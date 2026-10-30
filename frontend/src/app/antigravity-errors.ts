const ANTIGRAVITY_ERROR_KEYS = new Set([
  'antigravity_model_access_denied',
  'antigravity_quota_exhausted',
  'antigravity_request_rejected',
  'antigravity_auth_required',
  'antigravity_rate_limited',
  'antigravity_service_unavailable',
])

/** Stable service verdicts retain their meaning in live and saved turn failures. */
export function knownAntigravityErrorText(error: unknown, translate: (key: string) => string): string | undefined {
  const raw = typeof error === 'string' ? error.trim() : ''
  const code = raw.toLowerCase().match(/\bantigravity_[a-z0-9_]+\b/g)?.find(value => ANTIGRAVITY_ERROR_KEYS.has(value))
  return code ? translate(code) : undefined
}
