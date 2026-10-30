import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { encodedSocketFrame, ReliableDelivery, ReliableDeliveryStore } from '../main/services/mobile/transport';
import { object } from '../main/services/service-types';
import { CLIENT_CURSOR_TTL_MS, MAX_RELIABLE_BYTES, MAX_RELIABLE_CLIENTS, MAX_RELIABLE_MESSAGES, RELIABLE_TTL_MS } from '../main/services/mobile/transport-storage';
import { Harness, sleep } from './harness';

const h = new Harness();
const vector = object(JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-transport-storage-vectors.json'), 'utf8')));
const stores = new Set<ReliableDeliveryStore>(), roots: string[] = [];
async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-journal-' + name + '-')); roots.push(root);
  const path = join(root, 'transport-v1.json'), store = new ReliableDeliveryStore(path); stores.add(store);
  await store.ready(); return { root, path, store };
}
async function reopen(path: string) {
  const store = new ReliableDeliveryStore(path); stores.add(store); await store.ready(); return store;
}

h.test('incremental persistence keeps the committed replay and mutation-receipt retention limits', () => {
  assert.equal(MAX_RELIABLE_MESSAGES, object(vector.replay).maxMessagesPerClient);
  assert.equal(MAX_RELIABLE_BYTES, object(vector.replay).maxBytesPerClient);
  assert.equal(MAX_RELIABLE_CLIENTS, object(vector.replay).maxClients);
  assert.equal(RELIABLE_TTL_MS, object(vector.replay).ttlMs);
  assert.equal(CLIENT_CURSOR_TTL_MS, object(vector.receipt).ttlMs);
});

h.test('reliable frames are immutable and their encoding is reused without touching the source payload', () => {
  const delivery = new ReliableDelivery(), source = { type: 'fixture', nested: { text: 'original' } };
  const [frame] = delivery.enqueue(source);
  assert(frame); const encoded = encodedSocketFrame(frame);
  source.nested.text = 'edited';
  assert.equal(object(object(frame.message).nested).text, 'original');
  assert.equal(encodedSocketFrame(frame), encoded, 'live and replay writers use the same cached string and byte count');
  assert.throws(() => { object(object(frame.message).nested).text = 'cannot mutate'; });
  assert.equal(encodedSocketFrame(delivery.replay(0).frames[0]!), encoded);
  const direct = encodedSocketFrame(source); source.nested.text = 'still editable';
  assert.notEqual(encodedSocketFrame(source).text, direct.text, 'uncached caller-owned objects stay mutable');
});

h.test('replay storage appends new messages only and ACK-only revisions carry no old payload bytes', async () => {
  const { path, store } = await fixture('incremental'), delivery = store.get('phone');
  const first = delivery.enqueue({ type: 'history', text: 'x'.repeat(3 * 1024 * 1024) });
  const second = delivery.enqueue({ type: 'after', value: 2 });
  await store.flush();
  const before = store.stats(); assert.equal(before.appendedMessages, 2); assert(before.appendedBytes > 3 * 1024 * 1024);
  delivery.acknowledge(1); await store.flush();
  assert.equal(store.stats().appendedBytes, before.appendedBytes, 'an ACK does not clone or rewrite the retained history');
  assert.equal(store.stats().appendedMessages, 2);
  delivery.enqueue({ type: 'small', value: 3 }); await store.flush();
  assert.equal(store.stats().appendedMessages, 3, 'only the new logical message is appended');
  await store.close();
  const restored = (await reopen(path)).get('phone');
  assert.equal(restored.replay(0).stale, true);
  assert.deepEqual(restored.replay(1).frames.slice(0, second.length), second);
  assert(restored.replay(1).frames.every(frame => !first.includes(frame)));
});

h.test('a mutation cursor is flushed synchronously before its ACK independently of the asynchronous replay journal', async () => {
  const { path, store } = await fixture('cursor'), delivery = store.get('phone');
  delivery.enqueue({ type: 'large_result', body: 'y'.repeat(4 * 1024 * 1024) });
  delivery.commitClient(1);
  const cursors = object(JSON.parse(readFileSync(path + '.client-cursors', 'utf8')));
  assert.equal(object(object(cursors.clients).phone).lastClientSeq, 1, 'the next statement after commit can read the durable receipt');
  assert.equal(store.stats().appendedMessages, 0, 'inbound receipt durability never serializes the replay payload');
  await store.close();
  const restored = (await reopen(path)).get('phone');
  assert.equal(restored.acceptClient(1), 'duplicate'); assert.equal(restored.acceptClient(2), 'accept');
});

h.test('changes made during an in-flight asynchronous write are included before flush and close finish', async () => {
  const { path, store } = await fixture('generation'), delivery = store.get('phone');
  delivery.enqueue({ type: 'first', body: 'z'.repeat(4 * 1024 * 1024) });
  const writing = store.flush(); await Promise.resolve();
  const latest = delivery.enqueue({ type: 'latest', value: 9 }); delivery.commitClient(1);
  delivery.acknowledge(1);
  await writing;
  const closing = store.close(); assert.equal(store.close(), closing, 'shutdown shares its durable drain'); await closing;
  const restored = (await reopen(path)).get('phone');
  assert.deepEqual(restored.replay(1).frames, latest);
  assert.equal(restored.committedClientSeq(), 1);
});

h.test('v1 replay journals migrate off-main and keep newer independent inbound cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-journal-legacy-')); roots.push(root);
  const path = join(root, 'transport-v1.json'), delivery = new ReliableDelivery();
  const frames = delivery.enqueue({ type: 'legacy', body: 'h'.repeat(1024 * 1024) });
  delivery.commitClient(1);
  await writeFile(path, JSON.stringify({ version: 1, clients: { phone: { touchedAt: Date.now(), state: delivery.snapshot() } } }));
  await writeFile(path + '.client-cursors', JSON.stringify({ version: 1, clients: { phone: { touchedAt: Date.now(), lastClientSeq: 2 } } }));
  const store = new ReliableDeliveryStore(path); stores.add(store);
  assert.throws(() => store.get('phone'), /still restoring/);
  let heartbeats = 0; const timer = setInterval(() => { heartbeats++; }, 1);
  try { await store.ready(); } finally { clearInterval(timer); }
  assert(heartbeats > 0, 'worker restore leaves the event loop free for heartbeat work');
  assert.deepEqual(store.get('phone').replay(0).frames, frames);
  assert.equal(store.get('phone').committedClientSeq(), 2);
  await store.close();
  // Once the incremental journal owns the state, a stale legacy file cannot resurrect ACKed messages.
  const second = await reopen(path); second.get('phone').acknowledge(1); await second.close();
  assert.deepEqual((await reopen(path)).get('phone').replay(1).frames, []);
});

h.test('missing replay storage still restores the independent 30-day inbound receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-journal-cursor-only-')); roots.push(root);
  const path = join(root, 'transport-v1.json');
  await writeFile(path + '.client-cursors', JSON.stringify({ version: 1, clients: {
    phone: { touchedAt: Date.now() - 10 * 60_000, lastClientSeq: 17 },
  } }));
  const delivery = (await reopen(path)).get('phone');
  assert.equal(delivery.acceptClient(17), 'duplicate'); assert.equal(delivery.acceptClient(18), 'accept');
});

h.test('an abrupt host exit after cursor commit cannot replay an already accepted inbound mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-journal-crash-')); roots.push(root);
  const path = join(root, 'transport-v1.json');
  const program = `const {ReliableDeliveryStore}=require(process.argv[1]);
    (async()=>{const store=new ReliableDeliveryStore(process.argv[2]);await store.ready();
      const delivery=store.get('phone');delivery.enqueue({type:'pending_result',body:'x'.repeat(1024*1024)});
      delivery.commitClient(1);process.exit(0);
    })().catch(error=>{process.stderr.write(String(error));process.exit(1);});`;
  const outcome = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program, join(__dirname, '../main/services/mobile/transport.js'), path], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000,
    });
    let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stderr }));
  });
  assert.equal(outcome.code, 0, outcome.stderr);
  const delivery = (await reopen(path)).get('phone');
  assert.equal(delivery.acceptClient(1), 'duplicate'); assert.equal(delivery.acceptClient(2), 'accept');
  assert.equal(delivery.replay(1).stale, true, 'the lost asynchronous result is an explicit replay reset, not a repeated mutation');
});

h.test('an expired replay payload cannot erase the durable client action cursor during migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-journal-expired-')); roots.push(root);
  const path = join(root, 'transport-v1.json'), delivery = new ReliableDelivery();
  delivery.enqueue({ type: 'old' }); delivery.commitClient(1);
  const state = delivery.snapshot(), touchedAt = Date.now() - 10 * 60_000; state.messages[0]!.createdAt = touchedAt;
  await writeFile(path, JSON.stringify({ version: 1, clients: { phone: { touchedAt, state } } }));
  const restored = (await reopen(path)).get('phone');
  assert.equal(restored.replay(0).stale, true); assert.equal(restored.acceptClient(1), 'duplicate');
});

h.test('failed incremental persistence rejects drain and does not enter a timer retry loop', async () => {
  const { path, store } = await fixture('failure');
  const db = new DatabaseSync(path + '.sqlite'); db.exec('DROP TABLE messages'); db.close();
  const delivery = store.get('phone'); delivery.enqueue({ type: 'failed' });
  await assert.rejects(store.flush(), /messages/);
  const failedWrites = store.stats().writes;
  for (let index = 0; index < 10; index++) delivery.enqueue({ type: 'later', index });
  await sleep(60);
  assert.equal(store.stats().writes, failedWrites, 'new events do not hot-loop a failed storage worker');
  await assert.rejects(store.close(), /messages/);
});

h.test('startup errors are observable and shutdown reaps the failed restore worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-journal-start-failure-')); roots.push(root);
  await writeFile(join(root, 'blocked'), 'not a directory');
  const store = new ReliableDeliveryStore(join(root, 'blocked', 'state.json')); stores.add(store);
  await assert.rejects(store.ready()); await assert.rejects(store.close());
});

h.test('the shipped Electron runtime starts the persistence worker from an ASAR package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-mobile-journal-asar-')); roots.push(root);
  const source = join(root, 'app'), archive = join(root, 'app.asar');
  const modules = ['services/mobile/transport-store-worker.js', 'services/mobile/transport-storage.js', 'services/service-types.js', 'ipc/registry.js'];
  for (const module of modules) {
    const target = join(source, module); await mkdir(join(target, '..'), { recursive: true });
    await copyFile(join(__dirname, '../main', module), target);
  }
  await (await import('@electron/asar')).createPackage(source, archive);
  const worker = new Worker(join(archive, modules[0]!), { workerData: { path: join(root, 'transport-v1.json') } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged worker startup timed out')), 10_000);
      worker.on('error', error => { clearTimeout(timer); reject(error); });
      worker.on('message', (reply: { type: string; message?: string }) => {
        if (reply.type === 'ready') worker.postMessage({ id: 1, type: 'close' });
        else if (reply.type === 'done') { clearTimeout(timer); resolve(); }
        else if (reply.type === 'error') { clearTimeout(timer); reject(new Error(reply.message)); }
      });
    });
  } finally { await worker.terminate(); await unlink(archive); }
});

h.test('the replay database and independent cursor retain owner-only file permissions', async () => {
  const { path, store } = await fixture('permissions');
  store.get('phone').commitClient(1); await store.close();
  const { stat } = await import('node:fs/promises');
  if (process.platform !== 'win32') {
    assert.equal((await stat(path + '.sqlite')).mode & 0o777, 0o600);
    assert.equal((await stat(path + '.client-cursors')).mode & 0o777, 0o600);
  }
  assert.equal(object(JSON.parse(await readFile(path + '.client-cursors', 'utf8'))).version, 1);
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'mobile-transport-result.json'), 'mobile-transport');
  await Promise.allSettled([...stores].map(store => store.close()));
  for (const root of roots) await rm(root, { recursive: true, force: true });
  process.exit(failed);
})();
