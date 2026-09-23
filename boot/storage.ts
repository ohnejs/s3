import { useStorages } from 'ohnejs/uploads';

import { createS3Storage } from '../src/storage.ts';

useStorages().register('s3', createS3Storage);
