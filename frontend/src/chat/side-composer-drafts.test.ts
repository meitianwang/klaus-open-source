import { composerDraftFromControl } from './composer/document-draft'
import { createComposerDraft, normalizeComposerDraft, selectedSlashCommandFromDraft } from './composer/slash-draft'
import { migrateSkillDraft } from './composer/resource-reference'
import { workspaceReferencesIn } from './composer/workspace-reference'
import * as documentModel from './composer/document-model'
import { AttachmentHistory } from './composer/attachment-history'
import { referencesFromEditor as documentReferencesFromEditor } from './composer/resource-reference'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { installPendingSubmissionFixture } from './test-support/pending-submission-fixture'
import { createSourceFile, forEachChild, isBinaryExpression, isExpressionStatement, isFunctionDeclaration, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import * as inlineQuotes from './composer/inline-quote'
import { scrollCaretIntoView } from './composer/caret-scroll'
import { approvalReviewShortcutRange } from './composer/approval-review-shortcut'
import { configuredAgentReferences, normalizeComposerReferences } from './composer/reference-token'
import { createGoalSubmissionGate } from './goal-creation'
import { decideComposerPaste } from './composer/clipboard-paste'
import { isLargePastedText, pastedTextPreview } from './composer/pasted-text'
import { resolveDeferredSend } from './composer/deferred-send'
import { parseManualCompactInput } from './composer/manual-compact-command'
import { chatRunnerStubs } from './test-support/chat-runner-stubs'
if (typeof window === 'undefined') (globalThis as any).window = { addEventListener() {} }
const { isThinkingLevelValue, isThinkingLevelForModel, mainModelMenuValue } = await import('./composer/model-select')
const { modelOptionForValue } = await import('../../../shared/cursor-model-catalog')
import vectors from '../../../contracts/vectors/side-task-feedback-vectors.json'
import { createSidePanePlacement, sidePaneElementId, identifySidePaneComposer } from './panels/side-pane-placement'

// Run the real draft lifecycle, quote insertion and surface binding together.
// Only DOM geometry and host effects are supplied by the fixture.
const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const functionNames = new Set(['inlineQuoteEntries', 'sideInlineQuoteEntries', 'sideComposedInputText', 'sideComposedInputDraft', 'sideSetComposerDraft', 'sideAddSelection', 'sideUpload',
  'uploadAttachment', 'sideAttachmentRetained', 'removeSideAttachment', 'attachSidePastedText', 'handleSideComposerPaste',
  'addSideFiles', 'addSideFilePaths', 'filesFromClipboardData', 'filePathsFromClipboardData', 'clipboardLooksFileLike',
  'hideSideComposer', 'inlineQuoteDocumentData', 'sideAutoResize', 'sideDraftUnchanged', 'sideSubmit', 'sideSubmitNow', 'sideSubmitRunningFollowUp', 'updateSideSendButton', 'releaseSideDeferredSend', 'refreshSideComposerModel'])
const hookNames = new Set(['klausSideComposerBind', 'klausSideComposerPrepare', 'klausSideComposerPromote', 'klausSideComposerDiscard',
  'klausSideComposerAddSelection', 'klausSideSurfaceActivate', 'klausSideSurfaceClear', 'klausSideSurfaceRemove', 'klausSideSurfaceSessionId'])
const declarations: string[] = []
const found = new Set<string>()
function collect(node: any) {
  if (isFunctionDeclaration(node) && functionNames.has(node.name?.text || '')) declarations.push(node.getText(ast))
  if (isExpressionStatement(node) && isBinaryExpression(node.expression)) {
    const name = node.expression.left.getText(ast).split('.').at(-1)!
    if (hookNames.has(name) && !node.expression.left.getText(ast).startsWith('runtime.hooks.')) { declarations.push(node.getText(ast)); found.add(name) }
  }
  forEachChild(node, collect)
}
collect(ast)
const lifecycleAst = createSourceFile('attachment-lifecycle.ts', readFileSync(new URL('./composer/attachment-lifecycle.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
for (const node of lifecycleAst.statements) if (isFunctionDeclaration(node)) declarations.push(node.getText(lifecycleAst).replace(/^export\s+/, ''))
for (const name of hookNames) if (!found.has(name)) throw new Error(`Missing production hook: ${name}`)
const script = transpileModule(`${chatRunnerStubs}${declarations.join('\n')}\n({ sideSubmit, sideUpload, addSideFiles, attachSidePastedText, handleSideComposerPaste, updateSideSendButton, sideComposedInputText, refreshSideComposerModel, releaseSideDeferredSend });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve() }

function element() {
  const attributes = new Map<string, string>(), classes = new Set<string>()
  return { value: '', hidden: false, disabled: false, textContent: '', style: { height: '' }, scrollHeight: 36,
    selectionStart: 0, selectionEnd: 0, focus() {}, remove() {},
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end },
    setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    getAttribute: (name: string) => attributes.get(name), removeAttribute: (name: string) => { attributes.delete(name) }, toggleAttribute() {},
    classList: { add: (...names: string[]) => { names.forEach(name => classes.add(name)) }, remove: (...names: string[]) => { names.forEach(name => classes.delete(name)) },
      toggle: (name: string, active: boolean) => { if (active) classes.add(name); else classes.delete(name) }, contains: (name: string) => classes.has(name) },
  }
}
type Entry = { kind?: string; text?: string; quoteId?: string; objectUrl?: string; uploading?: boolean; uploadPath?: string; file?: any; [key: string]: unknown }

export function createSideComposerFixture() {
  const input = element(), button = element()
  const calls = { models: [] as string[], queues: [] as string[], histories: [] as string[], submissions: [] as string[],
    revoked: [] as string[], removed: [] as string[], toasts: [] as string[], nativePaths: [] as string[], remembered: [] as string[], touches: [] as string[], previews: 0, historyResets: 0, permission: '',
    reopens: [] as string[], consumedQueueEdits: [] as string[], viewport: [] as string[] }
  const model = { disabled: false, items: [] as any[], value: '', thinkingLevel: '', ultraMode: false, runtime: null as unknown,
    setDisabled(disabled: boolean) { this.disabled = disabled }, setRuntime(value: unknown) { this.runtime = value },
    setItems(items: any[], options: any) { this.items = items; this.value = options.value || ''; this.thinkingLevel = options.thinkingLevel || ''; this.ultraMode = options.ultraMode ?? this.ultraMode },
  }
  let quoteId = 0
  const running: Record<string, boolean> = {}
  const surfaces = new Map<string, { messagesEl: ReturnType<typeof element> }>()
  const viewportSnapshots = new Map<string, { distanceFromBottomPx: number }>()
  const surfaceId = (container: unknown) => [...surfaces].find(([, surface]) => surface.messagesEl === container)?.[0] || ''
  const catalog = [{ value: 'custom:fixture', label: 'Fixture model' }]
  const context = {
    parseCompactSlashInput: parseManualCompactInput,
    sideAttachmentHistory: new AttachmentHistory(),
    ...documentModel, decideComposerPaste, isLargePastedText, pastedTextPreview, referencesFromEditor: documentReferencesFromEditor, composerDraftFromControl, createComposerDraft, normalizeComposerDraft, selectedSlashCommandFromDraft, migrateSkillDraft, workspaceReferencesIn,
    sideSelectedSlashCommand: null, sideSelectedSlashCommandRange: null, sideReferenceTokens: [], sideDiscovery: null, sideBindingRevision: 0, sideHistoryBrowsingIndex: -1, addSessionHistory() {},
    ...inlineQuotes, approvalReviewShortcutRange, configuredAgentReferences, normalizeComposerReferences, resolveDeferredSend, isThinkingLevelValue, isThinkingLevelForModel, mainModelMenuValue, modelOptionForValue,
    // sideAutoResize is extracted from chat.ts verbatim, so its caret-scroll
    // call resolves against this context. The real module is a no-op on the
    // fixture's geometry-less element, exactly as in a detached composer.
    scrollCaretIntoView,
    prepareEphemeralSessionStream() {}, retireSessionStream() {},
    window: {} as any, document: { getElementById: (id: string) => id === 'side-send' ? button : id === 'side-input' ? input : null },
    URL: class extends URL { static revokeObjectURL(url: string) { calls.revoked.push(url) } static createObjectURL(_file: unknown) { return 'blob:fixture' } },
    sideInput: input, sideSend: button, sideWindowsSandboxBanner: null, sideVoiceChatUi: undefined, sideSurfaceSessionId: null as string | null,
    sideDraftScope: null as string | null, pendingSideDraft: null as { id: string; parentId: string } | null,
    sideDrafts: new Map<string, { value: string; files: Entry[]; deferred: unknown }>(),
    editedQueueReinsertBySession: new Map(),
    sidePendingFiles: [] as Entry[], sidePendingSendAfterUpload: null as unknown, sideLastComposerInputValue: '',
    sideComposerControl: {
      revision: 0,
      resetHistory() { calls.historyResets++ },
      snapshotDocument() { return undefined }, restoreDocument() { return false },
      restoreText(value: string) { input.value = value; this.revision++ },
      replaceRange(start: number, end: number, text: string) {
        if (!text) {
          const entries = context.sidePendingFiles.filter(entry => entry.range)
          const retained = inlineQuotes.replaceInlineTokenRange(start, end, text.length, entries)
          context.sidePendingFiles = context.sidePendingFiles.filter(entry => !retained.removed.includes(entry))
        }
        input.value = input.value.slice(0, start) + text + input.value.slice(end)
        this.revision++
      },
      serializeSubmission() {
        const entries = context.sidePendingFiles.filter(entry => entry.range)
        const composed = inlineQuotes.composeInlineQuotes(input.value, entries, false)
        return { text: composed.text, tokens: composed.quotes.map(quote => ({
          start: quote.requestOffset, end: quote.requestOffset, value: '\uFFFC',
          data: { ...quote, kind: 'selected-text' },
        })) }
      },
    }, sideModelApi: model, sidePermissionApi: { setUnavailable() {}, setValue(value: string) { calls.permission = value }, close() {}, refresh() {} }, sideComposerModelScope: null, sideComposerModelRevision: 0,
    composerPreferencesSnapshot: { sessionId: 'main', source: 'custom', items: catalog, mode: 'custom:fixture', thinkingLevel: 'high', ultraMode: true, fastMode: false, unavailable: false },
    mainModelCatalogCache: new Map([['custom', catalog]]), composerModelReadinessCache: { remember: (id: string, source: string) => { calls.remembered.push(`${id}:${source}`) } },
    preparingSubmissions: createGoalSubmissionGate(), stoppingSessions: new Set(), continuingSessions: new Set(), followUpQueueMode: 'queue',
    rejectOversizedAttachment: () => false, isInlineImage: (_name: string, type: string) => type.startsWith('image/'),
    basenameFromPath: (path: string) => path.split('/').at(-1), showToast: (value: string) => { calls.toasts.push(value) },
    createPastedTextAttachment: async (text: string) => ({ kind: 'pasted-text', file: { name: 'pasted text', type: 'text/plain', size: text.length }, uploadPath: '/pastes/created', uploading: false }),
    hasUploadInFlight: (files: Entry[]) => files.some(file => file.uploading), sessionContinueMode: () => false, tt: (key: string) => key,
    sideRenderPreviews: () => { calls.previews++ },
    focusComposerInput() {}, removeSideInlineQuote() {},
    buildSelectedTextEntry: (text: string) => ({ kind: 'selected-text', text, quoteId: `quote-${++quoteId}`, file: { name: 'Quote', type: 'text/plain', size: text.length } }),
    inlineQuotePlaceholder: () => '\uFFFC',
    klausApi: { clipboard: { readFilePaths: async () => calls.nativePaths }, chat: {
      pastedTextRemove: async (path: string) => { calls.removed.push(path) },
      uploadFilePath: async (path: string) => ({ ok: true, path, name: path.split('/').at(-1), type: 'text/plain' }), uploadFile: async (_name: string, _type: string, _buffer: unknown) => ({ path: '/uploads/file', name: 'file.txt', type: 'text/plain' }) },
      session: { touchSideTask: async (id: string) => { calls.touches.push(id) },
        getMainModel: async (id: string, _options?: { resolve?: boolean }) => { calls.models.push(id); return { source: 'custom', mode: 'custom:fixture', resolvedMode: 'custom:fixture' } },
        getThinkingLevel: async (_id: string) => ({ level: 'high' }), getFastMode: async (_id: string) => ({ enabled: false }), getUltraMode: async (_id: string) => ({ enabled: false }),
      } },
    sideSurfaces: surfaces, surfacesBySession: new Map(),
    getOrCreateSideSurface: (id: string) => { if (!surfaces.has(id)) surfaces.set(id, { messagesEl: element() }); return surfaces.get(id)! },
    sideMessagesContainer: () => null, syncComposerInferenceStatus() {},
    buildMainModelItems: async (source: string): Promise<Array<{ value: string; label: string }>> => context.mainModelCatalogCache.get(source) || [],
    refreshClientQueue: async (id: string) => { calls.queues.push(id) }, renderSideFollowUpQueue() {},
    sideScrollController: {
      scrollEl: { clientHeight: 400 },
      resetForConversation: (distance: number) => calls.viewport.push(`reset:${distance}`),
      compensateScrollToDistanceFromBottomPx: (distance: number) => calls.viewport.push(`restore:${distance}`),
    },
    captureTranscriptViewport: (container: unknown) => calls.viewport.push(`capture:${surfaceId(container)}`),
    activateTranscriptViewport: (container: unknown) => calls.viewport.push(`activate:${surfaceId(container)}`),
    transcriptViewportState: (id: string) => viewportSnapshots.get(id),
    mountReactTranscript: (id: string) => { calls.histories.push(id) }, unmountReactTranscript() {}, resetStreamState() {},
    reopenAsyncQuestionsForSession: (id: string) => { calls.reopens.push(id) },
    ensureComposerModelConfigured: async (_id: string) => true,
    takeEditedQueueReinsert: (id: string) => { calls.consumedQueueEdits.push(id); return null },
    buildOutgoingPayload: (value: string) => ({ finalText: value }),
    submitTurnPayload: async (id: string) => { calls.submissions.push(id) }, requestTurnContinue() {}, requestTurnStop() {},
  }
  context.window = { currentSessionId: 'main', isSessionRunning: (id: string) => !!running[id] }
  let api: { sideSubmit(options?: { followUp?: boolean }): Promise<void>; sideUpload(entry: Entry): Promise<void>; addSideFiles(files: any[]): void; attachSidePastedText(text: string): Promise<void>; handleSideComposerPaste(event: any): Promise<void>; updateSideSendButton(): void; sideComposedInputText(): string; refreshSideComposerModel(): Promise<void>; releaseSideDeferredSend(): void }
  const runtime = {
    placement: 'right', hooks: context.window,
    get sessionId() { return context.sideSurfaceSessionId },
    refreshModel: () => api.refreshSideComposerModel(),
    refreshQueue: () => context.renderSideFollowUpQueue(),
    refresh: () => { model.setDisabled(false); model.setRuntime(null); context.window.klausUpdateSideSendButton?.() },
    resetScroll: (distance: number) => context.sideScrollController.resetForConversation(distance),
    compensateScroll: (distance: number) => context.sideScrollController.compensateScrollToDistanceFromBottomPx(distance),
    retainsAttachment: (entry: Entry) => context.sidePendingFiles.includes(entry),
  }
  Object.assign(context, {
    runtime, sidePaneRuntimes: new Map([['right', runtime]]), retainedSideRuntimes: new Map(),
    sidePaneElementId, identifySidePaneComposer, sidePanePlacement: createSidePanePlacement(), sidePanePlacements: ['right'],
    // This unit fixture exercises draft serialization in one extracted closure.
    // Full retained editor construction and independent pane state are tested
    // with real activation handlers in side-pane-composer.test.ts.
    activateSideComposer: () => runtime,
    sideRuntime: () => runtime, sideRuntimeForSession: (id: string) => runtime.sessionId === id ? runtime : undefined,
    setSidePaneSession: (_runtime: unknown, id: string | null) => { context.sideSurfaceSessionId = id },
    showLeftSidePane() {},
    refreshSideAttachmentPanes: (entry: Entry) => { if (context.sidePendingFiles.includes(entry)) { context.sideRenderPreviews(); api.releaseSideDeferredSend() } },
  })
  installPendingSubmissionFixture(context)
  api = runInNewContext(script, context)
  context.window.klausUpdateSideSendButton = api.updateSideSendButton
  return { context, window: context.window, input, button, model, calls, api, running, viewportSnapshots,
    setText(value: string) { input.value = value; input.setSelectionRange(value.length, value.length); context.sideLastComposerInputValue = value },
    quotes: () => context.sidePendingFiles.filter(entry => entry.kind === 'selected-text').map(entry => entry.text),
  }
}

test('side tabs capture the outgoing viewport and restore only a retained target', async () => {
  const f = createSideComposerFixture()
  f.viewportSnapshots.set('side-a', { distanceFromBottomPx: 420 })
  f.viewportSnapshots.set('side-b', { distanceFromBottomPx: 160 })
  await f.window.klausSideSurfaceActivate('side-a')
  expect(f.calls.viewport).toEqual(['reset:420', 'activate:side-a'])
  f.calls.viewport.length = 0
  await f.window.klausSideSurfaceActivate('side-b')
  expect(f.calls.viewport).toEqual(['capture:side-a', 'reset:160', 'activate:side-b'])
  f.calls.viewport.length = 0
  await f.window.klausSideSurfaceActivate('side-a')
  expect(f.calls.viewport).toEqual(['capture:side-b', 'reset:420', 'activate:side-a', 'restore:420'])
  f.calls.viewport.length = 0
  await f.window.klausSideSurfaceActivate('side-a')
  expect(f.calls.viewport).toEqual(['activate:side-a'])
  f.calls.viewport.length = 0
  f.window.klausSideSurfaceClear()
  expect(f.calls.viewport).toEqual(['capture:side-a'])
})

test('pending composer accepts text and quotes while Send and model/reasoning remain disabled without a real session', async () => {
  const f = createSideComposerFixture()
  f.window.klausSideComposerPrepare('pending', 'main')
  f.setText('My draft')
  f.window.klausSideComposerAddSelection('Quoted passage')
  f.api.updateSideSendButton()
  expect(f.button.disabled).toBe(vectors.pending.sendDisabled)
  expect(f.model.disabled).toBe(vectors.pending.modelDisabled)
  expect(f.model.value).toBe('custom:fixture')
  expect(f.model.thinkingLevel).toBe('high')
  expect(f.model.ultraMode).toBe(true)
  await f.api.sideSubmit()
  expect(f.calls.models).toEqual([])
  expect(f.calls.queues).toEqual([])
  expect(f.calls.histories).toEqual([])
  expect(f.calls.submissions).toHaveLength(vectors.selection.automaticSubmissions)
  expect(f.quotes()).toEqual(vectors.selection.quotes)
  expect(f.api.sideComposedInputText()).toContain('My draft')
})

for (const enabled of [true, false]) test(`pending composer retains the parent Ultra setting through creation rebind: ${enabled}`, () => {
  const f = createSideComposerFixture()
  f.context.composerPreferencesSnapshot.ultraMode = enabled
  f.model.ultraMode = !enabled
  f.window.klausSideComposerPrepare('pending', 'main')
  expect(f.model.ultraMode).toBe(enabled)
  f.window.klausSideSurfaceClear()
  f.model.ultraMode = !enabled
  f.window.klausSideComposerPrepare('pending', 'main')
  expect(f.model.ultraMode).toBe(enabled)
  expect(f.model.disabled).toBe(true)
  expect(f.context.sideSurfaceSessionId).toBeNull()
})

test('loading-to-creation rebind and real-session promotion retain the pending draft and files', async () => {
  const f = createSideComposerFixture()
  f.window.klausSideComposerPrepare('pending', 'main')
  f.setText('My draft')
  const file = { kind: 'file', objectUrl: 'blob:pending' }
  f.context.sidePendingFiles.push(file)
  f.window.klausSideComposerAddSelection('Quoted passage')
  const composed = f.input.value, entries = [...f.context.sidePendingFiles]
  f.window.klausSideSurfaceClear()
  f.window.klausSideComposerPrepare('pending', 'main')
  expect(f.input.value).toBe(composed)
  expect(f.context.sidePendingFiles).toEqual(entries)
  const historyResets = f.calls.historyResets
  await f.window.klausSideComposerPromote('pending', 'real')
  expect(f.calls.historyResets).toBe(historyResets)
  await f.window.klausSideSurfaceActivate('real')
  await settle()
  f.window.klausSideComposerDiscard('pending')
  expect(f.input.value).toBe(composed)
  expect(f.context.sidePendingFiles).toEqual(entries)
  expect(f.context.sidePendingFiles[0]).toBe(file)
  expect(f.context.sideDraftScope).toBe('real')
  expect(f.model.disabled).toBe(false)
  expect(f.button.disabled).toBe(false)
  expect(new Set(f.calls.remembered)).toEqual(new Set(['real:custom']))
  expect(f.calls.revoked).toEqual([])
  expect(new Set(f.calls.models)).toEqual(new Set(['real']))
  expect(f.calls.queues).toEqual(['real'])
  expect(f.calls.histories).toEqual(['real'])
  expect(f.calls.submissions).toEqual([])
})

test('cancelling a pending draft releases its object URLs and cannot alter another side draft on late promotion', async () => {
  const f = createSideComposerFixture()
  f.window.klausSideComposerPrepare('pending', 'main')
  f.setText('Cancelled draft')
  f.context.sidePendingFiles.push({ objectUrl: 'blob:cancelled' })
  f.window.klausSideSurfaceClear()
  f.window.klausSideComposerDiscard('pending')
  await f.window.klausSideSurfaceActivate('other')
  f.setText('Other draft')
  await f.window.klausSideComposerPromote('pending', 'late')
  expect(f.calls.revoked).toEqual(['blob:cancelled'])
  expect(f.context.sideDrafts.has('pending')).toBe(false)
  expect(f.context.sideDraftScope).toBe('other')
  expect(f.input.value).toBe('Other draft')
  expect(f.context.sideSurfaceSessionId).toBe('other')
})

test('discard releases only authoritative live attachments and clears deferred intent and input history state', () => {
  const f = createSideComposerFixture()
  f.window.klausSideComposerPrepare('pending', 'main')
  f.context.sideDrafts.set('pending', { value: 'Saved', files: [{ objectUrl: 'blob:shared' }, { objectUrl: 'blob:saved' }], deferred: null })
  f.context.sidePendingFiles = [{ objectUrl: 'blob:shared' }, { objectUrl: 'blob:live' }]
  f.context.sidePendingSendAfterUpload = { invertFollowUp: false }
  f.setText('Discarded')
  const historyResets = f.calls.historyResets
  f.window.klausSideComposerDiscard('pending')
  expect([...f.calls.revoked].sort()).toEqual(['blob:live', 'blob:shared'])
  expect(f.context.sidePendingFiles).toEqual([])
  expect(f.context.sidePendingSendAfterUpload).toBeNull()
  expect(f.input.value).toBe('')
  expect(f.calls.historyResets).toBe(historyResets + 1)
})

test('a parent source change during a fork cannot seed readiness until the real side source is read', async () => {
  const f = createSideComposerFixture()
  f.window.klausSideComposerPrepare('pending', 'main')
  f.context.composerPreferencesSnapshot.source = 'other'
  f.context.composerPreferencesSnapshot.mode = 'other:fixture'
  f.context.mainModelCatalogCache.set('other', [{ value: 'other:fixture', label: 'Other model' }])
  const saved = deferred<{ source: string; mode: string; resolvedMode: string }>()
  f.context.klausApi.session.getMainModel = async (_id, options) => options?.resolve === false
    ? saved.promise : { source: 'custom', mode: 'custom:fixture', resolvedMode: 'custom:fixture' }
  await f.window.klausSideComposerPromote('pending', 'real')
  expect(f.calls.remembered).toEqual([])
  await f.window.klausSideSurfaceActivate('real')
  expect(f.calls.remembered).toEqual([])
  saved.resolve({ source: 'custom', mode: 'custom:fixture', resolvedMode: 'custom:fixture' })
  await settle()
  expect(new Set(f.calls.remembered)).toEqual(new Set(['real:custom']))
  expect(f.model.value).toBe('custom:fixture')
})

for (const outcome of ['success', 'failure'] as const) {
  test(`an inactive draft upload ${outcome} does not replay or render against the currently bound draft`, async () => {
    const f = createSideComposerFixture()
    f.window.klausSideComposerPrepare('pending', 'main')
    const uploaded = deferred<{ path: string; name: string; type: string }>()
    f.context.klausApi.chat.uploadFile = () => uploaded.promise
    const file = { objectUrl: 'blob:upload', uploading: true, file: { name: 'file.txt', type: 'text/plain', arrayBuffer: async () => new ArrayBuffer(0) } }
    f.context.sidePendingFiles.push(file)
    const upload = f.api.sideUpload(file)
    await f.window.klausSideSurfaceActivate('other')
    f.setText('Other draft')
    await settle()
    const previews = f.calls.previews
    if (outcome === 'success') uploaded.resolve({ path: '/uploads/file', name: 'file.txt', type: 'text/plain' })
    else uploaded.reject(new Error('Upload failed'))
    await upload
    expect(f.input.value).toBe('Other draft')
    expect(f.context.sidePendingFiles).toEqual([])
    expect(f.calls.previews).toBe(previews)
    expect(f.calls.submissions).toEqual([])
    f.window.klausSideComposerBind('pending')
    expect(f.context.sidePendingFiles).toHaveLength(outcome === 'success' ? 1 : 0)
    expect(f.calls.revoked).toEqual(outcome === 'failure' ? ['blob:upload'] : [])
  })
}

test('returning to a real draft replays its parked send after an upload finished in another tab', async () => {
  const f = createSideComposerFixture()
  await f.window.klausSideSurfaceActivate('one')
  f.setText('Parked message')
  const uploaded = deferred<{ path: string; name: string; type: string }>()
  f.context.klausApi.chat.uploadFile = () => uploaded.promise
  const file = { uploading: true, file: { name: 'file.txt', type: 'text/plain', arrayBuffer: async () => new ArrayBuffer(0) } }
  f.context.sidePendingFiles.push(file)
  f.context.sidePendingSendAfterUpload = { invertFollowUp: false }
  const upload = f.api.sideUpload(file)
  await f.window.klausSideSurfaceActivate('other')
  f.setText('Other draft')
  uploaded.resolve({ path: '/uploads/file', name: 'file.txt', type: 'text/plain' })
  await upload
  expect(f.calls.submissions).toEqual([])
  expect(f.input.value).toBe('Other draft')
  await f.window.klausSideSurfaceActivate('one')
  await settle()
  expect(f.calls.submissions).toEqual(['one'])
  expect(f.input.value).toBe('')
  expect(f.context.sidePendingFiles).toEqual([])
  expect(f.context.sidePendingSendAfterUpload).toBeNull()
})

test('a queued bind microtask cannot replay a parked draft after the user switches away again', async () => {
  const f = createSideComposerFixture()
  f.context.sideDrafts.set('one', { value: 'Parked message', files: [], deferred: { invertFollowUp: false } })
  const one = f.window.klausSideSurfaceActivate('one')
  const other = f.window.klausSideSurfaceActivate('other')
  f.setText('Other draft')
  await Promise.all([one, other])
  await settle()
  expect(f.calls.submissions).toEqual([])
  expect(f.input.value).toBe('Other draft')
  expect(f.context.sideDrafts.get('one')?.value).toBe('Parked message')
})

 test('submitting an edited idle side request consumes its queue undo identity', async () => {
  const f = createSideComposerFixture()
  f.context.sideSurfaceSessionId = 'side'
  f.context.sideDraftScope = 'side'
  f.setText('Edited queued request')
  await f.api.sideSubmit()
  expect(f.calls.submissions).toEqual(['side'])
  expect(f.calls.consumedQueueEdits).toEqual(['side'])
})


for (const active of [true, false]) test(`promotion preserves both structured drafts when pending is ${active ? 'active' : 'cached'}`, async () => {
  const f = createSideComposerFixture()
  const schema = documentModel.composerDocumentSchema
  const first = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('existing', [schema.marks.strong.create()])))
  const second = schema.nodes.doc.create(null, schema.nodes.code_block.create(null, schema.text('  pending\n\tcode')))
  const firstSnapshot = documentModel.snapshotComposerDocument(first), secondSnapshot = documentModel.snapshotComposerDocument(second)
  const existingFile = { kind: 'file', objectUrl: 'blob:existing' }, pendingFile = { kind: 'file', objectUrl: 'blob:pending' }
  let restored: unknown
  Object.assign(f.context.sideComposerControl, {
    snapshotDocument: () => secondSnapshot,
    restoreDocument: (snapshot: unknown) => {
      const document = documentModel.restoreComposerDocument(snapshot)
      if (!document) return false
      restored = snapshot
      f.input.value = documentModel.composerDocumentText(document)
      return true
    },
  })
  f.context.sideDrafts.set('real', { value: 'existing', document: firstSnapshot, files: [existingFile], deferred: null } as any)
  f.window.klausSideComposerPrepare('pending', 'main')
  f.setText('  pending\n\tcode')
  f.context.sidePendingFiles.push(pendingFile)
  if (!active) f.window.klausSideComposerBind('other')
  await f.window.klausSideComposerPromote('pending', 'real')
  const snapshot = active ? restored : (f.context.sideDrafts.get('real') as any)?.document
  const merged = documentModel.restoreComposerDocument(snapshot)!
  expect(merged.childCount).toBe(2)
  expect(merged.firstChild!.firstChild!.marks[0].type.name).toBe('strong')
  expect(merged.lastChild!.type.name).toBe('code_block')
  expect(merged.lastChild!.textContent).toBe('  pending\n\tcode')
  const files = active ? f.context.sidePendingFiles : f.context.sideDrafts.get('real')!.files
  expect(files[0]).toBe(existingFile)
  expect(files[1]).toBe(pendingFile)
})

function paste(data: Record<string, string> = {}, files: any[] = [], types = Object.keys(data)) {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true },
    clipboardData: { files, items: [], types, getData: (type: string) => data[type] || '' } }
}

test('side browser file and large-text pastes preserve the authored text and selection', async () => {
  const f = createSideComposerFixture()
  f.window.klausSideComposerPrepare('pending', 'main')
  f.setText('before selected after')
  f.input.setSelectionRange(7, 15)
  const revision = f.context.sideComposerControl.revision
  const file = { name: 'image.png', type: 'image/png', size: 3, arrayBuffer: async () => new ArrayBuffer(3) }
  await f.api.handleSideComposerPaste(paste({}, [file], ['Files']))
  await f.api.handleSideComposerPaste(paste({ 'text/plain': '😀'.repeat(2500) }))
  await settle()
  expect(f.input.value).toBe('before selected after')
  expect([f.input.selectionStart, f.input.selectionEnd]).toEqual([7, 15])
  expect(f.context.sideComposerControl.revision).toBe(revision)
  expect(f.context.sidePendingFiles.map(entry => entry.uploadPath)).toEqual(['/uploads/file', '/pastes/created'])
})

test('side native file formats route paths while ordinary URI text replaces the selection', async () => {
  const f = createSideComposerFixture()
  f.window.klausSideComposerPrepare('pending', 'main')
  f.setText('selected')
  f.input.setSelectionRange(0, 8)
  await f.api.handleSideComposerPaste(paste({ 'text/uri-list': 'file:///tmp/file%20name.txt' }, [], ['Files', 'text/uri-list']))
  await settle()
  expect(f.input.value).toBe('selected')
  expect(f.context.sidePendingFiles[0].uploadPath).toBe('/tmp/file name.txt')
  await f.api.handleSideComposerPaste(paste({ 'text/plain': 'file:///tmp/prose.txt' }))
  expect(f.input.value).toBe('file:///tmp/prose.txt')
  expect(f.context.sidePendingFiles).toHaveLength(1)
})

for (const change of ['draft', 'selection', 'document'] as const) {
  test(`side native clipboard probing ignores a stale ${change}`, async () => {
    const f = createSideComposerFixture()
    f.window.klausSideComposerPrepare('one', 'main')
    f.setText('draft')
    const host = deferred<string[]>()
    f.context.klausApi.clipboard.readFilePaths = () => host.promise
    const pending = f.api.handleSideComposerPaste(paste({}, [], ['Files']))
    if (change === 'draft') f.window.klausSideComposerBind('other')
    else if (change === 'selection') f.input.setSelectionRange(0, 0)
    else f.context.sideComposerControl.revision++
    host.resolve(['/tmp/stale.txt'])
    await pending
    expect(f.context.sidePendingFiles).toEqual([])
  })
}

for (const outcome of ['success', 'failure'] as const) {
  test(`side pasted-text ${outcome} settles only its cached owner`, async () => {
    const f = createSideComposerFixture()
    f.window.klausSideComposerPrepare('one', 'main')
    f.setText('original selection')
    f.input.setSelectionRange(0, 8)
    const creation = deferred<any>()
    f.context.createPastedTextAttachment = () => creation.promise
    const pending = f.api.attachSidePastedText('x'.repeat(5000))
    f.context.sidePendingSendAfterUpload = { invertFollowUp: false }
    f.window.klausSideComposerBind('other')
    f.setText('other draft')
    const renders = f.calls.previews
    creation.resolve(outcome === 'failure' ? null : { kind: 'pasted-text', uploadPath: '/pastes/one', uploading: false })
    await pending
    expect(f.input.value).toBe('other draft')
    expect(f.calls.previews).toBe(renders)
    const owner = f.context.sideDrafts.get('one')!
    expect(owner.value).toBe('original selection')
    expect(owner.files).toHaveLength(outcome === 'success' ? 1 : 0)
    if (outcome === 'success') expect(owner.files[0].uploading).toBe(false)
    else expect(owner.deferred).toBeNull()
    expect(f.calls.submissions).toEqual([])
  })
}

test('discarded side paste deletes a late file without changing a new draft', async () => {
  const f = createSideComposerFixture()
  f.window.klausSideComposerPrepare('one', 'main')
  const creation = deferred<any>()
  f.context.createPastedTextAttachment = () => creation.promise
  const pending = f.api.attachSidePastedText('x'.repeat(5000))
  f.window.klausSideComposerDiscard('one')
  f.window.klausSideComposerBind('other')
  f.setText('other')
  const renders = f.calls.previews
  creation.resolve({ kind: 'pasted-text', uploadPath: '/pastes/orphan' })
  await pending
  expect(f.calls.removed).toEqual(['/pastes/orphan'])
  expect(f.calls.previews).toBe(renders)
  expect(f.input.value).toBe('other')
})

test('an active side paste releases its parked send only after creation succeeds', async () => {
  const f = createSideComposerFixture()
  await f.window.klausSideSurfaceActivate('one')
  f.setText('message')
  const creation = deferred<any>()
  f.context.createPastedTextAttachment = () => creation.promise
  const pending = f.api.attachSidePastedText('x'.repeat(5000))
  f.context.sidePendingSendAfterUpload = { invertFollowUp: false }
  creation.resolve({ kind: 'pasted-text', file: { name: 'pasted text', type: 'text/plain', size: 5000 }, uploadPath: '/pastes/one', uploading: false })
  await pending
  await settle()
  expect(f.calls.submissions).toEqual(['one'])
  expect(f.context.sidePendingSendAfterUpload).toBeNull()
})

test('cached pending promotion merges into the active structured target and survives later binding', async () => {
  const f = createSideComposerFixture(), schema = documentModel.composerDocumentSchema
  let live = documentModel.snapshotComposerDocument(documentModel.composerDocumentFromText(''))
  Object.assign(f.context.sideComposerControl, {
    snapshotDocument: () => live,
    restoreDocument: (snapshot: unknown) => { const document = documentModel.restoreComposerDocument(snapshot); if (!document) return false
      live = documentModel.snapshotComposerDocument(document); f.input.value = documentModel.composerDocumentText(document); return true },
    restoreText: (text: string) => { live = documentModel.snapshotComposerDocument(documentModel.composerDocumentFromText(text)); f.input.value = text },
  })
  f.window.klausSideComposerPrepare('pending', 'main')
  const pending = schema.nodes.doc.create(null, schema.nodes.code_block.create(null, schema.text('  pending')))
  void (f.context.sideComposerControl.restoreDocument as (snapshot: unknown) => boolean)(documentModel.snapshotComposerDocument(pending))
  const pendingFile = { kind: 'file', objectUrl: 'blob:pending' }, targetFile = { kind: 'file', objectUrl: 'blob:target' }
  f.context.sidePendingFiles.push(pendingFile)
  f.window.klausSideComposerBind('target')
  const target = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('target', [schema.marks.strong.create()])))
  void (f.context.sideComposerControl.restoreDocument as (snapshot: unknown) => boolean)(documentModel.snapshotComposerDocument(target))
  f.context.sidePendingFiles.push(targetFile)
  await f.window.klausSideComposerPromote('pending', 'target')
  const merged = documentModel.restoreComposerDocument(live)!
  expect(merged.childCount).toBe(2)
  expect(merged.firstChild!.firstChild!.marks[0].type.name).toBe('strong')
  expect(merged.lastChild!.type.name).toBe('code_block')
  expect(f.context.sidePendingFiles).toEqual([targetFile, pendingFile])
  f.window.klausSideComposerBind('other'); f.window.klausSideComposerBind('target')
  expect(documentModel.restoreComposerDocument(live)!.eq(merged)).toBe(true)
  expect(f.context.sidePendingFiles[0]).toBe(targetFile)
  expect(f.context.sidePendingFiles[1]).toBe(pendingFile)
})
