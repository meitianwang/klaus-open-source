// A bounded AudioWorklet -> IPC pipeline. An exhausted credit window fails the
// recording instead of dropping microphone samples.
export class VoicePcmCapture {
  // Let the platform's band-limited resampler handle hardware sample rates.
  private readonly context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private tail: Promise<void> = Promise.resolve()
  private stopped: (() => void) | null = null
  private closed = false
  private stopping = false
  private nextSequence = 1
  private pending = 0
  constructor(private readonly stream: MediaStream,
    private readonly send: (data: ArrayBuffer, seq: number) => Promise<void>,
    private readonly failed: (error: Error) => void) {}
  async start(): Promise<void> {
    try {
      await this.context.audioWorklet.addModule('js/voice-capture-worklet.js')
      if (this.closed) throw new Error('voice-cancelled')
      this.source = this.context.createMediaStreamSource(this.stream)
      this.node = new AudioWorkletNode(this.context, 'voice-capture', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] })
      this.node.port.onmessage = event => this.message(event.data)
      this.source.connect(this.node)
      // The processor outputs silence; a connected destination keeps processing active.
      this.node.connect(this.context.destination)
      await this.context.resume()
      if (this.closed) throw new Error('voice-cancelled')
    } catch (error) { await this.close(); throw error }
  }
  private message(value: unknown): void {
    if (this.closed || !value || typeof value !== 'object') return
    const event = value as { type?: string; seq?: number; data?: ArrayBuffer; code?: string }
    if (event.type === 'error') { this.fail(new Error(event.code || 'speech-audio-overflow')); return }
    if (event.type === 'stopped') { this.stopped?.(); return }
    if (event.type !== 'audio' || !(event.data instanceof ArrayBuffer) || event.seq !== this.nextSequence || this.pending >= 4) {
      this.fail(new Error('speech-audio-sequence')); return
    }
    const data = event.data, seq = this.nextSequence++
    this.pending += 1
    const task = this.tail.then(async () => {
      if (this.closed) return
      await within(this.send(data, seq), 6000, 'speech-audio-write-timeout')
      if (!this.closed) this.node?.port.postMessage({ type: 'ack', seq })
    }).finally(() => { this.pending -= 1 })
    this.tail = task
    void task.catch(error => this.fail(error instanceof Error ? error : new Error('speech-audio-failed')))
  }
  private fail(error: Error): void {
    if (this.closed) return
    void this.close(); this.failed(error)
  }
  async stop(): Promise<void> {
    if (this.closed) return
    if (this.stopping) { await this.tail; return }
    this.stopping = true
    const flushed = new Promise<void>(resolve => { this.stopped = resolve })
    this.node?.port.postMessage({ type: 'stop' })
    try {
      await within(flushed, 2000, 'speech-audio-flush-timeout')
      await within(this.tail, 6000, 'speech-audio-drain-timeout')
    } finally { await this.close() }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stream.getTracks().forEach(track => track.stop())
    try { this.source?.disconnect() } catch { /* Already disconnected. */ }
    try { this.node?.disconnect(); this.node?.port.close() } catch { /* Already closed. */ }
    this.source = null; this.node = null
    await this.context.close().catch(() => {})
  }
}
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}
