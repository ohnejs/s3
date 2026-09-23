import { hook, useEnv } from 'ohnejs';
import { useStorages, useUploadsConfig } from 'ohnejs/uploads';

import { checkS3Storage, createS3Storage } from '../src/storage.ts';

useStorages().register('s3', createS3Storage);

// After the sync commits, so a dry run, which never touches storage, needs no bucket.
hook('schema:synced', async () => {
  const { storage, url } = useUploadsConfig();
  if (storage === 's3') await checkS3Storage(useEnv().get('UPLOADS_URL') ?? url);
});
