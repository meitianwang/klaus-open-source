// Harness entry: exposes the real sidebar module plus a mount helper. React
// commits settle on tasks after setState, so the helper polls until the target
// rows exist. Actions live in the root render, so a changed actions object
// forces a fresh root (a second createRoot on the same node never commits —
// the old node is replaced first).
import { mountSidebar, type SidebarSnapshot, type SidebarActions, type SidebarApi } from './session-list'

const roots = new WeakMap<HTMLElement, { api: SidebarApi; actions: SidebarActions }>()

export function mountSync(rootEl: HTMLElement, snapshot: SidebarSnapshot, actions: SidebarActions) {
  const previous = roots.get(rootEl)
  if (previous && previous.actions === actions) {
    previous.api.render(snapshot)
    return new Promise(resolve => { setTimeout(resolve, 0) })
  }
  // Actions changed (or first mount): replace the node so a fresh createRoot is
  // legal, then mount the real sidebar into it.
  const fresh = rootEl.cloneNode(false) as HTMLElement
  rootEl.replaceWith(fresh)
  if (fresh.id !== rootEl.id) fresh.id = rootEl.id
  const api = mountSidebar({ rootEl: fresh, actions })
  if (!api) throw new Error('harness mount: no rootEl')
  roots.set(fresh, { api, actions })
  roots.delete(rootEl)
  api.render(snapshot)
  return new Promise(resolve => { setTimeout(resolve, 0) })
}
