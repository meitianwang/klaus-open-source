import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BROWSER_CREDENTIAL_LIMITS,
  type BrowserAddressFields,
  type BrowserAutofillProfile,
  type BrowserAutofillProfileInput,
  type BrowserAutofillProfileKind,
  type BrowserAutofillProfileSummary,
  type BrowserContactFields,
  type BrowserCredentialPurpose,
  type BrowserPasswordImportItem,
  type BrowserPasswordImportReceipt,
  type BrowserPasswordImportRow,
  type BrowserPasswordInput,
  type BrowserPasswordSummary,
  type BrowserSecretCipher,
  type BrowserCredentialsStoreOptions,
} from '../../contracts/browser-credentials';
import { BrowserError } from './types';

const PASSWORD_TABLE = 'browser_passwords';
const PROFILE_TABLE = 'browser_autofill_profiles';
const DATABASE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

interface PasswordRow {
  id: string;
  origin_url: string;
  username: string;
  username_key: string;
  label: string | null;
  password_cipher: Uint8Array;
  created_at: number;
  updated_at: number;
}

interface ProfileRow {
  id: string;
  kind: string;
  label: string;
  data_cipher: Uint8Array;
  created_at: number;
  updated_at: number;
}

type PreparedStatement = ReturnType<DatabaseSync['prepare']>;

interface PasswordImportStatements {
  find: PreparedStatement;
  insert: PreparedStatement;
  update: PreparedStatement;
}

interface NormalizedPasswordInput {
  originUrl: string;
  username: string;
  usernameKey: string;
  password: string;
  label?: string;
}

interface NormalizedProfileInput {
  kind: BrowserAutofillProfileKind;
  label: string;
  fields: BrowserAddressFields | BrowserContactFields;
}

function credentialError(code: string, message: string): BrowserError {
  return new BrowserError(code, message);
}

function ensureEncryption(cipher: BrowserSecretCipher): void {
  let available = false;
  try {
    available = cipher.available();
  } catch {
    available = false;
  }
  if (!available) {
    throw credentialError(
      'encryption_unavailable',
      'Operating-system encryption is unavailable; browser credentials cannot be stored safely.',
    );
  }
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string') throw credentialError('invalid_request', 'originUrl must be a string.');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > BROWSER_CREDENTIAL_LIMITS.maxOriginLength) {
    throw credentialError('invalid_request', 'originUrl is invalid.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw credentialError('invalid_request', 'originUrl must be a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw credentialError('invalid_request', 'Only HTTP and HTTPS origins can store credentials.');
  }
  if (parsed.username || parsed.password) {
    throw credentialError('invalid_request', 'originUrl must not contain credentials.');
  }
  if (!parsed.hostname || parsed.origin === 'null') {
    throw credentialError('invalid_request', 'originUrl must include an exact origin.');
  }
  return parsed.origin;
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') throw credentialError('invalid_request', 'username must be a string.');
  const username = value.trim();
  if (!username || username.length > BROWSER_CREDENTIAL_LIMITS.maxUsernameLength) {
    throw credentialError('invalid_request', 'username is invalid.');
  }
  return username;
}

function normalizePassword(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > BROWSER_CREDENTIAL_LIMITS.maxPasswordLength) {
    throw credentialError('invalid_request', 'password is invalid.');
  }
  return value;
}

function normalizeLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw credentialError('invalid_request', 'label must be a string.');
  const label = value.trim();
  if (label.length > BROWSER_CREDENTIAL_LIMITS.maxLabelLength) {
    throw credentialError('invalid_request', 'label is too long.');
  }
  return label || undefined;
}

function normalizePasswordInput(input: BrowserPasswordInput): NormalizedPasswordInput {
  const originUrl = normalizeOrigin(input.originUrl);
  const username = normalizeUsername(input.username);
  return {
    originUrl,
    username,
    usernameKey: username,
    password: normalizePassword(input.password),
    ...(normalizeLabel(input.label) === undefined ? {} : { label: normalizeLabel(input.label) }),
  };
}

function normalizeKind(value: unknown): BrowserAutofillProfileKind {
  if (value === 'address' || value === 'contact') return value;
  throw credentialError('invalid_request', 'kind must be address or contact.');
}

const ADDRESS_KEYS = [
  'fullName',
  'company',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country',
  'phone',
  'email',
] as const;

const CONTACT_KEYS = ['name', 'email', 'phone'] as const;

function normalizeFields(
  kind: BrowserAutofillProfileKind,
  value: unknown,
): BrowserAddressFields | BrowserContactFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw credentialError('invalid_request', 'fields must be an object.');
  }
  const source = value as Record<string, unknown>;
  const allowed = kind === 'address' ? ADDRESS_KEYS : CONTACT_KEYS;
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') throw credentialError('invalid_request', `${key} must be a string.`);
    const trimmed = raw.trim();
    if (trimmed.length > BROWSER_CREDENTIAL_LIMITS.maxFieldLength) {
      throw credentialError('invalid_request', `${key} is too long.`);
    }
    if (trimmed) result[key] = trimmed;
  }
  if (!Object.keys(result).length) {
    throw credentialError('invalid_request', 'At least one autofill field is required.');
  }
  return result as BrowserAddressFields | BrowserContactFields;
}

function normalizeProfileInput(input: BrowserAutofillProfileInput): NormalizedProfileInput {
  const kind = normalizeKind(input.kind);
  const label = normalizeLabel(input.label);
  if (!label) throw credentialError('invalid_request', 'label is required.');
  return { kind, label, fields: normalizeFields(kind, input.fields) };
}

function summary(row: PasswordRow): BrowserPasswordSummary {
  return {
    id: row.id,
    originUrl: row.origin_url,
    username: row.username,
    ...(row.label ? { label: row.label } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function profileSummary(row: ProfileRow): BrowserAutofillProfileSummary {
  return {
    id: row.id,
    kind: normalizeKind(row.kind),
    label: row.label,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function secureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  try {
    chmodSync(directory, DIRECTORY_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') throw error;
  }
}

function secureDatabase(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(candidate)) continue;
    try {
      chmodSync(candidate, DATABASE_MODE);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') throw error;
    }
  }
}

function openDatabase(databasePath: string): DatabaseSync {
  secureDirectory(dirname(databasePath));
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA secure_delete = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PASSWORD_TABLE} (
      id TEXT PRIMARY KEY,
      origin_url TEXT NOT NULL,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL,
      label TEXT,
      password_cipher BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ${PASSWORD_TABLE}_origin_username
      ON ${PASSWORD_TABLE}(origin_url, username_key);
    CREATE INDEX IF NOT EXISTS ${PASSWORD_TABLE}_origin_updated
      ON ${PASSWORD_TABLE}(origin_url, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ${PROFILE_TABLE} (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('address', 'contact')),
      label TEXT NOT NULL,
      data_cipher BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${PROFILE_TABLE}_kind_updated
      ON ${PROFILE_TABLE}(kind, updated_at DESC);
  `);
  secureDatabase(databasePath);
  return db;
}

function closeDatabase(db: DatabaseSync, databasePath: string): void {
  try {
    secureDatabase(databasePath);
  } finally {
    db.close();
  }
}

function withDatabase<T>(databasePath: string, work: (db: DatabaseSync) => T): T {
  const db = openDatabase(databasePath);
  try {
    return work(db);
  } finally {
    closeDatabase(db, databasePath);
  }
}

function decrypt(cipher: BrowserSecretCipher, value: Uint8Array): string {
  ensureEncryption(cipher);
  try {
    const plaintext = cipher.decrypt(Buffer.from(value));
    if (typeof plaintext !== 'string') throw new Error('cipher returned a non-string value');
    return plaintext;
  } catch {
    throw credentialError(
      'decryption_failed',
      'Encrypted browser credentials could not be opened with the current operating-system key.',
    );
  }
}

function findPassword(
  db: DatabaseSync,
  originUrl: string,
  usernameKey: string,
  statements?: Pick<PasswordImportStatements, 'find'>,
): PasswordRow | undefined {
  const statement = statements?.find ?? db.prepare(
    `SELECT * FROM ${PASSWORD_TABLE} WHERE origin_url=? AND username_key=?`,
  );
  return statement.get(originUrl, usernameKey) as PasswordRow | undefined;
}

function writePassword(
  db: DatabaseSync,
  cipher: BrowserSecretCipher,
  input: NormalizedPasswordInput,
  now: number,
  statements?: PasswordImportStatements,
): { row: PasswordRow; created: boolean } {
  const ciphertext = cipher.encrypt(input.password);
  if (!ciphertext?.length) {
    throw credentialError('encryption_unavailable', 'Operating-system encryption returned no ciphertext.');
  }
  const existing = findPassword(db, input.originUrl, input.usernameKey, statements);
  if (existing) {
    const update = statements?.update ?? db.prepare(
      `UPDATE ${PASSWORD_TABLE}
       SET username=?, label=?, password_cipher=?, updated_at=?
       WHERE id=?`,
    );
    update.run(input.username, input.label ?? existing.label, ciphertext, now, existing.id);
    return {
      row: {
        ...existing,
        username: input.username,
        label: input.label ?? existing.label,
        password_cipher: new Uint8Array(ciphertext),
        updated_at: now,
      },
      created: false,
    };
  }
  const id = randomUUID();
  const insert = statements?.insert ?? db.prepare(
    `INSERT INTO ${PASSWORD_TABLE}
     (id, origin_url, username, username_key, label, password_cipher, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  insert.run(id, input.originUrl, input.username, input.usernameKey, input.label ?? null, ciphertext, now, now);
  return {
    row: {
      id,
      origin_url: input.originUrl,
      username: input.username,
      username_key: input.usernameKey,
      label: input.label ?? null,
      password_cipher: new Uint8Array(ciphertext),
      created_at: now,
      updated_at: now,
    },
    created: true,
  };
}

/**
 * Encrypted, local-only password and autofill profile store.
 *
 * The cipher is an injected boundary. Production passes Electron safeStorage;
 * tests pass a deterministic reversible cipher. There is deliberately no
 * plaintext fallback: if the cipher is unavailable every read and write fails.
 */
export class BrowserCredentialsStore {
  readonly databasePath: string;
  private readonly cipher: BrowserSecretCipher;
  private readonly now: () => number;

  constructor(options: BrowserCredentialsStoreOptions) {
    this.databasePath = options.databasePath;
    this.cipher = options.cipher;
    this.now = options.now ?? Date.now;
  }

  assertAvailable(): void {
    ensureEncryption(this.cipher);
  }

  savePassword(input: BrowserPasswordInput): Promise<BrowserPasswordSummary> {
    const normalized = normalizePasswordInput(input);
    return Promise.resolve(withDatabase(this.databasePath, db => {
      ensureEncryption(this.cipher);
      if (input.id !== undefined) {
        if (typeof input.id !== 'string' || !input.id) throw credentialError('invalid_request', 'A password entry id is required.');
        const existing = db.prepare(`SELECT * FROM ${PASSWORD_TABLE} WHERE id=?`).get(input.id) as PasswordRow | undefined;
        if (!existing) throw credentialError('not_found', 'The saved password no longer exists.');
        const collision = findPassword(db, normalized.originUrl, normalized.usernameKey);
        if (collision && collision.id !== existing.id) throw credentialError('credential_conflict', 'A password is already saved for this account and website.');
        const encrypted = this.cipher.encrypt(normalized.password);
        if (!encrypted.length) throw credentialError('encryption_unavailable', 'Operating-system encryption returned no ciphertext.');
        const now = this.now();
        db.prepare(`UPDATE ${PASSWORD_TABLE} SET origin_url=?,username=?,username_key=?,label=?,password_cipher=?,updated_at=? WHERE id=?`)
          .run(normalized.originUrl, normalized.username, normalized.usernameKey, normalized.label ?? null, encrypted, now, existing.id);
        secureDatabase(this.databasePath);
        return summary({ ...existing, origin_url:normalized.originUrl, username:normalized.username, username_key:normalized.usernameKey, label:normalized.label ?? null, password_cipher:encrypted, updated_at:now });
      }
      const written = writePassword(db, this.cipher, normalized, this.now());
      secureDatabase(this.databasePath);
      return summary(written.row);
    }));
  }

  listPasswords(originUrl?: string): Promise<BrowserPasswordSummary[]> {
    const exactOrigin = originUrl === undefined ? undefined : normalizeOrigin(originUrl);
    return Promise.resolve(withDatabase(this.databasePath, db => {
      const rows = exactOrigin
        ? db.prepare(`SELECT * FROM ${PASSWORD_TABLE} WHERE origin_url=? ORDER BY updated_at DESC, id DESC`)
          .all(exactOrigin) as unknown as PasswordRow[]
        : db.prepare(`SELECT * FROM ${PASSWORD_TABLE} ORDER BY updated_at DESC, id DESC`)
          .all() as unknown as PasswordRow[];
      return rows.map(summary);
    }));
  }

  /**
   * Explicit secret access. The caller must confirm the user's intent for
   * display or copy; autofill passes a confirmation already produced by the
   * trusted credential chooser.
   */
  async readPassword(
    id: string,
    purpose: BrowserCredentialPurpose,
    confirm: () => Promise<boolean> | boolean,
  ): Promise<string | null> {
    if (typeof id !== 'string' || !id) throw credentialError('invalid_request', 'id is required.');
    if (purpose !== 'display' && purpose !== 'copy') throw credentialError('invalid_request', 'purpose is invalid.');
    ensureEncryption(this.cipher);
    const row = withDatabase(this.databasePath, db => db.prepare(
      `SELECT * FROM ${PASSWORD_TABLE} WHERE id=?`,
    ).get(id) as PasswordRow | undefined);
    if (!row) return null;
    const allowed = await confirm();
    if (!allowed) return null;
    return decrypt(this.cipher, row.password_cipher);
  }

  deletePassword(id: string): Promise<{ removed: boolean }> {
    if (typeof id !== 'string' || !id) throw credentialError('invalid_request', 'id is required.');
    return Promise.resolve(withDatabase(this.databasePath, db => {
      const result = db.prepare(`DELETE FROM ${PASSWORD_TABLE} WHERE id=?`).run(id);
      secureDatabase(this.databasePath);
      return { removed: Number(result.changes) > 0 };
    }));
  }

  /**
   * Bulk import for the external-browser importer. Duplicate rows within one
   * batch are skipped after the first occurrence; an existing row with the
   * same origin and username is updated only when the password differs.
   */
  importPasswords(rows: BrowserPasswordImportRow[]): Promise<BrowserPasswordImportReceipt> {
    if (!Array.isArray(rows) || rows.length > BROWSER_CREDENTIAL_LIMITS.maxImportRows) {
      throw credentialError('invalid_request', `rows must contain at most ${BROWSER_CREDENTIAL_LIMITS.maxImportRows} entries.`);
    }
    ensureEncryption(this.cipher);
    const items: BrowserPasswordImportItem[] = [];
    const seen = new Map<string, string>();
    return Promise.resolve(withDatabase(this.databasePath, db => {
      db.exec('BEGIN IMMEDIATE');
      const statements: PasswordImportStatements = {
        find: db.prepare(`SELECT * FROM ${PASSWORD_TABLE} WHERE origin_url=? AND username_key=?`),
        insert: db.prepare(
          `INSERT INTO ${PASSWORD_TABLE}
           (id, origin_url, username, username_key, label, password_cipher, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        ),
        update: db.prepare(
          `UPDATE ${PASSWORD_TABLE}
           SET username=?, label=?, password_cipher=?, updated_at=?
           WHERE id=?`,
        ),
      };
      try {
        rows.forEach((row, index) => {
          try {
            const normalized = normalizePasswordInput(row);
            const key = `${normalized.originUrl}\u0000${normalized.usernameKey}`;
            const previousInBatch = seen.get(key);
            if (previousInBatch !== undefined && previousInBatch === normalized.password) {
              items.push({ index, status: 'skipped', reason: 'duplicate_in_import' });
              return;
            }
            seen.set(key, normalized.password);
            const existing = findPassword(db, normalized.originUrl, normalized.usernameKey, statements);
            if (existing) {
              const previous = decrypt(this.cipher, existing.password_cipher);
              if (previous === normalized.password) {
                items.push({ index, status: 'skipped', credentialId: existing.id, reason: 'duplicate' });
                return;
              }
            }
            const written = writePassword(db, this.cipher, normalized, this.now(), statements);
            items.push({
              index,
              status: written.created ? 'imported' : 'updated',
              credentialId: written.row.id,
            });
          } catch (error) {
            items.push({
              index,
              status: 'failed',
              reason: error instanceof BrowserError ? error.code : 'invalid_row',
            });
          }
        });
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
        throw error;
      } finally {
        secureDatabase(this.databasePath);
      }
      const count = (status: BrowserPasswordImportReceipt['items'][number]['status']) =>
        items.filter(item => item.status === status).length;
      return {
        total: rows.length,
        imported: count('imported'),
        updated: count('updated'),
        skipped: count('skipped'),
        failed: count('failed'),
        items,
      };
    }));
  }

  saveAutofillProfile(input: BrowserAutofillProfileInput): Promise<BrowserAutofillProfileSummary> {
    const normalized = normalizeProfileInput(input);
    return Promise.resolve(withDatabase(this.databasePath, db => {
      ensureEncryption(this.cipher);
      const count = Number((db.prepare(
        `SELECT COUNT(*) AS count FROM ${PROFILE_TABLE} WHERE kind=?`,
      ).get(normalized.kind) as { count: number | bigint }).count);
      if (count >= BROWSER_CREDENTIAL_LIMITS.maxProfilesPerKind) {
        throw credentialError('limit_exceeded', 'Too many autofill profiles of this kind.');
      }
      const ciphertext = this.cipher.encrypt(JSON.stringify(normalized.fields));
      if (!ciphertext?.length) {
        throw credentialError('encryption_unavailable', 'Operating-system encryption returned no ciphertext.');
      }
      const now = this.now();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO ${PROFILE_TABLE} (id, kind, label, data_cipher, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(id, normalized.kind, normalized.label, ciphertext, now, now);
      secureDatabase(this.databasePath);
      return {
        id,
        kind: normalized.kind,
        label: normalized.label,
        createdAt: now,
        updatedAt: now,
      };
    }));
  }

  updateAutofillProfile(id: string, input: BrowserAutofillProfileInput): Promise<BrowserAutofillProfileSummary> {
    if (typeof id !== 'string' || !id) throw credentialError('invalid_request', 'id is required.');
    const normalized = normalizeProfileInput(input);
    return Promise.resolve(withDatabase(this.databasePath, db => {
      ensureEncryption(this.cipher);
      const existing = db.prepare(`SELECT * FROM ${PROFILE_TABLE} WHERE id=?`).get(id) as ProfileRow | undefined;
      if (!existing) throw credentialError('not_found', 'Autofill profile not found.');
      const ciphertext = this.cipher.encrypt(JSON.stringify(normalized.fields));
      const now = this.now();
      db.prepare(
        `UPDATE ${PROFILE_TABLE} SET kind=?, label=?, data_cipher=?, updated_at=? WHERE id=?`,
      ).run(normalized.kind, normalized.label, ciphertext, now, id);
      secureDatabase(this.databasePath);
      return {
        id,
        kind: normalized.kind,
        label: normalized.label,
        createdAt: Number(existing.created_at),
        updatedAt: now,
      };
    }));
  }

  listAutofillProfiles(kind?: BrowserAutofillProfileKind): Promise<BrowserAutofillProfileSummary[]> {
    const exactKind = kind === undefined ? undefined : normalizeKind(kind);
    return Promise.resolve(withDatabase(this.databasePath, db => {
      const rows = exactKind
        ? db.prepare(`SELECT * FROM ${PROFILE_TABLE} WHERE kind=? ORDER BY updated_at DESC, id DESC`)
          .all(exactKind) as unknown as ProfileRow[]
        : db.prepare(`SELECT * FROM ${PROFILE_TABLE} ORDER BY updated_at DESC, id DESC`)
          .all() as unknown as ProfileRow[];
      return rows.map(profileSummary);
    }));
  }

  /** Explicit profile read for edit/autofill. Never call from a list path. */
  readAutofillProfile(id: string): Promise<BrowserAutofillProfile | null> {
    if (typeof id !== 'string' || !id) throw credentialError('invalid_request', 'id is required.');
    ensureEncryption(this.cipher);
    return Promise.resolve(withDatabase(this.databasePath, db => {
      const row = db.prepare(`SELECT * FROM ${PROFILE_TABLE} WHERE id=?`).get(id) as ProfileRow | undefined;
      if (!row) return null;
      const parsed = JSON.parse(decrypt(this.cipher, row.data_cipher)) as unknown;
      const fields = normalizeFields(normalizeKind(row.kind), parsed);
      return { ...profileSummary(row), fields };
    }));
  }

  deleteAutofillProfile(id: string): Promise<{ removed: boolean }> {
    if (typeof id !== 'string' || !id) throw credentialError('invalid_request', 'id is required.');
    return Promise.resolve(withDatabase(this.databasePath, db => {
      const result = db.prepare(`DELETE FROM ${PROFILE_TABLE} WHERE id=?`).run(id);
      secureDatabase(this.databasePath);
      return { removed: Number(result.changes) > 0 };
    }));
  }

  /** Test and diagnostics helper; does not expose credential values. */
  fileMode(): number {
    return statSync(this.databasePath).mode & 0o777;
  }
}
