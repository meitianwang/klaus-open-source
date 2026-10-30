import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../../contracts/vectors/chat-list-disclosure.json'
import type { ActivityToolData, ActivityToolState } from './activity-tool-model'

;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {} }

const { ActivityToolContent } = await import('./activity-tool')
const { LiveToolCard, HistoryToolCards, segmentsFromBlocks } = await import('./TranscriptView')

const output = JSON.stringify({ threads: [{ threadId: 'listed-chat', title: '<Literal chat title>' }], padding: 'Z'.repeat(6000) })

describe('chat listing disclosure contract', () => {
  for (const vector of vectors.cases) {
    test(`${vector.toolName} retains localized labels and full input and output on expansion`, () => {
      for (const [state, labels] of Object.entries(vector.labels)) {
        for (const [index, locale] of ['en', 'zh'].entries()) {
          for (const args of [vector.args, JSON.stringify(vector.args)]) {
            const tool: ActivityToolData = { toolCallId: 'listing', toolName: vector.toolName, args, state: state as ActivityToolState, output }
            const render = (open: boolean) => renderToStaticMarkup(<ActivityToolContent tool={tool} open={open} onToggle={() => {}} locale={locale} />)
            const closed = render(false)
            expect(closed).toContain(labels![index])
            expect(closed).toContain('aria-expanded="false"')
            expect(closed).toContain('aria-controls=')
            expect(closed).not.toContain('listed-chat')
            const expanded = render(true)
            expect(expanded).toContain(labels![index])
            expect(expanded).toContain('aria-expanded="true"')
            expect(expanded).toContain('&lt;Literal chat title&gt;')
            expect(expanded).not.toContain('<Literal chat title>')
            expect(expanded).toContain('Z'.repeat(6000))
            expect(expanded).toContain('aria-label=')
            expect(expanded).toContain('&quot;limit&quot;')
          }
        }
      }
    })

    test(`${vector.toolName} has a disclosure in live and replay projections`, () => {
      for (const state of ['done', 'error', 'interrupted'] as const) {
        const live = renderToStaticMarkup(<LiveToolCard card={{
          toolCallId: 'listing', toolName: vector.toolName, args: vector.args, argsDelta: '', progress: [],
          agent: false, bgTask: false, status: state === 'done' ? 'ok' : state, content: output,
        }} open onToggle={() => {}} />)
        expect(live).toContain('aria-expanded="true"')
        expect(live).toContain('listed-chat')
        const replay = segmentsFromBlocks([{
          type: 'tool_use', id: 'listing', name: vector.toolName, input: vector.args,
          __result: { text: output, isError: state === 'error' },
        }], undefined)
        const history = renderToStaticMarkup(<HistoryToolCards tools={replay[0].tools!} />)
        expect(history).toContain('aria-expanded="false"')
        expect(history).not.toContain('listed-chat')
      }
    })
  }
})
