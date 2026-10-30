import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, assertEqual, Harness } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');

const desktop = resolve(__dirname, '../..');
const logs = join(desktop, 'dist/prototype-figcraft-logs');
const h = new Harness();
h.test('the complete interface editor shares edits and preserves its native workspace', async () => {
  const runtime = resolve(officialPluginRoot('prototype-studio'), 'runtime/dist/runtime-manifest.json');
  assert(existsSync(runtime), 'Build the interface editor runtime before running this fixture.');
  mkdirSync(logs, { recursive: true });
  const profile = mkdtempSync(join(logs, 'fixture-profile-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/run-electron-test.mjs', 'dist/tests/prototype-fixture.js'], {
      cwd: desktop, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, KLAUS_PROTOTYPE_FIXTURE_PROFILE: profile },
    });
    assert(!result.error, String(result.error));
    assertEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(readFileSync(join(logs, 'prototype-fixture-result.json'), 'utf8'));
    assertEqual(report.failed, 0, 'all editor integration cases pass');
    assert(report.passed >= 10, 'the fixture covers shared editing, persistence, isolation, exports and recovery');
  } finally { rmSync(profile, { recursive: true, force: true }); }
});
void h.finish(join(logs, 'electron-launcher-result.json'), 'prototype-electron').then(code => { process.exitCode = code; });
