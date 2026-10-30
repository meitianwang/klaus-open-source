import { spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'darwin') throw new Error('The System integration test requires macOS');
const artifacts = join(desktop, 'native', 'artifacts'); mkdirSync(artifacts, { recursive: true });
const directory = mkdtempSync(join(artifacts, 'system-electron-fixture-'));
try {
  const env = { ...process.env, KLAUS_SYSTEM_FIXTURE_ROOT: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnElectronGuiSync(require('electron'), ['tests/macos-system-electron.cjs'], { cwd: desktop, env, stdio: 'inherit', timeout: 60_000 });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
} finally {
  // Chromium can flush its profile while exiting, after the main-process cleanup.
  rmSync(directory, { recursive: true, force: true });
  if (existsSync(directory)) throw new Error('The owned System fixture directory still exists');
  console.log('owned_system_fixture_cleanup=removed_after_process_exit');
}
