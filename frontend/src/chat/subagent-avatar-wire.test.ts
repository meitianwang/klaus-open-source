import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUBAGENT_AVATAR_VARIANTS, subagentAvatarHtml } from './subagent-avatar'

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

  test('uses static images without a runtime renderer or animation', () => {
    expect(STYLES).toContain('.subagent-avatar-image {')
    expect(STYLES).not.toContain('subagent-avatar-canvas')
    expect(STYLES).not.toContain('subagent-avatar-glint')
    expect(STYLES).not.toContain('data-orb-renderer')
    const running = subagentAvatarHtml(3, 20, 'running')
    expect(running).toBe(subagentAvatarHtml(3, 20, 'completed'))
    expect(running).toContain('<img class="subagent-avatar-image"')
    expect(running).not.toMatch(/<canvas|<script|data-orb-renderer/)
  })

  test('ships lightweight orb assets and keeps full identities when artwork repeats', () => {
    for (let variant = 0; variant < SUBAGENT_AVATAR_VARIANTS; variant++) {
      const path = fileURLToPath(new URL(`../../public/subagent-avatars/orb-${variant}.webp`, import.meta.url))
      const bytes = statSync(path).size
      expect(bytes).toBeGreaterThan(500)
      expect(bytes).toBeLessThan(10_000)
    }
    const repeated = subagentAvatarHtml(SUBAGENT_AVATAR_VARIANTS, 20)
    expect(repeated).toContain('orb-0.webp')
    expect(repeated).toContain(`data-avatar-id="${SUBAGENT_AVATAR_VARIANTS}"`)
  })
})
