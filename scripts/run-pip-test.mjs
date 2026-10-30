import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL('..', import.meta.url)), electron = require('electron');
if (!process.argv.includes('--electron-only')) {
  const result = spawnSync(electron, ['dist/tests/pip.test.js'], { cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.argv.includes('--unit-only')) process.exit(0);
// Native fixtures must execute from the workspace: macOS may stall a newly
// compiled temporary-directory helper before main(), even with valid signing.
assertElectronGuiAvailable();
const fixtureDirectory = resolve(desktop, 'dist', 'app-native-fixtures');
mkdirSync(fixtureDirectory, { recursive: true });
const root = mkdtempSync(join(fixtureDirectory, 'klaus-pip-electron-'));
if (process.platform === 'darwin') {
  const result = spawnSync('xcrun', ['clang', '-O2', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
    resolve(desktop, 'tests/fixtures/pip-snapshot.m'), '-o', join(root, 'pip-snapshot')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const env = { ...process.env, KLAUS_PIP_TEST_ROOT: root,
  ...(process.argv.includes('--diagnostics-only') ? { KLAUS_PIP_DIAGNOSTICS_ONLY: '1' } : {}),
  KLAUS_PIP_ADDON: process.env.KLAUS_PIP_ADDON ?? resolve(desktop, 'native/artifacts', `klaus-native-${process.platform}-${process.arch}.node`),
  KLAUS_PIP_PRODUCER: process.env.KLAUS_PIP_PRODUCER ?? resolve(desktop, 'native/artifacts/pip', `darwin-${process.arch}`, 'klaus-pip-producer') };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnElectronGuiSync(electron, ['tests/pip-electron.cjs', '-ApplePersistenceIgnoreState', 'YES'], { cwd: desktop, env, stdio: 'inherit', timeout: 90_000, killSignal: 'SIGKILL' });
if (result.error) throw result.error;
if (result.signal) console.error(`PiP Electron terminated with signal ${result.signal}`);
if (result.status === 0) rmSync(root, { recursive: true, force: true }); else console.error(`PiP Electron evidence: ${root}`);
process.exit(result.status ?? 1);
