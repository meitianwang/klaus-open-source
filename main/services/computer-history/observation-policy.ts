/** Observation policy: include/exclude entries per app bundle id or URL domain. */
export interface ObservationEntry {
  observe: 'include' | 'exclude';
  scope: 'app' | 'url';
  target: string;
}

export const COMPUTER_HISTORY_ENABLED_KEY = 'computer_history.enabled';
export const COMPUTER_HISTORY_POLICY_KEY = 'computer_history.observation_policy';
export const COMPUTER_HISTORY_MAX_POLICY_ENTRIES = 256;

/** Private-browsing window markers; frames matching these are never recorded. */
export const PRIVATE_WINDOW_MARKERS: readonly string[] = [
  'private browsing', 'incognito', 'inprivate', 'private window', 'プライベート', 'シークレット',
];

const APP_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const DOMAIN_TARGET_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/u;

export function isPrivateWindowTitle(title: string | undefined, url: string | undefined): boolean {
  for (const value of [title, url]) {
    if (!value) continue;
    const lower = value.toLowerCase();
    if (PRIVATE_WINDOW_MARKERS.some(marker => lower.includes(marker))) return true;
  }
  return false;
}

export function validateObservationEntry(payload: unknown): ObservationEntry {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Observation entry must be an object');
  const row = payload as Record<string, unknown>;
  for (const key of Object.keys(row)) if (!['observe', 'scope', 'target'].includes(key)) throw new Error(`Unknown observation field: ${key}`);
  if (row.observe !== 'include' && row.observe !== 'exclude') throw new Error('observe must be include or exclude');
  if (row.scope !== 'app' && row.scope !== 'url') throw new Error('scope must be app or url');
  if (typeof row.target !== 'string' || !row.target.trim()) throw new Error('target must be a non-empty string');
  const target = row.target.trim().toLowerCase();
  if (row.scope === 'app' ? !APP_TARGET_PATTERN.test(target) : !DOMAIN_TARGET_PATTERN.test(target))
    throw new Error(row.scope === 'app' ? 'app target must be a bundle identifier' : 'url target must be a domain');
  return { observe: row.observe, scope: row.scope, target };
}

export function parseObservationPolicy(raw: string | undefined): ObservationEntry[] {
  if (raw === undefined) return [];
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Computer History observation policy is unreadable; it is treated as empty until repaired'); }
  if (!Array.isArray(value) || value.length > COMPUTER_HISTORY_MAX_POLICY_ENTRIES) throw new Error('Computer History observation policy is invalid');
  return value.map(item => validateObservationEntry(item));
}

export function serializeObservationPolicy(entries: readonly ObservationEntry[]): string {
  return JSON.stringify(entries);
}

/** One (scope, target) pair carries exactly one observe value; upsert replaces it. */
export function upsertObservationEntry(entries: readonly ObservationEntry[], entry: ObservationEntry): ObservationEntry[] {
  const result = entries.filter(existing => !(existing.scope === entry.scope && existing.target === entry.target));
  result.push(entry);
  if (result.length > COMPUTER_HISTORY_MAX_POLICY_ENTRIES) throw new Error('Computer History observation policy limit exceeded');
  return result;
}

export function removeObservationEntry(entries: readonly ObservationEntry[], scope: ObservationEntry['scope'], target: string): ObservationEntry[] {
  return entries.filter(entry => !(entry.scope === scope && entry.target === target));
}

export function urlHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * With no include entries everything except exclusions is observed; once any
 * include entry exists, only included targets are observed, minus exclusions.
 */
export function shouldObserve(frame: { bundleId?: string; url?: string }, entries: readonly ObservationEntry[]): boolean {
  const host = urlHost(frame.url);
  let included = !entries.some(entry => entry.observe === 'include');
  for (const entry of entries) {
    const matches = entry.scope === 'app'
      ? !!frame.bundleId && frame.bundleId.toLowerCase() === entry.target
      : !!host && hostMatches(host, entry.target);
    if (!matches) continue;
    if (entry.observe === 'exclude') return false;
    included = true;
  }
  return included;
}
