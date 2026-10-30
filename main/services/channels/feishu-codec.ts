export interface FeishuFrame {
  seqId: bigint; logId: bigint; service: number; method: number; headers: Array<[string, string]>;
  payloadEncoding?: string; payloadType?: string; payload?: Buffer; logIdNew?: string;
}
const LIMIT = 1024 * 1024;
export const feishuHeader = (frame: FeishuFrame, key: string): string | undefined => frame.headers.find(row => row[0] === key)?.[1];
function varint(value: bigint): Buffer {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error('Invalid Feishu protobuf integer');
  const out: number[] = []; do { const byte = Number(value & 127n); value >>= 7n; out.push(value ? byte | 128 : byte); } while (value); return Buffer.from(out);
}
const field = (id: number, data: Uint8Array): Buffer => Buffer.concat([varint(BigInt(id * 8 + 2)), varint(BigInt(data.byteLength)), data]);
export function encodeFeishuFrame(frame: FeishuFrame): Buffer {
  if (![frame.service, frame.method].every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) || frame.headers.length > 64) throw new Error('Invalid Feishu frame');
  const chunks = [Buffer.from([8]), varint(frame.seqId), Buffer.from([16]), varint(frame.logId), Buffer.from([24]), varint(BigInt(frame.service >>> 0)), Buffer.from([32]), varint(BigInt(frame.method >>> 0))];
  for (const [key, value] of frame.headers) { if (Buffer.byteLength(key) + Buffer.byteLength(value) > 16_384) throw new Error('Feishu header exceeds the size limit'); chunks.push(field(5, Buffer.concat([field(1, Buffer.from(key)), field(2, Buffer.from(value))]))); }
  for (const [id, value] of [[6, frame.payloadEncoding], [7, frame.payloadType], [8, frame.payload], [9, frame.logIdNew]] as const) if (value !== undefined) chunks.push(field(id, typeof value === 'string' ? Buffer.from(value) : value));
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0); if (size > LIMIT) throw new Error('Feishu frame exceeds the size limit'); return Buffer.concat(chunks, size);
}
class Reader {
  position = 0;
  constructor(readonly bytes: Buffer) {}
  integer(): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      const byte = this.bytes[this.position++]; if (byte === undefined || (index === 9 && byte > 1)) throw new Error('Invalid Feishu protobuf integer');
      value |= BigInt(byte & 127) << BigInt(7 * index); if (!(byte & 128)) return value;
    }
    throw new Error('Invalid Feishu protobuf integer');
  }
  block(): Buffer { const length = this.integer(); if (length > BigInt(this.bytes.length - this.position)) throw new Error('Truncated Feishu protobuf field'); const start = this.position; this.position += Number(length); return this.bytes.subarray(start, this.position); }
  skip(wire: number): void {
    if (wire === 0) { this.integer(); return; } if (wire === 2) { this.block(); return; }
    if (wire !== 1 && wire !== 5) throw new Error('Invalid Feishu protobuf wire type'); this.position += wire === 1 ? 8 : 4;
    if (this.position > this.bytes.length) throw new Error('Truncated Feishu protobuf field');
  }
}
const decodeText = (bytes: Buffer): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export function decodeFeishuFrame(bytes: Buffer): FeishuFrame {
  if (bytes.length > LIMIT) throw new Error('Feishu frame exceeds the size limit');
  const frame: FeishuFrame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] }, reader = new Reader(bytes);
  while (reader.position < bytes.length) {
    const tag = reader.integer(); if (tag === 0n || tag > 0xffffffffn) throw new Error('Invalid Feishu protobuf tag'); const id = Number(tag >> 3n), wire = Number(tag & 7n);
    if (id <= 4) {
      if (wire !== 0) throw new Error('Invalid Feishu protobuf field type'); const value = reader.integer();
      if (id === 1) frame.seqId = value; else if (id === 2) frame.logId = value; else if (id === 3) frame.service = Number(BigInt.asIntN(32, value)); else frame.method = Number(BigInt.asIntN(32, value));
    } else if (id <= 9) {
      if (wire !== 2) throw new Error('Invalid Feishu protobuf field type'); const value = reader.block();
      if (id === 5) {
        if (value.length > 16_384 || frame.headers.length >= 64) throw new Error('Feishu header capacity exceeded');
        const nested = new Reader(value); let key = '', text = '';
        while (nested.position < value.length) { const tag = nested.integer(); if (tag === 10n) key = decodeText(nested.block()); else if (tag === 18n) text = decodeText(nested.block()); else nested.skip(Number(tag & 7n)); }
        frame.headers.push([key, text]);
      } else if (id === 6) frame.payloadEncoding = decodeText(value); else if (id === 7) frame.payloadType = decodeText(value); else if (id === 8) frame.payload = Buffer.from(value); else frame.logIdNew = decodeText(value);
    } else reader.skip(wire);
  }
  return frame;
}
/** Account/socket-owned reassembly with independent TTL, count, shard and total-byte bounds. */
export class FeishuShards {
  private readonly entries = new Map<string, { parts: Array<Buffer | undefined>; at: number; size: number }>();
  private size = 0;
  constructor(private readonly now = Date.now) {}
  clear(): void { this.entries.clear(); this.size = 0; }
  merge(id: string, sum: number, sequence: number, bytes: Buffer): Buffer | undefined {
    const now = this.now();
    for (const [key, entry] of this.entries) if (now - entry.at > 10_000) { this.entries.delete(key); this.size -= entry.size; }
    if (!id || Buffer.byteLength(id) > 2048 || !Number.isSafeInteger(sum) || sum < 1 || sum > 128 || !Number.isSafeInteger(sequence) || sequence < 0 || sequence >= sum || !bytes.length || bytes.length > LIMIT) throw new Error('Invalid Feishu shard');
    let entry = this.entries.get(id);
    if (entry && entry.parts.length !== sum) throw new Error('Feishu shard count changed');
    if (!entry) { if (this.entries.size >= 64) throw new Error('Feishu shard message capacity exceeded'); entry = { parts: Array.from({ length: sum }), at: now, size: 0 }; this.entries.set(id, entry); }
    const previous = entry.parts[sequence];
    if (previous) { if (!previous.equals(bytes)) throw new Error('Feishu shard content changed'); return undefined; }
    if (entry.size + bytes.length > LIMIT || this.size + bytes.length > 4 * LIMIT) throw new Error('Feishu shard byte capacity exceeded');
    entry.parts[sequence] = Buffer.from(bytes); entry.size += bytes.length; this.size += bytes.length;
    if (entry.parts.some(part => part === undefined)) return undefined;
    this.entries.delete(id); this.size -= entry.size; return Buffer.concat(entry.parts as Buffer[], entry.size);
  }
}
