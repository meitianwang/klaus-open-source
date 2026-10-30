import { spawnElectronGuiSync } from '../../scripts/electron-test-preflight.cjs';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const profile = mkdtempSync(path.join(tmpdir(), 'klaus-windows-credential-gate-'));
const env = { ...process.env, KLAUS_CREDENTIAL_TEST_ROOT: profile };
delete env.ELECTRON_RUN_AS_NODE;
let status = 0;
try {
  for (const phase of process.platform === 'win32' ? ['suite', 'reopen'] : ['suite']) {
    const result = spawnElectronGuiSync(require('electron'), ['native/tests/windows-credentials-electron.cjs', phase], {
      cwd: root, env, stdio: 'inherit', timeout: 120_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) { status = result.status ?? 1; break; }
  }
} finally { rmSync(profile, { recursive: true, force: true }); }
process.exit(status);
