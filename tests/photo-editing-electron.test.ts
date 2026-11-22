import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, assertEqual, Harness } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');

const desktop = resolve(__dirname, '../..');
const logs = join(desktop, 'dist/photo-editing-logs');
const h = new Harness();

h.test('the layered photo-editing workspace shares edits, exports PSD/PNG, and persists its .pcraft archive', async () => {
  const runtime = resolve(officialPluginRoot('photo-editing'), 'runtime/dist/runtime-manifest.json');
  assert(existsSync(runtime), 'Build the photo-editing WASM runtime before running this fixture.');
  mkdirSync(logs, { recursive: true });
  const profile = mkdtempSync(join(logs, 'fixture-profile-'));
  try {
    const { ELECTRON_RUN_AS_NODE: _dropNodeMode, ...cleanEnv } = process.env;
    const nodeExecutable = process.versions.electron ? 'node' : process.execPath;
    const result = spawnSync(nodeExecutable, ['scripts/run-electron-test.mjs', 'dist/tests/photo-editing-fixture.js'], {
      cwd: desktop,
      encoding: 'utf8',
      timeout: 130_000,
      env: { ...cleanEnv, KLAUS_PHOTO_EDITING_FIXTURE_PROFILE: profile },
    });
    assert(!result.error, String(result.error));
    assertEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(readFileSync(join(logs, 'photo-editing-fixture-result.json'), 'utf8'));
    assertEqual(report.failed, 0, 'all photo-editing Electron integration cases pass');
    assert(report.passed >= 3, 'the fixture covers boot, Smart Object + CJK typography editing, exports, and persistence');
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

void h.finish(join(logs, 'electron-launcher-result.json'), 'photo-editing-electron').then(code => { process.exitCode = code; });
