// Command menu model: the pure logic behind the global search panel.
// Kept DOM-free so it can be unit-tested under `bun test`.
//
// State machine:
//   - mode `root` without chat-search intent (⌘K): unified placeholder; empty
//     query lists a "Recent chats" group (max 7, no shortcut badges), the
//     "Quick actions" group and every command that matches the query;
//   - mode `root` WITH chat-search intent (header search button / the
//     "Search chats…" row): the chat
//     placeholder, a "Chats" group whose empty-query fallback is pinned then
//     recent chats and whose rows carry ⌘1..⌘9 badges, plus "Quick actions";
//   - mode `files` (the "Search files" quick action): engine FileIndex results.

import { matchScore, matchFragments, type MatchFragment } from './matcher'

export type CommandMenuMode = 'root' | 'files'

export interface CommandMenuSession {
  id: string
  title: string
  /** Right-hand description: project / workspace name (e.g. "klaus"). */
  projectLabel: string | null
  pinned: boolean
  updatedAt: number
}

export interface CommandMenuCommand {
  id: string
  title: string
  /** Extra search keywords matched alongside the command title. */
  keywords?: string[]
  icon: string
  run(): void
}

export interface FileSearchResult {
  path: string
  name: string
}

/** When a query is long enough to search, and whether to include content results. */
export interface ChatSearchPlan {
  includeContentResults: boolean
  maxResults: number
}

export const ROOT_MIN_QUERY_LENGTH = 2
export const ROOT_CONTENT_QUERY_LENGTH = 3
export const ROOT_MAX_RESULTS = 9
export const CHATS_MAX_RESULTS = 9
/** The recent-chats group in plain root mode caps at seven rows. */
export const RECENT_GROUP_LIMIT = 7

export function chatSearchPlan(mode: CommandMenuMode, chatSearchIntent: boolean, query: string): ChatSearchPlan | null {
  if (mode === 'files') return null
  const trimmed = query.trim()
  if (chatSearchIntent) {
    return { includeContentResults: trimmed.length > 0, maxResults: CHATS_MAX_RESULTS }
  }
  return trimmed.length < ROOT_MIN_QUERY_LENGTH
    ? null
    : { includeContentResults: trimmed.length >= ROOT_CONTENT_QUERY_LENGTH, maxResults: ROOT_MAX_RESULTS }
}

/** The reserved "import" query that suppresses command matching. */
export function isImportQuery(query: string, importActive: boolean): boolean {
  return importActive && query.trim().toLowerCase() === 'import'
}

/** Best fuzzy score across a row's searchable values; 0 = no match. */
export function rowSearchScore(values: string[], query: string): number {
  const trimmed = query.trim()
  if (trimmed.length === 0) return 1
  let best = matchScore(values[0] ?? '', trimmed)
  for (const extra of values.slice(1)) best = Math.max(best, matchScore(extra, trimmed))
  return best
}

export interface RankedSession {
  session: CommandMenuSession
  score: number
  fragments: MatchFragment[] | null
}

/**
 * Chat results for the current query. An empty query falls back to
 * pinned-then-recent ordering; a query ranks by fuzzy title score and
 * breaks ties by recency, capped at the search plan's maxResults.
 */
export function rankSessions(sessions: CommandMenuSession[], query: string, limit: number): RankedSession[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    const pinned = sessions.filter(s => s.pinned).sort((a, b) => b.updatedAt - a.updatedAt)
    const rest = sessions.filter(s => !s.pinned).sort((a, b) => b.updatedAt - a.updatedAt)
    return [...pinned, ...rest].slice(0, limit).map(session => ({ session, score: 0, fragments: null }))
  }
  const ranked: RankedSession[] = []
  for (const session of sessions) {
    const score = matchScore(session.title, trimmed)
    if (score > 0) ranked.push({ session, score, fragments: matchFragments(session.title, trimmed) })
  }
  ranked.sort((a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt)
  return ranked.slice(0, limit)
}

/** Pinned group first, then recents, for the empty-query chat list. */
export function splitSessionGroups(results: RankedSession[]): { pinned: RankedSession[]; recent: RankedSession[] } {
  return {
    pinned: results.filter(r => r.session.pinned),
    recent: results.filter(r => !r.session.pinned),
  }
}

export function filterCommands(commands: CommandMenuCommand[], query: string): CommandMenuCommand[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) return commands
  return commands
    .map(command => ({ command, score: rowSearchScore([command.title, ...(command.keywords ?? [])], trimmed) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.command)
}

/** Quick actions shown under the "Quick actions" heading on an empty query. */
export const QUICK_ACTION_IDS = ['newChat', 'openFolder', 'searchFiles']

/** A flat, keyboard-navigable row list: section headers are not rows. */
export type CommandMenuRow =
  | { kind: 'session'; session: CommandMenuSession; fragments: MatchFragment[] | null }
  | { kind: 'command'; command: CommandMenuCommand }
  | { kind: 'file'; file: FileSearchResult }

export interface CommandMenuSection {
  key: string
  label: string | null
  loading?: boolean
  rows: CommandMenuRow[]
}

export function flattenRows(sections: CommandMenuSection[]): CommandMenuRow[] {
  return sections.flatMap(section => section.rows)
}

