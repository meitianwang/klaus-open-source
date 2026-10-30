import { readSessionModel } from '../session-store';
import { mediaInputMime } from '../../../shared/media-input';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { object, string, type JsonObject } from '../service-types';
import { badRequest, MobileError, required, type IncomingMedia, type MobileCall } from './protocol';

export type MobileFollowUpMode = 'queue' | 'steer';
export const FOLLOW_UP_MODE_KEY = 'follow_up_queue_mode';
const RECEIPT_LIMIT = 128;
const RECEIPT_BYTES = 16 * 1024 * 1024;
const RECEIPT_TTL_MS = 10 * 60_000;
const QUEUE_LIMIT = 128;
const DRAFT_BYTES = 20 * 1024 * 1024;
const MUTATIONS = new Set(['remove', 'restore', 'reorder', 'resume', 'deliver', 'clear']);

export function followUpMode(value: unknown): MobileFollowUpMode {
  if (value !== 'queue' && value !== 'steer') throw badRequest('followUpMode must be queue or steer');
  return value;
}
export interface MobileFollowUpIntent { mode?: MobileFollowUpMode; expectedTurnId?: string; beforeId?: string | null; afterId?: string | null }
export function mobileFollowUpIntent(payload: JsonObject): MobileFollowUpIntent {
  const mode = payload.followUpMode === undefined ? undefined : followUpMode(payload.followUpMode);
  const expectedTurnId = payload.expectedTurnId === undefined ? undefined : required(payload.expectedTurnId, 'expectedTurnId');
  if (expectedTurnId && expectedTurnId.length > 256) throw badRequest('expectedTurnId is too long');
  if (mode === 'steer' && !expectedTurnId) throw badRequest('Steer requires expectedTurnId');
  if (mode !== 'steer' && expectedTurnId) throw badRequest('expectedTurnId is only valid for Steer');
  const intent: MobileFollowUpIntent = { mode, expectedTurnId };
  for (const key of ['beforeId', 'afterId'] as const) if (payload[key] !== undefined) {
    if (mode !== 'queue') throw badRequest('Queue insertion anchors require Queue mode');
    intent[key] = payload[key] === null ? null : identity(payload[key], key);
  }
  return intent;
}

/** Ordinary phone attachments retain their established image-or-path projection. */
function ordinaryFollowUpPayload(text: string, descriptors: JsonObject[]): JsonObject {
  const inline = descriptors.filter(item => string(item.mimeType).startsWith('image/'));
  const referenced = descriptors.filter(item => !inline.includes(item));
  const referenceBlock = referenced.length ? ['Attached:', ...referenced.map(item => '- ' + string(item.path))].join('\n') : '';
  return {
    finalText: [text, referenceBlock].filter(Boolean).join('\n\n'), displayText: text,
    media: inline, mobileAttachments: descriptors,
    liveAttachments: descriptors.map(item => ({ type: inline.includes(item) ? 'image' : 'file', name: string(item.name), src: '' })),
    ...(referenced.length ? { displayMetadata: { displayText: text, attachments: referenced.map(item => ({ type: 'file', name: string(item.name) })) } } : {}),
  };
}

export function followUpPayload(text: string, descriptors: JsonObject[], source = ''): JsonObject {
  if (source !== 'antigravity') return ordinaryFollowUpPayload(text, descriptors);
  const inline = descriptors.filter(item => string(item.mimeType).startsWith('image/'));
  const media = descriptors.flatMap(item => {
    if (inline.includes(item)) return [item];
    const mimeType = mediaInputMime(string(item.name) || string(item.fileName), string(item.mimeType));
    return mimeType ? [{ ...item, type: 'media', mimeType }] : [];
  });
  const referenced = descriptors.filter(item => !inline.includes(item));
  const referenceBlock = referenced.length ? ['Attached:', ...referenced.map(item => '- ' + string(item.path))].join('\n') : '';
  return {
    finalText: [text, referenceBlock].filter(Boolean).join('\n\n'), displayText: text,
    media, mobileAttachments: descriptors,
    liveAttachments: descriptors.map(item => ({ type: inline.includes(item) ? 'image' : 'file', name: string(item.name), path: string(item.path),
      mimeType: string(item.mimeType), src: '' })),
    ...(referenced.length ? { displayMetadata: { displayText: text, attachments: referenced.map(item => ({ type: 'file', name: string(item.name),
      path: string(item.path), mimeType: string(item.mimeType) })) } } : {}),
  };
}
export async function uploadFollowUpMedia(call: MobileCall, media: IncomingMedia[]): Promise<JsonObject[]> {
  const descriptors: JsonObject[] = [];
  for (const item of media) {
    const uploaded = object(await call('chat:upload', { name: item.filename, type: item.mimeType, buffer: item.bytes.toString('base64') }));
    if (!string(uploaded.path)) throw new MobileError(503, 'attachment_upload_unconfirmed', 'Desktop did not confirm the attachment');
    descriptors.push({ ...uploaded, type: item.type, mimeType: item.mimeType, fileName: item.filename, name: item.filename });
  }
  return descriptors;
}

/** Stable payload identities reject a retry that changes its original intent. */
export function payloadFingerprint(value: unknown): string {
  const canonical = (row: unknown): unknown => Array.isArray(row) ? row.map(canonical)
    : row && typeof row === 'object' ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : row;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function queueReply(value: unknown, options: { allowMissingSnapshot?: boolean } = {}): JsonObject {
  const reply = object(value), snapshot = object(reply.snapshot);
  if (reply.ok !== true) throw new MobileError(409, string(reply.code) || 'queue_mutation_rejected', string(reply.error) || 'Desktop did not accept the queue action');
  if (options.allowMissingSnapshot && reply.snapshot === undefined) return reply;
  if (!Number.isSafeInteger(snapshot.revision) || Number(snapshot.revision) < 0 || !Array.isArray(snapshot.items)) {
    throw new MobileError(503, 'queue_unavailable', 'Desktop did not return an authoritative follow-up queue');
  }
  return reply;
}
function revision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw badRequest('expectedRevision must be a non-negative integer');
  return Number(value);
}
function identity(value: unknown, field: string): string {
  const id = required(value, field);
  if (id.length > 256) throw badRequest(field + ' is too long');
  return id;
}
interface RemovedReceipt { row: JsonObject; fingerprint: string; bytes: number; createdAt: number }
interface MutationReceipt { fingerprint: string; createdAt: number; settled: boolean; task: Promise<JsonObject> }

/** Remote controls reuse the desktop queue; this ledger owns only bounded transport receipts. */
export class MobileFollowUpControls {
  private readonly removed = new Map<string, RemovedReceipt>();
  private readonly mutations = new Map<string, MutationReceipt>();
  private removedBytes = 0;
  constructor(private readonly configRoot: string) {}

  async snapshot(call: MobileCall, sessionId: string): Promise<JsonObject> {
    return queueReply(await call('chat:client-queue-snapshot', { sessionId }));
  }
  async enqueue(call: MobileCall, sessionId: string, clientMessageId: string, text: string, media: IncomingMedia[], anchors: Pick<MobileFollowUpIntent, 'beforeId' | 'afterId'> = {}): Promise<JsonObject> {
    const current = await this.snapshot(call, sessionId);
    const rows = object(current.snapshot).items as JsonObject[];
    const queueId = 'mobile-' + clientMessageId;
    const fingerprint = payloadFingerprint({ text, media: media.map(item => ({ type: item.type, mimeType: item.mimeType, filename: item.filename, digest: createHash('sha256').update(item.bytes).digest('hex') })), ...anchors });
    const existing = rows.map(object).find(row => row.id === queueId);
    if (existing) {
      if (object(existing.item).mobilePayloadFingerprint !== fingerprint) throw new MobileError(409, 'message_identity_conflict', 'This queued message identity belongs to a different payload');
      return { followUpMode: 'queue', queueId, snapshot: current.snapshot! };
    }
    if (rows.length >= QUEUE_LIMIT) throw new MobileError(429, 'queue_full', 'The conversation follow-up queue is full');
    const descriptors = await uploadFollowUpMedia(call, media);
    const item = { id: queueId, source: 'mobile', mobilePayloadFingerprint: fingerprint, ...followUpPayload(text, descriptors, readSessionModel(sessionId, this.configRoot).source) };
    const answer = queueReply(await call('chat:client-queue-add', { sessionId, id: queueId, item, ...anchors, dispatchIfIdle: true }), { allowMissingSnapshot: true });
    return { followUpMode: 'queue', queueId, ...(answer.snapshot === undefined ? {} : { snapshot: answer.snapshot }) };
  }
  async steer(call: MobileCall, sessionId: string, projected: JsonObject, expectedTurnId: string): Promise<JsonObject> {
    const result = object(await call('chat:follow-up', { sessionId, text: projected.finalText!, media: projected.media!, displayText: projected.displayText!, ...(projected.displayMetadata ? { displayMetadata: projected.displayMetadata } : {}), mobileAttachments: projected.mobileAttachments!, expectedTurnId }));
    if (result.removed === true && string(result.messageId)) return { followUpMode: 'steer', messageId: result.messageId!, followUpState: 'removed' };
    if (result.ok !== true && result.unconfirmed !== true) throw new MobileError(409, 'steer_rejected', string(result.error) || 'The running turn rejected this follow-up');
    const messageId = required(result.messageId, 'messageId');
    return { followUpMode: 'steer', messageId, followUpState: result.unconfirmed === true ? 'unconfirmed' : 'engine_queued' };
  }

  mutate(call: MobileCall, sessionId: string, action: string, payload: JsonObject): Promise<JsonObject> {
    if (!MUTATIONS.has(action)) throw badRequest('Unknown follow-up queue action');
    const mutationId = identity(payload.clientMutationId, 'clientMutationId');
    this.trimReceipts();
    const key = JSON.stringify([sessionId, mutationId]), fingerprint = payloadFingerprint({ action, payload });
    const previous = this.mutations.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new MobileError(409, 'mutation_identity_conflict', 'This queue action identity already belongs to a different request');
      return previous.task;
    }
    if (this.mutations.size >= RECEIPT_LIMIT) throw new MobileError(429, 'too_many_queue_actions', 'Too many queue actions are awaiting confirmation');
    const receipt: MutationReceipt = { fingerprint, createdAt: Date.now(), settled: false, task: Promise.resolve({}) };
    receipt.task = Promise.resolve().then(() => this.applyMutation(call, sessionId, action, payload)).finally(() => { receipt.settled = true; });
    this.mutations.set(key, receipt);
    return receipt.task;
  }

  private async applyMutation(call: MobileCall, sessionId: string, action: string, payload: JsonObject): Promise<JsonObject> {
    const expectedRevision = revision(payload.expectedRevision), input: JsonObject = { sessionId, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
    if (['remove', 'reorder', 'deliver'].includes(action)) input.id = identity(payload.id, 'id');
    if (action === 'reorder') input.beforeId = payload.beforeId === null || payload.beforeId === undefined ? null : identity(payload.beforeId, 'beforeId');
    if (action === 'remove') { input.clientMutationId = payload.clientMutationId!; input.mutationFingerprint = payloadFingerprint({ action, payload }); }
    if (action === 'deliver') {
      input.requireExpectedTurn = true;
      if (payload.allowUnconfirmedRetry !== undefined && typeof payload.allowUnconfirmedRetry !== 'boolean') throw badRequest('allowUnconfirmedRetry must be a boolean');
      input.allowUnconfirmedRetry = payload.allowUnconfirmedRetry === true;
      if (payload.expectedTurnId !== undefined) input.expectedTurnId = identity(payload.expectedTurnId, 'expectedTurnId');
    }
    if (action === 'resume') {
      if (payload.dispatch !== undefined && typeof payload.dispatch !== 'boolean') throw badRequest('dispatch must be a boolean');
      input.dispatch = payload.dispatch !== false;
    }
    if (action === 'restore') {
      const candidate = object(payload.row), id = identity(candidate.id, 'row.id'), key = JSON.stringify([sessionId, id]);
      const receipt = this.removed.get(key);
      if (receipt && receipt.fingerprint !== payloadFingerprint(candidate)) throw new MobileError(409, 'queue_restore_unavailable', 'Only the unchanged row removed from this conversation can be restored');
      input.row = receipt?.row ?? candidate;
      input.requireRemovedReceipt = true;
    }
    if (action === 'restore') for (const field of ['beforeId', 'afterId']) {
      if (payload[field] !== undefined && payload[field] !== null) input[field] = identity(payload[field], field);
    }
    const reply = object(await call('chat:client-queue-' + action, input));
    if (reply.ok !== true) throw new MobileError(409, string(reply.code) || 'queue_mutation_rejected', string(reply.error) || 'Desktop did not accept the queue action');
    if (action === 'remove' && reply.removed) {
      const row = object(reply.removed), bytes = Buffer.byteLength(JSON.stringify(row));
      if (bytes <= RECEIPT_BYTES) {
        while (this.removed.size >= RECEIPT_LIMIT || this.removedBytes + bytes > RECEIPT_BYTES) this.dropRemoved(this.removed.keys().next().value!);
        const key = JSON.stringify([sessionId, row.id]); this.dropRemoved(key);
        this.removed.set(key, { row, bytes, fingerprint: payloadFingerprint(row), createdAt: Date.now() }); this.removedBytes += bytes;
      }
    }
    if (action === 'restore') this.dropRemoved(JSON.stringify([sessionId, object(payload.row).id]));
    const fresh = reply.snapshot ? queueReply(reply) : await this.snapshot(call, sessionId);
    return { ...reply, snapshot: fresh.snapshot!, followUpTurnId: fresh.followUpTurnId ?? null };
  }

  /** Read only a queued row's managed upload bytes, while the queue retains ownership. */
  async draft(call: MobileCall, sessionId: string, id: string): Promise<JsonObject> {
    identity(id, 'queueId');
    const reply = await this.snapshot(call, sessionId), snapshot = object(reply.snapshot);
    const row = (snapshot.items as JsonObject[]).map(object).find(candidate => candidate.id === id);
    if (!row || row.dispatching === true || row.unconfirmed === true || object(row.item).followUpState === 'unconfirmed') throw new MobileError(409, 'queue_row_unavailable', 'The queued message is no longer editable');
    const item = object(row.item), text = typeof item.displayText === 'string' ? item.displayText : string(item.finalText) || string(item.text);
    if (Buffer.byteLength(text) > 32 * 1024) throw new MobileError(413, 'queue_draft_too_large', 'This queued message is too large to edit on the phone');
    const native = Array.isArray(item.media) && item.media.some(value => object(value).type === 'media');
    const media: JsonObject[] = [], entries: JsonObject[] = [], byPath = new Map<string, JsonObject>();
    const add = (value: unknown): void => {
      const descriptor = { ...object(value) }, path = string(descriptor.path), existing = native ? byPath.get(path) : undefined;
      if (existing) {
        if ((!string(existing.mimeType) || existing.mimeType === 'application/octet-stream') && string(descriptor.mimeType)) existing.mimeType = descriptor.mimeType!;
        if (!string(existing.name) && string(descriptor.name)) existing.name = descriptor.name!;
        return;
      }
      entries.push(descriptor); byPath.set(path, descriptor);
    };
    for (const descriptor of Array.isArray(item.mobileAttachments) ? item.mobileAttachments : Array.isArray(item.media) ? item.media : []) add(descriptor);
    if (!Array.isArray(item.mobileAttachments)) {
      const block = /(?:^|\n\n)Attached:\n((?:- [^\n]+\n?)+)$/u.exec(string(item.finalText));
      const paths = block?.[1]?.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)) ?? [];
      const files = (Array.isArray(item.liveAttachments) ? item.liveAttachments : []).map(object).filter(file => file.type !== 'image');
      if (files.length && files.length !== paths.length) throw new MobileError(409, 'queue_draft_unavailable', 'This queued message cannot be edited on the phone without losing its file references');
      for (let index = 0; index < paths.length; index++) add({ path: paths[index]!, name: string(files[index]?.name) || basename(paths[index]!),
        type: 'file', mimeType: native ? string(files[index]?.mimeType) || 'application/octet-stream' : 'application/octet-stream' });
    }
    if (entries.length > 8) throw new MobileError(413, 'queue_draft_too_large', 'This queued message has too many attachments for the phone');
    let total = 0;
    const root = entries.length ? await realpath(join(this.configRoot, 'uploads')) : '';
    for (const raw of entries) {
      const descriptor = object(raw), path = string(descriptor.path), canonical = await realpath(path);
      if (resolve(root, basename(path)) !== canonical || resolve(path) !== canonical) throw new MobileError(403, 'queue_media_unavailable', 'Only the queued managed upload can be edited remotely');
      const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await source.stat();
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024 || total + stat.size > DRAFT_BYTES) throw new MobileError(413, 'queue_draft_too_large', 'The queued attachment exceeds the phone draft limit');
        const bytes = Buffer.alloc(stat.size); let offset = 0;
        while (offset < bytes.length) { const read = await source.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        const after = await source.stat();
        if (offset !== bytes.length || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new MobileError(409, 'queue_media_changed', 'The queued attachment changed while reading it');
        total += bytes.length;
        const mimeType = string(descriptor.mimeType) || (string(descriptor.type).includes('/') ? string(descriptor.type) : 'application/octet-stream');
        media.push({ type: descriptor.type === 'image' || mimeType.startsWith('image/') ? 'image' : 'file', mimeType, filename: string(descriptor.name) || string(descriptor.fileName) || basename(path), data: bytes.toString('base64') });
      } finally { await source.close(); }
    }
    const rows = (snapshot.items as JsonObject[]).map(object), index = rows.findIndex(candidate => candidate.id === id);
    return { ok: true, id, expectedRevision: snapshot.revision!, text, media, beforeId: rows[index + 1]?.id ?? null, afterId: index > 0 ? rows[index - 1]!.id! : null };
  }
  private dropRemoved(key: string): void { const row = this.removed.get(key); if (row) { this.removedBytes -= row.bytes; this.removed.delete(key); } }
  private trimReceipts(): void {
    const before = Date.now() - RECEIPT_TTL_MS;
    for (const [key, row] of this.removed) if (row.createdAt < before) this.dropRemoved(key);
    for (const [key, row] of this.mutations) if (row.settled && row.createdAt < before) this.mutations.delete(key);
    while (this.mutations.size >= RECEIPT_LIMIT) { const oldest = [...this.mutations].find(([, row]) => row.settled); if (!oldest) break; this.mutations.delete(oldest[0]); }
  }
}
