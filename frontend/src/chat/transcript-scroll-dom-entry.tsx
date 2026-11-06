// Exercises the production transcript, history store and scroll controller in a
// real browser viewport. Host fixtures honor requested page and item views.
import { mountReactTranscript, unmountReactTranscript } from './transcript'
import { beginPendingUserTurn, flushChatFrames, getSessionStream, ingestChatEvent, loadSessionHistory } from './stream-store'
import { TranscriptScrollController, registerTranscriptScrollController } from './transcript-scroll-controller'
import { captureTranscriptViewport, transcriptViewportState } from './transcript/viewport-state'
import { composerDocumentFromText, snapshotComposerDocument } from './composer/document-model'

type Trace = Record<string, unknown>
const host = window as any
const viewport = document.getElementById('messages')!
const controller = new TranscriptScrollController({ scrollEl: viewport, responseSpacer: true })
registerTranscriptScrollController(controller)
host.currentLang = 'en'
host.getKnownSessionInfo = () => ({})
const errors: string[] = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason?.stack || event.reason)))
const writes: Trace[] = [], calls: Trace[] = [], samples: Trace[] = [], inputs: Trace[] = []
const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
Object.defineProperty(viewport, 'scrollTop', {
  configurable: true,
  get() { return scrollTop.get!.call(this) },
  set(value: number) {
    const before = scrollTop.get!.call(this)
    scrollTop.set!.call(this, value)
    writes.push({ time: performance.now(), before, requested: value, after: scrollTop.get!.call(this), scrollHeight: viewport.scrollHeight })
  },
})
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
async function frames(count = 6): Promise<void> { for (let i = 0; i < count; i++) await frame() }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const words = (seed: number, count: number) => Array.from({ length: count }, (_, index) => `word${(seed * 31 + index) % 97}`).join(' ')
const turnIds = Array.from({ length: 45 }, (_, index) => `scroll-turn-${String(index).padStart(3, '0')}`)
const historyStartedAt = Date.now() - (turnIds.length + 1) * 60_000
function rowsFor(turnId: string) {
  const index = turnIds.indexOf(turnId), timestamp = historyStartedAt + index * 60_000
  const prompt = `Question ${index}: ${words(index, 20 + index % 5 * 9)}`
  const user = { uuid: `${turnId}-user`, turnId, role: 'user', text: prompt, contentBlocks: [{ type: 'text', text: prompt }], timestamp }
  const tools = Array.from({ length: 2 + index % 4 }, (_, tool) => ({
    uuid: `${turnId}-tool-${tool}`, turnId, role: 'assistant', text: '', timestamp: timestamp + 1000 + tool,
    contentBlocks: [{ type: 'tool_use', id: `${turnId}-call-${tool}`, name: 'read', input: { path: `/fixture/file-${index}-${tool}.ts` },
      __result: { type: 'tool_result', tool_use_id: `${turnId}-call-${tool}`, content: [{ type: 'text', text: words(index + tool, 40) }], is_error: false } }],
  }))
  const answer = Array.from({ length: 2 + index % 3 }, (_, paragraph) => words(index * 7 + paragraph, 65 + (index + paragraph) % 4 * 35)).join('\n\n')
  const final = { uuid: `${turnId}-final`, turnId, role: 'assistant', text: answer, isFinalReply: true, timestamp: timestamp + 5000,
    contentBlocks: [{ type: 'text', text: answer, phase: 'final_answer', messageId: `${turnId}-final` }] }
  return [user, ...tools, final]
}
const rows = new Map(turnIds.map(id => [id, rowsFor(id)]))
const shell = (id: string, itemsView: string) => {
  const index = turnIds.indexOf(id), start = historyStartedAt + index * 60_000
  return { id, ordinal: index * 100, updatedAtOrdinal: index * 100 + 50, itemsView, status: 'completed',
    startedAtMs: start, finishedAtMs: start + 6000, durationMs: 6000 }
}
host.klaus = { session: {
  historyPage: async (sessionId: string, options: any = {}) => {
    calls.push({ method: 'historyPage', sessionId, options: { ...options }, time: performance.now() })
    await wait(100)
    if (sessionId.startsWith('running-')) streamDuringRead(sessionId)
    const end = sessionId.startsWith('empty') ? 0 : options.cursor ? Number(options.cursor) : turnIds.length
    const start = Math.max(0, end - (options.limit ?? 5)), selected = turnIds.slice(start, end)
    // A legacy host may explicitly return summary shells for a requested full page.
    const itemsView = sessionId.startsWith('summary-') ? 'summary' : options.itemsView ?? 'full'
    const messages = selected.flatMap(id => {
      const all = rows.get(id)!
      return itemsView === 'full' ? all : itemsView === 'summary' ? [all[0], all.at(-1)!] : []
    })
    const running = sessionId.startsWith('running-') ? RUNNING_TURN : null
    const runningRows = running && !options.cursor ? [{ uuid: `${running}-user`, turnId: running, role: 'user', text: RUNNING_PROMPT,
      contentBlocks: [{ type: 'text', text: RUNNING_PROMPT }], timestamp: Date.now() - 1000 }] : []
    const runningShell = running && !options.cursor ? [{ id: running, ordinal: 99_000, updatedAtOrdinal: 99_001, itemsView, status: 'interrupted', startedAtMs: Date.now() - 1000 }] : []
    return { messages: [...messages, ...runningRows], turns: [...selected.map(id => shell(id, itemsView)), ...runningShell],
      turnStatuses: { ...Object.fromEntries(selected.map(id => [id, 'completed'])), ...(running && !options.cursor ? { [running]: 'running' } : {}) },
      turnStartedAtMs: Object.fromEntries(selected.map(id => [id, shell(id, itemsView).startedAtMs])),
      turnFinishedAtMs: Object.fromEntries(selected.map(id => [id, shell(id, itemsView).finishedAtMs])),
      turnDurations: Object.fromEntries(selected.map(id => [id, 6000])),
      page: { hasMore: start > 0, nextCursor: start > 0 ? String(start) : null } }
  },
  historyItems: async (sessionId: string, options: any) => {
    calls.push({ method: 'historyItems', sessionId, options: { ...options }, time: performance.now() })
    await wait(100)
    const all = rows.get(options.turnId) ?? []
    const end = options.cursor ? all.findIndex(row => row.uuid === options.cursor) : all.length
    const start = options.sortDirection === 'asc' ? 0 : Math.max(0, end - options.limit)
    const selected = options.sortDirection === 'asc' ? all.slice(0, options.limit) : all.slice(start, end)
    return { messages: selected, page: { hasMore: options.sortDirection === 'asc' ? all.length > options.limit : start > 0,
      nextCursor: start > 0 ? all[start].uuid : null } }
  },
} }
const RUNNING_TURN = 'scroll-running-turn', RUNNING_PROMPT = 'A continued turn that is still running.'
let liveDeltas = 0
function liveDelta(sessionId: string) {
  ingestChatEvent({ type: 'text_delta', sessionId, turnId: RUNNING_TURN, messageId: `${RUNNING_TURN}-commentary`, phase: 'commentary', text: ` ${words(++liveDeltas, 6)}` })
  flushChatFrames()
}
/** The continued Turn keeps producing output while saved history is read. */
function streamDuringRead(sessionId: string) {
  for (const delay of [10, 40, 80]) setTimeout(() => liveDelta(sessionId), delay)
}
let currentSessionId = '', submission = 0, liveTurnId = ''
let phase = 'idle', sampling = false
function rowKey(row: Element): string { return row.getAttribute('data-klaus-transcript-turn-key') || row.getAttribute('data-klaus-transcript-turn-id') || row.getAttribute('data-virtual-turn-key') || '' }
function visibleAnchor(): { key: string; top: number } | null {
  const bounds = viewport.getBoundingClientRect()
  const turns = [...viewport.querySelectorAll<HTMLElement>('[data-klaus-transcript-turn]')]
  const visible = turns.find(row => { const rect = row.getBoundingClientRect(); return rect.top >= bounds.top && rect.top < bounds.bottom })
    ?? turns.find(row => { const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom })
  return visible ? { key: rowKey(visible), top: visible.getBoundingClientRect().top - bounds.top } : null
}
function geometry() {
  const state = getSessionStream(currentSessionId), bounds = viewport.getBoundingClientRect(), anchor = visibleAnchor()
  const user = viewport.querySelector<HTMLElement>(`[data-uuid="scroll-submission-${submission}"]`)
  return { sessionId: currentSessionId, top: viewport.scrollTop, height: viewport.scrollHeight, viewport: viewport.clientHeight, width: viewport.clientWidth,
    distance: Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop), following: controller.shouldFollowContentGrowth(),
    spacer: controller.getResponseSpacer()?.getHeightPx() ?? 0, anchor,
    userTop: user ? user.getBoundingClientRect().top - bounds.top : null,
    loadedTurns: Object.keys(state.savedTranscript?.entitiesByKey ?? {}).length, oldest: state.turnsPagination?.hasLoadedOldest,
    renderedTurns: viewport.querySelectorAll('[data-klaus-transcript-turn]').length,
    loading: state.historyLoading, errorCount: errors.length }
}
let previousAnchor: { key: string; top: number } | null = null
function sample() {
  if (!sampling) return
  const metrics = geometry()
  let trackedDelta: number | null = null
  if (previousAnchor) {
    const row = [...viewport.querySelectorAll<HTMLElement>('[data-klaus-transcript-turn]')].find(item => rowKey(item) === previousAnchor!.key)
    if (row) trackedDelta = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - previousAnchor.top
  }
  const bounds = viewport.getBoundingClientRect()
  const covered = [...viewport.querySelectorAll<HTMLElement>('[data-klaus-transcript-turn]')].some(row => {
    const rect = row.getBoundingClientRect(); return rect.height > 0 && rect.top < bounds.bottom && rect.bottom > bounds.top
  })
  const closedSectionsVisible = [...viewport.querySelectorAll<HTMLElement>('div[data-visible][aria-hidden="true"]')]
    .filter(element => element.getBoundingClientRect().height > 1).length
  samples.push({ time: performance.now(), phase, ...metrics, trackedDelta, covered, closedSectionsVisible })
  previousAnchor = metrics.anchor
  requestAnimationFrame(sample)
}
viewport.addEventListener('wheel', event => inputs.push({ time: performance.now(), phase, trusted: event.isTrusted, deltaY: event.deltaY }), { passive: true })
function grow(which: 'above' | 'latest', height = 160) {
  const bounds = viewport.getBoundingClientRect()
  const turns = [...viewport.querySelectorAll<HTMLElement>('[data-klaus-transcript-turn]')]
  const row = which === 'latest' ? turns.at(-1) : turns.filter(item => item.getBoundingClientRect().bottom < bounds.top).at(-1)
  const target = row?.querySelector<HTMLElement>('.msg.assistant') ?? row
  if (!target) return null
  const padding = document.createElement('div'); padding.style.height = `${height}px`; target.append(padding)
  return { key: rowKey(row!), height }
}
host.scrollFixture = {
  errors, calls, samples, writes, inputs, geometry, frames,
  phase(value: string) { phase = value; previousAnchor = null },
  async open(sessionId: string) {
    captureTranscriptViewport(viewport)
    unmountReactTranscript(viewport)
    currentSessionId = sessionId; host.currentSessionId = sessionId
    controller.resetForConversation(transcriptViewportState(sessionId)?.distanceFromBottomPx ?? 0)
    mountReactTranscript(sessionId, viewport, { scroll: 'main' })
    if (getSessionStream(sessionId).history === null) await loadSessionHistory(sessionId)
    await frames(8)
    return geometry()
  },
  /** A cold conversation whose newest Turn was continued after a restart and is still running. */
  async openRunning(sessionId: string) {
    ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: RUNNING_TURN })
    ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: RUNNING_TURN })
    liveDelta(sessionId)
    captureTranscriptViewport(viewport)
    unmountReactTranscript(viewport)
    currentSessionId = sessionId; host.currentSessionId = sessionId
    controller.resetForConversation(transcriptViewportState(sessionId)?.distanceFromBottomPx ?? 0)
    mountReactTranscript(sessionId, viewport, { scroll: 'main' })
    for (let i = 0; i < 6; i++) { await wait(60); liveDelta(sessionId) }
    await wait(400)
    await frames(8)
    const state = getSessionStream(sessionId)
    return { ...geometry(), historyRows: state.history?.length ?? null, historyStale: state.historyStale,
      liveTurnId: state.liveTurnId, savedTurns: Object.keys(state.turnShells),
      text: viewport.innerText.slice(0, 400), runningPromptVisible: viewport.innerText.includes(RUNNING_PROMPT) }
  },
  liveDelta() { liveDelta(currentSessionId) },
  async send() {
    const uuid = `scroll-submission-${++submission}`, text = `A structured message ${submission} with retained formatting.`
    controller.prepareLatestTurnPlacement(currentSessionId)
    const document = composerDocumentFromText(text)
    beginPendingUserTurn(currentSessionId, { text, uuid, displayText: text, composerDocument: snapshotComposerDocument(document), timestamp: Date.now() })
    liveTurnId = `scroll-live-${submission}`
    await wait(600)
    await frames(4)
    return geometry()
  },
  async appendReply(paragraphs: number, phase: 'commentary' | 'final_answer' = 'commentary') {
    ingestChatEvent({ type: 'stream_mode', sessionId: currentSessionId, mode: 'responding', turnId: liveTurnId })
    ingestChatEvent({ type: 'text_delta', sessionId: currentSessionId, turnId: liveTurnId, messageId: `${liveTurnId}-${phase}`, phase, text: Array.from({ length: paragraphs }, (_, i) => words(i, 35)).join('\n\n') })
    flushChatFrames(); await frames(10); return geometry()
  },
  async grow(which: 'above' | 'latest', height = 160) { const result = grow(which, height); await frames(10); return { result, geometry: geometry() } },
  startSamples() { if (sampling) return; sampling = true; previousAnchor = null; requestAnimationFrame(sample) },
  stopSamples() { sampling = false },
  async bottom() {
    const spacer = controller.getResponseSpacer()
    if (spacer) spacer.scrollToBottom()
    else controller.scrollToBottom()
    await wait(320); await frames(4); return geometry()
  },
}
host.fixtureReady = true
