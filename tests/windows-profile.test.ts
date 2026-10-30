import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { strict as strictAssert } from 'node:assert';
import { join } from 'node:path';
import { prepareWindowsProfile } from '../main/app/windows-profile';
import { Harness, assert, assertEqual } from './harness';
const h = new Harness(), roots: string[] = [];
const key = (text: string) => Buffer.from('DPAPI' + text).toString('base64');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'klaus-profile-')); roots.push(root);
  const configRoot = join(root, 'config'), appData = join(root, 'roaming');
  const target = join(configRoot, 'electron', 'Local State'), legacy = join(appData, 'Klaus', 'Local State');
  mkdirSync(join(configRoot, 'electron'), { recursive: true }); mkdirSync(join(appData, 'Klaus'), { recursive: true });
  writeFileSync(join(configRoot, '.credentials.enc'), 'v10-synthetic-encrypted-credential');
  return { root, configRoot, appData, target, legacy, run: () => prepareWindowsProfile({ configRoot, appData }) };
}
function state(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value)); }
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
h.test('restores only encryption fields and backs up the original blob and states together', () => {
  const f = fixture(); state(f.target, { keep: 42, os_crypt: { unrelated: true } });
  state(f.legacy, { oldOnly: true, os_crypt: { encrypted_key: key('A'), audit_enabled: true } });
  const before = readFileSync(f.legacy), result = f.run(); assertEqual(result.status, 'restored', 'migration status');
  const next = json(f.target); assertEqual(next.keep, 42, 'destination preserved'); assertEqual(next.oldOnly, undefined, 'no whole profile copy');
  assertEqual(next.os_crypt.encrypted_key, key('A'), 'exact key'); assertEqual(next.os_crypt.audit_enabled, true, 'audit bit'); assert(next.os_crypt.unrelated, 'other crypto fields');
  assert(readFileSync(f.legacy).equals(before), 'source unchanged');
  assert(readFileSync(join(result.backupDirectory!, 'credentials.enc')).equals(readFileSync(join(f.configRoot, '.credentials.enc'))), 'blob backed up');
  assert(json(join(result.backupDirectory!, 'sources.json')).states.length === 2, 'both local states backed up');
  assertEqual(f.run().status, 'current', 'restart is idempotent');
});
h.test('conflicting current or ambiguous legacy keys block access without replacing either', () => {
  const f = fixture(); state(f.target, { os_crypt: { encrypted_key: key('B') } }); state(f.legacy, { os_crypt: { encrypted_key: key('A') } });
  const before = readFileSync(f.target); assertEqual(f.run().keyError, 'windows_credentials_key_conflict', 'current conflict');
  assert(readFileSync(f.target).equals(before), 'destination untouched');
  rmSync(f.target); const dev = join(f.appData, 'klaus-desktop-dev'); mkdirSync(dev); state(join(dev, 'Local State'), { os_crypt: { encrypted_key: key('B') } });
  assertEqual(f.run().keyError, 'windows_credentials_key_conflict', 'ambiguous legacy'); assert(!existsSync(f.target), 'no guessed key written');
});
h.test('missing and invalid keys preserve old credentials and return an actionable error', () => {
  const f = fixture(); assertEqual(f.run().keyError, 'windows_credentials_legacy_key_required', 'missing key');
  state(f.target, { os_crypt: { encrypted_key: 'not-a-DPAPI-key' } });
  assertEqual(f.run().keyError, 'windows_credentials_key_conflict', 'malformed current key');
  assertEqual(readFileSync(join(f.configRoot, '.credentials.enc'), 'utf8'), 'v10-synthetic-encrypted-credential', 'old blob unchanged');
});
h.test('an explicitly configured legacy profile is read without copying unrelated data', () => {
  const f = fixture(), custom = join(f.root, 'custom'); mkdirSync(custom); state(join(custom, 'Local State'), { os_crypt: { encrypted_key: key('C') } });
  assertEqual(prepareWindowsProfile({ ...f, legacyUserDataDir: custom }).status, 'restored', 'custom source');
  assertEqual(json(f.target).os_crypt.encrypted_key, key('C'), 'custom exact key');
});
h.test('disabled legacy migration never reads domestic or explicitly supplied legacy states', () => {
  const f = fixture(), custom = join(f.root, 'custom'); mkdirSync(custom);
  writeFileSync(f.legacy, '{unreadable-domestic-state'); writeFileSync(join(custom, 'Local State'), '{unreadable-custom-state');
  const result = prepareWindowsProfile({ ...f, legacyMigration: false, legacyUserDataDir: custom });
  assertEqual(result.keyError, 'windows_credentials_legacy_key_required', 'no borrowed DPAPI key');
  assert(!existsSync(f.target), 'no foreign key restored');
  assertEqual(json(join(result.backupDirectory!, 'sources.json')).states.length, 0, 'no foreign state backed up');
  state(f.target, { os_crypt: { encrypted_key: key('independent') } });
  assertEqual(prepareWindowsProfile({ ...f, legacyMigration: false, legacyUserDataDir: custom }).status, 'current', 'own profile key remains usable');
});
h.test('a fresh application profile keeps owning later credentials despite stale legacy keys', () => {
  const f = fixture(); rmSync(join(f.configRoot, '.credentials.enc')); state(f.legacy, { os_crypt: { encrypted_key: key('old') } });
  assertEqual(f.run().status, 'fresh', 'no existing blob'); assert(!existsSync(f.target), 'Chromium initializes its own key');
  state(f.target, { os_crypt: { encrypted_key: key('new') } }); writeFileSync(join(f.configRoot, '.credentials.enc'), 'v10-new-blob');
  assertEqual(f.run().status, 'current', 'new app profile trusted on restart');
});
h.test('invalid Local State fails before startup and leaves every original byte intact', () => {
  const f = fixture(); writeFileSync(f.legacy, '{broken');
  let error: unknown; try { f.run(); } catch (caught) { error = caught; }
  assert(error instanceof Error && error.message === 'WINDOWS_PROFILE_INVALID_JSON', 'explicit startup failure');
  assertEqual(readFileSync(f.legacy, 'utf8'), '{broken', 'malformed state untouched'); assert(!existsSync(f.target), 'no target generated');
});
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function coexistence() {
  const f = fixture(), plaintext = join(f.configRoot, '.credentials.json'), encrypted = join(f.configRoot, '.credentials.enc');
  const marker = join(f.configRoot, 'electron', 'credential-profile-owner.json');
  state(f.target, { os_crypt: { encrypted_key: key('A') } });
  state(plaintext, { claudeAiOauth: { accessToken: 'synthetic-current-tauri-token' }, pluginSecrets: { retain: 'synthetic-other-secret' } });
  return { ...f, plaintext, encrypted, marker };
}
h.test('v1 ownership does not hide a valid current plaintext login beside the old blob', () => {
  const f = coexistence(); state(f.marker, { version: 1, owned: true, keyDigest: sha(Buffer.from(key('A'))) });
  const original = readFileSync(f.plaintext), encrypted = readFileSync(f.encrypted), result = f.run();
  strictAssert.deepEqual(result.legacyPlaintextProof, { encryptedSha256: sha(encrypted), plaintextSha256: sha(original) });
  strictAssert.equal(json(f.marker).owned, false);
  strictAssert.ok(readFileSync(join(result.backupDirectory!, 'credentials.json')).equals(original));
  strictAssert.ok(readFileSync(join(result.backupDirectory!, 'credentials.enc')).equals(encrypted));
  strictAssert.deepEqual(f.run().legacyPlaintextProof, result.legacyPlaintextProof);
});
h.test('the durable intent can resume before replacement and ownership prevents later token rollback', async () => {
  const f = coexistence(), first = f.run(), original = readFileSync(f.encrypted);
  await first.legacyMigrationJournal!.prepare(sha(Buffer.from('not-yet-written')));
  strictAssert.ok(readFileSync(f.encrypted).equals(original));
  const restarted = f.run(); strictAssert.deepEqual(restarted.legacyPlaintextProof, first.legacyPlaintextProof);
  const encrypted = Buffer.from('replacement-encrypted-fixture');
  await restarted.legacyMigrationJournal!.prepare(sha(encrypted));
  writeFileSync(f.encrypted, encrypted);
  await restarted.legacyMigrationJournal!.commit(sha(encrypted));
  await restarted.legacyMigrationJournal!.commit(sha(encrypted));
  strictAssert.equal(json(f.marker).owned, true);
  const recovered = f.run(); strictAssert.equal(recovered.legacyPlaintextProof, undefined);
  strictAssert.deepEqual(json(f.plaintext), { pluginSecrets: { retain: 'synthetic-other-secret' } });
  strictAssert.ok(readFileSync(f.encrypted).equals(encrypted));
  writeFileSync(f.encrypted, 'second-normal-encrypted-write'); writeFileSync(f.legacy, '{retired-profile-is-not-read');
  strictAssert.equal(f.run().status, 'current');
});
h.test('a crash after encrypted replacement recovers ownership before plaintext cleanup', async () => {
  const f = coexistence(), prepared = f.run(), encrypted = Buffer.from('already-committed-encrypted-fixture');
  await prepared.legacyMigrationJournal!.prepare(sha(encrypted));
  writeFileSync(f.encrypted, encrypted);
  strictAssert.equal(json(f.marker).owned, false);
  const recovered = f.run();
  strictAssert.equal(recovered.legacyPlaintextProof, undefined);
  strictAssert.equal(json(f.marker).version, 2); strictAssert.equal(json(f.marker).owned, true);
  strictAssert.deepEqual(json(f.plaintext), { pluginSecrets: { retain: 'synthetic-other-secret' } });
  strictAssert.ok(readFileSync(f.encrypted).equals(encrypted));
});
h.test('changed plaintext after a committed migration is preserved without becoming authoritative', async () => {
  const f = coexistence(), prepared = f.run(), encrypted = Buffer.from('committed-before-cleanup-failure');
  await prepared.legacyMigrationJournal!.prepare(sha(encrypted)); writeFileSync(f.encrypted, encrypted);
  state(f.plaintext, { claudeAiOauth: { accessToken: 'different-legacy-token' }, unrelated: 'new-data' });
  const changed = readFileSync(f.plaintext), recovered = f.run();
  strictAssert.equal(recovered.warning, 'legacy_credential_cleanup_failed');
  strictAssert.equal(recovered.legacyPlaintextProof, undefined); strictAssert.equal(json(f.marker).owned, true);
  strictAssert.ok(readFileSync(f.plaintext).equals(changed));
  strictAssert.equal(f.run().legacyPlaintextProof, undefined);
});
h.test('backup corruption, byte-hash races and unexpected ciphertext explicitly block migration', async () => {
  const f = coexistence(), prepared = f.run(), original = readFileSync(f.encrypted);
  writeFileSync(join(prepared.backupDirectory!, 'credentials.enc'), 'changed-backup');
  await strictAssert.rejects(prepared.legacyMigrationJournal!.prepare(sha(Buffer.from('next'))), /BACKUP_PROOF_INVALID/);
  strictAssert.throws(() => f.run(), /BACKUP_PROOF_INVALID/);
  strictAssert.ok(readFileSync(f.encrypted).equals(original));
  const changed = coexistence(); changed.run();
  writeFileSync(changed.plaintext, readFileSync(changed.plaintext, 'utf8') + ' ');
  strictAssert.throws(() => changed.run(), /MIGRATION_CHANGED/);
  const unknown = coexistence(), pending = unknown.run();
  await pending.legacyMigrationJournal!.prepare(sha(Buffer.from('intended')));
  writeFileSync(unknown.encrypted, 'unexpected-third-value');
  strictAssert.throws(() => unknown.run(), /MIGRATION_CHANGED/);
});
h.test('journal admission rejects changed markers or profile keys before replacing credentials', async () => {
  const f = coexistence(), prepared = f.run();
  state(f.marker, { ...json(f.marker), foreignChange: true });
  await strictAssert.rejects(prepared.legacyMigrationJournal!.prepare(sha(Buffer.from('next'))), /MARKER_CHANGED/);
  const other = coexistence(), second = other.run();
  state(other.target, { os_crypt: { encrypted_key: key('B') } });
  await strictAssert.rejects(second.legacyMigrationJournal!.prepare(sha(Buffer.from('next'))), /CURRENT_KEY_CHANGED/);
});
h.test('plaintext-only development data is backed up while Chromium creates the new profile key', () => {
  const f = coexistence(); rmSync(f.encrypted); rmSync(f.target);
  state(f.legacy, { os_crypt: { encrypted_key: key('old-retired-key') } });
  const result = f.run(); strictAssert.equal(result.status, 'fresh');
  strictAssert.ok(readFileSync(join(result.backupDirectory!, 'credentials.json')).equals(readFileSync(f.plaintext)));
  strictAssert.equal(f.run().status, 'fresh');
  state(f.target, { os_crypt: { encrypted_key: key('new-app-key') } }); writeFileSync(f.encrypted, 'new-encrypted-write');
  strictAssert.equal(f.run().status, 'current'); strictAssert.equal(json(f.marker).legacyPlaintextOnly, undefined);
});
h.test('new key persistence waits asynchronously and rechecks legacy hashes after the wait', async () => {
  const f = coexistence(); rmSync(f.target);
  const prepared = f.run(); strictAssert.equal(prepared.keyError, 'windows_credentials_legacy_key_required');
  const waiting = prepared.legacyMigrationJournal!.prepare(sha(Buffer.from('new-encrypted-value')));
  const timer = setTimeout(() => { state(f.target, { os_crypt: { encrypted_key: key('new') } }); }, 30);
  try { await waiting; } finally { clearTimeout(timer); }
  strictAssert.equal(json(f.marker).pendingNewEncryptedSha256, sha(Buffer.from('new-encrypted-value')));
  const changed = coexistence(); rmSync(changed.target);
  const pending = changed.run().legacyMigrationJournal!.prepare(sha(Buffer.from('never-written')));
  const release = setTimeout(() => {
    writeFileSync(changed.plaintext, readFileSync(changed.plaintext, 'utf8') + ' ');
    state(changed.target, { os_crypt: { encrypted_key: key('new') } });
  }, 30);
  try { await strictAssert.rejects(pending, /MIGRATION_CHANGED/); } finally { clearTimeout(release); }
});
void (async () => { const failed = await h.finish(join(__dirname, 'windows-profile-result.json'), 'windows-profile'); for (const root of roots) rmSync(root, { recursive: true, force: true }); process.exit(failed); })();
