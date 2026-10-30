import { describe, expect, test } from 'bun:test'
import { buildOggOpusFile, oggCrc32 } from './voice-ogg'

const ascii = (text: string) => new TextEncoder().encode(text)

interface Page {
  headerType: number
  granulepos: number
  serial: number
  sequence: number
  storedCrc: number
  computedCrc: number
  segments: number[]
  packets: Uint8Array[]
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}
function parsePages(bytes: Uint8Array): Page[] {
  const pages: Page[] = []
  let offset = 0
  while (offset + 27 <= bytes.length) {
    expect(new TextDecoder().decode(bytes.subarray(offset, offset + 4))).toBe('OggS')
    // One view over the whole buffer; every read below indexes absolutely.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint8(offset + 4)).toBe(0)
    const headerType = view.getUint8(offset + 5)
    const granulepos = view.getUint32(offset + 6, true) + view.getUint32(offset + 10, true) * 0x100000000
    const serial = view.getUint32(offset + 14, true)
    const sequence = view.getUint32(offset + 18, true)
    const storedCrc = view.getUint32(offset + 22, true)
    const segmentCount = view.getUint8(offset + 26)
    const segments = Array.from(bytes.subarray(offset + 27, offset + 27 + segmentCount))
    const bodyLength = segments.reduce((sum, value) => sum + value, 0)
    const pageLength = 27 + segmentCount + bodyLength
    const raw = bytes.slice(offset, offset + pageLength)
    new DataView(raw.buffer).setUint32(22, 0, true)
    const packets: Uint8Array[] = []
    let bodyOffset = offset + 27 + segmentCount
    let packetParts: Uint8Array[] = []
    for (const segment of segments) {
      packetParts.push(bytes.subarray(bodyOffset, bodyOffset + segment))
      bodyOffset += segment
      if (segment < 255) { packets.push(concat(packetParts)); packetParts = [] }
    }
    pages.push({ headerType, granulepos, serial, sequence, storedCrc, computedCrc: oggCrc32(raw), segments, packets })
    offset += pageLength
  }
  expect(offset).toBe(bytes.length)
  return pages
}

describe('ogg/opus packaging', () => {
  test('crc matches the Ogg generator polynomial with zero init across independent vectors', () => {
    // Reference values come from an independent bitwise implementation of the
    // RFC 3533 CRC (poly 0x04c11db7, init 0, MSB-first, no reflection or xorout).
    expect(oggCrc32(ascii('123456789'))).toBe(0x89a1897f)
    expect(oggCrc32(ascii('OggS'))).toBe(0x5fb0a94f)
    expect(oggCrc32(Uint8Array.from({ length: 256 }, (_, index) => index))).toBe(0xac148725)
    expect(oggCrc32(new Uint8Array(0))).toBe(0)
    // The table implementation must agree with a bitwise reference on arbitrary bytes.
    const bitwise = (bytes: Uint8Array): number => {
      let crc = 0
      for (const byte of bytes) {
        crc = (crc ^ (byte << 24)) >>> 0
        for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0
      }
      return crc >>> 0
    }
    let seed = 7
    const random = Uint8Array.from({ length: 512 }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 65536)
    expect(oggCrc32(random)).toBe(bitwise(random))
    expect(oggCrc32(ascii('the quick brown fox'))).toBe(bitwise(ascii('the quick brown fox')))
  })
  test('a small file frames BOS head, tags and one EOS audio page with valid crc and granules', () => {
    const file = new Uint8Array(buildOggOpusFile([
      { data: ascii('aa'), granuleDelta: 960 },
      { data: ascii('bbb'), granuleDelta: 960 },
    ]))
    const pages = parsePages(file)
    expect(pages.length).toBe(3)
    expect(pages.map(page => page.sequence)).toEqual([0, 1, 2])
    for (const page of pages) expect(page.storedCrc).toBe(page.computedCrc)
    expect(new Set(pages.map(page => page.serial)).size).toBe(1)
    expect(pages[0]!.headerType).toBe(0x02)
    expect(pages[0]!.granulepos).toBe(0)
    const head = pages[0]!.packets[0]!
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe('OpusHead')
    const headView = new DataView(head.buffer, head.byteOffset)
    expect(headView.getUint8(8)).toBe(1)
    expect(headView.getUint8(9)).toBe(1)
    expect(headView.getUint16(10, true)).toBe(312)
    expect(headView.getUint32(12, true)).toBe(16000)
    expect(headView.getInt16(16, true)).toBe(0)
    expect(headView.getUint8(18)).toBe(0)
    const tags = pages[1]!.packets[0]!
    expect(new TextDecoder().decode(tags.subarray(0, 8))).toBe('OpusTags')
    const tagsView = new DataView(tags.buffer, tags.byteOffset)
    expect(tagsView.getUint32(8, true)).toBe(5)
    expect(new TextDecoder().decode(tags.subarray(12, 17))).toBe('Klaus')
    expect(tagsView.getUint32(17, true)).toBe(0)
    expect(pages[1]!.granulepos).toBe(0)
    expect(pages[1]!.headerType).toBe(0x00)
    expect(pages[2]!.headerType).toBe(0x04)
    expect(pages[2]!.granulepos).toBe(1920)
    expect(pages[2]!.packets.map(packet => new TextDecoder().decode(packet))).toEqual(['aa', 'bbb'])
  })
  test('packets longer than one segment lace with continuation and terminator values', () => {
    const big = new Uint8Array(300).fill(7)
    const pages = parsePages(new Uint8Array(buildOggOpusFile([{ data: big, granuleDelta: 960 }])))
    const audio = pages[2]!
    expect(audio.segments).toEqual([255, 45])
    expect(audio.packets.length).toBe(1)
    expect(audio.packets[0]!.length).toBe(300)
    expect(audio.granulepos).toBe(960)
  })
  test('an exactly-255-byte packet keeps its terminating zero segment', () => {
    const exact = new Uint8Array(255).fill(3)
    const pages = parsePages(new Uint8Array(buildOggOpusFile([{ data: exact, granuleDelta: 480 }])))
    expect(pages[2]!.segments).toEqual([255, 0])
    expect(pages[2]!.packets[0]!.length).toBe(255)
  })
  test('a caller-provided identification header is used verbatim', () => {
    const head = ascii('OpusHeadCUSTOMDATA!')
    const pages = parsePages(new Uint8Array(buildOggOpusFile([{ data: ascii('x'), granuleDelta: 960 }], { opusHead: head })))
    expect(pages[0]!.packets[0]).toEqual(head)
  })
  test('many packets span multiple audio pages with cumulative granules and one EOS', () => {
    const packets = Array.from({ length: 400 }, (_, index) => ({ data: new Uint8Array(80).fill(index % 251), granuleDelta: 960 }))
    const pages = parsePages(new Uint8Array(buildOggOpusFile(packets)))
    const audio = pages.slice(2)
    expect(audio.length).toBeGreaterThan(1)
    for (const page of audio.slice(0, -1)) expect(page.headerType).toBe(0x00)
    expect(audio[audio.length - 1]!.headerType).toBe(0x04)
    let granule = 0
    for (const page of audio) {
      granule += page.packets.length * 960
      expect(page.granulepos).toBe(granule)
      expect(page.segments.length).toBeLessThanOrEqual(255)
    }
    for (const page of pages) expect(page.storedCrc).toBe(page.computedCrc)
    expect(audio.reduce((sum, page) => sum + page.packets.length, 0)).toBe(400)
  })
})
