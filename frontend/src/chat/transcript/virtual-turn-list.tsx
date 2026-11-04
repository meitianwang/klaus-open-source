// Virtualized list of transcript turns.
//
// Every turn owns a measured height (an estimate until it has mounted once).
// The list container carries the explicit total height, so mounting or
// unmounting turns never changes the scroll height and the browser never
// clamps the reading position. Which turns are mounted is derived from the
// reader's distance from the bottom; the current window is kept while it still
// covers what the viewport needs.
//
// Height changes are handled where they are observed: a resize observer
// writes the new row heights straight to the row wrappers and, in the same
// frame, moves the scroll position by the growth of rows at or below the
// reading anchor. Growth above the reader therefore never moves the text being
// read; growth below it is absorbed the same way unless the view follows the
// bottom.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import {
  BOTTOM_TOLERANCE_PX, DEFAULT_TURN_ESTIMATE_PX, INITIAL_VIEWPORT_HEIGHT_PX, TURN_OVERSCAN_COUNT,
  buildTurnLayout, captureRestoreState, distanceCenteringTurn, distanceKeepingAnchor, initialWindowState,
  nextWindowState, rangeAnchoredOnKey, sameKeys, turnRangeForDistance, viewportAnchorKey,
  type TurnLayout, type TurnLayoutEntry, type TurnRestoreState, type TurnWindowState,
} from './virtual-turn-layout'
import { type TranscriptScrollController } from '../transcript-scroll-controller'

/** Rows observed in one pass before the list yields a frame to avoid a measurement loop. */
const MAX_SYNC_MEASURE_PASSES = 8
/** Space kept between a "top" scroll target and the viewport edge. */
const TOP_ALIGN_MARGIN_PX = 10

export interface LatestTurnHeightChange {
  heightDeltaPx: number | null
  heightPx: number | null
  bottomViewportOverflowPx: number
  turnElement: HTMLElement | null
  followContentHeightPx?: number | null
}

export interface VirtualTurnListApi {
  getEntryGeometry(key: string): { startPx: number; endPx: number } | null
  scrollToKey(key: string, getTarget?: (row: HTMLElement) => HTMLElement | null, options?: { align?: 'center' | 'top'; signal?: AbortSignal }): Promise<void>
}

interface PendingCompensation {
  latestTurnHeightChange: LatestTurnHeightChange | null
  restoreScrollDistanceFromBottom: boolean
  scrollDistanceFromBottomPx: number | null
  turnHeightsByKey: Record<string, number>
}

interface ScrollRequest {
  key: string
  align: 'center' | 'top'
  getTarget?: (row: HTMLElement) => HTMLElement | null
  complete: () => void
}

type Measured = Map<string, { element: HTMLElement; heightPx: number }>

function borderBoxHeight(entry: ResizeObserverEntry): number {
  const box = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize as unknown as ResizeObserverSize | undefined
  return box ? box.blockSize : entry.contentRect.height
}

function overflowBelowViewport(scrollEl: HTMLElement, element: HTMLElement | null): number {
  return element == null ? 0 : element.getBoundingClientRect().bottom - scrollEl.getBoundingClientRect().bottom
}

export function VirtualTurnList({
  entries, renderRow, controller, initialRestoreState, getSpacerHeightPx, getPendingRestoreDistancePx,
  restoreDistance, onLatestTurnHeightChange, onApiChange, registerRestoreReader, onHistoryViewportChange,
}: {
  entries: readonly TurnLayoutEntry[]
  renderRow: (key: string) => ReactNode
  controller: TranscriptScrollController
  initialRestoreState: TurnRestoreState | null
  /** Height of the response spacer that follows the list (0 when there is none). */
  getSpacerHeightPx: () => number
  /** Distance a pending conversation restore is still trying to reach, if any. */
  getPendingRestoreDistancePx: () => number | null
  /** Retry a pending conversation restore against the current geometry. */
  restoreDistance: (distancePx?: number) => void
  onLatestTurnHeightChange?: (change: LatestTurnHeightChange) => boolean | void
  onApiChange?: (api: VirtualTurnListApi | null) => void
  onHistoryViewportChange?: (keys: string[] | null) => void
  /** Lets the owner read the current restore state when the conversation is left. */
  registerRestoreReader?: (read: () => TurnRestoreState | null) => () => void
}) {
  const scrollEl = controller.scrollEl
  const pixelScale = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const [committedHeights, setCommittedHeights] = useState<Record<string, number>>(() => initialRestoreState?.turnHeightsByKey ?? {})
  const layout = useMemo(() => buildTurnLayout(entries, committedHeights, { pixelScale }), [entries, committedHeights, pixelScale])
  const listRef = useRef<HTMLDivElement | null>(null)
  const heightsRef = useRef(committedHeights)
  // Ignore descendant overflow while a measured wrapper still has its old
  // height. Only the committed content box defines the list's bottom edge.
  const bottomGap = useCallback(() => {
    const list = listRef.current
    const content = scrollEl.firstElementChild
    if (!list || !content) return 0
    const padding = Number.parseFloat(getComputedStyle(scrollEl).paddingBottom) || 0
    return Math.max(0, content.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom + padding)
  }, [scrollEl])
  const layoutDistanceFromBottom = () => {
    const content = scrollEl.firstElementChild
    if (!content || scrollEl.clientHeight === 0) return controller.getLastScrollDistanceFromBottomPx()
    const padding = Number.parseFloat(getComputedStyle(scrollEl).paddingBottom) || 0
    return Math.max(0, content.getBoundingClientRect().bottom - scrollEl.getBoundingClientRect().top
      - scrollEl.clientTop + padding - scrollEl.clientHeight)
  }
  const [windowState, setWindowState] = useState<TurnWindowState>(() => initialWindowState(layout,
    Math.max(0, controller.getLastScrollDistanceFromBottomPx() - getSpacerHeightPx()), initialRestoreState))
  const windowRef = useRef(windowState)
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null)
  const scrollRequestRef = useRef<ScrollRequest | null>(null)
  scrollRequestRef.current = scrollRequest
  const rowElements = useRef(new Map<string, HTMLElement>())
  const rowKeys = useRef(new Map<Element, string>())
  const followElements = useRef(new Map<Element, number>())
  const latestMutationObserver = useRef<MutationObserver | null>(null)
  const latestObservedElement = useRef<HTMLElement | null>(null)
  const newlyObserved = useRef(new Map<string, HTMLElement>())
  const pendingRef = useRef<PendingCompensation | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const passCount = useRef(0)
  const yieldFrame = useRef(0)
  const [frameTick, setFrameTick] = useState(0)
  const builtLayoutRef = useRef<{ heights: Record<string, number>; source: TurnLayout; layout: TurnLayout }>({ heights: committedHeights, source: layout, layout })
  const appliedLayoutRef = useRef(layout)
  const deferredLayoutRef = useRef<TurnLayout | null>(null)
  const viewportHeightRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (committedHeights !== heightsRef.current) setCommittedHeights(heightsRef.current)
  }, [entries, committedHeights])

  // The geometry that includes measurements not yet committed to React state.
  const currentLayout = (): TurnLayout => {
    const built = builtLayoutRef.current
    if (built.source !== layout) {
      const next = committedHeights === heightsRef.current ? layout : buildTurnLayout(entries, heightsRef.current, { pixelScale })
      builtLayoutRef.current = { heights: heightsRef.current, source: layout, layout: next }
      if (listRef.current) listRef.current.style.height = `${next.totalHeightPx}px`
    }
    return builtLayoutRef.current.layout
  }

  const viewportHeight = () => (viewportHeightRef.current ??= scrollEl.clientHeight) || windowRef.current.viewportHeightPx || INITIAL_VIEWPORT_HEIGHT_PX

  // Scroll request: render the turn that is being navigated to.
  let renderedRange = windowState.renderedRange
  if (scrollRequest != null) {
    const distance = distanceCenteringTurn(layout, scrollRequest.key, windowState.viewportHeightPx)
    if (distance != null) renderedRange = turnRangeForDistance(layout, distance, windowState.viewportHeightPx, TURN_OVERSCAN_COUNT)
  } else if (!sameKeys(windowState.turnKeys, layout.turnKeys)) {
    const anchorKey = windowState.turnKeys[windowState.renderedRange.startIndex]
    if (anchorKey != null) renderedRange = rangeAnchoredOnKey(layout, anchorKey, renderedRange) ?? renderedRange
  }

  const updateWindow = (distanceFromBottomPx: number, viewportHeightPx: number) => {
    if (listRef.current?.getClientRects().length === 0) return
    if (pendingRef.current != null || viewportHeightPx <= 0) return
    const current = windowRef.current
    const next = nextWindowState(current, distanceFromBottomPx, currentLayout(), viewportHeightPx)
    if (next === current) return
    windowRef.current = next
    if (next.renderedRange.startIndex !== current.renderedRange.startIndex || next.renderedRange.endIndex !== current.renderedRange.endIndex
      || !sameKeys(next.turnKeys, current.turnKeys)) setWindowState(next)
  }

  const applyCompensation = (pending: PendingCompensation) => {
    const spacerBefore = getSpacerHeightPx()
    const positioned = pending.latestTurnHeightChange != null && onLatestTurnHeightChange?.(pending.latestTurnHeightChange) === true
    if (positioned) return
    if (pending.restoreScrollDistanceFromBottom || getPendingRestoreDistancePx() != null) restoreDistance(pending.scrollDistanceFromBottomPx ?? undefined)
    else if (pending.scrollDistanceFromBottomPx != null) {
      controller.compensateScrollToDistanceFromBottomPx(pending.scrollDistanceFromBottomPx + getSpacerHeightPx() - spacerBefore)
    }
  }

  /** Accept new row heights and keep the reading anchor still. Returns true when geometry changed. */
  const measure = (changes: Measured, sync = true, mode: 'measured' | 'controller' = 'measured'): boolean => {
    const current = currentLayout()
    if (scrollEl.getClientRects().length === 0 || listRef.current?.getClientRects().length === 0) return false
    const pending = pendingRef.current
    const heights = heightsRef.current
    let next = heights
    let latestDelta = 0, latestChanged = false, structural = false, compensation = 0
    let latestElement: HTMLElement | null = null
    const domDistance = mode === 'controller' ? controller.getLastScrollDistanceFromBottomPx() : layoutDistanceFromBottom()
    const gap = bottomGap()
    const spacer = getSpacerHeightPx()
    let anchorBottom = pending == null ? Math.max(0, domDistance - gap) : windowRef.current.distanceFromBottomPx
    if (scrollRequestRef.current == null) {
      const base = sameKeys(appliedLayoutRef.current.turnKeys, current.turnKeys) ? current : appliedLayoutRef.current
      const at = base === current ? pending?.scrollDistanceFromBottomPx ?? domDistance : domDistance
      let anchor = viewportAnchorKey({
        distanceFromBottomPx: Math.max(0, at - gap), preferLatestVisible: at < spacer, layout: base,
        measuredHeightsByKey: heights, nextLayout: current, viewportHeightPx: windowRef.current.viewportHeightPx,
      })
      // A focused control inside a visible turn keeps that turn in place.
      const focused = scrollEl.ownerDocument.activeElement
      const focusedRow = focused?.closest<HTMLElement>('[data-virtual-turn-key]')
      const focusedKey = focusedRow?.dataset.virtualTurnKey
      if (focused && focusedRow && focusedKey && rowElements.current.get(focusedKey) === focusedRow) {
        const box = focused.getBoundingClientRect(), viewport = scrollEl.getBoundingClientRect()
        if (box.bottom > viewport.top && box.top < viewport.bottom) anchor = focusedKey
      }
      const index = anchor == null ? null : current.turnIndexByKey.get(anchor)
      if (index != null) anchorBottom = current.bottomOffsetsPx[index] ?? anchorBottom
    }
    for (const [key, { element, heightPx }] of changes) {
      if (rowElements.current.get(key) !== element) continue
      const height = Math.max(1, heightPx)
      const previous = heights[key]
      if (previous === height) continue
      if (next === heights) next = { ...heights }
      next[key] = height
      const index = current.turnIndexByKey.get(key)
      if (index == null) continue
      const isLatest = index === current.turnKeys.length - 1
      const snapped = Math.round(Math.max(entries[index]?.minHeightPx ?? 0, height) * pixelScale) / pixelScale
      const delta = snapped - (current.heightsPx[index] ?? snapped)
      structural ||= previous == null || delta !== 0
      if (isLatest) { latestChanged = true; latestDelta += previous == null ? 0 : delta; latestElement = element }
      if ((current.bottomOffsetsPx[index] ?? 0) <= anchorBottom) compensation += delta
    }
    if (next === heights) return false
    if (!structural) { heightsRef.current = next; return false }
    const nextLayout = buildTurnLayout(entries, next, { pixelScale })
    const followBottom = controller.shouldFollowContentGrowth() && spacer === 0 && domDistance <= BOTTOM_TOLERANCE_PX
      && (latestElement as HTMLElement | null)?.querySelector('[data-preserve-turn-viewport]') == null
    const restoring = pending?.restoreScrollDistanceFromBottom === true
    let target: number | null = null
    if (!restoring) {
      target = followBottom ? 0 : compensation === 0
        ? pending?.scrollDistanceFromBottomPx ?? domDistance
        : (pending?.scrollDistanceFromBottomPx ?? controller.getUnroundedScrollDistanceFromBottomPx(domDistance)) + compensation
    }
    const windowDistance = target != null ? Math.max(0, target - gap) : windowRef.current.distanceFromBottomPx
    const nextWindow = nextWindowState(windowRef.current, windowDistance, nextLayout, windowRef.current.viewportHeightPx)
    const previousLatest = pending?.latestTurnHeightChange
    const turnElement = latestElement ?? previousLatest?.turnElement ?? null
    const result: PendingCompensation = {
      latestTurnHeightChange: latestChanged || previousLatest != null ? {
        heightDeltaPx: (previousLatest?.heightDeltaPx ?? 0) + latestDelta, heightPx: nextLayout.heightsPx.at(-1) ?? null,
        bottomViewportOverflowPx: overflowBelowViewport(scrollEl, turnElement), turnElement,
      } : null,
      restoreScrollDistanceFromBottom: restoring,
      scrollDistanceFromBottomPx: target,
      turnHeightsByKey: next,
    }
    controller.prepareMeasuredLayout()
    for (const [key, { element }] of changes) {
      const index = nextLayout.turnIndexByKey.get(key)
      if (rowElements.current.get(key) !== element || index == null || !element.parentElement) continue
      element.parentElement.style.height = `${nextLayout.heightsPx[index]}px`
      element.parentElement.style.minHeight = ''
    }
    // Streaming growth of the newest turn alone: update geometry in place.
    if (latestChanged && changes.size === 1 && pending == null && nextWindow === windowRef.current && listRef.current) {
      heightsRef.current = next
      builtLayoutRef.current = { heights: next, source: layout, layout: nextLayout }
      appliedLayoutRef.current = nextLayout
      listRef.current.style.height = `${nextLayout.totalHeightPx}px`
      applyCompensation(result)
      return true
    }
    deferredLayoutRef.current ??= current
    const commit = () => {
      heightsRef.current = next
      builtLayoutRef.current = { heights: next, source: layout, layout: nextLayout }
      setCommittedHeights(next)
      if (nextWindow !== windowRef.current) { windowRef.current = nextWindow; setWindowState(nextWindow) }
    }
    pendingRef.current = result
    if (sync) flushSync(commit)
    else commit()
    return true
  }
  const measureRef = useRef(measure)
  measureRef.current = measure

  const observer = (): ResizeObserver => {
    if (observerRef.current) return observerRef.current
    observerRef.current = new ResizeObserver(records => {
      const changes: Measured = new Map()
      let followChanged = false
      for (const record of records) {
        const key = rowKeys.current.get(record.target)
        if (key != null) changes.set(key, { element: record.target as HTMLElement, heightPx: borderBoxHeight(record) })
        else if (followElements.current.has(record.target)) {
          const height = borderBoxHeight(record)
          if (followElements.current.get(record.target) !== height) { followElements.current.set(record.target, height); followChanged = true }
        }
      }
      measureRef.current(changes)
      if (followChanged) runtime.current.notifyFollowContent()
    })
    return observerRef.current
  }

  const observeRow = useCallback((key: string, element: HTMLElement | null) => {
    if (element == null) return
    rowKeys.current.set(element, key)
    rowElements.current.set(key, element)
    newlyObserved.current.set(key, element)
    const resize = observer()
    resize.observe(element)
    return () => {
      resize.unobserve(element)
      rowKeys.current.delete(element)
      if (newlyObserved.current.get(key) === element) newlyObserved.current.delete(key)
      if (rowElements.current.get(key) === element) rowElements.current.delete(key)
    }
  }, [])

  const notifyFollowContent = () => {
    let height = 0, latest: HTMLElement | null = null
    for (const [element, size] of followElements.current) {
      height += size
      if (!latest || latest.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) latest = element as HTMLElement
    }
    if (latest) onLatestTurnHeightChange?.({ heightDeltaPx: null, heightPx: null,
      bottomViewportOverflowPx: overflowBelowViewport(scrollEl, latest), turnElement: latest, followContentHeightPx: height })
  }
  const observeFollowContent = () => {
    const latest = rowElements.current.get(entries.at(-1)?.key ?? '') ?? null
    const next = new Set(latest?.querySelectorAll('[data-latest-turn-follow-content]') ?? [])
    const resize = observer()
    for (const element of followElements.current.keys()) if (!next.has(element)) { resize.unobserve(element); followElements.current.delete(element) }
    for (const element of next) if (!followElements.current.has(element)) { followElements.current.set(element, 0); resize.observe(element) }
    if (latestObservedElement.current !== latest) {
      latestMutationObserver.current?.disconnect()
      latestObservedElement.current = latest
      if (latest) {
        const mutations = new MutationObserver(() => runtime.current.observeFollowContent())
        mutations.observe(latest, { childList: true, subtree: true })
        latestMutationObserver.current = mutations
      }
    }
  }
  useLayoutEffect(() => { observeFollowContent() })

  // Rows mounted by this commit are measured before paint.
  useLayoutEffect(() => {
    const observed = newlyObserved.current
    if (observed.size === 0) { passCount.current = 0; return }
    if (yieldFrame.current) return
    if (passCount.current >= MAX_SYNC_MEASURE_PASSES) {
      yieldFrame.current = requestAnimationFrame(time => { yieldFrame.current = 0; passCount.current = 0; setFrameTick(time) })
      return
    }
    passCount.current += 1
    newlyObserved.current = new Map()
    const changes: Measured = new Map()
    for (const [key, element] of observed) {
      if (rowElements.current.get(key) !== element) continue
      const height = element.getBoundingClientRect().height
      if (height > 0) changes.set(key, { element, heightPx: height })
    }
    if (changes.size > 0) {
      if (measure(changes, false, 'controller')) {
        for (const [key, element] of observed) if (rowElements.current.get(key) === element) newlyObserved.current.set(key, element)
      } else passCount.current = 0
    }
  })

  // Apply the compensation computed by a measurement once React has committed it.
  useLayoutEffect(() => {
    const pending = pendingRef.current
    if (pending != null && pending.turnHeightsByKey === committedHeights) {
      pendingRef.current = null
      applyCompensation(pending)
    }
  }, [committedHeights])

  // Turns added or removed: keep the reading anchor where it was.
  useLayoutEffect(() => {
    if (pendingRef.current != null) return
    const previous = appliedLayoutRef.current
    const now = currentLayout()
    const base = deferredLayoutRef.current ?? now
    deferredLayoutRef.current = null
    appliedLayoutRef.current = now
    if (scrollRequest != null || previous === base) return
    const last = controller.getLastScrollDistanceFromBottomPx()
    const gap = bottomGap()
    const listDistance = Math.max(0, last - gap)
    if (getPendingRestoreDistancePx() != null) return
    if (controller.shouldFollowContentGrowth() && getSpacerHeightPx() === 0 && last <= BOTTOM_TOLERANCE_PX) {
      controller.compensateScrollToDistanceFromBottomPx(0)
      return
    }
    const anchor = viewportAnchorKey({ distanceFromBottomPx: listDistance, preferLatestVisible: last < getSpacerHeightPx(), layout: previous,
      measuredHeightsByKey: heightsRef.current, nextLayout: base, viewportHeightPx: windowRef.current.viewportHeightPx })
    if (anchor == null) return
    const nextDistance = distanceKeepingAnchor(anchor, listDistance, previous, base)
    if (nextDistance == null || nextDistance === listDistance && previous.totalHeightPx === base.totalHeightPx) return
    updateWindow(nextDistance, windowRef.current.viewportHeightPx)
    controller.compensateScrollToDistanceFromBottomPx(controller.getUnroundedScrollDistanceFromBottomPx(last) + nextDistance - listDistance)
  }, [layout, scrollRequest])

  // Geometry or navigation changed: refresh the window and retry a pending restore.
  useLayoutEffect(() => {
    if (scrollRequest != null || pendingRef.current != null) return
    updateWindow(windowRef.current.distanceFromBottomPx, windowRef.current.viewportHeightPx)
    if (pendingRef.current == null) restoreDistance()
  }, [layout, scrollRequest])

  const reportHistoryViewport = (distance: number) => {
    if (!onHistoryViewportChange) return
    if (distance > BOTTOM_TOLERANCE_PX || scrollRequestRef.current != null || pendingRef.current != null
      || listRef.current?.getClientRects().length === 0) { onHistoryViewportChange(null); return }
    const geometry = currentLayout()
    const visible = turnRangeForDistance(geometry, Math.max(0, distance - bottomGap()), viewportHeight(), 0)
    onHistoryViewportChange(geometry.turnKeys.slice(visible.startIndex, visible.endIndex))
  }
  useLayoutEffect(() => { reportHistoryViewport(controller.getLastScrollDistanceFromBottomPx()) })
  useLayoutEffect(() => () => onHistoryViewportChange?.(null), [onHistoryViewportChange])

  const runtime = useRef({ currentLayout, updateWindow, restoreDistance, notifyFollowContent, observeFollowContent, reportHistoryViewport })
  runtime.current = { currentLayout, updateWindow, restoreDistance, notifyFollowContent, observeFollowContent, reportHistoryViewport }

  // Reader scrolling and viewport resizes.
  useLayoutEffect(() => {
    const viewport = new ResizeObserver(records => {
      const record = records.find(item => item.target === scrollEl)
      if (record) {
        const height = borderBoxHeight(record)
        viewportHeightRef.current = height
        runtime.current.updateWindow(windowRef.current.distanceFromBottomPx, height)
        if (pendingRef.current == null) runtime.current.restoreDistance()
      }
    })
    viewport.observe(scrollEl)
    const unsubscribe = controller.addScrollListener(distance => {
      runtime.current.updateWindow(Math.max(0, distance - bottomGap()), viewportHeight())
      runtime.current.reportHistoryViewport(distance)
    })
    return () => { unsubscribe(); viewport.disconnect() }
  }, [controller, scrollEl])

  // Navigation to a turn that may not be mounted yet.
  useLayoutEffect(() => {
    const request = scrollRequest
    if (request == null || yieldFrame.current) return
    const changes: Measured = new Map()
    for (const [key, element] of rowElements.current) {
      const height = element.getBoundingClientRect().height
      if (height > 0) changes.set(key, { element, heightPx: height })
    }
    if (measure(changes, false) || pendingRef.current != null) return
    const row = rowElements.current.get(request.key)
    const target = row ? request.getTarget?.(row) ?? row : null
    const geometry = currentLayout()
    const index = geometry.turnIndexByKey.get(request.key)
    const viewport = scrollEl.clientHeight
    let distance: number | null = null
    if (index != null) {
      const rowTop = (geometry.bottomOffsetsPx[index] ?? 0) + (geometry.heightsPx[index] ?? 0)
      if (row && target) {
        const offset = target.getBoundingClientRect().top - row.getBoundingClientRect().top
        const top = rowTop - offset
        distance = request.align === 'top'
          ? Math.max(0, top - viewport + TOP_ALIGN_MARGIN_PX)
          : Math.max(0, top - target.getBoundingClientRect().height / 2 - viewport / 2)
      } else {
        distance = request.align === 'top' ? Math.max(0, rowTop - viewport + TOP_ALIGN_MARGIN_PX)
          : distanceCenteringTurn(geometry, request.key, viewport)
      }
    }
    if (distance == null) { queueMicrotask(() => request.complete()); return }
    const absolute = distance + bottomGap()
    controller.holdViewport()
    controller.compensateScrollToDistanceFromBottomPx(absolute)
    updateWindow(distance, viewport)
    queueMicrotask(() => request.complete())
  }, [scrollRequest, layout, frameTick])

  useEffect(() => {
    if (!onApiChange) return
    onApiChange({
      getEntryGeometry: key => {
        const geometry = runtime.current.currentLayout(), index = geometry.turnIndexByKey.get(key)
        return index == null ? null : { startPx: geometry.topOffsetsPx[index], endPx: geometry.topOffsetsPx[index] + geometry.heightsPx[index] }
      },
      scrollToKey: (key, getTarget, options = {}) => options.signal?.aborted ? Promise.resolve() : new Promise<void>(resolve => {
        const request: ScrollRequest = {
          key, align: options.align ?? 'center', getTarget,
          complete: () => { setScrollRequest(current => current === request ? null : current); resolve() },
        }
        options.signal?.addEventListener('abort', () => request.complete(), { once: true })
        setScrollRequest(request)
      }),
    })
    return () => onApiChange(null)
  }, [onApiChange])

  useEffect(() => registerRestoreReader?.(() => captureRestoreState(heightsRef.current, windowRef.current.turnKeys, windowRef.current.renderedRange)), [registerRestoreReader])

  useEffect(() => () => {
    if (yieldFrame.current) cancelAnimationFrame(yieldFrame.current)
    observerRef.current?.disconnect()
    latestMutationObserver.current?.disconnect()
    followElements.current.clear()
    observerRef.current = null
    pendingRef.current = null
  }, [])

  const latestIndex = entries.length - 1
  const rows: ReactNode[] = []
  for (let index = renderedRange.startIndex; index < renderedRange.endIndex; index++) {
    const entry = entries[index]
    if (!entry) continue
    const measured = committedHeights[entry.key] != null
    rows.push(<VirtualTurnRow key={entry.key} rowKey={entry.key} observe={observeRow}
      gapBeforePx={index === renderedRange.startIndex ? 0 : layout.gapsBeforePx[index] ?? 0}
      measuredHeightPx={measured ? layout.heightsPx[index] : undefined}
      constrainedHeightPx={!measured && index !== latestIndex && scrollRequest?.key !== entry.key ? layout.heightsPx[index] : undefined}
      minHeightPx={measured ? undefined : entry.minHeightPx}>
      {renderRow(entry.key)}
    </VirtualTurnRow>)
  }
  return <div ref={element => { listRef.current = element }} data-virtual-turn-list="" style={{ position: 'relative', display: 'flow-root', flexShrink: 0, height: layout.totalHeightPx }}>
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: layout.topOffsetsPx[renderedRange.startIndex] ?? 0 }}>{rows}</div>
  </div>
}

const VirtualTurnRow = memo(function VirtualTurnRow({ rowKey, observe, gapBeforePx, measuredHeightPx, constrainedHeightPx, minHeightPx, children }: {
  rowKey: string
  observe: (key: string, element: HTMLElement | null) => (() => void) | undefined
  gapBeforePx: number
  measuredHeightPx?: number
  constrainedHeightPx?: number
  minHeightPx?: number
  children: ReactNode
}) {
  const ref = useCallback((element: HTMLDivElement | null) => observe(rowKey, element), [observe, rowKey])
  return <div style={{ height: measuredHeightPx ?? constrainedHeightPx, marginTop: gapBeforePx, minHeight: minHeightPx,
    overflow: constrainedHeightPx != null ? 'hidden' : undefined }}>
    <div ref={ref} data-virtual-turn-key={rowKey}>{children}</div>
  </div>
})

export { DEFAULT_TURN_ESTIMATE_PX }
