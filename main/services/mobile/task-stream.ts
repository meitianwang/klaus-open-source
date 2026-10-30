import { randomUUID } from 'node:crypto';
import type { Json } from '../../ipc/contract';
import { object, string, type JsonObject } from '../service-types';

const TEXT_BATCH_MS = 16;
const OUTPUT_BATCH_MS = 50;
const TARGET_TEXT_CHARACTERS = 24;
const MAX_DRAIN_FRAMES = 8;
const MAX_OUTPUT_CHARACTERS = 20_000;
const OUTPUT_TRUNCATED_MARKER = '[output truncated]\n';
const MAX_REPLAY_PATCHES = 512;
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const MAX_REPLAY_AGE_MS = 5 * 60_000;
const MAX_IDLE_STREAMS = 10;
const IDLE_STREAM_TTL_MS = 3 * 60 * 60_000;

interface JournalEntry {
  frame: JsonObject;
  bytes: number;
  createdAt: number;
}

interface BufferedDelta {
  event: JsonObject;
  location: 'root' | 'event';
  field: string;
  delta: string;
}

interface DeltaBuffer {
  segments: BufferedDelta[];
  truncated?: boolean;
}

interface TaskStream {
  id: string;
  revision: number;
  entries: JournalEntry[];
  bytes: number;
  followers: number;
  touchedAt: number;
  textBuffers: Map<string, DeltaBuffer>;
  outputBuffers: Map<string, DeltaBuffer>;
  textTimer?: NodeJS.Timeout;
  outputTimer?: NodeJS.Timeout;
  drainFramesRemaining?: number;
  deferred: JsonObject[];
}

export interface TaskCursor {
  streamId: string;
  revision: number;
}

export interface TaskSnapshotCut {
  streamId: string;
  revision: number;
  liveEvents: JsonObject[];
}

export type TaskPatchEmitter = (sessionId: string, frame: JsonObject) => void;

const eventCharacters = (event: JsonObject): number => {
  const value = object(event.event);
  for (const key of ['text', 'thinking', 'output', 'delta']) {
    const text = typeof event[key] === 'string' ? event[key] : value[key];
    if (typeof text === 'string') return text.length;
  }
  return 0;
};

const deltaDescriptor = (event: JsonObject): (Omit<BufferedDelta, 'event'> & { kind: 'text' | 'output'; key: string }) | undefined => {
  const nested = object(event.event);
  const location = string(nested.type) ? 'event' : 'root';
  const row = location === 'event' ? nested : event;
  const type = string(row.type);
  const field = type === 'text_delta' ? 'text' : type === 'thinking_delta' ? 'thinking' : type === 'progress' ? 'content' : '';
  const delta = row[field];
  if (!field || typeof delta !== 'string') return;
  const key = [type, row.turnId, row.messageId, row.phase, row.toolCallId, row.id]
    .map(value => typeof value === 'string' ? value : '')
    .join(':');
  return { kind: type === 'progress' ? 'output' : 'text', key, location, field, delta };
};

const withDelta = (segment: BufferedDelta, delta: string): JsonObject => segment.location === 'event'
  ? { ...segment.event, event: { ...object(segment.event.event), [segment.field]: delta } }
  : { ...segment.event, [segment.field]: delta };

const bufferCharacters = (buffer: DeltaBuffer): number => buffer.segments.reduce((total, segment) => total + segment.delta.length, 0);

/**
 * Canonical per-task patch journal used by every phone follower. A revision is
 * allocated per committed batch, never per character. The bounded journal is
 * sufficient for ordinary reconnects; stale cursors are explicitly rejected
 * so callers recover with a new snapshot instead of accepting a silent gap.
 */
export class MobileTaskStreams {
  private readonly streams = new Map<string, TaskStream>();
  private maintenance?: NodeJS.Timeout;

  constructor(private readonly emit: TaskPatchEmitter, private readonly retained: (sessionId: string) => boolean = () => false, private readonly now: () => number = Date.now) {}

  follow(sessionId: string): void {
    this.pruneIdle();
    const stream = this.stream(sessionId); stream.followers++; stream.touchedAt = this.now();
  }

  unfollow(sessionId: string): void {
    const stream = this.streams.get(sessionId);
    if (!stream) return;
    stream.followers = Math.max(0, stream.followers - 1);
    if (stream.followers === 0) { stream.touchedAt = this.now(); this.flush(sessionId); }
    this.pruneIdle();
  }

  reset(): void {
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = undefined;
    for (const stream of this.streams.values()) {
      if (stream.textTimer) clearTimeout(stream.textTimer);
      if (stream.outputTimer) clearTimeout(stream.outputTimer);
    }
    this.streams.clear();
  }

  forget(sessionId: string): void {
    const stream = this.streams.get(sessionId);
    if (stream?.textTimer) clearTimeout(stream.textTimer);
    if (stream?.outputTimer) clearTimeout(stream.outputTimer);
    this.streams.delete(sessionId);
  }

  publish(sessionId: string, event: JsonObject): void {
    const stream = this.streams.get(sessionId);
    // Once a task has been followed, keep its bounded journal warm across a
    // temporary zero-follower disconnect. Otherwise a reconnect could present
    // a valid-looking cursor even though events emitted while the socket was
    // down were silently skipped.
    if (!stream) return;
    if (stream.deferred.length) { stream.deferred.push(event); return; }
    const descriptor = deltaDescriptor(event);
    if (descriptor?.kind === 'text') { this.enqueueText(stream, sessionId, event, descriptor); return; }
    if (descriptor?.kind === 'output') { this.enqueueOutput(stream, sessionId, event, descriptor); return; }
    this.flushOutput(stream, sessionId);
    if (stream.textBuffers.size) {
      stream.deferred.push(event);
      const buffered = [...stream.textBuffers.values()].reduce((total, buffer) => total + bufferCharacters(buffer), 0);
      if (buffered <= TARGET_TEXT_CHARACTERS) {
        this.flushTextNow(stream, sessionId);
        this.finishDrain(stream, sessionId);
      } else {
        stream.drainFramesRemaining = MAX_DRAIN_FRAMES;
        this.scheduleText(stream, sessionId);
      }
      return;
    }
    this.commit(stream, sessionId, [event]);
  }

  flush(sessionId: string): void {
    const stream = this.streams.get(sessionId);
    if (!stream) return;
    this.flushOutput(stream, sessionId);
    this.flushTextNow(stream, sessionId);
    stream.drainFramesRemaining = undefined;
    const deferred = stream.deferred.splice(0);
    if (deferred.length) this.commit(stream, sessionId, deferred);
  }

  current(sessionId: string): TaskCursor {
    this.flush(sessionId);
    const stream = this.stream(sessionId);
    return { streamId: stream.id, revision: stream.revision };
  }

  replay(sessionId: string, cursor: TaskCursor): JsonObject[] | undefined {
    this.pruneIdle();
    this.flush(sessionId);
    const stream = this.stream(sessionId);
    this.prune(stream);
    if (cursor.streamId !== stream.id || cursor.revision > stream.revision) return undefined;
    const availableFrom = stream.entries[0]
      ? Number(stream.entries[0].frame.baseRevision)
      : stream.revision;
    if (cursor.revision < availableFrom) return undefined;
    return stream.entries
      .filter(entry => Number(entry.frame.revision) > cursor.revision)
      .map(entry => entry.frame);
  }

  snapshotCut(
    sessionId: string,
    bufferedPatches: JsonObject[],
    sourceStreamId: string,
    sourceRevision: number,
  ): TaskSnapshotCut {
    this.flush(sessionId);
    const stream = this.stream(sessionId);
    const liveEvents: JsonObject[] = [];
    for (const frame of bufferedPatches) {
      if (typeof frame.revision !== 'number' || frame.revision > stream.revision || !Array.isArray(frame.patches)) continue;
      for (const value of frame.patches) {
        const patch = object(value);
        if (patch.op !== 'add' || patch.path !== '/events/-') continue;
        const event = object(patch.value);
        const source = object(event.event);
        const eventStreamId = string(source.sourceStreamId) || string(event.sourceStreamId);
        const eventRevision = source.sourceRevision ?? event.sourceRevision;
        const coveredByHistory = eventStreamId === sourceStreamId
          && typeof eventRevision === 'number'
          && Number.isSafeInteger(eventRevision)
          && eventRevision <= sourceRevision;
        if (!coveredByHistory) liveEvents.push(event);
      }
    }
    return { streamId: stream.id, revision: stream.revision, liveEvents };
  }

  gap(sessionId: string, cursor?: TaskCursor): JsonObject {
    this.flush(sessionId);
    const stream = this.stream(sessionId);
    const availableFromRevision = stream.entries[0]
      ? Number(stream.entries[0].frame.baseRevision)
      : stream.revision;
    return {
      type: 'task_gap',
      sessionId,
      streamId: stream.id,
      expectedRevision: cursor?.revision ?? 0,
      availableFromRevision,
      currentRevision: stream.revision,
    };
  }

  private stream(sessionId: string): TaskStream {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = {
        id: randomUUID(), revision: 0, entries: [], bytes: 0, followers: 0, touchedAt: this.now(),
        textBuffers: new Map(), outputBuffers: new Map(), deferred: [],
      };
      this.streams.set(sessionId, stream);
      this.maintenance ??= setInterval(() => this.pruneIdle(), 60_000);
      this.maintenance.unref();
    }
    return stream;
  }

  private pruneIdle(): void {
    const idle = [...this.streams].filter(([id, stream]) => !stream.followers && !this.retained(id))
      .sort((a, b) => b[1].touchedAt - a[1].touchedAt);
    for (const [index, [id, stream]] of idle.entries()) {
      if (index >= MAX_IDLE_STREAMS || this.now() - stream.touchedAt >= IDLE_STREAM_TTL_MS) this.forget(id);
      else this.prune(stream);
    }
    if (!this.streams.size && this.maintenance) { clearInterval(this.maintenance); this.maintenance = undefined; }
  }

  private enqueueText(
    stream: TaskStream,
    sessionId: string,
    event: JsonObject,
    descriptor: Omit<BufferedDelta, 'event'> & { key: string },
  ): void {
    const buffer = stream.textBuffers.get(descriptor.key) ?? { segments: [] };
    buffer.segments.push({ event, location: descriptor.location, field: descriptor.field, delta: descriptor.delta });
    stream.textBuffers.set(descriptor.key, buffer);
    this.scheduleText(stream, sessionId);
  }

  private enqueueOutput(
    stream: TaskStream,
    sessionId: string,
    event: JsonObject,
    descriptor: Omit<BufferedDelta, 'event'> & { key: string },
  ): void {
    const buffer = stream.outputBuffers.get(descriptor.key) ?? { segments: [] };
    buffer.segments.push({ event, location: descriptor.location, field: descriptor.field, delta: descriptor.delta });
    let excess = bufferCharacters(buffer) - MAX_OUTPUT_CHARACTERS;
    if (excess > 0) {
      buffer.truncated = true;
      while (excess > 0 && buffer.segments.length) {
        const first = buffer.segments[0]!;
        if (first.delta.length <= excess) { excess -= first.delta.length; buffer.segments.shift(); }
        else { first.delta = first.delta.slice(excess); excess = 0; }
      }
    }
    stream.outputBuffers.set(descriptor.key, buffer);
    stream.outputTimer ??= setTimeout(() => this.flushOutput(stream, sessionId), OUTPUT_BATCH_MS);
  }

  private scheduleText(stream: TaskStream, sessionId: string): void {
    stream.textTimer ??= setTimeout(() => this.flushTextFrame(stream, sessionId), TEXT_BATCH_MS);
  }

  private flushTextFrame(stream: TaskStream, sessionId: string): void {
    if (stream.textTimer) clearTimeout(stream.textTimer);
    stream.textTimer = undefined;
    const events: JsonObject[] = [];
    for (const [key, buffer] of stream.textBuffers) {
      const length = stream.drainFramesRemaining === undefined
        ? TARGET_TEXT_CHARACTERS
        : Math.max(TARGET_TEXT_CHARACTERS, Math.ceil(bufferCharacters(buffer) / stream.drainFramesRemaining));
      events.push(...this.takeText(buffer, length));
      if (!buffer.segments.length) stream.textBuffers.delete(key);
    }
    if (events.length) this.commit(stream, sessionId, events);
    if (stream.drainFramesRemaining !== undefined) stream.drainFramesRemaining--;
    if (stream.textBuffers.size) this.scheduleText(stream, sessionId);
    else this.finishDrain(stream, sessionId);
  }

  private flushTextNow(stream: TaskStream, sessionId: string): void {
    if (stream.textTimer) clearTimeout(stream.textTimer);
    stream.textTimer = undefined;
    const events = [...stream.textBuffers.values()].flatMap(buffer => this.takeText(buffer, Number.MAX_SAFE_INTEGER));
    stream.textBuffers.clear();
    if (events.length) this.commit(stream, sessionId, events);
  }

  private takeText(buffer: DeltaBuffer, requested: number): JsonObject[] {
    const events: JsonObject[] = [];
    let remaining = requested;
    while (buffer.segments.length && remaining > 0) {
      const segment = buffer.segments[0]!;
      if (!segment.delta.length) {
        events.push(withDelta(segment, '')); buffer.segments.shift(); continue;
      }
      const delta = segment.delta.slice(0, remaining);
      events.push(withDelta(segment, delta));
      segment.delta = segment.delta.slice(delta.length);
      remaining -= delta.length;
      if (!segment.delta.length) buffer.segments.shift();
    }
    return events;
  }

  private flushOutput(stream: TaskStream, sessionId: string): void {
    if (stream.outputTimer) clearTimeout(stream.outputTimer);
    stream.outputTimer = undefined;
    const events: JsonObject[] = [];
    for (const buffer of stream.outputBuffers.values()) {
      if (buffer.truncated && buffer.segments.length) {
        const last = buffer.segments.at(-1)!;
        events.push(withDelta(last, OUTPUT_TRUNCATED_MARKER + buffer.segments.map(segment => segment.delta).join('')));
      } else {
        events.push(...buffer.segments.map(segment => withDelta(segment, segment.delta)));
      }
    }
    stream.outputBuffers.clear();
    if (events.length) this.commit(stream, sessionId, events);
  }

  private finishDrain(stream: TaskStream, sessionId: string): void {
    if (stream.textBuffers.size) return;
    stream.drainFramesRemaining = undefined;
    const deferred = stream.deferred.splice(0);
    for (const event of deferred) this.publish(sessionId, event);
  }

  private commit(stream: TaskStream, sessionId: string, events: JsonObject[]): void {
    const baseRevision = stream.revision;
    const revision = baseRevision + 1;
    const patches = events.map(event => ({ op: 'add', path: '/events/-', value: event }));
    const acceptedTextChanges = events.reduce((count, event) => count + eventCharacters(event), 0);
    const frame: JsonObject = {
      type: 'task_patch',
      sessionId,
      streamId: stream.id,
      baseRevision,
      revision,
      patches,
      acceptedTextChanges,
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    const entry = { frame, bytes, createdAt: this.now() };
    stream.revision = revision;
    stream.touchedAt = this.now();
    stream.entries.push(entry);
    stream.bytes += bytes;
    this.prune(stream);
    this.emit(sessionId, frame);
  }

  private prune(stream: TaskStream): void {
    const expiredBefore = this.now() - MAX_REPLAY_AGE_MS;
    while (stream.entries.length && (
      stream.entries.length > MAX_REPLAY_PATCHES
      || stream.bytes > MAX_REPLAY_BYTES
      || stream.entries[0]!.createdAt < expiredBefore
    )) {
      stream.bytes -= stream.entries.shift()!.bytes;
    }
  }
}

export function taskCursor(value: Json | undefined): TaskCursor | undefined {
  const row = object(value);
  const streamId = string(row.streamId);
  const revision = row.revision;
  return streamId && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? { streamId, revision }
    : undefined;
}
