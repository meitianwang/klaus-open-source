import { createHash } from 'node:crypto';
import type { Json, RpcError } from './protocol';

export type RpcPriority = 'critical' | 'interactive' | 'background';
export type RpcSource = 'thread_catalog' | 'thread' | 'other';
export interface RpcRequestOptions {
  priority?: RpcPriority;
  source?: RpcSource;
  conversationId?: string;
  signal?: AbortSignal;
  onQueued?: (promote: (priority: RpcPriority) => boolean) => void;
}

interface Admission extends RpcRequestOptions {
  method: string;
  timeoutMs?: number;
  coalesceKey?: string;
  bytes?: number;
}
interface Waiter {
  finish(value: Json, error?: RpcError): void;
}
interface Job {
  method: string;
  priority: RpcPriority;
  source: RpcSource;
  conversationId: string;
  coalesceKey?: string;
  bytes: number;
  controller: AbortController;
  waiters: Set<Waiter>;
  startedAt?: number;
  run(signal: AbortSignal): Promise<Json>;
}

export interface RpcRequestDiagnostic {
  method: string;
  conversationId: string;
  priority: RpcPriority;
  elapsedMs: number;
  queueMs: number;
  responseMs: number;
  deadlineOverrunMs?: number;
  outcome: 'ok' | RpcError['kind'];
  code?: number;
  timeoutMs?: number;
}

const priorities: RpcPriority[] = ['critical', 'interactive', 'background'];
const cancelled = (): RpcError => ({ kind: 'server', code: -32800, message: 'The app-server request was cancelled' });
const overloaded = (): RpcError => ({ kind: 'server', code: -32000, message: 'The app-server request queue is full; retry later' });

/**
 * A shared connection budget with reserved interactive and turn-control capacity.
 * Queues rotate by conversation, so a catalog or a busy thread cannot fill every
 * admission slot. Deadlines include queue time; cancellation is per consumer of a
 * coalesced read and only the last consumer cancels the underlying operation.
 */
export class RpcRequestScheduler {
  private readonly queued: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly coalesced = new Map<string, Job>();
  private readonly lastStarted = new Map<string, number>();
  private sequence = 0;
  private consumers = 0;
  private noncriticalConsumers = 0;
  private closed = false;

  constructor(private readonly diagnostic?: (record: RpcRequestDiagnostic) => void,
    private readonly now: () => number = () => performance.now()) {}

  private promoteJob(job: Job, priority: RpcPriority): void {
    if (priorities.indexOf(priority) >= priorities.indexOf(job.priority)) return;
    const previousKey = this.key(job);
    job.priority = priority;
    this.forgetUnusedKey(previousKey);
  }

  schedule(admission: Admission, run: (signal: AbortSignal) => Promise<Json>): Promise<Json> {
    if (this.closed) return Promise.reject({ kind: 'closed' } satisfies RpcError);
    if (admission.signal?.aborted) return Promise.reject(cancelled());
    const priority = admission.priority ?? 'interactive';
    let job = admission.coalesceKey ? this.coalesced.get(admission.coalesceKey) : undefined;
    const retained = [...this.queued, ...this.running], bytes = admission.bytes ?? 0;
    if (this.consumers >= 2048 || (priority !== 'critical' && this.noncriticalConsumers >= 1792)
      || (!job && (this.queued.length >= 512
      || retained.reduce((total, value) => total + value.bytes, bytes) > 128 * 1024 * 1024
      || (priority !== 'critical' && (this.queued.filter(value => value.priority !== 'critical').length >= 448
        || retained.filter(value => value.priority !== 'critical').reduce((total, value) => total + value.bytes, bytes) > 96 * 1024 * 1024))))) {
      return Promise.reject(overloaded());
    }
    if (!job) {
      job = {
        method: admission.method, priority, source: admission.source ?? 'other',
        conversationId: admission.conversationId ?? '', coalesceKey: admission.coalesceKey, bytes,
        controller: new AbortController(), waiters: new Set(), run,
      };
      this.queued.push(job);
      if (job.coalesceKey) this.coalesced.set(job.coalesceKey, job);
    } else if (priorities.indexOf(priority) < priorities.indexOf(job.priority)) {
      // A user opening a thread promotes an already queued background read.
      this.promoteJob(job, priority);
    }
    const target = job;
    const requestedAt = this.now();
    this.consumers++;
    if (priority !== 'critical') this.noncriticalConsumers++;
    const result = new Promise<Json>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const abort = () => waiter.finish(undefined, cancelled());
      const waiter: Waiter = { finish: (value, error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        admission.signal?.removeEventListener('abort', abort);
        target.waiters.delete(waiter);
        this.consumers--;
        if (priority !== 'critical') this.noncriticalConsumers--;
        const elapsedMs = Math.max(0, this.now() - requestedAt);
        if (this.diagnostic && (error || elapsedMs >= 1000 || admission.method.startsWith('cursor/') || admission.method === 'model/selection/resolve')) {
          const queueMs = Math.min(elapsedMs, Math.max(0, (target.startedAt ?? this.now()) - requestedAt));
          // Diagnostics must never affect settlement, and never include request payloads.
          try { this.diagnostic({ method: admission.method, conversationId: target.conversationId, priority: target.priority,
            elapsedMs, queueMs, responseMs: elapsedMs - queueMs, outcome: error?.kind ?? 'ok', timeoutMs: admission.timeoutMs,
            ...(error?.kind === 'server' ? { code: error.code } : {}),
            ...(error?.kind === 'timeout' && admission.timeoutMs !== undefined
              ? { deadlineOverrunMs: Math.max(0, elapsedMs - admission.timeoutMs) } : {}),
          }); } catch { /* A diagnostic sink cannot break an engine request. */ }
        }
        if (error) reject(error); else resolve(value);
        if (!target.waiters.size) {
          this.forget(target);
          target.controller.abort();
          this.drain();
        }
      } };
      target.waiters.add(waiter);
      admission.signal?.addEventListener('abort', abort, { once: true });
      if (admission.timeoutMs !== undefined) {
        timer = setTimeout(() => waiter.finish(undefined, { kind: 'timeout', method: admission.method }), admission.timeoutMs);
      }
    });
    if (target.coalesceKey) admission.onQueued?.(priority => {
      if (this.closed || this.coalesced.get(target.coalesceKey!) !== target) return false;
      this.promoteJob(target, priority);
      this.drain();
      return true;
    });
    this.drain();
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of [...this.queued, ...this.running]) {
      for (const waiter of [...job.waiters]) waiter.finish(undefined, { kind: 'closed' });
    }
    this.queued.length = 0;
    this.running.clear();
    this.coalesced.clear();
    this.lastStarted.clear();
  }

  stats(): { queued: number; running: number; consumers: number } {
    return { queued: this.queued.length, running: this.running.size, consumers: this.consumers };
  }

  private key(job: Job): string { return `${job.priority}\0${job.conversationId}`; }
  private forget(job: Job): void {
    const index = this.queued.indexOf(job);
    if (index !== -1) this.queued.splice(index, 1);
    this.running.delete(job);
    if (job.coalesceKey && this.coalesced.get(job.coalesceKey) === job) this.coalesced.delete(job.coalesceKey);
    this.forgetUnusedKey(this.key(job));
  }

  private forgetUnusedKey(key: string): void {
    if (![...this.queued, ...this.running].some(other => this.key(other) === key)) this.lastStarted.delete(key);
  }

  private canRun(job: Job): boolean {
    const active = [...this.running];
    if (active.length >= 6) return false;
    // A reconfiguration storm publishes one critical update per live
    // conversation; uncapped it fills every admission slot and the interactive
    // reads that paint the composer queue behind it (measured: 1.6s of pure
    // queue wait on the model catalog read). Reserve one slot for ordinary
    // traffic by capping critical work below the total budget.
    if (job.priority === 'critical') return active.filter(value => value.priority === 'critical').length < 4;

    if (active.filter(value => value.priority !== 'critical').length >= 5) return false;
    if (job.priority === 'interactive') return true;
    const background = active.filter(value => value.priority === 'background');
    if (background.length >= 4) return false;
    if (job.source === 'thread' && background.filter(value => value.source === 'thread').length >= 2) return false;
    if (job.source === 'thread_catalog' && background.some(value => value.source === 'thread_catalog')) return false;
    return true;
  }

  private drain(): void {
    if (this.closed) return;
    for (;;) {
      let next: Job | undefined;
      for (const priority of priorities) {
        const eligible = this.queued.filter(job => job.priority === priority && this.canRun(job));
        next = eligible.reduce<Job | undefined>((best, job) => !best
          || (this.lastStarted.get(this.key(job)) ?? 0) < (this.lastStarted.get(this.key(best)) ?? 0) ? job : best, undefined);
        if (next) break;
      }
      if (!next) return;
      const job = next;
      this.queued.splice(this.queued.indexOf(job), 1);
      this.running.add(job);
      job.startedAt = this.now();
      this.lastStarted.set(this.key(job), ++this.sequence);
      // Invoke synchronously to retain registration-before-write and wire ordering.
      let pending: Promise<Json>;
      try { pending = job.run(job.controller.signal); }
      catch (error) { pending = Promise.reject(error); }
      void pending.then(value => this.complete(job, value), error => this.complete(job, undefined, error as RpcError));
    }
  }

  private complete(job: Job, value: Json, error?: RpcError): void {
    this.forget(job);
    for (const waiter of [...job.waiters]) waiter.finish(value, error);
    this.drain();
  }
}

// Keep mutations out of coalescing by construction. A new facade method is not
// read-only just because its name happens to begin with "read" or "get".
const coalescibleReads = new Set([
  'engine/listSessions', 'engine/readSessionSummary', 'session/history',
  'engine/readThreadHistory', 'engine/readSubagentHistory',
  'session/readHistory', 'session/contextSnapshot', 'session/modelRuntime',
  'session/queueSnapshot', 'thread/queue/list', 'session/setupLifecycle', 'session/subagentLifecycle',
  'session/backgroundProcesses', 'session/taskList', 'session/taskIdentity', 'config/read',
  'model/selection/resolve', 'session/goal', 'session/readGoalObjective', 'session/collaborationMode', 'session/plans',
]);
// The picker's catalog reads: concurrent refreshes (main composer, side
// composer, send preflight) ask the same source with identical parameters, so
// they share one engine request instead of queueing as separate jobs.
const CATALOG_READ = /^(?:subscription|codex|cursor|qwenwork|qoderwork|workbuddy|antigravity|trae|kiro|kimi|bailian|minimax|zhipu|qoder)\/models$/;
const criticalMethods = new Set([
  'initialize', 'session/start', 'session/startSideTask', 'session/resumePending', 'session/resumeQueued', 'session/close',
  'turn/start', 'turn/submit', 'turn/interrupt', 'session/steer', 'session/setGoal', 'session/clearGoal',
  'thread/queue/list', 'thread/queue/add', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/reorder',
  'thread/queue/start', 'thread/queue/pause', 'thread/queue/resume', 'thread/queue/import', 'thread/queue/discard', 'thread/queue/clear',
  'session/setCollaborationMode', 'session/answerUserInput',
  'cursor/cancelOperation', 'workbuddy/cancelOperation', 'qwenwork/cancelOperation',
  'antigravity/cancelOperation', 'antigravity/loginCancel',
  'trae/cancelOperation', 'trae/loginCancel',
  'kiro/cancelOperation', 'kiro/loginCancel',
  'claude/cancelTranscription', 'codex/cancelTranscription', 'qoder/cancelTranscription', 'qoderwork/cancelTranscription', 'qwenwork/cancelTranscription',
  'session/beginModelUpdate', 'session/reconfigureModel', 'session/failModelUpdate',
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

/** Local scheduling metadata never becomes an additional engine wire surface. */
export function rpcAdmission(method: string, params: Json, timeoutMs: number | undefined, options: RpcRequestOptions = {}): Admission {
  const record = params !== null && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
  const id = record.sessionId ?? record.threadId;
  const priority = criticalMethods.has(method) ? 'critical' : options.priority ?? 'interactive';
  const coalescible = coalescibleReads.has(method) || CATALOG_READ.test(method);
  return {
    ...options, method, timeoutMs, priority,
    conversationId: options.conversationId ?? (typeof id === 'string' ? id : ''),
    ...(coalescible ? { coalesceKey: method + ':' + createHash('sha256').update(JSON.stringify(canonical(params))).digest('hex') } : {}),
  };
}
