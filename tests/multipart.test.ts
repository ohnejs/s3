import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { S3Client } from '../src/client.ts';
import type { FakeS3 } from './_fake-s3.ts';

import { createS3Client } from '../src/client.ts';
import { parseS3Location } from '../src/location.ts';
import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  MAX_PARTS,
  partSizeFor,
  uploadPart,
} from '../src/multipart.ts';
import { startFakeS3 } from './_fake-s3.ts';
import { MIB, randomBytes, TEST_CREDENTIALS } from './_fixtures.ts';

describe('multipart', () => {
  let fake: FakeS3;
  let client: S3Client;

  beforeEach(async () => {
    fake = await startFakeS3();
    client = createS3Client(parseS3Location(fake.location()), TEST_CREDENTIALS);
    mock.method(Math, 'random', () => 0);
  });

  afterEach(async () => {
    mock.restoreAll();
    await fake.close();
  });

  async function twoParts(key: string) {
    const bytes = randomBytes(5 * MIB + 3);
    const uploadId = await createMultipart(client, key, { 'content-type': 'video/mp4' });
    const parts = [
      await uploadPart(client, key, uploadId, 1, bytes.slice(0, 5 * MIB)),
      await uploadPart(client, key, uploadId, 2, bytes.slice(5 * MIB)),
    ];
    return { bytes, uploadId, parts };
  }

  it('assembles the parts into one object', async () => {
    const { bytes, uploadId, parts } = await twoParts('video.mp4');

    await completeMultipart(client, 'video.mp4', uploadId, parts);

    const object = fake.objects.get('video.mp4');
    deepStrictEqual(object?.bytes, bytes);
    strictEqual(object?.type, 'video/mp4');
    strictEqual(fake.uploads.size, 0);
  });

  it('throws an error embedded in the completion answer', async () => {
    const { uploadId, parts } = await twoParts('video.mp4');
    fake.fail('CompleteMultipartUpload', { status: 200, code: 'InvalidPart', embedded: true });

    await rejects(
      completeMultipart(client, 'video.mp4', uploadId, parts),
      /S3 answered `InvalidPart`/,
    );
    strictEqual(fake.objects.has('video.mp4'), false);
  });

  it('resolves a completion whose answer was lost, once the object carries its ETag', async () => {
    const { bytes, uploadId, parts } = await twoParts('video.mp4');
    fake.dropAfter('CompleteMultipartUpload');

    await completeMultipart(client, 'video.mp4', uploadId, parts);

    deepStrictEqual(fake.objects.get('video.mp4')?.bytes, bytes);
    deepStrictEqual(fake.requests.map(({ operation }) => operation).slice(-3), [
      'CompleteMultipartUpload',
      'CompleteMultipartUpload',
      'HeadObject',
    ]);
  });

  it('throws a missing upload when another object sits at the key', async () => {
    const { uploadId, parts } = await twoParts('video.mp4');
    fake.uploads.delete(uploadId);
    fake.objects.set('video.mp4', {
      bytes: new Uint8Array(1),
      type: 'video/mp4',
      etag: '"other-2"',
      tags: {},
    });

    await rejects(
      completeMultipart(client, 'video.mp4', uploadId, parts),
      /S3 answered `NoSuchUpload`/,
    );
  });

  it('aborts an upload, and again as a no-op', async () => {
    const { uploadId } = await twoParts('video.mp4');

    await abortMultipart(client, 'video.mp4', uploadId);
    await abortMultipart(client, 'video.mp4', uploadId);

    strictEqual(fake.uploads.size, 0);
    strictEqual(fake.objects.has('video.mp4'), false);
  });
});

describe('partSizeFor', () => {
  it('keeps the preferred size while the parts fit', () => {
    strictEqual(partSizeFor(100 * MIB, 8 * MIB), 8 * MIB);
    strictEqual(partSizeFor(8 * MIB * MAX_PARTS, 8 * MIB), 8 * MIB);
  });

  it('raises the size to a whole mebibyte when the parts would not fit', () => {
    strictEqual(partSizeFor(8 * MIB * MAX_PARTS + 1, 8 * MIB), 9 * MIB);
    strictEqual(partSizeFor(100 * 1024 ** 3, 8 * MIB), 11 * MIB);
  });
});
