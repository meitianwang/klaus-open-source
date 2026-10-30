// Protocol tests: plan §6.1 items 2 and 3, exercised against a fake engine stream
// so every wire edge case is reproducible without a real child process.
//
// Item 2 — framing: "跨 chunk、多帧、UTF-8、大消息、错误帧" (frames split across
// chunks, several frames in one chunk, UTF-8 split across a chunk boundary, large
// messages, error frames).
// Item 3 — "request ID、pending map、超时、取消、反向请求响应；EOF/写失败一次性结束
// 相关 pending" (request ids, pending map, timeout, cancel, reverse-request
// responses; EOF or write failure ends the related pending requests all at once).

import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { AppServerClient } from '../main/engine/client';
import { monitorHostResponsiveness } from '../main/app/log';
import { RpcRequestScheduler, rpcAdmission, type RpcRequestDiagnostic } from '../main/engine/request-scheduler';
import { vectorPath } from '../main/paths';
import { NdjsonFramer, parseFrame } from '../main/engine/ndjson';
import { join } from 'node:path';
import {
  classify,
  notificationToEvent,
  REVERSE_REQUEST_DROPPED_CODE,
  REVERSE_REQUEST_METHODS,
  SPECIAL_NOTIFICATIONS,
  SPECIAL_NOTIFICATION_EVENT_TYPES,
} from '../main/engine/protocol';
import { inheritedEnv, spawnKey, expandHomePrefix, windowsSystemProxy } from '../main/engine/spawn';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  assertRejects,
  Harness,
  sleep,
  waitFor,
} from './harness';

/** A two-way fake engine: the host writes to `toEngine`, the engine writes to `toHost`. */
function fakeEngine() {
  const toEngine = new PassThrough(); // host stdin -> engine reads
  const toHost = new PassThrough(); // engine stdout -> host reads
  const client = new AppServerClient(toEngine, 'fake-engine');
  const sent: string[] = [];
  toEngine.on('data', (chunk: Buffer) => sent.push(chunk.toString('utf8')));
  toHost.on('data', (chunk: Buffer) => client.feedStdout(chunk));
  toHost.on('end', () => client.endStdout());
  const clientEvents: unknown[] = [];
  client.on('event', (event) => clientEvents.push(event));
  return {
    client,
    sent,
    clientEvents,
    /** Engine -> host, as raw bytes so chunk boundaries are under test control. */
    engineWrite(bytes: Buffer | string): void {
      toHost.write(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
    },
    /** Engine replies to the request with this id. */
    reply(id: number, result: unknown): void {
      toHost.write(`${JSON.stringify({ id, result })}\n`);
    },
    replyError(id: number, code: number, message: string): void {
      toHost.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
    },
    notify(method: string, params: unknown): void {
      toHost.write(`${JSON.stringify({ method, params })}\n`);
    },
    /** Engine asks the client something (approval/elicitation). */
    reverseRequest(id: number, method: string, params: unknown): void {
      toHost.write(`${JSON.stringify({ id, method, params })}\n`);
    },
    endFromEngine(): void {
      toHost.end();
    },
    /** Frames the host wrote, parsed. */
    sentFrames(): unknown[] {
      return sent
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    },
    lastFrame(): unknown {
      const frames = sent.join('').split('\n').filter((l) => l.trim().length > 0);
      return JSON.parse(frames[frames.length - 1] as string);
    },
  };
}

const h = new Harness();
const schedulerVector = (JSON.parse(readFileSync(vectorPath('remote-catalog-host-vectors.json'), 'utf8')) as {
  scheduler: { total: number; critical: number; noncritical: number; background: number; backgroundThread: number; backgroundCatalog: number; maxNoncriticalQueued: number };
}).scheduler;

function requests(f: ReturnType<typeof fakeEngine>): Array<{ id: number; method: string; params: Record<string, unknown> }> {
  return f.sentFrames() as Array<{ id: number; method: string; params: Record<string, unknown> }>;
}

h.test('scheduler reserves critical and interactive slots while enforcing background source caps', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  const enqueue = (method: string, id: string, source: 'thread' | 'thread_catalog' | 'other') => {
    pending.push(f.client.requestWithTimeout(method, { sessionId: id }, 1000, { priority: 'background', source }).catch(error => error));
  };
  enqueue('engine/listSessions', 'catalog-1', 'thread_catalog');
  enqueue('engine/listSessions', 'catalog-2', 'thread_catalog');
  enqueue('session/history', 'thread-1', 'thread');
  enqueue('session/history', 'thread-2', 'thread');
  enqueue('session/history', 'thread-3', 'thread');
  enqueue('config/read', 'other-1', 'other');
  enqueue('config/read', 'other-2', 'other');
  assertEqual(requests(f).length, schedulerVector.background, 'one catalog, two thread and one other background request');
  pending.push(f.client.requestWithTimeout('session/contextSnapshot', { sessionId: 'open' }, 1000).catch(error => error));
  pending.push(f.client.requestWithTimeout('session/modelRuntime', { sessionId: 'queued' }, 1000).catch(error => error));
  assertEqual(requests(f).length, schedulerVector.noncritical, 'the fifth noncritical slot is interactive');
  pending.push(f.client.requestWithTimeout('turn/interrupt', { sessionId: 'busy' }, 1000).catch(error => error));
  assertEqual(requests(f).length, schedulerVector.total, 'a stop bypasses the saturated ordinary queue');
  assertEqual(requests(f)[5]?.method, 'turn/interrupt', 'the reserved slot carries actual control work');
  f.client.close(); await Promise.all(pending);
  assertDeepEqual(f.client.schedulingStats(), { running: 0, queued: 0, consumers: 0 }, 'close drains every lane');
});

h.test('direct and queued admissions use reserved control capacity behind saturated ordinary traffic', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  try {
    for (let index = 0; index <= schedulerVector.noncritical; index++) {
      pending.push(f.client.request('test/ordinary', { index }).catch(error => error));
    }
    assertEqual(requests(f).length, schedulerVector.noncritical, 'ordinary traffic fills its lane and retains one queued request');
    assertDeepEqual(f.client.schedulingStats(), { running: schedulerVector.noncritical, queued: 1, consumers: schedulerVector.noncritical + 1 }, 'ordinary saturation keeps the control slot free');
    const direct = f.client.request('turn/submit', { sessionId: 'direct-thread', mode: 'start-if-idle', input: 'Direct input', submissionId: 'direct-admission' });
    pending.push(direct.catch(error => error));
    assertEqual(requests(f).length, schedulerVector.total, 'direct admission writes through the reserved slot immediately');
    const directFrame = requests(f).at(-1)!;
    assertEqual(directFrame.method, 'turn/submit', 'the reserved wire request contains actual direct admission');
    assertEqual(directFrame.params.submissionId, 'direct-admission', 'the direct request retains its submission identity');
    const queued = f.client.request('thread/queue/start', { threadId: 'queued-thread', queuedSubmissionId: 'queued-row', mode: 'start-if-idle', submissionId: 'queued-admission' });
    pending.push(queued.catch(error => error));
    assertEqual(requests(f).length, schedulerVector.total, 'a second control request still respects the total in-flight budget');
    assertDeepEqual(f.client.schedulingStats(), { running: schedulerVector.total, queued: 2, consumers: schedulerVector.noncritical + 3 }, 'ordinary backlog and queued control each retain one consumer');
    f.reply(directFrame.id, { status: 'started', submissionId: 'direct-admission', turnId: 'direct-admission' });
    await direct;
    await waitFor(() => requests(f).length === schedulerVector.total + 1, 1000, 'queued admission claims the released control slot');
    const queuedFrame = requests(f).at(-1)!;
    assertEqual(queuedFrame.method, 'thread/queue/start', 'queued admission runs before the older ordinary backlog');
    assertEqual(queuedFrame.params.queuedSubmissionId, 'queued-row', 'the actual durable row identity reaches the engine');
    assertEqual(requests(f).filter(frame => frame.method === 'test/ordinary').length, schedulerVector.noncritical, 'ordinary saturation cannot consume the reserved control slot');
    assertDeepEqual(f.client.schedulingStats(), { running: schedulerVector.total, queued: 1, consumers: schedulerVector.noncritical + 2 }, 'both admission methods obey the shared connection budget');
  } finally {
    f.client.close(); await Promise.all(pending);
    assertDeepEqual(f.client.schedulingStats(), { running: 0, queued: 0, consumers: 0 }, 'cleanup drains both control and ordinary work');
  }
});

h.test('queue reads coalesce only within their mutation epoch and queue starts always write separately', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  try {
    const params = { threadId: 'shared-queue', limit: 128 };
    const first = f.client.request('thread/queue/list', params), joined = f.client.request('thread/queue/list', params);
    pending.push(first.catch(error => error), joined.catch(error => error));
    assertEqual(requests(f).length, 1, 'identical queue reads share one actual wire request');
    assertDeepEqual(f.client.schedulingStats(), { running: 1, queued: 0, consumers: 2 }, 'one read job owns two independent consumers');
    const oldRead = requests(f)[0]!;
    const mutation = f.client.request('thread/queue/add', { threadId: 'shared-queue', clientUserMessageId: 'new-row', input: [{ type: 'text', text: 'Queued input' }] });
    const fresh = f.client.request('thread/queue/list', params), freshJoined = f.client.request('thread/queue/list', params);
    pending.push(mutation.catch(error => error), fresh.catch(error => error), freshJoined.catch(error => error));
    const afterMutation = requests(f);
    assertDeepEqual(afterMutation.map(frame => frame.method), ['thread/queue/list', 'thread/queue/add', 'thread/queue/list'], 'a queue mutation forces a new wire read while its old read remains pending');
    assertDeepEqual(f.client.schedulingStats(), { running: 3, queued: 0, consumers: 5 }, 'the new read epoch coalesces its own consumers independently');
    let freshSettled = false; void fresh.then(() => { freshSettled = true; }, () => {});
    const startParams = { threadId: 'shared-queue', queuedSubmissionId: 'new-row', mode: 'start-if-idle', submissionId: 'same-submission' };
    const start1 = f.client.request('thread/queue/start', startParams), start2 = f.client.request('thread/queue/start', startParams);
    pending.push(start1.catch(error => error), start2.catch(error => error));
    const budget = f.client.schedulingStats();
    assertEqual(budget.running + budget.queued, 5, 'separate queue mutations each retain their own scheduling job');
    assertEqual(budget.consumers, 7, 'shared read consumers and independent admissions remain separate');
    assert(budget.running <= schedulerVector.total, 'metadata and admissions respect the connection budget');
    f.reply(oldRead.id, { revision: 1, data: [], nextCursor: null });
    assertDeepEqual(await first, await joined, 'old-epoch consumers receive their one old snapshot');
    await waitFor(() => requests(f).filter(frame => frame.method === 'thread/queue/start').length === 2, 1000, 'both independent queue starts write after control capacity becomes available');
    const starts = requests(f).filter(frame => frame.method === 'thread/queue/start');
    assertEqual(starts.length, 2, 'even byte-identical queue starts write two distinct engine RPCs');
    assert(starts[0]!.id !== starts[1]!.id, 'queue starts never share wire request identity');
    assertEqual(freshSettled, false, 'an old queue response cannot settle post-mutation readers');
    f.reply(afterMutation[1]!.id, { revision: 2 });
    const currentSnapshot = { revision: 2, data: [{ id: 'new-row' }], nextCursor: null };
    f.reply(afterMutation[2]!.id, currentSnapshot);
    assertDeepEqual(await fresh, currentSnapshot, 'post-mutation readers receive the fresh queue snapshot');
    assertDeepEqual(await freshJoined, currentSnapshot, 'same-epoch consumers share only the fresh response');
    for (const frame of starts) f.reply(frame.id, { status: 'started', submissionId: 'same-submission', turnId: 'same-submission' });
    await Promise.all([mutation, start1, start2]);
    assertDeepEqual(f.client.schedulingStats(), { running: 0, queued: 0, consumers: 0 }, 'settlement releases every read consumer and separate admission');
  } finally { f.client.close(); await Promise.all(pending); }
});

h.test('a committed queue change isolates listener and later reads from an older in-flight snapshot', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  try {
    const params = { threadId: 'external-queue', limit: 128, includeInput: false };
    const old = f.client.request('thread/queue/list', params); pending.push(old.catch(error => error));
    const oldFrame = requests(f)[0]!; let oldSettled = false;
    void old.then(() => { oldSettled = true; }, () => {});
    let listenerRead: Promise<unknown> | undefined;
    f.client.on('event', event => {
      if (event.type !== 'productEvent' || event.method !== 'thread/queue/changed') return;
      listenerRead = f.client.request('thread/queue/list', params); pending.push(listenerRead.catch(error => error));
    });
    f.client.feedStdout(Buffer.from(JSON.stringify({ method: 'thread/queue/changed', params: { threadId: 'external-queue', revision: 2 } }) + '\n'));
    assert(listenerRead, 'the committed queue event synchronously requests its fresh snapshot');
    const laterRead = f.client.request('thread/queue/list', params); pending.push(laterRead.catch(error => error));
    const frames = requests(f);
    assertEqual(frames.length, 2, 'an external queue change writes a new list RPC before notifying readers');
    const freshFrame = frames[1]!;
    assert(freshFrame.id !== oldFrame.id, 'the listener read owns a distinct wire request identity');
    assert(frames.every(frame => frame.method === 'thread/queue/list'), 'external notification requires no local mutation request');
    assertDeepEqual(freshFrame.params, oldFrame.params, 'only the committed notification separates identical read parameters');
    const fresh = { revision: 2, data: [{ id: 'committed-row' }], nextCursor: null };
    f.reply(freshFrame.id, fresh);
    assertDeepEqual(await listenerRead, fresh, 'the event listener receives the committed revision');
    assertDeepEqual(await laterRead, fresh, 'post-notification reads coalesce only with the fresh listener read');
    assertEqual(oldSettled, false, 'the new reply cannot settle the held old reader');
    const stale = { revision: 1, data: [], nextCursor: null }; f.reply(oldFrame.id, stale);
    assertDeepEqual(await old, stale, 'the old response belongs only to its original reader');
    assertDeepEqual(f.client.schedulingStats(), { running: 0, queued: 0, consumers: 0 }, 'both read epochs release their own consumers');
  } finally { f.client.close(); await Promise.all(pending); }
});

h.test('queue inspection and update/delete use reserved capacity while title metadata saturates ordinary traffic', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < schedulerVector.noncritical; index++) {
      pending.push(f.client.request('session/updateTitle', { threadId: `title-${index}`, title: `Held title ${index}` }).catch(error => error));
    }
    assertEqual(requests(f).length, schedulerVector.noncritical, 'five actual title writes occupy ordinary in-flight capacity');
    assertDeepEqual(f.client.schedulingStats(), { running: schedulerVector.noncritical, queued: 0, consumers: schedulerVector.noncritical }, 'title receipts remain held throughout queue metadata work');
    const list = f.client.request('thread/queue/list', { threadId: 'queue-thread', limit: 128 });
    pending.push(list.catch(error => error));
    assertEqual(requests(f).length, schedulerVector.total, 'queue inspection writes immediately through reserved capacity');
    const listFrame = requests(f).at(-1)!;
    assertEqual(listFrame.method, 'thread/queue/list', 'the actual read precedes preparation and removal');
    assertDeepEqual(f.client.schedulingStats(), { running: schedulerVector.total, queued: 0, consumers: schedulerVector.total }, 'one queue inspection and five titles share the bounded connection');
    const row = { id: 'native-queued-row', input: [{ type: 'text', text: 'Original input' }], createdAt: 1 };
    f.reply(listFrame.id, { data: [row], revision: 7, nextCursor: null });
    const snapshot = await list as { data: Array<{ id: string }>; revision: number };
    let revision = snapshot.revision;
    const controlIds = [listFrame.id];
    for (const method of ['thread/queue/update', 'thread/queue/delete']) {
      const mutation = f.client.request(method, { threadId: 'queue-thread', queuedSubmissionId: snapshot.data[0]!.id, expectedRevision: revision,
        ...(method === 'thread/queue/update' ? { input: [{ type: 'text', text: 'Prepared input' }] } : {}) });
      pending.push(mutation.catch(error => error));
      const frame = requests(f).at(-1)!;
      assertEqual(frame.method, method, 'the next queue mutation writes while every title receipt is still held');
      assertEqual(frame.params.queuedSubmissionId, row.id, 'the actual backend identity from inspection reaches the mutation');
      assertEqual(frame.params.expectedRevision, revision, 'metadata operations retain their observed revision');
      controlIds.push(frame.id);
      assertEqual(new Set(controlIds).size, controlIds.length, 'queue reads and mutations own independent wire requests');
      assertDeepEqual(f.client.schedulingStats(), { running: schedulerVector.total, queued: 0, consumers: schedulerVector.total }, 'each queue mutation occupies only the reserved slot');
      revision++;
      f.reply(frame.id, method === 'thread/queue/delete' ? { deleted: true, revision } : { queuedSubmission: row, revision, replayed: false });
      await mutation;
      assertDeepEqual(f.client.schedulingStats(), { running: schedulerVector.noncritical, queued: 0, consumers: schedulerVector.noncritical }, 'each queue reply releases reserved capacity without completing a title');
    }
    assertEqual(requests(f).length, schedulerVector.noncritical + 3, 'exactly one list, update and delete cross the saturated title lane');
  } finally {
    f.client.close(); await Promise.all(pending);
    assertDeepEqual(f.client.schedulingStats(), { running: 0, queued: 0, consumers: 0 }, 'cleanup drains held title receipts and queue work');
  }
});

h.test('scheduler rotates queued conversations instead of draining one conversation first', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) pending.push(f.client.request('test/read', { sessionId: 'busy', index: i }).catch(error => error));
  pending.push(f.client.request('test/read', { sessionId: 'busy', index: 5 }).catch(error => error));
  pending.push(f.client.request('test/read', { sessionId: 'other', index: 0 }).catch(error => error));
  f.reply(requests(f)[0]!.id, {});
  await waitFor(() => requests(f).length === 6, 1000, 'the released slot is admitted');
  assertEqual(requests(f)[5]?.params.sessionId, 'other', 'a second conversation gets the next available slot');
  f.client.close(); await Promise.all(pending);
});

h.test('scheduler coalesces identical reads but never duplicate mutations or distinct parameters', async () => {
  const f = fakeEngine();
  const first = f.client.request('engine/readSessionSummary', { sessionId: 'same', options: { a: 1, b: 2 } });
  const second = f.client.request('engine/readSessionSummary', { options: { b: 2, a: 1 }, sessionId: 'same' });
  const other = f.client.request('engine/readSessionSummary', { sessionId: 'other' });
  const send1 = f.client.request('turn/start', { sessionId: 'same', input: 'human' });
  const send2 = f.client.request('turn/start', { sessionId: 'same', input: 'human' });
  assertEqual(requests(f).length, 4, 'one shared read, one distinct read and two actual mutations');
  for (const frame of requests(f)) f.reply(frame.id, { id: frame.params.sessionId });
  assertDeepEqual(await first, await second, 'shared read result reaches both callers');
  await Promise.all([other, send1, send2]);
  assertDeepEqual(f.client.schedulingStats(), { running: 0, queued: 0, consumers: 0 }, 'coalescing leaves no retained jobs');
  f.client.close();
});

h.test('scheduler coalesces concurrent picker catalog reads and selection resolution', async () => {
  const f = fakeEngine();
  const main = f.client.request('qoderwork/models', { read: 'warm' });
  const side = f.client.request('qoderwork/models', { read: 'warm' });
  const otherSource = f.client.request('zhipu/models', { read: 'warm' });
  const resolve1 = f.client.request('model/selection/resolve', { source: 'qoderwork', selection: 'qwork-auto' });
  const resolve2 = f.client.request('model/selection/resolve', { source: 'qoderwork', selection: 'qwork-auto' });
  assertEqual(requests(f).length, 3, 'same-source catalog reads and same-parameter resolutions share one wire request each');
  for (const frame of requests(f)) f.reply(frame.id, { models: [], selection: 'qwork-auto', source: 'qoderwork' });
  assertDeepEqual(await main, await side, 'both picker refreshes see the one catalog reply');
  assertDeepEqual(await resolve1, await resolve2, 'both resolutions see the one reply');
  await otherSource;
  assertDeepEqual(f.client.schedulingStats(), { running: 0, queued: 0, consumers: 0 }, 'coalescing leaves no retained jobs');
  f.client.close();
});

h.test('scheduler caps concurrent critical work so a reconfiguration storm cannot starve interactive reads', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  for (let index = 0; index < schedulerVector.critical + 2; index++) {
    pending.push(f.client.request('session/reconfigureModel', { sessionId: `chat-${index}` }).catch(error => error));
  }
  assertEqual(requests(f).length, schedulerVector.critical, 'the storm enters only up to the critical cap');
  pending.push(f.client.request('qoderwork/models', { read: 'warm' }).catch(error => error));
  assertEqual(requests(f).length, schedulerVector.critical + 1, 'an interactive catalog read still gets an ordinary slot');
  for (const frame of requests(f)) f.reply(frame.id, {});
  await waitFor(() => requests(f).length === schedulerVector.critical + 3, 1000, 'queued critical work resumes as slots free');
  f.client.close(); await Promise.all(pending);
});

h.test('scheduler consumer cancellation and timeout cannot cancel another reader of the same operation', async () => {
  const f = fakeEngine(), controller = new AbortController();
  const cancelledRead = f.client.requestWithTimeout('engine/readSessionSummary', { sessionId: 'shared' }, 1000, { signal: controller.signal }).catch(error => error);
  const timedOutRead = f.client.requestWithTimeout('engine/readSessionSummary', { sessionId: 'shared' }, 10).catch(error => error);
  const survivingRead = f.client.requestWithTimeout('engine/readSessionSummary', { sessionId: 'shared' }, 1000);
  controller.abort();
  assertEqual((await cancelledRead as { code: number }).code, -32800, 'one consumer cancelled');
  assertEqual((await timedOutRead as { kind: string }).kind, 'timeout', 'each consumer owns its own deadline');
  assertEqual(f.client.stats().pending, 1, 'the wire operation remains for the surviving consumer');
  f.reply(requests(f)[0]!.id, { session: 'shared' });
  assertDeepEqual(await survivingRead, { session: 'shared' }, 'the uncancelled reader receives the reply');
  f.client.close();
});

h.test('scheduler removes queued cancellation and deadlines before writing to the engine', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) pending.push(f.client.request('test/block', { index: i }).catch(error => error));
  const controller = new AbortController();
  const cancelledRead = f.client.requestWithTimeout('engine/readSessionSummary', { sessionId: 'cancelled' }, 1000, { signal: controller.signal }).catch(error => error);
  const timedOutRead = f.client.requestWithTimeout('engine/readSessionSummary', { sessionId: 'expired' }, 10).catch(error => error);
  controller.abort();
  assertEqual((await cancelledRead as { code: number }).code, -32800, 'queued cancellation is observable');
  assertEqual((await timedOutRead as { kind: string }).kind, 'timeout', 'timeout includes queue time');
  assertEqual(requests(f).length, 5, 'neither cancelled request was written');
  assertEqual(f.client.schedulingStats().queued, 0, 'cancelled queue entries were removed');
  f.client.close(); await Promise.all(pending);
});

h.test('scheduler cancels the wire observation only after its last consumer leaves', async () => {
  const f = fakeEngine(), controller = new AbortController();
  const result = f.client.requestWithTimeout('engine/readSessionSummary', { sessionId: 'last' }, 1000, { signal: controller.signal }).catch(error => error);
  controller.abort(); await result;
  assertEqual(f.client.stats().pending, 0, 'the abandoned pending wire id is removed');
  assertEqual(f.client.schedulingStats().running, 0, 'the slot is released');
  f.reply(requests(f)[0]!.id, { late: true });
  assertEqual(f.client.stats().pending, 0, 'a late reply cannot resurrect its cancelled consumer');
  f.client.close();
});

h.test('scheduler promotes a coalesced user read ahead of queued background work', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) pending.push(f.client.request('test/background', { i }, { priority: 'background' }).catch(error => error));
  pending.push(f.client.request('session/history', { sessionId: 'open' }, { priority: 'background', source: 'thread' }).catch(error => error));
  assertEqual(requests(f).length, 4, 'background budget is full');
  pending.push(f.client.request('session/history', { sessionId: 'open' }).catch(error => error));
  assertEqual(requests(f).length, 5, 'the shared read is promoted into the interactive reserve');
  assertEqual(requests(f)[4]?.params.sessionId, 'open', 'the selected thread is admitted');
  f.client.close(); await Promise.all(pending);
});

for (const mutation of [false, true]) h.test(`a shared observation promotes its original queued job ${mutation ? 'after another mutation' : 'within the same read epoch'}`, async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) pending.push(f.client.request('test/background', { i }, { priority: 'background' }).catch(error => error));
  let promote!: (priority: 'critical' | 'interactive' | 'background') => boolean;
  const observation = f.client.request('session/goal', { threadId: 'open' }, { priority: 'background', source: 'thread', onQueued: value => { promote = value; } });
  pending.push(observation.catch(error => error));
  assertEqual(requests(f).length, 4, 'background capacity is occupied');
  if (mutation) pending.push(f.client.request('session/start', { threadId: 'other' }).catch(error => error));
  const before = requests(f).length;
  const consumers = f.client.schedulingStats().consumers;
  assertEqual(promote('interactive'), true, 'the exact pending observation is promoted');
  assertEqual(requests(f).length, before + 1, 'the observation uses reserved interactive capacity');
  const frame = requests(f).at(-1)!;
  assertEqual(frame.params.threadId, 'open', 'the original observation is admitted across epoch changes');
  assertEqual(f.client.schedulingStats().consumers, consumers, 'promotion creates no extra observer');
  f.reply(frame.id, { threadGoal: null, goalRevision: 0 });
  await observation;
  pending.push(f.client.request('session/goal', { threadId: 'open' }, { priority: 'background', source: 'thread' }).catch(error => error));
  assertEqual(promote('interactive'), false, 'a settled handle cannot promote a later observation with the same parameters');
  assertEqual(requests(f).length, before + 1, 'the retired handle starts no additional request');
  f.client.close(); await Promise.all(pending);
});

h.test('scheduler bounds ordinary backlog without consuming the critical queue reserve', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  for (let i = 0; i < 5 + 448; i++) pending.push(f.client.request('test/read', { i }).catch(error => error));
  assertEqual(f.client.schedulingStats().queued, schedulerVector.maxNoncriticalQueued, 'ordinary backlog is bounded');
  const overflow = await f.client.request('test/read', { i: 'overflow' }).catch(error => error) as { code: number };
  assertEqual(overflow.code, -32000, 'excess ordinary work is refused rather than retained');
  pending.push(f.client.request('turn/start', { sessionId: 'human' }).catch(error => error));
  pending.push(f.client.request('turn/interrupt', { sessionId: 'human' }).catch(error => error));
  assertEqual(requests(f).length, 6, 'critical traffic still owns its reserved in-flight slot');
  assertEqual(f.client.schedulingStats().queued, 449, 'critical traffic can queue beyond the ordinary bound');
  f.client.close(); await Promise.all(pending);
});

h.test('scheduler captures queued request parameters and never reuses pre-mutation reads', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) pending.push(f.client.request('test/block', { i }).catch(error => error));
  const params = { sessionId: 'original', nested: { value: 'saved' } };
  pending.push(f.client.request('session/history', params).catch(error => error));
  params.sessionId = 'changed'; params.nested.value = 'changed';
  f.reply(requests(f)[0]!.id, {});
  await waitFor(() => requests(f).length === 6, 1000, 'queued request was dispatched');
  assertDeepEqual(requests(f)[5]?.params, { sessionId: 'original', nested: { value: 'saved' } }, 'queued wire input is immutable');
  pending.push(f.client.request('turn/start', { sessionId: 'original', input: 'new' }).catch(error => error));
  pending.push(f.client.request('session/history', { sessionId: 'original', nested: { value: 'saved' } }).catch(error => error));
  assertEqual(f.client.schedulingStats().consumers, 7, 'post-mutation read remains a separate consumer');
  assertEqual(f.client.schedulingStats().queued, 1, 'a read after a mutation cannot join an older read');
  f.client.close(); await Promise.all(pending);
});

h.test('scheduler bounds retained request bytes and preserves capacity for image-bearing turns', async () => {
  const scheduler = new RpcRequestScheduler(), pending: Promise<unknown>[] = [];
  const blocked = () => new Promise<unknown>(() => {});
  const add = (method: string, priority: 'interactive' | 'critical', bytes: number) => scheduler.schedule({ method, priority, bytes }, blocked).catch(error => error);
  pending.push(add('read', 'interactive', 96 * 1024 * 1024));
  const ordinaryOverflow = await add('read', 'interactive', 1) as { code: number };
  assertEqual(ordinaryOverflow.code, -32000, 'ordinary data cannot retain the image-send reserve');
  pending.push(add('turn/start', 'critical', 32 * 1024 * 1024));
  assertEqual(scheduler.stats().running, 2, 'an image-bearing critical operation still enters');
  const totalOverflow = await add('turn/start', 'critical', 1) as { code: number };
  assertEqual(totalOverflow.code, -32000, 'total retained bytes are bounded');
  scheduler.close(); await Promise.all(pending);
});

h.test('atomic side-task start retains foreground admission while history reads are blocked', async () => {
  const f = fakeEngine(), pending: Promise<unknown>[] = [];
  for (let index = 0; index < schedulerVector.noncritical; index++) pending.push(f.client.request('test/block', { index }).catch(error => error));
  pending.push(f.client.request('session/startSideTask', { parentThreadId: 'parent', init: { threadId: 'side' } }).catch(error => error));
  assertEqual(requests(f).length, schedulerVector.total, 'side creation owns the reserved critical slot');
  assertEqual(requests(f).at(-1)?.method, 'session/startSideTask', 'the foreground create is dispatched before slow reads settle');
  f.client.close(); await Promise.all(pending);
});

// -----------------------------------------------------------------------------
// Item 2: framing
// -----------------------------------------------------------------------------

h.test('framing: one frame split across two chunks', async () => {
  const lines: string[] = [];
  const framer = new NdjsonFramer((line) => lines.push(line));
  framer.push(Buffer.from('{"id":1,"res', 'utf8'));
  assertEqual(lines.length, 0, 'no frame emitted before the newline arrives');
  framer.push(Buffer.from('ult":"ok"}\n', 'utf8'));
  assertEqual(lines.length, 1, 'frame emitted once complete');
  assertEqual(lines[0], '{"id":1,"result":"ok"}', 'frame content');
});

h.test('framing: several frames in one chunk, in wire order', async () => {
  const lines: string[] = [];
  const framer = new NdjsonFramer((line) => lines.push(line));
  framer.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n', 'utf8'));
  assertDeepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'], 'all three frames, in order');
  assertEqual(framer.frames, 3, 'frame counter');
});

h.test('framing: multi-byte UTF-8 split across a chunk boundary', async () => {
  // The hazard `buf.toString()` per chunk would cause: a 3-byte CJK character cut
  // in half decodes to U+FFFD on both sides. This is the case the addon slice's
  // UTF-8 decoder tests pinned for the napi path.
  const text = '{"msg":"计划方案"}\n';
  const full = Buffer.from(text, 'utf8');
  // Split inside the first CJK character (byte 9 of the value).
  const cut = full.indexOf('计');
  assert(cut > 0, 'found the CJK character boundary');
  const lines: string[] = [];
  const framer = new NdjsonFramer((line) => lines.push(line));
  framer.push(full.subarray(0, cut + 1)); // first byte of a 3-byte character
  framer.push(full.subarray(cut + 1));
  assertEqual(lines.length, 1, 'one frame');
  assertEqual(lines[0], '{"msg":"计划方案"}', 'no U+FFFD corruption');
  assert(!lines[0]?.includes('\uFFFD'), 'replacement character must not appear');
  assertDeepEqual(JSON.parse(lines[0] as string), { msg: '计划方案' }, 'round-trips');
});

h.test('framing: a 4-byte emoji split across a chunk boundary', async () => {
  const text = '{"m":"\u{1F600}\u{1F680}"}\n';
  const full = Buffer.from(text, 'utf8');
  const cut = full.indexOf('😀');
  const lines: string[] = [];
  const framer = new NdjsonFramer((line) => lines.push(line));
  framer.push(full.subarray(0, cut + 2)); // two bytes of a 4-byte character
  framer.push(full.subarray(cut + 2));
  assertEqual(lines[0], '{"m":"\u{1F600}\u{1F680}"}', 'emoji intact');
});

h.test('framing: large message buffered until its newline (8 MiB)', async () => {
  const big = 'x'.repeat(8 * 1024 * 1024);
  const lines: string[] = [];
  const framer = new NdjsonFramer((line) => lines.push(line));
  // Feed it in 64 KiB chunks, the way a real pipe delivers a large tool result.
  const payload = Buffer.from(`{"blob":"${big}"}\n`, 'utf8');
  for (let offset = 0; offset < payload.length; offset += 65_536) {
    framer.push(payload.subarray(offset, offset + 65_536));
  }
  assertEqual(lines.length, 1, 'one frame despite 128 chunks');
  assertEqual(JSON.parse(lines[0] as string).blob.length, big.length, 'no truncation');
});

h.test('framing: a 96 MiB frame stays linear in chunk count', async () => {
  // The shape that exposed the quadratic framing cost: one history reply whose
  // single line is ~90 MB of base64, delivered the way a pipe delivers it. The
  // old accumulate-and-rescan buffer spent ~8 s of CPU re-copying that line per
  // chunk; an incremental reader must stay near the payload size, so the CPU
  // budget below is ~30x the measured linear cost and ~4x under the quadratic
  // one -- a regression to rescanning fails here instead of in production.
  const big = 'x'.repeat(96 * 1024 * 1024);
  const lines: string[] = [];
  const framer = new NdjsonFramer((line) => lines.push(line));
  const payload = Buffer.from(`{"blob":"${big}"}\n`, 'utf8');
  const cpu = process.cpuUsage();
  for (let offset = 0; offset < payload.length; offset += 65_536) {
    framer.push(payload.subarray(offset, offset + 65_536));
  }
  const used = process.cpuUsage(cpu);
  const cpuMs = (used.user + used.system) / 1000;
  assertEqual(lines.length, 1, 'one frame despite 1536 chunks');
  assertEqual(JSON.parse(lines[0] as string).blob.length, big.length, 'no truncation');
  assert(cpuMs < 2500, `framing a 96 MiB line cost ${cpuMs.toFixed(0)} ms CPU, expected linear`);
});

h.test('framing: CRLF line endings decode identically', async () => {
  const lines: string[] = [];
  const framer = new NdjsonFramer((line) => lines.push(line));
  framer.push(Buffer.from('{"a":1}\r\n{"b":2}\r\n', 'utf8'));
  assertDeepEqual(lines, ['{"a":1}', '{"b":2}'], 'trailing \\r stripped, matching tokio lines()');
});

h.test('framing: blank and whitespace-only lines are skipped, not reported', async () => {
  const lines: string[] = [];
  const framer = new NdjsonFramer((line) => lines.push(line));
  framer.push(Buffer.from('\n\n   \n{"a":1}\n\n', 'utf8'));
  assertDeepEqual(lines, ['{"a":1}'], 'only the real frame (rpc.rs:227-229)');
});

h.test('framing: a final frame with no trailing newline is delivered on EOF', async () => {
  const lines: string[] = [];
  const framer = new NdjsonFramer((line) => lines.push(line));
  framer.push(Buffer.from('{"a":1}\n{"b":2}', 'utf8'));
  assertEqual(lines.length, 1, 'the unterminated frame is still buffered');
  framer.end();
  assertDeepEqual(lines, ['{"a":1}', '{"b":2}'], 'flushed at EOF, not lost');
});

h.test('framing: error frames are reported, not silently dropped', async () => {
  const { client, clientEvents, engineWrite } = fakeEngine();
  engineWrite('not json at all\n');
  engineWrite('[1,2,3]\n');
  engineWrite('42\n');
  engineWrite('{"id":1,"result":null}\n');
  await sleep(10);
  const protocolErrors = clientEvents.filter((e) => (e as { type: string }).type === 'protocolError');
  assertEqual(protocolErrors.length, 3, 'three unparseable frames reported');
  assertDeepEqual(
    (protocolErrors[0] as { line: string }).line,
    'not json at all',
    'the raw line is carried so the failure is readable',
  );
  assertEqual(parseFrame('{"a":1}').ok, true, 'a valid frame still parses');
  assertEqual(parseFrame('nope').ok, false, 'invalid JSON is rejected');
  assertEqual(parseFrame('[1]').ok, false, 'a JSON array is not an object');
  client.close();
});

h.test('framing: a stray line on stdout does not abort a healthy request', async () => {
  // The reader REPORTS the bad frame; the pump DROPS it (main.rs spawn_event_pump).
  // That split is what keeps one malformed line from killing an in-flight turn.
  const { client, reply, engineWrite } = fakeEngine();
  const pending = client.request('session/history', {});
  engineWrite('garbage from a subprocess sharing stdout\n');
  reply(1, { ok: true });
  assertDeepEqual(await pending, { ok: true }, 'the request still resolves');
  client.close();
});

// -----------------------------------------------------------------------------
// Item 3: request ids, pending map, timeout, cancel, reverse requests
// -----------------------------------------------------------------------------

h.test('request ids start at 1 and increase by one (rpc.rs:174,:358)', async () => {
  const { client, sentFrames, reply } = fakeEngine();
  const first = client.request('a', {});
  const second = client.request('b', {});
  await sleep(10);
  const frames = sentFrames() as Array<{ id: number; method: string }>;
  assertEqual(frames.length, 2, 'two frames written');
  assertEqual(frames[0]?.id, 1, 'first id is 1, not 0');
  assertEqual(frames[1]?.id, 2, 'ids increase by one');
  assertEqual(frames[0]?.method, 'a', 'method on the wire');
  reply(1, 'one');
  reply(2, 'two');
  assertEqual(await first, 'one', 'first resolves');
  assertEqual(await second, 'two', 'second resolves');
  client.close();
});

h.test('a request is registered before it is written (rpc.rs:359-368)', async () => {
  // The ordering matters: a close that lands while the write is in flight must still
  // find the pending entry and reject it, rather than stranding the caller forever.
  const { client, sent, toEngineClose } = (() => {
    const fake = fakeEngine();
    return { ...fake, toEngineClose: () => fake.endFromEngine() };
  })();
  const pending = client.request('session/history', {});
  // Close synchronously, before the write callback can run.
  client.close('test closed mid-write');
  const error = (await assertRejects(() => pending, 'closed mid-write must reject')) as { kind: string };
  assertEqual(error.kind, 'closed', 'rejected as closed, not left hanging');
  assertEqual(sent.length > 0, true, 'the frame was still attempted');
});

h.test('pending map: a response with an unknown id is ignored, not applied', async () => {
  const { client, reply, clientEvents } = fakeEngine();
  reply(999, { unexpected: true });
  await sleep(10);
  assertEqual(clientEvents.length, 0, 'no event, no throw (rpc.rs:420-435)');
  client.close();
});

h.test('pending map: a non-integer response id is ignored (rpc.rs:420-422)', async () => {
  const { client, engineWrite, clientEvents } = fakeEngine();
  engineWrite('{"id":"1","result":{}}\n');
  engineWrite('{"id":1.5,"result":{}}\n');
  engineWrite('{"id":null,"result":{}}\n');
  await sleep(10);
  assertEqual(clientEvents.length, 0, 'string, fractional and null ids never match');
  assertEqual(client.stats().pending, 0, 'nothing was pending anyway');
  client.close();
});

h.test('a server error reply carries the engine code and message', async () => {
  const { client, replyError } = fakeEngine();
  const pending = client.request('session/start', {});
  replyError(1, -32601, 'method not found');
  const error = (await assertRejects(() => pending, 'server error must reject')) as {
    kind: string;
    code: number;
    message: string;
  };
  assertEqual(error.kind, 'server', 'kind is server, not closed');
  assertEqual(error.code, -32601, 'the engine code is preserved');
  assertEqual(error.message, 'method not found', 'the engine message is preserved');
  client.close();
});

h.test('server conflict details survive the framed client transport', async () => {
  const { client, engineWrite } = fakeEngine();
  const pending = client.request('session/setGoal', { threadId: 'thread' });
  const detail = { code: 'GOAL_CONFLICT', feature: 'goal' };
  engineWrite(JSON.stringify({ id: 1, error: { code: -32000, message: 'Goal revision conflict', data: detail } }) + '\n');
  const error = await assertRejects(() => pending, 'the named mutation was refused') as { data?: unknown };
  assertDeepEqual(error.data, detail, 'a definitive rejection remains distinct from a lost acknowledgement');
  client.close();
});

h.test('timeout: requestWithTimeout rejects and names the method', async () => {
  const { client, reply } = fakeEngine();
  const error = (await assertRejects(
    () => client.requestWithTimeout('session/history', {}, 40),
    'an unanswered request must time out',
  )) as { kind: string; method: string };
  assertEqual(error.kind, 'timeout', 'timeout kind');
  assertEqual(error.method, 'session/history', 'method named for diagnostics');
  assertEqual(client.stats().pending, 0, 'expired request released without closing the connection');
  const next = client.request('session/history', {});
  reply(1, { late: true });
  reply(2, { current: true });
  assertDeepEqual(await next, { current: true }, 'a late response cannot settle the next request');
  client.close();
});

h.test('timeout: a reply that arrives before the deadline wins', async () => {
  const { client, reply } = fakeEngine();
  const pending = client.requestWithTimeout('session/history', {}, 500);
  reply(1, { fast: true });
  assertDeepEqual(await pending, { fast: true }, 'resolved by the reply, not the timer');
  client.close();
});

h.test('cancel: close() ends every pending request at once (reject_all_pending)', async () => {
  const { client } = fakeEngine();
  const requests = [
    client.request('a', {}),
    client.request('b', {}),
    client.request('c', {}),
  ];
  await sleep(5);
  assertEqual(client.stats().pending, 3, 'three in flight');
  client.close('test cancel');
  const errors = await Promise.all(
    requests.map((r) => r.catch((error: { kind: string }) => error.kind)),
  );
  assertDeepEqual(errors, ['closed', 'closed', 'closed'], 'all three failed at once');
  assertEqual(client.stats().pending, 0, 'pending map drained');
});

h.test('cancel: EOF ends every pending request at once', async () => {
  const { client, endFromEngine } = fakeEngine();
  const requests = [client.request('a', {}), client.request('b', {})];
  await sleep(5);
  endFromEngine(); // engine closed stdout -> EOF
  const errors = await Promise.all(
    requests.map((r) => r.catch((error: { kind: string }) => error.kind)),
  );
  assertDeepEqual(errors, ['closed', 'closed'], 'both failed on EOF');
  assertEqual(client.isClosed(), true, 'client is closed after EOF');
  assert(client.getCloseReason()?.includes('stream closed'), 'close reason recorded');
});

h.test('streamClosed is emitted exactly once on EOF', async () => {
  const { client, endFromEngine, clientEvents } = fakeEngine();
  endFromEngine();
  await sleep(10);
  endFromEngine(); // a second end must not produce a second event
  await sleep(10);
  const closed = clientEvents.filter((e) => (e as { type: string }).type === 'streamClosed');
  assertEqual(closed.length, 1, 'one streamClosed event');
});

h.test('a request issued after close rejects immediately', async () => {
  const { client } = fakeEngine();
  client.close();
  const error = (await assertRejects(() => client.request('a', {}), 'closed client must reject')) as {
    kind: string;
  };
  assertEqual(error.kind, 'closed', 'rejected without touching the wire');
});

h.test('close reason is first-wins (rpc.rs:349-355)', async () => {
  const { client } = fakeEngine();
  client.close('first reason');
  client.close('second reason');
  assertEqual(client.getCloseReason(), 'first reason', 'the first reason is kept');
});

// -----------------------------------------------------------------------------
// Reverse requests: the approval / elicitation round trip
// -----------------------------------------------------------------------------

h.test('reverse request: reply is wrapped as {id, result:{response}} (rpc.rs:103-105)', async () => {
  const { client, reverseRequest, lastFrame } = fakeEngine();
  let seen: { method: string; params: unknown } | undefined;
  client.on('event', (event) => {
    const e = event as { type: string; request?: { method: string; params: unknown } };
    if (e.type === 'reverseRequest' && e.request) seen = { method: e.request.method, params: e.request.params };
  });
  reverseRequest(7, 'approval/request', { sessionId: 's1', request: { id: 'r1' } });
  await waitFor(() => seen !== undefined, 500, 'reverse request delivered');
  assertEqual(seen?.method, 'approval/request', 'method');
  assertDeepEqual(seen?.params, { sessionId: 's1', request: { id: 'r1' } }, 'params');

  const events = (client as unknown as { reverse: Map<unknown, { respond: (v: unknown) => Promise<void> }> }).reverse;
  const request = [...events.values()][0];
  assert(request, 'reverse request tracked');
  await request!.respond({ decision: 'allow' });

  // The wrapping is the contract detail most likely to be lost: the engine reads
  // `result.response`, so a bare `result` would silently deny.
  assertDeepEqual(lastFrame(), { id: 7, result: { response: { decision: 'allow' } } }, 'wrapped reply');
  client.close();
});

h.test('reverse request: a second answer is a no-op (rpc.rs:91,:102)', async () => {
  const { client, reverseRequest, sentFrames } = fakeEngine();
  let captured: { respond: (v: unknown) => Promise<void> } | undefined;
  client.on('event', (event) => {
    const e = event as { type: string; request?: { respond: (v: unknown) => Promise<void> } };
    if (e.type === 'reverseRequest') captured = e.request;
  });
  reverseRequest(7, 'approval/request', {});
  await waitFor(() => captured !== undefined, 500, 'reverse request delivered');
  await captured!.respond({ decision: 'allow' });
  await captured!.respond({ decision: 'deny' }); // must be ignored
  const frames = sentFrames() as Array<{ id: number; result: { response: { decision: string } } }>;
  assertEqual(frames.length, 1, 'exactly one reply written');
  assertEqual(frames[0]?.result.response.decision, 'allow', 'the first answer stands');
  client.close();
});

h.test('reverse request: respondError writes {id, error:{code,message}}', async () => {
  const { client, reverseRequest, lastFrame } = fakeEngine();
  let captured: { respondError: (c: number, m: string) => Promise<void> } | undefined;
  client.on('event', (event) => {
    const e = event as { type: string; request?: { respondError: (c: number, m: string) => Promise<void> } };
    if (e.type === 'reverseRequest') captured = e.request;
  });
  reverseRequest(9, 'elicitation/request', {});
  await waitFor(() => captured !== undefined, 500, 'reverse request delivered');
  await captured!.respondError(-32001, 'user cancelled');
  assertDeepEqual(lastFrame(), { id: 9, error: { code: -32001, message: 'user cancelled' } }, 'error frame');
  client.close();
});

h.test('an unanswered reverse request is failed with -32000 (Responder::drop)', async () => {
  // TypeScript has no Drop, so this is the explicit replacement for rpc.rs:117-134.
  // The engine fails closed on an error reply (deny/decline), which is why sending
  // -32000 is safe and hanging is not.
  const { client, reverseRequest, sentFrames, lastFrame } = fakeEngine();
  reverseRequest(11, 'approval/request', { sessionId: 's1' });
  reverseRequest(12, 'elicitation/request', { sessionId: 's1' });
  await waitFor(() => client.stats().reverse === 2, 500, 'both tracked as outstanding');
  assertEqual(client.outstandingReverseRequests().length, 2, 'two outstanding');
  const retained = client.outstandingReverseRequests();
  const sent = await client.failOutstandingReverseRequests();
  assertEqual(sent, 2, 'both were answered');
  const frames = sentFrames() as Array<{ id: number; error: { code: number; message: string } }>;
  assertEqual(frames.length, 2, 'two error frames written');
  assertEqual(frames[0]?.error.code, REVERSE_REQUEST_DROPPED_CODE, '-32000');
  assertEqual(frames[0]?.id, 11, 'matched to the right request id');
  assertEqual(frames[1]?.id, 12, 'second id too');
  assertDeepEqual(lastFrame(), frames[1], 'last frame is the second reply');
  assertEqual(client.outstandingReverseRequests().length, 0, 'none left outstanding');
  await retained[0]!.respond({ decision: 'allow' });
  assertEqual(sentFrames().length, 2, 'a late UI answer cannot reply again after host cancellation');
  client.close();
});

h.test('an already-answered reverse request is not failed again on close', async () => {
  const { client, reverseRequest, sentFrames } = fakeEngine();
  let captured: { respond: (v: unknown) => Promise<void> } | undefined;
  client.on('event', (event) => {
    const e = event as { type: string; request?: { respond: (v: unknown) => Promise<void> } };
    if (e.type === 'reverseRequest') captured = e.request;
  });
  reverseRequest(13, 'approval/request', {});
  await waitFor(() => captured !== undefined, 500, 'delivered');
  await captured!.respond({ decision: 'allow' });
  assertEqual(await client.failOutstandingReverseRequests(), 0, 'nothing outstanding to fail');
  assertEqual((sentFrames() as unknown[]).length, 1, 'still exactly one reply');
  client.close();
});

h.test('failing reverse requests after close writes nothing (stdin already gone)', async () => {
  const { client, reverseRequest, sentFrames } = fakeEngine();
  reverseRequest(14, 'approval/request', {});
  await waitFor(() => client.stats().reverse === 1, 500, 'tracked');
  client.close('closed first');
  const sent = await client.failOutstandingReverseRequests();
  assertEqual(sent, 0, 'no reply could be written');
  assertEqual((sentFrames() as unknown[]).length, 0, 'nothing on the wire');
  assertEqual(client.outstandingReverseRequests().length, 0, 'set is cleared regardless');
});

// -----------------------------------------------------------------------------
// Four-way classification (rpc.rs:387-444)
// -----------------------------------------------------------------------------

h.test('classification: the (has method, has non-null id) discriminator', async () => {
  assertEqual(classify({ method: 'approval/request', id: 3 }).kind, 'reverseRequest', 'method + id');
  assertEqual(classify({ method: 'session/event', params: {} }).kind, 'notification', 'method, no id');
  assertEqual(classify({ id: 3, result: null }).kind, 'response', 'no method, id');
  assertEqual(classify({ id: 3, error: { code: -1, message: 'x' } }).kind, 'response', 'error response');
  assertEqual(classify({}).kind, 'ignored', 'neither');
  assertEqual(classify({ method: 'a', id: null }).kind, 'notification', 'a null id is not an id (rpc.rs:388)');
  assertEqual(classify(null).kind, 'ignored', 'null');
  assertEqual(classify([1, 2]).kind, 'ignored', 'array');
  assertEqual(classify('text').kind, 'ignored', 'scalar');
});

h.test('classification: missing params become null, matching the Rust unwrap_or', async () => {
  assertDeepEqual(classify({ method: 'turn/started' }), { kind: 'notification', method: 'turn/started', params: null }, 'no params key');
  assertDeepEqual(
    classify({ method: 'approval/request', id: 1 }),
    { kind: 'reverseRequest', method: 'approval/request', params: null, id: 1 },
    'reverse request with no params',
  );
});

h.test('notification mapping: the five named methods and the productEvent catch-all', async () => {
  assertEqual(notificationToEvent('session/event', { a: 1 }).type, 'sessionEvent', 'session/event');
  assertEqual(notificationToEvent('session/rawEvent', {}).type, 'rawSessionEvent', 'session/rawEvent');
  assertEqual(notificationToEvent('turn/completed', {}).type, 'turnCompleted', 'turn/completed');
  assertEqual(notificationToEvent('thread/deleted', {}).type, 'threadDeleted', 'thread/deleted');
  assertEqual(notificationToEvent('thread/started', {}).type, 'productEvent', 'thread/started');
  assertEqual(notificationToEvent('turn/started', {}).type, 'productEvent', 'turn/started');
  assertEqual(notificationToEvent('item/completed', {}).type, 'productEvent', 'item/completed');
  assertEqual(notificationToEvent('taskList/changed', {}).type, 'productEvent', 'taskList/changed');
  assertEqual(notificationToEvent('brand/newMethod', {}).type, 'productEvent', 'an unknown method is still delivered');
});

h.test('the exported SPECIAL_NOTIFICATIONS list matches the actual switch behaviour', async () => {
  // The live test compares SPECIAL_NOTIFICATIONS against the engine's own schema
  // bundle. That comparison is only meaningful if the list matches what
  // `notificationToEvent` actually does — otherwise a renamed switch arm could pass
  // the bundle comparison while the port disagreed with itself. This pins the two
  // together, so the list cannot be edited without editing the behaviour (or vice
  // versa) and getting caught here.
  assertDeepEqual(
    [...SPECIAL_NOTIFICATIONS].sort(),
    Object.keys(SPECIAL_NOTIFICATION_EVENT_TYPES).sort(),
    'the two exported lists name the same five methods',
  );
  for (const method of SPECIAL_NOTIFICATIONS) {
    const event = notificationToEvent(method, {});
    assertEqual(
      event.type,
      SPECIAL_NOTIFICATION_EVENT_TYPES[method],
      `${method} really produces ${SPECIAL_NOTIFICATION_EVENT_TYPES[method]}`,
    );
    assert(event.type !== 'productEvent', `${method} must not fold into the catch-all`);
  }
  // And nothing outside the list gets special treatment, so the catch-all is total.
  for (const other of ['thread/started', 'turn/started', 'item/completed', 'taskList/changed', 'item/reasoning/delta']) {
    assert(!SPECIAL_NOTIFICATIONS.includes(other), `${other} is not in the special list`);
    assertEqual(notificationToEvent(other, {}).type, 'productEvent', `${other} folds into productEvent`);
  }
});

h.test('REVERSE_REQUEST_METHODS are the two names classify() treats as reverse requests', async () => {
  // Same self-consistency argument: the live test asserts the engine's
  // `serverRequests` set equals REVERSE_REQUEST_METHODS, because an unhandled
  // reverse request is answered -32000 by the drop path — silently denied. That is
  // only a real guarantee if the list matches what `classify()` actually routes.
  assertEqual(REVERSE_REQUEST_METHODS.length, 2, 'exactly two reverse requests exist');
  for (const method of REVERSE_REQUEST_METHODS) {
    assertEqual(
      classify({ id: 7, method, params: {} }).kind,
      'reverseRequest',
      `${method} is classified as a reverse request when it carries an id`,
    );
    // Without an id the same name is a notification, per rpc.rs:389-390: a reverse
    // request is distinguished by HAS_ID, not by its name.
    assertEqual(
      classify({ method, params: {} }).kind,
      'notification',
      `${method} without an id is a notification, because the reverse-request test is has_id`,
    );
  }
});

h.test('engine/event is unwrapped one level to params.event (rpc.rs:411-413)', async () => {
  const event = notificationToEvent('engine/event', { event: { type: 'inner' }, other: 1 });
  assertEqual(event.type, 'engineEvent', 'engineEvent variant');
  assertDeepEqual((event as { params: unknown }).params, { type: 'inner' }, 'unwrapped, not the whole params');
  assertDeepEqual(
    (notificationToEvent('engine/event', {}) as { params: unknown }).params,
    null,
    'missing event becomes null',
  );
});

h.test('a live notification stream is decoded into the right variants in order', async () => {
  const { client, notify, engineWrite, clientEvents } = fakeEngine();
  notify('session/event', { n: 1 });
  notify('engine/event', { event: { n: 2 } });
  notify('turn/completed', { n: 3 });
  engineWrite('{"method":"item/completed","params":{"n":4}}\n');
  await waitFor(() => clientEvents.length >= 4, 500, 'all four delivered');
  assertDeepEqual(
    clientEvents.map((e) => (e as { type: string }).type),
    ['sessionEvent', 'engineEvent', 'turnCompleted', 'productEvent'],
    'wire order preserved',
  );
  client.close();
});

// -----------------------------------------------------------------------------
// Writer: backpressure and write failure
// -----------------------------------------------------------------------------

h.test('write failure closes the connection and fails pending requests', async () => {
  // A broken pipe is how an engine that already exited presents. The client owns
  // the writer, so it owns the stream's error path: an unhandled 'error' event
  // would crash the whole host process, which is far worse than losing one request.
  const toEngine = new PassThrough();
  const client = new AppServerClient(toEngine, 'failing-writer');
  toEngine.destroy(Object.assign(new Error('EPIPE: broken pipe'), { code: 'EPIPE' }));
  const pending = client.request('session/history', {});
  const error = (await assertRejects(() => pending, 'a broken pipe must fail the request')) as {
    kind: string;
  };
  assertEqual(error.kind, 'closed', 'failed as closed');
  await waitFor(() => client.isClosed(), 500, 'connection closed');
  assert(
    client.getCloseReason()?.includes('EPIPE') || client.getCloseReason()?.includes('write failed') || client.getCloseReason()?.includes('stdin error'),
    `reason names the failure, got: ${client.getCloseReason()}`,
  );
});

h.test('backpressure does not drop a frame', async () => {
  // A full PassThrough returns false from write(); the client must wait for drain
  // rather than discard the frame, matching the Rust writer task awaiting its channel.
  const toEngine = new PassThrough({ highWaterMark: 16 });
  const client = new AppServerClient(toEngine, 'backpressure');
  const drained: string[] = [];
  let reading = false;
  toEngine.on('data', (chunk: Buffer) => {
    drained.push(chunk.toString('utf8'));
    reading = true;
  });
  const big = 'y'.repeat(4096);
  const writes = [client.notify('a', big), client.notify('b', big), client.notify('c', big)];
  await Promise.all(writes);
  await sleep(50);
  const joined = drained.join('');
  assertEqual((joined.match(/\n/g) ?? []).length, 3, 'all three frames written despite backpressure');
  assert(joined.includes('"method":"c"'), 'the last frame is present');
  assert(reading, 'the stream was consumed');
  client.close();
});

h.test('notify sends no id on the wire (rpc.rs:375-378)', async () => {
  const { client, sentFrames } = fakeEngine();
  await client.notify('initialized', {});
  const frame = (sentFrames() as Array<Record<string, unknown>>)[0];
  assertEqual(frame?.method, 'initialized', 'method present');
  assertEqual('id' in (frame ?? {}), false, 'no id — it is a notification, not a request');
  client.close();
});

// -----------------------------------------------------------------------------
// Spawn key (item 1: 按实际 spawn key 共享/隔离引擎)
// -----------------------------------------------------------------------------

h.test('spawn key: identical options produce an identical key', async () => {
  const opts = { command: '/bin/engine', args: [], cwd: '/tmp/a', env: [['K', 'v']] as Array<[string, string]> };
  assertEqual(spawnKey(opts), spawnKey({ ...opts, env: [['K', 'v']] }), 'same key');
});

h.test('spawn key: env order does not change the key (it is sorted)', async () => {
  const a = { command: '/e', args: [], env: [['A', '1'], ['B', '2']] as Array<[string, string]> };
  const b = { command: '/e', args: [], env: [['B', '2'], ['A', '1']] as Array<[string, string]> };
  assertEqual(spawnKey(a), spawnKey(b), 'sorted env gives one shared process');
});

h.test('spawn key: every differing field splits the key', async () => {
  const base = { command: '/e', args: ['x'], cwd: '/c', env: [['A', '1']] as Array<[string, string]> };
  const keys = {
    base: spawnKey(base),
    command: spawnKey({ ...base, command: '/other' }),
    args: spawnKey({ ...base, args: ['y'] }),
    cwd: spawnKey({ ...base, cwd: '/d' }),
    envKey: spawnKey({ ...base, env: [['B', '1']] }),
    envValue: spawnKey({ ...base, env: [['A', '2']] }),
  };
  const unique = new Set(Object.values(keys));
  assertEqual(unique.size, 6, 'all six configurations are distinct');
});

h.test('spawn key: arg boundaries cannot collide (["ab"] vs ["a","b"])', async () => {
  const one = { command: '/e', args: ['ab'], env: [] as Array<[string, string]> };
  const two = { command: '/e', args: ['a', 'b'], env: [] as Array<[string, string]> };
  assert(spawnKey(one) !== spawnKey(two), 'the NUL separator keeps them apart');
});

h.test('spawn key: a unicode command and cwd are hashed as utf8', async () => {
  const k = spawnKey({ command: '/引擎/klaus', args: ['--x'], cwd: '/tmp/目录 一', env: [] });
  assertEqual(k.length, 64, 'sha256 hex length');
  assertEqual(k, spawnKey({ command: '/引擎/klaus', args: ['--x'], cwd: '/tmp/目录 一', env: [] }), 'stable');
});

h.test('inheritedEnv: a redirected config dir also redirects plugin home and session dir', async () => {
  const env = inheritedEnv({
    HOME: '/Users/tester',
    KLAUS_CONFIG_DIR: '/tmp/profile',
  } as NodeJS.ProcessEnv);
  const map = new Map(env);
  assertEqual(map.get('KLAUS_CONFIG_DIR'), '/tmp/profile', 'config dir kept');
  assertEqual(map.get('KLAUS_PLUGIN_HOME'), '/tmp/profile/plugins', 'plugin home follows');
  assertEqual(map.get('KLAUS_SESSION_DIR'), '/tmp/profile/sessions', 'session dir follows');
});

h.test('inheritedEnv: KLAUS_SESSION_DIR is the state that does NOT follow the config dir', async () => {
  // The one override that must win: the engine otherwise writes rollouts to
  // $HOME/.klaus/sessions, so a redirected profile would leak sessions into the
  // user's real profile (pool.rs:68-84).
  const env = inheritedEnv({
    HOME: '/Users/tester',
    KLAUS_CONFIG_DIR: '/tmp/profile',
    KLAUS_SESSION_DIR: '/tmp/elsewhere/sessions',
  } as NodeJS.ProcessEnv);
  const sessions = env.filter(([k]) => k === 'KLAUS_SESSION_DIR');
  assertEqual(sessions.length, 1, 'exactly one entry, not duplicated');
  assertEqual(sessions[0]?.[1], '/tmp/elsewhere/sessions', 'the explicit override wins');
});

h.test('inheritedEnv: no config override injects nothing', async () => {
  const env = inheritedEnv({ HOME: '/Users/tester', PATH: '/usr/bin' } as NodeJS.ProcessEnv);
  const map = new Map(env);
  assertEqual(map.has('KLAUS_PLUGIN_HOME'), false, 'no plugin home injected');
  assertEqual(map.has('KLAUS_SESSION_DIR'), false, 'no session dir injected');
  assertEqual(map.get('PATH'), '/usr/bin', 'the rest of the environment passes through');
});

h.test('inheritedEnv: an existing KLAUS_PLUGIN_HOME is not overwritten', async () => {
  const env = inheritedEnv({
    HOME: '/Users/tester',
    KLAUS_CONFIG_DIR: '/tmp/profile',
    KLAUS_PLUGIN_HOME: '/custom/plugins',
  } as NodeJS.ProcessEnv);
  const plugins = env.filter(([k]) => k === 'KLAUS_PLUGIN_HOME');
  assertEqual(plugins.length, 1, 'not duplicated');
  assertEqual(plugins[0]?.[1], '/custom/plugins', 'the caller value wins');
});

h.test('expandHomePrefix: ~ and ~/ are expanded, other values pass through', async () => {
  // Exhaustive coverage of this rule — including its platform-dependent separator set and
  // the "no home" case — lives in tests/services.test.ts, which imports the shared
  // implementation from main/paths.ts. What is pinned here is narrower and specific to this
  // module: that inheritedEnv hands the engine an EXPANDED config dir rather than a literal
  // "~/...", since the engine child resolves that string against its own cwd.
  assertEqual(expandHomePrefix('~', '/Users/t'), '/Users/t', 'bare ~');
  assertEqual(expandHomePrefix('~/x', '/Users/t'), '/Users/t/x', '~/x');
  assertEqual(expandHomePrefix('/abs', '/Users/t'), '/abs', 'absolute unchanged');
  // lib.rs:24 is `home.map(...)`, so no home yields None — NOT the literal value. Echoing
  // "~/x" would make the engine open a directory named "~" under its cwd and report no
  // problem doing it.
  assertEqual(expandHomePrefix('~/x', undefined), undefined, 'no home available: None');
});

h.test('inheritedEnv: HOME is resolved from USERPROFILE on Windows', async () => {
  // A FORWARD slash is used deliberately. expand_home_prefix's separator set is
  // platform-dependent (a backslash is an ordinary character in a POSIX file name), so a
  // `~\` value only expands on Windows — writing it here would make this test assert
  // Windows behaviour while running on macOS, and pass on one and fail on the other. What
  // this test is about is the HOME RESOLUTION ORDER (USERPROFILE as the second candidate,
  // main.rs:3163-3164 / pool.rs:45), which a forward slash exercises identically on every
  // platform.
  const env = inheritedEnv({
    USERPROFILE: 'C:\\Users\\t',
    KLAUS_CONFIG_DIR: '~/.klaus',
  } as NodeJS.ProcessEnv);
  assertEqual(new Map(env).get('KLAUS_CONFIG_DIR'), 'C:\\Users\\t\\.klaus', 'expanded via USERPROFILE');
  // The join preserves the home's separator convention rather than normalising to POSIX,
  // because the value goes into an environment variable and into spawnKey.
  assert(!new Map(env).get('KLAUS_CONFIG_DIR')?.includes('/'), 'and keeps windows separators');
});

h.test('inheritedEnv: HOMEDRIVE+HOMEPATH is the last-resort home', async () => {
  const env = inheritedEnv({
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\t',
    KLAUS_CONFIG_DIR: '~/cfg',
  } as NodeJS.ProcessEnv);
  assertEqual(new Map(env).get('KLAUS_CONFIG_DIR'), 'C:\\Users\\t\\cfg', 'expanded via drive+path');
});

h.test('inheritedEnv: an unexpandable override injects nothing', async () => {
  // pool.rs:53-58 chains `.and_then(expand_home_prefix)`, so when expansion yields None the
  // config is None and NEITHER the variable nor the derived plugin/session dirs are
  // injected — the engine keeps its own defaults rather than being handed a literal "~".
  const env = inheritedEnv({
    HOME: '',
    USERPROFILE: '',
    KLAUS_CONFIG_DIR: '~/.klaus',
  } as NodeJS.ProcessEnv);
  const map = new Map(env);
  assertEqual(map.get('KLAUS_CONFIG_DIR'), '~/.klaus', 'the caller value is passed through untouched');
  assertEqual(map.has('KLAUS_PLUGIN_HOME'), false, 'no plugin home is derived from it');
  assertEqual(map.has('KLAUS_SESSION_DIR'), false, 'and no session dir either');
});

h.test('inheritedEnv: proxy traffic to host MCP loopback bypasses the proxy', async () => {
  const env = new Map(inheritedEnv({
    HTTP_PROXY: 'http://proxy.example:10808',
    HTTPS_PROXY: 'http://proxy.example:10808',
  } as NodeJS.ProcessEnv));
  assertEqual(env.get('HTTP_PROXY'), 'http://proxy.example:10808', 'external HTTP proxy remains configured');
  assertEqual(env.get('HTTPS_PROXY'), 'http://proxy.example:10808', 'external HTTPS proxy remains configured');
  assertEqual(env.get('NO_PROXY'), '127.0.0.1,localhost', 'loopback bypass is passed to the engine');
  assertEqual(env.get('no_proxy'), env.get('NO_PROXY'), 'both proxy variable spellings agree');
});

h.test('inheritedEnv: loopback bypass preserves existing proxy exclusions', async () => {
  const env = new Map(inheritedEnv({
    HTTPS_PROXY: 'http://proxy.example:10808',
    NO_PROXY: 'internal.example,localhost',
    no_proxy: 'service.local,127.0.0.1',
  } as NodeJS.ProcessEnv));
  assertEqual(env.get('NO_PROXY'), 'internal.example,localhost,service.local,127.0.0.1', 'existing exclusions are retained without duplicate loopback entries');
  assertEqual(env.get('no_proxy'), env.get('NO_PROXY'), 'lowercase exclusion list is synchronized');
});

h.test('inheritedEnv: no active proxy leaves exclusions unchanged', async () => {
  const env = new Map(inheritedEnv({ HTTPS_PROXY: '', NO_PROXY: 'internal.example' } as NodeJS.ProcessEnv));
  assertEqual(env.get('NO_PROXY'), 'internal.example', 'existing exclusions stay untouched');
  assertEqual(env.has('no_proxy'), false, 'no unnecessary proxy variable is added');
});

// windowsSystemProxy parsing: the registry value shapes that appear in the wild. The
// exec function is injected so the rules are exercised off-Windows.
h.test('windowsSystemProxy: disabled manual proxy yields nothing', async () => {
  const proxy = windowsSystemProxy(args => {
    if (args.includes('ProxyEnable')) return '\n    ProxyEnable    REG_DWORD    0x0\n';
    return '';
  });
  assertEqual(proxy, undefined, 'ProxyEnable=0 disables the manual proxy');
});

h.test('windowsSystemProxy: single host:port becomes an http URL', async () => {
  const proxy = windowsSystemProxy(args => {
    if (args.includes('ProxyEnable')) return '\n    ProxyEnable    REG_DWORD    0x1\n';
    if (args.includes('ProxyServer')) return '\n    ProxyServer    REG_SZ    127.0.0.1:10808\n';
    return '';
  });
  assertEqual(proxy, 'http://127.0.0.1:10808', 'bare host:port wrapped as http');
});

h.test('windowsSystemProxy: per-protocol value picks the https entry', async () => {
  const proxy = windowsSystemProxy(args => {
    if (args.includes('ProxyEnable')) return '\n    ProxyEnable    REG_DWORD    0x1\n';
    if (args.includes('ProxyServer')) return '\n    ProxyServer    REG_SZ    http=127.0.0.1:1080;https=127.0.0.1:10808\n';
    return '';
  });
  assertEqual(proxy, 'http://127.0.0.1:10808', 'the https entry wins');
});

h.test('windowsSystemProxy: an unreadable registry yields nothing', async () => {
  const proxy = windowsSystemProxy(() => { throw new Error('reg.exe not found'); });
  assertEqual(proxy, undefined, 'a failing lookup never blocks startup');
});

h.test('queued Resume stays ahead of a later Stop when foreground slots are saturated', async () => {
  const scheduler = new RpcRequestScheduler();
  const releases: Array<(value: null) => void> = [];
  const active = Array.from({ length: 6 }, (_, index) => scheduler.schedule({
    method: `held-${index}`, priority: index < 4 ? 'critical' : 'interactive', conversationId: `held-${index}`,
  }, () => new Promise(resolve => releases.push(resolve))));
  const written: string[] = [];
  const resume = scheduler.schedule(rpcAdmission('session/resumeQueued', { sessionId: 'same-chat' }, 1000), async () => { written.push('resume'); return null; });
  const stop = scheduler.schedule(rpcAdmission('turn/interrupt', { sessionId: 'same-chat' }, 1000), async () => { written.push('stop'); return null; });
  try {
    assertDeepEqual(written, [], 'both controls wait behind already running requests');
    releases[0]!(null);
    await Promise.all([resume, stop]);
    assertDeepEqual(written, ['resume', 'stop'], 'the cancellation reaches the engine after the operation it cancels');
  } finally {
    for (const release of releases) release(null);
    await Promise.all(active); scheduler.close();
  }
});

h.test('request diagnostics separate queue wait from response wait without payloads', async () => {
  let now = 0;
  const diagnostics: RpcRequestDiagnostic[] = [];
  const scheduler = new RpcRequestScheduler(record => diagnostics.push(record), () => now);
  const releases: Array<(value: unknown) => void> = [];
  const active = Array.from({ length: 5 }, (_, index) => scheduler.schedule({ method: `read-${index}` },
    () => new Promise(resolve => releases.push(resolve))));
  const waiting = scheduler.schedule({ method: 'session/taskList', conversationId: 'chat' }, async () => { now = 1700; return {}; });
  now = 1200; releases[0]!({}); await waiting;
  const diagnostic = diagnostics.find(record => record.method === 'session/taskList');
  assertEqual(diagnostic?.queueMs, 1200, 'waiting for a slot is not attributed to engine work');
  assertEqual(diagnostic?.responseMs, 500, 'response time begins on admission');
  assertEqual(diagnostic?.outcome, 'ok', 'slow success is recorded');
  for (const release of releases.slice(1)) release({}); await Promise.all(active);
  scheduler.close();
});

h.test('queued timeouts and rejected RPCs emit bounded diagnostics without changing errors', async () => {
  const f = fakeEngine(); const diagnostics: RpcRequestDiagnostic[] = [];
  f.client.on('requestDiagnostic', record => diagnostics.push(record));
  const active = Array.from({ length: 5 }, (_, index) => f.client.request(`read-${index}`).catch(error => error));
  const error = await assertRejects(() => f.client.requestWithTimeout('session/taskList', { sessionId: 'chat', token: 'secret' }, 5), 'queued deadline') as { kind: string };
  assertEqual(error.kind, 'timeout', 'the original timeout remains unchanged');
  assertEqual(diagnostics[0]?.responseMs, 0, 'a request not sent has no response wait');
  assertEqual(diagnostics[0]?.outcome, 'timeout', 'timeout is distinguished from refusal');
  assert(typeof diagnostics[0]?.deadlineOverrunMs === 'number', 'late timer delivery is measurable');
  const refused = f.client.request('session/close', { sessionId: 'chat', token: 'secret' });
  const rejected = assertRejects(() => refused, 'engine refusal');
  const frame = JSON.parse(f.sent[f.sent.length - 1]!);
  f.replyError(frame.id, -32004, 'unknown session'); await rejected;
  assert(diagnostics.some(record => record.outcome === 'server' && record.code === -32004), 'server codes survive');
  assert(!JSON.stringify(diagnostics).includes('secret'), 'request payloads are excluded');
  f.client.close(); await Promise.all(active);
});

h.test('host responsiveness monitoring detects a real stall and stops cleanly', async () => {
  const records: Array<{ kind: string; detail: string }> = [];
  const stop = monitorHostResponsiveness({ write: (kind, detail) => records.push({ kind, detail }) }, 30, 40);
  try {
    await sleep(60);
    const start = performance.now();
    while (performance.now() - start < 100) { /* Deliberately block this isolated test process. */ }
    await waitFor(() => records.length > 0, 1000, 'host stall is measured');
    assertEqual(records[0]?.kind, 'host-responsiveness', 'host measurements are separate from RPC timing');
    assert(JSON.parse(records[0]!.detail).maxDelayMs >= 40, 'the measured stall crosses the threshold');
  } finally { stop(); }
  const count = records.length;
  await sleep(60);
  assertEqual(records.length, count, 'shutdown stops sampling');
});

h.test('diagnostic sink failure cannot strand request settlement', async () => {
  const scheduler = new RpcRequestScheduler(() => { throw new Error('sink failed'); });
  const failure = { kind: 'server', code: -32004, message: 'missing' };
  const error = await assertRejects(() => scheduler.schedule({ method: 'session/close' }, async () => { throw failure; }), 'refusal');
  assertEqual(error, failure, 'diagnostics cannot replace a request result');
  assertDeepEqual(scheduler.stats(), { queued: 0, running: 0, consumers: 0 }, 'slots are released');
  scheduler.close();
});

// Drain the queue, then report. The queue is why registration above is not awaited:
// top-level await would force ESM output, and the Electron main process is CommonJS.
void (async () => {
  const failed = await h.finish(join(__dirname, 'engine-protocol-result.json'), 'engine-protocol');
  process.exit(failed);
})();
