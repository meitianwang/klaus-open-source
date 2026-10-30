// Real-application check for a conversation opened while a delivered Turn runs.
//
// The conversation receives a message from another conversation while it is not
// on screen and has not been loaded since the application started; the Turn
// compacts its context and is still running when the conversation is opened.
// The seed and delivery phases run in separate application processes so the
// conversation is cold, and each phase must exit before the next starts (the
// engine holds the rollout writer until its process ends).
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { prepareTestEngine } from './prepare-test-engine.mjs';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logsRoot = join(desktop, 'dist/offscreen-turn-logs');
mkdirSync(logsRoot, { recursive: true });
const logs = mkdtempSync(join(logsRoot, 'run-'));
const gate = join(logs, 'gate.log'), log = openSync(gate, 'a');
let profile, passed = false;
function execute(name, args, timeout = 180_000) {
  writeFileSync(log, `\nCOMMAND: ${JSON.stringify([process.execPath, ...args])}\n`);
  const result = spawnSync(process.execPath, args, { cwd: desktop, stdio: ['ignore', log, log], timeout });
  writeFileSync(log, `EXIT: ${result.status}; SIGNAL: ${result.signal ?? ''}\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${name} failed; original output: ${gate}`);
}
try {
  if (process.argv.length !== 2) throw Error('This fixture accepts no arguments');
  writeFileSync(log, 'COMMAND: Electron GUI preflight\n');
  assertElectronGuiAvailable();
  writeFileSync(log, 'Electron GUI test preflight passed.\n');
  prepareTestEngine(desktop, { logFile: gate });
  execute('host and fixture build', [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  execute('preload build', ['scripts/build-preload.mjs']);
  execute('frontend build', [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--config', 'vite.config.mts']);
  profile = mkdtempSync(join(tmpdir(), 'klaus-offscreen-turn-'));
  // The fixture is an Electron application; an inherited Node-mode flag would run it without Electron.
  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  for (const phase of ['seed', 'deliver']) {
    const phaseLogs = join(logs, phase);
    mkdirSync(phaseLogs, { recursive: true });
    writeFileSync(log, `\nCOMMAND: approved Electron runner dist/tests/offscreen-delegated-turn.integration.js; phase=${phase}\n`);
    const result = spawnElectronGuiSync(require('electron'), ['dist/tests/offscreen-delegated-turn.integration.js'], {
      cwd: desktop, env: { ...baseEnv, KLAUS_OFFSCREEN_PROFILE: profile, KLAUS_OFFSCREEN_LOGS: phaseLogs, KLAUS_OFFSCREEN_PHASE: phase },
      stdio: ['ignore', log, log], timeout: 240_000,
    });
    writeFileSync(log, `PID: ${result.pid}; EXIT: ${result.status}; SIGNAL: ${result.signal ?? ''}\n`);
    if (result.error) throw result.error;
    const report = JSON.parse(readFileSync(join(phaseLogs, 'results.json'), 'utf8'));
    if (result.status !== 0 || report.failed !== 0 || report.passed !== 1) throw Error(`The ${phase} phase did not pass; see ${join(phaseLogs, 'results.json')}`);
  }
  passed = true;
  console.log(`Off-screen delivered Turn: seed and delivery phases passed in two processes. Original output: ${gate}`);
} catch (error) {
  writeFileSync(log, `${error instanceof Error ? error.stack : String(error)}\n`);
  console.error(`${error instanceof Error ? error.message : error}\nOriginal output: ${gate}`);
  process.exitCode = 1;
} finally {
  closeSync(log);
  if (profile && passed) rmSync(profile, { recursive: true, force: true });
  else if (profile) console.error(`Retained failed profile: ${profile}`);
}
