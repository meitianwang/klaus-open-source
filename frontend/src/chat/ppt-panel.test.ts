import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createStore } from 'zustand/vanilla'
import { createPptPanel } from './ppt-panel'
import { normalizeToolResultForReplay, normalizeVisualArtifact, visualArtifactHintState } from './transcript/factories'

const script = transpileModule(`${readFileSync(new URL('./panels/panel-tabs.tsx', import.meta.url), 'utf8')}\n;({ store, closePpt: id => closeTab(find('ppt', id)) });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
}).outputText

function tabsFixture() {
  let session = 'chat-a', mode = 'monitor', active = ''
  const storage = new Map<string, string>()
  const calls: unknown[] = []
  const listeners = new Map<string, () => void>()
  let held: Promise<boolean> | undefined
  const window: any = {
    dispatchEvent() {}, addEventListener: (name: string, listener: () => void) => { listeners.set(name, listener) },
    getCurrentSessionId: () => session,
    klausActivatePptPanel: async (payload: { id: string; sessionId: string }) => { calls.push(['show', payload]); active = payload.id; mode = 'ppt'; return held ?? true },
    klausActivePptId: () => active,
    klausClosePptPanel: async (id: string) => { calls.push(['close', id]); active = '' },
    klausOpenMonitorPanel: () => { mode = 'monitor' },
  }
  const imports: Record<string, unknown> = {
    react: {}, 'react/jsx-runtime': {}, 'react-dom': {}, 'react-dom/client': {}, zustand: {},
    'zustand/vanilla': { createStore },
    '../../app/window-state': { windowStateKey: (key: string) => key }, '../../icons/registry': { icon: () => '' },
    '../subagent-avatar': {}, '../subagent-identity': {}, '../subagent-state': { subscribeSubagents() {} }, './panels.module.css': {},
  }
  const runtime = runInNewContext(script, {
    window, CustomEvent, exports: {}, require: (name: string) => { if (!(name in imports)) throw Error(`Unexpected import: ${name}`); return imports[name] },
    document: { getElementById: (id: string) => id === 'artifacts-panel' ? { classList: { contains: () => false }, getAttribute: () => mode } : null, body: { classList: { toggle() {} } } },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
  })
  return { actions: window.KlausPanelTabs, snapshot: () => runtime.store.getState(), close: runtime.closePpt, calls,
    switchSession: (value: string) => { session = value }, hold: (promise: Promise<boolean>) => { held = promise }, languageChanged: () => listeners.get('klaus:lang-change')?.(),
    park: () => { active = '' } }
}

test('PPT tabs route owned presentations to the native view and retain document titles', async () => {
  const f = tabsFixture()
  expect(await f.actions.openPpt({ id: 'deck-a', title: 'Quarterly review', sessionId: 'chat-a' })).toBe(true)
  expect(f.calls).toEqual([['show', { id: 'deck-a', title: 'Quarterly review', sessionId: 'chat-a' }]])
  expect(f.snapshot().activeId).toBe('ppt:deck-a')
  f.languageChanged()
  const tab = f.snapshot().tabs.find((tab: any) => tab.id === 'ppt:deck-a')
  expect(tab.title).toBe('Quarterly review')
  await f.close('deck-a')
  expect(f.calls.at(-1)).toEqual(['close', 'deck-a'])
  expect(f.snapshot().tabs.some((tab: any) => tab.kind === 'ppt')).toBe(false)
  expect(await f.actions.openPpt({ id: 'foreign', sessionId: 'chat-b' })).toBe(false)
  expect(f.calls).toHaveLength(2)
})

test('a presentation receipt cannot select a tab removed during a chat switch', async () => {
  const f = tabsFixture()
  let finish!: (value: boolean) => void
  f.hold(new Promise(resolve => { finish = resolve }))
  const opening = f.actions.openPpt({ id: 'deck-a', sessionId: 'chat-a' })
  f.switchSession('chat-b')
  f.actions.clearPresentations()
  finish(true)
  expect(await opening).toBe(false)
  expect(f.snapshot().tabs.some((tab: any) => tab.kind === 'ppt')).toBe(false)
  expect(f.snapshot().activeId).not.toBe('ppt:deck-a')
})

test('background PPT opens acknowledge their request once and wait for the owning chat', async () => {
  let session = 'chat-a'
  const shown: unknown[] = [], replies: unknown[] = []
  const surface = createPptPanel({
    api: () => ({ panelShow: async (id, owner, bounds) => { shown.push({ id, owner, bounds }); return { ok: true } }, panelSetBounds: async () => ({ ok: true }), panelHide: async () => {}, panelClose: async () => {}, openResult: async (...args) => { replies.push(args) } }),
    currentSession: () => session, visible: () => true, bounds: () => ({ x: 10, y: 20, width: 500, height: 600 }), layout: async () => {}, openMode() {},
    openTab: payload => surface.activate(payload), toast() {}, text: key => key, schedule() {},
  })
  await surface.onOpen({ id: 'deck-b', sessionId: 'chat-b', requestId: 'request-b' })
  expect(shown).toHaveLength(0)
  expect(replies).toEqual([['request-b', false, 'ppt_background_pending']])
  session = 'chat-b'
  await surface.sessionChanged(session)
  expect(shown).toEqual([{ id: 'deck-b', owner: 'chat-b', bounds: { x: 10, y: 20, width: 500, height: 600 } }])
  expect(surface.state().activeTitle).toBe('ppt_title')
  expect(replies).toHaveLength(1)
  expect(await surface.activate({ id: 'foreign', sessionId: 'chat-a' })).toBe(false)
})

test('PPT artifact replay preserves explicit content state and omits failed results', () => {
  const artifact = { kind: 'ppt' as const, id: 'deck-a', title: 'Quarterly review', ready: false }
  expect(normalizeToolResultForReplay({ content: [], artifact })?.artifact).toEqual(artifact)
  expect(normalizeToolResultForReplay({ content: [], artifact, isError: true })?.artifact).toBeUndefined()
  expect(normalizeVisualArtifact({ kind: 'ppt', id: 'deck-a' })?.title).toBe('PPT')
  expect(visualArtifactHintState(artifact)).toBe('created')
  expect(visualArtifactHintState({ ...artifact, ready: true })).toBe('ready')
})

test('presentation tabs survive a session round trip and re-activate from the restored mode', async () => {
  const f = tabsFixture()
  expect(await f.actions.openPpt({ id: 'deck-a', title: 'Quarterly review', sessionId: 'chat-a' })).toBe(true)
  f.actions.beginSessionSwitch('chat-a', 'chat-b')
  expect(f.snapshot().tabs.some((tab: any) => tab.kind === 'ppt')).toBe(false)
  f.actions.beginSessionSwitch('chat-b', 'chat-a')
  expect(f.snapshot().tabs.find((tab: any) => tab.kind === 'ppt')).toMatchObject({ key: 'deck-a', title: 'Quarterly review', sessionId: 'chat-a' })
  // The surface owner parked its document on the way out; restoring the mode
  // re-activates it through the owner hook instead of an empty body.
  f.park()
  f.calls.length = 0
  f.actions.onModeChanged('ppt')
  expect(f.calls).toEqual([['show', { id: 'deck-a', title: 'Quarterly review', sessionId: 'chat-a' }]])
  expect(f.snapshot().activeId).toBe('ppt:deck-a')
})

test('session switches park the active presentation and resume it on return', async () => {
  let session = 'chat-a'
  const shown: unknown[] = []
  const surface = createPptPanel({
    api: () => ({ panelShow: async (id: string, owner: string, bounds: unknown) => { shown.push({ id, owner, bounds }); return { ok: true } }, panelSetBounds: async () => ({ ok: true }), panelHide: async () => {}, panelClose: async () => {}, openResult: async () => {} }),
    currentSession: () => session, visible: () => true, bounds: () => ({ x: 1, y: 2, width: 300, height: 400 }), layout: async () => {}, openMode() {},
    openTab: payload => surface.activate(payload), toast() {}, text: key => key, schedule() {},
  })
  expect(await surface.activate({ id: 'deck-a', title: 'Deck A', sessionId: 'chat-a' })).toBe(true)
  session = 'chat-b'
  await surface.sessionChanged('chat-b')
  expect(surface.state().activeId).toBe('')
  expect(surface.resumeId()).toBe('')
  session = 'chat-a'
  expect(surface.resumeId()).toBe('deck-a')
  await surface.sessionChanged('chat-a')
  expect(surface.state().activeId).toBe('')
  expect(await surface.activate({ id: 'deck-a', sessionId: 'chat-a' })).toBe(true)
  // An event for the chat already on screen must not hide its surface.
  const before = shown.length
  await surface.sessionChanged('chat-a')
  expect(surface.state().activeId).toBe('deck-a')
  expect(shown).toHaveLength(before)
})
