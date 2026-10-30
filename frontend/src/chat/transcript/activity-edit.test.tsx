import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityToolData } from './activity-tool-model'
import { editActivityPresentation, parseActivityPatch, replacementDiff } from './activity-edit-model'
import { EditActivityTool } from './activity-edit'

const edit = (args: unknown, overrides: Partial<ActivityToolData> = {}): ActivityToolData => ({ toolCallId: 'edit-1', toolName: 'edit', state: 'done', args, ...overrides })
const render = (tool: ActivityToolData, open = true) => renderToStaticMarkup(<EditActivityTool tool={tool} open={open} onToggle={() => {}} locale="en" />)

describe('file edit presentation', () => {
  test('parses add, update, move, and delete operations without pretending missing positions are known', () => {
    const patch = '*** Begin Patch\n*** Add File: added.txt\n+one\n+two\n*** Update File: before.txt\n*** Move to: after.txt\n@@\n old context\n-old\n+new\n*** Delete File: removed.txt\n*** End Patch'
    const files = parseActivityPatch(patch)
    expect(files.map(file => [file.path, file.kind, file.added, file.removed])).toEqual([
      ['added.txt', 'add', 2, 0], ['before.txt', 'update', 1, 1], ['removed.txt', 'delete', undefined, undefined],
    ])
    expect(files[0].lines[1].newLine).toBe(2)
    expect(files[1].movePath).toBe('after.txt')
    expect(files[1].lines.find(line => line.kind === 'added')?.newLine).toBeUndefined()
  })

  test('reads standard unified hunk line numbers and multiple files', () => {
    const files = parseActivityPatch('--- a/one.ts\n+++ b/one.ts\n@@ -12,2 +12,2 @@\n keep\n-old\n+new\n--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n-before\n+after', '', false)
    expect(files.map(file => file.path)).toEqual(['one.ts', 'two.ts'])
    expect(files[0].lines.find(line => line.kind === 'removed')?.oldLine).toBe(13)
    expect(files[0].lines.find(line => line.kind === 'added')?.newLine).toBe(13)
    expect(files[0].requested).toBe(false)
    expect(files[1].key).toBe('two.ts')
  })

  test('does not confuse removed and added code starting with dashes with file headers', () => {
    const [file] = parseActivityPatch('--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n--- old value\n+++ new value')
    expect(file.path).toBe('file.txt')
    expect(file.lines.filter(line => line.kind === 'removed' || line.kind === 'added').map(line => line.text)).toEqual(['-- old value', '++ new value'])
  })

  test('computes replacement changes while preserving shared context and literal markup', () => {
    const lines = replacementDiff('head\nold\n<script>x</script>\ntail\n', 'head\nnew\n<script>x</script>\ntail\n')
    expect(lines.map(line => [line.kind, line.text])).toEqual([['context', 'head'], ['removed', 'old'], ['added', 'new'], ['context', '<script>x</script>'], ['context', 'tail']])
    const model = editActivityPresentation(edit({ file_path: 'file.ts', old_string: 'before\n', new_string: 'after\n' }))
    expect(model.files[0]).toMatchObject({ added: 1, removed: 1, requested: true })
    expect(model.files[0].lines.every(line => line.oldLine === undefined && line.newLine === undefined)).toBe(true)
  })

  test('keeps several edits to the same file together and several paths independent', () => {
    const model = editActivityPresentation(edit({ edits: [{ path: 'one.ts', oldString: 'a', newString: 'b' }, { path: 'one.ts', oldString: 'c', newString: 'd' }, { path: 'two.ts', oldString: 'x', newString: 'y' }] }))
    expect(model.files).toHaveLength(2)
    expect(model.files[0]).toMatchObject({ path: 'one.ts', added: 2, removed: 2 })
    expect(model.files[0].diff).toContain('-a')
    expect(model.files[0].diff).toContain('-c')
  })

  test('shows newline-only changes as a replacement instead of claiming zero changed lines', () => {
    const lines = replacementDiff('same', 'same\n')
    expect(lines.map(line => line.kind)).toEqual(['removed', 'notice', 'added'])
    expect(replacementDiff('', 'new\n').map(line => line.kind)).toEqual(['added'])
  })

  test('prefers actual patch stats and contents without losing the file identity during streaming', () => {
    const args = { patch: '*** Begin Patch\n*** Update File: src/file.ts\n@@\n-old\n+new\n*** End Patch' }
    const before = editActivityPresentation(edit(args))
    const after = editActivityPresentation(edit(args, { output: JSON.stringify({ files: [{ path: '/repo/src/file.ts', kind: 'update', exact: false, added: 3, removed: 2 }] }) }))
    expect(after.files).toHaveLength(1)
    expect(after.files[0]).toMatchObject({ path: '/repo/src/file.ts', key: before.files[0].key, added: 3, removed: 2, requested: true, exact: false })
    const actual = editActivityPresentation(edit(args, { output: JSON.stringify({ changes: { 'src/file.ts': { type: 'update', unified_diff: '--- a/src/file.ts\n+++ b/src/file.ts\n@@ -3 +3 @@\n-old\n+normalized' } } }) }))
    expect(actual.files[0].requested).toBe(false)
    expect(actual.files[0].diff).toContain('+normalized')
  })

  test('does not claim zero changes when an overwrite has no available baseline', () => {
    const model = editActivityPresentation(edit({ path: 'file.txt', content: 'new content\n' }, { toolName: 'write', output: '{"path":"file.txt","kind":"modify","bytes":12}' }))
    expect(model.files[0].added).toBeUndefined()
    expect(model.files[0].removed).toBeUndefined()
    expect(model.files[0].lines[0]).toMatchObject({ kind: 'context', text: 'new content' })
    const created = editActivityPresentation(edit({ path: 'file.txt', content: 'new content\n' }, { toolName: 'write', output: '{"path":"file.txt","kind":"create","bytes":12}' }))
    expect(created.files[0]).toMatchObject({ kind: 'add', added: 1, removed: 0 })
  })
})

describe('file edit details and controls', () => {
  test('provides separate file and disclosure controls, counts, copy, and readable diff lines', () => {
    const html = render(edit({ path: 'src/file.ts', oldString: 'old\n', newString: 'new\n' }))
    expect(html).toContain('aria-label="Toggle diff for file.ts"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Edited file')
    expect(html).toContain('aria-label="Copy diff"')
    expect(html).toContain('1 lines added, 1 lines removed')
    expect(html).toContain('role="region" aria-label="Diff for src/file.ts"')
    expect(html).toContain('data-kind="removed"')
    expect(html).toContain('data-kind="added"')
    expect(html).toContain('Requested changes')
  })

  test('folds failure results like success results instead of opening them by default', () => {
    for (const state of ['error', 'interrupted'] as const) {
      const failed = edit({ path: 'file.ts', oldString: 'before', newString: 'after' }, { state, output: '<failure>file was not changed</failure>' })
      const folded = render(failed, false)
      expect(folded).not.toContain('file was not changed')
      expect(folded).not.toContain('Edited file')
      expect(folded).not.toContain('data-kind="added"')
      const opened = render(failed, true)
      expect(opened).toContain('&lt;failure&gt;file was not changed&lt;/failure&gt;')
      expect(opened).toContain('Tool result')
      expect(opened).not.toContain('Edited file')
    }
  })

  test('supports a pending multi-file patch and separate path links', () => {
    const html = render(edit({ patch: '*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch' }, { toolName: 'apply_patch', state: 'awaiting-approval' }))
    expect(html).toContain('Toggle diff for first.txt')
    expect(html).toContain('Toggle diff for second.txt')
    expect(html.match(/data-pending="true"/g)?.length).toBe(2)
    expect(html).toContain('Awaiting approval')
    expect(html).not.toContain('Created file')
  })

  // Every file row shares the one tool state, so a running N-file edit used to
  // light N gradient sweeps at once. Codex lights at most one per turn, and each
  // sweep re-rasterizes its text-clipped gradient every frame — so only the first
  // row carries it. The wording is unchanged on every row: the state is still
  // readable, only the duplicated animation is gone.
  test('one sweep per turn: a running multi-file edit lights only its first row', () => {
    const patch = '*** Begin Patch\n*** Update File: one.ts\n@@\n-old\n+new\n*** Update File: two.ts\n@@\n-old\n+new\n*** Update File: three.ts\n@@\n-old\n+new\n*** End Patch'
    const html = render(edit({ patch }, { toolName: 'apply_patch', state: 'running' }))
    expect(html.match(/data-running="true"/g)?.length).toBe(1)
    // All three rows still say what they are doing.
    expect(html.match(/Editing/g)?.length).toBe(3)
    // And a single-file running edit still gets its sweep.
    const single = render(edit({ path: 'solo.ts', oldString: 'a', newString: 'b' }, { state: 'running' }))
    expect(single.match(/data-running="true"/g)?.length).toBe(1)
    // A finished edit has none at all.
    const done = render(edit({ patch }, { toolName: 'apply_patch', state: 'done' }))
    expect(done).not.toContain('data-running')
  })

  test('keeps unknown edit shapes inspectable and escapes input instead of injecting HTML', () => {
    const html = render(edit({ custom: '<img src=x onerror=run()>' }, { state: 'error', output: 'Unsupported edit shape' }))
    expect(html).toContain('&lt;img src=x onerror=run()&gt;')
    expect(html).toContain('Unsupported edit shape')
    expect(html).toContain('aria-label="Copy input"')
    expect(html).not.toContain('<img')
  })
})
