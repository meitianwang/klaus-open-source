import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { distanceFromBottom, type TranscriptScrollController } from '../transcript-scroll-controller'
import { initialFollowState, latestTurnPhase, preservesViewport, reduceFollowState, savedDistanceFromBottom, type FollowState, type LatestTurnPhase } from './latest-turn-follow'
import { ResponseSpacerController, scrollPaddingBottom } from './response-spacer'
import { registerSavedHistoryViewport } from '../stream-store'
import { registerTranscriptViewport, transcriptViewportState } from './viewport-state'
import { VirtualTurnList, type LatestTurnHeightChange, type VirtualTurnListApi } from './virtual-turn-list'
import type { TurnLayoutEntry, TurnRestoreState } from './virtual-turn-layout'

export { latestTurnPhase }

/** A conversation owns its measured window, reading position and newest-turn follow policy. */
export function VirtualTranscript({ sessionId, container, controller, entries, renderRow, latestKey, placementKey, phase, running, onApiChange }: {
  sessionId: string
  container: HTMLElement
  controller: TranscriptScrollController
  entries: readonly TurnLayoutEntry[]
  renderRow: (key: string) => ReactNode
  latestKey: string | null
  placementKey: string | null
  phase: LatestTurnPhase
  running: boolean
  onApiChange: (api: VirtualTurnListApi | null) => void
}) {
  const entrySignature = entries.map(entry => entry.key).join('\u0000')
  const stableEntries = useMemo(() => entries, [entrySignature])
  const historyReader = useRef<ReturnType<typeof registerSavedHistoryViewport> | null>(null)
  useLayoutEffect(() => {
    const reader = registerSavedHistoryViewport(sessionId)
    historyReader.current = reader
    return () => { reader.dispose(); if (historyReader.current === reader) historyReader.current = null }
  }, [sessionId])
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const historyViewport = useCallback((keys: string[] | null) => {
    const map = new Map(entriesRef.current.map(entry => [entry.key, entry]))
    const rows = keys?.map(key => map.get(key))
    if (!rows?.length || rows.some(row => !row?.turnId || row.historyGap) || container.getClientRects().length === 0) {
      historyReader.current?.setHistoryViewport(null)
      return
    }
    historyReader.current?.setHistoryViewport({ oldestRenderedTurnId: rows[0]!.turnId!, firstProtectedItemId: rows[0]!.firstProtectedItemId ?? null })
  }, [container])
  const [saved] = useState(() => transcriptViewportState(sessionId))
  const [spacer] = useState(() => new ResponseSpacerController(controller))
  const current = useRef({ latestKey, phase, running })
  current.current = { latestKey, phase, running }
  const savedLatest = saved?.latestTurn?.key === latestKey ? saved.latestTurn : null
  const follow = useRef<FollowState>(initialFollowState({ inProgress: running, phase,
    initialDistancePx: saved?.distanceFromBottomPx ?? controller.getLastScrollDistanceFromBottomPx(), saved: savedLatest?.followMode ?? null }))
  const restore = useRef({ distance: saved?.distanceFromBottomPx ?? controller.getLastScrollDistanceFromBottomPx(), done: false })
  const heights = useRef<{ current: number | null; saved: number | null; follow: number | null }>({ current: savedLatest?.heightPx ?? null,
    saved: savedLatest && preservesViewport(savedLatest.followMode) ? savedLatest.heightPx : null, follow: savedLatest?.followContentHeightPx ?? null })
  const readLayout = useRef<(() => TurnRestoreState | null) | null>(null)
  const registerReader = useCallback((read: () => TurnRestoreState | null) => {
    readLayout.current = read
    return () => { if (readLayout.current === read) readLayout.current = null }
  }, [])
  const previous = useRef({ placementKey, phase })
  const pendingInitialPlacement = useRef(controller.hasResponseSpacer() && running && saved == null)
  const registration = useRef<ReturnType<TranscriptScrollController['responseSpacerController']['register']> | null>(null)
  const getPendingRestore = useCallback(() => restore.current.done || follow.current.followMode === 'prework_follow'
    ? null : Math.max(0, restore.current.distance - spacer.getHeightPx()), [spacer])
  const restoreDistance = useCallback((distancePx?: number) => {
    if (restore.current.done || entries.length === 0 || container.getClientRects().length === 0) return
    if (distancePx != null) restore.current.distance = distancePx
    if (follow.current.followMode === 'prework_follow') { restore.current.done = true; return }
    controller.compensateScrollToDistanceFromBottomPx(restore.current.distance)
    if (Math.abs(distanceFromBottom(controller.scrollEl) - restore.current.distance) <= 24) restore.current.done = true
  }, [controller, entries.length])
  const latestHeight = useCallback((change: LatestTurnHeightChange) => {
    const { phase } = current.current
    if (change.followContentHeightPx != null) heights.current.follow = change.followContentHeightPx
    const savedHeight = heights.current.saved
    if (change.heightPx != null) { heights.current.current = change.heightPx; heights.current.saved = null }
    if (savedHeight != null && change.heightPx != null && Math.abs(change.heightPx - savedHeight) > 24) {
      const delta = change.heightPx - savedHeight
      restore.current.distance = Math.max(0, restore.current.distance + delta)
      restore.current.done = false
      controller.compensateScrollToDistanceFromBottomPx(controller.getLastScrollDistanceFromBottomPx() + delta)
    }
    if (follow.current.followMode === 'user_follow' || follow.current.followMode === 'prework_follow' && phase === 'prework') {
      spacer.clear()
      controller.compensateScrollToDistanceFromBottomPx(0)
      return true
    }
    const hadSpacer = spacer.getHeightPx() > 24
    if (savedHeight == null) spacer.consumeGrowth(change.heightDeltaPx ?? 0)
    if (follow.current.followMode !== 'prework_watch' || phase !== 'prework' || !change.turnElement) return
    const overflow = hadSpacer ? change.bottomViewportOverflowPx + scrollPaddingBottom(controller.scrollEl)
      : controller.scrollEl.scrollHeight - controller.scrollEl.clientHeight
    // Without a spacer, only newly overflowing work can start automatic following.
    if (!hadSpacer && overflow > (change.heightDeltaPx ?? 0)) return
    follow.current = reduceFollowState(follow.current, { type: 'latest_turn_follow_content_changed', latestTurnPhase: phase, followContentOverflowPx: overflow })
    if (follow.current.followMode === 'prework_follow') {
      spacer.clear()
      controller.compensateScrollToDistanceFromBottomPx(0)
      return true
    }
  }, [controller, spacer])

  useLayoutEffect(() => {
    spacer.updateContext(controller, matchMedia('(prefers-reduced-motion: reduce)').matches, () => {
      if (!current.current.running) registration.current?.clear()
    })
    const entry = controller.responseSpacerController.register(latestKey == null ? null : {
      getHeightPx: spacer.getHeightPx,
      holdViewport: () => { restore.current.done = true; heights.current.saved = null; spacer.stop(); follow.current = reduceFollowState(follow.current, { type: 'hold_viewport' }) },
      scrollToBottom: () => {
        restore.current.done = true
        heights.current.saved = null
        follow.current = reduceFollowState(follow.current, { type: 'scroll_to_bottom' })
        if (current.current.running || current.current.phase === 'idle' && spacer.getHeightPx() > 24) {
          spacer.clear()
          if (!current.current.running) entry.clear()
          controller.scrollToDistanceFromBottomPx(0, 'instant')
        } else controller.scrollToBottom()
      },
    })
    registration.current = entry
    const height = spacer.onHeightChange(entry.notifyHeightChange)
    const scroll = controller.addScrollListener(spacer.handleScroll)
    const user = controller.addUserScrollListener((distance, before) => {
      if (container.getClientRects().length === 0) return
      restore.current.done = true
      heights.current.saved = null
      if (distance <= 24 && spacer.getHeightPx() <= 24 && before > 24) follow.current = reduceFollowState(follow.current, { type: 'scroll_to_bottom' })
      else follow.current = reduceFollowState(follow.current, { type: 'scroll_distance_changed', distanceFromBottomPx: distance, latestTurnPhase: current.current.phase })
      spacer.handleUserScroll(distance, before)
    })
    const resize = new ResizeObserver(spacer.reconcileViewport)
    resize.observe(controller.scrollEl)
    const intersection = new IntersectionObserver(spacer.collapseIfHidden, { root: controller.scrollEl })
    if (spacer.getElement()) intersection.observe(spacer.getElement()!)
    return () => { user(); scroll(); height(); resize.disconnect(); intersection.disconnect(); entry.dispose(); spacer.stop(); spacer.cancelPendingUserScrollDecay() }
  }, [controller, spacer, latestKey])

  useLayoutEffect(() => registerTranscriptViewport(container, sessionId, () => {
    const layout = readLayout.current?.()
    if (!layout) return null
    return { ...layout, widthPx: controller.scrollEl.clientWidth,
      distanceFromBottomPx: savedDistanceFromBottom({ distanceFromBottomPx: distanceFromBottom(controller.scrollEl), spacerHeightPx: spacer.getHeightPx(), scrollPaddingBottomPx: scrollPaddingBottom(controller.scrollEl) }),
      latestTurn: current.current.latestKey == null ? null : { key: current.current.latestKey, followMode: follow.current.followMode,
        phase: current.current.phase, heightPx: preservesViewport(follow.current.followMode) ? heights.current.current : null, followContentHeightPx: heights.current.follow } }
  }), [container, controller, sessionId, spacer])

  useLayoutEffect(() => {
    const before = previous.current
    previous.current = { placementKey, phase }
    if (latestKey == null) { spacer.clear(); follow.current = reduceFollowState(follow.current, { type: 'latest_turn_removed' }); return }
    if (before.placementKey !== placementKey || pendingInitialPlacement.current) {
      const initial = pendingInitialPlacement.current
      pendingInitialPlacement.current = false
      const pending = controller.consumePendingLatestTurnPlacement(sessionId)
      if ((pending || initial) && controller.hasResponseSpacer()) {
        restore.current.done = true
        heights.current.saved = null
        follow.current = reduceFollowState(follow.current, { type: 'latest_turn_placed' })
        if (pending?.shouldPlaceLatestTurn === false) {
          spacer.clear()
          controller.holdViewport()
          controller.compensateScrollToDistanceFromBottomPx(pending.distanceFromBottomPx + (pending.scrollHeightPx == null ? 0 : controller.scrollEl.scrollHeight - pending.scrollHeightPx))
        } else spacer.place()
      }
    }
    const mode = follow.current.followMode
    follow.current = reduceFollowState(follow.current, { type: 'latest_turn_phase_changed', latestTurnPhase: phase, previousLatestTurnPhase: before.phase })
    if (before.phase === 'prework' && phase === 'final_answer' && mode === 'prework_follow') {
      spacer.clear(); controller.compensateScrollToDistanceFromBottomPx(0)
    }
  }, [placementKey, phase, latestKey, controller, sessionId, spacer])

  return <>
    <VirtualTurnList entries={stableEntries} renderRow={renderRow} controller={controller}
      initialRestoreState={saved ?? null}
      getSpacerHeightPx={spacer.getHeightPx} getPendingRestoreDistancePx={getPendingRestore} restoreDistance={restoreDistance}
      onLatestTurnHeightChange={latestHeight} onApiChange={onApiChange} registerRestoreReader={registerReader} onHistoryViewportChange={historyViewport} />
    <div ref={spacer.setElement} data-response-spacer="" style={{ height: spacer.getHeightPx(), flexShrink: 0, pointerEvents: 'none' }} />
  </>
}
