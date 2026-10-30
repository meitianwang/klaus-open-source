import type { ClientEvent } from '../engine/protocol';
import type { Json } from '../ipc/contract';
import { object, string, errorMessage, type JsonObject } from '../services/service-types';
import { toolText } from '../services/cron-tools';

type Handler = (args: Json, sessionId: string, signal: AbortSignal, callId: string, turnId: string) => Json | Promise<Json>;
export interface DynamicToolOptions {
  timeoutMs?: number;
}
interface Pending { controller: AbortController; work: Promise<void>; sessionId: string; turnId: string; retired: boolean }

/** Every dynamic call receives one bounded outcome, including failures and cancellation. */
export class DynamicTools {
  private readonly tools = new Map<string, { spec: Json; handler: Handler; options: DynamicToolOptions }>();
  private readonly pending = new Map<string, Pending>();
  private readonly completed = new Set<string>();
  private closed = false;
  private generation?: number;
  private revision = 0;
  private closePromise?: Promise<void>;
  constructor(private readonly deps: {
    request(method: string, params: JsonObject): Promise<unknown>;
    knownSession(engineId: string): boolean;
    log(message: string): void;
  }) {}
  register(spec: Json, handler: Handler, options: DynamicToolOptions = {}): void {
    const name = string(object(spec).name);
    if (!name || this.tools.has(name)) throw new Error(`Invalid or duplicate dynamic tool: ${name}`);
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 4_200_000)) throw new Error('Invalid dynamic tool timeout');
    this.tools.set(name, { spec, handler, options });
  }
  definitions(): Json[] { return [...this.tools.values()].map(tool => tool.spec); }
  receive(event: ClientEvent, generation = 0): void {
    if (this.closed) return;
    if (this.generation !== generation) { this.invalidate(); this.generation = generation; }
    if (event.type === 'streamClosed') {
      this.invalidate();
      return;
    }
    if (event.type === 'turnCompleted' || event.type === 'threadDeleted' || event.type === 'productEvent' && event.method === 'turn/failed') {
      const params = object(event.params), sessionId = string(params.sessionId), turnId = string(params.turnId ?? params.submissionId);
      for (const pending of this.pending.values()) {
        if (pending.sessionId !== sessionId || event.type !== 'threadDeleted' && (!turnId || pending.turnId !== turnId)) continue;
        pending.retired = true; pending.controller.abort();
      }
      return;
    }
    if (!['rawSessionEvent', 'sessionEvent', 'engineEvent'].includes(event.type) || !('params' in event)) return;
    const params = object(event.params), envelope = object(params.event ?? params), call = object(envelope.dynamicToolCall);
    const callId = string(call.callId), sessionId = string(params.sessionId);
    if (!callId || !sessionId || !this.deps.knownSession(sessionId)) return;
    const turnId = string(call.turnId ?? envelope.submissionId);
    const revision = this.revision, key = `${revision}\0${sessionId}\0${turnId}\0${callId}`;
    if (this.pending.has(key) || this.completed.has(key)) return;
    const controller = new AbortController();
    const pending: Pending = { controller, work: Promise.resolve(), sessionId, turnId, retired: false };
    const work = this.execute(call, sessionId, controller, revision, pending).finally(() => {
      this.pending.delete(key);
      if (revision === this.revision) this.completed.add(key);
      if (this.completed.size > 4096) this.completed.delete(this.completed.values().next().value!);
    });
    pending.work = work; this.pending.set(key, pending);
    void work.catch(error => this.deps.log(`dynamic call ${callId}: ${errorMessage(error)}`));
  }
  private invalidate(): void {
    this.revision++;
    for (const entry of this.pending.values()) entry.controller.abort();
    this.completed.clear();
  }
  private async execute(call: JsonObject, sessionId: string, controller: AbortController, revision: number, pending: Pending): Promise<void> {
    const name = string(call.tool), tool = this.tools.get(name);
    let response: Json, handlerWork: Promise<Json> | undefined;
    if (this.closed || this.pending.size >= 64) response = toolText('The host cannot accept more dynamic calls.', false);
    else if (string(call.namespace)) response = toolText('This dynamic tool namespace is unsupported.', false);
    else if (!tool) response = toolText(`Unknown host tool: ${name}`, false);
    else {
      let cancel!: () => void;
      const aborted = new Promise<Json>(resolve => { cancel = () => resolve(toolText('The host tool was cancelled or timed out.', false)); });
      controller.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), tool.options.timeoutMs ?? 120_000);
      try {
        handlerWork = Promise.resolve().then(() => {
          if (controller.signal.aborted) return toolText('The host tool was cancelled before it started.', false);
          return tool.handler(call.arguments ?? {}, sessionId, controller.signal, string(call.callId), pending.turnId);
        });
        response = await Promise.race([handlerWork, aborted]);
      }
      catch (error) { response = toolText(errorMessage(error), false); }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', cancel); }
    }
    try {
      if (!pending.retired && revision === this.revision && this.deps.knownSession(sessionId)) {
        await this.deps.request('session/resolveDynamicToolCall', { sessionId, callId: string(call.callId), response });
      }
    } finally {
      // An early cancellation outcome does not prove that the underlying work
      // stopped. Retain ownership until its actual cleanup has finished.
      await handlerWork?.catch(() => undefined);
    }
  }
  close(deadlineMs = 15_000): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const pending = [...this.pending.values()];
    for (const entry of pending) entry.controller.abort();
    this.closePromise = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const outcomes = await Promise.race([
          Promise.allSettled(pending.map(entry => entry.work)),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Host tools did not drain before the shutdown deadline: ${this.pending.size} pending`)), deadlineMs); }),
        ]);
        const errors = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Host tool outcomes did not finish closing');
      } finally { if (timer) clearTimeout(timer); }
    })();
    return this.closePromise;
  }
}
