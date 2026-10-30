import type {
  PetLiveVoiceState,
  PetVoiceEvent,
  PetRealtimeOffer,
  PetRealtimeOptions,
  PetRealtimeAnswer,
  PetRealtimeAudioFrame,
  PetRealtimeControl,
} from "../../contracts/desktop-pet-voice";
import type {
  PetComposerAttachment,
  PetScreenshotSource,
  PetComposerSubmission,
  PetComposerImport,
  PetComposerResult,
  PetConversationState,
  PetComposerDraft,
  PetCaptureEvent,
} from "../../contracts/desktop-pet-composer";
import type { PetTaskResponse } from "../../contracts/desktop-pet-attention";
import { call, expose, subscribe } from "./ipc.js";
import type { PetAppshotSettings, PetAppshotState } from '../../contracts/desktop-pet-appshot';
import type {
  PetVoiceState,
  PetDragPoint,
  PetElementLayout,
  PetImportRequest,
  PetPreview,
  PetRect,
  PetSettings,
  PetState,
} from "../../contracts/desktop-pet";

export const petApi = {
  getState: (): Promise<PetState> => call("desktop-pet:get-state"),
  appshotSettings: (): Promise<PetAppshotState> => call('desktop-pet:appshot-settings'),
  updateAppshotSettings: (settings: Partial<PetAppshotSettings>): Promise<PetAppshotState> => call('desktop-pet:update-appshot-settings', settings),
  acknowledgeMainCapture: (captureId: string, accepted: boolean, error?: string): Promise<void> => call('desktop-pet:ack-main-capture', { captureId, accepted, ...(error ? { error } : {}) }),
  updateSettings: (settings: Partial<PetSettings>): Promise<PetState> =>
    call("desktop-pet:update-settings", settings),
  show: (): Promise<void> => call("desktop-pet:show"),
  hide: (): Promise<void> => call("desktop-pet:hide"),
  toggle: (): Promise<void> => call("desktop-pet:toggle"),
  rendererReady: (): Promise<PetState> => call("desktop-pet:renderer-ready"),
  setRegions: (regions: PetRect[]): Promise<void> =>
    call("desktop-pet:set-regions", { regions }),
  setLayout: (layout: PetElementLayout): Promise<PetState> =>
    call("desktop-pet:set-layout", layout),
  completeFocus: (requestId: number, layoutRevision: number): Promise<boolean> =>
    call("desktop-pet:complete-focus", { requestId, layoutRevision }),
  dragStart: (point: PetDragPoint): Promise<void> =>
    call("desktop-pet:drag-start", point),
  dragMove: (point: PetDragPoint): Promise<void> =>
    call("desktop-pet:drag-move", point),
  dragEnd: (point: PetDragPoint & { altKey?: boolean }): Promise<void> =>
    call("desktop-pet:drag-end", point),
  throw: (velocity: { x: number; y: number }, bounce = false): Promise<void> =>
    call("desktop-pet:throw", {
      velocityX: velocity.x,
      velocityY: velocity.y,
      bounce,
    }),
  stash: (edge: "left" | "right" | null): Promise<void> =>
    call("desktop-pet:stash", { edge }),
  openTask: (id: string): Promise<void> =>
    call("desktop-pet:open-task", { id }),
  dismissTask: (id: string): Promise<void> =>
    call("desktop-pet:dismiss-task", { id }),
  acknowledgeTask: (id: string): Promise<void> =>
    call("desktop-pet:acknowledge-task", { id }),
  openMain: (): Promise<void> => call("desktop-pet:open-main"),
  openSettings: (): Promise<void> => call("desktop-pet:open-settings"),
  contextMenu: (taskId?: string): Promise<void> =>
    call("desktop-pet:context-menu", taskId ? { taskId } : {}),
  setTaskMuted: (id: string, muted: boolean): Promise<void> =>
    call("desktop-pet:set-task-muted", { id, muted }),
  importFile: (): Promise<PetState> => call("desktop-pet:import-file"),
  previewUrl: (imageUrl: string): Promise<PetPreview> =>
    call("desktop-pet:preview-url", { imageUrl, name: "Custom pet" }),
  importUrl: (request: PetImportRequest): Promise<PetState> =>
    call("desktop-pet:import-url", request),
  deletePet: (id: string): Promise<PetState> =>
    call("desktop-pet:delete-pet", { id }),
  refreshCatalog: (): Promise<PetState> => call("desktop-pet:refresh-catalog"),
  openFolder: (): Promise<void> => call("desktop-pet:open-folder"),
  createPet: (): Promise<void> => call("desktop-pet:create-pet"),
  upgradePet: (id: string): Promise<void> =>
    call("desktop-pet:upgrade-pet", { id }),
  setKeyboard: (enabled: boolean): Promise<void> =>
    call("desktop-pet:set-keyboard", { active: enabled }),
  setComposerFocused: (focused: boolean): Promise<void> => call('desktop-pet:set-composer-focused', { focused }),
  pickAttachments: (): Promise<PetComposerAttachment[]> =>
    call("desktop-pet:pick-attachments"),
  screenshotSources: (): Promise<PetScreenshotSource[]> =>
    call("desktop-pet:screenshot-sources"),
  attachScreenshot: (sourceId: string): Promise<PetComposerAttachment> =>
    call("desktop-pet:attach-screenshot", { sourceId }),
  attachForeground: (): Promise<PetComposerAttachment> => call("desktop-pet:attach-foreground"),
  onCapture: (callback: (value: PetCaptureEvent) => void) => subscribe("desktop-pet:capture-event", callback),
  removeAttachment: (id: string): Promise<void> =>
    call("desktop-pet:remove-attachment", { id }),
  importAttachment: (value: PetComposerImport): Promise<PetComposerAttachment> =>
    call("desktop-pet:import-attachment", value),
  submitMessage: (submission: PetComposerSubmission): Promise<PetComposerResult | null> =>
    call("desktop-pet:submit-message", submission),
  conversationState: (): Promise<PetConversationState> => call("desktop-pet:conversation-state"),
  composerDraft: (): Promise<PetComposerDraft> => call("desktop-pet:composer-draft"),
  saveComposerDraft: (draft: PetComposerDraft): Promise<void> => call("desktop-pet:save-composer-draft", draft),
  selectConversation: (sessionId: string | null, title?: string): Promise<PetConversationState> => call("desktop-pet:select-conversation", { sessionId, ...(title ? { title } : {}) }),
  refreshConversation: (): Promise<PetConversationState> => call("desktop-pet:refresh-conversation"),
  stopConversation: (sessionId?: string): Promise<PetConversationState> => call("desktop-pet:stop-conversation", sessionId ? { sessionId } : {}),
  reactMessage: (messageId: string, reaction: string): Promise<PetConversationState> => call("desktop-pet:react-message", { messageId, reaction }),
  onConversation: (callback: (value: PetConversationState) => void) => subscribe("desktop-pet:conversation", callback),
  submit: (text: string): Promise<void> => call("desktop-pet:submit", { text }),
  respondTask: (request: PetTaskResponse): Promise<void> =>
    call("desktop-pet:respond-task", request),
  clearCompleted: (): Promise<void> => call("desktop-pet:clear-completed"),
  onState: (callback: (state: PetState) => void) =>
    subscribe("desktop-pet:state", callback),
  onFocus: (
    callback: (payload?: { type: "focus-input" | "toggle-input" | "cancel-focus"; requestId?: number; wasHidden?: boolean }) => void,
  ) => subscribe("desktop-pet:focus", callback),
  onPointer: (callback: (point: { x: number; y: number }) => void) =>
    subscribe("desktop-pet:pointer", callback),
  onVoiceEvent: (callback: (event: PetVoiceEvent) => void) =>
    subscribe("desktop-pet:voice-event", callback),
  voiceConfig: (operationId?: string): Promise<{ ok?: boolean; source?: string; sourceAvailable?: boolean; systemAsr?: boolean; streaming?: boolean }> => call('voice:config:get', { operationId }),
  micPermission: (operationId?: string): Promise<{ ok?: boolean; error?: string }> => call('voice:mic-permission', { operationId }),
  transcribe: (data: ArrayBuffer, mimeType?: string, operationId?: string, options?: { source: string; context?: string; durationMs?: number; partial?: boolean; segmentIds?: string[] }): Promise<{ ok?: boolean; text?: string; rawText?: string; error?: string }> => call('voice:transcribe', { data, mimeType, operationId, ...options }),
  sessionStart: (options: { operationId: string; context?: string; source?: string }): Promise<{ ok?: boolean; sessionId?: string; error?: string }> => call('voice:session:start', options),
  sessionAudio: (sessionId: string, data: ArrayBuffer, seq: number): Promise<{ ok?: boolean; error?: string }> => call('voice:session:audio', { sessionId, data, seq }),
  sessionStop: (sessionId: string): Promise<{ ok?: boolean; error?: string }> => call('voice:session:stop', { sessionId }),
  sessionCancel: (sessionId: string): Promise<{ ok?: boolean; complete?: boolean }> => call('voice:session:cancel', { sessionId }),
  onSessionEvent: (callback: (event: { sessionId?: string; seq?: number; type?: string; text?: string; rawText?: string; code?: string }) => void) => subscribe('voice:session:event', callback),
  realtimeOptions: (sourceId?: string, sessionId?: string): Promise<PetRealtimeOptions> => call('desktop-pet:realtime-options', { ...(sourceId ? { sourceId } : {}), ...(sessionId ? { sessionId } : {}) }),
  realtimeState: (): Promise<PetLiveVoiceState> => call("desktop-pet:realtime-state"),
  negotiateRealtime: (value: PetRealtimeOffer): Promise<PetRealtimeAnswer> => call("desktop-pet:negotiate-realtime", value),
  endRealtime: (value: { requestId: string; generation?: number }): Promise<PetLiveVoiceState> => call("desktop-pet:end-realtime", value),
  controlRealtime: (value: PetRealtimeControl): Promise<PetLiveVoiceState> => call("desktop-pet:realtime-control", value),
  appendRealtimeAudio: (value: PetRealtimeAudioFrame): Promise<null> => call("desktop-pet:realtime-audio", value),

};

export type DesktopPetApi = typeof petApi;
expose("klausPet", petApi);
