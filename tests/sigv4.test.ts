import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import type { SigV4Request } from '../src/sigv4.ts';

import {
  canonicalPath,
  canonicalQuery,
  EMPTY_PAYLOAD_HASH,
  signV4,
  UNSIGNED_PAYLOAD,
} from '../src/sigv4.ts';

const s3Scope = {
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  region: 'us-east-1',
  service: 's3',
  date: new Date('2013-05-24T00:00:00Z'),
};

const suiteScope = {
  credentials: {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  },
  region: 'us-east-1',
  service: 'service',
  date: new Date('2015-08-30T12:36:00Z'),
};

function s3Request(request: Partial<SigV4Request>): SigV4Request {
  const payloadHash = request.payloadHash ?? EMPTY_PAYLOAD_HASH;
  return {
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/',
    ...request,
    headers: { ...request.headers, 'x-amz-content-sha256': payloadHash },
    payloadHash,
  };
}

function suiteRequest(path: string, query: Record<string, string> = {}): SigV4Request {
  return {
    method: 'GET',
    host: 'example.amazonaws.com',
    path,
    query,
    headers: {},
    payloadHash: EMPTY_PAYLOAD_HASH,
  };
}

function signature(headers: Record<string, string>): string {
  return /Signature=([0-9a-f]+)$/.exec(headers.authorization)?.[1] ?? '';
}

describe('signV4', () => {
  describe('the S3 examples', () => {
    it('signs a ranged GET', () => {
      const headers = signV4(
        s3Request({ path: '/test.txt', headers: { range: 'bytes=0-9' } }),
        s3Scope,
      );

      strictEqual(
        headers.authorization,
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
          'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
          'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
      );
    });

    it('signs a PUT whose key needs encoding', () => {
      const headers = signV4(
        s3Request({
          method: 'PUT',
          path: '/test$file.text',
          headers: {
            date: 'Fri, 24 May 2013 00:00:00 GMT',
            'x-amz-storage-class': 'REDUCED_REDUNDANCY',
          },
          payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
        }),
        s3Scope,
      );

      strictEqual(
        signature(headers),
        '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
      );
    });

    it('signs a subresource without a value', () => {
      const headers = signV4(s3Request({ query: { lifecycle: '' } }), s3Scope);

      strictEqual(
        signature(headers),
        'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
      );
    });

    it('signs a listing with its query sorted', () => {
      const headers = signV4(s3Request({ query: { prefix: 'J', 'max-keys': '2' } }), s3Scope);

      strictEqual(
        signature(headers),
        '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
      );
    });
  });

  describe('the aws-c-auth suite', () => {
    const cases: [string, SigV4Request, string][] = [
      [
        'get-vanilla',
        suiteRequest('/'),
        '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
      ],
      [
        'get-space-unnormalized',
        suiteRequest('/example space/'),
        '652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741',
      ],
      [
        'get-utf8',
        suiteRequest('/ሴ'),
        '8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85',
      ],
      [
        'get-slashes-unnormalized',
        suiteRequest('//example//'),
        '87cca117541a147f6df867677d98a7d80dff226d2bfca9e4ffa899665623c7e5',
      ],
      [
        'get-vanilla-query-order-encoded',
        suiteRequest('/', { 'Param-3': 'Value3', Param: 'Value2', ሴ: 'Value1' }),
        '371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac',
      ],
    ];

    for (const [name, request, expected] of cases) {
      it(name, () => {
        strictEqual(signature(signV4(request, suiteScope)), expected);
      });
    }

    it('get-vanilla-with-session-token', () => {
      const sessionToken = '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267';
      const headers = signV4(suiteRequest('/'), {
        ...suiteScope,
        credentials: { ...suiteScope.credentials, sessionToken },
      });

      strictEqual(
        signature(headers),
        '07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8',
      );
      strictEqual(headers['x-amz-security-token'], sessionToken);
    });
  });

  it('returns the headers to send, without host', () => {
    const headers = signV4(
      s3Request({ headers: { 'content-type': 'text/plain' }, payloadHash: UNSIGNED_PAYLOAD }),
      s3Scope,
    );

    deepStrictEqual(Object.keys(headers).sort(), [
      'authorization',
      'content-type',
      'x-amz-content-sha256',
      'x-amz-date',
    ]);
    strictEqual(headers['x-amz-date'], '20130524T000000Z');
  });

  it('signs a value with its whitespace trimmed and collapsed', () => {
    const spaced = signV4(s3Request({ headers: { 'x-amz-meta-a': '  a   b ' } }), s3Scope);
    const tight = signV4(s3Request({ headers: { 'x-amz-meta-a': 'a b' } }), s3Scope);

    strictEqual(signature(spaced), signature(tight));
  });
});

describe('canonicalPath', () => {
  it('keeps empty segments', () => {
    strictEqual(canonicalPath('//a//b/'), '//a//b/');
  });

  it('encodes the characters encodeURIComponent leaves alone', () => {
    strictEqual(canonicalPath("/$!'()*"), '/%24%21%27%28%29%2A');
  });

  it('encodes each segment but keeps the slashes', () => {
    strictEqual(canonicalPath('/photos/a b+c.jpg'), '/photos/a%20b%2Bc.jpg');
  });
});

describe('canonicalQuery', () => {
  it('sorts by encoded name and keeps an empty value', () => {
    strictEqual(
      canonicalQuery({ uploadId: 'x y', partNumber: '2', uploads: '' }),
      'partNumber=2&uploadId=x%20y&uploads=',
    );
  });

  it('is empty without parameters', () => {
    strictEqual(canonicalQuery({}), '');
  });
});
