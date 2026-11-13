import { describe, expect, test } from 'bun:test'
import { I18N } from '../../i18n/messages'
import { isSourceNotSignedIn } from './model-shared'
import { authErrorText, authErrorTextForMode, SUBSCRIPTION_SOURCES } from './subscription-card'

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
    expect(isSourceNotSignedIn('Kimi membership is not signed in')).toBe(true)
  })

  test('leaves real failures and non-string errors alone', () => {
    expect(isSourceNotSignedIn('connection reset by peer')).toBe(false)
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
