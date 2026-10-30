import './user-message-disclosure.css'
import type { ClipboardContent } from '../../clipboard'

const copies = new WeakMap<HTMLElement, ClipboardContent>()
const revealers = new WeakMap<HTMLElement, () => void>()
const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]'
export const USER_MESSAGE_LINES = 20

export function registerUserMessageCopy(root: HTMLElement, content: ClipboardContent): () => void {
  copies.set(root, content)
  return () => { if (copies.get(root) === content) copies.delete(root) }
}
export function userMessageCopyContent(root: HTMLElement): ClipboardContent | undefined { return copies.get(root) }

/** Explicit navigation reveals content before the caller reads its geometry. */
export function revealUserMessageContent(root: HTMLElement): void {
  if (root.matches('[data-user-message-disclosure]')) revealers.get(root)?.()
  root.querySelectorAll<HTMLElement>('[data-user-message-disclosure]').forEach(bubble => revealers.get(bubble)?.())
}

export interface UserMessageExpansion { expandedText: string | null }

/** Measure visual lines while keeping the full body available for selection and copy. */
export function installUserMessageDisclosure(root: HTMLElement, text: string, state: UserMessageExpansion,
  labels: { more: string; less: string }): () => void {
  const bubble = root.querySelector<HTMLElement>('.sent-user-stack > .msg.user')
  if (!bubble) return () => {}
  const document = root.ownerDocument, view = document.defaultView!
  const body = document.createElement('div'), ellipsis = document.createElement('div'), toggle = document.createElement('button')
  body.dataset.userMessageBody = ''
  body.append(...bubble.childNodes)
  ellipsis.dataset.userMessageEllipsis = ''
  ellipsis.textContent = '…'
  ellipsis.setAttribute('aria-hidden', 'true')
  toggle.type = 'button'
  toggle.dataset.userMessageToggle = ''
  bubble.dataset.userMessageDisclosure = ''
  bubble.append(body, ellipsis, toggle)
  const owned = new Map<HTMLElement, string | null>()
  let collapsible = false, lineHeight = 0, printing = false, disposed = false, measureFrame = 0
  const restoreFocus = () => {
    for (const [element, previous] of owned) {
      element.removeAttribute('inert')
      if (previous === null) element.removeAttribute('aria-hidden')
      else element.setAttribute('aria-hidden', previous)
    }
    owned.clear()
  }
  const render = () => {
    const expanded = state.expandedText === text, collapsed = collapsible && !expanded && !printing
    restoreFocus()
    body.style.maxHeight = ''
    body.style.overflow = ''
    if (collapsed) {
      let height = Math.ceil(lineHeight * (USER_MESSAGE_LINES - 1))
      const rect = body.getBoundingClientRect()
      for (const block of body.querySelectorAll<HTMLElement>('[data-markdown-copy="code-block"]:not(pre)')) {
        const blockRect = block.getBoundingClientRect()
        if (blockRect.top - rect.top < height && blockRect.bottom - rect.top > height) height = Math.ceil(blockRect.bottom - rect.top)
      }
      body.style.maxHeight = `${height}px`
      body.style.overflow = 'hidden'
      const bottom = body.getBoundingClientRect().bottom
      for (const element of body.querySelectorAll<HTMLElement>(FOCUSABLE)) {
        if (element.hasAttribute('inert')) continue
        const bounds = element.getBoundingClientRect()
        const visible = bounds.bottom > rect.top && (element.matches('a[href]') ? bounds.top < bottom : bounds.bottom <= bottom + 0.5)
        if (visible) continue
        owned.set(element, element.getAttribute('aria-hidden'))
        element.setAttribute('inert', '')
        element.setAttribute('aria-hidden', 'true')
      }
    }
    ellipsis.hidden = !collapsed
    toggle.hidden = !collapsible || printing
    toggle.textContent = expanded ? labels.less : labels.more
    toggle.setAttribute('aria-expanded', String(expanded))
    bubble.dataset.userMessageCollapsed = String(collapsed)
  }
  const measure = () => {
    if (disposed || body.getBoundingClientRect().width <= 0) return
    const style = view.getComputedStyle(body)
    lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5
    collapsible = Math.ceil(body.scrollHeight) > Math.ceil(lineHeight * USER_MESSAGE_LINES) + 1
    render()
  }
  const reveal = () => { state.expandedText = text; render() }
  const click = (event: MouseEvent) => {
    event.stopPropagation()
    state.expandedText = state.expandedText === text ? null : text
    render()
  }
  const beforePrint = () => { printing = true; render() }
  const afterPrint = () => { printing = false; measure() }
  const selectionChanged = () => {
    if (bubble.dataset.userMessageCollapsed !== 'true') return
    const selection = document.getSelection()
    if (!selection?.rangeCount || !selection.focusNode || !body.contains(selection.focusNode)) return
    const range = selection.getRangeAt(0)
    if (range.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom + 1) reveal()
  }
  const observer = new ResizeObserver(() => {
    if (!measureFrame) measureFrame = view.requestAnimationFrame(() => { measureFrame = 0; measure() })
  })
  observer.observe(body)
  revealers.set(bubble, reveal)
  toggle.addEventListener('click', click)
  bubble.addEventListener('beforematch', reveal)
  document.addEventListener('selectionchange', selectionChanged)
  view.addEventListener('beforeprint', beforePrint)
  view.addEventListener('afterprint', afterPrint)
  measure()
  void document.fonts.ready.then(() => { if (!disposed) measure() })
  return () => {
    disposed = true
    observer.disconnect()
    if (measureFrame) view.cancelAnimationFrame(measureFrame)
    restoreFocus()
    revealers.delete(bubble)
    toggle.removeEventListener('click', click)
    bubble.removeEventListener('beforematch', reveal)
    document.removeEventListener('selectionchange', selectionChanged)
    view.removeEventListener('beforeprint', beforePrint)
    view.removeEventListener('afterprint', afterPrint)
    body.replaceWith(...body.childNodes)
    ellipsis.remove()
    toggle.remove()
    delete bubble.dataset.userMessageDisclosure
    delete bubble.dataset.userMessageCollapsed
  }
}
