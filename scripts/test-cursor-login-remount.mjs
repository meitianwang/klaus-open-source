import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronGuiAvailable, spawnElectronGui } from './electron-test-preflight.cjs';

assertElectronGuiAvailable();
const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'klaus-cursor-remount-'));
const env = { ...process.env, KLAUS_CURSOR_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
let child;
const interrupt = () => child?.kill('SIGINT');
const terminate = () => child?.kill('SIGTERM');
try {
  child = spawnElectronGui(createRequire(import.meta.url)('electron'),
    [join(desktop, 'tests/cursor-login-remount-electron.cjs')], { env, stdio: 'inherit' });
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  // Electron helpers may flush profile files until the application has exited.
  rmSync(profile, { recursive: true, force: true });
  console.log('Removed isolated account-card profile:', profile);
}
