import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isFunctionDeclaration, transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { Window } from 'happy-dom'
import { createStore } from 'zustand/vanilla'
import { randomUUID } from 'node:crypto'
import { composerSubmitState, applyComposerSubmitState } from '../composer/submit-state'
import * as placement from '../panels/side-pane-placement'
import { installContenteditableTextControl, composerKeyWasHandled } from '../composer/contenteditable-control'
import * as documentModel from '../composer/document-model'
import * as documentDraft from '../composer/document-draft'
import * as slashDraft from '../composer/slash-draft'
import * as inlineQuotes from '../composer/inline-quote'
import * as references from '../composer/reference-token'
import * as resourceReferences from '../composer/resource-reference'
import { workspaceReferencesIn } from '../composer/workspace-reference'
import { removeSideWorkflowControls } from '../composer/workflow-surface'
import { AttachmentHistory } from '../composer/attachment-history'
import { hasUploadInFlight, resolveDeferredSend } from '../composer/deferred-send'
import { createGoalSubmissionGate } from '../goal-creation'
import { createVisibilityScope } from '../visibility-scope'
import { GoalInteractionClock } from '../goals/draft-review'
import { clientMessageId as userMessageClientId } from '../../../../contracts/message-identity'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const runtimeStart = source.indexOf('type SideComposerRuntime =')
const runtimeEnd = source.indexOf('async function resolveEditorMentionReference', runtimeStart)
const factoryStart = source.indexOf('function initSideComposer(')
const factoryEnd = source.indexOf('\nconst welcomeEl =', factoryStart)
const helpers: string[] = []
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true)
function collect(node: any) {
  if (isFunctionDeclaration(node) && ['inlineQuoteEntries', 'inlineQuoteDocumentData', 'restoreInlineDocumentFiles', 'sessionContinueMode', 'createComposerInlineQuote', 'createPendingComposerSubmissionRecord', 'acceptPendingComposerSubmission', 'settlePendingComposerSubmission', 'dismissPendingComposerSubmission', 'renderLocalUserPayload', 'retryUnsentSubmission', 'unsentTurnPayload', 'reconcilePendingComposerSubmissions', 'reconcileCancelledComposerAdmissions', 'stopPendingComposerSubmission'].includes(node.name?.text || '')) helpers.push(node.getText(ast))
  forEachChild(node, collect)
}
collect(ast)
const streamAst = createSourceFile('stream-store.ts', readFileSync(new URL('../stream-store.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
for (const node of streamAst.statements) if (isFunctionDeclaration(node) && node.name?.text === 'canContinueTurn') helpers.push(node.getText(streamAst).replace(/^export\s+/, ''))
const script = transpileModule(`${helpers.join('\n')}\n${source.slice(runtimeStart, runtimeEnd)}\n${source.slice(factoryStart, factoryEnd)}\n({ sidePaneRuntimes, sidePanePlacement, sideComposerDrafts, initSideComposer, reconcileCancelledComposerAdmissions });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

/** Mount both production composer closures against isolated DOM and host boundaries. */
export function createSidePaneComposerFixture() {
  const window = new Window({ url: 'https://example.invalid/' })
  const document: any = window.document
  document.body.innerHTML = `<main id="main"><nav id="left-side-tabs"></nav><div id="messages">Parent content</div>
    <section id="left-side-chat-panel" data-mode="side-chat" hidden><div id="left-side-messages"></div><div id="left-side-composer-host"></div></section>
    <div id="input-wrapper"><div id="input-area"><div class="input-row"><div id="input" contenteditable="true"></div>
    <button id="composer-plus-btn"></button><input id="file-input" type="file"><button id="voice-input-btn"></button><button id="send"></button>
    <div id="main-model-select"></div><div id="permission-select"></div><div id="previews"></div></div></div>
    <div id="follow-up-queue"></div><button id="scroll-to-bottom"></button></div></main>
    <aside id="artifacts-panel" data-mode="side-chat"><section id="side-chat-panel"><div id="side-messages"></div><div id="side-composer-host"></div></section></aside>`
  const prior = new Map<string, unknown>()
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Text', 'MutationObserver', 'CustomEvent', 'Event', 'InputEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    prior.set(key, (globalThis as any)[key])
    ;(globalThis as any)[key] = (window as any)[key]
  }
  const calls = {
    submissions: [] as Array<{ id: string; payload: any }>, admissions: [] as Array<{ id: string; payload: any }>, stops: [] as string[], stopOwners: [] as Array<{ id: string; turnId?: string }>, queues: [] as string[],
    modelReads: [] as string[], queueRenders: [] as Array<{ pane: string; id: string | null }>, transcriptMounts: [] as string[],
    previews: new Map<HTMLElement, any[]>(), retired: [] as string[],
    reopens: [] as Array<{ id: string; left: string | null; right: string | null; mounted: boolean }>,
    queueIslands: [] as Array<{ element: HTMLElement; handlers: any }>,
  }
  const running = new Set<string>()
  const pendingSubmissions = new Map<string, any>(), unsent = new Map<string, any>(), recoveries = new Map<string, any>()
  const pendingRuntime = new Map<string, any>()
  const runtimeStore = createStore<{ sessions: Record<string, any> }>(() => ({ sessions: {} }))
  const streamFor = (id: string) => runtimeStore.getState().sessions[id] || {
    running: false, liveUnits: [], history: [], turnStatuses: {}, turnStartedAtMs: {}, turnFinishedAtMs: {},
  }
  const stopping = new Set<string>(), continuing = new Set<string>()
  const scrollControllers: Array<{ scrollEl: HTMLElement; destroyed: boolean }> = []
  let intervalCalls = 0
  const interval = window.setInterval.bind(window)
  window.setInterval = ((...args: any[]) => { intervalCalls++; return (interval as any)(...args) }) as any
  const uploads = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  const modelPickers = new Map<string, any>(), permissionPickers = new Map<string, any>(), controls = new Map<any, any>()
  ;(window as any).currentSessionId = 'parent'
  ;(window as any).isSessionRunning = (id: string) => running.has(id) || streamFor(id).running
  let sequence = 0
  let vmApi: any
  const context: any = {
    window, document, localStorage: window.localStorage, navigator: window.navigator,
    MutationObserver: window.MutationObserver, Event: window.Event, CustomEvent: window.CustomEvent,
    console, crypto: { randomUUID }, URL: window.URL, userMessageClientId, cancelledComposerAdmissions: new Map(), createVisibilityScope, composerSubmitState, applyComposerSubmitState, ...placement, ...documentModel, ...documentDraft, ...slashDraft,
    ...inlineQuotes, ...references, ...resourceReferences, workspaceReferencesIn, removeSideWorkflowControls,
    referencesFromEditor: resourceReferences.referencesFromEditor,
    installContenteditableTextControl: (element: any, resolve: any, options: any) => {
      const control = installContenteditableTextControl(element, resolve, options)
      controls.set(element, control)
      return control
    }, composerKeyWasHandled,
    AttachmentHistory, hasUploadInFlight, resolveDeferredSend, preparingSubmissions: createGoalSubmissionGate(),
    pendingComposerSubmissions: pendingSubmissions, sidePendingSubmissionIds: new Set(), goalInteractions: new GoalInteractionClock(),
    sessionDrafts: new Map(), sessionPendingFiles: new Map(), pendingFiles: [], visiblePendingSubmissionId: null,
    clearPendingSubmissionRecovery: (id: string) => recoveries.delete(id),
    setPendingSubmissionRecovery: (id: string, recovery: any) => recoveries.set(id, recovery),
    clearUnsentSubmission: (id: string) => unsent.delete(id), recordUnsentSubmission: (record: any) => unsent.set(record.sessionId, record),
    unsentSubmissionFor: (id: string) => unsent.get(id),
    syncBusyForCurrentSession() {}, syncMainTranscriptChrome() {}, renderSessionList() {},
    isSideChatSession: () => true, noteCommandReference() {}, isWorktreeSessionWorkdir: () => false,
    refreshWorktreeAvailability: async () => 'available',
    beginPendingUserTurn: (id: string, payload: any) => {
      calls.admissions.push({ id, payload })
      pendingRuntime.set(payload.uuid, streamFor(id))
      runtimeStore.setState(state => ({ sessions: { ...state.sessions, [id]: { ...streamFor(id), running: true,
        liveUnits: [...(streamFor(id).liveUnits || []), { type: 'live-user', key: payload.uuid, pendingUserTurn: payload.uuid, msg: { ...payload, localRender: payload } }] } } }))
    },
    finishPendingUserTurn: (id: string, uuid: string, outcome: string, error?: string) => {
      const stream = streamFor(id)
      runtimeStore.setState(state => ({ sessions: { ...state.sessions, [id]: { ...stream,
        ...(outcome !== 'accepted' && !stream.activeTurnId ? { running: pendingRuntime.get(uuid)?.running || false } : {}),
        liveUnits: (stream.liveUnits || []).flatMap((row: any) => row.msg?.uuid !== uuid ? [row] : outcome === 'cancelled' ? [] : [{ ...row, pendingUserTurn: undefined }]),
        ...(error ? { submissionError: error } : {}),
      } } }))
    },
    discardPendingUserTurn() {}, getWelcomeDraft: () => slashDraft.createComposerDraft(''),
    mainScrollController: { clearPendingLatestTurnPlacement() {} },
    stoppingSessions: stopping, continuingSessions: continuing, continueArmUntil: new Map(), followUpQueueMode: 'queue',
    mainSurface: { messagesEl: document.getElementById('messages') }, surfacesBySession: new Map(),
    composerPreferencesSnapshot: null, voiceChatUi: undefined,
    mainModelCatalogCache: new Map([['custom', [{ value: 'model', label: 'Model' }]]]),
    composerModelReadinessCache: { remember() {} },
    sessionWorkdir: () => '/workspace', windowsSandboxContext: () => ({}),
    mountWindowsSandboxBanner: () => ({ refresh() {}, dispose() {} }),
    TranscriptScrollController: class {
      scrollEl: any
      destroyed = false
      constructor(options: any) { this.scrollEl = options.scrollEl; scrollControllers.push(this) }
      resetForConversation() {} compensateScrollToDistanceFromBottomPx() {} noteUserScrollIntent() {} prepareLatestTurnPlacement() {} clearPendingLatestTurnPlacement() {} setActive() {}
      destroy() { this.destroyed = true }
    }, registerTranscriptScrollController: () => () => {}, mountOuterScrollbar: () => ({ destroy() {}, setActive() {} }),
    friendDispatchAttempts: () => ({ acquire() {}, accepted() {} }), windowStateKey: (key: string) => key,
    mountFriendIntentSelect: () => ({ setHidden() {}, setValue() {}, setDisabled() {} }),
    mountModelSelect: (element: any, options: any) => {
      const model = { options, value: null as any, setItems(_items: any[], value: any) { this.value = value }, setDisabled() {}, setRuntime() {}, refresh() {} }
      modelPickers.set(element.closest('[id$="composer-host"]').id, model)
      return model
    },
    mountPermissionSelect: (element: any, sessionId: any) => {
      const picker = { sessionId, setValue() {}, setUnavailable() {}, close() {}, refresh() {} }
      permissionPickers.set(element.closest('[id$="composer-host"]').id, picker)
      return picker
    },
    registerVoiceComposer() {}, invalidateComposerPreferenceReads() {}, applyComposerPreferences() {}, syncComposerInferenceStatus() {},
    mainModelMenuValue: (_items: any[], model: string) => model, isThinkingLevelForModel: () => true, modelOptionForValue: () => ({}),
    buildMainModelItems: async () => [{ value: 'model', label: 'Model' }],
    mountSlashMenu: () => null, composerDiscoveryMenuActions: () => ({}), installAttachmentHistory() {},
    mountPreviews: (element: HTMLElement) => ({ render(files: any[]) { calls.previews.set(element, [...files]) } }), buildFollowUpQueueHandlers: (getSession: any, overrides: any, options: any) => ({ getSession, overrides, options }),
    mountFollowUpQueue: (element: any, handlers: any) => { const island = { handlers, element, render() {} }; calls.queueIslands.push(island); return island },
    renderQueueInto: (api: any, id: string) => calls.queueRenders.push({ pane: api.element.closest('[id$="composer-host"]').id, id }),
    renderSideFollowUpQueue() {}, settingsVisibleIfAny: () => false, tt: (key: string) => key,
    formatPreviewMeta: () => '', fileIconSvg: () => '', slashCommandMatchesSearch: () => false,
    createComposerReferenceElement: () => document.createElement('span'),
    klausIcon: () => '', escapeHtml: (value: string) => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`),
    pastedTextPreview: (value: string) => value,
    inlineQuoteDocumentData: (entry: any) => entry, commandDocumentTokens: () => [], restoreInlineDocumentFiles: (files: any[]) => files,
    buildSelectedTextEntry: (text: string) => ({ kind: 'selected-text', text, quoteId: `quote-${++sequence}`, file: { name: 'Quote', type: 'text/plain', size: text.length } }),
    inlineQuotePlaceholder: () => '\uFFFC', addSessionHistory() {}, persistQueuedEditDraft() {}, sideFriendContexts: new Map(),
    approvalReviewShortcutRange: () => null, parseCompactSlashInput: () => null,
    ensureComposerModelConfigured: async () => true, takeEditedQueueReinsert: () => null,
    buildOutgoingPayload: (text: string, files: any[], _command: any, _id: string, _references: any, composerDocument: any) => ({ text, finalText: text, displayText: text, files, composerDocument, liveAttachments: files, media: [], pastedCards: [], selectedTextAttachments: [], composerReferences: _references || [] }),
    submitTurnPayload: async (id: string, payload: any) => { calls.submissions.push({ id, payload }); return null },
    queueFollowUp: async (id: string) => { calls.queues.push(id); return { status: 'queued' } },
    followUpModeHelper: { resolveSubmitAction: () => 'queue' },
    requestTurnStop: (id: string, turnId?: string) => { calls.stops.push(id); calls.stopOwners.push({ id, turnId }) }, requestTurnContinue: (id: string) => calls.submissions.push({ id, payload: [] }),
    clientQueueFor: () => [], editedQueueReinsertBySession: new Map(),
    chatStreamStore: runtimeStore,
    getSessionStream: streamFor, prepareEphemeralSessionStream() {}, retireSessionStream: (id: string) => calls.retired.push(id), findKnownSession: () => undefined,
    reviveSessionStream: () => false, loadSessionHistory: async () => {},
    persistSideDraft() {}, persistedSideDraft: () => null,
    createChatSurface: (options: any) => ({ messagesEl: options.messagesEl, sessionId: options.getSessionId() }),
    captureTranscriptViewport() {}, activateTranscriptViewport() {}, transcriptViewportState: () => ({ distanceFromBottomPx: 0 }),
    mountReactTranscript: (id: string, element: any) => { element.textContent = `Transcript ${id}`; calls.transcriptMounts.push(id) },
    unmountReactTranscript() {}, resetStreamState() {},
    reopenAsyncQuestionsForSession: (id: string) => calls.reopens.push({ id,
      left: vmApi.sidePaneRuntimes.get('left')?.sessionId ?? null,
      right: vmApi.sidePaneRuntimes.get('right')?.sessionId ?? null,
      mounted: calls.transcriptMounts.includes(id) }),
    refreshClientQueue: async () => ({}), refreshSideComposerModel: async () => ({}),
    focusComposerInput: (element: any, offset?: number) => { element.focus(); if (offset !== undefined) element.setSelectionRange(offset, offset) }, scrollCaretIntoView() {},
    disposeAttachmentObjectUrl() {}, rejectOversizedAttachment: () => false,
    uploadAttachment: (entry: any) => new Promise((resolve, reject) => { uploads.set(entry.file.name, { resolve, reject }) }),
    isInlineImage: (_name: string, type: string) => type.startsWith('image/'),
    klausApi: { session: {
      getMainModel: async (id: string) => { calls.modelReads.push(id); return { source: 'custom', mode: 'model', resolvedMode: 'model' } },
      getThinkingLevel: async () => ({ level: 'medium' }), getFastMode: async () => ({ enabled: false }),
      getPermissionMode: async () => ({}), getUltraMode: async () => ({ enabled: false }), touchSideTask: async () => ({}),
    } }, permissionPresetFromResponse: () => 'default',
    openCurrentModelSettings() {}, openApprovalReviewDenials() {}, showToast() {}, refreshClientQueueFromHost: async () => ({}),
  }
  vmApi = runInNewContext(script, context)
  vmApi.initSideComposer('right')
  vmApi.initSideComposer('left')
  const input = (pane: placement.SidePanePlacement) => document.getElementById(pane === 'left' ? 'left-side-input' : 'side-input') as any
  const button = (pane: placement.SidePanePlacement) => document.getElementById(pane === 'left' ? 'left-side-send' : 'side-send')!
  const api = {
    window: window as any, document, calls, running, modelPickers, permissionPickers, vmApi, input, button, uploads,
    controls, scrollControllers, stopping, continuing, streamFor, pendingSubmissions, unsent, recoveries, context,
    intervalCalls: () => intervalCalls,
    setRuntime(id: string, patch: Record<string, unknown>) {
      const next = { ...streamFor(id), ...patch }
      runtimeStore.setState(state => ({ sessions: { ...state.sessions, [id]: next } }))
    },
    addFile(pane: placement.SidePanePlacement, name: string) {
      const file = new window.File(['contents'], name, { type: 'text/plain' })
      input(pane).closest('[id$="input-wrapper"]').dispatchEvent(new window.CustomEvent('composer-attachment-drop', { detail: [file] }))
    },
    setText(pane: placement.SidePanePlacement, text: string) {
      const element = input(pane)
      controls.get(element).replaceRange(0, element.value.length, text, 'insertText')
    },
    async settle() { for (let index = 0; index < 20; index++) await Promise.resolve() },
    async destroy() {
      for (const runtime of vmApi.sidePaneRuntimes.values()) runtime.dispose?.()
      window.dispatchEvent(new window.Event('pagehide'))
      await window.happyDOM.close()
      for (const [key, value] of prior) (globalThis as any)[key] = value
    },
  }
  return api
}
