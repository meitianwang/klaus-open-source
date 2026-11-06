import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

let React: any
let act: any
let createRoot: any
let MobileBridgeSettingsTab: any
let clearSettingsSnapshots: any
let happyWindow: any
const originalGlobals = new Map<string, PropertyDescriptor | undefined>()

function installBridge(options: {
  settings?: Record<string, unknown>
  onSet?: (update: Record<string, unknown>) => void
}) {
  const host = globalThis as any
  let stored: Record<string, unknown> = {
    enabled: true,
    accountLinked: true,
    allowLockedComputerUse: false,
    ...options.settings,
  }
  const writes: Record<string, unknown>[] = []
  host.window.settingsApi = {
    mobileBridge: {
      get: async () => ({ ok: true, settings: stored }),
      devices: async () => ({ ok: true, devices: [] }),
      set: async (update: Record<string, unknown>) => {
        writes.push(update)
        options.onSet?.(update)
        stored = { ...stored, ...update }
        return { ok: true, settings: stored }
      },
    },
  }
  host.window.klsLoading = { render: () => '<div>loading</div>' }
  host.window.showToast = () => {}
  host.window.klaus = {
    powerSave: {
      subscribe: () => () => {},
      snapshot: async () => ({ revision: 1, preferences: { keepRemoteControlAwakeWhilePluggedIn: false } }),
      setPreference: async () => ({ ok: true, revision: 2, keepRemoteControlAwakeWhilePluggedIn: false }),
    },
  }
  return { writes }
}

async function mount() {
  const container = happyWindow.document.createElement('div')
  happyWindow.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(MobileBridgeSettingsTab)) })
  // Resolve the initial get()/devices() effects.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, root }
}

function toggle(id: string) {
  return happyWindow.document.getElementById(id) as any
}

beforeAll(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
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
  host.IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  createRoot = (await import('react-dom/client')).createRoot
  const tabModule = await import('./capability-tabs')
  MobileBridgeSettingsTab = tabModule.MobileBridgeSettingsTab
  clearSettingsSnapshots = (await import('./settings-snapshot')).clearSettingsSnapshots
})

afterEach(() => {
  happyWindow.document.body.innerHTML = ''
  clearSettingsSnapshots('account:mobile-bridge:')
  clearSettingsSnapshots('mobile-bridge:')
})

afterAll(async () => {
  await happyWindow.happyDOM.cancelAsync()
  happyWindow.close?.()
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as any)[key]
  }
})

describe('remote control settings: locked computer use', () => {
  test('reflects the stored preference', async () => {
    installBridge({ settings: { allowLockedComputerUse: true } })
    const { root } = await mount()
    expect(toggle('mobile-bridge-locked-use').checked).toBe(true)
    await act(async () => { root.unmount() })
  })

  test('defaults to off when the host omits the field', async () => {
    installBridge({ settings: {} })
    const { root } = await mount()
    expect(toggle('mobile-bridge-locked-use').checked).toBe(false)
    await act(async () => { root.unmount() })
  })

  test('writes only the locked-use field when toggled', async () => {
    const { writes } = installBridge({ settings: { allowLockedComputerUse: false } })
    const { root } = await mount()
    const node = toggle('mobile-bridge-locked-use')
    await act(async () => { node.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(writes).toEqual([{ allowLockedComputerUse: true }])
    expect(toggle('mobile-bridge-locked-use').checked).toBe(true)
    await act(async () => { root.unmount() })
  })

  test('labels the switch in the active language', async () => {
    happyWindow.currentLang = 'zh'
    installBridge({ settings: {} })
    const { root } = await mount()
    expect(happyWindow.document.body.textContent).toContain('锁屏时仍允许控制本机应用')
    await act(async () => { root.unmount() })
    happyWindow.currentLang = 'en'
  })
})
