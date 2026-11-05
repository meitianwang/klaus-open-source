import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

let React: any
let act: any
let createRoot: any
let BrowserSettingsTab: any
let happyWindow: any

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  callback: any
  disconnected = false
  constructor(callback: any) { this.callback = callback; FakeIntersectionObserver.instances.push(this) }
  observe() {}
  disconnect() { this.disconnected = true }
  takeRecords() { return [] }
  unobserve() {}
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  callback: any
  disconnected = false
  constructor(callback: any) { this.callback = callback; FakeResizeObserver.instances.push(this) }
  observe() {}
  disconnect() { this.disconnected = true }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const base = {
  enabled: true, chromeEnabled: false, showFullUrl: false, annotationScreenshots: 'necessary',
  webUrlTarget: 'system-default', localUrlTarget: 'in-app', downloadDirectory: null, promptForDownloads: false,
  defaultPolicy: { browsing: 'allow', downloads: 'allow', uploads: 'allow', siteTools: 'allow', debug: 'deny' },
  originRules: [], sitePermissions: [], approvalMode: 'alwaysAsk', screenshotMode: 'alwaysInclude',
  allowedOrigins: [], deniedOrigins: [],
}

function installApi(api: any) {
  const host = globalThis as any
  host.window.settingsApi = { browserUse: api }
  host.window.__toasts = []
  host.window.__toastOptions = []
  host.window.showToast = (text: string, options?: any) => { host.window.__toasts.push(text); host.window.__toastOptions.push(options) }
  host.window.klsLoading = { render: () => '<div>loading</div>' }
  host.window.klausOpenExternalUrl = async () => {}
  host.window.klaus = { app: { openExternal: async () => {} }, browserUse: {} }
  return api
}

async function mount() {
  const container = happyWindow.document.createElement('div')
  happyWindow.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(BrowserSettingsTab)) })
  return { container, root }
}

function buttonByText(text: string) {
  return Array.from(happyWindow.document.querySelectorAll('button')).find((node: any) => node.textContent?.trim() === text) as any
}

async function click(node: any) {
  await act(async () => { node.dispatchEvent(new happyWindow.MouseEvent('click', { bubbles: true })) })
}

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
}

function stubRect(read: () => { x: number; y: number; width: number; height: number }) {
  const original = happyWindow.HTMLElement.prototype.getBoundingClientRect
  happyWindow.HTMLElement.prototype.getBoundingClientRect = function () {
    const value = read()
    return { ...value, top: value.y, left: value.x, right: value.x + value.width, bottom: value.y + value.height, toJSON() { return value } } as any
  }
  return () => { happyWindow.HTMLElement.prototype.getBoundingClientRect = original }
}

beforeAll(async () => {
  happyWindow = new Window({ url: 'http://localhost/' })
  happyWindow.currentLang = 'en'
  const host = globalThis as any
  host.window = happyWindow
  host.document = happyWindow.document
  host.navigator = happyWindow.navigator
  host.HTMLElement = happyWindow.HTMLElement
  host.Node = happyWindow.Node
  host.Event = happyWindow.Event
  host.MouseEvent = happyWindow.MouseEvent
  host.CustomEvent = happyWindow.CustomEvent
  host.MutationObserver = happyWindow.MutationObserver
  host.getComputedStyle = happyWindow.getComputedStyle.bind(happyWindow)
  host.requestAnimationFrame = (callback: any) => setTimeout(() => callback(Date.now()), 0)
  host.cancelAnimationFrame = (id: any) => clearTimeout(id)
  host.IntersectionObserver = FakeIntersectionObserver
  happyWindow.IntersectionObserver = FakeIntersectionObserver
  host.ResizeObserver = FakeResizeObserver
  happyWindow.ResizeObserver = FakeResizeObserver
  host.IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  createRoot = (await import('react-dom/client')).createRoot
  BrowserSettingsTab = (await import('./browser-tab')).BrowserSettingsTab
})

afterEach(() => { happyWindow.document.body.innerHTML = ''; happyWindow.currentLang = 'en'; FakeIntersectionObserver.instances = []; FakeResizeObserver.instances = [] })
afterAll(() => { happyWindow.close?.() })

describe('browser settings React lifecycle', () => {
  test('agent control off keeps manual browser settings and data management usable', async () => {
    const writes: any[] = []
    const off = { ...base, enabled: false, browserAvailable: true }
    installApi({
      get: async () => off,
      setPreferences: async (patch: any) => { writes.push(patch); return { ok: true, settings: { ...off, ...patch } } },
    })
    const { root } = await mount()
    expect(happyWindow.document.querySelector('#browser-web-target').disabled).toBe(false)
    expect(happyWindow.document.querySelector('#browser-clear-data').disabled).toBe(false)
    expect(happyWindow.document.querySelector('#browser-history-manage').disabled).toBe(false)
    const target = happyWindow.document.querySelector('#browser-web-target')
    await act(async () => { target.value = 'in-app'; target.dispatchEvent(new happyWindow.Event('change', { bubbles: true })) })
    expect(writes).toEqual([{ webUrlTarget: 'in-app' }])
    expect(happyWindow.document.body.textContent).not.toContain('currently unavailable')
    await act(async () => { root.unmount() })
  })

  test('runtime unavailability disables manual controls independently of agent control', async () => {
    installApi({ get: async () => ({ ...base, enabled: true, browserAvailable: false }) })
    const { root } = await mount()
    expect(happyWindow.document.querySelector('#browser-web-target').disabled).toBe(true)
    expect(happyWindow.document.querySelector('#browser-clear-data').disabled).toBe(true)
    expect(happyWindow.document.querySelector('#browser-history-manage').disabled).toBe(true)
    expect(happyWindow.document.body.textContent).toContain('currently unavailable')
    await act(async () => { root.unmount() })
  })

  test('an external subscription wins over an older initial read', async () => {
    const initial = deferred<any>()
    let push: any
    installApi({
      get: () => initial.promise,
      subscribe: (callback: any) => { push = callback; return () => {} },
      setPreferences: async () => ({ ok: true, settings: base }),
    })
    const { root } = await mount()
    await act(async () => { push({ ...base, showFullUrl: true }) })
    await act(async () => { initial.resolve({ ...base, showFullUrl: false }) })
    expect((happyWindow.document.querySelector('#browser-show-full-url') as any)?.checked).toBe(true)
    await act(async () => { root.unmount() })
  })

  test('one toggle interaction writes once', async () => {
    const writes: any[] = []
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      setPreferences: async (patch: any) => { writes.push(patch); return { ok: true, settings: { ...base, ...patch } } },
    })
    const { root } = await mount()
    const toggle = happyWindow.document.querySelector('#browser-show-full-url') as any
    await act(async () => { toggle.click() })
    expect(writes).toEqual([{ showFullUrl: true }])
    await act(async () => { root.unmount() })
  })

  test('browser toggle success feedback waits for its receipt in both directions', async () => {
    for (const enabled of [true, false]) {
      const pending = deferred<any>()
      const writes: boolean[] = []
      let saved = { ...base, enabled: !enabled }
      installApi({
        get: async () => saved,
        setEnabled: (value: boolean) => { writes.push(value); return pending.promise },
      })
      const { container, root } = await mount()
      const control = happyWindow.document.querySelector('#browser-settings-enabled')
      await click(control)
      expect(writes).toEqual([enabled])
      expect(control.checked).toBe(enabled)
      expect(control.disabled).toBe(true)
      expect(happyWindow.__toasts).toEqual([])
      saved = { ...saved, enabled }
      await act(async () => { pending.resolve({ ok: true, settings: saved }) })
      await settle()
      expect(happyWindow.__toasts).toEqual([enabled ? 'Browser plugin enabled.' : 'Browser plugin disabled.'])
      expect(happyWindow.__toastOptions).toEqual([{ tone: 'success' }])
      expect(happyWindow.document.querySelector('#browser-settings-enabled')).toBe(control)
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  test('browser toggle failures never confirm success and restore the saved state', async () => {
    for (const failure of ['receipt', 'exception']) {
      const message = `toggle ${failure} failed`
      installApi({
        get: async () => ({ ...base }),
        setEnabled: async () => {
          if (failure === 'exception') throw new Error(message)
          return { ok: false, error: message }
        },
      })
      const { container, root } = await mount()
      await click(happyWindow.document.querySelector('#browser-settings-enabled'))
      await settle()
      expect(happyWindow.__toasts).toEqual([message])
      expect(happyWindow.__toastOptions.every((options: any) => options?.tone !== 'success')).toBe(true)
      expect(happyWindow.document.querySelector('#browser-settings-enabled').checked).toBe(true)
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  test('browser toggle feedback respects the acknowledged activation scope', async () => {
    const cases = [
      { receipt: { restartRequired: true, appliedToCurrentSession: true }, note: 'Takes effect after restarting Klaus.' },
      { receipt: { activationScope: 'endpoint_restart' }, note: 'Takes effect after restarting Klaus.' },
      { receipt: { activationScope: 'next_turn', appliedToCurrentSession: true }, note: 'Active in this conversation now.' },
      { receipt: { activationScope: 'next_turn' }, note: 'Takes effect from the next turn.' },
    ]
    for (const { receipt, note } of cases) {
      let saved = { ...base }
      installApi({
        get: async () => saved,
        setEnabled: async (enabled: boolean) => { saved = { ...saved, enabled }; return { ok: true, ...receipt, settings: saved } },
      })
      const { container, root } = await mount()
      await click(happyWindow.document.querySelector('#browser-settings-enabled'))
      await settle()
      expect(happyWindow.__toasts).toEqual([`Browser plugin disabled. ${note}`])
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  test('browser toggle confirmation is localized', async () => {
    happyWindow.currentLang = 'zh'
    let saved = { ...base }
    installApi({
      get: async () => saved,
      setEnabled: async (enabled: boolean) => { saved = { ...saved, enabled }; return { ok: true, activationScope: 'next_turn', settings: saved } },
    })
    const { root } = await mount()
    await click(happyWindow.document.querySelector('#browser-settings-enabled'))
    await settle()
    expect(happyWindow.__toasts).toEqual(['Browser 插件已关闭。 下一轮对话生效。'])
    await act(async () => { root.unmount() })
  })

  test('individual clearing stays scoped and a rejected request can be retried', async () => {
    const calls: string[] = []
    let rejectClear: (error: Error) => void = () => {}
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      clearData: (kind: string) => {
        calls.push(kind)
        if (calls.length === 1) return new Promise((_resolve, reject) => { rejectClear = reject })
        return Promise.resolve({ ok: true })
      },
    })
    const { root } = await mount()
    expect(happyWindow.document.querySelector('#browser-clear-data-options')).toBeNull()
    const disclosure = happyWindow.document.querySelector('[aria-controls="browser-clear-data-options"]')
    await click(disclosure)
    const options = happyWindow.document.querySelector('#browser-clear-data-options')
    const history = options.querySelector('button')
    await click(history)
    await click(history)
    expect(calls).toEqual(['history'])
    expect(history.getAttribute('aria-busy')).toBe('true')
    expect((happyWindow.document.querySelector('#browser-clear-data') as any).disabled).toBe(true)
    await act(async () => { rejectClear(new Error('clear failed')) })
    expect((happyWindow as any).__toasts).toContain('clear failed')
    expect(history.disabled).toBe(false)
    await click(happyWindow.document.querySelector('#browser-clear-data'))
    expect(calls).toEqual(['history', 'all'])
    await act(async () => { root.unmount() })
  })

  test('history pagination failure exposes retry without polling', async () => {
    const calls: any[] = []
    let page = 0
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      history: async (input: any) => {
        calls.push(input)
        page += 1
        if (page === 1) return { items: [{ id: 'h1', url: 'https://example.com', title: 'Example', visitTime: 1, isActorVisit: false }], nextCursor: 'next' }
        return { ok: false, error: 'boom' }
      },
      removeHistory: async () => ({ ok: true }),
    })
    const { root } = await mount()
    const manage = Array.from(happyWindow.document.querySelectorAll('button')).filter((node: any) => node.textContent?.trim() === 'Manage')[0] as any
    await click(manage)
    expect(calls.length).toBe(1)
    const observer = FakeIntersectionObserver.instances.at(-1)!
    await act(async () => { observer.callback([{ isIntersecting: true }]) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(calls.length).toBe(2)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(calls.length).toBe(2)
    expect(observer.disconnected).toBe(true)
    const retry = buttonByText('Try again')
    expect(retry).toBeTruthy()
    await click(retry)
    expect(calls.length).toBe(3)
    await act(async () => { root.unmount() })
  })

  test('leaving history ignores a late page response', async () => {
    const pending = deferred<any>()
    let first = true
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      history: async () => { if (first) { first = false; return pending.promise } return { items: [], nextCursor: null } },
      removeHistory: async () => ({ ok: true }),
    })
    const { root } = await mount()
    const manage = Array.from(happyWindow.document.querySelectorAll('button')).filter((node: any) => node.textContent?.trim() === 'Manage')[0] as any
    await click(manage)
    expect(happyWindow.document.body.textContent).toContain('Browsing history')
    const back = buttonByText('Back')
    await click(back)
    await act(async () => { pending.resolve({ items: [{ id: 'h2', url: 'https://late.example', title: 'Late', visitTime: 2, isActorVisit: false }], nextCursor: null }) })
    expect(happyWindow.document.querySelector('input[placeholder="Search browsing history"]')).toBeNull()
    expect(happyWindow.document.querySelector('#browser-settings-enabled')).toBeTruthy()
    await act(async () => { root.unmount() })
  })

  test('changing the history query clears hidden selections', async () => {
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      history: async () => ({ items: [{ id: 'h1', url: 'https://example.com', title: 'Example', visitTime: 1, isActorVisit: false }], nextCursor: null }),
      removeHistory: async () => ({ ok: true }),
    })
    const { root } = await mount()
    const manage = Array.from(happyWindow.document.querySelectorAll('button')).filter((node: any) => node.textContent?.trim() === 'Manage')[0] as any
    await click(manage)
    const checkbox = happyWindow.document.querySelector('input[type="checkbox"]') as any
    await act(async () => { checkbox.click() })
    expect((buttonByText('Remove selected') as any).disabled).toBe(false)
    const source = happyWindow.document.querySelector('select') as any
    await act(async () => {
      source.value = 'agent'
      source.dispatchEvent(new happyWindow.Event('change', { bubbles: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect((buttonByText('Remove selected') as any).disabled).toBe(true)
    await act(async () => { root.unmount() })
  })

  test('history removal catches rejection and rejects re-entry', async () => {
    const calls: string[][] = []
    let rejectRemoval: any
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      history: async () => ({ items: [{ id: 'h1', url: 'https://example.com', title: 'Example', visitTime: 1, isActorVisit: false }], nextCursor: null }),
      removeHistory: async (ids: string[]) => {
        calls.push(ids)
        return new Promise((_, reject) => { rejectRemoval = reject })
      },
    })
    const { root } = await mount()
    const manage = Array.from(happyWindow.document.querySelectorAll('button')).filter((node: any) => node.textContent?.trim() === 'Manage')[0] as any
    await click(manage)
    const remove = buttonByText('Remove')
    await click(remove)
    await click(remove)
    expect(calls.length).toBe(1)
    await act(async () => { rejectRemoval(new Error('delete failed')) })
    expect((happyWindow as any).__toasts.some((text: string) => text.includes('delete failed'))).toBe(true)
    await act(async () => { root.unmount() })
  })

  test('download subscription updates rows, refreshes unknown ids once, and unsubscribes', async () => {
    let push: any
    let offCalled = false
    let downloadsCalls = 0
    const actions: string[] = []
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      downloads: async () => {
        downloadsCalls += 1
        return { items: [{ id: 'active', url: 'https://example.com/a', filename: 'a.bin', path: '/tmp/a.bin', state: 'progressing', receivedBytes: 1, totalBytes: 10, startedAt: 1, canPause: true, canResume: false, canCancel: true, exists: true }], nextCursor: null }
      },
      subscribeDownloads: (callback: any) => { push = callback; return () => { offCalled = true } },
      downloadAction: async (action: string) => { actions.push(action); throw new Error('action failed') },
    })
    const { root } = await mount()
    const manage = happyWindow.document.querySelector('#browser-download-history-manage') as any
    await click(manage)
    expect(happyWindow.document.body.textContent).toContain('Downloading')
    await act(async () => { push({ id: 'active', state: 'failed', canPause: false, canResume: true, canCancel: true }) })
    expect(buttonByText('Resume')).toBeTruthy()
    expect(Array.from(happyWindow.document.querySelectorAll('button')).some((node: any) => node.textContent?.trim() === 'Pause')).toBe(false)
    await act(async () => { push({ id: 'active', state: 'completed', receivedBytes: 10, totalBytes: 10, canPause: false, canResume: false, canCancel: false }) })
    expect(happyWindow.document.body.textContent).toContain('Completed')
    expect(happyWindow.document.body.textContent).not.toContain('File deleted')
    expect(Array.from(happyWindow.document.querySelectorAll('button')).filter((node: any) => node.textContent?.trim() === 'Remove from history').length).toBe(1)
    await act(async () => { push({ id: 'new', state: 'completed', exists: false }) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)) })
    expect(downloadsCalls).toBe(2)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(downloadsCalls).toBe(2)
    const remove = Array.from(happyWindow.document.querySelectorAll('button')).filter((node: any) => node.textContent?.trim() === 'Remove from history')[0] as any
    await click(remove)
    expect(actions).toEqual(['remove'])
    expect((happyWindow as any).__toasts.some((text: string) => text.includes('action failed'))).toBe(true)
    const back = buttonByText('Back')
    await click(back)
    expect(offCalled).toBe(true)
    await act(async () => { root.unmount() })
  })

  test('download history offers remove only for terminal rows', async () => {
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      downloads: async () => ({ items: [
        { id: 'active', url: 'https://example.com/a', filename: 'a.bin', path: '/tmp/a.bin', state: 'progressing', receivedBytes: 1, totalBytes: 10, startedAt: 1, canPause: true, canResume: false, canCancel: true, exists: true },
        { id: 'done', url: 'https://example.com/b', filename: 'b.bin', path: '/tmp/b.bin', state: 'completed', receivedBytes: 10, totalBytes: 10, startedAt: 2, canPause: false, canResume: false, canCancel: false, exists: true },
      ], nextCursor: null }),
      downloadAction: async () => ({ ok: true }),
    })
    const { root } = await mount()
    const manage = happyWindow.document.querySelector('#browser-download-history-manage') as any
    await click(manage)
    const removeButtons = Array.from(happyWindow.document.querySelectorAll('button')).filter((node: any) => node.textContent?.trim() === 'Remove from history')
    expect(removeButtons.length).toBe(1)
    await act(async () => { root.unmount() })
  })

  test('native management opens an embedded pane with measured bounds and closes on back', async () => {
    const calls: any[] = []
    installApi({
      get: async () => ({ ...base, nativeManagementAvailable: true }),
      subscribe: () => () => {},
      openManager: async (surface: string, options: any = {}) => { calls.push({ surface, ...options }); return { ok: true, surface } },
    })
    let rect = { x: 24, y: 96, width: 640, height: 480 }
    const restore = stubRect(() => rect)
    try {
      const { root } = await mount()
      for (const entry of happyWindow.document.querySelectorAll('[data-surface]')) expect(entry.getAttribute('title')).toBeNull()
      await click(happyWindow.document.querySelector('#browser-open-passwords'))
      await settle()
      expect(happyWindow.document.querySelector('[data-native-management-pane="passwords"]')).toBeTruthy()
      expect(happyWindow.document.querySelector('#browser-native-back')).toBeTruthy()
      expect(calls).toHaveLength(1)
      const opened = calls[0]
      expect(opened).toMatchObject({ surface: 'passwords', action: 'open', bounds: { x: 24, y: 96, width: 640, height: 480 } })
      expect(typeof opened.viewId).toBe('string')

      calls.length = 0
      rect = { x: 32, y: 96, width: 700, height: 480 }
      await act(async () => { happyWindow.dispatchEvent(new happyWindow.Event('resize')) })
      await settle()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ surface: 'passwords', action: 'bounds', bounds: { x: 32, y: 96, width: 700, height: 480 } })
      expect(calls[0].viewId).toBe(opened.viewId)

      calls.length = 0
      await click(happyWindow.document.querySelector('#browser-native-back'))
      await settle()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ surface: 'passwords', action: 'close' })
      expect(calls[0].viewId).toBe(opened.viewId)
      expect(happyWindow.document.querySelector('[data-native-management-pane]')).toBeNull()

      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  test('native pane waits for a non-zero rectangle before opening', async () => {
    const calls: any[] = []
    installApi({
      get: async () => ({ ...base, nativeManagementAvailable: true }),
      subscribe: () => () => {},
      openManager: async (surface: string, options: any = {}) => { calls.push({ surface, ...options }); return { ok: true, surface } },
    })
    let rect = { x: 0, y: 0, width: 0, height: 0 }
    const restore = stubRect(() => rect)
    try {
      const { root } = await mount()
      for (const entry of happyWindow.document.querySelectorAll('[data-surface]')) expect(entry.getAttribute('title')).toBeNull()
      await click(happyWindow.document.querySelector('#browser-open-passwords'))
      await settle()
      expect(calls).toEqual([])
      expect(happyWindow.document.querySelector('[data-native-management-pane="passwords"]')).toBeTruthy()

      rect = { x: 24, y: 96, width: 640, height: 480 }
      await act(async () => { FakeResizeObserver.instances.at(-1)!.callback([]) })
      await settle()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ surface: 'passwords', action: 'open', bounds: { x: 24, y: 96, width: 640, height: 480 } })
      expect(typeof calls[0].viewId).toBe('string')
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  test('native pane reports an error and retries the open request with a new view token', async () => {
    const calls: any[] = []
    const opens: string[] = []
    installApi({
      get: async () => ({ ...base, nativeManagementAvailable: true }),
      subscribe: () => () => {},
      openManager: async (surface: string, options: any = {}) => {
        calls.push({ surface, ...options })
        if (options.action === 'open') { opens.push(options.viewId); return { ok: false, error: 'manager unavailable' } }
        return { ok: true, surface }
      },
    })
    const restore = stubRect(() => ({ x: 24, y: 96, width: 640, height: 480 }))
    try {
      const { root } = await mount()
      for (const entry of happyWindow.document.querySelectorAll('[data-surface]')) expect(entry.getAttribute('title')).toBeNull()
      await click(happyWindow.document.querySelector('#browser-open-passwords'))
      await settle()
      expect(happyWindow.document.querySelector('[role="alert"]')?.textContent).toContain('manager unavailable')
      await click(buttonByText('Try again'))
      await settle()
      expect(opens).toHaveLength(2)
      expect(opens[1]).not.toBe(opens[0])
      const firstClose = calls.find(call => call.action === 'close')
      expect(firstClose).toMatchObject({ surface: 'passwords', action: 'close', viewId: opens[0] })
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  test('same-surface re-entry uses a new view token and stale callbacks stay inert', async () => {
    const calls: any[] = []
    installApi({
      get: async () => ({ ...base, nativeManagementAvailable: true }),
      subscribe: () => () => {},
      openManager: async (surface: string, options: any = {}) => { calls.push({ surface, ...options }); return { ok: true, surface } },
    })
    const restore = stubRect(() => ({ x: 24, y: 96, width: 640, height: 480 }))
    try {
      const { root } = await mount()
      await click(happyWindow.document.querySelector('#browser-open-passwords'))
      await settle()
      const firstOpen = calls[0]
      expect(typeof firstOpen.viewId).toBe('string')
      const stale = FakeResizeObserver.instances.at(-1)!

      await click(happyWindow.document.querySelector('#browser-native-back'))
      await settle()
      const firstClose = calls.find(call => call.action === 'close')
      expect(firstClose).toMatchObject({ surface: 'passwords', action: 'close' })
      expect(firstClose.viewId).toBe(firstOpen.viewId)

      calls.length = 0
      await click(happyWindow.document.querySelector('#browser-open-passwords'))
      await settle()
      const secondOpen = calls[0]
      expect(secondOpen).toMatchObject({ surface: 'passwords', action: 'open' })
      expect(secondOpen.viewId).not.toBe(firstOpen.viewId)

      calls.length = 0
      await act(async () => {
        stale.callback([])
        happyWindow.dispatchEvent(new happyWindow.Event('resize'))
      })
      await settle()
      expect(calls).toEqual([])

      await click(happyWindow.document.querySelector('#browser-native-back'))
      await settle()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ surface: 'passwords', action: 'close' })
      expect(calls[0].viewId).toBe(secondOpen.viewId)
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  test('Import opens the custom profile import dialog instead of a native manager', async () => {
    const calls: any[] = []
    const discovered: number[] = []
    installApi({
      get: async () => ({ ...base, nativeManagementAvailable: true }),
      subscribe: () => () => {},
      openManager: async (surface: string, options: any = {}) => { calls.push({ surface, ...options }); return { ok: true, surface } },
    })
    ;(globalThis as any).window.settingsApi.browserProfileImport = {
      discover: async () => { discovered.push(1); return { profiles: [], errors: [] } },
      start: async () => { throw new Error('not used') },
      cancel: async () => {},
      subscribe: () => () => {},
    }
    const { root } = await mount()
    await click(happyWindow.document.querySelector('#browser-open-import'))
    await settle()
    expect(discovered).toHaveLength(1)
    expect(happyWindow.document.body.textContent).toContain('Import browser data')
    expect(calls).toEqual([])
    await act(async () => { root.unmount() })
  })

  test('native pane follows host navigation state and sends back, forward, navigate and theme actions', async () => {
    const calls: any[] = []
    let push: any
    installApi({
      get: async () => ({ ...base, nativeManagementAvailable: true }),
      subscribe: () => () => {},
      openManager: async (surface: string, options: any = {}) => { calls.push({ surface, ...options }); return { ok: true, surface } },
      onManagerState: (callback: any) => { push = callback; return () => {} },
    })
    const restore = stubRect(() => ({ x: 24, y: 96, width: 640, height: 480 }))
    try {
      const { root } = await mount()
      await click(happyWindow.document.querySelector('#browser-open-passwords'))
      await settle()
      const opened = calls.find(call => call.action === 'open')
      expect(typeof opened.viewId).toBe('string')
      expect(typeof push).toBe('function')

      await act(async () => {
        push({ surface: 'passwords', viewId: opened.viewId, url: 'chrome://password-manager/passwords', title: 'Saved passwords', canGoBack: true, canGoForward: true })
      })
      expect(happyWindow.document.body.textContent).toContain('Saved passwords')
      const back = happyWindow.document.querySelector('[data-native-nav="back"]') as any
      const forward = happyWindow.document.querySelector('[data-native-nav="forward"]') as any
      expect(back.disabled).toBe(false)
      expect(forward.disabled).toBe(false)

      calls.length = 0
      await click(back)
      await settle()
      expect(calls[0]).toMatchObject({ surface: 'passwords', action: 'back', viewId: opened.viewId })
      await click(forward)
      await settle()
      expect(calls[1]).toMatchObject({ surface: 'passwords', action: 'forward', viewId: opened.viewId })

      await act(async () => {
        push({ surface: 'passwords', viewId: opened.viewId, url: 'https://evil.example/', title: 'Evil page', canGoBack: false, canGoForward: false })
      })
      expect(happyWindow.document.body.textContent).not.toContain('Evil page')

      await act(async () => {
        push({ surface: 'passwords', viewId: opened.viewId, url: 'chrome://password-manager/passwords/detail', title: 'Detail', canGoBack: false, canGoForward: false })
      })
      const section = happyWindow.document.querySelector('[data-native-crumb="section"]') as any
      expect(section.disabled).toBe(false)
      calls.length = 0
      await click(section)
      await settle()
      expect(calls[0]).toMatchObject({ surface: 'passwords', action: 'navigate', url: 'chrome://password-manager/passwords', viewId: opened.viewId })

      calls.length = 0
      happyWindow.document.documentElement.dataset.theme = 'dark'
      await act(async () => { happyWindow.dispatchEvent(new happyWindow.CustomEvent('klaus:theme-change')) })
      await settle()
      expect(calls.find(call => call.action === 'theme')).toMatchObject({ surface: 'passwords', action: 'theme', theme: 'dark', viewId: opened.viewId })
      await act(async () => { root.unmount() })
    } finally {
      happyWindow.document.documentElement.dataset.theme = 'light'
      restore()
    }
  })

})
