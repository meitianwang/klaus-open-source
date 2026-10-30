import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createStore } from 'zustand/vanilla'
import { selectSideTaskQuoteTarget, type SideTaskQuotePanel } from '../../../../contracts/side-task-quotes'
import vectors from '../../../../contracts/vectors/side-task-quote-routing-vectors.json'

// Execute the actual registry and its drag/drop mutation, without mounting React.
const script = transpileModule(`${readFileSync(new URL('./panel-tabs.tsx', import.meta.url), 'utf8')}\n;({ moveTab, store });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
}).outputText

export function createPanelTabsFixture(window: any, panel: any) {
  window.dispatchEvent ??= () => true
  const storage = new Map<string, string>()
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
    document: { getElementById: (id: string) => id === 'artifacts-panel' ? panel : null, body: { classList: { toggle() {} } } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } },
  })
  return { actions: window.KlausPanelTabs, snapshot: () => api.store.getState(),
    move: (from: string, to: string, after = false) => api.moveTab(`side-task:${from}`, `side-task:${to}`, after) }
}

function fixture() {
  let mode = 'side-chat'
  const panel = { classList: { contains: () => false }, getAttribute: () => mode }
  const f = createPanelTabsFixture({ addEventListener() {}, getCurrentSessionId: () => 'main' }, panel)
  return { ...f, setMode: (next: string) => { mode = next } }
}

for (const vector of vectors.targetCases) {
  test(`quote routing vector: ${vector.id}`, () => {
    const available = new Set(vector.available)
    expect(selectSideTaskQuoteTarget(vector.panels as SideTaskQuotePanel[], id => available.has(id))).toBe(vector.target)
  })
}

test('the strip query follows the real drag reorder and retains it across owner refreshes', () => {
  const f = fixture()
  f.actions.syncSideTasks([{ id: 'one' }, { id: 'two' }, { id: 'three' }], 'two')
  expect(f.actions.sideTaskQuotePanels()).toEqual([{ placement: 'right', activeId: 'two', tabs: ['one', 'two', 'three'] }])
  expect(f.move('three', 'one')).toBe(true)
  expect(f.actions.sideTaskQuotePanels()[0].tabs).toEqual(['three', 'one', 'two'])
  f.actions.syncSideTasks([{ id: 'one', title: 'New title' }, { id: 'two' }, { id: 'three' }], 'two')
  expect(f.actions.sideTaskQuotePanels()[0].tabs).toEqual(['three', 'one', 'two'])
  expect(f.snapshot().tabs.find((tab: any) => tab.key === 'one').title).toBe('New title')
  expect(selectSideTaskQuoteTarget(f.actions.sideTaskQuotePanels(), () => true)).toBe('two')
  f.setMode('workspace')
  f.actions.onModeChanged('workspace')
  expect(f.actions.sideTaskQuotePanels()[0].activeId).toBeNull()
  expect(selectSideTaskQuoteTarget(f.actions.sideTaskQuotePanels(), () => true)).toBe('three')
})

test('non-side tabs are excluded and a removed active side cannot remain a quote target', () => {
  const f = fixture()
  f.actions.syncSideTasks([{ id: 'one' }, { id: 'two' }], 'two')
  f.actions.syncBrowserTabs([{ id: 'browser', title: 'Browser' }])
  f.actions.syncSideTasks([{ id: 'one' }], null)
  expect(f.actions.sideTaskQuotePanels()).toEqual([{ placement: 'right', activeId: null, tabs: ['one'] }])
  expect(selectSideTaskQuoteTarget(f.actions.sideTaskQuotePanels(), () => true)).toBe('one')
})

test('side title overrides preserve empty strings and raw Markdown', () => {
  const f = fixture()
  f.actions.syncSideTasks([{ id: 'empty', title: '' }, { id: 'raw', title: '**Raw title**' }], 'empty')
  expect(f.snapshot().tabs.find((tab: any) => tab.key === 'empty').title).toBe('')
  expect(f.snapshot().tabs.find((tab: any) => tab.key === 'raw').title).toBe('**Raw title**')
  f.actions.syncSideTasks([{ id: 'empty', title: 'Previous' }, { id: 'raw', title: '' }], 'empty')
  expect(f.snapshot().tabs.find((tab: any) => tab.key === 'raw').title).toBe('')
})
