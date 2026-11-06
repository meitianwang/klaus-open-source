import { spawnElectronGui } from './electron-test-preflight.cjs';
import { devLaunchEnvironment, describeEarlyExit, ensureProfileDirectory, resolveDevProfile } from './dev-profile.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
const repo = appDirectory;
const positional = [];
const flags = [];
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--profile=')) positional.push({ profile: argument.slice('--profile='.length) });
  else flags.push(argument);
}
if (positional.length > 1) throw new Error('Pass --profile at most once');
const profileOverride = positional.at(0)?.profile;
const options = new Set(flags);
const allowed = new Set(['--help', '-h', '--no-install', '--reuse-engine', '--reuse-native', '--watch', '--prepare-only', '--shared-profile']);
for (const option of options) if (!allowed.has(option)) throw new Error(`Unknown development option: ${option}`);
if (options.has('--help') || options.has('-h')) {
  console.log(`Usage: ./dev.sh [options] (Windows: dev.bat)

Build and launch the Electron desktop client with its single Rust engine.
The launch uses its own data profile (~/.klaus-dev-preview) so it can run
alongside the installed Klaus application.
  --no-install      Require existing npm dependencies
  --reuse-engine    Verify the staged engine instead of building it
  --reuse-native    Verify existing native artifacts instead of building them
  --watch           Rebuild and reload frontend changes; restart for host changes
  --prepare-only    Prepare all resources without launching the app
  --profile=PATH    Use an absolute directory as the development profile
  --shared-profile  Run on the installed app's profile; quit the app first
  --help            Show this help

KLAUS_DESKTOP_EDITION selects the edition (default domestic). Editions beyond the
public ones are read from the absolute path in KLAUS_DESKTOP_EDITIONS_FILE.

Ctrl+C requests normal app shutdown, including engine and native cleanup.`);
  process.exit(0);
}

function run(args, cwd = appDirectory) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.signal) console.error(`Development preparation stopped by ${result.signal}`);
    process.exit(result.status ?? 1);
  }
}

const require = createRequire(import.meta.url);
if (!existsSync(join(appDirectory, 'node_modules/electron/package.json')) || !existsSync(join(appDirectory, 'node_modules/vite/package.json'))) {
  if (options.has('--no-install')) throw new Error('Install desktop dependencies with npm ci in the desktop directory.');
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Start through ./dev.sh, dev.bat, or npm run dev to install dependencies.');
  run([npm, 'ci']);
}
// npm may leave an Electron package without its downloaded runtime when install scripts were disabled.
try { require('electron'); }
catch (error) {
  if (options.has('--no-install')) throw error;
  run([require.resolve('electron/install.js')]);
}

run([join(repo, 'engine/scripts/prepare-rust-release.mjs'), '--dev', ...(options.has('--reuse-engine') ? ['--verify-only'] : [])]);
const { requireTarget, validateNative, validateSpeech, validateRecording, validatePip, validateComputerUse } = await import('../packaging/resources.mjs');
const { ensureBrowserImportHelper } = await import('../packaging/browser-import.mjs');
requireTarget(process.platform, process.arch);
const target = `${process.platform}-${process.arch}`;
const nativeRoot = join(appDirectory, 'native');
const nativeDirectory = join(nativeRoot, 'artifacts');
const helperDirectory = kind => join(repo, 'resources', kind, target);
const validation = { platform: process.platform, arch: process.arch };
if (options.has('--reuse-native')) {
  validateNative(nativeDirectory, nativeRoot, validation);
  if (process.platform === 'darwin') {
    validateSpeech(helperDirectory('speech'), { ...validation, sourceRoot: join(nativeRoot, 'speech') });
    validateRecording(helperDirectory('recording'), { ...validation, sourceRoot: join(nativeRoot, 'recording') });
    validatePip(helperDirectory('pip'), { ...validation, sourceRoot: join(nativeRoot, 'pip') });
  }
  validateComputerUse(helperDirectory('computer-use'), { ...validation, sourceRoot: join(nativeRoot, 'computer-use') });
  console.log('Verified existing native artifacts against this checkout.');
} else {
  run(['native/scripts/build.mjs']);
  if (process.platform === 'darwin') for (const kind of ['speech', 'recording', 'pip']) run([`native/${kind}/build.mjs`, helperDirectory(kind)]);
  run([`native/computer-use/${process.platform === 'win32' ? 'build-windows.mjs' : 'build.mjs'}`, helperDirectory('computer-use')]);
}
const browserImport = ensureBrowserImportHelper({ repo, platform: process.platform, arch: process.arch });
if (browserImport.supported) console.log(`[dev] browser import helper: ${browserImport.helperPath}`);

run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.native-bindings.json']);
run(['scripts/build-preload.mjs']);
run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.canvas-sdk.json']);
const vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
run([vite, 'build', '--config', 'vite.config.mts']);
if (options.has('--prepare-only')) process.exit(0);

const plan = resolveDevProfile({
  sharedProfile: options.has('--shared-profile'),
  profileOverride,
  env: process.env,
  defaultHome: userInfo().homedir,
});
if (plan.isolated) {
  // The host refuses to start on a profile directory that does not exist yet.
  ensureProfileDirectory(plan.configRoot);
  console.log(`[dev] data profile: ${plan.configRoot} (instance identity ${plan.identity})`);
  if (existsSync(join(plan.configRoot, 'klaus-auth.json'))) console.log('[dev] this profile is signed in.');
  else console.log('[dev] this profile has no account yet: sign in once here and it is remembered.');
}
const env = devLaunchEnvironment({ base: process.env, plan });
const child = spawnElectronGui(require('electron'), ['.'], { cwd: appDirectory, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
let stopping = false, ready = false, windowNeverOpened = false, watcher, watcherDone = Promise.resolve(), watchFailed = false;
const requestQuit = () => {
  if (stopping) return;
  stopping = true;
  if (child.connected) child.send({ type: 'klaus:dev:quit' }, () => {});
};
process.on('SIGINT', requestQuit);
process.on('SIGTERM', requestQuit);
child.on('message', message => {
  if (message?.type === 'klaus:dev:ready') {
    ready = true;
    console.log('Klaus is ready. Ctrl+C closes the app and its owned resources.');
  }
});
const childDone = new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) console.error(`Electron terminated by ${signal}`);
    // A launch that never reported readiness is the failure that used to be silent: the
    // installed app owns the profile, activation is forwarded to it, and the exit code is 0.
    // `stopping` means the operator asked for this shutdown, so it is not a failure.
    if (!ready && !stopping) {
      const diagnosis = describeEarlyExit({ exitCode: code, signal, configRoot: plan.configRoot, isolated: plan.isolated });
      console.error(`\n[dev] the window never opened. ${diagnosis.occupied ? 'Reason:' : 'Details:'}`);
      for (const line of diagnosis.lines) console.error(`[dev] ${line}`);
      windowNeverOpened = true;
    }
    resolveExit(windowNeverOpened ? 1 : (code ?? 1));
  });
});
if (options.has('--watch')) {
  watcher = spawn(process.execPath, [vite, 'build', '--watch', '--config', 'vite.config.mts'], { cwd: appDirectory, stdio: ['ignore', 'pipe', 'inherit'] });
  let pending = '';
  watcher.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (/built in \d/.test(line) && !stopping && child.connected) child.send({ type: 'klaus:dev:reload' }, () => {});
  });
  watcherDone = new Promise(resolveExit => {
    watcher.once('error', error => { console.error(error); watchFailed = true; requestQuit(); resolveExit(); });
    watcher.once('exit', code => {
      if (!stopping) { watchFailed = true; console.error(`Frontend watcher exited with ${code}`); requestQuit(); }
      resolveExit();
    });
  });
}
let code = 1;
try { code = await childDone; }
finally {
  stopping = true;
  watcher?.kill('SIGTERM');
  await watcherDone;
  process.removeListener('SIGINT', requestQuit);
  process.removeListener('SIGTERM', requestQuit);
}
process.exitCode = watchFailed || windowNeverOpened ? 1 : code;
