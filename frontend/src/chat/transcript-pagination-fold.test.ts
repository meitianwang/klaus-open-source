import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fetchTurnItems } from './transcript-pagination'

type TranscriptModule = typeof import('./transcript/TranscriptView')
let transcript: TranscriptModule
let previousWindow: unknown

beforeAll(async () => {
  previousWindow = (globalThis as any).window
  ;(globalThis as any).window = { addEventListener: () => {} }
  transcript = await import('./transcript/TranscriptView')
})
afterAll(() => { (globalThis as any).window = previousWindow })

function nestedUnits(nodes: any[]): any[] {
  return nodes.flatMap(node => node.kind === 'unit' ? [node.unit] : node.items ? nestedUnits(node.items) : [])
}

describe('completed turn pagination and folding', () => {
  for (const withThinking of [false, true]) {
    test(`keeps all paged process inside one closed fold with thinking=${withThinking}`, async () => {
      const turnId = 'completed-turn'
      const rows = [
        { uuid: 'prompt', role: 'user', text: 'Inspect the source.', turnId },
        { uuid: 'progress', role: 'assistant', turnId, contentBlocks: [
          { type: 'text', text: 'Inspecting the source.', phase: 'commentary' },
        ] },
        ...Array.from({ length: 105 }, (_, index) => ({
          uuid: `work-${index}`, role: 'assistant', turnId,
          contentBlocks: [{ type: 'tool_use', id: `read-${index}`, name: 'read',
            input: { path: `/project/file-${index}.ts` }, __result: { text: 'File contents', isError: false } }],
        })),
        { uuid: 'final', role: 'assistant', turnId, isFinalReply: true, contentBlocks: [
          ...(withThinking ? [{ type: 'thinking', thinking: 'Checking the result.' }] : []),
          { type: 'text', text: 'The source inspection is complete.', phase: 'final_answer' },
        ] },
      ]
      let requests = 0
      const api = { session: {
        historyPage: async () => ({}),
        historyItems: async (_sessionId: string, options: any) => {
          requests += 1
          const end = options.cursor ? rows.findIndex(row => row.uuid === options.cursor) : rows.length
          const start = Math.max(0, end - options.limit)
          return { messages: rows.slice(start, end), page: {
            nextCursor: start > 0 ? rows[start].uuid : null,
            hasMore: start > 0, order: 'newest_first',
          } }
        },
      } }

      const loaded = await fetchTurnItems(api, 'session', turnId, 500)
      const nodes = transcript.foldUnits(transcript.unitsFromMessages(loaded.rows), null, { [turnId]: 'completed' }, {})
      const folds = nodes.filter(node => node.kind === 'turn-fold')
      expect(requests).toBe(2)
      expect(folds).toHaveLength(1)
      expect(folds[0]).toMatchObject({ turnId, open: false })
      expect(nodes[0]).toMatchObject({ kind: 'unit', unit: { type: 'user', msg: { uuid: 'prompt' } } })
      const outside = nodes.filter(node => node.kind === 'unit').map(node => node.kind === 'unit' ? node.unit : null)
      expect(outside.filter(unit => unit?.type === 'tools' || unit?.segment?.phase === 'commentary')).toHaveLength(0)
      const final = outside.filter(unit => unit?.isFinalReply)
      expect(final).toHaveLength(1)
      expect(final[0]?.segment?.text).toBe('The source inspection is complete.')
      expect(nodes.findIndex(node => node.kind === 'turn-fold')).toBeLessThan(nodes.findIndex(node => node.kind === 'unit' && node.unit.isFinalReply === true))
      const process = nestedUnits(folds)
      expect(process.filter(unit => unit.segment?.phase === 'commentary')).toHaveLength(1)
      expect(process.flatMap(unit => unit.segment?.tools || [])).toHaveLength(105)
      expect(process.some(unit => unit.isFinalReply)).toBe(false)
    })
  }
})
