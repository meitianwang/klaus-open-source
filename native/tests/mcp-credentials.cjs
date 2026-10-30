const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } = require('node:crypto');
const { McpCredentialStore, mcpCredentialAccount } = require('../../dist/main/native/mcp-credentials');

const key = 'fixture-mcp|0123456789abcdef';
const account = mcpCredentialAccount(key, 'tokens');
const token = value => ({ tokens: { access_token: value }, expiresAt: 1790000000000 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function memoryBackend() {
  const values = new Map();
  return {
    values,
    async read(key, part) { return { value: structuredClone(values.get(mcpCredentialAccount(key, part)) ?? null) }; },
    async write(key, part, value) { values.set(mcpCredentialAccount(key, part), structuredClone(value)); return { success: true }; },
    async remove(key, part) { values.delete(mcpCredentialAccount(key, part)); return true; },
  };
}
function fixtureEncryption() {
  const key = randomBytes(32);
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(text) {
      const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from('v10'), nonce, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(3, 15));
      decipher.setAuthTag(bytes.subarray(15, 31));
      return { result: Buffer.concat([decipher.update(bytes.subarray(31)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}
async function waitFor(predicate) {
  const until = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= until) throw new Error('MCP fixture observation timed out'); await sleep(5); }
}

module.exports = async function tests(test, root) {
  const live = new Set();
  const directory = () => { const value = path.join(root, randomUUID()); fs.mkdirSync(value, { recursive: true }); return value; };
  const store = (configRoot = directory(), backend = memoryBackend(), storage, deadline = 5000) => {
    const value = new McpCredentialStore(randomUUID(), configRoot, backend, storage, deadline); live.add(value); return value;
  };
  const close = async value => { assert.equal((await value.close()).complete, true); live.delete(value); };
  const seed = (dir, extra = {}) => {
    const bytes = Buffer.from(JSON.stringify({ [account]: JSON.stringify(token('legacy-fixture')), 'unknown-account': 'opaque-unrelated-record', ...extra }, null, 2));
    fs.writeFileSync(path.join(dir, '.mcp-credentials.json'), bytes); return bytes;
  };
  try {
    await test('MCP writes snapshot caller data and preserve immediate write-delete-read order', async () => {
      const value = store(); const input = token('first');
      const write = value.writeMcpOAuthRecord(key, 'tokens', input);
      input.tokens.access_token = 'changed-after-admission';
      const read = value.readMcpOAuthRecord(key, 'tokens');
      const remove = value.removeMcpOAuthRecord(key, 'tokens');
      const missing = value.readMcpOAuthRecord(key, 'tokens');
      assert.deepEqual(await write, { success: true });
      assert.deepEqual(await read, { value: token('first') });
      assert.equal(await remove, true); assert.deepEqual(await missing, { value: null });
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'pkce'), { value: null, error: 'invalid_mcp_credential_key' });
      await close(value);
    });
    await test('legacy string records migrate only into a secure backend with an exact byte backup', async () => {
      const dir = directory(); const backend = memoryBackend(); const original = seed(dir);
      const value = store(dir, backend);
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'tokens'), { value: token('legacy-fixture') });
      assert.deepEqual(backend.values.get(account), token('legacy-fixture'));
      assert.deepEqual(fs.readFileSync(path.join(dir, `.mcp-credentials.backup-${digest(original)}.json`)), original);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mcp-credentials.json'), 'utf8')), { 'unknown-account': 'opaque-unrelated-record' });
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, `.mcp-credentials.backup-${digest(original)}.json`)).mode & 0o777, 0o600);
      assert.equal(await value.removeMcpOAuthRecord(key, 'tokens'), true); await close(value);
      fs.writeFileSync(path.join(dir, '.mcp-credentials.json'), original);
      const restarted = store(dir, backend);
      assert.deepEqual(await restarted.readMcpOAuthRecord(key, 'tokens'), { value: null });
      assert.deepEqual(fs.readFileSync(path.join(dir, '.mcp-credentials.json')), original);
      await close(restarted);
    });
    await test('an existing secure record remains authoritative over an old plaintext copy', async () => {
      const dir = directory(); const original = seed(dir); const backend = memoryBackend();
      backend.values.set(account, token('current-secure'));
      const value = store(dir, backend);
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'tokens'), { value: token('current-secure') });
      assert.deepEqual(fs.readFileSync(path.join(dir, '.mcp-credentials.json')), original);
      assert.equal(await value.removeMcpOAuthRecord(key, 'tokens'), true);
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'tokens'), { value: null }); await close(value);
    });
    await test('backend denial and malformed legacy values are explicit and never written as plaintext', async () => {
      const dir = directory(); const original = seed(dir);
      const denied = store(dir, { async read() { return { value: null, error: 'credential_keychain_denied' }; }, async write() { throw new Error('Unexpected write'); }, async remove() { throw new Error('Unexpected delete'); } });
      assert.deepEqual(await denied.readMcpOAuthRecord(key, 'tokens'), { value: null, error: 'credential_keychain_denied' });
      assert.equal((await denied.writeMcpOAuthRecord(key, 'tokens', token('new'))).success, false);
      assert.equal(await denied.removeMcpOAuthRecord(key, 'tokens'), false);
      assert.deepEqual(fs.readdirSync(dir), ['.mcp-credentials.json']);
      assert.deepEqual(fs.readFileSync(path.join(dir, '.mcp-credentials.json')), original); await close(denied);
      fs.writeFileSync(path.join(dir, '.mcp-credentials.json'), JSON.stringify({ [account]: { tokens: {} } }));
      const malformed = store(dir);
      assert.deepEqual(await malformed.readMcpOAuthRecord(key, 'tokens'), { value: null, error: 'mcp_credential_record_unreadable' }); await close(malformed);
    });
    await test('a stopped write before the OS commit retains the usable legacy record for retry', async () => {
      const dir = directory(); const original = seed(dir); const backend = memoryBackend(); const write = backend.write;
      backend.write = async () => { throw new Error('fixture_before_secure_commit'); };
      const first = store(dir, backend);
      assert.equal((await first.writeMcpOAuthRecord(key, 'tokens', token('new'))).success, false); await close(first);
      assert.deepEqual(fs.readFileSync(path.join(dir, '.mcp-credentials.json')), original);
      backend.write = write;
      const restart = store(dir, backend);
      assert.deepEqual(await restart.readMcpOAuthRecord(key, 'tokens'), { value: token('legacy-fixture') }); await close(restart);
    });
    await test('a stopped write after the OS commit recovers ownership without rolling back to plaintext', async () => {
      const dir = directory(); seed(dir); const backend = memoryBackend(); const write = backend.write;
      backend.write = async (...args) => { await write(...args); throw new Error('fixture_after_secure_commit'); };
      const first = store(dir, backend);
      assert.equal((await first.writeMcpOAuthRecord(key, 'tokens', token('new-secure'))).success, false); await close(first);
      backend.write = write;
      const restart = store(dir, backend);
      assert.deepEqual(await restart.readMcpOAuthRecord(key, 'tokens'), { value: token('new-secure') });
      assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, '.mcp-credentials.json'))), account), false); await close(restart);
    });
    await test('a durable delete intent resumes after interruption without reviving a legacy token', async () => {
      const dir = directory(); seed(dir); const backend = memoryBackend(); backend.values.set(account, token('secure'));
      const remove = backend.remove; backend.remove = async (...args) => { await remove(...args); throw new Error('fixture_after_secure_delete'); };
      const first = store(dir, backend); assert.equal(await first.removeMcpOAuthRecord(key, 'tokens'), false); await close(first);
      backend.remove = remove;
      const restart = store(dir, backend);
      assert.deepEqual(await restart.readMcpOAuthRecord(key, 'tokens'), { value: null });
      assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, '.mcp-credentials.json'))), account), false); await close(restart);
    });
    await test('recovery refuses to clean legacy bytes when their required backup has been damaged', async () => {
      const dir = directory(); const original = seed(dir); const backend = memoryBackend(); const write = backend.write;
      backend.write = async (...args) => { await write(...args); throw new Error('fixture_after_secure_commit'); };
      const first = store(dir, backend); assert.equal((await first.writeMcpOAuthRecord(key, 'tokens', token('new-secure'))).success, false); await close(first);
      backend.write = write;
      fs.writeFileSync(path.join(dir, `.mcp-credentials.backup-${digest(original)}.json`), 'damaged-backup');
      const restart = store(dir, backend);
      assert.deepEqual(await restart.readMcpOAuthRecord(key, 'tokens'), { value: null, error: 'mcp_credential_backup_invalid' });
      assert.deepEqual(fs.readFileSync(path.join(dir, '.mcp-credentials.json')), original);
      assert.deepEqual(backend.values.get(account), token('new-secure')); await close(restart);
    });
    await test('confirmed ownership cannot restore a legacy login after its secure slot is removed', async () => {
      const dir = directory(); const backend = memoryBackend();
      const original = Buffer.from(JSON.stringify({ [account]: JSON.stringify(token('old')) }));
      const legacy = path.join(dir, '.mcp-credentials.json'); fs.writeFileSync(legacy, original);
      const promises = require('node:fs/promises'); const unlink = promises.unlink;
      promises.unlink = async file => { if (file === legacy) throw new Error('fixture_before_cleanup'); return unlink(file); };
      const first = store(dir, backend);
      try { assert.equal((await first.writeMcpOAuthRecord(key, 'tokens', token('new-secure'))).success, true); }
      finally { promises.unlink = unlink; await close(first); }
      backend.values.delete(account);
      const restart = store(dir, backend);
      assert.deepEqual(await restart.readMcpOAuthRecord(key, 'tokens'), { value: null });
      assert.equal(fs.existsSync(legacy), false); await close(restart);
    });
    await test('a legacy hash race preserves both the original backup and the newly changed file', async () => {
      const dir = directory(); const original = seed(dir); const backend = memoryBackend(); const write = backend.write;
      const changed = Buffer.from(JSON.stringify({ [account]: JSON.stringify(token('other-process')), unknown: 'new-opaque-record' }));
      backend.write = async (...args) => { const result = await write(...args); fs.writeFileSync(path.join(dir, '.mcp-credentials.json'), changed); return result; };
      const value = store(dir, backend);
      assert.deepEqual(await value.writeMcpOAuthRecord(key, 'tokens', token('secure-new')), { success: true, warning: 'mcp_legacy_credential_changed' });
      assert.deepEqual(fs.readFileSync(path.join(dir, '.mcp-credentials.json')), changed);
      assert.deepEqual(fs.readFileSync(path.join(dir, `.mcp-credentials.backup-${digest(original)}.json`)), original);
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'tokens'), { value: null, error: 'mcp_legacy_credential_changed' });
      assert.deepEqual(backend.values.get(account), token('secure-new')); await close(value);
    });
    await test('cleanup completed before a journal failure is recognized on restart', async () => {
      const dir = directory(); seed(dir); const backend = memoryBackend(); const promises = require('node:fs/promises'); const rename = promises.rename;
      let journalWrites = 0;
      promises.rename = async (from, to) => {
        if (to === path.join(dir, '.mcp-credential-migrations.json') && ++journalWrites === 3) throw new Error('fixture_after_cleanup');
        return rename(from, to);
      };
      const first = store(dir, backend);
      try { assert.equal((await first.writeMcpOAuthRecord(key, 'tokens', token('new-secure'))).success, true); }
      finally { promises.rename = rename; await close(first); }
      const restart = store(dir, backend);
      assert.deepEqual(await restart.readMcpOAuthRecord(key, 'tokens'), { value: token('new-secure') });
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.mcp-credential-migrations.json'))).pending, undefined); await close(restart);
    });
    await test('encrypted MCP files preserve independent slots and reject unreadable ciphertext without replacement', async () => {
      const dir = directory(); seed(dir); const crypto = fixtureEncryption(); const value = store(dir, memoryBackend(), crypto);
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'tokens'), { value: token('legacy-fixture') });
      assert.deepEqual(await value.writeMcpOAuthRecord(key, 'client', { client_id: 'fixture' }), { success: true });
      const file = path.join(dir, '.mcp-credentials.enc'); const bytes = fs.readFileSync(file);
      assert.equal(bytes.includes(Buffer.from('legacy-fixture')), false);
      assert.equal(await value.removeMcpOAuthRecord(key, 'tokens'), true);
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'client'), { value: { client_id: 'fixture' } }); await close(value);
      fs.writeFileSync(file, 'unreadable-ciphertext');
      const corrupted = store(dir, memoryBackend(), crypto);
      assert.deepEqual(await corrupted.readMcpOAuthRecord(key, 'tokens'), { value: null, error: 'mcp_credential_decryption_failed' });
      assert.equal((await corrupted.writeMcpOAuthRecord(key, 'tokens', token('new'))).success, false);
      assert.equal(fs.readFileSync(file, 'utf8'), 'unreadable-ciphertext'); await close(corrupted);
    });
    await test('unavailable Windows encryption cannot expose or migrate a plaintext credential', async () => {
      const dir = directory(); const original = seed(dir);
      const value = store(dir, memoryBackend(), { ...fixtureEncryption(), async isAsyncEncryptionAvailable() { return false; } });
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'tokens'), { value: null, error: 'mcp_credential_encryption_unavailable' });
      assert.equal((await value.writeMcpOAuthRecord(key, 'tokens', token('new'))).success, false);
      assert.deepEqual(fs.readFileSync(path.join(dir, '.mcp-credentials.json')), original);
      assert.deepEqual(fs.readdirSync(dir), ['.mcp-credentials.json']); await close(value);
    });
    await test('bounded admission and deadline shutdown retain a stalled encryptor without a late commit', async () => {
      const dir = directory(); const crypto = fixtureEncryption(); let release; let calls = 0;
      const held = new Promise(resolve => { release = resolve; });
      const value = store(dir, memoryBackend(), { ...crypto, async encryptStringAsync(text) { calls++; await held; return crypto.encryptStringAsync(text); } });
      const pending = [value.writeMcpOAuthRecord(key, 'tokens', token('held'))];
      await waitFor(() => calls === 1);
      for (let i = 0; i < 7; i++) pending.push(value.readMcpOAuthRecord(key, 'tokens'));
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'tokens'), { value: null, error: 'BUSY' });
      assert.throws(() => store(dir), /MCP_CREDENTIAL_RESOURCE_IN_USE/);
      assert.equal((await value.close(20)).complete, false);
      assert.equal(fs.existsSync(path.join(dir, '.mcp-credentials.enc')), false);
      release(); await Promise.all(pending); await close(value);
      assert.equal(calls, 1); assert.equal(fs.existsSync(path.join(dir, '.mcp-credentials.enc')), false);
      const restarted = store(dir, memoryBackend(), crypto);
      assert.deepEqual(await restarted.readMcpOAuthRecord(key, 'tokens'), { value: null }); await close(restarted);
    });
  } finally { for (const value of live) await value.close(5000); }
};
module.exports.fixtureEncryption = fixtureEncryption;
module.exports.memoryBackend = memoryBackend;
