import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import * as goalShortcuts from './goal-shortcut'
import * as planShortcuts from './plan-shortcut'
import * as compactCommands from './manual-compact-command'
import * as reviewShortcuts from './approval-review-shortcut'
import { composerQueryInText, sameComposerQuery } from './composer-query'
import vectors from '../../../../contracts/vectors/composer-input-vectors.json'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true)
const names = new Set(['findSlashTrigger', 'isValidSlashCommandRange', 'handleSlashMenu', 'withComposerGoalShortcut', 'currentComposerQuery', 'currentSlashTrigger'])
const declarations = ast.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text || ''))
const script = transpileModule(`${declarations.map(node => node.getText(ast)).join('\n')}\nhandleSlashMenu`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText

function fixture(vector: typeof vectors.slashCases[number]) {
  const placeholder = vector.selected ? '\u00a0'.repeat(20) : ''
  const value = vector.prefix + placeholder + vector.suffix
  const cursor = vector.cursor ?? value.length
  const shown: string[][] = []
  const context = {
    composerQueryInText, sameComposerQuery, mainComposerControl: null, syntheticMention: null,
    ...goalShortcuts,
    ...planShortcuts,
    ...compactCommands,
    pendingFiles: [],
    ...reviewShortcuts,
    window: { currentSessionId: null }, approvalReviewDenials: () => [],
    composerGoalEligible: () => true,
    inputEl: { value, selectionStart: cursor - (vector.selectionLength ?? 0), selectionEnd: cursor },
    selectedSlashCommand: vector.selected ? vectors.skill : null,
    selectedSlashCommandRange: vector.selected ? { start: vector.prefix.length, end: vector.prefix.length + placeholder.length } : null,
    pendingPastedSlashToken: false, composerMenuMode: '', activeSlashTriggerRange: null, slashRequestSeq: 0,
    slashMenu: { classList: { contains: () => true } },
    slashCommandMatchesSearch: (command: { name: string }, query: string) => command.name.includes(query),
    fetchSlashCommands: async () => [vectors.skill],
    tt: (key: string) => key,
    StaleSlashCatalogRequest: class extends Error {},
    showSlashMenu: (commands: Array<{ name: string }>, trigger: any) => { context.activeSlashTriggerRange = trigger; shown.push(commands.map(command => command.name)) },
    hideSlashMenu: () => { shown.length = 0 },
  }
  return { context, shown, handle: runInNewContext(script, context) as (options?: { refreshOnly?: boolean }) => Promise<void> }
}

describe('slash queries in a skill draft', () => {
  for (const vector of vectors.slashCases) {
    test(vector.name, async () => {
      const f = fixture(vector)
      const original = f.context.inputEl.value
      await f.handle()
      expect(f.shown.at(-1) ?? []).toEqual(vector.expected)
      expect(f.context.inputEl.value).toBe(original)
      if (vector.expected.length) expect(f.context.activeSlashTriggerRange).not.toBeNull()
    })
  }

  test('refreshes an open query while retaining the selected skill', async () => {
    const f = fixture(vectors.slashCases[0])
    f.context.composerMenuMode = 'slash'
    f.context.slashMenu.classList.contains = () => false
    await f.handle({ refreshOnly: true })
    expect(f.shown.at(-1)).toEqual([vectors.skill.name])
    expect(f.context.selectedSlashCommand).toEqual(vectors.skill)
  })

  test('does not treat a query overlapping the selected token as a new trigger', async () => {
    const f = fixture(vectors.slashCases[0])
    const end = f.context.inputEl.value.length
    f.context.selectedSlashCommandRange = { start: end - 4, end }
    await f.handle()
    expect(f.shown).toEqual([])
    expect(f.context.activeSlashTriggerRange).toBeNull()
  })
})

test('a delayed slash result cannot reopen the picker after the caret leaves its query', async () => {
  const f = fixture(vectors.slashCases[0])
  let resolve!: (commands: unknown[]) => void
  f.context.fetchSlashCommands = () => new Promise(done => { resolve = done }) as any
  const pending = f.handle()
  f.context.inputEl.selectionStart = 0
  f.context.inputEl.selectionEnd = 0
  resolve([vectors.skill])
  await pending
  expect(f.shown).toEqual([])
})
