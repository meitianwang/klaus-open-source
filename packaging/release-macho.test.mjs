import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machOFileType } from './release-macho.mjs';

function thin(type, { little = true, wide = true } = {}) {
  const bytes = Buffer.alloc(wide ? 32 : 28);
  const put = little ? bytes.writeUInt32LE.bind(bytes) : bytes.writeUInt32BE.bind(bytes);
  put(wide ? 0xfeedfacf : 0xfeedface, 0); put(wide ? 0x100000c : 12, 4); put(type, 12);
  return bytes;
}
function universal(types, { little = false, wide = false } = {}) {
  const stride = wide ? 32 : 20, base = 8 + stride * types.length, bytes = Buffer.alloc(base + 32 * types.length);
  const put = little ? bytes.writeUInt32LE.bind(bytes) : bytes.writeUInt32BE.bind(bytes);
  put(wide ? 0xcafebabf : 0xcafebabe, 0); put(types.length, 4);
  for (const [index, type] of types.entries()) {
    const entry = 8 + index * stride, offset = base + index * 32;
    put(index ? 0x1000007 : 0x100000c, entry);
    if (wide) {
      const big = little ? bytes.writeBigUInt64LE.bind(bytes) : bytes.writeBigUInt64BE.bind(bytes);
      big(BigInt(offset), entry + 8); big(32n, entry + 16);
    } else { put(offset, entry + 8); put(32, entry + 12); }
    thin(type).copy(bytes, offset);
  }
  return bytes;
}
async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'klaus-macho-header-'));
  const file = join(directory, 'binary');
  try { await callback(async bytes => { await writeFile(file, bytes); return machOFileType(file); }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('Mach-O headers distinguish executable, dylib and bundle for both byte orders and widths', async () => fixture(async read => {
  for (const little of [false, true]) for (const wide of [false, true]) for (const type of [2, 6, 8]) assert.equal(await read(thin(type, { little, wide })), type);
}));

test('universal Mach-O headers require all architecture slices to have one file type', async () => fixture(async read => {
  for (const little of [false, true]) for (const wide of [false, true]) {
    assert.equal(await read(universal([2, 2], { little, wide })), 2);
    assert.equal(await read(universal([6, 6], { little, wide })), 6);
    await assert.rejects(read(universal([2, 6], { little, wide })), /different file types/);
  }
}));

test('Mach-O inspection rejects truncated, overlapping and unsafe headers', async () => fixture(async read => {
  for (const bytes of [Buffer.alloc(3), Buffer.alloc(32), thin(0), thin(2).subarray(0, 31)]) await assert.rejects(read(bytes), /Mach-O/);
  const count = universal([2]); count.writeUInt32BE(33, 4); await assert.rejects(read(count), /architecture count/);
  const overlap = universal([2, 2]); overlap.writeUInt32BE(48, 36); await assert.rejects(read(overlap), /slice bounds/);
  const outOfBounds = universal([2]); outOfBounds.writeUInt32BE(0xffffffff, 16); await assert.rejects(read(outOfBounds), /slice bounds/);
  const unsafe = universal([2], { wide: true }); unsafe.writeBigUInt64BE(1n << 63n, 16); await assert.rejects(read(unsafe), /slice bounds/);
  const nested = universal([2]); nested.writeUInt32BE(0xcafebabe, 28); await assert.rejects(read(nested), /slice header/);
}));
