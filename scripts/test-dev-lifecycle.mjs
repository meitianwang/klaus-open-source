import { assertElectronGuiAvailable, spawnElectronGui } from './electron-test-preflight.cjs';
import { prepareTestEngine } from './prepare-test-engine.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { finished } from 'node:stream/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assertElectronGuiAvailable();
const root = fileURLToPath(new URL('..', import.meta.url)), require = createRequire(import.meta.url), electron = require('electron');
for (const args of [[require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], ['scripts/build-preload.mjs']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
prepareTestEngine(root);
const fixtures = join(root, 'dist/fixtures'); mkdirSync(fixtures, { recursive: true });
const results = [];
for (const action of ['quit', 'disconnect']) {
  const profile = mkdtempSync(join(fixtures, 'dev-lifecycle-'));
  const env = { ...process.env, KLAUS_CONFIG_DIR: profile, CANONICAL_CWD: profile, KLAUS_TEST: '1', KLAUS_INSTANCE_FIXTURE_ID: `ai.klaus.instance-fixture.${randomUUID()}` }; delete env.ELECTRON_RUN_AS_NODE;
  const setup = spawnSync(electron, ['-e', `const {kvSet}=require('./dist/main/services/settings'); for(const key of ['global_shortcut','quick_input_shortcut','notification.desktop','notification.sound']) kvSet(key,'off',process.env.KLAUS_CONFIG_DIR);`], { cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (setup.error || setup.status !== 0) throw setup.error ?? new Error('Could not prepare an isolated dev profile');
  writeFileSync(join(profile, 'klaus-guest-mode'), '1', { mode: 0o600 });
  const child = spawnElectronGui(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let report, ready, output = '', failure;
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const drained = Promise.all([finished(child.stdout), finished(child.stderr)]);
  const append = chunk => { output = (output + chunk.toString()).slice(-12_000); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.on('message', message => {
    if (message.type === 'klaus:dev:ready') {
      ready = message;
      if (action === 'disconnect') child.disconnect();
      else child.send({ type: 'klaus:dev:quit' });
    } else if (message.type === 'klaus:dev:closed') report = message;
  });
  const timer = setTimeout(() => { failure = new Error('Development lifecycle exceeded its deadline'); child.kill('SIGKILL'); }, 45_000);
  try {
    const [exit] = await Promise.all([exited, drained]);
    clearTimeout(timer);
    if (failure) throw failure;
    assert.deepEqual(exit, { code: 0, signal: null }, output);
    assert.ok(ready, 'Production entry reached dev readiness');
    for (const engine of ready.engines) if (engine.pid) assert.throws(() => process.kill(engine.pid, 0), { code: 'ESRCH' }, 'The owned engine exited');
    if (action === 'quit') {
      assert.equal(report?.engineCount, 0, 'Graceful shutdown report');
      assert.deepEqual(report.native, { searches: 0, ptys: 0, searchSessions: 0 }, 'Native resources drained before quit');
    }
    results.push({ action, passed: true, enginePids: ready.engines.map(engine => engine.pid), ...(report ? { report } : {}) });
    console.log(`  ok   production dev entry ${action} releases its actual engine and exits normally`);
  } catch (error) {
    console.error(error, output); results.push({ action, passed: false }); process.exitCode = 1;
  } finally {
    clearTimeout(timer); rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    if (process.platform === 'darwin') {
      // This unpredictable identity is used only by this already-exited fixture.
      const name = env.KLAUS_INSTANCE_FIXTURE_ID.replace(/[.-]/g, '_');
      rmSync(`/tmp/${name}_si.sock`, { force: true });
      rmSync(`/tmp/${name}_electron_si.lock`, { force: true });
    }
  }
}
writeFileSync(join(root, 'dist/dev-lifecycle-result.json'), JSON.stringify(results, null, 2));
console.log(`dev-lifecycle: ${results.filter(result => result.passed).length} passed, ${results.filter(result => !result.passed).length} failed`);
