import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Json } from '../ipc/contract';

/** Replace credentials without exposing a truncated file or widening its permissions. */
export function writePrivateJson(path: string, value: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  const pending = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(pending, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
}
