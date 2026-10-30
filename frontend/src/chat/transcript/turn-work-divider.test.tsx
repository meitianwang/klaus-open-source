import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../../contracts/vectors/turn-work-divider-vectors.json'
import type { LiveUnit, ToolCardState } from '../stream-store'

;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {}, currentLang: 'en' }
const { TurnWorkDivider, TurnWorkLabel, WORK_DIVIDER_TICK_MS, WORK_DIVIDER_TIME_THRESHOLD_MS, groupLiveActivityUnits } = await import('./TranscriptView')

const dividerAt = (startedAtMs: number | null) => renderToStaticMarkup(<TurnWorkDivider startedAtMs={startedAtMs} />)

describe('turn work divider contract', () => {
  test('tick interval and time threshold match the captured divider rules', () => {
    expect(WORK_DIVIDER_TICK_MS).toBe(vectors.rules.tickMs)
    expect(WORK_DIVIDER_TIME_THRESHOLD_MS).toBe(vectors.rules.timeThresholdMs)
  })

  test('a final-answer start freezes the work label and uses completed wording', () => {
    const html = renderToStaticMarkup(<TurnWorkLabel startedAtMs={1000} completedAtMs={3500} />)
    expect(html).toContain('Worked for 2s')
    expect(html).toContain('data-work-label="completed"')
    expect(renderToStaticMarkup(<TurnWorkLabel startedAtMs={3500} completedAtMs={1000} />)).toContain('Worked for 0s')
  })

  test('below the threshold the divider names plain work', () => {
    ;(window as any).currentLang = 'en'
    const html = dividerAt(Date.now() - 300)
    expect(html).toContain('data-work-divider="working"')
    expect(html).toContain('>Working<')
    expect(html).not.toContain('Working for')
  })

  test('at or above the threshold the divider names the elapsed time', () => {
    ;(window as any).currentLang = 'en'
    expect(dividerAt(Date.now() - 2500)).toContain('Working for 2s')
    expect(dividerAt(Date.now() - 65_000)).toContain('Working for 1m 5s')
  })

  test('the localized labels follow the active language', () => {
    ;(window as any).currentLang = 'zh'
    try {
      expect(dividerAt(Date.now() - 300)).toContain('处理中')
      expect(dividerAt(Date.now() - 65_000)).toContain('已处理 1分钟 5秒')
    } finally {
      ;(window as any).currentLang = 'en'
    }
  })

  test('a saved running turn without a start time shows a loading placeholder', () => {
    ;(window as any).currentLang = 'en'
    const html = dividerAt(null)
    expect(html).toContain('data-work-divider="loading"')
    expect(html).toContain('Loading activity status')
  })
})

describe('work header placement', () => {
  const user = { type: 'live-user', key: 'u', turnId: 't1', msg: { role: 'user', uuid: 'u', text: 'go' } } as LiveUnit
  const finalText = { type: 'live-text', key: 'ft', turnId: 't1', text: 'the answer', streaming: true, turnTail: { ts: 1, meta: null } } as LiveUnit
  const calls = { type: 'live-tools', key: 'calls', turnId: 't1', order: ['read'], sealed: false } as LiveUnit
  const toolCards: Record<string, ToolCardState> = {
    read: { toolCallId: 'read', toolName: 'read', args: { file_path: '/src/main.ts' }, status: 'running', argsDelta: '', progress: [], agent: false, bgTask: false },
  }
  const kinds = (nodes: ReturnType<typeof groupLiveActivityUnits>) => nodes.map(node => node.kind)

  test('a turn without process content shows its elapsed row before the final reply', () => {
    expect(kinds(groupLiveActivityUnits([user, finalText], {}, true, false))).toEqual(['unit', 'work-divider', 'unit'])
  })

  test('process content has one disclosure header instead of a second elapsed row', () => {
    const nodes = groupLiveActivityUnits([user, calls, finalText], toolCards, true, false)
    expect(kinds(nodes)).toEqual(['unit', 'turn', 'unit'])
    expect(nodes.find(node => node.kind === 'turn')).toMatchObject({ running: true, preventAutoCollapse: true })
  })

  test('a settled turn retains its process disclosure without a duplicate elapsed row', () => {
    const nodes = groupLiveActivityUnits([user, calls, finalText], toolCards, false, false)
    expect(nodes.some(node => node.kind === 'work-divider')).toBe(false)
    expect(nodes.some(node => node.kind === 'turn')).toBe(true)
  })

  test('an interrupted turn drops the divider: the terminal status owns the seam', () => {
    expect(groupLiveActivityUnits([user, calls, finalText], toolCards, true, false, true)
      .some(node => node.kind === 'work-divider')).toBe(false)
  })

  test('the divider carries the recorded turn start time', () => {
    const nodes = groupLiveActivityUnits([user, finalText], {}, true, false, false, new Set(), null, { t1: 1234 })
    const divider = nodes.find(node => node.kind === 'work-divider')
    expect(divider?.kind === 'work-divider' ? divider.startedAtMs : null).toBe(1234)
  })

  test('the running tail falls back to the session turn stamp before any per-turn record', () => {
    const nodes = groupLiveActivityUnits([user, finalText], {}, true, false, false, new Set(), null, {}, 5000)
    const divider = nodes.find(node => node.kind === 'work-divider')
    expect(divider?.kind === 'work-divider' ? divider.startedAtMs : null).toBe(5000)
  })

  test('an engine-stamped per-turn start wins over the session stamp', () => {
    const nodes = groupLiveActivityUnits([user, finalText], {}, true, false, false, new Set(), null, { t1: 1234 }, 5000)
    const divider = nodes.find(node => node.kind === 'work-divider')
    expect(divider?.kind === 'work-divider' ? divider.startedAtMs : null).toBe(1234)
  })

  test('a live turn without any stamp receives an initial observation time', () => {
    const before = Date.now()
    const nodes = groupLiveActivityUnits([user, finalText], {}, true, false)
    const divider = nodes.find(node => node.kind === 'work-divider')
    const startedAt = divider?.kind === 'work-divider' ? divider.startedAtMs : null
    expect(typeof startedAt).toBe('number')
    expect(startedAt ?? 0).toBeGreaterThanOrEqual(before)
  })
})

test('a final-answer timestamp freezes the process clock while the turn remains expanded', () => {
  const user = { type: 'live-user', key: 'u', turnId: 't1', msg: { role: 'user', text: 'go', timestamp: 1000 } } as LiveUnit
  const commentary = { type: 'live-text', key: 'c', turnId: 't1', text: 'Checking', phase: 'commentary', streaming: false } as LiveUnit
  const final = { type: 'live-text', key: 'f', turnId: 't1', text: 'Answer', phase: 'final_answer', streaming: true, startedAtMs: 3500 } as LiveUnit
  const nodes = groupLiveActivityUnits([user, commentary, final], {}, true, false)
  expect(nodes.map(node => node.kind)).toEqual(['unit', 'turn', 'unit'])
  expect(nodes[1]).toMatchObject({ running: true, preventAutoCollapse: true, startedAtMs: 1000, completedAtMs: 3500 })
})
