import { useEnv } from 'ohnejs';

declare module 'ohnejs' {
  interface Env {
    /**
     * The access key id every request to the bucket is signed with.
     *
     * @default
     * undefined
     */
    AWS_ACCESS_KEY_ID: string | undefined;

    /**
     * The secret of `AWS_ACCESS_KEY_ID`.
     * Never put it in `uploads.url`.
     *
     * @default
     * undefined
     */
    AWS_SECRET_ACCESS_KEY: string | undefined;

    /**
     * A session token, for temporary credentials.
     *
     * @default
     * undefined
     */
    AWS_SESSION_TOKEN: string | undefined;

    /**
     * The bucket's region when `uploads.url` names none.
     *
     * @default
     * undefined
     */
    AWS_REGION: string | undefined;

    /**
     * The S3 endpoint origin when `uploads.url` names none.
     * It wins over `AWS_ENDPOINT_URL`.
     *
     * @default
     * undefined
     */
    AWS_ENDPOINT_URL_S3: string | undefined;

    /**
     * The endpoint origin for every AWS service, used when `AWS_ENDPOINT_URL_S3` is unset.
     *
     * @default
     * undefined
     */
    AWS_ENDPOINT_URL: string | undefined;
  }
}

useEnv().define('AWS_ACCESS_KEY_ID', { default: undefined });
useEnv().define('AWS_SECRET_ACCESS_KEY', { default: undefined });
useEnv().define('AWS_SESSION_TOKEN', { default: undefined });
useEnv().define('AWS_REGION', { default: undefined });
useEnv().define('AWS_ENDPOINT_URL_S3', { default: undefined });
useEnv().define('AWS_ENDPOINT_URL', { default: undefined });
