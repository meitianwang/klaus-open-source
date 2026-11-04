import * as stream from './stream-store'
import * as markdown from './markdown'
import { mountReactTranscript, unmountReactTranscript } from './transcript'
import { TranscriptScrollController, registerTranscriptScrollController } from './transcript-scroll-controller'
import { verifyMarkdownAsyncTransitions, verifySettledHighlightInteraction } from './markdown-async-dom-fixture'

const host = window as any
const viewport = document.querySelector<HTMLElement>('#messages')!
const input = document.querySelector<HTMLTextAreaElement>('#input')!
const streamApi = stream as any
const markdownApi = markdown as any
const originalNow = Date.now
Date.now = () => 1_800_000_000_000
host.currentLang = 'en'
host.currentSessionId = null
// The main transcript delegates tail following to its host scroll controller.
const scrollController = new TranscriptScrollController({ scrollEl: viewport })
registerTranscriptScrollController(scrollController)
host.scrollToBottom = () => scrollController.scrollToDistanceFromBottomPx(0, 'instant')
const historyReplies = new Map<string, any[]>()
host.klaus = { session: { history: async (id: string) => ({ messages: historyReplies.get(id) ?? retainedHistory(id) }) } }
function configureWorker(): void {
  if (typeof markdownApi.setMarkdownWorkerFactory === 'function') {
    markdownApi.setMarkdownWorkerFactory(() => new Worker(new URL('./markdown-worker.js', location.href), { type: 'module' }))
  }
}
configureWorker()

let serial = 0
let scenario: { done: boolean; error?: string; startedAt: number; durationMs?: number; deltas: number; notifications: number; mutations: number; longTasks: number[] } | null = null
let unsubscribe: (() => void) | null = null
let mutationObserver: MutationObserver | null = null
let currentSource = ''
const inputWaiters = new Map<number, Promise<{ paintAt: number; valueLength: number }>>()
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
const frames = async (count = 3) => { for (let i = 0; i < count; i++) await frame() }
try {
  new PerformanceObserver(list => {
    if (scenario && !scenario.done) for (const entry of list.getEntries()) scenario.longTasks.push(entry.duration)
  }).observe({ type: 'longtask', buffered: false })
} catch { /* Older browsers still provide native input and process metrics. */ }

function send(event: any): void {
  const ingest = streamApi.ingestChatFrameEvent ?? stream.ingestChatEvent
  ingest(event)
}
function flush(): void { streamApi.flushChatFrames?.() }
function history(count: number, sessionId: string): any[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant', uuid: `${sessionId}-history-${index}`,
    turnId: `${sessionId}-turn-${Math.floor(index / 2)}`,
    text: index % 2 === 0 ? `Review item ${index}.` : `Item ${index} is complete. The saved transcript remains available when older messages are requested.`,
    ...(index % 2 ? { phase: 'final_answer' } : {}),
  }))
}
function retainedHistory(id: string): any[] {
  return Array.from({ length: 128 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant', uuid: `${id}-row-${index}`, turnId: `${id}-turn-${index >> 1}`,
    text: `${id} message ${index}: ` + Array.from({ length: 55 }, (_, word) => `${index}-${word} retained history payload. `).join(''),
    ...(index % 2 ? { phase: 'final_answer' } : {}),
  }))
}
function corpus(kind: string): string {
  if (kind === 'paragraph') return 'A long unfinished paragraph must remain responsive while every received character is preserved. '.repeat(1600) + '\n\nPERFORMANCE_FINAL_SENTINEL'
  return Array.from({ length: 45 }, (_, index) => `### Result ${index}\n\nThe **saved result** includes a [local reference](https://example.invalid/item/${index}) and inline \`value_${index}\`.\n\n\`\`\`typescript\nconst value_${index}: number = ${index};\nfunction inspect_${index}(input: string) { return input.trim().length + value_${index}; }\n\`\`\`\n\n| Item | Result |\n| --- | --- |\n| ${index} | Complete |\n\n`).join('') + '\nPERFORMANCE_FINAL_SENTINEL'
}
function finalTextVisible(): boolean {
  const sentinel = 'PERFORMANCE_FINAL_SENTINEL', walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = node.textContent?.indexOf(sentinel) ?? -1
    if (index < 0) continue
    const range = document.createRange()
    range.setStart(node, index); range.setEnd(node, index + sentinel.length)
    const rect = range.getBoundingClientRect(), bounds = viewport.getBoundingClientRect()
    host.__performanceVisibility = { text: node.textContent?.slice(index, index + sentinel.length), rect: rect.toJSON(), viewport: bounds.toJSON(), scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight }
    if (rect.width > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) return true
  }
  return false
}
async function settleTail(): Promise<void> {
  host.scrollToBottom({ force: true })
  await frames(2)
}
async function prepare(kind: string, historyCount: number): Promise<any> {
  flush()
  unsubscribe?.()
  mutationObserver?.disconnect()
  unmountReactTranscript(viewport)
  const sessionId = `performance-${kind}-${++serial}`
  host.currentSessionId = sessionId
  window.dispatchEvent(new CustomEvent('klaus:session-change', { detail: { sessionId } }))
  // Initialize the production viewport before publishing its full loaded history.
  // Mounting all loaded rows in an unwindowed probe makes every user disclosure
  // force layout during the first commit instead of exercising the main surface.
  historyReplies.set(sessionId, [])
  stream.chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: {
    ...stream.getSessionStream(sessionId), history: [], running: true,
  } } }))
  mountReactTranscript(sessionId, viewport, { scroll: 'main' })
  await frames(3)
  const saved = history(historyCount, sessionId)
  historyReplies.set(sessionId, saved)
  stream.chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: {
    ...stream.getSessionStream(sessionId), history: saved, running: true,
    turnStatuses: Object.fromEntries(saved.filter(row => row.role === 'assistant').map(row => [row.turnId, 'completed'])),
  } } }))
  mountReactTranscript(sessionId, viewport, { scroll: 'main' })
  send({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: `${sessionId}-current` })
  flush()
  await frames(5)
  host.scrollToBottom()
  await frames(3)
  const retainedHistoryRows = stream.getSessionStream(sessionId).history?.length ?? 0
  const mountedTurns = viewport.querySelectorAll('[data-klaus-transcript-turn]').length
  const virtualSpacers = viewport.querySelectorAll('[data-virtual-turn-list]').length
  if (retainedHistoryRows !== historyCount) throw new Error('Preparation lost loaded history')
  if (virtualSpacers < 1 || mountedTurns < 1 || mountedTurns >= historyCount / 2) throw new Error('Main transcript virtualization was not exercised')
  return { historyRows: retainedHistoryRows, scrollMode: 'main', mountedTurns, virtualSpacers, domElements: viewport.querySelectorAll('*').length }
}
async function startStreaming(kind: string, historyCount = 5000): Promise<any> {
  const preparation = await prepare(kind, historyCount)
  const sessionId = host.currentSessionId
  const source = corpus(kind)
  currentSource = source
  const chunks = 1440
  scenario = { done: false, startedAt: performance.now(), deltas: 0, notifications: 0, mutations: 0, longTasks: [] }
  const current = scenario
  unsubscribe = stream.chatStreamStore.subscribe(() => { if (!current.done) current.notifications++ })
  mutationObserver = new MutationObserver(records => { if (!current.done) current.mutations += records.length })
  mutationObserver.observe(viewport, { childList: true, characterData: true, subtree: true })
  void (async () => {
    try {
      for (let fragment = 0; fragment < chunks;) {
        for (let batch = 0; batch < 12 && fragment < chunks; batch++, fragment++) {
          const text = source.slice(Math.floor(fragment * source.length / chunks), Math.floor((fragment + 1) * source.length / chunks))
          send({ type: 'text_delta', sessionId, messageId: `${sessionId}-answer`, turnId: `${sessionId}-current`, phase: 'final_answer', text })
          current.deltas++
        }
        await pause(8)
      }
      flush()
      current.durationMs = performance.now() - current.startedAt
      current.done = true
    } catch (error) { current.error = String(error); current.done = true }
  })()
  return preparation
}
function armInput(id: number): void {
  input.focus()
  inputWaiters.set(id, new Promise(resolve => {
    input.addEventListener('input', () => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ paintAt: performance.timeOrigin + performance.now(), valueLength: input.value.length })))
    }, { once: true })
  }))
}
async function settle(): Promise<any> {
  flush()
  if (typeof markdownApi.waitForMarkdownWorkerIdle === 'function') await markdownApi.waitForMarkdownWorkerIdle()
  let previous = '', stable = 0
  for (let i = 0; i < 100 && stable < 5; i++) {
    await pause(40)
    await frames(2)
    const html = viewport.innerHTML
    stable = html === previous ? stable + 1 : 0
    previous = html
  }
  await settleTail()
  const session = stream.getSessionStream(host.currentSessionId)
  if (session.history?.length !== 5000) throw new Error('Streaming discarded loaded history')
  if (scenario?.deltas !== 1440) throw new Error('The full streaming event workload was not delivered')
  const text = session.liveUnits.filter((unit: any) => unit.type === 'live-text').map((unit: any) => unit.text).join('')
  if (!text.endsWith('PERFORMANCE_FINAL_SENTINEL')) throw new Error('Received text was truncated or reordered')
  if (!viewport.textContent?.includes('PERFORMANCE_FINAL_SENTINEL')) throw new Error('Final text was not painted')
  const visible = finalTextVisible()
  return { ...scenario, retainedHistoryRows: session.history.length, finalTextInDom: true, finalTextVisible: visible,
    viewportGeometry: host.__performanceVisibility, limitations: visible ? [] : ['isolated-fixture-sentinel-outside-viewport'],
    html: viewport.innerHTML, text, domElements: viewport.querySelectorAll('*').length,
    highlightedSpans: viewport.querySelectorAll('code span[class*="hljs-"]').length,
    horizontalOverflow: viewport.scrollWidth > viewport.clientWidth + 1 }
}
async function retention(count = 50): Promise<any> {
  unmountReactTranscript(viewport)
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `retained-conversation-${i}`
    ids.push(id)
    host.currentSessionId = id
    window.dispatchEvent(new CustomEvent('klaus:session-change', { detail: { sessionId: id } }))
    await stream.loadSessionHistory(id)
  }
  host.currentSessionId = null
  window.dispatchEvent(new CustomEvent('klaus:session-change', { detail: { sessionId: null } }))
  streamApi.trimSessionStreamCache?.()
  const before = cacheStats()
  for (const id of ids) streamApi.retireSessionStream?.(id)
  await frames(2)
  return { beforeDelete: before, afterDelete: cacheStats(), visited: count }
}
async function finishTurn(): Promise<any> {
  const id = host.currentSessionId
  const answerId = `${id}-answer`
  historyReplies.set(id, [...(historyReplies.get(id) ?? []), {
    role: 'assistant', uuid: answerId, turnId: `${id}-current`, text: currentSource, phase: 'final_answer',
  }])
  send({ type: 'message_complete', sessionId: id, messageId: answerId, phase: 'final_answer' })
  send({ type: 'done', sessionId: id, turnId: `${id}-current`, finalMessageId: answerId })
  flush()
  await stream.loadSessionHistory(id)
  await pause(100)
  await frames(5)
  if (typeof markdownApi.waitForMarkdownWorkerIdle === 'function') await markdownApi.waitForMarkdownWorkerIdle()
  await settleTail()
  const session = stream.getSessionStream(id)
  if (session.history?.length !== 5001) throw new Error('Completion discarded loaded history')
  if (session.running) throw new Error('The completed turn remained running')
  if (!viewport.textContent?.includes('PERFORMANCE_FINAL_SENTINEL')) throw new Error('History handoff lost the final answer')
  const visible = finalTextVisible()
  return { html: viewport.innerHTML, savedMessages: session.history.length, finalTextInDom: true, finalTextVisible: visible,
    viewportGeometry: host.__performanceVisibility, limitations: visible ? [] : ['isolated-fixture-sentinel-outside-viewport'],
    streamingIndicators: viewport.querySelectorAll('.streaming-dots').length,
    highlightedSpans: viewport.querySelectorAll('code span[class*="hljs-"]').length,
    worker: markdownApi.markdownWorkerStats?.() ?? null }
}
function cacheStats(): any {
  const stats = streamApi.sessionStreamCacheStats?.()
  const sessions = stream.chatStreamStore.getState().sessions
  return { ...(stats ?? {}), records: Object.keys(sessions).length,
    histories: Object.values(sessions).filter(row => row.history != null).length,
    serializedHistoryBytes: Object.values(sessions).reduce((total, row) => total + (row.history ? new TextEncoder().encode(JSON.stringify(row.history)).byteLength : 0), 0) }
}

host.performanceFixture = { startStreaming, status: () => scenario, armInput, finishTurn,
  verifyTransitions: async () => { try { return await verifyMarkdownAsyncTransitions(viewport) } finally { configureWorker() } },
  verifySettledInteractions: async () => { try { return await verifySettledHighlightInteraction(viewport) } finally { configureWorker() } },
  awaitInput: (id: number) => inputWaiters.get(id), settle, retention, cacheStats,
  restoreClock: () => { Date.now = originalNow } }
