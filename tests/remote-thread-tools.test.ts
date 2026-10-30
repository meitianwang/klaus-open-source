import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import type { DelegationDeliveryRequest, DelegationDeliveryResult } from '../main/sessions/service';
import { parseDelegationEnvelope } from '../contracts/thread-delegation';
import type { RemoteThreadOperation } from '../main/services/remote-thread-client';
import { object, type JsonObject } from '../main/services/service-types';
import { ThreadToolsService, type ThreadToolContext, type ThreadToolsDeps } from '../main/services/thread-tools';
import { Harness, waitFor } from './harness';

const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-remote-thread-tools-'));
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/remote-thread-tools-vectors.json'), 'utf8')) as JsonObject;
const services: ThreadToolsService[] = [];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nextTick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function bounded<T>(promise: Promise<T>, ms = 750): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The operation did not settle within its cancellation bound.')), ms);
    void promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
function responseText(value: Json, success = true): string {
  const result = object(value); assert.equal(result.success, success, JSON.stringify(value));
  const content = result.contentItems as JsonObject[];
  assert.equal(content.length, 1); assert.equal(content[0]!.type, 'inputText');
  return String(content[0]!.text);
}
const body = (value: Json): JsonObject => object(JSON.parse(responseText(value)));
const context = (overrides: Partial<ThreadToolContext> = {}): ThreadToolContext => ({
  sessionId: 'coordinator', unattended: false, signal: new AbortController().signal, assertCurrent: () => {}, ...overrides,
});
const successfulDelivery: DelegationDeliveryResult = { ok: true, route: 'turn', archived: false, overridesApplied: false };
function page(device: string, id = 'same', completed = device === 'device-b'): JsonObject {
  return { thread: { id, title: `${device} ${id}`, status: { type: completed ? 'idle' : 'active' } },
    page: { order: 'newest_first', limit: 1, hasMore: false, nextCursor: null },
    turns: [{ id: device === 'device-a' ? 'turn-a' : 'turn-b', status: completed ? 'completed' : 'inProgress',
      items: [{ type: 'agentMessage', id: 'message', text: device === 'device-a' ? 'Local working.' : 'Remote finished.' }] }] };
}
function fixture(hostId: string) {
  const reads: JsonObject[] = [], delivered: Array<{ targetId: string; request: DelegationDeliveryRequest }> = [];
  const created: JsonObject[] = [];
  const events = new EventEmitter(), privateIds = new Set<string>();
  const model = {
    enabled: true, active: [] as Json[], archived: [] as Json[], pages: new Map<string, JsonObject>(),
    projects: [] as JsonObject[], projectRoots: [] as string[],
    read: undefined as ((params: JsonObject) => Promise<Json>) | undefined,
    deliver: undefined as ((targetId: string, request: DelegationDeliveryRequest) => Promise<DelegationDeliveryResult>) | undefined,
  };
  model.pages.set('same', page(hostId));
  const deps: ThreadToolsDeps = {
    enabled: () => model.enabled, isPrivateThread: id => privateIds.has(id),
    sessions: {
      async request(_method, params) {
        reads.push(clone(params));
        if (model.read) return model.read(params);
        const result = model.pages.get(String(params.threadId));
        if (!result) throw new Error('The conversation was not found.');
        return clone(result);
      },
      async listSessions() { return clone(model.active); },
      async listArchivedSessions() { return clone(model.archived); },
      async deliverDelegation(targetId, request) {
        delivered.push({ targetId, request: clone(request) });
        return model.deliver ? model.deliver(targetId, request) : successfulDelivery;
      },
      async newSession(options) { created.push(clone(options)); return { id: `created-${created.length}` }; },
      async forkSession() { throw new Error('Unexpected fork'); },
      async rename() { throw new Error('Unexpected rename'); },
      async setPinned() { throw new Error('Unexpected pin'); },
      async setArchived() { throw new Error('Unexpected archive'); },
      async directory() { throw new Error('Unexpected directory read'); },
    },
    wait: {
      onChange: listener => { events.on('change', listener); return () => { events.off('change', listener); }; },
      onInput: (id, listener) => { events.on(`input:${id}`, listener); return () => { events.off(`input:${id}`, listener); }; },
    },
    projects: async () => clone(model.projects) as Array<{ path: string; label?: string; conversationCount?: number; isGitRepository: boolean }>,
    projectRoots: () => [...model.projectRoots],
  };
  const service = new ThreadToolsService(deps); services.push(service);
  return { hostId, deps, service, model, reads, delivered, created, privateIds, events };
}
type Fixture = ReturnType<typeof fixture>;
const remoteContext = (target: Fixture, signal = new AbortController().signal) => ({
  accountId: 'account-fixture', localHostId: target.hostId, signal, assertCurrent: () => {},
});
function incoming(requestId = 'request-1', prompt = 'Inspect the result.', threadId = 'same'): JsonObject {
  return { caller: { hostId: 'device-a', threadId: 'coordinator' }, requestId, arguments: { threadId, prompt } };
}
function pair() {
  const a = fixture('device-a'), b = fixture('device-b'), peers = new Map([[a.hostId, a], [b.hostId, b]]);
  const statuses = new Map([[a.hostId, 'online'], [b.hostId, 'online']]);
  const requests: Array<{ source: string; target: string; operation: RemoteThreadOperation; args: JsonObject; signal: AbortSignal }> = [];
  let serial = 0;
  for (const source of [a, b]) source.deps.remote = {
    async discover(signal) {
      signal.throwIfAborted();
      return { localHostId: source.hostId, hosts: [...statuses].filter(([id]) => id !== source.hostId).map(([id, status]) => ({ id, name: id, status, features: { threadCommunication: 1 } })) };
    },
    async request(hostId, operation, args, callerThreadId, signal) {
      requests.push({ source: source.hostId, target: hostId, operation, args: clone(args), signal });
      signal.throwIfAborted();
      const target = peers.get(hostId);
      if (!target) throw new Error('The computer is not available on this account.');
      if (statuses.get(hostId) !== 'online') throw new Error('The remote computer is offline.');
      const received = target.service.receiveRemote(operation, {
        caller: { hostId: source.hostId, threadId: callerThreadId }, requestId: `request-${++serial}`, arguments: clone(args),
      }, remoteContext(target, signal));
      return abortable(received, signal);
    },
  };
  return { a, b, peers, statuses, requests };
}
const cases = (key: string): JsonObject[] => (vectors[key] as Json[]).map(object);
const row = (id: string, title: string, updatedAt: number, extra: JsonObject = {}): JsonObject => ({ id, title, updatedAt, ...extra });

for (const item of cases('readRouting')) h.test(String(item.name), async () => {
  const f = pair(), result = body(await f.a.service.execute('read_thread', item.arguments!, context()));
  assert.equal(object(result.thread).hostId, item.expectedHost);
  assert.equal(object(result.thread).title, `${item.expectedDevice} same`);
  assert.equal(f.a.reads.length, item.expectedDevice === 'device-a' ? 1 : 0);
  assert.equal(f.b.reads.length, item.expectedDevice === 'device-b' ? 1 : 0);
});

for (const item of cases('uncertainDelivery')) h.test(String(item.name), async () => {
  const f = pair(), removed = item.state === 'removed';
  f.b.model.deliver = async () => ({ ok: false, messageId: String(item.messageId), error: removed ? 'Owner removed input' : 'Admission unconfirmed',
    ...(removed ? { removed: true } : { unconfirmed: true }), notice: 'Check the recipient queue before resending' });
  const result = body(await f.a.service.execute('send_message_to_thread', { threadId: 'same', hostId: 'device-b', prompt: 'Already issued' }, context()));
  assert.equal(result.ok, false); assert.equal(result.delivered, item.state); assert.equal(result.messageId, item.messageId);
  assert.equal(result.followUp, undefined, 'an uncertain or removed input does not claim a successful result-collection path');
  assert.equal(result[removed ? 'removed' : 'unconfirmed'], true); assert.equal(result.hostId, 'device-b');
  assert.equal(result.error, undefined, 'top-level error remains reserved for the HTTP relay envelope');
  assert.equal(result.deliveryError, removed ? 'Owner removed input' : 'Admission unconfirmed');
  assert.equal(f.a.delivered.length, 0, 'no local fallback or resend'); assert.equal(f.b.delivered.length, 1, 'one receiver delivery');
});

for (const item of cases('sendRouting')) h.test(String(item.name), async () => {
  const f = pair(), result = body(await f.a.service.execute('send_message_to_thread', item.arguments!, context()));
  assert.equal(result.ok, true); assert.equal(result.threadId, 'same');
  const targetHost = item.expectedDevice === 'device-a' ? 'local' : 'device-b';
  assert.deepEqual(object(object(result.followUp).wait).arguments, { targets: [{ threadId: 'same', hostId: targetHost }], timeoutMs: 120_000 });
  assert.equal(f.a.delivered.length, item.expectedDevice === 'device-a' ? 1 : 0);
  assert.equal(f.b.delivered.length, item.expectedDevice === 'device-b' ? 1 : 0);
});

h.test('a remote same-id caller can send and receive a reply without local self-delivery', async () => {
  const f = pair();
  responseText(await f.a.service.execute('send_message_to_thread', { threadId: 'same', prompt: 'No self send.' }, context({ sessionId: 'same' })), false);
  body(await f.a.service.execute('send_message_to_thread', { threadId: 'same', hostId: 'device-b', prompt: 'Work remotely.' }, context({ sessionId: 'same' })));
  assert.equal(f.a.delivered.length, 0);
  const source = parseDelegationEnvelope(f.b.delivered[0]!.request.text)!;
  assert.deepEqual(source, { sourceThreadId: 'same', sourceHostId: 'device-a', input: 'Work remotely.' });
  body(await f.b.service.execute('send_message_to_thread', { threadId: source.sourceThreadId!, hostId: source.sourceHostId!, prompt: 'Done.' }, context({ sessionId: 'same' })));
  assert.equal(f.a.delivered.length, 1); assert.equal(f.a.delivered[0]!.request.displayText, 'Done.');
});

h.test('remote reads preserve opaque paging and output limits without local history reads', async () => {
  const f = pair();
  f.b.model.read = async params => ({ ...page('device-b'), page: { order: 'newest_first', limit: params.limit!, hasMore: true, nextCursor: 'older-page' },
    turns: [{ id: 'page-turn', status: 'completed', items: [{ type: 'commandExecution', id: 'command', command: 'test', status: 'completed', aggregatedOutput: 'abcdef' }] }] });
  const result = body(await f.a.service.execute('read_thread', { threadId: 'same', hostId: 'device-b', cursor: 'opaque-page', turnLimit: 2, includeOutputs: true, maxOutputCharsPerItem: 3 }, context()));
  assert.deepEqual(f.b.reads, [{ threadId: 'same', cursor: 'opaque-page', limit: 2 }]);
  assert.equal(f.a.reads.length, 0); assert.equal(object(result.page).nextCursor, 'older-page');
  const output = object(((object((result.turns as Json[])[0]).items as Json[])[0]));
  assert.deepEqual(output.output, { text: 'abc', truncated: true, originalChars: 6 });
});

h.test('aggregate lists keep both same-id hosts, every pin, and unavailable hosts', async () => {
  const f = pair();
  f.a.model.active = [row('same', 'Local', 1000), row('pin', 'Local pin', 100, { sidebarPinnedAt: 10 })];
  f.b.model.active = [row('same', 'Remote', 2000), row('pin', 'Remote pin', 200, { sidebarPinnedAt: 20 })];
  f.statuses.set('device-offline', 'offline');
  const result = body(await f.a.service.execute('list_threads', { limit: 2 }, context()));
  assert.deepEqual((result.threads as JsonObject[]).map(value => [value.id, value.hostId]), [['same', 'device-b'], ['same', 'local']]);
  assert.deepEqual((result.pinnedThreads as JsonObject[]).map(value => [value.id, value.hostId, value.pinnedIndex]), [['pin', 'local', 1], ['pin', 'device-b', 2]]);
  assert.equal(object((result.unavailableHosts as Json[])[0]).hostId, 'device-offline');
});

h.test('explicit remote lists and archived cursors remain confined to that host', async () => {
  const f = pair();
  f.a.model.active = [row('local-only', 'Local', 9000)]; f.b.model.active = [row('same', 'Remote', 2000)];
  f.b.model.archived = [row('old-2', 'Second', 2000, { archived: true }), row('old-1', 'First', 1000, { archived: true })];
  const selected = body(await f.a.service.execute('list_threads', { hostId: 'device-b' }, context()));
  assert.deepEqual((selected.threads as JsonObject[]).map(value => [value.id, value.hostId]), [['same', 'device-b']]);
  const first = body(await f.a.service.execute('list_archived_threads', { hostId: 'device-b', limit: 1 }, context()));
  const next = body(await f.a.service.execute('list_archived_threads', { hostId: 'device-b', limit: 1, cursor: first.nextCursor! }, context()));
  assert.deepEqual((next.threads as JsonObject[]).map(value => [value.id, value.hostId]), [['old-1', 'device-b']]);
  assert.equal(next.nextCursor, null);
});

h.test('unknown and offline hosts never fall through to local reads or sends', async () => {
  const f = pair(); f.statuses.set('device-b', 'offline');
  for (const hostId of ['device-b', 'device-missing']) {
    responseText(await f.a.service.execute('read_thread', { hostId, threadId: 'same' }, context()), false);
    responseText(await f.a.service.execute('send_message_to_thread', { hostId, threadId: 'same', prompt: 'Do not deliver locally.' }, context()), false);
  }
  assert.equal(f.a.reads.length + f.b.reads.length + f.a.delivered.length + f.b.delivered.length, 0);
});

h.test('source and destination disabled gates and private targets stop remote access', async () => {
  const f = pair(); f.a.model.enabled = false;
  responseText(await f.a.service.execute('read_thread', { threadId: 'same', hostId: 'device-b' }, context()), false);
  assert.equal(f.requests.length, 0);
  f.a.model.enabled = true; f.b.model.enabled = false;
  responseText(await f.a.service.execute('send_message_to_thread', { threadId: 'same', hostId: 'device-b', prompt: 'Disabled.' }, context()), false);
  f.b.model.enabled = true; f.b.privateIds.add('same');
  responseText(await f.a.service.execute('read_thread', { threadId: 'same', hostId: 'device-b' }, context()), false);
  responseText(await f.a.service.execute('send_message_to_thread', { threadId: 'same', hostId: 'device-b', prompt: 'Private.' }, context()), false);
  assert.equal(f.a.reads.length + f.b.reads.length + f.a.delivered.length + f.b.delivered.length, 0);
});

h.test('an unattended caller cannot send to a remote computer', async () => {
  const f = pair();
  responseText(await f.a.service.execute('send_message_to_thread', { threadId: 'same', hostId: 'device-b', prompt: 'No unattended send.' }, context({ unattended: true })), false);
  assert.equal(f.requests.length, 0); assert.equal(f.b.delivered.length, 0);
});

h.test('caller ownership is rechecked after discovery and before remote delivery', async () => {
  const f = pair(), release = deferred<void>(); let current = true;
  const original = f.a.deps.remote!.discover;
  f.a.deps.remote!.discover = async signal => { await release.promise; return original(signal); };
  const pending = f.a.service.execute('send_message_to_thread', { threadId: 'same', hostId: 'device-b', prompt: 'Stale caller.' }, context({ assertCurrent: () => { if (!current) throw new Error('Stale caller'); } }));
  await nextTick(); current = false; release.resolve();
  responseText(await pending, false); assert.equal(f.requests.length, 0);
});

h.test('disabling communication during discovery prevents a remote mutation', async () => {
  const f = pair(), release = deferred<void>();
  const original = f.a.deps.remote!.discover;
  f.a.deps.remote!.discover = async signal => { await release.promise; return original(signal); };
  const pending = f.a.service.execute('send_message_to_thread', { threadId: 'same', hostId: 'device-b', prompt: 'Do not send after disabling.' }, context());
  await nextTick(); f.a.model.enabled = false; release.resolve();
  responseText(await pending, false); assert.equal(f.requests.length, 0); assert.equal(f.b.delivered.length, 0);
});

h.test('receiver preserves the remote source envelope and normalized delivery overrides', async () => {
  const f = fixture('device-b'), input = incoming();
  input.arguments = { ...object(input.arguments), model: 'model-test', thinking: 'minimal' };
  const result = await f.service.receiveRemote('send_message_to_thread', input, remoteContext(f));
  assert.equal(result.ok, true);
  assert.deepEqual(parseDelegationEnvelope(f.delivered[0]!.request.text), { sourceThreadId: 'coordinator', sourceHostId: 'device-a', input: 'Inspect the result.' });
  assert.deepEqual({ ...f.delivered[0]!.request, text: undefined }, { text: undefined, displayText: 'Inspect the result.', model: 'model-test', effort: 'low' });
});

h.test('receiver deduplicates in-flight and completed request ids and refuses changed payloads', async () => {
  const f = fixture('device-b'), release = deferred<DelegationDeliveryResult>();
  f.model.deliver = () => release.promise;
  const first = f.service.receiveRemote('send_message_to_thread', incoming(), remoteContext(f));
  const second = f.service.receiveRemote('send_message_to_thread', incoming(), remoteContext(f));
  try {
    await waitFor(() => f.delivered.length === 1, 500, 'one delivery started');
    await assert.rejects(Promise.resolve().then(() => f.service.receiveRemote('send_message_to_thread', incoming('request-1', 'Different.'), remoteContext(f))), /already used/);
    release.resolve(successfulDelivery);
    assert.deepEqual(await first, await second);
    assert.deepEqual(await f.service.receiveRemote('send_message_to_thread', incoming(), remoteContext(f)), await first);
    assert.equal(f.delivered.length, 1);
  } finally { release.resolve(successfulDelivery); await Promise.allSettled([first, second]); }
});

h.test('a cancelled original request cannot erase the committed delivery receipt', async () => {
  const f = fixture('device-b'), release = deferred<DelegationDeliveryResult>(), controller = new AbortController();
  f.model.deliver = () => release.promise;
  const first = f.service.receiveRemote('send_message_to_thread', incoming(), remoteContext(f, controller.signal));
  const observed = first.then(() => undefined, () => undefined);
  try {
    await waitFor(() => f.delivered.length === 1, 500, 'delivery started before disconnect');
    controller.abort(new Error('Original connection closed.')); release.resolve(successfulDelivery); await observed;
    const retried = await f.service.receiveRemote('send_message_to_thread', incoming(), remoteContext(f));
    assert.equal(retried.ok, true); assert.equal(retried.delivered, 'started'); assert.equal(f.delivered.length, 1);
  } finally { release.resolve(successfulDelivery); await observed; }
});

h.test('equal request ids from distinct source hosts are separate deliveries', async () => {
  const f = fixture('device-b');
  await f.service.receiveRemote('send_message_to_thread', incoming(), remoteContext(f));
  await f.service.receiveRemote('send_message_to_thread', { ...incoming(), caller: { hostId: 'device-c', threadId: 'coordinator' } }, remoteContext(f));
  assert.equal(f.delivered.length, 2);
});

for (const item of cases('snapshots')) h.test(String(item.name), async () => {
  const f = pair();
  if (item.offline) f.statuses.set('device-b', 'offline');
  if (item.localCompleted) f.a.model.pages.set('same', page('device-a', 'same', true));
  const result = body(await f.a.service.execute('wait_threads', item.arguments!, context()));
  const wake = result.wake === null ? null : { threadId: object(result.wake).threadId, hostId: object(result.wake).hostId, reason: object(result.wake).reason };
  assert.deepEqual(wake, item.expectedWake); assert.equal(result.timedOut, item.expectedTimedOut);
  assert.deepEqual((result.polls as JsonObject[]).map(value => ({ threadId: value.threadId, hostId: value.hostId, cursor: value.cursor, text: value.text, changed: value.changed,
    textTruncated: value.textTruncated, readResult: value.readResult ?? null })), item.expectedPolls);
  assert.deepEqual((result.errors as JsonObject[] | undefined)?.map(value => ({ threadId: value.threadId, hostId: value.hostId })) ?? [], item.expectedErrors ?? []);
});

h.test('wait aliases detect a duplicate local address and reject only the real self target', async () => {
  const f = pair();
  responseText(await f.a.service.execute('wait_threads', { targets: [{ threadId: 'same', hostId: 'local' }, { threadId: 'same', hostId: 'device-a' }], timeoutMs: 0 }, context()), false);
  responseText(await f.a.service.execute('wait_threads', { targets: [{ threadId: 'same', hostId: 'device-a' }], timeoutMs: 0 }, context({ sessionId: 'same' })), false);
  const remote = body(await f.a.service.execute('wait_threads', { targets: [{ threadId: 'same', hostId: 'device-b' }], timeoutMs: 0 }, context({ sessionId: 'same' })));
  assert.equal(object(remote.wake).hostId, 'device-b'); assert.equal(f.a.reads.length, 0);
});

for (const mixed of [false, true]) h.test(`${mixed ? 'mixed-host' : 'remote'} wait yields to caller input during a pending read`, async () => {
  const f = pair(), remote = deferred<Json>(), local = deferred<Json>();
  f.b.model.read = () => remote.promise;
  if (mixed) f.a.model.read = () => local.promise;
  const targets = [{ threadId: 'same', hostId: 'device-b' }, ...(mixed ? [{ threadId: 'same', hostId: 'local' }] : [])];
  const pending = f.a.service.execute('wait_threads', { targets, timeoutMs: 5000 }, context());
  try {
    await waitFor(() => f.b.reads.length > 0 && (!mixed || f.a.reads.length > 0), 500, 'wait reads started');
    f.a.events.emit('input:coordinator');
    assert.deepEqual(body(await bounded(pending)), { message: 'Wait interrupted by new input.', timedOut: false });
    assert(f.requests.some(request => request.signal.aborted), 'pending remote request was cancelled');
  } finally { remote.resolve(page('device-b')); local.resolve(page('device-a')); await pending; }
});

for (const mixed of [false, true]) h.test(`${mixed ? 'mixed-host' : 'remote'} wait deadline cancels pending reads and reports target errors`, async () => {
  const f = pair(), remote = deferred<Json>(), local = deferred<Json>();
  f.b.model.read = () => remote.promise;
  if (mixed) f.a.model.read = () => local.promise;
  const targets = [{ threadId: 'same', hostId: 'device-b' }, ...(mixed ? [{ threadId: 'same', hostId: 'local' }] : [])];
  const pending = f.a.service.execute('wait_threads', { targets, timeoutMs: 25 }, context());
  try {
    const result = body(await bounded(pending));
    assert.equal(result.timedOut, true);
    assert((result.errors as JsonObject[]).some(error => error.threadId === 'same' && error.hostId === 'device-b'));
    assert(f.requests.some(request => request.signal.aborted), 'deadline cancels the peer request');
  } finally { remote.resolve(page('device-b')); local.resolve(page('device-a')); await pending; }
});

h.test('shutdown drains every inbound read after one request rejects', async () => {
  const f = fixture('device-b'), one = deferred<Json>(), two = deferred<Json>();
  f.model.read = params => params.threadId === 'one' ? one.promise : two.promise;
  const read = (threadId: string) => f.service.receiveRemote('read_thread', { ...incoming(threadId), arguments: { threadId } }, remoteContext(f));
  const first = read('one'), second = read('two');
  const observed = Promise.allSettled([first, second]);
  await waitFor(() => f.reads.length === 2, 500, 'both inbound reads started');
  let settled = false;
  const closing = f.service.close(); void closing.then(() => { settled = true; }, () => { settled = true; });
  try {
    one.resolve(page('device-b', 'one')); await nextTick();
    assert.equal(settled, false, 'one rejection cannot release shutdown while the second read remains pending');
    two.resolve(page('device-b', 'two')); await closing;
  } finally { one.resolve(page('device-b', 'one')); two.resolve(page('device-b', 'two')); await observed; await closing.catch(() => {}); }
});

for (const item of cases('remoteCreation')) h.test(String(item.name), async () => {
  const f = pair();
  const path = String(item.path);
  const local = item.expectedCreatedOn === 'local';
  f.a.model.projectRoots = [path];
  if (item.expectedError === undefined) {
    f.b.model.projects = [{ path, isGitRepository: true }];
    f.b.model.projectRoots = [path];
  } else f.b.model.projectRoots = ['/registered/elsewhere'];
  if (item.offline === true) f.statuses.set('device-b', 'offline');
  const call = f.a.service.execute('create_thread',
    { prompt: 'Check the portal from that machine.', target: { type: 'project', projectId: JSON.stringify([item.host, path]), environment: { type: 'local' } } },
    context());
  if (typeof item.expectedError === 'string') {
    assert.match(responseText(await call, false), new RegExp(item.expectedError));
    assert.equal(f.a.created.length, 0); assert.equal(f.b.created.length, 0, 'a refused route creates nowhere');
    return;
  }
  const result = body(await call);
  assert.equal(result.ok, true);
  assert.equal(result.hostId, item.expectedCreatedOn, 'the creation reports the computer that runs it');
  if (local) {
    assert.equal(f.a.created.length, 1); assert.equal(f.b.created.length, 0);
    assert.equal(f.requests.length, 0, 'a local alias never touches the relay');
    assert.equal(f.a.created[0]!.workdir, path, 'the conversation lands in the project folder');
    return;
  }
  assert.equal(f.a.created.length, 0, 'the caller machine created nothing');
  assert.equal(f.b.created.length, 1, 'the destination created the conversation');
  assert.equal(f.b.created[0]!.workdir, path, 'the conversation lands in the project folder');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.operation, 'create_thread');
  assert.equal(f.requests[0]!.target, 'device-b');
  // The delivered prompt names the creating conversation across machines.
  const source = parseDelegationEnvelope(f.b.delivered[0]!.request.text)!;
  assert.deepEqual([source.sourceThreadId, source.sourceHostId], ['coordinator', 'device-a']);
});

h.test('list_projects reports peer projects with the host that runs them', async () => {
  const f = pair();
  f.a.model.projects = [{ path: '/local/repo', isGitRepository: true }];
  f.b.model.projects = [{ path: '/remote/repo', label: 'Remote', isGitRepository: false }];
  const result = body(await f.a.service.execute('list_projects', {}, context()));
  const rows = (result.projects as JsonObject[]).map(value => object(value));
  assert.deepEqual(rows.map(value => [value.hostId, value.path]), [['local', '/local/repo'], ['device-b', '/remote/repo']]);
  assert.deepEqual(JSON.parse(String(rows[1]!.projectId)), ['device-b', '/remote/repo'], 'the id a target carries back names the peer');
  assert.equal(rows[1]!.label, 'Remote');
});

h.test('a remote creation whose tuple names another computer is refused at the destination', async () => {
  const f = pair();
  f.a.model.projectRoots = ['/a/repo'];
  await assert.rejects(f.b.service.receiveRemote('create_thread', {
    caller: { hostId: 'device-a', threadId: 'coordinator' }, requestId: 'route-elsewhere',
    arguments: { prompt: 'Create here.', target: { type: 'project', projectId: JSON.stringify(['device-a', '/a/repo']), environment: { type: 'local' } } },
  }, remoteContext(f.b)), /does not live on this computer/);
  assert.equal(f.b.created.length, 0);
});

h.test('a remote creation into an unregistered destination folder is refused', async () => {
  const f = pair();
  f.b.model.projectRoots = ['/registered/repo'];
  await assert.rejects(f.b.service.receiveRemote('create_thread', {
    caller: { hostId: 'device-a', threadId: 'coordinator' }, requestId: 'unknown-folder',
    arguments: { prompt: 'Create here.', target: { type: 'project', projectId: JSON.stringify(['device-b', '/not/registered']), environment: { type: 'local' } } },
  }, remoteContext(f.b)), /Unknown projectId/);
  assert.equal(f.b.created.length, 0);
});

void h.finish(join(root, 'result.json'), 'remote-thread-tools').then(async code => {
  process.exitCode = 1;
  try { await Promise.all(services.map(service => service.close())); }
  finally { rmSync(root, { recursive: true, force: true }); }
  process.exitCode = code;
}).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
