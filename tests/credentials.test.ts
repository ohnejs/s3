import { deepStrictEqual, throws } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { isOhneError, useEnv } from 'ohnejs';

import { s3Credentials } from '../src/credentials.ts';

describe('s3Credentials', () => {
  afterEach(() => {
    useEnv().unset('AWS_ACCESS_KEY_ID');
    useEnv().unset('AWS_SECRET_ACCESS_KEY');
    useEnv().unset('AWS_SESSION_TOKEN');
  });

  it('reads the key pair from the env', () => {
    useEnv().set('AWS_ACCESS_KEY_ID', 'id');
    useEnv().set('AWS_SECRET_ACCESS_KEY', 'secret');

    deepStrictEqual(s3Credentials(), { accessKeyId: 'id', secretAccessKey: 'secret' });
  });

  it('adds a session token when one is set', () => {
    useEnv().set('AWS_ACCESS_KEY_ID', 'id');
    useEnv().set('AWS_SECRET_ACCESS_KEY', 'secret');
    useEnv().set('AWS_SESSION_TOKEN', 'token');

    deepStrictEqual(s3Credentials(), {
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
  });

  it('throws when the id or the secret is missing', () => {
    const missing = (error: unknown): boolean =>
      isOhneError(error) && error.title === 'Missing S3 credentials';

    throws(() => s3Credentials(), missing);
    useEnv().set('AWS_ACCESS_KEY_ID', 'id');
    throws(() => s3Credentials(), missing);
  });
});
