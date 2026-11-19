import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ensureSettingsBackup, inspectSettingsBackup, restoreSettingsBackup } from '../main/app/settings-backup';
import { kvGet, kvSet } from '../main/services/settings';
import { Harness } from './harness';

const h = new Harness(), roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'klaus-settings-backup-')); roots.push(root);
  const profile = join(root, 'profile'); mkdirSync(profile);
  return { root, profile, path: join(profile, 'settings.db') };
}
function seed(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=7; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE future_metadata(id INTEGER PRIMARY KEY, value BLOB); PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("BEGIN IMMEDIATE; INSERT INTO settings VALUES ('language','zh'),('accent',' legacy-slate '); INSERT INTO future_metadata VALUES (1,x'000102ff'); COMMIT");
  return db;
}
const snapshotPath = (profile: string) => join(profile, 'migration-backups', 'electron-settings-v1');

h.test('the first snapshot includes committed WAL rows and leaves the live database untouched', async () => {
  const f = fixture(), writer = seed(f.path);
  try {
    const original = readFileSync(f.path), wal = readFileSync(`${f.path}-wal`);
    const result = await ensureSettingsBackup(f.profile); assert.equal(result.status, 'created');
    assert.deepEqual(readFileSync(f.path), original); assert.deepEqual(readFileSync(`${f.path}-wal`), wal);
    const snapshot = await inspectSettingsBackup(result.directory); assert.equal(snapshot.database?.userVersion, 7);
    const saved = new DatabaseSync(join(result.directory, 'settings.db'), { readOnly: true });
    try {
      assert.equal(saved.prepare("SELECT value FROM settings WHERE key='language'").get()?.value, 'zh');
      assert.equal(saved.prepare('SELECT hex(value) AS value FROM future_metadata').get()?.value, '000102FF');
    } finally { saved.close(); }
    if (process.platform !== 'win32') {
      assert.equal(statSync(result.directory).mode & 0o777, 0o700);
      assert.equal(statSync(join(result.directory, 'settings.db')).mode & 0o777, 0o600);
    }
  } finally { writer.close(); }
});
h.test('later starts keep the original snapshot while allowing new application data', async () => {
  const f = fixture(), writer = seed(f.path); writer.close();
  const first = await ensureSettingsBackup(f.profile), original = readFileSync(join(first.directory, 'settings.db'));
  assert.equal(kvSet('language', 'en', f.profile), true);
  const second = await ensureSettingsBackup(f.profile); assert.equal(second.status, 'existing');
  assert.deepEqual(readFileSync(join(second.directory, 'settings.db')), original); assert.equal(kvGet('language', f.profile), 'en');
});
h.test('fresh profiles are recorded once without inventing an old database backup', async () => {
  const f = fixture(); assert.equal((await ensureSettingsBackup(f.profile)).status, 'fresh');
  assert.equal((await inspectSettingsBackup(snapshotPath(f.profile))).database, null);
  kvSet('language', 'en', f.profile);
  assert.equal((await ensureSettingsBackup(f.profile)).status, 'existing');
  assert.equal((await inspectSettingsBackup(snapshotPath(f.profile))).database, null);
});
h.test('a failed snapshot does not mark success or modify the source and can be retried', async () => {
  const f = fixture(), original = Buffer.from('not a SQLite database'); writeFileSync(f.path, original);
  await assert.rejects(ensureSettingsBackup(f.profile));
  assert.deepEqual(readFileSync(f.path), original); assert.deepEqual(readdirSync(join(f.profile, 'migration-backups')), []);
  rmSync(f.path); seed(f.path).close(); assert.equal((await ensureSettingsBackup(f.profile)).status, 'created');
});
h.test('the SQLite backup deadline rejects instead of declaring an incomplete snapshot ready', async () => {
  const f = fixture(), writer = seed(f.path);
  writer.exec('INSERT INTO future_metadata VALUES (2,zeroblob(1048576))'); writer.close();
  const realNow = Date.now; let calls = 0;
  Date.now = () => calls++ === 0 ? 0 : 31_000;
  try { await assert.rejects(ensureSettingsBackup(f.profile), /deadline/); }
  finally { Date.now = realNow; }
  assert.deepEqual(readdirSync(join(f.profile, 'migration-backups')), []);
  assert.equal((await ensureSettingsBackup(f.profile)).status, 'created');
});
h.test('corrupt snapshot records and bytes stop startup without replacing the saved evidence', async () => {
  const f = fixture(); seed(f.path).close();
  const { directory } = await ensureSettingsBackup(f.profile), file = join(directory, 'settings.db');
  const source = readFileSync(f.path); writeFileSync(file, 'damaged snapshot');
  await assert.rejects(ensureSettingsBackup(f.profile), /saved hash/);
  assert.equal(readFileSync(file, 'utf8'), 'damaged snapshot'); assert.deepEqual(readFileSync(f.path), source);
  writeFileSync(join(directory, 'snapshot.json'), '{broken'); await assert.rejects(ensureSettingsBackup(f.profile));
});
h.test('recovery creates a separate readable profile and never overwrites current data', async () => {
  const f = fixture(); seed(f.path).close(); const { directory } = await ensureSettingsBackup(f.profile);
  kvSet('language', 'en', f.profile);
  const restored = join(f.root, 'recovered profile'); await restoreSettingsBackup(directory, restored);
  assert.equal(kvGet('language', restored), 'zh'); assert.equal(kvGet('language', f.profile), 'en');
  await assert.rejects(restoreSettingsBackup(directory, f.profile), /EEXIST/);
  assert.equal(kvGet('language', f.profile), 'en');
});
if (process.platform !== 'win32') h.test('symlink inputs cannot copy a different database into the migration backup', async () => {
  const f = fixture(), other = join(f.root, 'other.db'); seed(other).close(); symlinkSync(other, f.path);
  await assert.rejects(ensureSettingsBackup(f.profile), /regular file/);
  rmSync(f.path); seed(f.path).close();
  const outside = join(f.root, 'outside'); mkdirSync(outside); rmSync(join(f.profile, 'migration-backups'), { recursive: true });
  symlinkSync(outside, join(f.profile, 'migration-backups')); await assert.rejects(ensureSettingsBackup(f.profile), /regular directory/);
  assert.deepEqual(readdirSync(outside), []);
});

void h.finish(join(__dirname, 'settings-backup-result.json'), 'settings-backup').then(code => {
  for (const root of roots) rmSync(root, { recursive: true, force: true }); process.exitCode = code;
});
