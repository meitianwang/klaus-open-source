import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionStreamState } from '../stream-store'

let chatStreamStore: typeof import('../stream-store').chatStreamStore
let getSessionStream: typeof import('../stream-store').getSessionStream
let ingestChatEvent: typeof import('../stream-store').ingestChatEvent
let ingestLocalUserTurn: typeof import('../stream-store').ingestLocalUserTurn
let TranscriptView: typeof import('./TranscriptView').TranscriptView
let TurnTerminalStatus: typeof import('./TranscriptView').TurnTerminalStatus
let LiveTail: typeof import('./TranscriptView').LiveTail
let foldTurnGroups: typeof import('./TranscriptView').foldTurnGroups
let unitsFromMessages: typeof import('./TranscriptView').unitsFromMessages
const originalWindow = globalThis.window
beforeAll(async () => {
  ;(globalThis as any).window = { ...originalWindow, currentLang: 'en', addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) }
  ;({ chatStreamStore, getSessionStream, ingestChatEvent, ingestLocalUserTurn } = await import('../stream-store'))
  ;({ TranscriptView, TurnTerminalStatus, LiveTail, foldTurnGroups, unitsFromMessages } = await import('./TranscriptView'))
})
afterAll(() => { (globalThis as any).window = originalWindow })

const sessionId = 'stop-resume-presentation'
const user = { role: 'user', uuid: 'message-1', turnId: 'stopped-turn', text: 'Continue the work', timestamp: 1000, contentBlocks: [{ type: 'text', text: 'Continue the work' }] }
const stopped = { type: 'live-turn-status', key: 'stop-1', turnId: 'stopped-turn', startedAt: 1000, finishedAt: 1300, userInitiated: true } as const
const base = (): Partial<SessionStreamState> => ({
  history: [], historyStale: false, historyLoadFailed: false,
  liveUnits: [{ type: 'live-user', key: 'user-1', turnId: 'stopped-turn', msg: user }, stopped],
  liveTurnId: 'stopped-turn', turnStatuses: { 'stopped-turn': 'interrupted' }, turnDurations: { 'stopped-turn': 300 },
  turnStartedAtMs: { 'stopped-turn': 1000 }, interruptedLiveTurn: { turnId: 'stopped-turn' },
  lastTerminalStatus: 'interrupted',
})

// Saved frames render production markdown, whose DOM probes need a document
// that can create elements. A permissive no-op element keeps SSR deterministic.
function fakeDomElement(): any {
  const store: Record<string, any> = {
    style: {}, dataset: {}, children: [], attributes: {}, tagName: 'DIV',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    innerHTML: '', textContent: '',
  }
  return new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'getContext') return () => ({ measureText: () => ({ width: 10 }), fillRect() {}, clearRect() {} })
      if (prop === 'getBoundingClientRect') return () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
      if (prop === 'querySelector') return () => null
      if (prop === 'querySelectorAll') return () => []
      if (prop === 'appendChild' || prop === 'insertBefore') return (child: any) => { target.children.push(child); return child }
      if (prop === 'removeChild' || prop === 'remove') return (child: any) => child
      if (prop === 'setAttribute') return (name: string, value: string) => { target.attributes[name] = String(value) }
      if (prop === 'getAttribute') return (name: string) => target.attributes[name] ?? null
      if (prop === 'addEventListener' || prop === 'removeEventListener') return () => {}
      if (prop === 'contains' || prop === 'matches') return () => false
      if (prop === 'closest') return () => null
      return () => {}
    },
    set(target, prop: string, value) { target[prop] = value; return true },
  })
}

function render(patch: Partial<SessionStreamState>, withSavedTimeline = false): string {
  const initial = chatStreamStore.getInitialState()
  const sessions = initial.sessions
  const previousDocument = globalThis.document
  initial.sessions = { ...sessions, [sessionId]: { ...getSessionStream('missing-stop-resume-fixture'), ...patch } }
  ;(globalThis as any).document = { documentElement: { setAttribute() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {},
    createElement: () => fakeDomElement(), createElementNS: () => fakeDomElement(), createDocumentFragment: () => fakeDomElement(),
    createTreeWalker: () => ({ nextNode: () => null }) }
  try {
    if (withSavedTimeline) {
      const groups = foldTurnGroups(unitsFromMessages(patch.history || []), null, patch.turnStatuses || {}, {}, {}, patch.turnDurations || {})
      // Render the production turn frames without unrelated artifact subscriptions.
      return renderToStaticMarkup(<LiveTail sessionId={sessionId} unitProps={{ archived: false, running: !!patch.running,
        composerAuthored: true, readOnly: true, editTarget: null, isThinkingExpanded: () => false, onToggleThinking() {} }}
        timeline={{ groups, range: null, offsets: groups.map(() => 0), renderNode: node => node.kind === 'unit' && node.unit.type === 'turn-status'
          ? <TurnTerminalStatus durationMs={node.unit.msg?.durationMs} /> : null }} />)
    }
    return renderToStaticMarkup(<TranscriptView sessionId={sessionId} container={{} as HTMLElement} scroll="none" />)
  } finally {
    initial.sessions = sessions
    if (previousDocument === undefined) delete (globalThis as any).document
    else (globalThis as any).document = previousDocument
  }
}

const occurrences = (html: string, text: string) => html.split(text).length - 1

describe('stopped turn presentation across continuation', () => {
  test('an immediate stop retains exactly one stopped label', () => {
    const html = render(base())
    expect(occurrences(html, 'You stopped after 0s')).toBe(1)
    expect(html).not.toContain('data-work-label="working"')
  })

  test('a continuation without content owns its clock separately from the stopped turn', () => {
    const html = render({ ...base(), running: true, activeTurnId: 'continued-turn', liveTurnId: 'continued-turn',
      interruptedLiveTurn: null, lastTerminalStatus: null, turnStartedAt: Date.now() - 2500,
      activityVisible: true, streamMode: 'requesting' })
    expect(occurrences(html, 'You stopped after 0s')).toBe(1)
    expect(occurrences(html, 'data-work-label="working"')).toBe(1)
    expect(html).toContain('Working for 2s')
    expect(html).toContain('data-klaus-transcript-turn-id="continued-turn"')
    const oldTurn = html.split('data-klaus-transcript-turn-id="stopped-turn"')[1]?.split('data-klaus-transcript-turn-id="continued-turn"')[0]
    expect(oldTurn).not.toContain('data-work-label="working"')
  })

  test('saved and live projections share one stopped label even when saved timing is absent', () => {
    const timings: Record<string, number>[] = [{}, { 'stopped-turn': 300 }]
    for (const turnDurations of timings) {
      const html = render({ ...base(), history: [user], turnDurations }, true)
      expect(occurrences(html, 'You stopped after 0s')).toBe(1)
      expect(html).not.toContain('>Stopped<')
    }
  })

  test('reloaded stopped turns retain a recorded zero duration', () => {
    const html = render({ ...base(), liveUnits: [], history: [user], interruptedLiveTurn: null,
      turnDurations: { 'stopped-turn': 0 } }, true)
    expect(occurrences(html, 'You stopped after 0s')).toBe(1)
  })

  test('a persisted zero-duration stop retains elapsed-time wording', () => {
    expect(renderToStaticMarkup(<TurnTerminalStatus durationMs={0} />)).toContain('You stopped after 0s')
    expect(renderToStaticMarkup(<TurnTerminalStatus />)).toContain('>Stopped<')
    expect(renderToStaticMarkup(<TurnTerminalStatus durationMs={NaN} startedAt={1000} finishedAt={1300} />)).toContain('You stopped after 0s')
  })

  test('an unnamed repeated interruption preserves the first terminal identity and time', () => {
    const id = 'stop-resume-repeat-terminal'
    ingestLocalUserTurn(id, { text: user.text, uuid: user.uuid })
    ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId: 'stopped-turn' })
    ingestChatEvent({ type: 'interrupted', sessionId: id, turnId: 'stopped-turn' }, { userInterrupted: true })
    const first = getSessionStream(id).liveUnits.find(unit => unit.type === 'live-turn-status')
    ingestChatEvent({ type: 'interrupted', sessionId: id })
    expect(getSessionStream(id).liveUnits.filter(unit => unit.type === 'live-turn-status')).toEqual([first])
    expect(getSessionStream(id).interruptedLiveTurn?.turnId).toBe('stopped-turn')
  })

  test('a retained stopped turn older than the loaded saved window keeps its place above the continuation', () => {
    // The saved first paint pages newest turns first; a long continuation can
    // fill the whole window, leaving the stopped turn owned only by the live
    // layer. Its bubble and stop label still belong ABOVE the continuation.
    const continued = { role: 'assistant', uuid: 'assistant-1', turnId: 'continued-turn', timestamp: 5000,
      contentBlocks: [{ type: 'text', text: 'Continuing the investigation.' }] }
    const html = render({
      ...base(),
      history: [continued],
      liveUnits: [
        { type: 'live-user', key: 'user-1', turnId: 'stopped-turn', msg: { ...user, uuid: undefined } },
        { type: 'live-turn-status', key: 'stop-1', turnId: 'stopped-turn', startedAt: 1000, finishedAt: 1300, userInitiated: true },
        { type: 'live-text', key: 'text-1', turnId: 'continued-turn', text: 'Continuing the investigation.', phase: 'commentary' },
      ] as unknown as SessionStreamState['liveUnits'],
      running: true, activeTurnId: 'continued-turn', liveTurnId: 'continued-turn',
      interruptedLiveTurn: null, lastTerminalStatus: null,
      turnStartedAtMs: { 'stopped-turn': 1000, 'continued-turn': 5000 },
    }, true)
    const stoppedAt = html.indexOf('data-klaus-transcript-turn-id="stopped-turn"')
    const continuedAt = html.indexOf('data-klaus-transcript-turn-id="continued-turn"')
    expect(stoppedAt).toBeGreaterThan(-1)
    expect(continuedAt).toBeGreaterThan(-1)
    expect(stoppedAt).toBeLessThan(continuedAt)
    expect(occurrences(html, 'You stopped after')).toBe(1)
  })

  test('a stopped turn owned only by the live layer stays above a saved continuation', () => {
    // The live layer may already have handed the continuation over to saved
    // history, leaving the stopped turn as the only live segment. With no
    // following live segment to anchor against, its start time decides where
    // it belongs: above the later continuation.
    const continued = { role: 'assistant', uuid: 'assistant-1', turnId: 'continued-turn', timestamp: 5000,
      contentBlocks: [{ type: 'text', text: 'Continuing the investigation.' }] }
    const html = render({
      ...base(),
      history: [continued],
      liveUnits: [
        { type: 'live-user', key: 'user-1', turnId: 'stopped-turn', msg: { ...user, uuid: undefined } },
        { type: 'live-turn-status', key: 'stop-1', turnId: 'stopped-turn', startedAt: 1000, finishedAt: 1300, userInitiated: true },
      ] as unknown as SessionStreamState['liveUnits'],
      running: true, activeTurnId: 'continued-turn', liveTurnId: 'continued-turn',
      interruptedLiveTurn: null, lastTerminalStatus: null,
      turnStartedAtMs: { 'stopped-turn': 1000, 'continued-turn': 5000 },
    }, true)
    const stoppedAt = html.indexOf('data-klaus-transcript-turn-id="stopped-turn"')
    const continuedAt = html.indexOf('data-klaus-transcript-turn-id="continued-turn"')
    expect(stoppedAt).toBeGreaterThan(-1)
    expect(continuedAt).toBeGreaterThan(-1)
    expect(stoppedAt).toBeLessThan(continuedAt)
    expect(occurrences(html, 'You stopped after')).toBe(1)
  })

  test('requesting and runtime events preserve the stopped turn while opening an empty continuation', () => {
    const id = 'stop-resume-event-sequence'
    ingestLocalUserTurn(id, { text: user.text, uuid: user.uuid,
      composerDocument: { version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: user.text }] }] } } })
    ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId: 'stopped-turn' })
    ingestChatEvent({ type: 'interrupted', sessionId: id, turnId: 'stopped-turn' }, { userInterrupted: true })
    ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId: 'continued-turn' })
    ingestChatEvent({ type: 'stream_mode', sessionId: id, mode: 'requesting', turnId: 'continued-turn' })
    const html = render(getSessionStream(id))
    expect(occurrences(html, 'You stopped after')).toBe(1)
    expect(occurrences(html, 'data-work-label="working"')).toBe(1)
    expect(html).toContain('data-klaus-transcript-turn-id="continued-turn"')
    ingestChatEvent({ type: 'text_delta', sessionId: id, turnId: 'continued-turn', text: 'Continuing now.', phase: 'commentary' })
    const next = render(getSessionStream(id))
    expect(occurrences(next, 'You stopped after')).toBe(1)
    expect(occurrences(next, 'data-work-label="working"')).toBe(1)
    expect(next).toContain('Continuing now.')
  })
})
