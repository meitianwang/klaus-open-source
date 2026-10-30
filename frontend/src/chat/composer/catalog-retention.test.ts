import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('a failed catalog refresh preserves the selected command and neighboring resource identities', async () => {
  const source = ts.createSourceFile('chat.ts', readFileSync(new URL('../chat.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ESNext, true)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'refreshSelectedSlashCommand')
  if (!declaration) throw new Error('Missing catalog refresh route')
  const selected = { name: 'review', kind: 'command' }, range = { start: 0, end: 7 }
  const references = [{ kind: 'plugin', id: 'tools', range: { start: 8, end: 14 } }]
  let writes = 0
  const context = { selectedSlashCommand: selected, selectedSlashCommandRange: range, composerReferenceTokens: references,
    inputEl: { value: '/review @tools', selectionStart: 14, selectionEnd: 14 },
    isValidSlashCommandRange: () => true, slashCatalogScope: () => 'owner',
    fetchSlashCommands: async () => { throw new Error('Catalog unavailable') },
    mainComposerControl: { refreshTokens: () => { writes++ }, replaceRange: () => { writes++ } },
    renderSelectedSlashCommand: () => { writes++ }, autoResize: () => { writes++ }, persistComposerDraft: () => { writes++ },
  }
  const script = ts.transpileModule(declaration.getText(source) + '\nrefreshSelectedSlashCommand()', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  await runInNewContext(script, context)
  expect(context.selectedSlashCommand).toBe(selected)
  expect(context.selectedSlashCommandRange).toBe(range)
  expect(context.composerReferenceTokens).toBe(references)
  expect(context.inputEl).toEqual({ value: '/review @tools', selectionStart: 14, selectionEnd: 14 })
  expect(writes).toBe(0)
})
