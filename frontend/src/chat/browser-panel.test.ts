import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PANEL = readFileSync(fileURLToPath(new URL('./browser-panel.ts', import.meta.url)), 'utf8')

function hideRuntimeBody(): string {
  const start = PANEL.indexOf('export async function hideBrowserRuntime(')
  expect(start).toBeGreaterThan(-1)
  const end = PANEL.indexOf('\nfunction browserHostBounds(', start)
  expect(end).toBeGreaterThan(start)
  return PANEL.slice(start, end)
}

describe('browser panel hide path is idempotent', () => {
  // The host answers hide() by publishing browser-use:state. That event calls
  // scheduleBrowserBoundsSync(), whose rAF sees a panel that is not visible and
  // calls hideBrowserRuntime() again. Without a guard the renderer ping-pongs
  // with the host once per animation frame: measured at 241.6 DOM writes per
  // second on an idle window (two per frame at 120 Hz), which is what made the
  // idle CPU budget fail with no interaction and no animation running.
  test('hiding when nothing is mounted skips the host round trip entirely', () => {
    const body = hideRuntimeBody()
    expect(body).toContain('if (!options.ensureDetached && !browserRuntimeVisible()) return')
  })

  test('the guard precedes every effect, so a no-op hide mutates nothing', () => {
    const body = hideRuntimeBody()
    const guard = body.indexOf('if (!options.ensureDetached && !browserRuntimeVisible()) return')
    const hideCall = body.indexOf('browserUse?.hide?.()')
    const stateWrite = body.indexOf('updateBrowserPanelState(')
    const frames = body.indexOf('invalidateBrowserFrames()')
    const bounds = body.indexOf('lastSyncedBounds = null')
    for (const at of [hideCall, stateWrite, frames, bounds]) {
      expect(at).toBeGreaterThan(-1)
      expect(guard).toBeLessThan(at)
    }
  })

  test('a hide that does have a mounted view still detaches it', () => {
    const body = hideRuntimeBody()
    // The guard must not swallow the real path: detaching still reaches the host
    // and the renderer still reconciles its own toolbar/tab state afterwards.
    expect(body.indexOf('browserUse?.hide?.()')).toBeGreaterThan(-1)
    expect(body.indexOf('updateBrowserPanelState({ ...(browserState || {}), visible: false })')).toBeGreaterThan(-1)
  })

  test('an explicit surface transition can detach a host view after renderer state was lost', () => {
    const body = hideRuntimeBody()
    expect(body).toContain('options: { ensureDetached?: boolean } = {}')
    expect(body).toContain('if (!options.ensureDetached && !browserRuntimeVisible()) return')
    expect(PANEL).toContain('hideBrowserRuntime({ ensureDetached: true })')
  })

  test('visibility is read from host state, not from a locally cached flag', () => {
    const visible = PANEL.slice(PANEL.indexOf('export function browserRuntimeVisible()'), PANEL.indexOf('export async function hideBrowserRuntime()'))
    // Both terms are host-derived: the published state and the class that is
    // toggled from that same state. A renderer-only guess would let the guard
    // skip a detach the host still owes.
    expect(visible).toContain('browserState?.visible')
    expect(visible).toContain("classList.contains('browser-mounted')")
  })
})

test('a failed browser tab action still reveals the browser surface', () => {
  const hookStart = PANEL.indexOf('w.klausOpenBrowserTab = async')
  expect(hookStart).toBeGreaterThan(-1)
  const hookEnd = PANEL.indexOf('\n  w.klausNewBrowserTab =', hookStart)
  expect(hookEnd).toBeGreaterThan(hookStart)
  const hook = PANEL.slice(hookStart, hookEnd)

  // Both selecting an existing page and creating a new one can fail before a
  // runtime is available. In either case the persistent Browser panel must be
  // shown after the transient error toast instead of leaving Files/Overview on
  // screen and making the Browser action appear to do nothing.
  const failedBranches = hook.match(/if \(!res\?\.ok\) \{[\s\S]*?return false\n\s*\}/g) || []
  expect(failedBranches).toHaveLength(2)
  for (const branch of failedBranches) {
    expect(branch).toContain("showToast(res?.error || tt('browser_open_failed'))")
    expect(branch).toContain('await showBrowserPanel()')
  }
})

test('an explicit open has one show and a renderer reload detaches the stale native view', async () => {
  const names = ['window', 'document', 'requestAnimationFrame', 'ResizeObserver'] as const
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const frames: FrameRequestCallback[] = []
  let mode = '', shows = 0, hides = 0, mounted = false, toastRequests = 0
  const state = { conversationId: 'manual', focusRevision: 1, enabled: true, visible: false, tabs: [{ id: 'first' }] }
  let publish!: (next: typeof state) => void
  let finishFailedTab!: (result: { ok: false; error: string }) => void
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
            // The real host announces a new tab before its native view is ready.
            if (shows === 1) publish(state)
            await pending
            const visible = { ...state, visible: true }
            publish(visible)
            return { ok: true, state: visible }
          },
          hide: async () => { hides++; return { ok: true } },
          setBounds: async () => ({}),
          tabs: async ({ action }: { action: string }) => action === 'new'
            ? new Promise(resolve => { finishFailedTab = resolve })
            : { ok: true, state: { ...state, visible: true } },
        },
        on: { browserUseState: (listener: typeof publish) => { publish = listener } },
      },
    },
    document: {
      hidden: false,
      body: { classList: { contains: () => false } },
      querySelector: () => null,
      getElementById: (id: string) => {
        if (id === 'settings-toast-viewport') toastRequests++
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
    const surface = await import('./browser-panel')
    surface.initBrowserPanel({
      closeSettingsIfActive() {}, hideNonChatViews() {}, hideBtwPanel() {}, setCurrentNonChatView() {},
      setArtifactsPanelMode(next) { mode = next }, openArtifactsPanel() {}, closeArtifactsPanel() {},
      syncTopModeButtons() {}, renderSessionList() {},
    })
    const opening = surface.showBrowserPanel()
    await frame(); await frame()
    const showsWhileOpening = shows
    finishShow()
    await opening
    await frame()
    expect(showsWhileOpening).toBe(1)
    expect(shows).toBe(1)
    expect(mounted).toBe(true)
    expect(toastRequests).toBe(0)
    const openTab = (values.window as any).klausOpenBrowserTab as (request: object) => Promise<boolean>
    const obsolete = openTab({ url: 'http://127.0.0.1:8791/preview' })
    const selected = openTab({ tabId: 'first' })
    finishFailedTab({ ok: false, error: 'net::ERR_CONNECTION_REFUSED' })
    expect(await obsolete).toBe(false)
    await frame(); await frame()
    expect(await selected).toBe(true)
    expect(toastRequests).toBe(0)
    // Once opening has settled, an actual detach still triggers one recovery.
    const beforeRecovery = shows
    publish(state)
    await frame()
    expect(shows).toBe(beforeRecovery + 1)
    expect(mounted).toBe(true)

    // A renderer reload starts on the home screen before any task is selected.
    // The host-owned native view can still be attached to the old task there.
    // Its scoped state must be rejected for rendering but still used to detach
    // the window-wide child view, or it covers the home screen indefinitely.
    mode = 'monitor'
    publish({ ...state, conversationId: 'task-before-reload', focusRevision: 2, visible: true })
    await frame()
    expect(hides).toBeGreaterThan(0)
    expect(mounted).toBe(false)
  } finally {
    finishShow()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
