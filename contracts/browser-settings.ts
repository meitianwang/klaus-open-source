import type { SiteOpenTargetId } from './browser-sites';

export const BROWSER_RESOURCES = ['browsing', 'downloads', 'uploads', 'siteTools', 'debug'] as const;
export type BrowserResource = typeof BROWSER_RESOURCES[number];
export type BrowserAccess = 'allow' | 'ask' | 'deny';
export type BrowserOriginPolicy = Record<BrowserResource, BrowserAccess>;
export type BrowserOriginRule = { pattern: string; policy: Partial<BrowserOriginPolicy> };
export const BROWSER_DEFAULT_POLICY: BrowserOriginPolicy = {
  browsing: 'allow', downloads: 'allow', uploads: 'allow', siteTools: 'allow', debug: 'deny',
};
export const WEB_URL_TARGET_KEY = 'browser:site_open_target';
export const LOCAL_URL_TARGET_KEY = 'browser:local_site_open_target';

/** Native management surfaces hosted by the browser's own WebUI. */
export const NATIVE_MANAGER_SURFACES = ['passwords', 'autofill', 'extensions', 'siteSettings'] as const;
export type NativeManagerSurface = typeof NATIVE_MANAGER_SURFACES[number];
export const BROWSER_MANAGER_SURFACES = [...NATIVE_MANAGER_SURFACES, 'import'] as const;
export type BrowserManagerSurface = typeof BROWSER_MANAGER_SURFACES[number];
export type BrowserManagerTheme = 'light' | 'dark';
export type BrowserManagerAction = 'open' | 'bounds' | 'close' | 'navigate' | 'back' | 'forward' | 'theme';
export interface BrowserManagerBounds { x: number; y: number; width: number; height: number }
export interface BrowserManagerOptions {
  action?: BrowserManagerAction;
  bounds?: BrowserManagerBounds;
  viewId?: string;
  url?: string;
  theme?: BrowserManagerTheme;
}
/** A state push from the host after load, navigation or title resolution. */
export interface BrowserManagerState {
  surface: BrowserManagerSurface;
  viewId: string;
  url: string;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserSettingsSnapshot {
  /** Agent/plugin authorization. */
  enabled: boolean;
  /**
   * Derived manual built-in-browser availability. Not persisted. Missing means
   * an older host where the browser is available.
   */
  browserAvailable?: boolean;
  /**
   * True only when the host can open its native browser management pages.
   * Older hosts and stock runtimes omit this field.
   */
  nativeManagementAvailable?: boolean;
  chromeEnabled: boolean;
  showFullUrl: boolean;
  annotationScreenshots: 'always' | 'necessary';
  webUrlTarget: SiteOpenTargetId;
  localUrlTarget: SiteOpenTargetId;
  downloadDirectory: string | null;
  promptForDownloads: boolean;
  defaultPolicy: BrowserOriginPolicy;
  originRules: BrowserOriginRule[];
  sitePermissions: Array<{ origin: string; permission: string; setting: 'granted' | 'denied' }>;
  approvalMode: string;
  screenshotMode: string;
  allowedOrigins: string[];
  deniedOrigins: string[];
}

/** Display the origin until editing starts; always preserve the complete navigable value. */
export function browserAddress(url: string, full: boolean, editing: boolean): string {
  if (!url || url === 'about:blank') return '';
  if (full || editing) return url;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.host : url;
  } catch { return url; }
}

export function localBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'file:' || host === 'localhost' || host.endsWith('.localhost')
      || host === '[::1]' || host === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}

/** Rules match whole hosts or a label-delimited wildcard, never URL substrings. */
export function browserOriginPattern(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value || value.length > 2048 || /[\s?#@\\]/.test(value)) return undefined;
  if (value === '*') return value;
  const wildcard = value.startsWith('*.') || /^https?:\/\/\*\./.test(value);
  const prepared = value.replace('://*.', '://').replace(/^\*\./, '');
  if (prepared.includes('*')) return undefined;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/.test(prepared) && !/^[\w.-]+:\d+$/.test(prepared) ? prepared : `https://${prepared}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/') return undefined;
    const explicitScheme = /^https?:\/\//.test(value);
    return `${explicitScheme ? `${url.protocol}//` : ''}${wildcard ? '*.' : ''}${url.host}`;
  } catch { return undefined; }
}

export function browserPatternMatches(pattern: string, input: string): boolean {
  if (pattern === '*') return true;
  const normalized = browserOriginPattern(pattern);
  if (!normalized) return false;
  try {
    const url = new URL(input);
    const scheme = /^(https?:)\/\//.exec(normalized);
    if (scheme && url.protocol !== scheme[1]) return false;
    const host = normalized.replace(/^https?:\/\//, '');
    return host.startsWith('*.') ? url.host === host.slice(2) || url.host.endsWith(`.${host.slice(2)}`) : url.host === host;
  } catch { return false; }
}

export function browserEffectiveAccess(snapshot: Pick<BrowserSettingsSnapshot, 'defaultPolicy' | 'originRules' | 'allowedOrigins' | 'deniedOrigins'>, url: string, resource: BrowserResource): BrowserAccess {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return 'deny'; }
  if (snapshot.deniedOrigins.includes(origin)) return 'deny';
  const matches = snapshot.originRules.filter(rule => browserPatternMatches(rule.pattern, url) && rule.policy[resource] !== undefined)
    .sort((a, b) => b.pattern.replace('*', '').length - a.pattern.replace('*', '').length || a.pattern.localeCompare(b.pattern));
  return matches[0]?.policy[resource] ?? (resource === 'browsing' && snapshot.allowedOrigins.includes(origin) ? 'allow' : snapshot.defaultPolicy[resource]);
}
