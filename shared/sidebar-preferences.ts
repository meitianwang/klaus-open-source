/** Persisted on this computer; controls whether completing a reply moves the conversation to the top of its sidebar group. Absent means on. */
export const SIDEBAR_PROMOTE_ON_REPLY_KEY = 'sidebar.promote_on_reply';

/** Persisted on this computer; JSON string array of conversation identities with unread activity (completed turns or inbound messages). */
export const SIDEBAR_UNREAD_SESSIONS_KEY = 'sidebar.unread_sessions';

const MAX_UNREAD_SESSION_IDS = 2000;
const MAX_UNREAD_SESSION_ID_LENGTH = 512;

/** Normalize a raw setting value or parsed array into deduplicated conversation identities. */
export function parseSidebarUnreadSessions(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try { list = JSON.parse(trimmed); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || id.length > MAX_UNREAD_SESSION_ID_LENGTH || id.includes('\0') || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_UNREAD_SESSION_IDS) break;
  }
  return out;
}

/** Serialize conversation identities into the canonical `sidebar.unread_sessions` value. */
export function serializeSidebarUnreadSessions(ids: Iterable<string>): string {
  return JSON.stringify(parseSidebarUnreadSessions([...ids]));
}

/** Interpret the stored `sidebar.promote_on_reply` setting row; absent or blank defaults to on. */
export function isSidebarPromoteOnReplyEnabled(value: string | null | undefined): boolean {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return true;
  return !['off', '0', 'false', 'no', 'disable', 'disabled'].includes(raw);
}
