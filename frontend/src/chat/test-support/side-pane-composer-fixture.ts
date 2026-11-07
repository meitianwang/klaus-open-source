import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isFunctionDeclaration, transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { Window } from 'happy-dom'
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

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const runtimeStart = source.indexOf('type SideComposerRuntime =')
const runtimeEnd = source.indexOf('async function resolveEditorMentionReference', runtimeStart)
const factoryStart = source.indexOf('function initSideComposer(')
const factoryEnd = source.indexOf('\nconst welcomeEl =', factoryStart)
const helpers: string[] = []
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true)
function collect(node: any) {
  if (isFunctionDeclaration(node) && ['inlineQuoteEntries', 'inlineQuoteDocumentData', 'restoreInlineDocumentFiles'].includes(node.name?.text || '')) helpers.push(node.getText(ast))
  forEachChild(node, collect)
}
collect(ast)
const script = transpileModule(`${helpers.join('\n')}\n${source.slice(runtimeStart, runtimeEnd)}\n${source.slice(factoryStart, factoryEnd)}\n({ sidePaneRuntimes, sidePanePlacement, sideComposerDrafts, initSideComposer });`, {
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
    submissions: [] as Array<{ id: string; payload: any }>, stops: [] as string[], queues: [] as string[],
    modelReads: [] as string[], queueRenders: [] as Array<{ pane: string; id: string | null }>, transcriptMounts: [] as string[],
  }
  const running = new Set<string>()
  const uploads = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  const modelPickers = new Map<string, any>(), permissionPickers = new Map<string, any>(), controls = new Map<any, any>()
  ;(window as any).currentSessionId = 'parent'
  ;(window as any).isSessionRunning = (id: string) => running.has(id)
  let sequence = 0
  let vmApi: any
  const context: any = {
    window, document, localStorage: window.localStorage, navigator: window.navigator,
    MutationObserver: window.MutationObserver, Event: window.Event, CustomEvent: window.CustomEvent,
    console, URL: window.URL, ...placement, ...documentModel, ...documentDraft, ...slashDraft,
    ...inlineQuotes, ...references, ...resourceReferences, workspaceReferencesIn, removeSideWorkflowControls,
    referencesFromEditor: resourceReferences.referencesFromEditor,
    installContenteditableTextControl: (element: any, resolve: any, options: any) => {
      const control = installContenteditableTextControl(element, resolve, options)
      controls.set(element, control)
      return control
    }, composerKeyWasHandled,
    AttachmentHistory, hasUploadInFlight, resolveDeferredSend, preparingSubmissions: createGoalSubmissionGate(),
    stoppingSessions: new Set(), continuingSessions: new Set(), followUpQueueMode: 'queue',
    mainSurface: { messagesEl: document.getElementById('messages') }, surfacesBySession: new Map(),
    composerPreferencesSnapshot: null, voiceChatUi: undefined,
    mainModelCatalogCache: new Map([['custom', [{ value: 'model', label: 'Model' }]]]),
    composerModelReadinessCache: { remember() {} },
    sessionWorkdir: () => '/workspace', windowsSandboxContext: () => ({}),
    mountWindowsSandboxBanner: () => ({ refresh() {}, dispose() {} }),
    TranscriptScrollController: class {
      scrollEl: any
      constructor(options: any) { this.scrollEl = options.scrollEl }
      resetForConversation() {} compensateScrollToDistanceFromBottomPx() {} noteUserScrollIntent() {} prepareLatestTurnPlacement() {}
    }, registerTranscriptScrollController() {}, mountOuterScrollbar() {},
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
    mountPreviews: () => ({ render() {} }), buildFollowUpQueueHandlers: (getSession: any) => ({ getSession }),
    mountFollowUpQueue: (element: any, handlers: any) => ({ handlers, element, render() {} }),
    renderQueueInto: (api: any, id: string) => calls.queueRenders.push({ pane: api.element.closest('[id$="composer-host"]').id, id }),
    renderSideFollowUpQueue() {}, settingsVisibleIfAny: () => false, tt: (key: string) => key,
    formatPreviewMeta: () => '', fileIconSvg: () => '', slashCommandMatchesSearch: () => false,
    createComposerInlineQuote: () => document.createElement('span'), createComposerReferenceElement: () => document.createElement('span'),
    inlineQuoteDocumentData: (entry: any) => entry, commandDocumentTokens: () => [], restoreInlineDocumentFiles: (files: any[]) => files,
    buildSelectedTextEntry: (text: string) => ({ kind: 'selected-text', text, quoteId: `quote-${++sequence}`, file: { name: 'Quote', type: 'text/plain', size: text.length } }),
    inlineQuotePlaceholder: () => '\uFFFC', addSessionHistory() {}, persistQueuedEditDraft() {}, sideFriendContexts: new Map(),
    approvalReviewShortcutRange: () => null, parseCompactSlashInput: () => null,
    ensureComposerModelConfigured: async () => true, takeEditedQueueReinsert: () => null,
    buildOutgoingPayload: (text: string, files: any[], _command: any, _id: string, _references: any, composerDocument: any) => ({ text, files, composerDocument }),
    submitTurnPayload: async (id: string, payload: any) => { calls.submissions.push({ id, payload }); return null },
    queueFollowUp: async (id: string) => { calls.queues.push(id); return { status: 'queued' } },
    followUpModeHelper: { resolveSubmitAction: () => 'queue' },
    requestTurnStop: (id: string) => calls.stops.push(id), requestTurnContinue: (id: string) => calls.submissions.push({ id, payload: [] }),
    sessionContinueMode: () => false, clientQueueFor: () => [], editedQueueReinsertBySession: new Map(),
    getSessionStream: () => ({}), prepareEphemeralSessionStream() {}, retireSessionStream() {}, findKnownSession: () => undefined,
    createChatSurface: (options: any) => ({ messagesEl: options.messagesEl, sessionId: options.getSessionId() }),
    captureTranscriptViewport() {}, activateTranscriptViewport() {}, transcriptViewportState: () => ({ distanceFromBottomPx: 0 }),
    mountReactTranscript: (id: string, element: any) => { element.textContent = `Transcript ${id}`; calls.transcriptMounts.push(id) },
    unmountReactTranscript() {}, resetStreamState() {}, reopenAsyncQuestionsForSession() {},
    refreshClientQueue: async () => ({}), refreshSideComposerModel: async () => ({}),
    focusComposerInput: (element: any) => element.focus(), scrollCaretIntoView() {},
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
