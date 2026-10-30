import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';

const NOTICE_SETUP_STATUSES = new Set([
  'failed',
  'persistence_failed',
  'interrupted',
  'outcome_unknown',
  'too_late',
  'request_conflict',
  'shutdown',
]);

/** Project setup failures that the engine does not push onto the live event stream. */
export function setupLifecycleNotices(reply: Json, sessionId: string): Json[] {
  const snapshot = object(object(reply)?.setupLifecycle ?? reply);
  const results = object(snapshot?.idempotencyResults);
  if (!results) return [];
  const notices: Json[] = [];
  for (const [fallbackId, raw] of Object.entries(results)) {
    const result = object(raw), status = typeof result?.status === 'string' ? result.status : '';
    if (!NOTICE_SETUP_STATUSES.has(status)) continue;
    const requestId = typeof result?.requestId === 'string' && result.requestId ? result.requestId : fallbackId;
    const suffix = typeof result?.error === 'string' && result.error ? ` (${result.error})` : '';
    notices.push({ type: 'notice', sessionId, level: 'warning', content: `setup ${requestId}: ${status}${suffix}` });
  }
  return notices;
}
