import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import WebSocket, { type RawData } from 'ws';
import type { Json } from '../../ipc/contract';
import { object, SerialMutations, type JsonObject } from '../service-types';
import { MOBILE_BODY_LIMIT, MobileError } from './protocol';
import { diagnosticMetadata } from './load-diagnostics';
import {
  CLIENT_CURSOR_TTL_MS, MAX_RELIABLE_BYTES, MAX_RELIABLE_CLIENTS, MAX_RELIABLE_MESSAGES, RELIABLE_TTL_MS,
  type JournalReply, type JournalRequest, type ReliableDeliveryState, type ReliableMessage, type StoredDelivery,
} from './transport-storage';

const frameEncodings = new WeakMap<object, { text: string; bytes: number }>();

/** Reuse immutable reliable frame bytes for both live delivery and reconnect replay. */
export function encodedSocketFrame(value: Json): { text: string; bytes: number } {
  const cached = value !== null && typeof value === 'object' ? frameEncodings.get(value) : undefined;
  if (cached) return cached;
  const text = JSON.stringify(value); return { text, bytes: Buffer.byteLength(text) };
}

function rememberFrame(frame: JsonObject, encoded?: string): string {
  const cached = frameEncodings.get(frame);
  if (cached) return cached.text;
  const text = encoded ?? JSON.stringify(frame);
  const pending: object[] = [frame];
  while (pending.length) {
    const value = pending.pop()!;
    if (Object.isFrozen(value)) continue;
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
  frameEncodings.set(frame, { text, bytes: Buffer.byteLength(text) });
  return text;
}

export async function readRequest(request: IncomingMessage, signal: AbortSignal): Promise<Json> {
  const declared = Number(request.headers['content-length']);
  if (declared > MOBILE_BODY_LIMIT) throw new MobileError(413, 'payload_too_large', 'Payload is too large');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    signal.throwIfAborted(); const buffer = Buffer.from(chunk as Uint8Array); length += buffer.length;
    if (length > MOBILE_BODY_LIMIT) throw new MobileError(413, 'payload_too_large', 'Payload is too large');
    chunks.push(buffer);
  }
  if (!length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json; } catch { throw new MobileError(400, 'invalid_json', 'Invalid JSON'); }
}
export async function responseText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
      if (length > limit) throw new Error('Response is too large'); chunks.push(next.value); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function httpReply(response: ServerResponse, status: number, body: Json): void {
  if (response.destroyed || response.writableEnded) return;
  const text = status === 204 ? '' : JSON.stringify(body);
  if (Buffer.byteLength(text) > MOBILE_BODY_LIMIT) { httpReply(response, 500, { error: { type: 'response_too_large', message: 'Desktop response is too large' } }); return; }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(text);
}
export interface SocketWriteObservation { phase: 'started' | 'complete'; bytes: number; bufferedBytes: number; success?: boolean }
export function sendSocket(socket: WebSocket, value: Json, limit = MOBILE_BODY_LIMIT, observe?: (event: SocketWriteObservation) => void): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const { text, bytes } = encodedSocketFrame(value);
  if (bytes > limit || socket.bufferedAmount + bytes > limit * 2) { socket.terminate(); return false; }
  if (!observe) { socket.send(text, error => { if (error) socket.terminate(); }); return true; }
  const notify = (phase: SocketWriteObservation['phase'], success?: boolean): void => {
    try { observe?.({ phase, bytes, bufferedBytes: socket.bufferedAmount, success }); } catch { /* Observation is not transport admission. */ }
  };
  notify('started');
  try {
    socket.send(text, error => { if (error) socket.terminate(); notify('complete', !error); });
  } catch (error) { notify('complete', false); throw error; }
  return true;
}

const LOGICAL_CHUNK_THRESHOLD = 100 * 1024;
const BINARY_CHUNK_BYTES = 96 * 1024;

/** Reassembles logical client messages without putting every fragment behind engine work. */
export class ClientMessageChunks {
  private readonly assemblies = new Map<number, { count: number; chunks: Map<number, Buffer>; bytes: number; touchedAt: number }>();

  receive(frame: JsonObject): JsonObject | undefined {
    const { seq, index, count, data } = frame;
    if (!Number.isSafeInteger(seq) || Number(seq) < 1 || !Number.isSafeInteger(index) || !Number.isSafeInteger(count)
      || Number(count) < 1 || Number(count) > Math.ceil(MOBILE_BODY_LIMIT / BINARY_CHUNK_BYTES)
      || Number(index) < 0 || Number(index) >= Number(count) || typeof data !== 'string'
      || data.length > Math.ceil(BINARY_CHUNK_BYTES / 3) * 4) throw new MobileError(400, 'invalid_chunk', 'Invalid message fragment');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== data) throw new MobileError(400, 'invalid_chunk', 'Invalid message fragment encoding');
    const now = Date.now();
    for (const [id, assembly] of this.assemblies) if (now - assembly.touchedAt > RELIABLE_TTL_MS) this.assemblies.delete(id);
    const id = Number(seq), part = Number(index);
    let assembly = this.assemblies.get(id);
    if (!assembly) {
      if (this.assemblies.size >= 4) throw new MobileError(429, 'too_many_partial_messages', 'Too many unfinished messages');
      assembly = { count: Number(count), chunks: new Map(), bytes: 0, touchedAt: now }; this.assemblies.set(id, assembly);
    }
    const previous = assembly.chunks.get(part);
    if (assembly.count !== count || (previous && !previous.equals(bytes))) {
      this.assemblies.delete(id); throw new MobileError(400, 'invalid_chunk', 'Message fragments disagree');
    }
    if (!previous) { assembly.chunks.set(part, bytes); assembly.bytes += bytes.length; }
    assembly.touchedAt = now;
    const total = [...this.assemblies.values()].reduce((sum, value) => sum + value.bytes, 0);
    if (assembly.bytes > MOBILE_BODY_LIMIT || total > MOBILE_BODY_LIMIT * 2) {
      this.assemblies.delete(id); throw new MobileError(413, 'payload_too_large', 'Message is too large');
    }
    if (assembly.chunks.size !== assembly.count) return;
    this.assemblies.delete(id);
    const encoded = Buffer.concat(Array.from({ length: assembly.count }, (_, offset) => assembly!.chunks.get(offset)!));
    let message: unknown;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)); }
    catch { throw new MobileError(400, 'invalid_json', 'Invalid fragmented message'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new MobileError(400, 'invalid_json', 'Invalid fragmented message');
    return { type: 'client_message', seq: id, message: message as JsonObject };
  }

  clear(): void { this.assemblies.clear(); }

  expire(): void {
    const before = Date.now() - RELIABLE_TTL_MS;
    for (const [seq, assembly] of this.assemblies) if (assembly.touchedAt < before) this.assemblies.delete(seq);
  }

  receipts(): JsonObject[] {
    this.expire();
    return [...this.assemblies].map(([seq, assembly]) => ({
      seq, count: assembly.count, receivedIndexes: [...assembly.chunks.keys()].sort((a, b) => a - b),
    }));
  }
}

function chunkReceipts(value: unknown): Map<number, { count: number; receivedIndexes: Set<number> }> {
  const result = new Map<number, { count: number; receivedIndexes: Set<number> }>();
  if (value === undefined) return result;
  if (!Array.isArray(value) || value.length > 16) throw new MobileError(400, 'invalid_chunk_receipts', 'Invalid partial message receipts');
  for (const row of value) {
    const { seq, count, receivedIndexes } = object(row);
    if (!Number.isSafeInteger(seq) || Number(seq) < 1 || !Number.isSafeInteger(count) || Number(count) < 1
      || Number(count) > Math.ceil(MAX_RELIABLE_BYTES / BINARY_CHUNK_BYTES) || !Array.isArray(receivedIndexes)
      || receivedIndexes.length > Number(count) || result.has(Number(seq))) throw new MobileError(400, 'invalid_chunk_receipts', 'Invalid partial message receipts');
    const indexes = new Set<number>();
    for (const index of receivedIndexes) {
      if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= Number(count) || indexes.has(Number(index))) throw new MobileError(400, 'invalid_chunk_receipts', 'Invalid partial message receipts');
      indexes.add(Number(index));
    }
    result.set(Number(seq), { count: Number(count), receivedIndexes: indexes });
  }
  return result;
}

export class ReliableDelivery {
  private readonly clientWork = new SerialMutations();
  readonly clientChunks = new ClientMessageChunks();
  private requireChunkAcknowledgements = false;
  private readonly acknowledgedChunks = new Map<number, Set<number>>();
  private nextSeq: number;
  private readonly messages: ReliableMessage[];
  private bytes: number;
  private lastClientSeq: number;

  constructor(state?: ReliableDeliveryState, private readonly changed: (urgent: boolean) => void = () => {}) {
    this.nextSeq = state?.nextSeq ?? 1;
    this.lastClientSeq = state?.lastClientSeq ?? 0;
    this.messages = state?.messages ?? [];
    for (const message of this.messages) message.encodedFrames = message.frames.map((frame, index) => rememberFrame(frame, message.encodedFrames?.[index]));
    this.bytes = this.messages.reduce((total, message) => total + message.bytes, 0);
    this.prune(true);
  }

  enqueue(message: JsonObject): JsonObject[] {
    const seq = this.nextSeq++;
    const encoded = Buffer.from(JSON.stringify(message));
    const chunkCount = Math.ceil(encoded.length / BINARY_CHUNK_BYTES);
    const metadata = diagnosticMetadata(message) ?? {};
    const frames: JsonObject[] = encoded.length <= LOGICAL_CHUNK_THRESHOLD
      ? [{ type: 'server_message', seq, message: JSON.parse(encoded.toString('utf8')) as JsonObject, ...metadata }]
      : Array.from({ length: chunkCount }, (_, index) => ({
        type: 'server_message_chunk', seq, index, count: chunkCount, ...metadata,
        data: encoded.subarray(index * BINARY_CHUNK_BYTES, (index + 1) * BINARY_CHUNK_BYTES).toString('base64'),
      }));
    const encodedFrames = frames.map(frame => rememberFrame(frame));
    const bytes = frames.reduce((total, frame) => total + encodedSocketFrame(frame).bytes, 0);
    this.messages.push({ seq, frames, encodedFrames, bytes, createdAt: Date.now() }); this.bytes += bytes;
    this.prune(false);
    this.changed(false);
    return [...frames];
  }

  acknowledge(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= this.nextSeq) return;
    while (this.messages[0] && this.messages[0].seq <= seq) {
      const message = this.messages[0];
      if (this.requireChunkAcknowledgements && message.frames[0]?.type === 'server_message_chunk'
        && this.acknowledgedChunks.get(message.seq)?.size !== message.frames.length) break;
      this.bytes -= this.messages.shift()!.bytes; this.acknowledgedChunks.delete(message.seq);
    }
    this.prune(false);
    this.changed(false);
  }

  replay(afterSeq: number): { stale: boolean; frames: JsonObject[]; latestSeq: number; lastClientSeq: number } {
    this.prune(true);
    const oldest = this.messages[0]?.seq ?? this.nextSeq;
    const latestSeq = this.nextSeq - 1;
    if (afterSeq > latestSeq || afterSeq < oldest - 1) return { stale: true, frames: [], latestSeq, lastClientSeq: this.lastClientSeq };
    return { stale: false, frames: this.messages.filter(message => message.seq > afterSeq).flatMap(message => {
      const acknowledged = this.acknowledgedChunks.get(message.seq);
      return this.requireChunkAcknowledgements && acknowledged
        ? message.frames.filter(frame => frame.type !== 'server_message_chunk' || !acknowledged.has(Number(frame.index))) : message.frames;
    }), latestSeq, lastClientSeq: this.lastClientSeq };
  }

  resumeChunkReceipts(enabled: boolean, value: unknown): void {
    const receipts = enabled ? chunkReceipts(value) : new Map<number, { count: number; receivedIndexes: Set<number> }>();
    this.requireChunkAcknowledgements = enabled; this.acknowledgedChunks.clear();
    for (const message of this.messages) {
      const receipt = receipts.get(message.seq);
      if (message.frames[0]?.type === 'server_message_chunk' && receipt?.count === message.frames.length) this.acknowledgedChunks.set(message.seq, receipt.receivedIndexes);
    }
  }

  acknowledgeChunk(seq: number, index: number, count: number): void {
    if (!this.requireChunkAcknowledgements || !Number.isSafeInteger(seq) || !Number.isSafeInteger(index) || !Number.isSafeInteger(count)) return;
    const message = this.messages.find(row => row.seq === seq);
    if (!message || message.frames[0]?.type !== 'server_message_chunk' || count !== message.frames.length || index < 0 || index >= count) return;
    let acknowledged = this.acknowledgedChunks.get(seq);
    if (!acknowledged) { acknowledged = new Set(); this.acknowledgedChunks.set(seq, acknowledged); }
    acknowledged.add(index);
  }

  acceptClient(seq: number): 'accept' | 'duplicate' | 'gap' {
    if (seq <= this.lastClientSeq) return 'duplicate';
    if (seq !== this.lastClientSeq + 1) return 'gap';
    return 'accept';
  }

  /** A replacement socket must wait for the old socket's already entered action. */
  processClient(operation: () => Promise<void>): Promise<void> { return this.clientWork.run(operation); }

  commitClient(seq: number): void {
    if (seq !== this.lastClientSeq + 1) throw new Error('Reliable client sequence changed before commit');
    const previous = this.lastClientSeq;
    this.lastClientSeq = seq;
    try { this.changed(true); }
    catch (error) { this.lastClientSeq = previous; throw error; }
  }

  expectedClientSeq(): number { return this.lastClientSeq + 1; }
  committedClientSeq(): number { return this.lastClientSeq; }

  resetReplay(): number {
    const latest = this.nextSeq - 1;
    this.messages.length = 0; this.bytes = 0; this.acknowledgedChunks.clear();
    this.changed(true);
    return latest;
  }

  snapshot(): ReliableDeliveryState {
    this.prune(true);
    return {
      nextSeq: this.nextSeq,
      lastClientSeq: this.lastClientSeq,
      messages: this.messages.map(message => ({
        seq: message.seq, bytes: message.bytes, createdAt: message.createdAt,
        frames: message.frames.map(frame => ({ ...frame })),
      })),
    };
  }

  /** Only newly appended frames cross the persistence worker boundary. */
  persistence(afterSeq: number): Omit<StoredDelivery, 'clientId' | 'touchedAt'> {
    this.prune(true);
    return { nextSeq: this.nextSeq, lastClientSeq: this.lastClientSeq, firstSeq: this.messages[0]?.seq ?? this.nextSeq,
      messages: this.messages.filter(message => message.seq >= afterSeq).map(message => ({
        seq: message.seq, createdAt: message.createdAt, bytes: message.bytes, frames: '[' + message.encodedFrames!.join(',') + ']',
      })) };
  }

  expire(): boolean {
    const count = this.messages.length;
    this.prune(true); this.clientChunks.expire();
    return count !== this.messages.length;
  }

  private prune(expire: boolean): void {
    const before = Date.now() - RELIABLE_TTL_MS;
    while (this.messages.length && (
      this.messages.length > MAX_RELIABLE_MESSAGES
      || this.bytes > MAX_RELIABLE_BYTES
      || (expire && this.messages[0]!.createdAt < before)
    )) {
      const message = this.messages.shift()!; this.bytes -= message.bytes; this.acknowledgedChunks.delete(message.seq);
    }
  }
}

export class ReliableDeliveryStore {
  private readonly clients = new Map<string, { delivery: ReliableDelivery; touchedAt: number; persistedNextSeq: number }>();
  private readonly restored = new Map<string, { touchedAt: number; state: ReliableDeliveryState }>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly requests = new Map<number, { resolve(): void; reject(error: Error): void }>();
  private readonly worker?: Worker;
  private readonly loading: Promise<void>;
  private loaded = false;
  private failure?: Error;
  private nextRequestId = 1;
  private writing?: Promise<void>;
  private closing?: Promise<void>;
  private writes = 0;
  private appendedFrames = 0;
  private appendedBytes = 0;
  private timer?: NodeJS.Timeout;
  private readonly maintenance: NodeJS.Timeout;

  constructor(private readonly path?: string) {
    this.maintenance = setInterval(() => {
      let changed = false;
      for (const [id, entry] of this.clients) if (entry.delivery.expire()) { this.dirty.add(id); changed = true; }
      if (changed) this.persist();
    }, 60_000);
    this.maintenance.unref();
    if (!path) { this.loaded = true; this.loading = Promise.resolve(); return; }
    this.worker = new Worker(join(__dirname, 'transport-store-worker.js'), { workerData: { path } });
    this.loading = new Promise<void>((resolve, reject) => {
      this.worker!.on('message', (reply: JournalReply) => {
        if (reply.type === 'client') {
          this.restored.set(reply.clientId, { touchedAt: reply.touchedAt,
            state: { nextSeq: reply.nextSeq, lastClientSeq: reply.lastClientSeq, messages: [] } });
        } else if (reply.type === 'message') {
          const state = this.restored.get(reply.clientId)?.state;
          if (!state) { const error = new Error('Replay restore lost its client identity'); this.fail(error); reject(error); return; }
          let message = state.messages.at(-1);
          if (!message || message.seq !== reply.seq) {
            message = { seq: reply.seq, createdAt: reply.createdAt, bytes: reply.bytes, frames: [], encodedFrames: [] };
            state.messages.push(message);
          }
          for (let index = 0; index < reply.frames.length; index++) rememberFrame(reply.frames[index]!, reply.encodedFrames[index]);
          message.frames.push(...reply.frames); message.encodedFrames!.push(...reply.encodedFrames);
          this.worker!.postMessage({ type: 'restore_ack', id: reply.restoreId } satisfies JournalRequest);
        } else if (reply.type === 'ready') {
          for (const [clientId, entry] of this.restored) this.clients.set(clientId, {
            delivery: this.delivery(clientId, entry.state), touchedAt: entry.touchedAt, persistedNextSeq: entry.state.nextSeq,
          });
          this.restored.clear(); this.loaded = true; resolve();
        } else if (reply.type === 'done') {
          const request = this.requests.get(reply.id); this.requests.delete(reply.id); request?.resolve();
        } else {
          const error = new Error(reply.message); this.fail(error); reject(error);
        }
      });
      this.worker!.on('error', error => { this.fail(error); reject(error); });
      this.worker!.on('exit', code => {
        if (this.requests.size || !this.loaded || (!this.closing && !this.failure)) {
          const error = new Error(`Mobile replay journal worker exited (${code})`); this.fail(error); reject(error);
        }
      });
    });
    void this.loading.catch(() => {});
  }

  ready(): Promise<void> { return this.loading; }

  get(clientId: string): ReliableDelivery {
    if (this.closing) throw new MobileError(503, 'transport_closed', 'Mobile transport storage is closed');
    if (!this.loaded) throw new MobileError(503, 'transport_initializing', 'Mobile transport storage is still restoring');
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(clientId)) throw new MobileError(400, 'invalid_client_id', 'Invalid mobile transport identity');
    const now = Date.now();
    for (const [key, value] of this.clients) if (now - value.touchedAt > CLIENT_CURSOR_TTL_MS) {
      this.clients.delete(key); this.dirty.delete(key); this.removed.add(key);
    }
    let entry = this.clients.get(clientId);
    if (!entry) {
      if (this.clients.size >= MAX_RELIABLE_CLIENTS) throw new MobileError(429, 'too_many_transport_clients', 'Too many mobile transport identities');
      entry = { delivery: this.delivery(clientId), touchedAt: now, persistedNextSeq: 1 }; this.clients.set(clientId, entry);
    }
    entry.touchedAt = now; this.dirty.add(clientId); this.persist(); return entry.delivery;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.maintenance);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const entry of this.clients.values()) entry.delivery.clientChunks.clear();
    this.closing = (async () => {
      try {
        await this.loading; this.writeCursors(); await this.flush();
        if (this.worker) await this.request({ type: 'close', id: this.nextRequestId++ });
      } finally { await this.worker?.terminate(); }
    })();
    return this.closing;
  }

  private delivery(clientId: string, state?: ReliableDeliveryState): ReliableDelivery {
    return new ReliableDelivery(state, urgent => {
      const entry = this.clients.get(clientId);
      if (entry) entry.touchedAt = Date.now();
      if (urgent) this.writeCursors();
      this.dirty.add(clientId);
      this.persist();
    });
  }

  private persist(): void {
    if (!this.path || this.closing || this.failure || this.timer || this.writing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(error => {
        process.emitWarning(`Unable to persist mobile transport state: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 25);
    this.timer.unref();
  }

  /** Wait for all accepted revisions, including changes made during an in-flight write. */
  async flush(): Promise<void> {
    await this.loading;
    if (!this.path) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.writing) { await this.writing; continue; }
      if (!this.dirty.size && !this.removed.size) return;
      const entries = [...this.dirty].flatMap(id => { const entry = this.clients.get(id); return entry ? [{ id, entry, state: entry.delivery.persistence(entry.persistedNextSeq) }] : []; });
      const clients = entries.map(({ id, entry, state }) => ({ clientId: id, touchedAt: entry.touchedAt, ...state }));
      const removed = [...this.removed]; this.dirty.clear(); this.removed.clear();
      this.writes++;
      this.appendedFrames += clients.reduce((sum, client) => sum + client.messages.length, 0);
      this.appendedBytes += clients.reduce((sum, client) => sum + client.messages.reduce((total, message) => total + message.bytes, 0), 0);
      const writing = this.request({ type: 'write', id: this.nextRequestId++, clients, removed }).then(() => {
        for (const { id, entry, state } of entries) if (this.clients.get(id) === entry) entry.persistedNextSeq = state.nextSeq;
      });
      this.writing = writing;
      try { await writing; }
      finally { if (this.writing === writing) this.writing = undefined; }
    }
  }

  stats(): { writes: number; appendedMessages: number; appendedBytes: number } {
    return { writes: this.writes, appendedMessages: this.appendedFrames, appendedBytes: this.appendedBytes };
  }

  private request(request: JournalRequest): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      this.requests.set(request.id, { resolve, reject });
      try { this.worker!.postMessage(request); }
      catch (error) { const failure = error instanceof Error ? error : new Error(String(error)); this.fail(failure); }
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const pending of this.requests.values()) pending.reject(this.failure);
    this.requests.clear();
  }

  private cursorPath(): string {
    return this.path! + '.client-cursors';
  }

  /**
   * Inbound client actions are acknowledged only after their cursor is durable.
   * Keep that synchronous durability record small: serializing the replay
   * journal here could otherwise block Electron's main loop on tens of MiB.
   */
  private writeCursors(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const clients = Object.fromEntries([...this.clients].map(([clientId, entry]) => [clientId, {
      touchedAt: entry.touchedAt,
      lastClientSeq: entry.delivery.committedClientSeq(),
    }]));
    const path = this.cursorPath(), temporary = path + `.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ version: 1, clients }), { mode: 0o600, flush: true });
    renameSync(temporary, path);
  }
}
export function socketBytes(data: RawData): Buffer { return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data); }
export function stopSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolve => {
    socket.once('close', resolve); socket.once('error', () => {}); socket.terminate();
  });
}
