import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveElectronRuntime } from './electron-runtime-resolver.mjs';

const require = createRequire(import.meta.url);
const { spawnElectronGuiSync } = require('./electron-test-preflight.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const explicit = process.argv[2];
const executable = explicit ? resolve(explicit) : (await resolveElectronRuntime({ appDirectory: root, env: process.env })).executable;
const logs = join(root, 'dist', 'browser-native-import-logs');
mkdirSync(logs, { recursive: true });
const profile = mkdtempSync(join(logs, 'profile-'));
for (const phase of ['initial', 'restart', 'no-source']) {
  const output = join(logs, `${profile.split('/').at(-1)}-${phase}.json`);
  const env = { ...process.env, NATIVE_IMPORT_PROFILE: profile, NATIVE_IMPORT_OUTPUT: output, NATIVE_IMPORT_PHASE: phase };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [join(root, 'tests', 'browser-native-source-import.cjs'), `--user-data-dir=${join(profile, 'electron')}`, '--use-mock-keychain'];
  console.log('COMMAND', JSON.stringify([executable, ...args]));
  const child = spawnElectronGuiSync(executable, args, { env, stdio: 'inherit', timeout: 120000 });
  console.log('EXIT', JSON.stringify({ phase, status: child.status, signal: child.signal, error: child.error?.message }));
  if (child.error || child.status !== 0) process.exit(1);
  const result = JSON.parse(readFileSync(output, 'utf8'));
  if (!result.ok) throw Error('Native import verification did not complete.');
  console.log('PASS', JSON.stringify(result));
}
rmSync(profile, { recursive: true, force: true });
console.log('CLEANUP', profile);
