import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from './service-types';

const MAX_CREDENTIAL_BYTES = 128 * 1024;
const opaque = (value: unknown, max = 32 * 1024): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);

/** Copy the active Kiro grant without modifying or refreshing its external store. */
export async function readKiroCredential(home = homedir()): Promise<JsonObject> {
  let file;
  try {
    file = await open(join(home, '.aws', 'sso', 'cache', 'kiro-auth-token.json'), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'kiro_local_not_found' : 'kiro_local_unreadable');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) throw new Error('kiro_local_unreadable');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_CREDENTIAL_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, null);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > stat.size || length > MAX_CREDENTIAL_BYTES) throw new Error('kiro_local_unreadable');
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('kiro_local_unreadable');
    const row = value as Record<string, unknown>;
    if (!opaque(row.accessToken) || !opaque(row.authMethod, 32) || !opaque(row.provider, 64)) throw new Error('kiro_local_unreadable');
    if (typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))) throw new Error('kiro_local_unreadable');
    if (Date.parse(row.expiresAt) <= Date.now()) throw new Error('kiro_local_expired');
    if (row.region !== undefined && (typeof row.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(row.region))) throw new Error('kiro_local_unreadable');
    return {
      accessToken: row.accessToken, authMethod: row.authMethod, provider: row.provider,
      expiresAt: row.expiresAt,
      ...(opaque(row.refreshToken) ? { refreshToken: row.refreshToken } : {}),
      ...(opaque(row.profileArn, 2048) ? { profileArn: row.profileArn } : {}),
      ...(typeof row.region === 'string' ? { region: row.region } : {}),
      account: `Kiro · ${row.provider}`,
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'kiro_local_expired') throw error;
    throw new Error('kiro_local_unreadable');
  } finally { await file.close(); }
}
