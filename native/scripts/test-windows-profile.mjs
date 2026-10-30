import { spawnElectronGuiSync } from '../../scripts/electron-test-preflight.cjs';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('The Windows profile recovery gate requires Windows');
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const profile = mkdtempSync(path.join(tmpdir(), 'klaus-windows-profile-gate-'));
const env = { ...process.env, KLAUS_WINDOWS_PROFILE_TEST_ROOT: profile };
delete env.ELECTRON_RUN_AS_NODE;
let passed = 0;
try {
  for (const mode of ['before', 'after', 'cleanup', 'missing']) {
    for (const phase of ['seed', 'crash', 'recover']) {
      console.log(`  Windows profile ${mode}: ${phase}`);
      const result = spawnElectronGuiSync(require('electron'), ['native/tests/windows-profile-electron.cjs', mode, phase], {
        cwd: root, env, stdio: 'inherit', timeout: 90_000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Windows profile ${mode}/${phase} failed: ${result.status}`);
    }
    passed++;
  }
  console.log(`windows-profile-electron: ${passed} recovery cases passed, 0 failed`);
} finally { rmSync(profile, { recursive: true, force: true }); }
