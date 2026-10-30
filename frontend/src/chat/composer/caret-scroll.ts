/**
 * Keep the caret inside the composer's visible box after the app rewrites its
 * content.
 *
 * The composer caps its own height (see `autoResize`) and scrolls internally with
 * a hidden scrollbar. When Chromium performs an edit itself (ordinary typing, a
 * native line break), it scrolls the caret into view as part of the same
 * operation, so the user never sees the caret leave the box. But several paths
 * write the value programmatically instead — shift+Enter, a paste, restoring a
 * draft, undo/redo — and those set the DOM selection directly, which does NOT
 * move the scroll. Once the content is taller than the cap, the caret lands below
 * the visible area and the user has to drag the scrollbar back down to keep
 * typing. This closes that gap.
 *
 * It is deliberately scroll-relative rather than "jump to the bottom": the caret
 * may sit mid-content (the user clicked an earlier line, or undo moved it up), and
 * forcing the bottom there would be jarring. So it measures where the caret
 * actually is and scrolls only as far as needed to bring it back into the padded
 * viewport, in whichever direction.
 */

/** The caret's viewport rect, or null when it cannot be measured. */
function caretClientRect(root: HTMLElement): DOMRect | null {
  const selection = root.ownerDocument?.defaultView?.getSelection?.()
  if (!selection || selection.rangeCount === 0) return null
  const source = selection.getRangeAt(0)
  // Only act when the selection belongs to this editor; the composer is not the
  // focused surface on every `autoResize` call (session switch, window resize).
  if (!root.contains(source.endContainer)) return null
  const caret = source.cloneRange()
  caret.collapse(false)
  const rect = caret.getBoundingClientRect()
  // A collapsed range beside real text reports the caret line's height, so a
  // zero height means the position was not measurable (an empty line, a caret at
  // a bare break). Fall back to the last client rect before giving up.
  if (rect && rect.height > 0) return rect
  const rects = caret.getClientRects()
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    if (rects[index].height > 0) return rects[index]
  }
  return null
}

/**
 * Scroll `root` the minimum distance that brings the caret back into its visible
 * (padding-inset) box. No-op when the composer is not the focused editor, when
 * nothing overflows, or when the caret is already fully visible.
 */
export function scrollCaretIntoView(root: HTMLElement | null | undefined): void {
  if (!root) return
  // Nothing to do unless the content is actually taller than the box.
  if (root.scrollHeight <= root.clientHeight) return

  const style = root.ownerDocument?.defaultView?.getComputedStyle?.(root)
  const padTop = style ? parseFloat(style.paddingTop) || 0 : 0
  const padBottom = style ? parseFloat(style.paddingBottom) || 0 : 0

  const caret = caretClientRect(root)
  if (!caret) {
    // The caret position is not measurable (no selection here, or a caret whose
    // line reports a zero-height rect). Scroll only when the caret can be placed
    // precisely: a guess would be worse than staying put, especially mid-IME,
    // where the composer's input listener also runs this on composition updates.
    return
  }

  const box = root.getBoundingClientRect()
  const viewTop = box.top + padTop
  const viewBottom = box.bottom - padBottom
  // Both rects are viewport-relative, so the overflow delta is independent of the
  // current scroll and one adjustment lands the caret inside the padded box.
  if (caret.bottom > viewBottom) root.scrollTop += caret.bottom - viewBottom
  else if (caret.top < viewTop) root.scrollTop -= viewTop - caret.top
}
