const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

let cachedProbe;

function probeExecutable() {
  const source = join(__dirname, '../native/tests/electron-gui-preflight.c');
  if (cachedProbe && existsSync(cachedProbe)) return cachedProbe;
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const directory = mkdtempSync(join(tmpdir(), `klaus-gui-preflight-${process.arch}-${digest}-`));
  const executable = join(directory, 'gui-access-probe');
  try {
    const result = spawnSync('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable], {
      encoding: 'utf8', maxBuffer: 8192, timeout: 30_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Cannot build the macOS GUI access probe: ${result.error?.message ?? result.stderr ?? result.signal}`);
    }
    for (const args of [
      ['--force', '--sign', '-', '--timestamp=none', '--identifier', 'com.klaus.test.gui-access-probe.atomic', executable],
      ['--verify', '--strict', executable],
    ]) {
      const signed = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8', maxBuffer: 8192, timeout: 30_000 });
      if (signed.error || signed.status !== 0) {
        throw new Error(`Cannot sign the macOS GUI access probe: ${signed.error?.message ?? signed.stderr ?? signed.signal}`);
      }
    }
    cachedProbe = executable;
    return executable;
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

function assertElectronGuiAvailable() {
  if (process.platform !== 'darwin') return;
  const result = spawnSync(probeExecutable(), [], { encoding: 'utf8', maxBuffer: 8192, timeout: 30_000 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? result.signal;
    const error = new Error(`Electron GUI test was not started. ${detail || 'macOS GUI access could not be verified'}. ` +
      'Run this command outside the restricted command sandbox (request an approved escalated run in Codex). ' +
      'Do not retry the raw Electron binary or disable Chromium renderer sandboxing.');
    error.code = 'KLAUS_ELECTRON_GUI_UNAVAILABLE';
    throw error;
  }
}

function spawnElectronGui(executable, args, options) {
  assertElectronGuiAvailable();
  return spawn(executable, args, options);
}

function spawnElectronGuiSync(executable, args, options) {
  assertElectronGuiAvailable();
  return spawnSync(executable, args, options);
}

module.exports = { assertElectronGuiAvailable, spawnElectronGui, spawnElectronGuiSync };

if (require.main === module) {
  try {
    assertElectronGuiAvailable();
    console.log('Electron GUI test preflight passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
