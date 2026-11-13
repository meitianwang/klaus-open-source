import { VOICE_AUDIO_MAX_BYTES, VOICE_AUDIO_MAX_MS, VOICE_INPUT_SOURCE_KEY, VOICE_INPUT_SOURCES, VOICE_NATIVE_STREAMING_SOURCES, isVoiceInputSource, voiceInputSource, voiceAudioMaxBytes, voiceTranscriptionTimeoutMs } from '../../../shared/voice-input';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Json } from '../../ipc/contract';
import { decodeBinary } from '../../ipc/binary';
import { IpcHandlerError } from '../../ipc/registry';
import { SpeechHelper, type SpeechCommand } from './helper';
import type { SpeechBackend } from './engine-speech';
import { alive, learn, polish, recordingRefinement, transcribe, type VoiceModels } from './network';
import { object, text, truncate, VoiceStore, type Row } from './store';
import { RefinementRace, refinementBackupDelay } from './refinement-race';

export interface VoiceOptions extends VoiceModels {
  configRoot: string;
  helperPath?: string;
  platform?: NodeJS.Platform;
  micPermission(ownerId: number, signal: AbortSignal): Promise<Row>;
  /** One bounded, acknowledged delivery to the attached trusted renderer. */
  deliver(ownerId: number, channel: 'voice:session:event', payload: Json): Promise<void>;
  /** Main-process test seam, never exposed through settings, env or renderer IPC. */
  speechCommand?: SpeechCommand;
  helperReadyTimeoutMs?: number;
  realtimeReserved?(): boolean;
  /** Timing metadata only; never includes audio, transcripts or credentials. */
  diagnostic?(event: Row): void;
}
interface Task { owner: Owner; kind: 'permission' | 'foreground' | 'learning' | 'configuration' | 'partial'; id: string; abort: AbortController; done: Promise<unknown> }
/** Rolling segment probes are small; they get a much shorter deadline than the full-audio pass and never hold one up. */
const PARTIAL_TRANSCRIBE_TIMEOUT_MS = 20_000;
interface SegmentReceipt { text: string; source: string; preference: string; durationMs: number }
interface Owner { id: number; generation: number; attached: boolean; tasks: Set<Task>; session?: Recognition; segments: Map<string, SegmentReceipt> }
interface Recognition { chatSessionId?: string; sourcePreference: string; source: string; realtime: boolean; recovering?: boolean; audioBytes: number; id: string; owner: Owner; helper: SpeechBackend; abort: AbortController; seq: number; final: boolean; started: number; timer: NodeJS.Timeout; stopTimer?: NodeJS.Timeout; stopRequestedAt?: number; refinement?: RefinementRace; done: Promise<void>; events: Promise<void>; calls: Set<Promise<unknown>>; failure?: Promise<void>; stop?: Promise<Row> }
function failure(error: unknown): Row { return { ok: false, error: error instanceof Error ? error.message : 'voice-failed' }; }
function audioBytes(value: Json | undefined, maximum: number): Uint8Array | undefined {
  const raw = typeof value === 'string' ? value : object(value).__klausBinary;
  if (typeof raw === 'string' && raw.length > Math.ceil(maximum / 3) * 4 || Array.isArray(value) && value.length > maximum) return undefined;
  const bytes = decodeBinary(value); return bytes && bytes.length <= maximum ? bytes : undefined;
}
function operationId(payload: Row): string {
  if (payload.operationId === undefined) return randomUUID();
  const id = text(payload.operationId);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('voice-operation-id-invalid');
  return id;
}
function chatSession(payload: Row): string | undefined {
  if (payload.chatSessionId === undefined || payload.chatSessionId === '') return undefined;
  const id = text(payload.chatSessionId);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('voice-context-invalid');
  return id;
}
async function deadline(promises: Promise<unknown>[], milliseconds: number): Promise<{ complete: boolean }> {
  if (!promises.length) return { complete: true };
  let timer: NodeJS.Timeout | undefined;
  try {
    const complete = await Promise.race([Promise.allSettled(promises).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, Math.min(60_000, milliseconds))); })]);
    return { complete };
  } finally { if (timer) clearTimeout(timer); }
}

/** Owns all voice business work and prevents old renderer generations from writing. */
export class VoiceService {
  readonly store: VoiceStore;
  private readonly owners = new Map<number, Owner>();
  private generation = 0;
  private closing = false;
  private readonly tasks = new Set<Task>();
  private readonly sessions = new Set<Recognition>();
  private readonly command: SpeechCommand | undefined;

  constructor(private readonly options: VoiceOptions) {
    this.store = new VoiceStore(options.configRoot); this.store.prune();
    const platform = options.platform ?? process.platform;
    if (options.speechCommand) this.command = options.speechCommand;
    else if (platform === 'darwin' && options.helperPath) {
      try { if (statSync(options.helperPath).isFile()) this.command = { executable: options.helperPath }; } catch { /* Missing capability is shown explicitly. */ }
    }
  }
  attachOwner(id: number): void {
    if (this.closing || !Number.isSafeInteger(id) || id < 1) throw new Error('voice-owner-invalid');
    const previous = this.owners.get(id);
    if (previous?.attached) return;
    if (previous?.tasks.size || [...this.sessions].some(session => session.owner === previous)) throw new Error('voice-owner-still-closing');
    if (this.owners.size >= 64 && !previous) throw new Error('voice-owner-limit');
    this.owners.set(id, { id, generation: ++this.generation, attached: true, tasks: new Set(), segments: new Map() });
  }
  busy(): boolean { return this.sessions.size > 0 || [...this.tasks].some(task => task.kind === 'foreground'); }
  private owner(id: number): Owner {
    const owner = this.owners.get(id);
    if (this.closing || !owner?.attached) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Voice caller is not attached');
    return owner;
  }
  private active(owner: Owner, signal: AbortSignal): void { alive(signal); if (!owner.attached || this.closing || this.owners.get(owner.id) !== owner) throw new Error('voice-owner-closed'); }
  private track<T>(owner: Owner, kind: Task['kind'], id: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.tasks.size >= 12 || [...owner.tasks].some(task => task.id === id)) throw new Error('voice-operation-limit');
    if (kind === 'foreground' && (this.busy() || this.options.realtimeReserved?.())) throw new Error('voice-busy');
    if (kind === 'partial') {
      // Rolling segment probes: one per owner, never gating the full-audio pass,
      // and evicted the moment a foreground transcription is admitted.
      if (this.options.realtimeReserved?.()) throw new Error('voice-busy');
      if ([...owner.tasks].some(task => task.kind === 'partial')) throw new Error('voice-partial-busy');
    }
    if (kind === 'learning' && [...owner.tasks].filter(task => task.kind === kind).length >= 2) throw new Error('voice-learning-busy');
    if (kind === 'foreground') for (const task of [...owner.tasks]) if (task.kind === 'partial') task.abort.abort(new Error('voice-cancelled'));
    const task: Task = { owner, kind, id, abort: new AbortController(), done: Promise.resolve() };
    const done = Promise.resolve().then(() => { this.active(owner, task.abort.signal); return run(task.abort.signal); })
      .finally(() => { this.tasks.delete(task); owner.tasks.delete(task); this.forget(owner); });
    task.done = done; this.tasks.add(task); owner.tasks.add(task); void done.catch(() => {}); return done;
  }
  private forget(owner: Owner): void {
    if (!owner.attached && !owner.tasks.size && ![...this.sessions].some(value => value.owner === owner) && this.owners.get(owner.id) === owner) this.owners.delete(owner.id);
  }
  private preference(): string { return JSON.stringify([this.store.setting(VOICE_INPUT_SOURCE_KEY), this.store.setting('voice.input.experience')]); }
  async config(id: number, payload: Row = {}): Promise<Row> {
    const owner = this.owner(id);
    if (payload.includeAvailability !== undefined && typeof payload.includeAvailability !== 'boolean') return { ok: false, error: 'voice-config-invalid' };
    try {
      return await this.track(owner, 'configuration', operationId(payload), async signal => {
        const saved = this.store.setting(VOICE_INPUT_SOURCE_KEY), preference = this.preference();
        const experience = this.store.setting('voice.input.experience') || (this.options.streaming ? 'realtime' : 'compatibility');
        const realtime = experience === 'realtime' && !!this.options.streaming;
        const selected = voiceInputSource(saved, !!this.command);
        const native: Record<string, boolean> = {};
        if (realtime) await Promise.all(VOICE_NATIVE_STREAMING_SOURCES.filter(source => source === selected || payload.includeAvailability === true).map(async source => {
          native[source] = false;
          try { native[source] = await this.options.streaming!.available(source, signal); }
          catch { this.active(owner, signal); }
        }));
        const nativeStreaming = !!selected && native[selected] === true;
        const gated: Record<string, boolean> = {};
        for (const source of ['workbuddy', 'antigravity', 'trae'] as const) {
          if (selected !== source && payload.includeAvailability !== true) continue;
          gated[source] = false;
          try { gated[source] = await this.options.transcriptionAvailable?.(source, signal) === true; }
          catch { this.active(owner, signal); }
        }
        this.active(owner, signal);
        if (this.preference() !== preference) throw new Error('voice-source-changed');
        // Keep source choices visible independently of the preferred transport.
        // Realtime admission requires its native route; a failed readiness check
        // must never silently start a file-segment transcription session.
        const availability = Object.fromEntries(VOICE_INPUT_SOURCES.flatMap<[string, boolean]>(source => {
          if (source === 'system') return [[source, !!this.command]];
          if (source === 'custom') return [[source, true]];
          if (Object.hasOwn(gated, source)) return [[source, gated[source] === true || native[source] === true]];
          return [[source, !!this.options.transcribeAudio]];
        }));
        const sourceAvailable = !!selected && (experience === 'realtime'
          ? selected === 'system' ? !!this.command : nativeStreaming
          : availability[selected] === true);
        return { source: (saved || selected) || '', sourceAvailable, availability,
          experience, streaming: selected === 'system' && !!this.command || nativeStreaming, nativeStreaming,
          systemAsr: !!this.command, polishEnabled: true,
          learningEnabled: this.store.enabled('voice.learning.enabled'), locale: '' };
      });
    } catch (error) { return failure(error); }
  }

  async microphone(id: number, payload: Row = {}): Promise<Row> {
    const owner = this.owner(id);
    try { return await this.track(owner, 'permission', operationId(payload), async signal => {
      const result = await this.options.micPermission(id, signal); this.active(owner, signal); return result;
    }); } catch (error) { return failure(error); }
  }
  async start(id: number, payload: Row): Promise<Row> {
    const owner = this.owner(id), preference = this.preference();
    let source = 'system', realtime = false;
    if (this.options.streaming) {
      const config = await this.config(id, { operationId: `${operationId(payload)}-source` });
      if (this.preference() !== preference) return { ok: false, error: 'voice-source-changed' };
      if (config.sourceAvailable !== true || config.streaming !== true) return { ok: false, error: 'voice-source-unavailable' };
      source = text(config.source); realtime = config.experience === 'realtime';
      if (payload.source !== undefined && payload.source !== source) return { ok: false, error: 'voice-source-changed' };
    } else {
      if (this.store.setting(VOICE_INPUT_SOURCE_KEY) && this.store.setting(VOICE_INPUT_SOURCE_KEY) !== 'system') return { ok: false, error: 'voice-source-changed' };
      if (!this.command) return { ok: false, error: 'system-asr-unavailable' };
    }
    if (this.busy() || this.options.realtimeReserved?.()) return { ok: false, error: 'voice-busy' };
    let session: Recognition | undefined;
    try {
      const sid = operationId(payload), abort = new AbortController();
      const locale = truncate(text(payload.locale), 64);
      if (locale && !/^[a-zA-Z0-9_-]+$/.test(locale)) return { ok: false, error: 'voice-locale-invalid' };
      const context = truncate(text(payload.context), 4000), chatSessionId = chatSession(payload);
      let recognition!: Recognition;
      const onEvent = (event: Row) => this.queueEvent(recognition, event, context);
      const onFailure = (code: string) => this.queueEvent(recognition, { type: 'error', code }, context);
      const helper: SpeechBackend = source !== 'system'
        ? this.options.streaming!.create(sid, source, abort.signal, onEvent, onFailure,
          ['qoder', 'qwenwork'].includes(source) ? { refinement: recordingRefinement(this.store, context) } : undefined)
        : new SpeechHelper({ command: this.command!, locale, hotwords: this.store.hotwords().filter(row => row.enabled).map(row => row.text),
          readyTimeoutMs: this.options.helperReadyTimeoutMs, onEvent, onFailure });
      recognition = { chatSessionId, sourcePreference: preference, source, realtime, audioBytes: 0, id: sid, owner, helper, abort, seq: 0, final: false, started: Date.now(),
        timer: setTimeout(() => { void this.fail(recognition, 'speech-session-timeout'); }, 5 * 60_000), done: Promise.resolve(), events: Promise.resolve(), calls: new Set() };
      session = recognition; owner.session = recognition; this.sessions.add(recognition);
      recognition.done = helper.done.finally(async () => {
        while (recognition.calls.size) await Promise.allSettled([...recognition.calls]);
        await recognition.refinement?.done;
        await recognition.events.catch(() => {});
        clearTimeout(recognition.timer); if (recognition.stopTimer) clearTimeout(recognition.stopTimer);
        this.sessions.delete(recognition); if (owner.session === recognition) owner.session = undefined; this.forget(owner);
      });
      void recognition.done.catch(() => {});
      await helper.ready; this.active(owner, abort.signal);
      if (this.preference() !== preference) throw new Error('voice-source-changed');
      recognition.started = Date.now(); clearTimeout(recognition.timer);
      recognition.timer = setTimeout(() => { void this.fail(recognition, 'speech-session-timeout'); }, VOICE_AUDIO_MAX_MS);
      return { ok: true, sessionId: sid, operationId: sid, generation: owner.generation, seq: 0 };
    } catch (error) { if (session) this.cancelSession(session); return failure(error); }
  }
  private queueEvent(session: Recognition, event: Row, context: string): Promise<void> {
    const task = session.events.catch(() => {}).then(() => this.event(session, event, context));
    session.events = task; return task;
  }
  private sessionCall<T>(session: Recognition, run: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(run).finally(() => session.calls.delete(task));
    session.calls.add(task); return task;
  }
  private diagnostic(session: Recognition, stage: string, details: Row = {}): void {
    try {
      this.options.diagnostic?.({ operationId: session.id, source: session.source, stage,
        elapsedMs: Date.now() - session.started, audioMs: Math.round(session.audioBytes / 32),
        ...(session.stopRequestedAt === undefined ? {} : { afterStopMs: Date.now() - session.stopRequestedAt }), ...details });
    } catch { /* Diagnostics never delay or fail dictation. */ }
  }
  private async event(session: Recognition, event: Row, context: string): Promise<void> {
    if (!session || session.abort.signal.aborted || !session.owner.attached || session.final || this.closing) return;
    if (this.preference() !== session.sourcePreference) event = { type: 'error', code: 'voice-source-changed' };
    if (event.type === 'status') {
      if (event.code === 'speech-recovering') {
        session.recovering = true; this.diagnostic(session, 'recovery-started');
        if (session.stopTimer) { clearTimeout(session.stopTimer); session.stopTimer = setTimeout(() => { void this.fail(session, 'speech-final-timeout'); }, voiceTranscriptionTimeoutMs('antigravity') + 30_000); }
      }
      await this.deliver(session, { type: 'status', code: text(event.code) }); return;
    }
    if (event.type === 'partial') {
      await this.deliver(session, { type: 'partial', text: truncate(text(event.text), 12000) }); return;
    }
    if (event.type === 'recognized') {
      const rawText = truncate(text(event.text).trim(), 12000);
      if (rawText && !session.refinement) {
        this.diagnostic(session, 'recognition-raw-complete');
        const elapsed = session.stopRequestedAt === undefined ? 0 : Date.now() - session.stopRequestedAt;
        session.refinement = new RefinementRace({
          rawText, delayMs: Math.max(0, refinementBackupDelay(session.audioBytes / 32) - elapsed),
          refine: signal => this.sessionCall(session, async () => {
            this.active(session.owner, session.abort.signal);
            this.diagnostic(session, 'backup-refinement-started');
            return polish(this.store, this.options, rawText, context, signal, session.chatSessionId);
          }),
          complete: result => this.queueEvent(session, { type: 'completed-refinement', ...result }, context),
          failed: code => this.queueEvent(session, { type: 'error', code, refinementFinalFailure: true }, context),
        });
      }
      return;
    }
    if (session.refinement && event.type === 'final') {
      session.refinement.native({ text: text(event.text), rawText: text(event.rawText), polished: event.polished === true, refinementComplete: event.refinementComplete === true });
      return;
    }
    if (session.refinement && event.type === 'error' && event.refinementFinalFailure !== true
      && /refinement_timed_out|connection_failed|transport_failed|incomplete|voice-provider-failed/.test(text(event.code))) {
      session.refinement.failed(text(event.code)); return;
    }
    session.final = true; session.refinement?.cancel(); clearTimeout(session.timer); if (session.stopTimer) clearTimeout(session.stopTimer);
    try {
      if (event.type === 'error') { await this.deliver(session, { type: 'error', code: text(event.code) || 'speech-failed', message: truncate(text(event.message), 500) }); return; }
      const rawText = truncate((text(event.rawText) || text(event.text)).trim(), 12000);
      if (!rawText) { await this.deliver(session, { type: 'error', code: 'empty-transcript' }); return; }
      this.diagnostic(session, 'recognition-complete');
      const refinementStarted = Date.now();
      let result: { text: string; polished: boolean };
      try {
        result = event.refinementComplete === true
          ? { text: truncate(text(event.text).trim(), 12000) || rawText, polished: event.polished === true }
          : await polish(this.store, this.options, rawText, context, session.abort.signal, session.chatSessionId);
        this.diagnostic(session, 'refinement-complete', { elapsedRefinementMs: Date.now() - refinementStarted, polished: result.polished, providerRefinement: event.refinementComplete === true && event.refinementSource !== 'text-model' });
        this.active(session.owner, session.abort.signal);
        if (this.preference() !== session.sourcePreference) throw new Error('voice-source-changed');
        // No await separates the cancellation check from the durable history mutation.
        this.store.addHistory({ id: randomUUID(), createdAt: Date.now(), rawText, finalText: result.text,
          durationMs: Math.round(session.audioBytes / 32), engine: session.source });
      } catch (error) {
        this.active(session.owner, session.abort.signal);
        await this.deliver(session, { type: 'error', code: error instanceof Error && error.message === 'voice-source-changed' ? 'voice-source-changed' : 'voice-finalization-failed' }); return;
      }
      await this.deliver(session, { type: 'final', text: result.text, rawText, polished: result.polished, refinementComplete: event.refinementComplete === true, refinementSource: text(event.refinementSource) || (event.refinementComplete === true ? 'native' : 'text-model') });
      this.diagnostic(session, 'final-delivered');
    } finally { session.helper.close(); }
  }
  private async deliver(session: Recognition, event: Row): Promise<void> {
    this.active(session.owner, session.abort.signal);
    await this.options.deliver(session.owner.id, 'voice:session:event', { ...event, sessionId: session.id,
      operationId: session.id, generation: session.owner.generation, seq: ++session.seq });
    this.active(session.owner, session.abort.signal);
  }
  private cancelSession(session: Recognition): void {
    session.abort.abort(new Error('voice-cancelled')); session.refinement?.cancel(); clearTimeout(session.timer);
    if (session.stopTimer) clearTimeout(session.stopTimer); session.helper.close();
  }
  private fail(session: Recognition, code: string): Promise<void> {
    session.failure ??= this.queueEvent(session, { type: 'error', code }, '')
      .catch(() => { /* Delivery rejection still closes the native resource. */ })
      .finally(() => session.helper.close());
    return session.failure;
  }
  async audio(id: number, payload: Row): Promise<Row> {
    const owner = this.owner(id), session = owner.session;
    if (!session || session.id !== text(payload.sessionId)) return { ok: false, error: 'speech-session-not-owned' };
    if (this.preference() !== session.sourcePreference) { await this.fail(session, 'voice-source-changed'); return { ok: false, error: 'voice-source-changed' }; }
    if (session.calls.size >= 4) { void this.fail(session, 'speech-audio-overflow'); return { ok: false, error: 'speech-audio-overflow' }; }
    return this.sessionCall(session, async () => {
      const bytes = audioBytes(payload.data, 32 * 1024);
      if (!bytes) { await this.fail(session, 'speech-audio-invalid'); return { ok: false, error: 'speech-audio-invalid' }; }
      try {
        if (payload.seq !== undefined && typeof payload.seq !== 'number') throw new Error('speech-audio-sequence');
        await session.helper.audio(bytes, payload.seq as number | undefined);
        session.audioBytes += bytes.byteLength;
        this.active(owner, session.abort.signal); return { ok: true, sessionId: session.id, seq: payload.seq ?? null };
      } catch (error) { await this.fail(session, error instanceof Error ? error.message : 'speech-write-failed'); return failure(error); }
    });
  }
  async stop(id: number, payload: Row): Promise<Row> {
    const owner = this.owner(id), session = owner.session;
    if (!session || payload.sessionId !== undefined && payload.sessionId !== null && session.id !== text(payload.sessionId)) return { ok: false, error: 'speech-session-not-owned' };
    session.stop ??= this.sessionCall(session, async () => {
      try {
        session.stopRequestedAt = Date.now(); this.diagnostic(session, 'stop-requested');
        await session.helper.stop();
        this.diagnostic(session, 'stop-acknowledged');
        if (!session.final && !session.stopTimer) session.stopTimer = setTimeout(() => { void this.fail(session, 'speech-final-timeout'); }, session.recovering ? voiceTranscriptionTimeoutMs('antigravity') + 30_000 : session.source === 'system' ? 15_000 : 35_000);
        return { ok: true, sessionId: session.id };
      } catch (error) { await this.fail(session, error instanceof Error ? error.message : 'speech-stop-failed'); return failure(error); }
    });
    return session.stop;
  }
  async cancel(id: number, payload: Row, milliseconds = 5000): Promise<Row> {
    const owner = this.owner(id), target = text(payload.sessionId) || text(payload.operationId);
    const sessions = [...this.sessions].filter(session => session.owner === owner && (!target || session.id === target));
    const matches = (key: string): boolean => !target || key === target || key.startsWith(`${target}-p`) || key.startsWith(`${target}-r`) || key === `${target}-w` || key === `${target}-source`;
    const tasks = [...owner.tasks].filter(task => task.kind !== 'learning' && matches(task.id));
    for (const key of owner.segments.keys()) if (matches(key)) owner.segments.delete(key);
    for (const session of sessions) this.cancelSession(session);
    for (const task of tasks) task.abort.abort(new Error('voice-cancelled'));
    const result = await deadline([...sessions.map(value => value.done), ...tasks.map(task => task.done)], milliseconds);
    return { ok: result.complete, ...result };
  }
  async transcribe(id: number, payload: Row): Promise<Row> {
    const experience = this.store.setting('voice.input.experience') || (this.options.streaming ? 'realtime' : 'compatibility');
    if (experience === 'realtime') return { ok: false, error: 'voice-source-unavailable' };
    const owner = this.owner(id), bytes = audioBytes(payload.data, VOICE_AUDIO_MAX_BYTES);
    if (!bytes?.length) return { ok: false, error: 'empty-audio' };
    const saved = this.store.setting(VOICE_INPUT_SOURCE_KEY), preference = this.preference();
    // Older narrow renderers recorded cloud audio without a source field. Only
    // an absent preference retains that custom route; a saved choice always wins.
    const source = payload.source === undefined && !saved ? 'custom' : payload.source ?? voiceInputSource(saved, !!this.command);
    if (!isVoiceInputSource(source)) return { ok: false, error: 'voice-source-unavailable' };
    if (bytes.length > voiceAudioMaxBytes(source)) return { ok: false, error: 'audio-too-large' };
    if (saved && saved !== source) return { ok: false, error: 'voice-source-changed' };
    if (source === 'system') return { ok: false, error: this.command ? 'voice-source-requires-system' : 'system-asr-unavailable' };
    const mime = text(payload.mimeType) || 'audio/webm';
    if (mime.length > 128 || /[\r\n]/.test(mime)) return { ok: false, error: 'invalid-mime-type' };
    const context = truncate(text(payload.context), 4000);
    const duration = typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs)
      ? Math.max(0, Math.min(VOICE_AUDIO_MAX_MS, payload.durationMs)) : 0;
    const active = (signal: AbortSignal): void => {
      this.active(owner, signal);
      if (this.preference() !== preference) throw new Error('voice-source-changed');
    };
    const partial = payload.partial === true;
    const segmentIds = payload.segmentIds;
    if (segmentIds !== undefined && (partial || !Array.isArray(segmentIds) || !segmentIds.length || segmentIds.length > 256 || segmentIds.some(value => typeof value !== 'string') || new Set(segmentIds).size !== segmentIds.length)) return { ok: false, error: 'voice-segments-invalid' };
    try {
      const chatSessionId = chatSession(payload);
      const id = operationId(payload);
      return await this.track(owner, partial ? 'partial' : 'foreground', id, async signal => {
        active(signal);
        if ((source === 'workbuddy' || source === 'antigravity' || source === 'trae') && await this.options.transcriptionAvailable?.(source, signal) !== true) {
          active(signal); return { ok: false, error: 'voice-source-unavailable' };
        }
        active(signal);
        let result: Row;
        if (Array.isArray(segmentIds)) {
          const receipts = segmentIds.map(key => owner.segments.get(String(key)));
          if (receipts.some(receipt => !receipt || receipt.source !== source || receipt.preference !== preference)) return { ok: false, error: 'voice-segments-invalid' };
          const coveredMs = receipts.reduce((sum, receipt) => sum + receipt!.durationMs, 0);
          if (Math.abs(coveredMs - duration) > segmentIds.length) return { ok: false, error: 'voice-segments-incomplete' };
          result = { ok: true, text: receipts.map(receipt => receipt!.text).filter(Boolean).join(' ') };
        } else {
          result = await transcribe(this.store, this.options, bytes, mime, signal,
            source === 'custom' ? undefined : { source, operationId: id },
            partial ? PARTIAL_TRANSCRIBE_TIMEOUT_MS : undefined);
        }
        active(signal);
        if (result.ok !== true) return result;
        const rawText = text(result.text);
        // A segment probe returns the raw provider text: no polish, no history, no learning.
        if (partial) {
          // A provider timeout can outlive the recording itself. Bound receipts
          // by count; recovery, cancellation and owner detach clear them.
          if (owner.segments.size >= 256) owner.segments.delete(owner.segments.keys().next().value!);
          owner.segments.set(id, { text: rawText, source, preference, durationMs: duration });
          return { ok: true, text: rawText, partial: true };
        }
        const final = await polish(this.store, this.options, rawText, context, signal, chatSessionId);
        active(signal);
        this.store.addHistory({ id: randomUUID(), createdAt: Date.now(), rawText, finalText: final.text, durationMs: duration, engine: source });
        if (Array.isArray(segmentIds)) for (const key of segmentIds) owner.segments.delete(String(key));
        return { ok: true, text: final.text, rawText, polished: final.polished };
      });
    } catch (error) { return failure(error); }
  }

  async learn(id: number, payload: Row): Promise<Row> {
    const owner = this.owner(id);
    try {
      const snapshot = { rawText: truncate(text(payload.rawText), 12000), insertedText: truncate(text(payload.insertedText), 12000), finalText: truncate(text(payload.finalText), 12000), chatSessionId: chatSession(payload) ?? '' };
      return await this.track(owner, 'learning', operationId(payload), async signal => {
        const additions = await learn(this.store, this.options, snapshot, signal);
        this.active(owner, signal);
        return { ok: true, addedHotwords: additions };
      });
    } catch (error) { return failure(error); }
  }
  stored(id: number, action: string, payload: Row): Json {
    this.owner(id);
    switch (action) {
      case 'hotwords:list': return this.store.hotwords();
      case 'hotwords:add': return this.store.addHotword(text(payload.text), 'manual', Date.now(), text(payload.id) || undefined);
      case 'hotwords:delete': return this.store.deleteHotword(text(payload.id));
      case 'hotwords:toggle': return this.store.toggleHotword(text(payload.id), payload.enabled === true);
      case 'memories:list': return this.store.memories();
      case 'memories:delete': return this.store.deleteMemory(text(payload.id));
      case 'history:list': return this.store.history(payload.limit);
      case 'history:clear': return this.store.clearHistory();
      default: throw new Error('voice-action-invalid');
    }
  }
  async detachOwner(id: number, milliseconds = 5000): Promise<{ complete: boolean }> {
    const owner = this.owners.get(id); if (!owner) return { complete: true };
    owner.attached = false; owner.segments.clear();
    const sessions = [...this.sessions].filter(session => session.owner === owner);
    for (const session of sessions) this.cancelSession(session);
    for (const task of owner.tasks) task.abort.abort(new Error('voice-owner-closed'));
    const result = await deadline([...sessions.map(session => session.done), ...[...owner.tasks].map(task => task.done)], milliseconds);
    this.forget(owner); return result;
  }
  async shutdown(milliseconds = 5000): Promise<{ complete: boolean }> {
    this.closing = true;
    const reports = await Promise.all([...this.owners.keys()].map(id => this.detachOwner(id, milliseconds)));
    return { complete: reports.every(report => report.complete) && !this.tasks.size && !this.sessions.size };
  }
}
