/**
 * Synthetic Chromium-family fixtures for browser import tests.
 *
 * Everything here is created under a temporary directory. No test reads a real
 * browser profile, OS keychain, or user home directory.
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BrowserImportDecryptError,
  type BrowserImportCookie,
  type BrowserImportExtension,
  type BrowserImportHistoryEntry,
  type BrowserImportPassword,
  type BrowserImportTarget,
  type BrowserPasswordDecryptor,
  type BrowserSecretContext,
  type BrowserSourceRoot,
} from '../contracts/browser-import';

export const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000n;

export function chromeTime(unixMillis: number): bigint {
  return (BigInt(unixMillis) + CHROME_EPOCH_OFFSET_MS) * 1000n;
}

export interface LocalStateProfile {
  name?: string;
  gaia_name?: string;
  user_name?: string;
}

export function writeLocalState(
  userDataDir: string,
  profiles: Record<string, LocalStateProfile>,
  lastUsed = 'Default',
): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'Local State'),
    `${JSON.stringify({ profile: { info_cache: profiles, last_used: lastUsed } }, null, 2)}\n`,
    'utf8',
  );
}

export function sourceRoot(userDataDir: string, id = 'chrome'): BrowserSourceRoot {
  return { id, label: id === 'chrome' ? 'Google Chrome' : id, userDataDir, family: 'chrome' };
}

export function profileDirectory(userDataDir: string, profileId = 'Default'): string {
  const directory = join(userDataDir, profileId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export interface CookieFixture {
  host: string;
  name: string;
  value?: string;
  encrypted?: Uint8Array;
  path?: string;
  expiresAt?: number;
  hasExpires?: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: number;
  topFrameSiteKey?: string;
  hasCrossSiteAncestor?: boolean;
}

export function createCookies(
  profileDirectoryPath: string,
  rows: readonly CookieFixture[],
  options: { keepOpen?: boolean; schemaVersion?: number; partitionedSchema?: boolean } = {},
): DatabaseSync | undefined {
  mkdirSync(profileDirectoryPath, { recursive: true });
  const database = new DatabaseSync(join(profileDirectoryPath, 'Cookies'));
  database.exec('PRAGMA journal_mode = WAL');
  const partitionColumns = options.partitionedSchema
    ? ', top_frame_site_key TEXT, has_cross_site_ancestor INTEGER'
    : '';
  database.exec(`CREATE TABLE cookies (
    host_key TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    encrypted_value BLOB,
    path TEXT NOT NULL DEFAULT '/',
    expires_utc INTEGER NOT NULL DEFAULT 0,
    has_expires INTEGER NOT NULL DEFAULT 1,
    is_secure INTEGER NOT NULL DEFAULT 0,
    is_httponly INTEGER NOT NULL DEFAULT 0,
    samesite INTEGER NOT NULL DEFAULT -1
    ${partitionColumns}
  )`);
  if (options.schemaVersion !== undefined) {
    database.exec('CREATE TABLE meta (key TEXT NOT NULL, value TEXT NOT NULL)');
    database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', String(options.schemaVersion));
  }
  const columns = ['host_key', 'name', 'value', 'encrypted_value', 'path', 'expires_utc', 'has_expires', 'is_secure', 'is_httponly', 'samesite'];
  if (options.partitionedSchema) columns.push('top_frame_site_key', 'has_cross_site_ancestor');
  const insert = database.prepare(`INSERT INTO cookies (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  for (const row of rows) {
    const values: Array<string | number | bigint | Uint8Array | null> = [
      row.host,
      row.name,
      row.value ?? '',
      row.encrypted ?? null,
      row.path ?? '/',
      row.expiresAt === undefined ? 0n : chromeTime(row.expiresAt),
      row.hasExpires === false ? 0 : 1,
      row.secure ? 1 : 0,
      row.httpOnly ? 1 : 0,
      row.sameSite ?? -1,
    ];
    if (options.partitionedSchema) {
      values.push(row.topFrameSiteKey ?? null, row.hasCrossSiteAncestor === undefined ? null : (row.hasCrossSiteAncestor ? 1 : 0));
    }
    insert.run(...values);
  }
  if (options.keepOpen) return database;
  database.close();
  return undefined;
}

export interface LoginFixture {
  origin: string;
  username: string;
  encrypted: Uint8Array;
  blacklisted?: boolean;
}

export function createLogins(profileDirectoryPath: string, rows: readonly LoginFixture[]): void {
  mkdirSync(profileDirectoryPath, { recursive: true });
  const database = new DatabaseSync(join(profileDirectoryPath, 'Login Data'));
  database.exec(`CREATE TABLE logins (
    origin_url TEXT NOT NULL,
    username_value TEXT NOT NULL DEFAULT '',
    password_value BLOB,
    blacklisted_by_user INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = database.prepare(`INSERT INTO logins
    (origin_url, username_value, password_value, blacklisted_by_user) VALUES (?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(row.origin, row.username, row.encrypted, row.blacklisted ? 1 : 0);
  }
  database.close();
}

export interface HistoryFixture {
  url: string;
  title?: string;
  visitedAt: number;
}

export function createHistory(
  profileDirectoryPath: string,
  visits: readonly HistoryFixture[],
  options: { keepOpen?: boolean } = {},
): DatabaseSync | undefined {
  mkdirSync(profileDirectoryPath, { recursive: true });
  const database = new DatabaseSync(join(profileDirectoryPath, 'History'));
  if (options.keepOpen) database.exec('PRAGMA journal_mode = WAL');
  database.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL)`);
  const insertUrl = database.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)');
  const insertVisit = database.prepare('INSERT INTO visits (id, url, visit_time) VALUES (?, ?, ?)');
  visits.forEach((visit, index) => {
    const id = index + 1;
    insertUrl.run(id, visit.url, visit.title ?? null);
    insertVisit.run(id, id, chromeTime(visit.visitedAt));
  });
  if (options.keepOpen) return database;
  database.close();
  return undefined;
}

export interface ExtensionFixture {
  id: string;
  version: string;
  name?: string;
  files?: Record<string, string | Uint8Array>;
  key?: string;
  symlinkTo?: string;
}

export function extensionIdFromPublicKeyDer(der: Uint8Array): string {
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (let index = 0; index < 16; index += 1) {
    const byte = digest[index]!;
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return id;
}

export function syntheticExtensionKey(): { key: string; id: string } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }));
  return { key: der.toString('base64'), id: extensionIdFromPublicKeyDer(der) };
}

export function createExtension(profileDirectoryPath: string, fixture: ExtensionFixture): string {
  const directory = join(profileDirectoryPath, 'Extensions', fixture.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify({
    manifest_version: 3,
    ...(fixture.key ? { key: fixture.key } : {}),
    name: fixture.name ?? `Synthetic ${fixture.id.slice(0, 6)}`,
    version: fixture.version,
  }, null, 2)}\n`, 'utf8');
  for (const [name, body] of Object.entries(fixture.files ?? {})) {
    writeFileSync(join(directory, name), body);
  }
  if (fixture.symlinkTo) symlinkSync(fixture.symlinkTo, join(directory, 'linked'));
  return directory;
}

export class RecordingDecryptor implements BrowserPasswordDecryptor {
  readonly calls: Array<{ bytes: Uint8Array; context: BrowserSecretContext }> = [];
  constructor(private readonly stripPrefix = 'v10-', private readonly rejectPrefix = 'v20-') {}
  async decrypt(input: Uint8Array, context: BrowserSecretContext): Promise<string> {
    this.calls.push({ bytes: Uint8Array.from(input), context });
    const text = Buffer.from(input).toString('utf8');
    if (this.rejectPrefix && text.startsWith(this.rejectPrefix)) {
      throw new BrowserImportDecryptError(
        'app_bound_encryption_unsupported',
        'The synthetic decryptor only rejects the app-bound fixture prefix.',
      );
    }
    return text.startsWith(this.stripPrefix) ? text.slice(this.stripPrefix.length) : text;
  }
}

export class RecordingTarget implements BrowserImportTarget {
  cookies: BrowserImportCookie[] = [];
  passwords: BrowserImportPassword[] = [];
  history: BrowserImportHistoryEntry[] = [];
  extensions: BrowserImportExtension[] = [];
  failCookies = false;
  /** How the synthetic target answers extension installs. */
  installResult: 'return-id' | 'void' | 'wrong-id' = 'return-id';

  async applyCookies(cookies: readonly BrowserImportCookie[]): Promise<void> {
    if (this.failCookies) throw Object.assign(new Error('cookie target rejected'), { code: 'cookie_target_failed' });
    this.cookies = [...cookies];
  }

  async applyPasswords(passwords: readonly BrowserImportPassword[]): Promise<void> {
    this.passwords = [...passwords];
  }

  async applyHistory(entries: readonly BrowserImportHistoryEntry[]): Promise<void> {
    this.history = [...entries];
  }

  async installExtension(extension: BrowserImportExtension): Promise<{ id: string } | void> {
    this.extensions = [...this.extensions, extension];
    if (this.installResult === 'void') return;
    if (this.installResult === 'wrong-id') return { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    return { id: extension.id };
  }
}
