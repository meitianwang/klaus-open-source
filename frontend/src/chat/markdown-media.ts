import { localMediaUrl } from '../../bridge/media-url'

/** Normalize local Markdown references once, before matching or minting media URLs. */
export function normalizeImageHrefToPath(href: string): string {
  let value = String(href || '').trim()
  if (/^sandbox:/i.test(value)) value = value.slice(8)
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return ''
  if (/^(?:https?:|blob:|data:)/i.test(value)) return ''
  let path = value
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value)
      if (url.username || url.password || url.port) return ''
      path = decodeURIComponent(url.pathname)
      if (/^\/[a-zA-Z]:[\\/]/.test(path)) path = path.slice(1)
      if (url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`
    } catch { return '' }
  } else if (/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value)) {
    try { path = decodeURI(value).replace(/%23/gi, '#').replace(/%3F/gi, '?') } catch { /* Keep literal percent signs and malformed escapes readable. */ }
  }
  if (/[\u0000-\u001f\u007f]/.test(path) || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(path)) return ''
  return path
}

export function resolveImageSrc(href: string, sessionId: string): string {
  const value = href.trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return ''
  if (/^(?:https?:|blob:|data:image\/)/i.test(value)) return value
  const path = normalizeImageHrefToPath(value)
  if (!path) return ''
  return (typeof window !== 'undefined' ? (window as any).klaus?.media?.url?.(path, sessionId) : '') || localMediaUrl(path, sessionId)
}
