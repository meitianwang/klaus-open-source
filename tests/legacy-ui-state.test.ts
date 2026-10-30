import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LEGACY_UI_STATE_CONSUMED, LEGACY_UI_STATE_KV_KEY, LEGACY_UI_STATE_LIMITS,
  parseLegacyUiStateSnapshot,
} from '../contracts/legacy-ui-state';
import { stageLegacyUiState, WEBKIT_UI_STATE_LIMITS } from '../main/app/legacy-ui-state';
import { handleCoreInvoke, type FrameLike } from '../main/ipc/binding';
import { RoleTable, type Json } from '../main/ipc/contract';
import { registerSettingsHandlers } from '../main/ipc/handlers/settings';
import { ChannelRegistry } from '../main/ipc/registry';
import { IpcRouter } from '../main/ipc/router';
import { kvGet, kvSet, settingsDbPath } from '../main/services/settings';
import { Harness } from './harness';

const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/legacy-ui-state.json'), 'utf8')) as {
  originHex: string;
  limits: typeof WEBKIT_UI_STATE_LIMITS & typeof LEGACY_UI_STATE_LIMITS;
  cases: Array<{ name: string; source: Record<string, string>; expectedStage: Record<string, string> }>;
};
const h = new Harness(), roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'klaus-ui-state-test-')); roots.push(root);
  const home = join(root, 'home'), profile = join(home, '.klaus');
  const webkit = join(home, 'Library/WebKit/ai.klaus.desktop/WebsiteData/Default');
  const client = join(webkit, 'fixture-top', 'fixture-client');
  const path = join(client, 'LocalStorage/localstorage.sqlite3');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(join(client, 'origin'), Buffer.from(vectors.originHex, 'hex'));
  return { root, home, profile, webkit, client, path };
}

function seed(path: string, entries: Record<string, string>, wal = false): DatabaseSync {
  const db = new DatabaseSync(path);
  if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)');
  db.exec('BEGIN IMMEDIATE');
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(entries)) insert.run(key, Buffer.from(value, 'utf16le'));
  db.exec('COMMIT');
  return db;
}

function originalFiles(path: string) {
  return Object.fromEntries(readdirSync(dirname(path)).sort().map(name => [name, readFileSync(join(dirname(path), name))]));
}

function assertNotStaged(profile: string) {
  if (existsSync(settingsDbPath(profile))) assert.equal(kvGet(LEGACY_UI_STATE_KV_KEY, profile), null);
}

for (const vector of vectors.cases) h.test(vector.name, () => {
  const f = fixture(); seed(f.path, vector.source).close();
  const original = originalFiles(f.path);
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'staged', entries: Object.keys(vector.expectedStage).length });
  assert.deepEqual(parseLegacyUiStateSnapshot(kvGet(LEGACY_UI_STATE_KV_KEY, f.profile))?.entries, vector.expectedStage);
  assert.deepEqual(originalFiles(f.path), original);
});

h.test('the contract pins finite limits for every allocation and traversal boundary', () => {
  assert.deepEqual({ ...WEBKIT_UI_STATE_LIMITS, ...LEGACY_UI_STATE_LIMITS }, vectors.limits);
});

h.test('large Unicode and escaped snapshots cross the real settings invoke path intact', async () => {
  for (const character of ['中', '"']) {
    const value = character.repeat(vectors.limits.valueChars - 50);
    const entries = { klaus_session_drafts: value, klaus_session_histories: value };
    const f = fixture(); seed(f.path, entries).close();
    assert.equal(stageLegacyUiState(f.profile, f.home, 'darwin').status, 'staged');
    const registry = new ChannelRegistry();
    registerSettingsHandlers(registry, {
      configRoot: f.profile,
      request: async () => { throw new Error('UI migration must not start the engine'); },
      onSettingsChanged: () => {},
    });
    const router = new IpcRouter({ registry, roles: RoleTable.load() });
    const frame: FrameLike = { routingId: 1, processId: 1, url: 'klaus-app://app/index.html', isDestroyed: () => false };
    const sender = { id: 1, mainFrame: frame, isDestroyed: () => false, send: () => {} };
    const invoke = async (channel: string, payload: Json) => {
      const reply = await handleCoreInvoke({
        roleOf: () => 'main', route: router.route.bind(router),
        windowOp: () => { throw new Error('UI migration does not use window operations'); },
      }, { sender, senderFrame: frame }, 'ipc_invoke', { channel, args: [payload] });
      assert(reply.ok);
      return structuredClone(reply.value);
    };
    const raw = await invoke('settings:kv:get', { key: LEGACY_UI_STATE_KV_KEY });
    assert.equal(typeof raw, 'string');
    assert.equal(raw, kvGet(LEGACY_UI_STATE_KV_KEY, f.profile));
    assert.deepEqual(parseLegacyUiStateSnapshot(raw)?.entries, entries);
    const text = raw as string;
    assert(Buffer.byteLength(text) > 2 * 1024 * 1024, 'invoke replies are independent of the push queue budget');
    assert(text.length <= vectors.limits.jsonChars);
    if (character === '"') assert(text.length > vectors.limits.jsonChars - 200);
    else assert(Buffer.byteLength(text) > 14_000_000, 'UTF8 size can exceed the JSON character budget');
    assert.deepEqual(await invoke('settings:kv:set', { key: LEGACY_UI_STATE_KV_KEY, value: LEGACY_UI_STATE_CONSUMED }), { ok: true });
    assert.equal(await invoke('settings:kv:get', { key: LEGACY_UI_STATE_KV_KEY }), LEGACY_UI_STATE_CONSUMED);
    h.info('invoke snapshot budget', `${character === '"' ? 'escaped' : 'Unicode'}: ${text.length} chars, ${Buffer.byteLength(text)} UTF8 bytes`);
  }
});

h.test('a committed WAL snapshot preserves every original database WAL and SHM byte', () => {
  const f = fixture(), writer = seed(f.path, { klaus_welcome_draft: 'committed fixture draft' }, true);
  try {
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('klaus_sidebar_collapsed', Buffer.from('1', 'utf16le'));
    const original = originalFiles(f.path);
    assert(existsSync(f.path + '-wal')); assert(existsSync(f.path + '-shm'));
    assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'staged', entries: 1 });
    assert.deepEqual(parseLegacyUiStateSnapshot(kvGet(LEGACY_UI_STATE_KV_KEY, f.profile))?.entries, { klaus_welcome_draft: 'committed fixture draft' });
    assert.deepEqual(originalFiles(f.path), original);
  } finally { writer.exec('ROLLBACK'); writer.close(); }
});

h.test('isolated profiles and other platforms never inspect or stage the default profile', () => {
  const f = fixture(); seed(f.path, { klaus_sidebar_collapsed: '1' }).close();
  for (const platform of ['win32', 'linux'] as const) {
    assert.deepEqual(stageLegacyUiState(f.profile, f.home, platform), { status: 'skipped' });
  }
  const isolated = join(f.root, 'isolated');
  assert.deepEqual(stageLegacyUiState(isolated, f.home, 'darwin'), { status: 'skipped' });
  assert.deepEqual(stageLegacyUiState(f.profile, undefined, 'darwin'), { status: 'skipped' });
  assert(!existsSync(f.profile)); assert(!existsSync(isolated));
});

h.test('missing sources do not create a completion record and may be retried', () => {
  const f = fixture();
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'missing' });
  assert(!existsSync(f.profile));
  seed(f.path, { klaus_sidebar_collapsed: '1' }).close();
  assert.equal(stageLegacyUiState(f.profile, f.home, 'darwin').status, 'staged');
});

h.test('origin validation rejects different schemes hosts and origin pairs', () => {
  for (const changedByte of [5, 15, 30, 40]) {
    const f = fixture(); seed(f.path, { klaus_sidebar_collapsed: '1' }).close();
    const origin = Buffer.from(vectors.originHex, 'hex'); origin[changedByte] = 120;
    writeFileSync(join(f.client, 'origin'), origin);
    assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'missing' });
    assert(!existsSync(f.profile));
  }
});

h.test('staged data and consumed tombstones are never replaced by later source changes', () => {
  const f = fixture(); seed(f.path, { klaus_sidebar_collapsed: '1' }).close();
  assert.equal(stageLegacyUiState(f.profile, f.home, 'darwin').status, 'staged');
  const first = kvGet(LEGACY_UI_STATE_KV_KEY, f.profile);
  const writer = new DatabaseSync(f.path);
  writer.prepare('UPDATE ItemTable SET value = ?').run(Buffer.from('0', 'utf16le')); writer.close();
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'existing' });
  assert.equal(kvGet(LEGACY_UI_STATE_KV_KEY, f.profile), first);
  assert.equal(kvSet(LEGACY_UI_STATE_KV_KEY, LEGACY_UI_STATE_CONSUMED, f.profile), true);
  rmSync(f.path);
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'existing' });
  assert.equal(kvGet(LEGACY_UI_STATE_KV_KEY, f.profile), LEGACY_UI_STATE_CONSUMED);
});

h.test('failed SQLite reads remain retryable without mutating the original evidence', () => {
  const f = fixture(); writeFileSync(f.path, 'broken SQLite fixture');
  const original = originalFiles(f.path);
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'read-failed' });
  assertNotStaged(f.profile); assert.deepEqual(originalFiles(f.path), original);
  rmSync(f.path); seed(f.path, { klaus_sidebar_collapsed: '1' }).close();
  assert.equal(stageLegacyUiState(f.profile, f.home, 'darwin').status, 'staged');
});

h.test('malformed UTF16 blobs fail the whole snapshot instead of consuming partial state', () => {
  const f = fixture(), writer = seed(f.path, { klaus_sidebar_collapsed: '1' });
  writer.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('klaus_welcome_draft', Buffer.from([0x61])); writer.close();
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'read-failed' });
  assertNotStaged(f.profile);
});

h.test('settings failures preserve source state and can stage after the database is repaired', () => {
  const f = fixture(); seed(f.path, { klaus_sidebar_collapsed: '1' }).close();
  mkdirSync(f.profile); writeFileSync(settingsDbPath(f.profile), 'broken settings fixture');
  const original = originalFiles(f.path);
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'settings-failed' });
  assert.deepEqual(originalFiles(f.path), original);
  rmSync(settingsDbPath(f.profile));
  assert.equal(stageLegacyUiState(f.profile, f.home, 'darwin').status, 'staged');
});

h.test('row and database byte budgets reject excessive sources without marking completion', () => {
  const f = fixture(), writer = seed(f.path, {});
  writer.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < ${vectors.limits.rows + 1}) INSERT INTO ItemTable SELECT 'ignored.' || n, X'3000' FROM rows`);
  writer.close();
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'limit-exceeded' });
  assertNotStaged(f.profile);
  truncateSync(f.path, vectors.limits.sourceBytes + 1);
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'limit-exceeded' });
  assertNotStaged(f.profile);
});

h.test('individual values and the total restore map have bounded memory use', () => {
  const cases = [
    { klaus_welcome_draft: 'x'.repeat(vectors.limits.valueChars + 1) },
    Object.fromEntries(Array.from({ length: vectors.limits.entries + 1 }, (_, i) => [`klaus.panelTabs.fixture-${i}`, '{}'])),
    { klaus_session_drafts: 'x'.repeat(vectors.limits.valueChars), klaus_session_histories: 'x'.repeat(vectors.limits.valueChars) },
  ];
  for (const entries of cases) {
    const f = fixture(); seed(f.path, entries).close();
    assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'limit-exceeded' });
    assertNotStaged(f.profile);
  }
});

h.test('directory traversal stops at the committed entry budget', () => {
  const f = fixture(); seed(f.path, { klaus_sidebar_collapsed: '1' }).close();
  for (let i = 0; i < vectors.limits.directoryEntries; i++) mkdirSync(join(f.webkit, `extra-${i}`));
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'limit-exceeded' });
  assertNotStaged(f.profile);
});

h.test('ambiguous matching origins are not resolved by guessing which profile is newer', () => {
  const f = fixture(); seed(f.path, { klaus_sidebar_collapsed: '1' }).close();
  const other = join(f.webkit, 'other-top/other-client'); mkdirSync(join(other, 'LocalStorage'), { recursive: true });
  writeFileSync(join(other, 'origin'), Buffer.from(vectors.originHex, 'hex'));
  seed(join(other, 'LocalStorage/localstorage.sqlite3'), { klaus_sidebar_collapsed: '0' }).close();
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'unsafe-source' });
  assertNotStaged(f.profile);
});

if (process.platform !== 'win32') h.test('symlinks cannot redirect database reads or settings writes outside the profile', () => {
  const f = fixture(), outside = join(f.root, 'outside.sqlite3'); seed(outside, { klaus_sidebar_collapsed: '1' }).close();
  symlinkSync(outside, f.path);
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'unsafe-source' });
  assertNotStaged(f.profile);
  rmSync(f.path); seed(f.path, { klaus_sidebar_collapsed: '1' }).close();
  symlinkSync(outside, f.path + '-wal');
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'unsafe-source' });
  assertNotStaged(f.profile); rmSync(f.path + '-wal');
  const destination = join(f.root, 'outside-profile'); mkdirSync(destination); symlinkSync(destination, f.profile);
  assert.deepEqual(stageLegacyUiState(f.profile, f.home, 'darwin'), { status: 'failed', reason: 'unsafe-source' });
  assert.deepEqual(readdirSync(destination), []);
});

void h.finish(join(__dirname, 'legacy-ui-state-result.json'), 'legacy-ui-state').then(code => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
