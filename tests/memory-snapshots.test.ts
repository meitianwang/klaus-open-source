import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { ClientEvent } from '../main/engine/protocol';
import { MemorySnapshotService, type MemorySnapshotDeps, type SnapshotOwner, type SnapshotResolution } from '../main/services/memory-snapshots';
import { type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';

const h = new Harness(), owners: MemorySnapshotService[] = [];
const audit = (id = 'audit', sessionId = 'engine', status = 'requested'): ClientEvent => ({ type: 'rawSessionEvent', params: { sessionId,
  event: { agentMemorySnapshotDecision: { status, request: { requestId: id, agentType: 'fixture-agent', snapshotTimestamp: '2026-09-01T00:00:00Z' } } } } });
function fixture(extra: Partial<MemorySnapshotDeps> = {}) {
  const prompts: JsonObject[] = [], resolutions: Array<{ owner: SnapshotOwner; id: string; result: SnapshotResolution }> = [], logs: string[] = []; let generation = 1;
  const service = new MemorySnapshotService({ generation: () => generation, rendererId: id => 'renderer-' + id,
    present: async prompt => { prompts.push(prompt); return true; }, resolve: async (owner, id, result) => { resolutions.push({ owner, id, result }); },
    log: value => { logs.push(value); }, timeoutMs: 100, ...extra }); owners.push(service);
  return { service, prompts, resolutions, logs, generation: (value: number) => { generation = value; } };
}
h.test('only a requested engine audit creates one prompt and explicit replies preserve exact session and generation', async () => {
  const f = fixture(); f.service.receive(audit()); f.service.receive(audit());
  assert.equal(f.prompts.length, 1); assert.deepEqual(f.prompts[0], { requestId: '1:memory:engine:audit', agentType: 'fixture-agent', snapshotTimestamp: '2026-09-01T00:00:00Z' });
  assert.equal(await f.service.respond({ requestId: f.prompts[0]!.requestId!, choice: 'merge' }), null);
  assert.deepEqual(f.resolutions, [{ owner: { engineId: 'engine', rendererId: 'renderer-engine', generation: 1 }, id: 'audit', result: { decision: 'merge' } }]);
  f.service.receive(audit()); assert.equal(f.prompts.length, 1); assert.equal(f.service.counts().prompts, 0);
});
h.test('unknown and forged replies do nothing and invalid choices resolve to keep', async () => {
  const f = fixture(); await f.service.respond({ requestId: 'forged', choice: 'replace' }); assert.equal(f.resolutions.length, 0);
  f.service.receive(audit()); await f.service.respond({ requestId: f.prompts[0]!.requestId!, choice: 'invented' });
  assert.deepEqual(f.resolutions[0]!.result, { decision: 'keep' });
  await f.service.respond({ requestId: f.prompts[0]!.requestId!, choice: 'replace' }); assert.equal(f.resolutions.length, 1);
});
h.test('undelivered or rejected presentation selects the engine no-handler policy without changing memory', async () => {
  for (const present of [async () => false, async (): Promise<boolean> => { throw new Error('renderer closed'); }]) {
    const f = fixture({ present }); f.service.receive(audit()); await waitFor(() => f.resolutions.length === 1, 1000, 'fallback sent');
    assert.deepEqual(f.resolutions[0]!.result, { reason: 'no-handler' }); assert.equal(f.service.counts().prompts, 0);
  }
});
h.test('the host timeout wins once and late replacement cannot override its keep policy', async () => {
  const f = fixture({ timeoutMs: 10 }); f.service.receive(audit());
  await waitFor(() => f.resolutions.length === 1, 1000, 'deadline'); assert.deepEqual(f.resolutions[0]!.result, { reason: 'timed-out' });
  await f.service.respond({ requestId: f.prompts[0]!.requestId!, choice: 'replace' }); assert.equal(f.resolutions.length, 1);
});
h.test('a terminal audit dismisses authority and generation replacement cannot retarget an old decision', async () => {
  const f = fixture(); f.service.receive(audit()); f.service.receive(audit('audit', 'engine', 'applied'));
  await f.service.respond({ requestId: f.prompts[0]!.requestId!, choice: 'replace' }); assert.equal(f.resolutions.length, 0);
  f.service.receive(audit('next')); const old = f.prompts[1]!.requestId!; f.generation(2); f.service.receive(audit('next'));
  await f.service.respond({ requestId: old, choice: 'replace' }); assert.equal(f.resolutions.length, 0);
  await f.service.respond({ requestId: f.prompts[2]!.requestId!, choice: 'keep' }); assert.equal(f.resolutions[0]!.owner.generation, 2);
});
h.test('renderer disappearance settles pending audits while session closure only revokes that session', async () => {
  const f = fixture(); f.service.receive(audit('one', 'first')); f.service.receive(audit('two', 'second'));
  f.service.forget('renderer-first'); await f.service.rendererUnavailable();
  assert.equal(f.resolutions.length, 1); assert.equal(f.resolutions[0]!.owner.engineId, 'second'); assert.deepEqual(f.resolutions[0]!.result, { reason: 'no-handler' });
});
h.test('one renderer disappearance leaves another conversation prompt actionable', async () => {
  const f = fixture(); f.service.receive(audit('one', 'first')); f.service.receive(audit('two', 'second'));
  await f.service.rendererUnavailable('renderer-first');
  assert.equal(f.resolutions.length, 1); assert.equal(f.resolutions[0]!.owner.engineId, 'first');
  assert.equal(f.service.counts().prompts, 1);
  await f.service.respond({ requestId: f.prompts[1]!.requestId!, choice: 'merge' });
  assert.equal(f.resolutions.length, 2); assert.equal(f.resolutions[1]!.owner.engineId, 'second');
  await f.service.close();
});
h.test('shutdown aborts pending presentation and drains the actual resolution acknowledgement', async () => {
  let cancelled = false, entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ present: (_prompt, signal) => new Promise<boolean>((_resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true })),
    resolve: async (_owner, _id, result) => { assert.deepEqual(result, { reason: 'disconnected' }); entered = true; await held; } });
  f.service.receive(audit()); let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await waitFor(() => entered, 1000, 'resolution entered'); assert.equal(cancelled, true); assert.equal(closed, false);
  release(); await closing; assert.deepEqual(f.service.counts(), { prompts: 0, operations: 0 }); f.service.receive(audit('late')); assert.equal(f.service.counts().prompts, 0);
});
h.test('an unconfirmed user decision stays pending and can be retried before transport loss clears it', async () => {
  let fail = true;
  const f = fixture({ resolve: async (owner, id, result) => {
    if (fail) throw new Error('fixture connection lost');
    f.resolutions.push({ owner, id, result });
  } });
  f.service.receive(audit());
  await assert.rejects(f.service.respond({ requestId: f.prompts[0]!.requestId!, choice: 'replace' }), /fixture connection lost/);
  assert.equal(f.service.counts().prompts, 1); assert.equal(f.logs.length, 0);
  fail = false;
  await f.service.respond({ requestId: f.prompts[0]!.requestId!, choice: 'merge' });
  assert.deepEqual(f.resolutions[0]!.result, { decision: 'merge' }); assert.equal(f.service.counts().prompts, 0);
  f.service.receive(audit('second')); f.service.receive({ type: 'streamClosed' });
  assert.equal(f.service.counts().prompts, 0); await f.service.respond({ requestId: f.prompts[1]!.requestId!, choice: 'replace' });
});
void h.finish(join(__dirname, 'memory-snapshots-result.json'), 'memory-snapshots').then(async code => { for (const owner of owners) await owner.close(); process.exitCode = code; });
