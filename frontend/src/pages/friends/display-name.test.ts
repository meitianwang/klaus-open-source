import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { I18N } from '../../i18n/messages'
import { friendDisplayName } from './display-name'

let previousWindow: unknown
beforeEach(() => { previousWindow = (globalThis as any).window; (globalThis as any).window = { currentLang: 'zh' } })
afterEach(() => { (globalThis as any).window = previousWindow })

describe('friend display names', () => {
  test('uses a local remark before the public nickname and email local part', () => {
    expect(friendDisplayName({ remark: ' Team ', displayName: 'Alice', email: 'alice@example.com' })).toBe('Team')
    expect(friendDisplayName({ displayName: 'Alice', email: 'alice@example.com' })).toBe('Alice')
    expect(friendDisplayName({ displayName: '  ', email: 'alice@example.com' })).toBe('alice')
  })
  test('keeps the nickname as written and localizes the missing-name fallback', () => {
    expect(friendDisplayName({ displayName: 'kLaUs' })).toBe('kLaUs')
    expect(friendDisplayName({ displayName: '   ' })).toBe(I18N.zh.friends_no_nickname)
  })
})
