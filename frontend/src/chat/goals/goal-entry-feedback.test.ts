import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { I18N } from '../../i18n/messages'
import { approvalReviewShortcutRange } from '../composer/approval-review-shortcut'
import { parseManualCompactInput } from '../composer/manual-compact-command'
import { goalSurfaceControlsAvailable, goalSurfaceEligible, type GoalSurfaceSession } from '../composer/workflow-surface'
import { GoalInteractionClock } from './draft-review'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const names = new Set(['denyComposerGoalAttempt', 'setComposerGoalEnabled', 'composerGoalControlsAvailable', 'composerGoalEligible', 'toggleComposerGoalEnabled', 'activateComposerGoalShortcut', 'parseBtwSlashInput', 'parseCompactSlashInput', 'sendMessage'])
const functions = ast.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text || '')).map(node => node.getText(ast))
const code = transpileModule(`${functions.join('\n')}\n({ toggleComposerGoalEnabled, sendMessage });`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
const expectedNotice = {
  en: 'Goal mode is available only in ordinary local or worktree chats.',
  zh: '目标模式仅适用于普通本地对话或工作树对话。',
}
function fixture(locale: 'en' | 'zh', session: GoalSurfaceSession, text: string, armed = false) {
  const image = { path: '/owned/image.png', name: 'image.png', type: 'image/png', size: 3 }
  const paste = { kind: 'pasted-text', text: 'Retain the whole pasted text' }
  const files = [image, paste]
  const toasts: string[] = [], calls = { model: 0, mode: 0, goal: 0, prepare: 0, inference: 0 }
  const special = { btw: [] as string[], compact: [] as string[] }
  const unexpected = (kind: keyof typeof calls) => async () => { calls[kind]++; throw new Error(`Unexpected ${kind} request`) }
  const context: Record<string, any> = {
    window: { currentSessionId: 'chat' }, findKnownSession: () => session, detectChannelPrefix: () => null,
    goalSurfaceControlsAvailable, goalSurfaceEligible, goalPursuitEligibility: new Map(),
    composerGoalEnabled: armed, composerSpecEnabled: false, specModeRevision: 0, goalInteractions: new GoalInteractionClock(),
    inputEl: { value: text, setSelectionRange() {} }, pendingFiles: files,
    updateGoalBadge() {}, updateGoalPlaceholder() {}, showToast: (message: string) => toasts.push(message), tt: (key: string) => I18N[locale][key],
    approvalReviewShortcutRange, parseManualCompactInput, hideSlashMenu() {},
    promoteInflight: null, composedInputDraft: () => ({ text: context.inputEl.value, references: [] }), updateInlineQuoteOffsets() {}, selectedSlashCommand: null,
    submitBtwQuestion: async (question: string) => { special.btw.push(question) },
    hasUploadInFlight: () => false, isWorktreeSessionWorkdir: () => false, sessionWorkdir: () => undefined, busy: false,
    addSessionHistory() {}, resetHistoryBrowsing() {}, ensureProjectWorkdirForInitCommand: async () => true,
    clientQueueSnapshotFor: () => null, clientQueueFor: () => [], needsPausedQueueConfirmation: () => false,
    btnSend: { disabled: false, classList: { add() {} } }, hideComposerPlusMenu() {}, ensureRunModeWorkspaceForSend: async () => true,
    firstSendInFlight: false, setComposerText: (value: string) => { context.inputEl.value = value }, autoResize() {},
    ensureSession: async () => 'chat', setDraft() {}, triggerCompact: async (instructions: string) => { special.compact.push(instructions) },
    beginPendingComposerSubmission: () => null, settlePendingComposerSubmission() {},
    ensureComposerModelConfigured: async () => { calls.model++; return false },
    hydrateGoalSnapshot: unexpected('goal'),
    klausApi: { session: { getCollaborationMode: unexpected('mode'), setCollaborationMode: unexpected('mode') },
      goal: { get: unexpected('goal'), set: unexpected('goal'), prepareObjective: unexpected('prepare') }, chat: { send: unexpected('inference') } },
  }
  const api = runInNewContext(code, context) as { toggleComposerGoalEnabled(force?: boolean): Promise<boolean>; sendMessage(): Promise<void> }
  return { api, context, calls, toasts, files, image, paste, special }
}

for (const locale of ['en', 'zh'] as const) for (const session of [{ threadSource: 'friend' }, { goalPursuitEligible: false }]) for (const route of ['plus', 'armed-submit'] as const) test(`${locale} ${route} denial explains goal scope and preserves draft attachment identity for ${JSON.stringify(session)}`, async () => {
  const text = 'Finish this objective'
  const f = fixture(locale, session, text, route === 'armed-submit')
  if (route === 'plus') expect(await f.api.toggleComposerGoalEnabled(true)).toBe(false)
  else await f.api.sendMessage()
  expect(f.toasts).toEqual([expectedNotice[locale]])
  expect(I18N[locale].goal_unavailable_context).toBe(expectedNotice[locale])
  expect(f.context.composerGoalEnabled).toBe(false)
  expect(f.context.inputEl.value).toBe(text)
  expect(f.context.pendingFiles).toBe(f.files)
  expect(f.context.pendingFiles[0]).toBe(f.image)
  expect(f.context.pendingFiles[1]).toBe(f.paste)
  expect(f.calls).toEqual({ model: 0, mode: 0, goal: 0, prepare: 0, inference: 0 })
})

for (const locale of ['en', 'zh'] as const) test(`${locale} ordinary follow-up in a bounded chat keeps its ordinary route without a goal notice`, async () => {
  const f = fixture(locale, { threadSource: 'friend' }, 'An ordinary follow-up')
  await f.api.sendMessage()
  expect(f.toasts).toEqual([])
  expect(f.calls).toEqual({ model: 1, mode: 0, goal: 0, prepare: 0, inference: 0 })
  expect(f.context.inputEl.value).toBe('An ordinary follow-up')
  expect(f.context.pendingFiles).toBe(f.files)
})

for (const locale of ['en', 'zh'] as const) for (const text of ['/btw Ask a side question', '/compact Keep recent details', ' \n ']) test(`${locale} explicit special routing or empty Send takes priority over stale Goal arming: ${JSON.stringify(text)}`, async () => {
  const f = fixture(locale, { goalPursuitEligible: false }, text, true)
  f.context.pendingFiles = []
  await f.api.sendMessage()
  expect(f.toasts).toEqual([])
  expect(f.special).toEqual({ btw: text.startsWith('/btw') ? ['Ask a side question'] : [], compact: text.startsWith('/compact') ? ['Keep recent details'] : [] })
  expect(f.calls).toEqual({ model: 0, mode: 0, goal: 0, prepare: 0, inference: 0 })
  if (text.startsWith('/btw') || !text.trim()) expect(f.context.inputEl.value).toBe(text)
})
