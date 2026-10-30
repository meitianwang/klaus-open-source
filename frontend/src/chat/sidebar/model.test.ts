import { describe, expect, test } from 'bun:test'
import type { SessionInfo } from '../engine-events'
import { automationSourceLabel, isPinnedSession, mergeSidebarSessionSnapshot, partitionSidebarSessions, preserveVisibleSessionTitle, sessionTitleForCurrentSession, shouldDiscardEmptySessionOnLeave } from './model'

function session(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, title: id, updatedAt: 1, ...extra }
}

describe('sidebar session model', () => {
  test('partitions pinned, channels, and ordinary sessions without duplicates', () => {
    const rows = [
      session('local'),
      session('channel:feishu', { sidebarPinnedAt: 10 }),
      session('channel:dingtalk'),
      session('automation', {
        threadSource: 'automation',
        automation: { taskId: 'daily', taskName: 'Daily report' },
      }),
      session('pinned-new', { sidebarPinnedAt: 30 }),
      session('pinned-project', { sidebarPinnedAt: 20, workdir: '/repo/project' }),
      session('pinned-workspace', { sidebarPinnedAt: 15, workdir: '/repo/root', workspaceId: 'workspace-1' }),
      session('project', { workdir: '/repo/project' }),
      session('workspace', { workdir: '/repo/root', workspaceId: 'workspace-1' }),
    ]

    const result = partitionSidebarSessions(rows, id => id.startsWith('channel:'))

    expect(result.pinned.map(row => row.id)).toEqual([
      'pinned-new',
      'pinned-project',
      'pinned-workspace',
      'channel:feishu',
    ])
    expect(result.channels.map(row => row.id)).toEqual(['channel:dingtalk'])
    expect(result.local.map(row => row.id)).toEqual(['local', 'automation', 'project', 'workspace'])
    expect(new Set([...result.pinned, ...result.channels, ...result.local].map(row => row.id)).size).toBe(rows.length)
  })

  test('treats automation execution as an ordinary task with a source label', () => {
    const execution = session('run', {
      threadSource: 'automation',
      automation: { taskId: 'daily', taskName: 'Daily report', runId: 7 },
    })
    expect(automationSourceLabel(execution, 'Scheduled')).toBe('Scheduled · Daily report')
    expect(automationSourceLabel(session('chat'), 'Scheduled')).toBeNull()
  })

  test('accepts only positive finite pin timestamps', () => {
    expect(isPinnedSession(session('valid', { sidebarPinnedAt: 1 }))).toBe(true)
    expect(isPinnedSession(session('zero', { sidebarPinnedAt: 0 }))).toBe(false)
    expect(isPinnedSession(session('missing'))).toBe(false)
  })

  test('runtime snapshots update row state without reordering on rollout writes', () => {
    const current = [
      session('newer', { updatedAt: 200, isWorking: false }),
      session('older-running', { updatedAt: 100, isWorking: true }),
    ]
    const incoming = [
      session('older-running', { updatedAt: 300, isWorking: true }),
      session('newer', { updatedAt: 200, isWorking: false }),
    ]

    const merged = mergeSidebarSessionSnapshot(current, incoming)

    expect(merged.map(row => row.id)).toEqual(['newer', 'older-running'])
    expect(merged.map(row => row.updatedAt)).toEqual([200, 100])
    expect(merged[1].isWorking).toBe(true)
  })

  test('a completed task adopts the latest time order', () => {
    const current = [session('newer', { updatedAt: 200 }), session('older', { updatedAt: 100 })]
    const incoming = [session('older', { updatedAt: 350 }), session('newer', { updatedAt: 200 })]

    const promoted = mergeSidebarSessionSnapshot(current, incoming, true)

    expect(promoted.map(row => row.id)).toEqual(['older', 'newer'])
    expect(promoted[0].updatedAt).toBe(350)
  })

  test('derives the title from the current session identity, not a stale rendered row', () => {
    const previous = session('previous', { title: 'Previous session title' })
    const current = session('current', { title: 'Current session title' })

    expect(sessionTitleForCurrentSession('current', previous)).toBe('')
    expect(sessionTitleForCurrentSession('current', current)).toBe('Current session title')
    expect(sessionTitleForCurrentSession('current', session('current', { title: 'New Chat' }))).toBe('')
    expect(sessionTitleForCurrentSession('current', session('current', { title: 'Chat' }))).toBe('')
    expect(sessionTitleForCurrentSession('branch', session('branch', {
      title: 'Current session title · Branch',
      forkedFrom: { sessionId: 'parent-session', threadId: 'parent-thread', title: 'Parent session' },
    }))).toBe('Current session title')
  })

  test('discards only proven-empty placeholder sessions when leaving', () => {
    const empty = {
      draftOnly: false,
      history: [] as unknown[],
      hasContent: false,
      hasDraft: false,
      hasPendingFiles: false,
      isChannel: false,
    }

    expect(shouldDiscardEmptySessionOnLeave(session('ghost', { title: 'Chat' }), empty)).toBe(true)
    expect(shouldDiscardEmptySessionOnLeave(session('draft', { title: 'New Chat' }), {
      ...empty,
      draftOnly: true,
      history: null,
    })).toBe(true)
    expect(shouldDiscardEmptySessionOnLeave(session('loading', { title: 'Chat' }), {
      ...empty,
      history: null,
    })).toBe(false)
    expect(shouldDiscardEmptySessionOnLeave(session('real', { title: 'Chat' }), {
      ...empty,
      history: [{ role: 'user', text: 'message' }],
      hasContent: true,
    })).toBe(false)
    expect(shouldDiscardEmptySessionOnLeave(session('stale-draft-flag', { title: 'Chat' }), {
      ...empty,
      draftOnly: true,
      history: [{ role: 'user', text: 'message' }],
    })).toBe(false)
    expect(shouldDiscardEmptySessionOnLeave(session('named-empty', { title: 'Kept intentionally' }), empty)).toBe(false)
    expect(shouldDiscardEmptySessionOnLeave(session('channel', { title: 'Chat' }), {
      ...empty,
      isChannel: true,
    })).toBe(false)
  })

  test('keeps a visible title when a list snapshot still carries a placeholder', () => {
    const current = session('live', { title: 'Fix the title flicker' })
    const incoming = session('live', { title: 'New Chat' })

    expect(preserveVisibleSessionTitle(current, incoming).title).toBe('Fix the title flicker')
  })

  test('accepts a newer real title and keeps a placeholder when both are placeholders', () => {
    const seeded = session('live', { title: 'Fix the title flicker' })
    const generated = session('live', { title: 'Fix title flicker' })

    expect(preserveVisibleSessionTitle(seeded, generated).title).toBe('Fix title flicker')
    expect(preserveVisibleSessionTitle(session('draft', { title: 'Chat' }), session('draft', { title: 'New Chat' })).title).toBe('New Chat')
  })
})

test('an admitted turn protects a placeholder session from empty-shell recycling', () => {
  const empty = {
    draftOnly: true,
    history: [] as unknown[],
    hasContent: false,
    hasDraft: false,
    hasPendingFiles: false,
    isChannel: false,
  }
  expect(shouldDiscardEmptySessionOnLeave(session('admitted', { title: 'Chat' }), empty)).toBe(true)
  expect(shouldDiscardEmptySessionOnLeave(session('admitted', { title: 'Chat' }), { ...empty, hasSubmittedTurn: true })).toBe(false)
})
