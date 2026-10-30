// Artifact 预览窗的安全 markdown 渲染器（迁自 js/artifact-markdown.js，UMD 壳换 ES module）。
// artifact.ts 消费具名导出；window.KlausArtifactMarkdown 面保留（外部诊断脚本可能引用）。
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon);base64,[a-z0-9+/=\s]+$/i

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeReference(value: unknown) {
  return String(value ?? '').trim()
}

export function classifyLink(href: unknown): 'blocked' | 'anchor' | 'relative' | 'external' {
  const value = normalizeReference(href)
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return 'blocked'
  if (value.startsWith('#')) return 'anchor'
  if (value.startsWith('//')) return 'blocked'
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  if (!scheme) return 'relative'
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
    ? 'external'
    : 'blocked'
}

function safeImageSource(href: unknown) {
  const value = normalizeReference(href)
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith('//')) return ''
  if (SAFE_DATA_IMAGE.test(value)) return value
  if (/^file:/i.test(value)) return value
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? '' : value
}

function inlineContent(renderer: any, token: any) {
  if (Array.isArray(token?.tokens) && renderer?.parser?.parseInline) {
    return renderer.parser.parseInline(token.tokens)
  }
  return escapeHtml(token?.text ?? '')
}

function createRenderer(markedApi: any) {
  if (typeof markedApi?.Renderer !== 'function') throw new Error('Marked renderer is unavailable')
  const renderer = new markedApi.Renderer()
  renderer.html = function (token: any) {
    return escapeHtml(typeof token === 'object' ? token.text || token.raw || '' : token)
  }
  renderer.link = function (this: any, token: any) {
    const href = normalizeReference(typeof token === 'object' ? token.href : token)
    const label = inlineContent(this, typeof token === 'object' ? token : { text: href })
    if (classifyLink(href) === 'blocked') return label
    const title = token?.title ? ` title="${escapeHtml(token.title)}"` : ''
    return `<a href="${escapeHtml(href)}"${title}>${label}</a>`
  }
  renderer.image = function (token: any) {
    const source = safeImageSource(typeof token === 'object' ? token.href : token)
    const alt = escapeHtml(typeof token === 'object' ? token.text || '' : '')
    if (!source) return alt
    const title = token?.title ? ` title="${escapeHtml(token.title)}"` : ''
    return `<img src="${escapeHtml(source)}" alt="${alt}"${title}>`
  }
  return renderer
}

export function render(markedApi: any, markdown: unknown): string {
  if (typeof markedApi?.parse !== 'function') throw new Error('Marked parser is unavailable')
  return String(markedApi.parse(String(markdown ?? ''), {
    gfm: true,
    renderer: createRenderer(markedApi),
  }) ?? '')
}

const api = Object.freeze({ classifyLink, render })
if (typeof globalThis !== 'undefined') (globalThis as any).KlausArtifactMarkdown = api
