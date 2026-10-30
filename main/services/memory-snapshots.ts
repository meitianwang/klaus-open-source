import type { ClientEvent } from '../engine/protocol';
import type { Json } from '../ipc/contract';
import { object, string, errorMessage, type JsonObject } from './service-types';

export interface SnapshotOwner { engineId: string; generation: number; rendererId: string }
export type SnapshotResolution = { decision: 'keep' | 'merge' | 'replace' } | { reason: 'timed-out' | 'disconnected' | 'no-handler' };
export interface MemorySnapshotDeps {
  generation(): number | undefined;
  rendererId(engineId: string): string;
  present(prompt: JsonObject, signal: AbortSignal, owner: SnapshotOwner): Promise<boolean>;
  resolve(owner: SnapshotOwner, requestId: string, result: SnapshotResolution): Promise<void>;
  log(message: string): void;
  timeoutMs?: number;
}
interface Pending {
  id: string
  rawId: string
  owner: SnapshotOwner
  controller: AbortController
  timer: NodeJS.Timeout
  settling?: Promise<void>
}

/** Engine audits create authority; a renderer reply can only settle that exact live request. */
export class MemorySnapshotService {
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly timeout: number;
  private observedGeneration?: number;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: MemorySnapshotDeps) {
    this.timeout = deps.timeoutMs ?? 120_000; this.observedGeneration = deps.generation();
    if (!Number.isSafeInteger(this.timeout) || this.timeout <= 0 || this.timeout > 120_000) throw new Error('Invalid memory snapshot deadline');
  }
  private track<T>(promise: Promise<T>): Promise<T> { this.jobs.add(promise); return promise.finally(() => this.jobs.delete(promise)); }
  private remember(id: string): void { this.seen.add(id); if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!); }
  private discard(entry: Pending): void { this.pending.delete(entry.id); clearTimeout(entry.timer); entry.controller.abort(); this.remember(entry.id); }
  private reset(): void { for (const entry of this.pending.values()) this.discard(entry); this.seen.clear(); }
  receive(event: ClientEvent): void {
    if (this.closed) return;
    const generation = this.deps.generation();
    if (generation !== this.observedGeneration) { this.reset(); this.observedGeneration = generation; }
    if (event.type === 'streamClosed') { this.reset(); return; }
    if (generation === undefined || !['rawSessionEvent', 'sessionEvent', 'engineEvent'].includes(event.type) || !('params' in event)) return;
    const params = object(event.params), envelope = object(params.event ?? params), audit = object(envelope.agentMemorySnapshotDecision), request = object(audit.request);
    const rawId = string(request.requestId), engineId = string(params.sessionId);
    if (!rawId || rawId.length > 256 || !engineId || engineId.length > 256) return;
    const id = `${generation}:memory:${engineId}:${rawId}`, previous = this.pending.get(id);
    if (string(audit.status).toLowerCase() !== 'requested') { if (previous) this.discard(previous); this.remember(id); return; }
    if (previous || this.seen.has(id)) return;
    if (this.pending.size >= 128) { this.deps.log('Memory snapshot prompt capacity exceeded; engine keep policy remains active'); return; }
    const controller = new AbortController(), owner: SnapshotOwner = { engineId, generation, rendererId: this.deps.rendererId(engineId) };
    const entry: Pending = { id, rawId, owner, controller, timer: setTimeout(() => { void this.settle(id, { reason: 'timed-out' }); }, this.timeout) };
    this.pending.set(id, entry);
    const prompt: JsonObject = { requestId: id, agentType: request.agentType ?? '', snapshotTimestamp: request.snapshotTimestamp ?? '' };
    void this.track((async () => {
      try { if (!await this.deps.present(prompt, controller.signal, owner)) await this.settle(id, { reason: 'no-handler' }); }
      catch { if (this.pending.has(id)) await this.settle(id, { reason: 'no-handler' }); }
    })());
  }
  private settle(id: string, result: SnapshotResolution): Promise<void> {
    const entry = this.pending.get(id); if (!entry) return Promise.resolve();
    if (entry.settling) return entry.settling;
    if (entry.owner.generation !== this.deps.generation()) { this.discard(entry); return Promise.resolve(); }
    if ('decision' in result) {
      const operation = this.track(this.deps.resolve(entry.owner, entry.rawId, result).then(() => {
        if (this.pending.get(id) === entry) this.discard(entry);
      }));
      entry.settling = operation;
      return operation.finally(() => { if (entry.settling === operation) entry.settling = undefined; });
    }
    this.discard(entry);
    return this.track(this.deps.resolve(entry.owner, entry.rawId, result).catch(error => {
      this.deps.log('Memory snapshot response was not confirmed: ' + errorMessage(error));
    }));
  }
  async respond(payload: JsonObject): Promise<Json> {
    const id = string(payload.requestId), choice = payload.choice;
    if (id) await this.settle(id, { decision: choice === 'merge' || choice === 'replace' ? choice : 'keep' });
    return null;
  }
  rendererUnavailable(rendererId?: string): Promise<void> {
    return Promise.all([...this.pending.values()].filter(entry => rendererId === undefined || entry.owner.rendererId === rendererId).map(({ id }) => this.settle(id, { reason: 'no-handler' }))).then(() => {});
  }
  forget(rendererId: string): void { for (const entry of this.pending.values()) if (entry.owner.rendererId === rendererId) this.discard(entry); }
  counts(): { prompts: number; operations: number } { return { prompts: this.pending.size, operations: this.jobs.size }; }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      await Promise.all([...this.pending.keys()].map(id => this.settle(id, { reason: 'disconnected' })));
      while (this.jobs.size) await Promise.allSettled([...this.jobs]); this.seen.clear();
    })();
  }
}
