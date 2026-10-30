// Standalone artifact preview window. Loads file via klausApi.artifacts.read,
// renders markdown / SVG / source code, supports source/preview toggle.
//（迁自 js/artifact.js，逻辑原样；KlausArtifactMarkdown 改显式 import。）
import { classifyLink, render as renderSafeMarkdown } from './artifact-markdown'
import { writeClipboardText } from '../clipboard'

document.documentElement.classList.add(/win/i.test(navigator.platform) ? 'platform-win32' : 'platform-darwin')

const klausApi = (window as any).klaus
const text = (key: string, fallback: string): string => (window as any).tt?.(key) || fallback
const preferencesReady = Promise.resolve((window as any).loadPreferences?.()).catch(() => {})

const params = new URLSearchParams(window.location.search)
const sessionId = params.get('sessionId') || ''
const filePath = params.get('filePath') || ''
const displayName = params.get('displayName') || ''
// kind ∈ 'artifact' | 'memory' | 'skill'. Memory files come from the
// dream/extractMemories memory dir and read via memory:read-file (no
// sessionId scoping); skills come from ~/.klaus/skills/ and read via
// skills:read-file; artifacts read via the session-scoped artifacts:read.
// Default to 'artifact' for back-compat with old callers that didn't pass kind.
const kindParam = params.get('kind')
const kind = kindParam === 'memory' ? 'memory'
  : kindParam === 'skill' ? 'skill'
  : 'artifact'

const FILE_TYPE_LABELS: Record<string, string> = {
  md: 'Markdown', markdown: 'Markdown',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', jsx: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
  java: 'Java', kt: 'Kotlin', swift: 'Swift',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  cs: 'C#', php: 'PHP', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
  xml: 'XML', svg: 'SVG', sql: 'SQL', csv: 'CSV',
  txt: 'Text', log: 'Log', conf: 'Config', ini: 'Config', env: 'Config',
}
const DIRECT_PREVIEW_EXTS: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', avif: 'image',
  pdf: 'pdf',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', ogv: 'video',
}
const UNSUPPORTED_PREVIEW_EXTS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key',
  'zip', 'gz', 'tgz', 'rar', '7z', 'tar', 'dmg', 'pkg',
])
function fileExt(p: string) {
  const m = /\.([A-Za-z0-9]+)$/.exec(p || '')
  return m ? m[1].toLowerCase() : ''
}
function fileTypeLabel(p: string) {
  const ext = fileExt(p)
  if (!ext) return ''
  return FILE_TYPE_LABELS[ext] || ext.toUpperCase()
}
function fileBaseName(p: string) {
  if (!p) return ''
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(idx + 1) : p
}
function directPreviewKind(p: string) {
  return DIRECT_PREVIEW_EXTS[fileExt(p)] || ''
}
function isExternalResourceRef(ref: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref || '')
}
function splitResourceRef(ref: string) {
  let cut = ref.length
  const queryIdx = ref.indexOf('?')
  const hashIdx = ref.indexOf('#')
  if (queryIdx >= 0) cut = Math.min(cut, queryIdx)
  if (hashIdx >= 0) cut = Math.min(cut, hashIdx)
  return { path: ref.slice(0, cut), suffix: ref.slice(cut) }
}
function decodeResourcePath(p: string) {
  try { return decodeURI(p) } catch { return p }
}
function dirnamePath(p: string) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(0, idx + 1) : ''
}
function isAbsoluteLocalPath(p: string) {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p || '')
}
function normalizeLocalPath(p: string) {
  const useBackslash = p.includes('\\') && !p.includes('/')
  const normalizedInput = p.replace(/\\/g, '/')
  let prefix = ''
  let rest = normalizedInput
  const drive = /^[A-Za-z]:\//.exec(rest)
  if (drive) {
    prefix = drive[0]
    rest = rest.slice(prefix.length)
  } else if (rest.startsWith('/')) {
    prefix = '/'
    rest = rest.replace(/^\/+/, '')
  }
  const out: string[] = []
  rest.split('/').forEach(part => {
    if (!part || part === '.') return
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!prefix) out.push(part)
      return
    }
    out.push(part)
  })
  const joined = prefix + out.join('/')
  return useBackslash ? joined.replace(/\//g, '\\') : joined
}
function resolveLocalResourcePath(baseFile: string, ref: string) {
  const parsed = splitResourceRef(ref)
  if (!parsed.path) return ''
  const resourcePath = decodeResourcePath(parsed.path)
  if (isAbsoluteLocalPath(resourcePath)) return normalizeLocalPath(resourcePath)
  return normalizeLocalPath(dirnamePath(baseFile) + resourcePath)
}

const titleEl = document.getElementById('aw-title')
const filenameEl = document.getElementById('aw-filename')
const filetypeEl = document.getElementById('aw-filetype')
const bodyEl = document.getElementById('aw-body')!
const truncEl = document.getElementById('aw-truncated')!
const copyBtn = document.getElementById('aw-copy')
const folderBtn = document.getElementById('aw-folder')
const actionErrorEl = document.getElementById('aw-action-error')
// macOS has Finder; Windows/Linux don't — show the right file-manager name.
if (folderBtn && !/Mac|iPhone|iPad|iPod/i.test(navigator.platform || '')) {
  ;(folderBtn as HTMLElement).title = 'Show in File Explorer'
  folderBtn.setAttribute('aria-label', 'Show in File Explorer')
}
const viewToggle = document.getElementById('aw-viewtoggle')
const viewSourceBtn = document.getElementById('aw-view-source')
const viewPreviewBtn = document.getElementById('aw-view-preview')

const baseName = displayName || fileBaseName(filePath)
const isMd = /\.(md|markdown)$/i.test(filePath)
const isSvg = /\.svg$/i.test(filePath)
const directKind = directPreviewKind(filePath)
const isUnsupportedPreview = UNSUPPORTED_PREVIEW_EXTS.has(fileExt(filePath))
const canPreview = isMd || isSvg || !!directKind
let content = ''
let view = canPreview ? 'preview' : 'source'
let previewObjectUrl = ''

function clearActionError() {
  if (!actionErrorEl) return
  actionErrorEl.textContent = ''
  actionErrorEl.hidden = true
}

function showActionError(key: string, fallback: string, error: unknown) {
  if (!actionErrorEl) return
  const detail = error instanceof Error ? error.message : String(error || '')
  const label = text(key, fallback)
  actionErrorEl.textContent = detail && detail !== label ? `${label}: ${detail}` : label
  actionErrorEl.hidden = false
}

async function runAction(key: string, fallback: string, action: () => Promise<unknown>) {
  clearActionError()
  try {
    const result: any = await action()
    if (result?.ok === false || result?.error) throw new Error(result?.error || fallback)
  } catch (error) {
    showActionError(key, fallback, error)
  }
}

document.title = baseName
if (titleEl) titleEl.textContent = baseName
if (filenameEl) { filenameEl.textContent = baseName; filenameEl.title = filePath }
if (filetypeEl) filetypeEl.textContent = fileTypeLabel(filePath)
if (viewToggle) viewToggle.classList.toggle('is-hidden', !(isMd || isSvg))

function revokePreviewObjectUrl() {
  if (!previewObjectUrl) return
  URL.revokeObjectURL(previewObjectUrl)
  previewObjectUrl = ''
}

function syncToggle() {
  if (viewSourceBtn) viewSourceBtn.classList.toggle('is-active', view === 'source')
  if (viewPreviewBtn) viewPreviewBtn.classList.toggle('is-active', view === 'preview')
}

function renderSource() {
  revokePreviewObjectUrl()
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = content
  pre.appendChild(code)
  bodyEl.innerHTML = ''
  bodyEl.appendChild(pre)
  const hljs = (window as any).hljs
  if (typeof hljs !== 'undefined') {
    try { hljs.highlightElement(code) } catch {}
  }
}

function renderMessage(message: string) {
  revokePreviewObjectUrl()
  const wrap = document.createElement('div')
  wrap.className = 'aw-preview-message'
  wrap.textContent = message
  bodyEl.innerHTML = ''
  bodyEl.appendChild(wrap)
}

// Skill/memory files carry a YAML frontmatter block (name/description/
// metadata …) meant for the loader, not the reader — markdown renderers
// mash it into one bold paragraph. Strip it in preview; source view keeps
// the raw file.
function stripFrontmatter(text: string) {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(text || '')
  return match ? text.slice(match[0].length).replace(/^\s+/, '') : text
}

function renderSvgPreview() {
  revokePreviewObjectUrl()
  const blob = new Blob([content], { type: 'image/svg+xml' })
  previewObjectUrl = URL.createObjectURL(blob)

  const wrap = document.createElement('div')
  wrap.className = 'aw-svg-preview'
  const img = document.createElement('img')
  img.alt = baseName
  img.src = previewObjectUrl
  img.onerror = () => {
    view = 'source'
    syncToggle()
    renderSource()
  }
  wrap.appendChild(img)
  bodyEl.innerHTML = ''
  bodyEl.appendChild(wrap)
}

async function resolveDirectPreviewUrl() {
  if (kind !== 'artifact') {
    throw new Error('Preview is only available for workspace artifacts')
  }
  const data = await klausApi?.artifacts?.fileUrl?.(sessionId, filePath)
  const errMsg = (data && data.ok === false ? data.error : data?.error)
  if (errMsg) throw new Error(errMsg)
  if (!data?.url) throw new Error('missing preview URL')
  return data.url
}

function renderDirectPreview(url: string, previewKind: string) {
  revokePreviewObjectUrl()
  const wrap = document.createElement('div')
  wrap.className = 'aw-media-preview aw-media-preview-' + previewKind
  let el: HTMLElement | undefined
  if (previewKind === 'image') {
    const img = document.createElement('img')
    img.alt = baseName
    img.src = url
    img.onerror = () => renderMessage('Preview is not available for this image.')
    el = img
  } else if (previewKind === 'pdf') {
    const frame = document.createElement('iframe')
    frame.title = baseName
    frame.src = url
    el = frame
  } else if (previewKind === 'audio') {
    const audio = document.createElement('audio')
    audio.controls = true
    audio.preload = 'metadata'
    audio.src = url
    audio.onerror = () => renderMessage('Preview is not available for this audio file.')
    el = audio
  } else if (previewKind === 'video') {
    const video = document.createElement('video')
    video.controls = true
    video.preload = 'metadata'
    video.src = url
    video.onerror = () => renderMessage('Preview is not available for this video file.')
    el = video
  }
  if (!el) {
    renderMessage('Preview is not available for this file type.')
    return
  }
  wrap.appendChild(el)
  bodyEl.innerHTML = ''
  bodyEl.appendChild(wrap)
}

function rewriteMarkdownImages(root: HTMLElement) {
  if (kind !== 'artifact') return
  root.querySelectorAll<HTMLImageElement>('img[src]').forEach(img => {
    const originalSrc = img.getAttribute('src') || ''
    if (!originalSrc || isExternalResourceRef(originalSrc)) return
    const imagePath = resolveLocalResourcePath(filePath, originalSrc)
    if (!imagePath) return
    img.loading = 'lazy'
    img.title = img.title || originalSrc
    klausApi?.artifacts?.fileUrl?.(sessionId, imagePath).then((data: any) => {
      const errMsg = (data && data.ok === false ? data.error : data?.error)
      if (!errMsg && data?.url) img.src = data.url
    }).catch(() => {})
  })
}

function renderPreview() {
  const marked = (window as any).marked
  if (isMd && typeof marked !== 'undefined') {
    revokePreviewObjectUrl()
    try {
      const previewContent = (kind === 'skill' || kind === 'memory') ? stripFrontmatter(content) : content
      bodyEl.innerHTML = renderSafeMarkdown(marked, previewContent)
    } catch (err) {
      console.warn('[artifact] safe markdown preview unavailable:', err)
      view = 'source'
      syncToggle()
      renderSource()
      return
    }
    rewriteMarkdownImages(bodyEl)
    // Hijack relative links: a markdown index file (MEMORY.md typically)
    // links to sibling .md files with bare relative paths. Default browser
    // behavior would navigate the BrowserWindow itself to file://.../foo.md
    // (usually 404). Instead, intercept and open each in another preview
    // window of the same kind so the user can browse memory pages without
    // losing the index.
    bodyEl.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
      const href = a.getAttribute('href') || ''
      const target = classifyLink(href)
      if (target === 'anchor') return
      a.addEventListener('click', (e) => {
        e.preventDefault()
        if (target === 'external') {
          void runAction('artifacts_action_open_failed', 'Could not open this item', async () => {
            if (typeof klausApi?.app?.openExternal !== 'function') throw new Error('Open action unavailable')
            return klausApi.app.openExternal(href)
          })
          return
        }
        if (target !== 'relative') return
        const absPath = resolveLocalResourcePath(filePath, href)
        if (kind === 'memory') {
          void runAction('artifacts_action_open_failed', 'Could not open this item', async () => {
            if (typeof klausApi?.memory?.openWindow !== 'function') throw new Error('Open action unavailable')
            return klausApi.memory.openWindow(absPath)
          })
        } else {
          void runAction('artifacts_action_open_failed', 'Could not open this item', async () => {
            if (typeof klausApi?.artifacts?.openWindow !== 'function') throw new Error('Open action unavailable')
            return klausApi.artifacts.openWindow(sessionId, absPath)
          })
        }
      })
    })
  } else if (isSvg) {
    renderSvgPreview()
  } else {
    renderSource()
  }
}

function setView(next: string) {
  const target = canPreview && next === 'preview' ? 'preview' : 'source'
  if (target === view) return
  view = target
  syncToggle()
  if (!content) return
  const scrollTop = bodyEl.scrollTop
  bodyEl.classList.add('is-swapping')
  setTimeout(() => {
    if (view === 'preview') renderPreview()
    else renderSource()
    bodyEl.scrollTop = scrollTop
    requestAnimationFrame(() => bodyEl.classList.remove('is-swapping'))
  }, 120)
}

viewSourceBtn?.addEventListener('click', () => setView('source'))
viewPreviewBtn?.addEventListener('click', () => setView('preview'))
copyBtn?.addEventListener('click', () => {
  if (!filePath) return
  void runAction('artifacts_action_copy_failed', 'Could not copy the path', async () => {
    return writeClipboardText(filePath)
  })
})
folderBtn?.addEventListener('click', () => {
  if (filePath) {
    void runAction('artifacts_action_reveal_failed', 'Could not reveal this file', async () => {
      if (typeof klausApi?.artifacts?.reveal !== 'function') throw new Error('Reveal action unavailable')
      return klausApi.artifacts.reveal(filePath)
    })
  } else if (sessionId) {
    void runAction('artifacts_action_open_failed', 'Could not open this item', async () => {
      if (typeof klausApi?.artifacts?.openWorkspace !== 'function') throw new Error('Open action unavailable')
      return klausApi.artifacts.openWorkspace(sessionId)
    })
  }
})
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') { e.preventDefault(); window.close() }
})
window.addEventListener('beforeunload', revokePreviewObjectUrl)

syncToggle()

;(async () => {
  await preferencesReady
  bodyEl.textContent = text('artifacts_loading', 'Loading…')
  try {
    if (directKind) {
      if (kind !== 'artifact') {
        renderMessage('Preview is not available for this file type.')
        truncEl.style.display = 'none'
        return
      }
      const url = await resolveDirectPreviewUrl()
      renderDirectPreview(url, directKind)
      truncEl.style.display = 'none'
      return
    }
    if (isUnsupportedPreview) {
      renderMessage('Preview is not available for this file type. Use the folder button to open it in another app.')
      truncEl.style.display = 'none'
      return
    }
    // Memory files come back as { ok, content, truncated, error? }; artifacts
    // come back as { content, truncated, error? }. Skill files use the same
    // shape as memory (Klaus extension). Normalize all three.
    const data = kind === 'memory'
      ? await klausApi.memory.readFile(filePath)
      : kind === 'skill'
      ? await klausApi.skills.readFile(filePath)
      : await klausApi.artifacts.read(sessionId, filePath)
    const errMsg = (data && data.ok === false ? data.error : data?.error)
    if (errMsg) {
      console.warn('[artifact]', kind, 'read returned error:', errMsg, 'filePath=', filePath, 'data=', data)
      bodyEl.textContent = errMsg === 'file not found'
        ? text('artifacts_file_missing', 'File no longer exists')
        : `${text('artifacts_load_failed', 'Failed to load file')} (${errMsg})`
      return
    }
    content = data?.content || ''
    if (view === 'preview') renderPreview()
    else renderSource()
    truncEl.style.display = data?.truncated ? 'block' : 'none'
  } catch (err) {
    console.error('[artifact] load threw:', err, { kind, filePath, sessionId })
    bodyEl.textContent = `${text('artifacts_load_failed', 'Failed to load file')} (${err instanceof Error ? err.message : String(err)})`
  }
})()

export {}
