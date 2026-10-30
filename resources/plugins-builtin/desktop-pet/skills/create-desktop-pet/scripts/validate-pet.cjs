#!/usr/bin/env node
'use strict';
const { readFileSync, realpathSync, statSync } = require('node:fs');
const { isAbsolute, join, relative, resolve } = require('node:path');
const LIMIT = 20 * 1024 * 1024;
function dimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: 'png' };
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error('The sprite image must be PNG or WebP.');
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > bytes.length) break;
    if (kind === 'VP8X' && length >= 10) return { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1, format: 'webp' };
    if (kind === 'VP8L' && length >= 5 && bytes[start] === 47) { const bits = bytes.readUInt32LE(start + 1); return { width: bits % 16384 + 1, height: Math.floor(bits / 16384) % 16384 + 1, format: 'webp' }; }
    if (kind === 'VP8 ' && length >= 10 && bytes[start + 3] === 157 && bytes[start + 4] === 1 && bytes[start + 5] === 42) return { width: bytes.readUInt16LE(start + 6) % 16384, height: bytes.readUInt16LE(start + 8) % 16384, format: 'webp' };
    offset = start + length + length % 2;
  }
  throw new Error('The WebP image has no valid dimensions.');
}
function validate(directory, requestedVersion) {
  const root = realpathSync(resolve(directory)), manifest = JSON.parse(readFileSync(join(root, 'pet.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('pet.json must contain an object.');
  if (typeof manifest.displayName !== 'string' || !manifest.displayName.trim() || manifest.displayName.length > 160) throw new Error('A displayName of at most 160 characters is required.');
  if (![1, 2].includes(manifest.spriteVersionNumber) || requestedVersion && manifest.spriteVersionNumber !== requestedVersion) throw new Error('The sprite version does not match the requested output.');
  if (typeof manifest.spritesheetPath !== 'string' || !manifest.spritesheetPath || isAbsolute(manifest.spritesheetPath)) throw new Error('spritesheetPath must name a relative image file.');
  const image = realpathSync(resolve(root, manifest.spritesheetPath)), child = relative(root, image);
  if (!child || child === '..' || child.startsWith('..' + require('node:path').sep) || isAbsolute(child)) throw new Error('The sprite image must stay inside the pet directory.');
  const info = statSync(image); if (!info.isFile() || !info.size || info.size > LIMIT) throw new Error('The sprite image must be a regular file no larger than 20 MiB.');
  const size = dimensions(readFileSync(image)), expectedHeight = manifest.spriteVersionNumber === 2 ? 2288 : 1872;
  if (size.width !== 1536 || size.height !== expectedHeight) throw new Error('The sprite atlas dimensions do not match its version.');
  return { valid: true, directory: root, displayName: manifest.displayName, spriteVersion: manifest.spriteVersionNumber, ...size };
}
module.exports = { validate };
if (require.main === module) {
  try {
    const args = process.argv.slice(2), version = args[1] === '--version' && [1, 2].includes(Number(args[2])) ? Number(args[2]) : undefined;
    if (!args[0] || args.length !== 1 && !(args.length === 3 && version)) throw new Error('Usage: node validate-pet.cjs <pet-directory> [--version 1|2]');
    process.stdout.write(JSON.stringify(validate(args[0], version)) + '\n');
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
}
