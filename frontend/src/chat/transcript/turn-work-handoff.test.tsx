import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { parse } from 'node-html-parser'
import type { LiveUnit, SessionStreamState } from '../stream-store'

let transcript: typeof import('./TranscriptView')
let stream: typeof import('../stream-store')
let previousWindow: unknown
let previousDocument: unknown
beforeAll(async () => {
  previousWindow = (globalThis as any).window
  previousDocument = (globalThis as any).document
  ;(globalThis as any).window = { ...(previousWindow as object), addEventListener: () => {}, currentLang: 'en' }
  transcript = await import('./TranscriptView')
  stream = await import('../stream-store')
  ;(globalThis as any).document = {
    getElementById: () => null,
    createElement: () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => null }),
  }
})
afterAll(() => {
  ;(globalThis as any).window = previousWindow
  ;(globalThis as any).document = previousDocument
})

function renderTurn(patch: Partial<SessionStreamState>): string {
  const initial = stream.chatStreamStore.getInitialState()
  const previous = initial.sessions
  const sessionId = 'work-header-handoff'
  initial.sessions = { ...previous, [sessionId]: { ...stream.getSessionStream('missing-work-header-fixture'),
    running: true, activeTurnId: 'turn', liveTurnId: 'turn', turnStartedAt: 1000,
    turnStartedAtMs: { turn: 1000 }, ...patch } }
  try {
    return renderToStaticMarkup(<transcript.TranscriptView sessionId={sessionId} container={{} as HTMLElement} readOnly />)
  } finally { initial.sessions = previous }
}

const user = { role: 'user', uuid: 'user', turnId: 'turn', text: 'Inspect the process', timestamp: 1000 }
const savedWork = { role: 'assistant', uuid: 'saved-work', turnId: 'turn', phase: 'commentary', text: 'Saved process.', timestamp: 1200 }
const liveUser: LiveUnit = { type: 'live-user', key: 'user', turnId: 'turn', msg: user }
const liveWork: LiveUnit = { type: 'live-text', key: 'work', turnId: 'turn', phase: 'commentary', text: 'Live process.', streaming: false }

function expectOneHeader(html: string, disclosure: boolean) {
  expect(html.match(/data-work-label=/g) ?? []).toHaveLength(1)
  expect(html.match(/data-work-divider=/g) ?? []).toHaveLength(disclosure ? 0 : 1)
  expect(html.match(/data-activity-toggle="turn"/g) ?? []).toHaveLength(disclosure ? 1 : 0)
  expect(html.match(/data-nav-turn="true"/g) ?? []).toHaveLength(1)
  expect(html.indexOf('Inspect the process')).toBeLessThan(html.indexOf('data-work-label='))
}

describe('one work header across saved and streamed turn content', () => {
  for (const late of [false, true]) test(`a ${late ? 'late' : 'middle'} answer keeps its arrival position when saved history already has the final`, () => {
    const answer = { role: 'user', uuid: 'answer', text: 'Three bullets', timestamp: late ? 5000 : 2000,
      steered: true, questionAnswer: { requestId: 'request', turnId: 'turn', toolCallId: 'question', clientResponseId: 'response',
        questions: [{ id: 'format', question: 'Which format?', options: [] }], answers: { format: 'Three bullets' } } }
    const final = { role: 'assistant', uuid: 'final', turnId: 'turn', text: 'Final result', phase: 'final_answer', isFinalReply: true, timestamp: 4000 }
    const html = renderTurn({ running: false, activeTurnId: null, history: [user, savedWork, final],
      turnStatuses: { turn: 'completed' }, turnCollapseOverrides: { 'turn:turn': false },
      liveUnits: [{ type: 'live-user', key: 'answer', turnId: 'turn', msg: answer }] })
    const dom = parse(html)
    expect(dom.querySelectorAll('[data-uuid="answer"]')).toHaveLength(1)
    const text = dom.textContent
    expect(text.indexOf('Three bullets') < text.indexOf('Final result')).toBe(!late)
    expect(text.indexOf('Inspect the process')).toBeLessThan(text.indexOf('Three bullets'))
  })
  test('saved user and live process share the process disclosure header', () => {
    const html = renderTurn({ history: [user], liveUnits: [liveWork] })
    expectOneHeader(html, true)
    expect(html.indexOf('data-work-label=')).toBeLessThan(html.indexOf('Live process.'))
  })

  test('saved process owns the header when the live projection still has only its user', () => {
    const html = renderTurn({ history: [user, savedWork], liveUnits: [liveUser] })
    expectOneHeader(html, true)
    expect(html).toContain('Saved process.')
  })

  test('matching saved and live placeholders share one elapsed row', () => {
    expectOneHeader(renderTurn({ history: [user], liveUnits: [liveUser] }), false)
  })

  test('saved and live process projections retain one disclosure and both process items', () => {
    const html = renderTurn({ history: [user, savedWork], liveUnits: [liveWork] })
    expectOneHeader(html, true)
    expect(html).toContain('Saved process.')
    expect(html).toContain('Live process.')
  })

  test('saved-only and live-only turns keep their elapsed row', () => {
    expectOneHeader(renderTurn({ history: [user], liveUnits: [] }), false)
    expectOneHeader(renderTurn({ history: [], liveUnits: [liveUser] }), false)
  })

  test('elapsed rows in different turns remain independent', () => {
    const html = renderTurn({ history: [user, savedWork], activeTurnId: 'next', liveTurnId: 'next',
      turnStatuses: { turn: 'completed' }, turnDurations: { turn: 1000 },
      liveUnits: [{ ...liveUser, key: 'next-user', turnId: 'next', msg: { role: 'user', text: 'Next request' } }] })
    expect(html.match(/data-work-label=/g) ?? []).toHaveLength(2)
    expect(html).toContain('Next request')
  })
})
