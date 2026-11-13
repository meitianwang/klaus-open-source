// The host's in-memory session state.
//
// Three things the engine does NOT hold for us, each of which a renderer call needs:
//
//   1. LIVE SESSION BINDINGS — the renderer's session id is a HOST-MINTED uuid, and the
//      engine's session id is whatever `session/start` returned. They are usually the same
//      string (the engine adopts `threadId` as its persistent identity) but they are NOT
//      guaranteed to be, so every session-scoped channel has to translate. Port of the
//      Rust `Engine.live_sessions` map behind `live_session` / `remember_started_session` /
//      `touch_live_session` / `take_stale_binding` (`main.rs:1963-2060`).
//   2. RUNNING TURNS — which sessions have an unsettled turn. `session:list` reports
//      `isWorking` from this, and `chat:interrupt` uses it to detect a STALE
//      `expectedTurnId` (`interrupt_request_is_stale`, `main.rs:5127-5129`). Without it a
//      Stop pressed after the turn already settled would be forwarded to the engine as an
//      interrupt of the NEXT turn.
//   3. PARKED REVERSE REQUESTS — an approval or elicitation the engine is BLOCKING on,
//      waiting for the user. The engine's `approval/request` is a JSON-RPC request with an
//      id, not a notification, so it does not time out on its own: if the host drops it the
//      turn hangs forever. The Rust parks each one in `engine.pending_reverse` keyed by
//      request id (`main.rs:1332-1351`), and settles every parked request for a session
//      when that session's turn is interrupted (`cancel_pending_reverse`, `main.rs:2664+`).
//
// Everything here is per-process and deliberately NOT persisted: a restart has no live
// sessions and no parked requests, which is correct — the engine child is gone too, and
// `session:history` re-activates a thread on demand.
//
// SINGLE-THREADED, BUT NOT THEREFORE SAFE. Node's event loop makes the map operations
// atomic, yet `resolveLiveSession` has an await between "is there a binding?" and "record
// the binding", so two concurrent calls for the same renderer id could both start a
// session. The Rust guards this with a per-id mutex (`session_start_gate`,
// `main.rs:2005-2008`); the equivalent here is the in-flight promise map, so the second
// caller awaits the first's session instead of racing it.

import { WorkflowSnapshots } from '../sessions/workflow-snapshots';
import type { ReverseRequest } from '../engine/protocol';
import type { Json } from '../ipc/contract';
import type { SandboxWorkspaceWrite } from '../../contracts/runtime-settings';
import { object } from '../ipc/arguments';
import { projectQueueSnapshot } from '../sessions/queue';
import { replaceInferenceInit } from '../sessions/inference';
import { normalizeSessionMaxRetries, type SessionEventContext, type PublicInference } from '../sessions/event-context';

export interface SessionProviderIdentity { source: string; selection: string; hostRouted?: true; accountId?: string }

/**
 * How long an accepted stop keeps the session "occupied" for teardown paths.
 * The engine acks `turn/interrupt` immediately and the terminal event follows
 * within a second or two; this only has to outlive that round trip plus a
 * slow rollout flush, while staying short enough that a lost event cannot pin
 * a session against retirement for long.
 */
const INTERRUPT_WINDOW_MS = 15_000;

/** One binding between a renderer session id and an engine session id. */
interface LiveSession {
  provider?: SessionProviderIdentity;
  /** The engine's session id, as `session/start` returned it. */
  engineId: string;
  /** Monotonic clock of the last use, for idle retirement. */
  touchedAt: number;
  /** The init the session was started with, kept for reconciliation reads. */
  init: Json;
  hostWritableRoots: string[];
  modelPreferenceRevision: number;
  modelTierRevision: number;
  inferenceUncertain: boolean;
  inferenceCandidates: Map<string, { init: Json; provider: SessionProviderIdentity; revision?: number }>;
  inferenceRevisions: Map<number, { init: Json; provider?: SessionProviderIdentity }>;
  /**
   * Set when the binding is known to be stale — the engine forgot the session, or its
   * structural configuration changed — so the next session-scoped call rebuilds it.
   * Model changes use a separate revision and keep the live session intact.
   * Ported from `take_stale_binding`.
   */
  stale: boolean;
}

/** A reverse request the user has not answered yet. */
export interface PendingReverse {
  /** Original engine updates; renderer indices refer to this immutable list. */
  suggestions?: Json[];
  /** The request id the renderer will answer by. */
  requestId: string;
  /** The session this request belongs to, so an interrupt can settle it. */
  sessionId: string;
  /**
   * Whether this is a tool approval rather than an elicitation.
   *
   * The two answer with DIFFERENT shapes — `{decision:"allow"|"deny"}` versus
   * `{kind:"accept"|"answers"|"decline", …}` — and `cancel_pending_reverse` uses this flag
   * to pick the right cancellation (`main.rs:2651-2658`). Getting it wrong would send a
   * `decline` to an approval the engine is waiting on, which it cannot parse.
   */
  isApproval: boolean;
  elicitationKind?: 'mcp-form';
  /** The card pushed to the renderer, kept so `permission:pending` can re-send it. */
  card: Json;
  /** The engine's own tool name for the pending request's diagnostics. */
  toolName: string;
  /** The responder that settles the engine's request. */
  request: Pick<ReverseRequest, 'outstanding' | 'respond' | 'respondError'> & Partial<Pick<ReverseRequest, 'id' | 'method' | 'params'>>;
}

/**
 * The host's session state.
 *
 * One instance per app, owned by the Electron entry point and handed to the handlers. Not a
 * module-level singleton, for the same reason `ChannelRegistry` is not: a test that mutates
 * shared global state cannot be run twice or in parallel.
 */
export class HostState {
  readonly workflows = new WorkflowSnapshots();
  private readonly live = new Map<string, LiveSession>();
  private readonly queues = new Map<string, Record<string, Json>>();
  private readonly running = new Set<string>();
  private readonly pending = new Map<string, PendingReverse>();
  /** In-flight `session/start` per renderer id, so concurrent callers share one start. */
  private readonly starting = new Map<string, Promise<string>>();
  private modelClock = 0;
  private globalModelRevision = 0;
  private readonly modelRevisions = new Map<string, number>();
  /** Observability hook for binding removals, wired to the host log by the app entry. */
  private readonly log?: (kind: string, detail: string) => void;
  /** Test hook observing the same removals without reading the log file. */
  private readonly onDrop?: (rendererId: string, engineId: string, reason: string) => void;

  constructor(options: { log?: (kind: string, detail: string) => void; onDrop?: (rendererId: string, engineId: string, reason: string) => void } = {}) {
    this.log = options.log;
    this.onDrop = options.onDrop;
  }

  /**
   * Report one binding removal with the session it named and the path removing it.
   *
   * Turn starts re-check the live binding against the engine id they resolved a moment
   * earlier and refuse when the two disagree. Nothing used to say WHICH path removed the
   * binding in between, so a reproduced race left no trace to attribute; every removal now
   * names its caller here.
   */
  private drop(rendererId: string, engineId: string, reason: string): void {
    this.submittedMessages.delete(rendererId);
    this.onDrop?.(rendererId, engineId, reason);
    this.log?.('session-binding-dropped', JSON.stringify({ sessionId: rendererId, engineId, reason }));
  }

  // ---------------------------------------------------------------------
  // Live session bindings
  // ---------------------------------------------------------------------

  /** The engine session id bound to a renderer id, or undefined. */
  liveSession(rendererId: string): string | undefined {
    return this.live.get(rendererId)?.engineId;
  }

  isStale(rendererId: string): boolean { return this.live.get(rendererId)?.stale === true; }

  /**
   * Whether a binding may still be acted on: fresh, or stale while its turn runs.
   *
   * `stale` only means "the next session-scoped call rebuilds this binding", and
   * `resolveLiveSession` deliberately does NOT rebuild while a turn is running —
   * it keeps serving the same engine session id instead. A durable settings write
   * landing mid-turn (a saved slash command, an installed skill) therefore marks
   * every binding stale without ending any conversation, so reading `stale` alone
   * as "this conversation is gone" makes the model's own mutation fail after it
   * already took effect. Engine identity is re-checked here, so a binding that
   * really was dropped and rebuilt is still refused.
   */
  bindingUsable(binding: { rendererId: string; engineId: string }): boolean {
    const entry = this.live.get(binding.rendererId);
    return entry !== undefined && entry.engineId === binding.engineId && (!entry.stale || this.running.has(binding.rendererId));
  }

  /** Record a binding established by a successful `session/start`. */
  rememberSession(rendererId: string, engineId: string, init: Json, provider?: SessionProviderIdentity & { modelPreferenceRevision?: number; modelTierRevision?: number; hostWritableRoots?: readonly string[] }): void {
    this.submittedMessages.delete(rendererId);
    this.live.set(rendererId, { engineId, touchedAt: Date.now(), init, stale: false,
      hostWritableRoots: [...new Set(provider?.hostWritableRoots ?? [])],
      modelPreferenceRevision: provider?.modelPreferenceRevision ?? this.modelPreferenceRevision(rendererId),
      modelTierRevision: provider?.modelTierRevision ?? 0,
      inferenceUncertain: false,
      provider: provider && { source: provider.source, selection: provider.selection, hostRouted: provider.hostRouted, accountId: provider.accountId },
      inferenceCandidates: new Map(),
      inferenceRevisions: new Map([[0, { init, provider }]]),
    });
  }

  modelPreferenceRevision(rendererId: string): number {
    return Math.max(this.globalModelRevision, this.modelRevisions.get(rendererId) ?? 0);
  }
  markModelChanged(rendererId?: string): void {
    const revision = ++this.modelClock;
    if (rendererId === undefined) this.globalModelRevision = revision;
    else this.modelRevisions.set(rendererId, revision);
  }
  inferencePending(rendererId: string): boolean {
    const entry = this.live.get(rendererId);
    return !!entry && (entry.inferenceUncertain || entry.modelPreferenceRevision !== this.modelPreferenceRevision(rendererId));
  }
  inferenceUncertain(rendererId: string): boolean { return this.live.get(rendererId)?.inferenceUncertain === true; }
  setInferenceUncertain(rendererId: string, engineId: string, uncertain: boolean): void {
    const entry = this.live.get(rendererId);
    if (entry?.engineId === engineId) entry.inferenceUncertain = uncertain;
  }
  updateInference(rendererId: string, engineId: string, selection: Record<string, Json>, provider: SessionProviderIdentity & { modelTierRevision?: number }, revision: number): boolean {
    const entry = this.live.get(rendererId);
    if (entry?.engineId !== engineId) return false;
    entry.init = replaceInferenceInit(entry.init, selection);
    entry.provider = { source: provider.source, selection: provider.selection, hostRouted: provider.hostRouted, accountId: provider.accountId };
    entry.modelPreferenceRevision = revision;
    if (provider.modelTierRevision !== undefined) entry.modelTierRevision = provider.modelTierRevision;
    entry.inferenceUncertain = false;
    return true;
  }

  modelTierRevision(rendererId: string): number | undefined { return this.live.get(rendererId)?.modelTierRevision; }

  updateModelTierTargets(rendererId: string, engineId: string, targets: Json, revision: number): boolean {
    const entry = this.live.get(rendererId);
    if (entry?.engineId !== engineId) return false;
    entry.init = { ...object(entry.init), modelTierTargets: targets };
    entry.modelTierRevision = revision;
    return true;
  }

  updateHostCapabilities(rendererId: string, engineId: string, capabilities: Json): void {
    const entry = this.live.get(rendererId);
    if (entry?.engineId !== engineId || !entry.init || typeof entry.init !== 'object' || Array.isArray(entry.init)) return;
    entry.init.hostCapabilities = capabilities;
  }

  /** The host catalog last acknowledged by this exact engine binding. */
  skillCatalog(rendererId: string): { cwd: string; skills: Json[] } | undefined {
    const init = object(this.live.get(rendererId)?.init);
    if (!init || typeof init.cwd !== 'string') return undefined;
    return { cwd: init.cwd, skills: structuredClone(Array.isArray(init.skills) ? init.skills : []) };
  }

  updateSkills(rendererId: string, engineId: string, skills: Json[]): boolean {
    const entry = this.live.get(rendererId);
    if (entry?.engineId !== engineId) return false;
    entry.init = { ...object(entry.init), skills: structuredClone(skills) };
    return true;
  }

  sessionProvider(rendererId: string): (SessionProviderIdentity & { token?: string }) | undefined {
    const entry = this.live.get(rendererId);
    if (!entry?.provider) return undefined;
    const init = entry.init;
    const auth = init && typeof init === 'object' && !Array.isArray(init) ? init.auth : undefined;
    const token = auth && typeof auth === 'object' && !Array.isArray(auth) && typeof auth.token === 'string' ? auth.token : undefined;
    return { ...entry.provider, token: entry.provider.hostRouted ? undefined : token };
  }

  recordInferenceCandidate(rendererId: string, engineId: string, changeId: string, init: Json, provider: SessionProviderIdentity): void {
    const entry = this.live.get(rendererId);
    if (entry?.engineId === engineId) entry.inferenceCandidates.set(changeId, { init, provider });
  }
  confirmInferenceCandidate(rendererId: string, engineId: string, changeId: string, revision: number): void {
    const entry = this.live.get(rendererId), candidate = entry?.inferenceCandidates.get(changeId);
    if (entry?.engineId !== engineId || !candidate) return;
    candidate.revision = revision;
    entry.inferenceRevisions.set(revision, candidate);
  }
  discardInferenceCandidate(rendererId: string, engineId: string, changeId: string): void {
    const entry = this.live.get(rendererId);
    if (entry?.engineId === engineId && entry.inferenceCandidates.get(changeId)?.revision === undefined) entry.inferenceCandidates.delete(changeId);
  }

  /** Attribute events to their capture, including candidates whose RPC ACK is still pending. */
  sessionEventContext(rendererId: string, inference?: PublicInference): SessionEventContext | undefined {
    const entry = this.live.get(rendererId);
    if (!entry) return undefined;
    const captured = inference ? (inference.changeId ? entry.inferenceCandidates.get(inference.changeId) : undefined)
      ?? entry.inferenceRevisions.get(inference.revision) : undefined;
    const target = inference?.tier ? object(object(object(captured?.init)?.modelTierTargets)?.[inference.tier]) : undefined;
    const source = inference?.source ?? (inference ? (typeof target?.source === 'string' ? target.source : captured?.provider?.source)
      : entry.inferenceRevisions.size === 1 && entry.inferenceCandidates.size === 0 ? entry.provider?.source : undefined);
    return {
      maxRetries: normalizeSessionMaxRetries(object(object(entry.init)?.config)?.maxRetries),
      ...(source ? { authMode: source } : {}),
      ...(inference ? { inference } : {}),
    };
  }

  /**
   * Mark a binding used.
   *
   * Kept separate from the read so `resolveLiveSession` can touch only on a HIT: a lookup
   * that misses must not create an entry, and one that hits must not be mistaken for a
   * write by the idle retirement sweep.
   */
  touchSession(rendererId: string): void {
    const entry = this.live.get(rendererId);
    if (entry !== undefined) entry.touchedAt = Date.now();
  }

  /**
   * Take and clear a stale binding.
   *
   * Returns the engine id so the caller can `session/close` it BEFORE re-activating. That
   * ordering is not optional: dropping only the host-side binding leaves the engine holding
   * the thread's rollout writer lease, and the resume then fails with
   * `<thread>.jsonl is locked by another writer` — measured in the Rust host
   * (`main.rs:1977-1989`).
   */
  takeStaleBinding(rendererId: string): string | undefined {
    const entry = this.live.get(rendererId);
    if (entry === undefined || !entry.stale) return undefined;
    this.live.delete(rendererId);
    this.queues.delete(rendererId);
    this.drop(rendererId, entry.engineId, 'stale-binding-taken');
    return entry.engineId;
  }

  /** Mark a binding stale, so the next session-scoped call rebuilds it. */
  markStale(rendererId: string): void {
    const entry = this.live.get(rendererId);
    if (entry !== undefined) entry.stale = true;
  }

  /** Drop a binding entirely (session deleted, or the engine process died). */
  forgetSession(rendererId: string, reason = 'forgotten'): void {
    const engineId = this.live.get(rendererId)?.engineId;
    this.live.delete(rendererId);
    this.modelRevisions.delete(rendererId);
    this.queues.delete(rendererId);
    this.clearTurnRunning(rendererId);
    this.clearInterruptWindow(rendererId);
    if (engineId !== undefined) this.drop(rendererId, engineId, reason);
  }

  invalidateConnection(): { running: string[]; pending: PendingReverse[] } {
    const running = [...this.running];
    for (const [rendererId, entry] of this.live) this.drop(rendererId, entry.engineId, 'connection-invalidated');
    this.live.clear();
    this.modelRevisions.clear();
    this.queues.clear();
    this.running.clear();
    this.turnIds.clear();
    this.turnSubmissionIds.clear();
    this.interruptWindows.clear();
    this.starting.clear();
    this.onTurnRunningChange?.();
    return { running, pending: this.takeAllPending() };
  }

  queueSnapshot(rendererId: string): Record<string, Json> | undefined { return this.queues.get(rendererId); }

  installQueueSnapshot(rendererId: string, raw: Record<string, Json>): Record<string, Json> | undefined {
    if (!this.live.has(rendererId) || typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.items)) return undefined;
    const previous = this.queues.get(rendererId);
    if (previous && ((typeof previous.revision === 'number' && raw.revision < previous.revision)
      || previous.status === 'persistence-failed' && raw.status === 'authoritative')) return undefined;
    const snapshot = projectQueueSnapshot(raw);
    this.queues.set(rendererId, snapshot);
    return snapshot;
  }

  /** Paths actually granted to a bound engine session, including an older configuration. */
  resourceRoots(rendererId: string): string[] {
    const init = this.live.get(rendererId)?.init;
    if (!init || typeof init !== 'object' || Array.isArray(init)) return [];
    const config = init.config && typeof init.config === 'object' && !Array.isArray(init.config) ? init.config : {};
    const workspace = object(config.sandbox_workspace_write);
    return [init.cwd, ...(Array.isArray(workspace?.writable_roots) ? workspace.writable_roots : [])]
      .filter((value): value is string => typeof value === 'string');
  }

  /** Roots contributed by host resources, independent of editable configuration. */
  hostWritableRoots(rendererId: string): readonly string[] {
    return this.live.get(rendererId)?.hostWritableRoots ?? [];
  }

  /** Capture an acknowledged workspace policy only for the binding that received it. */
  applyWorkspaceSettings(rendererId: string, engineId: string, workspace: SandboxWorkspaceWrite): void {
    const entry = this.live.get(rendererId);
    if (!entry || entry.engineId !== engineId) return;
    const init = object(entry.init);
    if (!init) return;
    const config = object(init.config) ?? {};
    init.config = { ...config, sandbox_workspace_write: { ...workspace, writable_roots: [...workspace.writable_roots] } };
  }

  /** The actual bound init retains its task boundary across settings changes. */
  hasTaskResourceScope(rendererId: string): boolean {
    const config = object(object(this.live.get(rendererId)?.init)?.config);
    return config?.taskResourceScope != null || config?.task_resource_scope != null;
  }

  /** Every binding, for diagnostics and for a shutdown sweep. */
  bindings(): Array<{ rendererId: string; engineId: string; touchedAt: number; stale: boolean }> {
    return [...this.live.entries()].map(([rendererId, entry]) => ({
      rendererId,
      engineId: entry.engineId,
      touchedAt: entry.touchedAt,
      stale: entry.stale,
    }));
  }

  /** How many bindings exist. */
  liveCount(): number {
    return this.live.size;
  }

  // ---------------------------------------------------------------------
  // In-flight starts
  // ---------------------------------------------------------------------

  /**
   * Share one `session/start` between concurrent callers for the same renderer id.
   *
   * `session:new`'s background warm-up and a fast first send both resolve the same id
   * (`main.rs:2003-2008`), and two `session/start` calls would leave the renderer watching
   * the losing session. The first caller's promise is stored; later callers await it. The
   * entry is always removed, including on failure, so a failed start does not poison the id.
   *
   * Typed to the one thing this gate is for — the engine session id a start resolves to —
   * rather than made generic. A generic version has to store `Promise<unknown>` and cast it
   * back out, which is exactly where two callers with different `T` for one id would be
   * silently handed each other's promise; naming the type makes that unrepresentable.
   */
  async withStartGate(rendererId: string, start: () => Promise<string>): Promise<string> {
    const existing = this.starting.get(rendererId);
    if (existing !== undefined) return existing;
    const promise = start().finally(() => {
      // Only remove OUR entry: a newer gate may already have replaced it if this one
      // settled after a retry installed another.
      if (this.starting.get(rendererId) === promise) this.starting.delete(rendererId);
    });
    this.starting.set(rendererId, promise);
    return promise;
  }

  /** How many starts are in flight, for diagnostics. */
  startingCount(): number {
    return this.starting.size;
  }

  // ---------------------------------------------------------------------
  // Running turns
  // ---------------------------------------------------------------------

  /** Observe running-turn set changes (restart ledger maintenance hooks here). */
  onTurnRunningChange?: () => void;

  /**
   * Submission identities outlive terminal events so a delayed ACK or inspection can
   * still join the original optimistic row. Binding removal retires the whole ledger.
   */
  private readonly submittedMessages = new Map<string, Map<string, {
    engineId: string; clientMessageId: string; displayMetadata: Json;
    userMessageId?: string; turnId?: string; startsTurn: boolean; settled?: boolean;
  }>>();

  noteSubmittedMessage(rendererId: string, engineId: string, submissionId: string,
    clientMessageId: string, displayMetadata: Json, userMessageId?: string): void {
    if (this.liveSession(rendererId) !== engineId || !clientMessageId || clientMessageId.length > 512) return;
    const records = this.submittedMessages.get(rendererId) ?? new Map();
    // A late retry may not transfer an already issued identity to another input.
    if (records.has(submissionId)) return;
    records.set(submissionId, { engineId, clientMessageId, displayMetadata,
      ...(userMessageId ? { userMessageId } : {}), startsTurn: !userMessageId });
    this.submittedMessages.set(rendererId, records);
    // Keep recent completed admissions, while retaining the current turn's owner.
    while (records.size > 256) {
      const oldest = [...records.keys()].find(id => id !== this.runningSubmissionId(rendererId));
      if (!oldest) break;
      records.delete(oldest);
    }
  }

  bindSubmittedTurn(rendererId: string, engineId: string, submissionId: string, turnId: string): string | undefined {
    if (this.liveSession(rendererId) !== engineId) return undefined;
    const record = this.submittedMessages.get(rendererId)?.get(submissionId);
    if (!record?.startsTurn || record.engineId !== engineId || record.turnId && record.turnId !== turnId) return undefined;
    record.turnId = turnId;
    return record.clientMessageId;
  }

  turnClientMessageId(rendererId: string, engineId: string, turnId: string): string | undefined {
    if (this.liveSession(rendererId) !== engineId) return undefined;
    const records = this.submittedMessages.get(rendererId);
    if (!records) return undefined;
    return [...records.entries()].find(([submissionId, record]) => record.startsTurn
      && record.engineId === engineId && (record.turnId === turnId || submissionId === turnId))?.[1].clientMessageId;
  }

  submittedTurnSettled(rendererId: string, engineId: string, turnId: string): boolean {
    if (this.liveSession(rendererId) !== engineId) return false;
    return [...(this.submittedMessages.get(rendererId)?.entries() ?? [])].some(([submissionId, record]) =>
      record.engineId === engineId && record.startsTurn && record.settled
      && (submissionId === turnId || record.turnId === turnId));
  }

  bindSubmittedTurnFromMessages(rendererId: string, engineId: string, turnId: string, userMessageIds: ReadonlySet<string>): string | undefined {
    if (this.liveSession(rendererId) !== engineId) return undefined;
    for (const [submissionId, record] of this.submittedMessages.get(rendererId) ?? []) {
      if (record.engineId === engineId && record.startsTurn && record.userMessageId
        && userMessageIds.has(record.userMessageId)) return this.bindSubmittedTurn(rendererId, engineId, submissionId, turnId);
    }
    return undefined;
  }

  settleSubmittedTurn(rendererId: string, engineId: string, turnIds: ReadonlySet<string>): void {
    if (this.liveSession(rendererId) !== engineId) return;
    for (const [submissionId, record] of this.submittedMessages.get(rendererId) ?? []) {
      if (record.engineId === engineId && record.startsTurn
        && (turnIds.has(submissionId) || record.turnId && turnIds.has(record.turnId))) record.settled = true;
    }
  }

  submittedMessage(rendererId: string, engineId: string, userMessageId: string, submissionId?: string):
    { clientMessageId: string; displayMetadata: Json } | undefined {
    if (this.liveSession(rendererId) !== engineId) return undefined;
    const records = this.submittedMessages.get(rendererId);
    if (!records) return undefined;
    const known = [...records.values()].find(record => record.engineId === engineId && record.userMessageId === userMessageId);
    if (known) return known;
    // Only the exact facade submission may associate its first canonical user UUID.
    const record = submissionId ? records.get(submissionId) : undefined;
    if (!record?.startsTurn || record.engineId !== engineId || record.userMessageId) return undefined;
    record.userMessageId = userMessageId;
    return record;
  }

  /** Mark a turn accepted for a session. */
  markTurnRunning(rendererId: string, turnId?: string, submissionId = turnId): void {
    this.running.add(rendererId);
    if (turnId !== undefined && turnId.length > 0) this.turnIds.set(rendererId, turnId);
    if (submissionId) this.turnSubmissionIds.set(rendererId, submissionId);
    // A newly accepted turn supersedes any stop window from the previous one.
    this.interruptWindows.delete(rendererId);
    this.onTurnRunningChange?.();
  }

  /** The turn id currently running for a session, if the host knows it. */
  private readonly turnIds = new Map<string, string>();
  private readonly turnSubmissionIds = new Map<string, string>();

  /** Named facade methods bind to the ACK submission ID, distinct from the UI engine UUID. */
  runningSubmissionId(rendererId: string): string | undefined { return this.turnSubmissionIds.get(rendererId); }

  markTurnSubmissionId(rendererId: string, submissionId: string): void {
    if (this.isWorking(rendererId)) this.turnSubmissionIds.set(rendererId, submissionId);
  }

  runningTurnId(rendererId: string): string | undefined {
    return this.turnIds.get(rendererId);
  }

  /** Clear the running flag when a turn settles. */
  clearTurnRunning(rendererId: string): void {
    this.running.delete(rendererId);
    this.turnIds.delete(rendererId);
    this.turnSubmissionIds.delete(rendererId);
    this.onTurnRunningChange?.();
  }

  /**
   * The window between an accepted user stop and the engine's terminal event.
   *
   * A stop settles the running registry OPTIMISTICALLY so the click feels
   * instant, but the engine turn is still winding down. In that gap the session
   * LOOKS idle to every `isWorking` guard: a stale-binding rebuild, an idle
   * retirement or any teardown could `session/close` the session and kill the
   * turn mid-abort — and because the close path reads the same registry, it
   * would not even push the `interrupted` frame the transcript needs. The
   * window keeps those paths treating the session as occupied until the
   * engine's own terminal word arrives (or the deadline expires, so a lost
   * event cannot pin a session forever).
   */
  private readonly interruptWindows = new Map<string, number>();

  noteInterruptWindow(rendererId: string): void {
    this.interruptWindows.set(rendererId, Date.now() + INTERRUPT_WINDOW_MS);
  }

  clearInterruptWindow(rendererId: string): void {
    this.interruptWindows.delete(rendererId);
  }

  inInterruptWindow(rendererId: string): boolean {
    const deadline = this.interruptWindows.get(rendererId);
    if (deadline === undefined) return false;
    if (Date.now() >= deadline) {
      this.interruptWindows.delete(rendererId);
      return false;
    }
    return true;
  }

  /** Whether a session has an unsettled turn — `session:list.isWorking` reads this. */
  isWorking(rendererId: string): boolean {
    return this.running.has(rendererId);
  }

  /**
   * Whether an interrupt's `expectedTurnId` is stale.
   *
   * `interrupt_request_is_stale` (`main.rs:5127-5129`): a non-empty expected id that does
   * not match the active turn means the renderer is stopping a turn that already settled.
   * The request is then answered `accepted:false` and NOT forwarded, so a late Stop cannot
   * cancel the next turn — the failure mode the renderer's expected-turn-id protocol exists
   * to prevent.
   *
   * An EMPTY expected id is not stale: it means "stop whatever is running", which is what a
   * renderer that never saw a turn id must be able to do.
   */
  interruptIsStale(rendererId: string, expectedTurnId: string | undefined): boolean {
    if (expectedTurnId === undefined || expectedTurnId.length === 0) return false;
    const active = this.turnIds.get(rendererId);
    if (active === undefined) return true;
    return active !== expectedTurnId;
  }

  /** Every session with an unsettled turn. */
  runningSessions(): string[] {
    return [...this.running];
  }

  // ---------------------------------------------------------------------
  // Parked reverse requests
  // ---------------------------------------------------------------------

  /** Park one reverse request the user must answer. */
  parkReverse(entry: PendingReverse): void {
    this.pending.set(entry.requestId, entry);
  }

  /** Take a parked request out, so it can be answered exactly once. */
  takePending(requestId: string): PendingReverse | undefined {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return undefined;
    this.pending.delete(requestId);
    return entry;
  }

  /** A parked request without removing it, for `permission:pending`. */
  peekPending(requestId: string): PendingReverse | undefined {
    return this.pending.get(requestId);
  }

  /** Every parked request for one session, in arrival order. */
  pendingForSession(sessionId: string): PendingReverse[] {
    return [...this.pending.values()].filter((entry) => entry.sessionId === sessionId);
  }

  /** The parked APPROVAL cards for one session, for `permission:pending`. */
  pendingApprovalCards(sessionId: string): Json[] {
    return this.pendingForSession(sessionId)
      .filter((entry) => entry.isApproval)
      .map((entry) => entry.card);
  }

  /** The parked ELICITATION cards for one session, for `elicit:pending`. */
  pendingElicitCards(sessionId: string): Json[] {
    return this.pendingForSession(sessionId)
      .filter((entry) => !entry.isApproval)
      .map((entry) => entry.card);
  }

  /**
   * Take every parked request for a session out, for cancellation.
   *
   * Taken rather than peeked because each one is about to be answered, and answering twice
   * is a no-op at the wire level but would still emit two cancellation events to the
   * renderer.
   */
  takePendingForSession(sessionId: string): PendingReverse[] {
    const taken: PendingReverse[] = [];
    for (const [requestId, entry] of [...this.pending.entries()]) {
      if (entry.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      taken.push(entry);
    }
    return taken;
  }

  /**
   * Take the parked APPROVAL cards for one session out, leaving elicitation cards parked.
   *
   * Narrower than {@link takePendingForSession} because a policy switch that turns off
   * prompting settles only approvals. The engine answers its own parked prompts in that
   * case and keeps every question open, so withdrawing a question here would drop a
   * reply the model is still waiting for.
   */
  takePendingApprovalsForSession(sessionId: string): PendingReverse[] {
    const taken: PendingReverse[] = [];
    for (const [requestId, entry] of [...this.pending.entries()]) {
      if (entry.sessionId !== sessionId || !entry.isApproval) continue;
      this.pending.delete(requestId);
      taken.push(entry);
    }
    return taken;
  }

  /** Take EVERY parked request out, for shutdown. */
  takeAllPending(): PendingReverse[] {
    const taken = [...this.pending.values()];
    this.pending.clear();
    return taken;
  }

  /** How many requests are parked, for diagnostics. */
  pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * The response that cancels a parked request.
 *
 * `cancel_reverse_response` (`main.rs:2651-2658`): an approval is denied, an elicitation is
 * declined. The shapes differ because the engine's two request types expect different
 * answers — sending `{kind:"decline"}` to an approval would not parse.
 */
export function cancelResponse(isApproval: boolean): Json {
  return isApproval ? { decision: 'deny' } : { kind: 'decline' };
}

/**
 * The chat event that tells the renderer a parked request was cancelled.
 *
 * `cancel_pending_reverse` pushes `permission_cancelled` or `elicit_cancelled` with the
 * request id (`main.rs:2680-2688`), so an open approval card closes instead of sitting there
 * forever waiting for an answer the engine no longer wants.
 */
export function cancelledEvent(isApproval: boolean, requestId: string, sessionId: string): Json {
  return {
    type: isApproval ? 'permission_cancelled' : 'elicit_cancelled',
    sessionId,
    requestId,
  };
}
