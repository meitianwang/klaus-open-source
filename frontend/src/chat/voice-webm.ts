import type { OggPacket } from './voice-ogg'

const text = (value: string) => new TextEncoder().encode(value)
function join(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.byteLength }
  return result
}
function id(value: number): Uint8Array {
  const bytes: number[] = []
  do { bytes.unshift(value & 255); value = Math.floor(value / 256) } while (value)
  return Uint8Array.from(bytes)
}
function size(value: number): Uint8Array {
  let width = 1
  while (value >= 2 ** (width * 7) - 1) width++
  const bytes = new Uint8Array(width)
  for (let i = width - 1; i >= 0; i--) { bytes[i] = value % 256; value = Math.floor(value / 256) }
  bytes[0] |= 1 << (8 - width)
  return bytes
}
function element(tag: number, data: Uint8Array): Uint8Array { return join([id(tag), size(data.byteLength), data]) }
function uint(tag: number, value: number): Uint8Array { return element(tag, id(value)) }
function float(tag: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value)
  return element(tag, bytes)
}
function master(tag: number, children: readonly Uint8Array[]): Uint8Array { return element(tag, join(children)) }

/** Standard WebM/Opus file, accepted by file-based speech endpoints. */
export function buildWebmOpusFile(packets: readonly OggPacket[], samples: number, head?: Uint8Array): ArrayBuffer {
  if (!packets.length || samples <= 0) throw new Error('empty-audio')
  if (!head) {
    head = new Uint8Array(19); head.set(text('OpusHead'))
    const view = new DataView(head.buffer)
    view.setUint8(8, 1); view.setUint8(9, 1); view.setUint16(10, 312, true); view.setUint32(12, 16000, true)
  }
  const delay = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true) / 48000
  const header = master(0x1a45dfa3, [uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), element(0x4282, text('webm')), uint(0x4287, 4), uint(0x4285, 2)])
  const info = master(0x1549a966, [uint(0x2ad7b1, 1000000), float(0x4489, samples / 16), element(0x4d80, text('Klaus')), element(0x5741, text('Klaus'))])
  const tracks = master(0x1654ae6b, [master(0xae, [uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 2), element(0x86, text('A_OPUS')), element(0x63a2, head), uint(0x56aa, Math.round(delay * 1e9)), uint(0x56bb, 80000000), master(0xe1, [float(0xb5, 48000), uint(0x9f, 1)])])])
  const clusters: Uint8Array[] = []
  let granule = 0, clusterAt = 0, blocks: Uint8Array[] = []
  const flush = () => { if (blocks.length) clusters.push(master(0x1f43b675, [uint(0xe7, clusterAt), ...blocks])); blocks = [] }
  for (const packet of packets) {
    const at = Math.round(granule / 48)
    if (at - clusterAt > 10000) { flush(); clusterAt = at }
    const prefix = new Uint8Array(4); prefix[0] = 0x81; new DataView(prefix.buffer).setInt16(1, at - clusterAt); prefix[3] = 0x80
    blocks.push(element(0xa3, join([prefix, packet.data])))
    granule += packet.granuleDelta
  }
  flush()
  return join([header, master(0x18538067, [info, tracks, ...clusters])]).buffer
}

export interface VoiceAudioRecording {
  append(data: ArrayBuffer): void
  finish(): Promise<ArrayBuffer | null>
  close(): void
}

/** Encode each captured frame immediately; finish only drains the codec tail and muxes. */
export class WebmOpusRecording implements VoiceAudioRecording {
  private encoder: any = null
  private packets: OggPacket[] = []
  private head?: Uint8Array
  private samples = 0
  private failed = false
  private ended = false
  private finishing?: Promise<ArrayBuffer | null>
  constructor() {
    const scope = globalThis as Record<string, any>
    if (typeof scope.AudioEncoder !== 'function' || typeof scope.AudioData !== 'function') { this.failed = true; return }
    try {
      this.encoder = new scope.AudioEncoder({
        output: (chunk: any, metadata: any) => {
          const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data)
          this.packets.push({ data, granuleDelta: Math.round((chunk.duration ?? 20000) * 48000 / 1e6) })
          const description = metadata?.decoderConfig?.description
          if (description) {
            const bytes = description instanceof ArrayBuffer ? new Uint8Array(description) : new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
            this.head = Uint8Array.from(bytes)
          }
        },
        error: () => { this.failed = true },
      })
      this.encoder.configure({ codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 32000 })
    } catch { this.failed = true; this.close() }
  }
  append(data: ArrayBuffer): void {
    if (this.failed || this.ended || !data.byteLength) return
    const scope = globalThis as Record<string, any>
    let audio: any
    try {
      if (data.byteLength % 2 || this.encoder.encodeQueueSize > 100) throw new Error('voice-encoder-overflow')
      const count = data.byteLength / 2
      audio = new scope.AudioData({ format: 's16', sampleRate: 16000, numberOfChannels: 1, numberOfFrames: count, timestamp: Math.round(this.samples * 1e6 / 16000), data })
      this.samples += count
      this.encoder.encode(audio)
    } catch { this.failed = true; this.close() }
    finally { audio?.close() }
  }
  finish(): Promise<ArrayBuffer | null> {
    if (this.finishing) return this.finishing
    this.ended = true
    this.finishing = (async () => {
      try {
        if (this.failed || !this.encoder || !this.samples) return null
        await this.encoder.flush()
        if (this.failed || !this.packets.length) return null
        return buildWebmOpusFile(this.packets, this.samples, this.head)
      } catch { return null }
      finally { this.close() }
    })()
    return this.finishing
  }
  close(): void {
    this.ended = true
    try { if (this.encoder?.state !== 'closed') this.encoder?.close() } catch { /* Already closed. */ }
    this.encoder = null; this.packets = []
  }
}

export async function encodeWebmOpus(frames: readonly ArrayBuffer[]): Promise<ArrayBuffer | null> {
  const recording = new WebmOpusRecording()
  for (const frame of frames) recording.append(frame)
  return recording.finish()
}
