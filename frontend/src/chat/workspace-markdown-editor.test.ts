import { describe, expect, test } from 'bun:test'
import { EditorState, Transaction } from '@codemirror/state'
import { history, undo, undoDepth } from '@codemirror/commands'
import { markdownExternalChanges, markdownLineSeparator, markdownTaskChange, planMarkdownPresentation, safeMarkdownHref } from './workspace-markdown-editor'

describe('live Markdown presentation', () => {
  test('escaped punctuation is rendered without exposing its source marker', () => {
    const source = 'A\\|B and \\*literal\\*'
    const hidden = planMarkdownPresentation(source).filter(spec => spec.kind === 'hide')
    expect(hidden.map(spec => source.slice(spec.from, spec.to))).toEqual(['\\', '\\', '\\'])
    expect(planMarkdownPresentation(source, [{ from: 1, to: 1 }]).filter(spec => spec.kind === 'hide')).toEqual([])
  })
  test('conceals syntax outside the selection and exposes the active span', () => {
    const source = '# Heading\n\nA **strong** and *soft* paragraph.\n'
    const headingMarker = planMarkdownPresentation(source).find(spec => spec.kind === 'hide' && spec.from === 0)
    expect(headingMarker).toMatchObject({ from: 0, to: 2 })
    const strong = source.indexOf('**strong**')
    const soft = source.indexOf('*soft*')
    const active = planMarkdownPresentation(source, [{ from: strong + 3, to: strong + 3 }])
    expect(active.some(spec => spec.kind === 'hide' && spec.from === strong)).toBe(false)
    expect(active.some(spec => spec.kind === 'hide' && spec.from === soft)).toBe(true)
    expect(planMarkdownPresentation(source, [{ from: 4, to: 4 }]).some(spec => spec.kind === 'hide' && spec.from === 0)).toBe(false)
  })

  test('resolves reference links and images without changing their source', () => {
    const source = '[Read][doc] and ![Plot][image]\n\n[doc]: ./notes.md "Notes"\n[image]: ./plot.png\n'
    const specs = planMarkdownPresentation(source)
    expect(specs.find(spec => spec.kind === 'mark' && spec.href)).toMatchObject({ href: './notes.md', from: 1, to: 5 })
    expect(specs.find(spec => spec.kind === 'image')).toMatchObject({ href: './plot.png', alt: 'Plot', block: false })
    expect(source).toContain('[doc]: ./notes.md "Notes"')
  })

  test('renders GFM tables until their source is selected', () => {
    const table = '| Left | Right |\n| :--- | ---: |\n| **One** | `Two` |'
    const source = 'Intro\n\n' + table + '\n\nEnd'
    const from = source.indexOf('|')
    expect(planMarkdownPresentation(source).find(spec => spec.kind === 'table')).toMatchObject({ from, to: from + table.length, value: table, block: true })
    expect(planMarkdownPresentation(source, [{ from: from + 10, to: from + 10 }]).some(spec => spec.kind === 'table')).toBe(false)
    // Inline decorations inside a table replacement would otherwise overlap it.
    expect(planMarkdownPresentation(source).filter(spec => spec.from > from && spec.to < from + table.length)).toEqual([])
  })

  test('treats diagram fences as source while editing and as real diagram widgets otherwise', () => {
    const source = '```mermaid\nflowchart LR\n  A --> B\n```\n\n```js\nconst n = 1\n```'
    const specs = planMarkdownPresentation(source)
    expect(specs.find(spec => spec.kind === 'diagram')).toMatchObject({ value: 'flowchart LR\n  A --> B', block: true })
    expect(specs.filter(spec => spec.kind === 'diagram')).toHaveLength(1)
    const pos = source.indexOf('A -->')
    expect(planMarkdownPresentation(source, [{ from: pos, to: pos }]).some(spec => spec.kind === 'diagram')).toBe(false)
    expect(specs.some(spec => spec.kind === 'line' && spec.from === source.indexOf('const'))).toBe(true)
  })

  test('renders inline and display math without interpreting code or currency as math', () => {
    const source = 'Inline $a+b$ and `$raw$`. Price $5 and $6.\n\n$$\nx^2 + y^2\n$$\n\n```tex\n$literal$\n```'
    const maths = planMarkdownPresentation(source).filter(spec => spec.kind === 'math')
    expect(maths.map(spec => ({ value: spec.value, block: spec.block }))).toEqual([
      { value: 'a+b', block: false },
      { value: '\nx^2 + y^2\n', block: true },
    ])
    const from = source.indexOf('a+b')
    expect(planMarkdownPresentation(source, [{ from, to: from }]).filter(spec => spec.kind === 'math')).toHaveLength(1)
  })

  test('supports setext headings, quotes, strike-through, lists and thematic breaks', () => {
    const source = 'Heading\n=======\n\n> Quote with ~~deleted~~ text\n\n- Item\n\n---'
    const specs = planMarkdownPresentation(source)
    expect(specs.some(spec => spec.kind === 'hide' && source.slice(spec.from, spec.to) === '\n=======')).toBe(true)
    expect(specs.some(spec => spec.kind === 'hide' && source.slice(spec.from, spec.to) === '> ')).toBe(true)
    expect(specs.some(spec => spec.kind === 'hide' && source.slice(spec.from, spec.to) === '~~')).toBe(true)
    expect(specs.some(spec => spec.kind === 'rule')).toBe(true)
  })

  test('keeps raw HTML literal and rejects active content navigation', () => {
    const source = '<script>alert(1)</script>\n\n[Bad](javascript:alert)\n\n![Bad](data:image/svg+xml,bad)'
    const specs = planMarkdownPresentation(source)
    expect(specs.some(spec => spec.kind === 'image')).toBe(false)
    expect(specs.some(spec => spec.href?.startsWith('javascript:'))).toBe(false)
  })

  test('normalizes nested quote table presentation while retaining source offsets', () => {
    const source = '> > Nested\n\n> | A | B |\n> | - | - |\n> | C | D |'
    const specs = planMarkdownPresentation(source)
    expect(specs.filter(spec => spec.kind === 'hide' && spec.from < 5)).toEqual([{ kind: 'hide', from: 0, to: 4 }])
    expect(specs.find(spec => spec.kind === 'table')).toMatchObject({ from: source.indexOf('|'), to: source.length, value: '| A | B |\n| - | - |\n| C | D |' })
  })
})

describe('document line endings', () => {
  test('retains homogeneous and mixed newline bytes through a raw marker edit', () => {
    for (const source of ['- [ ] Task\r\nNext\r\n', '- [ ] Task\nNext\n', '- [ ] Task\rNext\r', '- [ ] Task\r\nNext\nLast\r\n']) {
      const state = EditorState.create({ doc: source, extensions: [EditorState.lineSeparator.of(markdownLineSeparator(source))] })
      expect(state.sliceDoc()).toBe(source)
      const change = markdownTaskChange(state.doc.toString(), 2, true)!
      expect(state.update({ changes: change }).state.sliceDoc()).toBe(source.replace('[ ]', '[x]'))
    }
  })
})

describe('task marker editing', () => {
  test('updates only the checkbox character, preserving all unrelated bytes', () => {
    const source = '- [ ]  Keep **spacing**\n- [X] Other\n'
    const task = planMarkdownPresentation(source).find(spec => spec.kind === 'task')!
    expect(task).toMatchObject({ from: 2, to: 5, checked: false })
    const change = markdownTaskChange(source, task.from, true)!
    expect(EditorState.create({ doc: source }).update({ changes: change }).state.doc.toString()).toBe('- [x]  Keep **spacing**\n- [X] Other\n')
    expect(markdownTaskChange(source, source.indexOf('[X]'), false)).toEqual({ from: source.indexOf('[X]') + 1, to: source.indexOf('[X]') + 2, insert: ' ' })
  })

  test('exposes a selected marker and rejects stale marker positions', () => {
    const source = '- [ ] Task'
    expect(planMarkdownPresentation(source, [{ from: 3, to: 3 }]).some(spec => spec.kind === 'task')).toBe(false)
    expect(markdownTaskChange(source, 0, true)).toBeNull()
    expect(markdownTaskChange(source, -1, true)).toBeNull()
    expect(markdownTaskChange('plain text', 2, true)).toBeNull()
  })
})

describe('Markdown navigation', () => {
  test('allows host-managed paths and normal links', () => {
    for (const href of ['https://example.com', './notes.md', '../plot.png', '/tmp/a b.png', 'C:\\docs\\a.md', '#heading', 'file:///tmp/a.md', 'klaus-media://session/a.png']) expect(safeMarkdownHref(href)).toBe(href)
  })

  test('rejects executable schemes, control characters and unknown protocols', () => {
    for (const href of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'vbscript:run', 'data:text/html,evil', 'java\nscript:alert(1)', 'unknown:payload', '\u0000/tmp/a']) expect(safeMarkdownHref(href)).toBe('')
    expect(safeMarkdownHref('mailto:a@example.com', true)).toBe('')
    expect(safeMarkdownHref('mailto:a@example.com')).toBe('mailto:a@example.com')
  })
})


describe('external document synchronization', () => {
  test('keeps an earlier undo entry when another view changes an unrelated line', () => {
    let state = EditorState.create({ doc: '# Heading\n\nBody', extensions: [history()] })
    state = state.update({ changes: { from: state.doc.length, insert: '\nDocument edit' } }).state
    const external = 'Source edit\n' + state.doc.toString()
    state = state.update({ changes: markdownExternalChanges(state, external), annotations: Transaction.addToHistory.of(false) }).state
    expect(undoDepth(state)).toBe(1)
    expect(undo({ state, dispatch(transaction) { state = transaction.state } })).toBe(true)
    expect(state.doc.toString()).toBe('Source edit\n# Heading\n\nBody')
  })
})
