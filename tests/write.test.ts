import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { isUndefined } from 'ohnejs/utils';

import type { S3Client } from '../src/client.ts';
import type { FakeS3 } from './_fake-s3.ts';

import { createS3Client } from '../src/client.ts';
import { parseS3Location } from '../src/location.ts';
import { writeObject } from '../src/write.ts';
import { startFakeS3 } from './_fake-s3.ts';
import {
  bytesStream,
  failingStream,
  MIB,
  randomBytes,
  streamOf,
  TEST_CREDENTIALS,
} from './_fixtures.ts';

const headers = { 'content-type': 'video/mp4', 'cache-control': 'no-cache' };

const meta = { type: 'video/mp4' };

describe('writeObject', () => {
  let fake: FakeS3;
  let client: S3Client;

  beforeEach(async () => {
    fake = await startFakeS3();
    client = createS3Client(parseS3Location(fake.location({ partSize: '5mb' })), TEST_CREDENTIALS);
    mock.method(Math, 'random', () => 0);
  });

  afterEach(async () => {
    mock.restoreAll();
    await fake.close();
  });

  const operations = (): string[] => fake.requests.map(({ operation }) => operation);

  it('writes a small body as one PutObject', async () => {
    await writeObject(client, 'a.txt', streamOf('hel', 'lo'), meta, headers);

    deepStrictEqual(operations(), ['PutObject']);
    strictEqual(new TextDecoder().decode(fake.objects.get('a.txt')?.bytes), 'hello');
  });

  it('writes an empty body as an empty object', async () => {
    await writeObject(client, 'empty.txt', streamOf(), meta, headers);

    strictEqual(fake.objects.get('empty.txt')?.bytes.length, 0);
  });

  it('writes a body of exactly one part as one PutObject', async () => {
    await writeObject(client, 'a.bin', bytesStream(randomBytes(5 * MIB)), meta, headers);

    deepStrictEqual(operations(), ['PutObject']);
  });

  it('writes a longer body in parts of the configured size', async () => {
    const bytes = randomBytes(11 * MIB);

    await writeObject(client, 'a.bin', bytesStream(bytes), meta, headers);

    deepStrictEqual(operations(), [
      'CreateMultipartUpload',
      'UploadPart',
      'UploadPart',
      'UploadPart',
      'CompleteMultipartUpload',
    ]);
    deepStrictEqual(
      fake.requests
        .filter(({ operation }) => operation === 'UploadPart')
        .map(({ headers }) => headers['content-length']),
      [String(5 * MIB), String(5 * MIB), String(MIB)],
    );
    deepStrictEqual(fake.objects.get('a.bin')?.bytes, bytes);
  });

  it('refuses a declared size beyond the part limit before any request', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => void (cancelled = true) });

    await rejects(writeObject(client, 'a.bin', body, { ...meta, size: 100 * 1024 ** 3 }, headers), {
      message:
        'File exceeds `48.83gb`, the S3 limit for this `partSize`: raise `partSize` in `uploads.url`',
    });
    deepStrictEqual(operations(), []);
    strictEqual(cancelled, true);
  });

  it('aborts a body that runs past the part limit whatever size it declared', async () => {
    await rejects(
      writeObject(
        client,
        'a.bin',
        bytesStream(randomBytes(11 * MIB)),
        { ...meta, size: 1 },
        headers,
        2,
      ),
      /File exceeds `10mb`/,
    );
    strictEqual(operations().at(-1), 'AbortMultipartUpload');
    strictEqual(fake.uploads.size, 0);
    strictEqual(fake.objects.has('a.bin'), false);
  });

  it('pulls at most one part ahead of the upload, and lets an uploaded part go', async () => {
    const size = 5 * MIB;
    const bytes = randomBytes(4 * size);
    const original = globalThis.fetch;
    let completed = 0;
    let first: WeakRef<object> | undefined;
    let firstAlive: boolean | undefined;
    // Swapped by hand: `mock.method` keeps every call's arguments, the part bodies included.
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('partNumber=1&')) first = new WeakRef(init?.body as object);
      const { gc } = globalThis;
      if (url.includes('partNumber=4&') && !isUndefined(gc)) {
        await new Promise((resolve) => setTimeout(resolve));
        gc();
        firstAlive = !isUndefined(first?.deref());
      }
      const response = await original(input, init);
      if (url.includes('partNumber=')) completed++;
      return response;
    };

    let offset = 0;
    let held = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset >= bytes.length) return controller.close();
          held = Math.max(held, Math.floor(offset / size) + 1 - completed);
          controller.enqueue(bytes.slice(offset, offset + MIB));
          offset += MIB;
        },
      },
      { highWaterMark: 0 },
    );

    try {
      await writeObject(client, 'a.bin', body, meta, headers);
    } finally {
      globalThis.fetch = original;
    }

    strictEqual(held, 2);
    if (!isUndefined(globalThis.gc)) strictEqual(firstAlive, false);
    deepStrictEqual(fake.objects.get('a.bin')?.bytes, bytes);
  });

  it('aborts when the body fails mid-upload and keeps the previous object', async () => {
    fake.objects.set('a.bin', {
      bytes: new Uint8Array(1),
      type: 'video/mp4',
      etag: '"e"',
      tags: {},
    });

    await rejects(
      writeObject(client, 'a.bin', failingStream(randomBytes(11 * MIB)), meta, headers),
      /stream broke/,
    );
    strictEqual(operations().at(-1), 'AbortMultipartUpload');
    strictEqual(fake.uploads.size, 0);
    strictEqual(fake.objects.get('a.bin')?.bytes.length, 1);
  });

  it('aborts a failed part upload while the body errors behind it', async () => {
    fake.fail('UploadPart', { status: 403, code: 'AccessDenied' });
    const original = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
      if (input.includes('partNumber=')) await new Promise((resolve) => setTimeout(resolve, 50));
      return original(input, init);
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 12; index++) controller.enqueue(new Uint8Array(MIB));
        setTimeout(() => controller.error(new Error('client gone')), 20);
      },
    });

    await rejects(writeObject(client, 'a.bin', body, meta, headers), /AccessDenied/);
    strictEqual(operations().at(-1), 'AbortMultipartUpload');
    strictEqual(fake.uploads.size, 0);
  });

  it('retries a failed part', async () => {
    const bytes = randomBytes(11 * MIB);
    fake.fail('UploadPart', { status: 500, code: 'InternalError' });

    await writeObject(client, 'a.bin', bytesStream(bytes), meta, headers);

    strictEqual(operations().filter((operation) => operation === 'UploadPart').length, 4);
    deepStrictEqual(fake.objects.get('a.bin')?.bytes, bytes);
  });

  it('sends the headers with the object and never a tag', async () => {
    await writeObject(client, 'small.bin', streamOf('x'), meta, headers);
    await writeObject(client, 'large.bin', bytesStream(randomBytes(6 * MIB)), meta, headers);

    for (const { operation, headers: sent } of fake.requests) {
      ok(!('x-amz-tagging' in sent), operation);
      if (operation === 'PutObject' || operation === 'CreateMultipartUpload') {
        strictEqual(sent['cache-control'], 'no-cache');
        strictEqual(sent['content-type'], 'video/mp4');
      }
    }
    strictEqual(fake.objects.get('large.bin')?.cacheControl, 'no-cache');
  });
});
