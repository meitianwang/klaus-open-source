// Tab is reserved for the focused surface's own behavior. It must never move
// keyboard focus to another control, which is why the browser's sequential
// focus traversal is cancelled for every renderer window.
//
// Handlers that already own Tab (accepting a composer suggestion, indenting in
// an editor, closing a menu) still receive the event. Focus calls made from
// those handlers while the Tab keydown is being processed are ignored, so a
// focus trap cannot move focus either.

let installed = false
let tabKeydownDepth = 0
let tabKeydownGeneration = 0
let originalFocus: HTMLElement['focus'] | null = null

export function isTabFocusTraversal(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey
}

function suppressFocusDuringTab(): void {
  if (typeof HTMLElement === 'undefined' || originalFocus) return
  originalFocus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions): void {
    if (tabKeydownDepth > 0) return
    originalFocus?.call(this, options)
  }
}

function releaseTabKeydown(): void {
  tabKeydownDepth = 0
  tabKeydownGeneration += 1
}

export function installTabFocusPolicy(target: Window = window): () => void {
  if (installed) return () => {}
  installed = true
  suppressFocusDuringTab()
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isTabFocusTraversal(event)) return
    event.preventDefault()
    tabKeydownDepth += 1
    // Release after the event has travelled through the tree. The timeout is a
    // fallback for synthetic keydowns that never receive a keyup.
    const generation = ++tabKeydownGeneration
    setTimeout(() => { if (generation === tabKeydownGeneration) releaseTabKeydown() }, 0)
  }
  const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'Tab') releaseTabKeydown() }
  const onKeyDownBubble = () => { releaseTabKeydown() }
  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('keydown', onKeyDownBubble)
  target.addEventListener('keyup', onKeyUp, true)
  return () => {
    target.removeEventListener('keydown', onKeyDown, true)
    target.removeEventListener('keydown', onKeyDownBubble)
    target.removeEventListener('keyup', onKeyUp, true)
    if (originalFocus && typeof HTMLElement !== 'undefined') HTMLElement.prototype.focus = originalFocus
    originalFocus = null
    tabKeydownDepth = 0
    installed = false
  }
}
