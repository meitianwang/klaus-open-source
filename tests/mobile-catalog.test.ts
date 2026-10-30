import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileCatalog, catalogAccountKey, catalogCursor, type CatalogCursor, type CatalogSourcePage } from '../main/services/mobile/catalog';
import { MobileHydrationQueue } from '../main/services/mobile/hydration-queue';
import { MobileTaskStreams } from '../main/services/mobile/task-stream';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, sleep, waitFor } from './harness';
import { mobileFixture } from './mobile-fixture';

const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-catalog-sync-vectors.json'), 'utf8')) as Record<string, JsonObject>;
const cursor = (page: JsonObject): CatalogCursor => ({ streamId: string(page.streamId), revision: Number(page.revision) });
async function pages(catalog: MobileCatalog, after?: CatalogCursor): Promise<JsonObject[]> {
  const result: JsonObject[] = [];
  for await (const page of catalog.pages('fixture', after)) result.push(page);
  return result;
}
function source(count: number) {
  let clock = 1_000_000, next = 0;
  const rows = new Map<string, JsonObject>(Array.from({ length: count }, (_, i) => ['s' + (i + 1), { id: 's' + (i + 1), title: 'Session ' + i, updatedAt: count - i }]));
  const hidden = new Set<string>(), calls: (string | undefined)[] = [], reads: string[] = [];
  const snapshots = new Map<string, { rows: JsonObject[]; membership: string; metadata: string }>();
  let intercept: ((cursor: string | undefined) => Promise<void>) | undefined;
  const api = {
    visible: (id: string) => !hidden.has(id),
    row: async (id: string) => { reads.push(id); return rows.has(id) ? { ...rows.get(id)! } : null; },
    page: async (token: string | undefined, signal: AbortSignal): Promise<CatalogSourcePage> => {
      signal.throwIfAborted(); calls.push(token); await intercept?.(token); signal.throwIfAborted();
      let snapshotId: string, offset: number;
      if (token) { const parts = token.split(':'); snapshotId = parts[0]!; offset = Number(parts[1]); }
      else {
        snapshotId = String(++next); offset = 0;
        const cut = [...rows.values()].map(row => ({ ...row })).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
        const metadata = [...cut].sort((a, b) => string(a.id).localeCompare(string(b.id))).map(({ updatedAt: _updatedAt, ...header }) => header);
        snapshots.set(snapshotId, { rows: cut, membership: createHash('sha256').update(cut.map(row => row.id).sort().join(',')).digest('hex'), metadata: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') });
      }
      const snapshot = snapshots.get(snapshotId)!;
      const pageRows = snapshot.rows.slice(offset, offset + 100);
      return { rows: pageRows, sourceWatermarks: Object.fromEntries(pageRows.map(row => [string(row.id), Number(row.updatedAt)])),
        membershipFingerprint: snapshot.membership, metadataFingerprint: snapshot.metadata, ...(offset + 100 < snapshot.rows.length ? { nextCursor: snapshotId + ':' + (offset + 100) } : {}) };
    },
  };
  return { api, rows, hidden, calls, reads, now: () => clock, advance: (ms = 30_001) => { clock += ms; }, intercept: (value: typeof intercept) => { intercept = value; } };
}

void (async () => {
  await h.test('committed contract pins independent catalog and task checkpoints', () => {
    assert.equal(vector.negotiation!.protocolVersion, 3);
    assert.equal(vector.limits!.pageSize, 100);
    assert.equal(vector.limits!.idleFollowLimit, 10);
    assert.equal(vector.followReady!.type, 'task_follow_ready');
    for (const name of ['reset', 'delta', 'unchanged']) assert.equal(vector[name]!.done, true);
    assert.equal(catalogCursor(undefined), undefined);
    for (const value of [{}, { streamId: '', revision: 1 }, { streamId: 's', revision: -1 }, { streamId: 's', revision: 1.5 }]) assert.throws(() => catalogCursor(value));
    assert.notEqual(catalogAccountKey('account-a'), catalogAccountKey('account-b'));
    assert(!catalogAccountKey('account-a').includes('account-a'));
  });
  await h.test('large initial catalog yields bounded pages and warm unchanged resume performs no source IO', async () => {
    const s = source(1_000), catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      const started = performance.now();
      const full = await pages(catalog), cut = cursor(full.at(-1)!);
      const coldMs = performance.now() - started;
      assert.equal(full.length, 10); assert.equal(full.flatMap(page => page.sessions as JsonObject[]).length, 1_000);
      assert(full.every(page => page.reset && page.revision === cut.revision && page.streamId === cut.streamId));
      assert(full.slice(0, -1).every(page => !page.done)); assert.equal(full.at(-1)!.done, true);
      const calls = s.calls.length, warmStarted = performance.now(), delta = await pages(catalog, cut);
      assert.equal(s.calls.length, calls); assert.equal(delta.length, 1);
      assert.deepEqual(delta[0]!.sessions, []); assert.equal(delta[0]!.reset, false);
      assert(Buffer.byteLength(JSON.stringify(delta)) < 512);
      h.info('metadata-only fixture measurement', JSON.stringify({ sessions: 1_000, coldMs: Number(coldMs.toFixed(2)), warmMs: Number((performance.now() - warmStarted).toFixed(2)),
        initialPages: full.length, sourcePageReads: calls, resumeSourceReads: s.calls.length - calls, initialBytes: Buffer.byteLength(JSON.stringify(full)), resumeBytes: Buffer.byteLength(JSON.stringify(delta)) }));
    } finally { await catalog.close(); }
  });
  await h.test('a targeted rename reads one summary and increments the catalog revision without a directory scan', async () => {
    const s = source(216), catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      const cut = cursor((await pages(catalog)).at(-1)!), calls = s.calls.length;
      s.rows.get('s200')!.title = 'Changed'; catalog.invalidate('s200');
      const delta = await pages(catalog, cut);
      assert.equal(s.calls.length, calls); assert.deepEqual(s.reads, ['s200']);
      assert.equal(delta[0]!.reset, false); assert.equal(delta[0]!.revision, cut.revision + 1);
      assert.deepEqual((delta[0]!.sessions as JsonObject[]).map(row => row.title), ['Changed']);
    } finally { await catalog.close(); }
  });
  await h.test('large metadata rows respect the byte budget as well as the record limit', async () => {
    const s = source(12), catalog = new MobileCatalog(s.api, { now: s.now });
    for (const row of s.rows.values()) row.title = 'Large metadata '.repeat(25_000);
    try {
      const full = await pages(catalog);
      assert(full.length > 1);
      assert.equal(full.flatMap(page => page.sessions as JsonObject[]).length, 12);
      assert(full.every(page => Buffer.byteLength(JSON.stringify(page)) <= Number(vector.limits!.pageBytes)));
      assert(full.every(page => (page.sessions as JsonObject[]).length <= 100));
      const cut = cursor(full.at(-1)!);
      for (const [id, row] of s.rows) { row.title = String(row.title) + 'Changed'; catalog.invalidate(id); }
      const delta = await pages(catalog, cut);
      assert.equal(delta.flatMap(page => page.sessions as JsonObject[]).length, 12);
      assert(delta.every(page => Buffer.byteLength(JSON.stringify(page)) <= Number(vector.limits!.pageBytes)));
    } finally { await catalog.close(); }
  });
  await h.test('incremental head refresh crosses the old watermark without scanning unchanged tail pages', async () => {
    const s = source(1_000), catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      const cut = cursor((await pages(catalog)).at(-1)!); s.calls.length = 0;
      s.rows.get('s900')!.updatedAt = 2_000; s.advance();
      const delta = await pages(catalog, cut);
      assert.equal(s.calls.length, 2); assert(s.calls.every(token => token === undefined));
      assert.deepEqual((delta[0]!.sessions as JsonObject[]).map(row => row.id), ['s900']);
      assert.equal((await catalog.cached()).length, 1_000);
    } finally { await catalog.close(); }
  });
  await h.test('bulk invalidation is reconciled as batched pages instead of one database decoration per row', async () => {
    const s = source(216), catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      const cut = cursor((await pages(catalog)).at(-1)!); s.calls.length = 0;
      for (const [id, row] of s.rows) { row.title = 'Batch ' + id; catalog.invalidate(id); }
      const delta = await pages(catalog, cut);
      assert.equal(s.calls.length, 4); assert.deepEqual(s.reads, []);
      assert.equal(delta.flatMap(page => page.sessions as JsonObject[]).length, 216);
      assert(delta.every(page => page.reset === false));
    } finally { await catalog.close(); }
  });
  await h.test('same-count external membership replacement forces full reconciliation and deletion tombstones', async () => {
    const s = source(216), catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      const cut = cursor((await pages(catalog)).at(-1)!); s.calls.length = 0;
      s.rows.delete('s216'); s.rows.set('external', { id: 'external', title: 'External', updatedAt: 1 }); s.advance();
      const delta = await pages(catalog, cut);
      assert.equal(s.calls.length, 4); assert.deepEqual(delta[0]!.removedSessionIds, ['s216']);
      assert.deepEqual((delta[0]!.sessions as JsonObject[]).map(row => row.id), ['external']);
    } finally { await catalog.close(); }
  });
  await h.test('external metadata edits that preserve recency trigger full reconciliation below the watermark', async () => {
    const s = source(216), catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      const cut = cursor((await pages(catalog)).at(-1)!); s.calls.length = 0;
      s.rows.get('s216')!.title = 'External metadata edit'; s.advance();
      const delta = await pages(catalog, cut);
      assert.equal(s.calls.length, 4);
      assert.deepEqual((delta[0]!.sessions as JsonObject[]).map(row => [row.id, row.title, row.updatedAt]), [['s216', 'External metadata edit', 1]]);
      assert.equal(delta[0]!.reset, false);
    } finally { await catalog.close(); }
  });
  await h.test('head reconciliation retries a membership cut that changes during the scan', async () => {
    const s = source(216); let changed = false;
    s.intercept(async token => { if (!changed && token?.endsWith(':100')) { changed = true; s.rows.set('new', { id: 'new', title: 'New', updatedAt: 400 }); } });
    const catalog = new MobileCatalog(s.api, { now: s.now });
    try { await pages(catalog); assert.equal((await catalog.cached()).length, 217); assert(s.calls.length > 4); }
    finally { await catalog.close(); }
  });
  await h.test('failed scan never publishes a partial cut and observes retry backoff', async () => {
    const s = source(216), catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      await pages(catalog); s.rows.delete('s216'); s.advance();
      s.intercept(async token => { if (token) throw new Error('fixture page failed'); });
      await assert.rejects(pages(catalog), /fixture page failed/);
      assert.equal((await catalog.cached()).length, 216);
      const calls = s.calls.length; await assert.rejects(pages(catalog), /fixture page failed/); assert.equal(s.calls.length, calls);
      s.intercept(undefined); s.advance(10_001); await pages(catalog); assert.equal((await catalog.cached()).length, 215);
    } finally { await catalog.close(); }
  });
  await h.test('invalidation arriving during a point read survives the in-flight generation cut', async () => {
    const s = source(2), original = s.api.row; let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.api.row = async id => { const row = await original(id); if (id === 's1' && !entered) { entered = true; await gate; } return row; };
    const catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      await pages(catalog); catalog.invalidate('s1'); const first = catalog.refresh();
      await waitFor(() => entered, 1_000, 'Point read entered');
      s.rows.get('s1')!.title = 'Second generation'; catalog.invalidate('s1'); release(); await first; await catalog.refresh();
      assert.equal((await catalog.cached()).find(row => row.id === 's1')!.title, 'Second generation'); assert.equal(s.reads.length, 2);
    } finally { release(); await catalog.close(); }
  });
  await h.test('privacy changes remove cached rows even inside the source freshness window', async () => {
    const s = source(2), catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      const cut = cursor((await pages(catalog)).at(-1)!); s.hidden.add('s2');
      assert.deepEqual((await catalog.cached()).map(row => row.id), ['s1']);
      const delta = await pages(catalog, cut); assert.deepEqual(delta[0]!.removedSessionIds, ['s2']);
    } finally { await catalog.close(); }
  });
  await h.test('privacy is rechecked at each page publication while a slow client drains its previous page', async () => {
    const s = source(216), catalog = new MobileCatalog(s.api, { now: s.now });
    try {
      const reset = catalog.pages('reset'), first = await reset.next(); assert.equal((first.value!.sessions as JsonObject[]).length, 100);
      s.hidden.add('s150'); const second = await reset.next();
      assert(!(second.value!.sessions as JsonObject[]).some(row => row.id === 's150'));
      assert.deepEqual(second.value!.removedSessionIds, []);
      await reset.return(undefined); await catalog.refresh();
      const cut = cursor((await pages(catalog)).at(-1)!);
      for (const [id, row] of s.rows) { row.title = 'Changed ' + id; catalog.invalidate(id); }
      const delta = catalog.pages('delta', cut); await delta.next(); s.hidden.add('s160');
      const next = await delta.next();
      assert(!(next.value!.sessions as JsonObject[]).some(row => row.id === 's160'));
      assert((next.value!.removedSessionIds as string[]).includes('s160'));
      assert((next.value!.sessions as JsonObject[]).length + (next.value!.removedSessionIds as string[]).length <= 100);
      await delta.return(undefined);
    } finally { await catalog.close(); }
  });
  await h.test('completed cache survives restart; foreign, future and unavailable history cursors reset explicitly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klaus-catalog-')), path = join(dir, 'catalog.jsonl'), s = source(216);
    let catalog = new MobileCatalog(s.api, { path, now: s.now });
    try {
      const cut = cursor((await pages(catalog)).at(-1)!); await catalog.close();
      catalog = new MobileCatalog(s.api, { path, now: s.now });
      assert.equal((await catalog.cached()).length, 216);
      const unchanged = await pages(catalog, cut); assert.equal(unchanged[0]!.reset, false); assert.deepEqual(unchanged[0]!.sessions, []);
      for (const invalid of [{ ...cut, streamId: 'foreign' }, { ...cut, revision: cut.revision + 1 }, { ...cut, revision: 0 }]) {
        const reset = await pages(catalog, invalid); assert.equal(reset[0]!.reset, true); assert.equal(reset[0]!.baseRevision, null);
        assert.equal(reset.flatMap(page => page.sessions as JsonObject[]).length, 216);
      }
    } finally { await catalog.close(); await rm(dir, { recursive: true, force: true }); }
  });
  await h.test('corrupt cache never replaces authoritative source rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klaus-catalog-')), path = join(dir, 'catalog.jsonl'), s = source(2), errors: unknown[] = [];
    await writeFile(path, '{"version":1}\n{"row":{"id":"bad"}}\n');
    const catalog = new MobileCatalog(s.api, { path, error: error => errors.push(error) });
    try { assert.deepEqual(await catalog.cached(), []); await pages(catalog); assert.equal((await catalog.cached()).length, 2); assert.equal(errors.length, 1); }
    finally { await catalog.close(); await rm(dir, { recursive: true, force: true }); }
  });
  await h.test('a generation published while the writer settles is drained durably before close returns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klaus-catalog-writer-')), path = join(dir, 'catalog.jsonl');
    let headEntered!: () => void, releaseHead!: () => void, calls = 0, title = 'First', renames = 0;
    const entered = new Promise<void>(resolve => { headEntered = resolve; });
    const blocked = new Promise<void>(resolve => { releaseHead = resolve; });
    const originalRename = fsPromises.rename;
    fsPromises.rename = async (...args) => {
      if (++renames === 1) { await entered; await originalRename(...args); releaseHead(); return; }
      return originalRename(...args);
    };
    const catalog = new MobileCatalog({
      visible: () => true, row: async () => ({ id: 's1', title }),
      page: async () => {
        if (++calls === 4) { headEntered(); await blocked; }
        return { rows: [{ id: 's1', title }], sourceWatermarks: { s1: 1 }, membershipFingerprint: 'one', metadataFingerprint: title };
      },
    }, { path });
    try {
      await catalog.refresh(); title = 'Second'; catalog.invalidate(); await catalog.refresh(); await catalog.close();
      const disk = readFileSync(path, 'utf8').trim().split('\n').map(line => object(JSON.parse(line)));
      assert.equal(object(disk[1]!.row).title, 'Second'); assert.equal(disk[0]!.revision, 2); assert.equal(renames, 2);
    } finally { releaseHead(); fsPromises.rename = originalRename; await catalog.close(); await rm(dir, { recursive: true, force: true }); }
  });
  await h.test('cache storage failure reports once and close does not retry in a hot loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klaus-catalog-failure-')), parent = join(dir, 'not-a-directory'), s = source(1);
    await writeFile(parent, 'fixture'); const errors: unknown[] = [];
    const catalog = new MobileCatalog(s.api, { path: join(parent, 'catalog.jsonl'), error: error => errors.push(error) });
    try {
      await catalog.cached(); errors.length = 0;
      await catalog.refresh(); await catalog.close();
      assert.equal(errors.length, 1); assert.equal((await catalog.cached()).length, 1);
    } finally { await catalog.close(); await rm(dir, { recursive: true, force: true }); }
  });
  await h.test('an early corrupt-cache exit closes its paused file stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klaus-catalog-stream-')), path = join(dir, 'catalog.jsonl'), s = source(1);
    await writeFile(path, 'invalid-json\n' + 'x'.repeat(512 * 1024));
    const original = fs.createReadStream; let input: ReturnType<typeof original> | undefined;
    fs.createReadStream = (...args) => { input = original(...args); return input; };
    const errors: unknown[] = [], catalog = new MobileCatalog(s.api, { path, error: error => errors.push(error) });
    try {
      await catalog.cached(); await catalog.close(); assert.equal(errors.length, 1); assert(input?.destroyed);
      await waitFor(() => Boolean(input?.closed), 1_000, 'Corrupt cache input closed');
    } finally { fs.createReadStream = original; input?.destroy(); await catalog.close(); await rm(dir, { recursive: true, force: true }); }
  });
  await h.test('hydration lane bounds concurrency and cancels queued work before entry', async () => {
    const queue = new MobileHydrationQueue(); let release!: () => void, active = 0, max = 0, started = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const operation = async () => { started++; active++; max = Math.max(max, active); await gate; active--; };
    const signal = new AbortController().signal;
    const a = queue.run(operation, signal), b = queue.run(operation, signal), controller = new AbortController();
    const c = queue.run(operation, controller.signal); controller.abort();
    await assert.rejects(c); release(); await Promise.all([a, b]); assert.equal(started, 2); assert.equal(max, 2);
  });
  await h.test('server task journals bound idle ownership and explicitly reject evicted replay cursors', () => {
    let now = 0; const kept = new Set(['working']), streams = new MobileTaskStreams(() => {}, id => kept.has(id), () => now);
    try {
      streams.follow('working'); const working = streams.current('working'); streams.unfollow('working');
      streams.follow('old'); const old = streams.current('old'); streams.unfollow('old');
      for (let index = 0; index < 11; index++) { now++; streams.follow('s' + index); streams.unfollow('s' + index); }
      assert.equal(streams.replay('old', old), undefined);
      assert.deepEqual(streams.replay('working', working), []);
      streams.follow('idle'); const idle = streams.current('idle'); streams.unfollow('idle'); now += 3 * 60 * 60_000;
      assert.equal(streams.replay('idle', idle), undefined);
      assert.deepEqual(streams.replay('working', working), []);
      kept.clear(); now++; assert.equal(streams.replay('working', working), undefined);
    } finally { streams.reset(); }
  });
  await h.test('negotiated socket uses lightweight hello and unchanged sync, never the legacy full list', async () => {
    const s = source(216), f = await mobileFixture({ catalogPage: (token, context) => s.api.page(token, context.signal), catalogRow: id => s.api.row(id), catalogVisible: s.api.visible });
    try {
      await f.enable(); const client = await f.connect(true), hello = await client.next('hello');
      assert.equal(object(hello.features).catalogSync, 1); assert.deepEqual(hello.sessions, []);
      client.socket.send(JSON.stringify({ type: 'transport_resume', clientId: 'catalog-fixture', lastServerSeq: 0 })); await client.next('transport_ready');
      const nextLogical = async (type: string): Promise<JsonObject> => {
        await waitFor(() => client.messages.some(row => row.type === 'server_message' && object(row.message).type === type), 3_000, type);
        return object(client.messages.splice(client.messages.findIndex(row => row.type === 'server_message' && object(row.message).type === type), 1)[0]!.message);
      };
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 1, message: { type: 'catalog_sync', requestId: 'first' } }));
      const full: JsonObject[] = []; do { full.push(await nextLogical('catalog_page')); } while (!full.at(-1)!.done);
      assert.equal(full.length, 3); const cut = cursor(full.at(-1)!);
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 2, message: { type: 'catalog_sync', requestId: 'second', cursor: cut } }));
      const delta = await nextLogical('catalog_page'); assert.deepEqual(delta.sessions, []); assert.equal(delta.reset, false);
      f.bridge.publishEngineEvent({ type: 'session_title_updated', sessionId: 's1', title: 'Changed' }, f.owner());
      await sleep(30); assert.equal(f.calls.filter(call => call.channel === 'session:list').length, 0);
    } finally { await f.close(); }
  });
  await h.test('desktop workspace mutations refresh negotiated metadata without reconnect or legacy history scans', async () => {
    const s = source(2), f = await mobileFixture({ catalogPage: (token, context) => s.api.page(token, context.signal), catalogRow: id => s.api.row(id), catalogVisible: s.api.visible });
    for (const row of s.rows.values()) row.workspaceId = 'ws-one';
    let groups: JsonObject[] = [{ id: 'ws-one', name: 'Before', roots: ['/space/first'] }];
    try {
      f.intercept(async channel => channel === 'workspaces:list' ? { workspaces: groups } : undefined);
      await f.enable(); const client = await f.connect(true), hello = await client.next('hello');
      assert.equal(object((object(hello.desktopState).workspaces as JsonObject[])[0]).name, 'Before');
      assert.equal(s.calls.length, 0);
      groups = [{ id: 'ws-one', name: 'After', roots: ['/space/next'] }];
      f.bridge.noteRendererSession([{ id: 'ws-one' }], 'workspaces:save');
      const states = (): JsonObject[] => client.messages.filter(row => row.type === 'desktop_state_changed').map(row => object(row.desktopState));
      await waitFor(() => states().some(state => (state.workspaces as JsonObject[]).some(group => group.name === 'After' && group.conversationCount === 2)), 2_000, 'Workspace mutation refreshes cached catalog and desktop metadata');
      assert(s.calls.length > 0, 'Workspace decoration changes invalidate metadata in the background');
      groups = [];
      f.bridge.noteRendererSession([{ id: 'ws-one' }], 'workspaces:delete');
      await waitFor(() => states().some(state => (state.workspaces as JsonObject[]).length === 0), 2_000, 'Deleted workspace is removed on the same connection');
      assert.equal(f.calls.filter(call => ['session:list', 'session:history', 'session:follow'].includes(call.channel)).length, 0);
      assert.equal(client.socket.readyState, 1);
    } finally { await f.close(); }
  });
  await h.test('slow transcript hydration does not block message admission or empty replay completion', async () => {
    const s = source(2), f = await mobileFixture({ catalogPage: (token, context) => s.api.page(token, context.signal), catalogRow: id => s.api.row(id), catalogVisible: s.api.visible });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    try {
      f.intercept(async channel => { if (channel === 'session:follow') { entered = true; await gate; } return undefined; });
      await f.enable(); const client = await f.connect(true); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' })); await waitFor(() => entered, 1_000, 'History hydration started');
      client.socket.send(JSON.stringify({ type: 'send_message', sessionId: 's1', text: 'During history load', clientMessageId: 'concurrent-send' }));
      await waitFor(() => f.sent.length === 1, 1_000, 'Send does not wait for history');
      release(); const snapshot = await client.next('task_snapshot'); await client.next('task_follow_ready');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1', cursor: { streamId: snapshot.streamId, revision: snapshot.revision } }));
      const ready = await client.next('task_follow_ready'); assert.equal(ready.mode, 'replay');
      assert.equal(f.calls.filter(call => call.channel === 'session:follow').length, 1);
    } finally { release(); await f.close(); }
  });
  await h.test('engine replacement explicitly invalidates followers and accepts a fresh stream epoch', async () => {
    const s = source(2), f = await mobileFixture({ catalogPage: (token, context) => s.api.page(token, context.signal), catalogRow: id => s.api.row(id), catalogVisible: s.api.visible });
    try {
      await f.enable(); const client = await f.connect(true); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      const first = await client.next('task_snapshot'); await client.next('task_follow_ready');
      f.replaceOwner(); f.bridge.publishEngineEvent({ type: 'session_title_updated', sessionId: 's1' }, f.owner());
      const gap = await client.next('task_gap'); assert.notEqual(gap.streamId, first.streamId);
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      const second = await client.next('task_snapshot'); await client.next('task_follow_ready');
      assert.equal(second.streamId, gap.streamId); assert.notEqual(second.streamId, first.streamId);
      f.bridge.publishEngineEvent({ type: 'done', sessionId: 's1' }, f.owner());
      assert.equal((await client.next('task_patch')).streamId, second.streamId);
    } finally { await f.close(); }
  });
  await h.test('follow admission bounds abnormal idle retention without evicting protected work or existing follows', async () => {
    const s = source(70), f = await mobileFixture({ catalogPage: (token, context) => s.api.page(token, context.signal), catalogRow: id => s.api.row(id), catalogVisible: s.api.visible });
    try {
      await f.enable(); const client = await f.connect(true); await client.next('hello');
      for (let index = 1; index <= 64; index++) {
        client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's' + index }));
        await client.next('task_snapshot'); await client.next('task_follow_ready');
      }
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's65' }));
      const failure = await client.next('error'); assert.equal(failure.code, 'too_many_task_follows'); assert.equal(failure.sessionId, 's65');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      await client.next('task_snapshot'); await client.next('task_follow_ready');
      f.bridge.publishEngineEvent({ type: 'stream_mode', mode: 'requesting', sessionId: 's66' }, f.owner());
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's66' }));
      assert.equal((await client.next('task_snapshot')).sessionId, 's66'); await client.next('task_follow_ready');
      client.socket.send(JSON.stringify({ type: 'unfollow_task', sessionId: 's1' }));
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's65' }));
      assert.equal((await client.next('task_snapshot')).sessionId, 's65'); await client.next('task_follow_ready');
    } finally { await f.close(); }
  });
  await h.test('an overflowing snapshot join fails explicitly without disconnecting unrelated product actions', async () => {
    const f = await mobileFixture(); let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      f.intercept(async channel => { if (channel === 'session:follow') { entered = true; await gate; } return undefined; });
      await f.enable(); const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      await waitFor(() => entered, 1_000, 'Snapshot waiting');
      for (let index = 0; index < 1025; index++) f.bridge.publishEngineEvent({ type: 'fixture_boundary', sessionId: 's1', index }, f.owner());
      const failure = await client.next('error'); assert.equal(failure.code, 'history_changed_too_quickly');
      client.socket.send(JSON.stringify({ type: 'send_message', sessionId: 's2', text: 'Other task still usable', clientMessageId: 'after-join-overflow' }));
      await waitFor(() => f.sent.length === 1, 1_000, 'Independent task send'); release();
      await sleep(20); assert(!client.messages.some(row => row.type === 'task_snapshot'));
    } finally { release(); await f.close(); }
  });
  await h.test('snapshot-cut flush overflow cannot publish a snapshot after ownership was revoked', async () => {
    const f = await mobileFixture(); let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      f.intercept(async channel => { if (channel === 'session:follow') { entered = true; await gate; } return undefined; });
      await f.enable(); const client = await f.connect(); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      await waitFor(() => entered, 1_000, 'Snapshot waiting');
      for (let index = 0; index < 1024; index++) f.bridge.publishEngineEvent({ type: 'fixture_boundary', sessionId: 's1', index }, f.owner());
      f.bridge.publishEngineEvent({ type: 'text_delta', sessionId: 's1', text: 'Buffered tail' }, f.owner()); release();
      const failure = await client.next('error'); assert.equal(failure.code, 'history_changed_too_quickly');
      await sleep(20); assert(!client.messages.some(row => ['task_snapshot', 'task_follow_ready'].includes(string(row.type))));
    } finally { release(); await f.close(); }
  });
  process.exitCode = await h.finish(join(__dirname, 'mobile-catalog.result.json'), 'mobile-catalog');
})().catch(error => { console.error(error); process.exitCode = 1; });
