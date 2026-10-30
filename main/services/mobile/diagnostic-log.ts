import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { JsonObject } from '../service-types';
import { diagnosticMetadata, MOBILE_DIAGNOSTIC_PHASES } from './load-diagnostics';

const phases = new Set<string>(MOBILE_DIAGNOSTIC_PHASES);
const errors = new Set(['timeout', 'cancelled', 'disconnected', 'rejected', 'parse_failed', 'send_failed', 'limit']);
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Revalidate the sink boundary so unrelated host fields cannot enter the loading log. */
function record(value: JsonObject): JsonObject | undefined {
  const metadata = diagnosticMetadata({ diagnosticTraceId: value.traceId, diagnosticOperation: value.operation, diagnosticMessage: value.messageKind });
  if (!metadata || value.schemaVersion !== 1 || value.side !== 'desktop' || typeof value.phase !== 'string' || !phases.has(value.phase)
    || value.layer !== 'localService' && value.layer !== 'outerRelay'
    || value.clockOrigin !== 'request_received' && value.clockOrigin !== 'first_response_observed'
    || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 600_000) return;
  const row: JsonObject = { schemaVersion: 1, side: 'desktop', layer: value.layer, clockOrigin: value.clockOrigin,
    traceId: metadata.diagnosticTraceId, operation: metadata.diagnosticOperation, messageKind: metadata.diagnosticMessage,
    phase: value.phase, elapsedMs: value.elapsedMs };
  if (value.layer === 'localService' && (value.phase.startsWith('bridge_') || value.phase === 'collection_closed' || value.clockOrigin !== 'request_received')
    || value.layer === 'outerRelay' && !value.phase.startsWith('bridge_') && !['failed', 'cancelled', 'collection_closed', 'trace_expired', 'trace_evicted'].includes(value.phase)) return;
  for (const name of ['bytes', 'wireBytes', 'logicalBytes', 'queueBytes', 'bufferedBytes', 'count', 'sequence', 'index', 'chunkCount', 'droppedRecords', 'droppedTraces']) {
    const number = value[name], maximum = name === 'sequence' ? Number.MAX_SAFE_INTEGER : 512 * 1024 * 1024;
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 && number <= maximum) row[name] = number;
  }
  if (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 600_000) row.durationMs = value.durationMs;
  if (typeof value.errorCode === 'string' && errors.has(value.errorCode)) row.errorCode = value.errorCode;
  if (value.counterLimited === true) row.counterLimited = true;
  return row;
}

/** Two bounded private files; writing and rotation never join the transport's await chain. */
export class MobileDiagnosticLog {
  readonly path: string;
  private readonly directory: string;
  private tail = Promise.resolve();
  private pendingBytes = 0;
  private dropped = 0;
  private generation = 0;
  private closed = false;
  constructor(private readonly root: string, private readonly enabled: () => boolean, private readonly maximumFileBytes = MAX_FILE_BYTES) {
    this.directory = join(root, 'logs'); this.path = join(this.directory, 'mobile-loading-diagnostics.jsonl');
  }
  reset(): void { this.generation++; this.dropped = 0; }
  write(value: JsonObject): void {
    let active = false;
    try { active = this.enabled(); } catch { return; }
    if (this.closed || !active) return;
    const normalized = record(value); if (!normalized) return;
    if (this.dropped) normalized.sinkDroppedRecords = this.dropped;
    const text = JSON.stringify({ at: new Date().toISOString(), record: normalized }) + '\n', bytes = Buffer.byteLength(text);
    if (bytes > this.maximumFileBytes || this.pendingBytes + bytes > MAX_PENDING_BYTES) { this.dropped = Math.min(1_000_000, this.dropped + 1); return; }
    const generation = this.generation;
    this.pendingBytes += bytes;
    this.tail = this.tail.then(async () => {
      if (generation !== this.generation || !this.enabled()) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await lstat(this.directory)).isSymbolicLink() || dirname(await realpath(this.directory)) !== await realpath(this.root)) throw new Error('Invalid diagnostic directory');
      const current = await this.entry(this.path);
      if (current && current.size + bytes > this.maximumFileBytes) {
        const previous = this.path + '.previous';
        if (await this.entry(previous)) await unlink(previous);
        await rename(this.path, previous);
      }
      const file = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await file.writeFile(text); await file.chmod(0o600); }
      finally { await file.close(); }
    }).catch(() => { this.dropped = Math.min(1_000_000, this.dropped + 1); })
      .finally(() => { this.pendingBytes -= bytes; });
  }
  private async entry(path: string): Promise<Stats | undefined> {
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1
        || typeof process.getuid === 'function' && entry.uid !== process.getuid()) throw new Error('Invalid diagnostic file');
      return entry;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  async close(): Promise<void> { this.closed = true; await this.tail; }
}

/** Cache engine-owned preferences without allowing stale reads to re-enable capture. */
export class MobileDiagnosticsSwitch {
  private value = false;
  private revision = 0;
  constructor(private readonly read: () => Promise<unknown>, private readonly changed: () => void) {}
  enabled = (): boolean => this.value;
  async refresh(): Promise<void> {
    const revision = ++this.revision;
    let raw: unknown;
    try { raw = await this.read(); } catch { raw = false; }
    if (revision !== this.revision) return;
    const next = raw === true || raw === 'on' || raw === 'true' || raw === '1';
    if (next !== this.value) { this.value = next; this.changed(); }
  }
  close(): void { this.revision++; this.value = false; this.changed(); }
}
