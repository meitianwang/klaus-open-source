#!/usr/bin/env node

/**
 * Build the standalone macOS browser-import decryption helper.
 *
 * Production and test binaries are separate compilations:
 *   production -> Security.framework Keychain path
 *   test       -> fixture key read from KLAUS_BROWSER_IMPORT_TEST_KEY
 *
 * The signing identity is supplied by the packaging environment. No identity,
 * account, or machine-specific path is stored in this repository.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    'usage: build-macos-helper.mjs --mode production|test --arch arm64|x64 --output <path> '
    + '[--identity <codesign identity>] [--entitlements <path>]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--mode') result.mode = argv[++index];
    else if (name === '--arch') result.arch = argv[++index];
    else if (name === '--output') result.output = argv[++index];
    else if (name === '--identity') result.identity = argv[++index];
    else if (name === '--entitlements') result.entitlements = argv[++index];
    else usage(`unknown argument: ${name}`);
  }
  if (result.mode !== 'production' && result.mode !== 'test') usage('mode is required');
  if (!result.output) usage('output is required');
  if (result.arch !== 'arm64' && result.arch !== 'x64') usage('arch is required');
  return result;
}

const options = parseArgs(process.argv.slice(2));
if (process.platform !== 'darwin') {
  process.stderr.write('This helper builds only on macOS.\n');
  process.exit(1);
}

const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true });
const sources = [
  resolve(here, 'main.mm'),
  resolve(here, 'browser_import_crypto.mm'),
];
const args = [
  '-std=c++17',
  '-fobjc-arc',
  '-O2',
  '-arch', options.arch,
  '-Wall',
  '-Wextra',
  '-framework', 'Foundation',
  ...sources,
  '-o', output,
];
if (options.mode === 'production') {
  args.push('-DKLAUS_BROWSER_IMPORT_PRODUCTION=1', '-framework', 'Security', '-framework', 'LocalAuthentication');
} else {
  args.push('-DKLAUS_BROWSER_IMPORT_TEST=1');
}

const compile = spawnSync('clang++', args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, LC_ALL: 'C' },
});
if (compile.error) {
  process.stderr.write(`clang++ failed: ${compile.error.message}\n`);
  process.exit(1);
}
if (compile.status !== 0) process.exit(compile.status ?? 1);

if (options.mode === 'production' && options.identity) {
  const signArgs = ['--force', '--options', 'runtime', '--sign', options.identity];
  if (options.entitlements) signArgs.push('--entitlements', resolve(options.entitlements));
  signArgs.push(output);
  const sign = spawnSync('codesign', signArgs, { stdio: 'inherit' });
  if (sign.error) {
    process.stderr.write(`codesign failed: ${sign.error.message}\n`);
    process.exit(1);
  }
  if (sign.status !== 0) process.exit(sign.status ?? 1);
  process.stdout.write(`built and signed ${output}\n`);
} else {
  process.stdout.write(`built ${output} (unsigned)\n`);
}
