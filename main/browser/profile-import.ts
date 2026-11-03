/**
 * Bounded import of local data from a Chromium-family profile.
 *
 * Every database is copied to a disposable snapshot before it is opened. The
 * original profile is only ever read: Preferences and SecurePreferences are
 * never opened or written, and extension packages are copied into an
 * app-owned directory before the target install callback runs.
 *
 * The host injects the source roots, the platform secret decryptor and the
 * browser target. This module deliberately has no OS keychain or CEF
 * dependency of its own.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BROWSER_IMPORT_DEFAULT_LIMITS,
  BROWSER_IMPORT_DEFAULT_SELECTION,
  BrowserImportDecryptError,
  browserImportHostnameAllowed,
  validateBrowserImportRequest,
  type BrowserCookieSameSite,
  type BrowserImportCookie,
  type BrowserImportCounts,
  type BrowserImportDependencies,
  type BrowserImportExtension,
  type BrowserImportHistoryEntry,
  type BrowserImportIssue,
  type BrowserImportLimits,
  type BrowserImportPassword,
  type BrowserImportRequest,
  type BrowserImportResult,
  type BrowserImportSelection,
  type BrowserProfileCandidate,
} from '../../contracts/browser-import';
import { discoverBrowserProfiles, resolveCookieDatabase, type CookieDatabaseLocation } from './profile-discovery';
import { BrowserError } from './types';

const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000n;
const MAX_ISSUES = 64;
const MAX_SECRET_LENGTH = 16 * 1024;
const MAX_EXTENSION_MANIFEST_BYTES = 1024 * 1024;
const EXTENSION_ID = /^[a-p]{32}$/u;
const EXTENSION_VERSION = /^[0-9]+(?:\.[0-9]+){0,7}$/u;
const LIMIT_BOUNDS: Record<keyof BrowserImportLimits, number> = {
  maxCookieRows: 1_000_000,
  maxLoginRows: 1_000_000,
  maxHistoryRows: 1_000_000,
  maxExtensions: 10_000,
  maxExtensionFiles: 100_000,
  maxExtensionBytes: 4 * 1024 * 1024 * 1024,
  maxDatabaseBytes: 4 * 1024 * 1024 * 1024,
};

class ImportAbortedError extends Error {
  constructor() {
    super('The browser import was cancelled.');
    this.name = 'ImportAbortedError';
  }
}

class ExtensionCopyLimitError extends Error {
  constructor(readonly code: 'extension_file_limit' | 'extension_size_limit') {
    super(code === 'extension_file_limit'
      ? 'The extension exceeds the file-count limit.'
      : 'The extension exceeds the total-size limit.');
    this.name = 'ExtensionCopyLimitError';
  }
}

function emptyCounts(): BrowserImportCounts {
  return { cookies: 0, passwords: 0, history: 0, extensions: 0 };
}

function failure(
  request: Pick<BrowserImportRequest, 'sourceId' | 'profileId'>,
  code: string,
  message: string,
  category: BrowserImportIssue['category'] = 'profile',
): BrowserImportResult {
  return {
    ok: false,
    cancelled: false,
    sourceId: typeof request.sourceId === 'string' ? request.sourceId : '',
    profileId: typeof request.profileId === 'string' ? request.profileId : '',
    counts: emptyCounts(),
    errors: [{ category, code, message }],
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportAbortedError();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : undefined;
  }
  if (typeof value === 'string' && /^[0-9]+$/u.test(value)) {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : undefined;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === 1n;
}

function bytesValue(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

function chromeTimeToUnixMillis(value: unknown): number | undefined {
  const numeric = typeof value === 'bigint' ? value : (() => {
    const number = numberValue(value);
    return number === undefined || number < 0 ? undefined : BigInt(Math.trunc(number));
  })();
  if (numeric === undefined || numeric <= 0n) return undefined;
  const milliseconds = numeric / 1000n - CHROME_EPOCH_OFFSET_MS;
  if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(milliseconds);
}

function sameSiteValue(value: unknown): BrowserCookieSameSite {
  const numeric = numberValue(value);
  if (numeric === 0) return 'no_restriction';
  if (numeric === 1) return 'lax';
  if (numeric === 2) return 'strict';
  return 'unspecified';
}

function normalizedLimit(value: unknown, fallback: number, label: keyof BrowserImportLimits): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > LIMIT_BOUNDS[label]) {
    throw new BrowserError('invalid_request', `${label} must be a positive integer within the supported bound.`);
  }
  return value;
}

function resolvedLimits(limits: BrowserImportLimits | undefined): Required<BrowserImportLimits> {
  return {
    maxCookieRows: normalizedLimit(limits?.maxCookieRows, BROWSER_IMPORT_DEFAULT_LIMITS.maxCookieRows, 'maxCookieRows'),
    maxLoginRows: normalizedLimit(limits?.maxLoginRows, BROWSER_IMPORT_DEFAULT_LIMITS.maxLoginRows, 'maxLoginRows'),
    maxHistoryRows: normalizedLimit(limits?.maxHistoryRows, BROWSER_IMPORT_DEFAULT_LIMITS.maxHistoryRows, 'maxHistoryRows'),
    maxExtensions: normalizedLimit(limits?.maxExtensions, BROWSER_IMPORT_DEFAULT_LIMITS.maxExtensions, 'maxExtensions'),
    maxExtensionFiles: normalizedLimit(limits?.maxExtensionFiles, BROWSER_IMPORT_DEFAULT_LIMITS.maxExtensionFiles, 'maxExtensionFiles'),
    maxExtensionBytes: normalizedLimit(limits?.maxExtensionBytes, BROWSER_IMPORT_DEFAULT_LIMITS.maxExtensionBytes, 'maxExtensionBytes'),
    maxDatabaseBytes: normalizedLimit(limits?.maxDatabaseBytes, BROWSER_IMPORT_DEFAULT_LIMITS.maxDatabaseBytes, 'maxDatabaseBytes'),
  };
}

function issueSink(): { errors: BrowserImportIssue[]; add: (category: BrowserImportIssue['category'], code: string, message: string, count?: number) => void } {
  const errors: BrowserImportIssue[] = [];
  const byKey = new Map<string, BrowserImportIssue>();
  return {
    errors,
    add(category, code, message, count = 1) {
      const key = `${category}\0${code}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count = (existing.count ?? 1) + count;
        return;
      }
      if (byKey.size >= MAX_ISSUES) return;
      const issue: BrowserImportIssue = { category, code, message, ...(count > 1 ? { count } : {}) };
      byKey.set(key, issue);
      errors.push(issue);
    },
  };
}

function appliedBatchCount(receipt: unknown, submitted: number): number {
  if (receipt === undefined) return submitted;
  const applied = receipt !== null && typeof receipt === 'object' && 'applied' in receipt
    ? (receipt as { applied: unknown }).applied : undefined;
  if (typeof applied !== 'number' || !Number.isSafeInteger(applied) || applied < 0 || applied > submitted) {
    throw new BrowserError('invalid_target_result', 'The browser target returned an invalid applied count.');
  }
  return applied;
}

function safeTargetError(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z0-9_]+$/u.test(code)) return code;
  }
  return 'target_error';
}

/**
 * Read integer columns as bigints. Chromium timestamps exceed JavaScript's
 * safe integer range, and node:sqlite rejects such values unless the statement
 * opts into bigint reads.
 */
function queryRows<T>(database: DatabaseSync, sql: string, ...parameters: Array<number | bigint | string | null>): T[] {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all(...parameters) as unknown as T[];
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isSafeDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function isWithinRoot(rootReal: string, candidateReal: string): boolean {
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  return candidateReal === rootReal || candidateReal.startsWith(prefix);
}

async function resolveProfileDirectory(dependencies: BrowserImportDependencies, candidate: BrowserProfileCandidate): Promise<string | undefined> {
  const source = dependencies.roots.find(root => root.id === candidate.sourceId);
  if (!source) return undefined;
  try {
    const rootReal = await realpath(source.userDataDir);
    const profileReal = await realpath(join(rootReal, candidate.profileId));
    if (!isWithinRoot(rootReal, profileReal)) return undefined;
    return profileReal;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------------- *
 * Stable SQLite snapshots
 * ------------------------------------------------------------------------- */

async function fileSignature(path: string): Promise<string> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile()) return 'missing';
    return `${info.size}:${info.mtimeNs}:${info.ino}`;
  } catch {
    return 'missing';
  }
}

async function databaseSignature(path: string): Promise<string> {
  return [
    await fileSignature(path),
    await fileSignature(`${path}-wal`),
    await fileSignature(`${path}-shm`),
  ].join('|');
}

async function databaseTotalBytes(path: string): Promise<number> {
  let total = 0;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const info = await lstat(candidate);
      if (info.isFile()) total += info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return total;
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  try {
    const info = await lstat(source);
    if (!info.isFile()) {
      await rm(target, { force: true });
      return;
    }
    await copyFile(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await rm(target, { force: true });
      return;
    }
    throw error;
  }
}

async function copyStableDatabase(
  source: string,
  target: string,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<void> {
  if (!(await isRegularFile(source))) {
    throw new BrowserError('database_unavailable', 'The requested browser database is not available.');
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    const totalBytes = await databaseTotalBytes(source);
    if (totalBytes > maxBytes) {
      throw new BrowserError('database_too_large', 'The browser database exceeds the configured size limit.');
    }
    const before = await databaseSignature(source);
    await copyFile(source, target);
    await copyIfPresent(`${source}-wal`, `${target}-wal`);
    await copyIfPresent(`${source}-shm`, `${target}-shm`);
    if (await databaseTotalBytes(target) > maxBytes) {
      throw new BrowserError('database_too_large', 'The browser database exceeds the configured size limit.');
    }
    const after = await databaseSignature(source);
    if (before === after) return;
    await rm(target, { force: true });
    await rm(`${target}-wal`, { force: true });
    await rm(`${target}-shm`, { force: true });
  }
  throw new BrowserError('snapshot_unstable', 'The browser database changed while it was being copied.');
}

async function withDatabaseSnapshot<T>(
  source: string,
  tempRoot: string,
  signal: AbortSignal | undefined,
  maxBytes: number,
  work: (database: DatabaseSync) => T | Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    const directory = await mkdtemp(join(tempRoot, 'snapshot-'));
    const target = join(directory, basename(source));
    let database: DatabaseSync | undefined;
    try {
      await copyStableDatabase(source, target, signal, maxBytes);
      try {
        database = new DatabaseSync(target);
        database.exec('PRAGMA busy_timeout = 3000');
        const rows = database.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>;
        if (rows[0]?.quick_check !== 'ok') {
          throw new BrowserError('snapshot_corrupted', 'The browser database snapshot failed its integrity check.');
        }
      } catch (error) {
        if (error instanceof ImportAbortedError) throw error;
        throw error instanceof BrowserError
          ? error
          : new BrowserError('snapshot_corrupted', 'The browser database snapshot could not be read or verified.');
      }
      database.exec('PRAGMA query_only = ON');
      return await work(database);
    } catch (error) {
      if (error instanceof ImportAbortedError) throw error;
      if (error instanceof BrowserError && (error.code === 'snapshot_unstable' || error.code === 'snapshot_corrupted')) {
        lastError = error;
        continue;
      }
      throw error;
    } finally {
      database?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  throw lastError ?? new BrowserError('snapshot_corrupted', 'The browser database snapshot could not be made consistent.');
}

/* ------------------------------------------------------------------------- *
 * Category readers
 * ------------------------------------------------------------------------- */

interface CookieRow {
  host_key?: unknown;
  name?: unknown;
  value?: unknown;
  encrypted_value?: unknown;
  path?: unknown;
  expires_utc?: unknown;
  has_expires?: unknown;
  is_secure?: unknown;
  is_httponly?: unknown;
  samesite?: unknown;
  top_frame_site_key?: unknown;
  has_cross_site_ancestor?: unknown;
}

interface CookieSnapshot {
  rows: CookieRow[];
  metaVersion?: number;
  hasTopFrameSiteKey: boolean;
  hasCrossSiteAncestor: boolean;
}

interface LoginRow {
  origin_url?: unknown;
  username_value?: unknown;
  password_value?: unknown;
}

interface HistoryRow {
  url?: unknown;
  title?: unknown;
  visit_time?: unknown;
}

function decryptErrorCode(error: unknown): string | undefined {
  if (error instanceof BrowserImportDecryptError) return error.code;
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z0-9_]+$/u.test(code)) return code;
  }
  return undefined;
}

async function decryptSecret(
  dependencies: BrowserImportDependencies,
  bytes: Uint8Array,
  context: {
    kind: 'cookie' | 'password';
    host?: string;
    originUrl?: string;
    family?: 'chrome' | 'chromium' | 'edge';
    database?: { version?: number; layout?: 'legacy' | 'network' };
  },
): Promise<string> {
  try {
    const plain = await dependencies.decryptor.decrypt(bytes, { ...context, platform: process.platform });
    if (typeof plain !== 'string' || plain.length > MAX_SECRET_LENGTH) {
      throw new BrowserError('decrypt_invalid', 'The decryption adapter returned an unsupported value.');
    }
    return plain;
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    const code = decryptErrorCode(error) ?? 'decryption_failed';
    throw new BrowserImportDecryptError(code, 'The decryption adapter could not decrypt the value.');
  }
}

async function readCookies(
  dependencies: BrowserImportDependencies,
  profileDirectory: string,
  limits: Required<BrowserImportLimits>,
  allowlist: readonly string[] | undefined,
  errors: ReturnType<typeof issueSink>,
  sourceFamily: 'chrome' | 'chromium' | 'edge' | undefined,
): Promise<BrowserImportCookie[]> {
  const resolution = await resolveCookieDatabase(profileDirectory);
  if (resolution.error) {
    errors.add('cookies', resolution.error.code, resolution.error.message);
    return [];
  }
  const cookieDatabase: CookieDatabaseLocation | undefined = resolution.location;
  if (!cookieDatabase) {
    errors.add('cookies', 'cookies_unavailable', 'The profile has no readable cookie database.');
    return [];
  }

  let snapshot: CookieSnapshot;
  try {
    snapshot = await withDatabaseSnapshot(
      cookieDatabase.path,
      dependencies.tempRoot ?? join(tmpdir(), 'klaus-browser-import'),
      dependencies.signal,
      limits.maxDatabaseBytes,
      database => {
        const columns = new Set(
          queryRows<{ name?: unknown }>(database, 'PRAGMA table_info(cookies)')
            .map(row => stringValue(row.name))
            .filter((name): name is string => Boolean(name)),
        );
        const hasTopFrameSiteKey = columns.has('top_frame_site_key');
        const hasCrossSiteAncestor = columns.has('has_cross_site_ancestor');
        const extras = [
          hasTopFrameSiteKey ? 'top_frame_site_key' : 'NULL AS top_frame_site_key',
          hasCrossSiteAncestor ? 'has_cross_site_ancestor' : 'NULL AS has_cross_site_ancestor',
        ].join(', ');
        const rows = queryRows<CookieRow>(
          database,
          `SELECT host_key, name, value, encrypted_value, path, expires_utc, has_expires,
            is_secure, is_httponly, samesite, ${extras} FROM cookies LIMIT ?`,
          limits.maxCookieRows + 1,
        );
        let metaVersion: number | undefined;
        const metaTables = queryRows<{ name?: unknown }>(
          database,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
        );
        if (metaTables.length > 0) {
          const meta = queryRows<{ value?: unknown }>(
            database,
            "SELECT value FROM meta WHERE key = 'version' LIMIT 1",
          );
          metaVersion = numberValue(meta[0]?.value);
        }
        return { rows, metaVersion, hasTopFrameSiteKey, hasCrossSiteAncestor };
      },
    );
  } catch (error) {
    if (error instanceof ImportAbortedError) throw error;
    if (error instanceof BrowserError && ['snapshot_unstable', 'snapshot_corrupted', 'database_unavailable', 'database_too_large'].includes(error.code)) {
      errors.add('cookies', error.code, error.message);
    } else {
      errors.add('cookies', 'cookies_unreadable', 'The cookie database could not be read.');
    }
    return [];
  }

  let rows = snapshot.rows;
  if (rows.length > limits.maxCookieRows) {
    const omitted = rows.length - limits.maxCookieRows;
    rows = rows.slice(0, limits.maxCookieRows);
    errors.add('cookies', 'cookie_row_limit', 'The cookie database exceeds the configured row limit.', omitted);
  }

  const cookies: BrowserImportCookie[] = [];
  let decryptionFailures = 0;
  for (const row of rows) {
    throwIfAborted(dependencies.signal);
    const domain = stringValue(row.host_key) ?? '';
    if (!domain || !browserImportHostnameAllowed(domain, allowlist)) continue;
    const name = stringValue(row.name) ?? '';
    const pathValue = stringValue(row.path) || '/';
    if (!name || !pathValue) continue;

    let value = stringValue(row.value) ?? '';
    const encrypted = bytesValue(row.encrypted_value);
    if (!value && encrypted && encrypted.byteLength > 0) {
      try {
        value = await decryptSecret(dependencies, encrypted, {
          kind: 'cookie',
          host: domain,
          ...(sourceFamily ? { family: sourceFamily } : {}),
          database: {
            ...(snapshot.metaVersion === undefined ? {} : { version: snapshot.metaVersion }),
            layout: cookieDatabase.layout,
          },
        });
      } catch (error) {
        if (dependencies.signal?.aborted || (error instanceof BrowserImportDecryptError && error.code === 'cancelled')) {
          throw new ImportAbortedError();
        }
        decryptionFailures += 1;
        if (error instanceof BrowserImportDecryptError && error.code !== 'decryption_failed') {
          errors.add('cookies', error.code, 'The browser decryptor rejected a cookie value.');
        }
        continue;
      }
    }

    const expiry = row.has_expires === undefined || booleanValue(row.has_expires)
      ? chromeTimeToUnixMillis(row.expires_utc)
      : undefined;
    const topFrameSiteKey = snapshot.hasTopFrameSiteKey ? stringValue(row.top_frame_site_key) : undefined;
    const hasCrossSiteAncestor = snapshot.hasCrossSiteAncestor
      && row.has_cross_site_ancestor !== null
      && row.has_cross_site_ancestor !== undefined
      ? booleanValue(row.has_cross_site_ancestor)
      : undefined;
    cookies.push({
      domain,
      path: pathValue,
      name,
      value,
      httpOnly: booleanValue(row.is_httponly),
      secure: booleanValue(row.is_secure),
      sameSite: sameSiteValue(row.samesite),
      ...(expiry === undefined ? {} : { expiresAt: expiry }),
      ...(topFrameSiteKey ? { topFrameSiteKey } : {}),
      ...(hasCrossSiteAncestor === undefined ? {} : { hasCrossSiteAncestor }),
    });
  }
  if (decryptionFailures > 0) {
    errors.add('cookies', 'cookie_decryption_failed', 'Some cookies could not be decrypted and were skipped.', decryptionFailures);
  }
  return cookies;
}

async function readPasswords(
  dependencies: BrowserImportDependencies,
  profileDirectory: string,
  limits: Required<BrowserImportLimits>,
  errors: ReturnType<typeof issueSink>,
  sourceFamily: 'chrome' | 'chromium' | 'edge' | undefined,
): Promise<BrowserImportPassword[]> {
  const path = join(profileDirectory, 'Login Data');
  if (!(await isRegularFile(path))) {
    errors.add('passwords', 'passwords_unavailable', 'The profile has no readable login database.');
    return [];
  }
  let rows: LoginRow[];
  try {
    rows = await withDatabaseSnapshot(path, dependencies.tempRoot ?? join(tmpdir(), 'klaus-browser-import'), dependencies.signal, limits.maxDatabaseBytes, database =>
      queryRows<LoginRow>(database, `SELECT origin_url, username_value, password_value FROM logins
        WHERE blacklisted_by_user = 0 AND length(password_value) > 0 LIMIT ?`, limits.maxLoginRows + 1));
  } catch (error) {
    if (error instanceof ImportAbortedError) throw error;
    if (error instanceof BrowserError && ['snapshot_unstable', 'snapshot_corrupted', 'database_unavailable', 'database_too_large'].includes(error.code)) {
      errors.add('passwords', error.code, error.message);
    } else {
      errors.add('passwords', 'passwords_unreadable', 'The login database could not be read.');
    }
    return [];
  }

  if (rows.length > limits.maxLoginRows) {
    const omitted = rows.length - limits.maxLoginRows;
    rows = rows.slice(0, limits.maxLoginRows);
    errors.add('passwords', 'login_row_limit', 'The login database exceeds the configured row limit.', omitted);
  }

  const passwords: BrowserImportPassword[] = [];
  let decryptionFailures = 0;
  for (const row of rows) {
    throwIfAborted(dependencies.signal);
    const originUrl = stringValue(row.origin_url) ?? '';
    const username = stringValue(row.username_value) ?? '';
    const encrypted = bytesValue(row.password_value);
    if (!originUrl || !encrypted || encrypted.byteLength === 0) continue;
    try {
      const password = await decryptSecret(dependencies, encrypted, {
        kind: 'password',
        originUrl,
        ...(sourceFamily ? { family: sourceFamily } : {}),
      });
      passwords.push({ originUrl, username, password });
    } catch (error) {
      if (dependencies.signal?.aborted || (error instanceof BrowserImportDecryptError && error.code === 'cancelled')) {
        throw new ImportAbortedError();
      }
      decryptionFailures += 1;
      if (error instanceof BrowserImportDecryptError && error.code !== 'decryption_failed') {
        errors.add('passwords', error.code, 'The browser decryptor rejected a saved password.');
      }
    }
  }
  if (decryptionFailures > 0) {
    errors.add('passwords', 'password_decryption_failed', 'Some saved passwords could not be decrypted and were skipped.', decryptionFailures);
  }
  return passwords;
}

async function readHistory(
  dependencies: BrowserImportDependencies,
  profileDirectory: string,
  limits: Required<BrowserImportLimits>,
  errors: ReturnType<typeof issueSink>,
): Promise<BrowserImportHistoryEntry[]> {
  const path = join(profileDirectory, 'History');
  if (!(await isRegularFile(path))) {
    errors.add('history', 'history_unavailable', 'The profile has no readable history database.');
    return [];
  }
  let rows: HistoryRow[];
  try {
    rows = await withDatabaseSnapshot(path, dependencies.tempRoot ?? join(tmpdir(), 'klaus-browser-import'), dependencies.signal, limits.maxDatabaseBytes, database =>
      queryRows<HistoryRow>(database, `SELECT u.url AS url, u.title AS title, v.visit_time AS visit_time
        FROM visits v JOIN urls u ON u.id = v.url ORDER BY v.visit_time ASC LIMIT ?`, limits.maxHistoryRows + 1));
  } catch (error) {
    if (error instanceof ImportAbortedError) throw error;
    if (error instanceof BrowserError && ['snapshot_unstable', 'snapshot_corrupted', 'database_unavailable', 'database_too_large'].includes(error.code)) {
      errors.add('history', error.code, error.message);
    } else {
      errors.add('history', 'history_unreadable', 'The history database could not be read.');
    }
    return [];
  }

  if (rows.length > limits.maxHistoryRows) {
    const omitted = rows.length - limits.maxHistoryRows;
    rows = rows.slice(0, limits.maxHistoryRows);
    errors.add('history', 'history_row_limit', 'The history database exceeds the configured row limit.', omitted);
  }

  const entries: BrowserImportHistoryEntry[] = [];
  let invalidTimestamps = 0;
  for (const row of rows) {
    throwIfAborted(dependencies.signal);
    const url = stringValue(row.url) ?? '';
    const visitedAt = chromeTimeToUnixMillis(row.visit_time);
    if (!url || visitedAt === undefined) {
      invalidTimestamps += 1;
      continue;
    }
    const title = stringValue(row.title)?.trim() || url;
    entries.push({ url, title: title.slice(0, 2_048), visitedAt, source: 'other' });
  }
  if (invalidTimestamps > 0) {
    errors.add('history', 'history_rows_skipped', 'Some history rows had no usable URL or timestamp.', invalidTimestamps);
  }
  return entries;
}

/* ------------------------------------------------------------------------- *
 * Extension copy
 * ------------------------------------------------------------------------- */

interface ExtensionManifest {
  id: string;
  version: string;
  name?: string;
  publicKey?: string;
  idVerified: boolean;
}

const MAX_EXTENSION_KEY_CHARS = 64 * 1024;

function extensionIdFromKey(base64: string): string {
  if (base64.length > MAX_EXTENSION_KEY_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) {
    throw new BrowserError('extension_key_invalid', 'The extension public key is not valid base64.');
  }
  const der = Buffer.from(base64, 'base64');
  if (der.length === 0) throw new BrowserError('extension_key_invalid', 'The extension public key is empty.');
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (let index = 0; index < 16; index += 1) {
    const byte = digest[index]!;
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return id;
}

function safeExtensionName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return name ? name.slice(0, 256) : undefined;
}

async function readExtensionManifest(directory: string, expectedId: string): Promise<ExtensionManifest> {
  const path = join(directory, 'manifest.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new BrowserError('extension_manifest_invalid', 'The extension manifest is not a regular file.');
  if (info.size > MAX_EXTENSION_MANIFEST_BYTES) throw new BrowserError('extension_manifest_too_large', 'The extension manifest exceeds the supported size.');
  const real = await realpath(path);
  if (!isWithinRoot(directory, real)) throw new BrowserError('extension_escape_rejected', 'The extension manifest resolves outside its package.');

  let parsed: Record<string, unknown>;
  try {
    parsed = objectRecord(JSON.parse(await readFile(real, 'utf8')) as unknown);
  } catch {
    throw new BrowserError('extension_manifest_invalid', 'The extension manifest is not valid JSON.');
  }
  const version = stringValue(parsed.version)?.trim() ?? '';
  if (!EXTENSION_VERSION.test(version) || version.length > 64) {
    throw new BrowserError('extension_version_invalid', 'The extension manifest has no supported version.');
  }
  const name = safeExtensionName(parsed.name);
  const key = stringValue(parsed.key)?.trim();
  let publicKey: string | undefined;
  let idVerified = false;
  if (key) {
    const derived = extensionIdFromKey(key);
    if (derived !== expectedId) {
      throw new BrowserError('extension_id_mismatch', 'The extension public key does not match its folder id.');
    }
    publicKey = key;
    idVerified = true;
  }
  return {
    id: expectedId,
    version,
    ...(name ? { name } : {}),
    ...(publicKey ? { publicKey } : {}),
    idVerified,
  };
}

interface CopyBudget {
  files: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
}

async function copyExtensionTree(
  source: string,
  target: string,
  sourceRoot: string,
  budget: CopyBudget,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    throwIfAborted(signal);
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) throw new BrowserError('extension_symlink_rejected', 'The extension package contains a symbolic link.');
    const real = await realpath(sourcePath);
    if (!isWithinRoot(sourceRoot, real)) throw new BrowserError('extension_escape_rejected', 'The extension package escapes its directory.');
    if (info.isDirectory()) {
      await mkdir(targetPath, { recursive: true, mode: 0o700 });
      await copyExtensionTree(sourcePath, targetPath, sourceRoot, budget, signal);
      continue;
    }
    if (!info.isFile()) throw new BrowserError('extension_entry_rejected', 'The extension package contains an unsupported filesystem entry.');
    budget.files += 1;
    budget.bytes += Number(info.size);
    if (budget.files > budget.maxFiles) throw new ExtensionCopyLimitError('extension_file_limit');
    if (budget.bytes > budget.maxBytes) throw new ExtensionCopyLimitError('extension_size_limit');
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  }
}

async function importExtensions(
  dependencies: BrowserImportDependencies,
  profileDirectory: string,
  limits: Required<BrowserImportLimits>,
  errors: ReturnType<typeof issueSink>,
  sourceId: string,
  profileId: string,
  progress: { installed: number },
): Promise<void> {
  if (!dependencies.extensionRoot || !isAbsolute(dependencies.extensionRoot)) {
    errors.add('extensions', 'extension_target_unavailable', 'No app-owned extension directory was provided.');
    return;
  }
  if (!dependencies.target.installExtension) {
    errors.add('extensions', 'extension_install_unavailable', 'The browser target cannot install extensions.');
    return;
  }
  const extensionsDirectory = join(profileDirectory, 'Extensions');
  if (!(await isSafeDirectory(extensionsDirectory))) {
    errors.add('extensions', 'extensions_unavailable', 'The profile has no readable extension directory.');
    return;
  }
  const extensionsReal = await realpath(extensionsDirectory);
  const entries = (await readdir(extensionsReal, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && EXTENSION_ID.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > limits.maxExtensions) {
    errors.add('extensions', 'extension_row_limit', 'The profile exceeds the configured extension limit.', entries.length - limits.maxExtensions);
  }

  const runKey = createHash('sha256').update(`${sourceId}\0${profileId}`).digest('hex').slice(0, 16);
  const ownedRoot = join(dependencies.extensionRoot, runKey);
  await mkdir(ownedRoot, { recursive: true, mode: 0o700 });

  for (const entry of entries.slice(0, limits.maxExtensions)) {
    throwIfAborted(dependencies.signal);
    const sourceDirectory = join(extensionsReal, entry.name);
    let targetDirectory: string | undefined;
    let installedSuccessfully = false;
    try {
      const info = await lstat(sourceDirectory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        errors.add('extensions', 'extension_symlink_rejected', 'An extension directory is a symbolic link and was skipped.');
        continue;
      }
      const sourceReal = await realpath(sourceDirectory);
      if (!isWithinRoot(extensionsReal, sourceReal)) {
        errors.add('extensions', 'extension_escape_rejected', 'An extension directory resolves outside the extensions root.');
        continue;
      }
      const manifest = await readExtensionManifest(sourceReal, entry.name);
      targetDirectory = join(ownedRoot, `${manifest.id}-${manifest.version}`);
      await rm(targetDirectory, { recursive: true, force: true });
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      const budget: CopyBudget = {
        files: 0,
        bytes: 0,
        maxFiles: limits.maxExtensionFiles,
        maxBytes: limits.maxExtensionBytes,
      };
      await copyExtensionTree(sourceReal, targetDirectory, sourceReal, budget, dependencies.signal);
      throwIfAborted(dependencies.signal);
      const extension: BrowserImportExtension = {
        id: manifest.id,
        version: manifest.version,
        ...(manifest.name ? { name: manifest.name } : {}),
        ...(manifest.publicKey ? { publicKey: manifest.publicKey } : {}),
        idVerified: manifest.idVerified,
        path: targetDirectory,
      };
      const installedExtension = await dependencies.target.installExtension(extension);
      const installedId = installedExtension !== undefined && installedExtension !== null
        && typeof installedExtension === 'object' && typeof installedExtension.id === 'string'
        ? installedExtension.id
        : undefined;
      if (installedId !== undefined) {
        if (!EXTENSION_ID.test(installedId) || installedId !== manifest.id) {
          throw new BrowserError('extension_id_mismatch', 'The installed extension id does not match the profile folder id.');
        }
      } else if (!manifest.idVerified) {
        throw new BrowserError('extension_id_unverified', 'The target did not return the installed extension id and the package has no verifiable key.');
      }
      installedSuccessfully = true;
      progress.installed += 1;
      throwIfAborted(dependencies.signal);
    } catch (error) {
      if (targetDirectory && !installedSuccessfully) await rm(targetDirectory, { recursive: true, force: true });
      if (error instanceof ImportAbortedError) throw error;
      if (error instanceof BrowserError) {
        errors.add('extensions', error.code, error.message);
      } else if (error instanceof ExtensionCopyLimitError) {
        errors.add('extensions', error.code, error.message);
      } else {
        errors.add('extensions', 'extension_install_failed', 'An extension could not be installed.');
      }
    }
  }
  return;
}

/* ------------------------------------------------------------------------- *
 * Entry point
 * ------------------------------------------------------------------------- */

function parseRequest(request: BrowserImportRequest): { selection: Required<BrowserImportSelection>; allowlist?: string[] } {
  const validation = validateBrowserImportRequest(request);
  if (!validation.ok) throw new BrowserError(validation.code, validation.message);
  return {
    selection: validation.value.selection,
    ...(validation.value.allowlist ? { allowlist: validation.value.allowlist } : {}),
  };
}

/**
 * Import the requested categories from one profile.
 *
 * The original profile is never written. Category failures are aggregated in
 * the result so a partial import can still report its counts, while `ok` stays
 * false whenever an error or cancellation occurred.
 */
export async function importBrowserProfile(
  request: BrowserImportRequest,
  dependencies: BrowserImportDependencies,
): Promise<BrowserImportResult> {
  let parsed: { selection: Required<BrowserImportSelection>; allowlist?: string[] };
  let limits: Required<BrowserImportLimits>;
  try {
    parsed = parseRequest(request);
    limits = resolvedLimits(dependencies.limits);
  } catch (error) {
    const message = error instanceof BrowserError && error.code === 'extensions_not_confirmed'
      ? error.message
      : 'The browser import request is invalid.';
    const category = error instanceof BrowserError && error.code === 'extensions_not_confirmed' ? 'extensions' : 'profile';
    return failure(request, error instanceof BrowserError ? error.code : 'invalid_request', message, category);
  }

  const sink = issueSink();
  const result: BrowserImportResult = {
    ok: false,
    cancelled: false,
    sourceId: request.sourceId,
    profileId: request.profileId,
    counts: emptyCounts(),
    errors: sink.errors,
  };

  try {
    const discovery = await discoverBrowserProfiles(dependencies.roots, dependencies.signal);
    throwIfAborted(dependencies.signal);
    const candidate = discovery.profiles.find(profile =>
      profile.sourceId === request.sourceId && profile.profileId === request.profileId);
    if (!candidate) {
      const sourceErrors = discovery.errors.filter(issue => issue.sourceId === request.sourceId);
      for (const issue of sourceErrors) sink.add('discovery', issue.code, issue.message);
      sink.add('profile', 'profile_not_found', 'The selected browser profile is no longer available.');
      return result;
    }

    const profileDirectory = await resolveProfileDirectory(dependencies, candidate);
    if (!profileDirectory) {
      sink.add('profile', 'profile_unavailable', 'The selected browser profile can no longer be read.');
      return result;
    }
    const sourceFamily = dependencies.roots.find(root => root.id === request.sourceId)?.family;

    if (parsed.selection.cookies) {
      const cookies = await readCookies(dependencies, profileDirectory, limits, parsed.allowlist, sink, sourceFamily);
      if (cookies.length > 0) {
        if (!dependencies.target.applyCookies) {
          sink.add('cookies', 'apply_target_unavailable', 'The browser target cannot apply cookies.');
        } else {
          throwIfAborted(dependencies.signal);
          try {
            const receipt = await dependencies.target.applyCookies(cookies);
            result.counts.cookies = appliedBatchCount(receipt, cookies.length);
            if (result.counts.cookies < cookies.length) {
              sink.add('cookies', 'apply_cookies_partial', 'The browser target could not apply every cookie.', cookies.length - result.counts.cookies);
            }
            throwIfAborted(dependencies.signal);
          } catch (error) {
            if (dependencies.signal?.aborted) throw new ImportAbortedError();
            sink.add('cookies', 'apply_cookies_failed', `The browser target rejected the cookie batch (${safeTargetError(error)}).`);
          }
        }
      }
    }

    if (parsed.selection.passwords) {
      const passwords = await readPasswords(dependencies, profileDirectory, limits, sink, sourceFamily);
      if (passwords.length > 0) {
        if (!dependencies.target.applyPasswords) {
          sink.add('passwords', 'apply_target_unavailable', 'The browser target cannot apply saved passwords.');
        } else {
          throwIfAborted(dependencies.signal);
          try {
            const receipt = await dependencies.target.applyPasswords(passwords);
            result.counts.passwords = appliedBatchCount(receipt, passwords.length);
            if (result.counts.passwords < passwords.length) {
              sink.add('passwords', 'apply_passwords_partial', 'The browser target could not apply every saved password.', passwords.length - result.counts.passwords);
            }
            throwIfAborted(dependencies.signal);
          } catch (error) {
            if (dependencies.signal?.aborted) throw new ImportAbortedError();
            sink.add('passwords', 'apply_passwords_failed', `The browser target rejected the password batch (${safeTargetError(error)}).`);
          }
        }
      }
    }

    if (parsed.selection.history) {
      const entries = await readHistory(dependencies, profileDirectory, limits, sink);
      if (entries.length > 0) {
        if (!dependencies.target.applyHistory) {
          sink.add('history', 'apply_target_unavailable', 'The browser target cannot apply history.');
        } else {
          throwIfAborted(dependencies.signal);
          try {
            const receipt = await dependencies.target.applyHistory(entries);
            result.counts.history = appliedBatchCount(receipt, entries.length);
            if (result.counts.history < entries.length) {
              sink.add('history', 'apply_history_partial', 'The browser target could not apply every history entry.', entries.length - result.counts.history);
            }
            throwIfAborted(dependencies.signal);
          } catch (error) {
            if (dependencies.signal?.aborted) throw new ImportAbortedError();
            sink.add('history', 'apply_history_failed', `The browser target rejected the history batch (${safeTargetError(error)}).`);
          }
        }
      }
    }

    if (parsed.selection.extensions) {
      const extensionProgress = { installed: 0 };
      try {
        await importExtensions(
          dependencies,
          profileDirectory,
          limits,
          sink,
          request.sourceId,
          request.profileId,
          extensionProgress,
        );
      } finally {
        result.counts.extensions = extensionProgress.installed;
      }
    }
  } catch (error) {
    if (error instanceof ImportAbortedError || dependencies.signal?.aborted) {
      result.cancelled = true;
      sink.add('profile', 'cancelled', 'The browser import was cancelled.');
    } else if (error instanceof BrowserError) {
      sink.add('profile', error.code, error.message);
    } else {
      sink.add('profile', 'import_failed', 'The browser import did not complete.');
    }
  }

  if (dependencies.signal?.aborted && !result.cancelled) {
    result.cancelled = true;
    if (!sink.errors.some(issue => issue.code === 'cancelled')) {
      sink.add('profile', 'cancelled', 'The browser import was cancelled.');
    }
  }
  result.ok = !result.cancelled && result.errors.length === 0;
  return result;
}

export { BROWSER_IMPORT_DEFAULT_SELECTION };
