import { expect, test } from 'bun:test'

let instances = 0
async function fixture(run: (f: any) => Promise<void>) {
  const names = ['window', 'document', 'requestAnimationFrame', 'ResizeObserver'] as const
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const frames: FrameRequestCallback[] = []
  const events = new Map<string, () => void>()
  let mode = 'browser', mounted = false, toastRequests = 0
  let state: any = { conversationId: 'fixture', enabled: true, visible: false, tabId: 'first', tabs: [{ id: 'first' }] }
  let listener = (_state: any) => {}
  const shows: any[] = [], images: any[] = []
  let settings: () => Promise<any> = async () => ({ enabled: true })
  let show: (scope: any) => Promise<any> = async () => ({ ok: true, state: { ...state, visible: true } })
  let decode: () => Promise<void> = async () => {}
  let screenshot: () => Promise<any> = async () => ({ ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' })
  const panel = { getAttribute: () => mode, classList: { contains: () => false } }
  const host = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 600 }),
    classList: { contains: () => mounted, toggle: (_name: string, value: boolean) => { mounted = value } },
    appendChild: (child: any) => { images.push(child); return child },
  }
  const values = {
    window: {
      currentSessionId: 'fixture',
      addEventListener: (name: string, callback: () => void) => { events.set(name, callback) },
      klaus: {
        settings: { browserUse: { get: () => settings() } },
        browserUse: {
          state: async () => ({ ...state }),
          show: async (_bounds: any, scope: any) => { shows.push(scope); return show(scope) },
          hide: async () => { state = { ...state, visible: false }; listener(state); return { ok: true } },
          setBounds: async () => ({}),
          screenshot: () => screenshot(),
        },
        on: { browserUseState: (callback: typeof listener) => { listener = callback } },
      },
    },
    document: {
      hidden: false,
      body: { classList: { contains: () => false } },
      querySelector: () => null,
      createElement: () => {
        const image = { className: '', alt: '', draggable: true, src: '', setAttribute() {}, decode: () => decode(),
          remove() { const index = images.indexOf(image); if (index >= 0) images.splice(index, 1) } }
        return image
      },
      getElementById: (id: string) => {
        if (id === 'settings-toast-viewport') toastRequests++
        return id === 'artifacts-panel' ? panel : id === 'browser-panel-host' ? host : null
      },
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length },
    ResizeObserver: class { observe() {} },
  }
  const ticks = async (rounds = 6) => {
    for (let round = 0; round < rounds; round++) {
      for (const callback of frames.splice(0)) callback(0)
      for (let index = 0; index < 20; index++) await Promise.resolve()
    }
  }
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] })
    const moduleId = `./browser-panel?suite=overlay-races-${++instances}`
    const surface = await import(moduleId)
    surface.initBrowserPanel({
      closeSettingsIfActive() {}, hideNonChatViews() {}, hideBtwPanel() {}, setCurrentNonChatView() {},
      setArtifactsPanelMode(next: string) { mode = next }, openArtifactsPanel() {}, closeArtifactsPanel() {},
      syncTopModeButtons() {}, renderSessionList() {},
    })
    await ticks()
    surface.updateBrowserPanelState({ ...state, visible: true })
    await run({ surface, shows, images, ticks,
      suspend: () => (values.window as any).klausSuspendBrowserForOverlay(),
      resume: () => (values.window as any).klausResumeBrowserAfterOverlay(),
      state: (patch: any) => { state = { ...state, ...patch }; surface.updateBrowserPanelState(state) },
      settings: (work: typeof settings) => { settings = work },
      show: (work: typeof show) => { show = work },
      decode: (work: typeof decode) => { decode = work },
      screenshot: (work: typeof screenshot) => { screenshot = work },
      session: (sessionId: string) => { values.window.currentSessionId = sessionId; events.get('klaus:session-change')?.() },
      toasts: () => toastRequests,
    })
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('a deferred explicit open retains its exact target through the overlay', async () => fixture(async f => {
  const suspending = f.suspend(); await f.ticks(); await suspending
  const opening = f.surface.showBrowserPanel({ sessionId: 'fixture', targetId: 'second' })
  await f.ticks(); await opening
  expect(f.shows).toHaveLength(0)
  const resuming = f.resume(); await f.ticks(); await resuming
  expect(f.shows).toHaveLength(1)
  expect(f.shows[0].targetId).toBe('second')
}))

test('an explicit first open deferred under an overlay still opens once it closes', async () => fixture(async f => {
  f.state({ visible: false, tabId: null, tabs: [] })
  await f.suspend()
  const opening = f.surface.showBrowserPanel(); await f.ticks(); await opening
  expect(f.shows).toHaveLength(0)
  const resuming = f.resume(); await f.ticks(); await resuming
  expect(f.shows).toHaveLength(1)
}))

test('closing the last tab during the restore settings read cannot create a replacement', async () => fixture(async f => {
  const suspending = f.suspend(); await f.ticks(); await suspending
  const settings = held<any>()
  f.settings(() => settings.promise)
  const resuming = f.resume(); await f.ticks()
  f.state({ tabId: null, tabs: [] })
  settings.resolve({ enabled: true })
  await f.ticks(); await resuming
  expect(f.shows).toHaveLength(0)
  expect(f.images).toHaveLength(0)
}))

test('a task switch while the old screenshot decodes cannot insert it into the next task', async () => fixture(async f => {
  const decoded = held<void>()
  f.decode(() => decoded.promise)
  const suspending = f.suspend(); await f.ticks()
  f.session('next-task')
  decoded.resolve()
  await f.ticks(); await suspending
  expect(f.images).toHaveLength(0)
  // Switching back while the modal is still open does not resurrect that still.
  f.session('fixture')
  const resuming = f.resume(); await f.ticks(); await resuming
  expect(f.images).toHaveLength(0)
}))

test('a tab switch while a screenshot decodes invalidates the old still', async () => fixture(async f => {
  const decoded = held<void>()
  f.decode(() => decoded.promise)
  const suspending = f.suspend(); await f.ticks()
  f.state({ tabId: 'second', tabs: [{ id: 'first' }, { id: 'second' }] })
  decoded.resolve()
  await f.ticks(); await suspending
  expect(f.images).toHaveLength(0)
  const resuming = f.resume(); await f.ticks(); await resuming
  expect(f.shows.at(-1).targetId).toBe('second')
}))

test('an old show cancelled by a quickly closed overlay never reports an opening error', async () => fixture(async f => {
  const old = held<any>()
  let calls = 0
  f.show(async () => ++calls === 1 ? old.promise : { ok: true, state: { conversationId: 'fixture', visible: true, tabId: 'first', tabs: [{ id: 'first' }] } })
  const opening = f.surface.showBrowserPanel(); await f.ticks()
  await f.suspend()
  const resuming = f.resume(); await f.ticks(); await resuming
  old.resolve({ ok: false, error: 'The browser visibility request was superseded.' })
  await f.ticks(); await opening
  expect(f.toasts()).toBe(0)
}))


test('selecting a different tab during a restore prevents the old tab from retaking the panel', async () => fixture(async f => {
  f.state({ visible: true, tabs: [{ id: 'first' }, { id: 'second' }] })
  const suspending = f.suspend(); await f.ticks(); await suspending
  const settings = held<any>()
  f.settings(() => settings.promise)
  const resuming = f.resume(); await f.ticks()
  f.state({ tabId: 'second' })
  settings.resolve({ enabled: true })
  await f.ticks(); await resuming
  expect(f.shows).toHaveLength(0)
}))

test('a manual open cannot cross into another task during its initial layout wait', async () => fixture(async f => {
  const opening = f.surface.showBrowserPanel()
  f.session('next-task')
  await f.ticks(); await opening
  expect(f.shows).toHaveLength(0)
}))
