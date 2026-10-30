import type { Slice } from 'prosemirror-model'
import { composerClipboardTokenAttributes, COMPOSER_DOCUMENT_TOKEN_ATTRIBUTE, COMPOSER_DOCUMENT_TOKEN_DATA_LIMIT } from './document-model'

export const COMPOSER_HTML_PASTE_LIMIT = 100_000
export const COMPOSER_STRUCTURED_HTML_PASTE_LIMIT = COMPOSER_DOCUMENT_TOKEN_DATA_LIMIT

/** Authored atoms have a separate bounded import path for their retained metadata. */
export function clipboardHtmlLimit(document: Document, html: string): number {
  if (html.length <= COMPOSER_HTML_PASTE_LIMIT || html.length > COMPOSER_STRUCTURED_HTML_PASTE_LIMIT
    || !html.includes(COMPOSER_DOCUMENT_TOKEN_ATTRIBUTE)) return COMPOSER_HTML_PASTE_LIMIT
  const template = document.createElement('template')
  template.innerHTML = html
  const atom = Array.from(template.content.querySelectorAll(`span[${COMPOSER_DOCUMENT_TOKEN_ATTRIBUTE}]`))
    .some(element => composerClipboardTokenAttributes(element.getAttribute(COMPOSER_DOCUMENT_TOKEN_ATTRIBUTE)))
  return atom ? COMPOSER_STRUCTURED_HTML_PASTE_LIMIT : COMPOSER_HTML_PASTE_LIMIT
}

export function clipboardSelectionUrl(text: string): string | null {
  const candidate = text.trim()
  if (!candidate || /\s/u.test(candidate)) return null
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : null
  } catch { return null }
}

/** Plain paragraph wrappers do not override the editor's active text marks. */
export function clipboardHasRichContent(slice: Slice): boolean {
  if (slice.content.childCount > 1) return true
  let rich = false
  slice.content.descendants(node => {
    rich ||= node.isBlock && node.type.name !== 'paragraph'
      || node.isAtom && node.isInline && !node.isText && node.type.name !== 'hard_break'
      || node.isText && node.marks.length > 0
    return !rich
  })
  return rich
}

function safeClipboardHref(value: string | null | undefined): value is string {
  return !!value && /^(?:https?:|mailto:|klaus:|\/|#)/i.test(value)
}

/** Import visible content without loading pasted media or retaining active HTML. */
export function normalizeClipboardHtml(document: Document, html: string): { html: string; mediaFallback: boolean } {
  if (html.length > clipboardHtmlLimit(document, html)) return { html: '', mediaFallback: false }
  const template = document.createElement('template')
  template.innerHTML = html
  const content = template.content
  content.querySelectorAll('script,style,template,noscript,meta,link,[hidden],[aria-hidden="true"]').forEach(element => element.remove())
  content.querySelectorAll<HTMLElement>('[style]').forEach(element => {
    const style = element.style
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) { element.remove(); return }
    for (const property of ['color','background-color','font-family','font-size','line-height','text-decoration','text-shadow']) style.removeProperty(property)
  })
  for (const math of content.querySelectorAll('math')) {
    if (!content.contains(math)) continue
    const source = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent
      || math.getAttribute('alttext') || math.textContent
    if (!source?.trim()) continue
    const container = math.closest('.katex-display,.math-display') || math.closest('.katex') || math
    const code = document.createElement('code')
    code.textContent = source
    if (math.getAttribute('display') === 'block' || container.matches('.katex-display,.math-display')) {
      code.className = 'language-math'
      const block = document.createElement('pre'); block.setAttribute('data-params', 'math'); block.append(code); container.replaceWith(block)
    } else container.replaceWith(code)
  }
  const tails = new Map<Element, Node>()
  let mediaFallback = false
  for (const media of content.querySelectorAll('img,svg,video,audio,canvas,iframe,object,embed')) {
    if (!content.contains(media)) continue
    mediaFallback = true
    const source = media.getAttribute('src') || media.getAttribute('data') || media.querySelector('source[src]:not([src=""])')?.getAttribute('src')
    const label = [media.getAttribute('alt'), media.getAttribute('aria-label'), media.getAttribute('title'), media.textContent]
      .map(value => value?.trim()).find(Boolean) || (media.localName === 'img' ? 'image' : media.localName)
    const anchor = media.closest('a[href]')
    const link = safeClipboardHref(source) ? document.createElement('a') : null
    if (link && source) link.setAttribute('href', source)
    if (anchor && safeClipboardHref(anchor.getAttribute('href'))) {
      media.replaceWith(document.createTextNode(label))
      if (link && source !== anchor.getAttribute('href')) {
        link.textContent = media.localName === 'img' ? 'image' : media.localName
        const end = document.createTextNode(')')
        const tail = tails.get(anchor) || anchor
        tail.parentNode?.insertBefore(end, tail.nextSibling)
        end.before(document.createTextNode(' ('), link)
        tails.set(anchor, end)
      }
    } else if (link) { link.textContent = label; media.replaceWith(link) }
    else media.replaceWith(document.createTextNode(label))
  }
  content.querySelectorAll('a[href]').forEach(element => {
    if (!safeClipboardHref(element.getAttribute('href'))) element.removeAttribute('href')
  })
  content.querySelectorAll('pre:not([data-params])').forEach(element => {
    const language = element.querySelector('code')?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
    if (language) element.setAttribute('data-params', language)
  })
  return { html: template.innerHTML, mediaFallback }
}
