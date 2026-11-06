// Runs the real Electron GUI process with an isolated profile and a synthetic
// unpacked MV3 extension. The child never reads a user profile or extension.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { assertElectronGuiAvailable, spawnElectronGui } = require('../../scripts/electron-test-preflight.cjs') as typeof import('../scripts/electron-test-preflight.cjs');

assertElectronGuiAvailable();
const executable = require('electron') as string;
const profile = mkdtempSync(join(tmpdir(), 'klaus-browser-extensions-electron-'));
const fixture = join(__dirname, '../../tests/fixtures/browser-extension-mv3');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  KLAUS_BROWSER_EXTENSIONS_PROFILE: profile,
  KLAUS_BROWSER_EXTENSIONS_FIXTURE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawnElectronGui(executable, [join(__dirname, 'browser-extensions-electron.fixture.js')], { env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
child.once('error', error => { process.stderr.write(`${String(error)}\n`); });
child.once('close', (code, signal) => {
  clearTimeout(timer);
  rmSync(profile, { recursive: true, force: true });
  if (signal) process.stderr.write(`Browser extension fixture terminated by ${signal}\n`);
  process.exit(code ?? 1);
});
