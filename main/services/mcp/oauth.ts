import { randomBytes } from 'node:crypto';
import type { Json } from '../../ipc/contract';
import { errorMessage, object, string, type JsonObject } from '../service-types';
import { captureMcpOAuthCode, safeAuthorizationUrl, safeLoopbackRedirect } from './loopback';
import { authorizationUrl, discoveryUrls, isObject, mcpOAuthServerKey, normalizeTokens, originRoot, selectResourceUrl, strings, type McpOAuthCredentials, type McpOAuthPart } from './oauth-schema';

export interface McpOAuthDeps {
  credentials: McpOAuthCredentials;
  openExternal: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  redirectUri?: string;
  requestTimeoutMs?: number;
  authorizationTimeoutMs?: number;
}
interface Flow { config: JsonObject; key: string; signal: AbortSignal; redirect: string; oauth: boolean; scopes: string[]; url?: string }
interface HttpReply { status: number; statusText: string; headers: Headers; body: string }
type Probe = { kind: 'ready' } | { kind: 'unauthorized'; metadataUrl?: string; scope?: string };
class Declined extends Error { constructor(readonly authorizationUrl?: string) { super('MCP authorization declined'); } }
class TokenFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
class CredentialFailure extends Error {}
const abort = (flow: Flow): void => { if (flow.signal.aborted) throw new Declined(flow.url); };
function parsedObject(text: string): JsonObject { const value: unknown = JSON.parse(text); if (!isObject(value)) throw new Error('Expected an OAuth JSON object'); return value; }
function errorResponse(reply: HttpReply): TokenFailure {
  try { const body = parsedObject(reply.body); if (typeof body.error === 'string') return new TokenFailure(body.error, string(body.error_description)); } catch { /* Retain the status below. */ }
  return new TokenFailure('server_error', 'HTTP ' + reply.status + ': Invalid OAuth error response: . Raw body: ' + reply.body.slice(0, 8192));
}
function challenge(header: string, field: string): string | undefined {
  if (!/^Bearer\s/i.test(header)) return undefined;
  return new RegExp('(?:^|[\\s,])' + field + '="([^"]*)"').exec(header)?.[1];
}
function initializeMessage(text: string, eventStream: boolean): JsonObject | undefined {
  const frames = eventStream ? text.replace(/\r\n/g, '\n').split('\n\n').filter(frame => frame.includes('data:')).map(frame => frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')) : [text];
  for (const frame of frames) {
    try { const value = parsedObject(frame); if (value.id === 1 && value.jsonrpc === '2.0' && (isObject(value.result) || isObject(value.error))) return value; } catch { /* An SSE event may be split across reads. */ }
  }
  return undefined;
}

/** Host-side discovery, DCR and token exchange. Only the injected secure store persists secrets. */
export class McpOAuthService {
  private readonly pending = new Map<string, { controller: AbortController; promise: Promise<Json> }>();
  private readonly fetcher: typeof fetch;
  private closed = false;
  constructor(private readonly deps: McpOAuthDeps) { this.fetcher = deps.fetch ?? fetch; }
  authenticate(config: JsonObject): Promise<Json> {
    if (this.closed) return Promise.resolve({ status: 'failed', error: 'MCP authorization is closed' });
    if (!['http', 'sse'].includes(string(config.transport)) || !string(config.url)) return Promise.resolve({ status: 'unsupported' });
    const key = mcpOAuthServerKey(config), existing = this.pending.get(key); if (existing) return existing.promise;
    const controller = new AbortController();
    const flow: Flow = { config: structuredClone(config), key, signal: controller.signal, redirect: this.deps.redirectUri ?? process.env.KLAUS_MCP_OAUTH_REDIRECT_URI ?? 'http://127.0.0.1:33418/callback',
      oauth: config.oauth !== undefined && config.oauth !== null && config.oauth !== false, scopes: strings(object(config.oauth).scopes) };
    const promise = this.run(flow).finally(() => { this.pending.delete(key); }); this.pending.set(key, { controller, promise }); return promise;
  }
  async cancel(config: JsonObject): Promise<void> { const pending = this.pending.get(mcpOAuthServerKey(config)); pending?.controller.abort(); await pending?.promise; }
  async close(): Promise<void> { this.closed = true; const pending = [...this.pending.values()]; for (const item of pending) item.controller.abort(); await Promise.allSettled(pending.map(item => item.promise)); }
  private async read(flow: Flow, part: McpOAuthPart): Promise<JsonObject | undefined> {
    abort(flow); const result = await this.deps.credentials.readMcpOAuthRecord(flow.key, part); abort(flow);
    if (result.error) throw new CredentialFailure(result.error);
    if (result.value === null) return undefined;
    if (!isObject(result.value)) throw new CredentialFailure('Invalid MCP OAuth ' + part + ' record');
    return result.value;
  }
  private async write(flow: Flow, part: McpOAuthPart, value: JsonObject): Promise<void> {
    const before = await this.read(flow, part); abort(flow);
    const saved = await this.deps.credentials.writeMcpOAuthRecord(flow.key, part, value);
    if (!saved.success) throw new CredentialFailure(saved.error ?? 'MCP credential write failed');
    if (flow.signal.aborted) {
      const restored = before ? (await this.deps.credentials.writeMcpOAuthRecord(flow.key, part, before)).success : await this.deps.credentials.removeMcpOAuthRecord(flow.key, part);
      if (!restored) throw new CredentialFailure('MCP cancelled credential write could not be restored');
      abort(flow);
    }
  }
  private async remove(flow: Flow, part: McpOAuthPart): Promise<void> {
    abort(flow); if (!await this.deps.credentials.removeMcpOAuthRecord(flow.key, part)) throw new CredentialFailure('MCP credential delete failed'); abort(flow);
  }
  private async saveTokens(flow: Flow, tokens: JsonObject): Promise<void> {
    const ttl = typeof tokens.expires_in === 'number' && Number.isSafeInteger(tokens.expires_in * 1000) ? tokens.expires_in * 1000 : 3_600_000;
    const expiresAt = Date.now() + ttl; if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid OAuth token lifetime');
    await this.write(flow, 'tokens', { tokens, expiresAt });
  }
  private async http(flow: Flow, url: string, init: RequestInit = {}, mode: 'json' | 'probe' | 'diagnostic' = 'json'): Promise<HttpReply> {
    abort(flow); safeAuthorizationUrl(url);
    const controller = new AbortController(), cancel = (): void => controller.abort(); flow.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, mode === 'diagnostic' ? Math.min(5000, this.deps.requestTimeoutMs ?? 30_000) : this.deps.requestTimeoutMs ?? 30_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
      reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      const eventStream = response.headers.get('content-type')?.includes('text/event-stream') === true;
      if (reader) for (;;) {
        const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length;
        const limit = mode === 'diagnostic' ? 8192 : 512 * 1024;
        if (length > limit) { if (mode !== 'diagnostic') throw new Error('OAuth response exceeds the size limit'); chunks.push(chunk.value.slice(0, limit - (length - chunk.value.length))); break; }
        chunks.push(chunk.value);
        if (mode === 'probe' && eventStream && initializeMessage(Buffer.concat(chunks).toString('utf8'), true)) break;
      }
      abort(flow); return { status: response.status, statusText: response.statusText, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') };
    } finally { await reader?.cancel().catch(() => undefined); clearTimeout(timer); flow.signal.removeEventListener('abort', cancel); }
  }
  private async probe(flow: Flow, bearer?: string): Promise<Probe> {
    const headers = new Headers(Object.fromEntries(Object.entries(object(flow.config.headers)).filter((pair): pair is [string, string] => typeof pair[1] === 'string')));
    headers.set('content-type', 'application/json'); headers.set('accept', 'application/json, text/event-stream'); if (bearer) headers.set('authorization', 'Bearer ' + bearer);
    const reply = await this.http(flow, string(flow.config.url), { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-engine', version: '0.1.0' } } }) }, 'probe');
    if ([401, 403].includes(reply.status)) { const header = reply.headers.get('www-authenticate') ?? ''; return { kind: 'unauthorized', metadataUrl: challenge(header, 'resource_metadata'), scope: challenge(header, 'scope') }; }
    if (reply.status < 200 || reply.status >= 300) throw new Error('Streamable HTTP error: Error POSTing to endpoint: ' + reply.body.slice(0, 8192));
    const message = initializeMessage(reply.body, reply.headers.get('content-type')?.includes('text/event-stream') === true);
    if (!message) throw new Error('Invalid MCP initialize response');
    if (message.error) throw new Error(string(object(message.error).message) || JSON.stringify(message.error));
    if (!string(object(message.result).protocolVersion)) throw new Error('Invalid MCP initialize protocol version'); return { kind: 'ready' };
  }
  private async metadataGet(flow: Flow, url: string, acceptJson = false): Promise<HttpReply | undefined> {
    try { return await this.http(flow, url, { headers: { 'MCP-Protocol-Version': '2025-11-25', ...(acceptJson ? { accept: 'application/json' } : {}) } }); }
    catch { abort(flow); return undefined; }
  }
  private async resourceMetadata(flow: Flow, explicit?: string): Promise<JsonObject | undefined> {
    const server = new URL(string(flow.config.url)); let response: HttpReply | undefined;
    if (explicit) response = await this.metadataGet(flow, explicit);
    else {
      const first = new URL('/.well-known/oauth-protected-resource' + server.pathname.replace(/\/$/, ''), server); first.search = server.search;
      response = await this.metadataGet(flow, first.href);
      if (!response || (response.status >= 400 && response.status < 500 && server.pathname !== '/')) response = await this.metadataGet(flow, new URL('/.well-known/oauth-protected-resource', server).href);
    }
    if (!response || response.status < 200 || response.status >= 300) return undefined;
    try { return parsedObject(response.body); } catch { return undefined; }
  }
  private async serverMetadata(flow: Flow, server: string): Promise<JsonObject | undefined> {
    for (const candidate of discoveryUrls(server)) {
      const response = await this.metadataGet(flow, candidate.url, true); if (!response) continue;
      if (response.status < 200 || response.status >= 300) {
        if (response.status >= 400 && response.status < 500) continue;
        throw new Error('HTTP ' + response.status + ' trying to load ' + candidate.kind + ' metadata from ' + candidate.url);
      }
      try { return parsedObject(response.body); } catch { /* Try the next standard discovery location. */ }
    }
    return undefined;
  }
  private async discovery(flow: Flow, explicit?: string): Promise<JsonObject> {
    const cached = await this.read(flow, 'discovery'), resourceMetadataUrl = explicit ?? (typeof cached?.resourceMetadataUrl === 'string' ? cached.resourceMetadataUrl : undefined);
    const resourceMetadata = isObject(cached?.resourceMetadata) ? cached.resourceMetadata : await this.resourceMetadata(flow, resourceMetadataUrl);
    const authorizationServerUrl = string(cached?.authorizationServerUrl) || strings(resourceMetadata?.authorization_servers)[0] || originRoot(string(flow.config.url));
    safeAuthorizationUrl(authorizationServerUrl);
    const authorizationServerMetadata = isObject(cached?.authorizationServerMetadata) ? cached.authorizationServerMetadata : await this.serverMetadata(flow, authorizationServerUrl);
    const value = { authorizationServerUrl, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(resourceMetadata ? { resourceMetadata } : {}), ...(authorizationServerMetadata ? { authorizationServerMetadata } : {}) };
    await this.write(flow, 'discovery', value); return value;
  }
  private async register(flow: Flow, server: string, metadata: JsonObject | undefined, scope?: string): Promise<JsonObject> {
    const endpoint = metadata ? string(metadata.registration_endpoint) : originRoot(server) + 'register';
    if (!endpoint) throw new Error('Incompatible auth server: does not support dynamic client registration');
    const body = { client_name: 'agent-engine (' + string(flow.config.name) + ')', redirect_uris: [flow.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) };
    const reply = await this.http(flow, endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (reply.status < 200 || reply.status >= 300) throw errorResponse(reply);
    const client = parsedObject(reply.body); if (!string(client.client_id)) throw new Error('client_id missing in registration response'); return client;
  }
  private async token(flow: Flow, server: string, metadata: JsonObject | undefined, client: JsonObject, params: URLSearchParams, resource?: string): Promise<JsonObject> {
    const endpoint = string(metadata?.token_endpoint) || originRoot(server) + 'token';
    if (resource) params.append('resource', resource);
    const id = string(client.client_id), secret = typeof client.client_secret === 'string' ? client.client_secret : undefined, supported = strings(metadata?.token_endpoint_auth_methods_supported);
    const method = !supported.length ? secret !== undefined ? 'client_secret_basic' : 'none'
      : secret !== undefined && supported.includes('client_secret_basic') ? 'client_secret_basic' : secret !== undefined && supported.includes('client_secret_post') ? 'client_secret_post'
      : supported.includes('none') ? 'none' : secret !== undefined ? 'client_secret_post' : 'none';
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (method === 'client_secret_basic') headers.authorization = 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
    else { params.append('client_id', id); if (method === 'client_secret_post') params.append('client_secret', secret!); }
    const reply = await this.http(flow, endpoint, { method: 'POST', headers, body: params.toString() });
    if (reply.status < 200 || reply.status >= 300) throw errorResponse(reply);
    const tokens = parsedObject(reply.body); if (!string(tokens.access_token)) throw new TokenFailure('server_error', 'access_token missing in token response');
    if (tokens.expires_in !== undefined && (typeof tokens.expires_in !== 'number' || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in < 0)) throw new TokenFailure('server_error', 'Invalid OAuth token lifetime');
    return normalizeTokens(tokens);
  }
  private async refresh(flow: Flow, discovery: JsonObject, client: JsonObject, refreshToken: string): Promise<JsonObject> {
    return { refresh_token: refreshToken, ...await this.token(flow, string(discovery.authorizationServerUrl), isObject(discovery.authorizationServerMetadata) ? discovery.authorizationServerMetadata : undefined, client,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), selectResourceUrl(string(flow.config.url), discovery.resourceMetadata)) };
  }
  private async accessToken(flow: Flow): Promise<string | undefined> {
    const bundle = await this.read(flow, 'tokens'); if (!bundle) return undefined;
    const tokens = object(bundle.tokens), access = string(tokens.access_token); if (!access) return undefined;
    if (!string(tokens.refresh_token) || typeof bundle.expiresAt !== 'number' || bundle.expiresAt - Date.now() > 300_000) return access;
    const discovery = await this.read(flow, 'discovery'), client = await this.read(flow, 'client'); if (!discovery || !client) return access;
    try { const fresh = await this.refresh(flow, discovery, client, string(tokens.refresh_token)); await this.saveTokens(flow, fresh); return string(fresh.access_token) || access; }
    catch (error) { if (error instanceof CredentialFailure) throw error; abort(flow); return access; }
  }
  private async authorize(flow: Flow, unauthorized: Extract<Probe, { kind: 'unauthorized' }>): Promise<string | undefined> {
    const discovery = await this.discovery(flow, unauthorized.metadataUrl), metadata = isObject(discovery.authorizationServerMetadata) ? discovery.authorizationServerMetadata : undefined;
    const resource = selectResourceUrl(string(flow.config.url), discovery.resourceMetadata), scope = unauthorized.scope ?? (strings(object(discovery.resourceMetadata).scopes_supported).join(' ') || flow.scopes.join(' ') || undefined);
    let client = await this.read(flow, 'client'); const bundle = await this.read(flow, 'tokens'), refreshToken = string(object(bundle?.tokens).refresh_token);
    if (client && refreshToken) {
      try { const fresh = await this.refresh(flow, discovery, client, refreshToken); await this.saveTokens(flow, fresh); return undefined; }
      catch (error) {
        if (error instanceof CredentialFailure) throw error; abort(flow); await this.remove(flow, 'tokens');
        if (error instanceof TokenFailure && ['invalid_client', 'unauthorized_client'].includes(error.code)) { await this.remove(flow, 'client'); client = undefined; }
      }
    }
    if (!client) { client = await this.register(flow, string(discovery.authorizationServerUrl), metadata, scope); await this.write(flow, 'client', client); }
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    flow.url = authorizationUrl(string(discovery.authorizationServerUrl), metadata, client, flow.redirect, state, verifier, scope, resource);
    const captured = await captureMcpOAuthCode(flow.url, flow.redirect, flow.signal, this.deps.openExternal, this.deps.authorizationTimeoutMs);
    if (captured.kind !== 'code') throw new Declined(flow.url); abort(flow);
    let tokens: JsonObject;
    try { tokens = await this.token(flow, string(discovery.authorizationServerUrl), metadata, client, new URLSearchParams({ grant_type: 'authorization_code', code: captured.code, code_verifier: verifier, redirect_uri: flow.redirect }), resource); }
    catch { throw new Declined(flow.url); }
    await this.saveTokens(flow, tokens); return flow.url;
  }
  private async diagnostic(flow: Flow): Promise<string | undefined> {
    try {
      const reply = await this.http(flow, string(flow.config.url), {}, 'diagnostic'); if (reply.status < 400) return undefined;
      const body = Array.from(reply.body.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim()).slice(0, 700).join('');
      return 'Endpoint diagnostic: HTTP ' + reply.status + (reply.statusText ? ' ' + reply.statusText : '') + (body ? ' - ' + body : '');
    } catch { return undefined; }
  }
  private async run(flow: Flow): Promise<Json> {
    try {
      safeAuthorizationUrl(string(flow.config.url)); safeLoopbackRedirect(flow.redirect);
      const probe = await this.probe(flow, flow.oauth ? await this.accessToken(flow) : undefined);
      if (probe.kind === 'ready') return { status: flow.oauth ? 'authenticated' : 'not-needed' };
      if (!flow.oauth) throw new Declined();
      const url = await this.authorize(flow, probe);
      try { if ((await this.probe(flow, await this.accessToken(flow))).kind === 'ready') return { status: 'authenticated' }; }
      catch (error) { if (error instanceof CredentialFailure) throw error; }
      throw new Declined(url);
    } catch (error) {
      if (error instanceof Declined || (flow.signal.aborted && !(error instanceof CredentialFailure))) return { status: 'declined', ...(flow.url ? { authorizationUrl: flow.url } : error instanceof Declined && error.authorizationUrl ? { authorizationUrl: error.authorizationUrl } : {}) };
      const message = errorMessage(error), diagnostic = error instanceof CredentialFailure ? undefined : await this.diagnostic(flow);
      return { status: 'failed', error: diagnostic && !message.includes(diagnostic) ? message + '; ' + diagnostic : message };
    }
  }
}
