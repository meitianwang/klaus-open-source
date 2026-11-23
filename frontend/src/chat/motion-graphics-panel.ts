// The timeline motion-graphics and visual-effects studio runs in an isolated native view over this host.
import type { MotionGraphicsOpenPayload } from '../../bridge/motion-graphics-api'
import { createNativeEditorPanel, type NativeEditorBounds, type NativeEditorPanelEnvironment } from './native-editor-panel'

export type MotionGraphicsPanelEnvironment = NativeEditorPanelEnvironment
export function createMotionGraphicsPanel(env: MotionGraphicsPanelEnvironment) {
  return createNativeEditorPanel(env, {
    title: 'motion_graphics_title',
    openFailed: 'motion_graphics_open_failed',
    backgroundPending: 'motion_graphics_background_pending',
  })
}

export function motionGraphicsPanelBounds(rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'> | null | undefined): NativeEditorBounds | null {
  if (!rect) return null
  const { left: x, top: y, width, height } = rect
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

// Give the project bin, viewer canvas, properties inspector, and multi-track timeline breathing room
// whenever the workspace allows, without shrinking a wider user-chosen panel.
export const MOTION_GRAPHICS_PANEL_PREFERRED_WIDTH = 920
export const MOTION_GRAPHICS_PANEL_MIN_MAIN_WIDTH = 420

export function preferredMotionGraphicsPanelWidth(currentWidth: number, workspaceWidth: number): number | null {
  if (!Number.isFinite(workspaceWidth) || workspaceWidth <= 0) return null
  const maxPanel = Math.max(320, Math.round(workspaceWidth - MOTION_GRAPHICS_PANEL_MIN_MAIN_WIDTH))
  const target = Math.min(MOTION_GRAPHICS_PANEL_PREFERRED_WIDTH, maxPanel)
  const current = Number.isFinite(currentWidth) && currentWidth > 0 ? currentWidth : 460
  return target > current + 0.5 ? target : null
}

const w = () => window as any
let controller: ReturnType<typeof createMotionGraphicsPanel> | undefined
let boundsFrame = 0
export function scheduleMotionGraphicsBoundsSync(): void {
  if (boundsFrame) return
  boundsFrame = requestAnimationFrame(() => { boundsFrame = 0; void controller?.syncBounds() })
}
export function hideMotionGraphicsPanel(): Promise<void> { return controller?.hide() ?? Promise.resolve() }

export function initMotionGraphicsPanel(): void {
  if (controller) return
  const panel = document.getElementById('artifacts-panel')
  const host = document.getElementById('motion-graphics-panel-host')
  const text = (key: string) => w().tt?.(key) || key
  controller = createMotionGraphicsPanel({
    api: () => w().klaus?.motionGraphics,
    currentSession: () => w().getCurrentSessionId?.() || '',
    visible: () => !!host && panel?.getAttribute('data-mode') === 'motion-graphics' && !panel.classList.contains('collapsed')
      && document.visibilityState !== 'hidden',
    bounds: () => motionGraphicsPanelBounds(host?.getBoundingClientRect()),
    layout: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    openMode: () => w().openArtifactsPanel?.('motion-graphics'),
    openTab: payload => w().KlausPanelTabs?.openMotionGraphics?.(payload) ?? Promise.resolve(false),
    toast: message => w().showToast?.(message),
    text,
    schedule: scheduleMotionGraphicsBoundsSync,
    host: () => host,
  })
  const surface = controller
  w().klausActivateMotionGraphicsPanel = surface.activate
  w().klausHideMotionGraphicsPanel = surface.hide
  w().klausCloseMotionGraphicsPanel = surface.close
  w().klausActiveMotionGraphicsId = () => surface.state().activeId
  w().klausSuspendMotionGraphicsForOverlay = surface.suspend
  w().klausResumeMotionGraphicsAfterOverlay = surface.resume
  w().klausMotionGraphicsDiagnostics = surface.state
  w().klausMotionGraphicsResumeId = surface.resumeId
  w().klausOpenMotionGraphicsPanel = async (id: string, sessionId?: string) => {
    const session = sessionId || w().getCurrentSessionId?.() || ''
    if (!id || !session || session !== w().getCurrentSessionId?.()) return false
    const result = await w().klaus?.motionGraphics?.open(id, session)
    if (!result?.ok) w().showToast?.(result?.error || text('motion_graphics_open_failed'))
    return result?.ok === true
  }
  w().klaus?.motionGraphics?.onOpenPanel((payload: MotionGraphicsOpenPayload) => { void surface.onOpen(payload) })
  window.addEventListener('klaus:session-change', event => {
    void surface.sessionChanged((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || '')
  })
  if (host && typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleMotionGraphicsBoundsSync).observe(host)
  window.addEventListener('resize', scheduleMotionGraphicsBoundsSync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void surface.hide()
    else scheduleMotionGraphicsBoundsSync()
  })
  void surface.hide()
}
