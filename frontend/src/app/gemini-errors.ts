const GEMINI_ERROR_KEYS = new Set([
  'gemini_model_access_denied',
  'gemini_model_not_offered',
  'gemini_model_unlisted',
  'gemini_quota_exhausted',
  'gemini_request_rejected',
  'gemini_region_unsupported',
  'gemini_account_disabled',
  'gemini_account_restricted',
  'gemini_verification_required',
  'gemini_permission_denied',
  'gemini_egress_unavailable',
  'gemini_auth_required',
  'gemini_login_expired',
  'gemini_refresh_unavailable',
  'gemini_rate_limited',
  'gemini_service_unavailable',
  'model_context_window_exceeded',
  'gemini_transport_unavailable',
  'gemini_request_cancelled',
  'gemini_credential_changed',
  'gemini_not_signed_in',
  'gemini_response_too_large',
  'gemini_response_interrupted',
  'gemini_response_invalid',
  'gemini_request_invalid',
  'gemini_model_invalid',
  'gemini_endpoint_invalid',
  'gemini_catalog_timeout',
  'gemini_catalog_invalid',
  'gemini_stream_invalid',
  'gemini_stream_incomplete',
  'gemini_tool_choice_unsupported',
  'gemini_thinking_level_unsupported',
  'gemini_model_unavailable',
  'gemini_model_purpose_unsupported',
  'gemini_capability_unavailable',
  'gemini_refresh_invalid',
  'gemini_store_unavailable',
  'gemini_store_invalid',
  'gemini_account_limit_reached',
])

/** Stable service verdicts retain their meaning in live and saved turn failures. */
export function knownGeminiErrorText(error: unknown, translate: (key: string) => string): string | undefined {
  const raw = typeof error === 'string' ? error.trim() : ''
  const codes = raw.toLowerCase().match(/\b(gemini_[a-z0-9_]+|model_context_window_exceeded)\b/g) ?? []
  const code = codes.find(value => GEMINI_ERROR_KEYS.has(value))
  if (code) return translate(code)
  // A service tag this build does not know yet must still read as a localized
  // Gemini failure instead of leaking the machine code into the turn.
  return codes.some(value => value.startsWith('gemini_')) ? translate('gemini_error_generic') : undefined
}
