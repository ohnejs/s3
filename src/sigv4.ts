import { encodeRFC3986 } from 'ohnejs/utils';
import { digest, hmacBytes } from 'ohnejs/utils/crypto';

import type { S3Credentials } from './credentials.ts';

/**
 * The payload hash that leaves a request body out of its signature.
 */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * The hex SHA-256 of an empty body.
 */
export const EMPTY_PAYLOAD_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * A request as SigV4 signs it.
 */
export interface SigV4Request {
  /**
   * The HTTP method.
   */
  method: string;

  /**
   * The host exactly as sent, with a non-default port.
   */
  host: string;

  /**
   * The raw, unencoded path with its leading `/`, never normalized.
   */
  path: string;

  /**
   * The raw query parameters; a subresource without a value is `''`.
   */
  query?: Record<string, string>;

  /**
   * The headers to sign and send, by lower-case name, `host` excluded.
   */
  headers: Record<string, string>;

  /**
   * The hex SHA-256 of the body, `UNSIGNED_PAYLOAD`, or `EMPTY_PAYLOAD_HASH`.
   */
  payloadHash: string;
}

/**
 * Who signs a request, and for which region, service and moment.
 */
export interface SigV4Scope {
  /**
   * The key pair that signs.
   */
  credentials: S3Credentials;

  /**
   * The region the request is scoped to.
   */
  region: string;

  /**
   * The service the request is scoped to, `s3` for S3.
   */
  service: string;

  /**
   * The signing time, which must be within minutes of the server's clock.
   */
  date: Date;
}

/**
 * Encodes a path the way SigV4 canonicalizes it: each segment RFC 3986 encoded, every `/` kept.
 * The path is never normalized, so an empty segment survives.
 *
 * @example
 * ```ts
 * canonicalPath('/photos/a b.jpg') // -> '/photos/a%20b.jpg'
 * canonicalPath('//x//')           // -> '//x//'
 * ```
 */
export function canonicalPath(path: string): string {
  return path.split('/').map(encodeRFC3986).join('/');
}

/**
 * Encodes query parameters the way SigV4 canonicalizes them: encoded, sorted by encoded name.
 *
 * @example
 * ```ts
 * canonicalQuery({ uploads: '' })                     // -> 'uploads='
 * canonicalQuery({ prefix: 'a b', 'list-type': '2' }) // -> 'list-type=2&prefix=a%20b'
 * ```
 */
export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([name, value]) => [encodeRFC3986(name), encodeRFC3986(value)])
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * Signs a request with AWS Signature Version 4 and returns the headers to send.
 *
 * They are the request's headers plus `x-amz-date`, `authorization`, and any session token.
 * `host` is signed but not returned, since fetch sets it from the URL.
 *
 * @example
 * ```ts
 * signV4(
 *   { method: 'GET', host: 'bucket.s3.amazonaws.com', path: '/a.txt', headers: {}, payloadHash },
 *   { credentials, region: 'us-east-1', service: 's3', date: new Date() },
 * )
 * // -> { 'x-amz-date': '20260923T120000Z', authorization: 'AWS4-HMAC-SHA256 Credential=...' }
 * ```
 */
export function signV4(request: SigV4Request, scope: SigV4Scope): Record<string, string> {
  const { credentials, region, service } = scope;
  const stamp = scope.date.toISOString().replace(/[-:]|\.\d+/g, '');
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = { ...request.headers, 'x-amz-date': stamp };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  const signed: Record<string, string> = { ...headers, host: request.host };
  const names = Object.keys(signed).sort();
  const canonical = [
    request.method,
    canonicalPath(request.path),
    canonicalQuery(request.query ?? {}),
    names.map((name) => `${name}:${signed[name].trim().replace(/\s+/g, ' ')}\n`).join(''),
    names.join(';'),
    request.payloadHash,
  ].join('\n');

  const credentialScope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    credentialScope,
    digest('sha256', canonical).toHex(),
  ].join('\n');
  const key = [day, region, service, 'aws4_request'].reduce<string | Uint8Array>(
    (chain, part) => hmacBytes(part, chain),
    `AWS4${credentials.secretAccessKey}`,
  );
  const signature = hmacBytes(stringToSign, key).toHex();
  const credential = `${credentials.accessKeyId}/${credentialScope}`;
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credential},SignedHeaders=${names.join(';')},Signature=${signature}`;
  return headers;
}
