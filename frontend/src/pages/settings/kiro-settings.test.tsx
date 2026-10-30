import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { modelOptionForValue } from '../../../../shared/cursor-model-catalog'
import { pickKiroModelMetadata } from '../../../../shared/kiro-model-catalog'
import vectors from '../../../../contracts/vectors/kiro-source-vectors.json'
import { knownKiroErrorText, knownKiroAuthErrorText } from '../../app/kiro-errors'
import { AUTH_MODE_ORDER, sourceLabel } from './model-shared'
import { cancelKiroLogin, loginThroughDeviceFlow, SUBSCRIPTION_SOURCES, SubscriptionCardBody } from './subscription-card'
import { I18N } from '../../i18n/messages'
import { SUBSCRIPTION_WEB_SEARCH_SOURCES } from '../../../../contracts/web-search-settings'

let models: typeof import('../../chat/composer/model-select')
let previousWindow: unknown
beforeAll(async () => {
  const target = globalThis as any
  previousWindow = target.window
  target.window = { currentLang: 'en', currentSessionId: 'kiro-fixture', addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} }
  models = await import('../../chat/composer/model-select')
})
afterAll(async () => { await cancelKiroLogin(); (globalThis as any).window = previousWindow })

test('Kiro source identity and native search stay separate from other subscriptions', () => {
  expect(AUTH_MODE_ORDER).toContain('kiro')
  expect(sourceLabel('kiro', key => I18N.en[key])).toBe('Kiro')
  expect(models.isMainModelValue(vectors.selection)).toBe(true)
  expect(models.isMainModelValue('kiro:auto')).toBe(false)
  expect(models.isMainModelValue('kiro:auto::effort=max')).toBe(false)
  expect(models.isMainModelValue('qoder:auto')).toBe(true)
  expect(SUBSCRIPTION_WEB_SEARCH_SOURCES).toContain('kiro')
  const row = { value: 'kiro:fixture-chat', label: 'Fixture Chat', available: false }
  expect(models.mainModelItemDisabled(row, false)).toBe(false)
  expect(models.mainModelItemNote(row, key => I18N.en[key])).toBeNull()
})

test('native Kiro none and max survive exact selection and retain their labels', () => {
  const family = { value: vectors.selection, label: 'Fixture Chat', ...pickKiroModelMetadata(vectors.family) }
  const none = modelOptionForValue([family], 'kiro:fixture-chat::effort=none')!
  expect(models.mainModelThinkingLevels(none)).toEqual(['none', 'high', 'max'])
  expect(models.isThinkingLevelForModel(none, 'none')).toBe(true)
  expect(models.isThinkingLevelForModel({ value: 'custom:fixture' }, 'none')).toBe(false)
  const view = models.mainModelThinkingPresentation(none, 'high', key => I18N.zh[key])
  expect(view.rows.find(row => row.value === 'none')?.selected).toBe(true)
  expect(view.rows.find(row => row.value === 'max')?.label).toBe('最高')
})

test('Kiro errors localize in both languages without changing unrelated source messages', () => {
  for (const language of ['en', 'zh'] as const) {
    const t = (key: string) => I18N[language][key]
    for (const code of ['kiro_model_access_denied', 'kiro_quota_exhausted', 'kiro_auth_required', 'kiro_login_expired', 'kiro_request_parameter_unsupported', 'kiro_model_unavailable', 'kiro_default_model_unavailable', 'kiro_model_not_found']) {
      expect(knownKiroErrorText(`${code} (HTTP 403)`, t)).toBe(t(code))
    }
    expect(knownKiroErrorText('kiro_request_rejected (model_not_found; parameter=model)', t)).toBe(t('kiro_model_not_found'))
    expect(knownKiroErrorText('kiro_request_rejected (access_denied)', t)).toBe(t('kiro_request_rejected'))
    expect(knownKiroErrorText('model_not_found', t)).toBeUndefined()
    expect(knownKiroAuthErrorText('kiro_local_expired', t)).toBe(t('kiro_login_expired'))
    expect(knownKiroErrorText('kiro_stream_incomplete', t)).toBe(t('kiro_response_invalid'))
    expect(knownKiroErrorText('cursor_stream_incomplete', t)).toBeUndefined()
  }
})

test('committed Kiro login survives remount cancellation and displays an account with zero buttons', async () => {
  const target = globalThis as any, old = target.window, calls: unknown[] = []
  const source = SUBSCRIPTION_SOURCES.kiro
  target.window = { ...old, klaus: {
    kiroAuth: {
      start: async () => ({ ok: true, flowId: 'kiro-flow', expiresAt: Date.now() + 60_000, interval: 1 }),
      poll: async () => ({ ok: true, account: 'Fixture account' }),
      cancel: async () => { calls.push('cancel'); return { ok: true } },
    },
    session: { setMainModel: async (...args: unknown[]) => { calls.push(args); await cancelKiroLogin() } },
  } }
  try {
    await loginThroughDeviceFlow(source, () => {}, () => { void cancelKiroLogin() })
    expect(calls).toEqual([['auto', 'kiro-fixture', 'kiro']])
    const html = renderToStaticMarkup(createElement(SubscriptionCardBody, { mode: 'kiro', reloadSeq: 0, reload: () => {} }))
    expect(html).toContain('Fixture account')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('card-actions')
  } finally { await cancelKiroLogin(); target.window = old }
})
