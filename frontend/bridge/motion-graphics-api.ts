// Isolated bridge for the motion-graphics WebContentsView: exposes only lifecycle actions.
export interface MotionGraphicsRuntimeAction {
  type: 'load' | 'save' | 'export' | 'import' | 'open-url' | 'ready' | 'error'
  [key: string]: unknown
}

export interface MotionGraphicsHostSurface {
  action(action: MotionGraphicsRuntimeAction): Promise<unknown>
}

export function createMotionGraphicsHostSurface(
  call: (channel: string, args: unknown) => Promise<unknown>,
): MotionGraphicsHostSurface {
  return {
    action: action => call('motion-graphics:runtime-action', { action }),
  }
}

export interface MotionGraphicsBounds { x: number; y: number; width: number; height: number }
export interface MotionGraphicsOpenPayload { requestId?: string; id: string; title?: string; sessionId: string }
export interface MotionGraphicsListRow { id: string; title: string }
export interface MotionGraphicsPanelReply { ok?: boolean; error?: string }

export interface MotionGraphicsPanelApi {
  list(sessionId: string): Promise<{ motionWorkspaces: MotionGraphicsListRow[]; error?: string }>
  open(id: string, sessionId: string): Promise<MotionGraphicsPanelReply>
  panelShow(id: string, sessionId: string, bounds: MotionGraphicsBounds): Promise<MotionGraphicsPanelReply>
  panelSetBounds(bounds: MotionGraphicsBounds): Promise<MotionGraphicsPanelReply>
  panelHide(): Promise<unknown>
  panelClose(): Promise<unknown>
  onOpenPanel(cb: (payload: MotionGraphicsOpenPayload) => void): unknown
  openResult(requestId: string, ok: boolean, error?: string): Promise<unknown>
}
