import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL('..', import.meta.url));
const electron = require('electron');
if (!process.argv.includes('--electron-only')) {
  const result = spawnSync(electron, ['dist/tests/auxiliary.test.js'], { cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.argv.includes('--unit-only')) process.exit(0);
assertElectronGuiAvailable();
const root = mkdtempSync(join(tmpdir(), 'klaus-auxiliary-electron-'));
for (const entry of ['quick-input-renderer', 'quick-input-main-renderer']) {
  await require('esbuild').build({ absWorkingDir: desktop, entryPoints: [`tests/fixtures/${entry}.mts`], outfile: join(root, `${entry}.js`),
    bundle: true, platform: 'browser', target: 'es2022', format: 'iife', loader: { '.svg': 'text' }, logLevel: 'warning' });
}
const env = { ...process.env, KLAUS_AUXILIARY_TEST_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnElectronGuiSync(electron, ['tests/auxiliary-electron.cjs'], { cwd: desktop, env, stdio: 'inherit', timeout: 90_000 });
if (result.error) throw result.error;
if (result.status === 0) rmSync(root, { recursive: true, force: true });
else console.error(`auxiliary fixture evidence: ${root}`);
process.exit(result.status ?? 1);
