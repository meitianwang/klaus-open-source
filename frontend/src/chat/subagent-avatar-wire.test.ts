import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUBAGENT_AVATAR_HUES, subagentAvatarHtml, subagentAvatarPattern } from './subagent-avatar'

const read = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
const CHAT = read('./chat.ts')
const OVERVIEW = read('./overview/subagents.ts')
const TRANSCRIPT = read('./transcript/TranscriptView.tsx')
const STYLES = read('../../css/styles.css')

describe('geometric subagent avatar wiring', () => {
  test('preserves and persists the allocated identity when engine snapshots replace tasks', () => {
    const mergeStart = CHAT.indexOf('function mergeAgentTasks(')
    const mergeEnd = CHAT.indexOf('\nfunction scheduleAgentTasksSave(', mergeStart)
    expect(mergeStart).toBeGreaterThan(-1)
    expect(mergeEnd).toBeGreaterThan(mergeStart)
    const merge = CHAT.slice(mergeStart, mergeEnd)

    expect(merge).toContain('preserveSubagentAvatarId(prev, merged)')
    expect(merge).toContain('normalizeSubagentAvatarIds(existing)')
    expect(merge).toContain('scheduleAgentTasksSave(sessionId)')
    // A tasks_changed burst from the task-call accumulator never carries the
    // resolved model, so the merge must keep the one reconcile already learned.
    expect(merge).toContain("if (typeof prev?.model === 'string' && prev.model && !merged.model)")
  })

  test('uses the same persisted identity in overview, transcript, and detail surfaces', () => {
    expect(OVERVIEW).toContain('subagentAvatarHtml(task.avatarId, 20, status, conversationId)')
    expect(TRANSCRIPT).toContain('avatarId={row.task?.avatarId}')
    expect(TRANSCRIPT).toContain('subagentAvatarHtml(avatarId, 16, status, conversationId)')
    expect(CHAT).toContain('subagentAvatarHtml(task.avatarId, 24, status, subagentConversationId(taskId, task))')
  })

  test('colours the mark from theme variables without decorative animation', () => {
    expect(STYLES).toContain('[data-theme="dark"] .subagent-avatar {')
    expect(STYLES).toContain('.subagent-avatar .subagent-avatar-mark { fill: var(--subagent-avatar-ink); }')
    for (let hue = 0; hue < SUBAGENT_AVATAR_HUES; hue++) expect(STYLES).toContain(`.subagent-avatar[data-avatar-hue="${hue}"]`)
    expect(STYLES).not.toContain('subagent-orb')
  })

  test('draws a self-contained mirrored mark for every identity, including large ids', () => {
    for (const id of [0, 1, 27, 28, 4096, 1_000_000_123]) {
      const html = subagentAvatarHtml(id, 20)
      expect(html).toContain('<svg viewBox="0 0 16 16"')
      expect(html).toContain(`data-avatar-id="${id}"`)
      expect(html).not.toMatch(/<img|<script|<foreignObject|(?:href|src)=/)
      const { cells, hue } = subagentAvatarPattern(id)
      expect(cells.length).toBeGreaterThan(0)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(SUBAGENT_AVATAR_HUES)
      for (const [column, row] of cells) expect(cells).toContainEqual([3 - column, row])
    }
    expect(subagentAvatarHtml(28, 20)).not.toBe(subagentAvatarHtml(0, 20))
  })
})
