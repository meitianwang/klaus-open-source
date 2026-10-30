import { performance } from 'node:perf_hooks';
import type { JsonObject } from '../service-types';

export type DiagnosticOperation = 'catalog' | 'follow';
export type DiagnosticMessage = 'request' | 'catalog_page' | 'task_history' | 'task_snapshot' | 'task_follow_ready' | 'error';
export type DiagnosticLayer = 'localService' | 'outerRelay';
export type DiagnosticClockOrigin = 'request_received' | 'first_response_observed';
export interface DiagnosticMetadata extends JsonObject {
  diagnosticTraceId: string;
  diagnosticOperation: DiagnosticOperation;
  diagnosticMessage: DiagnosticMessage;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const messages = new Set<DiagnosticMessage>(['request', 'catalog_page', 'task_history', 'task_snapshot', 'task_follow_ready', 'error']);
export const MOBILE_DIAGNOSTIC_PHASES = [
  'request_received', 'admission_started', 'owner_acquire_started', 'owner_acquire_complete', 'request_admitted',
  'hydration_queued', 'hydration_started', 'history_prepared', 'snapshot_prepared', 'catalog_page_prepared',
  'send_queued', 'write_started', 'write_complete', 'request_complete', 'failed', 'cancelled', 'disconnected',
  'bridge_request_received', 'bridge_local_queued', 'bridge_local_write_started', 'bridge_local_write_complete',
  'bridge_response_received', 'bridge_flow_paused', 'bridge_flow_resumed', 'bridge_relay_write_started',
  'bridge_relay_write_complete', 'bridge_transfer_complete', 'collection_closed', 'trace_expired', 'trace_evicted',
] as const;
const phases = new Set<string>(MOBILE_DIAGNOSTIC_PHASES);
const errors = new Set(['timeout', 'cancelled', 'disconnected', 'rejected', 'parse_failed', 'send_failed', 'limit']);
const TTL_MS = 600_000;
const WINDOW_MS = 60_000;
const MAX_TRACES = 64;
const MAX_RECORDS = 1_024;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_DROPS = 1_000_000;

/** Only random correlation metadata crosses into diagnostic records. */
export function diagnosticMetadata(value: unknown): DiagnosticMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (typeof row.diagnosticTraceId !== 'string' || !UUID.test(row.diagnosticTraceId)
    || row.diagnosticOperation !== 'catalog' && row.diagnosticOperation !== 'follow') return;
  const kind = row.diagnosticMessage ?? (row.type === 'catalog_sync' || row.type === 'follow_task' ? 'request' : row.type);
  if (!messages.has(kind as DiagnosticMessage) || kind !== 'request' &&
    (row.diagnosticOperation === 'catalog' && kind !== 'catalog_page' && kind !== 'error'
      || row.diagnosticOperation === 'follow' && kind === 'catalog_page')) return;
  return { diagnosticTraceId: row.diagnosticTraceId.toLowerCase(), diagnosticOperation: row.diagnosticOperation as DiagnosticOperation,
    diagnosticMessage: kind as DiagnosticMessage };
}

export function diagnosticRequest(value: unknown): DiagnosticMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (row.type === 'client_message') return diagnosticRequest(row.message);
  const metadata = diagnosticMetadata(row);
  if (!metadata || metadata.diagnosticMessage !== 'request'
    || (row.type === 'catalog_sync' ? 'catalog' : row.type === 'follow_task' ? 'follow' : undefined) !== metadata.diagnosticOperation) return;
  return metadata;
}

/** Bridge inspection is bounded and never returns application content. */
export function diagnosticFrame(text: string, request = false): { metadata: DiagnosticMetadata; fields: JsonObject; last: boolean } | undefined {
  if (text.length > 160 * 1024 || !text.includes('"diagnosticTraceId"')) return;
  let value: unknown; try { value = JSON.parse(text); } catch { return; }
  const metadata = request ? diagnosticRequest(value) : diagnosticMetadata(value);
  if (!metadata) return;
  const row = value as Record<string, unknown>, fields: JsonObject = {};
  if (typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq >= 0) fields.sequence = row.seq;
  if (row.type === 'server_message_chunk' || row.type === 'client_message_chunk') {
    if (typeof row.index !== 'number' || typeof row.count !== 'number' || !Number.isSafeInteger(row.index)
      || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 512 || row.index < 0 || row.index >= row.count) return;
    fields.index = row.index; fields.chunkCount = row.count;
  }
  return { metadata, fields, last: fields.index === undefined || fields.index === Number(fields.chunkCount) - 1 };
}

export function diagnosticResponse(value: JsonObject, metadata?: DiagnosticMetadata): JsonObject {
  if (!metadata || !messages.has(value.type as DiagnosticMessage)) return value;
  return { ...value, ...metadata, diagnosticMessage: value.type as DiagnosticMessage };
}

interface Trace {
  started: number; touched: number; records: number; complete: boolean; operation: DiagnosticOperation; wireBytes: number;
  clockOrigin: DiagnosticClockOrigin; pauseStarted?: number; counterLimited?: boolean;
}
export interface MobileDiagnosticOptions { layer?: DiagnosticLayer; enabled?: () => boolean }

/** Diagnostics are opt-in, bounded, and never part of transport admission. */
export class MobileLoadDiagnostics {
  private readonly traces = new Map<string, Trace>();
  private windowStart = 0;
  private records = 0;
  private droppedRecords = 0;
  private droppedTraces = 0;
  constructor(private readonly emit: (event: JsonObject) => void, private readonly now = () => performance.now(),
    private readonly options: MobileDiagnosticOptions = {}) {}

  enabled(): boolean {
    let enabled = false;
    try { enabled = this.options.enabled?.() ?? true; } catch { /* Unavailable diagnostics cannot block remote access. */ }
    if (!enabled) this.reset();
    return enabled;
  }

  reset(): void { this.traces.clear(); this.records = 0; this.droppedRecords = 0; this.droppedTraces = 0; this.windowStart = 0; }

  begin(value: unknown, observedAt?: number): DiagnosticMetadata | undefined {
    const metadata = diagnosticRequest(value);
    if (!metadata) return;
    if (!this.enabled()) return metadata;
    this.start(metadata, 'request_received', observedAt);
    return metadata;
  }

  observeResponse(metadata: DiagnosticMetadata | undefined, observedAt?: number): void {
    if (!metadata || metadata.diagnosticMessage === 'request' || !this.enabled()) return;
    this.start(metadata, 'first_response_observed', observedAt);
  }

  private time(): number | undefined {
    try { const now = this.now(); return Number.isFinite(now) ? now : undefined; } catch { return; }
  }

  private start(metadata: DiagnosticMetadata, clockOrigin: DiagnosticClockOrigin, observedAt?: number): void {
    const now = this.time(); if (now === undefined) return;
    this.prune(now);
    if (this.traces.has(metadata.diagnosticTraceId)) return;
    if (this.traces.size >= MAX_TRACES) {
      const oldest = [...this.traces].sort((a, b) => Number(a[1].complete) === Number(b[1].complete)
        ? a[1].touched - b[1].touched : Number(b[1].complete) - Number(a[1].complete))[0];
      if (oldest) {
        if (!oldest[1].complete) this.record(this.metadata(oldest[0], oldest[1]), 'trace_evicted');
        this.traces.delete(oldest[0]);
        if (!oldest[1].complete) this.droppedTraces = Math.min(MAX_DROPS, this.droppedTraces + 1);
      }
    }
    const started = typeof observedAt === 'number' && Number.isFinite(observedAt) && observedAt >= 0 && observedAt <= now
      && now - observedAt < TTL_MS ? observedAt : now;
    this.traces.set(metadata.diagnosticTraceId, { started, touched: now, records: 0, complete: false,
      operation: metadata.diagnosticOperation, wireBytes: 0, clockOrigin });
    if (clockOrigin === 'request_received') this.record(metadata, this.options.layer === 'outerRelay' ? 'bridge_request_received' : 'request_received', {}, started);
  }

  record(metadata: DiagnosticMetadata | undefined, phase: string, fields: Record<string, unknown> = {}, observedAt?: number): void {
    if (!metadata || !phases.has(phase) || !this.enabled()) return;
    const now = this.time(); if (now === undefined) return;
    this.prune(now);
    const trace = this.traces.get(metadata.diagnosticTraceId);
    if (!trace || trace.complete || trace.operation !== metadata.diagnosticOperation) return;
    const outer = this.options.layer === 'outerRelay';
    if (phase.startsWith('bridge_') && !outer || phase === 'collection_closed' && !outer
      || outer && !phase.startsWith('bridge_') && !['failed', 'cancelled', 'collection_closed', 'trace_expired', 'trace_evicted'].includes(phase)) return;
    const terminal = ['request_complete', 'bridge_transfer_complete', 'failed', 'cancelled', 'disconnected', 'collection_closed', 'trace_evicted', 'trace_expired'].includes(phase);
    if (trace.records >= (terminal ? 64 : 62) || this.records >= (terminal ? MAX_RECORDS : MAX_RECORDS - 4)) {
      this.droppedRecords = Math.min(MAX_DROPS, this.droppedRecords + 1); return;
    }
    trace.touched = now;
    const observed = typeof observedAt === 'number' && Number.isFinite(observedAt) && observedAt >= trace.started && observedAt <= now ? observedAt : now;
    const event: JsonObject = { schemaVersion: 1, side: 'desktop', layer: this.options.layer ?? 'localService',
      clockOrigin: trace.clockOrigin, traceId: metadata.diagnosticTraceId, operation: trace.operation,
      phase, elapsedMs: Math.round(Math.min(TTL_MS, Math.max(0, observed - trace.started)) * 100) / 100, messageKind: metadata.diagnosticMessage };
    for (const field of ['bytes', 'wireBytes', 'logicalBytes', 'queueBytes', 'bufferedBytes', 'count', 'sequence', 'index', 'chunkCount']) {
      const value = fields[field], maximum = field === 'sequence' ? Number.MAX_SAFE_INTEGER : MAX_BYTES;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum) event[field] = value;
    }
    if (trace.counterLimited) { delete event.wireBytes; event.counterLimited = true; }
    const duration = fields.durationMs;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= TTL_MS) event.durationMs = Math.round(duration * 100) / 100;
    if (typeof fields.errorCode === 'string' && errors.has(fields.errorCode)) event.errorCode = fields.errorCode;
    if (this.droppedRecords) event.droppedRecords = this.droppedRecords;
    if (this.droppedTraces) event.droppedTraces = this.droppedTraces;
    trace.records++; this.records++;
    try { this.emit(event); } catch { /* A logging failure cannot affect remote access. */ }
  }

  wrote(metadata: DiagnosticMetadata | undefined, bytes: number): number | undefined {
    if (!metadata || !this.enabled() || !Number.isSafeInteger(bytes) || bytes < 0) return;
    const trace = this.traces.get(metadata.diagnosticTraceId);
    if (!trace || trace.complete || trace.operation !== metadata.diagnosticOperation) return;
    if (trace.counterLimited || trace.wireBytes + bytes > MAX_BYTES) { trace.counterLimited = true; return; }
    trace.wireBytes += bytes;
    return trace.wireBytes;
  }

  flow(paused: boolean): void {
    if (!this.enabled()) return;
    const now = this.time(); if (now === undefined) return;
    this.prune(now);
    for (const [id, trace] of this.traces) {
      if (trace.complete) continue;
      if (paused && trace.pauseStarted === undefined) {
        trace.pauseStarted = now; this.record(this.metadata(id, trace), 'bridge_flow_paused');
      } else if (!paused && trace.pauseStarted !== undefined) {
        const durationMs = Math.max(0, now - trace.pauseStarted); trace.pauseStarted = undefined;
        this.record(this.metadata(id, trace), 'bridge_flow_resumed', { durationMs });
      }
    }
  }

  finish(metadata: DiagnosticMetadata | undefined, errorCode?: string): void {
    if (!metadata || !this.enabled()) return;
    const trace = this.traces.get(metadata.diagnosticTraceId); if (!trace || trace.complete) return;
    this.record(metadata, errorCode === 'cancelled' ? 'cancelled' : errorCode ? 'failed'
      : this.options.layer === 'outerRelay' ? 'bridge_transfer_complete' : 'request_complete', { errorCode });
    trace.complete = true;
  }

  close(): void {
    if (this.enabled()) for (const [id, trace] of this.traces) if (!trace.complete) {
      this.record(this.metadata(id, trace), this.options.layer === 'outerRelay' ? 'collection_closed' : 'disconnected',
        this.options.layer === 'outerRelay' ? {} : { errorCode: 'disconnected' });
    }
    this.reset();
  }

  private metadata(id: string, trace: Trace): DiagnosticMetadata {
    return { diagnosticTraceId: id, diagnosticOperation: trace.operation, diagnosticMessage: 'request' };
  }

  private prune(now: number): void {
    if (!this.windowStart || now - this.windowStart >= WINDOW_MS) { this.windowStart = now || Number.EPSILON; this.records = 0; this.droppedRecords = 0; this.droppedTraces = 0; }
    for (const [id, trace] of this.traces) if (now - trace.touched >= TTL_MS) {
      // Expiry ends collection, not the underlying loading request.
      this.traces.delete(id);
      if (!trace.complete) this.droppedTraces = Math.min(MAX_DROPS, this.droppedTraces + 1);
    }
  }
}
