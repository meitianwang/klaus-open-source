import { attachPanelQuoteToolbar, openShadowRoots, panelDomSelection } from './panel-quote-toolbar'
import { writeClipboardText } from '../clipboard'
import { CodeView, type CodeViewFileItem, type CodeViewOptions } from '@pierre/diffs'
import { Editor, type EditState, type EditorOptions } from '@pierre/diffs/edit'
import styles from './workspace-source-editor.module.css'

export interface SourceEditorSnapshot {
  content: string
  state?: EditState<'file', undefined>
  scrollTop: number
}

export interface SourceEditorOptions {
  parent: HTMLElement
  path: string
  quoteKind?: 'code' | 'markdown'
  content: string
  readOnly: boolean
  initialState?: SourceEditorSnapshot
  onChange(content: string): void
  onSave(): void | Promise<unknown>
}

type CodePoint = { line: number; character: number }
export function sourceQuoteRange(value: string, start: CodePoint, end: CodePoint) {
  if (start.line > end.line || (start.line === end.line && start.character > end.character)) [start, end] = [end, start]
  const lines = value.split('\n')
  const offset = ({ line, character }: CodePoint) => lines.slice(0, line).reduce((total, row) => total + row.length + 1, character)
  return { text: value.slice(offset(start), offset(end)), startLine: start.line + 1,
    endLine: end.character === 0 && end.line > start.line ? end.line : end.line + 1 }
}

/** A virtualized code viewer and an editor share one syntax-highlighted surface. */
export function createSourceEditor(options: SourceEditorOptions) {
  const host = document.createElement('div')
  host.className = styles.editor
  host.setAttribute('aria-label', options.path)
  options.parent.append(host)
  const id = 'workspace-source'
  let content = options.content
  let readOnly = options.readOnly
  let version = 0
  const cacheIdentity = crypto.randomUUID()
  let disposed = false
  let editor: Editor<'file', undefined, undefined> | undefined
  let attached = false
  let applyingExternalChange = false
  let pendingLine: number | undefined
  let state = options.initialState?.state
  let restoring = !!state && options.initialState?.content !== content
  const retainedContent = restoring ? options.initialState!.content : content
  const captureState = (): EditState<'file', undefined> | undefined => {
    const captured = editor?.getEditState() ?? state
    if (captured && editor) captured.editor = editor.getViewState()
    return captured
  }
  const item = (text = content): CodeViewFileItem => ({
    id, type: 'file', version, edit: !readOnly,
    file: { name: options.path, contents: text, cacheKey: `${options.path}:${cacheIdentity}:${version}` },
  })
  const config = (): CodeViewOptions<undefined, undefined> => ({
    theme: { light: 'github-light', dark: 'github-dark' },
    themeType: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    preferredHighlighter: 'shiki-js',
    disableFileHeader: true,
    overflow: 'wrap',
    stickyHeaders: false,
    createEditor(type, settings, key) {
      if (type === 'file' && state) restoring = state.document.getText() !== content
      const instance = new Editor(type, {
        ...settings,
        ...(type === 'file' && state ? { initialState: state } : {}),
        onAttach() {
          attached = true
          queueMicrotask(() => {
            if (disposed || readOnly || !editor) return
            if (pendingLine) {
              const point = { line: pendingLine - 1, character: 0 }
              editor.setSelections([{ start: point, end: point, direction: 'none' }])
              editor.focus({ lineNumber: pendingLine, preventScroll: true })
              pendingLine = undefined
            } else if (!editor.getViewState().selections?.length) {
              editor.setSelections([{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, direction: 'none' }])
            }
          })
          if (!restoring) return
          queueMicrotask(() => {
            if (disposed) return
            applyingExternalChange = true
            try { version++; viewer.updateItem(item()) }
            finally { applyingExternalChange = false; restoring = false }
          })
        },
      } as EditorOptions<typeof type, undefined, undefined>, key)
      if (type === 'file') {
        attached = false
        editor = instance as Editor<'file', undefined, undefined>
        state = undefined
      }
      return instance
    },
    onItemEditChange(event) {
      if (disposed || restoring || applyingExternalChange || event.file.contents === content) return
      content = event.file.contents
      options.onChange(content)
    },
    onItemEditComplete(event) {
      if ('file' in event && event.editor === editor) {
        state = event.editor.getEditState() ?? state
        content = event.file.contents
        editor = undefined
        attached = false
      }
      return 'accept'
    },
    unsafeCSS: ':host{--diffs-font-family:var(--font-mono);--diffs-font-size:var(--text-body-sm);--diffs-line-height:22px} [data-diffs]{background:var(--bg);color:var(--fg)}',
  })
  const viewer = new CodeView(config(), undefined, true)
  viewer.setup(host)
  viewer.setItems([item(retainedContent)])
  const surfaceObservers = new Map<ParentNode, MutationObserver>()
  const removeHoverTitles = (root: ParentNode): void => {
    for (const element of root.querySelectorAll<HTMLElement>('[title]')) {
      if (!element.hasAttribute('aria-label') && !element.textContent?.trim()) element.setAttribute('aria-label', element.title)
      element.removeAttribute('title')
    }
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) observeSurface(element.shadowRoot)
  }
  const observeSurface = (root: ParentNode): void => {
    if (surfaceObservers.has(root)) return
    const observer = new MutationObserver(() => removeHoverTitles(root))
    observer.observe(root as Node, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
    surfaceObservers.set(root, observer)
    removeHoverTitles(root)
  }
  observeSurface(host)
  if (options.initialState?.scrollTop) viewer.scrollTo({ type: 'position', position: options.initialState.scrollTop, behavior: 'instant' })
  const themeObserver = new MutationObserver(() => { if (!disposed) viewer.setOptions(config()) })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      void options.onSave()
    }
  }
  host.addEventListener('keydown', onKeyDown, true)
  const quoteSource = (value: string, startLine?: number, endLine?: number) => {
    const kind = options.quoteKind || 'code'
    const rows = kind === 'markdown' && startLine ? value.split('\n').slice(0, startLine).reverse() : []
    const section = rows.map(row => /^#{1,6}\s+(.+?)\s*#*$/.exec(row)?.[1]?.trim()).find(Boolean)
    return { kind, path: options.path, startLine, endLine, ...(section ? { section } : {}) }
  }
  const quote = attachPanelQuoteToolbar(host, {
    canClearSelection: () => readOnly,
    copySelection: text => { void writeClipboardText(text).catch(() => {}) },
    resolveCurrent() {
      if (readOnly || !attached || !editor) return null
      const selected = editor.getViewState().selections?.find(({ start, end }) => start.line !== end.line || start.character !== end.character)
      if (!selected) return null
      const { text, startLine, endLine } = sourceQuoteRange(editor.getText(), selected.start, selected.end)
      const domRect = panelDomSelection(host)?.range.getBoundingClientRect()
      const line = [host, ...openShadowRoots(host)].map(root => root.querySelector(`[data-line="${startLine}"]`)).find(Boolean)
      return { text, source: quoteSource(editor.getText(), startLine, endLine),
        anchorRect: domRect && (domRect.width || domRect.height) ? domRect : line?.getBoundingClientRect() || host.getBoundingClientRect() }
    },
    resolveSelection(_selection, range) {
      const line = (node: Node) => {
        const row = (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest('[data-line], [data-line-number]')
        return row
      }
      const start = line(range.startContainer), end = line(range.endContainer)
      const number = (row: Element | null | undefined) => Number(row?.getAttribute('data-line') || row?.getAttribute('data-line-number')) || undefined
      const startLine = number(start), endLine = number(end)
      if (!start || !end || !startLine || !endLine) return { text: range.toString(), source: quoteSource(content, startLine, endLine) }
      const offset = (row: Element, node: Node, index: number) => {
        const prefix = row.ownerDocument.createRange()
        prefix.selectNodeContents(row)
        prefix.setEnd(node, index)
        return prefix.toString().length
      }
      const result = sourceQuoteRange(content, { line: startLine - 1, character: offset(start, range.startContainer, range.startOffset) },
        { line: endLine - 1, character: offset(end, range.endContainer, range.endOffset) })
      return { text: result.text, source: quoteSource(content, result.startLine, result.endLine) }
    },
  })
  return {
    getContent: () => editor?.getText() ?? content,
    updateContent(next: string) {
      if (disposed || next === content) return
      content = next
      applyingExternalChange = true
      try { version++; viewer.updateItem(item()) } finally { applyingExternalChange = false }
    },
    setReadOnly(next: boolean) {
      if (next === readOnly || disposed) return
      state = captureState()
      readOnly = next
      version++
      viewer.updateItem(item())
    },
    snapshot(): SourceEditorSnapshot {
      return { content: editor?.getText() ?? content, state: captureState(), scrollTop: viewer.getScrollTop() }
    },
    goToLine(line: number) {
      const target = Math.max(1, Math.min(Math.floor(line), content.split('\n').length))
      pendingLine = target
      viewer.scrollTo({ type: 'line', id, lineNumber: target, align: 'center', behavior: 'instant' })
      if (!readOnly && attached && editor?.getEditState()) {
        const point = { line: target - 1, character: 0 }
        editor.setSelections([{ start: point, end: point, direction: 'none' }])
        editor.focus({ lineNumber: target, preventScroll: true })
        pendingLine = undefined
      }
    },
    focus() { if (!readOnly) editor?.focus({ preventScroll: true }) },
    revealMatch(from: number, to: number) {
      if (disposed) return
      const text = editor?.getText() ?? content
      const point = (offset: number) => {
        const before = text.slice(0, Math.max(0, Math.min(text.length, offset)))
        return { line: before.split('\n').length - 1, character: before.length - before.lastIndexOf('\n') - 1 }
      }
      const start = point(from), end = point(to)
      viewer.scrollTo({ type: 'line', id, lineNumber: start.line + 1, align: 'center', behavior: 'instant' })
      viewer.setSelectedLines({ id, range: { start: start.line + 1, end: end.line + 1 } })
      if (!readOnly && attached && editor?.getEditState()) editor.setSelections([{ start, end, direction: 'forward' }])
    },
    destroy() {
      if (disposed) return
      disposed = true
      quote()
      themeObserver.disconnect()
      for (const observer of surfaceObservers.values()) observer.disconnect()
      host.removeEventListener('keydown', onKeyDown, true)
      viewer.cleanUp()
      host.remove()
    },
  }
}

export type SourceEditor = ReturnType<typeof createSourceEditor>
