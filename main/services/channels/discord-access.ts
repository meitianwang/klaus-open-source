import { randomBytes } from 'node:crypto';
import { chmod, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Json } from '../../ipc/contract';
import { IpcHandlerError } from '../../ipc/registry';
import { managedPath, readDocument } from '../extensions/file-store';
import { SerialMutations, errorMessage, object, string, type JsonObject } from '../service-types';

export interface DiscordAccessDeps {
  configRoot: string;
  now?: () => number;
  onChanged?: () => void | Promise<void>;
}
export type DiscordDirectDecision = { kind: 'deliver'; access: JsonObject } | { kind: 'drop' } | { kind: 'pair'; code: string; isResend: boolean };

const deliveryKeys = ['mentionPatterns', 'ackReaction', 'replyToMode', 'textChunkLimit', 'chunkMode'] as const;
const defaultAccess = (): JsonObject => ({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} });
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const argument = (value: Json | undefined): string => String(value || '');

function normalizeAccess(value: JsonObject): JsonObject {
  return {
    dmPolicy: string(value.dmPolicy, 'pairing'),
    allowFrom: Array.isArray(value.allowFrom) ? value.allowFrom : [],
    groups: isObject(value.groups) ? value.groups : {},
    pending: isObject(value.pending) ? value.pending : {},
    ...Object.fromEntries(deliveryKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]])),
  };
}

function pruneExpired(access: JsonObject, now: number): boolean {
  const pending = object(access.pending);
  let changed = false;
  for (const [code, entry] of Object.entries(pending)) {
    const expiresAt = object(entry).expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) {
      delete pending[code]; changed = true;
    }
  }
  return changed;
}

/** Existing file maps become the arrays consumed by the channel settings page. */
export function discordAccessSnapshot(access: JsonObject): JsonObject {
  return {
    dmPolicy: access.dmPolicy!, allowFrom: access.allowFrom!,
    groups: Object.entries(object(access.groups)).sort(([a], [b]) => a.localeCompare(b)).map(([channelId, value]) => {
      const policy = object(value);
      return { channelId, requireMention: typeof policy.requireMention === 'boolean' ? policy.requireMention : true,
        allowFrom: Array.isArray(policy.allowFrom) ? policy.allowFrom : [] };
    }),
    pending: Object.entries(object(access.pending)).sort(([a], [b]) => a.localeCompare(b)).map(([code, value]) => ({ ...object(value), code })),
    mentionPatterns: Array.isArray(access.mentionPatterns) ? access.mentionPatterns : [],
    ackReaction: string(access.ackReaction), replyToMode: string(access.replyToMode, 'first'),
    textChunkLimit: typeof access.textChunkLimit === 'number' ? access.textChunkLimit : 2000,
    chunkMode: string(access.chunkMode, 'length'),
  };
}

function senderFileName(senderId: string): string {
  // The legacy drop-box names files after sender IDs on both platforms.
  if (!senderId || senderId === '.' || senderId.includes('..') || /[\\/:\x00-\x1f\x7f]/.test(senderId)) throw new Error('Invalid sender id');
  return senderId;
}

/** One per application. The transport must share this store for pairing writes. */
export class DiscordAccessService {
  private readonly mutations = new SerialMutations();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly directory: string;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: DiscordAccessDeps) {
    if (!isAbsolute(deps.configRoot)) throw new Error('An absolute channel config root is required');
    this.directory = join(deps.configRoot, 'channels', 'discord');
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new IpcHandlerError('SERVICE_CLOSED', 'The Discord access service is closed'));
    const promise = this.mutations.run(operation);
    this.pending.add(promise);
    return promise.finally(() => this.pending.delete(promise));
  }
  private async privateWrite(relative: string, content: string): Promise<void> {
    const path = await managedPath(this.directory, relative, true);
    await chmod(this.directory, 0o700);
    await chmod(dirname(path), 0o700);
    const temp = join(dirname(path), '.discord-write-' + randomBytes(12).toString('hex'));
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8'); await handle.sync();
      await handle.close();
      await managedPath(this.directory, relative);
      await rename(temp, path);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  private async read(): Promise<JsonObject> {
    const path = await managedPath(this.directory, 'access.json');
    let raw: string;
    try { raw = await readDocument(path); }
    catch (error) { if (isMissing(error)) return defaultAccess(); throw error; }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) throw new Error('Access state is not an object');
      return normalizeAccess(parsed);
    } catch (error) {
      if (!(error instanceof SyntaxError) && errorMessage(error) !== 'Access state is not an object') throw error;
      const aside = path + '.corrupt-' + (this.deps.now?.() ?? Date.now()) + '-' + randomBytes(6).toString('hex');
      // If preserving the old bytes fails, refuse to proceed with empty state.
      await rename(path, aside);
      return defaultAccess();
    }
  }
  private save(access: JsonObject): Promise<void> { return this.privateWrite('access.json', JSON.stringify(access, null, 2) + '\n'); }
  access(): Promise<JsonObject> {
    return this.run(async () => {
      const access = await this.read();
      if (pruneExpired(access, this.deps.now?.() ?? Date.now())) await this.save(access);
      return discordAccessSnapshot(access);
    });
  }
  transportAccess(): Promise<JsonObject> {
    return this.run(async () => {
      const access = await this.read();
      if (pruneExpired(access, this.deps.now?.() ?? Date.now())) await this.save(access);
      return access;
    });
  }
  /** Shares the UI mutation queue, so a concurrent revoke cannot mint a stale grant. */
  authorizeDirect(senderId: string, chatId: string): Promise<DiscordDirectDecision> {
    return this.run(async () => {
      senderFileName(senderId);
      if (!chatId || /[\x00-\x1f\x7f]/u.test(chatId)) throw new Error('Invalid Discord DM channel');
      const access = await this.read(), now = this.deps.now?.() ?? Date.now();
      const pruned = pruneExpired(access, now);
      if (pruned) await this.save(access);
      if (!['pairing', 'allowlist'].includes(string(access.dmPolicy))) return { kind: 'drop' };
      if ((access.allowFrom as Json[]).includes(senderId)) return { kind: 'deliver', access };
      if (access.dmPolicy !== 'pairing') return { kind: 'drop' };
      const pending = object(access.pending);
      const existing = Object.entries(pending).find(([, value]) => object(value).senderId === senderId);
      if (existing) {
        const [code, value] = existing, entry = object(value);
        const replies = typeof entry.replies === 'number' ? entry.replies : 1;
        if (replies >= 2) return { kind: 'drop' };
        entry.replies = replies + 1;
        await this.save(access); await this.deps.onChanged?.();
        return { kind: 'pair', code, isResend: true };
      }
      if (Object.keys(pending).length >= 3) return { kind: 'drop' };
      let code = '';
      for (let attempt = 0; attempt < 4; attempt++) { const candidate = randomBytes(3).toString('hex'); if (!Object.hasOwn(pending, candidate)) { code = candidate; break; } }
      if (!code) throw new Error('Could not allocate a Discord pairing code');
      pending[code] = { senderId, chatId, createdAt: now, expiresAt: now + 3_600_000, replies: 1 };
      await this.save(access); await this.deps.onChanged?.();
      return { kind: 'pair', code, isResend: false };
    });
  }
  /** Consumes the existing approval drop-box; network confirmation remains best effort. */
  drainApprovals(): Promise<Array<{ senderId: string; chatId: string }>> {
    return this.run(async () => {
      const directory = await managedPath(this.directory, 'approved'), access = await this.read();
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
      const result: Array<{ senderId: string; chatId: string }> = [];
      for (const entry of entries.filter(row => row.isFile()).slice(0, 128)) {
        const senderId = senderFileName(entry.name), path = await managedPath(this.directory, join('approved', senderId));
        let chatId: string;
        try { chatId = (await readDocument(path, 4096)).trim(); } catch (error) { if (isMissing(error)) continue; throw error; }
        await unlink(path);
        if (['pairing', 'allowlist'].includes(string(access.dmPolicy)) && (access.allowFrom as Json[]).includes(senderId) && chatId && !/[\x00-\x1f\x7f]/u.test(chatId)) result.push({ senderId, chatId });
      }
      return result;
    });
  }
  private edit(update: (access: JsonObject) => void, afterSave?: () => Promise<void>): Promise<JsonObject> {
    return this.run(async (): Promise<JsonObject> => {
      const access = await this.read();
      const pruned = pruneExpired(access, this.deps.now?.() ?? Date.now());
      try { update(access); }
      catch (error) {
        if (pruned) await this.save(access);
        const message = errorMessage(error);
        return { ok: false, error: message, ...(message === 'Unknown or expired pairing code' ? { snapshot: discordAccessSnapshot(access) } : {}) };
      }
      await this.save(access);
      try { await afterSave?.(); await this.deps.onChanged?.(); }
      catch (error) { return { ok: false, saved: true, snapshot: discordAccessSnapshot(access), error: 'Discord access was saved, but completing the update failed: ' + errorMessage(error) }; }
      return { ok: true, snapshot: discordAccessSnapshot(access) };
    });
  }
  setDmPolicy(payload: JsonObject): Promise<JsonObject> {
    return this.edit(access => {
      const policy = string(payload.dmPolicy);
      if (!['pairing', 'allowlist', 'disabled'].includes(policy)) throw new Error('Invalid DM policy');
      access.dmPolicy = policy;
    });
  }
  approvePending(payload: JsonObject): Promise<JsonObject> {
    let senderId = '', chatId = '';
    return this.edit(access => {
      const code = string(payload.code), pending = object(access.pending);
      const entry = Object.hasOwn(pending, code) ? pending[code] : undefined;
      if (!isObject(entry)) throw new Error('Unknown or expired pairing code');
      senderId = senderFileName(string(entry.senderId)); chatId = string(entry.chatId);
      if (!chatId || /[\x00-\x1f\x7f]/.test(chatId)) throw new Error('Invalid pending chat id');
      const allow = access.allowFrom as Json[];
      if (!allow.includes(senderId)) allow.push(senderId);
      delete pending[code];
    }, () => this.privateWrite(join('approved', senderId), chatId));
  }
  denyPending(payload: JsonObject): Promise<JsonObject> {
    return this.edit(access => {
      const code = argument(payload.code), pending = object(access.pending);
      if (!Object.hasOwn(pending, code)) throw new Error('Unknown or expired pairing code');
      delete pending[code];
    });
  }
  addAllowFrom(payload: JsonObject): Promise<JsonObject> {
    return this.edit(access => {
      const senderId = argument(payload.senderId).trim();
      if (!senderId) throw new Error('Missing sender id');
      senderFileName(senderId);
      const allow = access.allowFrom as Json[];
      if (!allow.includes(senderId)) allow.push(senderId);
    });
  }
  removeAllowFrom(payload: JsonObject): Promise<JsonObject> {
    let senderId = '';
    return this.edit(access => {
      senderId = argument(payload.senderId).trim();
      if (!senderId) throw new Error('Missing sender id');
      senderFileName(senderId);
      access.allowFrom = (access.allowFrom as Json[]).filter(item => item !== senderId);
    }, async () => {
      const path = await managedPath(this.directory, join('approved', senderId));
      try { await unlink(path); } catch (error) { if (!isMissing(error)) throw error; }
    });
  }
  upsertGroup(payload: JsonObject): Promise<JsonObject> {
    return this.edit(access => {
      const channelId = argument(payload.channelId).trim();
      if (!channelId) throw new Error('Missing channel id');
      const allowFrom = Array.isArray(payload.allowFrom) ? payload.allowFrom.map(value => String(value).trim()).filter(Boolean) : [];
      Object.defineProperty(object(access.groups), channelId, {
        enumerable: true, configurable: true, writable: true, value: { requireMention: Boolean(payload.requireMention), allowFrom },
      });
    });
  }
  removeGroup(payload: JsonObject): Promise<JsonObject> {
    return this.edit(access => {
      const channelId = argument(payload.channelId).trim();
      if (!channelId) throw new Error('Missing channel id');
      delete object(access.groups)[channelId];
    });
  }
  updateDelivery(payload: JsonObject): Promise<JsonObject> {
    return this.edit(access => {
      const limit = Number(payload.textChunkLimit);
      access.mentionPatterns = argument(payload.mentionPatterns).split('\n').map(value => value.trim()).filter(Boolean);
      access.ackReaction = argument(payload.ackReaction).trim();
      access.replyToMode = ['off', 'first', 'all'].includes(string(payload.replyToMode)) ? payload.replyToMode! : 'first';
      access.textChunkLimit = Number.isFinite(limit) ? Math.max(1, Math.min(2000, limit)) : 2000;
      access.chunkMode = payload.chunkMode === 'newline' ? 'newline' : 'length';
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = Promise.allSettled([...this.pending]).then(() => undefined);
  }
}
