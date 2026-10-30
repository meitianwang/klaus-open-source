import { randomUUID } from 'node:crypto';
import type { ClientEvent } from '../engine/protocol';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { DreamStore } from './dream-store';
import { SerialMutations, object, string, errorMessage, type EngineRequest, type JsonObject } from './service-types';

export interface DreamSubject { rendererId: string; engineId: string; generation: number; busy: boolean }
export interface DreamDeps {
  configRoot: string; request: EngineRequest;
  startDream(subject: DreamSubject, submissionId: string): Promise<Json>;
  subject(rendererId: string): DreamSubject | undefined;
  generation(): number | undefined;
  onChanged(): void | Promise<void>;
  push(snapshot: JsonObject): void;
  log(message: string): void;
  now?: () => number;
}
interface ManualRun { subject: DreamSubject; submissionId: string; taskId: string; startedAt: number; started: boolean; completion?: JsonObject }
const bool = (value: Json | undefined, fallback: boolean): boolean => typeof value === 'boolean' ? value : ['1', 'true', 'on'].includes(String(value)) ? true : ['0', 'false', 'off'].includes(String(value)) ? false : fallback;
const positive = (value: Json | undefined, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : fallback;
export function dreamConfig(values: JsonObject): JsonObject {
  return { enabled: bool(values.autoDream, false), minHours: positive(object(values.dream).minHours, 24), minSessions: positive(object(values.dream).minSessions, 5),
    skillEvolutionEnabled: bool(object(object(values.desktop).dream).skillEvolution, false) };
}
export function completedDream(taskId: string, startedAt: number, value: JsonObject, now: number): JsonObject {
  return { taskId, phase: 'updating', status: value.ok === true ? 'completed' : 'failed', stoppable: false, sessionsReviewing: 0,
    filesTouched: Array.isArray(value.filesTouched) ? value.filesTouched : [], turns: [], turnCount: Number.isSafeInteger(value.turnCount) ? value.turnCount! : 0,
    startedAt, endedAt: now, ...(typeof value.reason === 'string' && value.reason ? { summary: value.reason } : {}) };
}
export function automaticDream(run: JsonObject, now: number): JsonObject | undefined {
  if (!['completed', 'failed'].includes(string(run.status)) || !Number.isSafeInteger(run.startedAt)) return undefined;
  return { taskId: 'klaus-dream-' + run.startedAt, phase: 'updating', status: run.status!, stoppable: false,
    sessionsReviewing: Number.isSafeInteger(run.sessionsReviewing) ? run.sessionsReviewing! : 0, filesTouched: Array.isArray(run.filesTouched) ? run.filesTouched : [],
    turns: [], turnCount: Number.isSafeInteger(run.turnCount) ? run.turnCount! : 0, startedAt: run.startedAt!, endedAt: Number.isSafeInteger(run.endedAt) ? run.endedAt! : now,
    ...(typeof run.summary === 'string' && run.summary ? { summary: run.summary } : {}) };
}

/** A lifecycle observer and configuration owner; consolidation stays inside the single engine. */
export class DreamService {
  readonly store: DreamStore;
  private readonly mutations = new SerialMutations();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly completedEngineIds = new Set<string>();
  private readonly settled = new Map<string, { subject: DreamSubject; order: number }>();
  private readonly manual = new Map<string, ManualRun>();
  private order = 0;
  private observedGeneration?: number;
  private currentSnapshot?: Json;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: DreamDeps) {
    this.store = new DreamStore(deps.configRoot);
    this.observedGeneration = deps.generation();
    try { const reaped = this.store.reap(); if (reaped) deps.log('Finalized stale dream runs: ' + reaped); }
    catch (error) { deps.log('Dream history startup recovery failed: ' + errorMessage(error)); }
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private active(): void { if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'Dream service is closed'); }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    try { this.active(); } catch (error) { return Promise.reject(error); }
    const pending = operation(); this.pending.add(pending); return pending.finally(() => this.pending.delete(pending));
  }
  private async config(): Promise<{ values: JsonObject; version: string }> {
    const reply = object(await this.deps.request('config/read', {}));
    if (!reply.values || typeof reply.values !== 'object' || Array.isArray(reply.values) || typeof reply.version !== 'string') throw new Error('Invalid engine configuration snapshot');
    return { values: reply.values, version: reply.version };
  }
  configGet(): Promise<Json> { return this.track(async () => dreamConfig((await this.config()).values)); }
  configSet(payload: JsonObject): Promise<Json> {
    return this.track(() => this.mutations.run(async () => {
      this.active(); const snapshot = await this.config(), current = dreamConfig(snapshot.values), result: JsonObject = {
        enabled: typeof payload.enabled === 'boolean' ? payload.enabled : current.enabled!,
        minHours: positive(payload.minHours, Number(current.minHours)),
        minSessions: Math.max(1, Math.floor(positive(payload.minSessions, Number(current.minSessions)))),
        skillEvolutionEnabled: typeof payload.skillEvolutionEnabled === 'boolean' ? payload.skillEvolutionEnabled : current.skillEvolutionEnabled!,
      };
      const edits = [['autoDream', result.enabled], ['dream.minHours', result.minHours], ['dream.minSessions', result.minSessions], ['desktop.dream.skillEvolution', result.skillEvolutionEnabled ? 'on' : 'off']]
        .map(([keyPath, value]) => ({ keyPath: keyPath!, value: value!, mergeStrategy: 'replace' }));
      this.active(); const reply = object(await this.deps.request('config/batchWrite', { expectedVersion: snapshot.version, edits }));
      if (reply.error != null) throw new Error(errorMessage(reply.error));
      if (typeof reply.version !== 'string' || !reply.values || typeof reply.values !== 'object' || Array.isArray(reply.values)) throw new Error('The engine did not confirm the dream configuration write');
      try { await this.deps.onChanged(); } catch (error) { throw new Error('Dream configuration was saved, but refreshing the host failed: ' + errorMessage(error)); }
      return result;
    }));
  }
  current(): Json { this.active(); return structuredClone(this.currentSnapshot === undefined ? this.currentSnapshot = this.store.latest() : this.currentSnapshot); }
  list(payload: JsonObject): Json { this.active(); return this.store.list(payload); }
  detail(payload: JsonObject): Json { this.active(); return this.store.detail(payload.taskId); }
  stop(_payload: JsonObject): Json { this.active(); return { ok: false, error: 'not-running' }; }
  private publish(snapshot: JsonObject): void {
    // History is useful, but it must not become the owner of the live lifecycle.
    // Keep the current snapshot and dream:event flowing when SQLite is
    // temporarily unavailable so renderer state reflects the live operation.
    try { this.store.save(snapshot); }
    catch (error) { this.deps.log('Dream history persistence failed: ' + errorMessage(error)); }
    this.currentSnapshot = snapshot;
    try { this.deps.push(structuredClone(snapshot)); }
    catch (error) { this.deps.log('Dream event delivery failed: ' + errorMessage(error)); }
  }
  private syncGeneration(): void {
    const generation = this.deps.generation();
    if (generation !== this.observedGeneration) { this.failRunning('Engine connection changed'); this.completedEngineIds.clear(); this.settled.clear(); this.observedGeneration = generation; }
  }
  private rememberSettled(rendererId: string): void {
    const subject = this.deps.subject(rendererId); if (!subject) return;
    this.settled.set(rendererId, { subject, order: ++this.order });
    if (this.settled.size > 1024) this.settled.delete(this.settled.keys().next().value!);
  }
  observeChat(events: Json[]): void {
    if (this.closed) return;
    this.syncGeneration();
    for (const raw of events) {
      const event = object(raw); if (!['done', 'interrupted'].includes(string(event.type)) || typeof event.sessionId !== 'string') continue;
      const subject = this.deps.subject(event.sessionId);
      if (!subject || !this.completedEngineIds.delete(subject.engineId)) continue;
      this.rememberSettled(event.sessionId);
    }
  }
  private latest(): DreamSubject | undefined {
    const generation = this.deps.generation();
    for (const row of [...this.settled.values()].sort((a, b) => b.order - a.order)) {
      const current = this.deps.subject(row.subject.rendererId);
      if (current && current.generation === generation && current.engineId === row.subject.engineId && current.generation === row.subject.generation) return current;
    }
    return undefined;
  }
  triggerNow(): Promise<Json> {
    return this.track(async (): Promise<Json> => {
      this.syncGeneration();
      if (this.manual.size) return { ok: false, error: 'already-running' };
      const subject = this.latest(); if (!subject) return { ok: false, error: 'no-context' };
      const startedAt = this.now(), nonce = randomUUID(), run: ManualRun = { subject, startedAt, started: false, taskId: 'klaus-dream-' + startedAt + '-' + nonce.slice(0, 8), submissionId: 'dream-' + nonce };
      this.manual.set(run.submissionId, run);
      try {
        // The facade ACK only accepts the submission. Its correlated `dream`
        // outcome determines whether consolidation actually started.
        const outcome = object(await this.deps.startDream(subject, run.submissionId));
        if (!this.manual.has(run.submissionId) || subject.generation !== this.deps.generation()) throw new Error('The dream engine owner changed before start was confirmed');
        if (outcome.ok !== true) { this.manual.delete(run.submissionId); return { ok: false, error: string(outcome.reason) || 'dream-not-started' }; }
        run.started = true;
        if (run.completion) { this.manual.delete(run.submissionId); this.publish(completedDream(run.taskId, startedAt, run.completion, this.now())); }
        else this.publish({ taskId: run.taskId, startedAt, phase: 'starting', status: 'running', stoppable: false, sessionsReviewing: 1, filesTouched: [], turns: [], turnCount: 0 });
        return { ok: true };
      } catch (error) {
        if (this.manual.delete(run.submissionId) && run.started) this.publish(completedDream(run.taskId, startedAt, { ok: false, reason: errorMessage(error) }, this.now()));
        return { ok: false, error: errorMessage(error) };
      }
    });
  }
  observeEngine(event: ClientEvent): void {
    if (this.closed) return;
    this.syncGeneration();
    if (event.type === 'streamClosed') { this.failRunning('Engine connection closed'); this.completedEngineIds.clear(); this.settled.clear(); return; }
    // Keep the authoritative app-server settlement until the projector supplies
    // its renderer id. This includes aborted turn/completed notifications while
    // excluding unrelated `interrupted` UI notices such as session closure.
    if (event.type === 'turnCompleted') {
      const params = object(event.params);
      if (typeof params.sessionId === 'string') {
        this.completedEngineIds.add(params.sessionId);
        if (this.completedEngineIds.size > 1024) this.completedEngineIds.delete(this.completedEngineIds.values().next().value!);
      }
      return;
    }
    if (!['rawSessionEvent', 'sessionEvent', 'engineEvent'].includes(event.type) || !('params' in event)) return;
    const params = object(event.params), envelope = object(params.event ?? params), generation = this.deps.generation();
    const maintenance = object(envelope.memoryMaintenanceEvent);
    if (Object.keys(maintenance).length) this.deps.log(JSON.stringify({ kind: maintenance.kind, status: object(maintenance.run).status }));
    const automatic = maintenance.kind === 'auto_dream' ? automaticDream(object(maintenance.run), this.now()) : undefined;
    if (automatic) this.publish(automatic);
    const run = this.manual.get(string(envelope.submissionId));
    if (!run || run.subject.generation !== generation || params.sessionId !== run.subject.engineId) return;
    const completion = object(envelope.dreamCompleted);
    if (typeof completion.ok !== 'boolean' && typeof envelope.error !== 'string') return;
    run.completion = typeof completion.ok === 'boolean' ? completion : { ok: false, reason: envelope.error! };
    if (run.started) { this.manual.delete(run.submissionId); this.publish(completedDream(run.taskId, run.startedAt, run.completion, this.now())); }
  }
  forget(id: string): void {
    this.settled.delete(id);
    for (const run of this.manual.values()) if (run.subject.rendererId === id) {
      this.manual.delete(run.submissionId); if (run.started) this.publish(completedDream(run.taskId, run.startedAt, { ok: false, reason: 'Conversation closed' }, this.now()));
    }
  }
  private failRunning(reason: string): void {
    for (const run of this.manual.values()) if (run.started) this.publish(completedDream(run.taskId, run.startedAt, { ok: false, reason }, this.now())); this.manual.clear();
  }
  close(): Promise<void> {
    return this.closing ??= (async () => { this.closed = true; await Promise.allSettled([...this.pending]); this.failRunning('Application closed'); this.completedEngineIds.clear(); this.settled.clear(); })();
  }
}
