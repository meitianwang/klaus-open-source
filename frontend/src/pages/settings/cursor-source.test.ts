import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../../contracts/vectors/cursor-native-service-ui-vectors.json'
import { I18N } from '../../i18n/messages'
import { AUTH_MODE_ORDER, normalizeAuthMode, sourceLabel } from './model-shared'
import { authErrorText, cancelCursorLogin, importLocalSubscription, loginThroughHost, loginThroughDeviceFlow, SUBSCRIPTION_SOURCES, SubscriptionCardBody } from './subscription-card'

const source = SUBSCRIPTION_SOURCES.cursor

function withWindow<T>(value: Record<string, unknown>, run: () => T): T {
  const target = globalThis as any
  const previous = target.window
  target.window = value
  try { return run() } finally { target.window = previous }
}

describe('Cursor account source', () => {
  test('has independent browser login, local account reuse and bilingual copy', () => {
    expect(normalizeAuthMode('cursor')).toBe('cursor')
    expect(AUTH_MODE_ORDER).toContain('cursor')
    expect(source.apiKey).toBeUndefined()
    expect(source.login).toBe(loginThroughDeviceFlow)
    expect(source.idPrefix).toBe('cursor-auth')
    for (const language of ['en', 'zh'] as const) {
      expect(sourceLabel('cursor', key => I18N[language][key])).toBe('Cursor')
      for (const key of [source.label, source.accountFallback, source.notLoggedIn, source.loginLabel,
        source.importLabel!, source.logoutLabel, source.loginOpening,
        source.importConfirm!, source.importing!, source.importSuccess!, source.importFailedPrefix!,
        source.confirmLogout, 'auth_mode_switched_cursor', 'usage_provider_cursor']) {
        expect(I18N[language][key]).toBeTypeOf('string')
      }
    }
  })

  test('import failure displays recovery without activating any source', async () => {
    const target = globalThis as any
    const previous = target.window
    const writes: unknown[] = []
    const statuses: string[] = []
    let reloads = 0
    target.window = { currentLang: 'en', klausDialog: { confirm: async () => true }, klaus: {
      cursorAuth: { importLocal: async () => ({ ok: false, error: 'cursor_login_expired' }) },
      session: { setMainModel: async (...args: unknown[]) => { writes.push(args) } },
    } }
    try {
      await importLocalSubscription(source, value => statuses.push(value), () => { reloads++ })
      expect(statuses.at(-1)).toBe(I18N.en.cursor_import_failed_prefix + I18N.en.cursor_import_expired)
      expect(writes).toEqual([])
      expect(reloads).toBe(0)
    } finally { target.window = previous }
  })

  test('successful import activates Cursor and only offers sign-out while connected', async () => {
    const target = globalThis as any
    const previous = target.window
    const writes: unknown[] = []
    let reloads = 0
    target.window = { currentLang: 'en', currentSessionId: 'cursor-session',
      dispatchEvent: () => true, klausDialog: { confirm: async () => true }, klaus: {
        cursorAuth: { importLocal: async () => ({ ok: true }) },
        session: { setMainModel: async (...args: unknown[]) => { writes.push(args) } },
      } }
    try {
      await importLocalSubscription(source, () => {}, () => { reloads++ })
      expect(writes).toEqual([['auto', 'cursor-session', 'cursor']])
      expect(reloads).toBe(1)
      const html = withWindow({ currentLang: 'en' }, () => renderToStaticMarkup(createElement(SubscriptionCardBody, {
        mode: 'cursor', reloadSeq: 0, reload: () => {},
      })))
      for (const action of vectors.connectedAccountActions) expect(html).toContain(`cursor-auth-${action}-btn`)
      expect(html).not.toContain('cursor-auth-import-btn')
      expect(html).not.toContain('cursor-auth-login-btn')
      expect(html.match(/<button\b/g)).toHaveLength(vectors.connectedAccountActions.length)
      expect(html).not.toContain('type="password"')
    } finally { target.window = previous }
  })

  for (const language of ['en', 'zh'] as const) {
    test(`separates expired imports and inference endpoint refusals in ${language}`, () => {
      withWindow({ currentLang: language }, () => {
        expect(authErrorText(source, 'cursor_login_expired')).toBe(I18N[language].cursor_import_expired)
        expect(authErrorText(source, 'cursor_browser_login_expired')).toBe(I18N[language].cursor_browser_login_expired)
        expect(authErrorText(source, 'cursor_browser_metadata_unavailable')).toBe(I18N[language].cursor_browser_metadata_unavailable)
        expect(authErrorText(source, 'cursor_client_metadata_missing')).toBe(I18N[language].cursor_import_metadata_missing)
        expect(authErrorText(source, 'cursor_model_response_unsupported: cursor_native_tool_rejected')).toBe(I18N[language].cursor_model_response_unsupported)
        expect(authErrorText(source, 'cursor_inference_not_enabled')).toBe(I18N[language].cursor_inference_not_enabled)
        expect(authErrorText(source, 'cursor_local_state_not_found')).toBe(I18N[language].auth_err_cursor_not_found)
        expect(authErrorText(source, 'cursor_local_metadata_unreadable')).toBe(I18N[language].auth_err_cursor_unreadable)
        expect(authErrorText(source, 'cursor_adopted_credential_needs_reimport')).toBe(I18N[language].cursor_import_expired)
        expect(authErrorText(source, 'Cursor: cursor_adopted_credential_needs_reimport: token expired')).toBe(I18N[language].cursor_import_expired)
        expect(authErrorText(source, 'Cursor: cursor_inference_not_enabled (HTTP 403)')).toBe(I18N[language].cursor_inference_not_enabled)
        expect(authErrorText(source, 'Cursor: cursor_unrecognized_diagnostic: failure')).toBe(I18N[language].auth_unknown_error)
        expect(authErrorText(source, 'Cursor: cursor_login_expired_unrecognized: failure')).toBe(I18N[language].auth_unknown_error)
        expect(authErrorText(source, 'Usage request timed out. Please try again.')).toBe('Usage request timed out. Please try again.')
      })
    })
  }
})


test('Cursor bridge forwards catalog refresh and independent browser login channels', async () => {
  const file = ts.createSourceFile('klaus-api.ts', readFileSync(new URL('../../../bridge/klaus-api.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'cursorAuth') initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!initializer) throw new Error('Cursor account bridge must be identifiable')
  const code = ts.transpileModule(`(${initializer.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const requests: unknown[] = []
  const bridge = runInNewContext(code, { call: async (channel: string, payload: unknown) => { requests.push({ channel, payload }); return { ok: true } } }) as {
    models(forceRefresh?: boolean): Promise<unknown>
    start(): Promise<unknown>; poll(flowId: string): Promise<unknown>; cancel(flowId: string): Promise<unknown>
  }
  await bridge.models()
  await bridge.models(true)
  await bridge.models(false)
  await bridge.start()
  await bridge.poll('flow-1')
  await bridge.cancel('flow-1')
  expect(requests).toEqual([
    { channel: 'cursor-auth:models', payload: { forceRefresh: false } },
    { channel: 'cursor-auth:models', payload: { forceRefresh: true } },
    { channel: 'cursor-auth:models', payload: { forceRefresh: false } },
    { channel: 'cursor-auth:start', payload: undefined },
    { channel: 'cursor-auth:poll', payload: { flowId: 'flow-1' } },
    { channel: 'cursor-auth:cancel', payload: { flowId: 'flow-1' } },
  ])
})


test('browser login polls the named flow and activates only the session that started it', async () => {
  const target = globalThis as any
  const previousWindow = target.window
  const previousTimeout = globalThis.setTimeout
  const requests: unknown[] = []
  let reloads = 0
  target.window = { currentLang: 'en', currentSessionId: 'origin', dispatchEvent: () => true, klaus: {
    cursorAuth: {
      start: async () => ({ ok: true, flowId: 'browser-flow', expiresAt: Date.now() + 60_000, interval: 1 }),
      poll: async (id: string) => { requests.push(['poll', id]); target.window.currentSessionId = 'other'; return { ok: true } },
    },
    session: { setMainModel: async (...args: unknown[]) => { requests.push(['set', ...args]) } },
  } }
  globalThis.setTimeout = ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout
  try {
    await loginThroughDeviceFlow(source, () => {}, () => { reloads++ })
    expect(requests).toEqual([['poll', 'browser-flow'], ['set', 'auto', 'origin', 'cursor']])
    expect(reloads).toBe(1)
  } finally { target.window = previousWindow; globalThis.setTimeout = previousTimeout }
})

test('cancelling while the browser flow starts cancels its eventual flow without activating the source', async () => {
  const target = globalThis as any
  const previous = target.window
  let resolveStart!: (flow: unknown) => void
  const start = new Promise(resolve => { resolveStart = resolve })
  const requests: unknown[] = []
  target.window = { currentLang: 'en', klaus: {
    cursorAuth: { start: () => start, cancel: async (id: string) => { requests.push(['cancel', id]); return { ok: true } }, poll: async () => { requests.push(['poll']); return { ok: true } } },
    session: { setMainModel: async (...args: unknown[]) => { requests.push(['set', ...args]) } },
  } }
  try {
    const pending = loginThroughDeviceFlow(source, () => {}, () => { requests.push(['reload']) })
    await cancelCursorLogin()
    resolveStart({ ok: true, flowId: 'cancelled-flow', expiresAt: Date.now() + 60_000 })
    await pending
    expect(requests).toEqual([['cancel', 'cancelled-flow']])
  } finally { target.window = previous }
})

test('browser authorization publishes its account before model activation and retains it on activation failure', async () => {
  const target = globalThis as any, previousWindow = target.window, previousTimeout = globalThis.setTimeout
  const statuses: string[] = []
  let reloads = 0
  let entered!: () => void, rejectActivation!: (error: Error) => void
  const activating = new Promise<void>(resolve => { entered = resolve })
  const activation = new Promise<void>((_resolve, reject) => { rejectActivation = reject })
  target.window = { currentLang: 'en', currentSessionId: 'origin', dispatchEvent: () => true, klaus: {
    cursorAuth: {
      start: async () => ({ ok: true, flowId: 'account-first', expiresAt: Date.now() + 60_000, interval: 1 }),
      poll: async () => ({ ok: true, account: 'browser@example.invalid' }),
    },
    session: { setMainModel: () => { entered(); return activation } },
  } }
  globalThis.setTimeout = ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout
  try {
    const login = loginThroughDeviceFlow(source, value => statuses.push(value), () => { reloads++ })
    await activating
    expect(reloads).toBe(1)
    const html = renderToStaticMarkup(createElement(SubscriptionCardBody, { mode: 'cursor', reloadSeq: 0, reload: () => {} }))
    expect(html).toContain('browser@example.invalid')
    expect(html).toContain('cursor-auth-logout-btn')
    rejectActivation(new Error('model catalog unavailable'))
    await login
    expect(statuses.at(-1)).toBe(I18N.en.auth_switch_failed_prefix + 'model catalog unavailable')
    expect(reloads).toBe(1)
  } finally { target.window = previousWindow; globalThis.setTimeout = previousTimeout }
})

test('local reuse refreshes the connected account even when the selected model is unavailable', async () => {
  const target = globalThis as any, previousWindow = target.window
  const statuses: string[] = []
  let reloads = 0
  target.window = { currentLang: 'en', klausDialog: { confirm: async () => true }, klaus: {
    cursorAuth: { importLocal: async () => ({ ok: true, account: 'imported@example.invalid' }) },
    session: { setMainModel: async () => { throw new Error('model catalog unavailable') } },
  } }
  try {
    await importLocalSubscription(source, value => statuses.push(value), () => { reloads++ })
    expect(reloads).toBe(1)
    expect(statuses.at(-1)).toBe(I18N.en.auth_switch_failed_prefix + 'model catalog unavailable')
    const html = renderToStaticMarkup(createElement(SubscriptionCardBody, { mode: 'cursor', reloadSeq: 0, reload: () => {} }))
    expect(html).toContain('imported@example.invalid')
    expect(html).toContain('cursor-auth-logout-btn')
  } finally { target.window = previousWindow }
})

test('independent service account login and reuse preserve the conversation source', async () => {
  const target = globalThis as any, previousWindow = target.window, previousTimeout = globalThis.setTimeout;
  const calls: unknown[] = [];
  let reloads = 0;
  const account = { ...SUBSCRIPTION_SOURCES.qwenwork, api: () => ({
    importLocal: async () => ({ ok: true }), login: async () => ({ ok: true }),
    start: async () => ({ ok: true, flowId: 'service-account', expiresAt: Date.now() + 60_000, interval: 1 }),
    poll: async () => ({ ok: true }),
  }) };
  target.window = { currentLang: 'en', currentSessionId: 'language-session', dispatchEvent: (event: Event) => { calls.push(event.type) },
    klausDialog: { confirm: async () => true }, klaus: { session: { setMainModel: async (...args: unknown[]) => { calls.push(args) } } } };
  globalThis.setTimeout = ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout;
  try {
    for (const login of [importLocalSubscription, loginThroughHost, loginThroughDeviceFlow]) {
      await login(account, () => {}, () => { reloads++ }, { activateModel: false });
    }
    expect(reloads).toBe(3);
    expect(calls).toEqual(['klaus:auth-mode-changed', 'klaus:auth-mode-changed', 'klaus:auth-mode-changed']);
  } finally { target.window = previousWindow; globalThis.setTimeout = previousTimeout }
});
