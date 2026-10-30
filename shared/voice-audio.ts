import { VOICE_AUDIO_MAX_BYTES, VOICE_AUDIO_MAX_MS } from './voice-input'

/** Canonical 16 kHz mono PCM16LE WAV, shared by capture and recovery. */
export function pcm16Wav(frames: readonly ArrayBuffer[]): ArrayBuffer {
  const bytes = frames.reduce((size, frame) => size + frame.byteLength, 0)
  if (frames.some(frame => frame.byteLength % 2)) throw new Error('voice-audio-invalid')
  if (bytes / 32 > VOICE_AUDIO_MAX_MS || bytes + 44 > VOICE_AUDIO_MAX_BYTES) throw new Error('audio-too-large')
  const result = new ArrayBuffer(44 + bytes), view = new DataView(result)
  const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  tag(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  tag(36, 'data'); view.setUint32(40, bytes, true)
  let offset = 44
  for (const frame of frames) { new Uint8Array(result, offset, frame.byteLength).set(new Uint8Array(frame)); offset += frame.byteLength }
  return result
}
