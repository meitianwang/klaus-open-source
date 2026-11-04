#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawnElectronGuiSync } = require('../../../scripts/electron-test-preflight.cjs');

const [executableArgument, directoryArgument, ...extra] = process.argv.slice(2);
if (!executableArgument || !directoryArgument || extra.length) {
  console.error('usage: run-probe.sh <electron-binary> <temporary-directory>');
  process.exit(2);
}

const executable = path.resolve(executableArgument);
const directory = path.resolve(directoryArgument);
if (fs.existsSync(directory)) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(directory).length) {
    console.error('error: probe directory must be empty and must not be a symbolic link');
    process.exit(2);
  }
}
fs.accessSync(executable, fs.constants.X_OK);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

// Local State is opened before the ProfileManager is created. Isolate both
// application storage and the native Profile, rather than only the latter.
const output = path.join(directory, 'probe.json');
const applicationData = path.join(directory, 'user-data');
const profileData = path.join(applicationData, 'native-browser');
const result = spawnElectronGuiSync(executable, [
  path.join(__dirname, 'probe-app.cjs'),
  '--native-profile-probe',
  '--use-mock-keychain',
  `--user-data-dir=${applicationData}`,
  `--native-profile-probe-data-dir=${profileData}`,
  `--native-profile-probe-output=${output}`,
], {
  cwd: path.resolve(__dirname, '../../..'),
  stdio: 'inherit',
  timeout: 120_000,
});
if (result.error || result.status !== 0) {
  console.error(`Native profile probe failed: ${result.error?.message ?? result.signal ?? result.status}`);
  process.exit(1);
}
const verification = spawnSync(process.env.PYTHON || 'python3', [
  path.join(__dirname, 'verify-probe.py'),
  output,
], { stdio: 'inherit' });
if (verification.error) {
  console.error(verification.error.message);
}
process.exit(verification.status ?? 1);
