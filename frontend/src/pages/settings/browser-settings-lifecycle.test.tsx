import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

let React: any
let act: any
let createRoot: any
let BrowserSettingsTab: any
let happyWindow: any
const originalGlobals = new Map<string, PropertyDescriptor | undefined>()

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
  host.window.showToast = (text: string, options?: unknown) => { host.window.__toasts.push(text); host.window.__toastOptions.push(options) }
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

async function choose(id: string, value: string) {
  await click(happyWindow.document.getElementById(id))
  const option = Array.from(happyWindow.document.querySelectorAll('[role="option"]')).find((node: any) => node.dataset.value === value)
  expect(option).toBeTruthy()
  await click(option)
}

beforeAll(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'IS_REACT_ACT_ENVIRONMENT']) originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
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
  host.IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  createRoot = (await import('react-dom/client')).createRoot
  BrowserSettingsTab = (await import('./browser-tab')).BrowserSettingsTab
})

afterEach(() => { happyWindow.document.body.innerHTML = ''; FakeIntersectionObserver.instances = [] })
afterAll(async () => {
  await happyWindow.happyDOM.cancelAsync()
  happyWindow.close?.()
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as any)[key]
  }
})

describe('browser settings React lifecycle', () => {
  test('URL choices support keyboard selection and restore focus to the retained trigger', async () => {
    let stored = { ...base }
    const writes: any[] = []
    installApi({
      get: async () => stored,
      setPreferences: async (patch: any) => { writes.push(patch); stored = { ...stored, ...patch }; return { ok: true, settings: stored } },
    })
    const { root } = await mount()
    const trigger = happyWindow.document.getElementById('browser-web-target')
    await act(async () => { trigger.dispatchEvent(new happyWindow.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    const list = happyWindow.document.querySelector('[role="listbox"]')
    expect(list.parentElement).toBe(happyWindow.document.body)
    expect(list.querySelector('[aria-selected="true"]').dataset.value).toBe('system-default')
    await act(async () => { happyWindow.document.activeElement.dispatchEvent(new happyWindow.KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    await act(async () => { happyWindow.document.activeElement.dispatchEvent(new happyWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(writes).toEqual([{ webUrlTarget: 'in-app' }])
    expect(happyWindow.document.querySelector('[role="listbox"]')).toBeNull()
    expect(happyWindow.document.getElementById('browser-web-target')).toBe(trigger)
    expect(happyWindow.document.activeElement).toBe(trigger)
    await act(async () => { root.unmount() })
  })

  test('plugin success appears after persistence confirms and keeps the switch node', async () => {
    let stored = { ...base, enabled: false }
    const saved = deferred<any>()
    installApi({
      get: async () => stored,
      setEnabled: () => saved.promise.then(reply => { stored = reply.settings; return reply }),
    })
    const { root } = await mount()
    const toggle = happyWindow.document.getElementById('browser-settings-enabled')
    await act(async () => { toggle.click() })
    expect(happyWindow.__toasts).toEqual([])
    await act(async () => { saved.resolve({ ok: true, appliedToCurrentSession: true, settings: { ...stored, enabled: true } }) })
    expect(happyWindow.__toasts).toHaveLength(1)
    expect(happyWindow.__toasts[0]).toContain('Browser plugin enabled')
    expect(happyWindow.__toastOptions[0]).toEqual({ tone: 'success' })
    expect(happyWindow.document.getElementById('browser-settings-enabled')).toBe(toggle)
    expect(toggle.checked).toBe(true)
    await act(async () => { root.unmount() })
  })

  test('a rejected plugin mutation rolls back and never shows success', async () => {
    installApi({ get: async () => ({ ...base, enabled: false }), setEnabled: async () => ({ ok: false, error: 'Synthetic persistence failure' }) })
    const { root } = await mount()
    const toggle = happyWindow.document.getElementById('browser-settings-enabled')
    await act(async () => { toggle.click() })
    expect(toggle.checked).toBe(false)
    expect(happyWindow.__toasts).toEqual(['Could not save the setting.'])
    expect(happyWindow.__toastOptions).not.toContainEqual({ tone: 'success' })
    expect(happyWindow.document.getElementById('browser-settings-enabled')).toBe(toggle)
    await act(async () => { root.unmount() })
  })

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
    await choose('browser-web-target', 'in-app')
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

  test('the clear dialog scopes deletion to the chosen kinds and a rejected request can be retried', async () => {
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
    expect(happyWindow.document.querySelector('[data-clear-dialog]')).toBeNull()
    await click(happyWindow.document.querySelector('#browser-clear-data'))
    const dialog = happyWindow.document.querySelector('[data-clear-dialog]')
    const boxes = Array.from(dialog.querySelectorAll('[data-clear-kind]')) as any[]
    expect(boxes.map(box => box.getAttribute('data-clear-kind'))).toEqual(['history', 'downloads', 'cookies', 'cache', 'siteData'])
    expect(boxes.map(box => box.checked)).toEqual([true, true, true, true, false])
    // Narrow the scope to browsing history only, then delete.
    for (const box of boxes.slice(1, 4)) await act(async () => { box.click() })
    await click(buttonByText('Delete data'))
    expect(calls).toEqual(['history'])
    expect(happyWindow.document.querySelector('[data-clear-dialog]')).toBeNull()
    const trigger = happyWindow.document.querySelector('#browser-clear-data') as any
    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    await act(async () => { rejectClear(new Error('clear failed')) })
    expect((happyWindow as any).__toasts).toContain('Could not save the setting.')
    expect((happyWindow as any).__toasts).not.toContain('clear failed')
    expect((happyWindow.document.querySelector('#browser-clear-data') as any).disabled).toBe(false)
    // Retry with every kind selected: the host receives one all-kinds request.
    await click(happyWindow.document.querySelector('#browser-clear-data'))
    const reopened = happyWindow.document.querySelector('[data-clear-dialog]')
    await act(async () => { (reopened.querySelector('[data-clear-kind="siteData"]') as any).click() })
    await click(buttonByText('Delete data'))
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

  test('history groups entries by visit date with collapsible day cards, row menus and a header clear action', async () => {
    const removed: string[][] = []
    const day = 86400000
    const today = new Date(2026, 10, 6, 10, 0, 0).getTime()
    const older = today - 3 * day
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      history: async () => ({
        items: [
          { id: 'h1', url: 'https://example.com/a', title: 'Newer page', visitTime: today, isActorVisit: false },
          { id: 'h2', url: 'https://example.com/b', title: 'Older page', visitTime: older, isActorVisit: false },
        ],
        nextCursor: null,
      }),
      removeHistory: async (ids: string[]) => { removed.push(ids); return { ok: true } },
      clearData: async () => ({ ok: true }),
    })
    const { root } = await mount()
    await click(buttonByText('Manage'))
    expect(happyWindow.document.body.textContent).toContain('All history records')
    let groups = Array.from(happyWindow.document.querySelectorAll('[data-hist-group]')) as any[]
    expect(groups.length).toBe(2)
    expect(groups[0].textContent).toContain('November 6, 2026')
    expect(groups[1].textContent).toContain('November 3, 2026')
    expect(groups[0].querySelectorAll('[data-hist-row]').length).toBe(1)
    expect(groups[1].querySelectorAll('[data-hist-row]').length).toBe(0)
    await click(groups[1].querySelector('button'))
    expect(groups[1].querySelectorAll('[data-hist-row]').length).toBe(1)
    // The row overflow menu removes a single entry.
    await click(happyWindow.document.querySelector('[data-hist-menu="h2"]'))
    await click(buttonByText('Remove'))
    expect(removed).toEqual([['h2']])
    // The source filter lives behind the search pill trigger.
    await click(happyWindow.document.querySelector('[data-hist-popover-trigger][aria-label="Filter by visit source"]'))
    await click(buttonByText('Agent'))
    expect(happyWindow.document.body.textContent).toContain('Agent history records')
    // The header clear action opens the shared clear dialog.
    await click(buttonByText('Clear browsing data'))
    expect(happyWindow.document.querySelector('[data-clear-dialog]')).not.toBeNull()
    await click(buttonByText('Cancel'))
    expect(happyWindow.document.querySelector('[data-clear-dialog]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  test('the site rule dialog adds a pattern and applies chosen overrides', async () => {
    const policyCalls: any[] = []
    installApi({
      get: async () => ({ ...base }),
      subscribe: () => () => {},
      setOriginPolicy: async (input: any) => { policyCalls.push(input); return { ok: true } },
    })
    const { root } = await mount()
    await click(happyWindow.document.querySelector('#browser-site-rule-add'))
    const dialog = happyWindow.document.querySelector('[data-site-rule-dialog]')
    expect(dialog).not.toBeNull()
    const confirm = Array.from(dialog.querySelectorAll('button')).find((node: any) => node.textContent?.trim() === 'Add') as any
    expect(confirm.disabled).toBe(true)
    const input = dialog.querySelector('input') as any
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(happyWindow.HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(input, 'example.com')
      else input.value = 'example.com'
      input.dispatchEvent(new happyWindow.InputEvent('input', { bubbles: true, data: 'example.com', inputType: 'insertText' }))
    })
    expect(confirm.disabled).toBe(false)
    await choose('browser-site-rule-browsing', 'allow')
    await click(confirm)
    expect(policyCalls).toEqual([
      { pattern: 'example.com', resource: 'browsing', setting: 'inherit' },
      { pattern: 'example.com', resource: 'browsing', setting: 'allow' },
    ])
    expect(happyWindow.document.querySelector('[data-site-rule-dialog]')).toBeNull()
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
    await click(happyWindow.document.querySelector('[aria-label="Filter by visit source"]'))
    await click(buttonByText('Agent'))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(buttonByText('Remove selected')).toBeUndefined()
    expect((happyWindow.document.querySelector('input[type="checkbox"]') as any).checked).toBe(false)
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
    await click(happyWindow.document.querySelector('[data-hist-menu="h1"]'))
    const remove = buttonByText('Remove')
    await click(remove)
    await click(happyWindow.document.querySelector('[data-hist-menu="h1"]'))
    await click(buttonByText('Remove'))
    expect(calls.length).toBe(1)
    await act(async () => { rejectRemoval(new Error('delete failed')) })
    expect((happyWindow as any).__toasts.some((text: string) => text.includes('Could not save the setting.'))).toBe(true)
    expect((happyWindow as any).__toasts.some((text: string) => text.includes('delete failed'))).toBe(false)
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
    const manage = happyWindow.document.getElementById('browser-downloads-manage') as any
    await click(manage)
    expect(happyWindow.document.body.textContent).toContain('Downloading')
    await act(async () => { push({ id: 'active', state: 'completed', receivedBytes: 10, totalBytes: 10 }) })
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
    expect((happyWindow as any).__toasts.some((text: string) => text.includes('Could not save the setting.'))).toBe(true)
    expect((happyWindow as any).__toasts.some((text: string) => text.includes('action failed'))).toBe(false)
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
    const manage = happyWindow.document.getElementById('browser-downloads-manage') as any
    await click(manage)
    const removeButtons = Array.from(happyWindow.document.querySelectorAll('button')).filter((node: any) => node.textContent?.trim() === 'Remove from history')
    expect(removeButtons.length).toBe(1)
    await act(async () => { root.unmount() })
  })
})
