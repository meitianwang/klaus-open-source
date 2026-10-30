// The host rectangle carries an isolated editor; the renderer owns presentation.
import type { PrototypeOpenPayload } from '../../bridge/prototype-api'
import { createNativeEditorPanel, type NativeEditorPanelEnvironment } from './native-editor-panel'

export type PrototypePanelEnvironment = NativeEditorPanelEnvironment
export function createPrototypePanel(env: PrototypePanelEnvironment) {
  return createNativeEditorPanel(env, {
    title: 'prototype_title', openFailed: 'prototype_open_failed', backgroundPending: 'prototype_background_pending',
  })
}

const w = () => window as any
let controller: ReturnType<typeof createPrototypePanel> | undefined
let boundsFrame = 0
export function schedulePrototypeBoundsSync(): void {
  if (boundsFrame) return
  boundsFrame = requestAnimationFrame(() => { boundsFrame = 0; void controller?.syncBounds() })
}
export function hidePrototypePanel(): Promise<void> { return controller?.hide() ?? Promise.resolve() }

export function initPrototypePanel(): void {
  if (controller) return
  const panel = document.getElementById('artifacts-panel')
  const host = document.getElementById('prototype-panel-host')
  const text = (key: string) => w().tt?.(key) || key
  controller = createPrototypePanel({
    api: () => w().klaus?.prototype,
    currentSession: () => w().getCurrentSessionId?.() || '',
    visible: () => !!host && panel?.getAttribute('data-mode') === 'prototype' && !panel.classList.contains('collapsed'),
    bounds: () => {
      const rect = host?.getBoundingClientRect()
      return rect && rect.width > 0 && rect.height > 0 ? {
        x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
      } : null
    },
    layout: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    openMode: () => w().openArtifactsPanel?.('prototype'),
    openTab: payload => w().KlausPanelTabs?.openPrototype?.(payload) ?? Promise.resolve(false),
    toast: message => w().showToast?.(message), text,
    schedule: schedulePrototypeBoundsSync,
  })
  const surface = controller
  w().klausActivatePrototypePanel = surface.activate
  w().klausHidePrototypePanel = surface.hide
  w().klausClosePrototypePanel = surface.close
  w().klausActivePrototypeId = () => surface.state().activeId
  w().klausSuspendPrototypeForOverlay = surface.suspend
  w().klausResumePrototypeAfterOverlay = surface.resume
  w().klausPrototypeDiagnostics = surface.state
  w().klausPrototypeResumeId = surface.resumeId
  // Clicking a known artifact asks the host to resolve its owned document.
  w().klausOpenPrototypePanel = async (id: string, sessionId?: string) => {
    const session = sessionId || w().getCurrentSessionId?.() || ''
    if (!id || !session || session !== w().getCurrentSessionId?.()) return false
    const result = await w().klaus?.prototype?.open(id, session)
    if (!result?.ok) w().showToast?.(result?.error || text('prototype_open_failed'))
    return result?.ok === true
  }
  w().klaus?.prototype?.onOpenPanel((payload: PrototypeOpenPayload) => { void surface.onOpen(payload) })
  window.addEventListener('klaus:session-change', event => {
    void surface.sessionChanged((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || '')
  })
  if (host && typeof ResizeObserver !== 'undefined') new ResizeObserver(schedulePrototypeBoundsSync).observe(host)
  window.addEventListener('resize', schedulePrototypeBoundsSync)
  // Switching to another app only occludes this window; the native editor stays attached through that.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') schedulePrototypeBoundsSync()
  })
  // A renderer reload may leave a native view attached to the previous document.
  void surface.hide()
}
