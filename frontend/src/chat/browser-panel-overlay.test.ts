import { expect, test } from 'bun:test'

test('nested overlays keep the native view suspended until the last one closes', async () => {
  // The image preview can host its own menu: the inner overlay closes first and
  // must not bring the native view back under the still-open preview.
  const names = ['window', 'document', 'requestAnimationFrame', 'ResizeObserver'] as const
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const frames: FrameRequestCallback[] = []
  let mode = 'browser', shows = 0, hides = 0, mounted = false
  // focusRevision stays below the watermark any sibling suite may have left on
  // the module-level frame scope: this suite only exercises the overlay hooks.
  const state = { conversationId: 'manual', focusRevision: 0, enabled: true, visible: false, tabs: [{ id: 'first' }] }
  let publish!: (next: typeof state) => void
  let finishShow!: () => void
  const pending = new Promise<void>(resolve => { finishShow = resolve })
  const panel = { getAttribute: () => mode, classList: { contains: () => false } }
  const host = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 600 }),
    classList: { contains: () => mounted, toggle: (_name: string, value: boolean) => { mounted = value } },
  }
  const values = {
    window: {
      addEventListener: () => {},
      klaus: {
        settings: { browserUse: { get: async () => ({ enabled: true }) } },
        browserUse: {
          state: async () => state,
          show: async () => {
            shows++
            await pending
            const visible = { ...state, visible: true }
            publish(visible)
            return { ok: true, state: visible }
          },
          hide: async () => { hides++; return { ok: true } },
          setBounds: async () => ({}),
        },
        on: { browserUseState: (listener: typeof publish) => { publish = listener } },
      },
    },
    document: {
      hidden: false,
      body: { classList: { contains: () => false } },
      querySelector: () => null,
      getElementById: (id: string) => {
        return id === 'artifacts-panel' ? panel : id === 'browser-panel-host' ? host : null
      },
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length },
    ResizeObserver: class { observe() {} },
  }
  const frame = async () => {
    for (const callback of frames.splice(0)) callback(0)
    for (let index = 0; index < 20; index++) await Promise.resolve()
  }
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] })
    // A query string gives this suite its own module instance: bun shares one
    // registry across the whole test run, and browser-panel's module-level frame
    // scope would otherwise carry this suite's revisions into sibling suites.
    const surface = await import('./browser-panel?suite=overlay')
    surface.initBrowserPanel({
      closeSettingsIfActive() {}, hideNonChatViews() {}, hideBtwPanel() {}, setCurrentNonChatView() {},
      setArtifactsPanelMode(next: string) { mode = next }, openArtifactsPanel() {}, closeArtifactsPanel() {},
      syncTopModeButtons() {}, renderSessionList() {},
    })
    surface.updateBrowserPanelState({ ...state, visible: true })
    expect(mounted).toBe(true)
    const suspend = (values.window as any).klausSuspendBrowserForOverlay as () => Promise<void>
    const resume = (values.window as any).klausResumeBrowserAfterOverlay as () => Promise<void>
    await suspend(); await suspend()
    await frame()
    expect(hides).toBe(1)
    expect(mounted).toBe(false)
    // The inner overlay closes first: the view must stay out of the window.
    await resume()
    await frame(); await frame()
    expect(shows).toBe(0)
    expect(mounted).toBe(false)
    void resume()
    await frame()
    finishShow()
    await frame()
    expect(shows).toBe(1)
    expect(mounted).toBe(true)
  } finally {
    finishShow()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test('an overlay lays a still of the page under the panel, defers shows, and never creates a page', async () => {
  // Order matters on screen: the still must be in the panel before the native
  // view leaves (or the dimmed panel flashes empty), and must stay until the
  // view is back. A show asked for under the overlay waits for its close.
  const names = ['window', 'document', 'requestAnimationFrame', 'ResizeObserver'] as const
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const frames: FrameRequestCallback[] = []
  const log: string[] = []
  let mode = 'browser', mounted = false
  const state = { conversationId: 'manual', focusRevision: 0, enabled: true, visible: false, tabs: [{ id: 'first' }] as Array<{ id: string }> }
  let publish!: (next: typeof state) => void
  const children: any[] = []
  const panel = { getAttribute: () => mode, classList: { contains: () => false } }
  const host = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 600 }),
    classList: { contains: () => mounted, toggle: (_name: string, value: boolean) => { mounted = value } },
    appendChild: (child: any) => { children.push(child); child.parent = host; log.push('still:placed'); return child },
  }
  const createElement = () => {
    const element: any = {
      className: '', alt: '', draggable: true, src: '', attributes: {} as Record<string, string>,
      setAttribute(name: string, value: string) { element.attributes[name] = value },
      decode: async () => {},
      remove() { const at = children.indexOf(element); if (at >= 0) { children.splice(at, 1); log.push('still:removed') } },
    }
    return element
  }
  const values = {
    window: {
      addEventListener: () => {},
      klaus: {
        settings: { browserUse: { get: async () => ({ enabled: true }) } },
        browserUse: {
          state: async () => state,
          show: async () => { log.push('show'); const visible = { ...state, visible: true }; publish(visible); return { ok: true, state: visible } },
          hide: async () => { log.push('hide'); return { ok: true } },
          setBounds: async () => ({}),
          screenshot: async (options: { presented?: boolean }) => {
            log.push(options?.presented ? 'capture:presented' : 'capture:agent')
            return { ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' }
          },
        },
        on: { browserUseState: (listener: typeof publish) => { publish = listener } },
      },
    },
    document: {
      hidden: false,
      body: { classList: { contains: () => false } },
      querySelector: () => null,
      createElement,
      getElementById: (id: string) => id === 'artifacts-panel' ? panel : id === 'browser-panel-host' ? host : null,
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length },
    ResizeObserver: class { observe() {} },
  }
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      for (const callback of frames.splice(0)) callback(0)
      for (let index = 0; index < 20; index++) await Promise.resolve()
    }
  }
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] })
    const surface = await import('./browser-panel?suite=overlay-still')
    surface.initBrowserPanel({
      closeSettingsIfActive() {}, hideNonChatViews() {}, hideBtwPanel() {}, setCurrentNonChatView() {},
      setArtifactsPanelMode(next: string) { mode = next }, openArtifactsPanel() {}, closeArtifactsPanel() {},
      syncTopModeButtons() {}, renderSessionList() {},
    })
    surface.updateBrowserPanelState({ ...state, visible: true })
    const suspend = (values.window as any).klausSuspendBrowserForOverlay as () => Promise<void>
    const resume = (values.window as any).klausResumeBrowserAfterOverlay as () => Promise<void>

    const suspending = suspend(); await settle(); await suspending
    expect(log).toEqual(['capture:presented', 'still:placed', 'hide'])
    expect(children).toHaveLength(1)
    expect(children[0].className).toBe('browser-overlay-snapshot')
    expect(children[0].attributes['aria-hidden']).toBe('true')
    expect(mounted).toBe(false)

    // An agent asks for the panel while the dialog is still up.
    log.length = 0
    const opening = surface.showBrowserPanel(); await settle(); await opening
    expect(log).toEqual([])
    expect(mounted).toBe(false)

    const resuming = resume(); await settle(); await resuming
    expect(log).toEqual(['show', 'still:removed'])
    expect(children).toHaveLength(0)
    expect(mounted).toBe(true)

    // With no page left in the task, closing the overlay must not ask the host
    // for one: showing an empty panel would leave a blank tab behind.
    log.length = 0
    state.tabs = []
    surface.updateBrowserPanelState({ ...state, visible: false })
    const second = suspend(); await settle(); await second
    const back = resume(); await settle(); await back
    expect(log.includes('show')).toBe(false)
    expect(log.includes('capture:presented')).toBe(false)
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
