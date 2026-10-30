import type { Fragment, Slice } from 'prosemirror-model'

export const CLIPBOARD_HIDDEN_LINK_LIMIT = 5_000

export function clipboardVisibleText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, '\n', node => node.type.name === 'hard_break' ? '\n' : node.type.spec.leafText?.(node) ?? '')
}

/** Count a linked text run once even when its other formatting marks change. */
export function clipboardHiddenLinkLength(content: Fragment): number {
  let total = 0
  let pending: { end: number; href: string; title: string | null; text: string } | null = null
  const flush = () => {
    if (pending) total += (pending.text.includes(pending.href) ? 0 : pending.href.length) + (pending.title?.length || 0)
    pending = null
  }
  content.descendants((node, position) => {
    if (node.type.spec.code || node.isAtom && !node.isText) { flush(); return false }
    if (!node.isText) return
    const link = node.marks.find(mark => mark.type.name === 'link')
    const href = link?.attrs.href
    if (typeof href !== 'string' || !href) { flush(); return }
    const title = typeof link?.attrs.title === 'string' ? link.attrs.title : null
    if (pending?.href === href && pending.title === title && pending.end === position) {
      pending.text += node.text
      pending.end = position + node.nodeSize
    } else {
      flush()
      pending = { end: position + node.nodeSize, href, title, text: node.text || '' }
    }
  })
  flush()
  return total
}

/** Excess hidden external link data falls back to the available visible text. */
export function clipboardLinkFallback(slice: Slice, plain: string): string | null {
  const hidden = clipboardHiddenLinkLength(slice.content), visible = clipboardVisibleText(slice)
  return hidden >= CLIPBOARD_HIDDEN_LINK_LIMIT && hidden >= Math.max(plain.length, visible.length) ? plain || visible : null
}
