import type { Json } from '../ipc/contract';
import { object, string } from './service-types';

/** Undefined is an unknown head; null is a known empty queue. */
export function notificationQueuePending(head: unknown): boolean {
  if (head === undefined) return true;
  if (head === null) return false;
  const row = object(head);
  return row.dispatching === true || row.pausedReason == null;
}

function parent(row: Record<string, Json>): string {
  const direct = string(row.parentSessionId) || string(row.parentThreadId);
  if (direct) return direct;
  let source = row.source ?? row.threadSource;
  if (typeof source === 'string') { try { source = JSON.parse(source) as Json; } catch { return ''; } }
  const value = object(source);
  return string(value.parentThreadId) || string(object(value.subagent).parentThreadId);
}
function runtime(row: Record<string, Json>): string {
  return string(object(row.runtimeStatus ?? row.runtime_status).type) || (row.isWorking === true ? 'active' : '');
}

/** Known effective-active descendants retain their ancestors regardless of Goal or mode. */
export function hasActiveNotificationDescendant(id: string, summaries: Json[], cached: Json[]): boolean {
  const summary = new Map<string, Record<string, Json>>(), cache = new Map<string, Record<string, Json>>();
  for (const [rows, target] of [[summaries, summary], [cached, cache]] as const) for (const raw of rows) {
    const row = object(raw), key = string(row.id) || string(row.threadId);
    if (key) target.set(key, row);
  }
  const known = new Map<string, Record<string, Json>>();
  for (const key of new Set([...summary.keys(), ...cache.keys()])) {
    const saved = summary.get(key), current = cache.get(key), state = current && runtime(current);
    const effective = !current || ['needs_resume', 'notLoaded', 'not_loaded'].includes(state || '') ? runtime(saved ?? {}) : state;
    known.set(key, { ...saved, ...current, runtimeStatus: { type: effective || '' } });
  }
  for (const [key, row] of known) {
    if (key === id || runtime(row) !== 'active') continue;
    const visited = new Set<string>([key]);
    let next = parent(row);
    while (next && !visited.has(next)) {
      if (next === id) return true;
      visited.add(next); next = parent(known.get(next) ?? {});
    }
  }
  return false;
}
