// Envelope failures must never reach the transcript as transport jargon: the
// auth and network families get actionable localized sentences, and other
// startup failures keep their inner reason under a friendly prefix. Bare
// engine strings keep their existing kind-based wording.
import { describe, expect, test } from 'bun:test'
import { I18N } from '../i18n/messages'
import { friendlyErrorText, parseHostEnvelope } from './friendly-errors'

const ENVELOPE_AUTH =
  "channel 'session:new' failed: app-server rpc error -32000: OAuth token refresh failed"
const ENVELOPE_NETWORK =
  "channel 'chat:send' failed: app-server rpc error -32000: connection refused"
const ENVELOPE_OTHER = "channel 'session:new' failed: app-server rpc error -32000: boom"

describe('parseHostEnvelope', () => {
  test('strips the channel and rpc prefixes', () => {
    expect(parseHostEnvelope(ENVELOPE_AUTH)).toEqual({
      channel: 'session:new',
      inner: 'OAuth token refresh failed',
      enveloped: true,
    })
  })
  test('leaves plain text untouched and unenveloped', () => {
    expect(parseHostEnvelope('plain text')).toEqual({
      channel: undefined,
      inner: 'plain text',
      enveloped: false,
    })
  })
})

for (const language of ['en', 'zh'] as const) {
  const translate = (key: string) => I18N[language][key]
  test(`auth envelope failures map to actionable copy in ${language}`, () => {
    expect(friendlyErrorText(ENVELOPE_AUTH, translate)).toBe(translate('error_auth_expired'))
    expect(translate('error_auth_expired')).not.toContain('app-server')
  })
  test(`network envelope failures map to actionable copy in ${language}`, () => {
    expect(friendlyErrorText(ENVELOPE_NETWORK, translate)).toBe(translate('error_network_unreachable'))
  })
  test(`other startup failures keep their reason under a friendly prefix in ${language}`, () => {
    const text = friendlyErrorText(ENVELOPE_OTHER, translate)
    expect(text).toBe(translate('error_startup_generic').replace('{detail}', 'boom'))
    expect(text).not.toContain('app-server')
    expect(text).not.toContain("channel '")
  })
  test(`bare engine strings keep their kind-based wording in ${language}`, () => {
    expect(friendlyErrorText('connection timeout', translate)).toBeUndefined()
    expect(friendlyErrorText('OAuth token refresh failed', translate)).toBeUndefined()
    expect(friendlyErrorText('some provider rejection', translate)).toBeUndefined()
  })
}

;(globalThis as any).window = { addEventListener: () => {} }
const { providerErrorText } = await import('./transcript/TranscriptView')

test('providerErrorText routes envelope auth failures through the friendly copy', () => {
  const translate = (key: string) => I18N.en[key]
  expect(providerErrorText(ENVELOPE_AUTH, 'unknown', translate)).toBe(translate('error_auth_expired'))
  const qoderUnsigned = "channel 'session:new' failed: app-server rpc error -32602: not signed in to a Qoder subscription — run `klaus login qoder`"
  expect(providerErrorText(qoderUnsigned, 'unknown', key => I18N.zh[key]))
    .toBe(I18N.zh.auth_err_source_not_signed_in.replace(/\{name\}/g, I18N.zh.auth_qoder))
})
