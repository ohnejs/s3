import { ohneError } from 'ohnejs';
import { escapeXML, mapConcurrent, xmlBlocks, xmlText } from 'ohnejs/utils';
import { digest } from 'ohnejs/utils/crypto';

import type { S3Client } from './client.ts';
import type { CompletedPart } from './multipart.ts';

import { XMLNS } from './client.ts';
import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  partSizeFor,
  uploadPartCopy,
} from './multipart.ts';

/**
 * An object in a listing.
 */
export interface S3Entry {
  /**
   * The full object key.
   */
  key: string;

  /**
   * The object's size in bytes.
   */
  size: number;
}

/**
 * What a `HEAD` of an object tells.
 */
export interface S3Head {
  /**
   * The object's size in bytes.
   */
  size: number;

  /**
   * The media type stored with the object.
   */
  type: string;

  /**
   * The `Cache-Control` stored with the object, when it has one.
   */
  cacheControl?: string;

  /**
   * The object's quoted ETag.
   */
  etag: string;
}

/**
 * The largest object one `CopyObject` copies; a larger one is copied in parts.
 */
export const MAX_COPY_SIZE = 5 * 1024 ** 3;

/**
 * The part size a multipart copy prefers.
 */
export const COPY_PART_SIZE = 1024 ** 3;

/**
 * The most keys one `ListObjectsV2` page returns and one `DeleteObjects` call removes.
 */
export const LIST_PAGE = 1000;

/**
 * The tag key that marks an object private, with the value `true`.
 */
export const PRIVATE_TAG = 'private';

const COPY_CONCURRENCY = 4;

const PRIVATE_TAGGING = `<Tagging xmlns="${XMLNS}"><TagSet><Tag><Key>${PRIVATE_TAG}</Key><Value>true</Value></Tag></TagSet></Tagging>`;

/**
 * Reads what S3 stores about the object at `key`, or resolves `null` when there is none.
 *
 * @example
 * ```ts
 * await headObject(client, 'photos/a.jpg')
 * // -> { size: 48213, type: 'image/jpeg', cacheControl: 'no-cache', etag: '"9b2c..."' }
 * ```
 */
export async function headObject(client: S3Client, key: string): Promise<S3Head | null> {
  const response = await client.send({
    operation: 'HeadObject',
    method: 'HEAD',
    key,
    accept: [404],
  });
  if (!response.ok) return null;

  const { headers } = response;
  const cacheControl = headers.get('cache-control');
  return {
    size: Number(headers.get('content-length')),
    type: headers.get('content-type') ?? 'application/octet-stream',
    ...(cacheControl && { cacheControl }),
    etag: headers.get('etag') ?? '',
  };
}

/**
 * Lists every object whose key starts with `prefix`, one page per request, skipping empty pages.
 *
 * @example
 * ```ts
 * for await (const page of listObjects(client, 'photos/')) console.log(page)
 * // -> [{ key: 'photos/a.jpg', size: 48213 }, ...]
 * ```
 */
export async function* listObjects(client: S3Client, prefix: string): AsyncGenerator<S3Entry[]> {
  let token: string | undefined;
  do {
    const text = await client.sendXML({
      operation: 'ListObjectsV2',
      method: 'GET',
      query: {
        'list-type': '2',
        'max-keys': String(LIST_PAGE),
        prefix,
        ...(token ? { 'continuation-token': token } : {}),
      },
    });
    const entries = xmlBlocks(text, 'Contents').map((block) => ({
      key: xmlText(block, 'Key') ?? '',
      size: Number(xmlText(block, 'Size')),
    }));
    if (entries.length > 0) yield entries;
    token = xmlText(text, 'IsTruncated') === 'true' ? xmlText(text, 'NextContinuationToken') : '';
  } while (token);
}

/**
 * Lists the object at `key` and every object under the prefix `key/`, as the storage contract reads a path.
 * The object comes first, as a page of its own.
 * The slash keeps `photos` from matching `photos2`.
 *
 * @example
 * ```ts
 * for await (const page of objectsAt(client, 'photos')) console.log(page)
 * // -> [{ key: 'photos/a.jpg', size: 48213 }]
 * ```
 */
export async function* objectsAt(client: S3Client, key: string): AsyncGenerator<S3Entry[]> {
  const head = await headObject(client, key);
  if (head) yield [{ key, size: head.size }];
  yield* listObjects(client, `${key}/`);
}

/**
 * Copies the object `from` to the key `to`, keeping its media type, `Cache-Control` and tags.
 * An object above `MAX_COPY_SIZE` is copied in parts.
 *
 * @example
 * ```ts
 * await copyObject(client, { key: 'photos/a.jpg', size: 48213 }, 'archive/a.jpg')
 * ```
 */
export async function copyObject(client: S3Client, from: S3Entry, to: string): Promise<void> {
  if (from.size > MAX_COPY_SIZE) return copyMultipart(client, from, to, COPY_PART_SIZE);
  await client.sendXML({
    operation: 'CopyObject',
    method: 'PUT',
    key: to,
    headers: { 'x-amz-copy-source': client.copySource(from.key) },
    timeout: false,
  });
}

/**
 * Copies the object `from` to the key `to` as a multipart upload of ranged part copies.
 * A part copy carries no tags, so a private source's tag is set on the upload itself.
 * Any failure aborts the upload.
 *
 * @example
 * ```ts
 * await copyMultipart(client, { key: 'video.mp4', size: 6 * 1024 ** 3 }, 'archive/video.mp4', 1024 ** 3)
 * ```
 */
export async function copyMultipart(
  client: S3Client,
  from: S3Entry,
  to: string,
  partSize: number,
): Promise<void> {
  const head = await headObject(client, from.key);
  const tagged = client.location.tagging && (await isPrivateObject(client, from.key));
  const uploadId = await createMultipart(client, to, {
    ...(head && { 'content-type': head.type }),
    ...(head?.cacheControl && { 'cache-control': head.cacheControl }),
    ...(tagged && { 'x-amz-tagging': `${PRIVATE_TAG}=true` }),
  });
  try {
    const size = partSizeFor(from.size, partSize);
    const source = client.copySource(from.key);
    const starts = Array.from({ length: Math.ceil(from.size / size) }, (_, index) => index * size);
    const parts: CompletedPart[] = await mapConcurrent(starts, COPY_CONCURRENCY, (start) =>
      uploadPartCopy(client, to, uploadId, start / size + 1, source, {
        start,
        end: Math.min(start + size, from.size) - 1,
      }),
    );
    await completeMultipart(client, to, uploadId, parts);
  } catch (error) {
    await abortMultipart(client, to, uploadId).catch(() => {});
    throw error;
  }
}

/**
 * Deletes `keys`, at most `LIST_PAGE` of them, in one request.
 * S3 reports a key it could not delete inside a successful answer, so the first one throws.
 *
 * @example
 * ```ts
 * await deleteObjects(client, ['photos/a.jpg', 'photos/b.jpg'])
 * ```
 */
export async function deleteObjects(client: S3Client, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const objects = keys.map((key) => `<Object><Key>${escapeXML(key)}</Key></Object>`).join('');
  const body = `<Delete xmlns="${XMLNS}"><Quiet>true</Quiet>${objects}</Delete>`;
  const text = await client.sendXML({
    operation: 'DeleteObjects',
    method: 'POST',
    query: { delete: '' },
    headers: { 'content-md5': digest('md5', body).toBase64() },
    body,
  });
  const [error] = xmlBlocks(text, 'Error');
  if (error) {
    const message = xmlText(error, 'Message');
    throw ohneError(
      `S3 answered \`${xmlText(error, 'Code')}\` for \`${xmlText(error, 'Key')}\`${message ? `: ${message}` : ''}`,
    );
  }
}

/**
 * Whether the object at `key` carries the tag `private=true`.
 *
 * @example
 * ```ts
 * await isPrivateObject(client, 'photos/a.jpg') // -> false
 * ```
 */
export async function isPrivateObject(client: S3Client, key: string): Promise<boolean> {
  const text = await client.sendXML({
    operation: 'GetObjectTagging',
    method: 'GET',
    key,
    query: { tagging: '' },
  });
  return xmlBlocks(text, 'Tag').some(
    (tag) => xmlText(tag, 'Key') === PRIVATE_TAG && xmlText(tag, 'Value') === 'true',
  );
}

/**
 * Tags the object at `key` `private=true`, or removes its tags for `false`.
 * The storage owns each object's tag set, so nothing else is lost.
 * An object that is gone is a no-op.
 *
 * @example
 * ```ts
 * await tagPrivate(client, 'photos/a.jpg', true)
 * ```
 */
export async function tagPrivate(client: S3Client, key: string, value: boolean): Promise<void> {
  await client.sendXML(
    value
      ? {
          operation: 'PutObjectTagging',
          method: 'PUT',
          key,
          query: { tagging: '' },
          headers: { 'content-md5': digest('md5', PRIVATE_TAGGING).toBase64() },
          body: PRIVATE_TAGGING,
          accept: [404],
        }
      : {
          operation: 'DeleteObjectTagging',
          method: 'DELETE',
          key,
          query: { tagging: '' },
          accept: [404],
        },
  );
}
