import type { NativeEditorBounds, NativeEditorOpenPayload, NativeEditorPanelApi } from '../src/chat/native-editor-panel'

/** Only the isolated presentation preload holds these two host operations. */
export function createPptTransportHost(call: (channel: string, args: unknown) => Promise<unknown>) {
  return {
    ready: () => call('ppt:transport-ready', {}),
    chatRequest: (payload: unknown) => call('ppt:chat-request', payload),
    saveFile: (payload: unknown) => call('ppt:save-file', payload),
  }
}

export type PptBounds = NativeEditorBounds
export type PptOpenPayload = NativeEditorOpenPayload
export interface PptChatRequest { requestId: string; sessionId: string; id: string; text: string; submit: boolean }
export interface PptPanelApi extends NativeEditorPanelApi {
  list(sessionId: string): Promise<{ presentations: { id: string; title: string }[]; error?: string }>
  open(id: string, sessionId: string): Promise<{ ok?: boolean; error?: string }>
  onOpenPanel(cb: (payload: PptOpenPayload) => void): unknown
  onChatRequest(cb: (payload: PptChatRequest) => void): unknown
  chatResult(requestId: string, ok: boolean, error?: string): Promise<unknown>
}
