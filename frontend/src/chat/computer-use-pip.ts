import type { ComputerUsePipHostLayout, ComputerUsePipRect, ComputerUsePipState, ComputerUsePipVisibilityRequest } from '../../bridge/types'
import { acceptPipState, computePipAnchors, scaledPipRect } from './computer-use-pip-model'
import { pipThreadSurfaceVisible, pipWorkPanelGeometry } from './computer-use-pip-geometry'

interface PipApi {
  computerUsePip?: {
    getState(): Promise<ComputerUsePipState>
    setVisibility(request: ComputerUsePipVisibilityRequest): Promise<ComputerUsePipState>
    setHostLayout(layout: ComputerUsePipHostLayout): Promise<unknown>
  }
  on?: { computerUsePipState?(callback: (state: ComputerUsePipState) => void): () => void }
}

const api = () => (window as unknown as { klaus?: PipApi }).klaus
const HOST = '[data-pip-anchor-host="klaus-main-thread"]'
const HOME = '[data-pip-home-surface]'
const OBSTACLE = '[data-pip-obstacle]'
const WORK_PANEL = '[data-pip-work-panel]'
const PANEL_HEADER = '[data-pip-panel-header]'
const SUMMARY_SECTION = '[data-pip-summary-section]'
const MARKERS = `${HOST},${HOME},${OBSTACLE},${WORK_PANEL},${PANEL_HEADER},${SUMMARY_SECTION}`
const listeners = new Set<() => void>()
let state: ComputerUsePipState = {
  revision: -1, supported: false, activeTaskIds: [], taskVisibilities: {},
  alwaysHidePictureInPicture: false, maxDisplaySize: 200,
}
let localError = ''
let requestLayout: (() => void) | undefined
let stopBridge: (() => void) | undefined

export function computerUsePipState(): ComputerUsePipState { return state }
export function computerUsePipError(): string {
  const taskError = !state.errorSessionId || state.errorSessionId === currentPipSession() ? state.error : ''
  return localError || taskError || ''
}
export function currentPipSession(): string | null {
  return (window as unknown as { currentSessionId?: string | null }).currentSessionId || null
}
export function browserPanelHidesPip(): boolean {
  const panel = document.getElementById('artifacts-panel')
  return panel?.getAttribute('data-mode') === 'browser' && !panel.classList.contains('collapsed')
}
export function subscribeComputerUsePip(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function notify(): void { for (const listener of listeners) listener() }
function receive(next: ComputerUsePipState): void {
  const accepted = acceptPipState(state, next)
  if (accepted === state) return
  state = accepted
  localError = ''
  notify()
  requestLayout?.()
}
export async function setComputerUsePipVisibility(request: ComputerUsePipVisibilityRequest): Promise<void> {
  const bridge = api()?.computerUsePip
  if (!bridge) return
  try {
    receive(await bridge.setVisibility(request))
  } catch (error) {
    localError = error instanceof Error ? error.message : String(error)
    notify()
  }
}

function visibleRect(element: Element | null, zoom: number): ComputerUsePipRect | null {
  if (!(element instanceof HTMLElement) || element.hidden || element.closest('[hidden]')) return null
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return null
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return scaledPipRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, zoom)
}

/** Only layout crosses this bridge. Native code owns every preview pixel and control. */
export function initComputerUsePip(): void {
  if (stopBridge || !api()?.computerUsePip || !document.body) return
  let frame: number | null = null
  let stopped = false
  let lastLayout: ComputerUsePipHostLayout | null = null
  let lastKey = ''
  let pendingLayout: ComputerUsePipHostLayout | null = null
  let sending = false
  const resizeObserver = new ResizeObserver(schedule)
  const attributesObserver = new MutationObserver(() => { notify(); schedule() })
  const structureObserver = new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node =>
      node instanceof HTMLElement && (node.matches(MARKERS) || node.querySelector(MARKERS))))) {
      observeElements()
      schedule()
    }
  })

  async function flush(): Promise<void> {
    if (sending) return
    sending = true
    while (pendingLayout) {
      const layout = pendingLayout
      pendingLayout = null
      try {
        await api()?.computerUsePip?.setHostLayout(layout)
      } catch (error) {
        localError = error instanceof Error ? error.message : String(error)
        notify()
        // An identical later measurement can retry a failed host update.
        lastKey = ''
      }
    }
    sending = false
  }

  function publish(layout: ComputerUsePipHostLayout): void {
    const key = JSON.stringify({ ...layout, animated: false })
    if (key === lastKey) return
    layout.animated = lastLayout?.anchorRect != null && layout.anchorRect != null
    lastLayout = layout
    lastKey = key
    pendingLayout = layout
    void flush()
  }

  function measure(): void {
    const sessionId = currentPipSession()
    const zoom = state.zoomFactor ?? 1
    const hostRect = !stopped && pipThreadSurfaceVisible() ? visibleRect(document.querySelector(HOST), zoom) : null
    const obstacles = [...document.querySelectorAll(OBSTACLE)].flatMap(element => {
      const rect = visibleRect(element, zoom)
      return rect ? [rect] : []
    })
    const panelGeometry = [...document.querySelectorAll(WORK_PANEL)].map(panel => {
      const viewport = panel.querySelector(HOME)
      const style = viewport ? getComputedStyle(viewport) : null
      const paddingScale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
      return pipWorkPanelGeometry({
        panel: visibleRect(panel, zoom), mode: panel.getAttribute('data-mode'), collapsed: panel.classList.contains('collapsed'),
        header: visibleRect(panel.querySelector(PANEL_HEADER), zoom), viewport: visibleRect(viewport, zoom),
        sections: [...panel.querySelectorAll(SUMMARY_SECTION)].flatMap(section => {
          const rect = visibleRect(section, zoom)
          return rect ? [rect] : []
        }),
        paddingTop: (Number.parseFloat(style?.paddingTop || '0') || 0) / paddingScale,
        paddingBottom: (Number.parseFloat(style?.paddingBottom || '0') || 0) / paddingScale,
      })
    })
    for (const { obstacle } of panelGeometry) if (obstacle) obstacles.push(obstacle)
    const homeSurface = panelGeometry.find(panel => panel.homeSurface)?.homeSurface ?? null
    const anchors = hostRect ? computePipAnchors(hostRect, obstacles, homeSurface) : null
    const aliases = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const
    const anchorRects = anchors ? Object.fromEntries(anchors.map(({ point }, index) =>
      [aliases[index], { ...point, width: 0, height: 0 }])) as NonNullable<ComputerUsePipHostLayout['anchorRects']> : null
    publish({
      hostId: 'klaus-main-thread', sessionId, anchorRect: hostRect, containerRect: hostRect, anchors, anchorRects,
      // Native completed cards remain visible for their completion animation
      // after activity ends. Activity controls the summary entry, not hosting.
      visible: hostRect !== null && state.supported && sessionId !== null && !browserPanelHidesPip()
        && !state.alwaysHidePictureInPicture && state.taskVisibilities[sessionId] === 'shown',
      animated: false, devicePixelRatio: window.devicePixelRatio || 1,
      isCodexHomeAvailable: homeSurface !== null, interactionPassthroughRect: null, presentationScope: 'thread',
    })
  }

  function schedule(): void {
    if (!stopped && frame === null) frame = window.requestAnimationFrame(() => { frame = null; measure() })
  }
  function observeElements(): void {
    resizeObserver.disconnect()
    attributesObserver.disconnect()
    const elements = new Set<Element>(document.querySelectorAll(MARKERS))
    for (const id of ['app', 'artifacts-panel', 'diff-view', 'workspace-main-view']) {
      const element = document.getElementById(id)
      if (element) elements.add(element)
    }
    elements.add(document.body)
    for (const element of elements) {
      resizeObserver.observe(element)
      attributesObserver.observe(element, { attributes: true, attributeFilter: ['class', 'hidden', 'style', 'data-mode'] })
    }
  }
  function sessionChanged(): void { notify(); schedule() }
  const unsubscribe = api()?.on?.computerUsePipState?.(receive)
  structureObserver.observe(document.body, {
    attributes: true, attributeFilter: ['data-pip-anchor-host', 'data-pip-home-surface', 'data-pip-obstacle', 'data-pip-work-panel', 'data-pip-panel-header', 'data-pip-summary-section'],
    childList: true, subtree: true,
  })
  window.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('resize', schedule)
  document.addEventListener('scroll', schedule, true)
  document.addEventListener('visibilitychange', sessionChanged)
  window.addEventListener('klaus:session-change', sessionChanged)
  window.addEventListener('pagehide', stop)
  requestLayout = schedule
  observeElements()
  schedule()
  // Subscribe before reading: a newer native push must beat an older initial reply.
  void api()?.computerUsePip?.getState().then(receive).catch(error => {
    localError = error instanceof Error ? error.message : String(error)
    notify()
  })

  function stop(): void {
    stopped = true
    if (frame !== null) window.cancelAnimationFrame(frame)
    resizeObserver.disconnect()
    attributesObserver.disconnect()
    structureObserver.disconnect()
    unsubscribe?.()
    window.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('resize', schedule)
    document.removeEventListener('scroll', schedule, true)
    document.removeEventListener('visibilitychange', sessionChanged)
    window.removeEventListener('klaus:session-change', sessionChanged)
    window.removeEventListener('pagehide', stop)
    measure()
    stopBridge = undefined
    requestLayout = undefined
  }
  stopBridge = stop
}
