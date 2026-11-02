import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { FriendsRuntimeSnapshot } from '../../../shared/friends'
import vectors from '../../../contracts/vectors/friends-messaging-vectors.json'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function snapshot(threadId: string | null): FriendsRuntimeSnapshot {
  return {
    signedIn: true, currentDeviceId: 'receiver', tasks: [{
      id: 'request-task', requestId: 'request', friendId: 'friend-a',
      senderUserId: 'peer', senderDisplayName: 'Friend A', threadId, status: 'pending',
      prompt: 'Review the shared notes', createdAt: 10, updatedAt: 10,
    }], templates: [], outgoing: [], defaultGrant: null,
  } as unknown as FriendsRuntimeSnapshot
}

// Run the real inbox with a fresh module state, without leaving bridge stubs or
// subscriptions in other tests' window or module cache.
function inboxFixture(runtime: () => Promise<FriendsRuntimeSnapshot>) {
  const events = new Map<string, () => void>()
  const window = {
    klaus: { friends: { runtime }, on: {
      friendsChanged: (listener: () => void) => { events.set('changed', listener) },
      klausAuthUpdated: (listener: () => void) => { events.set('auth', listener) },
    } },
    addEventListener: (name: string, listener: () => void) => { events.set(name, listener) },
  }
  const source = readFileSync(new URL('./friend-inbox.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {} as typeof import('./friend-inbox')
  new Function('exports', 'window', js)(exports, window)
  return { inbox: exports, events }
}

async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}

describe('friend requests stay reachable after an arrival notice is missed', () => {
  test('the contract keeps discovery independent of notification clicks', () => {
    expect(vectors.friendInboxDiscovery).toMatchObject({
      inboxRefresh: 'reload-authoritative-conversation-list',
      missedArrival: 'recover-on-boot-auth-and-focus',
      concurrentChange: 'read-again-after-inflight-snapshot',
    })
  })

  test('a change during the first read retains the final parked conversation', async () => {
    const first = deferred<FriendsRuntimeSnapshot>()
    let reads = 0
    const { inbox, events } = inboxFixture(() => ++reads === 1 ? first.promise : Promise.resolve(snapshot('parked-chat')))
    inbox.wireFriendInbox()
    await flush()
    events.get('changed')!()
    events.get('changed')!()
    first.resolve(snapshot(null))
    await flush()
    expect(reads).toBe(2)
    expect(inbox.pendingFriendTaskForSession('parked-chat')?.id).toBe('request-task')
  })

  test('a queued arrival retries after an older read fails', async () => {
    const first = deferred<FriendsRuntimeSnapshot>()
    let reads = 0
    const { inbox, events } = inboxFixture(() => ++reads === 1 ? first.promise : Promise.resolve(snapshot('parked-chat')))
    inbox.wireFriendInbox()
    await flush()
    events.get('changed')!()
    first.reject(new Error('The account was still restoring'))
    await flush()
    expect(inbox.pendingFriendTaskForSession('parked-chat')?.requestId).toBe('request')
    expect(reads).toBe(2)
  })

  test('cold start and focus recover saved requests without a notification click', async () => {
    let saved = snapshot('saved-chat')
    const { inbox, events } = inboxFixture(async () => saved)
    inbox.wireFriendInbox()
    await flush()
    expect(inbox.pendingFriendTaskForSession('saved-chat')?.id).toBe('request-task')
    saved = snapshot('arrived-while-closed')
    events.get('focus')!()
    await flush()
    expect(inbox.pendingFriendTaskForSession('arrived-while-closed')?.id).toBe('request-task')
  })

  test('an inbox update discovers new sidebar conversations without navigating', async () => {
    const source = ts.createSourceFile('chat.ts', readFileSync(new URL('./chat.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
    const registration = source.statements.find(statement => ts.isExpressionStatement(statement)
      && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(source) === 'subscribeFriendInbox') as ts.ExpressionStatement
    expect(registration).toBeDefined()
    const callback = (registration.expression as ts.CallExpression).arguments[0]!
    const js = ts.transpileModule(`const changed = ${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    let listed = false
    const rows: string[] = []
    const rendered: string[][] = []
    const changed = new Function('renderSessionList', 'updateSessionInList', `${js}; return changed`)(
      () => { rendered.push([...rows]) },
      async () => { listed = true; rows.push('parked-chat'); rendered.push([...rows]) },
    ) as () => void
    const { inbox } = inboxFixture(async () => snapshot('parked-chat'))
    const unsubscribe = inbox.subscribeFriendInbox(changed)
    await flush()
    expect(listed).toBe(true)
    expect(rendered.at(-1)).toContain('parked-chat')
    expect(inbox.pendingFriendTaskForSession('parked-chat')?.status).toBe('pending')
    unsubscribe()
  })

  test('a conversation asks once and an admitted conversation never asks again', async () => {
    const grant = { deviceId: 'receiver', mode: 'manual' as const, computerUse: false, apps: [], directories: [], remember: false, network: false }
    const tasks = [
      { id: 'later', requestId: 'later', friendId: 'friend-a', senderUserId: 'peer', senderDisplayName: 'Friend A', threadId: 'pending-chat', status: 'pending', prompt: 'later', createdAt: 20, updatedAt: 20 },
      { id: 'earlier', requestId: 'earlier', friendId: 'friend-a', senderUserId: 'peer', senderDisplayName: 'Friend A', threadId: 'pending-chat', status: 'pending', prompt: 'earlier', createdAt: 10, updatedAt: 10 },
      { id: 'completed', requestId: 'completed', friendId: 'friend-a', senderUserId: 'peer', senderDisplayName: 'Friend A', threadId: 'admitted-chat', status: 'completed', replied: true, grant, prompt: 'done', createdAt: 5, updatedAt: 6 },
      { id: 'new-pending', requestId: 'new-pending', friendId: 'friend-a', senderUserId: 'peer', senderDisplayName: 'Friend A', threadId: 'admitted-chat', status: 'pending', prompt: 'next', createdAt: 30, updatedAt: 30 },
      { id: 'failed-without-grant', requestId: 'failed-without-grant', friendId: 'friend-a', senderUserId: 'peer', senderDisplayName: 'Friend A', threadId: 'unapproved-chat', status: 'failed', prompt: 'setup failed', createdAt: 1, updatedAt: 2 },
      { id: 'pending-after-failure', requestId: 'pending-after-failure', friendId: 'friend-a', senderUserId: 'peer', senderDisplayName: 'Friend A', threadId: 'unapproved-chat', status: 'pending', prompt: 'first real request', createdAt: 3, updatedAt: 3 },
      { id: 'failed-with-grant', requestId: 'failed-with-grant', friendId: 'friend-a', senderUserId: 'peer', senderDisplayName: 'Friend A', threadId: 'failed-admitted-chat', status: 'failed', grant, prompt: 'approved failure', createdAt: 4, updatedAt: 4 },
      { id: 'cancelled-with-grant', requestId: 'cancelled-with-grant', friendId: 'friend-a', senderUserId: 'peer', senderDisplayName: 'Friend A', threadId: 'cancelled-admitted-chat', status: 'cancelled', grant, prompt: 'approved cancellation', createdAt: 5, updatedAt: 5 },
    ]
    const { inbox } = inboxFixture(async () => ({
      signedIn: true, currentDeviceId: 'receiver', tasks, templates: [], outgoing: [], defaultGrant: null,
    }) as unknown as FriendsRuntimeSnapshot)
    inbox.wireFriendInbox()
    await flush()
    expect(inbox.pendingFriendTaskForSession('pending-chat')?.id).toBe('earlier')
    expect(inbox.pendingFriendTaskByRequest('pending-chat', 'later')).toBeNull()
    expect(inbox.pendingFriendTaskByRequest('pending-chat', 'earlier')?.id).toBe('earlier')
    expect(inbox.friendConversationAdmitted('admitted-chat')).toBe(true)
    expect(inbox.pendingFriendTaskForSession('admitted-chat')).toBeNull()
    expect(inbox.friendConversationAdmitted('unapproved-chat')).toBe(false)
    expect(inbox.pendingFriendTaskForSession('unapproved-chat')?.id).toBe('pending-after-failure')
    expect(inbox.friendConversationAdmitted('failed-admitted-chat')).toBe(true)
    expect(inbox.friendConversationAdmitted('cancelled-admitted-chat')).toBe(true)
  })
})
