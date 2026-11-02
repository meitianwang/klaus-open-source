import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { slashCommandDisplayLabel, slashRowLabels } from './slash-row-labels'

describe('slashRowLabels', () => {
  test('a slug without a localized name stays the only token', () => {
    expect(slashRowLabels('a1', 'a1')).toEqual({ token: 'a1', slug: '' })
    expect(slashRowLabels('a1', '')).toEqual({ token: 'a1', slug: '' })
  })

  test('a localized name leads and the slug rides as secondary', () => {
    expect(slashRowLabels('digram', '图表')).toEqual({ token: '图表', slug: 'digram' })
    expect(slashRowLabels('plan', '计划模式')).toEqual({ token: '计划模式', slug: 'plan' })
  })

  test('a blank display name falls back to the slug without a secondary', () => {
    expect(slashRowLabels('digram', '   ')).toEqual({ token: 'digram', slug: '' })
  })
})

describe('slashCommandDisplayLabel', () => {
  test('prefers the shared i18n hook, then displayName, then the raw name', () => {
    const previousWindow = (globalThis as any).window
    try {
      ;(globalThis as any).window = {
        klausSlashCommandI18n: { displayName: (command: any) => (command?.name === 'plan' ? '计划模式' : '') },
      }
      expect(slashCommandDisplayLabel({ name: 'plan' })).toBe('计划模式')
      expect(slashCommandDisplayLabel({ name: 'goal', displayName: '目标模式' })).toBe('目标模式')
      expect(slashCommandDisplayLabel({ name: 'goal' })).toBe('goal')
    } finally {
      ;(globalThis as any).window = previousWindow
    }
  })
})

test('command and context results share the composer label source', () => {
  const menu = readFileSync(new URL('./slash-menu.tsx', import.meta.url), 'utf8')
  expect(menu).toContain('slashRowLabels(')
  expect(menu).toContain('slash-menu-item-slug')
  expect(menu).toContain('name: actions.slashCommandDisplayName(command)')
  const chat = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
  expect(chat).toContain('slashCommandDisplayName: (command) => slashCommandDisplayName(command),')
  expect(chat).toContain('return slashCommandDisplayLabel(command)')
})
