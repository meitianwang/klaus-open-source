import { expect, test } from 'bun:test'
import { AUTH_MODE_ORDER, normalizeAuthMode, sourceLabel } from './model-shared'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { authErrorText, cancelAntigravityLogin, cancelCursorLogin, importLocalSubscription, loginThroughDeviceFlow, SUBSCRIPTION_SOURCES, SubscriptionCardBody } from './subscription-card'
import { IMAGE_GENERATION_SOURCES, VIDEO_GENERATION_SOURCES, AUDIO_GENERATION_SOURCES } from './generation-sources'
import { resolveWebSearchSettings } from '../../../../contracts/web-search-settings'
import { I18N } from '../../i18n/messages'

test('Antigravity is an independent cloud source with supported media and search selections', () => {
  expect(AUTH_MODE_ORDER).toContain('antigravity')
  expect(normalizeAuthMode('antigravity')).toBe('antigravity')
  expect(sourceLabel('antigravity', key => I18N.en[key])).toBe('Antigravity')
  expect(IMAGE_GENERATION_SOURCES).toContain('antigravity')
  expect(VIDEO_GENERATION_SOURCES).not.toContain('antigravity')
  expect(AUDIO_GENERATION_SOURCES).not.toContain('antigravity')
  expect(resolveWebSearchSettings({ source: 'antigravity', enabled: true })).toEqual({ source: 'antigravity', enabled: true, mode: 'client' })
})

const source = SUBSCRIPTION_SOURCES.antigravity

async function withAccountWindow(run: (calls: unknown[], target: any) => Promise<void>, api: Record<string, unknown>) {
  const target = globalThis as any, previousWindow = target.window, previousTimeout = globalThis.setTimeout
  const calls: unknown[] = []
  target.window = { currentLang: 'en', currentSessionId: 'chat-one', dispatchEvent: (event: Event) => { calls.push(event.type) },
    klausDialog: { confirm: async () => true }, klaus: {
      antigravityAuth: api,
      session: { setMainModel: async (...args: unknown[]) => { calls.push(['set', ...args]) } },
    } }
  globalThis.setTimeout = ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout
  try { await run(calls, target) } finally {
    await cancelAntigravityLogin()
    target.window = previousWindow
    globalThis.setTimeout = previousTimeout
  }
}

const browserFlow = (flowId = 'browser-flow') => ({ ok: true, flowId, authUrl: 'https://accounts.example.invalid/authorize', expiresAt: Date.now() + 60_000, interval: 1 })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('browser login and local reuse have separate actions and activate only their requested conversation', async () => {
  expect(source.login).toBe(loginThroughDeviceFlow)
  expect(source.loginLabel).toBe('antigravity_login')
  expect(source.importLabel).toBe('antigravity_reuse_login')
  const requests: unknown[] = []
  await withAccountWindow(async (calls, target) => {
    await source.login(source, () => {}, () => { requests.push('reload') })
    expect(calls).toEqual([['set', 'auto', 'chat-one', 'antigravity'], 'klaus:auth-mode-changed'])
    target.window.currentSessionId = 'chat-two'
    await importLocalSubscription(source, () => {}, () => { requests.push('reload') })
    expect(calls).toEqual([['set', 'auto', 'chat-one', 'antigravity'], 'klaus:auth-mode-changed', ['set', 'auto', 'chat-two', 'antigravity'], 'klaus:auth-mode-changed'])
    expect(requests).toEqual(['start', ['poll', 'browser-flow'], 'reload', 'reuse', 'reload'])
  }, {
    start: async () => { requests.push('start'); return browserFlow() },
    poll: async (flowId: string) => { requests.push(['poll', flowId]); return { ok: true } },
    importLocal: async () => { requests.push('reuse'); return { ok: true } },
  })
})

test('browser completion preserves its originating session and retires cancellation before remount', async () => {
  const requests: unknown[] = []
  await withAccountWindow(async (calls, target) => {
    target.window.klaus.session.setMainModel = async (...args: unknown[]) => {
      calls.push(['set', ...args])
      await cancelAntigravityLogin()
    }
    await source.login(source, () => {}, () => { requests.push('reload'); void cancelAntigravityLogin() })
    expect(calls).toEqual([['set', 'auto', 'chat-one', 'antigravity'], 'klaus:auth-mode-changed'])
    expect(requests).toEqual(['reload'])
    const html = renderToStaticMarkup(createElement(SubscriptionCardBody, { mode: 'antigravity', reloadSeq: 0, reload: () => {} }))
    expect(html).toContain(I18N.en.auth_logged_in)
    expect(html).not.toContain('<button')
    expect(html).not.toContain('card-actions')
  }, {
    start: async () => browserFlow(),
    poll: async () => { (globalThis as any).window.currentSessionId = 'other-session'; return { ok: true } },
    cancel: async (flowId: string) => { requests.push(['cancel', flowId]); return { ok: true } },
  })
})

test('cancelling a delayed start cancels only its eventual flow without polling or activating', async () => {
  const start = deferred<unknown>(), requests: unknown[] = [], statuses: string[] = []
  await withAccountWindow(async calls => {
    const login = source.login(source, status => statuses.push(status), () => { calls.push('reload') })
    await cancelAntigravityLogin()
    start.resolve(browserFlow('late-start'))
    await login
    expect(requests).toEqual([['cancel', 'late-start']])
    expect(calls).toEqual([])
    expect(statuses).toEqual([I18N.en.antigravity_login_opening])
  }, {
    start: () => start.promise,
    poll: async () => { requests.push('poll'); return { ok: true } },
    cancel: async (flowId: string) => { requests.push(['cancel', flowId]); return { ok: true } },
  })
})

test('cancelling an in-flight poll fences its delayed successful result', async () => {
  const poll = deferred<unknown>(), entered = deferred<void>(), requests: unknown[] = [], statuses: string[] = []
  await withAccountWindow(async calls => {
    const login = source.login(source, status => statuses.push(status), () => { calls.push('reload') })
    await entered.promise
    await cancelAntigravityLogin()
    poll.resolve({ ok: true })
    await login
    expect(requests).toEqual([['poll', 'cancel-poll'], ['cancel', 'cancel-poll']])
    expect(calls).toEqual([])
    expect(statuses).toEqual([I18N.en.antigravity_login_opening])
  }, {
    start: async () => browserFlow('cancel-poll'),
    poll: (flowId: string) => { requests.push(['poll', flowId]); entered.resolve(); return poll.promise },
    cancel: async (flowId: string) => { requests.push(['cancel', flowId]); return { ok: true } },
  })
})

test('superseded starts and delayed cancellation cannot retire a newer login', async () => {
  const oldStart = deferred<unknown>(), newStart = deferred<unknown>(), oldCancel = deferred<unknown>()
  const requests: unknown[] = []
  let starts = 0
  await withAccountWindow(async calls => {
    const oldLogin = source.login(source, () => {}, () => { calls.push('old-reload') })
    const newLogin = source.login(source, () => {}, () => { calls.push('new-reload') })
    oldStart.resolve(browserFlow('old-flow'))
    await Promise.resolve()
    const cancelNew = cancelAntigravityLogin()
    newStart.resolve(browserFlow('new-flow'))
    await cancelNew
    oldCancel.resolve({ ok: true })
    await Promise.all([oldLogin, newLogin])
    expect(requests).toEqual([['cancel', 'old-flow'], ['cancel', 'new-flow']])
    expect(calls).toEqual([])
  }, {
    start: () => ++starts === 1 ? oldStart.promise : newStart.promise,
    poll: async () => { requests.push('poll'); return { ok: true } },
    cancel: (flowId: string) => { requests.push(['cancel', flowId]); return flowId === 'old-flow' ? oldCancel.promise : Promise.resolve({ ok: true }) },
  })
})

test('expired browser sessions show recovery text and release their pending listener', async () => {
  const requests: unknown[] = [], statuses: string[] = []
  await withAccountWindow(async calls => {
    await source.login(source, status => statuses.push(status), () => { calls.push('reload') })
    expect(statuses.at(-1)).toBe(I18N.en.antigravity_browser_login_expired)
    expect(requests).toEqual([['cancel', 'expired-flow']])
    expect(calls).toEqual([])
  }, {
    start: async () => ({ ...browserFlow('expired-flow'), expiresAt: Date.now() - 1 }),
    cancel: async (flowId: string) => { requests.push(['cancel', flowId]); return { ok: true } },
  })
})

test('account-only login and reuse leave conversation preferences intact', async () => {
  await withAccountWindow(async calls => {
    let reloads = 0
    for (const login of [source.login, importLocalSubscription]) await login(source, () => {}, () => { reloads++ }, { activateModel: false })
    expect(reloads).toBe(2)
    expect(calls).toEqual(['klaus:auth-mode-changed', 'klaus:auth-mode-changed'])
  }, { start: async () => browserFlow(), poll: async () => ({ ok: true }), importLocal: async () => ({ ok: true }) })
})

test('account and search copy is available in both interface languages', () => {
  for (const language of ['en', 'zh'] as const) for (const key of ['auth_antigravity', 'voice_source_antigravity', 'antigravity_login', 'antigravity_login_opening', 'antigravity_browser_login_expired', 'antigravity_import_confirm', 'antigravity_import_success', 'antigravity_import_failed_prefix', 'antigravity_reuse_login', 'antigravity_login_expired', 'antigravity_refresh_unavailable', 'klaus_websearch_source_antigravity']) expect(I18N[language][key]).toBeTruthy()
})

for (const language of ['en', 'zh'] as const) {
  test(`browser login errors provide localized recovery in ${language}`, () => {
    const target = globalThis as any, previous = target.window
    target.window = { currentLang: language }
    try {
      for (const code of ['invalid_flow', 'cancelled', 'expired', 'denied', 'callback_invalid', 'network_error', 'invalid_response', 'failed', 'store_failed', 'random_failed', 'callback_unavailable', 'credential_changed', 'endpoint_invalid', 'url_invalid', 'browser_failed']) {
        const message = authErrorText(source, `antigravity_login_${code}`)
        expect(message).not.toBe(I18N[language].auth_unknown_error)
        expect(message).not.toContain('antigravity_login_')
      }
    } finally { target.window = previous }
  })
}


test('Cursor replacement does not acquire the native source cancel-on-supersession policy', async () => {
  const target = globalThis as any, previousWindow = target.window, previousTimeout = globalThis.setTimeout
  const polls = [deferred<unknown>(), deferred<unknown>()], entered = [deferred<void>(), deferred<void>()]
  const cancelled: string[] = []
  let starts = 0
  target.window = { currentLang: 'en', currentSessionId: 'thread', dispatchEvent: () => {}, klaus: {
    cursorAuth: { start: async () => browserFlow(`cursor-${++starts}`), poll: (flow: string) => {
      const index = flow === 'cursor-1' ? 0 : 1; entered[index].resolve(); return polls[index].promise
    }, cancel: async (flow: string) => { cancelled.push(flow); return { ok: true } } },
    session: { setMainModel: async () => {} },
  } }
  globalThis.setTimeout = ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout
  try {
    const cursor = SUBSCRIPTION_SOURCES.cursor
    const first = loginThroughDeviceFlow(cursor, () => {}, () => {}, { activateModel: false })
    await entered[0].promise
    const second = loginThroughDeviceFlow(cursor, () => {}, () => {}, { activateModel: false })
    await entered[1].promise
    expect(cancelled).toEqual([])
    await cancelCursorLogin()
    expect(cancelled).toEqual(['cursor-2'])
    polls[0].resolve({ ok: true }); polls[1].resolve({ ok: true })
    await Promise.all([first, second])
  } finally { await cancelCursorLogin(); target.window = previousWindow; globalThis.setTimeout = previousTimeout }
})

test('native browser replacement cancels only its prior flow without inheriting Cursor ownership', async () => {
  const polls = [deferred<unknown>(), deferred<unknown>()], entered = [deferred<void>(), deferred<void>()]
  const cancelled: string[] = []
  let starts = 0
  await withAccountWindow(async () => {
    const first = loginThroughDeviceFlow(source, () => {}, () => {}, { activateModel: false })
    await entered[0].promise
    const second = loginThroughDeviceFlow(source, () => {}, () => {}, { activateModel: false })
    await entered[1].promise
    expect(cancelled).toEqual(['native-1'])
    await cancelAntigravityLogin()
    expect(cancelled).toEqual(['native-1', 'native-2'])
    polls[0].resolve({ ok: true }); polls[1].resolve({ ok: true })
    await Promise.all([first, second])
  }, {
    start: async () => browserFlow(`native-${++starts}`),
    poll: (flow: string) => { const index = flow === 'native-1' ? 0 : 1; entered[index].resolve(); return polls[index].promise },
    cancel: async (flow: string) => { cancelled.push(flow); return { ok: true } },
  })
})
