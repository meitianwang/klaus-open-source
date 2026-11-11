import { Marked, Renderer } from 'marked'
import hljs from 'highlight.js/lib/common'
import katex from 'katex'
import { isLocalPathLikeHref, matchFileCiteDirective, parseFileCitation, playableMediaKind, FILE_CITE_PREFIX, type FileCitation } from '../../../contracts/file-citation'
import { normalizeImageHrefToPath } from './markdown-media'

export interface MarkdownPipelineEnvironment {
  resolveImageSrc(href: string, sessionId: string): string
  fileIconSvg(path: string): string
  highlightCode?: boolean
}

function escapeHtml(str: unknown): string {
  return str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''
}

function normalizeCodeLanguage(lang: unknown): string {
  const text = String(lang || '').trim().split(/\s+/)[0] || ''
  return text.replace(/^language-/i, '').toLowerCase()
}

/** Markdown links and explicit directives share the same accessible file reference. */
function fileCitationHtml(citation: FileCitation, label: string, sessionId: string, fileIconSvg: (path: string) => string): string {
  const suffix = citation.location ? `:${citation.location.line}` : ''
  return `<button type="button" class="md-file-citation" data-file-path="${escapeHtml(citation.path)}"`
    + `${sessionId ? ` data-file-session="${escapeHtml(sessionId)}"` : ''}`
    + `${citation.location ? ` data-file-line="${citation.location.line}"` : ''}`
    + `${citation.location?.column ? ` data-file-column="${citation.location.column}"` : ''}`
    + `${citation.location?.endLine ? ` data-file-end-line="${citation.location.endLine}"` : ''}`
    + ` aria-label="${escapeHtml(label)}${suffix}">`
    + `<span class="md-file-citation-icon" aria-hidden="true">${fileIconSvg(citation.path)}</span>`
    + `<span class="md-file-citation-label">${escapeHtml(label)}${suffix ? `<span class="md-file-citation-line">${suffix}</span>` : ''}</span></button>`
}

const DOUBLE_TILDE_STRIKETHROUGH = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/

function doubleTildeStrikethrough(this: { lexer: { inlineTokens(src: string): unknown[] } }, src: string) {
  const cap = DOUBLE_TILDE_STRIKETHROUGH.exec(src)
  if (!cap) return undefined
  return {
    type: 'del',
    raw: cap[0],
    text: cap[2],
    tokens: this.lexer.inlineTokens(cap[2]),
  }
}

export function createMarkdownPipeline(sessionId: string, { resolveImageSrc, fileIconSvg, highlightCode = true }: MarkdownPipelineEnvironment) {
  const renderer = new Renderer()
  // Security: escape raw HTML
  renderer.html = function (token: any) {
    const text = typeof token === 'object' ? token.text || token.raw || '' : token
    return escapeHtml(text)
  } as any
  // Links open in new tab
  renderer.link = function (token: any) {
    const href = typeof token === 'object' ? token.href : token
    const text = typeof token === 'object' ? token.text : undefined
    // A local path destination is a FILE CITATION, not a navigation: the
    // transcript renders an inline reference the click delegate opens in
    // the workspace panel (with the cited line when the destination carries a
    // location suffix). A bare `file://` anchor would die at the window's
    // navigation guard, so refusing to emit one is the honest shape.
    const citation = parseFileCitation(String(href || ''))
    if (citation) return fileCitationHtml(citation, text || citation.citedPath, sessionId, fileIconSvg)
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${text || href}</a>`
  } as any
  renderer.image = function (token: any) {
    const raw = typeof token === 'object' ? token.href : token
    const alt = escapeHtml(typeof token === 'object' ? (token.text || '') : '')
    const path = normalizeImageHrefToPath(String(raw || ''))
    // A playable audio/video source is NOT a picture: the markdown image syntax
    // is how a reply cites media, and an `<img>` for an mp3 is a broken picture.
    // The card shell carries the media URL as a data attribute; the mount pass
    // (transcript media-player.ts) fills in the native element and the custom
    // controls after commit, because a raw `<audio>`/`<video>` in the memoized
    // HTML would restart playback on every re-render of the bubble.
    const kind = path ? playableMediaKind(path) : null
    if (kind) {
      const src = resolveImageSrc(String(raw || ''), sessionId)
      const name = alt || escapeHtml(path.split(/[\\/]/).pop() || kind)
      return `<span class="md-media-player" data-media-kind="${kind}" data-media-session="${escapeHtml(sessionId)}" data-media-path="${escapeHtml(path)}" data-media-src="${escapeHtml(src)}" data-media-name="${name}" aria-label="${name}"><span class="md-media-player-skeleton" aria-hidden="true"></span></span>`
    }
    const src = resolveImageSrc(String(raw || ''), sessionId)
    if (!src) return alt
    const title = token?.title ? ` title="${escapeHtml(token.title)}"` : ''
    return `<span class="md-media-figures"><button class="md-media-figure" type="button" data-media-figure="1" data-media-session="${escapeHtml(sessionId)}" data-media-path="${escapeHtml(path)}" aria-label="${alt || escapeHtml(path.split(/[\\/]/).pop() || 'image')}"${title}>`
      + `<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy"></button></span>`
  } as any
  // Code blocks with hljs
  renderer.code = function (token: any) {
    const code = typeof token === 'object' ? token.text : token
    const lang = normalizeCodeLanguage(typeof token === 'object' ? token.lang : undefined)
    let highlighted = escapeHtml(code)
    let resolvedLang = lang
    if (highlightCode && lang && hljs.getLanguage(lang)) {
      try {
        const result = hljs.highlight(code, { language: lang, ignoreIllegals: true })
        highlighted = result.value
        resolvedLang = result.language || lang
      } catch {}
    } else if (highlightCode && !lang) {
      try {
        const result = hljs.highlightAuto(code)
        highlighted = result.value
        resolvedLang = result.language || ''
      } catch {}
    }
    const classes = ['hljs']
    if (resolvedLang) classes.push(`language-${escapeHtml(resolvedLang)}`)
    return `<pre><code class="${classes.join(' ')}">${highlighted}</code></pre>`
  } as any

  const instance = new Marked({ breaks: true, gfm: true, renderer, tokenizer: { del: doubleTildeStrikethrough as any } })

  const renderTex = (tex: string, display: boolean) => {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false })
    } catch {
      const d = display ? '$$' : '$'
      return escapeHtml(d + tex + d)
    }
  }
  instance.use({
    extensions: [
      {
        name: 'blockMath',
        level: 'block',
        start(src: string) { const i = src.indexOf('$$'); return i < 0 ? undefined : i },
        tokenizer(src: string) {
          const m = /^\$\$\s*([\s\S]+?)\s*\$\$(?:\n+|$)/.exec(src)
          if (m) return { type: 'blockMath', raw: m[0], text: m[1] } as any
          return undefined
        },
        renderer(token: any) { return renderTex(token.text, true) },
      },
      {
        name: 'inlineMath',
        level: 'inline',
        start(src: string) { const i = src.indexOf('$'); return i < 0 ? undefined : i },
        tokenizer(src: string) {
          let m = /^\$\$([^\n]+?)\$\$/.exec(src)
          if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true } as any
          m = /^\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src)
          if (m) return { type: 'inlineMath', raw: m[0], text: m[1], display: false } as any
          return undefined
        },
        renderer(token: any) { return renderTex(token.text, token.display) },
      },
      {
        // The explicit file-citation directive, the second citation channel
        // Inline level and anchored at the current position, so a directive
        // is code, exactly the ranges the citation extractor leaves alone.
        name: 'fileCite',
        level: 'inline',
        start(src: string) { const i = src.indexOf(FILE_CITE_PREFIX); return i < 0 ? undefined : i },
        tokenizer(src: string) {
          const match = matchFileCiteDirective(src)
          if (!match) return undefined
          return { type: 'fileCite', raw: src.slice(0, match.length), directive: match.directive } as any
        },
        renderer(token: any) {
          const directive = token.directive as { path: string; caption?: string }
          const citation = parseFileCitation(directive.path)
          // An unreadable destination degrades to its literal text, the same
          // shape an unparsable directive gets: never a chip that opens nothing.
          if (!citation) return escapeHtml(token.raw)
          return fileCitationHtml(citation, directive.caption || citation.citedPath, sessionId, fileIconSvg)
        },
      },
    ],
  })

  return Object.assign((text: string) => instance.parse(text) as string, { lex: (text: string) => instance.lexer(text) })
}


export type MarkdownPipeline = ReturnType<typeof createMarkdownPipeline>
