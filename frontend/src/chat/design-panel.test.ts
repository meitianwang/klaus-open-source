import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createStore } from 'zustand/vanilla'
import { createDesignPanel, designPanelBounds } from './design-panel'
import { normalizeVisualArtifact, visualArtifactHintState } from './transcript/factories'

const script = transpileModule(`${readFileSync(new URL('./panels/panel-tabs.tsx', import.meta.url), 'utf8')}\n;({ store, closeDesign: id => closeTab(find('design', id)) });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
}).outputText

test('Design Canvas bounds preserve fractional CSS pixels for host zoom conversion', () => {
  expect(designPanelBounds({ left: 100.25, top: 44.75, width: 520.5, height: 840.25 }))
    .toEqual({ x: 100.25, y: 44.75, width: 520.5, height: 840.25 })
})

test('Design Canvas bounds reject invalid or zero-size measurements', () => {
  expect(designPanelBounds(null)).toBeNull()
  expect(designPanelBounds({ left: 0, top: 0, width: 0, height: 600 })).toBeNull()
  expect(designPanelBounds({ left: Number.NaN, top: 0, width: 480, height: 600 })).toBeNull()
})

function tabsFixture() {
  let session = 'chat-a', mode = 'monitor', active = ''
  const storage = new Map<string, string>()
  const calls: unknown[] = []
  const listeners = new Map<string, () => void>()
  let held: Promise<boolean> | undefined
  const window: any = {
    dispatchEvent() {}, addEventListener: (name: string, listener: () => void) => { listeners.set(name, listener) },
    getCurrentSessionId: () => session,
    klausActivateDesignPanel: async (payload: { id: string; sessionId: string }) => { calls.push(['show', payload]); active = payload.id; mode = 'design'; return held ?? true },
    klausActiveDesignId: () => active,
    klausCloseDesignPanel: async (id: string) => { calls.push(['close', id]); active = '' },
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
  return {
    actions: window.KlausPanelTabs, snapshot: () => runtime.store.getState(), close: runtime.closeDesign, calls,
    switchSession: (value: string) => { session = value }, hold: (promise: Promise<boolean>) => { held = promise },
    languageChanged: () => listeners.get('klaus:lang-change')?.(),
  }
}

test('Design Canvas tabs route owned canvases to the native view and retain titles across language switches', async () => {
  const f = tabsFixture()
  expect(await f.actions.openDesign({ id: 'canvas-1', title: 'Landing explorations', sessionId: 'chat-a' })).toBe(true)
  expect(f.calls).toEqual([['show', { id: 'canvas-1', title: 'Landing explorations', sessionId: 'chat-a' }]])
  expect(f.snapshot().activeId).toBe('design:canvas-1')
  f.languageChanged()
  const tab = f.snapshot().tabs.find((item: any) => item.id === 'design:canvas-1')
  expect(tab.title).toBe('Landing explorations')
  await f.close('canvas-1')
  expect(f.calls.at(-1)).toEqual(['close', 'canvas-1'])
  expect(f.snapshot().tabs.some((item: any) => item.kind === 'design')).toBe(false)
})

test('background Design Canvas opens queue until the owning chat is active', async () => {
  let session = 'chat-a'
  const openedTabs: unknown[] = [], replies: unknown[] = []
  const surface = createDesignPanel({
    api: () => ({
      panelShow: async () => ({ ok: true }),
      panelSetBounds: async () => ({ ok: true }),
      panelHide: async () => {},
      panelClose: async () => {},
      openResult: async (...args) => { replies.push(args) },
    }),
    currentSession: () => session,
    visible: () => true,
    bounds: () => ({ x: 0, y: 0, width: 640, height: 800 }),
    layout: async () => {},
    openMode: () => {},
    openTab: async payload => { openedTabs.push(payload); return true },
    toast: () => {},
    text: key => key,
    schedule: () => {},
  })
  await surface.onOpen({ requestId: 'req-1', id: 'canvas-b', title: 'Mobile flow', sessionId: 'chat-b' })
  expect(openedTabs).toHaveLength(0)
  expect(replies).toEqual([['req-1', false, 'design_background_pending']])
  session = 'chat-b'
  await surface.sessionChanged('chat-b')
  expect(openedTabs).toEqual([{ requestId: undefined, id: 'canvas-b', title: 'Mobile flow', sessionId: 'chat-b' }])
})

test('visual artifact normalization supports design created and ready states', () => {
  const created = normalizeVisualArtifact({ kind: 'design', id: 'c1', title: 'Poster', ready: false })
  expect(created).toEqual({ kind: 'design', id: 'c1', title: 'Poster', ready: false })
  expect(visualArtifactHintState(created!)).toBe('created')
  const ready = normalizeVisualArtifact({ kind: 'design', id: 'c1', title: '' })
  expect(ready).toEqual({ kind: 'design', id: 'c1', title: 'Design Canvas' })
  expect(visualArtifactHintState(ready!)).toBe('ready')
})
