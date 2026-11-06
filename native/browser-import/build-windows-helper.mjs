#!/usr/bin/env node

/**
 * Build the standalone Windows browser-import decryption helper.
 *
 * The helper is an optional import-time artifact. It is not part of the
 * application startup path and must be built on Windows so DPAPI resolves
 * against the current user.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, 'windows');

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('usage: build-windows-helper.mjs --output <path>\n');
  process.exit(2);
}

let output;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--output') output = args[++index];
  else usage(`unknown argument: ${args[index]}`);
}
if (!output) usage('output is required');
if (process.platform !== 'win32') {
  process.stderr.write('This helper builds only on Windows.\n');
  process.exit(1);
}

const build = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', resolve(project, 'Cargo.toml'), '--target-dir', resolve(project, 'target')],
  { cwd: project, stdio: 'inherit' },
);
if (build.error) {
  process.stderr.write(`cargo failed: ${build.error.message}\n`);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const destination = resolve(output);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(resolve(project, 'target/release/klaus-browser-import-windows.exe'), destination);
process.stdout.write(`built ${destination}\n`);
