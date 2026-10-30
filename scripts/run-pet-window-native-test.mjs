import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronGuiAvailable, spawnElectronGui } from './electron-test-preflight.cjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifactRoot = path.resolve(process.argv[2] ?? path.join(root, 'dist/pet-window-native-logs'));
mkdirSync(artifactRoot, { recursive: true });
const logs = mkdtempSync(path.join(artifactRoot, 'run-'));
console.log(`Native companion artifacts: ${logs}`);
assertElectronGuiAvailable();
const log = path.join(logs, 'native-window-run.log');
function command(executable, args) {
  appendFileSync(log, `COMMAND ${JSON.stringify([executable, ...args])}\n`);
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
  appendFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}EXIT ${result.status} SIGNAL ${result.signal}\n`);
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) throw result.error ?? Error(`${executable} exited ${result.status ?? result.signal}`);
}
const input = path.join(logs, 'pet-window-input'), recognizer = path.join(logs, 'appshot-shortcut');
command('/usr/bin/xcrun', ['clang', '-O2', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', 'tests/fixtures/pet-window-input.m', '-framework', 'AppKit', '-framework', 'Carbon', '-o', input]);
command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', input]);
command('/usr/bin/codesign', ['--verify', '--strict', input]);
command('/usr/bin/xcrun', ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'native/tests/appshot-shortcut.c', '-o', recognizer]);
command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', recognizer]);
command('/usr/bin/codesign', ['--verify', '--strict', recognizer]);
command(recognizer, []);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const args = [path.join(root, 'tests/desktop-pet-window-electron.cjs'), logs];
appendFileSync(log, `COMMAND ${JSON.stringify(['electron', ...args])}\n`);
const child = spawnElectronGui(createRequire(import.meta.url)('electron'), args, { cwd: root, env, stdio: ['inherit', 'pipe', 'pipe'] });
for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', chunk => { destination.write(chunk); appendFileSync(log, chunk); });
const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
child.on('error', error => { appendFileSync(log, `${error.stack}\n`); process.exitCode = 1; });
child.on('close', (code, signal) => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); appendFileSync(log, `EXIT ${code} SIGNAL ${signal}\n`); process.exitCode = code ?? 1; });
