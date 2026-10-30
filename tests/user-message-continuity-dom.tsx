import { flushSync } from 'react-dom'
import vectors from '../contracts/vectors/user-message-display-vectors.json'
import { mountReactTranscript, unmountReactTranscript } from '../frontend/src/chat/transcript'
import { composerDocumentFromText, snapshotComposerDocument } from '../frontend/src/chat/composer/document-model'
import { beginPendingUserTurn, bindPendingUserTurn, chatStreamStore, finishPendingUserTurn, getSessionStream,
  ingestChatEvent, loadSessionHistory, loadOlderHistoryPage, movePendingUserTurn } from '../frontend/src/chat/stream-store'

export async function userMessageContinuity(host: HTMLElement) {
  const w = window as any
  const originalSession = w.klaus.session
  const originalMedia = w.klaus.media
  const OriginalImage = window.Image
  const previousAvatar = w.__klausProfileAvatar
  const content = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="80"><rect width="60" height="80" fill="coral"/></svg>'
  const preview = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
  const durable = 'data:image/svg+xml,' + encodeURIComponent(content.replace('coral', 'steelblue'))
  const container = document.createElement('div')
  container.style.cssText = 'max-width:720px;margin:auto'
  host.append(container)
  let releaseDecode!: () => void
  const decodeGate = new Promise<void>(resolve => { releaseDecode = resolve })
  w.Image = function(...args: any[]) {
    const image = new OriginalImage(...args)
    const decode = image.decode.bind(image)
    image.decode = () => decodeGate.then(decode)
    return image
  }
  w.__klausProfileAvatar = { name: 'Fixture owner', url: durable }
  let reply: any = { messages: [] }
  w.klaus.session = { ...originalSession, historyPage: undefined, history: async () => reply }
  w.klaus.media = { ...originalMedia, url: () => durable }
  const id = `continuity-${Date.now()}`
  const pendingId = `pending:${id}`, sessionId = `saved:${id}`, uuid = `submission:${id}`
  const text = 'Keep this sent message and its image stable'
  const localRender = { displayText: text, composerDocument: snapshotComposerDocument(composerDocumentFromText(text)),
    attachments: [{ type: 'image', name: 'shot.svg', path: '/uploads/shot.svg', src: preview }] }
  const results: any[] = []
  const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const capture = () => {
    const row = [...container.querySelectorAll('.msg-group.user')].find(element => element.textContent?.includes(text)) || null
    return { row, bubble: row?.querySelector('.sent-user-stack > .msg.user'), body: row?.querySelector('[data-user-message-body]'),
      text: row?.querySelector('[data-user-message-body] p'), image: row?.querySelector('.kls-attach-thumb img'),
      avatar: row?.querySelector('[data-owner-sender-col] img') }
  }
  async function step(name: string, update: () => void | Promise<void>, extra: () => boolean = () => true) {
    const before = capture()
    if (!before.bubble || !before.image) throw Error(`Missing fixture content before ${name}`)
    const range = document.createRange()
    range.selectNodeContents(before.bubble.querySelector('[data-user-message-body]')!)
    const selection = document.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    const selected = selection.toString()
    let removedImages = 0
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) if (node instanceof Element && (node.matches('img') || node.querySelector('img'))) removedImages++
    })
    observer.observe(container, { subtree: true, childList: true })
    await update(); await frames()
    observer.disconnect()
    const after = capture()
    const stable = Object.fromEntries(Object.keys(before).map(name => {
      const key = name as keyof typeof before
      return [key, !!before[key] && before[key] === after[key]]
    }))
    const selectedAfter = selection.toString()
    const images = [...(after.row?.querySelectorAll<HTMLImageElement>('.kls-attach-thumb img') || [])]
    results.push({ name, passed: Object.values(stable).every(Boolean) && removedImages === 0 && !!selected && selected === selectedAfter && extra(),
      stable, removedImages, selectionPreserved: selected === selectedAfter, thumbnails: images.length, source: images[0]?.getAttribute('src'),
      loaded: images[0]?.complete && images[0]?.naturalWidth > 0 })
  }
  try {
    flushSync(() => {
      beginPendingUserTurn(pendingId, { text, uuid, ...localRender }, { provisional: true })
      mountReactTranscript(pendingId, container, { scroll: 'main', readOnly: true })
    })
    await frames()
    await step('pending conversation promotion', () => flushSync(() => {
      movePendingUserTurn(pendingId, sessionId, uuid)
      mountReactTranscript(sessionId, container, { scroll: 'main' })
    }))
    await step('turn acknowledgement', () => flushSync(() => ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'current-turn' } as any)))
    await step('message acknowledgement', () => flushSync(() => bindPendingUserTurn(sessionId, uuid, 'saved-user')))
    await step('streamed output', () => flushSync(() => ingestChatEvent({ type: 'text_delta', sessionId, text: 'Inspecting the attachment.' } as any)))
    finishPendingUserTurn(sessionId, 'saved-user', 'accepted')
    const assistant = { role: 'assistant', uuid: 'saved-assistant', turnId: 'current-turn', text: 'The response is complete.', isFinalReply: true,
      contentBlocks: [{ type: 'text', text: 'The response is complete.', phase: 'final_answer' }] }
    const savedUser = { role: 'user', uuid: 'saved-user', turnId: 'current-turn', text,
      localRender: { displayText: text, composerDocument: structuredClone(localRender.composerDocument) },
      contentBlocks: [{ type: 'image', name: 'shot.svg', path: '/pool/shot.svg' }] }
    reply = { messages: [assistant], turnStatuses: { 'current-turn': 'completed' } }
    flushSync(() => chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: {
      ...getSessionStream(sessionId), running: false, activeTurnId: null, lastTerminalStatus: 'completed', historyStale: false } } })))
    await step('history arrives before its user row', () => loadSessionHistory(sessionId), () => container.querySelectorAll('.msg-group.user').length === 1)
    reply = { ...reply, messages: [savedUser, assistant] }
    await step('saved history takes ownership', () => loadSessionHistory(sessionId), () => (capture().image as HTMLImageElement).getAttribute('src') === preview)
    await step('durable preview decodes', async () => { releaseDecode(); await frames() }, () => (capture().image as HTMLImageElement).getAttribute('src') === durable)
    const older = [{ role: 'user', uuid: 'old-user', turnId: 'old-turn', text: 'An older request' },
      { role: 'assistant', uuid: 'old-assistant', turnId: 'old-turn', text: 'An older answer', isFinalReply: true }]
    w.klaus.session.historyPage = async (_id: string, options: { cursor?: string } = {}) => options.cursor
      ? { messages: older, turnStatuses: { 'old-turn': 'completed' }, turns: [{ id: 'old-turn', status: 'completed' }], page: { hasMore: false, nextCursor: null } }
      : { ...reply, turns: [{ id: 'current-turn', status: 'completed' }], page: { hasMore: true, nextCursor: 'older' } }
    w.klaus.session.historyItems = async (_id: string, options: { turnId: string }) => ({
      messages: options.turnId === 'old-turn' ? older : [savedUser, assistant], page: { hasMore: false, nextCursor: null } })
    await step('history refresh', () => loadSessionHistory(sessionId), () => container.querySelectorAll('.kls-attach-thumb').length === 1)
    await step('older history prepends', () => loadOlderHistoryPage(sessionId).then(() => {}),
      () => container.textContent?.includes('An older request') === true)
    // Paged refreshes must retain the earlier window the reader already loaded.
    const primaryBeforeRefresh = container.querySelector('[data-uuid="saved-user"]')
    await loadSessionHistory(sessionId); await frames()
    results.push({ name: 'paged refresh retains the loaded window', passed: container.textContent?.includes('An older request') === true
      && container.querySelector('[data-uuid="saved-user"]') === primaryBeforeRefresh, users: container.querySelectorAll('.msg-group.user').length })
    // A cold mount must restore the durable thumbnail without a live preview.
    unmountReactTranscript(container)
    flushSync(() => mountReactTranscript(sessionId, container, { scroll: 'main' }))
    await frames()
    const cold = container.querySelector<HTMLImageElement>('[data-uuid="saved-user"] .kls-attach-thumb img')
    results.push({ name: 'cold replay restores one durable thumbnail', passed: !!cold?.complete && cold.naturalWidth > 0 && cold.getAttribute('src') === durable
      && container.querySelectorAll('[data-uuid="saved-user"] .kls-attach-thumb').length === 1 })
    // A resumed turn can appear on both sides of another turn; each segment keeps its own user row.
    const resumedId = `${sessionId}:segments`
    const messages = [
      { role: 'user', uuid: 'segment-a', turnId: 'turn-a', text: 'First request' },
      { role: 'assistant', uuid: 'process-a', turnId: 'turn-a', text: 'First process', phase: 'commentary' },
      { role: 'user', uuid: 'segment-b', turnId: 'turn-b', text: 'Second request' },
      { role: 'assistant', uuid: 'process-b', turnId: 'turn-b', text: 'Second process', phase: 'commentary' },
      { role: 'user', uuid: 'segment-c', turnId: 'turn-a', text: 'Follow-up inside the first turn', steered: true },
      { role: 'assistant', uuid: 'final-a', turnId: 'turn-a', text: 'Final answer', isFinalReply: true, phase: 'final_answer' },
    ]
    w.klaus.session.historyPage = undefined
    reply = { messages, turnStatuses: { 'turn-a': 'completed', 'turn-b': 'completed' } }
    flushSync(() => {
      chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [resumedId]: { ...getSessionStream(resumedId), history: [],
        historyStale: false, running: false, liveTurnId: 'turn-a', liveUnits: messages.map((message, index) => message.role === 'user'
          ? { type: 'live-user', key: `segment-${index}`, turnId: message.turnId, msg: message }
          : { type: 'live-text', key: `segment-${index}`, turnId: message.turnId, text: message.text, phase: message.phase,
            streaming: false, turnTail: !!message.isFinalReply }) as any } } }))
      mountReactTranscript(resumedId, container, { scroll: 'main' })
    })
    await frames()
    const beforeSegments = [...container.querySelectorAll('.msg-group.user')]
    await loadSessionHistory(resumedId); await frames()
    const afterSegments = [...container.querySelectorAll('.msg-group.user')]
    results.push({ name: 'resumed turns preserve steered message order and identity', passed: beforeSegments.length === 3 && afterSegments.length === 3
      && beforeSegments.every((node, index) => node === afterSegments[index]), uuids: afterSegments.map(node => node.getAttribute('data-uuid')) })
    if (results.map(row => row.name).join() !== vectors.submittedRowStability.continuity.transitions.join()) throw Error('Submitted continuity coverage differs from its contract')
    return results
  } finally {
    releaseDecode()
    document.getSelection()?.removeAllRanges()
    unmountReactTranscript(container); container.remove()
    w.klaus.session = originalSession; w.klaus.media = originalMedia; w.Image = OriginalImage; w.__klausProfileAvatar = previousAvatar
    URL.revokeObjectURL(preview)
  }
}
