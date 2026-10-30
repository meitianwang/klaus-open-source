// Workspace 面板域（自 chat.ts 拆出，逻辑原样，strict 类型化）。
//
// VSCode 风格文件树 + 多标签文件预览/编辑（源码高亮/markdown/svg/html/图片
// 缩放/媒体）+ 右键菜单（新建/改名/删除/复制路径/加入对话）+ chokidar 事件
// 驱动的防抖重载 + 自写回避（agent 写盘不打断正在看的文件）。
// artifacts 编排（open/close/mode）与 composer mention 桥仍在 chat.ts，经
// initWorkspacePanel(deps) 注入。
import { tt } from '../app/i18n'
import { showToast, escapeHtml } from '../app/ui-shared'
import { icon as klausIcon } from '../icons/registry'
import { WorkspaceDocument } from './workspace-document'
import type { SourceEditorSnapshot } from './workspace-source-editor'
import type { MarkdownEditorSnapshot } from './workspace-markdown-editor'
import { fileIconSvg } from './file-icon'
import { WorkspaceFileTree } from './workspace-file-tree'
import { initializeWorkspaceTreeResize } from './workspace-tree-resize'
import './workspace-file-tree.css'
import styles from './workspace-panel.module.css'
import { toggleSettings } from '../pages/settings/shell'
import { bindCommandHandler } from '../app/keybindings/use-command-handler'
import { bindingLabelFor } from '../app/keybindings/state'
import { writeClipboardText } from '../clipboard'
import { mountImageViewer, performImageAction, bindImageContextMenu, openImagePreview, imagePreviewOptionsFromElement, type PreviewImage, type ImageViewer, type ImageViewState } from './image-preview'

export interface WorkspacePanelDeps {
  ensureSession(): Promise<string | null | undefined>
  draftProjectWorkdir(): string | null
  inputEl(): HTMLTextAreaElement
  addWorkspaceComposerMention(node: unknown): void
  rememberWorkspaceRoot(sessionId: string, root: unknown): void
  closeSessionContextMenu(): void
  hideBtwPanel(): void
  setCurrentNonChatView(view: null): void
  openArtifactsPanel(mode: string): void
  setArtifactsPanelMode(mode: string): void
  syncArtifactsToggleVisibility(): void
  syncTopModeButtons(): void
  renderSessionList(): void
  artifactsPanel(): HTMLElement | null
  artifactsList(): HTMLElement | null
}
let deps!: WorkspacePanelDeps
let unbindWorkspaceImageMenu: (() => void) | undefined
const IMAGE_TAB_ZOOM_KEY = 'klaus.image-tab-zoom.v1'
function imageZoomIdentity(tab: WorkspaceTab): string {
  const path = tab.imageSource ? tab.imageSource.path : tab.path
  return path ? JSON.stringify([tab.ownerSessionId ?? '', path]) : ''
}
function imageTabZoom(tab: WorkspaceTab | null): ImageViewState | undefined {
  if (tab?.imageViewState) return tab.imageViewState
  if (!tab) return undefined
  try {
    const saved = JSON.parse(localStorage.getItem(IMAGE_TAB_ZOOM_KEY) || '{}')[imageZoomIdentity(tab)]
    return Number.isFinite(saved) && saved > 0 ? { scale: saved, x: 0, y: 0, fitted: false, index: 0 } : undefined
  } catch { return undefined }
}
function rememberImageTabZoom(tab: WorkspaceTab | null, scale: number | null): void {
  if (!tab) return
  const key = imageZoomIdentity(tab)
  if (!key) return
  try {
    const saved = JSON.parse(localStorage.getItem(IMAGE_TAB_ZOOM_KEY) || '{}')
    delete saved[key]
    if (scale !== null) saved[key] = scale
    const entries = Object.entries(saved).slice(-200)
    localStorage.setItem(IMAGE_TAB_ZOOM_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch { /* A storage failure does not prevent viewing the original image. */ }
}
// ---- 域内数据结构 ----
export interface WorkspaceTab {
  preview?: boolean
  imageSource?: PreviewImage
  imageViewState?: ImageViewState
  ownerSessionId?: string
  path: string
  previewPath?: string
  name: string
  directKind: string
  canPreview: boolean
  viewMode: 'source' | 'preview'
  loaded: boolean
  loading: boolean
  error: string
  mediaUrl: string
  savedContent: string
  draftContent: string
  truncated: boolean
  binary: boolean
  readonly: boolean
  encoding: string
  dirty: boolean
  mtimeMs?: number | null
}
export interface WorkspaceNode {
  path: string
  name?: string
  rel?: string
  isDir?: boolean
  children?: WorkspaceNode[]
  childrenLoaded?: boolean
  truncated?: boolean
}
const currentSessionId = () => (window as unknown as { currentSessionId?: string | null }).currentSessionId || null

interface KlausWorkspaceApi {
  workspace: {
    search(sessionId: string, query: string): Promise<{ hits?: { rel: string; name: string; isDir: boolean }[]; truncated?: boolean; error?: string } | null>
    list: (sessionId: string | null, filePath?: string) => Promise<{ root?: string; roots?: string[]; tree?: WorkspaceNode[]; truncated?: boolean; error?: string } | null>
    open: (sessionId: string | null, path: string) => Promise<{ ok?: boolean; error?: string } | null>
    reveal: (sessionId: string | null, path: string) => Promise<{ ok?: boolean; error?: string } | null>
    rename: (sessionId: string | null, path: string, newName: string) => Promise<{ ok?: boolean; path?: string; error?: string } | null>
    delete: (sessionId: string | null, path: string) => Promise<{ ok?: boolean; error?: string } | null>
    write: (sessionId: string | null, path: string, content: string, options?: { expectedMtimeMs?: number | null }) => Promise<{ ok?: boolean; error?: string; conflict?: boolean; content?: string; mtimeMs?: number | null; truncated?: boolean } | null>
  }
  artifacts: {
    authorizePreview: (sessionId: string, path: string) => Promise<{ ok?: boolean; filePath?: string; error?: string } | null>
    read: (sessionId: string | null, path: string) => Promise<{ ok?: boolean; error?: string; content?: string; binary?: boolean; readonly?: boolean; encoding?: string; truncated?: boolean; mtimeMs?: number | null } | null>
    fileUrl: (sessionId: string | null, path: string) => Promise<{ ok?: boolean; url?: string; error?: string } | null>
  }
}
const klausApi = () => (window as unknown as { klaus: KlausWorkspaceApi }).klaus
const klausDialog = () => (window as unknown as { klausDialog: { alert(msg: string): Promise<void>; confirm(opts: unknown): Promise<boolean> } }).klausDialog

const workspaceMainView = document.getElementById('workspace-main-view')
const workspaceFileEmpty = document.getElementById('workspace-file-empty')
const workspaceFileShell = document.getElementById('workspace-file-shell')
const workspaceFileTabs = document.getElementById('workspace-file-tabs')
const workspaceFileTitle = document.getElementById('workspace-file-title')
const workspaceFilePath = document.getElementById('workspace-file-path')
const workspaceFileStatus = document.getElementById('workspace-file-status')
const workspaceFileBody = document.getElementById('workspace-file-body')
const workspaceFileTruncated = document.getElementById('workspace-file-truncated')
const workspaceFileCopyBtn = document.getElementById('workspace-file-copy')
const workspaceFileRevealBtn = document.getElementById('workspace-file-reveal')
const workspaceFileViewToggle = document.getElementById('workspace-file-view-toggle')
const workspaceFileViewPreviewBtn = document.getElementById('workspace-file-view-preview')
const workspaceFileViewSourceBtn = document.getElementById('workspace-file-view-source')
const workspaceFileZoomControls = document.getElementById('workspace-file-zoom-controls')
const workspaceFileZoomOutBtn = document.getElementById('workspace-file-zoom-out')
const workspaceFileZoomFitBtn = document.getElementById('workspace-file-zoom-fit')
const workspaceFileZoomResetBtn = document.getElementById('workspace-file-zoom-reset')
const workspaceFileZoomInBtn = document.getElementById('workspace-file-zoom-in')

// Per-session expanded-folder set survives session switches but resets on
// reload — good enough for now. Persist if the user complains.
const workspaceExpanded = new Map<string, Set<string>>() // sessionId → Set<absPath>
let workspaceTree: WorkspaceFileTree | undefined
let workspaceTreeSession = ''
let workspaceTreeRoots = ''
let workspaceTreeLoadSequence = 0
const workspaceRoots = new Map<string, string>() // sessionId → abs root
const workspaceSelectedFiles = new Map<string, string>() // sessionId → abs file path
const workspaceOpenTabs = new Map<string, WorkspaceTab[]>() // sessionId → Workspace tab[]
let workspaceReloadTimer: ReturnType<typeof setTimeout> | null = null
let workspaceContextMenu: HTMLElement | null = null
let workspaceContextMenuCleanup: (() => void) | null = null
let workspaceContextRow: HTMLElement | null = null
let workspaceTabContextMenu: HTMLElement | null = null
let workspaceTabContextMenuCleanup: (() => void) | null = null
let workspaceRenamingPath: string | null = null
let workspaceMainActive = false
let workspaceFileLoadSeq = 0
let workspaceFilePreviewPath = ''
let workspaceFileContent = ''
let workspaceFileContentPath = ''
let workspaceFileViewMode = 'source'
let workspaceFileCanPreview = false
let workspacePreviewObjectUrl = ''
let workspaceImageScale: number | 'fit' = 'fit'
let workspaceImageElement: HTMLImageElement | null = null
let workspaceImageViewer: HTMLElement | null = null
let workspaceImageCtrlPressed = false
let workspaceImageAltPressed = false
let imageTabViewer: ImageViewer | null = null
let imageViewerTab: WorkspaceTab | null = null
const workspaceSelfWrites = new Map<string, number>()
const workspaceDocuments = new WeakMap<WorkspaceTab, WorkspaceDocument>()
const workspaceDocumentRevisions = new WeakMap<WorkspaceTab, number>()
const workspaceEditorStates = new WeakMap<WorkspaceTab, { markdown?: MarkdownEditorSnapshot; source?: SourceEditorSnapshot }>()
interface WorkspaceEditorHandle {
  getContent(): string
  updateContent(content: string): void
  setReadOnly(value: boolean): void
  goToLine(line: number): void
  focus(): void
  find?(direction?: 'next' | 'previous'): void
  revealMatch?(from: number, to: number): void
  destroy(): void
}
let workspaceMountedEditor: { tab: WorkspaceTab; mode: 'source' | 'preview'; handle: WorkspaceEditorHandle; capture(): void } | undefined
let workspaceEditorSequence = 0
let workspaceDocumentNotice: HTMLElement | undefined

function releaseWorkspaceEditor(flush = true): void {
  ++workspaceEditorSequence
  const mounted = workspaceMountedEditor
  workspaceMountedEditor = undefined
  if (!mounted) return
  mounted.capture()
  mounted.handle.destroy()
  const document = workspaceDocuments.get(mounted.tab)
  if (flush && document?.dirty) void document.flush()
}

async function flushWorkspacePath(sessionId: string | null, path: string): Promise<boolean> {
  const prefix = normalizeWorkspacePath(path)
  for (const tab of getWorkspaceTabs(sessionId)) {
    const name = normalizeWorkspacePath(tab.path)
    if ((name === prefix || name.startsWith(prefix + '/')) && (tab.dirty || workspaceDocuments.get(tab)?.snapshot.saving) && !await (workspaceDocuments.get(tab)?.flush() ?? saveWorkspaceTab(tab))) return false
  }
  return true
}

function forgetWorkspaceDocument(tab: WorkspaceTab): void {
  if (workspaceMountedEditor?.tab === tab) releaseWorkspaceEditor(false)
  void workspaceDocuments.get(tab)?.dispose(true)
  workspaceDocuments.delete(tab)
}

function workspaceDocumentFor(tab: WorkspaceTab): WorkspaceDocument {
  let document = workspaceDocuments.get(tab)
  if (document) return document
  const owner = tab.ownerSessionId ?? currentSessionId()
  const path = tab.path
  document = new WorkspaceDocument({
    content: tab.savedContent,
    mtimeMs: tab.mtimeMs,
    async write(content, expectedMtimeMs) {
      if (!workspaceTabIsEditable(tab)) return { ok: false, error: tt('workspace_file_readonly') }
      markWorkspaceSelfWrite(path)
      const result = await klausApi().workspace.write(owner, path, content, { expectedMtimeMs })
      if (!result?.ok) clearWorkspaceSelfWrite(path)
      else scheduleWorkspaceReload(owner)
      return result ?? { ok: false, error: tt('workspace_file_save_failed') }
    },
    onChange(snapshot) {
      workspaceDocumentRevisions.set(tab, (workspaceDocumentRevisions.get(tab) ?? 0) + 1)
      tab.savedContent = snapshot.savedContent
      tab.draftContent = snapshot.content
      tab.mtimeMs = snapshot.mtimeMs
      tab.dirty = snapshot.content !== snapshot.savedContent
      if (tab.ownerSessionId !== currentSessionId()) return
      if (getActiveWorkspaceTab() === tab) {
        syncWorkspaceActiveTabGlobals(tab)
        updateWorkspaceFileChromeForTab(tab)
      }
      renderWorkspaceTabs()
    },
  })
  workspaceDocuments.set(tab, document)
  if (tab.draftContent !== tab.savedContent) document.update(tab.draftContent)
  return document
}

function updateWorkspaceDocumentNotice(tab: WorkspaceTab): void {
  workspaceDocumentNotice ??= document.createElement('div')
  workspaceDocumentNotice.className = styles['workspace-document-notice']
  workspaceDocumentNotice.setAttribute('role', 'status')
  workspaceFileBody?.before(workspaceDocumentNotice)
  workspaceDocumentNotice.replaceChildren()
  const state = workspaceDocuments.get(tab)?.snapshot
  workspaceDocumentNotice.hidden = !state?.conflict && !state?.error
  if (!state?.conflict && !state?.error) return
  const text = document.createElement('span')
  text.textContent = state.conflict ? tt('workspace_file_external_change') : `${tt('workspace_file_save_failed')}: ${state.error}`
  workspaceDocumentNotice.append(text)
  const button = (label: string, action: () => void) => {
    const element = document.createElement('button')
    element.type = 'button'; element.textContent = tt(label)
    element.addEventListener('click', action)
    workspaceDocumentNotice!.append(element)
  }
  if (state.conflict) {
    for (const [choice, label] of [['disk', 'workspace_file_use_disk'], ['local', 'workspace_file_keep_changes']] as const) {
      button(label, () => {
        const document = workspaceDocuments.get(tab)
        if (choice === 'disk' && state.conflict?.truncated) {
          tab.truncated = true
          if (workspaceMountedEditor?.tab === tab) workspaceMountedEditor.handle.setReadOnly(true)
        }
        document?.resolveConflict(choice)
        if (getActiveWorkspaceTab() === tab) {
          workspaceMountedEditor?.handle.updateContent(tab.draftContent)
          updateWorkspaceFileChromeForTab(tab)
        }
        if (choice === 'disk' && state.conflict?.truncated && getActiveWorkspaceTab() === tab) void loadWorkspaceFile(tab.path, { force: true })
        if (choice === 'local') void document?.flush()
      })
    }
  } else button('workspace_file_retry_save', () => { void saveWorkspaceTab(tab) })
}

const WORKSPACE_IMAGE_PIXELATION_THRESHOLD = 3
const WORKSPACE_SELF_WRITE_RELOAD_SKIP_MS = 3000
const WORKSPACE_IMAGE_SCALE_PINCH_FACTOR = 0.075
const WORKSPACE_IMAGE_MIN_SCALE = 0.1
const WORKSPACE_IMAGE_MAX_SCALE = 20
const WORKSPACE_IMAGE_ZOOM_LEVELS = [
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
  1.5, 2, 3, 5, 7, 10, 15, 20,
]

const WORKSPACE_DIRECT_PREVIEW_EXTS: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', avif: 'image',
  pdf: 'pdf',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', ogv: 'video',
}

const WORKSPACE_READONLY_SOURCE_PREVIEW_EXTS = new Set(['svg'])
function workspaceFileExt(filePath: string) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filePath || '')
  return m ? m[1].toLowerCase() : ''
}

function workspaceDirectPreviewKind(filePath: string) {
  return WORKSPACE_DIRECT_PREVIEW_EXTS[workspaceFileExt(filePath)] || ''
}

function workspaceIsMarkdown(filePath: string) {
  return /\.(md|markdown)$/i.test(filePath || '')
}

function workspaceIsSvg(filePath: string) {
  return /\.svg$/i.test(filePath || '')
}

function workspaceIsHtml(filePath: string) {
  return /\.(html?|xhtml)$/i.test(filePath || '')
}

function workspaceCanPreviewSourceFile(filePath: string) {
  return workspaceIsMarkdown(filePath) || workspaceIsSvg(filePath) || workspaceIsHtml(filePath)
}

function workspaceUsesReadonlySourcePreview(filePath: string) {
  return WORKSPACE_READONLY_SOURCE_PREVIEW_EXTS.has(workspaceFileExt(filePath))
}

function workspaceBaseName(filePath: string) {
  const raw = String(filePath || '')
  const idx = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return idx >= 0 ? raw.slice(idx + 1) : raw
}

export function isWorkspaceMainActive() {
  return workspaceMainActive
}

export function selectedWorkspaceFile(sessionId = currentSessionId()) {
  return sessionId ? workspaceSelectedFiles.get(sessionId) || '' : ''
}

function getWorkspaceTabs(sessionId = currentSessionId()) {
  if (!sessionId) return []
  let tabs = workspaceOpenTabs.get(sessionId)
  if (!tabs) {
    tabs = []
    workspaceOpenTabs.set(sessionId, tabs)
  }
  return tabs
}

function findWorkspaceTab(filePath: string, sessionId = currentSessionId()) {
  return getWorkspaceTabs(sessionId).find(tab => tab.path === filePath) || null
}

function getActiveWorkspaceTab(sessionId = currentSessionId()) {
  const activePath = selectedWorkspaceFile(sessionId)
  return activePath ? findWorkspaceTab(activePath, sessionId) : null
}

function workspaceDefaultViewMode(filePath: string): 'source' | 'preview' {
  if (workspaceIsMarkdown(filePath)) return 'preview'
  if (workspaceIsSvg(filePath)) return 'preview'
  // HTML 产物默认富预览：agent 产出的报告/原型/可视化页面，用户首要诉求是
  // 「看效果」而非读源码；源码视图一键可切。
  if (workspaceIsHtml(filePath)) return 'preview'
  return 'source'
}

function createWorkspaceTab(filePath: string) {
  const directKind = workspaceDirectPreviewKind(filePath)
  const canPreview = workspaceCanPreviewSourceFile(filePath)
  return {
    path: filePath,
    name: workspaceBaseName(filePath),
    directKind,
    canPreview,
    viewMode: canPreview ? workspaceDefaultViewMode(filePath) : 'source',
    loaded: false,
    loading: false,
    error: '',
    mediaUrl: '',
    savedContent: '',
    draftContent: '',
    truncated: false,
    binary: false,
    readonly: false,
    encoding: '',
    dirty: false,
  }
}

function ensureWorkspaceTab(filePath: string, sessionId = currentSessionId()) {
  if (!sessionId || !filePath) return null
  const tabs = getWorkspaceTabs(sessionId)
  let tab = tabs.find(item => item.path === filePath)
  if (!tab) {
    tab = createWorkspaceTab(filePath)
    tab.ownerSessionId = sessionId
    tabs.push(tab)
  }
  return tab
}

function workspaceCloseIconSvg() {
  return klausIcon('chat-workspace-close')
}

/** Context-menu key hints come from the live keymap, with the historical
 *  hardcoded string as the fallback for the moment before the first state read
 *  resolves. A cleared binding shows no hint rather than a dead one. */
function workspaceShortcutLabel(commandId: string, fallback: string) {
  return bindingLabelFor(commandId) ?? fallback
}

function activeWorkspaceFileContent() {
  const tab = getActiveWorkspaceTab()
  return tab ? tab.draftContent || '' : workspaceFileContent
}

function clampWorkspaceImageScale(value: number) {
  return Math.min(Math.max(value, WORKSPACE_IMAGE_MIN_SCALE), WORKSPACE_IMAGE_MAX_SCALE)
}

function revokeWorkspacePreviewObjectUrl() {
  if (!workspacePreviewObjectUrl) return
  URL.revokeObjectURL(workspacePreviewObjectUrl)
  workspacePreviewObjectUrl = ''
}

function clearWorkspaceImageZoom() {
  if (imageTabViewer) {
    if (imageViewerTab) imageViewerTab.imageViewState = imageTabViewer.state()
    imageTabViewer.dispose(); imageTabViewer = null; imageViewerTab = null
  }
  workspaceImageElement = null
  workspaceImageViewer = null
  workspaceImageScale = 'fit'
  workspaceImageCtrlPressed = false
  workspaceImageAltPressed = false
  workspaceFileZoomControls?.setAttribute('hidden', '')
  if (workspaceFileZoomFitBtn) workspaceFileZoomFitBtn.textContent = tt('workspace_zoom_fit_label')
}

function setWorkspaceFileBodyMode(mode: string) {
  releaseWorkspaceEditor()
  if (workspaceDocumentNotice) workspaceDocumentNotice.hidden = true
  if (!workspaceFileBody) return
  workspaceFileBody.classList.remove(styles['workspace-editor-body'])
  workspaceFileBody.classList.remove('is-source', 'is-markdown', 'is-svg', 'is-html', 'is-media', 'is-message')
  if (mode) workspaceFileBody.classList.add('is-' + mode)
}

function syncWorkspaceFileViewToggle() {
  if (!workspaceFileViewToggle) return
  workspaceFileViewToggle.hidden = !workspaceFileCanPreview
  const previewActive = workspaceFileViewMode === 'preview'
  const sourceActive = workspaceFileViewMode === 'source'
  workspaceFileViewPreviewBtn?.classList.toggle('is-active', previewActive)
  workspaceFileViewSourceBtn?.classList.toggle('is-active', sourceActive)
  workspaceFileViewPreviewBtn?.setAttribute('aria-label', tt('artifacts_view_preview'))
  workspaceFileViewSourceBtn?.setAttribute('aria-label', tt('artifacts_view_source'))
  workspaceFileViewPreviewBtn?.setAttribute('aria-pressed', previewActive ? 'true' : 'false')
  workspaceFileViewSourceBtn?.setAttribute('aria-pressed', sourceActive ? 'true' : 'false')
  const markdown = workspaceIsMarkdown(workspaceFileContentPath)
  workspaceFileViewToggle.classList.toggle('is-document-toggle', markdown)
  if (markdown) {
    const active = previewActive ? workspaceFileViewSourceBtn : workspaceFileViewPreviewBtn
    const inactive = previewActive ? workspaceFileViewPreviewBtn : workspaceFileViewSourceBtn
    inactive?.setAttribute('hidden', '')
    active?.removeAttribute('hidden')
    if (active) {
      const label = tt(previewActive ? 'workspace_file_view_source' : 'workspace_file_view_preview')
      active.textContent = label
      active.setAttribute('aria-label', label)
    }
  } else {
    for (const [button, icon] of [[workspaceFileViewPreviewBtn, 'ws-file-preview'], [workspaceFileViewSourceBtn, 'ws-file-source']] as const) {
      button?.removeAttribute('hidden')
      if (button) button.innerHTML = klausIcon(icon)
    }
  }
}

function syncWorkspaceImageZoomControls() {
  if (!workspaceFileZoomControls) return
  const active = !!workspaceImageElement && !!workspaceImageViewer
  workspaceFileZoomControls.hidden = !active
  if (!active) return
  if (workspaceFileZoomFitBtn) {
    workspaceFileZoomFitBtn.textContent = workspaceImageScale === 'fit'
      ? tt('workspace_zoom_fit_label')
      : `${Math.round(workspaceImageScale * 100)}%`
  }
}

function workspaceImageUsesZoomOutCursor() {
  const isMac = /MAC/i.test(navigator.platform || '')
  return isMac ? workspaceImageAltPressed : workspaceImageCtrlPressed
}

function syncWorkspaceImageCursor() {
  if (!workspaceImageViewer) return
  workspaceImageViewer.classList.toggle('zoom-out', workspaceImageUsesZoomOutCursor())
}

function workspaceImageBaseSize(img: HTMLImageElement, viewer: HTMLElement) {
  const current = img.getBoundingClientRect()
  const width = Number(img.dataset.baseWidth) ||
    img.naturalWidth ||
    Math.round(current.width) ||
    Math.max(1, viewer.clientWidth - 64)
  const height = Number(img.dataset.baseHeight) ||
    img.naturalHeight ||
    Math.round(current.height) ||
    Math.max(1, viewer.clientHeight - 48)
  img.dataset.baseWidth = String(width)
  img.dataset.baseHeight = String(height)
  return { width, height }
}

function applyWorkspaceImageScale(nextScale: number | 'fit', options: { keepScroll?: boolean } = {}) {
  if (!workspaceImageElement || !workspaceImageViewer) return
  const img = workspaceImageElement
  const viewer = workspaceImageViewer
  const previousCenterX = (viewer.scrollLeft + viewer.clientWidth / 2) / Math.max(1, viewer.scrollWidth)
  const previousCenterY = (viewer.scrollTop + viewer.clientHeight / 2) / Math.max(1, viewer.scrollHeight)

  if (nextScale === 'fit') {
    workspaceImageScale = 'fit'
    img.classList.add('scale-to-fit')
    img.classList.remove('pixelated')
    img.style.width = ''
    img.style.height = ''
    viewer.classList.remove('is-zoomed')
    viewer.scrollLeft = 0
    viewer.scrollTop = 0
    syncWorkspaceImageZoomControls()
    return
  }

  const scale = clampWorkspaceImageScale(Number(nextScale) || 1)
  workspaceImageScale = scale
  const base = workspaceImageBaseSize(img, viewer)
  img.classList.remove('scale-to-fit')
  img.classList.toggle('pixelated', scale >= WORKSPACE_IMAGE_PIXELATION_THRESHOLD)
  img.style.width = `${Math.max(1, Math.round(base.width * scale))}px`
  img.style.height = `${Math.max(1, Math.round(base.height * scale))}px`
  viewer.classList.add('is-zoomed')
  syncWorkspaceImageZoomControls()

  if (options.keepScroll === false) return
  requestAnimationFrame(() => {
    viewer.scrollLeft = viewer.scrollWidth * previousCenterX - viewer.clientWidth / 2
    viewer.scrollTop = viewer.scrollHeight * previousCenterY - viewer.clientHeight / 2
  })
}

function firstWorkspaceImageZoom() {
  if (!workspaceImageElement || !workspaceImageViewer) return
  const img = workspaceImageElement
  const baseWidth = img.naturalWidth || Number(img.dataset.baseWidth)
  const renderedWidth = img.clientWidth || img.getBoundingClientRect().width
  const next = baseWidth ? renderedWidth / baseWidth : 1
  applyWorkspaceImageScale(next || 1)
}

function zoomWorkspaceImageIn() {
  if (!workspaceImageElement) return
  if (workspaceImageScale === 'fit') firstWorkspaceImageZoom()
  const current = workspaceImageScale === 'fit' ? 1 : workspaceImageScale
  const next = WORKSPACE_IMAGE_ZOOM_LEVELS.find(level => level > current) || WORKSPACE_IMAGE_MAX_SCALE
  applyWorkspaceImageScale(next)
}

function zoomWorkspaceImageOut() {
  if (!workspaceImageElement) return
  if (workspaceImageScale === 'fit') firstWorkspaceImageZoom()
  const current = workspaceImageScale === 'fit' ? 1 : workspaceImageScale
  let next = WORKSPACE_IMAGE_MIN_SCALE
  for (let i = WORKSPACE_IMAGE_ZOOM_LEVELS.length - 1; i >= 0; i -= 1) {
    if (WORKSPACE_IMAGE_ZOOM_LEVELS[i] < current) {
      next = WORKSPACE_IMAGE_ZOOM_LEVELS[i]
      break
    }
  }
  applyWorkspaceImageScale(next)
}

function setWorkspaceImageZoomTarget(img: HTMLImageElement | null, viewer: HTMLElement | null) {
  workspaceImageElement = img
  workspaceImageViewer = viewer
  workspaceImageScale = 'fit'
  if (!img || !viewer) return
  viewer.classList.add('ready')
  viewer.classList.remove('zoom-out', 'is-zoomed')
  img.classList.add('scale-to-fit')
  img.classList.remove('pixelated')
  img.style.width = ''
  img.style.height = ''
  viewer.addEventListener('click', (ev: MouseEvent) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    workspaceImageCtrlPressed = ev.ctrlKey
    workspaceImageAltPressed = ev.altKey
    if (workspaceImageUsesZoomOutCursor()) zoomWorkspaceImageOut()
    else zoomWorkspaceImageIn()
  })
  viewer.addEventListener('wheel', (ev: WheelEvent) => {
    if (ev.ctrlKey) ev.preventDefault()
    const isMac = /MAC/i.test(navigator.platform || '')
    const modifierPressed = isMac ? (workspaceImageAltPressed || ev.altKey) : (workspaceImageCtrlPressed || ev.ctrlKey)
    if (!modifierPressed && !ev.ctrlKey) return
    ev.preventDefault()
    if (workspaceImageScale === 'fit') firstWorkspaceImageZoom()
    const current = workspaceImageScale === 'fit' ? 1 : workspaceImageScale
    const delta = ev.deltaY > 0 ? 1 : -1
    applyWorkspaceImageScale(current * (1 - delta * WORKSPACE_IMAGE_SCALE_PINCH_FACTOR))
  }, { passive: false })
  syncWorkspaceImageZoomControls()
}

function isWorkspaceExternalResourceRef(ref: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref || '')
}

function splitWorkspaceResourceRef(ref: string) {
  const raw = String(ref || '')
  let cut = raw.length
  const queryIdx = raw.indexOf('?')
  const hashIdx = raw.indexOf('#')
  if (queryIdx >= 0) cut = Math.min(cut, queryIdx)
  if (hashIdx >= 0) cut = Math.min(cut, hashIdx)
  return { path: raw.slice(0, cut), suffix: raw.slice(cut) }
}

function decodeWorkspaceResourcePath(p: string) {
  try { return decodeURI(p) } catch { return p }
}

function dirnameWorkspacePath(p: string) {
  const raw = String(p || '')
  const idx = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return idx >= 0 ? raw.slice(0, idx + 1) : ''
}

function isAbsoluteWorkspaceLocalPath(p: string) {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p || '')
}

function normalizeWorkspaceLocalPath(p: string) {
  const raw = String(p || '')
  const useBackslash = raw.includes('\\') && !raw.includes('/')
  const normalizedInput = raw.replace(/\\/g, '/')
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

function resolveWorkspaceLocalResourcePath(baseFile: string, ref: string) {
  const parsed = splitWorkspaceResourceRef(ref)
  if (!parsed.path) return ''
  const resourcePath = decodeWorkspaceResourcePath(parsed.path)
  if (isAbsoluteWorkspaceLocalPath(resourcePath)) return normalizeWorkspaceLocalPath(resourcePath)
  return normalizeWorkspaceLocalPath(dirnameWorkspacePath(baseFile) + resourcePath)
}


function syncWorkspaceActiveTabGlobals(tab: WorkspaceTab | null) {
  workspaceFilePreviewPath = tab?.imageSource ? tab.imageSource.path || '' : tab?.path || ''
  workspaceFileContent = tab ? (tab.draftContent || '') : ''
  workspaceFileContentPath = tab && !tab.imageSource && !tab.directKind && tab.loaded && !tab.error ? tab.path : ''
  workspaceFileCanPreview = !!tab?.canPreview
  workspaceFileViewMode = tab?.viewMode || 'source'
  syncWorkspaceFileViewToggle()
}

function updateWorkspaceFileChromeForTab(tab: WorkspaceTab | null) {
  if (!tab) return
  showWorkspaceFileShell(tab.path)
  workspaceFileCopyBtn?.setAttribute('aria-label', tt(tab.imageSource ? 'image_copy' : 'artifacts_copy_path'))
  workspaceFileCopyBtn?.setAttribute('data-i18n-aria-label', tab.imageSource ? 'image_copy' : 'artifacts_copy_path')
  if (tab.imageSource) {
    if (workspaceFileTitle) workspaceFileTitle.textContent = tab.name
    if (workspaceFilePath) workspaceFilePath.textContent = tab.imageSource.path || (/^https?:/i.test(tab.imageSource.src) ? tab.imageSource.src : '')
    if (workspaceFileRevealBtn) workspaceFileRevealBtn.hidden = !tab.imageSource.path
  } else if (workspaceFileRevealBtn) workspaceFileRevealBtn.hidden = false
  workspaceFileTitle?.classList.toggle('is-dirty', !!tab.dirty)
  if (workspaceFileStatus) {
    let statusText = ''
    const document = workspaceDocuments.get(tab)?.snapshot
    if (document?.saving) statusText = tt('workspace_file_saving')
    else if (document?.error) statusText = tt('workspace_file_save_failed')
    else if (tab.dirty) statusText = tt('workspace_file_unsaved')
    else if (tab.binary) statusText = tt('workspace_file_binary_status')
    else if (!tab.directKind && (tab.readonly || workspaceUsesReadonlySourcePreview(tab.path))) statusText = tt('workspace_file_readonly')
    workspaceFileStatus.textContent = statusText
    workspaceFileStatus.hidden = !statusText
  }
  updateWorkspaceDocumentNotice(tab)
  if (workspaceFileTruncated) {
    workspaceFileTruncated.textContent = tt('artifacts_truncated')
    workspaceFileTruncated.hidden = !tab.truncated
  }
}

function renderWorkspaceTabs() {
  if (!workspaceFileTabs) return
  const tabs = getWorkspaceTabs()
  const activePath = selectedWorkspaceFile()
  workspaceFileTabs.innerHTML = ''
  for (const tab of tabs) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = styles['workspace-file-tab']
    btn.setAttribute('role', 'tab')
    btn.setAttribute('aria-selected', tab.path === activePath ? 'true' : 'false')
    btn.classList.toggle('is-active', tab.path === activePath)
    btn.classList.toggle('is-dirty', !!tab.dirty)
    btn.classList.toggle('is-preview', !!tab.preview)
    btn.dataset.path = tab.path
    btn.setAttribute('aria-label', tab.imageSource ? tab.name : tab.path)
    btn.innerHTML = `
      <span class="${styles['workspace-file-tab-icon']}" aria-hidden="true">${fileIconSvg(tab.name)}</span>
      <span class="${styles['workspace-file-tab-name']}">${escapeHtml(tab.name)}</span>
      <span class="${styles['workspace-file-tab-close']}" role="button" tabindex="-1" aria-label="${escapeHtml(tt('workspace_tab_close'))}">${workspaceCloseIconSvg()}</span>
    `
    btn.addEventListener('click', async (ev) => {
      if ((ev.target as HTMLElement | null)?.closest?.('.' + styles['workspace-file-tab-close'])) return
      await activateWorkspaceTab(tab.path)
    })
    btn.querySelector('.' + styles['workspace-file-tab-close'])?.addEventListener('click', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      await closeWorkspaceTab(tab.path)
    })
    btn.addEventListener('contextmenu', (ev: MouseEvent) => showWorkspaceTabContextMenu(ev, tab.path))
    btn.addEventListener('dblclick', () => { tab.preview = false; renderWorkspaceTabs() })
    workspaceFileTabs.appendChild(btn)
  }
}

function closeWorkspaceTabContextMenu() {
  workspaceTabContextMenuCleanup?.()
  workspaceTabContextMenuCleanup = null
  workspaceTabContextMenu?.remove()
  workspaceTabContextMenu = null
}

function workspaceContextMenuButton(action: string, label: string, shortcut = '') {
  return `<button type="button" role="menuitem" data-action="${action}">
    <span>${escapeHtml(label)}</span>
    ${shortcut ? `<span class="shortcut">${escapeHtml(shortcut)}</span>` : ''}
  </button>`
}

function showWorkspaceTabContextMenu(e: MouseEvent, tabPath: string) {
  e.preventDefault()
  e.stopPropagation()
  if (!currentSessionId() || !tabPath) return
  closeWorkspaceTabContextMenu()
  closeWorkspaceContextMenu()
  deps.closeSessionContextMenu()

  const menu = document.createElement('div')
  // 纯标记类（无样式规则）：与 panel-tabs.tsx 的 strip 菜单共用一个全局名，保持字面量。
  menu.className = 'workspace-context-menu workspace-tab-context-menu'
  menu.setAttribute('role', 'menu')
  menu.innerHTML = [
    workspaceContextMenuButton('close', tt('workspace_tab_close'), workspaceShortcutLabel('workspaceCloseTab', '')),
    workspaceContextMenuButton('close-others', tt('workspace_tab_close_others'), workspaceShortcutLabel('workspaceCloseOthers', '')),
    workspaceContextMenuButton('close-right', tt('workspace_tab_close_right')),
    workspaceContextMenuButton('close-saved', tt('workspace_tab_close_saved'), workspaceShortcutLabel('workspaceCloseUnsaved', '')),
    workspaceContextMenuButton('close-all', tt('workspace_tab_close_all'), workspaceShortcutLabel('workspaceCloseAll', '')),
  ].join('')
  document.body.appendChild(menu)
  workspaceTabContextMenu = menu

  for (const btn of menu.querySelectorAll('button[data-action]')) {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      const action = (btn as HTMLElement).dataset.action
      closeWorkspaceTabContextMenu()
      if (action) await runWorkspaceTabAction(action, tabPath)
    })
  }

  const rect = menu.getBoundingClientRect()
  const margin = 8
  const left = Math.min(e.clientX, window.innerWidth - rect.width - margin)
  const top = Math.min(e.clientY, window.innerHeight - rect.height - margin)
  menu.style.left = Math.max(margin, left) + 'px'
  menu.style.top = Math.max(margin, top) + 'px'

  const onPointerDown = (ev: PointerEvent) => { if (!menu.contains(ev.target as Node)) closeWorkspaceTabContextMenu() }
  const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === 'Escape') closeWorkspaceTabContextMenu() }
  const onClose = () => closeWorkspaceTabContextMenu()
  setTimeout(() => {
    if (workspaceTabContextMenu !== menu) return
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose, true)
    document.addEventListener('scroll', onClose, true)
    workspaceTabContextMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose, true)
      document.removeEventListener('scroll', onClose, true)
    }
  }, 0)
}

async function runWorkspaceTabAction(action: string, tabPath: string) {
  const tabs = getWorkspaceTabs()
  const index = tabs.findIndex(tab => tab.path === tabPath)
  if (index < 0) return
  if (action === 'close') {
    await closeWorkspaceTab(tabPath)
  } else if (action === 'close-others') {
    await closeWorkspaceTabs(tabs.filter(tab => tab.path !== tabPath).map(tab => tab.path))
  } else if (action === 'close-right') {
    await closeWorkspaceTabs(tabs.slice(index + 1).map(tab => tab.path))
  } else if (action === 'close-saved') {
    await closeWorkspaceTabs(tabs.filter(tab => !tab.dirty).map(tab => tab.path), { skipDirtyPrompt: true })
  } else if (action === 'close-all') {
    await closeWorkspaceTabs(tabs.map(tab => tab.path))
  }
}

async function confirmDiscardWorkspaceTab(tab: WorkspaceTab) {
  if (!tab?.dirty) return true
  const message = tt('workspace_file_discard_confirm').replace('{name}', tab.name || workspaceBaseName(tab.path))
  return klausDialog().confirm({
    message,
    danger: true,
    confirmText: tt('workspace_file_discard'),
    cancelText: tt('cancel'),
  })
}

async function closeWorkspaceTabs(paths: string[], options: { skipDirtyPrompt?: boolean; preserveRender?: boolean } = {}) {
  let closedAny = false
  for (const path of [...paths]) {
    const closed = await closeWorkspaceTab(path, { ...options, preserveRender: true })
    if (closed) closedAny = true
  }
  if (closedAny) renderWorkspaceAfterTabClose()
}

async function closeWorkspaceTab(path: string, options: { skipDirtyPrompt?: boolean; preserveRender?: boolean } = {}) {
  const sessionId = currentSessionId()
  if (!sessionId || !path) return false
  const tabs = getWorkspaceTabs(sessionId)
  const index = tabs.findIndex(tab => tab.path === path)
  if (index < 0) return false
  const tab = tabs[index]
  if (tab.dirty || workspaceDocuments.get(tab)?.snapshot.saving) await (workspaceDocuments.get(tab)?.flush() ?? saveWorkspaceTab(tab))
  if (!options.skipDirtyPrompt && !(await confirmDiscardWorkspaceTab(tab))) return false
  const wasActive = selectedWorkspaceFile(sessionId) === path
  if (workspaceMountedEditor?.tab === tab) releaseWorkspaceEditor(false)
  await workspaceDocuments.get(tab)?.dispose(true)
  workspaceDocuments.delete(tab)
  workspaceEditorStates.delete(tab)
  const currentIndex = tabs.indexOf(tab)
  if (currentIndex < 0) return false
  tabs.splice(currentIndex, 1)
  if (wasActive) {
    const next = tabs[Math.min(index, tabs.length - 1)] || null
    if (next) workspaceSelectedFiles.set(sessionId, next.path)
    else workspaceSelectedFiles.delete(sessionId)
  }
  if (!options.preserveRender && sessionId === currentSessionId()) renderWorkspaceAfterTabClose()
  return true
}

function renderWorkspaceAfterTabClose() {
  renderWorkspaceTabs()
  const active = getActiveWorkspaceTab()
  if (active) loadWorkspaceFile(active.path)
  else renderWorkspaceFileEmpty()
  renderWorkspaceSelection()
}

async function activateWorkspaceTab(path: string) {
  if (!currentSessionId() || !path) return
  const tab = ensureWorkspaceTab(path)
  if (!tab) return
  workspaceSelectedFiles.set(currentSessionId() as string, path)
  renderWorkspaceTabs()
  renderWorkspaceSelection()
  await loadWorkspaceFile(path)
  if (selectedWorkspaceFile() === path) focusWorkspaceImage()
}

function focusWorkspaceImage(): void {
  const stage = workspaceFileBody?.querySelector<HTMLElement>('.image-preview-stage')
  if (!stage) return
  const container = currentSessionId(), selected = selectedWorkspaceFile()
  requestAnimationFrame(() => {
    if (stage.isConnected && workspaceMainActive && container === currentSessionId() && selected === selectedWorkspaceFile()
      && !document.querySelector('.image-lightbox')) stage.focus({ preventScroll: true })
  })
}

function workspaceTabIsEditable(tab: WorkspaceTab | null | undefined) {
  return !!tab
    && !tab.imageSource
    && tab.loaded
    && !tab.error
    && !tab.directKind
    && !tab.binary
    && !tab.truncated
    && !tab.readonly
    && !workspaceUsesReadonlySourcePreview(tab.path)
}

function markWorkspaceTabDirty(tab: WorkspaceTab, value: string) {
  if (!tab || !workspaceTabIsEditable(tab)) return
  tab.preview = false
  workspaceDocumentFor(tab).update(value)
}

async function saveWorkspaceTab(tab: WorkspaceTab | null = getActiveWorkspaceTab()) {
  if (!tab || !workspaceTabIsEditable(tab)) return false
  return workspaceDocumentFor(tab).flush()
}

function renderWorkspaceFileEmpty() {
  releaseWorkspaceEditor()
  if (workspaceDocumentNotice) workspaceDocumentNotice.hidden = true
  revokeWorkspacePreviewObjectUrl()
  clearWorkspaceImageZoom()
  workspaceFileContent = ''
  workspaceFileContentPath = ''
  workspaceFileCanPreview = false
  workspaceFileViewMode = 'source'
  syncWorkspaceFileViewToggle()
  renderWorkspaceTabs()
  workspaceFileShell?.setAttribute('hidden', '')
  workspaceFileEmpty?.removeAttribute('hidden')
  if (workspaceFileEmpty) {
    workspaceFileEmpty.innerHTML = `
      <div class="${styles['workspace-file-empty-state']}">
        <div class="${styles['workspace-file-empty-icon']}" aria-hidden="true">
          ${klausIcon('workspace-file-empty')}
        </div>
        <div class="${styles['workspace-file-empty-title']}">${escapeHtml(tt('workspace_file_empty_title'))}</div>
        <div class="${styles['workspace-file-empty-desc']}">${escapeHtml(tt('workspace_file_empty_desc'))}</div>
      </div>
    `
  }
  if (workspaceFileBody) workspaceFileBody.innerHTML = ''
  if (workspaceFileTruncated) {
    workspaceFileTruncated.hidden = true
    workspaceFileTruncated.textContent = ''
  }
}

function renderWorkspaceFileMessage(message: string) {
  if (!workspaceFileBody) return
  revokeWorkspacePreviewObjectUrl()
  clearWorkspaceImageZoom()
  setWorkspaceFileBodyMode('message')
  workspaceFileBody.innerHTML = ''
  const el = document.createElement('div')
  el.className = styles['workspace-file-message']
  el.textContent = message
  workspaceFileBody.appendChild(el)
}

async function renderWorkspaceTextEditor(tab: WorkspaceTab, mode: 'source' | 'preview'): Promise<void> {
  if (!workspaceFileBody) return
  const mounted = workspaceMountedEditor
  if (mounted?.tab === tab && mounted.mode === mode) {
    mounted.handle.updateContent(tab.draftContent)
    mounted.handle.setReadOnly(!workspaceTabIsEditable(tab))
    applyPendingWorkspaceLine(tab.path)
    return
  }
  revokeWorkspacePreviewObjectUrl()
  clearWorkspaceImageZoom()
  setWorkspaceFileBodyMode(mode === 'preview' ? 'markdown' : 'source')
  workspaceFileBody.replaceChildren()
  workspaceFileBody.classList.add(styles['workspace-editor-body'])
  const sequence = workspaceEditorSequence
  const owner = tab.ownerSessionId
  const state = workspaceEditorStates.get(tab) ?? {}
  workspaceEditorStates.set(tab, state)
  const onChange = (content: string) => markWorkspaceTabDirty(tab, content)
  const onSave = async () => { await saveWorkspaceTab(tab) }
  const stale = () => sequence !== workspaceEditorSequence || owner !== currentSessionId() || getActiveWorkspaceTab() !== tab
  try {
    if (mode === 'preview') {
      const { createMarkdownEditor } = await import('./workspace-markdown-editor')
      if (stale()) return
      const handle = createMarkdownEditor({
        parent: workspaceFileBody,
        content: tab.draftContent,
        readOnly: !workspaceTabIsEditable(tab),
        initialState: state.markdown,
        ariaLabel: tab.name,
        onChange, onSave,
        resolveImageUrl: async href => {
          if (/^(?:https?:|blob:|klaus-media:)/i.test(href)) return href
          let imagePath = href
          if (/^file:/i.test(href)) {
            try { imagePath = decodeURIComponent(new URL(href).pathname) } catch { return '' }
          } else imagePath = resolveWorkspaceLocalResourcePath(tab.path, href)
          if (!imagePath) return ''
          const result = await klausApi().artifacts.fileUrl(owner ?? null, imagePath)
          return result?.ok === false ? '' : result?.url ?? ''
        },
        openLink: href => {
          if (/^(?:https?:|mailto:)/i.test(href)) {
            void (window as any).klaus?.app?.openExternal(href)
          } else if (href.startsWith('#')) {
            const text = tab.draftContent
            const title = decodeURIComponent(href.slice(1)).replace(/-/g, ' ').toLowerCase()
            const index = text.split('\n').findIndex(line => line.replace(/^#+\s*/, '').trim().toLowerCase() === title)
            if (index >= 0) handle.goToLine(index + 1)
          } else {
            const path = /^file:/i.test(href) ? decodeURIComponent(new URL(href).pathname) : resolveWorkspaceLocalResourcePath(tab.path, href)
            if (path) openWorkspaceFilePath(path)
          }
          return true
        },
      })
      workspaceMountedEditor = { tab, mode, handle, capture() { state.markdown = handle.snapshot() } }
    } else {
      const { createSourceEditor } = await import('./workspace-source-editor')
      if (stale()) return
      const handle = createSourceEditor({ parent: workspaceFileBody, path: tab.path, content: tab.draftContent,
        readOnly: !workspaceTabIsEditable(tab), initialState: state.source, onChange, onSave })
      workspaceMountedEditor = { tab, mode, handle, capture() { state.source = handle.snapshot() } }
    }
    applyPendingWorkspaceLine(tab.path)
    updateWorkspaceFileChromeForTab(tab)
  } catch (error) {
    if (stale()) return
    renderWorkspaceFileMessage(`${tt('artifacts_load_failed')}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function renderWorkspaceFileSource(_content: string) {
  const tab = getActiveWorkspaceTab()
  if (tab) void renderWorkspaceTextEditor(tab, 'source')
}

function renderWorkspaceFileEditor(tab: WorkspaceTab) { void renderWorkspaceTextEditor(tab, 'source') }

function renderWorkspaceFileMarkdown(_content: string, _filePath: string) {
  const tab = getActiveWorkspaceTab()
  if (tab) void renderWorkspaceTextEditor(tab, 'preview')
}

function renderWorkspaceFileSvgPreview(content: string, filePath: string) {
  if (!workspaceFileBody) return
  revokeWorkspacePreviewObjectUrl()
  clearWorkspaceImageZoom()
  setWorkspaceFileBodyMode('svg')
  workspaceFileBody.innerHTML = ''
  const blob = new Blob([content || ''], { type: 'image/svg+xml' })
  workspacePreviewObjectUrl = URL.createObjectURL(blob)
  const wrap = document.createElement('div')
  wrap.className = styles['workspace-file-svg-preview'] + ' ' + styles['workspace-file-image-viewer']
  const img = document.createElement('img')
  img.alt = workspaceBaseName(filePath)
  let zoomAttached = false
  const attachZoom = () => {
    if (zoomAttached) return
    zoomAttached = true
    setWorkspaceImageZoomTarget(img, wrap)
  }
  img.addEventListener('load', attachZoom, { once: true })
  img.src = workspacePreviewObjectUrl
  if (img.complete) attachZoom()
  img.onerror = () => {
    workspaceFileViewMode = 'source'
    syncWorkspaceFileViewToggle()
    renderWorkspaceFileSource(workspaceFileContent)
  }
  wrap.appendChild(img)
  workspaceFileBody.appendChild(wrap)
}

// HTML 产物富预览：沙箱 iframe 直接渲染，agent 产出的报告/原型/可视化页面
// 所见即所得。安全边界：
//  - sandbox="allow-scripts"（刻意不给 allow-same-origin）：脚本在不透明源里
//    运行，碰不到宿主 renderer 的 DOM/localStorage/preload API 面；
//  - 无 allow-popups / allow-top-navigation：不能开窗、不能劫持主窗口；
//  - src 用经主进程 isPreviewablePath 校验的 file:// URL（artifacts:file-url），
//    相对资源（css/图片/脚本）能按文件目录自然解析，且路径困在预览范围内。
// 异步取 URL 期间用户可能已切文件，完成后校验路径未变才上屏；失败退回源码。
async function renderWorkspaceFileHtmlPreview(filePath: string) {
  if (!workspaceFileBody) return
  revokeWorkspacePreviewObjectUrl()
  clearWorkspaceImageZoom()
  setWorkspaceFileBodyMode('html')
  workspaceFileBody.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = styles['workspace-file-html-preview']
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-label', workspaceBaseName(filePath))
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  wrap.appendChild(frame)
  workspaceFileBody.appendChild(wrap)
  const requestSessionId = currentSessionId()
  try {
    const res = await klausApi().artifacts.fileUrl(requestSessionId, getActiveWorkspaceTab()?.previewPath || filePath)
    const errMsg = res && res.ok === false ? res.error : res?.error
    if (errMsg || !res?.url) throw new Error(errMsg || 'no preview url')
    // 竞态守卫：异步期间切了文件/会话就丢弃本次结果。
    if (workspaceFileContentPath !== filePath || currentSessionId() !== requestSessionId) return
    frame.src = res.url
  } catch (err) {
    if (workspaceFileContentPath !== filePath || currentSessionId() !== requestSessionId) return
    console.warn('[workspace] html preview failed, falling back to source:', err)
    workspaceFileViewMode = 'source'
    syncWorkspaceFileViewToggle()
    renderWorkspaceFileSource(workspaceFileContent)
  }
}

function renderWorkspaceFileContent() {
  if (!workspaceFileContentPath) {
    renderWorkspaceFileEmpty()
    return
  }
  const activeTab = getActiveWorkspaceTab()
  if (activeTab?.binary) {
    renderWorkspaceFileMessage(tt('workspace_file_binary_message'))
    return
  }
  if (workspaceFileViewMode === 'preview') {
    if (workspaceIsMarkdown(workspaceFileContentPath)) {
      renderWorkspaceFileMarkdown(workspaceFileContent, workspaceFileContentPath)
      return
    }
    if (workspaceIsSvg(workspaceFileContentPath)) {
      renderWorkspaceFileSvgPreview(workspaceFileContent, workspaceFileContentPath)
      return
    }
    if (workspaceIsHtml(workspaceFileContentPath)) {
      void renderWorkspaceFileHtmlPreview(workspaceFileContentPath)
      return
    }
  }
  if (workspaceTabIsEditable(activeTab)) {
    if (activeTab) renderWorkspaceFileEditor(activeTab)
    applyPendingWorkspaceLine(workspaceFileContentPath)
    return
  }
  renderWorkspaceFileSource(workspaceFileContent)
  applyPendingWorkspaceLine(workspaceFileContentPath)
}

function renderWorkspaceFileMedia(url: string, kind: string, filePath: string) {
  if (!workspaceFileBody) return
  revokeWorkspacePreviewObjectUrl()
  clearWorkspaceImageZoom()
  setWorkspaceFileBodyMode('media')
  workspaceFileBody.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = (kind === 'image')
    ? 'workspace-file-media workspace-file-media-image ' + styles['workspace-file-image-viewer']
    : 'workspace-file-media workspace-file-media-' + kind
  let el: HTMLImageElement | HTMLAudioElement | HTMLVideoElement | HTMLIFrameElement | null = null
  if (kind === 'image') {
    workspaceFileBody.appendChild(wrap)
    const tab = getActiveWorkspaceTab()
    imageViewerTab = tab
    imageTabViewer = mountImageViewer(wrap, [{ src: url, path: filePath, sessionId: tab?.ownerSessionId ?? currentSessionId() ?? '', name: workspaceBaseName(filePath) }], 0, { state: imageTabZoom(tab), onZoomChange: scale => rememberImageTabZoom(tab, scale) })
    return
  } else if (kind === 'pdf') {
    el = document.createElement('iframe')
    el.setAttribute('aria-label', workspaceBaseName(filePath))
    el.src = url
  } else if (kind === 'audio') {
    el = document.createElement('audio')
    el.controls = true
    el.preload = 'metadata'
    el.src = url
  } else if (kind === 'video') {
    el = document.createElement('video')
    el.controls = true
    el.preload = 'metadata'
    el.src = url
  }
  if (!el) {
    renderWorkspaceFileMessage(tt('artifacts_load_failed'))
    return
  }
  wrap.appendChild(el)
  workspaceFileBody.appendChild(wrap)
}

function showWorkspaceFileShell(filePath: string) {
  workspaceFileEmpty?.setAttribute('hidden', '')
  workspaceFileShell?.removeAttribute('hidden')
  if (workspaceFileTitle) workspaceFileTitle.textContent = workspaceBaseName(filePath)
  if (workspaceFileStatus) workspaceFileStatus.hidden = true
  if (workspaceFilePath) {
    const rel = workspaceRelativePath(filePath) || filePath
    workspaceFilePath.textContent = rel
  }
}

export async function loadWorkspaceFile(filePath: string, { force = false } = {}) {
  const seq = ++workspaceFileLoadSeq
  const requestSessionId = currentSessionId()
  if (!requestSessionId || !filePath) {
    renderWorkspaceFileEmpty()
    return
  }
  const tab = ensureWorkspaceTab(filePath, requestSessionId)
  if (!tab) {
    renderWorkspaceFileEmpty()
    return
  }
  workspaceSelectedFiles.set(requestSessionId, filePath)
  renderWorkspaceTabs()
  syncWorkspaceActiveTabGlobals(tab)
  updateWorkspaceFileChromeForTab(tab)

  if (tab.imageSource && workspaceFileBody) {
    revokeWorkspacePreviewObjectUrl(); clearWorkspaceImageZoom(); setWorkspaceFileBodyMode('media')
    workspaceFileBody.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'workspace-file-media workspace-file-media-image'
    workspaceFileBody.appendChild(wrap)
    imageViewerTab = tab
    imageTabViewer = mountImageViewer(wrap, [tab.imageSource], 0, { state: imageTabZoom(tab), onZoomChange: scale => rememberImageTabZoom(tab, scale) })
    return
  }

  if (!force && tab.loaded && !tab.loading) {
    if (tab.error) {
      renderWorkspaceFileMessage(tab.error)
    } else if (tab.directKind) {
      renderWorkspaceFileMedia(tab.mediaUrl, tab.directKind, tab.path)
    } else {
      renderWorkspaceFileContent()
    }
    return
  }

  tab.loading = true
  tab.error = ''
  syncWorkspaceActiveTabGlobals(tab)
  updateWorkspaceFileChromeForTab(tab)
  if (!tab.loaded) renderWorkspaceFileMessage(tt('artifacts_loading'))
  if (workspaceFileTruncated) {
    workspaceFileTruncated.hidden = true
    workspaceFileTruncated.textContent = ''
  }
  const directKind = workspaceDirectPreviewKind(filePath)
  try {
    const authorization = await klausApi().artifacts.authorizePreview(requestSessionId, filePath)
    if (seq !== workspaceFileLoadSeq || requestSessionId !== currentSessionId()) return
    if (authorization?.ok !== true || !authorization.filePath) throw new Error(authorization?.error || tt('artifacts_load_failed'))
    const previewPath = authorization.filePath
    tab.previewPath = previewPath
    if (directKind) {
      const data = await klausApi().artifacts.fileUrl(requestSessionId, previewPath)
      if (seq !== workspaceFileLoadSeq || requestSessionId !== currentSessionId()) return
      tab.loading = false
      const errMsg = (data && data.ok === false ? data.error : data?.error)
      if (errMsg || !data?.url) {
        tab.error = errMsg || tt('artifacts_load_failed')
        renderWorkspaceFileMessage(tab.error)
        return
      }
      tab.directKind = directKind
      tab.mediaUrl = data.url
      tab.binary = false
      tab.readonly = true
      tab.encoding = ''
      tab.loaded = true
      syncWorkspaceActiveTabGlobals(tab)
      updateWorkspaceFileChromeForTab(tab)
      renderWorkspaceFileMedia(tab.mediaUrl, tab.directKind, tab.path)
      return
    }
    const documentRevision = workspaceDocumentRevisions.get(tab) ?? 0
    const data = await klausApi().artifacts.read(requestSessionId, previewPath)
    if (seq !== workspaceFileLoadSeq || requestSessionId !== currentSessionId()) return
    if ((workspaceDocumentRevisions.get(tab) ?? 0) !== documentRevision) {
      tab.loading = false
      await loadWorkspaceFile(filePath, { force: true })
      return
    }
    tab.loading = false
    const errMsg = (data && data.ok === false ? data.error : data?.error)
    if (errMsg) {
      tab.error = errMsg === 'file not found' ? tt('artifacts_file_missing') : `${tt('artifacts_load_failed')}: ${errMsg}`
      renderWorkspaceFileMessage(tab.error)
      return
    }
    tab.binary = !!data?.binary
    tab.readonly = !!data?.readonly
    tab.encoding = data?.encoding || ''
    const savedContent = tab.binary ? '' : (data?.content || '')
    tab.truncated = !!data?.truncated
    const existingDocument = workspaceDocuments.get(tab)
    if (existingDocument) existingDocument.syncExternal(savedContent, data?.mtimeMs ?? null)
    else {
      tab.savedContent = savedContent
      tab.mtimeMs = data?.mtimeMs ?? null
      if (!tab.dirty) tab.draftContent = tab.savedContent
      else tab.dirty = tab.draftContent !== tab.savedContent
    }
    tab.directKind = ''
    tab.mediaUrl = ''
    tab.canPreview = workspaceCanPreviewSourceFile(filePath)
    tab.viewMode = tab.canPreview ? (tab.viewMode || workspaceDefaultViewMode(filePath)) : 'source'
    tab.loaded = true
    tab.error = ''
    if (workspaceTabIsEditable(tab)) workspaceDocumentFor(tab)
    syncWorkspaceActiveTabGlobals(tab)
    updateWorkspaceFileChromeForTab(tab)
    renderWorkspaceFileContent()
  } catch (err) {
    if (seq !== workspaceFileLoadSeq || requestSessionId !== currentSessionId()) return
    tab.loading = false
    tab.error = `${tt('artifacts_load_failed')}: ${(err as Error | null)?.message || String(err)}`
    renderWorkspaceFileMessage(tab.error)
  }
}

function renderWorkspaceSelection() {
  const selected = selectedWorkspaceFile()
  workspaceTree?.select(selected)
}

export function hideWorkspaceMainView() {
  releaseWorkspaceEditor()
  unbindWorkspaceImageMenu?.(); unbindWorkspaceImageMenu = undefined
  ++workspaceFileLoadSeq
  clearWorkspaceImageZoom()
  workspaceMainActive = false
  closeWorkspaceTabContextMenu()
  workspaceMainView?.classList.remove('active')
  deps.syncTopModeButtons()
}

export function showWorkspaceMainView({ openPanel = true, revealAndFocus = false }: { openPanel?: boolean; revealAndFocus?: boolean } = {}) {
  if (!unbindWorkspaceImageMenu && workspaceFileBody) unbindWorkspaceImageMenu = bindImageContextMenu(workspaceFileBody)
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  { const fn = (window as unknown as Record<string, unknown>).hideCronView; if (typeof fn === 'function') (fn as () => void)() }
  { const fn = (window as unknown as Record<string, unknown>).hideMcpView; if (typeof fn === 'function') (fn as () => void)() }
  { const fn = (window as unknown as Record<string, unknown>).hideSkillsView; if (typeof fn === 'function') (fn as () => void)() }
  { const fn = (window as unknown as Record<string, unknown>).hidePluginsView; if (typeof fn === 'function') (fn as () => void)() }
  { const fn = (window as unknown as Record<string, unknown>).hideSlashCommandsView; if (typeof fn === 'function') (fn as () => void)() }
  { const fn = (window as unknown as Record<string, unknown>).hideAgentsView; if (typeof fn === 'function') (fn as () => void)() }
  { const fn = (window as unknown as Record<string, unknown>).hideChannelsView; if (typeof fn === 'function') (fn as () => void)() }
  { const fn = (window as unknown as Record<string, unknown>).hideMemoryView; if (typeof fn === 'function') (fn as () => void)() }
  // Not hideDiffView: the changes surface is a sibling tab inside this panel now,
  // and switching to Files must not close it.
  deps.hideBtwPanel()
  deps.setCurrentNonChatView(null)
  workspaceMainActive = true
  workspaceMainView?.classList.add('active')
  deps.setArtifactsPanelMode('workspace')
  if (openPanel) deps.openArtifactsPanel('workspace')
  else {
    deps.syncArtifactsToggleVisibility()
    if (!deps.artifactsPanel()?.classList.contains('collapsed')) loadWorkspace(currentSessionId(), { promoteDraft: true })
  }
  let selected = selectedWorkspaceFile()
  if (!selected) {
    const tabs = getWorkspaceTabs()
    selected = tabs[tabs.length - 1]?.path || ''
    if (selected) workspaceSelectedFiles.set(currentSessionId() as string, selected)
  }
  if (selected) {
    const container = currentSessionId()
    void loadWorkspaceFile(selected).then(() => {
      if (revealAndFocus && workspaceMainActive && container === currentSessionId() && selected === selectedWorkspaceFile()) focusWorkspaceImage()
    })
  } else renderWorkspaceFileEmpty()
  renderWorkspaceSelection()
  deps.syncTopModeButtons()
  deps.renderSessionList()
}

function selectWorkspaceFile(node: WorkspaceNode, { openMain = true, preview = false } = {}) {
  if (!node?.path || node.isDir || !currentSessionId()) return
  const tabs = getWorkspaceTabs()
  const existing = findWorkspaceTab(node.path)
  if (preview && !existing) {
    const index = tabs.findIndex(tab => tab.preview && !tab.dirty && !workspaceDocuments.get(tab)?.snapshot.saving)
    if (index >= 0) {
      const replaced = tabs[index]
      forgetWorkspaceDocument(replaced)
      workspaceEditorStates.delete(replaced)
      tabs.splice(index, 1)
    }
  }
  const tab = ensureWorkspaceTab(node.path)
  if (tab && (!existing || !preview)) tab.preview = preview
  workspaceSelectedFiles.set(currentSessionId() as string, node.path)
  renderWorkspaceTabs()
  renderWorkspaceSelection()
  if (openMain) showWorkspaceMainView({ openPanel: true })
  else if (workspaceMainActive) loadWorkspaceFile(node.path)
}

/** Open an absolute path in this surface, for callers that know a path but not a
 *  tree node (the overview's artifact rows, transcript file citations).
 *
 *  `line` scrolls the source view to that line once the content has rendered:
 *  a citation that names a line must land on it, not on the top of the file. */
export function openWorkspaceFilePath(path: string, options?: { line?: number }) {
  if (path.endsWith('.canvas.tsx')) {
    void (window as any).klaus?.canvas?.open?.(path)
    return
  }
  workspacePendingLine = options?.line && options.line > 0 ? Math.floor(options.line) : undefined
  workspacePendingLinePath = path
  selectWorkspaceFile({ path })
}

/** A citation's line, consumed by the next render of that same file. */
let workspacePendingLine: number | undefined
let workspacePendingLinePath = ''

function applyPendingWorkspaceLine(filePath: string): void {
  const line = workspacePendingLine
  if (!line || workspaceFileContentPath !== filePath || workspacePendingLinePath !== filePath) return
  const mounted = workspaceMountedEditor
  if (mounted?.tab.path !== filePath) return
  workspacePendingLine = undefined
  mounted.handle.goToLine(line)
}

export async function openWorkspaceImageTab(image: PreviewImage): Promise<boolean> {
  const containerSession = currentSessionId() || await deps.ensureSession()
  if (!containerSession || containerSession !== currentSessionId()) return false
  const existing = getWorkspaceTabs(containerSession).find(tab => tab.imageSource && tab.imageSource.sessionId === image.sessionId && (image.path ? tab.imageSource.path === image.path : tab.imageSource.src === image.src))
  const key = existing?.path || 'image:' + encodeURIComponent(image.sessionId || '') + ':' + (image.path || image.src)
  const tab = ensureWorkspaceTab(key, containerSession)
  if (!tab) return false
  tab.imageSource = { ...image }; tab.ownerSessionId = image.sessionId ?? ''
  tab.name = image.name || image.alt || workspaceBaseName(image.path || '') || 'image'
  tab.directKind = 'image'; tab.loaded = true; tab.loading = false; tab.readonly = true; tab.canPreview = false; tab.dirty = false
  workspaceSelectedFiles.set(containerSession, key)
  showWorkspaceMainView({ openPanel: true, revealAndFocus: true })
  return true
}

;(window as unknown as Record<string, unknown>).hideWorkspaceMainView = hideWorkspaceMainView
;(window as unknown as Record<string, unknown>).showWorkspaceMainView = showWorkspaceMainView
;(window as unknown as Record<string, unknown>).isWorkspaceMainViewActive = isWorkspaceMainActive
;(window as any).klausWorkspaceRunFind = (direction?: 'next' | 'previous') => {
  if (!isWorkspaceMainActive() || !workspaceMountedEditor?.handle.find) return false
  workspaceMountedEditor.handle.find(direction)
  return true
}
;(window as any).klausWorkspaceFindDocument = () => {
  const mounted = workspaceMountedEditor
  if (!isWorkspaceMainActive() || !mounted || mounted.mode !== 'source' || !mounted.handle.revealMatch) return null
  return { text: mounted.handle.getContent(), reveal: (from: number, to: number) => mounted.handle.revealMatch?.(from, to) }
}
// 只知道路径的调用方（概览产物行、转录的回合改动行）走这个口，不静态 import 本
// 模块——本模块在装载时就抓 DOM 节点，import 它等于要求调用方先有 DOM。
;(window as unknown as Record<string, unknown>).klausOpenWorkspaceFilePath = openWorkspaceFilePath
;(window as unknown as Record<string, unknown>).klausOpenWorkspaceImageTab = openWorkspaceImageTab

async function ensureWorkspaceSessionForCurrentDraft() {
  if (currentSessionId()) return currentSessionId()
  if (!deps.draftProjectWorkdir()) return null
  try {
    return await deps.ensureSession()
  } catch (err) {
    console.warn('[workspace] failed to create draft session:', err)
    return null
  }
}

workspaceFileCopyBtn?.addEventListener('click', () => {
  const image = getActiveWorkspaceTab()?.imageSource
  if (image) { void performImageAction('copy', image); return }
  if (!workspaceFilePreviewPath) return
  copyWorkspaceText(workspaceFilePreviewPath)
})
workspaceFileRevealBtn?.addEventListener('click', async () => {
  const image = getActiveWorkspaceTab()?.imageSource
  if (image) { await performImageAction('reveal', image); return }
  if (!currentSessionId() || !workspaceFilePreviewPath) return
  const res = await klausApi().workspace.reveal(currentSessionId(), getActiveWorkspaceTab()?.previewPath || workspaceFilePreviewPath).catch((err: unknown) => ({ ok: false as const, path: undefined, error: String(err) }))
  if (res?.error) await klausDialog().alert(res.error || tt('workspace_reveal_failed'))
})
async function setWorkspaceFileView(next: 'source' | 'preview') {
  const tab = getActiveWorkspaceTab()
  const canPreview = !!tab?.canPreview || workspaceFileCanPreview
  const target = canPreview && next === 'preview' ? 'preview' : 'source'
  if (target === workspaceFileViewMode) return
  const owner = currentSessionId()
  if (tab?.dirty && !await saveWorkspaceTab(tab)) return
  if (owner !== currentSessionId() || tab !== getActiveWorkspaceTab()) return
  releaseWorkspaceEditor()
  if (tab) tab.viewMode = target
  workspaceFileViewMode = target
  syncWorkspaceFileViewToggle()
  if (!workspaceFileContentPath) return
  syncWorkspaceActiveTabGlobals(tab)
  renderWorkspaceFileContent()
}
workspaceFileViewPreviewBtn?.addEventListener('click', () => setWorkspaceFileView('preview'))
workspaceFileViewSourceBtn?.addEventListener('click', () => setWorkspaceFileView('source'))
workspaceFileZoomOutBtn?.addEventListener('click', (ev: MouseEvent) => { ev.stopPropagation(); zoomWorkspaceImageOut() })
workspaceFileZoomInBtn?.addEventListener('click', (ev: MouseEvent) => { ev.stopPropagation(); zoomWorkspaceImageIn() })
workspaceFileZoomResetBtn?.addEventListener('click', (ev: MouseEvent) => { ev.stopPropagation(); applyWorkspaceImageScale(1) })
workspaceFileZoomFitBtn?.addEventListener('click', (ev: MouseEvent) => { ev.stopPropagation(); applyWorkspaceImageScale('fit') })
// The work panel's keys are commands in the keybinding registry now, so they are
// configurable in Settings → Keyboard shortcuts like everything else. The four
// actions are registered as command handlers and the runtime attaches the actual
// listeners (including the ⌘K prefix chord); nothing here inspects keys any
// more. Scope gating — "only while this surface is the active one, and not
// during an IME composition" — lives beside the other overrides in
// app/keybindings/runtime.ts, and that is also what keeps ⌘K from being
// consumed here when it should open the command menu.
function registerWorkspaceKeybindingCommands() {
  bindCommandHandler('workspaceSave', () => {
    if (!workspaceMainActive) return false
    saveWorkspaceTab()
    return true
  }, { priority: 'fallback' })
  bindCommandHandler('workspaceCloseTab', () => {
    if (!workspaceMainActive) return false
    const active = getActiveWorkspaceTab()
    if (!active) return false
    closeWorkspaceTab(active.path)
    return true
  }, { priority: 'fallback' })
  // "Close others" from the keyboard resolves against the ACTIVE tab, which is
  // what the per-tab context menu resolves against when opened on that tab.
  bindCommandHandler('workspaceCloseOthers', () => {
    if (!workspaceMainActive) return false
    const active = getActiveWorkspaceTab()
    if (!active) return false
    closeWorkspaceTabs(getWorkspaceTabs().filter(tab => tab.path !== active.path).map(tab => tab.path))
    return true
  }, { priority: 'fallback' })
  bindCommandHandler('workspaceCloseAll', () => {
    if (!workspaceMainActive) return false
    closeWorkspaceTabs(getWorkspaceTabs().map(tab => tab.path))
    return true
  }, { priority: 'fallback' })
  bindCommandHandler('workspaceCloseUnsaved', () => {
    if (!workspaceMainActive) return false
    closeWorkspaceTabs(getWorkspaceTabs().filter(tab => !tab.dirty).map(tab => tab.path), { skipDirtyPrompt: true })
    return true
  }, { priority: 'fallback' })
}
registerWorkspaceKeybindingCommands()
window.addEventListener('keydown', (ev: KeyboardEvent) => {
  if (!workspaceImageViewer) return
  workspaceImageCtrlPressed = ev.ctrlKey
  workspaceImageAltPressed = ev.altKey
  syncWorkspaceImageCursor()
  const key = ev.key
  if (!(ev.metaKey || ev.ctrlKey)) return
  if (key === '=' || key === '+') {
    ev.preventDefault()
    zoomWorkspaceImageIn()
  } else if (key === '-') {
    ev.preventDefault()
    zoomWorkspaceImageOut()
  } else if (key === '0') {
    ev.preventDefault()
    applyWorkspaceImageScale('fit')
  }
})
window.addEventListener('keyup', (ev: KeyboardEvent) => {
  if (!workspaceImageViewer) return
  workspaceImageCtrlPressed = ev.ctrlKey
  workspaceImageAltPressed = ev.altKey
  syncWorkspaceImageCursor()
})


// 字形本体搬到 ./file-icon（纯映射，不碰 DOM）；本模块自己也用它，同时保留出口，
// 原有调用方不动。
export { fileIconSvg }

export function folderIconSvg() {
  return klausIcon('chat-folder')
}

function getExpandedSet(sessionId: string | null) {
  let s = workspaceExpanded.get(sessionId as string)
  if (!s) { s = new Set(); workspaceExpanded.set(sessionId as string, s) }
  return s
}

export function closeWorkspaceContextMenu() {
  workspaceContextMenuCleanup?.()
  workspaceContextMenuCleanup = null
  workspaceContextMenu?.remove()
  workspaceContextMenu = null
  workspaceContextRow?.classList.remove(styles['ws-row-context'])
  workspaceContextRow = null
}

function normalizeWorkspacePath(p: unknown) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function pruneWorkspaceSelfWrites() {
  const now = Date.now()
  for (const [path, timestamp] of workspaceSelfWrites) {
    if (now - timestamp > WORKSPACE_SELF_WRITE_RELOAD_SKIP_MS) workspaceSelfWrites.delete(path)
  }
}

function markWorkspaceSelfWrite(filePath: string) {
  pruneWorkspaceSelfWrites()
  const normalized = normalizeWorkspacePath(filePath)
  if (normalized) workspaceSelfWrites.set(normalized, Date.now())
}

function clearWorkspaceSelfWrite(filePath: string) {
  workspaceSelfWrites.delete(normalizeWorkspacePath(filePath))
}

function workspacePathTouchesPath(changedPath: unknown, targetPath: unknown) {
  const changed = normalizeWorkspacePath(changedPath)
  const target = normalizeWorkspacePath(targetPath)
  if (!changed || !target) return false
  return changed === target || changed.startsWith(target + '/') || target.startsWith(changed + '/')
}

function workspaceEventTouchesPath(event: { events?: { path?: string }[] }, filePath: string) {
  const events = Array.isArray(event?.events) ? event.events : []
  if (!events.length) return true
  return events.some((item: { path?: string }) => workspacePathTouchesPath(item?.path, filePath))
}

export function shouldSkipWorkspaceFileReloadForOwnWrite(event: { type?: string; events?: { path?: string }[] }, filePath: string) {
  if (event?.type !== 'workspace:changed' || !workspaceEventTouchesPath(event, filePath)) return false
  pruneWorkspaceSelfWrites()
  const timestamp = workspaceSelfWrites.get(normalizeWorkspacePath(filePath))
  return typeof timestamp === 'number' && Date.now() - timestamp <= WORKSPACE_SELF_WRITE_RELOAD_SKIP_MS
}

export function workspaceRelativePath(filePath: string, sessionId = currentSessionId()) {
  const root = sessionId ? workspaceRoots.get(sessionId) : ''
  if (!root) return filePath
  const absNorm = normalizeWorkspacePath(filePath)
  const rootNorm = normalizeWorkspacePath(root)
  if (absNorm === rootNorm) return ''
  if (absNorm.startsWith(rootNorm + '/')) return absNorm.slice(rootNorm.length + 1)
  return filePath
}

function insertWorkspaceMention(node: WorkspaceNode) {
  deps.addWorkspaceComposerMention(node)
  deps.inputEl().dispatchEvent(new Event('input'))
  deps.inputEl().focus()
  showToast(tt('workspace_added_to_chat'))
}

function copyWorkspaceText(text: string) {
  writeClipboardText(text || '').then(() => {
    showToast(tt('copied'))
  }).catch(() => {
    showToast(tt('copy_failed'))
  })
}

function replaceWorkspaceExpandedPrefix(sessionId: string | null, oldPath: string, newPath: string) {
  const expandedSet = getExpandedSet(sessionId)
  const oldPrefix = normalizeWorkspacePath(oldPath)
  const next = new Set<string>()
  for (const p of expandedSet) {
    const norm = normalizeWorkspacePath(p)
    if (norm === oldPrefix || norm.startsWith(oldPrefix + '/')) {
      next.add(newPath + p.slice(oldPath.length))
    } else {
      next.add(p)
    }
  }
  expandedSet.clear()
  for (const path of next) expandedSet.add(path)
}

function removeWorkspaceExpandedPrefix(sessionId: string | null, oldPath: string) {
  const expandedSet = getExpandedSet(sessionId)
  const oldPrefix = normalizeWorkspacePath(oldPath)
  for (const p of [...expandedSet]) {
    const norm = normalizeWorkspacePath(p)
    if (norm === oldPrefix || norm.startsWith(oldPrefix + '/')) expandedSet.delete(p)
  }
}

function updateImageTabSources(owner: string | null, oldPath: string, newPath?: string): void {
  const prefix = normalizeWorkspacePath(oldPath)
  for (const [container, tabs] of workspaceOpenTabs) for (const tab of tabs) {
    const source = tab.imageSource
    if (!source?.path || source.sessionId !== owner) continue
    const norm = normalizeWorkspacePath(source.path)
    if (norm !== prefix && !norm.startsWith(prefix + '/')) continue
    if (newPath) {
      source.path = newPath + source.path.slice(oldPath.length)
      source.src = (window as any).klaus?.media?.url?.(source.path, source.sessionId) || ''
      source.name = tab.name = workspaceBaseName(source.path)
    } else source.src = ''
    if (container === currentSessionId() && tab.path === selectedWorkspaceFile()) void loadWorkspaceFile(tab.path)
  }
}

function replaceWorkspaceTabPathPrefix(sessionId: string | null, oldPath: string, newPath: string) {
  updateImageTabSources(sessionId, oldPath, newPath)
  const tabs = getWorkspaceTabs(sessionId)
  const oldPrefix = normalizeWorkspacePath(oldPath)
  let changed = false
  for (const tab of tabs) {
    const norm = normalizeWorkspacePath(tab.path)
    if (norm === oldPrefix || norm.startsWith(oldPrefix + '/')) {
      forgetWorkspaceDocument(tab)
      tab.path = newPath + tab.path.slice(oldPath.length)
      tab.name = workspaceBaseName(tab.path)
      if (tab.directKind) {
        tab.loaded = false
        tab.mediaUrl = ''
      }
      changed = true
    }
  }
  if (changed) renderWorkspaceTabs()
}

function removeWorkspaceTabsForPrefix(sessionId: string | null, oldPath: string) {
  updateImageTabSources(sessionId, oldPath)
  const tabs = getWorkspaceTabs(sessionId)
  const oldPrefix = normalizeWorkspacePath(oldPath)
  let changed = false
  for (let i = tabs.length - 1; i >= 0; i -= 1) {
    const norm = normalizeWorkspacePath(tabs[i].path)
    if (norm === oldPrefix || norm.startsWith(oldPrefix + '/')) {
      forgetWorkspaceDocument(tabs[i])
      workspaceEditorStates.delete(tabs[i])
      tabs.splice(i, 1)
      changed = true
    }
  }
  if (changed && sessionId === currentSessionId()) {
    const selected = selectedWorkspaceFile(sessionId)
    const selectedNorm = normalizeWorkspacePath(selected)
    if (selectedNorm === oldPrefix || selectedNorm.startsWith(oldPrefix + '/')) {
      const next = tabs[tabs.length - 1] || null
      if (next) workspaceSelectedFiles.set(sessionId as string, next.path)
      else workspaceSelectedFiles.delete(sessionId as string)
    }
    renderWorkspaceTabs()
  }
}

async function runWorkspaceAction(action: string, node: WorkspaceNode, row: HTMLElement) {
  if (!currentSessionId()) return
  if (action === 'open') {
    if (node.isDir) {
      const res = await klausApi().workspace.open(currentSessionId(), node.path).catch((err: unknown) => ({ ok: false as const, path: undefined, error: String(err) }))
      if (res?.error) await klausDialog().alert(res.error || tt('workspace_open_failed'))
    } else {
      selectWorkspaceFile(node)
    }
  } else if (action === 'reveal') {
    const res = await klausApi().workspace.reveal(currentSessionId(), node.path).catch((err: unknown) => ({ ok: false as const, path: undefined, error: String(err) }))
    if (res?.error) await klausDialog().alert(res.error || tt('workspace_reveal_failed'))
  } else if (action === 'copy-relative') {
    copyWorkspaceText(workspaceRelativePath(node.path) || node.name || '')
  } else if (action === 'copy-absolute') {
    copyWorkspaceText(node.path)
  } else if (action === 'add-chat') {
    insertWorkspaceMention(node)
  } else if (action === 'rename') {
    workspaceTree?.rename(node.path)
  } else if (action === 'delete') {
    await deleteWorkspaceNode(node)
  }
}

function showWorkspaceContextMenu(e: MouseEvent, node: WorkspaceNode, row: HTMLElement) {
  e.preventDefault()
  e.stopPropagation()
  if (!currentSessionId() || workspaceRenamingPath) return
  closeWorkspaceContextMenu()
  closeWorkspaceTabContextMenu()
  deps.closeSessionContextMenu()
  workspaceContextRow = row
  row.classList.add(styles['ws-row-context'])

  const menu = document.createElement('div')
  menu.className = 'workspace-context-menu'
  menu.setAttribute('data-file-tree-context-menu-root', 'true')
  menu.setAttribute('role', 'menu')
  const items = [
    ['open', tt('workspace_menu_open')],
    ['reveal', tt('workspace_menu_reveal')],
    ['copy-relative', tt('workspace_menu_copy_relative')],
    ['copy-absolute', tt('workspace_menu_copy_absolute')],
    ['add-chat', tt('workspace_menu_add_to_chat')],
    ['rename', tt('workspace_menu_rename')],
    ['delete', tt('workspace_menu_delete'), 'danger'],
  ]
  menu.innerHTML = items.map(([action, label, tone]) =>
    `<button type="button" role="menuitem" data-action="${action}" class="${tone === 'danger' ? 'danger' : ''}">${escapeHtml(label)}</button>`
  ).join('')
  document.body.appendChild(menu)
  workspaceContextMenu = menu

  for (const btn of menu.querySelectorAll('button[data-action]')) {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      const action = (btn as HTMLElement).dataset.action
      closeWorkspaceContextMenu()
      if (action) await runWorkspaceAction(action, node, row)
    })
  }

  const rect = menu.getBoundingClientRect()
  const margin = 8
  const left = Math.min(e.clientX, window.innerWidth - rect.width - margin)
  const top = Math.min(e.clientY, window.innerHeight - rect.height - margin)
  menu.style.left = Math.max(margin, left) + 'px'
  menu.style.top = Math.max(margin, top) + 'px'

  const onPointerDown = (ev: PointerEvent) => { if (!menu.contains(ev.target as Node)) closeWorkspaceContextMenu() }
  const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === 'Escape') closeWorkspaceContextMenu() }
  const onClose = () => closeWorkspaceContextMenu()
  setTimeout(() => {
    if (workspaceContextMenu !== menu) return
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose, true)
    document.addEventListener('scroll', onClose, true)
    workspaceContextMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose, true)
      document.removeEventListener('scroll', onClose, true)
    }
  }, 0)
}

async function renameWorkspaceTreeNode(node: WorkspaceNode, newName: string) {
  const sessionId = currentSessionId()
  if (!sessionId || !newName || newName === node.name) return
  if (!await flushWorkspacePath(sessionId, node.path)) { showToast(tt('workspace_file_save_failed')); return }
  const result = await klausApi().workspace.rename(sessionId, node.path, newName).catch((error: unknown) => ({ ok: false, path: undefined, error: String(error) }))
  if (result?.ok && result.path) {
    if (node.isDir) replaceWorkspaceExpandedPrefix(sessionId, node.path, result.path)
    replaceWorkspaceTabPathPrefix(sessionId, node.path, result.path)
    const selected = selectedWorkspaceFile(sessionId)
    if (selected === node.path || (node.isDir && selected.startsWith(node.path + '/'))) {
      workspaceSelectedFiles.set(sessionId, result.path + selected.slice(node.path.length))
      if (workspaceMainActive && sessionId === currentSessionId()) void loadWorkspaceFile(selectedWorkspaceFile(sessionId))
    }
  } else await klausDialog().alert(result?.error || tt('workspace_rename_failed'))
  if (sessionId === currentSessionId()) await loadWorkspace(sessionId)
}

async function deleteWorkspaceNode(node: WorkspaceNode) {
  if (!currentSessionId()) return
  const message = tt('workspace_delete_confirm').replace('{name}', node.name || node.path)
  const ok = await klausDialog().confirm({ message, danger: true })
  if (!ok) return
  const sessionId = currentSessionId()
  if (!await flushWorkspacePath(sessionId, node.path)) return
  const res = await klausApi().workspace.delete(sessionId, node.path).catch((err: unknown) => ({ ok: false as const, path: undefined, error: String(err) }))
  if (res?.ok) {
    if (node.isDir) removeWorkspaceExpandedPrefix(sessionId, node.path)
    removeWorkspaceTabsForPrefix(sessionId, node.path)
    const selected = selectedWorkspaceFile(sessionId)
    const deletedPrefix = normalizeWorkspacePath(node.path)
    const selectedNorm = normalizeWorkspacePath(selected)
    if (selectedNorm === deletedPrefix || (node.isDir && selectedNorm.startsWith(deletedPrefix + '/'))) {
      workspaceSelectedFiles.delete(sessionId as string)
      if (workspaceMainActive && sessionId === currentSessionId()) renderWorkspaceFileEmpty()
    } else if (workspaceMainActive && sessionId === currentSessionId()) {
      const active = getActiveWorkspaceTab(sessionId)
      if (active) loadWorkspaceFile(active.path)
      else renderWorkspaceFileEmpty()
    }
    loadWorkspace(sessionId)
    showToast(tt('toast_deleted'))
  } else {
    await klausDialog().alert(res?.error || tt('workspace_delete_failed'))
  }
}

function renderWorkspaceTree(sessionId: string, nodes: WorkspaceNode[], root: string, roots: string[], truncated = false) {
  const host = deps.artifactsList()
  if (!host) return
  const identity = JSON.stringify([root, ...roots])
  if (workspaceTree && workspaceTreeSession === sessionId && workspaceTreeRoots === identity) {
    workspaceTree.update(nodes, truncated)
    return
  }
  workspaceTree?.dispose()
  workspaceTreeSession = sessionId
  workspaceTreeRoots = identity
  workspaceTree = new WorkspaceFileTree({
    host, sessionId, root, roots, nodes,
    expanded: getExpandedSet(sessionId),
    selected: selectedWorkspaceFile(sessionId),
    list: path => klausApi().workspace.list(sessionId, path),
    search: query => klausApi().workspace.search(sessionId, query),
    select: (node, preview) => selectWorkspaceFile(node, { preview }),
    context: showWorkspaceContextMenu,
    rename: renameWorkspaceTreeNode,
  })
  if (truncated) workspaceTree.update(nodes, truncated)
}

function renderWorkspaceTreeEmpty(kind = 'empty') {
  workspaceTree?.dispose(); workspaceTree = undefined; workspaceTreeSession = ''
  if (!deps.artifactsList()) return
  const copy = {
    error: ['workspace_tree_error_title', 'workspace_tree_error_desc'],
    empty: ['workspace_tree_empty_title', 'workspace_tree_empty_desc'],
  }[kind] || ['workspace_tree_empty_title', 'workspace_tree_empty_desc']
  const emptyEl = deps.artifactsList()
  if (!emptyEl) return
  emptyEl.innerHTML = `
    <div class="${styles['ws-empty']}" aria-live="polite">
      <div class="${styles['ws-empty-icon']}" aria-hidden="true">
        ${klausIcon('ws-empty')}
      </div>
      <div class="${styles['ws-empty-title']}">${escapeHtml(tt(copy[0]))}</div>
      <div class="${styles['ws-empty-desc']}">${escapeHtml(tt(copy[1]))}</div>
    </div>
  `
}

export async function loadWorkspace(sessionId: string | null, options: { promoteDraft?: boolean } = {}) {
  if (deps.artifactsPanel()?.classList.contains('collapsed')) return
  const sequence = ++workspaceTreeLoadSequence
  let targetSessionId = sessionId
  // Promoting a draft into a real session is for surfaces the user opened on
  // purpose (the panel toggle, the folder button). Background refreshes that
  // pass a null id — entering the new-chat state after a delete, for one —
  // must not mint a session the user never asked for.
  if (!targetSessionId && options.promoteDraft) targetSessionId = (await ensureWorkspaceSessionForCurrentDraft()) || null
  if (!targetSessionId) { renderWorkspaceTreeEmpty('empty'); return }
  if (workspaceTreeSession !== targetSessionId) {
    workspaceTree?.dispose(); workspaceTree = undefined; workspaceTreeSession = ''
    const host = deps.artifactsList()
    if (host) { host.textContent = tt('loading'); host.setAttribute('aria-busy', 'true') }
  }
  try {
    const data = await klausApi().workspace.list(targetSessionId)
    if (sequence !== workspaceTreeLoadSequence) return
    deps.artifactsList()?.removeAttribute('aria-busy')
    if (!data || data.error || !Array.isArray(data.tree)) {
      if (targetSessionId !== currentSessionId()) return
      renderWorkspaceTreeEmpty('error')
      return
    }
    deps.rememberWorkspaceRoot(targetSessionId, data?.root)
    if (targetSessionId !== currentSessionId()) return
    if (data?.root) setWorkspaceRoot(targetSessionId, data.root)
    renderWorkspaceTree(targetSessionId, data?.tree || [], data?.root || workspaceRootFor(targetSessionId), data?.roots || [], data?.truncated)
  } catch {
    if (sequence !== workspaceTreeLoadSequence || targetSessionId !== currentSessionId()) return
    deps.artifactsList()?.removeAttribute('aria-busy')
    renderWorkspaceTreeEmpty('error')
  }
}
// Backward-compat alias for the existing call sites that still say
// loadArtifacts(sessionId). Keeps the diff small and avoids touching the
// session-switch path while the rename settles.
export const loadArtifacts = loadWorkspace

export function scheduleWorkspaceReload(sessionId: string | null) {
  if (sessionId !== currentSessionId()) return
  if (deps.artifactsPanel()?.classList.contains('collapsed')) return
  if (workspaceReloadTimer) clearTimeout(workspaceReloadTimer)
  workspaceReloadTimer = setTimeout(() => {
    workspaceReloadTimer = null
    loadWorkspace(currentSessionId())
  }, 100)
}



/** composer mention 桥（chat.ts）读写会话根目录。 */
export function workspaceRootFor(sessionId: string | null): string {
  return (sessionId ? workspaceRoots.get(sessionId) : '') || ''
}

export function setWorkspaceRoot(sessionId: string, root: string): void {
  if (sessionId && root) workspaceRoots.set(sessionId, root)
}

export function initWorkspacePanel(injected: WorkspacePanelDeps): void {
  deps = injected
  initializeWorkspaceTreeResize()
}

workspaceFileBody?.addEventListener('click', event => {
  const figure = (event.target as Element)?.closest<HTMLElement>('[data-media-figure], [data-media-thumb]')
  const img = figure?.querySelector('img')
  if (figure && img?.naturalWidth) openImagePreview(img.currentSrc || img.src, imagePreviewOptionsFromElement(figure, workspaceFileBody!))
})
