import { Compartment, EditorState } from '@codemirror/state'
import { defaultKeymap, historyKeymap, undo, redo } from '@codemirror/commands'
import { drawSelection, EditorView, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { markdownEditorClassName, markdownPresentationExtension, safeMarkdownHref } from '../workspace-markdown-editor'
import { PlanTableWidget } from './plan-table-editor'
import { resolveImageSrc } from '../markdown'
import { registerOwnedEditControl } from '../composer/contenteditable-control'
import { createPlanSourceState, planSourceContent, PlanSourceInput, planSourceExternal, planSourceChanged, PlanSourceHistory, planSourceReplacement } from './plan-source'

export interface PlanDocumentEditor {
  update(content: string, readOnly: boolean, label: string, cellLabel: string): void
  destroy(): void
}

/** One stable editor and one history own authored ranges, composition, and exact source endings. */
export function createPlanDocumentEditor(options: {
  parent: HTMLElement
  content: string
  sessionId: string
  readOnly: boolean
  label: string
  cellLabel: string
  openLink(href: string): void
  getContent(): string
  onChange(content: string): void
  onSave(): void
}): PlanDocumentEditor {
  const access = new Compartment(), attributes = new Compartment(), boundedHistory = new PlanSourceHistory()
  let readOnly = options.readOnly, label = options.label, cellLabel = options.cellLabel, destroyed = false
  const accessExtension = (value: boolean) => [EditorState.readOnly.of(value), EditorView.editable.of(!value)]
  const labelExtension = (value: string) => EditorView.contentAttributes.of({ 'aria-label': value, 'aria-multiline': 'true', tabindex: '0', spellcheck: 'true' })
  const presentationOptions = { openLink: options.openLink, resolveImageUrl: (href: string) => resolveImageSrc(href, options.sessionId) }
  const view = new EditorView({
    parent: options.parent,
    state: createPlanSourceState(options.content, [
      boundedHistory.extension(), new PlanSourceInput().extension(), drawSelection(), EditorView.lineWrapping, markdown(),
      EditorView.editorAttributes.of({ class: `${markdownEditorClassName} plan-rich-editor` }),
      markdownPresentationExtension({ options: presentationOptions, isReadOnly: () => readOnly, renderedOnly: true,
        tableWidget: spec => new PlanTableWidget(spec, { options: presentationOptions, isReadOnly: () => readOnly, renderedOnly: true }, () => cellLabel, options.onSave) }),
      EditorView.domEventHandlers({ click: event => {
        const anchor = (event.target as Element).closest<HTMLElement>('[data-markdown-href]')
        if (!anchor || (!readOnly && !(event.metaKey || event.ctrlKey))) return false
        const href = safeMarkdownHref(anchor.dataset.markdownHref ?? '')
        if (href) { event.preventDefault(); options.openLink(href) }
        return true
      } }),
      access.of(accessExtension(readOnly)), attributes.of(labelExtension(label)),
      keymap.of([{ key: 'Mod-s', run: () => { if (!readOnly) options.onSave(); return true } }, ...defaultKeymap, ...historyKeymap]),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' }, '.cm-content': { minHeight: '240px' }, '.cm-line': { padding: '0' }, '&.cm-focused': { outline: 'none' } }),
    ]),
    dispatchTransactions(transactions, editor) {
      if (destroyed) return
      // A pending DOM change must not overwrite a newer authoritative controller draft.
      if (transactions.some(transaction => planSourceChanged(transaction) && !transaction.annotation(planSourceExternal)) && options.getContent() !== planSourceContent(editor.state)) {
        boundedHistory.reset(editor)
        editor.update([planSourceReplacement(editor.state, options.getContent())])
        return
      }
      editor.update(transactions)
      if (boundedHistory.observe(transactions, editor.state)) boundedHistory.reset(editor)
      if (transactions.some(transaction => planSourceChanged(transaction) && !transaction.annotation(planSourceExternal))) options.onChange(planSourceContent(editor.state))
    },
  })
  const unregister = registerOwnedEditControl(view.contentDOM, command => readOnly ? false : (command === 'undo' ? undo(view) : redo(view)))
  return {
    update(content, nextReadOnly, nextLabel, nextCellLabel) {
      if (destroyed) return
      if (content !== planSourceContent(view.state)) {
        boundedHistory.reset(view)
        view.update([planSourceReplacement(view.state, content)])
      }
      cellLabel = nextCellLabel
      if (nextReadOnly !== readOnly) { readOnly = nextReadOnly; view.dispatch({ effects: access.reconfigure(accessExtension(readOnly)) }) }
      if (nextLabel !== label) { label = nextLabel; view.dispatch({ effects: attributes.reconfigure(labelExtension(label)) }) }
    },
    destroy() { if (!destroyed) { destroyed = true; unregister(); view.destroy() } },
  }
}
