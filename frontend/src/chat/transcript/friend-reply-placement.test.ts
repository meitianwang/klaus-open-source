import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import contract from '../../../../contracts/vectors/friend-reply-placement-vectors.json'
import type { Unit } from './TranscriptView'

let foldTurnGroups: typeof import('./TranscriptView')['foldTurnGroups']
let foldUnits: typeof import('./TranscriptView')['foldUnits']
let unitsFromMessages: typeof import('./TranscriptView')['unitsFromMessages']
let originalWindow: PropertyDescriptor | undefined
beforeAll(async () => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    currentLang: 'en', addEventListener: () => {}, klaus: { media: { url: (path: string) => path } },
  } })
  ;({ foldTurnGroups, foldUnits, unitsFromMessages } = await import('./TranscriptView'))
})
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

const send = (turnId = 'work', requestId = 'request-a', onReply = 'display') => ({
  role: 'assistant', turnId, contentBlocks: [
    { type: 'tool_use', id: `send-${requestId}`, name: 'send_message_to_friend',
      input: { friendId: 'friend-a', intent: 'request', onReply, prompt: 'Check the build.' },
      __result: { content: [{ type: 'text', text: JSON.stringify({ accepted: true, requestId, friendId: 'friend-a' }) }] } },
  ],
})
const final = (turnId = 'work', explicit = true) => ({ role: 'assistant', turnId,
  contentBlocks: [{ type: 'text', text: `Final answer for ${turnId}.`, ...(explicit ? { phase: 'final_answer' } : {}) }],
  isFinalReply: explicit,
})
const arrival = (extra = {}, turnId = 'delivery') => ({ role: 'user', turnId, uuid: `reply-${turnId}`,
  text: '<friend-message>Build checked.</friend-message>', localRender: {
    externalFriendMessage: true, replyToRequestId: 'request-a', replyType: 'completed',
    sender: { friendshipId: 'friend-a', displayName: 'Reviewer' }, displayText: 'Build checked.', ...extra,
  },
})
const opener = (turnId = 'work') => ({ role: 'user', turnId, uuid: `owner-${turnId}`, text: 'Investigate the build.' })
const history = (extra = {}, explicit = true) => [opener(), send(), final('work', explicit), arrival(extra)]
const folded = (nodes: ReturnType<typeof foldUnits>) => nodes.find(node => node.kind === 'turn-fold') as Extract<ReturnType<typeof foldUnits>[number], { kind: 'turn-fold' }>
const replyUnits = (nodes: any[]): Unit[] => nodes.flatMap(node => [
  ...(node.kind === 'unit' && node.unit.msg?.localRender?.externalFriendMessage ? [node.unit] : []),
  ...(node.items ? replyUnits(node.items) : []),
])

describe('friend reply process placement', () => {
  test('a late display reply folds into the requesting process and retains its stored identity', () => {
    expect(contract.rules.placement).toBe('requesting-turn-process-disclosure')
    const units = unitsFromMessages(history())
    const before = JSON.stringify(units)
    const groups = foldTurnGroups(units, null, { work: 'completed', delivery: 'completed' }, {}, {}, { work: 1234, delivery: 0 })
    expect(groups.map(group => group.turnId)).toEqual(['work'])
    const fold = folded(groups[0].nodes)
    expect(fold.open).toBe(false)
    expect(fold.durationMs).toBe(1234)
    expect(fold.messageCount).toBe(2)
    expect(replyUnits(fold.items).map(unit => unit.key)).toEqual(['reply-delivery'])
    expect(replyUnits(fold.items)[0]).toMatchObject({ turnId: 'delivery', friendReplyInProcess: true })
    expect(replyUnits(groups[0].nodes.filter(node => node.kind !== 'turn-fold'))).toEqual([])
    expect(groups[0].nodes.at(-1)).toMatchObject({ kind: 'turn-changes', turnId: 'work' })
    expect(JSON.stringify(units)).not.toContain('friendReplyInProcess')
    expect(JSON.parse(before).find((unit: Unit) => unit.key === 'reply-delivery')).toEqual(units.find(unit => unit.key === 'reply-delivery'))
  })

  test('manual expansion and history reload retain the same fold key and reply', () => {
    const rows = history()
    const render = (open: boolean) => foldUnits(unitsFromMessages(JSON.parse(JSON.stringify(rows))), null,
      { work: 'completed', delivery: 'completed' }, { 'turn:work': !open })
    expect(folded(render(false)).open).toBe(false)
    expect(folded(render(true)).open).toBe(true)
    expect(folded(render(true)).foldKey).toBe('turn:work')
    expect(replyUnits(render(true)).map(unit => unit.key)).toEqual(['reply-delivery'])
    expect(replyUnits(render(false)).map(unit => unit.key)).toEqual(['reply-delivery'])
  })

  test('legacy final text remains outside the fold after a late reply', () => {
    const nodes = foldUnits(unitsFromMessages(history({}, false)), null, { work: 'completed' }, {})
    expect(nodes.some(node => node.kind === 'unit' && node.unit.type === 'text')).toBe(true)
    expect(folded(nodes).open).toBe(false)
    expect(replyUnits(folded(nodes).items)).toHaveLength(1)
  })

  test('late replies stay with the exact requesting turn across intervening owner turns', () => {
    const nodes = foldTurnGroups(unitsFromMessages([
      opener(), send(), final(), opener('other'), send('other', 'request-b'), final('other'),
      arrival({}, 'reply-a'), arrival({ replyToRequestId: 'request-b' }, 'reply-b'),
    ]), null, { work: 'completed', other: 'completed' }, {})
    expect(nodes.map(group => group.turnId)).toEqual(['work', 'other'])
    expect(replyUnits(folded(nodes[0].nodes).items).map(unit => unit.key)).toEqual(['reply-reply-a'])
    expect(replyUnits(folded(nodes[1].nodes).items).map(unit => unit.key)).toEqual(['reply-reply-b'])
  })

  test('multiple device results preserve arrival order without duplicate groups', () => {
    const nodes = foldUnits(unitsFromMessages([...history(), arrival({}, 'second-device')]), null, { work: 'completed' }, {})
    expect(replyUnits(folded(nodes).items).map(unit => unit.key)).toEqual(['reply-delivery', 'reply-second-device'])
  })

  for (const replyType of contract.terminalReplies) test(`${replyType} result belongs to the requesting process`, () => {
    const nodes = foldUnits(unitsFromMessages(history({ replyType })), null, { work: 'completed' }, {})
    expect(replyUnits(folded(nodes).items)).toHaveLength(1)
  })

  for (const scenario of contract.unassociatedArrivals) test(`${scenario} remains a standalone message`, () => {
    let rows: any[] = history()
    if (scenario === 'missing-request') rows = [arrival()]
    if (scenario === 'different-friend') rows = history({ sender: { friendshipId: 'friend-b' } })
    if (scenario === 'human-request') rows = [opener(), final(), arrival()]
    if (scenario === 'new-request') rows = history({ replyToRequestId: undefined, replyType: undefined, friendIntent: 'request' })
    if (scenario === 'notice') {
      rows[1].contentBlocks[0].input.intent = 'notice'
      rows[3] = arrival({ friendIntent: 'notice' })
    }
    if (scenario === 'needs-input') rows = history({ replyType: 'needs_input' })
    if (scenario === 'progress') rows = history({ replyType: 'progress' })
    if (scenario === 'local-status') rows = history({ replyType: undefined, friendStatus: 'failed', statusDetail: 'Send failed.' })
    if (scenario === 'unknown-reply') rows = history({ replyType: 'unknown' })
    if (scenario === 'failed-send') rows[1].contentBlocks[0].__result = { is_error: true, content: [{ type: 'text', text: 'Send failed.' }] }
    const groups = foldTurnGroups(unitsFromMessages(rows), null, { work: 'completed', delivery: 'completed' }, {})
    expect(replyUnits(groups.at(-1)!.nodes.filter(node => node.kind !== 'turn-fold'))).toHaveLength(1)
  })

  test('loading the missing request page rehomes the existing reply exactly once', () => {
    const reply = arrival()
    expect(foldTurnGroups(unitsFromMessages([reply]), null, {}, {})[0].turnId).toBe('delivery')
    const nodes = foldTurnGroups(unitsFromMessages([...history().slice(0, 3), reply]), null, { work: 'completed' }, {})
    expect(nodes.map(group => group.turnId)).toEqual(['work'])
    expect(replyUnits(nodes.flatMap(group => group.nodes))).toHaveLength(1)
  })

  test('replies do not cross an unloaded history island boundary', () => {
    expect(contract.rules.historyGap).toBe('do-not-cross')
    const args: Parameters<typeof foldTurnGroups> = [unitsFromMessages(history()), null, { work: 'completed', delivery: 'completed' }, {}]
    args[16] = new Set(['delivery'])
    const groups = foldTurnGroups(...args)
    expect(groups.map(group => group.turnId)).toEqual(['work', 'delivery'])
    expect(replyUnits(groups[1].nodes)).toHaveLength(1)
    expect(replyUnits(folded(groups[0].nodes).items)).toHaveLength(0)
  })

  test('requests inside a later island can still own replies within that island', () => {
    const args: Parameters<typeof foldTurnGroups> = [unitsFromMessages([
      opener('older'), final('older'), ...history(),
    ]), null, { older: 'completed', work: 'completed', delivery: 'completed' }, {}]
    args[16] = new Set(['work'])
    const groups = foldTurnGroups(...args)
    expect(groups.map(group => group.turnId)).toEqual(['older', 'work'])
    expect(replyUnits(folded(groups[1].nodes).items)).toHaveLength(1)
  })

  test('a reply in its requesting turn is process evidence and keeps its arrival position', () => {
    const nodes = foldUnits(unitsFromMessages([opener(), send(), arrival({}, 'work'),
      { role: 'assistant', turnId: 'work', contentBlocks: [{ type: 'text', phase: 'commentary', text: 'Reviewed the result.' }] }, final(),
    ]), null, { work: 'completed' }, {})
    const fold = folded(nodes)
    expect(fold.messageCount).toBe(3)
    expect(replyUnits(fold.items)[0].friendReplyInProcess).toBe(true)
  })

  test('automatic continuation keeps its final answer in its own turn', () => {
    const nodes = foldTurnGroups(unitsFromMessages([opener(), send('work', 'request-a', 'follow_up'), final(), arrival(),
      { role: 'user', turnId: 'continuation', text: 'Continue with the result.', localRender: { friendContinuation: true } },
      final('continuation'),
    ]), null, { work: 'completed', continuation: 'completed' }, {})
    expect(nodes.map(group => group.turnId)).toEqual(['work', 'continuation'])
    expect(replyUnits(folded(nodes[0].nodes).items)).toHaveLength(1)
    expect(nodes[1].nodes.some(node => node.kind === 'unit' && node.unit.type === 'text')).toBe(true)
  })

  test('an incoming reply that directly opens model work retains its own opener', () => {
    const groups = foldTurnGroups(unitsFromMessages([opener(), send(), final(), arrival(), final('delivery')]), null,
      { work: 'completed', delivery: 'completed' }, {})
    expect(groups.map(group => group.turnId)).toEqual(['work', 'delivery'])
    expect(replyUnits(groups[1].nodes.filter(node => node.kind !== 'turn-fold'))).toHaveLength(1)
  })
})
