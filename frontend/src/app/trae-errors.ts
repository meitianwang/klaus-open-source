const TRAE_ERROR_KEYS = new Set([
  'trae_model_access_denied',
  'trae_quota_exhausted',
  'trae_request_rejected',
  'trae_auth_required',
  'trae_rate_limited',
  'trae_service_unavailable',
]);

const TRAE_TOOL_RESPONSE_ERRORS = new Set([
  'trae_stream_tool_arguments_changed',
  'trae_stream_tool_call_invalid',
  'trae_stream_tool_index_invalid',
  'trae_stream_tool_identity_changed',
]);

/** Preserve source error categories in both live and restored turn failures. */
export function knownTraeErrorText(error: unknown, translate: (key: string) => string): string | undefined {
  const raw = typeof error === 'string' ? error.trim() : '';
  const code = raw.toLowerCase().match(/\btrae_[a-z0-9_]+\b/g)?.find(value => TRAE_ERROR_KEYS.has(value) || TRAE_TOOL_RESPONSE_ERRORS.has(value));
  return code ? translate(TRAE_TOOL_RESPONSE_ERRORS.has(code) ? 'trae_tool_response_invalid' : code) : undefined;
}

const TRAE_AUTH_ERROR_KEYS: Record<string, string> = {
  trae_not_signed_in: 'trae_not_logged_in',
  trae_local_not_found: 'trae_local_not_found',
  trae_local_unreadable: 'trae_local_unreadable',
  trae_local_device_missing: 'trae_local_device_missing',
  trae_local_ambiguous_device: 'trae_local_ambiguous_device',
  trae_local_device_unavailable: 'trae_local_device_missing',
  trae_local_region_unsupported: 'trae_local_region_unsupported',
  trae_login_expired: 'trae_login_expired',
  trae_refresh_unavailable: 'trae_refresh_unavailable',
  trae_login_invalid_flow: 'trae_browser_login_expired',
  trae_login_cancelled: 'trae_login_cancelled',
  trae_login_denied: 'trae_login_denied',
  trae_login_network_error: 'trae_login_network_error',
  trae_login_invalid_response: 'trae_login_invalid_response',
  trae_login_failed: 'trae_login_failed',
  trae_login_store_failed: 'auth_err_store_write',
  trae_login_random_failed: 'trae_login_unavailable',
  trae_login_callback_unavailable: 'trae_login_unavailable',
  trae_login_callback_invalid: 'trae_login_invalid_response',
  trae_login_credential_changed: 'trae_login_credential_changed',
  trae_login_endpoint_invalid: 'trae_login_unavailable',
  trae_login_url_invalid: 'trae_login_browser_failed',
  trae_login_browser_failed: 'trae_login_browser_failed',
  trae_device_registration_invalid: 'trae_device_registration_failed',
  trae_device_registration_failed: 'trae_device_registration_failed',
  trae_device_registration_timed_out: 'trae_device_registration_failed',
  trae_device_identity_conflict: 'trae_device_identity_conflict',
  trae_device_identity_invalid: 'trae_login_invalid_response',
  trae_device_key_invalid: 'trae_login_unavailable',
  trae_device_key_unavailable: 'trae_login_unavailable',
  trae_device_proof_failed: 'trae_login_unavailable',
  trae_device_key_mismatch: 'trae_login_invalid_response',
  trae_device_identity_unavailable: 'trae_device_registration_failed',
  trae_device_platform_unsupported: 'trae_device_platform_unsupported',
};

export function knownTraeAuthErrorText(error: unknown, translate: (key: string) => string): string | undefined {
  if (typeof error !== 'string') return undefined;
  const code = error.trim().toLowerCase().match(/\btrae_[a-z0-9_]+\b/g)?.find(value => Object.hasOwn(TRAE_AUTH_ERROR_KEYS, value));
  return code ? translate(TRAE_AUTH_ERROR_KEYS[code]!) : undefined;
}
