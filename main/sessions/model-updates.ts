import { randomUUID } from 'node:crypto';
import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { IpcHandlerError } from '../ipc/registry';
import type { HostState, SessionProviderIdentity } from '../services/host-state';

interface ModelClient {
  requestWithTimeout(method: string, params: Json, timeout: number): Promise<unknown>;
}
export interface ModelUpdateBinding { client: ModelClient; engineId: string }
/**
 * Why a publication started. A sign-out removes the credential a live session
 * was using, so the background re-preparation it triggers is expected to fail;
 * that failure settles its fence but is reported quietly instead of announced
 * as a model error the user caused.
 */
export type ModelUpdateOrigin = 'signed-out';
export interface ModelCandidate {
  init: Record<string, Json>;
  provider: SessionProviderIdentity;
  preferenceRevision: number;
}
interface Change {
  id: string;
  binding: ModelUpdateBinding;
  preferenceRevision: number;
  expectedRevision?: number;
  deadline: number;
  controller: AbortController;
  fenced: Promise<void>;
  fenceConfirmed: boolean;
  candidate?: ModelCandidate;
  publishing: boolean;
  uncertain: boolean;
  failed: boolean;
  origin?: ModelUpdateOrigin;
}
interface ModelUpdateDeps {
  state: HostState;
  binding(id: string): ModelUpdateBinding | undefined;
  ensure(id: string, binding: ModelUpdateBinding): void;
  prepare(id: string, changeId: string, signal: AbortSignal): Promise<ModelCandidate>;
  release(id: string, changeId: string): void;
  push(events: Json[]): void;
  log?(kind: string, message: string): void;
  now?(): number;
}
const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const messageOf = (error: unknown): string => error instanceof Error ? error.message
  : typeof object(error)?.message === 'string' ? String(object(error)!.message) : 'The engine did not confirm the model change';
const conflict = (error: unknown): boolean => object(error)?.kind === 'server' && object(error)?.message === 'model reconfiguration revision conflict';
const sessionClosed = (error: unknown): boolean => (error instanceof IpcHandlerError && error.code === 'SESSION_UNAVAILABLE')
  || (object(error)?.kind === 'server' && object(error)?.code === -32004);

/** Model publication has its own singleflight lane: never wait behind tools or title inference. */
export class ModelUpdates {
  private readonly changes = new Map<string, Change>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly lastRunChange = new Map<string, Change>();
  constructor(private readonly deps: ModelUpdateDeps) {}

  /** Settings callbacks finish only after the latest selection has an acknowledged capture fence. */
  async changed(id: string, origin?: ModelUpdateOrigin): Promise<void> {
    const binding = this.deps.binding(id);
    if (!binding) return;
    const change = this.begin(id, binding, false, origin);
    void this.work(id).catch(error => {
      if (!sessionClosed(error)) this.deps.log?.('model-update-failed', messageOf(error));
    });
    try {
      await change.fenced;
      const latest = this.changes.get(id);
      if (latest && latest !== change) await latest.fenced;
    } catch (error) {
      if (!sessionClosed(error)) throw error;
      const next = this.deps.binding(id);
      if (next && next.engineId !== binding.engineId && this.deps.state.inferencePending(id)) {
        await this.changed(id, origin);
      }
    }
  }

  /** Admission joins preparation and confirmation; it never silently uses the cached provider. */
  async refresh(id: string, binding: ModelUpdateBinding): Promise<void> {
    this.deps.ensure(id, binding);
    const previous = this.changes.get(id);
    if (previous?.uncertain && previous.candidate && previous.binding.engineId === binding.engineId) {
      const runtime = await this.runtime(previous);
      if (this.committed(runtime, previous)) this.confirm(id, previous, runtime.revision as number);
    }
    if (!this.deps.state.inferencePending(id)) return;
    this.begin(id, binding);
    await this.work(id);
    this.deps.ensure(id, binding);
    if (this.deps.state.inferencePending(id)) throw new IpcHandlerError('MODEL_STATE_UNCERTAIN', 'The engine has not confirmed the latest model selection');
  }

  private begin(id: string, binding: ModelUpdateBinding, force = false, origin?: ModelUpdateOrigin): Change {
    const prior = this.changes.get(id), preferenceRevision = this.deps.state.modelPreferenceRevision(id);
    if (!force && prior && !prior.failed && prior.preferenceRevision === preferenceRevision
      && prior.binding.engineId === binding.engineId && prior.binding.client === binding.client) return prior;
    if (prior && !prior.publishing) prior.controller.abort(new IpcHandlerError('MODEL_PREFERENCES_CHANGED', 'A newer model selection replaced this preparation'));
    const change: Change = { id: randomUUID(), binding, preferenceRevision, deadline: this.now() + 75_000,
      controller: new AbortController(), fenced: Promise.resolve(), fenceConfirmed: false, publishing: false, uncertain: false, failed: false,
      ...(origin === undefined ? {} : { origin }) };
    this.changes.set(id, change);
    this.deps.state.setInferenceUncertain(id, binding.engineId, true);
    // Only fence installation is serialized. A slow provider preparation cannot delay a newer fence.
    change.fenced = (prior?.fenced.catch(() => {}) ?? Promise.resolve()).then(async () => {
      if (this.changes.get(id) !== change) return;
      this.deps.ensure(id, binding);
      for (let attempt = 0; attempt < 3; attempt++) {
        const runtime = await this.runtime(change);
        change.expectedRevision = runtime.revision as number;
        try {
          const ack = object(await binding.client.requestWithTimeout('session/beginModelUpdate', {
            sessionId: binding.engineId, changeId: change.id, expectedRevision: change.expectedRevision,
          }, 15_000));
          if (ack?.changeId !== change.id || ack.revision !== change.expectedRevision) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid model fence acknowledgement');
        } catch (error) {
          if (conflict(error) && attempt < 2) continue;
          if (object(error)?.kind === 'server') throw error;
          // A lost begin ACK is safe only when the engine proves ownership of this exact fence.
          const actual = await this.runtime(change).catch(() => undefined);
          if (actual?.pendingChangeId !== change.id || actual.modelUpdateError || actual.revision !== change.expectedRevision) throw error;
        }
        this.deps.ensure(id, binding);
        change.fenceConfirmed = true;
        if (this.changes.get(id) === change) this.push(id, change, 'preparing');
        return;
      }
    }).catch(error => {
      change.failed = true;
      if (sessionClosed(error)) {
        change.uncertain = false;
        if (this.changes.get(id) === change) this.changes.delete(id);
        throw error instanceof IpcHandlerError ? error : new IpcHandlerError('SESSION_UNAVAILABLE', messageOf(error));
      }
      change.uncertain = object(error)?.kind !== 'server';
      if (this.changes.get(id) === change) {
        this.deps.state.setInferenceUncertain(id, binding.engineId, change.uncertain);
        this.push(id, change, 'failed', undefined, messageOf(error));
      }
      throw new IpcHandlerError('MODEL_RECONFIGURE_FAILED', messageOf(error));
    });
    return change;
  }

  private work(id: string): Promise<void> {
    const running = this.workers.get(id);
    if (running) return running;
    const pending = this.drain(id);
    this.workers.set(id, pending);
    void pending.finally(() => {
      if (this.workers.get(id) === pending) this.workers.delete(id);
      const latest = this.changes.get(id);
      if (latest && latest !== this.lastRunChange.get(id) && !latest.failed && this.deps.state.inferencePending(id)) void this.work(id).catch(() => {});
    }).catch(() => {});
    return pending;
  }

  private async drain(id: string): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const change = this.changes.get(id);
      if (!change) return;
      this.lastRunChange.set(id, change);
      try {
        await change.fenced;
        if (this.changes.get(id) !== change) continue;
        this.deps.ensure(id, change.binding);
        const prepare = this.deps.prepare(id, change.id, change.controller.signal);
        // Even a dependency that ignores cancellation may finish late; its unused routes are reclaimed.
        void prepare.then(() => { if (change.controller.signal.aborted && !change.publishing) this.deps.release(id, change.id); }, () => {});
        change.candidate = await this.prepared(prepare, change);
        if (this.changes.get(id) !== change || this.deps.state.modelPreferenceRevision(id) !== change.candidate.preferenceRevision) {
          this.deps.release(id, change.id);
          if (this.changes.get(id) === change) this.begin(id, change.binding, true);
          continue;
        }
        this.deps.state.recordInferenceCandidate(id, change.binding.engineId, change.id, change.candidate.init, change.candidate.provider);
        this.deps.ensure(id, change.binding);
        change.publishing = true;
        change.uncertain = true;
        let result: Record<string, Json> | undefined;
        try {
          result = object(await change.binding.client.requestWithTimeout('session/reconfigureModel', {
            sessionId: change.binding.engineId, changeId: change.id,
            expectedRevision: change.expectedRevision!, init: change.candidate.init,
          }, Math.max(1, change.deadline - this.now())));
          if (!this.committed(result, change)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid model publication acknowledgement');
        } catch (error) {
          const runtime = await this.runtime(change).catch(() => undefined);
          if (this.committed(runtime, change)) result = runtime;
          else {
            if (object(error)?.kind === 'server') {
              change.uncertain = false;
              if (this.changes.get(id) === change) this.deps.state.setInferenceUncertain(id, change.binding.engineId, false);
              this.deps.release(id, change.id);
              this.deps.state.discardInferenceCandidate(id, change.binding.engineId, change.id);
              if (conflict(error) && this.changes.get(id) === change && attempt < 5) {
                this.begin(id, change.binding, true);
                continue;
              }
            }
            throw error;
          }
        }
        this.deps.ensure(id, change.binding);
        this.confirm(id, change, result!.revision as number);
        if (!this.deps.state.inferencePending(id)) return;
        if (this.changes.get(id) === change) this.begin(id, change.binding, true);
      } catch (error) {
        if (sessionClosed(error)) {
          if (!change.publishing) this.deps.release(id, change.id);
          change.failed = true;
          change.uncertain = false;
          if (this.changes.get(id) === change) this.changes.delete(id);
          throw error instanceof IpcHandlerError ? error : new IpcHandlerError('SESSION_UNAVAILABLE', messageOf(error));
        }
        if (!change.publishing && this.changes.get(id) === change
          && this.deps.state.modelPreferenceRevision(id) !== change.preferenceRevision) {
          this.deps.release(id, change.id);
          this.begin(id, change.binding, true);
          continue;
        }
        if (!change.publishing) this.deps.release(id, change.id);
        // Decoding can reject a publication before the engine dispatches its handler.
        // Fail only a known, uncommitted fence; an unknown publish must remain intact.
        if ((!change.publishing || !change.uncertain) && change.fenceConfirmed) void this.failFence(id, change, error);
        if (this.changes.get(id) !== change) continue;
        change.failed = true;
        this.push(id, change, 'failed', undefined, messageOf(error));
        throw error instanceof IpcHandlerError ? error : new IpcHandlerError('MODEL_RECONFIGURE_FAILED', messageOf(error));
      }
    }
    const latest = this.changes.get(id);
    if (latest && latest === this.lastRunChange.get(id)) {
      latest.failed = true;
      this.push(id, latest, 'failed', undefined, 'Model settings changed repeatedly while preparing the latest selection');
    }
    throw new IpcHandlerError('MODEL_PREFERENCES_CHANGED', 'Model settings changed repeatedly while preparing the latest selection');
  }

  private prepared(pending: Promise<ModelCandidate>, change: Change): Promise<ModelCandidate> {
    const signal = change.controller.signal;
    return new Promise((resolve, reject) => {
      const cancel = (): void => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { change.controller.abort(new IpcHandlerError('MODEL_PREPARATION_TIMEOUT', 'Model preparation timed out')); }, Math.max(1, change.deadline - this.now()));
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      void pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private async failFence(id: string, change: Change, error: unknown): Promise<void> {
    try {
      this.deps.ensure(id, change.binding);
      const ack = object(await change.binding.client.requestWithTimeout('session/failModelUpdate', {
        sessionId: change.binding.engineId, changeId: change.id, error: messageOf(error),
      }, 15_000));
      if (ack?.changeId !== change.id || !validRevision(ack.revision)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine did not acknowledge the failed model preparation');
    } catch {
      const runtime = await this.runtime(change).catch(() => undefined);
      if (runtime?.pendingChangeId !== change.id || !runtime.modelUpdateError) change.uncertain = true;
    }
  }

  private async runtime(change: Change): Promise<Record<string, Json>> {
    const runtime = object(await change.binding.client.requestWithTimeout('session/modelRuntime', { sessionId: change.binding.engineId }, 15_000));
    if (!runtime || !validRevision(runtime.revision)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned no model revision');
    return runtime;
  }
  private committed(runtime: Record<string, Json> | undefined, change: Change): boolean {
    return !!runtime && runtime.changeId === change.id && validRevision(runtime.revision)
      && runtime.revision === (change.expectedRevision ?? -1) + 1;
  }
  private confirm(id: string, change: Change, revision: number): void {
    const candidate = change.candidate;
    if (!candidate) throw new IpcHandlerError('MODEL_STATE_UNCERTAIN', 'The published model has no captured host identity');
    this.deps.state.confirmInferenceCandidate(id, change.binding.engineId, change.id, revision);
    if (!this.deps.state.updateInference(id, change.binding.engineId, candidate.init, candidate.provider, candidate.preferenceRevision)) {
      throw new IpcHandlerError('SESSION_UNAVAILABLE', 'The conversation closed while its model changed');
    }
    change.uncertain = false;
    if (this.changes.get(id) === change) this.push(id, change, 'ready', revision);
    else this.deps.state.setInferenceUncertain(id, change.binding.engineId, true);
  }
  private push(id: string, change: Change, status: string, revision?: number, error?: string): void {
    this.deps.push([{ type: 'model_update', sessionId: id, status, changeId: change.id, preferenceRevision: change.preferenceRevision,
      ...(revision === undefined ? {} : { revision }), ...(error === undefined ? {} : { error }),
      // Only a sign-out-driven failure is quiet: the user removed the credential
      // on purpose, so its expected preparation failure is not a model error.
      // A later user selection starts a fresh change without the origin and
      // announces its failures as before.
      ...(status === 'failed' && change.origin === 'signed-out' ? { quiet: true } : {}) }]);
  }
}
