import type { NativeEditorBounds, NativeEditorOpenPayload, NativeEditorPanelApi } from '../src/chat/native-editor-panel'

/** Only the isolated Design Canvas preload holds these three host operations. */
export function createDesignTransportHost(call: (channel: string, args: unknown) => Promise<unknown>) {
  return {
    ready: () => call('design:transport-ready', {}),
    chatRequest: (payload: unknown) => call('design:chat-request', payload),
    saveFile: (payload: unknown) => call('design:save-file', payload),
  }
}

export type DesignBounds = NativeEditorBounds
export type DesignOpenPayload = NativeEditorOpenPayload
export interface DesignChatRequest { requestId: string; sessionId: string; id: string; text: string; submit: boolean }
export interface DesignPanelApi extends NativeEditorPanelApi {
  list(sessionId: string): Promise<{ designs: { id: string; title: string }[]; error?: string }>
  open(id: string, sessionId: string): Promise<{ ok?: boolean; error?: string }>
  onOpenPanel(cb: (payload: DesignOpenPayload) => void): unknown
  onChatRequest(cb: (payload: DesignChatRequest) => void): unknown
  chatResult(requestId: string, ok: boolean, error?: string): Promise<unknown>
}
