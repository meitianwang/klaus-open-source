// The transcript source for a LIVE session is the complete saved rollout, not the
// engine's model-context snapshot: a compaction must not delete turns the user can
// scroll back to. These tests pin the source switch, the event-driven cache
// invalidation, and the lagging-flush guard that keeps a shorter late read from
// flickering settled rows off the screen.

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Json } from '../main/ipc/contract';
import { SessionService, type EngineAttacherLike, type EngineClientLike } from '../main/sessions/service';
import { HostState } from '../main/services/host-state';
import { ThreadHistoryCache, threadHistoryMetrics, INVALIDATING_EVENT_TYPES } from '../main/sessions/thread-history-cache';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const h = new Harness();
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/thread-history-source-vectors.json'), 'utf8')) as Record<string, Json>;

process.env.KLAUS_TEST = '1';

class FakeClient extends EventEmitter implements EngineClientLike {
  readonly calls: Array<{ method: string; params: Json }> = [];
  private readonly replies = new Map<string, Json>();
  private readonly sequences = new Map<string, Json[]>();
  private readonly sequenceIndex = new Map<string, number>();
  private readonly failures = new Set<string>();
  closed = false;
  private readonly heldReplies = new Map<string, { ready(): void; reply: Promise<Json> }>();
  holdNext(method: string): { started: Promise<void>; release(reply: Json): void } {
    let ready!: () => void, release!: (reply: Json) => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const reply = new Promise<Json>(resolve => { release = resolve; });
    this.heldReplies.set(method, { ready, reply });
    return { started, release };
  }

  reply(method: string, value: Json): this { this.replies.set(method, value); return this; }
  replySequence(method: string, values: Json[]): this {
    this.sequences.set(method, values); this.sequenceIndex.set(method, 0); return this;
  }
  failWith(method: string): this { this.failures.add(method); return this; }

  isClosed(): boolean { return this.closed; }

  async requestWithTimeout(method: string, params: Json): Promise<unknown> {
    this.calls.push({ method, params });
    const held = this.heldReplies.get(method);
    if (held) { this.heldReplies.delete(method); held.ready(); return held.reply; }
    if (this.failures.has(method)) throw new Error(`fake client: ${method} is unreadable`);
    if (method === 'session/prepare' && !this.replies.has(method)) return { sessionId: (params as { sessionId: string }).sessionId, ready: true };
    if (method === 'session/subscribe' && !this.replies.has(method)) return { subscribed: true };
    if (method === 'session/queueSnapshot' && !this.replies.has(method)) return { queueSnapshot: { revision: 0, items: [], status: 'authoritative' } };
    if (method === 'session/resumePending' && !this.replies.has(method)) return { pendingResume: { started: false, reason: 'empty' } };
    if (method === 'session/taskList' && !this.replies.has(method)) return { tasks: [] };
    if (method === 'session/setupLifecycle' && !this.replies.has(method)) return { setupLifecycle: { idempotencyResults: {} } };
    if (method === 'session/subagentLifecycle' && !this.replies.has(method)) return { subagentLifecycle: { agents: [] } };
    if (method === 'session/backgroundProcesses' && !this.replies.has(method)) return { backgroundProcesses: { processes: [] } };
    if (method === 'config/read' && !this.replies.has(method)) return { resolved: {}, sources: {} };
    const sequence = this.sequences.get(method);
    if (sequence !== undefined) {
      const index = this.sequenceIndex.get(method) ?? 0;
      this.sequenceIndex.set(method, index + 1);
      if (index >= sequence.length) throw new Error(`fake client: sequence for ${method} exhausted`);
      return sequence[index];
    }
    if (!this.replies.has(method)) throw new Error(`fake client: no reply scripted for ${method}`);
    return this.replies.get(method);
  }

  sent(method: string): Json[] { return this.calls.filter(call => call.method === method).map(call => call.params); }
}

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'klaus-thread-history-'));
  roots.push(root);
  return root;
}

function serviceWith(client: FakeClient, configRoot: string): { service: SessionService; state: HostState } {
  const state = new HostState();
  const manager: EngineAttacherLike = {
    attach: async () => ({ client, generation: 1 }),
    shutdownAll: async () => { client.closed = true; },
  };
  const service = new SessionService({
    manager, state, spawnOptions: () => ({ command: '/bin/true', args: [], env: [] }),
    pushChatEvents: () => {}, configRoot,
  });
  return { service, state };
}

function userRow(uuid: string, text: string): Json { return { type: 'user', uuid, content: [{ type: 'text', text }] }; }
function assistantRow(uuid: string, text: string): Json { return { type: 'assistant', uuid, content: [{ type: 'text', text }] }; }
function boundaryRow(uuid: string): Json { return { type: 'compact_boundary', uuid, summary: 'saved summary' }; }

function storedReply(rows: Json[], threadId: string): Json {
  return {
    threadId,
    history: rows,
    historyTurnIds: {}, turnFinalMessageIds: {}, turnStatuses: {}, turnStartedAtMs: {},
    turnFinishedAtMs: {}, turnDurations: {}, turnCancelledTools: {}, turnErrors: {},
    turnErrorKinds: {}, agentNotifications: [],
  };
}

h.test('saved turn and item pages never activate a cold conversation', async () => {
  const turn = { id: 'saved-turn', status: 'completed' };
  const page = { hasMore: true, nextCursor: 'older-turn', backwardsCursor: null };
  const client = new FakeClient()
    .reply('engine/readThreadHistory', { ...storedReply([], 'cold') as Record<string, Json>, turns: [turn], page })
    .reply('engine/readThreadItems', { ...storedReply([assistantRow('a1', 'saved answer')], 'cold') as Record<string, Json>, page: { hasMore: false, nextCursor: null } });
  const { service, state } = serviceWith(client, freshRoot());
  try {
    const shell = await service.historyPage('cold', { limit: 5, itemsView: 'notLoaded', sortDirection: 'desc' }) as Record<string, Json>;
    assertDeepEqual(shell.turns, [turn], 'the saved shell is delivered without a provider binding');
    assertDeepEqual(shell.page, page, 'the older cursor is preserved');
    const items = await service.historyItems('cold', { turnId: 'saved-turn', cursor: 'item-cursor', limit: 10, sortDirection: 'desc' }) as Record<string, Json>;
    assertEqual((items.messages as Array<Record<string, Json>>)[0]!.text, 'saved answer', 'saved items remain readable');
    assertDeepEqual(client.calls, [
      { method: 'engine/readThreadHistory', params: { threadId: 'cold', limit: 5, itemsView: 'notLoaded', sortDirection: 'desc' } },
      { method: 'engine/readThreadItems', params: { threadId: 'cold', turnId: 'saved-turn', cursor: 'item-cursor', limit: 10, sortDirection: 'desc' } },
    ], 'no provider resolution, session start, or activation snapshot is admitted');
    assertEqual(state.liveSession('cold'), undefined, 'inspection leaves the cold conversation unloaded');
    assertEqual((vectors.source as Record<string, Json>).renderReadActivation, 'none', 'the committed contract keeps saved paging independent of activation');
  } finally { await service.shutdown(); }
});

h.test('cold summary and single-item pages retain display companions without activation or an extra read', async () => {
  const localRender = { displayText: 'inspect assets', media: [{ type: 'directory', path: '/project/assets' }], composerDocument: { version: 1, content: [] } };
  const user = userRow('user-a', 'native input');
  const display = { type: 'system', uuid: 'display-a', subtype: 'user_display', text: JSON.stringify({ messageUuid: 'user-a', localRender }) };
  const firstPage = { hasMore: true, nextCursor: 'display-page' };
  const client = new FakeClient()
    .reply('engine/readThreadHistory', { ...storedReply([user], 'cold') as Record<string, Json>, presentationRecords: [display], turns: [{ id: 'saved-turn' }], page: firstPage })
    .replySequence('engine/readThreadItems', [
      { ...storedReply([user], 'cold') as Record<string, Json>, presentationRecords: [display], page: firstPage },
      { ...storedReply([display], 'cold') as Record<string, Json>, page: { hasMore: false, nextCursor: null } },
    ]);
  const { service, state } = serviceWith(client, freshRoot());
  try {
    const summary = await service.historyPage('cold', { itemsView: 'summary', limit: 1 }) as Record<string, Json>;
    const items = await service.historyItems('cold', { turnId: 'saved-turn', limit: 1 }) as Record<string, Json>;
    for (const reply of [summary, items]) {
      const messages = reply.messages as Array<Record<string, Json>>;
      assertEqual(messages.length, 1, 'the companion stays outside visible message membership');
      assertDeepEqual(messages[0]!.localRender, localRender, 'both paths preserve the exact same display envelope');
      assertDeepEqual(reply.page, firstPage, 'the raw engine cursor is passed through');
    }
    const second = await service.historyItems('cold', { turnId: 'saved-turn', cursor: 'display-page', limit: 1 }) as Record<string, Json>;
    assertDeepEqual(second.messages, [], 'an envelope-only following page does not duplicate the user');
    assertEqual(client.calls.length, 3, 'three bounded reads satisfy all three requests without companion fetches');
    assert(client.calls.every(call => call.method === 'engine/readThreadHistory' || call.method === 'engine/readThreadItems'), 'presentation hydration does not activate the engine session');
    assertEqual(state.liveSession('cold'), undefined, 'the inspected conversation remains cold');
  } finally { await service.shutdown(); }
});

for (const method of ((vectors.source as Record<string, Json>).planningArtifactCapture as Record<string, Json>).methods as string[]) {
  h.test(`${method} retains plans and bounded metadata from one coherent saved capture`, async () => {
    const page = (cut: number): Json => ({
      ...storedReply([assistantRow('a1', 'Before\n<proposed_plan>\nOriginal proposal\n</proposed_plan>\nAfter')], 'cold') as Record<string, Json>,
      historyTurnIds: { a1: 'saved-turn' },
      page: { hasMore: true, nextCursor: `cursor-${cut}` },
      turns: [{ id: 'saved-turn', status: 'completed', cut }],
    });
    const snapshot = (revision: number): Json => ({ planning: { mode: 'plan', revision, questions: [], plans: [{
      id: 'artifact', threadId: 'cold', turnId: 'saved-turn', revision,
      content: `# Edited proposal ${revision}`, status: 'proposed',
    }] } });
    const client = new FakeClient().replySequence(method, [page(0), page(1), page(2)])
      .replySequence('session/plans', [snapshot(1), snapshot(2), snapshot(2), snapshot(2)]);
    const { service, state } = serviceWith(client, freshRoot());
    const params = { threadId: 'cold', cursor: 'requested-cursor', limit: 3, sortDirection: 'desc',
      ...(method === 'engine/readThreadHistory' ? { itemsView: 'full' } : { turnId: 'saved-turn' }) };
    try {
      const reply = await (method === 'engine/readThreadHistory'
        ? service.historyPage('cold', params) : service.historyItems('cold', { ...params, turnId: 'saved-turn' })) as Record<string, Json>;
      const message = (reply.messages as Array<Record<string, Json>>)[0]!;
      assertDeepEqual((message.contentBlocks as Array<Record<string, Json>>).map(block => block.type === 'proposed_plan' ? 'PLAN' : block.text), ['Before\n', 'PLAN', 'After'], 'surrounding prose retains its original order');
      const block = (message.contentBlocks as Array<Record<string, Json>>).find(block => block.type === 'proposed_plan');
      assert(block, 'saved content restores the structured artifact instead of raw markup');
      assertEqual((block.plan as Record<string, Json>).content, '# Edited proposal 2', 'the accepted artifact revision owns the card');
      assertDeepEqual(reply.page, { hasMore: true, nextCursor: 'cursor-2' }, 'cursor comes from the accepted page rather than an unstable cut');
      if (method === 'engine/readThreadHistory') assertDeepEqual(reply.turns, [{ id: 'saved-turn', status: 'completed', cut: 2 }], 'turn shells come from the accepted cut');
      assertDeepEqual(client.sent(method), [params, params, params], 'every retry retains the original page budget and cursor');
      assert(client.calls.every(call => call.method === method || call.method === 'session/plans'), 'the join stays on saved read facades');
      assertEqual(state.liveSession('cold'), undefined, 'artifact recovery never activates a cold conversation');
    } finally { await service.shutdown(); }
  });
  h.test(`${method} rejects a saved page from a disconnected engine client`, async () => {
    const client = new FakeClient(), held = client.holdNext(method);
    const { service } = serviceWith(client, freshRoot());
    try {
      const pending = method === 'engine/readThreadHistory' ? service.historyPage('cold') : service.historyItems('cold', { turnId: 'saved-turn' });
      await held.started;
      client.closed = true;
      held.release(storedReply([], 'cold'));
      await assertRejects(() => pending, 'the retired client cannot publish its page');
      assertEqual(client.calls.length, 1, 'the retired read admits no planning or replacement request');
    } finally { await service.shutdown(); }
  });
}

h.test('saved change records walk metadata pages without reading message bodies', async () => {
  const older = { turnId: 'older', files: [{ path: '/p/old.ts', added: 2, removed: 0, kind: 'modify', turnDiff: 'saved diff' }] };
  const newer = { turnId: 'newer', files: [{ path: '/p/new.ts', added: null, removed: null, kind: 'create', turnDiff: null }] };
  const client = new FakeClient().replySequence('engine/readThreadHistory', [
    { fileChanges: [newer], page: { hasMore: true, nextCursor: 'older-page' } },
    { fileChanges: [older], page: { hasMore: false, nextCursor: null } },
  ]);
  const { service } = serviceWith(client, freshRoot());
  try {
    assertDeepEqual(await service.fileChanges('cold'), { fileChanges: [older, newer] }, 'saved counts, unknown values, diffs and turn order survive');
    assertDeepEqual(client.calls, [
      { method: 'engine/readThreadHistory', params: { threadId: 'cold', itemsView: 'notLoaded', sortDirection: 'desc', limit: 100 } },
      { method: 'engine/readThreadHistory', params: { threadId: 'cold', itemsView: 'notLoaded', sortDirection: 'desc', limit: 100, cursor: 'older-page' } },
    ], 'only bounded metadata reads are issued');
  } finally { await service.shutdown(); }
});

h.test('saved change records refuse repeated cursors and unsupported metadata', async () => {
  for (const replies of [
    [{ fileChanges: [], page: { hasMore: true, nextCursor: 'same' } }, { fileChanges: [], page: { hasMore: true, nextCursor: 'same' } }],
    [{ history: [], page: { hasMore: false } }],
  ]) {
    const client = new FakeClient().replySequence('engine/readThreadHistory', replies);
    const { service } = serviceWith(client, freshRoot());
    try {
      await assertRejects(() => service.fileChanges('cold'), 'an incomplete saved record is not passed off as authoritative emptiness');
      assert(client.calls.every(call => call.method === 'engine/readThreadHistory'), 'failure never activates a model or falls back to a whole read');
    } finally { await service.shutdown(); }
  }
});

h.test('live change records retain their existing mapped runtime source', async () => {
  const reply = { fileChanges: [{ turnId: 'live-turn', files: [] }] };
  const client = new FakeClient().reply('session/fileChanges', reply);
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conv', 'live-engine', {});
  try {
    assertDeepEqual(await service.fileChanges('conv'), reply, 'live records stay authoritative');
    assertDeepEqual(client.calls, [{ method: 'session/fileChanges', params: { sessionId: 'live-engine' } }], 'inspection uses the existing binding');
  } finally { await service.shutdown(); }
});

const PRE_COMPACT = [userRow('u1', 'question before compaction'), assistantRow('a1', 'answer before compaction')];
const POST_COMPACT = [userRow('u2', 'question after compaction'), assistantRow('a2', 'answer after compaction')];
const FULL_ROWS = [...PRE_COMPACT, boundaryRow('b1'), ...POST_COMPACT];

/** The projected chat event one settled assistant message produces. */
function settledMessageEvent(messageId: string): Json {
  return { type: 'productEvent', method: 'item/updated', params: { sessionId: 'conv', item: { type: 'agent_message', id: messageId, phase: 'final_answer' } } };
}

h.test('a live transcript reads the complete saved rollout, not the model context', async () => {
  const client = new FakeClient()
    .reply('engine/readThreadHistory', storedReply(FULL_ROWS, 'conv'))
    .reply('session/history', storedReply(POST_COMPACT, 'conv'));
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conv', 'engine-1', {});
  const projected = await service.history('conv') as Record<string, Json>;
  const messages = projected.messages as Array<Record<string, Json>>;
  assertDeepEqual(messages.map(row => row.kind ?? row.role), ['user', 'assistant', 'compaction', 'user', 'assistant'],
    'pre-compaction turns and the boundary divider render, in rollout order, without any summary body');
  assertDeepEqual(messages.map(row => row.text).filter(Boolean),
    ['question before compaction', 'answer before compaction', 'question after compaction', 'answer after compaction'],
    'the pre-compaction dialogue renders verbatim and the boundary carries no summary text');
  assertEqual(client.sent('engine/readThreadHistory').length, 1, 'the live transcript uses the saved projection');
  assertEqual(client.sent('session/history').length, 0, 'the model-context snapshot is not the transcript source');
  await service.shutdown();
});

h.test('a settled message poisons the capture so the next read sees the new rows', async () => {
  const client = new FakeClient().replySequence('engine/readThreadHistory', [
    storedReply(FULL_ROWS, 'conv'),
    storedReply([...FULL_ROWS, assistantRow('a3', 'settled reply')], 'conv'),
  ]);
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conv', 'engine-1', {});
  const first = await service.history('conv') as Record<string, Json>;
  assertEqual((first.messages as Json[]).length, 5, 'the full transcript renders');
  // A second read inside the TTL serves the cache: nothing proved the rollout moved.
  const cached = await service.history('conv') as Record<string, Json>;
  assertEqual((cached.messages as Json[]).length, 5, 'the cache serves the same rows');
  assertEqual(client.sent('engine/readThreadHistory').length, 1, 'an unpoisoned capture is served from cache');
  client.emit('event', settledMessageEvent('a3'));
  const second = await service.history('conv') as Record<string, Json>;
  assertEqual((second.messages as Json[]).length, 6, 'the settled reply joins the transcript');
  assertEqual(client.sent('engine/readThreadHistory').length, 2, 'the projected event poisoned the capture');
  await service.shutdown();
});

for (const entry of vectors.terminalGoalNotifications as Array<{ name: string; params: Json }>) {
  h.test(`terminal goal notification refreshes a cached empty transcript: ${entry.name}`, async () => {
    const completed = { threadId: 'conv', goalId: 'completed-without-model', objective: 'Retain the externally completed objective.',
      status: 'complete', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAtMs: 1, updatedAtMs: 2 };
    const client = new FakeClient().replySequence('engine/readThreadHistory', [
      storedReply([], 'conv'),
      { ...storedReply([], 'conv') as Record<string, Json>, goalCompletions: [{ goal: completed, goalRevision: 2 }] },
    ]);
    const { service, state } = serviceWith(client, freshRoot());
    state.rememberSession('conv', 'engine-1', {});
    try {
      assertEqual(((await service.history('conv') as Record<string, Json>).messages as Json[]).length, 0, 'the original empty transcript is cached');
      client.emit('event', { type: 'rawSessionEvent', params: { threadId: 'conv', event: { threadGoal: { ...completed, status: 'paused' }, goalRevision: 1 } } });
      await service.history('conv');
      assertEqual(client.sent('engine/readThreadHistory').length, 1, 'an unchanged stopped objective does not rewrite transcript history');
      client.emit('event', { type: 'rawSessionEvent', params: entry.params });
      const next = await service.history('conv') as Record<string, Json>;
      const blocks = (next.messages as Array<Record<string, Json>>).flatMap(message => message.contentBlocks as Array<Record<string, Json>>);
      assertEqual(blocks.length, 1, 'completion-only history supplies one chronological block');
      assertEqual(blocks[0]!.type, 'goal_completion', 'the stored completion is projected');
      assertDeepEqual(blocks[0]!.goal, completed, 'the complete authoritative snapshot is retained');
      assertEqual(client.sent('engine/readThreadHistory').length, 2, 'the terminal notification refreshes history inside the original cache TTL');
      assertEqual(client.sent('session/history').length, 0, 'refresh never activates or uses a model-context fallback');
    } finally { await service.shutdown(); }
  });
}

h.test('a lagging flush never shortens a transcript already on screen', async () => {
  const client = new FakeClient().replySequence('engine/readThreadHistory', [
    storedReply(FULL_ROWS, 'conv'),
    storedReply(PRE_COMPACT, 'conv'), // a capture that missed the flush of the tail
    storedReply(FULL_ROWS, 'conv'),
  ]);
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conv', 'engine-1', {});
  const first = await service.history('conv') as Record<string, Json>;
  assertEqual((first.messages as Json[]).length, 5, 'the full transcript renders');
  client.emit('event', settledMessageEvent('a2'));
  const second = await service.history('conv') as Record<string, Json>;
  assertEqual((second.messages as Json[]).length, 5, 'the shorter lagging capture is refused, the served one stays');
  client.emit('event', settledMessageEvent('a2'));
  const third = await service.history('conv') as Record<string, Json>;
  assertEqual((third.messages as Json[]).length, 5, 'once the disk catches up the fresh capture is served');
  assertEqual(client.sent('engine/readThreadHistory').length, 3, 'each poisoned capture forces one disk read');
  await service.shutdown();
});

h.test('the engine snapshot answers only when the rollout is unreadable', async () => {
  const client = new FakeClient()
    .failWith('engine/readThreadHistory')
    .reply('session/history', storedReply(POST_COMPACT, 'conv'));
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conv', 'engine-1', {});
  const projected = await service.history('conv') as Record<string, Json>;
  const messages = projected.messages as Array<Record<string, Json>>;
  assertDeepEqual(messages.map(row => row.text), ['question after compaction', 'answer after compaction'], 'only the snapshot rows render');
  assertEqual(client.sent('session/history').length, 1, 'the snapshot is the fallback, not the source');
  await service.shutdown();
});

h.test('a lost engine connection retires every cached capture', async () => {
  const client = new FakeClient().reply('engine/readThreadHistory', storedReply(FULL_ROWS, 'conv'));
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conv', 'engine-1', {});
  await service.history('conv');
  assertEqual(client.sent('engine/readThreadHistory').length, 1, 'the first read hit the disk');
  client.emit('event', { type: 'streamClosed' });
  await service.history('conv');
  assertEqual(client.sent('engine/readThreadHistory').length, 2, 'a new generation cannot serve the old capture');
  await service.shutdown();
});

h.test('the export keeps the turns a compaction retired', async () => {
  const client = new FakeClient().reply('engine/readThreadHistory', storedReply(FULL_ROWS, 'conv'));
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conv', 'engine-1', {});
  const exported = await service.exportMessages('conv') as Array<Record<string, Json>>;
  assertDeepEqual(exported.map(row => row.uuid), ['u1', 'a1', 'b1', 'u2', 'a2'], 'export is the saved rollout, boundaries included');
  await service.shutdown();
});

h.test('the cache invalidation discipline matches the committed vector', () => {
  assertDeepEqual([...INVALIDATING_EVENT_TYPES].sort(), [...(vectors.invalidatingEventTypes as string[])].sort(),
    'the projected event types that poison a capture are pinned by the vector');
  const retention = (vectors.cache as Record<string, Json>).retention as Record<string, Json>;
  const bounded = new ThreadHistoryCache();
  for (let i = 0; i < Number(retention.maxEntries) + 1; i++) bounded.store(String(i), { reply: {}, capturedAt: 0, rowCount: 0, boundaryCount: 0 });
  assertEqual(bounded.diagnostics().entries, Number(retention.maxEntries), 'the entry budget is pinned by the retention vector');
  assert(bounded.diagnostics().retainedBytes <= Number(retention.maxEstimatedBytes), 'the byte budget is pinned by the retention vector');
  const cacheCases = (vectors.cache as Record<string, Json>).cases as Array<Record<string, Json>>;
  for (const testCase of cacheCases) {
    const input = testCase.input as Record<string, Json>;
    const cache = new ThreadHistoryCache();
    const entry = input.entry as Record<string, Json> | undefined;
    if (entry) cache.store('s', { reply: entry.reply as Record<string, Json>, capturedAt: Number(entry.capturedAt), rowCount: Number(entry.rowCount), boundaryCount: Number(entry.boundaryCount ?? 0) });
    if (input.poisoned === true) cache.noteProjectedEvent('s', 'message_complete');
    const usable = cache.usable('s', Number(input.now), Number(input.minRows ?? 0));
    assertEqual(usable !== undefined, testCase.expected, `cache case ${String(testCase.name)}`);
  }
  const metrics = threadHistoryMetrics(storedReply(FULL_ROWS, 'conv') as Record<string, Json>);
  assertDeepEqual(metrics, { rowCount: 5, boundaryCount: 1 }, 'metrics count rows and boundaries for the lagging-flush guard');
});

h.test('payload eviction keeps lightweight flush watermarks and follows the byte and entry budgets', () => {
  const cache = new ThreadHistoryCache({ maxEntries: 2, maxBytes: 4096 });
  const entry = (rows: number) => ({ reply: { history: [{ text: 'x'.repeat(512) }] }, capturedAt: 1000, rowCount: rows, boundaryCount: 0 });
  cache.store('first', entry(5)); cache.store('second', entry(2)); cache.peek('first'); cache.store('third', entry(3));
  assertEqual(cache.peek('second'), undefined, 'least recently read payload is released');
  assertEqual(cache.watermark('second')?.rowCount, 2, 'eviction keeps only the flush watermark');
  assert(cache.diagnostics().entries <= 2 && cache.diagnostics().retainedBytes <= 4096, 'both payload budgets hold');
  const single = new ThreadHistoryCache({ maxEntries: 10, maxBytes: cache.diagnostics().retainedBytes / 2 + 1 });
  single.store('one', entry(1)); single.store('two', entry(2));
  assertEqual(single.diagnostics().entries, 1, 'the byte budget evicts even below the entry limit');
  cache.store('large', { ...entry(20), reply: { history: [{ text: 'y'.repeat(4096) }] } });
  assertEqual(cache.peek('large'), undefined, 'an oversized reply is served without keeping its payload');
  assertEqual(cache.watermark('large')?.rowCount, 20, 'an oversized reply still records the complete capture');
  cache.usable('first', 31001, 0);
  assertEqual(cache.peek('first'), undefined, 'expiry releases the full payload');
  assertEqual(cache.watermark('first')?.rowCount, 5, 'expiry retains the no-regression guard');
});

h.test('close and generation changes fence in-flight captures without retaining old lifetime markers', () => {
  const cache = new ThreadHistoryCache(), capture = cache.capture('s');
  const entry = { reply: { history: [] }, capturedAt: 0, rowCount: 0, boundaryCount: 0 };
  cache.store('s', entry, capture); cache.invalidateSession('s');
  assertEqual(cache.store('s', entry, capture), false, 'a late closed-session reply cannot repopulate the cache');
  assertDeepEqual(cache.diagnostics(), { entries: 0, retainedBytes: 0, watermarks: 0 }, 'normal close releases payload and metadata');
  const next = cache.capture('s'); cache.invalidateGeneration(2);
  assertEqual(next.current(), false, 'engine replacement invalidates an admitted read');
});

h.test('an evicted transcript retries a lagging saved read instead of dropping displayed rows', async () => {
  const client = new FakeClient().replySequence('engine/readThreadHistory', [storedReply(FULL_ROWS, 'conv'), storedReply(PRE_COMPACT, 'conv'), storedReply(FULL_ROWS, 'conv')]);
  const { service, state } = serviceWith(client, freshRoot());
  const cache = new ThreadHistoryCache({ maxEntries: 0 });
  Reflect.set(service, 'threadHistoryCache', cache);
  state.rememberSession('conv', 'engine-1', {});
  assertEqual(((await service.history('conv') as Record<string, Json>).messages as Json[]).length, 5, 'first complete capture renders');
  assertEqual(cache.diagnostics().entries, 0, 'the payload was not retained');
  assertEqual(((await service.history('conv') as Record<string, Json>).messages as Json[]).length, 5, 'the retry preserves all saved rows');
  assertEqual(client.sent('engine/readThreadHistory').length, 3, 'only the shortened saved capture is retried');
  await service.shutdown();
});

h.test('a bounded cache never substitutes shortened model context when the saved flush has not caught up', async () => {
  const client = new FakeClient().replySequence('engine/readThreadHistory', [storedReply(FULL_ROWS, 'conv'), storedReply(PRE_COMPACT, 'conv'), storedReply(PRE_COMPACT, 'conv'), storedReply(PRE_COMPACT, 'conv')]).reply('session/history', storedReply(PRE_COMPACT, 'conv'));
  const { service, state } = serviceWith(client, freshRoot());
  Reflect.set(service, 'threadHistoryCache', new ThreadHistoryCache({ maxEntries: 0 }));
  state.rememberSession('conv', 'engine-1', {});
  await service.history('conv');
  await assertRejects(() => service.history('conv'), 'a lagging full projection cannot clear rows already displayed');
  await service.shutdown();
});

h.test('idle live-session retirement releases transcript payloads and watermarks', async () => {
  const client = new FakeClient().reply('engine/readThreadHistory', storedReply(FULL_ROWS, 'a-retired')).reply('session/close', {});
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('a-retired', 'engine-old', {});
  await service.history('a-retired');
  for (let i = 0; i < 6; i++) state.rememberSession('z-keep-' + i, 'engine-keep-' + i, {});
  await service.resolveLiveSession('z-keep-5');
  await waitFor(() => !state.liveSession('a-retired'), 1000, 'idle retirement completed');
  const cache = Reflect.get(service, 'threadHistoryCache') as ThreadHistoryCache;
  assertEqual(cache.peek('a-retired'), undefined, 'retired history payload is released');
  assertEqual(cache.watermark('a-retired'), undefined, 'retired watermark is released');
  await service.shutdown();
});

h.test('a history read finishing after idle retirement cannot recreate its released cache', async () => {
  const client = new FakeClient().reply('engine/readThreadHistory', storedReply(FULL_ROWS, 'conv')).reply('session/close', {});
  const { service, state } = serviceWith(client, freshRoot());
  state.rememberSession('conv', 'engine-old', {});
  await service.history('conv');
  client.emit('event', settledMessageEvent('a2'));
  const held = client.holdNext('engine/readThreadHistory');
  const pending = service.history('conv'); void pending.catch(() => {});
  await held.started;
  for (let i = 0; i < 6; i++) state.rememberSession('z-keep-' + i, 'engine-keep-' + i, {});
  await service.resolveLiveSession('z-keep-5');
  await waitFor(() => !state.liveSession('conv'), 1000, 'idle retirement completes without waiting for the saved read');
  held.release(storedReply(FULL_ROWS, 'conv'));
  await assertRejects(() => pending, 'a stale read cannot publish after its live owner closes');
  const cache = Reflect.get(service, 'threadHistoryCache') as ThreadHistoryCache;
  assertEqual(cache.peek('conv'), undefined, 'the late response has no retained payload');
  assertEqual(cache.watermark('conv'), undefined, 'the late response has no retained watermark');
  await service.shutdown();
});

h.test('temp roots are cleaned', async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

void h.finish(join(__dirname, 'thread-history-source-result.json'), 'thread-history-source').then(code => { process.exitCode = code; });
