import { shell } from 'electron';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { ChromeBrowserService } from './chrome-browser';
import { BrowserManager } from './manager';
import { BrowserOperations, browserFailure, browserTools } from './operations';
import { BrowserError, object, type BrowserObject } from './types';
import type { Json } from '../ipc/contract';
import { join } from 'node:path';

export interface BrowserMcpOptions {
  chromeEnabled?: () => boolean;
  chromeExtensionRoot?: string;
  chromeDiscoveryDirectory?: string;
  /** HTTPS update manifest backing the managed-policy extension install. */
  chromePolicyUpdateManifestUrl?: string;
  reportDiagnostic?: (message: string) => void;
  beginOperation?: (sessionId: string) => unknown;
  observeResult?: (sessionId: string, lease: unknown, result: Json) => void;
  releaseAccess?: (sessionId: string) => void;
}

interface BrowserCall { token: string; session?: string; controller: AbortController }
const callKey = (token: string, session: string | undefined, id: string | number): string => JSON.stringify([token, session ?? null, id]);

/** A capability URL is bound to a task, so callers cannot supply another task id. */
export class BrowserMcpServer {
  readonly chrome: ChromeBrowserService;
  readonly operations: BrowserOperations;
  private readonly routes = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private readonly sessions = new Map<string, string>();
  private readonly calls = new Map<string, BrowserCall>();
  private server: Server | undefined;
  private starting: Promise<string> | undefined;
  private stopped = false;

  constructor(readonly manager: BrowserManager, private readonly options: BrowserMcpOptions = {}) {
    this.chrome = new ChromeBrowserService({
      enabled: () => manager.isEnabled() && (options.chromeEnabled?.() ?? false),
      assertNavigation: url => manager.assertNavigation(url), discoveryDirectory: options.chromeDiscoveryDirectory,
      reportDiagnostic: options.reportDiagnostic ?? (message => process.stderr.write(`${message}\n`)),
      onTabsChanged: () => manager.publishTabInventoryChange(),
      artifactDirectory: join(manager.configRoot, 'artifacts'),
      authorize: (sessionId, url, resource, signal) => manager.authorize(sessionId, url, resource, signal),
      setup: options.chromeExtensionRoot ? { configRoot: manager.configRoot, extensionRoot: options.chromeExtensionRoot, deployRoot: join(manager.configRoot, 'chrome-extension'), policyUpdateManifestUrl: options.chromePolicyUpdateManifestUrl, showExtensionFolder: path => shell.showItemInFolder(path) } : undefined,
    });
    this.operations = new BrowserOperations(manager, this.chrome);
  }

  private start(): Promise<string> {
    if (this.stopped) return Promise.reject(new BrowserError('unavailable', 'Browser MCP has shut down.'));
    if (this.starting) return this.starting;
    this.starting = new Promise<string>((resolveStart, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response); });
      this.server = server;
      // wait_for is bounded at 120 seconds; leave room to encode and flush its reply.
      server.requestTimeout = 125_000;
      server.headersTimeout = 10_000;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new BrowserError('host_error', 'Browser MCP did not bind a loopback port.')); return; }
        resolveStart(`http://127.0.0.1:${address.port}`);
      });
    });
    return this.starting;
  }

  async hostCapabilities(rendererId: string): Promise<BrowserObject> {
    if (!rendererId || rendererId.length > 256) throw new BrowserError('invalid_request', 'A renderer session id is required.');
    if (!this.manager.isEnabled()) return { mcpServers: [], runtimeCapabilityRoots: [] };
    const base = await this.start();
    let token = this.tokens.get(rendererId);
    if (!token) { token = randomBytes(32).toString('hex'); this.tokens.set(rendererId, token); this.routes.set(token, rendererId); }
    // Deferred by default: these tool schemas are surfaced through tool_search
    // instead of riding along in every model request.
    return {
      mcpServers: [{ name: 'klaus-browser', transport: 'http', url: `${base}/mcp/${token}?session=${encodeURIComponent(rendererId)}` }],
      runtimeCapabilityRoots: [{ id: 'klaus-browser', enabled: true, browser: { mcpServer: 'klaus-browser' } }],
    };
  }

  private send(response: ServerResponse, status: number, value?: unknown, sessionId?: string): void {
    if (response.destroyed || response.writableEnded) return;
    response.statusCode = status;
    response.setHeader('Cache-Control', 'no-store');
    if (sessionId) response.setHeader('Mcp-Session-Id', sessionId);
    if (value === undefined) { response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(value));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const address = this.server?.address();
      const host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
      // Reject browser-origin requests and DNS rebinding before inspecting a body.
      if (this.stopped || request.headers.host !== host || request.headers.origin) { this.send(response, 403, { error: 'Forbidden browser MCP origin.' }); return; }
      const url = new URL(request.url ?? '/', `http://${host}`);
      const token = url.pathname.startsWith('/mcp/') ? url.pathname.slice(5) : '';
      const owner = this.routes.get(token);
      if (!owner || url.searchParams.get('session') !== owner) { this.send(response, 404, { error: 'Unknown browser capability.' }); return; }
      const header = request.headers['mcp-session-id'];
      if (header !== undefined && (typeof header !== 'string' || this.sessions.get(header) !== token)) { this.send(response, 404, { error: 'Unknown MCP session.' }); return; }
      if (request.method === 'DELETE') {
        if (typeof header === 'string') {
          this.cancelCalls(call => call.token === token && call.session === header);
          this.sessions.delete(header);
        }
        this.send(response, 200, {}); return;
      }
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST, DELETE'); this.send(response, 405); return; }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) { this.send(response, 415); return; }
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 2 * 1024 * 1024) { this.send(response, 413, { error: 'MCP request too large.' }); return; }
        chunks.push(bytes);
      }
      let body: BrowserObject;
      try { body = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { this.send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
      if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') { this.send(response, 400, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } }); return; }
      // A task may close while its request body is still arriving.
      if (this.routes.get(token) !== owner || header !== undefined && this.sessions.get(header) !== token) { this.send(response, 404, { error: 'Released browser capability.' }); return; }
      const params = object(body.params);
      if (body.id === undefined) {
        if (body.method === 'notifications/cancelled' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
          this.calls.get(callKey(token, header, params.requestId))?.controller.abort(new BrowserError('cancelled', 'The MCP client cancelled the browser operation.'));
        }
        this.send(response, 202); return;
      }
      let result: Json;
      let sessionId: string | undefined;
      switch (body.method) {
        case 'initialize':
          sessionId = randomUUID(); this.sessions.set(sessionId, token);
          result = { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'klaus-browser', version: '1.0.0' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: browserTools() }; break;
        case 'resources/list': result = { resources: [] }; break;
        case 'resources/templates/list': result = { resourceTemplates: [] }; break;
        case 'prompts/list': result = { prompts: [] }; break;
        case 'tools/call': {
          if (typeof body.id !== 'string' && typeof body.id !== 'number') throw new BrowserError('invalid_request', 'A browser tool call needs a string or numeric request id.');
          const key = callKey(token, header, body.id);
          if (this.calls.has(key)) throw new BrowserError('invalid_request', 'The browser request id is already in flight.');
          const controller = new AbortController();
          this.calls.set(key, { token, session: header, controller });
          // Dropping a pending engine HTTP request must retire its temporary pages.
          const disconnected = (): void => { if (!response.writableEnded) controller.abort(new BrowserError('cancelled', 'The browser caller disconnected.')); };
          response.once('close', disconnected);
          if (response.destroyed) disconnected();
          try {
            controller.signal.throwIfAborted();
            const lease = this.options.beginOperation?.(owner);
            result = await this.operations.execute(owner, typeof params.name === 'string' ? params.name : '', params.arguments ?? {}, controller.signal);
            if (!controller.signal.aborted && !this.stopped && this.routes.get(token) === owner) {
              try { this.options.observeResult?.(owner, lease, result); }
              catch (error) { this.options.reportDiagnostic?.(`Browser result presentation failed: ${String(error)}`); }
            }
          } finally { response.off('close', disconnected); this.calls.delete(key); }
          break;
        }
        default: this.send(response, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unknown method: ${body.method}` } }); return;
      }
      this.send(response, 200, { jsonrpc: '2.0', id: body.id, result }, sessionId);
    } catch (error) { this.send(response, 500, browserFailure(error)); }
  }

  private cancelCalls(matches: (call: BrowserCall) => boolean): void {
    for (const call of this.calls.values()) if (matches(call)) call.controller.abort(new BrowserError('cancelled', 'The browser capability was released.'));
  }

  releaseSession(rendererId: string): void {
    this.options.releaseAccess?.(rendererId);
    this.operations.releaseSession(rendererId);
    const token = this.tokens.get(rendererId);
    if (token) {
      this.cancelCalls(call => call.token === token);
      this.routes.delete(token); this.tokens.delete(rendererId);
      for (const [id, owner] of this.sessions) if (owner === token) this.sessions.delete(id);
    }
    this.manager.releaseConversation(rendererId);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelCalls(() => true);
    this.operations.dispose();
    await this.chrome.shutdown();
    this.tokens.clear(); this.routes.clear(); this.sessions.clear();
    if (this.starting) await this.starting.catch(() => {});
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
    this.server = undefined;
  }
}
