import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { prepareTestEngine } from './prepare-test-engine.mjs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assertElectronGuiAvailable();
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
// Direct script invocations must exercise current sources, not stale dist files.
for (const args of [[require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], ['scripts/build-preload.mjs']]) {
  const build = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}
prepareTestEngine(root);
const sshFixture = process.env.KLAUS_SSH_FIXTURE_BINARY || join(root, 'native/target/debug', process.platform === 'win32' ? 'klaus-ssh-fixture.exe' : 'klaus-ssh-fixture');
if (!existsSync(sshFixture)) throw new Error('Build the SSH test fixture with native/scripts/test-ssh.mjs, or set KLAUS_SSH_FIXTURE_BINARY to its compiled binary.');
const whatsappFixtures = process.env.KLAUS_WHATSAPP_FIXTURE_DIR || join(root, 'native/artifacts/whatsapp-fixtures');
for (const name of [`klaus-native-${process.platform}-${process.arch}.node`, process.platform === 'win32' ? 'klaus-whatsapp-fixture.exe' : 'klaus-whatsapp-fixture']) {
  if (!existsSync(join(whatsappFixtures, name)) || !existsSync(join(whatsappFixtures, name + '.json'))) throw new Error('Set KLAUS_WHATSAPP_FIXTURE_DIR to the identified synthetic WhatsApp addon and peer directory.');
}
const profile = mkdtempSync(join(tmpdir(), 'klaus-electron-app-'));
const diagramPlugin = join(root, 'tests/fixtures/official-plugins/digram');
if (!existsSync(join(diagramPlugin, 'plugin.json'))) throw new Error('The diagram integration fixture package is missing.');
writeFileSync(join(profile, 'config.toml'), `[plugins."digram@klaus-official"]\ninstallPath = ${JSON.stringify(diagramPlugin)}\nenabled = true\n`);
const env = { ...process.env, KLAUS_DESKTOP_FIXTURE_PROFILE: profile, KLAUS_SSH_FIXTURE_BINARY: sshFixture, KLAUS_WHATSAPP_FIXTURE_DIR: whatsappFixtures };
delete env.ELECTRON_RUN_AS_NODE;
let code = 1;
let completed = false;
let nativeFixture;
const resultFile = join(root, 'dist/tests/desktop-app-result.json');
rmSync(resultFile, { force: true });
try {
  if (process.platform === 'darwin') {
    // Keep compiled executables with build outputs. macOS can hold a new
    // executable in its temporary directory before its main function starts.
    const fixtures = join(root, 'dist', 'app-native-fixtures');
    mkdirSync(fixtures, { recursive: true });
    nativeFixture = mkdtempSync(join(fixtures, 'klaus-computer-use-electron-'));
    const synthetic = join(nativeFixture, 'Klaus Synthetic Target.app');
    const contents = join(synthetic, 'Contents');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.klaus.synthetic.engine-cu.${profile.split('-').at(-1)}</string>
<key>CFBundleName</key><string>Klaus Synthetic Target</string><key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string><key>KlausFixtureOutput</key><string>${escape(join(nativeFixture, 'target.plist'))}</string></dict></plist>`);
    const compile = spawnSync('xcrun', ['clang', '-O1', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-framework', 'AppKit',
      join(root, 'tests/computer-use-synthetic-app.m'), '-o', join(contents, 'MacOS', 'fixture')], { stdio: 'inherit' });
    if (compile.error) throw compile.error;
    if (compile.status !== 0) throw new Error('The isolated Computer Use target did not compile');
    env.KLAUS_COMPUTER_USE_SYNTHETIC_APP = synthetic;
  }
  const result = spawnElectronGuiSync(require('electron'), ['dist/tests/desktop-app.integration.js'], {
    cwd: root, env, stdio: 'inherit', timeout: 300_000,
  });
  if (result.error) throw result.error;
  code = result.status ?? 1;
  if (code === 0) {
    const report = JSON.parse(readFileSync(resultFile, 'utf8'));
    if (report.suite !== 'desktop-app' || report.failed !== 0 || !Array.isArray(report.results)
      || !report.results.some(row => row.name === 'the Agents page completes its isolated create, edit, use, search and delete lifecycle' && row.ok === true)
      || !report.results.some(row => row.name === 'closing the main window keeps the engine; shutdown closes both' && row.ok === true)
      || report.results.some(row => row.ok === false)
      || report.passed !== report.results.filter(row => row.ok === true).length) {
      throw new Error('The application exited without a complete successful integration report');
    }
    completed = true;
  }
} finally {
  // Chromium can still write profile data after BrowserWindows close. The
  // parent removes it only after the entire application process has exited.
  // A failure may retain a sandbox permission-recovery journal. Keep its owned
  // paths intact until rollback is confirmed instead of erasing that evidence.
  if (completed) {
    rmSync(profile, { recursive: true, force: true });
    if (nativeFixture) rmSync(nativeFixture, { recursive: true, force: true });
  } else {
    if (process.platform === 'win32' && process.env.KLAUS_ASUS_RUN_DIR) {
      writeFileSync(join(process.env.KLAUS_ASUS_RUN_DIR, 'cleanup-hold.json'), JSON.stringify({
        reason: 'Application fixture recovery has not been confirmed', profile, resultFile,
      }, null, 2) + '\n');
    }
    process.stderr.write(`Retained failed integration profile: ${profile}\n`);
    if (nativeFixture) process.stderr.write(`Retained native integration fixture: ${nativeFixture}\n`);
  }
}
process.exit(code);
