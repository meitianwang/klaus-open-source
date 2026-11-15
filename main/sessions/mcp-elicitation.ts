import { object } from '../ipc/arguments';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { cancelledEvent, type HostState, type PendingReverse } from '../services/host-state';

type Row = Record<string, Json>;
export interface McpElicitationDependencies {
  state: HostState;
  currentGeneration(): number | undefined;
  resolve(engineSessionId: string, generation: number, requestId: string, response: Row): Promise<void>;
  present(card: Row): void;
  cancelled(event: Json): void;
  log(kind: string, message: string): void;
}

/** MCP form events use a named facade method, separate from engine reverse requests. */
export class McpElicitationPump {
  private readonly active = new Map<string, () => void>();
  private readonly seen = new Set<string>();
  constructor(private readonly deps: McpElicitationDependencies) {}
  reset(): void { for (const settle of this.active.values()) settle(); this.active.clear(); this.seen.clear(); }
  /** A host question died without a user answer: close the card it presented. */
  cancelHostQuestion(sessionId: string, requestId: string): void {
    for (const [key, finish] of this.active) {
      if (!key.endsWith(`:${requestId}`) || this.deps.state.peekPending(key)?.sessionId !== sessionId) continue;
      finish(); this.active.delete(key);
      const pending = this.deps.state.takePending(key);
      if (pending) this.deps.cancelled(cancelledEvent(false, key, sessionId));
      return;
    }
  }
  receive(engineId: string, sessionId: string, envelope: Row, generation: number): void {
    const terminal = object(envelope.mcpElicitationResolved);
    if (typeof terminal?.requestId === 'string') {
      const key = this.key(generation, engineId, terminal.requestId), finish = this.active.get(key);
      if (finish) {
        finish(); this.active.delete(key);
        const pending = this.deps.state.takePending(key);
        if (pending) {
          const base = cancelledEvent(false, key, sessionId) as Row;
          this.deps.cancelled(terminal.action === 'accept' ? { ...base, reason: 'resolved' } : base);
        }
      }
    }
    const event = object(envelope.mcpElicitation), request = object(event?.request), rawId = event?.requestId;
    if (!event || !request || typeof rawId !== 'string' || !rawId || rawId.length > 512) return;
    const key = this.key(generation, engineId, rawId);
    if (this.seen.has(key)) return;
    this.seen.add(key); if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
    const current = () => {
      if (this.deps.currentGeneration() !== generation || this.deps.state.liveSession(sessionId) !== engineId) throw new IpcHandlerError('STALE_SESSION', 'The MCP elicitation owner changed');
    };
    const resolve = async (response: Row) => { current(); await this.deps.resolve(engineId, generation, rawId, response); };
    const meta = object(request._meta), klaus = object(meta?.klaus);
    const prompt = typeof request.message === 'string' && request.message.trim() ? request.message : 'MCP server is asking for input';
    // Three wire shapes reach a card: the standard form and the arbitrary
    // JSON-schema form render typed fields; a URL flow renders an openable
    // link the user confirms or skips. Anything else is cancelled so the
    // server gets a verdict instead of hanging.
    const mode = request.mode === undefined ? 'form' : request.mode;
    const schema = object(request.requestedSchema);
    const url = typeof request.url === 'string' ? safeElicitUrl(request.url) : undefined;
    const formLike = (mode === 'form' || mode === 'openai/form') && !!schema;
    const urlFlow = mode === 'url' && url !== undefined;
    if ((!formLike && !urlFlow) || this.active.size >= 512) {
      void resolve({ action: 'cancel' }).catch(error => this.deps.log('mcp-elicitation-cancel', String(error)));
      this.deps.log('mcp-elicitation-refused', 'Unsupported form or pending interaction capacity exceeded'); return;
    }
    let status: 'open' | 'answering' | 'settled' = 'open';
    const settle = () => { status = 'settled'; };
    const answer = async (response: Row) => {
      current(); if (status !== 'open') throw new IpcHandlerError('UNKNOWN_REQUEST', 'MCP elicitation is no longer awaiting an answer');
      status = 'answering';
      try { await resolve(response); settle(); this.active.delete(key); }
      catch (error) { if (this.active.has(key)) status = 'open'; throw error; }
    };
    const card: Row = urlFlow
      ? { requestId: key, sessionId, type: 'mcp-url', serverName: event.serverName ?? '', prompt, message: prompt, url: url! }
      : { requestId: key, sessionId, type: 'mcp-elicit', serverName: event.serverName ?? '',
          prompt, message: prompt, requestedSchema: schema!,
          ...(typeof klaus?.computerUseApp === 'string' ? { computerUseApp: klaus.computerUseApp } : {}) };
    const responder: PendingReverse['request'] = {
      get outstanding() { return status !== 'settled'; },
      respond: async value => {
        const input = object(value) ?? {};
        const response: Row = input.kind === 'accept'
          ? (urlFlow ? { action: 'accept' } : { action: 'accept', content: object(input.values) ?? {} })
          : { action: 'decline' };
        if (meta) response._meta = meta;
        await answer(response);
      },
      respondError: async () => { await answer({ action: 'cancel' }); },
    };
    this.active.set(key, settle);
    this.deps.state.parkReverse({ requestId: key, sessionId, isApproval: false, elicitationKind: urlFlow ? 'mcp-url' : 'mcp-form', toolName: '', card, request: responder });
    this.deps.present(card);
  }
  private key(generation: number, engineId: string, requestId: string): string { return `${generation}:mcp:${engineId}:${requestId}`; }
}

/** A browser-openable http(s) URL without embedded credentials, normalized. */
function safeElicitUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try { url = new URL(trimmed); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  return url.toString();
}
