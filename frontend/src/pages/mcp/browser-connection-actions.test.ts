import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isCallExpression, isVariableDeclaration, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { enableChromeConnection, prepareChromeConnection, readBrowserConnectionSettings, type BrowserConnectionApi } from './browser-connection-actions'

// Execute the modal's real callbacks with the production connection workflows.
// Only host and presentation effects are stubbed; no browser profile is touched.
const source = readFileSync(new URL('./browser-connect.tsx', import.meta.url), 'utf8')
const ast = createSourceFile('browser-connect.tsx', source, ScriptTarget.ESNext, true, ScriptKind.TSX)
const names = new Set(['refresh', 'chromeFailure', 'enableChrome', 'prepare'])
const declarations: string[] = []
function collect(node: any) {
  if (isVariableDeclaration(node) && names.has(node.name.getText(ast)) && node.initializer) {
    const initializer = node.name.getText(ast) === 'refresh' && isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer
    if (!initializer) throw new Error('The production browser callback must have an initializer')
    declarations.push(`const ${node.name.getText(ast)} = ${initializer.getText(ast)};`)
  }
  forEachChild(node, collect)
}
collect(ast)
const script = transpileModule(`${declarations.join('\n')}\n({ refresh, enableChrome, prepare });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

function fixture(options: { enabled?: boolean; chromeEnabled?: boolean; readError?: boolean; unknownRead?: boolean; setupError?: boolean; enableError?: boolean; clipboardError?: boolean } = {}) {
  const calls: string[] = [], toasts: string[] = []
  const preferences = { enabled: options.enabled ?? false, chromeEnabled: options.chromeEnabled ?? false }
  let nativeRegistered = false, reloads = 0
  const api: BrowserConnectionApi & { chromeDiagnostics(): Promise<unknown> } = {
    get: async () => { calls.push('get'); if (options.readError) throw new Error('Host read failed'); return options.unknownRead ? { chromeEnabled: true } : { ...preferences } },
    setEnabled: async enabled => { calls.push(`setEnabled:${enabled}`); if (options.enableError) return { ok: false, error: 'Plugin enablement refused' }; preferences.enabled = enabled; return { ok: true } },
    setChromeEnabled: async enabled => { calls.push(`setChromeEnabled:${enabled}`); preferences.chromeEnabled = enabled; return { ok: true } },
    setupChrome: async () => { calls.push('setupChrome'); if (options.setupError) return { ok: false, error: 'Native host registration failed' }; nativeRegistered = true; return { ok: true } },
    deployChromeExtension: async () => { calls.push('deployChromeExtension'); return { ok: true, extensionPath: '/isolated/chrome-extension' } },
    revealChromeExtension: async () => { calls.push('revealChromeExtension'); expect(nativeRegistered).toBe(true); return { ok: true } },
    chromeDiagnostics: async () => { calls.push('diagnostics'); return { ok: true, diagnostics: { runtimeReachable: true, nativeHostCorrect: nativeRegistered } } },
  }
  const states: Record<string, any> = {}
  const context: Record<string, any> = {
    w: () => ({ settingsApi: { browserUse: api } }), seqRef: { current: 0 }, connectionActionRef: { current: false }, guideTouchedRef: { current: false },
    chromeBusy: false, prepareBusy: false,
    enableChromeConnection, prepareChromeConnection, readBrowserConnectionSettings,
    setEnabled: (value: boolean) => { states.enabled = value }, setChromeEnabled: (value: boolean | null) => { states.chromeEnabled = value },
    setChromeBusy: (value: boolean) => { context.chromeBusy = value; states.chromeBusy = value },
    setPrepareBusy: (value: boolean) => { context.prepareBusy = value; states.prepareBusy = value },
    setAccessLoadFailed: (value: boolean) => { states.accessLoadFailed = value }, setDiag: (value: unknown) => { states.diag = value },
    setDeployedPath: (value: string) => { states.path = value }, flashCopied: (value: string) => { states.copied = value },
    setManualOpen: (value: boolean) => { states.manualOpen = value },
    writeClipboardText: async (path: string) => { calls.push(`copy:${path}`); expect(nativeRegistered).toBe(true); if (options.clipboardError) throw new Error('Clipboard unavailable') },
    reloadMcpView: () => { reloads++ }, showToast: (text: string) => { toasts.push(text) }, t: (key: string) => key,
  }
  const callbacks = runInNewContext(script, context) as { refresh(): Promise<void>; enableChrome(): Promise<void>; prepare(): Promise<void> }
  return { calls, preferences, states, toasts, callbacks, api, reloads: () => reloads, nativeRegistered: () => nativeRegistered }
}

describe('browser connection opt-in and manual native-host setup', () => {
  test('opening the modal reads both facts without enabling access or writing a native host', async () => {
    const f = fixture()
    await f.callbacks.refresh()
    expect(f.calls).toEqual(['get', 'diagnostics'])
    expect(f.preferences).toEqual({ enabled: false, chromeEnabled: false })
    expect(f.states.chromeEnabled).toBe(false)
    expect(f.nativeRegistered()).toBe(false)
    expect(f.toasts).toEqual([])
  })

  test('a connected disabled extension is explicitly enabled before its native host is repaired', async () => {
    const f = fixture({ enabled: true })
    await f.callbacks.enableChrome()
    expect(f.calls).toEqual(['get', 'setChromeEnabled:true', 'setupChrome', 'get', 'diagnostics'])
    expect(f.preferences).toEqual({ enabled: true, chromeEnabled: true })
    expect(f.nativeRegistered()).toBe(true)
    expect(f.toasts).toEqual(['browser_ext_access_enabled'])
    expect(f.reloads()).toBe(1)
  })

  test('manual preparation enables the engine-owned capability then registers the host before folder actions', async () => {
    const f = fixture()
    await f.callbacks.prepare()
    expect(f.calls).toEqual(['get', 'setEnabled:true', 'setChromeEnabled:true', 'deployChromeExtension', 'setupChrome',
      'copy:/isolated/chrome-extension', 'revealChromeExtension', 'get', 'diagnostics'])
    expect(f.states.path).toBe('/isolated/chrome-extension')
    expect(f.toasts).toEqual(['browser_ext_prepare_done'])
    expect(f.nativeRegistered()).toBe(true)
  })

  test('already-enabled access does not rewrite either preference during connection repair', async () => {
    const f = fixture({ enabled: true, chromeEnabled: true })
    await f.callbacks.enableChrome()
    expect(f.calls).toEqual(['get', 'setupChrome', 'get', 'diagnostics'])
  })

  test('a failed or unknown settings read performs no opt-in and remains available for retry', async () => {
    const f = fixture({ readError: true })
    await f.callbacks.refresh()
    expect(f.states.chromeEnabled).toBeNull()
    expect(f.states.accessLoadFailed).toBe(true)
    await f.callbacks.prepare()
    expect(f.calls.every(call => call === 'get' || call === 'diagnostics')).toBe(true)
    expect(f.nativeRegistered()).toBe(false)
    expect(f.states.prepareBusy).toBe(false)
    expect(f.toasts.some(text => text.includes('Host read failed'))).toBe(true)
  })

  test('a partial settings response remains unknown even if its Chrome flag is true', async () => {
    const f = fixture({ unknownRead: true })
    await f.callbacks.refresh()
    expect(f.states.chromeEnabled).toBeNull()
    expect(f.states.accessLoadFailed).toBe(true)
    await f.callbacks.enableChrome()
    expect(f.calls.every(call => call === 'get' || call === 'diagnostics')).toBe(true)
    expect(f.preferences).toEqual({ enabled: false, chromeEnabled: false })
  })

  test('refused engine enablement stops before external preferences and native-host installation', async () => {
    const f = fixture({ enableError: true })
    await f.callbacks.prepare()
    expect(f.calls).toEqual(['get', 'setEnabled:true', 'get', 'diagnostics'])
    expect(f.preferences.chromeEnabled).toBe(false)
    expect(f.toasts).toEqual(['toast_error_prefixPlugin enablement refused'])
    expect(f.reloads()).toBe(0)
  })

  test('native registration failure never reports installation ready or proceeds to folder actions', async () => {
    const f = fixture({ setupError: true })
    await f.callbacks.prepare()
    expect(f.calls).toEqual(['get', 'setEnabled:true', 'setChromeEnabled:true', 'deployChromeExtension', 'setupChrome', 'get', 'diagnostics'])
    expect(f.toasts).toEqual(['toast_error_prefixNative host registration failed'])
    expect(f.states.prepareBusy).toBe(false)
    expect(f.reloads()).toBe(0)
  })

  test('clipboard failure preserves a usable folder path and reports partial completion', async () => {
    const f = fixture({ clipboardError: true })
    await f.callbacks.prepare()
    expect(f.states.path).toBe('/isolated/chrome-extension')
    expect(f.states.manualOpen).toBe(true)
    expect(f.toasts).toEqual(['browser_ext_prepare_partial'])
    expect(f.calls).toContain('revealChromeExtension')
  })

  test('duplicate clicks cannot start a second opt-in or setup operation', async () => {
    const f = fixture()
    let resolveSetup!: (reply: { ok: boolean }) => void
    f.api.setupChrome = () => { f.calls.push('setupChrome'); return new Promise(resolve => { resolveSetup = resolve }) }
    const first = f.callbacks.enableChrome()
    for (let round = 0; round < 8; round++) await Promise.resolve()
    await f.callbacks.prepare()
    expect(f.calls).toEqual(['get', 'setEnabled:true', 'setChromeEnabled:true', 'setupChrome'])
    resolveSetup({ ok: true }); await first
    expect(f.calls.filter(call => call === 'setupChrome')).toHaveLength(1)
  })
})
