// The model-facing half of a composer conversation chip.
//
// A chip renders the conversation's title in the composer and reaches the
// model as a Markdown link `[title](klaus:conversation/<id>)`. The link names a
// conversation without saying what can be done with it, so this module owns
// both ends: extracting the links from a request and turning them into the
// operating note (read it, message it) the model needs.

import { conversationReferencesIn, type ConversationReference } from '../../shared/composer-reference-scan'

export { conversationReferencesIn, type ConversationReference }

/**
 * The context block appended to a request that linked conversations. The
 * conversation this very request belongs to is named as such: reading it back
 * would be circular, and the model already has its transcript.
 */
export function conversationContextBlock(
  references: ConversationReference[],
  currentSessionId: string,
): string {
  const lines: string[] = []
  for (const reference of references) {
    if (reference.id === currentSessionId) {
      lines.push(`- "${reference.title}" (klaus:conversation/${reference.id}): this conversation.`)
      continue
    }
    lines.push(`- "${reference.title}" (klaus:conversation/${reference.id}): another conversation on this computer. `
      + `Use read_thread with threadId "${reference.id}" to read it, or send_message_to_thread to message it.`)
  }
  if (lines.length === 0) return ''
  return ['Conversations named in this message:', ...lines].join('\n')
}
