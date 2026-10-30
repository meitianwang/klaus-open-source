import { afterEach, expect, test } from 'bun:test'
import { WebmOpusRecording } from './voice-webm'

const scope = globalThis as Record<string, any>
const previous = { encoder: scope.AudioEncoder, audio: scope.AudioData }
afterEach(() => { scope.AudioEncoder = previous.encoder; scope.AudioData = previous.audio })

function codec() {
  const calls = { encoded: 0, flushed: 0, closed: 0, dataClosed: 0 }
  let output!: (chunk: unknown) => void
  let failure!: () => void
  scope.AudioEncoder = class {
    state = 'unconfigured'; encodeQueueSize = 0
    constructor(options: any) { output = options.output; failure = options.error }
    configure() { this.state = 'configured' }
    encode() {
      calls.encoded++
      output({ byteLength: 3, duration: 20000, copyTo: (buffer: Uint8Array) => buffer.set([0xf8, 0xff, 0xfe]) })
    }
    async flush() { calls.flushed++ }
    close() { this.state = 'closed'; calls.closed++ }
  }
  scope.AudioData = class { close() { calls.dataClosed++ } }
  return { calls, failure: () => failure() }
}

test('encoding runs when frames arrive, and finish never submits the recording again', async () => {
  const { calls } = codec()
  const recording = new WebmOpusRecording()
  recording.append(new ArrayBuffer(640))
  recording.append(new ArrayBuffer(640))
  expect(calls.encoded).toBe(2)
  expect(calls.flushed).toBe(0)
  const file = await recording.finish()
  expect(new Uint8Array(file!).subarray(0, 4)).toEqual(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3))
  expect(calls).toEqual({ encoded: 2, flushed: 1, closed: 1, dataClosed: 2 })
  expect(await recording.finish()).toBe(file)
})

test('unavailable codecs and encoder errors return a bounded PCM fallback signal', async () => {
  scope.AudioEncoder = undefined
  const unavailable = new WebmOpusRecording()
  unavailable.append(new ArrayBuffer(640))
  expect(await unavailable.finish()).toBeNull()
  const { failure, calls } = codec()
  const recording = new WebmOpusRecording()
  recording.append(new ArrayBuffer(640)); failure()
  expect(await recording.finish()).toBeNull()
  expect(calls.closed).toBe(1)
})

test('cancel closes the codec and prevents any further encoding or output file', async () => {
  const { calls } = codec()
  const recording = new WebmOpusRecording()
  recording.append(new ArrayBuffer(640)); recording.close()
  recording.append(new ArrayBuffer(640))
  expect(calls.encoded).toBe(1)
  expect(await recording.finish()).toBeNull()
})
