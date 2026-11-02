import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import vectors from '../../../contracts/vectors/session-runtime-state-vectors.json'

const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const idle = () => ({ provisional: false, running: false, activeTurnId: null as string | null, liveTurnId: null as string | null, turnStartedAt: 0, lastTerminalStatus: null as string | null })
const live = (id = 'turn-one') => ({ ...idle(), running: true, activeTurnId: id, liveTurnId: id, turnStartedAt: 1 })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fixture() {
  const calls = { catalog: 0, runtime: 0, scheduled: 0, rendered: 0 }
  const context = {
    sessions: Array.from({ length: vectors.historicalRows }, (_, index) => ({ id: `history-${index}`, title: `Title ${index}`, isWorking: false })),
    streams: {} as Record<string, ReturnType<typeof idle>>,
    runningSessions: new Set<string>(), sidebarListedWorkingSessions: new Set<string>(),
    stoppingSessions: new Set<string>(), continuingSessions: new Set<string>(), userInterruptedSessions: new Set<string>(),
    sessionRuntimeIdleObservations: new Map<string, number>(), SESSION_RUNTIME_IDLE_CONFIRMATIONS: vectors.idleConfirmations,
    sessionRuntimeAuditInFlight: false, sessionRuntimeAuditTimer: 0, stopEscArmedTurn: null,
    window: { currentSessionId: null, clearTimeout() {} },
    retired: new Set<string>(),
    readRuntime: async () => ({ workingSessionIds: [] as string[] }),
    klausApi: { session: { runtimeState: async () => { calls.runtime++; return context.readRuntime() },
      list: async () => { calls.catalog++; throw Error('A runtime audit must not enumerate the catalog') } } },
    chatStreamStore: { getState: () => ({ sessions: context.streams }) },
    getSessionStream: (id: string) => context.streams[id] || idle(),
    isSessionStreamRetired: (id: string) => context.retired.has(id),
    scheduleSessionRuntimeAudit: () => { calls.scheduled++ },
    updateSidebarWorkingSource: (set: Set<string>, id: string, working: boolean) => { if (working) set.add(id); else set.delete(id) },
    sidebarSessionStatusKind: () => '', markSidebarSessionSeen() {}, syncBusyForCurrentSession() {}, renderSessionList() { calls.rendered++ }, clearStopEscArm() {},
    updateSessionInList: async () => { calls.catalog++ },
    reconcileSessionWorking: async (id: string, working: boolean) => {
      context.streams = { ...context.streams, [id]: working ? live() : idle() }
    },
  }
  const names = ['auditSessionRuntimeState', 'syncSidebarWorkingFromSessions', 'setSessionRunning']
  const declarations = names.map(name => {
    const node = ast.statements.find(value => isFunctionDeclaration(value) && value.name?.text === name)
    if (!node) throw Error(`Missing function: ${name}`)
    return node.getText(ast)
  })
  const actions = runInNewContext(transpileModule(`${declarations.join('\n')}\n({ ${names.join(', ')} })`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText, context) as { auditSessionRuntimeState(): Promise<void>; setSessionRunning(id: string, running: boolean): void }
  return { context, actions, calls }
}

test('runtime recovery handles a large historical catalog without reading it', async () => {
  const f = fixture(), id = f.context.sessions[0]!.id
  f.context.readRuntime = async () => ({ workingSessionIds: [id] })
  await f.actions.auditSessionRuntimeState()
  expect(f.context.runningSessions.has(id)).toBe(true)
  expect(f.context.streams[id]?.running).toBe(true)
  expect(f.calls.catalog).toBe(vectors.expectedCatalogReadsDuringAudit)
  expect(f.context.sessions[1]?.title).toBe('Title 1')
})

test('unchanged runtime snapshots preserve the catalog and skip sidebar rendering', async () => {
  const f = fixture(), rows = f.context.sessions
  await f.actions.auditSessionRuntimeState()
  await f.actions.auditSessionRuntimeState()
  expect(f.context.sessions).toBe(rows)
  expect(f.calls.rendered).toBe(0)
  expect(f.calls.catalog).toBe(0)
})

test('a missed terminal event settles only after two successful idle observations', async () => {
  const f = fixture(), id = f.context.sessions[0]!.id
  f.context.streams[id] = live()
  f.actions.setSessionRunning(id, true)
  await f.actions.auditSessionRuntimeState()
  expect(f.context.runningSessions.has(id)).toBe(true)
  await f.actions.auditSessionRuntimeState()
  expect(f.context.runningSessions.has(id)).toBe(false)
  expect(f.context.streams[id]?.running).toBe(false)
  expect(f.calls.catalog).toBe(0)
})

test('host snapshots cannot settle a provisional draft before session creation completes', async () => {
  const f = fixture(), id = 'provisional-draft'
  f.context.streams[id] = { ...live(), provisional: true }
  await f.actions.auditSessionRuntimeState()
  await f.actions.auditSessionRuntimeState()
  expect(f.context.streams[id]?.running).toBe(true)
  expect(f.context.sessionRuntimeIdleObservations.size).toBe(0)
  expect(f.calls.catalog).toBe(0)
})

test('failed audits keep running state and retry without counting an idle observation', async () => {
  const f = fixture(), id = f.context.sessions[0]!.id
  f.context.streams[id] = live()
  f.actions.setSessionRunning(id, true)
  f.context.readRuntime = async () => { throw Error('Host unavailable') }
  await f.actions.auditSessionRuntimeState()
  expect(f.context.runningSessions.has(id)).toBe(true)
  expect(f.context.sessionRuntimeIdleObservations.size).toBe(0)
  expect(f.context.sessionRuntimeAuditInFlight).toBe(false)
  expect(f.calls.scheduled).toBeGreaterThan(0)
})

test('late idle snapshots cannot settle a newer turn or reuse an old idle confirmation', async () => {
  const f = fixture(), id = f.context.sessions[0]!.id
  f.context.streams[id] = live('old-turn')
  f.actions.setSessionRunning(id, true)
  await f.actions.auditSessionRuntimeState()
  const pending = deferred<{ workingSessionIds: string[] }>()
  f.context.readRuntime = () => pending.promise
  const audit = f.actions.auditSessionRuntimeState()
  f.context.streams = { ...f.context.streams, [id]: live('new-turn') }
  pending.resolve({ workingSessionIds: [] })
  await audit
  expect(f.context.streams[id]?.activeTurnId).toBe('new-turn')
  expect(f.context.runningSessions.has(id)).toBe(true)
  expect(f.context.sessionRuntimeIdleObservations.size).toBe(0)
})

test('late working snapshots cannot revive a completed or deleted conversation', async () => {
  for (const retired of [false, true]) {
    const f = fixture(), id = f.context.sessions[0]!.id
    f.context.streams[id] = live()
    f.actions.setSessionRunning(id, true)
    const pending = deferred<{ workingSessionIds: string[] }>()
    f.context.readRuntime = () => pending.promise
    const audit = f.actions.auditSessionRuntimeState()
    f.context.streams = { ...f.context.streams, [id]: { ...idle(), lastTerminalStatus: 'completed' } }
    f.actions.setSessionRunning(id, false)
    if (retired) f.context.retired.add(id)
    pending.resolve({ workingSessionIds: [id] })
    await audit
    expect(f.context.runningSessions.has(id)).toBe(false)
    expect(f.context.streams[id]?.running).toBe(false)
  }
})

test('newly discovered running conversations request metadata once and concurrent audits do not overlap', async () => {
  const f = fixture(), pending = deferred<{ workingSessionIds: string[] }>()
  f.context.readRuntime = () => pending.promise
  const audit = f.actions.auditSessionRuntimeState()
  await f.actions.auditSessionRuntimeState()
  expect(f.calls.runtime).toBe(1)
  pending.resolve({ workingSessionIds: ['external-chat'] })
  await audit
  expect(f.context.runningSessions.has('external-chat')).toBe(true)
  expect(f.calls.catalog).toBe(1)
})
