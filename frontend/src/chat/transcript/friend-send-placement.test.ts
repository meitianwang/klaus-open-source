// A friend send is process evidence like any other tool call: it keeps its
// arrival position inside the turn's process disclosure in both projections,
// and folds away with the turn once it settles. Lifting settled sends out of
// the process region put them below commentary that chronologically followed
// them (a retry note above the failure it reacts to) and left the cards
// unfolded after the turn completed.
import { describe, expect, test } from 'bun:test'
import type { LiveUnit, ToolCardState } from '../stream-store'

;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {}, currentLang: 'en', klaus: { media: { url: (p: string) => p } } }

const { unitsFromMessages, foldUnits, groupLiveActivityUnits } = await import('./TranscriptView')

const replay = (content: any[]): any => ({ role: 'assistant', contentBlocks: content, turnId: 'turn-1', isFinalReply: true })
const reply = { accepted: true, delivered: true, friendId: 'friend-a', friendName: 'Nick', prompt: 'The build fails on Node 18.' }

// Tool call ids in render order, descending through fold and activity nodes.
const collectToolIds = (nodes: any[]): string[] => nodes.flatMap((node: any) => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node.order)) return node.order
  if (node.segment?.tools) return node.segment.tools.map((tool: any) => tool.toolCallId)
  if (node.kind === 'unit' && node.unit) return collectToolIds([node.unit])
  if (Array.isArray(node.items)) return collectToolIds(node.items)
  if (Array.isArray(node.units)) return collectToolIds(node.units)
  return []
})
const findToolUnit = (nodes: any[], id: string): any => {
  const stack = [...nodes]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node.segment?.tools) && node.segment.tools.some((tool: any) => tool.toolCallId === id)) return node
    if (Array.isArray(node.order) && node.order.includes(id)) return node
    if (node.kind === 'unit' && node.unit) stack.push(node.unit)
    if (Array.isArray(node.items)) stack.push(...node.items)
    if (Array.isArray(node.units)) stack.push(...node.units)
  }
  return undefined
}

describe('saved history', () => {
  const units = unitsFromMessages([replay([
    { type: 'tool_use', id: 'read-1', name: 'read', input: { path: '/src/a.ts' }, __result: { content: [{ type: 'text', text: 'contents' }] } },
    { type: 'tool_use', id: 'reply-1', name: 'reply_to_friend', input: { prompt: 'The build fails on Node 18.' }, __result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } },
    { type: 'tool_use', id: 'read-2', name: 'read', input: { path: '/src/b.ts' }, __result: { content: [{ type: 'text', text: 'more' }] } },
    { type: 'text', text: 'Investigated and told Nick.', phase: 'final_answer', isFinalReply: true },
  ])])

  test('a settled reply keeps its arrival position inside the fold', () => {
    const nodes = foldUnits(units, null, { 'turn-1': 'completed' }, {})
    // Nothing is parked between the fold and the final answer.
    expect(nodes.findIndex(node => node.kind === 'turn-fold')).toBe(0)
    expect(nodes.findIndex(node => node.kind === 'unit' && node.unit.type === 'text')).toBe(1)
    expect(nodes.some(node => node.kind === 'unit' && node.unit.type === 'tools')).toBe(false)
    const fold = nodes[0] as Extract<(typeof nodes)[number], { kind: 'turn-fold' }>
    expect(collectToolIds(fold.items)).toEqual(['read-1', 'reply-1', 'read-2'])
    expect(fold.messageCount).toBe(3)
    // The fold renders each call under its own key, so disclosure state follows the row.
    expect(findToolUnit(fold.items, 'reply-1')?.key).toBe('tool:reply-1')
  })

  test('every friend send kind stays in call order among the process units', () => {
    const many = unitsFromMessages([replay([
      { type: 'tool_use', id: 'ask-1', name: 'ask_friend_for_information', input: { question: 'Which branch?' }, __result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } },
      { type: 'tool_use', id: 'read-1', name: 'read', input: { path: '/src/a.ts' }, __result: { content: [{ type: 'text', text: 'contents' }] } },
      { type: 'tool_use', id: 'progress-1', name: 'send_friend_progress', input: { prompt: 'Halfway' }, __result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } },
      { type: 'tool_use', id: 'send-1', name: 'send_message_to_friend', input: { friendId: 'friend-b', intent: 'request', prompt: 'Can you look?' }, __result: { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] } },
      { type: 'text', text: 'Done.', phase: 'final_answer', isFinalReply: true },
    ])])
    const nodes = foldUnits(many, null, { 'turn-1': 'completed' }, {})
    expect(nodes.some(node => node.kind === 'unit' && node.unit.type === 'tools')).toBe(false)
    const fold = nodes.find(node => node.kind === 'turn-fold') as Extract<(typeof nodes)[number], { kind: 'turn-fold' }>
    expect(collectToolIds(fold.items)).toEqual(['ask-1', 'read-1', 'progress-1', 'send-1'])
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

  test('a settled reply keeps its arrival position inside the process disclosure', () => {
    const tools = {
      read: card('read', 'read', { path: '/src/a.ts' }, 'ok'),
      reply: card('reply', 'reply_to_friend', { prompt: 'The build fails.' }, 'ok', JSON.stringify(reply)),
      more: card('more', 'read', { path: '/src/b.ts' }, 'ok'),
    }
    const units: LiveUnit[] = [{ type: 'live-tools', key: 'calls', order: ['read', 'reply', 'more'], turnId: 'turn', sealed: true }, final]
    const nodes = groupLiveActivityUnits(units, tools, false, false)
    const kinds = nodes.map(node => node.kind === 'unit' ? `${node.unit.type}:${node.key}` : node.kind)
    expect(kinds).toEqual(['turn', 'live-text:final'])
    const fold = nodes[0] as Extract<(typeof nodes)[number], { kind: 'turn' }>
    expect(collectToolIds(fold.items)).toEqual(['read', 'reply', 'more'])
    expect(fold.messageCount).toBe(3)
  })

  test('a running reply stays in the process region and keeps its place when it settles', () => {
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
    expect(after.some(node => node.kind === 'unit' && node.unit.type === 'live-tools' && node.key === 'reply')).toBe(false)
    const fold = after.find(node => node.kind === 'turn') as Extract<(typeof after)[number], { kind: 'turn' }>
    expect(collectToolIds(fold.items)).toEqual(['read', 'reply'])
  })
})
