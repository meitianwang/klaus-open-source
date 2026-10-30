// Command menu pure-logic tests: the search plan, ranking and
// keyboard-navigation rules live in model.ts / matcher.ts so they can be
// pinned without a DOM.
import { describe, expect, test } from 'bun:test'
import { matchFragments, matchScore } from './matcher'
import {
  CHATS_MAX_RESULTS,
  RECENT_GROUP_LIMIT,
  chatSearchPlan,
  filterCommands,
  flattenRows,
  isImportQuery,
  rankSessions,
  rowSearchScore,
  splitSessionGroups,
  type CommandMenuCommand,
  type CommandMenuSection,
  type CommandMenuSession,
} from './model'

const session = (id: string, title: string, extra: Partial<CommandMenuSession> = {}): CommandMenuSession => ({
  id, title, projectLabel: null, pinned: false, updatedAt: Number(id), ...extra,
})

describe('chatSearchPlan', () => {
  test('root mode needs two characters before searching', () => {
    expect(chatSearchPlan('root', false, '')).toBeNull()
    expect(chatSearchPlan('root', false, 'a')).toBeNull()
    expect(chatSearchPlan('root', false, 'ab')).toEqual({ includeContentResults: false, maxResults: 9 })
    expect(chatSearchPlan('root', false, 'abc')).toEqual({ includeContentResults: true, maxResults: 9 })
  })
  test('chat-search intent searches from the first character', () => {
    expect(chatSearchPlan('root', true, '')).toEqual({ includeContentResults: false, maxResults: CHATS_MAX_RESULTS })
    expect(chatSearchPlan('root', true, 'a')).toEqual({ includeContentResults: true, maxResults: CHATS_MAX_RESULTS })
  })
  test('files mode never plans a chat search', () => {
    expect(chatSearchPlan('files', false, 'anything')).toBeNull()
  })
})

describe('fuzzy matcher', () => {
  test('scores substring and camel-hump matches above zero', () => {
    expect(matchScore('修复 Google 和 GitHub 登录', 'google')).toBeGreaterThan(0)
    expect(matchScore('FixFooBar', 'ffb')).toBeGreaterThan(0)
    expect(matchScore('command menu', 'cm')).toBeGreaterThan(0)
  })
  test('rejects non-matching queries', () => {
    expect(matchScore('修复 Google 和 GitHub 登录', 'zzz')).toBe(0)
    expect(matchScore('abc', 'abcd')).toBe(0)
    expect(matchScore('anything', '')).toBe(0)
  })
  test('fragments cover the matched characters for highlighting', () => {
    const fragments = matchFragments('FixFooBar', 'fb')
    expect(fragments).not.toBeNull()
    const covered = fragments!.map(f => 'FixFooBar'.slice(f.startOffset, f.endOffset)).join('')
    expect(covered.toLowerCase()).toBe('fb')
  })
  test('rowSearchScore takes the best value and treats empty query as match', () => {
    expect(rowSearchScore(['New chat', 'new chat'], '')).toBe(1)
    expect(rowSearchScore(['Open folder', 'open folder'], 'folder')).toBeGreaterThan(0)
    expect(rowSearchScore(['Open folder'], 'zzz')).toBe(0)
  })
})

describe('session ranking', () => {
  const sessions = [
    session('3', '排查本地未推送代码', { pinned: true, updatedAt: 3 }),
    session('1', '修复 Google 和 GitHub 登录', { updatedAt: 9 }),
    session('2', '全面对齐 Electron 客户端工具', { updatedAt: 5 }),
  ]
  test('empty query lists pinned first then recency', () => {
    const ranked = rankSessions(sessions, '', 9)
    expect(ranked.map(r => r.session.id)).toEqual(['3', '1', '2'])
    expect(ranked.every(r => r.fragments === null)).toBe(true)
  })
  test('a query ranks by fuzzy score and drops misses', () => {
    const ranked = rankSessions(sessions, 'google', 9)
    expect(ranked.map(r => r.session.id)).toEqual(['1'])
    expect(ranked[0].fragments).not.toBeNull()
  })
  test('respects the result cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => session(String(i), `chat ${i}`))
    expect(rankSessions(many, '', 9).length).toBe(9)
  })
  test('splitSessionGroups separates pinned from recent', () => {
    const groups = splitSessionGroups(rankSessions(sessions, '', 9))
    expect(groups.pinned.map(r => r.session.id)).toEqual(['3'])
    expect(groups.recent.map(r => r.session.id)).toEqual(['1', '2'])
  })
  test('recent group cap is seven', () => {
    expect(RECENT_GROUP_LIMIT).toBe(7)
  })
})

describe('command filtering', () => {
  const commands: CommandMenuCommand[] = [
    { id: 'newChat', title: '新聊天', keywords: ['new chat'], icon: 'edit', run: () => {} },
    { id: 'openFolder', title: '打开文件夹', keywords: ['open folder'], icon: 'folder-open', run: () => {} },
    { id: 'searchFiles', title: '搜索文件', keywords: ['search files'], icon: 'search', run: () => {} },
  ]
  test('empty query keeps every command', () => {
    expect(filterCommands(commands, '').map(c => c.id)).toEqual(['newChat', 'openFolder', 'searchFiles'])
  })
  test('a query keeps only matches, best first', () => {
    expect(filterCommands(commands, 'folder').map(c => c.id)).toEqual(['openFolder'])
    expect(filterCommands(commands, 'zzz')).toEqual([])
  })
  test('the reserved import query is recognized', () => {
    expect(isImportQuery('import', true)).toBe(true)
    expect(isImportQuery('import', false)).toBe(false)
  })
})
