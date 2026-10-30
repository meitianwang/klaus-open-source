export interface VoiceActivity {
  speechStarted: boolean;
  utteranceEnded: boolean;
  reason?: "silence" | "maximum";
  level: number;
}

/** Segments the same acknowledged PCM frames sent to speech recognition. */
export class VoiceActivityDetector {
  private speechMs = 0;
  private silenceMs = 0;
  private durationMs = 0;
  private started = false;
  private ended = false;
  private noiseFloor = 0.002;

  constructor(
    private readonly options: {
      startMs?: number;
      silenceMs?: number;
      maximumMs?: number;
    } = {},
  ) {}

  push(buffer: ArrayBuffer): VoiceActivity {
    if (buffer.byteLength % 2 !== 0)
      throw new Error("Voice audio contains an incomplete PCM sample");
    const samples = new DataView(buffer);
    let squared = 0;
    for (let index = 0; index < samples.byteLength; index += 2) {
      const sample = samples.getInt16(index, true) / 32768;
      squared += sample * sample;
    }
    const count = samples.byteLength / 2;
    const level = count ? Math.sqrt(squared / count) : 0;
    const frameMs = (count / 16000) * 1000;
    if (this.ended || !count)
      return { speechStarted: false, utteranceEnded: false, level };
    const voiced = level >= Math.max(0.012, this.noiseFloor * 3);
    if (!this.started && !voiced)
      this.noiseFloor = this.noiseFloor * 0.96 + level * 0.04;
    let speechStarted = false;
    if (!this.started) {
      this.speechMs = voiced ? this.speechMs + frameMs : 0;
      if (this.speechMs >= (this.options.startMs ?? 200)) {
        this.started = true;
        speechStarted = true;
      }
    }
    if (this.started) {
      this.durationMs += frameMs;
      this.silenceMs = voiced ? 0 : this.silenceMs + frameMs;
      const reason =
        this.durationMs >= (this.options.maximumMs ?? 30000)
          ? "maximum"
          : this.silenceMs >= (this.options.silenceMs ?? 800)
            ? "silence"
            : undefined;
      if (reason) {
        this.ended = true;
        return { speechStarted, utteranceEnded: true, reason, level };
      }
    }
    return { speechStarted, utteranceEnded: false, level };
  }
}
