import { createRequire } from 'node:module';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logsRoot = join(desktop, 'dist/side-transcript-logs');
mkdirSync(logsRoot, { recursive: true });
const logs = mkdtempSync(join(logsRoot, 'run-'));
const profile = join(logs, 'profile');
const gate = join(logs, 'gate.log'), log = openSync(gate, 'a');
function build(args) {
  writeFileSync(log, `COMMAND: ${JSON.stringify([process.execPath, ...args])}\n`);
  const result = spawnSync(process.execPath, args, { cwd: desktop, stdio: ['ignore', log, log], timeout: 180_000 });
  writeFileSync(log, `EXIT: ${result.status}; SIGNAL: ${result.signal ?? ''}\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Build failed');
}
try {
  if (process.argv.length !== 2) throw Error('This fixture accepts no arguments');
  writeFileSync(log, 'COMMAND: Electron GUI preflight\n');
  assertElectronGuiAvailable();
  // The normal resource preparation stages the engine and native addon. Record
  // the staged engine identity rather than rebuilding unrelated engine sources.
  const manifest = readFileSync(join(desktop, 'resources/bin', `${process.platform}-${process.arch}`, 'manifest.json'), 'utf8');
  writeFileSync(join(logs, 'engine-manifest.json'), manifest);
  build([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  build([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.native-bindings.json']);
  build(['scripts/build-preload.mjs']);
  build([join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--config', 'vite.config.mts']);
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env, KLAUS_CONFIG_DIR: profile, KLAUS_PLUGIN_HOME: join(profile, 'plugins'),
    KLAUS_SIDE_TRANSCRIPT_PROFILE: profile, KLAUS_SIDE_TRANSCRIPT_LOGS: logs };
  delete env.ELECTRON_RUN_AS_NODE;
  writeFileSync(log, 'COMMAND: approved Electron runner dist/tests/side-transcript-app.integration.js\n');
  const result = spawnElectronGuiSync(require('electron'), ['dist/tests/side-transcript-app.integration.js'], {
    cwd: desktop, env, stdio: ['ignore', log, log], timeout: 180_000,
  });
  writeFileSync(log, `EXIT: ${result.status}; SIGNAL: ${result.signal ?? ''}\n`);
  if (result.error) throw result.error;
  const report = JSON.parse(readFileSync(join(logs, 'result.json'), 'utf8'));
  if (result.status !== 0 || !report.passed || report.checks !== 34) throw Error('Side transcript acceptance failed');
  console.log(`Side transcript: ${report.checks} checks passed. Original output: ${gate}`);
} catch (error) {
  writeFileSync(log, String(error instanceof Error ? error.stack : error) + '\n');
  console.error(`${error instanceof Error ? error.message : error}\nOriginal output: ${gate}`);
  process.exitCode = 1;
} finally {
  closeSync(log);
  rmSync(profile, { recursive: true, force: true });
}
