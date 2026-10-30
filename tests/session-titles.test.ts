import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { requestAcknowledged, type AcknowledgedClient } from '../main/engine/acknowledged';
import {
  applySessionTitles, generatedSessionTitle, normalizeSessionTitle, readSessionTitle,
  SessionTitles, TITLE_RETRY_INTERVAL_MS, truncateSessionTitle, visibleSeedText,
} from '../main/services/session-titles';
import { withSettingsDb, withSettingsTransaction } from '../main/services/settings';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects } from './harness';

type Row = Record<string, Json>;
const h = new Harness();
const object = (value: Json): Row => value as Row;
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25));
const generatedReply = (title = 'Generated title', threadId = 'thread'): Row => ({ generatedTitle: { threadId, title: { title, persisted: false, raw: title, usage: null } } });
interface FixtureState {
  engineTitles: Record<string, string>; liveId: string | undefined; current: boolean; authorized: boolean;
  clientReads: number; adaptive: boolean; firstUserContent: string | undefined; now: number;
}
interface Fixture {
  root: string;
  titles: SessionTitles;
  client: Client;
  state: FixtureState;
  events: Row[];
  logs: Array<{ kind: string; detail: string }>;
  serialize<T>(id: string, action: () => Promise<T>): Promise<T>;
}
class Client extends EventEmitter implements AcknowledgedClient {
  calls: Array<{ method: string; params: Json }> = [];
  readonly started = deferred<void>();
  generate: () => Promise<Json> = async () => generatedReply();
  updateFailure = false;
  updateGate: Promise<void> | undefined;
  constructor(private readonly state: FixtureState) { super(); }
  async requestWithTimeout(method: string, params: Json): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'session/generateTitle') { this.started.resolve(); return this.generate(); }
    if (method === 'session/updateTitle') {
      await this.updateGate;
      if (this.updateFailure) return { error: 'Title write rejected' };
      const row = object(params);
      this.state.engineTitles[String(row.threadId)] = String(row.title);
      return { title: { threadId: row.threadId, title: row.title } };
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'klaus-session-titles-'));
  const state: FixtureState = { engineTitles: {}, liveId: 'live-thread', current: true, authorized: true, clientReads: 0, adaptive: false, firstUserContent: undefined, now: 100 };
  const client = new Client(state), events: Row[] = [], logs: Array<{ kind: string; detail: string }> = [], queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(id: string, action: () => Promise<T>): Promise<T> => {
    const task = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    queues.set(id, task); return task;
  };
  const titles = new SessionTitles({
    configRoot: root, serialize, client: async () => { state.clientReads++; return client; },
    liveSession: () => state.liveId, ensureCurrent: () => { if (!state.current) throw new Error('Engine generation changed'); },
    authorizeGeneration: () => { if (!state.authorized) throw new Error('Source not authorized'); }, engineTitle: async id => state.engineTitles[id] ?? 'New Chat',
    publish: event => { events.push(event); }, adaptiveTitlesEnabled: () => state.adaptive,
    firstUserContent: async () => state.firstUserContent,
    log: (kind, detail) => logs.push({ kind, detail }), now: () => state.now,
  });
  return { root, titles, client, state, events, logs, serialize };
}
async function cleanup(f: Fixture): Promise<void> { f.titles.close(); await rm(f.root, { recursive: true, force: true }); }
const vectorPath = join(__dirname, '../../contracts/vectors/session-title-vectors.json');
interface Vector {
  truncation: { maxChars: number; ellipsis: string; cases: Array<{ text: string; expected: string }> };
  records: Array<{ id: string; title: string; source: string | null; attemptedAt: number | null; revision: number }>;
  rows: Json[];
  expectedTitles: string[];
  generation: { method: string; input: string; charLimit: number; promptFirstLine: string; promptSuffix: string; params: Row; reply: Row; expectedTitle: string; updateMethod: string; updateParams: Row; updateReply: Row; expectedEvent: Row };
  rejectedGenerationReplies: Row[];
  refresh: { gate: string; interval: number; charLimit: number; cacheLimit: number; promptContains: string[] };
}
const generations = (f: Fixture): Array<{ method: string; params: Row }> => f.client.calls.filter(call => call.method === 'session/generateTitle').map(call => ({ method: call.method, params: object(call.params) ?? {} }));
const cacheTitle = (f: Fixture, id: string): string | undefined => withSettingsDb(f.root, db => {
  db.exec('CREATE TABLE IF NOT EXISTS session_generated_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const row = db.prepare('SELECT title FROM session_generated_titles WHERE session_id = ?').get(id);
  return typeof row?.title === 'string' ? row.title : undefined;
});

h.test('committed title vectors preserve provenance without changing engine titles or recency', async () => {
  const f = await fixture();
  try {
    const vector = JSON.parse(await readFile(vectorPath, 'utf8')) as Vector;
    readSessionTitle('missing', f.root);
    withSettingsTransaction(f.root, db => {
      const put = db.prepare('INSERT INTO session_titles (session_id,title,source,ai_title_attempted_at,updated_at) VALUES (?,?,?,?,?)');
      for (const record of vector.records) put.run(record.id, record.title, record.source, record.attemptedAt, record.revision);
    });
    const before = withSettingsDb(f.root, db => db.prepare('SELECT * FROM session_titles ORDER BY session_id').all());
    const rows = f.titles.projectRows(vector.rows);
    assertDeepEqual(rows.map(row => object(row).title), vector.expectedTitles, 'explicit title precedence and conservative legacy seeds');
    assert(rows.every(row => object(row).updatedAt === 1000), 'title overlay never advances conversation recency');
    assertDeepEqual(withSettingsDb(f.root, db => db.prepare('SELECT * FROM session_titles ORDER BY session_id').all()), before, 'opening list does not rewrite any title record');
    assertDeepEqual(f.client.calls, [], 'opening list sends no engine or model request');
    assertEqual(f.state.clientReads, 0, 'opening list does not initialize an engine client');
    assertEqual(vector.truncation.maxChars, 60, 'display titles cap at sixty code points');
    for (const item of vector.truncation.cases) assertEqual(truncateSessionTitle(item.text) ?? null, item.expected, 'truncation vector');
    for (const title of [' New Chat ', 'Chat', '新对话', '12345678-abcd-1234-abcd-123456789abc', '']) assertEqual(normalizeSessionTitle(title), undefined, 'placeholder title');
  } finally { await cleanup(f); }
});

h.test('first accepted content is generation input and never a published title', async () => {
  const f = await fixture();
  try {
    const vector = JSON.parse(await readFile(vectorPath, 'utf8')) as Vector;
    f.client.generate = async () => vector.generation.reply;
    assertEqual(await f.titles.seedFromSend('thread', vector.generation.input), undefined, 'accepted content does not publish a title');
    assertEqual(readSessionTitle('thread', f.root), undefined, 'accepted content writes no title record');
    assertDeepEqual(f.events, [], 'accepted content pushes no title event');
    assertDeepEqual(f.client.calls, [], 'accepted content makes no engine call');
  } finally { await cleanup(f); }
});

h.test('a friend mention is not part of the generation input', async () => {
  assertEqual(visibleSeedText('@friend-2158597b-d2f5-48a9-a883-4d7f809de5aa 你电脑配置是什么').trim(), '你电脑配置是什么', 'the routing token is stripped');
  assertEqual(visibleSeedText('@friend-2158597b-d2f5-48a9-a883-4d7f809de5aa').trim(), '', 'a mention-only send has no title input');
});

h.test('an untitled live conversation recovers its title from stored first content once', async () => {
  const f = await fixture();
  try {
    f.state.firstUserContent = '@friend-2158597b-d2f5-48a9-a883-4d7f809de5aa 你电脑配置是什么';
    f.client.generate = async () => generatedReply('查询电脑配置');
    assertEqual(await f.titles.recoverUntitled('thread'), true, 'the live conversation recovers its initial title');
    assertEqual(readSessionTitle('thread', f.root)?.title, '查询电脑配置', 'the generated title is durable');
    const prompt = String(generations(f)[0]?.params.prompt);
    assert(prompt.includes('你电脑配置是什么'), 'the stored human message is the input');
    assert(!prompt.includes('@friend-'), 'the friend routing token is not input');
    assertEqual(await f.titles.recoverUntitled('thread'), false, 'recovery runs once per process');
  } finally { await cleanup(f); }
});

h.test('the first turn generates once through the named wrappers and applies the title', async () => {
  const f = await fixture();
  try {
    const vector = JSON.parse(await readFile(vectorPath, 'utf8')) as Vector;
    f.client.generate = async () => vector.generation.reply;
    await f.titles.seedFromSend('thread', vector.generation.input);
    assertEqual(await f.titles.firstTurnReady('thread'), true, 'the first turn carries the generation attempt');
    const call = generations(f)[0]!;
    assertEqual(call.method, vector.generation.method, 'only the named generateTitle wrapper');
    assertDeepEqual({ sessionId: call.params.sessionId, persist: call.params.persist }, vector.generation.params, 'generation params carry the session and the unpersisted flag');
    const prompt = String(call.params.prompt);
    assert(prompt.startsWith(vector.generation.promptFirstLine), 'the host-owned prompt frames the task');
    assert(prompt.endsWith(vector.generation.promptSuffix), 'the capped first content closes the prompt');
    assert(prompt.includes(`up to ${vector.generation.charLimit} characters`), 'the prompt carries its character limit');
    assertDeepEqual(f.client.calls[1], { method: vector.generation.updateMethod, params: vector.generation.updateParams }, 'the generated title syncs through updateTitle');
    assertDeepEqual(readSessionTitle('thread', f.root), { title: vector.generation.expectedTitle, source: 'ai', legacySeed: false, attemptedAt: 100, revision: 101 }, 'durable provenance and monotonic revisions');
    assertDeepEqual(f.events.at(-1), vector.generation.expectedEvent, 'AI completion pushes after persistence');
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'later turns do not regenerate');
    assertEqual(generations(f).length, 1, 'one generation request');
  } finally { await cleanup(f); }
});

h.test('a failed generation leaves the conversation untitled without retrying', async () => {
  const f = await fixture();
  try {
    f.client.generate = async () => { throw new Error('Provider unavailable'); };
    await f.titles.seedFromSend('thread', 'First prompt');
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'a failed generation reports no title');
    const record = readSessionTitle('thread', f.root);
    assertEqual(record?.title, null, 'no seed becomes a durable title');
    assertEqual(record?.source, 'seed', 'the generation attempt is recorded');
    assert(record?.attemptedAt !== null, 'the attempt stamp is durable');
    assert(f.logs.some(entry => entry.kind === 'session-title-generation-failed'), 'the failure is logged');
    assertEqual(f.events.length, 0, 'a failed generation pushes no title');
    assertEqual(f.client.calls.filter(call => call.method === 'session/updateTitle').length, 0, 'failure needs no engine write');
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'a failed attempt is not repeated on later turns');
  } finally { await cleanup(f); }
});

h.test('a failed attempt becomes eligible again after the quiet period', async () => {
  const f = await fixture();
  try {
    f.client.generate = async () => { throw new Error('session/generateTitle: timed out waiting for generatedTitle'); };
    await f.titles.seedFromSend('thread', 'First prompt');
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'the first attempt fails');
    const failed = readSessionTitle('thread', f.root);
    assertEqual(failed?.title, null, 'the failed attempt leaves no title');
    assertEqual(failed?.attemptedAt, 100, 'the failed attempt is still stamped');
    f.state.now = 100 + TITLE_RETRY_INTERVAL_MS - 1;
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'a retry inside the quiet period is refused');
    assertEqual(generations(f).length, 1, 'the quiet period sends no second request');
    f.state.now = 100 + TITLE_RETRY_INTERVAL_MS;
    f.client.generate = async () => generatedReply('Recovered title');
    assertEqual(await f.titles.firstTurnReady('thread'), true, 'the attempt retries once the quiet period passes');
    assertEqual(generations(f).length, 2, 'the retry sends one more request');
    assertEqual(readSessionTitle('thread', f.root)?.title, 'Recovered title', 'the retry applies its title');
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'a titled conversation never retries');
  } finally { await cleanup(f); }
});

h.test('a malformed attempt stamp stays a permanent claim', async () => {
  const f = await fixture();
  try {
    withSettingsDb(f.root, db => {
      db.exec('CREATE TABLE IF NOT EXISTS session_titles (session_id TEXT PRIMARY KEY, title TEXT, source TEXT, ai_title_attempted_at INTEGER, updated_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO session_titles VALUES (?,?,?,?,?)').run('thread', null, 'seed', 0, 1);
    });
    await f.titles.seedFromSend('thread', 'First prompt');
    f.state.now = 10 * TITLE_RETRY_INTERVAL_MS;
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'an unstamped attempt cannot prove its age');
    assertEqual(generations(f).length, 0, 'no inference is fired for an unprovable stamp');
  } finally { await cleanup(f); }
});

h.test('empty and rejected generation replies leave the conversation untitled', async () => {
  const vector = JSON.parse(await readFile(vectorPath, 'utf8')) as Vector;
  for (const reply of [emptyReply(), { generatedTitle: { threadId: 'thread', title: { persisted: false, raw: 'No structured title' } } }]) {
    const f = await fixture();
    try {
      f.client.generate = async () => reply;
      await f.titles.seedFromSend('thread', 'First prompt');
      assertEqual(await f.titles.firstTurnReady('thread'), false, 'an unusable reply reports no title');
      assertEqual(readSessionTitle('thread', f.root)?.title, null, 'no title is applied');
      assertEqual(f.events.length, 0, 'no title event is pushed');
    } finally { await cleanup(f); }
  }
  for (const reply of vector.rejectedGenerationReplies) await assertRejects(async () => generatedSessionTitle(reply, 'thread'), 'invalid title wrapper rejected');
  for (const reply of [emptyReply(), { generatedTitle: { threadId: 'thread', title: { persisted: false, raw: 'No structured title' } } }]) {
    assertEqual(generatedSessionTitle(reply, 'thread'), undefined, 'an omitted optional title and a null title are both empty generation');
  }
});

h.test('rename during inference wins in the same mutation queue even with a frozen clock', async () => {
  for (const rename of [false, true]) {
    const f = await fixture();
    try {
      await f.titles.seedFromSend('thread', 'First prompt');
      const pending = deferred<Json>(); f.client.generate = () => pending.promise;
      const ready = f.titles.firstTurnReady('thread');
      await f.client.started.promise;
      if (rename) await f.serialize('thread', async () => { f.titles.recordRename('thread', 'Manual title'); });
      let replaced = false;
      const admitted = deferred<void>();
      const replacement = f.serialize('thread', async () => {
        admitted.resolve(undefined);
        await f.titles.waitForInference('thread');
        replaced = true;
      });
      await admitted.promise;
      assertEqual(replaced, false, 'active title model use is fenced even after rename');
      pending.resolve(generatedReply('Late AI title'));
      await replacement;
      assertEqual(replaced, true, 'RPC settlement releases replacement before title persistence');
      assertEqual(await ready, !rename, 'only an unrenamed conversation applies the late title');
      if (rename) {
        assertDeepEqual(readSessionTitle('thread', f.root), { title: 'Manual title', source: 'custom', legacySeed: false, attemptedAt: 100, revision: 101 }, 'custom source and provenance survive');
        assert(!f.events.some(event => event.title === 'Late AI title'), 'no stale title push');
      }
    } finally { await cleanup(f); }
  }
});

h.test('duplicate first-turn events share one attempt and a late input still feeds the pipeline', async () => {
  const f = await fixture();
  try {
    await f.titles.seedFromSend('thread', 'First prompt');
    const pending = deferred<Json>(); f.client.generate = () => pending.promise;
    const first = f.titles.firstTurnReady('thread');
    await f.client.started.promise;
    assertEqual(readSessionTitle('thread', f.root)?.attemptedAt, 100, 'attempt committed before inference completes');
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'a concurrent first-turn event shares the live attempt');
    pending.resolve(generatedReply());
    assertEqual(await first, true, 'the live attempt settles');
    assertEqual(generations(f).length, 1, 'one inference request');
    assertEqual(await f.titles.firstTurnReady('late'), false, 'a turn start before the send acknowledgement generates nothing');
    await f.titles.seedFromSend('late', 'Late seed');
    f.client.generate = async () => generatedReply('Generated title', 'late');
    assertEqual(await f.titles.firstTurnReady('late'), true, 'the late input still feeds its own pipeline');
    assertEqual(readSessionTitle('late', f.root)?.title, 'Generated title', 'late conversation gets its generated title');
  } finally { await cleanup(f); }
});

h.test('the adaptive refresh stays inert while its gate is closed', async () => {
  const f = await fixture();
  try {
    await f.titles.seedFromSend('thread', 'First prompt');
    assertEqual(await f.titles.firstTurnReady('thread'), true, 'generation succeeds');
    for (let turn = 1; turn <= 5; turn++) f.titles.turnCompleted('thread', `turn-${turn}`, true);
    await settle();
    assertEqual(generations(f).length, 1, 'a closed gate schedules no refresh');
    assertEqual(cacheTitle(f, 'thread'), undefined, 'a closed gate writes no generated-title cache');
    f.titles.turnCompleted('thread', 'stopped', false);
    await settle();
    assertEqual(generations(f).length, 1, 'non-completed turns never refresh');
  } finally { await cleanup(f); }
});

h.test('the adaptive refresh revisits a cached generated title every fifth completed turn', async () => {
  const f = await fixture();
  try {
    const vector = JSON.parse(await readFile(vectorPath, 'utf8')) as Vector;
    f.state.adaptive = true;
    await f.titles.seedFromSend('thread', 'First prompt');
    assertEqual(await f.titles.firstTurnReady('thread'), true, 'generation caches its title');
    assertEqual(cacheTitle(f, 'thread'), 'Generated title', 'the cache holds the generated title');
    for (let turn = 1; turn <= 4; turn++) f.titles.turnCompleted('thread', `turn-${turn}`, true);
    await settle();
    assertEqual(generations(f).length, 1, 'the refresh waits for the fifth completed turn');
    f.client.generate = async () => generatedReply('Sharper title');
    f.titles.turnCompleted('thread', 'turn-5', true);
    await settle();
    assertEqual(generations(f).length, 2, 'the fifth completed turn refreshes');
    const refresh = generations(f)[1]!;
    for (const fragment of vector.refresh.promptContains) assert(String(refresh.params.prompt).includes(fragment), `refresh prompt carries ${fragment}`);
    assert(String(refresh.params.prompt).includes(JSON.stringify('Generated title')), 'refresh prompt quotes the cached title');
    assertEqual(readSessionTitle('thread', f.root)?.title, 'Sharper title', 'a better refresh title is applied');
    assertEqual(cacheTitle(f, 'thread'), 'Sharper title', 'the cache follows the applied title');
    await f.serialize('thread', async () => { f.titles.recordRename('thread', 'Manual name'); });
    f.client.generate = async () => generatedReply('Never applied');
    for (let turn = 6; turn <= 10; turn++) f.titles.turnCompleted('thread', `turn-${turn}`, true);
    await settle();
    assertEqual(generations(f).length, 2, 'a renamed title is never refreshed');
    assertEqual(vector.refresh.gate, 'adaptiveThreadTitles', 'the refresh rides the named gate');
    assertEqual(vector.refresh.interval, 5, 'the refresh interval is five completed turns');
    assertEqual(vector.refresh.cacheLimit, 1000, 'the cache is bounded');
  } finally { await cleanup(f); }
});

h.test('a failed engine title sync keeps the generated title in the host ledger', async () => {
  const f = await fixture();
  try {
    await f.titles.seedFromSend('thread', 'First prompt');
    f.client.updateFailure = true;
    assertEqual(await f.titles.firstTurnReady('thread'), true, 'the generated title is applied before the engine sync');
    const record = readSessionTitle('thread', f.root);
    assertEqual(record?.source, 'ai', 'failed engine sync still leaves an AI title');
    assertEqual(record?.title, 'Generated title', 'the generated title is durable');
    assert(record?.attemptedAt !== null, 'attempt remains durable');
    await settle();
    assert(f.logs.some(entry => entry.kind === 'session-title-engine-sync-failed'), 'engine sync failure is logged');
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'failure is not retried every turn');
    assertEqual(object(applySessionTitles([{ id: 'thread', title: 'New Chat' }], f.root)[0]!).title, 'Generated title', 'the generated title survives in the list');
  } finally { await cleanup(f); }
});

h.test('the generated title applies before the engine title write settles', async () => {
  const f = await fixture();
  try {
    await f.titles.seedFromSend('thread', 'First prompt');
    let release!: () => void;
    f.client.updateGate = new Promise<void>(resolve => { release = resolve; });
    assertEqual(await f.titles.firstTurnReady('thread'), true, 'generation applies while the engine write is still pending');
    assertEqual(readSessionTitle('thread', f.root)?.source, 'ai', 'the host ledger owns the generated title');
    assertDeepEqual(f.events.at(-1), { type: 'session_title_updated', sessionId: 'thread', title: 'Generated title' }, 'the title pushes before the engine write settles');
    release();
    await settle();
    assertEqual(f.state.engineTitles.thread, 'Generated title', 'the engine sync still lands after the turn');
    assert(f.logs.every(entry => entry.kind !== 'session-title-engine-sync-failed'), 'a settled sync logs no failure');
  } finally { await cleanup(f); }
});

h.test('legacy and existing engine titles are not silently retitled without provenance', async () => {
  const f = await fixture();
  try {
    f.state.engineTitles.thread = 'Existing Electron user rename';
    assertEqual(await f.titles.seedFromSend('thread', 'Next user message'), undefined, 'accepted content does not publish a title');
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'unknown provenance is not treated as first conversation');
    readSessionTitle('thread', f.root);
    withSettingsDb(f.root, db => db.prepare('INSERT INTO session_titles VALUES (?,?,?,?,?)').run('thread', 'Legacy first prompt', null, null, 1));
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'legacy seed cannot authorize replacing an unclassified engine title');
    assertEqual(f.state.clientReads, 0, 'no provider or engine client acquired for protected titles');
    assertDeepEqual(f.client.calls, [], 'no inference or title write');
    assertEqual(object(f.titles.projectRows([{ id: 'thread', title: f.state.engineTitles.thread }])[0]!).title, f.state.engineTitles.thread, 'legacy seed does not cover prior rename');
  } finally { await cleanup(f); }
});

h.test('generation admission runs before any provider request or durable attempt claim', async () => {
  const f = await fixture();
  try {
    await f.titles.seedFromSend('thread', 'First prompt');
    f.state.authorized = false;
    await assertRejects(() => f.titles.firstTurnReady('thread'), 'host source authorization is required');
    assertDeepEqual(f.client.calls, [], 'unauthorized source sends no provider request');
    assertEqual(f.state.clientReads, 0, 'authorization precedes client acquisition');
    assertEqual(readSessionTitle('thread', f.root), undefined, 'no attempt was claimed');
  } finally { await cleanup(f); }
});

h.test('interruption, shutdown, rebind and deletion cannot apply a stale title', async () => {
  for (const action of ['interrupt', 'close', 'rebind', 'delete']) {
    const f = await fixture();
    try {
      if (action === 'interrupt') {
        f.titles.turnCompleted('thread', 'stopped-turn', false);
        await settle();
        assertEqual(generations(f).length, 0, 'a stopped turn never refreshes');
        assertEqual(readSessionTitle('thread', f.root), undefined, 'a stopped turn consumes no title attempt');
        continue;
      }
      await f.titles.seedFromSend('thread', 'First prompt');
      const pending = deferred<Json>(); f.client.generate = () => pending.promise;
      const ready = f.titles.firstTurnReady('thread');
      await f.client.started.promise;
      if (action === 'close') f.titles.close();
      if (action === 'rebind') f.state.liveId = 'different-live-session';
      if (action === 'delete') await f.serialize('thread', async () => { withSettingsDb(f.root, db => db.prepare('DELETE FROM session_titles WHERE session_id = ?').run('thread')); });
      pending.resolve(generatedReply());
      assertEqual(await ready, false, `${action} invalidates pending result`);
      assertEqual(f.client.calls.filter(call => call.method === 'session/updateTitle').length, 0, 'no stale engine mutation');
      if (action === 'delete') assertEqual(readSessionTitle('thread', f.root), undefined, 'deleted title record is not recreated');
      if (action === 'close' || action === 'rebind') assertEqual(readSessionTitle('thread', f.root)?.title, null, 'the claim is left untitled');
    } finally { await cleanup(f); }
  }
});

h.test('malformed generation wrappers and engine generation changes are rejected', async () => {
  const vector = JSON.parse(await readFile(vectorPath, 'utf8')) as Vector;
  for (const reply of vector.rejectedGenerationReplies) await assertRejects(async () => generatedSessionTitle(reply, 'thread'), 'invalid title wrapper rejected');
  for (const reply of [emptyReply(), { generatedTitle: { threadId: 'thread', title: { persisted: false, raw: 'No structured title' } } }]) {
    assertEqual(generatedSessionTitle(reply, 'thread'), undefined, 'an omitted optional title and a null title are both empty generation');
  }
  const f = await fixture();
  try {
    await f.titles.seedFromSend('thread', 'First prompt');
    const pending = deferred<Json>(); f.client.generate = () => pending.promise;
    const ready = f.titles.firstTurnReady('thread');
    await f.client.started.promise;
    f.state.current = false; pending.resolve(generatedReply());
    assertEqual(await ready, false, 'engine generation guard prevents stale write');
    assertEqual(f.client.calls.filter(call => call.method === 'session/updateTitle').length, 0, 'no write to replacement engine');
    assertEqual(readSessionTitle('thread', f.root)?.title, null, 'the conversation stays untitled');
  } finally { await cleanup(f); }
});

h.test('a generated or custom title blocks a later generation', async () => {
  const f = await fixture();
  try {
    await f.titles.seedFromSend('thread', 'First prompt');
    f.client.generate = async () => generatedReply();
    assertEqual(await f.titles.firstTurnReady('thread'), true, 'generated title applied');
    assertEqual(await f.titles.seedFromSend('thread', 'Later content'), undefined, 'accepted content still publishes no title');
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'a generated title blocks later generation');
    await f.serialize('thread', async () => { f.titles.recordRename('thread', 'Manual name'); });
    assertEqual(await f.titles.firstTurnReady('thread'), false, 'a custom title blocks later generation');
    assertEqual(readSessionTitle('thread', f.root)?.title, 'Manual name', 'the custom title survives');
  } finally { await cleanup(f); }
});

function emptyReply(): Row {
  return { generatedTitle: { threadId: 'thread', title: { title: null, persisted: false } } };
}

void h.finish(join(__dirname, 'session-titles-result.json'), 'session-titles').then(code => { process.exitCode = code; });
