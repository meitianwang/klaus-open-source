import { IpcHandlerError } from '../../ipc/registry';
import type { Json } from '../../ipc/contract';
import type { SessionService } from '../../sessions/service';
import { object, string, type JsonObject } from '../service-types';
import { channelDefinition } from './types';
import type { ChannelTurnInput } from './service';

type Sessions = Pick<SessionService, 'channelThread' | 'newSession' | 'setArchived' | 'sendAndWait'>;
export interface ChannelTurnsDeps {
  sessions: Sessions;
  changed?(row: JsonObject): void;
}

/** Maps an external conversation to an engine-owned, portable thread identity. */
export class ChannelTurns {
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, Promise<{ reply: string | null }>>();
  private readonly contexts = new Map<string, JsonObject>();
  private closing?: Promise<void>;
  constructor(private readonly deps: ChannelTurnsDeps) {}
  contextFor(id: string): JsonObject | undefined { const context = this.contexts.get(id); return context ? { ...context } : undefined; }
  run(input: ChannelTurnInput, signal: AbortSignal): Promise<{ reply: string | null }> {
    const source = string(input.channelContext.channelId), definition = channelDefinition(source);
    if (!definition || !input.sessionKey.startsWith(source + ':') || input.sessionKey.length > 2048) return Promise.reject(new IpcHandlerError('BAD_REQUEST', 'Invalid messaging conversation identity'));
    if (this.controller.signal.aborted || signal.aborted) return Promise.reject(new IpcHandlerError('ABORTED', 'The messaging channel is closing'));
    if (this.pending.has(input.sessionKey)) return Promise.reject(new IpcHandlerError('TURN_IN_PROGRESS', 'A messaging turn already owns this conversation'));
    if (this.pending.size >= 64) return Promise.reject(new IpcHandlerError('TOO_MANY_REQUESTS', 'Too many messaging conversations are active'));
    const combined = AbortSignal.any([this.controller.signal, signal]);
    const task = Promise.resolve().then(async () => {
      let row = await this.deps.sessions.channelThread(input.sessionKey);
      combined.throwIfAborted();
      if (!row) {
        const context = input.channelContext;
        const binding = { sourceSessionKey: input.sessionKey, channelId: source, accountId: 'default', targetId: string(context.targetId), chatType: string(context.chatType),
          ...(typeof context.threadId === 'string' ? { threadId: context.threadId } : {}) };
        row = object(await this.deps.sessions.newSession({ title: `${definition.name} · ${string(context.senderLabel) || string(context.targetId)}`.slice(0, 300),
          hostMetadata: { threadSource: 'channel', channel: binding } }));
        combined.throwIfAborted();
        this.deps.changed?.(row);
      } else if (row.archived === true) {
        const restored = object(await this.deps.sessions.setArchived(string(row.id), false));
        if (restored.ok !== true) throw new Error('The archived messaging conversation could not be restored');
        combined.throwIfAborted(); this.deps.changed?.(row);
      }
      const id = string(row.id);
      if (!id) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine did not return a messaging conversation identity');
      const context: JsonObject = { ...input.channelContext, sourceSessionKey: input.sessionKey };
      if (this.contexts.has(id)) throw new IpcHandlerError('TURN_IN_PROGRESS', 'Another messaging source is using this conversation');
      this.contexts.set(id, context);
      try {
        return await this.deps.sessions.sendAndWait(id, { text: input.text, ...(input.media === undefined ? {} : { media: input.media as Json }) }, combined);
      } finally { if (this.contexts.get(id) === context) this.contexts.delete(id); }
    });
    this.pending.set(input.sessionKey, task);
    void task.finally(() => { if (this.pending.get(input.sessionKey) === task) this.pending.delete(input.sessionKey); }).catch(() => {});
    return task;
  }
  close(): Promise<void> {
    this.controller.abort(new Error('The application is shutting down'));
    return this.closing ??= Promise.allSettled([...this.pending.values()]).then(() => {});
  }
}
