import { expect, test } from 'bun:test'
import { I18N } from '../i18n/messages'
import { cursorErrorText, knownCursorErrorText } from './cursor-errors'

// Terminal Cursor rejections must reach the user as localized wording; a bare
// engine code on the failure pill or usage block is the defect this pins.
for (const language of ['en', 'zh'] as const) {
  const dictionary = I18N[language] as Record<string, string>
  const translate = (key: string) => dictionary[key] ?? key

  test(`cursor rate limit carries localized wording in ${language}`, () => {
    expect(knownCursorErrorText('cursor_rate_limit', translate)).toBe(dictionary.cursor_rate_limited)
    expect(cursorErrorText('cursor_rate_limit', translate)).toBe(dictionary.cursor_rate_limited)
    expect(dictionary.cursor_rate_limited).not.toBe('cursor_rate_limited')
  })

  test(`usage-limit and plan-required wording stay distinct from rate limiting in ${language}`, () => {
    expect(cursorErrorText('cursor_usage_limit', translate)).toBe(dictionary.cursor_model_usage_limit)
    expect(cursorErrorText('cursor_subscription_required', translate)).toBe(dictionary.cursor_model_plan_required)
    expect(dictionary.cursor_rate_limited).not.toBe(dictionary.cursor_model_usage_limit)
    expect(dictionary.cursor_rate_limited).not.toBe(dictionary.cursor_model_plan_required)
  })
}
