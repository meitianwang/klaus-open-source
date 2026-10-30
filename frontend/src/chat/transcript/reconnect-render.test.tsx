import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../../contracts/vectors/reconnect-render-vectors.json'
import type { LiveUnit, SessionStreamState } from '../stream-store'

let transcript: typeof import('./TranscriptView')
let stream: typeof import('../stream-store')
let previousWindow: any
beforeAll(async () => {
  previousWindow = (globalThis as any).window
  ;(globalThis as any).window = { ...previousWindow, addEventListener: () => {}, currentLang: 'en' }
  stream = await import('../stream-store')
  transcript = await import('./TranscriptView')
})
afterAll(() => { (globalThis as any).window = previousWindow })

const unitProps = {
  isThinkingExpanded: () => false, onToggleThinking: () => {},
  archived: false, running: true, composerAuthored: false, readOnly: true,
  editTarget: null,
}
const retry = (index: number, value: { attempt: number; maxRetries: number; phase?: string }, turnId = 'turn'): LiveUnit => ({
  ...value, type: 'live-retry', key: `retry-${turnId}-${index}`, turnId,
})
function render(units: LiveUnit[], locale: 'en' | 'zh', patch: Partial<SessionStreamState> = {}) {
  const initial = stream.chatStreamStore.getInitialState()
  const previous = initial.sessions
  const previousLang = (window as any).currentLang
  initial.sessions = { ...previous, reconnect: { ...stream.getSessionStream('missing-reconnect-fixture'),
    running: true, activeTurnId: 'turn', liveUnits: units, ...patch } }
  ;(window as any).currentLang = locale
  try { return renderToStaticMarkup(<transcript.LiveTail sessionId="reconnect" unitProps={unitProps} />) }
  finally { initial.sessions = previous; (window as any).currentLang = previousLang }
}
const reconnectRows = (html: string) => [...html.matchAll(/<span(?: [^>]*)?>(Reconnecting[^<]*|正在重新连接[^<]*)<\/span>/g)].map(match => match[1])

function projectedRetryUnits(units: LiveUnit[], running = true, interrupted = false) {
  type RenderUnit = Extract<ReturnType<typeof transcript.groupLiveActivityUnits>[number], { kind: 'unit' }>['unit']
  const visit = (nodes: ReturnType<typeof transcript.groupLiveActivityUnits>): RenderUnit[] => nodes.flatMap<RenderUnit>(node =>
    node.kind === 'unit' ? [node.unit] : node.kind === 'activity' ? node.units : node.kind === 'turn' ? visit(node.items) : [])
  return visit(transcript.groupLiveActivityUnits(units, {}, running, false, interrupted)).filter(unit => unit.type === 'live-retry')
}

describe('reconnect render contract', () => {
  for (const fixture of vectors.cases) {
    for (const locale of ['en', 'zh'] as const) {
      test(`${fixture.name} in ${locale} renders one row without counters`, () => {
        const units = fixture.retries.map((value, index) => retry(index, value))
        const before = JSON.stringify(units)
        const html = render(units, locale)
        const label = vectors.labels[locale][fixture.label as 'retry' | 'networkWait']
        expect(reconnectRows(html)).toEqual([label])
        expect(html).not.toMatch(/\d+\/\d+/)
        expect(JSON.stringify(units)).toBe(before)
      })
    }
  }

  test('nonadjacent retries retain the first row key without removing intervening activity', () => {
    const first = retry(0, { attempt: 1, maxRetries: 3 })
    const tools: LiveUnit = { type: 'live-tools', key: 'tools', order: ['read'], sealed: true, turnId: 'turn' }
    const notice: LiveUnit = { type: 'live-notice', key: 'notice', text: 'Keep this notice', turnId: 'turn' }
    const units = [first, tools, notice, retry(1, { attempt: 1, maxRetries: 5 }), retry(2, { attempt: 1, maxRetries: 0, phase: 'networkWait' })]
    const projected = projectedRetryUnits(units)
    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({ key: first.key, phase: 'networkWait' })
    const html = render(units, 'zh', { tools: { read: { toolCallId: 'read', toolName: 'read', args: { path: '/project.ts' },
      status: 'ok', argsDelta: '', progress: [], agent: false, bgTask: false } } })
    expect(html).toContain('Keep this notice')
    // The lone read now folds behind a summary, so the stable marker is the
    // activity disclosure rather than the hidden tool card.
    expect(html).toContain('data-activity-toggle="activity"')
    expect(reconnectRows(html)).toEqual([vectors.labels.zh.networkWait])
    expect(html.indexOf(vectors.labels.zh.networkWait)).toBeLessThan(html.indexOf('data-activity-toggle="activity"'))
  })

  test('separate turns keep independent reconnect rows', () => {
    const units = [retry(0, { attempt: 1, maxRetries: 3 }, 'old'), retry(1, { attempt: 2, maxRetries: 3 }, 'old'),
      retry(0, { attempt: 1, maxRetries: 5 }, 'turn'), retry(1, { attempt: 1, maxRetries: 0, phase: 'networkWait' }, 'turn')]
    expect(reconnectRows(render(units, 'zh'))).toEqual([vectors.labels.zh.retry, vectors.labels.zh.networkWait])
  })

  test('completed and interrupted projections still contain only one retry row per turn', () => {
    const units: LiveUnit[] = [retry(0, { attempt: 1, maxRetries: 3 }), retry(1, { attempt: 1, maxRetries: 0, phase: 'networkWait' }),
      { type: 'live-text', key: 'final', text: 'Done', phase: 'final_answer', streaming: true, turnId: 'turn' }]
    expect(projectedRetryUnits(units, false)).toHaveLength(1)
    expect(projectedRetryUnits(units, false, true)).toHaveLength(1)
    expect(projectedRetryUnits(units, true)).toHaveLength(1)
  })

  test('event ingestion retains all retry attempts and budgets while rendering coalesces them', () => {
    const sessionId = 'reconnect-events-fixture'
    stream.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'turn' })
    stream.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn' })
    for (const value of vectors.cases[2].retries) stream.ingestChatEvent({ type: 'api_retry', sessionId, ...value })
    const units = stream.getSessionStream(sessionId).liveUnits
    const retries = units.filter(unit => unit.type === 'live-retry')
    expect(retries.map(unit => ({ attempt: unit.attempt, maxRetries: unit.maxRetries, ...(unit.phase ? { phase: unit.phase } : {}) })))
      .toEqual(vectors.cases[2].retries)
    expect(projectedRetryUnits(units)).toHaveLength(1)
    expect(stream.getSessionStream(sessionId).liveUnits).toBe(units)
    expect(stream.getSessionStream(sessionId).running).toBe(true)
  })
})
