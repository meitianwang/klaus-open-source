import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Json } from '../main/ipc/contract';
import type { JsonObject } from '../main/services/service-types';
import { acceptedTurnInput } from './turn-input-fixture';

export interface EngineQueueRow extends JsonObject {
  id: string;
  input: Json[];
  clientUserMessageId: string;
  clientMetadata: Json;
  createdAt: number;
}
interface Receipt extends JsonObject {
  id: string;
  kind: string;
  queuedSubmission: EngineQueueRow | null;
  revision: number;
  fingerprint: Json;
}
export interface EngineQueueDocument {
  revision: number;
  rows: EngineQueueRow[];
  receipts: Map<string, Receipt>;
  legacyReceipts: Map<string, JsonObject>;
  migrations: Set<string>;
}
export type EngineQueueState = Map<string, EngineQueueDocument>;
const clone = <T>(value: T): T => structuredClone(value);
const fields = (value: Json): JsonObject => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected queue object');
  return value;
};
function invalid(message: string): never { throw Object.assign(new Error(message), { code: -32602 }); }
let nextIdentity = 0;

/**
 * A stateful implementation of the named queue facade for host-only fixtures.
 * Shared state survives replacement clients; no request is translated into a
 * legacy admission RPC, so tests must observe the actual queue protocol.
 */
export class FakeEngineQueue {
  readonly calls: Array<{ method: string; params: JsonObject }> = [];
  readonly admissions: Array<{ params: JsonObject; row: EngineQueueRow }> = [];
  readonly responses: Array<{ method: string; result: Json; bytes: number }> = [];
  readonly state: EngineQueueState;
  changed: (threadId: string, revision: number) => void = () => {};
  admit: (params: JsonObject, row: EngineQueueRow) => Promise<Json> = async params => acceptedTurnInput(params);
  beforeRequest?: (method: string, params: JsonObject) => Promise<void>;
  afterCommit?: (method: string, params: JsonObject, result: Json) => Promise<void>;
  beforeReserve?: (params: JsonObject, row: EngineQueueRow) => Promise<void>;
  pageSize?: number;
  constructor(state: EngineQueueState = new Map()) { this.state = state; }

  document(threadId: string): EngineQueueDocument {
    let document = this.state.get(threadId);
    if (!document) {
      document = { revision: 0, rows: [], receipts: new Map(), legacyReceipts: new Map(), migrations: new Set() };
      this.state.set(threadId, document);
    }
    return document;
  }
  /** Complete an engine reservation before emitting its correlated late event. */
  confirm(threadId: string, submissionId: string, status: 'started' | 'steered'): void {
    const document = this.document(threadId), index = document.rows.findIndex(row => fields(row.dispatching ?? {}).submissionId === submissionId);
    if (index < 0) return;
    const row = document.rows.splice(index, 1)[0]!;
    const receipt = this.receipt(document, row, status); receipt.submissionId = submissionId;
    this.bump(threadId, document);
  }
  private id(prefix: string): string { return `${prefix}-${++nextIdentity}`; }
  private touch(row: EngineQueueRow): void {
    row.inputFingerprint = 'sha256:' + createHash('sha256').update(JSON.stringify(row.input)).digest('hex');
    row.rowVersion = Number(row.rowVersion ?? 0) + 1;
  }
  private project(value: Json): Json {
    if (Array.isArray(value)) return value.map(entry => this.project(entry));
    if (value === null || typeof value !== 'object') return value;
    // Native rows and receipt rows use the same projection; opaque metadata is untouched.
    if (typeof value.id === 'string' && Array.isArray(value.input) && typeof value.createdAt === 'number') {
      const { input: _input, ...row } = value;
      return { ...clone(row), inputOmitted: true };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      key === 'clientMetadata' ? clone(entry) : this.project(entry)]));
  }
  private cas(document: EngineQueueDocument, expected: Json | undefined): void {
    if (expected !== undefined && expected !== document.revision) throw Object.assign(new Error('queue revision conflict'), {
      code: -32014, data: { expectedRevision: expected, revision: document.revision },
    });
  }
  private bump(threadId: string, document: EngineQueueDocument): number {
    document.revision++;
    this.changed(threadId, document.revision);
    return document.revision;
  }
  private index(document: EngineQueueDocument, id: Json | undefined): number {
    const index = document.rows.findIndex(row => row.id === id);
    if (index < 0) invalid(`unknown queued submission: ${id}`);
    return index;
  }
  private receipt(document: EngineQueueDocument, row: EngineQueueRow, kind: string, mutationId?: Json, fingerprint?: Json): Receipt {
    const receipt: Receipt = { id: this.id('receipt'), kind, queuedSubmission: clone(row), queuedSubmissionId: row.id,
      clientUserMessageId: row.clientUserMessageId, revision: document.revision + 1, fingerprint: fingerprint ?? null };
    document.receipts.set(`client:${row.clientUserMessageId}`, receipt);
    if (typeof mutationId === 'string') document.receipts.set(`mutation:${mutationId}`, receipt);
    return receipt;
  }

  async request(method: string, value: Json): Promise<Json> {
    if (!method.startsWith('thread/queue/')) invalid(`Unexpected queue method: ${method}`);
    const params = fields(value), threadId = String(params.threadId ?? '');
    if (!threadId) invalid('threadId is required');
    this.calls.push({ method, params: clone(params) });
    await this.beforeRequest?.(method, params);
    const document = this.document(threadId);
    let result: Json;
    switch (method) {
      case 'thread/queue/list': {
        const [revision, offset] = typeof params.cursor === 'string' ? params.cursor.split(':').map(Number) : [document.revision, 0];
        this.cas(document, revision!);
        const limit = Math.min(Number(params.limit ?? 100), this.pageSize ?? 1000), start = offset ?? 0;
        if (!Number.isInteger(start) || start < 0 || start > document.rows.length || limit < 1 || limit > 1000) invalid('invalid queue page');
        const end = Math.min(start + limit, document.rows.length);
        result = { data: clone(document.rows.slice(start, end)), nextCursor: end < document.rows.length ? `${document.revision}:${end}` : null, revision: document.revision };
        break;
      }
      case 'thread/queue/add': {
        const clientId = String(params.clientUserMessageId ?? '');
        if (!clientId) invalid('clientUserMessageId is required');
        if (params.lookupOnly === true) {
          const imported = document.legacyReceipts.get(String(params.mutationId));
          const prior = document.receipts.get(`mutation:${params.mutationId}`) ?? document.receipts.get(`client:${clientId}`);
          if (imported && (imported.kind !== 'addition' || imported.fingerprint !== params.mutationFingerprint)) invalid('mutation fingerprint does not match its imported receipt');
          if (prior && document.receipts.has(`mutation:${params.mutationId}`) && prior.fingerprint !== (params.mutationFingerprint ?? null)) invalid('mutation fingerprint does not match its receipt');
          result = imported ? { found: true, queuedSubmission: null, revision: document.revision, replayed: true, receipt: imported.result ?? null }
            : prior ? { found: true, queuedSubmission: clone(document.rows.find(row => row.id === prior.queuedSubmissionId) ?? prior.queuedSubmission), revision: document.revision, replayed: true, receipt: clone(prior) }
              : { found: false, queuedSubmission: null, revision: document.revision, replayed: false };
          break;
        }
        if (!Array.isArray(params.input)) invalid('input is required');
        if (params.restore && params.requireRemovedReceipt !== true) invalid('restore requires requireRemovedReceipt=true');
        const legacy = document.legacyReceipts.get(String(params.mutationId));
        if (legacy) {
          if (legacy.kind !== 'addition' || legacy.fingerprint !== params.mutationFingerprint) invalid('mutation fingerprint does not match its imported receipt');
          if (!params.restore) { result = { queuedSubmission: null, revision: document.revision, replayed: true, receipt: legacy.result ?? null }; break; }
        }
        const byMutation = document.receipts.get(`mutation:${params.mutationId}`);
        if (byMutation && byMutation.fingerprint !== (params.mutationFingerprint ?? null)) invalid('mutation fingerprint does not match its receipt');
        let prior = byMutation ?? document.receipts.get(`client:${clientId}`);
        if (!prior && params.restore) {
          const saved = [...document.legacyReceipts.values()].filter(receipt => receipt.kind === 'removal')
            .map(receipt => ({ receipt, removed: fields(fields(receipt.result ?? {}).removed ?? {}) }))
            .filter(proof => proof.removed.id === clientId).sort((a, b) => Number(b.receipt.createdAt) - Number(a.receipt.createdAt))[0];
          if (saved) {
            const removed = saved.removed;
            prior = { id: `legacy-${saved.receipt.mutationId}`, kind: 'deleted', fingerprint: null, revision: document.revision,
              queuedSubmission: { id: this.id('legacy-removed'), input: clone(params.input as Json[]), clientUserMessageId: clientId,
                clientMetadata: { item: removed.item!, legacyUnprepared: true }, createdAt: Number(removed.createdAt),
                ...(removed.pausedReason ? { pausedReason: removed.pausedReason } : {}), ...(removed.dispatching ? { dispatching: removed.dispatching } : {}) } };
          }
        }
        if (params.restore && prior && prior.kind !== 'deleted') invalid('restore requires a durable deletion receipt');
        if (prior && !params.restore) {
          result = { queuedSubmission: clone(document.rows.find(row => row.id === prior.queuedSubmissionId) ?? prior.queuedSubmission), revision: document.revision, replayed: true, receipt: clone(prior) }; break;
        }
        if ((params.restore || params.requireRemovedReceipt) && (!prior || prior.kind !== 'deleted')) invalid('restore requires a durable deletion receipt');
        if (params.restore) {
          const proof = prior!.queuedSubmission;
          if (!proof) invalid('restore requires a durable deletion receipt');
          if (proof.dispatching || !isDeepStrictEqual(fields(proof.clientMetadata).item, fields(params.clientMetadata ?? {}).item) || proof.createdAt !== params.createdAt
            || ((proof.pausedReason ?? null) !== (params.pausedReason ?? null)
              && !(params.pausedReason == null && proof.pausedReason === 'Interrupted before the turn ended.'))) invalid('removed payload does not match its durable receipt');
        }
        this.cas(document, params.expectedRevision);
        if (params.beforeId && params.afterId) invalid('choose beforeId or afterId');
        const index = params.beforeId ? this.index(document, params.beforeId) : params.afterId ? this.index(document, params.afterId) + 1 : document.rows.length;
        const row: EngineQueueRow = params.restore && prior?.queuedSubmission ? clone(prior.queuedSubmission) : { id: this.id('queued'), input: clone(params.input as Json[]), clientUserMessageId: clientId,
          clientMetadata: clone(params.clientMetadata ?? null), createdAt: Number(params.createdAt ?? Date.now()),
          ...(params.pausedReason ? { pausedReason: params.pausedReason } : {}) };
        this.touch(row);
        document.rows.splice(index, 0, row);
        const receipt = this.receipt(document, row, 'added', params.mutationId, params.mutationFingerprint);
        result = { queuedSubmission: clone(row), revision: this.bump(threadId, document), replayed: false, receipt };
        break;
      }
      case 'thread/queue/update': {
        this.cas(document, params.expectedRevision);
        const row = document.rows[this.index(document, params.queuedSubmissionId)]!;
        if (row.dispatching) invalid('admission is unconfirmed; explicitly retry or delete this entry');
        if (params.input) row.input = clone(params.input as Json[]);
        if (params.clientMetadata) row.clientMetadata = clone(params.clientMetadata);
        if (params.pausedReason) row.pausedReason = params.pausedReason;
        this.touch(row);
        result = { queuedSubmission: clone(row), revision: this.bump(threadId, document), replayed: false };
        break;
      }
      case 'thread/queue/delete': {
        const legacy = document.legacyReceipts.get(String(params.mutationId));
        if (legacy) {
          if (legacy.kind !== 'removal' || legacy.fingerprint !== params.mutationFingerprint) invalid('mutation fingerprint does not match its imported receipt');
          result = { deleted: true, revision: document.revision, replayed: true, receipt: legacy.result ?? null }; break;
        }
        const prior = document.receipts.get(`mutation:${params.mutationId}`);
        if (prior) {
          if (prior.kind !== 'deleted' || (prior.queuedSubmissionId !== params.queuedSubmissionId && prior.clientUserMessageId !== params.queuedSubmissionId)
            || prior.fingerprint !== (params.mutationFingerprint ?? null)) invalid('mutationId belongs to another mutation');
          result = { deleted: true, queuedSubmission: clone(prior.queuedSubmission), revision: document.revision, replayed: true, receipt: clone(prior) }; break;
        }
        this.cas(document, params.expectedRevision);
        const index = document.rows.findIndex(row => row.id === params.queuedSubmissionId);
        if (index < 0) { result = { deleted: false, revision: document.revision, replayed: false }; break; }
        const row = document.rows.splice(index, 1)[0]!, receipt = this.receipt(document, row, 'deleted', params.mutationId, params.mutationFingerprint);
        result = { deleted: true, queuedSubmission: clone(row), revision: this.bump(threadId, document), replayed: false, receipt };
        break;
      }
      case 'thread/queue/clear': {
        this.cas(document, params.expectedRevision);
        const cleared = clone(document.rows), ids = new Set(cleared.map(row => row.id));
        // Clear has no Undo proof; permanent addition identities remain replayable.
        for (const receipt of document.receipts.values()) if (typeof receipt.queuedSubmissionId === 'string' && ids.has(receipt.queuedSubmissionId)) receipt.queuedSubmission = null;
        for (const row of cleared) {
          document.receipts.set(`client:${row.clientUserMessageId}`, { id: this.id('cleared'), kind: 'cleared', queuedSubmission: null,
            queuedSubmissionId: row.id, clientUserMessageId: row.clientUserMessageId, revision: document.revision + 1, fingerprint: null });
        }
        document.rows = [];
        result = { cleared, revision: cleared.length ? this.bump(threadId, document) : document.revision };
        break;
      }
      case 'thread/queue/reorder': {
        this.cas(document, params.expectedRevision);
        const ids = params.queuedSubmissionIds;
        if (!Array.isArray(ids) || new Set(ids).size !== document.rows.length || ids.length !== document.rows.length
          || document.rows.some(row => !ids.includes(row.id))) invalid('reorder must contain every queued submission exactly once');
        const order = ids as string[];
        const changed = document.rows.some((row, index) => row.id !== order[index]);
        const positions = new Map(document.rows.map((row, index) => [row.id, index]));
        document.rows = order.map(id => document.rows.find(row => row.id === id)!);
        document.rows.forEach((row, index) => { if (positions.get(row.id) !== index) this.touch(row); });
        result = { revision: changed ? this.bump(threadId, document) : document.revision };
        break;
      }
      case 'thread/queue/pause':
      case 'thread/queue/resume': {
        this.cas(document, params.expectedRevision);
        const selected = params.queuedSubmissionIds;
        if (Array.isArray(selected)) for (const id of selected) this.index(document, id);
        let changed = false;
        for (const row of document.rows) {
          if (row.dispatching || Array.isArray(selected) && !selected.includes(row.id)) continue;
          if (method.endsWith('/pause')) {
            if (!params.reason) invalid('pause reason is required');
            if (row.pausedReason !== params.reason) { row.pausedReason = params.reason!; this.touch(row); changed = true; }
          } else if (row.pausedReason && (!params.reason || row.pausedReason === params.reason)) {
            delete row.pausedReason; this.touch(row); changed = true;
          }
        }
        result = { revision: changed ? this.bump(threadId, document) : document.revision };
        break;
      }
      case 'thread/queue/import': {
        const migrationId = String(params.migrationId ?? '');
        if (!migrationId || !Array.isArray(params.queuedSubmissions) || !Array.isArray(params.receipts)) invalid('invalid legacy import');
        if (document.migrations.has(migrationId)) { result = { revision: document.revision }; break; }
        for (const raw of params.queuedSubmissions as Json[]) {
          const imported = fields(raw), clientId = String(imported.clientUserMessageId);
          if (document.receipts.has(`client:${clientId}`)) continue;
          const unconfirmed = Boolean(imported.dispatching);
          const row: EngineQueueRow = { id: this.id('imported'), input: clone(imported.input as Json[]), clientUserMessageId: clientId,
            clientMetadata: clone(imported.clientMetadata ?? null), createdAt: Number(imported.createdAt ?? Date.now()),
            ...(unconfirmed ? { pausedReason: 'admission-unknown', dispatching: { submissionId: this.id('imported-submission'), mode: 'start-if-idle' } }
              : imported.pausedReason ? { pausedReason: imported.pausedReason } : {}) };
          this.touch(row);
          document.rows.push(row); this.receipt(document, row, 'added');
        }
        for (const raw of params.receipts as Json[]) {
          const receipt = fields(raw), key = String(receipt.mutationId), existing = document.legacyReceipts.get(key);
          if (!['addition', 'removal'].includes(String(receipt.kind)) || existing && (existing.kind !== receipt.kind || existing.fingerprint !== receipt.fingerprint)) invalid('conflicting imported mutation receipt');
          document.legacyReceipts.set(key, clone(receipt));
        }
        document.migrations.add(migrationId);
        document.revision = Math.max(document.revision, Number(params.minimumRevision));
        result = { revision: this.bump(threadId, document) };
        break;
      }
      case 'thread/queue/discard': {
        this.cas(document, params.expectedRevision);
        document.rows = []; document.receipts.clear(); document.legacyReceipts.clear(); document.migrations.clear();
        result = { revision: this.bump(threadId, document) };
        break;
      }
      case 'thread/queue/start': {
        this.cas(document, params.expectedRevision);
        const index = params.queuedSubmissionId ? this.index(document, params.queuedSubmissionId) : 0;
        const row = document.rows[index]; if (!row) invalid('thread queue is empty');
        await this.beforeReserve?.(params, row);
        const original = clone(row), submissionId = String(params.submissionId ?? this.id('queue-submission'));
        const mode = params.mode ?? 'start-if-idle';
        const refuse = (code: string): Json => ({ status: 'not-submitted', submissionId, reason: { code }, queuedSubmission: original, revision: document.revision });
        if (params.expectedInputFingerprint !== undefined && params.expectedInputFingerprint !== row.inputFingerprint
          || params.expectedRowVersion !== undefined && params.expectedRowVersion !== row.rowVersion) {
          result = refuse('queue-entry-changed'); break;
        }
        if (mode === 'start-or-steer') { result = refuse('invalid-input'); break; }
        if (row.dispatching && !params.retryUnconfirmed) { result = refuse('admission-unknown'); break; }
        if (!row.dispatching && row.pausedReason) { result = refuse('queue-paused'); break; }
        if (document.rows.some(candidate => candidate.id !== row.id && candidate.dispatching)) invalid('another queued admission is unconfirmed');
        row.dispatching = { submissionId, mode }; row.pausedReason = 'admission-unknown';
        this.touch(row);
        this.bump(threadId, document);
        // A thrown transport failure retains this durable reservation.
        this.admissions.push({ params: clone({ ...params, submissionId, mode }), row: clone(row) });
        const admission = fields(await this.admit({ ...params, submissionId, mode }, clone(row)));
        if (admission.status === 'started' || admission.status === 'steered') {
          document.rows.splice(this.index(document, row.id), 1);
          const receipt = this.receipt(document, original, String(admission.status));
          receipt.submissionId = submissionId; receipt.turnId = admission.turnId ?? null;
        } else {
          const restored = clone(original); delete restored.dispatching;
          if (original.dispatching) delete restored.pausedReason;
          const code = fields(admission.reason ?? {}).code;
          if (['invalid-input', 'empty-input', 'session-closing'].includes(String(code))) restored.pausedReason = code === 'session-closing' ? 'session-closing' : 'invalid-input';
          restored.rowVersion = row.rowVersion ?? 0;
          this.touch(restored);
          document.rows[this.index(document, row.id)] = restored;
        }
        result = { ...admission, submissionId, queuedSubmission: original, revision: this.bump(threadId, document) };
        break;
      }
      default: return invalid(`Unsupported named queue method: ${method}`);
    }
    if (params.includeInput === false && ['list', 'add', 'update', 'delete', 'start', 'clear'].some(name => method === `thread/queue/${name}`)) result = this.project(result);
    await this.afterCommit?.(method, params, result);
    const response = clone(result);
    this.responses.push({ method, result: response, bytes: Buffer.byteLength(JSON.stringify(response)) });
    return clone(response);
  }
}
