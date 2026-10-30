import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { teamIssueRouteHash } from './project-navigation'
import { routeHash } from './data'

const projectId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
const issueId = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'

describe('team Issue deep-link routing', () => {
  test('uses UUIDs and preserves unrelated chat route values', () => {
    const hash = teamIssueRouteHash('#session=chat%2F1&note=a+b&tcProject=old&tcIssue=old&tcInvite=secret&tcArchived=1&tcSearch=old&tcView=grid', { projectId, issueId })!
    const params = new URLSearchParams(hash.slice(1))
    expect(params.get('session')).toBe('chat/1')
    expect(params.get('note')).toBe('a b')
    expect(params.get('tcProject')).toBe(projectId.toLowerCase())
    expect(params.get('tcIssue')).toBe(issueId.toLowerCase())
    for (const key of ['tcInvite', 'tcArchived', 'tcSearch', 'tcView']) expect(params.has(key)).toBe(false)
  })
  test('does not turn identifiers, missing IDs or arbitrary payloads into routes', () => {
    for (const value of [null, undefined, '', [], {}, { projectId }, { projectId, issueId: 'ABC-123' }, { projectId: 'javascript:alert(1)', issueId }]) {
      expect(teamIssueRouteHash('#session=current', value)).toBeNull()
    }
  })
  test('an identical deep link remains a valid route', () => {
    const hash = teamIssueRouteHash('', { projectId, issueId })!
    expect(teamIssueRouteHash(hash, { projectId, issueId })).toBe(hash)
  })
  test('leaving or changing the project drops an old Issue selection', () => {
    const old = `#session=chat&tcProject=${projectId}&tcIssue=${issueId}`
    expect(routeHash(old, { projectId: null, archived: false, inviteToken: null })).toBe('#session=chat')
    expect(routeHash(old, { projectId: 'other', archived: false, inviteToken: null })).toBe('#session=chat&tcProject=other')
  })
  test('the actual chat shell subscribes to the published host event and keeps sidebar navigation', () => {
    const chat = readFileSync(new URL('../../chat/chat.ts', import.meta.url), 'utf8')
    expect(chat).toContain("window.addEventListener('hashchange', restoreCollaborationRoute)")
    expect(chat).toContain('klausApi.on.deepLinkOpenTeamIssue?.((payload: unknown) => { openTeamIssueDeepLink(payload) })')
    expect(chat).toContain("document.getElementById('btn-team-collaboration')?.addEventListener('click'")
  })
})
