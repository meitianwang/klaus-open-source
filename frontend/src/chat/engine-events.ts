import type { ComposerDocumentSnapshot } from './composer/document-model'
import type { ApprovalReview } from '../../../contracts/approval-review'
import type { ThreadGoal } from '../../../contracts/planning-goals'
import type { GoalTurnMetadata } from './goals/types'
import type { ProposedPlan, ProgressPlan } from './planning/types'
import type { FastModeMetadata } from '../../../shared/model-fast-mode'
import type { CursorModelMetadata } from '../../../shared/cursor-model-catalog'
import type { AntigravityModelMetadata } from '../../../shared/antigravity-model-catalog'
import type { TraeModelMetadata } from '../../../shared/trae-model-catalog'
import type { KiroModelMetadata } from '../../../shared/kiro-model-catalog'
// 引擎→渲染层 chat 事件契约与 chat 域领域实体。
//
// ChatEvent 各分支的字段以 klaus-shell 的发射面为权威（main.rs 的
// json!({ "type": … }) 家族、subagent_tasks.rs、engine.rs），消费面
// （chat.ts 分发 switch 与 stream-store 的 ingest）交叉核实；仍保留
// 接口但当前不发射的兼容分支（teammate/agent 生命周期、task_list、
// session_title_updated 等）按消费面标注，字段从宽为可选。
//
// 领域实体（SessionInfo / 队列项 / 子 agent 任务）同样对齐 Rust 侧
// 投影契约（map_engine_session_row 等）与 chat.ts 的本地构造点。

import type { ComposerReferenceToken } from './composer/reference-token'
import type { ProviderErrorDetails } from '../../../contracts/provider-error-details'
import type { InferenceSnapshot, ModelUpdateState } from '../../bridge/types'

// ---- 事件联合 ----

interface SessionScoped {
  sessionId: string
  inference?: InferenceSnapshot
}

export interface ProposedPlanEvent extends SessionScoped { type: 'proposed_plan'; phase: 'started' | 'updated' | 'completed'; plan: ProposedPlan }
export interface ProposedPlanDeltaEvent extends SessionScoped { type: 'proposed_plan_delta'; planId: string; turnId: string; revision: number; delta: string }
export interface ProgressPlanEvent extends SessionScoped { type: 'progress_plan'; progress: ProgressPlan }
export interface GoalCompletionEvent extends SessionScoped { type: 'goal_completion'; goal: ThreadGoal }
export interface TextDeltaEvent extends SessionScoped { type: 'text_delta'; text: string; messageId?: string; phase?: 'commentary' | 'partial_answer' | 'final_answer' }
export interface ThinkingDeltaEvent extends SessionScoped { type: 'thinking_delta'; thinking: string }
export interface StreamModeEvent extends SessionScoped, GoalTurnMetadata { type: 'stream_mode'; mode: 'requesting' | 'responding' | 'thinking' | 'tool-use' | 'idle' | string; turnId?: string }
// The engine turn lifecycle's own word for whether the
// session is running. `active` opens a turn under the id the engine named; `idle` settles it.
export interface SessionRuntimeStatusEvent extends SessionScoped, GoalTurnMetadata {
  type: 'session_runtime_status'
  source?: 'turn' | 'session'
  status: 'active' | 'idle' | 'notLoaded'
  turnId: string | null
  activeFlags?: string[]
  clientMessageId?: string
  startedAtMs?: number
}
export interface ModelUpdateEvent extends SessionScoped, ModelUpdateState { type: 'model_update' }
export interface ToolStartEvent extends SessionScoped { type: 'tool_start'; toolName: string; toolCallId: string; args: unknown }
export interface ToolInputDeltaEvent extends SessionScoped { type: 'tool_input_delta'; toolCallId: string; delta: string }
export interface VisualArtifactEvent { kind: 'diagram' | 'model3d' | 'prototype' | 'ppt'; id: string; title: string; ready?: boolean }
export interface ToolEndEvent extends SessionScoped {
  type: 'tool_end'
  toolCallId: string
  toolName?: string
  isError?: boolean
  content?: unknown
  artifact?: VisualArtifactEvent
  // 媒体产物（生图类 dynamic tool）：shell 已把字节落进内容寻址池，这里只
  // 带 path；base64 不上事件（否则一张图就是一大坨 base64 涌进渲染层）。
  media?: Array<{ path: string; mimeType?: string; sourcePath?: string }>
  // background task 通道（task 工具的后台收尾）在 result 上带产物。
  result?: unknown
}
export interface ProgressEvent extends SessionScoped { type: 'progress'; toolName: string; toolCallId: string; content: string }
export interface ApprovalReviewStrictRequiredEvent extends SessionScoped { type: 'approval_review_strict_required'; turnId: string; startedAtMs: number }
export interface ApprovalReviewWarningEvent extends SessionScoped { type: 'approval_review_warning'; message: string; kind?: string }
export interface ApprovalReviewEvent extends SessionScoped { type: 'approval_review'; review: ApprovalReview; rawReview?: Record<string, unknown> }
export interface NoticeEvent extends SessionScoped { type: 'notice'; content: string; code?: string; noticeId?: string }
export interface NoticeRetractEvent extends SessionScoped { type: 'notice_retract'; noticeId: string }
// One edit, in the shape the engine measured it in. Line counts are null when
// the engine had no baseline to measure against, and must stay null: folding
// them to 0 reports a volume nothing stands behind.
export interface DiffUpdateEvent extends SessionScoped {
  type: 'diff_update'
  turnId?: string | null
  changes: Array<{ path?: string | null; kind?: string | null; added?: number | null; removed?: number | null }>
}
export interface TurnUsage {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}
// Per-turn token totals for the overview's usage row. Separate from `done`
// because the driver drops `done` under `emitDone: false`, so usage rides its
// own frame off raw turn.completed.
export interface TurnUsageEvent extends SessionScoped { type: 'turn_usage'; usage: TurnUsage; stopReason?: string }
// A COMPLETED auto-memory / auto-dream pass that touched files. A failed pass
// is a transcript notice instead; this frame only reports writes.
export interface MemoryWriteEvent extends SessionScoped {
  type: 'memory_write'
  kind: string
  runId: string
  filesTouched: string[]
  turnCount?: number
  summary?: string
}
// An extension point that did not run: a hook command failed, a plugin failed to
// load, a skill was skipped. Its own event rather than a transcript notice,
// because a notice scrolls away while a broken extension stays broken.
export interface ExtensionFailureEvent extends SessionScoped {
  type: 'extension_failure'
  kind: 'hook' | 'plugin' | 'skill'
  id: string
  message: string
  scope?: string
}
export interface DoneEvent extends SessionScoped { type: 'done'; usage?: TurnUsage; stopReason?: string; turnId?: string }
export interface InterruptedEvent extends SessionScoped { type: 'interrupted'; turnId?: string }
export interface ApiErrorEvent extends SessionScoped {
  type: 'api_error'
  error: string
  kind?: string
  turnId?: string
  terminal?: boolean
  status?: number
  requestId?: string
  retryAfterMs?: number
  providerCode?: string
  providerType?: string
  errorDetails?: ProviderErrorDetails
}
export interface ApiRetryEvent extends SessionScoped { type: 'api_retry'; attempt: number; maxRetries: number; kind?: string }
export interface AuthRequiredEvent extends SessionScoped { type: 'auth_required'; reason: string }
export interface MessageCompleteEvent extends SessionScoped { type: 'message_complete'; messageId?: string; phase?: 'commentary' | 'partial_answer' | 'final_answer' }
export interface QueueSnapshotEvent extends SessionScoped {
  type: 'queue_snapshot'
  revision: number
  items: RustQueueSnapshotItem[]
  status: 'authoritative' | 'persistence-failed' | null
  error?: string
}
export interface FollowUpStatusEvent extends SessionScoped {
  type: 'follow_up_status'
  messageId: string
  text: string
  state: 'engine_queued' | 'pending' | 'unconfirmed' | 'applied' | 'failed' | 'removed'
  reason?: string
  error?: string
  /**
   * Present on `applied` for a cross-conversation delivery only: the envelope
   * the engine drained into the turn's last tool result. The live tool card
   * never sees that append (the tool's terminal event precedes the drain), so
   * the store inserts the delegation bubble from this payload instead.
   */
  delegation?: { input: string; sourceThreadId: string | null; sourceHostId?: string }
}
/** One row of the host-owned follow-up queue, as it comes back over the wire. */
export interface ClientQueueWireRow {
  id: string
  unconfirmed?: boolean
  /** Present when delivery failed or the user interrupted the run. */
  pausedReason?: string | null
  /** True between the host claiming the row and the engine admitting its turn. */
  dispatching?: boolean
  createdAt?: number
  /** The renderer's own outgoing payload, stored verbatim by the host. */
  item: Record<string, unknown>
}
/**
 * The host's authoritative client-queue snapshot.
 *
 * Published after every queue mutation and after a dispatch settles, so the
 * renderer treats it as the only source of truth instead of keeping a parallel
 * copy that could drift from what will actually be sent.
 */
export interface ClientQueueSnapshotEvent extends SessionScoped {
  type: 'client_queue_snapshot'
  revision: number
  items: ClientQueueWireRow[]
}
/**
 * The host started a queued message as an ordinary new turn.
 *
 * The renderer draws its user bubble optimistically only when IT sends; a queued
 * message the host dispatches after the turn ended needs the same bubble, with
 * the display metadata the row was stored with.
 */
export interface QueuedFollowUpDispatchedEvent extends SessionScoped {
  type: 'queued_follow_up_dispatched'
  id: string
  messageId?: string
  item: Record<string, unknown>
}
/** One stored queued message, normalized from its wire row. */
export interface ClientQueueRow {
  id: string
  unconfirmed?: boolean
  /** Non-null when delivery failed or the user interrupted the run. */
  pausedReason: string | null
  /** True between the host claiming the row and the engine admitting its turn. */
  dispatching: boolean
  createdAt: number
  /** The renderer's own outgoing payload, stored verbatim by the host. */
  item: FollowUpQueueItem
}
/** The host's queue state for one session, as the renderer caches it. */
export interface ClientQueueSnapshot {
  revision: number
  /** True when a user interruption paused the queue and Resume is offered. */
  interrupted: boolean
  rows: ClientQueueRow[]
}
export interface CompactionStartEvent extends SessionScoped { type: 'compaction_start'; trigger: 'manual' | 'auto' | string }
export interface CompactBoundaryEvent extends SessionScoped {
  type: 'compact_boundary'
  summaryText?: string | null
  summaryUuid?: string | null
  trigger?: string
}
export interface CompactionEndEvent extends SessionScoped { type: 'compaction_end' }
export interface CompactionErrorEvent extends SessionScoped { type: 'compaction_error'; error: string }
export interface PermissionCancelledEvent extends SessionScoped { type: 'permission_cancelled'; requestId: string }
export interface ElicitCancelledEvent extends SessionScoped { type: 'elicit_cancelled'; requestId: string }
export interface WorkspaceChangedEvent extends SessionScoped { type: 'workspace:changed' }
export interface WorkspaceInvalidatedEvent extends SessionScoped { type: 'workspace:invalidated' }
export interface TasksChangedEvent extends SessionScoped { type: 'tasks_changed'; tasks: Record<string, AgentTask> }
export interface AgentProgressEvent extends SessionScoped { type: 'agent_progress'; agentId: string; parentAgentId?: string; spawnTurnId?: string; depth?: number; toolUseId?: string; label?: string; event?: unknown }
export interface AgentNotification {
  notificationId: string
  source: 'background-task' | 'team-mailbox'
  status: 'updated' | 'completed' | 'failed' | 'cancelled'
  agentId?: string
  agentName?: string
  taskId?: string
  timestamp?: number
  turnId?: string
}
export interface AgentNotificationEvent extends SessionScoped, AgentNotification { type: 'agent_notification' }
// Channel 起源的 user 回合：外层包引擎消息信封（store 读 message.message.content）。
// localRender 是宿主随帧下发的显示快照，与历史回放从引擎元数据行恢复的是同一份。
export interface UserMessageEvent extends SessionScoped {
  type: 'user_message'
  message?: { message?: { content?: unknown; localRender?: unknown }; timestamp?: string; uuid?: string }
}
export interface HeartbeatEvent { type: 'heartbeat'; n: number; sessionId?: undefined }

// Host pushes this after either the fallback or AI title is persisted, so the
// sidebar does not wait for a later session-list refresh.
export interface SessionTitleUpdatedEvent extends SessionScoped { type: 'session_title_updated'; title: string }
export interface SessionRecencyUpdatedEvent extends SessionScoped { type: 'session_recency_updated' }

export interface TaskListEvent extends SessionScoped {
  type: 'task_list'
  planId?: string
  planKind?: 'plan' | 'tasks'
  available?: boolean
  taskListId?: string
  generation?: string
  revision?: number
  fingerprint?: string
  tasks?: unknown[]
  cursor?: string | null
  total?: number
  status?: string
  notice?: string
}
export interface SpecModeChangedEvent extends SessionScoped { type: 'spec_mode_changed'; enabled: boolean }

// -- 兼容分支：接口保留、当前发射面沉默；字段按渲染层消费面从宽标注。 --
export interface TeammateMessagesEvent extends SessionScoped { type: 'teammate_messages'; taskId: string; messages: unknown[] }
export interface TeammateSpawnedEvent extends SessionScoped { type: 'teammate_spawned'; taskId?: string; agentName?: string }
export interface AgentDoneEvent extends SessionScoped { type: 'agent_done'; agentId?: string }
export interface TeamCreatedEvent extends SessionScoped { type: 'team_created'; teamName: string }
export interface ContextCollapseStatsEvent extends SessionScoped { type: 'context_collapse_stats'; collapsedSpans?: number; stagedSpans?: number }
export interface TombstoneEvent extends SessionScoped { type: 'tombstone' }
export interface FileEvent extends SessionScoped { type: 'file'; data?: string; filename?: string; mimeType?: string }
export interface McpAuthUrlEvent extends SessionScoped { type: 'mcp_auth_url'; serverName?: string; url?: string }
export interface OrchestratorFallbackEvent extends SessionScoped {
  type: 'orchestrator_fallback'
  turnId?: string
  failedModel?: string
  mainModel?: string
  reason?: string
}

export type ChatEvent =
  | ProposedPlanEvent
  | ProposedPlanDeltaEvent
  | ProgressPlanEvent
  | GoalCompletionEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | StreamModeEvent
  | ModelUpdateEvent
  | ToolStartEvent
  | ToolInputDeltaEvent
  | ToolEndEvent
  | ProgressEvent
  | NoticeEvent
  | NoticeRetractEvent
  | ApprovalReviewEvent
  | ApprovalReviewStrictRequiredEvent
  | ApprovalReviewWarningEvent
  | DiffUpdateEvent
  | TurnUsageEvent
  | MemoryWriteEvent
  | ExtensionFailureEvent
  | DoneEvent
  | InterruptedEvent
  | ApiErrorEvent
  | ApiRetryEvent
  | AuthRequiredEvent
  | MessageCompleteEvent
  | QueueSnapshotEvent
  | FollowUpStatusEvent
  | ClientQueueSnapshotEvent
  | QueuedFollowUpDispatchedEvent
  | CompactionStartEvent
  | CompactBoundaryEvent
  | CompactionEndEvent
  | CompactionErrorEvent
  | PermissionCancelledEvent
  | ElicitCancelledEvent
  | WorkspaceChangedEvent
  | WorkspaceInvalidatedEvent
  | TasksChangedEvent
  | AgentProgressEvent
  | AgentNotificationEvent
  | UserMessageEvent
  | HeartbeatEvent
  | SessionTitleUpdatedEvent
  | SessionRecencyUpdatedEvent
  | TaskListEvent
  | SpecModeChangedEvent
  | TeammateMessagesEvent
  | TeammateSpawnedEvent
  | AgentDoneEvent
  | TeamCreatedEvent
  | ContextCollapseStatsEvent
  | TombstoneEvent
  | FileEvent
  | McpAuthUrlEvent
  | OrchestratorFallbackEvent
  | SessionRuntimeStatusEvent

// ---- 领域实体 ----

// session:list / session:new 行投影（engine.rs map_engine_session_row 契约）。
export interface SessionInfo {
  id: string
  title: string
  createdAt?: number
  updatedAt: number
  workdir?: string | null
  // Multi-folder workspace id this session is bound to (engine.rs carries it
  // only for workspace-bound sessions). Drives the sidebar's workspace grouping;
  // absent means a projectless / single-project session.
  workspaceId?: string | null
  // Project this conversation belongs to, locked at creation and independent of
  // the directory it runs in: a worktree session carries its
  // origin repository here so the sidebar files it under that project.
  projectRoot?: string | null
  isWorking?: boolean
  archived?: boolean
  role?: string
  parentSessionId?: string | null
  forkedFrom?: { sessionId: string; threadId: string; title?: string } | null
  threadSource?: 'automation' | string | null
  goalPursuitEligible?: boolean
  /** The friendship a friend task conversation belongs to; the sidebar files
   *  the conversation under that friend's folder. Absent for ordinary chats. */
  friendGroupId?: string | null
  hostMetadata?: { delegatedFrom?: string; threadSource?: string; friendTask?: { taskId: string; mode: 'manual' | 'auto-edit' | 'scoped-auto' } }
  automation?: {
    taskId: string
    taskName?: string | null
    runId?: number | null
    triggerType?: string | null
  } | null
  sidebarPinnedAt?: number | null
  // 侧任务登记面补充的字段（shell registry 侧带入）。
  expiresAt?: number
}

// queue_snapshot.items 的原始元素（shell install_queue_snapshot 投影）。
export interface RustQueueSnapshotItem {
  state?: 'pending' | 'reserved' | string
  mutable?: boolean
  message?: {
    uuid?: string
    delivery?: 'user' | 'delegation'
    value?: unknown
    mode?: string
    priority?: string
    agentId?: string
    agent_id?: string
    isMeta?: boolean
    is_meta?: boolean
  }
}

// 渲染层 follow-up 队列项：本地乐观项与引擎队列项共用一个形状
//（mapRustQueueSnapshotItem / queueFollowUp 两个构造点的并集）。
export interface FollowUpQueueItem {
  clientMessageId?: string
  friendDispatchId?: string;
  friendIntent?: 'request' | 'notice';
  friendReplyToMessageId?: string;
  friendSupplementToRequestId?: string;
  friendQuestionId?: string;
  friendAnswersRequestId?: string;
  id: string
  source?: 'rust' | 'local-follow-up' | string
  rustUuid?: string
  displayText: string
  finalText: string
  text?: string
  media: unknown[]
  liveAttachments: Array<{ type?: string; name?: string; src?: string; path?: string; mimeType?: string }>
  engineQueued?: boolean
  followUpState?: string
  state?: string
  mutable?: boolean
  editing?: boolean
  /** 本地队列行发送失败后的 paused 原因；存在时行显示 Retry。 */
  pausedReason?: string
  mode?: string
  priority?: string
  sentSlashCommand?: SlashCommandInfo | null
  composerReferences?: ComposerReferenceToken[]
  composerDocument?: ComposerDocumentSnapshot
  pastedCards?: unknown[]
  selectedTextAttachments?: unknown[]
  /**
   * The bubble's display projection, stored with the row so the host can replay
   * it when the queued message is dispatched later. Computed by the same
   * `sentUserDisplayMetadata` that a direct send passes to `chat.send`.
   */
  displayMetadata?: unknown
}

// tasksBySession 值：tasks_changed 快照与持久化 loadTasks 的并集形状。
export interface AgentTask {
  parentAgentId?: string
  depth?: number
  agentId?: string
  avatarId?: number
  agentName?: string
  agentType?: 'fork' | 'background' | string
  type?: 'in_process_teammate' | string
  description?: string
  objective?: string
  statusSummary?: string
  color?: string
  status?: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'killed' | 'cancelled' | string
  // The concrete model this child run resolved to at spawn time, stamped by
  // the engine onto its lifecycle row. Absent for rows saved before the
  // stamp existed and for spawns whose inference bundle never resolved.
  model?: string
  // The model mode (source) the resolved model belongs to, when the engine
  // attribution named one.
  modelSource?: string
  isIdle?: boolean
  isBackground?: boolean
  notified?: boolean
  // Turn that first revealed this task. Late lifecycle notices (a child settled
  // after its parent turn ended) anchor back to it instead of inventing a
  // per-agent pseudo turn, so inline subagent rows stay at their parent turn.
  spawnTurnId?: string
  // Renderer proof of a new child turn, separate from the engine's lifecycle clock.
  streamTurnId?: string
  streamStartedFromLifecycleVersion?: number
  startedAtMs?: number
  updatedAtMs?: number
  completedAtMs?: number
  lifecycleUpdatedAtMs?: number
  recencyAtMs?: number
  lastAssistantMessageAtMs?: number
  diffStats?: { linesAdded?: number; linesRemoved?: number }
  messages?: unknown[]
  [key: string]: unknown
}

// engine.slashCommands 行（harness fixture 与引擎发现层一致）。
export interface SlashCommandInfo {
  name: string
  displayName?: string
  description?: string
  kind?: string
  type?: string
  scope?: string
  argumentHint?: string
  [key: string]: unknown
}

// Composer attachment rows. Uploads acquire uploadPath asynchronously; pasted
// text, quotes, and imported paths use a lightweight File-shaped descriptor.
export interface PendingFileEntry {
  appshotContext?: import('../../../contracts/desktop-pet-composer').PetAppshotContext;
  file: File | { name: string; type: string; size: number }
  uploading: boolean
  uploadPath?: string | null
  objectUrl?: string | null
  uploadId?: string
  kind?: string
  text?: string
  previewText?: string
  lineCount?: number
  /** Large pastes reference a host-owned file; the character count rides with
   *  the reference so cards can show it without reading the file back. */
  characterCount?: number
  specAnnotation?: { sessionId: string; path: string; content: string; comment: string; startOffset?: number; endOffset?: number; anchorText?: string }
  sourcePath?: unknown
  error?: boolean
  quoteId?: string
  range?: { start: number; end: number }
  requestOffset?: number
  composerOffset?: number
  displayOrder?: number
}

// 定时任务行（cron.rs cron_tasks 表投影）与其运行记录。
export interface CronTask {
  id: string
  name?: string | null
  schedule: string
  prompt?: string
  enabled: boolean
  deleteAfterRun?: boolean
  channelBinding?: { channelId?: string; chatType?: string; label?: string; targetId?: string } | null
  [key: string]: unknown
}

export interface CronRun {
  taskId: string
  sessionId: string
  status?: string
  startedAt?: number
  [key: string]: unknown
}

// queue_snapshot 的会话级缓存条目（applyRustQueueSnapshot 归一化后）。
export interface RustQueueSnapshot {
  revision: number
  status: 'authoritative' | 'persistence-failed'
  error: string
  items: RustQueueSnapshotItem[]
}

// session.getMainModelOptions 的模型行（含档位元数据）。
export interface ModelOption extends CursorModelMetadata, AntigravityModelMetadata, TraeModelMetadata, KiroModelMetadata, FastModeMetadata {
  value?: string
  label?: string
  description?: string
  supportedThinkingLevels?: string[]
  defaultThinkingLevel?: string
  [key: string]: unknown
}

// workspace @mention 菜单消费的文件树节点（engine.workspaceTree 投影）。
export interface WorkspaceMentionNode {
  path?: string
  name?: string
  isDir?: boolean
  children?: WorkspaceMentionNode[]
}

// composer 已选 @mention 行（addWorkspaceComposerMention 构造）。


// buildOutgoingPayload 的产出：一次发送的完整载荷（乐观气泡 + IPC media）。
export interface OutgoingPayload {
  clientMessageId?: string
  friendDispatchId?: string;
  friendIntent?: 'request' | 'notice';
  friendReplyToMessageId?: string;
  friendSupplementToRequestId?: string;
  friendQuestionId?: string;
  friendAnswersRequestId?: string;
  text: string
  finalText: string
  displayText: string
  media: Array<{ type: string; path?: string | null; name?: string; fileName?: string; mimeType?: string }>
  liveAttachments: Array<{ type?: string; name?: string; src?: string; path?: string; mimeType?: string }>
  pastedCards: Array<{ path?: string; text?: string; preview?: string; previewText?: string; characterCount?: number; requestOffset?: number; displayOrder?: number }>
  selectedTextAttachments: Array<{ text: string; previewText: string; quoteId?: string; requestOffset?: number; displayOrder?: number }>
  sentSlashCommand: SlashCommandInfo | null
  composerReferences: ComposerReferenceToken[]
  composerDocument?: ComposerDocumentSnapshot
  createdAt: number
}

// 反馈/建议提交链路（debug report / suggestion）的附件与回执形状。
export interface FeedbackAttachment {
  name?: string
  path?: string
  size?: number
  kind?: string
  previewUrl?: string
  contentType?: string
}

export interface FeedbackEmailStatus {
  serverAccepted?: boolean
  sent?: boolean
  to?: string
  attempted?: boolean
  error?: string
  skippedReason?: string
}

export interface FeedbackSubmitResult {
  feedbackId?: string
  suggestionId?: string
  filePath?: string
  email?: FeedbackEmailStatus
}
