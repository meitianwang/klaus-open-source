import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')

function functionBody(startMarker: string, endMarker: string) {
  const start = CHAT_TS.indexOf(startMarker)
  const end = CHAT_TS.indexOf(endMarker, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return CHAT_TS.slice(start, end)
}

describe('global search reaches folded conversations', () => {
  test('the search session source enumerates every partition, not the rendered sidebar rows', () => {
    const source = functionBody('function commandMenuVisibleSessions()', '\nfunction commandMenuProjectLabel(')
    // The rendered snapshot only carries rows of expanded sections and of the
    // current pagination window; reading it is what hid folded conversations
    // from search.
    expect(source).not.toContain('buildSidebarSnapshot')
    expect(source).not.toContain('.collapsed')
    expect(source).not.toContain('threads?.rows')
    // Full coverage: every sidebar partition contributes its whole session
    // list, in sidebar section order.
    expect(source).toContain('partitionSidebarSessions(sessions')
    expect(source).toContain('partitions.pinned')
    expect(source).toContain('partitions.channels')
    expect(source).toContain('workspaceConversationSessions(workspace.id)')
    expect(source).toContain('friendConversationSessions(friend.id)')
    expect(source).toContain('projectConversationSessions(project.workdir)')
    expect(source).toContain('projectlessConversationSessions()')
  })

  test('the search path never runs the sidebar row builders that consume open-animation flags', () => {
    const source = functionBody('function commandMenuVisibleSessions()', '\nfunction commandMenuProjectLabel(')
    expect(source).not.toContain('workspaceRowsForSidebar()')
  })

  test('the command menu data surface is fed by the full-list source', () => {
    const surface = functionBody(';(window as any).klausCommandMenu = {', '\n// Keybinding command actions')
    expect(surface).toContain('commandMenuVisibleSessions()')
  })
})
