import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { DraftSessionPromotion } from './draft-session-promotion'
import { createGoalFromDraft, createGoalSubmissionGate } from './goal-creation'
import { GoalInteractionClock, goalSubmissionRoute, reviewGoalDraft, sameGoalDraft, sameGoalReview } from './goals/draft-review'
import { GoalSnapshots } from './goals/snapshots'
import { prepareGoalSubmission, goalImageInputs } from './goals/preparation'
import { GoalSubmissionReceipts, goalAttachmentIntent, serializeGoalSubmissionIntent } from './goals/submission'
import { canRestorePendingDraft, goalSubmissionUserUuid, setPendingSubmissionRecovery, clearPendingSubmissionRecovery, pendingSubmissionRecovery } from './composer/pending-submission'
import { normalizeComposerDraft } from './composer/slash-draft'
import { prepareComposerSubmission } from './composer/session-preparation'
import { clientMessageId as userMessageClientId } from '../../../contracts/message-identity'
import { runContextRowVisible } from './run-context'
import { transcriptChromeState } from './transcript/chrome-state'

;(globalThis as any).window = { ...(globalThis as any).window, addEventListener() {} }
const store = await import('./stream-store')
const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.Latest, true)
const names = new Set(['sendMessage', 'ensureSession', 'switchSession', 'reconcilePendingComposerSubmissions', 'currentPendingComposerSubmission', 'beginPendingComposerSubmission',
  'createPendingComposerSubmissionRecord', 'promotePendingComposerSubmission', 'acceptPendingComposerSubmission', 'settlePendingComposerSubmission', 'stopPendingComposerSubmission',
  'dismissPendingComposerSubmission', 'reconcileCancelledComposerAdmissions', 'syncComposerContextRowVisibility', 'mainTranscriptChromeState', 'syncMainTranscriptChrome', 'retryUnsentSubmission', 'resurfaceUnsentSubmission'])
const functions = ast.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text || '')).map(node => node.getText(ast))
const code = transpileModule(`${functions.join('\n')}\n({ sendMessage, switchSession, reconcilePendingComposerSubmissions, currentPendingComposerSubmission, stopPendingComposerSubmission, syncMainTranscriptChrome, ensureSession });`,
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const drain = async () => { for (let i = 0; i < 45; i++) await Promise.resolve() }
let sequence = 0
function fixture({ existing = false, goal = false, worktree = false } = {}) {
  const id = `pending-ui-${++sequence}`, hostId = `${id}-host`, sourceId = existing ? `${id}-origin` : null
  const model = deferred<boolean>(), creation = deferred<any>(), goalAck = deferred<any>(), workspace = deferred<boolean>()
  let draft = normalizeComposerDraft('Build the authored task'), welcome = normalizeComposerDraft('')
  const file = { uploadPath: '/owned/preview.png', file: new File(['image'], 'preview.png', { type: 'image/png' }), uploading: false }
  const mounts: string[] = [], calls: string[] = [], sends: any[] = [], goals: any[] = [], restored: any[] = [], closed: string[] = []
  const unsent = new Map<string, any>()
  const placements: Array<{ sessionId: string; usersBefore: number }> = []
  const placementMoves: Array<{ from: string; to: string }> = []
  const c: Record<string, any> = {
    crypto, TextEncoder, Date, console, CustomEvent: class { constructor(public type: string, public detail: any) {} },
    flushSync: (callback: () => void) => callback(),
    window: { currentSessionId: sourceId, klaus: { browserUse: { setConversation: async () => {} } }, dispatchEvent: () => c.draftPromotion.navigate() },
    goalInteractions: new GoalInteractionClock(), draftPromotion: new DraftSessionPromotion(), promoteInflight: null,
    sessions: [], sessionDeletePending: new Set(), draftOnlySessionIds: new Set(), sessionDrafts: new Map(), sessionPendingFiles: new Map(), runningSessions: new Set(),
    pendingComposerSubmissions: new Map(), visiblePendingSubmissionId: null,
    sidePendingSubmissionIds: new Set<string>(), cancelledComposerAdmissions: new Map<string, any>(),
    sideRuntimeForSession: () => undefined,
    mainTranscriptChromeSessionId: null,
    preparingSubmissions: createGoalSubmissionGate(), creatingGoalSessions: createGoalSubmissionGate(),
    busy: false, composerGoalEnabled: goal, pendingRunMode: worktree ? 'worktree' : 'local',
    pendingNewChatWorkspaceId: null, pendingNewChatProjectRoot: null, firstSendInFlight: false,
    inputEl: { value: draft.text, focus() {} }, btnSend: { disabled: false, classList: { add() {}, remove() {} } },
    welcomeEl: { style: { display: existing ? 'none' : 'flex' } }, messagesEl: { style: { display: existing ? 'block' : 'none' }, toggleAttribute() {}, hasAttribute: () => false },
    composerContextRowEl: { hidden: existing }, runContextRowVisible, transcriptChromeState,
    isDraftOnlySession: (target: string) => c.draftOnlySessionIds.has(target),
    canEditProjectForCurrentConversation: () => !c.window.currentSessionId || c.draftOnlySessionIds.has(c.window.currentSessionId),
    enterNewChatState: () => { c.window.currentSessionId = null; c.visiblePendingSubmissionId = null; c.api.syncMainTranscriptChrome() },
    pendingFiles: [file], selectedSlashCommand: null,
    composedInputDraft: () => draft,
    setComposerText: (value: unknown) => { draft = normalizeComposerDraft(value); c.inputEl.value = draft.text },
    clearComposerAfterSubmit: (target: string) => { c.setComposerText(''); c.pendingFiles = []; if (target) c.sessionDrafts.set(target, normalizeComposerDraft('')) },
    setDraft: (target: string, value: unknown) => { c.sessionDrafts.set(target, normalizeComposerDraft(value)); restored.push([target, value]) },
    getWelcomeDraft: () => welcome, setWelcomeDraft: (value: unknown) => { welcome = normalizeComposerDraft(value) }, normalizeComposerDraft,
    findKnownSession: () => ({ archived: false }), approvalReviewShortcutRange: () => null, updateInlineQuoteOffsets() {},
    planShortcutRange: () => null, goalShortcutRange: () => null,
    normalizeComposerReferences: (_text: string, refs: any[]) => refs || [], draftProjectWorkdir: () => '/project', sessionWorkdir: () => '/project',
    buildOutgoingPayload: (text: string, files: any[]) => ({ text, finalText: text, displayText: text, media: [], liveAttachments: files.map(file => ({ path: file.uploadPath })),
      pastedCards: [], selectedTextAttachments: [], sentSlashCommand: null, composerReferences: [], createdAt: Date.now() }),
    mountReactTranscript: (target: string) => { mounts.push(target); calls.push('mount') }, unmountReactTranscript() {},
    syncTopModeButtons() {}, updateScrollToBottomBtn() {}, renderSessionList() {}, updateSendBtn() {},
    mainScrollController: {
      prepareLatestTurnPlacement: (sessionId: string) => placements.push({ sessionId, usersBefore: store.getSessionStream(sessionId).liveUnits.filter(row => row.type === 'live-user').length }),
      movePendingLatestTurnPlacement: (from: string, to: string) => placementMoves.push({ from, to }),
      clearPendingLatestTurnPlacement() {}, resetForConversation() {},
    },
    renderPreviews() {}, renderSelectedSlashCommand() {}, autoResize() {}, hideSlashMenu() {}, hideComposerPlusMenu() {},
    syncBusyForCurrentSession: () => { c.busy = !!api.currentPendingComposerSubmission() || !!store.getSessionStream(c.window.currentSessionId || '').running },
    syncMainTranscriptChrome() {}, showToast() {}, tt: (key: string) => key,
    ...store, canRestorePendingDraft, goalSubmissionUserUuid, setPendingSubmissionRecovery, clearPendingSubmissionRecovery, userMessageClientId,
    parseBtwSlashInput: () => null, parseCompactSlashInput: () => null, composerGoalEligible: () => true,
    ensureComposerModelConfigured: () => { calls.push('model'); return model.promise }, hasUploadInFlight: () => false,
    isWorktreeSessionWorkdir: () => false, refreshWorktreeAvailability: async () => 'available',
    addSessionHistory() {}, resetHistoryBrowsing() {}, ensureProjectWorkdirForInitCommand: async () => true,
    clientQueueSnapshotFor: () => null, clientQueueFor: () => [], needsPausedQueueConfirmation: () => false,
    ensureRunModeWorkspaceForSend: async (surface: any) => { calls.push(`workspace:${surface?.sessionId || ''}`); return worktree ? workspace.promise : true },
    refreshWorkdirButton() {}, renderFollowUpQueue() {}, renderTaskPanel() {}, refreshTasksForSession() {}, saveRunModeForDraft() {}, forgetRunModeForDraft() {},
    updateGoalIndicator() {}, updateSpecBanner() {}, showTranscriptSurface: () => { calls.push('show'); c.welcomeEl.style.display = 'none'; c.messagesEl.style.display = 'block' },
    goalSubmissionRoute, goalSnapshots: new GoalSnapshots(), goalSubmissionReceipts: new GoalSubmissionReceipts(() => {}),
    isGoalConflict: () => false, reviewGoalDraft, sameGoalDraft, sameGoalReview, prepareGoalSubmission, goalImageInputs, goalAttachmentIntent, serializeGoalSubmissionIntent, createGoalFromDraft,
    hydrateGoalSnapshot: async () => null, confirmGoalReplacement: async () => true,
    setComposerGoalEnabled: (value: boolean) => { c.composerGoalEnabled = value }, onGoalUpdated() {}, requestTurnStop: (target: string) => calls.push(`stop:${target}`),
    noteCommandReference() {}, flushVoiceLearning() {}, prepareComposerSubmission,
    recordUnsentSubmission: (record: any) => { unsent.set(record.sessionId, record) },
    unsentSubmissionFor: (id: string) => unsent.get(id) ?? null,
    clearUnsentSubmission: (id: string) => { unsent.delete(id) },
    listUnsentSessionIds: () => [...unsent.keys()],
    submitTurnPayload: async (target: string, payload: any, options: any) => { sends.push({ target, payload, options }); return null },
    klausApi: { session: { new: async () => { calls.push('create'); return creation.promise }, delete: async (target: string) => { closed.push(target) } },
      chat: { pastedTextRelease: async () => {} }, goal: {
        prepareObjective: async (_target: string, input: any) => ({ objective: input.text, displayText: input.text, preparationId: 'prepared' }),
        discardPreparedObjective: async () => {},
        set: async (target: string, value: any) => { goals.push({ target, value }); return goalAck.promise },
      } },
  }
  const api = runInNewContext(code, c) as { sendMessage(): Promise<void>; switchSession(id: string): Promise<void>; reconcilePendingComposerSubmissions(): void; currentPendingComposerSubmission(): any; stopPendingComposerSubmission(): boolean; syncMainTranscriptChrome(): void; ensureSession(): Promise<string | null> }
  c.api = api
  return { c, api, model, creation, goalAck, workspace, file, mounts, calls, sends, goals, closed, hostId, placements, placementMoves,
    unsent: () => [...unsent.values()],
    draft: () => draft, setDraft: (text: string) => c.setComposerText(text),
    resolveCreation: () => creation.resolve({ id: hostId, title: 'New Chat', createdAt: Date.now(), updatedAt: Date.now(), workdir: '/project' }) }
}

for (const goal of [false, true]) test(`${goal ? 'goal' : 'ordinary'} submission publishes and consumes its snapshot before cold readiness or session creation`, async () => {
  const f = fixture({ goal }), task = f.api.sendMessage()
  const pending = f.api.currentPendingComposerSubmission()
  expect(f.calls.slice(0, 2)).toEqual(['mount', 'model'])
  expect(f.placements).toEqual([{ sessionId: pending.viewId, usersBefore: 0 }])
  const provisionalViewId = pending.viewId
  expect(f.c.window.currentSessionId).toBeNull()
  expect(f.c.welcomeEl.style.display).toBe('none')
  expect(f.c.composerContextRowEl.hidden).toBe(true)
  expect(f.draft().text).toBe('')
  const optimistic = store.getSessionStream(pending.viewId).liveUnits.find(row => row.type === 'live-user')!
  expect(optimistic.type === 'live-user' && optimistic.msg.text).toBe('Build the authored task')
  expect(store.getSessionStream(pending.viewId).turnStartedAt).toBe(pending.startedAtMs)
  expect(store.getSessionStream(pending.viewId).provisional).toBe(true)
  f.setDraft('The next message'); f.c.pendingFiles = []
  f.model.resolve(true); await drain()
  expect(f.calls).toContain('create')
  f.resolveCreation(); await drain()
  if (goal) {
    for (let i = 0; i < 20 && !f.goals.length; i++) await new Promise(done => setTimeout(done, 1))
    expect(f.goals).toHaveLength(1)
    const uuid = await goalSubmissionUserUuid(f.goals[0].value.clientRequestId)
    store.ingestChatEvent({ type: 'user_message', sessionId: f.hostId, message: { uuid, message: { content: 'Build the authored task' } } } as any)
    expect(store.getSessionStream(f.hostId).liveUnits.filter(row => row.type === 'live-user')).toHaveLength(1)
    f.goalAck.resolve({ ok: true, goal: { goalId: 'goal', status: 'active', objective: 'Build the authored task' }, goalRevision: 1, admission: 'scheduled' })
  }
  await task
  expect(f.placements).toHaveLength(1)
  expect(f.placementMoves).toEqual([{ from: provisionalViewId, to: f.hostId }])
  expect(f.draft().text).toBe('The next message')
  expect(store.getSessionStream(f.hostId).liveUnits.filter(row => row.type === 'live-user')).toHaveLength(1)
  expect(store.getSessionStream(f.hostId).turnStartedAt).toBe(pending.startedAtMs)
  if (!goal) expect(f.sends[0].options.skipOptimistic).toBe(true)
})

for (const goal of [false, true]) for (const nextText of ['', 'The next unsent message']) {
  test(`${goal ? 'goal' : 'ordinary'} promotion persists only the next draft ${JSON.stringify(nextText)}`, async () => {
    const f = fixture({ goal }), browserScope = deferred<void>()
    f.c.window.klaus.browserUse.setConversation = () => browserScope.promise
    const task = f.api.sendMessage()
    f.setDraft(nextText)
    f.model.resolve(true); await drain(); f.resolveCreation(); await drain()
    expect(normalizeComposerDraft(f.c.sessionDrafts.get(f.hostId)).text).toBe(nextText)
    // Re-entering the selected row restores its persisted slot even before the
    // browser scope and turn acknowledgement finish.
    f.c.setComposerText(f.c.sessionDrafts.get(f.hostId) || '')
    expect(f.draft().text).toBe(nextText)
    browserScope.resolve(); await drain()
    if (goal) {
      for (let i = 0; i < 20 && !f.goals.length; i++) await new Promise(done => setTimeout(done, 1))
      f.goalAck.resolve({ ok: true, goal: { status: 'active' }, goalRevision: 1, admission: 'scheduled' })
    }
    await task
    expect(normalizeComposerDraft(f.c.sessionDrafts.get(f.hostId)).text).toBe(nextText)
    expect(f.draft().text).toBe(nextText)
  })
}

for (const destination of ['another-conversation', null]) test(`background promotion preserves the newer welcome draft while viewing ${destination}`, async () => {
  const f = fixture(), task = f.api.sendMessage()
  f.model.resolve(true); await drain()
  f.c.goalInteractions.navigate(); f.c.draftPromotion.navigate()
  f.c.visiblePendingSubmissionId = null
  f.c.window.currentSessionId = destination
  f.setDraft('A different new draft')
  f.c.setWelcomeDraft('A different new draft')
  f.resolveCreation(); await task
  expect(f.sends[0].target).toBe(f.hostId)
  expect(normalizeComposerDraft(f.c.sessionDrafts.get(f.hostId)).text).toBe('')
  expect(f.c.getWelcomeDraft().text).toBe('A different new draft')
  expect(f.draft().text).toBe('A different new draft')
})

for (const nextText of ['', 'Follow-up during attachment promotion']) test(`a send joining attachment promotion preserves only the next draft ${JSON.stringify(nextText)}`, async () => {
  const f = fixture()
  const promotion = f.api.ensureSession()
  const task = f.api.sendMessage()
  f.setDraft(nextText)
  f.model.resolve(true); await drain(); f.resolveCreation()
  await promotion; await task
  expect(f.sends).toHaveLength(1)
  expect(normalizeComposerDraft(f.c.sessionDrafts.get(f.hostId)).text).toBe(nextText)
  expect(f.draft().text).toBe(nextText)
})

for (const goal of [false, true]) test(`${goal ? 'goal' : 'ordinary'} promotion keeps its submitted transcript visible during browser scope binding`, async () => {
  const f = fixture({ goal }), browserScope = deferred<void>()
  f.c.window.klaus.browserUse.setConversation = () => {
    f.api.syncMainTranscriptChrome()
    return browserScope.promise
  }
  const task = f.api.sendMessage()
  f.model.resolve(true); await drain(); f.resolveCreation(); await drain()
  expect(f.c.window.currentSessionId).toBe(f.hostId)
  expect(f.c.draftOnlySessionIds.has(f.hostId)).toBe(true)
  expect(f.c.messagesEl.style.display).toBe('block')
  expect(f.c.welcomeEl.style.display).toBe('none')
  f.api.syncMainTranscriptChrome()
  expect(f.c.messagesEl.style.display).toBe('block')
  browserScope.resolve(); await drain()
  if (goal) {
    for (let i = 0; i < 20 && !f.goals.length; i++) await new Promise(done => setTimeout(done, 1))
    f.goalAck.resolve({ ok: true, goal: { goalId: 'goal', status: 'active', objective: 'Build the authored task' }, goalRevision: 1, admission: 'scheduled' })
  }
  await task
  expect(f.c.messagesEl.style.display).toBe('block')
})

for (const existing of [false, true]) test(`failed readiness ${existing ? 'keeps the refusal retryable in its conversation' : 'restores only its empty new composer'}`, async () => {
  const f = fixture({ existing }), task = f.api.sendMessage()
  const pending = f.api.currentPendingComposerSubmission()
  f.model.resolve(false); await task
  if (existing) {
    // The conversation entity already exists, so the refused preparation stays
    // with it as a retryable unsent record instead of a composer write-back.
    expect(f.draft().text).toBe('')
    expect(f.unsent()).toHaveLength(1)
    expect(f.unsent()[0].sessionId).toBe(f.c.window.currentSessionId)
    expect(pendingSubmissionRecovery(pending!.uuid)?.action).toBe('retry')
  } else {
    expect(f.draft().text).toBe('Build the authored task')
    expect(f.c.pendingFiles).toEqual([f.file])
    expect(f.unsent()).toHaveLength(0)
  }
  expect(f.sends).toHaveLength(0)
  expect(f.api.currentPendingComposerSubmission()).toBeUndefined()
})

test('an attachment-promoted draft hides setup and keeps a refused preparation retryable', async () => {
  const f = fixture({ existing: true })
  f.c.draftOnlySessionIds.add(f.c.window.currentSessionId)
  f.c.composerContextRowEl.hidden = false
  const task = f.api.sendMessage()
  expect(f.c.composerContextRowEl.hidden).toBe(true)
  expect(f.c.canEditProjectForCurrentConversation()).toBe(true)
  f.model.resolve(false)
  await task
  // The conversation entity already exists, so the refused preparation stays
  // with it as a retryable unsent record: no composer write-back, and the
  // setup row stays hidden while the conversation owns the failure.
  expect(f.c.composerContextRowEl.hidden).toBe(true)
  expect(f.unsent()).toHaveLength(1)
  expect(f.draft().text).toBe('')
})

test('failure preserves newer input while retaining the submitted message and its error', async () => {
  const f = fixture(), task = f.api.sendMessage(), pending = f.api.currentPendingComposerSubmission()
  f.setDraft('Newer authored input'); f.c.pendingFiles = []
  f.model.resolve(false); await task
  expect(f.draft().text).toBe('Newer authored input')
  expect(store.getSessionStream(pending.viewId).liveUnits.map(row => row.type)).toEqual(['live-user', 'live-error'])
  expect(store.getSessionStream(pending.viewId).running).toBe(false)
  expect(f.c.composerContextRowEl.hidden).toBe(true)
  pendingSubmissionRecovery(pending.uuid)?.run()
  expect(f.draft().text).toBe('Newer authored input')
  expect(f.c.composerContextRowEl.hidden).toBe(false)
})

test('returning to a pending conversation hides setup without affecting a new draft', async () => {
  const f = fixture(), task = f.api.sendMessage(), pending = f.api.currentPendingComposerSubmission()
  f.c.visiblePendingSubmissionId = null
  f.api.syncMainTranscriptChrome()
  expect(f.c.composerContextRowEl.hidden).toBe(false)
  await f.api.switchSession(pending.viewId)
  expect(f.c.composerContextRowEl.hidden).toBe(true)
  f.api.stopPendingComposerSubmission()
  f.model.resolve(false)
  await task
  expect(f.c.composerContextRowEl.hidden).toBe(false)
})

test('loaded history hides setup before the transcript DOM paints', () => {
  const f = fixture()
  f.c.window.currentSessionId = f.hostId
  f.c.draftOnlySessionIds.add(f.hostId)
  store.chatStreamStore.setState(state => ({ sessions: { ...state.sessions,
    [f.hostId]: { ...store.getSessionStream(f.hostId), history: [{ role: 'user', uuid: 'saved', message: { content: 'Saved message' } }] },
  } }))
  f.api.syncMainTranscriptChrome()
  expect(f.c.composerContextRowEl.hidden).toBe(true)
})

test('Stop during session creation restores input and late identity cannot reclaim the welcome screen', async () => {
  const f = fixture(), task = f.api.sendMessage()
  f.model.resolve(true); await drain()
  expect(f.calls).toContain('create')
  expect(f.api.stopPendingComposerSubmission()).toBe(true)
  expect(f.draft().text).toBe('Build the authored task')
  f.resolveCreation(); await task; await drain()
  expect(f.c.window.currentSessionId).toBeNull()
  expect(f.c.welcomeEl.style.display).toBe('flex')
  expect(f.c.composerContextRowEl.hidden).toBe(false)
  expect(f.sends).toHaveLength(0)
  expect(f.closed).toContain(f.hostId)
})

test('a goal worktree binds preparation to its real conversation before workspace creation', async () => {
  const f = fixture({ goal: true, worktree: true }), task = f.api.sendMessage()
  f.model.resolve(true); await drain(); f.resolveCreation(); await drain()
  expect(f.calls).toContain(`workspace:${f.hostId}`)
  expect(f.goals).toHaveLength(0)
  f.workspace.resolve(true)
  for (let i = 0; i < 20 && !f.goals.length; i++) await new Promise(done => setTimeout(done, 1))
  expect(f.goals[0].target).toBe(f.hostId)
  f.goalAck.resolve({ ok: true, goal: { status: 'active' }, goalRevision: 1, admission: 'scheduled' })
  await task
})


test('failed creation provides a recovery action while preserving a newer draft', async () => {
  const f = fixture(), task = f.api.sendMessage(), pending = f.api.currentPendingComposerSubmission()
  f.model.resolve(true); await drain()
  f.setDraft('Keep my next request'); f.c.pendingFiles = []
  f.creation.reject(new Error('Creation failed')); await task
  expect(pendingSubmissionRecovery(pending.uuid)?.action).toBe('back')
  expect(f.c.welcomeEl.style.display).toBe('none')
  pendingSubmissionRecovery(pending.uuid)?.run()
  expect(f.draft().text).toBe('Keep my next request')
  expect(f.c.welcomeEl.style.display).toBe('flex')
  expect(store.getSessionStream(pending.viewId).liveUnits).toHaveLength(0)
})

test('Stop while goal acknowledgement is pending interrupts its admitted owner after acknowledgement', async () => {
  const f = fixture({ goal: true }), task = f.api.sendMessage(), pending = f.api.currentPendingComposerSubmission()
  f.model.resolve(true); await drain(); f.resolveCreation()
  for (let i = 0; i < 20 && !f.goals.length; i++) await new Promise(done => setTimeout(done, 1))
  // The engine surfaces the admitted turn before the acknowledgement returns: its
  // runtime status opens the turn and the owned user echo binds the exact input.
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId: f.hostId, status: 'active', turnId: 'goal-turn-1' })
  store.ingestChatEvent({ type: 'user_message', sessionId: f.hostId, turnId: 'goal-turn-1', message: { uuid: pending.uuid, message: { content: 'Build the authored task' } } } as any)
  expect(f.api.stopPendingComposerSubmission()).toBe(true)
  f.goalAck.resolve({ ok: true, goal: { status: 'active' }, goalRevision: 1, admission: 'scheduled' })
  await task
  expect(f.calls).toContain(`stop:${f.hostId}`)
  expect(f.draft().text).toBe('')
})


test('an uncertain goal acknowledgement is never resubmitted and a late owned echo reconciles its original clock', async () => {
  const f = fixture({ goal: true }), task = f.api.sendMessage(), pending = f.api.currentPendingComposerSubmission()
  f.model.resolve(true); await drain(); f.resolveCreation()
  for (let i = 0; i < 20 && !f.goals.length; i++) await new Promise(done => setTimeout(done, 1))
  f.goalAck.reject(new Error('Transport disconnected')); await task
  expect(pendingSubmissionRecovery(pending.uuid)?.action).toBe('dismiss')
  expect(f.goals).toHaveLength(1)
  expect(f.draft().text).toBe('')
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId: f.hostId, status: 'active', turnId: 'late-goal-turn' })
  // Only an owned echo — the canonical user row carrying the submission identity —
  // reconciles the uncertain record; session-only runtime status never adopts it.
  store.ingestChatEvent({ type: 'user_message', sessionId: f.hostId, turnId: 'late-goal-turn', message: { uuid: pending.uuid, message: { content: 'Build the authored task' } } } as any)
  f.api.reconcilePendingComposerSubmissions()
  expect(pendingSubmissionRecovery(pending.uuid)).toBeUndefined()
  expect(store.getSessionStream(f.hostId).turnWorkStartedAtMs['late-goal-turn']).toBe(pending.startedAtMs)
  expect(store.getSessionStream(f.hostId).liveUnits.filter(unit => unit.type === 'live-user')).toHaveLength(1)
})


test('selecting the visible provisional sidebar row does not invalidate its pending submission', async () => {
  const f = fixture(), task = f.api.sendMessage(), pending = f.api.currentPendingComposerSubmission()
  await f.api.switchSession(pending.viewId)
  expect(f.api.currentPendingComposerSubmission()).toBe(pending)
  f.model.resolve(true); await drain(); f.resolveCreation(); await task
  expect(f.sends).toHaveLength(1)
})

test('navigation during preparation keeps the submit on its originating conversation', async () => {
  const f = fixture({ existing: true }), task = f.api.sendMessage(), origin = f.c.window.currentSessionId
  f.c.goalInteractions.navigate(); f.c.draftPromotion.navigate(); f.c.window.currentSessionId = 'different-conversation'
  f.setDraft('The newly visible draft'); const nextFiles = [{ uploadPath: '/other/attachment' }]; f.c.pendingFiles = nextFiles
  f.model.resolve(true); await task
  // The send keeps its originating target across the navigation and never
  // admits its input to the newly visible conversation.
  expect(f.sends).toHaveLength(1)
  expect(f.sends[0].target).toBe(origin)
  expect(f.draft().text).toBe('The newly visible draft')
  expect(f.c.pendingFiles).toBe(nextFiles)
  // The originating draft slot keeps its post-handoff state: navigation never
  // writes the submitted snapshot back into a composer draft.
  expect(f.c.sessionDrafts.get(origin).text).toBe('')
  expect(f.c.sessionPendingFiles.get(origin)).toBeUndefined()
  expect(f.unsent()).toHaveLength(0)
})

test('a refused ordinary send keeps one error and offers retry without writing the draft back', async () => {
  const f = fixture(), task = f.api.sendMessage(), pending = f.api.currentPendingComposerSubmission()
  f.c.submitTurnPayload = async (_target: string, _payload: any, options: any) => { expect(options.quietError).toBe(true); return 'The request was refused' }
  f.model.resolve(true); await drain(); f.resolveCreation(); await task
  expect(store.getSessionStream(f.hostId).liveUnits.filter(unit => unit.type === 'live-error')).toHaveLength(1)
  // The conversation entity exists, so the refused message stays with it as a
  // retryable unsent record instead of returning to a composer draft.
  expect(pendingSubmissionRecovery(pending.uuid)?.action).toBe('retry')
  expect(f.unsent()).toHaveLength(1)
  expect(f.unsent()[0].sessionId).toBe(f.hostId)
  expect(f.draft().text).toBe('')
  const sends = f.sends
  f.c.submitTurnPayload = async (target: string, payload: any) => { sends.push({ target, payload }); return null }
  pendingSubmissionRecovery(pending.uuid)?.run(); await drain()
  // Retry resubmits the stored payload to the same conversation (the refusing
  // stub above owned the first admission, so this array holds the retry only)
  // and clears the unsent record once the host admits it.
  expect(f.sends).toHaveLength(1)
  expect(f.sends[0].target).toBe(f.hostId)
  expect(f.sends[0].payload.finalText).toBe('Build the authored task')
  expect(f.unsent()).toHaveLength(0)
})


test('a completed goal echo survives reconciliation when its acknowledgement is lost before history loads', async () => {
  const f = fixture({ goal: true }), task = f.api.sendMessage(), pending = f.api.currentPendingComposerSubmission()
  f.model.resolve(true); await drain(); f.resolveCreation()
  for (let i = 0; i < 20 && !f.goals.length; i++) await new Promise(done => setTimeout(done, 1))
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId: f.hostId, status: 'active', turnId: 'completed-before-ack' })
  // The completed echo arrives as the canonical user row owning the submission
  // identity, before the acknowledgement is lost and before any history load.
  store.ingestChatEvent({ type: 'user_message', sessionId: f.hostId, turnId: 'completed-before-ack', message: { uuid: pending.uuid, message: { content: 'Build the authored task' } } } as any)
  const before = store.getSessionStream(f.hostId)
  store.chatStreamStore.setState({ sessions: { ...store.chatStreamStore.getState().sessions, [f.hostId]: {
    ...before, running: false, activeTurnId: null, lastTerminalStatus: 'completed',
  } } })
  f.goalAck.reject(new Error('Acknowledgement was lost')); await task
  f.api.reconcilePendingComposerSubmissions()
  expect(pendingSubmissionRecovery(pending.uuid)).toBeUndefined()
  expect(store.getSessionStream(f.hostId).liveUnits.filter(unit => unit.type === 'live-user')).toHaveLength(1)
  expect(store.getSessionStream(f.hostId).liveUnits.filter(unit => unit.type === 'live-error')).toHaveLength(0)
})
