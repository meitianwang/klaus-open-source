import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AcknowledgedClient } from '../engine/acknowledged';
import { decodeTurnInputReply, TurnInputRefusedError, type TurnInputAccepted, type TurnInputRequest } from '../engine/turn-input';
import type { Json } from '../ipc/contract';
import type { JsonObject } from '../services/service-types';
import {
  ClientFollowUpQueue, QueueMutationError, UNCONFIRMED_DELIVERY_REASON,
  type ClientQueueRow, type ClientQueueSnapshot, type PositionAnchors, type QueueMutationReceipt,
} from './client-queue';

export interface EngineClientQueueDeps {
  configRoot: string;
  client(): Promise<AcknowledgedClient>;
  threadId(rendererId: string): string;
  assertCurrent(client: AcknowledgedClient, rendererId: string, threadId: string, method?: string): void;
  prepare(rendererId: string, item: JsonObject): Promise<Json>;
  publish?(rendererId: string, snapshot: ClientQueueSnapshot): void;
}

/** Admission already transferred ownership; a later read cannot undo that receipt. */
export class QueueAdmissionSnapshotError extends Error {
  constructor(cause: unknown) {
    super('The queued message was saved, but its refreshed queue is unavailable.', { cause });
  }
}

interface EngineQueueEntry {
  id: string;
  input?: Json[];
  inputOmitted?: boolean;
  inputFingerprint?: string;
  rowVersion?: number;
  clientUserMessageId?: string;
  clientMetadata?: JsonObject;
  pausedReason?: string;
  createdAt: number;
  dispatching?: JsonObject;
}
interface QueueView {
  snapshot: ClientQueueSnapshot;
  entries: Map<string, EngineQueueEntry>;
}
interface PreparedClaim { row: ClientQueueRow; entry: EngineQueueEntry; automatic?: boolean; turnId?: string; messageId?: string }
const record = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const parts = (input: Json): Json[] => typeof input === 'string' ? [{ type: 'text', text: input }] : Array.isArray(input) ? [...input] : (() => { throw new Error('Queued input must contain native input parts'); })();
const itemText = (item: JsonObject): string => typeof item.finalText === 'string' && item.finalText.trim() ? item.finalText : typeof item.text === 'string' ? item.text : '';
const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validInputFingerprint = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const projectedMethods = new Set(['thread/queue/list', 'thread/queue/add', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/start', 'thread/queue/clear']);
function queueEntry(value: unknown): EngineQueueEntry {
  const entry = record(value);
  if (!entry || typeof entry.id !== 'string' || !entry.id || !validRevision(entry.createdAt)
    || (entry.inputFingerprint !== undefined && !validInputFingerprint(entry.inputFingerprint))
    || (entry.rowVersion !== undefined && !validRevision(entry.rowVersion))
    || (entry.inputOmitted === true
      ? entry.input !== undefined || !validInputFingerprint(entry.inputFingerprint) || !validRevision(entry.rowVersion)
      : !Array.isArray(entry.input))) throw new Error('The engine returned an invalid queued submission');
  return entry as unknown as EngineQueueEntry;
}

/** A renderer projection of the app-server queue. It never executes from a local store. */
export class EngineClientFollowUpQueue {
  private readonly legacy: ClientFollowUpQueue;
  private readonly migrations = new Map<string, Promise<void>>();
  private readonly views = new Map<string, QueueView>();
  private readonly preparations = new Map<string, PreparedClaim>();
  private readonly pendingPresentation = new Map<string, ClientQueueRow>();
  private readonly resolvingPresentation = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: EngineClientQueueDeps) { this.legacy = new ClientFollowUpQueue(deps.configRoot); }

  /** This cache is only for synchronous presentation decisions, never admission. */
  peek(rendererId: string): ClientQueueSnapshot | null { return this.views.get(rendererId)?.snapshot ?? null; }
  private key(rendererId: string, id: string): string { return rendererId + '\0' + id; }
  private exclusive<T>(rendererId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(rendererId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.locks.set(rendererId, next);
    void next.finally(() => { if (this.locks.get(rendererId) === next) this.locks.delete(rendererId); }).catch(() => {});
    return next;
  }
  private async request(rendererId: string, method: string, params: JsonObject = {}, timeout = 30_000): Promise<JsonObject> {
    const threadId = this.deps.threadId(rendererId), client = await this.deps.client();
    this.deps.assertCurrent(client, rendererId, threadId, method);
    try {
      const reply = record(await client.requestWithTimeout(method, { threadId,
        ...(projectedMethods.has(method) ? { includeInput: false } : {}), ...params }, timeout));
      this.deps.assertCurrent(client, rendererId, threadId, method);
      if (!reply) throw new Error('The engine returned an invalid queue acknowledgement');
      return reply;
    } catch (error) {
      const value = record(error), data = record(value?.data);
      if (value?.code === -32014 || validRevision(data?.revision) && validRevision(data?.expectedRevision)) {
        throw new QueueMutationError('queue_revision_changed', 'The follow-up queue changed; refresh it before editing');
      }
      throw error;
    }
  }
  private async migrate(rendererId: string): Promise<void> {
    const existing = this.migrations.get(rendererId);
    if (existing) return existing;
    const pending = (async () => {
      const legacy = this.legacy.exportMigration(rendererId);
      if (!legacy.items.length && !legacy.receipts.length && !legacy.revision) return;
      const migrationId = createHash('sha256').update(this.deps.configRoot + '\0' + rendererId + '\0' + legacy.fingerprint).digest('hex');
      await this.request(rendererId, 'thread/queue/import', {
        migrationId, minimumRevision: legacy.revision,
        queuedSubmissions: legacy.items.map(row => ({
          input: [{ type: 'text', text: itemText(row.item) }], clientUserMessageId: row.id,
          clientMetadata: { item: row.item, legacyUnprepared: true }, createdAt: row.createdAt,
          ...(row.pausedReason ? { pausedReason: row.pausedReason } : {}),
          ...(row.dispatching || row.item.followUpState === 'unconfirmed' ? { dispatching: {
            submissionId: typeof row.item.queuedTurnSubmissionId === 'string' ? row.item.queuedTurnSubmissionId
              : typeof row.item.followUpMessageId === 'string' ? 'steer-' + row.item.followUpMessageId : 'legacy-' + row.id,
            mode: typeof row.item.followUpMessageId === 'string' ? 'steer' : 'start-if-idle',
          } } : {}),
        })), receipts: legacy.receipts as unknown as Json,
      });
      // A lost import acknowledgement leaves this proof in place for safe replay.
      this.legacy.acknowledgeMigration(rendererId, legacy.fingerprint);
    })();
    this.migrations.set(rendererId, pending);
    void pending.catch(() => { if (this.migrations.get(rendererId) === pending) this.migrations.delete(rendererId); });
    return pending;
  }
  private project(rendererId: string, raw: EngineQueueEntry): ClientQueueRow {
    const id = typeof raw.clientUserMessageId === 'string' && raw.clientUserMessageId ? raw.clientUserMessageId : raw.id;
    const metadata = record(raw.clientMetadata), stored = record(metadata?.item);
    const text = (raw.input ?? []).map(part => { const value = record(part); return value?.type === 'text' && typeof value.text === 'string' ? value.text : ''; }).filter(Boolean).join('\n');
    const item: JsonObject = stored ? { ...stored } : { text, finalText: text, displayText: text, media: [] };
    const dispatch = record(raw.dispatching), unknown = raw.pausedReason === 'admission-unknown';
    const claim = this.preparations.get(this.key(rendererId, id));
    if (unknown && !claim) {
      item.followUpState = 'unconfirmed';
      if (typeof dispatch?.submissionId === 'string') {
        if (dispatch.mode === 'steer') item.followUpMessageId = dispatch.submissionId.replace(/^steer-/, '');
        else item.queuedTurnSubmissionId = dispatch.submissionId;
      }
    }
    if (claim) item.followUpState = 'pending';
    if (claim?.messageId) item.followUpMessageId = claim.messageId;
    if (claim?.turnId) item.queuedTurnSubmissionId = claim.turnId;
    return { id, item, createdAt: raw.createdAt,
      pausedReason: claim ? null : unknown ? UNCONFIRMED_DELIVERY_REASON : typeof raw.pausedReason === 'string' && raw.pausedReason ? raw.pausedReason : null,
      ...(claim || (!unknown && dispatch) ? { dispatching: true } : {}) };
  }
  private install(rendererId: string, entries: EngineQueueEntry[], revision: number): ClientQueueSnapshot {
    const previous = this.views.get(rendererId);
    if (previous && previous.snapshot.revision > revision) return previous.snapshot;
    const mapped = new Map<string, EngineQueueEntry>();
    const items = entries.map(entry => { const row = this.project(rendererId, entry); mapped.set(row.id, entry); return row; });
    const snapshot = { revision, items };
    this.views.set(rendererId, { snapshot, entries: mapped });
    return snapshot;
  }
  async snapshot(rendererId: string): Promise<ClientQueueSnapshot> {
    await this.migrate(rendererId);
    // A revision-scoped cursor can refuse a concurrent change; retry one entire read.
    for (let attempt = 0; ; attempt++) {
      try {
        const entries: EngineQueueEntry[] = [], cursors = new Set<string>();
        let cursor: string | null = null, revision: number | undefined;
        do {
          const reply = await this.request(rendererId, 'thread/queue/list', { limit: 128, ...(cursor ? { cursor } : {}) });
          if (!validRevision(reply.revision) || !Array.isArray(reply.data)) throw new Error('The engine did not return an authoritative queue snapshot');
          if (revision !== undefined && revision !== reply.revision) throw new QueueMutationError('queue_revision_changed', 'The queue changed during pagination');
          revision = reply.revision;
          for (const value of reply.data) {
            let entry = queueEntry(value);
            // External producers may omit presentation metadata. Fetch only that row's input.
            if (entry.inputOmitted && !record(record(entry.clientMetadata)?.item)) {
              const full = await this.request(rendererId, 'thread/queue/list', {
                cursor: revision + ':' + entries.length, limit: 1, includeInput: true,
              });
              if (full.revision !== revision) throw new QueueMutationError('queue_revision_changed', 'The queue changed while restoring its presentation');
              if (!Array.isArray(full.data) || full.data.length !== 1) throw new Error('The engine did not return the queued input for presentation');
              const restored = queueEntry(full.data[0]);
              if (restored.id !== entry.id || !Array.isArray(restored.input) || restored.inputFingerprint !== entry.inputFingerprint
                || restored.rowVersion !== entry.rowVersion) throw new QueueMutationError('queue_revision_changed', 'The queued input changed while restoring its presentation');
              entry = restored;
            }
            entries.push(entry);
          }
          if (reply.nextCursor !== null && reply.nextCursor !== undefined && typeof reply.nextCursor !== 'string') throw new Error('The engine returned an invalid queue cursor');
          cursor = typeof reply.nextCursor === 'string' && reply.nextCursor ? reply.nextCursor : null;
          if (cursor && (cursors.has(cursor) || entries.length > 10000)) throw new Error('The engine queue pagination did not advance');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return this.install(rendererId, entries, revision!);
      } catch (error) {
        if (attempt === 0 && error instanceof QueueMutationError && error.code === 'queue_revision_changed') continue;
        throw error;
      }
    }
  }
  private async view(rendererId: string, expectedRevision?: number): Promise<QueueView> {
    const snapshot = await this.snapshot(rendererId);
    if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) throw new QueueMutationError('queue_revision_changed', 'The follow-up queue changed; refresh it before editing');
    return this.views.get(rendererId)!;
  }
  private inflight(rendererId: string): boolean {
    return [...this.preparations.keys()].some(key => key.startsWith(rendererId + '\0'));
  }
  private entry(view: QueueView, id: string): EngineQueueEntry {
    const entry = view.entries.get(id);
    if (!entry) throw new QueueMutationError('queue_row_unavailable', 'The queued message is no longer available');
    return entry;
  }
  private anchors(view: QueueView, position: PositionAnchors): JsonObject {
    const before = position.beforeId ? view.entries.get(position.beforeId)?.id : undefined;
    const after = !before && position.afterId ? view.entries.get(position.afterId)?.id : undefined;
    return { ...(before ? { beforeId: before } : {}), ...(after ? { afterId: after } : {}) };
  }
  private receipt(receipt?: QueueMutationReceipt): JsonObject {
    return receipt ? { mutationId: receipt.id, mutationFingerprint: receipt.fingerprint } : {};
  }
  private async snapshotAfterAdmission(rendererId: string): Promise<ClientQueueSnapshot> {
    try { return await this.snapshot(rendererId); }
    catch (cause) { throw new QueueAdmissionSnapshotError(cause); }
  }
  async add(rendererId: string, id: string, item: JsonObject, position: PositionAnchors = {}, receipt?: QueueMutationReceipt): Promise<ClientQueueSnapshot> {
    return this.exclusive(rendererId, async () => {
      await this.migrate(rendererId);
      const anchors = position.beforeId || position.afterId ? this.anchors(await this.view(rendererId), position) : {};
      let prepared: Json[];
      try { prepared = parts(await this.deps.prepare(rendererId, item)); }
      catch (error) {
        // A consumed admission receipt remains valid if its attachment source disappeared.
        const known = await this.request(rendererId, 'thread/queue/add', { clientUserMessageId: id,
          input: [], lookupOnly: true, clientMetadata: { item }, ...this.receipt(receipt) });
        if (known.found === true && known.replayed === true) return this.snapshotAfterAdmission(rendererId);
        throw error;
      }
      await this.request(rendererId, 'thread/queue/add', { input: prepared, clientUserMessageId: id,
        clientMetadata: { item }, ...anchors, ...this.receipt(receipt) });
      return this.snapshotAfterAdmission(rendererId);
    });
  }
  async remove(rendererId: string, id: string, expectedRevision?: number, receipt?: QueueMutationReceipt): Promise<{ snapshot: ClientQueueSnapshot; removed?: ClientQueueRow }> {
    return this.exclusive(rendererId, async () => {
      const view = await this.view(rendererId);
      // Stable deletion receipts are replayed before stale revision checks by the engine.
      const entry = view.entries.get(id);
      if (!entry && !receipt) {
        if (expectedRevision !== undefined && expectedRevision !== view.snapshot.revision) throw new QueueMutationError('queue_revision_changed', 'The queue changed before removal');
        return { snapshot: view.snapshot };
      }
      if (this.preparations.has(this.key(rendererId, id))) throw new QueueMutationError('queue_row_inflight', 'The queued message is being prepared');
      const reply = await this.request(rendererId, 'thread/queue/delete', {
        queuedSubmissionId: entry?.id ?? id,
        ...(!entry || !record(record(entry.clientMetadata)?.item) ? { includeInput: true } : {}),
        ...(expectedRevision === undefined ? {} : { expectedRevision }), ...this.receipt(receipt),
      });
      const original = record(reply.queuedSubmission);
      const legacyRemoved = record(record(reply.receipt)?.removed);
      const removed = original ? this.project(rendererId, queueEntry(original))
        : legacyRemoved ? legacyRemoved as unknown as ClientQueueRow : undefined;
      return { snapshot: await this.snapshot(rendererId), ...(removed ? { removed } : {}) };
    });
  }
  async restore(rendererId: string, row: ClientQueueRow, position: PositionAnchors = {}, atHead = false, expectedRevision?: number, requireRemovedReceipt = false): Promise<ClientQueueSnapshot> {
    return this.exclusive(rendererId, async () => {
      const view = await this.view(rendererId, expectedRevision);
      if (row.dispatching) throw new QueueMutationError('queue_row_inflight', 'An in-flight message cannot be restored');
      const anchors = atHead && view.snapshot.items[0] ? { beforeId: this.entry(view, view.snapshot.items[0].id).id } : this.anchors(view, position);
      // Undo needs the saved proof. A definite first-add refusal creates a new paused recovery item.
      await this.request(rendererId, 'thread/queue/add', { input: [{ type: 'text', text: itemText(row.item) }], clientUserMessageId: row.id,
        clientMetadata: { item: row.item, legacyUnprepared: true }, createdAt: row.createdAt, ...(row.pausedReason ? { pausedReason: row.pausedReason } : {}),
        ...(requireRemovedReceipt ? { restore: true, requireRemovedReceipt: true } : {}),
        ...(expectedRevision === undefined ? {} : { expectedRevision }), ...anchors });
      return this.snapshot(rendererId);
    });
  }
  async reorder(rendererId: string, id: string, beforeId: string | null, expectedRevision?: number): Promise<ClientQueueSnapshot> {
    return this.exclusive(rendererId, async () => {
      const view = await this.view(rendererId, expectedRevision);
      if (this.inflight(rendererId) || view.snapshot.items.some(row => row.dispatching)) throw new QueueMutationError('queue_row_inflight', 'Wait for the active queue delivery');
      const ids = [...view.entries.values()].map(entry => entry.id), moved = this.entry(view, id).id;
      ids.splice(ids.indexOf(moved), 1);
      const before = beforeId ? this.entry(view, beforeId).id : undefined;
      ids.splice(before ? ids.indexOf(before) : ids.length, 0, moved);
      await this.request(rendererId, 'thread/queue/reorder', { queuedSubmissionIds: ids, expectedRevision: view.snapshot.revision });
      return this.snapshot(rendererId);
    });
  }
  async pauseAll(rendererId: string, reason: string): Promise<ClientQueueSnapshot> {
    const view = await this.view(rendererId);
    const ids = [...view.entries.values()].filter(row => !row.dispatching && !row.pausedReason).map(row => row.id);
    if (!ids.length) return view.snapshot;
    await this.request(rendererId, 'thread/queue/pause', { reason, queuedSubmissionIds: ids, expectedRevision: view.snapshot.revision });
    return this.snapshot(rendererId);
  }
  async resumeInterrupted(rendererId: string, reason: string, expectedRevision?: number): Promise<ClientQueueSnapshot> {
    await this.migrate(rendererId);
    await this.request(rendererId, 'thread/queue/resume', { reason, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
    return this.snapshot(rendererId);
  }
  async claimNext(rendererId: string): Promise<{ row?: ClientQueueRow; snapshot: ClientQueueSnapshot }> {
    return this.exclusive(rendererId, async () => {
      const view = await this.view(rendererId);
      if (this.inflight(rendererId) || view.snapshot.items.some(row => row.dispatching)) return { snapshot: view.snapshot };
      const row = view.snapshot.items.find(row => !row.pausedReason);
      if (!row) return { snapshot: view.snapshot };
      this.preparations.set(this.key(rendererId, row.id), { row, entry: this.entry(view, row.id), automatic: true });
      return { row, snapshot: this.install(rendererId, [...view.entries.values()], view.snapshot.revision) };
    });
  }
  async claim(rendererId: string, id: string, expectedRevision?: number): Promise<{ row: ClientQueueRow; snapshot: ClientQueueSnapshot }> {
    return this.exclusive(rendererId, async () => {
      let view = await this.view(rendererId, expectedRevision);
      if (this.inflight(rendererId) || view.snapshot.items.some(row => row.dispatching)) throw new QueueMutationError('queue_delivery_busy', 'Another queued message is being delivered');
      let row = view.snapshot.items.find(row => row.id === id);
      if (!row) throw new QueueMutationError('queue_row_unavailable', 'The queued message is no longer available');
      if (row.pausedReason && row.pausedReason !== UNCONFIRMED_DELIVERY_REASON) {
        await this.request(rendererId, 'thread/queue/resume', { reason: row.pausedReason, queuedSubmissionIds: [this.entry(view, id).id], expectedRevision: view.snapshot.revision });
        view = await this.view(rendererId); row = view.snapshot.items.find(candidate => candidate.id === id);
        if (!row) throw new QueueMutationError('queue_row_unavailable', 'The queued message is no longer available');
      }
      this.preparations.set(this.key(rendererId, id), { row, entry: this.entry(view, id) });
      return { row, snapshot: this.install(rendererId, [...view.entries.values()], view.snapshot.revision) };
    });
  }
  bindTurnClaim(rendererId: string, id: string, submissionId: string): void {
    const claim = this.preparations.get(this.key(rendererId, id));
    if (!claim) throw new QueueMutationError('queue_row_unavailable', 'The queued message is no longer being prepared');
    claim.turnId = submissionId;
  }
  bindSteerClaim(rendererId: string, id: string, messageId: string): void {
    const claim = this.preparations.get(this.key(rendererId, id));
    if (!claim) throw new QueueMutationError('queue_row_unavailable', 'The queued message is no longer being prepared');
    claim.messageId = messageId;
  }
  /** New rows already contain portable bytes. Only imported path-based rows prepare once. */
  async preparedInput(rendererId: string, id: string): Promise<Json> {
    let view = await this.view(rendererId), entry = this.entry(view, id);
    const metadata = record(entry.clientMetadata);
    if (metadata?.legacyUnprepared === true) {
      const item = record(metadata.item);
      if (!item) throw new QueueMutationError('queue_row_unavailable', 'The imported queued input has no recoverable payload');
      const input = parts(await this.deps.prepare(rendererId, item));
      await this.request(rendererId, 'thread/queue/update', { queuedSubmissionId: entry.id, input,
        clientMetadata: { ...metadata, legacyUnprepared: false }, expectedRevision: view.snapshot.revision });
      view = await this.view(rendererId); entry = this.entry(view, id);
      const claim = this.preparations.get(this.key(rendererId, id));
      if (claim) claim.entry = entry;
    }
    // The app-server owns portable input. An omitted payload is not a replacement request.
    return entry.input ?? [];
  }

  async start(rendererId: string, id: string, request: TurnInputRequest, timeoutMs: number, retryUnconfirmed = false, onIssue?: () => void): Promise<TurnInputAccepted> {
    await this.migrate(rendererId);
    const claim = this.preparations.get(this.key(rendererId, id));
    const view = await this.view(rendererId);
    let entry = this.entry(view, id);
    if (claim && (claim.entry.inputFingerprint !== entry.inputFingerprint || claim.entry.rowVersion !== entry.rowVersion
      || (!entry.inputOmitted && !isDeepStrictEqual(claim.entry.input, entry.input))
      || !isDeepStrictEqual(claim.entry.clientMetadata, entry.clientMetadata))) {
      throw new QueueMutationError('queue_revision_changed', 'The queued input changed while its delivery was being prepared');
    }
    if (claim?.automatic && view.snapshot.items.find(row => !row.pausedReason && (!row.dispatching || row.id === id))?.id !== id) {
      throw new QueueMutationError('queue_revision_changed', 'The queue order changed while its delivery was being prepared');
    }
    const input = parts(request.input);
    // Rendering markers are an admission projection, never durable user input.
    if (request.mode === 'steer' && request.delivery === 'user' && record(input[0])?.text === '<!-- klaus-steered-message -->') input.shift();
    let revision = view.snapshot.revision;
    if (!entry.inputOmitted && !isDeepStrictEqual(input, entry.input)) {
      if (entry.dispatching) throw new QueueMutationError('queue_delivery_unknown', 'Unconfirmed queued input cannot be replaced before retry');
      const updated = await this.request(rendererId, 'thread/queue/update', { queuedSubmissionId: entry.id, input, expectedRevision: revision });
      if (!validRevision(updated.revision)) throw new QueueMutationError('queue_preparation_unconfirmed', 'The engine did not confirm queue input preparation');
      revision = updated.revision;
      entry = queueEntry(updated.queuedSubmission);
    }
    onIssue?.();
    const reply = await this.request(rendererId, 'thread/queue/start', { queuedSubmissionId: entry.id,
      mode: request.mode, ...(request.expectedTurnId ? { expectedTurnId: request.expectedTurnId } : {}),
      ...(request.submissionId ? { submissionId: request.submissionId } : {}),
      ...(request.queueMessageId ? { queueMessageId: request.queueMessageId } : {}),
      ...(request.options ? { options: request.options } : {}), ...(request.displayMetadata ? { displayMetadata: request.displayMetadata } : {}),
      ...(request.delivery ? { delivery: request.delivery } : {}), ...(retryUnconfirmed ? { retryUnconfirmed: true } : {}),
      expectedRevision: revision,
      ...(entry.inputFingerprint ? { expectedInputFingerprint: entry.inputFingerprint } : {}),
      ...(entry.rowVersion !== undefined ? { expectedRowVersion: entry.rowVersion } : {}),
    }, timeoutMs);
    try { return decodeTurnInputReply(reply, request); }
    catch (error) {
      if (error instanceof TurnInputRefusedError && error.reason.code === 'queue-entry-changed') {
        throw new QueueMutationError('queue_revision_changed', 'The queued input changed before admission');
      }
      throw error;
    }
  }
  async releaseClaim(rendererId: string, id: string): Promise<ClientQueueSnapshot> {
    this.preparations.delete(this.key(rendererId, id));
    return this.snapshot(rendererId);
  }
  async commitClaim(rendererId: string, id: string): Promise<ClientQueueSnapshot> { return this.releaseClaim(rendererId, id); }
  async retainUnconfirmed(rendererId: string, id: string): Promise<ClientQueueSnapshot> {
    const claim = this.preparations.get(this.key(rendererId, id));
    const previous = this.views.get(rendererId);
    const row = previous?.snapshot.items.find(candidate => candidate.id === id) ?? claim?.row;
    if (row && claim?.turnId) this.pendingPresentation.set(this.key(rendererId, claim.turnId), {
      ...row, item: { ...row.item, queuedTurnSubmissionId: claim.turnId }, dispatching: false,
    });
    this.preparations.delete(this.key(rendererId, id));
    try {
      const view = await this.view(rendererId), entry = view.entries.get(id);
      if (entry && !entry.dispatching) await this.request(rendererId, 'thread/queue/pause', { reason: UNCONFIRMED_DELIVERY_REASON, queuedSubmissionIds: [entry.id] });
      return await this.snapshot(rendererId);
    } catch (error) {
      if (!previous || !row) throw error;
      // Retain the last observed payload for presentation while the engine is unavailable.
      // It grants no execution authority and is never used by snapshot or dispatch.
      const snapshot = { revision: previous.snapshot.revision, items: previous.snapshot.items.map(candidate => candidate.id === id
        ? { ...candidate, dispatching: false, pausedReason: UNCONFIRMED_DELIVERY_REASON,
          item: { ...candidate.item, followUpState: 'unconfirmed', ...(claim?.turnId ? { queuedTurnSubmissionId: claim.turnId } : {}), ...(claim?.messageId ? { followUpMessageId: claim.messageId } : {}) } }
        : candidate) };
      this.views.set(rendererId, { ...previous, snapshot });
      return snapshot;
    }
  }
  async requeueFailed(rendererId: string, id: string, reason: string): Promise<ClientQueueSnapshot> {
    this.preparations.delete(this.key(rendererId, id));
    const view = await this.view(rendererId), entry = view.entries.get(id);
    if (entry && !entry.pausedReason && !entry.dispatching) await this.request(rendererId, 'thread/queue/pause', {
      reason: reason.trim() || 'The queued message could not be sent', queuedSubmissionIds: [entry.id], expectedRevision: view.snapshot.revision,
    });
    return this.snapshot(rendererId);
  }
  async resolveSteer(rendererId: string, messageId: string): Promise<ClientQueueSnapshot | undefined> {
    if (!this.peek(rendererId)?.items.some(row => row.item.followUpMessageId === messageId && !row.dispatching)) return undefined;
    const view = await this.view(rendererId);
    const row = view.snapshot.items.find(row => row.item.followUpMessageId === messageId && !row.dispatching);
    if (!row) return undefined;
    await this.request(rendererId, 'thread/queue/delete', { queuedSubmissionId: this.entry(view, row.id).id, expectedRevision: view.snapshot.revision });
    return this.snapshot(rendererId);
  }
  async resolveTurnClaim(rendererId: string, submissionId: string): Promise<{ row: ClientQueueRow; snapshot: ClientQueueSnapshot } | undefined> {
    const key = this.key(rendererId, submissionId);
    if (this.resolvingPresentation.has(key)) return undefined;
    const row = this.pendingPresentation.get(key) ?? this.peek(rendererId)?.items.find(candidate => candidate.item.queuedTurnSubmissionId === submissionId && !candidate.dispatching);
    if (!row) return undefined;
    // Consume the display correlation before awaiting so started/completed cannot render twice.
    this.pendingPresentation.delete(key);
    this.resolvingPresentation.add(key);
    try {
      const view = await this.view(rendererId), entry = view.entries.get(row.id);
      if (entry) await this.request(rendererId, 'thread/queue/delete', { queuedSubmissionId: entry.id, expectedRevision: view.snapshot.revision });
      return { row, snapshot: entry ? await this.snapshot(rendererId) : view.snapshot };
    } catch (error) { this.pendingPresentation.set(key, row); throw error; }
    finally { this.resolvingPresentation.delete(key); }
  }
  async clear(rendererId: string, expectedRevision?: number): Promise<{ snapshot: ClientQueueSnapshot; cleared: ClientQueueRow[] }> {
    return this.exclusive(rendererId, async () => {
      const view = await this.view(rendererId, expectedRevision);
      if (this.inflight(rendererId) || view.snapshot.items.some(row => row.dispatching)) throw new QueueMutationError('queue_row_inflight', 'Wait for the active queue delivery');
      const reply = await this.request(rendererId, 'thread/queue/clear', { expectedRevision: view.snapshot.revision,
        ...([...view.entries.values()].some(entry => !record(record(entry.clientMetadata)?.item)) ? { includeInput: true } : {}),
      });
      if (!validRevision(reply.revision) || !Array.isArray(reply.cleared)) throw new Error('The engine did not confirm clearing the queue');
      const cleared = reply.cleared.map(value => this.project(rendererId, queueEntry(value)));
      return { snapshot: await this.snapshot(rendererId), cleared };
    });
  }
  async discard(rendererId: string): Promise<void> {
    const reply = await this.request(rendererId, 'thread/queue/discard');
    if (!validRevision(reply.revision)) throw new Error('The engine did not confirm discarding the queue');
    this.forget(rendererId);
  }
  /** Session deletion already removed engine state; retire only host projections. */
  forget(rendererId: string): void {
    this.views.delete(rendererId); this.migrations.delete(rendererId);
    for (const key of this.preparations.keys()) if (key.startsWith(rendererId + '\0')) this.preparations.delete(key);
    for (const key of this.pendingPresentation.keys()) if (key.startsWith(rendererId + '\0')) this.pendingPresentation.delete(key);
    this.legacy.discard(rendererId);
  }
  invalidate(): void {
    this.views.clear(); this.preparations.clear(); this.pendingPresentation.clear(); this.migrations.clear();
  }
  async changed(threadId: string, rendererId?: string): Promise<void> {
    const ids = new Set([...this.views.keys()].filter(id => this.deps.threadId(id) === threadId));
    if (rendererId) ids.add(rendererId);
    for (const id of ids) this.deps.publish?.(id, await this.snapshot(id));
  }
}
