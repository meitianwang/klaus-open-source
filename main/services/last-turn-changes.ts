import { isAbsolute, resolve } from 'node:path';
import { createTwoFilesPatch, formatPatch, parsePatch, structuredPatch, type StructuredPatchHunk } from 'diff';
import type { Json } from '../ipc/contract';
import { object, string } from './service-types';
import type { LastTurnChanges } from './git';

const PATCH_LIMIT = 1024 * 1024;
type Segment = string | { start: number; count: number };

/** Split an unknown original range at a position in the evolving file. */
function boundary(segments: Segment[], position: number): number {
  if (position < 0) throw new Error('Patch starts before the file');
  let remaining = position;
  for (const [index, segment] of segments.entries()) {
    if (remaining === 0) return index;
    const length = typeof segment === 'string' ? 1 : segment.count;
    if (remaining < length && typeof segment !== 'string') {
      segments.splice(index, 1, { start: segment.start, count: remaining },
        { start: segment.start + remaining, count: segment.count - remaining });
      return index + 1;
    }
    remaining -= length;
  }
  if (remaining === 0) return segments.length;
  throw new Error('Patch extends beyond the file');
}

/** Consolidate sequential patches without inventing any unrecorded original lines. */
export function composeTurnPatches(patches: string[], created = false): string | null {
  try {
    if (patches.reduce((total, patch) => total + patch.length, 0) > PATCH_LIMIT) return null;
    const parsed = patches.map(patch => {
      const result = parsePatch(patch);
      if (result.length !== 1 || /^(?:Binary files|GIT binary patch|rename |copy |deleted file mode|old mode|new mode)/m.test(patch)) {
        throw new Error('Patch cannot be consolidated');
      }
      return result[0]!;
    });
    if (!parsed.length) return '';
    const segments: Segment[] = created ? [] : [{ start: 0, count: Infinity }];
    const original = new Map<number, string>();
    for (const patch of parsed) {
      let delta = 0;
      for (const hunk of patch.hunks) {
        const position = hunk.oldStart - 1 + delta;
        const begin = boundary(segments, position), end = boundary(segments, position + hunk.oldLines);
        const removed: Array<number | string> = segments.slice(begin, end).flatMap<number | string>(segment => typeof segment === 'string'
          ? [segment] : Array.from({ length: segment.count }, (_, index) => segment.start + index));
        const replacement: Segment[] = [];
        let consumed = 0;
        for (const [index, line] of hunk.lines.entries()) {
          if (line.startsWith('\\')) continue;
          const content = line.slice(1) + (hunk.lines[index + 1]?.startsWith('\\') ? '' : '\n');
          if (line.startsWith('+')) { replacement.push(content); continue; }
          const previous = removed[consumed++];
          if (typeof previous === 'number') {
            const known = original.get(previous);
            if (known !== undefined && known !== content) throw new Error('Conflicting original content');
            original.set(previous, content);
          } else if (previous !== content) throw new Error('Patches are not sequential');
          if (line.startsWith(' ')) replacement.push(typeof previous === 'number' ? { start: previous, count: 1 } : content);
        }
        if (consumed !== removed.length) throw new Error('Patch length mismatch');
        segments.splice(begin, end - begin, ...replacement);
        delta += hunk.newLines - hunk.oldLines;
      }
    }
    const hunks: StructuredPatchHunk[] = [];
    let oldPosition = 0, newPosition = 0, pending = '', pendingLines = 0;
    const flush = (until: number) => {
      let before = '';
      for (let index = oldPosition; index < until; index++) {
        const line = original.get(index);
        if (line === undefined) throw new Error('Missing original content');
        before += line;
      }
      const patch = structuredPatch('', '', before, pending, '', '', { context: 3 });
      for (const hunk of patch.hunks) hunks.push({ ...hunk, oldStart: hunk.oldStart + oldPosition, newStart: hunk.newStart + newPosition });
      newPosition += pendingLines;
      pending = ''; pendingLines = 0; oldPosition = until;
    };
    for (const segment of segments) {
      if (typeof segment === 'string') { pending += segment; pendingLines++; continue; }
      const known = segment.count === 1 ? original.get(segment.start) : undefined;
      if (known !== undefined) { pending += known; pendingLines++; continue; }
      flush(segment.start);
      oldPosition += segment.count; newPosition += segment.count;
    }
    if (created) flush(0);
    if (!hunks.length) return created ? patches[0]!.split(/^@@/m)[0]!.replace(/[\r\n]+$/, '') + '\n' : '';
    return formatPatch({ ...parsed[0]!, hunks });
  } catch { return null; }
}

function countPatch(patch: string): { added: number | null; removed: number | null } {
  try {
    let added = 0, removed = 0;
    for (const file of parsePatch(patch)) for (const hunk of file.hunks) for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      if (line.startsWith('-')) removed++;
    }
    return /^(?:Binary files|GIT binary patch)/m.test(patch) ? { added: null, removed: null } : { added, removed };
  } catch { return { added: null, removed: null }; }
}

function recordedEventPatch(kind: string, diff: unknown): string | null {
  if (typeof diff !== 'string') return null;
  if (kind === 'create' || kind === 'add') return createTwoFilesPatch('before', 'after', '', diff);
  if (kind === 'delete') return createTwoFilesPatch('before', 'after', diff, '');
  if (diff === '' || /^(?:Binary files|GIT binary patch)/m.test(diff)) return diff;
  try {
    const parsed = parsePatch(diff);
    return parsed.length === 1 && parsed[0]!.hunks.length ? diff : null;
  } catch { return null; }
}

/** Unloaded conversations remain readable without resuming their provider.
 *  `turnId` pins one turn's record; without it the newest turn with recorded
 *  changes wins. */
export async function readLastTurnFromHistory(sessionId: string, cwd: string,
  request: (method: string, params: Record<string, Json>) => Promise<Json>, turnId?: string): Promise<LastTurnChanges> {
  let cursor: string | undefined;
  const pages = new Map<string, Json>(), seen = new Set<string>();
  for (;;) {
    const params = { threadId: sessionId, limit: 100, ...(cursor ? { cursor } : {}) };
    const reply = await request('engine/readThread', params);
    pages.set(cursor ?? '', reply);
    const page = object(reply), thread = object(page.thread);
    if (thread.id !== sessionId || !Array.isArray(page.turns)) throw new Error('The engine returned a different turn history');
    for (const turn of page.turns.map(object)) {
      const rows = new Map<string, Record<string, Json>>();
      for (const item of Array.isArray(turn.items) ? turn.items.map(object) : []) {
        if (item.type !== 'fileChange' || item.status === 'failed' || item.status === 'declined') continue;
        for (const change of Array.isArray(item.changes) ? item.changes.map(object) : []) {
          const raw = string(change.path);
          if (!raw) continue;
          const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
          const reported = typeof change.kind === 'string' ? change.kind : string(object(change.kind).type);
          const nextKind = ({ add: 'create', update: 'modify', delete: 'delete' } as Record<string, string>)[reported] ?? reported;
          const kind = rows.get(path)?.kind === 'create' && nextKind === 'modify' ? 'create' : nextKind;
          rows.set(path, { path, kind, added: change.added ?? null, removed: change.removed ?? null,
            ...(typeof change.turnDiff === 'string' ? { turnDiff: change.turnDiff } : {}) });
        }
      }
      if (!rows.size) continue;
      if (turnId && turn.id !== turnId) continue;
      // Reuse the same durable pages for historical per-edit fallback.
      return readLastTurnChanges(sessionId, cwd, (method, extra) => {
        if (method === 'session/fileChanges') return Promise.resolve({ fileChanges: [{ turnId: turn.id ?? null, files: [...rows.values()] }] });
        return Promise.resolve(pages.get(string(extra.cursor)) ?? request(method, extra));
      });
    }
    const next = string(object(page.page).nextCursor);
    if (!next || seen.has(next)) return { turnId: null, files: [] };
    seen.add(next); cursor = next;
  }
}

/** Read durable turn records; historical per-edit patches use the same sequential fallback.
 *  `turnId` pins one turn's record (a per-turn change card asking for its own
 *  turn); without it the newest turn with recorded changes wins. */
export async function readLastTurnChanges(sessionId: string, cwd: string,
  request: (method: string, params: Record<string, Json>) => Promise<Json>, wantedTurnId?: string): Promise<LastTurnChanges> {
  const reply = object(await request('session/fileChanges', {}));
  if (!Array.isArray(reply.fileChanges)) throw new Error('The engine omitted turn file changes');
  const groups = [...reply.fileChanges].reverse().map(object);
  const group = wantedTurnId
    ? groups.find(turn => string(turn.turnId) === wantedTurnId && Array.isArray(turn.files))
    : groups.find(turn => Array.isArray(turn.files) && turn.files.length > 0);
  if (!group) return { turnId: null, files: [] };
  const turnId = string(group.turnId) || null;
  const recorded = (group.files as Json[]).map(object);
  const missing = new Set(recorded.filter(row => typeof row.turnDiff !== 'string').map(row => string(row.path)));
  const events = new Map<string, Array<{ diff: string | null; kind: string }>>();
  if (missing.size && turnId) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const page = object(await request('engine/readThread', { threadId: sessionId, limit: 100, ...(cursor ? { cursor } : {}) }));
      const thread = object(page.thread);
      if (thread.id !== sessionId || !Array.isArray(page.turns)) throw new Error('The engine returned a different turn history');
      const turn = page.turns.map(object).find(row => row.id === turnId);
      if (turn) {
        for (const item of Array.isArray(turn.items) ? turn.items.map(object) : []) {
          if (item.type !== 'fileChange' || item.status === 'failed' || item.status === 'declined') continue;
          for (const change of Array.isArray(item.changes) ? item.changes.map(object) : []) {
            const rawPath = string(change.path), path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
            if (!missing.has(path)) continue;
            const kind = typeof change.kind === 'string' ? change.kind : string(object(change.kind).type);
            const list = events.get(path) ?? [];
            list.push({ diff: recordedEventPatch(kind, change.diff), kind }); events.set(path, list);
          }
        }
        break;
      }
      const next = string(object(page.page).nextCursor);
      if (!next || seen.has(next)) break;
      seen.add(next); cursor = next;
    }
  }
  const files: LastTurnChanges['files'] = [];
  for (const row of recorded) {
    const path = string(row.path);
    if (!path) continue;
    const kind = string(row.kind), added = typeof row.added === 'number' ? row.added : null,
      removed = typeof row.removed === 'number' ? row.removed : null;
    if (typeof row.turnDiff === 'string') {
      if (row.turnDiff) files.push({ path, kind, added, removed, turnDiff: row.turnDiff });
      continue;
    }
    const changes = events.get(path) ?? [];
    if (!changes.length || changes.some(event => event.diff === null)) {
      files.push({ path, kind, added, removed, turnDiff: null }); continue;
    }
    const canCompose = changes.every((event, index) => event.kind === 'modify' || event.kind === 'update' || index === 0 && ['create', 'add'].includes(event.kind));
    const composed = canCompose ? composeTurnPatches(changes.map(event => event.diff!), ['create', 'add'].includes(changes[0]!.kind)) : null;
    if (composed !== null) {
      if (composed) files.push({ path, kind, ...countPatch(composed), turnDiff: composed });
    } else {
      changes.forEach((event, index) => files.push({ path, kind: event.kind, ...countPatch(event.diff!), turnDiff: event.diff, entryId: `${turnId}:${index}` }));
    }
  }
  return { turnId, files };
}
