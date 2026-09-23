import type { S3Credentials } from '../src/credentials.ts';

const encoder = new TextEncoder();

/**
 * The key pair the fake S3 verifies every signature with.
 */
export const TEST_CREDENTIALS: S3Credentials = {
  accessKeyId: 'test',
  secretAccessKey: 'test-secret',
};

/**
 * A mebibyte, the unit part sizes are counted in.
 */
export const MIB = 1024 ** 2;

/**
 * A stream of `chunks`, each encoded as UTF-8.
 */
export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return ReadableStream.from(chunks.map((chunk) => encoder.encode(chunk)));
}

/**
 * A stream of `bytes` in chunks of `chunk` bytes.
 */
export function bytesStream(bytes: Uint8Array, chunk = 256 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

/**
 * A stream that sends `bytes` and then fails with `stream broke`.
 */
export function failingStream(
  bytes: Uint8Array = encoder.encode('partial'),
): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.error(new Error('stream broke'));
      controller.enqueue(bytes);
      sent = true;
    },
  });
}

/**
 * The whole of `body`, decoded as UTF-8.
 */
export function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

/**
 * The whole of `body` as bytes.
 */
export async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * `size` bytes of a fixed pattern, so parts differ from each other and a mix-up shows.
 */
export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + (index >> 12)) % 251;
  return bytes;
}
