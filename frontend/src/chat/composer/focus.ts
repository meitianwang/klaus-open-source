export function focusComposerAfterTurn(input: HTMLElement) {
  const doc = input.ownerDocument
  if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement !== input) return
  try { input.focus({ preventScroll: true }) } catch { input.focus() }
}

/** An idle Escape outside editing returns to the last available composer. */
export function installComposerFocusRecovery(primary: HTMLElement, secondary: () => HTMLElement | null,
  idle: (input: HTMLElement) => boolean): () => void {
  const doc = primary.ownerDocument
  let remembered = primary
  const available = (input: HTMLElement | null): input is HTMLElement => !!input && input.isConnected
    && !input.closest('[inert],[hidden]') && input.getClientRects().length > 0
  const focus = () => {
    const active = doc.activeElement, side = secondary()
    if (active === primary) remembered = primary
    else if (side && active === side) remembered = side
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || !doc.hasFocus()) return
    const target = event.target as Element | null
    if (target?.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""],.cm-editor,.inline-user-edit,.xterm,#terminal-panel,#browser-url-input,[data-composer-escape-boundary]')) return
    const blocking = doc.querySelectorAll<HTMLElement>('[role="dialog"]:not([aria-modal="false"]),[role="menu"],[role="listbox"],.permission-card:not(.permission-resolved)')
    if ([...blocking].some(element => element.getClientRects().length > 0 && doc.defaultView!.getComputedStyle(element).visibility !== 'hidden')) return
    const input = available(remembered) ? remembered : available(primary) ? primary : secondary()
    if (available(input) && idle(input)) input.focus({ preventScroll: true })
  }
  doc.addEventListener('focusin', focus)
  doc.addEventListener('keydown', keydown)
  return () => { doc.removeEventListener('focusin', focus); doc.removeEventListener('keydown', keydown) }
}

export function focusComposerInput(input: HTMLTextAreaElement, selectionStart: number, selectionEnd: number = selectionStart) {
  const win = input.ownerDocument.defaultView
  if (!win) return
  win.setTimeout(() => {
    if (input.ownerDocument.querySelector('[role="dialog"][aria-modal="true"]')) return
    try { input.focus({ preventScroll: true }) } catch { input.focus() }
    win.requestAnimationFrame(() => {
      if (input.ownerDocument.querySelector('[role="dialog"][aria-modal="true"]')) return
      const start = Math.max(0, Math.min(input.value.length, selectionStart))
      const end = Math.max(start, Math.min(input.value.length, selectionEnd))
      try { input.setSelectionRange(start, end) } catch {}
    })
  }, 0)
}
