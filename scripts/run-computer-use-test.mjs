import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(require('electron'), ['dist/tests/computer-use-policy.test.js'], {
  cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 60_000,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
