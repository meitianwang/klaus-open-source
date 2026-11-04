import { savedRowId, savedTurns, type SavedTranscript, type SavedTurn } from './saved-transcript'
import { isTaskMutationTool } from './task-state'

export interface SavedHistoryViewport {
  oldestRenderedTurnId: string
  firstProtectedItemId: string | null
}
export const SAVED_HISTORY_HIGH_WATER_ITEMS = 1000
export const SAVED_HISTORY_RETAINED_ITEMS = 500

const protectedTools = new Set(['askuserquestion', 'ask_user', 'ask_user_async', 'ask_user_question',
  'enterplanmode', 'exitplanmode', 'enter_plan_mode', 'exit_plan_mode', 'request_user_input'])

/** A pageable message is atomic: any control record protects its entire row. */
export function canEvictSavedItem(turn: SavedTurn, item: any): boolean {
  if (!savedRowId(item) || item.kind || item.error || item.status === 'inProgress' || item.status === 'running' || item.completed === false) return false
  if (item.steered === true || item.localRender?.externalFriendMessage || item.localRender?.friendOutgoingMessage) return false
  if (item.role !== 'user' && item.role !== 'assistant') return false
  if (typeof item.text === 'string' && /<fork-boilerplate>|<teammate-message|<task-notification|<klaus-delegation>/i.test(item.text)) return false
  // Saved rows in a running turn are not all sealed. Explicit completion is
  // required before releasing a row that the active turn can still rewrite.
  if ((turn.shell.status === 'running' || turn.shell.status === 'inProgress') && item.completed !== true) return false
  if (Array.isArray(item.contentBlocks)) {
    for (const block of item.contentBlocks) {
      if (!block || typeof block !== 'object') return false
      if (block.type === 'tool_use') {
        const name = String(block.name ?? '')
        if (isTaskMutationTool(name) || protectedTools.has(name.toLowerCase()) || block.__result == null) return false
      } else if (!['text', 'thinking', 'redacted_thinking', 'image', 'tool_result'].includes(block.type)) return false
    }
  }
  return true
}

/**
 * Release only a safe oldest prefix while every mounted reader is at the end.
 * Turn shells and topology remain intact, so item anchors can reload each gap.
 */
export function retainSavedHistoryItems(history: SavedTranscript, viewports: readonly (SavedHistoryViewport | null)[]): SavedTranscript {
  if (history.islands.length !== 1 || viewports.length === 0 || viewports.some(viewport => viewport == null)) return history
  const turns = savedTurns(history)
  if (turns.some(turn => turn.itemsPagination.isLoadingOlder || turn.itemsPagination.summaryItemIds || turn.itemsPagination.reconnect)) return history
  let count = turns.reduce((sum, turn) => sum + turn.items.length, 0)
  if (count <= SAVED_HISTORY_HIGH_WATER_ITEMS) return history
  const boundaries = viewports as readonly SavedHistoryViewport[]
  if (!boundaries.every(viewport => turns.some(turn => !turn.auxiliary && turn.id === viewport.oldestRenderedTurnId))) return history
  let entities = history.entitiesByKey
  for (const turn of turns) {
    if (turn.auxiliary) {
      if (turn.items.length === 0 && turn.shell.status === 'completed') continue
      break
    }
    const readers = boundaries.filter(viewport => viewport.oldestRenderedTurnId === turn.id)
    const protectedIndex = Math.min(turn.items.length, ...readers.map(viewport => viewport.firstProtectedItemId == null
      ? 0 : turn.items.findIndex(item => savedRowId(item) === viewport.firstProtectedItemId)))
    if (protectedIndex < 0) break
    let removed = 0
    while (removed < protectedIndex && count > SAVED_HISTORY_RETAINED_ITEMS && canEvictSavedItem(turn, turn.items[removed])) { removed++; count-- }
    // Keep one neighboring row in front of a protected control record.
    if (removed > 0 && turn.items[removed] != null && !canEvictSavedItem(turn, turn.items[removed])) { removed--; count++ }
    if (removed > 0) {
      if (entities === history.entitiesByKey) entities = { ...entities }
      const items = turn.items.slice(removed)
      entities[`turn:${turn.id}`] = { ...turn, items, itemsPagination: {
        olderCursor: null, olderItemId: savedRowId(items[0]) || undefined, evicted: true,
        isLoadingOlder: false, hasLoadedOldest: false,
      } }
    }
    if (removed < turn.items.length || readers.length > 0) break
  }
  return entities === history.entitiesByKey ? history : { ...history, entitiesByKey: entities }
}
