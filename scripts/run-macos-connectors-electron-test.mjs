import { spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'darwin') throw new Error('The Finder integration test requires macOS');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnElectronGuiSync(require('electron'), ['tests/macos-connectors-electron.cjs'], { cwd: desktop, env, stdio: 'inherit', timeout: 120_000 });
if (result.error) throw result.error; process.exit(result.status ?? 1);
