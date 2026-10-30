import type { AppServerClient } from '../../engine/client';
import type { ClientEvent } from '../../engine/protocol';
import { object, text, type Row } from './store';
import type { VoiceRefinement } from './network';

export interface SpeechBackend {
  ready: Promise<void>;
  done: Promise<void>;
  audio(data: Uint8Array, seq?: number): Promise<void>;
  stop(): Promise<void>;
  close(): void;
}
export type SpeechClient = Pick<AppServerClient, 'requestWithTimeout' | 'isClosed'> & {
  on(event: 'event', listener: (event: ClientEvent) => void): unknown;
  off(event: 'event', listener: (event: ClientEvent) => void): unknown;
};
export interface StreamingSpeechOptions {
  operationId: string;
  source: string;
  language?: string;
  refinement?: VoiceRefinement;
  client: SpeechClient;
  current(): void;
  onEvent(event: Row): Promise<void>;
  onFailure(code: string): Promise<void>;
  errorCode(error: unknown): string;
}

/** Keep credentials in the engine and expose only owner-scoped PCM and text. */
export class EngineSpeech implements SpeechBackend {
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
  credentialGeneration?: string;
  private resolveDone!: () => void;
  private closing = false;
  private terminal = false;
  private failed = false;
  private ended = false;
  private nextAudio = 1;
  private nextEvent = 1;
  private events = Promise.resolve();
  private readonly listener = (event: ClientEvent): void => {
    if (this.closing) return;
    if (event.type === 'streamClosed') { this.fail('voice-engine-changed'); return; }
    if (event.type !== 'productEvent' || event.method !== 'engine/dictationEvent') return;
    const payload = object(event.params);
    if (payload.operationId !== this.options.operationId) return;
    if (!Number.isSafeInteger(payload.seq) || Number(payload.seq) < this.nextEvent) return;
    if (payload.seq !== this.nextEvent++) { this.fail('speech-event-sequence'); return; }
    if (this.terminal) return;
    if (!['partial', 'recognized', 'final', 'error'].includes(text(payload.type))) { this.fail('speech-protocol-error'); return; }
    if (payload.type === 'final' || payload.type === 'error') this.terminal = true;
    this.events = this.events.then(async () => {
      if (this.closing) return;
      this.options.current();
      await this.options.onEvent(payload);
    }).catch(error => { this.fail(this.options.errorCode(error)); });
  };
  constructor(private readonly options: StreamingSpeechOptions) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    options.client.on('event', this.listener);
    this.ready = Promise.resolve().then(async () => {
      options.current();
      const result = object(await options.client.requestWithTimeout('engine/dictationStart', { operationId: options.operationId, source: options.source, ...(options.language ? { language: options.language } : {}), ...(options.refinement ? { refinement: options.refinement } : {}) }, 40_000));
      this.credentialGeneration = text(result.credentialGeneration) || undefined;
      options.current();
      if (this.closing) throw new Error('voice-cancelled');
    });
    void this.ready.catch(error => this.fail(options.errorCode(error)));
  }
  private fail(code: string): void {
    if (this.closing || this.failed) return;
    this.failed = true; this.terminal = true;
    void this.options.onFailure(code).catch(() => {}).finally(() => this.close());
  }
  async audio(data: Uint8Array, seq?: number): Promise<void> {
    this.options.current();
    if (this.closing || this.ended || this.terminal) throw new Error('speech-session-closed');
    if (seq !== undefined && seq !== this.nextAudio || !data.length || data.length > 32768 || data.length % 2) throw new Error('speech-audio-sequence');
    const sequence = this.nextAudio++;
    await this.options.client.requestWithTimeout('engine/dictationAppendAudio', { operationId: this.options.operationId, seq: sequence, audioBase64: Buffer.from(data).toString('base64') }, 6000);
    this.options.current();
  }
  async stop(): Promise<void> {
    if (this.ended || this.closing) return;
    this.ended = true;
    this.options.current();
    await this.options.client.requestWithTimeout('engine/dictationEnd', { operationId: this.options.operationId }, 6000);
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.options.client.off('event', this.listener);
    void (async () => {
      // An incomplete drain keeps admission occupied. Only acknowledged closure
      // or a dead engine generation may release the native transport lease.
      while (!this.options.client.isClosed()) {
        try {
          const result = object(await this.options.client.requestWithTimeout('engine/dictationEnd', { operationId: this.options.operationId, cancel: true }, 6000));
          if (result.complete === true) break;
        } catch (error) {
          if (object(error).code === -32601) break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })().finally(() => this.resolveDone());
  }
}
