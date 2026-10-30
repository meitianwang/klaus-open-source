import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Json } from '../../ipc/contract';

type Row = Record<string, unknown>;
type RpcId = string | number;
const record = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const rpcId = (value: unknown): value is RpcId => typeof value === 'string' ? value.length <= 256 : typeof value === 'number' && Number.isSafeInteger(value);
const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const message = (error: unknown) => error instanceof Error ? error.message : 'The host operation failed';

export interface HostMcpCallContext {
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
  assertCurrent(): void;
  elicit(request: Row, signal: AbortSignal): Promise<unknown>;
}
export interface HostMcpServerDeps {
  name: string;
  tools(): unknown[];
  currentTurn(sessionId: string): string | undefined;
  call(name: string, args: Row, context: HostMcpCallContext): Promise<unknown>;
  enabled?(): boolean;
  operationTimeoutMs?: number;
  /** A question died without a user answer (turn ended, operation aborted): the card must close. */
  onElicitationCancelled?(sessionId: string, requestId: string): void;
  log?(event: string, detail: Row): void;
}
interface Owner {
  id: string; token: string; controller: AbortController; sessions: Map<string, Connection>; closing?: Promise<void>;
}
interface Connection {
  id: string; owner: Owner; version: string; form: boolean; initialized: boolean;
  controller: AbortController; calls: Map<RpcId, Operation>; questions: Map<string, Question>;
}
interface Operation {
  id: RpcId; turnId: string; controller: AbortController; done: Promise<void>; response: ServerResponse;
  /** The operation budget as a movable deadline: an elicitation wait pauses it. */
  deadline: number; timer?: NodeJS.Timeout; progressTimer?: NodeJS.Timeout;
  approvalWaiters?: number; pausedAt?: number;
}
interface Question { finish(error?: Error, value?: unknown): void }

/** Streamable HTTP with task-bound capabilities and request-scoped form elicitation. */
export class HostMcpServer {
  private server?: Server;
  private starting?: Promise<string>;
  private readonly owners = new Map<string, Owner>();
  private readonly tokens = new Map<string, Owner>();
  private readonly closingOwners = new Set<Promise<void>>();
  private readonly operations = new Set<Operation>();
  private closed = false;
  private stopping?: Promise<void>;
  constructor(private readonly deps: HostMcpServerDeps) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(deps.name)) throw new Error('Invalid host MCP server name');
    if (deps.operationTimeoutMs !== undefined && (!Number.isSafeInteger(deps.operationTimeoutMs) || deps.operationTimeoutMs <= 0 || deps.operationTimeoutMs > 30 * 60_000)) throw new Error('Invalid host MCP deadline');
  }
  private enabled() { return !this.closed && (this.deps.enabled?.() ?? true); }
  private trace(event: string, detail: Row): void {
    try { this.deps.log?.(event, detail); } catch { /* Diagnostics cannot interrupt the MCP protocol. */ }
  }
  private start(): Promise<string> {
    if (!this.enabled()) return Promise.reject(new Error('The host MCP server is unavailable'));
    return this.starting ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => { void this.receive(request, response).catch(error => {
        if (response.headersSent) response.destroy(); else this.send(response, 500, { error: message(error) });
      }); });
      this.server = server; server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 128;
      server.once('error', reject); server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('The MCP server did not bind loopback')); return; }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }
  async hostCapabilities(sessionId: string): Promise<Record<string, Json>> {
    if (!sessionId || sessionId.length > 256) throw new Error('Invalid host conversation identity');
    if (!this.enabled()) return { mcpServers: [], runtimeCapabilityRoots: [] };
    let owner = this.owners.get(sessionId);
    if (owner?.controller.signal.aborted) throw new Error('The previous host capability is still closing');
    if (!owner) {
      if (this.owners.size >= 256) throw new Error('Too many host MCP conversation owners');
      owner = { id: sessionId, token: randomBytes(32).toString('hex'), controller: new AbortController(), sessions: new Map() };
      this.owners.set(sessionId, owner); this.tokens.set(owner.token, owner);
    }
    const base = await this.start();
    this.valid(owner);
    return { mcpServers: [{ name: this.deps.name, transport: 'http', url: `${base}/mcp/${owner.token}?session=${encodeURIComponent(sessionId)}`, alwaysLoad: true }], runtimeCapabilityRoots: [] };
  }
  private send(response: ServerResponse, status: number, value?: unknown) {
    if (response.destroyed || response.writableEnded) return;
    response.statusCode = status; response.setHeader('Cache-Control', 'no-store');
    if (value !== undefined) response.setHeader('Content-Type', 'application/json');
    response.end(value === undefined ? undefined : JSON.stringify(value));
  }
  private frame(response: ServerResponse, value: unknown) {
    if (response.destroyed || response.writableEnded) throw new Error('The MCP response stream is disconnected');
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new Error('The MCP result exceeds the response limit');
    response.write(`event: message\ndata: ${encoded}\n\n`);
  }
  private valid(owner: Owner, connection?: Connection) {
    if (!this.enabled() || owner.controller.signal.aborted || this.owners.get(owner.id) !== owner
      || (connection && (connection.controller.signal.aborted || owner.sessions.get(connection.id) !== connection))) throw new Error('The host capability was released');
  }
  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = this.server?.address(), host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
    if (!this.enabled() || request.headers.host !== host || request.headers.origin !== undefined) { this.send(response, 403); return; }
    const url = new URL(request.url ?? '/', `http://${host}`), owner = this.tokens.get(url.pathname.slice(5));
    if (!url.pathname.startsWith('/mcp/') || !owner || owner.controller.signal.aborted || url.searchParams.get('session') !== owner.id) { this.send(response, 404); return; }
    const header = request.headers['mcp-session-id'];
    const connection = typeof header === 'string' ? owner.sessions.get(header) : undefined;
    if (header !== undefined && (!connection || connection.controller.signal.aborted)) { this.send(response, 404); return; }
    const protocol = request.headers['mcp-protocol-version'];
    if (protocol !== undefined && (typeof protocol !== 'string' || !versions.includes(protocol) || (connection && protocol !== connection.version))) { this.send(response, 400); return; }
    if (request.method === 'GET') { response.setHeader('Allow', 'POST, DELETE'); this.send(response, 405); return; }
    if (request.method === 'DELETE') {
      if (!connection) { this.send(response, 400); return; }
      try { await this.within(this.closeConnection(connection), 5000, 'The MCP connection'); this.send(response, 200, {}); }
      catch { this.send(response, 503, { error: 'The MCP connection is still closing' }); } return;
    }
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST, DELETE'); this.send(response, 405); return; }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) { this.send(response, 415); return; }
    const accept = request.headers.accept ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) { this.send(response, 406); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += part.length;
      if (bytes > 4 * 1024 * 1024) { this.send(response, 413); return; } chunks.push(part);
    }
    let body: Row | undefined;
    try { body = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { this.send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    if (!body || body.jsonrpc !== '2.0') { this.send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return; }
    try { this.valid(owner, connection); } catch { this.send(response, 404); return; }
    const params = record(body.params) ?? {}, id = body.id;
    if (body.method === 'initialize') {
      if (!rpcId(id) || connection) { this.send(response, 400); return; }
      if (owner.sessions.size >= 8) { this.send(response, 429); return; }
      const capabilities = record(params.capabilities), elicitation = record(capabilities?.elicitation);
      const version = typeof params.protocolVersion === 'string' && versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0]!;
      const created: Connection = { id: randomUUID(), owner, version, initialized: false, form: version !== '2025-03-26' && !!elicitation && (Object.keys(elicitation).length === 0 || record(elicitation.form) !== undefined),
        controller: new AbortController(), calls: new Map(), questions: new Map() };
      owner.sessions.set(created.id, created); response.setHeader('Mcp-Session-Id', created.id);
      this.trace('initialized', { sessionId: owner.id, version, form: created.form });
      this.send(response, 200, { jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: this.deps.name, version: '1.0.0' } } }); return;
    }
    if (!connection) { this.send(response, 400); return; }
    if (body.method === undefined) {
      const question = typeof id === 'string' ? connection.questions.get(id) : undefined;
      if (!question || (Object.hasOwn(body, 'result') === Object.hasOwn(body, 'error'))) { this.send(response, 400); return; }
      question.finish(body.error === undefined ? undefined : new Error('The MCP client rejected the elicitation request'), body.result);
      this.trace('elicitation-answered', { sessionId: owner.id, failed: body.error !== undefined });
      this.send(response, 202); return;
    }
    if (typeof body.method !== 'string') { this.send(response, 400); return; }
    if (id === undefined) {
      if (body.method === 'notifications/initialized') connection.initialized = true;
      if (body.method === 'notifications/cancelled' && rpcId(params.requestId)) connection.calls.get(params.requestId)?.controller.abort(new Error('The MCP client cancelled the operation'));
      this.send(response, 202); return;
    }
    if (!rpcId(id) || !connection.initialized) { this.send(response, 400); return; }
    const result = (value: unknown) => this.send(response, 200, { jsonrpc: '2.0', id, result: value });
    switch (body.method) {
      case 'ping': result({}); return;
      case 'tools/list': result({ tools: this.deps.tools() }); return;
      case 'resources/list': result({ resources: [] }); return;
      case 'resources/templates/list': result({ resourceTemplates: [] }); return;
      case 'prompts/list': result({ prompts: [] }); return;
      case 'tools/call': await this.call(connection, id, params, response); return;
      default: this.send(response, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } });
    }
  }
  private call(connection: Connection, id: RpcId, params: Row, response: ServerResponse): Promise<void> {
    const ownedCalls = [...connection.owner.sessions.values()].reduce((sum, session) => sum + session.calls.size, 0);
    if (connection.calls.has(id) || ownedCalls >= 16 || this.operations.size >= 64) { this.send(response, 429); return Promise.resolve(); }
    const turnId = this.deps.currentTurn(connection.owner.id), name = params.name;
    if (!turnId || typeof name !== 'string' || !this.deps.tools().some(tool => record(tool)?.name === name) || (params.arguments !== undefined && !record(params.arguments))) {
      this.send(response, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'A known tool and active conversation turn are required' } }); return Promise.resolve();
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); response.flushHeaders();
    const operation: Operation = { id, turnId, controller: new AbortController(), done: Promise.resolve(), response,
      deadline: Date.now() + (this.deps.operationTimeoutMs ?? 5 * 60_000) };
    const signal = AbortSignal.any([connection.owner.controller.signal, connection.controller.signal, operation.controller.signal]);
    const assertCurrent = () => {
      signal.throwIfAborted(); this.valid(connection.owner, connection);
      if (this.deps.currentTurn(connection.owner.id) !== turnId) throw new Error('The active conversation turn changed');
    };
    // Active-time budget: the timer is re-armed whenever the deadline moves
    // (an elicitation wait shifts it), so waiting for a user answer consumes
    // none of it.
    const arm = (): void => {
      if (operation.timer) clearTimeout(operation.timer);
      operation.timer = setTimeout(() => operation.controller.abort(new Error('The host MCP operation timed out')), Math.max(0, operation.deadline - Date.now()));
    };
    arm();
    connection.calls.set(id, operation);
    const token = record(params._meta)?.progressToken;
    if (rpcId(token)) {
      let reports = 0;
      // A long native hold keeps its MCP deadline alive without replaying input.
      // Approval pauses already propagate through elicitation, so remain quiet then.
      operation.progressTimer = setInterval(() => {
        if (signal.aborted || response.destroyed || response.writableEnded) {
          if (operation.progressTimer) clearInterval(operation.progressTimer); return;
        }
        if (operation.approvalWaiters) return;
        try { this.frame(response, { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++reports, message: 'The operation is still running.' } }); }
        catch { if (operation.progressTimer) clearInterval(operation.progressTimer); }
      }, Math.max(10, Math.min(30_000, (this.deps.operationTimeoutMs ?? 5 * 60_000) / 2)));
    }
    this.trace('call-started', { sessionId: connection.owner.id, turnId, tool: name });
    this.operations.add(operation);
    operation.done = Promise.resolve().then(async () => {
      try {
        assertCurrent();
        const value = await this.deps.call(name, record(params.arguments) ?? {}, { sessionId: connection.owner.id, turnId, signal, assertCurrent,
          elicit: (request, approvalSignal) => this.elicit(connection, operation, request, AbortSignal.any([signal, approvalSignal]), assertCurrent) });
        assertCurrent(); this.frame(response, { jsonrpc: '2.0', id, result: value });
      } catch (error) {
        this.trace('call-failed', { sessionId: connection.owner.id, turnId, tool: name, error: message(error) });
        if (!response.destroyed && !response.writableEnded) this.frame(response, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message(error) }] } });
      } finally {
        if (operation.timer) clearTimeout(operation.timer);
        if (operation.progressTimer) clearInterval(operation.progressTimer);
        connection.calls.delete(id);
        operation.controller.abort(new Error('The host operation finished'));
        response.end(); this.operations.delete(operation);
      }
    });
    return operation.done;
  }
  private elicit(connection: Connection, operation: Operation, request: Row, signal: AbortSignal, assertCurrent: () => void): Promise<unknown> {
    try {
      assertCurrent(); signal.throwIfAborted();
      if (!connection.form || (request.mode !== undefined && request.mode !== 'form')) throw new Error('The MCP client does not support form elicitation');
      if (connection.questions.size >= 16 || typeof request.message !== 'string' || !record(request.requestedSchema)) throw new Error('Invalid or excessive elicitation requests');
    } catch (error) { return Promise.reject(error); }
    const id = `host-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const abort = () => finish(new Error('The host elicitation was cancelled'));
      // No wall clock of its own: the wait is bounded by the enclosing
      // operation's active-time budget, which pauses here.
      if (!operation.approvalWaiters) {
        operation.pausedAt = Date.now();
        if (operation.timer) { clearTimeout(operation.timer); operation.timer = undefined; }
      }
      operation.approvalWaiters = (operation.approvalWaiters ?? 0) + 1;
      const finish = (error?: Error, value?: unknown) => {
        if (!connection.questions.delete(id)) return;
        // Resume the operation budget, shifted by the paused duration. A
        // question that outlives its operation must not re-arm a timer nobody
        // will clear.
        operation.approvalWaiters = Math.max(0, (operation.approvalWaiters ?? 1) - 1);
        if (connection.calls.get(operation.id) === operation && operation.approvalWaiters === 0) {
          operation.deadline += Date.now() - (operation.pausedAt ?? Date.now()); operation.pausedAt = undefined;
          if (operation.timer) clearTimeout(operation.timer);
          operation.timer = setTimeout(() => operation.controller.abort(new Error('The host MCP operation timed out')), Math.max(0, operation.deadline - Date.now()));
        }
        signal.removeEventListener('abort', abort);
        if (error) {
          try { this.frame(operation.response, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: error.message } }); } catch { /* The client may have disconnected. */ }
          try { this.deps.onElicitationCancelled?.(connection.owner.id, id); } catch { /* Diagnostics cannot interrupt the MCP protocol. */ }
          reject(error);
        } else {
          try { assertCurrent(); signal.throwIfAborted(); resolve(value); } catch (error) { reject(error); }
        }
      };
      connection.questions.set(id, { finish }); signal.addEventListener('abort', abort, { once: true });
      try {
        this.frame(operation.response, { jsonrpc: '2.0', id, method: 'elicitation/create', params: request });
        this.trace('elicitation-requested', { sessionId: connection.owner.id, turnId: operation.turnId });
      }
      catch (error) { finish(new Error(message(error))); }
    });
  }
  cancelTurn(sessionId: string, turnId: string): void {
    const owner = this.owners.get(sessionId); if (!owner) return;
    for (const connection of owner.sessions.values()) for (const call of connection.calls.values()) if (call.turnId === turnId) call.controller.abort(new Error('The conversation turn ended'));
  }
  private async closeConnection(connection: Connection): Promise<void> {
    connection.controller.abort(new Error('The MCP connection closed'));
    await Promise.allSettled([...connection.calls.values()].map(call => call.done));
    connection.owner.sessions.delete(connection.id);
  }
  private within(task: Promise<void>, deadlineMs: number, label: string): Promise<void> {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0 || deadlineMs > 30_000) return Promise.reject(new Error('Invalid host MCP shutdown deadline'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} did not finish closing before the deadline`)), deadlineMs);
      void task.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  releaseSession(sessionId: string, deadlineMs = 5000): Promise<void> {
    const owner = this.owners.get(sessionId); if (!owner) return Promise.resolve();
    if (owner.closing) return this.within(owner.closing, deadlineMs, 'The host MCP conversation');
    owner.controller.abort(new Error('The conversation closed')); this.tokens.delete(owner.token);
    owner.closing = Promise.all([...owner.sessions.values()].map(connection => this.closeConnection(connection))).then(() => {
      if (this.owners.get(sessionId) === owner) this.owners.delete(sessionId);
    });
    this.closingOwners.add(owner.closing);
    void owner.closing.finally(() => this.closingOwners.delete(owner.closing!)).catch(() => {});
    return this.within(owner.closing, deadlineMs, 'The host MCP conversation');
  }
  shutdown(deadlineMs = 5000): Promise<void> {
    if (this.stopping) return this.within(this.stopping, deadlineMs, 'The host MCP server');
    this.closed = true;
    const closeOwners = [...this.owners.keys()].map(id => this.releaseSession(id, deadlineMs));
    this.stopping = (async () => {
      // A caller deadline does not erase the underlying accepted operations.
      await Promise.allSettled(closeOwners);
      await Promise.allSettled([...this.closingOwners]);
      await this.starting?.catch(() => {});
      if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())); this.server = undefined; }
    })();
    return this.within(this.stopping, deadlineMs, 'The host MCP server');
  }
  counts() { return { owners: this.owners.size, connections: [...this.owners.values()].reduce((n, owner) => n + owner.sessions.size, 0), operations: this.operations.size,
    questions: [...this.owners.values()].reduce((n, owner) => n + [...owner.sessions.values()].reduce((m, connection) => m + connection.questions.size, 0), 0) }; }
}
