import type { CollaborationEvent, CollaborationRequest, CollaborationResponse } from '../../../contracts/team-collaboration';
import type { Json } from '../../ipc/contract';
import { IpcHandlerError } from '../../ipc/registry';
import type { CollaborationAccount, CollaborationUpdate, TeamCollaborationDeps } from './types';
import { CollaborationStore } from './store';

/** Exhaustiveness is checked against the server-owned discriminated union. */
export const COLLABORATION_OPERATIONS = {
  'projects.list': true, 'projects.get': true, 'projects.create': true, 'projects.update': true,
  'projects.archive': true, 'projects.restore': true, 'projects.delete': true,
  'project-members.list': true, 'project-members.set-role': true, 'project-members.remove': true, 'project-members.add-agent': true,
  'project-invitations.create': true, 'project-invitations.list': true, 'project-invitations.revoke': true,
  'project-invitations.preview': true, 'project-invitations.accept': true,
  'project-invitation-settings.get': true, 'project-invitation-settings.update': true,
  'issues.list': true, 'issues.get': true, 'issues.create': true, 'issues.update': true,
  'issues.archive': true, 'issues.restore': true, 'issues.delete': true, 'issues.reorder': true,
  'issue-reactions.list': true, 'issue-reactions.toggle': true, 'issue-activity.list': true,
  'files.upload': true, 'files.get': true, 'files.remove': true, 'files.list': true,
  'discussion-sources.list': true, 'discussion-sources.add': true, 'discussion-sources.remove': true,
  'discussions.list': true, 'discussions.get': true, 'discussions.create': true, 'discussions.update': true,
  'discussions.archive': true, 'discussions.restore': true,
  'discussion-members.list': true, 'discussion-members.add': true, 'discussion-members.remove': true,
  'discussion-messages.list': true, 'discussion-messages.send': true, 'discussion-messages.update': true,
  'discussion-messages.react': true, 'discussion-messages.set-key': true,
  'discussion-issue-links.list': true, 'discussion-issue-links.add': true, 'discussion-issue-links.remove': true,
  'agents.list': true, 'agents.register': true, 'agents.update': true, 'agents.remove': true,
  'executions.list': true, 'executions.create': true, 'executions.update': true, 'executions.cancel': true,
  'executions.complete': true,
} satisfies Record<CollaborationRequest['type'], true>;

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function id(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\0\r\n]/.test(value)) throw new IpcHandlerError('BAD_REQUEST', `Invalid ${field}`);
  return value;
}
export function validateRequest(value: unknown): CollaborationRequest {
  const input = record(value);
  if (typeof input.type !== 'string' || !Object.hasOwn(COLLABORATION_OPERATIONS, input.type)) throw new IpcHandlerError('BAD_REQUEST', 'Unknown collaboration operation');
  if (Buffer.byteLength(JSON.stringify(input)) > (input.type === 'files.upload' ? 12 * 1024 * 1024 : 128 * 1024)) throw new IpcHandlerError('BAD_REQUEST', 'Collaboration request is too large');
  // These names are never server parameters; refuse rather than treating this as a transport proxy.
  if (['url', 'headers', 'authorization', 'method', 'channel', 'localFolder', 'localPath'].some(key => Object.hasOwn(input, key))
    || (Object.hasOwn(input, 'token') && !['project-invitations.preview', 'project-invitations.accept'].includes(input.type))) throw new IpcHandlerError('BAD_REQUEST', 'Transport and local directory parameters are not permitted');
  return input as unknown as CollaborationRequest;
}
export function invitationUrl(value: unknown, origin: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\0\r\n\\]/.test(value)) throw new IpcHandlerError('INVALID_RESPONSE', 'The invitation link is invalid');
  let url: URL;
  try { url = new URL(value, origin); }
  catch { throw new IpcHandlerError('INVALID_RESPONSE', 'The invitation link is invalid'); }
  const keys = [...url.searchParams.keys()];
  const token = url.searchParams.get('token');
  if (url.origin !== origin || url.username || url.password || url.pathname !== '/collaboration/join' || url.hash
    || keys.length !== 1 || keys[0] !== 'token' || !token || !/^[A-Za-z0-9_-]{20,512}$/.test(token)) {
    throw new IpcHandlerError('INVALID_RESPONSE', 'The invitation link must use the account service and canonical join route');
  }
  return url.href;
}
export interface AccountScope { account: CollaborationAccount; signal: AbortSignal; current(): void }
interface Watch { controller: AbortController; done: Promise<void> }
export class CollaborationHttpError extends IpcHandlerError {
  constructor(code: string, message: string, readonly status: number) { super(code, message); }
}

export class CollaborationCloud {
  private currentAccount: CollaborationAccount | null = null;
  private generation = new AbortController();
  private readonly requests = new Set<AbortController>();
  private readonly watches = new Map<string, Watch>();
  private closed = false;
  private readonly fetcher: typeof fetch;
  readonly baseUrl: string;
  constructor(private readonly deps: TeamCollaborationDeps, private readonly store: CollaborationStore, private readonly changed: () => void,
    private readonly revoked: (projectId: string | null) => void = () => {}) {
    this.fetcher = deps.fetch ?? fetch;
    const url = new URL(deps.serverUrl);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Collaboration requires HTTPS (or a loopback test server)');
    this.baseUrl = url.origin;
  }
  updateAccount(): void {
    const next = this.deps.account();
    if (next?.id === this.currentAccount?.id && next?.token === this.currentAccount?.token) return;
    this.generation.abort();
    for (const pending of this.requests) pending.abort();
    for (const watch of this.watches.values()) watch.controller.abort();
    this.watches.clear();
    this.currentAccount = next;
    this.generation = new AbortController();
    this.changed();
    this.publish({ kind: 'account', accountId: next?.id ?? null });
  }
  scope(): AccountScope {
    if (this.closed) throw new IpcHandlerError('HOST_CLOSED', 'Team collaboration is closed');
    this.updateAccount();
    if (!this.currentAccount?.token || !this.currentAccount.id) throw new IpcHandlerError('NOT_AUTHENTICATED', 'Sign in to a Klaus account to use team collaboration');
    const account = this.currentAccount, signal = this.generation.signal;
    return { account, signal, current: () => {
      this.updateAccount();
      if (this.closed || signal.aborted) throw new IpcHandlerError('ACCOUNT_CHANGED', 'The signed-in account changed; reload team collaboration');
    } };
  }
  publish(value: CollaborationUpdate): void { this.deps.push('collaboration:updated', value as unknown as Json); }
  private async error(response: Response, scope: AccountScope): Promise<never> {
    let body: Record<string, unknown> = {};
    try { body = record(await response.json()); } catch { /* Keep a useful HTTP error for non-JSON responses. */ }
    scope.current();
    if (response.status === 401) await this.deps.authorizationExpired();
    const error = record(body.error);
    const code = typeof error.code === 'string' ? error.code : response.status === 401 ? 'NOT_AUTHENTICATED' : response.status === 403 ? 'FORBIDDEN' : response.status === 409 ? 'CONFLICT' : `HTTP_${response.status}`;
    const message = typeof error.message === 'string' ? error.message : response.status === 403 ? 'You do not have permission for this collaboration resource' : `Collaboration request failed (${response.status})`;
    throw new CollaborationHttpError(code, message.slice(0, 1000) + (Number.isSafeInteger(error.currentVersion) ? ` (current version: ${error.currentVersion})` : ''), response.status);
  }
  async request<R extends CollaborationRequest>(input: R, scope = this.scope()): Promise<CollaborationResponse<R['type']>> {
    validateRequest(input);
    scope.current();
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.deps.requestTimeoutMs ?? 30_000);
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    try {
      const response = await this.fetcher(this.baseUrl + '/api/collaboration/request', {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${scope.account.token}` },
        body: JSON.stringify(input), signal,
      });
      scope.current();
      if (!response.ok) return await this.error(response, scope);
      const text = await response.text();
      scope.current();
      if (text.length > 8 * 1024 * 1024) throw new IpcHandlerError('INVALID_RESPONSE', 'Collaboration response is too large');
      try { return JSON.parse(text) as CollaborationResponse<R['type']>; }
      catch { throw new IpcHandlerError('INVALID_RESPONSE', 'The collaboration server returned invalid JSON'); }
    } catch (error) {
      if (error instanceof CollaborationHttpError && error.status === 401) throw error;
      scope.current();
      if (error instanceof IpcHandlerError) throw error;
      throw new IpcHandlerError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', controller.signal.aborted ? 'The collaboration request timed out' : 'Cannot reach the collaboration server');
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  async fileBytes(fileId: string, maximum: number, scope = this.scope()): Promise<Buffer> {
    if (!/^[a-f0-9-]{36}$/.test(fileId)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid collaboration file identity');
    scope.current();
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.deps.requestTimeoutMs ?? 30_000);
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/collaboration/files/${fileId}`, {
        redirect: 'error', headers: { authorization: `Bearer ${scope.account.token}` }, signal: AbortSignal.any([controller.signal, scope.signal]),
      });
      scope.current();
      if (!response.ok) return await this.error(response, scope);
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new IpcHandlerError('INVALID_RESPONSE', 'The collaboration file is too large');
      if (!response.body) throw new IpcHandlerError('INVALID_RESPONSE', 'The collaboration file has no body');
      const reader = response.body.getReader(), chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          scope.current();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maximum) throw new IpcHandlerError('INVALID_RESPONSE', 'The collaboration file is too large');
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (error instanceof CollaborationHttpError && error.status === 401) throw error;
      scope.current();
      if (error instanceof IpcHandlerError) throw error;
      throw new IpcHandlerError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', 'The collaboration file could not be downloaded');
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  watch(projectId: string | null): void {
    const scope = this.scope();
    for (const [key, value] of this.watches) if (key !== projectId && key !== '@account') { value.controller.abort(); this.watches.delete(key); }
    if (projectId === null || this.watches.has(projectId)) return;
    id(projectId, 'projectId');
    const controller = new AbortController();
    const watch: Watch = { controller, done: Promise.resolve() };
    this.watches.set(projectId, watch);
    watch.done = this.stream(projectId, scope, AbortSignal.any([controller.signal, scope.signal])).catch(() => {}).finally(() => {
      if (this.watches.get(projectId) === watch) this.watches.delete(projectId);
    });
  }
  watchAccount(): void {
    const scope = this.scope(), key = '@account';
    if (this.watches.has(key)) return;
    const controller = new AbortController(), watch: Watch = { controller, done: Promise.resolve() };
    this.watches.set(key, watch);
    watch.done = this.stream(null, scope, AbortSignal.any([controller.signal, scope.signal])).catch(() => {}).finally(() => {
      if (this.watches.get(key) === watch) this.watches.delete(key);
    });
  }
  /** Tear down every background SSE stream without marking the cloud closed.
   *  Used when the server-side feature gate flips off mid-session: the account
   *  stays bound and re-attaching later is just another watchAccount() call. */
  suspendWatches(): void {
    for (const watch of this.watches.values()) watch.controller.abort();
    this.watches.clear();
  }
  private async stream(projectId: string | null, scope: AccountScope, signal: AbortSignal): Promise<void> {
    let failures = 0;
    const cursorKey = projectId ?? '@account';
    while (!signal.aborted && !this.closed) {
      const controller = new AbortController();
      let idle: NodeJS.Timeout;
      const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), this.deps.streamIdleMs ?? 45_000); };
      resetIdle();
      try {
        const cursor = this.store.cursor(scope.account.id, cursorKey);
        const url = new URL(this.baseUrl + '/api/collaboration/events');
        if (projectId) url.searchParams.set('projectId', projectId);
        if (cursor) url.searchParams.set('after', cursor);
        const response = await this.fetcher(url, { redirect: 'error', headers: {
          accept: 'text/event-stream', authorization: `Bearer ${scope.account.token}`, ...(cursor ? { 'last-event-id': cursor } : {}),
        }, signal: AbortSignal.any([signal, controller.signal]) });
        scope.current();
        if (!response.ok) await this.error(response, scope);
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid event stream');
        this.publish({ kind: 'connection', accountId: scope.account.id, projectId, state: 'connected' });
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        try {
          while (!signal.aborted) {
            const chunk = await reader.read();
            scope.current();
            if (chunk.done) break;
            resetIdle();
            buffer += decoder.decode(chunk.value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');
            if (buffer.length > 1024 * 1024) throw new Error('Event frame is too large');
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const lines = frame.split('\n');
              const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (!data) continue;
              const payload = record(JSON.parse(data));
              if (lines.some(line => line === 'event: access-revoked') && payload.code !== 'unavailable') {
                this.revoked(projectId);
                this.publish({ kind: 'connection', accountId: scope.account.id, projectId, state: 'forbidden', error: 'Collaboration access was revoked' });
                return;
              }
              const event = record(payload.event ?? payload);
              const eventId = lines.find(line => line.startsWith('id:'))?.slice(3).trim() ?? event.id;
              if (typeof eventId !== 'string' || !eventId || projectId !== null && event.projectId !== projectId
                || event.projectId !== null && typeof event.projectId !== 'string' || typeof event.type !== 'string') continue;
              const previous = this.store.cursor(scope.account.id, cursorKey);
              if (eventId === previous || (/^\d+$/.test(eventId) && /^\d+$/.test(previous) && BigInt(eventId) <= BigInt(previous))) continue;
              scope.current();
              this.publish({ kind: 'event', accountId: scope.account.id, projectId: event.projectId as string | null, event: event as unknown as CollaborationEvent });
              this.store.setCursor(scope.account.id, cursorKey, eventId);
              if (record(event.data).accessRevoked === true) this.revoked(event.projectId as string | null);
              failures = 0;
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) {
        if (signal.aborted || this.closed) return;
        if (error instanceof CollaborationHttpError && [403, 404].includes(error.status)) {
          this.revoked(projectId);
          this.publish({ kind: 'connection', accountId: scope.account.id, projectId, state: 'forbidden', error: error.message });
          return;
        }
      } finally { clearTimeout(idle!); controller.abort(); }
      if (signal.aborted || this.closed) return;
      this.publish({ kind: 'connection', accountId: scope.account.id, projectId, state: 'reconnecting' });
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(30_000, (this.deps.reconnectMs ?? 1000) * 2 ** Math.min(failures++, 5)));
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  async close(): Promise<void> {
    this.closed = true; this.generation.abort();
    for (const pending of this.requests) pending.abort();
    const watches = [...this.watches.values()];
    for (const watch of watches) watch.controller.abort();
    await Promise.all(watches.map(watch => watch.done));
    this.watches.clear();
  }
}
