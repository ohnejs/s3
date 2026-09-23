import { escapeXML, xmlRoot, xmlText } from 'ohnejs/utils';
import { digest } from 'ohnejs/utils/crypto';

import type { S3Client } from './client.ts';

import { XMLNS } from './client.ts';
import { failureError, readFailure } from './failure.ts';

/**
 * The smallest part S3 accepts, except for the last.
 */
export const MIN_PART_SIZE = 5 * 1024 ** 2;

/**
 * The largest part S3 accepts.
 */
export const MAX_PART_SIZE = 5 * 1024 ** 3;

/**
 * The most parts one multipart upload may have.
 */
export const MAX_PARTS = 10_000;

/**
 * A part S3 stored, as `completeMultipart` lists it.
 */
export interface CompletedPart {
  /**
   * The part's number, from 1.
   */
  partNumber: number;

  /**
   * The quoted ETag S3 answered for the part.
   */
  etag: string;
}

const MEBIBYTE = 1024 ** 2;

const MD5_HEX = /^[0-9a-f]{32}$/i;

/**
 * The size of every part but the last for an object of `size` bytes.
 * It is `preferred`, raised to a whole mebibyte when `size` would otherwise need more than `MAX_PARTS`.
 *
 * @example
 * ```ts
 * partSizeFor(100 * 1024 ** 2, 8 * 1024 ** 2) // -> 8388608
 * partSizeFor(100 * 1024 ** 3, 8 * 1024 ** 2) // -> 11534336
 * ```
 */
export function partSizeFor(size: number, preferred: number): number {
  if (size <= preferred * MAX_PARTS) return preferred;
  return Math.ceil(size / MAX_PARTS / MEBIBYTE) * MEBIBYTE;
}

/**
 * Starts a multipart upload to `key` and resolves its upload id.
 * `headers` apply to the object the upload completes into, such as `content-type`.
 *
 * @example
 * ```ts
 * await createMultipart(client, 'photos/a.jpg', { 'content-type': 'image/jpeg' }) // -> 'VXBsb2Fk...'
 * ```
 */
export async function createMultipart(
  client: S3Client,
  key: string,
  headers: Record<string, string>,
): Promise<string> {
  const text = await client.sendXML({
    operation: 'CreateMultipartUpload',
    method: 'POST',
    key,
    query: { uploads: '' },
    headers,
  });
  return xmlText(text, 'UploadId') ?? '';
}

/**
 * Uploads `body` as part `partNumber` of an upload and resolves the stored part.
 *
 * @example
 * ```ts
 * await uploadPart(client, 'photos/a.jpg', uploadId, 1, bytes) // -> { partNumber: 1, etag: '"9b2c..."' }
 * ```
 */
export async function uploadPart(
  client: S3Client,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<CompletedPart> {
  const response = await client.send({
    operation: 'UploadPart',
    method: 'PUT',
    key,
    query: { partNumber: String(partNumber), uploadId },
    body,
    timeout: false,
  });
  await response.body?.cancel();
  return { partNumber, etag: response.headers.get('etag') ?? '' };
}

/**
 * Copies the inclusive byte `range` of the object `source` names into part `partNumber` of an upload.
 * `source` is an `x-amz-copy-source` value, as `S3Client.copySource` builds it.
 *
 * @example
 * ```ts
 * await uploadPartCopy(client, 'b.bin', uploadId, 1, client.copySource('a.bin'), { start: 0, end: 99 })
 * // -> { partNumber: 1, etag: '"9b2c..."' }
 * ```
 */
export async function uploadPartCopy(
  client: S3Client,
  key: string,
  uploadId: string,
  partNumber: number,
  source: string,
  range: { start: number; end: number },
): Promise<CompletedPart> {
  const text = await client.sendXML({
    operation: 'UploadPartCopy',
    method: 'PUT',
    key,
    query: { partNumber: String(partNumber), uploadId },
    headers: {
      'x-amz-copy-source': source,
      'x-amz-copy-source-range': `bytes=${range.start}-${range.end}`,
    },
    timeout: false,
  });
  return { partNumber, etag: xmlText(text, 'ETag') ?? '' };
}

/**
 * Completes an upload from its `parts`, which makes the object appear at `key`.
 *
 * A completion whose answer was lost is not replayable: S3 answers the retry with `NoSuchUpload`.
 * So that answer counts as success when the object at `key` carries the ETag these parts produce.
 *
 * @example
 * ```ts
 * await completeMultipart(client, 'photos/a.jpg', uploadId, [part1, part2])
 * ```
 */
export async function completeMultipart(
  client: S3Client,
  key: string,
  uploadId: string,
  parts: readonly CompletedPart[],
): Promise<void> {
  const body = `<CompleteMultipartUpload xmlns="${XMLNS}">${parts
    .map(
      ({ partNumber, etag }) =>
        `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXML(etag)}</ETag></Part>`,
    )
    .join('')}</CompleteMultipartUpload>`;
  const text = await client.sendXML({
    operation: 'CompleteMultipartUpload',
    method: 'POST',
    key,
    query: { uploadId },
    body,
    accept: [404],
    timeout: false,
  });
  if (xmlRoot(text) === 'CompleteMultipartUploadResult') return;

  const failure = readFailure(404, new Headers(), text);
  const expected = multipartETag(parts);
  if (failure.code === 'NoSuchUpload' && expected && (await etagAt(client, key)) === expected)
    return;
  throw failureError('CompleteMultipartUpload', failure, client.location);
}

/**
 * Aborts an upload and drops its stored parts.
 * An upload that is already gone is a no-op.
 *
 * @example
 * ```ts
 * await abortMultipart(client, 'photos/a.jpg', uploadId)
 * ```
 */
export async function abortMultipart(
  client: S3Client,
  key: string,
  uploadId: string,
): Promise<void> {
  await client.sendXML({
    operation: 'AbortMultipartUpload',
    method: 'DELETE',
    key,
    query: { uploadId },
    accept: [404],
  });
}

/**
 * The ETag of the object at `key`, or `undefined` when there is none.
 */
async function etagAt(client: S3Client, key: string): Promise<string | undefined> {
  const response = await client.send({
    operation: 'HeadObject',
    method: 'HEAD',
    key,
    accept: [404],
  });
  return response.ok ? (response.headers.get('etag') ?? undefined) : undefined;
}

/**
 * The ETag S3 gives the object a multipart upload of `parts` completes into, when every part has an MD5.
 * It is the MD5 of the parts' binary MD5s, then a dash and the part count.
 */
function multipartETag(parts: readonly CompletedPart[]): string | undefined {
  const hashes = new Uint8Array(parts.length * 16);
  for (const [index, { etag }] of parts.entries()) {
    const hex = etag.replaceAll('"', '');
    if (!MD5_HEX.test(hex)) return undefined;
    hashes.set(Uint8Array.fromHex(hex), index * 16);
  }
  return `"${digest('md5', hashes).toHex()}-${parts.length}"`;
}
