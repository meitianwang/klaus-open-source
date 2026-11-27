import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Json } from '../../ipc/contract';
import { IpcHandlerError } from '../../ipc/registry';
import { isFailure, kvGet, kvSet } from '../settings';
import { object, string, type JsonObject } from '../service-types';

export interface McpDeviceDeps {
  configRoot: string;
  catalog: () => Promise<JsonObject[]>;
  /** The existing built-in installer owns credential replacement, enabling and refresh. */
  install: (payload: JsonObject, signal: AbortSignal) => Promise<Json>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  baseURL?: string;
  marketEndpoint?: GoogleOAuthOptions['marketEndpoint'];
  requestTimeoutMs?: number;
}

interface Attempt {
  id: string;
  controller: AbortController;
  result: Promise<JsonObject>;
  resolve: (result: JsonObject) => void;
  complete: boolean;
  retention?: ReturnType<typeof setTimeout>;
}
const failed = (error: string): JsonObject => ({ ok: false, error });
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SECONDS = 24 * 60 * 60;
const RETAIN_RESULT_MS = 15 * 60 * 1000;
const invalidClient = new Set(['Not Found', 'incorrect_client_credentials', 'device_flow_disabled']);
const publicErrors = new Set(['incorrect_client_credentials', 'device_flow_disabled', 'incorrect_device_code', 'unsupported_grant_type', 'invalid_request', 'unauthorized_client']);
class DeviceFailure extends Error {}
class DeviceNetworkError extends Error {}

function idOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new IpcHandlerError('BAD_REQUEST', 'A valid MCP server id is required');
  return value;
}
function publicClient(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || /[\0\r\n]/.test(value)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid public OAuth client id');
  return value.trim();
}

/** Shared with built-in rows: environment, legacy SQLite setting, public catalog default. */
function clientOverride(configRoot: string, id: string, env: NodeJS.ProcessEnv): string {
  idOf(id);
  const key = id.toUpperCase();
  const overridden = env[`KLAUS_${key}_CLIENT_ID`]?.trim() || env[`KLAUS_${key.replace(/-/g, '_')}_CLIENT_ID`]?.trim();
  if (overridden) return publicClient(overridden);
  const stored = kvGet('mcp-device-client-id:' + id, configRoot);
  if (isFailure(stored)) throw new IpcHandlerError(stored.code, stored.message);
  if (typeof stored === 'string' && stored.trim()) return publicClient(stored);
  return '';
}

interface GoogleOAuthOptions {
  baseURL?: string;
  marketEndpoint?: () => { baseUrl: string } | undefined | Promise<{ baseUrl: string } | undefined>;
}
type GoogleOAuthPlan = { clientId: string } & (
  { mode: 'direct'; tokenUrl: string; clientSecret?: string } |
  { mode: 'market'; marketBaseUrl: string }
);

export function readLocalGoogleOAuthCredentials(configRoot: string, env: NodeJS.ProcessEnv): { clientId: string; clientSecret: string } | undefined {
  const pair = (id: unknown, secret: unknown) => {
    const clientId = boundText(id, 4096).trim(), clientSecret = boundText(secret, 4096).trim();
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };
  const fromEnv = pair(env.KLAUS_GOOGLE_OAUTH_CLIENT_ID, env.KLAUS_GOOGLE_OAUTH_CLIENT_SECRET);
  if (fromEnv) return fromEnv;
  for (const path of [env.KLAUS_GOOGLE_OAUTH_FILE?.trim(), join(configRoot, 'google-oauth-desktop.json'), join(homedir(), '.klaus', 'google-oauth-desktop.json')]) {
    if (!path) continue;
    try {
      const root = object(JSON.parse(readFileSync(path, 'utf8')));
      const installed = object(root.installed);
      const found = pair(root.client_id, root.client_secret) ?? pair(installed.client_id, installed.client_secret);
      if (found) return found;
    } catch { /* Missing or malformed credential files are not usable. */ }
  }
}

export async function resolveGoogleOAuthPlan(configRoot: string, id: string, catalog: JsonObject[], env: NodeJS.ProcessEnv, { baseURL, marketEndpoint }: GoogleOAuthOptions): Promise<GoogleOAuthPlan | undefined> {
  idOf(id);
  const localPair = readLocalGoogleOAuthCredentials(configRoot, env);
  const customTokenUrl = env.KLAUS_GOOGLE_TOKEN_URL?.trim();
  if (localPair || baseURL || customTokenUrl) {
    const clientId = localPair?.clientId || clientOverride(configRoot, id, env) || defaultClientId(id, catalog);
    if (!clientId) return;
    const tokenUrl = customTokenUrl ? endpointBase(customTokenUrl) : baseURL ? endpointBase(baseURL) + '/token' : 'https://oauth2.googleapis.com/token';
    return { mode: 'direct', tokenUrl, clientId, ...(localPair ? { clientSecret: localPair.clientSecret } : {}) };
  }
  const override = clientOverride(configRoot, id, env), clientId = defaultClientId(id, catalog);
  if (!clientId || (override && override !== clientId)) return;
  const marketBaseUrl = (await marketEndpoint?.())?.baseUrl.trim();
  if (marketBaseUrl) return { clientId, mode: 'market', marketBaseUrl: endpointBase(marketBaseUrl) };
}

function defaultClientId(id: string, catalog: JsonObject[]): string {
  return publicClient(string(object(catalog.find(entry => entry.id === id)?.deviceAuth).defaultClientId));
}

export function resolveMcpDeviceClientId(configRoot: string, id: string, catalog: JsonObject[], env: NodeJS.ProcessEnv = process.env, options: GoogleOAuthOptions = {}): string | Promise<string> {
  if (object(catalog.find(entry => entry.id === id)?.deviceAuth).provider === 'google') {
    return resolveGoogleOAuthPlan(configRoot, id, catalog, env, options).then(plan => plan?.clientId ?? '', error => {
      if (error instanceof DeviceFailure) return '';
      throw error;
    });
  }
  return clientOverride(configRoot, id, env) || defaultClientId(id, catalog);
}

function endpointBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new DeviceFailure('invalid_endpoint'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw new DeviceFailure('invalid_endpoint');
  return url.href.replace(/\/+$/, '');
}
function verificationUri(value: unknown, base: string, deviceCode: string): string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes(deviceCode)) throw new DeviceFailure('invalid_response');
  let url: URL;
  try { url = new URL(value); } catch { throw new DeviceFailure('invalid_response'); }
  if (url.origin !== new URL(base).origin || url.username || url.password || url.hash) throw new DeviceFailure('invalid_response');
  return url.href;
}
function seconds(value: Json | undefined, fallback: number, clamp: boolean): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value > MAX_SECONDS || (!clamp && value <= 0)) throw new DeviceFailure('invalid_response');
  return Math.max(1, value);
}
function boundText(value: unknown, maximum: number): string {
  return typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= maximum && !/[\0\r\n]/.test(value) ? value : '';
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(new DeviceFailure('cancelled')); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DeviceFailure('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One background authorization per server, independent of renderer or dialog lifetime. */
export class McpDeviceService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeout: number;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly deps: McpDeviceDeps) {
    if (!isAbsolute(deps.configRoot) || deps.configRoot.includes('\0')) throw new Error('MCP device authorization requires an absolute config root');
    this.env = deps.env ?? process.env;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.timeout = deps.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 30_000) throw new Error('Invalid device authorization request timeout');
  }
  private active(): void { if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The MCP device authorization service is closed'); }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.jobs.add(operation);
    void operation.then(() => this.jobs.delete(operation), () => this.jobs.delete(operation));
    return operation;
  }
  private current(attempt: Attempt): void {
    if (this.closed || attempt.controller.signal.aborted || this.attempts.get(attempt.id) !== attempt) throw new DeviceFailure('cancelled');
  }
  private finish(attempt: Attempt, result: JsonObject): void {
    if (attempt.complete) return;
    attempt.complete = true; attempt.resolve(result);
    attempt.retention = setTimeout(() => this.forget(attempt), RETAIN_RESULT_MS);
    attempt.retention.unref();
  }
  private forget(attempt: Attempt): void {
    clearTimeout(attempt.retention);
    if (this.attempts.get(attempt.id) === attempt) this.attempts.delete(attempt.id);
  }
  private cancelAttempt(attempt: Attempt): void {
    attempt.controller.abort();
    this.finish(attempt, failed('cancelled'));
    this.forget(attempt);
  }
  private failure(error: unknown, attempt: Attempt): JsonObject {
    if (attempt.controller.signal.aborted || this.closed) return failed('cancelled');
    if (error instanceof DeviceFailure) return failed(error.message);
    // HTTP clients and installers can include their request in an error. Never send
    // those messages, response bodies, device codes or access tokens to the renderer.
    return failed(error instanceof DeviceNetworkError ? 'network_error' : 'authorization_failed');
  }

  async clientId(payload: JsonObject): Promise<Json> {
    this.active(); const id = idOf(payload.id);
    if (payload.clientId !== undefined) {
      const result = kvSet('mcp-device-client-id:' + id, publicClient(payload.clientId), this.deps.configRoot);
      if (isFailure(result)) throw new IpcHandlerError(result.code, result.message);
    }
    const catalog = await this.deps.catalog(); this.active();
    return { ok: true, clientId: await resolveMcpDeviceClientId(this.deps.configRoot, id, catalog, this.env, this.deps) };
  }
  start(payload: JsonObject): Promise<Json> {
    this.active(); const id = idOf(payload.id);
    const previous = this.attempts.get(id); if (previous) this.cancelAttempt(previous);
    let resolve!: (result: JsonObject) => void;
    const attempt: Attempt = { id, controller: new AbortController(), result: new Promise(done => { resolve = done; }), resolve: result => resolve(result), complete: false };
    // Install ownership before catalog or HTTP awaits: concurrent starts cannot publish
    // an older grant after its replacement has become the current attempt.
    this.attempts.set(id, attempt);
    return this.track(this.begin(attempt));
  }
  private async begin(attempt: Attempt): Promise<JsonObject> {
    try {
      const catalog = await abortable(this.deps.catalog(), attempt.controller.signal); this.current(attempt);
      const auth = object(catalog.find(entry => entry.id === attempt.id)?.deviceAuth);
      if (!Object.keys(auth).length) throw new DeviceFailure('unsupported');
      if (auth.provider !== 'github' && auth.provider !== 'google') throw new DeviceFailure('unsupported_provider');
      const tokenEnvKey = string(auth.tokenEnvKey);
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(tokenEnvKey)) throw new DeviceFailure('invalid_catalog');
      if (auth.provider === 'google') {
        const plan = await abortable(resolveGoogleOAuthPlan(this.deps.configRoot, attempt.id, catalog, this.env, this.deps), attempt.controller.signal);
        this.current(attempt);
        if (!plan) throw new DeviceFailure('no_client_id');
        return await this.beginGoogle(attempt, plan, tokenEnvKey, string(auth.scope));
      }
      const clientId = await resolveMcpDeviceClientId(this.deps.configRoot, attempt.id, catalog, this.env);
      if (!clientId) throw new DeviceFailure('no_client_id');
      const base = endpointBase(this.deps.baseURL ?? (this.env.KLAUS_GITHUB_DEVICE_URL?.trim() || 'https://github.com'));
      const data = await this.post(base + '/login/device/code', { client_id: clientId, scope: string(auth.scope) }, attempt, this.timeout);
      this.current(attempt);
      const deviceCode = boundText(data.device_code, 16 * 1024), userCode = boundText(data.user_code, 256);
      if (!deviceCode || !userCode || userCode === deviceCode || !string(data.verification_uri)) {
        const error = string(data.error);
        throw new DeviceFailure(invalidClient.has(error) ? 'no_client_id' : publicErrors.has(error) ? error : 'invalid_response');
      }
      const uri = verificationUri(data.verification_uri, base, deviceCode);
      const expiresIn = seconds(data.expires_in, 900, false), interval = seconds(data.interval, 5, true);
      this.track(this.poll(attempt, { base, clientId, deviceCode, tokenEnvKey, interval, deadline: performance.now() + expiresIn * 1000 }));
      return { ok: true, userCode, verificationUri: uri, expiresIn };
    } catch (error) {
      const result = this.failure(error, attempt); this.finish(attempt, result); this.forget(attempt); return result;
    }
  }
  private async beginGoogle(attempt: Attempt, plan: GoogleOAuthPlan, tokenEnvKey: string, scope: string): Promise<JsonObject> {
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    const signal = attempt.controller.signal;
    const expiresIn = 300;
    let redirect = '', claimed = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((req, res) => {
      const callback = new URL('http://127.0.0.1' + (req.url ?? ''));
      const reply = (status: number, text: string) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }).end(text);
      if (req.method !== 'GET' || callback.pathname !== '/oauth/callback') { reply(404, 'Not found.'); return; }
      if (claimed || signal.aborted) { reply(409, 'Authorization is no longer pending.'); return; }
      claimed = true;
      this.track((async () => {
        try {
          const actualState = Buffer.from(callback.searchParams.get('state') ?? '');
          const expectedState = Buffer.from(state);
          if (callback.searchParams.getAll('state').length !== 1 || actualState.length !== expectedState.length || !timingSafeEqual(actualState, expectedState)) {
            throw new DeviceFailure('invalid_state');
          }
          if (callback.searchParams.has('error')) throw new DeviceFailure('denied');
          const code = boundText(callback.searchParams.get('code'), 4096);
          if (!code) throw new DeviceFailure('invalid_response');
          const payload = { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier };
          const data = plan.mode === 'market'
            ? await this.post(plan.marketBaseUrl + '/api/market/mcp/oauth/google/token', payload, attempt, this.timeout)
            : await this.post(plan.tokenUrl, { ...payload, client_id: plan.clientId, ...(plan.clientSecret ? { client_secret: plan.clientSecret } : {}) }, attempt, this.timeout, true);
          this.current(attempt);
          const token = boundText(data.refresh_token, 16 * 1024);
          if (!token) throw new DeviceFailure('invalid_response');
          let installed: Json;
          try { installed = await this.deps.install({ id: attempt.id, env: { [tokenEnvKey]: token } }, signal); }
          catch { this.current(attempt); throw new DeviceFailure('install_failed'); }
          this.current(attempt);
          if (object(installed).ok !== true) {
            this.finish(attempt, { ...failed('install_failed'), ...(object(installed).saved === true ? { saved: true, reloadRequired: true } : {}) });
            reply(500, 'Installation failed. Return to the app for details.');
          } else {
            this.finish(attempt, { ok: true });
            reply(200, 'Authorization complete. You can close this tab.');
          }
        } catch (error) {
          this.finish(attempt, this.failure(error, attempt));
          reply(400, 'Authorization failed. Return to the app for details.');
        } finally { cleanup(); }
      })());
    });
    const cleanup = () => { clearTimeout(expiry); signal.removeEventListener('abort', cleanup); server.close(); server.closeAllConnections?.(); };
    try {
      await abortable(new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }), signal);
      this.current(attempt);
      const address = server.address();
      if (!address || typeof address === 'string') throw new DeviceFailure('invalid_endpoint');
      redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
      signal.addEventListener('abort', cleanup, { once: true });
      expiry = setTimeout(() => {
        this.finish(attempt, failed('expired'));
        attempt.controller.abort();
      }, expiresIn * 1000);
      expiry.unref();
      server.unref();
      const uri = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      uri.search = new URLSearchParams({ client_id: plan.clientId, redirect_uri: redirect, response_type: 'code', scope, state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        access_type: 'offline', prompt: 'consent' }).toString();
      return { ok: true, flow: 'browser', userCode: '', verificationUri: uri.href, expiresIn };
    } catch (error) { cleanup(); throw error; }
  }
  private async post(url: string, payload: JsonObject, attempt: Attempt, timeout: number, form = false): Promise<JsonObject> {
    this.current(attempt);
    const timeoutController = new AbortController(), timer = setTimeout(() => timeoutController.abort(), Math.max(1, Math.ceil(timeout)));
    const signal = AbortSignal.any([attempt.controller.signal, timeoutController.signal]);
    let response: Response | undefined;
    try {
      response = await this.fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? new URLSearchParams(Object.entries(payload).map(([key, value]): [string, string] => [key, String(value)])) : JSON.stringify(payload), signal, redirect: 'manual' });
      if (!response.ok) throw new DeviceFailure('http_' + response.status);
      const claimed = Number(response.headers.get('content-length'));
      if (Number.isFinite(claimed) && claimed > MAX_RESPONSE_BYTES) throw new DeviceFailure('invalid_response');
      if (!response.body) throw new DeviceFailure('invalid_response');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength; if (bytes > MAX_RESPONSE_BYTES) throw new DeviceFailure('invalid_response');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
        return value as JsonObject;
      } catch { throw new DeviceNetworkError('Invalid JSON response'); }
    } catch (error) {
      this.current(attempt);
      if (error instanceof DeviceFailure) throw error;
      throw new DeviceNetworkError('Device authorization request failed');
    } finally { clearTimeout(timer); await response?.body?.cancel().catch(() => undefined); }
  }
  private async poll(attempt: Attempt, grant: { base: string; clientId: string; deviceCode: string; tokenEnvKey: string; interval: number; deadline: number }): Promise<void> {
    let intervalMs = grant.interval * 1000;
    try {
      for (;;) {
        this.current(attempt);
        const wakeAt = Math.min(performance.now() + intervalMs, grant.deadline);
        let remaining = wakeAt - performance.now();
        // Timers can wake before a fractional deadline. Recheck the clock before
        // polling so both the full interval and grant expiry remain authoritative.
        while (remaining > 0) {
          await delay(Math.ceil(remaining), undefined, { signal: attempt.controller.signal });
          this.current(attempt);
          remaining = wakeAt - performance.now();
        }
        if (performance.now() >= grant.deadline) throw new DeviceFailure('expired');
        let data: JsonObject;
        try {
          data = await this.post(grant.base + '/login/oauth/access_token', { client_id: grant.clientId, device_code: grant.deviceCode, grant_type: GRANT_TYPE }, attempt, Math.min(this.timeout, grant.deadline - performance.now()));
        } catch (error) { if (error instanceof DeviceNetworkError) continue; throw error; }
        this.current(attempt);
        if (performance.now() >= grant.deadline) throw new DeviceFailure('expired');
        const token = boundText(data.access_token, 16 * 1024);
        if (token) {
          let installed: Json;
          try { installed = await this.deps.install({ id: attempt.id, env: { [grant.tokenEnvKey]: token } }, attempt.controller.signal); }
          catch { this.current(attempt); throw new DeviceFailure('install_failed'); }
          this.current(attempt);
          if (object(installed).ok !== true) {
            this.finish(attempt, { ...failed('install_failed'), ...(object(installed).saved === true ? { saved: true, reloadRequired: true } : {}) }); return;
          }
          this.finish(attempt, { ok: true }); return;
        }
        const error = string(data.error);
        if (error === 'authorization_pending') continue;
        if (error === 'slow_down') { intervalMs = Math.max(intervalMs + 5000, seconds(data.interval, grant.interval + 5, true) * 1000); continue; }
        if (error === 'expired_token') throw new DeviceFailure('expired');
        if (error === 'access_denied') throw new DeviceFailure('denied');
        throw new DeviceFailure(publicErrors.has(error) ? error : 'unknown');
      }
    } catch (error) { this.finish(attempt, this.failure(error, attempt)); }
    finally { grant.deviceCode = ''; }
  }
  async wait(payload: JsonObject): Promise<Json> {
    this.active(); const attempt = this.attempts.get(idOf(payload.id));
    if (!attempt) return failed('no_pending');
    const result = await attempt.result; this.forget(attempt); return result;
  }
  cancel(payload: JsonObject): Json {
    const attempt = this.attempts.get(idOf(payload.id)); if (attempt) this.cancelAttempt(attempt);
    return { ok: true };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const attempt of this.attempts.values()) this.cancelAttempt(attempt);
    this.closing = Promise.allSettled([...this.jobs]).then(() => undefined);
    return this.closing;
  }
}
