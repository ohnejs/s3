import type { StorageParts } from 'ohnejs/uploads';

import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { useEnv } from 'ohnejs';
import { digest } from 'ohnejs/utils/crypto';

import type { FakeS3 } from './_fake-s3.ts';

import { MAX_PARTS, MIN_PART_SIZE } from '../src/multipart.ts';
import { createS3Storage } from '../src/storage.ts';
import { startFakeS3 } from './_fake-s3.ts';
import { randomBytes, TEST_CREDENTIALS } from './_fixtures.ts';

const KEY = 'app/uploads/.tmp/thrall.mp4';

describe('createS3Parts', () => {
  let fake: FakeS3;
  let parts: StorageParts;

  beforeEach(async () => {
    useEnv().set('AWS_ACCESS_KEY_ID', TEST_CREDENTIALS.accessKeyId);
    useEnv().set('AWS_SECRET_ACCESS_KEY', TEST_CREDENTIALS.secretAccessKey);
    mock.method(Math, 'random', () => 0);
    fake = await startFakeS3();
    const storage = createS3Storage(fake.location({}, 'app/uploads'));
    ok(storage.parts);
    parts = storage.parts;
  });

  afterEach(async () => {
    mock.restoreAll();
    useEnv().unset('AWS_ACCESS_KEY_ID');
    useEnv().unset('AWS_SECRET_ACCESS_KEY');
    await fake.close();
  });

  /**
   * Opens a write of `bytes` at `.tmp/thrall.mp4` and stores them in parts of `size`.
   */
  async function writeParts(
    bytes: Uint8Array,
    size = MIN_PART_SIZE,
  ): Promise<{ handle: string; receipts: string[] }> {
    const handle = await parts.begin('.tmp/thrall.mp4', { type: 'video/mp4', size: bytes.length });
    const receipts: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += size) {
      const part = {
        number: receipts.length + 1,
        offset,
        bytes: bytes.subarray(offset, offset + size),
      };
      receipts.push(await parts.write('.tmp/thrall.mp4', handle, part));
    }
    return { handle, receipts };
  }

  it('takes the part limits S3 sets', () => {
    strictEqual(parts.minSize, MIN_PART_SIZE);
    strictEqual(parts.maxCount, MAX_PARTS);
  });

  it('completes into an object under the prefix, with the headers a whole write stores', async () => {
    const bytes = new TextEncoder().encode('<p>Lok&apos;tar</p>');
    const meta = { type: 'text/html', size: bytes.length, disposition: 'attachment' } as const;

    const handle = await parts.begin('.tmp/orgrimmar.html', meta);
    const receipt = await parts.write('.tmp/orgrimmar.html', handle, {
      number: 1,
      offset: 0,
      bytes,
    });
    await parts.complete('.tmp/orgrimmar.html', handle, [receipt]);

    const object = fake.objects.get('app/uploads/.tmp/orgrimmar.html');
    ok(object);
    deepStrictEqual(object.bytes, bytes);
    deepStrictEqual(
      [object.type, object.cacheControl, object.disposition],
      ['text/html', 'no-cache', 'attachment'],
    );
  });

  it('resolves the ETag of each part as its receipt', async () => {
    const bytes = randomBytes(MIN_PART_SIZE + 3);

    const { receipts } = await writeParts(bytes);

    deepStrictEqual(receipts, [
      `"${digest('md5', bytes.subarray(0, MIN_PART_SIZE)).toHex()}"`,
      `"${digest('md5', bytes.subarray(MIN_PART_SIZE)).toHex()}"`,
    ]);
    strictEqual(fake.objects.has(KEY), false);
  });

  it('confirms a replayed complete by the ETag of the object it made', async () => {
    const bytes = randomBytes(MIN_PART_SIZE + 3);
    const { handle, receipts } = await writeParts(bytes);

    await parts.complete('.tmp/thrall.mp4', handle, receipts);
    await parts.complete('.tmp/thrall.mp4', handle, receipts);

    deepStrictEqual(fake.objects.get(KEY)?.bytes, bytes);
    deepStrictEqual(fake.requests.map(({ operation }) => operation).slice(-3), [
      'CompleteMultipartUpload',
      'CompleteMultipartUpload',
      'HeadObject',
    ]);
  });

  it('keeps an upload whose complete S3 refused, until the abort drops its parts', async () => {
    const { handle, receipts } = await writeParts(randomBytes(MIN_PART_SIZE), MIN_PART_SIZE - 1);

    await rejects(parts.complete('.tmp/thrall.mp4', handle, receipts), {
      message: 'S3 answered `EntityTooSmall`: EntityTooSmall from the fake',
    });
    strictEqual(fake.uploads.size, 1);

    await parts.abort('.tmp/thrall.mp4', handle);
    strictEqual(fake.uploads.size, 0);
    strictEqual(fake.objects.has(KEY), false);
  });

  it('fails a part of an upload that is gone', async () => {
    const { handle } = await writeParts(randomBytes(3));
    await parts.abort('.tmp/thrall.mp4', handle);

    await rejects(
      parts.write('.tmp/thrall.mp4', handle, { number: 2, offset: 3, bytes: randomBytes(3) }),
      { message: 'S3 answered `NoSuchUpload`: NoSuchUpload from the fake' },
    );
  });
});
