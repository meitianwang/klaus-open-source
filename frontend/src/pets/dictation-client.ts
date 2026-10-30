import type { VoicePcmCapture } from '../chat/voice-capture';
import { VoiceSessionCapture } from '../chat/voice-session-capture';
import { DictationPipeline, type PipelineOptions } from '../chat/voice-pipeline';
import { VOICE_AUDIO_MAX_MS, isVoiceInputSource, type VoiceInputSource } from '../../../shared/voice-input';

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'cancelling';
export interface DictationReply { ok?: boolean; text?: string; rawText?: string; error?: string; sessionId?: string; complete?: boolean }
export interface DictationEvent { sessionId?: string; seq?: number; type?: string; text?: string; rawText?: string; code?: string }
export interface DictationTransport {
  voiceConfig(operationId?: string): Promise<{ ok?: boolean; source?: string; sourceAvailable?: boolean; systemAsr?: boolean; streaming?: boolean } | null>;
  micPermission(operationId?: string): Promise<DictationReply | null>;
  transcribe(data: ArrayBuffer, mimeType: string, operationId: string, options: { source: VoiceInputSource; context?: string; durationMs?: number; partial?: boolean; segmentIds?: string[] }): Promise<DictationReply | null>;
  sessionStart(options: { operationId: string; context: string; source?: string }): Promise<DictationReply | null>;
  sessionAudio(sessionId: string, data: ArrayBuffer, seq: number): Promise<DictationReply | null>;
  sessionStop(sessionId: string): Promise<DictationReply | null>;
  sessionCancel(sessionId: string): Promise<DictationReply | null>;
  onSessionEvent(callback: (event: DictationEvent) => void): (() => void);
}
type PcmCapture = Pick<VoicePcmCapture, 'start' | 'stop' | 'close'>;
export type PipelineHandle = Pick<DictationPipeline, 'start' | 'stop' | 'cancel'>;
export interface DictationOptions {
  transport: DictationTransport;
  text(value: string): void;
  error(value: Error): void;
  state?(phase: DictationPhase): void;
  /** Live segment transcript while a cloud recording runs; display only. */
  partial?(value: string): void;
  context?(): string;
  media?(): Promise<MediaStream>;
  pcm?(stream: MediaStream, send: (data: ArrayBuffer, seq: number) => Promise<void>, failed: (error: Error) => void): PcmCapture;
  /** Test seam over the streaming pipeline; production uses the shared one. */
  pipeline?(options: PipelineOptions): PipelineHandle;
  id?(): string;
  maxDurationMs?: number;
}
interface Capture {
  id: string;
  source: VoiceInputSource;
  streaming?: boolean;
  context: string;
  startedAt: number;
  sequence: number;
  bytes: number;
  stream?: MediaStream;
  pcm?: PcmCapture;
  pipeline?: PipelineHandle;
  timer?: ReturnType<typeof setTimeout>;
}
function failureCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError') return 'mic-denied';
  const code = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(code) ? code : fallback;
}

/** Records into an editable draft using the saved speech input source. */
export class PetDictationClient {
  private capture?: Capture;
  private phase: DictationPhase = 'idle';
  private disposed = false;
  private closing?: Promise<void>;
  private readonly unsubscribe: () => void;
  constructor(private readonly options: DictationOptions) {
    this.unsubscribe = options.transport.onSessionEvent(event => this.event(event));
  }
  snapshot(): DictationPhase { return this.phase; }
  private setPhase(phase: DictationPhase): void { this.phase = phase; if (!this.disposed) this.options.state?.(phase); }
  private owns(value: Capture): boolean { return !this.disposed && this.capture === value; }
  private clearTimer(value: Capture): void { clearTimeout(value.timer); value.timer = undefined; }
  private releaseStream(value: Capture): void { value.stream?.getTracks().forEach(track => track.stop()); value.stream = undefined; }
  private async release(value: Capture): Promise<void> {
    this.clearTimer(value); this.releaseStream(value);
    const pipeline = value.pipeline; value.pipeline = undefined;
    if (pipeline) await pipeline.cancel();
    const pcm = value.pcm; value.pcm = undefined;
    await pcm?.close();
  }
  private fail(value: Capture, code: string): void {
    if (!this.owns(value)) return;
    this.options.error(new Error(code));
    void this.cancel(false);
  }
  private complete(value: Capture, text?: string): void {
    if (!this.owns(value)) return;
    this.capture = undefined; this.clearTimer(value); this.setPhase('transcribing');
    const task = this.release(value).catch(() => {}).finally(() => {
      if (this.closing === task) { this.closing = undefined; this.setPhase('idle'); }
    });
    this.closing = task;
    const result = text?.trim();
    if (result) this.options.text(result);
    else this.options.error(new Error('empty-transcript'));
  }
  async start(): Promise<void> {
    if (this.disposed || this.phase !== 'idle') return;
    const value: Capture = { id: this.options.id?.() ?? crypto.randomUUID(), source: 'custom', context: this.options.context?.().slice(-4000) ?? '', startedAt: 0, sequence: 0, bytes: 0 };
    this.capture = value; this.setPhase('starting');
    try {
      const config = await this.options.transport.voiceConfig(value.id);
      if (!this.owns(value)) return;
      if (!config || config.ok === false || !isVoiceInputSource(config.source) || config.sourceAvailable === false) throw new Error('voice-source-unavailable');
      value.source = config.source;
      value.streaming = config.source === 'system' || config.streaming === true;
      const permission = await this.options.transport.micPermission(value.id);
      if (!this.owns(value)) return;
      if (!permission?.ok) throw new Error(permission?.error || 'mic-denied');
      const stream = await (this.options.media?.() ?? navigator.mediaDevices.getUserMedia({ audio: true }));
      if (!this.owns(value)) { stream.getTracks().forEach(track => track.stop()); return; }
      value.stream = stream;
      if (value.streaming) {
        value.pcm = new VoiceSessionCapture(stream, { transport: this.options.transport, operationId: value.id, source: value.source, context: value.context,
          pcm: this.options.pcm, ready: id => { if (this.owns(value)) value.id = id; }, failed: error => this.fail(value, failureCode(error, 'speech-audio-failed')) });
        await value.pcm.start();
        if (!this.owns(value)) return;
      } else {
        // Cloud sources stream through the shared pipeline: acknowledged worklet
        // frames, live segment previews, and complete recovery of every interval
        // when the authoritative full-audio request fails.
        const create = this.options.pipeline ?? ((options: PipelineOptions) => new DictationPipeline(options));
        const pipeline = create({
          transport: {
            transcribe: (data, mimeType, operationId, options) => this.options.transport.transcribe(data, mimeType, operationId, options),
            cancel: operationId => this.options.transport.sessionCancel(operationId),
          },
          source: value.source,
          operationId: value.id,
          context: value.context,
          capture: this.options.pcm,
          hooks: {
            partial: text => { if (this.owns(value)) this.options.partial?.(text); },
            final: result => { if (this.owns(value)) this.complete(value, result.text); },
            empty: () => { if (this.owns(value)) this.complete(value); },
            error: code => this.fail(value, code),
          },
        });
        value.pipeline = pipeline;
        await pipeline.start(stream);
        if (!this.owns(value)) { await pipeline.cancel(); return; }
      }
      value.startedAt = Date.now(); this.setPhase('recording');
      value.timer = setTimeout(() => { void this.stop(); }, Math.min(this.options.maxDurationMs ?? VOICE_AUDIO_MAX_MS, VOICE_AUDIO_MAX_MS));
    } catch (error) { this.fail(value, failureCode(error, 'voice-start-failed')); }
  }
  async stop(): Promise<void> {
    const value = this.capture;
    if (!value || this.phase !== 'recording') return;
    this.clearTimer(value); this.setPhase('transcribing');
    try {
      if (value.streaming) {
        await value.pcm?.stop();
        if (this.owns(value)) this.releaseStream(value);
      } else await value.pipeline?.stop();
    } catch (error) { this.fail(value, failureCode(error, 'voice-stop-failed')); }
  }
  private event(event: DictationEvent): void {
    const value = this.capture;
    if (!value || !this.owns(value) || !value.streaming || event.sessionId !== value.id) return;
    if (event.seq !== undefined) {
      if (event.seq <= value.sequence) return;
      if (event.seq !== value.sequence + 1) { this.fail(value, 'speech-event-sequence'); return; }
      value.sequence = event.seq;
    }
    if (event.type === 'partial') this.options.partial?.(event.text || '');
    if (event.type === 'error') this.fail(value, failureCode(event.code, 'speech-failed'));
    else if (event.type === 'final') this.complete(value, event.text);
  }
  cancel(reportError = true): Promise<void> {
    if (this.closing) return this.closing;
    const value = this.capture;
    if (!value) return Promise.resolve();
    this.capture = undefined; this.setPhase('cancelling');
    const task = Promise.allSettled([this.release(value), this.options.transport.sessionCancel(value.id)]).then(results => {
      if (reportError && !this.disposed && (results.some(row => row.status === 'rejected') || results[1].status === 'fulfilled' && results[1].value?.complete === false)) this.options.error(new Error('voice-cancel-incomplete'));
    }).finally(() => { if (this.closing === task) { this.closing = undefined; this.setPhase('idle'); } });
    this.closing = task; return task;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe(); await this.cancel(false);
  }
}
