// The layered photo-editing workspace runs in an isolated native view over this host.
import type { PhotoEditingOpenPayload } from '../../bridge/photo-editing-api'
import { createNativeEditorPanel, type NativeEditorBounds, type NativeEditorPanelEnvironment } from './native-editor-panel'

export type PhotoEditingPanelEnvironment = NativeEditorPanelEnvironment
export function createPhotoEditingPanel(env: PhotoEditingPanelEnvironment) {
  return createNativeEditorPanel(env, {
    title: 'photo_editing_title',
    openFailed: 'photo_editing_open_failed',
    backgroundPending: 'photo_editing_background_pending',
  })
}

export function photoEditingPanelBounds(rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'> | null | undefined): NativeEditorBounds | null {
  if (!rect) return null
  const { left: x, top: y, width, height } = rect
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

// Give the tool rail, canvas viewport, and layer/properties dock breathing room
// whenever the workspace allows, without shrinking a wider user-chosen panel.
export const PHOTO_EDITING_PANEL_PREFERRED_WIDTH = 880
export const PHOTO_EDITING_PANEL_MIN_MAIN_WIDTH = 420

export function preferredPhotoEditingPanelWidth(currentWidth: number, workspaceWidth: number): number | null {
  if (!Number.isFinite(workspaceWidth) || workspaceWidth <= 0) return null
  const maxPanel = Math.max(320, Math.round(workspaceWidth - PHOTO_EDITING_PANEL_MIN_MAIN_WIDTH))
  const target = Math.min(PHOTO_EDITING_PANEL_PREFERRED_WIDTH, maxPanel)
  const current = Number.isFinite(currentWidth) && currentWidth > 0 ? currentWidth : 460
  return target > current + 0.5 ? target : null
}

const w = () => window as any
let controller: ReturnType<typeof createPhotoEditingPanel> | undefined
let boundsFrame = 0
export function schedulePhotoEditingBoundsSync(): void {
  if (boundsFrame) return
  boundsFrame = requestAnimationFrame(() => { boundsFrame = 0; void controller?.syncBounds() })
}
export function hidePhotoEditingPanel(): Promise<void> { return controller?.hide() ?? Promise.resolve() }

export function initPhotoEditingPanel(): void {
  if (controller) return
  const panel = document.getElementById('artifacts-panel')
  const host = document.getElementById('photo-editing-panel-host')
  const text = (key: string) => w().tt?.(key) || key
  controller = createPhotoEditingPanel({
    api: () => w().klaus?.photoEditing,
    currentSession: () => w().getCurrentSessionId?.() || '',
    visible: () => !!host && panel?.getAttribute('data-mode') === 'photo-editing' && !panel.classList.contains('collapsed')
      && document.visibilityState !== 'hidden',
    bounds: () => photoEditingPanelBounds(host?.getBoundingClientRect()),
    layout: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    openMode: () => w().openArtifactsPanel?.('photo-editing'),
    openTab: payload => w().KlausPanelTabs?.openPhotoEditing?.(payload) ?? Promise.resolve(false),
    toast: message => w().showToast?.(message),
    text,
    schedule: schedulePhotoEditingBoundsSync,
  })
  const surface = controller
  w().klausActivatePhotoEditingPanel = surface.activate
  w().klausHidePhotoEditingPanel = surface.hide
  w().klausClosePhotoEditingPanel = surface.close
  w().klausActivePhotoEditingId = () => surface.state().activeId
  w().klausSuspendPhotoEditingForOverlay = surface.suspend
  w().klausResumePhotoEditingAfterOverlay = surface.resume
  w().klausPhotoEditingDiagnostics = surface.state
  w().klausPhotoEditingResumeId = surface.resumeId
  w().klausOpenPhotoEditingPanel = async (id: string, sessionId?: string) => {
    const session = sessionId || w().getCurrentSessionId?.() || ''
    if (!id || !session || session !== w().getCurrentSessionId?.()) return false
    const result = await w().klaus?.photoEditing?.open(id, session)
    if (!result?.ok) w().showToast?.(result?.error || text('photo_editing_open_failed'))
    return result?.ok === true
  }
  w().klaus?.photoEditing?.onOpenPanel((payload: PhotoEditingOpenPayload) => { void surface.onOpen(payload) })
  window.addEventListener('klaus:session-change', event => {
    void surface.sessionChanged((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || '')
  })
  if (host && typeof ResizeObserver !== 'undefined') new ResizeObserver(schedulePhotoEditingBoundsSync).observe(host)
  window.addEventListener('resize', schedulePhotoEditingBoundsSync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void surface.hide()
    else schedulePhotoEditingBoundsSync()
  })
  void surface.hide()
}
