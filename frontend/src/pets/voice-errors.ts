import { voiceErrorKey } from '../chat/voice-errors';
import { petMessages } from './messages';

/** User-facing voice failures never expose raw provider transport messages in Chinese. */
export function petVoiceError(value: unknown, language: 'en' | 'zh'): string {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  const m = petMessages(language), key = voiceErrorKey(raw);
  if (/realtime-source-not-configured/i.test(raw)) return m.realtimeNotConfigured;
  if (raw === 'empty-transcript') return m.dictationEmpty;
  if (raw === 'voice-cancel-incomplete') return m.dictationCancelIncomplete;
  if (key === 'voice_source_changed') return m.dictationSourceChanged;
  if (key === 'voice_source_unavailable') return m.dictationSourceUnavailable;
  if (key === 'voice_provider_auth_required') return m.voiceSignIn;
  if (key === 'voice_provider_usage_limit') return m.voiceUsageLimit;
  if (key) return m.dictationFailed;
  if (/mic-denied|NotAllowedError|permission|microphone access|speech-permission-denied/i.test(raw)) return m.voiceMicrophoneDenied;
  if (/realtime-source-unsupported|no configured realtime audio model|does not (?:support|declare the supported) realtime/i.test(raw)) return m.realtimeUnsupportedConversation;
  if (/no (?:explicit realtime capability|configured realtime model)|explicit (?:realtime|transcription) model/i.test(raw)) return m.realtimeModelRequired;
  if (/sign.?in|authenticat|credential|logged.?in/i.test(raw)) return m.voiceSignIn;
  if (/realtime-source-unavailable/i.test(raw)) return m.voiceSourceUnavailable;
  return language === 'en' && raw && !/^[\w-]+$/.test(raw) ? raw : m.voiceFailed;
}
