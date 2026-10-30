// Streaming dictation pipeline for cloud transcription sources.
//
// One acknowledged AudioWorklet PCM capture feeds three consumers:
// - a frame ledger that can materialize the full-session audio at any moment,
//   so stopping never waits on a transcode;
// - a silence-aware segmenter that hands bounded audio slices to an ordered,
//   single-flight partial transcriber, which keeps a live transcript on screen
//   while the user is still speaking;
// - an authoritative full-audio transcription on stop, with complete segment
//   recovery only after every interval, including the tail, has been recognized.
// Two consecutive partial failures — or a provider limit code — degrade the
// session to the single full-audio pass, mirroring a weak-network downgrade.
// Sources whose provider wire accepts it upload compact Ogg/Opus produced with
// the platform encoder; any encoding or provider-format failure degrades that
// session to WAV, which every wire accepts.
import { VOICE_AUDIO_MAX_MS, voiceAudioMaxBytes, voiceUploadContainer, type VoiceInputSource } from '../../../shared/voice-input'
import { VoicePcmCapture } from './voice-capture'
import { pcm16Wav } from './voice-audio'
import { encodeOggOpus } from './voice-ogg'
import { encodeWebmOpus, WebmOpusRecording, type VoiceAudioRecording } from './voice-webm'

export interface PipelineReply { ok?: boolean; text?: string; rawText?: string; error?: string }
export interface PipelineTransport {
  transcribe(data: ArrayBuffer, mimeType: string, operationId: string, options: { source: VoiceInputSource; context?: string; chatSessionId?: string; durationMs?: number; partial?: boolean; segmentIds?: string[] }): Promise<PipelineReply | null>
  /** Abort an in-flight partial probe (host-side task cancellation). */
  cancel?(operationId: string): Promise<unknown>
}
export interface DictationMetrics {
  pressToStreamMs: number | null
  pressToFirstFrameMs: number | null
  stopToFinalMs: number | null
  segments: number
  partialCalls: number
  partialFailures: number
  partialBytes: number
  downgraded: boolean
  container: 'wav' | 'ogg' | 'webm'
  wavFallbacks: number
  via: 'final' | 'segments' | null
}
export interface PipelineFinal { text: string; rawText?: string; via: 'final' | 'segments'; metrics: DictationMetrics }
export interface PipelineHooks {
  /** Joined partial transcript while recording; display only, never persisted. */
  partial?(text: string): void
  final(result: PipelineFinal): void
  /** Recording ended without a single captured frame. */
  empty?(metrics: DictationMetrics): void
  error(code: string, metrics: DictationMetrics): void
}
export interface PipelineCapture { start(): Promise<void>; stop(): Promise<void>; close(): Promise<void> }
export interface PipelineOptions {
  transport: PipelineTransport
  source: VoiceInputSource
  operationId: string
  context?: string
  chatSessionId?: string
  hooks: PipelineHooks
  /** Rolling segment transcription; surfaces without live text opt out and pay one call. */
  livePartials?: boolean
  /** Upload container override; defaults to the source's provider wire format. */
  container?: 'wav' | 'ogg' | 'webm'
  recording?(): VoiceAudioRecording
  /** Test seam over the platform Opus encoder. */
  encodeOgg?(frames: readonly ArrayBuffer[]): Promise<ArrayBuffer | null>
  pressedAt?: number
  streamConnectedAt?: number
  minSegmentFrames?: number
  maxSegmentFrames?: number
  capture?(stream: MediaStream, send: (data: ArrayBuffer, seq: number) => Promise<void>, failed: (error: Error) => void): PipelineCapture
  now?(): number
}

/** The production worklet emits 1600-sample (100 ms) frames at 16 kHz. */
const BYTES_PER_MS = 32
const DEFAULT_MIN_SEGMENT_FRAMES = 15
const DEFAULT_MAX_SEGMENT_FRAMES = 50
const FIRST_SEGMENT_FRAMES = 20
const QUIET_RUN_FRAMES = 2
const ENERGY_FLOOR = 0.008
const ENERGY_RATIO = 0.35
const MEAN_WINDOW_FRAMES = 60
const FAILURE_DOWNGRADE_COUNT = 2
const LIMIT_CODES = /operation_limit|rate_limited|operation_id_in_use|billing_required|audio_too_large/
const FORMAT_CODES = /format_unsupported|audio_invalid|mime_invalid|invalid_audio|provider_rejected/
const CANCELLED_CODES = /^voice-cancelled$|^voice-owner-closed$/

function frameEnergy(data: ArrayBuffer): number {
  if (data.byteLength % 2) return 0
  const view = new Int16Array(data)
  let sum = 0
  for (let i = 0; i < view.length; i++) { const s = view[i] / 32768; sum += s * s }
  return view.length ? Math.sqrt(sum / view.length) : 0
}

export class DictationPipeline {
  private readonly frames: ArrayBuffer[] = []
  private readonly energies: number[] = []
  private readonly texts = new Map<number, string>()
  private readonly receipts = new Map<number, string>()
  private readonly segments: Array<{ index: number; frames: ArrayBuffer[]; durationMs: number }> = []
  private pendingProbe: Promise<void> = Promise.resolve()
  private readonly queue: Array<{ index: number; frames: ArrayBuffer[]; durationMs: number }> = []
  private readonly maxBytes: number
  private readonly minSegmentFrames: number
  private readonly maxSegmentFrames: number
  private readonly livePartials: boolean
  private readonly encoder: (frames: readonly ArrayBuffer[]) => Promise<ArrayBuffer | null>
  private readonly now: () => number
  private container: 'wav' | 'ogg' | 'webm'
  private readonly recording: VoiceAudioRecording | null
  private capture: PipelineCapture | null = null
  private segmentStart = 0
  private nextSegment = 1
  private inFlight: { index: number; id: string } | null = null
  private totalBytes = 0
  private failures = 0
  private downgraded = false
  private formatRetried = false
  private wavFallbacks = 0
  private cancelled = false
  private stopping = false
  private finished = false
  private firstFrameAt: number | null = null
  private stopAt: number | null = null
  private partialCalls = 0
  private partialFailures = 0
  private partialBytes = 0
  private segmentCount = 0

  constructor(private readonly options: PipelineOptions) {
    this.maxBytes = voiceAudioMaxBytes(options.source)
    this.minSegmentFrames = options.minSegmentFrames ?? DEFAULT_MIN_SEGMENT_FRAMES
    this.maxSegmentFrames = Math.max(options.maxSegmentFrames ?? DEFAULT_MAX_SEGMENT_FRAMES, this.minSegmentFrames)
    this.livePartials = options.livePartials !== false
    this.container = options.container ?? voiceUploadContainer(options.source)
    this.encoder = options.encodeOgg ?? (frames => this.container === 'webm' ? encodeWebmOpus(frames) : encodeOggOpus(frames))
    this.recording = this.container === 'webm' ? (options.recording?.() ?? new WebmOpusRecording()) : null
    this.now = options.now ?? (() => Date.now())
  }

  async start(stream: MediaStream): Promise<void> {
    const create = this.options.capture ?? ((input, send, failed) => new VoicePcmCapture(input, send, failed))
    this.capture = create(stream, data => { this.append(data); return Promise.resolve() },
      error => this.fail(error instanceof Error ? error.message : 'speech-audio-failed'))
    await this.capture.start()
  }

  private durationMs(): number { return Math.round(this.totalBytes / BYTES_PER_MS) }

  private append(data: ArrayBuffer): void {
    if (this.cancelled || this.finished) return
    if (!data.byteLength || data.byteLength % 2) { this.fail('voice-audio-invalid'); return }
    this.totalBytes += data.byteLength
    if (this.firstFrameAt === null) this.firstFrameAt = this.now()
    if (this.totalBytes > this.maxBytes || this.durationMs() > VOICE_AUDIO_MAX_MS) { this.fail('audio-too-large'); return }
    this.frames.push(data)
    this.recording?.append(data)
    this.energies.push(frameEnergy(data))
    if (!this.livePartials || this.downgraded || this.stopping) return
    const since = this.frames.length - this.segmentStart
    if (since < this.minSegmentFrames) return
    const maximum = this.segmentStart === 0 && this.options.maxSegmentFrames === undefined ? FIRST_SEGMENT_FRAMES : this.maxSegmentFrames
    if (since >= maximum || this.quietTail()) this.cut()
  }

  private quietTail(): boolean {
    const window = this.energies.slice(-MEAN_WINDOW_FRAMES)
    const mean = window.reduce((sum, value) => sum + value, 0) / (window.length || 1)
    const threshold = Math.max(ENERGY_FLOOR, mean * ENERGY_RATIO)
    for (let i = this.energies.length - QUIET_RUN_FRAMES; i < this.energies.length; i++) if (this.energies[i]! >= threshold) return false
    return true
  }

  private cut(): void {
    const end = this.frames.length, slice = this.frames.slice(this.segmentStart, end)
    this.segmentStart = end
    if (!slice.length) return
    let bytes = 0
    for (const frame of slice) bytes += frame.byteLength
    this.segmentCount++
    const segment = { index: this.nextSegment++, frames: slice, durationMs: Math.round(bytes / BYTES_PER_MS) }
    this.segments.push(segment)
    this.queue.push(segment)
    this.pump()
  }

  /** Materialize ledger frames in the session's container, degrading to WAV. */
  private async materialize(frames: readonly ArrayBuffer[]): Promise<{ data: ArrayBuffer; mime: string }> {
    if (this.container === 'ogg' || this.container === 'webm') {
      const ogg = await this.encoder(frames).catch(() => null)
      if (ogg) return { data: ogg, mime: this.container === 'webm' ? 'audio/webm' : 'audio/ogg' }
      this.wavFallbacks++
    }
    return { data: pcm16Wav(frames), mime: 'audio/wav' }
  }

  private pump(): void {
    if (this.inFlight || this.cancelled || this.finished || this.stopping || !this.queue.length) return
    const next = this.queue.shift()!
    const id = `${this.options.operationId}-p${next.index}`
    this.inFlight = { index: next.index, id }
    this.partialCalls++
    this.pendingProbe = (async () => {
      const audio = await this.materialize(next.frames)
      if (this.inFlight?.id !== id || this.cancelled || this.finished) return null
      this.partialBytes += audio.data.byteLength
      return this.options.transport.transcribe(audio.data, audio.mime, id,
        { source: this.options.source, durationMs: next.durationMs, partial: true })
    })().then(reply => this.settled(id, next.index, reply)).catch(() => this.settled(id, next.index, null))
  }

  private settled(id: string, index: number, reply: PipelineReply | null): void {
    if (this.inFlight?.id !== id) return
    this.inFlight = null
    if (this.cancelled || this.finished) return
    if (reply?.ok === true) {
      this.failures = 0
      const text = typeof reply.text === 'string' ? reply.text.trim() : ''
      this.texts.set(index, text)
      this.receipts.set(index, id)
      if (text) this.options.hooks.partial?.(this.joined())
    } else {
      const code = String(reply?.error || 'voice-partial-failed')
      if (FORMAT_CODES.test(code)) this.container = 'wav'
      if (!CANCELLED_CODES.test(code)) {
        this.partialFailures++
        this.failures++
        if (LIMIT_CODES.test(code) || this.failures >= FAILURE_DOWNGRADE_COUNT) { this.downgraded = true; this.queue.length = 0 }
      }
    }
    this.pump()
  }

  private joined(): string {
    return [...this.texts.keys()].sort((a, b) => a - b).map(key => this.texts.get(key)!).filter(Boolean).join(' ')
  }

  private async recoverSegments(): Promise<PipelineReply | null> {
    await this.pendingProbe
    if (this.cancelled || this.finished) return null
    if (this.segmentStart < this.frames.length) this.cut()
    for (const segment of this.segments) {
      if (this.cancelled || this.finished) return null
      if (this.receipts.has(segment.index)) continue
      const id = `${this.options.operationId}-r${segment.index}`
      let reply: PipelineReply | null = null
      try {
        reply = await this.options.transport.transcribe(pcm16Wav(segment.frames), 'audio/wav', id,
          { source: this.options.source, durationMs: segment.durationMs, partial: true })
      } catch { return null }
      if (this.cancelled || this.finished || reply?.ok !== true) return null
      this.texts.set(segment.index, reply.text?.trim() ?? '')
      this.receipts.set(segment.index, id)
    }
    const text = this.joined()
    if (!text || this.receipts.size !== this.segments.length) return null
    // The host resolves its own receipts, applies configured polish once and
    // writes one history row. Renderer text is never trusted as an ASR result.
    try {
      const reply = await this.options.transport.transcribe(pcm16Wav(this.frames), 'audio/wav', `${this.options.operationId}-recovered`,
        { source: this.options.source, context: this.options.context, ...(this.options.chatSessionId ? { chatSessionId: this.options.chatSessionId } : {}), durationMs: this.durationMs(),
          segmentIds: this.segments.map(segment => this.receipts.get(segment.index)!) })
      return reply?.ok === true ? reply : null
    } catch { return null }
  }

  private finalCall(audio: { data: ArrayBuffer; mime: string }, id: string): Promise<PipelineReply | null> {
    return this.options.transport.transcribe(audio.data, audio.mime, id,
      { source: this.options.source, context: this.options.context, ...(this.options.chatSessionId ? { chatSessionId: this.options.chatSessionId } : {}), durationMs: this.durationMs() })
      .catch(() => null)
  }

  async stop(): Promise<void> {
    if (this.cancelled || this.stopping || this.finished) return
    this.stopping = true
    this.stopAt = this.now()
    // The capture flush still appends its tail frames to the ledger; only the
    // segmenter stops scheduling new partial probes.
    try { await this.capture?.stop() } catch (error) { this.fail(error instanceof Error ? error.message : 'speech-audio-flush-failed'); return }
    if (this.cancelled || this.finished) return
    if (!this.frames.length) { this.finishEmpty(); return }
    let reply: PipelineReply | null = null
    try {
      // The full compact stream was encoded as frames arrived. Stop only drains
      // the remaining codec packets; it never re-encodes the complete recording.
      const compact = this.container === 'webm' ? await this.recording?.finish() : null
      let audio = compact ? { data: compact, mime: 'audio/webm' } : this.recording
        ? { data: pcm16Wav(this.frames), mime: 'audio/wav' } : await this.materialize(this.frames)
      if (this.cancelled || this.finished) return
      reply = await this.finalCall(audio, this.options.operationId)
      if (this.cancelled || this.finished) return
      // A provider that rejects the compact container gets exactly one WAV
      // retry before the session falls back to joined partial text.
      if (reply?.ok !== true && audio.mime !== 'audio/wav' && !this.formatRetried
        && FORMAT_CODES.test(String(reply?.error || ''))) {
        this.formatRetried = true
        this.container = 'wav'
        audio = { data: pcm16Wav(this.frames), mime: 'audio/wav' }
        reply = await this.finalCall(audio, `${this.options.operationId}-w`)
        if (this.cancelled || this.finished) return
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'audio-too-large')
      return
    }
    const text = reply?.ok === true && typeof reply.text === 'string' ? reply.text.trim() : ''
    if (reply?.ok === true && text) {
      const rawText = typeof reply.rawText === 'string' && reply.rawText.trim() ? reply.rawText : text
      this.finish({ text, rawText, via: 'final' })
      return
    }
    // A prefix is never a successful recovery. Retry the untranscribed tail and
    // failed intervals, then require every sample interval to have a receipt.
    const code = String(reply?.error || 'voice-transcribe-failed')
    const terminal = /auth|credential|source-changed|permission|billing|rate_limit|cancelled|language/.test(code)
    const recovered = terminal ? null : await this.recoverSegments()
    if (this.cancelled || this.finished) return
    if (recovered?.text) { this.finish({ text: recovered.text, rawText: recovered.rawText, via: 'segments' }); return }
    this.fail(reply?.ok === true ? 'empty-transcript' : String(reply?.error || 'voice-transcribe-failed'))
  }

  async cancel(): Promise<void> {
    if (this.cancelled) return
    this.cancelled = true
    this.queue.length = 0
    const partialId = this.inFlight?.id
    this.inFlight = null
    if (partialId) { try { await this.options.transport.cancel?.(partialId) } catch { /* Best effort; the host also reaps on owner detach. */ } }
    try { await this.capture?.close() } catch { /* Already closed. */ }
    this.recording?.close()
  }

  private metrics(via: 'final' | 'segments' | null): DictationMetrics {
    const pressed = this.options.pressedAt
    return {
      pressToStreamMs: pressed !== undefined && this.options.streamConnectedAt !== undefined ? this.options.streamConnectedAt - pressed : null,
      pressToFirstFrameMs: pressed !== undefined && this.firstFrameAt !== null ? this.firstFrameAt - pressed : null,
      stopToFinalMs: this.stopAt !== null ? this.now() - this.stopAt : null,
      segments: this.segmentCount,
      partialCalls: this.partialCalls,
      partialFailures: this.partialFailures,
      partialBytes: this.partialBytes,
      downgraded: this.downgraded,
      container: this.container,
      wavFallbacks: this.wavFallbacks,
      via,
    }
  }

  private finish(result: { text: string; rawText?: string; via: 'final' | 'segments' }): void {
    if (this.finished || this.cancelled) return
    this.finished = true
    this.options.hooks.final({ ...result, metrics: this.metrics(result.via) })
  }

  private finishEmpty(): void {
    if (this.finished || this.cancelled) return
    this.finished = true
    this.options.hooks.empty?.(this.metrics(null))
  }

  private fail(code: string): void {
    if (this.finished || this.cancelled) return
    this.finished = true
    this.options.hooks.error(code, this.metrics(null))
  }
}
