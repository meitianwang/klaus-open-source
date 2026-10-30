import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const names = new Set(['pending-live', 'media-live', 'provider', 'configure-provider']);
const name = process.argv[2];
if (!names.has(name)) throw new Error(`Choose one fixture: ${[...names].join(', ')}`);
const require = createRequire(import.meta.url);
const child = spawn(require('electron'), [fileURLToPath(new URL(`./${name}.cjs`, import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
