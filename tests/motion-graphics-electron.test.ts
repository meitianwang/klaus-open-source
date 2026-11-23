import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, assertEqual, Harness } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');

const desktop = resolve(__dirname, '../..');
const logs = join(desktop, 'dist/motion-graphics-logs');
const h = new Harness();

h.test('the WebGPU motion-graphics studio authors keyframed/expression animations, renders 60fps previews, exports .aep/.mp4/.gif/.psd/lottie, and persists .ecproj generations', async () => {
  const runtime = resolve(officialPluginRoot('motion-graphics'), 'runtime/dist/runtime-manifest.json');
  assert(existsSync(runtime), 'Build the motion-graphics WASM runtime before running this fixture.');
  mkdirSync(logs, { recursive: true });
  const profile = mkdtempSync(join(logs, 'fixture-profile-'));
  try {
    const { ELECTRON_RUN_AS_NODE: _dropNodeMode, ...cleanEnv } = process.env;
    const nodeExecutable = process.versions.electron ? 'node' : process.execPath;
    const result = spawnSync(nodeExecutable, ['scripts/run-electron-test.mjs', 'dist/tests/motion-graphics-fixture.js'], {
      cwd: desktop,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...cleanEnv, KLAUS_MOTION_GRAPHICS_FIXTURE_PROFILE: profile },
    });
    assert(!result.error, String(result.error));
    assertEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(readFileSync(join(logs, 'motion-graphics-fixture-result.json'), 'utf8'));
    assertEqual(report.failed, 0, 'all motion-graphics Electron WebGPU integration cases pass');
    assert(report.passed >= 4, 'the fixture covers WebGPU boot, keyframe/expression/CJK authoring, 60fps benchmark + contact sheet, and multi-format export/import round-trips');
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

void h.finish(join(logs, 'electron-launcher-result.json'), 'motion-graphics-electron').then(code => { process.exitCode = code; });
