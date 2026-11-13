import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { pcm16Wav } from './voice-audio'
import { voiceInputSource, VOICE_INPUT_SOURCES, VOICE_SELECTABLE_SOURCES, VOICE_NATIVE_STREAMING_SOURCES, voiceAudioMaxBytes, voiceUploadContainer, visibleVoiceInputSources } from '../../../shared/voice-input'
import { voiceErrorKey } from './voice-errors'

const frame = (values: number[]) => Int16Array.from(values).buffer

describe('voice input source and audio contracts', () => {
  test('committed source vector pins provider availability and language/bounds without changing saved intent', () => {
    const vector = JSON.parse(readFileSync(new URL('../../../contracts/vectors/voice-input-source-vectors.json', import.meta.url), 'utf8'))
    expect([...VOICE_SELECTABLE_SOURCES]).toEqual(vector.sources)
    expect(VOICE_INPUT_SOURCES).toContain('custom')
    expect(VOICE_SELECTABLE_SOURCES).not.toContain('custom')
    expect(vector.localeOverrideSources).toEqual([])
    for (const source of ['workbuddy', 'qoder', 'qoderwork', 'qwenwork', 'trae'] as const) expect(voiceAudioMaxBytes(source)).toBe(vector.providerAudioMaxBytes[source])
    // Container policy: PCM-pinned subscription wires keep 16 kHz mono WAV;
    // the remaining HTTP sources upload compact Ogg/Opus with WAV fallback.
    expect(vector.pcm16Mono16000Wav).toEqual(['claude', 'qoder', 'qoderwork', 'qwenwork', 'antigravity', 'trae'])
    expect(vector.uploadContainers.webmOpus32k).toEqual(['custom', 'codex', 'workbuddy'])
    for (const source of VOICE_INPUT_SOURCES) expect(voiceUploadContainer(source)).toBe(vector.uploadContainers.webmOpus32k.includes(source) ? 'webm' : 'wav')
    expect(vector.transcriptionTimeoutMs.partial).toBe(20000)
    expect(vector.fileTranscription.completion).toBe('the full-audio final pass is authoritative; recovery requires every interval including the tail and consumes host receipts once')
    expect(vector.experience.choices).toEqual(['realtime', 'compatibility'])
    expect(['system', ...VOICE_NATIVE_STREAMING_SOURCES]).toEqual(vector.experience.realtimeSources)
    expect(VOICE_NATIVE_STREAMING_SOURCES).toContain('codex')
    expect(vector.streamingDictation.encoding).toBe('s16le')
    expect(vector.voicePreferences.automaticRefinement).toBe(true)
  })
  test('disabled capability is hidden unless selected, and retained selection can recover without fallback', () => {
    expect(visibleVoiceInputSources({ workbuddy: false }, 'codex')).not.toContain('workbuddy')
    expect(visibleVoiceInputSources({ workbuddy: false }, 'workbuddy')).toContain('workbuddy')
    expect(visibleVoiceInputSources({ workbuddy: true }, 'codex')).toContain('workbuddy')
    expect(visibleVoiceInputSources({ workbuddy: false }, 'retired')).toContain('retired')
  })
  test('absent source retains platform behavior while unsupported saved intent stays unavailable', () => {
    expect(voiceInputSource('', true)).toBe('system')
    expect(voiceInputSource('', false)).toBeUndefined()
    expect(voiceInputSource('custom', false)).toBe('custom')
    expect(visibleVoiceInputSources({}, '')).not.toContain('custom')
    expect(visibleVoiceInputSources({}, 'custom')).toContain('custom')
    expect(voiceInputSource('unknown', true)).toBeUndefined()
    expect(voiceAudioMaxBytes('workbuddy')).toBe(16 * 1024 * 1024); expect(voiceAudioMaxBytes('qoderwork')).toBe(12 * 1024 * 1024)
    for (const source of VOICE_INPUT_SOURCES) expect(voiceInputSource(source, false)).toBe(source)
  })
  test('pcm16Wav wraps captured frames in a canonical 16 kHz mono WAV container', () => {
    const wav = pcm16Wav([frame([100, -200]), frame([300])])
    const view = new DataView(wav)
    expect(wav.byteLength).toBe(44 + 6)
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 6)
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE')
    expect(new TextDecoder().decode(wav.slice(12, 16))).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(new TextDecoder().decode(wav.slice(36, 40))).toBe('data')
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.getInt16(44, true)).toBe(100)
    expect(view.getInt16(46, true)).toBe(-200)
    expect(view.getInt16(48, true)).toBe(300)
    expect(pcm16Wav([]).byteLength).toBe(44)
  })
  test('pcm16Wav rejects odd byte streams and recordings beyond the duration bound', () => {
    expect(() => pcm16Wav([new Uint8Array([1, 2, 3]).buffer])).toThrow('voice-audio-invalid')
    const minute = new ArrayBuffer(16000 * 2 * 60)
    expect(() => pcm16Wav([minute, minute, minute, minute, minute, minute])).toThrow('audio-too-large')
  })
  test('known source errors localize without exposing transport content', () => {
    expect(voiceErrorKey('voice-source-changed')).toBe('voice_source_changed')
    expect(voiceErrorKey('claude_transcription_authentication_required')).toBe('voice_provider_auth_required')
    expect(voiceErrorKey('qoder_transcription_format_unsupported')).toBe('voice_provider_format')
    expect(voiceErrorKey('voice-provider-failed')).toBe('voice_provider_failed')
    expect(voiceErrorKey('codex_transcription_rate_limited')).toBe('voice_provider_usage_limit')
    expect(voiceErrorKey('claude_transcription_billing_required')).toBe('voice_provider_usage_limit')
    expect(voiceErrorKey('provider_transcription_audio_invalid')).toBe('voice_provider_format')
    expect(voiceErrorKey('provider_transcription_language_invalid')).toBe('voice_provider_language')
    expect(voiceErrorKey('provider_operation_cancelled')).toBe('voice_provider_cancelled')
  })
})
