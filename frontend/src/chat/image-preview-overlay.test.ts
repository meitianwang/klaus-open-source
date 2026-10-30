import { expect, test } from 'bun:test'

// The lightbox is a DOM overlay while the embedded browser and the Canvas are
// native child views that paint above every HTML layer. Opening the preview
// must ask those runtimes to step aside and closing it must put them back, or
// the page shows through the dimmed backdrop.
type Listener = (event: any) => void

function makeElement(tag: string): any {
  const listeners = new Map<string, Listener[]>()
  const el: any = {
    tagName: tag, className: '', hidden: false, disabled: false, tabIndex: 0, draggable: false,
    style: {}, dataset: {}, textContent: '', innerHTML: '', alt: '', src: '',
    children: [] as any[], parentNode: undefined as any, isConnected: true,
    clientWidth: 800, clientHeight: 600, naturalWidth: 1600, naturalHeight: 1200,
    classList: {
      set: new Set<string>(),
      add(name: string) { this.set.add(name) },
      remove(name: string) { this.set.delete(name) },
      contains(name: string) { return this.set.has(name) },
      toggle(name: string, on?: boolean) {
        const want = on === undefined ? !this.set.has(name) : on
        if (want) this.set.add(name); else this.set.delete(name)
        return want
      },
    },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null },
    appendChild(child: any) { el.children.push(child); child.parentNode = el; return child },
    append(...kids: any[]) { for (const kid of kids) el.appendChild(kid) },
    remove() {
      if (!el.parentNode) return
      el.parentNode.children = el.parentNode.children.filter((child: any) => child !== el)
      el.parentNode = undefined
    },
    addEventListener(type: string, cb: Listener) { listeners.set(type, [...(listeners.get(type) || []), cb]) },
    removeEventListener(type: string, cb: Listener) { listeners.set(type, (listeners.get(type) || []).filter(fn => fn !== cb)) },
    dispatch(type: string, extra: Record<string, unknown> = {}) {
      const event = { target: el, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra }
      for (const cb of [...(listeners.get(type) || [])]) cb(event)
    },
    querySelector() { return null }, querySelectorAll() { return [] },
    focus() {}, blur() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
  }
  return el
}

test('the image preview suspends native child views while open and resumes on close', async () => {
  const names = ['window', 'document', 'ResizeObserver'] as const
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const counts = { browserSuspend: 0, browserResume: 0, canvasSuspend: 0, canvasResume: 0, prototypeSuspend: 0, prototypeResume: 0, videoSuspend: 0, videoResume: 0 }
  const body = makeElement('body')
  const documentListeners = new Map<string, Listener[]>()
  const values = {
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      klausSuspendBrowserForOverlay: async () => { counts.browserSuspend++ },
      klausResumeBrowserAfterOverlay: async () => { counts.browserResume++ },
      klausSuspendCanvasForOverlay: async () => { counts.canvasSuspend++ },
      klausResumeCanvasAfterOverlay: async () => { counts.canvasResume++ },
      klausSuspendPrototypeForOverlay: async () => { counts.prototypeSuspend++ },
      klausResumePrototypeAfterOverlay: async () => { counts.prototypeResume++ },
      klausSuspendVideoEditingForOverlay: async () => { counts.videoSuspend++ },
      klausResumeVideoEditingAfterOverlay: async () => { counts.videoResume++ },
    },
    document: {
      body,
      hidden: false,
      activeElement: null,
      createElement: (tag: string) => makeElement(tag),
      querySelector: () => null,
      addEventListener(type: string, cb: Listener) { documentListeners.set(type, [...(documentListeners.get(type) || []), cb]) },
      removeEventListener(type: string, cb: Listener) { documentListeners.set(type, (documentListeners.get(type) || []).filter(fn => fn !== cb)) },
    },
    ResizeObserver: class { observe() {} disconnect() {} },
  }
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] })
    // A query string gives this suite its own module instance, so its viewer
    // registry cannot leak into sibling suites that import the same module.
    const surface = await import('./image-preview?suite=overlay')
    surface.openImagePreview('https://example.invalid/shot.png', {})
    expect(counts).toEqual({ browserSuspend: 1, browserResume: 0, canvasSuspend: 1, canvasResume: 0, prototypeSuspend: 1, prototypeResume: 0, videoSuspend: 1, videoResume: 0 })
    const overlay = body.children.at(-1)
    expect(overlay?.className).toBe('image-lightbox')
    // Clicking the dimmed backdrop closes the preview.
    overlay.dispatch('click')
    expect(counts).toEqual({ browserSuspend: 1, browserResume: 1, canvasSuspend: 1, canvasResume: 1, prototypeSuspend: 1, prototypeResume: 1, videoSuspend: 1, videoResume: 1 })
    expect(body.children).toHaveLength(0)
    // A later preview suspends again instead of inheriting a stale release.
    surface.openImagePreview('https://example.invalid/second.png', {})
    expect(counts).toEqual({ browserSuspend: 2, browserResume: 1, canvasSuspend: 2, canvasResume: 1, prototypeSuspend: 2, prototypeResume: 1, videoSuspend: 2, videoResume: 1 })
    // Escape reaches the modal viewer's capture-phase key handler and closes too.
    for (const cb of documentListeners.get('keydown') || []) {
      cb({ key: 'Escape', defaultPrevented: false, isComposing: false, preventDefault() {}, stopPropagation() {}, target: body })
    }
    expect(counts).toEqual({ browserSuspend: 2, browserResume: 2, canvasSuspend: 2, canvasResume: 2, prototypeSuspend: 2, prototypeResume: 2, videoSuspend: 2, videoResume: 2 })
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
