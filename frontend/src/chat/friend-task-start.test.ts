import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { FriendsRuntimeSnapshot, FriendTaskSummary, FriendTaskGrant } from '../../../shared/friends'
import vectors from '../../../contracts/vectors/friends-messaging-vectors.json'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const grant: FriendTaskGrant = { deviceId: 'receiver', mode: 'manual', apps: [], directories: [], computerUse: false, remember: false }
const task = (id: string): FriendTaskSummary => ({ id, requestId: id, threadId: `chat-${id}`, friendId: 'friend', senderUserId: 'peer', senderDisplayName: 'Friend', senderAvatarUrl: null, receiverDeviceId: 'receiver', status: 'pending', prompt: 'Review the notes', createdAt: 1, updatedAt: 1 })
const snapshot = (row: FriendTaskSummary): FriendsRuntimeSnapshot => ({ signedIn: true, currentDeviceId: 'receiver', receiver: null, tasks: [row], templates: [], outgoing: [], defaultGrant: grant, friendFilesRoot: null, executionTargets: { projects: [], workspaces: [] } })
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const previousWindow = globalThis.window
;(globalThis as any).window = previousWindow ?? { addEventListener() {} }
const stream = await import('./stream-store')
;(globalThis as any).window = previousWindow
beforeAll(() => { (globalThis as any).window = { klaus: { session: { history: async () => [] } }, addEventListener() {} } })
afterAll(() => { (globalThis as any).window = previousWindow })

function fixture(row: FriendTaskSummary) {
  const ack = deferred<FriendsRuntimeSnapshot>()
  const listeners = new Set<() => void>()
  let current = row, calls = 0, cancels = 0
  const bridge = { klaus: { friends: {
    approve: () => { calls++; return ack.promise },
    cancel: async () => { cancels++; current = { ...current, status: 'cancelled', updatedAt: 3 }; return snapshot(current) },
  } }, showToast() {} }
  const inbox = {
    subscribeFriendInbox: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    friendTaskById: () => current,
    applyFriendInboxReceipt: (next: FriendsRuntimeSnapshot) => { current = next.tasks[0]; for (const listener of listeners) listener() },
  }
  const source = readFileSync(new URL('./friend-task-start.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const controller = {} as typeof import('./friend-task-start')
  new Function('exports', 'require', 'window', js)(controller, (name: string) => name === './friend-inbox' ? inbox : stream, bridge)
  return { controller, ack, inbox, get calls() { return calls }, get cancels() { return cancels } }
}

describe('friend approval starts an ordinary pending turn immediately', () => {
  test('the contract pins click feedback, one message and cancellation', () => {
    expect(vectors.approvalStartup).toMatchObject({ feedback: 'synchronous-ordinary-pending-turn', clock: 'owner-click-through-engine-admission', message: 'reuse-existing-friend-message', stop: 'cancel-owned-task-during-preparation' })
  })

  test('a delayed approval immediately starts the clock without duplicating the parked message', async () => {
    const row = task('delayed-approval'), f = fixture(row), id = row.threadId!
    const clickedAt = Date.now()
    const work = f.controller.approveFriendTask(row, grant)
    const started = stream.getSessionStream(id)
    expect(f.calls).toBe(1)
    expect(started).toMatchObject({ running: true, activityVisible: true, streamMode: 'requesting' })
    expect(started.turnStartedAt).toBeGreaterThanOrEqual(clickedAt)
    expect(started.liveUnits).toHaveLength(0)
    stream.ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'idle' })
    await stream.reconcileSessionWorking(id, false)
    expect(stream.getSessionStream(id).running).toBe(true)
    f.ack.resolve(snapshot({ ...row, status: 'starting', grant, updatedAt: 2 }))
    await work
    expect(stream.getSessionStream(id).running).toBe(true)
    stream.ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId: 'approved-turn' })
    expect(stream.getSessionStream(id).turnStartedAt).toBe(started.turnStartedAt)
    expect(stream.getSessionStream(id).turnWorkStartedAtMs['approved-turn']).toBe(started.turnStartedAt)
  })

  test('approval failure restores idle and leaves the friend message available for retry', async () => {
    const row = task('approval-failure'), f = fixture(row), id = row.threadId!
    const work = f.controller.approveFriendTask(row, grant)
    f.ack.reject(new Error('Approval unavailable'))
    expect(await work.then(() => '', error => error.message)).toBe('Approval unavailable')
    expect(stream.getSessionStream(id)).toMatchObject({ running: false, activityVisible: false, turnStartedAt: 0 })
    expect(stream.getSessionStream(id).liveUnits).toHaveLength(0)
  })

  test('a task failure before any engine frame settles startup even after the card is gone', async () => {
    const row = task('execution-failure'), f = fixture(row), id = row.threadId!
    const work = f.controller.approveFriendTask(row, grant)
    f.ack.resolve(snapshot({ ...row, status: 'starting', grant, updatedAt: 2 }))
    await work
    f.inbox.applyFriendInboxReceipt(snapshot({ ...row, status: 'failed', grant, updatedAt: 3, error: 'The friendship was revoked' }))
    expect(stream.getSessionStream(id).running).toBe(false)
    expect(stream.getSessionStream(id).liveUnits).toHaveLength(1)
    expect(stream.getSessionStream(id).liveUnits[0]).toMatchObject({ type: 'live-error', text: 'The friendship was revoked' })
  })

  test('a late approval acknowledgement cannot restart a turn that already finished', async () => {
    const row = task('late-ack'), f = fixture(row), id = row.threadId!
    const work = f.controller.approveFriendTask(row, grant)
    stream.ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId: 'fast-turn' })
    stream.ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'idle', turnId: 'fast-turn' })
    f.ack.resolve(snapshot({ ...row, status: 'running', grant, updatedAt: 2 }))
    await work
    expect(stream.getSessionStream(id).running).toBe(false)
    expect(f.controller.stopPendingFriendTask(id)).toBe(false)
  })

  test('stop during approval cancels its task before a delayed acknowledgement', async () => {
    const row = task('stop-before-ack'), f = fixture(row), id = row.threadId!
    const work = f.controller.approveFriendTask(row, grant)
    expect(f.controller.stopPendingFriendTask(id)).toBe(true)
    await flush()
    expect(f.cancels).toBe(1)
    expect(stream.getSessionStream(id).running).toBe(false)
    f.ack.resolve(snapshot({ ...row, status: 'starting', grant, updatedAt: 2 }))
    await work
    expect(f.cancels).toBe(1)
    expect(stream.getSessionStream(id).running).toBe(false)
  })

  test('a failed approval cannot reset an already running conversation or steal its stop control', async () => {
    const row = task('busy-conversation'), f = fixture(row), id = row.threadId!
    stream.ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId: 'owner-turn' })
    const clock = stream.getSessionStream(id).turnStartedAt
    const work = f.controller.approveFriendTask(row, grant)
    expect(f.controller.stopPendingFriendTask(id)).toBe(false)
    f.ack.reject(new Error('Task changed'))
    expect(await work.then(() => '', error => error.message)).toBe('Task changed')
    expect(stream.getSessionStream(id)).toMatchObject({ running: true, activeTurnId: 'owner-turn', turnStartedAt: clock })
  })
})
