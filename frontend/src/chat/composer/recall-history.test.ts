import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isVariableStatement, isFunctionDeclaration, isExpressionStatement, isCallExpression, isArrowFunction, ScriptTarget, transpileModule } from 'typescript'
import { appendComposerHistory, composerHistoryScope, recalledHistoryIndex, restoreComposerHistory } from './recall-history'
import vector from '../../../../contracts/vectors/composer-recall-vectors.json'
import { composerDocumentSchema, composerTokenNode, snapshotComposerDocument } from './document-model'
import { composerKeyWasHandled } from './composer-key-routing'
import { hasComposerDraftContent, normalizeComposerDraft } from './slash-draft'

test('new-chat and existing-chat recall buckets stay independent and bounded', () => {
  const history = restoreComposerHistory(['legacy new chat'])
  for (let index = 0; index < 25; index++) appendComposerHistory(history, 'one', `entry ${index}`)
  appendComposerHistory(history, 'one', 'entry 24')
  appendComposerHistory(history, 'two', 'other chat')
  expect(history.get(composerHistoryScope(null))?.map(draft => draft.text)).toEqual(['legacy new chat'])
  expect(history.get('one')).toHaveLength(vector.entryLimit)
  expect(history.get('one')!.slice(-2).map(draft => draft.text)).toEqual(['entry 24', 'entry 24'])
  expect(history.get('two')?.map(draft => draft.text)).toEqual(['other chat'])
  expect(history.get('unvisited')).toBeUndefined()
})

test('restored history bounds both entries and old chat buckets while preserving new-chat history', () => {
  const history = restoreComposerHistory(Object.fromEntries([
    ['global', ['new-chat']], ...Array.from({ length: 105 }, (_, index) => [`chat-${index}`, Array.from({ length: 30 }, (_v, row) => `entry ${row}`)]),
  ]))
  expect(history.size).toBe(vector.sessionScopeLimit + 1)
  expect(history.has('chat-0')).toBe(false)
  expect(history.get('chat-104')).toHaveLength(vector.entryLimit)
  expect(history.get('global')?.[0].text).toBe('new-chat')
})

test('first accepted prompt can seed its new chat once without losing the structured document', () => {
  const schema = composerDocumentSchema
  const document = snapshotComposerDocument(schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [
    schema.text('ask ', [schema.marks.strong.create()]),
    composerTokenNode({ value: '@target', label: 'Target', data: { kind: 'device', id: 'target' } }),
  ])))
  const history = restoreComposerHistory(null), draft = { text: 'ask @target', document, slashCommand: null, references: [] }
  appendComposerHistory(history, null, draft)
  appendComposerHistory(history, 'created', draft, true)
  expect(history.get('created')![0].document).toEqual(document)
  expect(history.get('global')![0].document).toEqual(document)
  expect(appendComposerHistory(history, 'created', '   ')).toBe(false)
})

test('a quote-only structured prompt remains eligible for recall', () => {
  const schema = composerDocumentSchema
  const token = composerTokenNode({ value: '\uFFFC', label: 'Quote', data: { kind: 'selected-text', quoteId: 'quote-one', text: 'Full quoted passage' } })
  const snapshot = snapshotComposerDocument(schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, token)))
  const history = restoreComposerHistory(null)
  expect(appendComposerHistory(history, 'one', { text: '', document: snapshot, slashCommand: null, references: [] })).toBe(true)
  expect(history.get('one')![0].document).toEqual(snapshot)
})

test('recall wraps upward, clears downward beyond newest, and fresh Down is inert', () => {
  expect(recalledHistoryIndex(-1, 1, 3)).toBeNull()
  expect(recalledHistoryIndex(-1, -1, 3)).toBe(2)
  expect(recalledHistoryIndex(0, -1, 3)).toBe(2)
  expect(recalledHistoryIndex(2, 1, 3)).toBe(-1)
  expect(recalledHistoryIndex(-1, -1, 0)).toBeNull()
})

const ast = createSourceFile('chat.ts', readFileSync(new URL('../chat.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
const names = new Set(['handleComposerRecallKeydown', 'navigateHistory', 'resetHistoryBrowsing'])
const script = transpileModule(ast.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text || ''))
  .map(node => node.getText()).join('\n') + '\n({ handleComposerRecallKeydown });', { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

function fixture() {
  const edited: string[] = []
  const input = { value: '', selectionStart: 0, selectionEnd: 0,
    ownerDocument: { getSelection: () => ({ isCollapsed: true }) },
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end } }
  const context = {
    inputEl: input, historyBrowsingIndex: -1, mainComposerControl: { composing: false },
    window: { currentSessionId: 'one' as string | null }, pendingFiles: [] as unknown[],
    sessionHistories: restoreComposerHistory({ one: ['first', 'second'], global: ['new chat'] }),
    composerHistoryScope, recalledHistoryIndex,
    rows: [] as any[], pendingMutations: new Set<string>(),
    clientQueueFor: (_id: string) => context.rows,
    clientQueueMutationPending: (_id: string, row: string) => context.pendingMutations.has(row),
    mainFollowUpQueueHandlers: { onEdit: async (id: string) => { edited.push(id) } },
    setComposerText: (draft: any) => { input.value = typeof draft === 'string' ? draft : draft.text },
    autoResize() {}, updateSendBtn() {}, persistComposerDraft() {},
  }
  const api = runInNewContext(script, context) as { handleComposerRecallKeydown(event: any): void }
  const key = (name: string, options: object = {}) => {
    const event = { key: name, defaultPrevented: false, stopped: false, ...options,
      preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() { this.stopped = true } }
    api.handleComposerRecallKeydown(event)
    return event
  }
  return { context, input, edited, key }
}

test('empty Up edits the newest eligible queue entry through the existing action', () => {
  const f = fixture()
  f.context.rows = [
    { id: 'older', item: {} }, { id: 'newest', item: {} },
    { id: 'pending', item: {} }, { id: 'unconfirmed', unconfirmed: true, item: {} },
    { id: 'dispatching', dispatching: true, item: {} }, { id: 'engine:owned', item: {} },
  ]
  f.context.pendingMutations.add('pending')
  const event = f.key('ArrowUp')
  expect(event.defaultPrevented).toBe(true)
  expect(event.stopped).toBe(true)
  expect(f.edited).toEqual(['newest'])
  expect(f.context.historyBrowsingIndex).toBe(-1)
})

test('recall reaches new-chat history and fresh Down does not enter it', () => {
  const f = fixture()
  f.context.window.currentSessionId = null
  expect(f.key('ArrowDown').defaultPrevented).toBe(false)
  expect(f.input.value).toBe('')
  expect(f.key('ArrowUp').defaultPrevented).toBe(true)
  expect(f.input.value).toBe('new chat')
  f.key('ArrowDown')
  expect(f.input.value).toBe('')
  expect(f.context.historyBrowsingIndex).toBe(-1)
})

for (const options of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
  test(`recall leaves modified or owned keys alone: ${JSON.stringify(options)}`, () => {
    const f = fixture()
    f.key('ArrowUp', options)
    expect(f.input.value).toBe('')
    expect(f.context.historyBrowsingIndex).toBe(-1)
  })
}

test('selection and caret movement do not replace a recalled entry or reset its browsing index', () => {
  const f = fixture()
  f.key('ArrowUp')
  expect(f.input.value).toBe('second')
  f.input.setSelectionRange(0, 0)
  expect(f.key('ArrowUp').defaultPrevented).toBe(false)
  expect(f.context.historyBrowsingIndex).toBe(1)
  f.input.setSelectionRange(0, f.input.value.length)
  expect(f.key('ArrowDown').defaultPrevented).toBe(false)
  f.input.setSelectionRange(f.input.value.length, f.input.value.length)
  f.key('ArrowUp')
  expect(f.input.value).toBe('first')
})

const keyListener = ast.statements.find(node => isExpressionStatement(node) && isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === 'inputEl.addEventListener'
  && node.expression.arguments[0]?.getText(ast) === "'keydown'" && isArrowFunction(node.expression.arguments[1]))!
const keyCallback = (keyListener as any).expression.arguments[1]
const stopNames = new Set(['clearStopEscArm', 'stopEscArmed', 'armStopEsc'])
const escapeScript = transpileModule(ast.statements.filter(node => isFunctionDeclaration(node) && stopNames.has(node.name?.text || ''))
  .map(node => node.getText()).join('\n') + `\nconst keydown = ${keyCallback.getText(ast)}; keydown;`,
{ compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

test('running Escape ignores repeat, expires after its window and stays scoped to the captured turn', () => {
  let timeout: (() => void) | null = null
  const stopped: string[] = []
  const context = {
    window: { currentSessionId: 'one', setTimeout(callback: () => void, delay: number) { expect(delay).toBe(2000); timeout = callback; return 1 }, clearTimeout() { timeout = null } },
    busy: true, mainComposerControl: { composing: false }, historyBrowsingIndex: 1,
    stopEscArmedTurn: null, stopEscArmTimer: 0, STOP_ESC_ARM_MS: 2000,
    stoppingSessions: new Set(), turn: 'turn-one', getSessionStream: () => ({ activeTurnId: context.turn }),
    inputEl: { selectionStart: 0, selectionEnd: 0, value: '', focus() {} },
    normalizeComposerTokenSelection() {}, updateSendBtn() {},
    requestTurnStop: (id: string) => { stopped.push(id) },
    composerKeyWasHandled,
  }
  const keydown = runInNewContext(escapeScript, context) as (event: any) => void
  const escape = (repeat = false) => keydown({ key: 'Escape', repeat, preventDefault() {} })
  escape()
  escape(true)
  expect(stopped).toEqual([])
  timeout!()
  expect(context.stopEscArmedTurn).toBeNull()
  escape()
  context.turn = 'turn-two'
  escape()
  expect(stopped).toEqual([])
  escape(true)
  expect(stopped).toEqual([])
  escape()
  expect(stopped).toEqual(['one'])
})

// Execute the actual persistence declarations with a shared store and separate windows.
const persistenceNames = new Set(['getWelcomeDraft', 'setWelcomeDraft', 'persistSessionHistories'])
const persistenceVariables = new Set(['sessionHistories', 'WELCOME_DRAFT_KEY', 'WELCOME_DRAFT_SLASH_KEY', 'WELCOME_DRAFT_REFERENCES_KEY', 'WELCOME_DRAFT_DOCUMENT_KEY'])
const windowStateSource = readFileSync(new URL('../../app/window-state.ts', import.meta.url), 'utf8').replace('export function', 'function')
const persistenceScript = transpileModule(windowStateSource + '\n' + ast.statements.filter(node =>
  isFunctionDeclaration(node) && persistenceNames.has(node.name?.text || '')
  || isVariableStatement(node) && node.declarationList.declarations.some(declaration => persistenceVariables.has(declaration.name.getText(ast))))
  .map(node => node.getText(ast)).join('\n') + '\n({ getWelcomeDraft, setWelcomeDraft, persistSessionHistories, sessionHistories });',
{ compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

test('structured welcome drafts and recall persist independently across windows and reloads', () => {
  const store = new Map<string, string>()
  const load = (search: string) => runInNewContext(persistenceScript, {
    window: { location: { search } }, URLSearchParams, restoreComposerHistory, hasComposerDraftContent,
    normalizeComposerDraft: (draft: unknown) => normalizeComposerDraft(draft),
    localStorage: { getItem: (key: string) => store.get(key) ?? null },
    persistLocalValue: (key: string, value: string) => store.set(key, value),
    removeLocalValue: (key: string) => store.delete(key),
    reportLocalPersistenceFailure: () => { throw new Error('Unexpected persistence failure') },
  }) as { getWelcomeDraft(): any; setWelcomeDraft(draft: unknown): void; persistSessionHistories(): void; sessionHistories: Map<string, any[]> }
  const secondarySearch = '?windowId=01234567-89ab-cdef-0123-456789abcdef'
  const primary = load(''), secondary = load(secondarySearch)
  const document = snapshotComposerDocument(composerDocumentSchema.nodes.doc.create(null,
    composerDocumentSchema.nodes.code_block.create(null, composerDocumentSchema.text('  exact\n\tcode'))))
  primary.setWelcomeDraft('primary draft')
  secondary.setWelcomeDraft({ text: '  exact\n\tcode', document, references: [], slashCommand: null })
  appendComposerHistory(primary.sessionHistories, null, 'primary recall')
  appendComposerHistory(secondary.sessionHistories, null, secondary.getWelcomeDraft())
  primary.persistSessionHistories(); secondary.persistSessionHistories()
  expect(load('').getWelcomeDraft().text).toBe('primary draft')
  expect(load(secondarySearch).getWelcomeDraft().document).toEqual(document)
  expect(load('').sessionHistories.get('global')?.[0].text).toBe('primary recall')
  expect(load(secondarySearch).sessionHistories.get('global')?.[0].document).toEqual(document)
  secondary.setWelcomeDraft('')
  expect(load(secondarySearch).getWelcomeDraft().text).toBe('')
  expect(load(secondarySearch).getWelcomeDraft().document).toBeUndefined()
  expect(load('').getWelcomeDraft().text).toBe('primary draft')
})
