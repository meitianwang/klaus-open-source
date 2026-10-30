import { antigravityMediaExtension } from './antigravity-input';
// The content-addressed media pool.
//
// Ported from the retired Rust shell's `media.rs` (readable with
// `git show c743c126^:apps/tauri/crates/klaus-shell/src/media.rs`). This is the seam that keeps
// megabytes of base64 out of the renderer: what crosses to the page is a PATH plus a MIME
// type, never bytes. Transcripts are re-rendered whole and memoized by their own text, so a
// data URL in that payload would be cached, re-parsed and held once per session, while a path
// is a few dozen bytes the media channel resolves on demand.
//
// WHY THIS IS P1 AND NOT P2. Plan §10 assigns the storage boundary to P2, and it would be
// reasonable to expect this to be native work. It is not: the pool is `fs` plus SHA-256 over
// bytes, both of which Node has built in, and `session:history` — which P1 must implement,
// since §10 P1 names 恢复 (resume) — cannot project an image or PDF block without it. So the
// POOL is ported here and the SERVE side (the `klaus-media:` custom protocol handler, range
// requests, and the session path scope check) is P2/P3 work that reads these same files.
//
// THE NAME IS THE CONTENT HASH, which makes storing idempotent: re-storing identical bytes is
// a no-op returning the same path, and an existing file is never rewritten. New entries are
// published by atomic rename only after the complete temporary file has been synced.
//
// Unknown declared types retain the existing sniff-or-refuse behavior. Native
// source-specific media uses its explicit storage adapter below.

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { configRootFrom } from './config-root';

/**
 * The extension/MIME whitelist (`media.rs:ALLOWED`).
 *
 * Order matters for one reason: `extensionForMime` returns the FIRST entry claiming a MIME,
 * so `image/jpeg` writes `.jpg` rather than `.jpeg`. Reordering this table would change the
 * names of newly pooled files, which is harmless for existing ones (they keep their names) but
 * would make the same image pool twice under two extensions.
 */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['avif', 'image/avif'],
  ['ico', 'image/x-icon'],
  ['svg', 'image/svg+xml'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['m4v', 'video/x-m4v'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['pdf', 'application/pdf'],
];

/** `mime_for_extension` (`media.rs:72-80`). */
export function mimeForExtension(extension: string): string | undefined {
  const lowered = extension.toLowerCase();
  return ALLOWED.find(([ext]) => ext === lowered)?.[1];
}

/** `extension_for_mime` (`media.rs:82-89`): the first whitelist entry claiming this MIME. */
export function extensionForMime(mime: string): string | undefined {
  const lowered = mime.trim().toLowerCase();
  return ALLOWED.find(([, candidate]) => candidate === lowered)?.[0];
}

/**
 * Magic-number sniffing for the formats a producer may hand over without a declared type
 * (`media.rs:128-142`).
 *
 * Deliberately narrow: this is a FALLBACK, not a detector. Adding a format here means adding
 * a way for unlabelled bytes to be written into the pool, so the bar is "a producer we know
 * omits the MIME", not "a format that exists".
 */
export function sniffMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (
    bytes.length > 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  const head = bytes.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return undefined;
}

/** The first 8 bytes of a digest as lowercase hex — the pooled file's name (`hex16`). */
function hex16(digest: Buffer): string {
  return digest.subarray(0, 8).toString('hex');
}

/** The pool directory: `config_root/media` (`media.rs:91-93`). */
export function poolDir(configRoot: string = configRootFrom()): string {
  return join(configRoot, 'media');
}

/**
 * Write bytes into the pool and return the path (`store_bytes`, `media.rs:103-126`).
 *
 * `mime` comes from the producer when it knows it (an engine image block, an
 * image-generation response); otherwise the bytes are sniffed. An unsupported type is an
 * error rather than a guess — see the header.
 *
 * Idempotent by construction: the name is the content hash, so identical bytes resolve to
 * the same path and an existing file is never rewritten.
 */
export function storeBytes(
  bytes: Buffer,
  mime: string | undefined,
  configRoot: string = configRootFrom(),
): string {
  return storeBytesWithType(bytes, mime, configRoot, extensionForMime);
}

export function storeAntigravityMediaBytes(bytes: Buffer, mime: string | undefined, configRoot: string = configRootFrom()): string {
  return storeBytesWithType(bytes, mime, configRoot, value => extensionForMime(value) ?? antigravityMediaExtension(value, extensionForMime));
}

function storeBytesWithType(bytes: Buffer, mime: string | undefined, configRoot: string, extensionForType: (mime: string) => string | undefined): string {
  if (bytes.length === 0) throw new Error('empty media payload');

  const trimmed = mime?.trim();
  // The producer's MIME is trusted only when the whitelist knows it; an unknown declared type
  // falls through to sniffing rather than being written under a guessed extension.
  const declared =
    trimmed !== undefined && trimmed.length > 0 && extensionForType(trimmed) !== undefined
      ? trimmed.toLowerCase()
      : undefined;
  const resolved = declared ?? sniffMime(bytes);
  if (resolved === undefined) throw new Error('unsupported media type');

  const extension = extensionForType(resolved);
  if (extension === undefined) throw new Error('unsupported media type');

  const digest = createHash('sha256').update(bytes).digest();
  const name = `${hex16(digest)}.${extension}`;
  const dir = poolDir(configRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  if (!existsSync(path)) {
    const temporary = join(dir, '.' + randomUUID() + '.tmp');
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  return path;
}

/**
 * Store the payload of a `data:<mime>;base64,<data>` URL and return its pooled path
 * (`store_data_url`, `media.rs:155-168`).
 *
 * Dynamic tools answer with images as data URLs, so this is the seam that keeps a megabyte of
 * base64 from riding an event into the renderer.
 *
 * Only base64 data URLs are supported: a percent-encoded payload would need decoding and
 * re-encoding to normalize, and no producer here sends one.
 */
export function storeDataUrl(url: string, configRoot: string = configRootFrom()): string {
  if (!url.startsWith('data:')) throw new Error('not a data URL');
  const comma = url.indexOf(',');
  if (comma === -1) throw new Error('data URL has no payload');
  const metadata = url.slice('data:'.length, comma);
  const payload = url.slice(comma + 1);
  if (!metadata.endsWith(';base64')) throw new Error('only base64 data URLs are supported');
  const mime = metadata.slice(0, -';base64'.length);
  const bytes = Buffer.from(payload.trim(), 'base64');
  return storeBytes(bytes, mime.length > 0 ? mime : undefined, configRoot);
}

/**
 * `saved_paths_from_text` (`host_tools.rs`).
 *
 * A generating tool's `Saved:` line names the files it wrote into the session workspace.
 * The media projectors pair those references with returned image bytes in order, preserving
 * source aliases while the transcript displays an immutable pooled copy.
 *
 * Each marker consumes one line. Following URLs or accessibility text are not
 * part of a filename. JSON strings/arrays preserve commas and spaces in paths;
 * legacy comma-separated producers remain readable.
 */
export function savedPathReferencesFromText(text: string): Array<{ path: string; exact: boolean }> {
  const paths: Array<{ path: string; exact: boolean }> = [];
  for (const match of text.matchAll(/Saved: ([^\r\n]*)/g)) {
    const value = match[1]!.trim();
    if (value.startsWith('"') || value.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(value);
        for (const path of Array.isArray(parsed) ? parsed : [parsed]) {
          paths.push({ path: typeof path === 'string' && !/[\u0000-\u001f\u007f]/.test(path) ? path : '', exact: true });
        }
      } catch { /* An invalid quoted path is not a file capability. */ }
    } else paths.push(...value.split(',').map(path => path.trim()).filter(Boolean).map(path => ({ path, exact: false })));
  }
  return paths;
}

export function savedPathsFromText(text: string): string[] {
  return savedPathReferencesFromText(text).map(entry => entry.path).filter(Boolean);
}

/** Read a pooled file, for the serve side and for tests. */
export function readPooled(path: string): Buffer {
  return readFileSync(path);
}

/** A producer-provided embed avoids asking the model to reconstruct capture identifiers. */
export function savedImageMarkdown(path: string): string {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('Invalid saved image path');
  return `![UI verification](<${pathToFileURL(path).href}>)`;
}
