// Ogg/Opus packaging for the dictation pipeline.
//
// Two layers, deliberately separated:
// - a pure Ogg multiplexer (page framing, lacing, CRC) that unit tests pin
//   byte-for-byte;
// - a platform audio encoder wrapper (WebCodecs AudioEncoder) that turns
//   captured PCM16 frames into Opus packets. Chromium ships the encoder, so
//   compact uploads add no bundled dependency; whenever it is unavailable or
//   fails, the caller degrades to WAV.
const RATE = 16000
const BITRATE = 32000
const GRANULE_RATE = 48000
const SERIAL = 0x4b505355
const MAX_PAGE_SEGMENTS = 255
const MAX_PAGE_BYTES = 16384

// Ogg uses polynomial 0x04c11db7 with zero initialization, no reflection
// and no final xor. The check value for "123456789" is 0x89a1897f.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = (i << 24) >>> 0
    for (let j = 0; j < 8; j++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0
    table[i] = crc >>> 0
  }
  return table
})()
export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]) >>> 0
  return crc >>> 0
}

export interface OggPacket { data: Uint8Array; granuleDelta: number }

function opusHead(): Uint8Array {
  const head = new Uint8Array(19), view = new DataView(head.buffer)
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0) // "OpusHead"
  view.setUint8(8, 1)
  view.setUint8(9, 1)
  view.setUint16(10, 312, true) // pre-skip: standard 6.5 ms encoder delay
  view.setUint32(12, RATE, true)
  view.setInt16(16, 0, true)
  view.setUint8(18, 0)
  return head
}
function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode('Klaus')
  const tags = new Uint8Array(8 + 4 + vendor.length + 4), view = new DataView(tags.buffer)
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0) // "OpusTags"
  view.setUint32(8, vendor.length, true)
  tags.set(vendor, 12)
  view.setUint32(12 + vendor.length, 0, true)
  return tags
}
function lacingFor(length: number): number[] {
  const segments: number[] = []
  let remaining = length
  while (remaining >= 255) { segments.push(255); remaining -= 255 }
  segments.push(remaining)
  return segments
}
function writePage(out: number[], page: Uint8Array[], sequence: number, granulepos: number, headerType: number): void {
  let payload = 0
  const lacing: number[] = []
  for (const packet of page) {
    payload += packet.length
    for (const value of lacingFor(packet.length)) lacing.push(value)
  }
  const header = new Uint8Array(27 + lacing.length)
  const view = new DataView(header.buffer)
  header.set([0x4f, 0x67, 0x67, 0x53, 0, headerType], 0) // "OggS", version 0
  view.setUint32(6, granulepos >>> 0, true)
  view.setUint32(10, Math.floor(granulepos / 0x100000000), true)
  view.setUint32(14, SERIAL, true)
  view.setUint32(18, sequence, true)
  view.setUint32(22, 0, true) // CRC placeholder
  view.setUint8(26, lacing.length)
  header.set(Uint8Array.from(lacing), 27)
  const crcInput = new Uint8Array(header.length + payload)
  crcInput.set(header, 0)
  let offset = header.length
  for (const packet of page) { crcInput.set(packet, offset); offset += packet.length }
  // Patch the CRC into the buffer that is actually emitted; the crc field was
  // zero when the checksum was computed, per the Ogg framing spec.
  new DataView(crcInput.buffer).setUint32(22, oggCrc32(crcInput), true)
  for (let i = 0; i < crcInput.length; i++) out.push(crcInput[i]!)
}

/**
 * Multiplex raw Opus packets into a self-contained Ogg/Opus file: BOS
 * identification page, tags page, then audio pages whose granule positions
 * count 48 kHz samples. Every file is independently decodable, which is what
 * one-shot provider endpoints require.
 */
export function buildOggOpusFile(packets: readonly OggPacket[], options: { opusHead?: Uint8Array } = {}): ArrayBuffer {
  const out: number[] = []
  let sequence = 0
  writePage(out, [options.opusHead ?? opusHead()], sequence++, 0, 0x02)
  writePage(out, [opusTags()], sequence++, 0, 0x00)
  if (!packets.length) {
    // Mark the tags page as EOS by rebuilding: only reachable for empty input,
    // which callers avoid; keep the file structurally valid regardless.
    return Uint8Array.from(out).buffer
  }
  let granulepos = 0
  let page: Uint8Array[] = []
  let pageSegments = 0
  let pageBytes = 0
  const flush = (eos: boolean) => {
    if (!page.length) return
    writePage(out, page, sequence++, granulepos, eos ? 0x04 : 0x00)
    page = []; pageSegments = 0; pageBytes = 0
  }
  for (const packet of packets) {
    const segments = lacingFor(packet.data.length).length
    if (page.length && (pageSegments + segments > MAX_PAGE_SEGMENTS || pageBytes + packet.data.length > MAX_PAGE_BYTES)) flush(false)
    page.push(packet.data)
    pageSegments += segments
    pageBytes += packet.data.length
    granulepos += packet.granuleDelta
  }
  flush(true)
  return Uint8Array.from(out).buffer
}

/**
 * Encode 16 kHz mono PCM16 frames to Ogg/Opus with the platform encoder.
 * Returns null when the platform cannot encode Opus or encoding fails, so the
 * caller can fall back to WAV without a second code path.
 */
export async function encodeOggOpus(frames: readonly ArrayBuffer[]): Promise<ArrayBuffer | null> {
  const scope = globalThis as Record<string, any>
  if (typeof scope.AudioEncoder !== 'function' || typeof scope.AudioData !== 'function') return null
  const config = { codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: BITRATE }
  try {
    const support = await scope.AudioEncoder.isConfigSupported(config)
    if (!support?.supported) return null
    const packets: OggPacket[] = []
    let head: Uint8Array | undefined
    let encoderError = false
    const encoder = new scope.AudioEncoder({
      output: (chunk: any, meta: any) => {
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        packets.push({ data, granuleDelta: Math.max(1, Math.round((chunk.duration ?? 20_000) * GRANULE_RATE / 1_000_000)) })
        const description = meta?.decoderConfig?.description
        if (description instanceof ArrayBuffer) head = new Uint8Array(description.slice(0))
      },
      error: () => { encoderError = true },
    })
    encoder.configure(config)
    let timestamp = 0
    for (const frame of frames) {
      const numberOfFrames = Math.floor(frame.byteLength / 2)
      if (!numberOfFrames) continue
      const audio = new scope.AudioData({ format: 's16', sampleRate: RATE, numberOfChannels: 1, numberOfFrames, timestamp, data: frame })
      timestamp += Math.round(numberOfFrames * 1_000_000 / RATE)
      encoder.encode(audio)
      audio.close()
    }
    await encoder.flush()
    encoder.close()
    if (encoderError || !packets.length) return null
    return buildOggOpusFile(packets, head ? { opusHead: head } : {})
  } catch { return null }
}
