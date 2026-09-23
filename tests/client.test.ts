import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { freePort } from 'ohnejs/utils/net';

import type { FakeS3 } from './_fake-s3.ts';

import { createS3Client } from '../src/client.ts';
import { parseS3Location } from '../src/location.ts';
import { signV4 } from '../src/sigv4.ts';
import { startFakeS3 } from './_fake-s3.ts';
import { TEST_CREDENTIALS } from './_fixtures.ts';

const put = {
  operation: 'PutObject',
  method: 'PUT',
  key: 'a.txt',
  body: new Uint8Array(3),
} as const;

describe('createS3Client', () => {
  let fake: FakeS3;

  beforeEach(async () => {
    fake = await startFakeS3();
    mock.method(Math, 'random', () => 0);
  });

  afterEach(async () => {
    mock.restoreAll();
    await fake.close();
  });

  function client(options?: Record<string, string>) {
    return createS3Client(parseS3Location(fake.location(options)), TEST_CREDENTIALS);
  }

  it('retries a 503 and then succeeds', async () => {
    fake.fail('PutObject', { status: 503, code: 'SlowDown' });

    const response = await client().send(put);

    strictEqual(response.status, 200);
    strictEqual(fake.requests.length, 2);
    strictEqual(fake.objects.get('a.txt')?.bytes.length, 3);
  });

  it('gives up after three attempts with the mapped message', async () => {
    fake.fail('PutObject', { status: 500, code: 'InternalError', times: 3 });

    await rejects(client().send(put), {
      message: 'S3 answered `InternalError`: InternalError from the fake',
    });
    strictEqual(fake.requests.length, 3);
  });

  it('retries an error embedded in a successful answer', async () => {
    fake.objects.set('a.txt', {
      bytes: new Uint8Array(1),
      type: 'text/plain',
      etag: '"x"',
      tags: {},
    });
    fake.fail('CopyObject', { status: 200, code: 'InternalError', embedded: true });

    await client().sendXML({
      operation: 'CopyObject',
      method: 'PUT',
      key: 'b.txt',
      headers: { 'x-amz-copy-source': '/bucket/a.txt' },
    });

    strictEqual(fake.requests.length, 2);
    strictEqual(fake.objects.has('b.txt'), true);
  });

  it('does not retry a denied request', async () => {
    fake.fail('PutObject', { status: 403, code: 'AccessDenied' });

    await rejects(client().send(put), /S3 answered `AccessDenied`/);
    strictEqual(fake.requests.length, 1);
  });

  it('resolves an accepted status instead of failing', async () => {
    const response = await client().send({
      operation: 'HeadObject',
      method: 'HEAD',
      key: 'none',
      accept: [404],
    });

    strictEqual(response.status, 404);
  });

  it('names the region of a bucket in another one', async () => {
    await rejects(client({ region: 'eu-central-1' }).send(put), {
      message:
        'Bucket `bucket` is in `us-east-1`: set `region=us-east-1` in `uploads.url` or `AWS_REGION`',
    });
  });

  it('never follows a redirect, and names the region it points at', async () => {
    fake.fail('PutObject', { status: 307, code: 'TemporaryRedirect' });

    await rejects(client().send(put), {
      message:
        'Bucket `bucket` is in `eu-west-1`: set `region=eu-west-1` in `uploads.url` or `AWS_REGION`',
    });
    strictEqual(fake.requests.length, 1);
  });

  it('reports an endpoint that never answers after its retries', async () => {
    const port = await freePort();
    const unreachable = createS3Client(
      parseS3Location(`s3://bucket?endpoint=http://127.0.0.1:${port}`),
      TEST_CREDENTIALS,
    );

    await rejects(unreachable.send(put), /^Error: S3 at `127\.0\.0\.1:\d+` did not answer: /);
  });

  it('builds the copy source with the key encoded', () => {
    strictEqual(client().copySource('photos/a b+c.jpg'), '/bucket/photos/a%20b%2Bc.jpg');
  });
});

describe('createS3Client URLs', () => {
  afterEach(() => mock.restoreAll());

  async function sent(
    url: string,
    key?: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
      calls.push({ url: input, headers: init.headers as Record<string, string> });
      return new Response('<ListBucketResult/>');
    });
    await createS3Client(parseS3Location(url), TEST_CREDENTIALS).sendXML({
      operation: 'GetObject',
      method: 'GET',
      ...(key && { key }),
      query: { 'list-type': '2' },
    });
    return calls[0];
  }

  it('addresses a virtual-hosted bucket as a subdomain', async () => {
    strictEqual(
      (await sent('s3://photos?region=eu-central-1', 'a b.jpg')).url,
      'https://photos.s3.eu-central-1.amazonaws.com/a%20b.jpg?list-type=2',
    );
    strictEqual(
      (await sent('s3://photos?region=eu-central-1')).url,
      'https://photos.s3.eu-central-1.amazonaws.com/?list-type=2',
    );
  });

  it('addresses a path-style bucket below the endpoint', async () => {
    strictEqual(
      (await sent('s3://photos?endpoint=http://localhost:9000', 'a.jpg')).url,
      'http://localhost:9000/photos/a.jpg?list-type=2',
    );
    strictEqual(
      (await sent('s3://photos?endpoint=http://localhost:9000')).url,
      'http://localhost:9000/photos?list-type=2',
    );
  });

  it('signs the host fetch sends, without a default port', async () => {
    const { url, headers } = await sent(
      's3://photos?endpoint=https://s3.example.com:443/&pathStyle=false',
      'a.jpg',
    );
    const { authorization, 'x-amz-date': stamp, ...rest } = headers;
    const date = new Date(
      stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
    );
    const resigned = signV4(
      {
        method: 'GET',
        host: new URL(url).host,
        path: '/a.jpg',
        query: { 'list-type': '2' },
        headers: rest,
        payloadHash: rest['x-amz-content-sha256'],
      },
      { credentials: TEST_CREDENTIALS, region: 'us-east-1', service: 's3', date },
    );

    strictEqual(new URL(url).host, 'photos.s3.example.com');
    deepStrictEqual(resigned.authorization, authorization);
  });
});
