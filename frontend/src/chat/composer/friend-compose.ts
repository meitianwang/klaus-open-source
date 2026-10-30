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

/** Preparing a local handoff must not reopen the remote task's authorization. */
export async function friendComposeTarget(
  request: FriendMessageComposeRequest,
  currentSessionId: string | null,
  prepareLocalAssist: (input: { sessionId: string; friendId: string }) => Promise<{ sessionId: string }>,
): Promise<string> {
  const sessionId = request.sessionId || currentSessionId || ''
  if (request.action !== 'handoff' || !sessionId || !request.friendId) return sessionId
  const result = await prepareLocalAssist({ sessionId, friendId: request.friendId })
  if (!result || typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('The local conversation could not be prepared')
  return result.sessionId
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
