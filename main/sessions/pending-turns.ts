import { randomUUID } from 'node:crypto';
import type { ClientEvent } from '../engine/protocol';
import { object } from '../ipc/arguments';

export function hasPendingMainTurn(snapshot: unknown): boolean {
  const items = object(snapshot)?.items;
  return Array.isArray(items) && items.some(item => {
    const row = object(item), message = object(row?.message);
    const queueOnly = message?.triggerTurn === false || (message?.triggerTurn == null
      && message?.mode === 'task-notification' && message?.origin === 'background-task');
    return row?.state === 'pending' && !message?.agentId && !queueOnly && ['now', 'next'].includes(String(message?.priority));
  });
}

export interface PendingTurnBinding {
  sessionId: string;
  engineSessionId: string;
  generation: number;
}
export interface PendingTurnRequest extends PendingTurnBinding {
  afterSubmissionId: string;
  submissionId: string;
  signal: AbortSignal;
  assertCurrent(): void;
}
interface HeldTerminal { event: ClientEvent; binding: PendingTurnBinding }
interface Chain { count: number; stopped: boolean; controllers: Set<AbortController>; held?: HeldTerminal }
export interface PendingTurnsDeps {
  binding(engineSessionId: string, generation: number): PendingTurnBinding | undefined;
  /** Await the named facade's admission outcome, not merely its RPC ACK. */
  resume(request: PendingTurnRequest): Promise<unknown>;
  forward(event: ClientEvent, generation: number, options?: { generateTitle: boolean }): void;
  notice(sessionId: string, message: string): void;
  hasPending(sessionId: string): boolean;
}

/** A completed turn stays busy until the engine confirms whether its durable queue continues. */
export class PendingTurns {
  private readonly chains = new Map<string, Chain>();
  private readonly seen = new Set<string>();
  private readonly work = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly deps: PendingTurnsDeps, private readonly maximum = 25) {}

  /** Explicit user work begins a new bounded chain; stop remains sticky until then. */
  start(sessionId: string): void {
    this.retire(sessionId);
    if (!this.closed) this.chains.set(sessionId, { count: 0, stopped: false, controllers: new Set() });
  }
  isStopped(sessionId: string): boolean { return this.closed || this.chains.get(sessionId)?.stopped === true; }
  stop(sessionId: string): void {
    let chain = this.chains.get(sessionId);
    if (!chain) { chain = { count: 0, stopped: true, controllers: new Set() }; this.chains.set(sessionId, chain); }
    chain.stopped = true;
    for (const controller of chain.controllers) controller.abort();
    const held = chain.held; chain.held = undefined;
    if (held) this.presentStopped(held);
  }
  retire(sessionId: string): void {
    const chain = this.chains.get(sessionId);
    if (chain) { chain.stopped = true; for (const controller of chain.controllers) controller.abort(); }
    this.chains.delete(sessionId);
  }
  invalidate(): void {
    for (const id of this.chains.keys()) this.retire(id);
    this.chains.clear(); this.seen.clear();
  }

  private presentStopped({ event, binding }: HeldTerminal): void {
    const current = this.deps.binding(binding.engineSessionId, binding.generation);
    if (this.closed || current?.sessionId !== binding.sessionId || current.engineSessionId !== binding.engineSessionId || current.generation !== binding.generation) return;
    // This is the original successful terminal, not a fabricated cancellation.
    // Stopping continuation must not leave it hidden when the stop/close RPC fails.
    this.deps.forward(event, binding.generation, { generateTitle: false });
  }

  receive(event: ClientEvent, generation: number): boolean {
    if (this.closed || event.type !== 'turnCompleted') return false;
    const params = object(event.params), result = object(params?.result);
    if (result?.stopReason !== 'completed' || typeof params?.sessionId !== 'string' || typeof params.turnId !== 'string' || !params.turnId) return false;
    const binding = this.deps.binding(params.sessionId, generation);
    if (!binding) return false;
    const key = `${generation}\0${binding.sessionId}\0${params.turnId}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    let chain = this.chains.get(binding.sessionId);
    if (!chain) { chain = { count: 0, stopped: false, controllers: new Set() }; this.chains.set(binding.sessionId, chain); }
    if (chain.stopped) { this.presentStopped({ event, binding }); return true; }
    if (chain.count >= this.maximum) {
      chain.held = undefined;
      if (this.deps.hasPending(binding.sessionId)) this.deps.notice(binding.sessionId, 'Queued continuation reached its limit. The remaining messages are still queued.');
      return false;
    }
    chain.count++;
    chain.held = { event, binding };
    const controller = new AbortController(); chain.controllers.add(controller);
    const captured = chain;
    const current = (): boolean => {
      const now = this.deps.binding(binding.engineSessionId, generation);
      return !this.closed && !controller.signal.aborted && !captured.stopped && this.chains.get(binding.sessionId) === captured
        && now?.sessionId === binding.sessionId && now.engineSessionId === binding.engineSessionId && now.generation === binding.generation;
    };
    const request: PendingTurnRequest = { ...binding, afterSubmissionId: params.turnId, submissionId: randomUUID(), signal: controller.signal,
      assertCurrent: () => { if (!current()) throw new Error('The queued continuation belongs to a retired conversation'); },
    };
    const task = Promise.resolve().then(async () => {
      request.assertCurrent();
      const outcome = object(await this.deps.resume(request));
      if (!current()) return;
      if (typeof outcome?.started !== 'boolean') throw new Error('The engine returned no queue continuation outcome');
      if (!outcome.started) {
        if (captured.held?.event === event) captured.held = undefined;
        this.deps.forward(event, generation);
      }
    }).catch(() => {
      if (!current()) return;
      if (captured.held?.event === event) captured.held = undefined;
      this.deps.notice(binding.sessionId, 'Queue continuation could not be confirmed. Check queued messages before retrying.');
      this.deps.forward(event, generation);
    }).finally(() => { captured.controllers.delete(controller); this.work.delete(task); });
    this.work.add(task);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true; this.invalidate();
    await Promise.allSettled(this.work);
  }
}
