import { VoicePcmCapture } from './voice-capture'

interface Reply { ok?: boolean; sessionId?: string; error?: string; complete?: boolean }
interface SessionTransport {
  sessionStart(options: { operationId: string; context: string; source?: string; chatSessionId?: string }): Promise<Reply | null>
  sessionAudio(id: string, data: ArrayBuffer, seq: number): Promise<Reply | null>
  sessionStop(id: string): Promise<Reply | null>
  sessionCancel(id: string): Promise<Reply | null>
}
export interface PcmCaptureHandle { start(): Promise<void>; stop(): Promise<void>; close(): Promise<void> }
export interface VoiceSessionCaptureOptions {
  transport: SessionTransport
  operationId: string
  source: string
  context: string
  chatSessionId?: string
  failed(error: Error): void
  ready?(id: string): void
  pcm?(stream: MediaStream, send: (data: ArrayBuffer, seq: number) => Promise<void>, failed: (error: Error) => void): PcmCaptureHandle
}

/** Capture immediately while recognition connects, preserving the first words. */
export class VoiceSessionCapture implements PcmCaptureHandle {
  private readonly pcm: PcmCaptureHandle
  private readonly queue: Array<{ data: ArrayBuffer; seq: number }> = []
  private queueBytes = 0
  private nextSequence = 1
  private id: string
  private connecting?: Promise<void>
  private draining: Promise<void> | null = null
  private connected = false
  private closed = false
  private failed = false
  private stopping = false
  constructor(stream: MediaStream, private readonly options: VoiceSessionCaptureOptions) {
    this.id = options.operationId
    const create = options.pcm ?? ((input, send, failed) => new VoicePcmCapture(input, send, failed))
    this.pcm = create(stream, async (data, seq) => {
      if (this.closed) return
      if (seq !== this.nextSequence++ || !data.byteLength || data.byteLength % 2) throw new Error('speech-audio-sequence')
      // Covers the native helper's authorization deadline without unbounded
      // buffering. A failed connection never silently drops captured samples.
      if (this.queueBytes + data.byteLength > 16000 * 2 * 70) throw new Error('speech-audio-overflow')
      this.queue.push({ data, seq }); this.queueBytes += data.byteLength
      void this.pump().catch(error => this.fail(error))
    }, error => this.fail(error))
  }
  async start(): Promise<void> {
    this.connecting = this.options.transport.sessionStart({ operationId: this.options.operationId, context: this.options.context, source: this.options.source,
      ...(this.options.chatSessionId ? { chatSessionId: this.options.chatSessionId } : {}) }).then(async reply => {
      if (this.closed) {
        if (reply?.sessionId) await this.options.transport.sessionCancel(reply.sessionId).catch(() => {})
        return
      }
      if (!reply?.ok || !reply.sessionId) throw new Error(reply?.error || 'speech-start-failed')
      this.id = reply.sessionId; this.connected = true; this.options.ready?.(this.id)
      await this.pump()
    })
    void this.connecting.catch(error => this.fail(error))
    await this.pcm.start()
    if (this.closed) await this.pcm.close()
  }
  private pump(): Promise<void> {
    if (this.draining) return this.draining
    if (!this.connected || this.closed || !this.queue.length) return Promise.resolve()
    this.draining = (async () => {
      while (this.queue.length && !this.closed) {
        const frame = this.queue.shift()!; this.queueBytes -= frame.data.byteLength
        const reply = await this.options.transport.sessionAudio(this.id, frame.data, frame.seq)
        if (reply?.ok !== true) throw new Error(reply?.error || 'speech-audio-failed')
      }
    })().finally(() => { this.draining = null })
    return this.draining
  }
  private fail(error: unknown): void {
    if (this.closed || this.failed) return
    this.failed = true
    void this.close().catch(() => {})
    this.options.failed(error instanceof Error ? error : new Error('speech-audio-failed'))
  }
  async stop(): Promise<void> {
    if (this.closed || this.stopping) return
    this.stopping = true
    await this.pcm.stop()
    await this.connecting
    if (this.closed) return
    await this.pump()
    const reply = await this.options.transport.sessionStop(this.id)
    if (reply?.ok !== true) throw new Error(reply?.error || 'speech-stop-failed')
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; this.queue.length = 0; this.queueBytes = 0
    await this.pcm.close()
  }
}
