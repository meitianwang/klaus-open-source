import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createStore } from 'zustand/vanilla'
import { createPhotoEditingPanel, photoEditingPanelBounds, preferredPhotoEditingPanelWidth } from './photo-editing-panel'
import { normalizeVisualArtifact, visualArtifactHintState } from './transcript/factories'
import { semanticActivity, semanticActivityLabel } from './transcript/activity-semantic'

const script = transpileModule(`${readFileSync(new URL('./panels/panel-tabs.tsx', import.meta.url), 'utf8')}\n;({ store, closePhotoEditing: id => closeTab(find('photo-editing', id)) });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
}).outputText

test('photo-editing bounds preserve fractional CSS pixels and reject invalid rectangles', () => {
  expect(photoEditingPanelBounds({ left: 88.5, top: 40.25, width: 760.5, height: 680.75 }))
    .toEqual({ x: 88.5, y: 40.25, width: 760.5, height: 680.75 })
  expect(photoEditingPanelBounds(null)).toBeNull()
  expect(photoEditingPanelBounds({ left: 0, top: 0, width: 0, height: 600 })).toBeNull()
  expect(photoEditingPanelBounds({ left: Number.NaN, top: 0, width: 480, height: 600 })).toBeNull()
})

test('preferredPhotoEditingPanelWidth widens default panels when workspace width permits without shrinking wider panels', () => {
  expect(preferredPhotoEditingPanelWidth(460, 1200)).toBe(780)
  expect(preferredPhotoEditingPanelWidth(460, 1440)).toBe(880)
  expect(preferredPhotoEditingPanelWidth(920, 1440)).toBeNull()
  expect(preferredPhotoEditingPanelWidth(460, 820)).toBeNull()
})

function tabsFixture() {
  let session = 'chat-a', mode = 'monitor', active = ''
  const storage = new Map<string, string>()
  const calls: unknown[] = []
  const listeners = new Map<string, () => void>()
  const window: any = {
    dispatchEvent() {},
    addEventListener: (name: string, listener: () => void) => { listeners.set(name, listener) },
    getCurrentSessionId: () => session,
    klausActivatePhotoEditingPanel: async (payload: { id: string; sessionId: string }) => {
      calls.push(['show', payload])
      active = payload.id
      mode = 'photo-editing'
      return true
    },
    klausActivePhotoEditingId: () => active,
    klausClosePhotoEditingPanel: async (id: string) => { calls.push(['close', id]); active = '' },
    klausOpenMonitorPanel: () => { mode = 'monitor' },
  }
  const imports: Record<string, unknown> = {
    react: {}, 'react/jsx-runtime': {}, 'react-dom': {}, 'react-dom/client': {}, zustand: {},
    'zustand/vanilla': { createStore },
    '../../app/window-state': { windowStateKey: (key: string) => key }, '../../icons/registry': { icon: () => '' },
    '../subagent-avatar': {}, '../subagent-identity': {}, '../subagent-state': { subscribeSubagents() {} }, './panels.module.css': {},
  }
  const runtime = runInNewContext(script, {
    window, CustomEvent, exports: {},
    require: (name: string) => { if (!(name in imports)) throw Error(`Unexpected import: ${name}`); return imports[name] },
    document: {
      getElementById: (id: string) => id === 'artifacts-panel' ? { classList: { contains: () => false }, getAttribute: () => mode } : null,
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
    snapshot: () => runtime.store.getState(),
    close: runtime.closePhotoEditing,
    calls,
    switchSession: (value: string) => { session = value },
    languageChanged: () => listeners.get('klaus:lang-change')?.(),
  }
}

test('photo-editing tabs route owned workspaces to the native view and retain titles across language switches', async () => {
  const f = tabsFixture()
  expect(await f.actions.openPhotoEditing({ id: 'photo-1', title: 'Spring Poster Retouch', sessionId: 'chat-a' })).toBe(true)
  expect(f.calls).toEqual([['show', { id: 'photo-1', title: 'Spring Poster Retouch', sessionId: 'chat-a' }]])
  expect(f.snapshot().activeId).toBe('photo-editing:photo-1')
  f.languageChanged()
  const tab = f.snapshot().tabs.find((item: any) => item.id === 'photo-editing:photo-1')
  expect(tab.title).toBe('Spring Poster Retouch')
  await f.close('photo-1')
  expect(f.calls.at(-1)).toEqual(['close', 'photo-1'])
  expect(f.snapshot().tabs.some((item: any) => item.kind === 'photo-editing')).toBe(false)
})

test('background photo-editing opens queue until the owning chat becomes active', async () => {
  let session = 'chat-a'
  const openedTabs: unknown[] = [], replies: unknown[] = []
  const surface = createPhotoEditingPanel({
    api: () => ({
      panelShow: async () => ({ ok: true }),
      panelSetBounds: async () => {},
      panelHide: async () => {},
      panelClose: async () => {},
      openResult: async (requestId: string, ok: boolean, error?: string) => { replies.push([requestId, ok, error]) },
    }) as any,
    currentSession: () => session,
    visible: () => true,
    bounds: () => ({ x: 0, y: 0, width: 880, height: 640 }),
    layout: async () => {},
    openMode: () => {},
    openTab: async payload => { openedTabs.push(payload); return true },
    toast: () => {},
    text: key => key,
    schedule: () => {},
  })
  await surface.onOpen({ requestId: 'req-bg', id: 'photo-bg', title: 'Key Visual', sessionId: 'chat-b' })
  expect(openedTabs).toEqual([])
  expect(replies).toEqual([['req-bg', false, 'photo_editing_background_pending']])
  session = 'chat-b'
  await surface.sessionChanged('chat-b')
  expect(openedTabs).toEqual([{ id: 'photo-bg', title: 'Key Visual', sessionId: 'chat-b' }])
})

test('visual artifact normalization and semantic activity recognize photo-editing tools', () => {
  const created = normalizeVisualArtifact({ kind: 'photo-editing', id: 'photo-1', title: 'Hero Retouch', ready: false })
  const ready = normalizeVisualArtifact({ kind: 'photo-editing', id: 'photo-1', title: '' })
  expect(created).toEqual({ kind: 'photo-editing', id: 'photo-1', title: 'Hero Retouch', ready: false })
  expect(ready).toEqual({ kind: 'photo-editing', id: 'photo-1', title: 'Photo Editing' })
  expect(visualArtifactHintState(created!)).toBe('created')
  expect(visualArtifactHintState(ready!)).toBe('ready')

  const indirect = semanticActivity('call_mcp_tool', {
    name: 'mcp__host-photo-editing__photo_open',
    arguments: { title: 'Summer Key Visual' },
  })
  expect(indirect).toEqual({
    action: 'photo_open',
    icon: 'tool-generate-image',
    target: 'Summer Key Visual',
    category: 'design',
  })
  expect(semanticActivityLabel(indirect!, 'done', 'zh')).toContain('打开图像编辑')
  expect(semanticActivityLabel(indirect!, 'done', 'en')).toContain('Opened photo workspace')
})

test('overlay suspension mounts a still snapshot in the photo-editing host and clears it on resume', async () => {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const prevWidth = Object.getOwnPropertyDescriptor(globalThis, 'innerWidth')
  const mounted: any[] = []
  const rootProps = new Map<string, string>()
  try {
    Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1440 })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        documentElement: {
          style: {
            setProperty: (k: string, v: string) => rootProps.set(k, v),
            removeProperty: (k: string) => rootProps.delete(k),
          },
        },
        createElement: () => {
          const img: any = {
            className: '',
            alt: '',
            draggable: true,
            src: '',
            setAttribute() {},
            decode: async () => {},
            remove: () => {
              const idx = mounted.indexOf(img)
              if (idx >= 0) mounted.splice(idx, 1)
            },
          }
          return img
        },
      },
    })
    const host = { appendChild: (node: unknown) => { mounted.push(node); return node } }
    const surface = createPhotoEditingPanel({
      api: () => ({
        panelShow: async () => ({ ok: true }),
        panelSetBounds: async () => ({ ok: true }),
        panelHide: async () => ({ ok: true, snapshotDataUrl: 'data:image/jpeg;base64,AAAA' }),
        panelClose: async () => ({ ok: true }),
        openResult: async () => {},
      }),
      currentSession: () => 'chat-a',
      visible: () => true,
      bounds: () => ({ x: 560, y: 40, width: 880, height: 860 }),
      layout: async () => {},
      openMode: () => {},
      openTab: async () => true,
      toast: () => {},
      text: key => key,
      schedule: () => {},
      host: () => host,
    })

    expect(await surface.activate({ id: 'photo-1', title: 'Retouch', sessionId: 'chat-a' })).toBe(true)
    expect(rootProps.get('--klaus-native-panel-inset-right')).toBe('880px')
    expect(mounted).toHaveLength(0)

    await surface.suspend()
    expect(rootProps.has('--klaus-native-panel-inset-right')).toBe(false)
    expect(mounted).toHaveLength(1)
    expect(mounted[0].className).toBe('browser-overlay-snapshot')
    expect(mounted[0].src).toBe('data:image/jpeg;base64,AAAA')

    await surface.resume()
    expect(mounted).toHaveLength(0)
    expect(rootProps.get('--klaus-native-panel-inset-right')).toBe('880px')
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc)
    else Reflect.deleteProperty(globalThis, 'document')
    if (prevWidth) Object.defineProperty(globalThis, 'innerWidth', prevWidth)
    else Reflect.deleteProperty(globalThis, 'innerWidth')
  }
})

