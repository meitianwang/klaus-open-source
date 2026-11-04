// Follow policy for the newest turn of a conversation.
//
// - static: the view stays where the reader left it.
// - user_follow: the reader asked to see the latest output (sent a message
//   while near the bottom, pressed "scroll to latest", or scrolled back down);
//   growth of the newest turn keeps the bottom in view.
// - prework_watch: the turn is still working (commentary, tools, reasoning)
//   and the reader has not asked to follow; the view starts following once
//   that work overflows below the viewport.
// - prework_follow: following the working turn; it ends when the final answer
//   starts, or when the reader scrolls away.

export type FollowMode = 'static' | 'user_follow' | 'prework_watch' | 'prework_follow'
export type LatestTurnPhase = 'idle' | 'prework' | 'final_answer'

export interface FollowState { followMode: FollowMode }

export type FollowEvent =
  | { type: 'latest_turn_follow_content_changed'; followContentOverflowPx: number; latestTurnPhase: LatestTurnPhase }
  | { type: 'latest_turn_phase_changed'; latestTurnPhase: LatestTurnPhase; previousLatestTurnPhase: LatestTurnPhase }
  | { type: 'hold_viewport' }
  | { type: 'latest_turn_placed' }
  | { type: 'latest_turn_removed' }
  | { type: 'scroll_distance_changed'; distanceFromBottomPx: number; latestTurnPhase: LatestTurnPhase }
  | { type: 'scroll_to_bottom' }

/** Within this distance the reader still counts as being at the bottom. */
export const FOLLOW_TOLERANCE_PX = 24
/** Sending within this distance of the latest content places the new turn; farther away keeps the reading position. */
export { PLACE_LATEST_TURN_MAX_DISTANCE_PX } from '../transcript-scroll-controller'
import { PLACE_LATEST_TURN_MAX_DISTANCE_PX } from '../transcript-scroll-controller'

function withMode(state: FollowState, followMode: FollowMode): FollowState {
  return state.followMode === followMode ? state : { ...state, followMode }
}

export function initialFollowState({ inProgress, phase, initialDistancePx, saved }: {
  inProgress: boolean
  phase: LatestTurnPhase
  initialDistancePx: number | null
  saved: FollowMode | null
}): FollowState {
  if (inProgress && (initialDistancePx ?? 0) <= FOLLOW_TOLERANCE_PX) return { followMode: phase === 'prework' ? 'prework_follow' : 'user_follow' }
  return { followMode: saved ?? 'static' }
}

export function reduceFollowState(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case 'latest_turn_follow_content_changed':
      if (event.latestTurnPhase !== 'prework' || state.followMode !== 'prework_watch') return state
      return event.followContentOverflowPx > 0 ? withMode(state, 'prework_follow') : state
    case 'latest_turn_phase_changed': {
      if (state.followMode === 'user_follow') return state
      let next = state
      if (event.previousLatestTurnPhase !== 'prework' && event.latestTurnPhase === 'prework' && next.followMode === 'static') next = withMode(next, 'prework_watch')
      if (event.previousLatestTurnPhase === 'prework' && event.latestTurnPhase === 'final_answer') next = withMode(next, next.followMode === 'prework_follow' ? 'user_follow' : 'static')
      if (event.previousLatestTurnPhase !== 'idle' && event.latestTurnPhase === 'idle') next = withMode(next, 'static')
      return next
    }
    case 'hold_viewport':
    case 'latest_turn_placed':
    case 'latest_turn_removed':
      return withMode(state, 'static')
    case 'scroll_distance_changed':
      if (event.distanceFromBottomPx <= FOLLOW_TOLERANCE_PX) return state
      if (state.followMode === 'prework_follow') return withMode(state, 'prework_watch')
      if (state.followMode === 'user_follow') return withMode(state, event.latestTurnPhase === 'prework' ? 'prework_watch' : 'static')
      return state
    case 'scroll_to_bottom':
      return withMode(state, 'user_follow')
  }
}

/** Modes in which the reader's viewport is preserved rather than followed. */
export function preservesViewport(mode: FollowMode): boolean {
  return mode === 'static' || mode === 'prework_watch'
}

/**
 * The newest turn's phase: idle when it is not running, final_answer once an
 * assistant message that is not commentary has started, prework while it only
 * has commentary, reasoning or tool work.
 */
export function latestTurnPhase({ running, hasWork, texts }: {
  running: boolean
  hasWork: boolean
  texts: readonly { phase?: 'commentary' | 'final_answer' }[]
}): LatestTurnPhase {
  if (!running) return 'idle'
  let commentary = false
  for (const text of texts) {
    if (text.phase === 'commentary') commentary = true
    else return 'final_answer'
  }
  return commentary || hasWork ? 'prework' : 'idle'
}

/** The distance saved for a later visit: a visible response spacer means "at the latest turn". */
export function savedDistanceFromBottom({ distanceFromBottomPx, spacerHeightPx, scrollPaddingBottomPx }: {
  distanceFromBottomPx: number
  spacerHeightPx: number
  scrollPaddingBottomPx: number
}): number {
  const visibleSpacer = Math.max(0, spacerHeightPx - distanceFromBottomPx - scrollPaddingBottomPx)
  return visibleSpacer > FOLLOW_TOLERANCE_PX ? 0 : Math.max(0, distanceFromBottomPx - spacerHeightPx)
}

/** Whether a message sent now should be placed near the top of the viewport. */
export function shouldPlaceLatestTurn(distanceFromBottomPx: number, spacerHeightPx: number): boolean {
  return distanceFromBottomPx - spacerHeightPx <= PLACE_LATEST_TURN_MAX_DISTANCE_PX
}
