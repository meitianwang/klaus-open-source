const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { WindowsCredentialStore, readLegacyClaudeOAuth, pruneLegacyClaudeOAuth } = require('../../dist/main/native/windows-credentials');
const { prepareWindowsProfile } = require('../../dist/main/app/windows-profile');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }

module.exports = async function coexistenceTests(test, root, storage, live) {
  async function fixture(options = {}) {
    const configRoot = path.join(root, randomUUID()), backend = storage();
    fs.mkdirSync(path.join(configRoot, 'electron'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'electron', 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI-synthetic-profile-key').toString('base64') } }));
    const encrypted = path.join(configRoot, '.credentials.enc'), plaintext = path.join(configRoot, '.credentials.json');
    const originalEncrypted = options.opaque ? Buffer.from('v10-opaque-unknown-secrets-preserved-in-backup')
      : await backend.encryptStringAsync(JSON.stringify({ claudeAiOauth: { accessToken: 'old-electron' }, encryptedOnly: 'retain', shared: 'old' }));
    const originalPlaintext = Buffer.from(JSON.stringify(options.plaintext ?? { claudeAiOauth: { accessToken: 'current-tauri' }, plaintextOnly: 'retain', shared: 'current' }));
    fs.writeFileSync(encrypted, originalEncrypted); fs.writeFileSync(plaintext, originalPlaintext);
    const prepared = prepareWindowsProfile({ configRoot, appData: path.join(root, 'unused-roaming') });
    function construct(overrides = {}) {
      const value = new WindowsCredentialStore(randomUUID(), configRoot, overrides.backend ?? backend, overrides.deadlineMs ?? 5000,
        overrides.keyError ?? prepared.keyError, overrides.proof ?? prepared.legacyPlaintextProof,
        overrides.noJournal ? undefined : overrides.journal ?? prepared.legacyMigrationJournal);
      live.add(value); return value;
    }
    return { configRoot, encrypted, plaintext, originalEncrypted, originalPlaintext, prepared, backend, construct };
  }
  async function close(value) { assert.equal((await value.close()).complete, true); live.delete(value); }

  await test('proven current plaintext wins while decryptable old unrelated keys survive migration and later writes', async () => {
    const f = await fixture(), proof = { ...f.prepared.legacyPlaintextProof }, value = f.construct({ proof });
    proof.plaintextSha256 = '0'.repeat(64);
    assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'current-tauri' } });
    assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'new-secure' }), { success: true });
    assert.deepEqual(JSON.parse((await f.backend.decryptStringAsync(fs.readFileSync(f.encrypted))).result), {
      encryptedOnly: 'retain', plaintextOnly: 'retain', shared: 'current', claudeAiOauth: { accessToken: 'new-secure' },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.plaintext, 'utf8')), { plaintextOnly: 'retain', shared: 'current' });
    assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'second-secure' }), { success: true });
    assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'second-secure' } });
    assert.equal(await value.removeClaudeOAuth(), true); assert.deepEqual(await value.readClaudeOAuth(), { value: null });
    await close(value);
  });
  await test('opaque old bytes and compatible tokens migrate only with verified backup proof', async () => {
    const f = await fixture({ opaque: true, plaintext: { claudeAiOauth: null, tokens: { accessToken: 'compatible-current' }, keep: 'other' } });
    const value = f.construct({ keyError: 'windows_credentials_legacy_key_required' });
    assert.deepEqual(readLegacyClaudeOAuth(f.originalPlaintext), { accessToken: 'compatible-current' });
    assert.deepEqual(JSON.parse(pruneLegacyClaudeOAuth(f.originalPlaintext).bytes), { keep: 'other' });
    assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'compatible-current' } });
    assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'secure-current' }), { success: true });
    assert.deepEqual(fs.readFileSync(path.join(f.prepared.backupDirectory, 'credentials.enc')), f.originalEncrypted);
    assert.deepEqual(fs.readFileSync(path.join(f.prepared.backupDirectory, 'credentials.json')), f.originalPlaintext);
    assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'secure-current' } });
    await close(value);
  });
  await test('raw-byte changes invalidate both read and mutation proof without touching either source', async () => {
    for (const target of ['plaintext', 'encrypted']) {
      const f = await fixture({ opaque: true }), value = f.construct();
      fs.appendFileSync(f[target], ' ');
      const encrypted = fs.readFileSync(f.encrypted), plaintext = fs.readFileSync(f.plaintext);
      assert.deepEqual(await value.readClaudeOAuth(), { value: null, error: 'windows_legacy_plaintext_proof_invalid' });
      assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'forbidden' }), { success: false, error: 'windows_legacy_plaintext_proof_invalid' });
      assert.equal(await value.removeClaudeOAuth(), false);
      assert.deepEqual(fs.readFileSync(f.encrypted), encrypted); assert.deepEqual(fs.readFileSync(f.plaintext), plaintext);
      await close(value);
    }
  });
  await test('an encryption race or damaged backup prevents replacement after asynchronous work', async () => {
    const f = await fixture({ opaque: true }), entered = gate(), release = gate();
    const encrypt = f.backend.encryptStringAsync;
    f.backend.encryptStringAsync = async text => { entered.release(); await release.promise; return encrypt(text); };
    const value = f.construct(), writing = value.writeClaudeOAuth({ accessToken: 'racing-write' });
    await entered.promise; fs.appendFileSync(f.plaintext, ' '); release.release();
    assert.deepEqual(await writing, { success: false, error: 'windows_legacy_plaintext_proof_invalid' });
    assert.deepEqual(fs.readFileSync(f.encrypted), f.originalEncrypted); await close(value);
    const other = await fixture({ opaque: true }), damaged = other.construct();
    fs.writeFileSync(path.join(other.prepared.backupDirectory, 'credentials.enc'), 'changed-backup');
    assert.deepEqual(await damaged.writeClaudeOAuth({ accessToken: 'forbidden' }), { success: false, error: 'WINDOWS_PROFILE_BACKUP_PROOF_INVALID' });
    assert.deepEqual(fs.readFileSync(other.encrypted), other.originalEncrypted); await close(damaged);
  });
  await test('current encryption and a durable journal are required and key conflicts still block writes', async () => {
    for (const kind of ['journal', 'unavailable', 'conflict']) {
      const f = await fixture({ opaque: true });
      const value = f.construct({ noJournal: kind === 'journal', keyError: kind === 'conflict' ? 'windows_credentials_key_conflict' : undefined,
        backend: kind === 'unavailable' ? { ...f.backend, isAsyncEncryptionAvailable: async () => false } : f.backend });
      if (kind !== 'unavailable') assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'current-tauri' } });
      const error = { journal: 'windows_credential_migration_journal_required', unavailable: 'windows_credential_encryption_unavailable', conflict: 'windows_credentials_key_conflict' }[kind];
      assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'forbidden' }), { success: false, error });
      assert.deepEqual(fs.readFileSync(f.encrypted), f.originalEncrypted); await close(value);
    }
  });
  await test('a lost ownership commit preserves the new token and forbids a second replacement until recovery', async () => {
    const f = await fixture({ opaque: true }); let failCommit = true;
    const journal = { ...f.prepared.legacyMigrationJournal, commit: async hash => {
      if (failCommit) throw new Error('Controlled journal failure'); await f.prepared.legacyMigrationJournal.commit(hash);
    } };
    const value = f.construct({ journal, keyError: 'windows_credentials_legacy_key_required' });
    assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'first-secure' }), { success: true, warning: 'windows_credential_migration_commit_pending' });
    const first = fs.readFileSync(f.encrypted);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.configRoot, 'electron', 'credential-profile-owner.json'))).pendingNewEncryptedSha256, digest(first));
    assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'first-secure' } });
    assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'second-secure' }), { success: false, error: 'windows_credential_migration_commit_pending' });
    assert.deepEqual(fs.readFileSync(f.encrypted), first);
    failCommit = false;
    assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'second-secure' }), { success: true });
    assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'second-secure' } }); await close(value);
  });
  await test('a proven logout writes an encrypted tombstone before removing only plaintext OAuth keys', async () => {
    const f = await fixture({ opaque: true, plaintext: { tokens: { accessToken: 'to-remove' } } }), value = f.construct();
    assert.equal(await value.removeClaudeOAuth(), true);
    assert.deepEqual(JSON.parse((await f.backend.decryptStringAsync(fs.readFileSync(f.encrypted))).result), {});
    assert.equal(fs.existsSync(f.plaintext), false); assert.deepEqual(await value.readClaudeOAuth(), { value: null });
    assert.deepEqual(fs.readFileSync(path.join(f.prepared.backupDirectory, 'credentials.enc')), f.originalEncrypted);
    await close(value);
  });
  await test('changed plaintext after secure commit is preserved and never overrides the committed token', async () => {
    const f = await fixture({ opaque: true });
    const changed = Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: 'foreign-current' }, foreignData: true }));
    const journal = { ...f.prepared.legacyMigrationJournal, commit: async hash => {
      await f.prepared.legacyMigrationJournal.commit(hash); fs.writeFileSync(f.plaintext, changed);
    } };
    const value = f.construct({ journal });
    assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'secure-authority' }), { success: true, warning: 'legacy_credential_cleanup_failed' });
    assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'secure-authority' } });
    await close(value);
    const recovered = prepareWindowsProfile({ configRoot: f.configRoot, appData: path.join(root, 'unused-roaming') });
    assert.equal(recovered.legacyPlaintextProof, undefined); assert.equal(recovered.legacyPlaintextCleanupSha256, digest(f.originalPlaintext));
    const reopened = new WindowsCredentialStore(randomUUID(), f.configRoot, f.backend, 5000, undefined, undefined, undefined, recovered.legacyPlaintextCleanupSha256);
    live.add(reopened);
    assert.deepEqual(await reopened.writeClaudeOAuth({ accessToken: 'second-secure' }), { success: true, warning: 'legacy_credential_cleanup_failed' });
    assert.deepEqual(fs.readFileSync(f.plaintext), changed);
    assert.deepEqual(await reopened.readClaudeOAuth(), { value: { accessToken: 'second-secure' } });
    assert.equal(await reopened.removeClaudeOAuth(), false);
    assert.deepEqual(await reopened.readClaudeOAuth(), { value: null });
    assert.deepEqual(fs.readFileSync(f.plaintext), changed);
    await close(reopened);
  });
};
