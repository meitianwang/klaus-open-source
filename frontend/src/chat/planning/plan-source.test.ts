import { expect, test } from 'bun:test'
import { EditorSelection, EditorState, StateEffect, Transaction } from '@codemirror/state'
import { isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { createPlanSourceState, planSourceContent, PlanSourceHistory, PlanSourceInput, planSourceInsertion, planSourceReplacement, planSourceChanged } from './plan-source'
import { EditorView } from '@codemirror/view'

function fixture(source: string, maxEvents = 128, maxBytes = 1024 * 1024) {
  const budget = new PlanSourceHistory(maxEvents, maxBytes)
  let state = createPlanSourceState(source, budget.extension())
  const clear = () => budget.reset({ get state() { return state }, update: transactions => { for (const transaction of transactions) state = transaction.state } })
  const dispatch = (transaction: Transaction) => {
    state = transaction.state
    if (budget.observe([transaction], state)) clear()
  }
  return {
    get state() { return state }, get source() { return planSourceContent(state) },
    edit(from: number, to: number, insert = '', userEvent = 'input.type', isolate = true) {
      dispatch(state.update({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + state.toText(insert).length), userEvent,
        annotations: isolate ? isolateHistory.of('full') : [] }))
    },
    undo: () => undo({ state, dispatch }), redo: () => redo({ state, dispatch }),
    replace(content: string) { clear(); state = planSourceReplacement(state, content).state },
    dispatch,
  }
}

test('opening exact source retains mixed endings and every UTF16 unit', () => {
  const source = '# Review\r\n\ud800before\r中文\n🦀\udc00\r\n'
  const editor = fixture(source)
  expect(editor.state.doc.toString()).toBe('# Review\n\ud800before\n中文\n🦀\udc00\n')
  expect(editor.source).toBe(source)
  expect(undoDepth(editor.state)).toBe(0)
})

test('CM range identity distinguishes deleting either repeated line ending', () => {
  for (const [from, expected] of [[1, 'a\nb'], [2, 'a\r\nb']] as const) {
    const editor = fixture('a\r\n\nb')
    editor.edit(from, from + 1)
    expect(editor.source).toBe(expected)
    expect(editor.undo()).toBe(true)
    expect(editor.source).toBe('a\r\n\nb')
    expect(editor.redo()).toBe(true)
    expect(editor.source).toBe(expected)
  }
})

test('identical repeated-text views retain the selected first or last source range', () => {
  for (const [from, to, expected] of [[0, 2, 'a\na'], [3, 5, 'a\r\na']] as const) {
    const editor = fixture('a\r\na\na')
    editor.edit(from, to)
    expect(editor.state.doc.toString()).toBe('a\na')
    expect(editor.source).toBe(expected)
    editor.undo()
    expect(editor.source).toBe('a\r\na\na')
    editor.redo()
    expect(editor.source).toBe(expected)
  }
})

test('line break insertion undo and redo preserve the original CRLF authority', () => {
  const editor = fixture('a\r\nb')
  editor.edit(1, 1, '\n')
  expect(editor.source).toBe('a\n\r\nb')
  expect(editor.undo()).toBe(true)
  expect(editor.state.doc.toString()).toBe('a\nb')
  expect(editor.source).toBe('a\r\nb')
  expect(editor.redo()).toBe(true)
  expect(editor.state.doc.toString()).toBe('a\n\nb')
  expect(editor.source).toBe('a\n\r\nb')
})

test('mixed CR and CRLF survive authored replacements and their inverse effects', () => {
  const source = '\ud800a\r🦀\r\nb\udc00'
  const editor = fixture(source)
  editor.edit(3, 5, '🦁')
  expect(editor.source).toBe('\ud800a\r🦁\r\nb\udc00')
  editor.edit(2, 3)
  expect(editor.source).toBe('\ud800a🦁\r\nb\udc00')
  editor.undo(); editor.undo()
  expect(editor.source).toBe(source)
  editor.redo(); editor.redo()
  expect(editor.source).toBe('\ud800a🦁\r\nb\udc00')
})

test('composition change ranges share the same exact grouped undo and redo history', () => {
  const editor = fixture('a\r\n\nb')
  editor.edit(1, 2, '中', 'input.type.compose.start', false)
  editor.edit(1, 2, '中文', 'input.type.compose', false)
  expect(editor.source).toBe('a中文\nb')
  expect(undoDepth(editor.state)).toBe(1)
  editor.undo()
  expect(editor.source).toBe('a\r\n\nb')
  editor.redo()
  expect(editor.source).toBe('a中文\nb')
})

test('adjacent grouped edits map ending inverse effects through the same transaction', () => {
  const editor = fixture('a\r\nb\rc')
  editor.edit(1, 2, '', 'delete.backward', false)
  editor.edit(1, 2, '', 'delete.backward', false)
  editor.edit(1, 2, '', 'delete.backward', false)
  expect(editor.source).toBe('ac')
  expect(undoDepth(editor.state)).toBe(1)
  editor.undo()
  expect(editor.source).toBe('a\r\nb\rc')
  editor.redo()
  expect(editor.source).toBe('ac')
})

test('authoritative replacement clears undo redo and old source provenance', () => {
  const editor = fixture('a\r\nb')
  editor.edit(1, 1, '\n')
  editor.undo()
  expect(redoDepth(editor.state)).toBe(1)
  editor.replace('new\rold\r\n\ud800')
  expect(editor.source).toBe('new\rold\r\n\ud800')
  expect(undoDepth(editor.state)).toBe(0)
  expect(redoDepth(editor.state)).toBe(0)
  expect(editor.undo()).toBe(false)
  expect(editor.redo()).toBe(false)
})

test('history count and payload limits retain exact current content without lossy undo fallback', () => {
  const count = fixture('a\r\nb', 2)
  count.edit(1, 1, '1'); count.edit(2, 2, '2'); count.edit(3, 3, '3')
  expect(count.source).toBe('a123\r\nb')
  expect(undoDepth(count.state)).toBe(0)
  expect(redoDepth(count.state)).toBe(0)
  expect(count.undo()).toBe(false)
  count.edit(4, 4, '4')
  expect(count.undo()).toBe(true)
  expect(count.source).toBe('a123\r\nb')
  const bytes = fixture('a\r\nb', 128, 300)
  bytes.edit(1, 1, 'x'.repeat(100))
  expect(bytes.source).toBe('a' + 'x'.repeat(100) + '\r\nb')
  expect(undoDepth(bytes.state)).toBe(0)
  expect(bytes.undo()).toBe(false)
})

test('read-only commands do not mutate source or history', () => {
  const editor = fixture('a\r\nb')
  editor.edit(1, 1, 'x')
  const before = editor.source
  const state = editor.state.update({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) }).state
  let writes = 0
  expect(undo({ state, dispatch: () => { writes++ } })).toBe(false)
  expect(writes).toBe(0)
  expect(planSourceContent(state)).toBe(before)
})


test('raw programmatic insertion preserves CR CRLF and surrogate units through undo redo', () => {
  const editor = fixture('a\r\nb')
  const inserted = '\ud800\r🦀\r\n\udc00'
  editor.dispatch(planSourceInsertion(editor.state, 1, 1, inserted))
  expect(editor.source).toBe('a' + inserted + '\r\nb')
  editor.undo()
  expect(editor.source).toBe('a\r\nb')
  editor.redo()
  expect(editor.source).toBe('a' + inserted + '\r\nb')
})

test('the real clipboard filter and source transaction preserve source before CM normalization', () => {
  const clipboard = new PlanSourceInput().extension()
  const budget = new PlanSourceHistory()
  let state = createPlanSourceState('a\r\nb', [budget.extension(), clipboard])
  const raw = '\ud800\r🦀\r\n\udc00'
  for (const filter of state.facet(EditorView.clipboardInputFilter)) expect(filter(raw, state)).toBe(raw)
  state = state.update({ changes: { from: 1, insert: raw }, userEvent: 'input.paste' }).state
  expect(planSourceContent(state)).toBe('a' + raw + '\r\nb')
  undo({ state, dispatch: transaction => { state = transaction.state } })
  expect(planSourceContent(state)).toBe('a\r\nb')
  redo({ state, dispatch: transaction => { state = transaction.state } })
  expect(planSourceContent(state)).toBe('a' + raw + '\r\nb')
})

test('clipboard metadata is single use and cannot attach to a newer authority or unrelated edit', () => {
  const clipboard = new PlanSourceInput().extension()
  let state = createPlanSourceState('a\r\nb', clipboard)
  const capture = () => { for (const filter of state.facet(EditorView.clipboardInputFilter)) filter('x\ry', state) }
  capture()
  state = state.update({ selection: { anchor: 1 } }).state
  state = state.update({ changes: { from: 1, insert: 'x\ny' }, userEvent: 'input.paste' }).state
  expect(planSourceContent(state)).toBe('ax\ny\r\nb')
  capture()
  state = state.update({ changes: { from: 0, insert: 'x\ny' }, userEvent: 'input.type' }).state
  expect(planSourceContent(state)).toBe('x\nyax\ny\r\nb')
})


test('native raw input metadata applies its exact anchored span even when CM minimizes the change', () => {
  const input = new PlanSourceInput()
  let state = createPlanSourceState('a\r\na\na', input.extension())
  input.captureNative(state, 0, 2, 'a\ra\r\n')
  // The browser and CM may omit the shared prefix from their actual change range.
  state = state.update({ changes: { from: 2, insert: 'a\n' }, userEvent: 'input.type' }).state
  expect(planSourceContent(state)).toBe('a\ra\r\na\na')
})

test('native composition raw spans and their exact inverses use CM history without a value-search journal', () => {
  const input = new PlanSourceInput(), budget = new PlanSourceHistory()
  let state = createPlanSourceState('a\r\nb', [input.extension(), budget.extension()])
  input.captureNative(state, 1, 2, '中\r文')
  state = state.update({ changes: { from: 1, to: 2, insert: '中\n文' }, userEvent: 'input.type.compose' }).state
  expect(planSourceContent(state)).toBe('a中\r文b')
  undo({ state, dispatch: transaction => { state = transaction.state } })
  expect(planSourceContent(state)).toBe('a\r\nb')
  redo({ state, dispatch: transaction => { state = transaction.state } })
  expect(planSourceContent(state)).toBe('a中\r文b')
})

test('mismatched raw native input and a read-only late input cannot overwrite exact authority', () => {
  const input = new PlanSourceInput()
  let state = createPlanSourceState('a\r\nb', input.extension())
  input.captureNative(state, 1, 1, '\r')
  state = state.update({ changes: { from: 0, insert: 'wrong' }, userEvent: 'input.type' }).state
  expect(planSourceContent(state)).toBe('a\r\nb')
  state = state.update({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) }).state
  state = state.update({ changes: { from: 1, insert: 'late' }, userEvent: 'input.type' }).state
  expect(planSourceContent(state)).toBe('a\r\nb')
})

test('an authoritative replacement retires a pending native span even when its displayed view is identical', () => {
  const input = new PlanSourceInput()
  let state = createPlanSourceState('a\r\nb', input.extension())
  input.captureNative(state, 1, 1, '\r')
  state = planSourceReplacement(state, 'a\rb').state
  expect(planSourceContent(state)).toBe('a\rb')
  state = state.update({ changes: { from: 0, insert: 'X' }, userEvent: 'input.type' }).state
  expect(planSourceContent(state)).toBe('Xa\rb')
})

test('mixed CR and CRLF with identical views retain the actual deleted ending identity', () => {
  for (const [from, expected] of [[1, 'a\r\nb'], [2, 'a\rb']] as const) {
    const editor = fixture('a\r\r\nb')
    editor.edit(from, from + 1)
    expect(editor.source).toBe(expected)
    editor.undo()
    expect(editor.source).toBe('a\r\r\nb')
    editor.redo()
    expect(editor.source).toBe(expected)
  }
})

test('full source replacement and boundary insertions retain authored and untouched UTF16 controls', () => {
  const editor = fixture('🦀\r\n\ud800')
  editor.edit(0, 2, '🦁')
  expect(editor.source).toBe('🦁\r\n\ud800')
  editor.dispatch(planSourceInsertion(editor.state, 0, editor.state.doc.length, '\udc00\r新\r\n'))
  expect(editor.source).toBe('\udc00\r新\r\n')
  editor.undo()
  expect(editor.source).toBe('🦁\r\n\ud800')
  editor.undo()
  expect(editor.source).toBe('🦀\r\n\ud800')
})

test('many untouched source endings do not consume the retained edit payload budget', () => {
  const source = 'x\r\n'.repeat(1000), editor = fixture(source, 128, 1024)
  editor.edit(0, 0, 'a')
  expect(undoDepth(editor.state)).toBe(1)
  expect(editor.undo()).toBe(true)
  expect(editor.source).toBe(source)
})

test('a composition replacement with an unchanged displayed value still has exact effect-only undo redo', () => {
  const input = new PlanSourceInput(), budget = new PlanSourceHistory()
  let state = createPlanSourceState('a\r\nb', [input.extension(), budget.extension()])
  input.captureNative(state, 1, 2, '\r', 'insertCompositionText')
  const transaction = input.finishUnchangedNative(state)
  expect(transaction?.docChanged).toBe(false)
  expect(transaction).toBeDefined()
  expect(planSourceChanged(transaction!)).toBe(true)
  state = transaction!.state
  expect(planSourceContent(state)).toBe('a\rb')
  expect(undoDepth(state)).toBe(1)
  undo({ state, dispatch: next => { expect(next.docChanged).toBe(false); expect(planSourceChanged(next)).toBe(true); state = next.state } })
  expect(planSourceContent(state)).toBe('a\r\nb')
  redo({ state, dispatch: next => { expect(next.docChanged).toBe(false); expect(planSourceChanged(next)).toBe(true); state = next.state } })
  expect(planSourceContent(state)).toBe('a\rb')
})

test('invalid native spans and mismatched clipboard ranges refuse mutation without normalizing source', () => {
  const input = new PlanSourceInput()
  let state = createPlanSourceState('a\r\nb', input.extension())
  input.captureNative(state, -1, -1, '\r')
  expect(input.finishUnchangedNative(state)).toBeUndefined()
  state = state.update({ changes: { from: 1, insert: '\n' }, userEvent: 'input.type.compose' }).state
  expect(planSourceContent(state)).toBe('a\r\nb')
  for (const filter of state.facet(EditorView.clipboardInputFilter)) filter('x\ry', state)
  state = state.update({ changes: { from: 1, insert: 'different' }, userEvent: 'input.paste' }).state
  expect(planSourceContent(state)).toBe('a\r\nb')
})

test('effect-only composition endings and preceding composition text share one history transaction', () => {
  const input = new PlanSourceInput(), budget = new PlanSourceHistory()
  let state = createPlanSourceState('a\r\nb', [input.extension(), budget.extension()])
  state = state.update({ changes: { from: 1, insert: '中' }, userEvent: 'input.type.compose.start' }).state
  input.captureNative(state, 2, 3, '\r', 'insertCompositionText')
  state = input.finishUnchangedNative(state)!.state
  expect(planSourceContent(state)).toBe('a中\rb')
  expect(undoDepth(state)).toBe(1)
  undo({ state, dispatch: next => { state = next.state } })
  expect(planSourceContent(state)).toBe('a\r\nb')
  redo({ state, dispatch: next => { state = next.state } })
  expect(planSourceContent(state)).toBe('a中\rb')
})

test('raw boundary joins reparse CR plus LF after deleting the separating character', () => {
  const editor = fixture('\rX\n')
  editor.edit(1, 2)
  expect(editor.source).toBe('\r\n')
  expect(editor.state.doc.toString()).toBe('\n')
  editor.undo()
  expect(editor.source).toBe('\rX\n')
  expect(editor.state.doc.toString()).toBe('\nX\n')
  editor.redo()
  expect(editor.source).toBe('\r\n')
  expect(editor.state.doc.toString()).toBe('\n')
})

test('short raw splice matrix preserves source and normalized view through every range undo and redo', () => {
  const atoms = ['\r', '\n', 'X', '\ud800', '\udc00', '🦀']
  const sources = ['']
  let level = ['']
  for (let depth = 0; depth < 3; depth++) {
    level = level.flatMap(prefix => atoms.map(atom => prefix + atom))
    sources.push(...level)
  }
  const inserts = ['', '\r', '\n', '\r\n', '\rX\n', 'X', '\ud800', '\udc00', '🦀']
  let cases = 0
  for (const source of sources) {
    // The oracle splices raw source at token boundaries; it has no editor provenance or history logic.
    const tokens = source.match(/\r\n|[\s\S]/g) ?? []
    const offsets = [0]
    for (const token of tokens) offsets.push(offsets.at(-1)! + token.length)
    for (let from = 0; from < offsets.length; from++) for (let to = from; to < offsets.length; to++) for (const insert of inserts) {
      const expected = source.slice(0, offsets[from]) + insert + source.slice(offsets[to])
      const budget = new PlanSourceHistory()
      let state = createPlanSourceState(source, budget.extension())
      state = planSourceInsertion(state, from, to, insert).state
      const context = () => JSON.stringify({ source, from, to, insert, expected, actual: planSourceContent(state), view: state.doc.toString() })
      if (planSourceContent(state) !== expected || state.doc.toString() !== expected.replace(/\r\n?/g, '\n')) throw new Error('Raw splice invariant: ' + context())
      if (undoDepth(state)) {
        undo({ state, dispatch: transaction => { state = transaction.state } })
        if (planSourceContent(state) !== source || state.doc.toString() !== source.replace(/\r\n?/g, '\n')) throw new Error('Undo invariant: ' + context())
        redo({ state, dispatch: transaction => { state = transaction.state } })
        if (planSourceContent(state) !== expected || state.doc.toString() !== expected.replace(/\r\n?/g, '\n')) throw new Error('Redo invariant: ' + context())
      } else expect(expected).toBe(source)
      cases++
    }
  }
  expect(cases).toBe(26568)
})

test('raw clipboard and unchanged composition insertions reparse boundary joins in the same history', () => {
  const input = new PlanSourceInput(), budget = new PlanSourceHistory()
  let state = createPlanSourceState('\n', [input.extension(), budget.extension()])
  for (const filter of state.facet(EditorView.clipboardInputFilter)) filter('\r', state)
  state = state.update({ changes: { from: 0, insert: '\r' }, userEvent: 'input.paste' }).state
  expect(planSourceContent(state)).toBe('\r\n')
  expect(state.doc.toString()).toBe('\n')
  undo({ state, dispatch: transaction => { state = transaction.state } })
  expect(planSourceContent(state)).toBe('\n')
  redo({ state, dispatch: transaction => { state = transaction.state } })
  expect(planSourceContent(state)).toBe('\r\n')

  state = createPlanSourceState('\n\n', [input.extension(), new PlanSourceHistory().extension()])
  input.captureNative(state, 0, 1, '\r', 'insertCompositionText')
  state = input.finishUnchangedNative(state)!.state
  expect(planSourceContent(state)).toBe('\r\n')
  expect(state.doc.toString()).toBe('\n')
  undo({ state, dispatch: transaction => { state = transaction.state } })
  expect(planSourceContent(state)).toBe('\n\n')
  expect(state.doc.toString()).toBe('\n\n')
  redo({ state, dispatch: transaction => { state = transaction.state } })
  expect(planSourceContent(state)).toBe('\r\n')
  expect(state.doc.toString()).toBe('\n')
})

test('a CR LF boundary join and its adjacent deletion share exact grouped inverse effects', () => {
  const editor = fixture('\rX\nY')
  editor.edit(1, 2, '', 'delete.forward', false)
  editor.edit(1, 2, '', 'delete.forward', false)
  expect(editor.source).toBe('\r\n')
  expect(editor.state.doc.toString()).toBe('\n')
  expect(undoDepth(editor.state)).toBe(1)
  editor.undo()
  expect(editor.source).toBe('\rX\nY')
  expect(editor.state.doc.toString()).toBe('\nX\nY')
  editor.redo()
  expect(editor.source).toBe('\r\n')
  expect(editor.state.doc.toString()).toBe('\n')
})
