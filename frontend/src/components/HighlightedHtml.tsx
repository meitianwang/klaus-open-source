import { useImperativeHandle, useLayoutEffect, useRef, type ComponentPropsWithRef } from 'react'

function codeUnit(code: Element): Element {
  const pre = code.parentElement!
  const wrapper = pre.parentElement
  return wrapper?.querySelector(':scope > button.code-copy') ? wrapper : pre
}

function copyAttributes(current: Element, before: Element, next: Element): void {
  for (const attribute of [...before.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
  for (const attribute of [...next.attributes]) current.setAttribute(attribute.name, attribute.value)
}

function copyLanguageBadge(current: Element, next: Element): void {
  const badge = [...current.children].find(child => child.tagName === 'SPAN')
  const wanted = [...next.children].find(child => child.tagName === 'SPAN')
  if (badge && wanted) { copyAttributes(badge, badge, wanted); badge.textContent = wanted.textContent }
  else if (badge) badge.remove()
  else if (wanted) current.insertBefore(wanted.cloneNode(true), current.querySelector(':scope > button.code-copy'))
}

/** Upgrade only highlighting when the underlying message structure is unchanged. */
function upgradeHighlights(root: HTMLElement, before: string, next: string): boolean {
  const previous = root.ownerDocument.createElement('template')
  const incoming = root.ownerDocument.createElement('template')
  previous.innerHTML = before
  incoming.innerHTML = next
  const oldCodes = [...previous.content.querySelectorAll('pre > code')]
  const newCodes = [...incoming.content.querySelectorAll('pre > code')]
  const mountedCodes = [...root.querySelectorAll('pre > code')]
  if (!oldCodes.length || oldCodes.length !== newCodes.length || oldCodes.length !== mountedCodes.length) return false
  const units = oldCodes.map((code, index) => ({ before: codeUnit(code), next: codeUnit(newCodes[index]), wrapped: codeUnit(code) !== code.parentElement }))
  if (oldCodes.some((code, index) => code.textContent !== newCodes[index].textContent || code.textContent !== mountedCodes[index].textContent)) return false
  for (let index = 0; index < oldCodes.length; index++) {
    oldCodes[index].replaceWith(newCodes[index].cloneNode(true))
    if (units[index].wrapped) copyLanguageBadge(units[index].before, units[index].next)
  }
  if (!previous.content.isEqualNode(incoming.content)) return false

  // A worker reply may arrive while code is selected. Keep its text offsets
  // while spans and an automatically detected language badge are updated.
  const selection = root.ownerDocument.getSelection()
  const capture = (node: Node | null, offset: number) => {
    const code = mountedCodes.find(element => node && element.contains(node))
    if (!node || !code) return { node, offset, code: undefined }
    const range = root.ownerDocument.createRange()
    range.setStart(code, 0)
    range.setEnd(node, offset)
    return { node, offset: range.toString().length, code }
  }
  const anchor = capture(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0)
  const focus = capture(selection?.focusNode ?? null, selection?.focusOffset ?? 0)
  for (let index = 0; index < mountedCodes.length; index++) {
    const code = mountedCodes[index], wanted = newCodes[index]
    copyAttributes(code, oldCodes[index], wanted)
    code.innerHTML = wanted.innerHTML
    const unit = codeUnit(code)
    if (unit === code.parentElement) continue
    copyLanguageBadge(unit, units[index].next)
  }
  const restore = (point: ReturnType<typeof capture>): [Node | null, number] => {
    if (!point.code) return [point.node, point.offset]
    const walker = root.ownerDocument.createTreeWalker(point.code, 4)
    let remaining = point.offset
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (remaining <= (node.nodeValue?.length ?? 0)) return [node, remaining]
      remaining -= node.nodeValue?.length ?? 0
    }
    return [point.code, point.code.childNodes.length]
  }
  if (selection && (anchor.code || focus.code)) {
    const [anchorNode, anchorOffset] = restore(anchor), [focusNode, focusOffset] = restore(focus)
    if (anchorNode?.isConnected && focusNode?.isConnected) selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
  }
  return true
}

/** Keep mounted players, pages and controls intact across an async highlight. */
export function HighlightedHtml({ html, ref, ...props }: { html: string } & Omit<ComponentPropsWithRef<'div'>, 'children' | 'dangerouslySetInnerHTML'>) {
  const root = useRef<HTMLDivElement>(null)
  const initial = useRef({ __html: html })
  const previous = useRef(html)
  useImperativeHandle(ref, () => root.current!, [])
  useLayoutEffect(() => {
    const element = root.current
    if (!element || previous.current === html) return
    if (!upgradeHighlights(element, previous.current, html)) element.innerHTML = html
    previous.current = html
  }, [html])
  return <div {...props} ref={root} dangerouslySetInnerHTML={initial.current} />
}
