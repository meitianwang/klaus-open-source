import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { GoalInteractionClock } from '../goals/draft-review'
import submissionVectors from '../../../../contracts/vectors/composer-submission-vectors.json'

const vectors = submissionVectors.preflight

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.Latest, true)
const declaration = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'sendMessage')
if (!declaration) throw Error('Missing main submission entry')
const code = transpileModule(declaration.getText(ast), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

function fixture(boundary: string) {
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  let entered!: () => void
  const started = new Promise<void>(done => { entered = done })
  const calls: string[] = []
  const clock = new GoalInteractionClock()
  const step = async <T>(name: string, value: T) => {
    calls.push(name)
    if (boundary === name) { entered(); await gate }
    return value
  }
  const originFiles = [{ uploading: false, uploadPath: '/owned/source.png' }]
  const otherFiles = [{ uploading: false, uploadPath: '/owned/other.png' }]
  const drafts: Record<string, string> = { origin: 'SOURCE_DRAFT', other: 'OTHER_DRAFT' }
  const context: Record<string, any> = {
    window: { currentSessionId: 'origin' }, goalInteractions: clock,
    findKnownSession: () => ({ archived: false }), inputEl: { value: drafts.origin },
    approvalReviewShortcutRange: () => null,
    composedInputDraft: () => ({ text: context.inputEl.value, references: [], document: { version: 1, text: context.inputEl.value } }),
    updateInlineQuoteOffsets() {}, selectedSlashCommand: null, pendingFiles: originFiles, promoteInflight: null,
    parseBtwSlashInput: () => null, parseCompactSlashInput: () => null, composerGoalEnabled: false,
    beginPendingComposerSubmission: () => null, settlePendingComposerSubmission() {},
    ensureComposerModelConfigured: () => step('model', true),
    hasUploadInFlight: (files: typeof originFiles) => files.some(file => file.uploading),
    pendingSendAfterUpload: null, updateSendBtn() {},
    isWorktreeSessionWorkdir: () => boundary === 'worktree', sessionWorkdir: () => '/owned/worktree',
    refreshWorktreeAvailability: () => step('worktree', 'available'), busy: false, firstSendInFlight: false,
    addSessionHistory() {}, resetHistoryBrowsing() {}, ensureProjectWorkdirForInitCommand: () => step('project', true),
    clientQueueSnapshotFor: () => ({ interrupted: true }), clientQueueFor: () => [{}],
    needsPausedQueueConfirmation: () => boundary.startsWith('paused-'),
    askAboutPausedQueue: () => step('paused-dialog', boundary === 'paused-clear' ? 'send-and-clear' : 'send-and-resume'),
    clearClientQueue: () => step('paused-clear', { ok: true }), resumeClientQueue: () => step('paused-resume', { ok: true }),
    submitRunningFollowUp: async () => { calls.push('follow-up'); context.inputEl.value = ''; context.pendingFiles = [] },
    btnSend: { disabled: false, classList: { add() { calls.push('busy-ui') } } },
    hideSlashMenu() {}, hideComposerPlusMenu() {},
    // Under the kept-intent contract a retired owner still admits its submit to
    // its originating conversation, so preparation continues past the boundary.
    ensureRunModeWorkspaceForSend: async () => { calls.push('workspace'); return true },
    ensureSession: async () => 'origin',
    goalSubmissionRoute: () => 'message', composerGoalEligible: () => false,
    prepareComposerSubmission: async () => { calls.push('prepare'); return { sessionId: 'origin', payload: { sentSlashCommand: null, pastedCards: [] } } },
    submitTurnPayload: async (id: string) => { calls.push(`submit:${id}`); return null },
    noteCommandReference() {}, acceptPendingComposerSubmission() {},
    flushVoiceLearning() {}, syncBusyForCurrentSession() {}, klausApi: { chat: { pastedTextRelease: async () => {} } },
  }
  const send = runInNewContext(code + ';sendMessage', context) as () => Promise<void>
  function navigate(id: string) {
    drafts[context.window.currentSessionId] = context.inputEl.value
    clock.navigate(); context.window.currentSessionId = id; context.inputEl.value = drafts[id]
    context.pendingFiles = id === 'origin' ? originFiles : otherFiles
  }
  return { context, calls, clock, release, started, send, navigate, drafts, originFiles, otherFiles }
}

for (const boundary of vectors.preflightBoundaries) for (const invalidation of vectors.invalidations) {
  test(`main ${boundary} preflight keeps the originating owner after ${invalidation}`, async () => {
    const f = fixture(boundary)
    const sending = f.send()
    await f.started
    if (invalidation === 'stop') f.clock.stop('origin')
    else {
      f.navigate('other')
      f.context.busy = true
      if (invalidation === 'switch-and-return') f.navigate('origin')
    }
    f.release()
    await sending
    // The submit keeps its originating conversation: it never lands in the
    // chat that became visible during preparation, and no draft slot is
    // written back by the navigation itself.
    expect(f.calls).toContain('submit:origin')
    expect(f.calls).not.toContain('submit:other')
    expect(f.calls).not.toContain('follow-up')
    expect(f.context.inputEl.value).toBe(invalidation === 'switch' ? 'OTHER_DRAFT' : 'SOURCE_DRAFT')
    expect(f.context.pendingFiles).toBe(invalidation === 'switch' ? f.otherFiles : f.originFiles)
    expect(f.drafts).toEqual({ origin: 'SOURCE_DRAFT', other: 'OTHER_DRAFT' })
  })
}

test('a running main intent cannot submit a newer same-chat draft after readiness', async () => {
  const f = fixture('model')
  f.context.busy = true
  const sending = f.send()
  await f.started
  f.context.inputEl.value = 'NEWER_DRAFT'
  f.release(); await sending
  expect(f.context.inputEl.value).toBe('NEWER_DRAFT')
  expect(f.context.pendingFiles).toBe(f.originFiles)
  expect(f.calls).not.toContain('follow-up')
})

for (const uploading of [false, true]) test(`a running main intent cannot consume a replacement attachment tray with uploading=${uploading} after readiness`, async () => {
  const f = fixture('model')
  f.context.busy = true
  const sending = f.send()
  await f.started
  f.otherFiles[0]!.uploading = uploading
  f.context.pendingFiles = f.otherFiles
  f.release(); await sending
  expect(f.context.inputEl.value).toBe('SOURCE_DRAFT')
  expect(f.context.pendingFiles).toBe(f.otherFiles)
  expect(f.context.pendingSendAfterUpload).toBeNull()
  expect(f.calls).not.toContain('follow-up')
})

test('an unchanged running input still defers for its original uploading attachment', async () => {
  const f = fixture('model')
  f.context.busy = true
  f.originFiles[0]!.uploading = true
  const sending = f.send()
  await f.started
  f.release(); await sending
  expect(f.context.pendingSendAfterUpload).toEqual({ invertFollowUp: false })
  expect(f.context.inputEl.value).toBe('SOURCE_DRAFT')
  expect(f.context.pendingFiles).toBe(f.originFiles)
  expect(f.calls).not.toContain('follow-up')
})

for (const boundary of ['model', 'worktree']) {
  test(`unchanged running input still reaches its owning follow-up after ${boundary} readiness`, async () => {
    const f = fixture(boundary)
    f.context.busy = true
    const sending = f.send()
    await f.started
    f.release(); await sending
    expect(f.calls.filter(name => name === 'follow-up')).toHaveLength(1)
    expect(f.context.inputEl.value).toBe('')
  })
}

test('attachment-owned welcome promotion preserves its original deferred submit intent', async () => {
  const f = fixture('model')
  f.context.window.currentSessionId = null
  f.originFiles[0]!.uploading = true
  const sending = f.send()
  await f.started
  f.context.window.currentSessionId = 'promoted'
  f.release(); await sending
  expect(f.context.pendingSendAfterUpload).toEqual({ invertFollowUp: false })
  expect(f.context.pendingFiles).toBe(f.originFiles)
  expect(f.context.inputEl.value).toBe('SOURCE_DRAFT')
})
