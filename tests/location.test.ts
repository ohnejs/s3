import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { describe, it } from 'node:test';
import { isOhneError } from 'ohnejs';

import type { S3LocationDefaults } from '../src/location.ts';

import { parseS3Location } from '../src/location.ts';
import { MIB } from './_fixtures.ts';

function refuses(url: string, title: string): void {
  throws(
    () => parseS3Location(url),
    (error) => isOhneError(error) && error.title === title,
  );
}

describe('parseS3Location', () => {
  it('addresses an AWS bucket as a subdomain by default', () => {
    deepStrictEqual(parseS3Location('s3://photos'), {
      bucket: 'photos',
      prefix: '',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      pathStyle: false,
      tagging: true,
      partSize: 8 * MIB,
    });
  });

  it('reads every option', () => {
    deepStrictEqual(
      parseS3Location(
        's3://photos/uploads?region=auto&endpoint=https://acc.r2.cloudflarestorage.com&pathStyle=false&tagging=0&partSize=16mb',
      ),
      {
        bucket: 'photos',
        prefix: 'uploads',
        region: 'auto',
        endpoint: 'https://acc.r2.cloudflarestorage.com',
        pathStyle: false,
        tagging: false,
        partSize: 16 * MIB,
      },
    );
  });

  it('uses the China domain for a cn- region', () => {
    strictEqual(
      parseS3Location('s3://photos?region=cn-north-1').endpoint,
      'https://s3.cn-north-1.amazonaws.com.cn',
    );
  });

  it('switches to path style for a given endpoint or a dotted bucket', () => {
    strictEqual(parseS3Location('s3://photos?endpoint=http://localhost:9000').pathStyle, true);
    strictEqual(
      parseS3Location('s3://photos', { endpoint: 'http://localhost:9000' }).pathStyle,
      true,
    );
    strictEqual(parseS3Location('s3://photos.example.com').pathStyle, true);
    strictEqual(parseS3Location('s3://photos?pathStyle=true').pathStyle, true);
  });

  it('prefers an option in the location over its default', () => {
    const defaults = { region: 'eu-west-1', endpoint: 'http://env:9000' };

    deepStrictEqual(
      [
        parseS3Location('s3://photos', defaults).region,
        parseS3Location('s3://photos', defaults).endpoint,
      ],
      ['eu-west-1', 'http://env:9000'],
    );
    const location = parseS3Location(
      's3://photos?region=eu-central-1&endpoint=http://url:9000',
      defaults,
    );
    deepStrictEqual([location.region, location.endpoint], ['eu-central-1', 'http://url:9000']);
  });

  it('normalizes the endpoint to its origin', () => {
    strictEqual(parseS3Location('s3://photos?endpoint=https://host:443/').endpoint, 'https://host');
    strictEqual(parseS3Location('s3://photos?endpoint=http://host:80').endpoint, 'http://host');
    strictEqual(
      parseS3Location('s3://photos?endpoint=http://host:9000').endpoint,
      'http://host:9000',
    );
  });

  it('trims and decodes the prefix', () => {
    strictEqual(parseS3Location('s3://photos//a%20b//c/').prefix, 'a b/c');
    strictEqual(parseS3Location('s3://photos/').prefix, '');
  });

  it('refuses a location that is not s3:// with a bucket', () => {
    refuses('https://photos', 'Invalid S3 location `https://photos`');
    refuses('s3:/photos', 'Invalid S3 location `s3:/photos`');
    refuses('s3://photos:9000', 'Invalid S3 location `s3://photos:9000`');
    refuses('s3://photos/%E0', 'Invalid S3 location `s3://photos/%E0`');
  });

  it('refuses credentials without echoing them', () => {
    const cases: [string, S3LocationDefaults, string][] = [
      ['s3://key:secret@photos', {}, 'Credentials in the S3 location'],
      ['s3://key:secret@photos:9000', {}, 'Credentials in the S3 location'],
      ['s3://key:secret@/x', {}, 'Invalid S3 location `s3:///x`'],
      ['https://key:secret@photos', {}, 'Credentials in the S3 location'],
      ['s3://photos?endpoint=https://key:secret@host', {}, 'Credentials in the S3 endpoint'],
      ['s3://photos', { endpoint: 'https://key:secret@host' }, 'Credentials in the S3 endpoint'],
      ['s3://key:secret@bu cket', {}, 'Invalid S3 location `s3://bu cket`'],
    ];
    for (const [url, defaults, title] of cases) {
      throws(
        () => parseS3Location(url, defaults),
        (error) =>
          isOhneError(error) &&
          error.title === title &&
          !JSON.stringify({ ...error, message: error.message }).includes('secret'),
      );
    }
  });

  it('refuses an invalid bucket name', () => {
    refuses('s3://Photos', 'Invalid bucket name `Photos`');
    refuses('s3://ab', 'Invalid bucket name `ab`');
    refuses('s3://-photos', 'Invalid bucket name `-photos`');
  });

  it('refuses an unknown option and suggests the closest', () => {
    throws(
      () => parseS3Location('s3://photos?regoin=eu'),
      (error) =>
        isOhneError(error) &&
        error.title === 'Unknown S3 option `regoin`' &&
        String(error.body).includes('Did you mean `region`?'),
    );
  });

  it('refuses a boolean option that is not a boolean', () => {
    refuses('s3://photos?tagging=off', 'Invalid S3 option `tagging=off`');
    refuses('s3://photos?pathStyle=', 'Invalid S3 option `pathStyle=`');
  });

  it('refuses an endpoint that is not an http origin', () => {
    refuses('s3://photos?endpoint=ftp://host', 'Invalid S3 endpoint `ftp://host`');
    refuses('s3://photos?endpoint=https://host/path', 'Invalid S3 endpoint `https://host/path`');
    refuses('s3://photos?endpoint=host', 'Invalid S3 endpoint `host`');
  });

  it('refuses a part size outside 5mb to 5gb', () => {
    refuses('s3://photos?partSize=4mb', 'Invalid S3 part size `4mb`');
    refuses('s3://photos?partSize=6gb', 'Invalid S3 part size `6gb`');
    refuses('s3://photos?partSize=big', 'Invalid S3 part size `big`');
    strictEqual(parseS3Location('s3://photos?partSize=5mb').partSize, 5 * MIB);
  });

  it('refuses a dot segment in the prefix, encoded or not', () => {
    refuses('s3://photos/a/../b', 'Invalid S3 prefix `a/../b`');
    refuses('s3://photos/./b', 'Invalid S3 prefix `./b`');
    refuses('s3://photos/a/%2E%2E', 'Invalid S3 prefix `a/%2E%2E`');
    refuses('s3://photos/a%2F..', 'Invalid S3 prefix `a%2F..`');
  });
});
