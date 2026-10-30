import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { configRootFrom } from './config-root';
import { currentDesktopEdition } from './desktop-edition';
import { klausAuthStatus, readStoredAuth } from './auth';
import { writePrivateJson } from './account-files';
import { type EngineRequest, type JsonObject, type ServicePush, object, string, errorMessage } from './service-types';
import { SubscriptionAuthService, type SubscriptionAuthDeps, type SubscriptionCredentials } from './subscription-auth';

export interface AccountDeps {
  configRoot?: string;
  request: EngineRequest;
  openExternal: (url: string) => Promise<void>;
  push: ServicePush;
  onAuthChanged: (change?: { signedOut?: boolean }) => void | Promise<void>;
  fetch?: typeof fetch;
  subscriptionFetch?: SubscriptionAuthDeps['fetch'];
  serverUrl?: string;
  appVersion: string;
  loginWindow?: (active: boolean) => void | Promise<void>;
  beforeWipeLocal?: () => void | Promise<void>;
  afterWipeLocal?: () => void | Promise<void>;
  loginTimeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  log?: (event: string, detail: string) => void;
  subscriptionCredentials?: SubscriptionCredentials;
  homeDir?: string;
  codexAuthUrl?: string;
}
type HttpResult = { ok: boolean; status: number; body: Json };
const MAX_CONSECUTIVE_LOGIN_FAILURES = 5;

function isTransientLoginStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function loginPollRejection(response: HttpResult): string {
  // The wire string stays stable for the host integration suite; the code is
  // what the login screen maps to localized copy, so a middlebox 403 no longer
  // reaches the user as a raw HTTP status.
  const code = string(object(response.body).error);
  return `login_poll_rejected:${response.status}${code ? ':' + code : ''}`;
}
function userOf(raw: Json | undefined): JsonObject | undefined {
  const user = object(raw), id = string(user.id);
  if (!id) return undefined;
  return { id, email: string(user.email), displayName: string(user.displayName), role: string(user.role, 'user'), avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : null };
}
function abortError(): Error { return new Error('login cancelled'); }
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  let cancel: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(abortError());
      signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', cancel); }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cancel = (): void => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Owns account HTTP work and cancellation, with no engine or helper process ownership. */
export class AccountService {
  readonly subscriptions: SubscriptionAuthService;
  readonly configRoot: string;
  readonly serverUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly pending = new Set<AbortController>();
  private loginController?: AbortController;
  private epoch = 0;
  private closed = false;
  private wiping?: Promise<Json>;
  constructor(readonly deps: AccountDeps) {
    this.configRoot = deps.configRoot ?? configRootFrom();
    const configured = deps.serverUrl ?? process.env.KLAUS_SERVER_URL;
    this.serverUrl = (configured?.trim() ? configured : currentDesktopEdition().serverUrl).replace(/\/+$/, '');
    this.fetcher = deps.fetch ?? fetch;
    this.subscriptions = new SubscriptionAuthService({ ...deps, fetch: deps.subscriptionFetch ?? deps.fetch, credentials: deps.subscriptionCredentials });
  }
  status(): Json { return klausAuthStatus(this.configRoot); }
  private stored(): JsonObject { return object(readStoredAuth(this.configRoot)); }
  private token(): string { return string(this.stored().token); }
  private authPath(): string { return join(this.configRoot, 'klaus-auth.json'); }
  private markerPath(): string { return join(this.configRoot, 'klaus-guest-mode'); }
  private invalidate(): void {
    this.epoch++;
    this.loginController?.abort();
    for (const controller of this.pending) controller.abort();
  }
  close(): Promise<void> { this.closed = true; this.invalidate(); return this.subscriptions.close(); }
  cancelLogin(): Json { this.loginController?.abort(); return { ok: true }; }
  private active(epoch: number, signal?: AbortSignal): void {
    if (this.closed || epoch !== this.epoch || signal?.aborted) throw abortError();
  }
  private async http(path: string, init: RequestInit = {}, timeoutMs = this.deps.requestTimeoutMs ?? 30_000, signal?: AbortSignal): Promise<HttpResult> {
    if (this.closed) throw new IpcHandlerError('HOST_CLOSED', 'Account service is closed');
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    this.pending.add(controller);
    const timer = setTimeout(cancel, timeoutMs);
    try {
      const response = await this.fetcher(this.serverUrl + path, { ...init, signal: controller.signal });
      const text = await response.text();
      let body: Json = null;
      try { body = JSON.parse(text) as Json; } catch { /* Invalid response bodies are a protocol failure at the caller. */ }
      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.pending.delete(controller);
    }
  }
  async login(): Promise<Json> {
    if (this.closed) return { ok: false, error: 'Account service is closed' };
    this.invalidate();
    const epoch = this.epoch, controller = new AbortController();
    this.loginController = controller;
    const signal = controller.signal;
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = this.serverUrl + '/api/auth/desktop/authorize?state=' + state + '&code_challenge=' + challenge;
    const deadline = Date.now() + (this.deps.loginTimeoutMs ?? 600_000);
    let failures = 0;
    try {
      await abortable(this.deps.openExternal(url), signal);
      this.active(epoch, signal);
      this.deps.push('klausAuth:loginPending', { url });
      for (;;) {
        this.active(epoch, signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          this.deps.log?.('login-timed-out', 'no authorization code within the 10 minute window');
          return { ok: false, error: 'login_timed_out' };
        }
        let response: HttpResult;
        try {
          response = await this.http('/api/auth/desktop/poll', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state, code_verifier: verifier, device_info: (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform) + ' ' + (process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch) + ' klaus/' + this.deps.appVersion }),
          }, Math.min(this.deps.requestTimeoutMs ?? 30_000, remaining), signal);
        } catch (error) {
          this.active(epoch, signal);
          if (++failures >= MAX_CONSECUTIVE_LOGIN_FAILURES) {
            this.deps.log?.('login-unreachable', errorMessage(error).slice(0, 500));
            return { ok: false, error: 'login_server_unreachable' };
          }
          await pause(Math.min(this.deps.pollIntervalMs ?? 1000, Math.max(1, deadline - Date.now())), signal);
          continue;
        }
        this.active(epoch, signal);
        if (!response.ok) {
          if (isTransientLoginStatus(response.status)) {
            if (++failures >= MAX_CONSECUTIVE_LOGIN_FAILURES) return { ok: false, error: 'login_service_unavailable' };
            await pause(Math.min(this.deps.pollIntervalMs ?? 1000, Math.max(1, deadline - Date.now())), signal);
            continue;
          }
          const rejection = loginPollRejection(response);
          this.deps.log?.('login-poll-rejected', rejection);
          return { ok: false, error: rejection };
        }
        failures = 0;
        const data = object(response.body);
        if (data.status === 'ok') {
          const token = string(data.token), user = userOf(data.user);
          if (!token || !user) {
            this.deps.log?.('login-invalid-payload', token ? 'missing user object' : 'missing token');
            return { ok: false, error: 'login_invalid_payload' };
          }
          this.active(epoch, signal);
          writePrivateJson(this.authPath(), { token, user, loggedInAt: Date.now() });
          rmSync(this.markerPath(), { force: true });
          await this.deps.onAuthChanged();
          this.deps.push('klausAuth:updated', { user });
          return { ok: true, user };
        }
        await pause(Math.min(this.deps.pollIntervalMs ?? 1000, Math.max(1, deadline - Date.now())), signal);
      }
    } catch (error) {
      return { ok: false, error: signal.aborted || this.closed || epoch !== this.epoch ? 'login cancelled' : errorMessage(error) };
    } finally {
      if (this.loginController === controller) this.loginController = undefined;
    }
  }
  guestEnter(): Json {
    if (readStoredAuth(this.configRoot) !== undefined) return { ok: false, error: 'sign out of the Klaus account before entering guest mode' };
    this.cancelLogin();
    try {
      mkdirSync(this.configRoot, { recursive: true });
      writeFileSync(this.markerPath(), '1', { mode: 0o600 });
      return { ok: true };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async logout(wipeLocal: boolean): Promise<Json> {
    if (wipeLocal && !this.deps.beforeWipeLocal) throw new IpcHandlerError('NOT_MIGRATED', 'Local data removal requires the host shutdown hook');
    const token = this.token();
    this.invalidate();
    rmSync(this.authPath(), { force: true });
    rmSync(this.markerPath(), { force: true });
    if (token) {
      try { await this.http('/api/auth/desktop/logout', { method: 'POST', headers: { authorization: 'Bearer ' + token } }); } catch { /* Local logout remains effective while offline. */ }
    }
    if (wipeLocal) await this.wipeLocal();
    await this.deps.onAuthChanged({ signedOut: true });
    this.deps.push('klausAuth:updated', { user: null });
    return { ok: true };
  }
  /** Clear a bearer token that the server revoked from another signed-in device. */
  async authorizationExpired(): Promise<void> {
    if (this.closed || !this.token()) return;
    this.invalidate();
    rmSync(this.authPath(), { force: true });
    rmSync(this.markerPath(), { force: true });
    await this.deps.onAuthChanged();
    this.deps.push('klausAuth:updated', { user: null });
  }
  wipeLocal(): Promise<Json> {
    if (this.wiping) return this.wiping;
    if (!this.deps.beforeWipeLocal) return Promise.reject(new IpcHandlerError('NOT_MIGRATED', 'Local data removal requires the host shutdown hook'));
    if (this.closed) return Promise.reject(new IpcHandlerError('HOST_CLOSED', 'Account service is closed'));
    return this.wiping = (async () => {
      await this.deps.beforeWipeLocal!();
      for (const name of ['settings.db', 'settings.db-wal', 'settings.db-shm', 'sessions', 'transcripts', 'uploads', 'pasted-text']) {
        rmSync(join(this.configRoot, name), { force: true, recursive: true });
      }
      try { await this.deps.afterWipeLocal?.(); }
      catch (error) { throw new IpcHandlerError('LOCAL_DATA_REMOVED', 'Local data was removed, but the application must be restarted manually: ' + errorMessage(error)); }
      return { ok: true };
    })();
  }
  async subscription(): Promise<Json> {
    const token = this.token();
    if (!token) return { ok: false, error: 'not_authenticated' };
    try {
      const response = await this.http('/api/subscription/me', { headers: { authorization: 'Bearer ' + token } });
      if (!response.ok) return { ok: false, error: string(object(response.body).error) || 'http_' + response.status, status: response.status };
      return { ok: true, subscription: object(response.body).subscription ?? null };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async clientConfig(): Promise<Json> {
    try {
      const token = this.token();
      const response = await this.http('/api/client/config', { headers: token ? { authorization: 'Bearer ' + token } : {} }, 4000);
      if (response.ok && response.body !== null) return { ok: true, config: response.body };
    } catch { /* The login screen retains its local defaults. */ }
    return { ok: false, error: 'config_unavailable' };
  }
  async updateProfile(displayName: string): Promise<Json> {
    return this.updateUser('/api/auth/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }) }, 'update_failed');
  }
  async uploadAvatar(mime: string, bytes: Uint8Array): Promise<Json> {
    return this.updateUser('/api/auth/avatar', { method: 'POST', headers: { 'content-type': mime }, body: Buffer.from(bytes) }, 'upload_failed');
  }
  private async updateUser(path: string, init: RequestInit, failure: string): Promise<Json> {
    const token = this.token(), epoch = this.epoch;
    if (!token) return { ok: false, error: failure };
    try {
      const headers = new Headers(init.headers); headers.set('authorization', 'Bearer ' + token);
      const response = await this.http(path, { ...init, headers });
      this.active(epoch);
      const user = response.ok ? userOf(object(response.body).user) : undefined;
      if (!user || this.token() !== token) return { ok: false, error: failure };
      writePrivateJson(this.authPath(), { ...this.stored(), user });
      this.deps.push('klausAuth:updated', { user });
      return { ok: true, user };
    } catch { return { ok: false, error: failure }; }
  }
  codexStatus(): Json {
    const path = join(this.configRoot, 'openai-subscription-oauth.json');
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); } catch { return { loggedIn: false }; }
    let value: JsonObject;
    try { value = object(JSON.parse(raw)); } catch { return { loggedIn: false, error: 'invalid_codex_store' }; }
    const accounts = object(value.accounts), ids = Object.keys(accounts);
    const preferred = string(value.defaultAccountId);
    const id = Object.hasOwn(accounts, preferred) ? preferred : ids.length === 1 ? ids[0] : undefined;
    if (id === undefined) return { loggedIn: false };
    const account = object(accounts[id]);
    return { loggedIn: true, account: typeof account.email === 'string' ? account.email : string(account.accountId), accountId: account.accountId ?? null };
  }
}
