import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/session-transcript-surface-vectors.json'
import {
  FOLLOW_TOLERANCE_PX, PLACE_LATEST_TURN_MAX_DISTANCE_PX, initialFollowState,
  latestTurnPhase, preservesViewport, reduceFollowState, savedDistanceFromBottom,
  shouldPlaceLatestTurn, type FollowEvent, type FollowMode,
} from './latest-turn-follow'

describe('latest turn viewport policy', () => {
  test('uses the committed placement and following boundaries', () => {
    expect(FOLLOW_TOLERANCE_PX).toBe(vectors.presentation.bottomFollowTolerancePx)
    expect(PLACE_LATEST_TURN_MAX_DISTANCE_PX).toBe(vectors.presentation.newMessagePlacementMaxDistancePx)
    for (const item of vectors.scrollBehavior.placementCases) {
      expect({ name: item.name, place: shouldPlaceLatestTurn(item.distancePx, item.spacerPx) })
        .toEqual({ name: item.name, place: item.expected })
    }
  })

  test('matches the committed transitions without restarting following during placement', () => {
    for (const item of vectors.scrollBehavior.followCases) {
      let state = { followMode: item.initial as FollowMode }
      for (const event of item.events) state = reduceFollowState(state, event as FollowEvent)
      expect({ name: item.name, mode: state.followMode }).toEqual({ name: item.name, mode: item.expected })
    }
  })

  test('saves a reading distance independently of temporary response space', () => {
    for (const item of vectors.scrollBehavior.restoreDistanceCases) {
      expect({ name: item.name, distance: savedDistanceFromBottom({ distanceFromBottomPx: item.distancePx,
        spacerHeightPx: item.spacerPx, scrollPaddingBottomPx: item.paddingPx }) })
        .toEqual({ name: item.name, distance: item.expectedPx })
    }
  })

  test('an opened running turn follows only when the saved viewport is at its end', () => {
    expect(initialFollowState({ inProgress: true, phase: 'prework', initialDistancePx: 24, saved: 'static' }))
      .toEqual({ followMode: 'prework_follow' })
    expect(initialFollowState({ inProgress: true, phase: 'final_answer', initialDistancePx: 0, saved: null }))
      .toEqual({ followMode: 'user_follow' })
    expect(initialFollowState({ inProgress: true, phase: 'prework', initialDistancePx: 25, saved: 'static' }))
      .toEqual({ followMode: 'static' })
    expect(initialFollowState({ inProgress: false, phase: 'idle', initialDistancePx: 0, saved: 'prework_watch' }))
      .toEqual({ followMode: 'prework_watch' })
  })

  test('final text, commentary and tool work determine distinct turn phases', () => {
    expect(latestTurnPhase({ running: false, hasWork: true, texts: [{ phase: 'final_answer' }] })).toBe('idle')
    expect(latestTurnPhase({ running: true, hasWork: false, texts: [] })).toBe('idle')
    expect(latestTurnPhase({ running: true, hasWork: true, texts: [] })).toBe('prework')
    expect(latestTurnPhase({ running: true, hasWork: false, texts: [{ phase: 'commentary' }] })).toBe('prework')
    expect(latestTurnPhase({ running: true, hasWork: true, texts: [{ phase: 'commentary' }, { phase: 'final_answer' }] })).toBe('final_answer')
    expect(latestTurnPhase({ running: true, hasWork: false, texts: [{}] })).toBe('final_answer')
  })

  test('unrelated content and near-bottom scroll events preserve state identity', () => {
    const state = { followMode: 'static' as const }
    expect(reduceFollowState(state, { type: 'latest_turn_follow_content_changed', latestTurnPhase: 'final_answer', followContentOverflowPx: 100 })).toBe(state)
    expect(reduceFollowState(state, { type: 'scroll_distance_changed', latestTurnPhase: 'idle', distanceFromBottomPx: 24 })).toBe(state)
    expect(preservesViewport('static')).toBe(true)
    expect(preservesViewport('prework_watch')).toBe(true)
    expect(preservesViewport('prework_follow')).toBe(false)
    expect(preservesViewport('user_follow')).toBe(false)
  })
})
