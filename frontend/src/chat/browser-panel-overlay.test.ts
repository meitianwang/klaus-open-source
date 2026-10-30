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

