// Four outstanding 100 ms frames bound the transfer queue. Exhaustion is an
// explicit error, never silent sample loss. Stop flushes the final partial frame.
const TARGET_RATE = 16000
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / TARGET_RATE
    this.position = 0
    this.output = new Int16Array(1600)
    this.length = 0
    this.sequence = 0
    this.pending = new Set()
    this.stopped = false
    this.port.onmessage = event => {
      if (event.data?.type === 'ack') this.pending.delete(event.data.seq)
      if (event.data?.type === 'stop' && !this.stopped) {
        this.stopped = true
        if (this.flush()) this.port.postMessage({ type: 'stopped', seq: this.sequence })
      }
    }
  }
  process(inputs) {
    if (this.stopped) return true
    const channel = inputs[0]?.[0]
    if (!channel?.length) return true
    // Carry the full distance to the next sample across rendering blocks.
    let position = this.position
    while (position < channel.length) {
      const sample = Math.max(-1, Math.min(1, channel[Math.floor(position)]))
      this.output[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      if (this.length === this.output.length && !this.flush()) return true
      position += this.ratio
    }
    this.position = position - channel.length
    return true
  }
  flush() {
    if (!this.length) return true
    if (this.pending.size >= 4) {
      this.stopped = true
      this.port.postMessage({ type: 'error', code: 'speech-audio-overflow' })
      return false
    }
    const data = this.output.slice(0, this.length).buffer
    const seq = ++this.sequence
    this.pending.add(seq)
    this.port.postMessage({ type: 'audio', seq, data }, [data])
    this.length = 0
    return true
  }
}
registerProcessor('voice-capture', VoiceCaptureProcessor)
