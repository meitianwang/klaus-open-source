import { validateAntigravityQueueInput } from '../services/antigravity-input';
import { createHash } from 'node:crypto';
import type { Json } from '../ipc/contract';
import { object, string, type JsonObject } from '../services/service-types';
import type { HostState } from '../services/host-state';
import type { SessionService } from './service';

export function projectQueueSnapshot(value: JsonObject): JsonObject {
  return {
    revision: value.revision ?? 0,
    items: Array.isArray(value.items) ? value.items.map(item => {
      const row = object(item);
      return { state: row.state ?? null, mutable: row.mutable ?? null, message: row.message ?? null };
    }) : [],
    status: value.status ?? null,
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

/** Renderer pushes carry snapshot fields at the top level; only RPC replies nest them. */
export function queueSnapshotEvent(sessionId: string, snapshot: JsonObject): JsonObject {
  return { type: 'queue_snapshot', sessionId, ...projectQueueSnapshot(snapshot) };
}

function failure(code: string, snapshot?: Json): JsonObject { return { ok: false, code, ...(snapshot ? { snapshot } : {}) }; }
function exact(value: unknown, keys: string[]): JsonObject {
  const row = object(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(row).some(key => !keys.includes(key))) throw new Error('Unexpected or missing request fields');
  return row;
}
function identifier(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid request identifier');
  return value.trim();
}

/** Input parts are the engine facade's typed data, never raw operations. */
export function validateInput(value: Json | undefined, source = ''): void {
  if (source === 'antigravity') return validateAntigravityQueueInput(value);
  const text = (raw: unknown): void => { if (typeof raw !== 'string' || raw.length > 1024 * 1024 || raw.includes('\0')) throw new Error('Input text is invalid or too large'); };
  if (typeof value === 'string') { text(value); return; }
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Input must contain between 1 and 32 parts');
  for (const part of value) {
    const row = object(part);
    if (row.type === 'text') { exact(part, ['type', 'text']); text(row.text); continue; }
    const image = row.type === 'image', document = row.type === 'document';
    if (!image && !document) throw new Error('Unsupported input part');
    exact(part, image ? ['type', 'base64', 'mimeType'] : ['type', 'base64', 'mimeType', 'filename']);
    if (image ? !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(string(row.mimeType)) : row.mimeType !== 'application/pdf') throw new Error('Unsupported input MIME type');
    const data = string(row.base64), padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    // Preserve ordinary base64 shape admission without a recursive repeated-group expression.
    if (!data || data.length > 24 * 1024 * 1024 || data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))) throw new Error('Invalid input base64');
    if (document && row.filename !== undefined) text(row.filename);
  }
}

export class SessionQueue {
  constructor(private readonly sessions: SessionService, private readonly state: HostState, private readonly inputSource: (id: string) => string = () => '') {}

  async snapshot(id: string): Promise<JsonObject> {
    if (!id) return failure('invalid-request');
    let engineId: string;
    try { engineId = await this.sessions.resolveLiveQueueSession(id); } catch { return failure('snapshot-unavailable'); }
    if (this.sessions.isSessionClosing(id) || this.state.liveSession(id) !== engineId) return failure('snapshot-unavailable');
    const snapshot = this.state.queueSnapshot(id);
    if (!snapshot) return failure('snapshot-unavailable');
    return snapshot.status === 'authoritative' ? { ok: true, snapshot } : failure(snapshot.status === 'persistence-failed' ? 'persistence-failed' : 'snapshot-unavailable', snapshot);
  }

  async followUps(id: string): Promise<Json[]> {
    const reply = await this.snapshot(id);
    if (!reply.ok) return [];
    return (object(reply.snapshot).items as Json[]).flatMap((item, index): Json[] => {
      const message = object(object(item).message), mode = string(message.mode);
      if (string(message.agentId) || string(message.agent_id) || message.isMeta === true || message.is_meta === true || mode === 'task-notification') return [];
      const value = message.value;
      const text = typeof value === 'string' ? value.trim() : Array.isArray(value) ? value.map(part => {
        const row = object(part);
        return row.type === 'text' ? string(row.text).trim() : row.type === 'image' ? `[Image: ${string(row.mimeType)}]` : row.type === 'document' ? `[Document: ${string(row.mimeType)}]` : row.type === 'media' ? `[Media: ${string(row.mimeType)}]` : '';
      }).filter(Boolean).join('\n').trim() : '';
      if (!text) return [];
      const uuid = string(message.uuid).trim() || 'queued-' + createHash('sha256').update(`${mode}\0${text}\0${index}`).digest('hex').slice(0, 12);
      return [{ id: uuid, text, ...(mode ? { mode } : {}), ...(typeof message.priority === 'string' ? { priority: message.priority } : {}) }];
    });
  }

  async mutate(action: 'edit' | 'remove' | 'reorder', payload: JsonObject): Promise<JsonObject> {
    let id: string, request: JsonObject, uuid: string, mutationId: string, beforeUuid: string | undefined;
    try {
      exact(payload, ['sessionId', 'request']);
      id = identifier(payload.sessionId);
      request = exact(payload.request, action === 'edit' ? ['uuid', 'edit', 'mutationId'] : action === 'remove' ? ['uuid', 'mutationId'] : ['item', 'before', 'mutationId']);
      mutationId = identifier(request.mutationId, 256);
      if (action === 'reorder') {
        const ref = (value: Json | undefined): JsonObject => {
          const row = object(value);
          if (!['rust', 'local-follow-up'].includes(string(row.source))) throw new Error('Invalid queue item source');
          exact(value, row.source === 'rust' ? ['source', 'uuid'] : ['source', 'localId']);
          identifier(row.source === 'rust' ? row.uuid : row.localId);
          return row;
        };
        const item = ref(request.item), before = request.before === null ? undefined : ref(request.before);
        if (before && before.source !== item.source) return failure('cross-source-reorder');
        if (item.source === 'local-follow-up') return failure('local-follow-up-reorder');
        uuid = identifier(item.uuid);
        beforeUuid = before ? identifier(before.uuid) : undefined;
        if (beforeUuid === uuid) return failure('invalid');
      } else uuid = identifier(request.uuid);
      if (action === 'edit') {
        const edit = exact(request.edit, ['value', 'mode', 'priority']);
        if (!Object.keys(edit).length) throw new Error('The edit must change value, mode or priority');
        if (edit.mode !== undefined) identifier(edit.mode, 128);
        if (edit.priority !== undefined && !['now', 'next', 'later'].includes(string(edit.priority))) throw new Error('Invalid queue priority');
      }
    } catch (error) { return { ...failure('invalid-request'), error: error instanceof Error ? error.message : String(error) }; }
    const seed = await this.snapshot(id);
    if (!seed.ok) return seed;
    if (action === 'edit') {
      try {
        const edit = object(request.edit);
        if (edit.value !== undefined) validateInput(edit.value, this.inputSource(id));
      } catch (error) { return { ...failure('invalid-request'), error: error instanceof Error ? error.message : String(error) }; }
    }
    const mirror = object(seed.snapshot), items = mirror.items as Json[];
    const guard = (target: string): string | undefined => {
      const item = items.map(object).find(item => object(item.message).uuid === target);
      return !item ? 'missing' : item.state === 'reserved' ? 'reserved' : item.mutable !== true ? 'not-mutable' : undefined;
    };
    const refusal = guard(uuid) ?? (beforeUuid ? guard(beforeUuid) : undefined);
    if (refusal) return failure(refusal, mirror);
    const engineId = this.state.liveSession(id);
    if (!engineId) return failure('snapshot-unavailable');
    try {
      const method = { edit: 'session/editQueued', remove: 'session/removeQueued', reorder: 'session/reorderQueued' }[action];
      const reply = object(await this.sessions.request(method, {
        sessionId: engineId, mutationId, uuid, expectedRevision: mirror.revision ?? 0,
        ...(action === 'edit' ? { edit: request.edit! } : {}), ...(beforeUuid ? { beforeUuid } : {}),
      }));
      const result = object(reply.queueMutation), latest = object(result.snapshot);
      if (result.snapshot && this.state.liveSession(id) === engineId) this.state.installQueueSnapshot(id, latest);
      const snapshot = result.snapshot ? projectQueueSnapshot(latest) : mirror;
      if (result.status === 'applied' && action === 'remove') this.sessions.queuedInputRemoved(id, uuid);
      return result.status === 'applied' ? { ok: true, snapshot } : failure(string(result.status) || 'outcome-unknown', snapshot);
    } catch { return failure('outcome-unknown', this.state.queueSnapshot(id) ?? mirror); }
  }
}
