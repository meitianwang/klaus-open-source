import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { selectComposerSkillRows } from './composer-skills'

const FAILED = 'list load failed'

// localizeSkillName reads the same window table the skills page reads, so the
// merge needs a window shim; a table holding only the localization case's key
// keeps every other row on its frontmatter-name fallback.
const SKILL_TABLE = {
  'localized-skill': { zh: ['本地化技能', '本地化描述。'], en: ['Localized Skill', 'Localized description.'] },
}
const previousWindow = (globalThis as any).window

beforeEach(() => {
  ;(globalThis as any).window = { SKILL_TEXT_I18N: SKILL_TABLE }
})

afterEach(() => {
  ;(globalThis as any).window = previousWindow
})

function base(input: Partial<Parameters<typeof selectComposerSkillRows>[0]> = {}) {
  return selectComposerSkillRows({
    installed: [],
    builtin: { items: [], error: null },
    projectCommands: [],
    loadFailedMessage: FAILED,
    ...input,
  })
}

describe('selectComposerSkillRows', () => {
  test('retains scoped definition paths for global and plugin skill selections', () => {
    const path = '/fixture/plugins/review/custom/SKILL.md'
    const rows = base({ projectCommands: [{ name: 'private-review', source: 'skills', scope: 'global', path }] })
    expect(rows).toEqual([{ name: 'private-review', displayName: 'private-review', description: '', source: 'skills', path }])
  })
  test('merges host object-shaped builtin replies with installed rows', () => {
    const rows = base({
      installed: [{ dirName: 'push-code', name: 'Push Code', description: 'ship it', source: 'installed', userEnabled: true }],
      builtin: { items: [{ name: 'deep-research', description: 'research', source: 'builtin', userInvocable: true, userEnabled: true }], error: null },
    })
    expect(rows.map(row => row.name)).toEqual(['deep-research', 'push-code'])
    expect(rows[1]).toMatchObject({ displayName: 'Push Code', source: 'installed' })
  })

  test('still accepts the legacy bare-array builtin shape', () => {
    const rows = base({ builtin: [{ dirName: 'legacy', name: 'Legacy', userEnabled: true }] })
    expect(rows.map(row => row.name)).toEqual(['legacy'])
  })

  test('keeps installed rows when the builtin reply is garbage instead of throwing', () => {
    const rows = base({
      installed: [{ dirName: 'only', name: 'Only', userEnabled: true }],
      builtin: { unexpected: true },
    })
    expect(rows.map(row => row.name)).toEqual(['only'])
  })

  test('throws the load-failed message when installed or project rows are not arrays', () => {
    expect(() => base({ installed: { error: 'nope' } })).toThrow(FAILED)
    expect(() => base({ projectCommands: null })).toThrow(FAILED)
  })

  test('drops disabled and non-invocable rows and dedupes by dirName', () => {
    const rows = base({
      installed: [
        { dirName: 'off', name: 'Off', userEnabled: false },
        { dirName: 'hard-off', name: 'Hard Off', enabled: false },
        { dirName: 'hidden', name: 'Hidden', userInvocable: false },
        { dirName: 'dup', name: 'Installed Dup', userEnabled: true },
      ],
      builtin: { items: [{ dirName: 'dup', name: 'Builtin Dup', source: 'builtin', userEnabled: true }], error: null },
    })
    expect(rows.map(row => row.name)).toEqual(['dup'])
    expect(rows[0].displayName).toBe('Builtin Dup')
  })

  test('project skill rows override same-name global rows', () => {
    const rows = base({
      installed: [{ dirName: 'deploy', name: 'Global Deploy', userEnabled: true }],
      projectCommands: [
        { name: 'deploy', displayName: 'Project Deploy', description: 'proj', scope: 'project', kind: 'skill' },
        { name: 'other-proj', displayName: 'Other', scope: 'project', kind: 'skill' },
        { name: 'global-cmd', displayName: 'Global Cmd', scope: 'user', kind: 'skill' },
        { name: 'plugin:thing', displayName: 'Plugin', scope: 'project', source: 'plugin:x' },
      ],
    })
    const byName = new Map(rows.map(row => [row.name, row]))
    expect(byName.get('deploy')?.displayName).toBe('Project Deploy')
    expect(byName.get('other-proj')?.displayName).toBe('Other')
    expect(byName.has('global-cmd')).toBe(true)
    expect(byName.has('plugin:thing')).toBe(false)
  })

  test('sorts case-insensitively by display name', () => {
    const rows = base({
      installed: [
        { dirName: 'z', name: 'zeta', userEnabled: true },
        { dirName: 'a', name: 'Alpha', userEnabled: true },
        { dirName: 'b', name: 'beta', userEnabled: true },
      ],
    })
    expect(rows.map(row => row.displayName)).toEqual(['Alpha', 'beta', 'zeta'])
  })

  test('display names come from the shared skill text table in the active language', () => {
    ;(globalThis as any).window.currentLang = 'zh'
    const zh = base({ installed: [{ dirName: 'localized-skill', name: 'localized-skill', userEnabled: true }] })
    expect(zh[0].displayName).toBe('本地化技能')
    ;(globalThis as any).window.currentLang = 'en'
    const en = base({ installed: [{ dirName: 'localized-skill', name: 'localized-skill', userEnabled: true }] })
    expect(en[0].displayName).toBe('Localized Skill')
    // A slug without a table entry keeps its frontmatter name.
    const plain = base({ installed: [{ dirName: 'plain', name: 'Plain Name', userEnabled: true }] })
    expect(plain[0].displayName).toBe('Plain Name')
  })

  test('chat.ts wires the plus-menu loader through the shared merge', () => {
    const chat = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
    expect(chat).toContain('selectComposerSkillRows({')
    expect(chat).not.toContain('!Array.isArray(builtin)')
  })
})
