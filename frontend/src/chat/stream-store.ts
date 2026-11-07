import { forgetApprovalReviewSession, replaceApprovalReviewHistory, type DeniedApprovalReview } from './approval-review-state'
import { ByteBudgetLru, retainedBytes } from './byte-budget'
import { mergeSubmittedUserHistory } from './transcript-user-handoff'
import { retireMarkdownRuntime } from './markdown-async'
import { approvalReview, approvalReviewEvent, type ApprovalReview } from '../../../contracts/approval-review'
import { planningQuestionHistoryOwns } from './planning/question-history'
import { beginTaskTurn, isTaskMutationTool, resetTaskContinuation, syncTaskGoal } from './task-state'
import type { GoalSnapshot } from './goals'
import type { PlanningQuestionRequest } from './planning/questions-state'
import type { PlanningSnapshot, ProposedPlan } from './planning/types'
import type { QuestionDraft } from './transcript/question-state'
import { EMPTY_ASYNC_QUESTIONS, expireAsyncQuestions, receiveAsyncQuestion, rememberAsyncQuestionResolution, reopenAsyncQuestions, resolveAsyncQuestion, type AsyncQuestionRequest, type AsyncQuestionUi } from './transcript/async-question-state'
import { activityShellResult } from './transcript/activity-tool-model'
import { normalizeVisualArtifact, type VisualArtifact } from './transcript/factories'
import type { AgentTask } from './engine-events'
import { providerErrorDetails, providerErrorTextWithRequestId, type ProviderErrorDetails } from '../../../contracts/provider-error-details'
import type { InferenceSnapshot, ModelUpdateState } from '../../bridge/types'
import type { InlineVisFragment } from '../../../contracts/inline-visualization'
import { inferenceSnapshot, nextModelUpdate } from './model-inference'
import { agentNotificationActivity, agentTaskName, agentTerminalStatus, isVisibleAgentActivity, mergeAgentActivityRecords, mergeAgentTimeline, resolveAgentActivityTask, sameAgentActivity, subagentStreamId, type AgentEventStatus, type AgentTimelineRecord } from './subagent-stream'
import { preserveAgentLifecycle } from './agent-status'
import { coalesceSubagentTaskAliases } from './subagent-navigation'
import { ensureArtifactsForSession, retireArtifactsForSession } from './overview/artifacts'
import { retireTranscriptViewport } from './transcript/viewport-state'
import { retireEndResources } from './end-resources'
import { retainSavedHistoryItems, type SavedHistoryViewport } from './saved-history-retention'
import { fetchTurnItemsPage, loadFirstPaint, loadOlderTurnsPage, type FirstPaintResult, type TranscriptPaginationState, type TranscriptTurnShell } from './transcript-pagination'
import { commitOlderTurns, commitSavedSnapshot, commitTurnItems, ownsSavedBoundary, patchSavedTurn, savedBoundary, savedPagination, savedRowId, savedRows, savedShells, savedTurn, savedTurns, type SavedTranscript, type TurnBoundaryRequest, type TurnItemsPagination } from './saved-transcript'
import { peekRewindCut, rememberRewindCut, replyWithoutRewoundTail, rewindCutFor, savedTranscriptWithoutTurns, sessionWithoutRewoundTail, settleRewindCut, unitsBeforeRewind } from './rewind-tail'
// Chat 流式状态 store（Batch 4 架构核心）：引擎事件 → store → 组件订阅，
// 替换 chat.js 的手动 DOM diff。chat.js 的 chatEvent handler 头部把每个事件
// 转发进 ingestChatEvent（含 userInterrupted 上下文）；React transcript 渲染
// history 层 + liveUnits 序列（本回合在途单元流），与旧 DOM 管线逐字节对照。
//
// liveUnits 是回合内的有序单元流（text 块/工具容器/notice/error/file/plan/
// diff/user/thinking-done 穿插），与历史 units 同构——渲染层共用同一组件族。
// done 后 liveUnits 保留至 history 重拉完成（live→history 移交，避免闪空）。
import { createStreamFrameQueue, createTransactionalStore } from './stream-batching'
import { useStore } from 'zustand'
import { t } from '../i18n'

export interface ToolCardState {
  toolCallId: string
  inference?: InferenceSnapshot
  toolName: string
  args: unknown
  argsDelta: string
  progress: unknown[]
  // awaiting-approval：调用已发起但停在权限审批上，此刻什么都没在跑。tool_start
  // 先于引擎的权限判定发出，所以这一行会先出现、再被审批挂住；审批给出结果后回
  // 到 running，终态仍由 tool_end 决定。
  status: 'running' | 'awaiting-approval' | 'ok' | 'error' | 'interrupted'
  // The failing result landed inside the stop window, so the row is shown as
  // stopped straight away rather than flashing a red failure. The Turn's own
  // terminal event settles it: `interrupted` keeps it, `done` puts the failure
  // back, because a Turn that finished on its own never stopped anything.
  stopWindowFailure?: boolean
  content?: string
  startedAtMs?: number
  durationMs?: number
  exitCode?: number
  // 产物图的 path（内容寻址池）：当轮就要能看到图，不能等到回合结束
  // 后的 history 重拉。
  media?: Array<{ path: string; mimeType?: string; sourcePath?: string }>
  artifact?: VisualArtifact
  agent: boolean
  bgTask: boolean
}

type LiveUnitValue =
  | { type: 'live-goal-completion'; key: string; goal: GoalSnapshot }
  | { type: 'live-planning-question'; key: string; request: PlanningQuestionRequest }
  | { type: 'live-proposed-plan'; key: string; plan: ProposedPlan }
  | ({ type: 'live-agent-event' } & AgentTimelineRecord)
  | { type: 'live-compaction'; key: string; trigger: string; state: 'running' | 'completed' }
  // turnTail：done 时本轮最后一段 assistant text 挂操作栏（attachCopyToTurnTail）
  // 与 klaus 引擎的本回合用量/停止原因（appendTurnUsageMeta，无 usage 为 null）。
  | { type: 'live-text'; key: string; text: string; streaming: boolean; messageId?: string; startedAtMs?: number; phase?: 'commentary' | 'final_answer'; inlineVis?: InlineVisFragment[]; turnTail?: { ts: number; meta: null | { turnTokens: number; usage: any; stopReason: string } }; aborted?: boolean }
  | { type: 'live-tools'; key: string; order: string[]; sealed: boolean }
  | { type: 'live-thinking-done'; key: string; text: string; elapsedSeconds: number }
  | { type: 'live-approval-review-notice'; key: string; kind: 'strictReviewRequired' | 'tooManyDenials'; startedAtMs: number }
  | { type: 'live-approval-review'; key: string; review: ApprovalReview; rawReview?: Record<string, unknown>; rawReviewAuthoritative?: boolean }
  | { type: 'live-notice'; key: string; text: string }
  | { type: 'live-retry'; key: string; attempt: number; maxRetries: number; phase?: string }
  | { type: 'live-congestion'; key: string; kind: string }
  | { type: 'live-error'; key: string; text: string; submissionUuid?: string; kind?: string; retryAfterMs?: number; errorDetails?: ProviderErrorDetails }
  | { type: 'live-file'; key: string; name: string; url: string }
  | { type: 'live-user'; key: string; msg: any }
  // 鉴权缺失行动卡（auth_required 事件）。
  | { type: 'live-auth'; key: string; reason: string; mode: string }
  // Turn terminal status belongs to the active Turn, not to a detached system message.
  | { type: 'live-turn-status'; key: string; turnId: string | null; startedAt: number; finishedAt: number; userInitiated: boolean }
  // live 审批卡族（permission:request / elicit:request 回调挂卡）：resolved
  // 携带终态文案信息，卡体降为只读。startedAt 供等待正计时。
  | { type: 'live-permission'; key: string; req: any; startedAt: number; resolved: null | { decision: string; allowSession: boolean; savedRules: boolean } }
  | { type: 'live-plan-review'; key: string; req: any; startedAt: number; resolved: null | { decision: string } }
  // 执行方式二选一（suggest_execution_mode 经 elicitation 通道）：选 Spec=引擎进
  // plan 模式，选直接执行=照常干。征询而非权限审批，故不受权限模式吞并。
  | { type: 'live-execution-mode'; key: string; req: any; startedAt: number; resolved: null | { decision: string } }
  | { type: 'live-elicit'; key: string; req: any; resolved: null | 'submitted' | 'declined' | 'cancelled' }
  | { type: 'live-ask'; key: string; req: any; draft?: QuestionDraft; resolved: null | { mode: 'submitted' | 'skipped'; answers: Record<string, string> } }
  // A cross-conversation steer drained into the RUNNING turn. The engine appends
  // the envelope to the turn's last tool result, which happens after that call's
  // terminal event, so the live tool card can never carry it; the host's applied
  // verdict (follow_up_status.delegation) is the only frame that knows the
  // message landed. Appended at the stream tail, i.e. at its arrival position,
  // so a message steered in mid-turn shows where it arrived.
  | { type: 'live-delegation'; key: string; messageId: string; delegation: { input: string; sourceThreadId: string | null; sourceHostId?: string } }

export type LiveUnit = LiveUnitValue & { turnId?: string; inference?: InferenceSnapshot; pendingUserTurn?: string; goalCompletion?: import('./transcript/goal-completion').GoalCompletionSummary }

function detailsForApiError(event: Record<string, unknown>): ProviderErrorDetails {
  const message = String(event.error ?? '').trim()
  const flat = Object.fromEntries(['kind', 'code', 'status', 'requestId', 'retryAfterMs', 'providerCode', 'providerType', 'providerError', 'recoveryReason']
    .filter(key => event[key] !== undefined).map(key => [key, event[key]]))
  return providerErrorDetails(event.errorDetails) ?? providerErrorDetails({ ...flat, message }) ?? { message }
}

export interface SessionStreamState {
  /** Renderer-only previews must never query the host under their temporary identity. */
  provisional: boolean
  asyncQuestions: AsyncQuestionUi
  agentTasks: Record<string, AgentTask>
  agentTimeline: AgentTimelineRecord[]
  running: boolean
  goalContinuationId: string | null
  streamMode: 'idle' | 'requesting' | 'responding' | 'tool-use'
  currentInference: InferenceSnapshot | null
  modelUpdate: ModelUpdateState | null
  liveUnits: LiveUnit[]
  liveRevision: number
  tools: Record<string, ToolCardState>
  // thinking live 盒（未收口的思考流）。
  thinkingActive: boolean
  thinkingText: string
  thinkingStartTime: number
  thinkingRequestStart: number
  // turn-activity 三点脉冲（显式状态，转移点对齐旧 show/hide 调用位）。
  activityVisible: boolean
  // compaction 乐观 loading pill（对齐旧 compactCacheStartMarker 的尾部标记）：
  // 非空 = 尾部合成 isCompactionStart 条目（trigger 文案）；boundary/error 清。
  compactionPendingTrigger: string | null
  // Worktree-mode init status: the transcript's
  // persistent top row. null = this session never went through worktree
  // creation. The engine does not persist the record, so after a reload the
  // render layer derives the settled row from the session workdir instead.
  worktreeInit: { status: 'running' | 'completed' | 'failed' } | null
  title: string | null
  // Authoritative transcript history: null until first load. A stale snapshot
  // remains visible while the complete saved projection reloads in the background.
  history: any[] | null
  // Ephemeral endpoints have no saved rollout; their live snapshot owns replay.
  historySource: 'saved' | 'ephemeral'
  historyStale: boolean
  historyLoading: boolean
  // Last full history read failed. The auto page-up state machine stops while
  // this is set and the transcript shows a retry callout instead.
  historyLoadFailed: boolean
  historyRetry: 'snapshot' | 'turns' | null
  historyGeneration: number
  savedTranscript: SavedTranscript | null
  supportsSavedItemAnchors: boolean
  // Renderer-driven saved-transcript pagination: the loaded turn window, the
  // cursor of the next older page, and the shells of turns whose messages have
  // not been fetched yet. Null until the first page lands.
  turnsPagination: TranscriptPaginationState | null
  turnShells: Record<string, TranscriptTurnShell>
  // The fetched turn window's rows, oldest-first, before any live-layer merge:
  // an older page prepends to this and the merged view is republished.
  loadedRows: any[] | null
  // live 层当前持有内容的起点序号（空→非空时打点，清空时复位到 +∞）。
  // 两层不重叠的判据：一次 history 读取的序号大于它，说明这些 live 内容引擎
  // 已经落盘、读回来的 history 覆盖它们；小于它则该读取早于本回合，两层无交集。
  liveStartSeq: number
  // The active Turn's identity, start time, and a pending user stop request.
  // Rendering only transitions to its terminal state when the engine emits
  // `interrupted`.
  activeTurnId: string | null
  // Retained while the completed live layer is awaiting its history handoff.
  liveTurnId: string | null
  // Turn ids in the order this session observed them. Saved pages and live
  // units merge against this one sequence, so a Turn that history has already
  // taken over still anchors Turns that exist only in the live layer.
  turnSequence: string[]
  // Once interrupted, the live layer keeps that Turn's partial output: the engine
  // never persisted it, so a history read would silently replace it with less.
  // `turnId` is null only when the engine settled the Turn without naming it.
  interruptedLiveTurn: { turnId: string | null } | null
  // The most recent Turn terminal event seen live. This lets the composer react
  // before the asynchronous history reload returns, while history remains the
  // durable source after a session is reopened.
  lastTerminalStatus: 'completed' | 'interrupted' | 'failed' | null
  turnStartedAt: number
  stopRequestedAt: number | null
  // 每个 turn 的终端状态（completed/interrupted/failed），随 history 一起返回。
  turnStatuses: Record<string, string>
  // Absolute per-Turn clocks returned by session/history. The user row uses the
  // start time; the final assistant row uses the terminal time.
  turnStartedAtMs: Record<string, number>
  /** Local input acceptance and first final-text arrival survive history handoff. */
  turnWorkStartedAtMs: Record<string, number>
  turnWorkCompletedAtMs: Record<string, number>
  turnFinishedAtMs: Record<string, number>
  // Turn terminal elapsed time in milliseconds, supplied by history for resumed
  // Turns and used to preserve the same status label after a reload.
  turnDurations: Record<string, number>
  turnErrors: Record<string, string>
  // failed turn 的归一化 provider 错误 kind（turnId -> kind），随 history 一起
  // 返回；失败标记按它本地化文案，原始文案降级为细节行。
  turnErrorKinds: Record<string, string>
  turnErrorDetails: Record<string, ProviderErrorDetails>
  // Turn id -> the tool call ids that Turn's abort killed. A stopped call and a
  // genuine failure both come back from history as errors, so this is what keeps
  // a reopened transcript from painting the user's stop as a red tool failure.
  turnCancelledTools: Record<string, string[]>
  // Explicit per-Turn collapse choices. A missing key follows the automatic
  // policy; true means collapsed and false means expanded. This must remain
  // tri-state because active subagents prevent automatic collapse without
  // overriding a choice the user already made.
  turnCollapseOverrides: Record<string, boolean>
}

export interface CollapseStats {
  collapsedSpans: number
  stagedSpans: number
}

interface ChatStreamStore {
  currentSessionId: string | null
  engineStatus: 'ok' | 'reconnecting' | 'error'
  // 旧版 #collapse-stats 的逐字节语义：on-screen 会话的最近一次事件值，
  // 全局残留、切会话不清（写入点保留在 chat.js 的 on-screen case 里）。
  lastOnScreenCollapse: CollapseStats | null
  sessions: Record<string, SessionStreamState>
}

const EMPTY_SESSION: SessionStreamState = {
  provisional: false,
  asyncQuestions: EMPTY_ASYNC_QUESTIONS,
  agentTasks: {},
  agentTimeline: [],
  running: false,
  goalContinuationId: null,
  streamMode: 'idle',
  currentInference: null,
  modelUpdate: null,
  liveUnits: [],
  liveRevision: 0,
  tools: {},
  thinkingActive: false,
  thinkingText: '',
  thinkingStartTime: 0,
  thinkingRequestStart: 0,
  activityVisible: false,
  compactionPendingTrigger: null,
  worktreeInit: null,
  title: null,
  history: null,
  historySource: 'saved',
  historyStale: false,
  historyLoading: false,
  historyLoadFailed: false,
  historyRetry: null,
  historyGeneration: 0,
  savedTranscript: null,
  supportsSavedItemAnchors: false,
  turnsPagination: null,
  turnShells: {},
  loadedRows: null,
  liveStartSeq: Number.MAX_SAFE_INTEGER,
  activeTurnId: null,
  liveTurnId: null,
  turnSequence: [],
  interruptedLiveTurn: null,
  lastTerminalStatus: null,
  turnStartedAt: 0,
  stopRequestedAt: null,
  turnStatuses: {},
  turnStartedAtMs: {},
  turnWorkStartedAtMs: {},
  turnWorkCompletedAtMs: {},
  turnFinishedAtMs: {},
  turnDurations: {},
  turnErrors: {},
  turnErrorKinds: {},
  turnErrorDetails: {},
  turnCancelledTools: {},
  turnCollapseOverrides: {},
}

type PendingRuntime = Pick<SessionStreamState, 'running' | 'streamMode' | 'currentInference' | 'activityVisible'
  | 'activeTurnId' | 'liveTurnId' | 'interruptedLiveTurn' | 'lastTerminalStatus' | 'turnStartedAt' | 'stopRequestedAt'>
interface PendingUserTurn {
  aliases: Set<string>
  uuid: string
  key: string
  startedAt: number
  before: PendingRuntime
  ownsRuntime: boolean
  observed: boolean
  accepted: boolean
}
const pendingUserTurns = new Map<string, Map<string, PendingUserTurn>>()

function pendingRuntime(state: SessionStreamState): PendingRuntime {
  const { running, streamMode, currentInference, activityVisible, activeTurnId, liveTurnId,
    interruptedLiveTurn, lastTerminalStatus, turnStartedAt, stopRequestedAt } = state
  return { running, streamMode, currentInference, activityVisible, activeTurnId, liveTurnId,
    interruptedLiveTurn, lastTerminalStatus, turnStartedAt, stopRequestedAt }
}
function pendingUserTurn(sessionId: string, uuid: string): PendingUserTurn | undefined {
  return [...(pendingUserTurns.get(sessionId)?.values() ?? [])].find(turn => turn.aliases.has(uuid))
}
function unadmittedUserTurn(sessionId: string): PendingUserTurn | undefined {
  return [...(pendingUserTurns.get(sessionId)?.values() ?? [])].find(turn => turn.ownsRuntime && !turn.observed)
}
function forgetPendingUserTurn(sessionId: string, turn: PendingUserTurn): void {
  const turns = pendingUserTurns.get(sessionId)
  turns?.delete(turn.uuid)
  if (!turns?.size) pendingUserTurns.delete(sessionId)
}
/** The input acceptance clock survives startup and is adopted once by the real Turn. */
function adoptPendingUserTurn(sessionId: string): number | undefined {
  const turn = unadmittedUserTurn(sessionId)
  if (!turn) return undefined
  turn.observed = true
  if (turn.accepted) forgetPendingUserTurn(sessionId, turn)
  return turn.startedAt
}

function completedWorkClock(state: SessionStreamState, units: LiveUnit[], turnId: string | null = state.activeTurnId || state.liveTurnId): Partial<SessionStreamState> {
  if (!turnId || state.turnWorkCompletedAtMs[turnId] != null) return {}
  const firstFinal = units.find(unit => unit.type === 'live-text' && unit.phase === 'final_answer'
    && (!unit.turnId || unit.turnId === turnId) && unit.startedAtMs != null)
  return firstFinal?.type === 'live-text' && firstFinal.startedAtMs != null
    ? { turnWorkCompletedAtMs: { ...state.turnWorkCompletedAtMs, [turnId]: firstFinal.startedAtMs } } : {}
}

// 与 chat.js isRunActivityEvent 同表：这些事件意味着回合在跑。
// Activity frames: the transcript's "something is happening" traffic.
// These frames NO LONGER set `running` (see the removed activity patch in
// ingestChatEvent) — the running indicator is a turn-lifecycle fact owned by
// session_runtime_status frames, turn submission and the stop bookkeeping. The set
// survives for LATE_AFTER_INTERRUPT_TYPES: after a user stop, late activity for the
// stopped turn must not paint under the stop divider.
const RUN_ACTIVITY_TYPES = new Set([
  'requesting',
  'stream_mode',
  'text_delta',
  'thinking_delta',
  'tool_start',
  'tool_input_delta',
  'tool_end',
  'progress',
  'diff_update',
  'user_message',
  'api_retry',
  'provider_status',
  'compaction_start',
])

// Stream activity that belongs to the Turn that just ended. A Turn settled as
// interrupted is CLOSED: anything still in flight for it lands after that
// terminal event, and applying it re-lights the running indicator and appends
// content BELOW the Turn's own stop status. `stream_mode` / `requesting` /
// `user_message` are excluded because those are how the NEXT Turn opens.
const LATE_AFTER_INTERRUPT_TYPES = new Set([...RUN_ACTIVITY_TYPES].filter(type =>
  type !== 'stream_mode' && type !== 'requesting' && type !== 'user_message'))

/** A stopped turn stays closed even while a successor has no engine identity yet. */
export function isStoppedTurnFrame(event: any): boolean {
  const turnId = typeof event?.turnId === 'string' ? event.turnId : ''
  if (!turnId || !event.sessionId) return false
  const terminal = event.type === 'done' || event.type === 'interrupted'
    || event.type === 'compaction_error' || event.type === 'api_error' && event.terminal === true
  if (!terminal && event.type !== 'session_runtime_status' && !RUN_ACTIVITY_TYPES.has(event.type)) return false
  return getSessionStream(event.sessionId).turnStatuses[turnId] === 'interrupted'
}

const streamTransactions = createTransactionalStore<ChatStreamStore>(() => ({
  currentSessionId: null,
  engineStatus: 'ok',
  lastOnScreenCollapse: null,
  sessions: {},
}))
export const chatStreamStore = streamTransactions.store

let frameQueue: ReturnType<typeof createStreamFrameQueue> | null = null

export function flushChatFrames(): void { frameQueue?.flush() }

/** IPC traffic is published once per frame; direct ingestion remains synchronous. */
export function ingestChatFrameEvent(event: any, context: { userInterrupted?: boolean } = {}): void {
  if (typeof window.requestAnimationFrame !== 'function') { ingestChatEvent(event, context); return }
  frameQueue ??= createStreamFrameQueue({
    frame: callback => { const id = window.requestAnimationFrame(callback); return () => window.cancelAnimationFrame(id) },
    timeout: callback => { const id = setTimeout(callback, 32); return () => clearTimeout(id) },
    visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    watchVisibility: callback => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('visibilitychange', callback)
      window.addEventListener('pagehide', callback)
      return () => { document.removeEventListener('visibilitychange', callback); window.removeEventListener('pagehide', callback) }
    },
  }, events => streamTransactions.transact(() => {
    for (const item of events) ingestChatEvent(item.event, item.context)
  }))
  frameQueue.enqueue(event, context)
}

const historicalReviews = new WeakMap<any[], DeniedApprovalReview[]>()
const retainedStreams = new ByteBudgetLru<string, { stream: SessionStreamState; bytes: number }>(64 * 1024 * 1024, 32)
const mountedStreams = new Map<string, number>()
const retiredStreams = new Map<string, number>()
const historyReadTokens = new Map<string, object>()
const retentionParticipants = new Set<{ protected(sessionId: string): boolean; retire(sessionId: string): void }>()
const savedHistoryViewports = new Map<string, Map<symbol, SavedHistoryViewport | null>>()
const queuedHistoryRetention = new Set<string>()

function pendingHistoryRetentionRequest(stream: SessionStreamState): boolean {
  return stream.liveUnits.some(unit => unit.type === 'live-planning-question' && unit.request.status === 'pending'
    || 'req' in unit && unit.resolved == null)
    || Object.values(stream.asyncQuestions.requests).some(request => request.state === 'pending' || request.state === 'submitting')
}

function scheduleHistoryRetention(sessionId: string): void {
  if (!savedHistoryViewports.has(sessionId) || queuedHistoryRetention.has(sessionId)) return
  queuedHistoryRetention.add(sessionId)
  queueMicrotask(() => {
    if (!queuedHistoryRetention.delete(sessionId)) return
    const stream = getSessionStream(sessionId), history = stream.savedTranscript
    const readers = savedHistoryViewports.get(sessionId)
    if (!history || !readers?.size || !stream.supportsSavedItemAnchors || stream.historySource !== 'saved'
      || stream.provisional || stream.historyLoading || stream.turnsPagination?.isLoadingOlder
      || unadmittedUserTurn(sessionId) || pendingEditedTurns.has(sessionId) || pendingHistoryRetentionRequest(stream)
      || historyInFlight.has(sessionId) || olderTurnsLoads.has(sessionId)
      || [...turnItemsLoads.values()].some(load => load.sessionId === sessionId && !load.cancelled)) return
    const retained = retainSavedHistoryItems(history, [...readers.values()])
    if (retained === history) return
    const kept = new Set(savedRows(retained).map(savedRowId))
    const removed = new Set(savedRows(history).map(savedRowId).filter(id => id && !kept.has(id)))
    patchSession(sessionId, previous => previous.savedTranscript !== history ? {} : {
      savedTranscript: retained,
      history: previous.history?.filter(row => !removed.has(savedRowId(row))) ?? previous.history,
      loadedRows: previous.loadedRows?.filter(row => !removed.has(savedRowId(row))) ?? previous.loadedRows,
      turnShells: savedShells(retained), turnsPagination: savedPagination(retained),
    })
  })
}

/** Every mounted surface reports its own measured end-of-history boundary. */
export function registerSavedHistoryViewport(sessionId: string): {
  setHistoryViewport(viewport: SavedHistoryViewport | null): void
  dispose(): void
} {
  const token = Symbol()
  const readers = savedHistoryViewports.get(sessionId) ?? new Map<symbol, SavedHistoryViewport | null>()
  readers.set(token, null)
  savedHistoryViewports.set(sessionId, readers)
  return {
    setHistoryViewport(viewport) {
      if (savedHistoryViewports.get(sessionId) !== readers || !readers.has(token)) return
      const previous = readers.get(token)
      if (previous?.oldestRenderedTurnId === viewport?.oldestRenderedTurnId
        && previous?.firstProtectedItemId === viewport?.firstProtectedItemId) return
      readers.set(token, viewport)
      scheduleHistoryRetention(sessionId)
    },
    dispose() {
      if (savedHistoryViewports.get(sessionId) !== readers) return
      readers.delete(token)
      if (!readers.size) savedHistoryViewports.delete(sessionId)
      else scheduleHistoryRetention(sessionId)
    },
  }
}

export function registerSessionRetentionParticipant(participant: { protected(sessionId: string): boolean; retire(sessionId: string): void }): () => void {
  retentionParticipants.add(participant)
  return () => { retentionParticipants.delete(participant) }
}

export function isSessionStreamRetired(sessionId: string): boolean {
  const until = retiredStreams.get(sessionId)
  if (until == null) return false
  if (until > Date.now()) return true
  retiredStreams.delete(sessionId)
  return false
}

function streamFamily(sessionId: string): Set<string> {
  const family = new Set([sessionId])
  let added = true
  while (added) {
    added = false
    for (const [id, source] of subagentHistorySources) if (family.has(source.parentSessionId) && !family.has(id)) {
      family.add(id); added = true
    }
  }
  return family
}

function streamRoot(sessionId: string): string {
  const seen = new Set<string>()
  while (!seen.has(sessionId)) {
    seen.add(sessionId)
    const parent = subagentHistorySources.get(sessionId)?.parentSessionId
    if (!parent) break
    sessionId = parent
  }
  return sessionId
}

function protectedStream(sessionId: string): boolean {
  const state = chatStreamStore.getState()
  for (const id of streamFamily(streamRoot(sessionId))) {
    const stream = state.sessions[id]
    if (id === state.currentSessionId || mountedStreams.has(id) || stream?.running || stream?.historyLoading
      || stream?.interruptedLiveTurn || stream?.liveUnits.length || pendingEditedTurns.has(id)) return true
    for (const participant of retentionParticipants) if (participant.protected(id)) return true
  }
  return false
}

function removeStreamFamily(sessionId: string, retired: boolean): void {
  const family = streamFamily(sessionId)
  const state = chatStreamStore.getState()
  const sessions = { ...state.sessions }
  for (const id of family) {
    if (retired) retiredStreams.set(id, Date.now() + 5 * 60_000)
    delete sessions[id]
    retainedStreams.delete(id)
    historyReadTokens.delete(id)
    historyInFlight.delete(id)
    cancelSavedHistoryLoads(id)
    savedHistoryViewports.delete(id)
    queuedHistoryRetention.delete(id)
    historyToolResults.delete(id)
    pendingEditedTurns.delete(id)
    pendingUserTurns.delete(id)
    subagentHistorySources.delete(id)
    retireMarkdownRuntime(id)
    retireArtifactsForSession(id)
    retireTranscriptViewport(id)
    retireEndResources(id)
  }
  // Keep tombstones small while still rejecting delayed host traffic.
  while (retiredStreams.size > 1024) retiredStreams.delete(retiredStreams.keys().next().value!)
  chatStreamStore.setState({ sessions })
  for (const id of family) {
    forgetApprovalReviewSession(id)
    for (const participant of retentionParticipants) participant.retire(id)
  }
}

export function trimSessionStreamCache(): void {
  for (const [id] of retainedStreams.trim(id => protectedStream(id))) removeStreamFamily(streamRoot(id), false)
}

/** Mounted surfaces, live turns and unresolved local output must never be evicted. */
export function retainSessionStream(sessionId: string): () => void {
  mountedStreams.set(sessionId, (mountedStreams.get(sessionId) ?? 0) + 1)
  retainedStreams.get(sessionId)
  return () => {
    const count = (mountedStreams.get(sessionId) ?? 1) - 1
    if (count > 0) mountedStreams.set(sessionId, count)
    else mountedStreams.delete(sessionId)
    trimSessionStreamCache()
  }
}

export function retireSessionStream(sessionId: string, options: { deleted?: boolean } = { deleted: true }): void {
  flushChatFrames()
  removeStreamFamily(sessionId, options.deleted !== false)
}

export function sessionStreamCacheStats() {
  return { entries: retainedStreams.size, bytes: retainedStreams.bytes, maxBytes: retainedStreams.maxBytes, maxEntries: retainedStreams.maxEntries }
}

function rememberStream(sessionId: string) {
  const stream = chatStreamStore.getState().sessions[sessionId]
  if (!stream) return
  const previous = retainedStreams.get(sessionId)
  const payloadChanged = !previous || previous.stream.history !== stream.history || previous.stream.agentTasks !== stream.agentTasks
    || previous.stream.agentTimeline !== stream.agentTimeline || previous.stream.running && !stream.running
  const bytes = payloadChanged && !stream.running ? retainedBytes(stream) : previous?.bytes ?? 1024
  retainedStreams.set(sessionId, { stream, bytes }, bytes)
  if (payloadChanged) trimSessionStreamCache()
}

function reviewsInHistory(history: any[] | null): DeniedApprovalReview[] {
  if (!history) return []
  const cached = historicalReviews.get(history)
  if (cached) return cached
  const reviews: DeniedApprovalReview[] = []
  for (const message of history) {
    const review = message.kind === 'approval-review' && approvalReview(message.approvalReview)
    if (review) reviews.push({ review, event: message.rawReview ?? approvalReviewEvent(review) })
  }
  historicalReviews.set(history, reviews)
  return reviews
}

chatStreamStore.subscribe((next, previous) => {
  for (const [sessionId, session] of Object.entries(next.sessions)) {
    const old = previous.sessions[sessionId]
    if (old?.history === session.history && old?.liveUnits === session.liveUnits) continue
    const reviews = [...reviewsInHistory(session.history)]
    for (const unit of session.liveUnits) if (unit.type === 'live-approval-review') reviews.push({ review: unit.review,
      event: unit.rawReview ?? approvalReviewEvent(unit.review) })
    replaceApprovalReviewHistory(sessionId, reviews.reverse())
  }
  for (const sessionId of Object.keys(previous.sessions)) if (!next.sessions[sessionId]) replaceApprovalReviewHistory(sessionId, [])
})

// 调试口：harness/probe 驱动的黑盒验证经此断言 store 内容（非产品 API）。
;(window as any).__klausChatStreamStore = chatStreamStore
;(window as any).__klausLoadSessionHistory = (sessionId: string) => loadSessionHistory(sessionId)

function patchSession(sessionId: string, patch: (prev: SessionStreamState) => Partial<SessionStreamState>): void {
  let retentionChanged = false
  flushChatFrames()
  if (isSessionStreamRetired(sessionId)) return
  chatStreamStore.setState(state => {
    const prev = state.sessions[sessionId] || EMPTY_SESSION
    const next = { ...prev, ...patch(prev) }
    retentionChanged = next.savedTranscript !== prev.savedTranscript || next.historyLoading !== prev.historyLoading
      || next.turnsPagination !== prev.turnsPagination || next.running !== prev.running
      || next.supportsSavedItemAnchors !== prev.supportsSavedItemAnchors
      || pendingHistoryRetentionRequest(next) !== pendingHistoryRetentionRequest(prev)
    const pendingEdit = pendingEditedTurns.get(sessionId)
    const observedTurnId = next.activeTurnId || next.liveTurnId
    if (pendingEdit && !pendingEdit.snapshot.replacementTurnId
      && observedTurnId && observedTurnId !== pendingEdit.snapshot.turnId) {
      pendingEdit.snapshot.replacementTurnId = observedTurnId
    }
    const turnId = next.activeTurnId || prev.activeTurnId
    if (turnId && (next.liveUnits !== prev.liveUnits || next.activeTurnId !== prev.activeTurnId)) {
      next.liveUnits = next.liveUnits.map(unit => unit.turnId ? unit : { ...unit, turnId })
    }
    // Keep one observed Turn order for the whole session. A Turn that history
    // later takes over keeps its slot, so a live-only Turn that preceded it can
    // still be placed before it instead of jumping to the transcript tail.
    const sequence = [...prev.turnSequence]
    const seenTurns = new Set(sequence)
    for (const id of [next.activeTurnId, next.liveTurnId, ...next.liveUnits.map(unit => unit.turnId)]) {
      if (!id || id === 'live' || seenTurns.has(id)) continue
      seenTurns.add(id)
      sequence.push(id)
    }
    if (sequence.length !== prev.turnSequence.length) next.turnSequence = sequence
    // Request cards have a separate host lifetime and are merged independently
    // during history handoff. Resolving one does not invalidate message history.
    const previousMessages = prev.liveUnits.filter(unit => !('req' in unit))
    const nextMessages = next.liveUnits.filter(unit => !('req' in unit))
    if (next.tools !== prev.tools || next.activeTurnId !== prev.activeTurnId
      || previousMessages.length !== nextMessages.length
      || nextMessages.some((unit, index) => unit !== previousMessages[index])) {
      next.liveRevision = prev.liveRevision + 1
    }
    // liveStartSeq 的唯一维护点：live 层每次由空转为持有内容就重新打点，清空即
    // 复位。放在这里而不是各插入点，是因为 live 单元的产生散在整张事件表上。
    if (next.liveUnits.length === 0) next.liveStartSeq = Number.MAX_SAFE_INTEGER
    else if (prev.liveUnits.length === 0) next.liveStartSeq = nextSeq()
    return { sessions: { ...state.sessions, [sessionId]: next } }
  })
  rememberStream(sessionId)
  if (retentionChanged) scheduleHistoryRetention(sessionId)
}

let liveKeySeq = 0
const nextKey = (prefix: string) => `${prefix}-${++liveKeySeq}`

// 单调序号：给「live 层内容的起点」和「history 的每次读取」排先后，两层
// 是否重叠只由这个先后决定（见 liveStartSeq 与 loadSessionHistory）。
let layerSeq = 0
const nextSeq = () => ++layerSeq

// 渲染为顶层 .msg-group.assistant 的 live 单元型（turnTail 定位用，对齐旧版
// querySelectorAll(':scope > .msg-group.assistant') 的命中面：capability 卡也带 assistant 类）。
const ASSISTANT_GROUP_UNIT_TYPES = new Set(['live-text', 'live-error', 'live-file'])

// 尾部 streaming text 收口（对齐 finalizeStream：块定格，下一段 text 新建单元）。
function sealTail(units: LiveUnit[]): LiveUnit[] {
  const index = lastConversationUnitIndex(units)
  const last = units[index]
  if (last?.type === 'live-text' && last.streaming) {
    return units.map((unit, position) => position === index ? { ...last, streaming: false } : unit)
  }
  if (last?.type === 'live-tools' && !last.sealed) {
    return units.map((unit, position) => position === index ? { ...last, sealed: true } : unit)
  }
  return units
}

// Asynchronous child notices belong after a logical message; they must not
// split its Markdown or prevent its next delta from continuing the same block.
function lastConversationUnitIndex(units: LiveUnit[]): number {
  let index = units.length - 1
  while (index >= 0 && units[index].type === 'live-agent-event') index--
  return index
}

// thinking 收口（对齐 thinkingUI.finalize）：有内容折叠成 thinking-done 单元，
// 空内容直接丢；返回新 units 与清空后的思考态。
function finalizeThinking(prev: SessionStreamState): Partial<SessionStreamState> {
  if (!prev.thinkingActive) return {}
  const patch: Partial<SessionStreamState> = {
    thinkingActive: false,
    thinkingText: '',
    thinkingStartTime: 0,
  }
  if (prev.thinkingText.trim()) {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - prev.thinkingStartTime) / 1000))
    patch.liveUnits = [
      ...sealTail(prev.liveUnits),
      { type: 'live-thinking-done', key: nextKey('tk'), text: prev.thinkingText, elapsedSeconds },
    ]
  }
  return patch
}

function appendAgentActivity(sessionId: string, activity: Omit<AgentTimelineRecord, 'key' | 'timestamp'> & { timestamp?: number }): void {
  patchSession(sessionId, prev => {
    if (activity.notificationId && prev.agentTimeline.some(item => item.notificationId === activity.notificationId)) return {}
    const sameAgent = (item: AgentTimelineRecord) => sameAgentActivity(item, activity)
    const previous = [...prev.agentTimeline].reverse().find(sameAgent)
    // A child settling after its parent turn ended must not invent a per-agent
    // pseudo turn: that splits the tail group per child and strands the rows
    // after the turn's change block. The spawn turn keeps them together and in
    // place.
    const spawnTurnId = prev.agentTasks[activity.taskId]?.spawnTurnId
      || (activity.agentId ? Object.values(prev.agentTasks).find(task => task.agentId === activity.agentId)?.spawnTurnId : undefined)
      || previous?.turnId
    const turnId = activity.turnId || spawnTurnId || prev.activeTurnId || prev.liveTurnId || `agent:${activity.agentId || activity.taskId}`
    if (activity.status === 'started') {
      const lastTerminal = [...prev.agentTimeline].reverse().findIndex(item => sameAgent(item) && agentTerminalStatus(item.status))
      const sinceTerminal = lastTerminal < 0 ? prev.agentTimeline : prev.agentTimeline.slice(prev.agentTimeline.length - lastTerminal)
      if (sinceTerminal.some(item => sameAgent(item) && item.status === 'started' && item.turnId === turnId)) return {}
    }
    if (previous?.status === activity.status && activity.status !== 'updated' && previous.turnId === turnId) {
      if (!activity.notificationId) return {}
      if (!previous.notificationId) {
        const delivered = { ...previous, notificationId: activity.notificationId, source: activity.source }
        return { agentTimeline: prev.agentTimeline.map(item => item === previous ? delivered : item),
          liveUnits: prev.liveUnits.map(unit => unit.type === 'live-agent-event' && unit.key === previous.key ? { ...unit, ...delivered } : unit) }
      }
    }
    const currentOwner = turnId === prev.activeTurnId || !prev.activeTurnId && (!prev.liveTurnId || turnId === prev.liveTurnId)
    const anchor = [...prev.liveUnits].reverse().find(unit => (unit.turnId === turnId || !unit.turnId && currentOwner)
      && (unit.type === 'live-text' || unit.type === 'live-tools' || unit.type === 'live-compaction'))
    const record: AgentTimelineRecord = {
      ...activity, key: nextKey(`agent-event-${Date.now()}`), timestamp: activity.timestamp ?? Date.now(),
      turnId,
      ...(anchor?.type === 'live-text' && anchor.messageId ? { afterMessageId: anchor.messageId } : {}),
      ...(anchor?.type === 'live-tools' ? { afterToolCallId: anchor.order.at(-1) } : {}),
    }
    const ownerIndex = [...prev.liveUnits].reverse().findIndex(unit => unit.turnId === turnId)
    const liveUnits = [...prev.liveUnits]
    if (currentOwner && (prev.activeTurnId || liveUnits.length || !prev.history?.some(message => message.turnId === turnId))) {
      liveUnits.push({ type: 'live-agent-event', ...record })
    } else if (ownerIndex >= 0) liveUnits.splice(liveUnits.length - ownerIndex, 0, { type: 'live-agent-event', ...record })
    else return {
      agentTimeline: [...prev.agentTimeline, record],
      // Lifecycle events can arrive before this conversation is opened. Keep
      // null until history is read so these events cannot block its first load.
      ...(prev.history !== null ? { history: mergeAgentTimeline(prev.history, [record]) } : {}),
    }
    return { agentTimeline: [...prev.agentTimeline, record], liveUnits }
  })
}

const subagentHistorySources = new Map<string, { parentSessionId: string; agentId: string; taskId: string; teammate: boolean; lifecycleVersion?: number; snapshotInterruptedVersion?: number }>()

/** Register endpoint identity before mounting or refreshing its transcript. */
export function prepareEphemeralSessionStream(sessionId: string): void {
  if (!sessionId || isSessionStreamRetired(sessionId) || getSessionStream(sessionId).historySource === 'ephemeral') return
  // A late saved-page failure must not overwrite the newly selected source.
  historyReadTokens.delete(sessionId)
  historyInFlight.delete(sessionId)
  cancelSavedHistoryLoads(sessionId)
  patchSession(sessionId, prev => ({
    historySource: 'ephemeral', historyGeneration: prev.historyGeneration + 1,
    historyLoading: false, historyLoadFailed: false, historyRetry: null, historyStale: true,
    savedTranscript: null, turnsPagination: null, turnShells: {},
  }))
}

/** Recipient labels follow the current direct parent, including late ancestry updates. */
export function selectSubagentParentId(state: ChatStreamStore, streamId: string): string | undefined {
  const source = subagentHistorySources.get(streamId)
  if (!source) return undefined
  const tasks = state.sessions[source.parentSessionId]?.agentTasks || {}
  const task = tasks[source.taskId] || Object.values(tasks).find(task => task.agentId === source.agentId)
  return task?.parentAgentId || source.parentSessionId
}

/** Content is keyed by the registry root; lifecycle activity belongs to the direct parent. */
export function subagentOwnerStreamId(rootSessionId: string, task: Pick<AgentTask, 'parentAgentId'>): string {
  return task.parentAgentId && task.parentAgentId !== rootSessionId ? subagentStreamId(rootSessionId, task.parentAgentId) : rootSessionId
}

function retainedAgentTaskSnapshot(sessionId: string, previous: AgentTask | undefined, incoming: AgentTask): AgentTask {
  const task = preserveAgentLifecycle(previous, incoming)
  if (task === previous) return task
  const child = previous?.agentId ? getSessionStream(subagentStreamId(sessionId, previous.agentId)) : null
  const version = previous?.streamStartedFromLifecycleVersion
  if (child?.running && child.activeTurnId === previous?.streamTurnId
    && (agentTerminalStatus(task.status) || task.type === 'in_process_teammate' && task.isIdle)
    && typeof version === 'number' && !(typeof task.lifecycleUpdatedAtMs === 'number' && task.lifecycleUpdatedAtMs > version)) return previous!
  return { ...task, spawnTurnId: task.spawnTurnId || (task.parentAgentId === previous?.parentAgentId ? previous?.spawnTurnId : undefined),
    ...(!agentTerminalStatus(task.status) && previous?.streamTurnId ? {
      streamTurnId: previous.streamTurnId, streamStartedFromLifecycleVersion: previous.streamStartedFromLifecycleVersion,
    } : {}) }
}

/** Restore renderer-only lifecycle history from the existing task sidecar. */
export function seedSubagentTasks(sessionId: string, tasks: Record<string, AgentTask>, registryRoot = subagentHistorySources.get(sessionId)?.parentSessionId || sessionId): void {
  if (isSessionStreamRetired(sessionId) || isSessionStreamRetired(registryRoot)) return
  let relocated: AgentTimelineRecord[] = []
  patchSession(sessionId, prev => {
    const known = new Set(prev.agentTimeline.map(event => event.key))
    const restored = Object.values(tasks).filter(task => subagentOwnerStreamId(registryRoot, task) === sessionId)
      .flatMap(task => Array.isArray(task.activityEvents) ? task.activityEvents : [])
      .filter((event): event is AgentTimelineRecord => !!event && typeof event.key === 'string'
        && typeof event.taskId === 'string' && typeof event.name === 'string'
        && typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
        && ['started', 'updated', 'completed', 'failed', 'cancelled'].includes(event.status)
        && isVisibleAgentActivity(event)
        && !known.has(event.key))
    const canonicalKeys = new Map(Object.entries(tasks).flatMap(([id, task]) => task.agentId && id !== task.agentId ? [[task.agentId, id]] : []))
    const retained = Object.fromEntries(Object.entries(prev.agentTasks).filter(([id, task]) => !task.agentId || !canonicalKeys.has(task.agentId) || canonicalKeys.get(task.agentId) === id))
    const agentTasks = coalesceSubagentTaskAliases({ ...retained, ...Object.fromEntries(Object.entries(tasks).map(([id, task]) =>
      [id, retainedAgentTaskSnapshot(registryRoot, prev.agentTasks[id] || (task.agentId ? Object.values(prev.agentTasks).find(previous => previous.agentId === task.agentId) : undefined), task)])) })
    const resolve = (record: AgentTimelineRecord) => resolveAgentActivityTask(record, agentTasks)
    const owns = (record: AgentTimelineRecord) => subagentOwnerStreamId(registryRoot, agentTasks[resolve(record).taskId] || {}) === sessionId
    relocated = prev.agentTimeline.filter(record => !owns(record))
    return { agentTasks, agentTimeline: mergeAgentActivityRecords(prev.agentTimeline.filter(owns), restored).map(resolve),
      liveUnits: prev.liveUnits.filter(unit => unit.type !== 'live-agent-event' || owns(unit))
        .map(unit => unit.type === 'live-agent-event' ? { ...unit, ...resolve(unit) } : unit),
      ...(prev.history ? { history: prev.history.filter(message => message.kind !== 'agent-event' || !message.agentEvent || owns(message.agentEvent))
        .map(message => message.kind === 'agent-event' && message.agentEvent
        ? { ...message, agentEvent: resolve(message.agentEvent) } : message) } : {}),
      ...(restored.length ? { historyStale: true } : {}) }
  })
  if (sessionId === registryRoot) {
    const owners = new Map<string, Record<string, AgentTask>>()
    for (const [taskId, task] of Object.entries(tasks)) {
      const owner = subagentOwnerStreamId(registryRoot, task)
      if (owner === registryRoot) continue
      const owned = owners.get(owner) || {}
      const current = getSessionStream(sessionId).agentTasks[taskId] || task
      const moved = relocated.filter(record => sameAgentActivity(record, { taskId, agentId: current.agentId })).map(record => {
        const turnId = current.spawnTurnId || getSessionStream(owner).activeTurnId || getSessionStream(owner).liveTurnId || record.turnId
        return turnId && turnId !== record.turnId ? { ...record, turnId, afterMessageId: undefined, afterToolCallId: undefined } : record
      })
      const movedKeys = new Set(moved.map(record => record.key))
      owned[taskId] = moved.length ? { ...current, activityEvents: [
        ...(Array.isArray(current.activityEvents) ? current.activityEvents.filter(record => !movedKeys.has(record.key)) : []), ...moved,
      ] } : current
      owners.set(owner, owned)
    }
    for (const [owner, owned] of owners) seedSubagentTasks(owner, owned, registryRoot)
  }
}

/** Disk replay marks every turn that has no terminal record as interrupted.
 *  A child that is still running has not finished that turn. A recorded stop
 *  carries a finish time, a duration, or the calls the stop cancelled. */
function childTailStillOpen(
  turnId: string | null | undefined,
  running: boolean,
  statuses: Record<string, string>,
  finishedAt: Record<string, number>,
  durations: Record<string, number>,
  cancelled: Record<string, string[]>,
  hasFinal: boolean,
): turnId is string {
  return running && !!turnId && !hasFinal
    && statuses[turnId] !== 'completed' && statuses[turnId] !== 'failed'
    && finishedAt[turnId] == null && durations[turnId] == null && !(cancelled[turnId]?.length)
}

function withoutInferredInterrupt(statuses: Record<string, string>, turnId: string | null): Record<string, string> {
  if (!turnId || statuses[turnId] !== 'interrupted') return statuses
  const next = { ...statuses }
  delete next[turnId]
  return next
}

/** Drop the stop row painted for an open child turn. A row with no turn id was
 *  synthesized before the turn was known; a recorded stop names its turn. */
function withoutOpenStopRow(units: LiveUnit[], turnId: string | null): LiveUnit[] {
  if (!turnId) return units
  const next = units.filter(unit => unit.type !== 'live-turn-status' || (!!unit.turnId && unit.turnId !== turnId))
  return next.length === units.length ? units : next
}

/** A child owns its stream and disclosure state; its parent owns the history endpoint. */
export function prepareSubagentStream(parentSessionId: string, taskId: string, task: Partial<AgentTask>): string {
  const agentId = task.agentId || taskId
  const streamId = subagentStreamId(parentSessionId, agentId)
  if (isSessionStreamRetired(parentSessionId)) return streamId
  const source = subagentHistorySources.get(streamId)
  const version = typeof task.lifecycleUpdatedAtMs === 'number' && Number.isFinite(task.lifecycleUpdatedAtMs)
    ? task.lifecycleUpdatedAtMs : undefined
  const newerLifecycle = version !== undefined && (source?.lifecycleVersion === undefined || version > source.lifecycleVersion)
  const repairSnapshotInterrupt = version !== undefined && source?.snapshotInterruptedVersion === version
    && task.status === 'running' && !task.isIdle
  subagentHistorySources.set(streamId, { parentSessionId, agentId, taskId, teammate: task.type === 'in_process_teammate',
    lifecycleVersion: newerLifecycle ? version : source?.lifecycleVersion,
    snapshotInterruptedVersion: newerLifecycle || repairSnapshotInterrupt ? undefined : source?.snapshotInterruptedVersion })
  if (!source || !chatStreamStore.getState().sessions[streamId]) {
    patchSession(streamId, () => ({ running: !agentTerminalStatus(task.status) && !task.isIdle, ...(task.messages?.length ? { history: task.messages } : {}) }))
  } else if ((newerLifecycle || repairSnapshotInterrupt) && task.status === 'running' && !task.isIdle) {
    // Reconnects can miss the child's requesting frame. A newer lifecycle can
    // restore liveness; an equal version may repair only the stop synthesized
    // from a task snapshot, never a cancellation delivered by the child stream.
    patchSession(streamId, prev => {
      // A same-version running snapshot undoes a stop this client synthesized
      // from a missing task row. Clearing only the running flag leaves the
      // stop row on screen and keeps later events for that turn discarded.
      // A newer lifecycle after a real cancellation must keep that turn's row.
      const dropped = repairSnapshotInterrupt
        ? new Set(Object.entries(prev.turnStatuses).filter(([id, status]) => status === 'interrupted'
          && prev.turnFinishedAtMs[id] == null && prev.turnDurations[id] == null
          && !(prev.turnCancelledTools[id]?.length)).map(([id]) => id))
        : null
      const liveUnits = dropped
        ? prev.liveUnits.filter(unit => unit.type !== 'live-turn-status' || (!!unit.turnId && !dropped.has(unit.turnId)))
        : prev.liveUnits
      const turnStatuses = dropped ? { ...prev.turnStatuses } : prev.turnStatuses
      if (dropped) for (const id of dropped) delete turnStatuses[id]
      const cleared = dropped != null && (liveUnits.length !== prev.liveUnits.length || dropped.size > 0)
      if (prev.running && !cleared) return {}
      if (!repairSnapshotInterrupt && prev.running) return {}
      const only = dropped && dropped.size === 1 ? [...dropped][0] : null
      return {
        running: true, streamMode: 'requesting' as const, activityVisible: true,
        interruptedLiveTurn: null, lastTerminalStatus: null, stopRequestedAt: null,
        historyStale: true,
        ...(cleared ? {
          liveUnits, turnStatuses,
          ...(only && !prev.activeTurnId ? { activeTurnId: only, liveTurnId: prev.liveTurnId || only } : {}),
        } : {}),
      }
    })
  }
  return streamId
}

function ingestSubagentEvent(event: any): void {
  const child = event.event
  if (!event.agentId || !child || typeof child.type !== 'string') return
  const registry = getSessionStream(event.sessionId)
  const taskId = Object.keys(registry.agentTasks).find(id => registry.agentTasks[id].agentId === event.agentId)
    || (event.label ? event.agentId : event.toolUseId) || event.agentId
  const previous = registry.agentTasks[taskId]
  const ancestryChanged = typeof event.parentAgentId === 'string' && event.parentAgentId !== previous?.parentAgentId
  const task = { ...previous, ...(ancestryChanged ? { spawnTurnId: undefined } : {}), agentId: event.agentId, ...(typeof event.parentAgentId === 'string' ? { parentAgentId: event.parentAgentId } : {}),
    ...(typeof event.depth === 'number' ? { depth: event.depth } : {}),
    ...((ancestryChanged || !previous?.spawnTurnId) && typeof event.spawnTurnId === 'string' ? { spawnTurnId: event.spawnTurnId } : {}) } as AgentTask
  const ownerId = subagentOwnerStreamId(event.sessionId, task)
  if (ancestryChanged) seedSubagentTasks(event.sessionId, { [taskId]: task })
  const parent = getSessionStream(ownerId)
  if (ownerId !== event.sessionId) {
    patchSession(ownerId, prev => ({ agentTasks: { ...prev.agentTasks, [taskId]: { ...task, agentId: event.agentId } } }))
    if (!registry.agentTasks[taskId]) patchSession(event.sessionId, prev => ({ agentTasks: { ...prev.agentTasks, [taskId]: { ...task, agentId: event.agentId } } }))
  }
  const streamId = prepareSubagentStream(event.sessionId, taskId, { ...task, agentId: event.agentId })
  const childState = getSessionStream(streamId)
  const terminal = child.type === 'done' ? 'completed' : child.type === 'interrupted' ? 'cancelled'
    : child.type === 'api_error' && child.terminal ? 'failed' : null
  if (terminal) {
    const source = subagentHistorySources.get(streamId)
    if (source?.snapshotInterruptedVersion !== undefined) {
      subagentHistorySources.set(streamId, { ...source, snapshotInterruptedVersion: undefined })
    }
  }
  // An explicit old turn's terminal event cannot settle the resumed child or
  // create a completion notice in the new parent turn.
  if (terminal && childState.activeTurnId && typeof child.turnId === 'string'
    && child.turnId !== childState.activeTurnId) return
  if (child.type === 'stream_mode' && child.mode === 'requesting' && typeof child.turnId === 'string'
    && child.turnId !== childState.activeTurnId && child.turnId !== childState.liveTurnId) {
    const resuming = !!childState.lastTerminalStatus || !!agentTerminalStatus(task?.status) || task?.isIdle === true
    const turnId = (resuming ? parent.activeTurnId || parent.liveTurnId || task?.spawnTurnId
      : task?.spawnTurnId || parent.activeTurnId || parent.liveTurnId) || undefined
    patchSession(streamId, () => ({ running: true }))
    if (registry.agentTasks[taskId] || ownerId !== event.sessionId) {
      patchSession(event.sessionId, prev => ({ agentTasks: { ...prev.agentTasks, [taskId]: {
        ...prev.agentTasks[taskId], status: 'running', isIdle: false, completedAtMs: undefined,
        streamTurnId: child.turnId, streamStartedFromLifecycleVersion: task.lifecycleUpdatedAtMs,
        ...(turnId ? { spawnTurnId: turnId } : {}),
      } } }))
      if (ownerId !== event.sessionId) patchSession(ownerId, prev => ({ agentTasks: { ...prev.agentTasks, [taskId]: getSessionStream(event.sessionId).agentTasks[taskId] } }))
    }
    appendAgentActivity(ownerId, { taskId, agentId: event.agentId,
      name: agentTaskName(task, event.label || ''), status: 'started',
      turnId })
  }
  // Live units track off-screen progress without claiming that saved history
  // was read. Opening the child can still load the earlier conversation.
  ingestChatEvent({ ...child, sessionId: streamId })
  // A persistent teammate can finish this run and remain available for another
  // prompt. Its run completion belongs in the parent process independently of
  // the task's lifetime status.
  if (terminal) {
    appendAgentActivity(ownerId, { taskId, agentId: event.agentId,
      name: agentTaskName(task, event.label || ''),
      status: terminal })
  }
}

// A tool that fails inside the stop window failed BECAUSE of the stop: the
// engine synthesises `Tool execution was interrupted.` for every call an abort
// left unhandled, so rendering that as a red failure blames the tool for the
// user's click. The Turn's terminal state decides it instead (see
// stop-interaction-vectors.json,
// unfinished-tool-terminal-state); a tool that failed on its own merits before
// the stop was requested keeps its failure.
function interruptAttributed(state: SessionStreamState): boolean {
  return state.stopRequestedAt != null || state.interruptedLiveTurn != null
}

// A Turn can end `failed` with an error that is not the model's verdict at all:
// the session was closed (a stop click racing a binding rebuild, an idle
// retirement, a delete) and the engine's shutdown gate refused the Turn's setup
// claim. Every shutdown-gate refusal carries the same marker phrase — no
// provider failure ever does — so the Turn reads as stopped, never as a red
// error. Durability persistence failures deliberately do NOT match: those are
// genuine internal failures the user must see. The engine settles new
// shutdown-refused Turns as aborted; this matcher is the safety net for races
// and for transcripts saved before that fix.
const TEARDOWN_FAILURE_MARKER = 'session shutdown closed'

export function isTeardownFailure(text: string): boolean {
  return String(text || '').toLowerCase().includes(TEARDOWN_FAILURE_MARKER)
}

// While the stop request is outstanding the attribution is a guess: the engine
// may still finish the Turn normally, and then the failure it reported was the
// tool's own. Only the Turn's terminal event knows, so that is where the guess
// is settled -- the click alone must never leave a real failure painted as a stop.
function settleStopWindowFailures(
  tools: Record<string, ToolCardState>,
  interrupted: boolean,
): Record<string, ToolCardState> {
  let changed = false
  const next = Object.fromEntries(Object.entries(tools).map(([toolCallId, tool]) => {
    if (!tool.stopWindowFailure) return [toolCallId, tool]
    changed = true
    const { stopWindowFailure: _dropped, ...rest } = tool
    return [toolCallId, interrupted ? rest : { ...rest, status: 'error' as const }]
  }))
  return changed ? next : tools
}

/** chat.js chatEvent handler 头部的镜像入口：全事件转发，附会话上下文。 */
export function ingestChatEvent(event: any, context: { userInterrupted?: boolean } = {}): void {
  flushChatFrames()
  const sessionId = typeof event?.sessionId === 'string' ? event.sessionId : ''
  if (!sessionId || isSessionStreamRetired(sessionId)) return
  if (isStoppedTurnFrame(event)) return
  const type = event?.type
  if (type === 'goal_completion' && event.goal?.status === 'complete') {
    ingestGoalCompletion(sessionId, { ...event.goal, tokenBudget: event.goal.tokenBudget ?? null })
    return
  }
  if (type === 'proposed_plan' && event.plan) {
    patchSession(sessionId, previous => {
      const plan = event.plan as ProposedPlan
      const key = `proposed-plan:${plan.id}`
      const index = previous.liveUnits.findIndex(unit => unit.key === key)
      const units = [...previous.liveUnits]
      const unit: LiveUnit = { type: 'live-proposed-plan', key, plan, turnId: plan.turnId }
      if (index >= 0) units[index] = unit
      else units.push(unit)
      const handoff = mergePlanningHistoryUnits(previous.history, units)
      return { ...handoff, liveRevision: previous.liveRevision + 1, goalContinuationId: null }
    })
    return
  }
  if (type === 'proposed_plan_delta') {
    patchSession(sessionId, previous => ({ liveUnits: previous.liveUnits.map(unit => unit.type === 'live-proposed-plan' && unit.plan.id === event.planId && unit.plan.revision === event.revision
      ? { ...unit, plan: { ...unit.plan, content: unit.plan.content + event.delta } } : unit), liveRevision: previous.liveRevision + 1, goalContinuationId: null }))
    return
  }
  if (type === 'progress_plan') {
    // Progress ends continuation preparation; the task store owns its visible checklist.
    patchSession(sessionId, () => ({ goalContinuationId: null }))
    return
  }
  if (type === 'agent_progress') { ingestSubagentEvent(event); return }
  if (type === 'agent_notification') {
    const activity = agentNotificationActivity(event, getSessionStream(sessionId).agentTasks)
    if (activity) appendAgentActivity(sessionId, activity)
    return
  }
  if (type === 'teammate_messages' && event.taskId && Array.isArray(event.messages)) {
    const task = getSessionStream(sessionId).agentTasks[event.taskId]
    if (task) {
      patchSession(sessionId, prev => ({ agentTasks: { ...prev.agentTasks, [event.taskId]: { ...task, messages: event.messages } } }))
      const childId = prepareSubagentStream(sessionId, event.taskId, task)
      patchSession(childId, () => ({ historyStale: true }))
      void loadSessionHistory(childId)
    }
    return
  }
  if (type === 'tasks_changed') {
    const before = getSessionStream(sessionId).agentTasks
    const incoming: Record<string, AgentTask> = event.tasks || {}
    const activeTurnId = getSessionStream(sessionId).activeTurnId
    const previousTask = (taskId: string, task: AgentTask) => before[taskId]
      || (task.agentId ? Object.values(before).find(previous => previous.agentId === task.agentId) : undefined)
    const isWorking = (task: AgentTask | undefined) => !!task && !task.isIdle
      && task.status === 'running'
    const stamped: Record<string, AgentTask> = Object.fromEntries(Object.entries(incoming).map(([taskId, raw]) => {
      const previous = previousTask(taskId, raw)
      const task = retainedAgentTaskSnapshot(sessionId, previous, raw)
      const ownerTurnId = getSessionStream(subagentOwnerStreamId(sessionId, task)).activeTurnId
      if (previous && task.parentAgentId !== previous.parentAgentId) return [taskId, { ...task, spawnTurnId: task.spawnTurnId || ownerTurnId || undefined }]
      if (ownerTurnId && isWorking(task) && !isWorking(previous)) return [taskId, { ...task, spawnTurnId: ownerTurnId }]
      const prior = previous?.spawnTurnId
      if (prior) return [taskId, { ...task, spawnTurnId: prior }]
      return [taskId, ownerTurnId && !previous ? { ...task, spawnTurnId: ownerTurnId } : task]
    }))
    seedSubagentTasks(sessionId, stamped)
    for (const [taskId, task] of Object.entries(stamped)) {
      const previous = previousTask(taskId, task)
      const ownerId = subagentOwnerStreamId(sessionId, task)
      const ownerTurnId = getSessionStream(ownerId).activeTurnId
      if (isWorking(task)) prepareSubagentStream(sessionId, taskId, task)
      if (isWorking(task) && !isWorking(previous)) {
        appendAgentActivity(ownerId, { taskId, agentId: task.agentId, name: agentTaskName(task, ''),
          status: 'started', turnId: ownerTurnId || task.spawnTurnId })
      }
      const idleRun = task.type === 'in_process_teammate' && task.isIdle && isWorking(previous)
      let runOutcome: AgentEventStatus | null = null
      if (idleRun) {
        // Reuse only a terminal notice after this run's start. The child's
        // stream can still contain a previous run when only snapshots arrived.
        for (const record of [...getSessionStream(ownerId).agentTimeline].reverse()) {
          if (!sameAgentActivity(record, { taskId, agentId: task.agentId })) continue
          if (task.spawnTurnId && record.turnId && record.turnId !== task.spawnTurnId) continue
          if (record.status === 'started') break
          runOutcome = agentTerminalStatus(record.status)
          if (runOutcome) break
        }
      }
      const status = agentTerminalStatus(task.status)
        || (idleRun ? runOutcome || 'completed' : null)
      if (status && status !== agentTerminalStatus(before[taskId]?.status)) {
        appendAgentActivity(ownerId, { taskId, agentId: task.agentId, name: agentTaskName(task, ''), status })
        const streamId = prepareSubagentStream(sessionId, taskId, task)
        if (status === 'cancelled' && typeof task.lifecycleUpdatedAtMs === 'number' && Number.isFinite(task.lifecycleUpdatedAtMs)) {
          const source = subagentHistorySources.get(streamId)
          if (source) subagentHistorySources.set(streamId, { ...source, snapshotInterruptedVersion: task.lifecycleUpdatedAtMs })
        }
        const childState = getSessionStream(streamId)
        if (childState.running || (status === 'failed' && !childState.lastTerminalStatus)) {
          ingestChatEvent({ sessionId: streamId, type: status === 'cancelled' ? 'interrupted' : status === 'failed' ? 'api_error' : 'done', terminal: true, error: task.error || (status === 'failed' ? t('subagent_activity_failed') : '') })
        }
      }
    }
    return
  }
  // Runtime communication is already delivered to the model and persisted by
  // the host. It must not insert a user row or split the visible reasoning.
  if (type === 'user_message' && [event, event.message, event.message?.message]
    .some(message => message?.isMeta === true || message?.is_meta === true)) return
  const terminalError = type === 'api_error' && event?.terminal === true

  if (type === 'done' || type === 'interrupted' || terminalError || type === 'compaction_error') {
    const terminalAt = Date.now()
    let ignoredLegacyDone = false
    patchSession(sessionId, prev => {
      const interrupted = type === 'interrupted'
      // A teardown-family failure is the session closing under the Turn, not the
      // model failing: the user's stop (or any teardown) owns it, so it settles
      // exactly like an interrupted Turn — partial output kept, stopped label,
      // no red error card.
      || (terminalError && isTeardownFailure(String(event?.error ?? '')))
      const failed = terminalError && !interrupted
      const turnId = typeof event?.turnId === 'string' && event.turnId
        ? event.turnId
        : prev.activeTurnId ?? (interrupted ? prev.interruptedLiveTurn?.turnId ?? null : null)
      // Terminal events are ALWAYS delivered and applied under the turnId they
      // carry (the host no longer drops them on an identity mismatch). A terminal event that
      // names a DIFFERENT turn than the one still streaming is that other turn's word, not
      // this turn's: settling on it would kill a live turn, exactly what the old host-side
      // guard was afraid of. Unnamed terminal events keep settling the active turn.
      if (turnId && prev.running && prev.activeTurnId && prev.activeTurnId !== turnId) return {}
      adoptPendingUserTurn(sessionId)
      if (interrupted || failed) resetTaskContinuation(sessionId)
      // Some driver paths emit a legacy bare `done` after the authoritative
      // interrupted lifecycle event. It carries no additional state and must
      // not erase the partial Turn the user just stopped.
      const retained = prev.interruptedLiveTurn
      if (type === 'done' && retained
          && (!retained.turnId || !event?.turnId || event.turnId === retained.turnId)) {
        ignoredLegacyDone = true
        return {}
      }
      const thinkingPatch = finalizeThinking(prev)
      let units = sealTail((thinkingPatch.liveUnits as LiveUnit[]) || prev.liveUnits)
      // The turn's terminal event is also the verdict on the questions it parked:
      // a question this turn left unanswered (skipped at the deadline, or its
      // answer racing the turn's end) must not keep the row parked as Needs-input
      // once the turn is over. Other turns' cards keep waiting for their own word.
      units = units.map(unit => {
        if ((unit.type !== 'live-ask' && unit.type !== 'live-elicit') || unit.resolved != null) return unit
        if (unit.turnId && turnId && unit.turnId !== turnId) return unit
        return { ...unit, resolved: unit.type === 'live-ask' ? { mode: 'skipped', answers: {} } : 'cancelled' } as LiveUnit
      })
      // The Turn's own terminal event is the verdict on every failure the stop
      // window painted as stopped, whichever way it went.
      let tools = settleStopWindowFailures(prev.tools, interrupted)
      if (interrupted) {
        // The partial answer keeps its text but is marked aborted so it does not
        // read as a finished reply. The streaming flag is read off the PRE-seal
        // state: `units` has already been through sealTail, which clears that
        // flag, so testing it afterwards always said false and the marker never
        // landed on the bubble.
        const streamingTail = prev.liveUnits[prev.liveUnits.length - 1]
        const last = units[units.length - 1]
        if (streamingTail?.type === 'live-text' && streamingTail.streaming
            && last?.type === 'live-text' && last.key === streamingTail.key) {
          units = [...units.slice(0, -1), { ...last, streaming: false, aborted: true }]
        }
        tools = Object.fromEntries(Object.entries(tools).map(([toolCallId, tool]) => [
          toolCallId,
          tool.status === 'running' || tool.status === 'awaiting-approval'
            ? { ...tool, status: 'interrupted' as const }
            : tool,
        ]))
        // The partial answer is finished text the user asked to keep, so it gets the
        // same copy/branch row a completed reply gets. Without it the actions only
        // appeared after a reload replaced the live layer, i.e. the same Turn showed
        // two different action sets. No usage meta: an abort produced no usage
        // envelope, and a zeroed one would read as "this turn cost nothing".
        for (let i = units.length - 1; i >= 0; i--) {
          const u = units[i]
          if (!ASSISTANT_GROUP_UNIT_TYPES.has(u.type)) continue
          if (u.type === 'live-text' && !u.turnTail) {
            units = [...units.slice(0, i), { ...u, turnTail: { ts: terminalAt, meta: null } }, ...units.slice(i + 1)]
          }
          break
        }
        const hasTerminalStatus = units.some(unit => unit.type === 'live-turn-status' && unit.turnId === turnId)
        if (!hasTerminalStatus) {
          units = [...units, {
            type: 'live-turn-status',
            key: nextKey('turn-status'),
            turnId,
            startedAt: prev.turnStartedAt || prev.thinkingRequestStart || Date.now(),
            finishedAt: terminalAt,
            userInitiated: context.userInterrupted === true,
          }]
        }
      }
      if (failed && !context.userInterrupted) {
        units = [...units, {
          type: 'live-error',
          key: nextKey('er'),
          text: String(event.error ?? '').trim(),
          kind: typeof event.kind === 'string' ? event.kind : undefined,
          errorDetails: detailsForApiError(event),
        }]
      }
      // Attach end-of-turn usage to the last assistant message on completed Turns.
      // The interrupted branch above attaches its own action row without usage.
      if (type === 'done') {
        const finalMessageId = typeof event.finalMessageId === 'string' ? event.finalMessageId : ''
        const tailIndex = lastConversationUnitIndex(units)
        const tail = units[tailIndex]
        // Older child streams omitted final-message metadata. Their terminal
        // trailing answer can settle the disclosure, but explicit commentary
        // and text followed by a tool remain process evidence.
        const childAnswerIndex = !finalMessageId && subagentHistorySources.has(sessionId)
          && tail?.type === 'live-text' && tail.phase !== 'commentary' && tail.text.trim() ? tailIndex : -1
        for (let i = units.length - 1; (finalMessageId || childAnswerIndex >= 0) && i >= 0; i--) {
          const u = units[i]
          if (u.type === 'live-text' && (finalMessageId ? u.messageId === finalMessageId : i === childAnswerIndex)) {
            const usage = event.usage
            const turnTokens = usage
              ? (typeof usage.totalTokens === 'number'
                  ? usage.totalTokens
                  : (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadInputTokens || 0) + (usage.cacheCreationInputTokens || 0))
              : 0
            const meta = usage ? { turnTokens, usage, stopReason: String(event.stopReason || '') } : null
            units = [...units.slice(0, i), { ...u, phase: 'final_answer', turnTail: { ts: terminalAt, meta } }, ...units.slice(i + 1)]
            break
          }
        }
      }
      return {
        ...thinkingPatch,
        ...completedWorkClock(prev, units, turnId),
        running: false,
        goalContinuationId: null,
        streamMode: 'idle',
        activityVisible: false,
        asyncQuestions: expireAsyncQuestions(prev.asyncQuestions, turnId),
        activeTurnId: null,
        liveTurnId: turnId || prev.liveTurnId,
        ...(turnId && prev.turnStartedAt ? { turnDurations: { ...prev.turnDurations, [turnId]: Math.max(0, terminalAt - prev.turnStartedAt) } } : {}),
        interruptedLiveTurn: interrupted ? { turnId } : null,
        lastTerminalStatus: interrupted
          ? 'interrupted'
          : failed
            ? 'failed'
            : type === 'done'
              ? 'completed'
              : prev.lastTerminalStatus,
        currentInference: null,
        turnStartedAt: 0,
        stopRequestedAt: null,
        tools,
        // liveUnits retain an interrupted Turn until history takes ownership so
        // partial text and tool output never disappear or duplicate.
        liveUnits: units.filter(unit => unit.type !== 'live-compaction' || unit.state === 'completed'),
        ...(interrupted && turnId ? { turnStatuses: { ...prev.turnStatuses, [turnId]: 'interrupted' } } : {}),
        ...(failed && turnId ? {
          turnStatuses: { ...prev.turnStatuses, [turnId]: 'failed' },
          turnErrors: { ...prev.turnErrors, [turnId]: String(event.error ?? '').trim() },
          turnErrorKinds: { ...prev.turnErrorKinds, [turnId]: String(event.kind ?? 'unknown') },
          turnErrorDetails: { ...prev.turnErrorDetails, [turnId]: detailsForApiError(event) },
        } : {}),
        ...(type !== 'interrupted' ? { historyStale: true } : {}),
        compactionPendingTrigger: null,
      }
    })
    // The history layer is frozen while a live Turn owns its content. An
    // interrupted Turn deliberately remains live to preserve partial output.
    if (type !== 'interrupted' && !ignoredLegacyDone) void loadSessionHistory(sessionId)
    return
  }
  if (LATE_AFTER_INTERRUPT_TYPES.has(type)
      && chatStreamStore.getState().sessions[sessionId]?.interruptedLiveTurn != null) {
    return
  }
  // Activity frames describe traffic, not turn lifecycle. Setting `running`
  // from them is what let a drifted session resurrect its own running indicator after the
  // lifecycle had settled; the indicator now opens only from session_runtime_status active
  // frames, turn submission, async-question admission and the host's working registry.

  switch (type) {
    case 'session_runtime_status': {
      // The engine's turn lifecycle is the authority
      // for the running indicator. `active` opens the turn under the id the engine named;
      // `idle` settles it. An idle frame for a foreign turn is ignored so it cannot erase a
      // turn the renderer is still legitimately streaming.
      const turnId = typeof event.turnId === 'string' && event.turnId ? event.turnId : null
      if (event.status === 'active') {
        patchSession(sessionId, prev => {
          if (prev.activeTurnId && turnId && prev.activeTurnId !== turnId && prev.running) return {}
          const submittedAt = adoptPendingUserTurn(sessionId)
          const startedAt = submittedAt ?? (prev.turnStartedAt || Date.now())
          const continuation = turnId && beginTaskTurn(sessionId, { turnId, goalContinuation: event.goalContinuation, inputOrigin: event.inputOrigin, goalId: event.goalId })
          return {
            running: true,
            goalContinuationId: continuation ? event.goalId : null,
            streamMode: prev.streamMode === 'idle' ? 'requesting' : prev.streamMode,
            activityVisible: !prev.thinkingActive,
            activeTurnId: turnId || prev.activeTurnId,
            liveTurnId: turnId || prev.liveTurnId,
            turnStartedAt: startedAt,
            ...(turnId && submittedAt != null ? { turnWorkStartedAtMs: { ...prev.turnWorkStartedAtMs, [turnId]: submittedAt } } : {}),
          }
        })
        break
      }
      if (event.status === 'idle') {
        if (unadmittedUserTurn(sessionId)) break
        patchSession(sessionId, prev => {
          if (prev.activeTurnId && turnId && prev.activeTurnId !== turnId) return {}
          if (!prev.running && !prev.activityVisible && !prev.thinkingActive && prev.activeTurnId == null) return {}
          // A stop's own idle frame lands BEFORE the engine's interrupted
          // verdict: the host settles its registry optimistically on the click.
          // Settling the renderer here as well clears the Turn's start stamp and
          // re-opens history reads while the live layer still holds the
          // interrupted Turn's partial output and optimistic bubble; a disk read
          // that is empty or ahead of the rollout flush then erases the message
          // the user just typed. The stop window (request recorded, verdict not
          // in) and a settled interrupted Turn both defer the frame: the
          // interrupted event settles this state a moment later, and a drifted
          // session whose interrupted word never arrives still converges
          // through the working-registry reconciliation.
          if (prev.interruptedLiveTurn != null || prev.stopRequestedAt != null) return {}
          const thinkingPatch = finalizeThinking(prev)
          return {
            ...thinkingPatch,
            running: false,
            goalContinuationId: null,
            streamMode: 'idle',
            activityVisible: false,
            activeTurnId: null,
            turnStartedAt: 0,
            liveUnits: sealTail((thinkingPatch.liveUnits as LiveUnit[]) || prev.liveUnits),
            historyStale: true,
          }
        })
      }
      break
    }
    case 'model_update':
      patchSession(sessionId, prev => ({ modelUpdate: nextModelUpdate(prev.modelUpdate, event) }))
      break
    case 'user_message': {
      const uuid = event.message?.uuid
      const steered = event.message?.message?.steered === true
      const questionAnswer = event.message?.message?.questionAnswer
      const current = getSessionStream(sessionId)
      if (uuid) {
        const owned = current.liveUnits.find(unit => unit.type === 'live-user' && unit.msg.uuid === uuid)
        if (owned && owned.type === 'live-user') {
          // A steer this renderer sent is painted before the canonical frame arrives.
          // The frame is the authority on what the row IS, so merge its `steered` flag
          // into the existing bubble; keeping only the local copy would leave the edit
          // gate treating an injection as a turn opener.
          if ((steered || questionAnswer) && owned.msg.steered !== true) {
            patchSession(sessionId, prev => ({
              liveUnits: prev.liveUnits.map(unit => unit.type === 'live-user' && unit.msg.uuid === uuid
                ? { ...unit, msg: { ...unit.msg, steered: true, ...(questionAnswer ? { questionAnswer } : {}) } } : unit),
            }))
          }
          break
        }
        if (current.history?.some(message => message.role === 'user' && message.uuid === uuid)) break
      }
      resetTaskContinuation(sessionId)
      // Channel 起源的 user 回合：存原始消息形状，渲染层与历史 user 同分流。
      // The event projection already strips a steer history marker and stamps the row
      // `steered`; the flag rides into the live unit so the edit-target rule treats an
      // injection into a running turn differently from a turn opener.
      const content = event.message?.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((b: any) => b && b.type === 'text').map((b: any) => b.text || '').join('')
          : ''
      const contentBlocks = Array.isArray(content) ? content : []

      // Channel frames carry the display snapshot inline; history replay restores the same
      // shape from the engine's provider-invisible metadata row, so both paths render one
      // human-facing text instead of the model-facing envelope.
      const rawRender = event.message?.message?.localRender
      const localRender = rawRender !== undefined && typeof rawRender === 'object' && !Array.isArray(rawRender)
        ? rawRender as Record<string, unknown> : null
      patchSession(sessionId, prev => ({
        goalContinuationId: null,
        liveUnits: event.message?.uuid && (prev.liveUnits.some(unit => unit.type === 'live-user' && unit.msg.uuid === event.message.uuid)
          || prev.history?.some(message => message.role === 'user' && message.uuid === event.message.uuid)) ? prev.liveUnits : [...sealTail(prev.liveUnits), {
          type: 'live-user', key: nextKey('u'),
          msg: {
            role: 'user', text, contentBlocks,
            timestamp: Date.parse(event.message?.timestamp || '') || undefined,
            uuid: event.message?.uuid,
            ...(localRender ? { localRender } : {}),
            ...(steered ? { steered: true } : {}),
            ...(questionAnswer ? { questionAnswer, steered: true } : {}),
          },
          turnId: questionAnswer?.turnId || event.turnId || prev.activeTurnId || undefined,
        }],
      }))
      break
    }
    case 'text_delta':
      patchSession(sessionId, prev => {
        // 文本开始 = 思考收尾（对齐 paintStreamText 的 finalize 兜底）+ activity 隐。
        const thinkingPatch = finalizeThinking(prev)
        const units = [...((thinkingPatch.liveUnits as LiveUnit[]) || prev.liveUnits)]
        const messageId = typeof event.messageId === 'string' && event.messageId ? event.messageId : undefined
        const phase = event.phase === 'commentary' || event.phase === 'final_answer' ? event.phase : undefined
        const inference = inferenceSnapshot(event.inference) || prev.currentInference || undefined
        const lastIndex = lastConversationUnitIndex(units)
        const last = units[lastIndex]
        if (last?.type === 'live-text' && last.streaming && (!messageId || !last.messageId || last.messageId === messageId)
          && last.inference?.revision === inference?.revision && last.inference?.changeId === inference?.changeId) {
          units[lastIndex] = { ...last, text: last.text + (event.text || ''),
            messageId: messageId || last.messageId, phase: phase || last.phase }
        } else {
          // A new message settles the preceding one even when child lifecycle
          // notices arrived between its last delta and this message boundary.
          if (last?.type === 'live-text' && last.streaming) units[lastIndex] = { ...last, streaming: false }
          units.push({ type: 'live-text', key: messageId ? `message:${messageId}${units.some(unit => unit.type === 'live-text' && unit.messageId === messageId) ? `:segment:${units.filter(unit => unit.type === 'live-text' && unit.messageId === messageId).length}` : ''}` : nextKey('tx'),
            text: event.text || '', streaming: true, messageId, startedAtMs: Date.now(), phase, inference })
        }
        return { ...thinkingPatch, ...completedWorkClock(prev, units, event.turnId || prev.activeTurnId || prev.liveTurnId), liveUnits: units, activityVisible: false, goalContinuationId: null }
      })
      break
    case 'thinking_delta':
      patchSession(sessionId, prev => ({
        goalContinuationId: null,
        thinkingActive: true,
        thinkingText: prev.thinkingText + (event.thinking || ''),
        // 首条 delta 才起表；起点取 requesting 时刻（OpenAI 摘要成串到达时长恒 0 的修正）。
        thinkingStartTime: prev.thinkingActive ? prev.thinkingStartTime : (prev.thinkingRequestStart || Date.now()),
        thinkingRequestStart: prev.thinkingActive ? prev.thinkingRequestStart : 0,
        // thinking 盒出现 → activity 隐（对齐 thinkingUI.show 里的 hide）。
        activityVisible: false,
        // thinking 前收口上一段 text（对齐 thinkingUI.show 里的 finalizeStream）。
        liveUnits: prev.thinkingActive ? prev.liveUnits : sealTail(prev.liveUnits),
      }))
      break
    case 'stream_mode':
      patchSession(sessionId, prev => {
        if (event.mode === 'requesting') {
          const turnId = (typeof event.turnId === 'string' && event.turnId) ? event.turnId : prev.activeTurnId
          const startedNewTurn = !!turnId && turnId !== prev.activeTurnId
          const submittedAt = adoptPendingUserTurn(sessionId)
          const startedAt = submittedAt ?? (startedNewTurn || !prev.turnStartedAt ? Date.now() : prev.turnStartedAt)
          return {
            streamMode: 'requesting',
            currentInference: inferenceSnapshot(event.inference),
            liveUnits: sealTail(prev.liveUnits),
            thinkingRequestStart: Date.now(),
            activityVisible: true,
            activeTurnId: turnId,
            liveTurnId: turnId,
            interruptedLiveTurn: null,
            lastTerminalStatus: null,
            turnStartedAt: startedAt,
            ...(turnId && submittedAt != null ? { turnWorkStartedAtMs: { ...prev.turnWorkStartedAtMs, [turnId]: submittedAt } } : {}),
            stopRequestedAt: startedNewTurn ? null : prev.stopRequestedAt,
          }
        }
        if (event.mode === 'responding') {
          return { ...finalizeThinking(prev), streamMode: 'responding', activityVisible: false, goalContinuationId: null }
        }
        if (event.mode === 'tool-use') {
          const thinkingPatch = finalizeThinking(prev)
          return {
            ...thinkingPatch,
            streamMode: 'tool-use',
            goalContinuationId: null,
            liveUnits: sealTail((thinkingPatch.liveUnits as LiveUnit[]) || prev.liveUnits),
            activityVisible: prev.running,
          }
        }
        return {}
      })
      break
    case 'tool_start': {
      if (isTaskMutationTool(event.toolName)) {
        patchSession(sessionId, () => ({ goalContinuationId: null }))
        break
      }
      patchSession(sessionId, prev => {
        const thinkingPatch = finalizeThinking(prev)
        let units = sealTailText((thinkingPatch.liveUnits as LiveUnit[]) || prev.liveUnits)
        const name = (event.toolName || '').toLowerCase()
        const agent = /agent/i.test(event.toolName || '')
          || name === 'task'
          || name === 'task_stop'
          || name === 'send_input'
          || name === 'send_message'
        const card: ToolCardState = {
          toolCallId: event.toolCallId,
          inference: inferenceSnapshot(event.inference) || prev.currentInference || undefined,
          toolName: event.toolName,
          args: event.args,
          argsDelta: '',
          progress: [],
          status: 'running', startedAtMs: Date.now(),
          agent,
          bgTask: !!(event.args?.run_in_background || event.args?.persistent),
        }
        const last = units[units.length - 1]
        if (last?.type === 'live-tools' && !last.sealed) {
          units = [...units.slice(0, -1), { ...last, order: [...last.order, event.toolCallId] }]
        } else {
          units = [...units, { type: 'live-tools', key: nextKey('tc'), order: [event.toolCallId], sealed: false }]
        }
        return {
          ...thinkingPatch,
          goalContinuationId: null,
          liveUnits: units,
          tools: { ...prev.tools, [event.toolCallId]: card },
          // The tool row describes what is running; the trailing activity dots
          // still show that the Turn has not yielded control back to the user.
          activityVisible: prev.running,
        }
      })
      break
    }
    case 'tool_input_delta':
      patchSession(sessionId, prev => {
        const card = prev.tools[event.toolCallId]
        if (!card) return {}
        // 旧版 updateToolArgs 用完整 JSON 重渲参数区并补 bgTask 标记。
        let args = card.args
        let bgTask = card.bgTask
        try {
          const parsed = JSON.parse(event.delta || '')
          args = parsed
          bgTask = !!(parsed?.run_in_background || parsed?.persistent)
        } catch { return {} }
        return { tools: { ...prev.tools, [event.toolCallId]: { ...card, args, bgTask, argsDelta: card.argsDelta + (event.delta || '') } } }
      })
      break
    case 'progress':
      patchSession(sessionId, prev => {
        const card = prev.tools[event.toolCallId]
        if (!card || card.agent) return {}
        return { tools: { ...prev.tools, [event.toolCallId]: { ...card, progress: [...card.progress, event.content] } } }
      })
      break
    case 'tool_end':
      patchSession(sessionId, prev => {
        const card = prev.tools[event.toolCallId]
        if (!card) {
          // A reopened conversation owns earlier calls in history. Settle that
          // existing row without creating a duplicate live tool card.
          const results = historyToolResults.get(sessionId) || new Map()
          results.set(event.toolCallId, { turnId: event.turnId, result: {
            content: [
              { type: 'text', text: typeof event.content === 'string' ? event.content : '' },
              ...(Array.isArray(event.media) ? event.media.filter((item: any) => typeof item?.path === 'string').map((item: any) => ({ type: 'image', ...item })) : []),
            ],
            is_error: event.isError === true,
            ...(event.artifact ? { artifact: event.artifact } : {}),
          } })
          historyToolResults.set(sessionId, results)
          const history = mergeHistoryToolResults(sessionId, prev.history)
          return { ...(history !== prev.history ? { history } : {}), activityVisible: prev.running }
        }
        const runtime = activityShellResult({ toolCallId: card.toolCallId, toolName: card.toolName, args: card.args, state: 'done', output: event.content, durationMs: event.durationMs, exitCode: event.exitCode })
        const media = Array.isArray(event.media)
          ? event.media.filter((entry: any) => entry && typeof entry.path === 'string' && entry.path)
          : []
        // One normalization rule, shared with the replay path (factories.ts), so a
        // live card and a reloaded card for the same tool result cannot diverge.
        const artifact = event.isError ? undefined : normalizeVisualArtifact(event.artifact)
        return {
          tools: {
            ...prev.tools,
            [event.toolCallId]: {
              ...card,
              status: event.isError
                ? (interruptAttributed(prev) ? 'interrupted' : 'error')
                : 'ok',
              // Only a request still awaiting its verdict is provisional. Once the
              // Turn is confirmed interrupted the attribution is already final.
              ...(event.isError && prev.stopRequestedAt != null && prev.interruptedLiveTurn == null
                ? { stopWindowFailure: true as const }
                : {}),
              ...(typeof event.content === 'string' ? { content: event.content } : {}),
              ...(typeof runtime.exitCode === 'number' ? { exitCode: runtime.exitCode } : {}),
              ...(typeof runtime.durationMs === 'number' ? { durationMs: runtime.durationMs } : card.startedAtMs ? { durationMs: Math.max(0, Date.now() - card.startedAtMs) } : {}),
              ...(media.length ? { media } : {}),
              ...(artifact ? { artifact } : {}),
            },
          },
          activityVisible: prev.running,
        }
      })
      break
    case 'approval_review_strict_required': {
      const startedAtMs = Number(event.startedAtMs)
      if (!Number.isFinite(startedAtMs) || typeof event.turnId !== 'string') break
      patchSession(sessionId, prev => {
        const old = prev.liveUnits.findLast(unit => unit.type === 'live-approval-review-notice' && unit.kind === 'strictReviewRequired' && unit.turnId === event.turnId)
        if (old?.type === 'live-approval-review-notice' && startedAtMs - old.startedAtMs < 10_000) return {}
        return { liveUnits: [...sealTail(prev.liveUnits), { type: 'live-approval-review-notice', key: `strict-review:${event.turnId}:${startedAtMs}`, turnId: event.turnId, kind: 'strictReviewRequired', startedAtMs }] }
      })
      break
    }
    case 'approval_review_warning': {
      if (event.kind !== 'tooManyDenials' && !String(event.message ?? '').startsWith('Automatic approval review rejected too many approval requests for this turn')) break
      patchSession(sessionId, prev => ({ liveUnits: [...sealTail(prev.liveUnits), { type: 'live-approval-review-notice', key: nextKey('review-warning'), kind: 'tooManyDenials', startedAtMs: Date.now(), ...(prev.activeTurnId ? { turnId: prev.activeTurnId } : {}) }] }))
      break
    }
    case 'approval_review': {
      const review = approvalReview(event.review)
      if (!review) break
      const previous = getSessionStream(sessionId)
      const live = previous.liveUnits.find(unit => unit.type === 'live-approval-review' && unit.review.reviewId === review.reviewId)
      const saved = previous.history?.find(message => message.kind === 'approval-review' && message.approvalReview?.reviewId === review.reviewId)
      const existing = live?.type === 'live-approval-review' ? live.review : approvalReview(saved?.approvalReview)
      if (existing && (existing.turnId !== review.turnId || existing.targetItemId !== review.targetItemId
        || existing.status !== 'inProgress' && review.status === 'inProgress')) break
      patchSession(sessionId, prev => {
        const old = prev.liveUnits.find(unit => unit.type === 'live-approval-review' && unit.review.reviewId === review.reviewId)
        if (old?.type === 'live-approval-review' && (old.review.turnId !== review.turnId || old.review.targetItemId !== review.targetItemId
          || old.review.status !== 'inProgress' && review.status === 'inProgress')) return {}
        const held = old?.type === 'live-approval-review' ? old : saved
        const authoritative = event.rawReview !== undefined || held?.rawReviewAuthoritative === true
        const rawReview = event.rawReview ?? (held?.rawReviewAuthoritative ? held.rawReview : approvalReviewEvent(review))
        if (saved) return { history: prev.history?.map(message => message === saved ? { ...message, approvalReview: { ...message.approvalReview, ...review }, rawReview, rawReviewAuthoritative: authoritative } : message), liveUnits: prev.liveUnits.filter(unit => unit !== old) }
        const unit: LiveUnit = { type: 'live-approval-review', key: `review:${review.reviewId}`, review, turnId: review.turnId, rawReview, rawReviewAuthoritative: authoritative }
        return { liveUnits: old ? prev.liveUnits.map(row => row === old ? unit : row) : [...sealTail(prev.liveUnits), unit] }
      })
      break
    }
    case 'notice':
      patchSession(sessionId, prev => ({
        liveUnits: [...sealTail(prev.liveUnits), { type: 'live-notice', key: nextKey('nt'), text: String(event.content ?? '') }],
      }))
      break
    case 'api_retry':
      patchSession(sessionId, prev => ({
        liveUnits: [...sealTail(prev.liveUnits), { type: 'live-retry', key: nextKey('rt'), attempt: event.attempt, maxRetries: event.maxRetries, phase: typeof event.phase === 'string' ? event.phase : undefined }],
      }))
      break
    case 'provider_status': {
      const kind = String(event.kind ?? '')
      if (event.retryable === true && (kind === 'rate_limit' || kind === 'overloaded')) {
        patchSession(sessionId, prev => ({
          liveUnits: [...sealTail(prev.liveUnits), { type: 'live-congestion', key: nextKey('cg'), kind }],
        }))
      }
      break
    }
    case 'auth_required':
      patchSession(sessionId, prev => ({
        liveUnits: [...sealTail(prev.liveUnits), {
          type: 'live-auth', key: nextKey('auth'),
          reason: String(event.reason || ''), mode: String(event.mode || ''),
        }],
      }))
      break
    case 'api_error':
      patchSession(sessionId, prev => ({
        activityVisible: false,
        ...(context.userInterrupted ? {} : {
          liveUnits: [...sealTail(prev.liveUnits), { type: 'live-error', key: nextKey('er'), text: String(event.error ?? '').trim(), kind: typeof event.kind === 'string' ? event.kind : undefined, retryAfterMs: typeof event.retryAfterMs === 'number' ? event.retryAfterMs : undefined, errorDetails: detailsForApiError(event) }],
        }),
      }))
      break
    case 'file':
      if (event.name && event.url) {
        patchSession(sessionId, prev => ({
          liveUnits: [...sealTail(prev.liveUnits), { type: 'live-file', key: nextKey('fl'), name: event.name, url: event.url }],
        }))
      }
      break
    case 'tombstone':
      // 流式回退：丢当前 partial 文本单元（对齐 tombstone 的三件套清理）。
      patchSession(sessionId, prev => {
        const last = prev.liveUnits[prev.liveUnits.length - 1]
        if (last?.type === 'live-text' && last.streaming) {
          return { liveUnits: prev.liveUnits.slice(0, -1) }
        }
        return {}
      })
      break
    // 引擎撤销待处理审批/追问（如用户 Stop）：卡降为终态。AskUser 卡的撤销
    // 对齐旧版 finalizeQuestionCard(card, 'skipped')，其余按 cancelled 收。
    case 'permission_cancelled':
      resolveLiveApproval(sessionId, event.requestId, (unit: LiveUnit) =>
        unit.type === 'live-ask' ? { mode: 'skipped', answers: {} }
          : unit.type === 'live-plan-review' || unit.type === 'live-execution-mode' ? { decision: 'cancelled' }
            : { decision: 'cancelled', allowSession: false, savedRules: false })
      break
    case 'elicit_cancelled':
      resolveLiveApproval(sessionId, event.requestId, (unit: LiveUnit) =>
        unit.type === 'live-ask' ? { mode: 'skipped', answers: {} }
          : unit.type === 'live-execution-mode' ? { decision: 'cancelled' }
            : 'cancelled')
      break
    case 'session_title_updated':
      patchSession(sessionId, () => ({ title: typeof event.title === 'string' ? event.title : null }))
      break
    // Persisted changes invalidate history; compaction also updates its live status.
    case 'message_complete':
      patchSession(sessionId, prev => {
        const messageId = typeof event.messageId === 'string' ? event.messageId : ''
        if (!messageId) return { historyStale: true }
        const units = [...prev.liveUnits]
        for (let index = units.length - 1; index >= 0; index--) {
          if (units[index].type !== 'live-text') continue
          const unit = units[index] as Extract<LiveUnit, { type: 'live-text' }>
          if (unit.messageId && unit.messageId !== messageId) continue
          const phase = event.phase === 'commentary' || event.phase === 'final_answer' ? event.phase : unit.phase
          // The settle frame carries the page content the host read under the
          // visualization whitelist, so the mounted frame needs no second read.
          const inlineVis = Array.isArray(event.inlineVis) ? event.inlineVis as InlineVisFragment[] : unit.inlineVis
          units[index] = { ...unit, messageId, phase, streaming: false, ...(inlineVis?.length ? { inlineVis } : {}) }
          break
        }
        return { historyStale: true, ...completedWorkClock(prev, units, event.turnId || prev.activeTurnId || prev.liveTurnId), liveUnits: units }
      })
      break
    case 'compaction_start':
      patchSession(sessionId, prev => {
        const trigger = typeof event.trigger === 'string' && event.trigger ? event.trigger : 'manual'
        return {
          historyStale: true, compactionPendingTrigger: trigger,
          liveUnits: prev.liveUnits.some(unit => unit.type === 'live-compaction' && unit.state === 'running')
            ? prev.liveUnits : [...sealTail(prev.liveUnits), { type: 'live-compaction', key: nextKey('compaction'), trigger, state: 'running' }],
        }
      })
      break
    case 'compact_boundary':
      patchSession(sessionId, prev => ({
        historyStale: true, compactionPendingTrigger: null,
        liveUnits: prev.liveUnits.some(unit => unit.type === 'live-compaction' && unit.state === 'running')
          ? prev.liveUnits.map(unit => unit.type === 'live-compaction' && unit.state === 'running' ? { ...unit, state: 'completed' as const } : unit)
          : [...prev.liveUnits, { type: 'live-compaction', key: nextKey('compaction'), trigger: event.trigger || 'auto', state: 'completed' }],
      }))
      break
    case 'compaction_end':
      // Only a boundary proves history was compacted; a no-op also emits end.
      patchSession(sessionId, prev => ({ historyStale: true, compactionPendingTrigger: null,
        liveUnits: prev.liveUnits.filter(unit => unit.type !== 'live-compaction' || unit.state === 'completed') }))
      break
    // Worktree init is a host-side step ahead of the first Turn, not engine
    // activity: it owns a field, not a live unit, so the row survives the
    // live→history handoff without a duplicate-render window.
    case 'worktree_init_start':
      patchSession(sessionId, () => ({ worktreeInit: { status: 'running' } }))
      break
    case 'worktree_init_completed':
      patchSession(sessionId, () => ({ worktreeInit: { status: 'completed' } }))
      break
    case 'worktree_init_failed':
      patchSession(sessionId, () => ({ worktreeInit: { status: 'failed' } }))
      break
    case 'follow_up_status': {
      const messageId = typeof event.messageId === 'string' ? event.messageId : ''
      if (!messageId) break
      const key = `follow-up-status-${messageId}`
      patchSession(sessionId, prev => {
        const liveUnits = prev.liveUnits.filter(unit => unit.key !== key)
        if (event.state === 'pending' || event.state === 'unconfirmed') {
          const text = event.state === 'pending' ? t('follow_up_engine_pending_notice') : t('follow_up_unconfirmed_notice')
          liveUnits.push({ type: 'live-notice', key, text })
        } else if (event.state === 'failed') {
          liveUnits.push({ type: 'live-error', key, text: event.error || t('follow_up_failed') })
        }
        return { liveUnits }
      })
      // A delegated steer the engine drained into this RUNNING turn: insert its
      // bubble at the arrival position now, because the envelope itself rides
      // the turn's last tool result and that card's terminal event already
      // passed (see the live-delegation unit). Human follow-ups carry no
      // delegation payload and stay out of the transcript here.
      const delegation = event.delegation
      if (event.state !== 'applied' || !delegation || typeof delegation.input !== 'string') break
      patchSession(sessionId, prev => {
        if (prev.liveUnits.some(unit => unit.type === 'live-delegation' && unit.messageId === messageId)) return {}
        return { liveUnits: [...sealTail(prev.liveUnits), { type: 'live-delegation', key: `delegation-${messageId}`, messageId, delegation }] }
      })
      break
    }
  }
}

// 只收口 text（tool_start 的块边界语义：文本定格，但当前 tools 容器可继续收卡）。
function sealTailText(units: LiveUnit[]): LiveUnit[] {
  const index = lastConversationUnitIndex(units)
  const last = units[index]
  if (last?.type === 'live-text' && last.streaming) {
    return units.map((unit, position) => position === index ? { ...last, streaming: false } : unit)
  }
  return units
}

// ==================== live 审批卡（回调通道，非 chatEvent）====================
// chat.js 的 showPermissionRequest/showElicitRequest 在路由后（auto-allow/
// 后台排队分支之外，确定挂到当前会话）转发入 store；处理/撤销经 resolve
// 同步终态。路由逻辑随切默认一并迁入。

/**
 * 本地乐观 user 气泡（submitTurnPayload 的 renderLocalUserPayload 等价）：
 * send 后引擎不回发 user_message，气泡由本地挂 live-user 单元；localRender
 * 携带显式渲染面（displayText/pastedCards/引用/附件实体/slash 命令）。
 * 同时点亮运行态与活动指示器（对齐 setSessionRunning(true) + turnActivityUI.show()）。
 */
export interface LocalUserTurnPayload {
  text: string
  uuid?: string
  /** True for a message the host steered into a running turn rather than a new opener. */
  steered?: boolean
  attachments?: any[]
  slashCommand?: any
  composerReferences?: any[]
  composerDocument?: unknown
  displayText?: unknown
  pastedCards?: any[]
  selectedTextAttachments?: any[]
  timestamp?: number
}

function localUserUnit(payload: LocalUserTurnPayload): Extract<LiveUnit, { type: 'live-user' }> {
  return {
    type: 'live-user', key: nextKey('u'),
    msg: {
      role: 'user', text: payload.text, contentBlocks: [],
      uuid: payload.uuid,
      // A steer is an injection into a running turn, not the message that opened it.
      // The flag has to be set when the bubble is drawn: the host's canonical
      // `user_message` frame carries it, but that frame is skipped once this local
      // bubble exists under the same uuid.
      ...(payload.steered ? { steered: true } : {}),
      timestamp: typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp) && payload.timestamp > 0
        ? payload.timestamp : Date.now(),
      localRender: {
        attachments: payload.attachments || [],
        slashCommand: payload.slashCommand ?? null,
        composerReferences: payload.composerReferences || [],
        ...(payload.composerDocument ? { composerDocument: payload.composerDocument } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'displayText') ? { displayText: payload.displayText } : {}),
        ...(Array.isArray(payload.pastedCards) ? { pastedCards: payload.pastedCards } : {}),
        ...(Array.isArray(payload.selectedTextAttachments) ? { selectedTextAttachments: payload.selectedTextAttachments } : {}),
      },
    },
  }
}

/** Publish a submitted snapshot before any asynchronous host preparation begins. */
export function beginPendingUserTurn(sessionId: string, payload: LocalUserTurnPayload, options: { provisional?: boolean; messageAlreadyVisible?: boolean } = {}): void {
  const uuid = payload.uuid
  if (!sessionId || !uuid || isSessionStreamRetired(sessionId) || pendingUserTurn(sessionId, uuid)) return
  const before = getSessionStream(sessionId)
  const timestamp = typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp) && payload.timestamp > 0
    ? payload.timestamp : Date.now()
  const existing = before.liveUnits.find(unit => unit.type === 'live-user' && unit.msg.uuid === uuid)
  const unit: LiveUnit = { ...(existing ?? localUserUnit({ ...payload, timestamp })), pendingUserTurn: uuid }
  const record: PendingUserTurn = { aliases: new Set([uuid]), uuid, key: unit.key, startedAt: timestamp,
    before: pendingRuntime(before), ownsRuntime: !before.running && !before.activeTurnId, observed: false, accepted: false }
  const turns = pendingUserTurns.get(sessionId) ?? new Map<string, PendingUserTurn>()
  turns.set(uuid, record); pendingUserTurns.set(sessionId, turns)
  patchSession(sessionId, prev => ({
    ...(options.provisional ? { provisional: true, history: [], historyStale: false, historyLoading: false, historyLoadFailed: false } : {}),
    ...(record.ownsRuntime ? { running: true, streamMode: 'requesting' as const, activityVisible: true, liveTurnId: null,
      currentInference: null, turnStartedAt: timestamp, interruptedLiveTurn: null, lastTerminalStatus: null, stopRequestedAt: null } : {}),
    liveUnits: options.messageAlreadyVisible ? prev.liveUnits : existing ? prev.liveUnits.map(row => row.key === unit.key ? unit : row)
      : prev.history?.some(row => row.role === 'user' && row.uuid === uuid) ? prev.liveUnits : [...sealTail(prev.liveUnits), unit],
  }))
}

/** A local submission owns startup until an engine turn adopts it. */
export function hasPendingTurnStart(sessionId: string): boolean {
  return !!unadmittedUserTurn(sessionId)
}

/** Retain one optimistic row's identity while preserving any real events already received. */
export function movePendingUserTurn(sourceId: string, targetId: string, uuid: string): void {
  if (!sourceId || !targetId || sourceId === targetId || isSessionStreamRetired(targetId)) return
  const record = pendingUserTurn(sourceId, uuid)
  if (!record) return
  const source = getSessionStream(sourceId)
  const unit = source.liveUnits.find(row => row.key === record.key && row.type === 'live-user')
  const target = getSessionStream(targetId)
  const sourceRuntime = record.before, restoreSourceRuntime = record.ownsRuntime && !record.observed
  forgetPendingUserTurn(sourceId, record)
  const turns = pendingUserTurns.get(targetId) ?? new Map<string, PendingUserTurn>()
  turns.set(record.uuid, record); pendingUserTurns.set(targetId, turns)
  record.before = pendingRuntime(target)
  record.ownsRuntime = !target.running && !target.activeTurnId && !target.lastTerminalStatus
  record.observed = !!target.activeTurnId || !!target.lastTerminalStatus
  streamTransactions.transact(() => {
    patchSession(targetId, prev => {
      const duplicate = prev.liveUnits.find(row => row.type === 'live-user' && row.msg.uuid === record.uuid)
      const saved = prev.history?.some(row => row.role === 'user' && row.uuid === record.uuid)
      const row = unit?.type === 'live-user' ? { ...unit, ...(duplicate?.turnId ? { turnId: duplicate.turnId } : {}),
        msg: { ...unit.msg, ...(duplicate?.type === 'live-user' ? duplicate.msg : {}), timestamp: record.startedAt,
          ...(unit.msg.localRender ? { localRender: unit.msg.localRender } : {}) } } : undefined
      const liveUnits = !row || saved ? prev.liveUnits : duplicate
        ? prev.liveUnits.map(item => item === duplicate ? row : item) : [row, ...prev.liveUnits]
      return { liveUnits,
        ...(record.ownsRuntime ? { running: true, streamMode: 'requesting' as const, activityVisible: true,
          turnStartedAt: record.startedAt, interruptedLiveTurn: null, lastTerminalStatus: null, stopRequestedAt: null } : {}),
        ...(record.observed && target.activeTurnId ? { turnStartedAt: record.startedAt,
          turnWorkStartedAtMs: { ...prev.turnWorkStartedAtMs, [target.activeTurnId]: record.startedAt },
          ...completedWorkClock(prev, liveUnits, target.activeTurnId) } : {}),
      }
    })
    if (source.provisional) {
      chatStreamStore.setState(state => { const sessions = { ...state.sessions }; delete sessions[sourceId]; return { sessions } })
      retainedStreams.delete(sourceId); historyReadTokens.delete(sourceId); historyInFlight.delete(sourceId)
    } else patchSession(sourceId, prev => ({ liveUnits: prev.liveUnits.filter(row => row.key !== record.key),
      ...(restoreSourceRuntime ? sourceRuntime : {}) }))
  })
  rememberStream(targetId)
}

/** Goal receipts can arrive after their authoritative user frame; keep the original row key. */
export function bindPendingUserTurn(sessionId: string, uuid: string, newUuid: string): void {
  const record = pendingUserTurn(sessionId, uuid)
  if (!record || !newUuid) return
  const turns = pendingUserTurns.get(sessionId)!
  turns.delete(record.uuid); record.aliases.add(newUuid); record.uuid = newUuid; turns.set(newUuid, record)
  patchSession(sessionId, prev => {
    const owned = prev.liveUnits.find(row => row.key === record.key && row.type === 'live-user')
    if (!owned || owned.type !== 'live-user') return {}
    const duplicate = prev.liveUnits.find(row => row.key !== record.key && row.type === 'live-user' && row.msg.uuid === newUuid)
    const saved = prev.history?.some(row => row.role === 'user' && row.uuid === newUuid)
    const bound = { ...owned, pendingUserTurn: newUuid, ...(duplicate?.turnId ? { turnId: duplicate.turnId } : {}),
      msg: { ...owned.msg, ...(duplicate?.type === 'live-user' ? duplicate.msg : {}), uuid: newUuid,
        timestamp: record.startedAt, ...(owned.msg.localRender ? { localRender: owned.msg.localRender } : {}) } }
    return { liveUnits: prev.liveUnits.flatMap(row => row === duplicate || saved && row === owned ? [] : [row === owned ? bound : row]) }
  })
}

/** Settle only this submit's synthetic state; real lifecycle events remain authoritative. */
export function finishPendingUserTurn(sessionId: string, uuid: string, outcome: 'accepted' | 'cancelled' | 'failed', error?: string): void {
  const record = pendingUserTurn(sessionId, uuid)
  if (!record) return
  if (outcome === 'accepted') {
    record.accepted = true
    if (record.observed || !record.ownsRuntime) forgetPendingUserTurn(sessionId, record)
  } else forgetPendingUserTurn(sessionId, record)
  patchSession(sessionId, prev => ({
    ...(outcome !== 'accepted' && record.ownsRuntime && !record.observed ? record.before : {}),
    liveUnits: prev.liveUnits.flatMap(row => {
      if (row.key !== record.key) return [row]
      if (outcome === 'cancelled') return []
      const { pendingUserTurn: _pending, ...settled } = row
      return [settled as LiveUnit]
    }).concat(outcome === 'failed' && error?.trim() ? [{ type: 'live-error', key: nextKey('submit-error'), text: error.trim(), submissionUuid: record.uuid }] : []),
  }))
}

/** Dismissing a local failure never removes a user message adopted by an active turn. */
export function discardPendingUserTurn(sessionId: string, uuid: string): void {
  patchSession(sessionId, prev => ({ liveUnits: prev.liveUnits.filter(unit =>
    !(unit.type === 'live-error' && unit.submissionUuid === uuid)
    && !(unit.type === 'live-user' && unit.msg.uuid === uuid && !unit.turnId)) }))
}

export function ingestLocalUserTurn(sessionId: string, payload: LocalUserTurnPayload): void {
  if (!sessionId) return
  pendingEditedTurns.delete(sessionId)
  patchSession(sessionId, prev => ({
    running: true,
    currentInference: null,
    activityVisible: true,
    turnStartedAt: Date.now(),
    interruptedLiveTurn: null,
    lastTerminalStatus: null,
    stopRequestedAt: null,
    liveUnits: [...sealTail(prev.liveUnits), localUserUnit(payload)],
  }))
}

/**
 * Undo an optimistic user turn that `ingestLocalUserTurn` placed when the
 * submit it was covering never went out — the worktree-init path paints the
 * bubble before its host round-trip so the wait is visible, and a failed
 * creation has to give the composer back exactly as the user left it.
 * Only the optimistic rows go: units the engine contributed in the meantime
 * (tool cards, approvals) keep the session's running state truthful.
 */
export function retractLocalUserTurn(sessionId: string): void {
  if (!sessionId) return
  patchSession(sessionId, prev => {
    const remaining = prev.liveUnits.filter(unit => unit.type !== 'live-user')
    if (remaining.length === prev.liveUnits.length) return {}
    return {
      liveUnits: remaining,
      running: remaining.length ? prev.running : false,
      activityVisible: remaining.length ? prev.activityVisible : false,
    }
  })
}

export interface EditedUserTurnSnapshot {
  uuid: string
  turnId: string
  droppedKeys: ReadonlySet<string>
  replacementTurnId: string | null
}

const pendingEditedTurns = new Map<string, { snapshot: EditedUserTurnSnapshot; accepted: boolean }>()

/** Observe the core turn identity even if history handoff clears it before the ACK. */
export function observeEditedUserTurn(sessionId: string, handle: { uuid: string; turnId: string }, droppedKeys: ReadonlySet<string>) {
  const before = getSessionStream(sessionId)
  const snapshot: EditedUserTurnSnapshot = {
    uuid: handle.uuid,
    turnId: handle.turnId || before.history?.find(message => message.uuid === handle.uuid)?.turnId || before.liveTurnId || '',
    droppedKeys,
    replacementTurnId: null,
  }
  const pending = { snapshot, accepted: false }
  pendingEditedTurns.set(sessionId, pending)
  const dispose = () => {
    if (pendingEditedTurns.get(sessionId) === pending && !pending.accepted) pendingEditedTurns.delete(sessionId)
  }
  return { snapshot, dispose }
}

function belongsToEditedTurn(message: { uuid?: string; turnId?: string }, snapshot: EditedUserTurnSnapshot): boolean {
  return !!(snapshot.uuid && message.uuid === snapshot.uuid || snapshot.turnId && message.turnId === snapshot.turnId)
}

/** Accept an edit without erasing replacement events that arrived before its ACK. */
export function commitEditedUserTurn(sessionId: string, snapshot: EditedUserTurnSnapshot, payload: LocalUserTurnPayload): void {
  if (!sessionId) return
  const pending = pendingEditedTurns.get(sessionId)
  if (pending?.snapshot === snapshot) pending.accepted = true
  patchSession(sessionId, prev => {
    const kept = prev.liveUnits.filter(unit => !snapshot.droppedKeys.has(unit.key))
    const replacementTurnId = snapshot.replacementTurnId || [prev.activeTurnId, prev.liveTurnId]
      .find(turnId => turnId && turnId !== snapshot.turnId)
    // Earlier history arriving during the request is not evidence of a replacement.
    // Only the core identity observed from its lifecycle can identify that row.
    const savedReplacement = replacementTurnId && prev.history?.find(message => message.role === 'user'
      && message.turnId === replacementTurnId)
    const targetIndex = prev.history?.findIndex(message => belongsToEditedTurn(message, snapshot)) ?? -1
    // A retained original snapshot may surround already-saved replacement rows.
    // Truncate the old tail only while history has not adopted the replacement.
    const history = savedReplacement ? prev.history!.filter(message => !belongsToEditedTurn(message, snapshot))
      : targetIndex >= 0 ? prev.history!.slice(0, targetIndex) : prev.history
    const replacementStarted = !!replacementTurnId
    const historyOwnsReplacement = !!savedReplacement
      && !kept.some(unit => unit.turnId === savedReplacement.turnId && !('req' in unit))
    const droppedToolIds = new Set(prev.liveUnits
      .filter(unit => snapshot.droppedKeys.has(unit.key) && unit.type === 'live-tools')
      .flatMap(unit => (unit as { order?: string[] }).order ?? []))
    const tools = Object.fromEntries(Object.entries(prev.tools)
      .filter(([toolCallId]) => !droppedToolIds.has(toolCallId)))
    const alreadyHasUser = historyOwnsReplacement || kept.some(unit => unit.type === 'live-user'
      && replacementTurnId && unit.turnId === replacementTurnId && !unit.msg.steered)
    if (historyOwnsReplacement) pendingEditedTurns.delete(sessionId)
    return {
      history: historyOwnsReplacement
        ? mergeSubmittedUserHistory(history!, [{ ...localUserUnit(payload), turnId: replacementTurnId || undefined }], [])
        : history,
      liveUnits: alreadyHasUser ? kept : [{ ...localUserUnit(payload), turnId: replacementTurnId || undefined }, ...kept],
      tools,
      // The host may ACK before any events, or after the replacement already
      // terminated. Only initialize runtime state when it has not started yet.
      ...(!replacementStarted ? {
        running: true, currentInference: null, activityVisible: true,
        activeTurnId: null, liveTurnId: null, turnStartedAt: payload.timestamp || Date.now(),
        interruptedLiveTurn: null, lastTerminalStatus: null, stopRequestedAt: null,
      } : {}),
      historyStale: !historyOwnsReplacement,
    }
  })
}

/**
 * Records the user's stop intent without pretending that the Turn has already
 * ended. The actual terminal transition is driven by the engine's
 * `interrupted` event, which also carries the authoritative Turn identity.
 */
export function requestTurnInterrupt(sessionId: string): void {
  if (!sessionId) return
  patchSession(sessionId, prev => {
    if (!prev.running || prev.stopRequestedAt != null) return {}
    return { stopRequestedAt: Date.now() }
  })
}

export function clearTurnInterruptRequest(sessionId: string): void {
  if (!sessionId) return
  // A refused stop retracts the window as well as the intent: every failure it
  // provisionally blamed on the stop goes back to being the tool's own.
  patchSession(sessionId, prev => ({
    stopRequestedAt: null,
    tools: settleStopWindowFailures(prev.tools, false),
  }))
}

/**
 * Reconcile the renderer's optimistic running state with the shell's live-turn
 * registry. This is the recovery path for a terminal event that did not reach
 * the webview: stop animating first, then let persisted history replace the
 * stale live layer and restore the Turn's completed/failed status.
 */
export function reconcileSessionWorking(sessionId: string, isWorking: boolean): Promise<void> {
  if (!sessionId) return Promise.resolve()
  const current = chatStreamStore.getState().sessions[sessionId]
  if (isWorking) {
    if (current?.running) return Promise.resolve()
    patchSession(sessionId, prev => ({
      running: true,
      streamMode: prev.streamMode === 'idle' ? 'requesting' : prev.streamMode,
      activityVisible: !prev.thinkingActive,
    }))
    return Promise.resolve()
  }
  if (current?.provisional || unadmittedUserTurn(sessionId)) return Promise.resolve()
  if (!current || (!current.running && !current.activityVisible && !current.thinkingActive && current.activeTurnId == null)) {
    return Promise.resolve()
  }
  patchSession(sessionId, prev => {
    const thinkingPatch = finalizeThinking(prev)
    return {
      ...thinkingPatch,
      running: false,
      streamMode: 'idle',
      activityVisible: false,
      asyncQuestions: expireAsyncQuestions(prev.asyncQuestions, prev.activeTurnId),
      activeTurnId: null,
      interruptedLiveTurn: null,
      turnStartedAt: 0,
      stopRequestedAt: null,
      liveUnits: sealTail((thinkingPatch.liveUnits as LiveUnit[]) || prev.liveUnits),
      historyStale: true,
    }
  })
  return loadSessionHistory(sessionId)
}

/**
 * Whether the session's last Turn can be continued without another user message.
 * Both interrupted and failed Turns may have partial work worth preserving; a
 * completed Turn may not. The live terminal status answers immediately, while
 * persisted Turn statuses answer after a reload.
 *
 * "Last Turn" is read from Turn metadata first, and from transcript rows only as
 * the fallback: a Turn killed before it rendered anything — an app relaunch for a
 * permission grant SIGKILLs the engine child mid-Turn — carries a status and a
 * start time but no row, so a row walk alone lands on the Turn before it and
 * offers no way to continue the thread it cut off. Ordering needs
 * `turnStartedAtMs`; a rollout old enough to predate that field has no second
 * signal, so it stays on the row walk.
 */
export function canContinueTurn(sessionId: string): boolean {
  if (!sessionId) return false
  const state = chatStreamStore.getState().sessions[sessionId]
  if (!state || state.running) return false
  if (state.interruptedLiveTurn != null || state.lastTerminalStatus === 'interrupted' || state.lastTerminalStatus === 'failed') return true
  // Once history is current, it is authoritative over a live terminal marker
  // left by an older Turn. This happens when both lifecycle pushes for the next
  // Turn are missed and shell reconciliation restores its failure from disk.
  // While history is stale, keep a live completion authoritative so an older
  // failed Turn cannot briefly re-enable Continue during the reload.
  if (state.lastTerminalStatus === 'completed' && state.historyStale) return false
  const unsettled = (id: string) => state.turnStatuses[id] === 'interrupted' || state.turnStatuses[id] === 'failed'
  const history = state.history || []
  let tailTurnId: string | null = null
  for (let i = history.length - 1; i >= 0; i--) {
    const turnId = (history[i] as any)?.turnId
    if (typeof turnId !== 'string' || !turnId) continue
    tailTurnId = turnId
    break
  }
  if (tailTurnId && unsettled(tailTurnId)) return true
  // A Turn killed before it rendered anything never puts its id on a transcript
  // row, so the walk above lands on the Turn BEFORE it. That is what a restart
  // for a permission grant looks like: the app relaunches, the engine child is
  // SIGKILLed, and the killed Turn's rows are either absent or dropped by the
  // resume repair. Its own status survives in `turnStatuses` because resume
  // infers it, and inference writes the status alone — no finish time, no
  // duration — while a later start time proves it is the real tail. Recorded
  // terminals are excluded on purpose: a Turn the user rewound past has a
  // finish time and must not come back as a recovery offer.
  const tailStartedAt = tailTurnId ? (state.turnStartedAtMs[tailTurnId] ?? 0) : -1
  for (const [turnId, startedAt] of Object.entries(state.turnStartedAtMs)) {
    if (turnId === tailTurnId || !(startedAt > tailStartedAt)) continue
    if (state.turnFinishedAtMs[turnId] != null) continue
    if (unsettled(turnId)) return true
  }
  if (state.lastTerminalStatus === 'completed') return false
  return false
}

export function ingestLiveApproval(kind: 'permission' | 'plan-review' | 'execution-mode' | 'elicit' | 'ask', req: any): void {
  const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : ''
  if (!sessionId) return
  patchSession(sessionId, prev => {
    if (kind === 'ask' && prev.liveUnits.some(unit => unit.type === 'live-ask' && unit.req.requestId === req.requestId)) return {}
    const unit: LiveUnit = kind === 'permission'
      ? { type: 'live-permission', key: `perm-${req.requestId}`, req, startedAt: Date.now(), resolved: null }
      : kind === 'plan-review'
        ? { type: 'live-plan-review', key: `perm-${req.requestId}`, req, startedAt: Date.now(), resolved: null }
        : kind === 'execution-mode'
          ? { type: 'live-execution-mode', key: `perm-${req.requestId}`, req, startedAt: Date.now(), resolved: null }
          : kind === 'elicit'
            ? { type: 'live-elicit', key: `elicit-${req.requestId}`, req, resolved: null }
            : { type: 'live-ask', key: `q-${req.requestId}`, req, resolved: null }
    // Recovered requests can precede any active turn. Give them a stable owner
    // instead of adopting the next unrelated turn and remounting their forms.
    unit.turnId = typeof req.turnId === 'string' && req.turnId ? req.turnId
      : prev.activeTurnId || `request:${req.requestId}`
    return {
      liveUnits: [...sealTail(prev.liveUnits), unit],
      // 审批卡弹出时隐 activity（对齐 turnActivityUI.hide 调用位）。
      activityVisible: false,
    }
  })
}

// 权限卡挂起期间，把它挡住的那一行工具从「执行中」改成「等待批准」。后台会话也
// 要标：用户切回去时不能看到一行假的执行中。
export function markToolAwaitingApproval(sessionId: string, toolCallId: string): void {
  if (!sessionId || !toolCallId) return
  patchSession(sessionId, prev => {
    const card = prev.tools[toolCallId]
    if (!card || card.status !== 'running') return {}
    return { tools: { ...prev.tools, [toolCallId]: { ...card, status: 'awaiting-approval' } } }
  })
}

export function saveQuestionDraft(sessionId: string, requestId: string, draft: QuestionDraft): void {
  patchSession(sessionId, prev => ({
    liveUnits: prev.liveUnits.map(unit => unit.type === 'live-ask' && unit.req.requestId === requestId ? { ...unit, draft } : unit),
  }))
}

export function updateAsyncQuestionUi(sessionId: string, update: (ui: AsyncQuestionUi) => AsyncQuestionUi): void {
  patchSession(sessionId, prev => ({ asyncQuestions: update(prev.asyncQuestions) }))
}

/** A surface started showing this session: put its answerable questions back.
 *
 *  Callers are the three places a conversation becomes visible — the main
 *  transcript switching to a session, a side tab activating, and a pending
 *  recovery that finishes for the session already on screen. This must never
 *  fire from a state change: the panel's own Later and Escape close it while the
 *  user is still looking at the same chat, and reopening from here would put it
 *  straight back.
 *
 *  Recovery is the reason the "on screen" qualifier matters. The startup sweep
 *  recovers every known session, including background ones whose questions the
 *  engine still lists as pending, so rebuilding a panel there would surface it in
 *  whichever composer happens to render next; approvals.ts therefore gates its
 *  own call on the current session. */
export function reopenAsyncQuestionsForSession(sessionId: string): void {
  if (!sessionId) return
  const now = Date.now()
  patchSession(sessionId, prev => ({
    asyncQuestions: reopenAsyncQuestions(prev.asyncQuestions, { running: prev.running, activeTurnId: prev.activeTurnId }, now),
  }))
}

export function ingestAsyncQuestion(request: AsyncQuestionRequest, recovered = false): void {
  patchSession(request.sessionId, prev => {
    const prior = prev.asyncQuestions.requests[request.requestId]
    if (prev.asyncQuestions.closedTurnIds?.includes(request.turnId) || prior && ['answered', 'expired', 'cancelled'].includes(prior.state)
      || prev.liveTurnId === request.turnId && prev.lastTerminalStatus && prev.activeTurnId !== request.turnId) return {}
    const asyncQuestions = receiveAsyncQuestion(prev.asyncQuestions, request, Date.now(), recovered)
    const present = prev.liveUnits.some(unit => unit.type === 'live-ask' && unit.req.requestId === request.requestId)
      || prev.history?.some(message => message.contentBlocks?.some((block: any) => block.type === 'tool_use' && block.id === request.toolCallId))
    const pending = ['pending', 'submitting'].includes(asyncQuestions.requests[request.requestId]?.state)
    return { asyncQuestions, ...(!prev.activeTurnId && pending ? { running: true, activeTurnId: request.turnId } : {}), liveUnits: recovered || present ? prev.liveUnits : [...sealTail(prev.liveUnits), {
      type: 'live-ask', key: `q-${request.requestId}`, req: request, resolved: null, turnId: request.turnId,
    }] }
  })
}

export function ingestAsyncQuestionResolution(resolution: { sessionId: string; requestId: string; turnId: string; state: 'pending' | 'answered' | 'expired' | 'cancelled'; answers: Record<string, string> }): void {
  updateAsyncQuestionUi(resolution.sessionId, ui => {
    if (!ui.requests[resolution.requestId]) {
      const next = resolution.state === 'expired' || resolution.state === 'cancelled' ? expireAsyncQuestions(ui, resolution.turnId) : ui
      return rememberAsyncQuestionResolution(next, resolution.requestId, resolution.turnId, resolution.state, resolution.answers)
    }
    if (ui.requests[resolution.requestId]?.request.turnId !== resolution.turnId) return ui
    if (resolution.state === 'expired' || resolution.state === 'cancelled') {
      // A durable answer may finish during cancellation. Mark accepted indexes
      // before restoring only the genuinely unsent drafts at the terminal boundary.
      const accepted = resolveAsyncQuestion(ui, resolution.requestId, 'pending', resolution.answers)
      return resolveAsyncQuestion(expireAsyncQuestions(accepted, resolution.turnId), resolution.requestId, resolution.state, resolution.answers)
    }
    return resolveAsyncQuestion(ui, resolution.requestId, resolution.state, resolution.answers)
  })
  // The async panel's submit settles the question store but never touched the
  // transcript's live ask unit, and the sidebar's waiting state reads that unit:
  // an answered question kept its row parked as Needs-input. Every resolution
  // path (card submit, deadline expiry, cancel, host recovery) converges here,
  // so settle the live unit here too.
  if (resolution.state === 'pending') return
  resolveLiveApproval(resolution.sessionId, resolution.requestId, (unit: LiveUnit) =>
    unit.type === 'live-ask'
      ? { mode: resolution.state === 'answered' && Object.keys(resolution.answers).length ? 'submitted' : 'skipped', answers: resolution.answers }
      : resolution.state === 'answered' ? 'submitted' : 'cancelled')
}

export function resolveLiveApproval(sessionId: string, requestId: string, resolution: any): void {
  if (!sessionId) {
    // 撤销事件可能只有 requestId：全会话扫描。
    const state = chatStreamStore.getState()
    for (const sid of Object.keys(state.sessions)) {
      if (state.sessions[sid].liveUnits.some(u => 'req' in u && (u as any).req?.requestId === requestId)) {
        resolveLiveApproval(sid, requestId, resolution)
      }
    }
    return
  }
  patchSession(sessionId, prev => {
    // 卡有结果了，被它挡住的工具行就不再是等待批准：允许则继续跑，拒绝则紧随其后
    // 的 tool_end 把它收成 error。
    let releasedToolCallId = ''
    const liveUnits = prev.liveUnits.map(unit => {
      if (!('req' in unit) || (unit as any).req?.requestId !== requestId) return unit
      releasedToolCallId = String((unit as any).req?.toolCallId || '')
      // resolution 可为工厂（按单元类型给不同终态形状，如 permission_cancelled）。
      const resolved = typeof resolution === 'function' ? resolution(unit) : resolution
      return { ...unit, resolved } as LiveUnit
    })
    const parked = releasedToolCallId ? prev.tools[releasedToolCallId] : undefined
    return {
      liveUnits,
      ...(parked && parked.status === 'awaiting-approval'
        ? { tools: { ...prev.tools, [releasedToolCallId]: { ...parked, status: 'running' as const } } }
        : {}),
      // 对齐旧版处理尾部的 `if (busy) turnActivityUI.show()`。
      activityVisible: prev.running ? true : prev.activityVisible,
    }
  })
}

/** 旧版 #collapse-stats 的 on-screen case 写入点（保留其过滤语义）。 */
export function noteOnScreenCollapseStats(event: any): void {
  chatStreamStore.setState({
    lastOnScreenCollapse: {
      collapsedSpans: Number(event?.collapsedSpans) || 0,
      stagedSpans: Number(event?.stagedSpans) || 0,
    },
  })
}

export function ingestEngineStatus(status: any): void {
  const value = status?.status
  const next = value === 'reconnecting' || value === 'error' ? value : 'ok'
  const previous = chatStreamStore.getState().engineStatus
  if (next !== 'ok' && previous === 'ok') {
    for (const sessionId of Object.keys(chatStreamStore.getState().sessions)) {
      cancelSavedHistoryLoads(sessionId)
      historyReadTokens.delete(sessionId)
      historyInFlight.delete(sessionId)
      patchSession(sessionId, stream => {
        const generation = (stream.historyGeneration ?? 0) + 1
        return { historyGeneration: generation, historyLoading: false,
          ...(stream.turnsPagination ? { turnsPagination: { ...stream.turnsPagination, isLoadingOlder: false } } : {}),
          ...(stream.savedTranscript ? { savedTranscript: { ...stream.savedTranscript, generation,
            entitiesByKey: Object.fromEntries(Object.entries(stream.savedTranscript.entitiesByKey).map(([key, turn]) =>
              [key, { ...turn, itemsPagination: { ...turn.itemsPagination, isLoadingOlder: false } }])),
          } } : {}),
        }
      })
    }
  }
  chatStreamStore.setState({ engineStatus: next })
  if (next === 'ok' && previous !== 'ok') {
    for (const sessionId of Object.keys(chatStreamStore.getState().sessions)) {
      patchSession(sessionId, () => ({ historyStale: true }))
    }
  }
}

// 当前会话跟踪：chat.js 切会话/新会话/恢复会话时 dispatch 此事件。
window.addEventListener('klaus:session-change', (event: Event) => {
  flushChatFrames()
  const detail = (event as CustomEvent).detail || {}
  chatStreamStore.setState({ currentSessionId: detail.sessionId ?? null })
  retainedStreams.get(detail.sessionId)
  trimSessionStreamCache()
})

export function useChatStream<T>(selector: (state: ChatStreamStore) => T): T {
  return useStore(chatStreamStore, selector)
}

export function getSessionStream(sessionId: string): SessionStreamState {
  return selectSessionStream(chatStreamStore.getState(), sessionId)
}

/** Missing sessions must share stable snapshots while their first turn mounts. */
export function selectSessionStream(state: ChatStreamStore, sessionId: string): SessionStreamState {
  return state.sessions[sessionId] || EMPTY_SESSION
}

export function setTurnCollapsed(sessionId: string, turnId: string, collapsed: boolean): void {
  patchSession(sessionId, prev => {
    return {
      turnCollapseOverrides: {
        ...(prev.turnCollapseOverrides || {}),
        [turnId]: collapsed,
      },
    }
  })
}

// 历史层加载（React transcript 的权威数据源：session.history IPC）。
// 并发去重：同一会话在飞行中的加载直接复用；失效（history 置 null）后
// 下一次消费方调用重拉。
//
// 两层不重叠是这里的硬约束：转录不做去重，history 层与 live 层是直接拼接的。
// 引擎在回合开始时就把 user 消息挂进了线程，所以回合期间读到的 history 已经含本
// 回合，而本回合同时正由 live 层呈现。谁让这两份同时上屏，同一条消息就画两遍。
// 规约是：
//   · 回合运行中且 live 层持有内容 → history 层冻结，这次读取不进渲染面；
//     stale 留着，done 分支解冻重拉（本回合的呈现全权交给 live 层）。
//   · 被中断的回合同样冻结：引擎不落盘半截回复，此刻读回来的 history 比 live 层
//     少了正文、思考和工具输出，应用它等于把用户刚看到的东西抹掉。这份 live 内容
//     由下一轮开始（interruptedTurnId 清空）后的 done 重拉正常移交。
//   · 读取晚于 live 起点（引擎已落盘）→ 应用 history 并把 live 移交清空。
//   · 读取早于 live 起点（加载横跨了新回合的开始）→ 两层无交集，live 原样保留。
const historyInFlight = new Map<string, Promise<void>>()
const historyToolResults = new Map<string, Map<string, { turnId?: string; result: Record<string, unknown> }>>()

function mergeHistoryToolResults(sessionId: string, messages: any[] | null, fromHost = false): any[] | null {
  const results = historyToolResults.get(sessionId)
  if (!results?.size || !messages) return messages
  let changed = false
  const merged = messages.map(message => {
    if (!Array.isArray(message.contentBlocks)) return message
    const contentBlocks = message.contentBlocks.map((block: any) => {
      const observed = block.type === 'tool_use' ? results.get(block.id) : null
      if (!observed || observed.turnId && message.turnId && observed.turnId !== message.turnId) return block
      if (block.__result != null) {
        if (fromHost) results.delete(block.id)
        return block
      }
      changed = true
      return { ...block, __result: observed.result }
    })
    return contentBlocks.some((block: any, index: number) => block !== message.contentBlocks[index]) ? { ...message, contentBlocks } : message
  })
  if (!results.size) historyToolResults.delete(sessionId)
  return changed ? merged : messages
}


/** live 层此刻是否持有 history 读不回来的内容（在途回合或被中断的回合）。 */
function liveLayerOwnsTurn(state: SessionStreamState): boolean {
  return (state.running || state.interruptedLiveTurn != null) && state.liveUnits.length > 0
}

/**
 * live 层正在渲染的回合 id。history 层不得重复这些回合，但更早的回合 live 层
 * 永远拿不到 —— 这是「冻结期整条读取都作废」过宽的地方。
 *
 * 空集表示认不出归属（只有乐观气泡、引擎还没回 stream_mode 带 turnId）。此时
 * 无法安全切分，必须维持原来的「整条不读」行为，否则本回合的 user 行会与乐观
 * 气泡各画一遍。
 */
function liveOwnedTurnIds(state: SessionStreamState): Set<string> {
  const ids = new Set<string>()
  if (typeof state.liveTurnId === 'string' && state.liveTurnId) ids.add(state.liveTurnId)
  const interrupted = state.interruptedLiveTurn?.turnId
  if (typeof interrupted === 'string' && interrupted) ids.add(interrupted)
  return ids
}

/** Identity of the Turns the live layer owns; empty when ownership is unknown. */
function frozenTurnKey(state: SessionStreamState): string {
  return [...liveOwnedTurnIds(state)].sort().join('\u0000')
}

export interface HistoryFreezeGateInput {
  /** live 层是否持有在途或被中断的回合（liveLayerOwnsTurn）。 */
  liveLayerOwnsTurn: boolean
  /** history 层是否已经有内容（null = 从未加载过）。 */
  historyLoaded: boolean
  /** live 层持有内容的回合 id 数量；0 = 认不出归属。 */
  liveTurnIdCount: number
}

/**
 * 冻结期该不该发这次 history 读取。纯函数，由
 * `contracts/vectors/transcript-history-freeze-vectors.json` 钉住。
 *
 * 默认不发：读回来的当前回合注定要作废，回合结束时本来就会重拉。
 *
 * 唯一的例外是 history 层此刻为空、且已经知道 live 层持有哪个回合：那意味着用户
 * 连一个更早的回合都翻不出来，而 live 层只持有正在跑的那个回合，更早的回合它永远
 * 拿不到 —— 一个跑了八个回合的长会话在收口前只能看到最后一屏。
 *
 * 回合 id 未知时必须跳过，不能白发一次注定作废的请求：新会话发第一条消息正是这个
 * 形状（乐观气泡已上屏、引擎的 stream_mode 还没带 turnId 回来），无法切分就没有任何
 * 东西可接管。history 已有内容时同样跳过：更早的回合已经可见，缺的只是本回合，而本
 * 回合归 live 层，等 done 移交即可。
 */
export function shouldReadHistoryDuringFreeze(input: HistoryFreezeGateInput): boolean {
  if (!input.liveLayerOwnsTurn) return true
  return !input.historyLoaded && input.liveTurnIdCount > 0
}

export interface FrozenHistorySliceInput {
  /** live 层持有内容的回合 id。 */
  liveTurnIds: readonly string[]
  /** 读取回来的行，按 rollout（= 时间）顺序。 */
  rows: readonly { readonly turnId?: unknown }[]
  /** history 层当前已有的行数；null = 从未加载过。 */
  ownedRowCount: number | null
}

export type FrozenHistorySlice =
  | { readonly apply: false; readonly reason: 'unknown-live-turn' | 'unattributable-rows' | 'no-earlier-rows' | 'no-new-rows' }
  | { readonly apply: true; readonly rowCount: number; readonly rows: readonly { readonly turnId?: unknown }[] }

/**
 * 冻结期把一次读取切成 history 层可以接管的那一段。纯函数，由
 * `contracts/vectors/transcript-history-freeze-vectors.json` 钉住。
 *
 * rollout 顺序即时间顺序，所以第一个属于 live 层的行就是分界：它之前的行全部来自
 * 更早的回合。渲染层是「history 层 + live 层直接拼接、不做任何去重」，所以只要切分
 * 严格停在分界之前，两层就不可能画重。
 *
 * 一行都没命中分界时返回 unattributable-rows 而不是「全部可用」，这在冻结期是危险
 * 信号而不是好消息：冻结意味着 live 层已经在渲染本回合，而引擎在回合开始时就把本回合
 * 的 user 消息挂进了线程，读回来的行里本该有它。一行都没命中只可能是行缺 turnId，
 * 此时无法区分哪些行属于本回合，全部应用就会让本回合的 user 行与乐观气泡各画一遍。
 */
export function frozenHistorySlice(input: FrozenHistorySliceInput): FrozenHistorySlice {
  const excluded = new Set(input.liveTurnIds.filter((id): id is string => typeof id === 'string' && !!id))
  if (excluded.size === 0) return { apply: false, reason: 'unknown-live-turn' }
  let boundary = -1
  for (let index = 0; index < input.rows.length; index++) {
    const turnId = input.rows[index]?.turnId
    if (typeof turnId === 'string' && excluded.has(turnId)) { boundary = index; break }
  }
  if (boundary < 0) return { apply: false, reason: 'unattributable-rows' }
  if (boundary === 0) return { apply: false, reason: 'no-earlier-rows' }
  const rows = input.rows.slice(0, boundary)
  // 只在真的多出回合时才换 history 引用：换一次就触发渲染层重跑 effect，无脑替换
  // 会让「拉取 → 换引用 → 再拉取」自激成 IPC 死循环。
  if (input.ownedRowCount !== null && input.ownedRowCount >= rows.length) {
    return { apply: false, reason: 'no-new-rows' }
  }
  return { apply: true, rowCount: rows.length, rows }
}

/**
 * 合并回合元数据表：磁盘侧的值用于 live 层不管的回合，live 层持有的回合保留本地值。
 *
 * 不能用「摘掉 live 回合」的做法：那样会把 live 层自己记下的状态一并删掉。中断态
 * 是最直接的受害者 —— `interrupted` 事件本地写 `turnStatuses[turnId]='interrupted'`，
 * 而磁盘上的回放可能还没有这条（或记的是别的），整体替换就把它抹掉，
 * `canContinueTurn` 随之失去 Continue 的判据。冻结期 live 层仍持有本回合，它的本地
 * 状态就是权威值，必须留住。
 */
function preservingLiveTurns<T>(
  next: Record<string, T>,
  prev: Record<string, T>,
  excluded: ReadonlySet<string>,
): Record<string, T> {
  let changed = false
  const out: Record<string, T> = { ...next }
  for (const turnId of excluded) {
    if (Object.prototype.hasOwnProperty.call(prev, turnId)) {
      if (out[turnId] !== prev[turnId]) { out[turnId] = prev[turnId]; changed = true }
    } else if (turnId in out) {
      delete out[turnId]
      changed = true
    }
  }
  return changed ? out : next
}

const shellEntries = (shells: TranscriptTurnShell[]): Record<string, TranscriptTurnShell> =>
  Object.fromEntries(shells.map(shell => [shell.id, shell]))

interface SavedPageCommit {
  current(): boolean
  update(history: SavedTranscript): SavedTranscript | null
  reply: any
}

/** Remove a rewound message and everything after it from the screen, and refuse to draw that tail back from a stale history snapshot. */
export function forgetRewoundTurn(sessionId: string, messageUuid: string, turnId = ''): void {
  if (!sessionId || (!messageUuid && !turnId)) return
  patchSession(sessionId, prev => {
    const cut = rewindCutFor(prev, messageUuid, turnId)
    rememberRewindCut(sessionId, cut)
    return sessionWithoutRewoundTail(prev, cut)
  })
}

export function loadSessionHistory(sessionId: string, options: {
  reconcile?: boolean
  savedPage?: SavedPageCommit
  /**
   * The caller already knows the rewrite removed the live Turn (a successful
   * rewind reports how many turns it dropped). That direct answer is stronger
   * than inferring truncation from the rows: saved history may legitimately
   * contain rows without a turn id (compaction, imported, auxiliary rows), and
   * the attribution test below must not let those rows pin a stopped tail on
   * screen after its turn is gone.
   */
  rewoundLiveTail?: boolean
} = {}): Promise<void> {
  flushChatFrames()
  if (!sessionId || isSessionStreamRetired(sessionId)) return Promise.resolve()
  const inFlight = historyInFlight.get(sessionId)
  if (inFlight) return options.reconcile || options.savedPage
    ? inFlight.then(() => loadSessionHistory(sessionId, options)) : inFlight
  if (options.savedPage && !options.savedPage.current()) return Promise.resolve()
  const current = chatStreamStore.getState().sessions[sessionId] || EMPTY_SESSION
  if (current.provisional || unadmittedUserTurn(sessionId)) return Promise.resolve()
  // 冻结期该不该发这次读取，由 shouldReadHistoryDuringFreeze 单一裁定（契约向量钉住）。
  if (!options.reconcile && !options.savedPage && !shouldReadHistoryDuringFreeze({
    liveLayerOwnsTurn: liveLayerOwnsTurn(current),
    historyLoaded: current.history !== null,
    liveTurnIdCount: liveOwnedTurnIds(current).size,
  })) return Promise.resolve()
  const readSeq = nextSeq()
  const readRevision = current.liveRevision
  // A read issued while the live layer holds a Turn is sliced by Turn id, so
  // that Turn streaming on during the read does not invalidate it.
  const readFrozenTurns = liveLayerOwnsTurn(current) && frozenTurnKey(current) ? frozenTurnKey(current) : null
  const readHistory = current.history
  const snapshotRead = !options.savedPage && !subagentHistorySources.has(sessionId)
  const generation = (current.historyGeneration ?? 0) + Number(snapshotRead)
  if (snapshotRead) cancelSavedHistoryLoads(sessionId)
  // Publish the generation and the loading flag in one write. Every write can
  // trim the stream cache, and a stream that is not yet loading or current is
  // evictable: evicting it between two writes recreated it at generation 0, so
  // this read could never commit and the transcript stayed on its skeleton.
  patchSession(sessionId, prev => ({
    historyGeneration: generation,
    historyLoading: true,
    ...(snapshotRead ? { historyLoadFailed: false, historyRetry: null } : {}),
    ...(snapshotRead && prev.savedTranscript ? { savedTranscript: {
      ...prev.savedTranscript, generation,
      entitiesByKey: Object.fromEntries(Object.entries(prev.savedTranscript.entitiesByKey).map(([key, turn]) =>
        [key, { ...turn, itemsPagination: { ...turn.itemsPagination, isLoadingOlder: false } }])),
    } } : {}),
  }))
  const readSaved = getSessionStream(sessionId).savedTranscript
  let refreshAfterSettled = false
  const readToken = {}
  historyReadTokens.set(sessionId, readToken)
  const currentRead = () => historyReadTokens.get(sessionId) === readToken && !isSessionStreamRetired(sessionId)
    && (getSessionStream(sessionId).historyGeneration ?? 0) === generation && (options.savedPage?.current() ?? true)
  const promise = (async () => {
    try {
      const child = subagentHistorySources.get(sessionId)
      const api = (window as any).klaus
      // Read companion records in parallel so ordinary first paints include
      // their change cards without making history depend on this endpoint.
      if (!child) void ensureArtifactsForSession(sessionId).catch(() => {})
      const captured = child ? getSessionStream(child.parentSessionId).agentTasks[child.taskId]?.messages : null
      // The endpoint also owns turn metadata and delivered notifications. A
      // captured message-only snapshot is a fallback, not a history substitute.
      let result
      let firstPaint: FirstPaintResult | null = null
      let nextSaved: SavedTranscript | null = null
      if (options.savedPage) {
        if (!readSaved || !options.savedPage.current()) return
        nextSaved = options.savedPage.update(readSaved)
        if (!nextSaved) return
        result = { ...options.savedPage.reply, messages: savedRows(nextSaved) }
      } else if (child) {
        try {
          result = await api.agents.history(child.parentSessionId, child.agentId)
          if (!Array.isArray(result?.messages) && captured?.length) result = { messages: captured }
        } catch (error) {
          if (!captured?.length) throw error
          result = { messages: captured }
        }
      } else if (current.historySource === 'ephemeral') {
        // Temporary endpoints replay their visible in-memory conversation.
        // They never create the rollout that saved paging requires.
        result = await api.session.history(sessionId)
      } else if (typeof api.session.historyPage === 'function') {
        const first = await loadFirstPaint(api, sessionId)
        if (!currentRead()) return
        nextSaved = commitSavedSnapshot(readSaved, first.reply, generation, !!options.reconcile)
        firstPaint = first
        result = { ...first.reply, messages: savedRows(nextSaved) }
        first.pagination = savedPagination(nextSaved)
      } else {
        // A bridge without the paged channels (test doubles, or a host older
        // than the renderer) still serves the transcript through the whole
        // read; every shipped bridge exposes the paged pair.
        result = await api.session.history(sessionId)
      }
      const cutBefore = peekRewindCut(sessionId)
      const rewindCut = settleRewindCut(sessionId, result)
      if (rewindCut) {
        if (nextSaved) {
          nextSaved = savedTranscriptWithoutTurns(nextSaved, rewindCut.turnIds) ?? nextSaved
          if (firstPaint) firstPaint.pagination = savedPagination(nextSaved)
        }
        if (firstPaint && Array.isArray(firstPaint.shells)) {
          firstPaint.shells = firstPaint.shells.filter((shell: any) => !rewindCut.turnIds.includes(shell?.id ?? ''))
        }
        const stripped = replyWithoutRewoundTail(result, rewindCut)
        result = nextSaved && stripped && typeof stripped === 'object' && !Array.isArray(stripped)
          ? { ...stripped, messages: savedRows(nextSaved) }
          : stripped
      }
      const liveCut = rewindCut ?? (options.rewoundLiveTail ? cutBefore ?? null : null)
      if (nextSaved) {
        const allowed = new Set(savedTurns(nextSaved).map(turn => turn.id))
        for (const field of ['turnStatuses', 'turnStartedAtMs', 'turnFinishedAtMs', 'turnDurations', 'turnErrors', 'turnErrorKinds', 'turnErrorDetails', 'turnCancelledTools']) {
          result[field] = {
            ...Object.fromEntries(Object.entries((current as any)[field] ?? {}).filter(([turnId]) => allowed.has(turnId))),
            ...(result[field] ?? {}),
          }
        }
      }
      if (!currentRead()) return
      const history = Array.isArray(result) ? result : (result?.messages ?? [])
      const turnStatuses = (result?.turnStatuses && typeof result.turnStatuses === 'object' && !Array.isArray(result.turnStatuses))
        ? (result.turnStatuses as Record<string, string>)
        : {}
      const numericTurnMap = (value: unknown): Record<string, number> =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).flatMap(([turnId, timestamp]) =>
              typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? [[turnId, timestamp]] : []
            ))
          : {}
      const turnStartedAtMs = numericTurnMap(result?.turnStartedAtMs)
      const turnFinishedAtMs = numericTurnMap(result?.turnFinishedAtMs)
      const turnDurations = (result?.turnDurations && typeof result.turnDurations === 'object' && !Array.isArray(result.turnDurations))
        ? Object.fromEntries(Object.entries(result.turnDurations).flatMap(([turnId, duration]) =>
          typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? [[turnId, duration]] : []
        )) as Record<string, number>
        : {}
      const turnErrors = (result?.turnErrors && typeof result.turnErrors === 'object' && !Array.isArray(result.turnErrors))
        ? { ...(result.turnErrors as Record<string, string>) }
        : {}
      const turnErrorKinds = (result?.turnErrorKinds && typeof result.turnErrorKinds === 'object' && !Array.isArray(result.turnErrorKinds))
        ? { ...(result.turnErrorKinds as Record<string, string>) }
        : {}
      const turnErrorDetails: Record<string, ProviderErrorDetails> = {}
      if (result?.turnErrorDetails && typeof result.turnErrorDetails === 'object' && !Array.isArray(result.turnErrorDetails)) {
        for (const [turnId, value] of Object.entries(result.turnErrorDetails)) {
          const details = providerErrorDetails(value)
          if (!details) continue
          turnErrorDetails[turnId] = details
          turnErrors[turnId] = providerErrorTextWithRequestId(turnErrors[turnId] ?? details.message, details.requestId)
          if (details.kind !== undefined && (!turnErrorKinds[turnId] || turnErrorKinds[turnId] === 'unknown')) turnErrorKinds[turnId] = details.kind
        }
      }
      // A Turn the saved verdict calls `failed` with a teardown-family error was
      // killed by its session closing (a stop racing a binding rebuild, an idle
      // retirement), not by the model. Project it as stopped — the same story the
      // live layer told — so reopening the conversation shows a stopped Turn
      // instead of a red engine-internal error row.
      const teardownTurnIds = new Set(Object.entries(turnStatuses)
        .filter(([turnId, status]) => status === 'failed'
          && isTeardownFailure(turnErrors[turnId] || ''))
        .map(([turnId]) => turnId))
      const projectTurnStatuses = teardownTurnIds.size
        ? Object.fromEntries(Object.entries(turnStatuses).map(([turnId, status]) =>
            [turnId, teardownTurnIds.has(turnId) ? 'interrupted' : status]))
        : turnStatuses
      const projectTurnErrors = teardownTurnIds.size
        ? Object.fromEntries(Object.entries(turnErrors).filter(([turnId]) => !teardownTurnIds.has(turnId)))
        : turnErrors
      const projectTurnErrorKinds = teardownTurnIds.size
        ? Object.fromEntries(Object.entries(turnErrorKinds).filter(([turnId]) => !teardownTurnIds.has(turnId)))
        : turnErrorKinds
      const projectTurnErrorDetails = teardownTurnIds.size
        ? Object.fromEntries(Object.entries(turnErrorDetails).filter(([turnId]) => !teardownTurnIds.has(turnId)))
        : turnErrorDetails
      const turnCancelledTools = (result?.turnCancelledTools && typeof result.turnCancelledTools === 'object' && !Array.isArray(result.turnCancelledTools))
        ? Object.fromEntries(Object.entries(result.turnCancelledTools).flatMap(([turnId, ids]) =>
          Array.isArray(ids) ? [[turnId, ids.filter((id): id is string => typeof id === 'string' && !!id)]] : []
        )) as Record<string, string[]>
        : {}
      if (!currentRead()) return
      patchSession(sessionId, prev => {
        if (!currentRead() || nextSaved && prev.savedTranscript !== readSaved) return { historyLoading: false }
        const covers = readSeq > prev.liveStartSeq
        // A tool result may have settled a history-owned call during this read.
        // Fetch again instead of replacing that result with the older snapshot.
        if (prev.history !== readHistory) {
          if (options.savedPage) return { historyLoading: false }
          refreshAfterSettled = true
          return { historyLoading: false, historyStale: true }
        }
        // 发起时不在冻结期，resolve 时却已经进了新回合或刚被中断：作废，等下一次
        // 移交时机重拉。
        const sameFrozenTurn = readFrozenTurns !== null && liveLayerOwnsTurn(prev) && frozenTurnKey(prev) === readFrozenTurns
        if (covers && readRevision !== prev.liveRevision && !sameFrozenTurn) {
          refreshAfterSettled = true
          return { historyLoading: false, historyStale: true }
        }
        const rows = Array.isArray(history) ? history : []
        const tailForResume = Array.isArray(history) ? history.at(-1)?.turnId : null
        const tailHasFinal = !!tailForResume && Array.isArray(history) && history.some((message: any) => message.turnId === tailForResume
          && (message.isFinalReply && message.text?.trim()
            || message.contentBlocks?.some((block: any) => block.type === 'text' && block.phase === 'final_answer' && block.text?.trim())))
        const parentTask = child ? getSessionStream(child.parentSessionId).agentTasks[child.taskId] : undefined
        // A live child has no terminal record yet, so disk replay calls the open
        // turn interrupted. That paints "stopped" and collapses its activity.
        const tailOpen = childTailStillOpen(tailForResume, prev.running && !!parentTask && parentTask.status === 'running' && parentTask.isIdle !== true,
          projectTurnStatuses, turnFinishedAtMs, turnDurations, turnCancelledTools, tailHasFinal)
          ? tailForResume : null
        const resumeOpenChild = tailOpen ? {
          running: true as const,
          streamMode: 'requesting' as const,
          activityVisible: true,
          ...(prev.lastTerminalStatus === 'interrupted' || (prev.interruptedLiveTurn && (!prev.interruptedLiveTurn.turnId || prev.interruptedLiveTurn.turnId === tailOpen))
            ? { interruptedLiveTurn: null, lastTerminalStatus: null, stopRequestedAt: null } : {}),
        } : {}
        const supportsSavedItemAnchors = result?.supportsItemAnchors === true
          || options.savedPage !== undefined && prev.supportsSavedItemAnchors
        const pageMeta = nextSaved
          ? { pagination: savedPagination(nextSaved), shells: Object.values(savedShells(nextSaved)) }
          : firstPaint
          ? { pagination: firstPaint.pagination, shells: firstPaint.shells }
          : null
        const pendingEdit = pendingEditedTurns.get(sessionId)
        const editedTurnId = pendingEdit?.snapshot.replacementTurnId
        // An edit ACK or terminal event can beat the rollout flush. Keep the
        // local replacement until saved history actually contains its user row.
        if (!options.reconcile && editedTurnId && prev.liveUnits.length
          && !rows.some(message => message.role === 'user' && message.turnId === editedTurnId)) {
          return { historyLoading: false, historyStale: true }
        }
        const ownedTurns = liveOwnedTurnIds(prev)
        // A user-requested truncation invalidates the stopped tail only when
        // fresh history can prove its turn is gone. Ordinary reloads keep it.
        const discardedInterruptedTurn = options.reconcile && covers && !prev.running
          && prev.interruptedLiveTurn != null && ownedTurns.size > 0
          && (options.rewoundLiveTail === true
            || rows.every(message => typeof message.turnId === 'string' && !!message.turnId)
              && !rows.some(message => typeof message.turnId === 'string' && ownedTurns.has(message.turnId)))
        // A rewind already removed this tail from the screen. Keeping the stopped
        // layer, or applying a snapshot that still names it, draws the undone turn again.
        if (covers && liveLayerOwnsTurn(prev) && !discardedInterruptedTurn && !liveCut && options.rewoundLiveTail !== true) {
          // 冻结期：live 层继续持有在跑的回合，history 层只接管它拿不到的更早回合。
          // 不做移交（liveUnits / liveTurnId / activeTurnId 一律不动），也不并入
          // agent 活动时间线 —— 那些 live 单元此刻正在屏上，并进来就画两遍。
          // 切分规则由 frozenHistorySlice 单一裁定（契约向量钉住）。
          const excluded = liveOwnedTurnIds(prev)
          // The saved page also names a running Turn as a shell (identity and
          // lifecycle, rows withheld). Keeping it hands the history layer an
          // empty frame for a Turn it does not own: its start time is withheld
          // below, so the transcript placed that frame before every older Turn
          // and the running Turn drew at the top, out of view. Drop it exactly
          // like its rows; the handoff read after the Turn ends restores it.
          // A stopped Turn keeps its saved entry: a later item read uses it to
          // tell a rewound Turn from one that still exists.
          const runningTurns = prev.running && typeof prev.liveTurnId === 'string' && excluded.has(prev.liveTurnId) ? [prev.liveTurnId] : []
          const frozenSaved = nextSaved ? savedTranscriptWithoutTurns(nextSaved, runningTurns) ?? nextSaved : null
          const frozenShells = (shells: readonly TranscriptTurnShell[]) => shells.filter(shell => !runningTurns.includes(shell.id))
          const boundary = options.reconcile ? rows.findIndex(message => excluded.has(message.turnId)) : -1
          const slice = boundary === 0
            ? { apply: true as const, rows: [] }
            : frozenHistorySlice({
              liveTurnIds: [...excluded],
              rows,
              ownedRowCount: options.reconcile ? null : Array.isArray(prev.history) ? prev.history.length : null,
            })
          if (!slice.apply) return { historyLoading: false, supportsSavedItemAnchors, ...(frozenSaved ? {
            savedTranscript: frozenSaved, loadedRows: savedRows(frozenSaved),
            turnsPagination: savedPagination(frozenSaved), turnShells: savedShells(frozenSaved),
          } : {}) }
          const earlier = [...slice.rows]
          return {
            history: mergeHistoryToolResults(sessionId, earlier, true) || [],
            supportsSavedItemAnchors,
            ...(options.reconcile ? { historyStale: false } : {}),
            historyLoading: false,
            loadedRows: frozenSaved ? savedRows(frozenSaved) : earlier,
            ...(pageMeta ? {
              turnsPagination: frozenSaved ? savedPagination(frozenSaved) : pageMeta.pagination ?? prev.turnsPagination,
              turnShells: frozenSaved ? savedShells(frozenSaved) : { ...prev.turnShells, ...shellEntries(frozenShells(pageMeta.shells)) },
              ...(frozenSaved ? { savedTranscript: frozenSaved } : {}),
            } : {}),
            turnStatuses: withoutInferredInterrupt(preservingLiveTurns(projectTurnStatuses, prev.turnStatuses, excluded), tailOpen),
            ...(tailOpen ? {
              ...resumeOpenChild,
              activeTurnId: prev.activeTurnId || tailOpen,
              liveTurnId: prev.liveTurnId || tailOpen,
              liveUnits: withoutOpenStopRow(prev.liveUnits, tailOpen),
            } : {}),
            turnStartedAtMs: preservingLiveTurns(turnStartedAtMs, prev.turnStartedAtMs, excluded),
            turnFinishedAtMs: preservingLiveTurns(turnFinishedAtMs, prev.turnFinishedAtMs, excluded),
            turnDurations: preservingLiveTurns(turnDurations, prev.turnDurations, excluded),
            turnErrors: preservingLiveTurns(projectTurnErrors, prev.turnErrors, excluded),
            turnErrorKinds: preservingLiveTurns(projectTurnErrorKinds, prev.turnErrorKinds, excluded),
            turnErrorDetails: preservingLiveTurns(projectTurnErrorDetails, prev.turnErrorDetails, excluded),
            turnCancelledTools: preservingLiveTurns(turnCancelledTools, prev.turnCancelledTools, excluded),
          }
        }
        // An empty disk read must not erase a sealed live transcript. A child
        // whose sidechain never reached disk has nothing on the other side of
        // this handoff; blanking the panel would
        // destroy the only copy of the run the user just watched. Keep the
        // live layer until a read brings real content or a new turn takes the
        // layer over. Scoped to child streams: a main-session interrupted
        // turn hands its partial over to history by contract, and an empty
        // read there is the engine's verdict, not a missing sidechain.
        if (subagentHistorySources.has(sessionId)
          && (Array.isArray(history) ? history.length : 0) === 0
          && prev.liveUnits.length > 0 && !liveLayerOwnsTurn(prev)) {
          return { history: prev.history ?? [], historyLoading: false, historyStale: false }
        }
        const tailTurnId = Array.isArray(history) ? history.at(-1)?.turnId : null
        const hasFinal = tailTurnId && history.some((message: any) => message.turnId === tailTurnId
          && (message.isFinalReply && message.text?.trim()
            || message.contentBlocks?.some((block: any) => block.type === 'text' && block.phase === 'final_answer' && block.text?.trim())))
        const restoredTurnId = prev.running && !prev.liveUnits.length && !prev.interruptedLiveTurn && tailTurnId
          && (!prev.activeTurnId || prev.activeTurnId === tailTurnId)
          && !hasFinal && !['completed', 'failed'].includes(projectTurnStatuses[tailTurnId])
          && !turnFinishedAtMs[tailTurnId] && turnDurations[tailTurnId] == null && !turnCancelledTools[tailTurnId]?.length
          ? tailTurnId : tailOpen
        // Disk replay marks unfinished turns interrupted. A known running
        // conversation without terminal evidence is still executing that tail.
        const restoredStatuses = { ...projectTurnStatuses }
        if (restoredTurnId && restoredStatuses[restoredTurnId] === 'interrupted') delete restoredStatuses[restoredTurnId]
        const delivered = Array.isArray(result?.agentNotifications) ? result.agentNotifications.flatMap((notification: any) => {
          const activity = agentNotificationActivity(notification, prev.agentTasks)
          return activity ? [{ ...activity, key: `agent-notification:${notification.notificationId}` }] : []
        }) : []
        const agentTimeline = mergeAgentActivityRecords(options.reconcile ? [] : prev.agentTimeline, delivered)
        const planningHandoff = mergePlanningHistoryUnits(mergeHistoryToolResults(sessionId, Array.isArray(history) ? history : [], true) || [], prev.liveUnits)
        const reviewHandoff = mergeApprovalReviewHistoryUnits(planningHandoff.history || [], planningHandoff.liveUnits, prev.history ?? [])
        const savedReplacement = editedTurnId && rows.some(message => message.role === 'user' && message.turnId === editedTurnId)
        // Fresh replacement history proves that the edited opener was superseded.
        // Its local rows must not enter the ordinary missing-user retention path.
        const submittedUnits = savedReplacement && pendingEdit
          ? prev.liveUnits.filter(unit => !pendingEdit.snapshot.droppedKeys.has(unit.key)) : prev.liveUnits
        const submittedHistory = savedReplacement && pendingEdit
          ? prev.history?.filter(message => !belongsToEditedTurn(message, pendingEdit.snapshot)) : prev.history
        const settledHistory = options.reconcile ? reviewHandoff.history
          : mergeSubmittedUserHistory(reviewHandoff.history, covers ? submittedUnits : [], submittedHistory || [])
        if (covers && pendingEdit && (options.reconcile || editedTurnId
          && settledHistory.some(message => message.role === 'user' && message.turnId === editedTurnId))) {
          pendingEditedTurns.delete(sessionId)
        }
        const savedUserIds = new Set(settledHistory.filter(message => message.role === 'user' && message.uuid).map(message => message.uuid))
        if (!prev.running) historyToolResults.delete(sessionId)
        return {
          agentTimeline,
          supportsSavedItemAnchors,
          history: mergeAgentTimeline(settledHistory, agentTimeline),
          historyStale: false,
          historyLoading: false,
          historyLoadFailed: false,
          loadedRows: rows,
          ...(pageMeta ? {
            turnsPagination: pageMeta.pagination ?? prev.turnsPagination,
            turnShells: nextSaved ? savedShells(nextSaved) : { ...prev.turnShells, ...shellEntries(pageMeta.shells) },
            ...(nextSaved ? { savedTranscript: nextSaved } : {}),
          } : {}),
          turnStatuses: restoredStatuses,
          turnStartedAtMs,
          turnFinishedAtMs,
          turnDurations,
          turnErrors: projectTurnErrors,
          turnErrorKinds: projectTurnErrorKinds,
          turnErrorDetails: projectTurnErrorDetails,
          turnCancelledTools,
          ...(discardedInterruptedTurn || (liveCut && (!prev.interruptedLiveTurn?.turnId || liveCut.turnIds.includes(prev.interruptedLiveTurn.turnId))) ? { interruptedLiveTurn: null, lastTerminalStatus: null, stopRequestedAt: null } : {}),
          activeTurnId: liveCut && prev.activeTurnId && liveCut.turnIds.includes(prev.activeTurnId)
            ? null
            : (restoredTurnId || ((covers && prev.activeTurnId) ? null : prev.activeTurnId)),
          // Approval cards have a separate host lifetime and are absent from
          // transcript history. A late history read must not erase a recovered card.
          ...(covers || liveCut ? { liveUnits: withoutOpenStopRow((liveCut ? unitsBeforeRewind(reviewHandoff.liveUnits, liveCut) : reviewHandoff.liveUnits).filter(unit => !covers || unit.type === 'live-planning-question' && unit.request.status === 'pending'
            || 'req' in unit && unit.resolved === null
            && (unit.type !== 'live-ask' || unit.req.responseChannel !== 'async-question'
              || !settledHistory.some(message => message.contentBlocks?.some((block: any) => block.id === unit.req.toolCallId)))), tailOpen),
            tools: covers ? {} : prev.tools,
            liveTurnId: tailOpen && !(liveCut && (!prev.liveTurnId || liveCut.turnIds.includes(prev.liveTurnId)))
              ? (prev.liveTurnId || tailOpen)
              : (covers || (liveCut && (!prev.liveTurnId || liveCut.turnIds.includes(prev.liveTurnId))) ? null : prev.liveTurnId) }
            : { liveUnits: withoutOpenStopRow(reviewHandoff.liveUnits.filter(unit => unit.type !== 'live-user' || !savedUserIds.has(unit.msg.uuid)), tailOpen) }),
          ...resumeOpenChild,
        }
      })
    } catch (error) {
      if (currentRead()) patchSession(sessionId, () => ({
        historyLoading: false,
        ...(!options.savedPage ? { historyLoadFailed: true, historyRetry: 'snapshot' as const } : {}),
      }))
      if (options.savedPage) throw error
    }
  })()
  historyInFlight.set(sessionId, promise)
  const settled = () => {
    const valid = currentRead()
    if (historyReadTokens.get(sessionId) === readToken) {
      historyReadTokens.delete(sessionId)
      if (historyInFlight.get(sessionId) === promise) historyInFlight.delete(sessionId)
    }
    // An abandoned first read with no successor must not leave the skeleton on
    // screen. Mark the stream stale so a mounted transcript issues a fresh read.
    if (!valid && snapshotRead && !historyReadTokens.has(sessionId) && !isSessionStreamRetired(sessionId)) {
      const left = getSessionStream(sessionId)
      if (left.historyLoading && left.history === null) patchSession(sessionId, () => ({ historyLoading: false, historyStale: true }))
    }
    scheduleHistoryRetention(sessionId)
    const settled = getSessionStream(sessionId)
    // A frozen read that was still invalidated retries only while no earlier
    // Turn is on screen; otherwise the Turn's end performs the handoff read.
    if (valid && refreshAfterSettled && (!liveLayerOwnsTurn(settled)
      || settled.history === null && !settled.historyLoading && liveOwnedTurnIds(settled).size > 0)) {
      queueMicrotask(() => { if (!isSessionStreamRetired(sessionId)) void loadSessionHistory(sessionId) })
    }
  }
  void promise.then(settled, settled)
  return promise
}

/**
 * Fetch the next older turn page and republish the transcript through the
 * ordinary history pipeline. The auto page-up machine calls this once the
 * render window already shows every loaded row.
 */
export async function loadOlderHistoryPage(sessionId: string, requested?: TurnBoundaryRequest): Promise<'stop' | 'continue'> {
  const stream = getSessionStream(sessionId), history = stream.savedTranscript
  if (!history || stream.provisional || isSessionStreamRetired(sessionId) || unadmittedUserTurn(sessionId)) return 'stop'
  const partial = savedTurns(history).filter(turn => !turn.itemsPagination.hasLoadedOldest).at(-1)
  if (partial && !requested && !failedHistoryBoundaries.has(sessionId)) {
    try { await loadTurnHistoryItems(sessionId, partial.id); return 'continue' }
    catch { return 'stop' }
  }
  const existing = olderTurnsLoads.get(sessionId)
  if (existing) return existing.promise
  const request = requested ?? failedHistoryBoundaries.get(sessionId) ?? savedBoundary(history)
  if (!request || !ownsSavedBoundary(history, request)) return 'stop'
  const owner = { request, promise: Promise.resolve<'stop' | 'continue'>('stop') }
  const current = () => olderTurnsLoads.get(sessionId) === owner && !isSessionStreamRetired(sessionId)
    && !unadmittedUserTurn(sessionId) && !!getSessionStream(sessionId).savedTranscript
    && ownsSavedBoundary(getSessionStream(sessionId).savedTranscript!, request)
  olderTurnsLoads.set(sessionId, owner)
  patchSession(sessionId, () => ({ turnsPagination: savedPagination(history, true), historyLoadFailed: false, historyRetry: null }))
  owner.promise = (async () => {
    try {
      const older = await loadOlderTurnsPage((window as any).klaus, sessionId, {
        olderCursor: request.handle.cursor, oldestLoadedTurnId: request.handle.oldestLoadedTurnId,
        isLoadingOlder: false, hasLoadedOldest: false,
      })
      if (!older || !current()) return 'stop'
      do {
        await loadSessionHistory(sessionId, { savedPage: {
          current, reply: older.reply, update: latest => commitOlderTurns(latest, request, older.reply),
        } })
      } while (current())
      if (failedHistoryBoundaries.get(sessionId) === request) failedHistoryBoundaries.delete(sessionId)
      return 'continue'
    } catch {
      if (current()) failedHistoryBoundaries.set(sessionId, request)
      if (current()) patchSession(sessionId, prev => ({
        historyLoadFailed: true, historyRetry: 'turns',
        turnsPagination: prev.savedTranscript ? savedPagination(prev.savedTranscript) : prev.turnsPagination,
      }))
      return 'stop'
    } finally {
      if (olderTurnsLoads.get(sessionId) === owner) {
        olderTurnsLoads.delete(sessionId)
        patchSession(sessionId, prev => ({
          turnsPagination: prev.savedTranscript ? savedPagination(prev.savedTranscript) : prev.turnsPagination,
        }))
      }
    }
  })()
  return owner.promise
}

interface TurnItemsLoad {
  sessionId: string
  turnId: string
  generation: number
  pagination: TurnItemsPagination
  cancelled: boolean
  promise: Promise<void>
  isBackground: boolean
}
const turnItemsLoads = new Map<string, TurnItemsLoad>()
const olderTurnsLoads = new Map<string, { request: TurnBoundaryRequest; promise: Promise<'stop' | 'continue'> }>()
const failedHistoryBoundaries = new Map<string, TurnBoundaryRequest>()
const queuedItemPreviews = new Map<TurnItemsLoad, (admitted: boolean) => void>()
let activeItemPreviews = 0

function ownsTurnItemsLoad(load: TurnItemsLoad): boolean {
  const stream = getSessionStream(load.sessionId)
  return !load.cancelled && !stream.provisional && !isSessionStreamRetired(load.sessionId) && !unadmittedUserTurn(load.sessionId)
    && stream.savedTranscript?.generation === load.generation
    && savedTurn(stream.savedTranscript, load.turnId)?.itemsPagination === load.pagination
}

function cancelSavedHistoryLoads(sessionId: string): void {
  olderTurnsLoads.delete(sessionId)
  failedHistoryBoundaries.delete(sessionId)
  for (const [key, load] of turnItemsLoads) {
    if (load.sessionId !== sessionId) continue
    load.cancelled = true
    queuedItemPreviews.get(load)?.(false)
    queuedItemPreviews.delete(load)
    turnItemsLoads.delete(key)
  }
}

function updateTurnItemsLoad(load: TurnItemsLoad, loading: boolean, error?: string): void {
  if (!ownsTurnItemsLoad(load)) return
  patchSession(load.sessionId, prev => ({
    savedTranscript: prev.savedTranscript ? patchSavedTurn(prev.savedTranscript, load.turnId, turn => ({
      ...turn, itemsPagination: { ...turn.itemsPagination, isLoadingOlder: loading, error },
    })) : prev.savedTranscript,
  }))
  load.pagination = savedTurn(getSessionStream(load.sessionId).savedTranscript, load.turnId)!.itemsPagination
}

/** A load owns one turn cursor and commits every accepted page separately. */
export async function loadTurnHistoryItems(sessionId: string, turnId: string, complete = false): Promise<void> {
  const history = getSessionStream(sessionId).savedTranscript
  const turn = savedTurn(history, turnId)
  if (!history || !turn || getSessionStream(sessionId).provisional || turn.itemsPagination.hasLoadedOldest || unadmittedUserTurn(sessionId)) return
  const key = `${sessionId}:${turnId}`, existing = turnItemsLoads.get(key)
  if (existing && ownsTurnItemsLoad(existing)) {
    await existing.promise
    if (complete && ownsTurnItemsLoad(existing)) return loadTurnHistoryItems(sessionId, turnId, true)
    return
  }
  if (existing) {
    existing.cancelled = true
    queuedItemPreviews.get(existing)?.(false)
    queuedItemPreviews.delete(existing)
  }
  const load: TurnItemsLoad = {
    sessionId, turnId, generation: history.generation, pagination: turn.itemsPagination,
    cancelled: false, promise: Promise.resolve(), isBackground: complete || !!turn.itemsPagination.summaryItemIds,
  }
  turnItemsLoads.set(key, load)
  load.promise = (async () => {
    try {
      const api = (window as any).klaus
      while (ownsTurnItemsLoad(load)) {
        const preview = !complete && !!load.pagination.summaryItemIds
        if (preview && activeItemPreviews >= 2) {
          if (!await new Promise<boolean>(resolve => queuedItemPreviews.set(load, resolve))) return
        } else if (preview) activeItemPreviews++
        try {
          if (!ownsTurnItemsLoad(load)) return
          updateTurnItemsLoad(load, true)
          const expected = load.pagination
          const capturedRows = savedTurn(getSessionStream(sessionId).savedTranscript, turnId)!.items
          const page = await fetchTurnItemsPage(api, sessionId, turnId, expected)
          if (!ownsTurnItemsLoad(load)) return
          do {
            await loadSessionHistory(sessionId, { savedPage: {
              current: () => ownsTurnItemsLoad(load), reply: page.reply,
              update: latest => commitTurnItems(latest, turnId, expected, capturedRows, page),
            } })
          } while (ownsTurnItemsLoad(load))
          const latest = getSessionStream(sessionId).savedTranscript
          if (load.cancelled || latest?.generation !== load.generation) return
          const pagination = savedTurn(latest, turnId)?.itemsPagination
          if (!pagination) return
          load.pagination = pagination
          if (!complete || pagination.hasLoadedOldest) return
        } finally {
          if (preview) {
            const next = queuedItemPreviews.entries().next().value
            if (next) { queuedItemPreviews.delete(next[0]); next[1](true) }
            else activeItemPreviews--
          }
        }
      }
    } catch (error) {
      if (!ownsTurnItemsLoad(load)) return
      const message = error instanceof Error ? error.message : String(error)
      // A rewind can remove the turn between publishing its summary and the
      // item read. Reconcile once with the saved snapshot: when the turn is
      // really gone its pager and any live tail must retire with it instead of
      // leaving a retry banner that can only fail again. If the summary still
      // contains the turn, preserve the original error for an explicit retry.
      if (message.includes('unknown history turn')) {
        await loadSessionHistory(sessionId, { reconcile: true })
        if (!savedTurn(getSessionStream(sessionId).savedTranscript, turnId)) return
      }
      updateTurnItemsLoad(load, false, message)
      throw error
    } finally {
      if (turnItemsLoads.get(key) === load) turnItemsLoads.delete(key)
      scheduleHistoryRetention(sessionId)
    }
  })()
  return load.promise
}

export function retryHistoryLoad(sessionId: string): Promise<unknown> {
  return getSessionStream(sessionId).historyRetry === 'turns' ? loadOlderHistoryPage(sessionId) : loadSessionHistory(sessionId)
}

/** A persisted artifact owns its position; newer live revisions update that position. */
export function mergeApprovalReviewHistoryUnits(history: any[], liveUnits: LiveUnit[], previousHistory: any[] = []): { history: any[]; liveUnits: LiveUnit[] } {
  const persisted = new Set<string>()
  const known = new Map<string, { review: ApprovalReview; rawReview?: Record<string, unknown>; rawReviewAuthoritative?: boolean }>()
  for (const message of previousHistory) {
    const review = message.kind === 'approval-review' && approvalReview(message.approvalReview)
    if (review) known.set(review.reviewId, { review, rawReview: message.rawReview, rawReviewAuthoritative: message.rawReviewAuthoritative })
  }
  for (const unit of liveUnits) if (unit.type === 'live-approval-review') known.set(unit.review.reviewId, unit)
  const rows = history.map(message => {
    const saved = message.kind === 'approval-review' && approvalReview(message.approvalReview)
    if (!saved) return message
    persisted.add(saved.reviewId)
    const held = known.get(saved.reviewId)
    const current = held?.review
    if (!current || current.turnId !== saved.turnId || current.targetItemId !== saved.targetItemId) return message
    const currentWins = current.status !== 'inProgress' && (saved.status === 'inProgress'
      || (current.completedAtMs ?? 0) > (saved.completedAtMs ?? 0))
    const latest = currentWins ? current : saved
    return { ...message, approvalReview: { ...current, ...saved, ...latest },
      ...(currentWins || held?.rawReviewAuthoritative && !message.rawReviewAuthoritative || !message.rawReview
        ? { rawReview: held?.rawReview ?? approvalReviewEvent(latest), rawReviewAuthoritative: held?.rawReviewAuthoritative === true } : {}) }
  })
  return { history: rows, liveUnits: liveUnits.filter(unit => unit.type !== 'live-approval-review' || !persisted.has(unit.review.reviewId)) }
}

export function mergePlanningHistoryUnits(history: any[] | null, liveUnits: LiveUnit[], plans: readonly ProposedPlan[] = []): { history: any[] | null; liveUnits: LiveUnit[] } {
  if (!history) return { history, liveUnits }
  const updates = new Map<string, ProposedPlan>()
  for (const unit of liveUnits) if (unit.type === 'live-proposed-plan') {
    const previous = updates.get(unit.plan.id)
    if (!previous || unit.plan.revision > previous.revision) updates.set(unit.plan.id, unit.plan)
  }
  for (const plan of plans) {
    const previous = updates.get(plan.id)
    if (!previous || plan.revision >= previous.revision) updates.set(plan.id, plan)
  }
  const persisted = new Set<string>()
  let changed = false
  const next = history.map(message => {
    if (!Array.isArray(message.contentBlocks)) return message
    let rowChanged = false
    const contentBlocks = message.contentBlocks.map((block: any) => {
      if (block.type !== 'proposed_plan' || typeof block.plan?.id !== 'string') return block
      persisted.add(block.plan.id)
      const update = updates.get(block.plan.id)
      if (!update || update.turnId !== block.plan.turnId || update.revision < block.plan.revision) return block
      rowChanged = changed = true
      return { ...block, plan: update }
    })
    if (!rowChanged) return message
    const text = contentBlocks.map((block: any) => block.type === 'text' ? block.text : block.type === 'proposed_plan' ? block.plan.content : '').join('')
    return { ...message, text, contentBlocks }
  })
  return { history: changed ? next : history, liveUnits: liveUnits.filter(unit => (unit.type !== 'live-proposed-plan' || !persisted.has(unit.plan.id))
    && (unit.type !== 'live-planning-question' || !planningQuestionHistoryOwns(history, unit.request))) }
}

/** Apply complete engine snapshots without reordering an existing artifact. */
export function ingestPlanningSnapshot(sessionId: string, planning: PlanningSnapshot): void {
  patchSession(sessionId, previous => {
    const units = [...previous.liveUnits]
    for (const plan of planning.plans) {
      const key = `proposed-plan:${plan.id}`
      const index = units.findIndex(unit => unit.key === key)
      if (index >= 0) units[index] = { type: 'live-proposed-plan', key, plan, turnId: plan.turnId }
      else if (plan.status === 'writing' || plan.status === 'proposed') units.push({ type: 'live-proposed-plan', key, plan, turnId: plan.turnId })
    }
    const handoff = mergePlanningHistoryUnits(previous.history, units, planning.plans)
    return { ...handoff, liveRevision: previous.liveRevision + 1 }
  })
}

export function ingestGoalCompletion(sessionId: string, goal: GoalSnapshot): void {
  patchSession(sessionId, previous => {
    const key = `goal-completion:${goal.goalId}`
    if (previous.liveUnits.some(unit => unit.key === key)) return {}
    return { liveUnits: [...previous.liveUnits, { type: 'live-goal-completion', key, goal }], liveRevision: previous.liveRevision + 1 }
  })
}
export function ingestTaskGoalSnapshot(sessionId: string, goal: GoalSnapshot | null): void {
  if (syncTaskGoal(sessionId, goal)) patchSession(sessionId, () => ({ goalContinuationId: null }))
}
export function ingestPlanningQuestion(request: PlanningQuestionRequest): void {
  patchSession(request.sessionId, previous => {
    if (planningQuestionHistoryOwns(previous.history, request)) {
      const units = previous.liveUnits.filter(unit => unit.type !== 'live-planning-question'
        || unit.request.turnId !== request.turnId || unit.request.toolCallId !== request.toolCallId)
      return units.length === previous.liveUnits.length ? {} : { liveUnits: units, liveRevision: previous.liveRevision + 1 }
    }
    const key = `planning-question:${request.turnId}:${request.toolCallId}:${request.requestId}`
    const index = previous.liveUnits.findIndex(unit => unit.key === key)
    const units = [...previous.liveUnits]
    const unit: LiveUnit = { type: 'live-planning-question', key, request, turnId: request.turnId }
    if (index >= 0) units[index] = unit
    else units.push(unit)
    return { liveUnits: units, liveRevision: previous.liveRevision + 1 }
  })
}
