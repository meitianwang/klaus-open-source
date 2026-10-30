import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Json } from '../ipc/contract';

export type Data = { [key: string]: Json };
export function record(value: unknown): Data { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}; }
export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} is required.`);
  return value;
}
export function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function inside(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== '' && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\') && !isAbsolute(suffix); }

/** Both the lexical path and its current filesystem target must stay in scope. */
export function scopedPath(root: string, input: unknown, suffix: string, mustExist = true): string {
  const path = text(input, 'file path');
  if (!isAbsolute(path) || !path.endsWith(suffix) || !inside(resolve(root), resolve(path))) throw new Error('The file is outside this visual artifact directory.');
  const canonicalRoot = realpathSync(root);
  if (mustExist) {
    const canonical = realpathSync(path);
    if (!inside(canonicalRoot, canonical) || !lstatSync(canonical).isFile()) throw new Error('The file is not a regular visual artifact in its directory.');
  } else if (!inside(canonicalRoot, realpathSync(dirname(path))) && realpathSync(dirname(path)) !== canonicalRoot) {
    throw new Error('The destination directory escaped the visual artifact directory.');
  }
  return resolve(path);
}

export function readBounded(path: string, maxBytes = 4 * 1024 * 1024): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`The artifact must be a regular file smaller than ${maxBytes} bytes.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}

export function writeAtomic(path: string, value: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
