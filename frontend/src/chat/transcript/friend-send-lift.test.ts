// A message a friend received is an outward action, so its tool row must be
// visible without opening the turn's process disclosure. These tests pin where
// settled friend sends land in both projections: out of the fold, directly
// above the turn's final answer. A send still running stays in the fold.
import { describe, expect, test } from 'bun:test'
import type { LiveUnit, ToolCardState } from '../stream-store'

;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {}, currentLang: 'en', klaus: { media: { url: (p: string) => p } } }

const { unitsFromMessages, foldUnits, groupLiveActivityUnits } = await import('./TranscriptView')

const replay = (content: any[]): any => ({ role: 'assistant', contentBlocks: content, turnId: 'turn-1', isFinalReply: true })
const reply = { accepted: true, delivered: true, friendId: 'friend-a', friendName: 'Nick', prompt: 'The build fails on Node 18.' }

describe('saved history', () => {
  const units = unitsFromMessages([replay([
    { type: 'tool_use', id: 'read-1', name: 'read', input: { path: '/src/a.ts' }, __result: { content: [{ type: 'text', text: 'contents' }] } },
    { type: 'tool_use', id: 'reply-1', name: 'reply_to_friend', input: { prompt: 'The build fails on Node 18.' }, __result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } },
    { type: 'tool_use', id: 'read-2', name: 'read', input: { path: '/src/b.ts' }, __result: { content: [{ type: 'text', text: 'more' }] } },
    { type: 'text', text: 'Investigated and told Nick.', phase: 'final_answer', isFinalReply: true },
  ])])

  test('a settled reply leaves the fold and sits directly above the final answer', () => {
    const nodes = foldUnits(units, null, { 'turn-1': 'completed' }, {})
    const foldIndex = nodes.findIndex(node => node.kind === 'turn-fold')
    const sendIndex = nodes.findIndex(node => node.kind === 'unit' && node.unit.type === 'tools' && node.unit.segment?.tools?.[0]?.toolName === 'reply_to_friend')
    const finalIndex = nodes.findIndex(node => node.kind === 'unit' && node.unit.type === 'text')
    expect(foldIndex).toBeGreaterThanOrEqual(0)
    expect(sendIndex).toBe(foldIndex + 1)
    expect(finalIndex).toBe(sendIndex + 1)
    const send = nodes[sendIndex] as Extract<(typeof nodes)[number], { kind: 'unit' }>
    // Same key the fold uses for a single-call entry, so disclosure state follows the row.
    expect(send.unit.key).toBe('tool:reply-1')
    expect(send.unit.segment?.tools).toHaveLength(1)
    const fold = nodes[foldIndex] as Extract<(typeof nodes)[number], { kind: 'turn-fold' }>
    const folded = JSON.stringify(fold.items)
    expect(folded).not.toContain('reply_to_friend')
    expect(folded).toContain('read-1')
    expect(folded).toContain('read-2')
    // The fold counts the work it still holds, not the message that left.
    expect(fold.messageCount).toBe(2)
  })

  test('every friend send kind is lifted, in call order', () => {
    const many = unitsFromMessages([replay([
      { type: 'tool_use', id: 'ask-1', name: 'ask_friend_for_information', input: { question: 'Which branch?' }, __result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } },
      { type: 'tool_use', id: 'read-1', name: 'read', input: { path: '/src/a.ts' }, __result: { content: [{ type: 'text', text: 'contents' }] } },
      { type: 'tool_use', id: 'progress-1', name: 'send_friend_progress', input: { prompt: 'Halfway' }, __result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } },
      { type: 'tool_use', id: 'send-1', name: 'send_message_to_friend', input: { friendId: 'friend-b', intent: 'request', prompt: 'Can you look?' }, __result: { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] } },
      { type: 'text', text: 'Done.', phase: 'final_answer', isFinalReply: true },
    ])])
    const nodes = foldUnits(many, null, { 'turn-1': 'completed' }, {})
    const lifted = nodes.flatMap(node => node.kind === 'unit' && node.unit.type === 'tools' ? [node.unit.segment!.tools![0]!.toolCallId] : [])
    expect(lifted).toEqual(['ask-1', 'progress-1', 'send-1'])
  })

  test('a send without a result stays in the fold until it settles', () => {
    const running = unitsFromMessages([{ role: 'assistant', turnId: 'turn-1', contentBlocks: [
      { type: 'tool_use', id: 'read-1', name: 'read', input: { path: '/src/a.ts' }, __result: { content: [{ type: 'text', text: 'contents' }] } },
      { type: 'tool_use', id: 'reply-1', name: 'reply_to_friend', input: { prompt: 'Draft' } },
    ] }])
    const nodes = foldUnits(running, null, { 'turn-1': 'running' }, {})
    expect(nodes.some(node => node.kind === 'unit' && node.unit.type === 'tools' && node.unit.segment?.tools?.[0]?.toolName === 'reply_to_friend')).toBe(false)
    expect(JSON.stringify(nodes)).toContain('reply-1')
  })
})

describe('live stream', () => {
  const card = (id: string, name: string, args: unknown, status: ToolCardState['status'], content?: string): ToolCardState => ({
    toolCallId: id, toolName: name, args, status, argsDelta: '', progress: [], agent: false, bgTask: false, ...(content ? { content } : {}),
  })
  const final: LiveUnit = { type: 'live-text', key: 'final', turnId: 'turn', text: 'Investigated and told Nick.', phase: 'final_answer', streaming: false }

  test('a settled reply is its own node between the fold and the final answer', () => {
    const tools = {
      read: card('read', 'read', { path: '/src/a.ts' }, 'ok'),
      reply: card('reply', 'reply_to_friend', { prompt: 'The build fails.' }, 'ok', JSON.stringify(reply)),
      more: card('more', 'read', { path: '/src/b.ts' }, 'ok'),
    }
    const units: LiveUnit[] = [{ type: 'live-tools', key: 'calls', order: ['read', 'reply', 'more'], turnId: 'turn', sealed: true }, final]
    const nodes = groupLiveActivityUnits(units, tools, false, false)
    const kinds = nodes.map(node => node.kind === 'unit' ? `${node.unit.type}:${node.key}` : node.kind)
    expect(kinds).toEqual(['turn', 'live-tools:reply', 'live-text:final'])
    const send = nodes[1] as Extract<(typeof nodes)[number], { kind: 'unit' }>
    expect(send.unit.type === 'live-tools' && send.unit.order).toEqual(['reply'])
    const fold = nodes[0] as Extract<(typeof nodes)[number], { kind: 'turn' }>
    expect(JSON.stringify(fold.items)).not.toContain('"reply"')
    expect(fold.messageCount).toBe(2)
  })

  test('a running reply stays in the process region and keeps its key when it settles', () => {
    const running = {
      read: card('read', 'read', { path: '/src/a.ts' }, 'ok'),
      reply: card('reply', 'reply_to_friend', { prompt: 'The build fails.' }, 'running'),
    }
    const units: LiveUnit[] = [{ type: 'live-tools', key: 'calls', order: ['read', 'reply'], turnId: 'turn', sealed: false }]
    const before = groupLiveActivityUnits(units, running, true, false)
    expect(before.some(node => node.kind === 'unit' && node.unit.type === 'live-tools' && node.key === 'reply')).toBe(false)
    expect(JSON.stringify(before)).toContain('reply')
    const settled = { ...running, reply: { ...running.reply, status: 'ok' as const, content: JSON.stringify(reply) } }
    const after = groupLiveActivityUnits(units, settled, true, false)
    const lifted = after.find(node => node.kind === 'unit' && node.unit.type === 'live-tools' && node.unit.order.includes('reply'))
    expect(lifted?.key).toBe('reply')
  })
})
