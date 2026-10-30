import { describe, expect, test } from 'bun:test'
import { isChannelConfigured, isSavedChannelFailure } from './channel-state'

describe('channel presentation state', () => {
  test('requires both the enabled flag and every form credential', () => {
    expect(isChannelConfigured(undefined, ['bot_token'])).toBe(false)
    expect(isChannelConfigured({ enabled: false, credentials: { bot_token: 'secret' } }, ['bot_token'])).toBe(false)
    expect(isChannelConfigured({ enabled: true, credentials: {} }, ['bot_token'])).toBe(false)
    expect(isChannelConfigured({ enabled: true, credentials: { bot_token: 'secret' } }, ['bot_token'])).toBe(true)
  })

  test('keeps configured channels visible while their live transport is offline', () => {
    expect(isChannelConfigured({ enabled: true, connected: false, credentials: { bot_token: 'secret' } }, ['bot_token'])).toBe(true)
  })

  test('treats an enabled QR-paired channel with no form fields as configured', () => {
    expect(isChannelConfigured({ enabled: true, credentials: {} }, [])).toBe(true)
  })

  test('distinguishes a saved configuration from an ordinary connection failure', () => {
    expect(isSavedChannelFailure({ ok: false, saved: true, error: 'offline' })).toBe(true)
    expect(isSavedChannelFailure({ ok: false, error: 'invalid' })).toBe(false)
    expect(isSavedChannelFailure(false)).toBe(false)
  })
})
