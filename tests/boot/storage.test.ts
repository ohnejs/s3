import { rejects, strictEqual } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { applyHook, useEnv, useHooks, useLayers } from 'ohnejs';
import { useStorages } from 'ohnejs/uploads';

import type { FakeS3 } from '../_fake-s3.ts';

import { createS3Storage } from '../../src/storage.ts';
import { startFakeS3 } from '../_fake-s3.ts';
import { TEST_CREDENTIALS } from '../_fixtures.ts';

describe('boot/storage', () => {
  let fake: FakeS3;
  let runs = 0;

  const boot = (): Promise<unknown> => import(`../../boot/storage.ts?run=${++runs}`);
  const synced = (): Promise<unknown> =>
    applyHook('schema:synced', { deletions: [], warnings: [] });

  const select = (storage: string, url: string): void => {
    useLayers().add({ path: '/s3-boot-test', input: { uploads: { storage, url } } });
  };

  beforeEach(async () => {
    fake = await startFakeS3();
    useEnv().set('AWS_ACCESS_KEY_ID', TEST_CREDENTIALS.accessKeyId);
    useEnv().set('AWS_SECRET_ACCESS_KEY', TEST_CREDENTIALS.secretAccessKey);
  });

  afterEach(async () => {
    useHooks().delete('schema:synced');
    useLayers().remove('/s3-boot-test');
    useEnv().unset('AWS_ACCESS_KEY_ID');
    useEnv().unset('AWS_SECRET_ACCESS_KEY');
    await fake.close();
  });

  it('registers createS3Storage as s3', async () => {
    await boot();

    strictEqual(useStorages().get('s3'), createS3Storage);
    strictEqual(fake.requests.length, 0);
  });

  it('checks nothing until the schema sync commits, so a dry run needs no bucket', async () => {
    select('s3', `s3://missing?endpoint=${fake.endpoint}`);

    await boot();

    strictEqual(fake.requests.length, 0);
  });

  it('fails once the schema syncs when the s3 bucket is missing', async () => {
    select('s3', `s3://missing?endpoint=${fake.endpoint}`);
    await boot();

    await rejects(synced(), { title: 'Cannot use S3 bucket `missing`' });
  });

  it('checks the bucket UPLOADS_URL names over uploads.url', async () => {
    select('s3', `s3://missing?endpoint=${fake.endpoint}`);
    useEnv().set('UPLOADS_URL', fake.location());
    try {
      await boot();
      await synced();
    } finally {
      useEnv().unset('UPLOADS_URL');
    }

    strictEqual(fake.requests.length, 1);
  });

  it('leaves another storage alone', async () => {
    select('fs', `s3://missing?endpoint=${fake.endpoint}`);

    await boot();
    await synced();

    strictEqual(fake.requests.length, 0);
  });
});
