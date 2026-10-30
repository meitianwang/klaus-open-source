// digram 面板控制器：右侧面板 data-mode="digram" 这块的 surface owner。
//
// 职责边界（和 chat.ts 的分工）：chat.ts 拥有面板的开合与 mode 切换（openArtifactsPanel
// / setArtifactsPanelMode），本模块拥有 mode="digram" 之下的一切——渲染、缩放平移、
// 文档切换、导出、以及（stage 3）把编辑手势接给 edit.ts。它由回复区的 Diagram
// 产物卡和已打开的 panel tab 驱动，两条来源最终都落到同一个 loadDoc()。
//
// 文档不在这里存：唯一真相在 Rust 侧。本模块只持有「当前渲染的这一份」的只读副本 +
// 视图状态（缩放/平移）。任何改动都发 op 给 Rust，等 digram:changed 回来再重渲。

import { render, type RenderResult } from './render'
import { makeTheme, type DigramTheme } from './theme'
import { canvasMeasurer, type TextMeasurer } from './measure'
import { exportScaleFromPercent, rasterize, scaleSvgDimensions, toBase64 } from './export'
import type { DigramDocument } from './types'
import { initDigramEditing, type DigramEditingHandle } from './edit'

const w = () => window as any
const tt = (key: string): string => w().tt?.(key) || key

interface DigramApi {
  list(sessionId: string): Promise<{ diagrams: DiagramRow[] }>
  get(sessionId: string, id?: string): Promise<{ ok?: boolean; error?: string; document?: DigramDocument }>
  applyEdit(sessionId: string, id: string, ops: unknown[], baseVersion?: number): Promise<{ ok?: boolean; error?: string; stale?: boolean; document?: DigramDocument }>
  export(sessionId: string, id: string, format: string, opts?: { scale?: number; svg?: string }): Promise<{ ok?: boolean; canceled?: boolean; error?: string; path?: string }>
  icons(keys: string[]): Promise<{ icons: Record<string, string> }>
  history(sessionId: string, id: string): Promise<{ revisions?: Array<{ version: number; updatedAtMs: number }> }>
  revert(sessionId: string, id: string, version: number): Promise<{ ok?: boolean; error?: string; document?: DigramDocument }>
  onChanged(cb: (payload: { id: string; version: number; sessionId: string }) => void): unknown
  onRenderRequest(
    cb: (payload: { requestId: string; document: DigramDocument; format: string; scale: number }) => void,
  ): unknown
  renderResult(payload: { requestId: string; format?: string; data?: string; error?: string }): Promise<unknown>
}
interface DiagramRow {
  id: string
  title: string
  version: number
  updatedAtMs: number
  pages: number
  nodes: number
}

const api = (): DigramApi | undefined => w().klaus?.digram

export interface DigramPanelDeps {
  currentSessionId(): string | null
  openArtifactsPanel(mode: string): void
  closeArtifactsPanel(): void
  syncTopModeButtons(): void
  renderSessionList(): void
}

// ---- DOM refs（index.html 静态骨架） ----
const canvasHost = () => document.getElementById('digram-canvas')
const emptyEl = () => document.getElementById('digram-empty')
const docSelect = () => document.getElementById('digram-doc-select') as HTMLSelectElement | null
const zoomLabel = () => document.getElementById('digram-zoom-fit')
const undoBtn = () => document.getElementById('digram-undo') as HTMLButtonElement | null
const redoBtn = () => document.getElementById('digram-redo') as HTMLButtonElement | null

// ---- 状态 ----
let deps: DigramPanelDeps | null = null
let doc: DigramDocument | null = null
let lastRender: RenderResult | null = null
let editing: DigramEditingHandle | null = null
let measurer: TextMeasurer | null = null
let zoom = 1
let panX = 0
let panY = 0
// Resolved icon paths, keyed. Filled lazily as diagrams reference icons; a miss
// paints the placeholder and triggers a fetch that repaints.
const iconPaths: Record<string, string> = {}
let iconsPending = false
// `fit` 态下窗口缩放会重新贴合；用户手动缩放/平移后就固定，不再跟随窗口。
let fitMode = true

function theme(): DigramTheme {
  const kind = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  return makeTheme(kind)
}

function ensureMeasurer(): TextMeasurer {
  // canvas 度量依赖字体栈；主题变了字体栈不变，所以只建一次。
  if (!measurer) measurer = canvasMeasurer(theme().fontFamily)
  return measurer
}

// ---- 渲染 ----

/** 重渲当前文档到 SVG 宿主，保持当前缩放/平移。fit 态则重新贴合。 */
function paint() {
  const host = canvasHost()
  if (!host) return
  if (!doc || !doc.pages?.length) {
    host.querySelector('svg')?.remove()
    if (emptyEl()) (emptyEl() as HTMLElement).style.display = ''
    return
  }
  if (emptyEl()) (emptyEl() as HTMLElement).style.display = 'none'
  ensureIcons(doc)
  lastRender = render(doc, {
    theme: theme(),
    measurer: ensureMeasurer(),
    showGrid: true,
    selected: editing?.selectedIds(),
    icons: iconPaths,
    padding: 40,
  })
  // 整串替换：渲染是纯函数，没有增量状态要维护，一次 innerHTML 最简单也最稳。
  const existing = host.querySelector('svg')
  if (existing) existing.remove()
  host.insertAdjacentHTML('beforeend', lastRender.svg)
  if (fitMode) fit()
  else applyTransform()
  editing?.onPainted(lastRender)
  syncUndoRedo()
}

/** Fetch path data for any icon keys the doc references that we do not have yet,
 *  then repaint. A catalog key is `phosphor:*`; inline `path:` needs no lookup. */
function ensureIcons(doc: DigramDocument): void {
  if (iconsPending) return
  const missing = new Set<string>()
  for (const page of doc.pages ?? []) {
    for (const node of page.nodes ?? []) {
      const key = node.icon
      if (key && !key.startsWith('path:') && !(key in iconPaths)) missing.add(key)
    }
  }
  if (!missing.size) return
  const bridge = api()
  if (!bridge) return
  iconsPending = true
  void bridge
    .icons([...missing])
    .then((reply) => {
      let changed = false
      for (const [key, path] of Object.entries(reply.icons ?? {})) {
        iconPaths[key] = path
        changed = true
      }
      // Cache misses too (empty string), so a missing glyph is not re-fetched
      // every paint; it stays the placeholder.
      for (const key of missing) if (!(key in iconPaths)) iconPaths[key] = ''
      iconsPending = false
      if (changed) paint()
    })
    .catch(() => {
      iconsPending = false
    })
}

/** 把缩放/平移落成 SVG 的 transform。SVG 用绝对定位，缩放是一次矩阵而不是逐节点重排。 */
function applyTransform() {
  const svg = canvasHost()?.querySelector('svg') as SVGElement | null
  if (!svg) return
  svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`
  const pct = Math.round(zoom * 100)
  if (zoomLabel()) (zoomLabel() as HTMLElement).textContent = fitMode ? tt('digram_zoom_fit') : `${pct}%`
}

/** 让整图贴合视口并居中。 */
function fit() {
  const host = canvasHost()
  if (!host || !lastRender) return
  const box = host.getBoundingClientRect()
  const margin = 24
  const scale = Math.min(
    (box.width - margin * 2) / lastRender.width,
    (box.height - margin * 2) / lastRender.height,
    1.5,
  )
  zoom = Number.isFinite(scale) && scale > 0 ? scale : 1
  panX = (box.width - lastRender.width * zoom) / 2
  panY = (box.height - lastRender.height * zoom) / 2
  fitMode = true
  applyTransform()
}

function setZoom(next: number, anchor?: { x: number; y: number }) {
  const host = canvasHost()
  if (!host) return
  const clamped = Math.max(0.1, Math.min(next, 8))
  const box = host.getBoundingClientRect()
  // 以锚点（默认视口中心）为定点缩放：光标/中心底下的那个点在缩放前后落在同一屏幕位置。
  const ax = anchor ? anchor.x - box.left : box.width / 2
  const ay = anchor ? anchor.y - box.top : box.height / 2
  const ratio = clamped / zoom
  panX = ax - (ax - panX) * ratio
  panY = ay - (ay - panY) * ratio
  zoom = clamped
  fitMode = false
  applyTransform()
}

// ---- 文档加载 ----

async function loadDoc(sessionId: string, id?: string): Promise<void> {
  const bridge = api()
  if (!bridge) return
  let reply: any
  try {
    reply = await bridge.get(sessionId, id)
  } catch (error) {
    if (deps?.currentSessionId() === sessionId) w().showToast?.((error as Error | null)?.message || tt('digram_load_failed'), 'error')
    return
  }
  if (deps?.currentSessionId() !== sessionId) return
  if (reply?.error) {
    w().showToast?.(reply.error || tt('digram_load_failed'), 'error')
    return
  }
  if (!reply?.document) {
    doc = null
    paint()
    await refreshDocList(sessionId)
    return
  }
  doc = reply.document
  fitMode = true
  paint()
  await refreshDocList(sessionId)
}

async function refreshDocList(sessionId = deps?.currentSessionId() || ''): Promise<void> {
  const bridge = api()
  const select = docSelect()
  if (!bridge || !select) return
  if (!sessionId) {
    select.innerHTML = ''
    select.style.display = 'none'
    return
  }
  let diagrams: DiagramRow[]
  try {
    const reply = await bridge.list(sessionId)
    if (!Array.isArray(reply?.diagrams)) throw new Error(tt('digram_load_failed'))
    diagrams = reply.diagrams
  } catch (error) {
    if (deps?.currentSessionId() === sessionId) w().showToast?.((error as Error | null)?.message || tt('digram_load_failed'), 'error')
    return
  }
  if (deps?.currentSessionId() !== sessionId) return
  select.innerHTML = ''
  for (const row of diagrams) {
    const option = document.createElement('option')
    option.value = row.id
    option.textContent = row.title?.trim() || row.id
    if (doc && row.id === doc.id) option.selected = true
    select.appendChild(option)
  }
  select.style.display = diagrams.length > 1 ? '' : 'none'
}

function syncUndoRedo() {
  if (undoBtn()) (undoBtn() as HTMLButtonElement).disabled = !editing?.canUndo()
  if (redoBtn()) (redoBtn() as HTMLButtonElement).disabled = !editing?.canRedo()
}

// ---- 导出 ----

type ExportFormat = 'png' | 'jpg' | 'svg'

let exportFormat: ExportFormat = 'png'
let exportIncludeGrid = false
let exportScalePercent = 100
let dismissExportMenu: (() => void) | undefined

async function exportAs(format: ExportFormat, includeGrid: boolean, scalePercent: number) {
  const bridge = api()
  const sessionId = deps?.currentSessionId()
  if (!bridge || !sessionId || !doc || !lastRender) return
  try {
    const scale = exportScaleFromPercent(scalePercent)
    const clean = render(doc, {
      theme: theme(),
      measurer: ensureMeasurer(),
      showGrid: includeGrid,
      icons: iconPaths,
      padding: 24,
    })
    if (format === 'svg') {
      const svg = scaleSvgDimensions(clean.svg, scale)
      const reply = await bridge.export(sessionId, doc.id, format, { scale, svg })
      notifyExport(reply)
      return
    }
    const bytes = await rasterize(clean.svg, format, scale)
    const reply = await bridge.export(sessionId, doc.id, format, { scale, svg: toBase64(bytes) })
    notifyExport(reply)
  } catch (error) {
    const message = String((error as Error)?.message || error)
    const translated = message === 'digram export: output is too large'
      ? tt('digram_export_too_large')
      : message.includes('scale')
        ? tt('digram_export_scale_error')
        : message
    w().showToast?.(translated, 'error')
  }
}

function notifyExport(reply: { ok?: boolean; canceled?: boolean; error?: string; path?: string } | undefined) {
  if (reply?.canceled) return
  if (reply?.ok && reply.path) w().showToast?.(tt('digram_exported'), 'success')
  else if (reply?.error) w().showToast?.(reply.error, 'error')
}

function openExportMenu(anchor: HTMLElement) {
  if (dismissExportMenu) {
    dismissExportMenu()
    return
  }

  const menu = document.createElement('form')
  menu.id = 'digram-export-menu'
  menu.className = 'digram-export-menu'
  menu.setAttribute('role', 'dialog')
  menu.setAttribute('aria-label', tt('digram_export'))

  const formatField = document.createElement('label')
  formatField.className = 'digram-export-field'
  const formatLabel = document.createElement('span')
  formatLabel.textContent = tt('digram_export_format')
  const formatSelect = document.createElement('select')
  formatSelect.className = 'digram-export-select'
  for (const format of ['png', 'jpg', 'svg'] as const) {
    const option = document.createElement('option')
    option.value = format
    option.textContent = format.toUpperCase()
    option.selected = format === exportFormat
    formatSelect.appendChild(option)
  }
  formatField.append(formatLabel, formatSelect)

  const gridField = document.createElement('label')
  gridField.className = 'digram-export-check'
  const gridInput = document.createElement('input')
  gridInput.type = 'checkbox'
  gridInput.checked = exportIncludeGrid
  const gridLabel = document.createElement('span')
  gridLabel.textContent = tt('digram_export_include_grid')
  gridField.append(gridInput, gridLabel)

  const scaleField = document.createElement('label')
  scaleField.className = 'digram-export-field'
  const scaleLabel = document.createElement('span')
  scaleLabel.textContent = tt('digram_export_scale')
  const scaleControl = document.createElement('span')
  scaleControl.className = 'digram-export-scale'
  const scaleInput = document.createElement('input')
  scaleInput.type = 'number'
  scaleInput.min = '10'
  scaleInput.max = '400'
  scaleInput.step = '10'
  scaleInput.value = String(exportScalePercent)
  scaleInput.inputMode = 'numeric'
  const percent = document.createElement('span')
  percent.textContent = '%'
  scaleControl.append(scaleInput, percent)
  scaleField.append(scaleLabel, scaleControl)

  const actions = document.createElement('div')
  actions.className = 'digram-export-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'digram-export-cancel'
  cancel.textContent = tt('cancel')
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'digram-export-submit'
  submit.textContent = tt('digram_export')
  actions.append(cancel, submit)
  menu.append(formatField, gridField, scaleField, actions)

  const listeners = new AbortController()
  const close = () => {
    listeners.abort()
    menu.remove()
    dismissExportMenu = undefined
  }
  dismissExportMenu = close
  cancel.addEventListener('click', close)
  menu.addEventListener('submit', async (event) => {
    event.preventDefault()
    const scalePercent = Number(scaleInput.value)
    try {
      exportScaleFromPercent(scalePercent)
    } catch {
      w().showToast?.(tt('digram_export_scale_error'), 'error')
      scaleInput.focus()
      return
    }
    exportFormat = formatSelect.value as ExportFormat
    exportIncludeGrid = gridInput.checked
    exportScalePercent = scalePercent
    for (const control of menu.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) {
      control.disabled = true
    }
    await exportAs(exportFormat, exportIncludeGrid, exportScalePercent)
    close()
  })

  const box = anchor.getBoundingClientRect()
  menu.style.position = 'fixed'
  menu.style.top = `${box.bottom + 4}px`
  menu.style.right = `${window.innerWidth - box.right}px`
  document.body.appendChild(menu)
  formatSelect.focus()
  setTimeout(() => {
    document.addEventListener('mousedown', (event) => {
      if (!menu.contains(event.target as Node)) close()
    }, { capture: true, signal: listeners.signal })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close()
    }, { signal: listeners.signal })
  }, 0)
}

// ---- 平移（空白处拖动 / 滚轮） ----

function wireViewport() {
  const host = canvasHost()
  if (!host) return
  // 滚轮缩放（带 ctrl/cmd）或平移。以光标为锚点缩放。
  host.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        setZoom(zoom * (event.deltaY < 0 ? 1.1 : 0.9), { x: event.clientX, y: event.clientY })
      } else {
        panX -= event.deltaX
        panY -= event.deltaY
        fitMode = false
        applyTransform()
      }
    },
    { passive: false },
  )
  // 空白处按下拖动 = 平移；命中节点则交给 edit.ts（stage 3）。中键始终平移。
  host.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return
    const onNode = event.button === 0 && editing?.hitTest(event)
    if (onNode) return
    event.preventDefault()
    host.classList.add('is-panning')
    host.setPointerCapture(event.pointerId)
    const startX = event.clientX - panX
    const startY = event.clientY - panY
    const move = (moveEvent: PointerEvent) => {
      panX = moveEvent.clientX - startX
      panY = moveEvent.clientY - startY
      fitMode = false
      applyTransform()
    }
    const up = () => {
      host.classList.remove('is-panning')
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerup', up)
    }
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerup', up)
  })
}

// ---- 公开入口 ----

/** 离屏渲染一份传入的文档（不是面板当前那份）并把字节回传给等待的工具调用。 */
async function handleRenderRequest(payload: {
  requestId: string
  document: DigramDocument
  format: string
  scale: number
}): Promise<void> {
  const bridge = api()
  if (!bridge) return
  try {
    const keys = [...new Set(payload.document.pages.flatMap(page =>
      (page.nodes ?? []).map(node => node.icon).filter((key): key is string => !!key && !key.startsWith('path:')),
    ))]
    const renderIcons: Record<string, string> = {}
    for (let offset = 0; offset < keys.length; offset += 1000) {
      const reply = await bridge.icons(keys.slice(offset, offset + 1000))
      Object.assign(renderIcons, reply.icons)
    }
    const clean = render(payload.document, { theme: theme(), measurer: ensureMeasurer(), padding: 24, icons: renderIcons })
    if (payload.format === 'svg') {
      await bridge.renderResult({ requestId: payload.requestId, format: 'svg', data: clean.svg })
      return
    }
    const format = payload.format === 'jpg' || payload.format === 'jpeg' ? 'jpg' : 'png'
    const bytes = await rasterize(clean.svg, format, payload.scale || 2)
    await bridge.renderResult({ requestId: payload.requestId, format, data: toBase64(bytes) })
  } catch (error) {
    await bridge.renderResult({ requestId: payload.requestId, error: String((error as Error)?.message || error) })
  }
}

/** Open the current session's Diagram panel, optionally at one exact artifact. */
async function activate(id?: string, ownerSessionId?: string): Promise<void> {
  const sessionId = deps?.currentSessionId()
  if (!sessionId || (ownerSessionId && ownerSessionId !== sessionId)) return
  const targetId = id || (doc?.sessionId === sessionId ? doc.id : undefined)
  deps?.openArtifactsPanel('digram')
  await loadDoc(sessionId, targetId)
}

export function initDigramPanel(injected: DigramPanelDeps): void {
  deps = injected
  wireViewport()
  editing = initDigramEditing({
    getDoc: () => doc,
    getRender: () => lastRender,
    viewTransform: () => ({ zoom, panX, panY }),
    canvasHost,
    applyOps: async (ops) => {
      const bridge = api()
      const sessionId = deps?.currentSessionId()
      if (!bridge || !sessionId || !doc) return
      // Send the version these ops were built against. If an agent edit landed
      // since, the host replies stale with the current document; we adopt it and
      // repaint rather than clobbering the agent's change with a stale drag.
      const reply: { document?: DigramDocument; error?: string; stale?: boolean } = await bridge.applyEdit(sessionId, doc.id, ops, doc.version).catch((error: unknown) => ({
        error: (error as Error | null)?.message || tt('digram_edit_failed'),
      }))
      if (reply?.document) {
        doc = reply.document
        paint()
        if (reply.stale) w().showToast?.(tt('digram_reloaded'), 'info')
      } else {
        w().showToast?.(reply?.error || tt('digram_edit_failed'), 'error')
      }
    },
    repaint: paint,
  })

  // 工具栏。
  document.getElementById('digram-zoom-in')?.addEventListener('click', () => setZoom(zoom * 1.2))
  document.getElementById('digram-zoom-out')?.addEventListener('click', () => setZoom(zoom / 1.2))
  document.getElementById('digram-zoom-reset')?.addEventListener('click', () => setZoom(1))
  zoomLabel()?.addEventListener('click', () => fit())
  document.getElementById('digram-export')?.addEventListener('click', (event) =>
    openExportMenu(event.currentTarget as HTMLElement),
  )
  undoBtn()?.addEventListener('click', () => editing?.undo())
  redoBtn()?.addEventListener('click', () => editing?.redo())
  docSelect()?.addEventListener('change', (event) => {
    const id = (event.target as HTMLSelectElement).value
    const sessionId = deps?.currentSessionId()
    if (id && sessionId) void loadDoc(sessionId, id)
  })

  // 主题切换后重算颜色重渲（同一份文档，明暗两套都对）。
  window.addEventListener('klaus:theme-change', () => {
    measurer = null
    if (doc) paint()
  })
  window.addEventListener('klaus:lang-change', () => {
    if (fitMode && zoomLabel()) (zoomLabel() as HTMLElement).textContent = tt('digram_zoom_fit')
  })
  window.addEventListener('klaus:session-change', (event: Event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || ''
    doc = null
    paint()
    void refreshDocList(sessionId)
  })

  api()?.onChanged((payload) => {
    if (payload.sessionId !== deps?.currentSessionId()) return
    if (doc && payload.id === doc.id) void loadDoc(payload.sessionId, doc.id)
    else void refreshDocList(payload.sessionId)
  })
  // 引擎侧（digram_export 工具）请求离屏渲染成图片：渲染是渲染进程的活，这里对
  // 传入的整份文档做一次干净渲染并回传字节，不动面板自身的视图。
  ;(api())?.onRenderRequest?.((payload) => {
    void handleRenderRequest(payload)
  })

  // Transcript artifact cards pass both identities so a stale click cannot open
  // another conversation's Diagram after a session switch.
  w().klausOpenDigramPanel = (id?: string, sessionId?: string) => {
    void activate(typeof id === 'string' ? id : undefined, typeof sessionId === 'string' ? sessionId : undefined)
  }
  w().klausCloseDigramPanel = () => {
    // 单实例 surface：关掉就回到 Monitor（closeTab 的 fallback 也会补一次激活，
    // 这里直接回 monitor 保证即便无 fallback 也不会留一个空的 digram 面板）。
    deps?.openArtifactsPanel('monitor')
    deps?.syncTopModeButtons()
    deps?.renderSessionList()
  }
  w().KlausDigram = {
    activate,
    reload: () => {
      const sessionId = deps?.currentSessionId()
      if (sessionId) return loadDoc(sessionId, doc?.id)
    },
  }

  // 窗口缩放时，fit 态跟随重贴合。
  window.addEventListener('resize', () => {
    if (fitMode && doc) fit()
  })
}
