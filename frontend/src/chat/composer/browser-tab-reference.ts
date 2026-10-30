import {
  browserTabMentionLink, parseBrowserTabMention, type BrowserTabMention,
} from '../../../../shared/browser-tab-mention'

export const BROWSER_TAB_MENTIONS_REFRESH_MS = 5_000

/** Only bounded, provider-supplied image data is rendered; missing favicons never trigger a lookup. */
export function safeBrowserTabFavicon(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16_384) return undefined
  if (/^data:image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    && value.slice(value.indexOf(',') + 1).length % 4 === 0) return value
  return undefined
}

/** Persisted chips and IPC rows must name the same exact tab snapshot as their URI. */
export function normalizeBrowserTabMention(value: unknown): BrowserTabMention | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<BrowserTabMention>
  if (typeof row.mention !== 'string') return null
  const parsed = parseBrowserTabMention(row.mention)
  if (!parsed || row.source !== parsed.source || row.browserId !== parsed.browserId || row.tabId !== parsed.tabId
    || row.title !== parsed.title || row.url !== parsed.url) return null
  const faviconUrl = safeBrowserTabFavicon(row.faviconUrl)
  return {
    ...parsed,
    browserName: typeof row.browserName === 'string' && row.browserName.trim() ? row.browserName : parsed.browserName,
    lastOpened: typeof row.lastOpened === 'number' && Number.isFinite(row.lastOpened) && row.lastOpened >= 0 ? row.lastOpened : 0,
    ...(faviconUrl ? { faviconUrl } : {}),
  }
}

export function browserTabReference(row: BrowserTabMention) {
  return {
    kind: 'browser-tab' as const,
    name: browserTabLabel(row),
    value: browserTabMentionLink(row),
    id: row.mention,
    browserTab: row,
  }
}

export function browserTabLabel(row: BrowserTabMention): string {
  return row.title.replace(/[\r\n]+/g, ' ').trim() || row.url.replace(/[\r\n]+/g, ' ').trim()
}

export function browserTabDetail(row: BrowserTabMention): string {
  let location = row.url
  try { location = new URL(row.url).hostname || row.url } catch { /* Retain the supplied location. */ }
  return `${location} · ${row.browserName}`
}
