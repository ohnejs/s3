# @ohnejs/uploads-s3

Stores [ohne uploads](https://ohne.dev/docs/uploads/uploads) in an S3 bucket, or in any
S3-compatible service such as Cloudflare R2 or MinIO. It has no dependencies: it signs its requests
itself.

## Install

You need Node 26 or newer.

```sh
pnpm add @ohnejs/uploads-s3
```

## Connecting ohne

List the layer after `ohnejs/uploads`, select the `s3` storage, and point `url` at your bucket:

```ts
// ohne.config.ts
import { defineConfig } from 'ohnejs';

export default defineConfig({
  layers: ['ohnejs/base', 'ohnejs/uploads', '@ohnejs/uploads-s3'],
  uploads: {
    storage: 's3',
    url: 's3://my-bucket/uploads?region=eu-central-1',
  },
});
```

Each file lands under the prefix, so `photos/sunset.jpg` becomes the object
`uploads/photos/sunset.jpg`. To use another bucket per deploy, set `UPLOADS_URL`. It replaces
`url` whole.

## Credentials

The storage reads its keys from the environment, or from `.env`:

| variable                | meaning                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `AWS_ACCESS_KEY_ID`     | The access key id. Required.                                                  |
| `AWS_SECRET_ACCESS_KEY` | Its secret. Required.                                                         |
| `AWS_SESSION_TOKEN`     | A session token, for temporary credentials.                                   |
| `AWS_REGION`            | The region, when the location names none.                                     |
| `AWS_ENDPOINT_URL_S3`   | The endpoint, when the location names none.                                   |
| `AWS_ENDPOINT_URL`      | The endpoint for every AWS service, used when `AWS_ENDPOINT_URL_S3` is unset. |

A `region` or `endpoint` in the location wins over its variable. Never put a secret in the
location: ohne refuses one that names a user or password. Profiles, instance roles, and SSO are not
read, so pass the keys through the environment. In production, set them beside ohne's other
[secrets](https://ohne.dev/docs/production/deployment#secrets).

## The location

```
s3://<bucket>[/<prefix>][?<option>=<value>&...]
```

| option      | default                                                              | meaning                                                                        |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `region`    | `AWS_REGION`, else `us-east-1`                                       | The bucket's region.                                                           |
| `endpoint`  | `AWS_ENDPOINT_URL_S3`, else `https://s3.<region>.amazonaws.com`      | The service origin, `http` or `https`, with no path.                           |
| `pathStyle` | `true` with an endpoint or a bucket name holding a `.`, else `false` | Address the bucket as `<endpoint>/<bucket>` rather than `<bucket>.<endpoint>`. |
| `tagging`   | `true`                                                               | Tag private files. Set `false` for a service without object tagging.           |
| `partSize`  | `8mb`                                                                | The size of each part of a large upload, from `5mb` to `5gb`.                  |

A `cn-` region defaults to the `amazonaws.com.cn` domain.

## Bucket setup

Give the key these permissions on the bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::my-bucket" },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging",
        "s3:DeleteObjectTagging"
      ],
      "Resource": "arn:aws:s3:::my-bucket/*"
    }
  ]
}
```

`s3:ListBucket` lets a missing file read as missing. Without it, S3 answers `403` instead of `404`.

A large file is uploaded in parts. When a process dies mid-upload, its parts stay in the bucket,
invisible and billed. Add a lifecycle rule that aborts incomplete multipart uploads after one day.

## Private files

Keep the bucket private, as a new bucket is. ohne then serves every file through its API, which
checks who is asking. Each [private file](https://ohne.dev/docs/uploads/private-files) also
carries the tag `private=true`, so the bucket can refuse it if you ever serve from it directly.

### Serving public files from the bucket

To let visitors load public files straight from the bucket, set `uploads.publicURL` to the
bucket's origin, prefix included:

```ts
uploads: {
  storage: 's3',
  url: 's3://my-bucket/uploads?region=eu-central-1',
  publicURL: 'https://my-bucket.s3.eu-central-1.amazonaws.com/uploads',
},
```

Turn off `BlockPublicPolicy` and `RestrictPublicBuckets` in the bucket's Block Public Access
settings, then attach this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadUnlessPrivate",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::my-bucket/uploads/*",
      "Condition": { "StringNotEquals": { "s3:ExistingObjectTag/private": "true" } }
    }
  ]
}
```

An object without the tag is public. A private one is refused to anyone but your app's key, so it
opens only through ohne, with a signed link. Private files still need `UPLOADS_SECRET`.

### Behind a CDN

The policy above serves straight from the bucket. A CDN reads the bucket with its own identity,
such as CloudFront's origin access control, not as `"*"`. Put the same `Condition` on the statement
that grants the CDN `s3:GetObject`, and set `publicURL` to the CDN's origin.

Every object carries the `Cache-Control` of `uploads.cache`. With the default, the CDN revalidates
on every request, so a replaced or newly private file takes effect at once. With a longer cache, it
takes effect when that age runs out.

## S3-compatible services

| service       | `uploads.url`                                                                                           | notes                                       |
| ------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| AWS S3        | `s3://my-bucket?region=eu-central-1`                                                                    |                                             |
| Cloudflare R2 | `s3://my-bucket?endpoint=https://<account>.r2.cloudflarestorage.com&region=auto&tagging=false`          | No object tagging. Keep the bucket private. |
| MinIO         | `s3://my-bucket?endpoint=http://localhost:9000`                                                         |                                             |
| Hetzner       | `s3://my-bucket?endpoint=https://fsn1.your-objectstorage.com&region=fsn1`                               | If it refuses tagging, add `tagging=false`. |
| Backblaze B2  | `s3://my-bucket?endpoint=https://s3.eu-central-003.backblazeb2.com&region=eu-central-003&tagging=false` | No object tagging. Keep the bucket private. |

A service without object tagging takes `tagging=false`, and its bucket stays private: ohne has no
way to hide a private file there, so only the API may serve it.

## How it works

- A file up to `partSize` is written in one request. A larger one is a multipart upload that holds
  at most two parts in memory, up to `partSize` times 10,000 bytes per file.
- The file appears only when the upload completes, so a failed upload keeps the previous file.
- Each object carries the `Cache-Control` of `uploads.cache`.
- A move copies each object and then deletes it. When a move is cut off, ohne replays it and it
  finishes.
- A folder delete removes up to 1,000 objects per request.
- A failed request is retried with backoff when the failure is transient, such as a `503`.
- Files are read with ranged `GET`s, so seeking in a video reads only what it needs.

## Contributing

From a clone, run `pnpm install` and `pnpm test`. With `minio` on your `PATH`,
`pnpm test:minio` also runs the suite against a real MinIO server.
