import { useLayoutEffect, useRef } from 'react'

/** Retain stable blocks, text nodes and selection while the live tail changes. */
function reconcileChildren(current: Node, next: Node): void {
  const incoming = [...next.childNodes]
  for (let index = 0; index < incoming.length; index++) {
    const wanted = incoming[index]
    const existing = current.childNodes[index]
    if (!existing) { current.appendChild(wanted); continue }
    if (existing.isEqualNode(wanted)) continue
    if (existing.nodeType !== wanted.nodeType || existing.nodeName !== wanted.nodeName) {
      current.replaceChild(wanted, existing)
      continue
    }
    if (existing.nodeType === 3 || existing.nodeType === 8) {
      const before = existing.nodeValue ?? ''
      const after = wanted.nodeValue ?? ''
      if (existing.nodeType === 3 && after.startsWith(before)) (existing as Text).appendData(after.slice(before.length))
      else existing.nodeValue = after
      continue
    }
    if (existing instanceof Element && wanted instanceof Element) {
      // Media players mount interactive controls beneath their HTML placeholder.
      // Preserve that owned subtree while its media identity remains unchanged.
      if (existing.classList.contains('md-media-player') && wanted.classList.contains('md-media-player')
        && ['kind', 'session', 'path', 'src', 'name'].every(key => existing.getAttribute(`data-media-${key}`) === wanted.getAttribute(`data-media-${key}`))) continue
      for (const attribute of [...existing.attributes]) if (!wanted.hasAttribute(attribute.name)) existing.removeAttribute(attribute.name)
      for (const attribute of [...wanted.attributes]) if (existing.getAttribute(attribute.name) !== attribute.value) existing.setAttribute(attribute.name, attribute.value)
    }
    reconcileChildren(existing, wanted)
  }
  while (current.childNodes.length > incoming.length) current.removeChild(current.lastChild!)
}

export function StreamingHtml({ className, html }: { className: string; html: string }) {
  const root = useRef<HTMLDivElement>(null)
  const initial = useRef({ __html: html })
  const previous = useRef(html)
  useLayoutEffect(() => {
    const element = root.current
    if (!element || previous.current === html) return
    const template = element.ownerDocument.createElement('template')
    template.innerHTML = html
    reconcileChildren(element, template.content)
    previous.current = html
  }, [html])
  return <div className={className} ref={root} dangerouslySetInnerHTML={initial.current} />
}
