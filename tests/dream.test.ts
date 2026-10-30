import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerDreamHandlers } from '../main/ipc/handlers/dream';
import { DreamService, type DreamSubject } from '../main/services/dream';
import { DreamStore } from '../main/services/dream-store';
import { withSettingsDb } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';

const h = new Harness(), disposers: Array<() => Promise<void>> = [];
async function fixture(initial: JsonObject = {}) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-dream-')), calls: Array<{ method: string; params: JsonObject }> = [], pushes: JsonObject[] = [], logs: string[] = [];
  const subjects = new Map<string, DreamSubject>(); let generation = 1, clock = 1000, values = structuredClone(initial), version = 0, changes = 0;
  let respond: (params: JsonObject) => Promise<Json> = async () => ({ ok: true });
  const service = new DreamService({ configRoot: root, now: () => clock++, generation: () => generation, subject: id => { const row = subjects.get(id); return row && { ...row }; },
    startDream: async (subject, submissionId) => { const params = { sessionId: subject.engineId, submissionId }; calls.push({ method: 'session/dreamNow', params }); return respond(params); },
    request: async (method, raw) => {
      const params = object(raw); calls.push({ method, params });
      if (method === 'config/read') return { values: structuredClone(values), version: String(version) };
      if (method === 'config/batchWrite') {
        assert.equal(params.expectedVersion, String(version));
        for (const raw of params.edits as JsonObject[]) { const keys = String(raw.keyPath).split('.'); let target = values;
          for (const key of keys.slice(0, -1)) { target[key] ??= {}; target = object(target[key]); } target[keys.at(-1)!] = raw.value!;
        }
        return { values: structuredClone(values), version: String(++version) };
      }
      throw new Error('Unexpected engine request: ' + method);
    }, onChanged: () => { changes++; }, push: value => { pushes.push(value); }, log: value => { logs.push(value); },
  });
  const registry = new ChannelRegistry(); registerDreamHandlers(registry, service);
  disposers.push(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { service, registry, root, calls, pushes, logs, values: () => values, changes: () => changes,
    add: (id: string, busy = false) => { subjects.set(id, { rendererId: id, engineId: 'engine-' + id, generation, busy }); },
    busy: (id: string, busy: boolean) => { subjects.get(id)!.busy = busy; }, remove: (id: string) => subjects.delete(id), generation: (value: number) => { generation = value; },
    done: (id: string, stopReason = 'completed') => {
      service.observeEngine({ type: 'turnCompleted', params: { sessionId: 'engine-' + id, result: { stopReason } } });
      service.observeChat([{ type: stopReason === 'aborted' ? 'interrupted' : 'done', sessionId: id }]);
    },
    respond: (fn: typeof respond) => { respond = fn; },
    event: (sessionId: string, event: JsonObject) => service.observeEngine({ type: 'rawSessionEvent', params: { sessionId, event } }),
    latestCall: () => calls.filter(row => row.method === 'session/dreamNow').at(-1)!.params,
  };
}

h.test('dream config reads engine defaults and patches only its four owned versioned fields', async () => {
  const f = await fixture({ untouched: true });
  assert.deepEqual(await f.service.configGet(), { enabled: false, minHours: 24, minSessions: 5, skillEvolutionEnabled: false });
  assert.deepEqual(await f.service.configSet({ enabled: true, minHours: 6, minSessions: 2.8, skillEvolutionEnabled: true }), { enabled: true, minHours: 6, minSessions: 2, skillEvolutionEnabled: true });
  assert.equal(f.values().untouched, true); assert.deepEqual(f.values().dream, { minHours: 6, minSessions: 2 }); assert.equal(object(object(f.values().desktop).dream).skillEvolution, 'on');
  assert.deepEqual(await f.service.configSet({ minHours: 0, minSessions: -2, enabled: 'false' }), { enabled: true, minHours: 6, minSessions: 2, skillEvolutionEnabled: true });
  assert.equal(f.changes(), 2); assert.equal(object(await f.service.configSet({ minSessions: 0.1 })).minSessions, 1);
});
h.test('a contextless, removed or replaced conversation cannot start a dream', async () => {
  const f = await fixture(); f.add('fresh'); assert.deepEqual(await f.service.triggerNow(), { ok: false, error: 'no-context' });
  f.service.observeChat([{ type: 'interrupted', sessionId: 'fresh' }]);
  assert.deepEqual(await f.service.triggerNow(), { ok: false, error: 'no-context' });
  f.done('fresh'); f.remove('fresh'); assert.equal(object(await f.service.triggerNow()).error, 'no-context');
  f.add('old'); f.done('old'); f.generation(2); assert.equal(object(await f.service.triggerNow()).error, 'no-context');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.service.list({}), { runs: [], hasMore: false });
});
h.test('an interrupted turn remains context and a busy newest conversation never falls back to an older one', async () => {
  const f = await fixture(); f.add('older'); f.done('older'); f.add('newest', true); f.done('newest', 'aborted');
  f.respond(async () => ({ ok: false, reason: 'already-running' }));
  assert.deepEqual(await f.service.triggerNow(), { ok: false, error: 'already-running' });
  assert.equal(f.latestCall().sessionId, 'engine-newest'); assert.equal(f.service.current(), null);
});
h.test('manual consolidation uses the latest settled available conversation and persists only its matching completion', async () => {
  const f = await fixture(); f.add('one'); f.add('two'); f.done('one'); f.done('two');
  assert.deepEqual(await f.service.triggerNow(), { ok: true }); const params = f.latestCall(); assert.equal(params.sessionId, 'engine-two');
  assert.equal(object(f.service.current()).status, 'running'); assert.equal(object(f.service.current()).stoppable, false);
  assert.equal(object(await f.service.triggerNow()).error, 'already-running');
  f.event('engine-one', { submissionId: params.submissionId!, dreamCompleted: { ok: true } }); assert.equal(object(f.service.current()).status, 'running');
  f.event('engine-two', { submissionId: params.submissionId!, dreamCompleted: { ok: true, filesTouched: ['memory.md'], turnCount: 2 } });
  const current = object(f.service.current()); assert.equal(current.status, 'completed'); assert.deepEqual(current.filesTouched, ['memory.md']);
  assert.equal(current.turnCount, 2); assert.equal(f.pushes.length, 2); assert.equal((f.service.list({}) as JsonObject).hasMore, false);
  assert.equal(object(f.service.detail({ taskId: current.taskId! })).status, 'completed');
});
h.test('completion before the start outcome stays terminal instead of being overwritten by starting', async () => {
  const f = await fixture(); f.add('subject'); f.done('subject');
  f.respond(async params => { f.event('engine-subject', { submissionId: params.submissionId!, dreamCompleted: { ok: false, reason: 'fixture run failed' } }); return { ok: true }; });
  assert.deepEqual(await f.service.triggerNow(), { ok: true });
  assert.equal(object(f.service.current()).status, 'failed'); assert.equal(object(f.service.current()).summary, 'fixture run failed');
  assert.deepEqual(f.pushes.map(row => row.status), ['failed']);
});
h.test('an unstarted request creates no run while a started operation failure is persisted', async () => {
  const f = await fixture(); f.add('subject'); f.done('subject'); f.respond(async () => ({ ok: false, reason: 'gate-closed' }));
  assert.equal(object(await f.service.triggerNow()).error, 'gate-closed'); assert.equal(f.service.current(), null);
  f.respond(async () => ({ ok: true })); await f.service.triggerNow();
  f.event('engine-subject', { submissionId: f.latestCall().submissionId!, error: 'fixture engine refused' });
  assert.equal(object(f.service.current()).summary, 'fixture engine refused');
});
h.test('generation replacement and conversation removal revoke the exact running owner', async () => {
  const f = await fixture(); f.add('subject'); f.done('subject'); await f.service.triggerNow();
  f.generation(2); assert.equal(object(await f.service.triggerNow()).error, 'no-context'); assert.equal(object(f.service.current()).status, 'failed');
  f.add('new'); f.done('new'); await f.service.triggerNow(); f.service.forget('new');
  assert.equal(object(f.service.current()).summary, 'Conversation closed'); assert.equal(object(await f.service.triggerNow()).error, 'no-context');
});
h.test('automatic lifecycle records only completed or failed runs with their actual engine timestamps', async () => {
  const f = await fixture();
  for (const status of ['started', 'skipped']) f.event('engine-auto', { memoryMaintenanceEvent: { kind: 'auto_dream', run: { status, startedAt: 100 } } });
  assert.equal(f.service.current(), null);
  f.event('engine-auto', { memoryMaintenanceEvent: { kind: 'auto_dream', run: { status: 'completed', startedAt: 120, endedAt: 200, sessionsReviewing: 3, filesTouched: ['merged.md'], turnCount: 4, turns: [{ text: 'internal transcript' }], summary: 'Merged duplicate memories' } } });
  const row = object(f.service.current()); assert.equal(row.taskId, 'klaus-dream-120'); assert.equal(row.endedAt, 200); assert.equal(row.turnCount, 4); assert.deepEqual(row.turns, []);
  assert.equal(row.summary, 'Merged duplicate memories'); assert.equal(f.logs.length, 3);
});
h.test('a history write failure cannot hide the live dream lifecycle', async () => {
  const f = await fixture(); f.add('subject'); f.done('subject');
  f.service.store.save = () => { throw new Error('fixture database unavailable'); };
  assert.deepEqual(await f.service.triggerNow(), { ok: true });
  const params = f.latestCall(); assert.equal(object(f.service.current()).status, 'running'); assert.equal(f.pushes.length, 1);
  f.event('engine-subject', { submissionId: params.submissionId!, dreamCompleted: { ok: true, filesTouched: ['memory.md'] } });
  assert.equal(object(f.service.current()).status, 'completed'); assert.equal(f.pushes.length, 2);
  assert.equal(f.logs.filter(line => line.includes('Dream history persistence failed: fixture database unavailable')).length, 2);
});
h.test('a history startup failure does not block Dream service construction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-dream-blocked-')), blocked = join(root, 'not-a-directory'), logs: string[] = [];
  await writeFile(blocked, 'fixture');
  const service = new DreamService({ configRoot: blocked, generation: () => 1, subject: () => undefined,
    startDream: async () => ({ ok: false }), request: async () => ({}), onChanged: () => {}, push: () => {}, log: message => { logs.push(message); } });
  disposers.push(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(logs.length, 1); assert.match(logs[0]!, /^Dream history startup recovery failed:/);
});
h.test('compatible SQLite history keeps six turns, optional fields and deterministic filtered pagination', async () => {
  const f = await fixture();
  for (let index = 1; index <= 4; index++) f.service.store.save({ taskId: 'task-' + index, startedAt: index * 100, endedAt: index * 100 + 20, status: 'completed', phase: 'updating',
    turns: Array.from({ length: 9 }, (_, number) => ({ text: 'turn-' + number })), turnCount: 9, filesTouched: ['one.md'], skillReview: { changed: false } });
  const first = object(f.service.list({ limit: 2 })); assert.equal(first.hasMore, true); assert.deepEqual((first.runs as JsonObject[]).map(row => row.taskId), ['task-4', 'task-3']);
  const next = object(f.service.list({ before: 300, from: 100, to: 200, limit: 2 })); assert.equal(next.hasMore, false); assert.deepEqual((next.runs as JsonObject[]).map(row => row.taskId), ['task-2', 'task-1']);
  const detail = object(f.service.detail({ taskId: 'task-1' })); assert.equal((detail.turns as Json[]).length, 6); assert.equal(object((detail.turns as Json[])[0]).text, 'turn-3');
  assert.equal(detail.turnCount, 9); assert.equal(detail.durationMs, 20); assert.equal(detail.summary, undefined); assert.deepEqual(detail.skillReview, { changed: false }); assert.equal(f.service.detail({ taskId: 'unknown' }), null);
  withSettingsDb(f.root, db => db.prepare("UPDATE dream_runs SET files_touched='broken', turns='broken' WHERE task_id='task-1'").run());
  assert.deepEqual(object(f.service.detail({ taskId: 'task-1' })).filesTouched, []); assert.deepEqual(object(f.service.detail({ taskId: 'task-1' })).turns, []);
});
h.test('cold-start reaping finalizes legacy running rows and stop never claims a nonexistent cancel capability', async () => {
  const f = await fixture(); f.service.store.save({ taskId: 'abandoned', startedAt: 11, status: 'running', phase: 'starting' });
  const store = new DreamStore(f.root); assert.equal(store.reap(), 1);
  const row = object(store.latest()); assert.equal(row.status, 'failed'); assert.equal(row.endedAt, 11); assert.equal(row.durationMs, 0);
  assert.deepEqual(f.service.stop({ taskId: 'abandoned' }), { ok: false, error: 'not-running' }); assert.equal(f.calls.length, 0);
});
h.test('shutdown waits for accepted submission replies and rejects later operations', async () => {
  const f = await fixture(); f.add('subject'); f.done('subject'); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); f.respond(async () => { await held; return { ok: true }; });
  const triggering = f.service.triggerNow(); await waitFor(() => f.calls.length > 0, 1000, 'real request boundary'); let closed = false;
  const closing = f.service.close().then(() => { closed = true; }); assert.equal(closed, false); await assert.rejects(f.service.configGet());
  release(); await triggering; await closing; assert.equal(object(f.service.store.latest()).status, 'failed'); assert.equal(object(f.service.store.latest()).summary, 'Application closed');
});
h.test('all seven declarations route to the actual configuration, lifecycle and history owner', async () => {
  const f = await fixture(); assert.deepEqual(f.registry.channels(), ['dream:config-get', 'dream:config-set', 'dream:current', 'dream:detail', 'dream:list', 'dream:stop', 'dream:trigger-now']);
});

void h.finish(join(__dirname, 'dream-result.json'), 'dream').then(async code => { for (const dispose of disposers) await dispose(); process.exitCode = code; });
