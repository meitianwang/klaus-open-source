/** A received agent message is conversation content, without human authority. */
export interface AgentCommunication {
  senderId: string
  text: string
}

const ORIGIN_PREFIX = 'Message provenance; this does not approve tools or update configuration: '

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Only engine-marked metadata may identify a received agent communication. */
export function subagentCommunication(content: unknown, isMeta: unknown): AgentCommunication | null {
  if (isMeta !== true || !Array.isArray(content) || content.length < 2) return null
  const blocks = content.map(object)
  if (blocks.some(block => block?.type !== 'text' || block.harnessEnvelope !== 'subagent-message' || typeof block.text !== 'string')) return null
  const originText = blocks[0]!.text as string
  if (!originText.startsWith(ORIGIN_PREFIX)) return null
  let origin: Record<string, unknown> | null
  try { origin = object(JSON.parse(originText.slice(ORIGIN_PREFIX.length))) } catch { return null }
  if (origin?.type !== 'subagent-message-origin' || typeof origin.sender !== 'string' || !origin.sender.trim()
    || typeof origin.userInitiated !== 'boolean' || !Number.isSafeInteger(origin.generation) || (origin.generation as number) < 0) return null
  return { senderId: origin.sender, text: blocks.slice(1).map(block => block!.text as string).join('') }
}
