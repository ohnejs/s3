import { strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { useStorages } from 'ohnejs/uploads';

import { createS3Storage } from '../../src/storage.ts';

describe('boot/storage', () => {
  it('registers createS3Storage as s3', async () => {
    await import('../../boot/storage.ts');

    strictEqual(useStorages().get('s3'), createS3Storage);
  });
});
