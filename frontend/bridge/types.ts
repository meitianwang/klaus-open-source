import type { CursorModelMetadata } from '../../shared/cursor-model-catalog'
import type { AntigravityModelMetadata } from '../../shared/antigravity-model-catalog'
import type { TraeModelMetadata } from '../../shared/trae-model-catalog'
import type { KiroModelMetadata } from '../../shared/kiro-model-catalog'
// Shapes the queue-mutation channels carry.
//
// The follow-up queue is edited optimistically in the UI and reconciled against
// the shell, so every mutation carries a `mutationId` the reply echoes back —
// that is what lets a stale reply be dropped instead of clobbering a newer edit.

export type QueuePriority = 'now' | 'next' | 'later'
export type { AsyncQuestionRequest, AsyncQuestionResolution, AsyncQuestionAnswerReply, AsyncUserQuestion, QuestionAnswerMetadata } from '../../contracts/async-questions'

export interface MainModelSelection {
  mode: string
  source: string
  resolvedMode: string | null
  resolutionError?: string | null
}

/** Non-secret attribution captured by the request, not by the model picker. */
export interface InferenceSnapshot {
  revision: number
  changeId?: string
  model: string
  source?: string
  tier?: string
  selection?: string
}

export interface ModelUpdateState {
  status: 'preparing' | 'ready' | 'failed'
  changeId: string
  preferenceRevision: number
  revision?: number
  error?: string
  // A sign-out-driven preparation failure settles quietly: the credential was
  // removed on purpose, so the failure is expected and stays out of the toast.
  quiet?: boolean
}

export type ModelTierName = 'high' | 'medium' | 'low'
export interface ModelTierReference { source: string; modelId: string }
export interface GlobalModelTierMapping {
  version: 1
  revision: number
  high: ModelTierReference | null
  medium: ModelTierReference | null
  low: ModelTierReference | null
  migration?: { source?: string; warning?: string }
}
export interface ModelTierOption extends CursorModelMetadata, AntigravityModelMetadata, TraeModelMetadata, KiroModelMetadata {
  modelId: string
  label: string
  description?: string
  available?: boolean
  reason?: string
  reasonCode?: string
  capabilities?: Record<string, unknown> | string[]
}
export interface ModelTierSourceOptions {
  source: string
  options: ModelTierOption[]
  status: 'ready' | 'unavailable' | 'error'
  reason?: string
  reasonCode?: string
}
export interface GlobalModelTierOptions {
  ok: true
  revision?: number
  sources: ModelTierSourceOptions[]
  tiers: Record<ModelTierName, { status: 'inherit' | 'ready' | 'unavailable'; label?: string; reason?: string }>
}
export interface GlobalModelTierReply { ok: true; mapping: GlobalModelTierMapping }

/** Auxiliary task models: an empty string follows the chat's main model. */
export interface FeatureModelSettings { title: string; prediction: string; memory: string; voiceRefinement: string }
export interface FeatureModelPatch { title?: string; prediction?: string; memory?: string; voiceRefinement?: string }
export interface FeatureModelsReply { ok: boolean; settings: FeatureModelSettings; error?: string }

export interface BrowserUseOpenRequest {
  sessionId?: string
  targetId?: string
  focusRevision?: number
}

export type ComputerUsePipAlignment = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export interface ComputerUsePipRect { x: number; y: number; width: number; height: number }
export interface ComputerUsePipAnchor {
  alignment: ComputerUsePipAlignment
  point: { x: number; y: number }
}
export interface ComputerUsePipState {
  revision: number
  supported: boolean
  activeTaskIds: string[]
  taskVisibilities: Record<string, 'shown' | 'hidden'>
  alwaysHidePictureInPicture: boolean
  maxDisplaySize: number
  zoomFactor?: number
  error?: string | null
  errorSessionId?: string | null
}
export interface ComputerUsePipHostLayout {
  hostId: 'klaus-main-thread'
  sessionId: string | null
  visible: boolean
  anchorRect: ComputerUsePipRect | null
  containerRect: ComputerUsePipRect | null
  anchors: ComputerUsePipAnchor[] | null
  anchorRects: Record<'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight', ComputerUsePipRect> | null
  animated: boolean
  devicePixelRatio: number
  isCodexHomeAvailable: boolean
  interactionPassthroughRect: null
  presentationScope: 'thread'
}
export interface ComputerUsePipVisibilityRequest {
  sessionId?: string
  scope: 'task' | 'all'
  visible: boolean
}

export type BackgroundProcessStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped'

export interface BackgroundProcessRecord {
  shellId: string
  taskId?: string
  command: string
  title?: string
  cwd: string
  pid?: number
  status: BackgroundProcessStatus
  startedAtMs?: number
  updatedAtMs?: number
  completedAtMs?: number
  exitCode?: number
  terminationSignal?: string
  failure?: string
  stopRequested?: boolean
  outputStartOffset?: number
  outputNextOffset?: number
  droppedBytes?: number
  outputAvailable?: boolean
}

export interface BackgroundProcessSnapshotReply {
  processes?: BackgroundProcessRecord[]
  backgroundProcesses?: { processes?: BackgroundProcessRecord[] }
}

export interface BackgroundProcessOutputReply {
  found: boolean
  output: string
  afterOffset: number
  nextOffset: number
  droppedBytes: number
  status?: BackgroundProcessStatus
  exitCode?: number
  eof: boolean
}

export interface BackgroundProcessStopReply {
  found: boolean
  accepted: boolean
  process?: BackgroundProcessRecord | null
}

export interface BackgroundProcessChangedPush {
  sessionId: string
  event: {
    subtype?: 'task_started' | 'task_progress' | 'task_notification' | 'task_updated' | 'background_tasks_changed'
    type?: string
    shellId?: string
    process?: BackgroundProcessRecord
    processes?: BackgroundProcessRecord[]
    output?: string
    afterOffset?: number
    nextOffset?: number
    droppedBytes?: number
  }
}

export type QueueInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
  | { type: 'document'; base64: string; mimeType: 'application/pdf'; filename?: string }
  | { type: 'media'; base64: string; mimeType: string; filename?: string }

export type QueueInput = string | QueueInputPart[]

export interface QueueEdit {
  value?: QueueInput
  mode?: string
  priority?: QueuePriority
}

export interface QueueEditRequest {
  uuid: string
  edit: QueueEdit
  mutationId: string
}

export interface QueueRemoveRequest {
  uuid: string
  mutationId: string
}

/**
 * A queue entry is addressed differently depending on where it lives: an entry
 * the engine already owns has a transcript uuid, one still only in the UI's
 * optimistic list has a local id.
 */
export type QueueItemRef =
  | { source: 'rust'; uuid: string }
  | { source: 'local-follow-up'; localId: string }

export interface QueueReorderRequest {
  item: QueueItemRef
  before: QueueItemRef | null
  mutationId: string
}

/**
 * Blender runtime provisioning state, pushed on `blender:install`.
 *
 * A ~350 MB download is the difference between "the panel opens" and "the panel
 * opens after a minute", so every stage is reported rather than leaving the user
 * staring at an empty viewport. `ready` carries the resolved path so the panel
 * can show which Blender it is driving — a system install and a managed one are
 * not the same thing to the user.
 */
export type BlenderInstallPush =
  | { state: 'missing'; reason?: string }
  | { state: 'downloading'; receivedBytes: number; totalBytes: number }
  | { state: 'extracting' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; path: string; managed: boolean; version?: string }
