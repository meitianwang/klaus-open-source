import type { FriendMessageIntent } from '../../../../shared/friends'

export interface FriendComposeContext {
  intent: FriendMessageIntent
  recipientId?: string
  quotedMessageId?: string
  replyToMessageId?: string
  supplementToRequestId?: string
  questionId?: string
  /** An open request in this conversation that this message answers and completes. */
  answersRequestId?: string
}

export interface FriendMessageComposeRequest {
  action: string
  sessionId?: string
  friendId?: string
}

/**
 * The conversation a compose action starts from: reply-style actions stay in the
 * conversation they were asked in. A handoff resolves its local conversation
 * through the host call that also submits the friend message as its first turn,
 * so it never passes through here.
 */
export function friendComposeTarget(request: FriendMessageComposeRequest, currentSessionId: string | null): string {
  return request.sessionId || currentSessionId || ''
}

export function friendSendLabel(names: string[], intent: FriendMessageIntent, t: (key: string) => string): string {
  return t(intent === 'notice' ? 'chat_friend_send_notice' : 'chat_friend_send_request').replace('{name}', names.join(', '))
}

export function friendComposeMetadata(context: FriendComposeContext, hasRecipient: boolean) {
  return hasRecipient ? {
    friendIntent: context.intent,
    ...(context.replyToMessageId ? { friendReplyToMessageId: context.replyToMessageId } : {}),
    ...(context.questionId ? { friendQuestionId: context.questionId } : {}),
    ...(context.supplementToRequestId ? { friendSupplementToRequestId: context.supplementToRequestId } : {}),
    ...(context.answersRequestId ? { friendAnswersRequestId: context.answersRequestId } : {}),
  } : {}
}

/**
 * A reply link belongs to one explicit recipient, never to a later mention. A
 * reply may be a notice or a request: either one answers the message it links
 * to and lands in the conversation that message came from. An answer to a
 * friend's question is fixed to a request, because it supplements that request;
 * the result of a friend's open request is fixed to a message, because it
 * completes that request.
 */
export function reconcileFriendComposeContext(context: FriendComposeContext, recipientIds: readonly string[]): FriendComposeContext {
  if (context.recipientId && (recipientIds.length !== 1 || recipientIds[0] !== context.recipientId)) return { intent: 'request' }
  if (context.supplementToRequestId && context.intent !== 'request') return { intent: context.intent }
  if (context.answersRequestId && (context.intent !== 'notice' || !context.recipientId)) return { intent: context.intent }
  return context
}

/** Whether the owner may still choose between a notice and a request. */
export function friendIntentEditable(context: FriendComposeContext): boolean {
  return !context.supplementToRequestId && !context.answersRequestId
}

/** Quote atoms are context, so submitting one requires separately authored text. */
export function hasFriendQuoteInstruction(text: string, quotes: readonly { range?: { start: number; end: number } }[]): boolean {
  let prose = text
  for (const quote of [...quotes].sort((left, right) => (right.range?.start || 0) - (left.range?.start || 0))) {
    if (quote.range) prose = prose.slice(0, quote.range.start) + prose.slice(quote.range.end)
  }
  return prose.trim().length > 0
}
