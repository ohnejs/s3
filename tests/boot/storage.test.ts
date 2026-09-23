import { strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { useStorages } from 'ohnejs/uploads';

import '../../boot/storage.ts';
import { createS3Storage } from '../../src/storage.ts';

describe('boot/storage', () => {
  it('registers createS3Storage as s3', () => {
    strictEqual(useStorages().get('s3'), createS3Storage);
  });
});
