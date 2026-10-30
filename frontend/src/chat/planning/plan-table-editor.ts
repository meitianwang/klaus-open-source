import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { defaultKeymap, undo, redo } from '@codemirror/commands'
import { EditorView, keymap, WidgetType } from '@codemirror/view'
import { registerOwnedEditControl } from '../composer/contenteditable-control'
import { markdownPresentationExtension, type MarkdownPresentation, type MarkdownPresentationContext } from '../workspace-markdown-editor'
import { planSourceInsertion } from './plan-source'
import { planTableCells, planTableInput, type PlanTableCell } from './plan-table'

interface CellEditor { range: PlanTableCell; view: EditorView; access: Compartment; unregister(): void }
interface TableEditor { update(spec: MarkdownPresentation): boolean; destroy(): void }
const tables = new WeakMap<HTMLElement, TableEditor>()

/** Each rendered cell edits a source range in the containing document's one undo history. */
export class PlanTableWidget extends WidgetType {
  private readonly readOnly: boolean
  private readonly cellLabel: string
  constructor(readonly spec: MarkdownPresentation, readonly context: MarkdownPresentationContext, readonly label: () => string, readonly save: () => void) {
    super()
    this.readOnly = context.isReadOnly()
    this.cellLabel = label()
  }
  eq(other: PlanTableWidget) { return JSON.stringify(this.spec) === JSON.stringify(other.spec) && this.readOnly === other.readOnly && this.cellLabel === other.cellLabel }
  toDOM(parent: EditorView) {
    const root = document.createElement('div')
    root.className = 'planning-table'
    root.dataset.markdownWidget = 'table'
    root.contentEditable = 'false'
    const table = root.appendChild(document.createElement('table'))
    const head = table.appendChild(document.createElement('thead'))
    const body = table.appendChild(document.createElement('tbody'))
    const cells: CellEditor[][] = []
    let currentSpec = this.spec
    const access = (value: boolean) => [EditorState.readOnly.of(value), EditorView.editable.of(!value)]
    const focusCell = (row: number, column: number) => {
      const flat = cells.flat(), index = flat.indexOf(cells[row][column]), next = flat[index + 1]
      if (next) next.view.focus()
      else { parent.dispatch({ selection: EditorSelection.cursor(currentSpec.to) }); parent.focus() }
    }
    const initial = planTableCells(parent.state.doc.toString(), 0, this.spec.from)
    initial.forEach((row, rowIndex) => {
      const tr = (rowIndex ? body : head).appendChild(document.createElement('tr'))
      cells[rowIndex] = []
      row.forEach((range, column) => {
        const td = tr.appendChild(document.createElement(rowIndex ? 'td' : 'th'))
        const compartment = new Compartment()
        const current: CellEditor = { range, access: compartment, view: null!, unregister() {} }
        const view = new EditorView({ parent: td, state: EditorState.create({ doc: range.content, extensions: [
          compartment.of(access(this.context.isReadOnly())), EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': this.label().replace('{row}', String(rowIndex + 1)).replace('{column}', String(column + 1)), spellcheck: 'true' }),
          markdownPresentationExtension({ options: this.context.options, isReadOnly: this.context.isReadOnly, renderedOnly: true }),
          EditorView.clipboardInputFilter.of(planTableInput),
          keymap.of([
            { key: 'Mod-z', run: () => parent.state.readOnly ? false : undo(parent) },
            { key: 'Mod-Shift-z', run: () => parent.state.readOnly ? false : redo(parent) },
            { key: 'Mod-y', run: () => parent.state.readOnly ? false : redo(parent) },
            { key: 'Mod-s', run: () => { this.save(); return true } },
            { key: 'Enter', run: () => { focusCell(rowIndex, column); return true } },
            { key: 'Tab', run: () => { focusCell(rowIndex, column); return true }, shift: () => {
              const flat = cells.flat(), previous = flat[flat.indexOf(current) - 1]
              if (!previous) return false
              previous.view.focus(); return true
            } }, ...defaultKeymap,
          ]),
          EditorView.inputHandler.of((editor, from, to, text) => {
            const safe = planTableInput(text)
            if (safe === text) return false
            editor.dispatch({ changes: { from, to, insert: safe }, selection: EditorSelection.cursor(from + safe.length), userEvent: 'input.type' })
            return true
          }),
          EditorView.theme({ '&': { backgroundColor: 'transparent' }, '.cm-scroller': { fontFamily: 'inherit', overflow: 'hidden' }, '.cm-content': { padding: '0', minHeight: '1.65em' }, '.cm-line': { padding: '0' }, '&.cm-focused': { outline: 'none' } }),
        ] }), dispatchTransactions(transactions, editor) {
          const changed = transactions.some(transaction => transaction.docChanged)
          if (changed && (parent.state.readOnly || parent.state.doc.sliceString(current.range.from, current.range.to) !== current.range.content)) return
          editor.update(transactions)
          if (changed) parent.dispatch(planSourceInsertion(parent.state, current.range.from, current.range.to, editor.state.doc.toString(), 'input.table'))
        } })
        current.view = view
        current.unregister = registerOwnedEditControl(view.contentDOM, command => parent.state.readOnly ? false : command === 'undo' ? undo(parent) : redo(parent))
        cells[rowIndex].push(current)
      })
    })
    tables.set(root, {
      update: spec => {
        currentSpec = spec
        const next = planTableCells(parent.state.doc.toString(), 0, spec.from)
        if (next.length !== cells.length || next.some((row, i) => row.length !== cells[i].length)) return false
        next.forEach((row, i) => row.forEach((range, j) => {
          const cell = cells[i][j]
          cell.range = range
          if (cell.view.state.doc.toString() !== range.content) cell.view.update([cell.view.state.update({ changes: { from: 0, to: cell.view.state.doc.length, insert: range.content }, annotations: Transaction.addToHistory.of(false) })])
          const readOnly = this.context.isReadOnly()
          if (cell.view.state.readOnly !== readOnly) cell.view.dispatch({ effects: cell.access.reconfigure(access(readOnly)) })
          cell.view.contentDOM.setAttribute('aria-label', this.label().replace('{row}', String(i + 1)).replace('{column}', String(j + 1)))
        }))
        return true
      },
      destroy() { cells.flat().forEach(cell => { cell.unregister(); cell.view.destroy() }); tables.delete(root) },
    })
    return root
  }
  updateDOM(dom: HTMLElement) { return tables.get(dom)?.update(this.spec) ?? false }
  destroy(dom: HTMLElement) { tables.get(dom)?.destroy() }
  ignoreEvent() { return true }
}
