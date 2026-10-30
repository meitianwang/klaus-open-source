// The ordinary test runner runs in Electron's Node mode. This child runs the
// actual GUI process, using an isolated profile that is removed only after exit.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const { assertElectronGuiAvailable, spawnElectronGui } = require('../../scripts/electron-test-preflight.cjs') as typeof import('../scripts/electron-test-preflight.cjs');

assertElectronGuiAvailable();
const executable = require('electron') as string;
const profile = mkdtempSync(join(__dirname, 'browser-fixture-profile-'));
const env: NodeJS.ProcessEnv = { ...process.env, KLAUS_BROWSER_FIXTURE_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawnElectronGui(executable, [join(__dirname, 'browser-fixture.js')], { env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
child.once('error', error => { process.stderr.write(`${String(error)}\n`); });
child.once('close', (code, signal) => {
  clearTimeout(timer);
  rmSync(profile, { recursive: true, force: true });
  if (signal) process.stderr.write(`Browser fixture terminated by ${signal}\n`);
  process.exit(code ?? 1);
});
