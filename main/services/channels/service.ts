import { managedPath, readDocument } from '../extensions/file-store';
import { SerialMutations, errorMessage, object, string, type JsonObject } from '../service-types';
import { ChannelActivityLog, channelPreview } from './activity';
import { permitsChannelMessage } from './access-policy';
import { RecentChannelMessages } from './recent-messages';
import { ChannelSettingsStore, validateChannelConfiguration } from './settings-store';
import { CHANNEL_DEFINITIONS, channelDefinition, channelDelay, type ChannelAdapter, type ChannelAdapterFactory, type ChannelId, type ChannelInbound, type ChannelOutcome, type ChannelSend } from './types';

export interface ChannelTurnInput { sessionKey: string; text: string; media?: ChannelInbound['media']; channelContext: JsonObject }
export interface ChannelInboundLimits { pendingTurns: number; turnsPerSession: number; sessions: number }
const DEFAULT_INBOUND_LIMITS: ChannelInboundLimits = { pendingTurns: 256, turnsPerSession: 32, sessions: 64 };
export interface ChannelServiceDeps {
  configRoot: string;
  factories: Partial<Record<ChannelId, ChannelAdapterFactory>>;
  runTurn: (input: ChannelTurnInput, signal: AbortSignal) => Promise<{ reply?: string | null }>;
  store?: ChannelSettingsStore; now?: () => number;
  onChanged?: () => void | Promise<void>;
  onFailure?: (channelId: string, label: string, error: string) => void | Promise<void>;
  beforeDisconnect?: (id: ChannelId) => void | Promise<void>;
  inboundLimits?: Partial<ChannelInboundLimits>;
  backoffMs?: readonly number[];
}
interface Runtime {
  id: ChannelId; controller: AbortController; task: Promise<void>;
  port?: ChannelAdapter; status: JsonObject;
}
interface TurnContext { value: JsonObject; manuallySent: boolean }
const enabled = (value: string | undefined): boolean => value === '1' || value === 'true';

/** One host-owned supervisor. Each platform supplies a narrow transport factory. */
export class ChannelService {
  private readonly store: ChannelSettingsStore;
  private readonly log: ChannelActivityLog;
  private readonly controller = new AbortController();
  private readonly runtimes = new Map<ChannelId, Runtime>();
  private readonly mutations = new Map<string, SerialMutations>();
  private readonly intents = new Map<ChannelId, AbortController>();
  private readonly turns = new Map<string, { queue: SerialMutations; pending: number }>();
  private readonly contexts = new Map<string, TurnContext>();
  private readonly seen = new RecentChannelMessages();
  private readonly limits: ChannelInboundLimits;
  private pendingTurns = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: ChannelServiceDeps) {
    if (typeof deps.runTurn !== 'function') throw new Error('Channels require the host engine turn bridge');
    this.store = deps.store ?? new ChannelSettingsStore(deps.configRoot);
    this.log = new ChannelActivityLog(deps.configRoot, deps.now);
    this.limits = { ...DEFAULT_INBOUND_LIMITS, ...deps.inboundLimits };
    if (Object.values(this.limits).some(limit => !Number.isSafeInteger(limit) || limit < 1)) throw new Error('Invalid channel inbound limits');
    if (deps.backoffMs && (!deps.backoffMs.length || deps.backoffMs.some(ms => !Number.isSafeInteger(ms) || ms < 1))) throw new Error('Invalid channel restart backoff');
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private active(signal = this.controller.signal): void { if (this.closed || signal.aborted) throw new Error('Channel operation was cancelled'); }
  private track<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Channel service is closed'));
    const pending = action(); this.pending.add(pending);
    return pending.finally(() => this.pending.delete(pending));
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    let queue = this.mutations.get(id);
    if (!queue) { queue = new SerialMutations(); this.mutations.set(id, queue); }
    return this.track(() => queue!.run(action));
  }
  list(): JsonObject[] {
    this.active();
    return CHANNEL_DEFINITIONS.map(definition => {
      const config = this.store.configuration(definition.id);
      const runtime = this.runtimes.get(definition.id), live = runtime?.port?.status();
      const status = { ...runtime?.status, ...live };
      const credentials: JsonObject = {};
      for (const field of definition.fields) if (config[field]) credentials[field] = config[field]!;
      if (definition.id === 'wechat' && config.account_id) credentials.account_id = config.account_id;
      const available = Boolean(this.deps.factories[definition.id]);
      return { id: definition.id, name: definition.name, enabled: enabled(config.enabled), connected: enabled(config.enabled) && status.connected === true,
        credentials, available, status, ...(!available ? { notice: definition.name + ' transport is not available in this build' } : {}) };
    });
  }
  private change(): Promise<void> { return Promise.resolve(this.deps.onChanged?.()); }
  private newIntent(id: ChannelId): AbortController {
    this.intents.get(id)?.abort();
    const intent = new AbortController(); this.intents.set(id, intent); return intent;
  }
  connect(payload: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const id = string(payload.id), definition = channelDefinition(id);
    if (!definition) return Promise.resolve({ ok: false, error: 'Unknown channel: ' + id });
    if (!this.deps.factories[definition.id]) return Promise.resolve({ ok: false, error: definition.name + ' transport is not available in this build' });
    try { validateChannelConfiguration(id, object(payload.config)); }
    catch (error) { return Promise.resolve({ ok: false, error: errorMessage(error) }); }
    const intent = this.newIntent(definition.id);
    const combined = signal ? AbortSignal.any([intent.signal, signal]) : intent.signal;
    return this.serial(id, async (): Promise<JsonObject> => {
      this.active(combined); let saved = false;
      try {
        this.store.saveConfiguration(id, object(payload.config)); saved = true;
        await this.replace(definition.id, combined);
        await this.change();
        return { ok: true };
      } catch (error) {
        if (saved) await this.change().catch(() => undefined);
        return { ok: false, ...(saved ? { saved: true } : {}), error: errorMessage(error) };
      }
    }).catch(error => ({ ok: false, error: errorMessage(error) })).finally(() => { if (this.intents.get(definition.id) === intent) this.intents.delete(definition.id); });
  }
  disconnect(payload: JsonObject): Promise<boolean> {
    const definition = channelDefinition(string(payload.id));
    if (!definition) return Promise.resolve(false);
    // Cancel before waiting for a queued start or active turn to release its gate.
    this.intents.get(definition.id)?.abort();
    this.runtimes.get(definition.id)?.controller.abort();
    const before = this.track(async () => { await this.deps.beforeDisconnect?.(definition.id); });
    // The service may close before the serialized operation gets to this await.
    void before.catch(() => undefined);
    return this.serial(definition.id, async () => {
      await before;
      this.active();
      this.store.disable(definition.id);
      await this.stopRuntime(definition.id);
      await this.change(); return true;
    });
  }
  restart(id: ChannelId, signal?: AbortSignal): Promise<void> {
    const intent = this.newIntent(id);
    this.runtimes.get(id)?.controller.abort();
    const combined = signal ? AbortSignal.any([intent.signal, signal]) : intent.signal;
    return this.serial(id, async () => { this.active(combined); await this.replace(id, combined); await this.change(); })
      .finally(() => { if (this.intents.get(id) === intent) this.intents.delete(id); });
  }
  startConfigured(): Promise<JsonObject[]> { return this.track(async () => {
    const results = await Promise.all(CHANNEL_DEFINITIONS.map(async definition => {
      try {
        const config = this.store.configuration(definition.id);
        if (!enabled(config.enabled)) return undefined;
        await this.restart(definition.id); return { id: definition.id, ok: true };
      }
      catch (error) { return { id: definition.id, ok: false, error: errorMessage(error) }; }
    }));
    return results.filter((row): row is Exclude<typeof row, undefined> => row !== undefined) as JsonObject[];
  }); }
  private async replace(id: ChannelId, signal?: AbortSignal): Promise<void> {
    const factory = this.deps.factories[id]; if (!factory) throw new Error(id + ' transport is not available in this build');
    await this.stopRuntime(id); this.active(signal);
    const config = this.store.configuration(id); if (!enabled(config.enabled)) throw new Error(id + ' channel is disabled');
    const runtime: Runtime = { id, controller: new AbortController(), task: Promise.resolve(), status: { channelId: id, accountId: 'default', state: 'starting', running: true, connected: false, restartCount: 0 } };
    const cancel = (): void => runtime.controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.runtimes.set(id, runtime);
    runtime.task = this.supervise(runtime, factory, resolveReady, rejectReady);
    void runtime.task.catch(() => undefined);
    try { await ready; }
    finally { signal?.removeEventListener('abort', cancel); }
  }
  private async supervise(runtime: Runtime, factory: ChannelAdapterFactory, ready: () => void, fail: (error: unknown) => void): Promise<void> {
    const signal = AbortSignal.any([this.controller.signal, runtime.controller.signal]);
    const patch = (value: JsonObject): void => { if (this.runtimes.get(runtime.id) === runtime) runtime.status = { ...runtime.status, ...value }; };
    let first = true;
    try {
      for (let attempt = 0; !signal.aborted && attempt < 10; attempt++) {
        try {
          const account = this.store.configuration(runtime.id, true);
          if (!enabled(account.enabled)) throw new Error(runtime.id + ' channel is disabled');
          patch({ state: 'starting', running: true, connected: false, restartCount: attempt, restartPending: false });
          const port = await factory(account, { configRoot: this.deps.configRoot, signal,
            inbound: (message, inboundSignal) => this.inbound(runtime, message, AbortSignal.any([signal, inboundSignal])), onStatus: patch });
          if (signal.aborted) { await port.close(); throw new Error('Channel start was cancelled'); }
          runtime.port = port;
          patch({ state: 'running', startedAt: this.now(), ...port.status() });
          if (first) { first = false; ready(); }
          await port.done;
          if (port.status().manualReconnectRequired === true) {
            patch({ state: 'stopped', manualReconnectRequired: true }); break;
          }
          if (!signal.aborted) throw new Error(string(port.status().lastError) || runtime.id + ' transport stopped unexpectedly');
        } catch (error) {
          if (first) { first = false; fail(error); }
          if (signal.aborted) break;
          const message = errorMessage(error);
          patch({ state: attempt === 9 ? 'failed' : 'restarting', connected: false, lastError: message, restartCount: attempt + 1, restartPending: attempt !== 9 });
          if (attempt === 9) {
            await this.log.record('channel_failed', runtime.id, { detail: message });
            try { await this.deps.onFailure?.(runtime.id, channelDefinition(runtime.id)!.name, message); } catch { /* The failed runtime remains inspectable. */ }
            break;
          }
        } finally {
          const port = runtime.port;
          if (port) { await port.close(); if (runtime.port === port) runtime.port = undefined; }
        }
        const backoff = this.deps.backoffMs ?? [5_000, 10_000, 30_000, 60_000, 300_000];
        await channelDelay(backoff[Math.min(attempt, backoff.length - 1)]!, signal);
      }
    } finally {
      if (first) fail(new Error('Channel start was cancelled'));
      patch({ running: false, connected: false, restartPending: false, ...(signal.aborted ? { state: 'stopped' } : {}), lastStopAt: this.now() });
    }
  }
  private async stopRuntime(id: ChannelId): Promise<void> {
    const runtime = this.runtimes.get(id); if (!runtime) return;
    runtime.controller.abort();
    if (runtime.port) await runtime.port.close();
    await runtime.task;
  }
  /**
   * Admission decision for one inbound message. A missing access file admits everything;
   * an unreadable or corrupt one denies everything, because fail-open on damaged policy
   * data would widen access silently. The distinction is reported so the activity log can
   * tell "this group is not registered" apart from "the policy file cannot be read".
   */
  private async admission(id: ChannelId, message: ChannelInbound): Promise<'admitted' | 'access_policy' | 'access_unreadable'> {
    let access: JsonObject;
    try { access = object(JSON.parse(await readDocument(await managedPath(this.deps.configRoot, 'channels/' + id + '/access.json')))); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'admitted' : 'access_unreadable'; }
    return permitsChannelMessage(id, access, message) ? 'admitted' : 'access_policy';
  }
  private inbound(runtime: Runtime, message: ChannelInbound, signal: AbortSignal): Promise<ChannelOutcome> {
    this.active(signal);
    if (!message.sessionKey.startsWith(runtime.id + ':')) return Promise.reject(new Error('Channel session key does not belong to the adapter'));
    const dedupKey = runtime.id + ':' + (message.dedupKey || message.sessionKey + ':' + (message.messageId || 'text:' + message.text)), now = this.now();
    if (this.seen.has(dedupKey, now)) return Promise.resolve({ dropped: true, reason: 'duplicate' });
    let turn = this.turns.get(message.sessionKey);
    if (this.pendingTurns >= this.limits.pendingTurns || (turn?.pending ?? 0) >= this.limits.turnsPerSession || (!turn && this.turns.size >= this.limits.sessions)) {
      return Promise.reject(new Error('Channel inbound queue capacity exceeded'));
    }
    this.seen.add(dedupKey, now);
    if (!turn) { turn = { queue: new SerialMutations(), pending: 0 }; this.turns.set(message.sessionKey, turn); }
    turn.pending++; this.pendingTurns++;
    const entry = turn;
    const pending = turn.queue.run(async () => {
      this.active(signal);
      const admitted = await this.admission(runtime.id, message);
      if (admitted !== 'admitted') {
        // Admission is the only gate that drops a message without a trace: `received` below
        // is written after it, so a bot that stopped answering one group — or every group,
        // when the access file is corrupt — left nothing to diagnose beyond a missing log
        // line. The record carries no message content, because this sender never reached
        // the engine and its text is not ours to keep.
        await this.log.record('blocked', runtime.id, { sessionKey: message.sessionKey, sender: message.senderName || message.senderId, chatType: message.chatType, reason: admitted });
        return { dropped: true, reason: 'access_policy' };
      }
      this.active(signal);
      const direct = ['private', 'direct'].includes(message.chatType);
      if (direct) this.store.claimOwner(runtime.id, message.senderId);
      const parts = message.sessionKey.split(':');
      const targetId = message.targetId || (runtime.id === 'qq' && parts[1] === 'group' ? parts[2] : parts[1]);
      const value: JsonObject = { channelId: runtime.id, accountId: 'default', sourceSessionKey: message.sessionKey,
        targetId: targetId || message.senderId, chatType: direct ? 'direct' : 'group',
        ...(message.messageId ? { messageId: message.messageId } : {}), ...(message.senderName ? { senderLabel: message.senderName } : {}), ...(message.threadId ? { threadId: message.threadId } : {}) };
      const context: TurnContext = { value, manuallySent: false }; this.contexts.set(message.sessionKey, context);
      const preview = channelPreview(message.text);
      await this.log.record('received', runtime.id, { sessionKey: message.sessionKey, sender: message.senderName || message.senderId, ...(preview ? { preview } : {}) });
      try {
        this.active(signal);
        const result = await this.deps.runTurn({ sessionKey: message.sessionKey, text: message.text, ...(message.media !== undefined ? { media: message.media } : {}), channelContext: value }, signal);
        this.active(signal);
        const reply = result.reply || null;
        const replyPreview = reply ? channelPreview(reply) : undefined;
        await this.log.record(reply ? 'replied' : 'no_reply', runtime.id, { sessionKey: message.sessionKey, ...(replyPreview ? { preview: replyPreview } : {}) });
        return { reply, manuallySent: context.manuallySent };
      } catch (error) {
        await this.log.record('error', runtime.id, { sessionKey: message.sessionKey, detail: errorMessage(error) }); throw error;
      } finally { if (this.contexts.get(message.sessionKey) === context) this.contexts.delete(message.sessionKey); }
    }).finally(() => { this.pendingTurns--; if (--entry.pending === 0 && this.turns.get(message.sessionKey) === entry) this.turns.delete(message.sessionKey); });
    this.pending.add(pending);
    return pending.finally(() => this.pending.delete(pending));
  }
  contextFor(sessionKey: string): JsonObject | undefined { const value = this.contexts.get(sessionKey)?.value; return value ? { ...value } : undefined; }
  send(id: string, params: ChannelSend & { sessionId?: string }, signal?: AbortSignal): Promise<JsonObject> {
    return this.track(async (): Promise<JsonObject> => {
      this.active(signal);
      const definition = channelDefinition(id); if (!definition) throw new Error('Unknown channel: ' + id);
      if (!enabled(this.store.configuration(id).enabled)) throw new Error(id + ' channel is disabled');
      const runtime = this.runtimes.get(definition.id), port = runtime?.port;
      if (!port || runtime.controller.signal.aborted) throw new Error(id + ' has no running adapter to send through');
      const result = await port.send(params, signal);
      if (result.ok === true && params.sessionId) {
        const context = this.contexts.get(params.sessionId);
        if (context?.value.channelId === id && context.value.targetId === params.targetId && (context.value.threadId || '') === (params.threadId || '')) context.manuallySent = true;
      }
      return result;
    }).catch(error => ({ ok: false, error: errorMessage(error) }));
  }
  deliverToBinding(binding: JsonObject, text: string, signal?: AbortSignal): Promise<boolean> {
    return this.track(async () => {
      const id = string(binding.channelId), targetId = string(binding.targetId);
      if (!id || !targetId) return false;
      const result = await this.send(id, { targetId, text, action: 'sendText', chatType: string(binding.chatType, 'direct'), ...(typeof binding.threadId === 'string' ? { threadId: binding.threadId } : {}) }, signal);
      await this.log.record(result.ok === true ? 'cron_delivered' : 'cron_failed', id, result.ok === true ? {} : { detail: errorMessage(result.error) });
      return result.ok === true;
    }).catch(() => false);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.controller.abort();
    for (const intent of this.intents.values()) intent.abort();
    for (const runtime of this.runtimes.values()) runtime.controller.abort();
    this.closing = (async () => {
      const stops = [...this.runtimes.keys()].map(id => this.stopRuntime(id));
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled(stops);
      await this.log.close(); this.contexts.clear(); this.seen.clear();
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return this.closing;
  }
}
