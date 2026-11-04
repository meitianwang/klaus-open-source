import { assertElectronGuiAvailable, spawnElectronGui } from './electron-test-preflight.cjs';
import { resolveElectronRuntime } from './electron-runtime-resolver.mjs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (!args.length) throw new Error('Usage: node apps/desktop/scripts/run-electron-test.mjs <test entry> [Electron arguments]');
assertElectronGuiAvailable();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = await resolveElectronRuntime({ appDirectory: root, mode: process.env.KLAUS_ELECTRON_RUNTIME_MODE ?? 'stock', env: process.env });
const child = spawnElectronGui(runtime.executable, args, { env, stdio: 'inherit' });
const forward = signal => child.kill(signal);
const interrupt = () => forward('SIGINT');
const terminate = () => forward('SIGTERM');
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('close', (code, signal) => {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  if (signal) console.error(`Electron test terminated by ${signal}`);
  process.exitCode = code ?? 1;
});
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
