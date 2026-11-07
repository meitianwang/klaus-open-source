export type SidePanePlacement = 'left' | 'right'

export const sidePanePlacements: readonly SidePanePlacement[] = ['left', 'right']

export function sidePaneElementId(id: string, placement: SidePanePlacement): string {
  return placement === 'left' && id.startsWith('side-') ? `left-${id}` : id
}

/** Keep composer-local selectors stable while each mounted pane owns unique ids. */
export function sidePaneDocument(document: Document, placement: SidePanePlacement): Document {
  if (placement === 'right') return document
  return new Proxy(document, {
    get(target, property) {
      if (property === 'getElementById') return (id: string) => target.getElementById(
        id === 'artifacts-panel' ? 'left-side-chat-panel' : sidePaneElementId(id, placement),
      )
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Rename after mounting so shared composer initialization can use its local selectors. */
export function identifySidePaneComposer(root: HTMLElement, placement: SidePanePlacement): void {
  if (placement === 'right') return
  const nodes = [root, ...root.querySelectorAll<HTMLElement>('[id]')]
  const renamed = new Map(nodes.filter(node => node.id).map(node => [node.id, sidePaneElementId(node.id, placement)]))
  for (const node of nodes) {
    if (node.id) node.id = renamed.get(node.id)!
    for (const attribute of ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby']) {
      const value = node.getAttribute(attribute)
      if (value) node.setAttribute(attribute, value.split(/\s+/).map(id => renamed.get(id) ?? sidePaneElementId(id, placement)).join(' '))
    }
  }
  root.dataset.sidePane = placement
}

/** Route pane-local composer hooks without copying or rebinding native window state. */
export function sidePaneWindow(window: Window, hooks: Record<string, unknown>): Window {
  return new Proxy(window, {
    get(target, property) {
      if (typeof property === 'string' && property in hooks) return hooks[property]
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value) {
      if (typeof property === 'string' && /^klaus(?:Side|UpdateSide)/.test(property)) {
        hooks[property] = value
        return true
      }
      return Reflect.set(target, property, value, target)
    },
  })
}

/** A session belongs to one pane, while both panes may retain independent active sessions. */
export function createSidePanePlacement() {
  const placementBySession = new Map<string, SidePanePlacement>()
  const active: Record<SidePanePlacement, string | null> = { left: null, right: null }
  return {
    placement: (id: string): SidePanePlacement => placementBySession.get(id) ?? 'right',
    active: (pane: SidePanePlacement): string | null => active[pane],
    activate(id: string, pane: SidePanePlacement) {
      const previous = placementBySession.get(id)
      if (previous && previous !== pane && active[previous] === id) active[previous] = null
      placementBySession.set(id, pane)
      active[pane] = id
    },
    clear(pane?: SidePanePlacement) {
      for (const target of pane ? [pane] : sidePanePlacements) active[target] = null
    },
    remove(id: string) {
      placementBySession.delete(id)
      for (const pane of sidePanePlacements) if (active[pane] === id) active[pane] = null
    },
  }
}
