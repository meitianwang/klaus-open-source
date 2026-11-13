import { object } from '../ipc/arguments';

export interface PublicInference {
  revision: number;
  changeId?: string;
  model: string;
  source?: string;
  tier?: string;
  selection?: string;
}
/** Explicit whitelist: credentials and route URLs are never public attribution. */
export function publicInference(value: unknown): PublicInference | undefined {
  const row = object(value);
  if (!row || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0
    || typeof row.model !== 'string' || !row.model) return undefined;
  const inference: PublicInference = { revision: row.revision, model: row.model };
  for (const key of ['changeId', 'source', 'tier', 'selection'] as const) {
    if (typeof row[key] === 'string' && row[key]) inference[key] = row[key];
  }
  return inference;
}
export function eventInference(params: unknown): PublicInference | undefined {
  const root = object(params), envelope = object(root?.event), event = object(envelope?.event);
  const detail = object(root?.detail), result = object(root?.result);
  return publicInference(root?.inference) ?? publicInference(detail?.inference) ?? publicInference(object(detail?.error)?.inference)
    ?? publicInference(event?.inference) ?? publicInference(object(event?.event)?.inference)
    ?? publicInference(envelope?.inference) ?? publicInference(result?.inference);
}

/** Public event metadata from the session binding, without provider credentials. */
export interface SessionEventContext {
  /** Exact canonical identity lookup, resolved before input presentation. */
  userDisplayMetadata?: (messageUuid: string, engineSessionId: string) => unknown;
  maxRetries?: number;
  authMode?: string;
  inference?: PublicInference;
  /** The config root, so a projection may read a thread-scoped visualization page at settle time. */
  configRoot?: string;
}

/** Keep the retry display aligned with the budget sent at session creation.
 *  The fallback mirrors the engine's own default stream retry budget (5), so a
 *  legacy engine that reports no budget still shows the budget it enforces. */
export function normalizeSessionMaxRetries(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 5;
}
