// Conversation search for the composer menu.
//
// The menu must stay a bounded search: an empty query returns nothing, the host
// filters its existing catalog snapshot, and only `{id,title}` rows cross IPC.
// These tests pin that contract plus cursor behaviour across snapshot updates.

process.env.KLAUS_TEST = '1';

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';
import { HostState } from '../main/services/host-state';
import { SessionService, type EngineAttacherLike, type EngineClientLike } from '../main/sessions/service';
import type { RpcRequestOptions } from '../main/engine/request-scheduler';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerSessionHandlers } from '../main/ipc/handlers/sessions';
import { withSettingsDb } from '../main/services/settings';
import { writeSessionListSnapshot } from '../main/services/session-list-cache';
import type { SessionEventPump } from '../main/sessions/events';
import { MentionTitleOverrides, SessionMentionCatalog } from '../main/services/session-mention-catalog';
import {
  buildSessionMentionEntries,
  decodeSessionMentionCursor,
  encodeSessionMentionCursor,
  normalizeSessionMentionQuery,
  pageSessionMentions,
  sessionMentionMatches,
  sessionMentionRank,
} from '../shared/session-mentions';

const h = new Harness();

interface Call { method: string; params: Json }

class CatalogClient extends EventEmitter implements EngineClientLike {
  readonly calls: Call[] = [];
  private pages: Json[] = [];
  private sequence: Json[] = [];
  closed = false;
  failCatalog = false;
  gate?: Promise<void>;

  reply(items: Json[], nextCursor: string | null = null): this {
    this.pages = [{ sessions: { items, nextCursor } }];
    return this;
  }

  replyPages(pages: Json[]): this {
    this.pages = pages;
    return this;
  }

  replySequence(pages: Json[]): this {
    this.sequence = [...pages];
    return this;
  }

  isClosed(): boolean { return this.closed; }

  async requestWithTimeout(method: string, params: Json, _timeoutMs?: number, _options?: RpcRequestOptions): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'session/updateTitle') {
      const value = params as Record<string, Json>;
      return { title: { threadId: value.threadId, title: value.title } };
    }
    if (method !== 'engine/listSessions') throw new Error(`unexpected method ${method}`);
    if (this.failCatalog) throw new Error('catalog temporarily unavailable');
    if (this.gate) await this.gate;
    if (this.sequence.length) return this.sequence.shift();
    const page = this.pages.length > 1 ? this.pages.shift()! : this.pages[0];
    return page ?? { sessions: { items: [], nextCursor: null } };
  }
}

const roots: string[] = [];

function serviceWith(client: CatalogClient, overrides: { isPrivateThread?: (id: string) => boolean } = {}): {
  service: SessionService; state: HostState; root: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'klaus-session-mentions-'));
  roots.push(root);
  const state = new HostState();
  const manager: EngineAttacherLike = {
    attach: async () => ({ client, generation: 1 }),
    shutdownAll: async () => { client.closed = true; },
  };
  const service = new SessionService({
    manager,
    state,
    spawnOptions: () => ({ command: '/bin/true', args: [], env: [] }),
    pushChatEvents: () => {},
    configRoot: root,
    ...overrides,
  });
  return { service, state, root };
}

function row(id: string, title: string, recencyAt: number, extra: Record<string, Json> = {}): Json {
  return { id, title, recencyAt, updatedAt: recencyAt, ...extra };
}

h.test('an empty search returns nothing and never reads the engine catalog', async () => {
  const client = new CatalogClient();
  const { service } = serviceWith(client);
  assertDeepEqual(await service.mentionCandidates({ query: '   ' }), { items: [], nextCursor: null },
    'whitespace is an empty search');
  assertDeepEqual(await service.mentionCandidates(), { items: [], nextCursor: null }, 'omitting the query is empty too');
  assertEqual(normalizeSessionMentionQuery('\t Alpha  plan \n'), 'Alpha plan', 'queries normalize whitespace');
  assertEqual(client.calls.length, 0, 'the engine catalog was not read');
});

h.test('matching accepts a case-insensitive substring or an in-order subsequence', () => {
  assert(sessionMentionMatches('Quarterly alpha plan', 'ALPHA'), 'substring ignores case');
  assert(sessionMentionMatches('Quarterly alpha plan', 'qal'), 'the query characters appear in order');
  assert(!sessionMentionMatches('Quarterly alpha plan', 'zzz'), 'unrelated characters do not match');
  assert(!sessionMentionMatches('Quarterly alpha plan', ''), 'an empty needle never matches');
  assert(sessionMentionMatches('会话引用菜单', '引用'), 'CJK titles match by substring');
});

h.test('relevance ranks exact, prefix, substring and subsequence before recency', () => {
  const entries = buildSessionMentionEntries([
    row('subsequence', 'A l p h a', 400),
    row('substring-old', 'Old Alpha notes', 300),
    row('prefix', 'Alpha roadmap', 200),
    row('exact', 'Alpha', 100),
    row('substring-new', 'Fresh Alpha', 500),
  ]);
  const page = pageSessionMentions({ entries, query: 'alpha', limit: 50, revision: 1 });
  assertDeepEqual(page.items.map(item => item.id), ['exact', 'prefix', 'substring-new', 'substring-old', 'subsequence'],
    'tiers outrank recency, and equal tiers keep recency order');
  assertEqual(sessionMentionRank('Alpha', 'alpha'), 0, 'exact');
  assertEqual(sessionMentionRank('Alpha roadmap', 'alpha'), 1, 'prefix');
  assertEqual(sessionMentionRank('Old Alpha notes', 'alpha'), 2, 'substring');
  assertEqual(sessionMentionRank('A l p h a', 'alpha'), 3, 'subsequence');
  assertEqual(sessionMentionRank('Unrelated', 'alpha'), null, 'no match');
});

h.test('a very old exact title is not hidden behind ten thousand newer loose matches', () => {
  const rows: Json[] = [];
  for (let index = 0; index < 5000; index += 1) rows.push(row(`prefix-${index}`, `Release checklist ${index}`, 20000 - index));
  for (let index = 0; index < 5000; index += 1) rows.push(row(`substring-${index}`, `Pre-release checklist ${index}`, 10000 - index));
  rows.push(row('old-exact', 'Release checklist', 1));
  const entries = buildSessionMentionEntries(rows);
  const page = pageSessionMentions({ entries, query: 'release checklist', limit: 50, revision: 1 });
  assertEqual(page.items.length, 50, 'the page still stops at fifty');
  assertEqual(page.items[0]!.id, 'old-exact', 'the exact title leads despite being the oldest row');
  assertEqual(page.items.filter(item => item.id === 'old-exact').length, 1, 'it appears once');
});

h.test('a title written while a snapshot read is in flight survives its pruning pass', () => {
  const overrides = new MentionTitleOverrides();
  const through = overrides.capture();
  overrides.set('thread', 'During read');
  overrides.prune(through);
  assertEqual(overrides.get('thread'), 'During read', 'a newer write is not pruned by an older read');
  overrides.prune(overrides.capture());
  assertEqual(overrides.get('thread'), undefined, 'a later read converges over it');
});

h.test('a local rename yields to the converged snapshot and a later external rename', async () => {
  const client = new CatalogClient().replySequence([
    { sessions: { items: [row('thread', 'Original', 10)], nextCursor: null } },
    { sessions: { items: [row('thread', 'Original', 10)], nextCursor: null } },
    { sessions: { items: [row('thread', 'Original', 10)], nextCursor: null } },
  ]);
  const { service, root } = serviceWith(client);
  await service.listSessions();
  await service.rename('thread', 'Local rename');
  assertDeepEqual((await service.mentionCandidates({ query: 'Local rename' })).items.map(item => item.id), ['thread'],
    'the acknowledged local title is visible before the catalog refreshes');

  await service.listSessions();
  withSettingsDb(root, db => {
    db.prepare('UPDATE session_titles SET title = ?, source = ? WHERE session_id = ?').run('External rename', 'custom', 'thread');
  });
  await service.listSessions();

  assertDeepEqual((await service.mentionCandidates({ query: 'External rename' })).items.map(item => item.id), ['thread'],
    'the converged snapshot wins once the temporary override is pruned');
  assertDeepEqual((await service.mentionCandidates({ query: 'Local rename' })).items, [],
    'the stale local title no longer masks the external one');
});

h.test('a maximum Unicode query with a full id window still encodes inside one cursor', () => {
  const ids = Array.from({ length: 64 }, (_, index) => `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`);
  const query = '会'.repeat(256);
  const cursor = encodeSessionMentionCursor({ query, revision: 7, id: ids[ids.length - 1]!, seen: ids });
  assert(new TextEncoder().encode(cursor).length <= 4096, 'the encoded cursor stays inside the shared byte limit');
  const decoded = decodeSessionMentionCursor(cursor);
  assert(decoded, 'the clipped cursor still decodes');
  assertEqual(decoded!.query, query, 'the query survives intact');
  assertEqual(decoded!.revision, 7, 'the revision survives');
  assertEqual(decoded!.id, ids[ids.length - 1], 'the anchor id survives');
  assert(decoded!.seen.length < ids.length, 'the oldest seen ids were dropped');
  assertEqual(decoded!.seen[decoded!.seen.length - 1], ids[ids.length - 1], 'the newest seen id is retained');
});

h.test('the snapshot index sorts by recency with a stable id tie-break and drops duplicate ids', () => {
  const entries = buildSessionMentionEntries([
    row('b', 'Second', 100),
    row('a', 'First', 100),
    row('c', 'Newest', 300),
    { id: 'b', title: 'Duplicate', recencyAt: 999 },
    { id: '', title: 'No id', recencyAt: 400 },
    { threadId: 'thread-only', title: 'Thread field', recencyAt: 50 },
  ]);
  assertDeepEqual(entries.map(entry => entry.id), ['c', 'a', 'b', 'thread-only'],
    'newest first, equal clocks tie by id, and the threadId fallback is kept');
  assertDeepEqual(entries.map(entry => entry.title), ['Newest', 'First', 'Second', 'Thread field'],
    'the duplicate id keeps its first row');
});

h.test('a cold search shares the in-flight full catalog read', async () => {
  const client = new CatalogClient();
  let release!: () => void;
  client.gate = new Promise<void>(resolve => { release = resolve; });
  client.reply([row('one', 'Alpha one', 200), row('two', 'Beta two', 100)]);
  const { service } = serviceWith(client);

  const catalogRead = service.listSessions();
  const search = service.mentionCandidates({ query: 'alpha' });
  await waitFor(() => client.calls.length > 0, 1000, 'the catalog read started');
  release();
  await catalogRead;

  assertDeepEqual(await search, { items: [{ id: 'one', title: 'Alpha one' }], nextCursor: null },
    'the search waits on the shared read and returns only compact candidates');
  assertEqual(client.calls.length, 1, 'one engine catalog read serves both callers');
  assertEqual(client.calls[0]!.method, 'engine/listSessions', 'the only read is the existing session catalog');
});

h.test('a warm search reuses the snapshot, filters before paging, and returns id/title only', async () => {
  const client = new CatalogClient().reply([
    row('new', 'Alpha roadmap', 300),
    row('hidden', 'Alpha private', 250),
    row('empty', '', 240),
    row('old', 'Quarterly alpha', 100),
    row('other', 'Unrelated', 90),
  ]);
  const { service } = serviceWith(client, { isPrivateThread: id => id === 'hidden' });
  await service.listSessions();
  const before = client.calls.length;

  const page = await service.mentionCandidates({ query: 'alpha' });
  assertDeepEqual(page.items, [{ id: 'new', title: 'Alpha roadmap' }, { id: 'old', title: 'Quarterly alpha' }],
    'private and empty-title rows never reach the menu, and recency orders the rest');
  assertEqual(page.nextCursor, null, 'both matches fit in one page');
  assertEqual(client.calls.length, before, 'filtering does not touch the engine again');
});

h.test('an explicit page size is honored while the default and maximum stay at 50', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => row(`s${index}`, `Alpha ${index}`, 600 - index));
  const client = new CatalogClient().reply(rows);
  const { service } = serviceWith(client);
  await service.listSessions();

  const explicit = await service.mentionCandidates({ query: 'alpha', limit: 8 });
  assertEqual(explicit.items.length, 8, 'a caller may ask for eight');
  assertEqual(explicit.items[0]!.id, 's0', 'the newest match starts the page');
  assert(explicit.nextCursor !== null, 'sixty matches leave another page');

  const twenty = await service.mentionCandidates({ query: 'alpha', limit: 20 });
  assertEqual(twenty.items.length, 20, 'a caller may ask for twenty');

  const standard = await service.mentionCandidates({ query: 'alpha' });
  assertEqual(standard.items.length, 50, 'the default page is fifty');

  await assertRejects(() => service.mentionCandidates({ query: 'alpha', limit: 0 }), 'limit zero is rejected');
  await assertRejects(() => service.mentionCandidates({ query: 'alpha', limit: 51 }), 'the maximum is fifty');
  await assertRejects(() => service.mentionCandidates({ query: 'x'.repeat(257) }), 'queries are capped at 256 characters');
});

h.test('a persisted fallback is retained so later searches do not retry the catalog', async () => {
  const client = new CatalogClient().reply([row('live', 'Recovered live', 30)]);
  client.failCatalog = true;
  const { service, root } = serviceWith(client);
  writeSessionListSnapshot('active', [row('disk', 'Disk alpha', 20), row('disk-beta', 'Disk beta', 10)], root);

  assertDeepEqual((await service.mentionCandidates({ query: 'alpha' })).items.map(item => item.id), ['disk'],
    'the first search recovers the persisted snapshot');
  const afterFallback = client.calls.length;
  assertDeepEqual((await service.mentionCandidates({ query: 'beta' })).items.map(item => item.id), ['disk-beta'],
    'the fallback serves a different query');
  assertEqual(client.calls.length, afterFallback, 'the retained fallback does not retry the failed catalog read');

  client.failCatalog = false;
  await service.listSessions();
  assertDeepEqual((await service.mentionCandidates({ query: 'recovered' })).items.map(item => item.id), ['live'],
    'a normal successful refresh replaces the retained fallback');
});

h.test('a cursor is bound to its query and keeps paging stable after snapshot changes', async () => {
  const catalog = new SessionMentionCatalog({ visible: () => true, titleFor: (_id, fallback) => fallback });
  const first = [row('a', 'Alpha a', 300), row('b', 'Alpha b', 200), row('c', 'Alpha c', 100), row('d', 'Alpha d', 50)];
  const pageOne = catalog.page(first, 'alpha', 2);
  assertDeepEqual(pageOne.items.map(item => item.id), ['a', 'b'], 'the first page follows recency');
  const cursor = decodeSessionMentionCursor(pageOne.nextCursor!);
  assert(cursor, 'the page issues a decodable cursor');
  assertEqual(cursor!.query, 'alpha', 'the cursor carries its query');

  const movedAhead = [row('c', 'Alpha c', 900), row('b', 'Alpha b renamed', 200), row('d', 'Alpha d', 50)];
  const pageTwo = catalog.page(movedAhead, 'alpha', 2, cursor!);
  assertDeepEqual(pageTwo.items.map(item => item.id), ['c', 'd'],
    'a row that moved ahead is returned once and a deleted anchor skips nothing');

  const sameSnapshot = catalog.page(first, 'alpha', 2, cursor!);
  assertDeepEqual(sameSnapshot.items.map(item => item.id), ['c', 'd'],
    'an unchanged snapshot resumes after the anchor id');

  const renamed = new SessionMentionCatalog({ visible: () => true, titleFor: id => id === 'b' ? 'Alpha b renamed' : 'Alpha b' });
  assertDeepEqual(renamed.page(first, 'alpha', 1, cursor!).items.map(item => item.id), ['c'],
    'a host title override does not disturb the position');
});

h.test('the index revision changes only when the snapshot array is replaced', () => {
  const catalog = new SessionMentionCatalog({ visible: () => true, titleFor: (_id, fallback) => fallback });
  const rows = [row('a', 'Alpha a', 300), row('b', 'Alpha b', 200)];
  const first = catalog.page(rows, 'alpha', 1);
  const second = catalog.page(rows, 'alpha', 1);
  const replaced = catalog.page([...rows], 'alpha', 1);
  const revisionOf = (cursor: string | null): number => decodeSessionMentionCursor(cursor!)!.revision;
  assertEqual(revisionOf(first.nextCursor), revisionOf(second.nextCursor), 'the same reference reuses its index');
  assert(revisionOf(replaced.nextCursor) > revisionOf(first.nextCursor), 'a new array rebuilds the index');
});

h.test('cursor decoding rejects foreign or malformed positions and the service rejects a query mismatch', async () => {
  assertEqual(decodeSessionMentionCursor('not-a-cursor'), null, 'garbage is not a cursor');
  assertEqual(decodeSessionMentionCursor(''), null, 'an empty cursor is invalid');
  const valid = encodeSessionMentionCursor({ query: 'alpha', revision: 1, id: 'a', seen: ['a'] });
  assertEqual(decodeSessionMentionCursor(valid)?.id, 'a', 'a generated cursor round-trips');

  const client = new CatalogClient().reply([row('a', 'Alpha', 10), row('b', 'Alpha b', 9)]);
  const { service } = serviceWith(client);
  await service.listSessions();
  const page = await service.mentionCandidates({ query: 'alpha', limit: 1 });
  await assertRejects(() => service.mentionCandidates({ query: 'beta', cursor: page.nextCursor! }),
    'a cursor cannot be replayed against a different query');
  await assertRejects(() => service.mentionCandidates({ query: 'alpha', cursor: 'garbage' }), 'malformed cursors are refused');
});

h.test('pageSessionMentions terminates when every remaining row was already returned', () => {
  const entries = buildSessionMentionEntries([row('a', 'Alpha', 10)]);
  const page = pageSessionMentions({
    entries, query: 'alpha', limit: 1, revision: 1,
    cursor: { query: 'alpha', revision: 1, id: 'a', seen: ['a'] },
  });
  assertDeepEqual(page, { items: [], nextCursor: null }, 'a fully consumed list has no phantom next page');
});

h.test('the session IPC route exposes the narrow candidate API', async () => {
  const client = new CatalogClient().reply([row('one', 'Alpha one', 2)]);
  const { service, state } = serviceWith(client);
  const registry = new ChannelRegistry();
  registerSessionHandlers(registry, {
    sessions: service, state, events: {} as SessionEventPump,
    configRoot: mkdtempSync(join(tmpdir(), 'klaus-session-mentions-ipc-')),
    chooseExportPath: async () => undefined,
  });
  const handler = registry.lookup('session:mention-candidates');
  assert(handler, 'the channel is registered');
  const context = { channel: 'session:mention-candidates', role: 'main', senderId: 1, args: [{ query: 'alpha' }] };
  assertDeepEqual(await handler!(context), { items: [{ id: 'one', title: 'Alpha one' }], nextCursor: null },
    'the handler returns the same compact page');
  await assertRejects(async () => { await handler!({ ...context, args: [{ query: 42 }] }); }, 'non-string queries are refused');
});

void (async () => {
  const code = await h.finish(join(__dirname, 'session-mentions-result.json'), 'session-mentions');
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
  process.exit(code);
})();
