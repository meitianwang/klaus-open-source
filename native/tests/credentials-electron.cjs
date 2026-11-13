const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, pbkdf2Sync, createCipheriv, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { app } = require('electron');
const { loadNativeAddon } = require('../../dist/main/native/binding');
const { NativeSubscriptionCredentials } = require('../../dist/main/native/credentials');

const profile = process.env.KLAUS_NATIVE_TEST_ROOT;
if (!profile || !path.isAbsolute(profile) || !path.basename(profile).startsWith('klaus-native-electron-gate-')) throw new Error('An isolated credential test profile is required');
app.setPath('userData', path.join(profile, 'electron'));

const results = [];
const roots = [];
const live = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixtureAddon;
function fixture(platform = 'darwin', entries = [], latencyMs = 0, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klaus-credential-electron-'));
  roots.push(root);
  const resourceId = randomUUID();
  const options = { configRoot: path.join(root, 'klaus'), userHome: path.join(root, 'home'), platform, account: 'fixture-user', ...overrides };
  const binding = fixtureAddon.createCredentialFixture(resourceId, JSON.stringify(options), JSON.stringify(entries), latencyMs);
  live.add(binding);
  const adapter = new NativeSubscriptionCredentials(options, { resourceId, binding });
  return { root, options, resourceId, binding, adapter };
}
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); }
}
async function close(f) {
  const report = await f.adapter.close(2000);
  assert.equal(report.complete, true);
  live.delete(f.binding);
}

async function run() {
  await app.whenReady();
  app.dock?.hide();
  await test('the identified credential fixture addon loads in normal Electron', async () => {
    assert.ok(process.versions.electron);
    assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
    const addonPath = path.resolve(__dirname, '../artifacts/fixtures', `klaus-native-${process.platform}-${process.arch}.node`);
    fixtureAddon = loadNativeAddon(addonPath);
    assert.equal(fixtureAddon.processId(), process.pid);
    assert.equal(typeof fixtureAddon.createCredentialFixture, 'function');
    const manifest = JSON.parse(fs.readFileSync(`${addonPath}.json`, 'utf8'));
    assert.equal(manifest.credentialFixtures, true);
    assert.equal(manifest.sha256, createHash('sha256').update(fs.readFileSync(addonPath)).digest('hex'));
    assert.match(manifest.nativeSourceSha256, /^[a-f0-9]{64}$/);
    console.log(`  runtime Electron=${process.versions.electron} Node=${process.versions.node} N-API=${process.versions.napi}`);
  });
  if (!fixtureAddon) throw new Error('Fixture addon unavailable');

  await test('OAuth JSON envelopes preserve write then logout ordering and close is idempotent', async () => {
    const f = fixture();
    assert.deepEqual(await f.adapter.readClaudeOAuth(), { value: null });
    const write = f.adapter.writeClaudeOAuth({ accessToken: 'fake-first', refreshToken: 'fake-refresh', scopes: ['scope'] });
    const logout = f.adapter.removeClaudeOAuth();
    const read = f.adapter.readClaudeOAuth();
    assert.deepEqual(await write, { success: true });
    assert.equal(await logout, true);
    assert.deepEqual(await read, { value: null });
    assert.equal(fs.existsSync(path.join(f.options.configRoot, '.credentials.json')), false);
    const firstClose = f.adapter.close();
    assert.equal(firstClose, f.adapter.close());
    assert.equal((await firstClose).complete, true);
    assert.deepEqual(await f.adapter.writeClaudeOAuth({ accessToken: 'late' }), { success: false, error: 'CREDENTIALS_CLOSED' });
    assert.throws(() => f.binding.readClaudeOAuth('late', 1000), /CLOSED/);
    live.delete(f.binding);
  });

  await test('bounded serial worker keeps Electron responsive while the fixture OS backend is slow', async () => {
    const f = fixture('darwin', [], 100);
    // The slow OS backend under test is the keychain, which only the MCP slot
    // reaches: the Claude subscription copy is a plain private file and never
    // blocks on the OS, which is exactly what keeps status polls prompt-free.
    const key = 'fixture|0123456789abcdef';
    const read = f.binding.readMcpOAuthRecord('active', key, 'tokens', 5000);
    const write = f.binding.writeMcpOAuthRecord('cancelled-write', key, 'tokens', JSON.stringify({ tokens: { access_token: 'must-not-write' } }), 5000);
    assert.equal(f.binding.cancel('cancelled-write'), true);
    const queued = [];
    for (let i = 0; i < 6; i++) queued.push(f.binding.readMcpOAuthRecord(`pending-${i}`, key, 'tokens', 5000));
    assert.throws(() => f.binding.readMcpOAuthRecord('overflow', key, 'tokens', 1000), /BUSY/);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const began = Date.now();
    await fs.promises.readFile(__filename);
    assert.ok(Date.now() - began < 250, 'filesystem callback was starved');
    await assert.rejects(write, /CANCELLED/);
    await read;
    assert.ok(ticks >= 2, 'main event loop was blocked by the OS backend');
    clearInterval(timer);
    await Promise.all(queued);
    await close(f);
  });

  await test('the subscription copy is one private file on every platform', async () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const f = fixture(platform);
      assert.deepEqual(await f.adapter.readClaudeOAuth(), { value: null });
      assert.deepEqual(await f.adapter.writeClaudeOAuth({ accessToken: platform + '-fixture' }), { success: true });
      const file = path.join(f.options.configRoot, 'claude-subscription-oauth.json');
      if (process.platform === 'win32') console.log('  info POSIX credential mode is verified only on a POSIX host; Windows DACLs are a separate gate');
      else assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(await f.adapter.readClaudeOAuth(), { value: { accessToken: platform + '-fixture' } });
      assert.equal(await f.adapter.removeClaudeOAuth(), true);
      assert.equal(fs.existsSync(file), false);
      await close(f);
    }
  });

  await test('Linux private-file and Windows existing-blob results retain platform semantics', async () => {
    const linux = fixture('linux');
    assert.deepEqual(await linux.adapter.writeClaudeOAuth({ accessToken: 'linux-fixture' }), { success: true, warning: 'Warning: Storing credentials in plaintext.' });
    const file = path.join(linux.options.configRoot, '.credentials.json');
    // A simulated Linux credential backend still uses the host filesystem.
    // Windows stat mode bits cannot establish POSIX permissions or a DACL.
    if (process.platform === 'win32') console.log('  info POSIX credential mode is verified only on a POSIX host; Windows DACLs are a separate gate');
    else assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(await linux.adapter.readClaudeOAuth(), { value: { accessToken: 'linux-fixture' } });
    await close(linux);
    const windows = fixture('win32');
    fs.mkdirSync(windows.options.configRoot, { recursive: true });
    const blob = path.join(windows.options.configRoot, '.credentials.enc');
    fs.writeFileSync(blob, 'opaque-fixture');
    assert.deepEqual(await windows.adapter.readClaudeOAuth(), { value: null, error: 'windows_dpapi_credentials_not_migrated' });
    assert.equal(await windows.adapter.removeClaudeOAuth(), false);
    assert.equal((await windows.adapter.writeClaudeOAuth({ accessToken: 'fake' })).success, false);
    assert.equal(fs.readFileSync(blob, 'utf8'), 'opaque-fixture');
    assert.equal(fs.existsSync(path.join(windows.options.configRoot, '.credentials.json')), false);
    await close(windows);
  });

  await test('local Claude import reads a NUL keychain value then prefers its untouched source file', async () => {
    const f = fixture('darwin', [{ service: 'Claude Code-credentials', account: 'cli-account', raw: '{"claudeAiOauth":{"accessToken":"keychain-fixture"}}\0' }]);
    assert.deepEqual(JSON.parse((await f.adapter.readLocalClaudeCredential()).raw), { claudeAiOauth: { accessToken: 'keychain-fixture' } });
    const file = path.join(f.options.userHome, '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = '{"claudeAiOauth":{"accessToken":"file-fixture"}}';
    fs.writeFileSync(file, raw);
    assert.deepEqual(await f.adapter.readLocalClaudeCredential(), { present: true, raw });
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    await close(f);
  });

  await test('Qoder SQLite safeStorage import returns the engine credential shape without changing input', async () => {
    const f = fixture('darwin', [{ service: 'Qoder Safe Storage', account: 'Qoder Key', raw: 'fixture-safe-storage-key' }]);
    const ide = { id: 'fixture-uid', token: 'fake-qoder-token', refreshToken: 'fake-refresh', expireTime: '1790000000000', orgId: 'fixture-org', privacyPolicyAgreed: true };
    const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync('fixture-safe-storage-key', 'saltysalt', 1003, 16, 'sha1'), Buffer.alloc(16, 32));
    const blob = Buffer.concat([Buffer.from('v10'), cipher.update(JSON.stringify(ide)), cipher.final()]);
    const db = path.join(f.options.userHome, 'Library/Application Support/Qoder/User/globalStorage/state.vscdb');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const database = new DatabaseSync(db);
    try {
      database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('secret://aicoding.auth.userInfo', JSON.stringify({ type: 'Buffer', data: [...blob] }));
    } finally { database.close(); }
    const before = fs.readFileSync(db);
    assert.deepEqual(await f.adapter.readQoderIdeCredential(), { present: true, userInfo: { uid: 'fixture-uid', security_oauth_token: 'fake-qoder-token', access_token: 'fake-qoder-token', refresh_token: 'fake-refresh', expire_time: 1790000000, organization_id: 'fixture-org', data_policy_agreed: true, organization_tags: [], login_method: 'qoder-ide' } });
    assert.deepEqual(fs.readFileSync(db), before);
    await close(f);
  });

  await test('QwenWork safeStorage import returns its device-bound engine shape without changing input', async () => {
    const f = fixture('darwin', [{ service: 'QwenWorkCN Safe Storage', account: 'QwenWorkCN Key', raw: 'fixture-safe-storage-key' }]);
    const stored = {
      schemaVersion: 2,
      token: 'fake-qwenwork-token',
      refreshToken: 'fake-refresh',
      expiresAt: '2027-01-15T08:00:00Z',
      user: { id: 'fixture-user', name: 'Fixture User', orgId: 'fixture-org', orgTags: ['enterprise'], isBiz: true },
      loginMethod: 'device',
      refreshStrategy: 'device',
      loginDeviceId: '01234567-89ab-cdef-0123-456789abcdef',
    };
    const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync('fixture-safe-storage-key', 'saltysalt', 1003, 16, 'sha1'), Buffer.alloc(16, 32));
    const blob = Buffer.concat([Buffer.from('v10'), cipher.update(JSON.stringify(stored)), cipher.final()]);
    const file = path.join(f.options.userHome, 'Library/Application Support/QwenWorkCN/auth-v2.dat');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, blob);
    const before = fs.readFileSync(file);
    const result = await f.adapter.readQwenWorkCredential();
    assert.equal(result.present, true);
    assert.equal(result.machineId, '01234567-89ab-cdef-0123-456789abcdef');
    assert.equal(result.userInfo.uid, 'fixture-user');
    assert.equal(result.userInfo.security_oauth_token, 'fake-qwenwork-token');
    assert.deepEqual(result.userInfo.organization_tags, ['enterprise']);
    assert.equal(result.userInfo.refresh_strategy, 'device');
    assert.deepEqual(fs.readFileSync(file), before);
    await close(f);
  });

  await test('WorkBuddy edition parameters cross the actual native binding and invalid editions are rejected', async () => {
    const f = fixture();
    try {
      for (const region of ['cn', 'intl']) {
        const result = await f.adapter.readWorkBuddyCredential(region);
        assert.equal(typeof result.present, 'boolean');
        assert.equal(result.userInfo, undefined);
      }
      assert.throws(() => f.binding.readWorkbuddyCredential('invalid-edition', 2000, 'unknown'), /INVALID_WORKBUDDY_REGION/);
    } finally { await close(f); }
  });

  await test('shutdown fences late credential data and reports a running OS call instead of false completion', async () => {
    const f = fixture('darwin', [], 250);
    const key = 'fixture|0123456789abcdef';
    const pending = f.adapter.readMcpOAuthRecord(key, 'tokens');
    await sleep(40);
    const began = Date.now();
    const report = await f.adapter.close(10);
    assert.ok(Date.now() - began < 500);
    assert.equal(report.complete, false);
    assert.equal(report.pendingOperations.length, 1);
    assert.deepEqual(await pending, { value: null, error: 'CREDENTIALS_CLOSED' });
    assert.equal(JSON.parse(await f.binding.shutdown(1000)).complete, true);
    live.delete(f.binding);
  });
}

run().catch(error => { results.push({ name: 'suite', ok: false, error: error.stack }); console.error(error); }).finally(async () => {
  for (const binding of live) {
    try { await binding.shutdown(2000); } catch {}
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  const passed = results.filter(result => result.ok).length;
  const failed = results.length - passed;
  const output = path.resolve(__dirname, '../test-results');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'credentials-electron.json'), JSON.stringify({ passed, failed, results }, null, 2));
  console.log(`native-credentials-electron: ${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
