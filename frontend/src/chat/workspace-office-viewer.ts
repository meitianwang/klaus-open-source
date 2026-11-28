import { attachPanelQuoteToolbar, openPanelQuoteContextMenu } from './panel-quote-toolbar'
import { rawIconHtml } from '../components/Icon'
import type { QuoteSourceMetadata } from './selected-text-envelope'
import { recalculateSpreadsheet } from '../../../contracts/office-formula'
import type {
  OfficeDocBlock,
  OfficeDocumentPreview,
  OfficeInlineRun,
  OfficeMindMapPreview,
  OfficeMindMapTopic,
  OfficePresentationPreview,
  OfficePreviewPayload,
  OfficeSlide,
  OfficeSlideParagraph,
  OfficeSpreadsheetPreview,
  OfficeWorksheet,
} from '../../../contracts/office-preview'
import { officePreviewEn } from '../i18n/office-preview-messages'
import css from './workspace-office-viewer.module.css'

export function officeSheetQuote(sheet: OfficeWorksheet, r: number, c: number, endR: number, endC: number, includeContent = true) {
  let minR = Math.min(r, endR), maxR = Math.max(r, endR), minC = Math.min(c, endC), maxC = Math.max(c, endC)
  let changed: boolean
  do {
    changed = false
    for (const cell of sheet.cells) {
      const bottom = cell.r + (cell.rs || 1) - 1, right = cell.c + (cell.cs || 1) - 1
      if (cell.r > maxR || bottom < minR || cell.c > maxC || right < minC) continue
      if (cell.r < minR || bottom > maxR || cell.c < minC || right > maxC) changed = true
      minR = Math.min(minR, cell.r); maxR = Math.max(maxR, bottom)
      minC = Math.min(minC, cell.c); maxC = Math.max(maxC, right)
    }
  } while (changed)
  const start = `${column(minC)}${minR + 1}`, end = `${column(maxC)}${maxR + 1}`
  const cellRange = start === end ? start : `${start}:${end}`
  if (!includeContent) return { minR, maxR, minC, maxC, cellRange, text: '', raw: '', columnHeaders: '', formulas: '' }
  const cells = new Map(sheet.cells.map(cell => [`${cell.r}:${cell.c}`, cell]))
  const columns = Array.from({ length: maxC - minC + 1 }, (_, index) => minC + index)
  const rows = Array.from({ length: maxR - minR + 1 }, (_, index) => minR + index)
  const raw = rows.map(row => columns.map(col => cells.get(`${row}:${col}`)?.v || '').join('\t')).join('\n')
  const columnHeaders = minR ? columns.flatMap(col => { const value = cells.get(`0:${col}`)?.v; return value ? [`${column(col)}=${JSON.stringify(value)}`] : [] }).join(', ').slice(0, 160) : ''
  const formulas = sheet.cells.filter(cell => cell.f && cell.r >= minR && cell.r <= maxR && cell.c >= minC && cell.c <= maxC).slice(0, 12)
    .map(cell => `${column(cell.c)}${cell.r + 1}==${cell.f!.replace(/^=/, '')}`).join(', ')
  return { minR, maxR, minC, maxC, cellRange, text: raw.trim() ? raw : `(${cellRange} empty)`, raw, columnHeaders, formulas }
}

export interface WorkspaceOfficeViewState {
  activeSheet?: number
  sheetStates?: Record<number, { r: number; c: number; scrollTop: number; scrollLeft: number }>
  scrollTop?: number
  activeSlide?: number
  selectedSlideElement?: number
  activeMindSheet?: number
  selectedTopicId?: string
  mindZoom?: number
  activeDocBlock?: number
}

export interface OfficeSaveResult {
  ok: boolean
  conflict?: boolean
  error?: string
  mtimeMs?: number | null
  savedPath?: string
}

type Vars = Record<string, string | number>

export interface MountOfficeViewerOptions {
  filePath?: string
  state?: WorkspaceOfficeViewState
  translate?: (key: string, vars?: Vars) => string
  openExternal?: (url: string) => void
  copyText?: (text: string) => void
  editable?: boolean
  canSaveInPlace?: boolean
  singleSheet?: boolean
  dirty?: boolean
  onChange?: (payload: OfficePreviewPayload) => void
  onSave?: (payload: OfficePreviewPayload) => Promise<OfficeSaveResult | boolean | void>
  onSaveAs?: (payload: OfficePreviewPayload) => Promise<OfficeSaveResult | boolean | void>
}

export interface MountedOfficeViewer {
  destroy: () => void
  update: (next: OfficePreviewPayload, meta?: { canSaveInPlace?: boolean; dirty?: boolean }) => void
  getPayload: () => OfficePreviewPayload
  markSaved: () => void
  save: () => Promise<boolean>
  saveAs: () => Promise<boolean>
}

const BRANCH_COLORS = ['#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed']

function clonePayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function makeTopicId(): string {
  return `topic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, cls?: string, text?: string) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  parent.append(n)
  return n
}

function svgNode(tag: string, parent?: Element): Element {
  const n = typeof document.createElementNS === 'function'
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag)
  if (parent) parent.append(n)
  return n
}

function paint(node: HTMLElement, bg?: string, color?: string) {
  if (bg) {
    node.style.backgroundColor = bg
    const m = /^#([a-f\d]{3}|[a-f\d]{6})$/i.exec(bg)
    if (!color && m) {
      const hex = m[1]!.length === 3 ? m[1]!.replace(/./g, '$&$&') : m[1]!
      const [r, g, b] = [0, 2, 4].map(i => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255
        return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
      })
      color = .2126 * r! + .7152 * g! + .0722 * b! > .18 ? '#1a1c1f' : '#f9fafb'
    }
  }
  if (color) node.style.color = color
}

function column(index: number) {
  let result = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result
  return result
}

function image(parent: HTMLElement, src: string, alt = '') {
  const img = el('img', parent)
  if (/^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);base64,/i.test(src)) img.src = src
  img.alt = alt
  return img
}

function cols(table: HTMLTableElement, widths: number[], unit: string) {
  const group = el('colgroup', table)
  for (const width of widths) el('col', group).style.width = `${width}${unit}`
}

function extractInlineRunsFromDom(container: HTMLElement): OfficeInlineRun[] {
  const out: OfficeInlineRun[] = []
  const walk = (node: ChildNode, marks: Partial<OfficeInlineRun>) => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      if (text) out.push({ ...marks, text })
      return
    }
    if (node.nodeType !== 1) return
    const element = node as HTMLElement
    const tag = element.tagName.toLowerCase()
    if (tag === 'img') return
    if (tag === 'br') {
      out.push({ text: '', br: true })
      return
    }
    if (element.dataset?.listMarker === '1') return
    const next: Partial<OfficeInlineRun> = { ...marks }
    if (tag === 'strong' || tag === 'b') next.bold = true
    if (tag === 'em' || tag === 'i') next.italic = true
    if (tag === 'u') next.underline = true
    if (tag === 's' || tag === 'strike' || tag === 'del') next.strike = true
    if (tag === 'code') next.code = true
    if (tag === 'sup') next.sup = true
    if (tag === 'sub') next.sub = true
    if (tag === 'a') {
      const href = element.getAttribute?.('href') || (element as HTMLAnchorElement).href
      if (href && /^(?:https?:|mailto:)/i.test(href)) next.href = href
    }
    if (element.dataset?.runColor) next.color = element.dataset.runColor
    if (element.dataset?.runHighlight) next.highlight = element.dataset.runHighlight
    if (element.dataset?.runFontSize) next.fontSize = Number(element.dataset.runFontSize)
    const children = Array.from(element.childNodes ?? [])
    if (!children.length && element.textContent) {
      out.push({ ...next, text: element.textContent })
      return
    }
    for (const child of children) walk(child, next)
    if ((tag === 'div' || tag === 'p') && element !== container) {
      out.push({ text: '', br: true })
    }
  }
  const children = Array.from(container.childNodes ?? [])
  if (!children.length) {
    const raw = container.textContent ?? ''
    return raw ? [{ text: raw }] : [{ text: '' }]
  }
  for (const child of children) walk(child, {})
  while (out.length > 1 && out.at(-1)?.br) out.pop()
  return out.length ? out : [{ text: '' }]
}

function findTopicAndParent(
  root: OfficeMindMapTopic,
  id: string,
  parent: OfficeMindMapTopic | null = null,
): { topic: OfficeMindMapTopic; parent: OfficeMindMapTopic | null; index: number } | null {
  if (root.id === id) return { topic: root, parent, index: -1 }
  const list = root.children ?? []
  for (let i = 0; i < list.length; i++) {
    const child = list[i]!
    if (child.id === id) return { topic: child, parent: root, index: i }
    const nested = findTopicAndParent(child, id, child)
    if (nested) return nested
  }
  return null
}

function countHiddenDescendants(topic: OfficeMindMapTopic): number {
  let count = 0
  for (const child of topic.children ?? []) {
    count += 1 + countHiddenDescendants(child)
  }
  return count
}

export function mountOfficeViewer(host: HTMLElement, payload: OfficePreviewPayload, options: MountOfficeViewerOptions = {}): MountedOfficeViewer {
  const quoteBindings: (() => void)[] = []
  const quoteEnabled = !!host.ownerDocument?.defaultView?.klausQuoteAddToChat
  const addQuote = (text: string, source: QuoteSourceMetadata) => host.ownerDocument.defaultView?.klausQuoteAddToChat?.(text, { source: { path: options.filePath, ...source } })
  const closest = (node: Node, selector: string) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>(selector)
  function quoteButton(parent: HTMLElement, action: () => void) {
    const button = el('button', parent, 'kls-panel-quote-inline-btn')
    button.type = 'button'
    button.innerHTML = rawIconHtml('quoted-text')
    button.append(options.translate?.('panel_quote_add_to_chat') || 'Add to chat')
    button.onclick = action
    return button
  }
  function bindTextQuote(parent: HTMLElement, resolve: (range: Range) => QuoteSourceMetadata, current?: () => { text: string; source: QuoteSourceMetadata; anchorRect: DOMRect } | null) {
    if (!quoteEnabled) return
    quoteBindings.push(attachPanelQuoteToolbar(parent, {
      resolveCurrent: current,
      resolveSelection: (_, range) => ({ text: range.toString(), source: { path: options.filePath, ...resolve(range) } }),
    }))
  }

  const state = options.state ?? {}
  let canSaveInPlace = options.canSaveInPlace !== false
  let dirty = Boolean(options.dirty)
  let saving = false
  let statusKind: 'idle' | 'saved' | 'conflict' | 'error' = 'idle'
  let statusError = ''
  let current: OfficePreviewPayload = clonePayload(payload)
  const undoStack: OfficePreviewPayload[] = []
  const redoStack: OfficePreviewPayload[] = []
  let pendingFlush: (() => void) | null = null

  const editingEnabled = () => Boolean(
    (options.editable || options.onChange || options.onSave || options.onSaveAs)
    && current.kind !== 'pdf'
    && current.kind !== 'error',
  )

  const t = (suffix: string, vars: Vars = {}) => {
    const key = `office_preview_${suffix}` as keyof typeof officePreviewEn
    const translated = options.translate?.(key, vars)
    return (translated && translated !== key ? translated : officePreviewEn[key]).replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match))
  }

  const root = el('div', host, css.viewer)
  root.tabIndex = -1
  const empty = (key: string, vars?: Vars, parent = root) => el('div', parent, css.empty, t(key, vars))

  let statusEl: HTMLElement | null = null
  let saveBtnEl: HTMLButtonElement | null = null
  let undoBtnEl: HTMLButtonElement | null = null
  let redoBtnEl: HTMLButtonElement | null = null

  function refreshToolbarStatus() {
    if (undoBtnEl) undoBtnEl.disabled = undoStack.length === 0 || saving
    if (redoBtnEl) redoBtnEl.disabled = redoStack.length === 0 || saving
    if (saveBtnEl) saveBtnEl.disabled = !canSaveInPlace || saving || !dirty
    if (!statusEl) return
    statusEl.className = css.statusBadge || ''
    if (saving) {
      statusEl.textContent = t('editor_saving')
    } else if (statusKind === 'conflict') {
      statusEl.textContent = t('editor_conflict')
      if (css.statusError) statusEl.classList.add(css.statusError)
    } else if (statusKind === 'error') {
      statusEl.textContent = t('editor_save_failed', { error: statusError })
      if (css.statusError) statusEl.classList.add(css.statusError)
    } else if (!canSaveInPlace) {
      statusEl.textContent = dirty ? `${t('editor_unsaved')} · ${t('editor_export_only')}` : t('editor_export_only')
      if (dirty && css.statusDirty) statusEl.classList.add(css.statusDirty)
    } else if (dirty) {
      statusEl.textContent = t('editor_unsaved')
      if (css.statusDirty) statusEl.classList.add(css.statusDirty)
    } else if (statusKind === 'saved') {
      statusEl.textContent = t('editor_saved')
    } else {
      statusEl.textContent = ''
    }
  }

  function pushMutation(mutator: (draft: OfficePreviewPayload) => void, rerender = true) {
    pendingFlush?.()
    pendingFlush = null
    undoStack.push(clonePayload(current))
    if (undoStack.length > 60) undoStack.shift()
    redoStack.length = 0
    const next = clonePayload(current)
    mutator(next)
    current = next
    dirty = true
    statusKind = 'idle'
    options.onChange?.(clonePayload(current))
    if (rerender) render(current, false)
    else refreshToolbarStatus()
  }

  function undo() {
    pendingFlush?.()
    pendingFlush = null
    const prev = undoStack.pop()
    if (!prev) return
    redoStack.push(clonePayload(current))
    current = prev
    dirty = true
    statusKind = 'idle'
    options.onChange?.(clonePayload(current))
    render(current, false)
  }

  function redo() {
    pendingFlush?.()
    pendingFlush = null
    const next = redoStack.pop()
    if (!next) return
    undoStack.push(clonePayload(current))
    current = next
    dirty = true
    statusKind = 'idle'
    options.onChange?.(clonePayload(current))
    render(current, false)
  }

  async function runSave(saveAs: boolean): Promise<boolean> {
    pendingFlush?.()
    pendingFlush = null
    const handler = saveAs ? options.onSaveAs : (canSaveInPlace ? options.onSave : options.onSaveAs)
    if (!handler || saving) return false
    saving = true
    statusKind = 'idle'
    refreshToolbarStatus()
    try {
      const res = await handler(clonePayload(current))
      saving = false
      if (res === false) {
        refreshToolbarStatus()
        return false
      }
      if (res && typeof res === 'object') {
        if (res.conflict) {
          statusKind = 'conflict'
          refreshToolbarStatus()
          return false
        }
        if (!res.ok) {
          if (res.error && res.error !== 'cancelled') {
            statusKind = 'error'
            statusError = res.error
          }
          refreshToolbarStatus()
          return false
        }
      }
      if (!saveAs || canSaveInPlace) dirty = false
      statusKind = 'saved'
      refreshToolbarStatus()
      return true
    } catch (err) {
      saving = false
      statusKind = 'error'
      statusError = err instanceof Error ? err.message : String(err)
      refreshToolbarStatus()
      return false
    }
  }

  function mountEditorHeader(buildActions?: (bar: HTMLElement) => void) {
    const bar = el('div', root, css.editorToolbar)
    const historyGroup = el('div', bar, css.toolbarGroup)
    undoBtnEl = el('button', historyGroup, css.toolbarBtn, t('editor_undo'))
    undoBtnEl.type = 'button'
    undoBtnEl.setAttribute('aria-label', t('editor_undo'))
    undoBtnEl.onclick = () => undo()
    redoBtnEl = el('button', historyGroup, css.toolbarBtn, t('editor_redo'))
    redoBtnEl.type = 'button'
    redoBtnEl.setAttribute('aria-label', t('editor_redo'))
    redoBtnEl.onclick = () => redo()

    buildActions?.(bar)

    el('span', bar, css.toolbarSpacer)
    statusEl = el('span', bar, css.statusBadge)
    statusEl.setAttribute('role', 'status')

    const saveGroup = el('div', bar, css.toolbarGroup)
    if (canSaveInPlace && options.onSave) {
      saveBtnEl = el('button', saveGroup, `${css.toolbarBtn} ${css.toolbarPrimary}`, t('editor_save'))
      saveBtnEl.type = 'button'
      saveBtnEl.onclick = () => { void runSave(false) }
    } else {
      saveBtnEl = null
    }
    if (options.onSaveAs) {
      const saveAsBtn = el('button', saveGroup, canSaveInPlace ? css.toolbarBtn : `${css.toolbarBtn} ${css.toolbarPrimary}`, t('editor_save_as'))
      saveAsBtn.type = 'button'
      saveAsBtn.onclick = () => { void runSave(true) }
    }
    refreshToolbarStatus()
    return bar
  }

  function runs(parent: HTMLElement, items: OfficeInlineRun[], slideWidth?: number) {
    for (const run of items) {
      if (run.br) { el('br', parent); continue }
      let node = el('span', parent)
      paint(node, run.highlight, run.color)
      if (run.color && node.dataset) node.dataset.runColor = run.color
      if (run.highlight && node.dataset) node.dataset.runHighlight = run.highlight
      if (run.fontSize && node.dataset) node.dataset.runFontSize = String(run.fontSize)
      if (slideWidth && run.fontSize) node.style.setProperty('--office-slide-fs', `${100 * run.fontSize / slideWidth}cqw`)
      else if (run.fontSize) node.style.fontSize = `${run.fontSize}pt`
      if (run.href && /^(?:https?:|mailto:)/i.test(run.href) && options.openExternal) {
        const link = el('a', node)
        const url = run.href
        link.href = url
        link.onclick = event => {
          if (editingEnabled() && !(event as MouseEvent).metaKey && !(event as MouseEvent).ctrlKey) return
          event.preventDefault()
          options.openExternal?.(url)
        }
        node = link
      }
      for (const [enabled, tag] of [[run.bold, 'strong'], [run.italic, 'em'], [run.underline, 'u'], [run.strike, 's'], [run.code, 'code'], [run.sup, 'sup'], [run.sub, 'sub']] as const) {
        if (enabled) node = el(tag, node)
      }
      node.textContent = run.text
    }
  }

  function blocks(parent: HTMLElement, items: OfficeDocBlock[]) {
    for (const block of items) {
      if (block.kind === 'hr') { el('hr', parent); continue }
      if (block.kind === 'paragraph') {
        const p = el(block.heading ? `h${block.heading}` : block.role === 'quote' ? 'blockquote' : 'p', parent,
          block.role === 'title' ? css.docTitle : block.role === 'subtitle' ? css.subtitle : undefined)
        paint(p, block.bg)
        if (block.align) p.style.textAlign = block.align
        p.style.marginInlineStart = `${(block.indentPt ?? 0) + 16 * (block.list?.level ?? 0)}pt`
        if (block.list) el('span', p, undefined, `${block.list.marker} `)
        runs(p, block.runs)
        for (const item of block.images ?? []) {
          const img = image(p, item.src, item.alt)
          if (item.widthPx) img.width = item.widthPx
          if (item.heightPx) img.height = item.heightPx
        }
        continue
      }
      const table = el('table', parent)
      if (block.colWidthsPct) cols(table, block.colWidthsPct, '%')
      let section: HTMLTableSectionElement | undefined
      for (const row of block.rows) {
        const tag = row.header ? 'THEAD' : 'TBODY'
        if (section?.tagName !== tag) section = el(row.header ? 'thead' : 'tbody', table)
        const tr = el('tr', section!)
        for (const cell of row.cells) {
          const td = el(row.header ? 'th' : 'td', tr)
          td.rowSpan = cell.rowSpan ?? 1
          td.colSpan = cell.colSpan ?? 1
          td.style.verticalAlign = cell.valign ?? 'top'
          paint(td, cell.bg)
          blocks(td, cell.blocks)
        }
      }
    }
  }

  function renderEditableDocument(doc: OfficeDocumentPreview) {
    let activeIdx = Math.max(0, Math.min(Math.max(0, doc.blocks.length - 1), state.activeDocBlock ?? 0))
    let activeTablePos: { blockIndex: number; rowIndex: number; cellIndex: number } | null = null

    const ensureInitialBlock = () => {
      if (!doc.blocks.length) {
        doc.blocks.push({ kind: 'paragraph', runs: [{ text: '' }] })
      }
    }
    ensureInitialBlock()

    const applyInlineCommand = (command: string, fallbackProp: 'bold' | 'italic' | 'underline' | 'strike') => {
      if (typeof document.execCommand === 'function' && document.getSelection?.()?.toString()) {
        document.execCommand(command, false)
        pendingFlush?.()
        return
      }
      pushMutation(draft => {
        if (draft.kind !== 'document') return
        const target = draft.blocks[activeIdx]
        if (target?.kind !== 'paragraph') return
        const allEnabled = target.runs.length > 0 && target.runs.every(r => r.br || r[fallbackProp])
        for (const r of target.runs) if (!r.br) r[fallbackProp] = !allEnabled
      })
    }

    mountEditorHeader(bar => {
      const styleGroup = el('div', bar, css.toolbarGroup)
      const addBtn = (parent: HTMLElement, label: string, onClick: () => void, aria?: string) => {
        const b = el('button', parent, css.toolbarBtn, label)
        b.type = 'button'
        if (aria) b.setAttribute('aria-label', aria)
        b.onclick = onClick
        return b
      }
      addBtn(styleGroup, t('doc_paragraph'), () => pushMutation(d => {
        if (d.kind !== 'document') return
        const b = d.blocks[activeIdx]
        if (b?.kind === 'paragraph') { delete b.heading; delete b.role }
      }))
      for (const h of [1, 2, 3] as const) {
        addBtn(styleGroup, t(`doc_h${h}`), () => pushMutation(d => {
          if (d.kind !== 'document') return
          const b = d.blocks[activeIdx]
          if (b?.kind === 'paragraph') { b.heading = h; delete b.role }
        }))
      }
      addBtn(styleGroup, t('doc_quote'), () => pushMutation(d => {
        if (d.kind !== 'document') return
        const b = d.blocks[activeIdx]
        if (b?.kind === 'paragraph') { delete b.heading; b.role = b.role === 'quote' ? undefined : 'quote' }
      }))

      const markGroup = el('div', bar, css.toolbarGroup)
      addBtn(markGroup, 'B', () => applyInlineCommand('bold', 'bold'), t('doc_bold'))
      addBtn(markGroup, 'I', () => applyInlineCommand('italic', 'italic'), t('doc_italic'))
      addBtn(markGroup, 'U', () => applyInlineCommand('underline', 'underline'), t('doc_underline'))
      addBtn(markGroup, 'S', () => applyInlineCommand('strikeThrough', 'strike'), t('doc_strike'))

      const alignGroup = el('div', bar, css.toolbarGroup)
      for (const [align, label, aria] of [['left', '⇤', 'doc_align_left'], ['center', '⇔', 'doc_align_center'], ['right', '⇥', 'doc_align_right']] as const) {
        addBtn(alignGroup, label, () => pushMutation(d => {
          if (d.kind !== 'document') return
          const b = d.blocks[activeIdx]
          if (b?.kind === 'paragraph') b.align = align
        }), t(aria))
      }

      const listGroup = el('div', bar, css.toolbarGroup)
      addBtn(listGroup, t('doc_bullet_list'), () => pushMutation(d => {
        if (d.kind !== 'document') return
        const b = d.blocks[activeIdx]
        if (b?.kind === 'paragraph') b.list = b.list && !b.list.ordered ? undefined : { ordered: false, level: 0, marker: '•' }
      }))
      addBtn(listGroup, t('doc_ordered_list'), () => pushMutation(d => {
        if (d.kind !== 'document') return
        const b = d.blocks[activeIdx]
        if (b?.kind === 'paragraph') b.list = b.list?.ordered ? undefined : { ordered: true, level: 0, marker: '1.' }
      }))

      const insertGroup = el('div', bar, css.toolbarGroup)
      addBtn(insertGroup, t('doc_add_paragraph'), () => pushMutation(d => {
        if (d.kind !== 'document') return
        const pos = Math.min(d.blocks.length, activeIdx + 1)
        d.blocks.splice(pos, 0, { kind: 'paragraph', runs: [{ text: '' }] })
        state.activeDocBlock = pos
      }))
      addBtn(insertGroup, t('doc_add_table'), () => pushMutation(d => {
        if (d.kind !== 'document') return
        const pos = Math.min(d.blocks.length, activeIdx + 1)
        d.blocks.splice(pos, 0, {
          kind: 'table',
          rows: [
            { header: true, cells: [{ blocks: [{ kind: 'paragraph', runs: [{ text: 'Column 1', bold: true }] }] }, { blocks: [{ kind: 'paragraph', runs: [{ text: 'Column 2', bold: true }] }] }, { blocks: [{ kind: 'paragraph', runs: [{ text: 'Column 3', bold: true }] }] }] },
            { cells: [{ blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] }, { blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] }, { blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] }] },
          ],
        })
        state.activeDocBlock = pos
      }))
      addBtn(insertGroup, t('doc_add_hr'), () => pushMutation(d => {
        if (d.kind !== 'document') return
        d.blocks.splice(Math.min(d.blocks.length, activeIdx + 1), 0, { kind: 'hr' })
      }))
      addBtn(insertGroup, t('doc_add_table_row'), () => pushMutation(d => {
        if (d.kind !== 'document') return
        const tblIdx = activeTablePos?.blockIndex ?? activeIdx
        const tbl = d.blocks[tblIdx]
        if (tbl?.kind !== 'table' || !tbl.rows.length) return
        const colCount = tbl.rows[0]!.cells.length || 1
        const insertAt = activeTablePos ? activeTablePos.rowIndex + 1 : tbl.rows.length
        tbl.rows.splice(insertAt, 0, {
          cells: Array.from({ length: colCount }, () => ({ blocks: [{ kind: 'paragraph' as const, runs: [{ text: '' }] }] })),
        })
      }))
      addBtn(insertGroup, t('doc_add_table_col'), () => pushMutation(d => {
        if (d.kind !== 'document') return
        const tblIdx = activeTablePos?.blockIndex ?? activeIdx
        const tbl = d.blocks[tblIdx]
        if (tbl?.kind !== 'table') return
        for (const row of tbl.rows) {
          row.cells.push({ blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] })
        }
        delete tbl.colWidthsPct
      }))
      addBtn(insertGroup, t('doc_delete_block'), () => pushMutation(d => {
        if (d.kind !== 'document' || !d.blocks.length) return
        d.blocks.splice(activeIdx, 1)
        if (!d.blocks.length) d.blocks.push({ kind: 'paragraph', runs: [{ text: '' }] })
        state.activeDocBlock = Math.max(0, activeIdx - 1)
      }))
    })

    const stage = el('div', root, css.document)
    const paper = el('article', stage, css.paper)
    if (doc.truncated) el('div', paper, css.notice, t('doc_truncated'))

    doc.blocks.forEach((block, idx) => {
      if (block.kind === 'hr') {
        const hr = el('hr', paper, css.editableBlock)
        hr.tabIndex = 0
        hr.onclick = () => { activeIdx = idx; state.activeDocBlock = idx; activeTablePos = null }
        return
      }
      if (block.kind === 'paragraph') {
        const tag = block.heading ? `h${block.heading}` as const : block.role === 'quote' ? 'blockquote' : 'p'
        const cls = [
          css.editableBlock,
          block.role === 'title' ? css.docTitle : block.role === 'subtitle' ? css.subtitle : '',
          idx === activeIdx ? css.editableBlockActive : '',
        ].filter(Boolean).join(' ')
        const p = el(tag, paper, cls)
        paint(p, block.bg)
        if (block.align) p.style.textAlign = block.align
        p.style.marginInlineStart = `${(block.indentPt ?? 0) + 16 * (block.list?.level ?? 0)}pt`
        if (block.list) {
          const marker = el('span', p, undefined, `${block.list.marker} `)
          marker.contentEditable = 'false'
          if (marker.dataset) marker.dataset.listMarker = '1'
        }
        const textSpan = el('span', p)
        textSpan.contentEditable = 'true'
        textSpan.style.outline = 'none'
        runs(textSpan, block.runs.length ? block.runs : [{ text: '' }])
        for (const item of block.images ?? []) {
          const img = image(p, item.src, item.alt)
          img.contentEditable = 'false'
          if (item.widthPx) img.width = item.widthPx
          if (item.heightPx) img.height = item.heightPx
        }
        let edited = false
        const commitText = () => {
          if (!edited || current.kind !== 'document') return
          edited = false
          const nextRuns = extractInlineRunsFromDom(textSpan)
          undoStack.push(clonePayload(current))
          if (undoStack.length > 60) undoStack.shift()
          redoStack.length = 0
          const target = current.blocks[idx]
          if (target?.kind === 'paragraph') target.runs = nextRuns
          dirty = true
          statusKind = 'idle'
          options.onChange?.(clonePayload(current))
          refreshToolbarStatus()
        }
        textSpan.onfocus = () => {
          activeIdx = idx
          state.activeDocBlock = idx
          activeTablePos = null
          pendingFlush = commitText
        }
        textSpan.oninput = () => {
          edited = true
          dirty = true
          refreshToolbarStatus()
        }
        textSpan.onblur = () => {
          commitText()
          if (pendingFlush === commitText) pendingFlush = null
        }
        textSpan.onkeydown = (ev: KeyboardEvent) => {
          if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault()
            commitText()
            pushMutation(d => {
              if (d.kind !== 'document') return
              const nextBlock: OfficeDocBlock = {
                kind: 'paragraph',
                ...(block.list ? { list: { ...block.list } } : {}),
                runs: [{ text: '' }],
              }
              d.blocks.splice(idx + 1, 0, nextBlock)
              state.activeDocBlock = idx + 1
            })
          } else if (ev.key === 'Backspace' && !(textSpan.textContent ?? '').length && doc.blocks.length > 1) {
            ev.preventDefault()
            edited = false
            pushMutation(d => {
              if (d.kind !== 'document') return
              d.blocks.splice(idx, 1)
              state.activeDocBlock = Math.max(0, idx - 1)
            })
          }
        }
        return
      }
      const table = el('table', paper)
      if (block.colWidthsPct) cols(table, block.colWidthsPct, '%')
      let section: HTMLTableSectionElement | undefined
      block.rows.forEach((row, rIdx) => {
        const tag = row.header ? 'THEAD' : 'TBODY'
        if (section?.tagName !== tag) section = el(row.header ? 'thead' : 'tbody', table)
        const tr = el('tr', section!)
        row.cells.forEach((cell, cIdx) => {
          const td = el(row.header ? 'th' : 'td', tr, css.editableCell)
          td.rowSpan = cell.rowSpan ?? 1
          td.colSpan = cell.colSpan ?? 1
          td.style.verticalAlign = cell.valign ?? 'top'
          paint(td, cell.bg)
          td.contentEditable = 'true'
          const cellParagraphs = cell.blocks.filter((b): b is Extract<OfficeDocBlock, { kind: 'paragraph' }> => b.kind === 'paragraph')
          if (cellParagraphs.length) {
            cellParagraphs.forEach((cp, cpIdx) => {
              runs(td, cp.runs)
              if (cpIdx < cellParagraphs.length - 1) el('br', td)
            })
          }
          let cellEdited = false
          const commitCell = () => {
            if (!cellEdited || current.kind !== 'document') return
            cellEdited = false
            undoStack.push(clonePayload(current))
            if (undoStack.length > 60) undoStack.shift()
            redoStack.length = 0
            const tbl = current.blocks[idx]
            if (tbl?.kind === 'table') {
              const targetCell = tbl.rows[rIdx]?.cells[cIdx]
              if (targetCell) {
                targetCell.blocks = [{ kind: 'paragraph', runs: extractInlineRunsFromDom(td) }]
              }
            }
            dirty = true
            statusKind = 'idle'
            options.onChange?.(clonePayload(current))
            refreshToolbarStatus()
          }
          td.onfocus = () => {
            activeIdx = idx
            state.activeDocBlock = idx
            activeTablePos = { blockIndex: idx, rowIndex: rIdx, cellIndex: cIdx }
            pendingFlush = commitCell
          }
          td.oninput = () => {
            cellEdited = true
            dirty = true
            refreshToolbarStatus()
          }
          td.onblur = () => {
            commitCell()
            if (pendingFlush === commitCell) pendingFlush = null
          }
        })
      })
    })

    if (doc.footnotes?.length) {
      el('h2', paper, undefined, t('doc_footnotes'))
      for (const note of doc.footnotes) blocks(paper, note.blocks)
    }
    stage.scrollTop = state.scrollTop ?? 0
    stage.onscroll = () => { state.scrollTop = stage.scrollTop }
  }

  function applySpreadsheetCellEdit(draft: OfficeSpreadsheetPreview, sheetIdx: number, r: number, c: number, rawInput: string) {
    const sheet = draft.sheets[sheetIdx]
    if (!sheet) return
    const existingIdx = sheet.cells.findIndex(cell => cell.r === r && cell.c === c)
    const trimmed = rawInput.trim()
    if (!rawInput.length) {
      if (existingIdx >= 0) {
        const prev = sheet.cells[existingIdx]!
        if (prev.s !== undefined || (prev.rs ?? 1) > 1 || (prev.cs ?? 1) > 1) {
          prev.v = ''
          delete prev.f
          delete prev.t
        } else {
          sheet.cells.splice(existingIdx, 1)
        }
      }
    } else {
      const cell = existingIdx >= 0 ? sheet.cells[existingIdx]! : (() => {
        const created: OfficeWorksheet['cells'][number] = { r, c, v: '' }
        sheet.cells.push(created)
        return created
      })()
      if (rawInput.startsWith('=') && rawInput.length > 1) {
        cell.f = rawInput.slice(1)
        cell.v = ''
      } else {
        delete cell.f
        if (/^(?:true|false)$/i.test(trimmed)) {
          cell.t = 'b'
          cell.v = trimmed.toUpperCase()
        } else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) && !/^0\d+$/.test(trimmed)) {
          cell.t = 'n'
          cell.v = trimmed
        } else {
          cell.t = 's'
          cell.v = rawInput
        }
      }
      sheet.totalRows = Math.max(sheet.totalRows, r + 1)
      sheet.renderedRows = Math.max(sheet.renderedRows, r + 1)
      sheet.totalCols = Math.max(sheet.totalCols, c + 1)
      sheet.renderedCols = Math.max(sheet.renderedCols, c + 1)
    }
    recalculateSpreadsheet(draft)
  }

  function renderSpreadsheet(next: OfficeSpreadsheetPreview) {
    const editable = editingEnabled()
    if (!next.sheets.length && !editable) { empty('sheet_empty'); return }
    if (!next.sheets.length && editable) {
      next.sheets.push({ name: 'Sheet 1', totalRows: 20, totalCols: 8, renderedRows: 20, renderedCols: 8, cells: [] })
    }
    const index = Math.max(0, Math.min(next.sheets.length - 1, state.activeSheet ?? next.activeSheet))
    state.activeSheet = index
    const sheet = next.sheets[index]!
    const minEditRows = editable ? Math.max(sheet.renderedRows, 24) : sheet.renderedRows
    const minEditCols = editable ? Math.max(sheet.renderedCols, 10) : sheet.renderedCols
    const displayRows = editable ? Math.max(sheet.renderedRows, Math.min(500, minEditRows)) : sheet.renderedRows
    const displayCols = editable ? Math.max(sheet.renderedCols, Math.min(52, minEditCols)) : sheet.renderedCols
    const saved = (state.sheetStates ??= {})[index] ??= { r: editable ? 0 : -1, c: editable ? 0 : -1, scrollTop: 0, scrollLeft: 0 }

    let selectedSlot: { td: HTMLTableCellElement; cell: OfficeWorksheet['cells'][number]; r: number; c: number; endR: number; endC: number } | undefined

    if (editable) {
      mountEditorHeader(bar => {
        const structGroup = el('div', bar, css.toolbarGroup)
        const addBtn = (label: string, fn: () => void, aria?: string) => {
          const b = el('button', structGroup, css.toolbarBtn, label)
          b.type = 'button'
          if (aria) b.setAttribute('aria-label', aria)
          b.onclick = fn
          return b
        }
        addBtn(t('sheet_add_row'), () => pushMutation(d => {
          if (d.kind !== 'spreadsheet') return
          const s = d.sheets[index]
          if (!s) return
          const targetR = selectedSlot ? selectedSlot.endR + 1 : s.totalRows
          for (const cell of s.cells) if (cell.r >= targetR) cell.r += 1
          s.totalRows += 1
          s.renderedRows = Math.max(s.renderedRows + 1, targetR + 1)
          recalculateSpreadsheet(d)
        }))
        addBtn(t('sheet_delete_row'), () => pushMutation(d => {
          if (d.kind !== 'spreadsheet' || !selectedSlot) return
          const s = d.sheets[index]
          if (!s) return
          const targetR = selectedSlot.r
          s.cells = s.cells.filter(cell => cell.r !== targetR)
          for (const cell of s.cells) if (cell.r > targetR) cell.r -= 1
          s.totalRows = Math.max(1, s.totalRows - 1)
          s.renderedRows = Math.max(1, s.renderedRows - 1)
          recalculateSpreadsheet(d)
        }))
        addBtn(t('sheet_add_col'), () => pushMutation(d => {
          if (d.kind !== 'spreadsheet') return
          const s = d.sheets[index]
          if (!s) return
          const targetC = selectedSlot ? selectedSlot.endC + 1 : s.totalCols
          for (const cell of s.cells) if (cell.c >= targetC) cell.c += 1
          s.totalCols += 1
          s.renderedCols = Math.max(s.renderedCols + 1, targetC + 1)
          recalculateSpreadsheet(d)
        }))
        addBtn(t('sheet_delete_col'), () => pushMutation(d => {
          if (d.kind !== 'spreadsheet' || !selectedSlot) return
          const s = d.sheets[index]
          if (!s) return
          const targetC = selectedSlot.c
          s.cells = s.cells.filter(cell => cell.c !== targetC)
          for (const cell of s.cells) if (cell.c > targetC) cell.c -= 1
          s.totalCols = Math.max(1, s.totalCols - 1)
          s.renderedCols = Math.max(1, s.renderedCols - 1)
          recalculateSpreadsheet(d)
        }))
        if (!options.singleSheet) {
          addBtn('B', () => pushMutation(d => {
            if (d.kind !== 'spreadsheet' || !selectedSlot) return
            const s = d.sheets[index]
            if (!s) return
            const { r, c } = selectedSlot
            let cell = s.cells.find(item => item.r === r && item.c === c)
            if (!cell) {
              cell = { r, c, v: '' }
              s.cells.push(cell)
            }
            const baseStyle = cell.s !== undefined ? { ...d.styles[cell.s] } : {}
            baseStyle.bold = !baseStyle.bold
            d.styles.push(baseStyle)
            cell.s = d.styles.length - 1
          }), t('doc_bold'))
        }
      })
    }

    const bar = el('div', root, css.bar)
    const address = el('span', bar, css.address)
    address.setAttribute('aria-label', t('cell_box_aria'))
    el('span', bar, css.fx, 'fx')

    let formulaEl: HTMLElement
    let formulaInputEl: HTMLInputElement | null = null
    if (editable) {
      formulaInputEl = el('input', bar, css.formulaInput)
      formulaInputEl.type = 'text'
      formulaInputEl.placeholder = t('formula_placeholder')
      formulaInputEl.setAttribute('aria-label', t('formula_bar_aria'))
      formulaEl = formulaInputEl
    } else {
      formulaEl = el('div', bar, css.formula)
      formulaEl.setAttribute('aria-label', t('formula_bar_aria'))
    }
    el('span', bar, css.dimensions, t('sheet_dimensions', { rows: sheet.totalRows, cols: sheet.totalCols }))
    if (sheet.renderedRows < sheet.totalRows || sheet.renderedCols < sheet.totalCols) {
      el('div', root, css.notice, t('sheet_truncated', { renderedRows: sheet.renderedRows, renderedCols: sheet.renderedCols, totalRows: sheet.totalRows, totalCols: sheet.totalCols }))
    }

    const stage = el('div', root, css.grid)
    stage.tabIndex = 0
    const rs = Array.from({ length: displayRows }, (_, i) => i).filter(i => !sheet.hiddenRows?.includes(i))
    const cs = Array.from({ length: displayCols }, (_, i) => i).filter(i => !sheet.hiddenCols?.includes(i))
    const key = (r: number, c: number) => r * Math.max(displayCols, 1) + c
    type Cell = typeof sheet.cells[number]
    type Slot = { td: HTMLTableCellElement; cell: Cell; r: number; c: number; endR: number; endC: number }
    const slots = new Map<number, Slot>()
    const masters = new Map<number, Cell>()
    for (const cell of sheet.cells) {
      const r = rs.find(i => i >= cell.r), c = cs.find(i => i >= cell.c)
      if (r !== undefined && c !== undefined && r < cell.r + (cell.rs ?? 1) && c < cell.c + (cell.cs ?? 1)) masters.set(key(r, c), cell)
    }
    let rangeEnd: Slot | undefined
    let dragging = false
    const range = (includeContent = true) => selectedSlot && officeSheetQuote(sheet, selectedSlot.r, selectedSlot.c, (rangeEnd || selectedSlot).endR, (rangeEnd || selectedSlot).endC, includeContent)
    const quoteRange = () => {
      const info = range()
      if (!info) return
      addQuote(info.text, { kind: 'spreadsheet', sheet: sheet.name, multiSheet: next.sheets.length > 1 && !/\.(csv|tsv)$/i.test(options.filePath || ''),
        cellRange: info.cellRange, columnHeaders: info.columnHeaders || undefined, formulas: info.formulas || undefined })
    }
    const quoteRangeButton = quoteEnabled ? quoteButton(bar, quoteRange) : undefined
    const paintRange = () => {
      if (!quoteEnabled) return
      const info = range(false)
      if (quoteRangeButton) quoteRangeButton.hidden = !info
      if (info) address.textContent = info.cellRange
      for (const slot of new Set(slots.values())) slot.td.classList.toggle('is-in-range', !!info && slot.r >= info.minR && slot.r <= info.maxR && slot.c >= info.minC && slot.c <= info.maxC)
    }
    if (quoteEnabled) {
      const win = stage.ownerDocument.defaultView!
      const stop = () => { dragging = false }
      win.addEventListener('mouseup', stop)
      win.addEventListener('blur', stop)
      quoteBindings.push(() => { win.removeEventListener('mouseup', stop); win.removeEventListener('blur', stop) })
    }
    const rowHeaders = new Map<number, HTMLElement>()
    const colHeaders = new Map<number, HTMLElement>()
    function markHeaders(slot: Slot, active: boolean) {
      for (let r = slot.r; r <= slot.endR; r++) rowHeaders.get(r)?.classList.toggle(css.activeHeader!, active)
      for (let c = slot.c; c <= slot.endC; c++) colHeaders.get(c)?.classList.toggle(css.activeHeader!, active)
    }

    const rawFormulaOrValue = (cell?: Cell) => cell ? (cell.f ? `=${cell.f.replace(/^=/, '')}` : cell.v) : ''

    function select(slot?: Slot, reveal = false) {
      selectedSlot?.td.classList.remove(css.selected!)
      if (selectedSlot) markHeaders(selectedSlot, false)
      selectedSlot = slot
      rangeEnd = undefined
      if (!formulaInputEl) formulaEl.classList.toggle(css.formulaPlaceholder!, !slot)
      if (slot) {
        slot.td.classList.add(css.selected!)
        markHeaders(slot, true)
        saved.r = slot.r; saved.c = slot.c
        if (reveal) slot.td.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
      const cell = slot?.cell
      const a = cell ? `${column(cell.c)}${cell.r + 1}` : '—'
      address.textContent = cell && ((cell.rs ?? 1) > 1 || (cell.cs ?? 1) > 1) ? `${a}:${column(cell.c + (cell.cs ?? 1) - 1)}${cell.r + (cell.rs ?? 1)}` : a
      paintRange()
      if (formulaInputEl) {
        formulaInputEl.value = rawFormulaOrValue(cell)
        formulaInputEl.disabled = !slot
      } else {
        const f = cell?.f ? `=${cell.f.replace(/^=/, '')}` : ''
        formulaEl.textContent = cell ? (f && cell.v && f !== cell.v && cell.f !== cell.v ? `${f}  →  ${cell.v}` : f || cell.v) : t('formula_placeholder')
      }
    }

    const startCellInlineEdit = (slot: Slot, initialText?: string) => {
      if (!editable) return
      pendingFlush?.()
      select(slot)
      const startVal = initialText !== undefined ? initialText : rawFormulaOrValue(slot.cell)
      const input = el('input', slot.td, css.cellEditor)
      input.type = 'text'
      input.value = startVal
      let finished = false
      const finish = (commit: boolean, moveDeltaR = 0, moveDeltaC = 0) => {
        if (finished) return
        finished = true
        if (pendingFlush === commitOnly) pendingFlush = null
        const nextRaw = input.value
        input.remove?.()
        const oldRaw = rawFormulaOrValue(slot.cell)
        if (commit && nextRaw !== oldRaw) {
          saved.r = Math.max(0, slot.r + moveDeltaR)
          saved.c = Math.max(0, slot.c + moveDeltaC)
          saved.scrollTop = stage.scrollTop
          saved.scrollLeft = stage.scrollLeft
          pushMutation(d => {
            if (d.kind !== 'spreadsheet') return
            applySpreadsheetCellEdit(d, index, slot.r, slot.c, nextRaw)
          })
          return
        }
        if (moveDeltaR || moveDeltaC) {
          const targetSlot = slots.get(key(Math.max(0, slot.r + moveDeltaR), Math.max(0, slot.c + moveDeltaC)))
          if (targetSlot) select(targetSlot, true)
        }
        stage.focus({ preventScroll: true })
      }
      const commitOnly = () => finish(true)
      pendingFlush = commitOnly
      input.oninput = () => {
        if (formulaInputEl) formulaInputEl.value = input.value
      }
      input.onkeydown = (ev: KeyboardEvent) => {
        ev.stopPropagation()
        if (ev.key === 'Enter') {
          ev.preventDefault()
          finish(true, ev.shiftKey ? -1 : 1, 0)
        } else if (ev.key === 'Tab') {
          ev.preventDefault()
          finish(true, 0, ev.shiftKey ? -1 : 1)
        } else if (ev.key === 'Escape') {
          ev.preventDefault()
          finish(false)
        }
      }
      input.onblur = () => finish(true)
      input.focus()
      if (initialText !== undefined) {
        input.setSelectionRange?.(initialText.length, initialText.length)
      } else {
        input.select?.()
      }
    }

    if (formulaInputEl) {
      let formulaDirty = false
      const commitFormulaBar = (moveDown = false) => {
        if (!selectedSlot || !formulaDirty) return
        formulaDirty = false
        const targetR = selectedSlot.r
        const targetC = selectedSlot.c
        const val = formulaInputEl!.value
        if (moveDown) saved.r = targetR + 1
        saved.scrollTop = stage.scrollTop
        saved.scrollLeft = stage.scrollLeft
        pushMutation(d => {
          if (d.kind !== 'spreadsheet') return
          applySpreadsheetCellEdit(d, index, targetR, targetC, val)
        })
      }
      formulaInputEl.onfocus = () => { pendingFlush = () => commitFormulaBar(false) }
      formulaInputEl.oninput = () => { formulaDirty = true }
      formulaInputEl.onblur = () => {
        commitFormulaBar(false)
        pendingFlush = null
      }
      formulaInputEl.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          commitFormulaBar(true)
        } else if (ev.key === 'Escape' && selectedSlot) {
          ev.preventDefault()
          formulaDirty = false
          formulaInputEl!.value = rawFormulaOrValue(selectedSlot.cell)
          stage.focus({ preventScroll: true })
        }
      }
    }

    if (!rs.length || !cs.length) empty('sheet_empty', undefined, stage)
    else {
      const table = el('table', stage)
      cols(table, [52, ...cs.map(c => Math.min(420, Math.max(56, sheet.colWidths?.[c] ?? 104)))], 'px')
      const header = el('tr', el('thead', table))
      el('th', header)
      for (const c of cs) {
        const th = el('th', header, undefined, column(c))
        th.scope = 'col'
        colHeaders.set(c, th)
      }
      const body = el('tbody', table)
      for (const r of rs) {
        const tr = el('tr', body)
        if (sheet.rowHeights?.[r]) tr.style.height = `${sheet.rowHeights[r]}px`
        const th = el('th', tr, undefined, String(r + 1))
        th.scope = 'row'
        rowHeaders.set(r, th)
        for (const c of cs) {
          if (slots.has(key(r, c))) continue
          const cell = masters.get(key(r, c)) ?? { r, c, v: '' }
          const td = el('td', tr, undefined, cell.v)
          const mergedRows = cell.rs ? rs.filter(i => i >= r && i < cell.r + cell.rs!) : [r]
          const mergedCols = cell.cs ? cs.filter(i => i >= c && i < cell.c + cell.cs!) : [c]
          td.rowSpan = mergedRows.length; td.colSpan = mergedCols.length
          const style = cell.s === undefined ? undefined : next.styles[cell.s]
          paint(td, style?.bg, style?.color)
          td.style.textAlign = style?.align ?? (cell.t === 'n' ? 'right' : 'left')
          td.style.verticalAlign = style?.valign ?? 'middle'
          if (style?.bold) td.style.fontWeight = 'var(--weight-semibold)'
          if (style?.italic) td.style.fontStyle = 'italic'
          td.style.textDecoration = [style?.underline && 'underline', style?.strike && 'line-through'].filter(Boolean).join(' ')
          if (style?.wrap || cell.v.includes('\n')) td.style.whiteSpace = 'pre-wrap'
          for (const edge of ['borderTop', 'borderRight', 'borderBottom', 'borderLeft'] as const) if (style?.[edge]) td.style[edge] = style[edge]
          const slot = { td, cell, r, c, endR: mergedRows.at(-1)!, endC: mergedCols.at(-1)! }
          for (const rr of mergedRows) for (const cc of mergedCols) slots.set(key(rr, cc), slot)
          td.onclick = () => { if (!quoteEnabled) select(slot); stage.focus({ preventScroll: true }) }
          if (quoteEnabled) {
            td.dataset.r = String(r); td.dataset.c = String(c)
            td.onmousedown = event => {
              if (event.button !== 0 || (event.target as Element).closest('input, textarea')) return
              if (event.shiftKey && selectedSlot) { rangeEnd = slot; paintRange() }
              else select(slot)
              dragging = true
              event.preventDefault()
            }
            td.onmouseover = () => { if (dragging) { rangeEnd = slot; paintRange() } }
            td.oncontextmenu = event => {
              const info = range(false)
              if (!info || r < info.minR || r > info.maxR || c < info.minC || c > info.maxC) select(slot)
              openPanelQuoteContextMenu(event, [
                { label: options.translate?.('panel_quote_add_to_chat') || 'Add to chat', iconName: 'quoted-text', onSelect: quoteRange },
                { label: options.translate?.('panel_quote_copy') || 'Copy', iconName: 'copy', onSelect: () => { const text = range()?.raw || ''; if (options.copyText) options.copyText(text); else void navigator.clipboard?.writeText(text).catch(() => {}) } },
              ])
            }
          }
          if (editable) {
            td.ondblclick = () => startCellInlineEdit(slot)
          }
        }
      }
    }

    select(saved.r < 0 || saved.c < 0 ? undefined : slots.get(key(saved.r, saved.c)))
    stage.scrollTop = saved.scrollTop; stage.scrollLeft = saved.scrollLeft
    const saveScroll = () => { saved.scrollTop = stage.scrollTop; saved.scrollLeft = stage.scrollLeft }
    stage.onscroll = saveScroll

    stage.onpaste = (event: ClipboardEvent) => {
      if (!editable || !selectedSlot) return
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      const startR = selectedSlot.r
      const startC = selectedSlot.c
      const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '').split('\n')
      saveScroll()
      pushMutation(d => {
        if (d.kind !== 'spreadsheet') return
        lines.forEach((line, dr) => {
          line.split('\t').forEach((cellVal, dc) => {
            applySpreadsheetCellEdit(d, index, startR + dr, startC + dc, cellVal)
          })
        })
      })
    }

    stage.onkeydown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selectedSlot && !document.getSelection?.()?.toString()) {
        event.preventDefault()
        if (options.copyText) options.copyText(selectedSlot.cell.v)
        else void navigator.clipboard?.writeText(selectedSlot.cell.v).catch(() => {})
        return
      }
      if (editable && selectedSlot) {
        if (event.key === 'F2' || event.key === 'Enter') {
          event.preventDefault()
          startCellInlineEdit(selectedSlot)
          return
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          const { r, c } = selectedSlot
          saveScroll()
          pushMutation(d => {
            if (d.kind !== 'spreadsheet') return
            applySpreadsheetCellEdit(d, index, r, c, '')
          })
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          const nextC = cs[cs.indexOf(selectedSlot.c) + (event.shiftKey ? -1 : 1)]
          const nextSlot = nextC === undefined ? undefined : slots.get(key(selectedSlot.r, nextC))
          if (nextSlot) { select(nextSlot, true); saveScroll() }
          return
        }
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          startCellInlineEdit(selectedSlot, event.key)
          return
        }
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      const r = selectedSlot ? event.key === 'ArrowUp' ? rs[rs.indexOf(selectedSlot.r) - 1] : event.key === 'ArrowDown' ? rs[rs.indexOf(selectedSlot.endR) + 1] : selectedSlot.r : rs[0]
      const c = selectedSlot ? event.key === 'ArrowLeft' ? cs[cs.indexOf(selectedSlot.c) - 1] : event.key === 'ArrowRight' ? cs[cs.indexOf(selectedSlot.endC) + 1] : selectedSlot.c : cs[0]
      const slot = r === undefined || c === undefined ? undefined : slots.get(key(r, c))
      if (slot) { select(slot, true); saveScroll() }
    }

    const tabs = el('div', root, css.tabs)
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', t('sheet_tabs_aria'))
    next.sheets.forEach((item, i) => {
      const btn = el('button', tabs, undefined, item.name)
      btn.setAttribute('role', 'tab'); btn.setAttribute('aria-selected', String(i === index))
      if (item.hidden) el('span', btn, css.badge, t('sheet_hidden_badge'))
      btn.onclick = () => {
        saveScroll()
        state.activeSheet = i
        render(current, false)
        tabs.querySelectorAll('button')[i]?.focus()
      }
      if (editable && !options.singleSheet) {
        btn.ondblclick = ev => {
          ev.preventDefault()
          const input = el('input', tabs, css.tabInput)
          input.type = 'text'
          input.value = item.name
          btn.replaceWith?.(input)
          const done = (commit: boolean) => {
            const nextName = input.value.trim()
            if (commit && nextName && nextName !== item.name) {
              pushMutation(d => {
                if (d.kind === 'spreadsheet' && d.sheets[i]) d.sheets[i]!.name = nextName
              })
            } else {
              render(current, false)
            }
          }
          input.onkeydown = keyEv => {
            if (keyEv.key === 'Enter') { keyEv.preventDefault(); done(true) }
            else if (keyEv.key === 'Escape') { keyEv.preventDefault(); done(false) }
          }
          input.onblur = () => done(true)
          input.focus()
          input.select?.()
        }
      }
    })
    if (editable && !options.singleSheet) {
      const addTabBtn = el('button', tabs, undefined, t('sheet_add_tab'))
      addTabBtn.type = 'button'
      addTabBtn.onclick = () => pushMutation(d => {
        if (d.kind !== 'spreadsheet') return
        const nextIdx = d.sheets.length + 1
        d.sheets.push({
          name: t('sheet_new_name', { index: nextIdx }),
          totalRows: 24,
          totalCols: 10,
          renderedRows: 24,
          renderedCols: 10,
          cells: [],
        })
        state.activeSheet = d.sheets.length - 1
      })
      if (next.sheets.length > 1) {
        const delTabBtn = el('button', tabs, undefined, '×')
        delTabBtn.type = 'button'
        delTabBtn.setAttribute('aria-label', t('sheet_delete_tab'))
        delTabBtn.onclick = () => pushMutation(d => {
          if (d.kind !== 'spreadsheet' || d.sheets.length <= 1) return
          d.sheets.splice(index, 1)
          state.activeSheet = Math.max(0, index - 1)
        })
      }
    }
  }

  function renderPresentation(next: OfficePresentationPreview) {
    const editable = editingEnabled()
    if (!next.slides.length && !editable) { empty('slides_empty'); return }
    if (!next.slides.length && editable) {
      next.slides.push({
        index: 1,
        elements: [{ kind: 'shape', x: 8, y: 12, w: 84, h: 24, paragraphs: [{ align: 'center', runs: [{ text: t('slide_new_title'), bold: true, fontSize: 28 }] }] }],
      })
    }

    let active = Math.max(0, Math.min(next.slides.length - 1, state.activeSlide ?? 0))
    let selectedElementIdx = state.selectedSlideElement ?? -1

    if (editable) {
      mountEditorHeader(bar => {
        const slideGroup = el('div', bar, css.toolbarGroup)
        const addBtn = (parent: HTMLElement, label: string, fn: () => void, aria?: string) => {
          const b = el('button', parent, css.toolbarBtn, label)
          b.type = 'button'
          if (aria) b.setAttribute('aria-label', aria)
          b.onclick = fn
          return b
        }
        addBtn(slideGroup, t('slide_add'), () => pushMutation(d => {
          if (d.kind !== 'presentation') return
          const insertPos = Math.min(d.slides.length, active + 1)
          const newSlide: OfficeSlide = {
            index: insertPos + 1,
            background: '#ffffff',
            elements: [
              { kind: 'shape', x: 8, y: 10, w: 84, h: 20, paragraphs: [{ align: 'left', runs: [{ text: t('slide_new_title'), bold: true, fontSize: 28 }] }] },
              { kind: 'shape', x: 8, y: 34, w: 84, h: 52, paragraphs: [{ align: 'left', runs: [{ text: t('slide_new_body'), fontSize: 18 }] }] },
            ],
          }
          d.slides.splice(insertPos, 0, newSlide)
          d.slides.forEach((s, idx) => { s.index = idx + 1 })
          state.activeSlide = insertPos
          state.selectedSlideElement = 0
        }))
        addBtn(slideGroup, t('slide_duplicate'), () => pushMutation(d => {
          if (d.kind !== 'presentation' || !d.slides[active]) return
          const copy = clonePayload(d.slides[active]!)
          d.slides.splice(active + 1, 0, copy)
          d.slides.forEach((s, idx) => { s.index = idx + 1 })
          state.activeSlide = active + 1
        }))
        addBtn(slideGroup, t('slide_delete'), () => pushMutation(d => {
          if (d.kind !== 'presentation' || d.slides.length <= 1) return
          d.slides.splice(active, 1)
          d.slides.forEach((s, idx) => { s.index = idx + 1 })
          state.activeSlide = Math.max(0, active - 1)
          state.selectedSlideElement = -1
        }))

        const elemGroup = el('div', bar, css.toolbarGroup)
        addBtn(elemGroup, t('slide_add_text'), () => pushMutation(d => {
          if (d.kind !== 'presentation' || !d.slides[active]) return
          d.slides[active]!.elements.push({
            kind: 'shape',
            x: 12,
            y: 22,
            w: 76,
            h: 24,
            fill: '#f8fafc',
            stroke: '#cbd5e1',
            strokeWidthPt: 1,
            paddingPct: { top: 2, right: 3, bottom: 2, left: 3 },
            paragraphs: [{ align: 'left', runs: [{ text: t('slide_new_body'), fontSize: 20 }] }],
          })
          state.selectedSlideElement = d.slides[active]!.elements.length - 1
        }))
        addBtn(elemGroup, t('slide_add_table'), () => pushMutation(d => {
          if (d.kind !== 'presentation' || !d.slides[active]) return
          d.slides[active]!.elements.push({
            kind: 'table',
            x: 10,
            y: 45,
            w: 80,
            h: 32,
            rows: [
              { cells: [{ bg: '#f1f5f9', paragraphs: [{ runs: [{ text: 'Header 1', bold: true, fontSize: 16 }] }] }, { bg: '#f1f5f9', paragraphs: [{ runs: [{ text: 'Header 2', bold: true, fontSize: 16 }] }] }] },
              { cells: [{ paragraphs: [{ runs: [{ text: '' }] }] }, { paragraphs: [{ runs: [{ text: '' }] }] }] },
            ],
          })
          state.selectedSlideElement = d.slides[active]!.elements.length - 1
        }))
        addBtn(elemGroup, t('slide_delete_element'), () => pushMutation(d => {
          if (d.kind !== 'presentation' || selectedElementIdx < 0) return
          const s = d.slides[active]
          if (!s || !s.elements[selectedElementIdx]) return
          s.elements.splice(selectedElementIdx, 1)
          state.selectedSlideElement = -1
        }))

        const fmtGroup = el('div', bar, css.toolbarGroup)
        addBtn(fmtGroup, 'B', () => pushMutation(d => {
          if (d.kind !== 'presentation' || selectedElementIdx < 0) return
          const elem = d.slides[active]?.elements[selectedElementIdx]
          if (elem?.kind !== 'shape') return
          const allBold = elem.paragraphs.every(p => p.runs.every(r => r.br || r.bold))
          for (const p of elem.paragraphs) for (const r of p.runs) if (!r.br) r.bold = !allBold
        }), t('doc_bold'))
        addBtn(fmtGroup, t('slide_font_smaller'), () => pushMutation(d => {
          if (d.kind !== 'presentation' || selectedElementIdx < 0) return
          const elem = d.slides[active]?.elements[selectedElementIdx]
          if (elem?.kind !== 'shape') return
          for (const p of elem.paragraphs) for (const r of p.runs) if (!r.br) r.fontSize = Math.max(10, (r.fontSize ?? 18) - 2)
        }))
        addBtn(fmtGroup, t('slide_font_larger'), () => pushMutation(d => {
          if (d.kind !== 'presentation' || selectedElementIdx < 0) return
          const elem = d.slides[active]?.elements[selectedElementIdx]
          if (elem?.kind !== 'shape') return
          for (const p of elem.paragraphs) for (const r of p.runs) if (!r.br) r.fontSize = Math.min(96, (r.fontSize ?? 18) + 2)
        }))
      })
    }

    const bar = el('div', root, css.bar)
    const prev = el('button', bar, undefined, '‹')
    prev.setAttribute('aria-label', t('slide_prev'))
    const counter = el('span', bar)
    const forward = el('button', bar, undefined, '›')
    forward.setAttribute('aria-label', t('slide_next'))
    if (next.truncated) el('div', root, css.notice, t('slides_truncated', { count: next.slides.length }))
    const deck = el('div', root, css.deck)
    deck.tabIndex = 0
    const w = next.widthPt || 720, h = next.heightPt || 405

    const paragraphs = (parent: HTMLElement, items: OfficeSlideParagraph[], onEditParagraphs?: (updated: OfficeSlideParagraph[]) => void) => {
      if (!editable || !onEditParagraphs) {
        for (const item of items) {
          const p = el('p', parent)
          p.style.textAlign = item.align ?? 'left'
          if (item.level) p.style.marginInlineStart = `${item.level}em`
          if (item.marker) el('span', p, undefined, `${item.marker} `)
          runs(p, item.runs, w)
        }
        return
      }
      const list = items.length ? items : [{ runs: [{ text: '' }] }]
      const pNodes: Array<{ node: HTMLElement; template: OfficeSlideParagraph }> = []
      let edited = false
      const commit = () => {
        if (!edited) return
        edited = false
        const updated: OfficeSlideParagraph[] = pNodes.map(({ node, template }) => {
          const baseRun = template.runs[0]
          const extracted = extractInlineRunsFromDom(node).map(r => ({
            ...(baseRun?.fontSize ? { fontSize: baseRun.fontSize } : {}),
            ...(baseRun?.color ? { color: baseRun.color } : {}),
            ...(baseRun?.bold ? { bold: baseRun.bold } : {}),
            ...r,
          }))
          return { ...template, runs: extracted }
        })
        onEditParagraphs(updated)
      }
      for (const item of list) {
        const p = el('p', parent)
        p.style.textAlign = item.align ?? 'left'
        if (item.level) p.style.marginInlineStart = `${item.level}em`
        if (item.marker) {
          const m = el('span', p, undefined, `${item.marker} `)
          m.contentEditable = 'false'
          if (m.dataset) m.dataset.listMarker = '1'
        }
        const editSpan = el('span', p)
        editSpan.contentEditable = 'true'
        editSpan.style.outline = 'none'
        runs(editSpan, item.runs.length ? item.runs : [{ text: '' }], w)
        pNodes.push({ node: editSpan, template: item })
        editSpan.onfocus = () => { pendingFlush = commit }
        editSpan.oninput = () => {
          edited = true
          dirty = true
          refreshToolbarStatus()
        }
        editSpan.onblur = () => {
          commit()
          if (pendingFlush === commit) pendingFlush = null
        }
      }
    }

    const cards = next.slides.map((slide, sIdx) => {
      const card = el('article', deck, `${css.slide}${editable && sIdx === active ? ` ${css.slideActive}` : ''}`)
      card.setAttribute('data-slide-number', String(sIdx + 1))
      const header = el('div', card, css.bar, t('slide_label', { index: slide.index }))
      const slideSource = (element?: HTMLElement | null): QuoteSourceMetadata => ({ kind: 'ppt', path: options.filePath, slide: sIdx + 1, totalSlides: next.slides.length, elementLabel: element?.dataset.slideElement })
      const quoteSlide = (element?: HTMLElement | null) => addQuote(element?.textContent?.trim() || canvas.textContent?.trim() || `Slide ${sIdx + 1}`, slideSource(element))
      if (quoteEnabled) quoteButton(header, () => quoteSlide(sIdx === active ? canvas.querySelector<HTMLElement>(`[data-slide-element="${selectedElementIdx + 1}"]`) : null))
      if (slide.hidden) el('span', header, css.badge, t('slide_hidden_badge'))
      const canvas = el('div', card, css.canvas)
      canvas.style.aspectRatio = `${w} / ${h}`
      paint(canvas, slide.background ?? '#ffffff')
      if (slide.backgroundImage && /^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);base64,[\w+/=]+$/i.test(slide.backgroundImage)) {
        canvas.style.backgroundImage = `url("${slide.backgroundImage}")`
      }
      if (editable) {
        card.onclick = () => {
          active = sIdx
          state.activeSlide = sIdx
        }
      }
      slide.elements.forEach((item, elemIdx) => {
        const isSelected = editable && sIdx === active && elemIdx === selectedElementIdx
        const box = el('div', canvas, `${css.positioned}${isSelected ? ` ${css.selectedElement}` : ''}`)
        box.setAttribute('data-slide-element', String(elemIdx + 1))
        if (quoteEnabled) box.oncontextmenu = event => {
          if (card.ownerDocument.getSelection()?.toString().trim()) return
          openPanelQuoteContextMenu(event, [{ label: options.translate?.('panel_quote_add_to_chat') || 'Add to chat', iconName: 'quoted-text', onSelect: () => quoteSlide(box) }])
        }

        Object.assign(box.style, { left: `${item.x}%`, top: `${item.y}%`, width: `${item.w}%`, height: `${item.h}%` })
        box.style.setProperty('--office-slide-fs', `${1800 / w}cqw`)
        if (item.rotation) box.style.transform = `rotate(${item.rotation}deg)`
        if (editable) {
          box.onclick = ev => {
            ev.stopPropagation()
            const changedSlide = active !== sIdx || selectedElementIdx !== elemIdx
            active = sIdx
            selectedElementIdx = elemIdx
            state.activeSlide = sIdx
            state.selectedSlideElement = elemIdx
            if (changedSlide) {
              for (const node of canvas.parentElement?.parentElement?.querySelectorAll?.(`.${css.selectedElement}`) ?? []) {
                node.classList?.remove(css.selectedElement!)
              }
              box.classList.add(css.selectedElement!)
            }
          }
        }
        if (item.kind === 'image') {
          const img = image(box, item.src, item.alt)
          Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'fill' })
          if (item.crop) {
            const { top: ct, right: cr, bottom: cb, left: cl } = item.crop
            const l = cl / 100, r = cr / 100, tp = ct / 100, b = cb / 100
            const x = 1 - l - r, y = 1 - tp - b
            if (x > 0 && y > 0) Object.assign(img.style, { position: 'absolute', width: `${100 / x}%`, height: `${100 / y}%`, left: `${-100 * l / x}%`, top: `${-100 * tp / y}%` })
          }
        } else if (item.kind === 'shape') {
          paint(box, item.fill)
          if (item.stroke) box.style.border = `${100 * (item.strokeWidthPt ?? 1) / w}cqw solid ${item.stroke}`
          if (item.geom === 'ellipse') box.style.borderRadius = '50%'
          if (item.geom === 'roundRect') box.style.borderRadius = 'var(--radius-md)'
          box.style.display = 'flex'; box.style.flexDirection = 'column'
          box.style.justifyContent = item.valign === 'middle' ? 'center' : item.valign === 'bottom' ? 'end' : 'start'
          if (item.paddingPct) box.style.padding = [item.paddingPct.top, item.paddingPct.right, item.paddingPct.bottom, item.paddingPct.left].map(v => `${v}%`).join(' ')
          paragraphs(box, item.paragraphs, editable ? updated => {
            undoStack.push(clonePayload(current))
            if (undoStack.length > 60) undoStack.shift()
            redoStack.length = 0
            if (current.kind === 'presentation') {
              const target = current.slides[sIdx]?.elements[elemIdx]
              if (target?.kind === 'shape') target.paragraphs = updated
            }
            dirty = true
            statusKind = 'idle'
            options.onChange?.(clonePayload(current))
            refreshToolbarStatus()
          } : undefined)
        } else {
          const table = el('table', box)
          if (item.colWidthsPct) cols(table, item.colWidthsPct, '%')
          const body = el('tbody', table)
          item.rows.forEach((row, rIdx) => {
            const tr = el('tr', body)
            row.cells.forEach((cell, cIdx) => {
              const td = el('td', tr)
              td.rowSpan = cell.rowSpan ?? 1; td.colSpan = cell.colSpan ?? 1
              td.style.verticalAlign = cell.valign ?? 'top'
              paint(td, cell.bg)
              paragraphs(td, cell.paragraphs, editable ? updated => {
                undoStack.push(clonePayload(current))
                if (undoStack.length > 60) undoStack.shift()
                redoStack.length = 0
                if (current.kind === 'presentation') {
                  const target = current.slides[sIdx]?.elements[elemIdx]
                  if (target?.kind === 'table' && target.rows[rIdx]?.cells[cIdx]) {
                    target.rows[rIdx]!.cells[cIdx]!.paragraphs = updated
                  }
                }
                dirty = true
                statusKind = 'idle'
                options.onChange?.(clonePayload(current))
                refreshToolbarStatus()
              } : undefined)
            })
          })
        }
      })
      if (editable) {
        const notes = el('section', card, css.notes)
        el('strong', notes, undefined, t('slide_notes'))
        const notesArea = el('textarea', notes, css.notesInput)
        notesArea.value = slide.notes ?? ''
        notesArea.placeholder = t('slide_notes_placeholder')
        notesArea.setAttribute('aria-label', t('slide_notes'))
        let notesEdited = false
        const commitNotes = () => {
          if (!notesEdited || current.kind !== 'presentation') return
          notesEdited = false
          undoStack.push(clonePayload(current))
          if (undoStack.length > 60) undoStack.shift()
          redoStack.length = 0
          if (current.slides[sIdx]) {
            const val = notesArea.value.trim()
            if (val) current.slides[sIdx]!.notes = notesArea.value
            else delete current.slides[sIdx]!.notes
          }
          dirty = true
          statusKind = 'idle'
          options.onChange?.(clonePayload(current))
          refreshToolbarStatus()
        }
        notesArea.onfocus = () => { pendingFlush = commitNotes }
        notesArea.oninput = () => { notesEdited = true; dirty = true; refreshToolbarStatus() }
        notesArea.onblur = () => { commitNotes(); if (pendingFlush === commitNotes) pendingFlush = null }
      } else if (slide.notes) {
        const notes = el('section', card, css.notes)
        el('strong', notes, undefined, t('slide_notes'))
        el('div', notes, undefined, slide.notes)
      }
      bindTextQuote(card, range => slideSource(closest(range.startContainer, '[data-slide-element]')), () => {
        const area = card.ownerDocument.activeElement as HTMLTextAreaElement | null
        if (area?.tagName !== 'TEXTAREA' || !card.contains(area) || area.selectionStart === area.selectionEnd) return null
        return { text: area.value.slice(area.selectionStart, area.selectionEnd), source: slideSource(), anchorRect: area.getBoundingClientRect() }
      })
      return card
    })

    let destination: number | undefined
    function set(index: number) {
      active = index; state.activeSlide = index
      counter.textContent = t('slide_counter', { current: index + 1, total: cards.length })
      prev.disabled = index === 0; forward.disabled = index === cards.length - 1
    }
    const top = (node: HTMLElement) => node.getBoundingClientRect().top - deck.getBoundingClientRect().top + deck.scrollTop - 16
    const go = (i: number) => {
      const index = Math.max(0, Math.min(cards.length - 1, i))
      destination = index
      set(index)
      deck.scrollTo({ top: top(cards[index]!), behavior: 'smooth' })
    }
    prev.onclick = () => go(active - 1)
    forward.onclick = () => go(active + 1)
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); go(active + (e.key === 'PageUp' ? -1 : 1)) }
    }
    deck.onkeydown = keydown; bar.onkeydown = keydown
    deck.onscrollend = () => { destination = undefined }
    deck.onwheel = () => { destination = undefined }
    deck.onpointerdown = () => { destination = undefined }
    deck.onscroll = () => {
      state.scrollTop = deck.scrollTop
      if (destination !== undefined) return
      let index = 0
      for (let i = 1; i < cards.length; i++) if (top(cards[i]!) <= deck.scrollTop + deck.clientHeight / 3) index = i
      if (deck.scrollTop > 0 && deck.scrollTop + deck.clientHeight >= deck.scrollHeight - 1) index = cards.length - 1
      set(index)
    }
    set(active)
    deck.scrollTop = state.scrollTop ?? top(cards[active]!)
  }

  function renderMindMap(next: OfficeMindMapPreview) {
    const editable = editingEnabled()
    if (!next.sheets.length) {
      if (!editable) { empty('mindmap_empty'); return }
      next.sheets.push({ id: makeTopicId(), title: t('mindmap_new_sheet', { index: 1 }), rootTopic: { id: makeTopicId(), title: t('mindmap_central_topic') } })
    }
    const sheetIdx = Math.max(0, Math.min(next.sheets.length - 1, state.activeMindSheet ?? next.activeSheet ?? 0))
    state.activeMindSheet = sheetIdx
    const sheet = next.sheets[sheetIdx]!
    let selectedId = state.selectedTopicId && findTopicAndParent(sheet.rootTopic, state.selectedTopicId)
      ? state.selectedTopicId
      : sheet.rootTopic.id
    state.selectedTopicId = selectedId
    let zoom = Math.min(2, Math.max(0.4, state.mindZoom ?? 1))
    let inlineEditingId: string | null = null

    const addChildToSelected = () => {
      const childId = makeTopicId()
      pushMutation(d => {
        if (d.kind !== 'mindmap') return
        const s = d.sheets[sheetIdx]
        if (!s) return
        const found = findTopicAndParent(s.rootTopic, selectedId)
        if (!found) return
        found.topic.folded = false
        found.topic.children = [...(found.topic.children ?? []), { id: childId, title: t('mindmap_new_child') }]
        state.selectedTopicId = childId
      })
    }

    const addSiblingToSelected = () => {
      const found = findTopicAndParent(sheet.rootTopic, selectedId)
      if (!found) return
      if (!found.parent) {
        addChildToSelected()
        return
      }
      const siblingId = makeTopicId()
      pushMutation(d => {
        if (d.kind !== 'mindmap') return
        const s = d.sheets[sheetIdx]
        if (!s) return
        const target = findTopicAndParent(s.rootTopic, selectedId)
        if (!target?.parent) return
        target.parent.children ??= []
        target.parent.children.splice(target.index + 1, 0, { id: siblingId, title: t('mindmap_new_sibling') })
        state.selectedTopicId = siblingId
      })
    }

    const deleteSelectedTopic = () => {
      const found = findTopicAndParent(sheet.rootTopic, selectedId)
      if (!found?.parent) return
      const fallbackId = found.parent.children?.[found.index - 1]?.id ?? found.parent.children?.[found.index + 1]?.id ?? found.parent.id
      pushMutation(d => {
        if (d.kind !== 'mindmap') return
        const s = d.sheets[sheetIdx]
        if (!s) return
        const target = findTopicAndParent(s.rootTopic, selectedId)
        if (!target?.parent?.children) return
        target.parent.children.splice(target.index, 1)
        if (!target.parent.children.length) delete target.parent.children
        state.selectedTopicId = fallbackId
      })
    }

    const toggleSelectedCollapse = (topicId = selectedId) => {
      pushMutation(d => {
        if (d.kind !== 'mindmap') return
        const s = d.sheets[sheetIdx]
        if (!s) return
        const target = findTopicAndParent(s.rootTopic, topicId)
        if (!target?.topic.children?.length) return
        target.topic.folded = !target.topic.folded
      })
    }

    let triggerInlineRename: ((id: string) => void) | null = null

    if (editable) {
      mountEditorHeader(bar => {
        const topicGroup = el('div', bar, css.toolbarGroup)
        const addBtn = (parent: HTMLElement, label: string, fn: () => void, aria?: string) => {
          const b = el('button', parent, css.toolbarBtn, label)
          b.type = 'button'
          if (aria) b.setAttribute('aria-label', aria)
          b.onclick = fn
          return b
        }
        addBtn(topicGroup, t('mindmap_add_child'), addChildToSelected)
        addBtn(topicGroup, t('mindmap_add_sibling'), addSiblingToSelected)
        addBtn(topicGroup, t('mindmap_edit_topic'), () => triggerInlineRename?.(selectedId))
        addBtn(topicGroup, t('mindmap_toggle_children'), () => toggleSelectedCollapse(selectedId))
        const delBtn = addBtn(topicGroup, t('mindmap_delete_topic'), deleteSelectedTopic)
        delBtn.disabled = selectedId === sheet.rootTopic.id

        const zoomGroup = el('div', bar, css.toolbarGroup)
        addBtn(zoomGroup, '−', () => {
          state.mindZoom = Math.max(0.4, Math.round((zoom - 0.15) * 100) / 100)
          render(current, false)
        }, t('mindmap_zoom_out'))
        addBtn(zoomGroup, `${Math.round(zoom * 100)}%`, () => {
          state.mindZoom = 1
          render(current, false)
        }, t('mindmap_zoom_reset'))
        addBtn(zoomGroup, '+', () => {
          state.mindZoom = Math.min(2, Math.round((zoom + 0.15) * 100) / 100)
          render(current, false)
        }, t('mindmap_zoom_in'))
      })
    } else {
      const bar = el('div', root, css.bar)
      const zoomOut = el('button', bar, undefined, '−')
      zoomOut.setAttribute('aria-label', t('mindmap_zoom_out'))
      const zoomReset = el('button', bar, undefined, `${Math.round(zoom * 100)}%`)
      zoomReset.setAttribute('aria-label', t('mindmap_zoom_reset'))
      const zoomIn = el('button', bar, undefined, '+')
      zoomIn.setAttribute('aria-label', t('mindmap_zoom_in'))
      zoomOut.onclick = () => { state.mindZoom = Math.max(0.4, zoom - 0.15); render(current, false) }
      zoomReset.onclick = () => { state.mindZoom = 1; render(current, false) }
      zoomIn.onclick = () => { state.mindZoom = Math.min(2, zoom + 0.15); render(current, false) }
    }

    const viewport = el('div', root, css.mindViewport)
    viewport.tabIndex = 0
    viewport.setAttribute('role', 'region')
    viewport.setAttribute('aria-label', t('mindmap_canvas_aria'))

    // Compute clean hierarchical mind-map layout
    type PositionedNode = {
      topic: OfficeMindMapTopic
      depth: number
      x: number
      y: number
      w: number
      h: number
      color: string
      parent?: PositionedNode
    }
    const positioned: PositionedNode[] = []
    const ROW_GAP = 18
    const COL_GAP = 72
    const estimateWidth = (topic: OfficeMindMapTopic, depth: number) => {
      const chars = Array.from(topic.title || '').reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 1.8 : 1), 0)
      const extras = (topic.labels?.length ? 36 : 0) + (topic.notes ? 24 : 0) + (topic.children?.length ? 30 : 0)
      const base = depth === 0 ? 48 : depth === 1 ? 34 : 28
      return Math.min(260, Math.max(depth === 0 ? 132 : 96, Math.round(chars * 8.2 + base + extras)))
    }
    const estimateHeight = (depth: number) => depth === 0 ? 44 : depth === 1 ? 36 : 32

    function subtreeSpan(topic: OfficeMindMapTopic, depth: number): number {
      const ownH = estimateHeight(depth)
      if (topic.folded || !topic.children?.length) return ownH
      const childSum = topic.children.reduce((acc, child) => acc + subtreeSpan(child, depth + 1), 0)
      return Math.max(ownH, childSum + ROW_GAP * (topic.children.length - 1))
    }

    const totalSpan = subtreeSpan(sheet.rootTopic, 0)
    const padX = 64
    const padY = 56
    let maxRight = padX + 320

    function place(topic: OfficeMindMapTopic, depth: number, leftX: number, topY: number, spanH: number, color: string, parent?: PositionedNode) {
      const w = estimateWidth(topic, depth)
      const h = estimateHeight(depth)
      const y = topY + (spanH - h) / 2
      const node: PositionedNode = { topic, depth, x: leftX, y, w, h, color, parent }
      positioned.push(node)
      maxRight = Math.max(maxRight, leftX + w + padX)
      if (topic.folded || !topic.children?.length) return
      const childSpans = topic.children.map(ch => subtreeSpan(ch, depth + 1))
      const childrenTotal = childSpans.reduce((a, b) => a + b, 0) + ROW_GAP * (topic.children.length - 1)
      let cursorY = topY + (spanH - childrenTotal) / 2
      topic.children.forEach((child, idx) => {
        const branchColor = depth === 0 ? BRANCH_COLORS[idx % BRANCH_COLORS.length]! : color
        const chSpan = childSpans[idx]!
        place(child, depth + 1, leftX + w + COL_GAP, cursorY, chSpan, branchColor, node)
        cursorY += chSpan + ROW_GAP
      })
    }

    const worldHeight = Math.max(420, totalSpan + padY * 2)
    place(sheet.rootTopic, 0, padX, padY, totalSpan, '#2563eb')
    const worldWidth = Math.max(760, maxRight)

    const world = el('div', viewport, css.mindWorld)
    world.style.width = `${worldWidth}px`
    world.style.height = `${worldHeight}px`
    world.style.transform = `scale(${zoom})`

    const svg = svgNode('svg', world)
    svg.setAttribute('class', css.mindSvg || '')
    svg.setAttribute('viewBox', `0 0 ${worldWidth} ${worldHeight}`)

    const nodeElementById = new Map<string, { box: HTMLElement; titleSpan: HTMLElement; topic: OfficeMindMapTopic }>()

    for (const item of positioned) {
      if (item.parent) {
        const x1 = item.parent.x + item.parent.w
        const y1 = item.parent.y + item.parent.h / 2
        const x2 = item.x
        const y2 = item.y + item.h / 2
        const dx = Math.max(28, (x2 - x1) * 0.5)
        const path = svgNode('path', svg)
        path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`)
        path.setAttribute('fill', 'none')
        path.setAttribute('stroke', item.color)
        path.setAttribute('stroke-width', item.depth === 1 ? '2.4' : '1.8')
        path.setAttribute('stroke-linecap', 'round')
      }

      const cls = [
        css.mindNode,
        item.depth === 0 ? css.mindRoot : item.depth === 1 ? css.mindMain : css.mindSub,
        item.topic.id === selectedId ? css.mindSelected : '',
      ].filter(Boolean).join(' ')
      const box = el('div', world, cls)
      box.style.left = `${item.x}px`
      box.style.top = `${item.y}px`
      box.style.minHeight = `${item.h}px`
      if (item.depth > 0) box.style.borderColor = item.color
      box.setAttribute('data-topic-id', item.topic.id)

      const titleSpan = el('span', box, css.mindTitle, item.topic.title)
      nodeElementById.set(item.topic.id, { box, titleSpan, topic: item.topic })

      if (item.topic.labels?.length) {
        el('span', box, css.mindBadge, item.topic.labels.join(', '))
      }
      if (item.topic.notes) {
        el('span', box, css.mindBadge, '✎')
      }
      if (item.topic.href && /^(?:https?:|mailto:)/i.test(item.topic.href) && options.openExternal) {
        const linkBtn = el('button', box, css.mindToggle, '↗')
        linkBtn.type = 'button'
        linkBtn.setAttribute('aria-label', t('mindmap_open_link'))
        const url = item.topic.href
        linkBtn.onclick = ev => { ev.stopPropagation(); options.openExternal?.(url) }
      }
      if (item.topic.children?.length) {
        const hiddenCount = countHiddenDescendants(item.topic)
        const toggleBtn = el('button', box, css.mindToggle, item.topic.folded ? `+${hiddenCount}` : '−')
        toggleBtn.type = 'button'
        toggleBtn.setAttribute('aria-label', t('mindmap_toggle_children'))
        toggleBtn.onclick = ev => {
          ev.stopPropagation()
          if (editable) toggleSelectedCollapse(item.topic.id)
          else {
            item.topic.folded = !item.topic.folded
            render(current, false)
          }
        }
      }

      box.onclick = ev => {
        ev.stopPropagation()
        if (inlineEditingId === item.topic.id) return
        selectedId = item.topic.id
        state.selectedTopicId = selectedId
        render(current, false)
        viewport.focus({ preventScroll: true })
      }

      if (editable) {
        box.ondblclick = ev => {
          ev.stopPropagation()
          triggerInlineRename?.(item.topic.id)
        }
      }
    }

    triggerInlineRename = (topicId: string) => {
      if (!editable) return
      const entry = nodeElementById.get(topicId)
      if (!entry) return
      inlineEditingId = topicId
      const input = el('input', entry.box, css.mindNodeInput)
      input.type = 'text'
      input.value = entry.topic.title
      entry.titleSpan.style.display = 'none'
      let done = false
      const finish = (commit: boolean) => {
        if (done) return
        done = true
        inlineEditingId = null
        if (pendingFlush === commitNow) pendingFlush = null
        const nextTitle = input.value.trim()
        input.remove?.()
        entry.titleSpan.style.display = ''
        if (commit && nextTitle && nextTitle !== entry.topic.title) {
          pushMutation(d => {
            if (d.kind !== 'mindmap') return
            const s = d.sheets[sheetIdx]
            if (!s) return
            const found = findTopicAndParent(s.rootTopic, topicId)
            if (found) found.topic.title = nextTitle
          })
        } else {
          viewport.focus({ preventScroll: true })
        }
      }
      const commitNow = () => finish(true)
      pendingFlush = commitNow
      input.onclick = ev => ev.stopPropagation()
      input.onkeydown = (ev: KeyboardEvent) => {
        ev.stopPropagation()
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
      }
      input.onblur = () => finish(true)
      input.focus()
      input.select?.()
    }

    // Drag to pan + Ctrl/Meta wheel to zoom
    let dragStart: { x: number; y: number; scrollLeft: number; scrollTop: number } | null = null
    viewport.onpointerdown = (ev: PointerEvent) => {
      if (ev.target !== viewport && ev.target !== world) return
      dragStart = { x: ev.clientX, y: ev.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop }
      viewport.classList.add(css.mindViewportDragging!)
    }
    viewport.onpointermove = (ev: PointerEvent) => {
      if (!dragStart) return
      viewport.scrollLeft = dragStart.scrollLeft - (ev.clientX - dragStart.x)
      viewport.scrollTop = dragStart.scrollTop - (ev.clientY - dragStart.y)
    }
    viewport.onpointerup = () => {
      dragStart = null
      viewport.classList.remove(css.mindViewportDragging!)
    }
    viewport.onwheel = (ev: WheelEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return
      ev.preventDefault()
      const delta = ev.deltaY > 0 ? -0.1 : 0.1
      state.mindZoom = Math.min(2, Math.max(0.4, Math.round((zoom + delta) * 100) / 100))
      render(current, false)
    }

    viewport.onkeydown = (ev: KeyboardEvent) => {
      if (!editable || inlineEditingId) return
      if (ev.key === 'Tab') {
        ev.preventDefault()
        addChildToSelected()
      } else if (ev.key === 'Enter') {
        ev.preventDefault()
        addSiblingToSelected()
      } else if (ev.key === 'F2') {
        ev.preventDefault()
        triggerInlineRename?.(selectedId)
      } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (selectedId !== sheet.rootTopic.id) {
          ev.preventDefault()
          deleteSelectedTopic()
        }
      } else if (ev.key === ' ') {
        ev.preventDefault()
        toggleSelectedCollapse(selectedId)
      }
    }

    // Topic inspector bar (Labels & Notes)
    const activeInfo = findTopicAndParent(sheet.rootTopic, selectedId)?.topic ?? sheet.rootTopic
    if (editable || activeInfo.labels?.length || activeInfo.notes) {
      const inspector = el('div', root, css.mindInspector)
      const labelsField = el('label', inspector, css.mindField)
      el('span', labelsField, css.mindFieldLabel, t('mindmap_labels_label'))
      const labelsInput = el('input', labelsField, css.mindFieldInput)
      labelsInput.type = 'text'
      labelsInput.value = (activeInfo.labels ?? []).join(', ')
      labelsInput.placeholder = t('mindmap_labels_placeholder')
      labelsInput.readOnly = !editable

      const notesField = el('label', inspector, css.mindField)
      el('span', notesField, css.mindFieldLabel, t('mindmap_notes_label'))
      const notesInput = el('input', notesField, css.mindFieldInput)
      notesInput.type = 'text'
      notesInput.value = activeInfo.notes ?? ''
      notesInput.placeholder = t('mindmap_notes_placeholder')
      notesInput.readOnly = !editable

      if (editable) {
        let metaEdited = false
        const commitMeta = () => {
          if (!metaEdited || current.kind !== 'mindmap') return
          metaEdited = false
          const nextLabels = labelsInput.value.split(',').map(s => s.trim()).filter(Boolean)
          const nextNotes = notesInput.value.trim()
          pushMutation(d => {
            if (d.kind !== 'mindmap') return
            const s = d.sheets[sheetIdx]
            if (!s) return
            const found = findTopicAndParent(s.rootTopic, selectedId)
            if (!found) return
            if (nextLabels.length) found.topic.labels = nextLabels
            else delete found.topic.labels
            if (nextNotes) found.topic.notes = nextNotes
            else delete found.topic.notes
          })
        }
        for (const input of [labelsInput, notesInput]) {
          input.onfocus = () => { pendingFlush = commitMeta }
          input.oninput = () => { metaEdited = true; dirty = true; refreshToolbarStatus() }
          input.onblur = () => { commitMeta(); if (pendingFlush === commitMeta) pendingFlush = null }
          input.onkeydown = (ev: KeyboardEvent) => {
            if (ev.key === 'Enter') { ev.preventDefault(); commitMeta() }
          }
        }
      }
    }

    // MindMap Sheet tabs
    if (next.sheets.length > 1 || editable) {
      const tabs = el('div', root, css.tabs)
      tabs.setAttribute('role', 'tablist')
      tabs.setAttribute('aria-label', t('mindmap_tabs_aria'))
      next.sheets.forEach((s, i) => {
        const btn = el('button', tabs, undefined, s.title)
        btn.type = 'button'
        btn.setAttribute('role', 'tab')
        btn.setAttribute('aria-selected', String(i === sheetIdx))
        btn.onclick = () => {
          state.activeMindSheet = i
          state.selectedTopicId = s.rootTopic.id
          render(current, false)
        }
        if (editable) {
          btn.ondblclick = ev => {
            ev.preventDefault()
            const input = el('input', tabs, css.tabInput)
            input.type = 'text'
            input.value = s.title
            btn.replaceWith?.(input)
            const done = (commit: boolean) => {
              const title = input.value.trim()
              if (commit && title && title !== s.title) {
                pushMutation(d => {
                  if (d.kind === 'mindmap' && d.sheets[i]) d.sheets[i]!.title = title
                })
              } else {
                render(current, false)
              }
            }
            input.onkeydown = kev => {
              if (kev.key === 'Enter') { kev.preventDefault(); done(true) }
              else if (kev.key === 'Escape') { kev.preventDefault(); done(false) }
            }
            input.onblur = () => done(true)
            input.focus()
            input.select?.()
          }
        }
      })
      if (editable) {
        const addBtn = el('button', tabs, undefined, t('sheet_add_tab'))
        addBtn.type = 'button'
        addBtn.onclick = () => pushMutation(d => {
          if (d.kind !== 'mindmap') return
          const idx = d.sheets.length + 1
          const rootId = makeTopicId()
          d.sheets.push({
            id: makeTopicId(),
            title: t('mindmap_new_sheet', { index: idx }),
            rootTopic: { id: rootId, title: t('mindmap_central_topic') },
          })
          state.activeMindSheet = d.sheets.length - 1
          state.selectedTopicId = rootId
        })
        if (next.sheets.length > 1) {
          const delBtn = el('button', tabs, undefined, '×')
          delBtn.type = 'button'
          delBtn.setAttribute('aria-label', t('sheet_delete_tab'))
          delBtn.onclick = () => pushMutation(d => {
            if (d.kind !== 'mindmap' || d.sheets.length <= 1) return
            d.sheets.splice(sheetIdx, 1)
            const nextActive = Math.max(0, sheetIdx - 1)
            state.activeMindSheet = nextActive
            state.selectedTopicId = d.sheets[nextActive]!.rootTopic.id
          })
        }
      }
    }
  }

  function clearQuoteBindings() { for (const dispose of quoteBindings.splice(0)) dispose() }
  function render(next: OfficePreviewPayload, resetHistory = true) {
    clearQuoteBindings()
    if (resetHistory) {
      current = clonePayload(next)
      undoStack.length = 0
      redoStack.length = 0
    }
    root.replaceChildren()
    statusEl = null
    saveBtnEl = null
    undoBtnEl = null
    redoBtnEl = null

    if (next.kind === 'error') {
      empty(`error_${next.code}`, { limit: `${(next.maxBytes ?? 50 * 1024 ** 2) / 1024 ** 2} MB` })
      return
    }
    if (next.kind === 'document') {
      if (editingEnabled()) {
        renderEditableDocument(next)
        return
      }
      if (!next.blocks.length && !next.footnotes?.length && !next.truncated) { empty('doc_empty'); return }
      const stage = el('div', root, css.document)
      const paper = el('article', stage, css.paper)
      if (next.truncated) el('div', paper, css.notice, t('doc_truncated'))
      let section = ''
      next.blocks.forEach((block, index) => {
        if (block.kind === 'paragraph' && block.heading) section = block.runs.map(run => run.text).join('').trim()
        blocks(paper, [block])
        const element = paper.children[paper.children.length - 1] as HTMLElement | undefined
        if (element) { element.setAttribute('data-doc-paragraph', String(index + 1)); if (section) element.setAttribute('data-doc-section', section) }
      })
      bindTextQuote(paper, range => {
        const data = closest(range.startContainer, '[data-doc-paragraph]')?.dataset
        return { kind: 'word', ...(data?.docSection ? { section: data.docSection } : { paragraph: Number(data?.docParagraph) || undefined }) }
      })
      if (next.footnotes?.length) {
        el('h2', paper, undefined, t('doc_footnotes'))
        for (const note of next.footnotes) blocks(paper, note.blocks)
      }
      stage.scrollTop = state.scrollTop ?? 0
      stage.onscroll = () => { state.scrollTop = stage.scrollTop }
      return
    }
    if (next.kind === 'spreadsheet') {
      renderSpreadsheet(next)
      return
    }
    if (next.kind === 'pdf') {
      if (!next.pages.length && !next.truncated) { empty('pdf_empty'); return }
      const stage = el('div', root, css.document)
      for (const [index, page] of next.pages.entries()) {
        const paper = el('article', stage, css.paper)
        paper.setAttribute('data-pdf-page', String(page.index))
        if (!index && next.truncated) el('div', paper, css.notice, t('doc_truncated'))
        el('div', paper, css.subtitle, t('pdf_page', { index: page.index }))
        blocks(paper, page.blocks)
      }
      bindTextQuote(stage, range => {
        const paper = closest(range.startContainer, '[data-pdf-page]')
        const page = paper && paper.contains(range.endContainer) ? Number(paper.dataset.pdfPage) : undefined
        return { kind: 'pdf', ...(page ? { page, totalPages: next.pageCount || next.pages.length } : {}) }
      })
      stage.scrollTop = state.scrollTop ?? 0
      stage.onscroll = () => { state.scrollTop = stage.scrollTop }
      return
    }
    if (next.kind === 'mindmap') {
      renderMindMap(next)
      return
    }
    renderPresentation(next)
  }

  root.onkeydown = (event: KeyboardEvent) => {
    if (!editingEnabled()) return
    const mod = event.metaKey || event.ctrlKey
    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === 's') {
      event.preventDefault()
      event.stopPropagation()
      void runSave(event.shiftKey || !canSaveInPlace)
      return
    }
    const targetTag = (event.target as HTMLElement | null)?.tagName?.toLowerCase()
    const inNativeInput = targetTag === 'input' || targetTag === 'textarea'
    if (!inNativeInput && key === 'z') {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) redo()
      else undo()
    } else if (!inNativeInput && key === 'y') {
      event.preventDefault()
      event.stopPropagation()
      redo()
    }
  }

  render(current, true)
  return {
    destroy: () => {
      pendingFlush?.()
      pendingFlush = null
      clearQuoteBindings()
      root.remove?.()
    },
    update: (next, meta) => {
      if (meta?.canSaveInPlace !== undefined) canSaveInPlace = meta.canSaveInPlace
      if (meta?.dirty !== undefined) dirty = meta.dirty
      render(next, true)
    },
    getPayload: () => {
      pendingFlush?.()
      pendingFlush = null
      return clonePayload(current)
    },
    markSaved: () => {
      dirty = false
      statusKind = 'saved'
      refreshToolbarStatus()
    },
    save: () => runSave(false),
    saveAs: () => runSave(true),
  }
}
