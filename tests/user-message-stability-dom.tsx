import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'
import { LiveTail, UserMessageRow } from '../frontend/src/chat/transcript/TranscriptView'
import { beginPendingUserTurn, bindPendingUserTurn, ingestChatEvent } from '../frontend/src/chat/stream-store'
import { composerDocumentFromText, snapshotComposerDocument } from '../frontend/src/chat/composer/document-model'
import { userMessageCopyContent } from '../frontend/src/chat/transcript/user-message-disclosure'
import vectors from '../contracts/vectors/user-message-display-vectors.json'

/** Exercise DOM identity rather than identical markup after a destructive rerender. */
export async function userMessageStability(container: HTMLElement, root: Root) {
  const contract = vectors.submittedRowStability
  const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="80"><rect width="60" height="80" fill="coral"/></svg>')
  const owner = window as any
  const previousAvatar = owner.__klausProfileAvatar
  owner.__klausProfileAvatar = { name: 'Fixture owner', url: image }
  const text = 'A submitted message with an image attachment'
  const msg = { role: 'user', uuid: 'pending-user', text, timestamp: Date.now(),
    localRender: { displayText: text, composerDocument: snapshotComposerDocument(composerDocumentFromText(text)),
      attachments: [{ type: 'image', name: 'shot.svg', src: image }] } }
  const props = { msg, composerAuthored: true, archived: false, running: true, canEdit: true,
    sessionId: 'row-stability', turnId: 'row-turn' }
  const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const nodes = () => ({ row: container.querySelector('.msg-group.user'),
    bubble: container.querySelector('.sent-user-stack > .msg.user'),
    body: container.querySelector('[data-user-message-body]'), text: container.querySelector('[data-user-message-body] p'),
    thumbnail: container.querySelector('.kls-attach-thumb img'), avatar: container.querySelector('[data-owner-sender-col] img') })
  const results: Array<{ transition: string; passed: boolean; stable: Record<string, boolean>; removedMediaSubtrees: number; removedBodySubtrees: number; selectionPreserved: boolean; actionsCurrent: boolean; copyCurrent: boolean }> = []
  async function measure(transition: string, update: () => void) {
    const before = nodes()
    const range = document.createRange()
    range.selectNodeContents(before.bubble!.querySelector('[data-user-message-body]')!)
    const selection = document.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    const selectedText = selection.toString()
    let removedMediaSubtrees = 0, removedBodySubtrees = 0
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node instanceof Element && (node.matches('img') || node.querySelector('img'))) removedMediaSubtrees++
        if (node === before.body || node instanceof Element && before.body && node.contains(before.body)) removedBodySubtrees++
      }
    })
    observer.observe(container, { childList: true, subtree: true })
    flushSync(update)
    await frames()
    observer.disconnect()
    const after = nodes()
    const stable = Object.fromEntries(contract.preserveNodes.map(name => {
      const key = name as keyof typeof before
      return [key, !!before[key] && before[key] === after[key]]
    }))
    const selectionPreserved = !!selectedText && selection.toString() === selectedText
    const actionsCurrent = !!after.row?.querySelector('[data-action="edit"]') === after.row?.hasAttribute('data-editable')
    const copyCurrent = !!after.row && userMessageCopyContent(after.row as HTMLElement)?.text === text
    results.push({ transition, passed: Object.values(stable).every(Boolean)
      && removedMediaSubtrees === contract.removedMediaSubtrees && removedBodySubtrees === contract.removedBodySubtrees
      && selectionPreserved === contract.preserveSelection && actionsCurrent && copyCurrent,
      stable, removedMediaSubtrees, removedBodySubtrees, selectionPreserved, actionsCurrent, copyCurrent })
  }
  try {
    const sessionId = `stability-${Date.now()}`
    beginPendingUserTurn(sessionId, { text, ...msg.localRender, uuid: msg.uuid, timestamp: msg.timestamp })
    const unitProps = { isThinkingExpanded: () => false, onToggleThinking: () => {}, archived: false,
      running: true, composerAuthored: true, readOnly: false, editTarget: null, sessionId }
    flushSync(() => root.render(<LiveTail key={sessionId} sessionId={sessionId} unitProps={unitProps} scroll="main" container={container} />))
    await frames()
    await measure('turn-id', () => ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'saved-turn' } as any))
    await measure('message-uuid', () => bindPendingUserTurn(sessionId, msg.uuid, 'saved-user'))
    await measure('stream-delta', () => {
      ingestChatEvent({ type: 'thinking_delta', sessionId, text: 'Considering the request.' } as any)
      ingestChatEvent({ type: 'text_delta', sessionId, text: 'The response is streaming.' } as any)
    })
    flushSync(() => root.render(<UserMessageRow {...props} />))
    await frames()
    await measure('running', () => root.render(<UserMessageRow {...props} running={false} />))
    await measure('archived', () => root.render(<UserMessageRow {...props} archived />))
    await measure('read-only', () => root.render(<UserMessageRow {...props} readOnly />))
    await measure('document-snapshot', () => root.render(<UserMessageRow {...props} msg={structuredClone(msg)} readOnly />))
    if (results.map(row => row.transition).join() !== contract.transitions.join()) throw new Error('Submitted row transition coverage changed')
    return results
  } finally {
    document.getSelection()?.removeAllRanges()
    owner.__klausProfileAvatar = previousAvatar
  }
}
