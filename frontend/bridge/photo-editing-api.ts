// Isolated bridge for the photo-editing WebContentsView: exposes only lifecycle actions.
export interface PhotoEditingRuntimeAction {
  type: 'load' | 'save' | 'export' | 'import' | 'open-url' | 'ready' | 'error'
  [key: string]: unknown
}

export interface PhotoEditingHostSurface {
  action(action: PhotoEditingRuntimeAction): Promise<unknown>
}

export function createPhotoEditingHostSurface(
  call: (channel: string, args: unknown) => Promise<unknown>,
): PhotoEditingHostSurface {
  return {
    action: action => call('photo-editing:runtime-action', { action }),
  }
}

export interface PhotoEditingBounds { x: number; y: number; width: number; height: number }
export interface PhotoEditingOpenPayload { requestId?: string; id: string; title?: string; sessionId: string }
export interface PhotoEditingListRow { id: string; title: string }
export interface PhotoEditingPanelReply { ok?: boolean; error?: string }

export interface PhotoEditingPanelApi {
  list(sessionId: string): Promise<{ photoWorkspaces: PhotoEditingListRow[]; error?: string }>
  open(id: string, sessionId: string): Promise<PhotoEditingPanelReply>
  panelShow(id: string, sessionId: string, bounds: PhotoEditingBounds): Promise<PhotoEditingPanelReply>
  panelSetBounds(bounds: PhotoEditingBounds): Promise<PhotoEditingPanelReply>
  panelHide(): Promise<unknown>
  panelClose(): Promise<unknown>
  onOpenPanel(cb: (payload: PhotoEditingOpenPayload) => void): unknown
  openResult(requestId: string, ok: boolean, error?: string): Promise<unknown>
}
