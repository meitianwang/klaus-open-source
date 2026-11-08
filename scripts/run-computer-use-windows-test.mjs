import { spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') throw new Error('Run the real Windows Computer Use fixture on Windows');
const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'klaus-computer-use-windows-'));
const compiler = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
execFileSync(compiler, ['/nologo', '/target:winexe', '/warn:4', '/warnaserror+', '/codepage:65001', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  `/out:${join(root, 'Klaus CU Windows Native Fixture.exe')}`, resolve(desktop, 'tests/computer-use-windows-synthetic.cs')], { windowsHide: true, stdio: 'inherit' });
const env = { ...process.env, KLAUS_COMPUTER_USE_TEST_ROOT: root,
  KLAUS_COMPUTER_USE_HELPER: process.env.KLAUS_COMPUTER_USE_HELPER ?? resolve(desktop, 'native/artifacts/computer-use/win32-x64/klaus-computer-use-helper.exe') };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnElectronGuiSync(require('electron'), ['tests/computer-use-windows-electron.cjs'], { cwd: desktop, env, stdio: 'inherit', timeout: 255000 });
let complete = false;
try { const summary = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')); complete = summary.passed === 12 && summary.failed === 0 && summary.results.length === 12 && summary.cleanup; } catch {}
if (result.status === 0 && complete) rmSync(root, { recursive: true, force: true }); else console.error(`Synthetic Windows Computer Use evidence: ${root}`);
if (result.error) throw result.error; process.exit(result.status === 0 && complete ? 0 : 1);
