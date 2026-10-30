const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { app, safeStorage } = require('electron');
const { WindowsCredentialStore } = require('../../dist/main/native/windows-credentials');
const { NativeSubscriptionCredentials } = require('../../dist/main/native/credentials');

const root = process.env.KLAUS_CREDENTIAL_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-windows-credential-gate-')) throw new Error('An isolated gate profile is required');
fs.mkdirSync(path.join(root, 'electron'), { recursive: true });
app.setPath('userData', path.join(root, 'electron'));
const results = [];
const live = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
function storage() {
  const records = new Map();
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => { const bytes = randomBytes(48); records.set(bytes.toString('hex'), value); return bytes; },
    decryptStringAsync: async bytes => {
      const result = records.get(bytes.toString('hex'));
      if (result === undefined) throw new Error('Fixture decrypt failure');
      return { result, shouldReEncrypt: false };
    },
  };
}
function create(options = {}) {
  const configRoot = path.join(root, randomUUID());
  fs.mkdirSync(configRoot);
  const backend = options.backend ?? storage();
  const value = new WindowsCredentialStore(randomUUID(), configRoot, backend, options.deadlineMs ?? 5000, options.keyError);
  live.add(value);
  return { value, configRoot, backend, encrypted: path.join(configRoot, '.credentials.enc'), plaintext: path.join(configRoot, '.credentials.json') };
}
async function close(value) { assert.equal((await value.close()).complete, true); live.delete(value); }
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); }
}

async function run() {
  await app.whenReady();
  app.dock?.hide();
  assert.ok(process.versions.electron);
  assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
  if (process.argv.includes('reopen')) {
    await test('a fresh Electron process decrypts the persisted DPAPI-backed profile', async () => {
      const value = new WindowsCredentialStore(randomUUID(), path.join(root, 'persisted'), safeStorage);
      live.add(value);
      assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'persistent-fixture-token' } });
      assert.equal(await value.removeClaudeOAuth(), true);
      assert.deepEqual(JSON.parse((await safeStorage.decryptStringAsync(fs.readFileSync(path.join(root, 'persisted', '.credentials.enc')))).result), {});
      assert.deepEqual(await value.readClaudeOAuth(), { value: null });
      await close(value);
    });
    return;
  }
  await test('encrypted transactions preserve unrelated keys and remove only the existing plaintext OAuth copy', async () => {
    const f = create();
    fs.writeFileSync(f.encrypted, await f.backend.encryptStringAsync(JSON.stringify({ pluginSecrets: { keep: 'fake-plugin-secret' }, claudeAiOauth: { accessToken: 'old' }, tokens: { accessToken: 'legacy' } })));
    fs.writeFileSync(f.plaintext, JSON.stringify({ pluginSecrets: { other: 'kept' }, claudeAiOauth: { accessToken: 'old-copy' } }));
    assert.deepEqual(await f.value.writeClaudeOAuth({ accessToken: 'new' }), { success: true });
    assert.equal(fs.readFileSync(f.encrypted).includes(Buffer.from('accessToken')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.plaintext, 'utf8')), { pluginSecrets: { other: 'kept' } });
    assert.deepEqual(await f.value.readClaudeOAuth(), { value: { accessToken: 'new' } });
    assert.equal(await f.value.removeClaudeOAuth(), true);
    assert.deepEqual(JSON.parse((await f.backend.decryptStringAsync(fs.readFileSync(f.encrypted))).result), { pluginSecrets: { keep: 'fake-plugin-secret' } });
    await close(f.value);
  });
  await test('write and logout keep admission order and snapshot the queued token object', async () => {
    const f = create();
    const token = { accessToken: 'first' };
    const first = f.value.writeClaudeOAuth(token);
    token.accessToken = 'changed-after-admission';
    const read = f.value.readClaudeOAuth();
    const remove = f.value.removeClaudeOAuth();
    const last = f.value.readClaudeOAuth();
    assert.deepEqual(await first, { success: true });
    assert.deepEqual(await read, { value: { accessToken: 'first' } });
    assert.equal(await remove, true);
    assert.deepEqual(await last, { value: null });
    await close(f.value);
  });
  await test('unavailable encryption never creates a plaintext fallback', async () => {
    const f = create({ backend: { ...storage(), isAsyncEncryptionAvailable: async () => false } });
    assert.deepEqual(await f.value.writeClaudeOAuth({ accessToken: 'secret' }), { success: false, error: 'windows_credential_encryption_unavailable' });
    assert.equal(fs.existsSync(f.encrypted), false);
    assert.equal(fs.existsSync(f.plaintext), false);
    await close(f.value);
  });
  await test('legacy key dependency and an unreadable current blob are explicit and never overwritten', async () => {
    for (const keyError of ['windows_credentials_legacy_key_required', 'windows_credentials_key_conflict', undefined]) {
      const f = create({ keyError });
      const bytes = Buffer.from('v10-opaque-legacy-fixture');
      fs.writeFileSync(f.encrypted, bytes);
      const error = keyError ?? 'windows_credentials_decryption_failed';
      assert.deepEqual(await f.value.readClaudeOAuth(), { value: null, error });
      assert.deepEqual(await f.value.writeClaudeOAuth({ accessToken: 'new' }), { success: false, error });
      assert.equal(await f.value.removeClaudeOAuth(), false);
      assert.deepEqual(fs.readFileSync(f.encrypted), bytes);
      assert.equal(fs.existsSync(f.plaintext), false);
      await close(f.value);
    }
  });
  await test('a stalled encryptor has bounded admission and close fences pending writes', async () => {
    const backend = storage(), entered = gate(), release = gate();
    const encrypt = backend.encryptStringAsync;
    backend.encryptStringAsync = async text => { entered.release(); await release.promise; return encrypt(text); };
    const f = create({ backend });
    const write = f.value.writeClaudeOAuth({ accessToken: 'must-not-land' });
    await entered.promise;
    const queued = Array.from({ length: 7 }, () => f.value.readClaudeOAuth());
    assert.deepEqual(await f.value.readClaudeOAuth(), { value: null, error: 'BUSY' });
    const closing = f.value.close(10);
    assert.equal(closing, f.value.close(10));
    assert.equal((await closing).complete, false);
    assert.equal((await closing).pendingOperations.length, 1);
    assert.deepEqual(await write, { success: false, error: 'CREDENTIALS_CLOSED' });
    for (const result of await Promise.all(queued)) assert.deepEqual(result, { value: null, error: 'CREDENTIALS_CLOSED' });
    release.release();
    await sleep(30);
    assert.equal(fs.existsSync(f.encrypted), false);
    live.delete(f.value);
  });
  await test('an encryption deadline cannot later commit a stale credential', async () => {
    const backend = storage(), entered = gate(), release = gate();
    const encrypt = backend.encryptStringAsync;
    backend.encryptStringAsync = async text => { entered.release(); await release.promise; return encrypt(text); };
    const f = create({ backend, deadlineMs: 30 });
    const write = f.value.writeClaudeOAuth({ accessToken: 'timed-out' });
    await entered.promise;
    assert.deepEqual(await write, { success: false, error: 'DEADLINE_EXCEEDED' });
    release.release();
    await sleep(20);
    assert.equal(fs.existsSync(f.encrypted), false);
    assert.deepEqual(fs.readdirSync(f.configRoot), []);
    await close(f.value);
  });
  await test('the subscription adapter injects Windows storage and joins both close reports', async () => {
    const resourceId = randomUUID(), configRoot = path.join(root, randomUUID());
    let nativeClosed = false;
    const binding = {
      shutdown: async () => { nativeClosed = true; return JSON.stringify({ resourceId, complete: true, pendingOperations: [] }); },
    };
    const value = new NativeSubscriptionCredentials({ configRoot, userHome: root, windowsSafeStorage: storage() }, { resourceId, binding });
    assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'injected' }), { success: true });
    assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'injected' } });
    assert.equal((await value.close()).complete, true);
    assert.equal(nativeClosed, true);
    assert.deepEqual(await value.readClaudeOAuth(), { value: null, error: 'CREDENTIALS_CLOSED' });
  });
  await require('./windows-coexistence.cjs')(test, root, storage, live);
  if (process.platform === 'win32') {
    await test('real Windows Electron safeStorage encrypts and decrypts a temporary profile', async () => {
      assert.equal(typeof safeStorage.encryptStringAsync, 'function');
      assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true);
      const configRoot = path.join(root, 'persisted');
      const value = new WindowsCredentialStore(randomUUID(), configRoot, safeStorage);
      live.add(value);
      assert.deepEqual(await value.writeClaudeOAuth({ accessToken: 'persistent-fixture-token' }), { success: true });
      const bytes = fs.readFileSync(path.join(configRoot, '.credentials.enc'));
      assert.equal(bytes.includes(Buffer.from('persistent-fixture-token')), false);
      assert.deepEqual(await value.readClaudeOAuth(), { value: { accessToken: 'persistent-fixture-token' } });
      assert.equal(fs.existsSync(path.join(configRoot, '.credentials.json')), false);
      await close(value);
    });
  } else console.log('  info Windows OS crypto and restart tests require Windows; only transaction fixtures ran here');
}

run().catch(error => { results.push({ name: 'suite', ok: false, error: error.stack }); console.error(error); }).finally(async () => {
  for (const value of live) { try { await value.close(2000); } catch {} }
  const passed = results.filter(result => result.ok).length;
  const failed = results.length - passed;
  const output = path.resolve(__dirname, '../test-results');
  fs.mkdirSync(output, { recursive: true });
  const phase = process.argv.includes('reopen') ? 'reopen' : 'suite';
  fs.writeFileSync(path.join(output, `windows-credentials-${phase}.json`), JSON.stringify({ passed, failed, platform: process.platform, results }, null, 2));
  console.log(`windows-credentials-${phase}: ${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
