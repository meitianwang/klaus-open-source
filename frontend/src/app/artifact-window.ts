// Standalone artifact preview window. Loads file via klausApi.artifacts.read,
// renders markdown / HTML / SVG / Office / XMind / CSV / source code, and
// supports source/preview toggle plus in-place document editing.
import { parseDelimitedSpreadsheet, serializeDelimitedSpreadsheet } from '../../../contracts/office-formula'
import {
  isInPlaceWritableOfficeExtension,
  isRecognizedUnsupportedMediaExtension,
  isTextSpreadsheetExtension,
  type OfficePreviewPayload,
} from '../../../contracts/office-preview'
import { classifyLink, render as renderSafeMarkdown } from './artifact-markdown'
import { attachHtmlDocumentToc } from '../chat/markdown-toc'
import type { MountedOfficeViewer } from '../chat/workspace-office-viewer'
import { writeClipboardText } from '../clipboard'

document.documentElement.classList.add(/win/i.test(navigator.platform) ? 'platform-win32' : 'platform-darwin')

const klausApi = (window as any).klaus
const text = (key: string, fallback: string, vars?: Record<string, string | number>): string => {
  const translated = (window as any).tt?.(key)
  let resolved = translated && translated !== key ? translated : fallback
  if (vars) {
    for (const [k, v] of Object.entries(vars)) resolved = resolved.replaceAll(`{${k}}`, String(v))
  }
  return resolved
}
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
  md: 'Markdown', markdown: 'Markdown', mdown: 'Markdown', mkd: 'Markdown',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', jsx: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
  java: 'Java', kt: 'Kotlin', swift: 'Swift',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  cs: 'C#', php: 'PHP', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  html: 'HTML', htm: 'HTML', xhtml: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
  xml: 'XML', svg: 'SVG', sql: 'SQL', csv: 'CSV', tsv: 'TSV', xmind: 'XMind',
  xls: 'Excel', xlsx: 'Excel', xlt: 'Excel', doc: 'Word', docx: 'Word', dot: 'Word',
  ppt: 'PowerPoint', pptx: 'PowerPoint', pot: 'PowerPoint', ppsm: 'PowerPoint',
  pdf: 'PDF', xlsm: 'Excel', xltx: 'Excel', xltm: 'Excel', docm: 'Word', dotx: 'Word', dotm: 'Word', rtf: 'RTF',
  pptm: 'PowerPoint', ppsx: 'PowerPoint', potx: 'PowerPoint', potm: 'PowerPoint', pps: 'PowerPoint',
  wps: 'WPS Writer', wpt: 'WPS Template', et: 'WPS Spreadsheets', ett: 'WPS Template', dps: 'WPS Presentation', dpt: 'WPS Template',
  ods: 'Spreadsheet', odt: 'Document', odp: 'Presentation',
  '3gp': 'Video', mkv: 'MKV', avi: 'AVI', wmv: 'WMV', flv: 'FLV', wma: 'WMA',
  txt: 'Text', log: 'Log', conf: 'Config', ini: 'Config', env: 'Config',
}
const DIRECT_PREVIEW_EXTS: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', avif: 'image',
  pdf: 'pdf',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', ogv: 'video', '3gp': 'video',
}
const UNSUPPORTED_PREVIEW_EXTS = new Set([
  'pages', 'numbers', 'key',
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
  return DIRECT_PREVIEW_EXTS[fileExt(p)]
    || (isRecognizedUnsupportedMediaExtension(p || '') ? 'unsupported-media' : '')
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
const mainEl = document.getElementById('aw-main')
const bodyEl = document.getElementById('aw-body')!
const markdownToc = mainEl
  ? attachHtmlDocumentToc({ host: mainEl, scrollContainer: bodyEl, contentContainer: bodyEl, translate: key => text(key, key) })
  : null
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
const isMd = /\.(md|markdown|mdown|mkd)$/i.test(filePath)
const isSvg = /\.svg$/i.test(filePath)
const isHtml = kind === 'artifact' && /\.(html?|xhtml)$/i.test(filePath)
const isCsvTsv = kind === 'artifact' && isTextSpreadsheetExtension(filePath)
const directKind = directPreviewKind(filePath)
const isUnsupportedPreview = UNSUPPORTED_PREVIEW_EXTS.has(fileExt(filePath))
const canTogglePreview = isMd || isSvg || isHtml || isCsvTsv
const canPreview = canTogglePreview || !!directKind
let content = ''
let htmlPreviewUrl = ''
let view = canPreview ? 'preview' : 'source'
let previewObjectUrl = ''
let officePayload: OfficePreviewPayload | null = null
let officeWritable = false
let fileMtimeMs: number | null = null
let savedOfficeJson = ''
let dirty = false
let mountedOffice: MountedOfficeViewer | null = null

function updateWindowTitle() {
  const label = `${dirty ? '• ' : ''}${baseName}`
  document.title = label
  if (titleEl) titleEl.textContent = label
}

function clearMountedOffice() {
  if (!mountedOffice) return
  mountedOffice.destroy()
  mountedOffice = null
}

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

updateWindowTitle()
if (filenameEl) { filenameEl.textContent = baseName; filenameEl.title = filePath }
if (filetypeEl) filetypeEl.textContent = fileTypeLabel(filePath)
if (viewToggle) viewToggle.classList.toggle('is-hidden', !canTogglePreview)

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
  clearMountedOffice()
  bodyEl.classList.remove('is-office-mode')
  markdownToc?.setEnabled(false)
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
  clearMountedOffice()
  bodyEl.classList.remove('is-office-mode')
  markdownToc?.setEnabled(false)
  revokePreviewObjectUrl()
  const wrap = document.createElement('div')
  wrap.className = 'aw-preview-message'
  wrap.textContent = message
  bodyEl.innerHTML = ''
  bodyEl.appendChild(wrap)
}

function renderUnsupportedMediaCard() {
  clearMountedOffice()
  bodyEl.classList.remove('is-office-mode')
  markdownToc?.setEnabled(false)
  revokePreviewObjectUrl()
  const card = document.createElement('div')
  card.className = 'aw-unsupported-card'
  const ext = fileExt(filePath) || 'media'
  const title = document.createElement('div')
  title.className = 'aw-unsupported-title'
  title.textContent = text('office_preview_media_unsupported_title', 'Cannot play .{ext} in built-in player', { ext })
  const desc = document.createElement('div')
  desc.className = 'aw-unsupported-desc'
  desc.textContent = text('office_preview_media_unsupported_desc', 'This audio or video container uses codecs that are not supported for inline playback. Open it in your system media player.')
  const actions = document.createElement('div')
  actions.className = 'aw-unsupported-actions'

  const openBtn = document.createElement('button')
  openBtn.type = 'button'
  openBtn.className = 'aw-unsupported-btn aw-unsupported-btn-primary'
  openBtn.textContent = text('office_preview_media_open_default', 'Open in Default App')
  openBtn.addEventListener('click', () => {
    void runAction('artifacts_action_open_failed', 'Could not open this item', async () => {
      if (typeof klausApi?.artifacts?.openDefault !== 'function') throw new Error('Open action unavailable')
      return klausApi.artifacts.openDefault(sessionId, filePath)
    })
  })

  const revealBtn = document.createElement('button')
  revealBtn.type = 'button'
  revealBtn.className = 'aw-unsupported-btn'
  revealBtn.textContent = text('office_preview_media_reveal', 'Show in Folder')
  revealBtn.addEventListener('click', () => {
    void runAction('artifacts_action_reveal_failed', 'Could not reveal this file', async () => {
      if (typeof klausApi?.artifacts?.reveal !== 'function') throw new Error('Reveal action unavailable')
      return klausApi.artifacts.reveal(filePath)
    })
  })

  actions.appendChild(openBtn)
  actions.appendChild(revealBtn)
  card.appendChild(title)
  card.appendChild(desc)
  card.appendChild(actions)
  bodyEl.innerHTML = ''
  bodyEl.appendChild(card)
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
  clearMountedOffice()
  bodyEl.classList.remove('is-office-mode')
  markdownToc?.setEnabled(false)
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

async function renderHtmlPreview() {
  clearMountedOffice()
  bodyEl.classList.remove('is-office-mode')
  markdownToc?.setEnabled(false)
  revokePreviewObjectUrl()
  let src = htmlPreviewUrl
  if (!src && typeof klausApi?.artifacts?.fileUrl === 'function') {
    const res = await klausApi.artifacts.fileUrl(sessionId, filePath).catch(() => null)
    if (res?.url && !res?.error) {
      htmlPreviewUrl = res.url
      src = res.url
    }
  }
  if (!src) {
    const blob = new Blob([content], { type: 'text/html;charset=utf-8' })
    previewObjectUrl = URL.createObjectURL(blob)
    src = previewObjectUrl
  }
  if (view !== 'preview') return
  const wrap = document.createElement('div')
  wrap.className = 'aw-html-preview'
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  iframe.setAttribute('aria-label', baseName)
  iframe.src = src
  wrap.appendChild(iframe)
  bodyEl.innerHTML = ''
  bodyEl.appendChild(wrap)
}

function renderDirectPreview(url: string, previewKind: string) {
  clearMountedOffice()
  bodyEl.classList.remove('is-office-mode')
  markdownToc?.setEnabled(false)
  revokePreviewObjectUrl()
  if (previewKind === 'unsupported-media') {
    renderUnsupportedMediaCard()
    return
  }
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
    audio.onerror = () => renderUnsupportedMediaCard()
    if (/\.ogg$/i.test(filePath)) {
      const probe = document.createElement('video')
      probe.preload = 'metadata'
      probe.muted = true
      probe.src = url
      probe.onloadedmetadata = () => {
        const hasVideo = probe.videoWidth > 0
        probe.removeAttribute('src')
        probe.load()
        if (hasVideo) renderDirectPreview(url, 'video')
      }
      probe.onerror = () => { probe.removeAttribute('src') }
    }
    el = audio
  } else if (previewKind === 'video') {
    const video = document.createElement('video')
    video.controls = true
    video.preload = 'metadata'
    video.src = url
    video.onerror = () => renderUnsupportedMediaCard()
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

async function saveOfficeInWindow(nextPayload: OfficePreviewPayload) {
  if (!officeWritable || typeof klausApi?.artifacts?.writeOffice !== 'function') {
    return { ok: false, error: text('workspace_file_readonly', 'Read-only') }
  }
  const res = await klausApi.artifacts.writeOffice(sessionId, filePath, nextPayload, { expectedMtimeMs: fileMtimeMs })
  if (!res?.ok) {
    return { ok: false, conflict: !!res?.conflict, error: res?.error || text('office_preview_status_error', 'Save failed') }
  }
  officePayload = nextPayload
  if (isCsvTsv && nextPayload.kind === 'spreadsheet') {
    content = serializeDelimitedSpreadsheet(nextPayload, fileExt(filePath) === 'tsv' ? '\t' : ',')
  }
  fileMtimeMs = res.mtimeMs ?? fileMtimeMs
  savedOfficeJson = JSON.stringify(nextPayload)
  dirty = false
  updateWindowTitle()
  return { ok: true, mtimeMs: fileMtimeMs }
}

async function saveOfficeAsInWindow(nextPayload: OfficePreviewPayload) {
  if (typeof klausApi?.artifacts?.saveOfficeAs !== 'function') {
    return { ok: false, error: text('office_preview_status_error', 'Save failed') }
  }
  const res = await klausApi.artifacts.saveOfficeAs(sessionId, filePath, nextPayload)
  if (res?.cancelled) return { ok: false, error: 'cancelled' }
  if (!res?.ok) return { ok: false, error: res?.error || text('office_preview_status_error', 'Save failed') }
  return { ok: true, savedPath: res.savedPath, mtimeMs: res.mtimeMs }
}

async function renderOfficePreview(payload: OfficePreviewPayload) {
  clearMountedOffice()
  markdownToc?.setEnabled(false)
  revokePreviewObjectUrl()
  const { mountOfficeViewer } = await import('../chat/workspace-office-viewer')
  bodyEl.classList.add('is-office-mode')
  bodyEl.replaceChildren()
  const editable = kind === 'artifact' && payload.kind !== 'pdf' && payload.kind !== 'error'
  mountedOffice = mountOfficeViewer(bodyEl, payload, {
    translate: (key, vars) => text(key, key, vars),
    editable,
    canSaveInPlace: officeWritable,
    singleSheet: isCsvTsv,
    dirty,
    onChange: nextPayload => {
      officePayload = nextPayload
      if (isCsvTsv && nextPayload.kind === 'spreadsheet') {
        content = serializeDelimitedSpreadsheet(nextPayload, fileExt(filePath) === 'tsv' ? '\t' : ',')
      }
      dirty = JSON.stringify(nextPayload) !== savedOfficeJson
      updateWindowTitle()
    },
    onSave: nextPayload => saveOfficeInWindow(nextPayload),
    onSaveAs: nextPayload => saveOfficeAsInWindow(nextPayload),
    openExternal: url => { void klausApi?.app?.openExternal(url) },
    copyText: value => { void writeClipboardText(value).catch(() => {}) },
  })
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
  if (isCsvTsv && officePayload) {
    void renderOfficePreview(officePayload)
    return
  }
  if (isHtml) {
    void renderHtmlPreview()
    return
  }
  const marked = (window as any).marked
  if (isMd && typeof marked !== 'undefined') {
    clearMountedOffice()
    bodyEl.classList.remove('is-office-mode')
    revokePreviewObjectUrl()
    try {
      const previewContent = (kind === 'skill' || kind === 'memory') ? stripFrontmatter(content) : content
      bodyEl.innerHTML = renderSafeMarkdown(marked, previewContent)
      markdownToc?.setEnabled(true)
      markdownToc?.refresh()
    } catch (err) {
      console.warn('[artifact] safe markdown preview unavailable:', err)
      markdownToc?.setEnabled(false)
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
  const target = canTogglePreview && next === 'preview' ? 'preview' : 'source'
  if (target === view) return
  if (mountedOffice && isCsvTsv) {
    const flushed = mountedOffice.getPayload()
    officePayload = flushed
    if (flushed.kind === 'spreadsheet') {
      content = serializeDelimitedSpreadsheet(flushed, fileExt(filePath) === 'tsv' ? '\t' : ',')
    }
  } else if (isCsvTsv && target === 'preview') {
    officePayload = parseDelimitedSpreadsheet(content, fileExt(filePath) === 'tsv' ? '\t' : ',').preview
  }
  view = target
  syncToggle()
  if (!content && !officePayload) return
  const scrollTop = bodyEl.scrollTop
  bodyEl.classList.add('is-swapping')
  setTimeout(() => {
    if (view === 'preview') renderPreview()
    else renderSource()
    bodyEl.scrollTop = scrollTop
    markdownToc?.syncScroll()
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
window.addEventListener('beforeunload', () => {
  clearMountedOffice()
  revokePreviewObjectUrl()
  markdownToc?.destroy()
})

syncToggle()

;(async () => {
  await preferencesReady
  bodyEl.textContent = text('artifacts_loading', 'Loading…')
  try {
    if (directKind === 'unsupported-media') {
      viewToggle?.classList.add('is-hidden')
      truncEl.style.display = 'none'
      renderUnsupportedMediaCard()
      return
    }
    if (directKind) {
      if (kind !== 'artifact') {
        renderMessage('Preview is not available for this file type.')
        truncEl.style.display = 'none'
        return
      }
      const data = await klausApi?.artifacts?.fileUrl?.(sessionId, filePath)
      if (data?.officeError && typeof data.officeError === 'object') {
        viewToggle?.classList.add('is-hidden')
        truncEl.style.display = 'none'
        await renderOfficePreview(data.officeError)
        return
      }
      if (data?.error || !data?.url) throw new Error(data?.error || 'missing preview URL')
      renderDirectPreview(data.url, directKind)
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
    fileMtimeMs = typeof data?.mtimeMs === 'number' ? data.mtimeMs : null
    if (data?.office && typeof data.office === 'object') {
      officePayload = data.office as OfficePreviewPayload
      officeWritable = typeof data?.officeWritable === 'boolean'
        ? data.officeWritable
        : Boolean(kind === 'artifact' && !data?.truncated && isInPlaceWritableOfficeExtension(filePath))
      savedOfficeJson = JSON.stringify(officePayload)
      if (!isCsvTsv) {
        viewToggle?.classList.add('is-hidden')
        await renderOfficePreview(officePayload)
      } else if (view === 'preview') {
        await renderOfficePreview(officePayload)
      } else {
        renderSource()
      }
    } else if (view === 'preview') renderPreview()
    else renderSource()
    truncEl.style.display = data?.truncated ? 'block' : 'none'
  } catch (err) {
    console.error('[artifact] load threw:', err, { kind, filePath, sessionId })
    bodyEl.textContent = `${text('artifacts_load_failed', 'Failed to load file')} (${err instanceof Error ? err.message : String(err)})`
  }
})()

export {}
