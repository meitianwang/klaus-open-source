import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import vectors from '../../../contracts/vectors/session-deletion-vectors.json'
import { shouldDiscardEmptySessionOnLeave } from './sidebar/model'

const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
function handlers(names: string[], context: Record<string, unknown>): Record<string, (...args: any[]) => any> {
  const declarations = names.map(name => {
    const declaration = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name)
    if (!declaration) throw new Error(`Missing chat handler: ${name}`)
    return declaration.getText(ast)
  })
  return runInNewContext(transpileModule(`${declarations.join('\n')}\n({ ${names.join(', ')} });`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText, context)
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function fixture() {
  const pending = deferred<{ ok: boolean }>()
  const row = { id: 'deleting', title: 'Chat', workdir: '/project' }
  const removed: string[] = [], calls: string[] = [], notices: string[] = [], toasts: string[] = []
  let selectionChanges = 0
  const context = {
    voiceChatUi: undefined,
    window: { currentSessionId: row.id as string | null, showToast: (message: string) => notices.push(message) },
    sessions: [row], archivedSessions: [], sessionDeletePending: new Set<string>(), sessionDeletionRevision: 0,
    sessionDrafts: new Map(), sessionPendingFiles: new Map(), submittedTurnSessionIds: new Set<string>(),
    findKnownSession: () => row, normalizeProjectWorkdir: (value: string) => value,
    isWorktreeSessionWorkdir: () => false, detectChannelPrefix: () => null,
    isDraftOnlySession: () => true, shouldDiscardEmptySessionOnLeave,
    goalInteractions: { navigate: () => { selectionChanges++ } },
    klausApi: { session: { delete: (id: string) => { calls.push(id); return pending.promise } } },
    forgetSessionLocalState: (id: string) => removed.push(id), renderSessionList() {}, tt: (key: string) => key,
    emptySessionDeletePending: new Set<string>(),
    showToast: (_message: string) => {},
    enterNewChatState: () => {},
    pendingComposerSubmissions: new Map<string, any>(),
  }
  // Module-level helpers used by deleteSession after it is extracted into the VM context.
  context.showToast = (message: string) => { toasts.push(message) }
  context.enterNewChatState = () => { selectionChanges++; context.window.currentSessionId = null }
  const actions = handlers(['switchSession', 'deleteSession', 'discardSessionWithKnownHistory'], context)
  return { context, actions, pending, removed, calls, notices, toasts, selectionChanges: () => selectionChanges }
}

test('automatic empty cleanup blocks reselection and duplicate deletion until completion', async () => {
  const f = fixture()
  f.context.window.currentSessionId = 'other'
  expect(f.actions.discardSessionWithKnownHistory!('deleting', [], false)).toBe(true)
  await f.actions.switchSession!('deleting')
  await f.actions.deleteSession!('deleting', { skipConfirm: true })
  expect(f.selectionChanges()).toBe(vectors.pending.selectionChanges)
  expect(f.context.window.currentSessionId).toBe('other')
  expect(f.calls).toHaveLength(vectors.pending.duplicateDeletes)
  expect(f.removed).toEqual([])
  f.pending.resolve({ ok: true })
  await settle()
  expect(f.context.sessions).toEqual([])
  expect(f.removed).toEqual(['deleting'])
  expect(f.context.sessionDeletePending.size).toBe(0)
})

test('explicit deletion leaves the current conversation after host deletion and preserves newer navigation', async () => {
  const f = fixture()
  const deletion = f.actions.deleteSession!('deleting', { skipConfirm: true })
  // The conversation stays visible until the delete succeeds; navigation happens after success.
  expect(f.context.window.currentSessionId).toBe('deleting')
  expect(f.removed).toEqual([])
  await f.actions.switchSession!('deleting')
  // While deletion is pending, switching into the doomed session is still blocked.
  expect(f.context.window.currentSessionId).toBe('deleting')
  f.context.window.currentSessionId = 'newer'
  f.pending.resolve({ ok: true })
  await deletion
  expect(f.context.window.currentSessionId).toBe('newer')
  expect(f.removed).toEqual(['deleting'])
  expect(f.context.sessionDeletePending.size).toBe(0)
})

test('project removal uses the same guarded deletion lifecycle', async () => {
  const f = fixture()
  Object.assign(f.context.window, {
    klausDialog: { confirm: async () => true, alert: async () => {} }, dispatchEvent() {},
  })
  Object.assign(f.context.klausApi, { projects: { remove: async () => ({ roots: [], labels: {} }) } })
  Object.assign(f.context, {
    deleteSession: f.actions.deleteSession,
    projectConversationSessions: () => f.context.sessions, closeProjectMenu() {},
    projectRoots: ['/project'], projectLabels: {}, activeProjectWorkdir: '/project',
    forgetProjectThreadListState() {}, setActiveProjectWorkdir() {}, syncAfterProjectRemoval() {},
    CustomEvent: class {},
  })
  const { removeProject } = handlers(['removeProject'], f.context)
  const removal = removeProject!({ workdir: '/project', name: 'Project' })
  await settle()
  // The current conversation is not navigated away until the deletion succeeds.
  expect(f.context.window.currentSessionId).toBe('deleting')
  await f.actions.switchSession!('deleting')
  expect(f.calls).toHaveLength(vectors.pending.duplicateDeletes)
  f.pending.resolve({ ok: true })
  await removal
  expect(f.context.window.currentSessionId).toBeNull()
  expect(f.removed).toEqual(['deleting'])
  expect(f.context.sessions).toEqual([])
})

for (const automatic of [true, false]) test(`failed deletion retains the row and local state, automatic=${automatic}`, async () => {
  const f = fixture()
  const deletion = automatic
    ? (f.actions.discardSessionWithKnownHistory!('deleting', [], false), Promise.resolve())
    : f.actions.deleteSession!('deleting', { skipConfirm: true }).catch((error: Error) => f.notices.push(error.message))
  f.pending.reject(new Error('Deletion failed'))
  await deletion
  await settle()
  expect(f.context.sessions.some((row: any) => row.id === 'deleting')).toBe(vectors.failed.retainsConversation)
  expect(f.removed).toHaveLength(vectors.failed.localStateRemovals)
  expect(f.context.sessionDeletePending.size).toBe(0)
  expect(f.notices).toEqual(['Deletion failed'])
})

test('an abandoned Plan mode read cannot report an error in the next conversation', async () => {
  const pending = deferred<unknown>()
  const notices: string[] = []
  const context = {
    voiceChatUi: undefined,
    window: { currentSessionId: 'old' }, specModeRevision: 0, composerSpecEnabled: false,
    sessionDeletePending: new Set(), klausApi: { session: { getCollaborationMode: () => pending.promise } },
    updateSpecBadge() {}, showToast: (message: string) => notices.push(message), tt: (key: string) => key,
  }
  const { refreshComposerSpecEnabled } = handlers(['refreshComposerSpecEnabled'], context)
  const read = refreshComposerSpecEnabled!()
  context.window.currentSessionId = 'next'
  pending.reject(new Error('The conversation was deleted'))
  await read
  expect(notices).toEqual([])
})

test('a pre-deletion list response cannot resurrect a deleted conversation', async () => {
  const f = fixture()
  const list = deferred<unknown>()
  const context = Object.assign(f.context, {
    sessionListReadSeq: 0, sessionListSettledSeq: 0, sessionListLoadFailed: false,
    console, showToast: (message: string) => f.notices.push(message),
  })
  f.context.enterNewChatState = () => { f.context.window.currentSessionId = null }
  Object.assign(context.klausApi.session, { list: () => list.promise })
  const { readSessionSnapshot } = handlers(['readSessionSnapshot'], context)
  const snapshot = readSessionSnapshot!()
  const deletion = f.actions.deleteSession!('deleting', { skipConfirm: true })
  f.pending.resolve({ ok: true })
  await deletion
  list.resolve([{ id: 'deleting', title: 'Chat' }])
  expect(await snapshot).toBe(vectors.completed.staleListResult)
  expect(context.sessions).toHaveLength(vectors.completed.resurrectedConversations)
})

test('deletion also invalidates an already-settled list before its consumer resumes', async () => {
  const f = fixture()
  const list = deferred<unknown>()
  const context = Object.assign(f.context as any, {
    sessionListReorderSeq: 0, sessionTitleVersions: new Map(),
    sessionPinning: { snapshot: () => new Map() },
    readSessionSnapshot: () => list.promise,
    enterNewChatState: () => { f.context.window.currentSessionId = null },
  })
  const { updateSessionInList } = handlers(['updateSessionInList'], context)
  const refresh = updateSessionInList!()
  const deletion = f.actions.deleteSession!('deleting', { skipConfirm: true })
  // Queue deletion's continuation before the already-settled list consumer.
  f.pending.resolve({ ok: true })
  list.resolve([{ id: 'deleting', title: 'Chat' }])
  await deletion
  await refresh
  expect(context.sessions).toHaveLength(vectors.completed.resurrectedConversations)
})
