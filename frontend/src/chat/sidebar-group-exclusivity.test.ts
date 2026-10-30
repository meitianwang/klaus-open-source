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

describe('a conversation lists in exactly one sidebar group', () => {
  test('the workspace container skips friend task conversations', () => {
    // A friend task approval may choose a workspace as the execution location,
    // which persists a workspace binding on the conversation. The friendship
    // owns the conversation in the sidebar, so the workspace container must not
    // list it a second time.
    const source = functionBody('function workspaceConversationSessions(', '\n\n// ==================== friend groups')
    expect(source).toContain('!session.friendGroupId')
  })

  test('the single-project group skips friend task conversations', () => {
    const source = functionBody('function sessionProjectKey(', '\n\nasync function revealWorktreeFromMenu')
    expect(source).toContain('session.friendGroupId')
  })

  test('the project-less recents skip friend task conversations', () => {
    const source = functionBody('function projectlessConversationSessions(', '\n\nfunction projectConversationSessions(')
    expect(source).toContain('!session.friendGroupId')
  })
})
