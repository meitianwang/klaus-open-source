import { userMessageStability } from './user-message-stability-dom'
import { userMessageContinuity } from './user-message-continuity-dom'
import { questionAnswerPlacement } from './question-answer-placement-dom'
import { friendReplyAppearance } from './friend-reply-appearance-dom'
import { setPendingSubmissionRecovery, clearPendingSubmissionRecovery } from '../frontend/src/chat/composer/pending-submission'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { LiveTail, StaticTranscriptView, TranscriptView } from '../frontend/src/chat/transcript/TranscriptView'
import { chatStreamStore, getSessionStream, beginPendingUserTurn, movePendingUserTurn, finishPendingUserTurn, discardPendingUserTurn, type LiveUnit, type SessionStreamState } from '../frontend/src/chat/stream-store'

const w = window as any
w.currentLang = 'en'
let hostLookups = 0
let recoveryClicks = 0
w.klaus = { media: { url: () => '' }, session: { getResolvedWorkdir: async () => { hostLookups++; return { workdir: null } }, history: async () => { hostLookups++; return { messages: [] } } } }
const container = document.getElementById('root')!
const root = createRoot(container)
const unitProps = { isThinkingExpanded: () => false, onToggleThinking: () => {}, archived: false,
  running: true, composerAuthored: false, readOnly: true, editTarget: null }
let id = ''
let serial = 0
let start = 0
let finalStart: number | null = null
let hasWork = false
let running = true

function update(patch: Partial<SessionStreamState> & { turnWorkStartedAtMs?: Record<string, number>; turnWorkCompletedAtMs?: Record<string, number> }) {
  flushSync(() => chatStreamStore.setState({ sessions: {
    ...chatStreamStore.getState().sessions, [id]: { ...getSessionStream(id), ...patch },
  } }))
}
function units(): LiveUnit[] {
  const rows: LiveUnit[] = [{ type: 'live-user', key: 'user', turnId: 'turn', msg: { role: 'user', text: 'Check the saved changes', timestamp: start } }]
  if (hasWork) rows.push({ type: 'live-text', key: 'commentary', turnId: 'turn', text: 'Inspecting the saved changes.', phase: 'commentary', streaming: false })
  if (finalStart != null) rows.push({ type: 'live-text', key: 'final', turnId: 'turn', text: 'The final answer stays visible.', phase: 'final_answer', streaming: running, startedAtMs: finalStart } as LiveUnit)
  return rows
}
function mount(surface = 'main', age = 0) {
  id = `${surface === 'subagent' ? 'subagent:fixture:' : surface + ':'}${++serial}`
  start = Date.now() - age; finalStart = null; hasWork = false; running = true
  update({ ...getSessionStream('missing-fixture'), history: [], historyStale: false,
    running: true, activeTurnId: 'turn', liveTurnId: 'turn', turnStartedAt: start,
    turnStartedAtMs: { turn: start }, liveUnits: units(), activityVisible: true })
  flushSync(() => root.render(<LiveTail key={id} sessionId={id} unitProps={unitProps} />))
}
function mountMixedHistory(mode: 'placeholder' | 'saved-process' | 'live-process' | 'both-process' = 'placeholder') {
  mount('mixed', 2500)
  hasWork = mode === 'live-process' || mode === 'both-process'
  update({ history: [
    { role: 'user', uuid: 'history-user', turnId: 'turn', text: 'Check the saved changes', timestamp: start },
    ...(mode === 'saved-process' || mode === 'both-process'
      ? [{ role: 'assistant', uuid: 'history-commentary', turnId: 'turn', phase: 'commentary', text: 'Saved process.', timestamp: start + 200 }]
      : []),
  ], liveUnits: units() })
  flushSync(() => root.render(<TranscriptView key={id} sessionId={id} container={container} readOnly />))
}
function mountPending() {
  id = `pending:fixture:${++serial}`; start = Date.now(); hasWork = false; running = true; finalStart = null; hostLookups = 0
  flushSync(() => beginPendingUserTurn(id, { text: 'A submitted request waiting for its session', uuid: 'pending-user', timestamp: start }, { provisional: true }))
  flushSync(() => root.render(<TranscriptView key={id} sessionId={id} container={container} readOnly />))
}
function failPending() {
  setPendingSubmissionRecovery('pending-user', { action: 'back', run: () => {
    recoveryClicks++; clearPendingSubmissionRecovery('pending-user'); flushSync(() => discardPendingUserTurn(id, 'pending-user'))
  } })
  flushSync(() => finishPendingUserTurn(id, 'pending-user', 'failed', 'The conversation could not be created.'))
}
function recoverPending() { container.querySelector<HTMLButtonElement>('[data-submission-recovery]')?.click() }
function locale(language: string) { w.currentLang = language; window.dispatchEvent(new Event('klaus:lang-change')) }
function promotePending() {
  const previous = id; id = `accepted:fixture:${serial}`
  flushSync(() => movePendingUserTurn(previous, id, 'pending-user'))
  flushSync(() => root.render(<TranscriptView key={id} sessionId={id} container={container} readOnly />))
  finishPendingUserTurn(id, 'pending-user', 'accepted')
}
function addWork() { hasWork = true; update({ liveUnits: units() }) }
function startFinal() { finalStart = Date.now(); update({ liveUnits: units() }) }
function complete() {
  running = false
  update({ running: false, activeTurnId: null, turnStartedAt: 0, liveUnits: units(),
    turnDurations: { turn: Date.now() - start }, activityVisible: false, lastTerminalStatus: 'completed' })
}
function handoffHistory() {
  update({ running: false, activeTurnId: null, liveUnits: [], historyStale: false,
    turnStartedAtMs: { turn: start + 1000 }, turnWorkStartedAtMs: { turn: start },
    turnWorkCompletedAtMs: finalStart != null ? { turn: finalStart } : {},
    history: [
      { role: 'user', uuid: 'history-user', turnId: 'turn', text: 'Check the saved changes', timestamp: start + 1000 },
      { role: 'assistant', uuid: 'history-commentary', turnId: 'turn', phase: 'commentary', text: 'Inspecting the saved changes.', timestamp: start + 1200 },
      { role: 'assistant', uuid: 'history-final', turnId: 'turn', phase: 'final_answer', text: 'The final answer stays visible.', timestamp: (finalStart ?? start) + 5000 },
    ] })
  flushSync(() => root.render(<TranscriptView key={`history-${id}`} sessionId={id} container={container} readOnly />))
}
function toggle() { container.querySelector<HTMLButtonElement>('[data-activity-toggle="turn"]')?.click() }
function mountStatic(active = true) {
  start = Date.now() - 2500
  flushSync(() => root.render(<StaticTranscriptView key={`static-${++serial}`} container={container} running={active}
    msgs={[
      { role: 'user', uuid: 'saved-user', turnId: 'saved-turn', text: 'Saved request', timestamp: start },
      { role: 'assistant', uuid: 'saved-commentary', turnId: 'saved-turn', phase: 'commentary', text: 'Saved process.', timestamp: start + 200 },
      { role: 'assistant', uuid: 'saved-final', turnId: 'saved-turn', phase: 'final_answer', text: 'Saved final answer.', timestamp: start + 2000 },
    ]} />))
}
function countTurnHorizontalRules() {
  return [...container.querySelectorAll<HTMLElement>('[data-klaus-transcript-turn-id] *, [data-work-divider] *, [data-variant="turn"] *')].filter(el => {
    const cls = typeof el.className === 'string' ? el.className : ''
    if (cls.includes('turn-terminal-rule') || /\bdivider\b/.test(cls)) return true
    const rect = el.getBoundingClientRect()
    if (rect.width <= 120 || rect.height > 2) return false
    const cs = getComputedStyle(el)
    return parseFloat(cs.borderTopWidth) > 0 || (rect.height > 0 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)')
  }).length
}
function mountInterruptedContinuation() {
  id = `interrupted-continuation:${++serial}`
  const now = Date.now()
  w.currentLang = 'zh'
  update({
    ...getSessionStream('missing-fixture'),
    historyStale: false,
    history: [
      { role: 'user', uuid: 'u0', turnId: 'prev-turn', text: '先看一下线上表现', timestamp: now - 180_000 },
      { role: 'assistant', uuid: 'a0', turnId: 'prev-turn', phase: 'final_answer', text: '旧路径下状态行和折叠头会重复渲染，问题仍在。', timestamp: now - 160_000 },
      { role: 'user', uuid: 'u1', turnId: 'stopped-turn', text: '那最近提交的代码有从根本修复这个问题吗', timestamp: now - 140_000 },
      {
        role: 'assistant', uuid: 'a1-tool', turnId: 'stopped-turn', timestamp: now - 135_000,
        contentBlocks: [{ type: 'tool_use', id: 'bash-stop-1', name: 'bash', input: { command: 'git log -n 5 --oneline' } }],
      },
    ],
    liveUnits: [],
    turnStatuses: { 'prev-turn': 'completed', 'stopped-turn': 'interrupted' },
    turnDurations: { 'prev-turn': 12_000, 'stopped-turn': 90_000 },
    turnCancelledTools: { 'stopped-turn': ['bash-stop-1'] },
    running: true,
    activeTurnId: 'continued-turn',
    liveTurnId: 'continued-turn',
    turnStartedAt: now - 41_200,
    turnStartedAtMs: { 'stopped-turn': now - 140_000, 'continued-turn': now - 41_200 },
    thinkingActive: true,
    activityVisible: true,
    streamMode: 'requesting',
  })
  flushSync(() => root.render(<TranscriptView key={id} sessionId={id} container={container} readOnly />))
}
function measureInterruptedContinuation() {
  const stoppedTurn = container.querySelector<HTMLElement>('[data-klaus-transcript-turn-id="stopped-turn"]')
  const toggleBtn = stoppedTurn?.querySelector<HTMLButtonElement>('[data-activity-toggle="turn"]') ?? null
  const stoppedLabel = toggleBtn?.querySelector<HTMLElement>('[data-work-label]') ?? null
  const activeDividerLabel = container.querySelector<HTMLElement>('[data-work-divider="working"] [data-work-label]')
  const stoppedRect = stoppedLabel?.getBoundingClientRect()
  const activeRect = activeDividerLabel?.getBoundingClientRect()
  const stoppedCs = stoppedLabel ? getComputedStyle(stoppedLabel) : null
  const activeCs = activeDividerLabel ? getComputedStyle(activeDividerLabel) : null
  const toolRow = stoppedTurn?.querySelector<HTMLElement>('[data-activity-group], [data-tool-call-id], button') ?? null
  const collapsibleSection = stoppedTurn?.querySelector<HTMLElement>('[data-variant="turn"] [aria-hidden]') ?? null
  const text = container.textContent || ''
  return {
    disclosureOpen: stoppedTurn?.querySelector('[data-variant="turn"]')?.getAttribute('data-open') ?? null,
    ariaExpanded: toggleBtn?.getAttribute('aria-expanded') ?? null,
    stoppedHeaderText: stoppedLabel?.textContent ?? '',
    activeWorkText: activeDividerLabel?.textContent ?? '',
    stoppedOccurrences: text.split('你在 1分钟 30秒 后停止了').length - 1,
    workedForStoppedOccurrences: text.split('用时 1分钟 30秒').length - 1,
    activeOccurrences: text.split('已处理 41秒').length - 1,
    horizontalRules: countTurnHorizontalRules(),
    deltaLeft: stoppedRect && activeRect ? Math.round(stoppedRect.left - activeRect.left) : null,
    stoppedFontSize: stoppedCs?.fontSize ?? null,
    activeFontSize: activeCs?.fontSize ?? null,
    stoppedLineHeight: stoppedCs?.lineHeight ?? null,
    activeLineHeight: activeCs?.lineHeight ?? null,
    sectionHidden: collapsibleSection?.getAttribute('aria-hidden') ?? null,
    hasToolRow: !!toolRow,
  }
}
function toggleStoppedTurn() {
  container.querySelector<HTMLButtonElement>('[data-klaus-transcript-turn-id="stopped-turn"] [data-activity-toggle="turn"]')?.click()
}
function snapshot() {
  const header = container.querySelector<HTMLButtonElement>('[data-activity-toggle="turn"]')
  const work = container.querySelector('[data-work-label]')
  const text = container.textContent || ''
  const content = [...container.querySelectorAll<HTMLElement>('[data-md]')]
  const process = content.find(row => /Inspecting|Saved process/.test(row.dataset.md || ''))
  const final = content.find(row => /final answer/.test(row.dataset.md || ''))
  const visible = (row: HTMLElement | undefined) => !!row && !row.closest('[aria-hidden="true"]') && row.getBoundingClientRect().height > 0
  return { label: work?.textContent || '', workLabels: container.querySelectorAll('[data-work-label]').length,
    placeholderRows: container.querySelectorAll('[data-work-divider]').length,
    disclosureHeaders: container.querySelectorAll('[data-activity-toggle="turn"]').length,
    horizontalRules: countTurnHorizontalRules(),
    expanded: header?.getAttribute('aria-expanded') ?? null, processVisible: visible(process), finalVisible: visible(final),
    headerBeforeProcess: !!header && !!process && !!(header.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING),
    text, hostLookups, recoveryClicks, recoveryAction: container.querySelector('[data-submission-recovery]')?.getAttribute('data-submission-recovery') ?? null, userMessages: container.querySelectorAll('[data-nav-turn="true"]').length, clockStart: getSessionStream(id).turnStartedAt }
}
w.processingFixture = { mountPending, failPending, recoverPending, locale, promotePending, mount, addWork, startFinal, complete, handoffHistory, toggle, mountStatic, snapshot,
  mountMixedHistory, mountInterruptedContinuation, measureInterruptedContinuation, toggleStoppedTurn,
  userMessageStability: () => userMessageStability(container, root), userMessageContinuity: () => userMessageContinuity(container),
  questionAnswerPlacement: () => questionAnswerPlacement(container),
  friendReplyAppearance: () => friendReplyAppearance(container) }
