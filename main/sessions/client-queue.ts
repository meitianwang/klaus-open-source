// Legacy desktop queue storage. Runtime execution is owned by the app-server
// queue; this reader remains for transactional migration and historical receipts.
//
// Strict next-turn requests retain their unprepared composer payload here.
// The engine's durable message queue also preserves display metadata, but its
// prompt modes may drain inside a running turn. This queue waits for completion
// and then uses turn/submit with start-if-idle: a competing admission leaves the
// original row queued instead of injecting it into the other turn. All windows
// and remote UI surfaces share this store and its per-conversation claim.
//
// Durability lives in settings.db next to the session titles. Media entries
// hold `uploads/` paths rather than bytes, and `account-service.wipeLocal`
// removes settings.db and `uploads` together, so a persisted item can never
// outlive the attachment it points at.
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../ipc/contract';
import type { JsonObject } from '../services/service-types';
import { withSettingsDb, withSettingsTransaction } from '../services/settings';

/**
 * The pause reason a user interruption stamps on every queued message.
 *
 * A string rather than a flag because it must be distinguishable from a real
 * delivery failure: `resumeInterrupted` clears exactly this reason and leaves a
 * failure paused, since retrying an interruption is meaningless while retrying a
 * failure is the only way forward.
 */
export const INTERRUPTED_QUEUE_REASON = 'Interrupted before the turn ended.';

/** One queued message. `item` is the renderer's payload, stored verbatim. */
export interface ClientQueueRow {
  id: string;
  /** Non-null once delivery failed or the user interrupted the run. */
  pausedReason: string | null;
  createdAt: number;
  /** True between claiming the row and the engine admitting its turn. */
  dispatching?: boolean;
  item: JsonObject;
}

/**
 * The pause reason a row gets when the process died between claiming it and the
 * engine admitting its turn.
 *
 * The outcome is genuinely unknown: the turn may have started. Restoring the row
 * as ordinary pending would let startup dispatch it a second time, and dropping it
 * would silently lose what the user typed, so it comes back paused where the row's
 * own Retry is the user's decision rather than the host's guess.
 */
export const UNCONFIRMED_DELIVERY_REASON = 'Delivery was not confirmed before the application closed.';

export interface ClientQueueSnapshot {
  /** Bumped by every mutation so a renderer can drop a stale push. */
  revision: number;
  items: ClientQueueRow[];
}

const DDL = `CREATE TABLE IF NOT EXISTS follow_up_queue (
  session_id TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  position   INTEGER NOT NULL,
  item       TEXT NOT NULL,
  paused_reason TEXT,
  dispatching INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revision   INTEGER NOT NULL,
  PRIMARY KEY (session_id, item_id)
)`;

/** A table created before the dispatch marker existed gains the column. */
const MIGRATIONS = ['ALTER TABLE follow_up_queue ADD COLUMN dispatching INTEGER NOT NULL DEFAULT 0'];

const INDEX_DDL = 'CREATE TABLE IF NOT EXISTS follow_up_queue_revision (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)';

function ensure(db: DatabaseSync): void {
  db.exec(DDL);
  db.exec(INDEX_DDL);
  db.exec('CREATE TABLE IF NOT EXISTS follow_up_queue_removal_receipts (session_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, mutation_id))');
  db.exec('CREATE TABLE IF NOT EXISTS follow_up_queue_addition_receipts (session_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, mutation_id))');
  const columns = db.prepare('PRAGMA table_info(follow_up_queue)').all() as Array<Record<string, unknown>>;
  const present = new Set(columns.map(column => String(column.name)));
  for (const migration of MIGRATIONS) {
    const name = /ADD COLUMN (\w+)/.exec(migration)?.[1];
    if (name && !present.has(name)) db.exec(migration);
  }
}

function parseItem(raw: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function rowsIn(db: DatabaseSync, sessionId: string): ClientQueueRow[] {
  const found = db.prepare('SELECT item_id, item, paused_reason, dispatching, created_at FROM follow_up_queue WHERE session_id = ? ORDER BY position ASC, created_at ASC')
    .all(sessionId) as Array<Record<string, unknown>>;
  const rows: ClientQueueRow[] = [];
  for (const row of found) {
    const item = typeof row.item === 'string' ? parseItem(row.item) : undefined;
    const id = typeof row.item_id === 'string' ? row.item_id : '';
    // A row whose payload cannot be decoded is dropped rather than rendered as
    // an empty message: the user must not see a queue entry they cannot read,
    // edit or identify.
    if (!item || !id) continue;
    rows.push({
      id,
      item,
      pausedReason: typeof row.paused_reason === 'string' && row.paused_reason ? row.paused_reason : null,
      ...(row.dispatching ? { dispatching: true } : {}),
      createdAt: typeof row.created_at === 'number' && Number.isSafeInteger(row.created_at) ? row.created_at : 0,
    });
  }
  return rows;
}

function revisionIn(db: DatabaseSync, sessionId: string): number {
  const row = db.prepare('SELECT revision FROM follow_up_queue_revision WHERE session_id = ?').get(sessionId) as { revision?: unknown } | undefined;
  return typeof row?.revision === 'number' && Number.isSafeInteger(row.revision) ? row.revision : 0;
}

function nextRevision(db: DatabaseSync, sessionId: string): number {
  const revision = revisionIn(db, sessionId) + 1;
  db.prepare(`INSERT INTO follow_up_queue_revision (session_id, revision) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision`).run(sessionId, revision);
  return revision;
}

/**
 * Where a re-inserted row belongs, as its former neighbours.
 *
 * Both neighbours are recorded because either can vanish while the message is out
 * of the queue: the row that followed it may have been dispatched, and the row that
 * preceded it may have been deleted. Holding only one of the two means a legitimate
 * re-insertion silently degrades to "append at the end", which reorders everything
 * the user queued in between.
 */
export interface PositionAnchors {
  /** The row it used to follow; the row lands immediately after it. */
  afterId?: string | null;
  /** The row it used to precede; the row lands immediately before it. */
  beforeId?: string | null;
}

/**
 * Resolve anchors to an insertion index.
 *
 * The successor wins when both are present, because "before X" is the tighter
 * constraint: landing before X is what keeps the message ahead of the rows the user
 * queued after it. When the successor is gone the predecessor's slot (index + 1)
 * still puts the message back in roughly the right place instead of at the end, and
 * when both are gone appending is the only honest option.
 */
function insertionIndex(rows: ClientQueueRow[], position: PositionAnchors): number {
  const before = position.beforeId ? rows.findIndex(row => row.id === position.beforeId) : -1;
  if (before >= 0) return before;
  const after = position.afterId ? rows.findIndex(row => row.id === position.afterId) : -1;
  if (after >= 0) return after + 1;
  return rows.length;
}

/** Rewrite every row's position so the stored order is the authoritative one. */
function writeOrder(db: DatabaseSync, sessionId: string, rows: ClientQueueRow[], revision: number): void {
  db.prepare('DELETE FROM follow_up_queue WHERE session_id = ?').run(sessionId);
  const insert = db.prepare('INSERT INTO follow_up_queue (session_id, item_id, position, item, paused_reason, dispatching, created_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  rows.forEach((row, position) => {
    insert.run(sessionId, row.id, position, JSON.stringify(row.item), row.pausedReason, row.dispatching ? 1 : 0, row.createdAt, revision);
  });
}

function snapshotOf(db: DatabaseSync, sessionId: string): ClientQueueSnapshot {
  return { revision: revisionIn(db, sessionId), items: rowsIn(db, sessionId) };
}

/**
 * The queue's durable state plus the mutation surface both the IPC handlers and
 * the dispatcher use. Every mutator returns the post-operation snapshot, which
 * is what the renderer publishes — mirroring the engine queue's own contract of
 * answering a mutation with the authoritative result.
 */
export class QueueMutationError extends Error {
  readonly kind = 'server';
  constructor(readonly code: string, message: string) { super(message); this.name = 'QueueMutationError'; }
}

export interface QueueMutationReceipt { id: string; fingerprint: string }
export type QueueRemovalReceipt = QueueMutationReceipt;
const REMOVAL_RECEIPT_LIMIT = 512;
const REMOVAL_RECEIPT_BYTES = 16 * 1024 * 1024;
const REMOVAL_RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;
/** Keep enqueue admission independent of the row, which may dispatch before an ACK arrives. */
function replayAdditionReceipt(db: DatabaseSync, sessionId: string, receipt: QueueMutationReceipt): boolean {
  const saved = db.prepare('SELECT fingerprint FROM follow_up_queue_addition_receipts WHERE session_id=? AND mutation_id=?')
    .get(sessionId, receipt.id);
  if (!saved) return false;
  if (saved.fingerprint !== receipt.fingerprint) throw new QueueMutationError('mutation_identity_conflict', 'This queue addition identity belongs to another request');
  return true;
}

function saveAdditionReceipt(db: DatabaseSync, sessionId: string, receipt: QueueMutationReceipt): void {
  // Renderer recovery can replay an old issued request after its row has already
  // run. Retain that proof for the conversation's lifetime, until discard.
  db.prepare('INSERT INTO follow_up_queue_addition_receipts VALUES (?, ?, ?, ?)').run(sessionId, receipt.id, receipt.fingerprint, Date.now());
}
function decodeRemovalReceipt(raw: unknown): { removed?: ClientQueueRow } {
  const value = JSON.parse(String(raw)) as { removed?: ClientQueueRow };
  if (value.removed && (!value.removed.id || !value.removed.item || typeof value.removed.createdAt !== 'number')) throw new QueueMutationError('queue_receipt_unavailable', 'The saved queue removal receipt is invalid');
  return value;
}
function saveRemovalReceipt(db: DatabaseSync, sessionId: string, receipt: QueueRemovalReceipt, removed: ClientQueueRow | undefined): void {
  const result = JSON.stringify(removed ? { removed } : {}), bytes = Buffer.byteLength(result), now = Date.now();
  if (bytes > REMOVAL_RECEIPT_BYTES) throw new QueueMutationError('queue_receipt_full', 'This queue removal cannot be saved safely');
  db.prepare('DELETE FROM follow_up_queue_removal_receipts WHERE created_at < ?').run(now - REMOVAL_RECEIPT_TTL_MS);
  let records = db.prepare('SELECT session_id, mutation_id, length(CAST(result AS BLOB)) AS bytes FROM follow_up_queue_removal_receipts ORDER BY created_at, rowid').all();
  let total = records.reduce((sum, row) => sum + Number(row.bytes), 0);
  while (records.length >= REMOVAL_RECEIPT_LIMIT || total + bytes > REMOVAL_RECEIPT_BYTES) {
    const oldest = records.shift()!;
    db.prepare('DELETE FROM follow_up_queue_removal_receipts WHERE session_id=? AND mutation_id=?').run(String(oldest.session_id), String(oldest.mutation_id));
    total -= Number(oldest.bytes);
  }
  db.prepare('INSERT INTO follow_up_queue_removal_receipts VALUES (?, ?, ?, ?, ?)').run(sessionId, receipt.id, receipt.fingerprint, result, now);
}
function removedRowProof(db: DatabaseSync, sessionId: string, candidate: ClientQueueRow): ClientQueueRow {
  const receipts = db.prepare('SELECT result FROM follow_up_queue_removal_receipts WHERE session_id=? AND created_at>=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(sessionId, Date.now() - REMOVAL_RECEIPT_TTL_MS, REMOVAL_RECEIPT_LIMIT);
  for (const receipt of receipts) {
    const removed = decodeRemovalReceipt(receipt.result).removed;
    if (removed?.id === candidate.id && isDeepStrictEqual(rowToWire(removed), rowToWire(candidate))) return removed;
  }
  throw new QueueMutationError('queue_restore_unavailable', 'The unchanged removed row has no retained desktop receipt');
}

const MAX_QUEUE_ROWS = 128;
const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
function assertRevision(db: DatabaseSync, sessionId: string, expected?: number): void {
  if (expected !== undefined && snapshotOf(db, sessionId).revision !== expected) throw new QueueMutationError('queue_revision_changed', 'The follow-up queue changed; refresh it before editing');
}
function assertCapacity(rows: ClientQueueRow[], candidate: JsonObject): void {
  const bytes = Buffer.byteLength(JSON.stringify(candidate));
  if (bytes > 8 * 1024 * 1024 || rows.length >= MAX_QUEUE_ROWS || rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row.item)), bytes) > MAX_QUEUE_BYTES) {
    throw new Error('The follow-up queue is full');
  }
}

export interface LegacyQueueReceipt {
  kind: 'addition' | 'removal';
  mutationId: string;
  fingerprint: string;
  createdAt: number;
  result?: Json;
}
export interface LegacyQueueMigration extends ClientQueueSnapshot {
  receipts: LegacyQueueReceipt[];
  fingerprint: string;
}
function migrationIn(db: DatabaseSync, sessionId: string): LegacyQueueMigration {
  const raw = db.prepare('SELECT item_id,item,position,paused_reason,dispatching,created_at FROM follow_up_queue WHERE session_id=? ORDER BY position,created_at,item_id').all(sessionId);
  const items = raw.map(row => {
    const item = typeof row.item === 'string' ? parseItem(row.item) : undefined;
    if (!item || typeof row.item_id !== 'string' || !row.item_id || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.position)) {
      throw new QueueMutationError('queue_legacy_corrupt', 'A legacy queued message could not be migrated; its original data was preserved');
    }
    return { id: row.item_id, item, pausedReason: typeof row.paused_reason === 'string' ? row.paused_reason : null,
      createdAt: Number(row.created_at), ...(row.dispatching ? { dispatching: true } : {}) };
  });
  const snapshot = { revision: revisionIn(db, sessionId), items };
  const additions = db.prepare('SELECT mutation_id,fingerprint,created_at FROM follow_up_queue_addition_receipts WHERE session_id=? ORDER BY mutation_id').all(sessionId);
  const removals = db.prepare('SELECT mutation_id,fingerprint,result,created_at FROM follow_up_queue_removal_receipts WHERE session_id=? ORDER BY mutation_id').all(sessionId);
  const receipts: LegacyQueueReceipt[] = additions.map(row => ({ kind: 'addition', mutationId: String(row.mutation_id), fingerprint: String(row.fingerprint), createdAt: Number(row.created_at) }));
  for (const row of removals) {
    if (Number(row.created_at) < Date.now() - REMOVAL_RECEIPT_TTL_MS) continue;
    receipts.push({ kind: 'removal', mutationId: String(row.mutation_id), fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) as Json, createdAt: Number(row.created_at) });
  }
  // Compare raw storage, including expired proofs, so a TTL boundary during an
  // acknowledged import cannot manufacture a different source fingerprint.
  const fingerprint = createHash('sha256').update(JSON.stringify({ snapshot, raw, additions, removals })).digest('hex');
  return { ...snapshot, receipts, fingerprint };
}

export class ClientFollowUpQueue {
  constructor(private readonly configRoot: string) {}

  /** Capture rows and deduplication proofs together before importing engine authority. */
  exportMigration(sessionId: string): LegacyQueueMigration {
    return withSettingsTransaction(this.configRoot, db => { ensure(db); return migrationIn(db, sessionId); });
  }

  /** Clear the old authority only after a durable import of this exact snapshot. */
  acknowledgeMigration(sessionId: string, fingerprint: string): void {
    withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      if (migrationIn(db, sessionId).fingerprint !== fingerprint) throw new QueueMutationError('queue_revision_changed', 'The legacy queue changed while it was being imported');
      for (const table of ['follow_up_queue', 'follow_up_queue_revision', 'follow_up_queue_removal_receipts', 'follow_up_queue_addition_receipts']) {
        db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
      }
    });
  }

  snapshot(sessionId: string): ClientQueueSnapshot {
    if (!sessionId) return { revision: 0, items: [] };
    return withSettingsDb(this.configRoot, db => { ensure(db); return snapshotOf(db, sessionId); });
  }


  add(sessionId: string, id: string, item: JsonObject, position: PositionAnchors = {}, receipt?: QueueMutationReceipt): ClientQueueSnapshot {
    if (!sessionId || !id) throw new Error('A queued message needs a conversation and an identity');
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      if (receipt && replayAdditionReceipt(db, sessionId, receipt)) return snapshotOf(db, sessionId);
      const rows = rowsIn(db, sessionId);
      if (rows.some(row => row.id === id)) throw new Error('This queued message identity is already in the queue');
      assertCapacity(rows, item);
      rows.splice(insertionIndex(rows, position), 0, { id, item, pausedReason: null, createdAt: Date.now() });
      const revision = nextRevision(db, sessionId);
      if (receipt) saveAdditionReceipt(db, sessionId, receipt);
      writeOrder(db, sessionId, rows, revision);
      return { revision, items: rows };
    });
  }
  remove(sessionId: string, id: string, expectedRevision?: number, receipt?: QueueRemovalReceipt): { snapshot: ClientQueueSnapshot; removed: ClientQueueRow | undefined } {
    if (!sessionId || !id) throw new Error('A queued message needs a conversation and an identity');
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      if (receipt) {
        const saved = db.prepare('SELECT fingerprint, result FROM follow_up_queue_removal_receipts WHERE session_id=? AND mutation_id=? AND created_at>=?').get(sessionId, receipt.id, Date.now() - REMOVAL_RECEIPT_TTL_MS);
        if (saved) {
          if (saved.fingerprint !== receipt.fingerprint) throw new QueueMutationError('mutation_identity_conflict', 'This queue removal identity belongs to another request');
          return { snapshot: snapshotOf(db, sessionId), removed: decodeRemovalReceipt(saved.result).removed };
        }
      }
      const rows = rowsIn(db, sessionId);
      assertRevision(db, sessionId, expectedRevision);
      const index = rows.findIndex(row => row.id === id);
      if (index >= 0 && rows[index]!.dispatching) throw new QueueMutationError('queue_row_inflight', 'The queued message is already being delivered');
      if (index < 0 && expectedRevision !== undefined) throw new QueueMutationError('queue_row_unavailable', 'The queued message is no longer available to edit');
      const removed = index >= 0 ? rows[index] : undefined;
      if (index >= 0) rows.splice(index, 1);
      const revision = nextRevision(db, sessionId);
      if (receipt) saveRemovalReceipt(db, sessionId, receipt, removed);
      writeOrder(db, sessionId, rows, revision);
      // The removed row goes back to the caller so a delete can be undone
      // without the renderer having kept its own copy.
      return { snapshot: { revision, items: rows }, removed };
    });
  }

  /**
   * Re-insert a row previously returned by `remove`.
   *
   * Resolves its position from both former neighbours (see `insertionIndex`) so an
   * undone delete returns to where it was even if one of those neighbours has since
   * been dispatched or deleted. `atHead` overrides that and puts the row first,
   * which is what a delivery failure needs so the message is retried before anything
   * the user queued since.
   */
  restore(sessionId: string, row: ClientQueueRow, position: PositionAnchors = {}, atHead = false, expectedRevision?: number, requireRemovedReceipt = false): ClientQueueSnapshot {
    if (!sessionId || !row?.id) throw new Error('A restored queued message needs a conversation and an identity');
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      const rows = rowsIn(db, sessionId);
      assertRevision(db, sessionId, expectedRevision);
      if (rows.some(existing => existing.id === row.id)) throw new Error('This queued message is already back in the queue');
      const original = requireRemovedReceipt ? removedRowProof(db, sessionId, row) : row;
      if (original.dispatching) throw new Error('An in-flight queued message cannot be restored');
      assertCapacity(rows, original.item);
      rows.splice(atHead ? 0 : insertionIndex(rows, position), 0, original);
      const revision = nextRevision(db, sessionId);
      writeOrder(db, sessionId, rows, revision);
      return { revision, items: rows };
    });
  }

  /** Move `id` immediately before `beforeId`, or to the end when it is null. */
  reorder(sessionId: string, id: string, beforeId: string | null, expectedRevision?: number): ClientQueueSnapshot {
    if (!sessionId || !id) throw new Error('A queued message needs a conversation and an identity');
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      const rows = rowsIn(db, sessionId);
      assertRevision(db, sessionId, expectedRevision);
      if (rows.some(row => (row.id === id || row.id === beforeId) && row.dispatching)) throw new QueueMutationError('queue_row_inflight', 'The queued message is already being delivered');
      const from = rows.findIndex(row => row.id === id);
      if (from < 0) throw new Error('This queued message is no longer in the queue');
      const moved = rows.splice(from, 1)[0];
      if (!moved) throw new Error('This queued message is no longer in the queue');
      const to = beforeId ? rows.findIndex(row => row.id === beforeId) : -1;
      if (beforeId && to < 0) throw new Error('The reorder target is no longer in the queue');
      rows.splice(to >= 0 ? to : rows.length, 0, moved);
      const revision = nextRevision(db, sessionId);
      writeOrder(db, sessionId, rows, revision);
      return { revision, items: rows };
    });
  }


  /** Pause every unpaused row at once — what a user interruption does. */
  pauseAll(sessionId: string, reason: string): ClientQueueSnapshot {
    if (!sessionId) return { revision: 0, items: [] };
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      const rows = rowsIn(db, sessionId);
      const targets = rows.filter(row => !row.pausedReason && !row.dispatching);
      if (!targets.length) return snapshotOf(db, sessionId);
      for (const row of targets) {
        // An in-flight claim keeps its own outcome: pausing it here would hide a
        // delivery that may still be confirmed, and `commitClaim` or
        // `requeueFailed` will settle it.
        row.pausedReason = reason;
      }
      const revision = nextRevision(db, sessionId);
      writeOrder(db, sessionId, rows, revision);
      return { revision, items: rows };
    });
  }

  /** Clear every interruption mark, leaving genuine delivery failures paused. */
  resumeInterrupted(sessionId: string, reason: string, expectedRevision?: number): ClientQueueSnapshot {
    if (!sessionId) return { revision: 0, items: [] };
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      const rows = rowsIn(db, sessionId);
      assertRevision(db, sessionId, expectedRevision);
      if (!rows.some(row => row.pausedReason === reason)) return snapshotOf(db, sessionId);
      for (const row of rows) if (row.pausedReason === reason) row.pausedReason = null;
      const revision = nextRevision(db, sessionId);
      writeOrder(db, sessionId, rows, revision);
      return { revision, items: rows };
    });
  }
  /**
   * Atomically mark the first deliverable row as in-flight for one turn.
   *
   * The row STAYS in the queue with `dispatching` set, mirroring the engine
   * queue's own `reserved` state: a crash between claiming and admission leaves
   * evidence behind instead of silently losing what the user typed. Two
   * dispatchers cannot claim the same row, and `recoverDispatching` decides what
   * an abandoned claim becomes on the next start.
   */
  claimNext(sessionId: string): { row: ClientQueueRow | undefined; snapshot: ClientQueueSnapshot } {
    if (!sessionId) return { row: undefined, snapshot: { revision: 0, items: [] } };
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      const rows = rowsIn(db, sessionId);
      // The execution claim is conversation-wide: a second dispatcher must not
      // prepare a later row and win admission ahead of the first one.
      if (rows.some(candidate => candidate.dispatching)) return { row: undefined, snapshot: snapshotOf(db, sessionId) };
      const row = rows.find(candidate => !candidate.pausedReason && !candidate.dispatching);
      if (!row) return { row: undefined, snapshot: snapshotOf(db, sessionId) };
      row.dispatching = true;
      const revision = nextRevision(db, sessionId);
      writeOrder(db, sessionId, rows, revision);
      return { row, snapshot: { revision, items: rows } };
    });
  }

  /** A manual Steer/Retry claim keeps durable ownership until its admission settles. */
  claim(sessionId: string, id: string, expectedRevision?: number): { row: ClientQueueRow; snapshot: ClientQueueSnapshot } {
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db); assertRevision(db, sessionId, expectedRevision);
      const rows = rowsIn(db, sessionId), row = rows.find(candidate => candidate.id === id);
      if (!row) throw new QueueMutationError('queue_row_unavailable', 'The queued message is no longer available to deliver');
      if (row.dispatching) throw new QueueMutationError('queue_row_inflight', 'The queued message is already being delivered');
      if (rows.some(candidate => candidate.dispatching)) throw new QueueMutationError('queue_delivery_busy', 'Another queued message is being delivered for this conversation');
      row.dispatching = true;
      row.pausedReason = null;
      const revision = nextRevision(db, sessionId); writeOrder(db, sessionId, rows, revision);
      return { row, snapshot: { revision, items: rows } };
    });
  }
  /** Persist the steer correlation before issuing input, including a later uncertain ACK. */
  bindSteerClaim(sessionId: string, id: string, messageId: string): void {
    withSettingsTransaction(this.configRoot, db => {
      ensure(db); const rows = rowsIn(db, sessionId), row = rows.find(candidate => candidate.id === id);
      if (!row?.dispatching) throw new QueueMutationError('queue_row_unavailable', 'The queued message no longer owns this delivery');
      row.item = { ...row.item, followUpMessageId: messageId, followUpState: 'pending' };
      const revision = nextRevision(db, sessionId); writeOrder(db, sessionId, rows, revision);
    });
  }
  /** Save the new-turn correlation before input is issued so late admission can settle it. */
  bindTurnClaim(sessionId: string, id: string, submissionId: string): void {
    withSettingsTransaction(this.configRoot, db => {
      ensure(db); const rows = rowsIn(db, sessionId), row = rows.find(candidate => candidate.id === id);
      if (!row?.dispatching) throw new QueueMutationError('queue_row_unavailable', 'The queued message no longer owns this delivery');
      row.item = { ...row.item, queuedTurnSubmissionId: submissionId, followUpState: 'pending' };
      const revision = nextRevision(db, sessionId); writeOrder(db, sessionId, rows, revision);
    });
  }
  /** A late admission only settles an uncertain copy; an active dispatcher owns its own claim. */
  resolveTurnClaim(sessionId: string, submissionId: string): { row: ClientQueueRow; snapshot: ClientQueueSnapshot } | undefined {
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db); const rows = rowsIn(db, sessionId);
      const row = rows.find(candidate => candidate.item.queuedTurnSubmissionId === submissionId && !candidate.dispatching
        && (candidate.pausedReason === UNCONFIRMED_DELIVERY_REASON || candidate.item.followUpState === 'unconfirmed'));
      if (!row) return undefined;
      const kept = rows.filter(candidate => candidate !== row), revision = nextRevision(db, sessionId);
      writeOrder(db, sessionId, kept, revision);
      return { row, snapshot: { revision, items: kept } };
    });
  }
  retainUnconfirmed(sessionId: string, id: string): ClientQueueSnapshot {
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db); const rows = rowsIn(db, sessionId), row = rows.find(candidate => candidate.id === id);
      if (!row) return snapshotOf(db, sessionId);
      row.dispatching = false; row.pausedReason = UNCONFIRMED_DELIVERY_REASON;
      row.item = { ...row.item, followUpState: 'unconfirmed' };
      const revision = nextRevision(db, sessionId); writeOrder(db, sessionId, rows, revision);
      return { revision, items: rows };
    });
  }
  resolveSteer(sessionId: string, messageId: string): ClientQueueSnapshot | undefined {
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db); const rows = rowsIn(db, sessionId), found = rows.find(row => row.item.followUpMessageId === messageId);
      if (!found) return undefined;
      const kept = rows.filter(row => row !== found), revision = nextRevision(db, sessionId); writeOrder(db, sessionId, kept, revision);
      return { revision, items: kept };
    });
  }

  /** A new running turn won admission; this strict-queue claim waits for its terminal. */
  releaseClaim(sessionId: string, id: string): ClientQueueSnapshot {
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db); const rows = rowsIn(db, sessionId), row = rows.find(candidate => candidate.id === id);
      if (!row?.dispatching) return snapshotOf(db, sessionId);
      row.dispatching = false;
      const revision = nextRevision(db, sessionId); writeOrder(db, sessionId, rows, revision);
      return { revision, items: rows };
    });
  }

  /** Drop a claimed row once the engine admitted its turn. */
  commitClaim(sessionId: string, id: string): ClientQueueSnapshot {
    if (!sessionId || !id) throw new Error('A claimed queued message needs a conversation and an identity');
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      const rows = rowsIn(db, sessionId);
      const row = rows.find(candidate => candidate.id === id);
      // A row that is gone was already committed or removed by the user; neither
      // is an error the dispatcher has to react to.
      if (row && !row.dispatching) return snapshotOf(db, sessionId);
      const kept = rows.filter(candidate => candidate.id !== id);
      const revision = nextRevision(db, sessionId);
      writeOrder(db, sessionId, kept, revision);
      return { revision, items: kept };
    });
  }

  /** Release a claim without delivering it: the row returns to the head, paused. */
  requeueFailed(sessionId: string, id: string, reason: string): ClientQueueSnapshot {
    if (!sessionId || !id) throw new Error('A requeued message needs a conversation and an identity');
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      const rows = rowsIn(db, sessionId);
      const row = rows.find(candidate => candidate.id === id);
      if (!row) return snapshotOf(db, sessionId);
      row.dispatching = false;
      row.pausedReason = reason && reason.trim() ? reason : 'The queued message could not be sent';
      const revision = nextRevision(db, sessionId);
      writeOrder(db, sessionId, rows, revision);
      return { revision, items: rows };
    });
  }

  /**
   * Resolve claims a previous process never finished.
   *
   * Called once at startup before any dispatch. The row comes back paused with a
   * reason that says delivery is unknown rather than failed, because the turn may
   * in fact have started: re-dispatching it automatically could send the same
   * message twice, and dropping it would lose the user's words without telling
   * them. Retry stays the user's call.
   */
  recoverDispatching(reason: string = UNCONFIRMED_DELIVERY_REASON): Array<{ sessionId: string; snapshot: ClientQueueSnapshot }> {
    const recovered: Array<{ sessionId: string; snapshot: ClientQueueSnapshot }> = [];
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      const found = db.prepare('SELECT DISTINCT session_id FROM follow_up_queue WHERE dispatching <> 0').all() as Array<Record<string, unknown>>;
      for (const entry of found) {
        const sessionId = String(entry.session_id);
        if (!sessionId) continue;
        const rows = rowsIn(db, sessionId);
        for (const row of rows) {
          if (!row.dispatching) continue;
          row.dispatching = false;
          row.pausedReason ??= reason;
          row.item = { ...row.item, followUpState: 'unconfirmed' };
        }
        const revision = nextRevision(db, sessionId);
        writeOrder(db, sessionId, rows, revision);
        recovered.push({ sessionId, snapshot: { revision, items: rows } });
      }
      return recovered;
    });
  }

  /** Drop every row, returning them so their attachments can be released. */
  clear(sessionId: string, expectedRevision?: number): { snapshot: ClientQueueSnapshot; cleared: ClientQueueRow[] } {
    if (!sessionId) return { snapshot: { revision: 0, items: [] }, cleared: [] };
    return withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      assertRevision(db, sessionId, expectedRevision);
      const cleared = rowsIn(db, sessionId);
      if (cleared.some(row => row.dispatching)) throw new Error('Wait for the in-flight queued message before clearing the queue');
      const revision = nextRevision(db, sessionId);
      writeOrder(db, sessionId, [], revision);
      return { snapshot: { revision, items: [] }, cleared };
    });
  }

  /** Forget a closed or deleted conversation's queue. */
  discard(sessionId: string): void {
    if (!sessionId) return;
    withSettingsTransaction(this.configRoot, db => {
      ensure(db);
      db.prepare('DELETE FROM follow_up_queue WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM follow_up_queue_revision WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM follow_up_queue_removal_receipts WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM follow_up_queue_addition_receipts WHERE session_id = ?').run(sessionId);
    });
  }
}

/** The renderer-facing event shape, flat like `queue_snapshot`. */
export function clientQueueSnapshotEvent(sessionId: string, snapshot: ClientQueueSnapshot): JsonObject {
  return {
    type: 'client_queue_snapshot',
    sessionId,
    revision: snapshot.revision,
    // Carried rather than re-derived in the renderer: `INTERRUPTED_QUEUE_REASON`
    // is this module's business, and a renderer that compared against its own copy
    // of the string would silently stop showing the banner the day the wording
    // changed.
    interrupted: snapshot.items.some(row => row.pausedReason === INTERRUPTED_QUEUE_REASON),
    items: snapshot.items.map(row => rowToWire(row) as Json),
  };
}

/**
 * A snapshot as wire data.
 *
 * The stored interfaces are named types, and a named type is not assignable to
 * the renderer's recursive `Json` even when every field already is, so the
 * projection is spelled out rather than cast through `unknown`.
 */
export function snapshotToWire(snapshot: ClientQueueSnapshot): JsonObject {
  return {
    revision: snapshot.revision,
    interrupted: snapshot.items.some(row => row.pausedReason === INTERRUPTED_QUEUE_REASON),
    items: snapshot.items.map(row => rowToWire(row) as Json),
  };
}

export function rowToWire(row: ClientQueueRow): JsonObject {
  // A row paused by a user interruption is NOT a failed row: retrying an
  // interruption is meaningless, and the queue-level `interrupted` flag already
  // carries the banner. Keeping the reason string here too would force the
  // renderer to compare against its own copy of an internal constant.
  const failed = !!row.pausedReason && row.pausedReason !== INTERRUPTED_QUEUE_REASON;
  return {
    id: row.id,
    ...(failed ? { pausedReason: row.pausedReason } : {}),
    ...(row.dispatching ? { dispatching: true } : {}),
    ...(row.pausedReason === UNCONFIRMED_DELIVERY_REASON || row.item.followUpState === 'unconfirmed' ? { unconfirmed: true } : {}),
    createdAt: row.createdAt,
    item: row.item,
  };
}
