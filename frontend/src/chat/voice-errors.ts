/** Stable host/provider codes are localized without exposing transport details. */
export function voiceErrorKey(code: string): string | undefined {
  if (code === 'voice-source-changed' || code === 'provider_credential_changed' || /^(claude|codex|qoder|qwenwork|workbuddy|antigravity|trae)_(transcription_)?credential_changed$/.test(code)) return 'voice_source_changed'
  if (['voice-engine-changed', 'voice-source-unavailable', 'system-asr-unavailable', 'voice-source-requires-system'].includes(code)) return 'voice_source_unavailable'
  if (/^(claude|codex|qoder|qwenwork|workbuddy|antigravity|trae)_(transcription_)?authentication_required$/.test(code)) return 'voice_provider_auth_required'
  if (/^(claude|codex|qoder|qwenwork|workbuddy|antigravity|trae)_(transcription_)?(billing_required|rate_limited)$/.test(code)) return 'voice_provider_usage_limit'
  if (/^(claude|codex|qoder|qwenwork|workbuddy|antigravity|trae|provider)_(transcription_)?(format_unsupported|invalid_audio|audio_invalid|mime_invalid)$/.test(code)) return 'voice_provider_format'
  if (/^(claude|codex|qoder|qwenwork|workbuddy|antigravity|trae|provider)_(transcription_)?(language_invalid|language_unsupported)$/.test(code)) return 'voice_provider_language'
  if (code === 'provider_operation_cancelled' || /^(claude|codex|qoder|qwenwork|workbuddy|antigravity|trae)_(transcription_)?cancelled$/.test(code)) return 'voice_provider_cancelled'
  if (code === 'voice-provider-failed' || code === 'voice-provider-response-invalid' || /^(claude|codex|qoder|qwenwork|workbuddy|antigravity|trae|provider)_/.test(code)) return 'voice_provider_failed'
  return undefined
}
