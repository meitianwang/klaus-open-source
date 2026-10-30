import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import vector from '../contracts/vectors/question-answer-placement-vectors.json'
import { TranscriptView } from '../frontend/src/chat/transcript/TranscriptView'
import { chatStreamStore, getSessionStream, loadSessionHistory, loadTurnHistoryItems, type LiveUnit, type SessionStreamState } from '../frontend/src/chat/stream-store'

/** Exercise real turn disclosures across live, summary and detail ownership. */
export async function questionAnswerPlacement(host: HTMLElement, capture: (name: string) => Promise<void> = async () => {}) {
  const w = window as any
  const previousSession = w.klaus.session
  const container = document.createElement('div')
  host.append(container)
  const root = createRoot(container)
  const results: Array<{ name: string; passed: boolean; evidence: unknown }> = []
  const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const settle = async () => { await frames(); await new Promise(resolve => setTimeout(resolve, 180)); await frames() }
  const base = Date.now() - 65000
  let id = '', serial = 0
  const answerText = 'Earlier this month'
  const finalText = 'The investigation is complete.'
  const metadata = { requestId: 'question-request', turnId: 'turn', toolCallId: 'question-tool', clientResponseId: 'response',
    questions: [{ id: 'when', question: 'When did the message arrive?', options: [] }], answers: { when: answerText } }
  const opener = { role: 'user', uuid: 'opener', turnId: 'turn', text: 'Inspect the delivery history', timestamp: base }
  const answer = { role: 'user', uuid: 'answer', turnId: 'turn', text: answerText, timestamp: base + 2000, steered: true, questionAnswer: metadata }
  const final = { role: 'assistant', uuid: 'final', turnId: 'turn', text: finalText, timestamp: base + 6000,
    isFinalReply: true, phase: 'final_answer', contentBlocks: [{ type: 'text', text: finalText, phase: 'final_answer', messageId: 'final' }] }
  const work = { role: 'assistant', uuid: 'work', turnId: 'turn', text: 'Inspecting the earlier delivery.', timestamp: base + 1000, phase: 'commentary' }
  const after = { role: 'assistant', uuid: 'after', turnId: 'turn', text: 'The answer has been considered.', timestamp: base + 3000, phase: 'commentary' }
  const live: LiveUnit[] = [
    { type: 'live-user', key: 'live-opener', turnId: 'turn', msg: opener },
    { type: 'live-text', key: 'live-work', messageId: 'work', turnId: 'turn', text: work.text, startedAtMs: work.timestamp, phase: 'commentary', streaming: false },
    { type: 'live-user', key: 'live-answer', turnId: 'turn', msg: answer },
    { type: 'live-text', key: 'live-after', messageId: 'after', turnId: 'turn', text: after.text, startedAtMs: after.timestamp, phase: 'commentary', streaming: false },
  ]
  const liveFinal: LiveUnit = { type: 'live-text', key: 'live-final', messageId: 'final', turnId: 'turn', text: finalText,
    startedAtMs: final.timestamp, phase: 'final_answer', streaming: false, turnTail: { ts: final.timestamp, meta: null } }
  const update = (patch: Partial<SessionStreamState>) => flushSync(() => chatStreamStore.setState(state => ({ sessions: {
    ...state.sessions, [id]: { ...getSessionStream(id), ...patch },
  } })))
  const mount = (surface: string, patch: Partial<SessionStreamState>) => {
    id = `question-placement:${surface}:${++serial}`
    update({ history: [], historyStale: false, running: false, activeTurnId: null, liveTurnId: 'turn', liveStartSeq: 0,
      turnStartedAtMs: { turn: base }, turnDurations: { turn: 6000 }, ...patch })
    flushSync(() => root.render(<TranscriptView key={id} sessionId={id} container={container} scroll={surface === 'main' ? 'main' : surface === 'side' ? 'simple' : 'none'} readOnly />))
  }
  const snapshot = (answerUuid = 'answer') => {
    const answers = [...container.querySelectorAll<HTMLElement>(`[data-uuid="${answerUuid}"]`)]
    const row = answers[0]
    const finalRow = [...container.querySelectorAll<HTMLElement>('[data-md]')].find(node => node.dataset.md === finalText)
    const visible = (node: HTMLElement | undefined) => !!node && !node.closest('[aria-hidden="true"]') && node.getBoundingClientRect().height > 0
    return { answerCount: answers.length, answerVisible: visible(row), finalVisible: visible(finalRow),
      answerBeforeFinal: !!row && !!finalRow && !!(row.compareDocumentPosition(finalRow) & Node.DOCUMENT_POSITION_FOLLOWING),
      answerInsideProcess: !!row?.closest('[aria-hidden]'), answerTop: row?.getBoundingClientRect().top ?? null,
      finalTop: finalRow?.getBoundingClientRect().top ?? null, headers: container.querySelectorAll('[data-activity-toggle="turn"]').length,
      expanded: container.querySelector('[data-activity-toggle="turn"]')?.getAttribute('aria-expanded'),
      userCount: container.querySelectorAll('.msg-group.user').length,
      savedIds: getSessionStream(id).history?.map(message => message.uuid), text: container.textContent }
  }
  const record = (name: string, passed: boolean, evidence: unknown) => results.push({ name, passed, evidence })
  const toggle = async () => { container.querySelector<HTMLButtonElement>('[data-activity-toggle="turn"]')?.click(); await settle() }
  const summary = { messages: [opener, final], turns: [{ id: 'turn', ordinal: 0, updatedAtOrdinal: 10, itemsView: 'summary', status: 'completed' }],
    turnStatuses: { turn: 'completed' }, turnDurations: { turn: 6000 }, page: { hasMore: false, nextCursor: null } }
  const details = [opener, work, answer, after, final]
  w.klaus.session = { ...previousSession, historyPage: async () => summary,
    historyItems: async () => ({ messages: details, page: { hasMore: false, nextCursor: null } }) }
  try {
    for (const surface of ['main', 'side']) {
      mount(surface, { liveUnits: live, running: true, activeTurnId: 'turn' })
      await settle()
      let state = snapshot()
      record(`${surface}: an answer without a following final stays visible`, state.answerVisible && state.answerCount === 1 && !state.finalVisible, state)
      update({ liveUnits: [...live, liveFinal] }); await settle()
      state = snapshot()
      record(`${surface}: final streaming retains the open answer at its arrival position`, state.answerVisible && state.answerBeforeFinal && state.headers === 1, state)
      update({ running: false, activeTurnId: null, lastTerminalStatus: 'completed' }); await settle()
      state = snapshot()
      record(`${surface}: completion folds the answer while the final remains visible`, !state.answerVisible && state.finalVisible && state.expanded === 'false', state)
      if (surface === 'main') await capture('completed')
      await toggle(); state = snapshot()
      record(`${surface}: expanding restores one answer before the final`, state.answerVisible && state.answerCount === 1 && state.answerBeforeFinal && state.answerInsideProcess, state)
      await toggle()
      await loadSessionHistory(id); await settle(); state = snapshot()
      record(`${surface}: summary handoff retains the answer before the final inside the fold`, !state.answerVisible && state.finalVisible
        && state.savedIds?.join() === 'opener,answer,final', state)
      await loadSessionHistory(id); await settle(); state = snapshot()
      record(`${surface}: a repeated summary keeps the same answer position`, state.savedIds?.join() === 'opener,answer,final' && !state.answerVisible, state)
      await loadTurnHistoryItems(id, 'turn'); await settle()
      await toggle(); state = snapshot()
      record(`${surface}: detail hydration replaces the snapshot once in arrival order`, state.answerVisible && state.answerCount === 1
        && state.answerBeforeFinal && state.savedIds?.join() === 'opener,work,answer,after,final', state)
    }
    mount('mixed', { history: [opener, work, final], turnStatuses: { turn: 'completed' }, liveUnits: [live[2]] })
    await settle(); let state = snapshot()
    record('a saved final and a remaining live answer share one collapsed process', !state.answerVisible && state.finalVisible && state.headers === 1, state)
    await toggle(); state = snapshot()
    record('the mixed process expands with the answer before its final', state.answerVisible && state.answerCount === 1 && state.answerBeforeFinal, state)
    mount('cold', { history: details, turnStatuses: { turn: 'completed' }, liveUnits: [] })
    await settle(); state = snapshot()
    record('cold history starts with its completed answer folded', !state.answerVisible && state.finalVisible && state.headers === 1, state)
    await toggle(); state = snapshot()
    record('cold history expands the original answer at its original position', state.answerVisible && state.answerCount === 1 && state.answerBeforeFinal, state)
    await capture('expanded')
    mount('late', { history: [opener, work, final], turnStatuses: { turn: 'completed' },
      liveUnits: [{ ...live[2], msg: { ...answer, timestamp: base + 9000 } } as LiveUnit] })
    await settle(); state = snapshot()
    record('an explicitly late answer stays visible after the final', state.answerVisible && state.finalVisible && !state.answerBeforeFinal, state)
    const nextAnswer = { ...answer, uuid: 'late-answer', turnId: 'reply-turn', timestamp: base + 9000 }
    const nextFinal = { ...final, uuid: 'next-final', turnId: 'reply-turn', text: 'The follow-up is complete.', timestamp: base + 12000,
      contentBlocks: [{ type: 'text', text: 'The follow-up is complete.', phase: 'final_answer' }] }
    mount('next-turn-saved', { history: [...details, nextAnswer, nextFinal], turnStatuses: { turn: 'completed', 'reply-turn': 'completed' }, liveUnits: [] })
    await settle(); state = snapshot('late-answer')
    record('an answer opening a later saved turn stays visible after its own final', state.answerVisible && state.answerCount === 1 && !state.answerBeforeFinal, state)
    mount('next-turn-live', { history: [opener, work, final], turnStatuses: { turn: 'completed', 'reply-turn': 'completed' },
      liveTurnId: 'reply-turn', liveUnits: [{ type: 'live-user', key: 'next-answer', turnId: 'reply-turn', msg: nextAnswer },
        { type: 'live-text', key: 'next-final', turnId: 'reply-turn', text: nextFinal.text, phase: 'final_answer', streaming: false }] })
    await settle(); state = snapshot('late-answer')
    record('an answer opening a later live turn stays visible after its own final', state.answerVisible && state.answerCount === 1 && !state.answerBeforeFinal, state)
    mount('interrupted', { history: [], liveUnits: [...live], turnStatuses: { turn: 'interrupted' }, interruptedLiveTurn: { turnId: 'turn' } })
    await settle(); state = snapshot()
    record('an interrupted turn without a final keeps its answer visible', state.answerVisible && state.answerCount === 1 && !state.finalVisible, state)
    if (vector.presentation.beforeFollowingFinal !== 'turn-process' || vector.presentation.withoutFollowingFinal !== 'visible-user-message'
      || vector.presentation.afterFinal !== 'visible-user-message' || vector.presentation.expandedOrder !== 'arrival-order'
      || vector.presentation.summaryHandoff !== 'preserve-order-and-uuid') throw Error('Question placement coverage differs from its contract')
    return results
  } finally { flushSync(() => root.unmount()); container.remove(); w.klaus.session = previousSession }
}
