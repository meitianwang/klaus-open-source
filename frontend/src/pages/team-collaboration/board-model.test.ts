import { describe, expect, test } from 'bun:test'
import type { CollaborationIssue, CollaborationMember, CollaborationProject } from '../../../../contracts/team-collaboration'
import { DEFAULT_BOARD_PREFERENCES, ISSUE_PRIORITIES, ISSUE_STATUSES, canWriteProject, groupIssues, isAccessDenied, isConflict, mergeIssues, ownMentionableMembers, parseBoardPreferences, reorderIssue, selectIssues, issueDeepLink } from './board-model'

const project = { id: 'project', archivedAt: null, role: 'member' } as CollaborationProject
const member = (id: string, userId: string, agent = false): CollaborationMember => ({ id, projectId: 'project', userId, kind: agent ? 'agent' : 'human', agentId: agent ? `agent-${id}` : null, role: 'member', joinedAt: '', user: { id: userId, displayName: id, avatarUrl: null }, agent: agent ? { id: `agent-${id}`, ownerId: userId, name: id, description: '', avatarUrl: null, runtimeReference: 'klaus:default', createdAt: '', updatedAt: '', version: 1 } : null })
const members = [member('me', 'user'), member('other', 'other-user'), member('my-agent', 'user', true), member('other-agent', 'other-user', true)]
const issue = (id: string, patch: Partial<CollaborationIssue> = {}): CollaborationIssue => ({ id, projectId: 'project', number: 1, identifier: `K-${id}`, title: id, description: '', status: 'backlog', priority: 'none', assigneeMemberId: null, sortOrder: 1024, cycle: null, createdBy: 'user', createdAt: '2026-09-21T10:00:00.000Z', updatedAt: '2026-09-21T10:00:00.000Z', archivedAt: null, version: 1, ...patch })

describe('collaboration issue board contract', () => {
  test('exposes the exact six statuses and five priorities', () => {
    expect(ISSUE_STATUSES).toEqual(['backlog', 'todo', 'active', 'review', 'done', 'cancelled'])
    expect(ISSUE_PRIORITIES).toEqual(['none', 'urgent', 'high', 'medium', 'low'])
  })
  test('recovers safely from corrupt or untrusted local preferences', () => {
    expect(parseBoardPreferences('{')).toEqual(DEFAULT_BOARD_PREFERENCES)
    expect(parseBoardPreferences('null')).toEqual(DEFAULT_BOARD_PREFERENCES)
    expect(parseBoardPreferences('[]')).toEqual(DEFAULT_BOARD_PREFERENCES)
    const result = parseBoardPreferences(JSON.stringify({ view: 'x', tab: 'x', sort: 'x', group: 'x', statuses: ['active', 'invalid'], priorities: ['urgent', {}], assignees: ['id', null], cycle: false, descending: 'true' }))
    expect(result).toEqual({ ...DEFAULT_BOARD_PREFERENCES, statuses: ['active'], priorities: ['urgent'], assignees: ['id'] })
  })
  test('ignores obsolete view and cycle settings instead of exposing unconnected controls', () => {
    expect(parseBoardPreferences(JSON.stringify({ view: 'table', cycle: 'hidden' }))).toEqual(DEFAULT_BOARD_PREFERENCES)
  })
  test('creates canonical cross-device Issue links and rejects invalid identifiers', () => {
    const projectId = 'ABCDEFAB-1234-1234-1234-ABCDEFABCDEF', issueId = '12345678-1234-1234-1234-123456789012'
    expect(issueDeepLink(projectId, issueId)).toBe(`klaus://issue?projectId=${projectId.toLowerCase()}&issueId=${issueId}`)
    expect(() => issueDeepLink('../../private', issueId)).toThrow()
  })
  test('filters title, not markdown description, and combines conditions', () => {
    const rows = [issue('a', { title: 'Fix Login', priority: 'high', status: 'todo', assigneeMemberId: 'me', cycle: 'Cycle 1' }), issue('b', { description: 'Fix Login' })]
    expect(selectIssues(rows, { ...DEFAULT_BOARD_PREFERENCES, search: ' LOGIN ', statuses: ['todo'], priorities: ['high'], assignees: ['me'] }, members, 'user').map(row => row.id)).toEqual(['a'])
    expect(selectIssues(rows, { ...DEFAULT_BOARD_PREFERENCES, search: 'Login', priorities: ['urgent'] }, members, 'user')).toEqual([])
  })
  test('mine includes self-owned agent assignments but never unknown identities', () => {
    const rows = [issue('a', { assigneeMemberId: 'me' }), issue('b', { assigneeMemberId: 'my-agent' }), issue('c', { assigneeMemberId: 'other' }), issue('d')]
    expect(selectIssues(rows, { ...DEFAULT_BOARD_PREFERENCES, tab: 'mine' }, members, 'user').map(row => row.id)).toEqual(['a', 'b'])
    expect(selectIssues(rows, { ...DEFAULT_BOARD_PREFERENCES, tab: 'mine' }, members, null)).toEqual([])
  })
  test('separates archived issues and filters unassigned issues without a cycle surface', () => {
    const rows = [issue('a'), issue('b', { archivedAt: '2026-09-22' }), issue('c', { cycle: '1' }), issue('d', { assigneeMemberId: 'me' })]
    expect(selectIssues(rows, { ...DEFAULT_BOARD_PREFERENCES, assignees: ['unassigned'] }, members, 'user').map(row => row.id)).toEqual(['a', 'c'])
    expect(selectIssues(rows, { ...DEFAULT_BOARD_PREFERENCES, archived: true }, members, 'user').map(row => row.id)).toEqual(['b'])
  })
  test('sorts urgent first and reverses deterministically without mutating source', () => {
    const rows = [issue('none'), issue('low', { priority: 'low' }), issue('urgent', { priority: 'urgent' }), issue('high', { priority: 'high' })]
    expect(selectIssues(rows, { ...DEFAULT_BOARD_PREFERENCES, sort: 'priority' }, members, 'user').map(row => row.id)).toEqual(['urgent', 'high', 'low', 'none'])
    expect(selectIssues(rows, { ...DEFAULT_BOARD_PREFERENCES, sort: 'priority', descending: true }, members, 'user').map(row => row.id)).toEqual(['none', 'low', 'high', 'urgent'])
    expect(rows[0].id).toBe('none')
  })
  test('keeps all six empty columns for quick creation', () => {
    expect(groupIssues([], 'status', members).map(group => group.key)).toEqual([...ISSUE_STATUSES])
    expect(groupIssues([issue('a', { assigneeMemberId: 'removed' })], 'assignee', members).find(group => group.key === 'removed')?.issues).toHaveLength(1)
  })
  test('persisted move carries the original version and target state', () => {
    const rows = [issue('move', { version: 7 }), issue('first', { status: 'active', sortOrder: 1024 }), issue('last', { status: 'active', sortOrder: 2048 })]
    expect(reorderIssue(rows, 'move', 'active', 'last')).toEqual([{ issueId: 'move', version: 7, status: 'active', sortOrder: 1536 }])
    expect(rows[0].status).toBe('backlog')
    expect(reorderIssue(rows, 'move', 'active', null)[0].sortOrder).toBe(3072)
    expect(reorderIssue(rows, 'move', 'active', 'first')[0].sortOrder).toBe(0)
  })
  test('renumbers a saturated gap atomically with every affected version', () => {
    const rows = [issue('move', { version: 3 }), issue('a', { sortOrder: 1, version: 4 }), issue('b', { sortOrder: 1, version: 5 })]
    expect(reorderIssue(rows, 'move', 'backlog', 'b')).toEqual([
      { issueId: 'a', version: 4, status: 'backlog', sortOrder: 1024 },
      { issueId: 'move', version: 3, status: 'backlog', sortOrder: 2048 },
      { issueId: 'b', version: 5, status: 'backlog', sortOrder: 3072 },
    ])
  })
  test('does not move archived, nonexistent, self, or unknown targets', () => {
    expect(reorderIssue([issue('a', { archivedAt: 'now' })], 'a', 'active', null)).toEqual([])
    expect(reorderIssue([issue('a')], 'b', 'active', null)).toEqual([])
    expect(reorderIssue([issue('a')], 'a', 'active', 'a')).toEqual([])
    expect(reorderIssue([issue('a')], 'a', 'active', 'unknown')).toEqual([])
  })
  test('disables writes without an authenticated human membership or on archive', () => {
    expect(canWriteProject(project, members, 'user')).toBe(true)
    expect(canWriteProject({ ...project, archivedAt: 'now' }, members, 'user')).toBe(false)
    expect(canWriteProject(project, members, null)).toBe(false)
    expect(canWriteProject(project, [member('agent', 'user', true)], 'user')).toBe(false)
  })
  test('mentions only include humans and self-owned agents', () => {
    expect(ownMentionableMembers(members, 'user').map(row => row.id)).toEqual(['me', 'other', 'my-agent'])
    expect(ownMentionableMembers(members, null).map(row => row.id)).toEqual(['me', 'other'])
  })
  test('merges cloud responses without losing unrelated rows', () => {
    const rows = [issue('a'), issue('b')]
    expect(mergeIssues(rows, [issue('a', { version: 2 }), issue('c')]).map(row => [row.id, row.version])).toEqual([['a', 2], ['b', 1], ['c', 1]])
    expect(rows[0].version).toBe(1)
  })
  test('recognizes serialized IPC conflicts and authentication failures', () => {
    expect(isConflict({ code: 'version_conflict' })).toBe(true)
    expect(isConflict({ status: 409 })).toBe(true)
    expect(isConflict(new Error('CONFLICT: current version: 4'))).toBe(true)
    expect(isConflict(new Error('offline'))).toBe(false)
    expect(isAccessDenied({ code: 'NOT_AUTHENTICATED' })).toBe(true)
    expect(isAccessDenied({ code: 'ACCOUNT_CHANGED' })).toBe(true)
    expect(isAccessDenied({ status: 403 })).toBe(true)
    expect(isAccessDenied(new Error('offline'))).toBe(false)
  })
})
