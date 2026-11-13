import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createPptPanel } from '../../chat/ppt-panel'

const script = transpileModule(readFileSync(new URL('./shell.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

function prewarmFixture(withDocument = true) {
  const callbacks: Array<() => void> = []
  const calls: string[] = []
  const document = { getElementById: () => ({ dataset: {} }) }
  const window: any = {
    ...(withDocument ? { document } : {}),
    requestIdleCallback: (callback: () => void) => callbacks.push(callback),
    reloadPluginsView: () => calls.push('plugins'),
    reloadSlashCommandsView: () => calls.push('commands'),
  }
  const context = {
    exports: {}, window, document,
    require: (name: string) => {
      if (name === '../../i18n') return { t: (key: string) => key }
      if (name === './kv') return { unmountSettingsTab() {} }
      if (name === './settings-error-text') return { settingsErrorText: () => '' }
      if (name === './settings.module.css') return { default: {} }
      throw Error(`Unexpected import: ${name}`)
    },
  }
  runInNewContext(script, context)
  return { callbacks, calls, context }
}

test('settings do not schedule DOM prewarming for a window without a document', () => {
  expect(prewarmFixture(false).callbacks).toHaveLength(0)
})

test('settings prewarm both catalog views on the owning live document', () => {
  const fixture = prewarmFixture()
  expect(fixture.callbacks).toHaveLength(1)
  fixture.callbacks[0]()
  expect(fixture.calls).toEqual(['plugins', 'commands'])
})

test('deferred settings prewarming ignores a replaced window or document', () => {
  for (const replace of ['window', 'document', 'closed'] as const) {
    const fixture = prewarmFixture()
    expect(fixture.callbacks).toHaveLength(1)
    if (replace === 'window') fixture.context.window = undefined
    else if (replace === 'document') fixture.context.window.document = undefined
    else fixture.context.window.closed = true
    expect(() => fixture.callbacks[0]()).not.toThrow()
    expect(fixture.calls).toEqual([])
  }
})

function fixture() {
  const classes = new Set<string>()
  const calls: string[] = []
  const pending: Promise<unknown>[] = []
  let nativeVisible = false
  let hold: Promise<void> | undefined
  const surface = createPptPanel({
    api: () => ({
      panelShow: async () => { calls.push('show'); await hold; nativeVisible = true; return { ok: true } },
      panelSetBounds: async () => ({ ok: true }),
      panelHide: async () => { calls.push('hide'); nativeVisible = false },
      panelClose: async () => { nativeVisible = false },
      openResult: async () => {},
    }),
    currentSession: () => 'chat-a', visible: () => true,
    bounds: () => ({ x: 600, y: 44, width: 600, height: 756 }),
    layout: async () => {}, openMode() {}, openTab: payload => surface.activate(payload),
    toast: message => calls.push(message), text: key => key, schedule() {},
  })
  const classList = {
    add: (name: string) => classes.add(name),
    remove: (name: string) => classes.delete(name),
    contains: (name: string) => classes.has(name),
  }
  const window: any = { dispatchEvent() {}, addEventListener() {}, requestIdleCallback() {}, klaus: { browserUse: { hide: async () => {} } } }
  for (const name of ['Canvas', 'Prototype', 'VideoEditing', 'Ppt']) {
    window[`klausSuspend${name}ForOverlay`] = () => {
      calls.push(`suspend:${name}`)
      const operation = name === 'Ppt' ? surface.suspend() : Promise.resolve()
      pending.push(operation)
      return operation
    }
    window[`klausResume${name}AfterOverlay`] = () => {
      calls.push(`resume:${name}`)
      const operation = name === 'Ppt' ? surface.resume() : Promise.resolve()
      pending.push(operation)
      return operation
    }
  }
  const exports: any = {}
  runInNewContext(script, {
    exports, window, CustomEvent, requestAnimationFrame() {},
    document: {
      activeElement: null, body: { classList: { add() {}, remove() {} } },
      getElementById: (id: string) => id === 'settings-view' ? { classList } : null,
      querySelectorAll: () => [], querySelector: () => null,
    },
    require: (name: string) => {
      if (name === '../../i18n') return { t: (key: string) => key }
      if (name === './kv') return { unmountSettingsTab() {} }
      if (name === './settings-error-text') return { logHostDiagnostic() {}, settingsErrorText: (_surface: string, _detail: unknown, key: string) => key }
      if (name === './settings.module.css') return { default: {} }
      throw Error(`Unexpected import: ${name}`)
    },
  })
  return {
    settings: exports, surface, calls, visible: () => nativeVisible,
    hold: (value: Promise<void> | undefined) => { hold = value },
    flush: async () => { while (pending.length) await Promise.all(pending.splice(0)) },
  }
}

test('settings hide an open presentation and restore its document on return', async () => {
  const f = fixture()
  expect(await f.surface.activate({ id: 'deck-a', sessionId: 'chat-a' })).toBe(true)
  expect(f.visible()).toBe(true)
  f.settings.openSettings('profile')
  await f.flush()
  expect(f.visible()).toBe(false)
  expect(f.surface.state().activeId).toBe('deck-a')
  await f.surface.syncBounds()
  expect(f.visible()).toBe(false)
  f.settings.closeSettings()
  await f.flush()
  expect(f.visible()).toBe(true)
  expect(f.surface.state().activeId).toBe('deck-a')
  expect(f.surface.state().overlays).toBe(0)
})

test('settings tab changes and repeated closes balance every native editor suspension', async () => {
  const f = fixture()
  f.settings.openSettings('profile')
  f.settings.openSettings('preferences')
  f.settings.closeSettings()
  f.settings.closeSettings()
  await f.flush()
  for (const name of ['Canvas', 'Prototype', 'VideoEditing', 'Ppt']) {
    expect(f.calls.filter(call => call === `suspend:${name}`)).toHaveLength(1)
    expect(f.calls.filter(call => call === `resume:${name}`)).toHaveLength(1)
  }
  f.settings.openSettings('profile')
  f.settings.closeSettings()
  await f.flush()
  expect(f.calls.filter(call => call === 'suspend:Ppt')).toHaveLength(2)
  expect(f.calls.filter(call => call === 'resume:Ppt')).toHaveLength(2)
})

test('an opening receipt cannot leave a presentation over settings', async () => {
  const f = fixture()
  let finish!: () => void
  f.hold(new Promise(resolve => { finish = resolve }))
  const opening = f.surface.activate({ id: 'deck-a', sessionId: 'chat-a' })
  while (!f.calls.includes('show')) await Promise.resolve()
  f.settings.openSettings('profile')
  finish()
  expect(await opening).toBe(false)
  await f.flush()
  expect(f.visible()).toBe(false)
  expect(f.surface.state().lastBounds).toBeNull()
  f.hold(undefined)
  f.settings.closeSettings()
  await f.flush()
  expect(f.visible()).toBe(true)
})

test('returning from settings respects another overlay suspension', async () => {
  const f = fixture()
  await f.surface.activate({ id: 'deck-a', sessionId: 'chat-a' })
  await f.surface.suspend()
  f.settings.openSettings('profile')
  await f.flush()
  f.settings.closeSettings()
  await f.flush()
  expect(f.visible()).toBe(false)
  expect(f.surface.state().overlays).toBe(1)
  await f.surface.resume()
  expect(f.visible()).toBe(true)
})
