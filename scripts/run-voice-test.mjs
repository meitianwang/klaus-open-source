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
  for (const entry of ['voice.test.js', 'voice-streaming.test.js']) {
    const unit = spawnSync(electron, [`dist/tests/${entry}`], { cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 60_000 });
    if (unit.error) throw unit.error;
    if (unit.status !== 0) process.exit(unit.status ?? 1);
  }
}
assertElectronGuiAvailable();
const root = mkdtempSync(join(tmpdir(), 'klaus-voice-electron-'));
await require('esbuild').build({ absWorkingDir: desktop, entryPoints: ['tests/fixtures/voice-renderer.mts'], outfile: join(root, 'renderer.js'), bundle: true,
  platform: 'browser', target: 'es2022', format: 'iife', jsx: 'automatic', loader: { '.svg': 'text' }, logLevel: 'warning' });
const env = { ...process.env, KLAUS_VOICE_TEST_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnElectronGuiSync(electron, ['tests/voice-electron.cjs'], { cwd: desktop, env, stdio: 'inherit', timeout: 60_000 });
if (result.error) throw result.error;
if (result.status === 0) rmSync(root, { recursive: true, force: true });
else console.error(`voice fixture evidence: ${root}`);
process.exit(result.status ?? 1);
