import type { CollaborationProject } from '../../../../contracts/team-collaboration'

export const PROJECT_NAME_LIMIT = 80
export const PROJECT_DESCRIPTION_LIMIT = 150
export const PROJECT_FILTERS = ['all', 'focused', 'unfocused'] as const
export const PROJECT_SORTS = ['updated-desc', 'created-desc', 'name-asc', 'name-desc'] as const
export type ProjectFilter = typeof PROJECT_FILTERS[number]
export type ProjectSort = typeof PROJECT_SORTS[number]
export interface ProjectPreferences { focusedIds: string[]; search: string; filter: ProjectFilter; sort: ProjectSort }
export const emptyProjectPreferences = (): ProjectPreferences => ({ focusedIds: [], search: '', filter: 'all', sort: 'updated-desc' })
export function projectPreferencesKey(accountId: string): string { return `klaus:team-collaboration:projects:${encodeURIComponent(accountId)}` }
export function parseProjectPreferences(raw: string | null): ProjectPreferences {
  if (!raw) return emptyProjectPreferences()
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid project preferences')
  const value = parsed as Partial<ProjectPreferences>
  return {
    focusedIds: Array.isArray(value.focusedIds) ? [...new Set(value.focusedIds.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [],
    search: typeof value.search === 'string' ? value.search : '',
    filter: PROJECT_FILTERS.includes(value.filter as ProjectFilter) ? value.filter! : 'all',
    sort: PROJECT_SORTS.includes(value.sort as ProjectSort) ? value.sort! : 'updated-desc',
  }
}
export function filterAndSortProjects(projects: CollaborationProject[], preferences: ProjectPreferences, locale: string): CollaborationProject[] {
  const focused = new Set(preferences.focusedIds), query = preferences.search.trim().toLocaleLowerCase()
  const time = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0
  const byName = (a: CollaborationProject, b: CollaborationProject) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' })
  return projects.filter(project => {
    if (preferences.filter === 'focused' && !focused.has(project.id) || preferences.filter === 'unfocused' && focused.has(project.id)) return false
    return !query || `${project.name} ${project.description}`.toLocaleLowerCase().includes(query)
  }).sort((a, b) => {
    switch (preferences.sort) {
      case 'created-desc': return time(b.createdAt) - time(a.createdAt) || byName(a, b)
      case 'name-asc': return byName(a, b) || time(b.updatedAt) - time(a.updatedAt)
      case 'name-desc': return byName(b, a) || time(b.updatedAt) - time(a.updatedAt)
      default: return time(b.updatedAt) - time(a.updatedAt) || byName(a, b)
    }
  })
}

export interface ProjectFormValue { name: string; identifier: string; description: string; repositoryUrl: string; coverIcon: string; coverColor: string }
export type ProjectDraftFields = Pick<ProjectFormValue, 'name' | 'description' | 'repositoryUrl' | 'coverIcon' | 'coverColor'>
export interface ProjectDraftPatch { name?: string; description?: string; repositoryUrl?: string | null; coverId?: string; coverIconId?: string }
export function projectDraftPatchToFields(patch: ProjectDraftPatch, colors: Record<string, string>, iconIds: string[]): Partial<ProjectDraftFields> | null {
  const next: Partial<ProjectDraftFields> = {}
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.length > PROJECT_NAME_LIMIT) return null
    next.name = patch.name
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== 'string' || patch.description.length > PROJECT_DESCRIPTION_LIMIT) return null
    next.description = patch.description
  }
  if (patch.repositoryUrl !== undefined) {
    if (patch.repositoryUrl !== null && (typeof patch.repositoryUrl !== 'string' || patch.repositoryUrl && !normalizeProjectRepositoryUrl(patch.repositoryUrl))) return null
    next.repositoryUrl = patch.repositoryUrl || ''
  }
  if (patch.coverId !== undefined) {
    if (typeof patch.coverId !== 'string' || !Object.hasOwn(colors, patch.coverId)) return null
    next.coverColor = colors[patch.coverId]
  }
  if (patch.coverIconId !== undefined) {
    if (typeof patch.coverIconId !== 'string' || !iconIds.includes(patch.coverIconId)) return null
    next.coverIcon = patch.coverIconId
  }
  return next
}
export const PROJECT_DRAFT_FIELDS = ['name', 'description', 'repositoryUrl', 'coverIcon', 'coverColor'] as const
export function applyProjectDraftPatch(current: ProjectFormValue, snapshot: ProjectDraftFields, patch: Partial<ProjectDraftFields>): ProjectFormValue {
  const next = { ...current }
  for (const key of PROJECT_DRAFT_FIELDS) {
    if (typeof patch[key] === 'string' && current[key] === snapshot[key]) next[key] = patch[key]!
  }
  return next
}
export interface DraftHistoryMessage { role: 'user' | 'assistant'; text: string; id: string }
export function boundedDraftHistory(messages: DraftHistoryMessage[]): Array<Pick<DraftHistoryMessage, 'role' | 'text'>> {
  const selected = messages.slice(-12).map(({ role, text }) => ({ role, text }))
  let size = selected.reduce((total, message) => total + message.text.length, 0)
  while (size > 16000 && selected.length) size -= selected.splice(0, 2).reduce((total, message) => total + message.text.length, 0)
  return selected
}

export function normalizeProjectRepositoryUrl(value: string): string | null {
  if (!value || value.length > 2048 || /[\s\\?#\u0000-\u001f\u007f]/u.test(value)) return null
  if (!/^(https|ssh):\/\//i.test(value)) return /^[A-Za-z0-9._-]+@(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9a-fA-F:]+\]):[^?#\s\\]+$/u.test(value) ? value : null
  try {
    const url = new URL(value)
    if (!url.hostname || url.password || url.search || url.hash) return null
    if (url.protocol === 'https:') return url.username ? null : value
    if (url.protocol === 'ssh:' && url.pathname.length > 1 && (!url.username || /^[A-Za-z0-9._-]+$/.test(url.username))) return value
    return null
  } catch { return null }
}

const PINYIN_INITIAL_BOUNDARIES = ['阿', '八', '嚓', '哒', '妸', '发', '旮', '哈', '讥', '咔', '垃', '妈', '拿', '噢', '妑', '七', '呥', '仨', '他', '哇', '夕', '丫', '帀']
const PINYIN_INITIALS = 'ABCDEFGHJKLMNOPQRSTWXYZ'
const pinyinOrder = new Intl.Collator('zh-u-co-pinyin')
function hanInitial(character: string): string {
  for (let index = PINYIN_INITIAL_BOUNDARIES.length - 1; index >= 0; index--) {
    if (pinyinOrder.compare(character, PINYIN_INITIAL_BOUNDARIES[index]) >= 0) return PINYIN_INITIALS[index] || ''
  }
  return ''
}
export function identifierPadding(): string {
  return [...crypto.getRandomValues(new Uint8Array(3))].map(value => String.fromCharCode(65 + value % 26)).join('')
}
export function suggestProjectIdentifier(name: string, padding: string): string {
  const tokens = name.normalize('NFKD').replace(/\p{M}/gu, '').match(/[a-zA-Z]+|\p{Script=Han}+/gu) || []
  const initials = tokens.map(token => /^[a-zA-Z]/.test(token) ? token[0] : [...token].map(hanInitial).join('')).join('').toUpperCase()
  return (initials.replace(/[^A-Z]/g, '') + padding).slice(0, 3)
}
