import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from 'ohnejs/utils';
import { freePort } from 'ohnejs/utils/net';

import { createS3Client } from '../src/client.ts';
import { parseS3Location } from '../src/location.ts';
import { TEST_CREDENTIALS } from './_fixtures.ts';

/**
 * A running MinIO server with one empty bucket, `bucket`.
 */
export interface MinIO {
  endpoint: string;
  close(): Promise<void>;
}

/**
 * Spawns `minio` from `PATH` on free loopback ports, with `TEST_CREDENTIALS` as its root user.
 */
export async function startMinIO(): Promise<MinIO> {
  const dir = await mkdtemp(join(tmpdir(), 'ohne-s3-minio-'));
  const port = await freePort(0, { host: '127.0.0.1' });
  const consolePort = await freePort(0, { host: '127.0.0.1', exclude: [port] });
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(
    'minio',
    [
      'server',
      dir,
      '--address',
      `127.0.0.1:${port}`,
      '--console-address',
      `127.0.0.1:${consolePort}`,
      '--quiet',
    ],
    {
      env: {
        ...process.env,
        MINIO_ROOT_USER: TEST_CREDENTIALS.accessKeyId,
        MINIO_ROOT_PASSWORD: TEST_CREDENTIALS.secretAccessKey,
      },
      stdio: 'ignore',
    },
  );
  const close = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dir, { recursive: true, force: true });
  };

  try {
    await waitForHealth(endpoint);
    const client = createS3Client(
      parseS3Location(`s3://bucket?endpoint=${endpoint}`),
      TEST_CREDENTIALS,
    );
    await client.sendXML({ operation: 'CreateBucket', method: 'PUT' });
  } catch (error) {
    await close();
    throw error;
  }
  return { endpoint, close };
}

/**
 * Polls the liveness probe until the server answers, for at most twenty seconds.
 */
async function waitForHealth(endpoint: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const live = await fetch(`${endpoint}/minio/health/live`).then(
      (response) => response.ok,
      () => false,
    );
    if (live) return;
    await sleep(100);
  }
  throw new Error(`MinIO did not start at ${endpoint}`);
}
