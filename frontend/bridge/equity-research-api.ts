// Isolated bridge for the equity-research WebContentsView: exposes only lifecycle actions.
export interface EquityResearchRuntimeAction {
  type: 'load' | 'save' | 'refresh' | 'export' | 'open-url' | 'ready' | 'error'
  [key: string]: unknown
}

export interface EquityResearchHostSurface {
  action(action: EquityResearchRuntimeAction): Promise<unknown>
}

export function createEquityResearchHostSurface(
  call: (channel: string, args: unknown) => Promise<unknown>,
): EquityResearchHostSurface {
  return {
    action: action => call('equity-research:runtime-action', { action }),
  }
}

export interface EquityResearchBounds { x: number; y: number; width: number; height: number }
export interface EquityResearchOpenPayload { requestId?: string; id: string; title?: string; sessionId: string }
export interface EquityResearchListRow { id: string; title: string }
export interface EquityResearchPanelReply { ok?: boolean; error?: string }

export interface EquityResearchPanelApi {
  list(sessionId: string): Promise<{ equityWorkspaces: EquityResearchListRow[]; error?: string }>
  open(id: string, sessionId: string): Promise<EquityResearchPanelReply>
  panelShow(id: string, sessionId: string, bounds: EquityResearchBounds): Promise<EquityResearchPanelReply>
  panelSetBounds(bounds: EquityResearchBounds): Promise<EquityResearchPanelReply>
  panelHide(): Promise<unknown>
  panelClose(): Promise<unknown>
  onOpenPanel(cb: (payload: EquityResearchOpenPayload) => void): unknown
  openResult(requestId: string, ok: boolean, error?: string): Promise<unknown>
}
