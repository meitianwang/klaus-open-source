#!/usr/bin/env node
// Real-application check that every subscription model source renders in the
// settings Models page and in the composer's source menu.
//
// This drives the actual desktop runtime, the actual frontend bundle and the
// actual engine binary, so it catches what a component fixture cannot: a source
// that is wired through the host but never reaches a page, a card whose ids do
// not match the bridge, and a login button whose click does not come back with
// the engine's own authorization URL.
//
// Usage:
//   node apps/desktop/scripts/run-models-source-ui-test.mjs [--build-only]
//
// Builds the current development engine before launching, including local
// engine edits. The release driver retains its artifact identity checks.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { prepareTestEngine } from './prepare-test-engine.mjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = desktop;
const require = createRequire(join(desktop, 'package.json'));
const output = join(desktop, 'dist', 'models-source-ui-logs');
mkdirSync(output, { recursive: true });
const log = join(output, 'run.log');
writeFileSync(log, `COMMAND: node apps/desktop/scripts/run-models-source-ui-test.mjs${process.argv.includes('--build-only') ? ' --build-only' : ''}\n`);

// Direct script invocations must exercise current sources, not stale dist files.
// The frontend bundle is rebuilt too: the renderer loads from frontend-dist, so a
// stale bundle silently tests the PREVIOUS UI and reports a control that no
// longer exists rather than a build that never ran.
for (const args of [
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  ['scripts/build-preload.mjs'],
]) {
  const build = spawnSync(process.execPath, args, { cwd: desktop, stdio: 'inherit' });
  appendFileSync(log, `$ ${args.join(' ')}\nEXIT: ${build.status}\n`);
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const frontend = spawnSync(join(desktop, 'node_modules/.bin/vite'), ['build', '--config', 'vite.config.mts'], { cwd: desktop, stdio: 'inherit' });
appendFileSync(log, `$ vite build --config vite.config.mts\nEXIT: ${frontend.status}\n`);
if (frontend.error) throw frontend.error;
if (frontend.status !== 0) process.exit(frontend.status ?? 1);

if (process.argv.includes('--build-only')) {
  appendFileSync(log, 'Runtime and fixture compiled. No GUI and no engine were started.\nEXIT: 0\n');
  process.stdout.write('Runtime and fixture compiled. No GUI and no engine were started.\n');
  process.exit(0);
}

// Every GUI process is launched through the approved wrapper after native access
// preflight. No direct Electron spawn, sandbox marker removal or disabled sandbox.
const preflight = spawnSync(process.execPath, [join(desktop, 'scripts/electron-test-preflight.cjs')], { cwd: repo, encoding: 'utf8', timeout: 40000 });
appendFileSync(log, `$ node apps/desktop/scripts/electron-test-preflight.cjs\n${preflight.stdout || ''}${preflight.stderr || ''}\nEXIT: ${preflight.status}\n`);
if (preflight.error || preflight.status !== 0) throw preflight.error || new Error(preflight.stderr || 'Electron preflight refused; no GUI fixture was started');

// The real engine binary is required: a source's login start only answers with an
// authorization URL if the engine that owns that source is actually running.
prepareTestEngine(repo, { logFile: log });

const profile = mkdtempSync(join(output, 'profile-'));
const command = [join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'dist/tests/models-qoderwork-ui.js')];
appendFileSync(log, `COMMAND: ${JSON.stringify([process.execPath, ...command])}\nPROFILE: ${profile}\n`);
const child = spawn(process.execPath, command, { cwd: desktop, env: { ...process.env, KLAUS_MODELS_UI_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { appendFileSync(log, chunk); process.stdout.write(chunk); });
const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('close', resolveCode); });
clearTimeout(timer);
appendFileSync(log, `\nEXIT: ${code}\nPROFILE: ${profile}\n`);
process.stdout.write(`Screenshots and the harness report are in ${profile}\n`);
process.exitCode = code === 0 ? 0 : 1;
