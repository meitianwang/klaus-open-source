import { Fragment, Slice, type Node as DocumentNode } from 'prosemirror-model'
import { EditorState, Plugin, Selection, TextSelection, type Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { closeHistory, history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, chainCommands, createParagraphNear, exitCode, liftEmptyBlock, splitBlock, toggleMark } from 'prosemirror-commands'
import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules'
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list'
import type { ComposerEditCommand, ComposerTextControl, ContenteditableToken } from './contenteditable-control'
import type { InlineTokenSnapshot } from './inline-token'
import { composerDocumentFromText, composerDocumentSchema as schema, composerDocumentText,
  restoreComposerDocument, serializeComposerDocument, snapshotComposerDocument } from './document-model'
import { projectComposerDocument } from './document-projection'
import { isLargePastedText } from './pasted-text'
import { composerQueryInDocument, type ComposerQuery } from './composer-query'
import { codeArrow, codeNewline, indentCode, leaveCode, selectCode } from './code-keys'
import { pastedQuoteIdentities } from './clipboard-identities'
import { composerTokenClipboardText } from './clipboard-token-text'
import { normalizeComposerReferences } from './reference-token'
import { copiedQuoteDrop } from './copied-quote-drop'
import { clipboardHasRichContent, clipboardHtmlLimit, clipboardSelectionUrl, normalizeClipboardHtml } from './clipboard-html'
import { convertTypedTable, pasteDocumentSlice } from './table-commands'
import { deferComposerApplicationKey } from './composer-key-routing'
import { clipboardLinkFallback } from './clipboard-link-budget'
import { clipboardAttachmentText } from './clipboard-attachment-text'
import './document-control.css'

type TokenResolver = (value: string) => ContenteditableToken[]
type RestoreTokens = (value: string, tokens: InlineTokenSnapshot[]) => void

function inlineContent(value: string, tokens: InlineTokenSnapshot[] = []): Fragment {
  return composerDocumentFromText(value, tokens).firstChild!.content
}

function tokenIdentity(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return JSON.stringify(data)
  const identity = { ...data } as Record<string, unknown>
  for (const field of ['range', 'requestOffset', 'composerOffset', 'displayOrder']) delete identity[field]
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sorted(entry)])) : value
  return JSON.stringify(sorted(identity))
}

/** A single document owns native edits, formatting, inline identities and history. */
export function installDocumentControl(root: HTMLElement, resolveTokens: TokenResolver,
  restoreTokens: RestoreTokens | undefined,
  register: (root: HTMLElement, apply: (command: ComposerEditCommand) => boolean, destroy: () => void) => void,
  onLongPaste?: (text: string) => boolean,
): ComposerTextControl {
  const initial = root.textContent || ''
  root.replaceChildren()
  root.dataset.klausDocumentControl = '1'
  let revision = 0, silent = false, emittingInput = false, shiftHeld = false, nativePlainPaste = false, mediaFallback = false
  let documentGeneration = 0, compositionGeneration = 0, compositionSequence = 0, finalizedComposition = 0
  const documentLifetime = crypto.randomUUID()
  const advanceRevision = () => { root.dataset.klausDocumentRevision = `${documentLifetime}:${++revision}` }
  advanceRevision()
  let view: EditorView
  let dismissedQuery: { prefix: ComposerQuery['prefix']; position: number } | null = null
  let continuedQuery: { prefix: ComposerQuery['prefix']; position: number } | null = null
  const emitInput = (inputType = 'insertText', data: string | null = null) => {
    if (!view.composing) finalizedComposition = compositionSequence
    emittingInput = true
    try { root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data, isComposing: view.composing })) }
    finally { emittingInput = false }
  }
  const syncTokens = (document: DocumentNode) => {
    const projection = projectComposerDocument(document)
    restoreTokens?.(projection.text, projection.tokens)
  }
  const dispatch = (transaction: Transaction) => {
    const previous = view.state
    const result = previous.applyTransaction(transaction)
    if (continuedQuery) {
      for (const applied of result.transactions) {
        const mapped = applied.mapping.mapResult(continuedQuery.position, 1)
        if (mapped.deleted) { continuedQuery = null; break }
        continuedQuery.position = mapped.pos
      }
    }
    if (dismissedQuery) {
      for (const applied of result.transactions) {
        const mapped = applied.mapping.mapResult(dismissedQuery.position, 1)
        if (mapped.deleted) { dismissedQuery = null; break }
        dismissedQuery.position = mapped.pos
      }
    }
    const changed = result.transactions.some(entry => entry.docChanged)
    if (changed) {
      advanceRevision()
      syncTokens(result.state.doc)
    }
    view.updateState(result.state)
    if (changed && !silent) {
      const before = composerDocumentText(previous.doc), after = composerDocumentText(result.state.doc)
      let start = 0, oldEnd = before.length, newEnd = after.length
      while (start < oldEnd && start < newEnd && before[start] === after[start]) start++
      while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
      const inputType = transaction.getMeta('inputType') || (transaction.getMeta('uiEvent') === 'paste' ? 'insertFromPaste' : 'insertText')
      emitInput(String(inputType), after.slice(start, newEnd) || null)
    }
    else if (!silent && !previous.selection.eq(result.state.selection)) root.dispatchEvent(new Event('select'))
  }
  const paragraphBreak = chainCommands(codeNewline, createParagraphNear, liftEmptyBlock, splitBlock)
  const insertBreak: import('prosemirror-state').Command = (state, send) => {
    if (send) send(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView())
    return true
  }
  const softBreak = chainCommands(paragraphBreak, insertBreak)
  const appleKeyboard = /Mac|iP(?:ad|hone|od)/.test(root.ownerDocument.defaultView?.navigator.platform || '')
  const listEnter = (state: EditorState, send?: (transaction: Transaction) => void) => {
    const inList = Array.from({ length: state.selection.$from.depth }, (_, index) => state.selection.$from.node(index + 1))
      .some(node => node.type === schema.nodes.list_item)
    return inList && splitListItem(schema.nodes.list_item)(state, send)
  }
  const keys = { ...baseKeymap }
  delete keys.Enter
  const plugins = [history({ depth: 100, newGroupDelay: 500 }), keymap({
    'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
    'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em),
    'Mod-`': toggleMark(schema.marks.code), 'Mod-Shift-x': toggleMark(schema.marks.strike),
    'Shift-Enter': softBreak, 'Alt-Enter': paragraphBreak,
    ...(appleKeyboard ? { 'Ctrl-Enter': chainCommands(exitCode, insertBreak) } : {}),
    'Mod-Enter': leaveCode, 'Mod-a': selectCode, ArrowUp: codeArrow(-1), ArrowDown: codeArrow(1),
    Enter: chainCommands(convertTypedTable, listEnter), Tab: chainCommands(indentCode(false), sinkListItem(schema.nodes.list_item)),
    'Shift-Tab': chainCommands(indentCode(true), liftListItem(schema.nodes.list_item)),
  }), keymap(keys), inputRules({ rules: [
    textblockTypeInputRule(/^```([\w-]+)?\s$/, schema.nodes.code_block, match => ({ params: match[1] || '' })),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
    wrappingInputRule(/^\s*(\d+)\.\s$/, schema.nodes.ordered_list, match => ({ order: Number(match[1]) }),
      (match, node) => node.childCount + node.attrs.order === Number(match[1])),
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
  ] }), new Plugin({ props: { handleKeyDown(editor, event) {
    if (editor.editable) deferComposerApplicationKey(event)
    return false
  } } })]
  const paste = (editor: EditorView, event: ClipboardEvent, slice: Slice, forcePlain = false) => {
    if (!editor.editable) return true
    const preferPlain = forcePlain || shiftHeld || nativePlainPaste
    const importedMedia = mediaFallback
    nativePlainPaste = false
    mediaFallback = false
    const rawText = event.clipboardData?.getData('text/plain') || event.clipboardData?.getData('text/uri-list') || ''
    let text = rawText.replace(/\r\n?/g, '\n')
    const { selection, storedMarks } = view.state
    if (isLargePastedText(rawText) && onLongPaste) {
      const attachment = preferPlain || selection.$from.parent.type.spec.code ? rawText
        : clipboardAttachmentText(slice, rawText, event.clipboardData?.getData('text/html') || '')
      if (onLongPaste(attachment) === true) return true
    }
    if ((!text && (preferPlain || selection.$from.parent.type.spec.code)) || !text && slice.content.size === 0) return true
    if (selection.$from.parent.type.spec.code) {
      dispatch(closeHistory(view.state.tr.insertText(text.replace(/\n+$/, ''))).setMeta('inputType', 'insertFromPaste').scrollIntoView())
      return true
    }
    let inlineCode = false
    if (selection.$from.sameParent(selection.$to)) {
      if (selection.empty) inlineCode = !!schema.marks.code.isInSet(storedMarks || selection.$from.marks())
      else {
        let sawInline = false, allCode = true
        view.state.doc.nodesBetween(selection.from, selection.to, node => {
          if (!node.isInline) return true
          sawInline = true
          if (!schema.marks.code.isInSet(node.marks)) allCode = false
          return false
        })
        inlineCode = sawInline && allCode
      }
    }
    if (!text && inlineCode) return true
    const url = clipboardSelectionUrl(text)
    if (!preferPlain && !inlineCode && url && !selection.empty) {
      let prose = false, atom = false
      selection.content().content.descendants(node => {
        if (node.isText) prose ||= !!node.text?.trim()
        else if (node.isInline) atom = true
      })
      if (prose && !atom) {
        const transaction = view.state.tr.addMark(selection.from, selection.to, schema.marks.link.create({ href: url, title: null }))
        transaction.setSelection(Selection.near(transaction.doc.resolve(selection.to), -1))
        dispatch(closeHistory(transaction))
        return true
      }
    }
    if (event.clipboardData?.getData('text/html') && !preferPlain && !inlineCode && slice.content.size > 0
      && (!text || importedMedia || clipboardHasRichContent(slice))) {
      const fallback = clipboardLinkFallback(slice, rawText)
      if (fallback === null) {
        dispatch(closeHistory(pasteDocumentSlice(editor.state, pastedQuoteIdentities(slice, editor.state)).setMeta('uiEvent', 'paste').scrollIntoView()))
        return true
      }
      text = fallback.replace(/\r\n?/g, '\n')
    }
    const marks = storedMarks || (selection.empty ? selection.$from.marks() : selection.$from.marksAcross(selection.$to)) || []
    // A typed reference link carries its full identity in plain text, so a
    // plain paste restores the chip instead of leaving the link as editable
    // prose. Code contexts keep pasted text literal.
    const tokens = inlineCode ? [] : normalizeComposerReferences(text, [])
      .map(reference => ({ start: reference.range.start, end: reference.range.end, value: reference.value, data: reference }))
    const content: DocumentNode[] = []
    inlineContent(text, tokens).forEach(node => content.push(node.mark(marks)))
    dispatch(closeHistory(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(content), 0, 0)).scrollIntoView()).setMeta('inputType', 'insertFromPaste'))
    return true
  }
  view = new EditorView({ mount: root }, {
    state: EditorState.create({ doc: composerDocumentFromText(initial), plugins }),
    dispatchTransaction: dispatch,
    attributes: { role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true', dir: 'auto', tabindex: '0' },
    nodeViews: { composer_token(node) {
      const projection = projectComposerDocument(view.state.doc)
      const candidates = resolveTokens(projection.text)
      const token = candidates.find(candidate => candidate.value === node.attrs.value
        && tokenIdentity(candidate.data ?? null) === tokenIdentity(node.attrs.data ?? null))
        || candidates.find(candidate => candidate.value === node.attrs.value)
      const dom = token?.element || root.ownerDocument.createElement('span')
      if (!token) { dom.className = 'composer-reference-token'; dom.textContent = node.attrs.label }
      dom.contentEditable = 'false'
      dom.setAttribute('data-klaus-composer-token-value', node.attrs.value)
      return { dom, ignoreMutation: () => true, stopEvent: event => event.type === 'click' && (event.target as Element)?.closest('button') !== null }
    } },
    handleDOMEvents: {
      compositionstart() { compositionGeneration = documentGeneration; compositionSequence++; return false },
      compositionend() {
        const generation = compositionGeneration, sequence = ++compositionSequence
        // Let the view finish composition and flush its pending DOM records.
        // A final unchanged candidate still needs one committed input notification.
        queueMicrotask(() => queueMicrotask(() => {
          if (generation !== documentGeneration || sequence !== compositionSequence || finalizedComposition === sequence
            || view.isDestroyed || !view.editable || view.composing || !root.isConnected) return
          emitInput('insertCompositionText')
        }))
        return false
      },
      drop(_view, rawEvent) {
        const data = (rawEvent as DragEvent).dataTransfer
        // Leave file transfers unconsumed for the host-owned attachment route.
        // Otherwise a companion URI or HTML payload can become editor text.
        return !!data && (data.files.length > 0 || Array.from(data.types).includes('Files'))
      },
      keydown(_view, rawEvent) {
        const event = rawEvent as KeyboardEvent
        shiftHeld = event.shiftKey && event.key !== 'Insert'
        if (event.isComposing || view.composing || event.keyCode === 229) {
          // The native input method owns this key, including its default action.
          event.stopImmediatePropagation()
          return true
        }
        return false
      },
      keyup(_view, rawEvent) {
        const event = rawEvent as KeyboardEvent
        shiftHeld = event.shiftKey && event.key !== 'Insert'
        return false
      },
      mousedown(_view, rawEvent) { shiftHeld = (rawEvent as MouseEvent).shiftKey; return false },
      blur() { shiftHeld = false; nativePlainPaste = false; return false },
      beforeinput(_view, event) {
        // Native editing is observed by the view; outer handlers receive only
        // the resulting transaction, never an intermediate DOM mutation.
        event.stopImmediatePropagation()
        return false
      },
      input(_view, event) {
        if (!emittingInput) event.stopImmediatePropagation()
        return false
      },
      paste(editor, event) {
        mediaFallback = false
        if (!editor.editable) { event.preventDefault(); return true }
        const data = (event as ClipboardEvent).clipboardData
        if (!data) return true
        const text = data.getData('text/plain') || data.getData('text/uri-list'), html = data.getData('text/html')
        // Attachment ingestion belongs to the existing host-owned tray.
        const delegated = data.files.length > 0 || Array.from(data.types).some(type => /files?/i.test(type))
          || (!text && !html)
        if (delegated) { nativePlainPaste = false; return true }
        if (html.length > clipboardHtmlLimit(root.ownerDocument, html)) {
          event.preventDefault()
          return paste(editor, event as ClipboardEvent, Slice.empty, true)
        }
        return false
      },
    },
    clipboardTextSerializer: slice => composerDocumentText(schema.nodes.doc.create(null, slice.content), composerTokenClipboardText),
    handlePaste: paste,
    handleDrop(editor, event, slice, moved) {
      if (moved || event.dataTransfer?.files.length) return false
      const position = editor.posAtCoords({ left: event.clientX, top: event.clientY })
      if (!position) return false
      const transaction = copiedQuoteDrop(editor.state, slice, position.pos)
      if (!transaction) return false
      editor.focus()
      dispatch(transaction)
      return true
    },
    transformPastedText(text, plain) { nativePlainPaste = plain; return text },
    transformPastedHTML(html) {
      nativePlainPaste = false
      const normalized = normalizeClipboardHtml(root.ownerDocument, html)
      mediaFallback = normalized.mediaFallback
      return normalized.html
    },
  })
  const projection = () => projectComposerDocument(view.state.doc)
  const selectionRange = () => {
    const map = projection()
    return { start: map.textOffset(view.state.selection.from, -1), end: map.textOffset(view.state.selection.to, 1) }
  }
  /**
   * Mirror a requested caret into the DOM selection.
   *
   * A selection transaction only reaches the DOM when ProseMirror sees the
   * state selection change while the editor owns the focus. Caret handoffs
   * (quote insertion, draft restore, the deferred focus after a transcript
   * toolbar click) routinely request a caret the state already holds, or
   * request it before the editor is focused, and the browser then keeps the
   * caret it placed itself — the start of the editable, i.e. before an
   * inserted quote pill. The request is authoritative, so write it straight
   * into the DOM selection instead of relying on a state change to carry it.
   */
  const syncDomSelection = (from: number, to: number) => {
    // Only the focused editor owns the document selection: writing it while
    // unfocused would steal a selection the user holds somewhere else (a
    // submitted bubble, the transcript) for a caret the editor merely records.
    if (view.composing || view.isDestroyed || !root.isConnected || !view.hasFocus()) return
    const doc = root.ownerDocument
    const selection = doc.getSelection()
    if (!selection) return
    const anchor = view.domAtPos(from)
    const head = to === from ? anchor : view.domAtPos(to)
    if (selection.rangeCount === 1) {
      const current = selection.getRangeAt(0)
      if (current.startContainer === anchor.node && current.startOffset === anchor.offset
        && current.endContainer === head.node && current.endOffset === head.offset) return
    }
    const range = doc.createRange()
    range.setStart(anchor.node, anchor.offset)
    range.setEnd(head.node, head.offset)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const setSelectionRange = (start: number, end = start) => {
    const map = projection()
    const from = map.documentPosition(start, start === end ? 1 : -1), to = map.documentPosition(end, 1)
    const transaction = view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(from), view.state.doc.resolve(to)))
    const wasSilent = silent
    silent = true
    try { dispatch(transaction) } finally { silent = wasSilent }
    syncDomSelection(from, to)
  }
  const freshTokens = (value: string) => resolveTokens(value).map(({ start, end, value, data }) => ({ start, end, value, data }))
  const refreshTokens = () => {
    const map = projection(), resolved = freshTokens(map.text)
    let transaction = view.state.tr
    let inserted = false
    for (const token of resolved.sort((a, b) => b.start - a.start)) {
      const from = map.documentPosition(token.start, -1), to = map.documentPosition(token.end, 1)
      const current = transaction.doc.nodeAt(from)
      if (map.text.slice(token.start, token.end) !== token.value) continue
      const content = inlineContent(token.value, [{ ...token, start: 0, end: token.value.length }])
      if (current?.type === schema.nodes.composer_token) {
        if (tokenIdentity(current.attrs.data) !== tokenIdentity(token.data)) transaction = transaction.setNodeMarkup(from, null, content.firstChild!.attrs)
        continue
      }
      inserted = true
      transaction = transaction.replaceWith(from, to, content)
    }
    if (transaction.docChanged) dispatch(inserted ? transaction : transaction.setMeta('addToHistory', false))
  }
  const replaceRange = (rawStart: number, rawEnd: number, text: string, inputType: string, tokenMode: 'resolve' | 'literal' = 'resolve') => {
    const map = projection()
    const start = Math.max(0, Math.min(map.text.length, rawStart)), end = Math.max(start, Math.min(map.text.length, rawEnd))
    const next = map.text.slice(0, start) + text + map.text.slice(end)
    const retainedQuotes = new Set(map.tokens.filter(token => token.end <= start || token.start >= end)
      .flatMap(token => {
        const data = token.data as { kind?: string; quoteId?: string } | null
        return data?.kind === 'selected-text' && data.quoteId ? [data.quoteId] : []
      }))
    const tokens = (tokenMode === 'literal' ? [] : freshTokens(next)).filter(token => token.start >= start && token.end <= start + text.length)
      .filter(token => {
        const data = token.data as { kind?: string; quoteId?: string } | null
        // A stale external offset cannot clone an existing quote into inserted prose.
        return data?.kind !== 'selected-text' || !data.quoteId || !retainedQuotes.has(data.quoteId)
      })
      .map(token => ({ ...token, start: token.start - start, end: token.end - start }))
    const from = map.documentPosition(start, -1), to = map.documentPosition(end, 1)
    let transaction = view.state.tr.replaceWith(from, to, inlineContent(text, tokens))
    const caret = transaction.mapping.map(to, 1)
    transaction = transaction.setSelection(Selection.near(transaction.doc.resolve(caret), -1))
    dispatch(closeHistory(transaction).setMeta('inputType', inputType).scrollIntoView())
    dispatch(closeHistory(view.state.tr))
  }
  const writeValue = (raw: unknown) => {
    const value = String(raw ?? ''), map = projection(), previous = map.text
    if (value === previous) return
    let start = 0, oldEnd = previous.length, newEnd = value.length
    while (start < oldEnd && start < newEnd && previous[start] === value[start]) start++
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd-- }
    // A legacy setter may replace prose adjacent to an atom. Snap the complete
    // atom into the edit so no partial canonical value can remain visible.
    for (const token of map.tokens) {
      if (token.start < start && start < token.end) { start = token.start }
      if (token.start < oldEnd && oldEnd < token.end) { newEnd += token.end - oldEnd; oldEnd = token.end }
    }
    silent = true
    try { replaceRange(start, oldEnd, value.slice(start, newEnd), 'insertReplacementText') }
    finally { silent = false }
  }
  const placeholder = root.getAttribute('placeholder') || root.getAttribute('data-placeholder') || ''
  Object.defineProperties(root, {
    value: { configurable: true, get: () => projection().text, set: writeValue },
    selectionStart: { configurable: true, get: () => selectionRange().start },
    selectionEnd: { configurable: true, get: () => selectionRange().end },
    placeholder: { configurable: true, get: () => root.getAttribute('data-placeholder') || '', set: (value: unknown) => {
      root.setAttribute('data-placeholder', String(value ?? '')); root.setAttribute('aria-placeholder', String(value ?? ''))
    } },
  })
  ;(root as any).setSelectionRange = setSelectionRange
  ;(root as any).placeholder = placeholder
  register(root, command => view.editable && (command === 'undo' ? undo : redo)(view.state, dispatch, view), () => { advanceRevision(); view.destroy() })
  const resetHistory = () => {
    documentGeneration++
    view.updateState(EditorState.create({ doc: view.state.doc, selection: view.state.selection,
      storedMarks: view.state.storedMarks, plugins }))
  }
  const queryAtCaret = () => {
    if (view.composing) return null
    const query = composerQueryInDocument(view.state, continuedQuery)
    if (!query || continuedQuery && projection().documentPosition(query.start) !== continuedQuery.position) continuedQuery = null
    if (!query) { dismissedQuery = null; return null }
    const position = projection().documentPosition(query.start)
    if (dismissedQuery?.prefix === query.prefix && dismissedQuery.position === position) return null
    dismissedQuery = null
    return query
  }
  return {
    setEditable: (editable: boolean) => { if (!editable) { shiftHeld = false; nativePlainPaste = false }; view.setProps({ editable: () => editable }) },
    readTokens: () => projection().tokens,
    replaceRange,
    resetHistory,
    refreshTokens,
    snapshotDocument: () => snapshotComposerDocument(view.state.doc),
    restoreDocument(snapshot) {
      const document = restoreComposerDocument(snapshot)
      if (!document) return false
      const state = EditorState.create({ doc: document, selection: Selection.atEnd(document), plugins })
      documentGeneration++
      advanceRevision()
      dismissedQuery = null
      continuedQuery = null
      shiftHeld = false
      nativePlainPaste = false
      syncTokens(document)
      view.updateState(state)
      return true
    },
    restoreText(value) {
      const document = composerDocumentFromText(value, freshTokens(value))
      documentGeneration++
      advanceRevision()
      dismissedQuery = null
      continuedQuery = null
      shiftHeld = false
      nativePlainPaste = false
      syncTokens(document)
      view.updateState(EditorState.create({ doc: document, selection: Selection.atEnd(document), plugins }))
    },
    serializeSubmission: () => serializeComposerDocument(view.state.doc),
    get revision() { return revision },
    get historyGeneration() { return documentGeneration },
    get composing() { return view.composing },
    queryAtCaret,
    dismissQuery() {
      const query = composerQueryInDocument(view.state, continuedQuery)
      if (query) dismissedQuery = { prefix: query.prefix, position: projection().documentPosition(query.start) }
    },
    continueQuery(prefix, start) { continuedQuery = { prefix, position: projection().documentPosition(start) }; dismissedQuery = null },
  }
}
