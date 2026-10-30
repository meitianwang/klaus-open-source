import { pickAntigravityModelMetadata } from '../../../../shared/antigravity-model-catalog'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'

test('account restrictions and exact media MIME metadata survive the model menu projection', async () => {
  const options = [
    { value: 'antigravity:paid', label: 'Restricted model', available: false, reason: 'Subscription required' },
    { value: 'antigravity:ready', label: 'Ready model', available: true, mediaInputMimeTypes: ['audio/webm;codecs=opus'],
      antigravityFamilyId: 'ready', antigravityVariants: [{ value: 'antigravity:ready', thinkingLevel: 'medium', available: true }] },
    { value: 'qoder:fast', label: 'Fast', priceFactor: 0.8 },
  ]
  const ast = createSourceFile('chat.ts', readFileSync(new URL('../chat.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
  const declaration = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'buildSessionMainModelItems')!
  const api = runInNewContext(transpileModule(declaration.getText(ast) + '\n({ buildSessionMainModelItems })', {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText, {
    klausApi: { session: { getMainModelOptions: async () => ({ options }) } },
    pickAntigravityModelMetadata, pickThinkingMetadata: () => ({}), pickFastModeMetadata: () => ({}), pickCursorModelMetadata: () => ({}),
    pickTraeModelMetadata: () => ({}), pickKiroModelMetadata: () => ({}),
  })
  const rows = await api.buildSessionMainModelItems('antigravity')
  expect(rows[0].available).toBe(false)
  expect(rows[0].reason).toBe('Subscription required')
  expect(rows[1].mediaInputMimeTypes).toEqual(['audio/webm;codecs=opus'])
  expect(rows[1].mediaInputMimeTypes).not.toBe(options[1].mediaInputMimeTypes)
  expect(rows[1].available).toBe(true)
  expect(rows[1].antigravityFamilyId).toBe('ready')
  expect(rows[1].antigravityVariants).toEqual(options[1].antigravityVariants)
  expect(rows[2].priceFactor).toBe(0.8)
})
