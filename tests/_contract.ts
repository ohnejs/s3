import type { StorageAdapter, StorageParts } from 'ohnejs/uploads';

import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { afterEach, beforeEach, it } from 'node:test';

import { MIN_PART_SIZE } from '../src/multipart.ts';
import { bytesOf, failingStream, randomBytes, streamOf, text } from './_fixtures.ts';

/**
 * A storage under test, with a way to read an object's visibility behind its back.
 */
export interface ContractSubject {
  storage: StorageAdapter;
  isPrivate(path: string): Promise<boolean>;
  close(): Promise<void>;
}

const type = { type: 'text/plain' };

const VIDEO = 'videos/durotar.mp4';

/**
 * The storage contract every S3 backend meets, registered as tests in the calling suite.
 * `setup` runs before each test and must hand out an empty storage.
 */
export function storageContract(setup: () => Promise<ContractSubject>): void {
  let subject: ContractSubject;
  let storage: StorageAdapter;

  beforeEach(async () => {
    subject = await setup();
    storage = subject.storage;
  });

  afterEach(() => subject.close());

  async function read(path: string): Promise<string | null> {
    const object = await storage.read(path);
    return object && text(object.body);
  }

  /**
   * The whole object at `path` as bytes, or `null` when there is none.
   */
  async function readBytes(path: string): Promise<Uint8Array | null> {
    const object = await storage.read(path);
    return object && bytesOf(object.body);
  }

  /**
   * The storage's part-wise writes, which every S3 backend has.
   */
  function parts(): StorageParts {
    ok(storage.parts, 'the storage has no parts');
    return storage.parts;
  }

  /**
   * Opens a part-wise write of `bytes` to `VIDEO` and resolves its handle.
   */
  function begin(bytes: Uint8Array): Promise<string> {
    return parts().begin(VIDEO, { type: 'video/mp4', size: bytes.length });
  }

  /**
   * Stores `bytes` as the parts of the write `handle` names, `size` bytes each, and resolves their receipts.
   */
  async function writeParts(
    handle: string,
    bytes: Uint8Array,
    size = MIN_PART_SIZE,
  ): Promise<string[]> {
    const receipts: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += size) {
      const part = {
        number: receipts.length + 1,
        offset,
        bytes: bytes.subarray(offset, offset + size),
      };
      receipts.push(await parts().write(VIDEO, handle, part));
    }
    return receipts;
  }

  it('writes an object and reads it back whole', async () => {
    await storage.write('photos/2024/sunset.jpg', streamOf('hello world'), { type: 'image/jpeg' });

    const object = await storage.read('photos/2024/sunset.jpg');
    ok(object);
    strictEqual(object.size, 11);
    strictEqual(await text(object.body), 'hello world');
  });

  it('writes a chunked body as one object', async () => {
    await storage.write('chunked.txt', streamOf('hel', 'lo ', 'world'), type);

    strictEqual(await read('chunked.txt'), 'hello world');
  });

  it('writes and reads an empty object', async () => {
    await storage.write('empty.txt', streamOf(), type);

    const object = await storage.read('empty.txt');
    ok(object);
    strictEqual(object.size, 0);
    strictEqual(await text(object.body), '');
  });

  it('reads a range from a start offset to the end', async () => {
    await storage.write('range.txt', streamOf('hello world'), type);

    const object = await storage.read('range.txt', { start: 6 });
    ok(object);
    strictEqual(await text(object.body), 'world');
    strictEqual(object.size, 11);
  });

  it('reads a range with an inclusive end', async () => {
    await storage.write('range.txt', streamOf('hello world'), type);

    const object = await storage.read('range.txt', { start: 0, end: 4 });
    ok(object);
    strictEqual(await text(object.body), 'hello');
    strictEqual(object.size, 11);
  });

  it('resolves null for a missing object or a folder', async () => {
    await storage.write('photos/a.jpg', streamOf('a'), type);

    strictEqual(await storage.read('photos/missing.jpg'), null);
    strictEqual(await storage.read('photos'), null);
    strictEqual(await storage.stat('photos/missing.jpg'), null);
    strictEqual(await storage.stat('photos'), null);
  });

  it('stats an object', async () => {
    await storage.write('photos/a.jpg', streamOf('hello world'), type);

    deepStrictEqual(await storage.stat('photos/a.jpg'), { size: 11 });
  });

  it('overwrites an object in place', async () => {
    await storage.write('photos/a.jpg', streamOf('first'), type);
    await storage.write('photos/a.jpg', streamOf('second'), type);

    strictEqual(await read('photos/a.jpg'), 'second');
    deepStrictEqual(await storage.stat('photos/a.jpg'), { size: 6 });
  });

  it('keeps the previous object when a write fails', async () => {
    await storage.write('photos/a.jpg', streamOf('first'), type);

    await rejects(storage.write('photos/a.jpg', failingStream(), type), /stream broke/);
    strictEqual(await read('photos/a.jpg'), 'first');
  });

  it('leaves nothing behind when the first write of an object fails', async () => {
    await rejects(storage.write('photos/a.jpg', failingStream(), type), /stream broke/);

    strictEqual(await storage.stat('photos/a.jpg'), null);
  });

  it('moves an object', async () => {
    await storage.write('a.txt', streamOf('moved'), type);

    await storage.move('a.txt', 'deep/nested/a.txt');

    strictEqual(await storage.stat('a.txt'), null);
    strictEqual(await read('deep/nested/a.txt'), 'moved');
  });

  it('moves an object over an existing one, replacing it', async () => {
    await storage.write('a.txt', streamOf('new'), type);
    await storage.write('b.txt', streamOf('old'), type);

    await storage.move('a.txt', 'b.txt');

    strictEqual(await storage.stat('a.txt'), null);
    strictEqual(await read('b.txt'), 'new');
  });

  it('moves a prefix with everything beneath it', async () => {
    await storage.write('photos/2024/a.jpg', streamOf('a'), type);
    await storage.write('photos/2024/b.jpg', streamOf('b'), type);

    await storage.move('photos/2024', 'archive/2024');

    strictEqual(await read('archive/2024/a.jpg'), 'a');
    strictEqual(await read('archive/2024/b.jpg'), 'b');
    strictEqual(await storage.stat('photos/2024/a.jpg'), null);
    strictEqual(await storage.stat('photos/2024/b.jpg'), null);
  });

  it('treats a move of a missing source as a no-op', async () => {
    await storage.move('ghost.txt', 'deep/ghost.txt');

    strictEqual(await storage.stat('deep/ghost.txt'), null);
  });

  it('deletes an object', async () => {
    await storage.write('photos/sunset.jpg', streamOf('x'), type);

    await storage.delete('photos/sunset.jpg');

    strictEqual(await storage.stat('photos/sunset.jpg'), null);
  });

  it('deletes a prefix with everything beneath it', async () => {
    await storage.write('photos/2024/a.jpg', streamOf('a'), type);
    await storage.write('photos/b.jpg', streamOf('b'), type);

    await storage.delete('photos');

    strictEqual(await storage.stat('photos/2024/a.jpg'), null);
    strictEqual(await storage.stat('photos/b.jpg'), null);
  });

  it('treats a delete of a missing path as a no-op', async () => {
    await storage.delete('nothing/here.txt');
  });

  it('lists every object, the object at a prefix, or every object under it', async () => {
    await storage.write('photos/2024/a.jpg', streamOf('a'), type);
    await storage.write('photos/b.jpg', streamOf('b'), type);
    await storage.write('photos2/c.jpg', streamOf('c'), type);

    deepStrictEqual((await Array.fromAsync(storage.list!())).sort(), [
      'photos/2024/a.jpg',
      'photos/b.jpg',
      'photos2/c.jpg',
    ]);
    deepStrictEqual((await Array.fromAsync(storage.list!('photos'))).sort(), [
      'photos/2024/a.jpg',
      'photos/b.jpg',
    ]);
    deepStrictEqual(await Array.fromAsync(storage.list!('photos/b.jpg')), ['photos/b.jpg']);
    deepStrictEqual(await Array.fromAsync(storage.list!('missing')), []);
  });

  it('never touches a sibling whose name shares the prefix', async () => {
    await storage.write('photos/a.jpg', streamOf('a'), type);
    await storage.write('photos2/b.jpg', streamOf('b'), type);

    await storage.setPrivate?.('photos', true);
    await storage.move('photos', 'archive');
    await storage.delete('archive');

    strictEqual(await read('photos2/b.jpg'), 'b');
    strictEqual(await subject.isPrivate('photos2/b.jpg'), false);
    strictEqual(await storage.stat('archive/a.jpg'), null);
  });

  it('locks and unlocks one object', async (t) => {
    if (!storage.setPrivate) return t.skip('the storage has no setPrivate');
    await storage.write('photos/a.jpg', streamOf('a'), type);
    await storage.write('photos/b.jpg', streamOf('b'), type);

    await storage.setPrivate('photos/a.jpg', true);
    deepStrictEqual(
      [await subject.isPrivate('photos/a.jpg'), await subject.isPrivate('photos/b.jpg')],
      [true, false],
    );
    await storage.setPrivate('photos/a.jpg', false);
    strictEqual(await subject.isPrivate('photos/a.jpg'), false);
  });

  it('locks a prefix, and the lock moves with it', async (t) => {
    if (!storage.setPrivate) return t.skip('the storage has no setPrivate');
    await storage.write('photos/a.jpg', streamOf('a'), type);
    await storage.write('photos/2024/b.jpg', streamOf('b'), type);

    await storage.setPrivate('photos', true);
    await storage.move('photos', 'archive');

    strictEqual(await subject.isPrivate('archive/a.jpg'), true);
    strictEqual(await subject.isPrivate('archive/2024/b.jpg'), true);
  });

  it('treats a lock of a missing path as a no-op', async () => {
    await storage.setPrivate?.('ghost', true);
  });

  it('assembles parts written apart into one object, which appears only once complete', async () => {
    const bytes = randomBytes(MIN_PART_SIZE + 3);
    const handle = await begin(bytes);
    const receipts = await writeParts(handle, bytes);

    strictEqual(await storage.stat(VIDEO), null);
    deepStrictEqual(await Array.fromAsync(storage.list!()), []);
    await parts().complete(VIDEO, handle, receipts);

    deepStrictEqual(await storage.stat(VIDEO), { size: bytes.length });
    deepStrictEqual(await readBytes(VIDEO), bytes);
  });

  it('keeps the last copy of a part written twice', async () => {
    const bytes = randomBytes(MIN_PART_SIZE + 3);
    const handle = await begin(bytes);
    await writeParts(handle, new Uint8Array(bytes.length));
    const receipts = await writeParts(handle, bytes);

    await parts().complete(VIDEO, handle, receipts);

    deepStrictEqual(await readBytes(VIDEO), bytes);
  });

  it('resolves a complete replayed after it landed', async () => {
    const bytes = randomBytes(MIN_PART_SIZE + 3);
    const handle = await begin(bytes);
    const receipts = await writeParts(handle, bytes);

    await parts().complete(VIDEO, handle, receipts);
    await parts().complete(VIDEO, handle, receipts);

    deepStrictEqual(await readBytes(VIDEO), bytes);
  });

  it('drops the parts of an aborted write, and aborts again as a no-op', async () => {
    const bytes = randomBytes(MIN_PART_SIZE + 3);
    const handle = await begin(bytes);
    const receipts = await writeParts(handle, bytes);

    await parts().abort(VIDEO, handle);
    await parts().abort(VIDEO, handle);

    await rejects(parts().complete(VIDEO, handle, receipts), /NoSuchUpload/);
    strictEqual(await storage.stat(VIDEO), null);
  });

  it('treats an abort after complete as a no-op', async () => {
    const bytes = randomBytes(3);
    const handle = await begin(bytes);
    await parts().complete(VIDEO, handle, await writeParts(handle, bytes));

    await parts().abort(VIDEO, handle);

    deepStrictEqual(await readBytes(VIDEO), bytes);
  });

  it('refuses a part under the minimum that is not the last', async () => {
    const bytes = randomBytes(MIN_PART_SIZE);
    const handle = await begin(bytes);
    const receipts = await writeParts(handle, bytes, MIN_PART_SIZE - 1);

    await rejects(parts().complete(VIDEO, handle, receipts), /EntityTooSmall/);
    strictEqual(await storage.stat(VIDEO), null);
    await parts().abort(VIDEO, handle);
  });
}
