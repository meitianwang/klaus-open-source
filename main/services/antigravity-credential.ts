import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from './service-types';

const MAX_CREDENTIAL_BYTES = 128 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 * 1024 && /^[\x21-\x7e]+$/.test(value);
}

/** Read only the authorized local login; never return the source document or ID token. */
export async function readAntigravityCredential(home = homedir()): Promise<JsonObject> {
  let file;
  try { file = await open(join(home, '.gemini', 'jetski-standalone-oauth-token'), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'antigravity_local_not_found' : 'antigravity_local_unreadable');
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) throw new Error('antigravity_local_unreadable');
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_CREDENTIAL_BYTES) throw new Error('antigravity_local_unreadable');
    const data = record(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    if (data.auth_method !== 'consumer') throw new Error('antigravity_auth_method_unsupported');
    const saved = record(data.token);
    if (!token(saved.access_token) || (saved.refresh_token !== undefined && !token(saved.refresh_token))) throw new Error('antigravity_local_unreadable');
    const credential: JsonObject = { accessToken: saved.access_token, authMethod: 'consumer' };
    if (saved.refresh_token !== undefined) credential.refreshToken = saved.refresh_token;
    if (saved.expiry !== undefined) {
      const expiry = typeof saved.expiry === 'string' && /^\d{4}-\d\d-\d\dT/.test(saved.expiry) ? Date.parse(saved.expiry) : NaN;
      if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new Error('antigravity_local_unreadable');
      credential.expiresAt = expiry;
    }
    // An unverified ID-token claim is used only as a display label, never as authority.
    if (typeof data.id_token === 'string' && data.id_token.length <= 64 * 1024) {
      try {
        const claims = record(JSON.parse(Buffer.from(data.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')));
        if (typeof claims.email === 'string' && claims.email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(claims.email)) credential.account = claims.email;
      } catch { /* The cloud account remains usable without a display claim. */ }
    }
    return credential;
  } catch (error) {
    if (error instanceof Error && error.message === 'antigravity_auth_method_unsupported') throw error;
    throw new Error('antigravity_local_unreadable');
  } finally { await file.close(); }
}
