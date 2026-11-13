import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isFunctionDeclaration, transpileModule, ScriptTarget } from 'typescript'
import { clientMessageId as userMessageClientId } from '../../../contracts/message-identity'
let chatStreamStore: typeof import('./stream-store').chatStreamStore
let getSessionStream: typeof import('./stream-store').getSessionStream
let ingestChatEvent: typeof import('./stream-store').ingestChatEvent
let ingestLocalUserTurn: typeof import('./stream-store').ingestLocalUserTurn
let retractLocalUserMessage: typeof import('./stream-store').retractLocalUserMessage

const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true)
const names = new Set(['steerFollowUp', 'renderLocalUserPayload', 'sentUserDisplayMetadata', 'noteLocallySentSteer'])
const declarations: string[] = []
function collect(node: any) {
  if (isFunctionDeclaration(node) && names.has(node.name?.text || '')) declarations.push(node.getText(ast))
  forEachChild(node, collect)
}
collect(ast)
const script = transpileModule(`${declarations.join('\n')}\nsteerFollowUp`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
let previousWindow: PropertyDescriptor | undefined
beforeAll(async () => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  ;(globalThis as any).window = { currentLang: 'en', addEventListener() {} }
  ;({ chatStreamStore, getSessionStream, ingestChatEvent, ingestLocalUserTurn, retractLocalUserMessage } = await import('./stream-store'))
})
afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else delete (globalThis as any).window
})
const turnA = '11111111-1111-4111-8111-111111111111'
const turnB = '22222222-2222-4222-8222-222222222222'
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const id = `steer-${randomUUID()}`
  const stream = getSessionStream(id)
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [id]: { ...stream, running: true,
    activeTurnId: turnA, liveTurnId: turnA, turnStartedAt: 100, turnStartedAtMs: { [turnA]: 100 } } } }))
  const ack = deferred<any>(), calls: any[][] = []
  const context = {
    getSessionStream, ingestChatEvent, ingestLocalUserTurn, retractLocalUserMessage, userMessageClientId,
    crypto: { randomUUID }, locallySentSteerIdsBySession: new Map(), chatStreamStore,
    isSideChatSession: () => true, sideRuntimeForSession: () => ({ preparePlacement() {} }),
    noteCommandReference() {}, window: {}, tt: (key: string) => key,
    klausApi: { chat: { followUp: (...args: any[]) => { calls.push(args); return ack.promise } } },
  }
  const steer = runInNewContext(script, context) as (id: string, payload: any) => Promise<boolean>
  const payload = { finalText: 'Model input', displayText: 'Display snapshot', media: [], liveAttachments: [],
    composerReferences: [{ kind: 'file', value: '/workspace/input.txt' }],
    selectedTextAttachments: [{ text: 'Quoted context', quoteId: 'quote-id' }], pastedCards: [] }
  const users = () => getSessionStream(id).liveUnits.filter(unit => unit.type === 'live-user')
  const canonical = (messageId: string) => ingestChatEvent({ type: 'user_message', sessionId: id, turnId: turnA,
    message: { uuid: randomUUID(), message: { role: 'user', content: 'Model input', steered: true,
      localRender: { clientMessageId: messageId, steerMessageId: messageId, expectedTurnId: turnA, displayText: 'Display snapshot' } } } } as any)
  return { id, ack, calls, payload, steer, users, canonical }
}

test('steer publishes one UUID-owned snapshot before RPC and canonical-before-ACK adopts that row', async () => {
  const f = fixture()
  const pending = f.steer(f.id, f.payload)
  expect(f.users()).toHaveLength(1)
  const row = f.users()[0]
  const metadata = f.calls[0][3]
  expect(metadata.steerMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  expect(userMessageClientId(row.msg)).toBe(metadata.steerMessageId)
  expect(metadata.clientMessageId).toBe(metadata.steerMessageId)
  expect(metadata.expectedTurnId).toBe(turnA)
  expect(row.turnId).toBe(turnA)
  expect(row.msg.localRender?.selectedTextAttachments).toEqual(f.payload.selectedTextAttachments)
  expect(row.msg.localRender?.composerReferences).toEqual(f.payload.composerReferences)
  f.canonical(metadata.clientMessageId)
  expect(f.users()).toHaveLength(1)
  expect(f.users()[0].key).toBe(row.key)
  f.ack.resolve({ ok: true, messageId: metadata.steerMessageId })
  expect(await pending).toBe(true)
  expect(f.users()).toHaveLength(1)
  expect(f.users()[0].key).toBe(row.key)
})

test('a steer awaiting ACK remains attached to its captured turn when a replacement starts', async () => {
  const f = fixture()
  const pending = f.steer(f.id, f.payload)
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [f.id]: { ...getSessionStream(f.id),
    activeTurnId: turnB, liveTurnId: turnB, turnStartedAt: 300, turnStartedAtMs: { [turnA]: 100, [turnB]: 300 } } } }))
  f.ack.resolve({ ok: true, messageId: f.calls[0][3].steerMessageId })
  expect(await pending).toBe(true)
  expect(f.users()).toHaveLength(1)
  expect(f.users()[0].turnId).toBe(turnA)
  expect(getSessionStream(f.id).activeTurnId).toBe(turnB)
  expect(getSessionStream(f.id).turnStartedAt).toBe(300)
})

test('confirmed refusal retracts only its own optimistic steer without clearing running work', async () => {
  const f = fixture()
  ingestLocalUserTurn(f.id, { text: 'Other input', uuid: 'other-input', steered: true, targetTurnId: turnA })
  const pending = f.steer(f.id, f.payload)
  f.ack.resolve({ ok: false, error: 'Confirmed refusal' })
  expect(await pending).toBe(false)
  expect(f.users().map(unit => unit.msg.uuid)).toEqual(['other-input'])
  expect(getSessionStream(f.id).running).toBe(true)
  expect(getSessionStream(f.id).activeTurnId).toBe(turnA)
})

test('lost steer ACK retains its issued identity and keyed delivery notice without resending', async () => {
  const f = fixture()
  const pending = f.steer(f.id, f.payload)
  const id = f.calls[0][3].steerMessageId
  f.ack.reject(new Error('Transport disconnected'))
  expect(await pending).toBe(true)
  expect(f.users()).toHaveLength(1)
  expect(userMessageClientId(f.users()[0].msg)).toBe(id)
  expect(getSessionStream(f.id).liveUnits.some(unit => unit.key === `follow-up-status-${id}` && unit.type === 'live-notice')).toBe(true)
  expect(f.calls).toHaveLength(1)
})

test('a canonical adoption before a contradictory refusal remains consumed and cannot be rolled back', async () => {
  const f = fixture()
  const pending = f.steer(f.id, f.payload)
  f.canonical(f.calls[0][3].steerMessageId)
  const key = f.users()[0].key
  f.ack.resolve({ ok: false, error: 'Late refusal' })
  expect(await pending).toBe(true)
  expect(f.users()).toHaveLength(1)
  expect(f.users()[0].key).toBe(key)
  expect(f.users()[0].optimisticUser).toBe(false)
})
