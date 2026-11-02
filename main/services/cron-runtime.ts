import { requireInterruptConfirmation } from '../sessions/turn-interrupt';
import { Cron } from 'croner';
import { presetRuntimePolicy } from '../../contracts/runtime-settings';
import type { Json } from '../ipc/contract';
import type { ClientEvent } from '../engine/protocol';
import { CRON_PERMISSION_PRESETS, CronStore } from './cron-store';
import type { CronPermissionPreset } from './cron-store';
import { object, string, errorMessage, type JsonObject, type ServicePush } from './service-types';

export function nextScheduledSlot(schedule: string, timezone: string | null | undefined, after: number): number | null {
  if (!Number.isFinite(after) || !schedule.trim()) return null;
  let zone = timezone || undefined;
  try { if (zone) new Intl.DateTimeFormat('en', { timeZone: zone }).format(); } catch { zone = undefined; }
  let cron: Cron | undefined;
  try {
    cron = new Cron(schedule, { timezone: zone, mode: '5-or-6-parts', paused: true });
    return cron.nextRun(new Date(after))?.getTime() ?? null;
  } catch { return null; } finally { cron?.stop(); }
}
interface Outcome { status: 'success' | 'failed' | 'stopped'; error: string | null }
interface Running {
  task: JsonObject; runId: number; sessionId: string; startedAt: number; trigger: string;
  bound: boolean; cancelled: boolean; terminal: boolean; softError: string | null; reply: string;
  settle(outcome: Outcome): void; outcome: Promise<Outcome>; done: Promise<void>; timer?: NodeJS.Timeout;
  ready: Promise<void>; readyResolve(): void; readyReject(error: unknown): void; interrupting?: Promise<void>;
}
export interface CronRuntimeDeps {
  store: CronStore;
  newSession(options: { title: string; runtimePolicyOverride: import('../../contracts/runtime-settings').RuntimePolicy; hostMetadata: JsonObject;
    workdir?: string | null; projectRoot?: string | null; workspaceId?: string | null }): Promise<Json>;
  send(sessionId: string, prompt: string, displayMetadata?: JsonObject): Promise<unknown>;
  interrupt(sessionId: string): Promise<unknown>;
  rendererId(engineId: string): string | undefined;
  push: ServicePush;
  log(message: string): void;
  deliver?(binding: Json, text: string): Promise<void>;
  finished?(sessionId: string): void;
  notifyOutcome?(value: { sessionId: string; taskName: string; error: string | null; reply: string; status: 'success' | 'failed'; notificationPolicy?: string }): void;
  now?: () => number;
}

/** One clock and one run per task, sharing the desktop's sole engine owner. */
export class CronRuntime {
  private readonly running = new Map<string, Running>();
  private readonly now: () => number;
  private lastTick: number;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private closePromise?: Promise<void>;
  constructor(private readonly deps: CronRuntimeDeps) { this.now = deps.now ?? Date.now; this.lastTick = this.now(); }
  start(): void {
    if (this.timer || this.closed) return;
    this.deps.store.recoverInterruptedRuns();
    this.lastTick = this.now();
    this.timer = setInterval(() => {
      try { this.tick(); } catch (error) { this.deps.log(`scheduler: ${errorMessage(error)}`); }
    }, 1000);
    this.timer.unref();
  }
  status(): JsonObject {
    return { running: [...this.running.keys()], nextRuns: Object.fromEntries(this.deps.store.listTasks().map(task => [string(task.id),
      task.enabled ? nextScheduledSlot(string(task.schedule), typeof task.timezone === 'string' ? task.timezone : null, this.now()) : null])) };
  }
  isRunSession(id: string): boolean { return [...this.running.values()].some(entry => entry.bound && entry.sessionId === id); }
  tick(): void {
    if (this.closed) return;
    const now = this.now(), from = this.lastTick;
    // Advance even when every task is busy, so missed slots do not queue a second run.
    if (now <= from) return;
    this.lastTick = now;
    for (const task of this.deps.store.listTasks()) {
      if (task.enabled !== true || this.running.has(string(task.id))) continue;
      const next = nextScheduledSlot(string(task.schedule), typeof task.timezone === 'string' ? task.timezone : null, Math.max(from, Number(task.createdAt) || from));
      if (next !== null && next <= now) this.execute(task, 'scheduled');
    }
  }
  async runNow(id: string): Promise<JsonObject> {
    let task: JsonObject | null;
    try { task = this.deps.store.getTask(id); } catch (error) { return { ok: false, error: errorMessage(error) }; }
    if (this.closed || !task || this.running.has(id)) return { ok: false, error: 'task not found or already running' };
    const entry = this.execute(task, 'manual');
    try {
      await entry.ready;
      return entry.cancelled ? { ok: false, error: 'Task startup was cancelled' } : { ok: true, sessionId: entry.sessionId };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  private execute(task: JsonObject, trigger: string): Running {
    if (this.running.size >= 32) throw new Error('Too many scheduled tasks are running');
    const taskId = string(task.id), name = string(task.name) || taskId;
    const row = this.deps.store.createRun(taskId, name, trigger);
    let settle!: (outcome: Outcome) => void;
    const outcome = new Promise<Outcome>(resolve => { settle = resolve; });
    let readyResolve!: () => void, readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => {});
    const entry: Running = { task, ...row, startedAt: this.now(), trigger, bound: false, cancelled: false,
      terminal: false, softError: null, reply: '', settle, outcome, done: Promise.resolve(), ready, readyResolve, readyReject };
    this.running.set(taskId, entry);
    const configured = Number(task.timeoutSeconds);
    const timeout = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 86400) * 1000 : 300_000;
    entry.timer = setTimeout(() => { void this.cancel(entry, { status: 'failed', error: `cron run timed out after ${timeout / 1000}s` }); }, timeout);
    entry.timer.unref();
    entry.done = this.drive(entry);
    void entry.done.catch(error => this.deps.log(`run ${row.runId}: ${errorMessage(error)}`));
    return entry;
  }
  private settle(entry: Running, outcome: Outcome): void {
    if (entry.terminal) return;
    entry.terminal = true; entry.settle(outcome);
  }
  private async cancel(entry: Running, outcome: Outcome): Promise<void> {
    if (entry.terminal) return entry.interrupting;
    entry.cancelled = true;
    this.settle(entry, outcome);
    if (entry.bound) {
      entry.interrupting = this.deps.interrupt(entry.sessionId).then(result => requireInterruptConfirmation(result)).catch(error => this.deps.log(`interrupt ${entry.sessionId}: ${errorMessage(error)}`));
      await entry.interrupting;
    }
  }
  private async drive(entry: Running): Promise<void> {
    const taskId = string(entry.task.id), taskName = string(entry.task.name) || taskId;
    const permissionPreset = entry.task.permissionPreset as CronPermissionPreset;
    if (typeof permissionPreset !== 'string' || !CRON_PERMISSION_PRESETS.includes(permissionPreset as CronPermissionPreset)) {
      throw new Error(`Scheduled task ${taskId} has an invalid permission preset: ${JSON.stringify(permissionPreset)}. Only ${CRON_PERMISSION_PRESETS.join(', ')} are allowed, or omit the field for the legacy default.`);
    }
    const workdir = typeof entry.task.workdir === 'string' && entry.task.workdir ? entry.task.workdir : null;
    const workspaceId = typeof entry.task.workspaceId === 'string' && entry.task.workspaceId ? entry.task.workspaceId : null;
    let result: Outcome;
    try {
      const row = object(await this.deps.newSession({ title: taskName, runtimePolicyOverride: presetRuntimePolicy(permissionPreset),
        ...(workspaceId ? { workspaceId } : workdir ? { workdir, projectRoot: workdir } : {}),
        hostMetadata: { threadSource: 'automation', automation: {
          taskId, taskName, runId: entry.runId, triggerType: entry.trigger,
          ...(typeof entry.task.thinking === 'string' && entry.task.thinking ? { thinking: entry.task.thinking } : {}),
          ...(typeof entry.task.model === 'string' && entry.task.model ? { model: entry.task.model } : {}),
        } } }));
      if (!string(row.id)) throw new Error('The scheduler did not receive a session identity');
      entry.sessionId = string(row.id); entry.bound = true;
      this.deps.store.bindSession(entry.runId, entry.sessionId);
      entry.readyResolve();
      if (entry.cancelled || this.closed) await this.cancel(entry, { status: 'stopped', error: null });
      // The display snapshot rides the send so the turn's user row carries its
      // scheduled-task provenance in the live frame AND in the replayed history:
      // the engine persists it as the provider-invisible metadata row, and no
      // composer exists on this path to render an optimistic bubble of its own.
      else await this.deps.send(entry.sessionId, string(entry.task.prompt), {
        origin: 'automation', taskId, taskName, runId: entry.runId, triggerType: entry.trigger,
      });
      result = await entry.outcome;
      await entry.interrupting;
    } catch (error) {
      entry.readyReject(error);
      this.settle(entry, { status: 'failed', error: errorMessage(error) });
      result = await entry.outcome;
      await entry.interrupting;
    }
    try {
      this.deps.store.finishRun(entry.runId, result.status, Math.max(0, this.now() - entry.startedAt), result.error);
      if (entry.task.deleteAfterRun === true) this.deps.store.disableTask(taskId);
      if (result.error) this.deps.push('cron:failed', { sessionId: entry.sessionId, taskId, taskName,
        detail: result.error.split('\n')[0] ?? '', soft: result.status === 'success' });
      this.deps.log(`run ${entry.runId} task=${taskId} status=${result.status}`);
      if (!this.closed && result.status !== 'stopped') this.deps.notifyOutcome?.({ sessionId: entry.sessionId, taskName, status: result.status, error: result.error, reply: entry.reply,
        notificationPolicy: typeof entry.task.notificationPolicy === 'string' ? entry.task.notificationPolicy : undefined });
      if (entry.task.channelBinding && result.status !== 'stopped') {
        const text = result.status === 'failed' ? `Scheduled task ${taskName} failed: ${result.error}` : entry.reply.trim();
        if (text && this.deps.deliver) await this.deps.deliver(entry.task.channelBinding, text);
        else if (text) this.deps.log(`run ${entry.runId}: messaging channel delivery is unavailable`);
      }
    } finally {
      if (entry.timer) clearTimeout(entry.timer);
      this.running.delete(taskId);
      if (entry.bound) this.deps.finished?.(entry.sessionId);
    }
  }
  observeChat(events: Json[]): void {
    for (const raw of events) {
      const event = object(raw), entry = [...this.running.values()].find(run => run.bound && run.sessionId === event.sessionId);
      if (!entry || entry.terminal) continue;
      if (event.type === 'api_error' && event.terminal === true) this.settle(entry, { status: 'failed', error: string(event.error) || 'Engine turn failed' });
      else if (event.type === 'auth_required') this.settle(entry, { status: 'failed', error: string(event.reason) || 'Authentication required' });
      else if (event.type === 'interrupted') this.settle(entry, { status: 'stopped', error: null });
      else if (event.type === 'done') this.settle(entry, { status: 'success', error: entry.softError });
    }
  }
  observeEngine(event: ClientEvent): void {
    if (event.type === 'streamClosed') {
      for (const entry of this.running.values()) this.settle(entry, { status: 'failed', error: 'Engine process exited mid-run' });
      return;
    }
    if (event.type !== 'productEvent' || event.method !== 'item/completed') return;
    const params = object(event.params), id = this.deps.rendererId(string(params.sessionId));
    const entry = [...this.running.values()].find(run => run.bound && run.sessionId === id);
    if (!entry || entry.terminal) return;
    const item = object(params.item), result = object(item.result);
    if (item.type === 'agent_message' && string(item.text).trim()) entry.reply = string(item.text).slice(-100_000);
    if (['tool_call', 'command_execution'].includes(string(item.type)) && (item.status === 'failed' || item.error != null
      || (typeof item.exitCode === 'number' && item.exitCode !== 0) || (typeof result.exitCode === 'number' && result.exitCode !== 0))) {
      entry.softError = `${string(item.toolName) || 'tool'}: ${string(item.error) || string(item.aggregatedOutput) || 'Tool execution failed'}`.split('\n')[0]!.slice(0, 240);
    }
  }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closed = true; if (this.timer) clearInterval(this.timer);
      const entries = [...this.running.values()];
      await Promise.all(entries.map(entry => this.cancel(entry, { status: 'stopped', error: null })));
      await Promise.all(entries.map(entry => entry.done));
    })();
  }
}
