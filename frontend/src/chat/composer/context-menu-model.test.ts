import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/composer-context-menu-vectors.json'
import { contextCommandQueryKey, contextMenuSections, resolveSyntheticContextQuery, syntheticContextQuery, shouldCloseEmptyContextMenu, CONTEXT_RESULT_LIMIT } from './context-menu-model'
import { QueryClient } from '@tanstack/react-query'
import type { MentionEntry } from './slash-menu'
import type { MentionSection } from './mention-sections'

const entry = (name: string, extra: Partial<MentionEntry> = {}): MentionEntry => ({ name, path: name, rel: '', isDir: false, ...extra })
const section = (key: string, rows: MentionEntry[]): MentionSection => ({ key, labelKey: key, rows })

describe('context menu activation contract', () => {
  for (const vector of vectors.activation) {
    test(`button activation preserves authored content at ${vector.start}:${vector.end}`, () => {
      const activation = syntheticContextQuery(vector.text, vector.start, vector.end, 'editor-a')
      expect(resolveSyntheticContextQuery(activation, vector.after, vector.caret, 'selectionEnd' in vector ? vector.selectionEnd! : vector.caret, 'editor-a'))
        .toEqual({ start: vector.range[0], end: vector.range[1], query: vector.query })
      expect(vector.text.includes('@')).toBe(false)
    })
  }
  test('navigation, changed bindings and unrelated text invalidate a button query', () => {
    const activation = syntheticContextQuery('before after', 7, 7, 'editor-a')
    expect(resolveSyntheticContextQuery(activation, 'before textafter', 11, 11, 'editor-b')).toBeNull()
    expect(resolveSyntheticContextQuery(activation, 'before textafter', 8, 8, 'editor-a')).toBeNull()
    expect(resolveSyntheticContextQuery(activation, 'other textafter', 10, 10, 'editor-a')).toBeNull()
    expect(resolveSyntheticContextQuery(activation, 'before line\nafter', 12, 12, 'editor-a')).toBeNull()
  })
})

describe('empty context results', () => {
  test('an unmatched single search term remains discoverable', () => {
    expect(shouldCloseEmptyContextMenu('unknown', false, 0)).toBe(vectors.emptyResults.closeSingleTerm)
    expect(shouldCloseEmptyContextMenu('未知技能', false, 0)).toBe(false)
    expect(shouldCloseEmptyContextMenu('', false, 0)).toBe(false)
    expect(shouldCloseEmptyContextMenu(' ', false, 0)).toBe(false)
  })
  test('unmatched prose dismisses only after sources finish and never hides a match', () => {
    for (const query of ['Please review', '请检查 无匹配', 'unknown ', 'unknown\tterm']) {
      expect(shouldCloseEmptyContextMenu(query, true, 0)).toBe(vectors.emptyResults.closeWhileLoading)
      expect(shouldCloseEmptyContextMenu(query, false, 1)).toBe(false)
      expect(shouldCloseEmptyContextMenu(query, false, 0)).toBe(vectors.emptyResults.closeWithWhitespace)
    }
  })
})

describe('context source grouping and search contract', () => {
  test('different editor catalog policies cannot reuse each other cached command results', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
    const main = await client.fetchQuery({ queryKey: contextCommandQueryKey('main', 'one'), queryFn: async () => ['skill', 'command'] })
    const inline = await client.fetchQuery({ queryKey: contextCommandQueryKey('inline-skills', 'one'), queryFn: async () => ['skill'] })
    expect(main).toEqual(['skill', 'command'])
    expect(inline).toEqual(['skill'])
    expect(client.getQueryData(contextCommandQueryKey('main', 'one'))).toEqual(['skill', 'command'])
    client.clear()
  })
  test('empty queries retain source order and apply only the source-specific first-screen limits', () => {
    const sources = Object.entries(vectors.emptySourceLimits).map(([key]) => section(key, Array.from({ length: 10 }, (_, index) => entry(`${key}-${index}`))))
    const result = contextMenuSections([...sources, section('plugins', Array.from({ length: 12 }, (_, index) => entry(`plugin-${index}`)))], '')
    expect(result.map(group => group.key)).toEqual([...Object.keys(vectors.emptySourceLimits), 'plugins'])
    for (const group of result) expect(group.rows.length).toBe(group.key === 'plugins' ? 12 : vectors.emptySourceLimits[group.key as keyof typeof vectors.emptySourceLimits])
  })
  test('search ranks all sources before limiting the single headingless result list', () => {
    const sources = [section('files', [entry('diagram.ts')]), section('skills', [entry('Diagram review')]),
      section('plugins', [entry('Diagrams', { kind: 'plugin', aliases: ['图表'] })])]
    const result = contextMenuSections(sources, 'diagram')
    expect(result).toHaveLength(1)
    expect(result[0].labelKey).toBeNull()
    expect(result[0].rows.map(row => row.name)).toEqual(['Diagrams', 'Diagram review', 'diagram.ts'])
    expect(contextMenuSections(sources, '图表')[0].rows[0].name).toBe('Diagrams')
  })
  test('skills appear through search instead of a truncated initial group', () => {
    const source = section('skills', Array.from({ length: 40 }, (_, index) => entry(`Skill ${index}`)))
    expect(contextMenuSections([source], '')[0].rows).toHaveLength(0)
    expect(contextMenuSections([source], 'Skill 39')[0].rows[0].name).toBe('Skill 39')
    expect(CONTEXT_RESULT_LIMIT).toBe(vectors.queryLimit)
    expect(contextMenuSections([source], 'Skill')[0].rows).toHaveLength(vectors.queryLimit)
  })
  test('matching supports paths, aliases, subsequences and stable ties', () => {
    const source = section('files', [entry('index.ts', { rel: 'src/composer/index.ts' }), entry('menu.ts'), entry('metadata.ts')])
    expect(contextMenuSections([source], 'composer')[0].rows.map(row => row.name)).toEqual(['index.ts'])
    expect(contextMenuSections([source], 'mt')[0].rows.map(row => row.name)).toEqual(['index.ts', 'menu.ts', 'metadata.ts'])
  })
  test('one failed source does not suppress healthy matches or claim an empty result', () => {
    const failed: MentionSection = { key: 'devices', labelKey: 'devices', rows: [], state: { kind: 'error', labelKey: 'failed' } }
    expect(contextMenuSections([failed, section('files', [entry('menu.ts')])], 'menu')[0].rows).toHaveLength(1)
    expect(contextMenuSections([failed], 'missing')[0].state?.kind).toBe('error')
    expect(contextMenuSections([section('files', [])], 'missing')[0].rows).toEqual([])
  })
})
