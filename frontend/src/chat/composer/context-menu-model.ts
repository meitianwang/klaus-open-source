import type { MentionEntry } from './slash-menu'
import type { MentionSection } from './mention-sections'

export const CONTEXT_RESULT_LIMIT = 8

export function contextCommandQueryKey(scope: string, sessionId: string | null, root?: string): readonly unknown[] {
  return ['composer-context-commands', scope, sessionId, root]
}

/** Rank the complete source lists before applying the visible result limit. */
function matchScore(entry: MentionEntry, query: string): number {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return 1
  const values = [entry.name, ...(entry.aliases || []), entry.rel].filter(Boolean).map(value => value.toLocaleLowerCase())
  let score = 0
  for (const value of values) {
    if (value === needle) score = Math.max(score, 100)
    else if (value.startsWith(needle)) score = Math.max(score, 80)
    else if (value.includes(needle)) score = Math.max(score, 60)
    else {
      let index = 0
      for (const character of value) if (character === needle[index]) index++
      if (index === needle.length) score = Math.max(score, 20)
    }
  }
  return score
}

function sourcePriority(section: string, entry: MentionEntry, query: string): number {
  const prefix = [entry.name, ...(entry.aliases || [])].some(value => value.toLocaleLowerCase().startsWith(query))
  if (prefix && section === 'plugins') return 0
  if (prefix && section === 'apps') return 1
  if (entry.kind === 'action') return 2
  if (['files', 'conversations', 'browser-tabs'].includes(section)) return 3
  return 2
}

/** Empty queries retain source headings; searches become one ranked result list. */
export function contextMenuSections(sections: MentionSection[], query: string): MentionSection[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return sections.map(section => {
    const limit = section.key === 'conversations' || section.key === 'files' ? 0
      : section.key === 'skills' ? 2 : section.key === 'apps' ? 3 : section.key === 'agents' ? 5 : section.key === 'sites' ? 2 : undefined
    return { ...section, rows: limit === undefined ? section.rows : section.rows.slice(0, limit) }
  })
  const candidates: Array<{ entry: MentionEntry; score: number; priority: number }> = []
  for (const section of sections) for (const entry of section.rows) {
    const score = matchScore(entry, needle)
    if (score <= 0) continue
    const priority = sourcePriority(section.key, entry, needle)
    const index = candidates.findIndex(candidate => priority < candidate.priority || (priority === candidate.priority && score > candidate.score))
    if (index < 0) {
      if (candidates.length < CONTEXT_RESULT_LIMIT) candidates.push({ entry, score, priority })
    } else {
      candidates.splice(index, 0, { entry, score, priority })
      if (candidates.length > CONTEXT_RESULT_LIMIT) candidates.pop()
    }
  }
  const rows = candidates.map(candidate => candidate.entry)
  const pending = sections.find(section => section.state?.kind === 'loading')
  const failed = sections.find(section => section.state?.kind === 'error')
  return [{ key: 'search-results', labelKey: null, rows,
    ...(!rows.length && (pending || failed) ? { state: (pending || failed)!.state } : {}),
  }]
}

export interface SyntheticContextQuery {
  before: string
  after: string
  original: string
  start: number
  owner: string
}

/** A button activation owns a selection without inserting a visible trigger. */
export function syntheticContextQuery(text: string, start: number, end: number, owner: string): SyntheticContextQuery {
  return { before: text.slice(0, start), after: text.slice(end), original: text.slice(start, end), start, owner }
}

export function resolveSyntheticContextQuery(activation: SyntheticContextQuery, text: string, start: number, end: number, owner: string): { start: number; end: number; query: string } | null {
  if (activation.owner !== owner || !text.startsWith(activation.before) || !text.endsWith(activation.after)) return null
  const to = text.length - activation.after.length
  if (to < activation.start) return null
  const value = text.slice(activation.start, to)
  if (value.includes('\n') || value.includes('\uFFFC')) return null
  const unchanged = value === activation.original && start === activation.start && end === to
  if (!unchanged && (start !== end || end !== to)) return null
  return { start: activation.start, end: unchanged ? activation.start : to, query: unchanged ? '' : value }
}
