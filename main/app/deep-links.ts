import { parseFriendInvite } from '../../shared/friends';
import { isDesktopProtocol } from '../../shared/desktop-edition';

export interface TeamIssueDeepLink { projectId: string; issueId: string }
export type DeepLinkAction = { kind: 'new' | 'settings' } | { kind: 'open'; sessionId: string } | ({ kind: 'issue' } & TeamIssueDeepLink) | { kind: 'friend'; email: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function teamIssueDeepLink(projectId: string, issueId: string, protocol = 'klaus'): string {
  if (!isDesktopProtocol(protocol)) throw new Error('Invalid desktop protocol');
  if (!uuid.test(projectId) || !uuid.test(issueId)) throw new Error('Issue links require project and issue UUIDs');
  return `${protocol}://issue?projectId=${projectId.toLowerCase()}&issueId=${issueId.toLowerCase()}`;
}

export function parseDeepLink(raw: string, protocol = 'klaus'): DeepLinkAction | undefined {
  if (!isDesktopProtocol(protocol)) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== protocol + ':' || url.username || url.password || url.port) return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    const verb = (url.hostname || parts.shift() || '').toLowerCase();
    if (verb === 'issue') {
      const keys = [...url.searchParams.keys()], projectId = url.searchParams.get('projectId'), issueId = url.searchParams.get('issueId');
      if (url.hostname.toLowerCase() !== 'issue' || url.pathname !== '' || url.hash || keys.length !== 2
        || !keys.includes('projectId') || !keys.includes('issueId') || !projectId || !issueId || !uuid.test(projectId) || !uuid.test(issueId)) return undefined;
      return { kind: 'issue', projectId: projectId.toLowerCase(), issueId: issueId.toLowerCase() };
    }
    if (verb === 'new' || verb === 'settings') return { kind: verb };
    // The add-me link another Klaus user shared: clicking it lands on the
    // friends page with the add dialog prefilled, never on a raw URL.
    if (verb === 'friend') {
      const invite = parseFriendInvite(raw, protocol);
      if (!invite || url.hash || url.username || url.password) return undefined;
      return { kind: 'friend', email: invite.email };
    }
    const sessionId = url.searchParams.get('session') || (parts[0] ? decodeURIComponent(parts[0]) : '');
    if (verb === 'open' && sessionId) return { kind: 'open', sessionId };
  } catch { /* Invalid URLs have no application action. */ }
  return undefined;
}
