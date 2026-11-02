/** Voice input selection is independent of the conversation model source. */
export const VOICE_INPUT_SOURCES = ['system', 'custom', 'claude', 'codex', 'workbuddy', 'antigravity', 'trae', 'qoder', 'qoderwork', 'qwenwork'] as const;
export type VoiceInputSource = typeof VOICE_INPUT_SOURCES[number];
/** The settings menu no longer offers the retired custom transcription route; a saved choice stays listed until replaced. */
export const VOICE_SELECTABLE_SOURCES = VOICE_INPUT_SOURCES.filter(source => source !== 'custom');
export type VoiceOAuthSource = Exclude<VoiceInputSource, 'system' | 'custom'>;
export const VOICE_NATIVE_STREAMING_SOURCES = ['claude', 'codex', 'workbuddy', 'antigravity', 'trae', 'qoder', 'qoderwork', 'qwenwork'] as const;
export const VOICE_INPUT_SOURCE_KEY = 'voice.input.source';
export const VOICE_DICTIONARY_TERM_MAX_LENGTH = 100;
export const VOICE_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
export const VOICE_AUDIO_MAX_MS = 5 * 60 * 1000;
export function isVoiceInputSource(value: unknown): value is VoiceInputSource {
  return typeof value === 'string' && VOICE_INPUT_SOURCES.some(source => source === value);
}
export function voiceInputSource(value: string, systemAvailable: boolean): VoiceInputSource | undefined {
  // An absent preference retains the previous platform choice. Unknown saved
  // selections remain unavailable rather than spending another source's quota.
  // Without system recognition an absent preference stays unselected: the
  // retired custom route is never guessed as a default.
  return value ? isVoiceInputSource(value) ? value : undefined : systemAvailable ? 'system' : undefined;
}
/**
 * Upload container per source. Subscription wires that mandate raw PCM keep
 * 16 kHz mono WAV; the remaining HTTP sources retain compact WebM/Opus, which
 * the renderer produces with the platform encoder and degrades to WAV whenever
 * encoding is unavailable or the provider rejects the format.
 */
export function voiceUploadContainer(source: VoiceInputSource): 'wav' | 'webm' {
  return source === 'custom' || source === 'codex' || source === 'workbuddy' ? 'webm' : 'wav';
}
export function voiceAudioMaxBytes(source: VoiceInputSource): number {
  return source === 'workbuddy' ? 16 * 1024 * 1024 : source === 'antigravity' || source === 'trae' || source === 'qoder' || source === 'qoderwork' || source === 'qwenwork' ? 12 * 1024 * 1024 : VOICE_AUDIO_MAX_BYTES;
}
/** Paced dictation includes the complete recording and a bounded provider drain. */
export function voiceTranscriptionTimeoutMs(source?: VoiceOAuthSource): number {
  return source === 'qwenwork' || source === 'antigravity' || source === 'trae' ? VOICE_AUDIO_MAX_MS + 150_000 : 60_000;
}
export function visibleVoiceInputSources(availability: Readonly<Record<string, boolean>>, selected: string): string[] {
  // The retired custom route is offered only as a preserved saved selection,
  // appended below when it is the current value.
  const sources: string[] = VOICE_SELECTABLE_SOURCES.filter(source => availability[source] !== false || source === selected);
  if (selected && !sources.includes(selected)) sources.push(selected);
  return sources;
}
