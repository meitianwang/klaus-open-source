// The equity research workbench runs in an isolated native view over this host.
import type { EquityResearchOpenPayload } from '../../bridge/equity-research-api'
import { createNativeEditorPanel, type NativeEditorBounds, type NativeEditorPanelEnvironment } from './native-editor-panel'

export type EquityResearchPanelEnvironment = NativeEditorPanelEnvironment
export function createEquityResearchPanel(env: EquityResearchPanelEnvironment) {
  return createNativeEditorPanel(env, {
    title: 'equity_research_title',
    openFailed: 'equity_research_open_failed',
    backgroundPending: 'equity_research_background_pending',
  })
}

export function equityResearchPanelBounds(rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'> | null | undefined): NativeEditorBounds | null {
  if (!rect) return null
  const { left: x, top: y, width, height } = rect
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

// Give the research workbench breathing room
// whenever the workspace allows, without shrinking a wider user-chosen panel.
export const EQUITY_RESEARCH_PANEL_PREFERRED_WIDTH = 900
export const EQUITY_RESEARCH_PANEL_MIN_MAIN_WIDTH = 420

export function preferredEquityResearchPanelWidth(currentWidth: number, workspaceWidth: number): number | null {
  if (!Number.isFinite(workspaceWidth) || workspaceWidth <= 0) return null
  const maxPanel = Math.max(320, Math.round(workspaceWidth - EQUITY_RESEARCH_PANEL_MIN_MAIN_WIDTH))
  const target = Math.min(EQUITY_RESEARCH_PANEL_PREFERRED_WIDTH, maxPanel)
  const current = Number.isFinite(currentWidth) && currentWidth > 0 ? currentWidth : 460
  return target > current + 0.5 ? target : null
}

const w = () => window as any
let controller: ReturnType<typeof createEquityResearchPanel> | undefined
let boundsFrame = 0
export function scheduleEquityResearchBoundsSync(): void {
  if (boundsFrame) return
  boundsFrame = requestAnimationFrame(() => { boundsFrame = 0; void controller?.syncBounds() })
}
export function hideEquityResearchPanel(): Promise<void> { return controller?.hide() ?? Promise.resolve() }

export function initEquityResearchPanel(): void {
  if (controller) return
  const panel = document.getElementById('artifacts-panel')
  const host = document.getElementById('equity-research-panel-host')
  const text = (key: string) => w().tt?.(key) || key
  controller = createEquityResearchPanel({
    api: () => w().klaus?.equityResearch,
    currentSession: () => w().getCurrentSessionId?.() || '',
    visible: () => !!host && panel?.getAttribute('data-mode') === 'equity-research' && !panel.classList.contains('collapsed')
      && document.visibilityState !== 'hidden',
    bounds: () => equityResearchPanelBounds(host?.getBoundingClientRect()),
    layout: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    openMode: () => w().openArtifactsPanel?.('equity-research'),
    openTab: payload => w().KlausPanelTabs?.openEquityResearch?.(payload) ?? Promise.resolve(false),
    toast: message => w().showToast?.(message),
    text,
    schedule: scheduleEquityResearchBoundsSync,
    host: () => host,
  })
  const surface = controller
  w().klausActivateEquityResearchPanel = surface.activate
  w().klausHideEquityResearchPanel = surface.hide
  w().klausCloseEquityResearchPanel = surface.close
  w().klausActiveEquityResearchId = () => surface.state().activeId
  w().klausSuspendEquityResearchForOverlay = surface.suspend
  w().klausResumeEquityResearchAfterOverlay = surface.resume
  w().klausEquityResearchDiagnostics = surface.state
  w().klausEquityResearchResumeId = surface.resumeId
  w().klausOpenEquityResearchPanel = async (id: string, sessionId?: string) => {
    const session = sessionId || w().getCurrentSessionId?.() || ''
    if (!id || !session || session !== w().getCurrentSessionId?.()) return false
    const result = await w().klaus?.equityResearch?.open(id, session)
    if (!result?.ok) w().showToast?.(result?.error || text('equity_research_open_failed'))
    return result?.ok === true
  }
  w().klaus?.equityResearch?.onOpenPanel((payload: EquityResearchOpenPayload) => { void surface.onOpen(payload) })
  window.addEventListener('klaus:session-change', event => {
    void surface.sessionChanged((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || '')
  })
  if (host && typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleEquityResearchBoundsSync).observe(host)
  window.addEventListener('resize', scheduleEquityResearchBoundsSync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void surface.hide()
    else scheduleEquityResearchBoundsSync()
  })
  void surface.hide()
}
