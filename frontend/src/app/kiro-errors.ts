const REQUEST_KEYS = new Set([
  'kiro_model_access_denied', 'kiro_quota_exhausted', 'kiro_request_rejected',
  'kiro_auth_required', 'kiro_rate_limited', 'kiro_service_unavailable',
  'kiro_login_expired', 'kiro_not_signed_in',
  'kiro_request_parameter_unsupported', 'kiro_model_unavailable', 'kiro_default_model_unavailable',
  'kiro_local_account_changed',
  'kiro_model_not_found',
]);

/** Keep Kiro failures readable in live turns and restored history. */
export function knownKiroErrorText(error: unknown, translate: (key: string) => string): string | undefined {
  const raw = typeof error === 'string' ? error.trim() : '';
  const codes: string[] = raw.toLowerCase().match(/\bkiro_[a-z0-9_]+\b/g) ?? [];
  if (codes.includes('kiro_request_rejected') && /\bmodel_not_found\b/i.test(raw)) {
    return translate('kiro_model_not_found');
  }
  const category = codes.find(code => REQUEST_KEYS.has(code));
  if (category) return translate(category === 'kiro_not_signed_in' ? 'kiro_not_logged_in' : category);
  if (codes.some(code => /^kiro_(?:stream|response|tool)_/.test(code))) return translate('kiro_response_invalid');
  return undefined;
}

const AUTH_KEYS: Record<string, string> = {
  kiro_not_signed_in: 'kiro_not_logged_in', kiro_local_not_found: 'kiro_local_not_found',
  kiro_local_unreadable: 'kiro_local_unreadable', kiro_local_expired: 'kiro_login_expired',
  kiro_login_expired: 'kiro_login_expired', kiro_refresh_unavailable: 'kiro_refresh_unavailable',
  kiro_refresh_failed: 'kiro_refresh_unavailable', kiro_login_invalid_flow: 'kiro_browser_login_expired',
  kiro_login_cancelled: 'kiro_login_cancelled', kiro_login_denied: 'kiro_login_denied',
  kiro_login_failed: 'kiro_login_failed', kiro_login_invalid_response: 'kiro_login_invalid_response',
  kiro_login_callback_invalid: 'kiro_login_invalid_response', kiro_login_callback_unavailable: 'kiro_login_unavailable',
  kiro_login_url_invalid: 'kiro_login_browser_failed', kiro_login_browser_failed: 'kiro_login_browser_failed',
  kiro_login_credential_changed: 'kiro_login_credential_changed', kiro_credential_changed: 'kiro_login_credential_changed',
  kiro_login_store_failed: 'auth_err_store_write', kiro_credential_write_failed: 'auth_err_store_write',
  kiro_login_port_unavailable: 'kiro_login_unavailable', kiro_login_exchange_failed: 'kiro_login_failed',
  kiro_refresh_method_unsupported: 'kiro_login_expired', kiro_auth_method_unsupported: 'kiro_login_method_unsupported',
  kiro_login_method_unsupported: 'kiro_login_method_unsupported',
  kiro_local_account_changed: 'kiro_local_account_changed',
};

export function knownKiroAuthErrorText(error: unknown, translate: (key: string) => string): string | undefined {
  if (typeof error !== 'string') return undefined;
  const code = error.toLowerCase().match(/\bkiro_[a-z0-9_]+\b/g)?.find(code => Object.hasOwn(AUTH_KEYS, code));
  return code ? translate(AUTH_KEYS[code]!) : knownKiroErrorText(error, translate);
}
