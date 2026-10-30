import { useEffect, useState } from 'react'
import { icon } from '../../icons/registry'
import { safeBrowserTabFavicon } from './browser-tab-reference'

const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

/** Composer and transcript chips use the same bounded favicon with a real icon fallback. */
export function browserTabIconHtml(faviconUrl?: string, className = ''): string {
  const src = safeBrowserTabFavicon(faviconUrl)
  const fallback = `<span data-browser-tab-fallback>${icon('browser-use-logo', { size: 16 })}</span>`
  return `<span class="${escapeAttribute(className)}" aria-hidden="true">${src
    ? `<img data-browser-tab-favicon src="${escapeAttribute(src)}" width="16" height="16" alt="" referrerpolicy="no-referrer" hidden>${fallback}`
    : fallback}</span>`
}

/** HTML-backed chips keep event handlers outside serialized markup. */
export function installBrowserTabFaviconFallback(doc: Document): () => void {
  const update = (event: Event) => {
    const image = event.target as HTMLImageElement | null
    if (!image?.matches?.('img[data-browser-tab-favicon]')) return
    const fallback = image.parentElement?.querySelector('[data-browser-tab-fallback]') as HTMLElement | null
    image.hidden = event.type === 'error'
    if (fallback) fallback.hidden = event.type === 'load'
  }
  doc.addEventListener('load', update, true)
  doc.addEventListener('error', update, true)
  return () => {
    doc.removeEventListener('load', update, true)
    doc.removeEventListener('error', update, true)
  }
}

export function BrowserTabIcon({ faviconUrl }: { faviconUrl?: string }) {
  const src = safeBrowserTabFavicon(faviconUrl)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  return src && !failed
    ? <img src={src} width={16} height={16} alt="" aria-hidden="true" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('browser-use-logo') }} />
}
