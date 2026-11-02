/**
 * Search and paging grammar for the composer's conversation picker.
 *
 * The picker is a search surface, not a second catalog: an empty query returns
 * nothing, and the host only ever sends the compact `{id,title}` projection the
 * menu can draw. Ranking and filtering happen against the host's existing
 * conversation snapshot, so typing never re-reads the engine directory.
 */

/** The picker requests up to this many matches by default. */
export const SESSION_MENTION_DEFAULT_LIMIT = 50;
/** A single response never carries more than this many matches. */
export const SESSION_MENTION_MAX_LIMIT = 50;
/** A search query longer than this is rejected rather than truncated. */
export const SESSION_MENTION_QUERY_MAX_CHARS = 256;
/** Opaque cursors stay inside the same envelope as the other paged reads. */
export const SESSION_MENTION_CURSOR_MAX_BYTES = 4096;

const CURSOR_VERSION = 1;
/**
 * How many already-returned ids a cursor carries. This is a deduplication
 * window, not the pagination position: the position is the last row's sort key,
 * which survives deletions and renames. The window only has to cover rows that
 * moved behind the cursor while the menu was open.
 */
const CURSOR_SEEN_LIMIT = 64;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface SessionMentionCandidate {
  id: string;
  title: string;
}

export interface SessionMentionPage {
  items: SessionMentionCandidate[];
  nextCursor: string | null;
}

export interface SessionMentionRequest {
  query?: string;
  cursor?: string;
  limit?: number;
}

/** One compact, already-ranked row in the host's search index. */
export interface SessionMentionEntry {
  id: string;
  title: string;
  sortAt: number;
}

export interface SessionMentionCursor {
  query: string;
  revision: number;
  id: string;
  seen: string[];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = index + 1 < bytes.length ? bytes[index + 1]! : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2]! : 0;
    out += BASE64URL[first >> 2];
    out += BASE64URL[((first & 0x03) << 4) | (second >> 4)];
    if (index + 1 < bytes.length) out += BASE64URL[((second & 0x0f) << 2) | (third >> 6)];
    if (index + 2 < bytes.length) out += BASE64URL[third & 0x3f];
  }
  return out;
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!value || value.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const index = BASE64URL.indexOf(char);
    if (index < 0) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** A title the menu can show: trimmed, with runs of whitespace collapsed. */
export function normalizeSessionMentionTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/** Whitespace-only searches are empty searches and never list recent conversations. */
export function normalizeSessionMentionQuery(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function matchText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/**
 * Relevance tiers: an exact title outranks a prefix, then a substring, then an
 * in-order subsequence. Ranking happens before the page limit so a very old
 * conversation whose title is exactly the query is never hidden behind newer
 * loose matches.
 */
export type SessionMentionRank = 0 | 1 | 2 | 3;

/** The title's relevance tier, or `null` when it does not match at all. */
export function sessionMentionRank(title: string, query: string): SessionMentionRank | null {
  const needle = matchText(query);
  if (!needle) return null;
  const haystack = matchText(title);
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  if (haystack.includes(needle)) return 2;
  let from = 0;
  for (const char of Array.from(needle)) {
    const found = haystack.indexOf(char, from);
    if (found < 0) return null;
    from = found + char.length;
  }
  return 3;
}

/** A title matches by exact text, prefix, substring or an in-order subsequence. */
export function sessionMentionMatches(title: string, query: string): boolean {
  return sessionMentionRank(title, query) !== null;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Recency wins, with the updated clock as the fallback for older rows. */
export function sessionMentionSortAt(row: Record<string, unknown>): number {
  return timestamp(row.recencyAt) ?? timestamp(row.updatedAt) ?? timestamp(row.updated_at) ?? 0;
}

function compareEntries(left: SessionMentionEntry, right: SessionMentionEntry): number {
  return right.sortAt - left.sortAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/**
 * Project the metadata snapshot into compact, stably ordered entries.
 *
 * Duplicate ids keep their first occurrence. Visibility and non-empty titles are
 * checked when a page is produced, because both can change without the snapshot
 * array being replaced.
 */
export function buildSessionMentionEntries(rows: readonly unknown[]): SessionMentionEntry[] {
  const entries: SessionMentionEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const value = row as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id : typeof value.threadId === 'string' ? value.threadId : '';
    if (!id || seen.has(id) || value.archived === true) continue;
    seen.add(id);
    entries.push({ id, title: normalizeSessionMentionTitle(value.title), sortAt: sessionMentionSortAt(value) });
  }
  entries.sort(compareEntries);
  return entries;
}

export function encodeSessionMentionCursor(cursor: SessionMentionCursor): string {
  const encoder = new TextEncoder();
  const seen = cursor.seen.slice(-CURSOR_SEEN_LIMIT);
  let encoded = '';
  for (;;) {
    encoded = base64UrlEncode(encoder.encode(JSON.stringify({
      v: CURSOR_VERSION,
      q: cursor.query,
      r: cursor.revision,
      i: cursor.id,
      s: seen,
    })));
    if (byteLength(encoded) <= SESSION_MENTION_CURSOR_MAX_BYTES || seen.length === 0) return encoded;
    // A maximum-length Unicode query plus a full dedupe window can exceed the
    // shared cursor budget. Drop the oldest already-returned ids until the
    // next page can still be requested.
    seen.shift();
  }
}

/** Decode a cursor, or answer `null` so the caller can reject it as malformed input. */
export function decodeSessionMentionCursor(value: string): SessionMentionCursor | null {
  if (typeof value !== 'string' || !value || byteLength(value) > SESSION_MENTION_CURSOR_MAX_BYTES) return null;
  const bytes = base64UrlDecode(value);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== CURSOR_VERSION
    || typeof record.q !== 'string' || byteLength(record.q) > SESSION_MENTION_CURSOR_MAX_BYTES
    || !Number.isSafeInteger(record.r) || (record.r as number) < 0
    || typeof record.i !== 'string' || !record.i
    || !Array.isArray(record.s) || record.s.some(id => typeof id !== 'string' || !id)) {
    return null;
  }
  return {
    query: record.q,
    revision: record.r as number,
    id: record.i,
    seen: (record.s as string[]).slice(-CURSOR_SEEN_LIMIT),
  };
}

/**
 * Page a filtered, already-ranked entry list.
 *
 * The cursor stores the query, the snapshot revision and the last returned id.
 * While the revision is unchanged that id is the position, so a rename keeps
 * paging exact. A replaced snapshot or a deleted anchor replays the ranked
 * matches from the start while skipping ids still inside the bounded seen
 * window; this avoids duplicates and skipped rows within that window. Beyond
 * the window a row that moved behind the cursor can appear again, which keeps
 * the cursor inside the shared size limit. The cursor never claims an
 * unbounded history guarantee.
 */
export function pageSessionMentions(input: {
  entries: readonly SessionMentionEntry[];
  query: string;
  limit: number;
  revision: number;
  cursor?: SessionMentionCursor;
}): SessionMentionPage {
  const { entries, query, limit, revision, cursor } = input;
  const matches = entries
    .flatMap(entry => {
      const rank = sessionMentionRank(entry.title, query);
      return rank === null ? [] : [{ entry, rank }];
    })
    .sort((left, right) => left.rank - right.rank || compareEntries(left.entry, right.entry))
    .map(match => match.entry);
  const seen = new Set(cursor?.seen ?? []);
  let start = 0;
  if (cursor && cursor.revision === revision) {
    const anchor = matches.findIndex(entry => entry.id === cursor.id);
    if (anchor >= 0) start = anchor + 1;
  }
  const items: SessionMentionCandidate[] = [];
  let index = start;
  while (index < matches.length && items.length < limit) {
    const entry = matches[index++]!;
    if (seen.has(entry.id)) continue;
    items.push({ id: entry.id, title: entry.title });
  }
  const last = items[items.length - 1];
  const more = index < matches.length;
  const nextCursor = more && last
    ? encodeSessionMentionCursor({
      query,
      revision,
      id: last.id,
      seen: [...seen, ...items.map(item => item.id)],
    })
    : null;
  return { items, nextCursor };
}
