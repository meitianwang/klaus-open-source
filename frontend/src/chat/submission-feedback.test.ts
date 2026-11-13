import { createComposerDraft } from './composer/slash-draft'
import { referencesFromEditor as documentReferencesFromEditor } from './composer/resource-reference'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { installPendingSubmissionFixture } from './test-support/pending-submission-fixture'
import { createSourceFile, forEachChild, isFunctionDeclaration, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { approvalReviewShortcutRange } from './composer/approval-review-shortcut'
import { normalizeComposerReferences } from './composer/reference-token'
import { createGoalSubmissionGate } from './goal-creation'
import { GoalInteractionClock, goalSubmissionRoute } from './goals/draft-review'
import vectors from '../../../contracts/vectors/side-task-feedback-vectors.json'
import { prepareComposerSubmission } from './composer/session-preparation'
import { normalizeComposerDraft } from './composer/slash-draft'
import { restoreInlineQuotePlaceholders } from './composer/inline-quote'
import { needsPausedQueueConfirmation } from './composer/paused-queue-submit'
import { parseManualCompactInput } from './composer/manual-compact-command'
import { chatRunnerStubs } from './test-support/chat-runner-stubs'

const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const names = new Set(['send', 'sideSubmit', 'sideSubmitNow', 'sideSubmitRunningFollowUp', 'sideDraftUnchanged', 'updateSideSendButton', 'updateSendBtn'])
const functions: string[] = []
function collect(node: any) {
  if (isFunctionDeclaration(node) && names.has(node.name?.text || '')) functions.push(node.getText(ast))
  forEachChild(node, collect)
}
collect(ast)
const script = transpileModule(`${chatRunnerStubs}${functions.join('\n')}\n({ send, sideSubmit, updateSideSendButton });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function element() {
  const attributes = new Map<string, string>(), classes = new Set<string>()
  return { value: '', hidden: true, disabled: false, textContent: '', title: '',
    setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    getAttribute: (name: string) => attributes.get(name), removeAttribute: (name: string) => { attributes.delete(name) }, toggleAttribute() {},
    classList: { add: (...names: string[]) => { names.forEach(name => classes.add(name)) }, remove: (...names: string[]) => { names.forEach(name => classes.delete(name)) },
      toggle: (name: string, active: boolean) => { if (active) classes.add(name); else classes.delete(name) }, contains: (name: string) => classes.has(name) },
  }
}
function fixture() {
  const input = element(), sideInput = element(), mainButton = element(), sideButton = element()
  input.value = 'Main question'; sideInput.value = 'Side question'
  const elements: Record<string, ReturnType<typeof element>> = { input, 'side-input': sideInput, send: mainButton, 'side-send': sideButton }
  const ready = deferred<boolean>(), mainWait = deferred<void>(), queueWait = deferred<{ status: 'queued' }>()
  const running: Record<string, boolean> = {}
  const submitted: Array<{ sessionId: string; text: string }> = []
  const unsentSnapshots: any[] = []
  let mainCalls = 0, modelReads = 0
  let api: { send(): Promise<void>; sideSubmit(options?: { followUp?: boolean }): Promise<void>; updateSideSendButton(): void }
  const context = {
    parseCompactSlashInput: parseManualCompactInput, composedInputText: () => input.value,
    normalizeComposerReferences, approvalReviewShortcutRange, referencesFromEditor: documentReferencesFromEditor,
    beginPendingComposerSubmission: () => null,
    recordUnsentSubmission: (record: any) => unsentSnapshots.push(record),
    window: { currentSessionId: 'main', isSessionRunning: (id: string) => !!running[id] },
    document: { getElementById: (id: string) => elements[id] || null },
    preparingSubmissions: createGoalSubmissionGate(), creatingGoalSessions: createGoalSubmissionGate(),
    sideSurfaceSessionId: 'side', sideInput, sideSend: sideButton, sidePendingFiles: [] as unknown[], sideLastComposerInputValue: '',
    sidePendingSendAfterUpload: null, sideComposedInputText: () => sideInput.value.trim(),
    sideComposedInputDraft: () => createComposerDraft(sideInput.value), sideSetComposerDraft: (value: string) => { sideInput.value = value }, addSessionHistory() {},
    sideAutoResize() {}, sideRenderPreviews() {}, sideComposerControl: null,
    ensureComposerModelConfigured: async () => { modelReads++; return ready.promise },
    hasUploadInFlight: () => false, sessionContinueMode: () => false, requestTurnContinue() {}, requestTurnStop() {},
    buildOutgoingPayload: (value: string) => ({ finalText: value }),
    followUpModeHelper: { resolveSubmitAction: () => 'queue' }, takeEditedQueueReinsert: () => null,
    queueFollowUp: async (sessionId: string, payload: { finalText: string }) => {
      submitted.push({ sessionId, text: payload.finalText }); return queueWait.promise
    },
    submitTurnPayload: async (sessionId: string, payload: { finalText: string }) => {
      submitted.push({ sessionId, text: payload.finalText }); running[sessionId] = true; api.updateSideSendButton()
    },
    klausApi: { session: { touchSideTask: async () => ({ ok: true }) } },
    stoppingSessions: new Set(), continuingSessions: new Set(), followUpQueueMode: 'queue', tt: (key: string) => key,
    getSessionStream: (id: string) => ({ running: !!running[id] }),
    busy: false, pendingFiles: [] as unknown[], btnSend: mainButton, hasComposerText: () => !!input.value.trim(),
    currentPendingComposerSubmission: () => undefined,
    composerContinueSessionId: null, composerContinueOffered: false, composerContinueMode: () => false,
    composerGoalEnabled: false, hasLiveGoal: () => false, stopEscArmed: () => false,
    sendMessage: async () => { mainCalls++; await mainWait.promise }, syncBusyForCurrentSession() {},
    showToast() {}, pendingSendAfterUpload: null,
  }
  installPendingSubmissionFixture(context)
  api = runInNewContext(script, context)
  return { context, api, ready, mainWait, queueWait, running, input, sideInput, mainButton, sideButton, submitted,
    mainCalls: () => mainCalls, modelReads: () => modelReads, unsentSnapshots }
}

test('side send owns pending transcript feedback and drops duplicate dispatch during a cold readiness lookup', async () => {
  const f = fixture()
  const first = f.api.sideSubmit()
  expect(f.sideButton.disabled).toBe(false)
  expect(f.sideButton.getAttribute('aria-label')).toBe('submit_tooltip_stop')
  expect(f.sideInput.value).toBe('')
  expect([...(f.context as any).pendingComposerSubmissions.values()][0].draft.text).toBe('Side question')
  expect(f.sideButton.getAttribute('aria-busy')).toBeUndefined()
  expect(f.sideButton.classList.contains('preparing')).toBe(false)
  await f.api.sideSubmit()
  expect(f.modelReads()).toBe(1)
  f.ready.resolve(true)
  await first
  expect(f.submitted).toHaveLength(vectors.send.duplicateSubmissions)
  expect(f.sideInput.value).toBe('')
})

test('a running attachment-only side follow-up retains submit and restores Stop after consuming the draft', async () => {
  const f = fixture()
  f.running.side = true
  f.sideInput.value = ''
  f.context.sidePendingFiles.push({ kind: 'file', name: 'evidence.txt' })
  const pending = f.api.sideSubmit({ followUp: true })
  expect(f.sideButton.disabled).toBe(false)
  expect(f.sideButton.getAttribute('aria-label')).toBe('submit_tooltip_queue')
  await f.api.sideSubmit({ followUp: true })
  expect(f.modelReads()).toBe(1)
  f.ready.resolve(true)
  for (let index = 0; index < 12; index++) await Promise.resolve()
  expect(f.context.preparingSubmissions.has('side')).toBe(true)
  expect(f.context.sidePendingFiles).toEqual([])
  expect(f.sideButton.getAttribute('aria-busy')).toBeUndefined()
  expect(f.sideButton.disabled).toBe(false)
  expect(f.sideButton.getAttribute('aria-label')).toBe(vectors.send.consumedRunningDraftButton)
  f.queueWait.resolve({ status: 'queued' })
  await pending
  expect(f.sideButton.disabled).toBe(false)
  expect(f.sideButton.getAttribute('aria-label')).toBe(vectors.send.consumedRunningDraftButton)
  expect(f.submitted).toHaveLength(1)
})

test('failed model readiness releases its reservation and retains the submitted snapshot outside the next draft', async () => {
  const f = fixture()
  const pending = f.api.sideSubmit()
  f.ready.resolve(false)
  await pending
  expect(f.submitted).toEqual([])
  expect(f.sideInput.value).toBe('')
  expect(f.unsentSnapshots[0].draft.text).toBe('Side question')
  expect(f.unsentSnapshots[0].payload.clientMessageId).toBeTruthy()
  expect(f.sideButton.disabled).toBe(true)
  expect(f.context.preparingSubmissions.has('side')).toBe(false)
})

for (const change of ['tab', 'draft'] as const) {
  test(`${change} changes during side preparation preserve the newly visible draft`, async () => {
    const f = fixture()
    const pending = f.api.sideSubmit()
    if (change === 'tab') f.context.sideSurfaceSessionId = 'another-side'
    f.sideInput.value = 'New draft'
    f.ready.resolve(true)
    await pending
    expect(f.submitted).toEqual([{ sessionId: 'side', text: 'Side question' }])
    expect(f.sideInput.value).toBe('New draft')
    expect(f.context.preparingSubmissions.has('side')).toBe(false)
  })
}

test('main idle reservation drops duplicate dispatch while presentation owns its feedback', async () => {
  const f = fixture()
  const pending = f.api.send()
  expect(f.mainButton.disabled).toBe(false)
  expect(f.mainButton.classList.contains('preparing')).toBe(false)
  expect(f.mainButton.getAttribute('aria-busy')).toBeUndefined()
  await f.api.send()
  expect(f.mainCalls()).toBe(1)
  f.mainWait.resolve()
  await pending
  expect(f.mainButton.disabled).toBe(false)
  expect(f.context.preparingSubmissions.has('main')).toBe(false)
})

test('main running follow-ups preserve their existing busy bypass rather than acquiring a preparation reservation', async () => {
  const f = fixture()
  f.context.busy = true
  const first = f.api.send(), second = f.api.send()
  // The friend-direct check runs before the busy bypass, so main admission
  // happens after one microtask rather than synchronously.
  await Promise.resolve()
  expect(f.mainCalls()).toBe(2)
  expect(f.context.preparingSubmissions.has('main')).toBe(vectors.main.runningFollowUpReserved)
  expect(f.mainButton.classList.contains('preparing')).toBe(false)
  f.mainWait.resolve()
  await Promise.all([first, second])
})

// Run the real paused-queue branch, mutation reservation and draft preparation
// together. The turn boundary records admissions; no renderer is booted here.
const pausedNames = new Set(['sendMessage', 'clearClientQueue', 'resumeClientQueue', 'runClientQueueMutation',
  'clientQueueMutationKey', 'clientQueueMutationPending', 'restorePendingFiles', 'restoreComposerInlineQuotes'])
const pausedFunctions: string[] = []
function collectPaused(node: any) {
  if (isFunctionDeclaration(node) && pausedNames.has(node.name?.text || '')) pausedFunctions.push(node.getText(ast))
  forEachChild(node, collectPaused)
}
collectPaused(ast)
const pausedScript = transpileModule(`${chatRunnerStubs}${pausedFunctions.join('\n')}\n({ sendMessage });`, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText

function pausedSubmission(answer: 'send-and-clear' | 'send-and-resume', outcome: 'accepted' | 'refused' | 'locked') {
  const input = element(), button = element(), mutations: Array<{ method: string; dispatch?: boolean }> = [], admissions: unknown[] = []
  input.value = 'Preserve this authored draft'
  const attachment = { file: { name: 'evidence.pdf', type: 'application/pdf' }, uploadPath: '/uploads/evidence.pdf' }
  const guards = new Set(outcome === 'locked' ? ['main\u0000queued-row'] : [])
  let preparations = 0
  const context: Record<string, any> = {
    beginPendingComposerSubmission: () => null, settlePendingComposerSubmission() {},
    normalizeComposerDraft, normalizeComposerReferences, restoreInlineQuotePlaceholders, approvalReviewShortcutRange, mainComposerControl: null,
    goalInteractions: new GoalInteractionClock(), window: { currentSessionId: 'main' }, inputEl: input, btnSend: button, busy: false,
    findKnownSession: () => ({ archived: false }), promoteInflight: null,
    composedInputDraft: () => ({ text: input.value, references: [] }), selectedSlashCommand: null, pendingFiles: [attachment],
    updateInlineQuoteOffsets() {}, updateComposerQuoteOffsets() {}, parseBtwSlashInput: () => null, parseCompactSlashInput: () => null,
    ensureComposerModelConfigured: async () => true, hasUploadInFlight: () => false,
    isWorktreeSessionWorkdir: () => false, sessionWorkdir: () => '/workspace',
    addSessionHistory() {}, resetHistoryBrowsing() {}, ensureProjectWorkdirForInitCommand: async () => true,
    clientQueueSnapshotFor: () => ({ interrupted: true }), clientQueueFor: () => [{ id: 'queued-row' }],
    needsPausedQueueConfirmation, askAboutPausedQueue: async () => answer,
    clientQueueMutationsInFlight: guards, repaintQueueIslands() {}, showToast() {}, tt: (key: string) => key,
    refreshClientQueue: async () => {}, applyClientQueueSnapshot() {},
    klausApi: { chat: {
      async clientQueueClear() { mutations.push({ method: 'clear' }); return { ok: outcome !== 'refused', error: 'Queue changed' } },
      async clientQueueResume(_sessionId: string, dispatch: boolean) { mutations.push({ method: 'resume', dispatch }); return { ok: outcome !== 'refused', error: 'Queue changed' } },
    } },
    hideSlashMenu() {}, hideComposerPlusMenu() {}, ensureRunModeWorkspaceForSend: async () => true,
    composerGoalEnabled: false, goalSubmissionRoute, sessionDrafts: new Map(), sessionPendingFiles: new Map(),
    prepareComposerSubmission: async (options: Parameters<typeof prepareComposerSubmission>[0]) => { preparations++; return prepareComposerSubmission(options) },
    buildOutgoingPayload: (text: string) => ({ finalText: text, media: [] }),
    clearComposerAfterSubmit() { input.value = ''; context.pendingFiles = [] },
    setComposerText(value: unknown) { input.value = normalizeComposerDraft(value).text },
    inlineQuotePlaceholder: () => '[quote]', displayOffsetToComposerOffset: (offset: number) => offset,
    syncComposerReferenceRanges() {}, setInputValue(value: string) { input.value = value },
    renderPreviews() {}, renderSelectedSlashCommand() {},
    autoResize() {}, updateSendBtn() {},
    setDraft(id: string, value: unknown) { context.sessionDrafts.set(id, normalizeComposerDraft(value)) },
    setWelcomeDraft() {}, syncBusyForCurrentSession() {},
    submitTurnPayload: async (...args: unknown[]) => { admissions.push(args); return null }, flushVoiceLearning() {},
  }
  const api = runInNewContext(pausedScript, context) as { sendMessage(): Promise<void> }
  return { api, context, input, attachment, mutations, admissions, preparations: () => preparations }
}

test('a retained quote uses the rendered offset after a newline following the sent text is consumed', async () => {
  const f = pausedSubmission('send-and-resume', 'accepted')
  const ready = deferred<boolean>()
  f.context.ensureComposerModelConfigured = () => ready.promise
  const pending = f.api.sendMessage()
  const nextQuote = { kind: 'selected-text', text: 'Next quote', composerOffset: f.input.value.length + 1 }
  f.input.value += '\nNext question'
  f.context.pendingFiles.push(nextQuote)
  ready.resolve(true)
  await pending
  expect(f.input.value).toBe('[quote]Next question')
  expect(f.context.pendingFiles).toEqual([nextQuote])
  expect(f.context.sessionDrafts.get('main').text).toBe('Next question')
})

for (const destination of ['current', 'background'] as const) {
  test(`late text and attachments preserve ${destination === 'current' ? 'the unsent suffix in the visible chat' : 'the entire intent after readiness navigation'}`, async () => {
    const f = pausedSubmission('send-and-resume', 'accepted')
    const ready = deferred<boolean>()
    f.context.ensureComposerModelConfigured = () => ready.promise
    const pending = f.api.sendMessage()
    const nextFile = { file: { name: 'next.png' }, uploadPath: '/uploads/next.png' }
    const nextQuote = { kind: 'selected-text', text: 'Next quote', composerOffset: f.input.value.length + 1 }
    f.input.value += ', follow up'
    f.context.pendingFiles.push(nextFile, nextQuote)
    if (destination === 'background') {
      f.context.sessionDrafts.set('main', normalizeComposerDraft(f.input.value))
      f.context.sessionPendingFiles.set('main', f.context.pendingFiles)
      f.context.window.currentSessionId = 'another-session'
      f.input.value = 'Other conversation draft'
      f.context.pendingFiles = []
    }
    ready.resolve(true)
    await pending
    if (destination === 'background') {
      // The submit keeps its originating conversation across the navigation:
      // exactly the captured snapshot is admitted there, and the late suffix
      // remains in the originating draft slot as the next message.
      expect(f.admissions).toHaveLength(1)
      expect((f.admissions[0] as [string, { finalText: string }])[0]).toBe('main')
      expect((f.admissions[0] as [string, { finalText: string }])[1].finalText).toBe('Preserve this authored draft')
      expect(f.context.sessionDrafts.get('main').text).toBe(', follow up')
      expect(f.input.value).toBe('Other conversation draft')
      expect(f.context.pendingFiles).toEqual([])
      expect(f.context.sessionPendingFiles.get('main')).toEqual([nextFile, nextQuote])
      expect(nextQuote.composerOffset).toBe(1)
      return
    }
    expect(f.admissions).toHaveLength(1)
    expect((f.admissions[0] as [string, { finalText: string }])[1].finalText).toBe('Preserve this authored draft')
    expect(f.context.sessionDrafts.get('main').text).toBe(', follow up')
    expect(nextQuote.composerOffset).toBe(1)
    expect(f.input.value).toBe(',[quote] follow up')
    expect(f.context.pendingFiles).toEqual([nextFile, nextQuote])
  })
}

test('a plain follow-up reaches ordinary turn admission without preparing or replacing an active goal', async () => {
  const f = pausedSubmission('send-and-resume', 'accepted')
  const activeGoal = { goalId: 'current-goal', objective: 'Keep pursuing the original objective', status: 'active' }
  f.input.value = 'A plain follow-up about the current work'
  f.context.pendingFiles = []
  f.context.clientQueueSnapshotFor = () => ({ interrupted: false })
  f.context.clientQueueFor = () => []
  f.context.goalSnapshots = { get: () => activeGoal, revision: () => 4 }
  f.context.klausApi.goal = { prepareObjective: () => { throw new Error('A plain follow-up must not prepare a goal') }, set: () => { throw new Error('A plain follow-up must not replace a goal') } }
  f.context.confirmGoalReplacement = () => { throw new Error('A plain follow-up must not ask for replacement') }
  await f.api.sendMessage()
  expect(f.admissions).toHaveLength(1)
  expect(f.admissions[0]).toEqual(['main', { finalText: 'A plain follow-up about the current work', media: [] }, { preserveDraft: true, skipOptimistic: false }])
  expect(activeGoal.objective).toBe('Keep pursuing the original objective')
  expect(f.mutations).toEqual([])
})

for (const answer of ['send-and-clear', 'send-and-resume'] as const) {
  for (const outcome of ['refused', 'locked'] as const) test(`${answer} ${outcome} preserves the main draft and attachments before turn admission`, async () => {
    const f = pausedSubmission(answer, outcome)
    await f.api.sendMessage()
    expect(f.input.value).toBe('Preserve this authored draft')
    expect(f.context.pendingFiles).toEqual([f.attachment])
    expect(f.context.busy).toBe(false)
    expect(f.preparations()).toBe(0)
    expect(f.admissions).toEqual([])
    expect(f.mutations).toEqual(outcome === 'locked' ? [] : [answer === 'send-and-clear' ? { method: 'clear' } : { method: 'resume', dispatch: false }])
  })

  test(`${answer} acknowledged plan permits one draft consumption and one turn admission`, async () => {
    const f = pausedSubmission(answer, 'accepted')
    await f.api.sendMessage()
    expect(f.input.value).toBe('')
    expect(f.context.pendingFiles).toEqual([])
    expect(f.preparations()).toBe(1)
    expect(f.admissions).toHaveLength(1)
    expect(f.mutations).toEqual([answer === 'send-and-clear' ? { method: 'clear' } : { method: 'resume', dispatch: false }])
  })
}

test('composer markup, styling and translations contain no additional preparation or creation presentation', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8')
  const messages = readFileSync(new URL('../i18n/messages.ts', import.meta.url), 'utf8')
  expect(html.includes('composer-send-preparation')).toBe(vectors.main.preparationUi)
  expect(css).not.toContain('#send.preparing')
  expect(css).not.toContain('#side-send.preparing')
  expect(messages).not.toMatch(/\b(message_preparing|side_task_loading|side_task_creating)\s*:/)
})
