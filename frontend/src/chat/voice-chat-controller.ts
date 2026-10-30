import type { VoiceChatEvent, VoiceChatState } from '../../../contracts/voice-chat';
import { PetRealtimeClient, type RealtimeVoiceOptions, type RealtimeVoiceTransport } from '../pets/realtime-client';

export interface VoiceChatTransport extends RealtimeVoiceTransport {
  state(sessionId?: string): Promise<VoiceChatState>;
  onEvent(callback: (event: VoiceChatEvent) => void): () => void;
  reserve?(requestId: string, sessionId?: string): Promise<void>;
}
export interface VoiceChatSnapshot {
  open: boolean;
  phase: 'inactive' | 'connecting' | 'active' | 'stopping' | 'error';
  state: VoiceChatState | null;
  error: unknown;
  notifyError: boolean;
  microphoneLevel: number;
  outputLevel: number;
  outputBands: number[];
  targetSessionId?: string;
}
export interface VoiceChatDependencies {
  transport: VoiceChatTransport;
  ensureSession(): Promise<string | null>;
  currentSession(): string | null;
  beforeStart?(): Promise<void>;
  client?: Partial<Pick<RealtimeVoiceOptions, 'media' | 'peer' | 'audio' | 'id' | 'devices' | 'timeoutMs'>>;
}

/** Pins a call to one conversation while text navigation remains independent. */
export class VoiceChatController {
  private value: VoiceChatSnapshot = { open: false, phase: 'inactive', state: null, error: null, notifyError: false, microphoneLevel: 0, outputLevel: 0, outputBands: [0, 0, 0, 0] };
  private readonly listeners = new Set<() => void>();
  private readonly client: PetRealtimeClient;
  private readonly unsubscribe: () => void;
  private revision = 0;
  private disposed = false;
  private preflightRevision = 0;
  private ending?: Promise<void>;
  private wasActive = false;
  constructor(private readonly deps: VoiceChatDependencies) {
    this.client = new PetRealtimeClient({
      ...deps.client,
      resumeOnStopFailure: true,
      transport: { state: () => deps.transport.state(this.value.targetSessionId ?? deps.currentSession() ?? undefined), negotiate: value => deps.transport.negotiate(value), end: value => deps.transport.end(value), control: value => deps.transport.control(value), appendAudio: value => deps.transport.appendAudio ? deps.transport.appendAudio(value) : Promise.reject(new Error('The voice transport cannot carry engine audio')) },
      prepare: (requestId, sessionId) => deps.transport.reserve?.(requestId, sessionId) ?? Promise.resolve(),
      state: state => {
        if (state.phase === 'active') this.wasActive = true;
        const disconnected = this.wasActive && state.phase === 'inactive' && !!state.error;
        const phase = this.value.open ? state.error && state.phase === 'inactive' ? 'error' : state.phase === 'inactive' && this.value.phase === 'connecting' ? 'connecting' : state.phase : 'inactive';
        this.patch({ state, phase: disconnected ? 'inactive' : phase, error: state.error ?? null, ...(disconnected ? { open: false, notifyError: true } : {}), ...(state.phase === 'inactive' && this.value.phase === 'active' && !state.error ? { open: false, targetSessionId: undefined } : {}) });
      },
      error: error => {
        const phase = this.client.snapshot().phase;
        this.patch({ error, notifyError: this.wasActive || phase === 'stopping', phase: phase === 'active' ? 'active' : phase === 'stopping' ? 'stopping' : this.wasActive ? 'inactive' : 'error', ...(this.wasActive && phase === 'inactive' ? { open: false } : {}) });
      },
      level: microphoneLevel => this.patch({ microphoneLevel }),
      outputLevel: outputLevel => this.patch({ outputLevel }),
      outputBands: outputBands => this.patch({ outputBands }),
    });
    this.unsubscribe = deps.transport.onEvent(event => {
      if (event.type === 'state' && (event.state.transport === 'webrtc' || event.state.transport === 'websocket')) this.client.applyState(event.state);
      else if (event.type === 'audio') this.client.audio(event);
    });
  }
  snapshot = (): VoiceChatSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private patch(patch: Partial<VoiceChatSnapshot>): void {
    if (this.disposed) return;
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  async refresh(): Promise<void> {
    const configurationError = this.value.phase === 'error' && /realtime-source-not-configured/.test(this.value.error instanceof Error ? this.value.error.message : String(this.value.error ?? ''));
    if (this.value.open && !configurationError || this.disposed) return;
    const revision = ++this.preflightRevision, sessionId = this.deps.currentSession();
    try {
      const state = await this.deps.transport.state(sessionId ?? undefined);
      if (!this.disposed && revision === this.preflightRevision && sessionId === this.deps.currentSession()) {
        if (!this.value.open) this.patch({ state, error: null });
        else if (configurationError && this.value.phase === 'error' && state.available) this.patch({ state, open: false, phase: 'inactive', error: null, targetSessionId: undefined });
      }
    } catch (error) {
      if (!this.disposed && !this.value.open && revision === this.preflightRevision) this.patch({ state: null, error });
    }
  }
  async start(targetSessionId?: string): Promise<void> {
    if (this.disposed || this.value.open && this.value.phase !== 'error' && this.value.phase !== 'inactive') return;
    const revision = ++this.revision;
    this.wasActive = false;
    this.preflightRevision++;
    this.patch({ open: true, phase: 'connecting', error: null, notifyError: false, targetSessionId: targetSessionId ?? this.deps.currentSession() ?? undefined });
    try {
      await this.deps.beforeStart?.();
      if (revision !== this.revision || this.disposed) return;
      const capability = await this.deps.transport.state(this.value.targetSessionId ?? undefined);
      if (revision !== this.revision || this.disposed) return;
      if (!capability.available || capability.transport !== 'webrtc' && capability.transport !== 'websocket') throw new Error(capability.unavailableReason || 'The selected source does not support realtime voice');
      const sessionId = this.value.targetSessionId ?? await this.deps.ensureSession();
      if (revision !== this.revision || this.disposed) return;
      if (!sessionId) throw new Error('The voice conversation could not be created');
      this.patch({ targetSessionId: sessionId });
      await this.client.start(sessionId, capability);
    } catch (error) {
      if (revision === this.revision) this.patch({ error, phase: this.client.snapshot().phase === 'stopping' ? 'stopping' : 'error' });
    }
  }
  stop(): Promise<void> {
    if (this.ending) return this.ending;
    ++this.revision;
    this.patch({ phase: 'stopping', error: null });
    const ending = this.client.stop().then(() => {
      this.patch({ open: false, phase: 'inactive', targetSessionId: undefined, error: null, microphoneLevel: 0, outputLevel: 0 });
    }).catch(error => { this.patch({ error: new Error(`Unable to stop voice chat: ${error instanceof Error ? error.message : String(error)}`), phase: this.client.snapshot().phase === 'active' ? 'active' : 'stopping', notifyError: true }); }).finally(() => { if (this.ending === ending) this.ending = undefined; });
    this.ending = ending;
    return ending;
  }
  async stopForSession(sessionId: string): Promise<void> {
    if (!this.value.open || this.value.targetSessionId !== sessionId) return;
    await this.stop();
    if (this.value.open) throw this.value.error ?? new Error('The voice conversation could not be stopped');
  }
  async microphone(): Promise<void> {
    try { await this.client.microphone(!this.value.state?.microphoneMuted); this.patch({ error: null }); }
    catch (error) { this.patch({ error }); }
  }
  async speaker(): Promise<void> {
    try { await this.client.speaker(!this.value.state?.speakerMuted); this.patch({ error: null }); }
    catch (error) { this.patch({ error }); }
  }
  async interrupt(): Promise<void> {
    try { await this.client.interrupt(); }
    catch (error) { this.patch({ error }); }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; ++this.revision; this.unsubscribe(); this.listeners.clear();
    await this.client.dispose();
  }
}
