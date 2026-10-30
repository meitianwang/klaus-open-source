// Host cache for the COMPLETE saved transcript of a live session.
//
// The transcript source of truth is the engine's on-disk projection
// (`engine/readThreadHistory`): it keeps every turn a compaction retired, which the
// engine's in-memory `session/history` snapshot deliberately drops (the snapshot IS the
// model context). Reading the rollout on every renderer refresh would re-parse a
// multi-megabyte file per message, so the projected reply is cached here with an
// explicit invalidation discipline instead of a blind TTL:
//
//   - a projected engine chat event that proves the rollout moved (a settled message,
//     a compaction boundary, a terminal turn, a delivered notification) poisons the
//     entry until the next successful capture;
//   - a host mutation that rewrites the rollout (rewind, delete, close) poisons it too;
//   - a new engine generation poisons EVERY entry, because bindings are gone;
//   - a short time-to-live covers whatever no event announces (a writer flush that
//     lands between events).
//
// The lagging-flush guard is the correctness half: the rollout writer flushes
// asynchronously, so a read can return FEWER rows than an earlier read of the same
// session. Serving that shorter capture would make settled rows flicker out of the
// transcript, so a capture shorter than the one already served is neither served nor
// cached. Lightweight watermarks survive payload eviction until the live session closes.

import type { Json } from '../ipc/contract';

export interface ThreadHistoryCacheMetrics {
  rowCount: number;
  boundaryCount: number;
}

export interface ThreadHistoryCacheEntry extends ThreadHistoryCacheMetrics {
  reply: Record<string, Json>;
  capturedAt: number;
}

/** Projected chat event types that prove the saved rollout moved past a capture. */
export const INVALIDATING_EVENT_TYPES = new Set([
  'user_message',
  'message_complete',
  'tool_end',
  'compact_boundary',
  'compaction_start',
  'compaction_end',
  'compaction_error',
  'done',
  'interrupted',
  'agent_notification',
]);

const CACHE_TTL_MS = 30_000;

/** Row and boundary counts of a stored-history reply, for the lagging-flush guard. */
export function threadHistoryMetrics(reply: Record<string, Json>): ThreadHistoryCacheMetrics {
  const rows = Array.isArray(reply.history) ? reply.history : [];
  let boundaryCount = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const type = (row as Record<string, Json>).type;
    // The stored reply carries the RAW rollout message shape, where a compaction
    // marker is a `compact_boundary` message; the projected shape calls it `compaction`.
    if (type === 'compact_boundary' || (row as Record<string, Json>).kind === 'compaction') boundaryCount += 1;
  }
  return { rowCount: rows.length, boundaryCount };
}

export interface ThreadHistoryCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

interface CaptureState {
  watermark?: ThreadHistoryCacheMetrics;
  poisoned: boolean;
}

export interface ThreadHistoryCapture {
  current(): boolean;
}

/** Estimate retained object/string storage without allocating another serialized transcript. */
function retainedBytes(value: Json): number {
  const pending: Json[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (typeof item === 'string') bytes += 24 + item.length * 2;
    else if (item && typeof item === 'object') {
      if (seen.has(item)) continue;
      seen.add(item);
      bytes += 64;
      if (Array.isArray(item)) {
        bytes += item.length * 8;
        for (const child of item) pending.push(child);
      } else {
        for (const [key, child] of Object.entries(item)) {
          bytes += 24 + key.length * 2;
          pending.push(child);
        }
      }
    } else bytes += 8;
  }
  return bytes;
}

export class ThreadHistoryCache {
  private readonly entries = new Map<string, ThreadHistoryCacheEntry & { bytes: number }>();
  private readonly captures = new Map<string, CaptureState>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;
  private generation?: number;

  constructor(options: ThreadHistoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 6;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 0
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0) throw new Error('Invalid transcript cache budget');
  }

  /** A read admitted before close/rewind cannot republish into the next session lifetime. */
  capture(rendererId: string): ThreadHistoryCapture {
    let state = this.captures.get(rendererId);
    if (!state) { state = { poisoned: false }; this.captures.set(rendererId, state); }
    return { current: () => this.captures.get(rendererId) === state };
  }

  watermark(rendererId: string): ThreadHistoryCacheMetrics | undefined {
    return this.captures.get(rendererId)?.watermark;
  }

  usable(rendererId: string, now: number, minRows: number): ThreadHistoryCacheEntry | undefined {
    const entry = this.entries.get(rendererId);
    if (!entry) return undefined;
    if (now - entry.capturedAt > CACHE_TTL_MS) { this.dropPayload(rendererId); return undefined; }
    if (this.captures.get(rendererId)?.poisoned || entry.rowCount < minRows) return undefined;
    this.touch(rendererId, entry);
    return entry;
  }

  /** A retained payload may answer a lagging read even after an invalidating event. */
  peek(rendererId: string): ThreadHistoryCacheEntry | undefined {
    const entry = this.entries.get(rendererId);
    if (entry) this.touch(rendererId, entry);
    return entry;
  }

  store(rendererId: string, entry: ThreadHistoryCacheEntry, capture?: ThreadHistoryCapture): boolean {
    if (capture && !capture.current()) return false;
    this.capture(rendererId);
    const state = this.captures.get(rendererId)!;
    state.watermark = { rowCount: entry.rowCount, boundaryCount: entry.boundaryCount };
    state.poisoned = false;
    this.dropPayload(rendererId);
    for (const [id, cached] of this.entries) if (entry.capturedAt - cached.capturedAt > CACHE_TTL_MS) this.dropPayload(id);
    const bytes = retainedBytes(entry.reply);
    if (this.maxEntries === 0 || bytes > this.maxBytes) return true;
    this.entries.set(rendererId, { ...entry, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.dropPayload(this.entries.keys().next().value!);
    return true;
  }

  noteProjectedEvent(rendererId: string, type: string): boolean {
    if (!rendererId || !INVALIDATING_EVENT_TYPES.has(type)) return false;
    const state = this.captures.get(rendererId);
    if (state) state.poisoned = true;
    return true;
  }

  invalidateSession(rendererId: string): void {
    this.dropPayload(rendererId);
    this.captures.delete(rendererId);
  }

  invalidateGeneration(generation: number): void {
    if (this.generation === generation) return;
    this.generation = generation;
    this.entries.clear();
    this.captures.clear();
    this.bytes = 0;
  }

  diagnostics(): { entries: number; retainedBytes: number; watermarks: number } {
    return { entries: this.entries.size, retainedBytes: this.bytes, watermarks: this.captures.size };
  }

  private touch(rendererId: string, entry: ThreadHistoryCacheEntry & { bytes: number }): void {
    this.entries.delete(rendererId);
    this.entries.set(rendererId, entry);
  }

  private dropPayload(rendererId: string): void {
    const entry = this.entries.get(rendererId);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(rendererId);
  }
}
