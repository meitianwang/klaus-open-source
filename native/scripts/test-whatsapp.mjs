import { spawnElectronGuiSync } from '../../scripts/electron-test-preflight.cjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const profile = mkdtempSync(path.join(tmpdir(), 'klaus-whatsapp-electron-gate-'));
const env = { ...process.env, KLAUS_WHATSAPP_TEST_ROOT: profile };
delete env.ELECTRON_RUN_AS_NODE;
const entry = process.argv.includes('--production') ? 'native/tests/whatsapp-production.cjs' : 'native/tests/whatsapp-electron.cjs';
let status = 1;
try {
  const result = spawnElectronGuiSync(process.env.KLAUS_TEST_ELECTRON || require('electron'), [entry], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)), env, stdio: 'inherit', timeout: 150_000,
  });
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally { rmSync(profile, { recursive: true, force: true }); }
process.exit(status);
