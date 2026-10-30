import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { RetiredPrivateSessions, type RetiredSessionOwner } from '../main/services/retired-private-sessions';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness } from './harness';

const h = new Harness();
const missing = { kind: 'server', code: -32004, message: 'The thread does not exist' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
class Client extends EventEmitter {
  closed = false;
  threads = new Set<string>();
  calls: Array<{ method: string; params: JsonObject }> = [];
  closeError?: unknown;
  deleteError?: unknown;
  readError?: unknown;
  closeGate?: Promise<void>;
  closeEntered?: () => void;
  deleteLostAck = false;
  deleteReply?: JsonObject;
  isClosed() { return this.closed; }
  async requestWithTimeout(method: string, payload: Json): Promise<unknown> {
    const params = object(payload);
    this.calls.push({ method, params });
    if (method === 'session/close') {
      this.closeEntered?.();
      await this.closeGate;
      if (this.closeError) throw this.closeError;
      return {};
    }
    if (method === 'session/deleteSession') {
      if (this.deleteError) throw this.deleteError;
      const threadId = String(params.threadId);
      const deleted = this.threads.delete(threadId);
      if (this.deleteLostAck) throw new Error('Deletion acknowledgement was lost');
      return { deleted: this.deleteReply ?? { threadId, deleted } };
    }
    if (method === 'engine/readThread') {
      if (this.readError) throw this.readError;
      if (!this.threads.has(String(params.threadId))) throw missing;
      return { thread: { id: params.threadId } };
    }
    throw new Error('Retired recovery attempted an unexpected operation: ' + method);
  }
}
async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.retired-private-'));
  const client = new Client();
  let owner: RetiredSessionOwner | undefined = { client, generation: 1 };
  const deps = { configRoot: root, engine: () => owner };
  const directory = join(root, 'sandbox-diagnostics');
  const marker = (id: string) => join(directory, id + '.json');
  const record = async (id = randomUUID(), extra: JsonObject = {}) => {
    await mkdir(join(directory, id), { recursive: true });
    await writeFile(marker(id), JSON.stringify({ schemaVersion: 1, kind: 'sandbox-diagnostics', threadId: id, ...extra }));
    client.threads.add(id);
    return id;
  };
  return { root, directory, client, deps, marker, record, setOwner(value: RetiredSessionOwner | undefined) { owner = value; },
    async clean() { await rm(root, { recursive: true, force: true }); } };
}

void (async () => {
  await h.test('no retired records means no directory, engine request, or new private conversation', async () => {
    const f = await fixture();
    try {
      f.setOwner(undefined);
      const service = new RetiredPrivateSessions(f.deps);
      await service.recover();
      assert.equal(service.isPrivateThread(randomUUID()), false);
      assert.equal(existsSync(f.directory), false);
      assert.deepEqual(f.client.calls, []);
    } finally { await f.clean(); }
  });
  await h.test('only a validated owned record is recovered and ordinary history is untouched', async () => {
    const f = await fixture();
    try {
      const owned = await f.record(), ordinary = randomUUID();
      f.client.threads.add(ordinary);
      await mkdir(join(f.directory, ordinary));
      await writeFile(join(f.directory, 'other-record.json'), 'unrelated');
      const service = new RetiredPrivateSessions(f.deps);
      assert.equal(service.isPrivateThread(owned), true);
      assert.equal(service.isPrivateThread(ordinary), false);
      await service.recover();
      assert.deepEqual(f.client.calls, [
        { method: 'session/close', params: { sessionId: owned } },
        { method: 'session/deleteSession', params: { threadId: owned } },
      ]);
      assert.equal(service.isPrivateThread(owned), false);
      assert.deepEqual([...f.client.threads], [ordinary]);
      assert.deepEqual((await readdir(f.directory)).sort(), [ordinary, 'other-record.json'].sort());
    } finally { await f.clean(); }
  });
  await h.test('a lost deletion acknowledgement requires typed absence before removing the record', async () => {
    const f = await fixture();
    try {
      const id = await f.record();
      f.client.deleteLostAck = true;
      const service = new RetiredPrivateSessions(f.deps);
      await service.recover();
      assert.deepEqual(f.client.calls.map(row => row.method), ['session/close', 'session/deleteSession', 'engine/readThread']);
      assert.equal(service.isPrivateThread(id), false);
      assert.equal(existsSync(f.marker(id)), false);
      assert.equal(f.client.listenerCount('event'), 0);
    } finally { await f.clean(); }
  });
  await h.test('an already absent owned conversation removes only its remaining private record', async () => {
    const f = await fixture();
    try {
      const id = await f.record();
      f.client.threads.delete(id);
      f.client.closeError = missing;
      const service = new RetiredPrivateSessions(f.deps);
      await service.recover();
      assert.equal(service.isPrivateThread(id), false);
      assert.deepEqual(await readdir(f.directory), []);
    } finally { await f.clean(); }
  });
  await h.test('I/O errors and textual not-found messages never establish safe deletion', async () => {
    const f = await fixture();
    try {
      const id = await f.record();
      const original = await readFile(f.marker(id), 'utf8');
      f.client.deleteError = new Error('The storage writer is unavailable');
      for (const error of [{ kind: 'io', message: 'not found' }, new Error('Unknown thread'), { kind: 'server', code: -32001 }]) {
        f.client.readError = error;
        const service = new RetiredPrivateSessions(f.deps);
        await assert.rejects(service.recover(), /storage writer/);
        assert.equal(service.isPrivateThread(id), true);
        assert.equal(await readFile(f.marker(id), 'utf8'), original);
        assert.equal(existsSync(join(f.directory, id)), true);
      }
    } finally { await f.clean(); }
  });
  await h.test('close failure leaves the private record retryable and sends no delete request', async () => {
    const f = await fixture();
    try {
      const id = await f.record(), service = new RetiredPrivateSessions(f.deps);
      f.client.closeError = new Error('Private process cleanup failed');
      await assert.rejects(service.recover(), /cleanup failed/);
      assert.equal(service.isPrivateThread(id), true);
      assert.deepEqual(f.client.calls.map(row => row.method), ['session/close']);
      f.client.closeError = undefined;
      await service.recover();
      assert.equal(service.isPrivateThread(id), false);
    } finally { await f.clean(); }
  });
  await h.test('unconfirmed permission cleanup stays private without modifying or deleting its record', async () => {
    const f = await fixture();
    try {
      const id = await f.record(undefined, { cleanupUnconfirmed: true });
      const original = await readFile(f.marker(id), 'utf8');
      const service = new RetiredPrivateSessions(f.deps);
      assert.equal(service.isPrivateThread(id), true);
      await assert.rejects(service.recover(), /unconfirmed permission cleanup/);
      assert.equal(await readFile(f.marker(id), 'utf8'), original);
      assert.deepEqual(f.client.calls, []);
    } finally { await f.clean(); }
  });
  await h.test('malformed, oversized and foreign ownership records remain hidden without engine deletion', async () => {
    for (const content of ['{', JSON.stringify({ schemaVersion: 1, kind: 'other', threadId: randomUUID() }),
      JSON.stringify({ schemaVersion: 1, kind: 'sandbox-diagnostics', threadId: randomUUID() }), ' '.repeat(1025)]) {
      const f = await fixture();
      try {
        const id = await f.record();
        await writeFile(f.marker(id), content);
        const service = new RetiredPrivateSessions(f.deps);
        assert.equal(service.isPrivateThread(id), true);
        await assert.rejects(service.recover());
        assert.deepEqual(f.client.calls, []);
        assert.equal(await readFile(f.marker(id), 'utf8'), content);
      } finally { await f.clean(); }
    }
  });
  await h.test('symbolic-link markers cannot authorize deletion of a conversation or external content', async () => {
    const f = await fixture();
    try {
      const id = await f.record(), external = join(f.root, 'external.json');
      const original = await readFile(f.marker(id), 'utf8');
      await writeFile(external, original);
      await rm(f.marker(id));
      await symlink(external, f.marker(id));
      const service = new RetiredPrivateSessions(f.deps);
      assert.equal(service.isPrivateThread(id), true);
      await assert.rejects(service.recover(), /ownership marker/);
      assert.equal(await readFile(external, 'utf8'), original);
      assert.deepEqual(f.client.calls, []);
    } finally { await f.clean(); }
  });
  await h.test('a symbolic-link journal is rejected before private record discovery', async () => {
    const f = await fixture();
    try {
      const external = join(f.root, 'external');
      await mkdir(external);
      await symlink(external, f.directory);
      assert.throws(() => new RetiredPrivateSessions(f.deps), /real directory/);
      assert.deepEqual(f.client.calls, []);
    } finally { await f.clean(); }
  });
  await h.test('an ownership change while close is pending prevents persistent deletion', async () => {
    const f = await fixture();
    try {
      const id = await f.record(), entered = deferred(), gate = deferred();
      f.client.closeGate = gate.promise; f.client.closeEntered = entered.resolve;
      const service = new RetiredPrivateSessions(f.deps), pending = service.recover();
      await entered.promise;
      await writeFile(f.marker(id), JSON.stringify({ schemaVersion: 1, kind: 'not-owned', threadId: id }));
      gate.resolve();
      await assert.rejects(pending, /ownership marker/);
      assert.equal(service.isPrivateThread(id), true);
      assert.deepEqual(f.client.calls.map(row => row.method), ['session/close']);
    } finally { await f.clean(); }
  });
  await h.test('endpoint generation changes fence recovery without contacting a replacement engine', async () => {
    const f = await fixture();
    try {
      const id = await f.record(), entered = deferred(), gate = deferred(), next = new Client();
      f.client.closeGate = gate.promise; f.client.closeEntered = entered.resolve;
      const service = new RetiredPrivateSessions(f.deps), pending = service.recover();
      await entered.promise;
      f.setOwner({ client: next, generation: 2 }); gate.resolve();
      await assert.rejects(pending, /engine changed/);
      assert.equal(service.isPrivateThread(id), true);
      assert.deepEqual(next.calls, []);
      assert.deepEqual(f.client.calls.map(row => row.method), ['session/close']);
    } finally { await f.clean(); }
  });
  await h.test('parallel recovery calls serialize the same owned record once', async () => {
    const f = await fixture();
    try {
      const id = await f.record(), service = new RetiredPrivateSessions(f.deps);
      await Promise.all([service.recover(), service.recover()]);
      assert.deepEqual(f.client.calls.map(row => row.method), ['session/close', 'session/deleteSession']);
      assert.equal(service.isPrivateThread(id), false);
    } finally { await f.clean(); }
  });
  process.exitCode = await h.finish(join(__dirname, 'retired-private-sessions-result.json'), 'retired-private-sessions');
})();
