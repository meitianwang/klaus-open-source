import { mediaInputMime } from '../../../../shared/media-input'
import { composerDocumentFromText, snapshotComposerDocument } from './document-model'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { encodeSelectedTextEnvelope } from '../selected-text-envelope'
import { createComposerDraft, normalizeComposerDraft } from './slash-draft'
import { normalizeComposerReferences, replaceComposerReferenceRange } from './reference-token'
import { isSkillCommand, migrateSkillDraft, referencesFromEditor, resourceReference, resourceReferenceContext, skillReference } from './resource-reference'
import vectors from '../../../../contracts/vectors/composer-mention-vectors.json'
import { isInlineImage } from './attachment-policy'

describe('inline resource references', () => {
  test('skills have independent identities rather than an executable selection', () => {
    const first = replaceComposerReferenceRange('', 0, 0, '', skillReference(vectors.skills[0]))
    const text = first.text + vectors.prose + '/beta'
    const start = text.lastIndexOf('/')
    const second = replaceComposerReferenceRange(text, start, text.length, '', skillReference(vectors.skills[1]))
    const draft = createComposerDraft(second.text, null, null, [first.reference, second.reference])
    expect(draft.slashCommand).toBeNull()
    expect(draft.references.map(reference => reference.id)).toEqual(vectors.skills.map(skill => skill.name))
    expect(draft.text).toContain(vectors.prose)
    expect(normalizeComposerDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft)
  })

  test('migrates an older skill draft without changing surrounding text or reference positions', () => {
    const text = 'Before /alpha-skill after @plugin'
    const start = text.indexOf('/')
    const end = start + '/alpha-skill'.length
    const pluginStart = text.indexOf('@')
    const draft = createComposerDraft(text, vectors.skills[0], { start, end }, [{
      kind: 'plugin', name: 'plugin', value: '@plugin', range: { start: pluginStart, end: text.length },
    }])
    const migrated = migrateSkillDraft(draft)
    expect(migrated.text).toBe('Before [Alpha skill](klaus:skill/alpha-skill) after @plugin')
    expect(migrated.slashCommand).toBeNull()
    expect(migrated.references.map(reference => reference.kind)).toEqual(['skill', 'plugin'])
    expect(migrated.references[1].range.start).toBe(migrated.text.indexOf('@plugin'))
  })

  test('keeps actual executable commands separate from resource references', () => {
    const command = { name: 'init', type: 'local' }
    const draft = createComposerDraft('/init a', command, { start: 0, end: 5 })
    expect(isSkillCommand(command)).toBe(false)
    expect(migrateSkillDraft(draft)).toBe(draft)
  })

  test('native node positions replace stale ranges while preserving exact resource identity', () => {
    const reference = { ...skillReference(vectors.skills[0]), range: { start: 0, end: 12 } }
    const value = `prefix ${reference.value}`
    const references = referencesFromEditor(value, [{ start: 7, end: value.length, value: reference.value, data: reference }])
    expect(references).toEqual([{ ...reference, range: { start: 7, end: value.length } }])
    expect(referencesFromEditor('', [])).toEqual(vectors.cleared.references)
  })

  test('retains repeated visible mentions and deduplicates only model-facing resource identities', () => {
    const first = replaceComposerReferenceRange('', 0, 0, '', skillReference(vectors.skills[0]))
    const second = replaceComposerReferenceRange(first.text, first.text.length, first.text.length, '', skillReference(vectors.skills[0]))
    const references = normalizeComposerReferences(second.text, [first.reference, second.reference])
    expect(references).toHaveLength(vectors.send.visibleOccurrences)
    const context = resourceReferenceContext(references)
    const resources = JSON.parse(context.split('\n').at(-2)!)
    expect(resources).toHaveLength(vectors.send.uniqueResourceTargets)
    expect(resources[0]).toMatchObject({ kind: 'skill', name: vectors.skills[0].name })
    expect(context).toContain('selection is not a standalone command')
  })

  test('plugin and MCP targets reach model context without altering the authored text', () => {
    const refs = [
      { kind: 'plugin' as const, name: 'Design tools', value: '@Design tools', id: 'plugin-id', range: { start: 0, end: 13 } },
      { kind: 'mcp' as const, name: 'Knowledge', value: '@mcp-Knowledge', id: 'Knowledge', range: { start: 14, end: 28 } },
    ]
    const context = resourceReferenceContext(refs)
    expect(context).toContain('plugin-id')
    expect(context).toContain('Knowledge')
    expect(context).toContain('"kind":"mcp"')
    expect(resourceReferenceContext([])).toBe('')
  })

  test('plain-text persistence restores skill, plugin and MCP identities including escaped labels', () => {
    const selected = [resourceReference('skill', 'A [review]', 'review:exact'),
      resourceReference('plugin', 'Design', '/plugins/design (copy)'), resourceReference('mcp', 'Knowledge')]
    const text = selected.map(reference => reference.value).join(' then ')
    const restored = normalizeComposerDraft(text)
    expect(restored.references.map(reference => [reference.kind, reference.name, reference.id]))
      .toEqual(selected.map(reference => [reference.kind, reference.name, reference.id]))
  })

  test('a selected skill keeps its exact definition outside standard roots through plain-text restoration', () => {
    const selected = skillReference(vectors.userOnlySkill)
    const restored = normalizeComposerDraft(selected.value)
    expect(restored.references[0].skillPath).toBe(vectors.userOnlySkill.path)
    const context = resourceReferenceContext(restored.references)
    const resources = JSON.parse(context.split('\n').at(-2)!)
    expect(resources[0]).toMatchObject({ name: vectors.userOnlySkill.name, path: vectors.userOnlySkill.path })
  })

  test('the production payload carries each selected resource identity in model-visible input', () => {
    const selected = [resourceReference('skill', 'Alpha skill', 'alpha-skill'), resourceReference('plugin', 'Design', 'design-id')]
    const text = '  ' + selected.map(reference => reference.value).join(' and ') + '\n\n'
    const references = normalizeComposerReferences(text, [])
    const ast = createSourceFile('chat.ts', readFileSync(new URL('../chat.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
    const declaration = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'buildOutgoingPayload')!
    const build = runInNewContext(transpileModule(`${declaration.getText(ast)}\nbuildOutgoingPayload`, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText, {
      composePastedTextRequest: (value: string) => ({ text: value }),
      encodeSelectedTextEnvelope, resourceReferenceContext, normalizeComposerReferences, isInlineImage, mediaInputMime,
    })
    const file = { file: { name: 'Notes.pdf', type: 'application/pdf', size: 10 }, uploadPath: '/pool/notes.pdf', uploading: false }
    const snapshot = snapshotComposerDocument(composerDocumentFromText(text))
    const payload = build(text, [file], null, 'thread', references, snapshot)
    expect(payload.composerDocument).toEqual(snapshot)
    expect(payload.displayText).toBe(text)
    expect(payload.finalText.startsWith('  ')).toBe(true)
    expect(payload.composerReferences).toEqual(references)
    expect(payload.finalText).toContain('"name":"alpha-skill"')
    expect(payload.finalText).toContain('"id":"design-id"')
    expect(payload.finalText).toContain(text)
    expect(payload.finalText.endsWith('Attached:\n- /pool/notes.pdf')).toBe(true)
  })
})
