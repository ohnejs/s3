import type { StorageAdapter } from 'ohnejs/uploads';

import { ohneError, useEnv } from 'ohnejs';
import { useUploadsConfig } from 'ohnejs/uploads';
import { cacheControl, errorMessage, mapConcurrent, parseContentRange } from 'ohnejs/utils';

import { createS3Client } from './client.ts';
import { s3Credentials } from './credentials.ts';
import { parseS3Location } from './location.ts';
import {
  copyObject,
  deleteObjects,
  headObject,
  listObjects,
  objectsAt,
  tagPrivate,
} from './objects.ts';
import { writeObject } from './write.ts';
import './env.ts';

const CONCURRENCY = 8;

const CHECK_TIMEOUT = 5_000;

/**
 * Creates a storage that keeps the uploads in the S3 bucket `url` names.
 *
 * `url` is an `s3://<bucket>/<prefix>` location; see `parseS3Location` for its options.
 * Credentials come from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
 * The region and endpoint fall back to `AWS_REGION` and `AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL`.
 * Every object carries the `Cache-Control` of `uploads.cache`, for a bucket behind `uploads.publicURL`.
 * With `tagging=false` the storage has no `setPrivate`, for a service without object tagging.
 * Its `check` lists one key under the prefix, in a single attempt of at most five seconds.
 *
 * @example
 * ```ts
 * useStorages().register('s3', createS3Storage)
 * ```
 */
export function createS3Storage(url: string): StorageAdapter {
  const env = useEnv();
  const location = parseS3Location(url, {
    region: env.get('AWS_REGION'),
    endpoint: env.get('AWS_ENDPOINT_URL_S3') ?? env.get('AWS_ENDPOINT_URL'),
  });
  const client = createS3Client(location, s3Credentials());
  const cache = cacheControl(useUploadsConfig().cache);
  const keyOf = (path: string): string => (location.prefix ? `${location.prefix}/${path}` : path);

  return {
    write: (path, body, meta) =>
      writeObject(client, keyOf(path), body, meta, {
        'content-type': meta.type,
        'cache-control': cache,
      }),

    async read(path, range) {
      const response = await client.send({
        operation: 'GetObject',
        method: 'GET',
        key: keyOf(path),
        headers: range ? { range: `bytes=${range.start}-${range.end ?? ''}` } : {},
        accept: [404],
        timeout: false,
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      const { headers } = response;
      const size =
        response.status === 206
          ? Number(parseContentRange(headers.get('content-range') ?? '')?.size)
          : Number(headers.get('content-length'));
      return { body: response.body ?? ReadableStream.from([]), size };
    },

    async stat(path) {
      const head = await headObject(client, keyOf(path));
      return head && { size: head.size };
    },

    async *list(prefix = '') {
      const pages =
        prefix === ''
          ? listObjects(client, location.prefix && `${location.prefix}/`)
          : objectsAt(client, keyOf(prefix));
      const skip = location.prefix ? location.prefix.length + 1 : 0;
      for await (const page of pages) for (const { key } of page) yield key.slice(skip);
    },

    async move(from, to) {
      const source = keyOf(from);
      const target = keyOf(to);
      for await (const page of objectsAt(client, source)) {
        await mapConcurrent(page, CONCURRENCY, (entry) =>
          copyObject(client, entry, target + entry.key.slice(source.length)),
        );
        await deleteObjects(
          client,
          page.map(({ key }) => key),
        );
      }
    },

    async delete(path) {
      const key = keyOf(path);
      await client.sendXML({ operation: 'DeleteObject', method: 'DELETE', key, accept: [404] });
      for await (const page of listObjects(client, `${key}/`)) {
        await deleteObjects(
          client,
          page.map((entry) => entry.key),
        );
      }
    },

    ...(location.tagging && {
      async setPrivate(path: string, value: boolean) {
        for await (const page of objectsAt(client, keyOf(path))) {
          await mapConcurrent(page, CONCURRENCY, (entry) => tagPrivate(client, entry.key, value));
        }
      },
    }),

    async check() {
      try {
        await client.sendXML({
          operation: 'ListObjectsV2',
          method: 'GET',
          query: {
            'list-type': '2',
            'max-keys': '1',
            prefix: location.prefix && `${location.prefix}/`,
          },
          timeout: CHECK_TIMEOUT,
          retry: false,
        });
      } catch (error) {
        throw ohneError({
          title: `Cannot use S3 bucket \`${location.bucket}\``,
          body: [errorMessage(error)],
        });
      }
    },
  };
}
