import type { TextContextEditCommand } from '../../shared/text-context-menu.js'

const INPUT_TEXT = '[data-klaus-document-control="1"]:is(#input,#side-input,.inline-user-edit-input)'
const SUBMITTED_TEXT = '[data-user-message-body],.user-content-reader-text'

type TextMenuOwner = {
  id: string
  root: Element
  revision: string | null
  editable: boolean
  focus: Element | null
  anchor: Node | null
  anchorOffset: number
  head: Node | null
  headOffset: number
}
export interface TextContextMenuOwner {
  capture(): string | null
  current(id: string): boolean
  prepare(id: string, command: TextContextEditCommand): boolean
}
declare global { interface Window { __KLAUS_TEXT_CONTEXT_MENU__?: TextContextMenuOwner } }
let owner: TextMenuOwner | null = null
let observer: MutationObserver | null = null
let pending: { id: string; command: TextContextEditCommand } | null = null
function retire(): void { owner = null; observer?.disconnect(); observer = null }
function current(id: string): boolean {
  const selection = window.getSelection(), captured = owner
  return !!captured && captured.id === id && captured.root.isConnected
    && captured.root.getAttribute('data-klaus-document-revision') === captured.revision
    && (captured.root as HTMLElement).isContentEditable === captured.editable
    && document.activeElement === captured.focus && selection?.anchorNode === captured.anchor
    && selection.anchorOffset === captured.anchorOffset && selection.focusNode === captured.head
    && selection.focusOffset === captured.headOffset
}

/** Existing custom menus win; native text actions belong only to authored content. */
export function handleTextContextMenu(event: MouseEvent): void {
  retire()
  if (event.defaultPrevented) return
  const target = event.target
  const root = target instanceof Element ? target.closest(`${INPUT_TEXT},${SUBMITTED_TEXT}`) : null
  if (!root) { event.preventDefault(); return }
  const selection = window.getSelection()
  if (!selection) { event.preventDefault(); return }
  owner = { id: crypto.randomUUID(), root, revision: root.getAttribute('data-klaus-document-revision'),
    editable: (root as HTMLElement).isContentEditable, focus: document.activeElement,
    anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, head: selection.focusNode, headOffset: selection.focusOffset }
  observer = new MutationObserver(records => {
    if (records.some(record => root.contains(record.target) || Array.from(record.removedNodes).some(node => node.contains(root)))) retire()
  })
  observer.observe(document, { childList: true, characterData: true, subtree: true })
}

/** The host receives an opaque lease, never content or executable renderer input. */
export function installTextContextMenuPolicy(): void {
  window.__KLAUS_TEXT_CONTEXT_MENU__ = { capture: () => owner && current(owner.id) ? owner.id : null, current,
    prepare(id, command) {
      if (!['cut', 'copy', 'paste', 'replaceSpelling'].includes(command) || !current(id)) return false
      pending = { id, command }
      return true
    } }
  const consume = (event: Event) => {
    if (!pending || !(event.type === pending.command || pending.command === 'replaceSpelling'
      && event instanceof InputEvent && event.inputType === 'insertReplacementText')) return
    const allowed = current(pending.id)
    pending = null
    if (!allowed) { event.preventDefault(); event.stopImmediatePropagation() }
  }
  for (const type of ['cut', 'copy', 'paste', 'beforeinput']) document.addEventListener(type, consume, true)
  document.addEventListener('contextmenu', handleTextContextMenu)
  document.addEventListener('keydown', retire, true)
  document.addEventListener('pointerdown', event => { if (event.button !== 2) retire() }, true)
  document.addEventListener('selectionchange', () => { if (owner && !current(owner.id)) retire() })
  document.addEventListener('focusin', () => { if (owner && document.activeElement !== owner.focus) retire() })
}
