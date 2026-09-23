import type { OhneError } from 'ohnejs';

import { STATUS_CODES } from 'node:http';
import { ohneError } from 'ohnejs';
import { errorMessage, xmlText } from 'ohnejs/utils';

import type { S3Location } from './location.ts';

/**
 * What S3 answered to a request that failed.
 */
export interface S3Failure {
  /**
   * The HTTP status, `200` for an error embedded in a successful answer.
   */
  status: number;

  /**
   * The S3 error code, or a name for the status when the answer has no body, such as `NotFound`.
   */
  code: string;

  /**
   * The error message S3 sent, or `''`.
   */
  message: string;

  /**
   * The bucket's real region, on an answer that says the request went to the wrong one.
   */
  region?: string;
}

const ATTEMPTS = 3;

const CAP = 20_000;

const RETRY_STATUSES = new Set([500, 502, 503, 504]);

const RETRY_CODES = new Set(['InternalError', 'RequestTimeout', 'SlowDown', 'ServiceUnavailable']);

const THROTTLE_CODES = new Set(['SlowDown', 'ServiceUnavailable']);

const REDIRECTS: Record<number, string> = { 301: 'PermanentRedirect', 307: 'TemporaryRedirect' };

const REGION_CODES = new Set([
  'PermanentRedirect',
  'TemporaryRedirect',
  'AuthorizationHeaderMalformed',
]);

const CREDENTIAL_CODES = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch']);

const READ_OPERATIONS = new Set(['GetObject', 'HeadObject']);

/**
 * Reads a failed answer from its status, headers, and XML body.
 * A bodiless answer, as every `HEAD` failure is, is named after its status.
 *
 * @example
 * ```ts
 * readFailure(404, headers, '<Error><Code>NoSuchKey</Code><Message>No key</Message></Error>')
 * // -> { status: 404, code: 'NoSuchKey', message: 'No key' }
 *
 * readFailure(301, new Headers({ 'x-amz-bucket-region': 'eu-west-1' }), '')
 * // -> { status: 301, code: 'PermanentRedirect', message: '', region: 'eu-west-1' }
 * ```
 */
export function readFailure(status: number, headers: Headers, xml: string): S3Failure {
  const code = xmlText(xml, 'Code') ?? REDIRECTS[status] ?? statusName(status);
  const failure: S3Failure = { status, code, message: xmlText(xml, 'Message') ?? '' };
  if (!REDIRECTS[status] && !REGION_CODES.has(code)) return failure;

  const region = xmlText(xml, 'Region') ?? headers.get('x-amz-bucket-region');
  return region ? { ...failure, region } : failure;
}

/**
 * The delay before retrying a failed attempt, or `undefined` when it is not retried.
 * `attempt` counts from 1; an `undefined` failure is a network error or a timeout.
 * Server errors, timeouts and throttling are retried with full jitter, throttling from a longer base.
 *
 * @example
 * ```ts
 * retryDelay({ status: 503, code: 'SlowDown', message: '' }, 1)     // -> 0 to 2000
 * retryDelay({ status: 403, code: 'AccessDenied', message: '' }, 1) // -> undefined
 * retryDelay(undefined, 3)                                          // -> undefined
 * ```
 */
export function retryDelay(failure: S3Failure | undefined, attempt: number): number | undefined {
  if (attempt >= ATTEMPTS) return undefined;
  if (failure && !RETRY_STATUSES.has(failure.status) && !RETRY_CODES.has(failure.code)) {
    return undefined;
  }
  const throttled = failure && (failure.status === 503 || THROTTLE_CODES.has(failure.code));
  return Math.random() * Math.min(CAP, (throttled ? 1_000 : 50) * 2 ** attempt);
}

/**
 * The one-line error for a failed operation, with the fix when the failure has a known cause.
 * The journal names the operation and the path, so the message repeats neither.
 *
 * @example
 * ```ts
 * failureError('GetObject', { status: 404, code: 'NoSuchBucket', message: '' }, location)
 * // -> OhneError('Bucket `photos` does not exist: create it, or name another ...')
 * ```
 */
export function failureError(
  operation: string,
  failure: S3Failure,
  location: S3Location,
): OhneError {
  const { bucket } = location;
  if (failure.region) {
    const { region } = failure;
    return ohneError(
      `Bucket \`${bucket}\` is in \`${region}\`: set \`region=${region}\` in \`uploads.url\` or \`AWS_REGION\``,
    );
  }
  if (REGION_CODES.has(failure.code)) {
    return ohneError(
      `Bucket \`${bucket}\` is in another region: set \`region\` in \`uploads.url\` or \`AWS_REGION\``,
    );
  }
  if (failure.code === 'NoSuchBucket') {
    return ohneError(
      `Bucket \`${bucket}\` does not exist: create it, or name another in \`uploads.url\` or \`UPLOADS_URL\``,
    );
  }
  if (CREDENTIAL_CODES.has(failure.code)) {
    return ohneError(
      'S3 rejected the credentials: check `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`',
    );
  }
  if (failure.code === 'RequestTimeTooSkewed') {
    return ohneError("S3 refused the request time: sync this machine's clock");
  }
  if (
    operation.includes('Tagging') &&
    (failure.code === 'NotImplemented' || failure.status === 501)
  ) {
    const { host } = new URL(location.endpoint);
    return ohneError(`\`${host}\` has no object tagging: add \`tagging=false\` to \`uploads.url\``);
  }
  if (failure.status === 403 && READ_OPERATIONS.has(operation)) {
    return ohneError(
      `S3 denied \`${operation}\`: grant \`s3:GetObject\`, and \`s3:ListBucket\` so a missing file reads as missing`,
    );
  }
  if (failure.status === 403 && operation === 'ListObjectsV2') {
    return ohneError('S3 denied `ListObjectsV2`: grant `s3:ListBucket`');
  }
  const message = failure.message ? `: ${failure.message}` : '';
  return ohneError(`S3 answered \`${failure.code}\`${message}`);
}

/**
 * The one-line error for a `host` that never answered, after the retries ran out.
 *
 * @example
 * ```ts
 * unreachableError(new TypeError('fetch failed', { cause }), 'photos.s3.eu-central-1.amazonaws.com')
 * // -> OhneError('S3 at `photos.s3.eu-central-1.amazonaws.com` did not answer: connect ECONNREFUSED ...')
 * ```
 */
export function unreachableError(error: unknown, host: string): OhneError {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return ohneError(`S3 at \`${host}\` did not answer: ${errorMessage(cause)}`);
}

/**
 * A status as an S3-style code, such as `NotFound` for `404`.
 */
function statusName(status: number): string {
  return (STATUS_CODES[status] ?? `Status ${status}`).replace(/[^a-z0-9]/gi, '');
}
