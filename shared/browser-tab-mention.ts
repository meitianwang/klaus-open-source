/** Browser identities stay separate from the title and URL snapshots shown in a chip. */
export interface BrowserTabMention {
  source: 'iab' | 'extension';
  browserId: string;
  tabId: string;
  title: string;
  url: string;
  browserName: string;
  lastOpened: number;
  faviconUrl?: string;
  mention: string;
}

export const BROWSER_TAB_MENTION_BASE = 'plugin://browser@klaus-bundled';

export function browserTabMentionUri(row: Omit<BrowserTabMention, 'mention'>): string {
  const params = new URLSearchParams({ mention: 'tab-v1' });
  if (row.source === 'extension') params.set('source', 'extension');
  params.set('browserId', row.browserId);
  params.set('tabId', row.tabId);
  params.set('title', row.title);
  params.set('url', row.url);
  return `${BROWSER_TAB_MENTION_BASE}?${params}`;
}

export function browserTabMentionLink(row: BrowserTabMention): string {
  const title = (row.title.trim() ? row.title : row.url).replace(/[\\\[\]\r\n]/g, character => /[\r\n]/.test(character) ? ' ' : `\\${character}`);
  return `[${title}](${row.mention})`;
}

export function parseBrowserTabMention(value: string): BrowserTabMention | null {
  try {
    const prefix = `${BROWSER_TAB_MENTION_BASE}?`;
    if (!value.startsWith(prefix)) return null;
    const params = new URLSearchParams(value.slice(prefix.length));
    if (params.get('mention') !== 'tab-v1') return null;
    for (const key of params.keys()) if (!['mention', 'source', 'browserId', 'tabId', 'title', 'url'].includes(key) || params.getAll(key).length !== 1) return null;
    const source = params.get('source') === 'extension' ? 'extension' : params.has('source') ? null : 'iab';
    const browserId = params.get('browserId') ?? '';
    const tabId = params.get('tabId') ?? '';
    const title = params.get('title') ?? '';
    const pageUrl = params.get('url') ?? '';
    if (!source || !/^[1-9]\d*$/.test(tabId) || !Number.isSafeInteger(Number(tabId))) return null;
    if (!browserId || browserId.length > 128 || /[\u0000-\u001f\u007f]/.test(browserId)) return null;
    if (source === 'extension' && !/^chrome:[A-Za-z0-9_-]+$/.test(browserId)) return null;
    if (title.length > 4096 || pageUrl.length > 16384) return null;
    const page = new URL(pageUrl);
    if (!['http:', 'https:'].includes(page.protocol) && pageUrl !== 'about:blank') return null;
    const row: Omit<BrowserTabMention, 'mention'> = { source, browserId, tabId, title, url: pageUrl, browserName: source === 'iab' ? 'Klaus' : browserId, lastOpened: 0 };
    if (browserTabMentionUri(row) !== value) return null;
    return { ...row, mention: value };
  } catch { return null; }
}

export function browserTabReferencesIn(text: string): BrowserTabMention[] {
  const found = new Map<string, BrowserTabMention>();
  let uriBytes = 0;
  for (const match of text.matchAll(/plugin:\/\/browser@klaus-bundled\?[^\s<>)]*/g)) {
    const reference = parseBrowserTabMention(match[0]);
    if (reference) {
      uriBytes += match[0].length;
      found.set(JSON.stringify([reference.source, reference.browserId, reference.tabId]), reference);
      if (found.size > 100 || uriBytes > 1024 * 1024) throw new RangeError('A message can reference at most 100 browser tabs and 1 MiB of browser tab URIs.');
    }
  }
  return [...found.values()];
}

export function filterBrowserTabMentions(rows: BrowserTabMention[], query: string): BrowserTabMention[] {
  const needle = query.trim().toLocaleLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  const found = new Map<string, BrowserTabMention>();
  for (const row of rows) {
    const searchable = [row.title, row.url, row.browserName].join(' ').toLocaleLowerCase();
    if (!terms.every(term => searchable.includes(term))) continue;
    const key = JSON.stringify([row.source, row.browserId, row.tabId]);
    if (!found.has(key)) found.set(key, row);
  }
  return [...found.values()].sort((a, b) => b.lastOpened - a.lastOpened || a.browserId.localeCompare(b.browserId) || Number(a.tabId) - Number(b.tabId)).slice(0, needle ? 100 : 3);
}
