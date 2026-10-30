// App-wide overlay exclusivity: at most one popover/dropdown/menu is open at
// any time. Every transient surface (composer model/permission pickers, plus
// menu, slash menu, sidebar quota popover and user menu, page-level kls-select
// dropdowns) registers a close callback; opening one claims the registry,
// which closes every other registered surface first.
//
// Trigger buttons stopPropagation so a sibling overlay's outside-click close
// never sees the click — that is what let two dropdowns stay open at once.
// Claiming on open closes the others directly instead of relying on the click
// reaching their document listeners.
//
// Closes are synchronous and idempotent, and a surface closing never claims,
// so cascades terminate.

export interface OverlayHandle {
  id: string
  close(): void
}

const overlays = new Map<string, OverlayHandle>()

/** Register (or replace) a surface's close callback. Returns an unregister fn. */
export function registerOverlay(id: string, close: () => void): () => void {
  overlays.set(id, { id, close })
  return () => {
    if (overlays.get(id)?.close === close) overlays.delete(id)
  }
}

export function unregisterOverlay(id: string): void {
  overlays.delete(id)
}

/**
 * Close every registered surface except `id`. Call immediately before setting
 * a surface's own open state.
 */
export function claimOverlay(id: string): void {
  for (const handle of [...overlays.values()]) {
    if (handle.id !== id) handle.close()
  }
}

/** Close every registered surface (e.g. session switch, Escape-all). */
export function closeAllOverlays(): void {
  for (const handle of [...overlays.values()]) handle.close()
}

/** Test/inspection helper: ids currently registered, in registration order. */
export function registeredOverlayIds(): string[] {
  return [...overlays.keys()]
}

let elementIdSeq = 0

/**
 * Stable overlay id per anchor element, so re-mounting a picker onto the same
 * root replaces its registration instead of stacking a second one.
 */
export function overlayIdForElement(el: Element, prefix: string): string {
  const keyed = el as Element & { __klsOverlayId?: string }
  if (!keyed.__klsOverlayId) keyed.__klsOverlayId = `${prefix}-${++elementIdSeq}`
  return keyed.__klsOverlayId
}
