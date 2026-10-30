import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import vector from '../../../../contracts/vectors/planning-goals-vectors.json'
import type { LiveUnit, ToolCardState } from '../stream-store'
import { goalCompletionsByTurn } from './goal-completion'

let previousWindow: typeof globalThis.window
let transcript: typeof import('./TranscriptView')
let factories: typeof import('./factories')
beforeAll(async () => {
  previousWindow = globalThis.window
  ;(globalThis as any).window = { addEventListener() {}, currentLang: 'en' }
  transcript = await import('./TranscriptView')
  factories = await import('./factories')
})
beforeEach(() => { (window as any).currentLang = 'en' })
afterAll(() => {
  if (previousWindow === undefined) delete (globalThis as any).window; else globalThis.window = previousWindow
})
const contract = vector.goalCompletionPresentation
const goal = { goalId: 'achievement', threadId: 'thread', objective: 'Objective must stay out of the answer footer', status: 'complete' as const, tokenBudget: 1000, tokensUsed: 998, timeUsedSeconds: contract.durationSeconds, createdAtMs: 1, updatedAtMs: 2 }
const completion = { goalId: goal.goalId, durationSeconds: goal.timeUsedSeconds }
const call = { type: 'tool_use', id: 'complete-call', name: 'update_goal', input: { status: 'complete' }, __result: { text: JSON.stringify({ ok: true, goal }), isError: false } }
const snapshot = { role: 'assistant', uuid: 'snapshot', turnId: 'finished', contentBlocks: [{ type: 'goal_completion', goal }] }
const answer = (turnId = 'finished', uuid = 'answer') => ({ role: 'assistant', uuid, turnId, isFinalReply: true, text: 'Delivered result', contentBlocks: [{ type: 'text', messageId: uuid, text: 'Delivered result', phase: 'final_answer' }] })
const history = () => [{ role: 'assistant', uuid: 'tools', turnId: 'finished', contentBlocks: [call] }, answer(), snapshot]
const flatten = (nodes: any[]): any[] => nodes.flatMap(node => [node, ...(node.items ? flatten(node.items) : [])])
const savedOutcomes = (messages: any[], running = false, statuses = {}) => flatten(transcript.foldUnits(transcript.unitsFromMessages(messages), running ? { turnId: 'finished' } : null, statuses, {})).filter(node => node.kind === 'unit' && node.unit.goalCompletion)
const tool: ToolCardState = { toolCallId: call.id, toolName: call.name, args: call.input, content: call.__result.text, status: 'ok', argsDelta: '', progress: [], agent: false, bgTask: false }
const live = (): LiveUnit[] => [
  { type: 'live-tools', key: 'tools', turnId: 'finished', order: [call.id], sealed: true },
  { type: 'live-text', key: 'answer', turnId: 'finished', text: 'Delivered result', phase: 'final_answer', streaming: false, turnTail: { ts: 10, meta: null } },
  { type: 'live-goal-completion', key: 'completion', goal },
]
const liveOutcomes = (units: LiveUnit[], running = false, summaries?: ReturnType<typeof transcript.transcriptGoalCompletions>) => flatten(transcript.groupLiveActivityUnits(units, { [call.id]: tool }, running, false, false, new Set(), null, {}, null, {}, false, null, summaries)).filter(node => node.kind === 'unit' && node.unit.goalCompletion)

test('completion accounting is appended inside the answer action row in both locales', () => {
  expect(contract.standaloneCard).toBe(false)
  for (const locale of ['en', 'zh'] as const) {
    ;(window as any).currentLang = locale
    const html = factories.renderMsgActionsHtml({ ts: 0, kind: 'assistant', copyText: 'Delivered result', archived: false, running: false, goalCompletion: completion })
    expect(html).toContain('class="msg-actions"')
    expect(html).toContain(`>${contract[locale]}<`)
    expect(html).not.toContain(goal.objective)
    expect(html).not.toContain('<section')
  }
  ;(window as any).currentLang = 'en'
})

test('saved completion belongs once to its final answer and never to a later turn', () => {
  const messages = [...history(), answer('unrelated', 'later-answer'), snapshot]
  const outcomes = savedOutcomes(messages)
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0].unit).toMatchObject({ key: 'message:answer', turnId: 'finished', goalCompletion: completion })
  expect(transcript.unitsFromMessages(messages).find(unit => unit.type === 'goal-completion')?.segment?.goal).toEqual(goal)
})

test('live success and repeated completion snapshots decorate one settled answer', () => {
  const units = live()
  units.push(units[2])
  expect(liveOutcomes(units).map(node => node.unit.goalCompletion)).toEqual([completion])
  expect(liveOutcomes(units, true)).toEqual([])
  const later = { ...units[1], key: 'later', turnId: 'unrelated' } as LiveUnit
  expect(liveOutcomes([...units, later]).map(node => node.unit.turnId)).toEqual(['finished'])
})

test('a snapshot echo resolves only through a matching successful tool or explicit source turn', () => {
  const orphan = { ...snapshot, turnId: undefined }
  expect(savedOutcomes([orphan, answer('unrelated')])).toEqual([])
  expect(liveOutcomes([live()[2], { ...live()[1], turnId: 'unrelated' }])).toEqual([])
  expect(savedOutcomes([...history().slice(0, 2), orphan])).toHaveLength(1)
  expect(goalCompletionsByTurn([{ completion, snapshot: true }]).size).toBe(0)
})

test('history and live layers share completion metadata through either ownership handoff', () => {
  const saved = transcript.unitsFromMessages([snapshot])
  const current = [live()[1]]
  const shared = transcript.transcriptGoalCompletions(saved, current)
  expect(liveOutcomes(current, false, shared).map(node => node.unit.goalCompletion)).toEqual([completion])
  const historicalAnswer = transcript.unitsFromMessages([answer()])
  const late = { ...live()[2], turnId: 'finished' } as LiveUnit
  const lateMap = transcript.transcriptGoalCompletions(historicalAnswer, [late])
  const nodes = flatten(transcript.foldUnits(historicalAnswer, null, {}, {}, {}, {}, {}, new Set(), {}, null, undefined, {}, {}, new Set(), {}, lateMap))
  expect(nodes.filter(node => node.unit?.goalCompletion).map(node => node.unit.goalCompletion)).toEqual([completion])
})

test('failed updates, active turns and outcomes without final answers do not claim achievement', () => {
  expect(savedOutcomes(history(), true)).toEqual([])
  expect(savedOutcomes(history(), false, { finished: 'failed' })).toEqual([])
  expect(savedOutcomes(history(), false, { finished: 'interrupted' })).toEqual([])
  expect(savedOutcomes([snapshot])).toEqual([])
  const failed = { ...call, __result: { text: 'Rejected', isError: true } }
  expect(savedOutcomes([{ role: 'assistant', turnId: 'finished', contentBlocks: [failed] }, answer()])).toEqual([])
  expect(liveOutcomes(live().filter(unit => unit.type !== 'live-text'))).toEqual([])
})

test('older tool-only results and missing durations use the same footer without inventing time', () => {
  const legacy = { ...call, __result: { text: 'Goal complete: used 1 tokens over 61 seconds.', isError: false } }
  expect(savedOutcomes([{ role: 'assistant', turnId: 'finished', contentBlocks: [legacy] }, answer()])[0].unit.goalCompletion.durationSeconds).toBe(61)
  const html = factories.renderMsgActionsHtml({ ts: 0, kind: 'assistant', copyText: 'Done', archived: false, running: false, goalCompletion: { durationSeconds: null } })
  expect(html).toContain('>Goal achieved<')
  expect(html).not.toContain('0 sec')
})
