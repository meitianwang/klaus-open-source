import { spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'darwin') throw new Error('The App UI integration test requires macOS');
const artifacts = join(desktop, 'native', 'artifacts'); mkdirSync(artifacts, { recursive: true });
const directory = mkdtempSync(join(artifacts, 'app-ui-electron-fixture-'));
const name = 'KlausAppUi' + directory.slice(-6), bundle = join(directory, name + '.app'), executable = join(bundle, 'Contents', 'MacOS', name);
try {
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleIdentifier</key><string>com.klaus.fixture.app-ui.${name}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string><key>KlausFixtureOutput</key><string>${escape(join(directory, 'target-state.json'))}</string></dict></plist>`);
  const build = spawnSync('/usr/bin/clang', ['-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-framework', 'AppKit', '-framework', 'QuartzCore', join(desktop, 'tests', 'app-ui-synthetic-app.m'), '-o', executable], { stdio: 'inherit', timeout: 30_000 });
  if (build.error) throw build.error; if (build.status !== 0) throw new Error('The owned native App UI fixture failed to compile');
  const env = { ...process.env, KLAUS_APP_UI_FIXTURE_ROOT: directory, KLAUS_APP_UI_FIXTURE_APP: bundle, KLAUS_APP_UI_FIXTURE_NAME: name }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnElectronGuiSync(require('electron'), ['tests/macos-app-ui-electron.cjs'], { cwd: desktop, env, stdio: 'inherit', timeout: 100_000 });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
} finally {
  const pattern = executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const probe = spawnSync('/usr/bin/pgrep', ['-f', '^' + pattern + '( |$)'], { encoding: 'utf8', timeout: 5000 });
  if (probe.error) throw probe.error;
  for (const value of probe.stdout.trim().split(/\s+/).filter(Boolean)) {
    const pid = Number(value); if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid owned fixture process identifier');
    const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    if (alive()) process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40 && alive(); i++) pause();
    if (alive()) process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 40 && alive(); i++) pause();
    if (alive()) throw new Error('The owned native fixture process has not exited');
  }
  rmSync(directory, { recursive: true, force: true });
  if (existsSync(directory)) throw new Error('The owned App UI fixture directory still exists');
  console.log('owned_app_ui_fixture_cleanup=removed_after_process_exit');
}
