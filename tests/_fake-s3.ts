import type { IncomingMessage, ServerResponse } from 'node:http';

import { createServer } from 'node:http';
import { escapeXML, xmlBlocks, xmlText } from 'ohnejs/utils';
import { digest } from 'ohnejs/utils/crypto';

import { EMPTY_PAYLOAD_HASH, signV4, UNSIGNED_PAYLOAD } from '../src/sigv4.ts';
import { TEST_CREDENTIALS } from './_fixtures.ts';

/**
 * An object the fake stores.
 */
export interface FakeS3Object {
  bytes: Uint8Array;
  type: string;
  cacheControl?: string;
  disposition?: string;
  etag: string;
  tags: Record<string, string>;
}

/**
 * How the fake behaves.
 */
export interface FakeS3Options {
  maxKeys?: number;
  tagging?: boolean;
  region?: string;
}

/**
 * A failure the fake answers in place of the next calls of an operation.
 */
export interface FakeS3Failure {
  status: number;
  code: string;
  times?: number;
  embedded?: boolean;
}

/**
 * A request the fake received, after its signature checked out.
 */
export interface FakeS3Request {
  operation: string;
  key: string;
  headers: Record<string, string>;
}

/**
 * An in-process S3 with one path-style bucket, `bucket`, that verifies every signature.
 */
export interface FakeS3 {
  endpoint: string;
  location(options?: Record<string, string>, prefix?: string): string;
  objects: Map<string, FakeS3Object>;
  uploads: Map<string, unknown>;
  requests: FakeS3Request[];
  fail(operation: string, failure: FakeS3Failure): void;
  dropAfter(operation: string): void;
  protect(key: string): void;
  close(): Promise<void>;
}

interface Upload {
  key: string;
  type: string;
  cacheControl?: string;
  disposition?: string;
  tags: Record<string, string>;
  parts: Map<number, Uint8Array>;
}

interface Exchange {
  method: string;
  bucket: string;
  key: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

const BUCKET = 'bucket';

const MIN_PART = 5 * 1024 ** 2;

const md5Hex = (bytes: Uint8Array | string): string => digest('md5', bytes).toHex();

const xml = (status: number, body: string): Answer => ({
  status,
  headers: { 'content-type': 'application/xml' },
  body: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`,
});

const error = (status: number, code: string, extra = ''): Answer =>
  xml(
    status,
    `<Error><Code>${code}</Code><Message>${code} from the fake</Message>${extra}</Error>`,
  );

/**
 * Starts the fake on a free loopback port.
 */
export async function startFakeS3(options: FakeS3Options = {}): Promise<FakeS3> {
  const { maxKeys = 1000, tagging = true, region = 'us-east-1' } = options;
  const objects = new Map<string, FakeS3Object>();
  const uploads = new Map<string, Upload>();
  const requests: FakeS3Request[] = [];
  const failures = new Map<string, FakeS3Failure & { times: number }>();
  const drops = new Set<string>();
  const protectedKeys = new Set<string>();
  let nextUpload = 0;

  const server = createServer(async (req, res) => {
    const exchange = await readExchange(req).catch(() => undefined);
    if (!exchange) return;
    const denied = verify(req, exchange, region);
    if (denied) return send(res, req.method, denied);

    const operation = operationOf(exchange);
    requests.push({ operation, key: exchange.key, headers: exchange.headers });
    if (exchange.bucket !== BUCKET) return send(res, req.method, error(404, 'NoSuchBucket'));

    const failure = failures.get(operation);
    if (failure) {
      if (--failure.times <= 0) failures.delete(operation);
      return send(res, req.method, injected(failure));
    }
    const answer = perform(operation, exchange);
    if (drops.delete(operation)) return res.socket?.destroy();
    send(res, req.method, answer);
  });

  function perform(operation: string, { key, query, headers, body }: Exchange): Answer {
    const object = objects.get(key);
    if (operation.includes('Tagging') && !tagging) return error(501, 'NotImplemented');

    switch (operation) {
      case 'HeadObject':
        return object ? { status: 200, headers: objectHeaders(object) } : { status: 404 };
      case 'GetObject':
        return object ? getObject(object, headers.range) : error(404, 'NoSuchKey');
      case 'PutObject': {
        if (!('content-length' in headers)) return error(411, 'MissingContentLength');
        const stored = store(key, body, headers, parseTags(headers['x-amz-tagging']));
        return { status: 200, headers: { etag: stored.etag } };
      }
      case 'CopyObject': {
        const copied = copySource(headers['x-amz-copy-source']);
        if (copied.bucket !== BUCKET) return error(404, 'NoSuchBucket');
        const source = objects.get(copied.key);
        if (!source) return error(404, 'NoSuchKey');
        objects.set(key, { ...source, tags: { ...source.tags } });
        return xml(
          200,
          `<CopyObjectResult><ETag>${escapeXML(source.etag)}</ETag></CopyObjectResult>`,
        );
      }
      case 'DeleteObject':
        objects.delete(key);
        return { status: 204 };
      case 'ListObjectsV2':
        return listObjects(
          query.prefix ?? '',
          query['continuation-token'],
          Math.min(maxKeys, Number(query['max-keys'] ?? maxKeys)),
        );
      case 'DeleteObjects':
        return deleteObjects(body, headers['content-md5']);
      case 'CreateMultipartUpload': {
        const uploadId = `upload-${++nextUpload}`;
        uploads.set(uploadId, {
          key,
          type: headers['content-type'] ?? 'binary/octet-stream',
          cacheControl: headers['cache-control'],
          disposition: headers['content-disposition'],
          tags: parseTags(headers['x-amz-tagging']),
          parts: new Map(),
        });
        return xml(
          200,
          `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${escapeXML(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      case 'UploadPart': {
        const upload = uploads.get(query.uploadId);
        if (!upload) return error(404, 'NoSuchUpload');
        upload.parts.set(Number(query.partNumber), body);
        return { status: 200, headers: { etag: `"${md5Hex(body)}"` } };
      }
      case 'UploadPartCopy': {
        const upload = uploads.get(query.uploadId);
        const copied = copySource(headers['x-amz-copy-source']);
        if (copied.bucket !== BUCKET) return error(404, 'NoSuchBucket');
        const source = objects.get(copied.key);
        if (!upload) return error(404, 'NoSuchUpload');
        if (!source) return error(404, 'NoSuchKey');
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers['x-amz-copy-source-range']) ?? [];
        const part = source.bytes.slice(Number(start), Number(end) + 1);
        upload.parts.set(Number(query.partNumber), part);
        return xml(200, `<CopyPartResult><ETag>&#34;${md5Hex(part)}&#34;</ETag></CopyPartResult>`);
      }
      case 'CompleteMultipartUpload':
        return completeUpload(query.uploadId, new TextDecoder().decode(body));
      case 'AbortMultipartUpload':
        uploads.delete(query.uploadId);
        return { status: 204 };
      case 'PutObjectTagging': {
        if (!object) return error(404, 'NoSuchKey');
        const tags = xmlBlocks(new TextDecoder().decode(body), 'Tag');
        object.tags = Object.fromEntries(
          tags.map((tag) => [xmlText(tag, 'Key') ?? '', xmlText(tag, 'Value') ?? '']),
        );
        return { status: 200 };
      }
      case 'GetObjectTagging': {
        if (!object) return error(404, 'NoSuchKey');
        const tags = Object.entries(object.tags)
          .map(
            ([name, value]) =>
              `<Tag><Key>${escapeXML(name)}</Key><Value>${escapeXML(value)}</Value></Tag>`,
          )
          .join('');
        return xml(200, `<Tagging><TagSet>${tags}</TagSet></Tagging>`);
      }
      case 'DeleteObjectTagging':
        if (!object) return error(404, 'NoSuchKey');
        object.tags = {};
        return { status: 204 };
      default:
        return error(400, 'NotImplemented');
    }
  }

  function store(
    key: string,
    bytes: Uint8Array,
    headers: Record<string, string>,
    tags: Record<string, string>,
    etag = `"${md5Hex(bytes)}"`,
  ): FakeS3Object {
    const object: FakeS3Object = {
      bytes,
      type: headers['content-type'] ?? 'binary/octet-stream',
      ...(headers['cache-control'] && { cacheControl: headers['cache-control'] }),
      ...(headers['content-disposition'] && { disposition: headers['content-disposition'] }),
      etag,
      tags,
    };
    objects.set(key, object);
    return object;
  }

  function getObject(object: FakeS3Object, range: string | undefined): Answer {
    const size = object.bytes.length;
    const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return { status: 200, headers: objectHeaders(object), body: object.bytes };
    const start = Number(match[1]);
    if (start >= size) return error(416, 'InvalidRange');
    const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
    return {
      status: 206,
      headers: { ...objectHeaders(object), 'content-range': `bytes ${start}-${end}/${size}` },
      body: object.bytes.slice(start, end + 1),
    };
  }

  function listObjects(prefix: string, token: string | undefined, pageSize: number): Answer {
    const after = token ? Buffer.from(token, 'base64url').toString() : '';
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix) && key > after).sort();
    const page = keys.slice(0, pageSize);
    const truncated = keys.length > page.length;
    const contents = page
      .map(
        (key) =>
          `<Contents><Key>${escapeXML(key)}</Key><Size>${objects.get(key)?.bytes.length}</Size></Contents>`,
      )
      .join('');
    const next = truncated
      ? `<NextContinuationToken>${Buffer.from(page.at(-1) ?? '').toString('base64url')}</NextContinuationToken>`
      : '';
    return xml(
      200,
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${escapeXML(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
    );
  }

  function deleteObjects(body: Uint8Array, md5: string | undefined): Answer {
    if (!md5) return error(400, 'MissingContentMD5');
    if (md5 !== digest('md5', body).toBase64()) return error(400, 'BadDigest');
    const errors: string[] = [];
    for (const block of xmlBlocks(new TextDecoder().decode(body), 'Object')) {
      const key = xmlText(block, 'Key') ?? '';
      if (protectedKeys.has(key)) {
        errors.push(
          `<Error><Key>${escapeXML(key)}</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`,
        );
      } else {
        objects.delete(key);
      }
    }
    return xml(200, `<DeleteResult>${errors.join('')}</DeleteResult>`);
  }

  function completeUpload(uploadId: string, body: string): Answer {
    const upload = uploads.get(uploadId);
    if (!upload) return error(404, 'NoSuchUpload');
    const listed = xmlBlocks(body, 'Part').map((part) => ({
      number: Number(xmlText(part, 'PartNumber')),
      etag: xmlText(part, 'ETag') ?? '',
    }));
    const chunks: Uint8Array[] = [];
    for (const [index, { number, etag }] of listed.entries()) {
      const bytes = upload.parts.get(number);
      if (!bytes || etag !== `"${md5Hex(bytes)}"`) return error(400, 'InvalidPart');
      if (index > 0 && number <= listed[index - 1].number) return error(400, 'InvalidPartOrder');
      if (index < listed.length - 1 && bytes.length < MIN_PART) return error(400, 'EntityTooSmall');
      chunks.push(bytes);
    }
    const hashes = new Uint8Array(chunks.flatMap((chunk) => [...digest('md5', chunk)]));
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const etag = `"${md5Hex(hashes)}-${chunks.length}"`;
    store(
      upload.key,
      bytes,
      {
        'content-type': upload.type,
        ...(upload.cacheControl && { 'cache-control': upload.cacheControl }),
        ...(upload.disposition && { 'content-disposition': upload.disposition }),
      },
      upload.tags,
      etag,
    );
    uploads.delete(uploadId);
    return xml(
      200,
      `<CompleteMultipartUploadResult><Key>${escapeXML(upload.key)}</Key><ETag>${escapeXML(etag)}</ETag></CompleteMultipartUploadResult>`,
    );
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const endpoint = `http://127.0.0.1:${port}`;

  return {
    endpoint,
    location: (options = {}, prefix = '') =>
      `s3://${BUCKET}${prefix && `/${prefix}`}?${new URLSearchParams({ endpoint, region: 'us-east-1', ...options })}`,
    objects,
    uploads,
    requests,
    fail: (operation, failure) =>
      failures.set(operation, { ...failure, times: failure.times ?? 1 }),
    dropAfter: (operation) => drops.add(operation),
    protect: (key) => protectedKeys.add(key),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Reads a request's path, query, headers and body, decoding the path and query as S3 does.
 */
async function readExchange(req: IncomingMessage): Promise<Exchange> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const [rawPath = '', rawQuery = ''] = (req.url ?? '').split('?');
  const segments = rawPath.split('/').map(decodeURIComponent);
  const query = Object.fromEntries(
    rawQuery
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const [name = '', value = ''] = pair.split('=');
        return [decodeURIComponent(name), decodeURIComponent(value)];
      }),
  );
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([name, value]) => [name, String(value)]),
  );
  return {
    method: req.method ?? 'GET',
    bucket: segments[1] ?? '',
    key: segments.slice(2).join('/'),
    query,
    headers,
    body: new Uint8Array(Buffer.concat(chunks)),
  };
}

/**
 * Re-signs the request from what arrived and compares, or answers why it is refused.
 */
function verify(req: IncomingMessage, exchange: Exchange, region: string): Answer | undefined {
  const { headers, body } = exchange;
  const payloadHash = headers['x-amz-content-sha256'];
  if (!payloadHash) return error(400, 'InvalidRequest');
  if (payloadHash !== UNSIGNED_PAYLOAD && payloadHash !== digest('sha256', body).toHex()) {
    return error(400, 'XAmzContentSHA256Mismatch');
  }
  if (payloadHash === EMPTY_PAYLOAD_HASH && body.length > 0)
    return error(400, 'XAmzContentSHA256Mismatch');

  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,SignedHeaders=([^,]+),Signature=[0-9a-f]{64}$/.exec(
      headers.authorization ?? '',
    );
  if (!match) return error(403, 'AccessDenied');
  const [, accessKeyId, , signedRegion, names] = match;
  if (accessKeyId !== TEST_CREDENTIALS.accessKeyId) return error(403, 'InvalidAccessKeyId');
  if (signedRegion !== region) {
    return error(400, 'AuthorizationHeaderMalformed', `<Region>${region}</Region>`);
  }

  const signed = Object.fromEntries(
    names
      .split(';')
      .filter((name) => name !== 'host')
      .map((name) => [name, headers[name] ?? '']),
  );
  const stamp = headers['x-amz-date'] ?? '';
  const date = new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
  const [path] = (req.url ?? '').split('?');
  const expected = signV4(
    {
      method: exchange.method,
      host: headers.host ?? '',
      path: path.split('/').map(decodeURIComponent).join('/'),
      query: exchange.query,
      headers: signed,
      payloadHash,
    },
    { credentials: TEST_CREDENTIALS, region, service: 's3', date },
  );
  return expected.authorization === headers.authorization
    ? undefined
    : error(403, 'SignatureDoesNotMatch');
}

/**
 * The S3 operation a request names, from its method, key, query and headers.
 */
function operationOf({ method, key, query, headers }: Exchange): string {
  if (!key) {
    if (method === 'GET' && query['list-type'] === '2') return 'ListObjectsV2';
    if (method === 'POST' && 'delete' in query) return 'DeleteObjects';
    return `${method}Bucket`;
  }
  if ('uploads' in query) return 'CreateMultipartUpload';
  if ('uploadId' in query) {
    if (method === 'PUT') return 'x-amz-copy-source' in headers ? 'UploadPartCopy' : 'UploadPart';
    return method === 'POST' ? 'CompleteMultipartUpload' : 'AbortMultipartUpload';
  }
  if ('tagging' in query) {
    return { PUT: 'PutObjectTagging', GET: 'GetObjectTagging' }[method] ?? 'DeleteObjectTagging';
  }
  if (method === 'PUT') return 'x-amz-copy-source' in headers ? 'CopyObject' : 'PutObject';
  return { GET: 'GetObject', HEAD: 'HeadObject' }[method] ?? 'DeleteObject';
}

/**
 * The answer for an injected failure: a redirect, an embedded error, or a plain one.
 */
function injected({ status, code, embedded }: FakeS3Failure): Answer {
  if (status === 301 || status === 307) {
    return {
      ...error(status, code, '<Endpoint>bucket.s3.eu-west-1.amazonaws.com</Endpoint>'),
      headers: {
        'content-type': 'application/xml',
        location: 'https://bucket.s3.eu-west-1.amazonaws.com/',
        'x-amz-bucket-region': 'eu-west-1',
      },
    };
  }
  return error(embedded ? 200 : status, code);
}

/**
 * The headers a `HEAD` or `GET` of an object carries.
 */
function objectHeaders(object: FakeS3Object): Record<string, string> {
  return {
    'content-length': String(object.bytes.length),
    'content-type': object.type,
    etag: object.etag,
    ...(object.cacheControl && { 'cache-control': object.cacheControl }),
    ...(object.disposition && { 'content-disposition': object.disposition }),
  };
}

/**
 * The bucket and key an `x-amz-copy-source` names.
 */
function copySource(source: string | undefined): { bucket: string; key: string } {
  const [bucket = '', ...key] = (source ?? '')
    .replace(/^\//, '')
    .split('/')
    .map(decodeURIComponent);
  return { bucket, key: key.join('/') };
}

/**
 * The tag set of an `x-amz-tagging` header.
 */
function parseTags(header: string | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(header ?? ''));
}

/**
 * Writes `answer`, leaving out the body of a `HEAD`.
 */
function send(res: ServerResponse, method: string | undefined, answer: Answer): void {
  const body = method === 'HEAD' ? undefined : answer.body;
  const headers = { ...answer.headers };
  if (method !== 'HEAD') {
    headers['content-length'] = String(body ? Buffer.byteLength(body) : 0);
  }
  res.writeHead(answer.status, headers);
  res.end(body);
}
