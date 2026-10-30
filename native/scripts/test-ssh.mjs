import { assertElectronGuiAvailable } from '../../scripts/electron-test-preflight.cjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
assertElectronGuiAvailable();
let fixtureBin;
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--fixture-bin=')) fixtureBin = argument.slice('--fixture-bin='.length);
  else throw new Error(`Unknown SSH gate option: ${argument}`);
}
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1)); });
}
if (!fixtureBin) {
  const code = await run('cargo', ['build', '--locked', '--manifest-path', 'native/Cargo.toml', '-p', 'klaus-native-core', '--features', 'ssh-fixtures', '--bin', 'klaus-ssh-fixture'],
    { env: { ...process.env, CARGO_BUILD_JOBS: '4' } });
  if (code !== 0) process.exit(code);
  fixtureBin = path.join(root, 'native/target/debug', process.platform === 'win32' ? 'klaus-ssh-fixture.exe' : 'klaus-ssh-fixture');
}
if (!path.isAbsolute(fixtureBin)) throw new Error('SSH fixture binary must be absolute');
const profile = mkdtempSync(path.join(tmpdir(), 'klaus-ssh-gate-'));
const fixture = spawn(fixtureBin, [profile], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => fixture.once('close', resolve));
const env = { ...process.env, KLAUS_SSH_TEST_ROOT: profile };
delete env.ELECTRON_RUN_AS_NODE;
let status = 1;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSH fixture startup timed out')), 15_000);
    const finish = (error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
    fixture.once('error', finish);
    fixture.once('exit', () => finish(new Error('SSH fixture exited before its test completed')));
    fixture.stdout.on('data', (bytes) => { const text = bytes.toString('utf8'); process.stdout.write(text); if (text.includes('SSH fixture ready')) finish(); });
    fixture.stderr.on('data', bytes => process.stderr.write(bytes));
  });
  status = await run(require('electron'), ['native/tests/ssh-electron.cjs'], { env, timeout: 120_000 });
} finally {
  if (fixture.exitCode === null) fixture.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true });
}
process.exit(status);
