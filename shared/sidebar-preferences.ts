/** Persisted on this computer; controls whether completing a reply moves the conversation to the top of its sidebar group. Absent means on. */
export const SIDEBAR_PROMOTE_ON_REPLY_KEY = 'sidebar.promote_on_reply';

/** Interpret the stored `sidebar.promote_on_reply` setting row; absent or blank defaults to on. */
export function isSidebarPromoteOnReplyEnabled(value: string | null | undefined): boolean {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return true;
  return !['off', '0', 'false', 'no', 'disable', 'disabled'].includes(raw);
}
