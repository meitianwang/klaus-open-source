import { describe, expect, test } from 'bun:test'

import { I18N } from '../../i18n/messages'
import { authCardCopy } from './auth-card-copy'

// Each model source directs the user to its own credential recovery.
// An unknown or retired source offers model settings.
describe('auth card copy', () => {
  test('every BYO source keeps its own recovery', () => {
    expect(authCardCopy('subscription').action).toBe('login')
    expect(authCardCopy('codex').action).toBe('device-flow')
    for (const mode of ['qoder', 'cursor', 'qwenwork', 'workbuddy', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark']) {
      expect(authCardCopy(mode).action).toBe('open-settings')
    }
  })

  test('an absent, retired or unrecognized source falls back to the custom-provider branch', () => {
    // The fallback is the only branch that never claims a credential the user might not
    // have, which is why an unknown or retired source lands there rather than erroring.
    for (const mode of [undefined, '', 'mystery-source', 'klaus', 'local']) {
      const copy = authCardCopy(mode)
      expect(copy.titleKey).toBe('auth_card_custom_title')
      expect(copy.action).toBe('open-settings')
    }
  })

  test('every branch names all five copy keys and a switch target', () => {
    // A missing key would render as the literal key string via t(), so the shape is part
    // of the contract, not just the values.
    const modes = ['subscription', 'codex', 'cursor', 'qoder', 'qwenwork', 'workbuddy', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark', 'custom', undefined]
    for (const mode of modes) {
      const copy = authCardCopy(mode)
      for (const key of ['titleKey', 'hintKey', 'primaryKey', 'secondaryKey'] as const) {
        expect(copy[key]).toMatch(/^auth_/)
      }
      expect(['custom', 'subscription']).toContain(copy.switchTo)
    }
  })

  test('subscription sources switch back to custom, the rest switch to the subscription', () => {
    expect(authCardCopy('subscription').switchTo).toBe('custom')
    expect(authCardCopy('codex').switchTo).toBe('custom')
    expect(authCardCopy('cursor').switchTo).toBe('custom')
    for (const mode of ['qoder', 'qwenwork', 'workbuddy', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark', 'custom', undefined]) {
      expect(authCardCopy(mode).switchTo).toBe('subscription')
    }
  })

  test('every copy key the mapping names exists in both languages', () => {
    // A key named here but missing from the table renders as the literal key string via
    // t(), so the mapping and the i18n table cannot be allowed to drift apart. This also
    // catches the easy mistake of adding a branch with a typo'd key.
    const modes = ['subscription', 'codex', 'cursor', 'qoder', 'qwenwork', 'workbuddy', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark', 'custom', undefined]
    for (const mode of modes) {
      const copy = authCardCopy(mode)
      for (const key of [copy.titleKey, copy.hintKey, copy.primaryKey, copy.secondaryKey]) {
        expect(I18N.en[key]).toBeTypeOf('string')
        expect(I18N.zh[key]).toBeTypeOf('string')
      }
    }
  })

})


test('Cursor endpoint refusal explains the rejected connection without suggesting re-import', () => {
  const copy = authCardCopy('cursor', 'Cursor: cursor_inference_not_enabled (HTTP 403)')
  expect(copy.titleKey).toBe('auth_card_cursor_unavailable_title')
  expect(copy.hintKey).toBe('cursor_inference_not_enabled')
  expect(copy.primaryKey).toBe('auth_primary_cursor')
  expect(copy.action).toBe('open-settings')
  for (const language of ['en', 'zh'] as const) {
    for (const key of [copy.titleKey, copy.hintKey, copy.primaryKey]) expect(I18N[language][key]).toBeTypeOf('string')
  }
  expect(authCardCopy('cursor', 'cursor_login_expired').hintKey).toBe('auth_card_cursor_hint')
  expect(authCardCopy('cursor', 'cursor_client_metadata_missing').hintKey).toBe('cursor_import_metadata_missing')
})


test('Cursor browser expiry asks for a fresh sign-in instead of re-import', () => {
  expect(authCardCopy('cursor', 'Cursor: cursor_browser_login_expired').hintKey).toBe('cursor_browser_login_expired')
  for (const language of ['en', 'zh'] as const) expect(I18N[language].cursor_browser_login_expired).toBeTypeOf('string')
})
