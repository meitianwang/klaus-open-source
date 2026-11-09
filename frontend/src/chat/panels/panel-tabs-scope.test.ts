import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createStore } from 'zustand/vanilla'

// Executes the real registry module in a VM context with a switchable session
// id and an inspectable localStorage, so per-conversation scope isolation,
// draft identity promotion and checkpoint round-trips are asserted against the
// real code paths instead of a reimplementation.
const script = transpileModule(
  `${readFileSync(new URL('./panel-tabs.tsx', import.meta.url), 'utf8')}\n;({ store, moveTab });`,
  { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } },
).outputText

const IDENTITIES_KEY = 'klaus.panelTabs.draftIdentities.v1'
const DRAFT_TABS_KEY = 'klaus.panelTabs.draftTabs.v1'
const BINDINGS_KEY = 'klaus.panelTabs.clientBindings.v1'

function createScopeFixture(initialSession: string | null, sharedStorage?: Map<string, string>) {
  let session = initialSession
  let mode = 'monitor'
  const storage = sharedStorage ?? new Map<string, string>()
  const window: any = {
    dispatchEvent() { return true },
    addEventListener() {},
    getCurrentSessionId: () => session,
    klausOpenMonitorPanel: () => { mode = 'monitor' },
  }
  const imports: Record<string, unknown> = {
    react: {}, 'react/jsx-runtime': {}, 'react-dom': {}, 'react-dom/client': {}, zustand: {},
    'zustand/vanilla': { createStore },
    '../../app/window-state': { windowStateKey: (key: string) => key },
    '../../icons/registry': { icon: () => '' },
    '../subagent-avatar': {}, '../subagent-identity': {},
    '../subagent-state': { subscribeSubagents() {} }, './panels.module.css': {},
  }
  const api = runInNewContext(script, {
    window, CustomEvent, exports: {}, require: (name: string) => {
      if (!(name in imports)) throw new Error(`Unexpected panel-tabs import: ${name}`)
      return imports[name]
    },
    document: {
      getElementById: (id: string) => id === 'artifacts-panel'
        ? { classList: { contains: () => false }, getAttribute: () => mode }
        : null,
      body: { classList: { toggle() {} } },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
  })
  return {
    actions: window.KlausPanelTabs,
    storage,
    api,
    snapshot: () => api.store.getState(),
    tabIds: (): string[] => api.store.getState().tabs.map((tab: any) => tab.id),
    setSession: (value: string | null) => { session = value },
    checkpoint: (key: string) => {
      const raw = storage.get(`klaus.panelTabs.${key}`)
      return raw ? JSON.parse(raw) : null
    },
    draftIdentity: (): string => JSON.parse(storage.get(IDENTITIES_KEY)!)['new-conversation'],
  }
}

test('resident scopes keep tab sets isolated across A → B → A', () => {
  const f = createScopeFixture('chat-a')
  f.actions.syncBrowserTabs([{ id: 'b1', url: 'https://a.example/docs', title: 'A docs' }])
  f.actions.onModeChanged('workspace')
  expect(f.tabIds()).toEqual(['monitor', 'browser:b1', 'workspace'])

  f.actions.beginSessionSwitch('chat-a', 'chat-b')
  f.setSession('chat-b')
  expect(f.tabIds()).toEqual(['monitor'])
  f.actions.syncBrowserTabs([{ id: 'b2', url: 'https://b.example/docs', title: 'B docs' }])

  f.actions.beginSessionSwitch('chat-b', 'chat-a')
  f.setSession('chat-a')
  // The warm scope comes back with its own tabs; the other chat's page never
  // rides along. The live browser descriptor folded back into its pending
  // placeholder, exactly like a cold restore would produce.
  expect(f.tabIds()).toEqual(['monitor', 'browser:restored:https://a.example/docs', 'workspace'])
  expect(f.snapshot().tabs.some((tab: any) => tab.url === 'https://b.example/docs')).toBe(false)
  expect(f.snapshot().activeId).toBe('workspace')

  const checkpoint = f.checkpoint('chat-a')
  expect(checkpoint.tabs).toEqual([
    { kind: 'browser', url: 'https://a.example/docs' },
    { kind: 'workspace' },
  ])
  expect(checkpoint.topology.tabIds).toEqual(['monitor', 'browser:restored:https://a.example/docs', 'workspace'])
  expect(checkpoint.topology.activeTabId).toBe('workspace')

  // The host re-sync supersedes the placeholder with the live page again; the
  // live descriptor appends at the end, matching the owner-sync contract.
  f.actions.syncBrowserTabs([{ id: 'b1', url: 'https://a.example/docs', title: 'A docs' }])
  expect(f.tabIds()).toEqual(['monitor', 'workspace', 'browser:b1'])
})

test('draft identity persists tabs, and promotion binds the same scope in place', () => {
  const f = createScopeFixture(null)
  const draftId = f.draftIdentity()
  expect(draftId.startsWith('draft:')).toBe(true)

  f.actions.syncBrowserTabs([{ id: 'd1', url: 'https://draft.example', title: 'Draft' }])

  // Leaving for a real chat checkpoints the draft under its client-side id.
  f.actions.beginSessionSwitch(null, 'chat-a')
  f.setSession('chat-a')
  const draftTabs = JSON.parse(f.storage.get(DRAFT_TABS_KEY)!)
  expect(draftTabs[draftId].tabs).toEqual([{ kind: 'browser', url: 'https://draft.example' }])

  // Returning to the new-chat state rebinds the SAME draft scope.
  f.actions.beginSessionSwitch('chat-a', null)
  f.setSession(null)
  expect(f.tabIds()).toEqual(['monitor', 'browser:restored:https://draft.example'])

  // Promotion binds the resident draft scope to the real session id in place:
  // no tab is lost or recreated, the checkpoint migrates to the session key,
  // and the new-chat identity rotates for the next draft.
  f.actions.promoteDraftSession('chat-c')
  f.setSession('chat-c')
  expect(f.tabIds()).toEqual(['monitor', 'browser:restored:https://draft.example'])
  expect(JSON.parse(f.storage.get(BINDINGS_KEY)!)['chat-c']).toBe(draftId)
  expect(f.draftIdentity()).not.toBe(draftId)
  expect(f.checkpoint('chat-c').tabs).toEqual([{ kind: 'browser', url: 'https://draft.example' }])
  expect(JSON.parse(f.storage.get(DRAFT_TABS_KEY) ?? '{}')[draftId]).toBeUndefined()

  // The next new chat starts clean under the rotated identity.
  f.actions.beginSessionSwitch('chat-c', null)
  f.setSession(null)
  expect(f.tabIds()).toEqual(['monitor'])
})

test('promotion is idempotent and never rebinds a session to a fresh draft', () => {
  const f = createScopeFixture(null)
  f.actions.syncBrowserTabs([{ id: 'd1', url: 'https://draft.example', title: 'Draft' }])
  f.actions.promoteDraftSession('chat-c')
  f.setSession('chat-c')
  const binding = JSON.parse(f.storage.get(BINDINGS_KEY)!)['chat-c']
  // No leave happened, so the live descriptor is retained as-is.
  expect(f.tabIds()).toEqual(['monitor', 'browser:d1'])

  // A duplicate promotion call (retry path) must not rotate the binding.
  f.actions.promoteDraftSession('chat-c')
  expect(JSON.parse(f.storage.get(BINDINGS_KEY)!)['chat-c']).toBe(binding)
  expect(f.tabIds()).toEqual(['monitor', 'browser:d1'])
})

test('checkpoint topology round-trips strip order and selection through a cold restore', () => {
  const storage = new Map<string, string>()
  const f1 = createScopeFixture('chat-a', storage)
  f1.actions.onModeChanged('workspace')
  f1.actions.onModeChanged('diff')
  expect(f1.tabIds()).toEqual(['monitor', 'workspace', 'diff'])
  expect(f1.api.moveTab('diff', 'workspace', false)).toBe(true)
  expect(f1.tabIds()).toEqual(['monitor', 'diff', 'workspace'])
  const checkpoint = f1.checkpoint('chat-a')
  expect(checkpoint.topology.tabIds).toEqual(['monitor', 'diff', 'workspace'])
  expect(checkpoint.topology.activeTabId).toBe('diff')

  // A cold module instance rebuilds order and selection from the checkpoint.
  const f2 = createScopeFixture(null, storage)
  f2.actions.beginSessionSwitch(null, 'chat-a')
  f2.setSession('chat-a')
  expect(f2.tabIds()).toEqual(['monitor', 'diff', 'workspace'])
  expect(f2.snapshot().activeId).toBe('diff')
})

test('volatile surfaces drop out of a scope on leave and never ride back', async () => {
  const f = createScopeFixture('chat-a')
  f.actions.syncTerminals(2)
  await f.actions.openSubagent('agent-1', 'Runner')
  f.actions.onModeChanged('workspace')
  expect(f.snapshot().tabs.map((tab: any) => tab.kind)).toEqual(['monitor', 'terminal', 'subagent', 'workspace'])

  f.actions.beginSessionSwitch('chat-a', 'chat-b')
  f.setSession('chat-b')
  const checkpoint = f.checkpoint('chat-a')
  expect(checkpoint.tabs).toEqual([{ kind: 'workspace' }])
  expect(checkpoint.topology.tabIds).toEqual(['monitor', 'workspace'])

  f.actions.beginSessionSwitch('chat-b', 'chat-a')
  f.setSession('chat-a')
  expect(f.tabIds()).toEqual(['monitor', 'workspace'])
})

test('forgetting a deleted chat wipes its envelope, binding and resident scope', () => {
  const f = createScopeFixture(null)
  f.actions.syncBrowserTabs([{ id: 'd1', url: 'https://draft.example', title: 'Draft' }])
  f.actions.promoteDraftSession('chat-c')
  f.setSession('chat-c')
  expect(f.checkpoint('chat-c')).not.toBeNull()

  // The delete flow leaves for the new-chat state first, then forgets.
  f.actions.beginSessionSwitch(null, null)
  f.setSession(null)
  f.actions.forgetSession('chat-c')
  expect(f.storage.get('klaus.panelTabs.chat-c')).toBeUndefined()
  expect(JSON.parse(f.storage.get(BINDINGS_KEY) ?? '{}')['chat-c']).toBeUndefined()

  // A later visit under the same id starts cold and empty.
  f.actions.beginSessionSwitch(null, 'chat-c')
  f.setSession('chat-c')
  expect(f.tabIds()).toEqual(['monitor'])
})

test('scopes beyond the retention window fall back to their checkpoints', () => {
  const f = createScopeFixture('chat-0')
  f.actions.syncBrowserTabs([{ id: 'b0', url: 'https://chat0.example', title: 'C0' }])
  for (let i = 1; i <= 21; i++) {
    f.actions.beginSessionSwitch(`chat-${i - 1}`, `chat-${i}`)
    f.setSession(`chat-${i}`)
    f.actions.syncBrowserTabs([{ id: `b${i}`, url: `https://chat${i}.example`, title: `C${i}` }])
  }
  // chat-0's scope was evicted from the resident window; its checkpoint still
  // brings the page back as a pending placeholder.
  f.actions.beginSessionSwitch('chat-21', 'chat-0')
  f.setSession('chat-0')
  expect(f.tabIds()).toEqual(['monitor', 'browser:restored:https://chat0.example'])
})
