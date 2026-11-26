import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_SESSION_TITLE_LENGTH,
  cancelInlineRename,
  getActiveInlineRename,
  isImeComposingKeyEvent,
  resetInlineRenameForTests,
  settleInlineRenameValue,
  startInlineRename,
} from './inline-rename'

describe('inline session rename state and contracts', () => {
  afterEach(() => {
    resetInlineRenameForTests()
  })

  test('tracks a single active inline rename and commits only trimmed changed values', () => {
    const commits: Array<{ id: string; title: string }> = []
    let restored = 0
    const active = startInlineRename({
      sessionId: 's-1',
      surface: 'sidebar',
      rowKey: 'pinned:s-1',
      initialValue: 'Original title',
      placeholder: 'New chat',
      ariaLabel: 'Conversation name',
      onCommit: (id, title) => commits.push({ id, title }),
      restoreFocus: () => { restored += 1 },
    })
    expect(getActiveInlineRename()?.id).toBe(active.id)
    expect(MAX_SESSION_TITLE_LENGTH).toBe(200)

    // Whitespace-only draft silently reverts without committing.
    settleInlineRenameValue(active, '   ', { restoreFocus: true })
    expect(commits).toEqual([])
    expect(getActiveInlineRename()).toBeNull()

    // Unchanged draft silently reverts without committing.
    const unchanged = startInlineRename({
      sessionId: 's-1',
      surface: 'sidebar',
      rowKey: 'pinned:s-1',
      initialValue: 'Original title',
      placeholder: 'New chat',
      ariaLabel: 'Conversation name',
      onCommit: (id, title) => commits.push({ id, title }),
    })
    settleInlineRenameValue(unchanged, '  Original title  ', { restoreFocus: false })
    expect(commits).toEqual([])

    // Escape cancels even when draft changed.
    const cancelled = startInlineRename({
      sessionId: 's-1',
      surface: 'titlebar',
      rowKey: null,
      initialValue: 'Original title',
      placeholder: 'New chat',
      ariaLabel: 'Conversation name',
      onCommit: (id, title) => commits.push({ id, title }),
    })
    settleInlineRenameValue(cancelled, 'Discarded draft', { restoreFocus: true, cancelled: true })
    expect(commits).toEqual([])

    // Non-empty changed draft trims and commits once.
    const changed = startInlineRename({
      sessionId: 's-1',
      surface: 'titlebar',
      rowKey: null,
      initialValue: 'Original title',
      placeholder: 'New chat',
      ariaLabel: 'Conversation name',
      onCommit: (id, title) => commits.push({ id, title }),
    })
    settleInlineRenameValue(changed, '  Updated title  ', { restoreFocus: false })
    expect(commits).toEqual([{ id: 's-1', title: 'Updated title' }])
    // Duplicate settlement (e.g. Enter followed by unmount blur) is a no-op.
    settleInlineRenameValue(changed, 'Another title', { restoreFocus: false })
    expect(commits).toEqual([{ id: 's-1', title: 'Updated title' }])
    expect(restored).toBeGreaterThanOrEqual(0)
  })

  test('detects CJK IME composition events across synthetic and native shapes', () => {
    expect(isImeComposingKeyEvent({ isComposing: true, keyCode: 13 })).toBe(true)
    expect(isImeComposingKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true)
    expect(isImeComposingKeyEvent({ nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true)
    expect(isImeComposingKeyEvent({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true)
    expect(isImeComposingKeyEvent({ isComposing: false, keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false)
  })

  test('cancelInlineRename clears active state cleanly', () => {
    startInlineRename({
      sessionId: 's-2',
      surface: 'sidebar',
      rowKey: 'session:s-2',
      initialValue: '',
      placeholder: 'New chat',
      ariaLabel: 'Conversation name',
      onCommit: () => {},
    })
    expect(getActiveInlineRename()?.sessionId).toBe('s-2')
    cancelInlineRename()
    expect(getActiveInlineRename()).toBeNull()
  })

  test('chat rename flow avoids modal prompt/alert dialogs and titlebar hover tooltips', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const chatSrc = readFileSync(resolve(here, '../chat.ts'), 'utf8')
    expect(chatSrc).not.toContain('function renameSessionFromMenu')
    expect(chatSrc).not.toContain('titlebarSessionTitleEl.title =')

    const commitBlock = chatSrc.slice(
      chatSrc.indexOf('async function commitSessionRename'),
      chatSrc.indexOf('function startSidebarSessionRename'),
    )
    expect(commitBlock).toContain('applySessionTitleUpdate(id, title)')
    expect(commitBlock).toContain("showToast(formatRenameSessionError(err), { tone: 'danger' })")
    expect(commitBlock).not.toContain('klausDialog')
    expect(commitBlock).not.toContain("tt('settings_saved')")
  })
})
