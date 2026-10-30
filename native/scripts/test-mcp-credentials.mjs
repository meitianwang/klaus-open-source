import { spawnElectronGuiSync } from '../../scripts/electron-test-preflight.cjs';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const profile = mkdtempSync(path.join(tmpdir(), 'klaus-mcp-credential-gate-'));
const env = { ...process.env, KLAUS_MCP_CREDENTIAL_TEST_ROOT: profile };
delete env.ELECTRON_RUN_AS_NODE;
let status = 0;
try {
  for (const phase of process.platform === 'win32' ? ['suite', 'reopen', 'crash-before', 'recover-before', 'crash-after', 'recover-after', 'crash-delete', 'recover-delete'] : ['suite']) {
    const result = spawnElectronGuiSync(require('electron'), ['native/tests/mcp-credentials-electron.cjs', phase], {
      cwd: root, env, stdio: 'inherit', timeout: 120_000,
    });
    if (result.error) throw result.error;
    const expected = phase.startsWith('crash-') ? 75 : 0;
    if (result.status !== expected) { status = result.status || 1; break; }
    if (expected) console.log(`${phase}: process exit ${result.status} at the requested transaction boundary`);
  }
} finally { rmSync(profile, { recursive: true, force: true }); }
process.exit(status);
