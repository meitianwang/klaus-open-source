import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BrowserDataStore } from '../main/browser/history-store';
import { DownloadStore } from '../main/browser/downloads';
import { uniqueDownloadPath } from '../main/browser/native-downloads';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-browser-history-'));
let sequence = 0;

function fixture() {
  const configRoot = join(root, String(++sequence));
  mkdirSync(configRoot, { recursive: true });
  return { configRoot, store: new BrowserDataStore(configRoot) };
}

h.test('browsing history pages with keyset cursors without duplicating or skipping rows', () => {
  const { store } = fixture();
  const base = 1_750_000_000_000;
  for (let index = 0; index < 125; index += 1) {
    store.recordVisit({
      sessionId: `session-${index % 3}`,
      url: `https://example.test/page-${String(index).padStart(3, '0')}`,
      title: index === 64 ? 'Release Notes' : `Page ${index}`,
      source: index % 5 === 0 ? 'agent' : 'other',
      visitedAt: base + index,
    });
  }
  const first = store.history({ limit: 100 });
  assertEqual(first.items.length, 100, 'first bounded page');
  assert(first.nextCursor, 'a full page exposes a cursor');
  assertDeepEqual(first.items.slice(0, 4).map(item => item.url), [
    'https://example.test/page-124', 'https://example.test/page-123',
    'https://example.test/page-122', 'https://example.test/page-121',
  ], 'newest first');
  assertEqual(first.items[0]?.visitTime, base + 124, 'epoch milliseconds retained');
  assertEqual(first.items[0]?.isActorVisit, false, 'ordinary navigation is not attributed to the agent');
  assertEqual(first.items.find(item => item.url.endsWith('page-120'))?.isActorVisit, true, 'agent visit retains attribution');

  const second = store.history({ limit: 100, cursor: first.nextCursor! });
  assertEqual(second.items.length, 25, 'remaining page');
  assertEqual(second.nextCursor, null, 'last page has no cursor');
  const ids = new Set([...first.items, ...second.items].map(item => item.id));
  assertEqual(ids.size, 125, 'pagination neither duplicates nor skips an entry');

  const agent = store.history({ source: 'agent', limit: 100 });
  assert(agent.items.every(item => item.isActorVisit), 'source filter');
  const search = store.history({ query: 'release notes' });
  assertEqual(search.items.length, 1, 'case-insensitive title search');
  assertEqual(search.items[0]?.url.endsWith('page-064'), true, 'search retains the exact row');
  const reopen = new BrowserDataStore(store.databasePath.replace(/\/browser-data\.db$/u, ''));
  assertEqual(reopen.history({ limit: 1 }).items[0]?.url, 'https://example.test/page-124', 'cold reopen sees the persisted row');
  assertEqual(store.history({ limit: 101 }).items.length, 100, 'page size is capped at 100');
});

h.test('native history projection preserves nearby visits and retries without duplicates', async () => {
  const { store } = fixture();
  const rows = Array.from({ length: 250 }, (_, index) => ({
    url: 'https://example.test/imported', title: `Visit ${index}`, visitedAt: 1000 + index, source: 'other' as const,
  }));
  store.recordImportedVisits(rows);
  store.recordImportedVisits(rows);
  const first = store.history({ limit: 100 });
  assertEqual(first.items.length, 100, 'history projection supports normal pagination');
  assert(first.items.every(item => !item.isActorVisit), 'import is never agent activity');
  const db = new DatabaseSync(store.databasePath);
  assertEqual((db.prepare('SELECT count(*) AS n FROM browser_visits').get() as { n: number }).n, 250, 'distinct visits retained and retries are idempotent');
  db.close();
  await assertRejects(async () => store.recordImportedVisits([...rows, rows[0]!]), 'native event batches are bounded');
  await assertRejects(async () => store.recordImportedVisits([rows[0]!, { ...rows[0]!, url: 'file:///tmp/example' }]), 'invalid batch cannot write a prefix');
});

h.test('history removal is bounded, idempotent and clear removes only visits', () => {
  const { store } = fixture();
  const first = store.recordVisit({ sessionId: 's', url: 'https://example.test/a', title: 'A', source: 'other', visitedAt: 1 });
  const second = store.recordVisit({ sessionId: 's', url: 'https://example.test/b', title: 'B', source: 'agent', visitedAt: 2 });
  assertDeepEqual(store.removeVisits([first.id, first.id]), { removed: 1 }, 'duplicate ids remove one row');
  assertDeepEqual(store.removeVisits([first.id]), { removed: 0 }, 'removal is idempotent');
  assertEqual(store.history().items.length, 1, 'unrelated row retained');
  assertEqual(store.history().items[0]?.id, second.id, 'remaining row identity');
  assertEqual(store.clearVisits().removed, 1, 'clear count');
  assertEqual(store.history().items.length, 0, 'clear leaves no visits');
});

h.test('download metadata persists terminal state, file existence and bounded keyset pages', async () => {
  const { configRoot, store } = fixture();
  const folder = join(configRoot, 'downloads');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'report.txt');
  writeFileSync(file, 'report');
  const base = 1_750_000_000_000;
  for (let index = 0; index < 105; index += 1) {
    store.createDownload({
      id: `download-${String(index).padStart(3, '0')}`,
      sessionId: 'task',
      url: `https://example.test/file-${index}`,
      filename: index === 104 ? 'report.txt' : `file-${index}.txt`,
      source: 'agent',
      startedAt: base + index,
      status: 'in_progress',
      ...(index === 104 ? { path: file, bytes: 6, totalBytes: 6 } : {}),
    });
  }
  store.updateDownload('download-104', { status: 'completed', finishedAt: base + 500, totalBytes: 6 });
  const first = store.downloadHistory({ limit: 100 });
  assertEqual(first.items.length, 100, 'download page bound');
  assert(first.nextCursor, 'download cursor');
  const second = store.downloadHistory({ limit: 100, cursor: first.nextCursor! });
  assertEqual(second.items.length, 5, 'remaining downloads');
  const completed = [...first.items, ...second.items].find(row => row.id === 'download-104');
  assert(completed, 'completed row present');
  assertEqual(completed.state, 'completed', 'terminal state');
  assertEqual(completed.exists, true, 'actual file existence');
  const search = store.downloadHistory({ query: 'report' });
  assertEqual(search.items.length, 1, 'download filename search');
  await assertRejects(async () => store.removeDownload('download-001'), 'active download cannot be removed');
  assertEqual(store.clearTerminalDownloads().removed, 1, 'clear removes terminal rows only');
  assertEqual(store.download('download-104'), undefined, 'terminal row cleared');
  assert(store.download('download-001'), 'active download survives history cleanup');
});

h.test('an interrupted row from a previous process becomes a failed row, while live rows stay active', () => {
  const { store } = fixture();
  const live = store.createDownload({ id: 'live', sessionId: 's', url: 'https://example.test/live', filename: 'live.bin', source: 'agent', startedAt: 10 });
  assertEqual(store.recoverInterruptedDownloads().recovered, 0, 'current process row is not retired');
  assertEqual(store.download('live')?.state, 'in_progress', 'live row remains active');
  const db = new DatabaseSync(store.databasePath);
  db.prepare("UPDATE browser_downloads SET boot_id='previous-boot' WHERE id=?").run(live.id);
  db.close();
  assertEqual(store.recoverInterruptedDownloads().recovered, 1, 'previous process row is retired');
  const recovered = store.download('live');
  assertEqual(recovered?.state, 'failed', 'restart cannot claim the old download is still running');
  assertEqual(recovered?.exists, undefined, 'a row without a path has no existence claim');
});

h.test('download store observers see creation and terminal bytes without changing tool semantics', async () => {
  const folder = join(root, 'observer-downloads');
  mkdirSync(folder, { recursive: true });
  const created: string[] = [];
  const changed: Array<Record<string, unknown>> = [];
  const store = new DownloadStore(folder, {
    created: (id, _owner, _url, value) => created.push(`${id}:${String(value.status)}`),
    changed: (id, _owner, _url, value) => changed.push({ id, status: value.status, bytes: value.bytes }),
  });
  const entry = store.create('page', 'https://example.test/file', { filename: 'file.txt' });
  assertEqual(created.length, 1, 'creation observed');
  entry.finish({ path: join(folder, 'done.txt'), bytes: 4, totalBytes: 4 });
  assertEqual(store.get(entry.id)?.status, 'completed', 'tool result remains completed');
  assertEqual(changed.at(-1)?.status, 'completed', 'terminal transition observed');
  assertEqual(changed.at(-1)?.bytes, 4, 'completion bytes observed');
  assertEqual(store.remove(entry.id), true, 'terminal handle can leave memory independently of history');
  store.dispose();
});

h.test('native download naming avoids overwriting an existing file', () => {
  const folder = join(root, 'unique-downloads');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'report.txt'), 'old');
  assertEqual(uniqueDownloadPath(folder, 'report.txt'), join(folder, 'report (1).txt'), 'next available name');
  writeFileSync(join(folder, 'report (1).txt'), 'old');
  assertEqual(uniqueDownloadPath(folder, 'report.txt'), join(folder, 'report (2).txt'), 'increments without touching old files');
});

h.test('open downloads survive download-history cleanup', () => {
  const { configRoot, store } = fixture();
  const downloads = new DownloadStore(join(configRoot, 'downloads'));
  const entry = downloads.create('page', 'https://example.test/active', { filename: 'active.bin' });
  store.createDownload({ id: entry.id, sessionId: 'task', url: 'https://example.test/active', filename: 'active.bin', source: 'other', startedAt: Date.now() });
  assertEqual(store.clearTerminalDownloads().removed, 0, 'active database row retained');
  downloads.clearSettled();
  assertEqual(store.download(entry.id)?.state, 'in_progress', 'active record still inspectable');
  downloads.dispose();
});

void h.finish(join(__dirname, 'browser-history-result.json'), 'browser-history').then(code => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
