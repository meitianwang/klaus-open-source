#!/usr/bin/env node
// Package the bundled Chrome extension as a CRX3 plus its Chrome update manifest.
//
// Why this exists instead of `chrome --pack-extension`: the policy install path
// (ExtensionInstallForcelist) only accepts a store update URL or an HTTPS-hosted
// CRX, and the Web Store listing was rejected. Chrome's own packer also needs a
// running browser and writes beside the source tree; this is deterministic,
// dependency-free and runs in CI or on the release box.
//
// The signing key is NOT in the repo. It lives where the updater key lives
// (`~/.klaus/chrome-extension-crx.pem`, 0600): the extension id is the hash of
// the public key, so losing the key means losing the id and every installed
// policy copy. `--key` may point anywhere for tests.
//
// CRX3 layout: "Cr24" + u32 version 3 + u32 header size + protobuf
// { 2: RSA public key DER, 3: RSA-SHA256 signature over header||zip }. The zip
// is STORE-only: Chrome unpacks it itself and compression gains nothing here
// while a hand-rolled deflate would be the riskiest part of the format.
import { createHash, createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function varint(value) {
  const out = [];
  let v = value;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

export function protobufField(fieldNumber, payload) {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(payload.length), payload]);
}

/** DOS timestamp for zip entries: fixed so two packs of the same tree match. */
export function dosWhen(date = new Date('2026-01-01T00:00:00Z')) {
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

function walk(directory, base = directory) {
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) entries.push(...walk(path, base));
    else entries.push({ name: relative(base, path).split(sep).join('/'), path });
  }
  return entries;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A STORE-only zip: local headers, central directory, EOCD. */
export function zipStore(entries) {
  const { time, day } = dosWhen();
  const locals = []; const centrals = []; let offset = 0;
  for (const entry of entries) {
    const data = readFileSync(entry.path);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value, 0); return b; }

export function extensionIdFromPublicKey(publicDer) {
  const digest = createHash('sha256').update(publicDer).digest();
  const alpha = 'abcdefghijklmnop';
  return Array.from(digest.subarray(0, 16)).map(byte => alpha[byte >> 4] + alpha[byte & 15]).join('');
}

/**
 * The CRX3 signature context, verbatim from Chromium's crx_file.h. Every proof
 * covers exactly: this string, the little-endian length of the signed header,
 * the signed header bytes, then the archive. Nothing else — not the magic,
 * not the outer header size, not the proofs themselves.
 */
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0', 'binary');

/**
 * Pack the directory into a CRX3, following components/crx_file/crx3.proto:
 * CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
 *                 bytes signed_header_data = 10000; } where the signed header
 * is SignedData { bytes crx_id = 1; } holding the first 16 bytes of the
 * SHA-256 of the public key DER — which is also how the extension id derives.
 */
export function buildCrx({ sourceDirectory, privateKeyPem }) {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const entries = walk(sourceDirectory).filter(entry => !entry.name.startsWith('.'));
  if (!entries.some(entry => entry.name === 'manifest.json')) throw new Error('The extension directory has no manifest.json.');
  const zip = zipStore(entries);
  const crxIdBytes = createHash('sha256').update(publicDer).digest().subarray(0, 16);
  const signedData = protobufField(1, crxIdBytes);
  const signer = createSign('SHA256');
  signer.update(SIGNATURE_CONTEXT);
  signer.update(u32(signedData.length));
  signer.update(signedData);
  signer.update(zip);
  const signature = signer.sign(privateKey);
  const proof = Buffer.concat([protobufField(1, publicDer), protobufField(2, signature)]);
  const header = Buffer.concat([protobufField(2, proof), protobufField(10000, signedData)]);
  const crx = Buffer.concat([Buffer.from('Cr24', 'ascii'), u32(3), u32(header.length), header, zip]);
  return { crx, publicDer, signature, zip, signedData, extensionId: extensionIdFromPublicKey(publicDer) };
}

export function updateManifest({ extensionId, version, codebase }) {
  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${extensionId}'>
    <updatecheck codebase='${codebase}' version='${version}' />
  </app>
</gupdate>
`;
}

/**
 * Parse a CRX3 back into its parts. Tags are varints (field 10000 needs two
 * bytes), so both tag and length are read with the same loop.
 */
export function parseCrx(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'Cr24') throw new Error('Not a CRX file.');
  const version = buffer.readUInt32LE(4);
  if (version !== 3) throw new Error(`Unsupported CRX version ${version}.`);
  const headerSize = buffer.readUInt32LE(8);
  const readVarint = start => {
    let value = 0; let shift = 0; let cursor = start;
    for (;;) { const byte = buffer[cursor]; value += (byte & 0x7f) * 2 ** shift; cursor += 1; shift += 7; if (!(byte & 0x80)) break; }
    return [value, cursor];
  };
  let cursor = 12; const end = 12 + headerSize; const fields = {};
  while (cursor < end) {
    const [tag, afterTag] = readVarint(cursor);
    const fieldNumber = Math.floor(tag / 8);
    const [length, afterLength] = readVarint(afterTag);
    fields[fieldNumber] = buffer.subarray(afterLength, afterLength + length);
    cursor = afterLength + length;
  }
  // Field 2 is the first AsymmetricKeyProof: { 1: public_key, 2: signature }.
  const proof = fields[2] ?? Buffer.alloc(0);
  const proofFields = {};
  let p = 0;
  while (p < proof.length) {
    let tag = 0; let shift = 0;
    for (;;) { const byte = proof[p]; tag += (byte & 0x7f) * 2 ** shift; p += 1; shift += 7; if (!(byte & 0x80)) break; }
    let length = 0; shift = 0;
    for (;;) { const byte = proof[p]; length += (byte & 0x7f) * 2 ** shift; p += 1; shift += 7; if (!(byte & 0x80)) break; }
    proofFields[Math.floor(tag / 8)] = proof.subarray(p, p + length);
    p += length;
  }
  return { version, headerSize, publicDer: proofFields[1], signature: proofFields[2], signedData: fields[10000], zip: buffer.subarray(end) };
}

export function verifyCrx(buffer) {
  const { publicDer, signature, signedData, zip } = parseCrx(buffer);
  if (!publicDer || !signature || !signedData) return false;
  const verifier = createVerify('SHA256');
  verifier.update(SIGNATURE_CONTEXT);
  verifier.update(u32(signedData.length));
  verifier.update(signedData);
  verifier.update(zip);
  return verifier.verify(createPublicKey({ key: publicDer, format: 'der', type: 'spki' }), signature);
}

/** Read one named entry out of a STORE zip (enough to self-check the pack). */
export function zipEntry(zip, name) {
  let cursor = 0;
  while (cursor + 30 <= zip.length && zip.readUInt32LE(cursor) === 0x04034b50) {
    const nameLength = zip.readUInt16LE(cursor + 26);
    const extraLength = zip.readUInt16LE(cursor + 28);
    const size = zip.readUInt32LE(cursor + 18);
    const entryName = zip.subarray(cursor + 30, cursor + 30 + nameLength).toString('utf8');
    const start = cursor + 30 + nameLength + extraLength;
    if (entryName === name) return zip.subarray(start, start + size);
    cursor = start + size;
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
  // The bundled extension is a resource of this repository.
  const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
  const source = value('--source') ?? join(desktopRoot, 'resources/plugins-builtin/browser/chrome-extension');
  const keyPath = value('--key') ?? join(process.env.HOME ?? '', '.klaus/chrome-extension-crx.pem');
  const outDirectory = value('--out') ?? join(process.cwd(), 'dist/chrome-extension-release');
  const baseUrl = value('--url');
  if (!baseUrl) { console.error('usage: package-chrome-extension.mjs --url https://host/path/ [--source dir] [--key pem] [--out dir]'); process.exit(2); }
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  const { crx, extensionId } = buildCrx({ sourceDirectory: source, privateKeyPem: readFileSync(keyPath, 'utf8') });
  if (!verifyCrx(crx)) throw new Error('The freshly packed CRX does not verify against its own key.');
  const codebase = `${baseUrl.replace(/\/+$/, '')}/klaus-browser-extension.crx`;
  mkdirSync(outDirectory, { recursive: true });
  writeFileSync(join(outDirectory, 'klaus-browser-extension.crx'), crx);
  writeFileSync(join(outDirectory, 'update_manifest.xml'), updateManifest({ extensionId, version: manifest.version, codebase }));
  console.log(JSON.stringify({ extensionId, version: manifest.version, codebase, bytes: crx.length, out: outDirectory }));
}

if (process.argv[1] && process.argv[1].endsWith('package-chrome-extension.mjs')) main();
