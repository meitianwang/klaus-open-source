import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { SiteOpenTarget, SiteOpenTargetId, SiteOpenTargets } from '../../contracts/browser-sites';
import { kvGet, kvSet } from '../services/settings';
import type { BrowserManager } from './manager';
import { BrowserError, string, type BrowserObject } from './types';
import { LOCAL_URL_TARGET_KEY, WEB_URL_TARGET_KEY, localBrowserUrl } from '../../contracts/browser-settings';

export const SITE_OPEN_TARGET_SETTING = WEB_URL_TARGET_KEY;
const targetIds: SiteOpenTargetId[] = ['in-app', 'chrome', 'system-default'];

export function siteUrl(input: unknown): string {
  const raw = string(input, 'url');
  let url: URL;
  try { url = new URL(raw); } catch { throw new BrowserError('invalid_request', 'A valid website URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new BrowserError('invalid_request', 'Only HTTP or HTTPS website URLs without credentials may be opened.');
  }
  return url.href;
}

/** Only Google Chrome is a named target; other browsers remain OS choices. */
export function chromeCandidatePaths(platform = process.platform, env = process.env, home = homedir()): string[] {
  if (platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ];
  if (platform === 'win32') return [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']]
    .filter((root): root is string => !!root).map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return [...new Set([
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(root => [join(root, 'google-chrome'), join(root, 'google-chrome-stable')]),
  ])];
}

export function findInstalledChrome(): string | null {
  for (const path of chromeCandidatePaths()) {
    try { accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return path; } catch { /* Try the next installation. */ }
  }
  return null;
}

function output(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

const iconCache = new Map<string, string | undefined>();

/** Official application artwork ships inside the bundle's icns container, while
 *  the system icon service can hand back a washed-out template rendering of the
 *  same app. Read the container directly and keep the largest PNG entry that is
 *  at most 256px, which is plenty for a menu row and stays small over IPC. */
export function icnsIconDataUrl(icnsPath: string): string | undefined {
  if (!icnsPath) return undefined;
  if (iconCache.has(icnsPath)) return iconCache.get(icnsPath);
  let result: string | undefined;
  try {
    const buffer = readFileSync(icnsPath);
    let chosen: { width: number; payload: Buffer } | undefined;
    let pos = 8;
    while (pos + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(pos + 4);
      if (length < 8 || pos + length > buffer.length) break;
      const payload = buffer.subarray(pos + 8, pos + length);
      if (payload.length > 24 && payload.readUInt32BE(0) === 0x89504e47) {
        const width = payload.readUInt32BE(16);
        if (!chosen) chosen = { width, payload };
        else {
          const current = chosen.width;
          if (width <= 256 ? current > 256 || width > current : current > 256 && width < current) chosen = { width, payload };
        }
      }
      pos += length;
    }
    if (chosen) result = `data:image/png;base64,${chosen.payload.toString('base64')}`;
  } catch { result = undefined; }
  iconCache.set(icnsPath, result);
  return result;
}

/** Locate a macOS bundle's own icon container. Apps ship exactly one icns in
 *  practice, and `app.icns` wins when a bundle ever carries more. */
export function bundleIconPathFromRoot(bundleRoot: string, platform = process.platform): string | null {
  if (platform !== 'darwin' || !bundleRoot) return null;
  const resources = join(bundleRoot, 'Contents', 'Resources');
  try {
    const icons = readdirSync(resources).filter(name => name.endsWith('.icns'));
    const chosen = icons.find(name => name === 'app.icns') ?? icons[0];
    return chosen ? join(resources, chosen) : null;
  } catch { return null; }
}

/** The executable path always sits inside `Contents/MacOS`, so the bundle
 *  root is the prefix up to and including the `.app` suffix. */
export function chromeBundleIconPath(executable: string | null, platform = process.platform): string | null {
  if (platform !== 'darwin' || !executable) return null;
  const marker = '.app/';
  const at = executable.indexOf(marker);
  if (at < 0) return null;
  return bundleIconPathFromRoot(executable.slice(0, at + marker.length - 1), platform);
}

async function chromeIsDefault(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      const plist = join(homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
      if (!existsSync(plist)) return false;
      const data = JSON.parse(await output('plutil', ['-convert', 'json', '-o', '-', plist])) as { LSHandlers?: Array<Record<string, string>> };
      return data.LSHandlers?.some(entry => entry.LSHandlerURLScheme === 'https' && entry.LSHandlerRoleAll?.toLowerCase() === 'com.google.chrome') ?? false;
    }
    if (process.platform === 'win32') return /ProgId\s+REG_SZ\s+ChromeHTML/i.test(await output('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']));
    return /^(?:google-chrome|google-chrome-stable)\.desktop\s*$/i.test(await output('xdg-settings', ['get', 'default-web-browser']));
  } catch { return false; }
}

/** Confirm OS launch errors and immediate process failures before reporting success. */
export function launchSiteProcess(executable: string, args: string[], waitForExit = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: !waitForExit, stdio: 'ignore' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve();
      child.unref();
    };
    child.once('error', finish);
    child.once('close', (code, signal) => finish(code === 0 ? undefined : new Error(`The browser launch failed (${signal ?? code ?? 'unknown'}).`)));
    child.once('spawn', () => {
      timer = setTimeout(() => finish(waitForExit ? new Error('The browser launcher timed out.') : undefined), waitForExit ? 10_000 : 500);
    });
  });
}

async function openChrome(path: string, url: string): Promise<void> {
  if (process.platform === 'darwin') await launchSiteProcess('/usr/bin/open', ['-a', path.slice(0, path.indexOf('.app/') + 4), url], true);
  else await launchSiteProcess(path, [url]);
}

interface SiteOpenDependencies {
  findChrome(): string | null;
  chromeDefault(): Promise<boolean>;
  chromeIcon(path: string): Promise<string | undefined>;
  systemDefaultIcon(): Promise<string | undefined>;
  openChrome(path: string, url: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

const defaults: SiteOpenDependencies = {
  findChrome: findInstalledChrome,
  chromeDefault: chromeIsDefault,
  chromeIcon: async path => {
    const bundled = icnsIconDataUrl(chromeBundleIconPath(path) ?? '');
    if (bundled) return bundled;
    try {
      const { app } = await import('electron');
      const image = await app.getFileIcon(process.platform === 'darwin' ? path.slice(0, path.indexOf('.app/') + 4) : path);
      return image.isEmpty() ? undefined : image.toDataURL();
    } catch { return undefined; }
  },
  systemDefaultIcon: async () => {
    if (process.platform === 'linux') return undefined;
    try {
      const { app } = await import('electron');
      const info = await app.getApplicationInfoForProtocol('https://example.com/');
      // The resolved handler's bundle carries its official artwork at full
      // size; the protocol lookup's own icon is only a small thumbnail.
      const bundled = icnsIconDataUrl(bundleIconPathFromRoot(info.path) ?? '');
      if (bundled) return bundled;
      return info.icon.isEmpty() ? undefined : info.icon.toDataURL();
    } catch { return undefined; }
  },
  openChrome,
  openExternal: async url => { const { shell } = await import('electron'); await shell.openExternal(url); },
};

export class SiteOpener {
  private readonly deps: SiteOpenDependencies;
  constructor(
    private readonly configRoot: string,
    private readonly browser: Pick<BrowserManager, 'ensurePage' | 'navigate' | 'requestPanel' | 'setConversation'>,
    dependencies: Partial<SiteOpenDependencies> = {},
  ) { this.deps = { ...defaults, ...dependencies }; }

  async targets(): Promise<SiteOpenTargets> {
    const targets: SiteOpenTarget[] = [{ id: 'in-app', kind: 'in-app', name: 'Klaus' }];
    const path = this.deps.findChrome();
    if (path) {
      const [iconDataUrl, isDefault] = await Promise.all([this.deps.chromeIcon(path), this.deps.chromeDefault()]);
      targets.push({ id: 'chrome', kind: 'named', name: 'Google Chrome', ...(iconDataUrl ? { iconDataUrl } : {}), ...(isDefault ? { isDefault } : {}) });
    }
    const systemIcon = await this.deps.systemDefaultIcon();
    targets.push({ id: 'system-default', kind: 'system-default', name: '', isDefault: true, ...(systemIcon ? { iconDataUrl: systemIcon } : {}) });
    const stored = kvGet(SITE_OPEN_TARGET_SETTING, this.configRoot);
    const preferredTarget = targets.find(target => target.id === stored)?.id ?? 'system-default';
    const local = kvGet(LOCAL_URL_TARGET_KEY, this.configRoot);
    return { targets, preferredTarget, localPreferredTarget: targets.find(target => target.id === local)?.id ?? 'in-app' };
  }

  async open(fields: BrowserObject): Promise<{ ok: true; target: SiteOpenTargetId }> {
    const sessionId = string(fields.sessionId, 'sessionId');
    if (sessionId.length > 256) throw new BrowserError('invalid_request', 'sessionId is too long.');
    const url = siteUrl(fields.url);
    const preferenceKey = localBrowserUrl(url) ? LOCAL_URL_TARGET_KEY : SITE_OPEN_TARGET_SETTING;
    const stored = kvGet(preferenceKey, this.configRoot);
    const preferred = targetIds.includes(stored as SiteOpenTargetId) && (stored !== 'chrome' || this.deps.findChrome()) ? stored : localBrowserUrl(url) ? 'in-app' : 'system-default';
    const target = fields.target ?? preferred;
    if (typeof target !== 'string' || !targetIds.includes(target as SiteOpenTargetId)) throw new BrowserError('invalid_request', 'Unknown website open target.');
    if (target === 'in-app') {
      // A user's explicit click can open a saved conversation's own page set.
      this.browser.setConversation(sessionId);
      const page = await this.browser.ensurePage(sessionId);
      // The click is a user takeover of the page: drop any emulated viewport
      // an operation left applied so the site lays out at its natural scale.
      await page.cdp.clearEmulationOverrides();
      await this.browser.navigate(page, url);
      if (!await this.browser.requestPanel(sessionId, page)) throw new BrowserError('unavailable', 'The browser panel could not be opened.');
    } else if (target === 'chrome') {
      const path = this.deps.findChrome();
      if (!path) throw new BrowserError('not_found', 'Google Chrome is not installed on this machine.');
      await this.deps.openChrome(path, url);
    } else await this.deps.openExternal(url);
    const saved = kvSet(preferenceKey, target, this.configRoot);
    if (saved !== true) throw new BrowserError(saved.code, saved.message);
    return { ok: true, target: target as SiteOpenTargetId };
  }
}
