// The editor receives one capability, without the main renderer bridge.
export interface VideoEditingRuntimeAction {
  type: string
  [key: string]: unknown
}

export interface VideoEditingHostSurface {
  action(action: VideoEditingRuntimeAction): Promise<unknown>
}

export function createVideoEditingHostSurface(call: (channel: string, args: unknown) => Promise<unknown>): VideoEditingHostSurface {
  return {
    action: action => call('video-editing:runtime-action', { action }),
  }
}

export interface VideoEditingBounds { x: number; y: number; width: number; height: number }
export interface VideoEditingOpenPayload { requestId?: string; id: string; title?: string; sessionId: string }
export interface VideoEditingListRow { id: string; title: string }
export interface VideoEditingPanelReply { ok?: boolean; error?: string }

export interface VideoEditingPanelApi {
  list(sessionId: string): Promise<{ videos: VideoEditingListRow[]; error?: string }>
  open(id: string, sessionId: string): Promise<VideoEditingPanelReply>
  panelShow(id: string, sessionId: string, bounds: VideoEditingBounds): Promise<VideoEditingPanelReply>
  panelSetBounds(bounds: VideoEditingBounds): Promise<VideoEditingPanelReply>
  panelHide(): Promise<unknown>
  panelClose(): Promise<VideoEditingPanelReply | void>
  onOpenPanel(cb: (payload: VideoEditingOpenPayload) => void): unknown
  openResult(requestId: string, ok: boolean, error?: string): Promise<unknown>
}
