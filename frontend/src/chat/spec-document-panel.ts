import { icon } from '../icons/registry'
import { SpecDocumentModel, findSpecMatches, isNearSpecBottom, specDocumentKey, specDocumentName, type SpecDocument, type SpecDocumentEvent } from './spec-document-model'
import { submitSpecAnnotationDraft, type SpecAnnotation, type SpecAnnotationHandle } from './spec-document-annotations'
import { specFindNavigationDirection } from './spec-document-shortcuts'
import './spec-document-panel.css'
import { writeClipboardText } from '../clipboard'
export type { SpecAnnotation, SpecAnnotationHandle } from './spec-document-annotations'

export interface SpecDocumentPanelOptions {
  root: HTMLElement | null
  readSpecDoc(path: string): Promise<{ content?: string; error?: unknown } | undefined>
  resolvePath?(sessionId: string, path: string): string
  knownPaths?(sessionId: string): string[]
  renderMarkdown(text: string, sessionId?: string): string
  attachAnnotations(host: HTMLElement, document: HTMLElement, context: { sessionId: string | null; path: string }): SpecAnnotationHandle
  submitAnnotations(items: SpecAnnotation[], path: string, sessionId: string): boolean | Promise<boolean>
  openPanel(): void
  openDirectory(path: string): unknown | Promise<unknown>
  translate(key: string): string
  onDocumentSelected?(path: string, sessionId: string): void
  onDocumentDiscovered?(document: { sessionId: string; path: string }): void
  copyText?(text: string): Promise<unknown>
  downloadFile?(name: string, content: string): unknown | Promise<unknown>
}

interface DocumentView {
  host: HTMLElement
  body: HTMLElement
  document: HTMLElement
  handle: SpecAnnotationHandle
  observer: MutationObserver
  revision: number
  followBottom: boolean
}

export function createSpecDocumentPanel(options: SpecDocumentPanelOptions) {
  const root = options.root
  const views = new Map<string, DocumentView>()
  let sessionId = ''
  let path = ''
  let disposed = false
  let submitting = false
  let actionGeneration = 0
  let findOpen = false
  let matchIndex = -1
  let matches: HTMLElement[][] = []
  let renderedSearch = ''
  const documentListeners = new Set<() => void>()
  const owner = root?.ownerDocument || document
  const translate = (key: string) => options.translate(key)
  const model = new SpecDocumentModel({
    read: options.readSpecDoc,
    resolvePath: options.resolvePath,
    onChange: () => {
      render()
      for (const listener of documentListeners) listener()
    },
    onDiscover: document => {
      if (document.sessionId === sessionId) options.onDocumentDiscovered?.(document)
    },
  })

  if (root) {
    root.classList.add('spec-document-panel')
    root.innerHTML = `
      <div class="spec-document-toolbar">
        <span class="spec-document-icon" aria-hidden="true">${icon('spec')}</span>
        <select class="spec-document-select"></select>
        <span class="spec-document-title"></span>
        <div class="spec-document-actions">
          <button type="button" data-spec-action="find">${icon('search')}</button>
          <button type="button" data-spec-action="copy">${icon('copy')}</button>
          <button type="button" data-spec-action="download">${icon('install')}</button>
          <button type="button" data-spec-action="directory">${icon('folder')}</button>
        </div>
      </div>
      <div class="spec-document-find" hidden>
        <input type="search" spellcheck="false" />
        <span class="spec-document-find-count" aria-live="polite">0/0</span>
        <button type="button" data-spec-action="previous">↑</button>
        <button type="button" data-spec-action="next">↓</button>
        <button type="button" data-spec-action="close-find">${icon('close')}</button>
      </div>
      <div class="spec-document-status" role="status" hidden></div>
      <div class="spec-document-views"></div>
      <div class="spec-document-empty"></div>
      <div class="spec-document-footer" hidden><button type="button" data-spec-action="annotations"></button></div>`
  }
  const element = <T extends HTMLElement>(selector: string) => root?.querySelector<T>(selector) || null
  const select = element<HTMLSelectElement>('.spec-document-select')
  const title = element('.spec-document-title')
  const host = element('.spec-document-views')
  const status = element('.spec-document-status')
  const empty = element('.spec-document-empty')
  const find = element('.spec-document-find')
  const input = element<HTMLInputElement>('.spec-document-find input')
  const count = element('.spec-document-find-count')
  const footer = element('.spec-document-footer')
  const button = (action: string) => element<HTMLButtonElement>(`[data-spec-action="${action}"]`)
  const current = () => model.get(sessionId, path)
  const activeView = () => views.get(specDocumentKey(sessionId, path))

  function showStatus(message: string) {
    if (!status) return
    status.textContent = message
    status.hidden = !message
  }

  function unmarkSearch() {
    root?.querySelectorAll<HTMLElement>('mark.spec-document-match').forEach(mark => mark.replaceWith(...mark.childNodes))
    matches = []
    matchIndex = -1
    renderedSearch = ''
  }

  function closeFind() {
    findOpen = false
    if (find) find.hidden = true
    if (input) input.value = ''
    unmarkSearch()
    syncFindCount()
  }

  function syncFindCount() {
    if (count) count.textContent = matches.length && matchIndex >= 0 ? `${matchIndex + 1}/${matches.length}` : '0/0'
    for (const action of ['previous', 'next']) { const control = button(action); if (control) control.disabled = matches.length === 0 }
  }

  function selectMatch(index: number) {
    matchIndex = matches.length ? (index % matches.length + matches.length) % matches.length : -1
    matches.forEach((marks, at) => marks.forEach(mark => mark.classList.toggle('is-current', at === matchIndex)))
    const target = matches[matchIndex]?.[0]
    const body = activeView()?.body
    if (target && body) {
      body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 2
      const view = activeView(); if (view) view.followBottom = false
    }
    syncFindCount()
  }

  function search() {
    const view = activeView()
    if (!view || !findOpen || current()?.streaming) return
    const query = input?.value || ''
    const signature = `${specDocumentKey(sessionId, path)}:${view.revision}:${query}`
    if (signature === renderedSearch) return
    unmarkSearch()
    renderedSearch = signature
    const nodes: Array<{ node: Text; start: number; end: number }> = []
    let text = ''
    const walker = owner.createTreeWalker(view.document, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (node.parentElement?.closest('button, script, style')) continue
      nodes.push({ node, start: text.length, end: text.length + node.length })
      text += node.data
    }
    const ranges = findSpecMatches(text, query)
    matches = ranges.map(() => [])
    // Work backwards so splitting a node never shifts offsets still to visit.
    for (let at = ranges.length - 1; at >= 0; at--) {
      const range = ranges[at]
      for (const entry of [...nodes].reverse()) {
        const start = Math.max(range.start, entry.start) - entry.start
        const end = Math.min(range.end, entry.end) - entry.start
        if (start >= end) continue
        const selected = entry.node.splitText(start)
        selected.splitText(end - start)
        const mark = owner.createElement('mark')
        mark.className = 'spec-document-match'
        selected.replaceWith(mark)
        mark.appendChild(selected)
        matches[at].unshift(mark)
      }
    }
    selectMatch(0)
  }

  function openFind() {
    if (!current()?.content || current()?.streaming || !find || !input) return
    findOpen = true
    find.hidden = false
    input.focus()
    input.select()
    search()
  }

  function createView(document: SpecDocument): DocumentView {
    const documentHost = owner.createElement('div')
    documentHost.className = 'spec-document-view'
    const body = owner.createElement('div')
    body.className = 'spec-document-body'
    const content = owner.createElement('div')
    content.className = 'plan-review-doc spec-panel-doc spec-document-content'
    const annotations = owner.createElement('div')
    annotations.className = 'spec-annotations hidden'
    body.appendChild(content)
    documentHost.append(body, annotations)
    host?.appendChild(documentHost)
    const handle = options.attachAnnotations(documentHost, content, { sessionId: document.sessionId, path: document.path })
    const observer = new MutationObserver(() => {
      if (disposed) return
      syncAnnotations()
      if (!documentHost.querySelector('.spec-annotate-bubble')) renderContent(document, view)
    })
    const view: DocumentView = { host: documentHost, body, document: content, handle, observer, revision: -1, followBottom: true }
    body.addEventListener('scroll', () => { view.followBottom = isNearSpecBottom(body.scrollHeight, body.clientHeight, body.scrollTop) }, { passive: true })
    observer.observe(documentHost, { childList: true, subtree: true })
    return view
  }

  function renderContent(document: SpecDocument, view: DocumentView) {
    if (view.revision === document.revision || view.host.querySelector('.spec-annotate-bubble')) return
    const shouldFollow = view.followBottom
    if (document.sessionId === sessionId && document.path === path) unmarkSearch()
    view.revision = document.revision
    view.document.innerHTML = options.renderMarkdown(document.content, document.sessionId)
    if (shouldFollow) view.body.scrollTop = view.body.scrollHeight
    if (findOpen && document.sessionId === sessionId && document.path === path) search()
  }

  function syncAnnotations() {
    const view = activeView()
    const total = view?.handle.count() || 0
    if (footer) footer.hidden = total === 0
    const send = button('annotations')
    if (send) { send.disabled = !total || submitting; send.textContent = translate('spec_annotation_add_context') }
  }

  function render() {
    if (!root || disposed) return
    const documents = model.list(sessionId)
    const document = current()
    if (select) {
      const signature = JSON.stringify(documents.map(item => [item.path, item.title]))
      if (select.dataset.signature !== signature) {
        select.replaceChildren(...documents.map(item => {
          const option = owner.createElement('option'); option.value = item.path; option.textContent = item.title; return option
        }))
        select.dataset.signature = signature
      }
      select.value = path
      select.hidden = documents.length < 2
      select.setAttribute('aria-label', translate('spec_documents'))
    }
    if (title) { title.textContent = document?.title || 'Spec'; title.hidden = documents.length > 1 }
    if (empty) { empty.hidden = !!document; empty.textContent = translate('spec_document_empty') }
    for (const [key, view] of views) view.host.hidden = key !== specDocumentKey(sessionId, path)
    if (document) {
      const key = specDocumentKey(sessionId, path)
      let view = views.get(key)
      if (!view) { view = createView(document); views.set(key, view) }
      view.host.hidden = false
      if (document.streaming) closeFind()
      renderContent(document, view)
      showStatus(document.error || (document.streaming ? translate('spec_document_streaming') : ''))
    } else showStatus('')
    const labels: Record<string, string> = { find: 'spec_find', copy: 'spec_copy_markdown', download: 'spec_download', directory: 'spec_open_directory', previous: 'spec_find_previous', next: 'spec_find_next', 'close-find': 'spec_find_close' }
    for (const [action, key] of Object.entries(labels)) button(action)?.setAttribute('aria-label', translate(key))
    for (const action of ['copy', 'download']) { const control = button(action); if (control) control.disabled = !document?.content }
    const findButton = button('find'); if (findButton) findButton.disabled = !document?.content || document.streaming
    const directoryButton = button('directory'); if (directoryButton) directoryButton.disabled = !document
    if (input) { input.placeholder = translate('spec_find_placeholder'); input.setAttribute('aria-label', translate('spec_find')) }
    syncAnnotations()
  }

  async function activate(document: { sessionId: string | null; path: string; title?: string; content?: string; streaming?: boolean }) {
    if (!document.path || disposed) return
    const nextSession = document.sessionId || ''
    const nextPath = model.resolvePath(nextSession, document.path)
    if (sessionId !== nextSession || path !== nextPath) { actionGeneration++; closeFind() }
    sessionId = nextSession
    path = nextPath
    for (const knownPath of options.knownPaths?.(sessionId) || []) model.register(sessionId, knownPath)
    model.register(sessionId, path, {
      ...(document.title ? { title: document.title } : {}),
      ...(document.content !== undefined ? { content: document.content } : {}),
      ...(document.streaming !== undefined ? { streaming: document.streaming } : {}),
    })
    options.openPanel()
    await model.refresh(sessionId, path)
  }

  function clear(closedPath = '') {
    if (closedPath && model.resolvePath(sessionId, closedPath) !== path) return
    actionGeneration++
    closeFind()
    path = ''
    render()
  }

  function setSession(nextSession: string | null) {
    if (sessionId === (nextSession || '')) return
    clear()
    sessionId = nextSession || ''
    for (const knownPath of options.knownPaths?.(sessionId) || []) model.register(sessionId, knownPath)
    render()
  }

  const onClick = async (event: MouseEvent) => {
    const target = (event.target as Element).closest<HTMLButtonElement>('[data-spec-action]')
    if (!target || target.disabled) return
    const action = target.dataset.specAction
    if (action === 'find') { openFind(); return }
    if (action === 'close-find') { closeFind(); return }
    if (action === 'previous' || action === 'next') { selectMatch(matchIndex + (action === 'next' ? 1 : -1)); return }
    const document = current()
    if (!document) return
    const generation = actionGeneration
    try {
      if (action === 'copy') await (options.copyText?.(document.content) || writeClipboardText(document.content))
      if (action === 'directory') await options.openDirectory(document.path)
      if (action === 'download') {
        if (options.downloadFile) await options.downloadFile(specDocumentName(document.path), document.content)
        else {
          const url = URL.createObjectURL(new Blob([document.content], { type: 'text/markdown;charset=utf-8' }))
          const anchor = owner.createElement('a'); anchor.href = url; anchor.download = specDocumentName(document.path)
          owner.body.appendChild(anchor); anchor.click(); anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        }
      }
      if (action === 'annotations') {
        const view = activeView()
        if (!view || submitting) return
        submitting = true; syncAnnotations()
        const accepted = await submitSpecAnnotationDraft(view.handle, items => options.submitAnnotations(items, document.path, document.sessionId))
        if (!accepted && generation === actionGeneration) showStatus(translate('spec_annotation_add_failed'))
      }
    } catch (error) {
      if (generation === actionGeneration) showStatus(error instanceof Error ? error.message : String(error))
    } finally {
      submitting = false
      syncAnnotations()
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!root || !path || root.closest('.artifacts-panel')?.getAttribute('data-mode') !== 'spec' || root.closest('.collapsed')) return
    const selection = owner.getSelection()
    const focusInside = root.contains(event.target as Node) || root.contains(owner.activeElement)
    const inside = focusInside || !!(selection?.rangeCount && root.contains(selection.getRangeAt(0).commonAncestorContainer))
    if (!inside && !findOpen) return
    const findDirection = specFindNavigationDirection(event, { findOpen, focusInside })
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); openFind() }
    else if (findOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind() }
    else if (findDirection !== null) { event.preventDefault(); event.stopPropagation(); selectMatch(matchIndex + findDirection) }
  }

  // The panel's own find bar takes ⌘F while the panel is in the state where
  // `onKeyDown` would claim it; everywhere else the key belongs to the
  // session-search command. The runtime reads this through a window hook so
  // the keybinding gate and this listener can never disagree about who owns
  // the key.
  const ownsFindKey = (): boolean => {
    if (disposed || !root || !path) return false
    if (root.closest('.artifacts-panel')?.getAttribute('data-mode') !== 'spec') return false
    if (root.closest('.collapsed')) return false
    const selection = owner.getSelection()
    const focusInside = root.contains(owner.activeElement)
    const inside = focusInside || !!(selection?.rangeCount && root.contains(selection.getRangeAt(0).commonAncestorContainer))
    return inside || findOpen
  }
  const view = owner.defaultView as (Window & { klausSpecPanelOwnsFind?: () => boolean; klausSpecPanelRunFind?: () => boolean }) | null
  if (view) view.klausSpecPanelOwnsFind = ownsFindKey
  const runFind = (direction?: 'next' | 'previous') => {
    if (!ownsFindKey() || !current()?.content || current()?.streaming) return false
    if (direction) { if (!findOpen) return false; selectMatch(matchIndex + (direction === 'next' ? 1 : -1)) }
    else openFind()
    return true
  }
  if (view) view.klausSpecPanelRunFind = runFind

  const onSelect = () => {
    if (!select?.value) return
    if (options.onDocumentSelected) options.onDocumentSelected(select.value, sessionId)
    else void activate({ sessionId, path: select.value })
  }
  select?.addEventListener('change', onSelect)
  input?.addEventListener('input', search)
  root?.addEventListener('click', onClick)
  owner.addEventListener('keydown', onKeyDown, true)
  owner.defaultView?.addEventListener('klaus:lang-change', render)
  render()
  return {
    activate,
    clear,
    setSession,
    onEvent: (event: SpecDocumentEvent) => model.onEvent(event),
    activePath: () => path,
    documents: (id: string) => model.list(id),
    registerDocument: (id: string, documentPath: string) => {
      if (!disposed && id && documentPath) model.register(id, documentPath)
    },
    subscribeDocuments: (listener: () => void) => {
      documentListeners.add(listener)
      return () => documentListeners.delete(listener)
    },
    dispose() {
      disposed = true
      actionGeneration++
      const view = owner.defaultView as (Window & { klausSpecPanelOwnsFind?: () => boolean; klausSpecPanelRunFind?: () => boolean }) | null
      if (view?.klausSpecPanelOwnsFind === ownsFindKey) delete view.klausSpecPanelOwnsFind
      if (view?.klausSpecPanelRunFind === runFind) delete view.klausSpecPanelRunFind
      documentListeners.clear()
      model.dispose()
      views.forEach(view => { view.observer.disconnect(); view.handle.destroy(); view.host.remove() })
      views.clear()
      select?.removeEventListener('change', onSelect)
      input?.removeEventListener('input', search)
      root?.removeEventListener('click', onClick)
      owner.removeEventListener('keydown', onKeyDown, true)
      owner.defaultView?.removeEventListener('klaus:lang-change', render)
    },
  }
}
