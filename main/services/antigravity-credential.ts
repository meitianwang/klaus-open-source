import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from './service-types';

const MAX_CREDENTIAL_BYTES = 128 * 1024;
/** Recent builds wrap the token document in a printable envelope inside the login keychain. */
const KEYCHAIN_ENVELOPE_PREFIX = 'go-keyring-base64:';

/** One keychain read verdict from the native credential store. */
export interface AntigravityKeychainRead {
  present: boolean;
  raw?: string;
  error?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 * 1024 && /^[\x21-\x7e]+$/.test(value);
}

function accountLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value) ? value : undefined;
}

/** Validate one token document; both stores carry the same schema family. */
function credentialFromDocument(data: Record<string, unknown>): JsonObject {
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
      const email = accountLabel(claims.email);
      if (email) credential.account = email;
    } catch { /* The cloud account remains usable without a display claim. */ }
  }
  // The keychain document carries the display email in the clear instead of an ID token.
  if (typeof credential.account !== 'string') {
    const email = accountLabel(data.id_token_email);
    if (email) credential.account = email;
  }
  return credential;
}

function credentialFromRaw(raw: string): JsonObject {
  try {
    const enveloped = raw.startsWith(KEYCHAIN_ENVELOPE_PREFIX);
    const body = enveloped ? raw.slice(KEYCHAIN_ENVELOPE_PREFIX.length) : raw;
    if (enveloped && !/^[A-Za-z0-9+/=\s]+$/.test(body)) throw new Error('not base64');
    const decoded = enveloped ? Buffer.from(body, 'base64').toString('utf8') : body;
    return credentialFromDocument(record(JSON.parse(decoded)));
  } catch (error) {
    if (error instanceof Error && error.message === 'antigravity_auth_method_unsupported') throw error;
    throw new Error('antigravity_local_unreadable');
  }
}

/** Older builds left the token document as a standalone file beside the agent state. */
async function readAntigravityFileCredential(home: string): Promise<JsonObject> {
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
    return credentialFromDocument(record(JSON.parse(buffer.subarray(0, length).toString('utf8'))));
  } catch (error) {
    if (error instanceof Error && error.message === 'antigravity_auth_method_unsupported') throw error;
    throw new Error('antigravity_local_unreadable');
  } finally { await file.close(); }
}

/** Read the authorized local login: the keychain entry recent builds write first, the standalone file as fallback. */
export async function readAntigravityCredential(home = homedir(), keychain?: () => Promise<AntigravityKeychainRead>): Promise<JsonObject> {
  let keychainError: string | undefined;
  if (keychain) {
    const read = await keychain();
    if (read.present && typeof read.raw === 'string') return credentialFromRaw(read.raw);
    if (read.present && typeof read.error === 'string' && read.error.length > 0) keychainError = read.error;
  }
  try {
    return await readAntigravityFileCredential(home);
  } catch (error) {
    // A refused keychain read is the actionable verdict when the fallback file is simply absent.
    if (keychainError !== undefined && error instanceof Error && error.message === 'antigravity_local_not_found') throw new Error(keychainError);
    throw error;
  }
}
