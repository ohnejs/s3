import type { OhneError } from 'ohnejs';
import type { StorageWriteMeta } from 'ohnejs/uploads';

import { ohneError } from 'ohnejs';
import { formatBytes, isUndefined, rechunkStream } from 'ohnejs/utils';

import type { S3Client } from './client.ts';
import type { CompletedPart } from './multipart.ts';

import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  MAX_PARTS,
  uploadPart,
} from './multipart.ts';

/**
 * Writes `body` to `key` with `headers`, as one `PutObject` when it fits a part, else as a multipart upload.
 *
 * Parts are the location's fixed `partSize`, so a declared `meta.size` never raises the memory a write holds.
 * At most two parts are held at once, one uploading while the next fills.
 * Both settle before a failure aborts the upload, so no part lands after the abort.
 * A body longer than `maxParts` parts throws, as does a declared `meta.size` beyond it, before any request.
 * The object appears only once the write completes, so a failed write keeps the previous one.
 *
 * @example
 * ```ts
 * await writeObject(client, 'photos/a.jpg', body, { type: 'image/jpeg' }, { 'content-type': 'image/jpeg' })
 * ```
 */
export async function writeObject(
  client: S3Client,
  key: string,
  body: ReadableStream<Uint8Array>,
  meta: StorageWriteMeta,
  headers: Record<string, string>,
  maxParts: number = MAX_PARTS,
): Promise<void> {
  const size = client.location.partSize;
  const limit = size * maxParts;
  if (!isUndefined(meta.size) && meta.size > limit) {
    await body.cancel();
    throw limitError(limit);
  }

  const parts = rechunkStream(body, size);
  let uploadId: string | undefined;
  try {
    let held = await parts.next();
    let next = await parts.next();
    if (held.done || next.done) {
      await client.sendXML({
        operation: 'PutObject',
        method: 'PUT',
        key,
        headers,
        body: held.done ? new Uint8Array() : held.value,
        timeout: false,
      });
      return;
    }

    uploadId = await createMultipart(client, key, headers);
    const completed: CompletedPart[] = [await uploadPart(client, key, uploadId, 1, held.value)];
    // Each iteration drops the uploaded part by reassigning `held`, so only two parts stay reachable.
    for (let partNumber = 2; !next.done; partNumber++) {
      if (partNumber > maxParts) throw limitError(limit);
      held = next;
      const uploading = uploadPart(client, key, uploadId, partNumber, held.value);
      const [uploaded, pulled] = await Promise.allSettled([uploading, parts.next()]);
      if (uploaded.status === 'rejected') throw uploaded.reason;
      if (pulled.status === 'rejected') throw pulled.reason;
      completed.push(uploaded.value);
      next = pulled.value;
    }
    await completeMultipart(client, key, uploadId, completed);
  } catch (error) {
    // Cancelling a body that errored rejects, which must neither skip the abort nor replace `error`.
    await parts.return().catch(() => {});
    if (!isUndefined(uploadId)) await abortMultipart(client, key, uploadId).catch(() => {});
    throw error;
  }
}

/**
 * The error for a file larger than the parts of this `partSize` can hold.
 */
function limitError(limit: number): OhneError {
  return ohneError(
    `File exceeds \`${formatBytes(limit)}\`, the S3 limit for this \`partSize\`: raise \`partSize\` in \`uploads.url\``,
  );
}
