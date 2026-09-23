import { isString, isUndefined, sleep, xmlRoot } from 'ohnejs/utils';
import { digest } from 'ohnejs/utils/crypto';

import type { S3Credentials } from './credentials.ts';
import type { S3Failure } from './failure.ts';
import type { S3Location } from './location.ts';

import { failureError, readFailure, retryDelay, unreachableError } from './failure.ts';
import {
  canonicalPath,
  canonicalQuery,
  EMPTY_PAYLOAD_HASH,
  signV4,
  UNSIGNED_PAYLOAD,
} from './sigv4.ts';

/**
 * One request to the bucket, signed and retried by `S3Client`.
 */
export interface S3Request {
  /**
   * The S3 operation, such as `PutObject`, named in failure messages.
   */
  operation: string;

  /**
   * The HTTP method.
   */
  method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE';

  /**
   * The full object key, or omitted for a request to the bucket itself.
   */
  key?: string;

  /**
   * The query parameters; a subresource without a value is `''`.
   */
  query?: Record<string, string>;

  /**
   * The headers to send, by lower-case name.
   */
  headers?: Record<string, string>;

  /**
   * The body: bytes are sent unsigned, a string is an XML document and is hashed into the signature.
   */
  body?: Uint8Array | string;

  /**
   * The non-2xx statuses that resolve like a success instead of failing, such as `[404]`.
   * A `NoSuchBucket` answer still fails, so a misnamed bucket never reads as a missing object.
   *
   * @default
   * []
   */
  accept?: readonly number[];

  /**
   * The milliseconds the whole exchange may take, or `false` for a request that moves object bytes.
   *
   * @default
   * 30_000
   */
  timeout?: number | false;

  /**
   * Whether a transient failure is retried with backoff, or fails on the first attempt.
   *
   * @default
   * true
   */
  retry?: boolean;
}

/**
 * Sends signed requests to the bucket of one location.
 */
export interface S3Client {
  /**
   * The location the client addresses.
   */
  location: S3Location;

  /**
   * Sends `request` and resolves its response, retrying transient failures.
   * The caller reads or cancels the body.
   */
  send(request: S3Request): Promise<Response>;

  /**
   * Sends `request` and resolves its body text.
   * An `<Error>` document in a `2xx` answer is a failure, retried like any other.
   */
  sendXML(request: S3Request): Promise<string>;

  /**
   * The `x-amz-copy-source` value that names `key` in this bucket.
   */
  copySource(key: string): string;
}

/**
 * The milliseconds a request that moves no object bytes may take, body included.
 */
export const CONTROL_TIMEOUT = 30_000;

/**
 * The namespace of every S3 XML document.
 */
export const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

/**
 * An attempt's outcome: the value to resolve, or the failure to retry or report.
 */
type Outcome<T> = { value: T } | { failure: S3Failure };

/**
 * Creates a client for the bucket at `location`, signing with `credentials`.
 *
 * Every attempt is signed afresh, so a retry after a long backoff stays inside the clock window.
 * Redirects are never followed: a bucket in another region fails with a message naming its region.
 *
 * @example
 * ```ts
 * const client = createS3Client(parseS3Location('s3://photos'), s3Credentials())
 * await client.sendXML({ operation: 'ListObjectsV2', method: 'GET', query: { 'list-type': '2' } })
 * ```
 */
export function createS3Client(location: S3Location, credentials: S3Credentials): S3Client {
  const endpoint = new URL(location.endpoint);
  const host = location.pathStyle ? endpoint.host : `${location.bucket}.${endpoint.host}`;
  const origin = `${endpoint.protocol}//${host}`;
  const base = location.pathStyle ? `/${location.bucket}` : '';

  async function exchange<T>(
    request: S3Request,
    read: (response: Response) => Promise<Outcome<T>>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let failure: S3Failure | undefined;
      let cause: unknown;
      try {
        const response = await fetchSigned(request);
        const outcome = response.ok
          ? await read(response)
          : await readRefusal(response, request.accept ?? [], read);
        if ('value' in outcome) return outcome.value;
        failure = outcome.failure;
      } catch (error) {
        cause = error;
      }
      const delay = request.retry === false ? undefined : retryDelay(failure, attempt);
      if (isUndefined(delay)) {
        throw isUndefined(failure)
          ? unreachableError(cause, host)
          : failureError(request.operation, failure, location);
      }
      await sleep(delay);
    }
  }

  function fetchSigned(request: S3Request): Promise<Response> {
    const { method, body, query = {}, timeout = CONTROL_TIMEOUT } = request;
    const payloadHash = isUndefined(body)
      ? EMPTY_PAYLOAD_HASH
      : isString(body)
        ? digest('sha256', body).toHex()
        : UNSIGNED_PAYLOAD;
    const path = isUndefined(request.key) ? base || '/' : `${base}/${request.key}`;
    const headers = signV4(
      {
        method,
        host,
        path,
        query,
        headers: {
          ...(isString(body) && { 'content-type': 'application/xml' }),
          ...request.headers,
          'x-amz-content-sha256': payloadHash,
        },
        payloadHash,
      },
      { credentials, region: location.region, service: 's3', date: new Date() },
    );
    const search = canonicalQuery(query);
    return fetch(`${origin}${canonicalPath(path)}${search && `?${search}`}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: timeout === false ? undefined : AbortSignal.timeout(timeout),
    });
  }

  return {
    location,
    send: (request) => exchange<Response>(request, async (value) => ({ value })),
    sendXML: (request) =>
      exchange<string>(request, async (response) => {
        const text = await response.text();
        return response.ok && xmlRoot(text) === 'Error'
          ? { failure: readFailure(200, response.headers, text) }
          : { value: text };
      }),
    copySource: (key) => canonicalPath(`/${location.bucket}/${key}`),
  };
}

/**
 * The outcome of a non-2xx answer: `read` resolves an accepted status, anything else is a failure.
 * The body is read first, so an accepted status that names a missing bucket fails too.
 */
async function readRefusal<T>(
  response: Response,
  accept: readonly number[],
  read: (response: Response) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const { status, headers } = response;
  const text = await response.text();
  const failure = readFailure(status, headers, text);
  if (!accept.includes(status) || failure.code === 'NoSuchBucket') return { failure };
  return read(new Response(text, { status, headers }));
}
