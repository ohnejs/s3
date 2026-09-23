import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { useEnv, useLayers } from 'ohnejs';

import type { FakeS3 } from './_fake-s3.ts';

import { createS3Client } from '../src/client.ts';
import { parseS3Location } from '../src/location.ts';
import { isPrivateObject } from '../src/objects.ts';
import { createS3Storage } from '../src/storage.ts';
import { storageContract } from './_contract.ts';
import { startFakeS3 } from './_fake-s3.ts';
import { streamOf, TEST_CREDENTIALS } from './_fixtures.ts';

describe('createS3Storage', () => {
  beforeEach(() => {
    useEnv().set('AWS_ACCESS_KEY_ID', TEST_CREDENTIALS.accessKeyId);
    useEnv().set('AWS_SECRET_ACCESS_KEY', TEST_CREDENTIALS.secretAccessKey);
    mock.method(Math, 'random', () => 0);
  });

  afterEach(() => {
    mock.restoreAll();
    useEnv().unset('AWS_ACCESS_KEY_ID');
    useEnv().unset('AWS_SECRET_ACCESS_KEY');
  });

  describe('the storage contract', () => {
    storageContract(async () => {
      const fake = await startFakeS3({ maxKeys: 2 });
      const location = fake.location();
      const client = createS3Client(parseS3Location(location), TEST_CREDENTIALS);
      return {
        storage: createS3Storage(location),
        isPrivate: (path) => isPrivateObject(client, path),
        close: () => fake.close(),
      };
    });
  });

  describe('against the fake', () => {
    let fake: FakeS3;

    beforeEach(async () => {
      fake = await startFakeS3();
    });

    afterEach(() => fake.close());

    it('has no setPrivate with tagging=false', () => {
      const storage = createS3Storage(fake.location({ tagging: 'false' }));

      strictEqual('setPrivate' in storage, false);
    });

    it('points a service without tagging at tagging=false', async () => {
      await fake.close();
      fake = await startFakeS3({ tagging: false });
      const storage = createS3Storage(fake.location());
      await storage.write('a.txt', streamOf('a'), { type: 'text/plain' });

      await rejects(storage.setPrivate?.('a.txt', true) ?? Promise.resolve(), {
        message:
          '`127.0.0.1:' +
          new URL(fake.endpoint).port +
          '` has no object tagging: add `tagging=false` to `uploads.url`',
      });
    });

    it('finishes a move that was cut off, when it is replayed', async () => {
      const storage = createS3Storage(fake.location());
      for (const name of ['a', 'b', 'c'])
        await storage.write(`photos/${name}.jpg`, streamOf(name), { type: 'image/jpeg' });
      fake.fail('CopyObject', { status: 403, code: 'AccessDenied' });

      await rejects(storage.move('photos', 'archive'), /AccessDenied/);
      await storage.move('photos', 'archive');

      deepStrictEqual([...fake.objects.keys()].sort(), [
        'archive/a.jpg',
        'archive/b.jpg',
        'archive/c.jpg',
      ]);
    });

    it('keeps every object under the prefix of its location', async () => {
      const storage = createS3Storage(fake.location({}, 'app/uploads'));

      await storage.write('photos/a.jpg', streamOf('a'), { type: 'image/jpeg' });
      await storage.move('photos', 'archive');

      deepStrictEqual([...fake.objects.keys()], ['app/uploads/archive/a.jpg']);
      deepStrictEqual(await storage.stat('archive/a.jpg'), { size: 1 });
    });

    it('stores the Cache-Control of uploads.cache and keeps it through a move', async () => {
      useLayers().add({
        path: '/s3-cache-test',
        input: { uploads: { cache: { public: true, maxAge: 60 } } },
      });
      try {
        const storage = createS3Storage(fake.location());
        await storage.write('a.jpg', streamOf('a'), { type: 'image/jpeg' });
        await storage.move('a.jpg', 'b.jpg');

        const object = fake.objects.get('b.jpg');
        ok(object);
        strictEqual(object.cacheControl, 'public, max-age=60');
        strictEqual(object.type, 'image/jpeg');
      } finally {
        useLayers().remove('/s3-cache-test');
      }
    });

    it('fails a read or delete in a missing bucket instead of finding no file', async () => {
      const storage = createS3Storage(`s3://missing?endpoint=${fake.endpoint}`);
      const missing = { message: 'Bucket `missing` does not exist' };

      await rejects(storage.read('a.txt'), missing);
      await rejects(storage.delete('a.txt'), missing);
    });

    it('reads the region and endpoint from the env', async () => {
      await fake.close();
      fake = await startFakeS3({ region: 'eu-west-2' });
      useEnv().set('AWS_ENDPOINT_URL_S3', fake.endpoint);
      useEnv().set('AWS_REGION', 'eu-west-2');
      try {
        const storage = createS3Storage('s3://bucket');
        await storage.write('a.txt', streamOf('a'), { type: 'text/plain' });

        strictEqual(fake.objects.has('a.txt'), true);
      } finally {
        useEnv().unset('AWS_ENDPOINT_URL_S3');
        useEnv().unset('AWS_REGION');
      }
    });
  });
});
