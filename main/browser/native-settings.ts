import type { BrowserManagerSurface } from '../../contracts/browser-settings';

export const NATIVE_SETTINGS_ROUTES = {
  passwords: 'chrome://password-manager/passwords',
  autofill: 'chrome://settings/contactInfo',
  extensions: 'chrome://extensions/',
  siteSettings: 'chrome://settings/content',
} as const;

const paths = {
  passwords: { 'password-manager': ['/'], settings: ['/passwords'] },
  autofill: { settings: ['/autofill', '/addresses', '/contactInfo'] },
  extensions: { extensions: ['/'] },
  siteSettings: { settings: ['/content', '/cookies', '/handlers'] },
} as const;

/** Only the selected native settings surface can be navigated by its host. */
export function nativeSettingsUrl(surface: BrowserManagerSurface, input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol !== 'chrome:' || url.username || url.password || url.port || surface === 'import') return false;
    const roots = (paths[surface] as Record<string, readonly string[]>)[url.hostname];
    return roots?.some(root => root === '/' || url.pathname === root || url.pathname.startsWith(`${root}/`)) ?? false;
  } catch { return false; }
}

/** Internal settings routers can replace native history entries on subpages. */
export class NativeSettingsHistory {
  private entries: string[];
  private index = 0;
  private requested: number | undefined;

  constructor(initialUrl: string) { this.entries = [initialUrl]; }

  visit(url: string): void {
    if (this.requested !== undefined && this.entries[this.requested] === url) {
      this.index = this.requested;
      this.requested = undefined;
      return;
    }
    if (this.entries[this.index] === url) return;
    const previous = this.entries.indexOf(url);
    if (previous >= 0) this.index = previous;
    else {
      this.entries = [...this.entries.slice(0, this.index + 1), url];
      this.index += 1;
    }
    this.requested = undefined;
  }

  get canGoBack(): boolean { return this.index > 0; }
  get canGoForward(): boolean { return this.index < this.entries.length - 1; }

  step(delta: -1 | 1): string | undefined {
    const next = this.index + delta;
    const url = this.entries[next];
    if (url !== undefined) { this.index = next; this.requested = next; }
    return url;
  }
}

/** Read the visible native subpage title through its open shadow roots. */
export const nativeSettingsTitleScript = `(() => {
  const visited = new Set();
  const clean = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const find = root => {
    if (!root || visited.has(root)) return null;
    visited.add(root);
    for (const element of root.querySelectorAll('settings-subpage,h1,h2,[slot="title"],#title,.page-title')) {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || !(rect.width || rect.height)) continue;
      const title = clean(element.localName === 'settings-subpage' ? element.getAttribute('page-title') : element.textContent);
      if (title) return title;
    }
    for (const element of root.querySelectorAll('*')) {
      const title = find(element.shadowRoot);
      if (title) return title;
    }
    return null;
  };
  return find(document);
})()`;

/** Let the native router retain its state when returning from a site subpage. */
export const nativeSettingsBackScript = `(() => {
  const visited = new Set();
  const find = root => {
    if (!root || visited.has(root)) return null;
    visited.add(root);
    const button = root.querySelector('settings-subpage')?.shadowRoot?.querySelector('cr-icon-button#closeButton');
    if (button) return button;
    for (const element of root.querySelectorAll('*')) {
      const nested = find(element.shadowRoot);
      if (nested) return nested;
    }
    return null;
  };
  const button = find(document);
  if (!button) return false;
  button.click();
  return true;
})()`;
