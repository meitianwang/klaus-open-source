import { Annotation, ChangeSet, Compartment, EditorSelection, EditorState, MapMode, StateEffect, StateField, Transaction, type ChangeDesc, type Extension } from '@codemirror/state'
import { history, invertedEffects, redoDepth, undoDepth } from '@codemirror/commands'
import { EditorView, ViewPlugin } from '@codemirror/view'

type EndingKind = 'cr' | 'crlf'
interface Ending { at: number; kind: EndingKind }
interface EndingPatch { at: number; kind: EndingKind | null }

export const planSourceExternal = Annotation.define<boolean>()

/** The editor displays LF; only non-LF source endings need provenance. */
function splitSource(source: string): { view: string; endings: Ending[] } {
  const endings: Ending[] = []
  let view = '', start = 0
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) !== 13) continue
    view += source.slice(start, i)
    endings.push({ at: view.length, kind: source.charCodeAt(i + 1) === 10 ? 'crlf' : 'cr' })
    view += '\n'
    if (source.charCodeAt(i + 1) === 10) i++
    start = i + 1
  }
  return { view: view + source.slice(start), endings }
}

function mapEndings(endings: readonly Ending[], changes: ChangeDesc): Ending[] {
  const result: Ending[] = []
  for (const ending of endings) {
    const at = changes.mapPos(ending.at, 1, MapMode.TrackAfter)
    if (at !== null) result.push({ at, kind: ending.kind })
  }
  return result
}

const patchEndings = StateEffect.define<readonly EndingPatch[]>({
  map: (patch, changes) => patch.flatMap(ending => {
    const at = changes.mapPos(ending.at, 1, MapMode.TrackAfter)
    return at === null ? [] : [{ at, kind: ending.kind }]
  }),
})
const replaceEndings = StateEffect.define<readonly Ending[]>()

export function planSourceChanged(transaction: Transaction): boolean {
  return transaction.docChanged || transaction.effects.some(effect => effect.is(patchEndings) || effect.is(replaceEndings))
}

function updatedEndings(endings: readonly Ending[], transaction: Transaction): readonly Ending[] {
  if (transaction.changes.empty && !transaction.effects.some(effect => effect.is(replaceEndings) || effect.is(patchEndings))) return endings
  let result = mapEndings(endings, transaction.changes)
  for (const effect of transaction.effects) {
    if (effect.is(replaceEndings)) result = [...effect.value]
    if (effect.is(patchEndings)) {
      const values = new Map(result.map(ending => [ending.at, ending.kind]))
      for (const ending of effect.value) {
        if (ending.kind === null) values.delete(ending.at)
        else values.set(ending.at, ending.kind)
      }
      result = [...values].map(([at, kind]) => ({ at, kind })).sort((a, b) => a.at - b.at)
    }
  }
  return result
}

const sourceEndings = StateField.define<readonly Ending[]>({
  create: () => [],
  update: updatedEndings,
})

function inverseEndings(transaction: Transaction): readonly EndingPatch[] {
  if (transaction.changes.empty && !transaction.effects.some(effect => effect.is(replaceEndings) || effect.is(patchEndings))) return []
  const before = transaction.startState.field(sourceEndings)
  const after = updatedEndings(before, transaction)
  const mappedBack = mapEndings(after, transaction.changes.invertedDesc)
  const expected = new Map(before.map(ending => [ending.at, ending.kind]))
  const actual = new Map(mappedBack.map(ending => [ending.at, ending.kind]))
  const patch: EndingPatch[] = []
  for (const [at, kind] of expected) if (actual.get(at) !== kind) patch.push({ at, kind })
  for (const [at] of actual) if (!expected.has(at)) patch.push({ at, kind: null })
  return patch
}

const sourceHistory = invertedEffects.of(transaction => {
  const patch = inverseEndings(transaction)
  return patch.length ? [patchEndings.of(patch)] : []
})

const normalizeSourceBoundaries = EditorState.transactionFilter.of(transaction => {
  if (!planSourceChanged(transaction)) return transaction
  const endings = updatedEndings(transaction.startState.field(sourceEndings), transaction)
  const kinds = new Map(endings.map(ending => [ending.at, ending.kind]))
  const joins = endings.filter(ending => ending.kind === 'cr' && !kinds.has(ending.at + 1) && transaction.newDoc.sliceString(ending.at + 1, ending.at + 2) === '\n')
  if (!joins.length) return transaction
  // A raw splice can join a former CR and LF into one new CRLF boundary.
  // Compose this source reparse into the same CM change and inverse-effects history.
  const changes = ChangeSet.of(joins.map(ending => ({ from: ending.at + 1, to: ending.at + 2 })), transaction.newDoc.length)
  return [transaction, { changes, selection: transaction.newSelection.map(changes), sequential: true,
    effects: patchEndings.of(joins.map(ending => ({ at: changes.mapPos(ending.at, 1), kind: 'crlf' as const }))) }]
})

export function planSourceContent(state: EditorState): string {
  const view = state.doc.toString()
  let result = '', start = 0
  for (const ending of state.field(sourceEndings)) {
    result += view.slice(start, ending.at) + (ending.kind === 'crlf' ? '\r\n' : '\r')
    start = ending.at + 1
  }
  return result + view.slice(start)
}

export function createPlanSourceState(content: string, extensions: Extension = []): EditorState {
  const source = splitSource(content)
  return EditorState.create({ doc: source.view, extensions: [sourceEndings.init(() => source.endings), sourceHistory, normalizeSourceBoundaries, extensions] })
}

/** Exact programmatic insertion uses an explicit source span, never a normalized value diff. */
export function planSourceInsertion(state: EditorState, from: number, to: number, content: string, userEvent = 'input.paste'): Transaction {
  const source = splitSource(content)
  return state.update({ changes: { from, to, insert: source.view },
    selection: EditorSelection.cursor(from + source.view.length), userEvent,
    effects: source.endings.length ? patchEndings.of(source.endings.map(ending => ({ at: from + ending.at, kind: ending.kind }))) : [] })
}

/** One native/clipboard operation may carry raw endings until its matching CM transaction. */
export class PlanSourceInput {
  private pending: { state: EditorState; view: string; endings: Ending[]; span?: { from: number; to: number }; inputType?: string } | undefined
  private clear = () => { this.pending = undefined }
  captureNative(state: EditorState, from: number, to: number, content: string, inputType?: string): void {
    const source = splitSource(content)
    this.pending = source.endings.length ? { state, ...source, span: { from, to }, inputType } : undefined
  }
  private patches(transaction: Transaction): readonly EndingPatch[] | undefined {
    const source = this.pending
    if (!source || source.state !== transaction.startState) return
    if (source.span) {
      if (!transaction.isUserEvent('input') || source.span.from < 0 || source.span.to < source.span.from || source.span.to > transaction.startState.doc.length) return
      const changes = transaction.startState.changes({ ...source.span, insert: source.view })
      if (!changes.apply(transaction.startState.doc).eq(transaction.newDoc)) return
      const expected = new Map(mapEndings(transaction.startState.field(sourceEndings), changes).map(ending => [ending.at, ending.kind]))
      for (const ending of source.endings) expected.set(source.span.from + ending.at, ending.kind)
      const actual = new Map(mapEndings(transaction.startState.field(sourceEndings), transaction.changes).map(ending => [ending.at, ending.kind]))
      const result: EndingPatch[] = []
      for (const [at, kind] of expected) if (actual.get(at) !== kind) result.push({ at, kind })
      for (const [at] of actual) if (!expected.has(at)) result.push({ at, kind: null })
      return result
    }
    if (!transaction.docChanged || !(transaction.isUserEvent('input.paste') || transaction.isUserEvent('input.drop') || transaction.isUserEvent('move.drop'))) return
    const matches: number[] = []
    transaction.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
      if (inserted.toString() === source.view) matches.push(fromB)
    })
    if (matches.length !== 1) return
    return source.endings.map(ending => ({ at: matches[0] + ending.at, kind: ending.kind }))
  }
  finishUnchangedNative(state: EditorState): Transaction | undefined {
    if (state.readOnly) { this.clear(); return }
    const source = this.pending
    if (!source?.span || source.state !== state || source.span.from < 0 || source.span.to < source.span.from || source.span.to > state.doc.length) return
    const intent = state.changes({ ...source.span, insert: source.view })
    if (!intent.apply(state.doc).eq(state.doc)) return
    const expected = new Map(mapEndings(state.field(sourceEndings), intent).map(ending => [ending.at, ending.kind]))
    for (const ending of source.endings) expected.set(source.span.from + ending.at, ending.kind)
    const actual = new Map(state.field(sourceEndings).map(ending => [ending.at, ending.kind]))
    const patches: EndingPatch[] = []
    for (const [at, kind] of expected) if (actual.get(at) !== kind) patches.push({ at, kind })
    for (const [at] of actual) if (!expected.has(at)) patches.push({ at, kind: null })
    if (!patches?.length) return
    this.clear()
    return state.update({ effects: patchEndings.of(patches), userEvent: 'input.type.compose' })
  }
  extension(): Extension {
    return [
      EditorView.clipboardInputFilter.of((content, state) => {
        const source = splitSource(content)
        this.pending = source.endings.length ? { state, ...source } : undefined
        return content
      }),
      EditorView.domEventHandlers({
        beforeinput: (event, view) => {
          if (view.state.readOnly) { this.clear(); return false }
          if (event.data?.includes('\r') && event.inputType.startsWith('insert')) {
            let { from, to } = view.state.selection.main
            const targets = event.getTargetRanges()
            if (targets.length === 1) {
              try { from = view.posAtDOM(targets[0].startContainer, targets[0].startOffset); to = view.posAtDOM(targets[0].endContainer, targets[0].endOffset) }
              catch { this.captureNative(view.state, -1, -1, event.data, event.inputType); if (event.cancelable) { event.preventDefault(); this.clear(); return true }; return false }
            }
            if (event.cancelable && !event.isComposing) {
              event.preventDefault()
              this.clear()
              view.dispatch(planSourceInsertion(view.state, from, to, event.data, event.inputType.includes('Composition') ? 'input.type.compose' : 'input.type'))
              return true
            }
            this.captureNative(view.state, from, to, event.data, event.inputType)
          } else if (this.pending?.span) this.clear()
          return false
        },
        input: (event, view) => {
          const input = event as InputEvent
          if (view.state.readOnly) { this.clear(); return false }
          if (this.pending?.inputType && this.pending.inputType !== input.inputType) { this.clear(); return false }
          const transaction = this.finishUnchangedNative(view.state)
          if (transaction) view.dispatch(transaction)
          return false
        },
        blur: this.clear,
      }),
      EditorState.transactionFilter.of(transaction => {
        const source = this.pending, patches = this.patches(transaction)
        this.clear()
        if (transaction.docChanged && transaction.startState.readOnly && !transaction.annotation(planSourceExternal)) return []
        // Refuse a stale or mismatched raw operation rather than normalizing its source silently.
        if (source && transaction.docChanged && !transaction.annotation(planSourceExternal) && (source.span || transaction.isUserEvent('input.paste') || transaction.isUserEvent('input.drop') || transaction.isUserEvent('move.drop')) && patches === undefined) return []
        return patches?.length ? [transaction, { effects: patchEndings.of(patches), sequential: true }] : transaction
      }),
      // History transactions may bypass filters, but must still retire stale native input.
      EditorState.transactionExtender.of(() => { this.clear(); return null }),
      ViewPlugin.define(() => ({ destroy: this.clear })),
    ]
  }
}

/** Replace authoritative content without turning a reload or Revert into an authored edit. */
export function planSourceReplacement(state: EditorState, content: string): Transaction {
  const source = splitSource(content), previous = state.doc.toString()
  let from = 0, suffix = 0
  while (from < previous.length && from < source.view.length && previous.charCodeAt(from) === source.view.charCodeAt(from)) from++
  while (suffix < previous.length - from && suffix < source.view.length - from && previous.charCodeAt(previous.length - suffix - 1) === source.view.charCodeAt(source.view.length - suffix - 1)) suffix++
  return state.update({
    changes: { from, to: previous.length - suffix, insert: source.view.slice(from, source.view.length - suffix) },
    effects: replaceEndings.of(source.endings),
    annotations: [planSourceExternal.of(true), Transaction.addToHistory.of(false)],
  })
}

/** History owns both text and inverse ending effects, with an explicit finite retention boundary. */
export class PlanSourceHistory {
  readonly compartment = new Compartment()
  private bytes = 0
  constructor(readonly maxEvents = 128, readonly maxBytes = 1024 * 1024) {}
  extension(): Extension { return this.compartment.of(history({ minDepth: this.maxEvents })) }
  private history(): Extension { return history({ minDepth: this.maxEvents }) }
  observe(transactions: readonly Transaction[], state: EditorState): boolean {
    for (const transaction of transactions) {
      if (transaction.annotation(planSourceExternal)) continue
      if (planSourceChanged(transaction) || transaction.selection) this.bytes += 256
      transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => { this.bytes += 256 + 4 * (toA - fromA + toB - fromB) })
      // Count both forward and inverse metadata conservatively, including grouped composition edits.
      this.bytes += inverseEndings(transaction).length * 128
      for (const effect of transaction.effects) if (effect.is(patchEndings)) this.bytes += effect.value.length * 128
    }
    return this.bytes >= this.maxBytes || undoDepth(state) + redoDepth(state) > this.maxEvents
  }
  reset(view: { state: EditorState; update(transactions: readonly Transaction[]): void }): void {
    this.bytes = 0
    view.update([view.state.update({ effects: this.compartment.reconfigure([]) })])
    view.update([view.state.update({ effects: this.compartment.reconfigure(this.history()) })])
  }
}
