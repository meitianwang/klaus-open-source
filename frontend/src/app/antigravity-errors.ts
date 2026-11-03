const ANTIGRAVITY_ERROR_KEYS = new Set([
  'antigravity_model_access_denied',
  'antigravity_model_not_offered',
  'antigravity_model_unlisted',
  'antigravity_quota_exhausted',
  'antigravity_request_rejected',
  'antigravity_auth_required',
  'antigravity_rate_limited',
  'antigravity_service_unavailable',
  'model_context_window_exceeded',
  'antigravity_transport_unavailable',
  'antigravity_request_cancelled',
  'antigravity_credential_changed',
  'antigravity_not_signed_in',
  'antigravity_response_too_large',
  'antigravity_response_interrupted',
  'antigravity_response_invalid',
  'antigravity_request_invalid',
  'antigravity_model_invalid',
  'antigravity_endpoint_invalid',
  'antigravity_catalog_timeout',
  'antigravity_catalog_invalid',
  'antigravity_stream_invalid',
  'antigravity_stream_incomplete',
  'antigravity_tool_choice_unsupported',
  'antigravity_thinking_level_unsupported',
  'antigravity_model_unavailable',
  'antigravity_model_purpose_unsupported',
  'antigravity_capability_unavailable',
  'antigravity_refresh_invalid',
  'antigravity_store_unavailable',
  'antigravity_store_invalid',
])

/** Stable service verdicts retain their meaning in live and saved turn failures. */
export function knownAntigravityErrorText(error: unknown, translate: (key: string) => string): string | undefined {
  const raw = typeof error === 'string' ? error.trim() : ''
  const codes = raw.toLowerCase().match(/\b(antigravity_[a-z0-9_]+|model_context_window_exceeded)\b/g) ?? []
  const code = codes.find(value => ANTIGRAVITY_ERROR_KEYS.has(value))
  if (code) return translate(code)
  // A service tag this build does not know yet must still read as a localized
  // Antigravity failure instead of leaking the machine code into the turn.
  return codes.some(value => value.startsWith('antigravity_')) ? translate('antigravity_error_generic') : undefined
}
