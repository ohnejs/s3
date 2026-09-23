import type { OhneError } from 'ohnejs';

import { ohneError } from 'ohnejs';
import {
  coerceToBoolean,
  didYouMean,
  isBoolean,
  isNull,
  isUndefined,
  parseBytes,
  stripUserinfo,
} from 'ohnejs/utils';

import { MAX_PART_SIZE, MIN_PART_SIZE } from './multipart.ts';

/**
 * A parsed `s3://` location: the bucket, the key prefix, and how to reach them.
 */
export interface S3Location {
  /**
   * The bucket name.
   */
  bucket: string;

  /**
   * The key prefix every object sits under, without surrounding slashes, or `''` for none.
   */
  prefix: string;

  /**
   * The region requests are signed for.
   */
  region: string;

  /**
   * The endpoint origin, such as `https://s3.eu-central-1.amazonaws.com`, with no default port.
   */
  endpoint: string;

  /**
   * Whether requests address the bucket as `/<bucket>/<key>` on the endpoint, rather than as its subdomain.
   */
  pathStyle: boolean;

  /**
   * Whether private objects are tagged `private=true`, which gives the storage `setPrivate`.
   */
  tagging: boolean;

  /**
   * The bytes per multipart part.
   */
  partSize: number;
}

/**
 * The values an `s3://` location falls back to where it names none, read from the env by the caller.
 */
export interface S3LocationDefaults {
  /**
   * The region, from `AWS_REGION`.
   */
  region?: string;

  /**
   * The endpoint origin, from `AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL`.
   */
  endpoint?: string;
}

const OPTIONS = ['region', 'endpoint', 'pathStyle', 'tagging', 'partSize'];

const LOCATION = /^s3:\/\/[^/?#]*([^?#]*)/;

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const DEFAULT_REGION = 'us-east-1';

const DEFAULT_PART_SIZE = 8 * 1024 ** 2;

/**
 * Parses an `s3://<bucket>[/<prefix>][?<option>=<value>&...]` location.
 *
 * The options are `region`, `endpoint`, `pathStyle`, `tagging` and `partSize`.
 * An option in the location wins over its entry in `defaults`, which wins over the built-in default.
 * Without an endpoint the bucket is addressed on AWS, as a subdomain unless its name holds a `.`.
 * A given endpoint switches to path style, which every S3-compatible service accepts.
 * Throws a titled error for a location it cannot use, since it often comes from `UPLOADS_URL`.
 *
 * @example
 * ```ts
 * parseS3Location('s3://photos/uploads?region=eu-central-1')
 * // -> { bucket: 'photos', prefix: 'uploads', region: 'eu-central-1',
 * //      endpoint: 'https://s3.eu-central-1.amazonaws.com', pathStyle: false, tagging: true,
 * //      partSize: 8388608 }
 *
 * parseS3Location('s3://photos', { endpoint: 'http://localhost:9000' })
 * // -> { bucket: 'photos', prefix: '', region: 'us-east-1', endpoint: 'http://localhost:9000',
 * //      pathStyle: true, tagging: true, partSize: 8388608 }
 * ```
 */
export function parseS3Location(url: string, defaults: S3LocationDefaults = {}): S3Location {
  const parsed = URL.parse(url);
  const raw = LOCATION.exec(url);
  if (parsed?.username || parsed?.password) throw credentialsError('location', '`uploads.url`');
  if (!parsed || !raw || parsed.protocol !== 's3:' || !parsed.hostname || parsed.port) {
    throw invalidLocation(url);
  }

  const bucket = parsed.hostname;
  if (!BUCKET.test(bucket)) {
    throw ohneError({
      title: `Invalid bucket name \`${bucket}\``,
      body: 'A bucket name is 3 to 63 lowercase letters, digits, `.` and `-`.',
    });
  }

  const options = parsed.searchParams;
  for (const name of options.keys()) {
    if (OPTIONS.includes(name)) continue;
    const suggestion = didYouMean(name, OPTIONS);
    throw ohneError({
      title: `Unknown S3 option \`${name}\``,
      body: [
        '`uploads.url` takes `region`, `endpoint`, `pathStyle`, `tagging` and `partSize`.',
        ...(isUndefined(suggestion) ? [] : [`Did you mean \`${suggestion}\`?`]),
      ],
    });
  }

  const region = options.get('region') ?? defaults.region ?? DEFAULT_REGION;
  const given = options.get('endpoint') ?? defaults.endpoint;
  return {
    bucket,
    prefix: parsePrefix(raw[1], url),
    region,
    endpoint: isUndefined(given) ? awsEndpoint(region) : parseEndpoint(given),
    pathStyle: booleanOption(options, 'pathStyle', !isUndefined(given) || bucket.includes('.')),
    tagging: booleanOption(options, 'tagging', true),
    partSize: parsePartSize(options.get('partSize')),
  };
}

/**
 * The error for a user or password in the S3 `part`, which `source` names, since it ends up in logs.
 */
function credentialsError(part: 'location' | 'endpoint', source: string): OhneError {
  return ohneError({
    title: `Credentials in the S3 ${part}`,
    body: [
      `${source} names a user or password, and it ends up in logs and config.`,
      'Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` instead.',
    ],
  });
}

/**
 * The error for a location that is not an `s3://` URL with a bucket.
 * Any userinfo is stripped from the title, since a location no parser accepts can still hold a secret.
 */
function invalidLocation(url: string): OhneError {
  return ohneError({
    title: `Invalid S3 location \`${stripUserinfo(url)}\``,
    body: [
      'The `s3` storage reads `uploads.url` or `UPLOADS_URL` as `s3://<bucket>/<prefix>`.',
      '',
      '- `s3://my-bucket?region=eu-central-1`',
    ],
  });
}

/**
 * The key prefix from the raw location path, decoded, with empty segments dropped.
 * The raw path is read because the URL parser silently collapses a `.` or `..` segment.
 */
function parsePrefix(path: string, url: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw invalidLocation(url);
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw ohneError({
      title: `Invalid S3 prefix \`${path.replace(/^\/+/, '')}\``,
      body: 'A prefix segment cannot be `.` or `..`.',
    });
  }
  return segments.join('/');
}

/**
 * The AWS endpoint of `region`, on the China partition's domain for a `cn-` region.
 */
function awsEndpoint(region: string): string {
  const domain = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  return `https://s3.${region}.${domain}`;
}

/**
 * The origin of an `http` or `https` endpoint, which drops a default port as fetch does.
 */
function parseEndpoint(value: string): string {
  const endpoint = URL.parse(value);
  if (endpoint?.username || endpoint?.password) throw credentialsError('endpoint', 'The endpoint');
  const isOrigin =
    endpoint &&
    (endpoint.protocol === 'http:' || endpoint.protocol === 'https:') &&
    endpoint.pathname === '/' &&
    !endpoint.search &&
    !endpoint.hash;
  if (!isOrigin) {
    throw ohneError({
      title: `Invalid S3 endpoint \`${stripUserinfo(value)}\``,
      body: 'The endpoint is an `http` or `https` origin, such as `https://fsn1.your-objectstorage.com`.',
    });
  }
  return endpoint.origin;
}

/**
 * The boolean option `name`, or `fallback` when the location omits it.
 */
function booleanOption(options: URLSearchParams, name: string, fallback: boolean): boolean {
  const value = options.get(name);
  if (isNull(value)) return fallback;
  const parsed = coerceToBoolean(value);
  if (isBoolean(parsed)) return parsed;
  throw ohneError({
    title: `Invalid S3 option \`${name}=${value}\``,
    body: `\`${name}\` is \`true\` or \`false\`.`,
  });
}

/**
 * The part size in bytes, within the range S3 accepts for a multipart part.
 */
function parsePartSize(value: string | null): number {
  if (isNull(value)) return DEFAULT_PART_SIZE;
  let size: number;
  try {
    size = parseBytes(value);
  } catch {
    size = NaN;
  }
  if (size >= MIN_PART_SIZE && size <= MAX_PART_SIZE) return size;
  throw ohneError({
    title: `Invalid S3 part size \`${value}\``,
    body: '`partSize` is a size from `5mb` to `5gb`.',
  });
}
