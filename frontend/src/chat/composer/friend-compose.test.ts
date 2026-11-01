import { describe, expect, test } from 'bun:test'
import { friendComposeMetadata, friendComposeTarget, friendIntentEditable, friendSendLabel, reconcileFriendComposeContext, hasFriendQuoteInstruction } from './friend-compose'
import { normalizeComposerDraft } from './slash-draft'

const t = (key: string) => ({ chat_friend_send_notice: 'Notify {name}', chat_friend_send_request: 'Send to {name}' })[key] || key

describe('explicit friend composition', () => {
  test('names the selected recipients and distinguishes notice from request', () => {
    expect(friendSendLabel(['Mia', 'Lin'], 'request', t)).toBe('Send to Mia, Lin')
    expect(friendSendLabel(['Mia'], 'notice', t)).toBe('Notify Mia')
  })

  test('only a selected recipient produces transport metadata', () => {
    expect(friendComposeMetadata({ intent: 'notice', replyToMessageId: 'message-1' }, false)).toEqual({})
    expect(friendComposeMetadata({ intent: 'notice', replyToMessageId: 'message-1' }, true)).toEqual({ friendIntent: 'notice', friendReplyToMessageId: 'message-1' })
    expect(friendComposeMetadata({ intent: 'request', supplementToRequestId: 'root', questionId: 'question-1' }, true)).toEqual({ friendIntent: 'request', friendSupplementToRequestId: 'root', friendQuestionId: 'question-1' })
  })

  test('persists notice intent and the original message link in a draft', () => {
    const draft = normalizeComposerDraft({ text: 'hello', friendCompose: { intent: 'notice', replyToMessageId: 'message-1' } })
    expect(draft.friendCompose).toEqual({ intent: 'notice', replyToMessageId: 'message-1' })
    expect(normalizeComposerDraft(draft).friendCompose).toEqual(draft.friendCompose)
    expect(normalizeComposerDraft({ text: 'hello', friendCompose: { intent: 'unknown' } }).friendCompose).toBeUndefined()
  })
  test('changing or removing the recipient discards reply and supplement bindings', () => {
    const reply = { intent: 'notice' as const, recipientId: 'friend-a', replyToMessageId: 'message-1' }
    expect(reconcileFriendComposeContext(reply, ['friend-a'])).toEqual(reply)
    expect(reconcileFriendComposeContext(reply, [])).toEqual({ intent: 'request' })
    expect(reconcileFriendComposeContext(reply, ['friend-b'])).toEqual({ intent: 'request' })
    expect(reconcileFriendComposeContext(reply, ['friend-a', 'friend-b'])).toEqual({ intent: 'request' })
    // A reply may also ask the friend to act; it keeps its link either way.
    expect(reconcileFriendComposeContext({ ...reply, intent: 'request' }, ['friend-a'])).toEqual({ ...reply, intent: 'request' })
    expect(friendComposeMetadata({ ...reply, intent: 'request' }, true)).toEqual({ friendIntent: 'request', friendReplyToMessageId: 'message-1' })
  })
  test('a reply lets the owner choose its purpose; an answer to a question stays a request', () => {
    expect(friendIntentEditable({ intent: 'notice', recipientId: 'friend-a', replyToMessageId: 'message-1' })).toBe(true)
    expect(friendIntentEditable({ intent: 'request', recipientId: 'friend-a', replyToMessageId: 'message-1' })).toBe(true)
    expect(friendIntentEditable({ intent: 'request' })).toBe(true)
    expect(friendIntentEditable({ intent: 'request', recipientId: 'friend-a', supplementToRequestId: 'root-1', questionId: 'q-1' })).toBe(false)
    expect(reconcileFriendComposeContext({ intent: 'notice', recipientId: 'friend-a', supplementToRequestId: 'root-1' }, ['friend-a'])).toEqual({ intent: 'notice' })
  })

  test('answering an open request is bound to its one recipient and stays a message', () => {
    const answer = { intent: 'notice' as const, recipientId: 'friend-a', replyToMessageId: 'req-1', answersRequestId: 'req-1' }
    expect(friendComposeMetadata(answer, true)).toEqual({ friendIntent: 'notice', friendReplyToMessageId: 'req-1', friendAnswersRequestId: 'req-1' })
    expect(friendIntentEditable(answer)).toBe(false)
    expect(reconcileFriendComposeContext(answer, ['friend-a'])).toEqual(answer)
    // A different or an extra recipient drops the binding entirely.
    expect(reconcileFriendComposeContext(answer, ['friend-b'])).toEqual({ intent: 'request' })
    expect(reconcileFriendComposeContext(answer, ['friend-a', 'friend-b'])).toEqual({ intent: 'request' })
    // A request can never complete another request.
    expect(reconcileFriendComposeContext({ ...answer, intent: 'request' }, ['friend-a'])).toEqual({ intent: 'request' })
    // The binding survives a saved draft.
    expect(normalizeComposerDraft({ text: 'done', friendCompose: answer }).friendCompose).toEqual(answer)
  })
  test('a context quote alone is never a new processing instruction', () => {
    expect(hasFriendQuoteInstruction('quoted-context', [{ range: { start: 0, end: 14 } }])).toBe(false)
    expect(hasFriendQuoteInstruction('quoted-context summarize it', [{ range: { start: 0, end: 14 } }])).toBe(true)
  })
  test('a handoff resolves no composer target: the host prepares the local chat', () => {
    // The host call that opens the local conversation also submits the friend
    // message as its first turn, so target resolution keeps every action here.
    expect(friendComposeTarget({ action: 'handoff', sessionId: 'friend-chat', friendId: 'friend-a' }, 'current-chat')).toBe('friend-chat')
    expect(friendComposeTarget({ action: 'handoff', sessionId: '', friendId: 'friend-a' }, 'current-chat')).toBe('current-chat')
    expect(friendComposeMetadata({ intent: 'request', quotedMessageId: 'notice-one' }, false)).toEqual({})
  })
  test('handwritten replies retain their original conversation', () => {
    for (const action of ['reply', 'supplement']) expect(friendComposeTarget({ action, sessionId: 'original', friendId: 'friend-a' }, 'current')).toBe('original')
  })

})
