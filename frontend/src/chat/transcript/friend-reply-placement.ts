import type { Unit } from './TranscriptView'
import { activityRecord, friendSendResult, friendSendToolName } from './activity-semantic'

type TurnGroup = { turnId: string | undefined; units: Unit[] }
const COMPLETED_REPLY_TYPES = new Set(['completed', 'rejected', 'failed', 'cancelled'])

/**
 * Replies to an assistant's collaboration belong to the process that requested
 * them. Display-only arrivals retain their persisted turn and message identity;
 * only their presentation moves. Human-authored requests have no tool anchor.
 */
export function placeFriendReplies(groups: TurnGroup[], boundaryTurnIds: ReadonlySet<string> = new Set()): TurnGroup[] {
  const requests = new Map<string, { group: TurnGroup; friendId?: string }>()
  const projected = groups.map(group => ({ ...group, units: [...group.units] }))
  const arrivals = new Map<TurnGroup, Unit[]>()
  for (const group of projected) {
    // A loaded history island cannot claim replies across an unread gap.
    if (group.turnId && boundaryTurnIds.has(group.turnId)) requests.clear()
    // A reply that opens real model work owns that work's input. Moving its
    // opener would detach the conversation from the answer it introduced.
    const displayOnly = group.units.every(unit => unit.type === 'user')
    group.units = group.units.flatMap(unit => {
      for (const tool of unit.segment?.tools ?? []) {
        if (friendSendToolName(tool.toolName) !== 'send_message_to_friend') continue
        const args = activityRecord(tool.args)
        const receipt = friendSendResult(tool.output?.text)
        if (args.intent !== 'request' || !receipt.requestId || receipt.declined || receipt.converted
          || (!receipt.accepted && !receipt.delivered) || requests.has(receipt.requestId)) continue
        requests.set(receipt.requestId, { group, friendId: typeof args.friendId === 'string' ? args.friendId : receipt.friendId })
      }
      const local = unit.msg?.localRender
      const request = unit.type === 'user' && local?.externalFriendMessage === true
        && COMPLETED_REPLY_TYPES.has(local.replyType) && typeof local.replyToRequestId === 'string'
        ? requests.get(local.replyToRequestId) : undefined
      if (!request || (request.friendId && local.sender?.friendshipId && request.friendId !== local.sender.friendshipId)
        || (request.group !== group && !displayOnly)) return [unit]
      const reply = { ...unit, friendReplyInProcess: true }
      if (request.group === group) return [reply]
      const pending = arrivals.get(request.group) ?? []
      pending.push(reply)
      arrivals.set(request.group, pending)
      return []
    })
  }
  for (const [group, replies] of arrivals) group.units.push(...replies)
  return projected.filter(group => group.units.length > 0)
}
