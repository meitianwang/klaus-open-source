// Native child WebContentsViews step aside for every modal or full-window overlay.
//
// Embedded surfaces (Browser, Canvas, Prototype, VideoEditing, Ppt, Design, PhotoEditing, MotionGraphics, EquityResearch) are
// host-owned WebContentsViews. They paint above every HTML layer of this window,
// so an overlay's backdrop or dialog card cannot cover them with z-index: the
// native surface stays sharp on top of the window and slices the dialog in half.
// Each surface exposes counted suspend/resume hooks; this module holds exactly
// one lease on all of them while any modal or opt-in overlay is visible.
//
// Overlays come from many producers (the command menu, the shared confirm dialog,
// React portals, hand-built overlays, native <dialog>, drag-drop targets, and
// wide popovers marked with data-klaus-native-suspend), so they are recognised
// by their DOM markers instead of asking every producer to wire the hooks.

export const NATIVE_OVERLAY_SELECTOR = [
  '[aria-modal="true"]',
  'dialog[open]',
  '.klaus-dialog-overlay',
  '.kls-modal-overlay',
  '.klaus-inline-vis-backdrop',
  '.drop-overlay.active',
  '[data-klaus-native-suspend]',
].join(',')

const SURFACE_HOOKS: ReadonlyArray<readonly [suspend: string, resume: string]> = [
  ['klausSuspendBrowserForOverlay', 'klausResumeBrowserAfterOverlay'],
  ['klausSuspendCanvasForOverlay', 'klausResumeCanvasAfterOverlay'],
  ['klausSuspendPrototypeForOverlay', 'klausResumePrototypeAfterOverlay'],
  ['klausSuspendVideoEditingForOverlay', 'klausResumeVideoEditingAfterOverlay'],
  ['klausSuspendPptForOverlay', 'klausResumePptAfterOverlay'],
  ['klausSuspendDesignForOverlay', 'klausResumeDesignAfterOverlay'],
  ['klausSuspendPhotoEditingForOverlay', 'klausResumePhotoEditingAfterOverlay'],
  ['klausSuspendMotionGraphicsForOverlay', 'klausResumeMotionGraphicsAfterOverlay'],
  ['klausSuspendEquityResearchForOverlay', 'klausResumeEquityResearchAfterOverlay'],
]

type Hook = () => unknown
type HookHost = Record<string, unknown>

export interface NativeOverlayGuardEnvironment {
  root: Element
  host: HookHost
  /** Runs the callback before the next paint; one pending evaluation at a time. */
  schedule(callback: () => void): void
  visible(element: Element): boolean
}

export interface NativeOverlayGuard {
  /** Re-read the DOM now. Exposed for tests and diagnostics. */
  evaluate(): boolean
  held(): boolean
  dispose(): void
}

function elementVisible(element: Element): boolean {
  if (!element.isConnected) return false
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility
  if (typeof check === 'function') return check.call(element)
  return element.getClientRects().length > 0
}

export function createNativeOverlayGuard(env: NativeOverlayGuardEnvironment): NativeOverlayGuard {
  // Elements that are, or once were, modal overlays. Checking these few nodes
  // keeps the per-frame cost independent of the transcript's size.
  const candidates = new Set<Element>()
  let resumes: Hook[] | null = null
  let scheduled = false
  let disposed = false

  const collect = (node: Node): boolean => {
    if (node.nodeType !== 1) return false
    const element = node as Element
    let found = false
    if (element.matches(NATIVE_OVERLAY_SELECTOR)) { candidates.add(element); found = true }
    if (element.firstElementChild) {
      for (const match of element.querySelectorAll(NATIVE_OVERLAY_SELECTOR)) { candidates.add(match); found = true }
    }
    return found
  }

  const acquire = () => {
    resumes = []
    for (const [suspend, resume] of SURFACE_HOOKS) {
      const enter = env.host[suspend], leave = env.host[resume]
      // Only a surface that was actually suspended may be resumed later: its
      // counter is shared with other overlays (the image preview, panel menus).
      if (typeof enter !== 'function' || typeof leave !== 'function') continue
      resumes.push(leave as Hook)
      try { void (enter as Hook)() } catch { /* a surface that fails to step aside must not block the others */ }
    }
  }

  const release = () => {
    const leaving = resumes || []
    resumes = null
    for (const leave of leaving) {
      try { void leave() } catch { /* the remaining surfaces still come back */ }
    }
  }

  const evaluate = (): boolean => {
    let open = false
    for (const element of candidates) {
      // A closed <dialog> or a reused node that lost its marker stops being a
      // candidate; it returns through the attribute record that re-marks it.
      if (!element.isConnected || !element.matches(NATIVE_OVERLAY_SELECTOR)) { candidates.delete(element); continue }
      if (!open && env.visible(element)) open = true
    }
    if (open && !resumes) acquire()
    else if (!open && resumes) release()
    return open
  }

  const request = () => {
    if (scheduled || disposed) return
    scheduled = true
    env.schedule(() => {
      scheduled = false
      if (!disposed) evaluate()
    })
  }

  const observer = new MutationObserver(records => {
    let relevant = false
    for (const record of records) {
      if (record.type === 'childList') {
        if (record.removedNodes.length && candidates.size) relevant = true
        for (const node of record.addedNodes) if (collect(node)) relevant = true
      } else if (record.type === 'attributes') {
        const target = record.target as Element
        if (target.matches(NATIVE_OVERLAY_SELECTOR)) { candidates.add(target); relevant = true }
        // A known overlay lost its marker, or an ancestor's class or hidden
        // flag showed or hid one. Unrelated attribute churn stays free.
        else if (!relevant) for (const element of candidates) if (target.contains(element)) { relevant = true; break }
      }
    }
    if (relevant) request()
  })
  observer.observe(env.root, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'open', 'aria-modal', 'data-klaus-native-suspend'],
  })
  for (const match of env.root.querySelectorAll(NATIVE_OVERLAY_SELECTOR)) candidates.add(match)
  if (candidates.size) request()

  return {
    evaluate,
    held: () => resumes !== null,
    dispose() {
      if (disposed) return
      disposed = true
      observer.disconnect()
      if (resumes) release()
      candidates.clear()
    },
  }
}

let mounted: NativeOverlayGuard | null = null

export function mountNativeOverlayGuard(): NativeOverlayGuard | null {
  if (mounted) return mounted
  if (typeof document === 'undefined' || typeof document.body?.querySelectorAll !== 'function'
    || typeof MutationObserver === 'undefined' || typeof requestAnimationFrame !== 'function') return null
  mounted = createNativeOverlayGuard({
    root: document.body,
    host: window as unknown as HookHost,
    schedule: callback => { requestAnimationFrame(() => callback()) },
    visible: elementVisible,
  })
  return mounted
}

mountNativeOverlayGuard()
