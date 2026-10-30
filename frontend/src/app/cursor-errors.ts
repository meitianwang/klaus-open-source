// Stable account errors use the same recovery copy across settings and usage.
const CURSOR_ERROR_KEYS: Record<string, string> = {
  cursor_local_state_not_found: 'auth_err_cursor_not_found',
  cursor_local_not_signed_in: 'auth_err_cursor_not_signed_in',
  cursor_local_state_unreadable: 'auth_err_cursor_unreadable',
  cursor_local_metadata_unreadable: 'auth_err_cursor_unreadable',
  cursor_local_secret_unreadable: 'auth_err_cursor_unreadable',
  cursor_local_keychain_denied: 'auth_err_cursor_keychain',
  cursor_local_platform_unsupported: 'auth_err_cursor_unsupported',
  cursor_local_credentials_invalid: 'auth_err_local_invalid',
  cursor_client_credentials_not_found: 'auth_err_cursor_not_found',
  cursor_client_credentials_invalid: 'auth_err_local_invalid',
  cursor_client_metadata_missing: 'cursor_import_metadata_missing',
  cursor_client_credentials_have_no_token: 'auth_err_local_no_token',
  cursor_login_expired: 'cursor_import_expired',
  cursor_browser_login_expired: 'cursor_browser_login_expired',
  cursor_browser_metadata_unavailable: 'cursor_browser_metadata_unavailable',
  cursor_credentials_expired: 'cursor_import_expired',
  cursor_adopted_credential_needs_reimport: 'cursor_import_expired',
  cursor_inference_not_enabled: 'cursor_inference_not_enabled',
  cursor_model_response_unsupported: 'cursor_model_response_unsupported',
  cursor_model_authorization_failed: 'cursor_model_authorization_failed',
  cursor_context_length_exceeded: 'cursor_context_length_exceeded',
  cursor_token_limit_exceeded: 'cursor_token_limit_exceeded',
  cursor_permission_denied: 'cursor_model_access_denied',
  cursor_model_blocked: 'cursor_model_access_denied',
  cursor_max_mode_required: 'cursor_model_max_required',
  cursor_subscription_required: 'cursor_model_plan_required',
  cursor_usage_pricing_required: 'cursor_model_plan_required',
  cursor_usage_limit: 'cursor_model_usage_limit',
  cursor_client_update_required: 'cursor_connection_update_required',
  cursor_provider_credentials_invalid: 'cursor_model_service_unavailable',
  cursor_image_too_large: 'cursor_image_too_large',
  cursor_api_deprecated: 'cursor_connection_update_required',
  cursor_native_operation_response_invalid: 'cursor_native_response_invalid',
  cursor_native_media_invalid: 'cursor_native_response_invalid',
  cursor_search_citations_unavailable: 'cursor_search_citations_unavailable',
  cursor_native_capability_not_enabled: 'cursor_native_service_unavailable',
  cursor_model_capability_unsupported: 'cursor_native_service_unavailable',
  cursor_native_service_failed: 'cursor_native_service_failed',
  cursor_operation_limit: 'cursor_native_busy',
  cursor_operation_timed_out: 'cursor_native_timeout',
  cursor_operation_cancelled: 'cursor_native_cancelled',
  cursor_request_cancelled: 'cursor_native_cancelled',
}

export function knownCursorErrorText(error: unknown, translate: (key: string) => string): string | undefined {
  const raw = typeof error === 'string' ? error.trim() : ''
  const codes = raw.toLowerCase().match(/\bcursor_[a-z0-9_]+\b/g) || []
  const key = codes.map(code => CURSOR_ERROR_KEYS[code]).find(Boolean)
  if (key) return translate(key).replace(/\{name\}/g, 'Cursor')
  return undefined
}

export function cursorErrorText(error: unknown, translate: (key: string) => string): string {
  const known = knownCursorErrorText(error, translate)
  if (known !== undefined) return known
  const raw = typeof error === 'string' ? error.trim() : ''
  return /\bcursor_[a-z0-9_]+\b/i.test(raw) ? translate('auth_unknown_error') : raw
}
