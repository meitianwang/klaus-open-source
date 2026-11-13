import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';

const { values } = parseArgs({ options: {
  engine: { type: 'string' }, account: { type: 'string' }, pcm: { type: 'string' }, output: { type: 'string' }, source: { type: 'string' }, refinement: { type: 'boolean', default: false },
} });
for (const key of ['engine', 'account', 'pcm', 'output']) if (!values[key] || !isAbsolute(values[key])) throw new Error(`--${key} requires an explicit absolute path`);
if (!['antigravity', 'qoder', 'qwenwork'].includes(values.source)) throw new Error('--source must select a supported streaming provider');
assertElectronGuiAvailable();
const desktop = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'klaus-voice-live-electron-'));
await require('esbuild').build({ absWorkingDir: desktop, entryPoints: ['tests/fixtures/voice-renderer.mts'], outfile: join(root, 'renderer.js'), bundle: true,
  platform: 'browser', target: 'es2022', format: 'iife', jsx: 'automatic', loader: { '.svg': 'text' }, logLevel: 'warning' });
const env = { ...process.env, KLAUS_VOICE_LIVE_ROOT: root, KLAUS_VOICE_LIVE_ENGINE: values.engine,
  KLAUS_VOICE_LIVE_ACCOUNT: values.account, KLAUS_VOICE_LIVE_PCM: values.pcm, KLAUS_VOICE_LIVE_OUTPUT: values.output, KLAUS_VOICE_LIVE_SOURCE: values.source, KLAUS_VOICE_LIVE_REFINEMENT: values.refinement ? '1' : '0' };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnElectronGuiSync(require('electron'), [resolve(desktop, 'tests/voice-live-provider-electron.cjs')], { cwd: desktop, env, stdio: 'inherit', timeout: 120000 });
if (result.error) throw result.error;
if (result.status === 0) rmSync(root, { recursive: true, force: true });
else console.error(`Live dictation fixture profile: ${root}`);
process.exit(result.status ?? 1);
