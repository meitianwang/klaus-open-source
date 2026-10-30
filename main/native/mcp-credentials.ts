import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Json } from '../ipc/contract';
import type { CredentialShutdownReport } from './credentials';
import type { WindowsSafeStorage } from './windows-credentials';
import { beforeDeadline, validDeadline } from './pty';

export type McpOAuthPart = 'discovery' | 'client' | 'tokens';
export interface McpRecordBackend {
  read(serverKey: string, part: McpOAuthPart): Promise<{ value: Json | null; error?: string }>;
  write(serverKey: string, part: McpOAuthPart, value: Json): Promise<{ success: boolean; error?: string }>;
  remove(serverKey: string, part: McpOAuthPart): Promise<boolean>;
}
type PendingMigration = {
  serverKey: string; part: McpOAuthPart; kind: 'write' | 'remove'; wasOwned: boolean;
  legacy?: { before: string; after: string | null };
};
type Journal = { owned: Set<string>; pending?: PendingMigration; bytes: Buffer | null };
type Operation = { id: string; until: number; mutation: boolean; settled: boolean; check(): void; reject(error: Error): void; done: Promise<void> };
type Legacy = { bytes: Buffer; value: Json; after: Buffer | null };
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORD = 512 * 1024;
const MAX_SLOTS = 4096;
const activeRoots = new Set<string>();
const fail = (code: string): Error => new Error(code);
const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const same = (left: Buffer | null, right: Buffer | null): boolean => left === null ? right === null : right !== null && hash(left) === hash(right);
function errorCode(error: unknown): string {
  return error instanceof Error && /^[A-Za-z_]+$/.test(error.message) ? error.message : 'mcp_credential_operation_failed';
}
export function mcpCredentialAccount(serverKey: string, part: McpOAuthPart): string {
  if (typeof serverKey !== 'string' || Buffer.byteLength(serverKey) > 1024 || /[\p{Cc}]/u.test(serverKey)
    || !/^.+\|[a-f0-9]{16}$/u.test(serverKey) || !['discovery', 'client', 'tokens'].includes(part)) throw fail('invalid_mcp_credential_key');
  return `mcp:oauth:${serverKey}:${part}`;
}
function jsonObject(text: string, maximum = MAX_BYTES): Record<string, Json> {
  if (Buffer.byteLength(text) > maximum) throw fail('mcp_credential_record_too_large');
  let value: Json;
  try { value = JSON.parse(text) as Json; } catch { throw fail('mcp_credential_record_unreadable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('mcp_credential_record_unreadable');
  return value;
}
function text(bytes: Buffer): string {
  if (!isUtf8(bytes)) throw fail('mcp_credential_record_unreadable');
  return bytes.toString('utf8');
}
function stringMap(value: Record<string, Json>): Record<string, string> {
  if (Object.keys(value).length > MAX_SLOTS || Object.values(value).some(item => typeof item !== 'string')) throw fail('mcp_credential_record_unreadable');
  return value as Record<string, string>;
}
async function readBytes(file: string): Promise<Buffer | null> {
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw fail('mcp_credential_file_read_failed');
  });
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) throw fail('mcp_credential_file_read_failed');
    const bytes = Buffer.alloc(MAX_BYTES + 1025);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) return bytes.subarray(0, offset);
      offset += result.bytesRead;
    }
    throw fail('mcp_credential_record_too_large');
  } finally { await handle.close(); }
}
async function durableDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomic(file: string, bytes: Buffer | null, expected: Buffer | null, operation: Operation): Promise<void> {
  operation.check();
  await mkdir(path.dirname(file), { recursive: true });
  operation.check();
  const temporary = `${file}.${operation.id}.tmp`;
  let handle;
  try {
    if (bytes !== null) {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    }
    if (!same(await readBytes(file), expected)) throw fail('mcp_credential_file_changed');
    operation.check(); operation.mutation = true;
    if (bytes === null) await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    else await rename(temporary, file);
    await durableDirectory(path.dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/** Main-only transactions. Legacy plaintext is read solely to migrate into a working secure backend. */
export class McpCredentialStore {
  private readonly rootKey: string;
  private readonly legacyPath: string;
  private readonly journalPath: string;
  private readonly encryptedPath: string;
  private readonly pending = new Map<string, Operation>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(readonly resourceId: string, readonly configRoot: string, private readonly backend: McpRecordBackend,
    private readonly storage?: WindowsSafeStorage, private readonly deadlineMs = 30_000) {
    if (!path.isAbsolute(configRoot)) throw fail('INVALID_PATH');
    validDeadline(deadlineMs);
    this.rootKey = process.platform === 'win32' ? path.resolve(configRoot).toLowerCase() : path.resolve(configRoot);
    if (activeRoots.has(this.rootKey)) throw fail('MCP_CREDENTIAL_RESOURCE_IN_USE');
    activeRoots.add(this.rootKey);
    this.legacyPath = path.join(configRoot, '.mcp-credentials.json');
    this.journalPath = path.join(configRoot, '.mcp-credential-migrations.json');
    this.encryptedPath = path.join(configRoot, '.mcp-credentials.enc');
  }

  private enqueue<T>(run: (operation: Operation) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(fail('CREDENTIALS_CLOSED'));
    if (this.pending.size >= 8) return Promise.reject(fail('BUSY'));
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const operation: Operation = {
        id: randomUUID(), until: Date.now() + this.deadlineMs, mutation: false, settled: false, done: Promise.resolve(),
        check: () => {
          if (this.closed || Date.now() >= operation.until) throw fail(operation.mutation ? 'credential_operation_outcome_unknown' : this.closed ? 'CREDENTIALS_CLOSED' : 'DEADLINE_EXCEEDED');
        },
        reject: error => { if (!operation.settled) { operation.settled = true; clearTimeout(timer); reject(error); } },
      };
      timer = setTimeout(() => operation.reject(fail(operation.mutation ? 'credential_operation_outcome_unknown' : 'DEADLINE_EXCEEDED')), this.deadlineMs);
      timer.unref(); this.pending.set(operation.id, operation);
      operation.done = this.tail.then(async () => {
        try {
          operation.check(); const result = await run(operation); operation.check();
          if (!operation.settled) { operation.settled = true; clearTimeout(timer); resolve(result); }
        } catch (error) { operation.reject(fail(errorCode(error))); }
        finally {
          this.pending.delete(operation.id);
          if (this.closed && this.pending.size === 0) activeRoots.delete(this.rootKey);
        }
      });
      this.tail = operation.done;
    });
  }

  private async encrypted(operation: Operation): Promise<{ bytes: Buffer | null; records: Record<string, string> }> {
    if (!await this.storage!.isAsyncEncryptionAvailable()) throw fail('mcp_credential_encryption_unavailable');
    operation.check();
    const bytes = await readBytes(this.encryptedPath); operation.check();
    if (!bytes) return { bytes, records: {} };
    let decrypted;
    try { decrypted = await this.storage!.decryptStringAsync(bytes); }
    catch { throw fail('mcp_credential_decryption_failed'); }
    operation.check();
    const value = jsonObject(decrypted.result);
    if (value.version !== 1 || !value.records || typeof value.records !== 'object' || Array.isArray(value.records)) throw fail('mcp_credential_record_unreadable');
    return { bytes, records: stringMap(value.records) };
  }
  private async secureRead(serverKey: string, part: McpOAuthPart, operation: Operation): Promise<Json | null> {
    operation.check();
    if (this.storage) {
      const current = await this.encrypted(operation);
      const account = mcpCredentialAccount(serverKey, part);
      return Object.hasOwn(current.records, account) ? jsonObject(current.records[account]!, MAX_RECORD) : null;
    }
    const result = await this.backend.read(serverKey, part); operation.check();
    if (result.error) throw fail(result.error);
    return result.value;
  }
  private async secureWrite(serverKey: string, part: McpOAuthPart, value: Json | null, operation: Operation): Promise<void> {
    operation.check();
    if (this.storage) {
      const current = await this.encrypted(operation);
      const account = mcpCredentialAccount(serverKey, part);
      if (value === null) delete current.records[account];
      else current.records[account] = JSON.stringify(value);
      const raw = JSON.stringify({ version: 1, records: current.records });
      if (Buffer.byteLength(raw) > MAX_BYTES || Object.keys(current.records).length > MAX_SLOTS) throw fail('mcp_credential_record_too_large');
      let encrypted;
      try { encrypted = await this.storage.encryptStringAsync(raw); }
      catch { throw fail('mcp_credential_encryption_failed'); }
      operation.check();
      if (!Buffer.isBuffer(encrypted) || encrypted.length < 16 || encrypted.length > MAX_BYTES + 1024 || encrypted.equals(Buffer.from(raw))) throw fail('mcp_credential_encryption_failed');
      await atomic(this.encryptedPath, encrypted, current.bytes, operation);
      return;
    }
    operation.mutation = true;
    if (value === null) { if (!await this.backend.remove(serverKey, part)) throw fail('mcp_credential_delete_failed'); }
    else { const result = await this.backend.write(serverKey, part, value); if (!result.success) throw fail(result.error ?? 'mcp_credential_write_failed'); }
    operation.check();
  }

  private async journal(operation: Operation): Promise<Journal> {
    const bytes = await readBytes(this.journalPath); operation.check();
    if (!bytes) return { owned: new Set(), bytes };
    const value = jsonObject(text(bytes));
    if (value.version !== 1 || !Array.isArray(value.owned) || value.owned.length > MAX_SLOTS
      || value.owned.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))) throw fail('mcp_credential_journal_invalid');
    let pending: PendingMigration | undefined;
    if (value.pending !== undefined) {
      const raw = value.pending;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.serverKey !== 'string' || typeof raw.part !== 'string'
        || !['write', 'remove'].includes(String(raw.kind)) || typeof raw.wasOwned !== 'boolean') throw fail('mcp_credential_journal_invalid');
      mcpCredentialAccount(raw.serverKey, raw.part as McpOAuthPart);
      if (raw.legacy !== undefined) {
        const legacy = raw.legacy;
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || typeof legacy.before !== 'string' || !/^[a-f0-9]{64}$/.test(legacy.before)
          || legacy.after !== null && (typeof legacy.after !== 'string' || !/^[a-f0-9]{64}$/.test(legacy.after))) throw fail('mcp_credential_journal_invalid');
      }
      pending = raw as unknown as PendingMigration;
    }
    return { bytes, owned: new Set(value.owned as string[]), pending };
  }
  private async save(journal: Journal, operation: Operation): Promise<void> {
    if (journal.owned.size > MAX_SLOTS) throw fail('mcp_credential_record_too_large');
    const bytes = Buffer.from(JSON.stringify({ version: 1, owned: [...journal.owned].sort(), pending: journal.pending }));
    await atomic(this.journalPath, bytes, journal.bytes, operation); journal.bytes = bytes;
  }
  private async legacy(account: string, operation: Operation): Promise<Legacy | undefined> {
    const bytes = await readBytes(this.legacyPath); operation.check();
    if (!bytes) return undefined;
    const records = stringMap(jsonObject(text(bytes)));
    if (!Object.hasOwn(records, account)) return undefined;
    const value = jsonObject(records[account]!, MAX_RECORD);
    const cleaned = { ...records }; delete cleaned[account];
    return { bytes, value, after: Object.keys(cleaned).length ? Buffer.from(JSON.stringify(cleaned)) : null };
  }
  private async backup(legacy: Legacy, operation: Operation): Promise<void> {
    operation.check();
    const file = path.join(this.configRoot, `.mcp-credentials.backup-${hash(legacy.bytes)}.json`);
    await mkdir(this.configRoot, { recursive: true }); operation.check();
    const existing = await readBytes(file); operation.check();
    if (existing) { if (!same(existing, legacy.bytes)) throw fail('mcp_credential_backup_invalid'); return; }
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(legacy.bytes); await handle.sync(); } finally { await handle.close(); }
    await durableDirectory(this.configRoot); operation.check();
  }
  private async cleanup(pending: PendingMigration, operation: Operation): Promise<void> {
    if (!pending.legacy) return;
    const backup = await readBytes(path.join(this.configRoot, `.mcp-credentials.backup-${pending.legacy.before}.json`));
    operation.check();
    if (!backup || hash(backup) !== pending.legacy.before) throw fail('mcp_credential_backup_invalid');
    const bytes = await readBytes(this.legacyPath); operation.check();
    const currentHash = bytes === null ? null : hash(bytes);
    if (currentHash === pending.legacy.after) return;
    if (!bytes || currentHash !== pending.legacy.before) throw fail('mcp_legacy_credential_changed');
    const records = stringMap(jsonObject(text(bytes)));
    delete records[mcpCredentialAccount(pending.serverKey, pending.part)];
    const after = Object.keys(records).length ? Buffer.from(JSON.stringify(records)) : null;
    if ((after === null ? null : hash(after)) !== pending.legacy.after) throw fail('mcp_credential_journal_invalid');
    await atomic(this.legacyPath, after, bytes, operation);
  }
  private async recover(journal: Journal, operation: Operation): Promise<void> {
    const pending = journal.pending;
    if (!pending) return;
    const key = hash(mcpCredentialAccount(pending.serverKey, pending.part));
    if (pending.kind === 'write' && await this.secureRead(pending.serverKey, pending.part, operation) === null && !journal.owned.has(key)) {
      if (pending.wasOwned) journal.owned.add(key); else journal.owned.delete(key);
      journal.pending = undefined; await this.save(journal, operation); return;
    }
    journal.owned.add(key); await this.save(journal, operation);
    // Delete is idempotent. A durable delete intent cannot revive the legacy record after a crash.
    if (pending.kind === 'remove') await this.secureWrite(pending.serverKey, pending.part, null, operation);
    await this.cleanup(pending, operation);
    journal.pending = undefined; await this.save(journal, operation);
  }
  private async prepare(journal: Journal, serverKey: string, part: McpOAuthPart, kind: 'write' | 'remove', operation: Operation, selected?: Legacy): Promise<void> {
    const key = hash(mcpCredentialAccount(serverKey, part));
    if (selected) await this.backup(selected, operation);
    const pending: PendingMigration = { serverKey, part, kind, wasOwned: journal.owned.has(key),
      legacy: selected ? { before: hash(selected.bytes), after: selected.after === null ? null : hash(selected.after) } : undefined };
    if (kind === 'remove') journal.owned.add(key);
    journal.pending = pending; await this.save(journal, operation);
    if (selected && !same(await readBytes(this.legacyPath), selected.bytes)) throw fail('mcp_legacy_credential_changed');
    operation.check();
  }
  private async finish(journal: Journal, operation: Operation): Promise<void> {
    const pending = journal.pending!;
    journal.owned.add(hash(mcpCredentialAccount(pending.serverKey, pending.part))); await this.save(journal, operation);
    await this.cleanup(pending, operation); journal.pending = undefined; await this.save(journal, operation);
  }

  async readMcpOAuthRecord(serverKey: string, part: McpOAuthPart): Promise<{ value: Json | null; error?: string }> {
    try {
      const account = mcpCredentialAccount(serverKey, part);
      return await this.enqueue(async operation => {
        const journal = await this.journal(operation); await this.recover(journal, operation);
        const current = await this.secureRead(serverKey, part, operation);
        if (current !== null || journal.owned.has(hash(account))) return { value: current };
        const legacy = await this.legacy(account, operation);
        if (!legacy) return { value: null };
        await this.prepare(journal, serverKey, part, 'write', operation, legacy);
        await this.secureWrite(serverKey, part, legacy.value, operation);
        await this.finish(journal, operation);
        return { value: legacy.value };
      });
    } catch (error) { return { value: null, error: errorCode(error) }; }
  }
  async writeMcpOAuthRecord(serverKey: string, part: McpOAuthPart, value: Json): Promise<{ success: boolean; error?: string; warning?: string }> {
    try {
      const account = mcpCredentialAccount(serverKey, part);
      const snapshot = jsonObject(JSON.stringify(value), MAX_RECORD);
      return await this.enqueue(async operation => {
        const journal = await this.journal(operation); await this.recover(journal, operation);
        // A failed or corrupt secure read must never be reinterpreted as an empty store to overwrite.
        await this.secureRead(serverKey, part, operation);
        const selected = journal.owned.has(hash(account)) ? undefined : await this.legacy(account, operation);
        await this.prepare(journal, serverKey, part, 'write', operation, selected);
        await this.secureWrite(serverKey, part, snapshot, operation);
        try { await this.finish(journal, operation); }
        catch (error) { operation.check(); return { success: true, warning: errorCode(error) }; }
        return { success: true };
      });
    } catch (error) { return { success: false, error: errorCode(error) }; }
  }
  async removeMcpOAuthRecord(serverKey: string, part: McpOAuthPart): Promise<boolean> {
    try {
      const account = mcpCredentialAccount(serverKey, part);
      return await this.enqueue(async operation => {
        const journal = await this.journal(operation); await this.recover(journal, operation);
        await this.secureRead(serverKey, part, operation);
        const selected = journal.owned.has(hash(account)) ? undefined : await this.legacy(account, operation);
        await this.prepare(journal, serverKey, part, 'remove', operation, selected);
        await this.secureWrite(serverKey, part, null, operation); await this.finish(journal, operation);
        return true;
      });
    } catch { return false; }
  }
  async close(deadlineMs = 2000): Promise<CredentialShutdownReport> {
    validDeadline(deadlineMs); this.closed = true;
    for (const operation of this.pending.values()) operation.reject(fail(operation.mutation ? 'credential_operation_outcome_unknown' : 'CREDENTIALS_CLOSED'));
    const settled = await beforeDeadline(this.tail, Date.now() + deadlineMs);
    if (this.pending.size === 0) activeRoots.delete(this.rootKey);
    return { resourceId: this.resourceId, complete: settled.done && this.pending.size === 0, pendingOperations: [...this.pending.keys()] };
  }
}
