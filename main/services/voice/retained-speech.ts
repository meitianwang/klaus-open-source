import { pcm16Wav } from '../../../shared/voice-audio';
import { VOICE_AUDIO_MAX_MS } from '../../../shared/voice-input';
import type { SpeechBackend } from './engine-speech';
import { text, type Row } from './store';

interface RetainedSpeechOptions {
  signal: AbortSignal;
  primary(onEvent: (event: Row) => Promise<void>, onFailure: (code: string) => Promise<void>): SpeechBackend;
  fallback(audio: ArrayBuffer): Promise<string>;
  onEvent(event: Row): Promise<void>;
  onFailure(code: string): Promise<void>;
  errorCode(error: unknown): string;
}
function recoverable(code: string): boolean {
  if (/auth|credential|permission|billing|rate_limit|operation_limit|source-changed|engine-changed|cancelled|sequence|invalid|overflow|no_speech|refused|too_large|refinement_timed_out/.test(code)) return false;
  return /transport|network|timeout|timed_out|connection_failed|incomplete|voice-provider-failed|speech-helper-exited|speech-session-closed/.test(code);
}

/** Retain complete PCM independently of the live transport for same-source recovery. */
export class RetainedSpeech implements SpeechBackend {
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private readonly primary: SpeechBackend;
  private frames: ArrayBuffer[] = [];
  private bytes = 0;
  private nextSequence = 1;
  private degraded = false;
  private terminal = false;
  private recognized = false;
  private closed = false;
  private ended = false;
  private fallbackTask?: Promise<void>;
  constructor(private readonly options: RetainedSpeechOptions) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.primary = options.primary(event => this.event(event), code => this.failure(code));
    this.ready = this.primary.ready.catch(async error => {
      await this.failure(options.errorCode(error));
      if (!this.degraded) throw error;
    });
    void this.ready.catch(() => {});
  }
  private async event(event: Row): Promise<void> {
    if (this.closed || this.terminal || this.options.signal.aborted) return;
    if (event.type === 'error') { await this.failure(text(event.code) || 'voice-provider-failed'); return; }
    if (event.type === 'recognized') this.recognized = true;
    if (event.type === 'final') this.terminal = true;
    await this.options.onEvent(event);
  }
  private async failure(code: string): Promise<void> {
    if (this.closed || this.terminal || this.options.signal.aborted) return;
    if (this.recognized || !recoverable(code)) { this.terminal = true; try { await this.options.onFailure(code); } finally { this.close(); } return; }
    if (this.degraded) return;
    this.degraded = true; this.primary.close();
    await this.options.onEvent({ type: 'status', code: 'speech-recovering' });
    if (this.ended) void this.recover().catch(() => {});
  }
  async audio(data: Uint8Array, seq?: number): Promise<void> {
    this.options.signal.throwIfAborted();
    if (this.closed || this.terminal || this.ended) throw new Error('speech-session-closed');
    if (seq !== undefined && seq !== this.nextSequence || data.length % 2 || !data.length) throw new Error('speech-audio-sequence');
    if (this.bytes + data.byteLength > VOICE_AUDIO_MAX_MS * 32) throw new Error('audio-too-large');
    this.nextSequence++; this.bytes += data.byteLength;
    this.frames.push(Uint8Array.from(data).buffer);
    if (this.degraded) return;
    try { await this.primary.audio(data, seq); }
    catch (error) { const code = this.options.errorCode(error); await this.failure(code); if (!this.degraded) throw error; }
  }
  async stop(): Promise<void> {
    if (this.closed || this.ended) return;
    this.ended = true;
    if (!this.frames.length) {
      this.terminal = true;
      try { await this.options.onFailure('empty-transcript'); } finally { this.close(); }
      return;
    }
    if (this.degraded) { void this.recover().catch(() => {}); return; }
    try { await this.primary.stop(); }
    catch (error) { await this.failure(this.options.errorCode(error)); if (!this.degraded) throw error; }
  }
  private recover(): Promise<void> {
    this.fallbackTask ??= (async () => {
      try {
        await this.primary.done;
        this.options.signal.throwIfAborted();
        if (this.closed) return;
        const audio = pcm16Wav(this.frames);
        const result = await this.options.fallback(audio);
        this.options.signal.throwIfAborted();
        if (this.closed || this.terminal) return;
        this.terminal = true;
        await this.options.onEvent({ type: 'final', text: result, recovered: true });
      } catch (error) {
        if (!this.closed && !this.options.signal.aborted) { this.terminal = true; await this.options.onFailure(this.options.errorCode(error)); }
      } finally { this.close(); }
    })();
    return this.fallbackTask;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.frames = []; this.primary.close();
    void Promise.allSettled([this.primary.done, this.fallbackTask]).then(() => { this.resolveDone(); });
  }
}
