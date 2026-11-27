import { describe, expect, test } from 'bun:test'
import {
  deriveMaximizedComposerPillState,
  extractReplyPreviewLine,
  isMaximizedComposerEligible,
  truncateSingleLine,
} from './maximized-composer'

const dict: Record<string, string> = {
  maximized_composer_placeholder: 'Message Klaus…',
  maximized_composer_draft: 'Draft',
  maximized_composer_needs_approval: 'Needs your approval',
  maximized_composer_has_question: 'Klaus has a question',
  maximized_composer_reply_ready: 'Reply ready',
  maximized_composer_reply_with_preview: 'Reply ready · {preview}',
  maximized_composer_view_reply: 'View reply',
  maximized_composer_review: 'Review',
  maximized_composer_stop: 'Stop',
  voice_chat_thinking: 'Thinking…',
}

const t = (key: string) => dict[key] || key
const tCount = (_key: string, count: number) => (count === 1 ? '1 file' : `${count} files`)

describe('isMaximizedComposerEligible', () => {
  test('allows open maximized work panel in active non-archived chat', () => {
    expect(
      isMaximizedComposerEligible({
        panelMaximized: true,
        panelOpen: true,
        panelMode: 'workspace',
        inChatSurface: true,
        archivedSession: false,
      }),
    ).toBe(true)
  })

  test('excludes unmaximized, collapsed, side-chat, non-chat views, and archived sessions', () => {
    const base = {
      panelMaximized: true,
      panelOpen: true,
      panelMode: 'diff',
      inChatSurface: true,
      archivedSession: false,
    }
    expect(isMaximizedComposerEligible({ ...base, panelMaximized: false })).toBe(false)
    expect(isMaximizedComposerEligible({ ...base, panelOpen: false })).toBe(false)
    expect(isMaximizedComposerEligible({ ...base, panelMode: 'side-chat' })).toBe(false)
    expect(isMaximizedComposerEligible({ ...base, inChatSurface: false })).toBe(false)
    expect(isMaximizedComposerEligible({ ...base, archivedSession: true })).toBe(false)
  })
})

describe('deriveMaximizedComposerPillState', () => {
  const base = {
    waitCount: 0,
    waitKind: 'approval' as const,
    unreadReply: null,
    running: false,
    runningLabel: null,
    draftText: '',
    attachmentCount: 0,
    t,
    tCount,
  }

  test('orders state priority as attention > unread > running > draft > idle', () => {
    expect(deriveMaximizedComposerPillState(base)).toEqual({
      kind: 'idle',
      leading: 'chat',
      text: 'Message Klaus…',
      trailingAction: null,
      trailingLabel: '',
    })

    const draftState = deriveMaximizedComposerPillState({
      ...base,
      draftText: '  fix the login   redirect\nissue  ',
      attachmentCount: 2,
    })
    expect(draftState).toEqual({
      kind: 'draft',
      leading: 'pencil',
      text: 'Draft · fix the login redirect issue · 2 files',
      trailingAction: null,
      trailingLabel: '',
    })

    const runningState = deriveMaximizedComposerPillState({
      ...base,
      draftText: 'still queued',
      running: true,
      runningLabel: 'Running command · +1 more',
    })
    expect(runningState).toEqual({
      kind: 'running',
      leading: 'spinner',
      text: 'Running command · +1 more',
      trailingAction: 'stop',
      trailingLabel: 'Stop',
    })

    const unreadState = deriveMaximizedComposerPillState({
      ...base,
      draftText: 'next question',
      running: true,
      unreadReply: { sessionId: 's1', preview: 'All tests passed.' },
    })
    expect(unreadState).toEqual({
      kind: 'unread',
      leading: 'info-dot',
      text: 'Reply ready · All tests passed.',
      trailingAction: 'view-reply',
      trailingLabel: 'View reply',
    })

    const approvalState = deriveMaximizedComposerPillState({
      ...base,
      waitCount: 1,
      waitKind: 'approval',
      unreadReply: { sessionId: 's1', preview: 'All tests passed.' },
      running: true,
    })
    expect(approvalState).toEqual({
      kind: 'attention',
      leading: 'warning-dot',
      text: 'Needs your approval',
      trailingAction: 'review',
      trailingLabel: 'Review',
    })

    const questionState = deriveMaximizedComposerPillState({
      ...base,
      waitCount: 1,
      waitKind: 'input',
    })
    expect(questionState).toEqual({
      kind: 'attention',
      leading: 'warning-dot',
      text: 'Klaus has a question',
      trailingAction: null,
      trailingLabel: '',
    })
  })
})

describe('preview helpers', () => {
  test('extracts clean first content line and strips markdown chrome', () => {
    expect(extractReplyPreviewLine('\n\n## Summary\n- Updated **pty.rs** and `reaper.rs`\n')).toBe('Summary')
    expect(extractReplyPreviewLine('```ts\nconst x = 1\n```\n- Fixed `reaper.rs` cleanup')).toBe('Fixed reaper.rs cleanup')
    expect(extractReplyPreviewLine('::klaus-inline-vis{path="/tmp/x.html"}\nDone.')).toBe('Done.')
    expect(truncateSingleLine('a'.repeat(70), 10)).toBe('aaaaaaaaa…')
  })
})
