import { describe, expect, test } from 'bun:test'
import vectors from '../../../contracts/vectors/compaction-lifecycle-vectors.json'
import { subagentStreamId } from './subagent-stream'

;(globalThis as any).window ||= {}
;(globalThis as any).window.addEventListener ||= () => {}
const stream = await import('./stream-store')

function compactions(sessionId: string) {
  return stream.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-compaction')
}

function text(sessionId: string) {
  return stream.getSessionStream(sessionId).liveUnits
    .filter(unit => unit.type === 'live-text').map(unit => unit.text).join('')
}

describe('compaction lifecycle preservation', () => {
  for (const [index, vector] of vectors.projectionCases.entries()) {
    test(vector.name, () => {
      const sessionId = `compaction-vector-${index}`
      const child = vector.scope === 'child'
      const targetId = child ? subagentStreamId(sessionId, 'child') : sessionId
      stream.ingestLocalUserTurn(sessionId, { text: 'Continue the investigation' })
      stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'parent-turn' })
      stream.ingestChatEvent({ sessionId, type: 'text_delta', text: 'Earlier conversation' })
      if (child) stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId: 'child',
        event: { type: 'stream_mode', mode: 'requesting', turnId: 'child-turn' } })
      const events = [...vector.expected, ...(vector.replyEvents ?? [])]
      expect(events).toHaveLength(vector.states.length)
      let loadingKey: string | undefined
      for (const [eventIndex, event] of events.entries()) {
        stream.ingestChatEvent({ ...event, sessionId })
        const expected = vector.states[eventIndex]
        const units = compactions(targetId)
        expect(stream.getSessionStream(targetId).compactionPendingTrigger).toBe(expected.pending)
        expect(units.map(unit => unit.state)).toEqual(expected.compactions)
        if (expected.pending) {
          if (loadingKey) expect(units.at(-1)?.key).toBe(loadingKey)
          loadingKey = units.at(-1)?.key
        } else {
          if (loadingKey && expected.compactions.some(state => state === 'completed')) expect(units.at(-1)?.key).toBe(loadingKey)
          loadingKey = undefined
        }
        expect(text(sessionId)).toBe('Earlier conversation')
        if (child) {
          expect(stream.getSessionStream(sessionId).running).toBe(true)
          expect(stream.getSessionStream(sessionId).compactionPendingTrigger).toBeNull()
          expect(compactions(sessionId)).toHaveLength(0)
        }
      }
      expect(stream.getSessionStream(targetId).historyStale).toBe(true)
    })
  }

  for (const scope of ['main', 'child'] as const) {
    for (const vector of vectors.terminalCases) {
      test(`${scope} ${vector.name} removes pending cleanup and preserves accepted checkpoints`, () => {
        const sessionId = `compaction-terminal-${scope}-${vector.name}`
        const targetId = scope === 'child' ? subagentStreamId(sessionId, 'child') : sessionId
        const send = (event: Record<string, unknown>) => stream.ingestChatEvent(scope === 'child'
          ? { sessionId, type: 'agent_progress', agentId: 'child', event }
          : { sessionId, ...event })
        stream.ingestLocalUserTurn(sessionId, { text: 'Continue the investigation' })
        stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'parent-turn' })
        send({ type: 'stream_mode', mode: 'requesting', turnId: 'target-turn' })
        send({ type: 'text_delta', text: 'Work already shown' })
        send({ type: 'compact_boundary', trigger: 'auto' })
        const completedKey = compactions(targetId)[0]?.key
        send({ type: 'compaction_start', trigger: 'auto' })
        send({ type: 'compaction_start', trigger: 'auto' })
        expect(compactions(targetId).map(unit => unit.state)).toEqual(['completed', 'running'])
        send({ ...vector.event, turnId: 'target-turn' })
        expect(stream.getSessionStream(targetId).compactionPendingTrigger).toBeNull()
        expect(compactions(targetId).map(unit => [unit.key, unit.state])).toEqual([[completedKey, 'completed']])
        expect(stream.getSessionStream(targetId).lastTerminalStatus).toBe(vector.terminalStatus)
        expect(text(targetId)).toBe('Work already shown')
        if (scope === 'child') {
          expect(stream.getSessionStream(sessionId).running).toBe(true)
          expect(compactions(sessionId)).toHaveLength(0)
        }
      })
    }
  }
})
