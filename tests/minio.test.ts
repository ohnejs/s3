import type { StorageAdapter } from 'ohnejs/uploads';

import { deepStrictEqual, strictEqual } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { useEnv } from 'ohnejs';
import { mapConcurrent } from 'ohnejs/utils';

import type { S3Client } from '../src/client.ts';
import type { MinIO } from './_minio.ts';

import { createS3Client } from '../src/client.ts';
import { parseS3Location } from '../src/location.ts';
import { isPrivateObject, LIST_PAGE, listObjects } from '../src/objects.ts';
import { createS3Storage } from '../src/storage.ts';
import { storageContract } from './_contract.ts';
import { bytesOf, bytesStream, MIB, randomBytes, streamOf, TEST_CREDENTIALS } from './_fixtures.ts';
import { startMinIO } from './_minio.ts';

const POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'PublicReadUnlessPrivate',
      Effect: 'Allow',
      Principal: '*',
      Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::bucket/*',
      Condition: { StringNotEquals: { 's3:ExistingObjectTag/private': 'true' } },
    },
  ],
};

const type = { type: 'text/plain' };

/**
 * The number of objects whose key starts with `prefix`.
 */
async function count(client: S3Client, prefix: string): Promise<number> {
  let total = 0;
  for await (const page of listObjects(client, prefix)) total += page.length;
  return total;
}

describe(
  'MinIO',
  { skip: process.env.S3_TEST_MINIO !== '1' && 'set S3_TEST_MINIO=1 to run' },
  () => {
    let minio: MinIO;
    let prefixes = 0;

    before(async () => {
      minio = await startMinIO();
      useEnv().set('AWS_ACCESS_KEY_ID', TEST_CREDENTIALS.accessKeyId);
      useEnv().set('AWS_SECRET_ACCESS_KEY', TEST_CREDENTIALS.secretAccessKey);
    });

    after(async () => {
      useEnv().unset('AWS_ACCESS_KEY_ID');
      useEnv().unset('AWS_SECRET_ACCESS_KEY');
      await minio?.close();
    });

    function location(options = ''): { url: string; prefix: string } {
      const prefix = `run-${++prefixes}`;
      return { url: `s3://bucket/${prefix}?endpoint=${minio.endpoint}${options}`, prefix };
    }

    async function publicStorage(
      options = '',
    ): Promise<{ storage: StorageAdapter; anonymous: (path: string) => Promise<Response> }> {
      const { url, prefix } = location(options);
      const client = createS3Client(parseS3Location(url), TEST_CREDENTIALS);
      await client.sendXML({
        operation: 'PutBucketPolicy',
        method: 'PUT',
        query: { policy: '' },
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(POLICY),
      });
      return {
        storage: createS3Storage(url),
        async anonymous(path) {
          const response = await fetch(`${minio.endpoint}/bucket/${prefix}/${path}`);
          await response.body?.cancel();
          return response;
        },
      };
    }

    describe('the storage contract', () => {
      storageContract(async () => {
        const { url, prefix } = location();
        const client = createS3Client(parseS3Location(url), TEST_CREDENTIALS);
        return {
          storage: createS3Storage(url),
          isPrivate: (path) => isPrivateObject(client, `${prefix}/${path}`),
          close: async () => {},
        };
      });
    });

    it('writes a body longer than a part as a multipart upload', async () => {
      const storage = createS3Storage(location('&partSize=5mb').url);
      const bytes = randomBytes(11 * MIB);

      await storage.write('video.mp4', bytesStream(bytes), { type: 'video/mp4' });

      const object = await storage.read('video.mp4');
      strictEqual(object?.size, bytes.length);
      deepStrictEqual(object && (await bytesOf(object.body)), bytes);
    });

    it('writes a declared size in parts and reads a range across a part boundary', async () => {
      const storage = createS3Storage(location('&partSize=5mb').url);
      const bytes = randomBytes(11 * MIB);

      await storage.write('video.mp4', bytesStream(bytes), {
        type: 'video/mp4',
        size: bytes.length,
      });

      const object = await storage.read('video.mp4', { start: 5 * MIB - 2, end: 5 * MIB + 1 });
      strictEqual(object?.size, bytes.length);
      deepStrictEqual(
        object && (await bytesOf(object.body)),
        bytes.slice(5 * MIB - 2, 5 * MIB + 2),
      );
    });

    it('moves and deletes a prefix longer than one listing page, keeping each lock', async () => {
      const { url, prefix } = location();
      const storage = createS3Storage(url);
      const client = createS3Client(parseS3Location(url), TEST_CREDENTIALS);
      const paths = Array.from({ length: LIST_PAGE + 1 }, (_, index) => `photos/${index}.txt`);
      await mapConcurrent(paths, 32, (path) => storage.write(path, streamOf(path), type));
      await storage.setPrivate?.(`photos/${LIST_PAGE}.txt`, true);

      await storage.move('photos', 'archive');

      strictEqual(await count(client, `${prefix}/photos/`), 0);
      strictEqual(await count(client, `${prefix}/archive/`), paths.length);
      strictEqual(await isPrivateObject(client, `${prefix}/archive/${LIST_PAGE}.txt`), true);

      await storage.delete('archive');

      strictEqual(await count(client, `${prefix}/archive/`), 0);
    });

    it('serves a public object anonymously, and refuses it once private', async () => {
      const { storage, anonymous } = await publicStorage();

      await storage.write('photos/a.jpg', streamOf('a'), { type: 'image/jpeg' });
      const served = await anonymous('photos/a.jpg');
      strictEqual(served.status, 200);
      strictEqual(served.headers.get('cache-control'), 'no-cache');

      await storage.setPrivate?.('photos', true);
      strictEqual((await anonymous('photos/a.jpg')).status, 403);

      await storage.move('photos', 'archive');
      strictEqual((await anonymous('archive/a.jpg')).status, 403);

      await storage.setPrivate?.('archive/a.jpg', false);
      strictEqual((await anonymous('archive/a.jpg')).status, 200);
    });

    it('serves an attachment as one, written in one part or many, and after a move', async () => {
      const { storage, anonymous } = await publicStorage('&partSize=5mb');
      const html = { type: 'text/html', disposition: 'attachment' } as const;
      await storage.write('kalimdor/orgrimmar.html', streamOf('<p>Lok&apos;tar</p>'), html);
      await storage.write('kalimdor/durotar.html', bytesStream(randomBytes(6 * MIB)), html);

      const dispositions = (directory: string): Promise<(string | null)[]> =>
        Promise.all(
          ['orgrimmar.html', 'durotar.html'].map(async (name) => {
            const served = await anonymous(`${directory}/${name}`);
            return served.headers.get('content-disposition');
          }),
        );

      deepStrictEqual(await dispositions('kalimdor'), ['attachment', 'attachment']);
      await storage.move('kalimdor', 'archive');
      deepStrictEqual(await dispositions('archive'), ['attachment', 'attachment']);
    });
  },
);
