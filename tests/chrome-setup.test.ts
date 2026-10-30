import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ChromeSetup, repairParkedWindowsLauncher, type ChromeSetupOptions } from '../main/browser/chrome-setup';
import { object, type BrowserObject } from '../main/browser/types';
import { assert, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness();
const root = mkdtempSync(join(__dirname, 'chrome-setup-profile-'));
const first = join(root, "First user's profile"); const second = join(root, 'Second profile');
mkdirSync(first); mkdirSync(second);
const extensionRoot = resolve(__dirname, '../../resources/plugins-builtin/browser/chrome-extension');
// The pinned identity is a release artifact (the CRX signing key decides it), so
// the gate derives it instead of hard-coding an id that a key rotation changes.
const EXTENSION_ID = JSON.parse(readFileSync(join(extensionRoot, 'extension-id.json'), 'utf8')).extensionId;
const options: ChromeSetupOptions = {
  configRoot: join(root, "Klaus user's config"), extensionRoot,
  browserDataRoots: [first, second], browserExecutable: process.execPath, executable: process.execPath,
  discoveryDirectory: join(first, 'nonexistent-relays'), enabled: () => true, registerWindowsHost: async () => {},
};
const setup = new ChromeSetup(options);

h.test('diagnostics are read-only and do not pretend an absent extension is connected', async () => {
  const state = object((await setup.diagnostics()).diagnostics);
  assertEqual(state.ok, false, 'not ready'); assertEqual(state.runtimeReachable, false, 'no live runtime');
  assertEqual(state.extensionInstalled, false, 'no extension preferences or host');
  assertEqual(state.nativeHostCorrect, false, 'no current native host');
  assert(!existsSync(options.configRoot), 'diagnostics did not create config directory');
  assert(!existsSync(join(first, 'NativeMessagingHosts')), 'diagnostics did not create browser registrations');
});

// Chrome omits `state` from an extension record it considers normal, and macOS
// refuses to read another application's profile at all. Neither is evidence, so
// both must be reported as unknown rather than as "not installed" or "disabled".
function profileRoot(name: string, record: Record<string, unknown> | null, opts: { file?: string; mode?: number } = {}): string {
  const profile = join(root, name, 'Default');
  mkdirSync(profile, { recursive: true });
  const file = opts.file ?? 'Secure Preferences';
  const body = record === null ? { extensions: { settings: {} } } : { extensions: { settings: { [EXTENSION_ID]: record } } };
  writeFileSync(join(profile, file), JSON.stringify(body));
  if (opts.mode !== undefined) chmodSync(join(profile, file), opts.mode);
  return join(root, name);
}

const diagnosticsFor = async (dataRoot: string): Promise<BrowserObject> => {
  const scoped = new ChromeSetup({ ...options, browserDataRoots: [dataRoot] });
  // Register the native host in this profile root first: the problem chain
  // reports an invalid host before it ever looks at extension state, so without
  // this the extension assertions would never be reached.
  const installed = await scoped.install();
  assertEqual(installed.ok, true, 'fixture native host registered');
  return object(object(await scoped.diagnostics()).diagnostics);
};

h.test('an extension record without an explicit state is not reported as disabled', async () => {
  const state = await diagnosticsFor(profileRoot('no-state', { path: '/somewhere/extension', location: 4 }));
  assertEqual(state.extensionInstalled, true, 'the record proves installation');
  assertEqual(state.extensionEnabled, false, 'enablement is not claimed from an absent state');
  assertEqual(state.extensionEnablementUnknown, true, 'enablement is reported as unknown');
  assertEqual(state.problem, 'runtime_unreachable', 'the actionable problem is the runtime, not the toggle');
});

h.test('an explicit disabled state still reports a disabled extension', async () => {
  const state = await diagnosticsFor(profileRoot('explicitly-disabled', { path: '/somewhere/extension', location: 4, state: 0 }));
  assertEqual(state.extensionInstalled, true, 'installed');
  assertEqual(state.extensionEnabled, false, 'disabled');
  assertEqual(state.extensionEnablementUnknown, false, 'enablement is known here');
  assertEqual(state.problem, 'extension_disabled', 'an explicit zero state is a disabled extension');
});

h.test('a populated disable reason also reports a disabled extension', async () => {
  const state = await diagnosticsFor(profileRoot('reasons', { path: '/somewhere/extension', location: 1, disable_reasons: [8] }));
  assertEqual(state.problem, 'extension_disabled', 'a non-empty reason list is definitive');
});

h.test('an explicitly enabled record reports an enabled extension', async () => {
  const state = await diagnosticsFor(profileRoot('enabled', { path: '/somewhere/extension', location: 4, state: 1, manifest: { version: '0.1.0' } }));
  assertEqual(state.extensionEnabled, true, 'enabled');
  assertEqual(state.extensionEnablementUnknown, false, 'enablement is known');
  assertEqual(state.problem, 'runtime_unreachable', 'only the runtime is missing');
  assertEqual(JSON.stringify(state.extensionVersions), JSON.stringify(['0.1.0']), 'version comes from the record');
});

h.test('a profile that cannot be read reports unknown instead of not installed', async () => {
  // 0o000 on the preference file reproduces the macOS application-data
  // protection that refuses the read with EPERM even for the signed app.
  const dataRoot = profileRoot('unreadable', { path: '/somewhere/extension', location: 4 }, { mode: 0o000 });
  let state: BrowserObject;
  try { state = await diagnosticsFor(dataRoot); }
  finally { chmodSync(join(dataRoot, 'Default', 'Secure Preferences'), 0o600); }
  assertEqual(state.extensionInstalled, false, 'a refused read cannot prove installation');
  assertEqual(state.extensionInstallStateUnknown, true, 'but it is reported as unconfirmed, not absent');
  assertEqual(state.problem, 'extension_state_unknown', 'no instruction to install a second copy');
});

h.test('a missing profile is still reported as an absent extension', async () => {
  const empty = join(root, 'no-profile-at-all'); mkdirSync(empty, { recursive: true });
  const state = await diagnosticsFor(empty);
  assertEqual(state.extensionInstalled, false, 'not installed');
  assertEqual(state.extensionInstallStateUnknown, false, 'absence is definitive when nothing refused a read');
  assertEqual(state.problem, 'extension_not_installed', 'installation is the actionable step');
});

h.test('installation registers the current compiled host only in explicit browser roots', async () => {
  const result = await setup.install(); assertEqual(result.ok, true, 'installation succeeds');
  const paths = Array.isArray(result.manifestPaths) ? result.manifestPaths.map(String) : [];
  assertEqual(paths.length, process.platform === 'win32' ? 1 : 2, 'all installed browser roots registered');
  for (const path of paths) {
    assert(path.startsWith(root), 'manifest stayed inside fixture');
    const manifest = object(JSON.parse(readFileSync(path, 'utf8')));
    assertEqual(manifest.name, 'com.klaus.chromeextension', 'exact native host name');
    assertEqual(manifest.type, 'stdio', 'Chrome native messaging protocol');
    assertEqual(JSON.stringify(manifest.allowed_origins), JSON.stringify([`chrome-extension://${EXTENSION_ID}/`]), 'only bundled extension origin');
  }
  const body = readFileSync(String(result.hostPath), 'utf8');
  assert(body.includes('ELECTRON_RUN_AS_NODE=1'), 'isolated Node entry, no engine or app boot');
  assert(body.includes('chrome-native-host.js'), 'compiled entry is used');
  if (process.platform !== 'win32') assert(body.includes("'\\''"), 'apostrophes in paths are safely quoted');
  const state = object((await setup.diagnostics()).diagnostics); assertEqual(state.nativeHostCorrect, true, 'installed launcher recognized');
  assertEqual(state.problem, 'extension_not_installed', 'native installation does not claim extension installation');
});

h.test('stale or foreign native launchers are reported and repaired deliberately', async () => {
  const installed = await setup.install(); const host = String(installed.hostPath);
  writeFileSync(host, '#!/bin/sh\nexit 0\n'); if (process.platform !== 'win32') chmodSync(host, 0o755);
  assertEqual(object((await setup.diagnostics()).diagnostics).nativeHostCorrect, false, 'foreign body is not current Klaus host');
  await setup.install();
  assertEqual(object((await setup.diagnostics()).diagnostics).nativeHostCorrect, true, 'explicit repair restores current host');
});

h.test('disabled Chrome settings refuse mutations and window actions before touching disk', async () => {
  const config = join(root, 'disabled'); let opened = 0;
  const disabled = new ChromeSetup({ ...options, configRoot: config, enabled: () => false, openBrowser: async () => { opened += 1; } });
  for (const action of ['chrome-install-native-host', 'chrome-setup', 'chrome-open-window', 'chrome-open-extension-manager']) await assertRejects(() => disabled.action(action), `${action} refuses disabled Chrome`);
  assert(!existsSync(config), 'disabled operations wrote nothing'); assertEqual(opened, 0, 'disabled operations opened nothing');
});

h.test('setup opens the extension manager and reports the remaining manual installation step', async () => {
  const opened: string[] = []; const shown: string[] = [];
  const manual = new ChromeSetup({ ...options, openBrowser: async url => { opened.push(url); }, showExtensionFolder: path => { shown.push(path); } });
  const result = await manual.action('chrome-setup');
  assertEqual(object(result.diagnostics).runtimeReachable, false, 'still disconnected'); assertEqual(result.manualAction, 'load_extension', 'manual step explicit');
  assertEqual(opened[0], `chrome://extensions/?id=${EXTENSION_ID}`, 'only exact extension manager URL opened');
  const webstore = await manual.action('chrome-open-webstore');
  assertEqual(webstore.manualAction, 'load_extension', 'unpublished extension is not a fake one-click web store install');
});

h.test('the manual install copy lands in a stable user-owned directory, not the app bundle', async () => {
  const shown: string[] = [];
  const manual = new ChromeSetup({ ...options, openBrowser: async () => {}, showExtensionFolder: path => { shown.push(path); } });
  const deployed = await manual.action('chrome-deploy-extension');
  assertEqual(deployed.ok, true, 'deploy succeeds');
  const target = String(deployed.extensionPath);
  assert(target.startsWith(options.configRoot), 'copy stays inside the config root');
  assert(!target.startsWith(options.extensionRoot), 'copy is not the bundle itself');
  assert(existsSync(join(target, 'manifest.json')), 'copied tree carries the manifest');
  assert(existsSync(join(target, 'extension-id.json')), 'copied tree carries the identity');
  // Re-deploying replaces the tree instead of merging a stale one into it.
  writeFileSync(join(target, 'stale.txt'), 'leftover');
  await manual.action('chrome-deploy-extension');
  assert(!existsSync(join(target, 'stale.txt')), 'redeploy drops stale files');
  // Opening the manager no longer reveals anything on its own; reveal is explicit.
  await manual.action('chrome-open-extension-manager');
  assertEqual(shown.length, 0, 'opening the manager has no file-manager side effect');
  const revealed = await manual.action('chrome-reveal-extension');
  assertEqual(revealed.ok, true, 'reveal succeeds once deployed');
  assertEqual(shown[0], target, 'reveal shows the deployed copy, not the bundle');
});

h.test('deploy and reveal work before external Chrome is enabled; reveal refuses an absent copy', async () => {
  const fresh = join(root, 'not-enabled-yet');
  const gated = new ChromeSetup({ ...options, configRoot: fresh, enabled: () => false });
  const deployed = await gated.action('chrome-deploy-extension');
  assertEqual(deployed.ok, true, 'deploy is a local copy, allowed before enable');
  await assertRejects(() => new ChromeSetup({ ...options, configRoot: join(root, 'never-deployed'), enabled: () => false }).action('chrome-reveal-extension'), 'reveal without a copy fails');
  for (const action of ['chrome-install-native-host', 'chrome-open-extension-manager']) await assertRejects(() => gated.action(action), `${action} still refuses disabled Chrome`);
});

h.test('policy state reads the machine managed preferences without touching them', async () => {
  const plistRoot = join(root, 'managed-prefs', 'com.google.Chrome');
  mkdirSync(dirname(plistRoot), { recursive: true });
  const scoped = new ChromeSetup({ ...options, managedPreferencesPath: plistRoot });
  let state = await scoped.policyState();
  assertEqual(state.installed, false, 'no plist means no policy of ours');
  writeFileSync(`${plistRoot}.plist`, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ExtensionInstallForcelist</key><array><string>${EXTENSION_ID}=https://example.com/update_manifest.xml</string><string>othervendor=https://other.example/m.xml</string></array></dict></plist>\n`);
  state = await scoped.policyState();
  assertEqual(state.installed, true, 'our entry is recognized');
  assert(String(state.entry).startsWith(`${EXTENSION_ID}=`), 'the entry is ours');
});

h.test('policy install refuses an unreachable or mis-pointed update manifest before any system write', async () => {
  // The fixture machine may itself be MDM-enrolled; the probe keeps this test
  // on the manifest-validation branch it exists to cover.
  const notEnrolled = { policyEnrolledProbe: async () => false };
  const scoped = new ChromeSetup({ ...options, ...notEnrolled, managedPreferencesPath: join(root, 'managed-prefs-2', 'com.google.Chrome'), policyUpdateManifestUrl: 'http://127.0.0.1:1/nope.xml' });
  await assertRejects(() => scoped.action('chrome-policy-install'), 'unreachable manifest is refused');
  const server = (await import('node:http')).createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end("<gupdate><app appid='someothervendorid'/></gupdate>"); });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
  const port = (server.address() as { port: number }).port;
  const wrongId = new ChromeSetup({ ...options, ...notEnrolled, managedPreferencesPath: join(root, 'managed-prefs-3', 'com.google.Chrome'), policyUpdateManifestUrl: `http://127.0.0.1:${port}/update_manifest.xml` });
  await assertRejects(() => wrongId.action('chrome-policy-install'), 'a manifest naming another extension is refused');
  assert(!existsSync(join(root, 'managed-prefs-3')), 'nothing was written to system policy');
  server.close();
});

h.test('policy install refuses an MDM-enrolled machine before any system write', async () => {
  const enrolled = new ChromeSetup({ ...options, policyEnrolledProbe: async () => true, policyUpdateManifestUrl: 'https://klaus-ai.cn/ext/update_manifest.xml' });
  await assertRejects(() => enrolled.action('chrome-policy-install'), 'enrolled machines cannot take hand-placed policy');
});

h.test('policy support reflects platform, manifest and MDM enrollment', async () => {
  const noManifest = new ChromeSetup({ ...options });
  assertEqual((await noManifest.policySupport()).reason, 'no_manifest', 'no manifest means no policy path');
  const enrolled = new ChromeSetup({ ...options, policyUpdateManifestUrl: 'https://example.com/m.xml', policyEnrolledProbe: async () => true });
  const enrolledResult = await enrolled.policySupport();
  assertEqual(enrolledResult.supported, false, 'MDM enrollment kills the policy path');
  assertEqual(enrolledResult.reason, 'mdm_enrolled', 'the reason names enrollment');
  const free = new ChromeSetup({ ...options, policyUpdateManifestUrl: 'https://example.com/m.xml', policyEnrolledProbe: async () => false });
  assertEqual((await free.policySupport()).supported, true, 'an unenrolled mac with a manifest supports policy');
});

h.test('the effectiveness probe reports through the injected seam without waiting', async () => {
  const probe = new ChromeSetup({ ...options, policyEffectiveProbe: async () => true });
  assertEqual(await probe.policyEffective('/nonexistent.plist', 'x=y'), true, 'injected probe wins');
  let calls = 0;
  const counting = new ChromeSetup({ ...options, policyEffectiveProbe: async () => { calls += 1; return false; } });
  assertEqual(await counting.policyEffective('/nonexistent.plist', 'x=y', 0), false, 'inert reported');
  assertEqual(calls, 1, 'retries=0 takes a single read');
});

h.test('invalid bundled extension identity or missing compiled host prevents registration', async () => {
  const invalidRoot = join(root, 'invalid-extension'); mkdirSync(invalidRoot); writeFileSync(join(invalidRoot, 'extension-id.json'), JSON.stringify({ extensionId: 'wrong', extensionHostName: 'invalid/name' }));
  await assertRejects(() => new ChromeSetup({ ...options, extensionRoot: invalidRoot }).install(), 'manifest identity must be valid');
  const absent = join(root, 'missing-host-config');
  await assertRejects(() => new ChromeSetup({ ...options, configRoot: absent, hostScript: join(root, 'missing.js') }).install(), 'missing compiled host cannot be registered');
});

h.test('a launcher parked by an interrupted update is restored on the next start', async () => {
  const configRoot = join(root, 'parked-launcher-config');
  const hostDir = join(configRoot, 'chrome-native-host');
  mkdirSync(hostDir, { recursive: true });
  const body = '@echo off\r\nREM Klaus Electron Chrome native host v1\r\n';
  writeFileSync(join(hostDir, 'klaus-chrome-host.cmd.updating'), body);
  await repairParkedWindowsLauncher(configRoot);
  assertEqual(readFileSync(join(hostDir, 'klaus-chrome-host.cmd'), 'utf8'), body, 'the parked launcher is restored');
  assert(!existsSync(join(hostDir, 'klaus-chrome-host.cmd.updating')), 'the parked copy is gone');
  await repairParkedWindowsLauncher(configRoot);
  assertEqual(readFileSync(join(hostDir, 'klaus-chrome-host.cmd'), 'utf8'), body, 'repair is idempotent');
  // A live launcher is the newer deliberate write; the orphaned parked copy is
  // dropped rather than allowed to overwrite it with older bytes.
  writeFileSync(join(hostDir, 'klaus-chrome-host.cmd.updating'), 'stale');
  await repairParkedWindowsLauncher(configRoot);
  assertEqual(readFileSync(join(hostDir, 'klaus-chrome-host.cmd'), 'utf8'), body, 'an existing launcher is not overwritten');
  assert(!existsSync(join(hostDir, 'klaus-chrome-host.cmd.updating')), 'the orphaned parked copy is dropped');
  await repairParkedWindowsLauncher(join(root, 'no-launcher-config'));
  assert(!existsSync(join(root, 'no-launcher-config')), 'repair creates nothing where nothing was parked');
});

void h.finish(join(__dirname, 'chrome-setup-result.json'), 'chrome-setup').then(code => {
  rmSync(root, { recursive: true, force: true }); process.exit(code);
});
