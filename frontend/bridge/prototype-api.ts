// The editor receives one capability, without the main renderer bridge.
export interface PrototypeRuntimeAction {
  type: 'load' | 'save' | 'export' | 'import' | 'open-url' | 'ready' | 'error'
  [key: string]: unknown
}

export interface PrototypeHostSurface {
  action(action: PrototypeRuntimeAction): Promise<unknown>
}

export function createPrototypeHostSurface(call: (channel: string, args: unknown) => Promise<unknown>): PrototypeHostSurface {
  return {
    action: action => call('prototype:runtime-action', { action }),
  }
}

export interface PrototypeBounds { x: number; y: number; width: number; height: number }
export interface PrototypeOpenPayload { requestId?: string; id: string; title?: string; sessionId: string }
export interface PrototypeListRow { id: string; title: string }
export interface PrototypePanelReply { ok?: boolean; error?: string }

export interface PrototypePanelApi {
  list(sessionId: string): Promise<{ prototypes: PrototypeListRow[]; error?: string }>
  open(id: string, sessionId: string): Promise<PrototypePanelReply>
  panelShow(id: string, sessionId: string, bounds: PrototypeBounds): Promise<PrototypePanelReply>
  panelSetBounds(bounds: PrototypeBounds): Promise<PrototypePanelReply>
  panelHide(): Promise<unknown>
  panelClose(): Promise<unknown>
  onOpenPanel(cb: (payload: PrototypeOpenPayload) => void): unknown
  openResult(requestId: string, ok: boolean, error?: string): Promise<unknown>
}
