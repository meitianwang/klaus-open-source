import { describe, expect, test } from 'bun:test'
import { DictationPipeline, type PipelineReply } from './voice-pipeline'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const stream = {} as MediaStream
const frame = (amplitude: number, samples = 1600): ArrayBuffer => {
  const data = new Int16Array(samples)
  if (amplitude) data.fill(amplitude)
  return data.buffer
}
const LOUD = 8000
const QUIET = 60

interface Call {
  data: ArrayBuffer
  mime: string
  id: string
  options: { source?: string; context?: string; chatSessionId?: string; durationMs?: number; partial?: boolean; segmentIds?: string[] }
  resolve(reply: PipelineReply | null): void
  reject(error: Error): void
}
function deferredTransport() {
  const calls: Call[] = []
  const cancels: string[] = []
  return {
    calls,
    cancels,
    last: () => calls[calls.length - 1]!,
    partials: () => calls.filter(call => call.options.partial === true),
    finals: () => calls.filter(call => call.options.partial !== true),
    transcribe: (data: ArrayBuffer, mime: string, id: string, options: Call['options']) =>
      new Promise<PipelineReply | null>((resolve, reject) => { calls.push({ data, mime, id, options, resolve, reject }) }),
    cancel: (id: string) => { cancels.push(id); return Promise.resolve(null) },
  }
}
function fakeCapture() {
  let send!: (data: ArrayBuffer, seq: number) => Promise<void>
  let failed!: (error: Error) => void
  let deferStop = false
  let stopResolve: (() => void) | null = null
  const capture = {
    started: 0, stopped: 0, closed: 0,
    start: async () => { capture.started++ },
    stop: async () => { capture.stopped++; if (deferStop) await new Promise<void>(resolve => { stopResolve = resolve }) },
    close: async () => { capture.closed++ },
    feed: (data: ArrayBuffer) => { void send(data, 0) },
    failWith: (error: Error) => failed(error),
    setDeferStop: (value: boolean) => { deferStop = value },
    releaseStop: () => { stopResolve?.(); stopResolve = null },
  }
  const factory = (_stream: MediaStream, sendFn: typeof send, failedFn: typeof failed) => {
    send = sendFn; failed = failedFn; return capture
  }
  return { capture, factory }
}
function hookSink() {
  const seen = {
    partials: [] as string[],
    finals: [] as Array<{ text: string; rawText?: string; via: 'final' | 'segments'; metrics: any }>,
    empties: 0,
    errors: [] as string[],
  }
  return {
    seen,
    hooks: {
      partial: (text: string) => { seen.partials.push(text) },
      final: (result: any) => { seen.finals.push(result) },
      empty: () => { seen.empties++ },
      error: (code: string) => { seen.errors.push(code) },
    },
  }
}
function makePipeline(config: {
  source?: 'custom' | 'antigravity'
  livePartials?: boolean
  container?: 'wav' | 'ogg'
  encodeOgg?: (frames: readonly ArrayBuffer[]) => Promise<ArrayBuffer | null>
  min?: number
  max?: number
  operationId?: string
  context?: string
  chatSessionId?: string
  now?: () => number
  pressedAt?: number
  streamConnectedAt?: number
} = {}) {
  const transport = deferredTransport()
  const { capture, factory } = fakeCapture()
  const sink = hookSink()
  const pipeline = new DictationPipeline({
    transport,
    source: config.source ?? 'custom',
    operationId: config.operationId ?? 'op-1',
    context: config.context ?? 'ctx',
    chatSessionId: config.chatSessionId,
    livePartials: config.livePartials,
    container: config.container ?? 'wav',
    encodeOgg: config.encodeOgg,
    minSegmentFrames: config.min ?? 4,
    maxSegmentFrames: config.max ?? 10,
    capture: factory,
    hooks: sink.hooks,
    now: config.now,
    pressedAt: config.pressedAt,
    streamConnectedAt: config.streamConnectedAt,
  })
  return { pipeline, transport, capture, sink }
}
const feedLoud = (capture: ReturnType<typeof fakeCapture>['capture'], count: number) => {
  for (let i = 0; i < count; i++) capture.feed(frame(LOUD))
}

describe('streaming dictation pipeline', () => {
  test('the final recording carries its dictating chat identity for shared-tier model selection', async () => {
    const { pipeline, capture, transport } = makePipeline({ chatSessionId: 'dictating-chat', livePartials: false })
    await pipeline.start(stream); feedLoud(capture, 2)
    const stopping = pipeline.stop(); await tick()
    expect(transport.finals()).toHaveLength(1)
    expect(transport.last().options.chatSessionId).toBe('dictating-chat')
    transport.last().resolve({ ok: true, text: 'Complete recording.' })
    await stopping
  })

  test('loud speech cuts at the hard cap and segments stream in order with one in flight', async () => {
    const { pipeline, transport, capture, sink } = makePipeline()
    await pipeline.start(stream)
    expect(capture.started).toBe(1)
    feedLoud(capture, 10)
    await tick()
    expect(transport.partials().length).toBe(1)
    const first = transport.last()
    expect(first.id).toBe('op-1-p1')
    expect(first.mime).toBe('audio/wav')
    expect(first.options).toMatchObject({ source: 'custom', durationMs: 1000, partial: true })
    expect(first.options.context).toBeUndefined()
    expect(first.data.byteLength).toBe(44 + 10 * 3200)
    const view = new DataView(first.data)
    expect(new TextDecoder().decode(first.data.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(10 * 3200)
    // The second cut queues behind the in-flight first probe.
    feedLoud(capture, 10)
    await tick()
    expect(transport.partials().length).toBe(1)
    first.resolve({ ok: true, text: 'hello' })
    await tick()
    expect(sink.seen.partials).toEqual(['hello'])
    expect(transport.partials().length).toBe(2)
    expect(transport.last().id).toBe('op-1-p2')
    transport.last().resolve({ ok: true, text: 'world' })
    await tick()
    expect(sink.seen.partials).toEqual(['hello', 'hello world'])
  })
  test('a silence valley cuts at the minimum length and never before it', async () => {
    const { pipeline, transport, capture } = makePipeline()
    await pipeline.start(stream)
    capture.feed(frame(LOUD)); capture.feed(frame(QUIET)); capture.feed(frame(QUIET))
    await tick(); expect(transport.partials().length).toBe(0)
    capture.feed(frame(LOUD))
    await tick(); expect(transport.partials().length).toBe(0)
    capture.feed(frame(QUIET))
    await tick(); expect(transport.partials().length).toBe(0)
    capture.feed(frame(QUIET))
    await tick(); expect(transport.partials().length).toBe(1)
    expect(transport.last().data.byteLength).toBe(44 + 6 * 3200)
  })
  test('two consecutive failures degrade the session while cancelled probes do not count', async () => {
    const { pipeline, transport, capture, sink } = makePipeline({ min: 2, max: 4 })
    await pipeline.start(stream)
    feedLoud(capture, 4)
    await tick()
    transport.last().resolve({ ok: false, error: 'voice-provider-failed' })
    await tick()
    feedLoud(capture, 4)
    await tick()
    expect(transport.partials().length).toBe(2)
    transport.last().resolve({ ok: false, error: 'VOICE_HTTP_503' })
    await tick()
    feedLoud(capture, 8)
    await tick()
    expect(transport.partials().length).toBe(2)
    const stopping = pipeline.stop()
    await tick()
    transport.last().resolve({ ok: true, text: 'full' })
    await stopping
    expect(sink.seen.finals[0]).toMatchObject({ text: 'full', via: 'final' })
    expect(sink.seen.finals[0].metrics).toMatchObject({ downgraded: true, partialCalls: 2, partialFailures: 2, segments: 2, container: 'wav', wavFallbacks: 0 })

    const second = makePipeline({ min: 2, max: 4 })
    await second.pipeline.start(stream)
    feedLoud(second.capture, 4)
    await tick()
    second.transport.last().resolve({ ok: false, error: 'voice-cancelled' })
    await tick()
    feedLoud(second.capture, 4)
    await tick()
    expect(second.transport.partials().length).toBe(2)
    second.transport.last().resolve({ ok: true, text: 'ok' })
    await tick()
    expect(second.sink.seen.partials).toEqual(['ok'])
  })
  test('a provider limit code degrades the session immediately', async () => {
    const { pipeline, transport, capture, sink } = makePipeline({ min: 2, max: 4 })
    await pipeline.start(stream)
    feedLoud(capture, 4)
    await tick()
    transport.last().resolve({ ok: false, error: 'qoder_transcription_operation_limit' })
    await tick()
    feedLoud(capture, 8)
    await tick()
    expect(transport.partials().length).toBe(1)
    const stopping = pipeline.stop()
    await tick()
    transport.last().resolve({ ok: true, text: 'full' })
    await stopping
    expect(sink.seen.finals[0].metrics.downgraded).toBe(true)
  })
  test('stop sends the full-session audio as the authoritative pass and its result wins', async () => {
    const { pipeline, transport, capture, sink } = makePipeline()
    await pipeline.start(stream)
    feedLoud(capture, 5)
    await tick()
    expect(transport.calls.length).toBe(0)
    const stopping = pipeline.stop()
    await tick()
    expect(transport.finals().length).toBe(1)
    const final = transport.last()
    expect(final.id).toBe('op-1')
    expect(final.mime).toBe('audio/wav')
    expect(final.options).toMatchObject({ source: 'custom', context: 'ctx', durationMs: 500 })
    expect(final.options.partial).toBeUndefined()
    expect(final.data.byteLength).toBe(44 + 5 * 3200)
    final.resolve({ ok: true, text: ' hello world ', rawText: 'raw' })
    await stopping
    expect(sink.seen.finals.length).toBe(1)
    expect(sink.seen.finals[0]).toMatchObject({ text: 'hello world', rawText: 'raw', via: 'final' })
  })
  test('a failed full-audio pass falls back to the joined partial text', async () => {
    const { pipeline, transport, capture, sink } = makePipeline({ min: 2, max: 4 })
    await pipeline.start(stream)
    feedLoud(capture, 4)
    await tick()
    transport.last().resolve({ ok: true, text: 'hello' })
    await tick()
    feedLoud(capture, 4)
    await tick()
    transport.last().resolve({ ok: true, text: 'world' })
    await tick()
    expect(sink.seen.partials).toEqual(['hello', 'hello world'])
    const stopping = pipeline.stop()
    await tick()
    transport.last().resolve({ ok: false, error: 'VOICE_HTTP_503' })
    await tick()
    expect(transport.last().options.segmentIds).toEqual(['op-1-p1', 'op-1-p2'])
    transport.last().resolve({ ok: true, text: 'hello world', rawText: 'hello world' })
    await stopping
    expect(sink.seen.finals[0]).toMatchObject({ text: 'hello world', via: 'segments' })
    expect(sink.seen.finals[0].metrics.partialCalls).toBe(2)
  })
  test('when both passes fail the provider error code survives for localization', async () => {
    const { pipeline, transport, capture, sink } = makePipeline()
    await pipeline.start(stream)
    feedLoud(capture, 3)
    const stopping = pipeline.stop()
    await tick()
    transport.last().resolve({ ok: false, error: 'claude_transcription_authentication_required' })
    await stopping
    expect(sink.seen.errors).toEqual(['claude_transcription_authentication_required'])
    expect(sink.seen.finals).toEqual([])
  })
  test('an empty recording reports empty without any provider call', async () => {
    const { pipeline, transport, capture, sink } = makePipeline()
    await pipeline.start(stream)
    await pipeline.stop()
    expect(sink.seen.empties).toBe(1)
    expect(transport.calls.length).toBe(0)
    expect(capture.stopped).toBe(1)
  })
  test('tail frames flushed during stop still extend the full-audio pass but schedule no partials', async () => {
    const { pipeline, transport, capture } = makePipeline({ min: 2, max: 4 })
    await pipeline.start(stream)
    feedLoud(capture, 3)
    capture.setDeferStop(true)
    const stopping = pipeline.stop()
    await tick()
    expect(capture.stopped).toBe(1)
    capture.feed(frame(LOUD)); capture.feed(frame(LOUD))
    expect(transport.partials().length).toBe(0)
    capture.releaseStop()
    await tick()
    expect(transport.finals().length).toBe(1)
    expect(transport.last().data.byteLength).toBe(44 + 5 * 3200)
    transport.last().resolve({ ok: true, text: 'x' })
    await stopping
  })
  test('cancel aborts the in-flight partial, ignores late replies and suppresses the final pass', async () => {
    const { pipeline, transport, capture, sink } = makePipeline({ min: 2, max: 4 })
    await pipeline.start(stream)
    feedLoud(capture, 4)
    await tick()
    expect(transport.partials().length).toBe(1)
    await pipeline.cancel()
    expect(transport.cancels).toEqual(['op-1-p1'])
    expect(capture.closed).toBe(1)
    transport.last().resolve({ ok: true, text: 'late' })
    await tick()
    expect(sink.seen.partials).toEqual([])
    await pipeline.stop()
    expect(transport.finals().length).toBe(0)
    expect(sink.seen.finals).toEqual([])
  })
  test('disabling live partials keeps exactly one provider call for the whole session', async () => {
    const { pipeline, transport, capture } = makePipeline({ livePartials: false, max: 4 })
    await pipeline.start(stream)
    feedLoud(capture, 20)
    await tick()
    expect(transport.calls.length).toBe(0)
    const stopping = pipeline.stop()
    await tick()
    expect(transport.calls.length).toBe(1)
    expect(transport.finals().length).toBe(1)
    transport.last().resolve({ ok: true, text: 'only' })
    await stopping
  })
  test('the duration bound fails the recording with audio-too-large and stops further work', async () => {
    const { pipeline, transport, capture, sink } = makePipeline({ livePartials: false })
    await pipeline.start(stream)
    const big = new ArrayBuffer(4 * 1024 * 1024)
    capture.feed(big); capture.feed(big)
    expect(sink.seen.errors).toEqual([])
    capture.feed(big)
    expect(sink.seen.errors).toEqual(['audio-too-large'])
    capture.feed(frame(LOUD))
    await pipeline.stop()
    expect(transport.calls.length).toBe(0)
  })
  test('metrics measure press, stream, first frame and stop-to-final', async () => {
    let clock = 0
    const { pipeline, transport, capture, sink } = makePipeline({ livePartials: false, now: () => clock, pressedAt: 100, streamConnectedAt: 250 })
    clock = 300
    await pipeline.start(stream)
    clock = 400
    capture.feed(frame(LOUD))
    clock = 900
    const stopping = pipeline.stop()
    await tick()
    clock = 1400
    transport.last().resolve({ ok: true, text: 'x' })
    await stopping
    expect(sink.seen.finals[0].metrics).toMatchObject({
      pressToStreamMs: 150,
      pressToFirstFrameMs: 300,
      stopToFinalMs: 500,
      segments: 0,
      partialCalls: 0,
      downgraded: false,
      container: 'wav',
      wavFallbacks: 0,
      via: 'final',
    })
  })
  test('a capture failure surfaces its code once', async () => {
    const { pipeline, capture, sink } = makePipeline()
    await pipeline.start(stream)
    capture.failWith(new Error('speech-audio-overflow'))
    expect(sink.seen.errors).toEqual(['speech-audio-overflow'])
    capture.feed(frame(LOUD))
    await pipeline.stop()
  })
  test('compact-container sources upload ogg segments and fall back to wav when the encoder fails', async () => {
    const marker = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]).buffer
    let encoderCalls = 0
    const { pipeline, transport, capture, sink } = makePipeline({
      min: 2, max: 4, container: 'ogg',
      encodeOgg: async () => { encoderCalls++; return encoderCalls <= 1 ? marker : null },
    })
    await pipeline.start(stream)
    feedLoud(capture, 4)
    await tick()
    expect(transport.partials().length).toBe(1)
    expect(transport.last().mime).toBe('audio/ogg')
    expect(transport.last().data).toBe(marker)
    expect(transport.last().options).toMatchObject({ durationMs: 400, partial: true })
    transport.last().resolve({ ok: true, text: 'compact' })
    await tick()
    feedLoud(capture, 4)
    await tick()
    expect(transport.partials().length).toBe(2)
    expect(transport.last().mime).toBe('audio/wav')
    expect(transport.last().data.byteLength).toBe(44 + 4 * 3200)
    transport.last().resolve({ ok: true, text: 'wide' })
    await tick()
    const stopping = pipeline.stop()
    await tick()
    expect(transport.last().mime).toBe('audio/wav')
    transport.last().resolve({ ok: true, text: 'done' })
    await stopping
    expect(sink.seen.finals[0].metrics).toMatchObject({ container: 'ogg', wavFallbacks: 2, via: 'final' })
  })
  test('a provider format rejection switches the session container to wav', async () => {
    const marker = new Uint8Array([1]).buffer
    const { pipeline, transport, capture, sink } = makePipeline({ min: 2, max: 4, container: 'ogg', encodeOgg: async () => marker })
    await pipeline.start(stream)
    feedLoud(capture, 4)
    await tick()
    expect(transport.last().mime).toBe('audio/ogg')
    transport.last().resolve({ ok: false, error: 'custom_transcription_format_unsupported' })
    await tick()
    feedLoud(capture, 4)
    await tick()
    expect(transport.partials().length).toBe(2)
    expect(transport.last().mime).toBe('audio/wav')
    transport.last().resolve({ ok: true, text: 'seg' })
    await tick()
    const stopping = pipeline.stop()
    await tick()
    expect(transport.last().mime).toBe('audio/wav')
    transport.last().resolve({ ok: true, text: 'done' })
    await stopping
    expect(sink.seen.finals[0].metrics).toMatchObject({ container: 'wav', wavFallbacks: 0, partialFailures: 1 })
  })
  test('a final-pass format rejection retries once with wav', async () => {
    const marker = new Uint8Array([1]).buffer
    const { pipeline, transport, capture, sink } = makePipeline({ livePartials: false, container: 'ogg', encodeOgg: async () => marker })
    await pipeline.start(stream)
    feedLoud(capture, 3)
    const stopping = pipeline.stop()
    await tick()
    expect(transport.finals().length).toBe(1)
    expect(transport.last().mime).toBe('audio/ogg')
    expect(transport.last().id).toBe('op-1')
    transport.last().resolve({ ok: false, error: 'workbuddy_transcription_mime_invalid' })
    await tick()
    expect(transport.finals().length).toBe(2)
    expect(transport.last().mime).toBe('audio/wav')
    expect(transport.last().id).toBe('op-1-w')
    transport.last().resolve({ ok: true, text: 'retried' })
    await stopping
    expect(sink.seen.finals[0]).toMatchObject({ text: 'retried', via: 'final' })
    expect(sink.seen.finals[0].metrics.container).toBe('wav')
  })
})
