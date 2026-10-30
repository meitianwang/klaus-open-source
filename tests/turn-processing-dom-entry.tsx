import { userMessageStability } from './user-message-stability-dom'
import { userMessageContinuity } from './user-message-continuity-dom'
import { questionAnswerPlacement } from './question-answer-placement-dom'
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
    expanded: header?.getAttribute('aria-expanded') ?? null, processVisible: visible(process), finalVisible: visible(final),
    headerBeforeProcess: !!header && !!process && !!(header.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING),
    text, hostLookups, recoveryClicks, recoveryAction: container.querySelector('[data-submission-recovery]')?.getAttribute('data-submission-recovery') ?? null, userMessages: container.querySelectorAll('[data-nav-turn="true"]').length, clockStart: getSessionStream(id).turnStartedAt }
}
w.processingFixture = { mountPending, failPending, recoverPending, locale, promotePending, mount, addWork, startFinal, complete, handoffHistory, toggle, mountStatic, snapshot,
  mountMixedHistory,
  userMessageStability: () => userMessageStability(container, root), userMessageContinuity: () => userMessageContinuity(container),
  questionAnswerPlacement: () => questionAnswerPlacement(container) }
