import { mountReactTranscript, unmountReactTranscript } from './transcript'
import { getSessionStream, loadSessionHistory, retireSessionStream } from './stream-store'
import { TranscriptScrollController, registerTranscriptScrollController } from './transcript-scroll-controller'
import { setMarkdownWorkerFactory } from './markdown'

const host = window as any
host.currentLang = 'en'
host.getKnownSessionInfo = () => ({})
setMarkdownWorkerFactory(() => new Worker(new URL('./retention-markdown-worker.js', location.href), { type: 'module' }))
const errors: string[] = [], calls: any[] = [], samples: any[] = [], inputs: any[] = []
let phase = 'idle'
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason?.stack ?? event.reason)))
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
const turnIds = ['retention-t0', 'retention-t1', 'retention-t2', 'retention-t3', 'retention-t4']
const startTime = Date.now() - 600_000
const rows = new Map(turnIds.map((turnId, index) => {
  const timestamp = startTime + index * 60_000
  const user = { uuid: `${turnId}-user`, role: 'user', turnId, timestamp, text: `Question ${index}: inspect the durable history and keep every source message.`,
    contentBlocks: [{ type: 'text', text: `Question ${index}: inspect the durable history and keep every source message.` }] }
  const tools = Array.from({ length: 238 }, (_, tool) => ({ uuid: `${turnId}-tool-${tool}`, role: 'assistant', turnId, timestamp: timestamp + tool + 1, text: '',
    contentBlocks: [{ type: 'tool_use', id: `${turnId}-call-${tool}`, name: 'read', input: { path: `/fixture/source-${index}-${tool}.ts` },
      __result: { type: 'tool_result', tool_use_id: `${turnId}-call-${tool}`, content: [{ type: 'text', text: `Source output ${index}/${tool}` }], is_error: false } }] }))
  const text = `### Answer ${index}\n\n` + Array.from({ length: 8 }, (_, paragraph) => `Paragraph ${paragraph}: ` + Array.from({ length: 52 }, (_, word) => `history${word}`).join(' ')).join('\n\n')
  const final = { uuid: `${turnId}-final`, role: 'assistant', turnId, timestamp: timestamp + 5000, text, isFinalReply: true,
    contentBlocks: [{ type: 'text', text, phase: 'final_answer', messageId: `${turnId}-final` }] }
  return [turnId, [user, ...tools, final]]
}))
const allIds = new Set([...rows.values()].flat().map(row => row.uuid))
const shell = (turnId: string, itemsView: string) => {
  const index = turnIds.indexOf(turnId)
  return { id: turnId, ordinal: index * 1000, updatedAtOrdinal: index * 1000 + 999, itemsView, status: 'completed',
    startedAtMs: startTime + index * 60_000, finishedAtMs: startTime + index * 60_000 + 6000, durationMs: 6000 }
}
host.klaus = { session: {
  historyPage: async (sessionId: string, options: any) => {
    calls.push({ method: 'historyPage', sessionId, options: { ...options }, at: performance.now() })
    await delay(30)
    const end = options.cursor ? Number(options.cursor) : turnIds.length
    const start = Math.max(0, end - options.limit), selected = turnIds.slice(start, end)
    return { supportsItemAnchors: true, messages: selected.flatMap(id => options.itemsView === 'full' ? rows.get(id)! : [rows.get(id)![0], rows.get(id)!.at(-1)]),
      turns: selected.map(id => shell(id, options.itemsView)), turnStatuses: Object.fromEntries(selected.map(id => [id, 'completed'])),
      turnStartedAtMs: Object.fromEntries(selected.map(id => [id, shell(id, options.itemsView).startedAtMs])),
      turnFinishedAtMs: Object.fromEntries(selected.map(id => [id, shell(id, options.itemsView).finishedAtMs])),
      turnDurations: Object.fromEntries(selected.map(id => [id, 6000])),
      page: { hasMore: start > 0, nextCursor: start > 0 ? String(start) : null } }
  },
  historyItems: async (sessionId: string, options: any) => {
    const call: any = { method: 'historyItems', sessionId, options: { ...options }, at: performance.now() }; calls.push(call)
    await delay(60)
    const all = rows.get(options.turnId) ?? []
    if (options.beforeItemId && options.cursor) throw new Error('cursor and beforeItemId are mutually exclusive')
    const anchor = options.cursor || options.beforeItemId
    const end = anchor ? all.findIndex(row => row.uuid === anchor) : all.length
    if (end < 0) throw new Error('unknown item anchor')
    const start = options.sortDirection === 'asc' ? 0 : Math.max(0, end - options.limit)
    const page = options.sortDirection === 'asc' ? all.slice(0, options.limit) : all.slice(start, end)
    call.end = performance.now(); call.returnedIds = page.map(row => row.uuid)
    return { supportsItemAnchors: true, messages: page, page: { hasMore: start > 0, nextCursor: start > 0 ? all[start].uuid : null } }
  },
} }
const primary = document.getElementById('messages')!, secondary = document.getElementById('secondary')!
const controllers = new Map<HTMLElement, TranscriptScrollController>()
for (const element of [primary, secondary]) {
  const controller = new TranscriptScrollController({ scrollEl: element, responseSpacer: element === primary })
  registerTranscriptScrollController(controller); controllers.set(element, controller)
}
let currentId = '', sampling = false
for (const element of [primary, secondary]) element.addEventListener('wheel', event => inputs.push({ phase, target: element.id, trusted: event.isTrusted, deltaY: event.deltaY }), { passive: true })
function viewportGeometry(element: HTMLElement) {
  const bounds = element.getBoundingClientRect()
  const frames = [...element.querySelectorAll<HTMLElement>('[data-virtual-turn-key]')].map(row => {
    const box = row.getBoundingClientRect(), outer = row.parentElement!.getBoundingClientRect()
    return { key: row.dataset.virtualTurnKey, top: box.top - bounds.top, height: box.height, wrapper: outer.height,
      text: row.textContent?.slice(0, 100), visible: box.bottom > bounds.top && box.top < bounds.bottom,
      users: [...row.querySelectorAll('[data-uuid]')].map(node => node.getAttribute('data-uuid')) }
  })
  return { top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight,
    distance: element.scrollHeight - element.clientHeight - element.scrollTop, frames,
    inflatedEmpty: frames.filter(row => row.height < 2 && row.wrapper > 2),
    visibleCoverage: frames.some(row => row.visible && row.height > 1) }
}
function snapshot() {
  const state = getSessionStream(currentId), source = state.history ?? [], ids = source.map(row => row.uuid)
  return { at: performance.now(), phase, id: currentId, items: ids.length, unique: new Set(ids).size, unknown: ids.filter(id => !allIds.has(id)),
    shells: Object.values(state.savedTranscript?.entitiesByKey ?? {}).map(turn => ({ id: turn.id, count: turn.items.length, pager: turn.itemsPagination })),
    primary: viewportGeometry(primary), secondary: viewportGeometry(secondary), calls: calls.length, errors: [...errors] }
}
function sample() { if (!sampling) return; samples.push(snapshot()); requestAnimationFrame(sample) }
host.retentionFixture = {
  calls, errors, samples, inputs, snapshot,
  phase(value: string) { phase = value },
  async frames(count = 12) { for (let i = 0; i < count; i++) await frame() },
  recoveredPrompts() { return turnIds.filter(id => (getSessionStream(currentId).history ?? []).some(row => row.uuid === `${id}-user`)) },
  sourceIds() { return [...allIds] },
  historyIds() { return (getSessionStream(currentId).history ?? []).map(row => row.uuid) },
  async open(multi: boolean) {
    if (currentId) { unmountReactTranscript(primary); unmountReactTranscript(secondary); retireSessionStream(currentId, { deleted: false }) }
    currentId = `retention-ui-${multi ? 'multi' : 'single'}`
    secondary.style.display = multi ? 'block' : 'none'
    controllers.get(primary)!.resetForConversation(0)
    controllers.get(secondary)!.resetForConversation(multi ? 1000 : 0)
    mountReactTranscript(currentId, primary, { scroll: 'main' })
    if (multi) mountReactTranscript(currentId, secondary, { scroll: 'main' })
    await loadSessionHistory(currentId)
    for (let i = 0; i < 40; i++) await frame()
    return snapshot()
  },
  start() { sampling = true; requestAnimationFrame(sample) }, stop() { sampling = false },
  async bottomSecondary() { controllers.get(secondary)!.scrollToDistanceFromBottomPx(0, 'instant'); for (let i = 0; i < 30; i++) await frame(); return snapshot() },
  async expand(turnId: string) { primary.querySelector<HTMLElement>(`[data-klaus-transcript-turn-id="${turnId}"] [data-activity-toggle="turn"]`)?.click(); for (let i = 0; i < 50; i++) await frame(); return snapshot() },
}
host.fixtureReady = true
