import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
if (process.platform !== 'darwin') throw new Error('The Computer Use native Electron fixture requires macOS');
assertElectronGuiAvailable();
const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL('..', import.meta.url));
// Compile native fixtures beside build outputs, not in the system temporary
// directory, where macOS can hold their execution before main starts.
const fixtures = join(desktop, 'dist', 'app-native-fixtures');
mkdirSync(fixtures, { recursive: true });
const root = mkdtempSync(join(fixtures, 'klaus-computer-use-electron-'));
const synthetic = join(root, 'Klaus Computer Use Native Fixture.app'), contents = join(synthetic, 'Contents');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.klaus.synthetic.computer-use.${root.split('-').at(-1)}</string><key>CFBundleName</key><string>Klaus CU Native Fixture</string>
<key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>KlausFixtureOutput</key><string>${escape(join(root, 'native-fixture.plist'))}</string></dict></plist>`);
execFileSync('xcrun', ['clang', '-O1', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-framework', 'AppKit', resolve(desktop, 'tests/computer-use-synthetic-app.m'), '-o', join(contents, 'MacOS', 'fixture')], { stdio: 'inherit' });
const env = { ...process.env, KLAUS_COMPUTER_USE_TEST_ROOT: root,
  KLAUS_COMPUTER_USE_SYNTHETIC_APP: synthetic,
  KLAUS_COMPUTER_USE_HELPER: process.env.KLAUS_COMPUTER_USE_HELPER ?? resolve(desktop, 'native/artifacts/computer-use', `darwin-${process.arch}`, 'klaus-computer-use-helper') };
delete env.ELECTRON_RUN_AS_NODE;
// A private installation prevents another development fixture with the same
// dependency path from becoming the target of application discovery.
const runtime = join(root, 'Klaus Computer Use Runtime Fixture.app');
const electron = require('electron');
execFileSync('/bin/cp', ['-cR', resolve(electron, '../../..'), runtime]);
execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier com.klaus.synthetic.computer-use.runtime.${root.split('-').at(-1)}`, join(runtime, 'Contents/Info.plist')]);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', runtime], { stdio: 'inherit' });
const result = spawnElectronGuiSync(join(runtime, 'Contents/MacOS/Electron'), ['tests/computer-use-electron.cjs', '-ApplePersistenceIgnoreState', 'YES'], { cwd: desktop, env, stdio: 'inherit', timeout: 440000 });
let complete = false;
try { const summary = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')); complete = summary.passed === 14 && summary.failed === 0 && summary.results.length === 14; } catch {}
if (result.status === 0 && complete) rmSync(root, { recursive: true, force: true }); else console.error(`Synthetic Computer Use evidence: ${root}`);
if (result.error) throw result.error; process.exit(result.status === 0 && complete ? 0 : 1);
