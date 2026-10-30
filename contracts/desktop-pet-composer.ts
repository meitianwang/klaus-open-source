export interface PetComposerAttachment {
  id: string;
  name: string;
  size: number;
  kind: 'image' | 'file' | 'appshot';
  previewUrl?: string;
  context?: PetAppshotContext;
}
export interface PetAppshotContext {
  capturedAt: number;
  appName?: string;
  bundleId?: string;
  pid?: number;
  windowId?: number;
  windowTitle?: string;
  url?: string;
  selectedText?: string;
  accessibilityText?: string;
  accessibilityUnavailableReason?: string;
  treeTruncated?: boolean;
  observationChanged?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface PetCapturedScreenshot { data: Uint8Array; context: PetAppshotContext }
export type PetCaptureEvent =
  | { type: 'started'; captureId: string }
  | { type: 'completed'; captureId: string; attachment: PetComposerAttachment }
  | { type: 'failed'; captureId: string; message: string };
export interface PetScreenshotSource { id: string; name: string; previewUrl: string }
export interface PetComposerSubmission {
  text: string;
  attachmentIds: string[];
  submissionId: string;
  targetTaskId?: string;
  replyTo?: { id: string; text: string; role: 'user' | 'assistant' };
}
export interface PetComposerResult { sessionId: string; turnId?: string }
export interface PetConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  turnId?: string;
  phase?: string;
  pending?: boolean;
  attachments?: Array<{ name: string; kind: 'image' | 'file' | 'appshot'; previewUrl?: string }>;
  replyTo?: PetComposerSubmission['replyTo'];
  reactions?: string[];
}
export interface PetConversationState {
  sessionId: string | null;
  title: string;
  revision: number;
  loading: boolean;
  running: boolean;
  messages: PetConversationMessage[];
  error?: string;
}
export interface PetComposerImport { name: string; mimeType: string; data: ArrayBuffer }
export interface PetComposerDraft { text: string; replyTo?: PetComposerSubmission['replyTo'] }
