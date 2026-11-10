import { describe, expect, test } from 'bun:test'
import { I18N } from '../../i18n/messages'
import { AUTH_MODE_ORDER, isSourceNotSignedIn, normalizeAuthMode, sourceLabel } from './model-shared'
import { authErrorText, authErrorTextForMode, loginThroughDeviceFlow, SUBSCRIPTION_SOURCES } from './subscription-card'

// The engine answers per-source model catalog requests for a source with no
// stored login with a human sentence, not an error code. The settings page
// sections fed by that catalog (tier mapping, advisor) hide on it instead of
// rendering a failure card, so the sentence shapes the engine actually sends
// are the contract this helper pins.
describe('isSourceNotSignedIn', () => {
  test('matches every source catalog not-signed-in sentence', () => {
    expect(isSourceNotSignedIn('not signed in to a ChatGPT/Codex subscription')).toBe(true)
    expect(isSourceNotSignedIn('not signed in to a Claude subscription — run `klaus login claude`')).toBe(true)
    expect(isSourceNotSignedIn('not signed in to a Qoder subscription — run `klaus login qoder`')).toBe(true)
    expect(isSourceNotSignedIn('not signed in to a QwenWork subscription')).toBe(true)
    expect(isSourceNotSignedIn('not signed in to a QoderWork subscription')).toBe(true)
    expect(isSourceNotSignedIn('not signed in to a WorkBuddy subscription')).toBe(true)
    expect(isSourceNotSignedIn('not signed in to a Kimi membership')).toBe(true)
    expect(isSourceNotSignedIn('not signed in to a Bailian Token Plan')).toBe(true)
  })

  test('matches the per-source catalogs’ reversed word order', () => {
    // workbuddy/catalog.rs, qoder/catalog.rs, qwenwork/catalog.rs and
    // kimi/auth.rs build the sentence the other way round; the settings page
    // used to miss exactly these and paint a failure card while signed out.
    expect(isSourceNotSignedIn('WorkBuddy subscription is not signed in')).toBe(true)
    expect(isSourceNotSignedIn('Qoder subscription is not signed in')).toBe(true)
    expect(isSourceNotSignedIn('QwenWork subscription is not signed in')).toBe(true)
    expect(isSourceNotSignedIn('QoderWork subscription is not signed in')).toBe(true)
    expect(isSourceNotSignedIn('Kimi membership is not signed in')).toBe(true)
  })

  test('leaves real failures and non-string errors alone', () => {
    expect(isSourceNotSignedIn('connection reset by peer')).toBe(false)
    expect(isSourceNotSignedIn('qoderwork_login_expired')).toBe(false)
    expect(isSourceNotSignedIn('the Codex model catalog is not reachable from this build')).toBe(false)
    // The engine keeps the three catalog refusals apart; "expired" is the one
    // where the user did everything right and only has to renew, so it must
    // still surface instead of hiding as an expected signed-out state.
    expect(isSourceNotSignedIn('the Claude subscription credential has expired and cannot be renewed — run `klaus login claude`')).toBe(false)
    expect(isSourceNotSignedIn(undefined)).toBe(false)
    expect(isSourceNotSignedIn(null)).toBe(false)
    expect(isSourceNotSignedIn(new Error('not signed in to a ChatGPT/Codex subscription'))).toBe(false)
  })
})

describe('QoderWork subscription presentation', () => {
  const source = SUBSCRIPTION_SOURCES.qoderwork
  const errors = [
    ['qoderwork_local_credentials_unavailable', 'auth_err_qoderwork_not_found'],
    ['qoderwork_local_secret_unreadable', 'auth_err_qoderwork_unreadable'],
    ['qoderwork_local_keychain_denied', 'auth_err_qoderwork_keychain'],
    ['qoderwork_local_platform_unsupported', 'auth_err_qoderwork_unsupported'],
    ['qoderwork_local_not_signed_in', 'auth_err_qoderwork_not_signed_in'],
    ['qoderwork_local_machine_id_missing', 'auth_err_qoderwork_machine_id'],
    ['qoderwork_local_state_unreadable', 'auth_err_qoderwork_unreadable'],
    ['qoderwork_client_credentials_not_found', 'auth_err_qoderwork_not_found'],
    ['qoderwork_client_credentials_invalid', 'auth_err_local_invalid'],
    ['qoderwork_client_credentials_have_no_token', 'auth_err_local_no_token'],
    ['qoderwork_login_expired', 'auth_err_qoderwork_login_expired'],
  ] as const

  test('keeps an independent BYO source immediately after QwenWork', () => {
    expect(AUTH_MODE_ORDER[AUTH_MODE_ORDER.indexOf('qwenwork') + 1]).toBe('qoderwork')
    expect(normalizeAuthMode('qoderwork')).toBe('qoderwork')
    for (const language of ['en', 'zh'] as const) {
      expect(sourceLabel('qoderwork', key => I18N[language][key])).toBe('QoderWork')
    }
  })

  test('offers device-flow login and local import with bilingual copy', () => {
    expect(source.mode).toBe('qoderwork')
    // The id prefix is a DOM id namespace, not the model-value prefix: it builds
    // `${prefix}-login-btn` and friends, and a colon in a DOM id makes the
    // element unreachable to a plain `#id` CSS selector.
    expect(source.idPrefix).toBe('qoderwork-auth')
    expect(source.login).toBe(loginThroughDeviceFlow)
    expect(source.deviceHint).toBeUndefined()
    for (const key of [
      source.label, source.accountFallback, source.notLoggedIn, source.loginLabel,
      source.importLabel!, source.logoutLabel, source.loginOpening, source.importConfirm!,
      source.importing!, source.importSuccess!, source.importFailedPrefix!,
      source.confirmLogout, source.deviceExpired!, 'auth_mode_switched_qoderwork',
      'usage_provider_qoderwork',
    ]) {
      expect(I18N.en[key]).toBeTypeOf('string')
      expect(I18N.zh[key]).toBeTypeOf('string')
    }
  })

  for (const language of ['en', 'zh'] as const) {
    test(`maps all QoderWork credential errors to readable ${language} copy`, () => {
      const previous = (globalThis as any).window
      ;(globalThis as any).window = { currentLang: language }
      try {
        for (const [error, key] of errors) {
          expect(I18N.en[key]).toBeTypeOf('string')
          expect(I18N.zh[key]).toBeTypeOf('string')
          expect(authErrorText(source, error)).toBe(I18N[language][key].replace(/\{name\}/g, 'QoderWork'))
        }
      } finally {
        ;(globalThis as any).window = previous
      }
    })
  }
})

// Switching the main model from the composer or the transcript auth card fails
// through the host channel wrapper, so the renderer receives transport noise
// around the stable verdict code. The mapping must peel that wrapper or the
// toast leaks machine text like "app-server rpc error -32000".
describe('wrapped engine verdicts stay readable', () => {
  const wrapped = (code: string) => `channel 'session:set-main-model' failed: app-server rpc error -32000: ${code}`

  for (const language of ['en', 'zh'] as const) {
    test(`maps wrapped not-signed-in verdicts to ${language} copy`, () => {
      const previous = (globalThis as any).window
      ;(globalThis as any).window = { currentLang: language }
      try {
        const antigravity = authErrorText(SUBSCRIPTION_SOURCES.antigravity, wrapped('antigravity_not_signed_in'))
        expect(antigravity).toBe(I18N[language].antigravity_not_signed_in)
        expect(antigravity).not.toContain('rpc error')
        expect(authErrorTextForMode('antigravity', wrapped('antigravity_not_signed_in'))).toBe(antigravity)
        const qoderwork = authErrorText(SUBSCRIPTION_SOURCES.qoderwork, wrapped('qoderwork_local_not_signed_in'))
        expect(qoderwork).toBe(I18N[language].auth_err_qoderwork_not_signed_in.replace(/\{name\}/g, 'QoderWork'))
        const trae = authErrorText(SUBSCRIPTION_SOURCES.trae, wrapped('trae_not_signed_in'))
        expect(trae).toBe(I18N[language].trae_not_logged_in)
        // Human-readable prose keeps passing through untouched.
        expect(authErrorText(SUBSCRIPTION_SOURCES.antigravity, 'Usage request timed out. Please try again.')).toBe('Usage request timed out. Please try again.')
      } finally {
        ;(globalThis as any).window = previous
      }
    })
  }
})
