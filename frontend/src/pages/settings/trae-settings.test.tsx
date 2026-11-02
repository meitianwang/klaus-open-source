import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
let modelSelect: typeof import('../../chat/composer/model-select')
let previousImportWindow: unknown
beforeAll(async () => {
  const target = globalThis as any
  previousImportWindow = target.window
  const current = target.window && typeof target.window === 'object' ? target.window : {}
  target.window = { ...current, addEventListener: current.addEventListener || (() => {}), removeEventListener: current.removeEventListener || (() => {}) }
  modelSelect = await import('../../chat/composer/model-select')
})
afterAll(() => { (globalThis as any).window = previousImportWindow })
import { modelOptionForValue } from '../../../../shared/cursor-model-catalog'
import { pickTraeModelMetadata } from '../../../../shared/trae-model-catalog'
import vectors from '../../../../contracts/vectors/trae-source-vectors.json'
import { knownTraeErrorText } from '../../app/trae-errors'
import { AUTH_MODE_ORDER, normalizeAuthMode, sourceLabel } from './model-shared'
import { authErrorText, cancelTraeLogin, importLocalSubscription, loginThroughDeviceFlow, SUBSCRIPTION_SOURCES, SubscriptionCardBody } from './subscription-card'
import { I18N } from '../../i18n/messages'
import { IMAGE_GENERATION_SOURCES, VIDEO_GENERATION_SOURCES, AUDIO_GENERATION_SOURCES, MUSIC_GENERATION_SOURCES } from './generation-sources'
import { SUBSCRIPTION_WEB_SEARCH_SOURCES } from '../../../../contracts/web-search-settings'

const source = SUBSCRIPTION_SOURCES.trae
const browserFlow = (flowId = 'trae-flow') => ({ ok: true, flowId, authUrl: 'https://www.trae.cn/authorization', expiresAt: Date.now() + 60_000, interval: 1 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function withAccountWindow(run: (calls: unknown[], target: any) => Promise<void>, api: Record<string, unknown>) {
  const target = globalThis as any, previousWindow = target.window, previousTimeout = globalThis.setTimeout
  const calls: unknown[] = []
  target.window = { currentLang: 'en', currentSessionId: 'chat-one', dispatchEvent: (event: Event) => { calls.push(event.type) },
    klausDialog: { confirm: async () => true }, klaus: { traeAuth: api,
      session: { setMainModel: async (...args: unknown[]) => { calls.push(['set', ...args]) } },
    } }
  globalThis.setTimeout = ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout
  try { await run(calls, target) } finally {
    await cancelTraeLogin()
    target.window = previousWindow
    globalThis.setTimeout = previousTimeout
  }
}

test('TRAE CN is selectable independently of the other connected sources', async () => {
  expect(AUTH_MODE_ORDER).toContain('trae')
  expect(normalizeAuthMode('trae')).toBe('trae')
  expect(sourceLabel('trae', key => I18N.en[key])).toBe('TRAE CN')
  expect(modelSelect.isMainModelValue('trae:fixture-chat')).toBe(true)
  expect(IMAGE_GENERATION_SOURCES).toContain('trae')
  expect(VIDEO_GENERATION_SOURCES).toContain('trae')
  expect(AUDIO_GENERATION_SOURCES as readonly string[]).not.toContain('trae')
  expect(MUSIC_GENERATION_SOURCES as readonly string[]).not.toContain('trae')
  expect(SUBSCRIPTION_WEB_SEARCH_SOURCES).toContain('trae')
})

test('known chat models remain selectable while account entitlement is decided by the service', () => {
  const model = { value: 'trae:fixture-chat', label: 'Fixture Chat', available: false, reason: 'Account restricted' }
  expect(modelSelect.mainModelItemDisabled(model, false)).toBe(false)
  expect(modelSelect.mainModelItemNote(model, key => I18N.en[key])).toBeNull()
  expect(modelSelect.mainModelItemDisabled(model, true)).toBe(true)
})

test('native effort members retain exact identity without entering the global reasoning ladder', () => {
  const family = { value: vectors.selection, label: vectors.family.display_name, ...pickTraeModelMetadata(vectors.family) }
  const light = modelOptionForValue([family], 'trae:fixture-chat::effort=light')!
  expect(light.value).toBe('trae:fixture-chat::effort=light')
  expect(modelSelect.mainModelThinkingLevels(light)).toEqual(['light', 'high'])
  expect(modelSelect.isThinkingLevelValue('light')).toBe(false)
  expect(modelSelect.isThinkingLevelForModel(light, 'light')).toBe(true)
  expect(modelSelect.isThinkingLevelForModel({ value: 'custom:fixture' }, 'light')).toBe(false)
  expect(modelSelect.mainModelThinkingPresentation(light, 'max', key => I18N.en[key])).toEqual({
    titleKey: 'thinking_level_button_title', label: 'Low', showBadge: true,
    rows: [{ value: 'light', label: 'Low', selected: true }, { value: 'high', label: 'High', selected: false }],
  })
  const chinese = modelSelect.mainModelThinkingPresentation(light, 'max', key => I18N.zh[key])
  expect(chinese.label).toBe('低')
  expect(chinese.rows).toEqual([{ value: 'light', label: '低', selected: true }, { value: 'high', label: '高', selected: false }])
  const native = pickTraeModelMetadata({ ...vectors.family, traeVariants: [...vectors.family.traeVariants,
    { value: 'trae:other-family::effort=light', nativeEffort: 'light', available: true },
    { value: 'custom:fixture-chat', nativeEffort: 'light', available: true },
  ] })
  expect(native.traeVariants).toHaveLength(3)
})

test('extended native effort labels use the shared ladder without changing their request value', () => {
  const family = { value: 'trae:fixture-extended', label: 'Extended', traeFamilyId: 'fixture-extended', traeVariants: [
    { value: 'trae:fixture-extended', nativeEffort: 'extra_high', isDefault: true, available: true },
    ...['extra_high', 'high', 'light'].map(nativeEffort => ({ value: `trae:fixture-extended::effort=${nativeEffort}`, nativeEffort, available: true })),
  ] }
  const presentation = modelSelect.mainModelThinkingPresentation(family, 'max', key => I18N.zh[key])
  expect(presentation.label).toBe('极高')
  expect(presentation.rows.map(row => [row.value, row.label])).toEqual([['light', '低'], ['high', '高'], ['extra_high', '极高']])
  expect(presentation.rows.find(row => row.selected)?.value).toBe('extra_high')
  expect(modelSelect.isThinkingLevelValue('extra_high')).toBe(false)
  expect(modelSelect.isThinkingLevelForModel(family, 'extra_high')).toBe(true)
})

test('browser sign-in and local reuse have independent actions and preserve their requested conversation', async () => {
  expect(source.login).toBe(loginThroughDeviceFlow)
  expect(source.loginLabel).toBe('trae_login')
  expect(source.importLabel).toBe('trae_reuse_login')
  const requests: unknown[] = []
  await withAccountWindow(async (calls, target) => {
    await source.login(source, () => {}, () => { requests.push('reload') })
    expect(calls).toEqual([['set', 'auto', 'chat-one', 'trae'], 'klaus:auth-mode-changed'])
    target.window.currentSessionId = 'chat-two'
    await importLocalSubscription(source, () => {}, () => { requests.push('reload') })
    expect(calls).toEqual([['set', 'auto', 'chat-one', 'trae'], 'klaus:auth-mode-changed', ['set', 'auto', 'chat-two', 'trae'], 'klaus:auth-mode-changed'])
    expect(requests).toEqual(['start', ['poll', 'trae-flow'], 'reload', 'reuse', 'reload'])
  }, {
    start: async () => { requests.push('start'); return browserFlow() },
    poll: async (flowId: string) => { requests.push(['poll', flowId]); return { ok: true, account: 'fixture@example.invalid' } },
    importLocal: async () => { requests.push('reuse'); return { ok: true, account: 'fixture@example.invalid' } },
  })
})

test('committed browser sign-in survives a card refresh and retains only sign-out', async () => {
  const requests: unknown[] = []
  await withAccountWindow(async (calls, target) => {
    target.window.klaus.session.setMainModel = async (...args: unknown[]) => { calls.push(['set', ...args]); await cancelTraeLogin() }
    await source.login(source, () => {}, () => { requests.push('reload'); void cancelTraeLogin() })
    expect(calls).toEqual([['set', 'auto', 'chat-one', 'trae'], 'klaus:auth-mode-changed'])
    expect(requests).toEqual(['reload'])
    const html = renderToStaticMarkup(createElement(SubscriptionCardBody, { mode: 'trae', reloadSeq: 0, reload: () => {} }))
    expect(html).toContain(I18N.en.auth_logged_in)
    expect(html).toContain('id="trae-auth-logout-btn"')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toContain('id="trae-auth-login-btn"')
    expect(html).not.toContain('id="trae-auth-import-btn"')
  }, { start: async () => browserFlow(), poll: async () => ({ ok: true }), cancel: async (flowId: string) => { requests.push(['cancel', flowId]); return { ok: true } } })
})

test('a delayed start is cancelled without publishing a late login', async () => {
  const start = deferred<unknown>(), requests: unknown[] = []
  await withAccountWindow(async calls => {
    const login = source.login(source, () => {}, () => { calls.push('reload') })
    await cancelTraeLogin()
    start.resolve(browserFlow('late-flow'))
    await login
    expect(requests).toEqual([['cancel', 'late-flow']])
    expect(calls).toEqual([])
  }, { start: () => start.promise, poll: async () => { requests.push('poll'); return { ok: true } }, cancel: async (flowId: string) => { requests.push(['cancel', flowId]); return { ok: true } } })
})

test('cancelling an in-flight poll prevents its delayed result from changing the conversation', async () => {
  const poll = deferred<unknown>(), entered = deferred<void>(), requests: unknown[] = []
  await withAccountWindow(async calls => {
    const login = source.login(source, () => {}, () => { calls.push('reload') })
    await entered.promise
    await cancelTraeLogin()
    poll.resolve({ ok: true })
    await login
    expect(requests).toEqual([['cancel', 'pending-flow']])
    expect(calls).toEqual([])
  }, { start: async () => browserFlow('pending-flow'), poll: () => { entered.resolve(); return poll.promise }, cancel: async (flowId: string) => { requests.push(['cancel', flowId]); return { ok: true } } })
})

for (const language of ['en', 'zh'] as const) {
  test(`authentication and service failures preserve localized recovery in ${language}`, () => {
    const target = globalThis as any, previous = target.window
    target.window = { currentLang: language }
    try {
      for (const code of ['trae_local_unreadable', 'trae_local_device_unavailable', 'trae_local_region_unsupported', 'trae_login_expired', 'trae_login_cancelled', 'trae_login_browser_failed', 'trae_refresh_unavailable', 'trae_device_registration_invalid', 'trae_device_registration_failed', 'trae_device_registration_timed_out', 'trae_device_identity_conflict', 'trae_device_proof_failed']) {
        expect(authErrorText(source, code)).not.toBe(I18N[language].auth_unknown_error)
        expect(authErrorText(source, code)).not.toContain('trae_')
      }
      for (const code of ['trae_model_access_denied', 'trae_quota_exhausted', 'trae_request_rejected', 'trae_auth_required', 'trae_rate_limited', 'trae_service_unavailable']) {
        expect(knownTraeErrorText(`Provider error ${code}: private diagnostics`, key => I18N[language][key])).toBe(I18N[language][code])
      }
      expect(knownTraeErrorText('antigravity_model_access_denied', key => I18N[language][key])).toBeUndefined()
      expect(knownTraeErrorText('trae_unknown', key => I18N[language][key])).toBeUndefined()
    } finally { target.window = previous }
  })
}
