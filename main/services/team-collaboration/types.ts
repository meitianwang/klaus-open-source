import type { CollaborationEvent, CollaborationExecution, CollaborationRequest, CollaborationResponse } from '../../../contracts/team-collaboration';
import type { Json } from '../../ipc/contract';
import type { SessionService } from '../../sessions/service';
import type { JsonObject } from '../service-types';

export interface LocalBinding { projectId: string; localFolder: string | null }
export type DesktopCollaborationResponse<T extends CollaborationRequest['type']> =
  T extends 'project-invitations.create' ? Omit<CollaborationResponse<T>, 'token'> : CollaborationResponse<T>;
export interface ProjectDraftPatch {
  name?: string;
  description?: string;
  repositoryUrl?: string | null;
  coverId?: string;
  coverIconId?: string;
}
export interface ProjectDraft { requestId: string; patch: ProjectDraftPatch; explanation: string }
export interface DraftAttachment { id: string; name: string; mimeType: string; size: number; base64: string }
export interface IssueDraftPatch {
  title?: string;
  description?: string;
  status?: 'backlog' | 'todo' | 'active' | 'review' | 'done' | 'cancelled';
  priority?: 'none' | 'urgent' | 'high' | 'medium' | 'low';
}
export interface IssueDraft { requestId: string; patch: IssueDraftPatch; reply: string }
export interface DraftOptions {
  requestId: string;
  model?: string;
  context?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  files?: Array<{ name: string; content: string }>;
  attachments?: DraftAttachment[];
  current?: ProjectDraftPatch;
  allowedCoverIds?: string[];
  allowedCoverIconIds?: string[];
}
export interface IssueDraftOptions extends Omit<DraftOptions, 'current' | 'allowedCoverIds' | 'allowedCoverIconIds'> { form: IssueDraftPatch }
export interface ExecuteOptions {
  projectId?: string | null;
  issueId?: string;
  issueVersion?: number;
  discussionId?: string;
  discussionVersion?: number;
  messageId?: string;
  agentId: string;
  idempotencyKey: string;
  localFolderConfirmed: true;
  prompt?: string;
  model?: string;
  workingDirectory?: string;
}
export interface ExecutionReply {
  execution: CollaborationExecution;
  sessionId: string | null;
  turnId: string | null;
}
export type CollaborationUpdate =
  | { kind: 'event'; accountId: string; projectId: string | null; event: CollaborationEvent }
  | { kind: 'connection'; accountId: string; projectId: string | null; state: 'connected' | 'reconnecting' | 'forbidden'; error?: string }
  | { kind: 'account'; accountId: string | null }
  | { kind: 'execution'; accountId: string; projectId: string | null; executionId: string; sessionId: string | null; turnId: string | null; status: CollaborationExecution['status']; syncPending: boolean };

export interface CollaborationAccount { id: string; token: string }
export interface TeamCollaborationDeps {
  configRoot: string;
  serverUrl: string;
  account(): CollaborationAccount | null;
  authorizationExpired(): Promise<void>;
  /** Server-controlled feature gate. When it returns false the whole surface
   *  is closed: IPC refuses and the background watch/reconcile stays idle.
   *  Defaults to enabled so unit fixtures exercise the product unchanged. */
  gateEnabled?(): boolean;
  fetch?: typeof fetch;
  push(channel: 'collaboration:updated', value: Json): void;
  pickDirectory(): Promise<string | null>;
  saveFile(name: string, bytes: Uint8Array, assertCurrent: () => void): Promise<boolean>;
  sessions: Pick<SessionService, 'newSession' | 'sideQuestion' | 'cancelSideQuestion' | 'deleteSession' | 'sendAndWait' | 'interrupt'>;
  bindSessionDirectory(sessionId: string, directory: string): void;
  configureSessionModel(sessionId: string, model: string): void | Promise<void>;
  modelOptions(source?: string): Promise<Json[]>;
  agentDefinitions(): Promise<JsonObject[]>;
  rendererId(engineId: string): string | undefined;
  log(message: string): void;
  requestTimeoutMs?: number;
  reconnectMs?: number;
  streamIdleMs?: number;
  draftTimeoutMs?: number;
  reconcileMs?: number;
}
