const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { app, safeStorage } = require('electron');
const { WindowsCredentialStore } = require('../../dist/main/native/windows-credentials');
const { prepareWindowsProfile } = require('../../dist/main/app/windows-profile');
const root = process.env.KLAUS_WINDOWS_PROFILE_TEST_ROOT;
const [mode, phase] = process.argv.slice(2);
if (process.platform !== 'win32' || !root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-windows-profile-gate-')
  || !['before', 'after', 'cleanup', 'missing'].includes(mode) || !['seed', 'crash', 'recover'].includes(phase)) throw new Error('An isolated Windows recovery fixture is required');
const base = path.join(root, mode), configRoot = path.join(base, 'config'), legacy = path.join(base, 'legacy-profile');
const profile = phase === 'seed' ? legacy : path.join(configRoot, 'electron');
fs.mkdirSync(configRoot, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration();
const encrypted = path.join(configRoot, '.credentials.enc'), plaintext = path.join(configRoot, '.credentials.json');
const marker = path.join(configRoot, 'electron', 'credential-profile-owner.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const options = { configRoot, appData: path.join(base, 'unused-roaming'), legacyUserDataDir: legacy };
// Preparation must occur before readiness and before any safeStorage call in the new profile.
const prepared = phase === 'seed' ? undefined : prepareWindowsProfile(options);
const evidence = path.join(base, 'seed-evidence.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function keyPersisted(file) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try { if (json(file).os_crypt?.encrypted_key) return; } catch {}
    await sleep(25);
  }
  throw new Error('The synthetic profile encryption key did not reach disk');
}
let value;
async function run() {
  if (phase === 'crash' && mode !== 'missing') {
    assert.ok(prepared.legacyPlaintextProof); assert.equal(prepared.keyError, undefined);
    assert.equal(json(path.join(configRoot, 'electron', 'Local State')).os_crypt.encrypted_key, json(path.join(legacy, 'Local State')).os_crypt.encrypted_key);
  }
  await app.whenReady();
  assert.ok(process.versions.electron); assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
  if (phase === 'seed') {
    const bytes = mode === 'missing' ? Buffer.from('v10-opaque-unknown-original-secrets')
      : await safeStorage.encryptStringAsync(JSON.stringify({ claudeAiOauth: { accessToken: 'old-electron-fixture' }, unknownOldSecret: 'preserve-this-fixture' }));
    fs.writeFileSync(encrypted, bytes, { flush: true });
    fs.writeFileSync(plaintext, JSON.stringify({ claudeAiOauth: { accessToken: 'current-tauri-fixture' }, plaintextOther: 'preserve-this-fixture' }), { flush: true });
    if (mode !== 'missing') await keyPersisted(path.join(legacy, 'Local State'));
    fs.writeFileSync(evidence, JSON.stringify({ encryptedSha256: sha(bytes), plaintextSha256: sha(fs.readFileSync(plaintext)) }), { flush: true });
    return;
  }
  let journal = prepared.legacyMigrationJournal;
  if (phase === 'crash') {
    assert.ok(journal);
    if (mode === 'missing') assert.equal(prepared.keyError, 'windows_credentials_legacy_key_required');
    const original = journal;
    journal = {
      prepare: async hash => {
        await original.prepare(hash);
        if (mode === 'before') {
          assert.equal(sha(fs.readFileSync(encrypted)), json(evidence).encryptedSha256);
          console.log('  crash point: intent durable, original encrypted file unchanged'); app.exit(0);
          await new Promise(() => {});
        }
      },
      commit: async hash => {
        assert.equal(sha(fs.readFileSync(encrypted)), hash);
        assert.equal(json(marker).owned, false);
        if (mode === 'cleanup') fs.writeFileSync(plaintext, JSON.stringify({ claudeAiOauth: { accessToken: 'changed-unproven-plaintext' }, foreignData: true }), { flush: true });
        console.log('  crash point: new encrypted file durable, ownership acknowledgement absent'); app.exit(0);
        await new Promise(() => {});
      },
    };
  }
  value = new WindowsCredentialStore(randomUUID(), configRoot, safeStorage, 30_000, prepared.keyError,
    prepared.legacyPlaintextProof, journal, prepared.legacyPlaintextCleanupSha256);
  const expected = phase === 'crash' || mode === 'before' ? 'current-tauri-fixture' : 'new-secure-fixture';
  assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: expected } });
  if (phase === 'crash') {
    const written = await value.writeClaudeOAuth({ accessToken: 'new-secure-fixture' });
    throw new Error(`Expected the controlled crash callback; write result ${JSON.stringify(written)}`);
  }
  if (mode !== 'before') assert.equal(prepared.legacyPlaintextProof, undefined);
  const warning = mode === 'cleanup' ? { warning: 'legacy_credential_cleanup_failed' } : {};
  assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'second-secure-fixture' }), { success: true, ...warning });
  assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'second-secure-fixture' } });
  assert.equal(fs.readFileSync(encrypted).includes(Buffer.from('second-secure-fixture')), false);
  const backups = path.join(configRoot, 'migration-backups', 'windows-credentials');
  const directory = fs.readdirSync(backups).find(name => sha(fs.readFileSync(path.join(backups, name, 'credentials.enc'))) === json(evidence).encryptedSha256);
  assert.ok(directory); assert.equal(sha(fs.readFileSync(path.join(backups, directory, 'credentials.json'))), json(evidence).plaintextSha256);
  if (mode === 'cleanup') assert.deepEqual(json(plaintext), { claudeAiOauth: { accessToken: 'changed-unproven-plaintext' }, foreignData: true });
  else assert.deepEqual(json(plaintext), { plaintextOther: 'preserve-this-fixture' });
  assert.equal(json(marker).owned, true);
  console.log(`windows-profile-${mode}-recover: 1 passed, 0 failed`);
}
const watchdog = setTimeout(() => { console.error('Windows recovery fixture deadline'); app.exit(1); }, 60_000);
run().then(async () => { if (value) assert.equal((await value.close()).complete, true); clearTimeout(watchdog); app.exit(0); })
  .catch(error => { console.error(error.stack); clearTimeout(watchdog); app.exit(1); });
