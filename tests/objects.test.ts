import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { usePrinter } from 'ohnejs';

import type { S3Client } from '../src/client.ts';
import type { FakeS3, FakeS3Object } from './_fake-s3.ts';

import { createS3Client } from '../src/client.ts';
import { parseS3Location } from '../src/location.ts';
import {
  copyMultipart,
  copyObject,
  deleteObjects,
  headObject,
  isPrivateObject,
  listObjects,
  objectsAt,
  tagPrivate,
} from '../src/objects.ts';
import { startFakeS3 } from './_fake-s3.ts';
import { MIB, randomBytes, TEST_CREDENTIALS } from './_fixtures.ts';

function object(bytes: Uint8Array, extra: Partial<FakeS3Object> = {}): FakeS3Object {
  return { bytes, type: 'image/jpeg', etag: '"e"', tags: {}, ...extra };
}

async function pages(generator: AsyncGenerator<{ key: string }[]>): Promise<string[][]> {
  const collected: string[][] = [];
  for await (const page of generator) collected.push(page.map(({ key }) => key));
  return collected;
}

describe('objects', () => {
  let fake: FakeS3;
  let client: S3Client;

  beforeEach(async () => {
    fake = await startFakeS3({ maxKeys: 2 });
    client = createS3Client(parseS3Location(fake.location()), TEST_CREDENTIALS);
  });

  afterEach(async () => {
    mock.restoreAll();
    await fake.close();
  });

  it('reads what S3 stores about an object, or null', async () => {
    fake.objects.set(
      'a.jpg',
      object(new Uint8Array(4), { cacheControl: 'no-cache', disposition: 'attachment' }),
    );

    deepStrictEqual(await headObject(client, 'a.jpg'), {
      size: 4,
      type: 'image/jpeg',
      cacheControl: 'no-cache',
      contentDisposition: 'attachment',
      etag: '"e"',
    });
    strictEqual(await headObject(client, 'b.jpg'), null);
  });

  it('lists every page of a prefix, decoding the keys', async () => {
    for (const key of ['p/a & b', 'p/c', 'p/d', 'p/e', 'q/f'])
      fake.objects.set(key, object(new Uint8Array(1)));

    deepStrictEqual(await pages(listObjects(client, 'p/')), [
      ['p/a & b', 'p/c'],
      ['p/d', 'p/e'],
    ]);
    deepStrictEqual(await pages(listObjects(client, 'none/')), []);
  });

  it('lists the object at a key and the ones beneath it, never a sibling that shares the name', async () => {
    for (const key of ['photos', 'photos/a', 'photos2/b'])
      fake.objects.set(key, object(new Uint8Array(1)));

    deepStrictEqual(await pages(objectsAt(client, 'photos')), [['photos'], ['photos/a']]);
  });

  it('deletes keys with a Content-MD5', async () => {
    for (const key of ['a', 'b', 'c']) fake.objects.set(key, object(new Uint8Array(1)));

    await deleteObjects(client, ['a', 'b']);

    deepStrictEqual([...fake.objects.keys()], ['c']);
    ok(fake.requests.at(-1)?.headers['content-md5']);
  });

  it('throws the first key S3 could not delete', async () => {
    for (const key of ['a', 'b']) fake.objects.set(key, object(new Uint8Array(1)));
    fake.protect('b');

    await rejects(deleteObjects(client, ['a', 'b']), {
      message: 'S3 answered `AccessDenied` for `b`: Access Denied',
    });
    deepStrictEqual([...fake.objects.keys()], ['b']);
  });

  it('copies an object with its type, Cache-Control and tags', async () => {
    fake.objects.set(
      'a.jpg',
      object(new Uint8Array(4), { cacheControl: 'no-cache', tags: { private: 'true' } }),
    );

    await copyObject(client, { key: 'a.jpg', size: 4 }, 'b.jpg');

    deepStrictEqual(fake.objects.get('b.jpg'), fake.objects.get('a.jpg'));
    strictEqual(await isPrivateObject(client, 'b.jpg'), true);
  });

  it('copies a large object in parts, keeping its headers and setting its private tag again', async () => {
    const bytes = randomBytes(11 * MIB);
    fake.objects.set(
      'big.html',
      object(bytes, {
        type: 'text/html',
        cacheControl: 'no-cache',
        disposition: 'attachment',
        tags: { private: 'true' },
      }),
    );

    await copyMultipart(client, { key: 'big.html', size: bytes.length }, 'copy.html', 5 * MIB);

    const copy = fake.objects.get('copy.html');
    deepStrictEqual(copy?.bytes, bytes);
    strictEqual(copy?.type, 'text/html');
    strictEqual(copy?.cacheControl, 'no-cache');
    strictEqual(copy?.disposition, 'attachment');
    deepStrictEqual(copy?.tags, { private: 'true' });
    strictEqual(fake.requests.filter(({ operation }) => operation === 'UploadPartCopy').length, 3);
  });

  it('copies only from the bucket the copy source names', async () => {
    fake.objects.set('a.jpg', object(new Uint8Array(4)));
    const astray = { ...client, copySource: (key: string) => `/other/${key}` };

    await rejects(copyObject(astray, { key: 'a.jpg', size: 4 }, 'b.jpg'), /does not exist/);
    await rejects(copyMultipart(astray, { key: 'a.jpg', size: 4 }, 'b.jpg', 2), /does not exist/);
    strictEqual(fake.objects.has('b.jpg'), false);
  });

  it('refuses a request to another bucket', async () => {
    const other = createS3Client(
      parseS3Location(fake.location().replace('s3://bucket', 's3://other')),
      TEST_CREDENTIALS,
    );

    await rejects(deleteObjects(other, ['a.jpg']), /Bucket `other` does not exist/);
    await rejects(isPrivateObject(other, 'a.jpg'), /Bucket `other` does not exist/);
  });

  it('aborts a multipart copy that fails', async () => {
    const bytes = randomBytes(11 * MIB);
    fake.objects.set('big.bin', object(bytes));
    fake.fail('UploadPartCopy', { status: 403, code: 'AccessDenied' });

    await rejects(
      copyMultipart(client, { key: 'big.bin', size: bytes.length }, 'copy.bin', 5 * MIB),
      /AccessDenied/,
    );
    strictEqual(fake.uploads.size, 0);
    strictEqual(fake.objects.has('copy.bin'), false);
  });

  it('warns with the key and upload id when a failed multipart copy cannot be aborted', async () => {
    const warn = mock.method(usePrinter(), 'warnBlock', () => {});
    const bytes = randomBytes(11 * MIB);
    fake.objects.set('dalaran.bin', object(bytes));
    fake.fail('UploadPartCopy', { status: 403, code: 'AccessDenied' });
    fake.fail('AbortMultipartUpload', { status: 403, code: 'AccessDenied' });

    await rejects(
      copyMultipart(client, { key: 'dalaran.bin', size: bytes.length }, 'violet-hold.bin', 5 * MIB),
      /AccessDenied/,
    );
    strictEqual(fake.uploads.size, 1);
    deepStrictEqual(
      warn.mock.calls.map(({ arguments: [options] }) => options),
      [
        {
          title: 'Multipart upload to `violet-hold.bin` not aborted',
          body: [
            'S3 answered `AccessDenied`: AccessDenied from the fake',
            '',
            'Its parts stay in the bucket, billed, under upload id `upload-1`.',
            'Abort it by hand, or add a lifecycle rule that aborts incomplete multipart uploads.',
          ],
        },
      ],
    );
  });

  it('tags an object private and removes the tag again', async () => {
    fake.objects.set('a.jpg', object(new Uint8Array(1)));

    await tagPrivate(client, 'a.jpg', true);
    strictEqual(await isPrivateObject(client, 'a.jpg'), true);
    await tagPrivate(client, 'a.jpg', false);
    strictEqual(await isPrivateObject(client, 'a.jpg'), false);
  });

  it('tags a missing object as a no-op', async () => {
    await tagPrivate(client, 'gone.jpg', true);
    await tagPrivate(client, 'gone.jpg', false);
  });
});
