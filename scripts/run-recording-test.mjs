import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL('..', import.meta.url)), electron = require('electron');
if (!process.argv.includes('--electron-only')) {
  const result = spawnSync(electron, ['dist/tests/recording.test.js'], { cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.argv.includes('--unit-only')) process.exit(0);
assertElectronGuiAvailable();
const root = mkdtempSync(join(tmpdir(), 'klaus-recording-electron-'));
await require('esbuild').build({ absWorkingDir: desktop, entryPoints: ['tests/fixtures/recording-main-renderer.mts'], outfile: join(root, 'recording-main-renderer.js'), bundle: true, platform: 'browser', target: 'es2022', format: 'iife', logLevel: 'warning' });
if (process.platform === 'darwin') {
  const build = spawnSync('xcrun', ['clang', '-O2', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-framework', 'AppKit', '-framework', 'Carbon', resolve(desktop, 'tests/fixtures/recording-input.m'), '-o', join(root, 'recording-input')], { stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const env = { ...process.env, KLAUS_RECORDING_TEST_ROOT: root,
  KLAUS_RECORDING_HELPER: process.env.KLAUS_RECORDING_HELPER ?? resolve(desktop, 'native/artifacts/recording', `darwin-${process.arch}`, 'klaus-recording-helper') };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnElectronGuiSync(electron, ['tests/recording-electron.cjs'], { cwd: desktop, env, stdio: 'inherit', timeout: 90_000 });
if (result.error) throw result.error;
if (result.status === 0) rmSync(root, { recursive: true, force: true }); else console.error(`recording Electron evidence: ${root}`);
process.exit(result.status ?? 1);
