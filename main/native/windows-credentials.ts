import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { mkdir, open, rename, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Json } from '../ipc/contract';
import type { CredentialShutdownReport } from './credentials';

/** Inject Electron's built-in native capability after app readiness. Never expose it over IPC. */
export interface WindowsSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
export type WindowsCredentialKeyError = 'windows_credentials_legacy_key_required' | 'windows_credentials_key_conflict';
export interface WindowsLegacyPlaintextProof { encryptedSha256: string; plaintextSha256: string }
/** The startup/profile owner persists these transitions atomically; neither callback may resolve before durability. */
export interface WindowsLegacyMigrationJournal {
  prepare(encryptedSha256: string): Promise<void>;
  commit(encryptedSha256: string): Promise<void>;
}

type RecordValue = { [key: string]: Json };
type Operation = {
  id: string;
  expires: number;
  mutationStarted: boolean;
  settled: boolean;
  timer: NodeJS.Timeout;
  run: (operation: Operation) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
const MAX_BYTES = 1024 * 1024;
const MAX_PENDING = 8;
const fail = (code: string): Error => new Error(code);
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function code(error: unknown): string {
  return error instanceof Error && /^[a-zA-Z_]+$/.test(error.message) ? error.message : 'windows_credential_operation_failed';
}
function record(text: string): RecordValue {
  if (Buffer.byteLength(text) > MAX_BYTES) throw fail('credential_record_too_large');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw fail('credential_record_unreadable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('credential_record_unreadable');
  return value as RecordValue;
}
function removeKeys(value: RecordValue): boolean {
  // The account queue is the current login shape; the historical token keys
  // stay logout targets for records older builds wrote.
  const changed = 'claudeAiOauth' in value || 'tokens' in value || 'accounts' in value;
  delete value.claudeAiOauth;
  delete value.tokens;
  delete value.accounts;
  return changed;
}
function claudeOAuth(value: RecordValue | null): Json | null {
  for (const candidate of [value?.claudeAiOauth, value?.tokens]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && typeof candidate.accessToken === 'string' && candidate.accessToken.trim()) return candidate;
  }
  return null;
}
/** The stored account queue, head first; the historical single-key shape
 *  reads as one legacy account until the next write rewrites it. */
function claudeAccountsOf(value: RecordValue | null): Json[] {
  if (Array.isArray(value?.accounts)) {
    return value.accounts.filter(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const row = entry as Record<string, unknown>;
      const tokens = row.tokens as Record<string, unknown> | undefined;
      return typeof row.id === 'string' && row.id.trim().length > 0
        && !!tokens && typeof tokens === 'object' && !Array.isArray(tokens)
        && typeof tokens.accessToken === 'string' && tokens.accessToken.trim().length > 0;
    });
  }
  const legacy = claudeOAuth(value) ?? (value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).accessToken === 'string'
    && String((value as Record<string, unknown>).accessToken).trim() ? value : null);
  return legacy === null ? [] : [{ id: 'legacy', tokens: legacy }];
}
/** Shared with synchronous startup recovery. Callers must validate the raw-byte backup hash first. */
function plaintextRecord(bytes: Buffer): RecordValue {
  if (!isUtf8(bytes)) throw fail('credential_record_unreadable');
  return record(bytes.toString('utf8'));
}
/** Directory lock shared with the engine's rotation writer: mkdir is atomic,
 *  a lock older than two minutes is stale and reclaimed. */
async function withAccountLock<T>(configRoot: string, run: () => Promise<T>): Promise<T> {
  const lockDir = path.join(configRoot, '.locks', 'claude-accounts-rotation.lock');
  await mkdir(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + 6_000;
  for (;;) {
    try { await mkdir(lockDir); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fail('credential_file_write_failed');
      let stale = false;
      try {
        const meta = await stat(lockDir);
        stale = Date.now() - meta.mtimeMs > 120_000;
      } catch { stale = false; }
      if (stale) { await rmdir(lockDir).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw fail('credential_file_write_failed');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await run(); }
  finally { await rmdir(lockDir).catch(() => {}); }
}
export function readLegacyClaudeOAuth(bytes: Buffer): Json | null { return claudeOAuth(plaintextRecord(bytes)); }
export function pruneLegacyClaudeOAuth(bytes: Buffer): { changed: boolean; bytes: Buffer | null } {
  const value = plaintextRecord(bytes);
  if (!removeKeys(value)) return { changed: false, bytes };
  return { changed: true, bytes: Object.keys(value).length ? Buffer.from(JSON.stringify(value)) : null };
}
async function readOptional(file: string): Promise<Buffer | null> {
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw fail('credential_file_read_failed');
  });
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) throw fail('credential_file_read_failed');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) return bytes.subarray(0, offset);
      offset += result.bytesRead;
    }
    throw fail('credential_record_too_large');
  } finally { await handle.close(); }
}
async function removeFile(file: string): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw fail('credential_file_write_failed');
  });
}

/** A bounded transaction queue around Electron's Windows OSCrypt/DPAPI implementation. */
export class WindowsCredentialStore {
  private readonly encrypted: string;
  private readonly plaintext: string;
  private readonly copy: string;
  private readonly queue: Operation[] = [];
  private readonly pending = new Map<string, Operation>();
  private running = false;
  private closed = false;
  private closing?: Promise<CredentialShutdownReport>;
  private onIdle?: () => void;
  private legacyProof?: WindowsLegacyPlaintextProof;
  private pendingJournalCommit?: string;
  private plaintextCleanupSha256?: string;
  private plaintextFallbackAllowed = true;

  constructor(
    readonly resourceId: string,
    readonly configRoot: string,
    private readonly storage: WindowsSafeStorage,
    private readonly deadlineMs = 30_000,
    private keyError?: WindowsCredentialKeyError,
    legacyPlaintextProof?: WindowsLegacyPlaintextProof,
    private readonly migrationJournal?: WindowsLegacyMigrationJournal,
    legacyPlaintextCleanupSha256?: string,
  ) {
    if (!path.isAbsolute(configRoot)) throw fail('INVALID_PATH');
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) throw fail('INVALID_DEADLINE');
    this.encrypted = path.join(configRoot, '.credentials.enc');
    this.plaintext = path.join(configRoot, '.credentials.json');
    // The cross-platform copy the engine CLI writes on this platform. Read
    // as a migration source only; the DPAPI store stays the desktop's own.
    this.copy = path.join(configRoot, 'claude-subscription-oauth.json');
    if (legacyPlaintextProof) {
      if (![legacyPlaintextProof.encryptedSha256, legacyPlaintextProof.plaintextSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
        throw fail('windows_legacy_plaintext_proof_invalid');
      }
      this.legacyProof = { ...legacyPlaintextProof };
    }
    if (legacyPlaintextCleanupSha256 !== undefined) {
      if (legacyPlaintextProof || !/^[a-f0-9]{64}$/.test(legacyPlaintextCleanupSha256)) throw fail('windows_legacy_plaintext_proof_invalid');
      this.plaintextCleanupSha256 = legacyPlaintextCleanupSha256;
      this.plaintextFallbackAllowed = false;
    }
  }

  private check(operation: Operation): void {
    if (this.closed) throw fail(operation.mutationStarted ? 'credential_operation_outcome_unknown' : 'CREDENTIALS_CLOSED');
    if (Date.now() >= operation.expires) throw fail(operation.mutationStarted ? 'credential_operation_outcome_unknown' : 'DEADLINE_EXCEEDED');
  }
  private settle(operation: Operation, error?: Error, value?: unknown): void {
    if (operation.settled) return;
    operation.settled = true;
    clearTimeout(operation.timer);
    if (error) operation.reject(error); else operation.resolve(value);
  }
  private enqueue<T>(run: (operation: Operation) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(fail('CREDENTIALS_CLOSED'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(fail('BUSY'));
    return new Promise<T>((resolve, reject) => {
      const operation: Operation = {
        id: randomUUID(), expires: Date.now() + this.deadlineMs, mutationStarted: false, settled: false,
        timer: undefined as unknown as NodeJS.Timeout, run,
        resolve: value => resolve(value as T), reject,
      };
      operation.timer = setTimeout(() => this.settle(operation, fail(operation.mutationStarted ? 'credential_operation_outcome_unknown' : 'DEADLINE_EXCEEDED')), this.deadlineMs);
      operation.timer.unref();
      this.pending.set(operation.id, operation);
      this.queue.push(operation);
      if (!this.running) void this.drain();
    });
  }
  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length) {
        const operation = this.queue.shift()!;
        try {
          this.check(operation);
          const value = await operation.run(operation);
          this.check(operation);
          this.settle(operation, undefined, value);
        } catch (error) { this.settle(operation, fail(code(error))); }
        finally { this.pending.delete(operation.id); }
      }
    } finally {
      this.running = false;
      this.onIdle?.();
    }
  }

  private async decrypt(bytes: Buffer, operation: Operation): Promise<RecordValue> {
    if (!await this.storage.isAsyncEncryptionAvailable()) throw fail('windows_credential_encryption_unavailable');
    this.check(operation);
    let decrypted: { result: string; shouldReEncrypt: boolean };
    try { decrypted = await this.storage.decryptStringAsync(bytes); }
    catch { throw fail('windows_credentials_decryption_failed'); }
    this.check(operation);
    // A read does not silently re-encrypt the file or alter an old profile's key dependency.
    return record(decrypted.result);
  }
  private async readEncrypted(operation: Operation): Promise<RecordValue | null> {
    const bytes = await readOptional(this.encrypted);
    this.check(operation);
    if (bytes === null) return null;
    this.plaintextFallbackAllowed = false;
    if (this.keyError) throw fail(this.keyError);
    return this.decrypt(bytes, operation);
  }
  private async readPlaintext(operation: Operation): Promise<RecordValue | null> {
    const bytes = await readOptional(this.plaintext);
    this.check(operation);
    return bytes === null ? null : plaintextRecord(bytes);
  }
  private async readRecord(operation: Operation): Promise<RecordValue | null> {
    if (this.legacyProof) {
      const { encrypted, plaintext } = await this.verifyProof(operation);
      const current = plaintextRecord(plaintext);
      const tokens = claudeOAuth(current);
      if (!tokens) throw fail('windows_legacy_plaintext_credential_invalid');
      let previous: RecordValue = {};
      try { previous = await this.decrypt(encrypted, operation); }
      catch (error) {
        // The opaque original is protected by the startup backup. An unavailable current backend is not a decryption failure.
        if (!['windows_credentials_decryption_failed', 'credential_record_unreadable'].includes(code(error))) throw error;
      }
      await this.verifyProof(operation);
      return { ...previous, ...current, claudeAiOauth: tokens };
    }
    const encrypted = await this.readEncrypted(operation);
    if (encrypted) return encrypted;
    if (this.plaintextFallbackAllowed) {
      const plaintext = await this.readPlaintext(operation);
      if (plaintext) return plaintext;
    }
    // A login the engine CLI wrote on this platform: read it as a migration
    // source so the desktop sees the same sign-in the CLI created.
    return this.readCopy(operation);
  }
  private async readCopy(operation: Operation): Promise<RecordValue | null> {
    const bytes = await readOptional(this.copy);
    this.check(operation);
    return bytes === null ? null : plaintextRecord(bytes);
  }
  /** Remove the login keys from the cross-platform copy, if it holds them. */
  private async pruneCopy(operation: Operation): Promise<void> {
    const bytes = await readOptional(this.copy);
    this.check(operation);
    if (!bytes) return;
    const cleaned = pruneLegacyClaudeOAuth(bytes);
    if (!cleaned.changed) return;
    if (cleaned.bytes) await this.writeAtomic(this.copy, cleaned.bytes, operation);
    else { operation.mutationStarted = true; await removeFile(this.copy); }
  }
  private async verifyProof(operation: Operation): Promise<{ encrypted: Buffer; plaintext: Buffer }> {
    const proof = this.legacyProof;
    if (!proof) throw fail('windows_legacy_plaintext_proof_invalid');
    const [encrypted, plaintext] = await Promise.all([readOptional(this.encrypted), readOptional(this.plaintext)]);
    this.check(operation);
    if (!encrypted || !plaintext || digest(encrypted) !== proof.encryptedSha256 || digest(plaintext) !== proof.plaintextSha256) {
      throw fail('windows_legacy_plaintext_proof_invalid');
    }
    return { encrypted, plaintext };
  }
  private async writeAtomic(file: string, bytes: Buffer, operation: Operation, beforeCommit?: () => Promise<void>): Promise<void> {
    this.check(operation);
    await mkdir(this.configRoot, { recursive: true });
    this.check(operation);
    const temporary = path.join(this.configRoot, `.credentials-${operation.id}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      this.check(operation);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await beforeCommit?.();
      this.check(operation);
      operation.mutationStarted = true;
      await rename(temporary, file);
    } finally {
      await handle.close().catch(() => {});
      await removeFile(temporary).catch(() => {});
    }
  }
  private async finishJournal(operation: Operation): Promise<void> {
    if (!this.pendingJournalCommit) return;
    this.check(operation);
    try { await this.migrationJournal!.commit(this.pendingJournalCommit); }
    catch { throw fail('windows_credential_migration_commit_pending'); }
    this.pendingJournalCommit = undefined;
    this.check(operation);
  }
  private async persist(recordValue: RecordValue, operation: Operation): Promise<boolean> {
    this.check(operation);
    if (this.legacyProof && this.keyError === 'windows_credentials_key_conflict') throw fail(this.keyError);
    if (this.legacyProof && !this.migrationJournal) throw fail('windows_credential_migration_journal_required');
    if (!await this.storage.isAsyncEncryptionAvailable()) throw fail('windows_credential_encryption_unavailable');
    this.check(operation);
    const text = JSON.stringify(recordValue);
    if (Buffer.byteLength(text) > MAX_BYTES / 2) throw fail('credential_record_too_large');
    let encrypted: Buffer;
    try { encrypted = await this.storage.encryptStringAsync(text); }
    catch { throw fail('windows_credential_encryption_failed'); }
    this.check(operation);
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 16 || encrypted.length > MAX_BYTES || encrypted.equals(Buffer.from(text))) {
      throw fail('windows_credential_encryption_failed');
    }
    const proof = this.legacyProof;
    const encryptedSha256 = digest(encrypted);
    if (proof) {
      await this.verifyProof(operation);
      try { await this.migrationJournal!.prepare(encryptedSha256); }
      catch (error) { throw fail(code(error).startsWith('WINDOWS_PROFILE_') ? code(error) : 'windows_credential_migration_prepare_failed'); }
    }
    await this.writeAtomic(this.encrypted, encrypted, operation, proof ? async () => { await this.verifyProof(operation); } : undefined);
    this.plaintextFallbackAllowed = false;
    if (proof) {
      // The durable intent already identifies this encrypted file after a crash. Never consult the old plaintext again.
      this.legacyProof = undefined;
      this.keyError = undefined;
      this.plaintextCleanupSha256 = proof.plaintextSha256;
      this.pendingJournalCommit = encryptedSha256;
      try { await this.finishJournal(operation); }
      catch {
        this.check(operation);
        return false;
      }
    }
    return true;
  }
  private async prunePlaintext(operation: Operation): Promise<void> {
    const bytes = await readOptional(this.plaintext);
    this.check(operation);
    if (!bytes) { this.plaintextCleanupSha256 = undefined; return; }
    const originalSha256 = digest(bytes);
    if (this.plaintextCleanupSha256 && originalSha256 !== this.plaintextCleanupSha256) throw fail('windows_legacy_plaintext_proof_invalid');
    const cleaned = pruneLegacyClaudeOAuth(bytes);
    if (!cleaned.changed) { this.plaintextCleanupSha256 = undefined; return; }
    const unchanged = async () => {
      const current = await readOptional(this.plaintext);
      this.check(operation);
      if (!current || digest(current) !== originalSha256) throw fail('windows_legacy_plaintext_proof_invalid');
    };
    if (cleaned.bytes) {
      await this.writeAtomic(this.plaintext, cleaned.bytes, operation, unchanged);
    } else {
      await unchanged();
      operation.mutationStarted = true;
      await removeFile(this.plaintext);
    }
    this.plaintextCleanupSha256 = undefined;
  }

  async readClaudeOAuth(): Promise<{ value: Json | null; error?: string }> {
    try {
      return await this.enqueue(async operation => {
        const value = await this.readRecord(operation);
        return { value: claudeOAuth(value) };
      });
    } catch (error) { return { value: null, error: code(error) }; }
  }
  async readClaudeAccounts(): Promise<{ accounts: Json[]; error?: string }> {
    try {
      return await this.enqueue(async operation => {
        const value = await this.readRecord(operation);
        return { accounts: claudeAccountsOf(value) };
      });
    } catch (error) { return { accounts: [], error: code(error) }; }
  }
  async writeClaudeAccounts(accounts: Json[]): Promise<{ success: boolean; warning?: string; error?: string }> {
    try {
      if (!Array.isArray(accounts) || accounts.length > 32) throw fail('invalid_claude_credential');
      const snapshot = accounts.map(entry => record(JSON.stringify(entry)));
      return await this.enqueue(async operation => {
        await this.finishJournal(operation);
        await withAccountLock(this.configRoot, async () => {
          const current = await this.readRecord(operation) ?? {};
          current.accounts = snapshot;
          if (!await this.persist(current, operation)) throw fail('windows_credential_migration_commit_pending');
        });
        try { await this.prunePlaintext(operation); }
        catch (error) {
          if (this.closed || Date.now() >= operation.expires) throw error;
          return { success: true, warning: 'legacy_credential_cleanup_failed' };
        }
        try { await this.pruneCopy(operation); }
        catch (error) {
          if (this.closed || Date.now() >= operation.expires) throw error;
          return { success: true, warning: 'legacy_credential_cleanup_failed' };
        }
        return { success: true };
      });
    } catch (error) { return { success: false, error: code(error) }; }
  }
  async writeClaudeOAuth(tokens: Json): Promise<{ success: boolean; warning?: string; error?: string }> {
    try {
      if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens) || Buffer.byteLength(JSON.stringify(tokens)) > MAX_BYTES / 2) throw fail('invalid_claude_credential');
      // Snapshot before admission so later caller mutation cannot change a queued write.
      const snapshot = record(JSON.stringify(tokens));
      return await this.enqueue(async operation => {
        await this.finishJournal(operation);
        const current = await this.readRecord(operation) ?? {};
        removeKeys(current);
        current.claudeAiOauth = snapshot;
        if (!await this.persist(current, operation)) return { success: true, warning: 'windows_credential_migration_commit_pending' };
        try { await this.prunePlaintext(operation); }
        catch (error) {
          if (this.closed || Date.now() >= operation.expires) throw error;
          return { success: true, warning: 'legacy_credential_cleanup_failed' };
        }
        try { await this.pruneCopy(operation); }
        catch (error) {
          if (this.closed || Date.now() >= operation.expires) throw error;
          return { success: true, warning: 'legacy_credential_cleanup_failed' };
        }
        return { success: true };
      });
    } catch (error) { return { success: false, error: code(error) }; }
  }
  async removeClaudeOAuth(): Promise<boolean> {
    try {
      return await this.enqueue(async operation => {
        await this.finishJournal(operation);
        if (this.legacyProof) {
          const current = await this.readRecord(operation) ?? {};
          removeKeys(current);
          // An encrypted empty record is a durable logout tombstone for startup recovery.
          if (!await this.persist(current, operation)) return false;
          await this.prunePlaintext(operation);
          return true;
        }
        let primaryOk = true;
        try {
          const current = await this.readEncrypted(operation);
          if (current && removeKeys(current)) {
            this.check(operation);
            // Keep a durable encrypted logout tombstone, including when legacy cleanup fails or a process exits mid-cleanup.
            await this.persist(current, operation);
          }
        } catch { primaryOk = false; }
        let plaintextOk = true;
        try { await this.prunePlaintext(operation); } catch { plaintextOk = false; }
        let copyOk = true;
        try { await this.pruneCopy(operation); } catch { copyOk = false; }
        return primaryOk && plaintextOk && copyOk;
      });
    } catch { return false; }
  }
  close(deadlineMs = 2000): Promise<CredentialShutdownReport> {
    if (this.closing) return this.closing;
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) throw fail('INVALID_DEADLINE');
    this.closed = true;
    for (const operation of this.pending.values()) {
      this.settle(operation, fail(operation.mutationStarted ? 'credential_operation_outcome_unknown' : 'CREDENTIALS_CLOSED'));
    }
    for (const operation of this.queue.splice(0)) this.pending.delete(operation.id);
    return this.closing = new Promise(resolve => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        this.onIdle = undefined;
        resolve({ resourceId: this.resourceId, complete: !this.running, pendingOperations: [...this.pending.keys()] });
      };
      if (!this.running) finish();
      else {
        this.onIdle = finish;
        timer = setTimeout(finish, deadlineMs);
        timer.unref();
      }
    });
  }
}
