import { ohneError, useEnv } from 'ohnejs';

import './env.ts';

/**
 * The AWS key pair every request is signed with.
 */
export interface S3Credentials {
  /**
   * The access key id.
   */
  accessKeyId: string;

  /**
   * The secret that signs each request.
   */
  secretAccessKey: string;

  /**
   * A session token, for temporary credentials.
   */
  sessionToken?: string;
}

/**
 * Reads the credentials from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`.
 * Throws when the key id or the secret is unset.
 *
 * @example
 * ```ts
 * s3Credentials() // -> { accessKeyId: 'AKIA...', secretAccessKey: '...' }
 * ```
 */
export function s3Credentials(): S3Credentials {
  const env = useEnv();
  const accessKeyId = env.get('AWS_ACCESS_KEY_ID');
  const secretAccessKey = env.get('AWS_SECRET_ACCESS_KEY');
  if (!accessKeyId || !secretAccessKey) {
    throw ohneError({
      title: 'Missing S3 credentials',
      body: [
        'The `s3` storage signs every request with an AWS access key.',
        'Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, in the environment or in `.env`.',
      ],
    });
  }
  const sessionToken = env.get('AWS_SESSION_TOKEN');
  return sessionToken
    ? { accessKeyId, secretAccessKey, sessionToken }
    : { accessKeyId, secretAccessKey };
}
