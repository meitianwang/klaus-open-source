import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import type { JsonObject } from '../main/services/service-types';
import { buildMessageInput } from '../main/services/attachments';
import { withSettingsDb } from '../main/services/settings';
import { ClientFollowUpQueue, INTERRUPTED_QUEUE_REASON, UNCONFIRMED_DELIVERY_REASON } from '../main/sessions/client-queue';
import { EngineClientFollowUpQueue, type EngineClientQueueDeps } from '../main/sessions/engine-client-queue';
import { FakeEngineQueue, type EngineQueueState } from './engine-queue-fixture';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness(), roots: string[] = [];
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/engine-client-queue-vectors.json'), 'utf8')) as {
  methods: Record<string, string>; identity: { rendererId: string; threadId: string; itemId: string; turnId: string };
  payload: JsonObject; nativeInput: Json[]; imageOnly: JsonObject;
  literalInput: { content: Json[]; displayMetadata: JsonObject };
  migration: { additionMutation: { id: string; fingerprint: string }; removalMutation: { id: string; fingerprint: string } };
  admission: { defaultMode: 'start-if-idle'; steerMode: 'steer'; separateTurnSubmitCalls: number; separateDeleteCalls: number };
};
const { rendererId, threadId, itemId, turnId } = vector.identity;
const fields = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const item = (id: string): JsonObject => ({ id, displayText: id, finalText: id, media: [], liveAttachments: [] });
const ids = (snapshot: { items: Array<{ id: string }> }): string[] => snapshot.items.map(row => row.id);
function fixture(root?: string, state?: EngineQueueState, overrides: Partial<EngineClientQueueDeps> = {}) {
  if (!root) { root = mkdtempSync(join(tmpdir(), 'klaus-engine-client-queue-')); roots.push(root); }
  const engine = new FakeEngineQueue(state), events = new EventEmitter(), prepared: JsonObject[] = [];
  const client = { requestWithTimeout: (method: string, params: Json) => engine.request(method, params), on: events.on.bind(events), off: events.off.bind(events) };
  const deps: EngineClientQueueDeps = { configRoot: root, client: async () => client,
    threadId: id => id === rendererId ? threadId : `engine-${id}`,
    assertCurrent: (actual, id, thread) => { assertEqual(actual, client, 'captured engine client'); assertEqual(thread, id === rendererId ? threadId : `engine-${id}`, 'mapped thread identity'); },
    prepare: async (_id, payload) => { prepared.push(structuredClone(payload)); return typeof payload.finalText === 'string' && payload.finalText
      ? [{ type: 'text', text: payload.finalText }] : [{ type: 'localImage', path: '/managed/uploads/shot.png' }]; }, ...overrides };
  return { root, engine, client, prepared, adapter: new EngineClientFollowUpQueue(deps), deps };
}

h.test('engine rows preserve complete render payload, native parts, image-only input and restart authority', async () => {
  const f = fixture();
  const first = await f.adapter.add(rendererId, itemId, vector.payload);
  assertDeepEqual(first.items[0]?.item, vector.payload, 'full composer render payload survives the projection');
  const native = f.engine.document(threadId).rows[0]!;
  assertDeepEqual(native.input, vector.nativeInput, 'only engine-native input parts are stored');
  assertDeepEqual(native.clientMetadata, { item: vector.payload }, 'opaque render metadata has one envelope');
  assert(native.id !== itemId, 'engine submission identity stays separate from renderer identity');
  await f.adapter.add(rendererId, String(vector.imageOnly.id), vector.imageOnly);
  const restarted = fixture(f.root, f.engine.state);
  const snapshot = await restarted.adapter.snapshot(rendererId);
  assertDeepEqual(ids(snapshot), [itemId, 'image-only'], 'a new host adapter reads engine-owned order');
  assertDeepEqual(snapshot.items[1]?.item, vector.imageOnly, 'image-only attachments survive restart without text');
  assertEqual(new ClientFollowUpQueue(f.root).snapshot(rendererId).items.length, 0, 'new additions never create legacy execution rows');
});

h.test('unanchored additions migrate first and return concurrent authoritative rows with one list read', async () => {
  const f = fixture();
  new ClientFollowUpQueue(f.root).add(rendererId, 'legacy', item('legacy'));
  let injected = false;
  f.engine.afterCommit = async (method, params) => {
    if (method !== vector.methods.add || params.clientUserMessageId !== 'new' || injected) return;
    injected = true;
    await f.engine.request(vector.methods.add!, { threadId, input: [{ type: 'text', text: 'external' }],
      clientUserMessageId: 'external', clientMetadata: { item: item('external') } });
  };
  const added = await f.adapter.add(rendererId, 'new', item('new'));
  assertDeepEqual(ids(added), ['legacy', 'new', 'external'], 'the response includes migration and the concurrent committed row');
  assertEqual(f.engine.calls[0]?.method, vector.methods.import, 'legacy authority transfers before the first addition');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.list).length, 1, 'an append needs only the final authoritative read');
  const anchored = await f.adapter.add(rendererId, 'between', item('between'), { beforeId: 'new' });
  assertDeepEqual(ids(anchored), ['legacy', 'between', 'new', 'external'], 'anchored insertion still resolves renderer identities against a fresh native view');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.list).length, 3, 'anchor resolution retains its fresh read and the final authoritative read');
});

h.test('prepared queued image bytes survive removal of the source file and a replacement host', async () => {
  const f = fixture(undefined, undefined, { prepare: async (_id, payload) => buildMessageInput(String(payload.finalText ?? ''), payload.media as Json[]) });
  const path = join(f.root, 'portable.png');
  writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYb0AAAAASUVORK5CYII=', 'base64'));
  const payload: JsonObject = { ...vector.imageOnly, media: [{ type: 'image', path, name: 'portable.png' }] };
  await f.adapter.add(rendererId, 'portable', payload);
  const stored = structuredClone(f.engine.document(threadId).rows[0]!.input);
  assert(JSON.stringify(stored).includes('base64') || JSON.stringify(stored).includes('data:image/'), 'the actual image preparer persisted portable bytes');
  rmSync(path);
  const restarted = fixture(f.root, f.engine.state, { prepare: async () => { throw new Error('Queued delivery must not read a removed source file'); } });
  const prepared = await restarted.adapter.preparedInput(rendererId, 'portable');
  assertDeepEqual(prepared, [], 'replacement host uses a control placeholder for engine-owned portable bytes');
  assertDeepEqual(restarted.engine.document(threadId).rows[0]?.input, stored, 'the engine keeps the exact saved image parts');
  await restarted.adapter.claim(rendererId, 'portable');
  const admitted = await restarted.adapter.start(rendererId, 'portable', { sessionId: threadId, input: prepared, mode: 'start-if-idle', submissionId: 'portable-once' }, 1000);
  assertEqual(admitted.status, 'started', 'queued delivery succeeds after the original file is gone');
  assertEqual(restarted.engine.calls.filter(call => call.method === vector.methods.start).length, 1, 'portable input starts exactly once');
});

h.test('the adapter consumes every revision-scoped list page and maps renderer anchors to engine IDs', async () => {
  const f = fixture();
  for (const id of ['a', 'b', 'c']) await f.adapter.add(rendererId, id, item(id));
  f.engine.pageSize = 1;
  const before = f.engine.calls.length, snapshot = await f.adapter.snapshot(rendererId);
  assertDeepEqual(ids(snapshot), ['a', 'b', 'c'], 'all pages install together');
  const reads = f.engine.calls.slice(before);
  assertEqual(reads.length, 3, 'one list request per page');
  assert(reads.every(call => call.method === vector.methods.list && call.params.threadId === threadId), 'the named durable thread facade owns paging');
  const reordered = await f.adapter.reorder(rendererId, 'c', 'a', snapshot.revision);
  assertDeepEqual(ids(reordered), ['c', 'a', 'b'], 'engine ordering projects back to renderer identities');
  const request = f.engine.calls.findLast(call => call.method === vector.methods.reorder)!;
  assertDeepEqual(request.params.queuedSubmissionIds, f.engine.document(threadId).rows.map(row => row.id), 'RPC carries complete native submission order');
});

h.test('metadata mutations refuse stale revisions without removing or reordering exact input', async () => {
  const f = fixture();
  await f.adapter.add(rendererId, 'a', item('a')); const stale = (await f.adapter.snapshot(rendererId)).revision;
  await f.adapter.add(rendererId, 'b', item('b'));
  for (const mutation of [() => f.adapter.remove(rendererId, 'a', stale), () => f.adapter.reorder(rendererId, 'b', 'a', stale), () => f.adapter.clear(rendererId, stale)]) {
    const error = await assertRejects(mutation, 'stale mutation must reject');
    assertEqual(fields(error).code, 'queue_revision_changed', 'CAS refusal stays explicit');
    assertDeepEqual(ids(await f.adapter.snapshot(rendererId)), ['a', 'b'], 'refused metadata operations preserve order and payload');
  }
});

h.test('a pagination revision race retries the complete read without installing mixed pages', async () => {
  const f = fixture();
  for (const id of ['a', 'b']) await f.adapter.add(rendererId, id, item(id));
  f.engine.pageSize = 1; let raced = false;
  f.engine.beforeRequest = async (method, params) => {
    if (method !== vector.methods.list || !params.cursor || raced) return;
    raced = true;
    await f.engine.request(vector.methods.add!, { threadId, input: [{ type: 'text', text: 'c' }], clientUserMessageId: 'c', clientMetadata: { item: item('c') } });
  };
  assertDeepEqual(ids(await f.adapter.snapshot(rendererId)), ['a', 'b', 'c'], 'retry installs only the complete later revision');
  assert(raced, 'the test actually crosses a stale cursor');
});

h.test('legacy migration imports rows and receipts together and clears local storage only after ACK', async () => {
  const f = fixture(), legacy = new ClientFollowUpQueue(f.root);
  legacy.add(rendererId, itemId, vector.payload, {}, vector.migration.additionMutation);
  legacy.add(rendererId, 'removed', item('removed'));
  legacy.remove(rendererId, 'removed', undefined, vector.migration.removalMutation);
  const original = legacy.exportMigration(rendererId);
  let imported = false;
  f.engine.afterCommit = async method => {
    if (method !== vector.methods.import) return;
    imported = true;
    assertEqual(legacy.exportMigration(rendererId).fingerprint, original.fingerprint, 'rows and receipts remain while the ACK is outstanding');
  };
  const snapshot = await f.adapter.snapshot(rendererId);
  assert(imported, 'migration actually reached the engine facade');
  assertDeepEqual(ids(snapshot), [itemId], 'only the live legacy row is imported');
  assert(snapshot.revision >= original.revision, 'migration never lowers the renderer revision');
  assertEqual(f.engine.document(threadId).legacyReceipts.size, 2, 'both addition and removal receipts crossed the same transaction');
  const cleared = legacy.exportMigration(rendererId);
  assertDeepEqual([cleared.items.length, cleared.receipts.length, cleared.revision], [0, 0, 0], 'ACK retires every local authority table');
  await f.adapter.snapshot(rendererId);
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.import).length, 1, 'normal reads do not re-import acknowledged data');
});

h.test('a malformed legacy row blocks migration before any local data can be acknowledged away', async () => {
  const f = fixture(), legacy = new ClientFollowUpQueue(f.root);
  legacy.add(rendererId, itemId, vector.payload);
  withSettingsDb(f.root, db => { db.prepare('UPDATE follow_up_queue SET item=? WHERE session_id=? AND item_id=?').run('{broken', rendererId, itemId); });
  await assertRejects(() => f.adapter.snapshot(rendererId), 'corrupt legacy payload must not be silently omitted');
  const saved = withSettingsDb(f.root, db => db.prepare('SELECT item FROM follow_up_queue WHERE session_id=? AND item_id=?').get(rendererId, itemId));
  assertEqual(saved?.item, '{broken', 'the original corrupt row remains available for explicit recovery');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.import).length, 0, 'no incomplete import can authorize deleting the local proof');
});

h.test('a lost import ACK keeps migration data and retries the same transaction without duplicate rows', async () => {
  const f = fixture(), legacy = new ClientFollowUpQueue(f.root);
  legacy.add(rendererId, itemId, vector.payload);
  let lose = true;
  f.engine.afterCommit = async method => { if (method === vector.methods.import && lose) { lose = false; throw { kind: 'timeout', method }; } };
  await assertRejects(() => f.adapter.snapshot(rendererId), 'unknown migration must remain explicit');
  assertEqual(legacy.snapshot(rendererId).items.length, 1, 'unknown import keeps local migration proof');
  assertEqual(f.engine.document(threadId).rows.length, 1, 'engine committed once before the ACK was lost');
  const second = fixture(f.root, f.engine.state), snapshot = await second.adapter.snapshot(rendererId);
  assertDeepEqual(ids(snapshot), [itemId], 'replayed transaction keeps one row');
  const imports = [...f.engine.calls, ...second.engine.calls].filter(call => call.method === vector.methods.import);
  assertEqual(imports.length, 2, 'retry actually issues the idempotent named import');
  assertEqual(imports[0]?.params.migrationId, imports[1]?.params.migrationId, 'restart reuses the same durable migration identity');
  assertEqual(legacy.snapshot(rendererId).items.length, 0, 'the confirmed replay finally retires local data');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.start).length, 0, 'unknown import cannot submit a model input');
});

h.test('an already consumed addition receipt never revives its input after legacy import', async () => {
  const f = fixture(), legacy = new ClientFollowUpQueue(f.root);
  legacy.add(rendererId, itemId, vector.payload, {}, vector.migration.additionMutation);
  legacy.claimNext(rendererId); legacy.commitClaim(rendererId, itemId);
  assertEqual(legacy.snapshot(rendererId).items.length, 0, 'the legacy addition has already been consumed');
  await f.adapter.snapshot(rendererId);
  await f.adapter.add(rendererId, itemId, vector.payload, {}, vector.migration.additionMutation);
  assertDeepEqual(ids(await f.adapter.snapshot(rendererId)), [], 'replaying a consumed receipt cannot recreate its row');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.start).length, 0, 'receipt replay cannot execute input');
});

h.test('a lost addition ACK can recover its consumed receipt after the image source disappears', async () => {
  const prepare: EngineClientQueueDeps['prepare'] = async (_id, payload) => buildMessageInput(String(payload.finalText ?? ''), payload.media as Json[]);
  const f = fixture(undefined, undefined, { prepare }), path = join(f.root, 'lost-add.png');
  writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYb0AAAAASUVORK5CYII=', 'base64'));
  const payload: JsonObject = { ...vector.imageOnly, id: 'lost-add', media: [{ type: 'image', path, name: 'lost-add.png' }] };
  const receipt = { id: 'lost-add-receipt', fingerprint: 'd'.repeat(64) };
  f.engine.afterCommit = async (method, params) => { if (method === vector.methods.add && params.lookupOnly !== true) throw { kind: 'timeout', method }; };
  await assertRejects(() => f.adapter.add(rendererId, 'lost-add', payload, {}, receipt), 'the first successful engine add loses its ACK');
  const row = f.engine.document(threadId).rows[0]!;
  await f.engine.request(vector.methods.start!, { threadId, queuedSubmissionId: row.id, submissionId: 'consumed-before-replay', mode: 'start-if-idle' });
  rmSync(path);
  const restarted = fixture(f.root, f.engine.state, { prepare }); let changed = 0;
  restarted.engine.changed = () => { changed++; };
  const recovered = await restarted.adapter.add(rendererId, 'lost-add', payload, {}, receipt);
  assertDeepEqual(ids(recovered), [], 'a consumed addition receipt cannot revive its input');
  const lookups = restarted.engine.calls.filter(call => call.method === vector.methods.add);
  assertEqual(lookups.length, 1, 'prepare failure reads exactly one durable addition receipt');
  assertEqual(lookups[0]?.params.lookupOnly, true, 'receipt lookup cannot create a replacement queued row');
  assertEqual(changed, 0, 'receipt lookup emits no queue mutation notification');
});

h.test('imported removal proof authorizes unchanged Undo after the legacy tables are cleared', async () => {
  const f = fixture(), legacy = new ClientFollowUpQueue(f.root);
  legacy.add(rendererId, itemId, vector.payload);
  legacy.pauseAll(rendererId, INTERRUPTED_QUEUE_REASON);
  const removed = legacy.remove(rendererId, itemId, undefined, vector.migration.removalMutation).removed!;
  await f.adapter.snapshot(rendererId);
  assertEqual(legacy.exportMigration(rendererId).receipts.length, 0, 'ACK clears the local removal receipt');
  const resumedHost = fixture(f.root, f.engine.state);
  const restored = await resumedHost.adapter.restore(rendererId, removed, {}, false, undefined, true);
  assertEqual(restored.items[0]?.pausedReason, INTERRUPTED_QUEUE_REASON, 'imported proof retains the stopped row pause');
  assertDeepEqual(restored.items[0]?.item, vector.payload, 'imported proof preserves the complete attachment envelope');
  await assertRejects(() => resumedHost.adapter.restore(rendererId, { ...removed, item: item('different') }, {}, false, undefined, true), 'old proof cannot restore altered payload');
});

h.test('stable mutation receipts replay before stale CAS and reject changed fingerprints', async () => {
  const f = fixture(), receipt = { id: 'stable-add', fingerprint: 'a'.repeat(64) };
  await f.adapter.add(rendererId, itemId, vector.payload, {}, receipt);
  await f.adapter.add(rendererId, itemId, vector.payload, {}, receipt);
  assertDeepEqual(ids(await f.adapter.snapshot(rendererId)), [itemId], 'replayed addition cannot duplicate a row');
  await assertRejects(() => f.adapter.add(rendererId, itemId, vector.payload, {}, { ...receipt, fingerprint: 'b'.repeat(64) }), 'a mutation identity cannot change its payload fingerprint');
  const before = await f.adapter.snapshot(rendererId), deletion = { id: 'stable-delete', fingerprint: 'c'.repeat(64) };
  const removed = await f.adapter.remove(rendererId, itemId, before.revision, deletion);
  const replay = await f.adapter.remove(rendererId, itemId, before.revision, deletion);
  assertDeepEqual(replay.removed, removed.removed, 'unknown delete ACK reads its original durable removal receipt');
  assertDeepEqual(ids(replay.snapshot), [], 'delete replay cannot recreate consumed input');
});

h.test('Stop pauses only fresh runnable rows and preserves failure and directory reasons', async () => {
  const f = fixture();
  for (const id of ['failed', 'directory', 'ordinary']) await f.adapter.add(rendererId, id, item(id));
  const native = f.engine.document(threadId), failed = native.rows.find(row => row.clientUserMessageId === 'failed')!, directory = native.rows.find(row => row.clientUserMessageId === 'directory')!, ordinary = native.rows.find(row => row.clientUserMessageId === 'ordinary')!;
  await f.engine.request(vector.methods.pause!, { threadId, reason: 'The engine refused this input', queuedSubmissionIds: [failed.id] });
  await f.engine.request(vector.methods.pause!, { threadId, reason: 'The working directory is unavailable', queuedSubmissionIds: [directory.id] });
  const revision = native.revision;
  const snapshot = await f.adapter.pauseAll(rendererId, INTERRUPTED_QUEUE_REASON);
  assertDeepEqual(snapshot.items.map(row => [row.id, row.pausedReason]), [
    ['failed', 'The engine refused this input'], ['directory', 'The working directory is unavailable'], ['ordinary', INTERRUPTED_QUEUE_REASON],
  ], 'a terminal Stop cannot overwrite engine-owned pause reasons learned after the cached view');
  const pause = f.engine.calls.findLast(call => call.method === vector.methods.pause)!;
  assertDeepEqual(pause.params.queuedSubmissionIds, [ordinary.id], 'only the actual runnable backend row is selected');
  assertEqual(pause.params.expectedRevision, revision, 'the selection is fenced by its fresh engine revision');
  assertEqual(f.engine.admissions.length, 0, 'Stop metadata never admits a model turn');
});

h.test('Stop during preparation survives a rejected start and only explicit Resume clears interruption', async () => {
  const f = fixture();
  await f.adapter.add(rendererId, 'failed', item('failed')); await f.adapter.add(rendererId, 'preparing', item('preparing'));
  const native = f.engine.document(threadId), failed = native.rows.find(row => row.clientUserMessageId === 'failed')!, preparing = native.rows.find(row => row.clientUserMessageId === 'preparing')!;
  await f.engine.request(vector.methods.pause!, { threadId, reason: 'Existing delivery failure', queuedSubmissionIds: [failed.id] });
  await f.adapter.claim(rendererId, 'preparing');
  await f.engine.request(vector.methods.pause!, { threadId, reason: INTERRUPTED_QUEUE_REASON, queuedSubmissionIds: [preparing.id] });
  const refusal = await assertRejects(() => f.adapter.start(rendererId, 'preparing', {
    sessionId: threadId, input: [{ type: 'text', text: 'preparing' }], mode: 'start-if-idle', submissionId: 'stopped-preparation',
  }, 1000), 'the engine refuses the input that Stop paused during preparation');
  assertEqual(fields(refusal).code, 'queue_revision_changed', 'Stop changes the row version before admission and reports a definite CAS refusal');
  assertEqual(fields(refusal).kind, 'server', 'a pre-admission Stop never becomes unknown delivery');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.start).length, 0, 'the changed Stop version refuses before a queue start RPC');
  const revision = native.revision, pauses = f.engine.calls.filter(call => call.method === vector.methods.pause).length;
  const retained = await f.adapter.requeueFailed(rendererId, 'preparing', 'Preparation was rejected after Stop');
  assertEqual(retained.items.find(row => row.id === 'preparing')?.pausedReason, INTERRUPTED_QUEUE_REASON, 'delivery cleanup retains the interruption instead of replacing it with a failure');
  assertEqual(native.revision, revision, 'refusal cleanup does not mutate an already paused engine row');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.pause).length, pauses, 'refusal cleanup issues no overwrite of the engine Stop reason');
  const resumed = await f.adapter.resumeInterrupted(rendererId, INTERRUPTED_QUEUE_REASON, retained.revision);
  assertDeepEqual(resumed.items.map(row => [row.id, row.pausedReason]), [['failed', 'Existing delivery failure'], ['preparing', null]], 'explicit Resume clears only interruption and preserves an independent failure');
  assertEqual(f.engine.admissions.length, 0, 'the stopped preparation and Resume metadata cannot issue model input');
});

h.test('Stop and failed-preparation cleanup cannot rewrite an unknown engine dispatch', async () => {
  const f = fixture();
  await f.adapter.add(rendererId, 'unknown', item('unknown')); await f.adapter.add(rendererId, 'ordinary', item('ordinary'));
  const native = f.engine.document(threadId), unknown = native.rows.find(row => row.clientUserMessageId === 'unknown')!, ordinary = native.rows.find(row => row.clientUserMessageId === 'ordinary')!;
  f.engine.admit = async () => { throw { kind: 'timeout', method: vector.methods.start }; };
  await assertRejects(() => f.engine.request(vector.methods.start!, { threadId, queuedSubmissionId: unknown.id, submissionId: 'unknown-dispatch', mode: 'start-if-idle' }), 'the fake engine durably reserves an admission whose ACK is unknown');
  const saved = structuredClone(unknown);
  await f.adapter.pauseAll(rendererId, INTERRUPTED_QUEUE_REASON);
  assertDeepEqual(native.rows.find(row => row.id === unknown.id), saved, 'Stop preserves the exact unknown reservation, input and reason');
  const pause = f.engine.calls.findLast(call => call.method === vector.methods.pause)!;
  assertDeepEqual(pause.params.queuedSubmissionIds, [ordinary.id], 'Stop does not include an unknown backend dispatch in its selected rows');
  const revision = native.revision, pauses = f.engine.calls.filter(call => call.method === vector.methods.pause).length;
  await f.adapter.requeueFailed(rendererId, 'unknown', 'A later preparation failed');
  assertDeepEqual(native.rows.find(row => row.id === unknown.id), saved, 'failed-preparation cleanup cannot downgrade an unknown reservation');
  assertEqual(native.revision, revision, 'unknown cleanup remains a read of engine authority');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.pause).length, pauses, 'unknown cleanup cannot issue a reason overwrite');
  await f.adapter.resumeInterrupted(rendererId, INTERRUPTED_QUEUE_REASON);
  assertDeepEqual(native.rows.find(row => row.id === unknown.id), saved, 'Resume cannot clear or retry an unknown dispatch');
  assertEqual(native.rows.find(row => row.id === ordinary.id)?.pausedReason, undefined, 'Resume still clears the separate interrupted row');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.start).length, 1, 'the unknown admission is never resubmitted');
});

h.test('stopped input keeps its pause and native attachments through removal and Undo', async () => {
  const f = fixture();
  await f.adapter.add(rendererId, itemId, vector.payload);
  await f.adapter.pauseAll(rendererId, INTERRUPTED_QUEUE_REASON);
  const removed = await f.adapter.remove(rendererId, itemId, undefined, { id: 'undo', fingerprint: 'c'.repeat(64) });
  assertEqual(removed.removed?.pausedReason, INTERRUPTED_QUEUE_REASON, 'raw receipt retains interruption state');
  const restored = await f.adapter.restore(rendererId, removed.removed!, {}, false, undefined, true);
  assertEqual(restored.items[0]?.pausedReason, INTERRUPTED_QUEUE_REASON, 'Undo does not resume stopped input');
  assertDeepEqual(f.engine.document(threadId).rows[0]?.input, vector.nativeInput, 'durable deletion proof restores prepared attachment input');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.start).length, 0, 'metadata Undo never starts a turn');
  await f.adapter.resumeInterrupted(rendererId, INTERRUPTED_QUEUE_REASON, restored.revision);
  assertEqual((await f.adapter.snapshot(rendererId)).items[0]?.pausedReason, null, 'explicit Resume clears exactly the interrupted state');
});

h.test('Undo rejects absent proof, altered render payload and a consumed admission tombstone', async () => {
  const f = fixture();
  const candidate = { id: 'missing', item: item('missing'), createdAt: 1, pausedReason: null };
  await assertRejects(() => f.adapter.restore(rendererId, candidate, {}, false, undefined, true), 'new rows cannot invent deletion proof');
  await f.adapter.add(rendererId, itemId, vector.payload);
  const removed = await f.adapter.remove(rendererId, itemId);
  await assertRejects(() => f.adapter.restore(rendererId, { ...removed.removed!, item: { ...vector.payload, finalText: 'Changed after deletion' } }, {}, false, undefined, true), 'changed payload cannot reuse the proof');
  await f.adapter.restore(rendererId, removed.removed!, {}, false, undefined, true);
  await f.adapter.claim(rendererId, itemId);
  await f.adapter.start(rendererId, itemId, { sessionId: threadId, input: vector.nativeInput, mode: 'start-if-idle', submissionId: 'accepted-once' }, 1000);
  await f.adapter.commitClaim(rendererId, itemId);
  await assertRejects(() => f.adapter.restore(rendererId, removed.removed!, {}, false, undefined, true), 'a started tombstone cannot become a retry copy');
});

for (const mode of ['start-if-idle', 'steer'] as const) h.test(`queued ${mode} uses one atomic start and separates admission from application`, async () => {
  const f = fixture();
  await f.adapter.add(rendererId, itemId, vector.payload); await f.adapter.claim(rendererId, itemId);
  const before = f.engine.calls.length;
  const admitted = await f.adapter.start(rendererId, itemId, { sessionId: threadId, input: vector.nativeInput, mode,
    submissionId: 'queue-admission', ...(mode === 'steer' ? { expectedTurnId: turnId, queueMessageId: itemId, delivery: 'user', displayMetadata: vector.payload.displayMetadata! } : {}) }, 1000);
  await f.adapter.commitClaim(rendererId, itemId);
  assertEqual(admitted.status, mode === 'steer' ? 'steered' : 'started', 'typed result records admission only');
  const calls = f.engine.calls.slice(before);
  assertEqual(calls.filter(call => call.method === vector.methods.start).length, 1, 'exactly one engine start request');
  assertEqual(calls.filter(call => call.method === 'turn/submit').length, vector.admission.separateTurnSubmitCalls, 'no independent direct submission');
  assertEqual(calls.filter(call => call.method === vector.methods.delete).length, vector.admission.separateDeleteCalls, 'atomic start removes its own row');
  const request = calls.find(call => call.method === vector.methods.start)!;
  assertEqual(request.params.threadId, threadId, 'durable namespace is the mapped thread');
  assert(!('input' in request.params), 'admission reads the previously persisted native input');
  if (mode === 'steer') assertEqual(request.params.expectedTurnId, turnId, 'steer retains the exact target fence');
  assertDeepEqual(ids(await f.adapter.snapshot(rendererId)), [], 'confirmed admission consumes the durable row');
  assert(!('applied' in admitted), 'application needs its own correlated engine outcome');
});

h.test('queued steer admission retains an authored leading literal without rewriting native input', async () => {
  const f = fixture(undefined, undefined, { prepare: async () => vector.literalInput.content });
  await f.adapter.add(rendererId, itemId, { ...item(itemId), displayMetadata: vector.literalInput.displayMetadata });
  await f.adapter.claim(rendererId, itemId);
  const before = f.engine.calls.length;
  await f.adapter.start(rendererId, itemId, { sessionId: threadId, mode: 'steer', input: vector.literalInput.content,
    submissionId: 'literal-steer', queueMessageId: itemId, expectedTurnId: turnId, delivery: 'user', displayMetadata: vector.literalInput.displayMetadata }, 1000);
  const calls = f.engine.calls.slice(before);
  assertEqual(calls.filter(call => call.method === vector.methods.update).length, 0, 'presentation does not remove a literal or rewrite durable bytes');
  const request = calls.find(call => call.method === vector.methods.start)!;
  assertDeepEqual(request.params.displayMetadata, vector.literalInput.displayMetadata, 'metadata travels separately from the authored input');
});

h.test('a definite busy admission retains the original row without a local fallback', async () => {
  const f = fixture(); await f.adapter.add(rendererId, itemId, vector.payload); await f.adapter.claim(rendererId, itemId);
  f.engine.admit = async params => ({ status: 'not-submitted', submissionId: params.submissionId!, reason: { code: 'not-idle', activeTurnId: turnId } });
  const error = await assertRejects(() => f.adapter.start(rendererId, itemId, { sessionId: threadId, input: vector.nativeInput, mode: 'start-if-idle', submissionId: 'busy-attempt' }, 1000), 'strict next-turn input cannot join a competing turn');
  assertEqual(fields(fields(error).reason).code, 'not-idle', 'safe refusal remains typed');
  await f.adapter.releaseClaim(rendererId, itemId);
  const row = (await f.adapter.snapshot(rendererId)).items[0]!;
  assertEqual(row.id, itemId, 'refusal preserves row identity'); assertDeepEqual(row.item, vector.payload, 'refusal preserves complete attachments');
  assertEqual(row.pausedReason, null, 'safe busy refusal is eligible for a later turn');
  assertEqual(f.engine.calls.filter(call => call.method === vector.methods.start).length, 1, 'busy admission has no immediate retry');
});

h.test('unknown start remains reserved across host restart and Resume cannot issue it again', async () => {
  const f = fixture(); await f.adapter.add(rendererId, itemId, vector.payload); await f.adapter.claim(rendererId, itemId);
  f.engine.admit = async () => { throw { kind: 'timeout', method: vector.methods.start }; };
  await assertRejects(() => f.adapter.start(rendererId, itemId, { sessionId: threadId, input: vector.nativeInput, mode: 'start-if-idle', submissionId: 'unknown-once' }, 1000), 'unknown admission stays explicit');
  await f.adapter.retainUnconfirmed(rendererId, itemId);
  const restarted = fixture(f.root, f.engine.state);
  let snapshot = await restarted.adapter.snapshot(rendererId);
  assertEqual(snapshot.items[0]?.pausedReason, UNCONFIRMED_DELIVERY_REASON, 'restart projects durable uncertainty');
  assertEqual(snapshot.items[0]?.item.queuedTurnSubmissionId, 'unknown-once', 'correlation survives replacement hosts');
  await restarted.adapter.resumeInterrupted(rendererId, INTERRUPTED_QUEUE_REASON);
  assertEqual((await restarted.adapter.claimNext(rendererId)).row, undefined, 'ordinary Resume cannot claim an unknown admission');
  snapshot = await restarted.adapter.snapshot(rendererId);
  assertDeepEqual(ids(snapshot), [itemId], 'the exact waiting row survives');
  assertEqual([...f.engine.calls, ...restarted.engine.calls].filter(call => call.method === vector.methods.start).length, 1, 'unknown input is never automatically resubmitted');
});

h.test('preparation claims serialize only one host while engine state owns cross-host execution', async () => {
  const f = fixture(); await f.adapter.add(rendererId, 'a', item('a')); await f.adapter.add(rendererId, 'b', item('b'));
  const first = await f.adapter.claimNext(rendererId);
  assertEqual(first.row?.id, 'a', 'the first row wins local preparation');
  assertEqual((await f.adapter.claimNext(rendererId)).row, undefined, 'a second local preparation cannot overtake it');
  const before = f.engine.calls.filter(call => call.method !== vector.methods.list).length;
  const second = fixture(f.root, f.engine.state);
  assertEqual((await second.adapter.claimNext(rendererId)).row?.id, 'a', 'a separate host does not trust another host memory lock');
  assertEqual(f.engine.calls.filter(call => call.method !== vector.methods.list).length, before, 'claim itself cannot reserve engine execution');
  await f.adapter.releaseClaim(rendererId, 'a');
  assertEqual((await f.adapter.claimNext(rendererId)).row?.id, 'a', 'safe preparation release keeps head order');
});

h.test('the named facade defaults to full rows and projects every payload-bearing response explicitly', async () => {
  const engine = new FakeEngineQueue(), input: Json[] = [{ type: 'text', text: 'native-private-bytes' }];
  const metadata = { item: item('projection'), nested: { opaque: ['retained'] } };
  const add = fields(await engine.request('thread/queue/add', { threadId, input, clientUserMessageId: 'projection', clientMetadata: metadata }));
  const full = fields(add.queuedSubmission), backendId = full.id!;
  assertDeepEqual(full.input, input, 'default add retains the native input API');
  assert(/^sha256:[a-f0-9]{64}$/.test(String(full.inputFingerprint)), 'full rows carry an opaque lowercase SHA-256 fingerprint');
  assert(Number.isSafeInteger(full.rowVersion), 'full rows carry a safe row version');
  const projected = (row: Json) => {
    const value = fields(row);
    assert(!('input' in value) && value.inputOmitted === true, 'projected native bytes are absent rather than an empty replacement');
    assert(/^sha256:[a-f0-9]{64}$/.test(String(value.inputFingerprint)), 'projection retains the fingerprint');
    assert(Number.isSafeInteger(value.rowVersion), 'projection retains the row version');
    assertDeepEqual(value.clientMetadata, metadata, 'projection preserves the complete opaque metadata envelope');
  };
  projected((fields(await engine.request('thread/queue/list', { threadId, includeInput: false })).data as Json[])[0]!);
  const updated = fields(await engine.request('thread/queue/update', { threadId, queuedSubmissionId: backendId, input, includeInput: false }));
  projected(updated.queuedSubmission!);
  assertEqual(fields(updated.queuedSubmission).inputFingerprint, full.inputFingerprint, 'metadata or identical input cannot change the input fingerprint');
  const removed = fields(await engine.request('thread/queue/delete', { threadId, queuedSubmissionId: backendId, includeInput: false }));
  projected(removed.queuedSubmission!); projected(fields(removed.receipt).queuedSubmission!);
  await engine.request('thread/queue/add', { threadId, input, clientUserMessageId: 'projection', clientMetadata: metadata, createdAt: full.createdAt!, restore: true, requireRemovedReceipt: true });
  const started = fields(await engine.request('thread/queue/start', { threadId, queuedSubmissionId: backendId, submissionId: 'projection-start', mode: 'start-if-idle', includeInput: false }));
  projected(started.queuedSubmission!);
  const added = fields(await engine.request('thread/queue/add', { threadId, input, clientUserMessageId: 'clear-projection', clientMetadata: metadata, includeInput: false }));
  projected(added.queuedSubmission!); projected(fields(added.receipt).queuedSubmission!);
  projected((fields(await engine.request('thread/queue/clear', { threadId, includeInput: false })).cleared as Json[])[0]!);
  await engine.request('thread/queue/add', { threadId, input, clientUserMessageId: 'default-list', clientMetadata: metadata });
  const listed = fields(await engine.request('thread/queue/list', { threadId }));
  assertDeepEqual(fields((listed.data as Json[])[0]).input, input, 'omitting includeInput preserves full list compatibility');
});

h.test('large portable images stay out of snapshot preparation and start wire bytes without native rewrites', async () => {
  const native: Json[] = [{ type: 'image', imageUrl: 'data:image/png;base64,' + 'Q'.repeat(3 * 1024 * 1024) }];
  const f = fixture(undefined, undefined, { prepare: async () => native });
  await f.adapter.add(rendererId, 'large', item('large'));
  const saved = structuredClone(f.engine.document(threadId).rows[0]!), before = f.engine.calls.length, responses = f.engine.responses.length;
  const host = fixture(f.root, f.engine.state, { prepare: async () => { throw new Error('Portable input must not be prepared again'); } });
  await host.adapter.snapshot(rendererId); await host.adapter.claim(rendererId, 'large');
  const input = await host.adapter.preparedInput(rendererId, 'large');
  assertDeepEqual(input, [], 'prepared native input uses a control-only placeholder');
  assertDeepEqual(host.engine.document(threadId).rows[0], saved, 'snapshot and preparation preserve exact native bytes and row version');
  await host.adapter.start(rendererId, 'large', { sessionId: threadId, input, mode: 'start-if-idle', submissionId: 'large-once' }, 1000);
  assertDeepEqual(host.engine.admissions[0]?.row.input, native, 'model admission uses the persisted image bytes');
  assert(host.engine.calls.every(call => call.params.includeInput === false), 'all actual snapshot/prepared/start RPC parameters request metadata projection');
  assertEqual(host.engine.calls.filter(call => call.method === 'thread/queue/update').length, 0, 'control placeholders never rewrite native bytes');
  assert(!host.engine.calls.some(call => 'input' in call.params), 'snapshot/prepared/start never upload replacement input');
  assert(host.engine.calls.every(call => Buffer.byteLength(JSON.stringify(call.params)) < 2048), 'each actual request remains bounded independently of native image size');
  assert(host.engine.responses.every(response => response.bytes < 4096), 'each actual response excludes the large image including nested receipts');
  assertEqual(f.engine.calls.length, before, 'replacement host does not invoke the original preparer or client');
  assertEqual(f.engine.responses.length, responses, 'replacement host uses its own RPC client');
  const start = host.engine.calls.find(call => call.method === 'thread/queue/start')!;
  assertEqual(start.params.expectedInputFingerprint, saved.inputFingerprint, 'start sends the observed native fingerprint');
  assertEqual(start.params.expectedRowVersion, saved.rowVersion, 'start sends the observed row version');
});

h.test('omitted rows require valid fingerprint and version while legacy full rows remain readable', async () => {
  for (const malformed of [{ inputFingerprint: undefined }, { inputFingerprint: 'sha256:' + 'A'.repeat(64) }, { rowVersion: undefined }, { rowVersion: -1 }, { rowVersion: 1.5 }, { rowVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
    const f = fixture(); await f.adapter.add(rendererId, 'bad', item('bad'));
    f.engine.afterCommit = async (method, _params, result) => {
      if (method === 'thread/queue/list') Object.assign(fields((fields(result).data as Json[])[0]), malformed);
    };
    const error = await assertRejects(() => f.adapter.snapshot(rendererId), 'malformed omitted input must reject');
    assert(String(error).includes('invalid queued submission'), 'the malformed projection reports its invalid row');
    assertEqual(f.engine.admissions.length, 0, 'malformed input cannot reach model admission');
  }
  const f = fixture(); await f.adapter.add(rendererId, 'old-full', item('old-full'));
  f.engine.afterCommit = async (method, _params, result) => {
    if (method !== 'thread/queue/list') return;
    const row = fields((fields(result).data as Json[])[0]); Object.assign(row, f.engine.document(threadId).rows[0]);
    delete row.inputOmitted; delete row.inputFingerprint; delete row.rowVersion;
  };
  assertDeepEqual(ids(await f.adapter.snapshot(rendererId)), ['old-full'], 'complete legacy rows without new fences remain readable');
});

for (const change of ['input', 'metadata'] as const) h.test(`a final ${change} change refuses queued start before reservation or model admission`, async () => {
  const f = fixture(); await f.adapter.add(rendererId, 'fenced', item('fenced')); await f.adapter.claim(rendererId, 'fenced');
  const observed = structuredClone(f.engine.document(threadId).rows[0]!);
  f.engine.beforeReserve = async (_params, row) => {
    await f.engine.request('thread/queue/update', { threadId, queuedSubmissionId: row.id,
      ...(change === 'input' ? { input: [{ type: 'text', text: 'external replacement' }] } : { clientMetadata: { item: item('external metadata') } }) });
  };
  const error = fields(await assertRejects(() => f.adapter.start(rendererId, 'fenced', { sessionId: threadId, input: [], mode: 'start-if-idle', submissionId: 'final-fence' }, 1000), 'final reserve must reject a changed row'));
  assertEqual(error.code, 'queue_revision_changed', 'final queue-entry-changed becomes an explicit Host CAS conflict');
  assertEqual(error.kind, 'server', 'the definite refusal cannot be classified as unknown transport admission');
  const row = f.engine.document(threadId).rows[0]!;
  assert(!row.dispatching && !row.pausedReason, 'final refusal neither consumes nor reserves nor pauses the changed row');
  assert(Number(row.rowVersion) > Number(observed.rowVersion), 'actual queue update changes the version');
  assertEqual(row.inputFingerprint === observed.inputFingerprint, change === 'metadata', 'only native input changes its fingerprint');
  assertEqual(f.engine.admissions.length, 0, 'the final fence prevents model input');
  assertEqual(f.engine.calls.filter(call => call.method === 'thread/queue/start').length, 1, 'one final fenced admission RPC was actually attempted');
  await f.adapter.releaseClaim(rendererId, 'fenced');
  assertEqual((await f.adapter.snapshot(rendererId)).items[0]?.pausedReason, null, 'releasing a definite refusal does not create unknown state');
});

h.test('a queue-entry-changed acknowledgement needs the exact submission identity before it can prove a definite refusal', async () => {
  const outcomes: JsonObject[] = [];
  for (const shape of ['missing', 'mismatched']) {
    const f = fixture(), submissionId = 'invalid-cas-ack-' + shape;
    await f.adapter.add(rendererId, 'fenced-ack', item('fenced-ack')); await f.adapter.claim(rendererId, 'fenced-ack');
    f.engine.beforeReserve = async (_params, row) => {
      await f.engine.request('thread/queue/update', { threadId, queuedSubmissionId: row.id, clientMetadata: { item: item('changed-before-reserve') } });
    };
    f.engine.afterCommit = async (method, _params, result) => {
      if (method !== 'thread/queue/start') return;
      const reply = fields(result);
      assertEqual(reply.submissionId, submissionId, 'the real final fence first returns the issued submission identity');
      assertEqual(fields(reply.reason).code, 'queue-entry-changed', 'the test corrupts a real final reserve refusal');
      if (shape === 'missing') delete reply.submissionId;
      else reply.submissionId = 'unrelated-submission';
    };
    const error = fields(await assertRejects(() => f.adapter.start(rendererId, 'fenced-ack', { sessionId: threadId, input: [], mode: 'start-if-idle', submissionId }, 1000), 'an uncorrelated queue refusal cannot prove that this admission was rejected'));
    outcomes.push({ shape, kind: error.kind ?? null, definiteCas: error.code === 'queue_revision_changed' });
    const starts = f.engine.calls.filter(call => call.method === 'thread/queue/start');
    assertEqual(starts.length, 1, shape + ' identity cannot trigger a second queued admission');
    assertEqual(starts[0]?.params.submissionId, submissionId, shape + ' identity is checked against the actual issued request');
    assert(!f.engine.calls.some(call => !call.method.startsWith('thread/queue/')), shape + ' identity cannot fall back to another submission API');
    assertEqual(f.engine.admissions.length, 0, shape + ' corrupted final refusal has no model admission');
  }
  assertDeepEqual(outcomes, [
    { shape: 'missing', kind: 'invalid_ack', definiteCas: false },
    { shape: 'mismatched', kind: 'invalid_ack', definiteCas: false },
  ], 'only an identity-validated queue-entry-changed acknowledgement can become a definite CAS refusal');
});

h.test('Stop after Host preflight fails the final row fence and preserves interruption until explicit Resume', async () => {
  const f = fixture(); await f.adapter.add(rendererId, 'final-stop', item('final-stop')); await f.adapter.claim(rendererId, 'final-stop');
  f.engine.beforeReserve = async (_params, row) => {
    await f.engine.request('thread/queue/pause', { threadId, queuedSubmissionIds: [row.id], reason: INTERRUPTED_QUEUE_REASON });
  };
  const error = fields(await assertRejects(() => f.adapter.start(rendererId, 'final-stop', { sessionId: threadId, input: [], mode: 'start-if-idle', submissionId: 'final-stop' }, 1000), 'Stop between preflight and reserve must reject'));
  assertEqual(error.code, 'queue_revision_changed', 'the final version fence wins before the paused check');
  assertEqual(error.kind, 'server', 'the final Stop refusal is definite');
  const reply = f.engine.responses.findLast(response => response.method === 'thread/queue/start')!;
  assertEqual(fields(fields(reply.result).reason).code, 'queue-entry-changed', 'the actual final reserve reply identifies the stale row');
  const row = f.engine.document(threadId).rows[0]!;
  assertEqual(row.pausedReason, INTERRUPTED_QUEUE_REASON, 'final refusal retains the exact interruption reason');
  assert(!row.dispatching, 'final Stop cannot create an unknown reservation');
  assertEqual(f.engine.admissions.length, 0, 'final Stop prevents model admission');
  await f.adapter.requeueFailed(rendererId, 'final-stop', 'Delivery failed after Stop');
  assertEqual((await f.adapter.snapshot(rendererId)).items[0]?.pausedReason, INTERRUPTED_QUEUE_REASON, 'failure cleanup preserves interruption');
  assertEqual((await f.adapter.claimNext(rendererId)).row, undefined, 'interrupted input cannot resume automatically');
  await f.adapter.resumeInterrupted(rendererId, INTERRUPTED_QUEUE_REASON);
  assertEqual((await f.adapter.claimNext(rendererId)).row?.id, 'final-stop', 'only explicit Resume makes the input claimable');
});

h.test('a paused direct start with current final fences remains a queue-paused refusal', async () => {
  const engine = new FakeEngineQueue();
  const added = fields(await engine.request('thread/queue/add', { threadId, input: [{ type: 'text', text: 'paused' }], clientUserMessageId: 'paused' }));
  await engine.request('thread/queue/pause', { threadId, queuedSubmissionIds: [fields(added.queuedSubmission).id!], reason: INTERRUPTED_QUEUE_REASON });
  const row = engine.document(threadId).rows[0]!;
  const reply = fields(await engine.request('thread/queue/start', { threadId, queuedSubmissionId: row.id, mode: 'start-if-idle', submissionId: 'paused',
    expectedRevision: engine.document(threadId).revision, expectedInputFingerprint: row.inputFingerprint!, expectedRowVersion: row.rowVersion! }));
  assertEqual(fields(reply.reason).code, 'queue-paused', 'a current row fence reaches the paused check');
  assertEqual(row.pausedReason, INTERRUPTED_QUEUE_REASON, 'the paused refusal preserves interruption');
  assertEqual(engine.admissions.length, 0, 'paused direct start never admits model input');
});

h.test('each final fence independently rejects a stale expected value without reserving input', async () => {
  for (const fence of ['expectedInputFingerprint', 'expectedRowVersion']) {
    const engine = new FakeEngineQueue();
    const add = fields(await engine.request('thread/queue/add', { threadId, input: [{ type: 'text', text: 'unchanged' }], clientUserMessageId: fence, clientMetadata: { item: item(fence) } }));
    const row = fields(add.queuedSubmission), saved = structuredClone(engine.document(threadId));
    const result = fields(await engine.request('thread/queue/start', { threadId, queuedSubmissionId: row.id!, mode: 'start-if-idle', submissionId: fence,
      expectedInputFingerprint: row.inputFingerprint!, expectedRowVersion: row.rowVersion!,
      [fence]: fence === 'expectedInputFingerprint' ? 'sha256:' + '0'.repeat(64) : Number(row.rowVersion) + 1, includeInput: false }));
    assertEqual(result.status, 'not-submitted', 'a stale final fence is a definite refusal');
    assertEqual(fields(result.reason).code, 'queue-entry-changed', 'either final fence identifies a changed queue entry');
    assertDeepEqual(engine.document(threadId), saved, 'a stale final fence leaves the durable queue unchanged');
    assertEqual(engine.admissions.length, 0, 'a stale final fence cannot reach model admission');
  }
});

h.test('a replacement preparation acknowledgement must contain a complete valid queue row', async () => {
  for (const malformed of [false, true]) {
    const f = fixture(); await f.adapter.add(rendererId, 'replacement', item('replacement'));
    f.engine.afterCommit = async (method, _params, result) => {
      if (method === 'thread/queue/list') {
        const rows = fields(result).data as Json[];
        for (const value of rows) { const row = fields(value); Object.assign(row, f.engine.document(threadId).rows.find(native => native.id === row.id)); delete row.inputOmitted; }
      }
      if (method === 'thread/queue/update' && malformed) delete fields(fields(result).queuedSubmission).rowVersion;
    };
    await f.adapter.claim(rendererId, 'replacement');
    const start = () => f.adapter.start(rendererId, 'replacement', { sessionId: threadId, input: [{ type: 'text', text: 'new native bytes' }], mode: 'start-if-idle', submissionId: 'replacement' }, 1000);
    if (malformed) {
      const error = await assertRejects(start, 'malformed preparation acknowledgement cannot authorize admission');
      assert(String(error).includes('invalid queued submission'), 'invalid update acknowledgement is explicit');
      assertEqual(f.engine.calls.filter(call => call.method === 'thread/queue/start').length, 0, 'invalid update acknowledgement prevents queue/start');
    } else {
      await start();
      const update = f.engine.responses.find(response => response.method === 'thread/queue/update')!, row = fields(fields(update.result).queuedSubmission);
      const request = f.engine.calls.find(call => call.method === 'thread/queue/start')!;
      assertEqual(request.params.expectedInputFingerprint, row.inputFingerprint, 'replacement start uses the acknowledged native fingerprint');
      assertEqual(request.params.expectedRowVersion, row.rowVersion, 'replacement start uses the acknowledged row version');
      assertDeepEqual(f.engine.admissions[0]?.row.input, [{ type: 'text', text: 'new native bytes' }], 'only confirmed replacement bytes reach model admission');
    }
  }
});

h.test('legacy path preparation updates portable input once and then starts with the refreshed fences', async () => {
  const f = fixture(), legacy = new ClientFollowUpQueue(f.root); legacy.add(rendererId, 'legacy-once', item('legacy-once'));
  await f.adapter.claim(rendererId, 'legacy-once');
  const initial = structuredClone(f.engine.document(threadId).rows[0]!), migrationRevision = f.engine.document(threadId).revision;
  assertDeepEqual(await f.adapter.preparedInput(rendererId, 'legacy-once'), [], 'legacy prepared input also becomes a control placeholder');
  assertDeepEqual(await f.adapter.preparedInput(rendererId, 'legacy-once'), [], 'second preparation uses engine authority');
  assertEqual(f.prepared.length, 1, 'legacy input is prepared exactly once');
  const updates = f.engine.calls.filter(call => call.method === 'thread/queue/update');
  assertEqual(updates.length, 1, 'legacy portable bytes are uploaded in one actual update');
  assertEqual(updates[0]?.params.expectedRevision, migrationRevision, 'legacy update uses its complete migration revision');
  const prepared = structuredClone(f.engine.document(threadId).rows[0]!);
  assertEqual(fields(prepared.clientMetadata).legacyUnprepared, false, 'successful preparation retires the legacy marker');
  assert(Number(prepared.rowVersion) > Number(initial.rowVersion), 'preparation refreshes the row version');
  await f.adapter.start(rendererId, 'legacy-once', { sessionId: threadId, input: [], mode: 'start-if-idle', submissionId: 'legacy-once' }, 1000);
  const start = f.engine.calls.find(call => call.method === 'thread/queue/start')!;
  assertEqual(start.params.expectedRowVersion, prepared.rowVersion, 'start uses the updated preparation fence');
  assertDeepEqual(f.engine.admissions[0]?.row.input, prepared.input, 'prepared legacy native bytes reach model admission');
});

h.test('a definite failed addition recovers a paused presentation without deletion proof and materializes only on explicit claim', async () => {
  const f = fixture(), payload = { ...vector.payload, id: 'refused-add' }, recovery = { id: 'refused-add', item: payload, createdAt: 100, pausedReason: 'The initial addition was refused' };
  const snapshot = await f.adapter.restore(rendererId, recovery, {}, false, undefined, false);
  assertDeepEqual(snapshot.items, [recovery], 'fresh recovery retains the complete paused UI payload');
  assertEqual(f.prepared.length, 0, 'paused recovery does not read attachment bytes before explicit delivery');
  const add = f.engine.calls.find(call => call.method === 'thread/queue/add')!;
  assert(!('restore' in add.params) && !('requireRemovedReceipt' in add.params), 'proof-free recovery is an ordinary named addition');
  assertEqual(fields(add.params.clientMetadata).legacyUnprepared, true, 'recovery persists its explicit deferred preparation marker');
  assertEqual((await f.adapter.claimNext(rendererId)).row, undefined, 'paused recovery cannot deliver automatically');
  await f.adapter.claim(rendererId, recovery.id);
  assertDeepEqual(await f.adapter.preparedInput(rendererId, recovery.id), [], 'explicit recovery materializes engine-owned input');
  await f.adapter.preparedInput(rendererId, recovery.id);
  assertEqual(f.prepared.length, 1, 'explicit recovery prepares the full UI payload exactly once');
  assertDeepEqual(f.prepared[0], payload, 'materialization receives the complete original composer envelope');
  assertEqual(f.engine.calls.filter(call => call.method === 'thread/queue/update').length, 1, 'recovery stores portable native parts in one update');
  assertEqual(f.engine.admissions.length, 0, 'materialization alone cannot issue model input');
  await f.adapter.start(rendererId, recovery.id, { sessionId: threadId, input: [], mode: 'start-if-idle', submissionId: 'recovered-add' }, 1000);
  assertDeepEqual(f.engine.admissions[0]?.row.input, vector.nativeInput, 'only the explicitly materialized bytes are admitted');
  assertEqual(f.engine.admissions.length, 1, 'explicit recovery admits exactly once');
  await f.adapter.restore(rendererId, recovery, {}, false, undefined, false);
  assertDeepEqual(ids(await f.adapter.snapshot(rendererId)), [], 'fresh recovery cannot revive a consumed permanent identity');
});

h.test('clear uses one atomic named RPC and preserves permanent identities without creating Undo proofs', async () => {
  const f = fixture(), addition = { id: 'cleared-add', fingerprint: 'e'.repeat(64) };
  await f.adapter.add(rendererId, 'a', item('a'), {}, addition); await f.adapter.add(rendererId, 'b', item('b'));
  await f.engine.request('thread/queue/import', { threadId, migrationId: 'preserved-import', minimumRevision: 0, queuedSubmissions: [], receipts: [{ mutationId: 'old-removal', kind: 'removal', fingerprint: 'f'.repeat(64), result: {} }] });
  const before = await f.adapter.snapshot(rendererId), document = f.engine.document(threadId), receipt = document.receipts.get('mutation:cleared-add')!, calls = f.engine.calls.length;
  const removed = await f.adapter.clear(rendererId, before.revision), actual = f.engine.calls.slice(calls);
  assertDeepEqual(removed.cleared, before.items, 'clear returns complete UI payloads from the atomic acknowledgement');
  assertDeepEqual(ids(removed.snapshot), [], 'clear reads a fresh authoritative empty snapshot');
  assertEqual(actual.filter(call => call.method === 'thread/queue/clear').length, 1, 'clear issues one atomic RPC');
  assertEqual(actual.filter(call => call.method === 'thread/queue/delete').length, 0, 'clear cannot create per-row deletion proofs');
  const clearIndex = actual.findIndex(call => call.method === 'thread/queue/clear');
  assert(actual.slice(clearIndex + 1).some(call => call.method === 'thread/queue/list'), 'clear acknowledgement is followed by a fresh snapshot');
  assertEqual(actual[clearIndex]?.params.includeInput, false, 'metadata-owned rows clear without reading native bytes');
  assertEqual(actual[clearIndex]?.params.expectedRevision, before.revision, 'atomic clear carries the selected revision');
  assertEqual(document.receipts.get('mutation:cleared-add'), receipt, 'permanent addition receipt identity survives clearing');
  assertEqual(receipt.queuedSubmission, null, 'cleared identities retain no native payload or Undo proof');
  assert(document.legacyReceipts.has('old-removal') && document.migrations.has('preserved-import'), 'clear preserves historical receipts and migration identities');
  assert(![...document.receipts.values()].some(value => value.kind === 'deleted'), 'clear produces no durable deletion proof');
  await assertRejects(() => f.adapter.restore(rendererId, removed.cleared[0]!, {}, false, undefined, true), 'clear cannot authorize Undo');
  await f.adapter.add(rendererId, 'a', item('a'), {}, addition);
  await f.adapter.add(rendererId, 'b', item('b'));
  assertDeepEqual(ids(await f.adapter.snapshot(rendererId)), [], 'replaying either permanent identity cannot revive cleared input');
  assertEqual(f.engine.admissions.length, 0, 'clear and replay cannot send model input');
});

h.test('external rows restore text with exact later-page absolute offsets and full input only for those rows', async () => {
  const f = fixture(); for (const id of ['a', 'b']) await f.adapter.add(rendererId, id, item(id));
  for (const id of ['external-c', 'external-d']) await f.engine.request('thread/queue/add', { threadId, input: [{ type: 'text', text: id + ' text' }], clientUserMessageId: id });
  f.engine.pageSize = 2; const before = f.engine.calls.length, revision = f.engine.document(threadId).revision;
  const snapshot = await f.adapter.snapshot(rendererId), reads = f.engine.calls.slice(before), fallback = reads.filter(call => call.params.includeInput === true);
  assertDeepEqual(ids(snapshot), ['a', 'b', 'external-c', 'external-d'], 'all projected and external rows install in order');
  assertDeepEqual(snapshot.items.slice(2).map(row => row.item.finalText), ['external-c text', 'external-d text'], 'external native text remains visible');
  assertDeepEqual(fallback.map(call => ({ cursor: call.params.cursor, limit: call.params.limit })), [{ cursor: `${revision}:2`, limit: 1 }, { cursor: `${revision}:3`, limit: 1 }], 'only exact revision and absolute offset row reads restore text');
  assert(reads.filter(call => call.params.includeInput === false).length === 2, 'regular pages remain projected');
});

h.test('an external text fallback revision race retries every page without installing mixed text', async () => {
  const f = fixture(); await f.adapter.add(rendererId, 'a', item('a'));
  const added = fields(await f.engine.request('thread/queue/add', { threadId, input: [{ type: 'text', text: 'before race' }], clientUserMessageId: 'external' }));
  f.engine.pageSize = 1; const revision = f.engine.document(threadId).revision; let raced = false;
  f.engine.beforeRequest = async (method, params) => {
    if (method !== 'thread/queue/list' || params.includeInput !== true || raced) return;
    raced = true; await f.engine.request('thread/queue/update', { threadId, queuedSubmissionId: fields(added.queuedSubmission).id!, input: [{ type: 'text', text: 'after race' }] });
  };
  const before = f.engine.calls.length, snapshot = await f.adapter.snapshot(rendererId), reads = f.engine.calls.slice(before).filter(call => call.method === 'thread/queue/list');
  assertEqual(snapshot.items[1]?.item.finalText, 'after race', 'only the complete later revision installs');
  assertEqual(snapshot.revision, revision + 1, 'the returned UI revision owns the restored text');
  assertEqual(reads.filter(call => !call.params.cursor).length, 2, 'a fallback CAS refusal restarts from the first page');
  assertDeepEqual(reads.filter(call => call.params.includeInput === true).map(call => call.params.cursor), [`${revision}:1`, `${revision + 1}:1`], 'retried fallback stays revision-scoped at the same absolute offset');
});

void (async () => {
  const result = await h.finish('result.json', 'engine-client-queue');
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exitCode = result;
})();
