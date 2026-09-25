import type { Socket } from 'node:net';

import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { useEnv, useLayers } from 'ohnejs';

import type { FakeS3 } from './_fake-s3.ts';

import { createS3Client } from '../src/client.ts';
import { parseS3Location } from '../src/location.ts';
import { isPrivateObject } from '../src/objects.ts';
import { createS3Storage } from '../src/storage.ts';
import { storageContract } from './_contract.ts';
import { startFakeS3 } from './_fake-s3.ts';
import { bytesStream, MIB, randomBytes, streamOf, TEST_CREDENTIALS } from './_fixtures.ts';

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
      await createS3Storage(fake.location()).write('other/x.jpg', streamOf('x'), {
        type: 'image/jpeg',
      });
      deepStrictEqual(await Array.fromAsync(storage.list!()), ['archive/a.jpg']);
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

    it('stores the disposition in one part or many, and keeps it through a move', async () => {
      const storage = createS3Storage(fake.location({ partSize: '5mb' }));
      const html = { type: 'text/html', disposition: 'attachment' } as const;

      await storage.write('orgrimmar.html', streamOf('<p>Lok&apos;tar</p>'), html);
      await storage.write('durotar.html', bytesStream(randomBytes(6 * MIB)), html);
      await storage.write('thrall.png', streamOf('png'), {
        type: 'image/png',
        disposition: 'inline',
      });
      await storage.write('jaina.txt', streamOf('txt'), { type: 'text/plain' });
      await storage.move('orgrimmar.html', 'archive/orgrimmar.html');

      strictEqual(fake.objects.get('archive/orgrimmar.html')?.disposition, 'attachment');
      strictEqual(fake.objects.get('durotar.html')?.disposition, 'attachment');
      strictEqual(fake.objects.get('thrall.png')?.disposition, 'inline');
      strictEqual(fake.objects.get('jaina.txt')?.disposition, undefined);
    });

    it('fails a read or delete in a missing bucket instead of finding no file', async () => {
      const storage = createS3Storage(`s3://missing?endpoint=${fake.endpoint}`);
      const missing = {
        message:
          'Bucket `missing` does not exist: create it, or name another in `uploads.url` or `UPLOADS_URL`',
      };

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

    it('treats a blank region or endpoint variable as unset', async () => {
      useEnv().set('AWS_ENDPOINT_URL_S3', '');
      useEnv().set('AWS_ENDPOINT_URL', fake.endpoint);
      useEnv().set('AWS_REGION', '');
      try {
        const storage = createS3Storage('s3://bucket');
        await storage.write('blank.txt', streamOf('b'), { type: 'text/plain' });

        strictEqual(fake.objects.has('blank.txt'), true);
      } finally {
        useEnv().unset('AWS_ENDPOINT_URL_S3');
        useEnv().unset('AWS_ENDPOINT_URL');
        useEnv().unset('AWS_REGION');
      }
    });
  });

  describe('check', () => {
    let fake: FakeS3;

    beforeEach(async () => {
      fake = await startFakeS3();
    });

    afterEach(() => fake.close());

    it('passes with one list request for a reachable bucket', async () => {
      await createS3Storage(fake.location({}, 'app/uploads')).check!();

      deepStrictEqual(
        fake.requests.map(({ operation }) => operation),
        ['ListObjectsV2'],
      );
    });

    it('names a missing bucket', async () => {
      await rejects(createS3Storage(`s3://missing?endpoint=${fake.endpoint}`).check!(), {
        title: 'Cannot use S3 bucket `missing`',
        body: [
          'Bucket `missing` does not exist: create it, or name another in `uploads.url` or `UPLOADS_URL`',
        ],
      });
    });

    it('names rejected credentials', async () => {
      useEnv().set('AWS_ACCESS_KEY_ID', 'wrong');

      await rejects(createS3Storage(fake.location()).check!(), {
        body: [
          'S3 rejected the credentials: check `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`',
        ],
      });
    });

    it('names the permission a refused key lacks', async () => {
      fake.fail('ListObjectsV2', { status: 403, code: 'AccessDenied' });

      await rejects(createS3Storage(fake.location()).check!(), {
        body: ['S3 denied `ListObjectsV2`: grant `s3:ListBucket`'],
      });
    });

    it('fails a transient failure without retrying it', async () => {
      fake.fail('ListObjectsV2', { status: 503, code: 'SlowDown' });

      await rejects(createS3Storage(fake.location()).check!(), {
        body: ['S3 answered `SlowDown`: SlowDown from the fake'],
      });
      strictEqual(fake.requests.length, 1);
    });

    it('gives up on a silent endpoint after its timeout', async () => {
      const sockets: Socket[] = [];
      const silent = createServer((socket) => sockets.push(socket));
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      const { port } = silent.address() as { port: number };
      try {
        await rejects(createS3Storage(`s3://bucket?endpoint=http://127.0.0.1:${port}`).check!(), {
          body: [
            `S3 at \`127.0.0.1:${port}\` did not answer: The operation was aborted due to timeout`,
          ],
        });
      } finally {
        for (const socket of sockets) socket.destroy();
        silent.close();
      }
      strictEqual(sockets.length, 1);
    });
  });
});
