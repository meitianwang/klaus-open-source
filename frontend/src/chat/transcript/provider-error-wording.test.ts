// Terminal provider failure wording: the projected kind selects the localized
// sentence; the raw transport text only survives where it adds the provider's
// own rejection reason.
import { describe, expect, test } from 'bun:test'
import { I18N } from '../../i18n/messages'
import billingVectors from '../../../../contracts/vectors/provider-billing-error-vectors.json'
import antigravityVectors from '../../../../contracts/vectors/antigravity-error-vectors.json'
import type { ProviderErrorDetails } from '../../../../contracts/provider-error-details'
import { renderErrorNoticeHtml } from '../error-notice'

;(globalThis as any).window = { addEventListener: () => {} }
const { providerErrorText } = await import('./TranscriptView')
const { t } = await import('../../i18n')

for (const language of ['en', 'zh'] as const) {
  test(`tool stream failures use readable source wording and retain diagnostics in ${language}`, () => {
    const translate = (key: string) => I18N[language][key]
    for (const code of ['trae_stream_tool_arguments_changed', 'trae_stream_tool_call_invalid', 'trae_stream_tool_index_invalid', 'trae_stream_tool_identity_changed']) {
      const diagnostics: ProviderErrorDetails = { message: code, kind: 'unknown', providerError: { message: code, code, type: 'trae_error' } }
      const before = JSON.stringify(diagnostics)
      const text = providerErrorText(code, 'unknown', translate, diagnostics)
      expect(text).toBe(translate('trae_tool_response_invalid'))
      const notice = renderErrorNoticeHtml(text, diagnostics)
      expect(notice.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1]).not.toContain(code)
      expect(notice).toContain(code)
      expect(JSON.stringify(diagnostics)).toBe(before)
    }
    expect(providerErrorText('cursor_stream_tool_arguments_changed', 'unknown', translate)).toBe('cursor_stream_tool_arguments_changed')
    expect(providerErrorText('trae_unknown', 'unknown', translate)).toBe('trae_unknown')
  })
}

describe('provider error wording', () => {
  for (const language of ['en', 'zh'] as const) {
    test(`billing refusals retain the correct classification and useful reason in ${language}`, () => {
      const translate = (key: string) => I18N[language][key]
      for (const row of billingVectors.cases) {
        const text = providerErrorText(row.raw, row.kind, translate, row.details as ProviderErrorDetails | undefined)
        expect(text).toBe(row.expectedRaw ? `${translate(row.expectedKey)} (${row.expectedRaw})` : translate(row.expectedKey))
        if (row.expectedKey === 'provider_payment_required') {
          expect(text).not.toContain(translate('provider_quota'))
          expect(text).toContain('402')
        }
      }
    })
  }
  test('network and quota failures read as the localized sentence, not the transport string', () => {
    expect(providerErrorText('connection timeout', 'network', t)).toBe(t('provider_network'))
    expect(providerErrorText('insufficient_quota', 'quota', t)).toBe(t('provider_quota'))
  })

  test('other rate-limit failures keep their existing wording', () => {
    expect(providerErrorText('Usage limit exceeded', 'rate_limit', t)).toBe('Usage limit exceeded')
  })

  test('fast mode credit refusals keep upstream diagnostics in the disclosure', () => {
    const details: ProviderErrorDetails = {
      message: 'Usage credits are required for fast mode.', kind: 'rate_limit', status: 429, requestId: 'req_fast_mode',
      providerError: { message: 'Usage credits are required for fast mode.', status: 429, requestId: 'req_fast_mode' },
    }
    const text = providerErrorText(details.message, details.kind, t, details)
    const notice = renderErrorNoticeHtml(text, details)
    expect(notice.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1]).not.toContain('Usage credits are required for fast mode')
    expect(notice).toContain('req_fast_mode')
    expect(notice).toContain('Usage credits are required for fast mode')
  })

  test('invalid_request keeps the provider rejection reason behind the localized lead-in', () => {
    expect(providerErrorText('body too large', 'invalid_request', t)).toBe(`${t('provider_invalid')} (body too large)`)
    expect(providerErrorText('', 'invalid_request', t)).toBe(t('provider_invalid'))
  })

  test('an output-limit truncation reads as the localized sentence, not the engine English', () => {
    expect(providerErrorText('the model reached its output limit before producing any text in its closing response', 'max_output', t)).toBe(t('provider_max_output'))
    expect(providerErrorText('', 'max_output', t)).toBe(t('provider_max_output'))
  })

  test('unmapped kinds keep the raw message and an empty raw still localizes', () => {
    expect(providerErrorText('boom', 'unknown', t)).toBe('boom')
    expect(providerErrorText('boom', undefined, t)).toBe('boom')
    expect(providerErrorText('', 'network', t)).toBe(t('provider_network'))
  })
})

describe('Antigravity service refusal wording', () => {
  for (const language of ['en', 'zh'] as const) {
    test(`service verdicts stay understandable across turn failure kinds in ${language}`, () => {
      const translate = (key: string) => I18N[language][key]
      for (const row of antigravityVectors.cases) {
        for (const kind of ['auth', 'quota', 'invalid_request', 'unknown', undefined]) {
          const raw = `Gemini API error: ${row.code}: provider-only diagnostic context`
          const text = providerErrorText(raw, kind, translate)
          expect(text).toBe(translate(row.expectedKey))
          expect(text).not.toContain('provider-only diagnostic context')
          if (row.code === 'antigravity_model_access_denied') expect(text).not.toBe(translate('provider_auth'))
        }
      }
    })
  }
  test('unrecognized service errors retain the existing failure wording, unknown source tags localize', () => {
    expect(providerErrorText('unrecognized refusal', 'invalid_request', t)).toBe(`${t('provider_invalid')} (unrecognized refusal)`)
    for (const language of ['en', 'zh'] as const) {
      const translate = (key: string) => I18N[language][key]
      const text = providerErrorText('antigravity_new_error', 'unknown', translate)
      expect(text).toBe(translate('antigravity_error_generic'))
      expect(text).not.toContain('antigravity_new_error')
    }
  })
})

// A provider's raw refusal text is an upstream error document. It can carry
// internal host names, echoed headers and request ids, so the user-facing card
// says what happened and what to do; the original stays in the failure log.
describe('provider failure wording keeps the raw document out of the conversation', () => {
  test('an auth refusal reads as the localized sentence, not the gateway text', () => {
    const raw = 'Qoder upstream Forbidden: HTTP 403 Forbidden (HTML error page). Body: <html>...'
    expect(providerErrorText(raw, 'auth', t)).toBe(t('provider_auth'))
    expect(providerErrorText(raw, 'auth', t)).not.toContain('HTTP 403')
  })

  test('a timeout reads as the localized sentence too', () => {
    expect(providerErrorText('error sending request for url (https://gw/v1/chat)', 'timeout', t)).toBe(t('provider_timeout'))
  })
})


for (const language of ['en', 'zh'] as const) {
  test(`Cursor endpoint refusal remains specific for every failure kind in ${language}`, () => {
    const translate = (key: string) => I18N[language][key]
    for (const kind of ['auth', 'invalid_request', 'unknown', undefined]) {
      expect(providerErrorText('OpenAI HTTP 403: cursor_inference_not_enabled (request-id: example)', kind, translate)).toBe(I18N[language].cursor_inference_not_enabled)
      expect(providerErrorText('cursor_client_metadata_missing', kind, translate)).toBe(I18N[language].cursor_import_metadata_missing)
      expect(providerErrorText('cursor_model_response_unsupported', kind, translate)).toBe(I18N[language].cursor_model_response_unsupported)
    }
    expect(providerErrorText('cursor_browser_login_expired', 'auth', translate)).toBe(I18N[language].cursor_browser_login_expired)
    expect(providerErrorText('cursor_adopted_credential_needs_reimport: token expired', 'auth', translate)).toBe(I18N[language].cursor_import_expired)
  })
}

for (const language of ['en', 'zh'] as const) {
  test(`Cursor model authorization failures preserve the valid account recovery path in ${language}`, () => {
    const translate = (key: string) => I18N[language][key]
    for (const kind of ['auth', 'invalid_request', 'unknown', undefined]) {
      for (const code of ['cursor_model_authorization_failed']) {
        expect(providerErrorText(code + ': private-provider-detail', kind, translate)).toBe(translate(code))
        expect(providerErrorText(code, kind, translate)).not.toBe(translate('cursor_import_expired'))
      }
    }
  })

  test(`Cursor native service errors retain their operation classification in ${language}`, () => {
    const translate = (key: string) => I18N[language][key]
    const cases = {
      cursor_native_operation_response_invalid: 'cursor_native_response_invalid',
      cursor_search_citations_unavailable: 'cursor_search_citations_unavailable',
      cursor_native_capability_not_enabled: 'cursor_native_service_unavailable',
      cursor_native_service_failed: 'cursor_native_service_failed',
      cursor_operation_limit: 'cursor_native_busy',
      cursor_operation_timed_out: 'cursor_native_timeout',
      cursor_operation_cancelled: 'cursor_native_cancelled',
    }
    for (const [code, key] of Object.entries(cases)) {
      for (const kind of ['auth', 'invalid_request', 'unknown', undefined]) {
        expect(providerErrorText(code + ': private-provider-detail', kind, translate)).toBe(translate(key))
      }
    }
  })
}
