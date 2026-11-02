// The full presentation editor lives in an isolated native view over this host.
import type { PptOpenPayload } from '../../bridge/ppt-api'
import { createNativeEditorPanel, type NativeEditorBounds, type NativeEditorPanelEnvironment } from './native-editor-panel'

export type PptPanelEnvironment = NativeEditorPanelEnvironment
export function createPptPanel(env: PptPanelEnvironment) {
  return createNativeEditorPanel(env, {
    title: 'ppt_title', openFailed: 'ppt_open_failed', backgroundPending: 'ppt_background_pending',
  })
}

export function pptPanelBounds(rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'> | null | undefined): NativeEditorBounds | null {
  if (!rect) return null
  const { left: x, top: y, width, height } = rect
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  // The host converts CSS pixels using the window zoom before rounding.
  return { x, y, width, height }
}

const w = () => window as any
let controller: ReturnType<typeof createPptPanel> | undefined
let boundsFrame = 0
export function schedulePptBoundsSync(): void {
  if (boundsFrame) return
  boundsFrame = requestAnimationFrame(() => { boundsFrame = 0; void controller?.syncBounds() })
}
export function hidePptPanel(): Promise<void> { return controller?.hide() ?? Promise.resolve() }

export function initPptPanel(): void {
  if (controller) return
  const panel = document.getElementById('artifacts-panel')
  const host = document.getElementById('ppt-panel-host')
  const text = (key: string) => w().tt?.(key) || key
  controller = createPptPanel({
    api: () => w().klaus?.ppt,
    currentSession: () => w().getCurrentSessionId?.() || '',
    visible: () => !!host && panel?.getAttribute('data-mode') === 'ppt' && !panel.classList.contains('collapsed')
      && document.visibilityState !== 'hidden',
    bounds: () => pptPanelBounds(host?.getBoundingClientRect()),
    layout: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    openMode: () => w().openArtifactsPanel?.('ppt'),
    openTab: payload => w().KlausPanelTabs?.openPpt?.(payload) ?? Promise.resolve(false),
    toast: message => w().showToast?.(message), text,
    schedule: schedulePptBoundsSync,
  })
  const surface = controller
  w().klausActivatePptPanel = surface.activate
  w().klausHidePptPanel = surface.hide
  w().klausClosePptPanel = surface.close
  w().klausActivePptId = () => surface.state().activeId
  w().klausSuspendPptForOverlay = surface.suspend
  w().klausResumePptAfterOverlay = surface.resume
  w().klausPptDiagnostics = surface.state
  w().klausPptResumeId = surface.resumeId
  w().klausOpenPptPanel = async (id: string, sessionId?: string) => {
    const session = sessionId || w().getCurrentSessionId?.() || ''
    if (!id || !session || session !== w().getCurrentSessionId?.()) return false
    const result = await w().klaus?.ppt?.open(id, session)
    if (!result?.ok) w().showToast?.(result?.error || text('ppt_open_failed'))
    return result?.ok === true
  }
  w().klaus?.ppt?.onOpenPanel((payload: PptOpenPayload) => { void surface.onOpen(payload) })
  window.addEventListener('klaus:session-change', event => {
    void surface.sessionChanged((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || '')
  })
  if (host && typeof ResizeObserver !== 'undefined') new ResizeObserver(schedulePptBoundsSync).observe(host)
  window.addEventListener('resize', schedulePptBoundsSync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void surface.hide()
    else schedulePptBoundsSync()
  })
  // A renderer reload may leave a native view attached to the previous document.
  void surface.hide()
}
