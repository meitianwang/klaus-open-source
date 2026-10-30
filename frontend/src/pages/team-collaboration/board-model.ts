import type { CollaborationIssue, CollaborationIssueStatus, CollaborationMember, CollaborationPriority, CollaborationProject } from '../../../../contracts/team-collaboration'
import { teamIssueDeepLink } from '../../../../main/app/deep-links'
import { desktopDistribution } from '../../app/distribution'

export const ISSUE_STATUSES = ['backlog', 'todo', 'active', 'review', 'done', 'cancelled'] as const
export const ISSUE_PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const
export type BoardTab = 'all' | 'mine' | CollaborationIssueStatus
export type BoardGroup = 'status' | 'priority' | 'assignee' | 'none'
export type BoardSort = 'manual' | 'priority' | 'created' | 'updated' | 'title'
export type FilterOperator = 'any' | 'none'
export type FilterField = 'statuses' | 'priorities' | 'assignees'
export const FILTER_OPERATOR_KEYS = { statuses: 'statusOperator', priorities: 'priorityOperator', assignees: 'assigneeOperator' } as const
export interface BoardPreferences {
  tab: BoardTab; search: string; statuses: CollaborationIssueStatus[];
  priorities: CollaborationPriority[]; assignees: string[]; sort: BoardSort; descending: boolean;
  group: BoardGroup; description: boolean; cardNumber: boolean; cardPriority: boolean; cardCreatedAt: boolean;
  statusOperator: FilterOperator; priorityOperator: FilterOperator; assigneeOperator: FilterOperator;
  archived: boolean
}
export const DEFAULT_BOARD_PREFERENCES: BoardPreferences = {
  tab: 'all', search: '', statuses: [], priorities: [], assignees: [],
  sort: 'manual', descending: false, group: 'status', description: true, cardNumber: true, cardPriority: true, cardCreatedAt: true,
  statusOperator: 'any', priorityOperator: 'any', assigneeOperator: 'any', archived: false,
}
export function parseBoardPreferences(value: string | null): BoardPreferences {
  try {
    const input = JSON.parse(value || '{}')
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...DEFAULT_BOARD_PREFERENCES }
    return {
      tab: ['all', 'mine', ...ISSUE_STATUSES].includes(input.tab) ? input.tab : 'all',
      search: typeof input.search === 'string' ? input.search : '',
      statuses: Array.isArray(input.statuses) ? input.statuses.filter((x: unknown) => ISSUE_STATUSES.includes(x as CollaborationIssueStatus)) : [],
      priorities: Array.isArray(input.priorities) ? input.priorities.filter((x: unknown) => ISSUE_PRIORITIES.includes(x as CollaborationPriority)) : [],
      assignees: Array.isArray(input.assignees) ? input.assignees.filter((x: unknown) => typeof x === 'string') : [],
      sort: ['manual', 'priority', 'created', 'updated', 'title'].includes(input.sort) ? input.sort : 'manual',
      descending: input.descending === true,
      group: ['status', 'priority', 'assignee', 'none'].includes(input.group) ? input.group : 'status',
      description: input.description !== false, cardNumber: input.cardNumber !== false, cardPriority: input.cardPriority !== false, cardCreatedAt: input.cardCreatedAt !== false,
      statusOperator: input.statusOperator === 'none' ? 'none' : 'any', priorityOperator: input.priorityOperator === 'none' ? 'none' : 'any', assigneeOperator: input.assigneeOperator === 'none' ? 'none' : 'any',
      archived: input.archived === true,
    }
  } catch { return { ...DEFAULT_BOARD_PREFERENCES } }
}
export function matchesFilter(value: string, selected: readonly string[], operator: FilterOperator): boolean {
  return !selected.length || (operator === 'none' ? !selected.includes(value) : selected.includes(value))
}
export function filterOptions(options: { value: string; label: string }[], selected: readonly string[], search: string): { value: string; label: string }[] {
  const query = search.trim().toLocaleLowerCase()
  return options.filter(option => !query || option.label.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(selected.includes(b.value)) - Number(selected.includes(a.value)) || a.label.localeCompare(b.label))
}
export interface SavedBoardFilter { id: string; name: string; preferences: BoardPreferences }
export function parseSavedBoardFilters(value: string | null): SavedBoardFilter[] {
  try {
    const input: unknown = JSON.parse(value || '[]')
    if (!Array.isArray(input)) return []
    return input.flatMap(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim()
      ? [{ id: item.id, name: item.name.trim(), preferences: parseBoardPreferences(JSON.stringify(item.preferences)) }] : [])
  } catch { return [] }
}
export interface KeyboardIssueTarget { issueId: string; status: CollaborationIssueStatus; beforeId: string | null }
export function keyboardIssueTarget(issues: CollaborationIssue[], current: KeyboardIssueTarget, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): KeyboardIssueTarget {
  const siblings = (status: CollaborationIssueStatus) => issues.filter(issue => !issue.archivedAt && issue.id !== current.issueId && issue.status === status).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  const original = siblings(current.status)
  let index = current.beforeId ? Math.max(0, original.findIndex(issue => issue.id === current.beforeId)) : original.length
  let status = current.status
  if (key === 'ArrowUp') index = Math.max(0, index - 1)
  if (key === 'ArrowDown') index = Math.min(original.length, index + 1)
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const next = Math.max(0, Math.min(ISSUE_STATUSES.length - 1, ISSUE_STATUSES.indexOf(status) + (key === 'ArrowRight' ? 1 : -1)))
    status = ISSUE_STATUSES[next]
  }
  const target = siblings(status)
  return { issueId: current.issueId, status, beforeId: target[Math.min(index, target.length)]?.id || null }
}
export function issueDeepLink(projectId: string, issueId: string): string {
  return teamIssueDeepLink(projectId, issueId, desktopDistribution().protocol)
}
export function memberName(member: CollaborationMember | undefined): string {
  return member?.agent?.name || member?.user.displayName || ''
}
export function canWriteProject(project: CollaborationProject, members: CollaborationMember[], userId: string | null): boolean {
  return !project.archivedAt && !!userId && members.some(m => m.kind === 'human' && m.userId === userId)
}
export function ownMentionableMembers(members: CollaborationMember[], userId: string | null): CollaborationMember[] {
  return members.filter(m => m.kind === 'human' || (!!userId && m.agent?.ownerId === userId))
}
const priorityRank: Record<CollaborationPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
export function selectIssues(issues: CollaborationIssue[], prefs: BoardPreferences, members: CollaborationMember[], userId: string | null): CollaborationIssue[] {
  const mine = new Set(members.filter(m => m.userId === userId).map(m => m.id))
  const result = issues.filter(issue => {
    if (!!issue.archivedAt !== prefs.archived) return false
    if (prefs.tab === 'mine' && (!issue.assigneeMemberId || !mine.has(issue.assigneeMemberId))) return false
    if (ISSUE_STATUSES.includes(prefs.tab as CollaborationIssueStatus) && issue.status !== prefs.tab) return false
    return (!prefs.search.trim() || issue.title.toLocaleLowerCase().includes(prefs.search.trim().toLocaleLowerCase()))
      && matchesFilter(issue.status, prefs.statuses, prefs.statusOperator)
      && matchesFilter(issue.priority, prefs.priorities, prefs.priorityOperator)
      && matchesFilter(issue.assigneeMemberId || 'unassigned', prefs.assignees, prefs.assigneeOperator)
  })
  return result.sort((a, b) => {
    let order = 0
    switch (prefs.sort) {
      case 'manual': order = a.sortOrder - b.sortOrder; break
      case 'priority': order = priorityRank[a.priority] - priorityRank[b.priority]; break
      case 'created': order = a.createdAt.localeCompare(b.createdAt); break
      case 'updated': order = a.updatedAt.localeCompare(b.updatedAt); break
      case 'title': order = a.title.localeCompare(b.title); break
    }
    return (order || a.id.localeCompare(b.id)) * (prefs.descending ? -1 : 1)
  })
}
export function groupIssues(issues: CollaborationIssue[], group: BoardGroup, members: CollaborationMember[]): { key: string; issues: CollaborationIssue[] }[] {
  const keys: string[] = group === 'status' ? [...ISSUE_STATUSES] : group === 'priority' ? [...ISSUE_PRIORITIES] : group === 'assignee' ? ['unassigned', ...members.map(m => m.id)] : ['all']
  const keyOf = (issue: CollaborationIssue) => group === 'status' ? issue.status : group === 'priority' ? issue.priority : group === 'assignee' ? issue.assigneeMemberId || 'unassigned' : 'all'
  for (const issue of issues) if (!keys.includes(keyOf(issue))) keys.push(keyOf(issue))
  return keys.map(key => ({ key, issues: issues.filter(issue => keyOf(issue) === key) }))
}
export function reorderIssue(issues: CollaborationIssue[], issueId: string, status: CollaborationIssueStatus, beforeId: string | null): { issueId: string; version: number; status: CollaborationIssueStatus; sortOrder: number }[] {
  const issue = issues.find(row => row.id === issueId)
  if (!issue || issue.archivedAt || beforeId === issueId) return []
  const target = issues.filter(row => !row.archivedAt && row.status === status && row.id !== issueId).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  const index = beforeId ? target.findIndex(row => row.id === beforeId) : target.length
  if (index < 0) return []
  const previous = target[index - 1]?.sortOrder
  const next = target[index]?.sortOrder
  const order = previous === undefined ? (next === undefined ? 1024 : next - 1024) : next === undefined ? previous + 1024 : previous + (next - previous) / 2
  if (Number.isFinite(order) && (previous === undefined || order > previous) && (next === undefined || order < next)) {
    return [{ issueId, version: issue.version, status, sortOrder: order }]
  }
  target.splice(index, 0, issue)
  return target.map((row, i) => ({ issueId: row.id, version: row.version, status, sortOrder: (i + 1) * 1024 }))
}
export function mergeIssues(issues: CollaborationIssue[], updated: CollaborationIssue[]): CollaborationIssue[] {
  const changes = new Map(updated.map(issue => [issue.id, issue]))
  return [...issues.map(issue => changes.get(issue.id) || issue), ...updated.filter(issue => !issues.some(old => old.id === issue.id))]
}
export function isConflict(error: unknown): boolean {
  const e = error as { code?: string; message?: string; status?: number } | null
  return e?.status === 409 || /conflict|version|409/i.test(`${e?.code || ''} ${e?.message || ''}`)
}
export function isAccessDenied(error: unknown): boolean {
  const e = error as { code?: string; message?: string; status?: number } | null
  return e?.status === 401 || e?.status === 403 || /forbidden|not_authenticated|account_changed|membership_required|401|403/i.test(`${e?.code || ''} ${e?.message || ''}`)
}
