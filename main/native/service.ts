import { randomUUID } from 'node:crypto';
import type { NativeHostBinding, NativeShutdownReport, PtyOptions, SearchOptions, SearchResult, SearchSessionInfo } from './binding';
import { beforeDeadline, NativePty, type PtyCloseReport, type PtySink, validDeadline } from './pty';
import { NativeSearchSession } from './search-session';

export interface SearchOperation { operationId: string; result: Promise<SearchResult>; cancel(): boolean }
export interface CapabilityShutdownReport extends NativeShutdownReport { delivery: PtyCloseReport[]; waiterComplete: boolean }

/** Owners are host-established identities, never fields copied from renderer payloads. */
export class NativeCapabilities {
  private closing = false;
  private shutdownPromise?: Promise<CapabilityShutdownReport>;
  private readonly owners = new Map<string, object>();
  private readonly searches = new Map<string, { owner: string; result: Promise<SearchResult> }>();
  private readonly ptys = new Map<string, { owner: string; resource: NativePty }>();
  private readonly searchSessions = new Map<string, { owner: string; session: NativeSearchSession }>();

  constructor(private readonly host: NativeHostBinding, private readonly onError: (owner: string, resourceId: string, error: Error) => void) {}

  /** Called by trusted window/session creation, never implicitly on an incoming command. */
  registerOwner(owner: string): void {
    if (!owner || this.closing) throw new Error('CLOSED: native runtime is shutting down');
    if (this.owners.size >= 256 && !this.owners.has(owner)) throw new Error('BUSY: too many native capability owners');
    if (!this.owners.has(owner)) this.owners.set(owner, {});
  }

  private checkOwner(owner: string): void {
    if (!owner || this.closing || !this.owners.has(owner)) throw new Error('CLOSED: native owner is no longer active');
  }

  private forgetStopped(): void {
    for (const [id, entry] of this.ptys) if (entry.resource.stopped) this.ptys.delete(id);
  }

  search(owner: string, options: Omit<SearchOptions, 'operationId'>, operationId = randomUUID()): SearchOperation {
    this.checkOwner(owner);
    validDeadline(options.deadlineMs);
    const result = this.host.search({ ...options, operationId });
    this.searches.set(operationId, { owner, result });
    void result.finally(() => { if (this.searches.get(operationId)?.result === result) this.searches.delete(operationId); }).catch(() => undefined);
    return { operationId, result, cancel: () => this.searches.get(operationId)?.result === result && this.host.cancelSearch(operationId) };
  }

  openPty(owner: string, options: Omit<PtyOptions, 'resourceId'>, sink: PtySink): NativePty {
    this.checkOwner(owner);
    this.forgetStopped();
    const resourceId = randomUUID();
    const resource = new NativePty(this.host, { ...options, resourceId }, sink, (error) => this.onError(owner, resourceId, error));
    this.ptys.set(resourceId, { owner, resource });
    void resource.finished.then(() => { if (resource.stopped) this.ptys.delete(resourceId); });
    return resource;
  }

  ownedPty(owner: string, resourceId: string): NativePty {
    this.forgetStopped();
    const entry = this.ptys.get(resourceId);
    if (!entry || entry.owner !== owner) throw new Error('RESOURCE_NOT_OWNED: PTY does not belong to this caller');
    return entry.resource;
  }

  /**
   * Open a persistent search session for a picker. The native side walks the
   * roots once here; later {@link NativeSearchSession.query} calls re-rank that
   * snapshot. A truncated snapshot is refused rather than served, so the picker
   * never offers a partial index — matching the one-shot path's rejection.
   */
  async openSearchSession(owner: string, roots: string[], deadlineMs: number, sessionId: string = randomUUID()): Promise<NativeSearchSession> {
    this.checkOwner(owner);
    validDeadline(deadlineMs);
    const ownerLease = this.owners.get(owner);
    const info: SearchSessionInfo = await this.host.createSearchSession({ sessionId, roots, deadlineMs });
    // The walk can outlive the owner (a renderer that navigated away mid-create);
    // refuse to register rather than adopt an orphan. Truncation is left to the
    // caller to reject, mirroring the one-shot handler's SEARCH_LIMIT_EXCEEDED.
    if (this.closing || this.owners.get(owner) !== ownerLease) {
      this.host.stopSearchSession(sessionId);
      throw new Error('CLOSED: native owner is no longer active');
    }
    // The session keeps the roots so it can rebase a secondary root's hit itself,
    // matching the one-shot handler; the caller never juggles root indexes.
    const session = new NativeSearchSession(this.host, sessionId, { roots: info.roots, scanned: info.scanned, truncated: info.truncated }, roots);
    this.searchSessions.set(sessionId, { owner, session });
    return session;
  }

  ownedSearchSession(owner: string, sessionId: string): NativeSearchSession {
    const entry = this.searchSessions.get(sessionId);
    if (!entry || entry.owner !== owner) throw new Error('RESOURCE_NOT_OWNED: search session does not belong to this caller');
    return entry.session;
  }

  /** Stop and drop one session. Returns false when it was not registered. */
  async closeSearchSession(owner: string, sessionId: string): Promise<boolean> {
    const entry = this.searchSessions.get(sessionId);
    if (!entry || entry.owner !== owner) return false;
    await entry.session.stop();
    this.searchSessions.delete(sessionId);
    return true;
  }

  async closeOwner(owner: string, deadlineMs = 2000): Promise<{ complete: boolean; resources: PtyCloseReport[]; pendingOperations: string[] }> {
    validDeadline(deadlineMs);
    this.forgetStopped();
    this.owners.delete(owner);
    const until = Date.now() + deadlineMs;
    const searches = [...this.searches].filter(([, entry]) => entry.owner === owner);
    for (const [id] of searches) this.host.cancelSearch(id);
    // Sessions outlive the picker that opened them if the renderer navigates or
    // dies without stopping them, so teardown is a host responsibility: stop each
    // owned session here rather than trusting the caller to have stopped it.
    const ownedSessions = [...this.searchSessions].filter(([, entry]) => entry.owner === owner);
    const resources = [...this.ptys.values()].filter((entry) => entry.owner === owner).map((entry) => entry.resource);
    const reports = await Promise.all(resources.map((resource) => resource.close(deadlineMs)));
    const sessionReports = await Promise.all(ownedSessions.map(([, entry]) => entry.session.stop()));
    for (const [sessionId] of ownedSessions) this.searchSessions.delete(sessionId);
    await beforeDeadline(Promise.allSettled(searches.map(([, entry]) => entry.result)), until);
    const pendingOperations = searches.map(([id]) => id).filter((id) => this.searches.has(id));
    const complete = !pendingOperations.length
      && reports.every((report) => report.complete)
      && sessionReports.every((report) => report.complete);
    return { complete, resources: reports, pendingOperations };
  }

  shutdown(deadlineMs = 2000): Promise<CapabilityShutdownReport> {
    validDeadline(deadlineMs);
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = this.performShutdown(deadlineMs);
    return this.shutdownPromise;
  }

  private async performShutdown(deadlineMs: number): Promise<CapabilityShutdownReport> {
    this.forgetStopped();
    const until = Date.now() + deadlineMs;
    const resources = [...this.ptys.values()].map((entry) => entry.resource);
    // Stop every session before the native runtime seals, then drop the registry
    // so the host's "no resources after shutdown" assertion sees zero sessions.
    const sessions = [...this.searchSessions.values()].map((entry) => entry.session);
    const sessionReports = await Promise.all(sessions.map((session) => session.stop()));
    this.searchSessions.clear();
    const native = this.host.shutdown(deadlineMs);
    const deliveryPromise = Promise.all(resources.map((resource) => resource.close(deadlineMs)));
    const result = await beforeDeadline(native, until);
    const delivery = await deliveryPromise;
    const report = result.done ? result.value : { complete: false, pendingOperations: [...this.searches.keys()], resources: delivery };
    this.owners.clear();
    return {
      ...report,
      complete: result.done && report.complete && delivery.every((item) => item.complete)
        && sessionReports.every((item) => item.complete),
      delivery,
      waiterComplete: result.done,
    };
  }
}
