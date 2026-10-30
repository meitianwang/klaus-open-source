import { randomUUID } from 'node:crypto';
import { TransformStream } from 'node:stream/web';
import type { JsonObject } from './service-types';
import { MobileError, type MobileAccount } from './mobile/protocol';
import { mobileDeviceId, readMobileMachineIdentifier, relayURL } from './mobile/settings';
import { responseText } from './mobile/transport';

export type RemoteThreadOperation = 'list_threads' | 'list_archived_threads' | 'read_thread' | 'send_message_to_thread' | 'list_projects' | 'create_thread';
export interface RemoteThreadHost {
  id: string; name: string; status: string; features: JsonObject;
  /** Presentational facts a caller needs to tell two computers apart. Optional
   *  because an older account server may omit them and a host is still reachable
   *  without them. The relay transport details (`relayId`, `relayBaseUrl`) stay
   *  private: they address a connection, not a computer, and are meaningless to a
   *  model choosing a target. */
  platform?: string | null; appVersion?: string | null; lastSeenAt?: number | null;
}
export interface RemoteThreadClientDeps {
  configRoot: string; serverURL: string; account(): MobileAccount | undefined; enabled(): boolean;
  fetch?: typeof fetch; platform?: NodeJS.Platform; machineIdentifier?: () => Promise<string | undefined>;
  requestTimeoutMs?: number; authorizationExpired?: () => void;
}
interface RequestContext { account: MobileAccount; signal: AbortSignal; check(): void }
interface DiscoveredHost extends RemoteThreadHost { relayId: string | null }
/** Every operation one computer may ask another to run. The destination's bridge
 *  routes exactly this list, so a new operation is added here once for both ends. */
export const REMOTE_THREAD_OPERATIONS: readonly RemoteThreadOperation[] = ['list_threads', 'list_archived_threads', 'read_thread', 'send_message_to_thread', 'list_projects', 'create_thread'];
const OPERATIONS = REMOTE_THREAD_OPERATIONS;
const DEVICE_LIMIT = 64, DISCOVERY_BYTES = 512 * 1024, RESPONSE_BYTES = 1024 * 1024, REQUEST_BYTES = 256 * 1024;
const record = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/u.test(value);
const invalidResponse = (): MobileError => new MobileError(502, 'invalid_remote_response', 'The remote computer returned an invalid response.');

/** Bounds depth and value count in addition to the transport's byte budget. */
function boundedObject(value: unknown): value is JsonObject {
  if (!record(value)) return false;
  const pending = [{ value, depth: 0 }] as Array<{ value: unknown; depth: number }>;
  let count = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++count > 50_000 || next.depth > 64) return false;
    if (next.value === null || typeof next.value === 'string' || typeof next.value === 'boolean') continue;
    if (typeof next.value === 'number') { if (!Number.isFinite(next.value)) return false; continue; }
    if (typeof next.value !== 'object') return false;
    for (const child of Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
    if (pending.length > 50_000) return false;
  }
  return true;
}

/** Observe cancellation even when a supplied transport has not settled yet. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { cleanup(); reject(signal.reason); };
    const cleanup = (): void => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
  });
}

/** Routes same-account desktop calls exclusively through the configured cloud. */
export class RemoteThreadClient {
  private readonly serverURL: string;
  private readonly stopped = new AbortController();
  private readonly jobs = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  constructor(private readonly deps: RemoteThreadClientDeps) { this.serverURL = relayURL(deps.serverURL); }

  discover(signal: AbortSignal): Promise<{ localHostId: string | null; hosts: RemoteThreadHost[] }> {
    return this.run<{ localHostId: string | null; hosts: RemoteThreadHost[] }>(signal, async context => {
      const { localHostId, hosts } = await this.devices(context);
      return { localHostId, hosts: hosts.map(({ id, name, status, features, platform, appVersion, lastSeenAt }) =>
        ({ id, name, status, features, platform, appVersion, lastSeenAt })) };
    }, () => ({ localHostId: null, hosts: [] }));
  }

  request(hostId: string, operation: RemoteThreadOperation, args: JsonObject, callerThreadId: string, signal: AbortSignal, requestId: string = randomUUID()): Promise<JsonObject> {
    return this.run(signal, async context => {
      if (!identifier(hostId, 128) || !identifier(callerThreadId, 512) || !identifier(requestId, 256) || !OPERATIONS.includes(operation) || !boundedObject(args)) {
        throw new MobileError(400, 'invalid_remote_request', 'The remote conversation request is invalid.');
      }
      const { localHostId, hosts } = await this.devices(context);
      if (hostId === localHostId) throw new MobileError(400, 'local_host', 'Use the local conversation tools for this computer.');
      const host = hosts.find(row => row.id === hostId);
      if (!host) throw new MobileError(404, 'remote_host_not_found', 'The computer is not available on this account.');
      if (host.status !== 'online') throw new MobileError(503, 'remote_host_offline', 'The remote computer is offline or reconnecting.');
      if (host.features.threadCommunication !== 1) throw new MobileError(409, 'remote_threads_unsupported', 'The remote computer needs an update to support conversation communication.');
      if (!host.relayId) throw invalidResponse();
      const body = JSON.stringify({ caller: { hostId: localHostId, threadId: callerThreadId }, requestId, arguments: args });
      if (Buffer.byteLength(body) > REQUEST_BYTES) throw new MobileError(413, 'remote_request_too_large', 'The remote conversation request is too large.');
      context.check();
      return this.cloud(context, localHostId, '/api/mobile/relay/' + encodeURIComponent(host.relayId) + '/thread-tools/' + operation, { method: 'POST', body }, RESPONSE_BYTES);
    });
  }

  close(): Promise<void> {
    this.stopped.abort(new MobileError(503, 'remote_client_closed', 'Remote conversation communication is closed.'));
    return this.closing ??= (async () => { while (this.jobs.size) await Promise.allSettled([...this.jobs]); })();
  }

  private run<T>(signal: AbortSignal, operation: (context: RequestContext) => Promise<T>, unavailable?: () => T): Promise<T> {
    const pending = (async (): Promise<T> => {
      this.stopped.signal.throwIfAborted(); signal.throwIfAborted();
      const current = this.deps.account();
      if (!this.deps.enabled()) {
        if (unavailable) return unavailable();
        throw new MobileError(403, 'remote_threads_disabled', 'Remote conversation communication is disabled.');
      }
      if (!current?.token || !current.userId) {
        if (unavailable) return unavailable();
        throw new MobileError(401, 'account_required', 'Sign in to communicate with another computer.');
      }
      const account = { token: current.token, userId: current.userId }, changed = new AbortController();
      const combined = AbortSignal.any([signal, this.stopped.signal, changed.signal, AbortSignal.timeout(this.deps.requestTimeoutMs ?? 30_000)]);
      const check = (): void => {
        combined.throwIfAborted();
        const next = this.deps.account();
        if (!this.deps.enabled() || next?.token !== account.token || next.userId !== account.userId) {
          const error = new MobileError(409, 'account_changed', 'The account or remote communication setting changed; retry the request.');
          changed.abort(error); throw error;
        }
      };
      // The account provider has no subscription API. Poll only while work is pending.
      const watcher = setInterval(() => { try { check(); } catch (error) { changed.abort(error); } }, 50);
      watcher.unref();
      try { check(); const result = await operation({ account, signal: combined, check }); check(); return result; }
      finally { clearInterval(watcher); }
    })();
    this.jobs.add(pending);
    void pending.then(() => this.jobs.delete(pending), () => this.jobs.delete(pending));
    return pending;
  }

  private async devices(context: RequestContext): Promise<{ localHostId: string; hosts: DiscoveredHost[] }> {
    const platform = this.deps.platform ?? process.platform;
    const localHostId = await abortable(mobileDeviceId(this.deps.configRoot, context.account.userId, platform,
      this.deps.machineIdentifier ?? (() => readMobileMachineIdentifier(platform))), context.signal);
    context.check();
    const body = await this.cloud(context, localHostId, '/api/mobile/devices', { method: 'GET' }, DISCOVERY_BYTES);
    if (!Array.isArray(body.devices) || body.devices.length > DEVICE_LIMIT) throw invalidResponse();
    const hosts: DiscoveredHost[] = [], seen = new Set<string>();
    for (const row of body.devices) {
      if (!record(row) || !identifier(row.id, 128) || typeof row.name !== 'string' || !record(row.features ?? {})) throw invalidResponse();
      if (seen.has(row.id)) throw invalidResponse();
      seen.add(row.id);
      if (row.id === localHostId) continue;
      const name = row.name.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim().slice(0, 120) || 'Klaus Desktop';
      const status = ['online', 'reconnecting', 'offline'].includes(String(row.status)) ? String(row.status) : 'offline';
      hosts.push({ id: row.id, name, status, features: (row.features ?? {}) as JsonObject,
        // All three are optional server-side facts, so an absent or wrong-typed one
        // becomes null rather than failing the whole discovery: a caller can still
        // reach a computer whose version it cannot name.
        platform: typeof row.platform === 'string' ? row.platform.slice(0, 32) : null,
        appVersion: typeof row.appVersion === 'string' ? row.appVersion.slice(0, 64) : null,
        lastSeenAt: typeof row.lastSeenAt === 'number' && Number.isFinite(row.lastSeenAt) ? row.lastSeenAt : null,
        relayId: typeof row.relayId === 'string' && /^[A-Za-z0-9_-]{12,128}$/u.test(row.relayId) ? row.relayId : null });
    }
    return { localHostId, hosts };
  }

  private async cloud(context: RequestContext, localHostId: string, path: string, init: RequestInit, limit: number): Promise<JsonObject> {
    context.check();
    const headers = new Headers({ authorization: 'Bearer ' + context.account.token, 'x-klaus-device-id': localHostId, accept: 'application/json' });
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const fetched = (this.deps.fetch ?? fetch)(this.serverURL + path, { ...init, headers, redirect: 'error', signal: context.signal });
    void fetched.then(response => { if (context.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await abortable(fetched, context.signal);
    context.check();
    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      this.deps.authorizationExpired?.();
      throw new MobileError(401, 'account_unauthorized', 'Account authorization expired. Sign in again.');
    }
    if (response.redirected || response.status < 200 || response.status >= 600 || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {}); throw invalidResponse();
    }
    if (Number(response.headers.get('content-length')) > limit) {
      void response.body?.cancel().catch(() => {}); throw new MobileError(502, 'remote_response_too_large', 'The remote computer returned too much data.');
    }
    // Cancel the original reader when the request, account, timeout or client ends.
    const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: context.signal });
    const text = await abortable(responseText(new Response(stream ?? null), limit), context.signal);
    context.check();
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw invalidResponse(); }
    if (!boundedObject(body)) throw invalidResponse();
    if (body.error !== undefined) {
      const error = body.error;
      if (!record(error) || !identifier(error.type, 128) || typeof error.message !== 'string' || !error.message.trim() || error.message.length > 4096) throw invalidResponse();
      throw new MobileError(response.status >= 400 ? response.status : 502, error.type, error.message);
    }
    if (!response.ok) throw new MobileError(response.status, 'remote_request_failed', 'The remote computer request failed.');
    return body;
  }
}
