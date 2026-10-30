import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { open } from 'node:fs/promises';
import { blake2b } from '@noble/hashes/blake2.js';

export interface MinisignKey { key: KeyObject; id: Buffer }
interface MinisignSignature { signature: Buffer; global: Buffer; comment: Buffer; prehashed: boolean }

/** Decode canonical base64 rather than Node's permissive, truncating decoder. */
export function strictBase64(value: unknown, maximum = 16_384): Buffer {
  if (typeof value !== 'string' || value.length > maximum || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid signature encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Noncanonical signature encoding');
  return bytes;
}

function lines(encoded: string): string[] { return strictBase64(encoded).toString('utf8').trimEnd().split(/\r?\n/); }

/** Existing Klaus keys and .sig files wrap the Minisign text in base64. */
export function parseMinisignKey(encoded: string): MinisignKey {
  const text = lines(encoded);
  if (text.length !== 2 || !text[0]?.startsWith('untrusted comment: ')) throw new Error('Invalid Minisign public key');
  const bytes = strictBase64(text[1]);
  if (bytes.length !== 42 || !['Ed', 'ED'].includes(bytes.toString('ascii', 0, 2))) throw new Error('Unsupported Minisign public key');
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return { id: bytes.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([prefix, bytes.subarray(10)]), format: 'der', type: 'spki' }) };
}

function parseSignature(encoded: string, key: MinisignKey): MinisignSignature {
  const text = lines(encoded);
  if (text.length !== 4 || !text[0]?.startsWith('untrusted comment: ') || !text[2]?.startsWith('trusted comment: ')) throw new Error('Invalid Minisign signature');
  const bytes = strictBase64(text[1]), global = strictBase64(text[3]);
  if (bytes.length !== 74 || global.length !== 64 || !['Ed', 'ED'].includes(bytes.toString('ascii', 0, 2))) throw new Error('Unsupported Minisign signature');
  if (!timingSafeEqual(bytes.subarray(2, 10), key.id)) throw new Error('Update signature key does not match');
  return { signature: bytes.subarray(10), global, comment: Buffer.from(text[2].slice(17)), prehashed: bytes.toString('ascii', 0, 2) === 'ED' };
}

function verifySignature(message: Buffer, signature: MinisignSignature, key: MinisignKey): void {
  if (!verify(null, message, key.key, signature.signature) || !verify(null, Buffer.concat([signature.signature, signature.comment]), key.key, signature.global)) throw new Error('Update signature verification failed');
}

export function verifyMinisign(bytes: Buffer, encoded: string, key: MinisignKey): void {
  const signature = parseSignature(encoded, key);
  // Electron uses BoringSSL, whose Node crypto surface omits BLAKE2b.
  verifySignature(signature.prehashed ? Buffer.from(blake2b(bytes, { dkLen: 64 })) : bytes, signature, key);
}

/** New Electron artifacts use streaming Minisign ED, avoiding an archive-sized heap copy. */
export async function verifyMinisignFile(path: string, encoded: string, key: MinisignKey, expected: { size: number; sha256: string; sha512: string }, signal?: AbortSignal): Promise<void> {
  const signature = parseSignature(encoded, key);
  if (!signature.prehashed) throw new Error('Electron update artifacts require a prehashed Minisign ED signature');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expected.size) throw new Error('Update artifact size mismatch');
    const blake = blake2b.create({ dkLen: 64 }), sha256 = createHash('sha256'), sha512 = createHash('sha512');
    let count = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      signal?.throwIfAborted(); count += chunk.length;
      if (count > expected.size) throw new Error('Update artifact grew during verification');
      blake.update(chunk); sha256.update(chunk); sha512.update(chunk);
    }
    if (count !== expected.size || sha256.digest('hex') !== expected.sha256 || sha512.digest('base64') !== expected.sha512) throw new Error('Update artifact checksum mismatch');
    verifySignature(Buffer.from(blake.digest()), signature, key);
  } finally { await file.close(); }
}
