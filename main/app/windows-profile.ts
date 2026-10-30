import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { restrictPrivateDirectory } from './private-directory';
import { pruneLegacyClaudeOAuth, readLegacyClaudeOAuth, type WindowsCredentialKeyError, type WindowsLegacyMigrationJournal, type WindowsLegacyPlaintextProof } from '../native/windows-credentials';

type RecordValue = Record<string, unknown>;
interface State { path: string; bytes: Buffer; value: RecordValue; key?: string }
export interface WindowsProfileResult {
  status: 'fresh' | 'current' | 'restored' | 'blocked';
  keyError?: WindowsCredentialKeyError;
  backupDirectory?: string;
  legacyPlaintextProof?: WindowsLegacyPlaintextProof;
  legacyMigrationJournal?: WindowsLegacyMigrationJournal;
  legacyPlaintextCleanupSha256?: string;
  warning?: string;
}
interface PendingMarker {
  version: 2; owned: false; legacyProof: WindowsLegacyPlaintextProof;
  backupDirectory: string; backupManifestSha256: string;
  keyDigest?: string; pendingNewEncryptedSha256?: string;
  keyError?: WindowsCredentialKeyError;
}
const CREDENTIAL_LIMIT = 1024 * 1024, STATE_LIMIT = 16 * 1024 * 1024;
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;

/** Completed owner markers no longer name their old backup, so repair this bounded namespace before returning early. */
function protectExistingBackups(configRoot: string): void {
  const parent = join(configRoot, 'migration-backups'), base = join(parent, 'windows-credentials');
  for (const path of [configRoot, parent, base]) {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory()) throw new Error('WINDOWS_PROFILE_BACKUP_NOT_DIRECTORY');
  }
  const stream = opendirSync(base); let count = 0;
  try {
    for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
      if (++count > 32 || !/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory()) throw new Error('WINDOWS_PROFILE_BACKUP_NAMESPACE_INVALID');
      const directory = join(base, entry.name), files = opendirSync(directory);
      try {
        let entries = 0;
        for (let file = files.readSync(); file; file = files.readSync()) {
          if (++entries > 6 || !/^(?:credentials\.(?:enc|json)|sources\.json|local-state-[0-2]\.json)$/.test(file.name) || !file.isFile()) throw new Error('WINDOWS_PROFILE_BACKUP_NAMESPACE_INVALID');
        }
      } finally { files.closeSync(); }
      restrictPrivateDirectory(directory, configRoot);
    }
  } finally { stream.closeSync(); }
}

function read(path: string, limit: number): Buffer | undefined {
  let fd: number;
  try {
    if (!lstatSync(path).isFile()) throw new Error('WINDOWS_PROFILE_NOT_REGULAR_FILE');
    fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('WINDOWS_PROFILE_FILE_TOO_LARGE');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; }
    if (offset > stat.size) throw new Error('WINDOWS_PROFILE_CHANGED_DURING_READ');
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}
function parse(bytes: Buffer): RecordValue {
  try { const value = record(JSON.parse(bytes.toString('utf8'))); if (value) return value; } catch { /* Report no key material. */ }
  throw new Error('WINDOWS_PROFILE_INVALID_JSON');
}
function encryptedKey(value: RecordValue): string | undefined {
  const key = record(value.os_crypt)?.encrypted_key;
  if (typeof key !== 'string' || !key) return undefined;
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length <= 5 || bytes.toString('base64') !== key || bytes.subarray(0, 5).toString() !== 'DPAPI') return undefined;
  return key;
}
function state(path: string): State | undefined {
  const bytes = read(path, 16 * 1024 * 1024); if (!bytes) return undefined;
  const value = parse(bytes); return { path, bytes, value, key: encryptedKey(value) };
}
function atomic(path: string, bytes: Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function validHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function pendingMarker(value: RecordValue, configRoot: string): PendingMarker {
  const proof = record(value.legacyProof);
  if (value.version !== 2 || value.owned !== false || !proof || !validHash(proof.encryptedSha256) || !validHash(proof.plaintextSha256)
    || typeof value.backupDirectory !== 'string' || dirname(resolve(value.backupDirectory)) !== resolve(configRoot, 'migration-backups', 'windows-credentials')
    || !/^[a-f0-9]{64}$/.test(basename(value.backupDirectory)) || !validHash(value.backupManifestSha256)
    || value.keyDigest !== undefined && !validHash(value.keyDigest)
    || value.pendingNewEncryptedSha256 !== undefined && !validHash(value.pendingNewEncryptedSha256)
    || value.keyError !== undefined && !['windows_credentials_legacy_key_required', 'windows_credentials_key_conflict'].includes(String(value.keyError))) throw new Error('WINDOWS_PROFILE_INVALID_MIGRATION_MARKER');
  return value as unknown as PendingMarker;
}
function backupEntries(marker: PendingMarker, manifestBytes: Buffer): Array<{ name: string; sha256: string; limit: number }> {
  if (digest(manifestBytes) !== marker.backupManifestSha256) throw new Error('WINDOWS_PROFILE_BACKUP_PROOF_INVALID');
  const manifest = parse(manifestBytes);
  if (!Array.isArray(manifest.states) || manifest.states.length > 3) throw new Error('WINDOWS_PROFILE_BACKUP_PROOF_INVALID');
  const entries = [{ name: 'credentials.enc', sha256: marker.legacyProof.encryptedSha256, limit: CREDENTIAL_LIMIT },
    { name: 'credentials.json', sha256: marker.legacyProof.plaintextSha256, limit: CREDENTIAL_LIMIT }];
  manifest.states.forEach((raw, index) => {
    const entry = record(raw);
    if (entry?.backup !== `local-state-${index}.json` || !validHash(entry.sha256)) throw new Error('WINDOWS_PROFILE_BACKUP_PROOF_INVALID');
    entries.push({ name: entry.backup, sha256: entry.sha256, limit: STATE_LIMIT });
  });
  return entries;
}
function verifyBackup(marker: PendingMarker): void {
  const manifest = read(join(marker.backupDirectory, 'sources.json'), 16 * 1024);
  if (!manifest) throw new Error('WINDOWS_PROFILE_BACKUP_PROOF_INVALID');
  for (const entry of backupEntries(marker, manifest)) {
    const bytes = read(join(marker.backupDirectory, entry.name), entry.limit);
    if (!bytes || digest(bytes) !== entry.sha256) throw new Error('WINDOWS_PROFILE_BACKUP_PROOF_INVALID');
  }
}
async function readAsync(path: string, limit: number): Promise<Buffer | undefined> {
  let handle;
  try {
    if (!(await lstat(path)).isFile()) throw new Error('WINDOWS_PROFILE_NOT_REGULAR_FILE');
    handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('WINDOWS_PROFILE_FILE_TOO_LARGE');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1)); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset > stat.size) throw new Error('WINDOWS_PROFILE_CHANGED_DURING_READ');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
async function atomicAsync(path: string, bytes: Buffer, expected: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    const current = await readAsync(path, 4096);
    if (!current?.equals(expected)) throw new Error('WINDOWS_PROFILE_MARKER_CHANGED');
    await rename(temporary, path);
  } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

async function persistedKey(path: string, knownDigest?: string): Promise<string> {
  const until = Date.now() + 15_000;
  for (;;) {
    const bytes = await readAsync(path, STATE_LIMIT);
    const value = bytes ? parse(bytes) : undefined;
    const key = value ? encryptedKey(value) : undefined;
    if (key) return key;
    if (knownDigest || record(value?.os_crypt)?.encrypted_key !== undefined || Date.now() >= until) {
      throw new Error('WINDOWS_PROFILE_CURRENT_KEY_NOT_PERSISTED');
    }
    // Chromium schedules preference writes separately from async encryption. Do not commit credentials before its new key reaches disk.
    await new Promise<void>(resolve => { setTimeout(resolve, 50); });
  }
}

/** Only the adapter's bounded serial queue calls this journal, after app readiness. */
function migrationJournal(configRoot: string, markerPath: string, initial: PendingMarker): WindowsLegacyMigrationJournal {
  let marker = initial, expected = Buffer.from(JSON.stringify(marker));
  const paths = { encrypted: join(configRoot, '.credentials.enc'), plaintext: join(configRoot, '.credentials.json'), state: join(configRoot, 'electron', 'Local State') };
  const verify = async (): Promise<void> => {
    const manifest = await readAsync(join(marker.backupDirectory, 'sources.json'), 16 * 1024);
    if (!manifest) throw new Error('WINDOWS_PROFILE_BACKUP_PROOF_INVALID');
    await Promise.all(backupEntries(marker, manifest).map(async entry => {
      const bytes = await readAsync(join(marker.backupDirectory, entry.name), entry.limit);
      if (!bytes || digest(bytes) !== entry.sha256) throw new Error('WINDOWS_PROFILE_BACKUP_PROOF_INVALID');
    }));
  };
  return {
    prepare: async encryptedSha256 => {
      if (!validHash(encryptedSha256)) throw new Error('WINDOWS_PROFILE_INVALID_ENCRYPTED_HASH');
      const key = await persistedKey(paths.state, marker.keyDigest);
      await verify();
      const [encrypted, plaintext] = await Promise.all([readAsync(paths.encrypted, CREDENTIAL_LIMIT), readAsync(paths.plaintext, CREDENTIAL_LIMIT)]);
      if (!encrypted || !plaintext || digest(encrypted) !== marker.legacyProof.encryptedSha256 || digest(plaintext) !== marker.legacyProof.plaintextSha256) throw new Error('WINDOWS_PROFILE_MIGRATION_CHANGED');
      if (marker.keyDigest && marker.keyDigest !== digest(key)) throw new Error('WINDOWS_PROFILE_CURRENT_KEY_CHANGED');
      const next: PendingMarker = { ...marker, keyDigest: digest(key), pendingNewEncryptedSha256: encryptedSha256 };
      const bytes = Buffer.from(JSON.stringify(next));
      await atomicAsync(markerPath, bytes, expected);
      marker = next; expected = bytes;
    },
    commit: async encryptedSha256 => {
      if (marker.pendingNewEncryptedSha256 !== encryptedSha256) throw new Error('WINDOWS_PROFILE_INVALID_ENCRYPTED_HASH');
      await verify();
      const [encrypted, localState] = await Promise.all([readAsync(paths.encrypted, CREDENTIAL_LIMIT), readAsync(paths.state, STATE_LIMIT)]);
      if (!encrypted || digest(encrypted) !== encryptedSha256) throw new Error('WINDOWS_PROFILE_MIGRATION_CHANGED');
      const key = localState ? encryptedKey(parse(localState)) : undefined;
      if (!key || marker.keyDigest !== digest(key)) throw new Error('WINDOWS_PROFILE_CURRENT_KEY_CHANGED');
      const bytes = Buffer.from(JSON.stringify({ version: 2, owned: true, keyDigest: marker.keyDigest,
        legacyPlaintextCleanupSha256: marker.legacyProof.plaintextSha256 }));
      const current = await readAsync(markerPath, 4096);
      // A successful disk commit followed by a lost acknowledgement is safe to retry.
      if (current?.equals(bytes)) return;
      await atomicAsync(markerPath, bytes, expected);
    },
  };
}

function cleanupOwnedPlaintext(configRoot: string, markerPath: string, marker: RecordValue): string | undefined {
  if (marker.legacyPlaintextCleanupSha256 === undefined) return undefined;
  if (!validHash(marker.legacyPlaintextCleanupSha256)) throw new Error('WINDOWS_PROFILE_INVALID_MIGRATION_MARKER');
  const path = join(configRoot, '.credentials.json');
  try {
    const bytes = read(path, CREDENTIAL_LIMIT);
    if (bytes) {
      const cleaned = pruneLegacyClaudeOAuth(bytes);
      if (cleaned.changed) {
        if (digest(bytes) !== marker.legacyPlaintextCleanupSha256) return 'legacy_credential_cleanup_failed';
        if (!read(path, CREDENTIAL_LIMIT)?.equals(bytes)) return 'legacy_credential_cleanup_failed';
        if (cleaned.bytes) atomic(path, cleaned.bytes); else unlinkSync(path);
      }
    }
    const next = { ...marker }; delete next.legacyPlaintextCleanupSha256;
    atomic(markerPath, Buffer.from(JSON.stringify(next)));
    return undefined;
  } catch { return 'legacy_credential_cleanup_failed'; }
}

/** Runs synchronously before Chromium readiness; journal callbacks run asynchronously afterward. */
export function prepareWindowsProfile(options: {
  configRoot: string; appData: string; legacyUserDataDir?: string; legacyMigration?: boolean;
}): WindowsProfileResult {
  const configRoot = resolve(options.configRoot), profile = join(configRoot, 'electron'), targetPath = join(profile, 'Local State');
  protectExistingBackups(configRoot);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const markerPath = join(profile, 'credential-profile-owner.json');
  const markerBytes = read(markerPath, 4096), marker = markerBytes ? parse(markerBytes) : undefined;
  if (marker && (marker.version !== 1 && marker.version !== 2 || typeof marker.owned !== 'boolean')) throw new Error('WINDOWS_PROFILE_INVALID_MIGRATION_MARKER');
  let current = state(targetPath);
  const credentials = read(join(configRoot, '.credentials.enc'), CREDENTIAL_LIMIT);
  const plaintext = read(join(configRoot, '.credentials.json'), CREDENTIAL_LIMIT);
  let validPlaintext = false;
  if (plaintext) { try { validPlaintext = readLegacyClaudeOAuth(plaintext) !== null; } catch { /* An unusable compatibility file is still backed up. */ } }
  const own = (extra: RecordValue = {}): RecordValue => {
    const value = { version: 2, owned: true, ...(current?.key ? { keyDigest: digest(current.key) } : {}), ...extra };
    atomic(markerPath, Buffer.from(JSON.stringify(value))); return value;
  };
  const blocked = (keyError: WindowsCredentialKeyError, backupDirectory?: string): WindowsProfileResult => ({ status: 'blocked', keyError, backupDirectory });

  if (marker?.version === 2 && marker.owned === false) {
    const pending = pendingMarker(marker, configRoot);
    verifyBackup(pending);
    if (!credentials) throw new Error('WINDOWS_PROFILE_MIGRATION_CHANGED');
    const hash = digest(credentials);
    if (pending.pendingNewEncryptedSha256 === hash) {
      if (!current?.key) return blocked('windows_credentials_legacy_key_required', pending.backupDirectory);
      if (pending.keyDigest && pending.keyDigest !== digest(current.key)) return blocked('windows_credentials_key_conflict', pending.backupDirectory);
      const owned = own({ legacyPlaintextCleanupSha256: pending.legacyProof.plaintextSha256 });
      const warning = cleanupOwnedPlaintext(configRoot, markerPath, owned);
      return { status: 'current', backupDirectory: pending.backupDirectory,
        ...(warning ? { warning, legacyPlaintextCleanupSha256: pending.legacyProof.plaintextSha256 } : {}) };
    }
    if (hash !== pending.legacyProof.encryptedSha256 || !plaintext || digest(plaintext) !== pending.legacyProof.plaintextSha256 || !validPlaintext) {
      throw new Error('WINDOWS_PROFILE_MIGRATION_CHANGED');
    }
    const keyError = pending.keyError === 'windows_credentials_key_conflict' || pending.keyDigest && current?.key && pending.keyDigest !== digest(current.key)
      ? 'windows_credentials_key_conflict' : current?.key ? undefined : 'windows_credentials_legacy_key_required';
    return { status: keyError ? 'blocked' : 'current', ...(keyError ? { keyError } : {}), backupDirectory: pending.backupDirectory,
      legacyPlaintextProof: { ...pending.legacyProof }, legacyMigrationJournal: migrationJournal(configRoot, markerPath, pending) };
  }

  // A v2 owned marker always wins over leftover plaintext. A v1 marker predates coexistence handling.
  if (marker?.version === 2 && marker.owned === true) {
    if (marker.keyDigest !== undefined && !validHash(marker.keyDigest)) throw new Error('WINDOWS_PROFILE_INVALID_MIGRATION_MARKER');
    if (marker.keyDigest && current?.key && marker.keyDigest !== digest(current.key)) return blocked('windows_credentials_key_conflict');
    if (credentials && !current?.key) return blocked('windows_credentials_legacy_key_required');
    const warning = cleanupOwnedPlaintext(configRoot, markerPath, marker);
    if (!credentials && validPlaintext && marker.legacyPlaintextOnly !== true && (marker.legacyPlaintextCleanupSha256 === undefined || warning)) {
      throw new Error('WINDOWS_PROFILE_OWNED_CREDENTIAL_MISSING');
    }
    if (!warning && current?.key && (marker.keyDigest === undefined || credentials && marker.legacyPlaintextOnly === true)) {
      own(!credentials && marker.legacyPlaintextOnly === true ? { legacyPlaintextOnly: true } : {});
    }
    return { status: credentials ? 'current' : 'fresh',
      ...(warning ? { warning, legacyPlaintextCleanupSha256: marker.legacyPlaintextCleanupSha256 as string } : {}) };
  }
  if (credentials && !validPlaintext && current?.key && marker?.version === 1 && marker.owned === true
    && (marker.keyDigest === undefined || marker.keyDigest === digest(current.key))) {
    own(); return { status: 'current' };
  }
  if (!credentials && !plaintext) { own(); return { status: 'fresh' }; }

  const legacyPaths = options.legacyMigration === false ? [] : [join(options.appData, 'Klaus', 'Local State'),
    join(options.legacyUserDataDir || join(options.appData, 'klaus-desktop-dev'), 'Local State')];
  const paths = [...new Set([targetPath, ...legacyPaths].map(path => resolve(path)))];
  const states = paths.map(path => path === resolve(targetPath) ? current : state(path)).filter((value): value is State => value !== undefined);
  const sources = Buffer.from(JSON.stringify({ states: states.map((value, index) => ({ path: value.path, backup: `local-state-${index}.json`, sha256: digest(value.bytes) })) }));
  const identity = JSON.stringify({ encrypted: credentials ? digest(credentials) : null, plaintext: plaintext ? digest(plaintext) : null, sources: digest(sources) });
  const backupDirectory = join(configRoot, 'migration-backups', 'windows-credentials', digest(identity));
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  restrictPrivateDirectory(backupDirectory, configRoot);
  const backup = (name: string, bytes: Buffer): void => {
    const path = join(backupDirectory, name), existing = read(path, STATE_LIMIT);
    if (existing && !existing.equals(bytes)) throw new Error('WINDOWS_PROFILE_BACKUP_CONFLICT');
    if (!existing) { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); } }
  };
  if (credentials) backup('credentials.enc', credentials);
  if (plaintext) backup('credentials.json', plaintext);
  states.forEach((value, index) => backup(`local-state-${index}.json`, value.bytes));
  backup('sources.json', sources);
  restrictPrivateDirectory(backupDirectory, configRoot);
  if (!credentials) { own(validPlaintext ? { legacyPlaintextOnly: true } : {}); return { status: 'fresh', backupDirectory }; }

  let status: WindowsProfileResult['status'] = 'current';
  let keyError: WindowsCredentialKeyError | undefined;
  const keys = new Set(states.flatMap(value => value.key ? [value.key] : []));
  const selected = states.find(value => value.key);
  if (keys.size > 1 || record(current?.value.os_crypt)?.encrypted_key !== undefined && !current?.key) keyError = 'windows_credentials_key_conflict';
  else if (!selected?.key) keyError = 'windows_credentials_legacy_key_required';
  else if (current?.key !== selected.key) {
    const crypt = record(selected.value.os_crypt)!;
    const next = { ...current?.value, os_crypt: { ...record(current?.value.os_crypt), encrypted_key: selected.key,
      ...(typeof crypt.audit_enabled === 'boolean' ? { audit_enabled: crypt.audit_enabled } : {}) } };
    const latest = read(targetPath, STATE_LIMIT);
    if (Boolean(latest) !== Boolean(current) || latest && !latest.equals(current!.bytes)) throw new Error('WINDOWS_PROFILE_CHANGED_DURING_PREPARATION');
    atomic(targetPath, Buffer.from(JSON.stringify(next)));
    current = state(targetPath); status = 'restored';
  }
  if (validPlaintext && plaintext) {
    const pending: PendingMarker = { version: 2, owned: false, legacyProof: { encryptedSha256: digest(credentials), plaintextSha256: digest(plaintext) },
      backupDirectory, backupManifestSha256: digest(sources), ...(current?.key ? { keyDigest: digest(current.key) } : {}), ...(keyError ? { keyError } : {}) };
    if (!read(join(configRoot, '.credentials.enc'), CREDENTIAL_LIMIT)?.equals(credentials)
      || !read(join(configRoot, '.credentials.json'), CREDENTIAL_LIMIT)?.equals(plaintext)) throw new Error('WINDOWS_PROFILE_MIGRATION_CHANGED');
    verifyBackup(pending);
    atomic(markerPath, Buffer.from(JSON.stringify(pending)));
    return { status: keyError ? 'blocked' : status, ...(keyError ? { keyError } : {}), backupDirectory,
      legacyPlaintextProof: { ...pending.legacyProof }, legacyMigrationJournal: migrationJournal(configRoot, markerPath, pending) };
  }
  if (keyError) return blocked(keyError, backupDirectory);
  own(); return { status, backupDirectory };
}
