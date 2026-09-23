import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';

import type { S3Failure } from '../src/failure.ts';

import { failureError, readFailure, retryDelay, unreachableError } from '../src/failure.ts';
import { parseS3Location } from '../src/location.ts';

const location = parseS3Location('s3://photos?endpoint=https://s3.example.com');

function failure(status: number, code: string, message = ''): S3Failure {
  return { status, code, message };
}

describe('readFailure', () => {
  it('reads the code and message from the XML body', () => {
    deepStrictEqual(
      readFailure(
        404,
        new Headers(),
        '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>It&apos;s gone</Message></Error>',
      ),
      failure(404, 'NoSuchKey', "It's gone"),
    );
  });

  it('names a bodiless answer after its status', () => {
    deepStrictEqual(readFailure(404, new Headers(), ''), failure(404, 'NotFound'));
    deepStrictEqual(readFailure(403, new Headers(), ''), failure(403, 'Forbidden'));
  });

  it('reads the region of a redirect from its header', () => {
    const headers = new Headers({ 'x-amz-bucket-region': 'eu-west-1' });

    deepStrictEqual(readFailure(301, headers, ''), {
      ...failure(301, 'PermanentRedirect'),
      region: 'eu-west-1',
    });
    strictEqual(readFailure(307, headers, '').code, 'TemporaryRedirect');
  });

  it('reads the region of a malformed authorization from its body', () => {
    const xml =
      '<Error><Code>AuthorizationHeaderMalformed</Code><Message>m</Message><Region>eu-central-1</Region></Error>';

    strictEqual(readFailure(400, new Headers(), xml).region, 'eu-central-1');
  });

  it('ignores the region header on an answer about something else', () => {
    const headers = new Headers({ 'x-amz-bucket-region': 'eu-west-1' });

    strictEqual(readFailure(403, headers, '').region, undefined);
  });
});

describe('retryDelay', () => {
  afterEach(() => mock.restoreAll());

  it('retries server errors, timeouts, throttling and network errors', () => {
    mock.method(Math, 'random', () => 1);

    strictEqual(retryDelay(failure(500, 'InternalError'), 1), 100);
    strictEqual(retryDelay(failure(502, 'BadGateway'), 1), 100);
    strictEqual(retryDelay(failure(400, 'RequestTimeout'), 1), 100);
    strictEqual(retryDelay(undefined, 1), 100);
    strictEqual(retryDelay(failure(200, 'InternalError'), 2), 200);
  });

  it('backs off throttling from a longer base', () => {
    mock.method(Math, 'random', () => 1);

    strictEqual(retryDelay(failure(503, 'SlowDown'), 1), 2000);
    strictEqual(retryDelay(failure(503, 'ServiceUnavailable'), 2), 4000);
  });

  it('jitters below the bound', () => {
    const delay = retryDelay(failure(500, 'InternalError'), 2);

    ok(delay !== undefined && delay >= 0 && delay < 200);
  });

  it('gives up on the third attempt', () => {
    strictEqual(retryDelay(failure(500, 'InternalError'), 3), undefined);
    strictEqual(retryDelay(undefined, 3), undefined);
  });

  it('never retries a client error', () => {
    strictEqual(retryDelay(failure(403, 'AccessDenied'), 1), undefined);
    strictEqual(retryDelay(failure(404, 'NoSuchKey'), 1), undefined);
    strictEqual(retryDelay(failure(400, 'EntityTooSmall'), 1), undefined);
  });
});

describe('failureError', () => {
  const message = (operation: string, answer: S3Failure): string =>
    failureError(operation, answer, location).message;

  it('names the region of a bucket in another one', () => {
    strictEqual(
      message('HeadObject', { ...failure(301, 'PermanentRedirect'), region: 'eu-west-1' }),
      'Bucket `photos` is in `eu-west-1`: set `region=eu-west-1` in `uploads.url` or `AWS_REGION`',
    );
    strictEqual(
      message('PutObject', failure(400, 'AuthorizationHeaderMalformed')),
      'Bucket `photos` is in another region: set `region` in `uploads.url` or `AWS_REGION`',
    );
  });

  it('explains a missing bucket, bad credentials and a skewed clock', () => {
    strictEqual(
      message('PutObject', failure(404, 'NoSuchBucket')),
      'Bucket `photos` does not exist: create it, or name another in `uploads.url` or `UPLOADS_URL`',
    );
    strictEqual(
      message('PutObject', failure(403, 'SignatureDoesNotMatch')),
      'S3 rejected the credentials: check `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`',
    );
    strictEqual(
      message('PutObject', failure(403, 'InvalidAccessKeyId')),
      message('PutObject', failure(403, 'SignatureDoesNotMatch')),
    );
    strictEqual(
      message('PutObject', failure(403, 'RequestTimeTooSkewed')),
      "S3 refused the request time: sync this machine's clock",
    );
  });

  it('points a service without tagging at `tagging=false`', () => {
    strictEqual(
      message('PutObjectTagging', failure(501, 'NotImplemented')),
      '`s3.example.com` has no object tagging: add `tagging=false` to `uploads.url`',
    );
    strictEqual(
      message('GetObjectTagging', failure(501, 'NotImplemented')),
      message('PutObjectTagging', failure(501, 'NotImplemented')),
    );
  });

  it('asks for read permissions on a forbidden read', () => {
    strictEqual(
      message('HeadObject', failure(403, 'Forbidden')),
      'S3 denied `HeadObject`: grant `s3:GetObject`, and `s3:ListBucket` so a missing file reads as missing',
    );
  });

  it('asks for `s3:ListBucket` on a forbidden list', () => {
    strictEqual(
      message('ListObjectsV2', failure(403, 'AccessDenied', 'Access Denied')),
      'S3 denied `ListObjectsV2`: grant `s3:ListBucket`',
    );
  });

  it('reports anything else by its code and message', () => {
    strictEqual(
      message('CopyObject', failure(403, 'AccessDenied', 'Access Denied')),
      'S3 answered `AccessDenied`: Access Denied',
    );
    strictEqual(message('PutObject', failure(500, 'InternalError')), 'S3 answered `InternalError`');
  });

  it('never repeats "failed" or a key', () => {
    const answers = ['NoSuchBucket', 'SignatureDoesNotMatch', 'AccessDenied', 'NotImplemented'];
    for (const code of answers) {
      const text = message('PutObjectTagging', failure(400, code));
      ok(!/failed|\.tmp\//i.test(text), text);
    }
  });
});

describe('unreachableError', () => {
  it('names the host and the network cause', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:9');
    const error = unreachableError(new TypeError('fetch failed', { cause }), 's3.example.com');

    strictEqual(
      error.message,
      'S3 at `s3.example.com` did not answer: connect ECONNREFUSED 127.0.0.1:9',
    );
  });
});
