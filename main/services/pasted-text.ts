import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { object, string, type JsonObject } from './service-types';
import type { WorkspaceStore } from './workspaces';

/**
 * Large pastes become host-owned text files instead of riding inside the
 * composer buffer or the message payload.
 *
 * The composer only ever holds a reference (path, preview, character count),
 * so a multi-megabyte paste cannot bloat drafts, queues, or the wire format.
 * Each attachment lives in its own directory under `<configRoot>/pasted-text/`
 * as `pasted-text.txt`. A ledger beside those directories records the paths a
 * not-yet-submitted composer draft owns; submitting releases the ledger entry
 * while the file stays on disk because the sent message still references it,
 * and removing a card deletes the file. `pendingRemovalPaths` exists so a
 * crash between "marked for deletion" and "deleted" is finished on startup.
 */
export const PASTED_TEXT_FILE_NAME = 'pasted-text.txt';
const LEDGER_FILE_NAME = 'pasted-text-attachments.json';
const DIRECTORY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Restoring a paste into the editable composer is bounded: beyond this the
 *  text field is the wrong surface and the caller reports a restore failure. */
export const PASTED_TEXT_RESTORE_LIMIT = 25_000;
/** Creation is bounded too; a clipboard blob larger than this is refused
 *  rather than written to disk. */
const PASTED_TEXT_CREATE_LIMIT = 10 * 1024 * 1024;

interface Ledger {
  attachmentPaths: string[];
  pendingRemovalPaths: string[];
}

const emptyLedger = (): Ledger => ({ attachmentPaths: [], pendingRemovalPaths: [] });

function normalizeLedger(value: unknown): Ledger {
  if (!value || typeof value !== 'object') return emptyLedger();
  const candidate = value as Partial<Ledger>;
  const list = (input: unknown): string[] => (
    Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
  );
  return { attachmentPaths: list(candidate.attachmentPaths), pendingRemovalPaths: list(candidate.pendingRemovalPaths) };
}

export class PastedTextService {
  private ledger: Ledger | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspaces: WorkspaceStore) {}

  private get root(): string {
    return join(this.workspaces.configRoot, 'pasted-text');
  }

  private get ledgerPath(): string {
    return join(this.root, LEDGER_FILE_NAME);
  }

  private async loadLedger(): Promise<Ledger> {
    if (this.ledger) return this.ledger;
    try {
      this.ledger = normalizeLedger(JSON.parse(await readFile(this.ledgerPath, 'utf8')));
    } catch {
      this.ledger = emptyLedger();
    }
    return this.ledger;
  }

  /** Ledger writes serialize so concurrent create/remove calls cannot lose
   *  each other's entries; a failed write must not fail the attachment call. */
  private queueLedgerWrite(): Promise<void> {
    const next = this.writing.then(async () => {
      const ledger = await this.loadLedger();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `.${LEDGER_FILE_NAME}.tmp`);
      await writeFile(temporary, JSON.stringify(ledger, null, 2), { mode: 0o600 });
      await rename(temporary, this.ledgerPath);
    }).catch(() => undefined);
    this.writing = next;
    return next;
  }

  /** The resolved path an attachment reference must point at; anything else
   *  is refused so the channel cannot read or delete arbitrary files. */
  private assertOwned(path: string): string {
    const root = resolve(this.root);
    const resolved = resolve(path);
    const relative = resolved.slice(root.length + 1).split(/[\\/]/);
    if (!resolved.startsWith(root + '/') || relative.length !== 2 || !DIRECTORY_RE.test(relative[0]!) || relative[1] !== PASTED_TEXT_FILE_NAME) {
      throw new IpcHandlerError('BAD_REQUEST', 'Not a pasted text attachment');
    }
    return resolved;
  }

  async create(payload: JsonObject): Promise<Json> {
    const text = string(payload.text);
    if (text.length > PASTED_TEXT_CREATE_LIMIT) throw new IpcHandlerError('UPLOAD_TOO_LARGE', 'pasted_text_too_large');
    const directory = join(this.root, randomUUID());
    const path = join(directory, PASTED_TEXT_FILE_NAME);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${PASTED_TEXT_FILE_NAME}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      await rename(temporary, path);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const ledger = await this.loadLedger();
    ledger.attachmentPaths = [...ledger.attachmentPaths.filter(entry => entry !== path), path];
    ledger.pendingRemovalPaths = ledger.pendingRemovalPaths.filter(entry => entry !== path);
    await this.queueLedgerWrite();
    return { ok: true, path, characterCount: text.length };
  }

  async read(payload: JsonObject): Promise<Json> {
    const path = this.assertOwned(string(payload.path));
    try {
      const text = await readFile(path, 'utf8');
      if (text.length > PASTED_TEXT_RESTORE_LIMIT) return { ok: false, error: 'pasted_text_restore_too_large' };
      return { ok: true, text, characterCount: text.length };
    } catch {
      return { ok: false, error: 'pasted_text_unavailable' };
    }
  }

  /** Drop an attachment a draft no longer references, deleting its file. */
  async remove(payload: JsonObject): Promise<Json> {
    const path = this.assertOwned(string(payload.path));
    const ledger = await this.loadLedger();
    // Reconstructed cards can borrow a file already retained by a message or queue.
    if (!ledger.attachmentPaths.includes(path) && !ledger.pendingRemovalPaths.includes(path)) return { ok: true };
    ledger.attachmentPaths = ledger.attachmentPaths.filter(entry => entry !== path);
    if (!ledger.pendingRemovalPaths.includes(path)) ledger.pendingRemovalPaths.push(path);
    await this.queueLedgerWrite();
    await rm(join(path, '..'), { recursive: true, force: true }).catch(() => undefined);
    const after = await this.loadLedger();
    after.pendingRemovalPaths = after.pendingRemovalPaths.filter(entry => entry !== path);
    await this.queueLedgerWrite();
    return { ok: true };
  }

  /** Release ledger ownership once a draft has been submitted; the file stays
   *  on disk because the sent message still points at it. */
  async release(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const owned = new Set(paths.map(entry => resolve(entry)));
    const ledger = await this.loadLedger();
    ledger.attachmentPaths = ledger.attachmentPaths.filter(entry => !owned.has(entry));
    await this.queueLedgerWrite();
  }

  /** Finish deletions a previous run marked but did not complete. */
  async sweep(): Promise<void> {
    const ledger = await this.loadLedger();
    if (!ledger.pendingRemovalPaths.length) return;
    const pending = [...ledger.pendingRemovalPaths];
    ledger.pendingRemovalPaths = [];
    await this.queueLedgerWrite();
    for (const path of pending) {
      try {
        await rm(join(this.assertOwned(path), '..'), { recursive: true, force: true });
      } catch { /* already gone or never owned */ }
    }
  }
}

export function pastedTextPayload(args: unknown): JsonObject {
  return object(args);
}
