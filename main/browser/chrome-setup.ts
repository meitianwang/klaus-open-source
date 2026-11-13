import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserError, message, object, type BrowserObject } from './types';
import { discoverChrome } from './chrome-relay';

/** Written into the deployed extension copy so stale installs are detectable. */
const BUILD_MARKER_FILE = 'klaus-build.json';

const exec = promisify(execFile);
const MARKER = 'Klaus Electron Chrome native host v1';
const MAC_SUPPORT = ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Google/Chrome for Testing', 'Google/ChromeForTesting', 'Chromium', 'Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'BraveSoftware/Brave-Browser', 'com.operasoftware.Opera', 'Vivaldi'];
const WINDOWS_KEYS = ['Software\\Google\\Chrome', 'Software\\Microsoft\\Edge', 'Software\\BraveSoftware\\Brave-Browser', 'Software\\Chromium'];

/**
 * The manual step the setup dialog should ask for, derived from diagnostics.
 *
 * Enablement is only actionable when it is known: Chrome leaves `state` out of
 * a normal extension's record, so "no explicit state" must not be read as
 * "disabled" and must not send the user to an enable toggle that is already on.
 */
function setupManualAction(state: BrowserObject): string {
  if (state.extensionInstalled !== true) return 'load_extension';
  if (state.extensionEnabled === true || state.extensionEnablementUnknown === true) return 'reload_extension';
  return 'enable_extension';
}

export interface ChromeSetupOptions {
  configRoot: string;
  extensionRoot: string;
  enabled: () => boolean;
  discoveryDirectory?: string;
  executable?: string;
  hostScript?: string;
  /** Explicit paths let fixtures install only inside their isolated profile. */
  browserDataRoots?: string[];
  browserExecutable?: string;
  openBrowser?: (url: string) => Promise<void>;
  showExtensionFolder?: (path: string) => void;
  /** Where the bundled extension is copied for manual "load unpacked" installs. */
  deployRoot?: string;
  /** Build id stamped into the deployed copy so stale installs are detectable. */
  buildStamp?: string;
  /** HTTPS update manifest the managed-policy install points Chrome at. */
  policyUpdateManifestUrl?: string;
  /** Test seam: the Chrome policy plist path without the .plist suffix. */
  managedPreferencesPath?: string;
  /** Test seam: override the "does the merged preferences view see it" probe. */
  policyEffectiveProbe?: (plistPath: string, entry: string) => Promise<boolean>;
  /** Test seam: override the MDM-enrollment read used by policySupport(). */
  policyEnrolledProbe?: () => Promise<boolean>;
  registerWindowsHost?: (key: string, manifest: string) => Promise<void>;
}

/**
 * Restore a native host launcher that an application update parked.
 *
 * The Windows installer moves the launcher aside while it replaces application
 * files, because the extension respawns its host a few seconds after every
 * kill and would otherwise keep those files locked. A cancelled or failed run
 * leaves the parked copy behind, and the next application start is the only
 * guaranteed chance to put it back. When a launcher already exists, the parked
 * copy is an orphan from an older run and is dropped instead: the live file is
 * the newer, deliberate write. Only the exact parked name this product writes
 * is touched; anything else stays for an explicit install to replace.
 */
export async function repairParkedWindowsLauncher(configRoot: string): Promise<void> {
  const launcher = join(configRoot, 'chrome-native-host', 'klaus-chrome-host.cmd');
  const parked = `${launcher}.updating`;
  try {
    if (existsSync(launcher)) { await rm(parked, { force: true }); return; }
    if (!existsSync(parked)) return;
    await rename(parked, launcher);
  } catch { /* Diagnostics report a launcher the browser cannot launch; startup must not fail on it. */ }
}

/**
 * Where machine-wide Chrome policy lives on macOS.
 *
 * This is the HOST layer, not /Library/Managed Preferences: that directory is
 * owned by cfprefsd/MDM — hand-placed files there are ignored by the merged
 * preferences view (verified on an MDM-enrolled machine, where the daemon even
 * rewrites the file), while Chrome reads machine policy from
 * /Library/Preferences. The entry still needs root to write, hence the single
 * administrator authorization.
 */
const MAC_HOST_PREFERENCES = '/Library/Preferences/com.google.Chrome';

function shellQuote(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new BrowserError('invalid_request', 'Native host paths cannot contain line breaks.');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Installs only on an explicit settings action; discovery never writes profiles. */
export class ChromeSetup {
  constructor(readonly options: ChromeSetupOptions) {}
  private requireEnabled(): void { if (!this.options.enabled()) throw new BrowserError('unavailable', 'Enable external Chrome in Browser settings first.'); }
  private async identity(): Promise<{ id: string; name: string; webstoreId?: string }> {
    const value = object(JSON.parse(await readFile(join(this.options.extensionRoot, 'extension-id.json'), 'utf8')));
    if (typeof value.extensionId !== 'string' || !/^[a-p]{32}$/u.test(value.extensionId) || typeof value.extensionHostName !== 'string' || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/u.test(value.extensionHostName)) throw new BrowserError('invalid_config', 'The bundled Chrome extension identity is invalid.');
    return { id: value.extensionId, name: value.extensionHostName, ...(typeof value.webstoreId === 'string' && /^[a-p]{32}$/u.test(value.webstoreId) ? { webstoreId: value.webstoreId } : {}) };
  }
  private roots(): string[] {
    if (this.options.browserDataRoots) return this.options.browserDataRoots.filter(existsSync);
    if (process.platform === 'darwin') return MAC_SUPPORT.map(segment => join(homedir(), 'Library/Application Support', segment)).filter(existsSync);
    if (process.platform === 'win32') return [join(process.env.LOCALAPPDATA || homedir(), 'Google/Chrome/User Data'), join(process.env.LOCALAPPDATA || homedir(), 'Microsoft/Edge/User Data')].filter(existsSync);
    return ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map(name => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name)).filter(existsSync);
  }
  private executable(): string | undefined {
    if (this.options.browserExecutable) return existsSync(this.options.browserExecutable) ? this.options.browserExecutable : undefined;
    const candidates = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'] : process.platform === 'win32' ? [join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'), join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'), join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe')] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
    return candidates.find(existsSync);
  }
  private launcherPath(): string { return join(this.options.configRoot, 'chrome-native-host', process.platform === 'win32' ? 'klaus-chrome-host.cmd' : 'klaus-chrome-host'); }
  private manifestPaths(name: string): string[] {
    return process.platform === 'win32' ? [join(this.options.configRoot, 'chrome-native-host', `${name}.json`)] : this.roots().map(root => join(root, 'NativeMessagingHosts', `${name}.json`));
  }
  private launcherBody(): string {
    const executable = this.options.executable ?? process.execPath;
    const script = this.options.hostScript ?? join(__dirname, 'chrome-native-host.js');
    if (!isAbsolute(executable) || !isAbsolute(script) || !existsSync(executable) || !existsSync(script)) throw new BrowserError('invalid_config', 'The Electron native host executable or compiled entry is missing.');
    const args = this.options.discoveryDirectory ? ['--discovery-directory', resolve(this.options.discoveryDirectory)] : [];
    if (process.platform === 'win32') {
      const quote = (value: string): string => { if (/[\r\n\0"!]/u.test(value)) throw new BrowserError('invalid_config', 'The native host path contains unsupported command characters.'); return `"${value.replaceAll('%', '%%')}"`; };
      // The file is UTF-8. Switch before CMD reads any non-ASCII path line;
      // native messaging stdout must contain only the binary protocol frames.
      return `@echo off\r\nREM ${MARKER}\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul || exit /b 1\r\nset ELECTRON_RUN_AS_NODE=1\r\n${[executable, script, ...args].map(quote).join(' ')} %*\r\n`;
    }
    return `#!/bin/sh\n# ${MARKER}\nexport ELECTRON_RUN_AS_NODE=1\nexec ${[executable, script, ...args].map(shellQuote).join(' ')} "$@"\n`;
  }

  async install(): Promise<BrowserObject> {
    this.requireEnabled();
    const identity = await this.identity(); const paths = this.manifestPaths(identity.name);
    if (!paths.length) throw new BrowserError('unavailable', 'Open a Chromium browser once so its user data directory exists, then install the native host again.');
    const launcher = this.launcherPath();
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, this.launcherBody(), { mode: 0o755 });
    if (process.platform !== 'win32') await chmod(launcher, 0o755);
    const installed: string[] = []; const failures: string[] = [];
    for (const path of paths) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify({ name: identity.name, description: MARKER, type: 'stdio', path: launcher, allowed_origins: [`chrome-extension://${identity.id}/`] }, null, 2)}\n`, { mode: 0o600 });
        installed.push(path);
      } catch (error) { failures.push(`${path}: ${message(error)}`); }
    }
    if (process.platform === 'win32' && installed[0]) for (const key of WINDOWS_KEYS) {
      try {
        const path = `HKCU\\${key}\\NativeMessagingHosts\\${identity.name}`;
        if (this.options.registerWindowsHost) await this.options.registerWindowsHost(path, installed[0]);
        else await exec('reg.exe', ['add', path, '/ve', '/t', 'REG_SZ', '/d', installed[0], '/f'], { windowsHide: true, timeout: 5000 });
      }
      catch (error) { failures.push(`${key}: ${message(error)}`); }
    }
    return { ok: installed.length > 0 && failures.length === 0, manifestPath: installed[0] ?? null, manifestPaths: installed, hostPath: launcher, failures };
  }

  async diagnostics(): Promise<BrowserObject> {
    const identity = await this.identity(); const roots = this.roots(); const paths = this.manifestPaths(identity.name);
    const live = await discoverChrome(this.options.discoveryDirectory);
    let installed = false; let enabled = false; const versions = new Set<string>();
    // A profile record that exists but states neither way (Chrome omits `state`
    // for normal extensions) leaves enablement unknown rather than disabled.
    let enabledUnknown = false;
    // macOS protects another application's data directory, so reading Chrome's
    // profile preferences can fail with EPERM even for the signed app. A read
    // that was refused says nothing about whether the extension is there, and
    // reporting it as "not installed" sends the user to reinstall something
    // that is already installed — so an unreadable profile is tracked as
    // unknown instead of absent. A missing file is a genuine absence.
    let profileReadRefused = false;
    for (const root of roots) {
      let entries: string[] = [];
      try { entries = (await readdir(root)).filter(name => name === 'Default' || /^Profile \d+$/u.test(name)); } catch { /* An absent profile is not an extension installation. */ }
      for (const entry of entries) for (const file of ['Preferences', 'Secure Preferences']) {
        try {
          const prefs = object(JSON.parse(await readFile(join(root, entry, file), 'utf8')));
          const record = object(object(object(prefs.extensions).settings)[identity.id]);
          if (Object.keys(record).length) {
            installed = true;
            // Chrome omits `state` entirely for extensions it considers normal,
            // so its absence is NOT evidence of being disabled — treating it as
            // one reported every installed extension as disabled. Only an
            // explicit zero state or a populated reason list says "disabled".
            if (record.state === 1) enabled = true;
            else if (record.state === 0 || (Array.isArray(record.disable_reasons) && record.disable_reasons.length > 0)) { /* definitively disabled */ }
            else enabledUnknown = true;
            const version = object(record.manifest).version; if (typeof version === 'string') versions.add(version);
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') profileReadRefused = true;
          /* Live extension discovery is authoritative when preferences are unavailable. */
        }
      }
    }
    const connected = live.browsers.filter(browser => object(browser.info.metadata).extensionId === identity.id);
    if (connected.length) { installed = true; enabled = true; for (const browser of connected) if (typeof browser.info.version === 'string') versions.add(browser.info.version); }
    let nativeHostCorrect = false; let nativeHostPath: string | null = null;
    const manifestResults: BrowserObject[] = [];
    for (const path of paths) {
      let correct = false;
      try {
        const manifest = object(JSON.parse(await readFile(path, 'utf8')));
        const launcher = typeof manifest.path === 'string' ? manifest.path : '';
        const body = await readFile(launcher, 'utf8');
        correct = manifest.name === identity.name && manifest.type === 'stdio' && Array.isArray(manifest.allowed_origins) && manifest.allowed_origins.includes(`chrome-extension://${identity.id}/`) && launcher === this.launcherPath() && body === this.launcherBody();
        if (correct) { nativeHostCorrect = true; nativeHostPath = launcher; }
      } catch { /* Missing, stale and foreign launchers are reported as invalid. */ }
      manifestResults.push({ path, correct });
    }
    const executable = this.executable(); let running = connected.length > 0;
    if (!running && executable && process.platform !== 'win32') {
      try { running = (await exec('ps', ['-axo', 'comm='], { timeout: 1500, maxBuffer: 1024 * 1024 })).stdout.split('\n').some(line => line.trim() === executable); } catch { /* A live native host is stronger evidence than process listing. */ }
    }
    const compatible = connected.some(browser => { const capabilities = object(browser.info.metadata).capabilities; return Array.isArray(capabilities) && ['task_downloads', 'flat_cdp_sessions'].every(feature => capabilities.includes(feature)); });
    // The manual-install copy is part of the story the dialog tells: when it
    // already exists, the path row can show immediately instead of making the
    // user press "copy extension" again just to see where it landed.
    const deployDir = this.deployDirectory();
    let deployed = false;
    try { deployed = existsSync(join(deployDir, 'manifest.json')); } catch { /* An unreadable deploy dir reports as absent. */ }
    // Policy state is read-only and unprivileged, so the dialog can always say
    // whether the zero-gesture install is in force on this machine.
    const policy = await this.policyState();
    const policyEffective = policy.installed ? await this.policyEffective(policy.plistPath, String(policy.entry), 0) : false;
    const support = await this.policySupport();
    // An extension record that exists without stating enablement either way
    // is not a disabled extension; the actionable state there is the runtime.
    const definitelyDisabled = installed && !enabled && !enabledUnknown;
    const problem = !executable && !roots.length ? 'chrome_not_installed'
      : !nativeHostCorrect ? 'native_host_invalid'
        // A refused profile read cannot prove absence, so it is reported as
        // unknown rather than as an instruction to install a second copy.
        : !installed ? (profileReadRefused ? 'extension_state_unknown' : 'extension_not_installed')
        : definitelyDisabled ? 'extension_disabled'
        : !connected.length ? 'runtime_unreachable'
        : !compatible ? 'extension_reload_required' : null;
    const messages: Record<string, string> = { extension_reload_required: 'Reload the bundled Klaus extension to enable current task and frame capabilities.', chrome_not_installed: 'Install and open a Chromium browser first.', native_host_invalid: 'Install or repair the Klaus Chrome native host.', extension_not_installed: 'Load the bundled Klaus extension in the Chrome extension manager.', extension_disabled: 'Enable the Klaus extension in Chrome.', extension_state_unknown: 'The browser profile could not be read, so the extension state is unknown. Check it in the Chrome extension manager.', runtime_unreachable: 'Reload the Klaus extension or restart Chrome to reconnect its native host.' };
    return { ok: true, diagnostics: {
      ok: problem === null, status: problem === null ? 'connected' : 'action_required', problem, message: problem ? messages[problem] ?? problem : 'Chrome is connected.',
      pluginRoot: this.options.extensionRoot, extensionId: identity.id, extensionHostName: identity.name,
      webstoreUrl: identity.webstoreId ? `https://chromewebstore.google.com/detail/${identity.webstoreId}` : null, webstoreOneClick: Boolean(identity.webstoreId), extensionManagerUrl: `chrome://extensions/?id=${identity.id}`,
      chromeInstalled: Boolean(executable || roots.length), chromeRunning: running, extensionInstalled: installed, extensionEnabled: enabled,
      extensionInstallStateUnknown: !installed && profileReadRefused, extensionEnablementUnknown: installed && !enabled && enabledUnknown,
      nativeHostCorrect, nativeHostProvider: nativeHostCorrect ? 'klaus' : 'missing_or_invalid', nativeHostPath, klausNativeHostInstalled: nativeHostCorrect,
      runtimeReachable: connected.length > 0, extensionVersions: [...versions], connectedBrowsers: connected.map(browser => ({ id: browser.id, name: browser.info.name ?? 'Chrome' })), browserCount: connected.length,
      deployDirectory: deployDir, deployed,
      policyInstalled: policy.installed, policyEffective, policyEntry: policy.entry, policyPlistPath: policy.plistPath,
      policySupported: support.supported, policySupportReason: support.reason,
      policyUpdateManifestUrl: this.options.policyUpdateManifestUrl ?? null,
      candidatePipeCount: live.candidatePipeCount, failures: live.failures, raw: { manifests: manifestResults },
    } };
  }

  /**
   * The directory the bundled extension is copied into for manual installs.
   *
   * Chrome's "load unpacked" keeps a LIVE reference to the chosen folder: an app
   * update that replaces the bundle directory out from under a loaded extension
   * breaks it, and the packaged bundle lives under an app-owned path the user
   * cannot browse to from a file picker in the first place. A stable copy under
   * the user config root is what the extension manager is pointed at instead.
   */
  deployDirectory(): string { return this.options.deployRoot ?? join(this.options.configRoot, 'chrome-extension'); }

  private managedPreferencesPlist(): string { return `${this.options.managedPreferencesPath ?? MAC_HOST_PREFERENCES}.plist`; }

  /**
   * Read the machine's Chrome policy without touching it. The plist is
   * world-readable once written, so this needs no privilege; an absent file or
   * an unreadable one both mean "no policy of ours installed".
   */
  async policyState(): Promise<{ installed: boolean; entry: string | null; plistPath: string; all: BrowserObject }> {
    const plistPath = this.managedPreferencesPlist();
    const identity = await this.identity();
    try {
      const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', '--', plistPath], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      const parsed = object(JSON.parse(stdout));
      const list = Array.isArray(parsed.ExtensionInstallForcelist) ? parsed.ExtensionInstallForcelist : [];
      const entry = list.find(item => typeof item === 'string' && item.startsWith(`${identity.id}=`)) ?? null;
      return { installed: entry !== null, entry: typeof entry === 'string' ? entry : null, plistPath, all: parsed };
    } catch {
      return { installed: false, entry: null, plistPath, all: {} };
    }
  }

  /**
   * Install the extension through Chrome's machine policy so Chrome fetches and
   * enables it with no gesture in the extension manager.
   *
   * This is the zero-gesture path and it is deliberately loud about its costs:
   * it needs one administrator authorization (the plist is root-owned under
   * /Library/Preferences), Chrome shows its "managed by your organization"
   * banner for as long as the entry exists, and the entry pins every Chrome
   * profile on the machine. The update manifest is fetched first and must name
   * our extension id, so a stale or mis-pointed URL can never be written into
   * system policy. Every other key in the existing plist — including entries
   * an MDM or another administrator wrote — is preserved verbatim; the nested
   * JSON is handed to `plutil` for the plist conversion so nothing is
   * hand-serialized.
   */
  async policyInstall(): Promise<BrowserObject> {
    if (process.platform !== 'darwin') throw new BrowserError('unavailable', 'Policy installation is implemented for macOS only.');
    const support = await this.policySupport();
    if (!support.supported) throw new BrowserError('unavailable', `The zero-gesture policy path cannot work on this machine (${support.reason}). Use the manual install instead.`);
    const manifestUrl = this.options.policyUpdateManifestUrl;
    if (!manifestUrl) throw new BrowserError('unavailable', 'No Chrome extension update manifest URL is configured for policy installs.');
    const identity = await this.identity();
    const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new BrowserError('unavailable', `The extension update manifest is not reachable (HTTP ${response.status}).`);
    const body = await response.text();
    if (!body.includes(identity.id)) throw new BrowserError('invalid_config', 'The update manifest does not name this extension build; refusing to write system policy.');
    // The extension Chrome is about to fetch must be able to reach our native
    // host, and the host registration carries the current extension id.
    await this.install();
    const entry = `${identity.id}=${manifestUrl}`;
    const plistPath = this.managedPreferencesPlist();
    const current = await this.policyState();
    const policy: BrowserObject = { ...current.all };
    const list = Array.isArray(policy.ExtensionInstallForcelist) ? (policy.ExtensionInstallForcelist as unknown[]).filter((item): item is string => typeof item === 'string' && !item.startsWith(`${identity.id}=`)) : [];
    policy.ExtensionInstallForcelist = [...list, entry];
    await this.writePolicyPlist(policy, plistPath);
    const after = await this.policyState();
    if (!after.installed) throw new BrowserError('host_error', 'The policy plist was written but Chrome policy does not list the extension.');
    const effective = await this.policyEffective(plistPath, entry);
    return { ok: true, policyInstalled: true, policyEffective: effective, entry, plistPath };
  }

  /** Remove only our entry from the policy list, preserving every other key. */
  async policyUninstall(): Promise<BrowserObject> {
    if (process.platform !== 'darwin') throw new BrowserError('unavailable', 'Policy installation is implemented for macOS only.');
    const identity = await this.identity();
    const plistPath = this.managedPreferencesPlist();
    const current = await this.policyState();
    if (!current.installed) return { ok: true, policyInstalled: false, changed: false };
    const policy: BrowserObject = { ...current.all };
    const others = (Array.isArray(policy.ExtensionInstallForcelist) ? policy.ExtensionInstallForcelist as unknown[] : [])
      .filter((item): item is string => typeof item === 'string' && !item.startsWith(`${identity.id}=`));
    if (others.length) {
      policy.ExtensionInstallForcelist = others;
      await this.writePolicyPlist(policy, plistPath);
    } else {
      // Ours was the only entry: drop the key, and drop the file entirely when
      // nothing else of anyone's remains in it.
      delete policy.ExtensionInstallForcelist;
      if (Object.keys(policy).length) await this.writePolicyPlist(policy, plistPath);
      else await this.osascriptWithAdmin(`/bin/rm -f ${shellQuote(plistPath)}`);
    }
    const after = await this.policyState();
    return { ok: !after.installed, policyInstalled: after.installed, changed: true };
  }

  /**
   * Whether the zero-gesture policy path can work on this machine at all.
   *
   * Three things kill it, and the dialog needs to know which: a non-macOS host
   * (the policy write is macOS-only), no update manifest configured (nothing to
   * point Chrome at), and MDM enrollment — on enrolled Macs the preferences
   * view is filtered to what the management server pushes, so a hand-placed
   * policy plist is inert no matter which layer it lands in (proven on an
   * enrolled machine, see the dialog copy that names it). Reading enrollment
   * needs no privilege: `profiles status` is a plain user-level query.
   */
  async policySupport(): Promise<{ supported: boolean; reason: 'not_macos' | 'no_manifest' | 'mdm_enrolled' | null }> {
    if (process.platform !== 'darwin') return { supported: false, reason: 'not_macos' };
    if (!this.options.policyUpdateManifestUrl) return { supported: false, reason: 'no_manifest' };
    if (await this.mdmEnrolled()) return { supported: false, reason: 'mdm_enrolled' };
    return { supported: true, reason: null };
  }

  private async mdmEnrolled(): Promise<boolean> {
    if (this.options.policyEnrolledProbe) return this.options.policyEnrolledProbe();
    try {
      const { stdout } = await exec('profiles', ['status', '-type', 'enrollment'], { timeout: 5000, maxBuffer: 64 * 1024 });
      return /MDM enrollment:\s*Yes/i.test(stdout);
    } catch {
      // An unreadable enrollment state must not hide the policy path on a
      // machine that could use it; the effectiveness probe still guards writes.
      return false;
    }
  }

  /** Stage the policy as JSON, convert with plutil, install as root in one prompt. */
  private async writePolicyPlist(policy: BrowserObject, plistPath: string): Promise<void> {
    const staged = join(this.options.configRoot, 'chrome-native-host', 'chrome-policy.json');
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(staged, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o644 });
    const payload = `/usr/bin/plutil -convert xml1 -o ${shellQuote(`${staged}.plist`)} ${shellQuote(staged)} && /usr/bin/install -m 644 -o root -g wheel ${shellQuote(`${staged}.plist`)} ${shellQuote(plistPath)}`;
    await this.osascriptWithAdmin(payload);
  }

  /**
   * Whether the machine's merged preferences view actually sees the entry.
   *
   * Chrome resolves machine policy through CFPreferences, so a plist that the
   * merged view cannot see is a plist Chrome will never apply. On machines
   * enrolled in mobile device management the view is filtered to what the MDM
   * pushes — hand-placed plists are invisible there no matter the layer
   * (verified against a control domain on an enrolled machine) — so this probe
   * is what lets the install report "written but inert" instead of claiming
   * success the browser will silently ignore.
   */
  async policyEffective(plistPath: string, entry: string, retries = 3): Promise<boolean> {
    if (this.options.policyEffectiveProbe) return this.options.policyEffectiveProbe(plistPath, entry);
    // cfprefsd picks a brand-new domain up asynchronously; a couple of retries
    // keep a slow daemon from reading as "inert". Callers on a hot path (the
    // diagnostics poll) pass retries=0 and take the single read.
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { stdout } = await exec('defaults', ['read', 'com.google.Chrome', 'ExtensionInstallForcelist'], { timeout: 5000, maxBuffer: 1024 * 1024 });
        if (stdout.split('\n').some(line => line.includes(entry))) return true;
      } catch { /* not visible yet */ }
      if (attempt < retries) await new Promise(resolveWait => setTimeout(resolveWait, 2000));
    }
    return false;
  }

  /**
   * Run one shell payload as root with a single administrator authorization.
   * osascript raises the system prompt; the payload itself never sees the
   * password.
   */
  private async osascriptWithAdmin(payload: string): Promise<void> {
    // AppleScript string literals are DOUBLE-quoted; the payload is a shell
    // command whose own quoting uses single quotes, so only backslashes and
    // double quotes need escaping at the AppleScript layer. Wrapping it in
    // single quotes produced a syntax error before any prompt was ever shown.
    const applescript = payload.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    try {
      await exec('osascript', ['-e', `do shell script "${applescript}" with administrator privileges`], { timeout: 120_000 });
    } catch (error) {
      const detail = message(error);
      // osascript reports the user closing the authorization dialog as -128;
      // that is a decision, not a failure of ours.
      if (detail.includes('-128')) throw new BrowserError('cancelled', 'The administrator authorization was cancelled.');
      throw new BrowserError('permission_denied', `The administrator authorization did not complete: ${detail}`);
    }
  }

  /**
   * Refresh the manual-install copy and report where it landed. Re-copying is
   * idempotent: the target is removed first so a stale tree from an older app
   * version cannot survive inside it. Read-only callers (diagnostics) never
   * reach this.
   */
  async deploy(): Promise<BrowserObject> {
    const identity = await this.identity();
    const target = this.deployDirectory();
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(this.options.extensionRoot, target, { recursive: true });
    await writeFile(join(target, BUILD_MARKER_FILE), `${JSON.stringify({ build: this.options.buildStamp ?? 'unknown' })}\n`, { mode: 0o644 });
    return { ok: true, extensionPath: target, extensionId: identity.id, extensionManagerUrl: `chrome://extensions/?id=${identity.id}` };
  }

  /** Build stamp of the extension copy Chrome currently loads unpacked. */
  async deployedBuildMarker(): Promise<string | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.deployDirectory(), BUILD_MARKER_FILE), 'utf8')) as { build?: unknown };
      return typeof raw.build === 'string' && raw.build ? raw.build : null;
    } catch { return null; }
  }

  /** Re-deploy when the stamped build differs from this app's build. */
  async syncIfStale(): Promise<boolean> {
    if (!this.options.buildStamp) return false;
    if ((await this.deployedBuildMarker()) === this.options.buildStamp) return false;
    await this.deploy();
    return true;
  }

  private async open(url: string): Promise<void> {
    if (this.options.openBrowser) { await this.options.openBrowser(url); return; }
    const executable = this.executable(); if (!executable) throw new BrowserError('unavailable', 'No installed Chromium browser was found.');
    if (process.platform === 'darwin') { await exec('open', ['-a', executable.split('/Contents/MacOS/')[0] ?? executable, url], { timeout: 5000 }); return; }
    await new Promise<void>((resolveSpawn, reject) => {
      const child = spawn(executable, [url], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolveSpawn(); });
    });
  }

  async action(action: string): Promise<BrowserObject> {
    if (action === 'chrome-diagnostics') return this.diagnostics();
    // Deploying our own bundle into our own config root and revealing that copy
    // touch nothing of the user's browser, so the manual-install flow works
    // before external Chrome is taken over at all.
    if (action === 'chrome-deploy-extension') return this.deploy();
    if (action === 'chrome-reveal-extension') {
      const target = this.deployDirectory();
      if (!existsSync(target)) throw new BrowserError('unavailable', 'The extension has not been copied yet.');
      this.options.showExtensionFolder?.(target);
      return { ok: true, extensionPath: target };
    }
    this.requireEnabled();
    if (action === 'chrome-install-native-host') return this.install();
    if (action === 'chrome-policy-install') return this.policyInstall();
    if (action === 'chrome-policy-uninstall') return this.policyUninstall();
    const identity = await this.identity();
    if (action === 'chrome-open-window') { await this.open('about:blank'); return { ok: true, opened: true }; }
    if (action === 'chrome-open-extension-manager' || action === 'chrome-open-webstore') {
      if (action === 'chrome-open-webstore' && identity.webstoreId) { await this.open(`https://chromewebstore.google.com/detail/${identity.webstoreId}`); return { ok: true, opened: true }; }
      await this.open(`chrome://extensions/?id=${identity.id}`);
      return { ok: true, opened: true, manualAction: 'load_extension', extensionPath: this.deployDirectory(), extensionManagerUrl: `chrome://extensions/?id=${identity.id}` };
    }
    if (action === 'chrome-setup') {
      const install = await this.install();
      if (install.ok !== true) return install;
      const report = await this.diagnostics(); const state = object(report.diagnostics);
      if (state.ok === true) return { ...report, actions: [{ action: 'install_native_host', ok: true }], manualAction: null };
      const opened = await this.action('chrome-open-extension-manager');
      return { ...report, actions: [{ action: 'install_native_host', ok: true }, { action: 'open_extension_manager', ok: opened.ok ?? false }], manualAction: setupManualAction(state), extensionPath: this.deployDirectory() };
    }
    throw new BrowserError('invalid_request', `Unknown Chrome settings action: ${action}`);
  }
}
