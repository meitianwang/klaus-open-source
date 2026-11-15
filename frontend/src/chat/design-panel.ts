// The full Design Canvas editor lives in an isolated native view over this host.
import type { DesignOpenPayload } from '../../bridge/design-api'
import { createNativeEditorPanel, type NativeEditorBounds, type NativeEditorPanelEnvironment } from './native-editor-panel'

export type DesignPanelEnvironment = NativeEditorPanelEnvironment
export function createDesignPanel(env: DesignPanelEnvironment) {
  return createNativeEditorPanel(env, {
    title: 'design_title', openFailed: 'design_open_failed', backgroundPending: 'design_background_pending',
  })
}

export function designPanelBounds(rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'> | null | undefined): NativeEditorBounds | null {
  if (!rect) return null
  const { left: x, top: y, width, height } = rect
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

const w = () => window as any
let controller: ReturnType<typeof createDesignPanel> | undefined
let boundsFrame = 0
export function scheduleDesignBoundsSync(): void {
  if (boundsFrame) return
  boundsFrame = requestAnimationFrame(() => { boundsFrame = 0; void controller?.syncBounds() })
}
export function hideDesignPanel(): Promise<void> { return controller?.hide() ?? Promise.resolve() }

export function initDesignPanel(): void {
  if (controller) return
  const panel = document.getElementById('artifacts-panel')
  const host = document.getElementById('design-panel-host')
  const text = (key: string) => w().tt?.(key) || key
  controller = createDesignPanel({
    api: () => w().klaus?.design,
    currentSession: () => w().getCurrentSessionId?.() || '',
    visible: () => !!host && panel?.getAttribute('data-mode') === 'design' && !panel.classList.contains('collapsed')
      && document.visibilityState !== 'hidden',
    bounds: () => designPanelBounds(host?.getBoundingClientRect()),
    layout: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    openMode: () => w().openArtifactsPanel?.('design'),
    openTab: payload => w().KlausPanelTabs?.openDesign?.(payload) ?? Promise.resolve(false),
    toast: message => w().showToast?.(message), text,
    schedule: scheduleDesignBoundsSync,
  })
  const surface = controller
  w().klausActivateDesignPanel = surface.activate
  w().klausHideDesignPanel = surface.hide
  w().klausCloseDesignPanel = surface.close
  w().klausActiveDesignId = () => surface.state().activeId
  w().klausSuspendDesignForOverlay = surface.suspend
  w().klausResumeDesignAfterOverlay = surface.resume
  w().klausDesignDiagnostics = surface.state
  w().klausDesignResumeId = surface.resumeId
  w().klausOpenDesignPanel = async (id: string, sessionId?: string) => {
    const session = sessionId || w().getCurrentSessionId?.() || ''
    if (!id || !session || session !== w().getCurrentSessionId?.()) return false
    const result = await w().klaus?.design?.open(id, session)
    if (!result?.ok) w().showToast?.(result?.error || text('design_open_failed'))
    return result?.ok === true
  }
  w().klaus?.design?.onOpenPanel((payload: DesignOpenPayload) => { void surface.onOpen(payload) })
  window.addEventListener('klaus:session-change', event => {
    void surface.sessionChanged((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || '')
  })
  if (host && typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleDesignBoundsSync).observe(host)
  window.addEventListener('resize', scheduleDesignBoundsSync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void surface.hide()
    else scheduleDesignBoundsSync()
  })
  void surface.hide()
}
