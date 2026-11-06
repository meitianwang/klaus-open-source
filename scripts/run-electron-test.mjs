import { createRequire } from 'node:module';
import { assertElectronGuiAvailable, spawnElectronGui } from './electron-test-preflight.cjs';

const args = process.argv.slice(2);
if (!args.length) throw new Error('Usage: node apps/desktop/scripts/run-electron-test.mjs <test entry> [Electron arguments]');
assertElectronGuiAvailable();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawnElectronGui(createRequire(import.meta.url)('electron'), args, { env, stdio: 'inherit' });
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
