import { open } from 'node:fs/promises';

const thinFormats = new Map([
  [0xfeedface, { little: false, size: 28 }], [0xfeedfacf, { little: false, size: 32 }],
  [0xcefaedfe, { little: true, size: 28 }], [0xcffaedfe, { little: true, size: 32 }],
]);
const fatFormats = new Map([
  [0xcafebabe, { little: false, wide: false }], [0xcafebabf, { little: false, wide: true }],
  [0xbebafeca, { little: true, wide: false }], [0xbfbafeca, { little: true, wide: true }],
]);

/** Read only bounded headers; all slices of a universal binary must agree. */
export async function machOFileType(file) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    async function read(position, length) {
      if (!Number.isSafeInteger(position) || position < 0 || position + length > size) throw new Error('Invalid Mach-O header bounds');
      const bytes = Buffer.alloc(length);
      if ((await handle.read(bytes, 0, length, position)).bytesRead !== length) throw new Error('Truncated Mach-O header');
      return bytes;
    }
    const header = await read(0, 16), magic = header.readUInt32BE(0);
    function thinType(bytes, available) {
      const format = thinFormats.get(bytes.readUInt32BE(0));
      if (!format || available < format.size) throw new Error('Invalid Mach-O slice header');
      const type = format.little ? bytes.readUInt32LE(12) : bytes.readUInt32BE(12);
      if (!type) throw new Error('Invalid Mach-O file type');
      return type;
    }
    if (thinFormats.has(magic)) return thinType(header, size);
    const format = fatFormats.get(magic);
    if (!format) throw new Error('Unrecognized Mach-O header');
    const u32 = (bytes, offset) => format.little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const count = u32(header, 4), stride = format.wide ? 32 : 20;
    if (count < 1 || count > 32) throw new Error('Invalid Mach-O architecture count');
    const table = await read(8, count * stride), ranges = []; let type;
    function integer(offset) {
      if (!format.wide) return u32(table, offset);
      const value = format.little ? table.readBigUInt64LE(offset) : table.readBigUInt64BE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid Mach-O slice bounds');
      return Number(value);
    }
    for (let index = 0; index < count; index++) {
      const start = index * stride, offset = integer(start + 8), length = integer(start + (format.wide ? 16 : 12));
      if (length < 28 || offset < 8 + table.length || offset + length > size || ranges.some(range => offset < range.end && offset + length > range.start)) throw new Error('Invalid Mach-O slice bounds');
      const current = thinType(await read(offset, 16), length);
      if (type !== undefined && current !== type) throw new Error('Mach-O slices have different file types');
      type = current; ranges.push({ start: offset, end: offset + length });
    }
    return type;
  } finally { await handle.close(); }
}
