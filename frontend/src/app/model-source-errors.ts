import { knownAntigravityErrorText } from './antigravity-errors'
import { knownCursorErrorText } from './cursor-errors'
import { knownKiroAuthErrorText } from './kiro-errors'
import { knownTraeAuthErrorText, knownTraeErrorText } from './trae-errors'

// Translate stable host error codes here instead of exposing internal identifiers.
// Provider-specific codes for the same condition share the same user-facing text.
export const AUTH_ERROR_KEYS: Record<string, string> = {
  antigravity_local_not_found: 'antigravity_local_not_found',
  antigravity_local_unreadable: 'antigravity_local_unreadable',
  antigravity_auth_method_unsupported: 'antigravity_auth_method_unsupported',
  antigravity_local_keychain_denied: 'antigravity_local_keychain_denied',
  antigravity_login_expired: 'antigravity_login_expired',
  antigravity_refresh_unavailable: 'antigravity_refresh_unavailable',
  antigravity_login_invalid_flow: 'antigravity_browser_login_expired',
  antigravity_login_cancelled: 'antigravity_login_cancelled',
  antigravity_login_denied: 'antigravity_login_denied',
  antigravity_login_callback_invalid: 'antigravity_login_invalid_response',
  antigravity_login_network_error: 'antigravity_login_network_error',
  antigravity_login_invalid_response: 'antigravity_login_invalid_response',
  antigravity_login_failed: 'antigravity_login_failed',
  antigravity_login_store_failed: 'auth_err_store_write',
  antigravity_login_random_failed: 'antigravity_login_unavailable',
  antigravity_login_callback_unavailable: 'antigravity_login_unavailable',
  antigravity_login_credential_changed: 'antigravity_login_credential_changed',
  antigravity_login_endpoint_invalid: 'antigravity_login_unavailable',
  antigravity_login_unconfigured: 'antigravity_login_unconfigured',
  antigravity_login_url_invalid: 'antigravity_login_browser_failed',
  antigravity_login_browser_failed: 'antigravity_login_browser_failed',
  claude_cli_credentials_not_found: 'auth_err_local_not_found',
  codex_cli_auth_not_found: 'auth_err_local_not_found',
  // Qoder gets its own wording: two independent stores are consulted (the IDE's
  // and the CLI's), so "no credential" has to say both were checked — users who
  // are signed into the IDE otherwise read this as the check being broken.
  qoder_client_credentials_not_found: 'auth_err_qoder_not_found',
  qoder_ide_state_not_found: 'auth_err_qoder_not_found',
  qoder_ide_not_signed_in: 'auth_err_ide_not_signed_in',
  qoder_ide_secret_unreadable: 'auth_err_ide_unreadable',
  qoder_ide_keychain_denied: 'auth_err_ide_keychain',
  qoder_ide_platform_unsupported: 'auth_err_ide_unsupported',
  qwenwork_client_credentials_not_found: 'auth_err_qwenwork_not_found',
  qwenwork_local_not_signed_in: 'auth_err_qwenwork_not_signed_in',
  qwenwork_local_secret_unreadable: 'auth_err_qwenwork_unreadable',
  qwenwork_local_state_unreadable: 'auth_err_qwenwork_unreadable',
  qwenwork_local_keychain_denied: 'auth_err_qwenwork_keychain',
  qwenwork_local_platform_unsupported: 'auth_err_qwenwork_unsupported',
  qwenwork_local_machine_id_missing: 'auth_err_qwenwork_machine_id',
  qwenwork_local_pat_requires_sign_in: 'auth_err_qwenwork_pat',
  // WorkBuddy has no keychain entry and no plaintext CLI cache: its one store is
  // encrypted under a key inside its own binary, so "not found" here means the app
  // is not installed, and the runtime codes say the delegated decryption failed.
  workbuddy_local_credentials_unavailable: 'auth_err_workbuddy_not_found',
  workbuddy_local_runtime_missing: 'auth_err_workbuddy_not_found',
  workbuddy_local_not_signed_in: 'auth_err_workbuddy_not_signed_in',
  workbuddy_local_secret_unreadable: 'auth_err_workbuddy_unreadable',
  workbuddy_local_state_unreadable: 'auth_err_workbuddy_unreadable',
  workbuddy_local_runtime_failed: 'auth_err_workbuddy_unreadable',
  workbuddy_local_runtime_incompatible: 'auth_err_workbuddy_unsupported',
  workbuddy_local_platform_unsupported: 'auth_err_workbuddy_unsupported',
  // An imported login cannot be renewed by Klaus (see the engine's refusal), so
  // the only way back is to copy the live token again.
  workbuddy_adopted_credential_needs_reimport: 'auth_err_workbuddy_needs_reimport',
  workbuddy_ip_limited: 'auth_err_workbuddy_ip_limited',
  // Kimi: the codes a credential or a device flow can answer with.
  kimi_credential_rejected: 'auth_err_kimi_credential_rejected',
  kimi_api_key_empty: 'auth_err_kimi_api_key_empty',
  kimi_login_expired: 'auth_err_kimi_login_expired',
  kimi_local_credentials_unavailable: 'auth_err_kimi_not_found',
  kimi_login_expired_token: 'auth_err_kimi_login_expired',
  kimi_login_access_denied: 'auth_err_kimi_login_denied',
  // Bailian Token Plan.
  bailian_key_rejected: 'auth_err_bailian_key_rejected',
  bailian_key_not_a_plan_key: 'auth_err_bailian_not_a_plan_key',
  bailian_api_key_empty: 'auth_err_bailian_api_key_empty',
  bailian_region_unknown: 'auth_err_bailian_region_unknown',
  // MiniMax M Plan.
  minimax_key_rejected: 'auth_err_minimax_key_rejected',
  minimax_key_not_a_subscription_key: 'auth_err_minimax_not_a_subscription_key',
  minimax_api_key_empty: 'auth_err_minimax_api_key_empty',
  minimax_region_unknown: 'auth_err_minimax_region_unknown',
  // Zhipu Coding Plan.
  zhipu_key_rejected: 'auth_err_zhipu_key_rejected',
  zhipu_api_key_empty: 'auth_err_zhipu_api_key_empty',
  zhipu_region_unknown: 'auth_err_zhipu_region_unknown',
  // Volcengine Ark Coding Plan.
  ark_key_rejected: 'auth_err_ark_key_rejected',
  ark_api_key_empty: 'auth_err_ark_api_key_empty',
  ark_region_unknown: 'auth_err_ark_region_unknown',
  claude_cli_credentials_invalid: 'auth_err_local_invalid',
  codex_cli_auth_invalid: 'auth_err_local_invalid',
  qoder_client_credentials_invalid: 'auth_err_local_invalid',
  qwenwork_client_credentials_invalid: 'auth_err_local_invalid',
  workbuddy_client_credentials_invalid: 'auth_err_local_invalid',
  claude_cli_credentials_have_no_token: 'auth_err_local_no_token',
  codex_cli_auth_has_no_tokens: 'auth_err_local_no_token',
  qoder_client_credentials_have_no_token: 'auth_err_local_no_token',
  qwenwork_client_credentials_have_no_token: 'auth_err_local_no_token',
  workbuddy_client_credentials_have_no_token: 'auth_err_local_no_token',
  credential_store_write_failed: 'auth_err_store_write',
  credential_store_delete_failed: 'auth_err_store_delete',
}

const CODE_MODE_PREFIXES: Array<[string, string]> = [
  ['claude_cli_', 'subscription'],
  ['codex_cli_', 'codex'],
  ['qwenwork_', 'qwenwork'],
  ['workbuddy_', 'workbuddy'],
  ['antigravity_', 'antigravity'],
  ['cursor_', 'cursor'],
  ['qoder_', 'qoder'],
  ['trae_', 'trae'],
  ['kiro_', 'kiro'],
  ['kimi_', 'kimi'],
  ['bailian_', 'bailian'],
  ['minimax_', 'minimax'],
  ['zhipu_', 'zhipu'],
  ['ark_', 'ark'],
]

const NOT_SIGNED_IN_PROSE: Array<[RegExp, string]> = [
  [/not signed in to a Claude subscription|\bClaude (?:subscription )?is not signed in/i, 'subscription'],
  [/not signed in to a ChatGPT\/Codex subscription|\bCodex subscription is not signed in|holds no signed-in account\s*—\s*run `klaus login codex`/i, 'codex'],
  [/not signed in to a Qoder subscription|\bQoder subscription is not signed in/i, 'qoder'],
  [/not signed in to a QwenWork subscription|\bQwenWork subscription is not signed in/i, 'qwenwork'],
  [/not signed in to a WorkBuddy subscription|\bWorkBuddy subscription is not signed in/i, 'workbuddy'],
  [/not signed in to a Kimi membership|\bKimi membership is not signed in/i, 'kimi'],
  [/not signed in to a Bailian Token Plan|\bBailian Token Plan is not signed in/i, 'bailian'],
  [/not signed in to a MiniMax M Plan|\bMiniMax M Plan is not signed in/i, 'minimax'],
  [/not signed in to a Zhipu Coding Plan|\bZhipu Coding Plan is not signed in/i, 'zhipu'],
  [/not signed in to an Ark Coding Plan|\bArk Coding Plan is not signed in/i, 'ark'],
]

export function stripTransportEnvelope(raw: string): string {
  let rest = raw.trim()
  const channelMatch = /^channel '[^']+' failed:\s*/u.exec(rest)
  if (channelMatch) rest = rest.slice(channelMatch[0].length)
  const rpcMatch = /^app-server rpc error -?\d+:\s*/u.exec(rest)
  if (rpcMatch) rest = rest.slice(rpcMatch[0].length)
  return rest.trim()
}

export function embeddedAuthCode(raw: string): string | undefined {
  const match = /(?:app-server rpc error -?\d+:\s*|failed:\s*)([a-z][a-z0-9_]*_[a-z0-9_]+)\s*$/u.exec(raw)
  return match ? match[1] : undefined
}

function inferModeFromCode(code: string, fallbackMode?: string): string | undefined {
  for (const [prefix, mode] of CODE_MODE_PREFIXES) {
    if (code.startsWith(prefix)) return mode
  }
  return fallbackMode
}

function sourceDisplayName(mode: string | undefined, translate: (key: string) => string): string {
  if (!mode) return ''
  return translate(`auth_${mode}`) || mode
}

/**
 * Map engine prose sentences for unconfigured or signed-out model sources into
 * localized desktop copy without CLI instructions (`run 'klaus login …'`).
 */
export function knownEngineSourceProseErrorText(
  error: unknown,
  translate: (key: string) => string,
  fallbackMode?: string,
): string | undefined {
  if (typeof error !== 'string') return undefined
  const inner = stripTransportEnvelope(error)
  if (!inner) return undefined

  if (/no models are configured in \[modelProviders\]/i.test(inner)) {
    return translate('auth_card_custom_hint')
  }

  const expiredMatch = /the (Claude|Codex) subscription credential has expired and cannot be renewed/i.exec(inner)
  if (expiredMatch) {
    const mode = expiredMatch[1].toLowerCase() === 'claude' ? 'subscription' : 'codex'
    return translate('auth_err_source_login_expired').replace(/\{name\}/g, sourceDisplayName(mode, translate))
  }

  const invalidMatch = /(?:the stored (Claude|Codex) credential has no (?:tokens|access token)|a stored (Claude) account is missing its id|sign in again with `klaus login (claude|codex)`)/i.exec(inner)
  if (invalidMatch) {
    const vendor = (invalidMatch[1] || invalidMatch[2] || invalidMatch[3] || '').toLowerCase()
    const mode = vendor === 'claude' ? 'subscription' : 'codex'
    return translate('auth_err_source_credential_invalid').replace(/\{name\}/g, sourceDisplayName(mode, translate))
  }

  for (const [pattern, mode] of NOT_SIGNED_IN_PROSE) {
    if (pattern.test(inner)) {
      return translate('auth_err_source_not_signed_in').replace(/\{name\}/g, sourceDisplayName(mode || fallbackMode, translate))
    }
  }

  return undefined
}

/**
 * Map any known model-source error code or engine prose verdict (bare or wrapped
 * in host/RPC transport noise) to localized user-facing copy.
 */
export function knownModelSourceErrorText(
  error: unknown,
  translate: (key: string) => string,
  fallbackMode?: string,
): string | undefined {
  if (typeof error !== 'string') return undefined
  const raw = error.trim()
  if (!raw) return undefined
  const inner = stripTransportEnvelope(raw)

  const license = /^workbuddy_license_rejected:\d+:(.*)$/u.exec(inner)
  if (license) return `${translate('auth_err_workbuddy_license')} ${license[1]}`.trim()

  const prose = knownEngineSourceProseErrorText(inner, translate, fallbackMode)
  if (prose !== undefined) return prose

  const candidates = [inner, embeddedAuthCode(raw)].filter((v): v is string => Boolean(v))
  for (const candidate of candidates) {
    const mode = inferModeFromCode(candidate, fallbackMode)
    if (mode === 'kiro' || candidate.startsWith('kiro_')) {
      const known = knownKiroAuthErrorText(candidate, translate)
      if (known) return known
    }
    if (mode === 'trae' || candidate.startsWith('trae_')) {
      const known = knownTraeAuthErrorText(candidate, translate) ?? knownTraeErrorText(candidate, translate)
      if (known) return known
    }
    if (mode === 'cursor' || candidate.startsWith('cursor_')) {
      const known = knownCursorErrorText(candidate, translate)
      if (known) return known
    }
    const key = AUTH_ERROR_KEYS[candidate]
    if (key) {
      return translate(key).replace(/\{name\}/g, sourceDisplayName(mode, translate))
    }
    const antigravity = knownAntigravityErrorText(candidate, translate)
    if (antigravity) return antigravity
  }

  return undefined
}
