import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { GoalInteractionClock } from '../goals/draft-review'
import { createComposerDraft, normalizeComposerDraft } from '../composer/slash-draft'
import { canRestorePendingDraft } from '../composer/pending-submission'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true)
const names = ['createPendingComposerSubmissionRecord', 'acceptPendingComposerSubmission', 'settlePendingComposerSubmission', 'dismissPendingComposerSubmission', 'reconcileCancelledComposerAdmissions']
const script = transpileModule(names.map(name => {
  const node = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name)
  if (!node) throw Error(`Missing submission entry point: ${name}`)
  return node.getText(ast)
}).join('\n') + `\n({ ${names.join(', ')} })`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

/** Supply storage/DOM boundaries while running the shared production admission records. */
export function installPendingSubmissionFixture(context: Record<string, any>): void {
  const defaults = {
    crypto: { randomUUID }, sidePreparation: null, settledSideSubmissions: new WeakSet(),
    sidePendingSubmissionIds: new Set(), pendingComposerSubmissions: new Map(), cancelledComposerAdmissions: new Map(),
    goalInteractions: new GoalInteractionClock(), runtime: { hooks: {} },
    sessionWorkdir: () => '/workspace', findKnownSession: () => undefined, isWorktreeSessionWorkdir: () => false,
    getSessionStream: () => ({ liveUnits: [], history: [], turnStatuses: {} }),
    sessionDrafts: new Map(), sessionPendingFiles: new Map(), pendingFiles: [], visiblePendingSubmissionId: null,
    normalizeComposerDraft, canRestorePendingDraft, getWelcomeDraft: () => createComposerDraft(''),
    beginPendingUserTurn() {}, finishPendingUserTurn() {}, renderLocalUserPayload() {},
    clearPendingSubmissionRecovery() {}, setPendingSubmissionRecovery() {},
    clearUnsentSubmission() {}, recordUnsentSubmission() {}, retryUnsentSubmission() {},
    reconcilePendingComposerSubmissions() {}, syncBusyForCurrentSession() {}, syncMainTranscriptChrome() {}, renderSessionList() {},
    mainScrollController: { clearPendingLatestTurnPlacement() {} },
  }
  for (const [key, value] of Object.entries(defaults)) if (!(key in context)) context[key] = value
  const entries = runInNewContext(script, context)
  for (const [key, value] of Object.entries(entries)) if (!(key in context)) context[key] = value
}
