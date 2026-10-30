import { describe, expect, test } from 'bun:test'
import { createComposerDraft, normalizeComposerDraft, selectedSlashCommandFromDraft } from './slash-draft'

const pushSkill = {
  name: 'push-code',
  displayName: 'Push code',
  kind: 'skill',
  source: 'skills',
}

describe('slash command draft restoration', () => {
  test('keeps an unselected slash query as literal text', () => {
    const draft = normalizeComposerDraft('/push')

    expect(draft).toEqual({ text: '/push', slashCommand: null, references: [] })
    expect(selectedSlashCommandFromDraft(draft)).toBeNull()
  })

  test('does not infer selection even when literal text exactly names a skill', () => {
    const draft = normalizeComposerDraft('/push-code')

    expect(selectedSlashCommandFromDraft(draft)).toBeNull()
  })

  test('restores only an explicitly selected skill with a matching range', () => {
    const draft = createComposerDraft('/push-code release', pushSkill, { start: 0, end: 10 })
    const restored = normalizeComposerDraft(JSON.parse(JSON.stringify(draft)))

    expect(restored.slashCommand).toEqual({
      command: pushSkill,
      range: { start: 0, end: 10 },
    })
  })

  test('drops stale selection metadata instead of selecting different text', () => {
    const draft = normalizeComposerDraft({
      text: '/push release',
      slashCommand: { command: pushSkill, range: { start: 0, end: 5 } },
    })

    expect(draft).toEqual({ text: '/push release', slashCommand: null, references: [] })
  })

  test('restores configured agent references from legacy string drafts', () => {
    expect(normalizeComposerDraft('@agent-Explore inspect this')).toEqual({
      text: '@agent-Explore inspect this',
      slashCommand: null,
      references: [{
        kind: 'agent',
        name: 'Explore',
        value: '@agent-Explore',
        range: { start: 0, end: 14 },
        source: 'configured',
      }],
    })
  })

  test('persists a selected command and an agent reference in the same draft', () => {
    const reference = {
      kind: 'agent' as const,
      name: 'Explore',
      value: '@agent-Explore',
      range: { start: 11, end: 25 },
      source: 'configured' as const,
    }
    const draft = createComposerDraft('/push-code @agent-Explore inspect', pushSkill, { start: 0, end: 10 }, [reference])

    expect(normalizeComposerDraft(JSON.parse(JSON.stringify(draft)))).toEqual({
      text: '/push-code @agent-Explore inspect',
      slashCommand: { command: pushSkill, range: { start: 0, end: 10 } },
      references: [reference],
    })
  })
})
