import { rawIconHtml } from '../components/Icon'
import { t } from '../i18n'
import type { QuoteSourceMetadata } from './selected-text-envelope'

export interface PanelQuoteCandidate {
  text: string
  source?: QuoteSourceMetadata
  previewText?: string
  anchorRect?: DOMRect
}

export interface PanelQuoteToolbarOptions {
  resolveSelection(selection: Selection, range: Range): PanelQuoteCandidate | null
  resolveCurrent?: () => PanelQuoteCandidate | null
  canClearSelection?: () => boolean
  copySelection?: (text: string) => void
  secondaryAction?: { label: () => string; iconName?: string; onTrigger(candidate: PanelQuoteCandidate, anchorRect: DOMRect): void }
  clearSelectionOnInsert?: boolean
}

type MenuItem = { label: string; iconName?: string; onSelect: () => void }

function actionButton(doc: Document, label: string, iconName?: string): HTMLButtonElement {
  const button = doc.createElement('button')
  button.type = 'button'
  if (iconName) button.innerHTML = rawIconHtml(iconName)
  button.append(label)
  return button
}

function position(element: HTMLElement, x: number, y: number): void {
  const win = element.ownerDocument.defaultView!
  element.style.left = `${Math.max(8, Math.min(x, win.innerWidth - element.offsetWidth - 8))}px`
  element.style.top = `${Math.max(8, Math.min(y, win.innerHeight - element.offsetHeight - 8))}px`
}

let closeCurrentMenu: (() => void) | undefined
function showMenu(event: MouseEvent, items: MenuItem[]): () => void {
  closeCurrentMenu?.()
  if (!items.length) return () => {}
  const doc = (event.target as Node | null)?.ownerDocument || document
  const win = doc.defaultView!
  event.preventDefault()
  const menu = doc.createElement('div')
  menu.className = 'workspace-context-menu kls-panel-quote-menu'
  menu.setAttribute('role', 'menu')
  const lifetime = new AbortController()
  const { signal } = lifetime
  const close = () => {
    lifetime.abort()
    menu.remove()
    if (closeCurrentMenu === close) closeCurrentMenu = undefined
  }
  closeCurrentMenu = close
  for (const item of items) {
    const button = actionButton(doc, item.label, item.iconName)
    button.className = 'workspace-context-menu-item'
    button.setAttribute('role', 'menuitem')
    button.addEventListener('click', () => { close(); item.onSelect() }, { signal })
    menu.append(button)
  }
  menu.addEventListener('mousedown', e => e.preventDefault(), { signal })
  doc.addEventListener('pointerdown', e => { if (!menu.contains(e.target as Node)) close() }, { capture: true, signal })
  doc.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const buttons = Array.from(menu.querySelectorAll('button'))
    const index = buttons.indexOf(doc.activeElement as HTMLButtonElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : (index + (e.key === 'ArrowDown' ? 1 : index < 0 ? 0 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus({ preventScroll: true })
  }, { capture: true, signal })
  win.addEventListener('scroll', close, { capture: true, signal })
  win.addEventListener('blur', close, { signal })
  doc.body.append(menu)
  position(menu, event.clientX, event.clientY)
  menu.querySelector('button')?.focus({ preventScroll: true })
  return close
}

export function openPanelQuoteContextMenu(event: MouseEvent, items: MenuItem[]): void {
  showMenu(event, items)
}

export function containsComposed(container: Node, node: Node | null): boolean {
  for (let current = node; current; current = current.parentNode || (current.getRootNode() as ShadowRoot).host || null) {
    if (current === container) return true
  }
  return false
}

export function openShadowRoots(container: ParentNode): ShadowRoot[] {
  const roots: ShadowRoot[] = []
  const visit = (element: Element) => {
    if (!element.shadowRoot) return
    roots.push(element.shadowRoot)
    element.shadowRoot.querySelectorAll('*').forEach(visit)
  }
  if ('shadowRoot' in container) visit(container as Element)
  container.querySelectorAll('*').forEach(visit)
  return roots
}

export function panelDomSelection(container: HTMLElement): { selection: Selection; range: Range } | null {
  const doc = container.ownerDocument
  const selection = doc.getSelection()
  if (!selection) return null
  const inside = (range: Range | StaticRange) => containsComposed(container, range.startContainer) && containsComposed(container, range.endContainer)
  const range = selection.rangeCount ? selection.getRangeAt(0) : null
  if (range && inside(range) && !range.collapsed) return { selection, range }
  const roots = openShadowRoots(container)
  for (const root of roots) {
    const local = (root as ShadowRoot & { getSelection?(): Selection | null }).getSelection?.()
    if (local && !local.isCollapsed && local.rangeCount && inside(local.getRangeAt(0))) return { selection: local, range: local.getRangeAt(0) }
  }
  const composed = selection.getComposedRanges?.({ shadowRoots: roots })[0]
  if (!composed || composed.collapsed || !inside(composed)) return null
  const resolved = doc.createRange()
  resolved.setStart(composed.startContainer, composed.startOffset)
  resolved.setEnd(composed.endContainer, composed.endOffset)
  return resolved.collapsed ? null : { selection, range: resolved }
}

export function attachPanelQuoteToolbar(container: HTMLElement, options: PanelQuoteToolbarOptions): (() => void) & { refresh(): void } {
  const doc = container.ownerDocument
  const win = doc.defaultView!
  const lifetime = new AbortController()
  const { signal } = lifetime
  const bar = doc.createElement('div')
  bar.className = 'kls-panel-quote-toolbar'
  bar.setAttribute('role', 'toolbar')
  let closeMenu: (() => void) | undefined
  const hide = () => bar.remove()
  const read = () => {
    const current = options.resolveCurrent?.()
    const dom = current?.anchorRect ? null : panelDomSelection(container)
    const candidate = current || (dom && options.resolveSelection(dom.selection, dom.range))
    if (!candidate?.text.trim()) return null
    return { candidate, rect: candidate.anchorRect || dom?.range.getBoundingClientRect() || container.getBoundingClientRect(), selection: dom?.selection }
  }
  const actions = ({ candidate, rect, selection }: NonNullable<ReturnType<typeof read>>): MenuItem[] => {
    const items: MenuItem[] = [{ label: t('panel_quote_add_to_chat'), iconName: 'quoted-text', onSelect: () => {
      if (options.clearSelectionOnInsert !== false && options.canClearSelection?.() !== false) (selection || doc.getSelection())?.removeAllRanges()
      win.klausQuoteAddToChat?.(candidate.text, { source: candidate.source, previewText: candidate.previewText })
    } }]
    const secondary = options.secondaryAction
    if (secondary) items.push({ label: secondary.label(), iconName: secondary.iconName, onSelect: () => secondary.onTrigger(candidate, rect) })
    return items
  }
  const dispose = () => { lifetime.abort(); hide(); closeMenu?.() }
  const update = () => {
    if (!container.isConnected) { dispose(); return }
    const selection = read()
    if (!selection) { hide(); return }
    const { rect } = selection
    if ((!rect.width && !rect.height) || rect.bottom < 0 || rect.top > win.innerHeight) { hide(); return }
    const focusIndex = Array.from(bar.querySelectorAll('button')).indexOf(doc.activeElement as HTMLButtonElement)
    bar.replaceChildren()
    actions(selection).forEach((item, index) => {
      if (index) {
        const divider = doc.createElement('span')
        divider.className = 'kls-panel-quote-divider'
        bar.append(divider)
      }
      const button = actionButton(doc, item.label, item.iconName)
      button.className = 'kls-panel-quote-btn'
      button.addEventListener('click', () => { hide(); item.onSelect() })
      bar.append(button)
    })
    if (!bar.isConnected) doc.body.append(bar)
    position(bar, (rect.left + rect.right - bar.offsetWidth) / 2, rect.top < 44 ? rect.bottom + 8 : rect.top - bar.offsetHeight - 8)
    if (focusIndex >= 0) bar.querySelectorAll('button')[focusIndex]?.focus({ preventScroll: true })
  }
  bar.addEventListener('mousedown', e => e.preventDefault(), { signal })
  doc.addEventListener('selectionchange', update, { signal })
  container.addEventListener('pointerup', update, { signal })
  container.addEventListener('keyup', update, { signal })
  container.addEventListener('contextmenu', event => {
    if (event.defaultPrevented) return
    const selection = read()
    if (!selection) return
    hide()
    const items = actions(selection)
    if (options.copySelection) items.push({ label: t('panel_quote_copy'), onSelect: () => options.copySelection?.(selection.candidate.text) })
    closeMenu = showMenu(event, items)
  }, { signal })
  doc.addEventListener('pointerdown', e => { if (!container.isConnected) dispose(); else if (!bar.contains(e.target as Node)) hide() }, { capture: true, signal })
  doc.addEventListener('keydown', e => {
    if (e.key === 'Escape' && bar.isConnected) { e.preventDefault(); e.stopPropagation(); hide() }
  }, { capture: true, signal })
  win.addEventListener('scroll', hide, { capture: true, signal })
  win.addEventListener('blur', hide, { signal })
  if (container.isConnected) update()
  return Object.assign(dispose, { refresh: update })
}
