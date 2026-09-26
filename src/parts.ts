import type { StorageParts, StorageWriteMeta } from 'ohnejs/uploads';

import type { S3Client } from './client.ts';

import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  MAX_PARTS,
  MIN_PART_SIZE,
  uploadPart,
} from './multipart.ts';

/**
 * Part-wise writes as S3 multipart uploads: the handle is the upload id, and each receipt a part's ETag.
 *
 * `keyOf` maps a path onto its object key, and `headersOf` gives the headers a whole write stores.
 * The upload takes those headers at `begin`, so the object it completes into matches one written whole.
 * S3 refuses a part under `MIN_PART_SIZE` that is not the last, when the upload completes.
 * A completion whose answer was lost resolves on the retry, once the object carries the parts' ETag.
 * An abort of an upload that is gone, completed or aborted, is a no-op.
 *
 * @example
 * ```ts
 * const parts = createS3Parts(client, (path) => `uploads/${path}`, ({ type }) => ({ 'content-type': type }))
 * const handle = await parts.begin('.tmp/a', { type: 'video/mp4', size: 3 })           // -> 'VXBsb2Fk...'
 * const receipt = await parts.write('.tmp/a', handle, { number: 1, offset: 0, bytes }) // -> '"9b2c..."'
 * await parts.complete('.tmp/a', handle, [receipt])
 * ```
 */
export function createS3Parts(
  client: S3Client,
  keyOf: (path: string) => string,
  headersOf: (meta: StorageWriteMeta) => Record<string, string>,
): StorageParts {
  return {
    minSize: MIN_PART_SIZE,
    maxCount: MAX_PARTS,

    begin: (path, meta) => createMultipart(client, keyOf(path), headersOf(meta)),

    async write(path, handle, { number, bytes }) {
      const { etag } = await uploadPart(client, keyOf(path), handle, number, bytes);
      return etag;
    },

    complete: (path, handle, receipts) =>
      completeMultipart(
        client,
        keyOf(path),
        handle,
        receipts.map((etag, index) => ({ partNumber: index + 1, etag })),
      ),

    abort: (path, handle) => abortMultipart(client, keyOf(path), handle),
  };
}
