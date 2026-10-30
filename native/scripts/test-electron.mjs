import { spawnElectronGuiSync } from '../../scripts/electron-test-preflight.cjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const windows = process.platform === 'win32' && !process.argv.includes('--credentials');
const profile = mkdtempSync(path.join(os.tmpdir(), windows ? 'klaus-conpty-electron-' : 'klaus-native-electron-gate-'));
env.KLAUS_NATIVE_TEST_ROOT = profile;
if (windows) { env.KLAUS_CONPTY_TEST_ROOT = profile; env.KLAUS_CONPTY_NODE_EXECUTABLE = process.execPath; }
const entry = process.argv.includes('--credentials') ? 'native/tests/credentials-electron.cjs'
  : windows ? 'native/tests/conpty-electron.cjs' : 'native/tests/electron-main.cjs';
let status = 1;
try {
  // Cocoa crash restoration belongs to the shared Electron bundle, not this
  // disposable profile. Override it only in this process's volatile defaults.
  const args = [entry, ...(process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [])];
  const result = spawnElectronGuiSync(require('electron'), args, {
    cwd: root, env, stdio: 'inherit', timeout: 120_000, killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Native Electron test terminated by ${result.signal}`);
  status = result.status ?? 1;
} finally { rmSync(profile, { recursive: true, force: true }); }
process.exit(status);
