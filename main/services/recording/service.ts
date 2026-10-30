import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { RecordingHelper, recordingCapabilities, recordingDeadline, type RecordingCommand, type RecordingPolicy, type RecordingRow } from './helper';
import { RecordingStore, type RecordingState } from './store';

export interface RecordingEnded {
  recordingId: string; sessionId: string; generation: number; mode: 'stop' | 'discard' | 'error'; eventsPath?: string; error?: string;
}
export interface RecordingStartContext {
  sessionId: string; signal: AbortSignal;
  elicit(request: RecordingRow, signal: AbortSignal): Promise<unknown>;
}
export interface RecordingDependencies {
  recordingsRoot: string; command?: RecordingCommand; platform?: NodeJS.Platform;
  policy(): Promise<RecordingPolicy> | RecordingPolicy;
  showPanel(state: RecordingState): Promise<void>;
  closePanel(recordingId: string): void | Promise<void>;
  /** One acknowledged delivery. A rejection must never cause an automatic replay. */
  ended(value: RecordingEnded): Promise<void>;
  log(message: string): void;
  maxDurationMs?: number;
}
export interface RecordingResult { ok: boolean; complete: boolean; state?: RecordingState; error?: string }
interface Active {
  id: string; sessionId: string; generation: number; abort: AbortController; store: RecordingStore;
  state?: RecordingState; helper?: RecordingHelper; start?: Promise<RecordingState>; finalization?: Promise<RecordingResult>;
  finished: boolean; approved: boolean; displayed: boolean; silent: boolean; origin?: string;
  poll?: NodeJS.Timeout; pollWork?: Promise<void>; startupError?: string;
}
const owners = new Map<string, Active>();
const message = (error: unknown): string => error instanceof Error ? error.message : 'recording-failed';
const object = (value: unknown): RecordingRow => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordingRow : {};

/** Owns consent, disk state and the session that must receive the finished demonstration. */
export class RecordingService {
  private active?: Active;
  private generation = 0;
  private closing = false;
  private readonly work = new Set<Promise<unknown>>();
  private readonly completed = new Map<string, RecordingState>();
  private readonly key: string;
  constructor(private readonly deps: RecordingDependencies) { this.key = resolve(deps.recordingsRoot); }
  private track<T>(task: Promise<T>): Promise<T> {
    this.work.add(task); void task.finally(() => this.work.delete(task)).catch(() => {}); return task;
  }
  capabilities() { return this.track(recordingCapabilities(this.deps.command, this.deps.platform)); }
  snapshot(sessionId: string): RecordingState | undefined {
    const state = this.active?.sessionId === sessionId ? this.active.state : this.completed.get(sessionId);
    return state ? { ...state } : undefined;
  }
  snapshotForSession(sessionId: string): Promise<RecordingState | undefined> {
    if (this.closing) return Promise.reject(new Error('recording-service-closed'));
    const state = this.snapshot(sessionId);
    return state ? Promise.resolve(state) : this.track(new RecordingStore(this.deps.recordingsRoot).previousForSession(sessionId));
  }
  status(recordingId?: string): RecordingRow {
    const resource = this.active;
    if (recordingId && resource?.id !== recordingId) throw new Error('recording-owner-not-active');
    if (!resource) return { recording: false, supported: (this.deps.platform ?? process.platform) === 'darwin' && !!this.deps.command };
    return { recording: !resource.finished && resource.state?.state === 'recording', id: resource.id, recordingId: resource.id,
      sessionId: resource.sessionId, startedAt: resource.state?.startedAt ?? null, state: resource.state?.state ?? 'approving',
      ...(resource.state?.error ? { error: resource.state.error } : {}), ...(resource.startupError ? { error: resource.startupError } : {}) };
  }
  start(context: RecordingStartContext): Promise<RecordingState> {
    if (this.closing) return Promise.reject(new Error('recording-service-closed'));
    if (!context.sessionId || context.sessionId.length > 256 || context.signal.aborted) return Promise.reject(new Error('recording-session-invalid-or-cancelled'));
    if (owners.has(this.key)) return Promise.reject(new Error('recording-already-active'));
    const resource: Active = { id: randomUUID(), sessionId: context.sessionId, generation: ++this.generation,
      abort: new AbortController(), store: new RecordingStore(this.deps.recordingsRoot), finished: false, approved: false, displayed: false, silent: false };
    this.active = resource; owners.set(this.key, resource);
    const cancel = () => { resource.silent = true; resource.abort.abort(); void resource.helper?.close(); };
    context.signal.addEventListener('abort', cancel, { once: true });
    const task = this.track(this.launch(resource, context).finally(() => context.signal.removeEventListener('abort', cancel)));
    resource.start = task; return task;
  }
  private check(resource: Active): void {
    if (resource.abort.signal.aborted || this.closing || this.active !== resource) throw new Error('recording-cancelled');
  }
  private async launch(resource: Active, context: RecordingStartContext): Promise<RecordingState> {
    try {
      const capabilities = await this.capabilities(); this.check(resource);
      if (!capabilities.supported) throw new Error(capabilities.error ?? 'recording-unavailable');
      if (!capabilities.permissions?.accessibility || !capabilities.permissions.inputMonitoring) throw new Error('macos-input-monitoring-or-accessibility-permission-required');
      const consent = object(await context.elicit({ _meta: { klaus: { recordAndReplay: true } },
        message: 'Record your actions on this Mac for up to 30 minutes? Mouse clicks, typed text, and window switches are captured until you press Stop. Apps on your blocked list and password fields are excluded.',
        requestedSchema: { properties: {}, type: 'object' } }, resource.abort.signal));
      this.check(resource);
      if (consent.action !== 'accept') throw new Error('Record & Replay approval was not granted via MCP elicitation.');
      resource.approved = true;
      const policy = await this.deps.policy(); this.check(resource);
      resource.state = await resource.store.create({ id: resource.id, sessionId: resource.sessionId, generation: resource.generation,
        pid: 0, hostPid: process.pid, state: 'starting', startedAt: Date.now(), eventCount: 0, suppressedEventCount: 0 });
      this.check(resource);
      const helper = new RecordingHelper({ command: this.deps.command!, recordingId: resource.id, generation: resource.generation,
        blockedApps: policy.blockedApps, allowedProcessIds: policy.allowedProcessIds, maxDurationMs: this.deps.maxDurationMs,
        onReady: async () => {
          this.check(resource);
          const state = resource.state!; state.pid = helper.pid ?? 0; state.state = 'recording'; state.startedAt = Date.now();
          await resource.store.persist(state); this.check(resource);
          await this.deps.showPanel({ ...state }); resource.displayed = true; this.check(resource);
        },
        onEvent: async event => {
          if (resource.state!.eventCount >= 200_000) throw new Error('recording-event-limit');
          await resource.store.append(event); resource.state!.eventCount++;
        },
      });
      resource.helper = helper;
      resource.finalization = this.track(this.finalize(resource));
      await helper.ready; this.check(resource);
      if (resource.finished || resource.state.state !== 'recording') throw new Error('recording-ended-during-start');
      resource.poll = setInterval(() => {
        if (resource.pollWork || resource.origin || resource.finished) return;
        const pending = this.track((async () => {
          const control = await resource.store.control();
          if (control && !resource.origin && !resource.finished) {
            resource.origin = 'panel'; void helper.stop(control, control === 'stop' ? 'recording_controls_stopped' : 'recording_controls_cancelled').catch(() => {});
          }
        })().catch(error => { resource.startupError = message(error); void helper.close(); }));
        resource.pollWork = pending; void pending.finally(() => { resource.pollWork = undefined; });
      }, 300);
      return { ...resource.state };
    } catch (error) {
      resource.startupError = message(error); resource.silent = true;
      if (resource.helper) await resource.helper.close();
      else {
        try { await resource.store.flush(); } catch (failure) { this.deps.log(message(failure)); }
        if (resource.state) {
          resource.state.state = 'failed'; resource.state.error = message(error); resource.state.endedAt = Date.now();
          try { await resource.store.persist(resource.state); } catch (failure) { this.deps.log(message(failure)); }
        }
        resource.finished = true;
        if (owners.get(this.key) === resource) owners.delete(this.key);
      }
      throw error;
    }
  }
  private async finalize(resource: Active): Promise<RecordingResult> {
    let mode: RecordingEnded['mode'] = 'error', reason = 'recording-failed', error: string | undefined;
    try {
      const end = await resource.helper!.completed; await resource.helper!.done;
      mode = end.mode; reason = end.reason; resource.state!.suppressedEventCount = end.suppressedEventCount;
      if (mode === 'error') error = reason;
    } catch (failure) { error = resource.startupError ?? message(failure); }
    // Even an early transport failure must wait for queued disk callbacks and physical exit.
    await resource.helper!.done.catch(() => {});
    if (resource.poll) clearInterval(resource.poll);
    await resource.pollWork;
    try { await resource.store.flush(); } catch (failure) { error = message(failure); }
    if (error) mode = 'error';
    const state = resource.state!;
    state.state = mode === 'stop' ? 'ended' : mode === 'discard' ? 'discarded' : 'failed';
    state.endedAt = Date.now(); state.endReason = reason;
    if (error) state.error = error;
    try {
      if (mode === 'discard') await resource.store.discard(state); else await resource.store.persist(state);
    } catch (failure) { error = message(failure); mode = 'error'; state.state = 'failed'; state.error = error; }
    this.completed.set(resource.sessionId, { ...state });
    if (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!);
    try { await this.deps.closePanel(resource.id); } catch (failure) { error ??= message(failure); }
    // Retain the reservation until all old callbacks are done; a new recording cannot borrow this panel.
    if (resource.displayed && !resource.silent) {
      try { await this.deps.ended({ recordingId: resource.id, sessionId: resource.sessionId, generation: resource.generation, mode,
        ...(mode === 'stop' ? { eventsPath: state.eventsPath } : {}), ...(error ? { error } : {}) }); }
      catch (failure) { error ??= message(failure); }
    }
    resource.finished = true;
    if (owners.get(this.key) === resource) owners.delete(this.key);
    return { ok: !error, complete: true, state: { ...state }, ...(error ? { error } : {}) };
  }
  async stop(recordingId: string, mode: 'stop' | 'discard', origin: 'panel' | 'tool' | 'session' = 'panel'): Promise<RecordingResult> {
    const resource = this.active;
    if (!resource || resource.id !== recordingId) throw new Error('recording-owner-not-active');
    if (!resource.origin) {
      resource.origin = origin;
      if (origin !== 'panel') resource.silent = true;
      if (!resource.helper) resource.abort.abort();
      else void resource.helper.stop(mode, origin === 'tool' ? 'tool_stop' : origin === 'session' ? 'session_closed' : mode === 'discard' ? 'recording_controls_cancelled' : 'recording_controls_stopped').catch(() => {});
    }
    await resource.start?.catch(() => {});
    return resource.finalization ? resource.finalization : { ok: false, complete: resource.finished, error: resource.startupError ?? 'recording-not-started' };
  }
  async stopSession(sessionId: string, deadlineMs = 5000): Promise<{ complete: boolean }> {
    const resource = this.active;
    if (!resource || resource.sessionId !== sessionId || resource.finished) return { complete: true };
    resource.silent = true; resource.abort.abort();
    const task = this.track(this.stop(resource.id, 'stop', 'session'));
    if (await recordingDeadline(task, deadlineMs)) return { complete: true };
    if (resource.helper) void resource.helper.close();
    return { complete: false };
  }
  updatePolicy(): Promise<void> { return this.track(this.applyPolicy()); }
  private async applyPolicy(): Promise<void> {
    const resource = this.active;
    if (this.closing || !resource?.helper || resource.finished) return;
    const policy = await this.deps.policy();
    if (this.closing || resource !== this.active || resource.finished) return;
    await resource.helper.updatePolicy(policy);
  }
  async observe(sessionId: string, events: RecordingRow[]): Promise<void> {
    const resource = this.active;
    if (!resource || resource.sessionId !== sessionId || resource.finished || resource.state?.state !== 'recording') return;
    if (events.some(event => event.type === 'tool_end' && event.toolName === 'mcp__computer-use__event_stream_start' && event.isError !== true)) {
      // Native start already owns panel creation. Await its result instead of opening
      // another window from a delayed engine event after the recording has ended.
      await resource.start;
    }
  }
  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closing = true;
    const resource = this.active;
    if (resource && !resource.finished) {
      resource.silent = true; resource.abort.abort();
      if (resource.helper) void resource.helper.stop('stop', 'host_shutdown').catch(() => {});
    }
    const drained = Promise.allSettled([...this.work]);
    if (await recordingDeadline(drained, deadlineMs)) return { complete: this.work.size === 0 };
    if (resource?.helper) void resource.helper.close();
    return { complete: false };
  }
}
