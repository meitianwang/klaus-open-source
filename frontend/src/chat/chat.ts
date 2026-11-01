import { friendDispatchAttempts } from './composer/friend-dispatch-attempt'
import { friendComposeMetadata, friendComposeTarget, friendIntentEditable, friendSendLabel, reconcileFriendComposeContext, hasFriendQuoteInstruction, type FriendComposeContext } from './composer/friend-compose'
import { mountFriendIntentSelect, type FriendIntentSelectApi } from './composer/friend-intent-select'
import { friendMessageUnreadTracker } from './friend-unread'
import { mediaInputMime } from '../../../shared/media-input'
import { createQueueRemovalRequest, type RemovalRequest } from '../../bridge/queue-removal'
import { applyStorageChange } from './storage-cleanup'
import type { StorageChatsChanged } from '../../../contracts/storage-settings'
import { windowStateKey } from '../app/window-state'
import { configureInlineUserEditing, inlineUserEdits } from './transcript/inline-user-edit'
import { inlineMessageEditFiles } from './composer/inline-message-edit'
import { disposeAttachmentObjectUrl, pendingPastedTextEntry, settlePastedTextAttachment } from './composer/attachment-lifecycle'
import { approvalReviewDenials } from './approval-review-state'
import { SessionNavigation } from './session-navigation'
import { createAgentTaskSnapshotBuilder } from './agent-task-snapshot'
import { createAgentTaskSaveGuard } from './agent-task-save-guard'
import { createContentFind } from './content-find'
import type { NativeMenuState } from '../../../contracts/native-menu-state'
import { desktopSiteUrl } from '../app/distribution'
import { openApprovalReviewDenials } from './transcript/approval-review'
import { approvalReviewShortcutRange, isApprovalReviewShortcut, withApprovalReviewShortcut } from './composer/approval-review-shortcut'
import { pickFastModeMetadata, isFastModePreferenceKey, type FastModeState } from '../../../shared/model-fast-mode'
import { modelOptionForValue, pickCursorModelMetadata } from '../../../shared/cursor-model-catalog'
import { pickAntigravityModelMetadata } from '../../../shared/antigravity-model-catalog'
import { pickTraeModelMetadata, traeThinkingLevels, traeThinkingLevel } from '../../../shared/trae-model-catalog'
import { pickKiroModelMetadata, kiroThinkingLevels, kiroThinkingLevel, isKiroRoutingAlias } from '../../../shared/kiro-model-catalog'
import { isAutomaticCursorSelection } from './composer/model-selection-values'
import { knownKiroAuthErrorText } from '../app/kiro-errors'
//
// 渲染域已全部绞杀进同目录的 React 组件树（transcript/composer/sidebar/panels），
// 本文件是剩余的数据面：会话生命周期、chatEvent 分发、IPC 管线、终端/浏览器/
// 工作区面板接线、以及 classic-script 时代遗留的 window 全局面。类型化随
// Batch 5 后续单元按域推进（届时逐段摘除本豁免）。
// Klaus Desktop — Chat UI (fully aligned with Web端)

import { createAppshotMainConsumer } from './composer/appshot-capture'
import type { PetMainCapture } from '../../../contracts/desktop-pet-appshot'
import { appshotContextText } from '../../../contracts/appshot-context'
const klausApi = window.klaus
// 流式状态 store（Batch 4）：chatEvent 全事件镜像入 store，功能域随迁移逐个改为订阅。
import { ingestPlanningQuestion, ingestGoalCompletion, ingestTaskGoalSnapshot, ingestPlanningSnapshot, ingestChatEvent, ingestChatFrameEvent, isStoppedTurnFrame, retireSessionStream, isSessionStreamRetired, registerSessionRetentionParticipant, trimSessionStreamCache, ingestEngineStatus, ingestLiveApproval, requestTurnInterrupt, clearTurnInterruptRequest, canContinueTurn, getSessionStream, ingestLocalUserTurn, retractLocalUserTurn, observeEditedUserTurn, commitEditedUserTurn, noteOnScreenCollapseStats, resolveLiveApproval, chatStreamStore, loadSessionHistory, reconcileSessionWorking, prepareSubagentStream, seedSubagentTasks, subagentOwnerStreamId, updateAsyncQuestionUi, reopenAsyncQuestionsForSession } from './stream-store'
import type { EditedUserTurnSnapshot } from './stream-store'
import type { ChatEvent, FollowUpStatusEvent, SessionInfo, FollowUpQueueItem, ClientQueueRow, ClientQueueSnapshot, ClientQueueWireRow, QueuedFollowUpDispatchedEvent, AgentTask, SlashCommandInfo, PendingFileEntry, CronTask, ModelOption, OutgoingPayload, FeedbackAttachment, FeedbackEmailStatus, FeedbackSubmitResult } from './engine-events'
import { prepareEphemeralSessionStream } from './stream-store'
import { mountReactTranscript, unmountReactTranscript } from './transcript'
import { captureTranscriptViewport, transcriptViewportState } from './transcript/viewport-state'
import { openFileCitationFromElement } from './file-citation-open'
import { DraftSessionPromotion } from './draft-session-promotion'
import { canRestorePendingDraft, goalSubmissionUserUuid, setPendingSubmissionRecovery, clearPendingSubmissionRecovery, pendingSubmissionRecovery, type PendingComposerSubmission } from './composer/pending-submission'
import { clearUnsentSubmission, recordUnsentSubmission, unsentSubmissionFor, type UnsentSubmissionRecord } from './composer/unsent-submissions'
import { beginPendingUserTurn, movePendingUserTurn, bindPendingUserTurn, finishPendingUserTurn, discardPendingUserTurn } from './stream-store'
// The transcript owns both halves of an edit's identity: which message the newest bubble
// names (`editTargetFromRow`), and how a sent message's recorded display metadata maps
// back onto composer chips. Reading them from there keeps one definition of each.
import { composerDraftFromDisplayMetadata } from './transcript/TranscriptView'
import { transcriptChromeState, transcriptContentPresence } from './transcript/chrome-state'
import { createBottomSticker, type BottomSticker } from './bottom-sticker'
import { mountOuterScrollbar } from './outer-scrollbar'
import { catalogNeedsLoading, isThinkingLevelValue, isThinkingLevelForModel, mainModelMenuValue, mountModelSelect, type MainModelItem, type ModelSelectApi } from './composer/model-select'
import { checkComposerModelConfiguration, createModelCatalogCache, createModelReadinessCache, isLikelyNetworkError, openComposerModelSettings } from './composer/model-readiness'
import { effectiveModelSource } from '../pages/settings/model-shared'
import { cursorErrorText } from '../app/cursor-errors'
import { mountWindowsSandboxBanner, type WindowsSandboxBannerMount } from './composer/windows-sandbox-banner'
import { mountPermissionSelect, permissionPresetFromResponse, type PermissionSelectApi, type PermissionPreset } from './composer/permission-select'
import { mountComposerPlusMenu } from './composer/plus-menu'
import { activatePlanShortcut, isPlanShortcut, withPlanShortcut } from './composer/plan-shortcut'
import { configurePlanningQuestions, receivePlanningQuestion, planningQuestionReadToken, reconcilePlanningQuestionRead, pendingPlanningQuestions, subscribePlanningQuestions, PlanningQuestionView } from './planning/questions-runtime'
import type { GoalSnapshot as GoalWireSnapshot, PlanningInputRequest } from '../../../contracts/planning-goals'
import type { PlanningQuestionRequest } from './planning/questions-state'
import { configurePlanningWorkflow, pendingProposedPlan, PendingPlanReview, planningSnapshot, receivePlanningSnapshot, subscribePlanningWorkflow } from './planning/runtime'
import type { PlanningSnapshot } from './planning/types'
import { PlanDocumentEditor } from './planning/plan-card'
import type { PlanReviewController } from './planning/plan-controller'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createElement } from 'react'
import { activateGoalShortcut, isGoalShortcut, withGoalShortcut } from './composer/goal-shortcut'
import { goalSurfaceControlsAvailable, goalSurfaceEligible, removeSideWorkflowControls } from './composer/workflow-surface'
import { mapCaretAroundToken, placeholderCount, shiftPositionAfterRemoval } from './composer/slash-placeholder'
import { openModelSettings, toggleSettings, openSettings } from '../pages/settings/shell'
import { openTeamIssueDeepLink, restoreCollaborationRoute } from '../pages/team-collaboration/project-navigation'
import { queueFriendInvite } from '../pages/friends/invite'
import { friendInboxSnapshot, friendTaskById, pendingFriendTaskForSession, refreshFriendInbox, subscribeFriendInbox, wireFriendInbox } from './friend-inbox'
import { FRIEND_COMPOSE_EVENT, takeQueuedFriendCompose, type FriendComposeRequest } from '../pages/friends/compose'
import { mountPreviews } from './composer/previews'
import { serializeSpecAnnotation } from './spec-annotation'
import { createSpecDocumentPanel } from './spec-document-panel'
import { markSpecAnnotation } from './spec-document-selection'
import { createGoalFromDraft, createGoalSubmissionGate } from './goal-creation'
import { GoalEditor, GoalEditorController, GoalProgressRow, GoalConfirmation, type GoalSnapshot, type GoalLocale } from './goals'
import { GoalSnapshots } from './goals/snapshots'
import { GoalCompletionCleanup } from './goals/completion-cleanup'
import { GoalInteractionClock, goalSubmissionRoute, reviewGoalDraft, reviewGoalResume, sameGoalDraft, sameGoalReview } from './goals/draft-review'
import { leavePlanningForGoal } from './goals/mode-entry'
import { goalImageInputs, prepareGoalSubmission, type PreparedGoalSubmission } from './goals/preparation'
import { goalAttachmentIntent, serializeGoalSubmissionIntent, GoalSubmissionReceipts, isGoalConflict, type GoalSubmissionReceipt } from './goals/submission'
import { hasUploadInFlight, resolveDeferredSend, type DeferredSendIntent } from './composer/deferred-send'
import { prepareComposerSubmission } from './composer/session-preparation'
import { createComposerDraft, normalizeComposerDraft, hasComposerDraftContent, selectedSlashCommandFromDraft, type ComposerDraft } from './composer/slash-draft'
import { ComposerCatalog, reconcileSlashDraft, SlashCatalog, StaleSlashCatalogRequest } from './composer/slash-catalog'
import { invalidateSkillsDataCache } from '../pages/skills/data'
import { composeInlineQuotes, composeInlineQuoteSubmission, composeSlashTextCards, composerOffsetFromDisplayOffset, expandSelectionAcrossInlineQuotes, insertInlineQuotePlaceholder, positionAfterRemovingInlineTokens, replaceInlineTokenRange, restoreInlineQuotePlaceholders, syncInlineQuoteRanges } from './composer/inline-quote'
import { configuredAgentReferences, normalizeComposerReferences, replaceComposerReferenceRange, syncComposerReferences, type ComposerReferenceToken } from './composer/reference-token'
import { isSkillCommand, migrateSkillDraft, referencesFromEditor, resourceReference, resourceReferenceContext, skillReference } from './composer/resource-reference'
import { composerReferenceClass, composerReferenceIconSvg, friendReferenceIdentity, renderComposerReferencePillHtml } from './composer/reference-pill'
import { friendDisplayName } from '../pages/friends/display-name'
import { updateFriendsRuntime } from '../pages/friends/runtime-state'
import { selectComposerSkillRows } from './composer/composer-skills'
import { unpackBuiltinSkillsReply } from '../pages/skills/builtin-reply'
import { slashCommandDisplayLabel } from './composer/slash-row-labels'
import { friendMentionValue } from '../../../shared/friends'
import { browserTabReference } from './composer/browser-tab-reference'
import { installBrowserTabFaviconFallback } from './composer/browser-tab-icon'
import { readClipboardText, writeClipboardText } from '../clipboard'
import { composerKeyWasHandled, installContenteditableTextControl, type ComposerTextControl } from './composer/contenteditable-control'
import type { InlineTokenSnapshot } from './composer/inline-token'
import { composerDocumentText, composerTokenDataWithinDepth, mergeComposerDocuments, restoreComposerDocument, type ComposerDocumentSnapshot } from './composer/document-model'
import { composerQueryInText, sameComposerQuery } from './composer/composer-query'
import { createEditorDiscovery, routeComposerPickerKey, type EditorDiscoveryContext } from './composer/editor-discovery'
import { composerDraftFromControl } from './composer/document-draft'
import { AttachmentHistory, installAttachmentHistory } from './composer/attachment-history'
import { workspaceReference, workspaceReferencesIn } from './composer/workspace-reference'
import { mountComposerPredictions, createPredictionSessionSelector, PREDICTIONS_ENABLED_KEY, PREDICTIONS_ACCEPTED_KEY, type PredictionSession } from './composer/predictions'
import { scrollCaretIntoView } from './composer/caret-scroll'
import { installComposerEditCommandBridge } from './composer/edit-command-bridge'
import { revealUserMessageContent } from './transcript/user-message-disclosure'
import { appendComposerHistory, composerHistoryScope, recalledHistoryIndex, restoreComposerHistory } from './composer/recall-history'
import { decideComposerPaste } from './composer/clipboard-paste'
import { composePastedTextRequest, isLargePastedText, pastedCardPreview, pastedReferenceSection, pastedTextPreview, PASTE_RESTORE_CHAR_LIMIT, type PastedTextCard } from './composer/pasted-text'
import { focusComposerAfterTurn, focusComposerInput, installComposerFocusRecovery } from './composer/focus'
import { attachmentSizeRejection, formatAttachmentSize, isInlineImage, maxAttachmentBytes } from './composer/attachment-policy'
import { pendingEntriesFromPrepare, restoredMessageTextCards, type RestoredMessageDraft } from './composer/sent-message-edit'
import { mountSlashMenu, type MentionEntry, type SlashMenuActions } from './composer/slash-menu'
import { createManualCompactController, isManualCompactCommand, manualCompactPresentation, manualCompactQueryAllowed, parseManualCompactInput, withManualCompactCommand } from './composer/manual-compact-command'
import { invalidatePluginMentions, invalidateDeviceMentions } from './composer/mention-queries'
import { WorkspaceFileSearchSession } from './composer/workspace-file-search-session'
import { mountFollowUpQueue, type FollowUpQueueApi, type FollowUpQueueHandlers } from './composer/follow-up-queue'
import { queuedRowContent, queuedComposerReferences } from './composer/queue-row-content'
import { engineFollowUpRows } from './engine-follow-up-queue'
import type { QueueSnapshotEvent } from './engine-events'
import { needsPausedQueueConfirmation, decisionFromDialog } from './composer/paused-queue-submit'
import { encodeSelectedTextEnvelope, parseSelectedTextEnvelope } from './selected-text-envelope'
import { dispatchWidgetInteraction, type WidgetInteractionRequest } from './widget-interaction'
import { mountSidebar, type SessionRowSpec } from './sidebar/session-list'
import { friendGroupThreadTitle } from './sidebar/friend-title'
import { sharedFriendUnread } from './sidebar/friend-unread'
import { forgetInputSnoozes, inputSnoozeRemaining, isInputRequestSnoozed, liveApprovalsOf, sessionAttentionState, snoozeInputRequest, takeExpiredSnooze, INPUT_SNOOZE_MS, type SessionWaitingKind } from './sidebar/attention'
import { readStoredSortMode, sortSectionRows, storeSortMode, type SidebarSortMode } from './sidebar/sort'
import { compareByAttentionState } from './sidebar/sort'
import { automationSourceLabel, isPinnedSession, isPlaceholderSessionTitle, mergeSidebarSessionSnapshot, partitionSidebarSessions, preserveVisibleSessionTitle, sessionTitleForCurrentSession, shouldDiscardEmptySessionOnLeave } from './sidebar/model'
import {
  CollapseWriteQueue, hasMoreProjectThreads, isProjectOpen, isSectionCollapsed, mayApplyAsyncState,
  parseProjectExpansionMap, parseSectionsCollapsed, projectThreadWindow, readProjectExpansion,
  reduceCollapsedBadge, revealDecision, seedSectionsFromLegacy, showMoreAfterPress, withProjectExpansion,
  withSectionCollapsed,
  type CollapsedBadge, type SectionsCollapsed, type SidebarSectionKey,
} from './sidebar/collapse'
import { SIDEBAR_PROJECT_EXPANDED_KEY, SIDEBAR_PROJECT_ORDER_CHANGED_KEY, SIDEBAR_SECTIONS_COLLAPSED_KEY } from '../../../contracts/sidebar-collapse'
import { bootFeatureOnboarding } from '../app/feature-onboarding'
import { parseStoredOrder, reconcileOrder } from './sidebar/project-order'
import { SessionPinning } from './sidebar/pinning'
import { initTerminal, forgetTerminalGroup, syncTerminalPanelForCurrentSession, scheduleTerminalResize, setTerminalOpen, renderTerminalList } from './terminal'
import { initBrowserPanel, isBrowserPanelMode, isBrowserPanelVisible, browserRuntimeVisible, hideBrowserRuntime, noteBrowserPanelManualResize, scheduleBrowserBoundsSync, showBrowserPanel, hideBrowserPanel } from './browser-panel'
import { initDigramPanel } from './digram/panel'
import { initModel3DPanel } from './model3d/panel'
import { initCanvasPanel, hideCanvasPanel, scheduleCanvasBoundsSync } from './canvas-panel'
import { initPrototypePanel, hidePrototypePanel, schedulePrototypeBoundsSync } from './prototype-panel'
import { initVideoEditingPanel, hideVideoEditingPanel, scheduleVideoEditingBoundsSync } from './video-editing-panel'
import { initPptPanel, hidePptPanel, schedulePptBoundsSync } from './ppt-panel'
import { createPptChatConsumer } from './ppt-chat'
import type { PptChatRequest } from '../../bridge/ppt-api'
import { initBackgroundProcessMonitor } from './background-process-monitor'
import { initMonitorSummary, noteToolReference, noteCommandReference, reconcilePlanSection, renderPlanRows, initSubagentSection, renderSubagentSection, subagentConversationId, subagentDisplayName, subagentDisplayStatus, subagentTaskText, noteMemoryWriteReference } from './overview'
import { normalizeSubagentAvatarIds, preserveSubagentAvatarId, subagentAvatarHtml } from './subagent-avatar'
import { notifySubagentsChanged } from './subagent-state'
import { paintSubagentModel } from './subagent-model'
import { coalesceSubagentTaskAliases, navigateToSubagentConversation } from './subagent-navigation'
import { initVoice, registerVoiceComposer, flushVoiceLearning, clearVoiceLearning, cancelVoiceForChat } from './voice'
import { mountVoiceChat } from './voice-chat/view'
import { activityToolDisplayName, activityToolPresentation } from './transcript/activity-tool-model'
import { initApprovals, syncApprovalBadge, trackApprovalRequest, untrackApprovalRequest, untrackApprovalRequestsOfSession, restorePendingPermissions, showPermissionRequest, showElicitRequest, showMemorySnapshotPrompt, type ApprovalRequest } from './approvals'
import { createQuickInputConsumer } from './quick-input-submission'
import { shouldRestoreWelcomeRunMode, type DraftRunMode } from './draft-run-mode'
import { runContextControls, runContextRowVisible, type RunTargetKind } from './run-context'
import { initAuthScreen, hideBootScreen, seedIdentityKv, beginAccountLogin } from './auth-screen'
import { initGuestSignin, syncGuestSigninUi } from './sidebar/guest-signin'
import { initFeatureGates, type FeatureGateController } from './sidebar/feature-gate'
import { initWorkspacePanel, hideWorkspaceMainView, showWorkspaceMainView, isWorkspaceMainActive, loadWorkspace, loadArtifacts, loadWorkspaceFile, scheduleWorkspaceReload, selectedWorkspaceFile, shouldSkipWorkspaceFileReloadForOwnWrite, closeWorkspaceContextMenu, fileIconSvg, folderIconSvg, workspaceRelativePath, workspaceRootFor, setWorkspaceRoot } from './workspace-panel'
import composerStyles from './composer/composer.module.css'
import { openImagePreview, configureImagePreview, type ImagePreviewOptions } from './image-preview'
import sidebarStyles from './sidebar/sidebar.module.css'
import { renderMarkdownHtml } from './markdown'
import { renderErrorNoticeHtml } from './error-notice'
import { tt, ttCount, setLanguage } from '../app/i18n'
import { syncTruncatedTip } from '../app/truncated-tip'
import { claimOverlay, registerOverlay, unregisterOverlay } from '../app/overlay-registry'
import { icon as klausIcon, contextPieSvg } from '../icons'
import { agentTasksEquivalent, observeMissingBackgroundAgents, preserveAgentLifecycle, reconcileAgentRuntimeState } from './agent-status'
import { createBackgroundAgentPoller } from './background-agent-poll'
import { sessionRunningChanges, sidebarSessionWorking } from './session-running-sync'
import { applyLiveTaskToolEnd, dropLiveTaskPending, forgetTaskItems, hasTaskItems, noteLiveTaskToolInputDelta, noteLiveTaskToolStart, setTaskItems, taskItems, taskNumberLabel, taskPlanIdentity, type TaskPlanIdentity } from './task-state'
import { escapeHtml, showToast } from '../app/ui-shared'
import { normalizeProjectMcpData } from '../pages/mcp/project-status'
import { buildMcpServerConfig, formatMcpCommandLine } from '../pages/mcp/server-form'
import { isHiddenBuiltinSlashCommand } from '../pages/slash-commands/helpers'
import mcpStyles from '../pages/mcp/mcp.module.css'
const chatProductContracts = window.KlausRendererProductContracts
// 与壳层 cloud.rs 的 DEFAULT_BASE_URL 保持一致。
// --- State ---
window.currentSessionId = null
let sessions: SessionInfo[] = []
let archivedSessions: SessionInfo[] = []
const sessionTitleVersions = new Map()
const sessionPinning = new SessionPinning({
  getSessions: () => sessions,
  setSessions: next => { sessions = next },
  persist: (id, pinned) => klausApi.session.setPinned(id, pinned),
  render: () => renderSessionList(),
})
let busy = false
const creatingGoalSessions = createGoalSubmissionGate()
const goalInteractions = new GoalInteractionClock()
const preparingSubmissions = createGoalSubmissionGate()
const pendingComposerSubmissions = new Map<string, PendingComposerSubmission>()
let visiblePendingSubmissionId: string | null = null
window.getCurrentSessionId = () => window.currentSessionId
window.getKnownSessionInfo = (sessionId: string) => findKnownSession(sessionId)
;(window as any).klausSideTaskHasUserMessage = (sessionId: string): boolean | null => {
  const stream = chatStreamStore.getState().sessions[sessionId]
  if (!stream) return null
  if (stream.history?.some(message => message.role === 'user') || stream.liveUnits.some(unit => unit.type === 'live-user')) return true
  return stream.history === null ? null : false
}
// Per-surface streaming state (buffer / currentMsgGroup / paintSuspended /
// paintRaf) lives on each ChatSurface (see createChatSurface), so the main and
// side transcripts can stream concurrently without clobbering each other.
// Per-session accumulator for the in-flight assistant text block. A session can
// keep streaming while off-screen; the disk transcript won't contain that turn
// until it completes, so on switch-back we repaint the live text from here —
// otherwise only the deltas arriving after switch-back show ("lost first half").
// Keyed by sessionId; cleared at each text-block boundary (finalize/tool_start)
// and on done/reload.
const liveStreamText = new Map()
const runningSessions = new Set()
const stoppingSessions = new Set<string>()
const sessionRuntimeIdleObservations = new Map<string, number>()
const SESSION_RUNTIME_AUDIT_INTERVAL_MS = 15_000
const SESSION_RUNTIME_IDLE_CONFIRMATIONS = 2
let sessionRuntimeAuditTimer = 0
let sessionRuntimeAuditInFlight = false
let sessionListReorderSeq = 0
let sessionListReadSeq = 0
let sessionListSettledSeq = 0
let sessionListLoadFailed = false
// Sessions with a continue request in flight. Same shape and reason as
// stoppingSessions: a second click while the first request is outstanding must
// be dropped. The entry survives the IPC acknowledgement and is released only
// when engine activity proves the Turn started, or on start failure.
const continuingSessions = new Set<string>()
// The composer's primary button changes ROLE after a stop (send → continue). The
// change is held back past the double-click window: it is the same button, so a
// stop the engine confirms in under a double-click would turn the user's second
// click into "start another turn", which is the opposite of what they asked for.
const CONTINUE_ARM_DELAY_MS = 700
const continueArmUntil = new Map<string, number>()
// Escape arms the stop before it fires it: the
// first press names the key on the stop button, a second press within the window
// actually interrupts. Escape is a dismiss key everywhere else in the composer,
// so a single press must not be able to kill a running Turn by accident.
const STOP_ESC_ARM_MS = 2000
let stopEscArmedTurn: { sessionId: string; turnId: string | null } | null = null
let stopEscArmTimer = 0

function clearStopEscArm() {
  if (stopEscArmTimer) { window.clearTimeout(stopEscArmTimer); stopEscArmTimer = 0 }
  if (stopEscArmedTurn === null) return
  stopEscArmedTurn = null
  updateSendBtn()
}

/**
 * Whether the stop is armed for the Turn the composer is pointed at. Scoped to
 * the Turn, not just the session: the arming window outlives its own Turn, and a
 * session-wide arm would let the second Escape kill whichever Turn started next.
 */
function stopEscArmed(): boolean {
  if (!stopEscArmedTurn) return false
  const sessionId = window.currentSessionId || ''
  if (stopEscArmedTurn.sessionId !== sessionId) return false
  return stopEscArmedTurn.turnId === getSessionStream(sessionId).activeTurnId
}

function armStopEsc(sessionId: string) {
  if (stopEscArmTimer) window.clearTimeout(stopEscArmTimer)
  stopEscArmedTurn = { sessionId, turnId: getSessionStream(sessionId).activeTurnId }
  stopEscArmTimer = window.setTimeout(clearStopEscArm, STOP_ESC_ARM_MS)
  updateSendBtn()
}
const userInterruptedSessions = new Set()
const followUpModeHelper = window.KlausFollowUp || {
  FOLLOW_UP_QUEUE_MODE_KEY: 'follow_up_queue_mode',
  normalizeMode: (value: string) => value === 'steer' ? 'steer' : 'queue',
  resolveSubmitAction: (value: string, invert: boolean) => {
    const mode = value === 'steer' ? 'steer' : 'queue'
    return invert ? (mode === 'queue' ? 'steer' : 'queue') : mode
  },
  addItem: (items: FollowUpQueueItem[], item: FollowUpQueueItem) => [...items, item],
  removeItem: (items: FollowUpQueueItem[], id: string) => items.filter((item) => item.id !== id),
  updateItem: (items: FollowUpQueueItem[], id: string, patch: Partial<FollowUpQueueItem>) => items.map((item) => item.id === id ? { ...item, ...patch } : item),
  reorderItem: (items: FollowUpQueueItem[], id: string, overId: string | null) => {
    const next = [...items]
    if (!id || !overId || id === overId) return next
    const from = next.findIndex((item) => item.id === id)
    const to = next.findIndex((item) => item.id === overId)
    if (from < 0 || to < 0) return next
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
  },
  createId: () => `follow-up-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}
let followUpQueueMode = 'queue'
let followUpQueueModeReadGeneration = 0
/**
 * The host's authoritative follow-up queue, per session.
 *
 * Kept as a cache of what the host pushed, never as a source of truth: the host
 * stores the queue durably, dispatches it after each turn ends, and republishes a
 * snapshot after every mutation. The renderer holding its own array instead is what
 * used to make queued messages vanish on reload and made two sources that could
 * disagree about order.
 */
const clientQueueBySession = new Map<string, ClientQueueSnapshot>()
/** Mutations awaiting the host's reply, so a row cannot be acted on twice at once. */
const clientQueueMutationsInFlight = new Set<string>()
// A lost addition acknowledgement keeps its original identity and complete
// payload across reloads, until the host can replay its durable receipt.
const pendingQueueAdditions = loadPendingQueueAdditions()
const sidebarListedWorkingSessions = new Set<string>()
const sidebarCompletedSessions = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('klaus_sidebar_completed_sessions') || '[]')) }
  catch { return new Set() }
})()
const reloadOnMessageCompleteSessions = new Set()
// The preview limit lives in sidebar/collapse.ts (PROJECT_THREAD_PREVIEW_LIMIT)
// so the windowing rule and its unit tests share one definition.
// --- Thinking / turn-activity indicators, per ChatSurface ---
// 切默认后两类指示器由 React 渲染（store.thinkingActive / activityVisible，
// 见 LiveTail）；工厂降级为 no-op 接口保住残留调用点（随渲染域清理一并删），
// 绝不再触碰 React root 管理的 DOM——否则 React 卸载/重渲时 removeChild 会炸。
function createThinkingUI(_surface: unknown) {
  return {
    el: null,
    startTime: 0,
    requestStartTime: 0,
    markRequestStart() {},
    show() {},
    append(_text: string) {},
    _pending: '',
    _raf: 0,
    _flushPending() {},
    finalize() {},
    reset() {},
  }
}

function createTurnActivityUI(_surface: unknown) {
  return {
    el: null,
    sweep() {},
    show() {},
    hide() {},
  }
}
// Tool calls 每个独立折叠 — 不再 ride 全局开关。新建 tool-item 默认折叠
// （没有 .open 类），点 header 只切自己。

let slashRequestSeq = 0
let selectedSlashCommand: SlashCommandInfo | null = null
let selectedSlashCommandRange: { start: number; end: number } | null = null
let composerReferenceTokens: ComposerReferenceToken[] = []
let friendComposeContext: FriendComposeContext = { intent: 'request' }
let friendIntentApi: FriendIntentSelectApi | null = null
let friendSendInFlight = false
let friendDispatchAttempt: { key: string; id: string } | null = null
const persistedFriendAttempts = friendDispatchAttempts(localStorage, windowStateKey('main'))
const friendUnreadMessages = friendMessageUnreadTracker(localStorage, windowStateKey('friend-unread-messages'))
const PARKED_FRIEND_DRAFTS_KEY = windowStateKey('klaus_parked_friend_drafts')
const parkedFriendDrafts = (() => {
  try {
    const entries = JSON.parse(localStorage.getItem(PARKED_FRIEND_DRAFTS_KEY) || '[]')
    return new Map<string, { draft: ComposerDraft; files: PendingFileEntry[] }>(Array.isArray(entries) ? entries.flatMap(([key, value]) =>
      typeof key === 'string' && value?.draft ? [[key, { draft: normalizeComposerDraft(value.draft), files: Array.isArray(value.files) ? value.files : [] }]] : []) : [])
  } catch { return new Map<string, { draft: ComposerDraft; files: PendingFileEntry[] }>() }
})()
function persistParkedFriendDrafts(): boolean {
  return persistLocalValue(PARKED_FRIEND_DRAFTS_KEY, JSON.stringify([...parkedFriendDrafts].map(([key, value]) => [key, {
    draft: value.draft, files: value.files.map(entry => ({ ...entry,
      file: { name: entry.file.name, type: entry.file.type, size: entry.file.size },
      objectUrl: null, uploading: false, error: entry.uploading || !entry.uploadPath && entry.kind !== 'text' ? true : entry.error,
    })),
  }])))
}
let activeSlashTriggerRange: { start: number; end: number; prefix?: '/' | '@' | '$'; query?: string } | null = null
let composerMenuMode: string | null = null
let composerPredictions: ReturnType<typeof mountComposerPredictions> | null = null
let mainWindowsSandboxBanner: WindowsSandboxBannerMount | null = null
let sideWindowsSandboxBanner: WindowsSandboxBannerMount | null = null
let voiceChatUi: ReturnType<typeof mountVoiceChat> | undefined
let sideVoiceChatUi: ReturnType<typeof mountVoiceChat> | undefined
let mountSideComposerVoice: (() => void) | undefined
const predictionModelSelections = new Map<string, string>()
let workspaceAtTrigger: { start: number; end: number; query?: string } | null = null
// The @ menu opens on category rows (files / folders) rather than a flat dump
// of every project path: picking a category first is what keeps a large
// workspace out of the first screen of the picker. Null = category level.
let workspaceMentionScope: 'files' | 'folders' | null = null
let externalImportRefreshBound = false
// Agent / teammate panel data feed. Sticky accumulator — completed/failed/
// killed/cancelled agents are never removed from the cache even when the
// engine evicts them from appState.tasks (engine sends full-snapshot
// tasks_changed; mergeAgentTasks only adds/updates, never deletes terminal
// entries). Mirrors Tasks panel permanence.
let tasksBySession = new Map<string, Record<string, AgentTask>>()  // sessionId → Record<taskId, AgentTaskSnapshot>
// The active task-specific subagent tab owns this optional detail resource.
let activeSubagentTaskId: string | null = null

// Debounce timers for per-session disk saves (keyed by sessionId).
const _agentSaveTimers = new Map()
const _agentSaveFailures = new Map<string, number>()
const agentTaskLifetimes = new Map<string, object>()
const agentTaskLoadTokens = new Map<string, object>()
const AGENT_SAVE_RETRY_DELAYS = [1000, 3000, 10_000]

// When the engine sends a live snapshot, tasks that were running but are now
// absent were evicted immediately after completion (inProcessRunner calls
// evictTerminalTask right after setting status→completed, so the two
// setAppState calls collapse into one tasks_changed without the intermediate
// "completed" state). Auto-terminate those tasks here so the panel never
// shows a permanently-running badge for a finished agent.
function autoTerminateVanishedRunningTasks(sessionId: string, engineSnapshot: Record<string, AgentTask>) {
  const existing = tasksBySession.get(sessionId)
  if (!existing) return
  for (const [id, task] of Object.entries(existing)) {
    if (!task || task.isBackground) continue
    if ((task.status === 'running' || task.status === 'pending') && !(id in engineSnapshot)) {
      existing[id] = { ...task, status: 'completed', notified: true }
    }
  }
}

function mergeAgentTasks(sessionId: string, newTasks: Record<string, AgentTask>) {
  if (isSessionStreamRetired(sessionId)) return
  if (!agentTaskLifetimes.has(sessionId)) agentTaskLifetimes.set(sessionId, {})
  const existing = tasksBySession.get(sessionId) || {}
  for (const [id, task] of Object.entries(newTasks || {})) {
    // Preserve captured teammate messages: the engine snapshot deliberately
    // excludes task.messages to avoid IPC bloat, but the renderer may have
    // already received them via the teammate_messages event. Don't overwrite.
    const alias = task.agentId && task.agentId !== id ? existing[task.agentId] : undefined
    const prev = existing[id] || (alias && (!alias.agentId || alias.agentId === task.agentId) ? alias : undefined)
    const incoming = preserveAgentLifecycle(prev, task)
    if (incoming === prev) continue
    let merged = (prev?.messages && !incoming.messages)
      ? { ...incoming, messages: prev.messages }
      : incoming
    merged = preserveSubagentAvatarId(prev, merged)
    if (prev?.isBackground && !merged.isBackground) {
      merged = { ...merged, isBackground: true }
    }
    // The task-call accumulator never carries the resolved model (only the
    // engine lifecycle rows stamp it), so a tasks_changed burst must not wipe
    // a model an earlier reconcile already learned.
    if (typeof prev?.model === 'string' && prev.model && !merged.model) {
      merged = { ...merged, model: prev.model, modelSource: merged.modelSource ?? prev.modelSource }
    }
    // Preserve the read marker: the engine snapshot never carries `notified`
    // (klaus's accumulator deliberately omits it), but the renderer sets it
    // when the user opens a sub-agent. A blind replace would flip the unread
    // badge back on the next tasks_changed, so carry the read state from prev.
    if (prev?.notified && !merged.notified) {
      merged = { ...merged, notified: true }
    }
    existing[id] = merged
  }
  const coalesced = coalesceSubagentTaskAliases(existing)
  const aliases = Object.fromEntries(Object.entries(coalesced).flatMap(([id, task]) =>
    task.agentId && task.agentId !== id && existing[task.agentId] && !(task.agentId in coalesced) ? [[task.agentId, id]] : []))
  for (const id of Object.keys(existing)) if (!(id in coalesced)) delete existing[id]
  Object.assign(existing, coalesced)
  normalizeSubagentAvatarIds(existing)
  // Keep any previously-seen terminal tasks even if absent from the new
  // snapshot (engine evicted them from appState.tasks after evictAfter).
  tasksBySession.set(sessionId, existing)
  if (window.currentSessionId === sessionId && Object.keys(aliases).length) {
    if (activeSubagentTaskId) activeSubagentTaskId = aliases[activeSubagentTaskId] || activeSubagentTaskId
    if (viewingAgentSessionId === sessionId && viewingAgentTaskId) viewingAgentTaskId = aliases[viewingAgentTaskId] || viewingAgentTaskId
    ;(window.KlausPanelTabs as any)?.remapSubagentTasks?.(aliases)
  }
  seedSubagentTasks(sessionId, existing)
  notifySubagentsChanged()
  scheduleAgentTasksSave(sessionId)
}

const buildAgentTaskSnapshot = createAgentTaskSnapshotBuilder()
const agentTaskSaveGuard = createAgentTaskSaveGuard<Record<string, AgentTask>>()
const agentTaskSnapshot = (sessionId: string, tasks: Record<string, AgentTask>) => buildAgentTaskSnapshot(tasks,
  task => subagentOwnerStreamId(sessionId, task), owner => getSessionStream(owner).agentTimeline)

registerSessionRetentionParticipant({
  protected(sessionId) {
    const tasks = tasksBySession.get(sessionId)
    return agentTaskLoadTokens.has(sessionId) || !!tasks && (_agentSaveTimers.has(sessionId) || _agentSaveFailures.has(sessionId)
      || agentTaskSaveGuard.protected(sessionId, agentTaskSnapshot(sessionId, tasks)))
  },
  retire(sessionId) {
    const tasks = tasksBySession.get(sessionId)
    if (tasks) buildAgentTaskSnapshot.forget(tasks)
    tasksBySession.delete(sessionId)
    agentTaskLifetimes.delete(sessionId)
    agentTaskLoadTokens.delete(sessionId)
    backgroundAgentPoller.cancel(sessionId)
    _agentMissingObservations.delete(sessionId)
    const reconcile = _agentReconcilePending.get(sessionId)
    if (reconcile != null) clearTimeout(reconcile)
    _agentReconcilePending.delete(sessionId)
    agentTaskSaveGuard.forget(sessionId)
    const timer = _agentSaveTimers.get(sessionId)
    if (timer != null) clearTimeout(timer)
    _agentSaveTimers.delete(sessionId)
    _agentSaveFailures.delete(sessionId)
  },
})

// Persist a session's agent-task map to disk, debounced 600ms so rapid
// tasks_changed bursts coalesce. Shared by mergeAgentTasks and markAgentRead.
function scheduleAgentTasksSave(sessionId: string, delayMs = 600) {
  if (!tasksBySession.has(sessionId)) return
  if (_agentSaveTimers.has(sessionId)) clearTimeout(_agentSaveTimers.get(sessionId))
  _agentSaveTimers.set(sessionId, setTimeout(() => {
    _agentSaveTimers.delete(sessionId)
    const existing = tasksBySession.get(sessionId)
    if (!existing) return
    const snapshot = agentTaskSnapshot(sessionId, existing)
    if (agentTaskSaveGuard.acknowledged(sessionId, snapshot)) {
      _agentSaveFailures.delete(sessionId)
      trimSessionStreamCache()
      return
    }
    const ticket = agentTaskSaveGuard.begin(sessionId)
    void Promise.resolve().then(() => agentTaskSaveGuard.active(ticket) ? klausApi.agents.saveTasks(sessionId, snapshot) : undefined).then((result: any) => {
      if (result?.ok === false || result?.error) throw new Error(result?.error || tt('agent_tasks_save_failed'))
      if (!agentTaskSaveGuard.complete(ticket, snapshot)) return
      _agentSaveFailures.delete(sessionId)
      trimSessionStreamCache()
    }).catch((error: any) => {
      if (!agentTaskSaveGuard.fail(ticket)) return
      const failures = (_agentSaveFailures.get(sessionId) || 0) + 1
      _agentSaveFailures.set(sessionId, failures)
      const retryDelay = AGENT_SAVE_RETRY_DELAYS[failures - 1]
      if (retryDelay != null && tasksBySession.has(sessionId)) {
        scheduleAgentTasksSave(sessionId, retryDelay)
        return
      }
      window.showToast?.(error?.message || tt('agent_tasks_save_failed'), { duration: 5000 })
    })
  }, delayMs))
}

// Mark a completed sub-agent as read (clears the unread badge). klaus has no
// backend notified state — the read marker lives only in the renderer's
// tasksBySession (persisted via the sidecar file). Returns true if the state
// changed, so the caller knows whether a re-render is warranted.
function markAgentRead(sessionId: string, taskId: string) {
  const existing = tasksBySession.get(sessionId)
  const task = existing?.[taskId]
  if (!task || task.notified) return false
  // Only completed agents carry an unread badge (see overview/subagents.ts). Marking
  // a still-running agent read would silently swallow the unread cue once it
  // finishes, so defer until it's actually completed.
  if (task.status !== 'completed') return false
  existing[taskId] = { ...task, notified: true }
  scheduleAgentTasksSave(sessionId)
  return true
}

// Task list state. Per-session cache keyed by
// sessionId; currentSessionId's entry drives rendering inside the right
// Monitor panel's Tasks section. Engine pushes `task_list` events for any
// session, we cache them; switchSession also pulls a fresh snapshot from
// disk. No auto-hide timer — Monitor is an always-on surface; when all tasks
// complete the section stays so the user can see the final outcome.
let taskPanel = {
  unavailable: new Map(), // sessionId → Rust Task unavailable result
  metadata: new Map(), // sessionId → authoritative Task generation/revision metadata
  requestIds: new Map(),
  liveVersions: new Map(),
  nextRequestId: 0,
}

const AGENT_COLOR_MAP = {
  blue: 'var(--info)',
  green: 'var(--success)',
  purple: 'var(--theme-skill)',
  orange: 'var(--warning)',
  red: 'var(--danger)',
  yellow: 'var(--warning)',
}
let pendingFiles: PendingFileEntry[] = []  // { file, objectUrl, uploadId, uploading, kind?, previewText? }
let inlineQuoteSeq = 0
// Attaching a file needs a real engine session before the user sends anything.
// Keep that transport detail separate from the conversation lifecycle: these
// sessions still belong to the welcome layout and keep their run context editable
// until a real turn starts.
const draftOnlySessionIds = new Set<string>()
// Conversations whose turn was admitted through submitTurnPayload in this
// window. Empty-shell recycling must never delete them: the rollout flush can
// lag admission, so an authoritative history read may still look empty.
const submittedTurnSessionIds = new Set<string>()
const emptySessionDiscardChecks = new Set<string>()
const sessionDeletePending = new Set<string>()
let sessionDeletionRevision = 0

function isDraftOnlySession(sessionId: string | null | undefined) {
  return !!sessionId && draftOnlySessionIds.has(sessionId)
}

// A submit the user made while an attachment was still uploading. Enter calls
// send() directly and ignores btnSend.disabled, so pasting an image and
// immediately hitting Enter used to hit the uploading guard and vanish with no
// feedback. Park the intent here; the last upload to settle replays it.
let pendingSendAfterUpload: DeferredSendIntent | null = null

function cancelDeferredSend() {
  if (!pendingSendAfterUpload) return
  pendingSendAfterUpload = null
  updateSendBtn()
}

// Called whenever an upload settles (success or failure). Replays the parked
// submit once nothing is in flight anymore.
function releaseDeferredSendIfReady() {
  const decision = resolveDeferredSend(
    pendingSendAfterUpload,
    pendingFiles,
    hasComposerText() || pendingFiles.length > 0,
  )
  if (decision.action === 'wait') return
  pendingSendAfterUpload = null
  if (decision.action === 'none') { updateSendBtn(); return }
  void send({ invertFollowUp: decision.intent.invertFollowUp })
}
// Composer attachments are session-scoped like text drafts: pendingFiles is
// the live array for the CURRENT session only; switching away stashes it
// here and switching back restores it. Otherwise a pasted image would ride
// along into whatever session the user opens next.
const sessionPendingFiles = new Map()  // sessionId -> pendingFiles array

function stashPendingFiles(sessionId: string | null) {
  updateComposerQuoteOffsets()
  if (pendingFiles.length > 0) sessionPendingFiles.set(sessionId, pendingFiles)
  else sessionPendingFiles.delete(sessionId)
  // A parked submit belongs to the session being left; it must not follow the
  // user into whichever session they open next.
  pendingSendAfterUpload = null
  // Detach the live array: callers may clear/revoke the composer state after
  // stashing, which must not touch the stashed entries.
  pendingFiles = []
}

function restorePendingFiles(sessionId: string | null) {
  pendingFiles = sessionPendingFiles.get(sessionId) || []
  sessionPendingFiles.delete(sessionId)
  restoreComposerInlineQuotes()
  renderPreviews()
  renderSelectedSlashCommand()
}

function restoreComposerInlineQuotes() {
  const tokens = mainComposerControl?.readTokens() || []
  if (tokens.some(token => (token.data as { kind?: string })?.kind === 'selected-text')) {
    pendingFiles = restoreInlineDocumentFiles(pendingFiles, tokens)
    return
  }
  const inlineEntries = pendingFiles.filter(entry => (entry.kind === 'selected-text' || entry.kind === 'pasted-text') && Number.isInteger(entry.composerOffset))
  if (inlineEntries.length > 0) {
    for (const entry of inlineEntries) entry.range = undefined
    const previous = inputEl.value
    const restored = restoreInlineQuotePlaceholders(
      inputEl.value,
      inlineEntries,
      inlineQuotePlaceholder,
      entry => displayOffsetToComposerOffset(Number(entry.composerOffset)),
    )
    syncComposerReferenceRanges(previous, restored)
    setInputValue(restored)
    try { inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length) } catch {}
    mainComposerControl?.resetHistory()
  }
}

function dropPendingFilesForSession(sessionId: string) {
  const active = window.currentSessionId === sessionId
  const retired = new Set<PendingFileEntry>([...(sessionPendingFiles.get(sessionId) || []), ...(active ? pendingFiles : [])])
  for (const entry of retired) disposeAttachmentObjectUrl(entry)
  sessionPendingFiles.delete(sessionId)
  if (active) { pendingFiles = []; pendingSendAfterUpload = null }
}

window.isSessionRunning = (sessionId?: string | null) => !!sessionId && runningSessions.has(sessionId)
// sessionId → PermissionRequest[]: permission asks that arrived while the user
// was looking at a different session (cron-run sessions trigger these in the
// background). switchSession() drains the list when the user opens that session
// so the card materializes at that moment. permission_cancelled drops the entry
// here too. We don't try to render into the off-screen session's DOM because
// chat:event for off-screen sessions is fully filtered out (see
// klausApi.on.chatEvent), so no tool_use anchors exist to attach to anyway.
let pendingPermissionsBySession = new Map<string, ApprovalRequest[]>()
// sessionId → ElicitRequestCard[]: 引擎内置 ask_user 追问，到达时用户正看着别的会话。
// 与 pendingPermissionsBySession 同构：switchSession 切回时物化，elicit_cancelled 撤销时移除。
let pendingElicitsBySession = new Map<string, ApprovalRequest[]>()
// requestId → ElicitRequestCard：供 submitElicit 按 options 下标还原选中文本（避免把
// 选项文本塞进 DOM 属性再解析的转义问题）。submit/decline/cancel 后删。
const elicitRequestsById = new Map()

// ==================== 审批基础设施（已拆出至 src/chat/approvals.ts） ====================
initApprovals({
  currentSessionId: () => window.currentSessionId || null,
  isCronRunSession: (sessionId: string) => isCronRunSession(sessionId),
  markCronRunUnread: (sessionId: string) => markSidebarSessionCompleted(sessionId),
  renderSessionList: () => renderSessionList(),
  pendingPermissionsBySession,
  pendingElicitsBySession,
})

let switchSeq = 0  // monotonic; each switchSession run captures this and bails out if a newer click superseded it mid-await
let sidebarCollapsed = localStorage.getItem('klaus_sidebar_collapsed') === '1'
const PANEL_RESIZE_MIN_MAIN_WIDTH = 420
// Sidebar width is fixed by design (user request: no manual dragging); only
// the artifacts panel stays resizable. panelResizeLimit() still references the
// sidebar's live width when capping the artifacts panel, so it stays as-is.
const PANEL_RESIZE_CONFIGS = [
  {
    handleId: 'artifacts-panel-resizer',
    panelId: 'artifacts-panel',
    cssProperty: '--artifacts-panel-width',
    storageKey: windowStateKey('klaus_artifacts_panel_width'),
    min: 260,
    max: 900,
    direction: -1,
  },
]

function panelResizeLimit(panelId: string, min: number, max: number) {
  const appWidth = document.getElementById('app')?.getBoundingClientRect().width || window.innerWidth
  const otherPanelId = panelId === 'sidebar' ? 'artifacts-panel' : 'sidebar'
  const otherPanel = document.getElementById(otherPanelId)
  const otherPanelVisible = otherPanel
    && !otherPanel.classList.contains('collapsed')
  const otherWidth = otherPanelVisible ? otherPanel.getBoundingClientRect().width : 0
  return Math.max(min, Math.min(max, appWidth - otherWidth - PANEL_RESIZE_MIN_MAIN_WIDTH))
}

function applyStoredPanelWidths() {
  for (const config of PANEL_RESIZE_CONFIGS) {
    const rawStored = localStorage.getItem(config.storageKey)
    if (rawStored === null) continue
    const stored = Number(rawStored)
    if (!Number.isFinite(stored)) continue
    const width = Math.round(Math.min(config.max, Math.max(config.min, stored)))
    document.documentElement.style.setProperty(config.cssProperty, `${width}px`)
    document.getElementById(config.handleId)?.setAttribute('aria-valuenow', String(width))
  }
}

function bindPanelResizer(config: { handleId: string; panelId: string; cssProperty: string; storageKey: string; min: number; max: number; direction: number }) {
  const handle = document.getElementById(config.handleId)
  const panel = document.getElementById(config.panelId)
  if (!handle || !panel) return

  handle.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return
    // Every tab shares one panel width, so the resizer works in every mode; the
    // dragged width persists and stays put across tab switches.
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panel.getBoundingClientRect().width
    const maxWidth = panelResizeLimit(config.panelId, config.min, config.max)
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('is-resizing')
    document.body.classList.add('panel-resizing')
    // A manual drag is explicit intent: automatic content-width widening
    // yields to the dragged value for the rest of this document.
    noteBrowserPanelManualResize()

    const onPointerMove = (moveEvent: PointerEvent) => {
      const width = Math.round(Math.min(maxWidth, Math.max(
        config.min,
        startWidth + ((moveEvent.clientX - startX) * config.direction),
      )))
      document.documentElement.style.setProperty(config.cssProperty, `${width}px`)
      handle.setAttribute('aria-valuenow', String(width))
      if (typeof scheduleTerminalResize === 'function') scheduleTerminalResize()
      if (typeof scheduleBrowserBoundsSync === 'function') scheduleBrowserBoundsSync()
    }

    const finishResize = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
      window.removeEventListener('blur', finishResize)
      handle.classList.remove('is-resizing')
      document.body.classList.remove('panel-resizing')
      const width = Math.round(panel.getBoundingClientRect().width)
      persistLocalValue(config.storageKey, String(width))
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)
    window.addEventListener('blur', finishResize)
  })
}

applyStoredPanelWidths()
PANEL_RESIZE_CONFIGS.forEach(bindPanelResizer)
const ACTIVE_PROJECT_WORKDIR_KEY = 'klaus_active_project_workdir'
const PROJECT_THREAD_EXPANDED_KEY = 'klaus_project_thread_expanded'
const PROJECTS_COLLAPSED_KEY = 'klaus_projects_collapsed'
const CONVERSATIONS_COLLAPSED_KEY = 'klaus_conversations_collapsed'
// localStorage mirrors of the two settings.db rows named in
// contracts/sidebar-collapse.ts. The mirror exists only so the first paint can
// read synchronously; settings.db is authoritative and overwrites both on
// hydrate. Deliberately NOT in contracts/legacy-ui-state.ts UI_KEYS: that
// migration writes KV→localStorage, while these keys flow the other way, so
// staging them would resurrect stale values.
const SIDEBAR_PROJECT_EXPANDED_MIRROR_KEY = 'klaus_sidebar_project_expanded_mirror'
const SIDEBAR_SECTIONS_COLLAPSED_MIRROR_KEY = 'klaus_sidebar_sections_collapsed_mirror'
// First-paint mirror of the dragged Projects order. Same split as the two rows
// above: settings.db is authoritative and overwrites it on hydrate, the mirror
// only lets the first synchronous paint show the remembered arrangement.
const SIDEBAR_PROJECT_ORDER_MIRROR_KEY = 'klaus_sidebar_project_order_mirror'
// 删除会话确认框里「一并移除隔离工作区」勾选的记忆值（首次默认不勾，
// 用户每次勾/不勾都落盘，后续弹框沿用）。projectless 与 worktree 分开记。
const SESSION_DELETE_WIPE_PROJECTLESS_KEY = 'session.delete.wipe_projectless_workspace'
const SESSION_DELETE_REMOVE_WORKTREE_KEY = 'session.delete.remove_worktree'
let activeProjectWorkdir = (() => {
  try {
    const value = localStorage.getItem(ACTIVE_PROJECT_WORKDIR_KEY)
    // A cached managed worktree path is never a project identity; drop it and
    // let the backend's (origin-resolved) active root take over on refresh.
    if (value && isWorktreeSessionWorkdir(value)) return null
    return value && value.trim() ? value : null
  } catch {
    return null
  }
})()
let pendingNewChatWorkdir: string | null = null
// Project membership drafted for a not-yet-created chat: when the
// draft cwd is a managed worktree this carries its origin repository so the new
// session is filed under that project from the moment it is created.
let pendingNewChatProjectRoot: string | null = null
// Draft workspace for a not-yet-created chat (mirrors pendingNewChatWorkdir).
// When set, the new session is created bound to this workspace (its primary
// root becomes the cwd, the extra roots ride along).
let pendingNewChatWorkspaceId: string | null = null
const expandedProjectThreadLists = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(PROJECT_THREAD_EXPANDED_KEY) || '[]')) }
  catch { return new Set() }
})()
// Sidebar collapse state. settings.db is the authoritative store;
// localStorage is a synchronous first-paint mirror so module-scope reads render
// the remembered shape before the KV hydrate lands (same split as
// workspace.active_root in setActiveProjectWorkdir).
//
// Tri-state per project: an absent key means "never set" and renders open, an
// explicit false is the only thing that folds a group. The draft reveal
// exemption depends on telling those apart, which a collapsed-Set cannot.
let sidebarProjectExpansion = readLocalProjectExpansion()
let sidebarSectionsCollapsed = readLocalSectionsCollapsed()
// The Projects section's user-dragged order, as section keys top to bottom
// (`ws:<id>`, `friend:<id>`, or a normalized project workdir). The host owns the
// durable row (settings.db `workspace.sidebar_project_order`, written by
// `projects:reorder`); this is the copy the paint reads.
//
// A separate order row rather than the project registry's own, because the
// section holds two kinds of key the registry cannot express — a workspace
// container and a friend group are not registered roots. Only the plain-project
// subset is mirrored back into the registry order, in the same host transaction,
// so the project picker lists projects the way the sidebar shows them.
let sidebarProjectOrder: string[] = readLocalProjectOrder()
// An order that has been applied optimistically but is not confirmed durable yet.
// While it is set the section paints the drop indicator at the slot the last
// drag landed on, so a slow write never looks like the drag was ignored.
let sidebarProjectOrderPending: string[] | null = null
// Bumped on every local reorder. A refresh or cross-window push that started
// before a drop landed must not overwrite it, so each async reader compares the
// revision it captured before awaiting with the current one and yields.
let sidebarProjectOrderRevision = 0
// In-memory "show more" page counters. The counter lives in component
// state (`useState(1)`), so it restarts at the first page after a reload while
// the expanded flag itself persists (klaus_project_thread_expanded above).
const projectThreadPages = new Map<string, number>()
// Bumped on every local collapse write. A hydrate or cross-window push that
// started before a click landed must not overwrite it: the async reader compares
// the counter it captured before awaiting with the current one and yields to the
// newer local edit.
let projectExpansionRevision = 0
let sectionsCollapsedRevision = 0
let sidebarCollapseHydrate: Promise<void> | null = null
const openingProjectThreadLists = new Set()
// 正在播退场动画的项目线程列表：开合状态在点击时就已提交（见
// toggleProjectSidebarItem），这里只标记「动画还没播完」——数据面继续渲染这些
// 行，projectSidebarCloseFinished 回调只清除本标记，不再改动开合状态。
const closingProjectThreadLists = new Set()

function localSidebarMirrorValue(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function readLocalProjectExpansion(): Record<string, boolean> {
  const raw = localSidebarMirrorValue(SIDEBAR_PROJECT_EXPANDED_MIRROR_KEY)
  if (raw) {
    try { return parseProjectExpansionMap(JSON.parse(raw)) } catch { /* a corrupt mirror degrades to defaults */ }
  }
  // No legacy seeding here, unlike sections below: group expansion was never
  // persisted before this rework (it lived in a renderer-memory Set), so the
  // honest first-paint state is "nothing set" = every group open.
  return parseProjectExpansionMap(null)
}

function readLocalSectionsCollapsed(): SectionsCollapsed {
  const raw = localSidebarMirrorValue(SIDEBAR_SECTIONS_COLLAPSED_MIRROR_KEY)
  if (raw) {
    try { return parseSectionsCollapsed(JSON.parse(raw)) } catch { /* a corrupt mirror degrades to the legacy seed */ }
  }
  // One-time seed from the pre-section-fold booleans so a user who had folded
  // those two groups keeps their choice across the upgrade.
  return seedSectionsFromLegacy(
    localSidebarMirrorValue(PROJECTS_COLLAPSED_KEY),
    localSidebarMirrorValue(CONVERSATIONS_COLLAPSED_KEY),
  )
}

function readLocalProjectOrder(): string[] {
  const raw = localSidebarMirrorValue(SIDEBAR_PROJECT_ORDER_MIRROR_KEY)
  if (!raw) return []
  try { return parseStoredOrder(JSON.parse(raw)) } catch { return [] }
}
let projectRoots: string[] = []
let projectLabels: Record<string, string> = {}
// Multi-folder workspaces (workspace.groups). A workspace groups >=1 folders
// independently from standalone projects. A bound session runs in roots[0] (its
// cwd) with the remaining roots as additional writable roots. Sidebar containers key these by
// `ws:<id>` so they stay distinct from the bare project at the same primary root.
let projectWorkspaces: Array<{ id: string; name: string; roots: string[] }> = []
let projectMenuEl: HTMLElement | null = null
let projectMenuCloseHandlers: { onMouseDown: (e: MouseEvent) => void; onKeyDown: (e: KeyboardEvent) => void; onResize: () => void } | null = null
let projectPickerEl: HTMLElement | null = null
let projectPickerCloseHandlers: { onPointerDown: (e: PointerEvent) => void; onKeyDown: (e: KeyboardEvent) => void; onClose: () => void } | null = null
let projectPickerSearch = ''
// 会话已发消息（锁定）时，popover 走只读分支：只展示锁定提示，不给项目切换。
let projectPickerReadOnly = false

// 当前显示的非对话页面。null 表示在对话页。侧栏 nav 高亮和 session 高亮互斥
// 都看它：非 null 时给对应 btn-* 加 .active、所有任务行不再绘制 active；
// 为 null 时反之，由 setCurrentNonChatView() 集中维护。
let currentNonChatView: string | null = null

function delay(ms: number) {
  return new Promise((resolve: (v?: unknown) => void) => setTimeout(resolve, ms))
}

let localPersistenceWarningShown = false
function reportLocalPersistenceFailure() {
  if (localPersistenceWarningShown) return
  localPersistenceWarningShown = true
  showToast(tt('local_persistence_failed'))
}
function persistLocalValue(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    reportLocalPersistenceFailure()
    return false
  }
}
function removeLocalValue(key: string): boolean {
  try {
    localStorage.removeItem(key)
    return true
  } catch {
    reportLocalPersistenceFailure()
    return false
  }
}

// sessionId → 未发送的输入（草稿）。持久化到 localStorage，应用重启后仍在。
// 后端 SessionInfo 不带草稿字段，保持纯前端状态。
const sessionDrafts = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(windowStateKey('klaus_session_drafts')) || '{}')
    return new Map(Object.entries(stored).map(([id, draft]) => [id, normalizeComposerDraft(draft)]))
  } catch { return new Map<string, ComposerDraft>() }
})()
function persistDrafts() {
  const obj = {}
  for (const [k, v] of sessionDrafts) (obj as Record<string, unknown>)[k] = v
  persistLocalValue(windowStateKey('klaus_session_drafts'), JSON.stringify(obj))
}

// Recall is scoped to the current chat, including a separate new-chat bucket.
const sessionHistories = (() => {
  try { return restoreComposerHistory(JSON.parse(localStorage.getItem(windowStateKey('klaus_session_histories')) || '{}')) }
  catch { return restoreComposerHistory(null) }
})()
function persistSessionHistories() {
  persistLocalValue(windowStateKey('klaus_session_histories'), JSON.stringify(Object.fromEntries(sessionHistories)))
}
function addSessionHistory(sessionId: string | null, value: ComposerDraft | string, prepend = false) {
  if (appendComposerHistory(sessionHistories, sessionId, value, prepend)) persistSessionHistories()
}
let historyBrowsingIndex = -1
function resetHistoryBrowsing() { historyBrowsingIndex = -1 }
function navigateHistory(direction: -1 | 1, sessionId: string | null): boolean {
  const entries = sessionHistories.get(composerHistoryScope(sessionId)) || []
  const next = recalledHistoryIndex(historyBrowsingIndex, direction, entries.length)
  if (next === null) return false
  setComposerText(next < 0 ? '' : entries[next])
  historyBrowsingIndex = next
  autoResize()
  updateSendBtn()
  persistComposerDraft()
  try { inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length) } catch {}
  return true
}
function setDraft(sessionId: string | null, value: ComposerDraft | string) {
  if (!sessionId) return
  const draft = normalizeComposerDraft(value)
  const hasText = hasComposerDraftContent(draft)
  const had = sessionDrafts.has(sessionId)
  if (hasText) sessionDrafts.set(sessionId, draft)
  else sessionDrafts.delete(sessionId)
  persistDrafts()
  // presence 变化时才重渲染侧栏，避免每个按键都 repaint
  if (had !== hasText) renderSessionList()
}

// The welcome screen is a single global draft. It is not a session or sidebar
// item: only a send or attachment promotion creates a persisted conversation.
const WELCOME_DRAFT_KEY = windowStateKey('klaus_welcome_draft')
const WELCOME_DRAFT_SLASH_KEY = windowStateKey('klaus_welcome_draft_slash_command')
const WELCOME_DRAFT_REFERENCES_KEY = windowStateKey('klaus_welcome_draft_references')
const WELCOME_DRAFT_DOCUMENT_KEY = windowStateKey('klaus_welcome_draft_document')
function getWelcomeDraft() {
  try {
    const text = localStorage.getItem(WELCOME_DRAFT_KEY) || ''
    const slashCommand = JSON.parse(localStorage.getItem(WELCOME_DRAFT_SLASH_KEY) || 'null')
    const references = JSON.parse(localStorage.getItem(WELCOME_DRAFT_REFERENCES_KEY) || '[]')
    const document = JSON.parse(localStorage.getItem(WELCOME_DRAFT_DOCUMENT_KEY) || 'null')
    return normalizeComposerDraft({ text, slashCommand, references, document })
  } catch { return normalizeComposerDraft('') }
}
function setWelcomeDraft(value: ComposerDraft | string) {
  const draft = normalizeComposerDraft(value)
  try {
    if (hasComposerDraftContent(draft)) {
      if (draft.document) persistLocalValue(WELCOME_DRAFT_DOCUMENT_KEY, JSON.stringify(draft.document))
      else removeLocalValue(WELCOME_DRAFT_DOCUMENT_KEY)
      persistLocalValue(WELCOME_DRAFT_KEY, draft.text)
      if (draft.slashCommand) persistLocalValue(WELCOME_DRAFT_SLASH_KEY, JSON.stringify(draft.slashCommand))
      else removeLocalValue(WELCOME_DRAFT_SLASH_KEY)
      if (draft.references.length > 0) persistLocalValue(WELCOME_DRAFT_REFERENCES_KEY, JSON.stringify(draft.references))
      else removeLocalValue(WELCOME_DRAFT_REFERENCES_KEY)
    } else {
      removeLocalValue(WELCOME_DRAFT_KEY)
      removeLocalValue(WELCOME_DRAFT_SLASH_KEY)
      removeLocalValue(WELCOME_DRAFT_REFERENCES_KEY)
      removeLocalValue(WELCOME_DRAFT_DOCUMENT_KEY)
    }
  } catch { reportLocalPersistenceFailure() }
}
// composer 内容的统一持久化入口：有会话实体写 per-session 草稿，
// 虚拟新对话（currentSessionId === null）写 welcome 草稿。
function persistComposerDraft() {
  if (window.currentSessionId) setDraft(window.currentSessionId, composedInputDraft())
  else setWelcomeDraft(composedInputDraft())
  persistQueuedEditDraft(window.currentSessionId, composedInputDraft(), pendingFiles)
}
let userMenuOpen = false

function syncBusyForCurrentSession() {
  // A live goal loop occupies the session between its turns as well: the engine
  // admits the goal and starts each turn asynchronously, so stream running alone
  // leaves gaps where the composer reads idle while the goal keeps advancing.
  busy = !!currentPendingComposerSubmission() || !!(window.currentSessionId
    && (runningSessions.has(window.currentSessionId) || goalAdvancing(window.currentSessionId)))
  btnSend?.classList.toggle('busy', busy)
  // The scroll-to-latest arrow swaps its glyph to a spinner while the turn
  // runs (data-chat-timeline-scroll-generating), so a visible arrow
  // during a run reads as "live output below".
  scrollToBottomBtn?.toggleAttribute('data-generating', busy)
  updateSendBtn()
  // busy 翻转时同步 rewind/delete 按钮的可用态（前置能力提示）。
  if (typeof syncMessageActionAvailability === 'function') syncMessageActionAvailability()
}

function isSidebarSessionWorking(sessionId: string) {
  return !!sessionId && sidebarSessionWorking({
    turnRunning: runningSessions.has(sessionId),
    listedWorking: sidebarListedWorkingSessions.has(sessionId),
  })
}

function isSessionOpenInChatView(sessionId: string) {
  return !!sessionId && sessionId === window.currentSessionId && !currentNonChatView
}

function isSidebarSessionCompleteUnread(sessionId: string) {
  return !!sessionId && sidebarCompletedSessions.has(sessionId) && !isSidebarSessionWorking(sessionId)
}

function sidebarSessionStatusKind(sessionId: string) {
  if (isSidebarSessionWorking(sessionId)) return 'working'
  if (isSidebarSessionCompleteUnread(sessionId)) return 'complete'
  return 'none'
}

function persistSidebarCompletedSessions() {
  persistLocalValue('klaus_sidebar_completed_sessions', JSON.stringify([...sidebarCompletedSessions]))
}

function markSidebarSessionCompleted(sessionId: string) {
  if (!sessionId || isSessionOpenInChatView(sessionId)) return
  const before = sidebarSessionStatusKind(sessionId)
  sidebarCompletedSessions.add(sessionId)
  persistSidebarCompletedSessions()
  if (before !== sidebarSessionStatusKind(sessionId)) renderSessionList()
}

function markSidebarSessionSeen(sessionId: string, { render = true } = {}) {
  // Friend-message unread settles on the same open/seen paths as turn-completion
  // unread, so opening a session clears both ledgers at once.
  if (sharedFriendUnread().clearSession(sessionId)) {
    syncSidebarToolbar()
    syncApprovalBadge()
    if (render) renderSessionList()
  }
  if (!sessionId || !sidebarCompletedSessions.has(sessionId)) return
  const before = sidebarSessionStatusKind(sessionId)
  sidebarCompletedSessions.delete(sessionId)
  persistSidebarCompletedSessions()
  if (render && before !== sidebarSessionStatusKind(sessionId)) renderSessionList()
}

function updateSidebarWorkingSource(set: Set<string>, sessionId: string, working: boolean, { render = true } = {}) {
  if (!sessionId) return
  const before = sidebarSessionStatusKind(sessionId)
  if (working) set.add(sessionId)
  else set.delete(sessionId)
  // Either own-turn working source must arm the convergence audit so a missed
  // terminal event can settle from the authoritative session registry.
  if (working) scheduleSessionRuntimeAudit()
  if (render && before !== sidebarSessionStatusKind(sessionId)) renderSessionList()
}

function syncSidebarWorkingFromSessions(list: SessionInfo[], { reconcileRuntime = false } = {}) {
  for (const s of list || []) {
    if (!s?.id) continue
    updateSidebarWorkingSource(sidebarListedWorkingSessions, s.id, !!s.isWorking, { render: false })
    if (!reconcileRuntime) continue
    const storeRunning = getSessionStream(s.id).running
    if (s.isWorking) {
      sessionRuntimeIdleObservations.delete(s.id)
      if (!runningSessions.has(s.id)) setSessionRunning(s.id, true)
      if (!storeRunning) void reconcileSessionWorking(s.id, true)
      // A session the host reports working keeps the audit polling even when the
      // renderer never opened it (recovered turns, background continuations):
      // without a running renderer state nothing else schedules the audit, and a
      // missed lifecycle frame would leave the window idle forever.
      scheduleSessionRuntimeAudit()
      continue
    }
    if (!runningSessions.has(s.id) && !storeRunning) {
      sessionRuntimeIdleObservations.delete(s.id)
      continue
    }
    const idleObservations = (sessionRuntimeIdleObservations.get(s.id) || 0) + 1
    sessionRuntimeIdleObservations.set(s.id, idleObservations)
    if (idleObservations < SESSION_RUNTIME_IDLE_CONFIRMATIONS) continue
    sessionRuntimeIdleObservations.delete(s.id)
    stoppingSessions.delete(s.id)
    continuingSessions.delete(s.id)
    userInterruptedSessions.delete(s.id)
    if (stopEscArmedTurn?.sessionId === s.id) clearStopEscArm()
    setSessionRunning(s.id, false)
    void reconcileSessionWorking(s.id, false)
  }
}

function scheduleSessionRuntimeAudit(options: { once?: boolean } = {}) {
  if (sessionRuntimeAuditTimer || sessionRuntimeAuditInFlight) return
  // The audit is the convergence path for BOTH drift directions. A session the
  // host lists as working while the renderer sits idle (a turn recovered after a
  // restart whose lifecycle frame never arrived) has no other rescuer, so the
  // host-side working set must keep the poll alive on its own. Sub-agent
  // activity is deliberately not a working source: it lives in the Monitor
  // alone, so it can neither light a row nor strand one.
  if (!options.once && runningSessions.size === 0 && sidebarListedWorkingSessions.size === 0) return
  sessionRuntimeAuditTimer = window.setTimeout(() => {
    sessionRuntimeAuditTimer = 0
    void auditSessionRuntimeState()
  }, SESSION_RUNTIME_AUDIT_INTERVAL_MS)
}

async function auditSessionRuntimeState() {
  if (sessionRuntimeAuditInFlight) return
  sessionRuntimeAuditInFlight = true
  try {
    const titleVersionsAtRequest = new Map(sessionTitleVersions)
    const pinVersionsAtRequest = sessionPinning.snapshot()
    const liveSessions = await klausApi.session.list()
    const merged = mergeSessionsPreservingFreshTitles(sessionPinning.mergeSnapshot(liveSessions, pinVersionsAtRequest), titleVersionsAtRequest)
    sessions = mergeSidebarSessionSnapshot(sessions, merged)
    syncSidebarWorkingFromSessions(sessions, { reconcileRuntime: true })
    renderSessionList()
  } catch {
    // A failed audit is not evidence that a Turn ended. The next interval retries.
  } finally {
    sessionRuntimeAuditInFlight = false
    scheduleSessionRuntimeAudit()
  }
}

function setSessionRunning(sessionId: string, running: boolean) {
  if (!sessionId) return
  const before = sidebarSessionStatusKind(sessionId)
  if (running) {
    runningSessions.add(sessionId)
    markSidebarSessionSeen(sessionId, { render: false })
  }
  else {
    runningSessions.delete(sessionId)
    sidebarListedWorkingSessions.delete(sessionId)
    sessionRuntimeIdleObservations.delete(sessionId)
  }
  if (sessionId === window.currentSessionId) syncBusyForCurrentSession()
  if (before !== sidebarSessionStatusKind(sessionId)) renderSessionList()
  if (running) scheduleSessionRuntimeAudit()
  else if (runningSessions.size === 0 && sessionRuntimeAuditTimer) {
    window.clearTimeout(sessionRuntimeAuditTimer)
    sessionRuntimeAuditTimer = 0
  }
}

async function loadFollowUpQueueMode() {
  const generation = ++followUpQueueModeReadGeneration
  try {
    const raw = await klausApi.settings?.kv?.get(followUpModeHelper.FOLLOW_UP_QUEUE_MODE_KEY)
    if (generation !== followUpQueueModeReadGeneration) return
    followUpQueueMode = followUpModeHelper.normalizeMode(raw)
  } catch {
    if (generation !== followUpQueueModeReadGeneration) return
    followUpQueueMode = 'queue'
  }
  renderFollowUpQueue()
}

window.addEventListener('klaus-follow-up-mode-changed', (event: Event) => {
  const detail = (event as CustomEvent).detail
  followUpQueueModeReadGeneration++
  followUpQueueMode = followUpModeHelper.normalizeMode(detail?.mode)
  // The row menu's queueing entry is labelled from this mode, and the settings page
  // flips it from outside this module — so the queue has to repaint rather than keep
  // offering the switch it already made.
  renderFollowUpQueue()
})
loadFollowUpQueueMode()

// 哪些事件足以证明「这个会话正在跑一轮」。判据是：该事件只可能出现在一轮之内，
// 因而必定有 done/interrupted 与之配对来解除运行态。
// notice 不在其列 —— 它是带外的系统提示（模型降级、上下文统计失败、以及激活时
// 补报的记忆维护失败），出现在轮次之外时没有任何终止事件跟随，一旦据此点亮运行态
// 就再也灭不掉：发送键永久卡在停止态、侧栏永久转圈。真正在轮次里发出的 notice
// 也不吃亏，同轮的 requesting/stream_mode 早已点亮运行态。
function isRunActivityEvent(event: ChatEvent) {
  return [
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
    'compaction_start',
  ].includes(event?.type)
}

function isTranscriptAffectingEvent(event: ChatEvent) {
  return [
    'user_message',
    'text_delta',
    'thinking_delta',
    'tool_start',
    'tool_input_delta',
    'tool_end',
    'progress',
    'notice',
    'diff_update',
    'stream_mode',
    'message_complete',
    'context_collapse_stats',
    'api_error',
    'api_retry',
    'auth_required',
    'interrupted',
    'compaction_start',
    'compact_boundary',
    'compaction_error',
    'file',
    'mcp_auth_url',
    'permission_cancelled',
    'elicit_cancelled',
    'done',
  ].includes(event?.type)
}

// Automation definitions remain owned by the Scheduled page. The sidebar only
// needs them to resolve channel-delivery context for an open execution chat.
let cronTasks: CronTask[] = []

function isCronRunSession(id: string | null | undefined) {
  return !!id && findKnownSession(id)?.threadSource === 'automation'
}

function updateCronNavBadge() {
  // The flag goes on the BUTTON, not the dot: the rule that reveals a nav dot is
  // `.sidebar-nav-item.has-active .sidebar-nav-dot`, so toggling the class on the
  // dot itself never matched and the indicator stayed invisible. Same shape as
  // the memory entry's updateSidebarDot.
  const item = document.getElementById('btn-cron')
  if (!item) return
  const hasUnread = sessions.some((session) =>
    session.threadSource === 'automation' && isSidebarSessionCompleteUnread(session.id),
  )
  item.classList.toggle('has-active', hasUnread)
}

function findCronTaskBySessionId(sessionId: string | null | undefined) {
  const taskId = sessionId ? findKnownSession(sessionId)?.automation?.taskId : null
  return taskId ? cronTasks.find((task) => task.id === taskId) || null : null
}

function cronChannelLabel(channelId: string | undefined): string | null {
  const key = `settings_ch_${channelId}`
  const value = tt(key)
  return value === key ? (channelId ?? null) : value
}

window.refreshCronSidebar = async () => {
  await refreshCronTasksForSidebar()
  await updateSessionInList()
}
window.surfaceCronRunInSidebar = async () => {
  await refreshCronTasksForSidebar()
  await updateSessionInList()
}

async function refreshCronTasksForSidebar() {
  try {
    cronTasks = (await klausApi.settings.cron.list()) || []
  } catch (error) {
    console.warn('[Sidebar] cron load failed:', error)
    cronTasks = []
  }
  renderSessionList()
}

async function refreshCronRunsForAllTasks() {
  await updateSessionInList()
}

// --- DOM refs ---
installBrowserTabFaviconFallback(document)
let messagesEl = document.getElementById('messages') as HTMLElement
// Scroll-to-bottom 浮标：消息区离开底部时亮起，点击吸回最新。
const scrollToBottomBtn = document.getElementById('scroll-to-bottom') as HTMLButtonElement | null
// A ChatSurface bundles everything one conversation view needs so the main
// transcript and the side-chat panel can render and stream independently: its
// target container, a session-id getter, and (attached by the factory) its own
// thinking / turn-activity indicators. Stream state is threaded per surface by
// the streaming functions. mainSurface wraps the main #messages transcript.
interface ChatSurface {
  messagesEl: HTMLElement
  getSessionId: () => string | null
  stream: { buffer: string; currentMsgGroup: HTMLElement | null; paintSuspended: boolean; paintRaf: number }
  thinkingUI?: ReturnType<typeof createThinkingUI>
  turnActivityUI?: ReturnType<typeof createTurnActivityUI>
}

function createChatSurface({ messagesEl, getSessionId }: { messagesEl: HTMLElement; getSessionId: () => string | null }): Required<ChatSurface> {
  const surface: ChatSurface = {
    messagesEl,
    getSessionId,
    // Per-surface streaming state so the main and side transcripts can stream
    // concurrently without clobbering each other's in-flight bubble.
    stream: { buffer: '', currentMsgGroup: null, paintSuspended: false, paintRaf: 0 },
  }
  surface.thinkingUI = createThinkingUI(surface)
  surface.turnActivityUI = createTurnActivityUI(surface)
  return surface as Required<ChatSurface>
}
// Scroll a surface's transcript to the bottom. 两个 surface 各走自己的 sticker：
// side 的滚动容器是 #side-messages，不是 surface.messagesEl（那是容器里的一个
// .side-messages-slot，根本不滚）——以前这里写 el.scrollTop = el.scrollHeight，
// 写在 slot 上，所以 side 面板的吸底从来没生效过。
function surfaceScrollToBottom(surface = activeRenderSurface, options: { force?: boolean } = {}) {
  if (surface === mainSurface) { scrollToBottom(options); return }
  sideSticker?.scrollToBottom(options)
}
const mainSurface = createChatSurface({ messagesEl, getSessionId: () => window.currentSessionId })
// Legacy aliases: the vast majority of the codebase calls thinkingUI.* and
// turnActivityUI.* and messagesEl directly for the main transcript. They are
// `let` so withSurface() can point them at another surface for the duration of
// a synchronous render/event dispatch, then restore them.
let thinkingUI = mainSurface.thinkingUI
let turnActivityUI = mainSurface.turnActivityUI
// The surface synchronous render/stream code targets by default. withSurface()
// repoints it (and the render globals) so no-arg calls follow the active
// surface, and async schedulers capture it at call time.
let activeRenderSurface = mainSurface
// Session id -> ChatSurface for live event dispatch. An active side task maps to
// the side surface here while its tab is open; the main session resolves to
// mainSurface implicitly in the event handler.
const surfacesBySession = new Map()
let sideSurfaceSessionId: string | null = null
/**
 * The side composer's own queue island.
 *
 * A side chat is a separate session with its own queue, so it gets its own mount
 * rather than sharing the main one — a side row must never act on the main
 * conversation's queue. Declared here (not beside the mount) because
 * `initSideComposer` assigns it during boot while `renderFollowUpQueue` reads it
 * later; both happen after module evaluation, but a `let` up here cannot be caught
 * in a TDZ by an early repaint either way.
 */
let sideFollowUpQueueApi: FollowUpQueueApi | null = null
// Each side task gets its own ChatSurface (own messagesEl slot inside
// #side-messages, own indicator instances, own stream state) that lives for as
// long as the tab exists. Registrations in surfacesBySession are PERMANENT
// while the tab is open, so live engine events always paint into the correct
// slot regardless of which tab is currently visible — switching tabs is a
// zero-cost show/hide, streams never break, no cache/re-fetch dance.
const sideSurfaces = new Map()  // sideId -> ChatSurface
function sideMessagesContainer() { return document.getElementById('side-messages') }
function getOrCreateSideSurface(sideId: string) {
  if (!sideId) return null
  const existing = sideSurfaces.get(sideId)
  if (existing) return existing
  const container = sideMessagesContainer()
  if (!container) return null
  const slot = document.createElement('div')
  slot.className = 'side-messages-slot'
  slot.dataset.sideid = sideId
  slot.hidden = true
  container.appendChild(slot)
  const surface = createChatSurface({ messagesEl: slot, getSessionId: () => sideId })
  sideSurfaces.set(sideId, surface)
  surfacesBySession.set(sideId, surface)
  return surface
}
// side-tasks.js calls this when a side tab becomes active: bring the target
// side task's slot into view (all other slots stay in the DOM, just hidden).
// slot 挂 React transcript（store 驱动：历史拉取/live 事件都在 store 里），
// 切 tab 是纯 show/hide，流不断、无重拉。
window.klausSideSurfaceActivate = async (sideId) => {
  if (!sideId) return
  prepareEphemeralSessionStream(sideId)
  const surface = getOrCreateSideSurface(sideId)
  if (!surface) return
  sideSurfaceSessionId = sideId
  sideVoiceChatUi?.refresh()
  sideWindowsSandboxBanner?.refresh()
  sideModelApi?.setDisabled(false)
  ;(window as any).klausSideComposerBind?.(sideId)
  ;(window as any).klausUpdateSideSendButton?.()
  void refreshSideComposerModel()
  // The side composer is reused across side tabs, so its queue has to follow the tab
  // that just became active. Paint from cache immediately (a flash of the previous
  // side chat's queue would be worse than an empty bar), then pull the host's
  // snapshot — this conversation's queue may never have been read in this window.
  renderSideFollowUpQueue()
  void refreshClientQueue(sideId, { reset: true })

  // Show target slot, hide siblings. Doing this before await so the UI
  // reflects the tab click immediately even if history hasn't loaded yet.
  const container = sideMessagesContainer()
  if (container) {
    for (const child of container.children) {
      if (child.classList?.contains('side-messages-slot')) {
        (child as HTMLElement).hidden = (child as HTMLElement).dataset.sideid !== sideId
      }
    }
  }

  // React root 接管 slot（首次挂载即自拉历史；重复调用同容器换 props 幂等）。
  mountReactTranscript(sideId, surface.messagesEl, { scroll: 'simple' })
  // This side tab is the one on screen now, and every side tab shares one cloned
  // composer slot, so the questions belong to whichever tab just activated. Same
  // rule as the main transcript: a surface starting to show a session, never a
  // store change, is what puts a deferred question back.
  reopenAsyncQuestionsForSession(sideId)
  surfaceScrollToBottom(surface)
}
// Remove a specific side task's slot + registration — called when its tab is
// closed. Frees the DOM and stops future event dispatch for that id.
window.klausSideSurfaceRemove = (sideId) => {
  ;(window as any).klausSideComposerDiscard?.(sideId)
  if (!sideId) return
  const surface = sideSurfaces.get(sideId)
  if (surface) {
    unmountReactTranscript(surface.messagesEl)
    resetStreamState(surface)
    surface.messagesEl.remove()
    sideSurfaces.delete(sideId)
  }
  surfacesBySession.delete(sideId)
  if (sideSurfaceSessionId === sideId) {
    sideSurfaceSessionId = null
    sideVoiceChatUi?.refresh()
    ;(window as any).klausUpdateSideSendButton?.()
    // Nothing is bound to the side composer now, so its queue must empty rather than
    // keep offering the closed chat's rows. The host drops the durable rows too.
    renderSideFollowUpQueue()
  }
}
// Cross-family navigation — hide all slots and drop the active pointer, but
// KEEP surfaces + registrations alive so switching back to a main session
// with existing side tasks finds their slots intact (with all their in-flight
// stream state). Only klausSideSurfaceRemove destroys a slot.
window.klausSideSurfaceClear = () => {
  for (const surface of sideSurfaces.values()) surface.messagesEl.hidden = true
  sideSurfaceSessionId = null
  sideVoiceChatUi?.refresh()
  ;(window as any).klausSideComposerBind?.(null)
  ;(window as any).klausUpdateSideSendButton?.()
  // Navigated away from the side family entirely: the queue bar has no conversation
  // to describe, so it empties instead of showing a hidden tab's messages.
  renderSideFollowUpQueue()
}
window.klausSideSurfaceSessionId = () => sideSurfaceSessionId
async function resolveEditorMentionReference(entry: MentionEntry, sessionId: string | null): Promise<Omit<ComposerReferenceToken, 'range'> | null> {
    if (entry.kind === 'plugin') return resourceReference('plugin', entry.name, entry.path || entry.name)
    if (entry.kind === 'browser-tab' && entry.browserTab) return browserTabReference(entry.browserTab)
    if (entry.kind === 'friend' && entry.friendId) return { kind: 'friend', name: entry.name, value: friendMentionValue(entry.friendId), id: entry.friendId }
    if (entry.kind === 'device' && entry.deviceId) return { kind: 'device', name: entry.name, value: `@device-${entry.deviceId}`, id: entry.deviceId }
    if (entry.kind === 'conversation' && entry.conversationId) return {
      kind: 'conversation', name: entry.name, id: entry.conversationId,
      value: `[${entry.name.replace(/([\\\[\]])/g, '\\$1')}](klaus:conversation/${encodeURIComponent(entry.conversationId)})`,
    }
    if (entry.kind) return null
    if (!sessionId) throw new Error(tt('composer_load_failed'))
    const result = await klausApi.session.getResolvedWorkdir(sessionId)
    if (!result?.workdir || result.workdir.includes('://')) throw new Error(tt('composer_load_failed'))
    const raw = entry.path || entry.rel
    const path = /^(?:\/|[A-Za-z]:[\\/])/.test(raw) ? raw : `${result.workdir.replace(/[/\\]+$/, '')}/${entry.rel.replace(/^\.\//, '')}`
    return workspaceReference({ ...entry, path })
}

// Build the side-chat composer as a clone of the main #input-wrapper so it is
// visually and behaviourally identical, re-id'd to #side-* and bound to the
// active side task. Attachments (+) and voice (mic) are wired to side-scoped
// state / the shared recorder; discovery is bound to the active side draft.
function initSideComposer() {
  const host = document.getElementById('side-composer-host')
  const template = document.getElementById('input-wrapper')
  if (!host || !template || host.dataset.ready === '1') return
  const clone = template.cloneNode(true) as HTMLElement
  clone.id = 'side-input-wrapper'
  clone.querySelectorAll<HTMLElement>('[id]').forEach((el) => { el.id = `side-${el.id}` })
  // A pending main question must never be copied into a side task's composer.
  clone.querySelector('#side-question-composer-slot')?.replaceChildren()
  clone.querySelector('[data-windows-sandbox-host]')?.remove()
  // The source switch follows the main session; the side composer has its own
  // model picker and must not clone an unmounted main-session control.
  clone.querySelector('#side-auth-mode-pill-host')?.remove()
  // Voice controls belong to the main React root; a DOM clone has no controller.
  clone.querySelectorAll('.voice-chat-composer-controls, .voice-chat-stage, .kls-select--friend-intent').forEach(element => element.remove())
  delete clone.dataset.voiceChat
  const modelRoot = clone.querySelector('#side-main-model-select')
  if (modelRoot) modelRoot.id = 'side-model-select' // reuse existing model-menu styling
  clone.querySelectorAll('.streaming-dots, .msg, [data-uuid]').forEach((n) => n.remove())
  const sideInput = clone.querySelector<HTMLTextAreaElement>('#side-input')
  if (sideInput) {
    sideInput.removeAttribute('data-klaus-text-control')
    sideInput.replaceChildren()
    sideInput.value = ''
    sideInput.style.height = ''
  }
  ;['#side-composer-context-row', '#side-ctx-usage-chip']
    .forEach(sel => { const el = clone.querySelector<HTMLElement>(sel); if (el) el.style.display = 'none' })
  // 一起拆掉 side-action-dots-host：回合胶囊只服务主会话（它读的是 stream store 的
  // currentSessionId），克隆出来的那个挂点永远没人往里面挂 React root。而且克隆
  // 发生在胶囊已经渲染时，还会把当时那一帧整个拉过来，在 side 面板上留下一份
  // 永不更新的僵死副本。
  // Composer status rows are main-session state too, and cloning them could
  // preserve stale queue, Spec, or Goal snapshots in the side composer.
  removeSideWorkflowControls(clone)
  // The side queue KEEPS its mount point — a side chat has its own queue and needs
  // somewhere to draw it — but its contents are dropped. The clone copied whatever
  // the main island had rendered into its container at that instant, including the
  // React root's DOM; leaving it would paint a frozen copy of the MAIN queue that
  // never updates. Emptied here so the side mount below renders it fresh.
  // The clone also inherited the main queue's `hidden`, but the mount further down in
  // this same synchronous tick renders the side queue fresh and sets `hidden` itself,
  // so no frame can paint the inherited state in between.
  clone.querySelector<HTMLElement>('#side-follow-up-queue')?.replaceChildren()
  host.appendChild(clone)
  host.dataset.ready = '1'
  sideWindowsSandboxBanner = mountWindowsSandboxBanner(clone, () => windowsSandboxContext(sideSurfaceSessionId ? sessionWorkdir(sideSurfaceSessionId) : null, sideSurfaceSessionId))

  // side 面板的粘底跟随：与主会话同一份实现（方向判定 + 内容观察器 + 浮标）。
  // 滚动容器是 #side-messages；浮标 #side-scroll-to-bottom 就是刚才克隆主 composer
  // 时连带重命名出来的那个——它一直有 DOM、有样式，但从来没有任何代码点亮过它。
  sideSticker = createBottomSticker({
    scrollEl: sideMessagesContainer(),
    floatBtn: clone.querySelector<HTMLElement>('#side-scroll-to-bottom'),
  })
  // Same proxy scrollbar as the main column, pinned to the side panel's edge.
  mountOuterScrollbar({
    scrollEl: sideMessagesContainer(),
    region: document.getElementById('side-chat-panel'),
    onUserScrollIntent: (direction) => {
      if (direction === 'up') sideSticker?.noteUpwardScrollGesture()
      else sideSticker?.noteUserScrollIntent()
    },
  })

  const sideSend = clone.querySelector<HTMLButtonElement>('#side-send')
  let sideFriendSending = false
  let sideFriendAttempt: { key: string; id: string } | null = null
  const persistedSideFriendAttempts = friendDispatchAttempts(localStorage, windowStateKey('side'))
  const sideFriendContexts = new Map<string, FriendComposeContext>()
  const sideFriendIntentHost = document.createElement('div')
  sideFriendIntentHost.id = 'side-friend-intent-select'
  sideFriendIntentHost.className = 'kls-select kls-select--flat kls-select--friend-intent'
  sideFriendIntentHost.hidden = true
  sideSend?.parentElement?.insertBefore(sideFriendIntentHost, sideSend)
  const sideFriendIntentApi = mountFriendIntentSelect(sideFriendIntentHost, {
    onIntentChange: (intent) => {
      if (sideSurfaceSessionId) sideFriendContexts.set(sideSurfaceSessionId, { intent })
      updateSideSendButton()
    },
  })

  sideSend?.removeAttribute('title')
  sideSend?.removeAttribute('data-i18n-title')
  const modelSel = clone.querySelector<HTMLElement>('#side-model-select')
  const sidePreviews = clone.querySelector<HTMLElement>('#side-previews')
  const sideFileInput = clone.querySelector<HTMLInputElement>('#side-file-input')
  const sidePlusBtn = clone.querySelector<HTMLButtonElement>('#side-composer-plus-btn')
  const sideVoiceBtn = clone.querySelector<HTMLElement>('#side-voice-input-btn')
  mountSideComposerVoice = () => {
    if (!voiceChatUi || sideVoiceChatUi || !sideSend || !sideInput) return
    const panel = document.getElementById('artifacts-panel')!
    sideVoiceChatUi = mountVoiceChat({
      wrapper: clone, row: clone.querySelector('.input-row')!, content: document.getElementById('side-chat-panel')!,
      visibilityRoot: panel, sendButton: sideSend, input: sideInput,
      transport: klausApi.voice.chat,
      currentSession: () => sideSurfaceSessionId,
      ensureSession: async () => sideSurfaceSessionId,
      hasDraft: () => !!sideComposedInputText().trim() || sidePendingFiles.length > 0,
      canStart: () => !!sideSurfaceSessionId && !window.isSessionRunning?.(sideSurfaceSessionId)
        && !stoppingSessions.has(sideSurfaceSessionId) && !sessionContinueMode(sideSurfaceSessionId)
        && !sideInput.disabled && sideInput.getAttribute('contenteditable') !== 'false'
        && (sideVoiceBtn?.dataset.voiceState || 'idle') === 'idle',
      commandActive: () => clone.contains(document.activeElement),
      inChat: () => !!sideSurfaceSessionId && panel.dataset.mode === 'side-chat' && !panel.classList.contains('collapsed'),
      feedback: () => { void submitDebugReport('') },
      systemSettings: () => klausApi.systemPermissions.openSettings('microphone'),
      present: (eligible, sessionId, notice) => klausApi.voice.chat.present({ eligible, sessionId, ...(notice ? { notice } : {}) }),
    }, voiceChatUi.controller)
  }
  mountSideComposerVoice()
  let sideDraftScope: string | null = null
  let pendingSideDraft: { id: string; parentId: string | null } | null = null
  let sideBindingRevision = 0
  let sideHistoryBrowsingIndex = -1
  if (modelSel) {
    sideModelApi = mountModelSelect(modelSel, {
      onEmptyClick: () => { void openCurrentModelSettings(window.klausSideSurfaceSessionId?.()) },
      getSessionId: () => window.klausSideSurfaceSessionId?.(),
      onFastModeChange: invalidateComposerPreferenceReads,
    })
  }
  const permSel = clone.querySelector<HTMLElement>('#side-permission-select')
  if (permSel) sidePermissionApi = mountPermissionSelect(permSel, () => sideSurfaceSessionId)
  if (composerPreferencesSnapshot) applyComposerPreferences(composerPreferencesSnapshot)
  void refreshSideComposerModel()

  // Side attachments: a live array for the active side task, rendered into
  // #side-previews and folded into the outgoing payload. Rendering goes through
  // the same mountPreviews component as the main composer — one renderer, so the
  // attachment row cannot drift between the two surfaces. Uploads reuse the same
  // chat.uploadFile IPC as the main composer, so behaviour matches.
  let sidePendingFiles: PendingFileEntry[] = []
  let sideComposerControl: ComposerTextControl | null = null
  let sideReferenceTokens: ComposerReferenceToken[] = []
  let sideSelectedSlashCommand: SlashCommandInfo | null = null
  let sideSelectedSlashCommandRange: { start: number; end: number } | null = null
  let sideDiscovery: ReturnType<typeof createEditorDiscovery> | null = null
  if (sideInput) sideComposerControl = installContenteditableTextControl(sideInput as unknown as HTMLElement, (value) => [
    ...sideInlineQuoteEntries(value).map((entry) => ({
      start: entry.range!.start,
      end: entry.range!.end,
      value: value.slice(entry.range!.start, entry.range!.end),
      element: createComposerInlineQuote(entry, removeSideInlineQuote),
      data: inlineQuoteDocumentData(entry),
    })),
    ...normalizeComposerReferences(value, sideReferenceTokens).map((reference) => ({
      start: reference.range.start,
      end: reference.range.end,
      value: reference.value,
      element: createComposerReferenceElement(reference),
      data: reference,
    })),
    ...commandDocumentTokens(value, sideSelectedSlashCommand, sideSelectedSlashCommandRange),
  ], { onLongPaste: text => {
    if (!isLargePastedText(text)) return false
    void attachSidePastedText(text)
    return true
  }, restoreTokens: (value, tokens) => {
    sidePendingFiles = restoreInlineDocumentFiles(sidePendingFiles, tokens)
    sideReferenceTokens = referencesFromEditor(value, tokens)
    const command = tokens.find(token => (token.data as { kind?: string })?.kind === 'command')
    sideSelectedSlashCommand = (command?.data as { command?: SlashCommandInfo })?.command || null
    sideSelectedSlashCommandRange = command ? { start: command.start, end: command.end } : null
  } })
  function sideSetComposerDraft(value: unknown) {
    sideDiscovery?.hide()
    sideHistoryBrowsingIndex = -1
    sideSelectedSlashCommand = null
    sideSelectedSlashCommandRange = null
    sideReferenceTokens = []
    const draft = migrateSkillDraft(normalizeComposerDraft(value))
    if (draft.document && sideComposerControl?.restoreDocument(draft.document)) return
    const selected = selectedSlashCommandFromDraft(draft)
    sideSelectedSlashCommand = selected?.command || null
    sideSelectedSlashCommandRange = selected?.range || null
    sideReferenceTokens = normalizeComposerReferences(draft.text, [...draft.references, ...workspaceReferencesIn(draft.text)])
    if (sideComposerControl) sideComposerControl.restoreText(draft.text)
    else if (sideInput) sideInput.value = draft.text
  }
  function sideComposedInputDraft(): ComposerDraft {
    return sideComposerControl ? composerDraftFromControl(sideComposerControl)
      : createComposerDraft(sideInput?.value || '', sideSelectedSlashCommand, sideSelectedSlashCommandRange, sideReferenceTokens)
  }
  function sideDiscoveryContext(): EditorDiscoveryContext | null {
    if (!sideDraftScope) return null
    const pending = pendingSideDraft?.id === sideDraftScope ? pendingSideDraft : null
    if (!pending && sideDraftScope.startsWith('pending-side-')) return null
    return { owner: `${sideDraftScope}:${sideBindingRevision}`, sessionId: pending ? pending.parentId : sideDraftScope }
  }
  function sideInsertReference(reference: Omit<ComposerReferenceToken, 'range'>, range: { start: number; end: number }) {
    if (!sideInput || !sideComposerControl) return
    const value = sideInput.value
    const inserted = replaceComposerReferenceRange(value, range.start, range.end, '', reference)
    sideReferenceTokens = normalizeComposerReferences(inserted.text, [
      ...syncComposerReferences(value, inserted.text, sideReferenceTokens), inserted.reference,
    ])
    const replacement = inserted.text.slice(range.start, inserted.text.length - value.length + range.end)
    sideComposerControl.replaceRange(range.start, range.end, replacement, 'insertText')
    focusComposerInput(sideInput, inserted.caret)
  }
  async function sideCompact(instructions: string, range?: { start: number; end: number }) {
    const sessionId = sideSurfaceSessionId
    const binding = sideBindingRevision
    const value = sideInput?.value || ''
    if (!sessionId || !sideInput || !sideComposerControl) return
    if (range && !manualCompactQueryAllowed(value, range, sidePendingFiles.length, sessionId)) return
    await manualCompactController.run(sessionId, instructions, () => {
      if (sideSurfaceSessionId !== sessionId || sideBindingRevision !== binding || sideInput.value !== value) return
      sideComposerControl.replaceRange(range?.start ?? 0, range?.end ?? value.length, '', 'insertReplacementText')
      sideDiscovery?.hide()
    })
    if (sideSurfaceSessionId === sessionId && sideBindingRevision === binding) sideInput.focus()
  }

  function sideInsertCommand(command: SlashCommandInfo, range: { start: number; end: number }) {
    if (!sideInput || !sideComposerControl) return
    if (isManualCompactCommand(command)) { void sideCompact('', range); return }
    if (isSkillCommand(command)) { sideInsertReference(skillReference(command, slashCommandDisplayName(command)), range); return }
    let start = range.start, end = range.end
    const previous = sideSelectedSlashCommandRange
    if (sideSelectedSlashCommand && isValidSlashCommandRange(previous, sideInput.value)) {
      const before = sideInput.value, after = removeTextRangeWithWhitespace(before, previous).value
      let from = 0, to = before.length, nextEnd = after.length
      while (from < to && from < nextEnd && before[from] === after[from]) from++
      while (to > from && nextEnd > from && before[to - 1] === after[nextEnd - 1]) { to--; nextEnd-- }
      sideComposerControl.replaceRange(from, to, '', 'deleteContentBackward')
      start = shiftPositionAfterRemoval(start, { start: from, end: to })
      end = shiftPositionAfterRemoval(end, { start: from, end: to })
    }
    const placeholder = slashCommandPlaceholder(command)
    const trailing = !sideInput.value.slice(end) || !/^\s/.test(sideInput.value.slice(end)) ? ' ' : ''
    sideSelectedSlashCommand = command
    sideSelectedSlashCommandRange = { start, end: start + placeholder.length }
    sideComposerControl.replaceRange(start, end, placeholder + trailing, 'insertText')
    focusComposerInput(sideInput, start + placeholder.length + trailing.length)
  }
  async function sideMentionReference(entry: MentionEntry, context: EditorDiscoveryContext): Promise<Omit<ComposerReferenceToken, 'range'> | null> {
    const reference = await resolveEditorMentionReference(entry, context.sessionId)
    if (reference && (reference.kind === 'file' || reference.kind === 'folder') && pendingSideDraft?.id === sideDraftScope) {
      return workspaceReference({ ...entry, path: reference.path || entry.path, rel: reference.path || entry.path })
    }
    return reference
  }

  if (sideInput && sideComposerControl) {
    const menu = document.createElement('div')
    menu.id = 'side-slash-menu'
    menu.className = 'slash-menu hidden'
    // Viewport coordinates must stay outside clipped composer ancestors.
    document.body.appendChild(menu)
    const api = mountSlashMenu(menu, composerDiscoveryMenuActions({
      onMentionMenuEmpty: () => sideDiscovery?.empty(),
      onSelectCommand: command => sideDiscovery?.selectCommand(command),
      onSelectMention: (entry, intent) => { void sideDiscovery?.selectMention(entry, intent) },
    }, () => sideSurfaceSessionId), { wrapper: clone, input: clone.querySelector<HTMLElement>('#side-input-area') || sideInput as unknown as HTMLElement })
    if (api) sideDiscovery = createEditorDiscovery({ input: sideInput, control: sideComposerControl, menu: api,
      context: sideDiscoveryContext,
      load: async context => {
        if (sideSurfaceSessionId && !ctxPanel.sessions.has(sideSurfaceSessionId)) void fetchContextStats(sideSurfaceSessionId)
        const commands = withManualCompactCommand(await loadScopedSlashCommands(context.sessionId, context.root))
        return commands.filter(command => !isManualCompactCommand(command) || manualCompactQueryAllowed(sideInput.value, sideComposerControl.queryAtCaret(), sidePendingFiles.length, sideSurfaceSessionId))
      },
      matches: slashCommandMatchesSearch, command: sideInsertCommand, reference: sideMentionReference, insert: sideInsertReference,
      failure: () => showToast(tt('composer_load_failed')) })
    sideInput.addEventListener('keydown', event => sideDiscovery?.keydown(event), true)
    sideInput.addEventListener('select', () => { void sideDiscovery?.refresh() })
    sideInput.addEventListener('focus', () => { void sideDiscovery?.refresh() })
    sideInput.addEventListener('blur', () => sideDiscovery?.hide())
    const panel = document.getElementById('artifacts-panel')
    if (panel) new MutationObserver(() => {
      if (panel.classList.contains('collapsed') || panel.dataset.mode !== 'side-chat') sideDiscovery?.hide()
    }).observe(panel, { attributes: true, attributeFilter: ['class', 'data-mode'] })
    window.addEventListener('klaus:skills-changed', () => { sideDiscovery?.hide(); void sideDiscovery?.refresh() })
    document.addEventListener('pointerdown', event => {
      if (!menu.contains(event.target as Node) && !sideInput.contains(event.target as Node)) sideDiscovery?.hide(true)
    }, true)
  }
  if (sidePreviews) sidePreviews.innerHTML = ''
  const sideAttachmentHistory = new AttachmentHistory()
  if (sideInput) installAttachmentHistory(sideInput, sidePreviews, sideAttachmentHistory)
  const sidePreviewsApi = mountPreviews(sidePreviews, {
    onRemove: (entry) => {
      const owner = sideSurfaceSessionId, binding = sideBindingRevision, generation = sideComposerControl?.historyGeneration
      sideAttachmentHistory.remove(entry, {
        files: () => sidePendingFiles, setFiles: files => { sidePendingFiles = files },
        current: () => sideSurfaceSessionId === owner && sideBindingRevision === binding && sideInput?.isConnected === true
          && sideComposerControl?.historyGeneration === generation,
        changed: () => { sideRenderPreviews(); updateSideSendButton(); sideInput?.focus() },
        finalize: file => {
          if (sideAttachmentRetained(file)) return
          disposeAttachmentObjectUrl(file)
          if (file.kind === 'pasted-text' && file.uploadPath) void klausApi.chat.pastedTextRemove(file.uploadPath).catch(() => undefined)
        },
      })
      // User changed their mind: a parked submit must not fire on its own later.
      sidePendingSendAfterUpload = null
      sideSend?.classList.remove('awaiting-upload')
      sideRenderPreviews()
    },
    onOpenImage: (src) => openImagePreview(src),
    onOpenFile: (entry) => openFileAttachmentPreview(entry, sideSurfaceSessionId || pendingSideDraft?.parentId || window.currentSessionId),
    onRestorePasted: (entry) => { void restoreSidePastedTextToComposer(entry) },
    formatMeta: (entry) => formatPreviewMeta(entry),
  })
  function sideInlineQuoteEntries(value: string = sideInput?.value || '') {
    return inlineQuoteEntries(sidePendingFiles, value)
  }
  function sideComposedInputText() {
    if (sideComposerControl) {
      const serialized = sideComposerControl.serializeSubmission()
      serialized.tokens.filter(token => (token.data as { kind?: string })?.kind === 'selected-text').forEach((token, index) => {
        const entry = sidePendingFiles.find(file => file.quoteId === (token.data as PendingFileEntry).quoteId)
        if (entry) { entry.requestOffset = token.start; entry.displayOrder = index }
      })
      return serialized.text
    }
    const value = sideInput?.value || ''
    return composeInlineQuoteSubmission(value, sideInlineQuoteEntries(value)).text
  }
  function sideRenderPreviews() {
    sidePreviewsApi?.render(sidePendingFiles)
    if (sideSurfaceSessionId === sideDraftScope) persistQueuedEditDraft(sideSurfaceSessionId, sideComposedInputDraft(), sidePendingFiles)
  }
  function removeSideInlineQuote(entry: PendingFileEntry) {
    if (!sideInput) return
    const current = sidePendingFiles.find(candidate => candidate.quoteId === entry.quoteId) || entry
    if (!current.range) return
    const { start, end } = current.range
    sideComposerControl?.replaceRange(start, end, '', 'deleteContentBackward')
    focusComposerInput(sideInput, start)
    sideRenderPreviews()
  }

  // A side-task selection uses the same inline text pill and persistent quote
  // envelope as main chat: one shared composer behavior across both surfaces.
  function sideAddSelection(text: string, requestOffset?: number, metadata: Partial<PendingFileEntry> = {}) {
    if (!sideInput) return
    const normalized = String(text || '').replace(/\r\n?/g, '\n')
    if (!normalized.trim()) return
    const entry = buildSelectedTextEntry(normalized)
    if (metadata.quoteId) entry.quoteId = metadata.quoteId
    if (metadata.previewText) entry.previewText = metadata.previewText
    if (metadata.specAnnotation) entry.specAnnotation = { ...metadata.specAnnotation }
    const start = Number.isInteger(requestOffset)
      ? composerOffsetFromDisplayOffset(Number(requestOffset), sideInput.value.length, sideSelectedSlashCommandRange, sideSelectedSlashCommand ? `/${sideSelectedSlashCommand.name}`.length : 0)
      : sideInput.selectionStart ?? sideInput.value.length
    const end = Number.isInteger(requestOffset) ? start : sideInput.selectionEnd ?? start
    const inlineEntries = sideInlineQuoteEntries()
    const expanded = expandSelectionAcrossInlineQuotes(start, end, [...inlineEntries, ...normalizeComposerReferences(sideInput.value, [])])
    if (!composerTokenDataWithinDepth(entry)) {
      // Malformed retained metadata falls back before any tray or range mutation.
      sideComposerControl?.replaceRange(expanded.start, expanded.end, normalized, 'insertText', 'literal')
      focusComposerInput(sideInput, expanded.start + normalized.length)
      sideRenderPreviews()
      sideAutoResize()
      return
    }
    const placeholder = inlineQuotePlaceholder()
    const inserted = insertInlineQuotePlaceholder(sideInput.value, expanded.start, expanded.end, placeholder)
    const synced = replaceInlineTokenRange(expanded.start, expanded.end, placeholder.length, inlineEntries)
    if (synced.removed.length > 0) {
      sidePendingFiles = sidePendingFiles.filter(candidate => !synced.removed.includes(candidate))
    }
    entry.composerOffset = expanded.start
    entry.range = inserted.range
    sidePendingFiles.push(entry)
    sideComposerControl?.replaceRange(expanded.start, expanded.end, placeholder, 'insertText')
    try { sideInput.setSelectionRange(inserted.caret, inserted.caret) } catch {}
    focusComposerInput(sideInput, inserted.caret)
    sideRenderPreviews()
    sideAutoResize()
  }
  window.klausSideComposerAddSelection = text => sideAddSelection(text)
  function sideAttachmentRetained(entry: PendingFileEntry) {
    return sidePendingFiles.includes(entry) || sideAttachmentHistory.retains(entry)
      || [...sideDrafts].some(([scope, draft]) => scope !== sideDraftScope && draft.files.includes(entry))
  }
  function removeSideAttachment(entry: PendingFileEntry, cancelPaste = false) {
    for (const draft of sideDrafts.values()) {
      if (!draft.files.includes(entry)) continue
      draft.files = draft.files.filter(candidate => candidate !== entry)
      if (cancelPaste) draft.deferred = null
    }
    if (sidePendingFiles.includes(entry)) {
      sidePendingFiles = sidePendingFiles.filter(candidate => candidate !== entry)
      if (cancelPaste) { sidePendingSendAfterUpload = null; sideSend?.classList.remove('awaiting-upload') }
    }
    sideAttachmentHistory.discard(entry)
  }
  async function sideUpload(entry: PendingFileEntry) {
    try {
      const result = await uploadAttachment(entry)
      entry.uploadPath = result.path
      entry.file = { name: result.name || entry.file.name, type: result.type || entry.file.type || '', size: result.size ?? entry.file.size ?? 0 }
      entry.lineCount = result.lineCount ?? null
    } catch {
      const active = sidePendingFiles.includes(entry)
      removeSideAttachment(entry)
      disposeAttachmentObjectUrl(entry)
      entry.uploading = false
      if (active) { showToast(tt('upload_failed_short') + entry.file.name); sideRenderPreviews(); releaseSideDeferredSend() }
      return
    }
    entry.uploading = false
    if (sidePendingFiles.includes(entry)) { sideRenderPreviews(); releaseSideDeferredSend() }
  }
  function addSideFiles(files: FileList | File[]) {
    for (const f of files) {
      if (rejectOversizedAttachment(f.name, f.size, f.type)) continue
      const entry: PendingFileEntry = { file: f, objectUrl: null, uploadPath: null, uploading: true }
      if (isInlineImage(f.name, f.type)) entry.objectUrl = URL.createObjectURL(f)
      sidePendingFiles.push(entry)
      sideUpload(entry)
    }
    sideRenderPreviews()
  }
  function addSideFilePaths(paths: string[]) {
    for (const path of new Set(paths.filter(Boolean))) {
      const entry: PendingFileEntry = { file: { name: basenameFromPath(path), type: '', size: 0 },
        objectUrl: null, uploadPath: null, uploading: true, sourcePath: path }
      sidePendingFiles.push(entry)
      void sideUpload(entry)
    }
    sideRenderPreviews()
    updateSideSendButton()
  }
  async function attachSidePastedText(text: string) {
    const pending = pendingPastedTextEntry(text)
    pending.previewText = pastedTextPreview(text)
    sidePendingFiles.push(pending)
    sideRenderPreviews()
    updateSideSendButton()
    const result = await settlePastedTextAttachment(pending, text, {
      create: value => createPastedTextAttachment(value, () => sidePendingFiles.includes(pending)), retained: () => sideAttachmentRetained(pending),
      removeStored: path => klausApi.chat.pastedTextRemove(path),
    })
    const active = sidePendingFiles.includes(pending)
    if (result === 'failed') removeSideAttachment(pending, true)
    if (active) { sideRenderPreviews(); updateSideSendButton(); if (result === 'ready') releaseSideDeferredSend() }
  }
  async function handleSideComposerPaste(e: ClipboardEvent) {
    if (e.defaultPrevented || !sideInput) return
    const files = filesFromClipboardData(e.clipboardData), looksFileLike = clipboardLooksFileLike(e.clipboardData)
    const paths = looksFileLike ? filePathsFromClipboardData(e.clipboardData) : []
    const text = e.clipboardData?.getData('text/plain') || e.clipboardData?.getData('text/uri-list') || ''
    const decision = decideComposerPaste({ browserFileCount: files.length, uriPathCount: paths.length,
      looksFileLike, largeText: isLargePastedText(text) })
    if (decision.preventBrowserDefault) e.preventDefault()
    if (decision.route === 'browser-files') { addSideFiles(files); return }
    if (decision.route === 'uri-paths') { addSideFilePaths(paths); return }
    if (decision.route === 'large-text') { await attachSidePastedText(text); return }
    const input = sideInput, scope = sideDraftScope, session = sideSurfaceSessionId
    const revision = sideComposerControl?.revision, previous = input.value, start = input.selectionStart, end = input.selectionEnd
    const pathsFromHost = await klausApi.clipboard?.readFilePaths?.().catch(() => [])
    if (sideInput !== input || sideDraftScope !== scope || sideSurfaceSessionId !== session || input.value !== previous
      || sideComposerControl?.revision !== revision || input.selectionStart !== start || input.selectionEnd !== end) return
    if (pathsFromHost?.length) addSideFilePaths(pathsFromHost)
    else if (text) sideComposerControl?.replaceRange(start, end, text, 'insertFromPaste')
  }
  sidePlusBtn?.addEventListener('click', (e: MouseEvent) => { e.preventDefault(); sideFileInput?.click() })
  sideFileInput?.addEventListener('change', () => {
    if (sideFileInput.files?.length) addSideFiles([...sideFileInput.files])
    sideFileInput.value = ''
  })
  sideInput?.addEventListener('paste', handleSideComposerPaste)
  clone.addEventListener('composer-attachment-drop', event => { addSideFiles((event as CustomEvent<File[]>).detail) })
  clone.addEventListener('composer-directory-drop', event => {
    for (const entry of (event as CustomEvent<PendingFileEntry[]>).detail) {
      if (!sidePendingFiles.some(file => file.uploadPath === entry.uploadPath)) sidePendingFiles.push(entry)
    }
    sideRenderPreviews()
    updateSideSendButton()
  })

  // Side voice: reuse the single shared recorder, but route the transcript into
  // the side input and mirror the main mic's press-hold / click-toggle model.
  if (sideVoiceBtn) {
    registerVoiceComposer(sideVoiceBtn, (text: string) => {
      const existing = sideInput!.value
      const needsSpace = existing && !/\s$/.test(existing)
      sideInput!.value = existing + (needsSpace ? ' ' : '') + text
      sideInput!.focus()
      sideAutoResize()
    })
  }

  async function restoreSidePastedTextToComposer(entry: PendingFileEntry) {
    if (!sideInput) return
    const input = sideInput, owner = sideSurfaceSessionId, binding = sideBindingRevision
    const current = () => sideInput === input && input.isConnected && sideSurfaceSessionId === owner
      && sideBindingRevision === binding && sidePendingFiles.includes(entry)
    const text = await readPastedTextForRestore(entry, current)
    if (text == null || !current()) return
    const previous = input.value, start = input.selectionStart ?? previous.length, end = input.selectionEnd ?? start
    const range = expandSelectionAcrossInlineQuotes(start, end, [...sideInlineQuoteEntries(previous), ...normalizeComposerReferences(previous, [])])
    if (sideComposerControl) sideComposerControl.replaceRange(range.start, range.end, text, 'insertFromPaste', 'literal')
    else {
      input.value = previous.slice(0, range.start) + text + previous.slice(range.end)
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }))
    }
    focusComposerInput(input, range.start + text.length)
    sidePendingFiles = sidePendingFiles.filter(candidate => candidate !== entry)
    sideAttachmentHistory.discard(entry)
    sideRenderPreviews()
    sideAutoResize()
    if (entry.uploadPath) void klausApi.chat.pastedTextRemove(entry.uploadPath).catch(() => undefined)
  }

  function sideAutoResize() {
    if (!sideInput) return
    sideInput.style.height = 'auto'
    sideInput.style.height = `${Math.min(sideInput.scrollHeight, 160)}px`
    // Same caret-into-view rule as the main composer: a programmatic value
    // rewrite (shift+Enter, paste, draft restore) does not scroll on its own once
    // the box is capped, so keep the caret in the visible area.
    scrollCaretIntoView(sideInput)
  }
  let sidePendingSendAfterUpload: DeferredSendIntent | null = null
  const sideDrafts = new Map<string, { value: string; files: PendingFileEntry[]; deferred: DeferredSendIntent | null; document?: ComposerDocumentSnapshot }>()
  ;(window as any).klausSideComposerBind = (scope: string | null) => {
    sideDiscovery?.hide()
    if (scope === sideDraftScope) { void sideDiscovery?.refresh(); return }
    sideBindingRevision++
    sideHistoryBrowsingIndex = -1
    if (sideDraftScope) sideDrafts.set(sideDraftScope, { value: sideInput?.value || '', files: sidePendingFiles, deferred: sidePendingSendAfterUpload, document: sideComposerControl?.snapshotDocument() })
    sideDraftScope = scope
    const queuedEdit = scope ? editedQueueReinsertBySession.get(scope) : null
    const saved = (scope ? sideDrafts.get(scope) : null) || (queuedEdit?.phase === 'editing' ? {
      value: queuedEdit.draft?.text || '', document: queuedEdit.draft?.document,
      files: queuedPendingFiles(queuedEdit.item || queuedEdit.row!.item, scope!), deferred: null,
    } : null)
    sidePendingFiles = saved?.files || []
    if (scope) sideDrafts.delete(scope)
    sidePendingSendAfterUpload = saved?.deferred || null
    sideSetComposerDraft({ text: saved?.value || '', ...(saved?.document ? { document: saved.document } : {}) })
    if (queuedEdit?.phase === 'editing') restoreSideDisplayCards((queuedEdit.item || queuedEdit.row!.item).selectedTextAttachments,
      (queuedEdit.item || queuedEdit.row!.item).pastedCards)
    sideComposerControl?.resetHistory()
    sideRenderPreviews()
    sideAutoResize()
    void sideDiscovery?.refresh()
    // An upload may have finished while this draft was in another tab.
    void Promise.resolve().then(() => {
      if (scope === sideDraftScope && scope === sideSurfaceSessionId) releaseSideDeferredSend()
    })
  }
  ;(window as any).klausSideComposerPrepare = (id: string, parentId: string | null) => {
    pendingSideDraft = { id, parentId }
    ;(window as any).klausSideComposerBind(id)
    sideModelApi?.setDisabled(true)
    sideModelApi?.setRuntime(null)
    const inherited = composerPreferencesSnapshot?.sessionId === parentId ? composerPreferencesSnapshot : null
    sideModelApi?.setItems(inherited?.items || [], inherited ? {
      value: inherited.mode, thinkingLevel: inherited.thinkingLevel, ultraMode: inherited.ultraMode, fastMode: inherited.fastMode, fastModeSupported: inherited.fastModeSupported, fastModeBilling: inherited.fastModeBilling, unavailable: inherited.unavailable,
    } : { loading: true })
    sideInput?.focus()
    updateSideSendButton()
  }
  ;(window as any).klausSideComposerPromote = async (draftId: string, sessionId: string, inheritModel = true) => {
    const draft = pendingSideDraft
    if (!draft || draft.id !== draftId) return
    const pending = sideDraftScope === draftId
      ? { value: sideInput?.value || '', document: sideComposerControl?.snapshotDocument(), files: sidePendingFiles, deferred: sidePendingSendAfterUpload }
      : sideDrafts.get(draftId)
    const targetActive = sideDraftScope === sessionId
    const existing = targetActive
      ? { value: sideInput?.value || '', document: sideComposerControl?.snapshotDocument(), files: sidePendingFiles, deferred: sidePendingSendAfterUpload }
      : sideDrafts.get(sessionId)
    if (pending && existing && (existing.value || existing.files.length)) {
      const documentInput = (draft: typeof existing) => ({ text: draft.value, document: draft.document,
        tokens: inlineQuoteEntries(draft.files, draft.value).map(entry => ({ start: entry.range!.start, end: entry.range!.end,
          value: draft.value.slice(entry.range!.start, entry.range!.end), label: entry.previewText || '', data: inlineQuoteDocumentData(entry) })) })
      const merged = mergeComposerDocuments(documentInput(existing), documentInput(pending))
      const prefix = existing.value + (existing.value && pending.value ? '\n' : '')
      for (const entry of pending.files) {
        if (entry.range) entry.range = { start: entry.range.start + prefix.length, end: entry.range.end + prefix.length }
        if (entry.composerOffset !== undefined) entry.composerOffset += prefix.length
      }
      pending.document = merged
      pending.value = composerDocumentText(restoreComposerDocument(merged)!)
      pending.files = [...existing.files, ...pending.files]
      pending.deferred = null
    }
    if (sideDraftScope === draftId || targetActive && pending) {
      sideDiscovery?.hide()
      sideBindingRevision++
      sideHistoryBrowsingIndex = -1
      sideDraftScope = sessionId
      if (pending) {
        sidePendingFiles = pending.files
        sidePendingSendAfterUpload = pending.deferred
        sideSetComposerDraft({ text: pending.value, ...(pending.document ? { document: pending.document } : {}) })
        if (existing && (existing.value || existing.files.length)) sideComposerControl?.resetHistory()
        sideRenderPreviews()
        sideAutoResize()
      }
    } else if (pending) sideDrafts.set(sessionId, pending)
    if (sideDraftScope === sessionId) sideDrafts.delete(sessionId)
    sideDrafts.delete(draftId)
    pendingSideDraft = null
    sideModelApi?.setDisabled(false)
    const inherited = composerPreferencesSnapshot?.sessionId === draft.parentId ? composerPreferencesSnapshot : null
    const source = inheritModel ? inherited?.source : undefined
    const items = source && mainModelCatalogCache.get(source)
    if (source && items) {
      sideComposerModelScope = { sessionId, source }
    }
  }
  ;(window as any).klausSideComposerDiscard = (id: string) => {
    if (pendingSideDraft?.id === id) { pendingSideDraft = null; sideModelApi?.setDisabled(false) }
    const files = sideDraftScope === id ? sidePendingFiles : sideDrafts.get(id)?.files || []
    for (const entry of files) {
      disposeAttachmentObjectUrl(entry)
      if (entry.kind === 'pasted-text' && entry.uploadPath) void klausApi.chat.pastedTextRemove(entry.uploadPath).catch(() => undefined)
    }
    sideDrafts.delete(id)
    if (sideDraftScope === id) {
      sideDiscovery?.hide()
      sideBindingRevision++
      sideHistoryBrowsingIndex = -1
      sideDraftScope = null
      sidePendingFiles = []
      sidePendingSendAfterUpload = null
      if (sideComposerControl) sideComposerControl.restoreText(''); else if (sideInput) sideInput.value = ''
      sideComposerControl?.resetHistory()
      sideRenderPreviews()
      sideAutoResize()
    }
  }

  // Same rule as the main composer: a submit made while an attachment is still
  // uploading is parked, then replayed once the uploads settle. The side
  // composer needs it more, not less — its send button never checked `uploading`
  // at all, so even a mouse click was being dropped.
  function releaseSideDeferredSend() {
    const decision = resolveDeferredSend(
      sidePendingSendAfterUpload,
      sidePendingFiles,
      !!(sideInput?.value || '').trim() || sidePendingFiles.length > 0,
    )
    if (decision.action === 'wait') return
    sidePendingSendAfterUpload = null
    sideSend?.classList.remove('awaiting-upload')
    if (decision.action === 'send') {
      // Whether a parked submit replays as a follow-up is decided NOW, not when it
      // was parked: the turn may have ended while the upload was in flight, and a
      // message that arrives after the turn should start a new one rather than be
      // refused as "the side task is already running".
      const sid = sideSurfaceSessionId
      const running = !!sid && window.isSessionRunning?.(sid)
      void sideSubmit({ replay: true, followUp: running, invert: decision.intent.invertFollowUp })
    }
  }

  /**
   * Send a follow-up from the side composer while its turn is running.
   *
   * The mirror of the main composer's `submitRunningFollowUp`, and it shares the
   * queue helpers rather than duplicating them: the same mode preference decides
   * queue-vs-steer, the same host round-trip stores the row, and the same edit
   * anchor applies. Only the composer state it reads and clears is the side one.
   *
   * A replayed submit (a send parked behind an upload) keeps `invert` false, since
   * the modifier the user held is long gone by the time the upload settles.
   */
  async function sideSubmitRunningFollowUp(sid: string, invert: boolean) {
    const draft = sideInput?.value || ''
    const draftFiles = [...sidePendingFiles]
    const draftRevision = sideComposerControl?.revision
    const historyDraft = sideComposedInputDraft()
    const draftDocument = historyDraft.document
    const value = sideComposedInputText()
    const serialized = sideComposerControl?.serializeSubmission()
    const references = serialized ? referencesFromEditor(serialized.text, serialized.tokens)
      : normalizeComposerReferences(value, [])
    if (!value.trim() && sidePendingFiles.length === 0) return
    if (!(await ensureComposerModelConfigured(sid))) return
    if (!sideDraftUnchanged(sid, draft, draftFiles, draftRevision)) return
    if (hasUploadInFlight(sidePendingFiles)) {
      // Park it exactly like a normal side submit: the intent survives the upload,
      // and `releaseSideDeferredSend` replays it as a follow-up because the turn is
      // still running when it lands. The modifier the user held is gone by then, so
      // the replay is not inverted.
      sidePendingSendAfterUpload = { invertFollowUp: false }
      sideSend?.classList.add('awaiting-upload')
      sideSend?.setAttribute('aria-label', tt('submit_tooltip_waiting_upload'))
      return
    }
    sidePendingSendAfterUpload = null
    sideSend?.classList.remove('awaiting-upload')
    const files = [...sidePendingFiles]
    const payload = buildOutgoingPayload(value, files, historyDraft.slashCommand?.command || null, sid, references, draftDocument)
    addSessionHistory(sid, historyDraft)
    const action = value.trimStart().startsWith('/')
      ? 'queue'
      : followUpModeHelper.resolveSubmitAction(followUpQueueMode, invert)
    const reinsertAnchors = takeEditedQueueReinsert(sid)
    sidePendingFiles = []
    sideRenderPreviews()
    if (sideInput) {
      sideSetComposerDraft('')
      // Same rule as the main composer: clearing after a send is the app
      // replacing the document, not the user editing it.
      sideComposerControl?.resetHistory()
    }
    sideAutoResize()
    updateSideSendButton()
    const clearedValue = sideInput?.value || '', clearedFiles = [...sidePendingFiles], clearedDeferred = sidePendingSendAfterUpload
    const clearedRevision = sideComposerControl?.revision
    klausApi.session.touchSideTask?.(sid).catch(() => {})
    if (action === 'steer') {
      const accepted = await steerFollowUp(sid, payload, { quietError: true })
      if (!accepted) {
        if (sideDraftUnchanged(sid, clearedValue, clearedFiles, clearedRevision) && sidePendingSendAfterUpload === clearedDeferred) {
          sidePendingFiles = files
          sideRenderPreviews()
          sideSetComposerDraft(historyDraft)
          sideComposerControl?.resetHistory()
          sideAutoResize()
          if (reinsertAnchors) setEditedQueueReinsert(sid, reinsertAnchors)
          updateSideSendButton()
        } else {
          await retainRefusedFollowUp(sid, payload, reinsertAnchors)
        }
        showToast(tt('follow_up_failed'))
      }
      return
    }
    const queued = await queueFollowUp(sid, payload, reinsertAnchors)
    if (queued.status !== 'refused') return
    // Only a confirmed refusal returns to the draft. A newer draft owns its own
    // text and attachments; the refused request gets a paused recovery row instead.
    if (sideDraftUnchanged(sid, clearedValue, clearedFiles, clearedRevision) && sidePendingSendAfterUpload === clearedDeferred) {
      sidePendingFiles = files
      sideRenderPreviews()
      if (sideInput) {
        sideSetComposerDraft(historyDraft)
        sideComposerControl?.resetHistory()
        sideAutoResize()
      }
      if (reinsertAnchors) setEditedQueueReinsert(sid, reinsertAnchors)
      updateSideSendButton()
      forgetPendingQueueAddition(sid, queued.id)
    } else {
      await recoverRefusedQueueAddition(sid, queued, reinsertAnchors)
    }
    showToast(tt('follow_up_failed'))
  }

  function sideDraftUnchanged(sid: string, draft: string, files: PendingFileEntry[], revision: number | undefined) {
    return sid === sideSurfaceSessionId && revision === sideComposerControl?.revision && draft === (sideInput?.value || '')
      && files.length === sidePendingFiles.length && files.every((file, index) => file === sidePendingFiles[index])
  }

  async function sideSubmit(options: { replay?: boolean; followUp?: boolean; invert?: boolean } = {}) {
    const sid = sideSurfaceSessionId
    if (!sid) return
    const compactInstructions = sidePendingFiles.length === 0 ? parseCompactSlashInput(sideComposedInputText()) : null
    if (compactInstructions !== null) { await sideCompact(compactInstructions); return }
    if (!(sideInput?.value || '').trim() && sidePendingFiles.length === 0) return sideSubmitNow(options)
    const release = preparingSubmissions.begin(sid)
    if (!release) return
    updateSideSendButton()
    try { await sideSubmitNow(options) }
    finally { release(); updateSideSendButton() }
  }

  async function sideSubmitNow(options: { replay?: boolean; followUp?: boolean; invert?: boolean } = {}) {
    const sid = sideSurfaceSessionId
    if (!sid) return
    const friendDraft = sideComposedInputDraft()
    const friendReferences = friendDraft.references.filter(reference => reference.kind === 'friend')
    if (friendReferences.length) {
      if (sideFriendSending) return
      if (sidePendingFiles.length) { showToast(tt('chat_friend_text_only')); return }
      sideFriendSending = true
      updateSideSendButton()
      const snapshot = JSON.stringify(friendDraft)
      const context = sideFriendContexts.get(sid) || { intent: 'request' as const }
      const key = sid + ':' + snapshot + ':' + context.intent
      sideFriendAttempt = persistedSideFriendAttempts.acquire(key)
      try {
        const receipt = await klausApi.friends.sendMessage({ sessionId: sid, text: friendDraft.text, displayMetadata: {
          displayText: friendDraft.text, composerReferences: friendDraft.references,
          ...(friendDraft.document ? { composerDocument: friendDraft.document } : {}),
          ...friendComposeMetadata(context, true), friendDispatchId: sideFriendAttempt.id,
        } }) as { accepted?: boolean }
        if (receipt.accepted !== true) throw new Error(tt('chat_friend_partial_send'))
        persistedSideFriendAttempts.accepted(sideFriendAttempt)
        sideFriendAttempt = null
        if (sid === sideSurfaceSessionId && JSON.stringify(sideComposedInputDraft()) === snapshot) {
          sideSetComposerDraft(''); sideFriendContexts.delete(sid); sideAutoResize()
        }
        void loadSessionHistory(sid)
      } catch (error) { showToast(tt('chat_friend_send_failed') + ((error as Error)?.message || String(error))) }
      finally { sideFriendSending = false; updateSideSendButton() }
      return
    }
    const reviewEntry = approvalReviewShortcutRange(sideInput?.value || '')
    if (reviewEntry && sideInput) {
      const draft = sideInput.value
      sideInput.value = draft.slice(0, reviewEntry.start) + draft.slice(reviewEntry.end).replace(/^[ \t]+/, '')
      sideInput.dispatchEvent(new Event('input', { bubbles: true }))
      openApprovalReviewDenials(sid, () => sideSurfaceSessionId, sideInput as unknown as HTMLElement)
      return
    }
    const compactInstructions = sidePendingFiles.length === 0 ? parseCompactSlashInput(sideComposedInputText()) : null
    if (compactInstructions !== null) { await sideCompact(compactInstructions); return }
    if (window.isSessionRunning?.(sid)) {
      const value = (sideInput?.value || '').trim()
      // Symmetry with the main composer: Enter with something typed is a FOLLOW-UP
      // (queue or steer, per the shared preference), not a stop. A button press
      // reaches this path only when the button shows the submit face (composer
      // holds content and no stop is in flight), so it follows the same rule; with
      // an empty composer the button stops instead, below.
      if ((value || sidePendingFiles.length > 0) && options.followUp) {
        // A live Enter carries the user's modifier; a replayed submit does not,
        // because the key was released long before the upload settled.
        await sideSubmitRunningFollowUp(sid, options.replay === true ? false : options.invert === true)
        return
      }
      // The send button doubles as stop, but only for a live press. A replayed
      // submit carries the opposite intent, so routing it here would abort a
      // running turn and lose the message with it.
      if (options.replay) { showToast(tt('side_send_blocked_session_running')); return }
      requestTurnStop(sid)
      return
    }
    const value = sideComposedInputText()
    const historyDraft = sideComposedInputDraft()
    const draftDocument = historyDraft.document
    const serialized = sideComposerControl?.serializeSubmission()
    const references = serialized ? referencesFromEditor(serialized.text, serialized.tokens)
      : normalizeComposerReferences(value, [])
    // Empty composer plus a stopped or failed Turn: this press means continue.
    if (!value.trim() && sidePendingFiles.length === 0 && sessionContinueMode(sid)) {
      requestTurnContinue(sid)
      return
    }
    if (!value.trim() && sidePendingFiles.length === 0) return
    const draft = sideInput?.value || ''
    const draftFiles = [...sidePendingFiles]
    const draftRevision = sideComposerControl?.revision
    if (!(await ensureComposerModelConfigured(sid))) return
    if (!sideDraftUnchanged(sid, draft, draftFiles, draftRevision)) return
    if (hasUploadInFlight(sidePendingFiles)) {
      sidePendingSendAfterUpload = { invertFollowUp: false }
      sideSend?.classList.add('awaiting-upload')
      sideSend?.setAttribute('aria-label', tt('submit_tooltip_waiting_upload'))
      return
    }
    sidePendingSendAfterUpload = null
    sideSend?.classList.remove('awaiting-upload')
    const files = [...sidePendingFiles]
    addSessionHistory(sid, historyDraft)
    sidePendingFiles = []
    sideRenderPreviews()
    sideSetComposerDraft('')
    sideAutoResize()
    updateSideSendButton()
    klausApi.session.touchSideTask?.(sid).catch(() => {})
    takeEditedQueueReinsert(sid)
    try { await submitTurnPayload(sid, buildOutgoingPayload(value, files, historyDraft.slashCommand?.command || null, sid, references, draftDocument)) }
    catch (err) { console.warn('[side-composer] send failed:', err) }
  }
  sideInput?.addEventListener('input', (rawEvent: Event) => {
    const event = rawEvent as InputEvent
    sideHistoryBrowsingIndex = -1
    const current = sideInput.value
    const completedReference = event.inputType === 'insertText' && /\s/.test(event.data || '')
      && normalizeComposerReferences(current, []).some(reference => reference.range.end === current.length - 1)
    if (completedReference) sideComposerControl?.refreshTokens()
    sideRenderPreviews()
    sideAutoResize()
    updateSideSendButton()
    void sideDiscovery?.refresh()
  })
  sideInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (composerKeyWasHandled(e) || e.isComposing || e.keyCode === 229 || sideComposerControl?.composing) return
    if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
      && (!sideSurfaceSessionId || !window.isSessionRunning?.(sideSurfaceSessionId))) {
      e.preventDefault()
      sideInput.blur()
      return
    }
    if (e.key === 'Enter' && e.shiftKey && !e.isComposing && sideInput.tagName !== 'TEXTAREA') {
      e.preventDefault()
      const previous = sideInput.value
      const start = sideInput.selectionStart ?? previous.length
      const end = sideInput.selectionEnd ?? start
      const expanded = expandSelectionAcrossInlineQuotes(start, end, [
        ...sideInlineQuoteEntries(previous),
        ...configuredAgentReferences(previous),
      ])
      sideComposerControl?.replaceRange(expanded.start, expanded.end, '\n', 'insertLineBreak')
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) {
      e.preventDefault()
      // Enter is the follow-up path while the side turn runs (Cmd/Ctrl inverts the
      // queue/steer default, exactly as in the main composer). The button follows
      // the same split as the main composer: submit face once the side composer
      // holds content, stop face while it is empty.
      sideSubmit({ followUp: true, invert: e.metaKey || e.ctrlKey })
    }
  })
  sideSend?.addEventListener('click', (e: MouseEvent) => {
    e.preventDefault()
    // Same split as the main composer: while the side turn runs and the side
    // composer holds content, the button is a submit (queue/steer), not a stop.
    const running = !!sideSurfaceSessionId && window.isSessionRunning?.(sideSurfaceSessionId)
    const stopping = !!sideSurfaceSessionId && stoppingSessions.has(sideSurfaceSessionId)
    const hasContent = !!((sideInput?.value || '').trim()) || sidePendingFiles.length > 0
    if (running && !stopping && hasContent) sideSubmit({ followUp: true })
    else sideSubmit()
  })
  // Keep the send/stop affordance in sync with the side session's running state.
  function updateSideSendButton() {
    if (!sideSend) return
    const friendRefs = sideComposedInputDraft().references.filter(reference => reference.kind === 'friend')
    const friendIntent = sideSurfaceSessionId ? sideFriendContexts.get(sideSurfaceSessionId)?.intent || 'request' : 'request'
    sideFriendIntentApi?.setHidden(friendRefs.length === 0)
    sideFriendIntentApi?.setValue(friendIntent)
    sideFriendIntentApi?.setDisabled(sideFriendSending)
    if (sideFriendSending) { sideSend.disabled = true; return }
    if (friendRefs.length) {
      sideSend.classList.remove('busy', 'stopping', 'continue', 'continuing', 'running-submit')
      sideSend.disabled = sidePendingFiles.length > 0 || !hasFriendQuoteInstruction(sideInput?.value || '', friendRefs)
      sideSend.setAttribute('aria-label', friendSendLabel(friendRefs.map(reference => friendReferenceIdentity(reference).name), friendIntent, tt))
      return
    }
    const running = !!sideSurfaceSessionId && window.isSessionRunning?.(sideSurfaceSessionId)
    document.getElementById('side-scroll-to-bottom')?.toggleAttribute('data-generating', !!running)
    const stopping = !!sideSurfaceSessionId && stoppingSessions.has(sideSurfaceSessionId)
    const empty = !(sideInput?.value || '').trim() && sidePendingFiles.length === 0
    const continuing = !running && !stopping && !!sideSurfaceSessionId && empty
      && sessionContinueMode(sideSurfaceSessionId)
    const continuePending = !!sideSurfaceSessionId && continuingSessions.has(sideSurfaceSessionId)
    const runningSubmit = !!running && !stopping && !empty
    sideSend.classList.toggle('busy', !!running)
    sideSend.classList.toggle('running-submit', runningSubmit)
    sideSend.classList.toggle('stopping', stopping)
    sideSend.classList.toggle('continue', continuing)
    sideSend.classList.toggle('continuing', continuePending)
    sideSend.disabled = !sideSurfaceSessionId || stopping
      || (continuing ? continuePending : (!running && empty))
    sideSend.setAttribute('aria-label', stopping
      ? tt('submit_tooltip_stopping')
      : runningSubmit && hasUploadInFlight(sidePendingFiles) && sidePendingSendAfterUpload
        ? tt('submit_tooltip_waiting_upload')
        : runningSubmit
          ? tt(followUpQueueMode === 'steer' ? 'submit_tooltip_steer' : 'submit_tooltip_queue')
          : running
            ? tt('submit_tooltip_stop')
            : continuing
              ? tt(continuePending ? 'submit_tooltip_continuing' : 'submit_tooltip_continue')
              : tt('submit_tooltip_send'))
  }
  ;(window as any).klausUpdateSideSendButton = updateSideSendButton
  setInterval(updateSideSendButton, 300)

  // The side composer's own queue island. A side chat is a separate session with its
  // own queue, and the host dispatches and pauses it exactly like the main one, so it
  // gets a real mount bound to `sideSurfaceSessionId` rather than reusing the main
  // island (which would act on the wrong conversation's rows).
  const sideFollowUpQueueEl = clone.querySelector<HTMLElement>('#side-follow-up-queue')
  function restoreSideDisplayCards(selected: any, pasted: any) {
    for (const card of Array.isArray(pasted) ? pasted : []) {
      if (card.path) {
        if (!sidePendingFiles.some(entry => entry.kind === 'pasted-text' && entry.uploadPath === card.path)) {
          sidePendingFiles.push(buildPastedReferenceEntry({ path: card.path,
            preview: card.preview || card.previewText || pastedTextPreview(card.text || ''),
            characterCount: Number.isFinite(card.characterCount) ? Number(card.characterCount) : 0,
            ...(typeof card.text === 'string' ? { text: card.text } : {}) }))
        }
      } else if (typeof card.text === 'string' && card.text) void attachSidePastedText(card.text)
    }
    const cards = (Array.isArray(selected) ? selected : []).map((card: any, index: number) => ({ ...card, index }))
      .sort((left: any, right: any) => Number(right.requestOffset || 0) - Number(left.requestOffset || 0)
        || Number(right.displayOrder ?? right.index) - Number(left.displayOrder ?? left.index))
    const existing = sidePendingFiles.filter(entry => entry.kind === 'selected-text')
    const consumed = new Set<PendingFileEntry>()
    for (const card of cards) {
      const match = existing.find(entry => !consumed.has(entry) && (card.quoteId ? entry.quoteId === card.quoteId : entry.text === card.text))
      if (match) { consumed.add(match); continue }
      sideAddSelection(card.text, card.requestOffset, card)
    }
  }
  const sideFollowUpQueueHandlers = buildFollowUpQueueHandlers(
    () => sideSurfaceSessionId,
    {
      capture: () => {
        const sessionId = sideSurfaceSessionId, value = sideInput?.value || '', files = [...sidePendingFiles], deferred = sidePendingSendAfterUpload
        const document = sideComposerControl?.snapshotDocument(), revision = sideComposerControl?.revision, binding = sideBindingRevision
        return {
          isCurrent: () => binding === sideBindingRevision && sessionId === sideSurfaceSessionId && sideDraftUnchanged(sessionId || '', value, files, revision)
            && JSON.stringify(document) === JSON.stringify(sideComposerControl?.snapshotDocument())
            && sidePendingSendAfterUpload === deferred,
          restore: () => {
            sidePendingFiles = files
            sideSetComposerDraft({ text: value, ...(document ? { document } : {}) })
            sideRenderPreviews()
          },
        }
      },
      restoreForEdit: item => {
        sidePendingSendAfterUpload = null
        sideSend?.classList.remove('awaiting-upload')
        sidePendingFiles = queuedPendingFiles(item, sideSurfaceSessionId || '')
        const restored = composerDraftFromDisplayMetadata(item.displayMetadata ?? item)
        sideSetComposerDraft(restored || item.displayText)
        restoreSideDisplayCards(item.selectedTextAttachments, item.pastedCards)
        sideComposerControl?.resetHistory()
        sideRenderPreviews()
      },
      settle: () => {
        sideAutoResize()
        updateSideSendButton()
        // Caret at the end: the message was just handed back for editing, and the
        // most common edit is at the tail (adding to it) rather than at the head.
        if (sideInput) focusComposerInput(sideInput, sideInput.value.length)
      },
      persistEdit: () => persistQueuedEditDraft(sideSurfaceSessionId, sideComposedInputDraft(), sidePendingFiles),
    },
    // A side chat's own queue omits "open in side chat": opening a side chat from a
    // side chat is not a thing this product does, and the menu drops the item rather
    // than showing a control that cannot work.
    { offerSideChat: false },
  )
  sideFollowUpQueueApi = mountFollowUpQueue(sideFollowUpQueueEl, sideFollowUpQueueHandlers)
  function handleSideRecallKeydown(event: KeyboardEvent) {
    if (!sideInput || event.defaultPrevented || event.isComposing || event.keyCode === 229 || sideComposerControl?.composing
      || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
      || event.key !== 'ArrowUp' && event.key !== 'ArrowDown'
      || sideInput.selectionStart !== sideInput.value.length || sideInput.selectionEnd !== sideInput.value.length
      || sideInput.ownerDocument.getSelection()?.isCollapsed === false) return
    const sessionId = sideSurfaceSessionId
    if (!sessionId || sideDraftScope !== sessionId || sideHistoryBrowsingIndex < 0 && sideInput.value.length > 0) return
    if (sideHistoryBrowsingIndex < 0 && event.key === 'ArrowUp' && sidePendingFiles.length === 0) {
      const queued = [...clientQueueFor(sessionId)].reverse().find(row => !row.id.startsWith('engine:')
        && !row.dispatching && !row.unconfirmed && row.item.followUpState !== 'unconfirmed'
        && !clientQueueMutationPending(sessionId, row.id))
      if (queued) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void sideFollowUpQueueHandlers.onEdit(queued.id)
        return
      }
    }
    const entries = sessionHistories.get(composerHistoryScope(sessionId)) || []
    const next = recalledHistoryIndex(sideHistoryBrowsingIndex, event.key === 'ArrowUp' ? -1 : 1, entries.length)
    if (next === null) return
    sideSetComposerDraft(next < 0 ? '' : entries[next])
    sideHistoryBrowsingIndex = next
    sideAutoResize()
    updateSideSendButton()
    focusComposerInput(sideInput, sideInput.value.length)
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  sideInput?.addEventListener('keydown', handleSideRecallKeydown, true)
  renderSideFollowUpQueue()
}
const welcomeEl = document.getElementById('welcome') as HTMLElement
const composerContextRowEl = document.getElementById('composer-context-row')
const inputEl = document.getElementById('input') as HTMLTextAreaElement
const mainComposerControl = installContenteditableTextControl(inputEl as unknown as HTMLElement, (value) => [
  ...inlineQuoteEntries(pendingFiles, value).map((entry) => ({
    start: entry.range!.start,
    end: entry.range!.end,
    value: value.slice(entry.range!.start, entry.range!.end),
    element: createComposerInlineQuote(entry, removeInlineQuote),
    data: inlineQuoteDocumentData(entry),
  })),
  ...composerReferenceEntries(value).map((reference) => ({
    start: reference.range.start,
    end: reference.range.end,
    value: reference.value,
    element: createComposerReferenceElement(reference),
    data: reference,
  })),
  ...commandDocumentTokens(value),
], { onLongPaste: text => {
  if (!isLargePastedText(text)) return false
  void attachMainPastedText(text)
  return true
}, restoreTokens: (value, tokens) => {
  composerReferenceTokens = referencesFromEditor(value, tokens)
  pendingFiles = restoreInlineDocumentFiles(pendingFiles, tokens)
  const command = tokens.find(token => (token.data as { kind?: string })?.kind === 'command')
  selectedSlashCommand = (command?.data as { command?: SlashCommandInfo })?.command || null
  selectedSlashCommandRange = command ? { start: command.start, end: command.end } : null
} })
// The host intercepts the platform's undo/redo while a composer owns the focus
// and dispatches it back into the composer's own history, because the native
// undo stack cannot see this control's programmatic rewrites.
installComposerEditCommandBridge(window.klaus ?? {}, window as unknown as Record<string, unknown>, document)
const inputWrapperEl = document.getElementById('input-wrapper')
const followUpQueueEl = document.getElementById('follow-up-queue')
const archivedSessionBannerEl = document.getElementById('archived-session-banner')
const archivedSessionContinueEl = document.getElementById('archived-session-continue')
const btnSend = document.getElementById('send') as HTMLButtonElement
const btnNewChat = document.getElementById('btn-new-chat') as HTMLElement
const btnComposerPlus = document.getElementById('composer-plus-btn')
const fileInput = document.getElementById('file-input') as HTMLInputElement
const sessionListEl = document.getElementById('session-list')
const titlebarSessionTitleEl = document.getElementById('titlebar-session-title')
const dropOverlay = document.getElementById('drop-overlay') as HTMLElement
const slashMenu = document.getElementById('slash-menu') as HTMLElement
const composerPlusMenu = document.getElementById('composer-plus-menu')
const composerPlusSubmenu = document.getElementById('composer-plus-submenu')
const slashInputLine = document.getElementById('slash-input-line')
const slashToken = document.getElementById('slash-token')
const slashTokenLabel = document.getElementById('slash-token-label')
let sessionContextMenu: HTMLElement | null = null
let sessionContextMenuCleanup: (() => void) | null = null
let sessionContextRow: HTMLElement | null = null
let composerTokenLayerEl = document.getElementById('composer-token-layer')
if (!composerTokenLayerEl && slashInputLine && inputEl) {
  composerTokenLayerEl = document.createElement('div')
  composerTokenLayerEl.id = 'composer-token-layer'
  slashInputLine.insertBefore(composerTokenLayerEl, inputEl)
}
if (composerTokenLayerEl && slashToken && slashToken.parentElement !== composerTokenLayerEl) {
  composerTokenLayerEl.appendChild(slashToken)
}
let composerSlashMirrorEl = document.getElementById('composer-slash-mirror')
if (!composerSlashMirrorEl) {
  composerSlashMirrorEl = document.createElement('div')
  composerSlashMirrorEl.id = 'composer-slash-mirror'
  composerSlashMirrorEl.className = 'hidden'
}
if (composerTokenLayerEl && composerSlashMirrorEl.parentElement !== composerTokenLayerEl) {
  composerTokenLayerEl.appendChild(composerSlashMirrorEl)
}

// Welcome-mode composer dock. The new-session screen places the shared
// composer (#input-wrapper) between the hero copy and the suggestion chips;
// once a conversation shows messages it returns to its home spot right above
// the (hidden) composer-home anchor. Re-parenting keeps all composer
// listeners/popups alive, and because both docks live inside #main's flex
// flow the composer width and centering automatically follow the right
// monitor panel collapse/expand.
// A MutationObserver on #welcome's inline style keeps the dock in sync with
// every `welcomeEl.style.display = ...` call site without touching each one.
const welcomeComposerSlotEl = document.getElementById('welcome-composer-slot')
const composerHomeAnchorEl = document.getElementById('composer-home-anchor')
function syncComposerDock() {
  if (!welcomeComposerSlotEl || !composerHomeAnchorEl?.parentElement || !inputWrapperEl || !welcomeEl) return
  const welcomeVisible = welcomeEl.style.display !== 'none'
  const alreadyDocked = welcomeVisible
    ? inputWrapperEl.parentElement === welcomeComposerSlotEl
    : (inputWrapperEl.parentElement === composerHomeAnchorEl.parentElement
        && inputWrapperEl.nextElementSibling === composerHomeAnchorEl)
  if (alreadyDocked) return
  // Re-parenting blurs a focused textarea — restore focus so the caret
  // survives welcome <-> conversation transitions.
  const hadFocus = document.activeElement === inputEl
  if (welcomeVisible) welcomeComposerSlotEl.appendChild(inputWrapperEl)
  else composerHomeAnchorEl.parentElement.insertBefore(inputWrapperEl, composerHomeAnchorEl)
  // Keep the /btw side-question panel glued directly above the composer.
  const btwPanel = document.getElementById('btw-panel')
  if (btwPanel) inputWrapperEl.parentElement?.insertBefore(btwPanel, inputWrapperEl)
  if (hadFocus) inputEl.focus()
}
if (welcomeEl) {
  new MutationObserver(syncComposerDock).observe(welcomeEl, { attributes: true, attributeFilter: ['style'] })
  syncComposerDock()
}

// 粘底跟随：主转录与 side 面板各持一个 bottom-sticker 实例（阈值、方向判定、内容
// 观察器、浮标显隐全在那一份实现里，两边不会再漂移）。下面这些名字只是代理，
// 保留是因为全文多处调用。
const mainSticker = createBottomSticker({
  scrollEl: messagesEl,
  floatBtn: scrollToBottomBtn,
  isVisible: () => messagesEl.style.display !== 'none',
})
// Outer proxy scrollbar for the main transcript: the column's native scrollbar
// is hidden, so this 6px scroller at #main's right edge is the only thumb the
// conversation shows. Dragging it is real user scroll intent for the sticker.
mountOuterScrollbar({
  scrollEl: messagesEl,
  region: document.getElementById('main'),
  onUserScrollIntent: (direction) => {
    if (direction === 'up') mainSticker.noteUpwardScrollGesture()
    else mainSticker.noteUserScrollIntent()
  },
})
// side 面板的 sticker 得等 composer 克隆完才能建：#side-scroll-to-bottom 是
// initSideComposer 里克隆主 composer 时连带重命名出来的，在那之前并不存在。
let sideSticker: BottomSticker | null = null

function isMessagesNearBottom() { return mainSticker.isNearBottom() }
function noteMessagesUserScrollIntent() { mainSticker.noteUserScrollIntent() }
function lockMessagesBottomForNavigation() { mainSticker.lockForNavigation() }
function resumeMessagesBottomFollowing() { mainSticker.resumeFollowing() }
function updateScrollToBottomBtn() { mainSticker.syncFloatBtn() }

function navigateToTurn(target: HTMLElement, options: { behavior?: ScrollBehavior } = {}) {
  if (!target?.isConnected || !messagesEl.contains(target) || target.dataset.navTurn !== 'true') return false
  revealUserMessageContent(target)
  lockMessagesBottomForNavigation()
  const messagesRect = messagesEl.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const top = Math.max(0, messagesEl.scrollTop + targetRect.top - messagesRect.top - 12)
  messagesEl.scrollTo({ top, behavior: options.behavior || 'smooth' })
  return true
}

const turnNavigationController = window.KlausTurnNavigation?.createTurnNavigationController({
  scrollEl: messagesEl,
  railEl: document.getElementById('turn-navigation'),
  listEl: document.getElementById('turn-navigation-list'),
  tooltipEl: document.getElementById('turn-navigation-tooltip'),
  translate: (key: string, fallback: string) => typeof tt === 'function' ? tt(key) : fallback,
  onNavigate: navigateToTurn,
}) || null

window.addEventListener('klaus:lang-change', () => turnNavigationController?.refreshLabels())
window.addEventListener('klaus:settings-visibility-change', () => syncTopModeButtons())

function slashCommandDisplayName(command: SlashCommandInfo | null | undefined) {
  if (isManualCompactCommand(command)) return tt('compact_command_title')
  return slashCommandDisplayLabel(command)
}

function slashCommandDescription(command: SlashCommandInfo | null | undefined) {
  if (isManualCompactCommand(command)) return manualCompactPresentation({ sessionId: window.currentSessionId, percent: contextUsageView(ctxPanel.sessions.get(window.currentSessionId || ''))?.percent ?? null }, tt).description
  return window.klausSlashCommandI18n?.description?.(command) || command?.description || ''
}

function escapeRegExp(value: string) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function iconClassAttr(className: string | undefined) {
  return className ? ` class="${className}"` : ''
}

// Hollow path-fill icons — must stay byte-identical with the sidebar versions in
// [index.html](../index.html) so the same concept reads
// the same wherever it appears (sidebar / plus menu / slash chip / btw pill /
// workspace mention). Changing one without the other is a no-no.
function slashCommandIconSvg(className = '') {
  return klausIcon('slash-command-fill', { cls: className })
}

function skillIconSvg(className = '') {
  return klausIcon('skill-sparkle-fill', { cls: className })
}

function pluginIconSvg(className = '') {
  return klausIcon('plugin-fill', { cls: className })
}

function mcpIconSvg(className = '') {
  return klausIcon('mcp-grid-fill', { cls: className })
}

const slashCommandCache = new Map()
const slashCatalog = new SlashCatalog()
const composerSkillCatalog = new ComposerCatalog<{ installed: unknown; builtin: unknown }>()

function slashCatalogScope(): string {
  const workspaceId = currentEditableWorkspaceId()
  return JSON.stringify([window.currentSessionId || '', selectedProjectWorkdir() || '', workspaceId, workspaceById(workspaceId)?.roots ?? []])
}

function invalidateComposerCatalogs() {
  slashCatalog.invalidate()
  composerSkillCatalog.invalidate()
}
window.addEventListener('klaus:projects-changed', invalidateComposerCatalogs)
klausApi.on.appPreferencesChanged?.(invalidateComposerCatalogs)

function slashCommandCacheKey(name: string | undefined) {
  return String(name || '').trim().toLowerCase()
}

function cacheSlashCommand(command: SlashCommandInfo | null | undefined) {
  const key = slashCommandCacheKey(command?.name)
  if (key) slashCommandCache.set(key, command)
}

function resolveSlashCommand(command: SlashCommandInfo | null | undefined, name: string) {
  return command || slashCommandCache.get(slashCommandCacheKey(name)) || null
}

function commandGroupKey(command: SlashCommandInfo | null | undefined) {
  const source = String(command?.source || '').toLowerCase()
  const name = String(command?.name || '').toLowerCase()
  if (command?.kind === 'skill' || source.includes('skill') || source === 'bundled' || source === 'installed') return 'skills'
  if (source.includes('plugin')) return 'plugins'
  if (source.includes('mcp') || name.includes(':')) return 'mcp'
  return 'shortcuts'
}

function commandGroupClass(command: SlashCommandInfo | null | undefined) {
  return `is-${commandGroupKey(command)}-command`
}

function commandIconSvg(command: SlashCommandInfo | null | undefined, className = '') {
  if (isManualCompactCommand(command)) return contextPieSvg(contextUsageView(ctxPanel.sessions.get(window.currentSessionId || ''))?.percent ?? 0).replace('<svg ', `<svg${iconClassAttr(className)} `)
  switch (commandGroupKey(command)) {
    case 'skills': return skillIconSvg(className)
    case 'plugins': return pluginIconSvg(className)
    case 'mcp': return mcpIconSvg(className)
    default: return slashCommandIconSvg(className)
  }
}

function slashCommandGroupLabel(group: string) {
  if (group === 'skills') return tt('skills')
  if (group === 'plugins') return tt('plugins')
  if (group === 'mcp') return tt('mcp')
  return tt('composer_slash_commands')
}

function slashCommandMatchesSearch(command: SlashCommandInfo, query: string) {
  const search = window.klausSearch
  if (search?.matches) {
    const values = typeof search.slashCommandValues === 'function'
      ? search.slashCommandValues(command)
      : [
          command?.name,
          command?.displayName,
          command?.description,
          command?.argumentHint,
          command?.source,
          command?.type,
          slashCommandDisplayName(command),
          slashCommandDescription(command),
        ]
    return search.matches(query, values)
  }
  const q = String(query || '').trim().toLowerCase().replace(/^\/+/, '')
  if (!q) return true
  return [
    command?.name,
    command?.displayName,
    command?.description,
    command?.argumentHint,
    command?.source,
    command?.type,
    slashCommandDisplayName(command),
    slashCommandDescription(command),
  ].some((value: string) => String(value || '').toLowerCase().includes(q))
}

let composerMeasureCanvas = null

function measureComposerText(text: string) {
  composerMeasureCanvas ||= document.createElement('canvas')
  const ctx = composerMeasureCanvas.getContext('2d')
  if (!ctx) return String(text || '').length * 8
  const cs = getComputedStyle(inputEl)
  ctx.font = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  return ctx.measureText(String(text || '')).width
}

function measureSlashCommandTokenWidth(command: SlashCommandInfo | null | undefined) {
  if (!document?.body) return 16 + 5 + measureComposerText(slashCommandDisplayName(command))
  const el = document.createElement('span')
  el.className = `slash-token composer-slash-mirror-token ${commandGroupClass(command)}`
  el.style.font = getComputedStyle(inputEl).font
  el.style.position = 'absolute'
  el.style.visibility = 'hidden'
  el.style.pointerEvents = 'none'
  el.style.whiteSpace = 'nowrap'
  el.style.left = '-9999px'
  el.style.top = '-9999px'
  el.innerHTML = composerSlashTokenInnerHtml(command)
  document.body.appendChild(el)
  const width = el.getBoundingClientRect().width
  el.remove()
  return width || (16 + 5 + measureComposerText(slashCommandDisplayName(command)))
}

function inlineQuotePlaceholder() {
  return '\uFFFC'
}

function inlineQuoteDocumentData(entry: PendingFileEntry) {
  const data = { ...entry, file: { name: entry.file.name, type: entry.file.type, size: entry.file.size },
    ...(entry.specAnnotation ? { specAnnotation: { ...entry.specAnnotation } } : {}) }
  delete data.range
  delete data.objectUrl
  return data
}

function restoreInlineDocumentFiles(files: PendingFileEntry[], tokens: InlineTokenSnapshot[]): PendingFileEntry[] {
  const inline = tokens.flatMap(token => {
    const data = token.data as Partial<PendingFileEntry> | null
    if (!data || !['selected-text', 'pasted-text'].includes(data.kind || '') || typeof data.text !== 'string') return []
    return [{ ...data, file: data.file || { name: 'Quoted text', type: 'text/plain', size: data.text.length },
      uploading: false, range: { start: token.start, end: token.end } } as PendingFileEntry]
  })
  return [...files.filter(entry => !entry.range), ...inline]
}

function commandDocumentTokens(value: string, command = selectedSlashCommand, range = selectedSlashCommandRange) {
  if (!command || !isValidSlashCommandRange(range, value)) return []
  const token = document.createElement('span')
  token.className = `slash-token composer-slash-mirror-token ${commandGroupClass(command)}`
  token.innerHTML = composerSlashTokenInnerHtml(command)
  return [{ ...range, value: value.slice(range.start, range.end),
    data: { kind: 'command', name: slashCommandDisplayName(command), command: { ...command } }, element: token }]
}

function inlineQuoteEntries(files: PendingFileEntry[] = pendingFiles, value: string = inputEl.value) {
  return files.filter((entry) => (entry.kind === 'selected-text' || entry.kind === 'pasted-text')
    && entry.range
    && entry.range.start >= 0
    && entry.range.end > entry.range.start
    && entry.range.end <= value.length)
}

function forgetInlineQuoteEntries(removed: PendingFileEntry[]): void {
  if (removed.length === 0) return
  pendingFiles = pendingFiles.filter(entry => !removed.includes(entry))
}


function composerReferenceEntries(value: string = inputEl.value) {
  return normalizeComposerReferences(value, composerReferenceTokens)
}

function syncComposerReferenceRanges(previous: string, next: string) {
  composerReferenceTokens = syncComposerReferences(previous, next, composerReferenceTokens)
}

function createComposerReferenceElement(reference: ComposerReferenceToken) {
  const token = document.createElement('span')
  const name = reference.kind === 'friend' ? friendReferenceIdentity(reference).name : reference.name
  token.className = `slash-token composer-reference-token ${composerReferenceClass(reference)}`
  token.innerHTML = `${composerReferenceIconSvg(reference, 'slash-token-icon')}<span class="slash-token-label">${escapeHtml(name)}</span>${reference.kind === 'friend' ? `<small class="friend-identity-tag">${escapeHtml(tt('friend_identity_tag'))}</small>` : ''}`
  token.setAttribute('aria-label', name)
  return token
}

// The chip's footprint inside the value is a run of no-break spaces sized to
// the chip's rendered width at insertion time. No-break (not plain) spaces so
// the run is one atomic wrap unit: a breakable run could split across lines
// and desync the two layers' line breaks. The mirror paints the real chip as
// an inline-block of exactly the same pixel width (see
// appendComposerSlashToken), so both layers wrap identically. Any later
// metrics change (the 900px breakpoint swaps the composer font size) re-derives
// the run via refreshSlashCommandPlaceholderWidth.
let slashCommandPlaceholderWidth = 0
let slashPlaceholderFontSig = ''

function composerFontSignature() {
  const cs = getComputedStyle(inputEl)
  return `${cs.fontSize}|${cs.fontWeight}|${cs.fontFamily}`
}

function slashCommandPlaceholder(command: SlashCommandInfo | null | undefined) {
  if (mainComposerControl) return `/${command?.name || ''}`
  const chipWidth = measureSlashCommandTokenWidth(command)
  slashCommandPlaceholderWidth = chipWidth
  slashPlaceholderFontSig = composerFontSignature()
  const spaceWidth = measureComposerText(' ')
  return '\u00A0'.repeat(placeholderCount(chipWidth, spaceWidth))
}

// Re-derive the placeholder run when the composer's text metrics changed since
// insertion. The value edit stays inside the token range, so the ordinary
// range syncs (reference/quote) only shift what follows it.
function refreshSlashCommandPlaceholderWidth() {
  if (mainComposerControl) return
  if (!selectedSlashCommand || !isValidSlashCommandRange(selectedSlashCommandRange)) return
  const sig = composerFontSignature()
  if (sig === slashPlaceholderFontSig) return
  slashPlaceholderFontSig = sig
  const width = measureSlashCommandTokenWidth(selectedSlashCommand)
  if (!width || Math.abs(width - slashCommandPlaceholderWidth) < 0.5) {
    slashCommandPlaceholderWidth = width || slashCommandPlaceholderWidth
    return
  }
  const previous = inputEl.value
  const { start, end } = selectedSlashCommandRange
  const spaceWidth = measureComposerText(' ')
  const count = placeholderCount(width, spaceWidth)
  const delta = count - (end - start)
  const next = previous.slice(0, start) + '\u00A0'.repeat(count) + previous.slice(end)
  slashCommandPlaceholderWidth = width
  selectedSlashCommandRange = { start, end: start + count }
  syncComposerReferenceRanges(previous, next)
  const syncedQuotes = syncInlineQuoteRanges(previous, next, inlineQuoteEntries(pendingFiles, previous))
  if (syncedQuotes.removed.length > 0) {
    forgetInlineQuoteEntries(syncedQuotes.removed)
    renderPreviews()
  }
  const caretStart = mapCaretAroundToken(inputEl.selectionStart ?? next.length, { start, end }, delta)
  const caretEnd = mapCaretAroundToken(inputEl.selectionEnd ?? caretStart, { start, end }, delta)
  setInputValue(next)
  try { inputEl.setSelectionRange(caretStart, caretEnd) } catch {}
}

function setInputValue(value: string) {
  inputEl.value = value
}

function replaceTextRange(value: string, start: number, end: number, replacement: string) {
  return value.slice(0, start) + replacement + value.slice(end)
}

function removeTextRangeWithWhitespace(value: string, range: { start: number; end: number }) {
  let before = value.slice(0, range.start)
  let after = value.slice(range.end)
  if (!before) after = after.replace(/^[ \t]+/, '')
  else if (!after) before = before.replace(/[ \t]+$/, '')
  else if (/[ \t]$/.test(before) && /^[ \t]/.test(after)) {
    before = before.replace(/[ \t]+$/, ' ')
    after = after.replace(/^[ \t]+/, '')
  }
  return { value: before + after, caret: before.length }
}

function adjustPositionAfterRemovedRange(position: number, range: { start: number; end: number }) {
  if (position <= range.start) return position
  if (position >= range.end) return position - (range.end - range.start)
  return range.start
}

function isValidSlashCommandRange(range: { start: number; end: number } | null | undefined, value: string = inputEl.value): range is { start: number; end: number } {
  return !!range &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= value.length
}

function findSlashTrigger(text: string, cursor: number) {
  const query = composerQueryInText(text, cursor)
  return query && query.prefix !== '@' ? query : null
}

function currentComposerQuery() {
  return mainComposerControl ? mainComposerControl.queryAtCaret()
    : composerQueryInText(inputEl.value, inputEl.selectionStart, inputEl.selectionEnd)
}

function currentSlashTrigger() {
  const query = currentComposerQuery()
  return query && query.prefix !== '@' ? query : null
}

// Slash command chip rendered inside a user bubble — mirrors #slash-token in the
// composer so a sent message keeps the same visual identity as the input chip.
const SLASH_PILL_ICON_SVG = slashCommandIconSvg('slash-pill-icon')
const WORKSPACE_FILE_PILL_ICON_SVG = klausIcon('workspace-file-pill')
const WORKSPACE_DIR_PILL_ICON_SVG = klausIcon('workspace-dir-pill')
// Match "/cmd" at a token boundary. Captures (1) the boundary whitespace
// preserved as-is for replacement and (2) the command name.
const SLASH_PILL_TOKEN_RE = /(^|\s)\/([A-Za-z0-9][\w:-]*)(?=\s|$)/

// [垫片] React transcript（src/chat/transcript）经 window 消费 slash/mention
// pill 渲染与图片预览；composer/slash 域迁 React 时随迁收编。
window.renderSlashPillHtml = (name: string, command) => renderSlashPillHtml(name, command)
window.renderWorkspaceMentionPillHtml = (label: string, isDir: boolean) => renderWorkspaceMentionPillHtml(label, isDir)
window.renderComposerReferencePillHtml = (reference: ComposerReferenceToken) => renderComposerReferencePillHtml(reference)
window.openImagePreview = (src, options?: ImagePreviewOptions) => openImagePreview(src, options)
configureImagePreview({
  openTab: image => window.klausOpenWorkspaceImageTab?.(image),
  currentChat: () => window.currentSessionId || '',
  addToChat: async (file, target) => {
    if ((window.currentSessionId || '') !== target) throw new Error(tt('image_composer_changed'))
    addFiles([file])
    inputEl.focus()
  },
})

function slashPillRegexForCommand(command: SlashCommandInfo) {
  const name = String(command?.name || '').trim()
  return name
    ? new RegExp(`(^|\\s)\\/(${escapeRegExp(name)})(?=\\s|$)`, 'i')
    : SLASH_PILL_TOKEN_RE
}

function renderSlashPillHtml(name: string, command: SlashCommandInfo | null = null) {
  const resolvedCommand = resolveSlashCommand(command, name)
  const icon = commandIconSvg(resolvedCommand, 'slash-pill-icon')
  return `<span class="slash-pill ${commandGroupClass(resolvedCommand)}">${icon}<span class="slash-pill-label">${escapeHtml(name)}</span></span>`
}

function sentUserDisplayMetadata(payload: OutgoingPayload | FollowUpQueueItem) {
  const command = payload.sentSlashCommand
  const source = String(command?.source || '').toLowerCase()
  const isSkill = !!command && (command.kind === 'skill' || source.includes('skill'))
  if (!payload.composerDocument && !isSkill && !(payload.pastedCards?.length) && !(payload.composerReferences?.length)
    && !payload.media.some((attachment: any) => attachment.type === 'media')) return undefined
  return {
    displayText: payload.displayText,
    ...(payload.composerDocument ? { composerDocument: payload.composerDocument } : {}),
    attachments: payload.liveAttachments
      .filter((attachment) => attachment.type !== 'image')
      .map((attachment) => ({ type: attachment.type, name: attachment.name, path: attachment.path, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) })),
    pastedCards: payload.pastedCards || [],
    selectedTextAttachments: payload.selectedTextAttachments || [],
    composerReferences: payload.composerReferences || [],
    ...(payload.friendDispatchId ? { friendDispatchId: payload.friendDispatchId } : {}),
    ...(payload.friendIntent ? { friendIntent: payload.friendIntent } : {}),
    ...(payload.friendReplyToMessageId ? { friendReplyToMessageId: payload.friendReplyToMessageId } : {}),
    ...(payload.friendSupplementToRequestId ? { friendSupplementToRequestId: payload.friendSupplementToRequestId } : {}),
    ...(payload.friendQuestionId ? { friendQuestionId: payload.friendQuestionId } : {}),
    ...(payload.friendAnswersRequestId ? { friendAnswersRequestId: payload.friendAnswersRequestId } : {}),
    ...(command ? {
      slashCommand: {
        name: command.name,
        displayName: command.displayName,
        kind: command.kind,
        type: command.type,
        scope: command.scope,
        source: command.source,
      },
    } : {}),
  }
}

function renderWorkspaceMentionPillHtml(label: string, isDir = false) {
  const icon = isDir ? WORKSPACE_DIR_PILL_ICON_SVG : WORKSPACE_FILE_PILL_ICON_SVG
  return `<span class="slash-pill workspace-mention-pill">${icon}<span class="slash-pill-label workspace-mention-pill-label">${escapeHtml(label)}</span></span>`
}

function addWorkspaceComposerMention(node: { rel?: string; path?: string; name?: string; isDir?: boolean }, range: { start: number; end: number } | null = null) {
  const rel = node.rel || workspaceRelativePath(node.path || '') || node.name || '.'
  insertComposerReferenceToken(workspaceReference({ ...node, rel }), range)
}

function updateComposerTokenState() {
  const hasSlashToken = !!selectedSlashCommand && isValidSlashCommandRange(selectedSlashCommandRange)
  const hasInlineQuoteToken = inlineQuoteEntries().length > 0
  const hasReferenceToken = composerReferenceEntries().length > 0
  const hasToken = hasSlashToken || hasInlineQuoteToken || hasReferenceToken
  const hasOverlayToken = !mainComposerControl && (hasSlashToken || hasInlineQuoteToken)
  slashInputLine?.classList.toggle('has-token', hasToken)
  slashInputLine?.classList.toggle('has-slash-token', hasSlashToken && !mainComposerControl)
  slashInputLine?.classList.remove('has-workspace-token')
  slashInputLine?.style.removeProperty('--composer-token-indent')
  composerTokenLayerEl?.classList.toggle('hidden', !hasOverlayToken)
  if (slashInputLine) slashInputLine.style.setProperty('--composer-token-scroll-top', `${inputEl?.scrollTop || 0}px`)
  positionSelectedSlashToken()
}

function syncComposerTokenScroll() {
  slashInputLine?.style.setProperty('--composer-token-scroll-top', `${inputEl?.scrollTop || 0}px`)
  positionSelectedSlashToken()
}

function positionSelectedSlashToken() {
  renderComposerSlashMirror()
}

function normalizeSlashCommandSelection() {
  if (!selectedSlashCommand || !isValidSlashCommandRange(selectedSlashCommandRange)) return false
  const start = inputEl.selectionStart ?? 0
  const end = inputEl.selectionEnd ?? start
  if (start !== end) return false
  if (start <= selectedSlashCommandRange.start || start >= selectedSlashCommandRange.end) return false
  const leftDistance = start - selectedSlashCommandRange.start
  const rightDistance = selectedSlashCommandRange.end - start
  const next = leftDistance < rightDistance ? selectedSlashCommandRange.start : selectedSlashCommandRange.end
  try { inputEl.setSelectionRange(next, next) } catch {}
  return true
}

function normalizeInlineQuoteSelection() {
  const start = inputEl.selectionStart ?? 0
  const end = inputEl.selectionEnd ?? start
  if (start !== end) return false
  for (const entry of inlineQuoteEntries()) {
    const range = entry.range!
    if (start <= range.start || start >= range.end) continue
    const next = start - range.start < range.end - start ? range.start : range.end
    try { inputEl.setSelectionRange(next, next) } catch {}
    return true
  }
  return false
}

function normalizeComposerReferenceSelection() {
  const start = inputEl.selectionStart ?? 0
  const end = inputEl.selectionEnd ?? start
  if (start !== end) return false
  for (const reference of composerReferenceEntries()) {
    if (start <= reference.range.start || start >= reference.range.end) continue
    const next = start - reference.range.start < reference.range.end - start
      ? reference.range.start
      : reference.range.end
    try { inputEl.setSelectionRange(next, next) } catch {}
    return true
  }
  return false
}

function normalizeComposerTokenSelection() {
  return normalizeSlashCommandSelection() || normalizeInlineQuoteSelection() || normalizeComposerReferenceSelection()
}

function appendMirrorTextWithCaret(parent: Node, text: string, globalStart: number, caret: number, options: { includeEnd?: boolean } = {}) {
  const value = String(text || '')
  const globalEnd = globalStart + value.length
  const includeEnd = !!options.includeEnd
  if (caret > globalStart && (caret < globalEnd || (includeEnd && caret === globalEnd))) {
    const offset = caret - globalStart
    if (offset > 0) parent.appendChild(document.createTextNode(value.slice(0, offset)))
    parent.appendChild(createComposerSlashCaret())
    if (offset < value.length) parent.appendChild(document.createTextNode(value.slice(offset)))
  } else if (value) {
    parent.appendChild(document.createTextNode(value))
  }
}

function createComposerSlashCaret() {
  const caret = document.createElement('span')
  caret.className = 'composer-slash-caret'
  caret.setAttribute('aria-hidden', 'true')
  return caret
}

function appendComposerSlashToken(parent: Node) {
  const token = document.createElement('span')
  token.className = `slash-token composer-slash-mirror-token ${commandGroupClass(selectedSlashCommand)}`
  token.innerHTML = composerSlashTokenInnerHtml(selectedSlashCommand)
  // Pin the chip box to the exact pixel width of its placeholder run in the
  // value so the mirror and the (transparent) input wrap at identical points.
  const range = selectedSlashCommandRange
  if (range) {
    const spaceWidth = measureComposerText(' ')
    const runWidth = (range.end - range.start) * spaceWidth
    if (runWidth > 0) token.style.width = `${runWidth}px`
  }
  parent.appendChild(token)
}

function composerSlashTokenInnerHtml(command: SlashCommandInfo | null | undefined) {
  return `<span class="composer-slash-mirror-token-inner">${commandIconSvg(command, 'slash-token-icon')}<span class="slash-token-label">${escapeHtml(slashCommandDisplayName(command))}</span></span>`
}

function appendComposerReferenceToken(parent: Node, reference: ComposerReferenceToken) {
  parent.appendChild(createComposerReferenceElement(reference))
}

function createComposerInlineQuote(entry: PendingFileEntry, onRemove: (entry: PendingFileEntry) => void) {
  const isPasted = entry.kind === 'pasted-text'
  const meta = isPasted ? formatPreviewMeta(entry) : ''
  const token = document.createElement('span')
  token.className = `kls-inline-quote${isPasted ? ' is-pasted' : ''}`
  token.innerHTML = `<span class="kls-inline-quote-content"><span class="kls-attach-chip-icon">${klausIcon(isPasted ? 'pasted-text' : 'quoted-text')}</span><span class="kls-attach-chip-name">${escapeHtml(entry.previewText || pastedTextPreview(entry.text || ''))}</span>${meta ? `<span class="kls-attach-chip-meta">${escapeHtml(meta)}</span>` : ''}</span><button class="kls-inline-quote-remove" type="button" aria-label="${escapeHtml(tt('delete_title'))}">${klausIcon('workdir-clear')}</button>`
  token.querySelector<HTMLButtonElement>('.kls-inline-quote-remove')?.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  token.querySelector<HTMLButtonElement>('.kls-inline-quote-remove')?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onRemove(entry)
  })
  return token
}

function appendComposerInlineQuote(parent: Node, entry: PendingFileEntry) {
  parent.appendChild(createComposerInlineQuote(entry, removeInlineQuote))
}

function removeInlineQuote(entry: PendingFileEntry) {
  const current = pendingFiles.find(candidate => candidate.quoteId === entry.quoteId) || entry
  if (!current.range) return
  const { start, end } = current.range
  mainComposerControl?.replaceRange(start, end, '', 'deleteContentBackward')
  renderPreviews()
  focusComposerInput(inputEl, start)
}

function renderComposerSlashMirror() {
  if (mainComposerControl) { composerSlashMirrorEl?.classList.add('hidden'); return }
  if (!composerSlashMirrorEl) return
  const quoteEntries = inputEl.tagName === 'TEXTAREA' ? inlineQuoteEntries() : []
  const hasSlashToken = !!selectedSlashCommand && isValidSlashCommandRange(selectedSlashCommandRange)
  const hasToken = hasSlashToken || quoteEntries.length > 0
  composerSlashMirrorEl.classList.toggle('hidden', !hasToken)
  slashToken?.classList.add('hidden')
  if (!hasToken) {
    composerSlashMirrorEl.replaceChildren()
    return
  }

  const value = inputEl.value
  const selectionStart = inputEl.selectionStart ?? value.length
  const selectionEnd = inputEl.selectionEnd ?? selectionStart
  const caret = selectionStart === selectionEnd ? selectionStart : -1
  const fragment = document.createDocumentFragment()

  const tokens: Array<{ range: { start: number; end: number }; kind: 'slash' | 'quote' | 'reference'; quote?: PendingFileEntry; reference?: ComposerReferenceToken }> = quoteEntries
    .map(quote => ({ range: quote.range!, kind: 'quote' as const, quote }))
  if (hasSlashToken && selectedSlashCommandRange) tokens.push({ range: selectedSlashCommandRange, kind: 'slash' })
  if (hasSlashToken) {
    tokens.push(...composerReferenceEntries(value).map(reference => ({
      range: reference.range,
      kind: 'reference' as const,
      reference,
    })))
  }
  tokens.sort((a, b) => a.range.start - b.range.start)

  let cursor = 0
  for (const token of tokens) {
    if (token.range.start < cursor) continue
    appendMirrorTextWithCaret(fragment, value.slice(cursor, token.range.start), cursor, caret)
    if (caret === token.range.start) fragment.appendChild(createComposerSlashCaret())
    if (token.kind === 'slash') appendComposerSlashToken(fragment)
    else if (token.kind === 'reference') appendComposerReferenceToken(fragment, token.reference!)
    else appendComposerInlineQuote(fragment, token.quote!)
    if (caret === token.range.end) fragment.appendChild(createComposerSlashCaret())
    cursor = token.range.end
  }
  appendMirrorTextWithCaret(fragment, value.slice(cursor), cursor, caret, { includeEnd: true })

  composerSlashMirrorEl.replaceChildren(fragment)
}

function composedInputDraft() {
  if (mainComposerControl) return { ...composerDraftFromControl(mainComposerControl), friendCompose: { ...friendComposeContext } }
  let args = inputEl.value
  let quoteEntries = inlineQuoteEntries().map(entry => ({ ...entry, range: entry.range ? { ...entry.range } : undefined }))
  let references = composerReferenceEntries(args).map(reference => ({
    ...reference,
    range: { ...reference.range },
  }))
  let slashCommand: SlashCommandInfo | null = null
  let slashRange: { start: number; end: number } | null = null
  if (selectedSlashCommand && isValidSlashCommandRange(selectedSlashCommandRange, args)) {
    const commandText = `/${selectedSlashCommand.name}`
    slashCommand = selectedSlashCommand
    slashRange = {
      start: selectedSlashCommandRange.start,
      end: selectedSlashCommandRange.start + commandText.length,
    }
    const nextArgs = replaceTextRange(args, selectedSlashCommandRange.start, selectedSlashCommandRange.end, commandText)
    quoteEntries = syncInlineQuoteRanges(args, nextArgs, quoteEntries).tokens
    references = syncComposerReferences(args, nextArgs, references)
    args = nextArgs
  }
  const composedQuotes = composeInlineQuotes(args, quoteEntries, false)
  references = references.map(reference => ({
    ...reference,
    range: {
      start: positionAfterRemovingInlineTokens(reference.range.start, quoteEntries),
      end: positionAfterRemovingInlineTokens(reference.range.end, quoteEntries),
    },
  }))
  args = composedQuotes.text
  if (slashRange) {
    const commandLength = slashRange.end - slashRange.start
    const slashStart = positionAfterRemovingInlineTokens(slashRange.start, quoteEntries)
    slashRange = {
      start: slashStart,
      end: slashStart + commandLength,
    }
  }
  return { ...createComposerDraft(args, slashCommand, slashRange, references), friendCompose: { ...friendComposeContext } }
}

function updateInlineQuoteOffsets(text: string) {
  if (mainComposerControl) {
    const serialized = mainComposerControl.serializeSubmission()
    const quotes = serialized.tokens.filter(token => (token.data as { kind?: string })?.kind === 'selected-text')
    for (const [index, quote] of quotes.entries()) {
      const entry = pendingFiles.find(file => file.quoteId === (quote.data as PendingFileEntry).quoteId)
      if (entry) { entry.requestOffset = Math.max(0, Math.min(text.length, quote.start)); entry.displayOrder = index }
    }
    return
  }
  const entries = inlineQuoteEntries()
  let value = inputEl.value
  let positionedEntries = entries.map(entry => ({ ...entry, range: entry.range ? { ...entry.range } : undefined }))
  if (selectedSlashCommand && isValidSlashCommandRange(selectedSlashCommandRange, value)) {
    const nextValue = replaceTextRange(
      value,
      selectedSlashCommandRange.start,
      selectedSlashCommandRange.end,
      `/${selectedSlashCommand.name}`,
    )
    positionedEntries = syncInlineQuoteRanges(value, nextValue, positionedEntries).tokens
    value = nextValue
  }
  composeInlineQuoteSubmission(value, positionedEntries, text)
  const byId = new Map(positionedEntries.map(entry => [entry.quoteId, entry]))
  for (const entry of entries) {
    const quote = byId.get(entry.quoteId)
    if (quote) {
      entry.requestOffset = quote.requestOffset
      entry.displayOrder = quote.displayOrder
    }
  }
}

function updateComposerQuoteOffsets() {
  updateInlineQuoteOffsets(composedInputText())
  for (const entry of inlineQuoteEntries()) {
    if (Number.isInteger(entry.requestOffset)) entry.composerOffset = entry.requestOffset
  }
}

function composedInputText() {
  return composedInputDraft().text
}

function hasComposerText() {
  return composedInputText().trim().length > 0
}

function parseCompactSlashInput(text: string) {
  return parseManualCompactInput(text)
}

function parseProjectInitSlashCommand(text: string) {
  const trimmed = (text || '').trim()
  const match = /^\/(init|init-verifiers)(?=\s|$)/.exec(trimmed)
  return match ? match[1] : null
}

async function setPickedWorkdirForInitCommand(pickPath: string, sessionId: string) {
  const workdir = normalizeProjectWorkdir(pickPath)
  if (!workdir) return false
  if (!sessionId) {
    pendingNewChatWorkdir = workdir
    pendingNewChatProjectRoot = projectIdentityForWorkdir(workdir)
    setActiveProjectWorkdir(workdir, { render: false, refreshWorkdir: false })
    await klausApi.projects?.add?.(workdir).catch((err: unknown) => console.warn('[projects] add failed:', err))
    await refreshProjectWorkspaces({ render: true, refreshWorkdir: true })
    return true
  }

  const result = await klausApi.session.setWorkdir(sessionId, workdir)
  if (result?.error) throw new Error(String(result.error))
  sessions = sessions.map((s) => s.id === sessionId ? { ...s, workdir } : s)
  setActiveProjectWorkdir(workdir, { render: false, refreshWorkdir: false })
  renderSessionList()
  if (sessionId === window.currentSessionId) await refreshWorkdirButton()
  refreshContextStatsThrottled(sessionId, 0)
  return true
}

async function ensureProjectWorkdirForInitCommand(text: string) {
  const commandName = parseProjectInitSlashCommand(text)
  if (!commandName) return true

  const sessionId = window.currentSessionId
  if (!sessionId && draftProjectWorkdir()) return true
  if (sessionId && sessionWorkdir(sessionId)) return true

  try {
    if (sessionId) {
      const info = await klausApi.session.getWorkdir(sessionId)
      if (normalizeProjectWorkdir(info?.custom)) return true
    }
  } catch (err) {
    console.warn('[workdir] init command guard failed to read current workdir:', err)
  }

  const ok = await window.klausDialog.confirm({
    title: tt('workdir_init_guard_title'),
    message: tt(commandName === 'init-verifiers'
      ? 'workdir_init_verifiers_guard_msg'
      : 'workdir_init_guard_msg'),
    confirmText: tt('workdir_init_guard_choose'),
    cancelText: tt('cancel'),
  })
  if (!ok) {
    inputEl.focus()
    return false
  }

  let pick
  try {
    pick = await klausApi.session.pickWorkdir()
  } catch (err) {
    console.warn('[workdir] init command guard pick failed:', err)
    return false
  }
  if (!pick?.path) {
    inputEl.focus()
    return false
  }

  try {
    return await setPickedWorkdirForInitCommand(pick.path, sessionId as string)
  } catch (err) {
    console.warn('[workdir] init command guard set failed:', err)
    await window.klausDialog.alert((err as Error | null)?.message || String(err))
    inputEl.focus()
    return false
  }
}

function renderSelectedSlashCommand() {
  const hasToken = !!selectedSlashCommand && isValidSlashCommandRange(selectedSlashCommandRange)
  slashToken?.classList.toggle('hidden', !hasToken || !!mainComposerControl)
  slashToken?.classList.remove('is-shortcuts-command', 'is-skills-command', 'is-plugins-command', 'is-mcp-command')
  if (slashToken && hasToken) {
    const icon = commandIconSvg(selectedSlashCommand, 'slash-token-icon')
    const currentIcon = slashToken.querySelector('.slash-token-icon')
    if (currentIcon) currentIcon.outerHTML = icon
    else slashToken.insertAdjacentHTML('afterbegin', icon)
    slashToken.classList.add(commandGroupClass(selectedSlashCommand))
  }
  if (slashTokenLabel) slashTokenLabel.textContent = hasToken ? slashCommandDisplayName(selectedSlashCommand) : ''
  updateComposerTokenState()
}

function focusComposerInputAfterSlashInsert() {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
  try { inputEl.focus({ preventScroll: true }) } catch { inputEl.focus() }
  renderSelectedSlashCommand()
  requestAnimationFrame(() => {
    // Later keyboard or pointer focus takes precedence over deferred insertion work.
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
    if (document.activeElement !== inputEl) return
    try { inputEl.focus({ preventScroll: true }) } catch { inputEl.focus() }
    normalizeSlashCommandSelection()
    renderSelectedSlashCommand()
  })
}

function clearSelectedSlashCommand() {
  if (selectedSlashCommand && isValidSlashCommandRange(selectedSlashCommandRange)) {
    const previous = inputEl.value
    const removed = removeTextRangeWithWhitespace(inputEl.value, selectedSlashCommandRange)
    const synced = syncInlineQuoteRanges(previous, removed.value, inlineQuoteEntries())
    if (synced.removed.length > 0) pendingFiles = pendingFiles.filter(entry => !synced.removed.includes(entry))
    syncComposerReferenceRanges(previous, removed.value)
    setInputValue(removed.value)
    const caret = Math.min(removed.caret, removed.value.length)
    try { inputEl.setSelectionRange(caret, caret) } catch {}
  }
  selectedSlashCommand = null
  selectedSlashCommandRange = null
  renderSelectedSlashCommand()
}

function insertSlashCommandToken(command: SlashCommandInfo, triggerRange: { start: number; end: number } | null = null) {
  if (!command) return
  if (isSkillCommand(command)) {
    cacheSlashCommand(command)
    insertComposerReferenceToken(skillReference(command, slashCommandDisplayName(command)), triggerRange)
    return
  }
  let value = inputEl.value
  let selectionStart = inputEl.selectionStart ?? value.length
  let selectionEnd = inputEl.selectionEnd ?? selectionStart
  let removedRange: { start: number; end: number } | null = null
  if (selectedSlashCommand && isValidSlashCommandRange(selectedSlashCommandRange, value)) {
    const previousValue = value
    const previousRange = { ...selectedSlashCommandRange }
    const removed = removeTextRangeWithWhitespace(value, previousRange)
    const previousValueBeforeRemoval = value
    value = removed.value
    // Removal also trims the whitespace around the placeholder, so derive the
    // exact deleted span by common prefix/suffix instead of assuming the range.
    let delStart = 0
    const minLen = Math.min(previousValueBeforeRemoval.length, value.length)
    while (delStart < minLen && previousValueBeforeRemoval[delStart] === value[delStart]) delStart++
    let delEnd = previousValueBeforeRemoval.length
    let nextEnd = value.length
    while (delEnd > delStart && nextEnd > delStart && previousValueBeforeRemoval[delEnd - 1] === value[nextEnd - 1]) { delEnd--; nextEnd-- }
    removedRange = { start: delStart, end: delEnd }
    selectionStart = adjustPositionAfterRemovedRange(selectionStart, previousRange)
    selectionEnd = adjustPositionAfterRemovedRange(selectionEnd, previousRange)
    selectedSlashCommand = null
    selectedSlashCommandRange = null
    syncComposerReferenceRanges(previousValue, value)
    setInputValue(value)
    try { inputEl.setSelectionRange(selectionStart, selectionEnd) } catch {}
    renderSelectedSlashCommand()
  }
  cacheSlashCommand(command)

  // Replacing an existing chip shifts the draft: a trigger range captured
  // before the removal must move with the text or the new chip lands where
  // the old placeholder used to be.
  let adjustedTrigger = triggerRange
  if (removedRange && triggerRange) {
    adjustedTrigger = {
      start: shiftPositionAfterRemoval(triggerRange.start, removedRange),
      end: shiftPositionAfterRemoval(triggerRange.end, removedRange),
    }
  }
  const start = adjustedTrigger?.start ?? selectionStart
  const end = adjustedTrigger?.end ?? selectionEnd
  const prefix = value.slice(0, start)
  const suffix = value.slice(end)
  const leading = adjustedTrigger ? '' : (prefix && !/\s$/.test(prefix) ? ' ' : '')
  const trailing = suffix && !/^\s/.test(suffix) ? ' ' : (suffix ? '' : ' ')
  const placeholder = slashCommandPlaceholder(command)
  const replacement = `${leading}${placeholder}${trailing}`
  const rangeStart = start + leading.length
  const rangeEnd = rangeStart + placeholder.length
  const next = prefix + replacement + suffix
  const syncedQuotes = syncInlineQuoteRanges(value, next, inlineQuoteEntries())
  forgetInlineQuoteEntries(syncedQuotes.removed)
  syncComposerReferenceRanges(value, next)

  selectedSlashCommand = command
  selectedSlashCommandRange = { start: rangeStart, end: rangeEnd }
  if (mainComposerControl) mainComposerControl.replaceRange(start, end, replacement, 'insertText')
  else setInputValue(next)
  const caret = rangeEnd + trailing.length
  try { inputEl.setSelectionRange(caret, caret) } catch {}
  renderSelectedSlashCommand()
  autoResize()
  updateSendBtn()
  persistComposerDraft()
  void refreshSelectedSlashCommand()
}

function syncSlashCommandRangeAfterInput(prevValue: string, nextValue: string) {
  if (!selectedSlashCommand || !isValidSlashCommandRange(selectedSlashCommandRange, prevValue)) return
  if (prevValue === nextValue) return

  let prefixLen = 0
  const minLen = Math.min(prevValue.length, nextValue.length)
  while (prefixLen < minLen && prevValue[prefixLen] === nextValue[prefixLen]) prefixLen++

  let prevSuffix = prevValue.length - 1
  let nextSuffix = nextValue.length - 1
  while (
    prevSuffix >= prefixLen &&
    nextSuffix >= prefixLen &&
    prevValue[prevSuffix] === nextValue[nextSuffix]
  ) {
    prevSuffix--
    nextSuffix--
  }

  const oldChangeStart = prefixLen
  const oldChangeEnd = prevSuffix + 1
  const newChangeEnd = nextSuffix + 1
  const delta = (newChangeEnd - oldChangeStart) - (oldChangeEnd - oldChangeStart)

  if (oldChangeEnd <= selectedSlashCommandRange.start) {
    selectedSlashCommandRange = {
      start: selectedSlashCommandRange.start + delta,
      end: selectedSlashCommandRange.end + delta,
    }
  } else if (oldChangeStart >= selectedSlashCommandRange.end) {
    return
  } else {
    selectedSlashCommand = null
    selectedSlashCommandRange = null
  }
}

function syncComposerTokenRangesAfterInput(previous: string, next: string) {
  syncComposerReferenceRanges(previous, next)
  syncSlashCommandRangeAfterInput(previous, next)
}

function syncSlashCommandRangeAfterReplace(start: number, end: number, replacementLength: number) {
  if (!selectedSlashCommand || !selectedSlashCommandRange) return
  const delta = replacementLength - (end - start)
  if (end <= selectedSlashCommandRange.start) {
    selectedSlashCommandRange = {
      start: selectedSlashCommandRange.start + delta,
      end: selectedSlashCommandRange.end + delta,
    }
  } else if (start < selectedSlashCommandRange.end && end > selectedSlashCommandRange.start) {
    selectedSlashCommand = null
    selectedSlashCommandRange = null
  }
}

// [垫片] React 欢迎屏 chips 经 window 调用；composer 域迁 React 时随迁收编。
window.setComposerText = setComposerText
function setComposerText(value: ComposerDraft | string) {
  selectedSlashCommand = null
  selectedSlashCommandRange = null
  composerReferenceTokens = []
  const draft = migrateSkillDraft(reconcileSlashDraft(value, slashCatalog.snapshot(slashCatalogScope())))
  friendComposeContext = draft.friendCompose ? { ...draft.friendCompose } : { intent: 'request' }
  if (draft.document && mainComposerControl?.restoreDocument(draft.document)) {
    renderSelectedSlashCommand()
    if (selectedSlashCommand) void refreshSelectedSlashCommand()
    return
  }
  const selected = selectedSlashCommandFromDraft(draft)
  selectedSlashCommand = selected?.command || null
  selectedSlashCommandRange = selected?.range || null
  composerReferenceTokens = normalizeComposerReferences(draft.text, [...draft.references, ...workspaceReferencesIn(draft.text)])
  if (mainComposerControl) mainComposerControl.restoreText(draft.text)
  else setInputValue(draft.text)
  renderSelectedSlashCommand()
  mainComposerControl?.resetHistory()
  if (selectedSlashCommand) void refreshSelectedSlashCommand()
}

function setSlashCommandDraft(command: SlashCommandInfo, text: string = '') {
  selectedSlashCommand = null
  selectedSlashCommandRange = null
  composerReferenceTokens = []
  setInputValue(text || '')
  // 芯片插在最前（设计稿顺序：[命令芯片] 种子文案…），插完再把光标移到末尾接着输入。
  try { inputEl.setSelectionRange(0, 0) } catch {}
  insertSlashCommandToken(command || null)
  try { inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length) } catch {}
  autoResize()
  updateSendBtn()
  persistComposerDraft()
}

function insertComposerReferenceToken(
  reference: Omit<ComposerReferenceToken, 'range'>,
  triggerRange: { start: number; end: number } | null = null,
) {
  const value = inputEl.value || ''
  const selectionStart = inputEl.selectionStart ?? value.length
  const selectionEnd = inputEl.selectionEnd ?? selectionStart
  const start = triggerRange?.start ?? selectionStart
  const end = triggerRange?.end ?? selectionEnd
  const inserted = replaceComposerReferenceRange(value, start, end, '', reference)
  syncComposerTokenRangesAfterInput(value, inserted.text)
  const syncedQuotes = syncInlineQuoteRanges(value, inserted.text, inlineQuoteEntries())
  forgetInlineQuoteEntries(syncedQuotes.removed)
  composerReferenceTokens = normalizeComposerReferences(inserted.text, [...composerReferenceTokens, inserted.reference])
  const replacement = inserted.text.slice(start, inserted.text.length - value.length + end)
  if (mainComposerControl) mainComposerControl.replaceRange(start, end, replacement, 'insertText')
  else setInputValue(inserted.text)
  try { inputEl.setSelectionRange(inserted.caret, inserted.caret) } catch {}
  renderSelectedSlashCommand()
  autoResize()
  updateSendBtn()
  persistComposerDraft()
}

window.klausComposer = {
  ...(window.klausComposer || {}),
  setText(text) {
    setComposerText(text || '')
    autoResize()
    updateSendBtn()
    persistComposerDraft()
    inputEl.focus()
  },
  // Programmatic send for host-owned entry points (plugin failure diagnosis):
  // place the query, then run the ordinary submit path so queueing, goals and
  // friend-compose guards behave exactly like a typed message.
  async submit(text?: string) {
    if (typeof text === 'string') {
      setComposerText(text)
      autoResize()
      updateSendBtn()
      persistComposerDraft()
    }
    await send()
  },
  appendReviewFeedback(text: string, sessionId: string): boolean {
    if (window.currentSessionId !== sessionId || !text.trim()) return false
    const existing = inputEl.value || ''
    const addition = (existing ? '\n\n' : '') + text
    if (mainComposerControl) mainComposerControl.replaceRange(existing.length, existing.length, addition, 'insertText')
    else {
      inputEl.value = existing + addition
      inputEl.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: addition, bubbles: true }))
    }
    autoResize()
    updateSendBtn()
    persistComposerDraft()
    inputEl.focus()
    return true
  },
  setSlashCommandDraft(command, text = '') {
    setSlashCommandDraft(command, text)
    inputEl.dispatchEvent(new Event('input'))
    inputEl.focus()
  },
  startNewChat(options: { workdir?: string | null; workspaceId?: string | null } = {}) {
    newChat(options)
  },
  insertReference(reference) {
    const kind = reference?.kind === 'plugin' ? 'plugin' : 'agent'
    const name = String(reference?.name || '').trim()
    if (!name) return
    if (reference?.replaceDraft) setComposerText('')
    insertComposerReferenceToken({
      kind,
      name,
      value: String(reference?.value || (kind === 'agent' ? `@agent-${name}` : `@${name}`)),
      source: reference?.source || (kind === 'plugin' ? 'plugin' : 'configured'),
      ...(reference?.id ? { id: String(reference.id) } : {}),
      ...(Number.isInteger(reference?.avatarId) ? { avatarId: Number(reference.avatarId) } : {}),
      ...(reference?.agentStatus ? { agentStatus: String(reference.agentStatus) } : {}),
    })
    inputEl.dispatchEvent(new Event('input'))
    inputEl.focus()
  },
}

slashToken?.addEventListener('click', () => {
  clearSelectedSlashCommand()
  persistComposerDraft()
  autoResize()
  updateSendBtn()
  inputEl.focus()
})

// Markdown 渲染管线已迁 src/chat/markdown.ts（独立 Marked 实例 + KaTeX 扩展
// + hljs + LRU 记忆化），本文件经 import 消费 renderMarkdownHtml。

// --- Init ---
let sidebarScrollHideTimer = 0

function initSidebarScrollbars() {
  const scroller = document.querySelector('.sidebar-scroll')
  if (!scroller || (scroller as HTMLElement).dataset.scrollbarInitialized === '1') return
  ;(scroller as HTMLElement).dataset.scrollbarInitialized = '1'
  scroller.addEventListener('scroll', () => {
    scroller.classList.add('is-scrolling')
    window.clearTimeout(sidebarScrollHideTimer)
    sidebarScrollHideTimer = window.setTimeout(() => {
      scroller.classList.remove('is-scrolling')
    }, 650)
  }, { passive: true })
}

function updateSidebarToggleState() {
  document.getElementById('sidebar')?.classList.toggle('collapsed', sidebarCollapsed)
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed)
  const toggle = document.getElementById('sidebar-toggle')
  toggle?.setAttribute('aria-expanded', sidebarCollapsed ? 'false' : 'true')
  // Glyph swap (expanded vs collapsed) is pure CSS on body.sidebar-collapsed —
  // see .sidebar-toggle rules in styles.css.
}

async function init() {
  // Sidebar collapse state
  updateSidebarToggleState()
  initSidebarScrollbars()
  initSideComposer()

  const initialSessions = await readSessionSnapshot()
  if (initialSessions) {
    sessions = initialSessions
    syncSidebarWorkingFromSessions(sessions, { reconcileRuntime: true })
  }
  // One unconditional audit after boot: a window restored over sessions whose
  // turns the host recovered in the background may have missed every lifecycle
  // frame, and with no running state of its own nothing else would ever read
  // the host's working registry again. The audit's own gate then keeps polling
  // only while some session is working on either side.
  scheduleSessionRuntimeAudit({ once: true })
  await refreshProjectWorkspaces({ render: false, refreshWorkdir: false })
  // Friendship folder names must resolve before the first sidebar paint, or a
  // cold start briefly files friend conversations under their raw id.
  await refreshFriendDirectory()
  // Kick off cron sidebar load in parallel — it renders the pinned "定时任务"
  // group above the flat session list. Non-blocking: renderSessionList() runs
  // now with an empty cronTasks, then re-renders once tasks arrive.
  refreshCronTasksForSidebar()
  renderSessionList()
  if (typeof window.bootstrapProfile === 'function') window.bootstrapProfile()
  // 启动落在"虚拟新对话"状态而不是自动续上次 session。
  // currentSessionId = null + welcome 屏，sidebar 不高亮任何项；用户点击具体
  // session 才进入历史，发送第一条消息时 send() 会 lazy 创建实体。
  enterNewChatState()

  // A renderer reload has no live running-state cache. Recover all known
  // sessions so background requests regain their badge before being opened.
  for (const session of sessions) void restorePendingPermissions(session.id)

  if (!externalImportRefreshBound) {
    externalImportRefreshBound = true
    window.addEventListener('klaus:external-import-complete', async () => {
      await updateSessionInList({ reorder: true })
    })
  }
  window.setTimeout(() => {
    if (typeof window.maybeShowExternalAgentImportOnboarding === 'function') {
      window.maybeShowExternalAgentImportOnboarding()
    }
    // Feature discovery (upgrade card / walkthroughs) starts after
    // the window state above has been restored, so a panel that comes back open
    // is not mistaken for the user having just arrived at it. Non-blocking and
    // self-suppressing: the card yields to the import overlay if that one won.
    void bootFeatureOnboarding()
  }, 250)

  // Re-run dynamic renders on language switch. applyI18n() in i18n.js only
  // refreshes static [data-i18n] nodes; anything built via innerHTML (the
  // sidebar, auth pill, cron banner, channel badges, …) stays stuck at the
  // tt() value from when it was last rendered. setLanguage() dispatches
  // this event so listeners can re-resolve their labels.
  window.addEventListener('klaus:lang-change', () => {
    renderSessionList()
    renderCronChannelBanner(window.currentSessionId || '')
    refreshWorkdirButton()  // re-translate the default-state pill label
    refreshComposerSelectorTranslations()
    updateTeammateBanner()
    renderSelectedSlashCommand()
    syncSidebarToolbar()  // header controls re-resolve their aria-labels
    // The @ menu is not re-run here: it is a React island that subscribes to
    // language changes via useT and re-resolves every label from its i18n keys
    // on the re-render. (The old imperative getters built labels with tt() at
    // construction time, so they needed this manual re-run; the component does
    // not. Verified by the language-switch harness case.)
  })
}

// 认证模式 pill 与切换菜单已迁 React 岛（src/chat/auth-pill.tsx），
// pill 自行订阅 auth-mode-changed / models-changed / 语言切换重渲。
// 设置页切了 auth_mode / 登录 / 登出后触发这两个事件刷新输入区模型选择。
window.addEventListener('klaus:auth-mode-changed', () => {
  composerPredictions?.invalidate()
  invalidateComposerPreferenceReads()
  void refreshComposerPreferences()
  void refreshSideComposerModel()
})
window.addEventListener('klaus:models-changed', () => {
  composerPredictions?.invalidate()
  invalidateComposerPreferenceReads()
  void refreshComposerPreferences()
  void refreshSideComposerModel()
})
// 欢迎屏问候语/示例 chips 已迁 React 岛（src/chat/welcome.tsx），useT 自行语言重渲。

// ==================== Sessions ====================

// Channel prefix → short label key (mirrors Web 端 web-ui-chat-js.ts:176-181).
// When a session id carries one of these prefixes it was created by an external
// channel plugin; show the channel badge in the sidebar so users can tell.
const CHANNEL_PREFIXES = ['feishu', 'dingtalk', 'wechat', 'wecom', 'qq', 'telegram', 'discord', 'whatsapp']
function detectChannelPrefix(sessionId: string) {
  for (const p of CHANNEL_PREFIXES) if (sessionId.startsWith(p + ':')) return p
  return null
}

function normalizeProjectWorkdir(workdir: string | null | undefined) {
  return typeof workdir === 'string' && workdir.trim() ? workdir : null
}

function setActiveProjectWorkdir(workdir: string | null, options: { render?: boolean; refreshWorkdir?: boolean } = {}) {
  // A managed worktree is never a project identity: activating one selects its
  // origin repository instead of registering the scratch directory.
  const next = projectIdentityForWorkdir(normalizeProjectWorkdir(workdir))
  if (activeProjectWorkdir === next) {
    if (next && !projectRoots.includes(next)) projectRoots = [next, ...projectRoots]
    if (options.render !== false) renderSessionList()
    if (options.refreshWorkdir !== false) refreshWorkdirButton()
    return
  }
  const previous = activeProjectWorkdir
  activeProjectWorkdir = next
  if (next && !projectRoots.includes(next)) projectRoots = [next, ...projectRoots]
  if (next) persistLocalValue(ACTIVE_PROJECT_WORKDIR_KEY, next)
  else removeLocalValue(ACTIVE_PROJECT_WORKDIR_KEY)
  void klausApi.projects?.setActive?.(next).then((result: { error?: string } | null | undefined) => {
    if (result?.error) throw new Error(result.error)
  }).catch((error: unknown) => {
    if (activeProjectWorkdir !== next) return
    activeProjectWorkdir = previous
    if (previous) persistLocalValue(ACTIVE_PROJECT_WORKDIR_KEY, previous)
    else removeLocalValue(ACTIVE_PROJECT_WORKDIR_KEY)
    renderSessionList()
    refreshWorkdirButton()
    showToast(`${tt('project_active_save_failed')}: ${(error as Error | null)?.message || String(error)}`)
  })
  if (options.render !== false) renderSessionList()
  if (options.refreshWorkdir !== false) refreshWorkdirButton()
}

async function refreshProjectWorkspaces(options: { render?: boolean; refreshWorkdir?: boolean } = {}) {
  if (!klausApi.projects?.list) return
  try {
    const state = await klausApi.projects.list()
    const roots = Array.isArray(state?.roots)
      ? state.roots.map((root: string | { path?: string }) => typeof root === 'string' ? root : root?.path).filter((r: string | undefined): r is string => !!r)
      : []
    projectRoots = [...new Set<string>(roots)]
    projectLabels = state?.labels && typeof state.labels === 'object' ? state.labels : {}
    // The host's order row is authoritative, but a drag that landed while this
    // read was in flight has a newer revision and must not be overwritten by the
    // older answer.
    const orderRevision = sidebarProjectOrderRevision
    const storedOrder = parseStoredOrder((state as { sidebarOrder?: unknown })?.sidebarOrder)
    if (storedOrder.length > 0 && mayApplyAsyncState(orderRevision, sidebarProjectOrderRevision) && sidebarProjectOrderPending === null) {
      if (JSON.stringify(storedOrder) !== JSON.stringify(sidebarProjectOrder)) {
        sidebarProjectOrder = storedOrder
        persistLocalValue(SIDEBAR_PROJECT_ORDER_MIRROR_KEY, JSON.stringify(storedOrder))
      }
    }
    // Load the multi-folder workspace registry alongside the flat project list;
    // both feed the sidebar's project tab and the project picker.
    try {
      const wsState = await klausApi.workspaces?.list?.()
      const list = Array.isArray(wsState?.workspaces) ? wsState.workspaces : []
      projectWorkspaces = list
        .map((w: { id?: string; name?: string; roots?: string[] }) => ({
          id: String(w?.id || ''),
          name: String(w?.name || ''),
          roots: Array.isArray(w?.roots) ? w!.roots!.filter((r): r is string => typeof r === 'string') : [],
        }))
        .filter((w: { id: string; roots: string[] }) => !!w.id && w.roots.length > 0)
    } catch (err) {
      console.warn('[workspaces] refresh failed:', err)
    }
    const nextActive = normalizeProjectWorkdir(state?.activeRoot)
    if (nextActive !== activeProjectWorkdir) {
      activeProjectWorkdir = nextActive
      if (nextActive) persistLocalValue(ACTIVE_PROJECT_WORKDIR_KEY, nextActive)
      else removeLocalValue(ACTIVE_PROJECT_WORKDIR_KEY)
    }
    if (options.render !== false) renderSessionList()
    if (options.refreshWorkdir !== false) refreshWorkdirButton()
  } catch (err) {
    console.warn('[projects] refresh failed:', err)
  }
}

function sessionWorkdir(sessionId: string) {
  return normalizeProjectWorkdir(findKnownSession(sessionId)?.workdir)
}

function findKnownSession(sessionId: string | null) {
  return sessions.find((s) => s.id === sessionId)
    || archivedSessions.find((s) => s.id === sessionId)
    || window.KlausSideTasks?.find(sessionId)
    || null
}

// ==================== multi-folder workspaces ====================
// A workspace groups >=1 project roots under a name. Sidebar containers and the
// thread-list open-state Sets key a workspace by `ws:<id>` so it never collides
// with the bare project sharing its primary root.
const WORKSPACE_KEY_PREFIX = 'ws:'
function isWorkspaceStateKey(key: string | null): key is string {
  return typeof key === 'string' && key.startsWith(WORKSPACE_KEY_PREFIX)
}
function workspaceContainerKey(id: string) {
  return `${WORKSPACE_KEY_PREFIX}${id}`
}
function workspaceIdFromKey(key: string | null) {
  return isWorkspaceStateKey(key) ? key.slice(WORKSPACE_KEY_PREFIX.length) : null
}
// The thread-list open-state helpers accept EITHER a project workdir or a
// `ws:<id>` container key: workspace keys pass through opaque, project workdirs
// normalize as before. This keeps one set of open/expand/collapse machinery for
// both container kinds.
function projectStateKey(workdirOrKey: string | null): string | null {
  if (isWorkspaceStateKey(workdirOrKey)) return workdirOrKey
  if (isFriendStateKey(workdirOrKey)) return workdirOrKey
  return normalizeProjectWorkdir(workdirOrKey)
}
function workspaceById(id: string | null) {
  return id ? projectWorkspaces.find((w) => w.id === id) || null : null
}
function workspacePrimaryRoot(id: string | null) {
  const ws = workspaceById(id)
  return ws && ws.roots.length ? normalizeProjectWorkdir(ws.roots[0]) : null
}
// The workspace the current conversation is (or, for a new chat, would be) bound
// to. Existing sessions read their persisted binding; a new chat reads the draft.
function currentEditableWorkspaceId(): string | null {
  if (window.currentSessionId) return findKnownSession(window.currentSessionId)?.workspaceId ?? null
  return pendingNewChatWorkspaceId
}
function workspaceConversationSessions(id: string) {
  // A friend task conversation keeps its workspace binding (the approval chose
  // the execution location) but is filed under its friendship, exactly like a
  // friend conversation with a project target never lists under that project:
  // one conversation, one group.
  return groupedLocalSessions().filter((session) => (session.workspaceId ?? null) === id && !session.friendGroupId)
}

// ==================== friend groups ====================
// A friend task conversation belongs to its friendship: the group key is the
// friendship id (names repeat and change, the friendship row does not), and the
// display name is the owner's remark, else the friend's display name. Every
// conversation of one friend lands in that one group, whatever execution
// location its task approvals chose.
const FRIEND_GROUP_KEY_PREFIX = 'friend:'
function isFriendStateKey(key: string | null): key is string {
  return typeof key === 'string' && key.startsWith(FRIEND_GROUP_KEY_PREFIX)
}
function friendGroupKey(friendshipId: string) {
  return FRIEND_GROUP_KEY_PREFIX + friendshipId
}
function friendshipIdFromKey(key: string | null): string | null {
  return isFriendStateKey(key) ? key.slice(FRIEND_GROUP_KEY_PREFIX.length) : null
}
let friendDirectory: Array<{ id: string; userId?: string; name: string; avatarUrl?: string | null }> = []
;(window as any).getFriendDirectoryEntry = (friendshipId?: string, userId?: string) => friendDirectory.find(row => friendshipId ? row.id === friendshipId : !!userId && row.userId === userId)
function friendDirectoryName(friendshipId: string): string {
  // A friendship this account cannot resolve (removed, or left over from an
  // earlier login on this machine) still owns its local conversations, so the
  // group stays reachable under a localized placeholder instead of leaking the
  // raw friendship id into the sidebar.
  return friendDirectory.find(row => row.id === friendshipId)?.name || tt('sidebar_friend_unknown') || 'Unknown friend'
}
async function refreshFriendDirectory(): Promise<void> {
  try {
    const snapshot = await klausApi.friends?.list?.()
    const rows = Array.isArray(snapshot?.friends) ? snapshot.friends : []
    friendDirectory = rows
      .filter((row: { id?: string; status?: string }) => row?.id && row.status === 'accepted')
      .map((row: { id: string; userId?: string; displayName?: string; remark?: string; email?: string; avatarUrl?: string | null }) => ({ id: row.id, userId: row.userId, name: friendDisplayName(row), avatarUrl: row.avatarUrl }))
    void klausApi.friends.runtime?.().then(updateFriendsRuntime).catch(() => {})
  } catch { friendDirectory = [] }
}
function friendConversationSessions(friendshipId: string) {
  return groupedLocalSessions().filter((session) => session.friendGroupId === friendshipId)
}
function friendRowsForSidebar() {
  const groups = new Map<string, { id: string; name: string; updatedAt: number }>()
  for (const session of groupedLocalSessions()) {
    const id = session.friendGroupId
    if (!id) continue
    // Only a friendship of the signed-in account owns a sidebar group: the
    // directory is that account's accepted-friend ledger, so conversations
    // left over from another login stay out of this sidebar entirely. Every
    // other bucket skips friend-bound sessions, so hiding the group hides its
    // conversations here too, without deleting anything.
    if (!friendDirectory.some(row => row.id === id)) continue
    const existing = groups.get(id) ?? { id, name: friendDirectoryName(id), updatedAt: 0 }
    existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt || 0)
    groups.set(id, existing)
  }
  // A friendship without any conversation shows no folder: the group appears
  // with the friend's first task, like a project appears with its first chat.
  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

/** Attention count painted on a friend group row: requests this computer still
 *  owes a decision, plus group conversations holding unread friend messages. A
 *  parked request conversation counts once, through its request, so approving
 *  or rejecting clears the number without touching the unread ledger. */
function friendGroupAttentionCount(friendshipId: string): number {
  const pending = (friendInboxSnapshot()?.tasks || []).filter(task => task.friendId === friendshipId && task.status === 'pending')
  const parked = new Set(pending.map(task => task.threadId).filter((thread): thread is string => !!thread))
  const unread = friendConversationSessions(friendshipId).filter(session => !parked.has(session.id) && sharedFriendUnread().countOf(session.id) > 0)
  return pending.length + unread.length
}

function projectRowsFromSessions() {
  const projects = new Map<string, { workdir: string; name: string; updatedAt: number }>()
  const pushProject = (workdir: string | null | undefined, session: SessionInfo | null = null) => {
    const key = normalizeProjectWorkdir(workdir)
    if (!key) return
    const existing = projects.get(key) || {
      workdir: key,
      name: projectLabels[key] || basenameOf(key) || key,
      updatedAt: 0,
    }
    if (session) {
      existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt || 0)
    }
    projects.set(key, existing)
  }
  for (const root of projectRoots) pushProject(root)
  for (const session of sessions) {
    if (detectChannelPrefix(session.id)) continue
    // Group by project membership, not by the directory the session runs in:
    // a worktree session lands under its origin project.
    pushProject(sessionProjectKey(session), session)
  }
  const rank = new Map(projectRoots.map((root, index: number) => [root, index]))
  return [...projects.values()].sort((a, b) => {
    const ar = rank.get(a.workdir)
    const br = rank.get(b.workdir)
    if (ar !== undefined && br !== undefined) return ar - br
    if (ar !== undefined) return -1
    if (br !== undefined) return 1
    return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)
  })
}

function regularLocalSessions() {
  return sessions.filter((session) => !detectChannelPrefix(session.id))
}

function groupedLocalSessions() {
  return regularLocalSessions().filter((session) => !isPinnedSession(session))
}

function selectedProjectWorkdir() {
  if (currentNonChatView) return null
  if (window.currentSessionId) return sessionWorkdir(window.currentSessionId)
  return normalizeProjectWorkdir(pendingNewChatWorkdir) || normalizeProjectWorkdir(activeProjectWorkdir)
}

function draftProjectWorkdir() {
  return normalizeProjectWorkdir(pendingNewChatWorkdir)
}

function currentEditableProjectWorkdir() {
  return window.currentSessionId ? sessionWorkdir(window.currentSessionId) : draftProjectWorkdir()
}

function canEditProjectForCurrentConversation() {
  if (!window.currentSessionId) return true
  if (isDraftOnlySession(window.currentSessionId)) return true
  // A friend task conversation belongs to its friendship; its home is not the
  // owner's to rebind mid-conversation.
  if (findKnownSession(window.currentSessionId)?.friendGroupId) return false
  // 运行中的会话必然已有消息，不依赖瞬时 attr/列表直接判锁定。
  if (runningSessions.has(window.currentSessionId)) return false
  const hasMessagesAttr = btnWorkdir?.getAttribute('data-has-messages')
  if (hasMessagesAttr === '1') return false
  // 当前在看的会话：转录 DOM 就是最直接的证据。这同时覆盖 sessions
  // 列表尚未包含该会话的入口（deep link/cron 运行行/boot 时序）——
  // 之前未知会话一律按可编辑处理，会让已开始会话的「运行于」行
  // 错误地保持显示。
  const transcriptContent = messagesEl.querySelector(':scope > [data-klaus-transcript-content]') || messagesEl
  if (transcriptContent.childNodes.length > 0) return false
  const session = sessions.find((s) => s.id === window.currentSessionId)
  return session ? sessionMessagePresence(session) === 'empty' : false
}

function newChatTargetFromCurrentSelection(): { workdir: string | null; workspaceId?: string | null } {
  if (currentNonChatView) return { workdir: null }
  if (window.currentSessionId) {
    const session = findKnownSession(window.currentSessionId)
    // A friend task conversation lives in its friendship's scratch home, which
    // is not a project identity: a new chat drafted from it starts untargeted
    // instead of inheriting the scratch directory as its run location.
    if (session?.friendGroupId) return { workdir: null }
    return {
      workdir: sessionWorkdir(window.currentSessionId),
      ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}),
    }
  }
  return {
    workdir: draftProjectWorkdir(),
    ...(pendingNewChatWorkspaceId ? { workspaceId: pendingNewChatWorkspaceId } : {}),
  }
}

function projectlessConversationSessions() {
  return groupedLocalSessions().filter((session) => !normalizeProjectWorkdir(session.workdir) && !session.workspaceId && !session.friendGroupId)
}

function projectConversationSessions(workdir: string | null) {
  const selected = normalizeProjectWorkdir(workdir)
  if (!selected) return []
  // A workspace-bound session lives under its workspace container, never under
  // the bare project of its primary root — exclude it here so it is not listed
  // twice. Worktree sessions file under their origin project via membership.
  return groupedLocalSessions().filter((session) => sessionProjectKey(session) === selected)
}

function persistExpandedProjectThreadLists() {
  persistLocalValue(PROJECT_THREAD_EXPANDED_KEY, JSON.stringify([...expandedProjectThreadLists]))
}

// --- project group open/closed state -------------------------------------
//
// Tri-state, read from `sidebarProjectExpansion`. Only an explicit `false`
// collapses a group; a missing key means "never set" and renders open. That
// distinction is load-bearing: the reveal logic must not force open a group the
// user deliberately folded, but must still open one nobody has touched.
// Storage shape: `atom('sidebar-project-expanded-v1-'+id) === false`.

function isProjectThreadListOpen(workdir: string | null) {
  const key = projectStateKey(workdir)
  return !!key && isProjectOpen(readProjectExpansion(sidebarProjectExpansion, key))
}

/** Set a group open/closed. `open=true` records an explicit choice rather than
 *  deleting the key. */
function setProjectThreadListOpen(workdir: string | null, open: boolean) {
  const key = projectStateKey(workdir)
  if (!key) return
  if (readProjectExpansion(sidebarProjectExpansion, key) === open) return
  commitProjectExpansion(key, open)
}

/** Drop every trace of a project's collapse choice (project removal). */
function forgetProjectThreadListState(workdirOrKey: string | null) {
  const key = projectStateKey(workdirOrKey)
  if (!key) return
  expandedProjectThreadLists.delete(key)
  projectThreadPages.delete(key)
  persistExpandedProjectThreadLists()
  if (readProjectExpansion(sidebarProjectExpansion, key) === undefined) return
  commitProjectExpansion(key, undefined)
}

function commitProjectExpansion(key: string, expanded: boolean | undefined) {
  sidebarProjectExpansion = withProjectExpansion(sidebarProjectExpansion, key, expanded)
  projectExpansionRevision += 1
  projectExpansionQueue.commit(JSON.stringify(sidebarProjectExpansion))
}

// --- section collapse -----------------------------------------------------

function isSidebarSectionCollapsed(section: SidebarSectionKey) {
  return isSectionCollapsed(sidebarSectionsCollapsed, section)
}

function setSidebarSectionCollapsed(section: SidebarSectionKey, collapsed: boolean) {
  if (isSidebarSectionCollapsed(section) === collapsed) return
  sidebarSectionsCollapsed = withSectionCollapsed(sidebarSectionsCollapsed, section, collapsed)
  sectionsCollapsedRevision += 1
  sectionsCollapsedQueue.commit(JSON.stringify(sidebarSectionsCollapsed))
}

function toggleSidebarSection(section: SidebarSectionKey) {
  setSidebarSectionCollapsed(section, !isSidebarSectionCollapsed(section))
  renderSessionList()
}

// --- reveal on session switch / new chat ---------------------------------

/** Reveal a project group (and its section) so a session becomes visible.
 *  Unfold the containing section first, then a group already
 *  expanded is a no-op, a group the user EXPLICITLY collapsed is left alone when
 *  the reason is only a draft, anything else expands. */
function revealProjectInSidebar(section: SidebarSectionKey, projectKey: string | null, options: { draft?: boolean } = {}) {
  setSidebarSectionCollapsed(section, false)
  if (!projectKey) return
  if (revealDecision(readProjectExpansion(sidebarProjectExpansion, projectKey), !!options.draft) !== 'expand') return
  setProjectThreadListOpen(projectKey, true)
}

// --- persistence: settings.db authoritative, localStorage first-paint mirror --

/** Decode one persisted collapse row back into live state. Used as the queue's
 *  `apply` port, so an optimistic commit and a failure rollback go through one
 *  code path. */
function applyCollapseRow(key: string, value: string) {
  const parsed = safeJsonParse(value)
  if (key === SIDEBAR_PROJECT_EXPANDED_KEY) sidebarProjectExpansion = parseProjectExpansionMap(parsed)
  else if (key === SIDEBAR_SECTIONS_COLLAPSED_KEY) sidebarSectionsCollapsed = parseSectionsCollapsed(parsed)
}

function currentCollapseRow(key: string): string {
  return key === SIDEBAR_PROJECT_EXPANDED_KEY
    ? JSON.stringify(sidebarProjectExpansion)
    : JSON.stringify(sidebarSectionsCollapsed)
}

function createCollapseWriteQueue(key: string, mirrorKey: string): CollapseWriteQueue {
  return new CollapseWriteQueue({
    writeStore: value => klausApi.settings?.kv?.set?.(key, value) ?? Promise.resolve(null),
    writeMirror: value => { persistLocalValue(mirrorKey, value) },
    apply: value => applyCollapseRow(key, value),
    current: () => currentCollapseRow(key),
    render: () => renderSessionList(),
    // settings:kv:set can answer with an error envelope instead of rejecting.
    isError: result => !!result && typeof result === 'object' && 'error' in result && !!(result as { error?: unknown }).error,
    describeError: result => String((result as { error?: unknown }).error),
    onFailure: error => showToast(`${tt('local_persistence_failed')}: ${error}`),
  }, currentCollapseRow(key))
}

// One serialized queue per row. The UI applies optimistically on click; the
// durable writes are chained so a rapid fold/unfold cannot land out of order and
// leave settings.db holding the older value (see CollapseWriteQueue).
const projectExpansionQueue = createCollapseWriteQueue(SIDEBAR_PROJECT_EXPANDED_KEY, SIDEBAR_PROJECT_EXPANDED_MIRROR_KEY)
const sectionsCollapsedQueue = createCollapseWriteQueue(SIDEBAR_SECTIONS_COLLAPSED_KEY, SIDEBAR_SECTIONS_COLLAPSED_MIRROR_KEY)

/** Write a missing KV row from the local mirror at first hydrate. Failure is
 *  benign: the mirror stands and the next launch retries. */
async function seedSidebarUiState(queue: CollapseWriteQueue, key: string, value: string, mirrorKey: string) {
  try {
    await klausApi.settings?.kv?.set?.(key, value)
    persistLocalValue(mirrorKey, value)
    // Now that the row exists, a later click's failure must roll back to it.
    queue.noteDurable(value)
  } catch {
    // Keep the local mirror; seeding retries on the next boot.
  }
}

/** Hydrate from settings.db once at boot. A click that landed before the read
 *  resolved wins: each async branch compares the revision it captured before
 *  awaiting against the current one. */
async function hydrateSidebarCollapseState() {
  if (sidebarCollapseHydrate) return sidebarCollapseHydrate
  sidebarCollapseHydrate = (async () => {
    const projectsRevision = projectExpansionRevision
    const sectionsRevision = sectionsCollapsedRevision
    let changed = false
    try {
      const [rawProjects, rawSections] = await Promise.all([
        klausApi.settings?.kv?.get?.(SIDEBAR_PROJECT_EXPANDED_KEY),
        klausApi.settings?.kv?.get?.(SIDEBAR_SECTIONS_COLLAPSED_KEY),
      ])
      if (mayApplyAsyncState(projectsRevision, projectExpansionRevision)) {
        // A missing row means "never persisted", not "everything expanded": the
        // local mirror (or its legacy seed) is the only evidence, so it wins and
        // gets written back. Only an existing row is authoritative.
        if (rawProjects == null) {
          await seedSidebarUiState(projectExpansionQueue, SIDEBAR_PROJECT_EXPANDED_KEY, JSON.stringify(sidebarProjectExpansion), SIDEBAR_PROJECT_EXPANDED_MIRROR_KEY)
        } else {
          const projects = parseProjectExpansionMap(safeJsonParse(rawProjects))
          // The store is authoritative; make it the rollback target so a failed
          // click reverts to the persisted row, not the pre-hydrate mirror guess.
          projectExpansionQueue.noteDurable(JSON.stringify(projects))
          if (JSON.stringify(projects) !== JSON.stringify(sidebarProjectExpansion)) {
            sidebarProjectExpansion = projects
            persistLocalValue(SIDEBAR_PROJECT_EXPANDED_MIRROR_KEY, JSON.stringify(projects))
            changed = true
          }
        }
      }
      if (mayApplyAsyncState(sectionsRevision, sectionsCollapsedRevision)) {
        if (rawSections == null) {
          // Same rule, and the one that matters for an upgrade: a user who had
          // folded the old `klaus_projects_collapsed` group would otherwise lose
          // it on the first launch after this rework.
          await seedSidebarUiState(sectionsCollapsedQueue, SIDEBAR_SECTIONS_COLLAPSED_KEY, JSON.stringify(sidebarSectionsCollapsed), SIDEBAR_SECTIONS_COLLAPSED_MIRROR_KEY)
        } else {
          const sections = parseSectionsCollapsed(safeJsonParse(rawSections))
          sectionsCollapsedQueue.noteDurable(JSON.stringify(sections))
          if (JSON.stringify(sections) !== JSON.stringify(sidebarSectionsCollapsed)) {
            sidebarSectionsCollapsed = sections
            persistLocalValue(SIDEBAR_SECTIONS_COLLAPSED_MIRROR_KEY, JSON.stringify(sections))
            changed = true
          }
        }
      }
    } catch {
      // An unavailable host must not block the sidebar; the mirror stands.
    }
    if (changed) renderSessionList()
  })()
  return sidebarCollapseHydrate
}

function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/** Adopt a collapse change pushed from another window. Equal values are the
 *  echo of this window's own write and must not re-render; a local write that
 *  landed mid-flight also wins. */
async function applyRemoteSidebarCollapseChange(key: string) {
  const revision = key === SIDEBAR_PROJECT_EXPANDED_KEY ? projectExpansionRevision : sectionsCollapsedRevision
  try {
    const raw = await klausApi.settings?.kv?.get?.(key)
    if (key === SIDEBAR_PROJECT_EXPANDED_KEY) {
      if (!mayApplyAsyncState(revision, projectExpansionRevision)) return
      const next = parseProjectExpansionMap(safeJsonParse(raw))
      if (JSON.stringify(next) === JSON.stringify(sidebarProjectExpansion)) return
      sidebarProjectExpansion = next
      persistLocalValue(SIDEBAR_PROJECT_EXPANDED_MIRROR_KEY, JSON.stringify(next))
    } else if (key === SIDEBAR_SECTIONS_COLLAPSED_KEY) {
      if (!mayApplyAsyncState(revision, sectionsCollapsedRevision)) return
      const next = parseSectionsCollapsed(safeJsonParse(raw))
      if (JSON.stringify(next) === JSON.stringify(sidebarSectionsCollapsed)) return
      sidebarSectionsCollapsed = next
      persistLocalValue(SIDEBAR_SECTIONS_COLLAPSED_MIRROR_KEY, JSON.stringify(next))
    } else {
      return
    }
    renderSessionList()
  } catch {
    // A failed cross-window refresh leaves this window's state untouched.
  }
}

function reduceSidebarMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
}

// --- show-more pagination (5 rows, then +10 per press) ----------------------

function projectShowMoreState(key: string): { expanded: boolean; page: number } {
  return { expanded: expandedProjectThreadLists.has(key), page: projectThreadPages.get(key) ?? 0 }
}

function projectShowMorePress(key: string) {
  const next = showMoreAfterPress(projectShowMoreState(key))
  if (next.expanded && !expandedProjectThreadLists.has(key)) {
    expandedProjectThreadLists.add(key)
    persistExpandedProjectThreadLists()
  }
  projectThreadPages.set(key, next.page)
  renderSessionList()
}

/** Fold a group's "show more" back to the preview limit. Collapsing a project
 *  clears the
 *  show-all flag when a project collapses; the in-memory page counter drops with
 *  it so a reopen starts at 5 rows again. */
function resetProjectShowMore(key: string) {
  projectThreadPages.delete(key)
  if (!expandedProjectThreadLists.has(key)) return
  expandedProjectThreadLists.delete(key)
  persistExpandedProjectThreadLists()
}

// --- collapsed aggregate badge -------------------------------------------

/** A collapsed group/section surfaces waiting/unread as a dot and
 *  an otherwise-running session as a spinner, else nothing. Collapsed groups do
 *  not build thread rows, so this reads session state directly. */
function projectCollapsedBadge(key: string): CollapsedBadge {
  return reduceCollapsedBadge(projectGroupSessionIds(key).map(sidebarSessionActivity))
}

function sectionCollapsedBadge(section: SidebarSectionKey): CollapsedBadge {
  return reduceCollapsedBadge(sectionSessionIdsForBadge(section).map(sidebarSessionActivity))
}

function sidebarSessionActivity(sessionId: string) {
  return {
    working: isSidebarSessionWorking(sessionId),
    unread: isSidebarSessionCompleteUnread(sessionId),
    waiting: sidebarSessionWait(sessionId).count > 0,
  }
}

/** All requests parked on this session, merged from both parking places:
 *  the off-screen queues (arrived while another conversation was open) and the
 *  live transcript cards (the on-screen render of the same waits). Snoozed
 *  input requests are held out until their deadline passes (the snooze window). */
function sidebarSessionWait(sessionId: string): { count: number; kind: SessionWaitingKind; snooze: { requestId: string; deadlineMs: number } | null } {
  if (!sessionId) return { count: 0, kind: 'approval', snooze: null }
  const seen = new Set<string>()
  let approvals = 0
  let inputs = 0
  let snooze: { requestId: string; deadlineMs: number } | null = null
  const addRequest = (requestId: string, kind: SessionWaitingKind) => {
    if (!requestId || seen.has(requestId)) return
    seen.add(requestId)
    if (kind === 'input' && isInputRequestSnoozed(requestId)) {
      const remaining = inputSnoozeRemaining(requestId)
      if (remaining != null && (snooze == null || remaining < snooze.deadlineMs - Date.now())) {
        snooze = { requestId, deadlineMs: Date.now() + remaining }
      }
      return
    }
    if (kind === 'input') {
      inputs += 1
      return
    }
    approvals += 1
  }
  for (const req of pendingPermissionsBySession.get(sessionId) || []) {
    addRequest(req.requestId, req.toolName === 'AskUserQuestion' ? 'input' : 'approval')
  }
  for (const req of pendingElicitsBySession.get(sessionId) || []) addRequest(req.requestId, 'input')
  for (const live of liveApprovalsOf(getSessionStream(sessionId).liveUnits as unknown as Array<Record<string, unknown>>)) {
    addRequest(live.requestId, live.kind)
  }
  // A friend request parked in this conversation waits on its owner exactly
  // like a parked approval card, so it ranks the row as needing input.
  const friendPending = pendingFriendTaskForSession(sessionId)
  if (friendPending) addRequest(`friend-task:${friendPending.id}`, 'input')
  if (inputs > 0) return { count: inputs + approvals, kind: 'input', snooze }
  return { count: approvals, kind: 'approval', snooze }
}

/** A `waiting` session: an approval or elicitation is parked on this session. The
 *  data lives in the approval queues but is not projected onto sidebar rows, so
 *  the badge reducer reads the queues directly. */
function isSidebarSessionWaiting(sessionId: string) {
  return sidebarSessionWait(sessionId).count > 0
}

/** Every session that belongs to a section, including ones hidden inside a
 *  collapsed project group — a folded group must still report that something in
 *  it is running. */
function sectionSessionIdsForBadge(section: SidebarSectionKey): string[] {
  const partitions = partitionSidebarSessions(sessions, sessionId => !!detectChannelPrefix(sessionId))
  if (section === 'pinned') return partitions.pinned.map(s => s.id)
  if (section === 'channels') return partitions.channels.map(s => s.id)
  if (section === 'recent') return projectlessConversationSessions().map(s => s.id)
  // 'projects': everything filing under a workspace container or a project.
  return groupedLocalSessions()
    .filter(s => !!projectStateKey(s.workspaceId ? workspaceContainerKey(s.workspaceId) : sessionProjectKey(s)))
    .map(s => s.id)
}

/** Session ids belonging to one project group (or workspace container, or friend folder). */
function projectGroupSessionIds(key: string): string[] {
  const workspaceId = workspaceIdFromKey(key)
  if (workspaceId) return workspaceConversationSessions(workspaceId).map(s => s.id)
  const friendshipId = friendshipIdFromKey(key)
  if (friendshipId) return friendConversationSessions(friendshipId).map(s => s.id)
  return projectConversationSessions(key).map(s => s.id)
}

// Hand-crafted hollow folder: the icon set has no exported folder SVG component,
// it's likely inlined inside a React component that didn't get split into its own
// bundle. Outer = folder silhouette with tab on top; inner = matching cutout for
// the body interior. evenodd makes it a hollow folder outline.
function projectFolderIconSvg() {
  return `${klausIcon('project-sb')}`
}

// Stacked-folder glyph for a multi-folder workspace (vs the single folder above).
function projectWorkspaceIconSvg() {
  return `${klausIcon('project-sb-workspace')}`
}

// New-chat glyph for a project row.
function projectNewChatIconSvg() {
  return `${klausIcon('chat-project-new-chat')}`
}

// Hand-crafted hollow folder + plus (no exact equivalent for "add project" in the icon set).
// Outer folder shape + inner cutout = hollow folder; small plus sign overlaid in center.
function projectAddIconSvg() {
  return `${klausIcon('chat-project-add')}`
}

function projectMoreIconSvg() {
  return `${klausIcon('chat-project-more')}`
}

function projectSearchIconSvg() {
  return `${klausIcon('chat-project-search')}`
}

function projectPickerCheckIconSvg() {
  return `${klausIcon('chat-project-picker-check')}`
}

// 分支行字形：把触发器的三圆点+曲线连接转为 path-fill 填充字形（圆用双环
// donut、竖干用 rect、曲线用填充 path 闭合），保持与触发器完全相同的外观。
function projectBranchIconSvg() {
  return `${klausIcon('project-sb-2')}`
}

function projectNoProjectIconSvg() {
  return `${klausIcon('chat-project-no-project')}`
}

// Hollow server-rack glyph for SSH remote projects — same 16x16 fill-rule
// evenodd style as the folder icons so picker/sidebar rows stay consistent.
function projectSshIconSvg() {
  return `${klausIcon('project-sb-3')}`
}

// True when a project root/workdir is an ssh:// remote binding, not a local path.
function isSshProjectWorkdir(workdir: string | null) {
  return typeof workdir === 'string' && workdir.startsWith('ssh://')
}

// Sidebar chevron glyph.
function sidebarChevronIconSvg() {
  return `${klausIcon('chat-sidebar-chevron')}`
}

function toggleProjectSidebarItem(workdirOrKey: string | null) {
  const key = projectStateKey(workdirOrKey)
  if (!key) return
  const currentlyOpen = isProjectThreadListOpen(key) && !closingProjectThreadLists.has(key)
  const nextOpen = !currentlyOpen
  // A project row click only changes the visible sidebar selection. The next
  // conversation target changes only through an explicit new-chat entry.
  if (!isWorkspaceStateKey(key) && !isFriendStateKey(key)) {
    setActiveProjectWorkdir(key, { render: false, refreshWorkdir: false })
  }
  if (!nextOpen) {
    // Folding resets the group's "show all tasks", so the next
    // reopen starts back at the preview limit rather than a deep page.
    resetProjectShowMore(key)
    // Commit the fold (and its persistence) at click time, writing the state
    // atom on toggle. Deferring it to the exit-animation callback meant a
    // lost callback — hidden window, throttled rAF, detached node — silently
    // dropped the user's choice: the row looked folded but reload showed it open.
    setProjectThreadListOpen(key, false)
    // 减少动效场景直接收起；否则标 closing 让组件播退场动画后清理临时标记。
    if (reduceSidebarMotion()) {
      renderSessionList()
      return
    }
    closingProjectThreadLists.add(key)
    renderSessionList()
    return
  }
  closingProjectThreadLists.delete(key)
  setProjectThreadListOpen(key, true)
  openingProjectThreadLists.add(key)
  renderSessionList()
}

function projectSidebarCloseFinished(key: string) {
  closingProjectThreadLists.delete(key)
  renderSessionList()
}

function closeProjectMenu() {
  if (projectMenuCloseHandlers) {
    document.removeEventListener('mousedown', projectMenuCloseHandlers.onMouseDown, true)
    document.removeEventListener('keydown', projectMenuCloseHandlers.onKeyDown, true)
    window.removeEventListener('resize', projectMenuCloseHandlers.onResize, true)
  }
  projectMenuCloseHandlers = null
  projectMenuEl?.remove()
  projectMenuEl = null
}

// ---- Friend folder menu and notification-mute prefs ----
// Friend folders own no registry entry, so the project menu does not apply;
// their one setting of their own is muting arrival notifications. The mute
// list and the toast switch live in settings:kv and are cached here so the
// menu label and the arrival listener can read them synchronously.
let friendToastPref: string | null = null
let mutedFriendsCache = new Set<string>()
function refreshFriendNotificationPrefs() {
  void Promise.all([
    klausApi.settings.kv.get('notification.friendToast'),
    klausApi.settings.kv.get('notification.mutedFriends'),
  ]).then(([toast, muted]) => {
    friendToastPref = toast === 'off' ? 'off' : 'on'
    try {
      const parsed = JSON.parse(muted || '[]') as unknown
      mutedFriendsCache = new Set(Array.isArray(parsed) ? (parsed as unknown[]).map(entry => String(entry)) : [])
    } catch { mutedFriendsCache = new Set() }
  }).catch(() => { /* prefs are best-effort; defaults stay permissive */ })
}
refreshFriendNotificationPrefs()
window.addEventListener('app:preferences-changed', refreshFriendNotificationPrefs)

async function toggleFriendMuted(friendId: string) {
  const next = new Set(mutedFriendsCache)
  if (next.has(friendId)) next.delete(friendId)
  else next.add(friendId)
  try {
    const result = await klausApi.settings.kv.set('notification.mutedFriends', JSON.stringify([...next]))
    if ((result as { ok?: boolean } | null)?.ok === false) return
    mutedFriendsCache = next
    refreshFriendNotificationPrefs()
  } catch { /* keep the cached state when the write fails */ }
}

/** Shared chrome for the sidebar popover menus: clamp into the viewport and
 *  close on outside press, Escape or resize. */
function attachSidebarMenuChrome(menu: HTMLElement, anchor: HTMLElement | null, point: { x: number; y: number } | null) {
  document.body.appendChild(menu)
  const rect = anchor?.getBoundingClientRect()
  const width = Math.max(menu.offsetWidth, 168)
  const height = menu.offsetHeight
  const maxLeft = Math.max(8, window.innerWidth - width - 8)
  const maxTop = Math.max(8, window.innerHeight - height - 8)
  const rawLeft = point ? point.x : (rect ? rect.right - width : 8)
  const rawTop = point ? point.y : (rect ? rect.bottom + 6 : 8)
  menu.style.left = `${Math.min(Math.max(8, rawLeft), maxLeft)}px`
  menu.style.top = `${Math.min(Math.max(8, rawTop), maxTop)}px`
  projectMenuEl = menu
  const onMouseDown = (e: MouseEvent) => {
    if (projectMenuEl?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return
    closeProjectMenu()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeProjectMenu()
  }
  const onResize = () => closeProjectMenu()
  projectMenuCloseHandlers = { onMouseDown, onKeyDown, onResize }
  setTimeout(() => {
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onResize, true)
  }, 0)
}

function showFriendFolderMenu(key: string, anchor: HTMLElement | null, point: { x: number; y: number } | null) {
  const friendId = key.slice(FRIEND_GROUP_KEY_PREFIX.length)
  if (!friendId || (!anchor && !point)) return
  closeProjectMenu()
  const menu = document.createElement('div')
  menu.className = 'project-menu'
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'project-menu-item'
  item.textContent = mutedFriendsCache.has(friendId)
    ? (tt('friend_menu_unmute') || 'Unmute friend notifications')
    : (tt('friend_menu_mute') || 'Mute friend notifications')
  item.addEventListener('click', (e) => {
    e.stopPropagation()
    closeProjectMenu()
    void toggleFriendMuted(friendId)
  })
  menu.appendChild(item)
  attachSidebarMenuChrome(menu, anchor, point)
}

function showProjectMenu(project: { workdir: string; name: string }, anchor: HTMLElement, point: { x: number; y: number } | null = null) {
  closeProjectMenu()
  if (!anchor && !point) return
  const menu = document.createElement('div')
  menu.className = 'project-menu'

  const addItem = (label: string, onClick: () => void, options: { danger?: boolean } = {}) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'project-menu-item' + (options.danger ? ' danger' : '')
    item.textContent = label
    item.addEventListener('click', async (e) => {
      e.stopPropagation()
      closeProjectMenu()
      await onClick()
    })
    menu.appendChild(item)
  }

  addItem(tt('project_menu_new_chat'), async () => startProjectNewChat(project.workdir))
  // ssh:// 项目没有本地目录可以在 Finder 里展示，隐掉该项；复制路径仍可用（复制规范 ssh:// 地址）。
  if (!isSshProjectWorkdir(project.workdir)) {
    addItem(tt('project_menu_reveal'), async () => {
      await klausApi.artifacts?.reveal?.(project.workdir).catch((err: unknown) => console.warn('[projects] reveal failed:', err))
    })
  }
  addItem(tt('project_menu_copy_path'), async () => {
    await writeClipboardText(project.workdir).catch((err: unknown) => console.warn('[projects] copy path failed:', err))
  })
  addItem(tt('project_menu_remove'), async () => removeProject(project), { danger: true })

  attachSidebarMenuChrome(menu, anchor, point)
}

function closeProjectPicker() {
  if (projectPickerCloseHandlers) {
    document.removeEventListener('pointerdown', projectPickerCloseHandlers.onPointerDown, true)
    document.removeEventListener('keydown', projectPickerCloseHandlers.onKeyDown, true)
    window.removeEventListener('resize', projectPickerCloseHandlers.onClose, true)
    document.removeEventListener('scroll', projectPickerCloseHandlers.onClose, true)
  }
  projectPickerCloseHandlers = null
  projectPickerEl?.remove()
  projectPickerEl = null
  projectPickerSearch = ''
  btnWorkdir?.classList.remove('open')
  btnWorkdir?.setAttribute('aria-expanded', 'false')
}

function positionProjectPicker() {
  if (!projectPickerEl || !btnWorkdir) return
  const rect = btnWorkdir.getBoundingClientRect()
  projectPickerEl.style.left = `${Math.max(8, rect.left)}px`
  projectPickerEl.style.top = `${Math.max(8, rect.bottom + 8)}px`
  requestAnimationFrame(() => {
    if (!projectPickerEl || !btnWorkdir) return
    const panel = projectPickerEl.getBoundingClientRect()
    const anchor = btnWorkdir.getBoundingClientRect()
    const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - panel.width - 8))
    const topAbove = anchor.top - panel.height - 8
    const topBelow = anchor.bottom + 8
    const top = topAbove >= 8
      ? topAbove
      : Math.min(topBelow, Math.max(8, window.innerHeight - panel.height - 8))
    projectPickerEl.style.left = `${left}px`
    projectPickerEl.style.top = `${top}px`
  })
}

function projectPickerItems() {
  const query = projectPickerSearch.trim().toLowerCase()
  const current = currentEditableProjectWorkdir()
  const items = projectRowsFromSessions()
  if (!query) return items
  return items.filter(project => {
    const name = String(project.name || '').toLowerCase()
    const workdir = String(project.workdir || '').toLowerCase()
    return name.includes(query) || workdir.includes(query)
  }).sort((a, b) => {
    const aSelected = normalizeProjectWorkdir(a.workdir) === current
    const bSelected = normalizeProjectWorkdir(b.workdir) === current
    if (aSelected !== bSelected) return aSelected ? -1 : 1
    return 0
  })
}

function revealProjectChoiceInSidebar(workdir: string | null, options: { draft?: boolean } = {}) {
  const key = normalizeProjectWorkdir(workdir)
  if (key) {
    revealProjectInSidebar('projects', key, options)
    if (!projectRoots.includes(key)) projectRoots = [key, ...projectRoots]
    return
  }
  setSidebarSectionCollapsed('recent', false)
}

async function setProjectForCurrentNewConversation(workdir: string | null) {
  if (!canEditProjectForCurrentConversation()) {
    window.showToast?.(tt('workdir_new_chat_only'))
    return
  }
  const next = normalizeProjectWorkdir(workdir)
  const current = currentEditableProjectWorkdir()
  // A draft (no live session yet) must not pry open a group the user folded.
  revealProjectChoiceInSidebar(next, { draft: !window.currentSessionId })
  if (!window.currentSessionId) {
    pendingNewChatWorkdir = next
    pendingNewChatProjectRoot = projectIdentityForWorkdir(next)
    // Choosing a bare project (or none) drops any drafted workspace.
    pendingNewChatWorkspaceId = null
  } else {
    // A session that WAS workspace-bound must have its binding cleared even when
    // the picked project equals the workspace's primary root, so force the
    // set/clear-workdir call (the host drops the workspace row in both).
    const hadWorkspace = !!findKnownSession(window.currentSessionId)?.workspaceId
    if (next) {
      if (current !== next || hadWorkspace) {
        const result = await klausApi.session.setWorkdir(window.currentSessionId, next)
        if (result?.error) throw new Error(String(result.error))
      }
      sessions = sessions.map((s) => s.id === window.currentSessionId ? { ...s, workdir: next, workspaceId: null } : s)
    } else {
      if (current || hadWorkspace) {
        const result = await klausApi.session.clearWorkdir(window.currentSessionId)
        if (result?.error) throw new Error(String(result.error))
      }
      sessions = sessions.map((s) => s.id === window.currentSessionId ? { ...s, workdir: null, workspaceId: null } : s)
    }
  }
  setActiveProjectWorkdir(next, { render: false, refreshWorkdir: false })
  renderSessionList()
  await refreshWorkdirButton()
}

// Open (and reveal) a workspace container in the sidebar, mirroring
// revealProjectChoiceInSidebar but keyed by the `ws:<id>` container key.
function revealWorkspaceChoiceInSidebar(workspaceId: string, options: { draft?: boolean } = {}) {
  revealProjectInSidebar('projects', workspaceContainerKey(workspaceId), options)
}

// Select a WORKSPACE as the run target of the current new chat (or an editable
// session): its primary root becomes the cwd and the extra roots ride along.
// null cancels the workspace, falling back to projectless.
async function setWorkspaceForCurrentNewConversation(workspaceId: string | null) {
  if (!canEditProjectForCurrentConversation()) {
    window.showToast?.(tt('workdir_new_chat_only'))
    return
  }
  const primary = workspacePrimaryRoot(workspaceId)
  if (workspaceId && !primary) {
    await window.klausDialog.alert(tt('workspace_empty_error'))
    return
  }
  const draft = !window.currentSessionId
  if (workspaceId) revealWorkspaceChoiceInSidebar(workspaceId, { draft })
  else revealProjectChoiceInSidebar(null, { draft })
  if (!window.currentSessionId) {
    pendingNewChatWorkspaceId = workspaceId
    pendingNewChatWorkdir = workspaceId ? primary : null
    // A workspace-bound draft has no bare project membership.
    pendingNewChatProjectRoot = null
  } else {
    const result = await klausApi.session.setWorkspace(window.currentSessionId, workspaceId)
    if (result?.error) throw new Error(String(result.error))
    sessions = sessions.map((s) => s.id === window.currentSessionId
      ? { ...s, workspaceId, workdir: workspaceId ? primary : null }
      : s)
  }
  setActiveProjectWorkdir(null, { render: false, refreshWorkdir: false })
  renderSessionList()
  await refreshWorkdirButton()
}

async function pickProjectWorkdir() {
  let pick
  try { pick = await klausApi.session.pickWorkdir() }
  catch (err) { console.warn('[projects] pick failed:', err); return null }
  return normalizeProjectWorkdir(pick?.path)
}

async function pickProjectWorkdirs() {
  let pick: { paths?: unknown } | null = null
  try { pick = await klausApi.session.pickWorkdirs() }
  catch (err) { console.warn('[projects] multi pick failed:', err); return [] }
  const rows = Array.isArray(pick?.paths) ? pick.paths : []
  return rows.map((row: unknown) => normalizeProjectWorkdir(typeof row === 'string' ? row : null)).filter((row: string | null): row is string => !!row)
}

async function pickAndRegisterProjectWorkdir() {
  const next = await pickProjectWorkdir()
  if (!next) return null
  const state = await klausApi.projects?.add?.(next)
  if (state?.error) {
    await window.klausDialog.alert(String(state.error))
    return null
  }
  projectRoots = Array.isArray(state?.roots)
    ? state.roots.map((root: string | { path?: string }) => typeof root === 'string' ? root : root?.path).filter((r: string | undefined): r is string => !!r)
    : [next, ...projectRoots.filter((root) => root !== next)]
  projectLabels = state?.labels && typeof state.labels === 'object' ? state.labels : projectLabels
  // 广播项目注册表变化：快捷指令页等消费方据此即时重拉项目 tab。
  try { window.dispatchEvent(new CustomEvent('klaus:projects-changed')) } catch {}
  await window.maybeShowExternalImportForProject?.(next).catch((err: unknown) => {
    console.warn('[projects] external import dialog failed:', err)
  })
  return next
}

async function addProjectFromProjectPicker() {
  const next = await pickAndRegisterProjectWorkdir()
  if (!next) return
  await setProjectForCurrentNewConversation(next)
  await refreshProjectWorkspaces({ render: true, refreshWorkdir: true })
}

// 「连接 SSH」：弹连接弹窗 → 选远程目录 →
// 注册为 ssh:// 远程项目并选中。弹窗逻辑在 ssh-connect.js（window.openSshConnectModal）。
async function connectSshFromProjectPicker() {
  const picked = await window.openSshConnectModal?.()
  if (!picked?.workdir) return
  const state = await klausApi.projects?.add?.(picked.workdir, picked.label || undefined)
  if (state?.error) {
    await window.klausDialog.alert(String(state.error))
    return
  }
  projectRoots = Array.isArray(state?.roots)
    ? state.roots.map((root: string | { path?: string }) => typeof root === 'string' ? root : root?.path).filter((r: string | undefined): r is string => !!r)
    : [picked.workdir, ...projectRoots.filter((root) => root !== picked.workdir)]
  projectLabels = state?.labels && typeof state.labels === 'object' ? state.labels : projectLabels
  try { window.dispatchEvent(new CustomEvent('klaus:projects-changed')) } catch {}
  await setProjectForCurrentNewConversation(picked.workdir)
  await refreshProjectWorkspaces({ render: true, refreshWorkdir: true })
}

// Workspace editor: name a group, select existing projects, or pick folders
// without registering them as standalone projects. The first folder is the cwd;
// v1 accepts local absolute paths only, so ssh:// roots are excluded.
async function openWorkspaceEditor(existing: { id: string; name: string; roots: string[] } | null) {
  // The editor picks from the registered-project list; refresh it first.
  await refreshProjectWorkspaces({ render: false, refreshWorkdir: false })
  const isEdit = !!existing
  let name = existing?.name || ''
  // `selected` preserves check order; selected[0] is the workspace PRIMARY root.
  const selected: string[] = (existing?.roots || [])
    .map((r) => normalizeProjectWorkdir(r))
    .filter((r): r is string => !!r)

  const modal = document.createElement('div')
  modal.className = 'kls-modal-overlay'
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  function close() { modal.remove(); document.removeEventListener('keydown', onKey, true) }

  const rowStyle = 'display:flex;align-items:center;gap:8px;width:100%;text-align:left'
  function render() {
    const available = projectRoots
      .map((r) => normalizeProjectWorkdir(r))
      .filter((r): r is string => !!r && !isSshProjectWorkdir(r) && !selected.includes(r))
    const selectedHtml = selected.length
      ? selected.map((root, i) => `
        <div class="project-picker-item" style="${rowStyle}">
          <span class="project-picker-icon">${projectFolderIconSvg()}</span>
          <span class="project-picker-label">${escapeHtml(workdirDisplayName(root))}</span>
          ${i === 0 ? `<span class="kls-required" style="font-size:11px">${escapeHtml(tt('workspace_primary_badge'))}</span>` : ''}
          <button type="button" class="kls-modal-close" data-ws-remove="${escapeHtml(root)}" aria-label="remove">${klausIcon('close', { size: 14 })}</button>
        </div>`).join('')
      : `<div class="project-picker-empty">${escapeHtml(tt('workspace_no_folders'))}</div>`
    const availableHtml = available.map((root) => `
      <button type="button" class="project-picker-item" data-ws-select="${escapeHtml(root)}" style="${rowStyle}">
        <span class="project-picker-icon">${projectFolderIconSvg()}</span>
        <span class="project-picker-label">${escapeHtml(workdirDisplayName(root))}</span>
      </button>`).join('')
    modal.innerHTML = `
      <div class="kls-modal">
        <div class="kls-modal-head">
          <div>
            <h3 class="kls-modal-title">${escapeHtml(isEdit ? tt('workspace_edit_title') : tt('workspace_create_title'))}</h3>
            <p class="kls-modal-subtitle">${escapeHtml(tt('workspace_modal_subtitle'))}</p>
          </div>
          <button class="kls-modal-close" data-close aria-label="close">${klausIcon('close', { size: 18 })}</button>
        </div>
        <div class="kls-modal-body">
          <div class="kls-field">
            <label class="kls-field-label">${escapeHtml(tt('workspace_name_label'))}</label>
            <input class="kls-input" id="ws-name" placeholder="${escapeHtml(tt('workspace_name_placeholder'))}" value="${escapeHtml(name)}">
          </div>
          <div class="kls-field">
            <label class="kls-field-label">${escapeHtml(tt('workspace_folders_label'))} <span class="kls-required">*</span></label>
            <div class="kls-field-hint">${escapeHtml(tt('workspace_primary_hint'))}</div>
            <div class="project-picker-list">${selectedHtml}</div>
            ${availableHtml ? `<div class="project-picker-section-label">${escapeHtml(tt('workspace_available_label'))}</div><div class="project-picker-list">${availableHtml}</div>` : ''}
            <button class="kls-field-add-btn" id="ws-add-folder">${escapeHtml(tt('workspace_add_folder'))}</button>
          </div>
        </div>
        <div class="kls-modal-foot" style="display:flex;gap:8px;justify-content:flex-end">
          ${isEdit ? `<button class="kls-modal-close" id="ws-delete" style="width:auto;padding:0 12px">${escapeHtml(tt('workspace_delete'))}</button>` : ''}
          <button class="kls-submit-btn" id="ws-submit">${escapeHtml(isEdit ? tt('workspace_save_submit') : tt('workspace_create_submit'))}</button>
        </div>
      </div>`
    modal.querySelector('#ws-name')?.addEventListener('input', (e) => { name = (e.target as HTMLInputElement).value })
    modal.querySelector('[data-close]')?.addEventListener('click', close)
    modal.querySelectorAll('[data-ws-select]').forEach((btn) => btn.addEventListener('click', () => {
      const root = btn.getAttribute('data-ws-select') || ''
      if (root && !selected.includes(root)) selected.push(root)
      render()
    }))
    modal.querySelectorAll('[data-ws-remove]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const root = btn.getAttribute('data-ws-remove') || ''
      const idx = selected.indexOf(root)
      if (idx >= 0) selected.splice(idx, 1)
      render()
    }))
    modal.querySelector('#ws-add-folder')?.addEventListener('click', async () => {
      for (const added of await pickProjectWorkdirs()) {
        if (!selected.includes(added)) selected.push(added)
      }
      render()
    })
    modal.querySelector('#ws-submit')?.addEventListener('click', async () => {
      if (!selected.length) { await window.klausDialog.alert(tt('workspace_empty_error')); return }
      try {
        const res = await klausApi.workspaces.save({ id: existing?.id, name: name.trim(), roots: selected })
        if (res?.error) { await window.klausDialog.alert(String(res.error)); return }
        await refreshProjectWorkspaces({ render: true, refreshWorkdir: false })
        const savedId = typeof res?.id === 'string' ? res.id : (existing?.id || null)
        close()
        if (savedId) await setWorkspaceForCurrentNewConversation(savedId)
      } catch (err) {
        await window.klausDialog.alert((err as Error | null)?.message || String(err))
      }
    })
    modal.querySelector('#ws-delete')?.addEventListener('click', async () => {
      if (!existing) return
      // A workspace owns its sessions: deleting the group takes them along,
      // which the confirmation states with the exact count.
      const count = workspaceConversationSessions(existing.id).length
      const ok = await window.klausDialog.confirm({
        title: tt('workspace_delete_title'),
        message: tt('workspace_delete_message').replace('{count}', String(count)),
        confirmText: tt('workspace_delete'),
        danger: true,
      })
      if (!ok) return
      try {
        await klausApi.workspaces.delete(existing.id, true)
        if (pendingNewChatWorkspaceId === existing.id) pendingNewChatWorkspaceId = null
        await refreshProjectWorkspaces({ render: true, refreshWorkdir: true })
        close()
      } catch (err) {
        await window.klausDialog.alert((err as Error | null)?.message || String(err))
      }
    })
  }

  document.body.appendChild(modal)
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close() })
  document.addEventListener('keydown', onKey, true)
  render()
}

function focusProjectPickerSearch(caret = projectPickerSearch.length) {
  const input = projectPickerEl?.querySelector('.project-picker-search input')
  if (!input) return
  ;(input as HTMLElement | null)?.focus()
  const nextCaret = Math.max(0, Math.min(Number(caret) || 0, (input as HTMLInputElement).value.length))
  try { (input as HTMLInputElement).setSelectionRange(nextCaret, nextCaret) } catch {}
}

// 改动项目级 MCP 后：提示需新开会话生效（无文件监听，引擎在会话装配时重读）。openProjectMcpModal 现只
// 从「管理 MCP」设置页的项目区打开，故其提交后若该页正开着就刷新它（settings.js reloadMcpView）。
function afterProjectMcpChange() {
  window.showToast?.(tt('mcp_project_needs_new_session'))
  if (document.getElementById('mcp-view')?.classList.contains('active') && typeof window.reloadMcpView === 'function') window.reloadMcpView()
}

// 项目级 / 本地私有 MCP 添加/编辑弹窗（精简版，复用全局 kls-modal CSS 与 window.klsSelect）。
// scope: 'project'（写 <cwd>/.klaus/mcp.json 团队共享）| 'local'（写 ~/.klaus/config.toml 的 projects.<cwd>.mcpServers，私有不提交）。
// 添加时可在弹窗内切换作用域；编辑时作用域锁定（对应文件已定）。
function openProjectMcpModal(cwd: string, existing: { name?: string; config?: Record<string, unknown> & { type?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; timeout?: number; alwaysLoad?: boolean }; scope?: string } | null, scope: string | null) {
  const isEdit = !!existing
  const cfg: Record<string, unknown> & { type?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; timeout?: number; alwaysLoad?: boolean } = existing?.config || {}
  const type = cfg.type || 'stdio'
  let curScope = scope === 'local' ? 'local' : 'project'
  const cmdStr = type === 'stdio' ? formatMcpCommandLine(cfg.command || '', cfg.args || []) : ''
  const url = cfg.url || ''
  const envEntries = Object.entries(cfg.env || {})
  const timeout = cfg.timeout || ''

  const modal = document.createElement('div')
  modal.className = 'kls-modal-overlay'
  modal.innerHTML = `
    <div class="kls-modal ${mcpStyles['mcp-form-modal']}" role="dialog" aria-modal="true" aria-labelledby="pmcp-title">
      <div class="kls-modal-head">
        <div>
          <h3 class="kls-modal-title" id="pmcp-title">${isEdit ? escapeHtml(tt('mcp_edit_title')) : escapeHtml(curScope === 'local' ? tt('mcp_local_add') : tt('mcp_project_add'))}</h3>
          <p class="kls-modal-subtitle" id="pmcp-subtitle">${escapeHtml(curScope === 'local' ? tt('mcp_local_modal_subtitle') : tt('mcp_project_modal_subtitle'))}</p>
        </div>
        <button type="button" class="kls-modal-close" data-close aria-label="${escapeHtml(tt('cancel'))}">
          ${klausIcon('close', { size: 18 })}
        </button>
      </div>
      <div class="kls-modal-body">
        <div class="kls-field">
          <label class="kls-field-label">${escapeHtml(tt('mcp_field_scope'))}</label>
          <div id="pmcp-scope" class="kls-select kls-select-block"></div>
        </div>
        <div class="kls-field">
          <label class="kls-field-label">${escapeHtml(tt('mcp_field_type'))}</label>
          <div id="pmcp-type" class="kls-select kls-select-block"></div>
        </div>
        <div class="kls-field">
          <label class="kls-field-label">${escapeHtml(tt('mcp_field_name'))} <span class="kls-required">*</span></label>
          <input class="kls-input" id="pmcp-name" placeholder="${escapeHtml(tt('mcp_field_name_placeholder'))}" value="${escapeHtml(existing?.name || '')}" ${isEdit ? 'readonly' : ''}>
        </div>
        <div class="kls-field" id="pmcp-cmd-wrap" ${type !== 'stdio' ? 'hidden' : ''}>
          <label class="kls-field-label">${escapeHtml(tt('mcp_field_command'))} <span class="kls-required">*</span></label>
          <textarea class="kls-input kls-input-area" id="pmcp-cmd" rows="2" placeholder="npx -y @modelcontextprotocol/server-filesystem">${escapeHtml(cmdStr)}</textarea>
          <div class="kls-field-hint">${escapeHtml(tt('mcp_field_command_hint'))}</div>
        </div>
        <div class="kls-field" id="pmcp-url-wrap" ${type === 'stdio' ? 'hidden' : ''}>
          <label class="kls-field-label">${escapeHtml(tt('mcp_field_url'))} <span class="kls-required">*</span></label>
          <input class="kls-input" id="pmcp-url" placeholder="https://..." value="${escapeHtml(url)}">
        </div>
        <div class="kls-field">
          <label class="kls-field-label kls-field-label-row">
            <span>${escapeHtml(tt('mcp_field_env'))} <span class="kls-field-optional">${escapeHtml(tt('mcp_field_env_optional'))}</span></span>
            <button type="button" class="kls-field-inline-btn" id="pmcp-env-paste">${escapeHtml(tt('mcp_field_env_paste'))}</button>
          </label>
          <div id="pmcp-env-rows"></div>
          <button type="button" class="kls-field-add-btn" id="pmcp-env-add">${escapeHtml(tt('mcp_field_env_add'))}</button>
        </div>
        <div class="kls-field">
          <label class="kls-field-label">${escapeHtml(tt('mcp_field_timeout'))} <span class="kls-field-optional">${escapeHtml(tt('mcp_field_timeout_optional'))}</span></label>
          <input class="kls-input" id="pmcp-timeout" type="number" placeholder="60" value="${escapeHtml(String(timeout))}">
        </div>
        <div class="kls-field">
          <label class="kls-field-label">${escapeHtml(tt('mcp_field_always_load'))} <span class="kls-field-optional">${escapeHtml(tt('mcp_field_always_load_optional'))}</span></label>
          <label class="kls-checkbox"><input type="checkbox" id="pmcp-always-load" ${cfg.alwaysLoad === true ? 'checked' : ''}> ${escapeHtml(tt('mcp_field_always_load_hint'))}</label>
        </div>
      </div>
      <div class="${mcpStyles['mcp-form-error']}" id="pmcp-error" role="alert" hidden></div>
      <div class="kls-modal-foot">
        <button type="button" class="kls-submit-btn" id="pmcp-submit">${isEdit ? escapeHtml(tt('mcp_save_submit')) : escapeHtml(tt('mcp_add_submit'))}</button>
      </div>
    </div>
  `
  document.body.appendChild(modal)
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let busy = false

  const titleEl = modal.querySelector('#pmcp-title')
  const subtitleEl = modal.querySelector('#pmcp-subtitle')
  // 作用域选择（添加时可切 project/local；编辑时锁定当前作用域，文件已定不可迁移）。
  const scopeSel = window.klsSelect!.bind(modal.querySelector('#pmcp-scope'), {
    items: [
      { value: 'project', label: tt('mcp_scope_project_option') },
      { value: 'local', label: tt('mcp_scope_local_option') },
    ],
    value: curScope,
    disabled: isEdit,
    onChange: (v: string) => {
      curScope = v === 'local' ? 'local' : 'project'
      if (!isEdit && titleEl) titleEl.textContent = curScope === 'local' ? tt('mcp_local_add') : tt('mcp_project_add')
      if (subtitleEl) subtitleEl.textContent = curScope === 'local' ? tt('mcp_local_modal_subtitle') : tt('mcp_project_modal_subtitle')
    },
  })

  const cmdWrap = modal.querySelector<HTMLElement>('#pmcp-cmd-wrap')
  const urlWrap = modal.querySelector<HTMLElement>('#pmcp-url-wrap')
  const typeSel = window.klsSelect!.bind(modal.querySelector('#pmcp-type'), {
    items: [
      { value: 'stdio', label: 'STDIO' },
      { value: 'sse', label: 'SSE' },
      { value: 'http', label: 'HTTP' },
    ],
    value: type,
    disabled: isEdit,
    onChange: (v: string) => { cmdWrap!.hidden = v !== 'stdio'; urlWrap!.hidden = v === 'stdio' },
  })

  const envRows = modal.querySelector('#pmcp-env-rows')
  const appendEnvRow = (k: string, v: string) => {
    const row = document.createElement('div')
    row.className = 'mcp-env-row'
    row.innerHTML = `
      <input class="kls-input" placeholder="KEY" value="${escapeHtml(k || '')}" data-ek>
      <input class="kls-input" placeholder="value" value="${escapeHtml(v || '')}" data-ev>
      <button type="button" class="mcp-env-del" aria-label="${escapeHtml(tt('remove'))}">
        ${klausIcon('close', { size: 14 })}
      </button>`
    row.querySelector('.mcp-env-del')!.addEventListener('click', () => row.remove())
    envRows!.appendChild(row)
  }
  if (envEntries.length) envEntries.forEach(([k, v]) => appendEnvRow(k, String(v)))
  modal.querySelector('#pmcp-env-add')!.addEventListener('click', () => appendEnvRow('', ''))
  modal.querySelector('#pmcp-env-paste')!.addEventListener('click', async () => {
    try {
      const text = await readClipboardText()
      text.trim().split('\n').forEach((line: string) => {
        const eq = line.indexOf('=')
        if (eq > 0) appendEnvRow(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
      })
    } catch {
      window.showToast?.(tt('clipboard_read_failed'))
    }
  })

  const submitBtn = modal.querySelector<HTMLButtonElement>('#pmcp-submit')!
  const closeBtn = modal.querySelector<HTMLButtonElement>('[data-close]')!
  const errorEl = modal.querySelector<HTMLElement>('#pmcp-error')!
  const showFormError = (message: string, target?: HTMLElement | null) => {
    errorEl.textContent = message
    errorEl.hidden = false
    modal.querySelector('.kls-modal')?.setAttribute('aria-describedby', 'pmcp-error')
    window.showToast?.(message)
    target?.focus()
  }
  const setBusy = (next: boolean) => {
    busy = next
    submitBtn.disabled = next
    closeBtn.disabled = next
    for (const select of [scopeSel, typeSel]) {
      const disabled = next || isEdit
      select.close()
      select.el.classList.toggle('is-disabled', disabled)
      const trigger = select.el.querySelector<HTMLButtonElement>('.kls-select-trigger')
      if (trigger) {
        trigger.disabled = disabled
        trigger.setAttribute('aria-disabled', disabled ? 'true' : 'false')
      }
    }
    modal.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.kls-modal-body input, .kls-modal-body textarea')
      .forEach(control => { control.disabled = next })
    modal.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('.mcp-env-del, #pmcp-env-add, #pmcp-env-paste').forEach(control => { control.disabled = next })
  }
  const onModalKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy) closeModal()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...modal.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.hidden && element.getClientRects().length > 0)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  function closeModal() {
    if (!modal.isConnected) return
    document.removeEventListener('keydown', onModalKeyDown, true)
    scopeSel.destroy()
    typeSel.destroy()
    modal.remove()
    previousFocus?.focus()
  }
  modal.querySelector('[data-close]')!.addEventListener('click', closeModal)
  modal.addEventListener('click', (e) => { if (e.target === modal && !busy) closeModal() })
  document.addEventListener('keydown', onModalKeyDown, true)
  modal.querySelector<HTMLInputElement>('#pmcp-name')?.focus()

  submitBtn.addEventListener('click', async () => {
    if (busy) return
    errorEl.hidden = true
    modal.querySelector('.kls-modal')?.removeAttribute('aria-describedby')
    const name = modal.querySelector<HTMLInputElement>('#pmcp-name')!.value.trim()
    if (!name) { showFormError(tt('settings_mcp_name_required'), modal.querySelector<HTMLElement>('#pmcp-name')); return }
    const t = typeSel.getValue()
    const env: Array<{ key: string; value: string }> = []
    modal.querySelectorAll('#pmcp-env-rows .mcp-env-row').forEach((r) => {
      const k = r.querySelector<HTMLInputElement>('[data-ek]')?.value.trim() || ''
      const v = r.querySelector<HTMLInputElement>('[data-ev]')?.value || ''
      env.push({ key: k, value: v })
    })
    const built = buildMcpServerConfig(cfg, {
      type: t,
      commandLine: modal.querySelector<HTMLInputElement>('#pmcp-cmd')!.value,
      url: modal.querySelector<HTMLInputElement>('#pmcp-url')!.value,
      env,
      timeout: modal.querySelector<HTMLInputElement>('#pmcp-timeout')!.value,
      alwaysLoad: !!modal.querySelector<HTMLInputElement>('#pmcp-always-load')?.checked,
    })
    if (!built.ok) {
      const target = modal.querySelector<HTMLElement>(built.field === 'command' ? '#pmcp-cmd' : '#pmcp-url')
      showFormError(tt(built.field === 'command' ? 'mcp_field_command_required' : 'mcp_field_url_required'), target)
      return
    }
    const newCfg = built.config

    setBusy(true)
    try {
      const api = scopeSel.getValue() === 'local' ? klausApi.mcp?.local : klausApi.mcp?.project
      const res = isEdit
        ? await api?.update?.(cwd, name, newCfg)
        : await api?.create?.(cwd, name, newCfg)
      if (res?.ok !== true) throw new Error(res?.error || tt('settings_failed'))
      closeModal()
      afterProjectMcpChange()
    } catch (error) {
      showFormError((error as Error | null)?.message || String(error || tt('settings_failed')))
    } finally {
      setBusy(false)
    }
  })
}

function renderProjectPicker() {
  if (!projectPickerEl) return
  // 只读分支（会话已锁定）：只展示锁定提示，不渲染项目列表/切换动作。项目 MCP 的管理已移到设置「管理 MCP」页。
  if (projectPickerReadOnly) {
    projectPickerEl.innerHTML = `
      <div class="project-picker-empty">${escapeHtml(tt('workdir_new_chat_only'))}</div>`
    return
  }
  const current = currentEditableProjectWorkdir()
  const currentWorkspaceId = currentEditableWorkspaceId()
  const items = projectPickerItems()
  const listHtml = items.length
    ? items.map(project => {
      const workdir = normalizeProjectWorkdir(project.workdir)
      // When a workspace is active its primary root equals `current`; suppress
      // the bare-project highlight so only the workspace row reads as selected.
      const selected = !currentWorkspaceId && !!workdir && workdir === current
      return `
        <button type="button" class="project-picker-item${selected ? ' is-selected' : ''}" data-project-workdir="${escapeHtml(workdir || '')}">
          <span class="project-picker-icon">${isSshProjectWorkdir(workdir) ? projectSshIconSvg() : projectFolderIconSvg()}</span>
          <span class="project-picker-label">${escapeHtml(project.name || workdir || '')}</span>
          ${selected ? `<span class="project-picker-check">${projectPickerCheckIconSvg()}</span>` : ''}
        </button>`
    }).join('')
    : `<div class="project-picker-empty">${escapeHtml(tt('project_picker_empty'))}</div>`
  // Workspace section: multi-folder containers, filtered by the same search box
  // (name or any root path). Shown above the bare-project list, stacked-folder
  // glyph marking them apart.
  const wsQuery = projectPickerSearch.trim().toLowerCase()
  const wsItems = projectWorkspaces.filter((ws) => !wsQuery
    || ws.name.toLowerCase().includes(wsQuery)
    || ws.roots.some((root) => root.toLowerCase().includes(wsQuery)))
  const workspaceListHtml = wsItems.length
    ? `<div class="project-picker-section-label">${escapeHtml(tt('workspace_section_label'))}</div>` + wsItems.map(ws => {
      const selected = ws.id === currentWorkspaceId
      return `
        <button type="button" class="project-picker-item${selected ? ' is-selected' : ''}" data-workspace-id="${escapeHtml(ws.id)}">
          <span class="project-picker-icon">${projectWorkspaceIconSvg()}</span>
          <span class="project-picker-label">${escapeHtml(ws.name || ws.roots[0] || '')}</span>
          ${selected ? `<span class="project-picker-check">${projectPickerCheckIconSvg()}</span>` : ''}
        </button>`
    }).join('') + `<div class="project-picker-separator"></div>`
    : ''
  const noProjectSelected = !current && !currentWorkspaceId
  projectPickerEl.innerHTML = `
    <label class="project-picker-search">
      <span class="project-picker-search-icon">${projectSearchIconSvg()}</span>
      <input type="search" value="${escapeHtml(projectPickerSearch)}" placeholder="${escapeHtml(tt('project_search_placeholder'))}" autocomplete="off">
    </label>
    ${workspaceListHtml}
    <div class="project-picker-list">${listHtml}</div>
    <div class="project-picker-separator"></div>
    <button type="button" class="project-picker-item project-picker-action" data-project-action="add">
      <span class="project-picker-icon">${projectAddIconSvg()}</span>
      <span class="project-picker-label">${escapeHtml(tt('project_add_new'))}</span>
    </button>
    <button type="button" class="project-picker-item project-picker-action" data-project-action="workspace">
      <span class="project-picker-icon">${projectWorkspaceIconSvg()}</span>
      <span class="project-picker-label">${escapeHtml(tt('workspace_set'))}</span>
    </button>
    <button type="button" class="project-picker-item project-picker-action" data-project-action="ssh">
      <span class="project-picker-icon">${projectSshIconSvg()}</span>
      <span class="project-picker-label">${escapeHtml(tt('project_connect_ssh'))}</span>
    </button>
    <button type="button" class="project-picker-item project-picker-action${noProjectSelected ? ' is-selected' : ''}" data-project-action="none">
      <span class="project-picker-icon">${projectNoProjectIconSvg()}</span>
      <span class="project-picker-label">${escapeHtml(tt('project_no_project'))}</span>
      ${noProjectSelected ? `<span class="project-picker-check">${projectPickerCheckIconSvg()}</span>` : ''}
    </button>`

  const input = projectPickerEl.querySelector('input')
  input?.addEventListener('input', () => {
    const caret = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length
    projectPickerSearch = input.value || ''
    renderProjectPicker()
    focusProjectPickerSearch(caret)
  })
  input?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeProjectPicker()
    }
  })
  projectPickerEl.querySelectorAll('[data-project-workdir]').forEach((item) => {
    item.addEventListener('click', async () => {
      const workdir = item.getAttribute('data-project-workdir') || ''
      try {
        await setProjectForCurrentNewConversation(workdir)
        closeProjectPicker()
      } catch (err) {
        console.warn('[projects] select failed:', err)
        await window.klausDialog.alert((err as Error | null)?.message || String(err))
      }
    })
  })
  projectPickerEl.querySelectorAll('[data-workspace-id]').forEach((item) => {
    item.addEventListener('click', async () => {
      const id = item.getAttribute('data-workspace-id') || ''
      try {
        await setWorkspaceForCurrentNewConversation(id)
        closeProjectPicker()
      } catch (err) {
        console.warn('[workspaces] select failed:', err)
        await window.klausDialog.alert((err as Error | null)?.message || String(err))
      }
    })
  })
  projectPickerEl.querySelector('[data-project-action="add"]')?.addEventListener('click', async () => {
    try {
      await addProjectFromProjectPicker()
      closeProjectPicker()
    } catch (err) {
      console.warn('[projects] add from picker failed:', err)
      await window.klausDialog.alert((err as Error | null)?.message || String(err))
    }
  })
  projectPickerEl.querySelector('[data-project-action="workspace"]')?.addEventListener('click', async () => {
    // The editor takes over interaction; collapse the picker first to avoid two
    // stacked popovers.
    closeProjectPicker()
    try {
      await openWorkspaceEditor(null)
    } catch (err) {
      console.warn('[workspaces] editor failed:', err)
      await window.klausDialog.alert((err as Error | null)?.message || String(err))
    }
  })
  projectPickerEl.querySelector('[data-project-action="ssh"]')?.addEventListener('click', async () => {
    // 弹窗接管交互，先收起 picker 避免两层浮层叠加。
    closeProjectPicker()
    try {
      await connectSshFromProjectPicker()
    } catch (err) {
      console.warn('[projects] ssh connect failed:', err)
      await window.klausDialog.alert((err as Error | null)?.message || String(err))
    }
  })
  projectPickerEl.querySelector('[data-project-action="none"]')?.addEventListener('click', async () => {
    try {
      await setProjectForCurrentNewConversation(null)
      closeProjectPicker()
    } catch (err) {
      console.warn('[projects] clear project failed:', err)
      await window.klausDialog.alert((err as Error | null)?.message || String(err))
    }
  })
}

async function openProjectPicker() {
  if (!btnWorkdir) return
  if (projectPickerEl) {
    closeProjectPicker()
    return
  }
  const readOnly = !canEditProjectForCurrentConversation()
  // 锁定（会话已发消息）态只弹 toast 提示，不展开项目选择器。
  if (readOnly) {
    window.showToast?.(tt('workdir_new_chat_only'))
    return
  }
  hideSlashMenu()
  hideComposerPlusMenu()
  mainModelApi?.close?.()
  if (!readOnly) await refreshProjectWorkspaces({ render: false, refreshWorkdir: false })
  projectPickerSearch = ''
  projectPickerReadOnly = readOnly
  projectPickerEl = document.createElement('div')
  projectPickerEl.className = `project-picker-popover${readOnly ? ' is-readonly' : ''}`
  projectPickerEl.setAttribute('role', 'dialog')
  projectPickerEl.setAttribute('aria-label', tt('project_picker_label'))
  document.body.appendChild(projectPickerEl)
  btnWorkdir.classList.add('open')
  btnWorkdir.setAttribute('aria-expanded', 'true')
  renderProjectPicker()
  positionProjectPicker()
  if (!readOnly) focusProjectPickerSearch()

  const onPointerDown = (event: PointerEvent) => {
    if (projectPickerEl?.contains(event.target as Node) || btnWorkdir?.contains(event.target as Node)) return
    closeProjectPicker()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeProjectPicker()
  }
  const onClose = () => closeProjectPicker()
  projectPickerCloseHandlers = { onPointerDown, onKeyDown, onClose }
  setTimeout(() => {
    if (!projectPickerEl) return
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose, true)
    document.addEventListener('scroll', onClose, true)
  }, 0)
}

async function addProjectFromPicker() {
  const next = await pickAndRegisterProjectWorkdir()
  if (!next) return
  try {
    await klausApi.projects?.setActive?.(next).catch((err: unknown) => console.warn('[projects] set active failed:', err))
    startProjectNewChat(next)
    await refreshProjectWorkspaces({ render: true, refreshWorkdir: true })
  } catch (err) {
    console.warn('[projects] add failed:', err)
  }
}

async function removeProject(project: { workdir: string; name: string }) {
  const workdir = normalizeProjectWorkdir(project?.workdir)
  if (!workdir) return
  const projectName = project?.name || basenameOf(workdir) || workdir
  const projectSessions = projectConversationSessions(workdir)
  const count = projectSessions.length
  const ok = await window.klausDialog.confirm({
    title: tt('project_remove_title'),
    message: tt('project_remove_message')
      .replace('{name}', projectName)
      .replace('{count}', String(count)),
    confirmText: tt('project_menu_remove'),
    danger: true,
  })
  if (!ok) return

  closeProjectMenu()
  const sessionIds = projectSessions.map((s) => s.id)
  const deletionResults = await Promise.allSettled(
    sessionIds.map(async (id: string) => {
      if (sessionDeletePending.has(id)) throw new Error(tt('session_cleanup_failed'))
      await deleteSession(id, { skipConfirm: true })
    }),
  )
  const deletedIds = new Set<string>()
  const failed: string[] = []
  deletionResults.forEach((result: PromiseSettledResult<unknown>, index: number) => {
    const id = sessionIds[index]
    if (result.status === 'fulfilled') deletedIds.add(id)
    else failed.push(result.reason?.message || String(result.reason || id))
  })

  if (failed.length > 0) {
    syncAfterProjectRemoval(workdir, deletedIds)
    await window.klausDialog.alert(`${tt('project_remove_failed')}: ${failed[0]}`)
    return
  }

  const state = await klausApi.projects?.remove?.(workdir).catch((err: unknown) => ({ error: String(err) }))
  if (state?.error) {
    syncAfterProjectRemoval(workdir, deletedIds)
    await window.klausDialog.alert(`${tt('project_remove_failed')}: ${state.error}`)
    return
  }

  projectRoots = Array.isArray(state?.roots)
    ? state.roots.map((root: string | { path?: string }) => typeof root === 'string' ? root : root?.path).filter((r: string | undefined): r is string => !!r)
    : projectRoots.filter((root) => normalizeProjectWorkdir(root) !== workdir)
  projectLabels = state?.labels && typeof state.labels === 'object'
    ? state.labels
    : Object.fromEntries(Object.entries(projectLabels).filter(([key]) => normalizeProjectWorkdir(key) !== workdir))
  // Dropping a project forgets every sidebar choice keyed to it: the show-more
  // flag, its page counter, and its persisted expansion entry.
  forgetProjectThreadListState(workdir)
  if (normalizeProjectWorkdir(activeProjectWorkdir) === workdir) {
    setActiveProjectWorkdir(null, { render: false, refreshWorkdir: false })
  }
  // 广播项目注册表变化：快捷指令页等消费方据此移除对应项目 tab。
  try { window.dispatchEvent(new CustomEvent('klaus:projects-changed')) } catch {}
  syncAfterProjectRemoval(workdir, deletedIds)
}

function syncAfterProjectRemoval(workdir: string | null, deletedIds: Set<string>) {
  const removedCurrent = !!window.currentSessionId && deletedIds.has(window.currentSessionId)
  const pendingWasProject = !window.currentSessionId && normalizeProjectWorkdir(pendingNewChatWorkdir) === workdir
  if (normalizeProjectWorkdir(pendingNewChatWorkdir) === workdir) pendingNewChatWorkdir = null
  if (removedCurrent) window.currentSessionId = null
  if (removedCurrent || pendingWasProject) {
    enterNewChatState({ workdir: null })
    return
  }
  renderSessionList()
  refreshWorkdirButton()
  renderTaskPanel()
  renderSubagentSection()
  renderContextPanel()
}

function startProjectNewChat(workdirOrKey: string | null) {
  // A workspace container's new-chat starts a workspace-bound chat.
  const workspaceId = workspaceIdFromKey(workdirOrKey)
  if (workspaceId) {
    startWorkspaceNewChat(workspaceId)
    return
  }
  const next = normalizeProjectWorkdir(workdirOrKey)
  // New chat is a draft: reveal the project but respect an explicit fold.
  revealProjectInSidebar('projects', next, { draft: true })
  setActiveProjectWorkdir(next, { render: false, refreshWorkdir: false })
  enterNewChatState({ workdir: next })
}

// New chat bound to a workspace: opens its container and drafts the workspace so
// ensureSession creates the session with cwd = primary root + extra roots.
function startWorkspaceNewChat(workspaceId: string) {
  const primary = workspacePrimaryRoot(workspaceId)
  if (!primary) return
  revealProjectInSidebar('projects', workspaceContainerKey(workspaceId), { draft: true })
  setActiveProjectWorkdir(null, { render: false, refreshWorkdir: false })
  enterNewChatState({ workdir: primary, workspaceId })
}

// Message presence is tri-state until authoritative history arrives. A title is
// presentation metadata and must never be used as transcript evidence: legacy
// sessions can contain full conversations while still carrying "New Chat".
function sessionMessagePresence(s: SessionInfo) {
  const stream = chatStreamStore.getState().sessions[s.id]
  return transcriptContentPresence({
    running: !!(stream?.running || runningSessions.has(s.id)),
    liveUnitCount: stream?.liveUnits?.length || 0,
    history: stream?.history,
  })
}

async function listArchivedSessions() {
  try {
    archivedSessions = (await klausApi.session.listArchived?.()) || []
  } catch (error) {
    console.warn('[sessions] failed to list archived sessions:', error)
    showToast(sessionActionErrorText((error as Error | null)?.message || error, 'archived_sessions_load_failed'))
  }
  return archivedSessions
}

// ==================== Unified task sidebar ====================

function sidebarSessionRowSpec(s: SessionInfo): SessionRowSpec {
  const working = isSidebarSessionWorking(s.id)
  const completeUnread = isSidebarSessionCompleteUnread(s.id)
  const friendUnread = sharedFriendUnread().countOf(s.id)
  // A friend message awaiting a reply already parks its own chip; only plain
  // unread friend news paints the row's blue dot.
  const friendDot = friendUnread > 0 && !sharedFriendUnread().wantReplyOf(s.id)
  const wait = sidebarSessionWait(s.id)
  const ch = detectChannelPrefix(s.id)
  const hasDraft = (sessionDrafts.get(s.id)?.text || '').trim().length > 0
  const scheduledLabel = tt('cron') || 'Scheduled'
  return {
    id: s.id,
    active: s.id === window.currentSessionId && !currentNonChatView,
    working,
    completeUnread,
    leadState: working ? 'working' : (completeUnread || friendDot ? 'unread' : 'read'),
    title: sessionDisplayTitle(s),
    channelLabel: ch ? tt('settings_ch_' + ch) : null,
    worktreeTitle: isWorktreeSessionWorkdir(s.workdir) ? (s.workdir || '') : null,
    automationLabel: automationSourceLabel(s, scheduledLabel),
    pinned: isPinnedSession(s),
    draft: hasDraft && sessionMessagePresence(s) === 'empty' && s.id !== window.currentSessionId,
    branchIconHtml: sessionBranchIconHtml(s),
    waitingKind: wait.count > 0 ? wait.kind : null,
    waitingCount: wait.count,
    snoozeDeadlineMs: wait.snooze?.deadlineMs ?? null,
    snoozeRequestId: wait.kind === 'input' ? (wait.snooze?.requestId ?? firstInputRequestId(s.id)) : null,
    unreadCount: (completeUnread ? 1 : 0) + friendUnread,
    friendAwaiting: friendUnread > 0 && sharedFriendUnread().wantReplyOf(s.id),
  }
}

/** The live/queued input request a Needs-input pill would snooze. A waiting
 *  session always has at least one live or queued request; prefer a live card's
 *  id so the snooze survives the queue-drain on switch-in. */
function firstInputRequestId(sessionId: string): string | null {
  const stream = getSessionStream(sessionId)
  for (const live of liveApprovalsOf(stream.liveUnits as unknown as Array<Record<string, unknown>>)) {
    if (live.kind === 'input') return live.requestId
  }
  for (const req of pendingElicitsBySession.get(sessionId) || []) return req.requestId
  for (const req of pendingPermissionsBySession.get(sessionId) || []) {
    if (req.toolName === 'AskUserQuestion') return req.requestId
  }
  return null
}

/** Thread rows for one open group, windowed by pagination.
 *
 *  Rows beyond the window are not rendered, but the active session is always
 *  appended if it falls outside (`forcedVisibleItemKey`), so opening a
 *  session can never leave it invisible in its own group. Project groups carry
 *  no timestamp: `hideThreadTimestamps:!0` is passed on
 *  exactly this path (`cAn`→`vAn`→`TAn`) and leaves its flat sections with one.
 *  Klaus flat sections never had timestamps, so nothing was added there. */
function projectThreadsWindow(key: string, groupSessions: SessionInfo[]) {
  const state = projectShowMoreState(key)
  const visible = projectThreadWindow(groupSessions, state, s => s.id === window.currentSessionId)
  const friendshipId = friendshipIdFromKey(key)
  return {
    rows: visible.map((session) => {
      const row = sidebarSessionRowSpec(session)
      return friendshipId
        ? { ...row, title: friendGroupThreadTitle(row.title, friendshipId, session.hostMetadata) }
        : row
    }),
    more: hasMoreProjectThreads(groupSessions.length, state),
  }
}

// Workspace containers: one row per workspace, its threads
// drawn from sessions bound to it (keyed by `ws:<id>`, so open-state and grouping
// never collide with the bare project at the same primary root). Rendered above
// the single-project rows with a stacked-folder glyph.
function workspaceRowsForSidebar() {
  return projectWorkspaces.map((ws) => {
    const key = workspaceContainerKey(ws.id)
    const closing = closingProjectThreadLists.has(key)
    const open = isProjectThreadListOpen(key) && !closing
    const justOpened = openingProjectThreadLists.delete(key)
    const wsSessions = (open || closing) ? workspaceConversationSessions(ws.id) : []
    const primary = workspacePrimaryRoot(ws.id) || ''
    return {
      key,
      name: ws.name || primary || ws.id,
      workdir: primary,
      ssh: false,
      isWorkspace: true,
      workspaceId: ws.id,
      active: !window.currentSessionId && currentEditableWorkspaceId() === ws.id,
      expanded: open,
      justOpened,
      closing,
      // While the exit animation plays the rows are still on screen (closing),
      // so the badge must wait until they are actually gone.
      collapsedBadge: (open || closing) ? null : projectCollapsedBadge(key),
      threads: (open || closing) && wsSessions.length > 0 ? projectThreadsWindow(key, wsSessions) : null,
    }
  })
}

/** Paint the Projects section in the user's dragged order.
 *
 *  An optimistic order that is still in flight wins over the durable one, so the
 *  drop takes effect on the frame it lands instead of waiting for a round trip to
 *  the host. `reconcileOrder` guarantees the result holds exactly the rows that
 *  exist now, once each, whichever order row it starts from. */
function orderProjectRows<T extends { key: string }>(rows: T[]): T[] {
  const order = sidebarProjectOrderPending ?? sidebarProjectOrder
  if (order.length === 0) return rows
  const byKey = new Map(rows.map(row => [row.key, row]))
  const ordered = reconcileOrder(order, rows.map(row => row.key))
    .flatMap(key => {
      const row = byKey.get(key)
      return row === undefined ? [] : [row]
    })
  // A row that the reconciled order somehow missed still has to be painted:
  // losing a project from the sidebar is worse than painting it out of order.
  const painted = new Set(ordered.map(row => row.key))
  for (const row of rows) if (!painted.has(row.key)) ordered.push(row)
  return ordered
}

/** The dragged Projects order, committed optimistically and rolled back if the
 *  host rejects it.
 *
 *  Three rules, each of which a plain fire-and-forget write breaks:
 *
 *   1. The UI never waits on IPC. The new order is applied and painted on the
 *      frame the drop lands, and only the durable write trails.
 *   2. Writes are chained. Two drops in quick succession issue two calls;
 *      unserialized they can land out of order and leave settings.db holding the
 *      OLDER arrangement, so the next launch restores a drag the user undid.
 *      Chaining makes the last drop win.
 *   3. A rollback is guarded. A failed older write must not revert a newer drop
 *      that has since been applied, so the revert only happens when the failed
 *      order is still the live one. */
let sidebarProjectOrderWrite: Promise<void> = Promise.resolve()

function commitSidebarProjectOrder(keys: string[]) {
  const previous = sidebarProjectOrder
  sidebarProjectOrderPending = keys
  sidebarProjectOrder = keys
  sidebarProjectOrderRevision += 1
  // Captured NOW, before the write is queued. The guard below compares this
  // against the live revision when the write settles: if a second drop landed
  // while this one was in flight it bumped the revision, and this (older) write
  // must neither adopt its own host answer nor roll back — the newer drop owns
  // the live order. Capturing after the await instead would make the two values
  // always equal and silently defeat the guard.
  const myRevision = sidebarProjectOrderRevision
  persistLocalValue(SIDEBAR_PROJECT_ORDER_MIRROR_KEY, JSON.stringify(keys))
  renderSessionList()
  sidebarProjectOrderWrite = sidebarProjectOrderWrite.then(async () => {
    try {
      const state = await klausApi.projects?.reorder?.(keys)
      if (!state || state.error) throw new Error(String(state?.error ?? 'projects:reorder failed'))
      // The host answer carries the registry's own order; adopting it keeps the
      // two rows in step without a second read.
      if (mayApplyAsyncState(myRevision, sidebarProjectOrderRevision)) {
        const stored = Array.isArray(state.sidebarOrder) ? parseStoredOrder(state.sidebarOrder) : []
        if (stored.length > 0) {
          sidebarProjectOrder = stored
          persistLocalValue(SIDEBAR_PROJECT_ORDER_MIRROR_KEY, JSON.stringify(stored))
        }
        sidebarProjectOrderPending = null
        renderSessionList()
      }
    } catch (error) {
      // Revert only when the failed order is still the live one; a newer drop has
      // already replaced it and must survive this failure.
      if (mayApplyAsyncState(myRevision, sidebarProjectOrderRevision)) {
        sidebarProjectOrder = previous
        sidebarProjectOrderPending = null
        persistLocalValue(SIDEBAR_PROJECT_ORDER_MIRROR_KEY, JSON.stringify(previous))
        renderSessionList()
      }
      const message = (error as Error | null)?.message || String(error)
      showToast(`${tt('project_reorder_failed')}: ${message}`)
    }
  })
}

/** Adopt an order pushed from another window. Equal values are the echo of this
 *  window's own write and must not disturb an in-flight drag. */
async function applyRemoteSidebarProjectOrder() {
  const revision = sidebarProjectOrderRevision
  try {
    const state = await klausApi.projects?.list?.()
    // A drop landed while the read was in flight, or a write is still pending:
    // this window's own order wins.
    if (!mayApplyAsyncState(revision, sidebarProjectOrderRevision)) return
    if (sidebarProjectOrderPending !== null) return
    const stored = parseStoredOrder((state as { sidebarOrder?: unknown } | null | undefined)?.sidebarOrder)
    if (stored.length === 0) return
    if (JSON.stringify(stored) === JSON.stringify(sidebarProjectOrder)) return
    sidebarProjectOrder = stored
    persistLocalValue(SIDEBAR_PROJECT_ORDER_MIRROR_KEY, JSON.stringify(stored))
    renderSessionList()
  } catch {
    // A failed cross-window refresh leaves this window's order untouched.
  }
}

function buildSidebarSnapshot() {
  const partitions = partitionSidebarSessions(sessions, sessionId => !!detectChannelPrefix(sessionId))
  const sortMode = sidebarSortMode
  const friendRows = friendRowsForSidebar().map(friend => {
    const key = friendGroupKey(friend.id)
    const closing = closingProjectThreadLists.has(key)
    const open = isProjectThreadListOpen(key) && !closing
    const justOpened = openingProjectThreadLists.delete(key)
    const friendSessions = (open || closing) ? friendConversationSessions(friend.id) : []
    return {
      key,
      name: friend.name,
      workdir: '',
      ssh: false,
      isFriend: true,
      pendingCount: friendGroupAttentionCount(friend.id),
      active: false,
      expanded: open,
      justOpened,
      closing,
      collapsedBadge: (open || closing) ? null : projectCollapsedBadge(key),
      threads: (open || closing) && friendSessions.length > 0 ? projectThreadsWindow(key, friendSessions) : null,
    }
  })
  const projects = [...workspaceRowsForSidebar(), ...friendRows, ...projectRowsFromSessions().map(project => {
    const key = normalizeProjectWorkdir(project.workdir)!
    const closing = closingProjectThreadLists.has(key)
    const open = isProjectThreadListOpen(key) && !closing
    const justOpened = openingProjectThreadLists.delete(key)
    const projectSessions = (open || closing) ? projectConversationSessions(key) : []
    return {
      key,
      name: project.name,
      workdir: project.workdir,
      ssh: isSshProjectWorkdir(key),
      active: !window.currentSessionId && (normalizeProjectWorkdir(pendingNewChatProjectRoot) || selectedProjectWorkdir()) === key,
      expanded: open,
      justOpened,
      closing,
      // While the exit animation plays the rows are still on screen (closing),
      // so the badge must wait until they are actually gone.
      collapsedBadge: (open || closing) ? null : projectCollapsedBadge(key),
      threads: (open || closing) && projectSessions.length > 0 ? projectThreadsWindow(key, projectSessions) : null,
    }
  })]
  // Apply the user's dragged order last. Rows are built in their natural order
  // (workspace containers, friend groups, plain projects) because each builder
  // reads a different source; the stored order is what decides where they land.
  // `reconcileOrder` also drops keys whose row vanished and lifts keys nobody has
  // arranged yet to the head, so a row can never be lost or duplicated by a stale
  // order row.
  const orderedProjects = orderProjectRows(projects)
  return {
    sortMode,
    sortMenuOpen: sidebarSortMenuOpen,
    pinned: {
      rows: sortSessionRows(partitions.pinned.map(sidebarSessionRowSpec), sortMode),
      collapsed: isSidebarSectionCollapsed('pinned'),
      collapsedBadge: isSidebarSectionCollapsed('pinned') ? sectionCollapsedBadge('pinned') : null,
    },
    channels: {
      rows: sortSessionRows(partitions.channels.map(sidebarSessionRowSpec), sortMode),
      collapsed: isSidebarSectionCollapsed('channels'),
      collapsedBadge: isSidebarSectionCollapsed('channels') ? sectionCollapsedBadge('channels') : null,
    },
    projects: {
      rows: orderedProjects,
      collapsed: isSidebarSectionCollapsed('projects'),
      collapsedBadge: isSidebarSectionCollapsed('projects') ? sectionCollapsedBadge('projects') : null,
      reorderPending: sidebarProjectOrderPending !== null,
    },
    recent: {
      rows: sortSessionRows(projectlessConversationSessions().map(sidebarSessionRowSpec), sortMode),
      collapsed: isSidebarSectionCollapsed('recent'),
      collapsedBadge: isSidebarSectionCollapsed('recent') ? sectionCollapsedBadge('recent') : null,
    },
  }
}

/** Priority ordering applies INSIDE each section: section membership and pinned
 *  order are structural, the attention sort only reorders members (it applies
 *  `rI` per group, never across its Pinned/Recent split). */
function sortSessionRows(rows: SessionRowSpec[], mode: SidebarSortMode): SessionRowSpec[] {
  if (mode !== 'priority') return rows
  const recencyById = new Map(sessions.map(s => [s.id, s.updatedAt] as const))
  return sortSectionRows(
    rows.map(row => ({
      ...row,
      attention: sessionAttentionState({
        waitingKind: row.waitingKind,
        waitingCount: row.waitingCount,
        unread: row.completeUnread,
        working: row.working,
        unreadCount: row.unreadCount,
      }) as 'waiting' | 'unread' | 'active' | 'idle',
      recencyAt: recencyById.get(row.id) ?? 0,
    })),
    mode,
  ) as SessionRowSpec[]
}

const sidebarApi = mountSidebar({
  rootEl: sessionListEl,
  actions: {
    switchSession: (id: string) => switchSession(id),
    showContextMenu: (event: MouseEvent, sessionId: string, rowEl) => {
      const session = sessions.find((candidate) => candidate.id === sessionId)
      if (session) showSessionContextMenu(event, session, rowEl)
    },
    toggleProject: (workdir) => toggleProjectSidebarItem(workdir),
    projectMenu: (key: string, anchor: HTMLElement, point: { x: number; y: number } | null) => {
      const workspaceId = workspaceIdFromKey(key)
      if (workspaceId) {
        const workspace = workspaceById(workspaceId)
        if (workspace) openWorkspaceEditor({ id: workspace.id, name: workspace.name, roots: workspace.roots })
        return
      }
      // A friend folder owns no registry entry: no rename, no removal, no MCP
      // scope. It does own one setting of its own: muting arrival notifications.
      if (isFriendStateKey(key)) {
        showFriendFolderMenu(key, anchor, point)
        return
      }
      const project = projectRowsFromSessions().find((candidate) => normalizeProjectWorkdir(candidate.workdir) === key)
      if (project) showProjectMenu(project, anchor, point)
    },
    projectNewChat: (workdir) => { if (!isFriendStateKey(workdir)) startProjectNewChat(workdir) },
    // Pagination: each press reveals ten more rows and there is no
    // "show less" inside a project group.
    showMoreThreads: (key: string) => projectShowMorePress(key),
    toggleSection: (section) => toggleSidebarSection(section),
    addProjectFromSection: () => { void pickAndRegisterProjectWorkdir() },
    projectCloseFinished: (key: string) => projectSidebarCloseFinished(key),
    reorderProjects: (keys: string[]) => commitSidebarProjectOrder(keys),
    snoozeInput: (sessionId: string, requestId: string) => snoozeSidebarInputRequest(sessionId, requestId),
    openSortMenu: (anchor: HTMLElement) => {
      // Clicking the trigger again closes the open menu (toggle).
      if (sidebarSortMenu) closeSidebarSortMenu()
      else openSidebarSortMenu(anchor)
    },
  },
})

/** Snooze a Needs-input wait (`snoozeInputTimeout`): hide the pill and the
 *  waiting sort position for 60s, then the request resurfaces on its own. The
 *  pill's countdown fill tracks the same deadline. */
function snoozeSidebarInputRequest(sessionId: string, requestId: string) {
  if (!sessionId || !requestId) return
  snoozeInputRequest(requestId)
  renderSessionList()
  // Wake the wait back up when the deadline passes so the pill returns without
  // any user action (the reminder restarts after the snooze window).
  window.setTimeout(() => {
    if (!takeExpiredSnooze(requestId)) return
    if (sidebarSessionWait(sessionId).count > 0) renderSessionList()
  }, INPUT_SNOOZE_MS + 50)
}

/** Drop a deleted session's snooze ledger entries (the row's state goes
 *  with the row). */
function forgetSessionInputSnoozes(sessionId: string) {
  const requestIds = [
    ...(pendingPermissionsBySession.get(sessionId) || []).map(req => req.requestId),
    ...(pendingElicitsBySession.get(sessionId) || []).map(req => req.requestId),
  ]
  forgetInputSnoozes(requestIds)
}

// Command-menu data surface (global search panel, mounted as a
// React island from src/chat/command-menu/host.tsx). The panel's whole point is
// reaching a conversation without walking the sidebar, so its session source is
// the FULL list in sidebar section order — pinned, channels, every project
// container's threads, then project-less recents — never the snapshot's
// rendered rows: a folded section or a paginated project group must not hide a
// conversation from search.
function commandMenuVisibleSessions() {
  const partitions = partitionSidebarSessions(sessions, sessionId => !!detectChannelPrefix(sessionId))
  const ordered: SessionInfo[] = []
  const push = (session: SessionInfo) => {
    if (!ordered.some(candidate => candidate.id === session.id)) ordered.push(session)
  }
  for (const session of partitions.pinned) push(session)
  for (const session of partitions.channels) push(session)
  // Project containers in sidebar order: workspace containers first, then
  // single-project rows. Enumerated straight from the registries — the sidebar
  // row builders consume one-shot open-animation flags, so they must not run
  // on the search path.
  for (const workspace of projectWorkspaces) {
    for (const session of workspaceConversationSessions(workspace.id)) push(session)
  }
  // Friend folders sit between workspace containers and project rows in the
  // sidebar, and a friend conversation files under its folder alone: without
  // this loop the search could only reach one incidentally, through an
  // execution-location container it no longer lists under.
  for (const friend of friendRowsForSidebar()) {
    for (const session of friendConversationSessions(friend.id)) push(session)
  }
  for (const project of projectRowsFromSessions()) {
    for (const session of projectConversationSessions(project.workdir)) push(session)
  }
  for (const session of projectlessConversationSessions()) push(session)
  return ordered
}

function commandMenuProjectLabel(session: SessionInfo): string | null {
  // A friend task conversation files under its friendship folder, so the search
  // row names the friend rather than the execution directory or workspace.
  if (session.friendGroupId) return friendDirectoryName(session.friendGroupId)
  const key = session.workspaceId ? workspaceContainerKey(session.workspaceId) : normalizeProjectWorkdir(session.projectRoot ?? session.workdir)
  if (!key) return null
  const workspace = session.workspaceId ? workspaceById(session.workspaceId) : null
  if (workspace) return workspace.name || workspacePrimaryRoot(workspace.id) || null
  const project = projectRowsFromSessions().find(candidate => normalizeProjectWorkdir(candidate.workdir) === key)
  return project?.name || null
}

;(window as any).klausCommandMenu = {
  sessions: () => commandMenuVisibleSessions().map(session => ({
    id: session.id,
    title: sessionDisplayTitle(session),
    projectLabel: commandMenuProjectLabel(session),
    pinned: isPinnedSession(session),
    updatedAt: session.updatedAt,
  })),
  newChat: () => { newChat() },
  openFolder: () => { void pickAndRegisterProjectWorkdir() },
}

// Keybinding command actions. The keymap runtime (app/keybindings/runtime.ts)
// dispatches command ids; this block is where each id meets the function that
// already implements it, so there is exactly one path per action — the same one
// the sidebar buttons and context menus use. Anything not listed here has no
// handler and is therefore neither dispatchable nor shown in the shortcut
// overview (both are gated the same way).
;(window as any).klausKeybindingActions = {
  findInThread: () => {
    if (!document.hasFocus() && isBrowserPanelVisible()) lastContentFindSurface = 'panel'
    if ((window as any).klausSpecPanelRunFind?.()) { currentContentFind.close(); return }
    if (lastContentFindSurface === 'panel' && (window as any).klausWorkspaceRunFind?.()) { currentContentFind.close(); return }
    void currentContentFind.open()
  },
  closeContentFind: () => currentContentFind.close(),
  newProject: () => { void addProjectFromPicker() },
  navigateBack: () => { void navigateChatHistory(-1) },
  navigateForward: () => { void navigateChatHistory(1) },
  previousTab: () => { void (window.KlausPanelTabs as any)?.step?.(-1) },
  nextTab: () => { void (window.KlausPanelTabs as any)?.step?.(1) },
  newBrowserTab: () => { void (window as any).klausNewBrowserTab?.() },
  focusBrowserAddressBar: () => {
    const host = window as any
    void Promise.resolve(host.klausOpenBrowserTab?.({ tabId: host.klausActiveBrowserTabId?.() || undefined })).then(() => {
      const input = document.getElementById('browser-url-input') as HTMLInputElement | null
      input?.focus(); input?.select()
    })
  },
  reloadBrowserPage: () => { document.getElementById('browser-reload')?.click() },
  newChat: () => { document.getElementById('btn-new-chat')?.click() },
  openFolder: () => { void pickAndRegisterProjectWorkdir() },
  renameThread: () => { const id = window.currentSessionId; if (id) void renameSessionFromMenu(id) },
  archiveThread: () => { const id = window.currentSessionId; if (id) void archiveSessionFromMenu(id) },
  toggleThreadPin: () => {
    const id = window.currentSessionId
    const session = sessions.find(candidate => candidate.id === id)
    if (session) void toggleSessionPinned(session)
  },
  forkThread: () => { const id = window.currentSessionId; if (id) void forkSessionFromMenu(id) },
  previousThread: () => { stepSession(-1) },
  nextThread: () => { stepSession(1) },
  nextThreadNeedingAttention: () => { void stepSessionNeedingAttention() },
  // Sidebar order is the command menu's visible-session order, which is exactly
  // the list ⌘1–9 numbers.
  sessionAt: (index: number) => {
    const ordered = commandMenuVisibleSessions()
    const session = ordered[index]
    if (session) void switchSession(session.id)
  },
  openCommandMenu: () => { document.getElementById('titlebar-search')?.click() },
  searchFiles: () => { (window as any).klausOpenCommandMenuInFilesMode?.() },
  toggleSidebar: () => { document.getElementById('sidebar-toggle')?.click() },
  toggleWorkPanel: () => { document.getElementById('artifacts-panel-toggle')?.click() },
  toggleTerminal: () => { document.getElementById('terminal-toggle')?.click() },
  toggleFilesPanel: () => { document.getElementById('workspace-panel-toggle')?.click() },
  toggleChangesPanel: () => { document.getElementById('btn-diff')?.click() },
  toggleOverviewPanel: () => { document.getElementById('monitor-panel-toggle')?.click() },
  toggleBrowserPanel: () => { document.getElementById('browser-panel-toggle')?.click() },
  settings: () => { openSettings() },
  keyboardShortcuts: () => { openSettings('keyboard') },
  openSkills: () => { document.getElementById('btn-skills')?.click() },
  openSlashCommands: () => { document.getElementById('btn-slash-commands')?.click() },
  openAgents: () => { document.getElementById('btn-agents')?.click() },
  openMcp: () => { document.getElementById('btn-mcp')?.click() },
  openPlugins: () => { document.getElementById('btn-plugins')?.click() },
  openChannels: () => { document.getElementById('btn-channels')?.click() },
  openCron: () => { document.getElementById('btn-cron')?.click() },
  openMemory: () => { document.getElementById('btn-memory')?.click() },
  showKeyboardShortcuts: () => { (window as any).klausShowKeyboardShortcutsDialog?.() },
  logOut: () => { document.getElementById('menu-logout')?.click() },
}

const chatNavigation = new SessionNavigation()
let lastContentFindSurface: 'chat' | 'panel' = 'chat'
const currentFindScope = () => {
  const panel = document.getElementById('artifacts-panel')
  if (lastContentFindSurface === 'panel' && panel && !panel.classList.contains('collapsed')) {
    if (panel.dataset.mode === 'workspace') return document.getElementById('workspace-file-body')
    if (panel.dataset.mode === 'diff') return document.getElementById('diff-view-content')
    if (panel.dataset.mode === 'spec') return document.getElementById('spec-panel')
  }
  return messagesEl
}
const currentFindIsNative = () => lastContentFindSurface === 'panel' && isBrowserPanelVisible()
const currentContentFind = createContentFind({
  scope: currentFindScope, chinese: () => window.currentLang === 'zh', nativeTarget: currentFindIsNative,
  nativeFind: (query, options) => klausApi.app.findContent(query, options), stopNativeFind: () => klausApi.app.stopContentFind(),
  document: () => lastContentFindSurface === 'panel' ? (window as any).klausWorkspaceFindDocument?.() ?? null : null,
  mount: () => {
    if (currentFindIsNative()) return document.getElementById('monitor-section-browser')
    const root = currentFindScope(), parent = root?.parentElement
    if (!parent) return null
    let slot = parent.querySelector<HTMLElement>(':scope > [data-content-find-slot]')
    if (!slot) {
      slot = document.createElement('div'); slot.dataset.contentFindSlot = ''
      parent.insertBefore(slot, root === messagesEl ? document.getElementById('header')?.nextSibling ?? root : root)
    }
    return slot
  },
  onLayout: scheduleBrowserBoundsSync,
})
const rememberFindSurface = (event: Event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (target.closest('#artifacts-panel,[aria-controls="artifacts-panel"]')) lastContentFindSurface = 'panel'
  else if (target.closest('#main')) lastContentFindSurface = 'chat'
}
document.addEventListener('pointerdown', rememberFindSurface, true)
document.addEventListener('focusin', rememberFindSurface, true)
window.addEventListener('klaus:session-change', () => { currentContentFind.close(); lastContentFindSurface = 'chat' })
window.addEventListener('beforeunload', () => {
  currentContentFind.dispose()
  document.removeEventListener('pointerdown', rememberFindSurface, true)
  document.removeEventListener('focusin', rememberFindSurface, true)
}, { once: true })
;(window as any).klausContentFindNavigation = (direction: 'next' | 'previous') => {
  if ((window as any).klausSpecPanelRunFind?.(direction)) return
  if (lastContentFindSurface === 'panel' && (window as any).klausWorkspaceRunFind?.(direction)) return
  if (currentContentFind.isOpen()) void (direction === 'next' ? currentContentFind.next() : currentContentFind.previous())
}
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.altKey) return
  if (event.key === 'Escape' && currentContentFind.isOpen()) { event.preventDefault(); currentContentFind.close(); return }
  if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') || event.key === 'F3') {
    if (!currentContentFind.isOpen()) return
    event.preventDefault(); (window as any).klausContentFindNavigation(event.shiftKey ? 'previous' : 'next')
  }
})
let chatNavigationBusy = false
async function navigateChatHistory(delta: number) {
  if (chatNavigationBusy) return
  chatNavigation.retain(new Set(sessions.map(session => session.id)))
  const target = chatNavigation.move(delta)
  if (target === undefined) return
  chatNavigationBusy = true
  try {
    if (target === null) enterNewChatState()
    else await switchSession(target)
  } catch (error) {
    chatNavigation.move(-delta)
    showToast(String((error as Error).message || error))
  } finally { chatNavigationBusy = false; publishNativeMenuState() }
}

let lastNativeMenuState = ''
function publishNativeMenuState() {
  const disabled = (id: string) => (document.getElementById(id) as HTMLButtonElement | null)?.disabled === true
  const state: NativeMenuState = {
    newProject: typeof klausApi.projects?.add === 'function',
    terminal: !!window.currentSessionId && !disabled('terminal-toggle'),
    browser: !disabled('browser-panel-toggle') && typeof (window as any).klausNewBrowserTab === 'function',
    reloadBrowserPage: !!(window as any).klausActiveBrowserTabId?.() && !disabled('browser-reload'),
    navigateBack: !chatNavigationBusy && chatNavigation.canMove(-1),
    navigateForward: !chatNavigationBusy && chatNavigation.canMove(1),
    previousTab: (window.KlausPanelTabs as any)?.canStep?.() === true,
    nextTab: (window.KlausPanelTabs as any)?.canStep?.() === true,
  }
  const serialized = JSON.stringify(state)
  if (serialized === lastNativeMenuState) return
  lastNativeMenuState = serialized
  void klausApi.app.reportNativeMenuState(state).catch(() => { if (lastNativeMenuState === serialized) lastNativeMenuState = '' })
}
window.addEventListener('klaus:session-change', () => {
  chatNavigation.observe(window.currentSessionId || null)
  publishNativeMenuState()
})
window.addEventListener('klaus:panel-tabs-change', publishNativeMenuState)
window.addEventListener('focus', publishNativeMenuState)
const nativeMenuObserver = new MutationObserver(publishNativeMenuState)
for (const id of ['terminal-toggle', 'browser-panel-toggle', 'browser-reload']) {
  const control = document.getElementById(id)
  if (control) nativeMenuObserver.observe(control, { attributes: true, attributeFilter: ['disabled', 'hidden'] })
}
window.addEventListener('beforeunload', () => nativeMenuObserver.disconnect(), { once: true })
queueMicrotask(publishNativeMenuState)

;(window as any).klausMenuHelp = {
  documentation: () => { void window.klausOpenExternalUrl?.(desktopSiteUrl(window.currentLang === 'zh' ? '/docs/desktop/overview' : '/en/docs/desktop/overview')) },
  whatsNew: () => { void window.klausOpenExternalUrl?.(desktopSiteUrl(window.currentLang === 'zh' ? '/updates' : '/en/updates')) },
  feedback: () => { document.getElementById('menu-feedback')?.click() },
}

// Move through the sidebar's visible order, wrapping at both ends.
// previousThread/nextThread do the same over the thread list.
function stepSession(delta: number) {
  const ordered = commandMenuVisibleSessions()
  if (ordered.length === 0) return
  const currentIndex = ordered.findIndex(session => session.id === window.currentSessionId)
  if (currentIndex === -1) {
    void switchSession(ordered[0]!.id)
    return
  }
  const next = (currentIndex + delta + ordered.length) % ordered.length
  const session = ordered[next]
  if (session) void switchSession(session.id)
}

// `nextThreadNeedingAttention`: jump to the first conversation waiting
// for the user (any parked request) or unread, ranked by attention then recency.
function stepSessionNeedingAttention(): boolean {
  const ranked = allSidebarRowSpecs()
    .filter(row => row.waitingCount > 0 || row.completeUnread)
    .map(row => ({
      row,
      attention: sessionAttentionState({
        waitingKind: row.waitingKind,
        waitingCount: row.waitingCount,
        unread: row.completeUnread,
        working: row.working,
        unreadCount: row.unreadCount,
      }),
      recencyAt: sessions.find(s => s.id === row.id)?.updatedAt ?? 0,
    }))
    .sort(compareByAttentionState)
  const currentId = window.currentSessionId
  // Advance past the current conversation so repeated presses cycle through the
  // needs-attention list (jumping to the top-ranked one; the current
  // session is not a candidate because it is neither waiting nor unread).
  const target = ranked.find(entry => entry.row.id !== currentId)
  if (!target) return false
  void switchSession(target.row.id)
  return true
}

function renderSessionList() {
  const snapshot = buildSidebarSnapshot()
  for (const pending of pendingComposerSubmissions.values()) {
    if (pending.sessionId) continue
    const row = sidebarSessionRowSpec({ id: pending.viewId, title: pending.draft.text.trim().slice(0, 120) || tt('new_chat'),
      createdAt: pending.startedAtMs, updatedAt: pending.startedAtMs, workdir: pending.workdir })
    row.active = window.currentSessionId === null && visiblePendingSubmissionId === pending.id && !currentNonChatView
    row.working = pending.phase === 'preparing' || pending.phase === 'submitting'
    row.leadState = row.working ? 'working' : 'read'
    row.draft = false
    const key = pending.workspaceId ? workspaceContainerKey(pending.workspaceId) : normalizeProjectWorkdir(pending.projectRoot || pending.workdir)
    const project = snapshot.projects.rows.find(project => project.key === key)
    if (project) {
      project.expanded = true
      project.threads = { rows: [row, ...(project.threads?.rows || [])], more: project.threads?.more || false }
    } else snapshot.recent.rows.unshift(row)
  }
  sidebarApi?.render(snapshot)
  syncTitlebarSessionTitle()
  updateCronNavBadge()
  syncSidebarToolbar()
  if (sidebarActivityOpen) renderSidebarActivityView()
}

// ==================== sidebar sort mode (sortMenu) ====================
//
// 'updated_at' is the historical order (host snapshot order). 'priority' ranks
// every section waiting > unread > active > idle. The choice is a localStorage
// first-paint mirror like the other sidebar state; the menu lives in the
// sidebar header (activity view trigger + sort entry).

let sidebarSortMode: SidebarSortMode = readStoredSortMode()

function setSidebarSortMode(mode: SidebarSortMode) {
  if (sidebarSortMode === mode) return
  sidebarSortMode = mode
  storeSortMode(mode)
  renderSessionList()
  syncSidebarToolbar()
  window.dispatchEvent(new CustomEvent('klaus:sidebar-sort-changed', { detail: { mode } }))
}

// ==================== activity view (priorityThreads) ====================
//
// The Priority entry opens a filtered overlay over the conversation list: only
// conversations that need attention — waiting first, then unread, then running —
// grouped by that order, with an empty state, mark-all-read and per-session
// rows that reuse the regular switch path. The same trio ships here
// (coachmark "See chats that are unread, active, or awaiting a response",
// "Nothing needs attention" empty state, "Mark all as read" bulk action).

let sidebarActivityOpen = false
let sidebarActivityView: HTMLElement | null = null

function attentionSectionsOf(rows: SessionRowSpec[]): Array<{ key: 'waiting' | 'unread' | 'active'; label: string; rows: SessionRowSpec[] }> {
  const waiting: SessionRowSpec[] = []
  const unread: SessionRowSpec[] = []
  const active: SessionRowSpec[] = []
  for (const row of rows) {
    if (row.waitingCount > 0) waiting.push(row)
    else if (row.completeUnread) unread.push(row)
    else if (row.working) active.push(row)
  }
  const sections: Array<{ key: 'waiting' | 'unread' | 'active'; label: string; rows: SessionRowSpec[] }> = []
  if (waiting.length > 0) sections.push({ key: 'waiting', label: tt('activity_section_needs_input'), rows: waiting })
  if (unread.length > 0) sections.push({ key: 'unread', label: tt('activity_section_unread'), rows: unread })
  if (active.length > 0) sections.push({ key: 'active', label: tt('activity_section_active'), rows: active })
  return sections
}

/** Every conversation row the sidebar knows about, in section order — the
 *  activity view's and the attention-jump command's candidate pool. Built from
 *  session state, never from rendered rows: collapsed project groups and
 *  pagination windows do not build thread rows, yet a session hidden inside
 *  them must still surface as running/waiting/unread here. The
 *  global attention list is projected from the whole thread store the same way; the pinned,
 *  channel and un-pinned local partitions are disjoint and cover `sessions`. */
function allSidebarRowSpecs(): SessionRowSpec[] {
  const partitions = partitionSidebarSessions(sessions, sessionId => !!detectChannelPrefix(sessionId))
  const rows: SessionRowSpec[] = []
  for (const session of partitions.pinned) rows.push(sidebarSessionRowSpec(session))
  for (const session of partitions.channels) rows.push(sidebarSessionRowSpec(session))
  for (const session of groupedLocalSessions()) rows.push(sidebarSessionRowSpec(session))
  return rows
}

function toggleSidebarActivityView(force?: boolean) {
  const next = force ?? !sidebarActivityOpen
  if (next === sidebarActivityOpen) return
  sidebarActivityOpen = next
  syncSidebarToolbar()
  if (next) renderSidebarActivityView()
  else sidebarActivityView?.remove(), sidebarActivityView = null
  const btn = document.getElementById('titlebar-activity')
  btn?.setAttribute('aria-pressed', next ? 'true' : 'false')
}

function closeSidebarActivityView() {
  if (!sidebarActivityOpen) return
  toggleSidebarActivityView(false)
}

function renderSidebarActivityView() {
  // Refresh the rows without changing the user's activity-view toggle.
  sidebarActivityView?.remove()
  sidebarActivityView = null
  const scroller = document.getElementById('sidebar-scroll')
  if (!scroller) return
  const view = document.createElement('div')
  view.className = 'sidebar-activity-view'
  const all = allSidebarRowSpecs().filter(row =>
    row.waitingCount > 0 || row.unreadCount > 0 || row.working)
  if (all.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'sidebar-activity-empty'
    empty.textContent = tt('activity_empty') || 'Nothing needs attention'
    view.appendChild(empty)
  } else {
    for (const section of attentionSectionsOf(all)) {
      const head = document.createElement('div')
      head.className = 'sidebar-activity-section-head'
      head.textContent = section.label
      view.appendChild(head)
      for (const row of section.rows) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'sidebar-activity-row' + (row.waitingCount > 0 ? ' is-waiting' : '')
        btn.setAttribute('data-session-id', row.id)
        const title = document.createElement('span')
        title.className = 'sidebar-activity-row-title'
        title.textContent = row.title
        btn.appendChild(title)
        if (row.waitingCount > 0) {
          const tag = document.createElement('span')
          tag.className = 'sidebar-activity-tag ' + (row.waitingKind === 'input' ? 'is-input' : 'is-approval')
          tag.textContent = row.waitingKind === 'input'
            ? (tt('session_needs_input') || 'Needs input')
            : (tt('session_awaiting_approval') || 'Awaiting approval')
          btn.appendChild(tag)
        } else if (row.working) {
          const tag = document.createElement('span')
          tag.className = 'sidebar-activity-row-meta'
          tag.textContent = tt('agent_status_running') || 'Running'
          btn.appendChild(tag)
        } else if (row.unreadCount > 0 && !row.completeUnread) {
          const tag = document.createElement('span')
          tag.className = 'sidebar-activity-tag is-friend'
          tag.textContent = tt('sidebar_activity_friend') || 'Friend message'
          btn.appendChild(tag)
        }
        btn.addEventListener('click', () => {
          void switchSession(row.id)
        })
        view.appendChild(btn)
      }
    }
    const footer = document.createElement('div')
    footer.className = 'sidebar-activity-footer'
    const markAll = document.createElement('button')
    markAll.type = 'button'
    markAll.className = 'sidebar-activity-mark-all'
    markAll.textContent = tt('activity_mark_all_read') || 'Mark all as read'
    markAll.addEventListener('click', () => {
      for (const session of sessions) {
        if (isSidebarSessionCompleteUnread(session.id)) markSidebarSessionSeen(session.id, { render: false })
      }
      persistSidebarCompletedSessions()
      sharedFriendUnread().clearAll()
      renderSessionList()
      syncSidebarToolbar()
      syncApprovalBadge()
      closeSidebarActivityView()
    })
    footer.appendChild(markAll)
    view.appendChild(footer)
  }
  scroller.insertBefore(view, scroller.firstChild)
  sidebarActivityView = view
}

/** Keep the header controls honest: the activity toggle carries the pressed
 *  state and one of three aria-labels (open / needs attention /
 *  turn off) plus the attention recolor. The sort action's aria-label is
 *  rendered by the sidebar list itself from the snapshot's sortMode. */
function syncSidebarToolbar() {
  const activityBtn = document.getElementById('titlebar-activity')
  const needsAttention = sharedFriendUnread().total() > 0
    || sessions.some(s => isSidebarSessionWaiting(s.id) || isSidebarSessionCompleteUnread(s.id))
  if (activityBtn) {
    activityBtn.setAttribute('aria-pressed', sidebarActivityOpen ? 'true' : 'false')
    activityBtn.classList.toggle('is-attention', needsAttention)
    const label = sidebarActivityOpen
      ? (tt('sidebar_activity_turn_off') || 'Turn off activity view')
      : needsAttention
        ? (tt('sidebar_activity_needs_attention') || 'View activity, needs attention')
        : (tt('sidebar_activity_view') || 'View activity')
    activityBtn.setAttribute('aria-label', label)
  }
}

let sidebarSortMenu: HTMLElement | null = null
// Mirrored into the sidebar snapshot so React owns the trigger's
// aria-expanded (a manually written attribute would be wiped by the next
// list re-render).
let sidebarSortMenuOpen = false

function closeSidebarSortMenu() {
  sidebarSortMenu?.remove()
  sidebarSortMenu = null
  if (sidebarSortMenuOpen) {
    sidebarSortMenuOpen = false
    renderSessionList()
  }
}

function openSidebarSortMenu(anchor: HTMLElement) {
  closeSidebarSortMenu()
  const menu = document.createElement('div')
  menu.className = 'workspace-context-menu sidebar-sort-menu'
  menu.setAttribute('role', 'menu')
  const modes: Array<{ mode: SidebarSortMode; label: string }> = [
    { mode: 'updated_at', label: tt('sidebar_sort_updated') || 'Last updated' },
    { mode: 'priority', label: tt('sidebar_sort_priority') || 'Priority' },
  ]
  for (const { mode, label } of modes) {
    const item = document.createElement('button')
    item.type = 'button'
    item.setAttribute('role', 'menuitemradio')
    item.setAttribute('aria-checked', sidebarSortMode === mode ? 'true' : 'false')
    item.textContent = label
    item.addEventListener('click', () => {
      setSidebarSortMode(mode)
      closeSidebarSortMenu()
    })
    menu.appendChild(item)
  }
  document.body.appendChild(menu)
  const rect = anchor.getBoundingClientRect()
  const margin = 8
  menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - menu.offsetWidth - margin))}px`
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - margin)}px`
  sidebarSortMenuOpen = true
  renderSessionList()  // React flips the trigger's aria-expanded
  sidebarSortMenu = menu
  const onPointerDown = (ev: PointerEvent) => { if (!menu.contains(ev.target as Node)) closeSidebarSortMenu() }
  const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === 'Escape') closeSidebarSortMenu() }
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
  }, 0)
  const cleanup = new MutationObserver(() => {
    if (menu.isConnected) return
    cleanup.disconnect()
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
  })
  cleanup.observe(document.body, { childList: true })
}

function sessionDisplayTitle(s: SessionInfo | undefined) {
  const title = !isPlaceholderSessionTitle(s?.title) ? String(s?.title) : tt('new_chat')
  return s?.forkedFrom ? title.replace(/\s*·\s*Branch$/i, '') : title
}

function applySessionTitleUpdate(sessionId: string, title: string) {
  const nextTitle = String(title || '').trim()
  if (!sessionId || !nextTitle) return false
  sessionTitleVersions.set(sessionId, (sessionTitleVersions.get(sessionId) || 0) + 1)
  let changed = false
  sessions = sessions.map((session) => {
    if (session.id !== sessionId) return session
    changed = true
    return { ...session, title: nextTitle }
  })
  if (changed) renderSessionList()
  else syncTitlebarSessionTitle()
  return changed
}

function mergeSessionsPreservingFreshTitles(nextSessions: SessionInfo[], titleVersionsAtRequest: Map<string, number>) {
  const currentById = new Map(sessions.map((session) => [session.id, session]))
  return (Array.isArray(nextSessions) ? nextSessions : []).map((session) => {
    const sessionId = session?.id
    const before = titleVersionsAtRequest.get(sessionId) || 0
    const now = sessionTitleVersions.get(sessionId) || 0
    const current = currentById.get(sessionId)
    if (now > before) {
      if (current?.title) return { ...session, title: current.title }
    }
    return preserveVisibleSessionTitle(current, session)
  })
}

function sessionBranchIconHtml(session: SessionInfo) {
  if (!session?.forkedFrom) return ''
  const sourceTitle = String(session.forkedFrom.title || '').trim()
  const label = sourceTitle
    ? tt('session_branch_from').replace('{title}', sourceTitle)
    : tt('session_branch_badge')
  return `<span class="session-branch-icon" role="img" aria-label="${escapeHtml(label)}">${klausIcon('session-branch')}</span>`
}

function titlebarSessionTitle() {
  const sessionId = window.currentSessionId
  return sessionTitleForCurrentSession(sessionId, findKnownSession(sessionId))
}

function syncTitlebarSessionTitle() {
  if (!titlebarSessionTitleEl) return
  const title = titlebarSessionTitle()
  // Avoid touching the DOM when the title hasn't changed. renderSessionList() is
  // invoked many times during a turn (status changes, queue snapshots, list
  // refreshes) and unconditionally rewriting textContent replaces the text node
  // on every call, which can make the titlebar title flicker.
  if (titlebarSessionTitleEl.textContent === title && (title ? !titlebarSessionTitleEl.hasAttribute('aria-hidden') : titlebarSessionTitleEl.hasAttribute('aria-hidden'))) {
    return
  }
  titlebarSessionTitleEl.textContent = title
  titlebarSessionTitleEl.title = title
  titlebarSessionTitleEl.toggleAttribute('aria-hidden', !title)
}

function closeSessionContextMenu() {
  sessionContextMenuCleanup?.()
  sessionContextMenuCleanup = null
  sessionContextMenu?.remove()
  sessionContextMenu = null
  sessionContextRow?.classList.remove('session-row-context')
  sessionContextRow = null
}

function sessionActionErrorText(error: unknown, fallbackKey: string) {
  const raw = String(error || fallbackKey || '')
  const localized = raw ? tt(raw) : ''
  if (localized && localized !== raw) return localized
  const fallback = fallbackKey ? tt(fallbackKey) : ''
  return fallback && fallback !== fallbackKey ? fallback : (raw || fallbackKey || tt('settings_failed'))
}

async function renameSessionFromMenu(id: string) {
  const target = sessions.find((s) => s.id === id)
  if (!target) return
  const currentTitle = sessionDisplayTitle(target)
  const value = await window.klausDialog.prompt!({
    title: tt('rename_session_title'),
    message: tt('rename_session_message'),
    placeholder: tt('rename_session_placeholder'),
    initialValue: currentTitle,
    confirmText: tt('session_menu_rename'),
  })
  if (value === null) return
  const title = String(value || '').trim()
  if (!title) {
    await window.klausDialog.alert(tt('rename_session_empty'))
    return
  }
  if (title === currentTitle) return

  const res = await klausApi.session.rename(id, title)
    .then(() => ({ ok: true }))
    .catch((err: unknown) => ({ ok: false, error: String((err as Error | null)?.message || err) }))
  if (res.ok) {
    if (target) {
      target.title = title
    }
    renderSessionList()
    showToast(tt('settings_saved'))
  } else {
    await window.klausDialog.alert(sessionActionErrorText(res.error, 'rename_session_failed'))
  }
}

async function exportSessionFromMenu(id: string) {
  const res = await klausApi.session.export(id)
    .catch((err: unknown) => ({ ok: false, error: String((err as Error | null)?.message || err) }))
  if (res?.ok) {
    showToast(tt('export_session_success'))
    return
  }
  if (res?.canceled) return
  await window.klausDialog.alert(sessionActionErrorText(res?.error, 'export_session_failed'))
}

async function forkSessionFromMenu(id: string) {
  const source = findKnownSession(id)
  const result = await klausApi.session.fork(id)
    .catch((error: unknown) => ({ error: String((error as Error | null)?.message || error) }))
  if (!result?.id) {
    await window.klausDialog.alert(sessionActionErrorText(result?.error, 'fork_session_failed'))
    return false
  }
  sessions = [result, ...sessions.filter((session) => session.id !== result.id)]
  showToast(tt('fork_session_success'))
  await switchSession(result.id)
  if (source?.archived) void listArchivedSessions()
  return true
}
// Side tasks convert by forking their transcript into a standalone session, so
// they reuse this path (and its error surface) instead of a second fork flow.
window.klausForkSession = forkSessionFromMenu

async function archiveSessionFromMenu(id: string) {
  const target = findKnownSession(id)
  const confirmed = await window.klausDialog.confirm({
    title: tt('archive_session_title'),
    message: sessionActionMessageWithProcesses(tt('archive_session_message'), id),
    confirmText: tt('session_menu_archive'),
  })
  if (!confirmed) return
  const persistedTitle = !isPlaceholderSessionTitle(target?.title) ? target?.title : undefined
  const result = await klausApi.session.archive(id, persistedTitle)
    .catch((error: unknown) => ({ error: String((error as Error | null)?.message || error) }))
  if (!result?.ok) {
    await window.klausDialog.alert(sessionActionErrorText(result?.error, 'archive_session_failed'))
    return
  }
  const archived = { ...target, id, archived: true, updatedAt: Date.now() }
  sessions = sessions.filter((session) => session.id !== id)
  archivedSessions = [archived, ...archivedSessions.filter((session) => session.id !== id)]
  forgetSessionLocalState(id, false)
  showToast(tt('archive_session_success'))
  if (window.currentSessionId === id) {
    enterNewChatState({ workdir: normalizeProjectWorkdir(target?.workdir), discardLeavingDraft: true })
  } else {
    renderSessionList()
  }
}

async function toggleSessionPinned(session: SessionInfo) {
  try {
    await sessionPinning.toggle(session.id)
  } catch (error) {
    const detail = String((error as Error | null)?.message || error || '')
    const message = sessionActionErrorText(detail, 'session_pin_failed')
    await window.klausDialog.alert(detail && detail !== 'session_pin_failed' && detail !== message
      ? `${message}\n\n${detail}` : message)
  }
}

async function runSessionContextAction(action: string, session: SessionInfo) {
  if (!session?.id) return
  if (action === 'pin' || action === 'unpin') await toggleSessionPinned(session)
  else if (action === 'rename') await renameSessionFromMenu(session.id)
  else if (action === 'export') await exportSessionFromMenu(session.id)
  else if (action === 'fork') await forkSessionFromMenu(session.id)
  else if (action === 'archive') await archiveSessionFromMenu(session.id)
  else if (action === 'copy-id') await copySessionIdFromMenu(session.id)
  else if (action === 'report') await submitDebugReport('')
  else if (action === 'delete') await deleteSession(session.id)
  else if (action === 'worktree-reveal') await revealWorktreeFromMenu(session)
}

/** Copy the conversation id so the user can hand an exact id to another session. */
async function copySessionIdFromMenu(id: string) {
  try {
    await writeClipboardText(id)
    showToast(tt('session_id_copied'))
  } catch (err) {
    console.warn('[sessions] copy id failed:', err)
    await window.klausDialog.alert(tt('session_id_copy_failed'))
  }
}

// ==================== 受管 worktree 并行会话 ====================
// 同一项目同时开多个会话，每个会话在自己的 git worktree 里改代码互不污染：
// 创建走新会话页的 Worktree 模式（ensureRunModeWorkspaceForSend）→ 提交
//（diff 视图提交闭环）→ 分支由用户在 git 侧自行合并 → 删除会话时可一并移除 worktree。
// 受管路径特征：~/.klaus/worktrees/ 下（主进程创建时固定，此处只做展示判定；
// 真正的路径校验在主进程 worktree-manager 内收口）。谓词本体在 worktree-path，
// 转录的 worktree-init 常驻行共用同一判定。
import { isWorktreeSessionWorkdir } from './worktree-path'
import { classifyWorktreeAvailability, paintWorktreeAvailability, type WorktreeAvailability } from './worktree-availability'
let worktreeAvailability: WorktreeAvailability | null = null
let worktreeAvailabilitySeq = 0

function renderWorktreeAvailability(): void {
  const row = document.getElementById('worktree-availability')
  const message = document.getElementById('worktree-availability-message')
  const action = document.getElementById('worktree-availability-action') as HTMLButtonElement | null
  if (!row || !message || !action) return
  paintWorktreeAvailability(row, message, action, worktreeAvailability, window.currentSessionId, {
    missing: tt('worktree_missing'), unavailable: tt('worktree_status_unavailable'),
    continueInOrigin: tt('worktree_continue_in_origin'), retry: tt('worktree_status_retry'),
  })
}

async function refreshWorktreeAvailability(sessionId: string | null): Promise<'available' | 'gone' | 'unavailable'> {
  const seq = ++worktreeAvailabilitySeq
  const workdir = sessionId ? sessionWorkdir(sessionId) : null
  if (!sessionId || !isWorktreeSessionWorkdir(workdir)) {
    worktreeAvailability = null
    renderWorktreeAvailability()
    return 'available'
  }
  const result = await klausApi.worktree.status(workdir!, true).catch(() => null)
  if (seq !== worktreeAvailabilitySeq || window.currentSessionId !== sessionId || sessionWorkdir(sessionId) !== workdir) return 'unavailable'
  worktreeAvailability = classifyWorktreeAvailability(sessionId, result)
  renderWorktreeAvailability()
  return worktreeAvailability.state
}

document.getElementById('worktree-availability-action')?.addEventListener('click', async () => {
  const status = worktreeAvailability
  if (!status || status.sessionId !== window.currentSessionId) return
  if (status.state !== 'gone') { void refreshWorktreeAvailability(status.sessionId); return }
  if (!status.repoRoot) return
  if (busy || runningSessions.has(status.sessionId)) { showToast(tt('worktree_continue_in_origin_busy')); return }
  const confirmed = await window.klausDialog.confirm({
    title: tt('worktree_continue_in_origin'),
    message: tt('worktree_continue_in_origin_confirm'),
    confirmText: tt('worktree_continue_in_origin'),
  })
  if (!confirmed || window.currentSessionId !== status.sessionId) return
  if (busy || runningSessions.has(status.sessionId)) { showToast(tt('worktree_continue_in_origin_busy')); return }
  try {
    const result = await klausApi.session.setWorkdir(status.sessionId, status.repoRoot)
    if (result?.ok !== true) throw new Error(result?.error || tt('worktree_continue_in_origin_failed'))
    sessions = sessions.map(session => session.id === status.sessionId ? { ...session, workdir: status.repoRoot, workspaceId: null } : session)
    setActiveProjectWorkdir(status.repoRoot, { render: false, refreshWorkdir: false })
    renderSessionList()
    await refreshWorkdirButton()
    hideSlashMenu()
    void handleSlashMenu()
    void refreshWorktreeAvailability(status.sessionId)
  } catch (error) { showToast(`${tt('worktree_continue_in_origin_failed')}: ${(error as Error).message}`) }
})
window.setInterval(() => { if (window.currentSessionId && isWorktreeSessionWorkdir(sessionWorkdir(window.currentSessionId))) void refreshWorktreeAvailability(window.currentSessionId) }, 5000)

// --- 会话项目归属（cwd 是运行环境，归属是身份）---
// worktree 会话的归属在创建时由主进程锁定（session_project_assignments），
// 老会话没有该字段时按 worktree 目录反查源仓库；解析结果缓存，解析中的
// 会话暂不合成项目行，避免闪现一个以 worktree 目录命名的条目。
const worktreeProjectRootCache = new Map<string, string | null>()
const worktreeProjectRootInflight = new Set<string>()

async function resolveWorktreeProjectRoot(workdir: string): Promise<string | null> {
  const root = (await klausApi.projects?.resolveRoot?.(workdir).catch(() => null))?.root ?? null
  worktreeProjectRootCache.set(workdir, root)
  worktreeProjectRootInflight.delete(workdir)
  renderSessionList()
  return root
}

/** Project identity for a cwd: a managed worktree maps to its origin repo. */
function projectIdentityForWorkdir(workdir: string | null): string | null {
  if (!workdir || !isWorktreeSessionWorkdir(workdir)) return workdir
  const cached = worktreeProjectRootCache.get(workdir)
  if (cached !== undefined) return cached
  if (!worktreeProjectRootInflight.has(workdir)) {
    worktreeProjectRootInflight.add(workdir)
    void resolveWorktreeProjectRoot(workdir)
  }
  return null
}

/** The project a session belongs to; null for workspace-bound, friend-bound or projectless. */
function sessionProjectKey(session: SessionInfo): string | null {
  if (session.workspaceId) return null
  if (session.friendGroupId) return null
  const assigned = normalizeProjectWorkdir(session.projectRoot)
  if (assigned) return assigned
  return projectIdentityForWorkdir(normalizeProjectWorkdir(session.workdir))
}

async function revealWorktreeFromMenu(session: SessionInfo) {
  const workdir = normalizeProjectWorkdir(session.workdir)
  if (!workdir) return
  const res = await klausApi.worktree.reveal(workdir).catch(() => null)
  if (res && res.ok === false) await window.klausDialog.alert(res.error || tt('settings_failed'))
}

// Session context-menu item icons — hollow path-fill on the 16×16 grid,
// same icon language as the sidebar (fill=currentColor, evenodd, ≈1px walls).
function sessionMenuItemIconSvg(action: string) {
  const known = ['rename', 'pin', 'unpin', 'export', 'copy-id', 'fork', 'worktree-reveal', 'report', 'archive', 'delete']
  return known.includes(action) ? klausIcon(`session-menu-${action}`) : ''
}

function showSessionContextMenu(e: MouseEvent | { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, session: SessionInfo, row: HTMLElement | null) {
  e.preventDefault()
  e.stopPropagation()
  closeSessionContextMenu()
  closeWorkspaceContextMenu()
  sessionContextRow = row
  row?.classList.add('session-row-context')

  const menu = document.createElement('div')
  menu.className = 'workspace-context-menu session-context-menu'
  menu.setAttribute('role', 'menu')
  const isRust = true
  const isWorktree = isWorktreeSessionWorkdir(session.workdir)
  const items = session.archived
    ? [
        ['export', tt('session_menu_export')],
        ['copy-id', tt('session_menu_copy_id')],
        ...(isRust ? [['fork', tt('session_menu_fork')]] : []),
        ['delete', tt('session_menu_delete'), 'danger'],
      ]
    : [
        ['rename', tt('session_menu_rename')],
        [isPinnedSession(session) ? 'unpin' : 'pin', tt(isPinnedSession(session) ? 'session_menu_unpin' : 'session_menu_pin')],
        ['export', tt('session_menu_export')],
        ['copy-id', tt('session_menu_copy_id')],
        ...(isRust ? [['fork', tt('session_menu_fork')]] : []),
        // 并行工作树：创建统一走新会话页的 Worktree 模式；worktree 会话在此
        // 只提供 Finder 展示，分支的合并由用户在 git 侧自行完成。
        ...(isWorktree ? [['worktree-reveal', tt('session_menu_worktree_reveal')]] : []),
        // 头部的导出/报告问题按钮已整体移除，统一收进这个菜单。
        ['report', tt('debug_report_tooltip')],
        ['archive', tt('session_menu_archive')],
        // 永久删除与归档并存：删除走 deleteSession 的三分支确认
        //（projectless wipe 勾选 / 项目会话只删会话文件 / worktree 移除隔离副本勾选）。
        ['delete', tt('session_menu_delete'), 'danger'],
      ]
  menu.innerHTML = items.map(([action, label, tone]) =>
    `<button type="button" role="menuitem" data-action="${action}" class="${tone === 'danger' ? 'danger' : ''}"><span class="menu-item-icon">${sessionMenuItemIconSvg(action)}</span><span class="menu-item-label">${escapeHtml(label)}</span></button>`
  ).join('')
  document.body.appendChild(menu)
  sessionContextMenu = menu

  for (const btn of menu.querySelectorAll('button[data-action]')) {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      const action = (btn as HTMLElement).dataset.action
      closeSessionContextMenu()
      try {
        await runSessionContextAction(action as string, session)
      } catch (error) {
        await window.klausDialog.alert(sessionActionErrorText((error as Error | null)?.message || error, 'session_action_failed'))
      }
    })
  }

  const rect = menu.getBoundingClientRect()
  const margin = 8
  const left = Math.min(e.clientX, window.innerWidth - rect.width - margin)
  const top = Math.min(e.clientY, window.innerHeight - rect.height - margin)
  menu.style.left = Math.max(margin, left) + 'px'
  menu.style.top = Math.max(margin, top) + 'px'

  const onPointerDown = (ev: PointerEvent) => { if (!menu.contains(ev.target as Node)) closeSessionContextMenu() }
  const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === 'Escape') closeSessionContextMenu() }
  const onClose = () => closeSessionContextMenu()
  setTimeout(() => {
    if (sessionContextMenu !== menu) return
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose, true)
    document.addEventListener('scroll', onClose, true)
    sessionContextMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose, true)
      document.removeEventListener('scroll', onClose, true)
    }
  }, 0)
}

function renderCronChannelBanner(sessionId: string) {
  const el = document.getElementById('cron-channel-banner')
  if (!el) return
  if (!isCronRunSession(sessionId)) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  const task = findCronTaskBySessionId(sessionId)
  const binding = task?.channelBinding
  if (!binding) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  const chLabel = cronChannelLabel(binding.channelId)
  const target = binding.chatType === 'group'
    ? (tt('cron_form_channel_group') || '群 · ') + (binding.label || binding.targetId)
    : (binding.label || tt('cron_form_channel_me') || '发给你本人')
  el.innerHTML = `
    ${klausIcon('chat-render-cron-channel-banner')}
    <span class="cron-channel-banner-text">
      ${escapeHtml(tt('cron_chat_banner_prefix') || '运行结束会推到')}
      <strong>${escapeHtml(chLabel)}</strong> · ${escapeHtml(target)}
    </span>`
  el.hidden = false
}

// [垫片] React transcript 对照与后续 sessions 侧栏 React 化经 window 调用。
window.klausSwitchSession = (id: string) => switchSession(id)
async function switchSession(id: string) {
  if (sessionDeletePending.has(id)) return
  const pending = [...pendingComposerSubmissions.values()].find(pending => !pending.sessionId && pending.viewId === id)
  if (pending) {
    if (window.currentSessionId === null && visiblePendingSubmissionId === pending.id) return
    enterNewChatState({ workdir: pending.workdir, workspaceId: pending.workspaceId })
    visiblePendingSubmissionId = pending.id
    mountReactTranscript(pending.viewId, messagesEl, { scroll: 'main', readOnly: true })
    welcomeEl.style.display = 'none'
    messagesEl.style.display = 'block'
    syncBusyForCurrentSession()
    syncComposerContextRowVisibility()
    syncTopModeButtons()
    renderSessionList()
    return
  }
  visiblePendingSubmissionId = null
  // A row can outlive the engine's delete acknowledgement while resources close.
  if (sessionDeletePending.has(id)) return
  goalInteractions.navigate()
  const turnNavigationLease = turnNavigationController?.suspend('session-switch')
  try {
  const mySeq = ++switchSeq
  // Leaving global full-screen overlays.
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  hideBtwPanel()
  setCurrentNonChatView(null)
  // The panel is per-session. Snapshot the OUTGOING session's panel state (mode +
  // collapsed) and its tab set, then drop the instance tabs whose surfaces belong
  // to that session. The TARGET's own state is restored below, after
  // currentSessionId flips, so the changes / files surfaces re-open against the
  // right session. There is no "keep changes/files across the switch" path: it
  // read global active flags (isDiffViewActive / isWorkspaceMainViewActive) and so
  // dragged one session's whole panel — open state, browser page, terminal — into
  // the next, which is exactly the leak being fixed.
  if (window.currentSessionId !== id) captureTranscriptViewport(messagesEl)
  saveArtifactsStateFor(window.currentSessionId || '')
  window.KlausPanelTabs?.beginSessionSwitch?.(window.currentSessionId, id)

  // Leaving a conversation abandons an edit of one of its sent messages, BEFORE the draft
  // is written: while editing, the composer holds that message's content, so stashing it
  // as a draft would leave the conversation with an unsent copy of something already sent.
  // Restoring puts back what the user had typed before grabbing the edit, which is then what
  // gets stashed — so a switch away costs nothing but the edit itself.
  // 离开前把输入框里的东西写进草稿。setDraft 内部会按 presence 变化触发
  // renderSessionList，所以下面紧跟的那次 render 会覆盖到最新状态。
  // 附件同理按会话暂存——不然粘贴的图片会跟着用户跑进下一个会话。
  // stash 不限 id 是否相同：同 id 重入时下面的 restore 会原样取回。
  if (window.currentSessionId) {
    if (window.currentSessionId !== id) setDraft(window.currentSessionId, composedInputDraft())
    stashPendingFiles(window.currentSessionId)
    saveRunModeForDraft(window.currentSessionId)
  } else {
    // 从欢迎屏切进历史会话：虚拟新对话没有实体可挂草稿，
    // 输入框内容存进 welcome 草稿，下次回欢迎屏时恢复。
    setWelcomeDraft(composedInputDraft())
    stashPendingFiles(null)
    saveRunModeForDraft(null)
  }

  // Leaving a proven-empty placeholder recycles both in-run drafts and a draft
  // the engine already materialised as a persisted "Chat" thread.
  const leavingHadContent = !!(window.currentSessionId && sessionStreamHasContent(window.currentSessionId))
  if (window.currentSessionId && window.currentSessionId !== id && !leavingHadContent) {
    discardEmptySessionOnLeave(window.currentSessionId, leavingHadContent)
  }

  // Always drop the sub-agent tabs when switching sessions — they show one
  // conversation's derived agents, so carrying them across would point at
  // transcripts the target session never produced.
  closeAllSubagentTabs()
  window.KlausBackgroundProcessPanel?.closeAll?.()
  pendingNewChatWorkdir = null
  pendingNewChatProjectRoot = null
  pendingNewChatWorkspaceId = null
  window.currentSessionId = id
  // Set the target viewport width before its transcript can paint. Surface
  // content still restores after the browser has adopted this conversation.
  prepareArtifactsPanelLayoutForSessionSwitch(id)
  mainSticker.resetForSession(transcriptViewportState(id)?.distanceFromBottomPx ?? 0)
  void klausApi.desktopPet?.acknowledgeTask(id).catch(() => {})
  void refreshWorktreeAvailability(id)
  // A friend conversation can hold a request whose arrival event this window
  // missed (closed window, boot race). Opening it is the owner's clearest cue
  // to re-read the inbox, so the approval card and the row pill never wait for
  // the next unrelated change event.
  void refreshFriendInbox()
  resetHistoryBrowsing()
  markSidebarSessionSeen(id, { render: false })

  // Commit the visible conversation before any unrelated host IPC. An existing
  // session whose history has not arrived yet owns the transcript loading
  // surface; it must never fall through to the new-chat welcome screen merely
  // because its title is still the placeholder.
  setComposerText(sessionDrafts.get(id) || '')
  restorePendingFiles(id)
  const queuedEdit = editedQueueReinsertBySession.get(id)
  if (queuedEdit?.phase === 'editing') restoreDisplayCardsToComposer((queuedEdit.item || queuedEdit.row!.item).selectedTextAttachments,
    (queuedEdit.item || queuedEdit.row!.item).pastedCards)
  autoResize()
  updateSendBtn()
  const targetStream = getSessionStream(id)
  if (targetStream.history === null && !targetStream.historyLoading) void loadSessionHistory(id)
  resurfaceUnsentSubmission(id)
  mountReactTranscript(id, messagesEl, { scroll: 'main' })
  syncMainTranscriptChrome()
  ;(window as any).klausUpdateSideSendButton?.()

  // Point the embedded browser at THIS session's own conversation before the
  // panel is reconciled below, so the tab strip is built from this session's own
  // pages (and new manual pages land here) instead of the app-wide "manual" pool
  // — that pool was why one session's browser page showed up in the next.
  await window.klaus?.browserUse?.setConversation?.(id).catch(() => {})
  if (mySeq !== switchSeq || window.currentSessionId !== id || sessionDeletePending.has(id)) return
  // This conversation just became the one on screen, so anything it can still
  // answer belongs in the composer instead of somewhere up a transcript that may
  // have folded the question away. Deliberately keyed to a surface starting to
  // show a session rather than to a store change: the panel's own Later/Escape
  // closes it while the user stays on this same chat, and that dismissal has to
  // stick. After the switch guard so a session the user already navigated away
  // from never gets a panel rebuilt.
  reopenAsyncQuestionsForSession(id)
  // Now that the target session is current, restore ITS panel: re-open the
  // changes / files surface against this session, or leave the panel closed if it
  // was never opened here. Runs before session-change so downstream consumers see
  // the settled panel state.
  adjustArtifactsPanelForSessionSwitch(id)
  window.dispatchEvent(new CustomEvent('klaus:session-change', { detail: { sessionId: id } }))
  // Clear the previous session's modes before loading this session's snapshot.
  composerSpecEnabled = false
  setComposerGoalEnabled(false)
  void refreshComposerSpecEnabled()
  updateSpecBanner()
  // Show this conversation's cached goal while runtime recovery hydrates it.
  updateGoalIndicator()
  syncTerminalPanelForCurrentSession()
  const targetSession = findKnownSession(id)
  if (!detectChannelPrefix(id)) {
    const projectKey = targetSession?.workspaceId
      ? workspaceContainerKey(targetSession.workspaceId)
      : targetSession?.friendGroupId
        ? friendGroupKey(targetSession.friendGroupId)
        : normalizeProjectWorkdir(targetSession?.workdir)
    if (projectKey) {
      // Opening a real session always reveals it: the draft exemption exists
      // only for a chat that does not exist yet.
      revealProjectInSidebar('projects', projectKey)
    }
    // Friend task conversations live in their friendship's scratch home, which
    // is not a project identity: opening one must neither register it nor move
    // the default project for new chats.
    if (!targetSession?.friendGroupId) {
      setActiveProjectWorkdir(targetSession?.workspaceId ? null : (targetSession?.workdir || null), { render: false, refreshWorkdir: false })
    }
  }
  renderSessionList()
  renderCronChannelBanner(id)
  resetStreamState()
  syncBusyForCurrentSession()
  syncArchivedSessionUi()
  renderFollowUpQueue()
  // The host owns the queue, so switching sessions reads its snapshot instead of
  // carrying rows over in renderer memory. Cached rows are dropped first: a stale
  // cache would draw the previous session's queue for one frame.
  void refreshClientQueue(id, { reset: true })

  // Monitor's Tasks section reflects the new session immediately from cache
  // (if any), then refreshes from disk in the background — IPC roundtrip is
  // a few ms but rendering from cache first avoids a flash of empty section.
  renderTaskPanel()
  refreshTasksForSession(id)
  // Same cache-first pattern for the agent panel: paint the session's last
  // known snapshot, then re-pull from main-process appState. Subsequent live
  // updates ride the `tasks_changed` engine event.
  renderSubagentSection()
  refreshAgentsForSession(id)
  void window.KlausBackgroundProcessPanel?.refreshSession?.(id)
  // Context section: render cached snapshot immediately. Re-fetch only after
  // history tells us the session has content; empty just-created shells should
  // not run heavy prompt analysis.
  renderContextPanel()

  // 恢复该会话草稿期的运行模式选择（离开时已按会话保存）。
  restoreRunModeForDraft(id)
  // Workdir pill reflects whatever override this session has — async, no need
  // to await before painting the rest of the surface.
  refreshWorkdirButton()

  // Drain pending permission asks that arrived while this session was
  // off-screen (typically cron-run sessions hitting Bash/AskUserQuestion).
  // Now that messagesEl reflects this session, route them through the normal
  // showPermissionRequest path — sessionId === currentSessionId so the
  // re-entry into showPermissionRequest takes the in-session render branch.
  const queued = pendingPermissionsBySession.get(id)
  if (queued && queued.length > 0) {
    pendingPermissionsBySession.delete(id)
    for (const req of queued) showPermissionRequest(req)
  }
  void restorePendingPermissions(id)

  // 同理排空切走时积压的追问卡（引擎内置 ask_user）。
  const queuedElicits = pendingElicitsBySession.get(id)
  if (queuedElicits && queuedElicits.length > 0) {
    pendingElicitsBySession.delete(id)
    for (const req of queuedElicits) showElicitRequest(req)
  }

  // welcome/messages 显隐初判（订阅会随 store 变化重算）；运行中会话强制显转录。
  syncMainTranscriptChrome()
  // 转录 DOM 已就位，兜底重判「运行于」行显隐 —— refreshWorkdirButton 的
  // IPC 可能在 DOM 挂载前就回来了（彼时 messagesEl 还是空的会误判可编辑）。
  syncComposerContextRowVisibility()
  syncTopModeButtons()
  const hasContent = mainTranscriptHasContent(id)
  if (hasContent) refreshContextStatsThrottled(id, 0)
  // 切会话立即从缓存重绘顶栏用量 chip（命中则秒出，未命中先隐藏等 fetch）。
  renderContextChip()
  scrollToBottom()
  loadArtifacts(id)
  } finally {
    if (turnNavigationLease) turnNavigationController?.resume(turnNavigationLease, window.currentSessionId)
  }
}

// 进入"虚拟新对话"状态：currentSessionId = null + welcome 屏 + 输入框就绪。
// 不在后端创建任何 session entity —— 只有 send()
// 发送第一条消息时才 lazy 创建实体（见 [send] 段）。这同时根治了之前
// `if (!currentSessionId) await newChat()` 触发 switchSession → 清空 inputEl
// → finalText 为空气泡的 race。
function enterNewChatState(options: { workdir?: string | null; workspaceId?: string | null; discardLeavingDraft?: boolean; retainSettings?: boolean } = {}) {
  visiblePendingSubmissionId = null
  goalInteractions.navigate()
  const turnNavigationLease = turnNavigationController?.suspend('new-chat')
  try {
  // Leaving the conversation abandons an edit of one of its sent messages, BEFORE the
  // draft is written — the same rule `switchSession` applies. While editing, the composer
  // holds that message's content, so stashing it here would leave the old conversation with
  // an unsent copy of something already sent, and the banner would stay up promising a
  // replacement that this fresh chat would never do.
  // 离开当前 session 时保存草稿（与 switchSession 对齐）；转录内容在 store 里，
  // 切回时 React 直接按数据重渲，不再需要 DOM 搬运。
  // A retired owner must not be saved again or mistaken for the welcome draft.
  if (window.currentSessionId && !options.discardLeavingDraft) {
    const leavingHadContent = sessionStreamHasContent(window.currentSessionId)
    setDraft(window.currentSessionId, composedInputDraft())
    stashPendingFiles(window.currentSessionId)
    saveRunModeForDraft(window.currentSessionId)

    // Recycle only when the store has proved the persisted placeholder empty, or
    // when this run still marks it as a draft-only transport session.
    if (!leavingHadContent) {
      discardEmptySessionOnLeave(window.currentSessionId, leavingHadContent)
    }
  } else if (!window.currentSessionId) {
    stashPendingFiles(null)
    // 已在欢迎屏态（如快速输入/canvas 注入触发的重入）：当前模式属于欢迎草稿。
    saveRunModeForDraft(null)
  }

  // 关掉所有 non-chat overlay（与 switchSession 对齐）
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.hideDiffView === 'function') window.hideDiffView()
  if (typeof window.hideWorkspaceMainView === 'function') window.hideWorkspaceMainView()
  if (!options.retainSettings && document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  hideBtwPanel()
  setCurrentNonChatView(null)
  restoreArtifactsPanelForChatView()
  closeAllSubagentTabs()
  window.KlausBackgroundProcessPanel?.closeAll?.()

  const targetWasExplicit = Object.prototype.hasOwnProperty.call(options, 'workdir')
    || Object.prototype.hasOwnProperty.call(options, 'workspaceId')
  pendingNewChatWorkdir = Object.prototype.hasOwnProperty.call(options, 'workdir')
    ? normalizeProjectWorkdir(options.workdir)
    : pendingNewChatWorkdir
  // Workspace draft: an explicit workspaceId wins; a plain workdir-only new chat
  // is NOT workspace-bound so it clears the draft; otherwise the draft persists.
  if (Object.prototype.hasOwnProperty.call(options, 'workspaceId')) {
    pendingNewChatWorkspaceId = options.workspaceId || null
  } else if (Object.prototype.hasOwnProperty.call(options, 'workdir')) {
    pendingNewChatWorkspaceId = null
  }
  if (pendingNewChatWorkspaceId) {
    setActiveProjectWorkdir(null, { render: false, refreshWorkdir: false })
  } else if (pendingNewChatWorkdir) {
    setActiveProjectWorkdir(pendingNewChatWorkdir, { render: false, refreshWorkdir: false })
  } else {
    setActiveProjectWorkdir(null, { render: false, refreshWorkdir: false })
  }
  pendingNewChatProjectRoot = projectIdentityForWorkdir(pendingNewChatWorkdir)

  window.currentSessionId = null
  void refreshWorktreeAvailability(null)
  composerSpecEnabled = false
  setComposerGoalEnabled(false)
  updateGoalIndicator()
  updateSpecBanner()
  resetHistoryBrowsing()
  window.dispatchEvent(new CustomEvent('klaus:session-change', { detail: { sessionId: null } }))
  syncTerminalPanelForCurrentSession()
  // An explicit entry may reopen the same welcome draft (for example, New from
  // another conversation in the same project). Reset only when its target is
  // genuinely different; otherwise restore the draft's selected run mode.
  const welcomeRunMode = sessionRunModes.get(WELCOME_RUN_MODE_KEY)
  if (shouldRestoreWelcomeRunMode(welcomeRunMode, {
    workdir: normalizeProjectWorkdir(pendingNewChatWorkdir),
    workspaceId: pendingNewChatWorkspaceId || null,
  }, targetWasExplicit)) {
    restoreRunModeForDraft(null)
  } else {
    forgetRunModeForDraft(null)
    pendingRunMode = 'local'
    worktreeBaseBranch = null
    runModeApi?.setValue('local')
  }
  // 语音学习埋点不跨草稿：上一个草稿的语音插入记录作废。
  clearVoiceLearning()
  // React root 卸载：欢迎屏态下 #messages 不挂任何会话转录。
  unmountReactTranscript(messagesEl)
  messagesEl.style.display = 'none'
  welcomeEl.style.display = 'flex'
  syncTopModeButtons()
  updateScrollToBottomBtn()
  resetStreamState()
  syncBusyForCurrentSession()
  syncArchivedSessionUi()
  renderFollowUpQueue()

  // 恢复欢迎屏草稿：虚拟新对话的输入存在 localStorage（见 setWelcomeDraft），
  // 切走再回来/重启都能接着写。
  setComposerText(getWelcomeDraft())
  // A failed promotion still owns a welcome draft, including its attachments.
  // Restore only that draft's files; other conversations remain stashed.
  restorePendingFiles(null)
  pendingSendAfterUpload = null
  renderPreviews()
  renderSelectedSlashCommand()
  autoResize()
  updateSendBtn()

  renderSessionList()
  renderCronChannelBanner('')
  renderTaskPanel()
  renderSubagentSection()
  renderContextPanel()
  refreshWorkdirButton()
  loadArtifacts(null)

  if (options.retainSettings) void klausApi.browserUse.hide().catch(() => {})
  else inputEl.focus()
  } finally {
    if (turnNavigationLease) turnNavigationController?.resume(turnNavigationLease, window.currentSessionId)
  }
}

function newChat(options: { workdir?: string | null; workspaceId?: string | null } = {}) {
  enterNewChatState({
    workdir: Object.prototype.hasOwnProperty.call(options, 'workdir') ? options.workdir : null,
    ...(Object.prototype.hasOwnProperty.call(options, 'workspaceId') ? { workspaceId: options.workspaceId } : {}),
  })
}

function discardEmptySessionOnLeave(sessionId: string, hasContent: boolean) {
  if (voiceChatUi?.controller.snapshot().open && voiceChatUi.controller.snapshot().targetSessionId === sessionId) return
  // A submit still in flight owns this conversation: recycling it would delete
  // the target of a message the user already handed over.
  for (const entry of pendingComposerSubmissions.values()) {
    if (entry.sessionId === sessionId && (entry.phase === 'preparing' || entry.phase === 'submitting')) return
  }
  const history = chatStreamStore.getState().sessions[sessionId]?.history
  if (discardSessionWithKnownHistory(sessionId, history, hasContent)) return
  if (history != null || hasContent || emptySessionDiscardChecks.has(sessionId) || sessionDeletePending.has(sessionId)) return

  // History may still be loading when the user immediately clicks New. Qualify
  // every other guard first, then confirm through the authoritative history API.
  const session = sessions.find((candidate) => candidate.id === sessionId)
  if (!shouldDiscardEmptySessionOnLeave(session, {
    draftOnly: false,
    history: [],
    hasContent: false,
    hasDraft: !!(sessionDrafts.get(sessionId)?.text || '').trim(),
    hasPendingFiles: !!sessionPendingFiles.get(sessionId)?.length,
    hasSubmittedTurn: submittedTurnSessionIds.has(sessionId),
    isChannel: !!detectChannelPrefix(sessionId),
  })) return

  emptySessionDiscardChecks.add(sessionId)
  void klausApi.session.history(sessionId).then((result: any) => {
    if (window.currentSessionId === sessionId) return
    const confirmedHistory = Array.isArray(result)
      ? result
      : (Array.isArray(result?.messages) ? result.messages : null)
    discardSessionWithKnownHistory(sessionId, confirmedHistory, sessionStreamHasContent(sessionId))
  }).catch(() => {}).finally(() => emptySessionDiscardChecks.delete(sessionId))
}

function discardSessionWithKnownHistory(
  sessionId: string,
  history: readonly unknown[] | null | undefined,
  hasContent: boolean,
) {
  if (voiceChatUi?.controller.snapshot().open && voiceChatUi.controller.snapshot().targetSessionId === sessionId) return false
  const session = sessions.find((candidate) => candidate.id === sessionId)
  if (!shouldDiscardEmptySessionOnLeave(session, {
    draftOnly: isDraftOnlySession(sessionId),
    history,
    hasContent,
    hasDraft: !!(sessionDrafts.get(sessionId)?.text || '').trim(),
    hasPendingFiles: !!sessionPendingFiles.get(sessionId)?.length,
    hasSubmittedTurn: submittedTurnSessionIds.has(sessionId),
    isChannel: !!detectChannelPrefix(sessionId),
  })) return false

  if (sessionDeletePending.has(sessionId)) return true
  sessionDeletePending.add(sessionId)
  void klausApi.session.delete(sessionId).then((result: any) => {
    if (result?.ok === false || result?.error) throw new Error(result?.error || tt('session_cleanup_failed'))
    sessionDeletionRevision++
    sessions = sessions.filter((candidate) => candidate.id !== sessionId)
    forgetSessionLocalState(sessionId)
    renderSessionList()
  }).catch((error: any) => {
    // Keep the row and its local state when the authoritative delete failed.
    // Otherwise the next refresh resurrects a conversation the UI pretended was
    // gone, with no explanation of where it came from.
    window.showToast?.(error?.message || tt('session_cleanup_failed'), { duration: 5000 })
  }).finally(() => sessionDeletePending.delete(sessionId))
  return true
}

// 把"虚拟新对话"提升为后端 session entity。两个入口都汇总到这：
//   - addFiles（用户拖入/粘贴/选择文件，附件需要实体承接）
//   - send()（发送第一条消息）
// 欢迎屏纯打字不再触发 promote：草稿走 welcome 草稿（localStorage），
// 避免 prewarm 激活链路让引擎把零消息 rollout 落盘。
// promoteInflight guard 让快速触发的多次调用合流到同一个 IPC，避免连开多个
// session。promote 只创建草稿会话，不隐藏 welcome；只有真正 send() 后才
// 切到 messages。这样新会话在用户未发送消息前始终保持欢迎页内容可见。
// 同时保留"切走时草稿存在 sessionDrafts、sidebar 显示草稿徽章、离开时
// 若空则回收"语义（见 switchSession 内的离开回收逻辑）。
const draftPromotion = new DraftSessionPromotion()
window.addEventListener('klaus:session-change', () => draftPromotion.navigate())
const syncPetVoiceConversation = () => { void klausApi.desktopPet.setMainConversation(window.currentSessionId || null).catch(() => {}) }
window.addEventListener('klaus:session-change', syncPetVoiceConversation)
syncPetVoiceConversation()

let promoteInflight: Promise<string | null> | null = null
// A worktree-mode first send is parked on its host-side creation between the
// optimistic bubble and the real submit. While that wait is open there is no
// running turn to steer or queue into, so a repeated Enter must be dropped
// instead of dispatching a second copy of the same message.
let firstSendInFlight = false
async function ensureSession(pending?: PendingComposerSubmission) {
  if (pending?.sessionId) return pending.sessionId
  if (!pending && window.currentSessionId) return window.currentSessionId
  const promotion = draftPromotion.run(async isCurrent => {
    const inheritedWorkdir = pending ? pending.workdir : draftProjectWorkdir()
    // A drafted workspace binds the new session to the workspace (its primary
    // root becomes the cwd; the host resolves it and injects the extra roots).
    const inheritedWorkspaceId = pending ? pending.workspaceId : pendingNewChatWorkspaceId
    // Membership drafted alongside a worktree cwd: the session
    // is filed under its origin project from the moment it exists.
    const inheritedProjectRoot = pending ? pending.projectRoot : pendingNewChatProjectRoot
    const info = await klausApi.session.new({
      ...(inheritedWorkdir ? { workdir: inheritedWorkdir } : {}),
      ...(inheritedWorkspaceId ? { workspaceId: inheritedWorkspaceId } : {}),
      ...(inheritedProjectRoot ? { projectRoot: inheritedProjectRoot } : {}),
    })
    if (inheritedWorkdir && !info.workdir) info.workdir = inheritedWorkdir
    if (inheritedWorkspaceId && !info.workspaceId) info.workspaceId = inheritedWorkspaceId
    if (inheritedProjectRoot && !info.projectRoot) info.projectRoot = inheritedProjectRoot
    // Dedup against a refresh that landed while session:new was in flight: the
    // host lists the new thread immediately, so updateSessionInList can file it
    // first. A second copy means duplicate React keys — two rows for one session
    // that both render `active` and freeze at stale titles.
    sessions = [info, ...sessions.filter((candidate) => candidate.id !== info.id)]
    draftOnlySessionIds.add(info.id)
    if (pending?.cancelled) {
      void klausApi.session.delete(info.id).catch(() => {})
      return info.id
    }
    if (pending) promotePendingComposerSubmission(pending, info.id)
    if (pending && !pending.cancelled) {
      saveRunModeForDraft(info.id)
      forgetRunModeForDraft(null)
    }
    // A later navigation can be another empty draft, so sessionId alone cannot
    // authorize this completion to take over its UI or preparation state.
    if (isCurrent() && window.currentSessionId === null && (welcomeEl.style.display !== 'none' || pending && visiblePendingSubmissionId === pending.id)) {
      if (pending) {
        // The submitted snapshot already left the composer. Only its next draft
        // moves to the new conversation, before any asynchronous view binding.
        setDraft(info.id, composedInputDraft())
        setWelcomeDraft('')
      }
      window.currentSessionId = info.id
      // Keep the host-owned browser scope in lockstep with the visible task before
      // its first turn can invoke a browser tool. Existing-session navigation does
      // this in switchSession; promotion needs the same ordering or the host
      // correctly rejects the tool's panel-open request as background work.
      await window.klaus?.browserUse?.setConversation?.(info.id).catch(() => {})
      // The await above gives the user time to select another task or start another
      // new chat. Do not let the completed promotion reclaim that newer surface.
      if (!isCurrent() || window.currentSessionId !== info.id) {
        renderSessionList()
        return info.id
      }
      creatingGoalSessions.promote(null, info.id)
      preparingSubmissions.promote(null, info.id)
      updateGoalIndicator()
      updateSpecBanner()
      // A promotion without a pending submission (attachment-only) still moves
      // the live welcome composer content into the per-session draft slot.
      if (!pending) {
        setDraft(info.id, composedInputDraft())
        setWelcomeDraft('')
        saveRunModeForDraft(info.id)
        forgetRunModeForDraft(null)
      }
      window.dispatchEvent(new CustomEvent('klaus:session-change', { detail: { sessionId: info.id } }))
      if (pending) {
        visiblePendingSubmissionId = null
        showTranscriptSurface()
      } else {
        welcomeEl.style.display = 'flex'
        messagesEl.style.display = 'none'
      }
      syncTopModeButtons()
      updateScrollToBottomBtn()
      refreshWorkdirButton()
      renderFollowUpQueue()
      renderTaskPanel()
      void refreshTasksForSession(info.id)
    }
    renderSessionList()
    return info.id
  })
  promoteInflight = promotion
  try {
    const id = await promotion
    if (id && pending && !pending.cancelled && !pending.sessionId) {
      promotePendingComposerSubmission(pending, id)
      saveRunModeForDraft(id)
      forgetRunModeForDraft(null)
      if (window.currentSessionId === null && visiblePendingSubmissionId === pending.id
        && goalInteractions.token(null) === pending.navigationToken) {
        setDraft(id, composedInputDraft())
        setWelcomeDraft('')
        window.currentSessionId = id
        creatingGoalSessions.promote(null, id)
        preparingSubmissions.promote(null, id)
        await window.klaus?.browserUse?.setConversation?.(id).catch(() => {})
        if (window.currentSessionId === id && !pending.cancelled) {
          visiblePendingSubmissionId = null
          window.dispatchEvent(new CustomEvent('klaus:session-change', { detail: { sessionId: id } }))
          showTranscriptSurface()
          renderSessionList()
        }
      }
    }
    return id
  } finally { if (promoteInflight === promotion) promoteInflight = null }
}

function forgetSessionLocalState(id: string, deleted = true) {
  retireSessionStream(id, { deleted })
  goalSnapshots.forget(id)
  goalPursuitEligibility.delete(id)
  retireGoalSessionCaches(id)
  if (openGoalSessionId === id) { window.KlausPanelTabs?.closeGoal?.(); closeGoalPanel() }
  engineQueueBySession.delete(id)
  forgetLocallySentSteers(id)
  draftOnlySessionIds.delete(id)
  submittedTurnSessionIds.delete(id)
  clearUnsentSubmission(id)
  forgetRunModeForDraft(id)
  forgetTerminalGroup(id)
  reloadOnMessageCompleteSessions.delete(id)
  runningSessions.delete(id)
  sidebarListedWorkingSessions.delete(id)
  forgetSessionInputSnoozes(id)
  backgroundAgentPoller.cancel(id)
  _agentMissingObservations.delete(id)
  window.KlausBackgroundProcessPanel?.forgetSession?.(id)
  // The durable rows belong to the host, which discards them when the session is
  // deleted; only this renderer's cache and in-flight mutation guards are local.
  clientQueueBySession.delete(id)
  forgetPendingQueueAdditionsForSession(id)
  for (const key of [...clientQueueMutationsInFlight]) {
    if (key.startsWith(`${id}\u0000`)) clientQueueMutationsInFlight.delete(key)
  }
  forgetEditedQueueReinsert(id)
  inlineUserEdits.forgetSession(id)
  markSidebarSessionSeen(id, { render: false })
  if (_agentSaveTimers.has(id)) {
    clearTimeout(_agentSaveTimers.get(id))
    _agentSaveTimers.delete(id)
  }
  _agentSaveFailures.delete(id)
  tasksBySession.delete(id)
  taskPanel.unavailable.delete(id)
  taskPanel.metadata.delete(id)
  taskPanel.requestIds.delete(id)
  taskPanel.liveVersions.delete(id)
  forgetTaskItems(id)
  untrackApprovalRequestsOfSession(id)
  pendingPermissionsBySession.delete(id)

  if (specDocBySession.delete(id)) persistLocalValue('klaus_approved_spec_docs_v2', JSON.stringify(Object.fromEntries(specDocBySession)))
  ctxPanel.sessions.delete(id)
  ctxPanel.inflight.delete(id)
  ctxPanel.loading.delete(id)
  const pendingCtx = ctxPanel.pending.get(id)
  if (pendingCtx) clearTimeout(pendingCtx)
  ctxPanel.pending.delete(id)
  if (sessionDrafts.has(id)) {
    sessionDrafts.delete(id)
    persistDrafts()
  }
  if (sessionHistories.has(id)) {
    sessionHistories.delete(id)
    persistSessionHistories()
  }
  dropPendingFilesForSession(id)
}

// 删除确认框里的会话名：整句内联展示，过长的标题截断，避免一行标题把
// 弹窗正文撑成一大片。
function sessionActionMessageWithProcesses(message: string, sessionId: string) {
  const count = window.KlausBackgroundProcessPanel?.count?.(sessionId, true) || 0
  if (!count) return message
  return `${message}\n\n${tt('background_process_close_guard').replace('{count}', String(count))}`
}

function deleteConfirmSessionName(session: SessionInfo | undefined) {
  const name = sessionDisplayTitle(session) || tt('untitled')
  return name.length > 44 ? `${name.slice(0, 44)}…` : name
}

async function saveSessionDeletePreference(key: string, value: boolean) {
  try {
    const result = await klausApi.settings.kv.set(key, value ? 'on' : 'off')
    if (result?.ok === false || result?.error) throw new Error(result?.error || tt('preferences_save_failed'))
  } catch (error: any) {
    showToast(error?.message || tt('preferences_save_failed'))
  }
}

// 删除会话：三类工作区分支处理。
// - projectless（不使用项目）：确认框 + 「一并移除隔离工作区」勾选，勾选态持久记忆；
//   勾上才 wipe ~/.klaus/sessions/<id>/（引擎护栏保证删不到 SESSIONS_DIR 之外）。
// - 本地模式项目会话：普通确认框，只删会话文件，项目目录永远不动。
// - worktree 会话：确认框 + 「移除工作树目录」勾选（持久记忆，删的是隔离副本，
//   分支保留）；不勾则只删会话文件。
// opts.skipConfirm：归档页批量/单条删除自带确认，跳过这里的弹框（不 wipe、不动 worktree）。
async function deleteSession(id: string, opts: { skipConfirm?: boolean } = {}) {
  if (sessionDeletePending.has(id)) return
  const target = findKnownSession(id)
  const targetWorkdir = normalizeProjectWorkdir(target?.workdir)
  const isWorktree = isWorktreeSessionWorkdir(targetWorkdir)

  const doDelete = async (wipeWorkspace: boolean, removeWorktree: boolean) => {
    if (sessionDeletePending.has(id)) return
    sessionDeletePending.add(id)
    try {
      const deleted = await klausApi.session.delete(id, { wipeWorkspace })
      if (deleted?.ok !== true) throw new Error(deleted?.error || tt('delete_session_failed'))
      sessionDeletionRevision++
      // 离开动作放在删除确认之后：请求失败时用户仍停留在原会话，
      // 可以直接重试，不需要重建会话状态。
      if (window.currentSessionId === id) enterNewChatState({ workdir: targetWorkdir })
      if (removeWorktree && targetWorkdir) {
        const res = await klausApi.worktree.remove(targetWorkdir)
          .catch((err: unknown) => ({ ok: false, error: String((err as Error | null)?.message || err) }))
        if (res?.ok) showToast(tt('worktree_removed'))
        else await window.klausDialog.alert(`${tt('worktree_remove_failed')}：${res?.error || 'unknown'}`)
      }
      sessions = sessions.filter((s) => s.id !== id)
      archivedSessions = archivedSessions.filter((s) => s.id !== id)
      forgetSessionLocalState(id)
      renderSessionList()
    } finally {
      sessionDeletePending.delete(id)
    }
  }

  if (opts.skipConfirm) {
    await doDelete(false, false)
    return
  }

  const sessionName = deleteConfirmSessionName(target)
  // 对话框路径：确认按钮带 loading，请求成功才关闭弹窗并 toast，失败保持弹窗可重试。
  const runDeleteWithToast = async (wipeWorkspace: boolean, removeWorktree: boolean): Promise<boolean> => {
    try {
      await doDelete(wipeWorkspace, removeWorktree)
      return true
    } catch (error) {
      showToast(`${tt('delete_session_failed')} ${(error as Error | null)?.message || ''}`.trim(), { tone: 'danger' })
      return false
    }
  }
  const dialogConfirmed = (result: unknown) =>
    result === true || (typeof result === 'object' && result !== null && (result as { confirmed?: boolean }).confirmed === true)

  if (isWorktree) {
    let remembered = false
    try { remembered = (await klausApi.settings.kv.get(SESSION_DELETE_REMOVE_WORKTREE_KEY)) === 'on' } catch {}
    const answer = await window.klausDialog.confirm({
      title: tt('delete_session_title'),
      message: sessionActionMessageWithProcesses(tt('worktree_delete_message').replace('{title}', sessionName), id),
      confirmText: tt('session_menu_delete'),
      danger: true,
      checkbox: { label: tt('worktree_delete_checkbox'), defaultChecked: remembered },
      onConfirm: async (_value: string, checked: boolean) => {
        await saveSessionDeletePreference(SESSION_DELETE_REMOVE_WORKTREE_KEY, checked)
        return runDeleteWithToast(false, checked)
      },
    })
    if (dialogConfirmed(answer)) showToast(tt('toast_deleted'), { tone: 'success' })
  } else if (!targetWorkdir) {
    let remembered = false
    try { remembered = (await klausApi.settings.kv.get(SESSION_DELETE_WIPE_PROJECTLESS_KEY)) === 'on' } catch {}
    const answer = await window.klausDialog.confirm({
      title: tt('delete_session_title'),
      message: sessionActionMessageWithProcesses(tt('delete_session_message').replace('{title}', sessionName), id),
      confirmText: tt('session_menu_delete'),
      danger: true,
      checkbox: { label: tt('projectless_delete_checkbox'), defaultChecked: remembered },
      onConfirm: async (_value: string, checked: boolean) => {
        await saveSessionDeletePreference(SESSION_DELETE_WIPE_PROJECTLESS_KEY, checked)
        return runDeleteWithToast(checked, false)
      },
    })
    if (dialogConfirmed(answer)) showToast(tt('toast_deleted'), { tone: 'success' })
  } else {
    const answer = await window.klausDialog.confirm({
      title: tt('delete_session_title'),
      message: sessionActionMessageWithProcesses(tt('delete_session_message').replace('{title}', sessionName), id),
      confirmText: tt('session_menu_delete'),
      danger: true,
      onConfirm: async () => runDeleteWithToast(false, false),
    })
    if (dialogConfirmed(answer)) showToast(tt('toast_deleted'), { tone: 'success' })
  }
}

function syncArchivedSessionUi() {
  const archived = !!findKnownSession(window.currentSessionId)?.archived
  if (archivedSessionBannerEl) archivedSessionBannerEl.hidden = !archived
  if (inputWrapperEl) inputWrapperEl.hidden = archived
  if (followUpQueueEl && archived) followUpQueueEl.hidden = true
  // 归档态翻转时同步 rewind/delete 按钮的可用态（前置能力提示）。
  syncMessageActionAvailability()
}

archivedSessionContinueEl?.addEventListener('click', () => {
  if (!window.currentSessionId) return
  forkSessionFromMenu(window.currentSessionId).catch((error: unknown) => {
    window.klausDialog.alert(sessionActionErrorText((error as Error | null)?.message || error, 'fork_session_failed'))
  })
})

function resetStreamState(surface = activeRenderSurface) {
  cancelStreamPaint(surface) // 丢弃排期中的帧绘制，防止回调画进新会话的 DOM
  surface.stream.buffer = ''; surface.stream.currentMsgGroup = null
  surface.thinkingUI.reset() // 丢弃上一轮未完成的 indicator（含 DOM）
  surface.turnActivityUI.hide() // 同理丢弃脉冲指示器，别让它跨会话残留
  // The agent panel is a main-surface concern only.
  if (surface !== mainSurface) return
  // Don't clear tasksBySession — it's keyed per session, leaving other
  // sessions' agents intact. The strip is standing, so it just repaints.
  renderSubagentSection()
}

// ==================== Message-meta (time + copy) helpers ====================

// HH:MM for today, MM-DD HH:MM otherwise. Empty string if ts is missing/bad.
function formatMsgTime(ts: number) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

const COPY_ICON_SVG = klausIcon('copy')
const CHECK_ICON_SVG = klausIcon('check')

function copyTextToClipboard(text: string, btn: HTMLElement) {
  writeClipboardText(text || '').then(() => {
    if (!btn) return
    btn.classList.add('copied')
    btn.innerHTML = CHECK_ICON_SVG
    btn.setAttribute('aria-label', tt('copied'))
    setTimeout(() => {
      btn.classList.remove('copied')
      btn.innerHTML = COPY_ICON_SVG
      btn.setAttribute('aria-label', tt('copy'))
    }, 1500)
  }).catch(() => {
    if (btn) btn.setAttribute('aria-label', tt('copy_failed'))
  })
}

// Rewind = curved-arrow back; Branch = git-branch fork. Same
// 24x24 viewBox + stroke style as the copy icon so the row stays visually
// homogeneous.
const REWIND_ICON_SVG = klausIcon('rewind')
const BRANCH_ICON_SVG = klausIcon('branch')

// 把「归档只读 / 会话运行中」这类能力限制前置到 rewind 按钮态：
// disabled + title 写明原因，用户不必点了才知道。状态变化入口（busy 切换、
// 归档切换、按钮挂载）都会调这里，保证态实时。
function syncMessageActionAvailability() {
  const archived = !!findKnownSession(window.currentSessionId)?.archived
  const running = busy
  const disabled = archived || running
  const reason = archived ? tt('msg_actions_archived') : running ? tt('msg_actions_busy') : ''
  messagesEl.querySelectorAll<HTMLButtonElement>('.msg-action-btn[data-action="rewind"]').forEach((btn) => {
    btn.disabled = disabled
    btn.title = disabled ? reason : (btn.dataset.baseTitle || btn.title)
    btn.setAttribute('aria-disabled', String(disabled))
  })
  // 分支不受归档限制（只读会话靠它继续），仅运行中禁用。
  messagesEl.querySelectorAll<HTMLButtonElement>('.msg-action-btn[data-action="branch"]').forEach((btn) => {
    btn.disabled = running
    btn.title = running ? tt('msg_actions_busy') : tt('msg_branch')
    btn.setAttribute('aria-disabled', String(running))
  })
}

// ==================== /btw Side Question ====================

let btwPanelEl: HTMLElement | null = null
let btwPanelSeq = 0
let btwPanelSessionId: string | null = null
let btwPanelRequestId: string | null = null

function ensureBtwPanel() {
  if (btwPanelEl) return btwPanelEl
  btwPanelEl = document.createElement('div')
  btwPanelEl.id = 'btw-panel'
  btwPanelEl.className = 'btw-panel'
  btwPanelEl.hidden = true
  if (inputWrapperEl?.parentElement) inputWrapperEl.parentElement.insertBefore(btwPanelEl, inputWrapperEl)
  else document.body.appendChild(btwPanelEl)
  return btwPanelEl
}

function parseBtwSlashInput(text: string) {
  const trimmed = (text || '').trim()
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(trimmed)
  if (!match) return null
  return (match[1] || '').trim()
}

function renderBtwPanel({ question, state, response, error, commandLabel }: { question?: string; state: string; response?: string; error?: string; commandLabel?: string }) {
  const panel = ensureBtwPanel()
  panel.hidden = false
  panel.dataset.state = state
  const label = commandLabel || slashCommandDisplayName({ name: 'btw' }) || tt('btw_label') || '/btw'
  const body = state === 'loading'
    ? `<div class="btw-loading"><span class="btw-spinner" aria-hidden="true"></span><span>${escapeHtml(tt('btw_answering') || 'Answering...')}</span></div>`
    : state === 'error'
      ? renderErrorNoticeHtml(error || tt('error') || 'Error')
      : `<div class="btw-answer">${renderMarkdownHtml(response || '', btwPanelSessionId || '')}</div>`
  panel.innerHTML = `
    <div class="btw-head">
      <span class="btw-command" title="/btw">${SLASH_PILL_ICON_SVG}<span>${escapeHtml(label)}</span></span>
      <span class="btw-question">${escapeHtml(question || tt('btw_usage') || 'Usage: /btw <your question>')}</span>
      <button class="btw-close" type="button" aria-label="${escapeHtml(tt('close_btn') || 'Close')}">
        ${klausIcon('btw-close')}
      </button>
    </div>
    <div class="btw-body">${body}</div>
    ${state !== 'loading' ? `<div class="btw-foot">${escapeHtml(tt('btw_dismiss_hint') || 'Esc to dismiss')}</div>` : ''}
  `
  panel.querySelector('.btw-close')?.addEventListener('click', hideBtwPanel)
}

function hideBtwPanel() {
  btwPanelSeq++
  btwPanelSessionId = null
  const requestId = btwPanelRequestId
  btwPanelRequestId = null
  if (requestId) void klausApi.chat.cancelSideQuestion(requestId).catch(() => {})
  if (btwPanelEl) btwPanelEl.hidden = true
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && btwPanelEl && !btwPanelEl.hidden) hideBtwPanel()
})

async function submitBtwQuestion(question: string) {
  const trimmed = (question || '').trim()
  const commandLabel = slashCommandDisplayName(selectedSlashCommand?.name === 'btw' ? selectedSlashCommand : { name: 'btw' }) || tt('btw_label') || '/btw'
  hideSlashMenu()
  hideComposerPlusMenu()
  setComposerText('')
  autoResize()
  updateSendBtn()
  if (window.currentSessionId) setDraft(window.currentSessionId, '')

  if (!trimmed) {
    renderBtwPanel({ question: '', state: 'error', error: tt('btw_usage') || 'Usage: /btw <your question>', commandLabel })
    inputEl.focus()
    return
  }

  const targetSessionId = await ensureSession()
  const seq = ++btwPanelSeq
  const requestId = crypto.randomUUID()
  btwPanelSessionId = targetSessionId
  btwPanelRequestId = requestId
  setDraft(targetSessionId, '')
  renderBtwPanel({ question: trimmed, state: 'loading', commandLabel })
  inputEl.focus()

  try {
    const result = await klausApi.chat.sideQuestion(targetSessionId, trimmed, requestId)
    if (seq !== btwPanelSeq || btwPanelSessionId !== targetSessionId || window.currentSessionId !== targetSessionId) return
    btwPanelRequestId = null
    if (result?.ok && result.response) {
      renderBtwPanel({ question: trimmed, state: 'done', response: result.response, commandLabel })
    } else {
      renderBtwPanel({ question: trimmed, state: 'error', error: result?.error || tt('btw_no_response') || 'No response received', commandLabel })
    }
  } catch (err) {
    if (seq !== btwPanelSeq || btwPanelSessionId !== targetSessionId || window.currentSessionId !== targetSessionId) return
    btwPanelRequestId = null
    renderBtwPanel({ question: trimmed, state: 'error', error: (err as Error | null)?.message || String(err), commandLabel })
  }
}

// ==================== Send ====================

const SUGGESTION_MAX_ATTACHMENTS = 8
const SUGGESTION_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

function supportEmailStatusMessage(email: FeedbackEmailStatus | null | undefined, notConfiguredKey: string) {
  if (email?.serverAccepted) {
    if (email?.sent) {
      return (tt('feedback_server_received_email_sent') || 'Submitted to Klaus support and emailed to {to}.')
        .replace('{to}', email.to || 'support@klaus-ai.cn')
    }
    return tt('feedback_server_received') || 'Submitted to Klaus support.'
  }
  if (email?.skippedReason === 'not_authenticated') {
    return tt('feedback_not_authenticated') || 'Sign in to submit this to Klaus support.'
  }
  if (email?.sent) {
    return (tt('feedback_email_sent') || 'Email sent to {to}.')
      .replace('{to}', email.to || '')
  }
  if (email?.attempted) {
    return (tt('feedback_email_failed') || 'Could not send this to Klaus support right now.')
      .replace('{error}', email.error || 'Unknown error')
  }
  if (email?.skippedReason === 'smtp_not_configured') {
    return (tt(notConfiguredKey) || tt('feedback_email_not_configured') || 'Issue recorded, but could not be sent to Klaus support right now.')
      .replace('{to}', email.to || 'support@klaus-ai.cn')
  }
  return ''
}

function debugReportSubmittedMessage(result: FeedbackSubmitResult | null | undefined) {
  const template = tt('feedback_submitted') || 'Issue recorded. Reference ID: {id}'
  const parts = [template
    .replace('{id}', result?.feedbackId || '')
    .replace('{path}', result?.filePath || '')]
  parts.push(supportEmailStatusMessage(result?.email, 'feedback_email_not_configured'))
  return parts.filter(Boolean).join('\n')
}

function suggestionSubmittedMessage(result: FeedbackSubmitResult | null | undefined) {
  const template = tt('suggestion_submitted') || 'Suggestion recorded. Reference ID: {id}'
  const parts = [template
    .replace('{id}', result?.suggestionId || '')
    .replace('{path}', result?.filePath || '')]
  parts.push(supportEmailStatusMessage(result?.email, 'suggestion_email_not_configured'))
  return parts.filter(Boolean).join('\n')
}

async function submitDebugReport(description: string | { description: string; attachments: FeedbackAttachment[] }) {
  let finalDescription = String(description || '').trim()
  if (!finalDescription) {
    const entered = await window.klausDialog.prompt!({
      title: tt('feedback_title') || 'Report issue',
      message: tt('feedback_prompt') || 'Describe what happened. Klaus will use your description to help the support team investigate. You can review the next step before anything is submitted.',
      placeholder: tt('feedback_placeholder') || 'What went wrong?',
      confirmText: tt('feedback_continue') || 'Continue',
      multiline: true,
    })
    if (entered === null) { inputEl.focus(); return }
    finalDescription = String(entered || '').trim()
  }

  if (!finalDescription) {
    await window.klausDialog.alert(tt('feedback_required') || 'Please describe the issue before submitting.')
    inputEl.focus()
    return
  }

  const ok = await window.klausDialog.confirm({
    title: tt('feedback_consent_title') || 'Include session context?',
    message: tt('feedback_consent_message') || 'Klaus will include your description and relevant conversation context so the support team can investigate. Sensitive information such as passwords and private credentials is hidden before submission.',
    confirmText: tt('feedback_submit') || 'Submit',
    cancelText: tt('cancel') || 'Cancel',
  })
  if (!ok) { inputEl.focus(); return }

  hideSlashMenu(); hideComposerPlusMenu()
  const targetSessionId = await ensureSession()

  try {
    const result = await klausApi.feedback.submit(targetSessionId, finalDescription)
    if (result?.ok) {
      await window.klausDialog.alert({
        title: result?.email?.serverAccepted
          ? (tt('feedback_submitted_title') || 'Issue report submitted')
          : (tt('feedback_saved_title') || 'Issue recorded'),
        message: debugReportSubmittedMessage(result),
      })
    } else {
      await window.klausDialog.alert({
        title: tt('feedback_failed') || 'Failed to submit issue report.',
        message: tt('feedback_failed_retry') || 'Please try again later.',
      })
    }
  } catch (err) {
    console.error('Failed to submit issue report', err)
    await window.klausDialog.alert({
      title: tt('feedback_failed') || 'Failed to submit issue report.',
      message: tt('feedback_failed_retry') || 'Please try again later.',
    })
  } finally {
    inputEl.focus()
  }
}

function renderSuggestionAttachments(listEl: HTMLElement, attachments: FeedbackAttachment[]) {
  if (!listEl) return
  if (!attachments.length) {
    listEl.innerHTML = `<div class="suggestion-attachment-empty">${escapeHtml(tt('suggestion_no_attachments') || 'No attachments yet')}</div>`
    return
  }
  listEl.innerHTML = attachments.map((attachment, idx: number) => {
    const name = attachment.name || attachment.path?.split(/[\\/]/).pop() || 'attachment'
    const meta = formatFileSize(attachment.size)
    const isScreenshot = attachment.kind === 'screenshot' && attachment.previewUrl
    if (isScreenshot) {
      return `
        <div class="suggestion-attachment-shot">
          <button class="suggestion-shot-preview" type="button" data-preview-screenshot="${idx}" title="${escapeHtml(name)}">
            <img src="${escapeHtml(attachment.previewUrl)}" alt="${escapeHtml(name)}">
          </button>
          <button class="suggestion-attachment-remove suggestion-shot-remove" type="button" data-remove-attachment="${idx}" title="${escapeHtml(tt('suggestion_attachment_remove') || 'Remove attachment')}">
            ${klausIcon('close')}
          </button>
        </div>
      `
    }
    const ext = fileExtLabel(name)
    return `
      <div class="suggestion-attachment-file">
        <button class="suggestion-attachment-remove suggestion-file-remove" type="button" data-remove-attachment="${idx}" title="${escapeHtml(tt('suggestion_attachment_remove') || 'Remove attachment')}">
          ${klausIcon('close')}
        </button>
        <div class="suggestion-file-card" title="${escapeHtml(name)}">
          <span class="suggestion-file-name">${escapeHtml(name)}</span>
          ${meta ? `<span class="suggestion-file-meta">${escapeHtml(meta)}</span>` : ''}
          <span class="suggestion-file-ext">${escapeHtml(ext)}</span>
        </div>
      </div>
    `
  }).join('')
  listEl.querySelectorAll<HTMLElement>('[data-remove-attachment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-remove-attachment'))
      if (!Number.isInteger(idx)) return
      attachments.splice(idx, 1)
      renderSuggestionAttachments(listEl, attachments)
    })
  })
  listEl.querySelectorAll<HTMLElement>('[data-preview-screenshot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-preview-screenshot'))
      const attachment = Number.isInteger(idx) ? attachments[idx] : null
      if (attachment?.previewUrl) openImagePreview(attachment.previewUrl)
    })
  })
}

function openSuggestionDialog() {
  return new Promise((resolve: (v?: unknown) => void) => {
    const root = document.getElementById('klaus-dialog-root') || document.body
    const overlay = document.createElement('div')
    const attachments: FeedbackAttachment[] = []
    overlay.className = 'klaus-dialog-overlay suggestion-dialog-overlay'
    overlay.innerHTML = `
      <div class="klaus-dialog-backdrop"></div>
      <div class="klaus-dialog-card suggestion-dialog-card" role="dialog" aria-modal="true">
        <div class="klaus-dialog-title">${escapeHtml(tt('suggestion_title') || 'Submit suggestion')}</div>
        <div class="klaus-dialog-message suggestion-dialog-message">${escapeHtml(tt('suggestion_prompt') || 'Tell the Klaus team what you would like improved.')}</div>
        <textarea class="klaus-dialog-input klaus-dialog-textarea suggestion-dialog-textarea" id="suggestion-description" placeholder="${escapeHtml(tt('suggestion_placeholder') || 'What should Klaus improve?')}"></textarea>
        <div class="suggestion-attachment-actions">
          <button class="suggestion-action-btn" type="button" data-add-attachments>
            ${klausIcon('suggestion-action-btn')}
            <span>${escapeHtml(tt('suggestion_add_attachment') || 'Add attachment')}</span>
          </button>
          <button class="suggestion-action-btn" type="button" data-add-screenshot>
            ${klausIcon('suggestion-action-btn-2')}
            <span>${escapeHtml(tt('suggestion_add_screenshot') || 'Add screenshot')}</span>
          </button>
        </div>
        <div class="suggestion-attachment-list"></div>
        <div class="suggestion-form-error" aria-live="polite"></div>
        <div class="klaus-dialog-footer suggestion-dialog-footer">
          <button class="klaus-dialog-btn klaus-dialog-cancel" type="button">${escapeHtml(tt('cancel') || 'Cancel')}</button>
          <button class="klaus-dialog-btn klaus-dialog-confirm" type="button">${escapeHtml(tt('suggestion_submit') || 'Submit')}</button>
        </div>
      </div>
    `
    root.appendChild(overlay)
    requestAnimationFrame(() => overlay.classList.add('active'))

    const textarea = overlay.querySelector<HTMLTextAreaElement>('#suggestion-description')
    const errorEl = overlay.querySelector('.suggestion-form-error')
    const listEl = overlay.querySelector('.suggestion-attachment-list')
    const addAttachmentsBtn = overlay.querySelector('[data-add-attachments]')
    const addScreenshotBtn = overlay.querySelector('[data-add-screenshot]')
    renderSuggestionAttachments(listEl as HTMLElement, attachments)

    let closed = false
    const setError = (message: string) => { if (errorEl) errorEl.textContent = message || '' }
    const close = (value: { description: string; attachments: FeedbackAttachment[] } | null) => {
      if (closed) return
      closed = true
      overlay.classList.remove('active')
      document.removeEventListener('keydown', onKey, true)
      setTimeout(() => overlay.remove(), 160)
      resolve(value)
    }
    const addAttachmentItems = (items: FeedbackAttachment[]) => {
      let errorMessage = ''
      for (const item of items || []) {
        if (!item?.path || attachments.some(existing => existing.path === item.path)) continue
        if (attachments.length >= SUGGESTION_MAX_ATTACHMENTS) {
          errorMessage = (tt('suggestion_attachment_limit') || 'You can attach up to {count} files.')
            .replace('{count}', String(SUGGESTION_MAX_ATTACHMENTS))
          break
        }
        const nextTotal = attachments.reduce((sum, existing) => sum + (Number(existing.size) || 0), 0) + (Number(item.size) || 0)
        if (nextTotal > SUGGESTION_MAX_ATTACHMENT_BYTES) {
          errorMessage = (tt('suggestion_attachment_size_limit') || 'Attachments are limited to {size} total.')
            .replace('{size}', formatFileSize(SUGGESTION_MAX_ATTACHMENT_BYTES))
          continue
        }
        attachments.push({
          path: item.path,
          name: item.name,
          size: item.size,
          contentType: item.contentType,
          previewUrl: item.previewUrl,
          kind: item.kind,
        })
      }
      renderSuggestionAttachments(listEl as HTMLElement, attachments)
      setError(errorMessage)
    }
    const submit = () => {
      const description = String(textarea?.value || '').trim()
      if (!description) {
        setError(tt('suggestion_required') || 'Please describe your suggestion before submitting.')
        textarea?.focus()
        return
      }
      close({
        description,
        attachments: attachments.map((item) => ({
          path: item.path,
          name: item.name,
          size: item.size,
          contentType: item.contentType,
        })),
      })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close(null)
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        e.stopPropagation()
        submit()
      }
    }

    addAttachmentsBtn?.addEventListener('click', async () => {
      ;(addAttachmentsBtn as HTMLButtonElement).disabled = true
      setError('')
      try {
        const result = await klausApi.feedback.pickAttachments?.()
        if (result?.ok) addAttachmentItems(result.attachments)
        else setError(result?.error || tt('suggestion_attachment_error') || 'Failed to add attachment.')
      } catch (err) {
        setError((err as Error | null)?.message || String(err))
      } finally {
        ;(addAttachmentsBtn as HTMLButtonElement).disabled = false
        textarea?.focus()
      }
    })
    addScreenshotBtn?.addEventListener('click', async () => {
      ;(addScreenshotBtn as HTMLButtonElement).disabled = true
      setError('')
      try {
        overlay.style.visibility = 'hidden'
        await new Promise((resolve: (v?: unknown) => void) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const result = await klausApi.feedback.captureScreenshot?.()
        overlay.style.visibility = ''
        if (result?.ok && result.attachment) addAttachmentItems([result.attachment])
        else setError(result?.error || tt('suggestion_screenshot_error') || 'Failed to capture screenshot.')
      } catch (err) {
        overlay.style.visibility = ''
        setError((err as Error | null)?.message || String(err))
      } finally {
        overlay.style.visibility = ''
        ;(addScreenshotBtn as HTMLButtonElement).disabled = false
        textarea?.focus()
      }
    })
    overlay.querySelector('.klaus-dialog-backdrop')?.addEventListener('click', () => close(null))
    overlay.querySelector('.klaus-dialog-cancel')?.addEventListener('click', () => close(null))
    overlay.querySelector('.klaus-dialog-confirm')?.addEventListener('click', submit)
    document.addEventListener('keydown', onKey, true)
    setTimeout(() => textarea?.focus(), 0)
  })
}

async function submitSuggestion() {
  const payload = await openSuggestionDialog()
  if (!payload) { inputEl.focus(); return }
  hideSlashMenu(); hideComposerPlusMenu()

  try {
    const result = await klausApi.feedback.submitSuggestion(payload)
    if (result?.ok) {
      await window.klausDialog.alert({
        title: result?.email?.serverAccepted
          ? (tt('suggestion_submitted_title') || 'Suggestion submitted')
          : (tt('suggestion_saved_title') || 'Suggestion saved'),
        message: suggestionSubmittedMessage(result),
      })
    } else {
      await window.klausDialog.alert({
        title: tt('suggestion_failed') || 'Failed to submit suggestion.',
        message: result?.error || (tt('suggestion_failed') || 'Failed to submit suggestion.'),
      })
    }
  } catch (err) {
    await window.klausDialog.alert({
      title: tt('suggestion_failed') || 'Failed to submit suggestion.',
      message: (err as Error | null)?.message || String(err),
    })
  } finally {
    inputEl.focus()
  }
}

function buildOutgoingPayload(
  text: string,
  files: PendingFileEntry[],
  sentSlashCommand: SlashCommandInfo | null,
  targetSessionId = '',
  composerReferences: ComposerReferenceToken[] = [],
  composerDocument?: ComposerDocumentSnapshot,
  releasePastedText = true,
) {
  const pastedCards = files
    .filter((entry) => entry.kind === 'pasted-text')
    .map((entry) => ({
      ...(entry.uploadPath ? { path: entry.uploadPath } : {}),
      text: entry.text || '',
      preview: entry.previewText || pastedTextPreview(entry.text || ''),
      previewText: entry.previewText || pastedTextPreview(entry.text || ''),
      ...(Number.isFinite(entry.characterCount) ? { characterCount: Number(entry.characterCount) } : {}),
      ...(Number.isInteger(entry.requestOffset) ? { requestOffset: Number(entry.requestOffset) } : {}),
      ...(Number.isInteger(entry.displayOrder) ? { displayOrder: Number(entry.displayOrder) } : {}),
    }))
  const pastedRequest = composePastedTextRequest(text, pastedCards)
  const pastedPaths = pastedCards.map(card => card.path).filter((path): path is string => typeof path === 'string' && !!path)
  if (releasePastedText && pastedPaths.length) void klausApi.chat.pastedTextRelease(pastedPaths).catch(() => undefined)
  const selectedTextAttachments = files
    .filter((entry) => entry.kind === 'selected-text')
    .map((entry) => ({
      text: entry.text || '',
      previewText: entry.previewText || pastedTextPreview(entry.text || ''),
      ...(entry.quoteId ? { quoteId: entry.quoteId } : {}),
      ...(Number.isInteger(entry.requestOffset) ? { requestOffset: Number(entry.requestOffset) } : {}),
      ...(Number.isInteger(entry.displayOrder) ? { displayOrder: Number(entry.displayOrder) } : {}),
    }))
    .filter((entry) => entry.text)
  const encodedSelectedTextAttachments = selectedTextAttachments.map((entry) => ({
    ...entry,
    ...(Number.isInteger(entry.requestOffset) ? {
      requestOffset: pastedRequest.requestOffsetFor(Number(entry.requestOffset), entry.displayOrder),
    } : {}),
  }))
  // Slash commands must stay the first model-visible token so the host can
  // expand them. Text cards follow it in their authored display order.
  const bodyText = text.trimStart().startsWith('/')
    ? composeSlashTextCards(text, files.filter((entry) => entry.kind === 'selected-text' || (entry.kind === 'pasted-text' && !entry.uploadPath)) as Array<PendingFileEntry & { kind: 'pasted-text' | 'selected-text' }>) + pastedReferenceSection(pastedCards)
    : pastedRequest.text
  const attachedFiles = files.filter((entry) => entry.kind !== 'pasted-text' && entry.kind !== 'selected-text')
  // Both arrays must describe the SAME attachments: liveAttachments feeds the
  // optimistic bubble, media feeds the engine. Filtering only one of them drew a
  // picture the engine never received, with nothing on screen saying so. An entry
  // with no uploadPath never landed on disk, so it leaves both — and is named,
  // because a silently missing attachment is indistinguishable from a model that
  // chose to ignore it.
  const sendableFiles = attachedFiles.filter((entry) => entry.uploadPath)
  const droppedFiles = attachedFiles.filter((entry) => !entry.uploadPath)
  if (droppedFiles.length > 0) {
    showToast(tt('attachment_dropped_not_uploaded') + droppedFiles.map((entry) => entry.file.name).join(', '))
  }
  // Images enter the request directly. Other files retain path references; the
  // host may additionally inline audio/video when this session's selected model
  // explicitly accepts the exact MIME type.
  const inlineFiles = sendableFiles.filter((entry) => isInlineImage(entry.file.name, entry.file.type))
  const referencedFiles = sendableFiles.filter((entry) => !isInlineImage(entry.file.name, entry.file.type))
  const referenceBlock = referencedFiles.length > 0
    ? ['Attached:', ...referencedFiles.map((entry) => `- ${entry.uploadPath}`)].join('\n')
    : ''
  const liveAttachments = sendableFiles.map((entry) => ({
    type: isInlineImage(entry.file.name, entry.file.type) ? 'image' : 'file',
    name: entry.file.name,
    path: entry.uploadPath || undefined,
    appshotContext: entry.appshotContext,
    ...(mediaInputMime(entry.file.name, entry.file.type) ? { mimeType: mediaInputMime(entry.file.name, entry.file.type) } : {}),
    // 乐观气泡的图片 src：blob 优先；路径导入的图没有 File 实体建不了 blob，
    // 走媒体通道（uploads 缓存在 previewable 范围内）。裸文件系统路径塞进
    // <img> 是必裂的图。
    src: isInlineImage(entry.file.name, entry.file.type)
      ? (entry.objectUrl
        || (entry.uploadPath ? (window.klaus?.media?.url?.(entry.uploadPath, targetSessionId || undefined) || '') : ''))
      : '',
  }))
  const media = sendableFiles.flatMap((entry) => {
    const mimeType = mediaInputMime(entry.file.name, entry.file.type)
    if (!inlineFiles.includes(entry) && !mimeType) return []
    // Session-owned host selection decides whether audio/video candidates become bytes.
    return [{ type: mimeType ? 'media' : 'image', path: entry.uploadPath, name: entry.file.name, fileName: entry.file.name,
      ...(mimeType ? { mimeType } : {}) }]
  })
  const appshotContext = sendableFiles.flatMap(entry => entry.appshotContext ? [appshotContextText(entry.appshotContext)] : []).join('\n\n')
  const requestText = [bodyText, appshotContext, resourceReferenceContext(composerReferences), referenceBlock].filter(Boolean).join('\n\n')
  const finalText = text.trimStart().startsWith('/')
    ? requestText
    : encodeSelectedTextEnvelope(requestText, encodedSelectedTextAttachments)

  return {
    text,
    finalText,
    displayText: text,
    ...(composerDocument ? { composerDocument } : {}),
    media,
    liveAttachments,
    pastedCards,
    selectedTextAttachments,
    sentSlashCommand,
    composerReferences: normalizeComposerReferences(text, composerReferences),
    ...(composerReferences.some(reference => reference.kind === 'friend') ? { friendDispatchId: crypto.randomUUID(), ...friendComposeMetadata(friendComposeContext, true) } : {}),
    createdAt: Date.now(),
  }
}

function clearComposerAfterSubmit(targetSessionId: string) {
  friendComposeContext = { intent: 'request' }
  composerPredictions?.submitted()
  setComposerText('')
  autoResize()
  hideSlashMenu()
  hideComposerPlusMenu()
  pendingFiles = []
  // This submit is on its way out; nothing may replay it afterwards.
  pendingSendAfterUpload = null
  renderPreviews()
  renderSelectedSlashCommand()
  if (targetSessionId) setDraft(targetSessionId, '')
}

/**
 * Whether a conversation is a side chat's rather than the main column's.
 *
 * Needed because the side effects of "a user message appeared" are per-surface:
 * resuming bottom-following on the main sticker when a SIDE conversation produced
 * the message would yank the main transcript to its bottom for no reason the user
 * can see. The host dispatches a side chat's queued messages with that side's
 * session id, so this is reachable from outside the side composer.
 */
function isSideChatSession(sessionId: string | null | undefined): boolean {
  return !!sessionId && sideSurfaces.has(sessionId)
}

function renderLocalUserPayload(targetSessionId: string, payload: OutgoingPayload | FollowUpQueueItem, options: { uuid?: string; edit?: EditedUserTurnSnapshot; steered?: boolean } = {}) {
  if (isSideChatSession(targetSessionId)) {
    // Side surfaces share one scroll container (#side-messages) and therefore one
    // sticker, so there is no per-surface choice to make here. The side transcript
    // has no welcome screen to hide either, which is why showTranscriptSurface is
    // main-only.
    sideSticker?.resumeFollowing()
  } else if (targetSessionId === window.currentSessionId) {
    // Only the conversation on screen may flip the main column out of the
    // welcome layout. A background session's queued dispatch or steer lands
    // here too; flipping for it would hide the new-chat welcome screen the
    // user is looking at and dock the composer back to the bottom.
    resumeMessagesBottomFollowing()
    showTranscriptSurface()
  }
  // A slash command the user attached is a reference this turn stands on; the
  // session id is resolved by now, which is why the note happens here and not
  // where the payload was built.
  noteCommandReference(targetSessionId, payload.sentSlashCommand ?? null, options.uuid || '')
  // 本地乐观气泡入 store（React transcript 消费）；旧 appendUserMsg 的 DOM 路径已退役。
  const localPayload = {
    text: payload.finalText,
    uuid: options.uuid,
    // A steer joins the running turn instead of opening one; the flag keeps the edit
    // gate from offering to rewrite it once the turn stops.
    ...(options.steered ? { steered: true } : {}),
    attachments: payload.liveAttachments,
    slashCommand: payload.sentSlashCommand,
    displayText: payload.displayText,
    ...(payload.composerDocument ? { composerDocument: payload.composerDocument } : {}),
    pastedCards: payload.pastedCards,
    selectedTextAttachments: payload.selectedTextAttachments,
    composerReferences: payload.composerReferences,
    timestamp: Date.now(),
  }
  if (options.edit) commitEditedUserTurn(targetSessionId, options.edit, localPayload)
  else ingestLocalUserTurn(targetSessionId, localPayload)
  ;(window as any).klausUpdateSideSendButton?.()
  // 首条消息落地后运行环境锁定，立即收起「运行于」行（侧面板无此行所以加 guard）。
  if (window.currentSessionId === targetSessionId) syncComposerContextRowVisibility()
}

function showTranscriptSurface(surface = activeRenderSurface) {
  // Only the main surface has a welcome screen to hide and top-mode buttons to
  // sync; the side-chat panel's transcript is always visible in its panel.
  if (surface !== mainSurface) return
  // welcome 首发白屏修复：promote（ensureSession）不走 switchSession，而
  // enterNewChatState 已卸载 React root，若不在掀开转录时兑底挂载，首条
  // 消息的乐观气泡与流式回复只进 store 不上屏。同容器重复挂载幂等
  //（transcript/index 复用 root 换 props）。
  if (window.currentSessionId) mountReactTranscript(window.currentSessionId, messagesEl, { scroll: 'main' })
  welcomeEl.style.display = 'none'
  messagesEl.style.display = 'block'
  syncTopModeButtons()
  updateScrollToBottomBtn()
}

function mainTranscriptChromeState(id: string) {
  const stream = id ? chatStreamStore.getState().sessions[id] : undefined
  // A submitted message owns the visible surface before its first turn is admitted.
  const hasSubmittedUser = stream?.liveUnits.some(unit => unit.type === 'live-user')
    || stream?.history?.some(message => message.role === 'user')
  return transcriptChromeState({
    sessionId: id,
    draftOnly: isDraftOnlySession(id) && !hasSubmittedUser,
    running: !!(stream?.running || runningSessions.has(id)),
    liveUnitCount: stream?.liveUnits?.length || 0,
    history: stream?.history,
  })
}

// 主转录是否已有内容（空壳回收与上下文分析的判定源）。历史尚未返回是
// loading，不冒充有内容，也不冒充新对话；删除路径仍会通过权威 history 复核。
function mainTranscriptHasContent(id: string) {
  return mainTranscriptChromeState(id) === 'transcript'
}

// Recycling decisions need real content, not the visible surface: a proven
// empty conversation now renders an empty transcript surface, so the chrome
// state alone can no longer tell "nothing was ever sent" from "empty thread".
function sessionStreamHasContent(id: string) {
  const stream = chatStreamStore.getState().sessions[id]
  return transcriptContentPresence({
    running: !!(stream?.running || runningSessions.has(id)),
    liveUnitCount: stream?.liveUnits?.length || 0,
    history: stream?.history,
  }) === 'present'
}

let mainTranscriptChromeSessionId: string | null = null

// Stream content updates independently. Apply shell visibility only when the
// conversation or surface changes; background tokens must not force layout.
function syncMainTranscriptChrome() {
  // Provisional submissions can own visible messages before a host session exists.
  syncComposerContextRowVisibility()
  const id = window.currentSessionId
  if (!id) return // 欢迎屏态（虚拟新对话）由 enterNewChatState 管
  const state = mainTranscriptChromeState(id)
  const showTranscript = state !== 'welcome'
  const messagesDisplay = showTranscript ? 'block' : 'none'
  const welcomeDisplay = showTranscript ? 'none' : 'flex'
  const loading = state === 'loading'
  // Check applied visibility too: new-chat navigation can hide the transcript
  // before this same conversation is reopened.
  if (mainTranscriptChromeSessionId === id && messagesEl.style.display === messagesDisplay
    && welcomeEl.style.display === welcomeDisplay && messagesEl.hasAttribute('aria-busy') === loading) return
  mainTranscriptChromeSessionId = id
  messagesEl.style.display = messagesDisplay
  messagesEl.toggleAttribute('aria-busy', loading)
  welcomeEl.style.display = welcomeDisplay
  if (showTranscript) {
    mountReactTranscript(id, messagesEl, { scroll: 'main' })
    syncTopModeButtons()
  }
  updateScrollToBottomBtn()
}
// Whether the composer's primary button is currently offering to continue.
// Tracked so the store subscription only touches the DOM when it FLIPS: the
// store fires on every streamed token, and re-running the whole button sync at
// that rate is pure waste.
let composerContinueOffered = false
let composerContinueSessionId: string | null = null
// Number of live-approval units per session in the stream store; a change means
// a card appeared or resolved, which moves that row in/out of the waiting state.
function liveApprovalCountSignature(state: { sessions: Record<string, { liveUnits: { type: string; req?: { requestId?: unknown } }[] }> }): string {
  const parts: string[] = []
  for (const [sessionId, stream] of Object.entries(state.sessions)) {
    const live = liveApprovalsOf(stream.liveUnits as unknown as Array<Record<string, unknown>>)
    if (live.length > 0) parts.push(`${sessionId}:${live.map(u => u.requestId).join(',')}`)
  }
  return parts.sort().join('|')
}

let previousApprovalSignature = ''

chatStreamStore.subscribe((state, previousState) => {
  reconcilePendingComposerSubmissions()
  syncComposerInferenceStatus()
  // Task events continue to update the agent cache, while every chat session's
  // own stream state independently drives its sidebar runtime state. This
  // subscription is global, so an off-screen session settles without waiting
  // to be opened.
  for (const change of sessionRunningChanges(previousState.sessions, state.sessions)) {
    if (state.sessions[change.sessionId]?.provisional || previousState.sessions[change.sessionId]?.provisional) continue
    setSessionRunning(change.sessionId, change.running)
    if (change.sessionId === sideSurfaceSessionId) (window as any).klausUpdateSideSendButton?.()
    // Session state is also a reconciliation trigger for the task source. A
    // detached agent keeps its own activity state while the parent row settles.
    void reconcileAgentTasksFromEngine(change.sessionId)
  }
  // A live approval card appearing or resolving changes the sidebar's waiting
  // state even when the turn keeps running (the row stays ranked waiting
  // while the request is parked).
  const approvalSignature = liveApprovalCountSignature(state)
  if (approvalSignature !== previousApprovalSignature) {
    previousApprovalSignature = approvalSignature
    renderSessionList()
  }
  const offered = composerContinueMode()
  if (window.currentSessionId === composerContinueSessionId && offered === composerContinueOffered) return
  updateSendBtn()
})

// A friend request arriving or being decided moves its conversation in and out
// of the sidebar waiting state, same as a parked approval card.
subscribeFriendInbox(() => { renderSessionList() })

// The main surface selects only its own stream. Cross-session lifecycle and
// sidebar reconciliation stay in the global subscription above.
function syncCurrentTranscriptChrome(
  state: { sessions: Record<string, unknown> },
  previousState: { sessions: Record<string, unknown> },
) {
  const id = window.currentSessionId
  if (id && state.sessions[id] !== previousState.sessions[id]) syncMainTranscriptChrome()
}
chatStreamStore.subscribe(syncCurrentTranscriptChrome)

async function submitTurnPayload(targetSessionId: string, payload: OutgoingPayload | FollowUpQueueItem, options: { quietError?: boolean; preserveDraft?: boolean; preserveQueueAnchor?: boolean; skipOptimistic?: boolean } = {}): Promise<string | null> {
  draftOnlySessionIds.delete(targetSessionId)
  userInterruptedSessions.delete(targetSessionId)
  // A re-insert position only means something for a message that goes back INTO the
  // queue. This call is the "it became a real turn" point, so any anchor an Edit
  // left behind is spent: keeping it would let the NEXT queued message land at that
  // old position. The queue path goes through `queueFollowUp`, not here, so this
  // cannot consume an anchor that was still meant to be used.
  if (!options.preserveQueueAnchor) takeEditedQueueReinsert(targetSessionId)
  if (!options.preserveDraft) {
    setDraft(targetSessionId, '')
    // 首条消息落地后运行环境锁定，草稿期的模式记录不再需要。
    forgetRunModeForDraft(targetSessionId)
  }
  // Optimistic user content and running state enter through the stream store;
  // its global subscription updates the current or off-screen sidebar row.
  // A worktree-mode first send painted its bubble ahead of the host-side
  // creation wait; painting it again here would duplicate the row.
  if (!options.skipOptimistic) renderLocalUserPayload(targetSessionId, payload)
  // 用户主动发送 = 明确想看最新内容：无论之前是否滚走看过历史，都把视口
  // 吸回底部并恢复粘底跟随。不恢复的话，上翻过历史的会话里发送后流式输出
  // 会在视口下方持续增长，最新内容被底部输入框区域遮住。
  scrollToBottom({ force: true })
  try {
    await klausApi.chat.send(
      targetSessionId,
      payload.finalText,
      payload.media.length > 0 ? payload.media : undefined,
      sentUserDisplayMetadata(payload),
    )
  } catch (err) {
    await reconcileSessionWorking(targetSessionId, false)
    const message = (err as Error | null)?.message || String(err)
    // quietError 供队列派发/Retry 用：失败由行进入 paused 等 Retry，
    // 不再另弹错误气泡；普通发送路径保留 live-error 气泡。
    if (!options.quietError) {
      ingestChatEvent({ type: 'api_error', sessionId: targetSessionId, error: message })
      if (window.currentSessionId === targetSessionId) inputEl.focus()
    }
    return message
  }
  // The turn is admitted: from here on, empty-shell recycling treats this
  // conversation as content-bearing even while the rollout flush lags.
  submittedTurnSessionIds.add(targetSessionId)
  return null
}

/** Rows of the host-owned queue for one session, or none when nothing is queued. */
function clientQueueFor(sessionId: string | null): ClientQueueRow[] {
  return clientQueueBySession.get(sessionId ?? '')?.rows || []
}

const engineQueueBySession = new Map<string, QueueSnapshotEvent>()

function applyEngineQueueSnapshot(sessionId: string, snapshot: QueueSnapshotEvent): void {
  const previous = engineQueueBySession.get(sessionId)
  if (previous && snapshot.revision < previous.revision) return
  engineQueueBySession.delete(sessionId)
  engineQueueBySession.set(sessionId, snapshot)
  while (engineQueueBySession.size > 64) engineQueueBySession.delete(engineQueueBySession.keys().next().value!)
  repaintQueueIslands(sessionId)
}

function clientQueueSnapshotFor(sessionId: string | null): ClientQueueSnapshot | null {
  return clientQueueBySession.get(sessionId ?? '') || null
}

function clientQueueMutationKey(sessionId: string, id: string) {
  return `${sessionId}\u0000${id}`
}

/**
 * Narrow a stored payload back to a `FollowUpQueueItem`.
 *
 * The host stores the renderer's own outgoing payload verbatim, but what comes
 * back over the wire is plain JSON, so this re-checks the fields a queue row
 * actually reads (text for the preview, media for the engine, attachments for the
 * bubble) instead of asserting the shape. A row that lost them renders nothing
 * useful and is dropped rather than drawn half-empty.
 */
function asQueuedItem(value: unknown): FollowUpQueueItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const displayText = typeof raw.displayText === 'string' ? raw.displayText : ''
  const finalText = typeof raw.finalText === 'string' ? raw.finalText : ''
  const media = Array.isArray(raw.media) ? raw.media : []
  const liveAttachments = Array.isArray(raw.liveAttachments) ? raw.liveAttachments : []
  // A row is sendable when it has words OR inline images: an image-only message
  // is a complete turn on its own (the host feeds `media` to the engine with an
  // empty text part), and `queuedRowContent` already knows how to describe it.
  // Requiring text here used to silently drop exactly that message — the queue
  // never showed it and the dispatch never drew its bubble.
  const hasInlineMedia = media.length > 0 || liveAttachments.some(entry => entry?.type === 'image')
  if (!displayText && !finalText && !hasInlineMedia) return null
  return {
    // The required fields below are validated first; everything else (attachments,
    // slash command, references) is passed through untouched, which is why this
    // goes via `unknown` rather than claiming the raw JSON already matches.
    ...(raw as unknown as FollowUpQueueItem),
    id: typeof raw.id === 'string' ? raw.id : '',
    displayText,
    finalText,
    media,
    liveAttachments,
  }
}

/**
 * Install one host snapshot as the renderer's whole view of that queue.
 *
 * A lower revision is rejected rather than merged: the host republishes after
 * every mutation, so an out-of-order push arriving late must not resurrect a row
 * the user already deleted or reorder one they already moved.
 */
function applyClientQueueSnapshot(sessionId: string, snapshot: { revision?: unknown; interrupted?: unknown; items?: unknown }, { replace = false } = {}): boolean {
  if (!sessionId || !snapshot || !Number.isFinite(Number(snapshot.revision)) || !Array.isArray(snapshot.items)) return false
  const previous = clientQueueBySession.get(sessionId)
  if (previous && Number(snapshot.revision) < previous.revision) return false
  const rows: ClientQueueRow[] = []
  for (const raw of snapshot.items as ClientQueueWireRow[]) {
    const id = typeof raw?.id === 'string' ? raw.id : ''
    const item = asQueuedItem(raw?.item)
    // A row without an identity or payload cannot be edited, reordered or sent,
    // so it is dropped instead of drawn as an unreadable entry.
    if (!id || !item) continue
    rows.push({
      id,
      pausedReason: typeof raw.pausedReason === 'string' && raw.pausedReason ? raw.pausedReason : null,
      dispatching: raw.dispatching === true,
      ...(raw.unconfirmed === true || item.followUpState === 'unconfirmed' ? { unconfirmed: true } : {}),
      createdAt: typeof raw.createdAt === 'number' && Number.isSafeInteger(raw.createdAt) ? raw.createdAt : 0,
      item,
    })
  }
  const normalized: ClientQueueSnapshot = {
    revision: Number(snapshot.revision),
    interrupted: snapshot.interrupted === true,
    rows,
  }
  // The entry is kept even when the queue drained to zero rows. Dropping it here
  // would throw away the revision with it, and the next out-of-order push would
  // then pass the staleness guard below and resurrect rows the user already
  // deleted or a dispatch already consumed.
  clientQueueBySession.set(sessionId, normalized)
  repaintQueueIslands(sessionId)
  return true
}

/**
 * Repaint whichever queue island is showing this conversation.
 *
 * Two islands read one cache, so a host push has to reach both possibilities: the
 * main island when the row belongs to the visible conversation, and the side island
 * when it belongs to the side chat that is currently open. Checking only the main
 * id is how a side chat's queue would silently freeze — its rows are stored and
 * dispatched by the host exactly like any other, so the missing repaint would look
 * like a queue that never drains.
 */
function repaintQueueIslands(sessionId: string | null) {
  if (sessionId && sessionId === window.currentSessionId) renderFollowUpQueue()
  if (sessionId && sideSurfaceSessionId === sessionId) renderSideFollowUpQueue()
}

/** Pull the host's queue for a session — on open, and after anything unexpected. */
async function refreshClientQueue(sessionId: string, { reset = false } = {}) {
  if (!sessionId) return
  const session = findKnownSession(sessionId)
  if (session?.archived) {
    clientQueueBySession.delete(sessionId)
    engineQueueBySession.delete(sessionId)
    forgetPendingQueueAdditionsForSession(sessionId)
    repaintQueueIslands(sessionId)
    return
  }
  if (reset) {
    clientQueueBySession.delete(sessionId)
    engineQueueBySession.delete(sessionId)
    repaintQueueIslands(sessionId)
  }
  try {
    const results = await Promise.allSettled([
      klausApi.chat.clientQueueSnapshot(sessionId), klausApi.chat.queueSnapshot(sessionId),
    ])
    const client = results[0], engine = results[1]
    if (client.status === 'fulfilled' && client.value?.ok && client.value.snapshot) {
      applyClientQueueSnapshot(sessionId, client.value.snapshot, { replace: true })
      await reconcilePendingQueueAdditions(sessionId)
    }
    if (engine.status === 'fulfilled' && engine.value?.snapshot) applyEngineQueueSnapshot(sessionId, { type: 'queue_snapshot', sessionId, ...engine.value.snapshot })
    for (const result of results) if (result.status === 'rejected') console.warn('[follow-up] queue refresh failed:', result.reason)
  } catch (error) {
    console.warn('[follow-up] failed to refresh the client queue:', error)
  }
}

function clientQueueMutationPending(sessionId: string, id: string | null): boolean {
  const prefix = `${sessionId}\u0000`
  return clientQueueMutationsInFlight.has(`${prefix}*`) || (id
    ? clientQueueMutationsInFlight.has(`${prefix}${id}`)
    : [...clientQueueMutationsInFlight].some(key => key.startsWith(prefix)))
}

/**
 * Run one host queue mutation, guarding a row against concurrent edits.
 *
 * The host answers every mutation with the authoritative snapshot, which is what
 * gets installed here — the renderer never computes the resulting order itself,
 * because a dispatch claiming the head row at the same moment would make a
 * locally predicted order wrong.
 */
async function runClientQueueMutation<T>(sessionId: string, id: string | null, mutate: () => Promise<T | undefined>, options: { silent?: boolean; refreshAfterFailure?: boolean } = {}): Promise<T | undefined> {
  if (!sessionId) return undefined
  const key = id ? clientQueueMutationKey(sessionId, id) : `${sessionId}\u0000*`
  if (clientQueueMutationPending(sessionId, id)) {
    if (!options.silent) showToast(tt('queue_mutation_running'))
    return undefined
  }
  clientQueueMutationsInFlight.add(key)
  repaintQueueIslands(sessionId)
  try {
    const result = await mutate()
    const reply = result as { ok?: boolean; error?: string; snapshot?: unknown } | undefined
    if (reply?.snapshot) applyClientQueueSnapshot(sessionId, reply.snapshot as { revision?: unknown; interrupted?: unknown; items?: unknown }, { replace: true })
    if (reply && reply.ok !== true && !options.silent) showToast(reply.error || tt('queue_mutation_failed').replace('{code}', tt('setup_status_unknown')))
    return result
  } catch (error) {
    if (!options.silent) showToast((error as Error | null)?.message || String(error))
    // The host may have applied the mutation before the transport failed, so the
    // cached snapshot is no longer trustworthy either way.
    if (options.refreshAfterFailure !== false) void refreshClientQueue(sessionId, { reset: true })
    return undefined
  } finally {
    clientQueueMutationsInFlight.delete(key)
    repaintQueueIslands(sessionId)
  }
}

/**
 * Where an edited queued message returns to, keyed by conversation: the id of the
 * row it must land before — the `nextMessageId` anchor.
 *
 * Edit takes the message out of the queue and puts it in the composer, so the row
 * that was behind it becomes the insertion anchor. Without remembering that, the
 * edited message would rejoin at the end and silently reorder the queue the user
 * arranged.
 *
 * Keyed by session rather than held in one variable because two composers can have
 * a queue open at once (the main one and a side chat's): a single slot would let an
 * edit in the side composer move a message the user queued in the main one.
 *
 * Re-checked when consumed, because the state goes stale in three ways the user can
 * reach: clearing the composer instead of resending, and the anchor row itself being
 * dispatched or deleted in the meantime. A stale anchor degrades to "append" rather
 * than inserting a message in the middle of an unrelated queue.
 */
interface QueueEditRecovery extends ReinsertAnchors {
  row?: ClientQueueRow
  removal?: RemovalRequest
  phase?: 'removing' | 'editing'
  draft?: ComposerDraft
  item?: FollowUpQueueItem
}

const editedQueueReinsertBySession = loadEditedQueueReinsert()
hydrateQueuedEditDrafts()

/** Rehydrate attachments as well as text; the ordinary draft store only owns text. */
function hydrateQueuedEditDrafts() {
  for (const [sessionId, edit] of editedQueueReinsertBySession) {
    if (edit.phase !== 'editing' || !edit.row) continue
    const draft = edit.draft || composerDraftFromDisplayMetadata(edit.row.item.displayMetadata ?? edit.row.item)
      || createComposerDraft(edit.row.item.displayText)
    edit.draft = draft
    sessionDrafts.set(sessionId, draft)
    sessionPendingFiles.set(sessionId, queuedPendingFiles(edit.item || edit.row.item, sessionId))
  }
}

function loadEditedQueueReinsert(): Map<string, QueueEditRecovery> {
  try {
    const entries = JSON.parse(localStorage.getItem('klaus_edited_queue_reinsert') || '[]')
    return new Map(Array.isArray(entries) ? entries.filter(([sessionId, edit]) => typeof sessionId === 'string'
      && asQueuedItem(edit?.row?.item) && edit.removal?.sessionId === sessionId && edit.removal?.id === edit.row.id
      && typeof edit.removal.clientMutationId === 'string' && typeof edit.removal.mutationFingerprint === 'string'
      && (edit.phase === 'removing' || edit.phase === 'editing')) : [])
  } catch { return new Map() }
}

function persistEditedQueueReinsert(): boolean {
  return persistLocalValue('klaus_edited_queue_reinsert', JSON.stringify([...editedQueueReinsertBySession]))
}

function persistQueuedEditDraft(sessionId: string | null, draft: ComposerDraft, files: PendingFileEntry[]) {
  const edit = sessionId ? editedQueueReinsertBySession.get(sessionId) : null
  if (!edit || edit.phase !== 'editing') return
  edit.draft = draft
  edit.item = { ...buildOutgoingPayload(draft.text, [...files], draft.slashCommand?.command || null, sessionId!,
    normalizeComposerReferences(draft.text, draft.references), draft.document), id: edit.row!.id } as FollowUpQueueItem
  persistEditedQueueReinsert()
}

function setEditedQueueReinsert(sessionId: string, edit: QueueEditRecovery) {
  const previous = editedQueueReinsertBySession.get(sessionId)
  editedQueueReinsertBySession.set(sessionId, edit)
  if (persistEditedQueueReinsert()) return true
  if (previous) editedQueueReinsertBySession.set(sessionId, previous)
  else editedQueueReinsertBySession.delete(sessionId)
  return false
}

function forgetEditedQueueReinsert(sessionId: string) {
  editedQueueReinsertBySession.delete(sessionId)
  persistEditedQueueReinsert()
}

/** A reload during removal restores by receipt instead of losing the queued input. */
async function reconcileQueuedEdit(sessionId: string) {
  const edit = editedQueueReinsertBySession.get(sessionId)
  if (!edit?.row || !edit.removal || edit.phase !== 'removing') return
  if (!persistEditedQueueReinsert()) return
  const removed = await runClientQueueMutation<{ ok?: boolean; removed?: ClientQueueRow }>(sessionId, edit.row.id,
    () => klausApi.chat.clientQueueRemove(sessionId, edit.row!.id, edit.removal!.expectedRevision, edit.removal!),
    { silent: true, refreshAfterFailure: false })
  if (editedQueueReinsertBySession.get(sessionId) !== edit || !removed) return
  if (!removed.ok || !removed.removed) { forgetEditedQueueReinsert(sessionId); return }
  const restored = await runClientQueueMutation<{ ok?: boolean }>(sessionId, edit.row.id,
    () => klausApi.chat.clientQueueRestore(sessionId, removed.removed, edit),
    { silent: true, refreshAfterFailure: false })
  if (restored?.ok && editedQueueReinsertBySession.get(sessionId) === edit) forgetEditedQueueReinsert(sessionId)
}

/**
 * The re-insertion anchors for a message an Edit put back into the composer.
 *
 * Both former neighbours are captured, not just the one behind it. While a message
 * sits in the composer being edited, the queue keeps moving — a dispatch can consume
 * the row that followed, a delete can remove the row that preceded. Holding only the
 * successor means that when it vanishes the position is unrecoverable and the edited
 * message lands at the end, reordering everything the user queued in between. With
 * both anchors the host can still place it correctly via whichever neighbour survives.
 */
interface ReinsertAnchors {
  afterId: string | null
  beforeId: string | null
}

/**
 * The anchors an edited message should re-insert at, or empty anchors to append.
 *
 * Consuming deletes the entry, so every path out of a submit clears the pending
 * position — including the ones that do not queue anything — or a later unrelated
 * message would inherit it. Stale anchors are pruned here rather than sent: an
 * anchor whose row is already gone is dropped so the host never resolves against a
 * phantom, and if both are gone the row simply appends.
 */
function takeEditedQueueReinsert(sessionId: string | null): ReinsertAnchors {
  const empty: ReinsertAnchors = { afterId: null, beforeId: null }
  if (!sessionId) return empty
  const pending = editedQueueReinsertBySession.get(sessionId)
  forgetEditedQueueReinsert(sessionId)
  if (!pending) return empty
  const live = new Set(clientQueueFor(sessionId).map(row => row.id))
  return {
    ...pending,
    afterId: pending.afterId && live.has(pending.afterId) ? pending.afterId : null,
    beforeId: pending.beforeId && live.has(pending.beforeId) ? pending.beforeId : null,
  }
}

/**
 * Both neighbours of a row, for re-inserting it later.
 *
 * Used by Edit (the message leaves the queue for the composer) and by Delete (the
 * row leaves until an undo puts it back). Both need the same pair, and both used to
 * capture only the successor — which silently lost the position whenever that row was
 * dispatched or deleted first. See `ReinsertAnchors` for why one anchor is not enough.
 */
function queueRowAnchors(sessionId: string, id: string): ReinsertAnchors {
  const rows = clientQueueFor(sessionId)
  const index = rows.findIndex(candidate => candidate.id === id)
  if (index < 0) return { afterId: null, beforeId: null }
  return {
    afterId: rows[index - 1]?.id ?? null,
    beforeId: rows[index + 1]?.id ?? null,
  }
}

/**
 * Queue a follow-up: the host stores it durably and dispatches it after the turn.
 *
 * `anchors` puts the row back where an edited message came from. Without them the
 * message would rejoin at the end, so editing the second of three queued messages
 * would silently reorder the other two — the queue the user arranged is not the
 * queue that runs.
 */
interface PendingQueueAddition {
  sessionId: string
  id: string
  item: FollowUpQueueItem
  anchors: ReinsertAnchors
  refused?: boolean
  transfer?: {
    sourceSessionId: string
    row: ClientQueueRow
    anchors: ReinsertAnchors
    removal: RemovalRequest
    phase: 'remove-source' | 'add-target' | 'restore-source'
  }
}

interface QueueAddOutcome {
  status: 'queued' | 'refused' | 'unconfirmed' | 'discarded'
  id: string
  item: FollowUpQueueItem
}

function loadPendingQueueAdditions(): Map<string, PendingQueueAddition> {
  const pending = new Map<string, PendingQueueAddition>()
  try {
    const stored = JSON.parse(localStorage.getItem('klaus_pending_queue_additions') || '[]')
    if (!Array.isArray(stored)) return pending
    for (const raw of stored) {
      const item = asQueuedItem(raw?.item)
      if (typeof raw?.sessionId !== 'string' || !raw.sessionId || typeof raw?.id !== 'string' || !raw.id || !item) continue
      const transfer = raw.transfer
      if (transfer && (typeof transfer.sourceSessionId !== 'string' || transfer.row?.id !== raw.id
        || !asQueuedItem(transfer.row?.item) || transfer.removal?.sessionId !== transfer.sourceSessionId
        || transfer.removal?.id !== raw.id || typeof transfer.removal?.clientMutationId !== 'string'
        || typeof transfer.removal?.mutationFingerprint !== 'string'
        || !['remove-source', 'add-target', 'restore-source'].includes(transfer.phase))) continue
      pending.set(clientQueueMutationKey(raw.sessionId, raw.id), { sessionId: raw.sessionId, id: raw.id, item,
        anchors: { afterId: typeof raw.anchors?.afterId === 'string' ? raw.anchors.afterId : null,
          beforeId: typeof raw.anchors?.beforeId === 'string' ? raw.anchors.beforeId : null },
        ...(raw.refused === true ? { refused: true } : {}), ...(transfer ? { transfer } : {}) })
    }
  } catch { /* A malformed recovery record must not prevent the composer loading. */ }
  return pending
}

function persistPendingQueueAdditions(): boolean {
  return persistLocalValue('klaus_pending_queue_additions', JSON.stringify([...pendingQueueAdditions.values()]))
}

function forgetPendingQueueAddition(sessionId: string, id: string) {
  pendingQueueAdditions.delete(clientQueueMutationKey(sessionId, id))
  persistPendingQueueAdditions()
}

function forgetPendingQueueAdditionsForSession(sessionId: string) {
  for (const [key, pending] of pendingQueueAdditions) if (pending.sessionId === sessionId || pending.transfer?.sourceSessionId === sessionId) pendingQueueAdditions.delete(key)
  persistPendingQueueAdditions()
}

/** Recover a confirmed admission refusal without replacing a newer composer draft. */
async function recoverRefusedQueueAddition(sessionId: string, outcome: Pick<QueueAddOutcome, 'id' | 'item'>, anchors: ReinsertAnchors) {
  const pending = pendingQueueAdditions.get(clientQueueMutationKey(sessionId, outcome.id))
  if (!pending) return
  pending.refused = true
  if (!persistPendingQueueAdditions()) return
  const restored = await runClientQueueMutation<{ ok?: boolean }>(sessionId, pending.id,
    () => klausApi.chat.clientQueueRestore(sessionId, { id: pending.id, item: pending.item,
      pausedReason: tt('follow_up_failed'), createdAt: Date.now() }, anchors, { requireRemovedReceipt: false }),
    { silent: true, refreshAfterFailure: false })
  if (restored?.ok) forgetPendingQueueAddition(sessionId, pending.id)
}

/** Preserve definitely refused input as paused recovery when its composer has moved on. */
async function retainRefusedFollowUp(sessionId: string, payload: OutgoingPayload | FollowUpQueueItem, anchors: ReinsertAnchors) {
  const id = followUpModeHelper.createId()
  const displayMetadata = sentUserDisplayMetadata(payload)
  const item: FollowUpQueueItem = JSON.parse(JSON.stringify({ ...payload, id, source: 'local', editing: false,
    ...(displayMetadata ? { displayMetadata } : {}) }))
  pendingQueueAdditions.set(clientQueueMutationKey(sessionId, id), { sessionId, id, item, anchors, refused: true })
  persistPendingQueueAdditions()
  await recoverRefusedQueueAddition(sessionId, { id, item }, anchors)
}

/** One bounded recovery pass after a successful snapshot, never a transport retry loop. */
async function reconcilePendingQueueAdditions(sessionId: string) {
  await reconcileQueuedEdit(sessionId)
  for (const pending of [...pendingQueueAdditions.values()]) {
    if (pending.sessionId !== sessionId && pending.transfer?.sourceSessionId !== sessionId) continue
    if (clientQueueMutationPending(pending.sessionId, pending.id)) continue
    if (pending.transfer) {
      await reconcileQueueTransfer(pending)
      continue
    }
    if (pending.refused) {
      await recoverRefusedQueueAddition(sessionId, pending, pending.anchors)
      continue
    }
    const reply = await runClientQueueMutation<{ ok?: boolean }>(sessionId, pending.id,
      () => klausApi.chat.clientQueueAdd(sessionId, pending.id, pending.item, pending.anchors),
      { silent: true, refreshAfterFailure: false })
    if (reply?.ok) forgetPendingQueueAddition(sessionId, pending.id)
    else if (reply) await recoverRefusedQueueAddition(sessionId, pending, pending.anchors)
  }
}

/** Resume only receipt-backed mutations. Recovery never starts a model turn. */
async function reconcileQueueTransfer(pending: PendingQueueAddition): Promise<boolean> {
  const transfer = pending.transfer
  if (!transfer) return false
  const key = clientQueueMutationKey(pending.sessionId, pending.id)
  const current = () => pendingQueueAdditions.get(key) === pending
  const result = await runClientQueueMutation<{ admitted: boolean }>(pending.sessionId, pending.id, async () => {
    // Persist before every destructive/replayed step, including a recovery pass.
    if (!current() || !persistPendingQueueAdditions()) return { admitted: false }
    if (transfer.phase === 'remove-source') {
      const removed = await runClientQueueMutation<{ ok?: boolean; removed?: ClientQueueRow }>(transfer.sourceSessionId, pending.id,
        () => klausApi.chat.clientQueueRemove(transfer.sourceSessionId, pending.id, transfer.removal.expectedRevision, transfer.removal),
        { silent: true, refreshAfterFailure: false })
      if (!current() || !removed) return { admitted: false }
      if (!removed.ok || !removed.removed) {
        forgetPendingQueueAddition(pending.sessionId, pending.id)
        return { admitted: false }
      }
      transfer.row = removed.removed
      transfer.phase = 'add-target'
      if (!persistPendingQueueAdditions()) return { admitted: false }
    }
    if (transfer.phase === 'add-target') {
      const added = await klausApi.chat.clientQueueAdd(pending.sessionId, pending.id, pending.item, pending.anchors)
      if (!current() || !added) return { admitted: false }
      if (added.snapshot) applyClientQueueSnapshot(pending.sessionId, added.snapshot)
      // An admission receipt remains authoritative after the target consumed the row.
      if (added.ok === true) {
        forgetPendingQueueAddition(pending.sessionId, pending.id)
        return { admitted: true }
      }
      transfer.phase = 'restore-source'
      if (!persistPendingQueueAdditions()) return { admitted: false }
    }
    // Only an explicit admission refusal reaches here. The host checks its
    // removal receipt before restoring the original row at the original anchors.
    const restored = await runClientQueueMutation<{ ok?: boolean }>(transfer.sourceSessionId, pending.id,
      () => klausApi.chat.clientQueueRestore(transfer.sourceSessionId, transfer.row, transfer.anchors),
      { silent: true, refreshAfterFailure: false })
    if (current() && restored?.ok) forgetPendingQueueAddition(pending.sessionId, pending.id)
    return { admitted: false }
  }, { refreshAfterFailure: false })
  return result?.admitted === true
}

async function queueFollowUp(targetSessionId: string, payload: OutgoingPayload | FollowUpQueueItem, anchors: ReinsertAnchors = { afterId: null, beforeId: null }): Promise<QueueAddOutcome> {
  const id = followUpModeHelper.createId()
  // The display metadata travels with the row so a dispatch that happens after a
  // reload — or from another window — can still draw the bubble correctly.
  const displayMetadata = sentUserDisplayMetadata(payload)
  const item: FollowUpQueueItem = JSON.parse(JSON.stringify({
    ...payload,
    id,
    source: 'local',
    editing: false,
    ...(displayMetadata ? { displayMetadata } : {}),
  }))
  const key = clientQueueMutationKey(targetSessionId, id)
  const pending: PendingQueueAddition = { sessionId: targetSessionId, id, item, anchors }
  pendingQueueAdditions.set(key, pending)
  if (!persistPendingQueueAdditions()) {
    pendingQueueAdditions.delete(key)
    return { status: 'refused', id, item }
  }
  const result = await runClientQueueMutation<{ ok?: boolean }>(targetSessionId, id, () => klausApi.chat.clientQueueAdd(targetSessionId, id, item, anchors))
  // Archive/delete cleanup consumes the record. A late refusal must not recreate
  // a row for a conversation the user has already removed.
  if (pendingQueueAdditions.get(key) !== pending) return { status: 'discarded', id, item }
  if (!result) return { status: 'unconfirmed', id, item }
  if (result.ok === true) forgetPendingQueueAddition(targetSessionId, id)
  else { pending.refused = true; persistPendingQueueAdditions() }
  return { status: result.ok === true ? 'queued' : 'refused', id, item }
}

/** Restore a removed row, which is what makes a delete undoable. */
async function restoreQueuedFollowUp(sessionId: string, row: unknown, anchors: ReinsertAnchors = { afterId: null, beforeId: null }) {
  return runClientQueueMutation<{ ok?: boolean }>(sessionId, null, () => klausApi.chat.clientQueueRestore(sessionId, row, anchors))
}

function queuedPendingFiles(item: OutgoingPayload | FollowUpQueueItem, sessionId: string): PendingFileEntry[] {
  const attachments: Array<{ path: string; name?: string; mimeType?: string }> = []
  const seen = new Set<string>()
  const add = (path: unknown, name?: string, mimeType?: string) => {
    if (typeof path !== 'string' || !path) return
    if (seen.has(path)) {
      const existing = attachments.find(attachment => attachment.path === path)
      if (existing && !existing.mimeType && mimeType) existing.mimeType = mimeType
      return
    }
    seen.add(path); attachments.push({ path, name, ...(mimeType ? { mimeType } : {}) })
  }
  for (const attachment of item.liveAttachments || []) add(attachment.path, attachment.name, attachment.mimeType)
  for (const raw of item.media || []) {
    const media = raw as { path?: unknown; name?: string; mimeType?: string }
    add(media?.path, media?.name, media?.mimeType)
  }
  // Older file descriptors had names but omitted paths. Recover only the final
  // generated block backed by those descriptors; ordinary request text is never
  // an attachment manifest.
  const legacyFiles = (item.liveAttachments || []).filter(attachment => attachment.type === 'file' && !attachment.path && attachment.name)
  const requestText = parseSelectedTextEnvelope(String(item.finalText || ''))?.message ?? String(item.finalText || '')
  const legacyBlock = legacyFiles.length > 0 ? /(?:^|\n\n)Attached:\n((?:- [^\n]+(?:\n|$))+)$/.exec(requestText) : null
  if (legacyBlock) {
    const paths = legacyBlock[1].trimEnd().split('\n').map(line => line.slice(2))
    if (paths.length === legacyFiles.length && paths.every((path, index) => /^(?:\/|[A-Za-z]:[\\/])/.test(path)
      && path.split(/[\\/]/).pop() === legacyFiles[index].name)) {
      paths.forEach((path, index) => add(path, legacyFiles[index].name))
    }
  }
  return pendingEntriesFromPrepare(attachments, path => window.klaus?.media?.url?.(path, sessionId) || '')
}

async function removeQueuedFollowUp(sessionId: string, id: string) {
  return runClientQueueMutation<{ ok?: boolean; removed?: { id: string; item: FollowUpQueueItem } }>(sessionId, id, () => klausApi.chat.clientQueueRemove(sessionId, id, clientQueueSnapshotFor(sessionId)?.revision))
}

async function reorderQueuedFollowUp(sessionId: string, id: string, beforeId: string | null) {
  await runClientQueueMutation(sessionId, id, () => klausApi.chat.clientQueueReorder(sessionId, id, beforeId, clientQueueSnapshotFor(sessionId)?.revision))
}

/** Deliver one queued row now — behind both the row's Steer and its Retry button. */
async function deliverQueuedFollowUp(sessionId: string, row: ClientQueueRow) {
  if (!sessionId || !row) return
  if (row.dispatching) {
    showToast(tt('queue_mutation_running'))
    return
  }
  if (row.unconfirmed || row.item.followUpState === 'unconfirmed') {
    showToast(tt('follow_up_delivery_unknown'))
    return
  }
  const expectedRevision = clientQueueSnapshotFor(sessionId)?.revision
  const requireExpectedTurn = runningSessions.has(sessionId)
  const expectedTurnId = requireExpectedTurn ? getSessionStream(sessionId).activeTurnId || undefined : undefined
  const result = await runClientQueueMutation<{ ok?: boolean; error?: string }>(sessionId, row.id,
    () => klausApi.chat.clientQueueDeliver(sessionId, row.id, { expectedRevision, expectedTurnId, requireExpectedTurn }))
  if (result && result.ok !== true) {
    // The host put the row back paused; make the reason visible rather than
    // leaving a row that silently failed to leave the queue.
    ingestChatEvent({ type: 'api_error', sessionId, error: result.error || tt('follow_up_failed') })
  }
}

/**
 * Clear the queue's interruption pause.
 *
 * `dispatch` defaults to true because the banner's Resume is the user asking the
 * queue to run again right now. The paused-queue dialog passes false: there the
 * user's own message is about to start a turn, and a dispatch started at the same
 * moment would collide with it — the queued rows then go out after that turn
 * instead, which is the order they were written in.
 */
async function resumeClientQueue(sessionId: string, dispatch = true) {
  return runClientQueueMutation<{ ok?: boolean }>(sessionId, null, () => klausApi.chat.clientQueueResume(sessionId, dispatch))
}

async function clearClientQueue(sessionId: string) {
  return runClientQueueMutation<{ ok?: boolean }>(sessionId, null, () => klausApi.chat.clientQueueClear(sessionId))
}

async function removeEngineFollowUp(sessionId: string, uuid: string): Promise<void> {
  const row = engineFollowUpRows(engineQueueBySession.get(sessionId)).find(item => item.id === uuid)
  if (!row?.removable) return
  const key = clientQueueMutationKey(sessionId, `engine:${uuid}`)
  if (clientQueueMutationPending(sessionId, `engine:${uuid}`)) return
  clientQueueMutationsInFlight.add(key)
  repaintQueueIslands(sessionId)
  try {
    const result = await klausApi.chat.removeQueued(sessionId, { uuid, mutationId: crypto.randomUUID() })
    if (result?.snapshot) applyEngineQueueSnapshot(sessionId, { type: 'queue_snapshot', sessionId, ...result.snapshot })
    if (!result?.ok) showToast(tt('queue_mutation_failed').replace('{code}', result?.code || tt('setup_status_unknown')))
  } catch (error) {
    showToast((error as Error)?.message || String(error))
    await refreshClientQueue(sessionId)
  } finally {
    clientQueueMutationsInFlight.delete(key)
    repaintQueueIslands(sessionId)
  }
}

async function steerFollowUp(targetSessionId: string, payload: OutgoingPayload | FollowUpQueueItem, options: { quietError?: boolean } = {}) {
  const result = await klausApi.chat.followUp?.(
    targetSessionId,
    payload.finalText,
    payload.media.length > 0 ? payload.media : undefined,
    sentUserDisplayMetadata(payload),
  )
  if (result?.removed) return true
  if (!result?.ok && !result?.unconfirmed) {
    if (!options.quietError) ingestChatEvent({ type: 'api_error', sessionId: targetSessionId, error: result?.error || 'Failed to send follow-up' })
    return false
  }
  // Issued input is consumed even when its ACK is uncertain; its keyed notice owns delivery status.
  renderLocalUserPayload(targetSessionId, payload, { uuid: result.messageId, steered: true })
  noteLocallySentSteer(targetSessionId, result.messageId)
  // steer 也是用户主动发送：把视口吸回底部并恢复粘底跟随。但要吸的是**这条消息所属
  // 会话**的面——侧聊的引导必须滚侧边面板；无条件滚主转录会把用户正在看的主会话
  // 拽到底部，同时侧边那条新消息留在视口外。
  if (isSideChatSession(targetSessionId)) {
    if (sideSurfaceSessionId === targetSessionId) sideSticker?.scrollToBottom({ force: true })
    return true
  }
  // Guarded by identity rather than scrolling unconditionally: a steer whose side
  // tab was closed mid-flight resolves here (its surface is gone, so it is no longer
  // a side chat), and yanking the main transcript for a message that belongs to a
  // closed conversation would be worse than not scrolling at all.
  if (targetSessionId === window.currentSessionId) scrollToBottom({ force: true })
  return true
}

// Delivery notices are projected by the stream store and keyed by the stable message ID.
function applyFollowUpDeliveryStatus(event: FollowUpStatusEvent) {
  if (!event?.messageId) return
  repaintQueueIslands(event.sessionId)
}

/**
 * Steers this renderer dispatched itself and whose sent bubble it already drew.
 *
 * The engine keeps an admitted steer in its queue until the running turn consumes
 * it, so between admission and consumption the engine-owned queue row and the
 * sent bubble show the SAME message. The row is read-only — the host already
 * admitted it — so it adds nothing the bubble does not say; drawing both is what
 * made a steered message appear twice on screen. The entry is forgotten when the
 * session's turn ends: a steer still queued at that point was never consumed, and
 * the queue bar is then the only surface offering recovery (banner plus Resume),
 * so it must come back.
 */
const locallySentSteerIdsBySession = new Map<string, Set<string>>()

function noteLocallySentSteer(sessionId: string, messageId: string | undefined): void {
  if (!sessionId || !messageId) return
  const ids = locallySentSteerIdsBySession.get(sessionId)
  if (ids) ids.add(messageId)
  else locallySentSteerIdsBySession.set(sessionId, new Set([messageId]))
  while (locallySentSteerIdsBySession.size > 64) locallySentSteerIdsBySession.delete(locallySentSteerIdsBySession.keys().next().value!)
}

function forgetLocallySentSteers(sessionId: string): void {
  locallySentSteerIdsBySession.delete(sessionId)
}

/** The hidden set only applies while the conversation runs; an idle queue is the recovery surface. */
function hiddenLocallySentSteers(sessionId: string | null): ReadonlySet<string> | undefined {
  if (!sessionId || !runningSessions.has(sessionId)) return undefined
  return locallySentSteerIdsBySession.get(sessionId)
}

/**
 * Draw the user bubble for a queued message the HOST dispatched.
 *
 * The renderer only renders its own optimistic bubble when it sends directly; a
 * queued message goes out after the turn ended, possibly after a reload or from
 * another window, so the host announces it and the bubble is built here from the
 * payload that was stored with the row.
 */
function applyQueuedFollowUpDispatched(event: QueuedFollowUpDispatchedEvent) {
  const sessionId = event?.sessionId
  const item = asQueuedItem(event?.item)
  if (!sessionId || !item) return
  renderLocalUserPayload(sessionId, item, { uuid: event.messageId })
  noteLocallySentSteer(sessionId, event.messageId)
  // Scroll the surface that owns this conversation: a side chat's dispatched row
  // must pull the SIDE panel down, and must never yank the main transcript.
  if (isSideChatSession(sessionId)) {
    if (sideSurfaceSessionId === sessionId) sideSticker?.scrollToBottom({ force: true })
    return
  }
  if (sessionId === window.currentSessionId) scrollToBottom({ force: true })
}

/**
 * Paint one queue island from the host's cached rows for a session.
 *
 * Shared by the main and side composers because the queue is host-owned and keyed
 * by session: both islands read the SAME cache, so a row dispatched or paused by
 * the host shows up in whichever composer is looking at that conversation. Only the
 * session they are bound to differs.
 */
function renderQueueInto(api: FollowUpQueueApi | null, sessionId: string | null) {
  if (!api) return
  const snapshot = clientQueueSnapshotFor(sessionId)
  const rows = clientQueueFor(sessionId)
  // 行无来源标题，只有单行文本 + 动作；打断暂停时头部出横幅 + Resume。
  // 可拖拽（≥2 条）由组件自己按行数判定，宿主不再替它算。
  // 已画过发送气泡的自有 steer 在运行期不重复成行：引擎队列里它从被接受到被
  // 回合消费之间一直占一行，而气泡已经说了同一句话。
  const engineRows = sessionId ? engineFollowUpRows(engineQueueBySession.get(sessionId), hiddenLocallySentSteers(sessionId)) : []
  const banner = engineRows.length > 0 && !runningSessions.has(sessionId) ? tt('follow_up_engine_pending_header')
    : snapshot?.interrupted && rows.length > 0 ? tt('follow_up_interrupted_header') : null
  api.render([...engineRows.map(row => ({ id: `engine:${row.id}`, readOnly: true, removable: row.removable, mutationPending: clientQueueMutationPending(sessionId || '', `engine:${row.id}`), paused: false,
    pausedTitle: '', pausedDetail: '', dispatching: row.reserved, preview: row.text,
    // A quote-only engine row has no request text of its own; count its selections
    // with the same label a client row uses, instead of rendering nothing.
    summary: row.summaryOnly ? ttCount('follow_up_summary_selections', row.selectionCount || 0) : '',
    summaryOnly: !!row.summaryOnly, thumbnail: null })), ...rows.map((row) => {
    const mutationPending = clientQueueMutationPending(sessionId || '', row.id)
    // The host only sends `pausedReason` for a genuine delivery failure — a row
    // paused by the user's interruption arrives without it, because retrying an
    // interruption is meaningless and the banner above already says what happened.
    const paused = !!row.pausedReason
    const content = queuedRowContent(row.item, {
      previewOf: pastedTextPreview,
      resolveMediaUrl: path => window.klaus?.media?.url?.(path, sessionId || undefined) || '',
    })
    return {
      id: row.id,
      mutationPending,
      paused,
      // Two lines rather than one run-on sentence: what went wrong, then what the
      // user can do about it. The engine's own refusal text is the useful part, so
      // it goes in the first line when there is one.
      pausedTitle: paused ? (row.pausedReason || tt('follow_up_paused')) : '',
      pausedDetail: paused ? tt('follow_up_paused_hint') : '',
      dispatching: row.dispatching,
      unconfirmed: row.unconfirmed || row.item.followUpState === 'unconfirmed',
      preview: content.text,
      fullText: typeof row.item.displayText === 'string' ? row.item.displayText : content.text,
      composerReferences: queuedComposerReferences(row.item, content.text),
      summary: content.summary,
      summaryOnly: content.summaryOnly,
      thumbnail: content.thumbnail,
    }
  })], banner, followUpQueueMode === 'queue', sessionId || '')
}

function renderFollowUpQueue() {
  renderMainFollowUpQueue()
  // Called from generic points — a session switch, a follow-up-mode change, a
  // mutation settling — so it repaints both islands. Doing only the main one would
  // leave a side chat's queue showing a stale mode label or a stale row set.
  renderSideFollowUpQueue()
}

function renderMainFollowUpQueue() {
  if (!followUpQueueApi) return
  if (findKnownSession(window.currentSessionId)?.archived) {
    followUpQueueApi.render(null, null, followUpQueueMode === 'queue')
    return
  }
  renderQueueInto(followUpQueueApi, window.currentSessionId)
}

/**
 * Paint the side composer's queue from the side chat it is bound to.
 *
 * An archived or absent side conversation hides the island entirely rather than
 * showing the previous side chat's rows: the side composer is reused across tabs,
 * so a stale queue there would offer to send another conversation's messages.
 */
function renderSideFollowUpQueue() {
  if (!sideFollowUpQueueApi) return
  const sideId = sideSurfaceSessionId
  if (!sideId || findKnownSession(sideId)?.archived) {
    sideFollowUpQueueApi.render(null, null, followUpQueueMode === 'queue')
    return
  }
  renderQueueInto(sideFollowUpQueueApi, sideId)
}

/**
 * The composer an Edit puts a queued message back into.
 *
 * Two composers can own a queue — the main one and a side chat's — and they are
 * separate DOM with separate state, and genuinely not equivalent: the side composer
 * has no pasted-text chip, only a selected-text one. So the surface owns the whole
 * "put this message back for editing" decision rather than being handed a text
 * string and a card list it may not be able to represent.
 *
 * Edit is the only row action that reaches into a composer, which is why this is the
 * entire seam between the shared queue logic and the composer beside it. Everything
 * else is keyed by session id and needs no surface.
 */
interface QueueComposerSurface {
  capture?(): { restore(): void; isCurrent(): boolean }
  /** Restore a queued message into the composer, losing nothing it cannot chip. */
  restoreForEdit(item: FollowUpQueueItem): void
  /** Post-edit housekeeping: resize, button state, close menus, focus. */
  settle(): void
  persistEdit?(): void
}

/**
 * Build the row handlers for one queue island.
 *
 * Parameterized rather than closed over `window.currentSessionId` because the side
 * composer's queue belongs to `sideSurfaceSessionId`, not the main conversation:
 * a side chat is its own session with its own queue, and reading the main id there
 * would let a side-chat row act on the main conversation's queue.
 *
 * `resolveSessionId` is a function, not a value, for the same reason the old
 * delegated handlers read the id at call time: one mount must stay correct as the
 * user switches conversations or side tabs without remounting.
 */
function buildFollowUpQueueHandlers(
  resolveSessionId: () => string | null,
  surface: QueueComposerSurface,
  options: { offerSideChat?: boolean } = {},
): FollowUpQueueHandlers {
  return {
    onResume: () => {
      const sessionId = resolveSessionId()
      if (!sessionId) return
      // The host coordinates accepted engine input with the interrupted client
      // queue, so one action resumes both without racing two turn starts.
      void resumeClientQueue(sessionId)
    },
    onDeliver: (id) => {
      const sessionId = resolveSessionId()
      if (!sessionId) return
      const entry = clientQueueFor(sessionId).find(candidate => candidate.id === id)
      if (!entry) return
      void deliverQueuedFollowUp(sessionId, entry)
    },
    onEdit: async (id) => {
      const sessionId = resolveSessionId()
      if (!sessionId) return
      const entry = clientQueueFor(sessionId).find(candidate => candidate.id === id)
      if (!entry) return
      if (entry.dispatching) {
        // The host has already handed this row to the engine; mutating it now would
        // either be refused or would lose the message that is being sent.
        showToast(tt('queue_reserved'))
        return
      }
      // Edit 把消息取回输入框，编辑后由用户重发重新入队。
      // Capture BOTH neighbours before removing the row: the successor says where to
      // land, and the predecessor is the fallback when the successor is dispatched or
      // deleted while the user is still editing.
      const restoreDraft = surface.capture?.()
      const anchors: QueueEditRecovery = { ...queueRowAnchors(sessionId, id), row: JSON.parse(JSON.stringify(entry)),
        removal: await createQueueRemovalRequest({ sessionId, id, expectedRevision: clientQueueSnapshotFor(sessionId)?.revision }),
        phase: 'removing' }
      if (!setEditedQueueReinsert(sessionId, anchors)) return
      const removed = await runClientQueueMutation<{ ok?: boolean; removed?: ClientQueueRow }>(sessionId, id,
        () => klausApi.chat.clientQueueRemove(sessionId, id, anchors.removal!.expectedRevision, anchors.removal!),
        { refreshAfterFailure: false })
      if (!removed) return
      if (!removed.ok || !removed.removed) { forgetEditedQueueReinsert(sessionId); return }
      if (resolveSessionId() !== sessionId || restoreDraft?.isCurrent() === false) {
        const restored = await restoreQueuedFollowUp(sessionId, removed.removed, anchors)
        if (restored?.ok) forgetEditedQueueReinsert(sessionId)
        return
      }
      anchors.row = removed.removed
      anchors.phase = 'editing'
      if (!persistEditedQueueReinsert()) { anchors.phase = 'removing'; return }
      surface.restoreForEdit(removed.removed.item)
      surface.persistEdit?.()
      surface.settle()
      showToast(`${tt('follow_up_edited_toast')} · ${tt('follow_up_deleted_undo')}`, {
        onClick: () => {
          if (editedQueueReinsertBySession.get(sessionId) !== anchors || resolveSessionId() !== sessionId) return
          anchors.phase = 'removing'
          if (!persistEditedQueueReinsert()) { anchors.phase = 'editing'; return }
          restoreDraft?.restore(); surface.settle()
          void restoreQueuedFollowUp(sessionId, removed.removed, anchors).then(restored => {
            if (restored?.ok && editedQueueReinsertBySession.get(sessionId) === anchors) forgetEditedQueueReinsert(sessionId)
          })
        }, duration: 6000,
      })
    },
    onDelete: async (id) => {
      const sessionId = resolveSessionId()
      if (!sessionId) return
      if (id.startsWith('engine:')) {
        await removeEngineFollowUp(sessionId, id.slice('engine:'.length))
        return
      }
      const entry = clientQueueFor(sessionId).find(candidate => candidate.id === id)
      if (!entry) return
      if (entry.dispatching) {
        showToast(tt('queue_reserved'))
        return
      }
      // Remember BOTH neighbours BEFORE removing, so undo puts the row back exactly
      // where it was rather than at the end — even if one neighbour has since been
      // dispatched or deleted.
      const anchors = queueRowAnchors(sessionId, id)
      const removed = await removeQueuedFollowUp(sessionId, id)
      if (!removed?.ok || !removed.removed) return
      // A delete is undoable from its toast. The row object the host
      // returned carries everything restore needs, so an undo reconstructs the same
      // row rather than a blank one.
      const row = removed.removed
      showToast(`${tt('follow_up_deleted_toast')} · ${tt('follow_up_deleted_undo')}`, {
        onClick: () => { void restoreQueuedFollowUp(sessionId, row, anchors) },
        duration: 6000,
      })
    },
    onReorder: async (id, beforeId) => {
      const sessionId = resolveSessionId()
      if (!sessionId) return
      // `beforeId === null` is a drop past the last row: the host appends the row
      // to the end, and there is no target row to look up or reserve.
      if (beforeId !== null) {
        const over = clientQueueFor(sessionId).find(candidate => candidate.id === beforeId)
        if (!over) return
        if (over.dispatching) {
          showToast(tt('queue_reserved'))
          return
        }
      }
      // `beforeId` semantics: the dragged row lands immediately before that row,
      // or at the end when it is null, which is what the host's reorder expects.
      await reorderQueuedFollowUp(sessionId, id, beforeId)
    },
    ...(options.offerSideChat === false ? {} : {
      onOpenInSideChat: async (id: string) => {
        const sessionId = resolveSessionId()
        if (!sessionId) return
        const entry = clientQueueFor(sessionId).find(candidate => candidate.id === id)
        if (!entry || entry.dispatching || entry.unconfirmed || entry.item.followUpState === 'unconfirmed'
          || clientQueueMutationPending(sessionId, id)
          || [...pendingQueueAdditions.values()].some(pending => pending.transfer?.sourceSessionId === sessionId && pending.id === id)) return
        const anchors = queueRowAnchors(sessionId, id)
        let target: string | null = null
        try {
          target = await window.KlausSideTasks?.createForQueued?.(sessionId)
          if (!target) return
          const removal = await createQueueRemovalRequest({ sessionId, id, expectedRevision: clientQueueSnapshotFor(sessionId)?.revision })
          const pending: PendingQueueAddition = { sessionId: target, id, item: JSON.parse(JSON.stringify(entry.item)),
            anchors: { afterId: null, beforeId: null },
            transfer: { sourceSessionId: sessionId, row: JSON.parse(JSON.stringify(entry)), anchors, removal, phase: 'remove-source' } }
          const key = clientQueueMutationKey(target, id)
          pendingQueueAdditions.set(key, pending)
          if (!persistPendingQueueAdditions()) { pendingQueueAdditions.delete(key); return }
          if (!await reconcileQueueTransfer(pending)) return
          // The initial gesture may deliver a still-queued target. A consumed
          // receipt and every reload recovery pass stop after admission.
          if (!clientQueueFor(target).some(row => row.id === id)) return
          const delivered = await klausApi.chat.clientQueueDeliver(target, id, { expectedRevision: clientQueueSnapshotFor(target)?.revision })
          if (delivered?.snapshot) applyClientQueueSnapshot(target, delivered.snapshot)
          if (delivered?.ok !== true) throw new Error(delivered?.error || tt('follow_up_failed'))
        } catch (error) {
          showToast((error as Error)?.message || String(error))
        } finally {
          if (target) await refreshClientQueue(target)
        }
      },
    }),
    onToggleQueueing: async () => {
      const next = followUpModeHelper.resolveSubmitAction(followUpQueueMode, true)
      // Same persistence path as the settings page: write the preference, then let
      // the mode-changed listener repaint every consumer of it.
      const saved = await klausApi.settings?.kv?.set(followUpModeHelper.FOLLOW_UP_QUEUE_MODE_KEY, next)
      if (saved === false) {
        showToast(tt('follow_up_mode_save_failed'))
        return
      }
      followUpQueueMode = next
      window.dispatchEvent(new CustomEvent('klaus-follow-up-mode-changed', { detail: { mode: next } }))
    },
  }
}

// follow-up 队列的 React 挂载：行结构与行上的事件都在组件里，这里只提供动作。
//
// 交互不再走容器委托。原先点击与拖拽都挂在 followUpQueueEl 上按 data-attribute
// 反查，于是组件加一个按钮就得同步改委托 switch；现在组件把用户意图直接回调出来，
// 宿主侧只负责「这个意图要对当前会话做什么」。
const mainFollowUpQueueHandlers = buildFollowUpQueueHandlers(
  () => window.currentSessionId,
  {
    capture: () => {
      const sessionId = window.currentSessionId, draft = composedInputDraft(), files = [...pendingFiles], deferred = pendingSendAfterUpload
      return {
        isCurrent: () => window.currentSessionId === sessionId && JSON.stringify(composedInputDraft()) === JSON.stringify(draft)
          && pendingFiles.length === files.length && files.every((file, index) => pendingFiles[index] === file)
          && pendingSendAfterUpload === deferred,
        restore: () => { setComposerText(draft); pendingFiles = files; renderPreviews() },
      }
    },
    restoreForEdit: item => {
      // The main composer has chips for both card kinds, so the stored display text
      // plus the cards themselves round-trip without loss.
      pendingSendAfterUpload = null
      pendingFiles = queuedPendingFiles(item, window.currentSessionId || '')
      const hasDisplayCards = !!(item.selectedTextAttachments?.length || item.pastedCards?.length)
      const restoredDraft = composerDraftFromDisplayMetadata(item.displayMetadata ?? item)
      const restoredText = hasDisplayCards ? (item.displayText || '')
        : restoredDraft ? restoredDraft.text : item.displayText
      setComposerText(restoredDraft ? { ...restoredDraft, text: restoredText } : restoredText)
      restoreDisplayCardsToComposer(item.selectedTextAttachments, item.pastedCards)
      renderPreviews()
    },
    settle: () => {
      autoResize(); updateSendBtn(); hideSlashMenu(); hideComposerPlusMenu()
      inputEl.focus()
    },
    persistEdit: () => persistQueuedEditDraft(window.currentSessionId, composedInputDraft(), pendingFiles),
  },
)
const followUpQueueApi = mountFollowUpQueue(followUpQueueEl, mainFollowUpQueueHandlers)

async function submitRunningFollowUp({ invert = false } = {}) {
  const draft = composedInputDraft()
  const text = draft.text
  updateInlineQuoteOffsets(text)
  const sentSlashCommand = selectedSlashCommand
  if (!text.trim() && pendingFiles.length === 0) return
  // Defence in depth: send() parks the submit before routing here, so this is
  // unreachable in practice. Kept so a future direct caller cannot reintroduce
  // a send that drops its attachments.
  if (hasUploadInFlight(pendingFiles)) return
  const targetSessionId = window.currentSessionId || await ensureSession()
  if (!targetSessionId) return
  addSessionHistory(targetSessionId, draft)
  resetHistoryBrowsing()
  const payload = buildOutgoingPayload(text, [...pendingFiles], sentSlashCommand, targetSessionId, normalizeComposerReferences(draft.text, draft.references), draft.document)
  const action = text.trimStart().startsWith('/')
    ? 'queue'
    : followUpModeHelper.resolveSubmitAction(followUpQueueMode, invert)

  clearComposerAfterSubmit(targetSessionId)
  updateSendBtn()
  const clearedDraft = JSON.stringify(composedInputDraft()), clearedFiles = [...pendingFiles], clearedDeferred = pendingSendAfterUpload
  // Taken once here so every path out of this submit consumes it: a steer does not
  // become a queue row, and leaving the anchor behind would apply it to whatever
  // unrelated message the user queues later.
  const reinsertAnchors = takeEditedQueueReinsert(targetSessionId)
  if (action === 'steer') {
    const accepted = await steerFollowUp(targetSessionId, payload)
    if (!accepted) {
      // A definitive refusal retains the original request without replacing newer input.
      if (window.currentSessionId === targetSessionId && JSON.stringify(composedInputDraft()) === clearedDraft
        && pendingFiles.length === clearedFiles.length && clearedFiles.every((file, index) => pendingFiles[index] === file)
        && pendingSendAfterUpload === clearedDeferred) {
        pendingFiles = queuedPendingFiles(payload, targetSessionId)
        setComposerText(draft)
        restoreDisplayCardsToComposer(payload.selectedTextAttachments, payload.pastedCards)
        renderPreviews()
        autoResize(); updateSendBtn()
        if (reinsertAnchors) setEditedQueueReinsert(targetSessionId, reinsertAnchors)
      } else {
        await retainRefusedFollowUp(targetSessionId, payload, reinsertAnchors)
      }
    }
  } else {
    const queued = await queueFollowUp(targetSessionId, payload, reinsertAnchors)
    if (queued.status === 'refused') {
      // An uncertain admission still belongs to its original durable identity.
      // Only a refusal may restore a draft, and only while that composer is empty.
      if (window.currentSessionId === targetSessionId && JSON.stringify(composedInputDraft()) === clearedDraft
        && pendingFiles.length === clearedFiles.length && clearedFiles.every((file, index) => pendingFiles[index] === file)
        && pendingSendAfterUpload === clearedDeferred) {
        pendingFiles = queuedPendingFiles(payload, targetSessionId)
        setComposerText(draft)
        restoreDisplayCardsToComposer(payload.selectedTextAttachments, payload.pastedCards)
        renderPreviews()
        autoResize(); updateSendBtn()
        if (reinsertAnchors) setEditedQueueReinsert(targetSessionId, reinsertAnchors)
        forgetPendingQueueAddition(targetSessionId, queued.id)
      } else {
        await recoverRefusedQueueAddition(targetSessionId, queued, reinsertAnchors)
      }
      showToast(tt('follow_up_failed'))
    }
  }
  inputEl.focus()
}

function reconcilePendingComposerSubmissions(): void {
  for (const pending of pendingComposerSubmissions.values()) {
    if (pending.phase !== 'unconfirmed' || !pending.sessionId) continue
    const stream = getSessionStream(pending.sessionId)
    const echoed = stream.liveUnits.find(unit => unit.type === 'live-user' && unit.msg.uuid === pending.uuid && unit.turnId)
    const saved = stream.history?.find(message => message.role === 'user' && message.uuid === pending.uuid)
    if (!echoed && !saved) continue
    const turnId = echoed?.turnId || saved?.turnId
    acceptPendingComposerSubmission(pending)
    discardPendingUserTurn(pending.sessionId, pending.uuid)
    if (turnId) chatStreamStore.setState(state => ({ sessions: { ...state.sessions,
      [pending.sessionId!]: { ...state.sessions[pending.sessionId!], turnWorkStartedAtMs: {
        ...state.sessions[pending.sessionId!].turnWorkStartedAtMs, [turnId]: pending.startedAtMs,
      } },
    } }))
  }
}

function currentPendingComposerSubmission(): PendingComposerSubmission | undefined {
  return [...pendingComposerSubmissions.values()].find(pending =>
    pending.phase !== 'accepted' && pending.phase !== 'failed' && pending.phase !== 'unconfirmed' && pending.phase !== 'cancelled'
    && (pending.sessionId ? pending.sessionId === window.currentSessionId
      : window.currentSessionId === null && visiblePendingSubmissionId === pending.id))
}

function beginPendingComposerSubmission(draft: ComposerDraft, files: PendingFileEntry[], slashCommand: SlashCommandInfo | null, navigationToken: string): PendingComposerSubmission {
  const sourceSessionId = window.currentSessionId
  const id = crypto.randomUUID(), uuid = `submission:${id}`
  const startedAtMs = Date.now()
  const payload = buildOutgoingPayload(draft.text, files, slashCommand, sourceSessionId || '', normalizeComposerReferences(draft.text, draft.references), draft.document, false)
  const pending: PendingComposerSubmission = {
    id, uuid, sourceSessionId, sessionId: sourceSessionId, viewId: sourceSessionId || `pending:${id}`,
    navigationToken, draft, files, payload, startedAtMs,
    workdir: sourceSessionId ? sessionWorkdir(sourceSessionId) || null : draftProjectWorkdir(),
    workspaceId: sourceSessionId ? findKnownSession(sourceSessionId)?.workspaceId || null : pendingNewChatWorkspaceId,
    projectRoot: sourceSessionId ? findKnownSession(sourceSessionId)?.projectRoot || null : pendingNewChatProjectRoot,
    phase: 'preparing', cancelled: false,
  }
  pendingComposerSubmissions.set(id, pending)
  if (!sourceSessionId) visiblePendingSubmissionId = id
  syncComposerContextRowVisibility()
  clearComposerAfterSubmit(sourceSessionId || '')
  if (!sourceSessionId) setWelcomeDraft('')
  beginPendingUserTurn(pending.viewId, {
    text: payload.finalText, uuid, timestamp: startedAtMs, attachments: payload.liveAttachments,
    slashCommand: payload.sentSlashCommand, displayText: payload.displayText,
    composerReferences: payload.composerReferences, composerDocument: payload.composerDocument,
    pastedCards: payload.pastedCards, selectedTextAttachments: payload.selectedTextAttachments,
  }, { provisional: !sourceSessionId })
  busy = true
  btnSend.classList.add('busy')
  resumeMessagesBottomFollowing()
  mountReactTranscript(pending.viewId, messagesEl, { scroll: 'main', readOnly: !sourceSessionId })
  welcomeEl.style.display = 'none'
  messagesEl.style.display = 'block'
  syncTopModeButtons()
  updateScrollToBottomBtn()
  renderSessionList()
  updateSendBtn()
  scrollToBottom({ force: true })
  return pending
}

function promotePendingComposerSubmission(pending: PendingComposerSubmission, sessionId: string): void {
  if (pending.sessionId === sessionId) return
  const visible = currentPendingComposerSubmission() === pending
  flushSync(() => {
    movePendingUserTurn(pending.viewId, sessionId, pending.uuid)
    pending.sessionId = sessionId
    pending.viewId = sessionId
    // Rebind the mounted view in the same commit that removes its provisional source.
    if (visible) mountReactTranscript(sessionId, messagesEl, { scroll: 'main' })
  })
}

function acceptPendingComposerSubmission(pending: PendingComposerSubmission): void {
  pending.phase = 'accepted'
  clearPendingSubmissionRecovery(pending.uuid)
  if (pending.sessionId) clearUnsentSubmission(pending.sessionId)
  finishPendingUserTurn(pending.viewId, pending.uuid, 'accepted')
  pendingComposerSubmissions.delete(pending.id)
  if (visiblePendingSubmissionId === pending.id) visiblePendingSubmissionId = null
  if (pending.cancelled && pending.sessionId) requestTurnStop(pending.sessionId)
}

function settlePendingComposerSubmission(pending: PendingComposerSubmission): void {
  if (pending.phase === 'accepted' || !pendingComposerSubmissions.has(pending.id)) return
  const owner = pending.sessionId || pending.sourceSessionId
  const visible = owner ? window.currentSessionId === owner
    : window.currentSessionId === null && visiblePendingSubmissionId === pending.id
  const currentDraft = visible ? composedInputDraft() : owner ? normalizeComposerDraft(sessionDrafts.get(owner)) : getWelcomeDraft()
  const currentFiles = visible ? pendingFiles : sessionPendingFiles.get(owner) || []
  const explicitFailure = pending.phase === 'failed' || pending.phase === 'unconfirmed'
  // Once the conversation entity exists, an aborted or failed submit never
  // writes its snapshot back into a composer draft: the unsent message stays
  // with its conversation as a retryable error state instead.
  const entityOwned = pending.sessionId != null
  const restore = !explicitFailure && !entityOwned && canRestorePendingDraft(currentDraft, currentFiles)
  if (restore) {
    if (owner) setDraft(owner, pending.draft)
    else setWelcomeDraft(pending.draft)
    sessionPendingFiles.set(owner, pending.files)
    if (visible) {
      setComposerText(pending.draft)
      pendingFiles = pending.files
      renderPreviews()
      renderSelectedSlashCommand()
      autoResize()
    }
  }
  const retryable = entityOwned && pending.phase !== 'unconfirmed'
  if (retryable) {
    recordUnsentSubmission({
      sessionId: pending.sessionId!, uuid: pending.uuid, draft: pending.draft, files: pending.files,
      payload: pending.payload, error: pending.error, atMs: Date.now(),
    })
  }
  const retainFailure = retryable || (!restore && pending.phase !== 'cancelled')
  if (retainFailure) setPendingSubmissionRecovery(pending.uuid, retryable ? {
    action: 'retry',
    run: () => { retryUnsentSubmission(pending.sessionId!, pending.uuid) },
  } : {
    action: pending.phase === 'unconfirmed' ? 'dismiss' : 'back',
    run: () => {
      clearPendingSubmissionRecovery(pending.uuid)
      discardPendingUserTurn(pending.viewId, pending.uuid)
      pending.phase = 'cancelled'
      settlePendingComposerSubmission(pending)
    },
  })
  finishPendingUserTurn(pending.viewId, pending.uuid, retainFailure ? 'failed' : 'cancelled',
    retainFailure ? pending.error || tt('message_prepare_failed') : undefined)
  if (retainFailure) {
    if (pending.phase !== 'unconfirmed') pending.phase = 'failed'
  } else {
    clearPendingSubmissionRecovery(pending.uuid)
    pendingComposerSubmissions.delete(pending.id)
    if (visiblePendingSubmissionId === pending.id) {
      visiblePendingSubmissionId = null
      if (!window.currentSessionId) {
        unmountReactTranscript(messagesEl)
        messagesEl.style.display = 'none'
        welcomeEl.style.display = 'flex'
        syncTopModeButtons()
      }
    }
  }
  syncBusyForCurrentSession()
  syncMainTranscriptChrome()
  renderSessionList()
}

function unsentTurnPayload(record: UnsentSubmissionRecord) {
  return {
    text: record.payload.finalText, uuid: record.uuid, timestamp: record.atMs,
    attachments: record.payload.liveAttachments, slashCommand: record.payload.sentSlashCommand,
    displayText: record.payload.displayText, composerReferences: record.payload.composerReferences,
    composerDocument: record.payload.composerDocument, pastedCards: record.payload.pastedCards,
    selectedTextAttachments: record.payload.selectedTextAttachments,
  }
}

function retryUnsentSubmission(sessionId: string, uuid: string) {
  const record = unsentSubmissionFor(sessionId)
  if (!record || record.uuid !== uuid) return
  clearPendingSubmissionRecovery(uuid)
  discardPendingUserTurn(sessionId, uuid)
  void (async () => {
    const error = await submitTurnPayload(sessionId, record.payload, { quietError: true })
    if (error) {
      recordUnsentSubmission({ ...record, error, atMs: Date.now() })
      beginPendingUserTurn(sessionId, unsentTurnPayload({ ...record, atMs: Date.now() }))
      finishPendingUserTurn(sessionId, uuid, 'failed', error)
      setPendingSubmissionRecovery(uuid, { action: 'retry', run: () => retryUnsentSubmission(sessionId, uuid) })
    } else {
      clearUnsentSubmission(sessionId)
    }
    syncBusyForCurrentSession()
    syncMainTranscriptChrome()
    renderSessionList()
  })()
}

/** A reload must bring back the retryable failure state of an unsent submit. */
function resurfaceUnsentSubmission(sessionId: string) {
  const record = unsentSubmissionFor(sessionId)
  if (!record || pendingSubmissionRecovery(record.uuid)) return
  beginPendingUserTurn(sessionId, unsentTurnPayload(record))
  finishPendingUserTurn(sessionId, record.uuid, 'failed', record.error || tt('message_prepare_failed'))
  setPendingSubmissionRecovery(record.uuid, { action: 'retry', run: () => retryUnsentSubmission(sessionId, record.uuid) })
  syncMainTranscriptChrome()
}

function stopPendingComposerSubmission(sessionId?: string): boolean {
  const pending = currentPendingComposerSubmission()
  if (!pending || sessionId && sessionId !== pending.sessionId && sessionId !== pending.viewId) return false
  pending.cancelled = true
  if (pending.sessionId) goalInteractions.stop(pending.sessionId)
  if (pending.phase !== 'submitting') {
    pending.phase = 'cancelled'
    settlePendingComposerSubmission(pending)
  }
  updateSendBtn()
  return true
}

interface ComposerSendOptions { invertFollowUp?: boolean; onAccepted?: () => void; expectedSessionId?: string }
async function submitDirectFriendMessage(): Promise<boolean> {
  const draft = composedInputDraft()
  if (!draft.references.some(reference => reference.kind === 'friend')) return false
  if (friendSendInFlight) return true
  if (pendingFiles.length) { showToast(tt('chat_friend_text_only')); return true }
  if (!draft.text.trim()) return true
  friendSendInFlight = true
  const sourceId = window.currentSessionId
  const snapshot = JSON.stringify(draft)
  const context = { ...friendComposeContext }
  updateSendBtn()
  try {
    const sessionId = await ensureSession()
    if (!sessionId) throw new Error(tt('message_prepare_failed'))
    const payload = buildOutgoingPayload(draft.text, [], null, sessionId, draft.references, draft.document)
    const dispatchKey = sessionId + ':' + snapshot
    friendDispatchAttempt = persistedFriendAttempts.acquire(dispatchKey)
    const displayMetadata = { ...sentUserDisplayMetadata(payload), ...friendComposeMetadata(context, true), friendDispatchId: friendDispatchAttempt.id }
    const receipt = await klausApi.friends.sendMessage({ sessionId, text: draft.text, displayMetadata }) as { accepted?: boolean }
    if (receipt.accepted !== true) throw new Error(tt('chat_friend_partial_send'))
    persistedFriendAttempts.accepted(friendDispatchAttempt)
    friendDispatchAttempt = null
    addSessionHistory(sessionId, draft)
    if ((window.currentSessionId === sourceId || !sourceId && window.currentSessionId === sessionId)
      && JSON.stringify(composedInputDraft()) === snapshot) {
      clearComposerAfterSubmit(sessionId)
      restoreParkedFriendDraft(sourceId || '__new')
    }
    void loadSessionHistory(sessionId)
    renderSessionList()
  } catch (error) {
    showToast(tt('chat_friend_send_failed') + ((error as Error)?.message || String(error)))
  } finally { friendSendInFlight = false; updateSendBtn() }
  return true
}

async function send(options: ComposerSendOptions = {}) {
  if (options.expectedSessionId && options.expectedSessionId !== window.currentSessionId) return
  if (friendComposeContext.quotedMessageId && !hasFriendQuoteInstruction(inputEl.value, inlineQuoteEntries())) { showToast(tt('chat_friend_quote_instruction')); return }
  if (await submitDirectFriendMessage()) return
  if (options.expectedSessionId && options.expectedSessionId !== window.currentSessionId) return
  const sessionId = window.currentSessionId || null
  const compactInstructions = pendingFiles.length === 0 ? parseCompactSlashInput(composedInputText()) : null
  if (compactInstructions !== null) {
    await triggerCompact(compactInstructions, sessionId, { accepted: () => { setComposerText(''); autoResize(); hideSlashMenu(); hideComposerPlusMenu() } })
    return
  }
  if (creatingGoalSessions.has(sessionId) || preparingSubmissions.has(sessionId)) return
  if (!composerGoalEnabled) {
    if (busy) return sendMessage(options)
    // Reserve the submitted snapshot before asynchronous preparation.
    const release = preparingSubmissions.begin(sessionId)
    if (!release) return
    try { await sendMessage(options) } finally { release() }
    return
  }
  const release = creatingGoalSessions.begin(sessionId)
  if (!release) return
  updateSendBtn()
  try {
    await sendMessage(options)
  } finally {
    release()
    syncBusyForCurrentSession()
    updateSendBtn()
  }
}

/** A dismissed paused-queue dialog leaves its rows and the submitted draft intact. */
async function askAboutPausedQueue(queuedCount: number): Promise<ReturnType<typeof decisionFromDialog> | null> {
  const confirm = window.klausDialog?.confirm
  if (typeof confirm !== 'function') return null
  const result = await confirm({
    title: tt('queue_paused_submit_title'),
    message: ttCount('queue_paused_submit_message', queuedCount),
    confirmText: tt('queue_paused_submit_send'),
    cancelText: tt('cancel'),
    danger: false,
    checkbox: { label: ttCount('queue_paused_submit_clear', queuedCount), defaultChecked: false },
  })
  // A boolean result means a dialog variant that carried no checkbox; there is then
  // no destructive alternative on offer, so a confirm is a plain send.
  if (typeof result === 'boolean') return decisionFromDialog({ confirmed: result, checked: false })
  return decisionFromDialog(result)
}

async function sendMessage(options: ComposerSendOptions = {}) {
  const goalInteractionToken = goalInteractions.token(window.currentSessionId)
  if (findKnownSession(window.currentSessionId)?.archived) {
    showToast(tt('archived_session_read_only'))
    return
  }
  const reviewEntry = approvalReviewShortcutRange(inputEl.value)
  if (reviewEntry) { hideSlashMenu(); activateComposerApprovalReviewShortcut(reviewEntry); return }
  const runningAtSubmit = busy
  const goalMode = composerGoalEnabled
  const sourceSessionId = window.currentSessionId
  // A submission keeps the conversation it was composed in as its target.
  // Sidebar navigation while host creation or preparation awaits are in flight
  // is an ordinary conversation switch afterwards: it must not abort the send,
  // and the transcript reloads from disk on return. Only an explicit cancel,
  // or goal-route invalidation (navigation and Stop void the reviewed goal
  // draft binding), may abort it.
  const sourceCurrent = () => !pending?.cancelled
    && !goalInteractions.routeInvalidated(goalMode, sourceSessionId, goalInteractionToken)
  const sourcePromotion = promoteInflight
  const draft = composedInputDraft()
  const text = draft.text
  updateInlineQuoteOffsets(text)
  const sentSlashCommand = selectedSlashCommand
  const files = [...pendingFiles]
  const runningDraftCurrent = () => JSON.stringify(composedInputDraft()) === JSON.stringify(draft)
    && pendingFiles.length === files.length && pendingFiles.every((file, index) => file === files[index])
  const goalPayloadFiles = files.map(file => ({ ...file }))
  if (!text.trim() && pendingFiles.length === 0) return
  const btwQuestion = pendingFiles.length === 0 ? parseBtwSlashInput(text) : null
  if (btwQuestion !== null) {
    await submitBtwQuestion(btwQuestion)
    return
  }
  const compactInstructions = pendingFiles.length === 0 ? parseCompactSlashInput(text) : null
  if (compactInstructions !== null) {
    await triggerCompact(compactInstructions, sourceSessionId, { accepted: () => { setComposerText(''); autoResize(); hideSlashMenu(); hideComposerPlusMenu() } })
    return
  }
  if (goalMode && !composerGoalEligible()) { denyComposerGoalAttempt(); return }
  const pending = !runningAtSubmit && !hasUploadInFlight(files)
    ? beginPendingComposerSubmission(draft, files, sentSlashCommand, goalInteractionToken) : null
  try {
  if (!(await ensureComposerModelConfigured())) return
  if (pending?.cancelled) return
  if (!sourceCurrent()) return
  // The conversation entity is created as early as preparation allows: the
  // submission, its draft slot and any later failure state are owned by that
  // identity instead of by the view the send started from.
  if (pending && !sourceSessionId) {
    try {
      await ensureSession(pending)
    } catch (error) {
      pending.phase = 'failed'
      pending.error = (error as Error)?.message || String(error)
      console.warn('[composer] session creation during send preparation failed:', error)
      showToast(tt('message_prepare_failed') + ((error as Error | null)?.message || String(error)))
      return
    }
    if (pending?.cancelled || !sourceCurrent()) return
  }
  // Deferred uploads also replay a running submission, so its draft must own
  // the original intent before either immediate routing or upload deferral.
  if (runningAtSubmit && !goalMode && !runningDraftCurrent()) return
  // Attachments still uploading: keep the submit intent instead of dropping it.
  // This sits ABOVE the busy branch on purpose — the running-session follow-up
  // path needs the same treatment, and a guard placed after the routing would
  // leave that path silently dropping submits.
  if (hasUploadInFlight(files)) {
    pendingSendAfterUpload = { invertFollowUp: !!options.invertFollowUp }
    updateSendBtn()
    return
  }
  if (window.currentSessionId && isWorktreeSessionWorkdir(sessionWorkdir(window.currentSessionId))) {
    if (await refreshWorktreeAvailability(window.currentSessionId) !== 'available') return
    if (!sourceCurrent()) return
  }
  if (runningAtSubmit && !goalMode) {
    // Running submission reads the visible draft. A newer document or tray
    // cannot inherit an earlier intent that waited for readiness.
    if (!runningDraftCurrent()) return
    // The first message is still creating its session. It cannot accept a
    // running-turn follow-up yet, and a repeated Enter must not duplicate errors.
    if (!window.currentSessionId && promoteInflight) return
    // A worktree-mode first send is still waiting on its host-side creation:
    // there is no running turn to steer or queue into yet, and a repeated
    // Enter must not dispatch a second copy of the same message.
    if (firstSendInFlight) return
    await submitRunningFollowUp({ invert: !!options.invertFollowUp })
    return
  }
  addSessionHistory(sourceSessionId, draft)
  resetHistoryBrowsing()

  if (!(await ensureProjectWorkdirForInitCommand(text))) return
  if (!sourceCurrent()) return

  // Queue changes remain conditional; a dismissal restores this submission's snapshot.
  const pausedQueueSessionId = sourceSessionId || window.currentSessionId
  if (pausedQueueSessionId) {
    const queueSnapshot = clientQueueSnapshotFor(pausedQueueSessionId)
    const queuedCount = clientQueueFor(pausedQueueSessionId).length
    if (needsPausedQueueConfirmation(!!queueSnapshot?.interrupted, queuedCount)) {
      // A dialog that could not be asked at all (bridge missing) must not swallow the
      // send: that is not the user cancelling, so the message goes out and the paused
      // rows are left exactly as they are for the user to deal with.
      const answer = await askAboutPausedQueue(queuedCount)
      if (!sourceCurrent()) return
      if (answer === 'cancel') return
      if (answer === 'send-and-clear') {
        if ((await clearClientQueue(pausedQueueSessionId))?.ok !== true) return
        if (!sourceCurrent()) return
      } else if (answer === 'send-and-resume') {
        // The rows are released but deliberately NOT dispatched: this message starts
        // the next turn, and a dispatch started now would race it. They go out after
        // this turn ends, which keeps the order the user wrote them in.
        if ((await resumeClientQueue(pausedQueueSessionId, false))?.ok !== true) return
        if (!sourceCurrent()) return
      }
    }
  }

  busy = true
  btnSend.disabled = false
  btnSend.classList.add('busy')
  hideSlashMenu(); hideComposerPlusMenu()

  // A workspace needs its real host identity before the workdir can be bound.
  // The submission already owns its visible message while that identity is pending.
  // The early preparation step above already created the entity for a pending
  // first send; worktree mode only parks the submit on it while the isolated
  // workspace is being built.
  let earlySessionId: string | null = pending?.sessionId ?? null
  if (earlySessionId && pendingRunMode === 'worktree') firstSendInFlight = true

  // Worktree 模式：首次发送前先建隔离工作区；失败则中止发送（输入保留）。
  const worktreeReady = await ensureRunModeWorkspaceForSend(earlySessionId ? { sessionId: earlySessionId } : undefined)
  if (!worktreeReady) {
    firstSendInFlight = false
    if (earlySessionId && !pending) retractLocalUserTurn(earlySessionId)
    busy = false
    syncBusyForCurrentSession()
    inputEl.focus()
    return
  }

  if (pending?.cancelled || !sourceCurrent()) return

  // Goal creation keeps its draft until the host acknowledges the goal. A
  // session switch or newly typed text must not be consumed by that reply.
  if (goalSubmissionRoute(goalMode) === 'goal' && (text || files.length)) {
    if (!composerGoalEligible()) return
    let goalIntentSessionId: string | null = null
    const goalIntentReceipt: { current: GoalSubmissionReceipt | null } = { current: null }
    let goalAdmitted = false
    busy = true
    btnSend.classList.add('busy')
    updateSendBtn()
    try {
      const sessionId = await ensureSession(pending || undefined)
      if (!sessionId || !klausApi.goal?.set) throw new Error('Goal creation is unavailable')
      if (window.currentSessionId !== sessionId || goalInteractions.token(sessionId) !== goalInteractionToken) return
      goalIntentSessionId = sessionId
      updateSendBtn()
      const payload = pending?.payload || buildOutgoingPayload(text, goalPayloadFiles, sentSlashCommand, sessionId, normalizeComposerReferences(draft.text, draft.references), draft.document)
      const selectedText = payload.selectedTextAttachments.map(item => item.text).join('\n\n')
      const pastes = payload.pastedCards.map(item => item.path ? { path: item.path } : { text: item.text || '' })
      const attachmentSnapshot = (entries: PendingFileEntry[]) => JSON.stringify(goalAttachmentIntent(entries))
      const binding = { sessionId, draft, attachments: files, interactionToken: goalInteractionToken, attachmentSnapshot: attachmentSnapshot(goalPayloadFiles) }
      const current = () => ({ sessionId: window.currentSessionId, draft: pending ? pending.draft : composedInputDraft(), attachments: pending ? pending.files : pendingFiles, interactionToken: pending?.cancelled ? 'cancelled' : goalInteractions.token(window.currentSessionId), attachmentSnapshot: attachmentSnapshot(pending ? goalPayloadFiles : pendingFiles) })
      const reviewed = await reviewGoalDraft<ComposerDraft, PendingFileEntry, PreparedGoalSubmission>({
        binding, current, objective: [payload.displayText, selectedText].filter(Boolean).join('\n\n'),
        readGoal: () => hydrateGoalSnapshot(sessionId), currentGoal: () => goalSnapshots.get(sessionId), goalIntentVersion: () => goalSnapshots.intentVersion(sessionId),
        prepare: (source, valid) => !composerGoalEligible() ? Promise.resolve(null) : prepareGoalSubmission({
          receipts: goalSubmissionReceipts, sessionId, serializedIntent: serializeGoalSubmissionIntent(draft, goalPayloadFiles),
          target: { expectedGoalId: source?.goalId ?? null, expectedGoalRevision: goalSnapshots.revision(sessionId) },
          input: { text: payload.displayText, selectedText, pastes, images: goalImageInputs(goalPayloadFiles) },
          valid: () => valid() && composerGoalEligible(), prepare: input => klausApi.goal.prepareObjective(sessionId, input),
          onReceipt: receipt => { goalIntentReceipt.current = receipt },
        }),
        readObjective: async target => (await klausApi.goal.readObjective(sessionId, target.objective)).content,
        confirm: confirmGoalReplacement,
        discard: async target => { if (target.preparationId) await klausApi.goal.discardPreparedObjective(sessionId, target.preparationId) },
      })
      if (!reviewed) return
      const { prepared, goal: existingGoal } = reviewed
      const receipt = prepared.receipt
      if (!composerGoalEligible() || !sameGoalDraft(binding, current()) || !sameGoalReview(existingGoal, goalSnapshots.get(sessionId)) || reviewed.intentVersion !== goalSnapshots.intentVersion(sessionId)) {
        if (prepared.preparationId) await klausApi.goal.discardPreparedObjective(sessionId, prepared.preparationId)
        return
      }
      let goalRevision = 0
      await createGoalFromDraft({
        create: async () => {
          if (pending) {
            const uuid = await goalSubmissionUserUuid(receipt.id)
            bindPendingUserTurn(sessionId, pending.uuid, uuid)
            pending.uuid = uuid
            if (pending.cancelled || !sourceCurrent()) throw new Error('Submission was cancelled')
            pending.phase = 'submitting'
          }
          if (pending) {
            const pastedPaths = pending.payload.pastedCards.map(card => card.path).filter((path): path is string => !!path)
            if (pastedPaths.length) void klausApi.chat.pastedTextRelease(pastedPaths).catch(() => undefined)
          }
          const result = await klausApi.goal.set(sessionId, { objective: prepared.objective, preparationId: prepared.preparationId, expectedGoalId: receipt.expectedGoalId, expectedGoalRevision: receipt.expectedGoalRevision, clientRequestId: receipt.id, submit: true, displayText: prepared.displayText })
          goalRevision = result.goalRevision
          if (result.admission !== 'deferred') goalAdmitted = true
          if (result.admission === 'deferred') {
            if (pending) finishPendingUserTurn(pending.viewId, pending.uuid, 'cancelled')
            ingestChatEvent({ type: 'notice', sessionId, content: tt('goal_saved_deferred') })
          }
          return result
        },
        accept: goal => {
          if (pending) acceptPendingComposerSubmission(pending)
          if (!sourceSessionId) addSessionHistory(sessionId, draft, true)
          options.onAccepted?.()
          goalSubmissionReceipts.forget(sessionId)
          draftOnlySessionIds.delete(sessionId)
          forgetRunModeForDraft(sessionId)
          onGoalUpdated({ sessionId, goal: goal as Parameters<typeof normalizeGoal>[0] | null, goalRevision })
          if (window.currentSessionId === sessionId) setComposerGoalEnabled(false)
          if (window.currentSessionId === sessionId) {
            showTranscriptSurface()
            scrollToBottom({ force: true })
          }
        },
        consumeUnchangedDraft: () => {
          if (window.currentSessionId === sessionId) {
            if (!pending && sameGoalDraft(binding, current())) clearComposerAfterSubmit(sessionId)
          } else if (!pending && JSON.stringify(normalizeComposerDraft(sessionDrafts.get(sessionId))) === JSON.stringify(draft)) {
            setDraft(sessionId, '')
            const remaining = (sessionPendingFiles.get(sessionId) || []).filter((file: PendingFileEntry) => !files.includes(file))
            sessionPendingFiles.set(sessionId, remaining)
          }
        },
      })
    } catch (error) {
      if (pending) {
        pending.phase = pending.phase === 'submitting' && !isGoalConflict(error) ? 'unconfirmed' : 'failed'
        pending.error = pending.phase === 'unconfirmed' ? tt('submission_unconfirmed') : (error as Error)?.message || String(error)
      }
      console.error('[goal] create from first message failed', error)
      if (goalIntentSessionId && goalIntentReceipt.current && goalSubmissionReceipts.rejectConflict(goalIntentSessionId, goalIntentReceipt.current.id, error)) {
        const keepGoalArmed = window.currentSessionId === goalIntentSessionId && goalMode
        await refreshGoalSnapshot(goalIntentSessionId)
        if (keepGoalArmed && window.currentSessionId === goalIntentSessionId) setComposerGoalEnabled(true)
        showToast(tt('goal_changed_retry'))
      } else showToast(tt('composer_goal_set_failed'))
    } finally {
      busy = getSessionStream(window.currentSessionId || '').running
      syncBusyForCurrentSession()
      // Goal admission starts the first turn asynchronously; hold the stop
      // affordance until stream events take over so the send slot never reads
      // idle (and never falls back to the voice entry) while the loop comes up.
      if (goalAdmitted && !busy) {
        busy = true
        btnSend.disabled = false
        btnSend.classList.add('busy')
      }
      updateSendBtn()
    }
    return
  }

  const payloadFiles = files.map(file => ({ ...file }))
  const draftOwner = (targetSessionId: string): string | null => (
    window.currentSessionId === targetSessionId
      || sessionDrafts.has(targetSessionId)
      || sessionPendingFiles.has(targetSessionId)
  ) ? targetSessionId : sourceSessionId
  const readSubmissionDraft = (targetSessionId: string) => {
    const owner = draftOwner(targetSessionId)
    if (window.currentSessionId === owner) {
      updateComposerQuoteOffsets()
      return { draft: composedInputDraft(), files: pendingFiles }
    }
    return {
      draft: owner ? normalizeComposerDraft(sessionDrafts.get(owner)) : getWelcomeDraft(),
      files: (sessionPendingFiles.get(owner) || []) as PendingFileEntry[],
    }
  }
  const prepared = await prepareComposerSubmission({
    snapshot: { draft, files },
    ensureSession: async () => {
      if (sourceSessionId) return sourceSessionId
      // A worktree-mode first send already created its session ahead of the
      // host-side creation wait; reusing it keeps the optimistic bubble and
      // the turn on the same session.
      if (earlySessionId) return earlySessionId
      if (pending?.sessionId) return pending.sessionId
      if (sourcePromotion) return pending ? ensureSession(pending) : sourcePromotion
      return ensureSession(pending || undefined)
    },
    buildPayload: targetSessionId => pending?.payload || buildOutgoingPayload(text, payloadFiles, sentSlashCommand, targetSessionId, normalizeComposerReferences(draft.text, draft.references), draft.document),
    readDraft: targetSessionId => pending ? { draft: pending.draft, files: pending.files } : readSubmissionDraft(targetSessionId),
    consumeDraft: (targetSessionId, remaining) => {
      if (pending) return
      const owner = draftOwner(targetSessionId)
      const removedPrefixLength = readSubmissionDraft(targetSessionId).draft.text.length - remaining.draft.text.length
      const files = [...remaining.files]
      // Retained quote chips use offsets in the remaining display text when
      // their placeholders are restored, including after a conversation switch.
      for (const file of files) {
        if (Number.isInteger(file.composerOffset)) file.composerOffset = Math.max(0, Number(file.composerOffset) - removedPrefixLength)
      }
      if (files.length) sessionPendingFiles.set(owner, files)
      else sessionPendingFiles.delete(owner)
      if (window.currentSessionId === owner) {
        clearComposerAfterSubmit(targetSessionId)
        if (remaining.draft.text || files.length) {
          setComposerText(remaining.draft)
          restorePendingFiles(owner)
          autoResize()
          updateSendBtn()
        }
      }
      if (owner) setDraft(owner, remaining.draft)
      else setWelcomeDraft(remaining.draft)
    },
    onUnavailable: error => {
      if (pending) { pending.phase = 'failed'; pending.error = (error as Error)?.message || String(error) }
      console.warn('[composer] message preparation failed:', error)
      showToast(tt('message_prepare_failed') + ((error as Error | null)?.message || String(error)))
    },
    releaseBusy: syncBusyForCurrentSession,
  })
  if (!prepared) {
    firstSendInFlight = false
    return
  }
  const { sessionId: targetSessionId, payload } = prepared
  // ensureSession await 期间用户可能已切到别的 session（极罕见 race）。这种
  // 情况下消息仍发到 targetSessionId（用户最初的发送意图），但 UI 渲染只在
  // 还停留在 targetSessionId 时进行——否则气泡会错位 append 到用户当前看的
  // 历史会话 DOM 里。下次切回 targetSessionId 时 history 会从磁盘 reload，
  // 气泡 + 流式回复都会正常出现。
  if (pending?.cancelled || !sourceCurrent()) return
  if (pending) {
    pending.phase = 'submitting'
    noteCommandReference(targetSessionId, payload.sentSlashCommand ?? null, pending.uuid)
    const pastedPaths = payload.pastedCards.map(card => card.path).filter((path): path is string => !!path)
    if (pastedPaths.length) void klausApi.chat.pastedTextRelease(pastedPaths).catch(() => undefined)
  }
  const submissionError = await submitTurnPayload(targetSessionId, payload, { ...(pending ? { quietError: true } : {}), preserveDraft: true, skipOptimistic: !!pending || targetSessionId === earlySessionId })
  if (pending && !submissionError) acceptPendingComposerSubmission(pending)
  else if (pending) { pending.phase = 'failed'; pending.error = submissionError || tt('message_prepare_failed') }
  firstSendInFlight = false
  if (!submissionError) {
    if (!sourceSessionId) addSessionHistory(targetSessionId, draft, true)
    options.onAccepted?.()
  }
  // 语音学习闭环：本轮草稿含语音插入时，把「上屏 vs 最终发送」交给主进程
  // fire-and-forget 抽取热词/语音记忆（未编辑时主进程自行跳过）。
  flushVoiceLearning(text)
  } finally {
    if (pending && pending.phase !== 'accepted') settlePendingComposerSubmission(pending)
  }
}

async function activeWidgetRevision(request: WidgetInteractionRequest): Promise<boolean> {
  if (window.currentSessionId !== request.sessionId || findKnownSession(request.sessionId)?.archived) return false
  try {
    const snapshot = await klausApi.artifacts.widgetUrl(request.sessionId, request.widgetId, request.revision, request.path)
    return window.currentSessionId === request.sessionId && snapshot?.ok === true && snapshot.currentRevision === request.revision
  } catch { return false }
}

function appendWidgetDraft(text: string): void {
  const existing = inputEl.value || ''
  const addition = existing ? `\n${text}` : text
  const end = existing.length + addition.length
  inputEl.value = existing + addition
  inputEl.setSelectionRange(end, end)
  inputEl.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: addition, bubbles: true }))
  autoResize()
  updateSendBtn()
  persistComposerDraft()
  inputEl.focus()
}

;(window as typeof window & { klausHandleWidgetInteraction?: (request: WidgetInteractionRequest) => Promise<boolean> }).klausHandleWidgetInteraction = async request => {
  return dispatchWidgetInteraction(request, {
    isCurrent: activeWidgetRevision,
    appendDraft: appendWidgetDraft,
    stale: () => showToast(tt('widget_stale')),
    manual: () => showToast(tt('widget_draft_preserved')),
    confirm: async text => {
      const confirm = window.klausDialog?.confirm
      if (typeof confirm !== 'function') return false
      const answer = await confirm({
        title: tt('widget_confirm_title'),
        message: tt('widget_confirm_message').replace('{preview}', text),
        confirmText: tt('widget_confirm_send'),
        cancelText: tt('cancel'),
        danger: false,
      })
      return typeof answer === 'boolean' ? answer : answer?.confirmed === true
    },
    isBusy: () => busy,
    needsManualSend: () => composerGoalEnabled && !hasLiveGoal(request.sessionId)
      || !!clientQueueSnapshotFor(request.sessionId)?.interrupted && clientQueueFor(request.sessionId).length > 0,
    modelReady: () => ensureComposerModelConfigured(),
    queue: async text => {
      const queued = await queueFollowUp(request.sessionId, buildOutgoingPayload(text, [], null, request.sessionId, []))
      if (queued.status === 'refused') { forgetPendingQueueAddition(request.sessionId, queued.id); showToast(tt('follow_up_failed')) }
      return queued.status !== 'refused'
    },
    send: async text => {
      busy = true
      btnSend.disabled = false
      btnSend.classList.add('busy')
      updateSendBtn()
      try {
        const payload = buildOutgoingPayload(text, [], null, request.sessionId, [])
        const error = await submitTurnPayload(request.sessionId, payload, { preserveDraft: true, preserveQueueAnchor: true })
        if (!error) return true
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error))
      }
      busy = false
      syncBusyForCurrentSession()
      updateSendBtn()
      return false
    },
  })
}

// ==================== Slash command menu ====================

// 斜杠命令按当前会话工作区取数：有会话时引擎按会话 cwd 发现（项目会话→项目目录，无项目→会话私有目录）；
// 草稿态选了项目就传 root 按该项目列；会话模式（无项目）再把 scope==='project' 的条目过滤掉，
// 防引擎无 root 时回退 CANONICAL_CWD 泄漏其它项目的命令/技能。
async function fetchSlashCommands(options: { strict?: boolean; forceReload?: boolean } = {}): Promise<SlashCommandInfo[]> {
  const scope = slashCatalogScope()
  const sessionId = window.currentSessionId, root = selectedProjectWorkdir() || undefined
  let commands: SlashCommandInfo[]
  try {
    commands = await slashCatalog.load(scope, () => loadScopedSlashCommands(sessionId, root, { ...options, strict: true }), options)
  } catch (error) {
    if (error instanceof StaleSlashCatalogRequest || options.strict) throw error
    // Partial compatibility rows remain usable without becoming a fresh catalog.
    commands = await loadInstalledSlashCommands(options, error)
  }
  if (scope !== slashCatalogScope()) throw new StaleSlashCatalogRequest()
  const currentCommands = withManualCompactCommand(withPlanShortcut(withComposerGoalShortcut(commands), tt('composer_plan'))).filter(command => !isManualCompactCommand(command)
    || manualCompactQueryAllowed(inputEl.value, currentSlashTrigger(), pendingFiles.length, window.currentSessionId))
  if (window.currentSessionId && !ctxPanel.sessions.has(window.currentSessionId)) void fetchContextStats(window.currentSessionId)
  currentCommands.forEach(cacheSlashCommand)
  return currentCommands
}

async function loadScopedSlashCommands(sessionId: string | null, root?: string, options: { strict?: boolean; forceReload?: boolean } = {}): Promise<SlashCommandInfo[]> {
  let requestError: unknown
  try {
    if (klausApi.engine?.slashCommands) {
      const commands = await klausApi.engine.slashCommands(sessionId || undefined,
        { root: !sessionId ? root : undefined, forceReload: options.forceReload })
      if (Array.isArray(commands)) return commands
        .filter(command => (sessionId || root || command?.scope !== 'project') && !isHiddenBuiltinSlashCommand(command))
      throw new Error(tt('composer_load_failed'))
    }
    throw new Error(tt('composer_load_failed'))
  } catch (error) { requestError = error }
  if (options.strict) throw requestError
  return loadInstalledSlashCommands(options, requestError)
}

async function loadInstalledSlashCommands(options: { strict?: boolean } = {}, requestError?: unknown): Promise<SlashCommandInfo[]> {
  try {
    const skills = await klausApi.skills.list()
    if (!Array.isArray(skills)) {
      if (options.strict) throw new Error(tt('composer_load_failed'))
      return []
    }
    return skills.filter(skill => skill.enabled || skill.userEnabled).map(skill => ({
      name: skill.dirName || skill.name, displayName: skill.name, description: skill.description || '',
      source: skill.source, path: skill.path, definitionPreview: skill.definitionPreview === true, kind: 'skill', type: 'prompt',
    }))
  } catch (error) {
    if (options.strict) throw error instanceof Error ? error : requestError || new Error(tt('composer_load_failed'))
    return []
  }
}

async function handleSlashMenu(options: { refreshOnly?: boolean } = {}) {
  if (options.refreshOnly && (composerMenuMode !== 'slash' || slashMenu.classList.contains('hidden'))) return
  const text = inputEl.value
  const selectionStart = inputEl.selectionStart ?? text.length
  const selectionEnd = inputEl.selectionEnd ?? selectionStart
  if (selectionStart !== selectionEnd) {
    if (composerMenuMode === 'slash') hideSlashMenu()
    return
  }
  const trigger = currentSlashTrigger()
  if (!trigger) {
    if (composerMenuMode === 'slash') hideSlashMenu()
    return
  }
  // A selected command chip owns its range of the draft; a slash caret inside
  // that run sits in the placeholder, not on a fresh trigger. Outside the chip
  // the menu must still open — a draft can hold a chip and a later slash
  // query at the same time, and refusing it left the user with no picker.
  if (selectedSlashCommand && isValidSlashCommandRange(selectedSlashCommandRange)
    && trigger.start < selectedSlashCommandRange.end
    && trigger.end > selectedSlashCommandRange.start) {
    if (composerMenuMode === 'slash') hideSlashMenu()
    return
  }
  const seq = ++slashRequestSeq
  const query = trigger.query.toLowerCase()
  const localCommands = trigger.prefix === '$' ? [] : withManualCompactCommand(withPlanShortcut(withComposerGoalShortcut([]), tt('composer_plan')))
    .filter(command => (!isManualCompactCommand(command) || manualCompactQueryAllowed(text, trigger, pendingFiles.length, window.currentSessionId)) && slashCommandMatchesSearch(command, query))
  if (localCommands.length && !options.refreshOnly) showSlashMenu(localCommands, trigger)
  let commands: SlashCommandInfo[]
  try { commands = await fetchSlashCommands() } catch (error) {
    if (error instanceof StaleSlashCatalogRequest) return
    throw error
  }
  if (seq !== slashRequestSeq || inputEl.value !== text || !sameComposerQuery(trigger, currentSlashTrigger())
    || inputEl.ownerDocument && inputEl.ownerDocument.activeElement !== inputEl) return
  if (options.refreshOnly && (composerMenuMode !== 'slash' || slashMenu.classList.contains('hidden'))) return
  const candidates = trigger.prefix === '$' ? commands.filter(isSkillCommand) : commands
  const filtered = query ? candidates.filter(command => slashCommandMatchesSearch(command, query)) : candidates
  if (filtered.length === 0) { if (composerMenuMode === 'slash') hideSlashMenu(); return }
  showSlashMenu(filtered, trigger)
}

function showSlashMenu(items: SlashCommandInfo[], trigger = currentSlashTrigger()) {
  activeSlashTriggerRange = trigger
  hideComposerPlusMenu()
  claimOverlay('slash-menu')
  composerMenuMode = 'slash'
  items.forEach(cacheSlashCommand)
  slashMenuApi?.showSlash(items)
}

function hideSlashMenu(dismissQuery = false) {
  if (dismissQuery) mainComposerControl?.dismissQuery()
  slashRequestSeq++
  composerMenuMode = null
  workspaceAtTrigger = null
  workspaceMentionScope = null
  activeSlashTriggerRange = null
  slashMenuApi?.hide()
}
registerOverlay('slash-menu', hideSlashMenu)

function selectSlashItem(command: SlashCommandInfo) {
  const current = currentSlashTrigger()
  if (!current || !activeSlashTriggerRange || current.start !== activeSlashTriggerRange.start || current.end !== activeSlashTriggerRange.end
    || activeSlashTriggerRange.query !== undefined && current.query !== activeSlashTriggerRange.query
    || activeSlashTriggerRange.prefix !== undefined && current.prefix !== activeSlashTriggerRange.prefix) {
    hideSlashMenu()
    return
  }
  const triggerRange = current
  hideSlashMenu()
  if (isManualCompactCommand(command)) { void activateMainManualCompact(triggerRange); return }
  if (isApprovalReviewShortcut(command)) { activateComposerApprovalReviewShortcut(triggerRange); return }
  if (isGoalShortcut(command)) { void activateComposerGoalShortcut(triggerRange); return }
  if (isPlanShortcut(command)) { void activateComposerPlanShortcut(triggerRange); return }
  insertSlashCommandToken(command, triggerRange)
  focusComposerInputAfterSlashInsert()
}

// slash/mention 双模式菜单与附件预览区的 React 挂载（渲染面在组件，数据面在本文件）。
function composerDiscoveryMenuActions(callbacks: Pick<SlashMenuActions, 'onMentionMenuEmpty' | 'onSelectCommand' | 'onSelectMention'>, sessionId: () => string | null = () => window.currentSessionId): SlashMenuActions {
  return {
    manualCompactState: () => ({ sessionId: sessionId(), percent: contextUsageView(ctxPanel.sessions.get(sessionId() || ''))?.percent ?? null }),
    subscribeCommandState: listener => {
      commandStateListeners.add(listener)
      const unsubscribe = chatStreamStore.subscribe(listener)
      return () => { commandStateListeners.delete(listener); unsubscribe() }
    },
    commandIconSvg: (command) => commandIconSvg(command),
    slashCommandDescription: (command) => slashCommandDescription(command),
    slashCommandDisplayName: (command) => slashCommandDisplayName(command),
    slashCommandGroupLabel: (key: string) => slashCommandGroupLabel(key),
    commandGroupKey: (command) => commandGroupKey(command as SlashCommandInfo | null),
    folderIconSvg: () => folderIconSvg(),
    fileIconSvg: (name: string) => fileIconSvg(name),
    pluginIconSvg: () => klausIcon('plugin-fill'),
    deviceIconHtml: () => klausIcon('run-mode-local'),
    categoryIconHtml: (category) => category === 'folders' ? folderIconSvg() : fileIconSvg(''),
    conversationIconHtml: () => klausIcon('chat-bubble'),
    openFileSearchSession: (sessionId, root) => openWorkspaceFileSearchSession(sessionId, root),
    ...callbacks,
  }
}
const slashMenuApi = mountSlashMenu(slashMenu, composerDiscoveryMenuActions({
  onMentionMenuEmpty: () => { if (composerMenuMode === 'workspace') hideSlashMenu() },
  onSelectCommand: command => selectSlashItem(command),
  onSelectMention: (entry, intent) => selectWorkspaceMentionItem(entry, intent),
}))

const mainAttachmentHistory = new AttachmentHistory()
installAttachmentHistory(inputEl, document.getElementById('previews'), mainAttachmentHistory)
const previewsApi = mountPreviews(document.getElementById('previews'), {
  onRemove: (entry) => {
    const owner = window.currentSessionId, navigation = goalInteractions.token(null), generation = mainComposerControl?.historyGeneration
    mainAttachmentHistory.remove(entry, {
      files: () => pendingFiles, setFiles: files => { pendingFiles = files },
      current: () => window.currentSessionId === owner && goalInteractions.token(null) === navigation
        && mainComposerControl?.historyGeneration === generation,
      changed: () => { renderPreviews(); updateSendBtn(); inputEl.focus() },
      finalize: file => {
        if (mainAttachmentRetained(file)) return
        disposeAttachmentObjectUrl(file)
        if (file.kind === 'pasted-text' && file.uploadPath) void klausApi.chat.pastedTextRemove(file.uploadPath).catch(() => undefined)
      },
    })
    // Pulling an attachment out is the user changing their mind: a submit that
    // was parked waiting for it must not fire later on its own.
    cancelDeferredSend()
    renderPreviews(); updateSendBtn()
  },
  onOpenImage: (src) => openImagePreview(src),
  onOpenFile: (entry) => openFileAttachmentPreview(entry),
  onRestorePasted: (entry) => { void restorePastedTextToComposer(entry) },
  formatMeta: (entry) => formatPreviewMeta(entry),
})

function navigateSlashMenu(dir: number) {
  slashMenuApi?.navigate(dir)
}

// ==================== Composer plus menu ====================

const COMPOSER_PLUS_ICONS = {
  file: klausIcon('file'),
  skills: skillIconSvg(),
  plugins: pluginIconSvg(),
  mcp: mcpIconSvg(),
  slash: slashCommandIconSvg(),
  spec: klausIcon('spec'),
  plan: klausIcon('plan'),
  goal: klausIcon('goal'),
  check: klausIcon('check-2'),
  manage: klausIcon('manage'),
  chevron: klausIcon('chevron-2'),
  back: klausIcon('back'),
}
// 双轨垫片：React PlanReviewCard 经 window 读 spec 图标。
window.COMPOSER_PLUS_ICONS = COMPOSER_PLUS_ICONS

function isComposerPlusOpen() {
  return !!composerPlusApi?.isOpen()
}

// Collaboration mode is engine-owned and independent of permission policy.
// Archived file-based plan documents remain readable below.
let composerSpecEnabled = false
let specModeRevision = 0
// sessionId → 已批准的 spec 计划文件路径（localStorage 持久，重启不丢绑定）。
const specDocBySession = new Map()
try {
  const saved = JSON.parse(localStorage.getItem('klaus_approved_spec_docs_v2') || '{}')
  for (const [sid, path] of Object.entries(saved)) {
    if (typeof path === 'string' && path) specDocBySession.set(sid, path)
  }
} catch { /* 损坏的持久档直接从空开始 */ }

const specExecutionPaths = new Map<string, string>()
try {
  const saved = JSON.parse(localStorage.getItem('klaus_spec_executions_v1') || '{}')
  for (const [key, path] of Object.entries(saved)) {
    if (typeof path === 'string') specExecutionPaths.set(key, path)
  }
} catch { /* A corrupt history index can be rebuilt from subsequent approvals. */ }
window.getSpecExecutionPath = (sessionId: string, toolCallId: string) => specExecutionPaths.get(`${sessionId}:${toolCallId}`) || ''

// Spec card action icon. The document itself opens in the shared right panel.
const SPEC_PANEL_ICON = klausIcon('spec-panel')
// 双轨垫片：React PlanReviewCard 经 window 复用 spec 域的图标/批注工具。
window.SPEC_PANEL_ICON = SPEC_PANEL_ICON

// sessionId → 待提交的批注列表。批注的结构对齐文档驱动产品的通行做法：
// 每条记住「选中的原文 + 用户意见 + 所在行范围」，提交时作为上下文交给模型，
// 而不是直接改文档——人只负责指出问题，重写交给模型。
const specAnnotationsBySession = new Map()

/// 把一个已渲染的 markdown 容器变成可批注面：选中文字 → 冒出「批注」浮层 →
/// 写意见 → 该段加高亮下划线，卡底累加计数。返回读写句柄供调用方在提交
/// 时取用。`host` 提供浮层与列表的挂载位，`docEl` 是被批注的正文。
function attachSpecAnnotating(host: HTMLElement, docEl: HTMLElement, { sessionId, path }: { sessionId: string | null; path: string }) {
  const listEl = host.querySelector('.spec-annotations')
  const items: Array<{ content: string; comment: string; startOffset?: number; endOffset?: number; anchorText?: string; path?: string; marks: HTMLElement[] }> = []

  const render = () => {
    if (!listEl) return
    listEl.classList.toggle('hidden', items.length === 0)
    if (!items.length) { listEl.innerHTML = ''; return }
    listEl.innerHTML = `
      <div class="spec-annotations-head">${escapeHtml(tt('spec_annotation_summary').replace('{n}', String(items.length)))}</div>
      ${items.map((it, i: number) => `
        <div class="spec-annotation-row" data-index="${i}">
          <div class="spec-annotation-quote">${escapeHtml(it.content)}</div>
          <div class="spec-annotation-comment">${escapeHtml(it.comment)}</div>
          <button class="spec-annotation-del" type="button" aria-label="${escapeHtml(tt('spec_annotation_delete'))}">${klausIcon('close')}</button>
        </div>`).join('')}`
    listEl.querySelectorAll<HTMLElement>('.spec-annotation-del').forEach((btn) => {
      btn.onclick = () => {
        const row = btn.closest('.spec-annotation-row')
        const idx = parseInt((row as HTMLElement | null)?.dataset.index || '-1', 10)
        if (idx >= 0) {
          items[idx].marks.forEach((m: HTMLElement) => m.classList.remove('spec-annotated'))
          items.splice(idx, 1)
          render()
        }
      }
    })
  }

  // 浮层：选区存在时跟随选区尾部显示，点击展开输入框。
  let bubble: HTMLElement | null = null
  const closeBubble = () => { bubble?.remove(); bubble = null }

  const openBubble = (range: Range, rect: DOMRect) => {
    closeBubble()
    const selected = range.toString().trim()
    if (!selected) return
    bubble = document.createElement('div')
    bubble.className = 'spec-annotate-bubble'
    bubble.innerHTML = `
      <textarea class="spec-annotate-input" rows="2" spellcheck="false"
        placeholder="${escapeHtml(tt('spec_annotation_placeholder'))}"></textarea>
      <div class="spec-annotate-actions">
        <button class="spec-annotate-cancel" type="button">${escapeHtml(tt('cancel'))}</button>
        <button class="spec-annotate-confirm" type="button">${escapeHtml(tt('spec_annotation_confirm'))}</button>
      </div>`
    host.appendChild(bubble)
    // 定位在选区下方，以 host 为参系（host 已是 position:relative）。
    const hostRect = host.getBoundingClientRect()
    bubble.style.top = `${rect.bottom - hostRect.top + 6}px`
    bubble.style.left = `${Math.max(8, Math.min(rect.left - hostRect.left, hostRect.width - 260))}px`
    const input = bubble.querySelector<HTMLTextAreaElement>('.spec-annotate-input')
    ;(input as HTMLElement).focus()

    const commit = () => {
      const comment = input!.value.trim()
      if (!comment) { closeBubble(); return }
      // DOM range offsets distinguish repeated passages. They are rendered-text
      // offsets, never guessed Markdown source line numbers.
      const prefix = document.createRange()
      prefix.selectNodeContents(docEl)
      prefix.setEnd(range.startContainer, range.startOffset)
      const startOffset = prefix.toString().length
      const endOffset = startOffset + range.toString().length
      const anchorText = (range.startContainer.parentElement?.closest('p,li,pre,h1,h2,h3,h4,blockquote')?.textContent || selected).trim()
      const marks = highlightRange(range)
      items.push({ content: selected, comment, startOffset, endOffset, anchorText, marks })
      render()
      closeBubble()
      window.getSelection()?.removeAllRanges()
    }
    ;(bubble.querySelector('.spec-annotate-confirm') as HTMLElement).onclick = commit
    ;(bubble.querySelector('.spec-annotate-cancel') as HTMLElement).onclick = () => { closeBubble(); window.getSelection()?.removeAllRanges() }
    input!.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit() }
      if (e.key === 'Escape') { e.preventDefault(); closeBubble() }
    }
  }

  // 高亮：把选区包成 <mark>。跨元素选区用 surroundContents 会抛错，回退到
  // 按文本节点逐段包，保证任意选区都能拿到可视标记。
  function highlightRange(range: Range) {
    const marks = []
    try {
      const mark = document.createElement('mark')
      mark.className = 'spec-annotated'
      range.surroundContents(mark)
      marks.push(mark)
    } catch {
      const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT)
      const touched = []
      while (walker.nextNode()) {
        if (range.intersectsNode(walker.currentNode)) touched.push(walker.currentNode)
      }
      for (const node of touched) {
        if (!node.textContent?.trim()) continue
        const mark = document.createElement('mark')
        mark.className = 'spec-annotated'
        node.parentNode?.insertBefore(mark, node)
        mark.appendChild(node)
        marks.push(mark)
      }
    }
    return marks
  }

  const onMouseUp = () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!docEl.contains(range.commonAncestorContainer)) return
    if (!range.toString().trim()) return
    openBubble(range.cloneRange(), range.getBoundingClientRect())
  }
  docEl.addEventListener('mouseup', onMouseUp)

  const handle = {
    count: () => items.length,
    peek: () => items.map(({ marks, ...item }) => ({ ...item, path })),
    clear: () => {
      items.forEach(item => item.marks.forEach(mark => mark.classList.remove('spec-annotated')))
      items.length = 0
      render()
    },
    take: () => {
      const taken = items.map(({ marks, ...item }) => ({ ...item, path }))
      items.forEach(item => item.marks.forEach(mark => mark.classList.remove('spec-annotated')))
      items.length = 0
      render()
      return taken
    },
    destroy: () => {
      closeBubble()
      docEl.removeEventListener('mouseup', onMouseUp)
      items.forEach(item => item.marks.forEach(mark => mark.classList.remove('spec-annotated')))
      items.length = 0
      render()
      if (sessionId && specAnnotationsBySession.get(sessionId) === handle) specAnnotationsBySession.delete(sessionId)
    },
  }
  if (sessionId) specAnnotationsBySession.set(sessionId, handle)
  return handle
}
// 双轨垫片：React PlanReviewCard 经 window 复用批注工具；spec 域迁入组件树时收编。
window.attachSpecAnnotating = attachSpecAnnotating

/// 把批注变成下一轮输入：模型需要知道「哪一段」「什么意见」「哪个文件」，
/// 才能定点重写而不是重新推演全文。
function submitSpecAnnotations(list: Array<{ content: string; comment: string; startOffset?: number; endOffset?: number; anchorText?: string; path?: string }>, planFilePath: string, sessionId: string | null = window.currentSessionId): boolean {
  if (!Array.isArray(list) || !list.length || !sessionId) return false
  const entries = list.map((annotation) => {
    const path = annotation.path || planFilePath
    const text = serializeSpecAnnotation({ ...annotation, path })
    return {
      ...buildSelectedTextEntry(text),
      previewText: `${tt('spec_annotation_label')} · ${specFileName(path)}`,
      specAnnotation: { ...annotation, path, sessionId },
    }
  })
  if (sessionId !== window.currentSessionId) {
    sessionPendingFiles.set(sessionId, [...(sessionPendingFiles.get(sessionId) || []), ...entries])
    return true
  }
  // Context chips have no inline replacement range, so neither a selected
  // draft passage nor the current caret can cause user text to be overwritten.
  pendingFiles.push(...entries)
  renderPreviews()
  updateSendBtn()
  persistComposerDraft()
  focusComposerInput(inputEl, inputEl.value.length)
  return true
}
// 双轨垫片：React PlanReviewCard 拒绝时经 window 提交批注。
window.submitSpecAnnotations = submitSpecAnnotations

const specPanel = document.getElementById('spec-panel')
const specDocuments = createSpecDocumentPanel({
  root: specPanel,
  knownPaths: sessionId => [...new Set([
    specDocBySession.get(sessionId),
    ...[...specExecutionPaths].filter(([key]) => key.startsWith(`${sessionId}:`)).map(([, path]) => path),
  ].filter((path): path is string => typeof path === 'string' && !!path))],
  readSpecDoc: path => klausApi.session.readSpecDoc(path),
  resolvePath: (sessionId, path) => {
    if (/^(?:\/|[A-Za-z]:[\\/])/.test(path)) return path
    const cwd = findKnownSession(sessionId)?.workdir || (sessionId === window.currentSessionId ? selectedProjectWorkdir() : null)
    return cwd ? `${cwd.replace(/[\\/]$/, '')}/${path.replace(/^\.\//, '')}` : path
  },
  renderMarkdown: renderMarkdownHtml,
  attachAnnotations: attachSpecAnnotating,
  submitAnnotations: submitSpecAnnotations,
  openPanel: () => openArtifactsPanel('spec'),
  openDirectory: path => klausApi.artifacts.reveal(path),
  downloadFile: async (name, content) => {
    const result = await klausApi.session.saveSpecDoc(name, content)
    if (result?.ok === false && !result.canceled) throw new Error(result.error || tt('spec_download_failed'))
  },
  translate: tt,
  onDocumentSelected: (path, sessionId) => { void openSpecPanel({ sessionId, path }) },
  onDocumentDiscovered: document => { void openSpecPanel(document) },
})
specDocuments.setSession(window.currentSessionId)

function clearSpecPanel(path = '') { specDocuments.clear(path) }
function activateSpecPanel(document: { sessionId: string | null; path: string }) { return specDocuments.activate(document) }

function openSpecPanel({ sessionId, path }: { sessionId: string | null; path: string }) {
  if (!path) return
  return window.KlausPanelTabs?.openSpec?.({ sessionId, path, title: specFileName(path) })
}

function specFileName(path: string) {
  return String(path || '').split(/[\\/]/).pop() || 'plan.md'
}
// Spec 审阅与文档面的对外句柄（仓内惯例：跨文件/工具共享面挂到 window）。
window.openSpecPanel = openSpecPanel
window.openSpecAnnotation = async (annotation: { sessionId: string; path: string; content: string; comment: string; startOffset?: number; endOffset?: number; anchorText?: string }) => {
  if (annotation.sessionId !== window.currentSessionId) await switchSession(annotation.sessionId)
  await openSpecPanel(annotation)
  const doc = specPanel?.querySelector<HTMLElement>('.spec-document-view:not([hidden]) .spec-panel-doc, .spec-document-view:not([hidden]) .plan-review-doc')
  if (!doc) return
  if (window.currentSessionId !== annotation.sessionId || specDocuments.activePath() !== annotation.path) return
  const marks = markSpecAnnotation(doc, annotation)
  marks[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  window.setTimeout(() => {
    marks.forEach(mark => { if (mark.isConnected) mark.replaceWith(...mark.childNodes) })
  }, 1500)
  specPanel?.querySelector('.spec-annotation-preview')?.remove()
  const preview = document.createElement('div')
  preview.className = 'spec-annotation-preview spec-annotation-row'
  preview.innerHTML = `<div class="spec-annotation-quote">${escapeHtml(annotation.content)}</div><div class="spec-annotation-comment">${escapeHtml(annotation.comment)}</div><button type="button" aria-label="${escapeHtml(tt('close_btn'))}">${klausIcon('close')}</button>`
  preview.querySelector('button')!.onclick = () => preview.remove()
  doc.insertAdjacentElement('afterend', preview)
}

window.klausActivateSpecPanel = activateSpecPanel
window.klausCloseSpecPanel = (path?: string) => clearSpecPanel(path)
window.klausActiveSpecPath = () => specDocuments.activePath()
window.addEventListener('klaus:session-change', () => specDocuments.setSession(window.currentSessionId))

let planPanelRoot: Root | null = null
let activePlanReview: { sessionId: string; controller: PlanReviewController } | null = null

function planningPanelHost() {
  let host = document.getElementById('planning-work-panel')
  if (!host) {
    host = document.createElement('section')
    host.id = 'planning-work-panel'
    document.querySelector('#artifacts-panel .artifacts-body')?.appendChild(host)
  }
  return host
}

async function activatePlanningEditor(sessionId: string, controller: PlanReviewController) {
  if (window.currentSessionId !== sessionId) return false
  if (activePlanReview && activePlanReview.controller !== controller) {
    await activePlanReview.controller.closeEditor()
    if (activePlanReview.controller.getSnapshot().editorOpen) return false
  }
  if (window.currentSessionId !== sessionId) return false
  activePlanReview = { sessionId, controller }
  openArtifactsPanel('planning')
  planPanelRoot ??= createRoot(planningPanelHost())
  planPanelRoot.render(createElement(PlanDocumentEditor, { controller }))
  if (!controller.getSnapshot().editorOpen) await controller.openEditor()
  return window.currentSessionId === sessionId
}

configurePlanningWorkflow({
  api: klausApi.plan,
  open: (sessionId, controller) => {
    void (async () => {
      const plan = controller.getSnapshot().plan
      if (sessionId === window.currentSessionId) await window.KlausPanelTabs?.openPlanning?.({ sessionId, planId: plan.id, revision: plan.revision })
    })()
  },
  download: async content => {
    const result = await klausApi.session.saveSpecDoc('PLAN.md', content)
    if (result?.ok === false && !result.canceled) throw new Error('Plan download failed')
  },
})
;(window as any).klausActivatePlanningPanel = async ({ sessionId, planId, revision }: { sessionId: string; planId: string; revision: number }) => {
  const plan = planningSnapshot(sessionId)?.plans.find(entry => entry.id === planId && entry.revision === revision)
  if (!plan || sessionId !== window.currentSessionId) return false
  const { planReviewController } = await import('./planning/runtime')
  const controller = planReviewController(sessionId, plan)
  return controller ? activatePlanningEditor(sessionId, controller) : false
}
;(window as any).klausActivePlanningKey = () => activePlanReview ? `${activePlanReview.controller.getSnapshot().plan.id}:${activePlanReview.controller.getSnapshot().plan.revision}` : ''
;(window as any).klausClosePlanningPanel = async () => {
  if (activePlanReview) {
    await activePlanReview.controller.closeEditor()
    if (activePlanReview.controller.getSnapshot().editorOpen) return false
  }
  activePlanReview = null
  planPanelRoot?.render(null)
  return true
}
window.addEventListener('klaus:session-change', () => { void (window as any).klausClosePlanningPanel() })

let planDecisionRoot: Root | null = null
function renderComposerPlanDecision() {
  let host = document.getElementById('planning-decision-panel')
  const sessionId = window.currentSessionId
  if (!sessionId || findKnownSession(sessionId)?.archived || !pendingProposedPlan(sessionId)) {
    planDecisionRoot?.render(null)
    if (host) host.hidden = true
    return
  }
  if (!host) { host = document.createElement('section'); host.id = 'planning-decision-panel' }
  const composer = inputWrapperEl?.querySelector('#input-area')
  if (!composer?.parentElement) return
  if (host.parentElement !== composer.parentElement) composer.parentElement.insertBefore(host, composer)
  host.hidden = false
  planDecisionRoot ??= createRoot(host)
  planDecisionRoot.render(createElement(PendingPlanReview, { sessionId, key: sessionId }))
}
subscribePlanningWorkflow(renderComposerPlanDecision)
window.addEventListener('klaus:session-change', renderComposerPlanDecision)

function renderPlanningOverview() {
  const body = document.querySelector('#monitor-section-plan .artifacts-section-body')
  if (!body) return
  let row = document.getElementById('monitor-proposed-plan') as HTMLButtonElement | null
  const sessionId = window.currentSessionId
  const plan = sessionId ? planningSnapshot(sessionId)?.plans.filter(entry => ['writing', 'proposed', 'accepted'].includes(entry.status)).at(-1) : undefined
  if (!plan) { row?.remove(); reconcilePlanSection(); return }
  if (!row) { row = document.createElement('button'); row.id = 'monitor-proposed-plan'; row.type = 'button'; body.prepend(row) }
  const heading = plan.content.split(/\r?\n/).find(line => /^#\s+/.test(line))?.replace(/^#\s+/, '').replace(/\*\*|__/g, '').trim() || tt('planning_title')
  row.innerHTML = `<span aria-hidden="true">${klausIcon('plan')}</span><span>${escapeHtml(heading)}</span>`
  row.onclick = () => { void window.KlausPanelTabs?.openPlanning?.({ sessionId, planId: plan.id, revision: plan.revision }) }
  reconcilePlanSection()
}
subscribePlanningWorkflow(renderPlanningOverview)
window.addEventListener('klaus:session-change', renderPlanningOverview)
window.addEventListener('klaus:lang-change', renderPlanningOverview)

let planningInputRoot: Root | null = null
function renderComposerPlanningInput() {
  let host = document.getElementById('planning-input-panel')
  const sessionId = window.currentSessionId
  const request = sessionId ? pendingPlanningQuestions(sessionId).at(-1) : null
  if (!request) { planningInputRoot?.render(null); if (host) host.hidden = true; return }
  if (!host) { host = document.createElement('section'); host.id = 'planning-input-panel' }
  host.hidden = false
  const queue = inputWrapperEl?.querySelector('#follow-up-queue')
  if (queue?.parentElement && host.parentElement !== queue.parentElement) queue.parentElement.insertBefore(host, queue)
  planningInputRoot ??= createRoot(host)
  planningInputRoot.render(createElement(PlanningQuestionView, { request, inComposer: true }))
}
function applyPlanningQuestion(request: PlanningQuestionRequest) {
  receivePlanningQuestion(request)
  ingestPlanningQuestion(request)
}
configurePlanningQuestions(async (identity, resolution) => {
  const result = await klausApi.planningInput.answer(identity.sessionId, { requestId: identity.requestId, turnId: identity.turnId, toolCallId: identity.toolCallId, status: resolution.status === 'expired' ? 'cancelled' : resolution.status, answers: resolution.response.answers })
  return { accepted: result.accepted, status: resolution.status, response: resolution.response, identity }
})
subscribePlanningQuestions(renderComposerPlanningInput)
window.addEventListener('klaus:session-change', () => {
  renderComposerPlanningInput()
  const sessionId = window.currentSessionId
  if (!sessionId) return
  const token = planningQuestionReadToken(sessionId)
  void klausApi.planningInput.pending(sessionId).then((result: PlanningInputRequest[]) => {
    if (reconcilePlanningQuestionRead(sessionId, result, token)) for (const request of result) ingestPlanningQuestion(request)
  }).catch(() => { if (window.currentSessionId === sessionId && !sessionDeletePending.has(sessionId)) showToast(tt('planning_questions_load_failed')) })
})

function applyPlanningUpdated({ sessionId, planning }: { sessionId: string; planning: PlanningSnapshot }) {
  if (!receivePlanningSnapshot(sessionId, planning)) return
  ingestPlanningSnapshot(sessionId, planning)
  if (sessionId === window.currentSessionId) {
    composerSpecEnabled = planning.mode === 'plan'
    if (composerSpecEnabled && composerGoalEnabled) setComposerGoalEnabled(false)
    updateSpecBadge()
    composerPredictions?.invalidate(sessionId)
  }
}
window.addEventListener('klaus:planning-snapshot', ((event: CustomEvent<{ sessionId: string; planning: PlanningSnapshot }>) => applyPlanningUpdated(event.detail)) as EventListener)

// ---- 目标模式（会话级持久目标 + 引擎自动续跑）----
// 目标工具随会话常在（config.goal 恒 true），模型可自行调 create_goal。同时保留
// 加号菜单里的「目标模式」开关作为用户手动武装入口：开关开着时下一条消息
// 自动变成目标 objective。这不是工具门控，只是输入区的快捷方式。
let composerGoalEnabled = false
const goalSnapshots = new GoalSnapshots()
const goalPursuitEligibility = new Map<string, boolean>()
const goalBySession = { get: (sessionId: string) => goalSnapshots.get(sessionId) }
window.getSessionGoalSnapshot = (sessionId: string) => goalSnapshots.get(sessionId)

function setComposerGoalEnabled(enabled: boolean) {
  composerGoalEnabled = enabled && composerGoalEligible()
  updateGoalBadge()
  updateGoalPlaceholder()
}

function composerGoalControlsAvailable(): boolean {
  return goalSurfaceControlsAvailable(findKnownSession(window.currentSessionId), !!detectChannelPrefix(window.currentSessionId || ''))
}
function composerGoalEligible(): boolean {
  return goalPursuitEligibility.get(window.currentSessionId || '') !== false
    && goalSurfaceEligible(findKnownSession(window.currentSessionId), !!detectChannelPrefix(window.currentSessionId || ''))
}
function withComposerGoalShortcut(commands: SlashCommandInfo[]): SlashCommandInfo[] {
  const scoped = composerGoalEligible() ? withGoalShortcut(commands, tt('composer_goal')) : commands.filter(command => !isGoalShortcut(command))
  return withApprovalReviewShortcut(scoped, tt('approval_review_shortcut'), !!window.currentSessionId && approvalReviewDenials(window.currentSessionId).length > 0)
}

function activateComposerApprovalReviewShortcut(range: { start: number; end: number } | null) {
  const sessionId = window.currentSessionId
  if (!sessionId) return
  if (range) {
    const draft = inputEl.value
    const before = draft.slice(0, range.start)
    setComposerText(before + draft.slice(range.end).replace(/^[ \t]+/, ''))
    autoResize(); updateSendBtn(); persistComposerDraft()
  }
  claimOverlay('slash-menu')
  composerMenuMode = 'slash'
  slashMenuApi?.showApprovalReview(sessionId, () => window.currentSessionId, hideSlashMenu)
}

function denyComposerGoalAttempt(): false {
  setComposerGoalEnabled(false)
  showToast(tt('goal_unavailable_context'))
  return false
}
async function toggleComposerGoalEnabled(forceEnable = false): Promise<boolean> {
  if (!composerGoalEligible()) return denyComposerGoalAttempt()
  const next = forceEnable || !composerGoalEnabled
  const targetSessionId = window.currentSessionId
  const interactionToken = goalInteractions.token(targetSessionId)
  const generation = ++specModeRevision
  const bound = () => window.currentSessionId === targetSessionId && goalInteractions.token(targetSessionId) === interactionToken && generation === specModeRevision
  const valid = () => bound() && composerGoalEligible()
  const rejected = () => bound() && !composerGoalEligible() ? denyComposerGoalAttempt() : false
  if (next && targetSessionId) {
    try { await hydrateGoalSnapshot(targetSessionId) }
    catch { if (bound()) showToast(tt('composer_goal_load_failed')); return false }
    try {
      if (!valid()) return rejected()
      const ready = await leavePlanningForGoal({ valid,
        read: () => klausApi.session.getCollaborationMode(targetSessionId),
        setDefault: () => klausApi.session.setCollaborationMode(targetSessionId, 'default'),
        apply: planning => applyPlanningUpdated({ sessionId: targetSessionId, planning }),
      })
      if (!ready) return rejected()
    } catch { showToast(tt('planning_mode_failed')); return false }
  }
  if (!valid()) return rejected()
  if (next) { composerSpecEnabled = false; updateSpecBadge() }
  setComposerGoalEnabled(next)
  return composerGoalEnabled
}

function hasLiveGoal(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  const goal = goalBySession.get(sessionId)
  if (!goal) return false
  return String(goal.status || '') !== 'complete'
}

/** A goal that is actively advancing keeps its session occupied between turns. */
function goalAdvancing(sessionId: string | null | undefined): boolean {
  return goalBySession.get(sessionId || '')?.status === 'active'
}

function placeComposerModeBadge(inputRow: Element, badge: HTMLElement) {
  const permissionSelect = inputRow.querySelector('#permission-select')
  if (permissionSelect && badge.previousElementSibling !== permissionSelect) {
    inputRow.insertBefore(badge, permissionSelect.nextSibling)
  } else if (!permissionSelect && badge.parentElement !== inputRow) {
    inputRow.appendChild(badge)
  }
}

// Show the armed Goal badge immediately after the permission selector; clicking it disarms Goal mode.
function updateGoalBadge() {
  const inputRow = inputWrapperEl?.querySelector('.input-row')
  if (!inputRow) return
  let badge = document.getElementById('goal-mode-badge')
  if (!composerGoalEnabled) { badge?.remove(); return }
  if (!badge) {
    badge = document.createElement('button')
    badge.id = 'goal-mode-badge'
    ;(badge as HTMLButtonElement).type = 'button'
    badge.className = 'goal-mode-badge'
    badge.innerHTML = `<span class="goal-badge-icon" aria-hidden="true">${COMPOSER_PLUS_ICONS.goal}</span><span class="goal-badge-close" aria-hidden="true">×</span><span class="goal-badge-text">${escapeHtml(tt('composer_goal'))}</span>`
    badge.onclick = () => { void toggleComposerGoalEnabled() }
  }
  badge.setAttribute('aria-label', tt('goal_badge_tooltip'))
  const label = badge.querySelector<HTMLElement>('.goal-badge-text')
  if (label) label.textContent = tt('composer_goal')
  placeComposerModeBadge(inputRow, badge)
}

// 开关开着且没目标时把 placeholder 改成“描述你的目标...”。
function updateGoalPlaceholder() {
  const needsGoalPlaceholder = composerGoalEnabled && !hasLiveGoal(window.currentSessionId)
  inputEl.placeholder = needsGoalPlaceholder
    ? tt('goal_placeholder')
    : tt('placeholder')
}

function syncComposerStatusOrder() {
  if (!inputWrapperEl) return
  const queue = inputWrapperEl.querySelector('#follow-up-queue')
  const content = queue?.parentElement
  if (!queue || !content) return
  const goal = document.getElementById('goal-indicator')
  const spec = document.getElementById('spec-banner')
  // Keep status rows ordered without moving already ordered focused subtrees.
  let anchor: Node = queue
  for (const row of [spec, goal]) {
    if (row?.parentElement !== content) continue
    if (row.nextSibling !== anchor) content.insertBefore(row, anchor)
    anchor = row
  }
}

let goalRowRoot: Root | null = null
let goalEditorRoot: Root | null = null
let openGoalSessionId: string | null = null
const goalEditors = new Map<string, GoalEditorController>()
const goalCompletionCleanup = new GoalCompletionCleanup<GoalWireSnapshot & { ok: boolean; error?: string }>({
  clear: (sessionId, input) => klausApi.goal.clear(sessionId, input),
  apply: (sessionId, result) => {
    if (result.ok === false || result.error) throw new Error(result.error || 'Goal completion cleanup failed')
    onGoalUpdated({ sessionId, goal: result.goal, goalRevision: result.goalRevision })
  },
  refresh: refreshGoalSnapshot,
})
const goalPresentationObjectives = new Map<string, { source: string; content: string | null; failed: boolean }>()
const goalSubmissionReceipts = new GoalSubmissionReceipts(value => persistLocalValue('klaus_goal_submission_receipts_v1', value), localStorage.getItem('klaus_goal_submission_receipts_v1'))
const goalLocale = (): GoalLocale => (window as any).currentLang === 'zh' ? 'zh' : 'en'
function goalEditorKey(sessionId: string, goal: GoalSnapshot) { return JSON.stringify([sessionId, goal.goalId]) }
function goalEditorFor(sessionId: string, goal: GoalSnapshot) {
  const key = goalEditorKey(sessionId, goal)
  let controller = goalEditors.get(key)
  if (!controller) { controller = new GoalEditorController(goal); goalEditors.set(key, controller) }
  return controller
}
function retireGoalSessionCaches(sessionId: string, currentGoal: GoalSnapshot | null = null) {
  const keepKey = currentGoal && currentGoal.status !== 'complete' ? goalEditorKey(sessionId, currentGoal) : null
  const ownedPrefix = `[${JSON.stringify(sessionId)},`
  for (const [key, controller] of goalEditors) {
    if (key.startsWith(ownedPrefix) && key !== keepKey) {
      goalEditors.delete(key)
      controller.update(null)
    }
  }
  for (const [key, cached] of goalPresentationObjectives) {
    if (key.startsWith(ownedPrefix) && (key !== keepKey || cached.source !== currentGoal?.objective)) goalPresentationObjectives.delete(key)
  }
}
async function mutateDisplayedGoal(sessionId: string, goal: GoalSnapshot, status?: 'active' | 'paused') {
  if (!composerGoalControlsAvailable() || status === 'active' && !composerGoalEligible() || window.currentSessionId !== sessionId || goalSnapshots.get(sessionId)?.goalId !== goal.goalId) throw new Error('Goal changed')
  const guard = goalSnapshots.guard(sessionId, goal)
  const result = await (status
    ? klausApi.goal.set(sessionId, { status, ...guard })
    : klausApi.goal.clear(sessionId, guard)).catch(async (error: unknown) => {
    if (isGoalConflict(error)) await refreshGoalSnapshot(sessionId)
    throw error
  })
  if (result.ok === false || result.error) throw new Error(result.error || 'Goal update failed')
  if ('goal' in result) onGoalUpdated({ sessionId, goal: result.goal, goalRevision: result.goalRevision })
  return result
}

function goalSummary(sessionId: string, goal: GoalSnapshot): string {
  if (!goal.objectiveMaterialized) return goal.objective
  const key = goalEditorKey(sessionId, goal)
  const existing = goalPresentationObjectives.get(key)
  if (existing?.source === goal.objective) return existing.content ?? tt(existing.failed ? 'goal_objective_load_failed' : 'goal_objective_loading')
  const loading = { source: goal.objective, content: null as string | null, failed: false }
  goalPresentationObjectives.set(key, loading)
  void klausApi.goal.readObjective(sessionId, goal.objective).then((result: { content: string }) => {
    if (goalPresentationObjectives.get(key) !== loading) return
    goalPresentationObjectives.set(key, { source: goal.objective, content: result.content, failed: false })
    if (window.currentSessionId === sessionId && goalSnapshots.get(sessionId)?.goalId === goal.goalId) updateGoalIndicator()
  }).catch(() => {
    if (goalPresentationObjectives.get(key) !== loading) return
    goalPresentationObjectives.set(key, { source: goal.objective, content: null, failed: true })
    if (window.currentSessionId === sessionId) updateGoalIndicator()
  })
  return tt('goal_objective_loading')
}

function updateGoalIndicator() {
  if (!inputWrapperEl) return
  let row = document.getElementById('goal-indicator')
  const sessionId = window.currentSessionId
  const goal = sessionId ? goalSnapshots.get(sessionId) : null
  if (!composerGoalControlsAvailable() || !goal || goal.status === 'complete') {
    goalRowRoot?.render(null)
    if (row) row.hidden = true
    syncComposerStatusOrder()
    return
  }
  if (!row) { row = document.createElement('div'); row.id = 'goal-indicator' }
  row.hidden = false
  const queue = inputWrapperEl.querySelector('#follow-up-queue')
  if (!queue?.parentElement) return
  if (row.parentElement !== queue.parentElement) queue.parentElement.insertBefore(row, queue)
  goalRowRoot ??= createRoot(row)
  goalRowRoot.render(createElement(GoalProgressRow, {
    goal, locale: goalLocale(), displayObjective: goalSummary(sessionId!, goal), canPursue: composerGoalEligible(),
    onOpen: () => { void window.KlausPanelTabs?.openGoal?.({ sessionId, goalId: goal.goalId }) },
    onPause: target => mutateDisplayedGoal(sessionId!, target, 'paused'),
    onReviewResume: target => {
      if (!composerGoalEligible()) return Promise.resolve(null)
      const interactionToken = goalInteractions.token(sessionId)
      return reviewGoalResume({ goal: target,
        valid: () => composerGoalEligible() && window.currentSessionId === sessionId && goalInteractions.token(sessionId) === interactionToken,
        readGoal: () => hydrateGoalSnapshot(sessionId!), currentGoal: () => goalSnapshots.get(sessionId!),
        readObjective: async source => (await klausApi.goal.readObjective(sessionId!, source.objective)).content,
      })
    },
    onResume: target => mutateDisplayedGoal(sessionId!, target, 'active'),
    onClear: target => mutateDisplayedGoal(sessionId!, target),
  }))
  syncComposerStatusOrder()
}

function closeGoalPanel() {
  openGoalSessionId = null
  goalEditorRoot?.render(null)
}
function renderGoalEditor(sessionId: string, goal: GoalSnapshot) {
  let host = document.getElementById('goal-work-panel')
  if (!host) { host = document.createElement('section'); host.id = 'goal-work-panel'; document.querySelector('#artifacts-panel .artifacts-body')?.appendChild(host) }
  goalEditorRoot ??= createRoot(host)
  const controller = goalEditorFor(sessionId, goal)
  controller.update(goal)
  goalEditorRoot.render(createElement(GoalEditor, {
    goal, controller, locale: goalLocale(), readOnly: !composerGoalEligible(),
    readObjective: async target => (await klausApi.goal.readObjective(sessionId, target.objective)).content,
    onOpenLink: href => { void klausApi.app.openExternal(href) },
    onSave: async (objective, target) => {
      if (!composerGoalEligible() || window.currentSessionId !== sessionId) throw new Error('Goal editing is unavailable')
      const prepared = await klausApi.goal.prepareObjective(sessionId, { text: objective })
      controller.expectSavedObjective(prepared.objective)
      let guard
      try {
        if (!composerGoalEligible() || window.currentSessionId !== sessionId) throw new Error('Goal editing is unavailable')
        guard = goalSnapshots.guard(sessionId, target)
      } catch (error) {
        if (prepared.preparationId) await klausApi.goal.discardPreparedObjective(sessionId, prepared.preparationId)
        throw error
      }
      const result = await klausApi.goal.set(sessionId, { objective: prepared.objective, status: 'active', preparationId: prepared.preparationId, ...guard }).catch(async (error: unknown) => {
        if (isGoalConflict(error)) await refreshGoalSnapshot(sessionId)
        throw error
      })
      if (result.ok === false || result.error || !result.goal) throw new Error(result.error || 'Goal update failed')
      onGoalUpdated({ sessionId, goal: result.goal, goalRevision: result.goalRevision })
      if (result.admission === 'deferred') ingestChatEvent({ type: 'notice', sessionId, content: tt('goal_saved_deferred') })
      const saved = goalSnapshots.get(sessionId)
      if (!saved) throw new Error('Goal changed before the save completed')
      return saved
    },
  }))
}
;(window as any).klausActivateGoalPanel = ({ sessionId, goalId }: { sessionId: string; goalId: string }) => {
  const goal = goalSnapshots.get(sessionId)
  if (!composerGoalControlsAvailable() || !goal || goal.status === 'complete' || goal.goalId !== goalId || window.currentSessionId !== sessionId) return false
  openGoalSessionId = sessionId
  renderGoalEditor(sessionId, goal)
  openArtifactsPanel('goal')
  return true
}
;(window as any).klausCloseGoalPanel = closeGoalPanel
;(window as any).klausActiveGoalId = () => openGoalSessionId ? goalSnapshots.get(openGoalSessionId)?.goalId || '' : ''
window.addEventListener('klaus:session-change', closeGoalPanel)
window.addEventListener('klaus:lang-change', () => {
  updateGoalBadge()
  updateGoalIndicator()
  updateSpecBadge()
  if (openGoalSessionId) { const goal = goalSnapshots.get(openGoalSessionId); if (goal) renderGoalEditor(openGoalSessionId, goal) }
})
function confirmGoalReplacement(goal: GoalSnapshot, objective: string): Promise<boolean> {
  return new Promise(resolve => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const finish = (accepted: boolean) => {
      window.removeEventListener('klaus:lang-change', renderConfirmation)
      root.unmount(); host.remove(); resolve(accepted)
    }
    const renderConfirmation = () => root.render(createElement(GoalConfirmation, { kind: 'replace', goal: { objective, status: goal.status }, locale: goalLocale(), onConfirm: () => finish(true), onCancel: () => finish(false) }))
    window.addEventListener('klaus:lang-change', renderConfirmation)
    renderConfirmation()
  })
}
function normalizeGoal(goal: { goalId: string; threadId: string; objective: string; status: GoalSnapshot['status']; tokenBudget?: number | null; tokensUsed: number; timeUsedSeconds: number; createdAtMs: number; updatedAtMs: number }): GoalSnapshot {
  return { ...goal, tokenBudget: goal.tokenBudget ?? null, objectiveMaterialized: /^Read the complete goal objective from /i.test(goal.objective) || goal.objective.includes('<klaus-goal-objective') }
}
/** Revision ordering covers null clears as well as present generations. */
function onGoalUpdated(payload: GoalWireSnapshot & { sessionId?: string }, readToken?: symbol) {
  const sessionId = payload.sessionId || ''
  if (!sessionId) return
  const received = payload.goal ? normalizeGoal(payload.goal) : null
  const previousGoal = goalSnapshots.get(sessionId)
  if (!goalSnapshots.receive(sessionId, received, payload.goalRevision, readToken)) return
  if (typeof payload.goalPursuitEligible === 'boolean') goalPursuitEligibility.set(sessionId, payload.goalPursuitEligible)
  const goal = goalSnapshots.get(sessionId)
  retireGoalSessionCaches(sessionId, goal)
  ingestTaskGoalSnapshot(sessionId, goal)
  if (goal) {
    const editor = goalEditors.get(goalEditorKey(sessionId, goal))
    if (editor) {
      const previous = editor.getSnapshot()
      editor.update(goal)
      if ((editor.getSnapshot().sourceChanged || previous.goal?.objective !== goal.objective && !editor.getSnapshot().saving) && openGoalSessionId === sessionId) window.KlausPanelTabs?.closeGoal?.()
    }
  }
  if (!goal || goal.status === 'complete') {
    if (openGoalSessionId === sessionId) window.KlausPanelTabs?.closeGoal?.()
    if (goal) {
      ingestGoalCompletion(sessionId, goal)
      void goalCompletionCleanup.run(sessionId, goal, payload.goalRevision)
    }
  } else if (openGoalSessionId === sessionId) renderGoalEditor(sessionId, goal)
  if (sessionId === window.currentSessionId) {
    if (!composerGoalEligible() || goal?.status === 'complete' || !goal && previousGoal) setComposerGoalEnabled(false)
    updateGoalIndicator()
    // Goal status flips change session occupancy: the stop affordance and the
    // voice entry both follow the busy flag derived from it.
    syncBusyForCurrentSession()
  }
}
async function hydrateGoalSnapshot(sessionId: string): Promise<GoalSnapshot | null> {
  const previous = goalSnapshots.get(sessionId), revision = goalSnapshots.revision(sessionId)
  const readToken = goalSnapshots.readToken(sessionId)
  try {
    const result = await klausApi.goal.get(sessionId)
    if (!result || !Object.hasOwn(result, 'goal') || !Number.isSafeInteger(result.goalRevision) || result.goalRevision < 0) throw new Error('Invalid goal snapshot')
    if (!goalSnapshots.isCurrentRead(sessionId, readToken)) {
      if (goalSnapshots.has(sessionId) && (goalSnapshots.get(sessionId) !== previous || goalSnapshots.revision(sessionId) > revision)) return goalSnapshots.get(sessionId)
      throw new Error('Goal read was superseded')
    }
    onGoalUpdated({ sessionId, ...result }, readToken)
    return goalSnapshots.get(sessionId)
  } finally { goalSnapshots.finishRead(sessionId, readToken) }
}
async function refreshGoalSnapshot(sessionId: string) {
  try { await hydrateGoalSnapshot(sessionId) }
  catch (error) {
    // Background reads can overlap runtime startup or retirement. Keep the last
    // snapshot and diagnostics without reporting a mutation the user never made.
    console.warn('[goal] snapshot refresh failed', sessionId, error)
  }
  if (sessionId === window.currentSessionId) updateGoalIndicator()
}

async function refreshComposerSpecEnabled() {
  const sessionId = window.currentSessionId
  if (!sessionId) { composerSpecEnabled = false; updateSpecBadge(); return false }
  const generation = ++specModeRevision
  try {
    const result = await klausApi.session.getCollaborationMode(sessionId)
    if (sessionId !== window.currentSessionId || generation !== specModeRevision) return composerSpecEnabled
    applyPlanningUpdated({ sessionId, planning: result.planning })
  } catch {
    if (sessionId !== window.currentSessionId || generation !== specModeRevision || sessionDeletePending.has(sessionId)) return composerSpecEnabled
    showToast(tt('planning_mode_failed'))
  }
  updateSpecBadge()
  return composerSpecEnabled
}

async function toggleComposerSpecEnabled() {
  const sourceSessionId = window.currentSessionId
  const targetSessionId = sourceSessionId || await ensureSession()
  if (!targetSessionId || sourceSessionId && sourceSessionId !== window.currentSessionId) return composerSpecEnabled
  const next = !composerSpecEnabled
  const generation = ++specModeRevision
  try {
    const result = await klausApi.session.setCollaborationMode(targetSessionId, next ? 'plan' : 'default')
    if (window.currentSessionId !== targetSessionId || generation !== specModeRevision) return composerSpecEnabled
    applyPlanningUpdated({ sessionId: targetSessionId, planning: result.planning })
    if (next && composerGoalEnabled) setComposerGoalEnabled(false)
  } catch { showToast(tt('planning_mode_failed')) }
  updateSpecBadge()
  return composerSpecEnabled
}

async function activateComposerPlanShortcut(range: { start: number; end: number } | null) {
  return activatePlanShortcut({
    sessionId: () => window.currentSessionId,
    readDraft: () => inputEl.value,
    toggle: async () => {
      const previous = composerSpecEnabled
      await toggleComposerSpecEnabled()
      return composerSpecEnabled !== previous
    },
    replaceDraft: (value, caret) => { setComposerText(value); autoResize(); updateSendBtn(); persistComposerDraft(); focusComposerInput(inputEl, caret) },
  }, range)
}

function updateSpecBadge() {
  const inputRow = inputWrapperEl?.querySelector('.input-row')
  if (!inputRow) return
  let badge = document.getElementById('plan-mode-badge')
  document.getElementById('spec-mode-badge')?.remove()
  if (!composerSpecEnabled) { badge?.remove(); return }
  if (!badge) {
    badge = document.createElement('button')
    badge.id = 'plan-mode-badge'
    ;(badge as HTMLButtonElement).type = 'button'
    badge.className = 'goal-mode-badge spec-mode-badge'
    badge.onclick = () => { void toggleComposerSpecEnabled() }
  }
  badge.setAttribute('aria-label', tt('planning_mode_off'))
  badge.innerHTML = `<span class="goal-badge-icon" aria-hidden="true">${COMPOSER_PLUS_ICONS.plan}</span><span class="goal-badge-close" aria-hidden="true">×</span><span class="goal-badge-text">${escapeHtml(tt('composer_plan'))}</span>`
  placeComposerModeBadge(inputRow, badge)
}

// Spec 文档横幅：批准后把「执行对照的 spec 文件」钉在输入区上方，执行阶段
// 与任务面板一起构成「执行与 spec 持续绑定」的可见面。
function updateSpecBanner() {
  updateSpecBadge()
  // Execution is recorded in the transcript; it is not a permanent draft mode.
  document.getElementById('spec-banner')?.remove()
  syncComposerStatusOrder()
}

// 任务面板顶部的 spec 绑定条：指明当前任务在对照哪份已批准的 spec 执行。
// 点击在系统编辑器里打开该文档，方便执行中随时回看计划。
function renderTaskPanelSpecBinding(section: HTMLElement) {
  if (!section) return
  const header = section.querySelector('.artifacts-section-header')
  if (!header) return
  let row = section.querySelector('.task-spec-binding')
  const path = specDocBySession.get(window.currentSessionId)
  if (!path) { row?.remove(); return }
  if (!row) {
    row = document.createElement('button')
    ;(row as HTMLButtonElement).type = 'button'
    row.className = 'task-spec-binding'
    header.insertAdjacentElement('afterend', row)
  }
  const name = String(path).split('/').pop() || String(path)
  row.setAttribute('aria-label', `${tt('spec_open_panel')}: ${path}`)
  row.innerHTML = `
    <span class="task-spec-binding-icon" aria-hidden="true">${COMPOSER_PLUS_ICONS.spec}</span>
    <span class="task-spec-binding-label">${escapeHtml(tt('spec_tasks_bound'))}</span>
    <span class="task-spec-binding-path">${escapeHtml(name)}</span>`
  ;(row as HTMLElement).onclick = () => {
    // 执行中回看计划：开 app 内面板（而不是丢给外部编辑器），因为执行阶段发现
    // 计划不对时仍需要就地批注交回模型；面板头部保留了外部打开入口。
    openSpecPanel({ sessionId: window.currentSessionId || '', path: String(path) })
  }
}

// ==================== Composer plus 菜单（React 化，src/chat/composer/plus-menu.tsx） ====================
// 卡面/子菜单/hover 时序/定位全在组件内；这里只注入数据加载器与动作。
// mcp loader：数据源用 sessionStatus——它把 user/global + 当前工作目录下的
// project/local + plugin 各 scope 的 MCP 合并成扁平列表（含项目/本地 MCP），
// 比 mcp.list()（仅 user/全局）更全。连接器(日历等)是宿主托管、不写 .mcp.json，
// 仍单独并入已开启的。会话模式（无项目）只留 user/plugin 级，剪掉 project/
// local——防无 cwd 时后端回退 CANONICAL_CWD 带出其它项目的 MCP。
const composerPlusApi = mountComposerPlusMenu({
  menuEl: composerPlusMenu,
  submenuEl: composerPlusSubmenu,
  btnEl: btnComposerPlus,
  loaders: {
    skills: options => getComposerSkills(options),
    plugins: () => (klausApi.plugins?.list ? klausApi.plugins.list() : Promise.resolve([])),
    mcp: async () => {
      const [status, connectors] = await Promise.all([
        klausApi.mcp?.sessionStatus
          ? klausApi.mcp.sessionStatus(window.currentSessionId || undefined, selectedProjectWorkdir() || undefined)
          : Promise.resolve(null),
        klausApi.connectors?.list ? klausApi.connectors.list() : Promise.resolve([]),
      ])
      if (status?.ok === false || status?.error) throw new Error(status?.error || tt('composer_load_failed'))
      if (!Array.isArray(connectors)) throw new Error(connectors?.error || tt('composer_load_failed'))
      const mcpWorkdir = selectedProjectWorkdir()
      const projectStatus = normalizeProjectMcpData(status, mcpWorkdir || '')
      if (!projectStatus) throw new Error(tt('composer_load_failed'))
      return [
        ...projectStatus.servers
          .filter((s: { scope?: string }) => mcpWorkdir || (s.scope !== 'project' && s.scope !== 'local')),
        ...(Array.isArray(connectors) ? connectors : [])
          .filter((c) => c.enabled)
          .map((c) => ({ name: c.name || c.id, transport: 'connector', status: 'connected' })),
      ]
    },
    slashCommands: async options => (await fetchSlashCommands({ ...options, strict: true })).filter(isStandaloneSlashCommand),
  },
  actions: {
    icons: COMPOSER_PLUS_ICONS,
    selectReference: reference => {
      hideComposerPlusMenu()
      insertComposerReferenceToken(reference)
      focusComposerInputAfterSlashInsert()
    },
    selectCommand: (command) => selectComposerCommand(command),
    openSkillsView: () => document.getElementById('btn-skills')?.click(),
    openPluginsView: () => document.getElementById('btn-plugins')?.click(),
    openMcpView: () => document.getElementById('btn-mcp')?.click(),
    pickFile: () => fileInput?.click(),
    getSpecEnabled: () => composerSpecEnabled,
    refreshSpecEnabled: () => refreshComposerSpecEnabled(),
    toggleSpecEnabled: () => toggleComposerSpecEnabled(),
    getGoalEnabled: () => composerGoalEnabled,
    isGoalAvailable: composerGoalEligible,
    toggleGoalEnabled: () => toggleComposerGoalEnabled(),
    onOpen: () => { hideSlashMenu() },
  },
})

async function refreshSelectedSlashCommand() {
  const selected = selectedSlashCommand
  if (!selected || !isValidSlashCommandRange(selectedSlashCommandRange)) return
  const scope = slashCatalogScope()
  let commands: SlashCommandInfo[]
  try { commands = await fetchSlashCommands({ strict: true }) } catch { return }
  if (scope !== slashCatalogScope() || selected !== selectedSlashCommand
    || !isValidSlashCommandRange(selectedSlashCommandRange)) return
  const command = commands.find(entry => slashCommandCacheKey(entry.name) === slashCommandCacheKey(selected.name))
  if (command) {
    selectedSlashCommand = command
    mainComposerControl?.refreshTokens()
    slashPlaceholderFontSig = ''
    refreshSlashCommandPlaceholderWidth()
  } else {
    // A removed command becomes editable text; the user's draft is preserved.
    const previous = inputEl.value
    const range = { ...selectedSlashCommandRange }
    const literal = `/${selected.name}`
    const next = replaceTextRange(previous, range.start, range.end, literal)
    const delta = literal.length - (range.end - range.start)
    const start = mapCaretAroundToken(inputEl.selectionStart ?? previous.length, range, delta)
    const end = mapCaretAroundToken(inputEl.selectionEnd ?? start, range, delta)
    syncComposerReferenceRanges(previous, next)
    const synced = syncInlineQuoteRanges(previous, next, inlineQuoteEntries())
    if (synced.removed.length > 0) forgetInlineQuoteEntries(synced.removed)
    selectedSlashCommand = null
    selectedSlashCommandRange = null
    if (mainComposerControl) mainComposerControl.replaceRange(range.start, range.end, literal, 'insertReplacementText')
    else setInputValue(next)
    try { inputEl.setSelectionRange(start, end) } catch {}
  }
  renderSelectedSlashCommand()
  autoResize()
  persistComposerDraft()
}

klausApi.on.skillsChanged(() => {
  invalidateComposerCatalogs()
  slashCommandCache.clear()
  slashRequestSeq++
  invalidateSkillsDataCache()
  window.dispatchEvent(new Event('klaus:skills-changed'))
  composerPlusApi?.refreshSkills()
  void refreshSelectedSlashCommand()
  if (composerMenuMode === 'slash' && !slashMenu.classList.contains('hidden')) {
    void handleSlashMenu({ refreshOnly: true })
  }
})

function openComposerPlusMenu() { composerPlusApi?.open() }

function hideComposerPlusMenu() { composerPlusApi?.close() }

async function getComposerSkills(options: { forceReload?: boolean } = {}) {
  const scope = slashCatalogScope()
  const sessionId = window.currentSessionId, root = selectedProjectWorkdir() || undefined
  const [dependencies, projectCommands] = await Promise.all([
    composerSkillCatalog.load(scope, async () => {
      const [installed, builtin] = await Promise.all([
        klausApi.skills?.list ? klausApi.skills.list() : Promise.resolve([]),
        klausApi.skills?.builtin ? klausApi.skills.builtin() : Promise.resolve([]),
      ])
      const builtinError = unpackBuiltinSkillsReply(builtin).error
      if (!Array.isArray(installed) || builtinError) throw new Error(builtinError || tt('composer_load_failed'))
      return { installed, builtin }
    }, options),
    slashCatalog.load(scope, () => loadScopedSlashCommands(sessionId, root, { ...options, strict: true }), options),
  ])
  if (scope !== slashCatalogScope()) throw new StaleSlashCatalogRequest()
  // 宿主 skills:builtin 返回 { items, error } 对象（引擎查询失败时 items 仍带
  // 兜底条目），解包与合并语义在 composer-skills 纯函数里，两形态都容忍。
  return selectComposerSkillRows({
    ...dependencies,
    projectCommands,
    loadFailedMessage: tt('composer_load_failed'),
  })
}

function selectComposerCommand(command: SlashCommandInfo) {
  hideComposerPlusMenu()
  if (isManualCompactCommand(command)) { void activateMainManualCompact(currentSlashTrigger()); return }
  if (isApprovalReviewShortcut(command)) { activateComposerApprovalReviewShortcut(null); return }
  if (isGoalShortcut(command)) { void activateComposerGoalShortcut(null); return }
  if (isPlanShortcut(command)) { void activateComposerPlanShortcut(null); return }
  insertSlashCommandToken(command, null)
  focusComposerInputAfterSlashInsert()
}

async function activateComposerGoalShortcut(range: { start: number; end: number } | null) {
  const activated = await activateGoalShortcut({
    sessionId: () => window.currentSessionId,
    enabled: () => composerGoalEnabled,
    enable: () => toggleComposerGoalEnabled(true),
    interactionToken: () => goalInteractions.token(window.currentSessionId),
    readDraft: () => inputEl.value,
    replaceDraft: (value, caret) => {
      syncComposerReferenceRanges(inputEl.value, value)
      const synced = syncInlineQuoteRanges(inputEl.value, value, inlineQuoteEntries())
      if (synced.removed.length) pendingFiles = pendingFiles.filter(entry => !synced.removed.includes(entry))
      setInputValue(value)
      try { inputEl.setSelectionRange(caret, caret) } catch {}
      renderSelectedSlashCommand()
      autoResize()
      updateSendBtn()
      persistComposerDraft()
    },
  }, range)
  if (activated) focusComposerInputAfterSlashInsert()
  return activated
}

function isStandaloneSlashCommand(command: SlashCommandInfo | null | undefined) {
  return commandGroupKey(command) === 'shortcuts'
}





/**
 * Remember a session's primary workspace root, so relative paths resolve.
 *
 * This used to also flatten the whole file tree into a mention cache, but the
 * `@` picker searches through the native file index instead of reading that
 * Map — nothing consumed it, while every workspace load paid a full recursive
 * walk. The root registration is the part that is still load-bearing:
 * `workspaceRelativePath` reads it for the file preview path, the tree's
 * copy-path action, and the mention chip's label.
 */
function rememberWorkspaceRoot(sessionId: string, root: string) {
  if (sessionId && root) setWorkspaceRoot(sessionId, root)
}

/**
 * 提及候选失效。插件页每次装/卸/启停后调——不叫就只能等 TTL 过期，中间那几秒里
 * `@` 会列出一个刚卸掉的插件。菜单现读 react-query 缓存，失效走查询层。
 */
export function invalidatePluginMentionCache() {
  invalidatePluginMentions()
}

/**
 * 设备提及候选失效。设置面板改名/移除设备后调——设备在线状态漂移由短 staleTime
 * 覆盖，但用户的显式改名/移除必须立刻反映到 `@` 菜单，否则菜单会列旧名字。
 */
export function invalidateDeviceMentionCache() {
  invalidateDeviceMentions()
}

function getWorkspaceAtTrigger() {
  const query = currentComposerQuery()
  return query?.prefix === '@' ? query : null
}

/**
 * Detect the `@` trigger and hand the menu its intent. This is synchronous and
 * does no fetching: the component owns the queries and renders local groups on
 * the first frame while remote groups fill in, so there is no await here and no
 * request-sequence race to guard. The menu closing on "nothing to show" is the
 * component's `onMentionMenuEmpty` callback, fired once every group has settled.
 */
function handleWorkspaceMentionMenu() {
  const trigger = getWorkspaceAtTrigger()
  if (!trigger) {
    if (composerMenuMode === 'workspace') hideSlashMenu()
    return
  }
  showWorkspaceMentionMenu(trigger)
}

function showWorkspaceMentionMenu(trigger: { start: number; end: number; query?: string }) {
  hideComposerPlusMenu()
  claimOverlay('slash-menu')
  composerMenuMode = 'workspace'
  workspaceAtTrigger = trigger
  slashMenuApi?.showMention({
    query: trigger.query ?? '',
    scope: workspaceMentionScope,
    sessionId: window.currentSessionId,
    root: window.currentSessionId ? undefined : draftProjectWorkdir() ?? undefined,
  })
}

/** Open the selected workspace without creating a conversation for discovery. */
function openWorkspaceFileSearchSession(sessionId: string | null, root?: string): WorkspaceFileSearchSession | null {
  if (!sessionId && !root) return null
  return new WorkspaceFileSearchSession(klausApi.engine, sessionId, root)
}

/**
 * Enter or leave a @-menu category (files / folders).
 *
 * Entering replaces the trigger's query with a bare `@`: the query the user
 * typed was matching category names, not paths, and carrying it into the
 * search level would filter every path by it. Leaving (Escape) does the
 * reverse, restoring the category level with an empty query.
 */
function setWorkspaceMentionScope(scope: 'files' | 'folders' | null) {
  const trigger = workspaceAtTrigger || getWorkspaceAtTrigger()
  workspaceMentionScope = scope
  if (trigger) {
    const value = inputEl.value || ''
    const cursor = inputEl.selectionStart ?? trigger.end
    const start = Math.max(0, Math.min(trigger.start, value.length))
    const end = Math.max(start, Math.min(cursor, value.length))
    const next = value.slice(0, start) + '@' + value.slice(end)
    syncComposerTokenRangesAfterInput(value, next)
    setInputValue(next)
    try { inputEl.setSelectionRange(start + 1, start + 1) } catch {}
  }
  inputEl.dispatchEvent(new Event('input'))
  inputEl.focus()
}

function selectWorkspaceMentionItem(entry: MentionEntry, intent: 'insert' | 'complete' = 'insert') {
  const trigger = getWorkspaceAtTrigger()
  if (!trigger || workspaceAtTrigger && (trigger.start !== workspaceAtTrigger.start || trigger.end !== workspaceAtTrigger.end)) {
    hideSlashMenu()
    return
  }
  // A category row is navigation, not a mention: entering it clears the query
  // the user typed to find the category (it was matching category names, not
  // paths) and refills the menu with that kind's search results.
  if (entry.kind === 'category' && entry.category) {
    setWorkspaceMentionScope(entry.category)
    return
  }
  if (intent === 'complete' && entry.isDir) {
    const path = /[\\/]$/.test(entry.rel) ? entry.rel : `${entry.rel}/`
    mainComposerControl?.continueQuery('@', trigger.start)
    if (mainComposerControl) mainComposerControl.replaceRange(trigger.start + 1, trigger.end, path, 'insertReplacementText')
    else {
      setInputValue(inputEl.value.slice(0, trigger.start + 1) + path + inputEl.value.slice(trigger.end))
      inputEl.setSelectionRange(trigger.start + 1 + path.length, trigger.start + 1 + path.length)
      inputEl.dispatchEvent(new Event('input'))
    }
    inputEl.focus()
    return
  }
  if (entry.kind === 'browser-tab' && entry.browserTab) {
    if (trigger) {
      const value = inputEl.value || ''
      const cursor = trigger.end
      const start = Math.max(0, Math.min(trigger.start, value.length))
      const end = Math.max(start, Math.min(cursor, value.length))
      insertComposerReferenceToken(browserTabReference(entry.browserTab), { start, end })
    }
    hideSlashMenu()
    inputEl.dispatchEvent(new Event('input'))
    inputEl.focus()
    return
  }
  // Keep localized labels separate from model-facing addresses. Display metadata
  // preserves the chip, while the request text identifies the actual recipient.
  if (entry.kind === 'plugin') {
    if (trigger) {
      const value = inputEl.value || ''
      const cursor = trigger.end
      const start = Math.max(0, Math.min(trigger.start, value.length))
      const end = Math.max(start, Math.min(cursor, value.length))
      insertComposerReferenceToken(resourceReference('plugin', entry.name, entry.path || entry.name), { start, end })
    }
    hideSlashMenu()
    inputEl.dispatchEvent(new Event('input'))
    inputEl.focus()
    return
  }
  if (entry.kind === 'friend' && entry.friendId) {
    if (trigger) {
      const value = inputEl.value || ''
      const cursor = trigger.end
      const start = Math.max(0, Math.min(trigger.start, value.length))
      const end = Math.max(start, Math.min(cursor, value.length))
      insertComposerReferenceToken({ kind: 'friend', name: entry.name, value: friendMentionValue(entry.friendId), id: entry.friendId }, { start, end })
    }
    hideSlashMenu()
    inputEl.dispatchEvent(new Event('input'))
    inputEl.focus()
    return
  }
  if (entry.kind === 'device' && entry.deviceId) {
    if (trigger) {
      const value = inputEl.value || ''
      const cursor = trigger.end
      const start = Math.max(0, Math.min(trigger.start, value.length))
      const end = Math.max(start, Math.min(cursor, value.length))
      insertComposerReferenceToken({
        kind: 'device',
        name: entry.name,
        // Same shape as the agent chip: the model-facing address is the
        // token's own text (a placeholder run under the visible chip), so the
        // host can lift it straight out of the request.
        value: `@device-${entry.deviceId}`,
        id: entry.deviceId,
      }, { start, end })
    }
    hideSlashMenu()
    inputEl.dispatchEvent(new Event('input'))
    inputEl.focus()
    return
  }
  if (entry.kind === 'conversation' && entry.conversationId) {
    if (trigger) {
      const value = inputEl.value || ''
      const cursor = trigger.end
      const start = Math.max(0, Math.min(trigger.start, value.length))
      const end = Math.max(start, Math.min(cursor, value.length))
      insertComposerReferenceToken({
        kind: 'conversation',
        name: entry.name,
        // A conversation mention is serialized as a Markdown link; ours
        // points at the local conversation so the host can lift the id back
        // out and tell the model how to read or message that conversation.
        value: `[${entry.name}](klaus:conversation/${entry.conversationId})`,
        id: entry.conversationId,
      }, { start, end })
    }
    hideSlashMenu()
    inputEl.dispatchEvent(new Event('input'))
    inputEl.focus()
    return
  }
  addWorkspaceComposerMention(entry, trigger)
  hideSlashMenu()
  inputEl.dispatchEvent(new Event('input'))
  inputEl.focus()
}

document.addEventListener('click', (e) => {
  if (slashMenu.classList.contains('hidden')) return
  if (slashMenu.contains(e.target as Node) || inputEl.contains(e.target as Node)) return
  hideSlashMenu(true)
}, true)

// File citation chips outside the transcript containers (composer follow-up
// previews, plan review documents) have no container delegate of their own;
// the transcript's own handler stops propagation first, so a chip inside a
// transcript never reaches this catch-all twice.
document.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement | null)?.closest?.('.md-file-citation') as HTMLElement | null
  if (chip) openFileCitationFromElement(chip)
})

btnComposerPlus?.setAttribute('aria-haspopup', 'menu')
btnComposerPlus?.setAttribute('aria-expanded', 'false')
btnComposerPlus?.addEventListener('click', (e) => {
  e.stopPropagation()
  isComposerPlusOpen() ? hideComposerPlusMenu() : openComposerPlusMenu()
})

// ==================== Message rendering ====================

const fileSvg = klausIcon('file-2')
const imgSvg = klausIcon('img')

const INTERRUPT_MARKER_RE = /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/

function isInterruptMarkerText(text: string) {
  return typeof text === 'string' && INTERRUPT_MARKER_RE.test(text)
}

// ==================== 套路 5: fork boilerplate 折叠 ====================
//
// fork 出来的 sub-agent 第一条 user message 由 forkSubagent.buildForkedMessages
// 写入，结构：
//   <fork-boilerplate>
//   STOP. READ THIS FIRST. ... [一大段 fork 协议规则文本]
//   </fork-boilerplate>
//
//   Your directive: <用户实际指令>
//
// 直接展示会刷屏几百行 fork 协议文本。这里折叠成单行 pill，只突出 directive；
// 点 pill 展开看完整 boilerplate。
const FORK_BOILERPLATE_RE = /<fork-boilerplate>([\s\S]*?)<\/fork-boilerplate>\s*([\s\S]*)/

// ==================== 套路 4: teammate 消息渲染 ====================
//
// 引擎的 inbox 轮询把每条 SendMessage 包装成 <teammate-message ...>...</teammate-message>
// XML 块注入主对话 user message 流。一条 user message 可能含多个 teammate-message
// 块（同 poll 周期内多 sender 合并）。这里逐块解析 + 渲染。
//
// teammate 内容如果是 JSON 且 type 命中 plan_approval / shutdown 等结构化消息，
// 走特化卡片样式（边框颜色按 plan_approval / shutdown 的语义）。
// 普通文本则走 markdown 渲染。
const TEAMMATE_MSG_RE = /<teammate-message\s+([^>]*?)>([\s\S]*?)<\/teammate-message>/g

// 通用 teammate 卡片（plan/shutdown/task_completed 复用）。variant 决定边框颜色。
function buildTeammateCard({ variant, color, teammateName, title, bodyHtml }: { variant: string; color?: string; teammateName?: string; title?: string; bodyHtml?: string }) {
  const card = document.createElement('div')
  card.className = 'teammate-card variant-' + variant
  card.style.setProperty('--teammate-color', color ?? null)
  card.innerHTML = `
    <div class="teammate-card-header">
      <span class="teammate-dot" style="background:${color};border-color:${color}"></span>
      <span class="teammate-name">@${escapeHtml(teammateName)}</span>
      <span class="teammate-card-title">${escapeHtml(title)}</span>
    </div>
    ${bodyHtml ? `<div class="teammate-card-body">${bodyHtml}</div>` : ''}
  `
  return card
}

// --- Thinking 函数全部迁移到 thinkingUI 单例对象（定义在文件顶部） ---

// 丢弃挂起的绘制（会话切换/重置时调，防止排期回调画进新会话 DOM）。
function cancelStreamPaint(surface = activeRenderSurface) {
  if (!surface.stream.paintRaf) return
  cancelAnimationFrame(surface.stream.paintRaf)
  surface.stream.paintRaf = 0
}
// klaus 引擎本回合用量/停止原因的轻量展示位。挂到本轮最后一段 assistant 的
// 操作栏(与时间/复制同行),复用 .msg-time 小字风格。turn.completed
// 带 usage 时才会调用此函数。明细放进 title 悬浮,行内只露关键数字。
const TURN_STOP_REASON_LABELS = {
  zh: {
    max_tokens: '已达输出上限', length: '已达输出上限',
    stop_sequence: '命中停止序列', content_filter: '内容过滤拦截',
    refusal: '模型拒答', pause_turn: '回合暂停', error: '异常结束',
    turn_limit_exhausted: '已达轮次上限，本回合结束', spend_limit_exhausted: '已达花费上限，本回合结束',
  },
  en: {
    max_tokens: 'Output limit reached', length: 'Output limit reached',
    stop_sequence: 'Stop sequence hit', content_filter: 'Content filtered',
    refusal: 'Refused', pause_turn: 'Turn paused', error: 'Errored',
    turn_limit_exhausted: 'Turn limit reached, turn ended', spend_limit_exhausted: 'Spend limit reached, turn ended',
  },
}
// 正常收尾的 stopReason 不打扰用户,只有异常/截断才在行内提示。
const TURN_STOP_REASON_NORMAL = new Set(['end_turn', 'stop', 'complete', 'tool_use', 'completed', ''])

// ==================== 轮次中间过程折叠 ====================
// 一轮结束后（done/interrupted，或历史回放里已完成的轮次），把该轮的中间
// 过程 —— 工具卡、thinking 折叠块、被 tool_use 切开的中间 text 段 —— 收进
// 一行「已处理 N 个操作」摘要，点击展开还原。本轮最后一段 assistant 正文
// 保留在折叠区外；权限卡/追问卡/plan 卡/错误组/teammate 消息等一律不折。

// Fold only assistant prose. Capability cards, file cards and system notices
// never count as intermediate text.
function isTurnFoldText(el: HTMLElement) {
  const cls = el.classList
  if (!cls?.contains('msg-group') || !cls.contains('assistant') || cls.contains('capability-group')) return false
  return !!el.querySelector(':scope > .msg.assistant')
}

// ==================== Tool rendering ====================

// CC 引擎在某些工具结果里注入 <system-reminder> 给模型看（如 FileReadTool 的
// 反恶意代码提示）。后端 stringifyToolResultContent 已经过滤一次，这里是 UI
// 层的兜底，确保展示给用户的 Output 永远不会带 system-reminder。
const SYSTEM_REMINDER_RE = /\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/g
function sanitizeToolOutput(text: string) {
  if (typeof text !== 'string' || !text) return ''
  return text.replace(SYSTEM_REMINDER_RE, '').trimEnd()
}

function toolChevronSvg() {
  return klausIcon('tool-chevron')
}
function toolCheckSvg() {
  return klausIcon('tool-check')
}
function formatToolInput(args: unknown) {
  if (!args || typeof args !== 'object') return ''
  try { return JSON.stringify(args, null, 2) } catch { return String(args) }
}

// Wire up a copy button: copies the textContent of the sibling .tool-detail-pre
// or .tool-detail-fields block (whichever is present in the same .tool-detail-block).
function bindCopyButton(btn: HTMLElement) {
  btn.onclick = (ev) => {
    ev.stopPropagation()
    const block = btn.closest('.tool-detail-block')
    if (!block) return
    const src = block.querySelector('.tool-detail-pre, .tool-detail-fields')
    const text = src ? ((src as HTMLElement).dataset.copyText || src.textContent || '') : ''
    writeClipboardText(text).then(() => {
      const orig = btn.textContent
      btn.textContent = tt('copied') || 'Copied!'
      setTimeout(() => { btn.textContent = orig }, 1500)
    }).catch(() => { btn.textContent = tt('copy_failed') || 'Failed'; setTimeout(() => { btn.textContent = tt('copy') || 'Copy' }, 1500) })
  }
}

// Decide if Input args render as a structured key-value grid (专业、易扫读)
// or fall back to a JSON pre block. Grid is used when args is a plain object
// with at most 6 keys whose values are all primitives (string/number/boolean).
function shouldRenderInputAsFields(args: unknown) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const keys = Object.keys(args).filter((k) => !k.startsWith('__'))
  if (keys.length === 0 || keys.length > 6) return false
  return keys.every((k) => {
    const v = (args as Record<string, unknown>)[k]
    return v === null || ['string', 'number', 'boolean'].includes(typeof v)
  })
}

// 找到（或创建）工具卡片 detail 内的 Output 段，返回 <pre> 元素。Output 也
// 走 block + bar 结构：[输出] [N 行]   [复制] / pre
function ensureToolOutputPre(item: HTMLElement) {
  const detail = item.querySelector('.tool-item-detail')
  if (!detail) return null
  let outPre = detail.querySelector('.tool-detail-output')
  if (outPre) return outPre
  const section = document.createElement('div')
  section.className = 'tool-detail-section'
  section.innerHTML = `<div class="tool-detail-block">
    <div class="tool-detail-bar">
      <span class="tool-detail-bar-label">${escapeHtml(tt('tool_output') || 'Output')}</span>
      <span class="tool-detail-bar-meta"></span>
      <button class="tool-detail-bar-copy" type="button">${escapeHtml(tt('copy') || 'Copy')}</button>
    </div>
    <pre class="tool-detail-pre tool-detail-output"></pre>
  </div>`
  detail.appendChild(section)
  section.querySelectorAll<HTMLElement>('.tool-detail-bar-copy').forEach(bindCopyButton)
  return section.querySelector('.tool-detail-output')
}

// 更新 Output 段的 meta info（行数）。
function updateOutputMeta(outPre: HTMLElement) {
  if (!outPre) return
  const meta = outPre.parentElement?.querySelector('.tool-detail-bar-meta')
  if (!meta) return
  const text = outPre.textContent || ''
  const lines = text ? text.split('\n').length : 0
  meta.textContent = lines ? `${lines} ${tt('tool_lines') || 'lines'}` : ''
}

function capabilityDomId(prefix: string, key: string) {
  return `${prefix}-${String(key || 'current').replace(/[^A-Za-z0-9_-]/g, '_')}`
}

// ==================== File card ====================

const FILE_EXT_LABELS = { pdf:'PDF',json:'JSON',zip:'ZIP',gz:'GZ',txt:'TXT',csv:'CSV',md:'MD',html:'HTML',png:'PNG',jpg:'JPG',jpeg:'JPG',gif:'GIF',webp:'WEBP',svg:'SVG',mp3:'MP3',wav:'WAV',mp4:'MP4',py:'PY',ts:'TS',js:'JS',sh:'SH' }

// ==================== Background subagents ====================

function visibleAgentTasks(): Array<[string, AgentTask]> {
  const allTasks = tasksBySession.get(window.currentSessionId || '') || {}
  return Object.entries(allTasks).filter(([, task]) => task != null)
}

initSubagentSection({
  currentSessionId: () => window.currentSessionId || null,
  entries: visibleAgentTasks,
  onOpen: (taskId) => openSubagent(taskId),
})

/**
 * One-shot pull of session.appState.tasks snapshot from the main process.
 * Called on switchSession to seed the panel before any event arrives — the
 * subsequent `tasks_changed` events keep it in sync. Mirrors taskPanel's
 * refreshTasksForSession pattern.
 */
async function refreshAgentsForSession(sessionId: string) {
  if (!sessionId || isSessionStreamRetired(sessionId)) return
  const token = {}
  const lifetime = agentTaskLifetimes.get(sessionId) || {}
  agentTaskLifetimes.set(sessionId, lifetime)
  agentTaskLoadTokens.set(sessionId, token)
  const valid = () => agentTaskLoadTokens.get(sessionId) === token && agentTaskLifetimes.get(sessionId) === lifetime
  try {
    // Restore durable terminal rows before merging the live engine snapshot.
    try {
      const persisted = await klausApi.agents.loadTasks(sessionId)
      if (!valid()) return
      if (persisted && typeof persisted.tasks === 'object') mergeAgentTasks(sessionId, persisted.tasks)
    } catch (err) {
      if (!valid()) return
      console.warn('[agents] load-tasks failed:', err)
    }
    try {
      const res = await klausApi.agents.snapshot(sessionId)
      if (!valid()) return
      const tasks = (res && res.tasks && typeof res.tasks === 'object') ? res.tasks : {}
      autoTerminateVanishedRunningTasks(sessionId, tasks)
      mergeAgentTasks(sessionId, tasks)
    } catch (err) {
      if (!valid()) return
      console.warn('[agents] snapshot failed:', err)
    }
    await reconcileAgentTasksFromEngine(sessionId)
    if (valid() && sessionId === window.currentSessionId) renderSubagentSection()
  } finally {
    if (agentTaskLoadTokens.get(sessionId) === token) agentTaskLoadTokens.delete(sessionId)
    trimSessionStreamCache()
  }
}

// ==================== Engine-authoritative status reconcile (klaus only) ====================
// The accumulator that drives the dock can misclassify a still-running
// sub-agent as `completed` (autoTerminateVanishedRunningTasks fires whenever a
// running task's id is absent from a snapshot, and the host accumulator can
// briefly fall back to an empty set). The engine's Session.backgroundAgentSummaries()
// is the source of truth for liveness, so we pull it and let
// reconcileAgentStatus (pure, in agent-status.js) correct tasksBySession before
// the panel renders. When the engine produces no summaries the
// accumulator/autoTerminate path is the only source.
const _agentReconcilePending = new Map() // sessionId -> setTimeout handle
const _agentMissingObservations = new Map<string, Record<string, number>>()

async function reconcileAgentTasksFromEngine(sessionId: string) {
  if (!sessionId || isSessionStreamRetired(sessionId)) return false
  const lifetime = agentTaskLifetimes.get(sessionId)
  let existing = tasksBySession.get(sessionId)
  if (!existing) return false
  let agents: Array<{ id?: string; status?: string; idle?: boolean; model?: string; modelSource?: string; startedAtMs?: number | null; updatedAtMs?: number | null; completedAtMs?: number | null }>
  try {
    const res = await klausApi.agents.backgroundSummaries(sessionId)
    agents = (res && Array.isArray(res.agents)) ? res.agents : []
  } catch (err) {
    if (agentTaskLifetimes.get(sessionId) !== lifetime) return false
    console.warn('[agents] background-summaries reconcile failed:', err)
    // Detached children need their own recovery path after the parent becomes
    // idle. Failed reads retain known tasks and retry with backoff; they never
    // change the parent's turn state or sidebar indicator.
    const known = reconcileAgentRuntimeState(tasksBySession.get(sessionId), [])
    backgroundAgentPoller.retry(sessionId, known.working)
    return false
  }
  if (agentTaskLifetimes.get(sessionId) !== lifetime) return false
  existing = tasksBySession.get(sessionId)
  if (!existing) return false
  const missing = observeMissingBackgroundAgents(existing, agents, _agentMissingObservations.get(sessionId))
  if (Object.keys(missing.observations).length) _agentMissingObservations.set(sessionId, missing.observations)
  else _agentMissingObservations.delete(sessionId)
  const reconciled = reconcileAgentRuntimeState(existing, agents, missing.confirmed)
  // Reconciliation is a repair path, not the update path: while a background
  // run is live the poller calls in on a fixed cadence, and republishing an
  // unchanged snapshot would repaint the panel (and the transcript's agent
  // activity) on that cadence for no reason. Only a real difference fans out.
  const changed = !agentTasksEquivalent(existing, reconciled.tasks)
  if (changed) {
    tasksBySession.set(sessionId, reconciled.tasks)
    ingestChatEvent({ type: 'tasks_changed', sessionId, tasks: reconciled.tasks })
    notifySubagentsChanged()
    scheduleAgentTasksSave(sessionId)
    scheduleTeammateViewRefresh(sessionId)
  }
  // The live child stream is primary. Reconciliation repairs missed terminal
  // events after reconnects and also settles the same transcript store.
  backgroundAgentPoller.update(sessionId, reconciled.working)
  return changed
}

const backgroundAgentPoller = createBackgroundAgentPoller(async (sessionId) => {
  const changed = await reconcileAgentTasksFromEngine(sessionId)
  if (changed && sessionId === window.currentSessionId) renderSubagentSection()
})

// Coalesce `tasks_changed` bursts into a single engine-direct reconcile+render
// (mirrors refreshContextStatsThrottled): each burst reschedules one delayed pull.
function reconcileAgentsThrottled(sessionId: string, delay: number = 250) {
  if (!sessionId) return
  const existing = _agentReconcilePending.get(sessionId)
  if (existing) clearTimeout(existing)
  const handle = setTimeout(async () => {
    _agentReconcilePending.delete(sessionId)
    const changed = await reconcileAgentTasksFromEngine(sessionId)
    if (changed && sessionId === window.currentSessionId) renderSubagentSection()
  }, delay)
  _agentReconcilePending.set(sessionId, handle)
}

// ==================== Task list (Monitor panel ▸ Tasks section) ====================
// Surfaces TaskCreate/TaskUpdate state as a section
// inside the always-on right Monitor panel instead of as a raw-JSON tool card
// in the transcript. Engine pushes task_list events; renderer maintains a
// per-session cache and re-renders when the active session changes or its
// task list updates.

function getCurrentTasks() {
  return taskItems(window.currentSessionId)
}

// The overview describes the conversation you are looking at. An event for a
// tracked off-screen surface still drives the transcript, but it must not
// repaint the summary of a different session.
function isActiveSessionEvent(event: { sessionId?: string }): boolean {
  return !event.sessionId || event.sessionId === window.currentSessionId
}

function renderTaskPanel() {
  // Tasks are a group inside the overview's Plan section now, so an empty task
  // list hides the group and lets the section's own empty line speak once,
  // instead of every group printing its own "nothing here".
  const section = document.getElementById('monitor-section-plan')
  const group = document.getElementById('monitor-plan-group-tasks')
  const body = document.getElementById('monitor-tasks-body')
  if (!section || !group || !body) return
  const plan = taskPlanIdentity(window.currentSessionId)
  const identity = `${window.currentSessionId || ''}\u0000${chatProductContracts.taskSnapshotSource(taskPanel.metadata.get(window.currentSessionId))}\u0000${plan.planId}`
  renderPlanRows(body, identity, () => {
    // Keep the approved specification above the measured task rows.
    renderTaskPanelSpecBinding(section)
    const unavailable = taskPanel.unavailable.get(window.currentSessionId)
    if (unavailable) {
      group.hidden = false
      body.innerHTML = `<div class="task-empty task-unavailable">${escapeHtml(tt('tasks_unavailable_rust') || unavailable.notice || 'Tasks are unavailable in the Rust engine.')}</div>`
      reconcilePlanSection()
      return
    }
    const tasks = getCurrentTasks()
    if (tasks.length === 0) {
      group.hidden = true
      body.replaceChildren()
      reconcilePlanSection()
      return
    }
    // Membership and order come from the current engine plan, not task IDs.
    group.hidden = false

    body.innerHTML = ''
    for (const [index, t] of tasks.entries()) {
      // The snapshot resolves dependencies against all durable tasks, including
      // predecessors outside the current plan.
      const blocked = t.status === 'pending' && t.blockedBy.length > 0
      const row = document.createElement('div')
      row.className = 'task-row ' + t.status + (blocked ? ' blocked' : '')
      const subjectText = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject
      const subject = (subjectText || '') + (blocked ? (tt('task_blocked_suffix') || ' (blocked)') : '')
      const markHtml = t.status === 'completed'
        ? '<span class="task-mark">' + klausIcon('task-check') + '</span>'
        : '<span class="task-mark"></span>'
      const number = taskNumberLabel(t, index, plan.planKind || 'tasks')
      const numberHtml = number ? `<span class="task-id">${escapeHtml(number)}</span>` : ''
      row.innerHTML = `${markHtml}${numberHtml}<span class="task-subject">${escapeHtml(subject)}</span>`
      body.appendChild(row)
    }
    reconcilePlanSection()
  })
}

// The tasks group used to print "1 in progress · 2 pending" under its title. That
// is a second reading of the very rows below it — each one already carries its
// own state mark — and it made the tallest section in the panel start with a
// line nobody acts on. The section header's own total is the only count left.
type TaskPanelSnapshot = TaskPlanIdentity & { tasks?: unknown[]; notice?: string; version?: number; generation?: string; taskListId?: string; revision?: number; fingerprint?: string; cursor?: string | null; total?: number; status?: string }

function taskPanelMetadata(snapshot: TaskPanelSnapshot | null | undefined) {
  const generation = typeof snapshot?.generation === 'string' ? snapshot.generation : ''
  const taskListId = typeof snapshot?.taskListId === 'string' ? snapshot.taskListId : ''
  if (!generation || !taskListId) return null
  return {
    taskListId,
    generation,
    revision: Number(snapshot!.revision),
    fingerprint: typeof snapshot!.fingerprint === 'string' ? snapshot!.fingerprint : '',
    cursor: typeof snapshot!.cursor === 'string' ? snapshot!.cursor : null,
    total: Number.isFinite(Number(snapshot!.total)) ? Number(snapshot!.total) : (Array.isArray(snapshot!.tasks) ? snapshot!.tasks.length : 0),
    loaded: Array.isArray(snapshot!.tasks) ? snapshot!.tasks.length : 0,
    status: typeof snapshot!.status === 'string' ? snapshot!.status : 'current',
  }
}

function acceptTaskPanelSnapshot(sessionId: string, snapshot: TaskPanelSnapshot | null | undefined) {
  if (!sessionId) return false
  const incoming = taskPanelMetadata(snapshot)
  const current = taskPanel.metadata.get(sessionId) || null
  const decision = chatProductContracts.taskSnapshotDecision(current, incoming)
  if (!decision.accept) return false
  if (incoming) taskPanel.metadata.set(sessionId, incoming)
  else taskPanel.metadata.delete(sessionId)
  taskPanel.unavailable.delete(sessionId)
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  setTaskItems(sessionId, tasks, snapshot || {})
  if (sessionId === window.currentSessionId) renderTaskPanel()
  return true
}

async function refreshTasksForSession(sessionId: string) {
  if (!sessionId) return
  const requestId = ++taskPanel.nextRequestId
  const liveVersion = taskPanel.liveVersions.get(sessionId) || 0
  taskPanel.requestIds.set(sessionId, requestId)
  try {
    const res = await klausApi.tasks.list(sessionId)
    if (taskPanel.requestIds.get(sessionId) !== requestId) return
    if (res && res.available === false && res.code === 'rust_task_protocol_missing') {
      taskPanel.unavailable.set(sessionId, res)
      if (!hasTaskItems(sessionId)) setTaskItems(sessionId, [])
    } else {
      const liveChanged = (taskPanel.liveVersions.get(sessionId) || 0) !== liveVersion
      const currentSource = chatProductContracts.taskSnapshotSource(taskPanel.metadata.get(sessionId))
      const incomingSource = chatProductContracts.taskSnapshotSource(taskPanelMetadata(res))
      if (!liveChanged || !currentSource || currentSource === incomingSource) {
        acceptTaskPanelSnapshot(sessionId, res)
      }
    }
  } catch (err) {
    console.warn('[tasks] refresh failed:', err)
  }
  if (sessionId === window.currentSessionId) renderTaskPanel()
}

// ==================== Context window snapshot (Monitor panel ▸ Context) ====================
// Pulls the engine's context-usage analysis over IPC and renders a token bar +
// category breakdown. The IPC walks the full message buffer + estimates tokens
// for every section (system/MCP/agents/skills/memory/messages), so it's not
// free — only fetch when there's a reason to think the count moved:
//   • on session switch (initial render)
//   • after a turn ends (`done` event)
//   • after a compact boundary (auto or manual)
// All paths funnel into refreshContextStatsThrottled which debounces 250ms so
// rapid back-to-back triggers (compact_boundary + done arriving together)
// collapse into one IPC call.
interface ContextStatsSnapshot {
  tokens?: number
  maxTokens?: number
  rawMaxTokens?: number
  warning?: { isAtBlockingLimit?: boolean; isAboveErrorThreshold?: boolean; isAboveWarningThreshold?: boolean; isAboveAutoCompactThreshold?: boolean } | null
  cost?: { totalCostUsd?: number }
  [key: string]: unknown
}

const commandStateListeners = new Set<() => void>()

const ctxPanel = {
  /** Per-session cache so a session re-open doesn't re-issue the IPC if the
   *  count hasn't moved. Cleared on `done` / `compact_boundary` for that
   *  session, then refilled by the throttled fetch. */
  sessions: new Map<string, ContextStatsSnapshot>(),
  inflight: new Map(),
  pending: new Map(),
  loading: new Set(),
}

// Klaus desktop UI is a strict single-accent + grayscale system (see Tasks
// panel: every state uses --accent only, never a hue), so we collapse the
// engine's per-category hues into three semantic roles:
//   used     → real usage going through the API (System prompt, tools,
//              MCP, agents, memory, skills, messages). Accent fill.
//   reserved → autocompact / compact buffer; held back, not occupied.
//   inert    → free space (the unused window) and deferred tools (loaded
//              on demand, not currently consuming budget).
//
// IMPORTANT: judge role by name + isDeferred only. The engine reuses color keys
// across roles (e.g. 'promptBorder' tags both System prompt [used] and
// Free space [inert]; 'inactive' tags System tools [used], Autocompact
// buffer [reserved], and deferred tools [inert]) — keying off color
// silently puts huge chunks of real usage into the "inert" bucket.
const CTX_RESERVED_NAMES = new Set(['Autocompact buffer', 'Compact buffer'])
const CTX_FREE_SPACE_NAME = 'Free space'

function ctxRoleFor(category: { name?: string; isDeferred?: boolean }) {
  if (category.name === CTX_FREE_SPACE_NAME) return 'inert'
  if (CTX_RESERVED_NAMES.has(category.name || '')) return 'reserved'
  if (category.isDeferred) return 'inert'
  return 'used'
}

function formatTokens(n: number) {
  if (typeof n !== 'number' || !isFinite(n)) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

// Lookup: Klaus-style i18n labels for the engine's English category names.
// Engine emits hard-coded English strings ("Skills", "Autocompact buffer",
// "Free space", "MCP tools", ...) regardless of locale, so we localize at
// the renderer boundary. Anything not in the table renders as-is.
function ctxLocalizeCategoryName(rawName: string) {
  const t = window.tt || ((k) => undefined)
  const map = {
    'System prompt': t('context_cat_system_prompt') || 'System prompt',
    'System tools': t('context_cat_system_tools') || 'System tools',
    'MCP tools': t('context_cat_mcp_tools') || 'MCP tools',
    'MCP tools (deferred)': t('context_cat_mcp_tools_deferred') || 'MCP tools (deferred)',
    'System tools (deferred)': t('context_cat_system_tools_deferred') || 'System tools (deferred)',
    'Custom agents': t('context_cat_agents') || 'Custom agents',
    'Memory files': t('context_cat_memory') || 'Memory files',
    'Skills': t('context_cat_skills') || 'Skills',
    'Messages': t('context_cat_messages') || 'Messages',
    'Autocompact buffer': t('context_cat_autocompact_buffer') || 'Autocompact buffer',
    'Compact buffer': t('context_cat_compact_buffer') || 'Compact buffer',
    'Free space': t('context_cat_free') || 'Free space',
  }
  return (map as Record<string, string>)[rawName] || rawName
}

// Context usage uses the current session's measured usable input capacity.
function ctxPieSvg(pct: number) {
  return contextPieSvg(pct)
}

function contextUsageView(stats: ContextStatsSnapshot | undefined) {
  const tokens = stats?.tokens
  const capacity = stats?.maxTokens
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0
    || typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0) return null
  const percent = Math.min(100, Math.max(0, (tokens / capacity) * 100))
  const usage = Math.round(percent)
  return { percent, usage, usedTokens: Math.round(tokens / 1000), capacity: Math.round(capacity / 1000) }
}

function renderContextChip() {
  const chip = document.getElementById('ctx-usage-chip')
  if (!chip) return
  const usage = contextUsageView(ctxPanel.sessions.get(window.currentSessionId || ''))
  if (!window.currentSessionId || !usage) {
    chip.hidden = true
    chip.removeAttribute('aria-label')
    hideCtxPop()
    return
  }
  chip.className = 'ctx-pie-btn'
  chip.hidden = false
  chip.setAttribute('aria-label', tt('context_usage_aria').replace('{percent}', String(usage.usage)))
  const progress = chip.querySelector('.ctx-usage-progress')
  if (progress) {
    progress.setAttribute('stroke-dashoffset', String(100 - usage.percent))
    progress.setAttribute('opacity', usage.percent === 0 ? '0' : '1')
  } else {
    chip.innerHTML = ctxPieSvg(usage.percent)
  }
}

let ctxPopEl: HTMLElement | null = null
let ctxPopShowTimer: ReturnType<typeof setTimeout> | null = null

function hideCtxPop() {
  if (ctxPopShowTimer !== null) { clearTimeout(ctxPopShowTimer); ctxPopShowTimer = null }
  if (ctxPopEl) ctxPopEl.hidden = true
  document.getElementById('ctx-usage-chip')?.removeAttribute('aria-describedby')
}

function scheduleShowCtxPop() {
  if (ctxPopShowTimer !== null) clearTimeout(ctxPopShowTimer)
  ctxPopShowTimer = setTimeout(() => {
    ctxPopShowTimer = null
    showCtxPop()
  }, 200)
}

function positionCtxPop() {
  const chip = document.getElementById('ctx-usage-chip')
  if (!ctxPopEl || ctxPopEl.hidden || !chip || chip.hidden) return
  const rect = chip.getBoundingClientRect()
  const pr = ctxPopEl.getBoundingClientRect()
  const centered = rect.left + rect.width / 2 - pr.width / 2
  ctxPopEl.style.left = `${Math.max(8, Math.min(centered, window.innerWidth - pr.width - 8))}px`
  const above = rect.top - pr.height - 4
  const top = above >= 8 ? above : rect.bottom + 4
  ctxPopEl.style.top = `${Math.max(8, Math.min(top, window.innerHeight - pr.height - 8))}px`
}

function ensureCtxPop() {
  if (ctxPopEl) return ctxPopEl
  ctxPopEl = document.createElement('div')
  ctxPopEl.id = 'ctx-usage-tooltip'
  ctxPopEl.className = 'ctx-pop'
  ctxPopEl.setAttribute('role', 'tooltip')
  ctxPopEl.hidden = true
  document.body.appendChild(ctxPopEl)
  return ctxPopEl
}

function showCtxPop() {
  const chip = document.getElementById('ctx-usage-chip')
  const usage = contextUsageView(ctxPanel.sessions.get(window.currentSessionId || ''))
  if (!chip || chip.hidden || !usage) { hideCtxPop(); return }
  const pop = ensureCtxPop()
  const status = tt(usage.usage >= 50 ? 'context_usage_full' : 'context_usage_remaining')
    .replace('{usage}', String(usage.usage)).replace('{remaining}', String(100 - usage.usage))
  const tokens = tt('context_usage_tokens').replace('{usedTokens}', String(usage.usedTokens))
    .replace('{contextWindow}', String(usage.capacity))
  pop.innerHTML = `
    <div class="ctx-pop-label">${escapeHtml(tt('context_usage_label'))}</div>
    <div class="ctx-pop-status${usage.usage >= 50 ? ' ctx-pop-status-full' : ''}">${escapeHtml(status)}</div>
    <div class="ctx-pop-tokens">${escapeHtml(tokens)}</div>`
  pop.hidden = false
  chip.setAttribute('aria-describedby', pop.id)
  positionCtxPop()
}

{
  const ctxChipEl = document.getElementById('ctx-usage-chip')
  ctxChipEl?.addEventListener('mouseenter', scheduleShowCtxPop)
  ctxChipEl?.addEventListener('mouseleave', hideCtxPop)
  ctxChipEl?.addEventListener('click', hideCtxPop)
  window.addEventListener('scroll', positionCtxPop, true)
  window.addEventListener('resize', positionCtxPop)
  window.addEventListener('blur', hideCtxPop)
  window.addEventListener('klaus:lang-change', renderContextPanel)
  document.addEventListener('keydown', (event: KeyboardEvent) => { if (event.key === 'Escape') hideCtxPop() })
}

// The monitor panel's Context section was removed — the composer's
// ctx-usage-chip (with its hover pop) is the single context-usage surface.
// Keep the original name as the unified landing point for contextStats
// refreshes: it drives the chip and the derived budget banner (both must
// also cover the session-switch / no-stats branches).
function renderContextPanel() {
  refreshBudgetBanner()
  renderContextChip()
  if (ctxPopEl && !ctxPopEl.hidden) showCtxPop()
}

// 累计成本格式化：极小额显 <$0.01，<$1 保 4 位、否则 2 位。
function formatUsd(n: number) {
  if (!(n > 0)) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return '$' + n.toFixed(n < 1 ? 4 : 2)
}

// 会话花费上限 klaus.engine.maxBudgetUsd 的缓存(0/未设=不限)。随 contextStats 刷新一并更新,
// 故用户改设置后下一次刷新即生效(调高上限 → 横幅自动消失)。
let budgetCapUsd = 0

// 派生式预算横幅:当前会话累计花费 ≥ 上限时,在对话区顶部持久提示(冷会话重开只要仍超上限就再现;
// 非 toast、不随刷新消失)。横幅永远只关乎**当前**会话(单元素),故内部固定读 currentSessionId——
// 别按传入 sessionId 判,否则某个后台会话的 contextStats 刷新会误隐藏当前会话的横幅。
function refreshBudgetBanner() {
  const el = document.getElementById('budget-banner')
  if (!el) return
  const stats = ctxPanel.sessions.get(window.currentSessionId || '')
  const cost = stats?.cost?.totalCostUsd || 0
  const over = budgetCapUsd > 0 && cost >= budgetCapUsd
  if (!over) { el.hidden = true; el.textContent = ''; return }
  const zh = window.currentLang === 'zh'
  const text = zh
    ? `本会话累计花费 ${formatUsd(cost)} 已达上限 ${formatUsd(budgetCapUsd)}，新消息不会得到回复。请在设置里调高「会话花费上限」或新建会话。`
    : `This session's spend ${formatUsd(cost)} reached the cap ${formatUsd(budgetCapUsd)}; new messages won't get a reply. Raise the "Session spend cap" in settings, or start a new chat.`
  const notice = el.querySelector<HTMLDetailsElement>('.error-notice')
  const summary = notice?.querySelector('.error-notice-summary')
  const detail = notice?.querySelector('.error-notice-detail')
  if (summary && detail) {
    if (detail.textContent !== text) {
      summary.textContent = text
      detail.textContent = text
    }
  } else {
    el.innerHTML = renderErrorNoticeHtml(text)
  }
  el.hidden = false
}

async function fetchContextStats(sessionId: string) {
  if (!sessionId || isSessionStreamRetired(sessionId)) return
  if (ctxPanel.inflight.has(sessionId)) return ctxPanel.inflight.get(sessionId)
  ctxPanel.loading.add(sessionId)
  if (sessionId === window.currentSessionId) renderContextPanel()
  // cost 与上限缓存**一并 await**(Promise.all),否则冷会话打开时 refreshBudgetBanner 可能抢在上限
  // 加载完之前跑、budgetCapUsd 还是 0 → 明明超上限却不显横幅(竞态)。链进来后 finally 时两者都就位。
  const promise: Promise<ContextStatsSnapshot | null> = Promise.all([
    klausApi.engine.contextStats(sessionId).then((stats: ContextStatsSnapshot | null) => {
      if (stats && ctxPanel.inflight.get(sessionId) === promise && !isSessionStreamRetired(sessionId)) {
        ctxPanel.sessions.set(sessionId, stats)
      }
      return stats
    }),
    klausApi.settings?.kv?.get('klaus.engine.maxBudgetUsd')
      .then((v: unknown) => {
        if (ctxPanel.inflight.get(sessionId) === promise && !isSessionStreamRetired(sessionId)) budgetCapUsd = Number(v) || 0
      })
      .catch(() => {}),
  ])
    .then(([stats]) => stats)
    .catch((err: unknown) => { console.warn('[ctx] contextStats failed:', err); return null })
    .finally(() => {
      if (ctxPanel.inflight.get(sessionId) !== promise) return
      ctxPanel.inflight.delete(sessionId)
      ctxPanel.loading.delete(sessionId)
      if (sessionId === window.currentSessionId) renderContextPanel()
      for (const listener of commandStateListeners) listener()
      refreshBudgetBanner()
    })
  ctxPanel.inflight.set(sessionId, promise)
  return promise
}

function refreshContextAfterModelUpdate(sessionId: string, previous: ReturnType<typeof getSessionStream>['modelUpdate']) {
  const current = getSessionStream(sessionId).modelUpdate
  if (current?.status !== 'ready' || current.revision === undefined
    || (previous?.status === 'ready' && previous.changeId === current.changeId
      && previous.preferenceRevision === current.preferenceRevision && previous.revision === current.revision)) return
  const pending = ctxPanel.pending.get(sessionId)
  if (pending) clearTimeout(pending)
  ctxPanel.pending.delete(sessionId)
  // Retire the old read before starting another. Its response and cleanup must
  // not replace a snapshot or clear a request belonging to the new model.
  ctxPanel.inflight.delete(sessionId)
  ctxPanel.loading.delete(sessionId)
  void fetchContextStats(sessionId)
}

function refreshContextStatsThrottled(sessionId: string, delay: number = 250) {
  if (!sessionId) return
  const existing = ctxPanel.pending.get(sessionId)
  if (existing) clearTimeout(existing)
  const handle = setTimeout(() => {
    ctxPanel.pending.delete(sessionId)
    fetchContextStats(sessionId)
  }, delay)
  ctxPanel.pending.set(sessionId, handle)
}

// ==================== Manual compact (/compact slash command) ====================
// Manual and automatic compaction share stream-store status updates. The
// transcript reloads the complete saved history without hiding earlier turns.
const manualCompactController = createManualCompactController({
  isWorking: sessionId => preparingSubmissions.has(sessionId) || creatingGoalSessions.has(sessionId)
    || runningSessions.has(sessionId) || !!getSessionStream(sessionId).running
    || !!getSessionStream(sessionId).compactionPendingTrigger,
  blocked: () => showToast(tt('compact_command_busy')),
  start: sessionId => { ingestChatEvent({ type: 'compaction_start', sessionId, trigger: 'manual' }) },
  request: (sessionId, instructions) => klausApi.engine.compact(sessionId, instructions),
  failed: (sessionId, message, notice) => {
    ingestChatEvent({ type: 'compaction_end', sessionId })
    if (notice) ingestChatEvent({ type: 'notice', sessionId, content: message })
    else ingestChatEvent({ type: 'api_error', sessionId, terminal: false, error: tt('compact_failed_prefix') + message })
  },
  settled: async sessionId => {
    try { await reconcileSessionWorking(sessionId, false) }
    catch (error) { console.warn('[compact] session status refresh failed:', error) }
    refreshContextStatsThrottled(sessionId, 50)
  },
})

async function triggerCompact(customInstructions = '', explicitSessionId: string | null = null, options: { accepted?: () => void } = {}) {
  const sessionId = explicitSessionId || window.currentSessionId
  await manualCompactController.run(sessionId, customInstructions, options.accepted)
  if (sessionId && window.currentSessionId === sessionId) inputEl.focus()
}

async function activateMainManualCompact(range: { start: number; end: number } | null) {
  const sessionId = window.currentSessionId
  const value = inputEl.value
  if (!manualCompactQueryAllowed(value, range, pendingFiles.length, sessionId)) return
  await triggerCompact('', sessionId, { accepted: () => {
    if (window.currentSessionId !== sessionId || inputEl.value !== value) return
    if (range) { mainComposerControl?.replaceRange(range.start, range.end, '', 'insertReplacementText'); autoResize(); persistComposerDraft() }
  } })
}

// ==================== Workdir picker ====================
// 输入框左侧的「选择工作目录」按钮:让用户为单个会话指定 cwd,覆盖默认的
// `~/.klaus/sessions/<sessionId>/`。状态来自后端 customWorkdirCache,renderer
// 只是个壳:switchSession 时拉一次,选 / 清后再拉一次。
const btnWorkdir = document.getElementById('workdir-btn') as HTMLButtonElement | null
const workdirLabel = btnWorkdir?.querySelector<HTMLElement>('.workdir-label')
const workdirClearEl = btnWorkdir?.querySelector<HTMLElement>('.workdir-clear')

function basenameOf(path: string) {
  if (!path) return ''
  const trimmed = path.replace(/[\/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

// Workdir pill label: ssh 项目优先用注册时的友好标签（如「klaus @ dev-box」），
// 本地项目仍用目录 basename。
function workdirDisplayName(workdir: string | null) {
  if (!workdir) return ''
  if (isSshProjectWorkdir(workdir) && projectLabels[workdir]) return projectLabels[workdir]
  return basenameOf(workdir) || workdir
}

// 「运行于」pill 的显示名。选中的是多根工作区时显示工作区自己的名字，不是它第一个
// 根的目录名 —— 工作区条目用它自己的 label（`.code-workspace` 文件名
// 或文件夹名），而不是某个成员目录。这正是「明明选了工作区，pill 却
// 显示主项目」的来源。
function runTargetDisplayName(workdir: string | null, workspaceId: string | null) {
  const workspace = workspaceById(workspaceId)
  if (workspace) return workspace.name || workspaceDisplayFallbackName(workspace)
  return workdirDisplayName(workdir)
}

function workspaceDisplayFallbackName(workspace: { id: string; name: string; roots: string[] }) {
  return workdirDisplayName(workspace.roots[0] || null) || workspace.id
}

async function refreshWorkdirButton() {
  mainWindowsSandboxBanner?.refresh()
  if (!btnWorkdir || !workdirLabel || !workdirClearEl) return
  // Snapshot the session id so a rapid switchSession during the await below
  // doesn't paint stale data — same `mySeq !== switchSeq` pattern switchSession
  // uses (line ~824), simpler version since refresh has only one await.
  const id = window.currentSessionId
  if (!id) {
    const activeRoot = draftProjectWorkdir()
    const activeWorkspaceId = pendingNewChatWorkspaceId
    btnWorkdir.disabled = false
    btnWorkdir.removeAttribute('title')
    if (activeRoot || activeWorkspaceId) {
      // A workspace draft shows the workspace's own name, not its primary root.
      workdirLabel.textContent = runTargetDisplayName(activeRoot, activeWorkspaceId)
      if (activeRoot && isSshProjectWorkdir(activeRoot)) workdirLabel.setAttribute('title', activeRoot)
      else workdirLabel.removeAttribute('title')
      btnWorkdir.classList.add('has-custom')
      if (activeRoot) btnWorkdir.setAttribute('data-workdir', activeRoot)
      else btnWorkdir.removeAttribute('data-workdir')
    } else {
      // 未选项目时与 picker 里的选项同文案（「不使用项目」），而不是动作式的
      // 「选择工作目录」—— pill 展示的是当前状态。
      workdirLabel.textContent = tt('project_no_project')
      workdirLabel.removeAttribute('title')
      btnWorkdir.classList.remove('has-custom')
      btnWorkdir.removeAttribute('data-workdir')
    }
    btnWorkdir.removeAttribute('data-has-messages')
    workdirClearEl.hidden = true
    // 运行模式/分支控件在 workdir/锁定态落盘之后再刷新：它依赖
    // data-has-messages 判断可编辑性，提前读会吃到上一个会话的残留值。
    refreshComposerContextControls().catch(() => {})
    return
  }
  try {
    const { custom, hasMessages: reportedHasMessages } = await klausApi.session.getWorkdir(id)
    // Bail out if the user clicked another session while we were awaiting —
    // the response we have is for the prior session, painting it now would
    // mislabel the pill.
    if (id !== window.currentSessionId) return
    // Stash hasMessages on the DOM so click handlers can read it without
    // round-tripping a second IPC. Refreshed on every switchSession.
    const hasMessages = !!reportedHasMessages && !isDraftOnlySession(id)
    btnWorkdir.setAttribute('data-has-messages', hasMessages ? '1' : '0')
    // A friend conversation's pill names the friend, and the project picker
    // never opens for it: the friendship owns the conversation's home.
    const friendId = findKnownSession(id)?.friendGroupId
    if (friendId) {
      btnWorkdir.setAttribute('data-has-messages', '1')
      btnWorkdir.disabled = false
      btnWorkdir.removeAttribute('title')
      workdirLabel.textContent = friendDirectoryName(friendId)
      btnWorkdir.classList.add('has-custom')
      btnWorkdir.setAttribute('data-workdir', '')
      workdirClearEl.hidden = true
      refreshComposerContextControls().catch(() => {})
      return
    }
    // 锁定（已发消息）后保持可点：仍能打开「本项目 MCP」只读 popover，切项目由 openProjectPicker
    // 的只读分支挡住。clear「×」在锁定时隐藏，维持「会话中途不可清除工作目录」的原有实际行为。
    btnWorkdir.disabled = false
    btnWorkdir.removeAttribute('title')
    if (custom) {
      // A workspace-bound session's `custom` is its primary root; the pill shows the
      // workspace it actually belongs to (the group is labelled, not a member).
      workdirLabel.textContent = runTargetDisplayName(custom, findKnownSession(id)?.workspaceId ?? null)
      if (isSshProjectWorkdir(custom)) workdirLabel.setAttribute('title', custom)
      else workdirLabel.removeAttribute('title')
      btnWorkdir.classList.add('has-custom')
      btnWorkdir.setAttribute('data-workdir', custom)
      workdirClearEl.hidden = !!hasMessages
    } else {
      workdirLabel.textContent = tt('project_no_project')
      workdirLabel.removeAttribute('title')
      btnWorkdir.classList.remove('has-custom')
      btnWorkdir.removeAttribute('data-workdir')
      workdirClearEl.hidden = true
    }
  } catch (err) {
    console.warn('[workdir] refresh failed:', err)
  }
  // 同上：会话态也等 data-has-messages/workdir 刷新完再同步模式/分支控件。
  refreshComposerContextControls().catch(() => {})
}

if (btnWorkdir && workdirClearEl) {
  // Inline × inside the pill: clears the override (back to default). For
  // sessions that already produced files we ask first, since "default" maps
  // to a different directory and the user likely wants to know.
  workdirClearEl.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (!window.currentSessionId) return
    try {
      const hasMessages = btnWorkdir.getAttribute('data-has-messages') === '1'
      if (hasMessages) {
        const ok = await window.klausDialog.confirm({
          title: tt('workdir_switch_title'),
          message: tt('workdir_clear_confirm_msg'),
          confirmText: tt('workdir_switch_ok'),
        })
        if (!ok) return
      }
      await klausApi.session.clearWorkdir(window.currentSessionId)
      const clearedId = window.currentSessionId
      sessions = sessions.map((s) => s.id === clearedId ? { ...s, workdir: null } : s)
      setActiveProjectWorkdir(null, { render: false, refreshWorkdir: false })
      renderSessionList()
      await refreshWorkdirButton()
      // 后端已经吹掉 systemPrompt + context_stats 缓存,UI 上的上下文面板
      // 也得重抓,否则 token 数还停在旧 cwd 的统计上。
      if (hasMessages) refreshContextStatsThrottled(window.currentSessionId, 0)
    } catch (err) {
      console.warn('[workdir] clear failed:', err)
    }
  })
  // Keyboard a11y for the × span (since it can't be a real <button> nested
  // inside the outer button — invalid HTML). Enter / Space activate it.
  workdirClearEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      workdirClearEl.click()
    }
  })

  btnWorkdir.addEventListener('click', () => {
    openProjectPicker().catch((err: unknown) => console.warn('[projects] picker failed:', err))
  })
}

// ==================== Run context row (mode + branch) ====================
// 输入卡片上方的「运行于」行：运行目标 pill（上面的 btnWorkdir）+ 运行模式
// （本地 / Worktree）+ 分支选择器。模式与分支只在首条消息前可编辑（与
// workdir 锁定同语义）。
//
// 可见性/可用性（见 run-context.ts 的决策函数）：
// - 多根工作区没有单一「当前分支」（各 root 是独立仓库），对
//   `.code-workspace` 的处理：分支选择器整个不渲染，Worktree 选项禁用并
//   标注「当前项目暂不支持」，运行模式回落本地。
// - 非 git 目录同理：没有分支可切，就没有分支 pill（不再在 composer 里
//   引导 git init —— 那是编辑器 SCM 面的职责）。
// - 本地模式选分支：真实 checkout。有会被覆盖的未提交改动时先弹确认
//   （列出文件 + 「提交并切换分支」）。
// - Worktree 模式选分支：只记基分支草稿，不动主仓；首次发送时基于它建
//   受管 worktree（ensureRunModeWorkspaceForSend），会话落在隔离工作区。
//   分支行内嵌「包括 N 个未提交的更改」开关，随创建请求传给宿主。
const runModeSelectEl = document.getElementById('run-mode-select')
const branchBtn = document.getElementById('branch-btn')
const branchLabelEl = branchBtn?.querySelector<HTMLElement>('.branch-label')
let pendingRunMode = 'local'
let worktreeBaseBranch: string | null = null
// includeUncommitted 开关：Worktree 模式下是否把主仓未提交改动一起搬进
// 新工作树。默认开（勾选态）。
let worktreeIncludeUncommitted = true
let composerBranchState = { gitRoot: null, current: '', branches: [] }
let composerContextNonGit = false
// The last workdir whose branch probe SUCCEEDED. A later failed probe on the
// same directory keeps these known controls on screen instead of falling back
// to the "not a repository" rendering: a host stall (frozen I/O, engine
// reconnect) must not blank the draft's run-mode and branch pills.
let composerContextWorkdir: string | null = null
let composerContextRetryTimer: ReturnType<typeof setTimeout> | null = null
let composerContextRetries = 0

function clearComposerContextRetry() {
  composerContextRetries = 0
  if (composerContextRetryTimer) { clearTimeout(composerContextRetryTimer); composerContextRetryTimer = null }
}

function scheduleComposerContextRetry(workdir: string) {
  if (composerContextRetries >= 3 || composerContextRetryTimer) return
  composerContextRetries += 1
  composerContextRetryTimer = setTimeout(() => {
    composerContextRetryTimer = null
    if (composerContextWorkdir === workdir) void refreshComposerContextControls()
  }, 2000 * composerContextRetries)
}
// 未提交改动计数（含未跟踪：workingTreeChanges + indexChanges）。
let composerUncommittedCount = 0
let composerContextSeq = 0

// Run mode belongs to a conversation draft. Welcome records also retain their
// project/workspace identity so an explicit same-project return is not mistaken
// for a request to start a different draft.
const WELCOME_RUN_MODE_KEY = '__welcome__'
const SESSION_RUN_MODES_KEY = windowStateKey('klaus_session_run_modes')
const sessionRunModes: Map<string, DraftRunMode> = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_RUN_MODES_KEY) || '{}') as Record<string, DraftRunMode>
    return new Map(Object.entries(stored))
  } catch { return new Map<string, DraftRunMode>() }
})()

function persistRunModes() {
  const obj: Record<string, DraftRunMode> = {}
  for (const [k, v] of sessionRunModes) obj[k] = v
  persistLocalValue(SESSION_RUN_MODES_KEY, JSON.stringify(obj))
}

function saveRunModeForDraft(sessionId: string | null) {
  const saved: DraftRunMode = {
    mode: pendingRunMode === 'worktree' ? 'worktree' : 'local',
    baseBranch: worktreeBaseBranch,
    ...(pendingRunMode === 'worktree' ? { includeUncommitted: worktreeIncludeUncommitted } : {}),
  }
  if (!sessionId) {
    saved.workdir = normalizeProjectWorkdir(pendingNewChatWorkdir)
    saved.workspaceId = pendingNewChatWorkspaceId || null
  }
  sessionRunModes.set(sessionId ?? WELCOME_RUN_MODE_KEY, saved)
  persistRunModes()
}

function forgetRunModeForDraft(sessionId: string | null) {
  sessionRunModes.delete(sessionId ?? WELCOME_RUN_MODE_KEY)
  persistRunModes()
}

function restoreRunModeForDraft(sessionId: string | null) {
  const saved = sessionRunModes.get(sessionId ?? WELCOME_RUN_MODE_KEY)
  pendingRunMode = saved?.mode === 'worktree' ? 'worktree' : 'local'
  worktreeBaseBranch = typeof saved?.baseBranch === 'string' ? saved.baseBranch : null
  worktreeIncludeUncommitted = saved?.includeUncommitted !== false
  runModeApi?.setValue(pendingRunMode)
  renderComposerBranchLabel()
}

const RUN_MODE_LOCAL_ICON = klausIcon('run-mode-local')
// 工作树专属层级树字形（根节点分叉出两个子节点），与右侧分支选择器的
// 三节点分支字形明确区分；与项目/分支 picker 同为 path-fill 空心字形。
const RUN_MODE_WORKTREE_ICON = klausIcon('run-mode-worktree')

const runModeApi = runModeSelectEl && window.klsSelect
  ? window.klsSelect.bind(runModeSelectEl, {
      items: runModeItems(),
      value: 'local',
      onChange: (value: string) => {
        pendingRunMode = value === 'worktree' ? 'worktree' : 'local'
        // 回到本地模式时丢弃基分支草稿，分支标签回到主仓当前分支。
        if (pendingRunMode === 'local') worktreeBaseBranch = null
        renderComposerBranchLabel()
      },
    })
  : null

// 运行模式选项。Worktree 在「没有单一仓库/没有分支」的目标上禁用并给出原因
// （disabled + disabledReason）。原因按本仓
// 交互策略写在行内 description 上，不用悬停 tooltip。
function runModeItems() {
  const gate = runContextControls(composerRunContextInput())
  return [
    { value: 'local', i18nKey: 'run_mode_local', iconHtml: RUN_MODE_LOCAL_ICON },
    gate.worktreeEnabled
      ? { value: 'worktree', i18nKey: 'run_mode_worktree', iconHtml: RUN_MODE_WORKTREE_ICON }
      : {
          value: 'worktree', i18nKey: 'run_mode_worktree', iconHtml: RUN_MODE_WORKTREE_ICON,
          disabled: true, descriptionKey: gate.worktreeDisabledReasonKey || 'run_worktree_unavailable',
        },
  ]
}

function composerRunContextInput() {
  const workdir = currentEditableProjectWorkdir()
  const target: RunTargetKind = window.currentSessionId
    ? (findKnownSession(window.currentSessionId)?.workspaceId ? 'workspace' : workdir ? 'project' : 'none')
    : (pendingNewChatWorkspaceId ? 'workspace' : workdir ? 'project' : 'none')
  return { target, isGitRepo: !composerContextNonGit && !!composerBranchState.gitRoot, hasBranch: !!composerBranchState.current }
}

// 把模式选项推到已绑定的下拉上（目标变化时 Worktree 的可用性随之变化）。
function syncRunModeItems() {
  if (runContextControls(composerRunContextInput()).forceLocalMode
      && (pendingRunMode !== 'local' || worktreeBaseBranch !== null || !worktreeIncludeUncommitted)) {
    pendingRunMode = 'local'
    worktreeBaseBranch = null
    worktreeIncludeUncommitted = true
    saveRunModeForDraft(window.currentSessionId)
  }
  runModeApi?.setItems(runModeItems(), { value: pendingRunMode })
}

function composerSelectedBranch() {
  return pendingRunMode === 'worktree'
    ? (worktreeBaseBranch || composerBranchState.current)
    : composerBranchState.current
}

function renderComposerBranchLabel() {
  if (!branchBtn || !branchLabelEl) return
  // 分支 pill 只在「单根项目 + 是 git 仓库 + 有当前分支」时出现；工作区/非 git
  // 目录整体不渲染（多根工作区与无仓库目录都不给分支控件）。
  const gate = runContextControls(composerRunContextInput())
  const branch = gate.branchVisible ? composerSelectedBranch() : ''
  branchLabelEl.textContent = branch
  branchBtn.hidden = !branch
  // 按钮限宽 220px，长分支名在这里同样会被省略号截断；截断时悬停给全名。
  syncTruncatedTip(branchBtn, branchLabelEl, branch)
}

// Hide setup as soon as a submitted message owns this surface, independently
// from the draft editability needed to finish first-turn workspace preparation.
function syncComposerContextRowVisibility() {
  if (!composerContextRowEl) return
  const sessionId = window.currentSessionId
  const pending = sessionId
    ? [...pendingComposerSubmissions.values()].find(submission => submission.sessionId === sessionId)
    : visiblePendingSubmissionId ? pendingComposerSubmissions.get(visiblePendingSubmissionId) : undefined
  const streamId = sessionId || pending?.viewId
  const stream = streamId ? chatStreamStore.getState().sessions[streamId] : undefined
  const visible = runContextRowVisible({
    editable: canEditProjectForCurrentConversation(),
    pendingSubmission: !!pending,
    running: !!(stream?.running || sessionId && runningSessions.has(sessionId)),
    liveUnitCount: stream?.liveUnits.length || 0,
    history: stream?.history,
  })
  if (composerContextRowEl.hidden !== !visible) composerContextRowEl.hidden = !visible
}

// 拉取当前可编辑 workdir 的分支信息并同步模式/分支控件可见性。
// refreshWorkdirButton 的所有调用点（切会话/选项目/新对话）都会途经这里。
async function refreshComposerContextControls() {
  if (!runModeSelectEl || !branchBtn) return
  const seq = ++composerContextSeq
  const editable = canEditProjectForCurrentConversation()
  syncComposerContextRowVisibility()
  const workdir = currentEditableProjectWorkdir()
  if (!editable || !workdir || isWorktreeSessionWorkdir(workdir)) {
    clearComposerContextRetry()
    composerContextWorkdir = null
    composerContextNonGit = false
    composerBranchState = { gitRoot: null, current: '', branches: [] }
    composerUncommittedCount = 0
    if (editable) syncRunModeItems()
    runModeSelectEl.hidden = true
    branchBtn.hidden = true
    return
  }
  const res = await klausApi.git?.branches?.(workdir).catch(() => null)
  if (seq !== composerContextSeq) return
  if (!res?.ok) {
    // A directory already known to be a repository keeps its controls while a
    // bounded background retry re-probes it: a stalled probe (frozen I/O, busy
    // host) must not blank the draft's run-mode and branch pills.
    if (composerContextWorkdir === workdir) {
      scheduleComposerContextRetry(workdir)
      return
    }
    // 非 git 目录：本地模式照常可用（它不需要仓库），但 Worktree 禁用、分支 pill
    // 不出现 —— 无仓库目录就是这两件表现。首次探测失败也走这里，但会
    // 排后台重试，停顿恢复后控件自己回来。
    composerBranchState = { gitRoot: null, current: '', branches: [] }
    composerContextNonGit = true
    runModeSelectEl.hidden = false
    syncRunModeItems()
    renderComposerBranchLabel()
    scheduleComposerContextRetry(workdir)
    return
  }
  clearComposerContextRetry()
  composerContextWorkdir = workdir
  composerContextNonGit = false
  composerBranchState = {
    gitRoot: res.gitRoot || workdir,
    current: res.current || '',
    branches: Array.isArray(res.branches) ? res.branches : [],
  }
  // 空仓库（init 过、还没有提交）没有当前分支：git 把 abbrev-ref 报成字面量
  // 'HEAD'，此时既没有分支可显示，也不能据此认为存在可切的当前分支。
  if (composerBranchState.current === 'HEAD' && !composerBranchState.branches.length) composerBranchState.current = ''
  if (worktreeBaseBranch && !(composerBranchState.branches as string[]).includes(worktreeBaseBranch)) worktreeBaseBranch = null
  runModeSelectEl.hidden = false
  syncRunModeItems()
  renderComposerBranchLabel()
  // 未提交改动计数：用它标注 Worktree 的「包括 N 个未提交的更改」。
  if (!runContextControls(composerRunContextInput()).branchVisible) {
    composerUncommittedCount = 0
    renderBranchPickerIfOpen()
    return
  }
  const pending = await klausApi.git?.uncommitted?.(workdir).catch(() => null)
  if (seq !== composerContextSeq) return
  composerUncommittedCount = pending?.ok ? Number(pending.changes) || 0 : 0
  renderBranchPickerIfOpen()
}

/** 未提交改动计数变化时刷新已打开的分支面板（行内开关的文案带这个数字）。 */
function renderBranchPickerIfOpen() {
  if (branchPickerEl) renderBranchPicker()
}

// 本地模式切换分支前的未提交改动确认：
// 仅当 git 会因为未提交改动拒绝这次 checkout 时才弹；弹窗列出会被覆盖的文件，
// 并给「提交并切换分支」这条出路（提交后原样重试切换）。没有冲突时直接切。
// 返回是否应该继续执行这次切换。
async function confirmBranchSwitchWithUncommitted(branch: string): Promise<boolean> {
  const workdir = currentEditableProjectWorkdir()
  if (!workdir) return true
  const info = await klausApi.git?.uncommitted?.(workdir, branch).catch(() => null)
  if (!info?.ok || !info.files?.length) return true
  const files = (info.files as Array<{ path?: string; additions?: number; deletions?: number }>)
    .map(file => ({ path: String(file.path || ''), additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0 }))
    .filter(file => !!file.path)
  if (!files.length) return true
  const detail = files.map(file => {
    const stats = file.additions || file.deletions ? `  +${file.additions} −${file.deletions}` : ''
    return `${file.path}${stats}`
  }).join('\n')
  const ok = await window.klausDialog.confirm({
    title: tt('branch_switch_confirm_title'),
    message: tt('branch_switch_confirm_msg'),
    detail,
    confirmText: tt('branch_switch_commit_switch'),
  })
  if (!ok) return false
  // 「提交并切换」：提交范围就是这些会被覆盖的文件，提交信息由宿主旁路生成
  // （与 Diff 页同一个生成器），失败就让用户手写，绝不静默丢弃改动。
  let message = ''
  const generated = await klausApi.diff.generateCommitMessage(window.currentSessionId || '').catch(() => null)
  if (generated?.ok && generated.message) message = String(generated.message)
  const typed = await window.klausDialog.prompt!({
    title: tt('branch_switch_commit_title'),
    message: message ? tt('branch_switch_commit_hint') : tt('branch_switch_commit_prompt'),
    initialValue: message,
    confirmText: tt('branch_switch_commit_ok'),
  })
  const commitMessage = typeof typed === 'string' ? typed.trim() : ''
  if (!commitMessage) return false
  const committed = await klausApi.git.commitPaths(workdir, files.map(file => file.path), commitMessage)
    .catch((err: unknown) => ({ ok: false, error: String((err as Error | null)?.message || err) }))
  if (!committed?.ok) {
    await window.klausDialog.alert({
      title: tt('branch_switch_commit_failed'),
      message: tt('branch_switch_commit_failed_msg'),
      detail: String(committed?.error || ''),
      variant: 'error',
    })
    return false
  }
  return true
}

// 首次真实发送前的 Worktree 模式落地：以项目目录 + 选定基分支建受管
// worktree，会话工作区切到隔离目录。失败时弹窗并中止发送（输入内容保留，
// 绝不静默回退到本地目录）。成功后模式复位为 local，后续发送不重复建。
// surface 携带提前落地的会话与乐观气泡：创建是宿主侧 git 往返，可能长达
// 数十秒，气泡让这段等待在转录里可见；创建失败时由调用方回滚气泡。
async function ensureRunModeWorkspaceForSend(surface?: { sessionId: string } | null) {
  if (pendingRunMode !== 'worktree') return true
  if (!canEditProjectForCurrentConversation()) return true
  const base = currentEditableProjectWorkdir()
  if (!base || isWorktreeSessionWorkdir(base)) return true
  const baseRef = composerSelectedBranch() || undefined
  // 只有「以当前检出的 HEAD 为基」时把未提交改动搬过去才有意义；这个开关
  // 也只在 Worktree 模式下随创建请求发送。
  const includeUncommitted = worktreeIncludeUncommitted && !baseRef
  const initSessionId = surface?.sessionId || window.currentSessionId || ''
  ingestChatEvent({ type: 'worktree_init_start', sessionId: initSessionId })
  const res = await klausApi.worktree.createFromWorkdir(base, baseRef, includeUncommitted)
    .catch((err: unknown) => ({ ok: false, error: String((err as Error | null)?.message || err) }))
  if (!res?.ok) {
    ingestChatEvent({ type: 'worktree_init_failed', sessionId: initSessionId })
    if (surface && !currentPendingComposerSubmission()) retractLocalUserTurn(surface.sessionId)
    await window.klausDialog.alert({
      title: tt('worktree_create_failed'),
      message: tt('worktree_create_failed_msg'),
      detail: String(res?.error || ''),
      variant: 'error',
    })
    return false
  }
  // 绑定目标是这次发送的会话，而不是创建返回时用户恰好停留的会话：创建
  // 期间切走不应把隔离工作区挂到别的会话上。
  const bindSessionId = surface?.sessionId || window.currentSessionId
  if (!bindSessionId) {
    pendingNewChatWorkdir = res.path
    // Lock membership at creation: the draft session belongs to
    // the origin repository even though it will run inside the worktree.
    pendingNewChatProjectRoot = res.repoRoot || base
  } else {
    const set = await klausApi.session.setWorkdir(bindSessionId, res.path)
    if (set?.error) {
      ingestChatEvent({ type: 'worktree_init_failed', sessionId: initSessionId })
      if (surface && !currentPendingComposerSubmission()) retractLocalUserTurn(surface.sessionId)
      await window.klausDialog.alert(String(set.error))
      return false
    }
    sessions = sessions.map((s) => s.id === bindSessionId
      ? { ...s, workdir: res.path, projectRoot: res.repoRoot || base } : s)
  }
  pendingRunMode = 'local'
  worktreeBaseBranch = null
  runModeApi?.setValue('local')
  // A transcript row instead of a toast: the init status is a
  // persistent transcript entry, so the branch it created stays visible after
  // the moment of creation passes.
  ingestChatEvent({ type: 'worktree_init_completed', sessionId: initSessionId })
  await refreshWorkdirButton()
  return true
}

// --- 分支选择器 popover（复用 project-picker 的视觉语言）---
let branchPickerEl: HTMLElement | null = null
let branchPickerSearch = ''
let branchPickerCloseHandlers: { onPointerDown: (e: PointerEvent) => void; onKeyDown: (e: KeyboardEvent) => void; onClose: () => void } | null = null

function closeBranchPicker() {
  if (branchPickerCloseHandlers) {
    document.removeEventListener('pointerdown', branchPickerCloseHandlers.onPointerDown, true)
    document.removeEventListener('keydown', branchPickerCloseHandlers.onKeyDown, true)
    window.removeEventListener('resize', branchPickerCloseHandlers.onClose, true)
    document.removeEventListener('scroll', branchPickerCloseHandlers.onClose, true)
  }
  branchPickerCloseHandlers = null
  branchPickerEl?.remove()
  branchPickerEl = null
  branchPickerSearch = ''
  branchBtn?.classList.remove('open')
  branchBtn?.setAttribute('aria-expanded', 'false')
}

function positionBranchPicker() {
  if (!branchPickerEl || !branchBtn) return
  const rect = branchBtn.getBoundingClientRect()
  branchPickerEl.style.left = `${Math.max(8, rect.left)}px`
  branchPickerEl.style.top = `${Math.max(8, rect.bottom + 8)}px`
  requestAnimationFrame(() => {
    if (!branchPickerEl || !branchBtn) return
    const panel = branchPickerEl.getBoundingClientRect()
    const anchor = branchBtn.getBoundingClientRect()
    const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - panel.width - 8))
    const topBelow = anchor.bottom + 8
    const top = topBelow + panel.height <= window.innerHeight - 8
      ? topBelow
      : Math.max(8, anchor.top - panel.height - 8)
    branchPickerEl.style.left = `${left}px`
    branchPickerEl.style.top = `${top}px`
  })
}

function branchPickerItems() {
  const query = branchPickerSearch.trim().toLowerCase()
  const items = composerBranchState.branches
  if (!query) return items
  return items.filter((branch: string) => branch.toLowerCase().includes(query))
}

async function selectComposerBranch(branch: string) {
  if (!branch || branch === composerSelectedBranch()) return
  if (pendingRunMode === 'worktree') {
    // Worktree 模式：只记基分支草稿，不碰主仓。
    worktreeBaseBranch = branch
    renderComposerBranchLabel()
    return
  }
  // 本地模式：真实 checkout。有会被覆盖的未提交改动时先确认，
  // 用户可以选择先提交这些文件再切。
  if (!(await confirmBranchSwitchWithUncommitted(branch))) {
    await refreshComposerContextControls()
    return
  }
  const res = await klausApi.git.checkout(composerBranchState.gitRoot, branch, window.currentSessionId ? { sessionId: window.currentSessionId } : undefined)
    .catch((err: unknown) => ({ ok: false, error: String((err as Error | null)?.message || err) }))
  if (!res?.ok) {
    await window.klausDialog.alert({
      title: tt('branch_checkout_failed'),
      message: tt('branch_checkout_failed_msg'),
      detail: String(res?.error || ''),
      variant: 'error',
    })
    return
  }
  showToast(tt('branch_checked_out').replace('{branch}', branch))
  await refreshComposerContextControls()
}

async function createComposerBranch() {
  const name = await window.klausDialog.prompt!({
    title: tt('branch_create_title'),
    message: tt('branch_create_msg'),
    confirmText: tt('branch_create_ok'),
  })
  const branch = typeof name === 'string' ? name.trim() : ''
  if (!branch) return
  const res = await klausApi.git.checkout(composerBranchState.gitRoot, branch, {
    create: true,
    ...(window.currentSessionId ? { sessionId: window.currentSessionId } : {}),
  })
    .catch((err: unknown) => ({ ok: false, error: String((err as Error | null)?.message || err) }))
  if (!res?.ok) {
    await window.klausDialog.alert({
      title: tt('branch_checkout_failed'),
      message: tt('branch_checkout_failed_msg'),
      detail: String(res?.error || ''),
      variant: 'error',
    })
    return
  }
  showToast(tt('branch_checked_out').replace('{branch}', branch))
  await refreshComposerContextControls()
}

function renderBranchPicker() {
  if (!branchPickerEl) return
  const selected = composerSelectedBranch()
  const items = branchPickerItems()
  const listHtml = items.length
    ? items.map(branch => {
        // 未提交信息挂在「将成为基分支的那一行」（其 z = 选中的基分支，
        // 未显式选分支时就是当前分支）：Worktree 模式下是可点的「包括 N 个未提交
        // 的更改」，本地模式只是同位置的只读计数。
        const isBaseRow = branch === selected
        const uncommittedCount = composerUncommittedCount
        const showToggle = isBaseRow && pendingRunMode === 'worktree' && uncommittedCount > 0
        const showCount = isBaseRow && pendingRunMode !== 'worktree' && uncommittedCount > 0
        const toggleHtml = showToggle
          ? `<span class="branch-option-uncommitted branch-option-uncommitted--toggle" data-branch-toggle="uncommitted">
               <span class="branch-option-checkbox${worktreeIncludeUncommitted ? ' is-on' : ''}" role="checkbox" aria-checked="${worktreeIncludeUncommitted ? 'true' : 'false'}" tabindex="0">${projectPickerCheckIconSvg()}</span>
               <span class="branch-option-uncommitted-label">${escapeHtml(tt('branch_include_uncommitted').replace('{count}', String(uncommittedCount)))}</span>
             </span>`
          : showCount
            ? `<span class="branch-option-uncommitted">${escapeHtml(tt('branch_uncommitted_count').replace('{count}', String(uncommittedCount)))}</span>`
            : ''
        return `
        <button type="button" class="project-picker-item${branch === selected ? ' is-selected' : ''}" data-branch="${escapeHtml(branch)}">
          <span class="project-picker-icon">${projectBranchIconSvg()}</span>
          <span class="project-picker-label">${escapeHtml(branch)}</span>
          ${toggleHtml}
          ${branch === selected ? `<span class="project-picker-check">${projectPickerCheckIconSvg()}</span>` : ''}
        </button>`
      }).join('')
    : `<div class="project-picker-empty">${escapeHtml(tt('branch_picker_empty'))}</div>`
  // Worktree 模式下隐藏「新建分支」：新建需要 checkout 主仓，与隔离语义矛盾；
  // 隔离工作区自身本来就会拿到全新的 klaus/wt-* 分支。
  const createHtml = pendingRunMode === 'worktree' ? '' : `
    <div class="project-picker-separator"></div>
    <button type="button" class="project-picker-item project-picker-action" data-branch-action="create">
      <span class="project-picker-icon">${projectAddIconSvg()}</span>
      <span class="project-picker-label">${escapeHtml(tt('branch_create_new'))}</span>
    </button>`
  branchPickerEl.innerHTML = `
    <label class="project-picker-search">
      <span class="project-picker-search-icon">${projectSearchIconSvg()}</span>
      <input type="search" value="${escapeHtml(branchPickerSearch)}" placeholder="${escapeHtml(tt('branch_search_placeholder'))}" autocomplete="off">
    </label>
    <div class="project-picker-list">${listHtml}</div>
    ${createHtml}`

  // 行宽固定 264px，长分支名会被省略号截断；截断的行把全名挂到悬停提示上，
  // 没截断的行保持无提示。提示挂在整行按钮上，行内任意位置悬停都能看到。
  branchPickerEl.querySelectorAll<HTMLElement>('[data-branch]').forEach((row) => {
    const label = row.querySelector<HTMLElement>('.project-picker-label')
    if (!label) return
    syncTruncatedTip(row, label, row.getAttribute('data-branch') || '')
  })

  const input = branchPickerEl.querySelector('input')
  input?.addEventListener('input', () => {
    const caret = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length
    branchPickerSearch = input.value || ''
    renderBranchPicker()
    const nextInput = branchPickerEl?.querySelector('input')
    if (nextInput) {
      nextInput.focus()
      try { nextInput.setSelectionRange(caret, caret) } catch {}
    }
  })
  input?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeBranchPicker()
    }
  })
  branchPickerEl.querySelectorAll('[data-branch]').forEach((item) => {
    item.addEventListener('click', async () => {
      const branch = item.getAttribute('data-branch') || ''
      closeBranchPicker()
      await selectComposerBranch(branch).catch((err: unknown) => console.warn('[branch] select failed:', err))
    })
  })
  const toggle = branchPickerEl.querySelector('[data-branch-toggle="uncommitted"]')
  toggle?.addEventListener('click', (event) => {
    // 开关只管搬不搬未提交改动，不能顺带把这一行当成一次分支切换。
    event.stopPropagation()
    event.preventDefault()
    worktreeIncludeUncommitted = !worktreeIncludeUncommitted
    saveRunModeForDraft(window.currentSessionId)
    renderBranchPicker()
  })
  toggle?.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key
    if (key !== 'Enter' && key !== ' ') return
    event.stopPropagation()
    event.preventDefault()
    worktreeIncludeUncommitted = !worktreeIncludeUncommitted
    saveRunModeForDraft(window.currentSessionId)
    renderBranchPicker()
  })
  branchPickerEl.querySelector('[data-branch-action="create"]')?.addEventListener('click', async () => {
    closeBranchPicker()
    await createComposerBranch().catch((err: unknown) => console.warn('[branch] create failed:', err))
  })
}

async function openBranchPicker() {
  if (!branchBtn) return
  if (branchPickerEl) {
    closeBranchPicker()
    return
  }
  hideSlashMenu()
  hideComposerPlusMenu()
  mainModelApi?.close?.()
  // 未提交计数就画在分支行里，打开面板前先拿到它，避免先渲染 0 再跳数字。
  const workdir = currentEditableProjectWorkdir()
  if (workdir) {
    const pending = await klausApi.git?.uncommitted?.(workdir).catch(() => null)
    composerUncommittedCount = pending?.ok ? Number(pending.changes) || 0 : 0
  }
  // 非 git 目录/多根工作区没有分支控件，这个入口不会被触发；真到了这里说明没有
  // 可展示的分支，直接不打开（而不是显示一个空面板）。
  if (!composerBranchState.current) return
  branchPickerSearch = ''
  branchPickerEl = document.createElement('div')
  branchPickerEl.className = 'project-picker-popover'
  branchPickerEl.setAttribute('role', 'dialog')
  branchPickerEl.setAttribute('aria-label', tt('branch_button_title'))
  document.body.appendChild(branchPickerEl)
  branchBtn.classList.add('open')
  branchBtn.setAttribute('aria-expanded', 'true')
  renderBranchPicker()
  positionBranchPicker()
  branchPickerEl.querySelector('input')?.focus()

  const onPointerDown = (event: PointerEvent) => {
    if (branchPickerEl?.contains(event.target as Node) || branchBtn?.contains(event.target as Node)) return
    closeBranchPicker()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeBranchPicker()
  }
  const onClose = () => closeBranchPicker()
  branchPickerCloseHandlers = { onPointerDown, onKeyDown, onClose }
  setTimeout(() => {
    if (!branchPickerEl) return
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose, true)
    document.addEventListener('scroll', onClose, true)
  }, 0)
}

branchBtn?.addEventListener('click', () => {
  openBranchPicker().catch((err: unknown) => console.warn('[branch] picker failed:', err))
})

// ==================== Composer preferences ====================
const mainModelRoot = document.getElementById('main-model-select')
let mainModelApi: ModelSelectApi | null = null
let sideModelApi: ModelSelectApi | null = null

const permissionSelectRoot = document.getElementById('permission-select')
let permissionSelectApi: PermissionSelectApi | null = null
let sidePermissionApi: PermissionSelectApi | null = null

// codex 订阅模型的展示名：去掉 GPT 前缀、连字符改空格（GPT-5.6-Sol → 5.6 Sol，
// GPT-5.3-Codex-Spark → 5.3 Codex Spark）——菜单里全是同一家族，前缀是纯噪音。
// 只换展示层，value/IPC 标识不变。
function codexModelDisplayLabel(label: string) {
  const raw = String(label || '')
  const stripped = raw.replace(/^gpt[-\s]+/i, '')
  return (stripped || raw).replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
}

async function buildSessionMainModelItems(source?: string) {
  const res = await klausApi.session.getMainModelOptions(source)
  const options: ModelOption[] = Array.isArray(res?.options) ? res.options : []
  if (options.length > 0) {
    return options
      .map((option: ModelOption) => {
        const rawLabel = option.label || String(option.value || '')
        const isCodex = typeof option.value === 'string' && option.value.startsWith('codex:')
        return {
          value: String(option.value || ''),
          label: isCodex ? codexModelDisplayLabel(rawLabel) : rawLabel,
          tooltip: option.description || rawLabel,
          description: option.description,
          ...pickThinkingMetadata(option),
          ...pickFastModeMetadata(option),
          ...pickCursorModelMetadata(option),
          ...pickAntigravityModelMetadata(option),
          ...pickTraeModelMetadata(option),
          ...pickKiroModelMetadata(option),
          ...(typeof option.available === 'boolean' ? { available: option.available } : {}),
          ...(typeof option.reason === 'string' ? { reason: option.reason } : {}),
          // Catalog rows carry the gateway's credit multiplier; dropping it here
          // left the picker unable to show the official consumption figure.
          ...(typeof option.priceFactor === 'number' && Number.isFinite(option.priceFactor) ? { priceFactor: option.priceFactor } : {}),
          ...(Array.isArray(option.mediaInputMimeTypes) ? { mediaInputMimeTypes: [...option.mediaInputMimeTypes] } : {}),
        }
      })
      .filter((item) => item.value && item.value !== 'auto')
  }
  return []
}

// 透传主进程下发的 per-model 档位元数据（档位是模型属性而非全局常量）；
// 非法值在这里就地过滤。
function pickThinkingMetadata(option: ModelOption) {
  if (typeof option?.value === 'string' && option.value.startsWith('kiro:')) {
    const metadata = pickKiroModelMetadata(option), native = kiroThinkingLevel(metadata, option.value)
    return { supportedThinkingLevels: kiroThinkingLevels(metadata), ...(native ? { defaultThinkingLevel: native } : {}) }
  }
  if (typeof option?.value === 'string' && option.value.startsWith('trae:')) {
    const metadata = pickTraeModelMetadata(option), native = traeThinkingLevel(metadata, option.value)
    return { supportedThinkingLevels: traeThinkingLevels(metadata), ...(native ? { defaultThinkingLevel: native } : {}) }
  }
  const supported = Array.isArray(option?.supportedThinkingLevels)
    ? option.supportedThinkingLevels.filter(isThinkingLevelValue)
    : null
  return {
    ...(supported ? { supportedThinkingLevels: supported } : {}),
    ...(isThinkingLevelValue(option?.defaultThinkingLevel) ? { defaultThinkingLevel: option.defaultThinkingLevel } : {}),
  }
}

async function buildMainModelItems(source: string) {
  return mainModelCatalogCache.load(source)
}

async function openCurrentModelSettings(sessionId = window.currentSessionId): Promise<void> {
  try {
    await openComposerModelSettings(sessionId, openModelSettings)
  } catch (error) {
    console.warn('[composer] model source unavailable:', error)
    showToast(tt('model_catalog_unavailable'))
  }
}

async function ensureComposerModelConfigured(sessionId = window.currentSessionId): Promise<boolean> {
  return checkComposerModelConfiguration(sessionId, {
    loadItems: buildMainModelItems,
    cache: composerModelReadinessCache,
    openSettings: openModelSettings,
    onUnavailable: error => {
      console.warn('[composer] model catalog unavailable:', error)
      showToast(tt(isLikelyNetworkError(error) ? 'model_catalog_unavailable_network' : 'model_catalog_unavailable'))
    },
  })
}

// 思考档位表只有一份,在 composer/thinking-ladder.ts。这里曾经有一份同样的副本,
// 没有任何引用却要跟着一起改——xhigh 补格时它就是漏掉的那一份。

mainModelApi = mountModelSelect(mainModelRoot, {
  onEmptyClick: () => { void openCurrentModelSettings() },
  getSessionId: () => window.currentSessionId,
  onFastModeChange: invalidateComposerPreferenceReads,
})

permissionSelectApi = mountPermissionSelect(permissionSelectRoot)

type ComposerPreferencesSnapshot = {
  sessionId: string | null
  source: string
  items: MainModelItem[]
  mode: string
  unavailable: boolean
  thinkingLevel: string
  ultraMode: boolean
  fastMode: boolean
  fastModeSupported?: boolean
  fastModeBilling?: FastModeState['billing']
  permissionMode: PermissionPreset | null
  permissionAvailable?: boolean
}

let composerPreferencesSnapshot: ComposerPreferencesSnapshot | null = null
// Each conversation owns its own resolved composer state. A switch may reuse
// the state we already resolved for the target conversation, but it must never
// borrow the snapshot of the conversation that was on screen a moment earlier.
const composerPreferencesBySession = new Map<string | null, ComposerPreferencesSnapshot>()
let composerPreferencesRevision = 0
let sideComposerModelRevision = 0
let sideComposerModelScope: { sessionId: string; source: string } | null = null
function invalidateComposerPreferenceReads() {
  composerPreferencesRevision++
  sideComposerModelRevision++
  mainModelCatalogCache.invalidate()
  composerModelReadinessCache.invalidate()
}
function syncComposerInferenceStatus() {
  const mainId = window.currentSessionId
  const sideId = window.klausSideSurfaceSessionId?.()
  mainModelApi?.setRuntime(mainId ? getSessionStream(mainId) : null)
  sideModelApi?.setRuntime(sideId ? getSessionStream(sideId) : null)
}
// Successful catalogs are shared by both pickers and send preflight. Changes
// invalidate them explicitly; concurrent cold reads share one host request.
const mainModelCatalogCache = createModelCatalogCache(buildSessionMainModelItems)
const composerModelReadinessCache = createModelReadinessCache({
  loadSource: effectiveModelSource, loadItems: buildMainModelItems,
})

function applyComposerPreferences(snapshot: ComposerPreferencesSnapshot) {
  if (snapshot.sessionId) {
    const signature = JSON.stringify([snapshot.source, snapshot.mode, snapshot.thinkingLevel, snapshot.ultraMode, snapshot.fastMode, snapshot.permissionMode])
    const previous = predictionModelSelections.get(snapshot.sessionId)
    predictionModelSelections.set(snapshot.sessionId, signature)
    if (previous !== undefined && previous !== signature) {
      composerPredictions?.invalidate(snapshot.sessionId)
      void composerPredictions?.refresh()
    }
  }
  mainModelApi?.setItems(snapshot.items, {
    value: snapshot.mode,
    thinkingLevel: snapshot.thinkingLevel,
    ultraMode: snapshot.ultraMode,
    fastMode: snapshot.fastMode,
    fastModeSupported: snapshot.fastModeSupported,
    fastModeBilling: snapshot.fastModeBilling,
    unavailable: snapshot.unavailable,
  })
  permissionSelectApi?.setValue(snapshot.permissionMode)
  if (snapshot.permissionAvailable === false) permissionSelectApi?.setUnavailable()
}

// A conversation switch can reuse the model state already resolved for the
// target conversation, but only when the model rows for that source are still
// cached. Without rows the trigger must stay in its pending state; painting the
// previous conversation's rows would be worse than a short wait.
function applyCachedComposerPreferences(sessionId: string | null): boolean {
  const cached = composerPreferencesBySession.get(sessionId)
  if (!cached) return false
  const cachedItems = cached.source ? mainModelCatalogCache.get(cached.source) ?? null : null
  if (!cachedItems?.length) {
    // The model rows are gone, but this conversation's permission preset is
    // still its own. Keep that from falling back to the previous conversation
    // while the async refresh rebuilds the model rows.
    permissionSelectApi?.setValue(cached.permissionMode)
    if (cached.permissionAvailable === false) permissionSelectApi?.setUnavailable()
    return false
  }
  const hydrated = { ...cached, items: cachedItems }
  composerPreferencesSnapshot = hydrated
  applyComposerPreferences(hydrated)
  return true
}

function cacheComposerPreferences(snapshot: ComposerPreferencesSnapshot) {
  composerPreferencesBySession.set(snapshot.sessionId, snapshot)
}

function concreteStoredModel(value: string): boolean {
  return value.length > 0 && value !== 'auto'
    && !isAutomaticCursorSelection(value)
    && !(value.startsWith('kiro:') && isKiroRoutingAlias(value))
}

// The engine can resolve a stored model that is no longer in the catalog, but
// leaving the old value in the session makes every visit repeat the fallback.
// Persist the effective model on that session only, never as the remembered
// default for new conversations, and never while the turn is running.
async function reconcileUnavailableComposerModel(
  sessionId: string | null,
  source: string,
  storedMode: string,
  effectiveMode: string,
  items: MainModelItem[],
) {
  if (!sessionId || !source || !concreteStoredModel(storedMode)) return
  if (storedMode === effectiveMode) return
  if (items.some(item => item.value === storedMode)) return
  if (window.isSessionRunning?.(sessionId)) return
  try {
    await klausApi.session.setMainModel(effectiveMode, sessionId, source)
  } catch (error) {
    console.warn('[composer-preferences] unavailable model fallback save failed:', error)
  }
}

async function refreshComposerPreferences() {
  syncComposerInferenceStatus()
  const sessionId = window.currentSessionId
  const revision = ++composerPreferencesRevision
  try {
    const saved = await klausApi.session.getMainModel(sessionId, { resolve: false }).catch((error: unknown) => {
      console.warn('[composer-preferences] model selection unavailable:', error)
      return null
    })
    const source = saved?.source || ''
    if (revision !== composerPreferencesRevision || sessionId !== window.currentSessionId) return
    const cachedItems = source ? mainModelCatalogCache.get(source) ?? null : null
    if (catalogNeedsLoading(source, composerPreferencesSnapshot?.source ?? null, cachedItems)) {
      // No usable rows exist for this source yet (first paint, or the provider
      // changed with no cached catalog): show the loading state instead of the
      // preceding conversation's menu. A cached catalog keeps the picker live
      // while this refresh revalidates it below.
      mainModelApi?.setItems([], { value: '', loading: true })
    } else {
      // Seed from the cache so the trigger never flashes the empty "no models"
      // state while this refresh is still in flight. Same source keeps its
      // resolved model; a different conversation starts from ITS persisted
      // selection instead of the previous conversation's model or the catalog
      // head, so a session switch cannot paint another chat's model first.
      const snapshot = composerPreferencesSnapshot
      const seedValue = snapshot && snapshot.sessionId === sessionId && snapshot.source === source
        ? snapshot.mode
        : (mainModelMenuValue(cachedItems ?? [], saved?.mode) || cachedItems?.[0]?.value || '')
      mainModelApi?.setItems(cachedItems, { value: seedValue })
    }
    const [resolved, catalogItems, thinking, permission, fastMode, ultraMode] = await Promise.all([
      source ? klausApi.session.getMainModel(sessionId).catch(() => null) : Promise.resolve(null),
      source ? buildMainModelItems(source).catch(error => {
        console.warn('[composer-preferences] model catalog unavailable:', error)
        return null
      }) : Promise.resolve(null),
      klausApi.session.getThinkingLevel?.(sessionId).catch(() => ({ level: 'medium' })),
      klausApi.session.getPermissionMode(sessionId).catch(() => null),
      klausApi.session.getFastMode(sessionId),
      klausApi.session.getUltraMode(sessionId),
    ])
    if (revision !== composerPreferencesRevision || sessionId !== window.currentSessionId) return
    if (resolved && (resolved.source !== saved?.source || resolved.mode !== saved?.mode)) return
    if (catalogItems) composerModelReadinessCache.remember(sessionId, source, catalogItems)
    // A model catalog outage must not reset the independently read permission
    // or reasoning setting. Retain model rows only for the same selected model.
    const previousItems = composerPreferencesSnapshot
      && composerPreferencesSnapshot.sessionId === sessionId
      && composerPreferencesSnapshot.source === source
      && composerPreferencesSnapshot.mode === resolved?.resolvedMode
      ? composerPreferencesSnapshot.items
      : []
    const items = catalogItems ?? (previousItems.length ? previousItems : cachedItems ?? [])
    // A stalled resolution keeps the last resolved model on the trigger instead
    // of flipping it to "unavailable": the row list above already proves the
    // source is configured.
    const resolvedMode = typeof resolved?.resolvedMode === 'string' && resolved.resolvedMode ? resolved.resolvedMode : ''
    const snapshotAfter = composerPreferencesSnapshot
    const fallbackMode = snapshotAfter && snapshotAfter.source === source ? snapshotAfter.mode : ''
    const mode = mainModelMenuValue(items, resolvedMode || fallbackMode)
    const unavailable = !saved || (catalogItems === null && previousItems.length === 0 && !cachedItems?.length)
    const thinkingLevel = isThinkingLevelForModel(modelOptionForValue(items, mode), thinking?.level) ? thinking.level : 'medium'
    // No clamp here and no write-back. The stored level is the user's pick; the
    // picker derives what the current model will actually honor from it at
    // render time, and the engine clamps again at the request boundary. Clamping
    // in this refresh and persisting the result is what used to destroy the pick
    // (max, through a model with no ladder, came back as high for good).
    const normalizedPermission = permission ? permissionPresetFromResponse(permission)
      : composerPreferencesSnapshot?.sessionId === sessionId ? composerPreferencesSnapshot.permissionMode : null
    composerPreferencesSnapshot = { sessionId, source, items, mode, unavailable, thinkingLevel, ultraMode: ultraMode.enabled, fastMode: fastMode.enabled, fastModeSupported: fastMode.supported, fastModeBilling: fastMode.billing, permissionMode: normalizedPermission,
      permissionAvailable: permission !== null }
    cacheComposerPreferences(composerPreferencesSnapshot)
    if (catalogItems && saved?.mode) void reconcileUnavailableComposerModel(sessionId, source, saved.mode, mode, items)
    applyComposerPreferences(composerPreferencesSnapshot)
  } catch (err) {
    console.warn('[composer-preferences] refresh failed:', err)
    if (revision !== composerPreferencesRevision) return
    // Keep the last known rows for this source: a failed refresh must not blank
    // a picker the cache can still serve.
    const keep = composerPreferencesSnapshot?.sessionId === sessionId ? composerPreferencesSnapshot : null
    composerPreferencesSnapshot = keep ?? { sessionId, source: '', items: [], mode: '', unavailable: true, thinkingLevel: 'medium', ultraMode: false, fastMode: false, permissionMode: null, permissionAvailable: false }
    applyComposerPreferences(composerPreferencesSnapshot)
  }
}

async function refreshSideComposerModel() {
  syncComposerInferenceStatus()
  const sessionId = window.klausSideSurfaceSessionId?.()
  const revision = ++sideComposerModelRevision
  if (!sideModelApi || !sessionId) return
  try {
    const saved = await klausApi.session.getMainModel(sessionId, { resolve: false })
    if (revision !== sideComposerModelRevision || sessionId !== window.klausSideSurfaceSessionId?.()) return
    const cachedItems = mainModelCatalogCache.get(saved.source)
    // Seed send readiness only after reading this endpoint's persisted source.
    if (cachedItems) composerModelReadinessCache.remember(sessionId, saved.source, cachedItems)
    if (sideComposerModelScope?.sessionId !== sessionId || sideComposerModelScope.source !== saved.source) {
      sideModelApi.setItems(cachedItems || [], cachedItems ? { value: saved.mode } : { value: '', loading: true })
    }
    const [resolved, items, thinking, fastMode, permission, ultraMode] = await Promise.all([
      klausApi.session.getMainModel(sessionId),
      buildMainModelItems(saved.source),
      klausApi.session.getThinkingLevel?.(sessionId).catch(() => ({ level: 'medium' })),
      klausApi.session.getFastMode(sessionId),
      klausApi.session.getPermissionMode
        ? klausApi.session.getPermissionMode(sessionId).catch(() => null)
        : Promise.resolve(null),
      klausApi.session.getUltraMode(sessionId),
    ])
    if (revision !== sideComposerModelRevision || sessionId !== window.klausSideSurfaceSessionId?.()) return
    if (resolved.source !== saved.source || resolved.mode !== saved.mode) return
    composerModelReadinessCache.remember(sessionId, saved.source, items)
    const mode = mainModelMenuValue(items, resolved.resolvedMode)
    const thinkingLevel = isThinkingLevelForModel(modelOptionForValue(items, mode), thinking?.level) ? thinking.level : 'medium'
    // The side composer is its own conversation: its permission preset rides its
    // own stored row, never the main composer's.
    if (permission) sidePermissionApi?.setValue(permissionPresetFromResponse(permission))
    else sidePermissionApi?.setUnavailable()
    // Passed UNCLAMPED, same as the main composer: the picker derives the
    // displayed rung from the stored pick per model. Clamping here would push a
    // downgraded value into the selector's state and make it stick.
    sideComposerModelScope = { sessionId, source: saved.source }
    sideModelApi.setItems(items, { value: mode, thinkingLevel, ultraMode: ultraMode.enabled, fastMode: fastMode.enabled, fastModeSupported: fastMode.supported, fastModeBilling: fastMode.billing })
  } catch (error) {
    console.warn('[side-composer-model] refresh failed:', error)
    if (revision !== sideComposerModelRevision || sessionId !== window.klausSideSurfaceSessionId?.()) return
    sideComposerModelScope = null
    sideModelApi.setItems([], { value: '', unavailable: true })
  }
}
window.refreshComposerPreferences = refreshComposerPreferences
window.refreshPermissionButton = refreshComposerPreferences
window.refreshSidePermissionButton = refreshSideComposerModel
window.refreshSideModelButton = refreshSideComposerModel

const COMPOSER_PREFERENCE_KEYS = new Set([
  'composer.main_model',
  'composer.thinking_level',
  'composer.ultra_mode',
  'composer.codex_fast_mode',
  'composer.permission_mode',
  'klaus.approvalPolicy',
  'klaus.approvalsReviewer',
  'klaus.sandboxMode',
  'klaus.sandbox.networkAllowed',
])
// Sidebar collapse rows ride the same push as every other preference.
// Persisted-atom updates are broadcast to all windows, so a fold made in one window lands in the others. The handler re-reads the row
// and skips when the value equals local state, which absorbs the echo of this
// window's own write.
const SIDEBAR_COLLAPSE_KEYS = new Set([SIDEBAR_PROJECT_EXPANDED_KEY, SIDEBAR_SECTIONS_COLLAPSED_KEY])
klausApi.on.appPreferencesChanged?.(({ key }: { key?: string }) => {
  if (key === PREDICTIONS_ENABLED_KEY || key === PREDICTIONS_ACCEPTED_KEY) void composerPredictions?.reloadSettings()
  if (key === followUpModeHelper.FOLLOW_UP_QUEUE_MODE_KEY) void loadFollowUpQueueMode()
  if (key && (COMPOSER_PREFERENCE_KEYS.has(key) || isFastModePreferenceKey(key) || key === 'modelProviders' || key === 'auth_mode' || key.startsWith('model_tiers:'))) {
    composerPredictions?.invalidate()
    invalidateComposerPreferenceReads()
    void refreshComposerPreferences()
    void refreshSideComposerModel()
  }
  if (key && SIDEBAR_COLLAPSE_KEYS.has(key)) void applyRemoteSidebarCollapseChange(key)
  // The dragged Projects order is not a settings:kv row (it lives in the
  // workspace store so the host can reconcile it against the project registry in
  // one transaction), so it arrives under its own broadcast key.
  if (key === SIDEBAR_PROJECT_ORDER_CHANGED_KEY) void applyRemoteSidebarProjectOrder()
})
// Friend folders rename themselves when a remark or display name changes, and
// appear or disappear with the friendship's conversations.
klausApi.on.friendsChanged?.(() => {
  void refreshFriendDirectory().then(() => renderSessionList())
  // 目录申请卡只活在宿主内存里：重载后由快照重新物化，角标与侧栏等待态随之恢复。
  void klausApi.friends.pendingAccessRequests?.().then((rows: any) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const request = row as { id?: string; sessionId?: string; path?: string; access?: string; reason?: string; remember?: boolean }
      if (!request.id || !request.sessionId) continue
      const known = pendingPermissionsBySession.get(request.sessionId)?.some(req => req.requestId === request.id)
        || getSessionStream(request.sessionId).liveUnits.some(unit => 'req' in unit && (unit as { req?: { requestId?: string } }).req?.requestId === request.id)
      if (known) continue
      showPermissionRequest({ requestId: request.id, sessionId: request.sessionId, toolName: 'request_directory_access',
        toolInput: { path: request.path, access: request.access, reason: request.reason, remember: request.remember === true } })
    }
  }).catch(() => {})
})
// A conversation switch must not leave the previous conversation's model on the
// trigger while this one's persisted selection is still in flight. Clear the
// picker synchronously (the listener runs after currentSessionId changes) so
// the async read below fills in this session's model instead of overwriting a
// stale one a moment later.
function resetComposerPreferencesForSessionChange() {
  const sessionId = window.currentSessionId
  if (composerPreferencesSnapshot?.sessionId === sessionId) return
  composerPreferencesSnapshot = null
  if (!applyCachedComposerPreferences(sessionId)) {
    // No resolved state exists for this conversation yet: hold the picker in
    // its pending state instead of showing the previous conversation's model.
    mainModelApi?.setItems([], { value: '', loading: true })
  }
}
window.addEventListener('klaus:session-change', () => {
  resetComposerPreferencesForSessionChange()
  void refreshComposerPreferences()
})
void refreshComposerPreferences()


function refreshComposerSelectorTranslations() {
  mainModelApi?.refresh()
  sideModelApi?.refresh()
  permissionSelectApi?.refresh()
  sidePermissionApi?.refresh()
}

// ==================== Chat mode (auto / plan) ====================

// ==================== Events ====================

// Plays a short beep when the agent finishes or needs input while the
// user is away. Uses Web Audio so we don't ship an asset file.
function playNotifySound(kind: string) {
  try {
    const Ctx = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.value = kind === 'input' ? 660 : 880
    const now = ctx.currentTime
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32)
    osc.start(now)
    osc.stop(now + 0.34)
    osc.onended = () => { try { ctx.close() } catch {} }
  } catch {}
}
klausApi.on.notifySound?.((kind: string) => playNotifySound(kind))

// ---- Friend message arrival: unread ledger, in-app toast, badge refresh ----
// The host broadcasts every inbound friend message; the renderer decides what
// is worth surfacing. A session already open in a focused window needs nothing
// (the transcript renders the card live); everything else joins the unread
// ledger, and a focused window additionally gets one aggregated toast.
interface FriendArrivalPayload { sessionId: string; friendId: string; senderName: string; preview: string; wantReply: boolean; muted: boolean; ts: number }
const friendToastBursts = new Map<string, { count: number; ts: number; dismiss?: () => void }>()
function showFriendArrivalToast(payload: FriendArrivalPayload) {
  const now = Date.now()
  const previous = friendToastBursts.get(payload.friendId)
  const count = previous && now - previous.ts < 5000 ? previous.count + 1 : 1
  previous?.dismiss?.()
  const body = count > 1
    ? (tt('friend_notify_burst') || '{name}: {count} new messages').replace('{name}', payload.senderName).replace('{count}', String(count))
    : payload.preview
  const dismiss = showToast(body, {
    duration: 6000,
    head: { avatar: (payload.senderName || '?').trim().slice(0, 1).toUpperCase(), title: payload.senderName },
    onClick: () => { void switchSession(payload.sessionId) },
  })
  friendToastBursts.set(payload.friendId, { count, ts: now, dismiss })
}
klausApi.on.friendMessageArrived?.((payload: FriendArrivalPayload) => {
  if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId) return
  const viewing = isSessionOpenInChatView(payload.sessionId) && document.hasFocus()
  if (!viewing) {
    sharedFriendUnread().add(payload.sessionId, 1, payload.wantReply === true)
    renderSessionList()
    syncSidebarToolbar()
    syncApprovalBadge()
  }
  if (!viewing && !payload.muted && friendToastPref !== 'off' && document.hasFocus()) showFriendArrivalToast(payload)
})

// 后台 cron 失败（硬失败/超时，或软失败=chat 成功但工具报错）→ app 内即时 toast（系统通知在
// dev 模式不可靠）。点 toast 跳到该 cron 会话；并刷新侧栏拉到这条失败 run、点亮全局 badge。
klausApi.on.cronFailed?.((p: { taskId?: string; taskName?: string; sessionId?: string; detail?: string } | null) => {
  const label = (p && (p.taskName || p.taskId)) || '定时任务'
  const detail = p && p.detail ? ` — ${p.detail}` : ''
  window.showToast?.(`定时任务失败：${label}${detail}`, {
    onClick: p?.sessionId ? () => switchSession(p.sessionId!) : undefined,
    duration: 6000,
  })
  if (p && typeof window.surfaceCronRunInSidebar === 'function') {
    Promise.resolve(window.surfaceCronRunInSidebar(p.taskId)).then(updateCronNavBadge).catch(() => updateCronNavBadge())
  } else {
    updateCronNavBadge()
  }
})

// 渠道（IM）连接反复重连仍失败并永久放弃 → app 内即时 toast + 系统通知，
// 避免用户以为渠道还在工作却其实已经断开。
klausApi.on.channelFailed?.((p: { label?: string; error?: string } | null) => {
  const label = (p && p.label) || '渠道'
  const detail = p && p.error ? ` — ${p.error}` : ''
  window.showToast?.(`渠道连接失败：${label}${detail}`, { duration: 6000 })
})

// The demonstration belongs to its creating session, even after the user switches tabs.
import { createRecordingHandoff } from './recording-handoff'
klausApi.on.recordEnded?.(createRecordingHandoff({
  hasSession: sid => !!findKnownSession(sid),
  discarded: () => showToast(tt('record_skill_discarded')),
  failed: error => showToast(error),
  send: async sid => {
    const error = await submitTurnPayload(sid, buildOutgoingPayload(tt('record_skill_stopped_followup'), [], null, sid), { preserveDraft: true })
    if (error) throw new Error(error)
  },
}))

// Every chat — UI-originated and channel-originated alike — forwards its
// engine events through this single IPC. Filter by currentSessionId so only
// the active tab animates. When a `done` arrives for some other session
// (channel just finished replying in the background), refresh the sidebar and
// adopt the latest updatedAt order. Runtime audits refresh status without moving rows.
function handleChatEvent(event: ChatEvent) {
  if (event.sessionId && isSessionStreamRetired(event.sessionId)) return
  if (isStoppedTurnFrame(event)) return
  if (event.type === 'done' || event.type === 'interrupted'
      || event.type === 'api_error' && event.terminal === true) {
    if (foreignTerminalTurn(event)) return
    const stopped = getSessionStream(event.sessionId).interruptedLiveTurn
    // Confirmation already settled this turn. Its later cleanup notification
    // must not restart the Continue delay or repeat terminal side effects.
    if (event.type === 'interrupted' && stopped
        && (!event.turnId || event.turnId === stopped.turnId)) return
  }
  const previousModelUpdate = event.type === 'model_update' ? getSessionStream(event.sessionId).modelUpdate : null
  // Arm before the store sees the interrupted state. Store subscribers render
  // synchronously; arming afterward briefly exposed a clickable-looking Continue
  // button whose click handler still rejected the action during this delay.
  if (event.type === 'interrupted' && event.sessionId) {
    continueArmUntil.set(event.sessionId, Date.now() + CONTINUE_ARM_DELAY_MS)
  }
  // A Turn can start outside the main composer (channels, a newly created goal,
  // Continue). Any real run activity ends the draft-only lifecycle; activation
  // notices and attachment-upload errors deliberately do not.
  if (event.sessionId && isRunActivityEvent(event)) {
    draftOnlySessionIds.delete(event.sessionId)
    forgetRunModeForDraft(event.sessionId)
  }
  // 镜像层：全事件先进 stream store（React 侧消费面），再走既有 DOM 渲染管线。
  // userInterrupted 上下文供 api_error 卡的抑制判定（对齐下方 case 的守卫）。
  ingestChatFrameEvent(event, { userInterrupted: userInterruptedSessions.has(event.sessionId) })
  if (event.type === 'model_update') refreshContextAfterModelUpdate(event.sessionId, previousModelUpdate)
  if (event.type === 'done' && event.sessionId === window.currentSessionId && !foreignTerminalTurn(event)) {
    const turnId = typeof event.turnId === 'string' && event.turnId ? event.turnId : undefined
    void composerPredictions?.refresh(turnId ? 'live' : 'catch_up', turnId)
  }
  if (event.type === 'agent_progress' || event.type === 'agent_notification') scheduleAgentTasksSave(event.sessionId)
  if (event.sessionId) specDocuments.onEvent({ ...event, sessionId: event.sessionId })
  // Second plan input: live Task* tool calls ride the chat
  // stream, so the visible plan keeps moving mid-turn even when the
  // authoritative `task_list` push is lost. History replay never reaches this
  // handler, so a stored transcript cannot mutate the current plan, and every
  // accepted engine snapshot replaces the whole list and clears this state.
  if (event.sessionId) {
    if (event.type === 'tool_start') noteLiveTaskToolStart(event.sessionId, event.toolCallId, event.toolName || '', event.args)
    else if (event.type === 'tool_input_delta') noteLiveTaskToolInputDelta(event.sessionId, event.toolCallId, event.delta)
    else if (event.type === 'tool_end') applyLiveTaskToolEnd(event.sessionId, event.toolCallId, event.isError === true, event.content)
    else if (event.type === 'done' || event.type === 'interrupted'
        || (event.type === 'api_error' && event.terminal === true) || event.type === 'compaction_error') {
      dropLiveTaskPending(event.sessionId)
    }
  }
  // Side tasks render live in the right #artifacts-panel (side-chat mode),
  // beside the main chat. Forward every event so the panel can stream its own
  // session without the main transcript pipeline being involved.
  try { window.KlausSideTasks?.onEngineEvent?.(event) } catch (err) { console.warn('[side-task] event forward failed:', err) }
  if (event.sessionId) {
    if (event.type === 'done' || event.type === 'interrupted'
        || (event.type === 'api_error' && event.terminal === true)
        || event.type === 'compaction_error') {
      stoppingSessions.delete(event.sessionId)
      // A steer this renderer sent is hidden from the queue bar only while its
      // turn runs; once the turn ends, anything still queued was never consumed
      // and the queue bar becomes its recovery surface again.
      forgetLocallySentSteers(event.sessionId)
      // The Turn is over, so an armed Escape has nothing left to stop. Left set it
      // would make the NEXT Turn stoppable by a single stray press.
      if (stopEscArmedTurn?.sessionId === event.sessionId) clearStopEscArm()
      if (event.type === 'interrupted') window.setTimeout(updateSendBtn, CONTINUE_ARM_DELAY_MS + 20)
      // A lost `task_list` push (engine child recycle, publication race) leaves
      // the plan frozen at an old snapshot until the next session switch, so a
      // finished turn can still read "0/6". Re-pull the authoritative list once
      // the turn settles; the snapshot decision keeps any fresher push.
      void refreshTasksForSession(event.sessionId)
      if (event.type === 'done') {
        markSidebarSessionCompleted(event.sessionId)
        // The host pushes a fresh `client_queue_snapshot` after dispatching, and a
        // session switch pulls one too, so an off-screen `done` needs no polling.
      }
    } else if (isRunActivityEvent(event)) {
      // A successful Continue stays visibly pending until an engine event proves
      // that the new Turn really started. Releasing it on the IPC acknowledgement
      // reopened the button before this event and allowed duplicate empty Turns.
      continuingSessions.delete(event.sessionId)
      updateSendBtn()
      if (event.sessionId === window.currentSessionId) syncComposerContextRowVisibility()
    }
  }

  if (event.type === 'client_queue_snapshot' && event.sessionId) {
    // The host republishes the whole queue after every mutation and dispatch, so
    // this replaces the cached rows outright; the revision guard inside rejects a
    // late out-of-order push instead of reviving a deleted row.
    applyClientQueueSnapshot(event.sessionId, event)
    return
  }

  if (event.type === 'queued_follow_up_dispatched' && event.sessionId) {
    applyQueuedFollowUpDispatched(event)
    return
  }

  if (event.type === 'queue_snapshot') {
    applyEngineQueueSnapshot(event.sessionId, event)
    return
  }

  if (event.type === 'session_recency_updated') {
    void updateSessionInList({ reorder: true })
    return
  }

  // Task panel updates must be cached even for off-screen sessions so that
  // when the user switches in we can render the latest list from cache before
  // the IPC refetch resolves.
  if (event.type === 'task_list' && event.sessionId) {
    taskPanel.liveVersions.set(event.sessionId, (taskPanel.liveVersions.get(event.sessionId) || 0) + 1)
    acceptTaskPanelSnapshot(event.sessionId, event)
    return
  }

  // The engine emits this only after enter/exit Plan actually changed the live
  // mode. The shell has already persisted the same edge, so this updates the
  // visible badge immediately while session switches keep reading one source.

  if (event.type === 'follow_up_status') {
    applyFollowUpDeliveryStatus(event)
    if (event.sessionId !== window.currentSessionId) return
  }

  if (event.sessionId && event.sessionId !== window.currentSessionId && !surfacesBySession.has(event.sessionId)) {
    if (event.type === 'session_title_updated') {
      applySessionTitleUpdate(event.sessionId, event.title)
      return
    }
    // 离屏会话的转录变化已由 store 全量镜像（liveUnits/historyStale），切回时
    // React 按数据重渲；旧 sessionDom-stale/liveStreamText 机制退役。
    if (event.type === 'done') {
      userInterruptedSessions.delete(event.sessionId)
      updateSessionInList()
      // Queue dispatch and interruption pausing are the host's job: it owns the
      // durable rows, so it is the only party that can send them in order after the
      // engine's own continuation chain drains. An off-screen session's queue
      // therefore needs nothing here — the pushed snapshot carries it.
    } else if (event.type === 'tasks_changed') {
      // Keep tasksBySession up-to-date for off-screen sessions so that
      // when the user switches in, the panel hydrates from cache rather
      // than from a stale snapshot. renderSubagentSection() is intentionally
      // skipped — that session isn't visible.
      autoTerminateVanishedRunningTasks(event.sessionId, event.tasks || {})
      mergeAgentTasks(event.sessionId, event.tasks || {})
      // klaus: keep the off-screen cache authoritative too, so a later switch-in
      // paints corrected status without waiting on the refresh round-trip.
      reconcileAgentsThrottled(event.sessionId)
    } else if (event.type === 'teammate_messages') {
      // Messages captured at isIdle transition must be stored even when the
      // session is off-screen; otherwise switching back shows empty transcript.
      const { sessionId: sid, taskId, messages } = event
      if (sid && taskId && Array.isArray(messages) && messages.length) {
        const tasks = tasksBySession.get(sid)
        if (tasks && tasks[taskId]) {
          tasks[taskId] = { ...tasks[taskId], messages }
          scheduleAgentTasksSave(sid)
        }
      }
    } else if (event.type === 'permission_cancelled') {
      // Engine withdrew a pending ask while we weren't looking at that
      // session — drop it from the queued list so we don't pop a stale
      // approve/deny card the next time the user opens that session.
      untrackApprovalRequest(event.requestId)
      const list = pendingPermissionsBySession.get(event.sessionId)
      if (list) {
        const filtered = list.filter((r) => r.requestId !== event.requestId)
        if (filtered.length === 0) pendingPermissionsBySession.delete(event.sessionId)
        else pendingPermissionsBySession.set(event.sessionId, filtered)
      }
    } else if (event.type === 'elicit_cancelled') {
      // 同理：撤销后台会话里积压的追问，避免切回时弹出已失效的追问卡。
      untrackApprovalRequest(event.requestId)
      const list = pendingElicitsBySession.get(event.sessionId)
      if (list) {
        const filtered = list.filter((r) => r.requestId !== event.requestId)
        if (filtered.length === 0) pendingElicitsBySession.delete(event.sessionId)
        else pendingElicitsBySession.set(event.sessionId, filtered)
      }
      elicitRequestsById.delete(event.requestId)
    }
    return
  }

  // 渲染已全部入 store（React 消费）；这里只剩非渲染副作用，无需 surface 分发。
  switch (event.type) {
    case 'follow_up_status':
      applyFollowUpDeliveryStatus(event)
      break
    case 'user_message':
      if (friendUnreadMessages.accept(event)) markSidebarSessionCompleted(event.sessionId || '')
      // Channel-originated user turn（wechat/feishu/…）：store 已挂 live-user
      // 单元（React 渲染）；welcome 显隐由 syncMainTranscriptChrome 订阅接管。
      break
    case 'message_complete':
      // store 已标 historyStale，React 侧自动后台重拉。
      break
    case 'text_delta': break
    case 'thinking_delta': break
    case 'tool_start':
      // Monitor references 采集（live 路）：occurrenceId 去重，与回放扫描幂等。
      noteToolReference(event.sessionId || window.currentSessionId, event.toolName, event.toolCallId, event.args)
      break
    case 'tool_end': {
      // Tool results push messages onto session.messages — refresh the
      // monitor so the bar climbs as the turn does work, not just at the end.
      // Heavy throttle (1.5s) so back-to-back parallel tool returns don't
      // hammer analyzeContextUsage on the main side.
      refreshContextStatsThrottled(event.sessionId, 1500)
      if (event.sessionId === window.currentSessionId && isWorktreeSessionWorkdir(sessionWorkdir(event.sessionId))) {
        void refreshWorktreeAvailability(event.sessionId)
      }
      break
    }
    case 'workspace:changed':
    case 'workspace:invalidated':
      // Both events trigger the same debounced reload — chokidar already
      // batched at 75ms + 200ms throttle in main, so a single 100ms debounce
      // here just collapses any straggler events into one render pass.
      scheduleWorkspaceReload(event.sessionId)
      if (event.sessionId === window.currentSessionId && isWorkspaceMainActive() && selectedWorkspaceFile()) {
        const selected = selectedWorkspaceFile()
        if (!shouldSkipWorkspaceFileReloadForOwnWrite(event, selected)) {
          loadWorkspaceFile(selected, { force: true })
        }
      }
      break
    case 'tool_input_delta': break
    case 'progress': break
    case 'notice': break
    // The overview's Artifacts section owns its session record and subscribes to
    // this event directly with a debounced refetch. The diff store separately
    // reloads the project working-tree view; neither projection folds this payload.
    case 'diff_update': break
    // A completed auto-memory / auto-dream pass that touched files. Listed under
    // the references section's memory tab, which is where the memory this
    // conversation touched is reported.
    case 'memory_write':
      if (isActiveSessionEvent(event)) {
        noteMemoryWriteReference(
          event.sessionId || window.currentSessionId,
          String(event.runId || ''),
          String(event.kind || ''),
          Array.isArray(event.filesTouched) ? event.filesTouched.map(String) : [],
        )
      }
      break
    // A plugin / skill that did not run. The turn survived, so silence is
    // the only other thing that would tell the user — and the overview section
    // that used to list these is gone, so it lands in the transcript of the turn
    // it happened in. Hook failures do NOT arrive here: the host drops them at the
    // projection boundary and logs them instead; hooks are
    // managed from Settings → Hooks.
    case 'extension_failure':
      if (isActiveSessionEvent(event) && event.kind !== 'hook') {
        const kindLabel = event.kind === 'plugin'
          ? 'extension_failed_plugin'
          : 'extension_failed_skill'
        ingestChatEvent({
          type: 'notice',
          sessionId: event.sessionId || window.currentSessionId,
          content: `${tt(kindLabel)}: ${event.id}${event.message ? ' — ' + event.message : ''}`,
        })
      }
      break
    case 'tombstone':
      // store 已丢弃流式 partial（React 渲染面）。
      break
    case 'stream_mode':
      if (event.mode === 'requesting') {
        // Inbox-poller-triggered turns (teammate → leader) bypass send(), so
        // the stream store's global subscription activates interrupt mode and
        // the off-screen sidebar row on the first event of the Turn.
      }
      break
    case 'context_collapse_stats':
      // pill 渲染住 src/chat/status-bar.tsx；写入点留在 on-screen case 里保住旧过滤语义。
      noteOnScreenCollapseStats(event)
      break
    case 'api_error':
      if (event.terminal === true && !foreignTerminalTurn(event)) {
        // A provider failure is terminal but not a user interruption. The store
        // owns the failed Turn and error row; reclaim local stop intent here.
        userInterruptedSessions.delete(event.sessionId)
        stoppingSessions.delete(event.sessionId)
        if (event.sessionId === window.currentSessionId) focusComposerAfterTurn(inputEl)
        void updateSessionInList()
      }
      break
    case 'api_retry': break
    case 'auth_required': break
    // Agent / teammate panel events. tasks_changed is authoritative — it
    // carries the full sanitized appState.tasks snapshot. The legacy
    // incremental events (teammate_spawned/agent_progress/agent_done) are
    // still pushed by the engine for any consumer outside this renderer,
    // but the panel ignores them to avoid double-bookkeeping.
    case 'tasks_changed': {
      autoTerminateVanishedRunningTasks(event.sessionId, event.tasks || {})
      mergeAgentTasks(event.sessionId, event.tasks || {})
      if (event.sessionId === window.currentSessionId) {
        renderSubagentSection()
      }
      // Refresh the open child banner; its transcript consumes the shared stream.
      scheduleTeammateViewRefresh(event.sessionId)
      // klaus: sub-agent lifecycle changed → reconcile against the engine's
      // authoritative summaries and re-render (fixes false auto-terminations).
      reconcileAgentsThrottled(event.sessionId)
      break
    }
    case 'teammate_messages': {
      // Processed transcript captured just before inProcessRunner strips/evicts.
      // Store in tasksBySession so enterTeammateView can render without an IPC
      // round-trip, and trigger a sidecar save so it survives across restarts.
      const { sessionId: sid, taskId, messages } = event
      if (sid && taskId && Array.isArray(messages) && messages.length) {
        const tasks = tasksBySession.get(sid)
        if (tasks && tasks[taskId]) {
          tasks[taskId] = { ...tasks[taskId], messages }
          scheduleAgentTasksSave(sid)
          // 这份缓存就是 teammate 转录的权威面（清场后 IPC 再也拿不到）：正在看
          // 它就把这份重画上去。
          scheduleTeammateViewRefresh(sid)
        }
      }
      break
    }
    case 'teammate_spawned':
    case 'agent_progress':
    case 'agent_done':
    // A team name is a fact about the engine's teaming, not about what this
    // conversation derived: the strip shows the teammates themselves, so there
    // is nothing here to repaint for it.
    case 'team_created':
      // Advisory only — no-op for the panel (tasks_changed drives the UI).
      break
    // File
    case 'file': break
    // MCP OAuth
    case 'mcp_auth_url':
      if (event.url) {
        window.open(event.url, '_blank')
        // 提示条入 store（live-notice，与旧 appendSystemMsg 同构）。
        ingestChatEvent({ type: 'notice', sessionId: event.sessionId || window.currentSessionId, content: tt('mcp_auth_opened_prefix') + (event.serverName || tt('mcp_auth_opened_fallback')) })
      }
      break
    // Pending permission cancelled by engine (e.g., user hit Stop mid-ask).
    // store 已把卡降终态（resolveLiveApproval）；此处只回收角标与本地表。
    case 'permission_cancelled':
      untrackApprovalRequest(event.requestId)
      break
    // 引擎撤销待回答的追问（如用户在追问期间按 Stop）。
    case 'elicit_cancelled':
      untrackApprovalRequest(event.requestId)
      elicitRequestsById.delete(event.requestId)
      break
    case 'compaction_start':
      // store 已置 compactionPendingTrigger（乐观 loading pill）+ historyStale。
      break
    case 'compact_boundary':
      // store 已清 pending + 标 stale（React 重拉后呈现真 boundary/summary）。
      refreshContextStatsThrottled(event.sessionId, 50)
      break
    case 'compaction_end':
      // Legacy event — kept as a no-op for backwards compatibility. The
      // boundary event is what flips the UI.
      refreshContextStatsThrottled(event.sessionId, 50)
      break
    case 'compaction_error':
      // 压缩失败提示入 store（live-error 气泡）；loading pill 已在 ingest 早退分支撤回。
      ingestChatEvent({ type: 'api_error', sessionId: event.sessionId, error: (tt('compact_failed_prefix') || 'Compaction failed: ') + (event.error || 'unknown') })
      break
    case 'session_title_updated':
      applySessionTitleUpdate(event.sessionId, event.title)
      break
    case 'done':
      // Terminal events for a DIFFERENT turn than the one streaming are that
      // other turn's word. Their side effects (stop-intent retraction, focus, refreshes) must
      // not touch the live turn; the store's terminal branch applies the same scope guard.
      if (foreignTerminalTurn(event)) break
      userInterruptedSessions.delete(event.sessionId)
      // 渲染收尾（指示器/收口/操作栏/usage meta/轮次折叠/uuid 回填）全部由
      // store 的 done 分支与 React 渲染面接管；此处只剩非渲染副作用。
      // 预算/轮次上限收尾:引擎在发请求前就拒了本回合,可能一条 assistant 消息都没产生。用会话内
      // 持久横幅(派生自"累计花费 ≥ 上限")提示,而非一闪而过的 toast——冷会话重开只要仍超上限就再现,
      // 调高上限后自动消失。拉一次最新 cost 再刷新横幅。
      if (event.stopReason === 'turn_limit_exhausted' || event.stopReason === 'spend_limit_exhausted') {
        Promise.resolve(fetchContextStats(event.sessionId)).then(() => refreshBudgetBanner())
      }
      // Refresh the context monitor — the turn that just ended changed the
      // message buffer; throttled so back-to-back done events (rare but
      // possible across cron/external channels) collapse into one IPC.
      refreshContextStatsThrottled(event.sessionId)
      // Project workdirs intentionally do not run a native recursive watcher;
      // refresh the file tree after a turn so generated/edited files appear
      // without exhausting macOS watch descriptors.
      scheduleWorkspaceReload(event.sessionId)
      if (event.sessionId === window.currentSessionId) focusComposerAfterTurn(inputEl)
      updateSessionInList()
      window.KlausSideTasks?.refresh(event.sessionId).catch((err: unknown) => console.warn('[side-task] refresh after turn failed:', err))
      // The host dispatches the client queue after the engine's own continuation
      // chain drains, and pushes the resulting snapshot. Doing it here too would
      // send the head row a second time.
      break
    case 'interrupted':
      if (foreignTerminalTurn(event)) break
      // 用户停止是这一轮的终态：done 上那些「回合结束后仍然欠着」的副作用同样欠着。
      // 队列暂停也归宿主——它看到自己转发的这个终态（stopReason:'aborted'）就把
      // 整条队列标记为打断暂停，渲染器只消费随后推来的快照（横幅 + Resume 由
      // interrupted 标志驱动）。
      userInterruptedSessions.delete(event.sessionId)
      stoppingSessions.delete(event.sessionId)
      // 停下来之前烧掉的 token 与工具写过的文件都是真的，读数照样要刷。
      refreshContextStatsThrottled(event.sessionId)
      scheduleWorkspaceReload(event.sessionId)
      if (event.sessionId === window.currentSessionId) focusComposerAfterTurn(inputEl)
      void updateSessionInList()
      window.KlausSideTasks?.refresh(event.sessionId).catch((err: unknown) => console.warn('[side-task] refresh after interrupt failed:', err))
      if (isCronRunSession(event.sessionId)) refreshCronRunsForAllTasks()
      break
  }
}
klausApi.on.chatEvent(handleChatEvent)

klausApi.on.permissionRequest(showPermissionRequest)
klausApi.on.elicitRequest(showElicitRequest)
// 好友任务的目录申请卡走同一条审批路由：后台会话排队、角标、切回物化都复用。
klausApi.on.friendAccessRequest?.(showPermissionRequest)
klausApi.on.friendAccessResolved?.((resolution: any) => {
  const requestId = typeof resolution?.requestId === 'string' ? resolution.requestId : ''
  if (!requestId) return
  untrackApprovalRequest(requestId)
  for (const [sid, list] of pendingPermissionsBySession) {
    const filtered = list.filter(req => req.requestId !== requestId)
    if (filtered.length === list.length) continue
    if (filtered.length === 0) pendingPermissionsBySession.delete(sid)
    else pendingPermissionsBySession.set(sid, filtered)
  }
  resolveLiveApproval('', requestId, { decision: resolution.approved === true ? 'allow' : 'deny' })
})
klausApi.on.memorySnapshotPrompt(showMemorySnapshotPrompt)
// 目标快照：引擎自己改的那几种变化（模型建/完成、预算停掉、回合失败
// 封住）只从这个推送来，不订就只能轮询。
klausApi.on.goalUpdated?.(onGoalUpdated)
klausApi.on.planningUpdated?.(applyPlanningUpdated)
klausApi.on.planningInputRequested?.(applyPlanningQuestion)
klausApi.on.planningInputResolved?.(applyPlanningQuestion)

let lastModelEngineStatus = 'ok'
klausApi.on.engineStatus((status: string) => {
  if (status !== lastModelEngineStatus) {
    lastModelEngineStatus = status
    invalidateComposerPreferenceReads()
    if (status === 'ok') { void refreshComposerPreferences(); void refreshSideComposerModel() }
  }
  ingestEngineStatus(status)
})

// 引擎进程意外退出：主进程只在「已完成握手的服务进程崩溃」时推送（启动失败
// 走请求自身的报错），且已按进程去重。toast 告知用户下一条消息会自动拉起新引擎，
// 避免只留一条莫名失败在屏幕上。
klausApi.on.engineProcessCrashed?.(() => {
  invalidateComposerPreferenceReads()
  window.showToast?.(tt('engine_process_crashed'), { duration: 6000 })
})

function settingsVisibleIfAny() {
  return document.getElementById('settings-view')?.classList.contains('active')
}

// A failed or superseded request cannot replace the last authoritative snapshot.
async function readSessionSnapshot(): Promise<SessionInfo[] | null> {
  const seq = ++sessionListReadSeq
  const deletionRevision = sessionDeletionRevision
  try {
    const snapshot = await klausApi.session.list()
    if (deletionRevision !== sessionDeletionRevision || seq < sessionListSettledSeq) return null
    sessionListSettledSeq = seq
    sessionListLoadFailed = false
    return snapshot
  } catch (error) {
    if (deletionRevision !== sessionDeletionRevision || seq < sessionListSettledSeq) return null
    sessionListSettledSeq = seq
    console.warn('[sessions] failed to list conversations:', error)
    if (!sessionListLoadFailed) showToast(tt('sessions_load_failed'))
    sessionListLoadFailed = true
    return null
  }
}

async function updateSessionInList({ reorder = false }: { reorder?: boolean } = {}) {
  const reorderSeq = reorder ? ++sessionListReorderSeq : sessionListReorderSeq
  const titleVersionsAtRequest = new Map(sessionTitleVersions)
  const pinVersionsAtRequest = sessionPinning.snapshot()
  const deletionRevision = sessionDeletionRevision
  const liveSessions = await readSessionSnapshot()
  if (!liveSessions || deletionRevision !== sessionDeletionRevision || (reorder && reorderSeq !== sessionListReorderSeq)) return
  const merged = mergeSessionsPreservingFreshTitles(sessionPinning.mergeSnapshot(liveSessions, pinVersionsAtRequest), titleVersionsAtRequest)
  sessions = mergeSidebarSessionSnapshot(sessions, merged, reorder)
  // Every authoritative list refresh reconciles the runtime against the host's
  // working registry, not only the boot and audit paths: a turn that started or
  // settled while no lifecycle frame reached this webview (recovered turns after
  // a restart, background continuations) converges here instead of waiting for
  // an audit that only runs once the renderer already thinks something is live.
  syncSidebarWorkingFromSessions(sessions, { reconcileRuntime: true })
  await refreshProjectWorkspaces({ render: false, refreshWorkdir: false })
  renderSessionList()
  // Surfaces that read the ledger through window.getKnownSessionInfo (the
  // fork-provenance banner over the main transcript) have no store of their own;
  // this event is their re-read trigger.
  window.dispatchEvent(new CustomEvent('klaus:sessions-list-updated'))
}

// ==================== Utils ====================

// 粘底写入口（代理到 mainSticker）。force = 用户明确要看最新：发送消息、点浮标。
function scrollToBottom(options: { force?: boolean; immediate?: boolean } = {}) {
  mainSticker.scrollToBottom(options)
}
// React transcript 的粘底入口：main = 主转录，simple = side 面板，两边各走自己的
// sticker（同一份实现，含方向判定与浮标）。stick 判定留在本模块。
;(window as { scrollToBottom?: typeof scrollToBottom }).scrollToBottom = scrollToBottom
;(window as any).restoreTranscriptViewport = (distanceFromBottomPx: number) => mainSticker.restoreViewport(distanceFromBottomPx)
;(window as any).isTranscriptFollowing = () => mainSticker.isFollowing()
;(window as { sideScrollToBottom?: (options?: { force?: boolean }) => void }).sideScrollToBottom =
  (options = {}) => { sideSticker?.scrollToBottom(options) }
// escapeHtml 收编至 app/ui-shared（workspace-panel 等模块共享）。
function autoResize() {
  refreshSlashCommandPlaceholderWidth()
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px'
  // Once the box is capped, an edit the app wrote itself (shift+Enter, paste,
  // draft restore, undo) leaves the caret wherever the selection landed instead
  // of scrolling it into view the way Chromium does for its own edits. Bring it
  // back before the mirror layer reads scrollTop, so both layers agree.
  scrollCaretIntoView(inputEl)
  syncComposerTokenScroll()
}
// The composer's primary button doubles as the recovery entry for a stopped or
// failed Turn. While the composer is empty, pressing it starts a new Turn with
// no input instead of re-sending anything. See stop-interaction-vectors.json,
// resume-entry.
function sessionContinueMode(sessionId: string): boolean {
  if (!sessionId) return false
  if (continuingSessions.has(sessionId)) return true
  const armUntil = continueArmUntil.get(sessionId) || 0
  if (Date.now() < armUntil) return false
  if (armUntil) continueArmUntil.delete(sessionId)
  return canContinueTurn(sessionId)
}

function composerContinueMode(): boolean {
  if (busy) return false
  const sessionId = window.currentSessionId || ''
  if (hasComposerText() || pendingFiles.length > 0) return false
  // An edit of a sent message owns the composer. Without this, editing a stopped turn
  // down to empty text would flip the button to Continue and route Enter to a
  // continuation — re-running the truncated turn's empty input instead of re-sending the
  // message the user is editing.
  return sessionContinueMode(sessionId)
}

function updateFriendComposeControls() {
  const friends = composerReferenceEntries().filter(reference => reference.kind === 'friend')
  friendComposeContext = reconcileFriendComposeContext(friendComposeContext, friends.map(reference => reference.id || ''))
  let intentHost = document.getElementById('friend-intent-select')
  if (!intentHost) {
    intentHost = document.createElement('div')
    intentHost.id = 'friend-intent-select'
    intentHost.className = 'kls-select kls-select--flat kls-select--friend-intent'
    btnSend.parentElement?.insertBefore(intentHost, btnSend)
    friendIntentApi = mountFriendIntentSelect(intentHost, {
      onIntentChange: (intent) => {
        friendComposeContext.intent = intent
        persistComposerDraft()
        updateSendBtn()
      },
    })
  }
  friendIntentApi?.setHidden(friends.length === 0)
  friendIntentApi?.setValue(friendComposeContext.intent)
  let contextRow = document.getElementById('friend-compose-context')
  if (!contextRow) {
    contextRow = document.createElement('div'); contextRow.id = 'friend-compose-context'; contextRow.className = 'friend-compose-context'
    document.getElementById('slash-input-line')?.before(contextRow)
  }
  const parkedKey = window.currentSessionId || '__new'
  const parked = parkedFriendDrafts.has(parkedKey)
  // A plain reply needs no caption: the recipient chip and the intent select
  // already spell the destination out. Only the quote instruction, the
  // supplement note and the parked-draft restore button occupy this row.
  const captionKey = friendComposeContext.quotedMessageId ? 'chat_friend_quote_instruction'
    : friendComposeContext.supplementToRequestId ? 'chat_friend_supplement_context'
    : friendComposeContext.answersRequestId ? 'chat_friend_answer_context'
    : null
  contextRow.hidden = !parked && !captionKey
  contextRow.replaceChildren()
  if (!contextRow.hidden) {
    if (captionKey) {
      const caption = document.createElement('span')
      const recipient = friends.find(reference => reference.id === friendComposeContext.recipientId)
      caption.textContent = tt(captionKey).replace('{name}', recipient ? friendReferenceIdentity(recipient).name : tt('friends'))
      contextRow.append(caption)
    }
    if (parked) {
      const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = tt('chat_friend_restore_draft')
      restore.addEventListener('click', () => { restoreParkedFriendDraft(parkedKey); updateSendBtn(); inputEl.focus() })
      contextRow.append(restore)
    }
  }
  const showRecipient = friends.length > 0 && (!busy || hasComposerText())
  friendIntentApi?.setDisabled(friendSendInFlight || !friendIntentEditable(friendComposeContext))
  // The send button keeps its standard round face; the recipient is already
  // visible as a mention chip in the composer, so only assistive technology
  // gets the spelled-out destination.
  if (showRecipient) btnSend.setAttribute('aria-label', friendSendLabel(friends.map(reference => friendReferenceIdentity(reference).name), friendComposeContext.intent, tt))
  else btnSend.removeAttribute('aria-label')
}

function restoreParkedFriendDraft(key: string) {
  const saved = parkedFriendDrafts.get(key)
  if (!saved) return
  parkedFriendDrafts.delete(key)
  persistParkedFriendDrafts()
  pendingFiles = saved.files
  setComposerText(saved.draft)
  renderPreviews(); autoResize(); persistComposerDraft()
}

let friendComposePreparation = 0
window.addEventListener('klaus:friend-message-compose', (event: Event) => {
  const detail = (event as CustomEvent).detail
  if (!detail || typeof detail.text !== 'string') return
  const action = detail.action
  if (action !== 'reply' && action !== 'supplement' && action !== 'answer' && action !== 'handoff') return
  const preparation = ++friendComposePreparation
  const originalView = window.currentSessionId
  void (async () => {
    const targetSessionId = await friendComposeTarget(detail, originalView || null, input => klausApi.friends.prepareLocalAssist(input))
    if (preparation !== friendComposePreparation || window.currentSessionId !== originalView) return
    if (targetSessionId && targetSessionId !== window.currentSessionId) {
      // The ordinary switch saves the old composer draft before opening the local one.
      await window.klausSwitchSession?.(targetSessionId)
      if (preparation !== friendComposePreparation || window.currentSessionId !== targetSessionId) return
    }
  const existing = composedInputDraft()
  const key = window.currentSessionId || '__new'
  // Hand a friend message to this device's Klaus: submit it as the prompt of
  // the newly opened local conversation. Do not leave it as a quote that needs
  // a separate owner instruction.
  if (action === 'handoff') {
    if (!parkedFriendDrafts.has(key) && (existing.text.trim() || pendingFiles.length)) {
      parkedFriendDrafts.set(key, { draft: existing, files: [...pendingFiles] })
      if (!persistParkedFriendDrafts()) { parkedFriendDrafts.delete(key); return }
    }
    pendingFiles = []
    setComposerText(detail.text)
    renderPreviews(); autoResize(); updateSendBtn(); persistComposerDraft()
    await send()
    inputEl.focus()
    return
  }
  const explicitReply = action === 'reply' || action === 'supplement' || action === 'answer'
  const hasForeignRecipient = existing.references.some(reference => reference.kind === 'friend')
  if (explicitReply || hasForeignRecipient) {
    if (!parkedFriendDrafts.has(key) && (existing.text.trim() || pendingFiles.length)) {
      parkedFriendDrafts.set(key, { draft: existing, files: [...pendingFiles] })
      if (!persistParkedFriendDrafts()) { parkedFriendDrafts.delete(key); return }
    }
    pendingFiles = []; setComposerText('')
  }
  let replyCaret: number | null = null
  if (explicitReply && typeof detail.friendId === 'string') {
    insertComposerReferenceToken({ kind: 'friend', id: detail.friendId, name: detail.name || tt('friends'), value: '@friend-' + detail.friendId }, { start: 0, end: 0 })
    // The chip lands while the editor still lacks focus, so the selection write
    // inside the insert never reaches the DOM and the browser's focus-time
    // collapse would park the caret before the chip. Carry the requested caret
    // into the deferred focus handoff so it wins over that collapse.
    replyCaret = inputEl.selectionStart ?? null
    friendComposeContext = detail.action === 'reply'
      ? { intent: 'notice', recipientId: detail.friendId, replyToMessageId: detail.messageId }
      // The result of the friend's open request: what the owner writes is sent
      // back as that request's answer and completes it.
      : detail.action === 'answer'
      ? { intent: 'notice', recipientId: detail.friendId, replyToMessageId: detail.messageId, answersRequestId: detail.requestId }
      : { intent: 'request', recipientId: detail.friendId, supplementToRequestId: detail.requestId, questionId: detail.questionId }
  }
  renderPreviews(); autoResize(); updateSendBtn(); persistComposerDraft()
  if (replyCaret !== null) focusComposerInput(inputEl, replyCaret)
  else inputEl.focus()
  })().catch((error: unknown) => showToast((error as Error)?.message || String(error)))
})

function updateSendBtn() {
  updateFriendComposeControls()
  if (friendSendInFlight) { btnSend.disabled = true; return }
  const directFriends = composerReferenceEntries().filter(reference => reference.kind === 'friend')
  if (directFriends.length) {
    btnSend.classList.remove('busy', 'stopping', 'esc-armed', 'continue', 'continuing', 'awaiting-upload', 'running-submit')
    btnSend.disabled = pendingFiles.length > 0 || !hasFriendQuoteInstruction(inputEl.value, directFriends)
    btnSend.removeAttribute('title')
    return
  }
  voiceChatUi?.refresh()
  composerPredictions?.paint()
  composerContinueSessionId = window.currentSessionId || null
  composerContinueOffered = composerContinueMode()
  const pendingSubmission = currentPendingComposerSubmission()
  const goalPreparing = creatingGoalSessions.has(window.currentSessionId || null)
  if (!pendingSubmission && goalPreparing && !(window.currentSessionId && getSessionStream(window.currentSessionId).running)) {
    composerContinueOffered = false
    btnSend.disabled = true
    btnSend.classList.remove('stopping', 'esc-armed', 'continue', 'continuing', 'awaiting-upload', 'running-submit')
    return
  }
  // While a turn runs the button is the stop affordance ONLY while the composer
  // holds nothing to submit (or the stop request is already in flight). Typing
  // anything hands it back to submit: the press then queues or steers the
  // follow-up instead of aborting the turn (see the
  // running-composer-submit-mode rule in stop-interaction-vectors.json).
  const stopping = !!(window.currentSessionId && stoppingSessions.has(window.currentSessionId))
  const runningSubmit = busy && !pendingSubmission && !stopping && !goalPreparing && (hasComposerText() || pendingFiles.length > 0)
  if (busy) {
    btnSend.classList.add('busy')
    btnSend.disabled = stopping || !!pendingSubmission?.cancelled
    btnSend.classList.toggle('running-submit', runningSubmit)
    btnSend.title = stopping
      ? tt('submit_tooltip_stopping')
      : runningSubmit && hasUploadInFlight(pendingFiles) && pendingSendAfterUpload
        ? tt('submit_tooltip_waiting_upload')
        : runningSubmit
          ? tt(followUpQueueMode === 'steer' ? 'submit_tooltip_steer' : 'submit_tooltip_queue')
          : tt('submit_tooltip_stop')
    btnSend.classList.toggle('stopping', stopping)
    btnSend.classList.toggle('esc-armed', !stopping && !runningSubmit && stopEscArmed())
    btnSend.classList.remove('continue')
    btnSend.classList.remove('continuing')
    // The stop affordance must never carry the waiting-for-upload animation:
    // every call on the way out of send() already has `busy` set, so leaving it
    // on here kept the button breathing for the whole turn. The running-submit
    // face is a live submit, so a press parked on an in-flight upload keeps
    // breathing there — that is the only thing separating "received, waiting"
    // from a plain enabled button.
    btnSend.classList.toggle('awaiting-upload', runningSubmit && hasUploadInFlight(pendingFiles) && !!pendingSendAfterUpload)
    return
  }
  btnSend.classList.remove('busy')
  btnSend.classList.remove('stopping')
  btnSend.classList.remove('esc-armed')
  btnSend.classList.remove('running-submit')
  const continuing = composerContinueOffered
  const continuePending = !!window.currentSessionId && continuingSessions.has(window.currentSessionId)
  btnSend.classList.toggle('continue', continuing)
  btnSend.classList.toggle('continuing', continuePending)
  if (continuing) {
    btnSend.disabled = continuePending
    btnSend.title = tt(continuePending ? 'submit_tooltip_continuing' : 'submit_tooltip_continue')
    btnSend.classList.remove('awaiting-upload')
    return
  }
  const uploading = hasUploadInFlight(pendingFiles)
  btnSend.disabled = uploading || (!hasComposerText() && pendingFiles.length === 0)
  // A parked submit is waiting on those uploads — say so, otherwise the click
  // that did nothing looks like the app ignored the user.
  btnSend.title = uploading && pendingSendAfterUpload
    ? tt('submit_tooltip_waiting_upload')
    : tt('submit_tooltip_send')
  btnSend.classList.toggle('awaiting-upload', uploading && !!pendingSendAfterUpload)
}

// ==================== Input events ====================

function handleComposerPickerKeydown(event: KeyboardEvent) {
  const query = currentComposerQuery()
  const published = composerMenuMode === 'workspace' ? workspaceAtTrigger : activeSlashTriggerRange
  const current = !!query && !!published && query.start === published.start && query.end === published.end
    && (published.query === undefined || query.query === published.query)
    && (composerMenuMode === 'workspace' ? query.prefix === '@' : query.prefix !== '@'
      && (activeSlashTriggerRange?.prefix === undefined || query.prefix === activeSlashTriggerRange.prefix))
  routeComposerPickerKey(event, { composing: mainComposerControl?.composing || false, visible: !!slashMenuApi?.isOpen() && current,
    navigate: navigateSlashMenu, select: intent => { slashMenuApi?.clickActive(intent) },
    escape: () => {
      if (composerMenuMode === 'workspace' && workspaceMentionScope) setWorkspaceMentionScope(null)
      else hideSlashMenu(true)
    } })
}

inputEl.addEventListener('keydown', handleComposerPickerKeydown, true)

function handleComposerRecallKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || mainComposerControl?.composing
    || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
    || event.key !== 'ArrowUp' && event.key !== 'ArrowDown'
    || inputEl.selectionStart !== inputEl.value.length || inputEl.selectionEnd !== inputEl.value.length
    || inputEl.ownerDocument.getSelection()?.isCollapsed === false) return
  if (historyBrowsingIndex < 0 && inputEl.value.length > 0) return
  const sessionId = window.currentSessionId
  if (historyBrowsingIndex < 0 && event.key === 'ArrowUp' && sessionId && pendingFiles.length === 0) {
    const queued = [...clientQueueFor(sessionId)].reverse().find(row => !row.id.startsWith('engine:')
      && !row.dispatching && !row.unconfirmed && row.item.followUpState !== 'unconfirmed'
      && !clientQueueMutationPending(sessionId, row.id))
    if (queued) {
      event.preventDefault()
      event.stopImmediatePropagation()
      void mainFollowUpQueueHandlers.onEdit(queued.id)
      return
    }
  }
  if (navigateHistory(event.key === 'ArrowUp' ? -1 : 1, sessionId)) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}
inputEl.addEventListener('keydown', handleComposerRecallKeydown, true)

installComposerFocusRecovery(inputEl, () => document.getElementById('side-input'), input => input === inputEl
  ? !busy : !window.isSessionRunning?.(window.klausSideSurfaceSessionId?.() || ''))

inputEl.addEventListener('keydown', (e) => {
  if (composerKeyWasHandled(e) || e.isComposing || e.keyCode === 229 || mainComposerControl?.composing) return
  // IME 合成中（中/日/韩输入法候选词选择）按回车不应触发任何快捷行为。
  // isComposing 在 Chromium 上并不总是可靠（按回车确认候选时常已变 false），
  // 同时用 keyCode === 229 兜底，这是 W3C/业界通用做法。
  if (e.isComposing || e.keyCode === 229) return
  normalizeComposerTokenSelection()
  // Escape stops the running Turn, in two presses. The first press only ARMS it
  // (the stop button names the key); a second press inside the window does the
  // interrupt. One press cannot do it because Escape dismisses menus, pickers and
  // history browsing all over this composer, and a stray press must not be able to
  // kill a Turn. Anything with something of its own to dismiss is handled above,
  // so reaching here means Escape had nothing else to do.
  if (e.key === 'Escape' && busy) {
    const sessionId = window.currentSessionId || currentPendingComposerSubmission()?.viewId || ''
    if (sessionId && !stoppingSessions.has(sessionId)) {
      e.preventDefault()
      if (stopEscArmed()) {
        if (e.repeat) return
        clearStopEscArm()
        requestTurnStop(sessionId)
        inputEl.focus()
      } else {
        armStopEsc(sessionId)
      }
      return
    }
  }
  if (
    selectedSlashCommand &&
    e.key === 'Backspace' &&
    inputEl.selectionStart === inputEl.selectionEnd &&
    isValidSlashCommandRange(selectedSlashCommandRange) &&
    inputEl.selectionStart > selectedSlashCommandRange.start &&
    inputEl.selectionStart <= selectedSlashCommandRange.end + 1
  ) {
    e.preventDefault()
    clearSelectedSlashCommand()
    persistComposerDraft()
    updateSendBtn()
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    inputEl.blur()
    return
  }
  if (e.key === 'Enter' && e.shiftKey && inputEl.tagName !== 'TEXTAREA') {
    e.preventDefault()
    const previous = inputEl.value
    const start = inputEl.selectionStart ?? previous.length
    const end = inputEl.selectionEnd ?? start
    const expanded = expandSelectionAcrossInlineQuotes(start, end, [
      ...inlineQuoteEntries(pendingFiles, previous),
      ...composerReferenceEntries(previous),
    ])
    mainComposerControl?.replaceRange(expanded.start, expanded.end, '\n', 'insertLineBreak')
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    const sessionId = window.currentSessionId
    if (busy && sessionId && stoppingSessions.has(sessionId)) return
    if (composerContinueMode()) {
      requestTurnContinue(sessionId || '')
      return
    }
    send({ invertFollowUp: busy && (e.metaKey || e.ctrlKey) })
  }
})

inputEl.addEventListener('input', async (rawEvent: Event) => {
  const event = rawEvent as InputEvent
  resetHistoryBrowsing()
  const editorTokens = mainComposerControl?.readTokens()
  if (editorTokens) composerReferenceTokens = referencesFromEditor(inputEl.value, editorTokens)
  const completedReference = event.inputType === 'insertText' && /\s/.test(event.data || '')
    && configuredAgentReferences(inputEl.value).some(reference => reference.range.end === inputEl.value.length - 1)
  if (completedReference) mainComposerControl?.refreshTokens()
  renderPreviews()
  normalizeComposerTokenSelection()
  renderSelectedSlashCommand()
  autoResize(); updateSendBtn()
  // 欢迎屏打字不再 eager promote session 实体（旧行为的 prewarm 会让引擎
  // 把空 rollout 落盘，重启后变成零消息的 "Chat" 幽灵会话）。草稿存
  // localStorage，切走/重启都能恢复；实体由 send()/addFiles 的
  // ensureSession 懒创建。
  if (event.isComposing || mainComposerControl?.composing) return
  persistComposerDraft()
  handleSlashMenu()
  handleWorkspaceMentionMenu()
})
inputEl.addEventListener('scroll', syncComposerTokenScroll)
// A window resize re-wraps both text layers and can cross the 900px breakpoint
// that swaps the composer font size; re-derive the chip placeholder width so
// the mirror and the input keep identical line breaks.
window.addEventListener('resize', () => { autoResize() })
inputEl.addEventListener('click', () => {
  normalizeComposerTokenSelection()
  positionSelectedSlashToken()
})
inputEl.addEventListener('keyup', () => {
  normalizeComposerTokenSelection()
  positionSelectedSlashToken()
})
inputEl.addEventListener('select', () => {
  normalizeComposerTokenSelection()
  positionSelectedSlashToken()
  if (inputEl.ownerDocument.activeElement !== inputEl || mainComposerControl?.composing) return
  void handleSlashMenu()
  handleWorkspaceMentionMenu()
})
inputEl.addEventListener('blur', () => {
  if (inputEl.ownerDocument.hasFocus()) hideSlashMenu(true)
})
/**
 * A terminal event that names a turn OTHER than the one still streaming belongs to that other
 * turn: its DOM side effects (stop-intent retraction, focus, refreshes) must not touch the
 * live turn. Mirrors the store's terminal-branch scope guard.
 */
function foreignTerminalTurn(event: { sessionId?: string; turnId?: string }): boolean {
  const turnId = typeof event?.turnId === 'string' && event.turnId ? event.turnId : null
  if (!turnId || !event.sessionId) return false
  const state = getSessionStream(event.sessionId)
  return !!state.running && !!state.activeTurnId && state.activeTurnId !== turnId
}

function requestTurnStop(sessionId: string) {
  if (stopPendingComposerSubmission(sessionId)) return
  if (!sessionId || stoppingSessions.has(sessionId)) return
  goalInteractions.stop(sessionId)
  clearStopEscArm()
  stoppingSessions.add(sessionId)
  userInterruptedSessions.add(sessionId)
  // Name the Turn being stopped so the host can refuse the request if this
  // session has already moved on to another one.
  const expectedTurnId = getSessionStream(sessionId).activeTurnId
  requestTurnInterrupt(sessionId)
  const requestedAt = getSessionStream(sessionId).stopRequestedAt
  updateSendBtn()
  const ownsStopRequest = () => {
    const current = getSessionStream(sessionId)
    return current.stopRequestedAt == null || current.stopRequestedAt === requestedAt
      && (!expectedTurnId || !current.activeTurnId || current.activeTurnId === expectedTurnId)
  }
  // A refused fence belongs to the captured turn. A replacement must keep running.
  const settleRefusedStop = () => {
    if (!ownsStopRequest()) return
    stoppingSessions.delete(sessionId)
    userInterruptedSessions.delete(sessionId)
    clearTurnInterruptRequest(sessionId)
    updateSendBtn()
  }
  void klausApi.chat.interrupt(sessionId, expectedTurnId).then((result: any) => {
    if (result?.interruptionError) showToast(String(result.interruptionError))
    if (result?.goalPauseError) showToast(String(result.goalPauseError))
    if (result?.accepted) {
      // The host distinguishes the engine's cancellation verdict from dispatch
      // acknowledgement. Once confirmed, cleanup and rollout flushing can finish
      // in the background while the existing terminal path preserves partial output.
      if (result.confirmed !== true || result.interruptionError) return
      const current = getSessionStream(sessionId)
      const turnId = expectedTurnId || result.interruptedTurnId
      if (!turnId || !current.running || current.stopRequestedAt !== requestedAt
          || current.activeTurnId && current.activeTurnId !== turnId) return
      handleChatEvent({ type: 'interrupted', sessionId, turnId })
      updateSendBtn()
      return
    }
    settleRefusedStop()
  }).catch((error: unknown) => {
    showToast(error instanceof Error ? error.message : String(error))
  }).finally(() => {
    // Loading belongs to this request, not to the engine's later cleanup. An
    // uncertain outcome retains its turn intent, but must not lock the button.
    if (!stoppingSessions.has(sessionId) || !ownsStopRequest()) return
    stoppingSessions.delete(sessionId)
    updateSendBtn()
  })
}

// Continue a stopped or failed Turn. NOT a re-send: `chat:continue` starts a new
// Turn with no input, so the model picks the thread back up without the last
// message being submitted twice.
function requestTurnContinue(sessionId: string) {
  if (!sessionId || continuingSessions.has(sessionId)) return
  continuingSessions.add(sessionId)
  updateSendBtn()
  void klausApi.chat.continueTurn(sessionId).then((result: any) => {
    if (result && result.ok === false && result.error) {
      continuingSessions.delete(sessionId)
      updateSendBtn()
      window.showToast?.(String(result.error), { duration: 5000 })
    }
  }).catch((error: unknown) => {
    continuingSessions.delete(sessionId)
    updateSendBtn()
    console.error('[chat] continue failed:', error)
    // The host's structured refusal (TURN_IN_PROGRESS, SESSION_UNAVAILABLE, …)
    // already carries the real reason in `error.message` (bridge/ipc.ts wraps it).
    // The generic wording is the LAST resort for a rejection with nothing to say,
    // not a blanket replacement — repeating "the turn did not complete" over a
    // turn that is already settled hides why the new one never started.
    const detail = error instanceof Error && error.message.trim() ? error.message.trim() : ''
    window.showToast?.(detail ? `${tt('continue_failed_prefix')}${detail}` : tt('chat_error_generic'), { duration: 5000 })
  })
}

btnSend.addEventListener('click', () => {
  if (busy) {
    // A press on the running-submit face is a submit, never a stop: the composer
    // holds content, and send() routes it through the follow-up path (queue or
    // steer per the shared preference). Stopping stays reachable with an empty
    // composer, or with Escape.
    if (btnSend.classList.contains('running-submit')) void send()
    else requestTurnStop(window.currentSessionId || '')
  } else if (composerContinueMode()) {
    requestTurnContinue(window.currentSessionId || '')
  } else {
    send()
  }
})
// Select the active full-page sidebar view and update its navigation state.
// 给对应入口加 .active、其它脱掉，并触发 session 列表重渲让会话条目按
// 新状态决定要不要画 active。diff/workspace 是会话级详情页，不走这个全局状态。
function setCurrentNonChatView(view: string | null) {
  document.body.classList.toggle('non-chat-view', view !== null)
  if (view !== 'profile') (window as any).hideProfileView?.()
  document.getElementById('sidebar-profile')?.setAttribute('aria-current', view === 'profile' ? 'page' : 'false')
  if (view !== 'friends') window.hideFriendsView?.()
  if (view !== 'teamCollaboration') (window as any).klsPageViews?.get('team-collaboration')?.hide()
  if (currentNonChatView === view) return
  currentNonChatView = view
  const map = { cron: 'btn-cron', memory: 'btn-memory', friends: 'btn-friends', mcp: 'btn-mcp', skills: 'btn-skills', plugins: 'btn-plugins', slashCommands: 'btn-slash-commands', agents: 'btn-agents', channels: 'btn-channels', teamCollaboration: 'btn-team-collaboration' }
  for (const [k, id] of Object.entries(map)) {
    document.getElementById(id)?.classList.toggle('active', view === k)
  }
  // Extensions 子视图激活时强制展开分组，否则 active 高亮藏在折叠区里看不见
  // （外部深链会直接 .click() 隐藏中的子按钮）。
  if (view === 'mcp' || view === 'skills' || view === 'plugins' || view === 'slashCommands' || view === 'agents') {
    document.getElementById('extensions-children')?.classList.add('open')
    document.getElementById('btn-extensions')?.setAttribute('aria-expanded', 'true')
  }
  if (view !== null && typeof window.hideWorkspaceMainView === 'function') window.hideWorkspaceMainView()
  if (typeof window.hideDiffView === 'function') window.hideDiffView()
  syncTopModeButtons()
  renderSessionList()
}

btnNewChat.addEventListener('click', () => {
  const target = newChatTargetFromCurrentSelection()
  // Coming from cron/settings view: close the overlay before starting a new chat
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.hideDiffView === 'function') window.hideDiffView()
  if (typeof window.hideWorkspaceMainView === 'function') window.hideWorkspaceMainView()
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  setCurrentNonChatView(null)
  newChat(target)
})

// Sidebar toolbar (priority threads + sort menu): the Priority entry toggles
// the activity view; the sort entry opens the ordering menu.
document.getElementById('titlebar-activity')?.addEventListener('click', () => {
  toggleSidebarActivityView()
})

// Extensions 分组：父项只负责折叠/展开 MCP・技能・插件・快捷命令・智能体五个子项，不导航。
document.getElementById('btn-extensions')?.addEventListener('click', () => {
  const children = document.getElementById('extensions-children')
  const open = children?.classList.toggle('open')
  document.getElementById('btn-extensions')?.setAttribute('aria-expanded', open ? 'true' : 'false')
})

document.getElementById('btn-team-collaboration')?.addEventListener('click', () => {
  // Server-controlled gate: when teamCollaboration is closed for this account
  // the button is hidden, but programmatic entry (hash-route restore, Issue
  // deep links, agent nav) lands on .click() too — refuse all of them here.
  if (!featureGates?.enabled('teamCollaboration')) return
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  const pages = (window as any).klsPageViews
  for (const name of ['cron', 'memory', 'friends', 'mcp', 'skills', 'plugins', 'slash-commands', 'agents', 'channels']) pages?.get(name)?.hide()
  pages?.get('team-collaboration')?.show()
  setCurrentNonChatView('teamCollaboration')
  hideArtifactsPanelForNonChatView()
})

window.addEventListener('hashchange', restoreCollaborationRoute)
queueMicrotask(restoreCollaborationRoute)

document.getElementById('btn-mcp')?.addEventListener('click', () => {
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.showMcpView === 'function') window.showMcpView()
  setCurrentNonChatView('mcp')
  hideArtifactsPanelForNonChatView()
})

document.getElementById('btn-skills')?.addEventListener('click', () => {
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.showSkillsView === 'function') window.showSkillsView()
  setCurrentNonChatView('skills')
  hideArtifactsPanelForNonChatView()
})

document.getElementById('btn-plugins')?.addEventListener('click', () => {
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.showPluginsView === 'function') window.showPluginsView()
  setCurrentNonChatView('plugins')
  hideArtifactsPanelForNonChatView()
})

document.getElementById('btn-slash-commands')?.addEventListener('click', () => {
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.showSlashCommandsView === 'function') window.showSlashCommandsView()
  setCurrentNonChatView('slashCommands')
  hideArtifactsPanelForNonChatView()
})

document.getElementById('btn-agents')?.addEventListener('click', () => {
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.showAgentsView === 'function') window.showAgentsView()
  setCurrentNonChatView('agents')
  hideArtifactsPanelForNonChatView()
})

document.getElementById('btn-diff')?.addEventListener('click', () => {
  const diffOpen = typeof window.isDiffViewActive === 'function'
    ? window.isDiffViewActive()
    : document.getElementById('diff-view')?.classList.contains('active')
  if (diffOpen) {
    window.dispatchEvent(new CustomEvent('klaus:diff-close'))
    return
  }
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.hideWorkspaceMainView === 'function') window.hideWorkspaceMainView()
  setCurrentNonChatView(null)
  if (typeof window.showDiffView === 'function') window.showDiffView({ openPanel: true })
  syncTopModeButtons()
  renderSessionList()
})

window.addEventListener('klaus:diff-close', () => {
  if (typeof window.hideDiffView === 'function') window.hideDiffView()
  restoreArtifactsPanelForChatView()
  syncTopModeButtons()
  renderSessionList()
})

document.getElementById('btn-cron')?.addEventListener('click', () => {
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.showCronView === 'function') window.showCronView()
  setCurrentNonChatView('cron')
  hideArtifactsPanelForNonChatView()
})

document.getElementById('btn-channels')?.addEventListener('click', () => {
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
  window.hideFriendsView?.()
  if (typeof window.showChannelsView === 'function') window.showChannelsView()
  setCurrentNonChatView('channels')
  hideArtifactsPanelForNonChatView()
})

document.getElementById('btn-memory')?.addEventListener('click', () => {
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  if (typeof window.hideCronView === 'function') window.hideCronView()
  if (typeof window.hideMcpView === 'function') window.hideMcpView()
  if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
  if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
  if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
  if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
  if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
  if (typeof window.showMemoryView === 'function') window.showMemoryView()
  setCurrentNonChatView('memory')
  hideArtifactsPanelForNonChatView()
})

document.getElementById('btn-friends')?.addEventListener('click', () => {
  if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  const pages = (window as any).klsPageViews
  for (const name of ['cron', 'memory', 'mcp', 'skills', 'plugins', 'slash-commands', 'agents', 'channels', 'team-collaboration']) pages?.get(name)?.hide()
  pages?.get('friends')?.show()
  setCurrentNonChatView('friends')
  hideArtifactsPanelForNonChatView()
})

// Sidebar toggle
document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed
  persistLocalValue('klaus_sidebar_collapsed', sidebarCollapsed ? '1' : '0')
  updateSidebarToggleState()
})

// User menu
const USER_SUBMENU_IDS = ['user-menu-lang', 'user-menu-theme', 'user-menu-font']
let languageSaveRevision = 0

function closeUserSubmenus() {
  USER_SUBMENU_IDS.forEach((id: string) => document.getElementById(id)?.classList.remove('open'))
}

function closeUserMenu() {
  userMenuOpen = false
  document.getElementById('user-menu')?.classList.remove('open')
  // The gear's selected look keys off aria-expanded (styles.css), so it has to
  // drop with the menu no matter which path closed it.
  document.getElementById('sidebar-user-settings')?.setAttribute('aria-expanded', 'false')
  closeUserSubmenus()
}
registerOverlay('user-menu', closeUserMenu)

// Submenus are fixed-position siblings of the menu, so they get placed against
// the anchor row's viewport rect. The palette list is taller than the footer
// area, so the top edge is clamped into the window instead of running off it.
function positionUserSubmenu(submenu: HTMLElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect()
  submenu.style.left = `${rect.right + 8}px`
  submenu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - submenu.offsetHeight - 8))}px`
}

function toggleUserSubmenu(id: string) {
  const submenu = document.getElementById(id)
  if (!submenu) return null
  const wasOpen = submenu.classList.contains('open')
  closeUserSubmenus()
  if (wasOpen) return null
  submenu.classList.add('open')
  return submenu
}

function initLangSubmenu() {
  const submenu = document.getElementById('user-menu-lang')
  if (!submenu) return
  const checkSvg = klausIcon('check', { cls: 'menu-check' })
  submenu.innerHTML = `
    <button class="user-menu-item${window.currentLang === 'en' ? ' active' : ''}" data-lang="en"><span>English</span>${window.currentLang === 'en' ? checkSvg : ''}</button>
    <button class="user-menu-item${window.currentLang === 'zh' ? ' active' : ''}" data-lang="zh"><span>中文</span>${window.currentLang === 'zh' ? checkSvg : ''}</button>
  `
  submenu.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-lang]')
    if (btn) {
      const lang = (btn as HTMLElement).dataset.lang
      if (!lang || lang === window.currentLang) return
      const previous = window.currentLang || 'zh'
      const revision = ++languageSaveRevision
      setLanguage(lang)
      updateLangSubmenuActive(lang)
      void Promise.resolve(klausApi?.settings?.kv?.set?.('language', lang)).then((result: any) => {
        if (result?.ok === false || result?.error) throw new Error(result?.error || tt('preferences_save_failed'))
      }).catch((error: any) => {
        if (revision !== languageSaveRevision) return
        setLanguage(previous)
        updateLangSubmenuActive(previous)
        showToast(error?.message || tt('preferences_save_failed'))
      })
    }
  })
}

function updateLangSubmenuActive(lang: string) {
  const submenu = document.getElementById('user-menu-lang')
  if (submenu) {
    const checkSvg = klausIcon('check', { cls: 'menu-check' })
    submenu.querySelectorAll<HTMLElement>('[data-lang]').forEach((btn) => {
      const isActive = btn.dataset.lang === lang
      btn.classList.toggle('active', isActive)
      const check = btn.querySelector('.menu-check')
      if (isActive && !check) btn.innerHTML += checkSvg
      else if (!isActive && check) check.remove()
    })
  }
}

// Theme submenu — light/dark/system on top, the palettes for the variant that
// is actually in effect below. A palette is listed only for the variant that
// has a seed for it, so switching variant re-renders the list.
function themeChoiceIcon(choice: string) {
  if (choice === 'dark') {
    return `${klausIcon('chat-theme-choice')}`
  }
  if (choice === 'system') {
    return `${klausIcon('chat-theme-choice-2')}`
  }
  return `${klausIcon('chat-theme-choice-3')}`
}

async function renderThemeSubmenu() {
  const submenu = document.getElementById('user-menu-theme')
  if (!submenu) return
  const pref = await window.ensureAppearancePreferences?.()
  const choice = pref.themeChoice
  const variant = window.resolveAppearanceVariant?.(choice)
  const selectedId = pref.codeThemeIds?.[variant]
  const check = klausIcon('check', { cls: 'menu-check' })
  // Row markers must not reuse `data-theme-choice`: applyTheme writes that
  // attribute on <html>, so closest() from a row would climb out of the menu
  // and match the document root.
  const choices = ['light', 'dark', 'system'].map((item) => `
    <button class="user-menu-item${item === choice ? ' active' : ''}" data-theme-mode="${item}">${themeChoiceIcon(item)}<span>${tt(item)}</span>${check}</button>`).join('')
  const palettes = window.appearanceThemeOptions!(variant).map((theme: { id: string; accent: string; surface: string; name?: string }) => `
    <button class="user-menu-item${theme.id === selectedId ? ' active' : ''}" data-theme-palette="${escapeHtml(theme.id)}">
      <span class="theme-menu-dot" style="--theme-dot-fill:${escapeHtml(theme.accent)};--theme-dot-ring:${escapeHtml(theme.surface)}"></span>
      <span>${escapeHtml(theme.name)}</span>${check}
    </button>`).join('')
  submenu.innerHTML = `${choices}<div class="user-menu-sep"></div>${palettes}`
}

// Picking a palette only moves the check mark, so the rows are updated in place
// — a full re-render would drop the row the pointer is on.
async function syncThemeSubmenuActive() {
  const submenu = document.getElementById('user-menu-theme')
  if (!submenu) return
  const pref = await window.ensureAppearancePreferences?.()
  const selectedId = pref.codeThemeIds?.[window.resolveAppearanceVariant?.(pref.themeChoice)]
  submenu.querySelectorAll<HTMLElement>('[data-theme-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeMode === pref.themeChoice)
  })
  submenu.querySelectorAll<HTMLElement>('[data-theme-palette]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themePalette === selectedId)
  })
}

// Font submenu — the two size preferences as steppers, since a popup row has no
// space for a labelled number field.
function fontStepperRow(field: string, label: string) {
  return `<div class="user-menu-row" data-font-row="${field}">
    <span>${escapeHtml(label)}</span>
    <span class="font-stepper">
      <button type="button" data-font-field="${field}" data-font-step="-1" aria-label="-">${klausIcon('minus')}</button>
      <span class="font-stepper-value"></span>
      <button type="button" data-font-field="${field}" data-font-step="1" aria-label="+">${klausIcon('plus')}</button>
    </span>
  </div>`
}

async function renderFontSubmenu() {
  const submenu = document.getElementById('user-menu-font')
  if (!submenu) return
  submenu.innerHTML = [
    fontStepperRow('uiFontSize', tt('appearance_ui_font_size')),
    fontStepperRow('codeFontSize', tt('appearance_code_font_size')),
  ].join('')
  await syncFontSubmenu()
}

// Values and bound states are written into the existing rows: stepping twice in
// a row must keep working, which a re-render of the pressed button would break.
async function syncFontSubmenu() {
  const submenu = document.getElementById('user-menu-font')
  if (!submenu) return
  const pref = await window.ensureAppearancePreferences?.()
  submenu.querySelectorAll<HTMLElement>('[data-font-row]').forEach((row) => {
    const spec = window.KLAUS_APPEARANCE_FONT_FIELDS![row.dataset.fontRow!]
    const value = pref[row.dataset.fontRow!]
    const valueEl = row.querySelector('.font-stepper-value')
    if (valueEl) valueEl.textContent = String(value)
    row.querySelectorAll<HTMLButtonElement>('[data-font-step]').forEach((btn) => {
      btn.disabled = Number(btn.dataset.fontStep) < 0 ? value <= spec.min : value >= spec.max
    })
  })
}

document.getElementById('sidebar-profile')?.addEventListener('click', () => {
  closeUserMenu()
  openSettings('profile')
})

// The gear retains the account and application settings menu.
document.getElementById('sidebar-user-settings')?.addEventListener('click', (e) => {
  e.stopPropagation()
  if (userMenuOpen) {
    closeUserMenu()
  } else {
    userMenuOpen = true
    claimOverlay('user-menu')
    document.getElementById('user-menu')?.classList.add('open')
    ;(e.currentTarget as HTMLElement).setAttribute('aria-expanded', 'true')
  }
})

// The quota popover follows this conversation's persisted model source.
// A new-chat draft uses the source selected for the next conversation.
function usageWindowLabel(win: { label?: string; id?: string; usedPercent?: number }) {
  // 显式 label（如 Codex 附加限额的模型名）优先于 id 的 i18n 映射。
  if (win.label) return win.label
  const key = `usage_window_${win.id}`
  const label = tt(key)
  if (label !== key) return label
  // A plan entitlement this build has no name for still reads as an
  // entitlement, never as the raw code the service uses internally.
  if ((win.id || '').startsWith('tokenplan_')) return tt('usage_window_plan_entitlement')
  return tt('usage_window_generic')
}

function usageFormatTime(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  try {
    return new Date(ms).toLocaleString(window.currentLang === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '' }
}

function renderUsageBarRow(label: string, valueText: string, usedPercent: number) {
  const usedPct = Math.min(100, Math.max(0, Number(usedPercent) || 0))
  const remainingPct = 100 - usedPct
  return `
    <div class="usage-row">
      <div class="usage-row-top">
        <span class="usage-row-label">${escapeHtml(label)}</span>
        <span class="usage-row-value">${escapeHtml(valueText)}</span>
      </div>
      <div class="usage-bar"><div class="usage-bar-fill${usedPct >= 90 ? ' high' : ''}" style="width:${remainingPct}%"></div></div>
    </div>`
}

function renderUsageWindows(data: { windows?: Array<{ usedPercent: number; resetsAt?: number; label?: string; id?: string }> }) {
  const windows = Array.isArray(data.windows) ? data.windows : []
  if (!windows.length) return `<div class="usage-empty">${escapeHtml(tt('usage_no_windows'))}</div>`
  return windows.map((win: { usedPercent: number; resetsAt?: number; label?: string }) => {
    const usedPct = Math.min(100, Math.max(0, Number(win.usedPercent) || 0))
    // The bar fill is remaining allowance, so the number beside it must say
    // remaining too; mixing the two readings in one row is what confused users.
    const parts = [`${100 - Math.round(usedPct)}% ${tt('usage_remaining')}`]
    const reset = usageFormatTime(win.resetsAt)
    if (reset) parts.push(`${tt('usage_resets')} ${reset}`)
    return renderUsageBarRow(usageWindowLabel(win), parts.join(' · '), usedPct)
  }).join('')
}

function renderUsageCredits(labelKey: string, credits: { used?: number; total?: number; unit?: string; usedPercent?: number } | null | undefined) {
  if (!credits) return ''
  const fmt = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
  const usedPct = Math.min(100, Math.max(0, Number(credits.usedPercent) || 0))
  const total = Number(credits.total ?? 0)
  const remaining = Math.max(0, total - Number(credits.used ?? 0))
  const value = `${fmt(remaining)} / ${fmt(total)} ${credits.unit ?? ''} · ${100 - Math.round(usedPct)}% ${tt('usage_remaining')}`
  return renderUsageBarRow(tt(labelKey), value, usedPct)
}


function renderAntigravityUsageWindows(data: { windows?: Array<{ usedPercent?: number; remaining?: number | string; total?: number | string; used?: number | string; unit?: string; expiresAt?: number; resetsAt?: number; label?: string; id?: string; disabled?: boolean; unlimited?: boolean; description?: string; groupDescription?: string }> }, showLimits = false) {
  const windows = Array.isArray(data.windows) ? data.windows : []
  if (!windows.length) return `<div class="usage-empty">${escapeHtml(tt('usage_no_windows'))}</div>`
  return windows.map(win => {
    const usedPct = typeof win.usedPercent === 'number' && Number.isFinite(win.usedPercent) ? Math.min(100, Math.max(0, win.usedPercent)) : undefined
    // The bar fill is remaining allowance, so the number beside it must say
    // remaining too; mixing the two readings in one row is what confused users.
    const formatAmount = (value: unknown): string | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString()
      : typeof value === 'string' && /^\d{1,19}$/.test(value) ? BigInt(value).toLocaleString() : undefined
    const nativeRemaining = showLimits ? formatAmount(win.remaining) : undefined
    const parts = win.disabled === true ? [tt('usage_account_restricted')]
      : showLimits && win.unlimited === true ? [tt('usage_unlimited')]
      : usedPct !== undefined ? [`${100 - Math.round(usedPct)}% ${tt('usage_remaining')}`]
        : nativeRemaining !== undefined ? [`${nativeRemaining} ${win.unit || ''} ${tt('usage_remaining')}`.replace(/\s+/g, ' ').trim()]
          : typeof win.remaining === 'number' && Number.isFinite(win.remaining) ? [`${win.remaining.toLocaleString()} ${tt('usage_remaining')}`] : [tt('usage_quota_unknown')]
    if (showLimits && formatAmount(win.total) !== undefined) parts.push(`${tt('trae_usage_limit')}: ${formatAmount(win.total)} ${win.unit || ''}`.trim())
    const expiry = showLimits ? usageFormatTime(win.expiresAt) : ''
    if (expiry) parts.push(`${tt('usage_expires')} ${expiry}`)
    const reset = usageFormatTime(win.resetsAt)
    if (reset) parts.push(`${tt('usage_resets')} ${reset}`)
    const row = usedPct !== undefined && win.disabled !== true && !(showLimits && win.unlimited === true) ? renderUsageBarRow(usageWindowLabel(win), parts.join(' · '), usedPct)
      : `<div class="usage-row"><div class="usage-row-top"><span class="usage-row-label">${escapeHtml(usageWindowLabel(win))}</span><span class="usage-row-value">${escapeHtml(parts.join(' · '))}</span></div></div>`
    const description = [win.groupDescription, win.description].filter(Boolean).join(' · ')
    return row + (description ? `<div class="usage-meta">${escapeHtml(description)}</div>` : '')
  }).join('')
}

function renderAntigravityUsageCredits(labelKey: string, credits: { used?: number | string; total?: number | string; remaining?: number | string; unit?: string; usedPercent?: number; pools?: Array<{ creditType?: string; creditAmount: string; minimumCreditAmountForUsage?: string }> } | null | undefined, showAmounts = false) {
  if (!credits) return ''
  if (showAmounts) {
    const formatAmount = (value: unknown): string | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString()
      : typeof value === 'string' && /^\d{1,19}$/.test(value) && BigInt(value) <= 9223372036854775807n ? BigInt(value).toLocaleString() : undefined
    const parts = ([['remaining', 'usage_remaining'], ['used', 'usage_used'], ['total', 'trae_usage_limit']] as const).flatMap(([field, label]) => {
      const amount = formatAmount(credits[field])
      return amount === undefined ? [] : [`${tt(label)}: ${amount} ${credits.unit || ''}`.trim()]
    })
    return parts.length ? `<div class="usage-row"><div class="usage-row-top"><span class="usage-row-label">${escapeHtml(tt(labelKey))}</span><span class="usage-row-value">${escapeHtml(parts.join(' · '))}</span></div></div>` : ''
  }
  if (credits.pools?.length) return credits.pools.map(pool => {
    const label = pool.creditType === 'GOOGLE_ONE_AI' ? 'Google One AI' : tt(labelKey)
    const amount = BigInt(pool.creditAmount).toLocaleString()
    const minimum = pool.minimumCreditAmountForUsage === undefined ? '' : ` · ${tt('usage_credit_minimum')} ${BigInt(pool.minimumCreditAmountForUsage).toLocaleString()}`
    return `<div class="usage-meta">${escapeHtml(label)}: ${escapeHtml(amount)} ${escapeHtml(tt('usage_remaining'))}${escapeHtml(minimum)}</div>`
  }).join('')
  const fmt = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
  const total = typeof credits.total === 'number' && Number.isFinite(credits.total) && credits.total > 0 ? credits.total : undefined
  const reported = typeof credits.remaining === 'number' && Number.isFinite(credits.remaining) && credits.remaining >= 0 ? credits.remaining : undefined
  const remaining = reported ?? Math.max(0, (total ?? 0) - Number(credits.used ?? 0))
  if (total === undefined) return `<div class="usage-meta">${escapeHtml(tt(labelKey))}: ${fmt(remaining)} ${escapeHtml(credits.unit || '')} ${escapeHtml(tt('usage_remaining'))}</div>`
  const usedPct = Math.min(100, Math.max(0, typeof credits.usedPercent === 'number' ? credits.usedPercent : (total - remaining) / total * 100))
  const value = `${fmt(remaining)} / ${fmt(total)} ${credits.unit ?? ''} · ${100 - Math.round(usedPct)}% ${tt('usage_remaining')}`
  return renderUsageBarRow(tt(labelKey), value, usedPct)
}

function renderKiroUsageWindows(data: { windows?: Array<{ id?: string; label?: string; remaining?: number; total?: number; used?: number; usedPercent?: number; resetsAt?: number }> }) {
  const rows = Array.isArray(data.windows) ? data.windows : []
  if (!rows.length) return `<div class="usage-empty">${escapeHtml(tt('usage_no_windows'))}</div>`
  const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return rows.map(row => {
    const labelKey = row.id?.endsWith('-monthly') ? 'kiro_usage_monthly'
      : row.id?.endsWith('-trial') ? 'kiro_usage_trial'
        : row.id?.includes('-prepaid-') ? 'kiro_usage_prepaid' : undefined
    const label = labelKey ? tt(labelKey) : row.label || tt('kiro_usage_bonus')
    const remaining = typeof row.remaining === 'number' ? format(row.remaining) : undefined
    const total = typeof row.total === 'number' ? format(row.total) : undefined
    const parts = [remaining !== undefined
      ? `${remaining}${total !== undefined ? ` / ${total}` : ''} ${tt('kiro_usage_unit')} ${tt('usage_remaining')}`
      : total !== undefined ? `${tt('trae_usage_limit')}: ${total} ${tt('kiro_usage_unit')}` : tt('usage_quota_unknown')]
    const reset = usageFormatTime(row.resetsAt)
    if (reset) parts.push(`${tt('usage_resets')} ${reset}`)
    if (typeof row.usedPercent === 'number') return renderUsageBarRow(label, parts.join(' · '), row.usedPercent)
    return `<div class="usage-row"><div class="usage-row-top"><span class="usage-row-label">${escapeHtml(label)}</span><span class="usage-row-value">${escapeHtml(parts.join(' · '))}</span></div></div>`
  }).join('')
}

function renderTraeUsageCredits(credits: { remaining?: number | string; unlimited?: boolean } | null | undefined) {
  const amount = credits?.remaining
  const value = credits?.unlimited === true ? tt('usage_unlimited')
    : typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER
      ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : typeof amount === 'string' && /^\d{1,19}$/.test(amount) && BigInt(amount) <= 9223372036854775807n
        ? BigInt(amount).toLocaleString() : tt('usage_quota_unknown')
  return `<div class="usage-row"><div class="usage-row-top"><span class="usage-row-label">${escapeHtml(tt('trae_usage_available'))}</span><span class="usage-row-value">${escapeHtml(value)}</span></div></div>`
}

type ExtraCreditUsage = { billing: 'extraCredits'; enabled?: boolean; monthlyLimit?: number; usedCredits?: number }

function renderUsageExtra(extraUsage: ExtraCreditUsage | undefined) {
  if (extraUsage?.billing !== 'extraCredits') return ''
  const format = (value: number) => value.toLocaleString(window.currentLang === 'zh' ? 'zh-CN' : 'en-US', { maximumSignificantDigits: 21 })
  const amounts = ([
    ['usage_extra_used', extraUsage.usedCredits],
    ['usage_extra_monthly_limit', extraUsage.monthlyLimit],
  ] as const).flatMap(([key, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? [`${tt(key)}: ${format(value)} ${tt('usage_extra_credit_unit')}`] : [])
  const status = typeof extraUsage.enabled === 'boolean'
    ? `<span class="usage-row-value">${escapeHtml(tt(extraUsage.enabled ? 'usage_extra_enabled' : 'usage_extra_disabled'))}</span>` : ''
  return `<div class="usage-extra" style="margin-top:10px"><div class="usage-row-top"><span class="usage-row-label">${escapeHtml(tt('usage_extra_title'))}</span>${status}</div>`
    + (amounts.length ? `<div class="usage-meta">${escapeHtml(amounts.join(' · '))}</div>` : '')
    + `<div class="usage-meta">${escapeHtml(tt('usage_extra_billing'))}</div></div>`
}

function renderUsageProvider(name: string, data: { error?: string; plan?: string; state?: string } | null | undefined, bodyHtml: string) {
  // 只展示源名 + 套餐档位；账号邮箱不在浮层里重复展示。
  const plan = data?.plan
    ? `<span class="usage-plan-badge">${escapeHtml(String(data.plan))}</span>` : ''
  let body = bodyHtml
  if (data?.state === 'signed_out' && !bodyHtml) {
    body = `<div class="usage-empty">${escapeHtml(tt('usage_signed_out'))}</div>`
  } else if (data?.state === 'error' && !bodyHtml) {
    body = `<div class="usage-empty usage-error-text">${escapeHtml(tt('usage_error'))}${data?.error ? ` · ${escapeHtml(String(data.error).slice(0, 160))}` : ''}</div>`
  }
  return `
    <div class="usage-provider">
      <div class="usage-provider-head">
        <span class="usage-provider-name">${escapeHtml(name)}</span>
        ${plan}
      </div>
      ${body}
    </div>`
}

const USAGE_MODE_PROVIDER_KEYS = {
  subscription: 'usage_provider_claude',
  codex: 'usage_provider_codex',
  cursor: 'usage_provider_cursor',
  qoder: 'usage_provider_qoder',
  qwenwork: 'usage_provider_qwenwork',
  qoderwork: 'usage_provider_qoderwork',
  workbuddy: 'usage_provider_workbuddy',
  antigravity: 'usage_provider_antigravity',
  trae: 'usage_provider_trae',
  kiro: 'usage_provider_kiro',
  kimi: 'usage_provider_kimi',
  bailian: 'usage_provider_bailian',
  minimax: 'usage_provider_minimax',
  zhipu: 'usage_provider_zhipu',
  ark: 'usage_provider_ark',
  custom: 'usage_provider_byok',
}
const USAGE_PRESET_MODE_NAMES = { deepseek: 'DeepSeek', qwen: 'Qwen' }

function renderUsageSnapshot(snapshot: { mode: string; provider?: { state?: string; error?: string; plan?: string; subscriptionState?: string; windows?: Array<{ usedPercent: number; resetsAt?: number; label?: string; id?: string }>; extraUsage?: ExtraCreditUsage; credits?: { used?: number; total?: number; remaining?: number; unlimited?: boolean; unit?: string; usedPercent?: number }; unlimited?: boolean; quotaAvailable?: boolean; expiresAt?: number; resetsAt?: number; models?: Array<{ name?: string; model?: string; provider?: string }>; accounts?: Array<{ id?: string; label?: string; isCurrent?: boolean; state?: string; error?: string; plan?: string; windows?: Array<{ usedPercent: number; resetsAt?: number; label?: string; id?: string }>; extraUsage?: ExtraCreditUsage }> } }) {
  const mode = snapshot.mode
  const provider = snapshot.provider || { state: 'error', error: 'empty snapshot' }
  let data = mode === 'cursor' && provider.error ? { ...provider, error: cursorErrorText(provider.error, tt) } : provider
  if (mode === 'kiro' && data.error) data = { ...data, error: knownKiroAuthErrorText(data.error, tt) || data.error }
  if (mode === 'qwenwork' && data.error) {
    const key = ({
      qwenwork_login_expired: 'usage_qwenwork_login_required',
      qwenwork_refresh_failed: 'usage_qwenwork_refresh_failed',
      qwenwork_credential_changed: 'usage_qwenwork_credential_changed',
      qwenwork_credential_write_failed: 'usage_qwenwork_credential_write_failed',
    } as Record<string, string>)[data.error]
    if (key) data = { ...data, error: tt(key) }
  }
  const nameKey = (USAGE_MODE_PROVIDER_KEYS as Record<string, string>)[mode]
  const name = nameKey ? tt(nameKey) : ((USAGE_PRESET_MODE_NAMES as Record<string, string>)[mode] || mode)
  let body = ''
  if (data.state === 'ok' || (mode === 'subscription' && Array.isArray(data.accounts) && data.accounts.length > 0)) {
    if (mode === 'subscription' && Array.isArray(data.accounts) && data.accounts.length > 0) {
      // A subscription login can carry a queue of accounts; each one keeps its
      // own allowance window, so the popover shows one block per account and
      // marks the one requests actually authenticate with.
      body = data.accounts.map((row, index) => {
        const label = escapeHtml(String(row.label || tt('usage_provider_claude')))
        const current = row.isCurrent ? `<span class="usage-plan-badge">${escapeHtml(tt('usage_account_current'))}</span>` : ''
        const inner = row.state === 'error'
          ? `<div class="usage-empty usage-error-text">${escapeHtml(tt('usage_error'))}${row.error ? ` · ${escapeHtml(String(row.error).slice(0, 160))}` : ''}</div>`
          : renderUsageWindows(row) + renderUsageExtra(row.extraUsage)
        const gap = index > 0 ? ' style="margin-top:10px"' : ''
        return `<div class="usage-account"${gap}><div class="usage-provider-head"><span class="usage-provider-name">${label}</span>${current}</div>${inner}</div>`
      }).join('')
    } else if (mode === 'kiro') {
      body = renderKiroUsageWindows(data)
    } else if (mode === 'trae') {
      body = renderTraeUsageCredits(data.credits)
    } else if (mode === 'antigravity') {
      body = renderAntigravityUsageWindows(data)
      if (data.credits) body += renderAntigravityUsageCredits('usage_qoder_personal', data.credits)
    } else if (mode === 'subscription' || mode === 'codex' || mode === 'cursor' || mode === 'kimi' || mode === 'minimax') {
      // Kimi and M Plan answer in the same window shape: one bar per allowance,
      // each with its own reset. Their ratios are already projected onto usedPercent
      // by the host, so this is the same read the two rate-limited sources use.
      body = renderUsageWindows(data)
      if (mode === 'subscription') body += renderUsageExtra(data.extraUsage)
      // M Plan is one shared allowance across every modality, and which window a
      // task draws on depends on the modality — video is weekly only. When the plan
      // reports no window at all, say what the allowance covers rather than reading
      // as a fetch that failed.
      if (mode === 'minimax' && data.quotaAvailable === false) {
        body = `<div class="usage-empty">${escapeHtml(tt('minimax_usage_console_hint'))}</div>`
      } else if (mode === 'minimax') {
        body += `<div class="usage-meta">${escapeHtml(tt('minimax_usage_console_hint'))}</div>`
      }
    } else if (mode === 'qoder' || mode === 'qwenwork' || mode === 'qoderwork' || mode === 'workbuddy') {
      body = renderUsageCredits('usage_qoder_personal', data.credits)
        + renderUsageCredits('usage_qoder_org', (data as { orgCredits?: { used?: number; total?: number; unit?: string; usedPercent?: number } }).orgCredits)
      // An enterprise account with no limit reports the plan and no pool: drawing
      // a bar out of a -1 total would be nonsense, and "no usage window" would
      // read as a failure to fetch.
      if (!body) {
        body = data.unlimited === true
          ? `<div class="usage-empty">${escapeHtml(tt('usage_unlimited'))}</div>`
          : `<div class="usage-empty">${escapeHtml(tt('usage_no_windows'))}</div>`
      }
      const expires = usageFormatTime(data.expiresAt)
      if (expires) body += `<div class="usage-meta">${escapeHtml(tt('usage_expires'))} ${escapeHtml(expires)}</div>`
    } else if (mode === 'custom') {
      body = (data.models || []).map((m: { name?: string; model?: string; provider?: string; costUsd?: number }) => `
        <div class="usage-byok-item">
          <span class="usage-byok-name">${escapeHtml(m.name || m.model)}</span>
          <span class="usage-byok-model">${escapeHtml(m.provider)} · ${escapeHtml(m.model)}</span>
        </div>`).join('')
        + `<div class="usage-meta">${escapeHtml(tt('usage_byok_metered'))}</div>`
    } else if (mode === 'bailian') {
      // Token Plan is a fixed monthly Credits pool, NOT pay-as-you-go. The plan
      // key alone reaches no quota route, but a stored console session unlocks
      // the console's own gateway, and then the host projects the pool as rate
      // windows — so with windows this draws the same bar the Codex and Kimi
      // gauges draw, and without them it says where the allowance actually
      // lives instead of falling through to the BYO wording below, which would
      // wrongly claim the user is billed per token.
      body = data.windows && data.windows.length
        ? renderUsageWindows(data)
        : data.subscriptionState === 'expired' || data.subscriptionState === 'invalid_key'
          ? `<div class="usage-empty">${escapeHtml(tt(data.subscriptionState === 'expired' ? 'bailian_subscription_expired' : 'bailian_key_invalid'))}</div>`
          : `<div class="usage-empty">${escapeHtml(tt('bailian_usage_console_hint'))}</div>`
    } else if (mode === 'zhipu') {
      // Coding Plan meters credits against a rolling five-hour allowance and a
      // weekly one, not per token. The engine reads both from the console's
      // monitor route with the plan key, so with windows this draws the same bar
      // the Codex and Kimi gauges draw; a connected plan whose read answered no
      // window says where the allowance lives instead of falling through to the
      // BYO wording, which would wrongly claim the user is billed per token.
      body = data.windows && data.windows.length
        ? renderUsageWindows(data)
        : `<div class="usage-empty">${escapeHtml(tt('zhipu_usage_console_hint'))}</div>`
    } else if (mode === 'ark') {
      // Coding Plan's allowance is not readable with the plan key: measured with a
      // live key, every candidate allowance route on the coding gateway answers 404,
      // and the service's published usage APIs are control-plane actions wanting an
      // account signature or a console session. The engine still probes those routes
      // and projects windows if one ever answers, so draw them when present; until
      // then this says where the allowance lives rather than falling through to the
      // BYO wording, which would wrongly claim the user is billed per token.
      body = data.windows && data.windows.length
        ? renderUsageWindows(data)
        : `<div class="usage-empty">${escapeHtml(tt('ark_usage_console_hint'))}</div>`
    } else {
      // 预置 key 型订阅（DeepSeek / ...）：上游按量计费，无额度接口。
      body = `<div class="usage-empty">${escapeHtml(tt('usage_byok_metered'))}</div>`
    }
  }
  return renderUsageProvider(name, data, body)
}

const usageDashboardRequests = new WeakMap<HTMLElement, number>()

async function loadUsageDashboardInto(body: HTMLElement) {
  const revision = (usageDashboardRequests.get(body) || 0) + 1
  usageDashboardRequests.set(body, revision)
  const sessionId = window.currentSessionId
  const isCurrent = () => body.isConnected && usageDashboardRequests.get(body) === revision
    && sessionId === window.currentSessionId
  body.innerHTML = (window as { klsLoading?: { render: () => string } }).klsLoading!.render()
  try {
    const res = await klausApi.usage?.subscriptions?.(sessionId)
    if (!isCurrent()) return
    if (!res?.ok || !res.snapshot) throw new Error(res?.error || 'unavailable')
    body.innerHTML = renderUsageSnapshot(res.snapshot)
  } catch (err) {
    if (!isCurrent()) return
    body.innerHTML = `<div class="usage-empty usage-error-text">${escapeHtml(tt('usage_error'))} · ${escapeHtml((err as Error | null)?.message || String(err))}</div>`
  }
}

function openUsageDashboard(anchorBtn: HTMLElement) {
  const existing = document.querySelector('.usage-popover')
  if (existing) { existing.dispatchEvent(new CustomEvent('usage:close')); return }
  const pop = document.createElement('div')
  pop.className = 'usage-popover'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', tt('usage_dashboard_aria'))
  pop.innerHTML = `
    <div class="usage-popover-head">
      <span class="usage-popover-title">${escapeHtml(tt('usage_dashboard_title'))}</span>
      <button class="usage-popover-refresh" data-refresh aria-label="${escapeHtml(tt('usage_refresh'))}">
        ${klausIcon('refresh', { size: 14 })}
      </button>
    </div>
    <div class="usage-popover-body" id="usage-popover-body"></div>`
  document.body.appendChild(pop)
  anchorBtn.setAttribute('aria-expanded', 'true')
  // 底部紧贴 gauge 按钮顶部，左缘对齐侧栏内边距（同 user-menu 的上浮方向）。
  const rect = anchorBtn.getBoundingClientRect()
  pop.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`
  pop.style.left = '8px'
  const body = pop.querySelector('#usage-popover-body')
  const refresh = () => { void loadUsageDashboardInto(body as HTMLElement) }
  const unsubscribePreferences = klausApi.on.appPreferencesChanged?.(({ key }: { key?: string }) => {
    if (key === 'composer.main_model' || key === 'auth_mode') refresh()
  })
  const close = () => {
    unregisterOverlay('usage-popover')
    pop.remove()
    // Selected look keys off aria-expanded (styles.css); clear it on every
    // close path, including the toggle-out branch below.
    anchorBtn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('click', onDocClick)
    window.removeEventListener('klaus:auth-mode-changed', refresh)
    window.removeEventListener('klaus:session-change', refresh)
    unsubscribePreferences?.()
  }
  registerOverlay('usage-popover', close)
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  const onDocClick = (e: MouseEvent) => { if (!pop.contains(e.target as Node) && e.target !== anchorBtn && !anchorBtn.contains(e.target as Node)) close() }
  pop.addEventListener('usage:close', close)
  document.addEventListener('keydown', onKey)
  document.addEventListener('click', onDocClick)
  window.addEventListener('klaus:auth-mode-changed', refresh)
  window.addEventListener('klaus:session-change', refresh)
  pop.querySelector('[data-refresh]')?.addEventListener('click', (e) => { e.stopPropagation(); loadUsageDashboardInto(body as HTMLElement) })
  loadUsageDashboardInto(body as HTMLElement)
}

document.getElementById('sidebar-user-usage')?.addEventListener('click', (e) => {
  e.stopPropagation()
  closeUserMenu()
  claimOverlay('usage-popover')
  openUsageDashboard(e.currentTarget as HTMLElement)
})
document.addEventListener('click', closeUserMenu)
initLangSubmenu()
document.getElementById('menu-settings')?.addEventListener('click', () => {
  closeUserMenu()
  toggleSettings()
})
document.getElementById('menu-language')?.addEventListener('click', (e) => {
  e.stopPropagation()
  const langSubmenu = toggleUserSubmenu('user-menu-lang')
  if (!langSubmenu) return
  // initLangSubmenu 在脚本加载时快照 currentLang('en' 初始值),而语言偏好是 boot 里异步
  // 读回的——打开时按 live 值重同步勾选,否则首开永远勾在 English 而界面已是中文
  updateLangSubmenuActive(typeof window.getLang === 'function' ? (window.getLang() || 'en') : (window.currentLang || 'en'))
  positionUserSubmenu(langSubmenu, e.currentTarget as HTMLElement)
})
document.getElementById('menu-theme')?.addEventListener('click', async (e) => {
  e.stopPropagation()
  const anchor = e.currentTarget
  const submenu = toggleUserSubmenu('user-menu-theme')
  if (!submenu) return
  await renderThemeSubmenu()
  positionUserSubmenu(submenu, anchor as HTMLElement)
})
document.getElementById('menu-font')?.addEventListener('click', async (e) => {
  e.stopPropagation()
  const anchor = e.currentTarget
  const submenu = toggleUserSubmenu('user-menu-font')
  if (!submenu) return
  await renderFontSubmenu()
  positionUserSubmenu(submenu, anchor as HTMLElement)
})
// Theme and font edits apply live, so the submenu stays open while the user
// compares the result — hence stopPropagation against the close-on-click guard.
document.getElementById('user-menu-theme')?.addEventListener('click', async (e) => {
  e.stopPropagation()
  const submenu = e.currentTarget as HTMLElement
  const modeBtn = (e.target as HTMLElement).closest('[data-theme-mode]')
  const paletteBtn = (e.target as HTMLElement).closest('[data-theme-palette]')
  if (!modeBtn && !paletteBtn) return
  if (modeBtn) {
    // A different variant offers a different palette list, so this rebuilds.
    await window.setAppearanceThemeChoice!((modeBtn as HTMLElement).dataset.themeMode)
    await renderThemeSubmenu()
    const anchor = document.getElementById('menu-theme')
    if (anchor) positionUserSubmenu(submenu, anchor as HTMLElement)
    return
  }
  const pref = await window.ensureAppearancePreferences?.()
  await window.setAppearanceCodeTheme!(window.resolveAppearanceVariant?.(pref.themeChoice), (paletteBtn as HTMLElement).dataset.themePalette)
  await syncThemeSubmenuActive()
})
document.getElementById('user-menu-font')?.addEventListener('click', async (e) => {
  e.stopPropagation()
  const stepBtn = (e.target as HTMLElement).closest('[data-font-step]')
  if (!stepBtn) return
  const field = (stepBtn as HTMLElement).dataset.fontField
  const pref = await window.ensureAppearancePreferences?.()
  await window.setAppearanceFontSize!(field, pref[field!] + Number((stepBtn as HTMLElement).dataset.fontStep))
  await syncFontSubmenu()
})
document.getElementById('menu-feedback')?.addEventListener('click', async () => {
  closeUserMenu()
  await submitSuggestion()
})
document.getElementById('menu-help')?.addEventListener('click', () => {
  closeUserMenu()
  ;(window as any).klausMenuHelp.documentation()
})
document.getElementById('menu-logout')?.addEventListener('click', async () => {
  closeUserMenu()
  try {
    if (typeof klausApi.klausAuth?.logout !== 'function') throw new Error(tt('profile_logout_failed'))
    const result = await klausApi.klausAuth.logout()
    if ((result as any)?.ok === false) throw new Error((result as any).error || tt('profile_logout_failed'))
    // Clear presentation-only profile data only after the credential store has
    // confirmed logout. A failed logout must leave the signed-in UI intact.
    try {
      await Promise.all([
        klausApi.settings.kv.set('display_name', ''),
        klausApi.settings.kv.set('avatar_data_url', ''),
        klausApi.settings.kv.set('email', ''),
      ])
    } catch (error: any) {
      showToast(error?.message || tt('settings_failed'))
    }
    void syncGuestSigninUi()
  } catch (error: any) {
    showToast(error?.message || tt('profile_logout_failed'))
  }
})

// Settings 侧栏（返回键 + tab 导航）绑定随骨架迁 React 岛
// （src/pages/settings/settings-nav.tsx），此处不再持有静态 DOM 绑定。

function openSubagent(taskId: string) {
  const sessionId = window.currentSessionId || ''
  const task = (tasksBySession.get(sessionId) || {})[taskId]
  if (!task) return
  const title = subagentDisplayName(taskId, task)
  const tabs = window.KlausPanelTabs as any
  if (tabs?.openSubagent) {
    void tabs.openSubagent(taskId, title)
    return
  }
  void activateSubagent(taskId)
}

function openSubagentConversation(conversationId: string) {
  return navigateToSubagentConversation(conversationId, {
    selectedSessionId: () => window.currentSessionId || '',
    tasks: sessionId => tasksBySession.get(sessionId) || {},
    snapshot: sessionId => klausApi.agents.snapshot(sessionId),
    merge: mergeAgentTasks,
    open: openSubagent,
    unavailable: () => showToast(tt('subagent_conversation_unavailable')),
  })
}

async function activateSubagent(taskId: string) {
  const sessionId = window.currentSessionId || ''
  const task = (tasksBySession.get(sessionId) || {})[taskId]
  if (!task) return
  activeSubagentTaskId = taskId
  markAgentRead(sessionId, taskId)
  openArtifactsPanel('subagent')
  await enterTeammateView(taskId)
}

function closeSubagent(taskId: string) {
  if (activeSubagentTaskId !== taskId) return
  activeSubagentTaskId = null
  exitTeammateView()
}

function closeAllSubagentTabs() {
  activeSubagentTaskId = null
  exitTeammateView()
  window.KlausPanelTabs?.clearSubagents?.()
  notifySubagentsChanged()
}

;(window as any).KlausSubagentPanel = {
  activateByTaskId: (taskId: string) => activateSubagent(taskId),
  closeByTaskId: (taskId: string) => closeSubagent(taskId),
  getActiveTaskId: () => activeSubagentTaskId,
  listTasks: () => Object.entries(tasksBySession.get(window.currentSessionId || '') || {}),
  getTask: (taskId: string) => (tasksBySession.get(window.currentSessionId || '') || {})[taskId] || null,
  getTaskByConversationId: (conversationId: string) => {
    const tasks = tasksBySession.get(window.currentSessionId || '') || {}
    const entry = Object.entries(tasks).find(([taskId, task]) => subagentConversationId(taskId, task) === conversationId)
    return entry ? { taskId: entry[0], task: entry[1] } : null
  },
  loadTranscript: async (taskId: string) => {
    const sessionId = window.currentSessionId || ''
    const task = (tasksBySession.get(sessionId) || {})[taskId]
    if (!task) return []
    if (task.messages?.length) return task.messages
    const result = task.agentId ? await klausApi.agents.history(sessionId, task.agentId) : null
    return result?.messages || []
  },
  openByTaskId: (taskId: string) => openSubagent(taskId),
  openByConversationId: (conversationId: string) => openSubagentConversation(conversationId),
}

// ==================== Sub-agent (teammate) transcript view ====================
//
// The chosen child has its own live store in the right panel. Opening it does
// not interrupt the main transcript or change the parent's run state.
let viewingAgentTaskId: string | null = null
let viewingAgentSessionId: string | null = null
let _teammateRefreshTimer: ReturnType<typeof setTimeout> | null = null

function paintSubAgentBanner(taskId: string, task: AgentTask | null) {
  const avatarEl = document.getElementById('subagent-panel-avatar')
  const titleEl = document.getElementById('subagent-panel-title')
  const descriptionEl = document.getElementById('subagent-panel-description')
  const modelEl = document.getElementById('subagent-panel-model')
  const name = task ? subagentDisplayName(taskId, task) : ''
  if (avatarEl) {
    const status = task ? subagentDisplayStatus(task) : ''
    const avatarKey = task ? `${task.avatarId ?? ''}:${subagentConversationId(taskId, task)}:${status}` : ''
    if (avatarEl.dataset.avatarKey !== avatarKey) {
      avatarEl.dataset.avatarKey = avatarKey
      avatarEl.innerHTML = task
        ? subagentAvatarHtml(task.avatarId, 24, status, subagentConversationId(taskId, task))
        : ''
    }
  }
  if (titleEl) titleEl.textContent = name
  if (descriptionEl) {
    const description = task ? subagentTaskText(task) : ''
    descriptionEl.textContent = description.replace(/\s+/g, ' ').trim() === name ? '' : description
  }
  if (modelEl) paintSubagentModel(modelEl, task)
}

function updateTeammateBanner() {
  const taskId = viewingAgentTaskId
  const sessionId = viewingAgentSessionId
  if (!taskId || !sessionId) return
  const task = (tasksBySession.get(sessionId) || {})[taskId] || null
  paintSubAgentBanner(taskId, task)
}

// Legacy hook removed — side-tasks.js now uses klausSideSurfaceActivate +
// renderHistoryMessage via withSurface, rendering the side task's transcript with
// the exact same pipeline as the main chat (tool cards / thinking folds / etc.).

// Every subagent uses the main transcript store and renderer. History is only
// the initial/replay layer; normalized child events keep the mounted tree live.
let teammateSticker: BottomSticker | null = null

async function enterTeammateView(taskId: string) {
  const sessionId = window.currentSessionId || ''
  const task = (tasksBySession.get(sessionId) || {})[taskId]
  if (!task) return
  viewingAgentTaskId = taskId
  viewingAgentSessionId = sessionId
  cancelTeammateViewRefresh()
  paintSubAgentBanner(taskId, task)
  const subEl = document.getElementById('subagent-messages')
  if (!subEl) return
  subEl.setAttribute('data-klaus-tooltips', 'off')
  const streamId = prepareSubagentStream(sessionId, taskId, task)
  unmountReactTranscript(subEl)
  subEl.innerHTML = ''
  teammateSticker ||= createBottomSticker({ scrollEl: subEl })
  teammateSticker.resumeFollowing()
  mountReactTranscript(streamId, subEl, { readOnly: true, contextSessionId: sessionId })
  await loadSessionHistory(streamId)
  if (viewingAgentTaskId === taskId && viewingAgentSessionId === sessionId) {
    teammateSticker.scrollToBottom({ force: true })
  }
}

// Task snapshots update the banner and attach a newly discovered child id.
// Token and tool updates go straight to the child's existing stream store.
function scheduleTeammateViewRefresh(sessionId: string) {
  if (!viewingAgentTaskId || sessionId !== viewingAgentSessionId || _teammateRefreshTimer) return
  _teammateRefreshTimer = setTimeout(() => {
    _teammateRefreshTimer = null
    void refreshTeammateView()
  }, 100)
}

function cancelTeammateViewRefresh() {
  if (!_teammateRefreshTimer) return
  clearTimeout(_teammateRefreshTimer)
  _teammateRefreshTimer = null
}

async function refreshTeammateView() {
  const taskId = viewingAgentTaskId
  const sessionId = viewingAgentSessionId
  if (!taskId || !sessionId) return
  const task = (tasksBySession.get(sessionId) || {})[taskId]
  const subEl = document.getElementById('subagent-messages')
  if (!task || !subEl) return
  paintSubAgentBanner(taskId, task)
  const streamId = prepareSubagentStream(sessionId, taskId, task)
  mountReactTranscript(streamId, subEl, { readOnly: true, contextSessionId: sessionId })
  if (getSessionStream(streamId).history === null || getSessionStream(streamId).historyStale) {
    await loadSessionHistory(streamId)
  }
}

function exitTeammateView() {
  if (!viewingAgentTaskId) return
  viewingAgentTaskId = null
  viewingAgentSessionId = null
  cancelTeammateViewRefresh()
  const subEl = document.getElementById('subagent-messages')
  if (subEl) {
    unmountReactTranscript(subEl)
    subEl.innerHTML = ''
  }
  paintSubAgentBanner('', null)
}

// File attach
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) addFiles([...fileInput.files])
  fileInput.value = ''
})

// No type whitelist any more. Images are inlined as content parts and every
// other file travels to the model as a path it opens with its own read tool
// (composer/attachment-policy.ts), so there is no type left that has nowhere to
// go. Size is still worth catching at add time rather than at send time: a send
// time refusal lands after the composer is cleared and the optimistic bubble is
// on screen, which looks like a message that was sent and ignored.
function rejectOversizedAttachment(name: string, size: number, mimeType?: string | null) {
  const limit = attachmentSizeRejection(name, size, mimeType)
  if (limit === null) return false
  showToast(tt('file_too_large').replace('{size}', formatFileSize(limit)) + name)
  return true
}

function addFiles(files: File[]) {
  for (const f of files) {
    if (rejectOversizedAttachment(f.name, f.size, f.type)) continue
    const entry: PendingFileEntry = { file: f, objectUrl: null, uploadPath: null, uploading: true }
    if (isInlineImage(f.name, f.type)) entry.objectUrl = URL.createObjectURL(f)
    pendingFiles.push(entry)
    // Upload via IPC — saves to ~/.klaus/uploads/
    uploadFileEntry(entry)
  }
  renderPreviews()
  updateSendBtn()
}

function basenameFromPath(path: string) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || 'attachment'
}

function addFilePaths(paths: string[]) {
  const uniquePaths = [...new Set((paths || []).filter(Boolean))]
  for (const path of uniquePaths) {
    const name = basenameFromPath(path as string)
    // No size guard here on purpose: a path import carries no size in the
    // renderer (the entry is created with `size: 0`), so the host enforces the
    // same ceiling when it copies the file — see `chat_upload_path`.
    const entry = {
      file: { name, type: '', size: 0 },
      objectUrl: null,
      uploadPath: null,
      uploading: true,
      sourcePath: path,
    }
    pendingFiles.push(entry)
    uploadFileEntry(entry)
  }
  renderPreviews()
  updateSendBtn()
}

function countPlainTextLines(text: string) {
  const value = String(text || '')
  if (!value) return 0
  return value.split(/\r\n|\r|\n/).length
}

function buildTextAttachmentEntry(text: string, name: string, kind: 'pasted-text' | 'selected-text'): PendingFileEntry {
  const normalizedText = String(text || '')
  const lineCount = countPlainTextLines(normalizedText)
  return {
    kind,
    text: normalizedText,
    file: {
      name,
      type: 'text/markdown',
      size: new Blob([normalizedText], { type: 'text/markdown' }).size,
    },
    objectUrl: null,
    uploadPath: null,
    uploading: false,
    previewText: pastedTextPreview(normalizedText),
    lineCount,
  }
}

/**
 * A large paste becomes a host-owned file reference: the composer tray keeps
 * the path, the one-line preview and the character count. The text rides the
 * pending entry only until submission, where it lands in the provider-invisible
 * display snapshot — the model-facing payload carries the path reference alone.
 */
function buildPastedReferenceEntry(reference: { path: string; preview: string; characterCount: number; text?: string }): PendingFileEntry {
  return {
    kind: 'pasted-text',
    ...(reference.text ? { text: reference.text } : {}),
    file: { name: 'pasted text', type: 'text/plain', size: reference.characterCount },
    objectUrl: null,
    uploadPath: reference.path,
    uploading: false,
    previewText: reference.preview,
    characterCount: reference.characterCount,
  }
}

async function createPastedTextAttachment(text: string, current: () => boolean = () => true): Promise<PendingFileEntry | null> {
  try {
    const result = await klausApi.chat.pastedTextCreate(text) as { ok?: boolean; path?: string; characterCount?: number; error?: string } | null
    if (!result?.ok || !result.path) {
      if (current()) showToast(tt(result?.error === 'pasted_text_too_large' ? 'pasted_text_too_large' : 'pasted_text_restore_error'))
      return null
    }
    return buildPastedReferenceEntry({
      path: result.path,
      preview: pastedTextPreview(text),
      characterCount: Number.isFinite(result.characterCount) ? Number(result.characterCount) : text.length,
      text,
    })
  } catch {
    if (current()) showToast(tt('pasted_text_restore_error'))
    return null
  }
}

/**
 * "Show in text field": read the stored paste back and put it into the editor
 * as ordinary editable text, then drop the reference card and its host file —
 * the text now lives in the composer, exactly like removing the attachment.
 */
/** Read a stored paste back for editing; the snapshot text is the fallback
 *  when the host file is gone or over the editable bound. */
async function readPastedTextForRestore(entry: PendingFileEntry, current: () => boolean): Promise<string | null> {
  const snapshot = typeof entry.text === 'string' && entry.text && entry.text.length <= PASTE_RESTORE_CHAR_LIMIT
    ? entry.text : null
  const path = entry.uploadPath
  if (!path) return snapshot
  try {
    const result = await klausApi.chat.pastedTextRead(path) as { ok?: boolean; text?: string; error?: string } | null
    if (result?.error === 'pasted_text_restore_too_large'
      || result?.ok && typeof result.text === 'string' && result.text.length > PASTE_RESTORE_CHAR_LIMIT) {
      if (current()) showToast(tt('pasted_text_too_large'))
      return null
    }
    if (result?.ok && typeof result.text === 'string') return result.text
    if (snapshot) return snapshot
    if (current()) showToast(tt(result?.error === 'pasted_text_restore_too_large' ? 'pasted_text_too_large' : 'pasted_text_restore_error'))
    return null
  } catch {
    if (snapshot) return snapshot
    if (current()) showToast(tt('pasted_text_restore_error'))
    return null
  }
}

/**
 * "Show in text field": the stored paste returns to the editor as ordinary
 * editable text at the caret, and the reference card plus its host file go
 * away — the text now lives in the composer, exactly like removing the card.
 */
async function restorePastedTextToComposer(entry: PendingFileEntry) {
  const owner = window.currentSessionId
  const navigationToken = goalInteractions.token(null)
  const current = () => window.currentSessionId === owner && goalInteractions.token(null) === navigationToken && pendingFiles.includes(entry)
  const text = await readPastedTextForRestore(entry, current)
  if (text == null || !current()) return
  const previous = inputEl.value, start = inputEl.selectionStart ?? previous.length, end = inputEl.selectionEnd ?? start
  const range = expandSelectionAcrossInlineQuotes(start, end, [...inlineQuoteEntries(), ...composerReferenceEntries()])
  if (mainComposerControl) {
    mainComposerControl.replaceRange(range.start, range.end, text, 'insertFromPaste', 'literal')
  } else insertDefaultTextPaste(previous, range.start, range.end, text)
  focusComposerInput(inputEl, range.start + text.length)
  pendingFiles = pendingFiles.filter(candidate => candidate !== entry)
  mainAttachmentHistory.discard(entry)
  renderPreviews()
  autoResize()
  updateSendBtn()
  persistComposerDraft()
  if (entry.uploadPath) void klausApi.chat.pastedTextRemove(entry.uploadPath).catch(() => undefined)
}

function buildSelectedTextEntry(text: string): PendingFileEntry {
  return {
    ...buildTextAttachmentEntry(String(text || ''), 'selected text', 'selected-text'),
    quoteId: `quote-${Date.now().toString(36)}-${(++inlineQuoteSeq).toString(36)}`,
  }
}

/**
 * Restore a pasted card into the composer tray. Reference cards reuse their
 * host file; legacy text-only cards (histories written before references
 * existed) get a host file of their own so every card has one shape.
 */
function addPastedTextToComposer(text: string, reference?: { path?: string; preview?: string; characterCount?: number }) {
  const normalizedText = String(text || '')
  if (reference?.path) {
    pendingFiles.push(buildPastedReferenceEntry({
      path: reference.path,
      preview: reference.preview || pastedTextPreview(normalizedText),
      characterCount: Number.isFinite(reference.characterCount) ? Number(reference.characterCount) : normalizedText.length,
      ...(normalizedText ? { text: normalizedText } : {}),
    }))
    renderPreviews()
    updateSendBtn()
    return
  }
  if (!normalizedText) return
  void attachMainPastedText(normalizedText)
}

function displayOffsetToComposerOffset(requestOffset: number) {
  return composerOffsetFromDisplayOffset(
    requestOffset,
    inputEl.value.length,
    selectedSlashCommandRange,
    selectedSlashCommand ? `/${selectedSlashCommand.name}`.length : 0,
    0,
  )
}

function restoreDisplayCardsToComposer(selectedTextAttachments: any, pastedCards: any) {
  const pasted = (Array.isArray(pastedCards) ? pastedCards : [])
    .map((entry: any, index: number) => ({ ...entry, originalIndex: index }))
  const selections = (Array.isArray(selectedTextAttachments) ? selectedTextAttachments : [])
    .map((entry: any, index: number) => ({ ...entry, kind: 'selected-text', originalIndex: index }))
    .filter((entry: any) => entry?.text)
    .sort((a: any, b: any) => {
      const offsetDelta = Number(b.requestOffset) - Number(a.requestOffset)
      if (offsetDelta) return offsetDelta
      const orderDelta = Number(b.displayOrder ?? b.originalIndex) - Number(a.displayOrder ?? a.originalIndex)
      return orderDelta || b.originalIndex - a.originalIndex
    })
  // Pasted cards return to the tray as references; quotes re-inline at their
  // authored offsets, last first so earlier offsets stay valid.
  for (const entry of pasted) {
    addPastedTextToComposer(entry.text || '', {
      path: typeof entry.path === 'string' ? entry.path : undefined,
      preview: entry.preview || entry.previewText,
      characterCount: entry.characterCount,
    })
  }
  for (const entry of selections) {
    if (entry.quoteId && pendingFiles.some(candidate => candidate.quoteId === entry.quoteId)) continue
    addChatSelectionToComposer(entry.text, entry.requestOffset, entry)
  }
}

// A selected transcript range becomes a pending quote chip. Submission encodes
// it in a text envelope that the engine persists unchanged; replay splits the
// quote from the user's request again.
function addChatSelectionToComposer(text: string, requestOffset?: number, metadata: Partial<PendingFileEntry> = {}) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return
  const entry = buildSelectedTextEntry(normalized)
  if (metadata.quoteId) entry.quoteId = metadata.quoteId
  if (metadata.previewText) entry.previewText = metadata.previewText
  if (metadata.specAnnotation) entry.specAnnotation = { ...metadata.specAnnotation }
  const start = Number.isInteger(requestOffset)
    ? displayOffsetToComposerOffset(Number(requestOffset))
    : (inputEl.selectionStart ?? inputEl.value.length)
  const end = Number.isInteger(requestOffset)
    ? start
    : (inputEl.selectionEnd ?? inputEl.selectionStart ?? inputEl.value.length)
  const inlineEntries = inlineQuoteEntries()
  const expanded = expandSelectionAcrossInlineQuotes(start, end, [...inlineEntries, ...composerReferenceEntries()])
  if (!composerTokenDataWithinDepth(entry)) {
    // Keep readable quote text without creating a partially attached invalid atom.
    mainComposerControl?.replaceRange(expanded.start, expanded.end, normalized, 'insertText', 'literal')
    focusComposerInput(inputEl, expanded.start + normalized.length)
    renderPreviews()
    autoResize()
    updateSendBtn()
    persistComposerDraft()
    return
  }
  const placeholder = inlineQuotePlaceholder()
  const inserted = insertInlineQuotePlaceholder(
    inputEl.value,
    expanded.start,
    expanded.end,
    placeholder,
  )
  syncComposerTokenRangesAfterInput(inputEl.value, inserted.value)
  const synced = replaceInlineTokenRange(expanded.start, expanded.end, placeholder.length, inlineEntries)
  if (synced.removed.length > 0) pendingFiles = pendingFiles.filter(candidate => !synced.removed.includes(candidate))
  entry.range = inserted.range
  pendingFiles.push(entry)
  mainComposerControl?.replaceRange(expanded.start, expanded.end, placeholder, 'insertText')
  try { inputEl.setSelectionRange(inserted.caret, inserted.caret) } catch {}
  focusComposerInput(inputEl, inserted.caret)
  renderPreviews()
  renderSelectedSlashCommand()
  autoResize()
  updateSendBtn()
  persistComposerDraft()
}

// 选区引用浮层（transcript/quote-selection.tsx）的注入点：主转录选中 → 主 composer。
window.klausQuoteAddToChat = addChatSelectionToComposer
window.klausPastedTextAddToChat = addPastedTextToComposer
window.klausDisplayCardsAddToChat = restoreDisplayCardsToComposer

async function restoreRewoundMessage(sessionId: string, prepared: RestoredMessageDraft): Promise<void> {
  if (window.currentSessionId !== sessionId) await switchSession(sessionId)
  if (window.currentSessionId !== sessionId) throw new Error(tt('msg_rewind_restore_failed'))
  pendingSendAfterUpload = null
  for (const entry of pendingFiles) {
    if (entry.objectUrl?.startsWith('blob:')) disposeAttachmentObjectUrl(entry)
  }
  // Seed files first: restoring quote and paste cards appends their own entries.
  pendingFiles = pendingEntriesFromPrepare(prepared.attachments, path => window.klaus?.media?.url?.(path, sessionId) || '')
  const draft = composerDraftFromDisplayMetadata(prepared.displayMetadata)
  const cards = restoredMessageTextCards(prepared)
  updateComposerQuoteOffsets()
  setComposerText(draft ? { ...draft, text: cards.text } : cards.text)
  restoreDisplayCardsToComposer(cards.selectedTextAttachments, cards.pastedCards)
  renderPreviews()
  autoResize()
  updateSendBtn()
  persistComposerDraft()
  focusComposerInput(inputEl, inputEl.value.length)
}
window.restoreRewoundMessage = restoreRewoundMessage

configureInlineUserEditing({
  commands: sessionId => loadScopedSlashCommands(sessionId),
  matches: slashCommandMatchesSearch,
  menuActions: composerDiscoveryMenuActions,
  reference: resolveEditorMentionReference,
  failure: error => String((error as Error)?.message || error),
  prepare: async (sessionId, handle) => {
    const prepared = await klausApi.chat.editPrepare(sessionId, handle.uuid, handle.turnId || undefined)
    if (prepared?.ok !== true) throw new Error(editMessageFailure(prepared?.reason))
    return prepared
  },
  submit: async state => {
    const { sessionId, handle, draft, prepared } = state
    const files = inlineMessageEditFiles(prepared, draft, path => window.klaus?.media?.url?.(path, sessionId) || '')
    const payload = buildOutgoingPayload(draft.text, files, draft.slashCommand?.command || null, sessionId, draft.references, draft.document)
    const observation = observeEditedUserTurn(sessionId, handle, new Set((getSessionStream(sessionId)?.liveUnits || []).map(unit => String(unit.key))))
    try {
      const result = await klausApi.chat.editMessage(sessionId, handle.uuid, payload.finalText, sentUserDisplayMetadata(payload), payload.media, handle.turnId || undefined)
      if (result?.ok !== true) throw new Error(editMessageFailure(result?.reason))
      if (inlineUserEdits.snapshot(state.key) !== state) return
      renderLocalUserPayload(sessionId, payload, { edit: observation.snapshot })
      void loadSessionHistory(sessionId)
    } finally { observation.dispose() }
  },
})

function editMessageFailure(reason: unknown): string {
  return reason === 'turn-in-progress' ? tt('msg_edit_busy')
    : reason === 'not-the-last-message' ? tt('msg_edit_not_last')
    : reason === 'turn-not-in-history' || reason === 'uuid-not-found' ? tt('msg_edit_prepare_stale') : tt('msg_edit_failed')
}

async function uploadAttachment(entry: PendingFileEntry) {
  if (entry.sourcePath) {
    const result = await klausApi.chat.uploadFilePath(entry.sourcePath)
    if (!result?.ok) throw new Error(result?.error || 'upload_failed')
    return result
  }
  const buffer = await (entry.file as File).arrayBuffer()
  return klausApi.chat.uploadFile(entry.file.name, entry.file.type, buffer)
}

function mainAttachmentRetained(entry: PendingFileEntry) {
  return pendingFiles.includes(entry) || mainAttachmentHistory.retains(entry)
    || [...sessionPendingFiles].some(([scope, files]) => scope !== window.currentSessionId && files.includes(entry))

}

function removeMainAttachment(entry: PendingFileEntry) {
  for (const [scope, files] of sessionPendingFiles) sessionPendingFiles.set(scope, files.filter((candidate: PendingFileEntry) => candidate !== entry))
  pendingFiles = pendingFiles.filter(candidate => candidate !== entry)
  mainAttachmentHistory.discard(entry)
}

async function uploadFileEntry(entry: PendingFileEntry) {
  try {
    const result = await uploadAttachment(entry)
    entry.uploadPath = result.path
    entry.file = { name: result.name || entry.file.name, type: result.type || entry.file.type || '', size: result.size ?? entry.file.size ?? 0 }
    entry.lineCount = result.lineCount ?? null
  } catch {
    const active = pendingFiles.includes(entry)
    removeMainAttachment(entry)
    disposeAttachmentObjectUrl(entry)
    entry.uploading = false
    if (active) { showToast(tt('upload_failed_short') + entry.file.name); renderPreviews(); updateSendBtn(); releaseDeferredSendIfReady() }
    return
  }
  entry.uploading = false
  if (pendingFiles.includes(entry)) { renderPreviews(); updateSendBtn(); releaseDeferredSendIfReady() }
}

async function attachMainPastedText(text: string) {
  const pending = pendingPastedTextEntry(text)
  pending.previewText = pastedTextPreview(text)
  pendingFiles.push(pending)
  renderPreviews()
  updateSendBtn()
  const result = await settlePastedTextAttachment(pending, text, {
    create: value => createPastedTextAttachment(value, () => pendingFiles.includes(pending)), retained: () => mainAttachmentRetained(pending),
    removeStored: path => klausApi.chat.pastedTextRemove(path),
  })
  const active = pendingFiles.includes(pending)
  if (result === 'failed') { removeMainAttachment(pending); if (active) cancelDeferredSend() }
  if (active) { renderPreviews(); updateSendBtn(); persistComposerDraft(); if (result === 'ready') releaseDeferredSendIfReady() }
}

function fileExtLabel(name: string) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  return match ? match[1].slice(0, 4).toUpperCase() : 'FILE'
}

function formatFileSize(size: number | undefined) {
  if (size === undefined || !Number.isFinite(size) || size <= 0) return ''
  return formatAttachmentSize(size)
}

function formatPreviewMeta(entry: PendingFileEntry) {
  if (entry.uploading) return tt('uploading_label')
  if ((entry.lineCount ?? 0) > 0) {
    return `${entry.lineCount} ${tt('tool_lines') || 'lines'}`
  }
  return formatFileSize(entry.file?.size)
}

async function openFileAttachmentPreview(entry: PendingFileEntry, ownerSessionId = window.currentSessionId) {
  if (!entry || entry.uploading || !entry.uploadPath) return
  let sessionId = ownerSessionId
  try {
    let result
    if (/[/\\]$/.test(entry.uploadPath)) result = await klausApi.artifacts.reveal(entry.uploadPath)
    else {
      sessionId ||= await ensureSession()
      result = await klausApi.artifacts.openWindow(sessionId, entry.uploadPath, entry.file?.name || '')
    }
    if (result?.error) throw new Error(result.error)
  } catch (err) {
    ingestChatEvent({ type: 'api_error', sessionId, error: tt('preview_failed_short') + (entry.file?.name || 'file') })
  }
}
// Sent pasted-text cards delegate their click here: the card knows its session
// and path, the preview surface needs both.
;(window as any).openPastedTextPreview = (sessionId: string, path: string) => {
  if (!sessionId || !path) return
  void openFileAttachmentPreview({
    kind: 'pasted-text',
    file: { name: 'pasted text', type: 'text/plain', size: 0 },
    objectUrl: null,
    uploadPath: path,
    uploading: false,
  }, sessionId)
}

function renderPreviews() {
  previewsApi?.render(pendingFiles)
}

// Drag-drop
document.addEventListener('dragover', (e) => {
  if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
  e.preventDefault(); dropOverlay.classList.add('active')
})
document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) dropOverlay.classList.remove('active') })
function handleComposerFileDrop(e: DragEvent) {
  dropOverlay.classList.remove('active')
  if (e.defaultPrevented || !Array.from(e.dataTransfer?.types || []).includes('Files')) return
  e.preventDefault()
  const target = document.elementFromPoint(e.clientX, e.clientY) || e.target as Element | null
  if (target?.closest('.inline-user-edit')) return
  const { files, directories, orderedFiles } = droppedFileEntries(e.dataTransfer)
  const ready = directoryEntriesFromDrop(directories)
  const ordinary = new Set(files)
  const sideComposer = target?.closest('#side-input-wrapper')
  for (const file of orderedFiles) {
    const entry = ready.get(file)
    if (sideComposer) {
      if (entry) sideComposer.dispatchEvent(new CustomEvent('composer-directory-drop', { detail: [entry] }))
      else if (ordinary.has(file)) sideComposer.dispatchEvent(new CustomEvent('composer-attachment-drop', { detail: [file] }))
    } else if (entry) {
      if (!pendingFiles.some(candidate => candidate.uploadPath === entry.uploadPath)) pendingFiles.push(entry)
    } else if (ordinary.has(file)) addFiles([file])
  }
  if (!sideComposer && ready.size) { renderPreviews(); updateSendBtn() }
}
document.addEventListener('drop', handleComposerFileDrop)

function directoryEntriesFromDrop(directories: Array<{ name: string; file: File | null }>): Map<File, PendingFileEntry> {
  const entries = new Map<File, PendingFileEntry>(), unavailable: string[] = [], seen = new Set<string>()
  for (const { name, file } of directories) {
    const sourcePath = file ? klausApi.chat.localFilePath?.(file) || '' : ''
    if (!file || !sourcePath || sourcePath.includes('\0')) { unavailable.push(name); continue }
    // A trailing separator preserves directory identity in stored path references.
    const path = sourcePath.endsWith('/') ? sourcePath : sourcePath + '/'
    if (seen.has(path)) continue
    seen.add(path)
    entries.set(file, { file: { name, type: 'inode/directory', size: 0 }, objectUrl: null,
      uploadPath: path, sourcePath, uploading: false })
  }
  if (unavailable.length) showToast(tt('attachment_directory_unsupported') + unavailable.join(', '))
  return entries
}

// Entry identity distinguishes a directory from an unrelated same-name file.
function droppedFileEntries(data: DataTransfer | null): { files: File[]; directories: Array<{ name: string; file: File | null }>; orderedFiles: File[] } {
  const files: File[] = [], directories: Array<{ name: string; file: File | null }> = [], orderedFiles: File[] = []
  const items = Array.from(data?.items || []).filter(item => item.kind === 'file')
  if (!items.length) {
    const fallback = Array.from(data?.files || []).filter(file => file.size !== 0)
    return { files: fallback, directories, orderedFiles: fallback }
  }
  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean; name?: string } | null })
      .webkitGetAsEntry?.()
    const file = item.getAsFile()
    if (entry?.isDirectory) directories.push({ name: entry.name || file?.name || '', file })
    else if (file && file.size !== 0) files.push(file)
    if (file) orderedFiles.push(file)
  }
  return { files, directories, orderedFiles }
}

function filesFromClipboardData(data: DataTransfer | null) {
  const files = []
  if (data?.files?.length) files.push(...data.files)
  const items = data?.items
  if (items) {
    for (const item of items) {
      if (item.kind !== 'file') continue
      const f = item.getAsFile()
      if (f && !files.some(existing => existing.name === f.name && existing.size === f.size)) files.push(f)
    }
  }
  return files
}

function filePathsFromClipboardData(data: DataTransfer | null) {
  const uriList = data?.getData?.('text/uri-list') || ''
  if (!uriList) return []
  return uriList
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter((line: string) => line && !line.startsWith('#') && /^file:\/\//i.test(line))
    .map((line: string) => {
      try { return decodeURIComponent(new URL(line).pathname) }
      catch { return '' }
    })
    .filter(Boolean)
}

function clipboardLooksFileLike(data: DataTransfer | null) {
  return [...(data?.types || [])].some(type => /files?/i.test(type))
}

function insertDefaultTextPaste(before: string, start: number, end: number, pastedText: string) {
  if (!pastedText || typeof start !== 'number' || typeof end !== 'number') return
  if (inputEl.value !== before) return
  const next = before.slice(0, start) + pastedText + before.slice(end)
  syncComposerTokenRangesAfterInput(before, next)
  const syncedQuotes = syncInlineQuoteRanges(before, next, inlineQuoteEntries())
  forgetInlineQuoteEntries(syncedQuotes.removed)
  setInputValue(next)
  const cursor = start + pastedText.length
  inputEl.setSelectionRange(cursor, cursor)
  renderSelectedSlashCommand()
  autoResize()
  updateSendBtn()
  persistComposerDraft()
}

// Files/images pasted from Chromium data first; Finder copied files on macOS
// come through native clipboard formats, so fall back to preload IPC.
async function handleMainComposerPaste(e: ClipboardEvent) {
  if (e.defaultPrevented) return
  const files = filesFromClipboardData(e.clipboardData)
  const looksFileLike = clipboardLooksFileLike(e.clipboardData)
  const uriPaths = looksFileLike ? filePathsFromClipboardData(e.clipboardData) : []
  const pastedText = e.clipboardData?.getData?.('text/plain') || e.clipboardData?.getData?.('text/uri-list') || ''
  const decision = decideComposerPaste({
    browserFileCount: files.length,
    uriPathCount: uriPaths.length,
    looksFileLike,
    largeText: isLargePastedText(pastedText),
  })
  if (decision.preventBrowserDefault) e.preventDefault()

  if (decision.route === 'browser-files') {
    addFiles(files)
    return
  }

  if (decision.route === 'uri-paths') {
    addFilePaths(uriPaths)
    return
  }

  const start = inputEl.selectionStart
  const end = inputEl.selectionEnd
  if (decision.route === 'large-text') { await attachMainPastedText(pastedText); return }

  const owner = window.currentSessionId
  const ownerToken = goalInteractions.token(owner)
  const revision = mainComposerControl?.revision
  const current = () => window.currentSessionId === owner && goalInteractions.token(owner) === ownerToken
    && mainComposerControl?.revision === revision && inputEl.selectionStart === start && inputEl.selectionEnd === end
  const nativePaths = await klausApi.clipboard?.readFilePaths?.().catch(() => [])
  if (!current()) return
  if (nativePaths?.length) addFilePaths(nativePaths)
  else if (pastedText) mainComposerControl?.replaceRange(start, end, pastedText, 'insertFromPaste')
}
inputEl.addEventListener('paste', handleMainComposerPaste)

// Tray events
klausApi.on.trayNewChat?.(() => newChat())
klausApi.on.trayOpenSettings?.(() => { if (!document.getElementById('settings-view')?.classList.contains('active')) toggleSettings() })
klausApi.on.deepLinkOpenSession?.(async ({ sessionId }: { sessionId?: string }) => { if (sessionId) await switchSession(sessionId) })
klausApi.on.deepLinkOpenTeamIssue?.((payload: unknown) => { openTeamIssueDeepLink(payload) })
// A clicked add-me link: queue the invite and show the friends page; the page
// consumes the queue when its island mounts (or immediately, if already up).
klausApi.on.deepLinkFriendInvite?.(({ email }: { email?: string }) => {
  if (!email) return
  queueFriendInvite(email)
  document.getElementById('btn-friends')?.click()
})
// A clicked friend-task banner opens the conversation the request waits in:
// the decision lives inside that conversation, not on the friends page.
klausApi.on.deepLinkFriendTask?.(({ taskId }: { taskId?: string }) => {
  if (!taskId) return
  void (async () => {
    wireFriendInbox()
    await refreshFriendInbox()
    const threadId = friendTaskById(taskId)?.threadId
    if (threadId) await switchSession(threadId)
    else document.getElementById('btn-friends')?.click()
  })()
})

function consumeFriendCompose(event?: Event) {
  const queued = takeQueuedFriendCompose()
  const request = (event as CustomEvent<FriendComposeRequest> | undefined)?.detail ?? queued
  if (!request) return
  btnNewChat.click()
  insertComposerReferenceToken({ kind: 'friend', id: request.friendId, name: request.name, value: request.value }, { start: 0, end: 0 })
  inputEl.dispatchEvent(new Event('input'))
  inputEl.focus()
}
// Register first so a request arriving during startup cannot miss the handoff.
window.addEventListener(FRIEND_COMPOSE_EVENT, consumeFriendCompose)
consumeFriendCompose()

// The agent moved the window on the user's behalf (klaus_action nav.open), so
// what was just discussed is what they end up looking at. Page navigation goes
// through the sidebar buttons rather than re-deriving which views to hide: those
// handlers already own the mutual exclusion, the active highlight and the
// artifacts panel, and a second copy here would drift the first time one of them
// changes. The host already rejected unknown views/tabs, so an unmatched view
// here means the two lists diverged — logged rather than silently ignored.
const AGENT_NAV_BUTTONS: Record<string, string> = {
  cron: 'btn-cron',
  memory: 'btn-memory',
  friends: 'btn-friends',
  mcp: 'btn-mcp',
  skills: 'btn-skills',
  plugins: 'btn-plugins',
  'slash-commands': 'btn-slash-commands',
  agents: 'btn-agents',
  channels: 'btn-channels',
  'team-collaboration': 'btn-team-collaboration',
}
klausApi.on.appNavigate?.(({ view, tab, focusComposer }: { view?: string; tab?: string; focusComposer?: boolean } = {}) => {
  if (view === 'settings') { openSettings(tab); return }
  if (view === 'chat') {
    if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
    for (const id of Object.values(AGENT_NAV_BUTTONS)) document.getElementById(id)?.classList.remove('active')
    if (typeof window.hideCronView === 'function') window.hideCronView()
    if (typeof window.hideMcpView === 'function') window.hideMcpView()
    if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
    if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
    if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
    if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
    if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
    if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
    window.hideFriendsView?.()
    setCurrentNonChatView(null)
    restoreArtifactsPanelForChatView()
    if (focusComposer === true) inputEl?.focus()
    return
  }
  const button = AGENT_NAV_BUTTONS[view ?? '']
  if (!button) { console.warn('[nav] unknown view from the agent:', view); return }
  document.getElementById(button)?.click()
})

// The acknowledgement covers an accepted submit, with deduplication before any UI change.
klausApi.on.desktopPetDraft?.(({ text }: { text: string }) => {
  if (!text?.trim()) return
  enterNewChatState()
  setComposerText(text)
  autoResize()
  updateSendBtn()
  inputEl?.focus()
})
const consumeMainAppshot = createAppshotMainConsumer({
  currentSession: () => window.currentSessionId || null,
  lastSession: () => sessions.filter(session => !session.archived && !session.parentSessionId).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null,
  newChat: () => enterNewChatState(),
  switchSession,
  attach: entry => { pendingFiles.push(entry); renderPreviews(); updateSendBtn(); persistComposerDraft(); },
  focus: () => { autoResize(); inputEl?.focus(); },
  accepted: async (captureId, accepted, error) => { await (window.klaus as unknown as { desktopPet: { acknowledgeMainCapture(captureId: string, accepted: boolean, error?: string): Promise<void> } }).desktopPet.acknowledgeMainCapture(captureId, accepted, error); },
})
klausApi.on.desktopPetMainCapture?.((payload: PetMainCapture) => { void consumeMainAppshot(payload).catch(error => window.showToast?.(error instanceof Error ? error.message : String(error))); })

klausApi.on.quickInputSubmit?.(createQuickInputConsumer(async text => {
  enterNewChatState()
  setComposerText(text)
  autoResize()
  updateSendBtn()
  let accepted = false
  await send({ onAccepted: () => { accepted = true } })
  if (!accepted) throw new Error('Check the main Klaus window to finish sending this message')
}))

// Canvas “Send to chat”：把用户在 canvas 里选中/点击的东西变成下一句 prompt。
//
// 与快速输入的关键区别：默认只填不发。canvas 里的按钮是模型写的，它拟的
// prompt 用户没看过，直接提交就把“看一眼”变成了“已经帮你发出去了”。只有
// canvas 显式请求 submit 时才发。newChat 同理：不要默认把用户从当前会话里抽走。
klausApi.canvas.onSendToChat(
  ({ text, submit, newChat }: { text?: string; submit?: boolean; newChat?: boolean } = {}) => {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) return
    try {
      if (newChat) enterNewChatState()
      setComposerText(trimmed)
      autoResize()
      updateSendBtn()
      // 焦点回输入框，否则用户要自己去点一下才能接着改。
      if (!submit) inputEl?.focus()
      if (submit) void send()
    } catch (err) {
      console.warn('[canvas] failed to place canvas text in the composer:', err)
    }
  },
)

const consumePptChat = createPptChatConsumer({
  currentSession: () => window.currentSessionId || null,
  stage: text => { setComposerText(text); autoResize(); updateSendBtn() },
  focus: () => { inputEl?.focus() },
  send: (onAccepted, expectedSessionId) => send({ onAccepted, expectedSessionId }),
  reply: (requestId, ok, error) => klausApi.ppt.chatResult(requestId, ok, error),
  toast: message => showToast(message),
  text: key => tt(key),
})
klausApi.ppt.onChatRequest((payload: PptChatRequest) => { void consumePptChat(payload) })

// External channel activity (wechat/feishu/…). Engine stream events don't
// reach this renderer; the main process fires one notification per persisted
// user/assistant message. Mirrors Web 端 web-ui-chat-js.ts `channel_message`
// handler: always refresh sidebar, and if the current session IS the touched
// one, append the new message live so the user doesn't need to switch sessions.

// ==================== 登录屏+更新横幅（已拆出至 src/chat/auth-screen.ts） ====================
initAuthScreen()
// Guest sign-in from the user menu: same host login flow as the boot screen,
// but in place — no window shrink, no workbench hide, running turns untouched.
initGuestSignin({
  t: (key) => tt(key),
  status: () => klausApi.klausAuth?.status?.(),
  login: () => beginAccountLogin(),
  cancelLogin: () => klausApi.klausAuth?.cancelLogin?.() ?? null,
  onLoginPending: (cb) => { klausApi.on?.klausAuthLoginPending?.(cb) },
  onAuthUpdated: (cb) => { klausApi.on?.klausAuthUpdated?.(cb) },
  toast: (message) => showToast(message),
})

// ==================== 服务端功能灰度开关（sidebar/feature-gate.ts） ====================
// 宿主解析每账号的门控结果，渲染端只反映布尔值。初始按 fail-closed 隐藏入口，
// 避免未放行账号看到团队协作闪现；快照与后续推送到达后再决定展示与否。
let featureGates: FeatureGateController | null = null
featureGates = initFeatureGates({
  snapshot: () => klausApi.featureGates?.snapshot?.() ?? Promise.resolve({ features: {} }),
  onUpdated: (handler) => klausApi.on?.featureGatesUpdated?.(handler) ?? (() => {}),
  setEntryVisible: (visible) => {
    const entry = document.getElementById('btn-team-collaboration')
    if (entry) entry.hidden = !visible
  },
  onTeamCollaborationDisabled: () => {
    // Gate flipped closed while the user may be ON the page: leave it and
    // return to chat. Idempotent — a no-op unless the team page is current.
    if (currentNonChatView !== 'teamCollaboration') return
    ;(window as any).klsPageViews?.get('team-collaboration')?.hide()
    setCurrentNonChatView(null)
    restoreArtifactsPanelForChatView()
  },
  onTeamCollaborationEnabled: () => {
    // The gate can open AFTER boot resolved a pending hash route (the click
    // was refused while fail-closed). Replay it now that the entry exists.
    restoreCollaborationRoute()
  },
  log: (message) => console.warn('[feature-gates]', message),
})

// --- Boot ---
async function boot() {
  try {
    if (typeof window.loadPreferences === 'function') await window.loadPreferences()
  } catch {}
  if (typeof window.applyI18n === 'function') window.applyI18n()
  // Hydrate sidebar collapse state from settings.db (authoritative). The first
  // paint already used the localStorage mirror, so this only reconciles and
  // re-renders when they differ; a click made before it lands wins.
  void hydrateSidebarCollapseState()
  try {
    const savedLang = await klausApi.settings.kv.get('language').catch(() => null)
    if (savedLang) document.documentElement.lang = savedLang
  } catch {}

  try {
    const status = await klausApi.klausAuth?.status?.()
    if (status?.loggedIn && status?.user) {
      await seedIdentityKv(status.user)
    }
  } catch (err) {
    console.warn('klausAuth status failed:', err)
  }
  // The user menu swaps its logout row for a guest sign-in entry; sync it from
  // the same authoritative status read so the first menu open is already right.
  void syncGuestSigninUi()

  // 登录态：揭开底层 #app，但**保留 boot splash 在最上层**，直到 init() 把侧栏/
  // 会话渲染好、UI 接上手为止。此前这里调 hideLoginScreen() 会在 init() 之前就撤掉
  // splash，于是用户看到的是一个空的、还被主线程建 DOM 卡住的外壳 —— 表现为"启动
  // 画面秒出但点啥都没反应"。把带动画的 splash 持续盖到 init() 完成，就把那段死白
  // 期变成明确的加载态，结束后再淡出，露出已可交互的 app。splash 的进度条是
  // transform 动画（跑在合成器线程），主线程忙时仍能转。
  const appEl = document.getElementById('app')
  if (appEl) appEl.style.visibility = ''
    try {
    await init()
  } finally {
    // 即便 init() 中途抛错也要撤掉 splash，否则用户会永远卡在启动画面。
    hideBootScreen()
  }
}

// ===== Workspace panel (file tree, VSCode-style) =====
// Replaces the old session_artifacts list. Data source is the chokidar
// watcher in main; first paint is workspace.list, subsequent updates ride
// the workspace:changed / workspace:invalidated events. We re-fetch the
// full subtree on any event (debounced 100ms) — diffing chokidar batches
// onto a DOM tree isn't worth the code; sessions/<sid>/ is small.
const artifactsPanel = document.getElementById('artifacts-panel')
const artifactsList = document.getElementById('artifacts-list')
const artifactsToggleBtn = document.getElementById('artifacts-panel-toggle')
const workspaceToggleBtn = document.getElementById('workspace-panel-toggle')
const artifactsToggleBtnInner = document.getElementById('artifacts-panel-toggle-inner')
// browser 域已拆出（browser-panel.ts）；此 ref 仍被 artifacts 编排的按钮态同步消费。
const browserToggleBtn = document.getElementById('browser-panel-toggle')
let chatMonitorExpanded = false
let artifactsPanelRestoreState: { mode: string | null; collapsed: boolean } | null = null
let diffFilesPanelCollapsed = localStorage.getItem(windowStateKey('klaus_diff_files_collapsed')) === '1'
// ==================== Workspace 面板（已拆出至 src/chat/workspace-panel.ts） ====================
// artifacts 编排与 composer mention 桥仍在本文件，经 deps 注入。
initWorkspacePanel({
  ensureSession: () => ensureSession(),
  draftProjectWorkdir: () => draftProjectWorkdir(),
  inputEl: () => inputEl,
  addWorkspaceComposerMention: (node) => addWorkspaceComposerMention(node as { rel?: string; path?: string; name?: string; isDir?: boolean }),
  rememberWorkspaceRoot: (sessionId: string, root) => rememberWorkspaceRoot(sessionId, root as string),
  closeSessionContextMenu: () => closeSessionContextMenu(),
  hideBtwPanel: () => hideBtwPanel(),
  setCurrentNonChatView: (view) => setCurrentNonChatView(view),
  openArtifactsPanel: (mode) => openArtifactsPanel(mode),
  setArtifactsPanelMode: (mode) => setArtifactsPanelMode(mode),
  syncArtifactsToggleVisibility: () => syncArtifactsToggleVisibility(),
  syncTopModeButtons: () => syncTopModeButtons(),
  renderSessionList: () => renderSessionList(),
  artifactsPanel: () => artifactsPanel,
  artifactsList: () => artifactsList,
})

// ==================== 语音输入（已拆出至 src/chat/voice.ts） ====================
initVoice({
  chatActive: () => voiceChatUi?.controller.snapshot().open === true,
  mainComposerInsert: (trimmed) => {
    const existing = inputEl.value
    const needsSpace = existing && !/\s$/.test(existing)
    const next = existing + (needsSpace ? ' ' : '') + trimmed
    syncComposerReferenceRanges(existing, next)
    setInputValue(next)
    inputEl.focus()
    autoResize()
    updateSendBtn()
    persistComposerDraft()
  },
})

voiceChatUi = mountVoiceChat({
  wrapper: inputWrapperEl!, row: inputWrapperEl!.querySelector('.input-row')!, content: document.getElementById('main')!,
  sendButton: btnSend, input: inputEl,
  transport: klausApi.voice.chat,
  currentSession: () => window.currentSessionId || null,
  ensureSession: async () => {
    const id = await ensureSession()
    if (!id || window.currentSessionId !== id) return null
    if (welcomeEl.style.display !== 'none') await switchSession(id)
    return window.currentSessionId === id ? id : null
  },
  beforeStart: cancelVoiceForChat,
  hasDraft: () => hasComposerText() || pendingFiles.length > 0,
  canStart: () => !busy && !inputEl.disabled && inputEl.getAttribute('contenteditable') !== 'false' && !composerContinueMode()
    && !firstSendInFlight && !creatingGoalSessions.has(window.currentSessionId || '')
    && (document.getElementById('voice-input-btn')?.dataset.voiceState || 'idle') === 'idle',
  commandActive: () => !document.getElementById('side-input-wrapper')?.contains(document.activeElement),
  inChat: () => !currentNonChatView && !settingsVisibleIfAny() && !isWorkspaceMainActive() && !window.isDiffViewActive?.(),
  taskStatus: () => {
    const id = voiceChatUi?.controller.snapshot().targetSessionId
    if (!id) return null
    const stream = getSessionStream(id)
    if (stream.streamMode === 'responding') return null
    const active = Object.values(stream.tools).filter(tool => tool.status === 'running' || tool.status === 'awaiting-approval').sort((a, b) => (a.startedAtMs || 0) - (b.startedAtMs || 0))
    const tool = active.at(-1)
    if (!tool) return tt('voice_chat_thinking')
    const presentation = activityToolPresentation({ ...tool, state: tool.status === 'awaiting-approval' ? 'awaiting-approval' : 'running' })
    const key = tool.status === 'awaiting-approval' ? 'voice_chat_waiting' : presentation.kind === 'exec' ? 'voice_chat_command' : presentation.kind === 'edit' ? 'voice_chat_editing' : presentation.kind === 'read' ? 'voice_chat_reading' : presentation.kind === 'search' ? 'voice_chat_searching' : null
    const label = key ? tt(key) : activityToolDisplayName(tool.toolName)
    return active.length > 1 ? `${label} · ${tt('voice_chat_more').replace('{count}', String(active.length - 1))}` : label
  },
  feedback: () => { void submitDebugReport('') },
  systemSettings: () => klausApi.systemPermissions.openSettings('microphone'),
  present: (eligible, sessionId, notice) => klausApi.voice.chat.present({ eligible, sessionId, ...(notice ? { notice } : {}) }),
  levels: (microphone, output, outputBands) => klausApi.voice.chat.levels({ microphone, output, outputBands }),
})
mountSideComposerVoice?.()
window.klausStopVoiceChatForSession = sessionId => voiceChatUi!.controller.stopForSession(sessionId)
chatStreamStore.subscribe(() => voiceChatUi?.refresh())
klausApi.voice.chat.onToggle(({ action }: { action: 'start' | 'stop' }) => {
  if (action === 'stop') { void voiceChatUi?.controller.stop(); return }
  if (voiceChatUi?.controller.snapshot().open) return
  newChat()
  void voiceChatUi?.controller.start()
})
window.addEventListener('pagehide', () => { sideVoiceChatUi?.dispose(); voiceChatUi?.dispose() }, { once: true })

window.addEventListener('klaus:restore-question-draft', ((event: CustomEvent<{ sessionId: string; drafts: Array<{ text: string }> }>) => {
  const { sessionId, drafts } = event.detail
  const restored = drafts.map(draft => draft.text).filter(Boolean).join('\n\n')
  if (!restored) return
  if (window.currentSessionId === sessionId) {
    const existing = inputEl.value
    const next = [existing, restored].filter(Boolean).join('\n\n')
    syncComposerReferenceRanges(existing, next)
    setInputValue(next)
    autoResize()
    updateSendBtn()
    persistComposerDraft()
  } else {
    const draft = normalizeComposerDraft(sessionDrafts.get(sessionId))
    setDraft(sessionId, { ...draft, document: undefined, text: [draft.text, restored].filter(Boolean).join('\n\n') })
  }
}) as EventListener)

chatStreamStore.subscribe(state => {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (!session.asyncQuestions.restoredDrafts.length) continue
    const drafts = session.asyncQuestions.restoredDrafts
    updateAsyncQuestionUi(sessionId, ui => ({ ...ui, restoredDrafts: [] }))
    window.dispatchEvent(new CustomEvent('klaus:restore-question-draft', { detail: { sessionId, drafts } }))
  }
})


const selectPredictionSession = createPredictionSessionSelector()
function currentPredictionSession(): PredictionSession | null {
  const sessionId = window.currentSessionId
  if (!sessionId || composerSpecEnabled || chatStreamStore.getState().engineStatus !== 'ok' || sessions.find(row => row.id === sessionId)?.role === 'side_task') return null
  const stream = getSessionStream(sessionId)
  if (stream.running || stream.historyLoadFailed) return null
  return selectPredictionSession(sessionId, stream)
}

function windowsSandboxContext(cwd: string | null, sessionId: string | null | undefined) {
  const knownTarget = !sessionId || findKnownSession(sessionId) !== null
  return { cwd, environment: { platform: /^Win/i.test(navigator.platform) ? 'win32' : 'other', local: knownTarget && !isSshProjectWorkdir(cwd) } }
}
const windowsSandboxComposer = document.getElementById('input-wrapper')
if (windowsSandboxComposer) mainWindowsSandboxBanner = mountWindowsSandboxBanner(windowsSandboxComposer, () => windowsSandboxContext(selectedProjectWorkdir(), window.currentSessionId))
window.addEventListener('klaus:session-change', () => {
  mainWindowsSandboxBanner?.refresh()
  sideWindowsSandboxBanner?.refresh()
})
window.addEventListener('pagehide', () => {
  mainWindowsSandboxBanner?.dispose()
  sideWindowsSandboxBanner?.dispose()
}, { once: true })

composerPredictions = mountComposerPredictions({
  input: inputEl,
  session: currentPredictionSession,
  source: sessionId => klausApi.composerPredictions.source(sessionId),
  blocked: () => busy || inputEl.disabled || inputEl.getAttribute('contenteditable') === 'false' || pendingFiles.length > 0
    || !!selectedSlashCommand || composerReferenceTokens.length > 0
    || !slashMenu.classList.contains('hidden')
    || (document.getElementById('voice-input-btn')?.dataset.voiceState || 'idle') !== 'idle',
  predict: (target, trigger) => klausApi.composerPredictions.get(target.sessionId, target.turnId, trigger),
  cancel: sessionId => klausApi.composerPredictions.cancel(sessionId),
  get: key => klausApi.settings.kv.get(key),
  set: (key, value) => klausApi.settings.kv.set(key, value),
  text: tt,
})
chatStreamStore.subscribe((state, previous) => {
  for (const [id, stream] of Object.entries(state.sessions)) {
    if (stream.running && !previous.sessions[id]?.running) composerPredictions?.invalidate(id)
  }
  // The live terminal listener supplies its trigger before this microtask runs.
  queueMicrotask(() => { void composerPredictions?.refresh() })
})
window.addEventListener('pagehide', () => composerPredictions?.dispose(), { once: true })
window.addEventListener('klaus:session-change', () => { void composerPredictions?.refresh() })
const predictionBlockerObserver = new MutationObserver(() => composerPredictions?.paint())
predictionBlockerObserver.observe(slashMenu, { attributes: true, attributeFilter: ['class'] })
const predictionVoiceButton = document.getElementById('voice-input-btn')
if (predictionVoiceButton) predictionBlockerObserver.observe(predictionVoiceButton, { attributes: true, attributeFilter: ['data-voice-state'] })
window.addEventListener('pagehide', () => predictionBlockerObserver.disconnect(), { once: true })


// ==================== Terminal（已拆出至 src/chat/terminal.ts） ====================
// deps 注入 sessions/artifacts/视图编排的跨域函数；那些域拆出后改直接 import。
initTerminal({
  ensureSession: () => ensureSession(),
  sessionWorkdir: (sessionId: string) => sessionWorkdir(sessionId),
  normalizeProjectWorkdir: (workdir) => normalizeProjectWorkdir(workdir as string | null | undefined),
  currentSessionId: () => window.currentSessionId || null,
  openArtifactsPanel: (mode) => openArtifactsPanel(mode),
  closeArtifactsPanel: () => closeArtifactsPanel(),
  closeSettingsIfActive: () => {
    if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  },
  hideWorkspaceMainView: () => hideWorkspaceMainView(),
  hideBtwPanel: () => hideBtwPanel(),
  setCurrentNonChatView: (view) => setCurrentNonChatView(view),
  syncTopModeButtons: () => syncTopModeButtons(),
  renderSessionList: () => renderSessionList(),
  artifactsPanel: () => artifactsPanel,
})

function syncTopModeButtons() {
  const diffActive = typeof window.isDiffViewActive === 'function'
    ? window.isDiffViewActive()
    : document.getElementById('diff-view')?.classList.contains('active')
  const browserPanelActive = artifactsPanel?.getAttribute('data-mode') === 'browser' && !artifactsPanel?.classList.contains('collapsed')
  const chatActive = !diffActive && !isWorkspaceMainActive() && !currentNonChatView
  const turnNavigationActive = chatActive && messagesEl?.style.display !== 'none' && !settingsVisibleIfAny()
  turnNavigationController?.setChatActive(turnNavigationActive)
  workspaceToggleBtn?.classList.toggle('active', isWorkspaceMainActive())
  browserToggleBtn?.classList.toggle('active', !!browserPanelActive)
}

// Chat starts collapsed; dedicated non-chat surfaces decide whether their
// right panel should open when entered.
if (artifactsPanel) {
  artifactsPanel.classList.add('collapsed')
}

// ==================== Browser 面板（已拆出至 src/chat/browser-panel.ts） ====================
// artifacts 编排与视图清场仍在本文件，经 deps 注入；C4 拆出后改直接 import。
initBrowserPanel({
  closeSettingsIfActive: () => {
    if (document.getElementById('settings-view')?.classList.contains('active')) toggleSettings()
  },
  hideNonChatViews: () => {
    if (typeof window.hideCronView === 'function') window.hideCronView()
    if (typeof window.hideMcpView === 'function') window.hideMcpView()
    if (typeof window.hideSkillsView === 'function') window.hideSkillsView()
    if (typeof window.hidePluginsView === 'function') window.hidePluginsView()
    if (typeof window.hideSlashCommandsView === 'function') window.hideSlashCommandsView()
    if (typeof window.hideAgentsView === 'function') window.hideAgentsView()
    if (typeof window.hideChannelsView === 'function') window.hideChannelsView()
    if (typeof window.hideMemoryView === 'function') window.hideMemoryView()
    window.hideFriendsView?.()
    ;(window as any).klsPageViews?.get('team-collaboration')?.hide()
    if (typeof window.hideWorkspaceMainView === 'function') window.hideWorkspaceMainView()
  },
  hideBtwPanel: () => hideBtwPanel(),
  setCurrentNonChatView: (view) => setCurrentNonChatView(view),
  setArtifactsPanelMode: (mode) => setArtifactsPanelMode(mode),
  openArtifactsPanel: (mode) => openArtifactsPanel(mode),
  closeArtifactsPanel: () => closeArtifactsPanel(),
  syncTopModeButtons: () => syncTopModeButtons(),
  renderSessionList: () => renderSessionList(),
})

// ==================== Diagram 面板（src/chat/digram/panel.ts） ====================
// 由 Turn 产物卡精确打开；面板只借 chat.ts 的当前会话和开合编排。
initDigramPanel({
  currentSessionId: () => window.currentSessionId || null,
  openArtifactsPanel: (mode) => openArtifactsPanel(mode),
  closeArtifactsPanel: () => closeArtifactsPanel(),
  syncTopModeButtons: () => syncTopModeButtons(),
  renderSessionList: () => renderSessionList(),
})
// 3D 面板（src/chat/model3d/panel.ts）：与 digram 同构的 surface owner，区别在于
// 这里渲染的是宿主进程内 WASM 内核求值出的真实几何，而不是自己画 SVG。
initModel3DPanel({
  currentSessionId: () => window.currentSessionId || null,
  openArtifactsPanel: (mode) => openArtifactsPanel(mode),
  closeArtifactsPanel: () => closeArtifactsPanel(),
  syncTopModeButtons: () => syncTopModeButtons(),
  renderSessionList: () => renderSessionList(),
})
initCanvasPanel()
initPrototypePanel()
initVideoEditingPanel()
initPptPanel()

// The panel's modes, in one place. Three separate ternary chains used to spell
// this list out, and each of them silently coerced any mode it had not been
// taught to 'monitor' — so adding a surface meant remembering all three or
// watching the new tab open on the summary instead.
const PANEL_MODES = new Set(['monitor', 'workspace', 'diff', 'browser', 'terminal', 'digram', 'model3d', 'side-chat', 'subagent', 'background-process', 'spec', 'canvas', 'prototype', 'video-editing', 'ppt', 'planning', 'goal'])
// Modes whose open/collapsed state is NOT the summary's persisted preference:
// they are surfaces the user entered on purpose, so leaving one must not teach
// the panel to come back collapsed next session.
const TRANSIENT_PANEL_MODES = new Set(['browser', 'terminal', 'digram', 'model3d', 'side-chat', 'subagent', 'background-process', 'spec', 'canvas', 'prototype', 'video-editing', 'ppt', 'planning', 'goal'])
// Modes whose open/collapsed state is NOT the summary's persisted preference:
// they are surfaces the user entered on purpose, so leaving one must not teach
// the panel to come back collapsed next session.
function normalizePanelMode(mode: string): string {
  return PANEL_MODES.has(mode) ? mode : 'monitor'
}
function setArtifactsPanelMode(mode: string) {
  const next = normalizePanelMode(mode)
  const previous = artifactsPanel?.getAttribute('data-mode') || null
  artifactsPanel?.setAttribute('data-mode', next)
  if (next !== 'browser' && (previous === 'browser' || browserRuntimeVisible())) {
    void hideBrowserRuntime({ ensureDetached: true })
  }
  if (next !== 'canvas') void hideCanvasPanel()
  if (next !== 'prototype') void hidePrototypePanel()
  if (next !== 'video-editing') void hideVideoEditingPanel()
  if (next !== 'ppt') void hidePptPanel()
  if (next !== 'diff' && !TRANSIENT_PANEL_MODES.has(next)) persistLocalValue(windowStateKey('klaus_artifacts_mode'), next)
  // Whoever moved the panel (tab click, side rail, engine event, restore), the
  // strip follows: the registry re-derives which tab is active from the mode
  // plus that kind's own active instance.
  window.KlausPanelTabs?.onModeChanged?.(next)
  const browserVisible = next === 'browser' && isBrowserPanelVisible()
  if (browserVisible) scheduleBrowserBoundsSync()
}
function syncArtifactsToggleVisibility() {
  if (!artifactsPanel) return
  const collapsed = artifactsPanel.classList.contains('collapsed')
  const mode = artifactsPanel.getAttribute('data-mode') || 'monitor'
  // The changes surface lives INSIDE the panel as one tab among others, so a
  // loaded diff is no longer a reason to hide the panel. The rule that did that
  // dated from when diff was a full-screen overlay; keeping it meant switching
  // from the Changes tab to any other tab blanked the whole panel.
  document.body.classList.toggle('artifacts-open', !collapsed)
  if (artifactsToggleBtn) artifactsToggleBtn.style.display = collapsed ? '' : 'none'
  if (artifactsToggleBtnInner) artifactsToggleBtnInner.style.display = collapsed ? 'none' : ''
  artifactsToggleBtn?.classList.toggle('active', !collapsed && (mode === 'monitor' || mode === 'diff'))
  workspaceToggleBtn?.classList.toggle('active', isWorkspaceMainActive())
  browserToggleBtn?.classList.toggle('active', !collapsed && mode === 'browser')
  artifactsToggleBtn?.setAttribute('aria-expanded', String(!collapsed && (mode === 'monitor' || mode === 'diff')))
  workspaceToggleBtn?.setAttribute('aria-expanded', String(!collapsed && mode === 'workspace'))
  browserToggleBtn?.setAttribute('aria-expanded', String(!collapsed && mode === 'browser'))
  const monitorToggleBtn = document.getElementById('monitor-panel-toggle')
  monitorToggleBtn?.classList.toggle('active', !collapsed && mode === 'monitor')
  monitorToggleBtn?.setAttribute('aria-expanded', String(!collapsed && mode === 'monitor'))
  // The strip re-renders from the registry: active state depends on panel
  // open-state as well as mode, and maximize only applies while open.
  window.KlausPanelTabs?.render?.()
  if (typeof syncTerminalPanelForCurrentSession === 'function') syncTerminalPanelForCurrentSession()
  syncTopModeButtons()
}
window.syncArtifactsToggleVisibility = syncArtifactsToggleVisibility
function openArtifactsPanel(mode: string = 'monitor') {
  if (!artifactsPanel) return
  const nextMode = normalizePanelMode(mode)
  setArtifactsPanelMode(nextMode)
  artifactsPanel.classList.remove('collapsed')
  if (nextMode === 'monitor') chatMonitorExpanded = true
  if (nextMode === 'diff') {
    diffFilesPanelCollapsed = false
    persistLocalValue(windowStateKey('klaus_diff_files_collapsed'), '0')
  } else if (!TRANSIENT_PANEL_MODES.has(nextMode)) {
    persistLocalValue(windowStateKey('klaus_artifacts_collapsed'), '0')
  }
  syncArtifactsToggleVisibility()
  if (nextMode === 'monitor' || nextMode === 'workspace') loadWorkspace(window.currentSessionId, { promoteDraft: true })
}
window.openArtifactsPanel = openArtifactsPanel
window.closeArtifactsPanel = closeArtifactsPanel
function closeArtifactsPanel() {
  if (!artifactsPanel) return
  const mode = artifactsPanel.getAttribute('data-mode') || 'monitor'
  // Diff / workspace surfaces live inside the panel now: collapsing the
  // panel must exit the surface too, otherwise an active-but-invisible
  // view lingers behind the collapsed panel.
  const diffActive = typeof window.isDiffViewActive === 'function'
    ? window.isDiffViewActive()
    : document.getElementById('diff-view')?.classList.contains('active')
  if (mode === 'diff' && diffActive) {
    window.dispatchEvent(new CustomEvent('klaus:diff-close'))
    return
  }
  if (mode === 'workspace' && isWorkspaceMainActive()) {
    hideWorkspaceMainView()
    restoreArtifactsPanelForChatView()
    syncTopModeButtons()
    renderSessionList()
    return
  }
  artifactsPanel.classList.add('collapsed')
  if (mode === 'monitor') chatMonitorExpanded = false
  if (mode === 'diff') {
    diffFilesPanelCollapsed = true
    persistLocalValue(windowStateKey('klaus_diff_files_collapsed'), '1')
  } else if (!TRANSIENT_PANEL_MODES.has(mode)) {
    persistLocalValue(windowStateKey('klaus_artifacts_collapsed'), '1')
  }
  if (mode === 'browser' || browserRuntimeVisible()) void hideBrowserRuntime({ ensureDetached: true })
  if (mode === 'canvas') void hideCanvasPanel()
  if (mode === 'prototype') void hidePrototypePanel()
  if (mode === 'video-editing') void hideVideoEditingPanel()
  if (mode === 'ppt') void hidePptPanel()
  if (mode === 'terminal') setTerminalOpen(false)
  syncArtifactsToggleVisibility()
}
function toggleArtifactsPanel(mode: string = 'monitor') {
  if (!artifactsPanel) return
  const collapsed = artifactsPanel.classList.contains('collapsed')
  const currentMode = artifactsPanel.getAttribute('data-mode') || 'monitor'
  const nextMode = normalizePanelMode(mode)
  if (!collapsed && currentMode === nextMode) closeArtifactsPanel()
  else openArtifactsPanel(nextMode)
}
setArtifactsPanelMode('monitor')
// Panel-strip hooks for the two fixed tabs and the changes surface. Tab clicks
// funnel through the same open paths as the side-rail buttons, so a tab and a
// rail button can never leave the panel in different states.
window.klausOpenMonitorPanel = () => {
  // Switching tabs must not tear down other surfaces: the changes view stays
  // loaded behind its own tab (CSS hides it by mode) and only its × closes it.
  if (typeof window.hideWorkspaceMainView === 'function') window.hideWorkspaceMainView()
  openArtifactsPanel('monitor')
  syncTopModeButtons()
  renderSessionList()
}
window.klausOpenDiffPanel = () => {
  const diffActive = typeof window.isDiffViewActive === 'function'
    ? window.isDiffViewActive()
    : document.getElementById('diff-view')?.classList.contains('active')
  // Already loaded but the panel moved elsewhere: re-enter instead of toggling
  // the surface off, which is what #btn-diff would do.
  if (diffActive) window.enterDiffArtifactsPanel?.()
  else document.getElementById('btn-diff')?.click()
}
window.klausCloseDiffPanel = () => window.dispatchEvent(new CustomEvent('klaus:diff-close'))
artifactsToggleBtn?.addEventListener('click', () => {
  const diffActive = typeof window.isDiffViewActive === 'function'
    ? window.isDiffViewActive()
    : document.getElementById('diff-view')?.classList.contains('active')
  toggleArtifactsPanel(diffActive ? 'diff' : isWorkspaceMainActive() ? 'workspace' : 'monitor')
})
// Side-rail monitor entry — same open path as the panel's Monitor tab.
document.getElementById('monitor-panel-toggle')?.addEventListener('click', () => {
  window.klausOpenMonitorPanel!()
})
workspaceToggleBtn?.addEventListener('click', () => {
  if (isWorkspaceMainActive()) {
    hideWorkspaceMainView()
    restoreArtifactsPanelForChatView()
    syncTopModeButtons()
    renderSessionList()
    return
  }
  showWorkspaceMainView({ openPanel: true })
})
// Maximizing / restoring the panel changes the space the embedded browser and
// the terminal get, so both need a layout pass afterwards.
window.klausOnArtifactsLayoutChange = () => {
  scheduleBrowserBoundsSync()
  scheduleCanvasBoundsSync()
  schedulePrototypeBoundsSync()
  scheduleVideoEditingBoundsSync()
  schedulePptBoundsSync()
  scheduleTerminalResize()
}
artifactsToggleBtnInner?.addEventListener('click', closeArtifactsPanel)
syncArtifactsToggleVisibility()

function hideArtifactsPanelForNonChatView() {
  if (!artifactsPanel) return
  // A WebContentsView belongs to the main process and can remain attached after
  // a renderer reload even when this renderer has no local visible state yet.
  // Every explicit route away from chat therefore confirms detachment with the
  // host; frame-driven layout sync keeps the guarded no-op path.
  void hideBrowserRuntime({ ensureDetached: true })
  void hidePrototypePanel()
  void hideVideoEditingPanel()
  void hidePptPanel()
  artifactsPanel.classList.add('collapsed')
  syncArtifactsToggleVisibility()
}
function restoreArtifactsPanelForChatView() {
  if (!artifactsPanel) return
  setArtifactsPanelMode('monitor')
  artifactsPanel.classList.toggle('collapsed', !chatMonitorExpanded)
  syncArtifactsToggleVisibility()
}
// Per-main-session snapshot of the artifacts panel: which mode it was in and
// whether it was collapsed. Written on session-switch (before mutating for the
// target), read to restore when the user comes back. Keyed by sessionId so each
// main session has its own remembered panel state.
const artifactsStateBySession = new Map()  // sessionId -> {mode, collapsed}
function saveArtifactsStateFor(sessionId: string) {
  if (!sessionId || !artifactsPanel) return
  const mode = artifactsPanel.getAttribute('data-mode') || 'monitor'
  artifactsStateBySession.set(sessionId, {
    // A sub-agent surface is not restorable: the switch closes that session's
    // sub-agent tabs, so remembering the mode would bring the panel back on an
    // empty body with no tab in front of it.
    // Native editor surfaces persist their tabs with the owning chat, so
    // their mode restores like any other surface and re-activates the parked
    // document instead of stranding the panel on an empty body.
    mode: mode === 'subagent' || mode === 'background-process' || mode === 'spec' || mode === 'canvas' || mode === 'planning' || mode === 'goal' ? 'monitor' : mode,
    collapsed: artifactsPanel.classList.contains('collapsed'),
  })
}
// Session-switch specific: unlike restoreArtifactsPanelForChatView (which is a
// hard reset used when leaving diff/workspace back to chat), a plain main
// session switch restores the target session's remembered panel state. No
// memory for that session means the panel stays closed (default state) — the
// user has never opened it there.
function adjustArtifactsPanelForSessionSwitch(targetSessionId: string) {
  if (!artifactsPanel) return
  // Tear down the OUTGOING session's global surfaces so they cannot bleed into
  // the target. Their "was active" is preserved in that session's saved mode, so
  // switching back re-activates them through the branches below.
  if (window.isDiffViewActive?.()) window.deactivateDiffView?.()
  if (isWorkspaceMainActive()) hideWorkspaceMainView()
  const saved = targetSessionId ? artifactsStateBySession.get(targetSessionId) : null
  const mode = saved?.mode || 'monitor'
  const collapsed = saved ? !!saved.collapsed : true
  // The changes / files surfaces have their own activation lifecycle (an .active
  // class plus a content load), so an open one is re-entered through its show
  // path — setting the panel mode alone would show the tab with an empty body.
  if (!collapsed && mode === 'diff') { window.showDiffView?.(); return }
  if (!collapsed && mode === 'workspace') { window.showWorkspaceMainView?.({ openPanel: true }); return }
  // No memory for this session (or a plain surface): monitor + whatever collapsed
  // state was saved. A brand-new session has never opened the panel, so it stays
  // closed instead of inheriting the previous session's open panel.
  setArtifactsPanelMode(mode)
  artifactsPanel.classList.toggle('collapsed', collapsed)
  syncArtifactsToggleVisibility()
}

function prepareArtifactsPanelLayoutForSessionSwitch(targetSessionId: string) {
  if (!artifactsPanel) return
  const saved = artifactsStateBySession.get(targetSessionId)
  artifactsPanel.setAttribute('data-session-switch-layout', '')
  artifactsPanel.classList.toggle('collapsed', saved ? !!saved.collapsed : true)
  syncArtifactsToggleVisibility()
  // Commit the restored width without animating the new transcript through
  // intermediate line wraps. Manual panel toggles keep their transition.
  void artifactsPanel.offsetWidth
  artifactsPanel.removeAttribute('data-session-switch-layout')
}

window.enterDiffArtifactsPanel = function enterDiffArtifactsPanel(options = {}) {
  if (!artifactsPanel) return
  const currentMode = artifactsPanel.getAttribute('data-mode') || 'monitor'
  if (currentMode !== 'diff') {
    artifactsPanelRestoreState = {
      mode: currentMode === 'workspace' ? 'workspace' : 'monitor',
      collapsed: artifactsPanel.classList.contains('collapsed'),
    }
  }
  setArtifactsPanelMode('diff')
  // The diff surface renders inside the panel, so entering diff always
  // expands it — a collapsed panel would leave an active-but-invisible view.
  diffFilesPanelCollapsed = false
  persistLocalValue(windowStateKey('klaus_diff_files_collapsed'), '0')
  artifactsPanel.classList.remove('collapsed')
  syncArtifactsToggleVisibility()
}

window.exitDiffArtifactsPanel = function exitDiffArtifactsPanel() {
  if (!artifactsPanel) return
  const restore = artifactsPanelRestoreState
  artifactsPanelRestoreState = null
  // The changes surface is an instance tab: leaving it closes the tab too.
  window.KlausPanelTabs?.remove?.('diff')
  const mode = restore?.mode === 'workspace' ? 'workspace' : 'monitor'
  setArtifactsPanelMode(mode)
  artifactsPanel.classList.toggle('collapsed', restore ? restore.collapsed : true)
  syncArtifactsToggleVisibility()
}

// ==================== Monitor 摘要（已拆出至 src/chat/overview/） ====================
initMonitorSummary({
  currentSessionId: () => window.currentSessionId || null,
  commandGroupKey: (command) => commandGroupKey(command as SlashCommandInfo | null),
  slashCommandDisplayName: (command) => slashCommandDisplayName(command as SlashCommandInfo | null),
  specDocuments: (sessionId) => specDocuments.documents(sessionId),
  subscribeSpecDocuments: (listener) => specDocuments.subscribeDocuments(listener),
  openSpecDocument: (document) => openSpecPanel(document),
})
const backgroundProcessMonitor = initBackgroundProcessMonitor({
  api: klausApi,
  currentSessionId: () => window.currentSessionId || null,
  switchSession,
  openPanel: (mode) => openArtifactsPanel(mode),
})
// The terminal list's count line and per-row labels are painted, not
// data-i18n attributes, so applyI18n cannot reach them.
window.addEventListener('klaus:lang-change', () => renderTerminalList())



boot()

// [module-bridge] classic-script 时代的跨文件全局；模块化后由此统一挂到 window。
// typeof 守卫让 bun test 仍可按 CJS require 本文件。
if (typeof window !== 'undefined') Object.assign(window, { deleteSession, escapeHtml, invalidateDeviceMentionCache, invalidatePluginMentionCache, listArchivedSessions, openProjectMcpModal, sessionDisplayTitle, switchSession, updateSessionInList })

// Storage mutations use the same local ownership and cache lifecycle as chat actions.
klausApi.storage.onChanged(({ kind, sessionIds }: StorageChatsChanged) => {
  if (kind !== 'deleted' && kind !== 'archived') return
  applyStorageChange(sessionIds, {
    currentId: () => window.currentSessionId,
    leaveCurrent: () => {
      const retainSettings = !!document.getElementById('settings-view')?.classList.contains('active')
      const current = window.currentSessionId ? findKnownSession(window.currentSessionId) : undefined
      const workdir = normalizeProjectWorkdir(kind === 'archived' ? current?.projectRoot : current?.workdir)
      enterNewChatState({ workdir, discardLeavingDraft: true, retainSettings })
    },
    remove: ids => {
      sessionDeletionRevision++
      if (kind === 'archived') {
        for (const id of ids) archivedSessions = [{ ...findKnownSession(id), id, archived: true, updatedAt: Date.now() }, ...archivedSessions.filter(row => row.id !== id)]
      } else archivedSessions = archivedSessions.filter(row => !ids.has(row.id))
      sessions = sessions.filter(row => !ids.has(row.id))
    },
    forget: id => forgetSessionLocalState(id, kind === 'deleted'),
    refresh: () => {
      renderSessionList()
      const revision = sessionDeletionRevision
      void (async () => {
        const archived = await klausApi.session.listArchived()
        if (revision !== sessionDeletionRevision) return
        archivedSessions = archived
        await updateSessionInList()
        syncArchivedSessionUi()
      })().catch(error => console.warn('[storage] conversation refresh failed', error))
    },
  })
})
