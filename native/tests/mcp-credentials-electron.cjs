const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { app, safeStorage } = require('electron');
const { loadNativeAddon } = require('../../dist/main/native/binding');
const { NativeSubscriptionCredentials } = require('../../dist/main/native/credentials');
const { McpCredentialStore } = require('../../dist/main/native/mcp-credentials');
const transactionTests = require('./mcp-credentials.cjs');
const root = process.env.KLAUS_MCP_CREDENTIAL_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-mcp-credential-gate-')) throw new Error('An isolated MCP credential profile is required');
app.disableHardwareAcceleration(); app.setPath('userData', path.join(root, 'electron'));
const results = []; const bindings = new Set(); const adapters = new Set();
const key = 'fixture-mcp|0123456789abcdef';
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); }
}
function fixture(entries = [], latency = 0, keychainService = 'agent-engine') {
  const resourceId = randomUUID(); const dir = path.join(root, resourceId);
  const options = { configRoot: path.join(dir, 'klaus'), userHome: path.join(dir, 'home'), platform: 'darwin', keychainService, account: 'fixture-user' };
  const addon = loadNativeAddon(path.resolve(__dirname, '../artifacts/fixtures', `klaus-native-${process.platform}-${process.arch}.node`));
  const binding = addon.createCredentialFixture(resourceId, JSON.stringify(options), JSON.stringify(entries), latency); bindings.add(binding);
  const adapter = new NativeSubscriptionCredentials(options, { resourceId, binding }); adapters.add(adapter);
  return { options, resourceId, binding, adapter };
}
async function close(value) { assert.equal((await value.adapter.close()).complete, true); adapters.delete(value.adapter); bindings.delete(value.binding); }
async function run() {
  await app.whenReady(); app.dock?.hide();
  const phase = process.argv[2] ?? 'suite';
  if (phase.startsWith('crash-') || phase.startsWith('recover-')) {
    assert.equal(process.platform, 'win32');
    const mode = phase.replace(/^(?:crash|recover)-/, '');
    const configRoot = path.join(root, `crash-${mode}`);
    const encrypted = path.join(configRoot, '.mcp-credentials.enc');
    const legacy = path.join(configRoot, '.mcp-credentials.json');
    const value = new NativeSubscriptionCredentials({ configRoot, userHome: path.join(root, 'home'), windowsSafeStorage: safeStorage }); adapters.add(value);
    if (phase.startsWith('crash-')) {
      fs.mkdirSync(configRoot, { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ [`mcp:oauth:${key}:tokens`]: JSON.stringify({ tokens: { access_token: 'legacy-crash-fixture' } }), unknown: 'preserved-record' }));
      const promises = require('node:fs/promises'); const rename = promises.rename;
      const terminate = () => { process.exit(75); return new Promise(() => {}); };
      promises.rename = async (from, to) => {
        if (to === encrypted && mode === 'before') return terminate();
        await rename(from, to);
        if (to === encrypted) return terminate();
      };
      if (mode === 'delete') await value.removeMcpOAuthRecord(key, 'tokens');
      else await value.writeMcpOAuthRecord(key, 'tokens', { tokens: { access_token: 'secure-crash-fixture' } });
      throw new Error('The requested process-exit boundary was not reached');
    }
    await test(`a fresh Windows process recovers an interruption ${mode} the secure replacement`, async () => {
      const expected = mode === 'delete' ? null : { tokens: { access_token: mode === 'before' ? 'legacy-crash-fixture' : 'secure-crash-fixture' } };
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'tokens'), { value: expected });
      assert.deepEqual(JSON.parse(fs.readFileSync(legacy, 'utf8')), { unknown: 'preserved-record' });
      assert.equal(JSON.parse(fs.readFileSync(path.join(configRoot, '.mcp-credential-migrations.json'))).pending, undefined);
      assert.equal((await value.close()).complete, true); adapters.delete(value);
    }); return;
  }
  if (process.argv[2] === 'reopen') {
    await test('a fresh Windows Electron process reads MCP records encrypted by the same isolated profile', async () => {
      const value = new McpCredentialStore(randomUUID(), path.join(root, 'persisted'), transactionTests.memoryBackend(), safeStorage);
      assert.deepEqual(await value.readMcpOAuthRecord(key, 'tokens'), { value: { tokens: { access_token: 'persisted-fixture' }, expiresAt: 1790000000000 } });
      assert.equal((await value.close()).complete, true);
    }); return;
  }
  await test('identified N-API MCP fixture methods load in the same normal Electron process', async () => {
    assert.ok(process.versions.electron); assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
    const addonPath = path.resolve(__dirname, '../artifacts/fixtures', `klaus-native-${process.platform}-${process.arch}.node`);
    const manifest = JSON.parse(fs.readFileSync(`${addonPath}.json`, 'utf8'));
    assert.equal(manifest.credentialFixtures, true);
    assert.equal(manifest.sha256, createHash('sha256').update(fs.readFileSync(addonPath)).digest('hex'));
    const addon = loadNativeAddon(addonPath); assert.equal(addon.processId(), process.pid);
    const value = fixture();
    for (const method of ['readMcpOAuthRecord', 'writeMcpOAuthRecord', 'removeMcpOAuthRecord']) assert.equal(typeof value.binding[method], 'function');
    await close(value);
  });
  await transactionTests(test, root);
  await test('the real native worker reads the old fixed MCP service and leaves the other slots untouched', async () => {
    const value = fixture([{ service: 'agent-engine', account: `mcp:oauth:${key}:tokens`, raw: JSON.stringify({ tokens: { access_token: 'existing-fixture' }, expiresAt: 1790000000000 }) }]);
    assert.deepEqual(await value.adapter.readMcpOAuthRecord(key, 'tokens'), { value: { tokens: { access_token: 'existing-fixture' }, expiresAt: 1790000000000 } });
    assert.deepEqual(await value.adapter.writeMcpOAuthRecord(key, 'client', { client_id: 'native-client' }), { success: true });
    assert.equal(await value.adapter.removeMcpOAuthRecord(key, 'tokens'), true);
    assert.deepEqual(await value.adapter.readMcpOAuthRecord(key, 'tokens'), { value: null });
    assert.deepEqual(await value.adapter.readMcpOAuthRecord(key, 'client'), { value: { client_id: 'native-client' } }); await close(value);
  });
  await test('international native MCP workers cannot read or delete domestic entries', async () => {
    const value = fixture([{ service: 'agent-engine', account: `mcp:oauth:${key}:tokens`, raw: JSON.stringify({ tokens: { access_token: 'domestic-fixture' } }) }], 0, 'agent-engine-international');
    assert.deepEqual(await value.adapter.readMcpOAuthRecord(key, 'tokens'), { value: null });
    assert.deepEqual(await value.adapter.writeMcpOAuthRecord(key, 'tokens', { tokens: { access_token: 'international-fixture' } }), { success: true });
    assert.deepEqual(await value.adapter.readMcpOAuthRecord(key, 'tokens'), { value: { tokens: { access_token: 'international-fixture' } } });
    assert.equal(await value.adapter.removeMcpOAuthRecord(key, 'tokens'), true);
    await close(value);
    assert.throws(() => fixture([], 0, 'arbitrary-service'), /INVALID_KEYCHAIN_SERVICE/);
  });
  await test('native MCP envelopes and queue admission preserve write-delete-read order', async () => {
    const value = fixture([], 20);
    const write = value.binding.writeMcpOAuthRecord('write', key, 'tokens', JSON.stringify({ tokens: { access_token: 'queued' } }), 5000);
    const remove = value.binding.removeMcpOAuthRecord('remove', key, 'tokens', 5000);
    const read = value.binding.readMcpOAuthRecord('read', key, 'tokens', 5000);
    assert.equal(JSON.parse(await write).result.success, true); assert.equal(JSON.parse(await remove).result, true);
    assert.deepEqual(JSON.parse(await read), { resourceId: value.resourceId, operationId: 'read', result: { value: null } }); await close(value);
  });
  await test('legacy file migration reaches the native worker and native malformed records remain explicit', async () => {
    const value = fixture(); fs.mkdirSync(value.options.configRoot, { recursive: true });
    fs.writeFileSync(path.join(value.options.configRoot, '.mcp-credentials.json'), JSON.stringify({ [`mcp:oauth:${key}:tokens`]: JSON.stringify({ tokens: { access_token: 'legacy-native' } }) }));
    assert.deepEqual(await value.adapter.readMcpOAuthRecord(key, 'tokens'), { value: { tokens: { access_token: 'legacy-native' } } });
    assert.equal(fs.existsSync(path.join(value.options.configRoot, '.mcp-credentials.json')), false);
    assert.deepEqual(JSON.parse(await value.binding.readMcpOAuthRecord('direct', key, 'tokens', 2000)).result, { value: { tokens: { access_token: 'legacy-native' } } }); await close(value);
    const broken = fixture([{ service: 'agent-engine', account: `mcp:oauth:${key}:tokens`, raw: 'invalid-record' }]);
    assert.deepEqual(await broken.adapter.readMcpOAuthRecord(key, 'tokens'), { value: null, error: 'mcp_credential_record_unreadable' });
    assert.equal((await broken.adapter.writeMcpOAuthRecord(key, 'tokens', { tokens: {} })).success, false); await close(broken);
  });
  if (process.platform === 'win32') await test('real Windows safeStorage stores MCP ciphertext separately from Claude credentials', async () => {
    assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true);
    const configRoot = path.join(root, 'persisted');
    const options = { configRoot, userHome: path.join(root, 'home'), windowsSafeStorage: safeStorage };
    const value = new NativeSubscriptionCredentials(options); adapters.add(value);
    assert.deepEqual(await value.writeMcpOAuthRecord(key, 'tokens', { tokens: { access_token: 'persisted-fixture' }, expiresAt: 1790000000000 }), { success: true });
    const bytes = fs.readFileSync(path.join(configRoot, '.mcp-credentials.enc'));
    assert.equal(bytes.includes(Buffer.from('persisted-fixture')), false);
    assert.equal(fs.existsSync(path.join(configRoot, '.credentials.enc')), false);
    assert.equal(fs.existsSync(path.join(configRoot, '.mcp-credentials.json')), false);
    assert.equal((await value.close()).complete, true); adapters.delete(value);
  });
}
const watchdog = setTimeout(() => { console.error('MCP credential gate timed out'); app.exit(1); }, 100_000);
run().catch(error => { results.push({ name: 'setup', ok: false, error: error.stack }); console.error(error); }).finally(async () => {
  for (const value of adapters) await value.close(5000).catch(() => {});
  for (const value of bindings) await value.shutdown(5000).catch(() => {});
  clearTimeout(watchdog);
  const failed = results.filter(value => !value.ok).length;
  const phase = process.argv[2] ?? 'suite';
  fs.mkdirSync(path.resolve('native/test-results'), { recursive: true });
  fs.writeFileSync(path.resolve(`native/test-results/mcp-credentials-${phase}.json`), JSON.stringify({ platform: process.platform, results }, null, 2));
  console.log(`mcp-credentials-${phase}: ${results.length - failed} passed, ${failed} failed`); app.exit(failed ? 1 : 0);
});
