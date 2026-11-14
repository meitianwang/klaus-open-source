import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../ipc/contract';
import { writePrivateJson } from './account-files';
import { configRootFrom } from './config-root';
import { readAntigravityCredential } from './antigravity-credential';
import { readTraeCredential, readTraeLoginDevice } from './trae-credential';
import { readKiroCredential } from './kiro-credential';
import { readCursorClientVersion } from './cursor-client-version';
import type { CursorCredentialSnapshot, LocalCursorCredential } from '../native/credentials';
import { type EngineRequest, type JsonObject, object, string, errorMessage, SerialMutations } from './service-types';

/** These capabilities are available only in the main process, never through preload. */
export interface SubscriptionCredentials {
  readClaudeOAuth(): Promise<{ value: Json | null; error?: string }>;
  readClaudeAccounts(): Promise<{ accounts: Json[]; error?: string }>;
  writeClaudeAccounts(accounts: Json[]): Promise<{ success: boolean; warning?: string; error?: string }>;
  writeClaudeOAuth(tokens: Json): Promise<{ success: boolean; warning?: string; error?: string }>;
  removeClaudeOAuth(): Promise<boolean>;
  readLocalClaudeCredential(): Promise<{ present: boolean; raw?: string; error?: string }>;
  readCursorCredential(): Promise<LocalCursorCredential>;
  readQoderIdeCredential(): Promise<{ present: boolean; userInfo?: Json; error?: string }>;
  readAntigravityKeychainSecret(): Promise<{ present: boolean; raw?: string; error?: string }>;
  readQwenWorkCredential(): Promise<{ present: boolean; userInfo?: Json; machineId?: string; error?: string }>;
  readWorkBuddyCredential(region?: 'cn' | 'intl'): Promise<{ present: boolean; userInfo?: Json; machineId?: string; error?: string }>;
}
export interface SubscriptionAuthDeps {
  configRoot?: string;
  homeDir?: string;
  request: EngineRequest;
  openExternal: (url: string) => Promise<void>;
  credentials?: SubscriptionCredentials;
  onAuthChanged: (change?: { signedOut?: boolean }) => void | Promise<void>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
  loginTimeoutMs?: number;
  codexAuthUrl?: string;
  appVersion?: string;
  cursorClientVersion?: () => Promise<string | undefined>;
  log?: (kind: string, detail: string) => void;
}
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPES = ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'];
const APPROVED_CLAUDE_DEPLOYMENTS = ['https://beacon.claude-ai.staging.ant.dev', 'https://claude.fedstart.com', 'https://claude-staging.fedstart.com'];
export function claudeOAuthConfig(customBase = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL): { authorize: string; token: string; profile: string; success: string; consoleSuccess: string } {
  const base = customBase?.trim().replace(/\/+$/, '') || undefined;
  if (base && !APPROVED_CLAUDE_DEPLOYMENTS.includes(base)) throw new Error('CLAUDE_CODE_CUSTOM_OAUTH_URL must be one of the approved deployments');
  return {
    authorize: (base ?? 'https://claude.ai') + '/oauth/authorize',
    token: (base ?? 'https://platform.claude.com') + '/v1/oauth/token',
    profile: (base ?? 'https://api.anthropic.com') + '/api/oauth/profile',
    success: (base ?? 'https://platform.claude.com') + '/oauth/code/success?app=claude-code',
    consoleSuccess: base ? base + '/oauth/code/success?app=claude-code' : 'https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
  };
}
/**
 * The engine reports a dead QwenWork login as this stable message; the host
 * keys its reread-then-refresh recovery on it rather than on prose.
 */
export function isQwenWorkLoginExpired(error: unknown): boolean {
  return errorMessage(error).includes('qwenwork_login_expired');
}

/**
 * The engine's stable code for a refresh the gateway refused: the stored
 * refresh token is dead, which for a rotated one-time token means another
 * client of the same account refreshed first and holds the only live copy.
 * The models handler answers this before its catalog fetch can produce the
 * login-expired code, so recovery has to key on both.
 */
export function isQwenWorkRefreshFailed(error: unknown): boolean {
  return errorMessage(error).includes('qwenwork_refresh_failed');
}

/** Either stable code for a stored QwenWork session only a reread of the official store can recover. */
export function isQwenWorkRecoverable(error: unknown): boolean {
  return isQwenWorkLoginExpired(error) || isQwenWorkRefreshFailed(error);
}

/** The same stable code for a dead WorkBuddy login. */
export function isWorkBuddyLoginExpired(error: unknown): boolean {
  return errorMessage(error).includes('workbuddy_login_expired');
}

export function needsCursorReadoption(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes('cursor_adopted_credential_needs_reimport') || message.includes('cursor_client_metadata_missing');
}

function cursorSnapshotDigest(info: CursorCredentialSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    accessToken: info.accessToken, expiresAt: info.expiresAt, account: info.account,
    clientVersion: info.clientVersion, backendUrl: info.backendUrl, inferenceUrl: info.inferenceUrl,
    clientIdentity: info.clientIdentity,
  })).digest('hex');
}

export function decodeTokenClaims(token: string): JsonObject {
  try { return object(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))); }
  catch { return {}; }
}
function tokenExpiry(tokens: JsonObject, accessToken: string, now = Date.now()): number | null {
  const duration = tokens.expires_in, exp = decodeTokenClaims(accessToken).exp;
  if (typeof duration === 'number' && Number.isSafeInteger(duration) && Number.isSafeInteger(now + duration * 1000)) return now + duration * 1000;
  return typeof exp === 'number' && Number.isSafeInteger(exp * 1000) ? exp * 1000 : null;
}
function readJson(path: string): JsonObject {
  try { return object(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
type SubscriptionHttpResult = { status: number; ok: boolean; data: JsonObject; message: string; headers: Headers };
const CLAUDE_OAUTH_ERRORS = new Set([
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type',
  'invalid_scope', 'access_denied', 'temporarily_unavailable', 'server_error', 'rate_limit_error',
  'authentication_error', 'permission_error', 'overloaded_error',
]);
class ClaudeTokenExchangeError extends Error {
  readonly diagnostics: JsonObject;
  constructor(response: SubscriptionHttpResult) {
    const upstream = response.data.error;
    const errorType = typeof upstream === 'string' ? upstream : string(object(upstream).type);
    const oauthError = CLAUDE_OAUTH_ERRORS.has(errorType) ? errorType : '';
    const requestId = response.headers.get('request-id') ?? '';
    const edgeTraceId = response.headers.get('cf-ray') ?? '';
    const retryAfter = response.headers.get('retry-after')?.trim() ?? '';
    let retryAfterSeconds: number | undefined;
    if (/^\d+$/.test(retryAfter)) {
      const seconds = Number(retryAfter);
      if (Number.isSafeInteger(seconds)) retryAfterSeconds = seconds;
    } else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter)) {
      const seconds = Math.max(0, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000));
      if (Number.isSafeInteger(seconds)) retryAfterSeconds = seconds;
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const diagnostics: JsonObject = {
      stage: 'token_exchange', status: response.status,
      responseFormat: contentType.includes('json') ? 'json' : contentType.includes('text/html') ? 'html' : 'other',
    };
    if (oauthError) diagnostics.oauthError = oauthError;
    if (/^req_[A-Za-z0-9_-]{1,96}$/.test(requestId)) diagnostics.requestId = requestId;
    if (/^[a-f0-9]{8,32}-[A-Z]{3}$/.test(edgeTraceId)) diagnostics.edgeTraceId = edgeTraceId;
    if (retryAfterSeconds !== undefined) diagnostics.retryAfterSeconds = retryAfterSeconds;
    let message = response.status === 401 ? 'Authentication failed: Invalid authorization code' : `Token exchange failed (${response.status})`;
    if (oauthError) message += `: ${oauthError}`;
    if (diagnostics.responseFormat === 'html') message += ' (HTML response)';
    if (retryAfterSeconds !== undefined) message += `. Retry after ${retryAfterSeconds} seconds`;
    if (diagnostics.requestId) message += `. Request ID: ${diagnostics.requestId}`;
    super(message);
    this.diagnostics = diagnostics;
  }
}
type PendingDevice = { userCode: string; expiresAt: number; epoch: number; polling?: Promise<Json> };

/** Owns HTTP requests and login listeners; engine and credential lifetimes stay external. */
export class SubscriptionAuthService {
  readonly configRoot: string;
  private readonly fetcher: NonNullable<SubscriptionAuthDeps['fetch']>;
  private readonly writes = new SerialMutations();
  private readonly pending = new Set<AbortController>();
  private readonly devices = new Map<string, PendingDevice>();
  private claudeController?: AbortController;
  private claudeEpoch = 0;
  private codexEpoch = 0;
  private qoderEpoch = 0;
  private qwenworkEpoch = 0;
  private workbuddyEpoch = 0;
  private antigravityEpoch = 0;
  private antigravityLoginFlow?: { flowId: string; epoch: number };
  private kiroEpoch = 0;
  private kiroLoginFlow?: { flowId: string; epoch: number };
  private traeEpoch = 0;
  private traeLoginFlow?: { flowId: string; epoch: number };
  private cursorEpoch = 0;
  private cursorSnapshotHash?: string;
  private cursorReadoption?: Promise<boolean>;
  private cursorLoginFlow?: { flowId: string; epoch: number };
  private closed = false;
  private closing?: Promise<void>;
  constructor(readonly deps: SubscriptionAuthDeps) {
    this.configRoot = deps.configRoot ?? configRootFrom();
    this.fetcher = deps.fetch ?? fetch;
  }
  close(): Promise<void> {
    this.closed = true; this.claudeEpoch++; this.codexEpoch++; this.qoderEpoch++; this.qwenworkEpoch++; this.workbuddyEpoch++; this.antigravityEpoch++; this.traeEpoch++; this.kiroEpoch++; this.cursorEpoch++; this.devices.clear();
    this.claudeController?.abort();
    for (const controller of this.pending) controller.abort();
    const cursorFlow = this.cursorLoginFlow;
    this.cursorLoginFlow = undefined;
    const antigravityFlow = this.antigravityLoginFlow;
    this.antigravityLoginFlow = undefined;
    const kiroFlow = this.kiroLoginFlow;
    this.kiroLoginFlow = undefined;
    const traeFlow = this.traeLoginFlow;
    this.traeLoginFlow = undefined;
    return this.closing ??= this.writes.run(async () => {
      if (cursorFlow) await this.deps.request('cursor/loginCancel', { flow: { flowId: cursorFlow.flowId } }).catch(() => {});
      if (antigravityFlow) await this.deps.request('antigravity/loginCancel', { flow: { flowId: antigravityFlow.flowId } }).catch(() => {});
      if (traeFlow) await this.deps.request('trae/loginCancel', { flow: { flowId: traeFlow.flowId } }).catch(() => {});
      if (kiroFlow) await this.deps.request('kiro/loginCancel', { flow: { flowId: kiroFlow.flowId } }).catch(() => {});
    });
  }
  private check(kind: 'claude' | 'codex', epoch: number): void {
    if (this.closed || epoch !== (kind === 'claude' ? this.claudeEpoch : this.codexEpoch)) throw new Error('Login cancelled');
  }
  private credentials(): SubscriptionCredentials {
    if (!this.deps.credentials) throw new Error('Secure credential storage is unavailable');
    return this.deps.credentials;
  }
  private async http(url: string, init: RequestInit = {}, parent?: AbortSignal, timeout = this.deps.requestTimeoutMs ?? 30_000): Promise<SubscriptionHttpResult> {
    if (this.closed || parent?.aborted) throw new Error('Login cancelled');
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    parent?.addEventListener('abort', cancel, { once: true });
    this.pending.add(controller);
    const timer = setTimeout(cancel, timeout);
    try {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
      const text = await response.text();
      let data: JsonObject = {};
      try { data = object(JSON.parse(text)); } catch { /* HTTP status and text remain available. */ }
      return { ok: response.ok, status: response.status, data, headers: response.headers, message: `${response.status} ${response.statusText}${text ? ' - ' + text : ''}` };
    } finally { clearTimeout(timer); this.pending.delete(controller); parent?.removeEventListener('abort', cancel); }
  }
  private post(url: string, body: Json, parent?: AbortSignal, headers: Record<string, string> = {}) {
    return this.http(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, parent);
  }
  private configFile(): string {
    const legacy = join(this.configRoot, '.config.json');
    return existsSync(legacy) ? legacy : join(this.configRoot, '.klaus.json');
  }
  async claudeStatus(): Promise<Json> {
    try {
      const read = await this.credentials().readClaudeAccounts();
      if (read.error) return { loggedIn: false, accounts: [], error: read.error };
      const accounts = read.accounts.map(normalizeClaudeAccount).filter((row): row is JsonObject => row !== null);
      if (accounts.length === 0) return { loggedIn: false, accounts: [] };
      const head = accounts[0]!;
      const tokens = object(head.tokens);
      const account = object(readJson(this.configFile()).oauthAccount);
      return {
        loggedIn: true,
        account: string(head.email) || string(head.displayName) || string(account.emailAddress) || string(account.displayName) || string(tokens.emailAddress) || string(tokens.account) || 'Claude',
        subscriptionType: tokens.subscriptionType ?? null,
        accounts: accounts.map((row, index) => ({ id: string(row.id), email: string(row.email), displayName: string(row.displayName), isCurrent: index === 0 })),
      };
    } catch (error) { return { loggedIn: false, accounts: [], error: errorMessage(error) }; }
  }
  /** The stored Claude account queue, head first. */
  async claudeAccounts(): Promise<JsonObject[]> {
    try {
      const read = await this.credentials().readClaudeAccounts();
      if (read.error) return [];
      return read.accounts.map(normalizeClaudeAccount).filter((row): row is JsonObject => row !== null);
    } catch { return []; }
  }
  private async saveClaudeAccounts(accounts: JsonObject[], previous: JsonObject[], epoch: number) {
    this.check('claude', epoch);
    const saved = await this.credentials().writeClaudeAccounts(accounts);
    if (saved.success && (this.closed || this.claudeEpoch !== epoch)) {
      // The mutation queue prevents a newer login from being erased here.
      if (!await this.credentials().writeClaudeAccounts(previous)) throw new Error('Could not discard a cancelled credential write');
      throw new Error('Login cancelled');
    }
    return saved;
  }
  /** Append an account to the queue, or refresh the stored tokens of the same
   *  account when the login lands on one already in the queue. */
  private async upsertClaudeAccount(tokens: JsonObject, meta: JsonObject, epoch: number): Promise<{ saved: { success: boolean; warning?: string; error?: string }; accountId: string; updatedExisting: boolean }> {
    const previous = await this.claudeAccounts();
    const accounts = previous.map(row => ({ ...row }));
    const email = string(meta.emailAddress), organization = string(meta.organizationUuid);
    const refresh = string(tokens.refreshToken);
    let match = accounts.find(row => {
      if (email) return string(row.email) === email && string(row.organizationUuid) === organization;
      const storedRefresh = string(object(row.tokens).refreshToken);
      return refresh.length > 0 && storedRefresh === refresh;
    });
    // A pre-multi-account file holds exactly one legacy row: a fresh login
    // upgrades it in place instead of stacking a second account on a store
    // that never had one, preserving the plan fields the login did not report.
    if (!match && accounts.length === 1 && string(accounts[0]!.id) === 'legacy') match = accounts[0];
    if (match && string(match.id) === 'legacy') match.id = randomUUID();
    if (match) {
      // Absent fields of the new credential keep the stored value, so a
      // re-login that no longer reports a plan tier does not erase it.
      const merged: JsonObject = { ...object(match.tokens) };
      for (const [key, value] of Object.entries(tokens)) {
        if (value !== null && value !== undefined) merged[key] = value;
      }
      match.tokens = merged;
      for (const key of ['email', 'displayName', 'accountUuid', 'organizationUuid'] as const) {
        const value = string(meta[key]);
        if (value) match[key] = value;
      }
      const saved = await this.saveClaudeAccounts(accounts, previous, epoch);
      return { saved, accountId: string(match.id), updatedExisting: true };
    }
    const accountId = randomUUID();
    accounts.push({ id: accountId, addedAt: Date.now(), ...meta, tokens });
    const saved = await this.saveClaudeAccounts(accounts, previous, epoch);
    return { saved, accountId, updatedExisting: false };
  }
  private async syncClaudeAccountMeta(): Promise<void> {
    const accounts = await this.claudeAccounts();
    const head = accounts[0];
    if (!head) return;
    const row: JsonObject = head
      ? {
        ...(string(head.accountUuid) ? { accountUuid: string(head.accountUuid) } : {}),
        ...(string(head.email) ? { emailAddress: string(head.email) } : {}),
        ...(string(head.organizationUuid) ? { organizationUuid: string(head.organizationUuid) } : {}),
        ...(string(head.displayName) ? { displayName: string(head.displayName) } : {}),
      }
      : {};
    writePrivateJson(this.configFile(), { ...readJson(this.configFile()), oauthAccount: row });
  }
  async claudeImportLocal(): Promise<Json> {
    const epoch = ++this.claudeEpoch;
    this.claudeController?.abort();
    try {
      const local = await this.credentials().readLocalClaudeCredential();
      this.check('claude', epoch);
      if (local.error) return { ok: false, error: local.error };
      if (!local.present || !local.raw) return { ok: false, error: 'claude_cli_credentials_not_found' };
      let parsed: JsonObject;
      try { parsed = object(JSON.parse(local.raw)); } catch { return { ok: false, error: 'claude_cli_credentials_invalid' }; }
      const tokens = object(parsed.claudeAiOauth ?? parsed);
      if (!string(tokens.accessToken)) return { ok: false, error: 'claude_cli_credentials_have_no_token' };
      return await this.writes.run(async (): Promise<Json> => {
        this.check('claude', epoch);
        const meta: JsonObject = {
          ...(string(parsed.emailAddress) ? { email: string(parsed.emailAddress) } : {}),
          ...(string(parsed.displayName) ? { displayName: string(parsed.displayName) } : {}),
        };
        const { saved, accountId, updatedExisting } = await this.upsertClaudeAccount(tokens, meta, epoch);
        if (!saved.success) return { ok: false, error: saved.error ?? 'credential_store_write_failed' };
        this.check('claude', epoch);
        await this.syncClaudeAccountMeta();
        await this.deps.onAuthChanged();
        return { ok: true, loggedIn: true, accountId, updatedExisting, ...(saved.warning ? { warning: saved.warning } : {}) };
      });
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async claudeLogout(accountId?: string): Promise<Json> {
    ++this.claudeEpoch; this.claudeController?.abort();
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (!accountId) {
          if (!await this.credentials().removeClaudeOAuth()) return { ok: false, error: 'credential_store_delete_failed' };
        } else {
          const accounts = await this.claudeAccounts();
          const remaining = accounts.filter(row => string(row.id) !== accountId);
          if (remaining.length === accounts.length) return { ok: false, error: 'claude_account_not_found' };
          const saved = await this.credentials().writeClaudeAccounts(remaining);
          if (!saved.success) return { ok: false, error: saved.error ?? 'credential_store_delete_failed' };
        }
        await this.syncClaudeAccountMeta();
        await this.deps.onAuthChanged({ signedOut: true }); return { ok: true };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }
  /** Move a queued Claude account to the head so new and live inference uses it immediately. */
  async claudeSwitchAccount(accountId: string): Promise<Json> {
    const targetId = accountId.trim();
    if (!targetId) return { ok: false, error: 'claude_account_not_found' };
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (this.closed) return { ok: false, error: 'Login cancelled' };
        const read = await this.credentials().readClaudeAccounts();
        if (read.error) return { ok: false, error: read.error };
        const accounts = read.accounts.map(normalizeClaudeAccount).filter((row): row is JsonObject => row !== null);
        const index = accounts.findIndex(row => string(row.id) === targetId);
        if (index < 0) return { ok: false, error: 'claude_account_not_found' };
        if (index > 0) {
          const selected = accounts[index]!;
          const reordered = [selected, ...accounts.slice(0, index), ...accounts.slice(index + 1)];
          const saved = await this.credentials().writeClaudeAccounts(reordered);
          if (!saved.success) return { ok: false, error: saved.error ?? 'credential_store_write_failed' };
        }
        await this.syncClaudeAccountMeta();
        await this.deps.onAuthChanged();
        return { ok: true, accountId: targetId };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }
  async claudeLogin(): Promise<Json> {
    const epoch = ++this.claudeEpoch;
    this.claudeController?.abort();
    const controller = new AbortController(); this.claudeController = controller;
    let browserResponse: ServerResponse | undefined;
    const listener = createServer();
    const timer = setTimeout(() => controller.abort(), this.deps.loginTimeoutMs ?? 10 * 60_000);
    try {
      this.check('claude', epoch);
      this.credentials();
      const config = claudeOAuthConfig();
      const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
      const captured = new Promise<string>((resolve, reject) => {
        const cancel = (): void => reject(new Error('Login cancelled'));
        controller.signal.addEventListener('abort', cancel, { once: true });
        listener.on('request', (request, response) => {
          let url: URL;
          try { url = new URL(request.url ?? '/', 'http://localhost'); }
          catch { response.writeHead(400).end(); return; }
          if (request.method !== 'GET' || url.pathname !== '/callback') { response.writeHead(404).end(); return; }
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.get('state') !== state) {
            const message = !code ? 'No authorization code received' : 'Invalid state parameter';
            response.writeHead(400, { 'content-type': 'text/plain' }).end(message); reject(new Error(message)); return;
          }
          if (browserResponse) { response.writeHead(409).end(); return; }
          browserResponse = response; resolve(code);
        });
        listener.on('error', reject);
      });
      // Attach a rejection handler before browser handoff or bind can fail.
      void captured.catch(() => {});
      await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve(); }); });
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('OAuth callback server closed');
      const redirect = `http://localhost:${address.port}/callback`;
      const url = new URL(config.authorize);
      for (const [key, value] of Object.entries({ code: 'true', client_id: CLAUDE_CLIENT_ID, response_type: 'code', redirect_uri: redirect, scope: SCOPES.join(' '), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state })) url.searchParams.set(key, value);
      // The listener is already active; external browser handoff must not own its lifetime.
      void this.deps.openExternal(url.href).catch(() => {});
      const code = await captured;
      this.check('claude', epoch);
      // The token API can reject Electron's browser identity before validating the grant.
      const exchanged = await this.post(config.token, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: CLAUDE_CLIENT_ID, code_verifier: verifier, state }, controller.signal, { 'user-agent': `Klaus/${this.deps.appVersion ?? 'development'}` });
      if (!exchanged.ok) throw new ClaudeTokenExchangeError(exchanged);
      const tokens = exchanged.data, access = string(tokens.access_token), refresh = string(tokens.refresh_token), duration = tokens.expires_in;
      if (!access) throw new Error('Token exchange returned no access token');
      const scopes = string(tokens.scope).split(' ').filter(Boolean);
      if (!scopes.includes('user:inference') || !refresh || typeof duration !== 'number' || duration <= 0 || !Number.isSafeInteger(Date.now() + duration * 1000)) {
        throw new Error('Authorization did not grant a renewable Claude subscription credential');
      }
      let profile: JsonObject = {};
      try { const response = await this.http(config.profile, { headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' } }, controller.signal, 10_000); if (response.ok) profile = response.data; } catch { /* A transient profile failure does not discard a valid credential. */ }
      this.check('claude', epoch);
      const result = await this.writes.run(async (): Promise<Json> => {
        this.check('claude', epoch);
        const organization = object(profile.organization);
        const plan = ({ claude_max: 'max', claude_pro: 'pro', claude_enterprise: 'enterprise', claude_team: 'team' } as Record<string, string>)[string(organization.organization_type)];
        const account = object(tokens.account);
        const email = string(account.email_address);
        const orgId = object(tokens.organization).uuid;
        const displayName = object(profile.account).display_name ?? object(profile.account).displayName ?? profile.display_name ?? profile.displayName;
        const credentialTokens: JsonObject = {
          accessToken: access, refreshToken: refresh, expiresAt: Date.now() + duration * 1000, scopes,
          ...(plan ? { subscriptionType: plan } : {}),
          ...(organization.rate_limit_tier ? { rateLimitTier: organization.rate_limit_tier } : {}),
        };
        const meta: JsonObject = {
          ...(string(account.uuid) ? { accountUuid: string(account.uuid) } : {}),
          ...(email ? { email: email } : {}),
          ...(orgId !== null && orgId !== undefined ? { organizationUuid: orgId } : {}),
          ...(typeof displayName === 'string' ? { displayName } : {}),
        };
        this.check('claude', epoch);
        const { saved, accountId, updatedExisting } = await this.upsertClaudeAccount(credentialTokens, meta, epoch);
        if (!saved.success) throw new Error(saved.error ?? 'Failed to save tokens');
        this.check('claude', epoch);
        await this.syncClaudeAccountMeta();
        await this.deps.onAuthChanged();
        return { ok: true, accountId, updatedExisting, ...(saved.warning ? { warning: saved.warning } : {}) };
      });
      browserResponse?.writeHead(302, { location: config.success }).end();
      return result;
    } catch (error) {
      browserResponse?.writeHead(400, { 'content-type': 'text/plain' }).end('Authorization failed. Return to Klaus and try again.');
      return { ok: false, error: errorMessage(error), ...(error instanceof ClaudeTokenExchangeError ? { diagnostics: error.diagnostics } : {}) };
    } finally {
      clearTimeout(timer); controller.abort(); listener.closeAllConnections(); listener.close();
      if (this.claudeController === controller) this.claudeController = undefined;
    }
  }
  private codexUrl(): string { return ((this.deps.codexAuthUrl ?? process.env.KLAUS_CODEX_AUTH_URL)?.trim() || 'https://auth.openai.com').replace(/\/+$/, ''); }
  private codexPath(): string { return join(this.configRoot, 'openai-subscription-oauth.json'); }
  /** Host-only quota reader. Tokens never cross an IPC response. */
  private selectCodexAccount(store: JsonObject): { key: string; account: JsonObject } | undefined {
    const accounts = object(store.accounts), preferred = string(store.defaultAccountId), ids = Object.keys(accounts);
    const key = Object.hasOwn(accounts, preferred) ? preferred : ids.length === 1 ? ids[0] : undefined;
    return key === undefined ? undefined : { key, account: object(accounts[key]) };
  }
  codexAccessToken(signal?: AbortSignal): Promise<{ accessToken: string; accountId: string } | undefined> {
    const epoch = this.codexEpoch;
    return this.writes.run(async () => {
      this.check('codex', epoch); signal?.throwIfAborted();
      const initial = this.selectCodexAccount(readJson(this.codexPath())); if (!initial) return undefined;
      const account = initial.account, accountId = string(account.accountId), stored = string(account.accessToken);
      if (!accountId) throw new Error('Codex account has no account ID');
      const expires = typeof account.accessTokenExpiresAt === 'number' ? account.accessTokenExpiresAt : Number(decodeTokenClaims(stored).exp) * 1000;
      if (stored && Number.isFinite(expires) && expires > Date.now() + 60_000) return { accessToken: stored, accountId };
      const refresh = string(account.refreshToken);
      if (!refresh) {
        // A copied login with no refresh token can never renew itself, but the
        // official client may still hold a live pair; rereading it costs no
        // credential and restores the login without user action.
        if (await this.readoptCodexLocal(epoch)) return this.currentCodexToken();
        throw new Error('Codex login needs renewal; reuse the local login or sign in again');
      }
      const response = await this.http(this.codexUrl() + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'klaus-desktop' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CODEX_CLIENT_ID, scope: 'openid profile email' }).toString() }, signal);
      this.check('codex', epoch); signal?.throwIfAborted();
      if (!response.ok) {
        // A rotation-shaped refusal means the official client refreshed first
        // and invalidated this copy of the refresh token. Its own store then
        // holds the live pair, so adopt it before reporting a dead login.
        if ((response.status === 400 || response.status === 401 || response.status === 403) && await this.readoptCodexLocal(epoch)) return this.currentCodexToken();
        throw new Error(`Codex token refresh failed (HTTP ${response.status}); retry or reuse the local login`);
      }
      const tokens = response.data, accessToken = string(tokens.access_token), idToken = string(tokens.id_token);
      if (!accessToken) throw new Error('Codex token refresh returned no access token');
      const claims = decodeTokenClaims(idToken || accessToken), nextId = string(object(claims['https://api.openai.com/auth']).chatgpt_account_id) || accountId;
      const store = readJson(this.codexPath()), current = this.selectCodexAccount(store);
      if (!current || current.key !== initial.key || JSON.stringify(current.account) !== JSON.stringify(account)) throw new Error('Codex login changed during refresh; retry with the current login');
      const accounts = object(store.accounts);
      if (nextId !== initial.key && Object.hasOwn(accounts, nextId)) throw new Error('Codex refresh conflicts with another stored account');
      delete accounts[initial.key];
      accounts[nextId] = { ...account, accountId: nextId, refreshToken: string(tokens.refresh_token) || refresh, accessToken, ...(idToken ? { idToken } : {}), accessTokenExpiresAt: tokenExpiry(tokens, accessToken), updatedAt: Date.now() };
      this.check('codex', epoch); signal?.throwIfAborted();
      writePrivateJson(this.codexPath(), { ...store, accounts, defaultAccountId: nextId });
      return { accessToken, accountId: nextId };
    });
  }
  async codexStart(): Promise<Json> {
    const epoch = this.codexEpoch;
    try {
      this.check('codex', epoch);
      const configured = process.env.KLAUS_CODEX_CLIENT_VERSION?.trim() ?? '';
      const version = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(configured) ? configured : '0.159.2';
      const os = process.platform === 'darwin' ? 'Mac OS' : process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform;
      const response = await this.post(this.codexUrl() + '/api/accounts/deviceauth/usercode', { client_id: CODEX_CLIENT_ID }, undefined, { 'User-Agent': `codex_cli_rs/${version} (${os} ${release()}; ${process.arch})` });
      this.check('codex', epoch);
      if (!response.ok) return { ok: false, error: response.message };
      const code = string(response.data.device_auth_id), userCode = string(response.data.user_code);
      if (!code || !userCode) return { ok: false, error: 'device auth returned invalid payload' };
      const expiresIn = typeof response.data.expires_in === 'number' && response.data.expires_in > 0 ? response.data.expires_in : 900;
      const requestedInterval = Number(response.data.interval), interval = Number.isInteger(requestedInterval) && requestedInterval > 0 ? requestedInterval : 5;
      const expiresAt = Date.now() + expiresIn * 1000;
      this.devices.set(code, { userCode, expiresAt, epoch });
      void this.deps.openExternal('https://auth.openai.com/codex/device').catch(() => {});
      return { ok: true, deviceCode: code, userCode, verificationUri: 'https://auth.openai.com/codex/device', expiresIn, expiresAt, interval };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  codexPoll(deviceCode: string): Promise<Json> {
    if (!deviceCode) return Promise.resolve({ ok: false, error: 'Invalid deviceCode' });
    const flow = this.devices.get(deviceCode);
    if (!flow || flow.expiresAt <= Date.now()) {
      this.devices.delete(deviceCode); return Promise.resolve({ ok: false, expired: true, error: 'Login flow expired. Start again.' });
    }
    if (flow.polling) return flow.polling;
    flow.polling = this.pollDevice(deviceCode, flow).finally(() => { flow.polling = undefined; });
    return flow.polling;
  }
  private async pollDevice(code: string, flow: PendingDevice): Promise<Json> {
    try {
      this.check('codex', flow.epoch);
      const response = await this.post(this.codexUrl() + '/api/accounts/deviceauth/token', { device_auth_id: code, user_code: flow.userCode });
      this.check('codex', flow.epoch);
      if (response.status === 403 || response.status === 404) return { ok: false, pending: true };
      if (response.status === 410 || flow.expiresAt <= Date.now()) { this.devices.delete(code); return { ok: false, expired: true, error: 'Login flow expired. Start again.' }; }
      if (!response.ok) return { ok: false, error: response.message };
      const authorizationCode = string(response.data.authorization_code);
      if (!authorizationCode) return { ok: false, pending: true };
      const exchanged = await this.post(this.codexUrl() + '/oauth/token', { grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID, code: authorizationCode, code_verifier: string(response.data.code_verifier), redirect_uri: 'https://auth.openai.com/deviceauth/callback' });
      this.check('codex', flow.epoch);
      if (!exchanged.ok) return { ok: false, error: `token exchange failed (${exchanged.status})` };
      if (!string(exchanged.data.access_token)) return { ok: false, error: 'token exchange returned no access token' };
      const result = await this.storeCodex(exchanged.data, flow.epoch, false);
      this.devices.delete(code); return result;
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  /** Write core shared by the login flows and the dead-copy recovery below. */
  private publishCodex(tokens: JsonObject, epoch: number, imported: boolean): Json {
    this.check('codex', epoch);
    const access = string(tokens.access_token), idToken = string(tokens.id_token), claims = decodeTokenClaims(idToken || access);
    const accountId = (imported ? string(tokens.account_id) : '') || string(object(claims['https://api.openai.com/auth']).chatgpt_account_id) || (!imported ? string(claims.sub) : '') || 'codex-account';
    const email = string(claims.email), store = readJson(this.codexPath()), accounts = object(store.accounts);
    accounts[accountId] = { accountId, email, refreshToken: string(tokens.refresh_token), accessToken: access, ...(idToken ? { idToken } : {}), accessTokenExpiresAt: tokenExpiry(imported ? {} : tokens, access), updatedAt: Date.now() };
    writePrivateJson(this.codexPath(), { ...store, accounts, defaultAccountId: accountId });
    return { ok: true, account: email || accountId, accountId };
  }
  private storeCodex(tokens: JsonObject, epoch: number, imported: boolean): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const published = this.publishCodex(tokens, epoch, imported);
      await this.deps.onAuthChanged();
      return published;
    });
  }
  /**
   * Reread the official Codex client's login after this copy of it died. The
   * official client rotates refresh tokens on its own refresh, which invalidates
   * every copy Klaus imported earlier; its store is then the only place the live
   * pair still exists. Only a still-valid access token is adopted, so a dead
   * official login falls through to the ordinary renewal error. Runs inside an
   * outer mutation, so it must not enter the write queue again.
   */
  private async readoptCodexLocal(epoch: number): Promise<boolean> {
    try {
      const path = join(this.deps.homeDir ?? homedir(), '.codex', 'auth.json');
      if (!existsSync(path)) return false;
      const tokens = object(object(readJson(path)).tokens);
      const access = string(tokens.access_token);
      const exp = Number(decodeTokenClaims(access).exp) * 1000;
      if (!access || !Number.isFinite(exp) || exp <= Date.now() + 60_000) return false;
      this.publishCodex(tokens, epoch, true);
      await this.deps.onAuthChanged();
      return true;
    } catch { return false; }
  }
  /** The token just published by a recovery, read back from the store. */
  private currentCodexToken(): { accessToken: string; accountId: string } | undefined {
    const selected = this.selectCodexAccount(readJson(this.codexPath()));
    if (!selected) return undefined;
    const accessToken = string(selected.account.accessToken), accountId = string(selected.account.accountId);
    return accessToken && accountId ? { accessToken, accountId } : undefined;
  }
  async codexImportLocal(): Promise<Json> {
    const epoch = ++this.codexEpoch; this.devices.clear();
    try {
      const path = join(this.deps.homeDir ?? homedir(), '.codex', 'auth.json');
      if (!existsSync(path)) return { ok: false, error: 'codex_cli_auth_not_found' };
      let parsed: JsonObject;
      try { parsed = readJson(path); } catch { return { ok: false, error: 'codex_cli_auth_invalid' }; }
      const tokens = object(parsed.tokens);
      if (!string(tokens.refresh_token) && !string(tokens.access_token)) return { ok: false, error: 'codex_cli_auth_has_no_tokens' };
      return await this.storeCodex(tokens, epoch, true);
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async codexLogout(): Promise<Json> {
    ++this.codexEpoch; this.devices.clear();
    return this.writes.run(async (): Promise<Json> => {
      try {
        const store = readJson(this.codexPath()), accounts = object(store.accounts);
        const id = string(store.defaultAccountId) || (Object.keys(accounts).length === 1 ? Object.keys(accounts)[0]! : '');
        if (id) { delete accounts[id]; if (store.defaultAccountId === id) delete store.defaultAccountId; }
        writePrivateJson(this.codexPath(), { ...store, accounts });
        await this.deps.onAuthChanged({ signedOut: true }); return { ok: true };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }
  async qoderImportLocal(): Promise<Json> {
    const epoch = ++this.qoderEpoch;
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (this.closed || epoch !== this.qoderEpoch) throw new Error('Account operation cancelled');
        const local = await this.credentials().readQoderIdeCredential();
        if (this.closed || epoch !== this.qoderEpoch) throw new Error('Account operation cancelled');
        const imported = local.userInfo !== undefined
          ? object(await this.deps.request('qoder/adoptCredential', { userInfo: local.userInfo }))
          : object(await this.deps.request('qoder/importLocal', {}));
        if (this.closed || epoch !== this.qoderEpoch) {
          await this.deps.request('qoder/logout', {}); throw new Error('Account operation cancelled');
        }
        if (imported.ok === true) { await this.deps.onAuthChanged(); return imported; }
        if (local.userInfo !== undefined || !local.present) return imported;
        return { ok: false, error: local.error ?? 'qoder_ide_credentials_unavailable' };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }
  async qoderLogout(): Promise<Json> {
    ++this.qoderEpoch;
    return this.writes.run(async (): Promise<Json> => {
      const result = object(await this.deps.request('qoder/logout', {}));
      await this.deps.onAuthChanged({ signedOut: true }); return result;
    });
  }
  async kiroStart(): Promise<Json> {
    const epoch = ++this.kiroEpoch, previous = this.kiroLoginFlow;
    this.kiroLoginFlow = undefined;
    const stale = (): boolean => this.closed || epoch !== this.kiroEpoch;
    return this.writes.run(async (): Promise<Json> => {
      let flowId: string | undefined;
      try {
        if (previous) await this.deps.request('kiro/loginCancel', { flow: { flowId: previous.flowId } });
        if (stale()) throw new Error('kiro_login_cancelled');
        const result = object(await this.deps.request('kiro/loginStart', {}));
        flowId = typeof result.flowId === 'string' ? result.flowId : undefined;
        if (stale()) throw new Error('kiro_login_cancelled');
        if (result.ok !== true) return result;
        let url: URL;
        try { url = new URL(string(result.authUrl)); }
        catch { throw new Error('kiro_login_url_invalid'); }
        if (!flowId || url.origin !== 'https://app.kiro.dev' || url.pathname !== '/signin'
          || url.username || url.password || url.hash) throw new Error('kiro_login_url_invalid');
        this.kiroLoginFlow = { flowId, epoch };
        try { await this.deps.openExternal(url.href); }
        catch { throw new Error('kiro_login_browser_failed'); }
        if (stale()) throw new Error('kiro_login_cancelled');
        return result;
      } catch (error) {
        if (this.kiroLoginFlow?.epoch === epoch) this.kiroLoginFlow = undefined;
        if (flowId) await this.deps.request('kiro/loginCancel', { flow: { flowId } }).catch(() => {});
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  async kiroPoll(flowId: string): Promise<Json> {
    const flow = this.kiroLoginFlow;
    const stale = (): boolean => this.closed || !flow || flow.flowId !== flowId
      || flow.epoch !== this.kiroEpoch || this.kiroLoginFlow !== flow;
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (stale()) return { ok: false, error: 'kiro_login_cancelled' };
        const result = object(await this.deps.request('kiro/loginPoll', { flow: { flowId } }));
        if (stale()) {
          await this.deps.request('kiro/loginCancel', { flow: { flowId } }).catch(() => {});
          return { ok: false, error: 'kiro_login_cancelled' };
        }
        if (result.pending === true || result.status === 'pending') return { ...result, ok: false, pending: true };
        this.kiroLoginFlow = undefined;
        if (result.ok === true) {
          try { await this.deps.onAuthChanged(); }
          catch { this.deps.log?.('kiro-auth', 'Account notification failed after credential commit'); }
          if (this.closed || flow!.epoch !== this.kiroEpoch) return { ok: false, error: 'kiro_login_cancelled' };
        }
        return result;
      } catch (error) {
        if (this.kiroLoginFlow === flow) this.kiroLoginFlow = undefined;
        await this.deps.request('kiro/loginCancel', { flow: { flowId } }).catch(() => {});
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  async kiroCancel(flowId: string): Promise<Json> {
    if (this.closed || this.kiroLoginFlow?.flowId !== flowId) return { ok: true, cancelled: true };
    ++this.kiroEpoch;
    this.kiroLoginFlow = undefined;
    return object(await this.deps.request('kiro/loginCancel', { flow: { flowId } }));
  }

  async kiroImportLocal(): Promise<Json> {
    const epoch = ++this.kiroEpoch, previous = this.kiroLoginFlow;
    this.kiroLoginFlow = undefined;
    return this.writes.run(async (): Promise<Json> => {
      const stale = (): boolean => this.closed || epoch !== this.kiroEpoch;
      try {
        if (previous) await this.deps.request('kiro/loginCancel', { flow: { flowId: previous.flowId } });
        if (stale()) throw new Error('kiro_login_cancelled');
        const credential = await readKiroCredential(this.deps.homeDir);
        if (stale()) throw new Error('kiro_login_cancelled');
        const localFollow = typeof credential.profileArn === 'string' && credential.profileArn.length > 0;
        const result = object(await this.deps.request('kiro/adoptCredential', { credential, localFollow }));
        if (stale()) {
          await this.deps.request('kiro/logout', {});
          throw new Error('kiro_login_cancelled');
        }
        if (result.ok === true) {
          try { await this.deps.onAuthChanged(); }
          catch { this.deps.log?.('kiro-auth', 'Account notification failed after credential commit'); }
        }
        if (stale()) throw new Error('kiro_login_cancelled');
        return result;
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }

  async kiroLogout(): Promise<Json> {
    ++this.kiroEpoch;
    const previous = this.kiroLoginFlow;
    this.kiroLoginFlow = undefined;
    return this.writes.run(async (): Promise<Json> => {
      if (previous) await this.deps.request('kiro/loginCancel', { flow: { flowId: previous.flowId } });
      if (this.closed) return { ok: false, error: 'kiro_login_cancelled' };
      const result = object(await this.deps.request('kiro/logout', {}));
      try { await this.deps.onAuthChanged({ signedOut: true }); }
      catch { this.deps.log?.('kiro-auth', 'Account notification failed after disconnect'); }
      return result;
    });
  }

  async traeStart(): Promise<Json> {
    const epoch = ++this.traeEpoch, previous = this.traeLoginFlow;
    this.traeLoginFlow = undefined;
    const stale = (): boolean => this.closed || epoch !== this.traeEpoch;
    return this.writes.run(async (): Promise<Json> => {
      let flowId: string | undefined;
      try {
        if (previous) await this.deps.request('trae/loginCancel', { flow: { flowId: previous.flowId } });
        if (stale()) throw new Error('trae_login_cancelled');
        // Preserve existing device proof when the service deduplicates its identity.
        const device = await readTraeLoginDevice(this.deps.homeDir);
        if (stale()) throw new Error('trae_login_cancelled');
        const result = object(await this.deps.request('trae/loginStart', {
          excludedDeviceIds: device.excludedDeviceIds,
          ...(device.localDeviceProof ? { localDeviceProof: { ...device.localDeviceProof } } : {}),
        }));
        flowId = typeof result.flowId === 'string' ? result.flowId : undefined;
        if (stale()) throw new Error('trae_login_cancelled');
        if (result.ok !== true) return result;
        let url: URL;
        try { url = new URL(string(result.authUrl)); }
        catch { throw new Error('trae_login_url_invalid'); }
        if (!flowId || url.origin !== 'https://www.trae.cn' || url.pathname !== '/authorization'
          || url.username || url.password || url.hash) throw new Error('trae_login_url_invalid');
        this.traeLoginFlow = { flowId, epoch };
        try { await this.deps.openExternal(url.href); }
        catch { throw new Error('trae_login_browser_failed'); }
        if (stale()) throw new Error('trae_login_cancelled');
        return result;
      } catch (error) {
        if (this.traeLoginFlow?.epoch === epoch) this.traeLoginFlow = undefined;
        if (flowId) await this.deps.request('trae/loginCancel', { flow: { flowId } }).catch(() => {});
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  async traePoll(flowId: string): Promise<Json> {
    const flow = this.traeLoginFlow;
    const stale = (): boolean => this.closed || !flow || flow.flowId !== flowId
      || flow.epoch !== this.traeEpoch || this.traeLoginFlow !== flow;
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (stale()) return { ok: false, error: 'trae_login_cancelled' };
        const result = object(await this.deps.request('trae/loginPoll', { flow: { flowId } }));
        if (stale()) {
          await this.deps.request('trae/loginCancel', { flow: { flowId } }).catch(() => {});
          return { ok: false, error: 'trae_login_cancelled' };
        }
        if (result.pending === true || result.status === 'pending') return { ...result, ok: false, pending: true };
        if (result.ok === true) {
          // A committed login no longer belongs to the card's unmount cancellation.
          this.traeLoginFlow = undefined;
          try { await this.deps.onAuthChanged(); }
          catch { this.deps.log?.('trae-auth', 'Account notification failed after credential commit'); }
          if (this.closed || flow!.epoch !== this.traeEpoch) return { ok: false, error: 'trae_login_cancelled' };
        } else this.traeLoginFlow = undefined;
        return result;
      } catch (error) {
        if (this.traeLoginFlow === flow) this.traeLoginFlow = undefined;
        await this.deps.request('trae/loginCancel', { flow: { flowId } }).catch(() => {});
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  async traeCancel(flowId: string): Promise<Json> {
    if (this.closed || this.traeLoginFlow?.flowId !== flowId) return { ok: true, cancelled: true };
    ++this.traeEpoch;
    this.traeLoginFlow = undefined;
    return object(await this.deps.request('trae/loginCancel', { flow: { flowId } }));
  }

  async traeImportLocal(): Promise<Json> {
    const epoch = ++this.traeEpoch, previous = this.traeLoginFlow;
    this.traeLoginFlow = undefined;
    return this.writes.run(async (): Promise<Json> => {
      const stale = (): boolean => this.closed || epoch !== this.traeEpoch;
      try {
        if (previous) await this.deps.request('trae/loginCancel', { flow: { flowId: previous.flowId } });
        if (stale()) throw new Error('trae_login_cancelled');
        const credential = await readTraeCredential(this.deps.homeDir);
        if (stale()) throw new Error('trae_login_cancelled');
        const result = object(await this.deps.request('trae/adoptCredential', { credential }));
        if (stale()) {
          await this.deps.request('trae/logout', {});
          throw new Error('trae_login_cancelled');
        }
        if (result.ok === true) {
          try { await this.deps.onAuthChanged(); }
          catch { this.deps.log?.('trae-auth', 'Account notification failed after credential commit'); }
        }
        if (stale()) throw new Error('trae_login_cancelled');
        return result;
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }

  async traeLogout(): Promise<Json> {
    ++this.traeEpoch;
    const previous = this.traeLoginFlow;
    this.traeLoginFlow = undefined;
    return this.writes.run(async (): Promise<Json> => {
      if (previous) await this.deps.request('trae/loginCancel', { flow: { flowId: previous.flowId } });
      if (this.closed) return { ok: false, error: 'trae_login_cancelled' };
      const result = object(await this.deps.request('trae/logout', {}));
      try { await this.deps.onAuthChanged({ signedOut: true }); }
      catch { this.deps.log?.('trae-auth', 'Account notification failed after disconnect'); }
      return result;
    });
  }

  async antigravityStart(): Promise<Json> {
    const epoch = ++this.antigravityEpoch;
    const previousFlow = this.antigravityLoginFlow;
    this.antigravityLoginFlow = undefined;
    const stale = (): boolean => this.closed || epoch !== this.antigravityEpoch;
    return this.writes.run(async (): Promise<Json> => {
      let flowId: string | undefined;
      try {
        if (previousFlow) await this.deps.request('antigravity/loginCancel', { flow: { flowId: previousFlow.flowId } });
        if (stale()) throw new Error('antigravity_login_cancelled');
        const result = object(await this.deps.request('antigravity/loginStart', {}));
        flowId = typeof result.flowId === 'string' ? result.flowId : undefined;
        if (stale()) throw new Error('antigravity_login_cancelled');
        if (result.ok !== true) return result;
        let url: URL;
        try { url = new URL(string(result.authUrl)); }
        catch { throw new Error('antigravity_login_url_invalid'); }
        if (!flowId || url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/auth'
          || url.username || url.password || url.hash) throw new Error('antigravity_login_url_invalid');
        this.antigravityLoginFlow = { flowId, epoch };
        try { await this.deps.openExternal(url.href); }
        catch { throw new Error('antigravity_login_browser_failed'); }
        if (stale()) throw new Error('antigravity_login_cancelled');
        return result;
      } catch (error) {
        if (this.antigravityLoginFlow?.epoch === epoch) this.antigravityLoginFlow = undefined;
        if (flowId) await this.deps.request('antigravity/loginCancel', { flow: { flowId } }).catch(() => {});
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  async antigravityPoll(flowId: string): Promise<Json> {
    const flow = this.antigravityLoginFlow;
    const stale = (): boolean => this.closed || !flow || flow.flowId !== flowId
      || flow.epoch !== this.antigravityEpoch || this.antigravityLoginFlow !== flow;
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (stale()) return { ok: false, error: 'antigravity_login_cancelled' };
        const result = object(await this.deps.request('antigravity/loginPoll', { flow: { flowId } }));
        if (stale()) {
          await this.deps.request('antigravity/loginCancel', { flow: { flowId } }).catch(() => {});
          return { ok: false, error: 'antigravity_login_cancelled' };
        }
        if (result.ok === true) {
          await this.deps.onAuthChanged();
          if (stale()) {
            await this.deps.request('antigravity/loginCancel', { flow: { flowId } }).catch(() => {});
            return { ok: false, error: 'antigravity_login_cancelled' };
          }
          this.antigravityLoginFlow = undefined;
        } else if (result.pending !== true) this.antigravityLoginFlow = undefined;
        return result;
      } catch (error) {
        if (this.antigravityLoginFlow === flow) this.antigravityLoginFlow = undefined;
        await this.deps.request('antigravity/loginCancel', { flow: { flowId } }).catch(() => {});
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  async antigravityCancel(flowId: string): Promise<Json> {
    if (this.closed || this.antigravityLoginFlow?.flowId !== flowId) return { ok: true, cancelled: true };
    ++this.antigravityEpoch;
    this.antigravityLoginFlow = undefined;
    return object(await this.deps.request('antigravity/loginCancel', { flow: { flowId } }));
  }

  async antigravityImportLocal(): Promise<Json> {
    const epoch = ++this.antigravityEpoch;
    const previousFlow = this.antigravityLoginFlow;
    this.antigravityLoginFlow = undefined;
    return this.writes.run(async (): Promise<Json> => {
      const stale = () => this.closed || epoch !== this.antigravityEpoch;
      try {
        if (previousFlow) await this.deps.request('antigravity/loginCancel', { flow: { flowId: previousFlow.flowId } });
        if (stale()) throw new Error('Account operation cancelled');
        const credentials = this.deps.credentials;
        const credential = await readAntigravityCredential(this.deps.homeDir, credentials ? () => credentials.readAntigravityKeychainSecret() : undefined);
        if (stale()) throw new Error('Account operation cancelled');
        const imported = object(await this.deps.request('antigravity/adoptCredential', { credential }));
        if (stale()) {
          await this.deps.request('antigravity/logout', {});
          throw new Error('Account operation cancelled');
        }
        if (imported.ok === true) await this.deps.onAuthChanged();
        if (stale()) throw new Error('Account operation cancelled');
        return imported;
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }

  async antigravityLogout(): Promise<Json> {
    ++this.antigravityEpoch;
    const previousFlow = this.antigravityLoginFlow;
    this.antigravityLoginFlow = undefined;
    return this.writes.run(async (): Promise<Json> => {
      if (previousFlow) await this.deps.request('antigravity/loginCancel', { flow: { flowId: previousFlow.flowId } });
      if (this.closed) return { ok: false, error: 'Account operation cancelled' };
      const result = object(await this.deps.request('antigravity/logout', {}));
      await this.deps.onAuthChanged({ signedOut: true });
      return result;
    });
  }

  async qwenworkImportLocal(): Promise<Json> {
    const epoch = ++this.qwenworkEpoch;
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (this.closed || epoch !== this.qwenworkEpoch) throw new Error('Account operation cancelled');
        const local = await this.credentials().readQwenWorkCredential();
        if (this.closed || epoch !== this.qwenworkEpoch) throw new Error('Account operation cancelled');
        if (local.present && local.userInfo === undefined) {
          return { ok: false, error: local.error ?? 'qwenwork_local_credentials_unavailable' };
        }
        const imported = local.userInfo !== undefined
          ? object(await this.deps.request('qwenwork/adoptCredential', {
              userInfo: local.userInfo,
              ...(local.machineId ? { machineId: local.machineId } : {}),
            }))
          : object(await this.deps.request('qwenwork/importLocal', {}));
        if (this.closed || epoch !== this.qwenworkEpoch) {
          await this.deps.request('qwenwork/logout', {}); throw new Error('Account operation cancelled');
        }
        if (imported.ok === true) { await this.deps.onAuthChanged(); return imported; }
        return imported;
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }
  /**
   * Recover a dead QwenWork login without spending the one-time refresh token:
   * reread the official client's own store (the desktop safeStorage blob this
   * process can decrypt, then the CLI cache the engine reads itself) and adopt
   * whatever is freshest. Returns whether the adoption landed; the caller only
   * falls back to `qwenwork/refreshToken` when this says no, because refreshing
   * invalidates whichever copy the official client holds.
   */
  async qwenworkReadopt(): Promise<boolean> {
    try {
      const local = await this.credentials().readQwenWorkCredential();
      if (local.present && local.userInfo === undefined) return false;
      const adopted = local.userInfo !== undefined
        ? object(await this.deps.request('qwenwork/adoptCredential', {
          userInfo: local.userInfo,
          ...(local.machineId ? { machineId: local.machineId } : {}),
        }))
        : object(await this.deps.request('qwenwork/importLocal', {}));
      if (adopted.ok === true) { await this.deps.onAuthChanged(); return true; }
      return false;
    } catch {
      return false;
    }
  }

  async qwenworkLogout(): Promise<Json> {
    ++this.qwenworkEpoch;
    return this.writes.run(async (): Promise<Json> => {
      const result = object(await this.deps.request('qwenwork/logout', {}));
      await this.deps.onAuthChanged({ signedOut: true }); return result;
    });
  }

  private cursorNote(phase: string, fields: Record<string, unknown> = {}): void {
    try { this.deps.log?.('cursor-diagnostic', JSON.stringify({ phase, fields })); } catch { /* Diagnostics never affect account operations. */ }
  }

  async cursorStart(): Promise<Json> {
    this.cursorNote('login_start');
    const epoch = ++this.cursorEpoch;
    const previousFlow = this.cursorLoginFlow;
    this.cursorLoginFlow = undefined;
    const stale = (): boolean => this.closed || epoch !== this.cursorEpoch;
    return this.writes.run(async (): Promise<Json> => {
      let flowId: string | undefined;
      try {
        if (stale()) throw new Error('Account operation cancelled');
        if (previousFlow) await this.deps.request('cursor/loginCancel', { flow: { flowId: previousFlow.flowId } });
        if (stale()) throw new Error('Account operation cancelled');
        this.cursorNote('client_metadata_read');
        const clientVersion = await (this.deps.cursorClientVersion?.() ?? readCursorClientVersion(this.deps.homeDir));
        this.cursorNote('client_metadata_result', { hasClientVersion: !!clientVersion });
        if (stale()) throw new Error('Account operation cancelled');
        if (!clientVersion) throw new Error('cursor_browser_metadata_unavailable');
        const result = object(await this.deps.request('cursor/loginStart', { clientVersion }));
        flowId = typeof result.flowId === 'string' ? result.flowId : undefined;
        if (stale()) throw new Error('Account operation cancelled');
        if (result.ok !== true) return result;
        const url = new URL(string(result.authUrl));
        if (!flowId || url.origin !== 'https://cursor.com' || url.pathname !== '/loginDeepControl' || url.username || url.password) throw new Error('cursor_login_url_invalid');
        this.cursorLoginFlow = { flowId, epoch };
        this.cursorNote('browser_open');
        await this.deps.openExternal(url.href);
        this.cursorNote('browser_opened');
        if (stale()) throw new Error('Account operation cancelled');
        return result;
      } catch (error) {
        if (this.cursorLoginFlow?.epoch === epoch) this.cursorLoginFlow = undefined;
        if (flowId) await this.deps.request('cursor/loginCancel', { flow: { flowId } }).catch(() => {});
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  async cursorPoll(flowId: string): Promise<Json> {
    const flow = this.cursorLoginFlow;
    const stale = (): boolean => this.closed || !flow || flow.flowId !== flowId || flow.epoch !== this.cursorEpoch || this.cursorLoginFlow !== flow;
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (stale()) return { ok: false, error: 'cursor_login_cancelled' };
        const result = object(await this.deps.request('cursor/loginPoll', { flow: { flowId } }));
        if (stale()) {
          const credentialId = string(result.credentialId);
          if (result.ok === true && credentialId) await this.deps.request('cursor/logout', { expectedCredentialId: credentialId });
          return { ok: false, error: 'cursor_login_cancelled' };
        }
        if (result.pending !== true && result.ok !== true) this.cursorLoginFlow = undefined;
        if (result.ok === true) {
          // The saved grant is committed before account notifications can remount
          // settings. Cleanup may cancel a pending flow, never a committed grant.
          this.cursorLoginFlow = undefined;
          this.cursorSnapshotHash = undefined;
          this.cursorNote('login_committed');
          try { await this.deps.onAuthChanged(); }
          catch { this.cursorNote('account_publication_failed'); }
          if (this.closed || flow?.epoch !== this.cursorEpoch) {
            // Explicit logout or replacement owns its own credential operation.
            return { ok: false, error: 'cursor_login_cancelled' };
          }
        }
        return result;
      } catch (error) {
        if (this.cursorLoginFlow === flow) this.cursorLoginFlow = undefined;
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  async cursorCancel(flowId: string): Promise<Json> {
    if (this.closed) return { ok: true };
    if (this.cursorLoginFlow?.flowId === flowId) {
      ++this.cursorEpoch;
      this.cursorLoginFlow = undefined;
    }
    return object(await this.deps.request('cursor/loginCancel', { flow: { flowId } }));
  }

  async cursorImportLocal(): Promise<Json> {
    const epoch = ++this.cursorEpoch;
    const flow = this.cursorLoginFlow;
    this.cursorLoginFlow = undefined;
    const stale = (): boolean => this.closed || epoch !== this.cursorEpoch;
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (stale()) throw new Error('Account operation cancelled');
        if (flow) await this.deps.request('cursor/loginCancel', { flow: { flowId: flow.flowId } });
        if (stale()) throw new Error('Account operation cancelled');
        this.cursorNote('local_credential_read');
        const local = await this.credentials().readCursorCredential();
        this.cursorNote('local_credential_result', { present: local.present, metadataPresent: !!local.userInfo,
          hasAccount: !!local.userInfo?.account, hasClientVersion: !!local.userInfo?.clientVersion,
          hasClientIdentity: !!local.userInfo?.clientIdentity, expiryKnown: local.userInfo?.expiresAt !== undefined });
        if (stale()) throw new Error('Account operation cancelled');
        if (!local.userInfo) return { ok: false, error: local.error ?? 'cursor_local_not_signed_in' };
        if (local.userInfo.expiresAt !== undefined && local.userInfo.expiresAt <= Date.now()) {
          return { ok: false, error: 'cursor_adopted_credential_needs_reimport' };
        }
        const imported = object(await this.deps.request('cursor/adoptCredential', { userInfo: object(local.userInfo) }));
        if (stale()) {
          const credentialId = string(imported.credentialId);
          if (imported.ok === true && credentialId) await this.deps.request('cursor/logout', { expectedCredentialId: credentialId });
          throw new Error('Account operation cancelled');
        }
        if (imported.ok === true) {
          this.cursorSnapshotHash = cursorSnapshotDigest(local.userInfo);
          await this.deps.onAuthChanged();
          if (stale()) {
            const credentialId = string(imported.credentialId);
            if (credentialId) await this.deps.request('cursor/logout', { expectedCredentialId: credentialId });
            throw new Error('Account operation cancelled');
          }
        }
        return imported;
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }

  /** Retry a changed local access snapshot once; renewal belongs to its original application. */
  cursorReadopt(): Promise<boolean> {
    if (this.closed || this.cursorLoginFlow) return Promise.resolve(false);
    if (this.cursorReadoption) return this.cursorReadoption;
    const epoch = this.cursorEpoch;
    const stale = (): boolean => this.closed || epoch !== this.cursorEpoch;
    const pending = this.writes.run(async (): Promise<boolean> => {
      try {
        if (stale() || this.cursorLoginFlow) return false;
        const status = object(await this.deps.request('cursor/status', {}));
        if (status.authMethod === 'browser') return false;
        const expectedCredentialId = string(status.credentialId);
        if (stale() || !expectedCredentialId || status.loggedIn !== true && status.needsReimport !== true) return false;
        this.cursorNote('local_credential_read');
        const local = await this.credentials().readCursorCredential();
        this.cursorNote('local_credential_result', { present: local.present, metadataPresent: !!local.userInfo,
          hasAccount: !!local.userInfo?.account, hasClientVersion: !!local.userInfo?.clientVersion,
          hasClientIdentity: !!local.userInfo?.clientIdentity, expiryKnown: local.userInfo?.expiresAt !== undefined });
        if (stale() || !local.userInfo || local.userInfo.expiresAt !== undefined && local.userInfo.expiresAt <= Date.now()) return false;
        if (typeof status.account === 'string' && status.account !== local.userInfo.account) return false;
        const hash = cursorSnapshotDigest(local.userInfo);
        if (hash === this.cursorSnapshotHash) return false;
        const adopted = object(await this.deps.request('cursor/adoptCredential', { userInfo: object(local.userInfo), expectedCredentialId }));
        if (stale()) {
          const credentialId = string(adopted.credentialId);
          if (adopted.ok === true && credentialId) await this.deps.request('cursor/logout', { expectedCredentialId: credentialId });
          return false;
        }
        if (adopted.ok !== true) {
          if (needsCursorReadoption(string(adopted.error))) this.cursorSnapshotHash = hash;
          return false;
        }
        this.cursorSnapshotHash = hash;
        await this.deps.onAuthChanged();
        if (stale()) {
          const credentialId = string(adopted.credentialId);
          if (credentialId) await this.deps.request('cursor/logout', { expectedCredentialId: credentialId });
          return false;
        }
        return true;
      } catch { return false; }
    });
    this.cursorReadoption = pending;
    void pending.finally(() => { if (this.cursorReadoption === pending) this.cursorReadoption = undefined; });
    return pending;
  }

  async cursorLogout(): Promise<Json> {
    ++this.cursorEpoch;
    this.cursorLoginFlow = undefined;
    return this.writes.run(async (): Promise<Json> => {
      if (this.closed) return { ok: false, error: 'Account operation cancelled' };
      const result = object(await this.deps.request('cursor/logout', {}));
      if (result.ok === true) this.cursorSnapshotHash = undefined;
      await this.deps.onAuthChanged({ signedOut: true });
      return result;
    });
  }

  /**
   * Reuse a login WorkBuddy AI already holds.
   *
   * Unlike the QwenWork import there is NO engine-side fallback: WorkBuddy keeps
   * exactly one store, encrypted under a key inside its own binary, so
   * `workbuddy/importLocal` can only ever answer "unavailable". Routing a failed
   * native read through it would replace a specific reason — not installed, not
   * signed in, an incompatible build — with a generic one, so the native answer
   * is surfaced as-is.
   */
  async workbuddyImportLocal(region?: 'cn' | 'intl'): Promise<Json> {
    const epoch = ++this.workbuddyEpoch;
    return this.writes.run(async (): Promise<Json> => {
      try {
        if (this.closed || epoch !== this.workbuddyEpoch) throw new Error('Account operation cancelled');
        const local = await this.credentials().readWorkBuddyCredential(region);
        if (this.closed || epoch !== this.workbuddyEpoch) throw new Error('Account operation cancelled');
        if (local.userInfo === undefined) {
          return { ok: false, error: local.error ?? 'workbuddy_local_credentials_unavailable' };
        }
        const imported = object(await this.deps.request('workbuddy/adoptCredential', {
          userInfo: local.userInfo,
          ...(local.machineId ? { machineId: local.machineId } : {}),
        }));
        if (this.closed || epoch !== this.workbuddyEpoch) {
          await this.deps.request('workbuddy/logout', {}); throw new Error('Account operation cancelled');
        }
        if (imported.ok === true) { await this.deps.onAuthChanged(); return imported; }
        return imported;
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }

  /**
   * Recover a dead WorkBuddy login by re-reading WorkBuddy's own store.
   *
   * This is the ONLY recovery an imported login gets, and deliberately so:
   * WorkBuddy's refresh returns a whole new token set and overwrites the session,
   * which is rotation-shaped, so spending the refresh token that a running
   * WorkBuddy client also holds risks signing the user out of their own app to
   * keep a Klaus session alive. The engine refuses to refresh an adopted
   * credential for the same reason; a login Klaus itself started is unaffected and
   * still refreshes normally.
   */
  async workbuddyReadopt(): Promise<boolean> {
    const epoch = this.workbuddyEpoch;
    return this.writes.run(async () => {
      try {
        if (this.closed || epoch !== this.workbuddyEpoch) return false;
        const current = object(await this.deps.request('workbuddy/status', {}));
        if (this.closed || epoch !== this.workbuddyEpoch) return false;
        const region = current.region;
        if (current.loggedIn !== true || current.loginMethod !== 'adopted' || (region !== 'cn' && region !== 'intl')) return false;
        const local = await this.credentials().readWorkBuddyCredential(region);
        if (this.closed || epoch !== this.workbuddyEpoch || local.userInfo === undefined) return false;
        const adopted = object(await this.deps.request('workbuddy/adoptCredential', {
          userInfo: local.userInfo,
          ...(local.machineId ? { machineId: local.machineId } : {}),
        }));
        if (this.closed || epoch !== this.workbuddyEpoch) return false;
        if (adopted.ok === true) { await this.deps.onAuthChanged(); return true; }
        return false;
      } catch {
        return false;
      }
    });
  }

  async workbuddyLogout(): Promise<Json> {
    ++this.workbuddyEpoch;
    return this.writes.run(async (): Promise<Json> => {
      const result = object(await this.deps.request('workbuddy/logout', {}));
      await this.deps.onAuthChanged({ signedOut: true }); return result;
    });
  }

  /**
   * Store a Kimi Code console API key.
   *
   * The engine verifies the key against Kimi's account route before storing it, so
   * this answers with the resulting status (`loggedIn`) or an `error` code rather
   * than optimistically reporting success. Either way the credential changed what
   * a session can resolve, so the auth change is broadcast.
   */
  async kimiSetApiKey(apiKey: string, apiBase?: string): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      // `Json` admits no undefined member, so an absent base URL is left out
      // rather than sent as one: the engine reads the key's own region then.
      const params: JsonObject = { apiKey };
      if (apiBase !== undefined) params.apiBase = apiBase;
      const result = object(await this.deps.request('kimi/setApiKey', params));
      await this.deps.onAuthChanged(); return result;
    });
  }

  async kimiLogout(): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const result = object(await this.deps.request('kimi/logout', {}));
      await this.deps.onAuthChanged({ signedOut: true }); return result;
    });
  }

  /**
   * Store a Bailian Token Plan console key.
   *
   * Token Plan has no login flow, so this is the only way a credential arrives. The
   * engine verifies the key against the catalog route before storing it, which is
   * what turns a mistyped key — or one from the neighbouring Coding Plan product,
   * whose keys are not interchangeable — into an immediate refusal on the settings
   * card instead of a failure inside the first conversation.
   */
  async bailianSetApiKey(apiKey: string, region?: string): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const params: JsonObject = { apiKey };
      // An absent region keeps whichever site the stored key already belongs to, so
      // re-entering a key cannot silently move it to a host that will refuse it.
      if (region !== undefined) params.region = region;
      const result = object(await this.deps.request('bailian/setApiKey', params));
      await this.deps.onAuthChanged(); return result;
    });
  }

  async bailianLogout(): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const result = object(await this.deps.request('bailian/logout', {}));
      await this.deps.onAuthChanged({ signedOut: true }); return result;
    });
  }

  /**
   * Store a MiniMax M Plan subscription key.
   *
   * M Plan has no login flow, so this is the only way a credential arrives. The
   * engine verifies the key against the catalog route before storing it, and
   * detects which site issued it when no region is named: both the China site and
   * the global site mint the same `sk-cp-` key shape and do not share keys, so a
   * wrong default would read to the user as a bad key. A pay-as-you-go key
   * (`sk-api-…`) is refused outright, because it would spend account balance
   * instead of plan allowance.
   */
  async minimaxSetApiKey(apiKey: string, region?: string): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const params: JsonObject = { apiKey };
      // An absent region lets the engine detect the site from the key. Blank counts
      // as absent, not as a site name: the picker's first option is "detect
      // automatically" and carries an empty value, and forwarding that would reach
      // the engine as a region it has to reject rather than probe. The bridge and the
      // IPC handler already collapse it, so this is the last gate before the wire.
      const site = region?.trim();
      if (site) params.region = site;
      const result = object(await this.deps.request('minimax/setApiKey', params));
      await this.deps.onAuthChanged(); return result;
    });
  }

  /**
   * Store a Zhipu Coding Plan key.
   *
   * Coding Plan has no login flow, so this is the only way a credential arrives. The
   * engine verifies the key against the catalog route before storing it, which is
   * what turns a mistyped key — or one minted on the other site, since the two
   * sites keep separate accounts and their keys do not cross — into an immediate
   * refusal on the settings card instead of a failure inside the first conversation.
   */
  async zhipuSetApiKey(apiKey: string, region?: string): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const params: JsonObject = { apiKey };
      // An absent region keeps whichever site the stored key already belongs to, so
      // re-entering a key cannot silently move it to a host that will refuse it.
      if (region !== undefined) params.region = region;
      const result = object(await this.deps.request('zhipu/setApiKey', params));
      await this.deps.onAuthChanged(); return result;
    });
  }

  async minimaxLogout(): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const result = object(await this.deps.request('minimax/logout', {}));
      await this.deps.onAuthChanged({ signedOut: true }); return result;
    });
  }

  async zhipuLogout(): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const result = object(await this.deps.request('zhipu/logout', {}));
      await this.deps.onAuthChanged({ signedOut: true }); return result;
    });
  }

  /**
   * Store an Ark Coding Plan key.
   *
   * Coding Plan has no login flow, so this is the only way a credential arrives. The
   * engine verifies the key against the catalog route before storing it, which turns
   * a mistyped key into an immediate refusal on the settings card instead of a
   * failure inside the first conversation. The plan publishes one region, so unlike
   * the two-site plans there is no detection step: a named region that is not the
   * published one is refused by the engine rather than probed.
   */
  async arkSetApiKey(apiKey: string, region?: string): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const params: JsonObject = { apiKey };
      const site = region?.trim();
      if (site) params.region = site;
      const result = object(await this.deps.request('ark/setApiKey', params));
      await this.deps.onAuthChanged(); return result;
    });
  }

  async arkLogout(): Promise<Json> {
    return this.writes.run(async (): Promise<Json> => {
      const result = object(await this.deps.request('ark/logout', {}));
      await this.deps.onAuthChanged({ signedOut: true }); return result;
    });
  }
}

/** One stored Claude account row, or null when the row cannot carry a request. */
function normalizeClaudeAccount(value: Json): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as JsonObject;
  const tokens = object(row.tokens);
  if (!string(row.id) || !string(tokens.accessToken)) return null;
  return row;
}
