const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

// A sentinel launch proves refusal happens before a GUI child is created.
function fixture(platform, probe, options = {}) {
  const calls = [], child = { pid: 1234 }, syncResult = { status: 0, signal: null };
  const module = { exports: {} };
  runInNewContext(readFileSync(join(__dirname, 'electron-test-preflight.cjs'), 'utf8'), {
    __dirname, module,
    process: { platform, arch: process.arch, env: { CODEX_SANDBOX: 'seatbelt' } },
    require(name) {
      if (name === 'node:fs') return { ...require(name), existsSync: () => true,
        mkdtempSync: () => '/tmp/klaus-gui-preflight-fixture', rmSync() {} };
      if (name !== 'node:child_process') return require(name);
      return {
        spawn(...args) { calls.push({ kind: 'launch', args }); return child; },
        spawnSync(...args) {
          if (args[0] === '/usr/bin/xcrun') { calls.push({ kind: 'compile', args }); return syncResult; }
          if (args[0] === '/usr/bin/codesign') { calls.push({ kind: args[1][0] === '--verify' ? 'verify' : 'sign', args }); return options.signatureFailure ? { status: 1, stderr: 'Invalid local signature' } : syncResult; }
          if (args[0].endsWith('gui-access-probe')) {
            calls.push({ kind: 'probe', args });
            return probe;
          }
          calls.push({ kind: 'launch', args });
          return syncResult;
        },
      };
    },
  });
  return { ...module.exports, calls, child, syncResult };
}

test('denied macOS GUI access prevents both asynchronous and synchronous child creation', () => {
  const f = fixture('darwin', { status: 2, stderr: 'launchservicesd mach-lookup: denied by macOS sandbox' });
  for (const launch of [f.spawnElectronGui, f.spawnElectronGuiSync]) {
    assert.throws(() => launch('/sentinel/electron', ['fixture.cjs']), {
      code: 'KLAUS_ELECTRON_GUI_UNAVAILABLE', message: /Electron GUI test was not started.*outside the restricted command sandbox/s,
    });
  }
  assert.equal(f.calls.filter(call => call.kind === 'launch').length, 0);
});

test('a freshly compiled permission probe is signed and verified at its final executable path', () => {
  const f = fixture('darwin', { status: 0 }, { fresh: true });
  assert.equal(f.spawnElectronGui('/sentinel/electron', []), f.child);
  assert.deepEqual(f.calls.map(call => call.kind), ['compile', 'sign', 'verify', 'probe', 'launch']);
  const signed = f.calls.find(call => call.kind === 'sign');
  assert.equal(signed.args[1].includes('com.klaus.test.gui-access-probe.atomic'), true);
  assert.equal(signed.args[1].includes('--timestamp=none'), true);
});

test('a signing failure prevents permission inspection and GUI child creation', () => {
  const f = fixture('darwin', { status: 0 }, { fresh: true, signatureFailure: true });
  assert.throws(() => f.spawnElectronGui('/sentinel/electron', []), /Cannot sign the macOS GUI access probe/);
  assert.equal(f.calls.some(call => call.kind === 'probe' || call.kind === 'launch'), false);
});

test('unknown, signalled, and timed-out native probes never permit GUI startup', () => {
  for (const probe of [
    { status: 1, stderr: 'inspection failed' },
    { status: null, signal: 'SIGKILL', stderr: '' },
    { status: null, error: new Error('spawnSync ETIMEDOUT') },
  ]) {
    const f = fixture('darwin', probe);
    assert.throws(() => f.spawnElectronGui('/sentinel/electron', []), { code: 'KLAUS_ELECTRON_GUI_UNAVAILABLE' });
    assert.equal(f.calls.filter(call => call.kind === 'launch').length, 0);
  }
});

test('allowed native permissions preserve the executable, arguments, options, and child results', () => {
  const f = fixture('darwin', { status: 0 });
  const args = ['fixture.cjs', '-ApplePersistenceIgnoreState', 'YES'];
  const options = { cwd: '/owned/profile', env: { FIXTURE: '1' }, stdio: 'inherit', timeout: 1000 };
  assert.equal(f.spawnElectronGui('/sentinel/electron', args, options), f.child);
  assert.equal(f.spawnElectronGuiSync('/sentinel/electron', args, options), f.syncResult);
  const launches = f.calls.filter(call => call.kind === 'launch');
  assert.equal(launches.length, 2);
  for (const call of launches) {
    assert.equal(call.args[0], '/sentinel/electron');
    assert.equal(call.args[1], args);
    assert.equal(call.args[2], options);
  }
  // Environment markers cannot override the actual native permission result.
  assert.equal(f.calls.filter(call => call.kind === 'probe').length, 2);
});

test('Windows and Linux launch without requiring macOS tools or changing spawn options', () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture(platform);
    assert.equal(f.spawnElectronGui('/sentinel/electron', []), f.child);
    assert.equal(f.spawnElectronGuiSync('/sentinel/electron', []), f.syncResult);
    assert.equal(f.calls.filter(call => call.kind === 'probe').length, 0);
  }
});

test('native macOS service denial is detected without an agent environment marker', { skip: process.platform !== 'darwin' }, () => {
  const env = { ...process.env };
  delete env.CODEX_SANDBOX;
  const profile = '(version 1) (allow default) (deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))';
  const options = { env, encoding: 'utf8', maxBuffer: 8192, timeout: 40_000 };
  const entry = join(__dirname, 'electron-test-preflight.cjs');
  const current = spawnSync(process.execPath, [entry], options);
  // An existing agent sandbox cannot apply a nested sandbox. Test its real
  // denial directly; otherwise restrict a plain Node child ourselves.
  const result = current.status === 0
    ? spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, entry], options)
    : current;
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /launchservicesd mach-lookup: denied by macOS sandbox/);
  assert.match(result.stderr, /Electron GUI test was not started/);
});
