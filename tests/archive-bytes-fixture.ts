import { createHash } from 'node:crypto';

export function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
/** A valid GGUF v3 language tensor with four f32 elements, independent of the reader. */
export function gguf(architecture = 'llama', payloadBytes = 16): Buffer {
  const values: Buffer[] = [], u32 = (n: number): void => { const b = Buffer.alloc(4); b.writeUInt32LE(n); values.push(b); }, u64 = (n: number): void => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); values.push(b); }, text = (s: string): void => { u64(Buffer.byteLength(s)); values.push(Buffer.from(s)); };
  values.push(Buffer.from('GGUF')); u32(3); u64(1); u64(1); text('general.architecture'); u32(8); text(architecture);
  text('token_embd.weight'); u32(1); u64(4); u32(0); u64(0);
  const header = Buffer.concat(values); return Buffer.concat([header, Buffer.alloc((32 - header.length % 32) % 32), Buffer.alloc(payloadBytes, 1)]);
}
/** ZIP STORE fixture, including a central directory and CRC, without invoking the extractor. */
export function zip(entries: Array<{ name: string; bytes: Buffer; mode?: number }>): Buffer {
  const data: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    let crc = 0xffffffff; for (const byte of entry.bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } crc = (crc ^ 0xffffffff) >>> 0;
    const name = Buffer.from(entry.name), local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.bytes.length, 20); central.writeUInt32LE(entry.bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode ?? 0o100755) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    data.push(local, name, entry.bytes); directory.push(central, name); offset += local.length + name.length + entry.bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...data, central, end]);
}
