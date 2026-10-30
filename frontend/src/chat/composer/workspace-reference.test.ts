import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/composer-mention-vectors.json'
import { workspaceReference, workspaceReferencesIn } from './workspace-reference'
import { normalizeComposerReferences } from './reference-token'
import { resourceReferenceContext } from './resource-reference'

describe('inline filesystem references', () => {
  test('preserves repeated authored positions when importing a legacy draft', () => {
    const value = vectors.workspace.legacyText
    const references = workspaceReferencesIn(value)
    expect(references.map(reference => reference.kind)).toEqual(vectors.workspace.kinds)
    expect(references.map(reference => value.slice(reference.range.start, reference.range.end)))
      .toEqual(vectors.workspace.values)
    expect(normalizeComposerReferences(value, references)).toEqual(references)
  })

  test('preserves exact secondary-root and quoted-name targets', () => {
    const target = workspaceReference(vectors.workspace.quotedTarget)
    expect(target.value).toBe(vectors.workspace.quotedTarget.value)
    const restored = normalizeComposerReferences(target.value, [])[0]
    expect(restored.id).toBe('/other root/a"b.ts')
    expect(restored.path).toBe('/other root/a"b.ts')
    expect(resourceReferenceContext([{ ...target, range: { start: 0, end: target.value.length } }])).toContain('"path":"/other root/a\\"b.ts"')
  })

  test('folder addresses retain their directory marker without changing their target', () => {
    const reference = workspaceReference({ rel: 'src/components/', name: 'Components', isDir: true })
    expect(reference).toMatchObject({ kind: 'folder', value: '@"src/components/"', rel: 'src/components', id: 'src/components' })
    expect(workspaceReferencesIn('literal @"worker (agent)"')).toEqual([])
  })
})
