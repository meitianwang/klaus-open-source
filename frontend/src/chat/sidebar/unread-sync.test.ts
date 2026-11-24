import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSidebarUnreadSessions, serializeSidebarUnreadSessions, SIDEBAR_UNREAD_SESSIONS_KEY } from '../../../../shared/sidebar-preferences'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('sidebar unread session persistence', () => {
  test('parses, trims, deduplicates, and rejects malformed session identifiers', () => {
    expect(SIDEBAR_UNREAD_SESSIONS_KEY).toBe('sidebar.unread_sessions')
    for (const malformed of [null, '', '{broken', '{"not":"array"}']) expect(parseSidebarUnreadSessions(malformed)).toEqual([])
    expect(parseSidebarUnreadSessions('[" s1 ", "s2", "s1", "", "bad\\u0000id", 42]')).toEqual(['s1', 's2'])
    expect(parseSidebarUnreadSessions(['x'.repeat(513), 'valid'])).toEqual(['valid'])
  })

  test('serializes canonical deduplicated JSON arrays', () => {
    expect(serializeSidebarUnreadSessions(['s2', ' s1 ', 's2', ''])).toBe('["s2","s1"]')
  })

  test('chat renderer wires shared unread storage through CollapseWriteQueue and cross-surface listeners', () => {
    const chat = readFileSync(join(desktopRoot, 'frontend/src/chat/chat.ts'), 'utf8')
    expect(chat).toContain('unreadSessionsQueue = createCollapseWriteQueue(SIDEBAR_UNREAD_SESSIONS_KEY, SIDEBAR_COMPLETED_MIRROR_KEY)')
    expect(chat).toContain('hydrateSidebarUnreadSessions()')
    expect(chat).toContain('applyRemoteSidebarUnreadChange()')
    expect(chat).toContain("window.addEventListener('focus', settleOpenUnreadSession)")
    expect(readFileSync(join(desktopRoot, 'main/sessions/configuration.ts'), 'utf8')).toContain('SIDEBAR_UNREAD_SESSIONS_KEY')
  })
})
