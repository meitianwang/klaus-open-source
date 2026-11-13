import { friendlyErrorText } from '../friendly-errors'
import { noticeI18nKey } from '../notice-codes'
import { pendingSubmissionRecovery } from '../composer/pending-submission'
import { InlineUserEditor, openInlineUserEdit, useInlineUserEdit } from './inline-user-edit'
import { installUserMessageDisclosure, registerUserMessageCopy, userMessageCopyContent } from './user-message-disclosure'
import { renderUserDocument } from './user-document'
import { SubmittedMessageContent, mergeSubmittedAttachments, type SubmittedContent } from './submitted-message-content'
import { TranscriptRenderIdentity } from './transcript-render-identity'
import { mergeSubmittedUserHistory } from '../transcript-user-handoff'
import { useShallow } from 'zustand/react/shallow'
import { TranscriptFrameIndex } from './transcript-frame-index'
import { handleSubmittedContentClick } from './submitted-content-actions'
import { restoreComposerDocument, snapshotComposerDocument } from '../composer/document-model'
import { ApprovalReviewCard, ApprovalReviewNotice } from './approval-review'
import { approvalReview, type ApprovalReview } from '../../../../contracts/approval-review'
import { knownCursorErrorText } from '../../app/cursor-errors'
import { knownAntigravityErrorText } from '../../app/antigravity-errors'
import { knownTraeErrorText } from '../../app/trae-errors'
import { knownKiroErrorText } from '../../app/kiro-errors'
import { knownEngineSourceProseErrorText } from '../../app/model-source-errors'
import { imagePreviewOptionsFromElement, bindImageContextMenu, imageFailureText } from '../image-preview'
import { parsePastedReferenceSection } from '../composer/pasted-text'
import { asyncQuestionReceipt, isQuestionTool, questionResolution } from './question-state'
import { questionReplyDisplay } from './question-answer-display'
import { extractGoalImageReferences } from '../goals/goal-image-references'
import { AsyncQuestionComposer, AsyncQuestionText } from './async-question-view'
import { isTaskMutationTool } from '../task-state'
import { FriendOwnerChatRequest, FriendTaskApproval } from './friend-task-approval'
// Streamed and replayed messages share one turn/activity projection. Explicit
// message phases identify final answers; session-owned disclosure keys survive
// streaming updates, history handoff, and nested disclosure unmounts.
import styles from './transcript.module.css'
import chatStyles from '../chat.module.css'
import { activityCollapseState, describeActivity, projectActivity, turnCollapseState, transcriptPageStart, type ActivityEntry, type ActivitySummary, type ActivityAction } from './activity-model'
import { ActivityTool, activityToolDisplayName, activityToolIconName, activityToolPresentation, delegatedToolOutput, type ActivityToolData } from './activity-tool'
import { semanticActivity, semanticActivityLabel } from './activity-semantic'
import { mediaGenerationKind, mediaGenerationLabel, mediaGenerationSummaryState } from './media-generation-activity'
import { ActivityDisclosure } from './activity-disclosure'
import { isAgentActionToolName, isHiddenAgentMessageTool } from './activity-agent-action-model'
import { createContext, Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { intlLocale, useT } from '../../i18n'
import { Icon, rawIconHtml } from '../../components/Icon'
import { RawHtml } from '../../components/RawHtml'
import { renderErrorNoticeHtml } from '../error-notice'
import type { ProviderErrorDetails } from '../../../../contracts/provider-error-details'
import { useAsyncMarkdownHtml } from '../markdown-async'
import { StreamingHtml } from '../../components/StreamingHtml'
import { renderMarkdownHtml, stripMarkdownImagesForPaths, collectMarkdownImagePaths, collectReportedPaths, resolveRelativeImagePaths, collectImageSourceAliases } from '../markdown'
import { parseCreatedThreadDirective } from '../../../../contracts/created-thread-directive'
import { InlineVisualizationHtml, stripInlineVisLines } from './inline-visualization'
import type { InlineVisFragment } from '../../../../contracts/inline-visualization'
import { parseDelegationEnvelope, findEmbeddedDelegationEnvelopes, encodeDelegationEnvelope, initialDelegationMetadata, type DelegationEnvelope } from '../../../../contracts/thread-delegation'
import { hasPendingTurnStart, useChatStream, forgetRewoundTurn, loadSessionHistory, loadOlderHistoryPage, loadTurnHistoryItems, retryHistoryLoad, retainSessionStream, selectSessionStream, selectSubagentParentId, chatStreamStore, setTurnCollapsed, type LiveUnit as StoreLiveUnit, type ToolCardState } from '../stream-store'
import { transcriptScrollControllerFor, type TranscriptScrollController } from '../transcript-scroll-controller'
import { VirtualTranscript, latestTurnPhase } from './virtual-transcript'
import type { VirtualTurnListApi } from './virtual-turn-list'
import { savedTurn, type TurnItemsPagination, type TurnBoundaryRequest } from '../saved-transcript'
// 回合改动区块与 composer 胶囊读同一份按回合的产物记录，两处不各存一份副本。
import { artifactTurn, artifactsVersion, subscribeArtifacts } from '../overview'
import type { ArtifactFile, LineCount } from '../overview/artifacts'
import { isLargeDiff } from './turn-diff-parse'
import { TurnDiffPreview } from './turn-diff-preview'
import { openTurnChanges } from '../../pages/diff/store'
import { publishEndResources, turnEndResources, type TurnEndResources } from '../end-resources'
import { stripEndResourceLinkLines, endResourceFilePaths, endResourcesCoverEdits } from '../../../../contracts/end-resources'
import { retainSessionView } from '../session-view-interest'
import { EndResourceCards, useTurnEndResources } from './end-resource-card'
import { openFileCitationFromElement } from '../file-citation-open'
import type { GoalSnapshot } from '../goals'
import { PlanningQuestionHistoryView, PlanningQuestionView } from '../planning/questions-runtime'
import { ProposedPlanView } from '../planning/runtime'
import type { ProposedPlan } from '../planning/types'
import { AskUserQuestionCard, ElicitCard, ExecutionModeCard, PermissionCard, PlanReviewCard } from './approval-cards'
import { AuthRequiredCard } from './auth-card'
import { QuoteSelectionToolbar, type QuoteSurface } from './quote-selection'
import {
  FORK_BOILERPLATE_RE, TEAMMATE_MSG_RE,
  advisorResultFromBlock, advisorToolArgsFromBlock, basenameFromPath, classifyTeammateContent,
  escapeHtml, formatThinkingHtml,
  extractSentFileCards, isInterruptMarkerText,
  normalizeToolResultForReplay, parseTeammateAttrs,
  delegationEnvelopeInput, renderAgentSenderAvatarHtml, renderCreatedThreadListHtml, renderDelegationBubbleHtml, renderDelegationLabelHtml, renderDelegationLabelParsedHtml, renderExternalSenderAvatarHtml, renderMediaFigureHtml, renderMsgActionsHtml, renderOwnerSenderAvatarHtml, renderResolvedAskUserCardHtml,
  renderSentFileCardHtml, renderSentPastedCardHtml, renderSentQuoteCardHtml, renderTurnUsageMetaHtml,
  renderUserAttachmentsHtml, teammateColorVar,
  externalMessageDisplay, externalMessageSender, userAttachmentsFromContentBlocks, userBubbleEditable, userCopyText,
} from './factories'
import { visualArtifactHintState, type ReplayToolResult, type VisualArtifact } from './factories'
import { subagentAvatarHtml } from '../subagent-avatar'
import { subagentDisplayName, subagentNamePreview } from '../subagent-identity'
import {
  isTerminalSubagentStatus,
  subagentConversationId,
  subagentDisplayStatus,
  subagentTaskText,
  type SubagentDisplayStatus,
} from '../overview/subagents'
import type { AgentTask } from '../engine-events'
import { subscribeSubagents, subagentsVersion } from '../subagent-state'
import { resolveAgentActivityTask } from '../subagent-stream'
import { parseSelectedTextEnvelope } from '../selected-text-envelope'
import { dynamicActivityLabel, isExplicitMediaGenerationTool, isPetPillOnlyTool, isToolDiscovery, loadedActivityToolNames, mcpActivitySource, mcpActivityIsCommand, chatActivitySummaryLabel, skillActivityLabel, skillIdentifierFromPath, type ChatActivityTool } from './chat-activity'
import { workflowRecordFromTool, WorkflowRecordView, type WorkflowRecord } from './workflow-records'
import { goalCompletionsByTurn, type GoalCompletionSource, type GoalCompletionSummary } from './goal-completion'
import { agentEventRowStatus, isSettledAgentEventRowStatus, parseAgentLifecycleNotification, uniqueAgentLifecycleEvents, type AgentLifecycleEvent } from './agent-lifecycle'
import { writeClipboardContent, writeClipboardText, type ClipboardContent } from '../../clipboard'
import { openFriendMessageReader } from '../../friend-message-reader'
import { normalizeComposerReferences, type ComposerReferenceToken } from '../composer/reference-token'
import { isWorktreeSessionWorkdir } from '../worktree-path'
import { useDeviceNamesVersion } from '../device-names'
import { attachFriendFollowUps, friendMessageActionsHtml, friendOutgoingForMessage, friendRequestTarget, friendStatusDisplay, isIncomingFriendRequest, renderFriendCardHtml, renderFriendOutgoingStatusHtml, resolveFriendIdentity } from './friend-presentation'
import { automationMessageLabel } from './automation-source'
import { placeFriendReplies } from './friend-reply-placement'
import { friendsRuntimeSnapshot, subscribeFriendsRuntime } from '../../pages/friends/runtime-state'
import { friendOutgoingActionPending, friendOutgoingActionsRevision, performFriendOutgoingAction, subscribeFriendOutgoingActions } from '../../pages/friends/outgoing-actions'
import { renderComposerReferencePillHtml } from '../composer/reference-pill'
import { t as translate } from '../../i18n'
import { mergeTurnSequence, type TurnSequenceRef } from './turn-sequence'

type LiveUnit = (StoreLiveUnit
  | (AgentLifecycleEvent & { type: 'live-agent-event'; key: string; turnId?: string })
  | { type: 'live-compaction'; key: string; turnId?: string; trigger: string; state: 'running' | 'completed' }
  | { type: 'live-delegation'; key: string; turnId?: string; delegation: DelegationEnvelope }) & { agentEvents?: AgentLifecycleEvent[]; laterAgentIds?: string[]; friendFollowUp?: boolean }

/**
 * Re-encode a parsed envelope so an extracted mid-turn delegation unit can reuse
 * the idle path's renderer, which expects `msg.text` to be an envelope.
 *
 * The re-encoding is display-only: the stored history keeps the original text,
 * and the renderer only ever reads the prompt back out. The synthetic text is
 * therefore not a second copy of the message on disk — it exists for the few
 * microseconds between unit projection and HTML construction.
 */
function reencodeDelegationEnvelope(delegation: DelegationEnvelope): string {
  return encodeDelegationEnvelope(delegation.input, delegation.sourceThreadId, delegation.sourceHostId)
}

const w = () => window as any

// 本地媒体 path → src。唯一入口是 bridge 的 klaus.media.url（klaus-media:// 协议，
// 每次请求都重新过一遍作用域与扩展名白名单）。同步拼串，所以 HTML 工厂
// 能一次成型，不需要异步回填。
// sessionId 可选：省略时 bridge 用当前屏幕上的会话。渲染别的会话的转录（子 Agent、
// 侧任务）时必须显式传，否则拿到的是当前会话的作用域，那些图会 403。
const mediaUrl = (path: string, sessionId?: string): string => w().klaus?.media?.url?.(path, sessionId) || ''

function tGlobalText(key: string): string {
  return w().tt?.(key) || ''
}

// ==================== 组件层事件委托 ====================
// 工厂 HTML 里的交互点统一在容器上委托：与旧版 per-node onclick 行为一致，
// 且 dangerouslySetInnerHTML 重渲后无需重绑。消息级动作（rewind/
// branch/copy）需要会话上下文，由 makeTranscriptClickHandler 闭包生成。
export function makeTranscriptClickHandler(
  sessionId: string,
  copyText: (text: string) => Promise<void> = writeClipboardText,
  copyContent: (content: ClipboardContent) => Promise<void> = writeClipboardContent,
): (event: Event) => void {
  return (nativeEvent: Event) => {
    const event = nativeEvent as unknown as MouseEvent
    const target = event.target as HTMLElement
    if (handleSubmittedContentClick(event, sessionId)) return
    const friendOutgoing = target.closest<HTMLButtonElement>('button[data-friend-outgoing-action]')
    if (friendOutgoing) {
      event.stopPropagation()
      const action = friendOutgoing.dataset.friendOutgoingAction
      if (action === 'cancel' || action === 'retry') void performFriendOutgoingAction(action, friendOutgoing.dataset.friendRequestId || '')
      return
    }
    const requestReply = target.closest<HTMLButtonElement>('button[data-friend-request-reply]')
    if (requestReply) {
      event.stopPropagation()
      const taskId = requestReply.dataset.friendRequestReply || ''
      if (!taskId || requestReply.disabled) return
      if (friendsRuntimeSnapshot()?.tasks.find(task => task.id === taskId)?.replied === true) {
        w().showToast?.(tGlobalText('chat_friend_request_reply_done'))
        return
      }
      requestReply.disabled = true
      void Promise.resolve().then(() => window.klaus.friends.requestReply({ taskId })).catch((error: unknown) => {
        requestReply.disabled = false
        w().showToast?.(tGlobalText('chat_friend_request_reply_failed') + (error instanceof Error ? error.message : String(error)))
      })
      return
    }
    const friendCompose = target.closest<HTMLButtonElement>('button[data-friend-compose-action]')
    if (friendCompose && sessionId) {
      event.stopPropagation()
      const data = friendCompose.dataset
      const quote = data.friendText || ''
      window.dispatchEvent(new CustomEvent('klaus:friend-message-compose', { detail: {
        sessionId, action: data.friendComposeAction, friendId: data.friendId, name: data.friendName,
        messageId: data.friendMessageId, requestId: data.friendRequestId, questionId: data.friendQuestionId,
        // A handoff submits the friend's message itself; replies start empty.
        text: data.friendComposeAction === 'quote' || data.friendComposeAction === 'handoff' ? quote : '',
      } }))
      return
    }
    const requestLink = target.closest<HTMLButtonElement>('button[data-friend-request-target]')
    if (requestLink) {
      event.stopPropagation()
      const root = requestLink.closest('#messages, #side-messages, [data-transcript-root]') || document
      const row = [...root.querySelectorAll<HTMLElement>('[data-uuid]')].find(row => row.dataset.uuid === requestLink.dataset.friendRequestTarget)
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' })
        row.animate([{ outline: '2px solid var(--theme-accent)', outlineOffset: '6px' }, { outline: '2px solid transparent', outlineOffset: '6px' }], { duration: 1800 })
      } else if (requestLink.dataset.friendRequestTarget) {
        // The target row is loaded but not mounted by the virtual window yet.
        root.dispatchEvent(new CustomEvent('klaus-transcript-jump', { detail: { uuid: requestLink.dataset.friendRequestTarget } }))
      }
      return
    }
    const source = target.closest<HTMLButtonElement>('button[data-delegation-source-id]')
    if (source) {
      event.stopPropagation()
      const sourceId = source.dataset.delegationSourceId
      if (sourceId) void w().klausSwitchSession?.(sourceId)
      return
    }
    // A file citation chip in the reply body: open the cited file in the
    // workspace panel, at the cited line when the destination carried one.
    // Relative citations resolve against the session's workdir first — the
    // render pass cannot know it, and a chip that opens the wrong scope would
    // be worse than plain text.
    const citation = target.closest('.md-file-citation') as HTMLElement | null
    if (citation) {
      event.stopPropagation()
      openFileCitationFromElement(citation)
      return
    }
    // The shell retains the original for the reader while inline expansion
    // reveals the same Markdown body used by short friend replies.
    const friendBtn = target.closest<HTMLButtonElement>('button[data-friend-msg-action]')
    if (friendBtn) {
      event.stopPropagation()
      const shell = friendBtn.closest('.friend-msg-collapsed') as HTMLElement | null
      const full = shell?.querySelector<HTMLElement>('.friend-msg-full')
      if (!shell || !full) return
      const action = friendBtn.dataset.friendMsgAction
      if (action === 'expand') {
        const open = full.hidden
        full.hidden = !open
        const preview = shell.querySelector<HTMLElement>('.friend-msg-preview')
        if (preview) preview.hidden = open
        friendBtn.setAttribute('aria-expanded', String(open))
        friendBtn.textContent = tGlobalText(open ? 'friend_message_collapse' : 'friend_message_expand')
      } else if (action === 'reader') {
        const group = friendBtn.closest('.msg-group') as HTMLElement | null
        const name = group?.querySelector('[data-external-sender-name]')?.textContent?.trim() || ''
        openFriendMessageReader({
          title: tGlobalText('friend_reader_title').replace('{name}', name || tGlobalText('friends')),
          meta: tGlobalText('friend_message_meta').replace('{chars}', String((shell.dataset.friendMessageText || full.textContent || '').length)).replace('{lines}', String((shell.dataset.friendMessageText || full.textContent || '').split('\n').length)),
          text: shell.dataset.friendMessageText || full.textContent || '',
        })
      }
      return
    }
    // 消息操作栏：copy（无 data-action）/rewind/branch
    const actionBtn = target.closest('.msg-action-btn') as HTMLButtonElement | null
    if (actionBtn) {
      event.stopPropagation()
      if (actionBtn.disabled) return
      const bar = actionBtn.closest('.msg-actions') as HTMLElement | null
      const group = actionBtn.closest('.msg-group') as HTMLElement | null
      const action = actionBtn.dataset.action
      if (!action) {
        // copy：user 类取 bar 的原文，assistant 取气泡的 markdown 源。
        const md = group?.querySelector(':scope > .msg.assistant') as HTMLElement | null
        const text = md?.dataset.md ?? bar?.dataset.copyText ?? ''
        const rich = group ? userMessageCopyContent(group) : undefined
        const copied = rich ? copyContent(rich) : copyText(text)
        copied.then(() => {
          actionBtn.classList.add('copied')
          actionBtn.innerHTML = rawIconHtml('check')
          actionBtn.setAttribute('aria-label', tGlobalText('copied'))
          setTimeout(() => {
            actionBtn.classList.remove('copied')
            actionBtn.innerHTML = rawIconHtml('copy')
            actionBtn.setAttribute('aria-label', tGlobalText('copy'))
          }, 1500)
        }).catch(() => {
          actionBtn.setAttribute('aria-label', tGlobalText('copy_failed'))
          w().showToast?.(tGlobalText('copy_failed'))
        })
        return
      }
      if (!sessionId) return
      const uuid = group?.dataset.uuid || ''
      void runMessageAction(action, sessionId, uuid, group)
      return
    }
    handleTranscriptClick(event as unknown as React.MouseEvent)
  }
}

/**
 * Double-click on an editable user bubble opens its inline editor through the
 * same `onDoubleClick` handler on the message body. The pencil button is the discoverable entry
 * point; this is the fast path for a message the user is already reading.
 *
 * Only rows the render marked `data-editable` answer, so the recency, running,
 * archived and read-only rules live in one place (`userBubbleEditable`) instead of
 * being re-derived here. Controls inside the bubble keep their own double-click
 * (text selection in a code block, a button's own action), and a double-click that
 * lands on the action bar is the button's, not the bubble's.
 */
export function makeTranscriptDblClickHandler(sessionId: string): (event: Event) => void {
  return (nativeEvent: Event) => {
    if (!sessionId) return
    const event = nativeEvent as unknown as MouseEvent
    const target = event.target as HTMLElement
    if (target.closest('.msg-actions, button, a, input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return
    const group = target.closest('.msg-group.user[data-editable="true"]') as HTMLElement | null
    if (!group) return
    const handle = editTargetFromRow(group)
    if (!handle) return
    event.stopPropagation()
    beginSentMessageEdit(sessionId, handle)
  }
}

/**
 * The edit handle a rendered user row carries: its uuid, or the turn it started.
 *
 * A row can have only the turn. The uuid is the engine's to assign and no event carries
 * it back, so the optimistic bubble a stopped turn leaves on screen has none — but the
 * turn id is stamped on every unit of the turn in flight, and the host resolves a turn to
 * its message through the engine's own history.
 */
export function editTargetFromRow(group: HTMLElement): { uuid: string; turnId: string } | null {
  // `data-edit-uuid` is the resolved handle. It may be empty for an optimistic
  // row whose display uuid is a client-only `submission:` id, so it must win
  // over `data-uuid` even when the value is empty.
  const uuid = group.dataset.editUuid !== undefined ? group.dataset.editUuid : (group.dataset.uuid || '')
  const turnId = group.dataset.editTurn || ''
  return uuid || turnId ? { uuid, turnId } : null
}

/** Start an independent editor in the message's owning transcript row. */
function beginSentMessageEdit(sessionId: string, handle: { uuid: string; turnId: string }): void {
  openInlineUserEdit(sessionId, handle)
}

// rewind/branch 动作（对齐旧版 attachUserMessageActions/
// attachAssistantForkAction 的 IPC 与后续流）：确认框 → IPC → 成功后
// 失效 store 历史重拉（React 路径）/ fork 切会话（经 klausSwitchSession 垫片，
// chat.js 的 sessions 账本随之同步）。per-action 入飞锁防重入。
const actionInFlight = new Set<string>()

/**
 * The turn a live optimistic row belongs to, for rows whose own uuid is a
 * client-only `submission:` id the engine never persisted. The live layer stamps
 * the turn id on every unit of the turn in flight, and the host resolves a turn to
 * its message through the engine's own history — the same handle the edit path
 * carries on the row, fetched from the store because an optimistic row's DOM
 * carries no saved handle of its own.
 */
function liveTurnIdForMessage(sessionId: string, uuid: string): string {
  if (!sessionId || !uuid) return ''
  const units = (chatStreamStore.getState() as any)?.sessions?.[sessionId]?.liveUnits
  if (!Array.isArray(units)) return ''
  for (const unit of units as any[]) {
    if (unit?.msg?.uuid === uuid && typeof unit?.turnId === 'string') return unit.turnId
  }
  return ''
}

/**
 * The persisted engine uuid behind a row's display uuid.
 *
 * A live optimistic user row shows a client-only `submission:` id the engine
 * never persisted, but a fork cut point must be a persisted message uuid: the
 * engine cuts the inherited history by matching uuids it stored itself. Resolve
 * through the row's saved edit handle first, then through the turn the live
 * layer stamped on the row, matched against the saved history rows the store
 * holds for that turn (history order puts the turn's opening user message
 * before any compaction boundary or subagent communication in the same turn).
 * An id that still cannot be resolved is returned unchanged so the caller can
 * refuse the cut instead of silently forking the whole conversation.
 */
export function persistedCutUuid(sessionId: string, el: HTMLElement | null, displayUuid: string): string {
  if (!displayUuid || !displayUuid.startsWith('submission:')) return displayUuid
  const handled = el?.dataset?.editUuid
  if (handled) return handled
  const turnId = el?.dataset?.editTurn || liveTurnIdForMessage(sessionId, displayUuid)
  if (!turnId) return displayUuid
  const history = (chatStreamStore.getState() as any)?.sessions?.[sessionId]?.history
  if (!Array.isArray(history)) return displayUuid
  for (const row of history as any[]) {
    const uuid = typeof row?.uuid === 'string' ? row.uuid : ''
    const kind = typeof row?.kind === 'string' ? row.kind : ''
    if (row?.turnId === turnId && row?.role === 'user' && kind !== 'compaction' && kind !== 'agent-message'
      && uuid && !uuid.startsWith('submission:')) return uuid
  }
  return displayUuid
}

export function composerDraftFromDisplayMetadata(value: any): any | null {
  if (!value || typeof value !== 'object') return null
  const text = typeof value.displayText === 'string' ? value.displayText : ''
  const command = value.slashCommand
  const name = typeof command?.name === 'string' ? command.name.trim() : ''
  const token = name ? `/${name}` : ''
  const hasPastedCards = Array.isArray(value.pastedCards) && value.pastedCards.length > 0
  const references = normalizeComposerReferences(text, value.composerReferences)
  const document = restoreComposerDocument(value.composerDocument)
  if (!document && !token && !hasPastedCards && references.length === 0) return null
  if (!document && token && (!text.startsWith(token) || (text.length > token.length && !/\s/.test(text[token.length])))) return null
  return {
    text,
    ...(token && text.startsWith(token) ? { slashCommand: { command, range: { start: 0, end: token.length } } } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(document ? { document: snapshotComposerDocument(document) } : {}),
  }
}

/**
 * The fork cut point for an assistant reply: the first persisted user row that
 * follows it in document order.
 *
 * The main transcript wraps every turn in its own container, so the next user
 * row is NOT a sibling of an assistant row — it opens the NEXT turn wrapper. A
 * sibling-only walk stops at the wrapper edge, finds nothing, and the fork then
 * silently inherits the whole conversation instead of cutting at the reply the
 * user clicked. Walk document order instead (a node's children before its next
 * sibling), bounded by the transcript root so a transcript whose last row is
 * the clicked reply never reaches into unrelated UI.
 */
export function branchCutUuidAfter(group: HTMLElement, sessionId = ''): string {
  const root = (group.closest('[data-klaus-transcript-turn]')?.parentElement ?? group.parentElement) as HTMLElement | null
  const nextInOrder = (el: HTMLElement): HTMLElement | null => {
    if (el.firstElementChild) return el.firstElementChild as HTMLElement
    let node: HTMLElement | null = el
    while (node && !node.nextElementSibling) node = node.parentElement
    return (node?.nextElementSibling as HTMLElement | null) ?? null
  }
  // Step strictly past the clicked row's own subtree before the first check.
  let node: HTMLElement | null = group
  while (node && !node.nextElementSibling) node = node.parentElement
  node = (node?.nextElementSibling as HTMLElement | null) ?? null
  while (node && root?.contains(node)) {
    if (node.classList?.contains('user') && node.dataset?.uuid) return persistedCutUuid(sessionId, node, node.dataset.uuid)
    node = nextInOrder(node)
  }
  return ''
}

async function runMessageAction(action: string, sessionId: string, uuid: string, group: HTMLElement | null): Promise<void> {
  const lockKey = `${sessionId}:${uuid || 'tail'}:${action}`
  if (actionInFlight.has(lockKey)) return
  const api = w().klaus
  if (action === 'edit') {
    if (!group) return
    const handle = editTargetFromRow(group)
    if (!handle) return
    beginSentMessageEdit(sessionId, handle)
    return
  }
  if (action === 'rewind') {
    if (!uuid || actionInFlight.has(lockKey)) return
    actionInFlight.add(lockKey)
    try {
      if (!(await w().klausDialog.confirm({ message: tGlobalText('msg_rewind_confirm') }))) return
      const liveTurnId = liveTurnIdForMessage(sessionId, uuid)
      const res = liveTurnId
        ? await api.chat.rewindFrom(sessionId, uuid, liveTurnId)
        : await api.chat.rewindFrom(sessionId, uuid)
      if (!res?.ok && !res?.conversationChanged) {
        if (res?.reason === 'unsupported-by-engine') { await w().klausDialog.alert(tGlobalText('msg_rewind_unsupported')); return }
        if (res?.reason === 'uuid-not-found' || res?.reason === 'turn-not-in-history') {
          await loadSessionHistory(sessionId, { reconcile: true })
          await w().klausDialog.alert(tGlobalText('msg_rewind_stale'))
          return
        }
        await w().klausDialog.alert(`撤销失败：${res?.reason || 'unknown'}`)
        return
      }
      try {
        if (w().restoreRewoundMessage) {
          await w().restoreRewoundMessage(sessionId, res)
        } else if (typeof res.text === 'string') {
          const draft = composerDraftFromDisplayMetadata(res.displayMetadata)
          const restored = draft ? null : parseSelectedTextEnvelope(res.text)
          if (draft) {
            w().setComposerText?.(draft)
            const selections = Array.isArray(res.displayMetadata?.selectedTextAttachments)
              ? res.displayMetadata.selectedTextAttachments
              : []
            const pastedCards = Array.isArray(res.displayMetadata?.pastedCards)
              ? res.displayMetadata.pastedCards
              : []
            w().klausDisplayCardsAddToChat?.(selections, pastedCards)
          } else if (restored) {
            w().setComposerText?.(restored.message)
            restored.selectedTextAttachments
              .slice()
              .sort((a, b) => (Number(b.requestOffset) || 0) - (Number(a.requestOffset) || 0))
              .forEach(selection => w().klausQuoteAddToChat?.(selection.text, selection.requestOffset))
          } else {
            w().setComposerText?.(res.text)
          }
        }
      } finally {
        // Drop the message and everything after it before the history round trip.
        // A stopped turn stays on screen until that copy is removed, and a reload
        // of the pre-rewind snapshot must not be allowed to draw it again.
        forgetRewoundTurn(sessionId, uuid, liveTurnId)
        await loadSessionHistory(sessionId, { reconcile: true, rewoundLiveTail: true })
      }
      if (!res.ok) await w().klausDialog.alert(String(res.reason || 'Conversation rewind failed'))
    } catch (err: any) {
      await w().klausDialog.alert(String(err?.message || err))
    } finally {
      actionInFlight.delete(lockKey)
    }
    return
  }
  if (action === 'branch') {
    const isUser = !!group?.classList.contains('user') || !!group?.classList.contains('teammate')
    const confirmKey = isUser && uuid ? 'msg_branch_confirm' : 'msg_fork_after_confirm'
    if (!(await w().klausDialog.confirm({ message: tGlobalText(confirmKey) }))) return
    if (actionInFlight.has(lockKey)) return
    actionInFlight.add(lockKey)
    try {
      // Assistant reply: the cut is the first persisted user message after it,
      // evaluated at click time. The walk crosses turn-wrapper boundaries.
      // Both sources can be a live optimistic row carrying only a client-only
      // `submission:` id, so both go through the persisted-uuid resolution; an
      // id that still cannot be resolved aborts the branch instead of letting
      // the engine fail on it or silently inheriting the whole conversation.
      let cutUuid = isUser && uuid ? persistedCutUuid(sessionId, group, uuid) : ''
      if (!cutUuid && group) cutUuid = branchCutUuidAfter(group, sessionId)
      if (cutUuid.startsWith('submission:')) {
        await w().klausDialog.alert(tGlobalText('msg_branch_cut_unresolved'))
        return
      }
      const result = await api.session.fork(sessionId, cutUuid ? { beforeMessageUuid: cutUuid } : {})
        .catch((error: any) => ({ error: String(error?.message || error) }))
      if (!result?.id) {
        await w().klausDialog.alert(result?.error || tGlobalText('fork_session_failed'))
        return
      }
      w().showToast(tGlobalText('fork_session_success'))
      await w().klausSwitchSession?.(result.id)
      // The forked session exists on the host the moment session:fork resolves,
      // but nothing on this path pushes a list refresh (the sidebar only re-lists
      // on turn-terminal / recency engine events), so the new row would wait for
      // the next unrelated trigger. File it now, like session:new does.
      void w().updateSessionInList?.()
    } finally {
      actionInFlight.delete(lockKey)
    }
  }
}

// ==================== 产物图加载失败兜底 ====================
// 转录里的产物图 / markdown 内嵌图 / 发送附件缩略图引用的是内容寻址池的文件，
// 源文件被会话清理或移动后转录仍会引用它——img 加载失败时 Chromium 把 alt 文件
// 名画成破损图条，叠在 line-height:0 + overflow:hidden 的卡片里就是截图里那团。
// img 的 error 不冒泡，必须捕获阶段在容器上委派；React 合成事件没有捕获 error
// 通道，所以走原生 listener（与 click 委派同一挂载点）。失败态只改 DOM（补
// is-media-broken 类 + 注入图标/文件名节点），不进 stream-store：重渲会重建
// img 元素，error 重新触发一次，状态自然恢复。
//
// 类名必须双挂：失败态规则在两份样式表里各有一份——transcript.module.css 的
// 规则选择器带构建期哈希（styles['is-media-broken']），styles.css 的 md 域规则
// 是字面量。JS 运行时只能挂字面量，module 域规则就永远命中不了（headless 探针
// 实测 computed display 仍是 block），所以哈希类与字面量类同时挂上。
const MEDIA_BROKEN_CLASS = 'is-media-broken'
export const MEDIA_BROKEN_CLASS_TOKENS = [styles['is-media-broken'], MEDIA_BROKEN_CLASS].filter(Boolean).join(' ')
const BROKEN_ICON_CLASS = 'kls-media-broken-icon'
const BROKEN_NAME_CLASS = 'kls-media-broken-name'
// 委托锚点用语义 data 属性而非 CSS module 哈希类：哈希类在 bun test 的假 DOM
// 里不可复现，而且哈希变化时 JS 不应跟着变。三个渲染点（组件层产物图、历史/
// live 工具卡、markdown 内嵌图）与缩略图都挂上对应属性。
const MEDIA_FIGURE_SELECTOR = '[data-media-figure], [data-media-thumb]'
export function isMediaBrokenTarget(target: EventTarget | null): HTMLElement | null {
  // target 可能是 Document/非元素节点（error 事件在 window 捕获时），closest
  // 只在 Element 上有，所以先验形态而非 instanceof（bun test 无 DOM 全局）。
  const el = (target as Element | null)?.closest?.bind(target)
    ? (target as Element).closest<HTMLElement>(MEDIA_FIGURE_SELECTOR)
    : null
  return el && !el.classList.contains(MEDIA_BROKEN_CLASS) ? el : null
}
// 缩略图（36px 方块）只注图标不注文件名。
function isThumbFigure(figure: HTMLElement): boolean {
  return figure.getAttribute('data-media-thumb') !== null
}
export function markMediaBroken(target: EventTarget | null): HTMLElement | null {
  const figure = isMediaBrokenTarget(target)
  if (!figure) return null
  for (const token of MEDIA_BROKEN_CLASS_TOKENS.split(' ')) figure.classList.add(token)
  // 图标两种卡都注入（缩略图 36px 方块里居中，产物图在文件名前）。
  if (!figure.querySelector(`.${BROKEN_ICON_CLASS}`)) {
    const icon = document.createElement('span')
    icon.className = `${styles[BROKEN_ICON_CLASS]} ${BROKEN_ICON_CLASS}`
    let iconHtml = ''
    try { iconHtml = rawIconHtml('image-broken', { size: 16 }) } catch {}
    if (iconHtml) icon.innerHTML = iconHtml
    figure.appendChild(icon)
  }
  // 文件名只上产物图卡：缩略图本就不带名字（气泡旁有名字卡），36px 方块也放不下。
  if (!isThumbFigure(figure)) {
    const name = figure.getAttribute('data-media-path')?.split(/[\\/]/).pop() || figure.getAttribute('aria-label') || figure.querySelector('img')?.getAttribute('alt') || tGlobalText('image_unavailable')
    if (name && !figure.querySelector(`.${BROKEN_NAME_CLASS}`)) {
      const label = document.createElement('span')
      label.className = `${styles[BROKEN_NAME_CLASS]} ${BROKEN_NAME_CLASS}`
      const unavailable = tGlobalText('media_broken_image')
      label.textContent = unavailable ? `${unavailable} · ${name}` : name
      figure.appendChild(label)
      figure.setAttribute('aria-label', unavailable ? `${unavailable} ${name}` : name)
    }
  }
  const img = figure.querySelector('img')
  if (img) diagnoseMediaFailure(figure, img)
  return figure
}
function diagnoseMediaFailure(figure: HTMLElement, img: HTMLImageElement): void {
  const path = figure.getAttribute('data-media-path') || ''
  const sessionId = figure.getAttribute('data-media-session') || ''
  const api = w().klaus?.media
  if (!path || typeof api?.readImage !== 'function') return
  const src = img.getAttribute('src')
  void api.readImage({ filePath: path, sessionId, inspect: true, loadFailed: true }).then((result: any) => {
    if (img.getAttribute('src') !== src || !figure.isConnected) return
    const label = figure.querySelector(`.${BROKEN_NAME_CLASS}`)
    const name = path.split(/[\\/]/).pop() || ''
    const description = imageFailureText(result?.ok ? undefined : result?.reason)
    if (label) label.textContent = `${description} · ${name}`
    figure.setAttribute('aria-label', `${description} · ${name}`)
  }).catch(() => { /* The explicit preview retains a retry even if diagnostics are unavailable. */ })
}
export function makeTranscriptMediaErrorHandler(): (event: Event) => void {
  return (event: Event) => {
    const target = event.target as { tagName?: string } | null
    if (!target || String(target.tagName).toUpperCase() !== 'IMG') return
    markMediaBroken(event.target)
  }
}

function handleTranscriptClick(event: React.MouseEvent): void {
  const target = event.target as HTMLElement
  const processButton = target.closest('[data-background-process-shell-id]') as HTMLButtonElement | null
  if (processButton) {
    event.stopPropagation()
    const shellId = processButton.dataset.backgroundProcessShellId || ''
    const sessionId = processButton.dataset.sessionId || ''
    if (shellId) void w().klausOpenBackgroundProcess?.(shellId, sessionId || undefined)
    return
  }
  // 工具卡头部：开合 detail
  const header = target.closest(`.${styles['tool-item-header']}`)
  if (header) {
    if (header.closest('[data-live-tool-card]')) return
    header.parentElement?.classList.toggle('open')
    return
  }
  // Input/Output 复制
  const copyBtn = target.closest('.tool-detail-bar-copy') as HTMLButtonElement | null
  if (copyBtn) {
    event.stopPropagation()
    const block = copyBtn.closest('.tool-detail-block')
    const src = block?.querySelector('.tool-detail-pre, .tool-detail-fields') as HTMLElement | null
    const text = src ? (src.dataset.copyText || src.textContent || '') : ''
    writeClipboardText(text).then(() => {
      const orig = copyBtn.textContent
      copyBtn.textContent = w().tt?.('copied') || 'Copied!'
      setTimeout(() => { copyBtn.textContent = orig }, 1500)
    }).catch(() => {
      copyBtn.textContent = w().tt?.('copy_failed') || 'Failed'
      setTimeout(() => { copyBtn.textContent = w().tt?.('copy') || 'Copy' }, 1500)
    })
    return
  }
  // Raw-HTML cards that navigate to a conversation. These are built as HTML
  // strings (postProcess / envelope folders), so they cannot use a React onClick
  // the way ChatActivity does — this delegate is their only click path.
  const threadNav = target.closest('[data-created-thread-id]') as HTMLElement | null
  if (threadNav) {
    event.stopPropagation()
    // Same contract as the read/send activity cards: a nonempty id goes straight to
    // the switcher, which loads an empty history for one that no longer exists
    // rather than failing. Validating against the sidebar here would race a stale
    // inventory and give these cards stricter rules than their siblings for no
    // user-visible benefit.
    const id = threadNav.dataset.createdThreadId || ''
    if (id) void w().klausSwitchSession?.(id)
    return
  }
  // 代码块复制（postProcess 结构）
  const codeCopy = target.closest('.code-copy') as HTMLButtonElement | null
  if (codeCopy) {
    const code = codeCopy.closest(`.${styles['code-block']}`)?.querySelector('code')
    writeClipboardText(code?.textContent || '').then(() => {
      codeCopy.textContent = w().tt?.('copied') || 'Copied'
      setTimeout(() => { codeCopy.textContent = w().tt?.('copy') || 'Copy' }, 2000)
    }).catch(() => {
      codeCopy.textContent = w().tt?.('copy_failed') || 'Failed'
      setTimeout(() => { codeCopy.textContent = w().tt?.('copy') || 'Copy' }, 2000)
    })
    return
  }
  // Healthy and failed figures share the viewer. Failed local references retain
  // their exact source and use scoped inspection plus explicit retry.
  const figure = target.closest('[data-media-figure]') as HTMLElement | null
  if (figure) {
    const img = figure.querySelector('img')
    const src = (img as HTMLImageElement | null)?.currentSrc || img?.getAttribute('src') || ''
    if (src) w().openImagePreview?.(src, imagePreviewOptionsFromElement(figure, event.currentTarget as HTMLElement))
    return
  }
  // 发送图片缩略图 → 预览大图（chat.js 的 openImagePreview 垫片）
  const thumb = target.closest('[data-media-thumb]') as HTMLElement | null
  if (thumb) {
    const img = thumb.querySelector('img')
    const src = (img as HTMLImageElement | null)?.currentSrc || img?.getAttribute('src') || ''
    if (src) w().openImagePreview?.(src, imagePreviewOptionsFromElement(thumb, event.currentTarget as HTMLElement))
    return
  }
  // fork boilerplate 展开/收起
  const forkToggle = target.closest(`.${styles['fork-toggle']}`) as HTMLButtonElement | null
  if (forkToggle) {
    const bubble = forkToggle.closest(`.${styles['fork-bubble']}`)
    const pre = bubble?.querySelector(`.${styles['fork-boilerplate']}`)
    if (pre) {
      const willShow = pre.classList.contains('hidden')
      pre.classList.toggle('hidden', !willShow)
      forkToggle.textContent = willShow ? (w().tt?.('fork_hide_protocol') || '') : (w().tt?.('fork_show_protocol') || '')
    }
    return
  }
  // created-thread 列表的展开/收起（「Show N more chats」行）。纯 DOM
  // 切换:data-collapsed 翻转让 CSS 同时旋转 chevron 并隐藏/显示溢出行,文案换
  // 预存的两种语言值(不经 tt(),切语言后重渲会重建整份 HTML)。
  const moreToggle = target.closest('[data-created-thread-more]') as HTMLButtonElement | null
  if (moreToggle) {
    event.stopPropagation()
    const list = moreToggle.closest('[data-created-thread-list]') as HTMLElement | null
    if (list) {
      const collapsed = list.dataset.collapsed !== 'false'
      list.dataset.collapsed = collapsed ? 'false' : 'true'
      moreToggle.setAttribute('aria-expanded', collapsed ? 'true' : 'false')
      const label = moreToggle.querySelector('span')
      if (label) label.textContent = collapsed ? moreToggle.dataset.fewerLabel || '' : moreToggle.dataset.moreLabel || ''
    }
    return
  }
}

// ==================== markdown 后处理（代码块增强） ====================
// 旧版 postProcessMsg：pre>code 包 .code-block 外壳 + 语言角标 + 复制按钮。
// 输出结构逐字节一致；点击行为走上面的事件委托。
function postProcessHtml(html: string): string {
  const host = document.createElement('div')
  host.innerHTML = html
  host.querySelectorAll('pre code').forEach(block => {
    const langClass = [...block.classList].find(c => c.startsWith('language-'))
    const lang = langClass ? langClass.replace('language-', '') : ''
    const wrapper = document.createElement('div')
    wrapper.className = styles['code-block']
    const pre = block.parentElement!
    pre.replaceWith(wrapper)
    wrapper.appendChild(pre)
    if (lang && lang !== 'plaintext') {
      const badge = document.createElement('span')
      badge.className = styles['code-lang']
      badge.textContent = lang
      wrapper.appendChild(badge)
    }
    const btn = document.createElement('button')
    btn.className = 'code-copy'
    btn.textContent = w().tt?.('copy') || 'Copy'
    wrapper.appendChild(btn)
  })
  const cardsHtml = renderCreatedThreadCards(host)
  if (cardsHtml) host.insertAdjacentHTML('beforeend', cardsHtml)
  return host.innerHTML
}

/**
 * Code-block and created-thread post-processing runs on detached HTML. Inline
 * pages are mounted later, on the committed React-owned node, from the content
 * the host projected with the message.
 */

function inlineVisPostProcess(html: string): string {
  const host = document.createElement('div')
  host.innerHTML = html
  host.querySelectorAll('pre code').forEach(block => {
    const langClass = [...block.classList].find(c => c.startsWith('language-'))
    const lang = langClass ? langClass.replace('language-', '') : ''
    const wrapper = document.createElement('div')
    wrapper.className = styles['code-block']
    const pre = block.parentElement!
    pre.replaceWith(wrapper)
    wrapper.appendChild(pre)
    if (lang && lang !== 'plaintext') {
      const badge = document.createElement('span')
      badge.className = styles['code-lang']
      badge.textContent = lang
      wrapper.appendChild(badge)
    }
    const btn = document.createElement('button')
    btn.className = 'code-copy'
    btn.textContent = w().tt?.('copy') || 'Copy'
    wrapper.appendChild(btn)
  })
  const cardsHtml = renderCreatedThreadCards(host)
  if (cardsHtml) host.insertAdjacentHTML('beforeend', cardsHtml)
  return host.innerHTML
}

/**
 * The created-thread pass of `postProcessHtml`, testable without a DOM engine.
 *
 * `paragraphs` is the markdown output pre-split into top-level blocks (the test
 * stub splits on `<p>`/`</p>` boundaries). Each block is consumed when EVERY
 * nonempty line in it parses as one directive; consumed blocks vanish, and the
 * returned HTML carries their cards appended after whatever prose remains. The
 * real DOM path (`renderCreatedThreadCards` above) implements the identical rule
 * against `host.querySelectorAll('p')` — these two are the same decision tree in
 * two runtimes, and the paired assertions pin that they stay in step.
 */
export function postProcessHtmlForTests(paragraphs: readonly string[]): string {
  const kept: string[] = []
  const threadIds: string[] = []
  for (const paragraph of paragraphs) {
    // `<br>` becomes a newline BEFORE tag stripping, mirroring the DOM walk's
    // br→text replacement: with `breaks: true`, marked separates consecutive
    // directive lines with `<br>`, and stripping it as a plain tag would glue
    // the lines together and fail the per-line parse.
    const text = paragraph.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    if (lines.length === 0) { kept.push(paragraph); continue }
    const directives = lines.map(line => parseCreatedThreadDirective(line))
    if (directives.some(d => d === null)) { kept.push(paragraph); continue }
    for (const directive of directives) threadIds.push(directive!.threadId)
  }
  const cards = renderCreatedThreadListHtml(threadIds)
  return `${kept.join('')}${cards}`
}

/**
 * Strip every directive paragraph and return the card list HTML for the whole
 * message.
 *
 * Directives are matched PER LINE, not per paragraph. `marked` merges consecutive
 * lines into one `<p>`, so the old
 * whole-paragraph match silently leaked two adjacent directives as raw text —
 * the exact bug this replaces. Now a paragraph qualifies when EVERY line in it
 * is a well-formed directive; the paragraphs are removed and the rows mount
 * once, AFTER the message body (the mt-3 block below the prose), so the
 * cards never interleave with text.
 *
 * A line that only PARTIALLY matches keeps its whole paragraph as visible text:
 * dropping the sentence around a directive would delete model output the user
 * was owed, and showing the raw syntax is the cheaper failure. Fenced content is
 * still safe — `marked` puts fence lines inside `<pre><code>`, never `<p>`, so
 * a directive the model was DISCUSSING is never consumed here.
 *
 * Returns '' when nothing parsed, so the caller appends nothing.
 */
function renderCreatedThreadCards(host: HTMLElement): string {
  const threadIds: string[] = []
  for (const paragraph of [...host.querySelectorAll('p')]) {
    // `textContent`, never `innerHTML`: entities such as `&quot;` must come back
    // decoded to match the directive syntax. `<br>` must become a newline FIRST
    // (`breaks: true` puts one between consecutive lines and textContent drops
    // it — without this, two adjacent directives read as ONE glued line and the
    // per-line parse fails exactly like the old whole-paragraph match did).
    for (const br of paragraph.querySelectorAll('br')) br.replaceWith('\n')
    const lines = (paragraph.textContent ?? '').split('\n').map(line => line.trim()).filter(line => line.length > 0)
    if (lines.length === 0) continue
    const directives = lines.map(line => parseCreatedThreadDirective(line))
    if (directives.some(d => d === null)) continue
    for (const directive of directives) threadIds.push(directive!.threadId)
    paragraph.remove()
  }
  return renderCreatedThreadListHtml(threadIds)
}

// ==================== user 消息 HTML（appendUserMsg 的纯构造版） ====================
const SLASH_PILL_TOKEN_RE = /(^|\s)\/([A-Za-z0-9_:-]+)(?=\s|$)/

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// composerAuthored = 本面的 user 回合真的是人在输入框里发的。粘贴 chip 是「发送
// 时那一行待发卡」的复原：历史里只剩拍平的 text，所以主转录按体量猜一次，让
// 重载后的样子和发出去时一致。子 Agent 转录的 user 回合不是人发的，是父
// Agent 写给它的 prompt：在那儿猜粘贴等于把任务指令藏进一枚点不开的 chip（转
// 录里的 chip 无交互），只留最后一段可读。
export function buildUserBubbleHtml(msg: any, composerAuthored: boolean, sessionId?: string): { html: string; navTurn: boolean; attachmentsHtml?: string; content?: SubmittedContent } | null {
  const text = msg.text
  // Optimistic messages carry an explicit rendering snapshot. Replay restores
  // quotes from the text envelope first, then derives the remaining cards from
  // text/contentBlocks. Subagent prompts deliberately skip this UI convention.
  const local = msg.localRender || null
  if (externalMessageDisplay(local) !== null) {
    const stream = sessionId ? chatStreamStore.getState().sessions[sessionId] : undefined
    const target = msg.friendRequestTarget ?? (stream ? friendRequestTarget([
      ...(stream.history || []), ...stream.liveUnits.flatMap(unit => unit.type === 'live-user' ? [{ ...unit.msg, role: 'user' }] : []),
    ], local) : undefined)
    return { html: renderFriendCardHtml(local, externalMessageSender(local, msg.text), translate, target, sessionId, friendsRuntimeSnapshot()), navTurn: false }
  }
  const parsedQuote = (local || !composerAuthored) ? null : parseSelectedTextEnvelope(text)
  const renderedText = parsedQuote?.message ?? text
  // 历史路径的图只带 path（内容寻址池），在这里转成 klaus-media:// 的 src；
  // 本地乐观气泡的 attachments 已携 objectUrl，不动。
  const replayAttachments = userAttachmentsFromContentBlocks(msg.contentBlocks)
    .map((entry) => (entry.path ? { ...entry, sessionId, src: mediaUrl(entry.path, sessionId) } : entry))
  // Optimistic snapshots can precede session creation. Bind missing owners so
  // previews and file actions use this transcript's scope.
  const localAttachments = (Array.isArray(local?.attachments) ? local.attachments : [])
    .map((entry: any) => entry ? { ...entry, sessionId: entry.sessionId || sessionId } : entry)
  let attachments = mergeSubmittedAttachments(localAttachments, replayAttachments)
  // Pasted cards render from their record, never from a size guess: the send
  // snapshot carries them, and histories written after references existed carry
  // the `# Files pasted by the user:` section in the message text itself.
  const referenceSection = (local || !composerAuthored) ? null : parsePastedReferenceSection(renderedText)
  const pastedCards = Array.isArray(local?.pastedCards)
    ? local.pastedCards
    : (referenceSection?.cards ?? [])
  const selectedTextAttachments = Array.isArray(local?.selectedTextAttachments)
    ? local.selectedTextAttachments
    : (parsedQuote?.selectedTextAttachments ?? [])
  let displayText = local && Object.prototype.hasOwnProperty.call(local, 'displayText')
    ? local.displayText
    : local ? renderedText : (referenceSection?.displayText ?? renderedText)
  // Goal objectives name their owned images with Markdown reference lines so the
  // engine can grant read authority; the bubble shows thumbnails instead of the
  // internal paths, on the live snapshot and on replay alike.
  const goalImages = extractGoalImageReferences(String(displayText))
  if (goalImages) {
    displayText = goalImages.displayText
    attachments = [...attachments, ...goalImages.images.map(image => ({
      type: 'image', name: image.name, sessionId,
      src: image.remote ? image.target : mediaUrl(image.target, sessionId),
      ...(image.remote ? {} : { path: image.target }),
    }))]
  }
  const slashCommand = local?.slashCommand ?? null
  const slashPillRe = slashCommand?.name
    ? new RegExp(`(^|\\s)\\/(${escapeRegExp(String(slashCommand.name).trim())})(?=\\s|$)`, 'i')
    : SLASH_PILL_TOKEN_RE
  const documentBody = renderUserDocument(local?.composerDocument, token => {
    const data = token.data as Record<string, any> | null
    if (data?.kind === 'selected-text') return renderSentQuoteCardHtml(data, true)
    if (data?.kind === 'command') return w().renderSlashPillHtml?.(data.command?.name, data.command) || escapeHtml(token.label)
    const reference = normalizeComposerReferences(token.value, [{ ...data, value: token.value, range: { start: 0, end: token.value.length } }])[0]
    return reference ? renderComposerReferencePillHtml(reference, true) : escapeHtml(token.label)
  })
  if (documentBody && !msg.questionAnswer) {
    const cards = [renderUserAttachmentsHtml(attachments), pastedCards.map(renderSentPastedCardHtml).filter(Boolean).join('')].filter(Boolean).join('')
    const cardsHtml = cards ? `<div class="kls-attach-row ${styles['sent-attachments']}">${cards}</div>` : ''
    const bubble = documentBody.hasContent ? `<div class="msg user ${styles['user-document']}">${documentBody.html}</div>` : ''
    if (!bubble && !cardsHtml) return null
    return { html: `<div class="sent-user-stack">${cardsHtml}${bubble}</div>`, navTurn: true, attachmentsHtml: cardsHtml,
      content: { beforeHtml: '', attachments, afterHtml: pastedCards.map(renderSentPastedCardHtml).filter(Boolean).join(''),
        bubble: documentBody.hasContent ? { className: `msg user ${styles['user-document']}`, html: documentBody.html } : null } }
  }
  const authoredContent = [String(displayText), ...selectedTextAttachments.flatMap((quote: any) => [quote?.text, quote?.previewText])].join('\n')
  let markerPrefix = 'KLAUS_USER_TOKEN_'
  while (authoredContent.includes(markerPrefix)) markerPrefix += '_'
  const SLASH_PILL_PLACEHOLDER = `${markerPrefix}SLASH`
  let pillName: string | null = null
  let working: any = displayText
  const composerReferences: ComposerReferenceToken[] = typeof working === 'string' && (local || composerAuthored)
    ? normalizeComposerReferences(working, local?.composerReferences)
    : []
  const referenceMarkers = composerReferences.map((reference, index) => ({
    reference,
    marker: `${markerPrefix}REFERENCE_${index}_TOKEN`,
  }))
  const workspaceMentionPills: Array<{ rel: string; isDir: boolean }> = []
  if (typeof working === 'string') {
    for (const { reference, marker } of referenceMarkers.slice().sort((left, right) => right.reference.range.start - left.reference.range.start)) {
      working = working.slice(0, reference.range.start) + marker + working.slice(reference.range.end)
    }
    const positionedCards = [
      ...selectedTextAttachments.map((card: any, index: number) => ({ card, index, kind: 'quote' as const })),
    ]
      .filter(({ card }) => Number.isInteger(card?.requestOffset))
      .sort((a, b) => {
        const offsetDelta = a.card.requestOffset - b.card.requestOffset
        if (offsetDelta) return offsetDelta
        const orderDelta = Number(a.card.displayOrder ?? a.index) - Number(b.card.displayOrder ?? b.index)
        return orderDelta || (a.kind === b.kind ? a.index - b.index : a.kind.localeCompare(b.kind))
      })
    let added = 0
    for (const { card, index, kind } of positionedCards) {
      const marker = `${markerPrefix}QUOTE_${index}_TOKEN`
      const originalOffset = Math.max(0, Math.min(String(displayText).length, card.requestOffset))
      const referenceDelta = referenceMarkers.reduce((delta, entry) => (
        entry.reference.range.end <= originalOffset
          ? delta + entry.marker.length - entry.reference.value.length
          : delta
      ), 0)
      const offset = Math.max(0, Math.min(working.length, originalOffset + referenceDelta)) + added
      working = working.slice(0, offset) + marker + working.slice(offset)
      added += marker.length
    }
    const pillMatch = slashPillRe.exec(working)
    if (pillMatch) {
      pillName = pillMatch[2]
      const leadingSpace = pillMatch[1] || ''
      working = working.slice(0, pillMatch.index) +
        leadingSpace +
        SLASH_PILL_PLACEHOLDER +
        working.slice(pillMatch.index + pillMatch[0].length)
    }
    // workspace mention（@"rel" 语法）→ pill 占位（chat.js 同款正则语义）
    working = String(working).replace(/(^|\s)@"([^"]+)"/g, (match: string, prefix: string, rel: string) => {
      if (!rel || rel.endsWith(' (agent)')) return match
      const index = workspaceMentionPills.length
      const isDir = rel.endsWith('/')
      workspaceMentionPills.push({ rel: isDir ? rel.replace(/\/+$/, '') : rel, isDir })
      return `${prefix}${markerPrefix}FILE_${index}_TOKEN`
    })
  }
  const extractedFiles = extractSentFileCards(working)
  working = extractedFiles.text
  const fileSvg = rawIconHtml('file-2')
  const imgSvg = rawIconHtml('img')
  let html = escapeHtml(working)
  html = html.replace(/\[Files?: (.+?)\]/g, (_, names) =>
    names.split(',').map((n: string) => `<span class="file-badge">${fileSvg} ${escapeHtml(n.trim())}</span>`).join(' '))
  html = html.replace(/\[Pasted image\]/g, `<span class="file-badge">${imgSvg} image</span>`)
  html = html.replace(/\[图片: (.+?)\]/g, (_, name) => `<span class="file-badge">${imgSvg} ${escapeHtml(name)}</span>`)
  html = html.replace(/\[图片\]/g, `<span class="file-badge">${imgSvg} image</span>`)
  html = html.replace(/\[文件: (.+?)\]/g, (_, name) => `<span class="file-badge">${fileSvg} ${escapeHtml(name)}</span>`)
  html = html.replace(/@(\/[^\s]+\.(png|jpg|jpeg|gif|webp))/gi, (_, path) =>
    `<img src="file://${escapeHtml(path)}" style="max-height:200px;border-radius:8px;margin:4px 0;display:block">`)
  if (pillName) {
    // slash pill 渲染依赖 slash 域（命令图标/分组类名）——经 chat.js 垫片；
    // 垫片缺席（极早期）退回纯文本。
    const pillHtml = w().renderSlashPillHtml?.(pillName, slashCommand) || escapeHtml('/' + pillName)
    html = html.replace(SLASH_PILL_PLACEHOLDER, pillHtml)
  }
  workspaceMentionPills.forEach((mention, index) => {
    const pill = w().renderWorkspaceMentionPillHtml?.(mention.rel, mention.isDir)
      || `<span class="slash-pill workspace-mention-pill">${escapeHtml('@' + mention.rel)}</span>`
    html = html.replace(`${markerPrefix}FILE_${index}_TOKEN`, pill)
  })
  referenceMarkers.forEach(({ reference, marker }) => {
    const pill = renderComposerReferencePillHtml(reference, true)
    html = html.replace(marker, pill)
  })
  selectedTextAttachments.forEach((quote: any, index: number) => {
    if (!Number.isInteger(quote?.requestOffset)) return
    html = html.replace(`${markerPrefix}QUOTE_${index}_TOKEN`, renderSentQuoteCardHtml(quote))
  })
  const questionReplies = msg.questionAnswer?.answers && Array.isArray(msg.questionAnswer.questions)
    ? questionReplyDisplay(msg.questionAnswer, attachments.filter(entry => entry?.type === 'image' && entry.src).length)
    : null
  const attachmentsHtml = renderUserAttachmentsHtml(attachments)
  const extractedFilesHtml = extractedFiles.cards.map(renderSentFileCardHtml).filter(Boolean).join('')
  const cards = [
    selectedTextAttachments.filter((quote: any) => !Number.isInteger(quote?.requestOffset)).map(renderSentQuoteCardHtml).filter(Boolean).join(''),
    attachmentsHtml,
    extractedFilesHtml,
    pastedCards.map(renderSentPastedCardHtml).filter(Boolean).join(''),
  ].filter(Boolean).join('')
  // 附件行：图片方块与文件/粘贴 chip 共用一行（同输入框待发行），不再每张卡占一行。
  const cardsHtml = cards ? `<div class="kls-attach-row ${styles['sent-attachments']}">${cards}</div>` : ''
  if (questionReplies) {
    const replies = questionReplies.map(reply => `<div class="${styles['question-reply']}"><div class="${styles['question-reply-quote']}">${escapeHtml(reply.question)}</div>${reply.text ? `<div class="${styles['question-reply-answer']}">${renderMarkdownHtml(reply.text, sessionId)}</div>` : ''}</div>`).join('')
    return { html: `<div class="sent-user-stack">${cardsHtml}<div class="msg user">${replies}</div></div>`, navTurn: false,
      content: { beforeHtml: selectedTextAttachments.filter((quote: any) => !Number.isInteger(quote?.requestOffset)).map(renderSentQuoteCardHtml).filter(Boolean).join(''),
        attachments, afterHtml: extractedFilesHtml + pastedCards.map(renderSentPastedCardHtml).filter(Boolean).join(''),
        bubble: { className: 'msg user', html: replies } } }
  }
  const bubbleHtml = html ? `<div class="msg user">${html}</div>` : ''
  if (!bubbleHtml && !cardsHtml) return null
  return { html: `<div class="sent-user-stack">${cardsHtml}${bubbleHtml}</div>`, navTurn: true, attachmentsHtml: cardsHtml,
    content: { beforeHtml: selectedTextAttachments.filter((quote: any) => !Number.isInteger(quote?.requestOffset)).map(renderSentQuoteCardHtml).filter(Boolean).join(''),
      attachments, afterHtml: extractedFilesHtml + pastedCards.map(renderSentPastedCardHtml).filter(Boolean).join(''),
      bubble: html ? { className: 'msg user', html } : null } }
}

function buildForkHtml(text: string): string {
  const m = FORK_BOILERPLATE_RE.exec(text)
  const boilerplate = (m && m[1] || '').trim()
  const tail = (m && m[2] || '').trim()
  const directiveMatch = /^Your directive:\s*([\s\S]*)$/i.exec(tail)
  const directive = directiveMatch ? directiveMatch[1].trim() : tail
  const t = (key: string) => w().tt?.(key) || ''
  return `
    <div class="msg user ${styles['fork-bubble']}">
      <div class="${styles['fork-header']}">
        ${rawIconHtml('fork')}
        <span class="${styles['fork-label']}">${escapeHtml(t('fork_label'))}</span>
        <button class="${styles['fork-toggle']}" type="button">${escapeHtml(t('fork_show_protocol'))}</button>
      </div>
      <div class="${styles['fork-directive']}">${escapeHtml(directive || t('fork_directive_empty'))}</div>
      <pre class="${styles['fork-boilerplate']} hidden">${escapeHtml(boilerplate)}</pre>
    </div>
  `
}

function buildTeammateCardHtml({ variant, color, teammateName, title, bodyHtml }: {
  variant: string; color: string; teammateName: string; title: string; bodyHtml: string
}): string {
  return `<div class="teammate-card variant-${variant}" style="--teammate-color: ${color};">
    <div class="teammate-card-header">
      <span class="teammate-dot" style="background:${color};border-color:${color}"></span>
      <span class="teammate-name">@${escapeHtml(teammateName)}</span>
      <span class="teammate-card-title">${escapeHtml(title)}</span>
    </div>
    ${bodyHtml ? `<div class="teammate-card-body">${bodyHtml}</div>` : ''}
  </div>`
}

function buildTeammateGroupHtml(text: string, sessionId?: string): string {
  const t = (key: string) => w().tt?.(key) || ''
  const blocks: Array<{ attrs: Record<string, string>; content: string }> = []
  let m
  TEAMMATE_MSG_RE.lastIndex = 0
  while ((m = TEAMMATE_MSG_RE.exec(text)) !== null) {
    blocks.push({ attrs: parseTeammateAttrs(m[1]), content: m[2] })
  }
  const parts: string[] = []
  for (const block of blocks) {
    const cls = classifyTeammateContent(block.content)
    if (cls.kind === 'hidden') continue
    const teammateName = block.attrs.teammate_id || 'teammate'
    const summary = block.attrs.summary || ''
    const color = teammateColorVar(block.attrs.color)
    if (cls.kind === 'plan_request') {
      parts.push(buildTeammateCardHtml({
        variant: 'plan-request', color, teammateName, title: t('teammate_plan_request_title'),
        bodyHtml: `<div class="${styles['teammate-card-markdown']}">${renderMarkdownHtml(cls.planContent || '', sessionId)}</div>`
          + (cls.planFilePath ? `<div class="${styles['teammate-card-meta']}">${escapeHtml(cls.planFilePath)}</div>` : ''),
      }))
    } else if (cls.kind === 'plan_response') {
      const ok = !!cls.approved
      parts.push(buildTeammateCardHtml({
        variant: ok ? 'plan-approved' : 'plan-rejected', color, teammateName,
        title: ok ? t('teammate_plan_approved_title') : t('teammate_plan_rejected_title'),
        bodyHtml: cls.feedback ? `<div class="${styles['teammate-card-feedback']}">${escapeHtml(cls.feedback)}</div>` : '',
      }))
    } else if (cls.kind === 'shutdown_request') {
      parts.push(buildTeammateCardHtml({
        variant: 'shutdown-request', color, teammateName, title: t('teammate_shutdown_request_title'),
        bodyHtml: cls.reason ? `<div class="${styles['teammate-card-feedback']}">${escapeHtml(cls.reason)}</div>` : '',
      }))
    } else if (cls.kind === 'shutdown_rejected') {
      parts.push(buildTeammateCardHtml({
        variant: 'shutdown-rejected', color, teammateName, title: t('teammate_shutdown_rejected_title'),
        bodyHtml: cls.reason ? `<div class="${styles['teammate-card-feedback']}">${escapeHtml(cls.reason)}</div>` : '',
      }))
    } else if (cls.kind === 'task_completed') {
      parts.push(buildTeammateCardHtml({
        variant: 'task-completed', color, teammateName, title: t('teammate_task_completed_title'),
        bodyHtml: cls.taskId ? `<div class="${styles['teammate-card-meta']}">#${escapeHtml(String(cls.taskId))}</div>` : '',
      }))
    } else {
      parts.push(`<div class="${styles['teammate-bubble']}" style="--teammate-color: ${color};">
        <div class="${styles['teammate-header']}">
          <span class="teammate-dot" style="background:${color};border-color:${color}"></span>
          <span class="teammate-name">@${escapeHtml(teammateName)}</span>
          ${summary ? `<span class="${styles['teammate-summary']}">${escapeHtml(summary)}</span>` : ''}
        </div>
        <div class="${styles['teammate-content']}">${renderMarkdownHtml(cls.text || '', sessionId)}</div>
      </div>`)
    }
  }
  return parts.join('')
}

/**
 * Fold a cross-conversation delegation envelope into a card.
 *
 * The envelope is what the recipient MODEL reads (it carries the sender's id so a
 * reply can find its way back); the recipient's OWNER should see the sender's
 * prose. Same division as `<fork-boilerplate>` and `<teammate-message>`.
 *
 * Returns '' when the text is not exactly one well-formed envelope, so the caller
 * falls back to rendering it as an ordinary user message. A half-parsed wrapper
 * shown as text beats a card that swallowed the model's actual prompt.
 */
// ==================== assistant blocks → 分段 ====================
type SubagentActivityKind = 'spawn'

export function isSubagentSpawnToolName(toolName: string): boolean {
  const name = toolName.replace(/^tool-/, '').toLowerCase()
  return name === 'task' || name === 'agent' || name === 'spawn_agent'
}

type SegmentTool = {
  toolName: string
  toolCallId: string
  args: any
  state: string
  output: ReplayToolResult | null
  agent: boolean
  activityKind: SubagentActivityKind | null
  pendingResult?: boolean
}

interface Segment {
  kind: 'thinking' | 'text' | 'tools' | 'ask-user' | 'proposed-plan' | 'goal-completion'
  plan?: ProposedPlan
  goal?: GoalSnapshot
  thinking?: string
  durationLabel?: string
  text?: string
  messageId?: string
  phase?: 'commentary' | 'partial_answer' | 'final_answer'
  /** The page content the host projected with this text, one entry per directive line. */
  inlineVis?: InlineVisFragment[]
  tools?: SegmentTool[]
  block?: any
  /**
   * Delegation envelopes the engine drained into this segment's tool results.
   *
   * A mid-turn delivery lands in the LAST tool result's text, so the envelope
   * arrives glued to a tool call rather than as its own message. The renderer
   * must not leave the message buried under a fold the way a tool row is: a
   * steered message is a first-class user bubble whether the thread was idle or
   * busy on arrival. `foldUnits` keeps the lifted
   * unit as a persistent fold section at its arrival position; the tool card
   * keeps only the sanitized output.
   */
  delegations?: DelegationEnvelope[]
}

function subagentActivityKind(toolName: string): SubagentActivityKind | null {
  return isSubagentSpawnToolName(toolName) ? 'spawn' : null
}

export function segmentsFromBlocks(blocks: any[], thinkingDurationMs: number | undefined): Segment[] {
  const segments: Segment[] = []
  let pendingThinking = ''
  let thinkingDurationUsed = false
  let pendingText = ''
  let pendingMessageId: string | undefined
  let pendingPhase: 'commentary' | 'partial_answer' | 'final_answer' | undefined
  let pendingInlineVis: InlineVisFragment[] = []
  let currentTools: Segment | null = null
  const advisorResultsById = new Map<string, ReplayToolResult>()
  for (const b of blocks) {
    if (b?.type === 'advisor_tool_result' && typeof b.tool_use_id === 'string') {
      advisorResultsById.set(b.tool_use_id, advisorResultFromBlock(b))
    }
  }
  const flushThinking = () => {
    if (!pendingThinking.trim()) { pendingThinking = ''; return }
    const dur = (!thinkingDurationUsed && typeof thinkingDurationMs === 'number' && Number.isFinite(thinkingDurationMs) && thinkingDurationMs >= 0)
      ? `${Math.max(1, Math.round(thinkingDurationMs / 1000))}s`
      : '…'
    segments.push({ kind: 'thinking', thinking: pendingThinking, durationLabel: dur })
    pendingThinking = ''
    thinkingDurationUsed = true
    currentTools = null
  }
  const flushText = () => {
    if (!pendingText.trim()) { pendingText = ''; pendingInlineVis = []; return }
    segments.push({ kind: 'text', text: pendingText, messageId: pendingMessageId, phase: pendingPhase,
      ...(pendingInlineVis.length ? { inlineVis: pendingInlineVis } : {}) })
    pendingMessageId = undefined
    pendingPhase = undefined
    pendingText = ''
    pendingInlineVis = []
    currentTools = null
  }
  const ensureTools = (): Segment => {
    if (!currentTools) {
      currentTools = { kind: 'tools', tools: [] }
      segments.push(currentTools)
    }
    return currentTools
  }
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      flushText()
      pendingThinking += (b.thinking ?? b.data ?? '')
    } else if (b.type === 'text' && typeof b.text === 'string') {
      flushThinking()
      const phase = b.phase === 'commentary' || b.phase === 'partial_answer' || b.phase === 'final_answer' ? b.phase : undefined
      const messageId = typeof b.messageId === 'string' ? b.messageId : undefined
      if (pendingText && (pendingMessageId !== messageId || pendingPhase !== phase)) flushText()
      pendingMessageId = messageId
      pendingPhase = phase
      pendingText += b.text
      if (Array.isArray(b.inlineVis)) pendingInlineVis = pendingInlineVis.concat(b.inlineVis as InlineVisFragment[])
      currentTools = null
    } else if (b.type === 'goal_completion' && b.goal?.status === 'complete') {
      flushThinking()
      flushText()
      segments.push({ kind: 'goal-completion', goal: { ...b.goal, tokenBudget: b.goal.tokenBudget ?? null } })
      currentTools = null
    } else if (b.type === 'proposed_plan' && b.plan && typeof b.plan.id === 'string') {
      flushThinking()
      flushText()
      segments.push({ kind: 'proposed-plan', plan: b.plan })
      currentTools = null
    } else if (b.type === 'tool_use') {
      flushThinking()
      flushText()
      // AskUserQuestion 历史卡：独立顶层卡，保持 blocks 序位（旧版 rebuild 在
      // 循环内原位 append 并重置工具容器）。
      if (isQuestionTool(b.name) && Array.isArray(b.input?.questions) && !normalizeToolResultForReplay(b.__result)?.isError) {
        segments.push({ kind: 'ask-user', block: b })
        currentTools = null
        continue
      }
      if (isTaskMutationTool(b.name)) continue
      const activityKind = subagentActivityKind(b.name || '')
      const agent = activityKind !== null
      const result = normalizeToolResultForReplay(b.__result)
      if (result && isAgentActionToolName(b.name || '') && b.__result?.agentCommunication) {
        result.text = JSON.stringify(b.__result.agentCommunication)
      }
      // A mid-turn delegation arrives drained into this result's text (the
      // engine appends it after the tool's own output). Split it off before the
      // card renders, so the tool card shows only its own output and the
      // envelope surfaces as its own user bubble via `segment.delegations`.
      const delegations = !agent && result
        ? findEmbeddedDelegationEnvelopes(result.text).map(segment => segment.parsed)
        : []
      if (delegations.length && result) {
        const found = findEmbeddedDelegationEnvelopes(result.text)
        let rebuilt = ''
        for (const entry of found) rebuilt += entry.before
        rebuilt += result.text.slice(found.reduce((at, entry) => at + entry.before.length + entry.raw.length, 0))
        result.text = rebuilt.replace(/\s+$/, '')
      }
      const tool: SegmentTool = {
        toolName: b.name || '',
        toolCallId: b.id || '',
        args: b.input,
        state: result?.isError ? 'error' : 'done',
        output: agent ? null : result,
        agent,
        activityKind,
        pendingResult: b.__result == null,
      }
      if (activityKind) {
        currentTools = null
        segments.push({ kind: 'tools', tools: [tool] })
      } else {
        const container = ensureTools()
        container.tools!.push(tool)
        if (delegations.length) container.delegations = [...(container.delegations || []), ...delegations]
      }
    } else if (b.type === 'server_tool_use' && b.name === 'advisor') {
      flushThinking()
      flushText()
      const result = advisorResultsById.get(b.id) || null
      ensureTools().tools!.push({
        toolName: 'advisor',
        toolCallId: b.id || '',
        args: advisorToolArgsFromBlock(b),
        state: result ? (result.isError ? 'error' : 'done') : 'running',
        output: result,
        agent: false,
        activityKind: null,
      })
    } else if (b.type === 'advisor_tool_result') {
      continue
    }
  }
  flushThinking()
  flushText()
  return segments
}

// ==================== msg-group 单元展开与轮次折叠 ====================
// 旧版是 DOM 后处理（collapseHistoryTurnOps 把每轮中间过程收进 turn-fold）；
// React 版在数据层做同构变换：messages → units → 按 user 轮界折叠 → 渲染。

export interface Unit {
  goalCompletion?: GoalCompletionSummary
  friendFollowUp?: boolean
  /** A received collaboration result presented inside its requesting process. */
  friendReplyInProcess?: boolean
  /** The completed turn whose resources this final reply presents. */
  endResourceTurn?: { turnId: string; status: string } | null
  type: 'agent-event' | 'compaction' | 'compact-file-restore' | 'compact-summary' | 'turn-status' | 'fail-hint' | 'user' | 'fork' | 'teammate' | 'delegation' | 'thinking' | 'text' | 'tools' | 'ask-user' | 'proposed-plan' | 'goal-completion' | 'approval-review' | 'workflow-record'
  key: string
  approvalReview?: ApprovalReview
  workflowRecord?: WorkflowRecord
  msg?: any
  segment?: Segment
  block?: any
  // 末段 text 才挂操作栏（对齐 pruneIntermediateAssistantActions：一轮内中间
  // assistant 段的按钮被剔除，只留最后一段）。foldUnits 里标记。
  hasActions?: boolean
  agentEvent?: AgentLifecycleEvent
  agentEvents?: AgentLifecycleEvent[]
  laterAgentIds?: string[]
  ts?: number
  restoredText?: string
  // 消息归属的 turn id（来自 history 投影的 turnId 字段）。
  turnId?: string
  // Explicit identity from session/history. The final reply stays visible even
  // when later tool activity belongs to the same Turn.
  isFinalReply?: boolean
  /** An optional answer with a later final reply is completed turn activity. */
  hasFollowingFinalAnswer?: boolean
  // 同回合工具卡已出图的本地路径集合：中间正文渲染前剥掉指向这些路径的
  // markdown 图（最终回复不剥，见 foldUnits 的让位判定）。
  suppressImagePaths?: ReadonlySet<string>
  // 最终回复已嵌图的本地路径集合：工具卡对让位，不再出同路径产物图。
  suppressFigurePaths?: ReadonlySet<string>
  // 最终回复里相对路径的图已按本回合工具产物解析成绝对路径后的正文。渲染面用
  // 它，data-md（复制源）也用它，所以用户复制到的路径就是能打开的那个。未改写
  // 时不设，渲染原文。
  resolvedText?: string
  /** Page content the host projected with this text block; empty means no directive or nothing projected. */
  inlineVis?: InlineVisFragment[]
  // A mid-turn delegation lifted out of a tool result (see Segment.delegations).
  // Present on synthetic delegation units only; the idle path's delegation unit
  // carries the envelope inside `msg.text` instead.
  delegation?: DelegationEnvelope
  /**
   * Set on a user unit whose row the host steered into a running turn. The row is
   * the user's words but not a turn opener, so it is never the edit target — the
   * same rule that applies to steered items.
   */
  steered?: boolean
}

/**
 * Which message an edit may target, addressed by whatever identity the layer holding it
 * has: a settled history row by its uuid, an optimistic live bubble by the turn it started.
 *
 * Two identity shapes because the uuid is the engine's to assign and no event carries it
 * back, so a bubble the renderer drew itself has none. The turn id is enough: the engine's
 * history maps every message uuid to the turn that produced it, so the host resolves the
 * turn to exactly one message. See `userMessageUuidForTurn` on the host side.
 */
export type EditTargetRef = { uuid: string; turnId: string }

/**
 * Whether a uuid names a message the engine has persisted.
 *
 * The composer paints its optimistic bubble with a client-only `submission:` id
 * before the engine assigns the real uuid. That id is useful for matching the
 * bubble while the send is in flight, but it is not a message identity the host
 * can resolve. Edit must fall back to the turn id instead of sending it.
 */
export function isEngineMessageUuid(uuid: string): boolean {
  return !!uuid && !uuid.startsWith('submission:')
}

/** Whether `ref` names this row: by uuid when there is one, else by turn. */
export function isEditTarget(ref: EditTargetRef | null, uuid: string | undefined, turnId: string | undefined): boolean {
  if (!ref) return false
  if (ref.uuid) return !!uuid && uuid === ref.uuid
  return !!ref.turnId && !!turnId && turnId === ref.turnId
}

/**
 * Whether an inline edit names this row, from the row's own identity.
 *
 * The turn half is deliberately withheld from a steered row. A steer that arrived mid-turn
 * shares its turn id with the opener, so `isEditTarget` alone would light the pencil on the
 * injection too and let a click resolve to the OPENER's uuid. That resolves, so the click
 * succeeds — but it silently rewrites the wrong message. `editTargetFor` already skips
 * steered rows, so the target is never a steer; withholding the handle here keeps the row
 * unable to match even if the row's own `steered` flag arrives late.
 */
export function rowIsEditTarget(ref: EditTargetRef | null, uuid: string | undefined, turnId: string | undefined, steered: boolean): boolean {
  if (steered) return false
  return isEditTarget(ref, uuid, turnId)
}

/**
 * Project one optimistic live user unit into the history-shaped units the transcript
 * renders, KEEPING the live layer's turn handle.
 *
 * `unitsFromMessages` only reads the wrapped message, so it cannot know the turn: the
 * bubble is painted by `ingestLocalUserTurn` before the engine names the turn, and the id
 * is stamped onto the live unit by `patchSession` once `stream_mode` reports it. Dropping
 * it here is what made a stopped turn's bubble unreachable for Edit — that bubble has no
 * uuid (the engine assigns it and no event reports it), so the turn is its only handle.
 */
export function liveUserRenderUnits(unit: { turnId?: string; msg: any }): Unit[] {
  return unitsFromMessages([unit.msg]).map(u => ({ ...u, turnId: u.turnId ?? unit.turnId }))
}

/**
 * The newest editable user message across BOTH transcript layers, or null.
 *
 * Editable means an ordinary user message. Fork / teammate / delegation bubbles are
 * excluded because they are not messages the user typed into this conversation — they are
 * protocol wrappers folded to the sender's prose, so editing one would rewrite a marker
 * the model depends on.
 *
 * The live layer is consulted FIRST, and that ordering is the whole point. A turn the user
 * stopped keeps its partial output in the live layer and deliberately never reloads
 * history, so the newest bubble on screen is the optimistic one; reading only the history
 * layer named the PREVIOUS message instead, which is why Edit vanished (or landed on the
 * wrong bubble) after every stop. While a turn runs, `userBubbleEditable`'s running gate
 * hides the entry point, so consulting the live layer costs nothing there.
 *
 * A steered history row is skipped: it is the user's words injected into a turn that was
 * already running, not a message that opened one, so the editable target stays the last
 * turn opener — Edit is offered on exactly that row and never on a steer.
 *
 * A history row with no uuid is skipped: it cannot be a target, and offering Edit on it
 * would fail with `uuid-not-found`.
 */
export function editTargetFor(historyUnits: Unit[], liveUnits: Array<{ type: string; turnId?: string; msg?: { uuid?: unknown; steered?: unknown } }>): EditTargetRef | null {
  for (let index = liveUnits.length - 1; index >= 0; index -= 1) {
    const unit = liveUnits[index]
    if (unit?.type !== 'live-user' || unit.msg?.steered === true) continue
    const uuid = typeof unit.msg?.uuid === 'string' && isEngineMessageUuid(unit.msg.uuid) ? unit.msg.uuid : ''
    const turnId = typeof unit.turnId === 'string' ? unit.turnId : ''
    if (uuid) return { uuid, turnId }
    if (turnId) return { uuid: '', turnId }
  }
  for (let index = historyUnits.length - 1; index >= 0; index -= 1) {
    const unit = historyUnits[index]
    if (unit?.type !== 'user' || unit.steered === true) continue
    const uuid = unit.msg?.uuid
    if (typeof uuid === 'string' && isEngineMessageUuid(uuid)) return { uuid, turnId: typeof unit.turnId === 'string' ? unit.turnId : '' }
  }
  return null
}

export function unitsFromMessages(visible: any[], legacyCreator?: string): Unit[] {
  const units: Unit[] = []
  const completedGoals = new Set<string>()
  let seenUserInput = false
  const msgTurnId = (msg: any) => (typeof msg.turnId === 'string' && msg.turnId) ? msg.turnId : undefined
  visible.forEach((msg, index) => {
    const base = (msg.role === 'user' ? clientMessageId(msg) : undefined) || msg.uuid || `i-${index}`
    const tid = msgTurnId(msg)
    if (msg.kind === 'approval-review') { const review = approvalReview(msg.approvalReview); if (review) units.push({ type: 'approval-review', key: `review:${review.reviewId}`, msg, approvalReview: review, turnId: review.turnId }); return }
    if (msg.kind === 'agent-event' && msg.agentEvent) { units.push({ type: 'agent-event', key: base, msg, agentEvent: msg.agentEvent, turnId: tid }); return }
    // Received agent communication is model context, not a conversation message.
    if (msg.kind === 'agent-message') return
    if (msg.kind === 'compaction') { units.push({ type: 'compaction', key: base, msg, turnId: tid }); return }
    if (msg.kind === 'compact-file-restore') {
      const previous = units[units.length - 1]
      if (previous?.type === 'compaction') previous.restoredText = msg.text
      else units.push({ type: 'compact-file-restore', key: base, msg, turnId: tid })
      return
    }
    if (msg.kind === 'compact-summary') { units.push({ type: 'compact-summary', key: base, msg, turnId: tid }); return }
    // The raw engine interrupt marker is a transport detail. Turn status is
    // rendered once for the enclosing Turn below, never as a detached message.
    if (isInterruptMarkerText(msg.text)) return
    if (msg.role === 'user') {
      const firstInput = !seenUserInput
      seenUserInput = true
      const text = msg.text
      if (typeof text === 'string') {
        if (/^<task-notification(?:\s|>)/i.test(text.trimStart())) {
          const agentEvent = parseAgentLifecycleNotification(text)
          if (agentEvent) units.push({ type: 'agent-event', key: base, msg, agentEvent, turnId: tid })
          return
        }
        if (text.includes('<fork-boilerplate>')) { units.push({ type: 'fork', key: base, msg, turnId: tid }); return }
        if (text.includes('<teammate-message')) { units.push({ type: 'teammate', key: base, msg, turnId: tid }); return }
        // A cross-conversation delegation, folded like the two above so the recipient's
        // owner reads the sender's prose rather than the protocol wrapper that carries
        // the source id for the model.
        //
        // Classified by the STRICT parser, not by a substring test on the tag. The two
        // envelopes above can be detected by their tags because nothing else produces
        // them, but a delegation envelope is a shape a user can type or paste — "what
        // does <klaus-delegation> mean?" and a code sample both contain the tag. A
        // substring test routed those to a unit the delegation renderer cannot render,
        // which threw and blanked the whole transcript.
        //
        // Parsing here also keeps the unit honest: a message that is NOT exactly one
        // well-formed envelope stays an ordinary `user` unit, so it keeps the editing
        // affordance its author is owed, and the renderer's own fallback stays a
        // second line of defence rather than the only one.
        const envelope = parseDelegationEnvelope(text)
        if (envelope) {
          const initialInput = msg.localRender?.delegationKind === 'initial-input'
            || firstInput && !!legacyCreator && envelope.sourceThreadId === legacyCreator
          units.push(initialInput
            ? { type: 'user', key: base, msg: { ...msg, localRender: { ...msg.localRender, ...initialDelegationMetadata(envelope.input) } }, turnId: tid }
            : { type: 'delegation', key: base, msg, turnId: tid })
          return
        }
      }
      // A steered follow-up is a user row but not a message the user sent as a turn
      // opener: the host marks it at submit time and the projection carries the flag
      // here. Edit targets only turn openers, so the flag rides the unit.
      units.push({ type: 'user', key: base, msg, turnId: tid, ...(msg.steered === true ? { steered: true } : {}) })
      return
    }
    if (Array.isArray(msg.contentBlocks)) {
      const segments = segmentsFromBlocks(msg.contentBlocks, msg.thinkingDurationMs)
      let finalTextIndex = -1
      if (msg.isFinalReply) {
        for (let index = segments.length - 1; index >= 0; index--) {
          if (segments[index].kind === 'text') { finalTextIndex = index; break }
        }
      }
      const occurrences = new Map<string, number>()
      segments.forEach((segment, si) => {
        if (segment.kind === 'goal-completion' && segment.goal) {
          if (completedGoals.has(segment.goal.goalId)) return
          completedGoals.add(segment.goal.goalId)
        }
        const occurrence = segment.messageId ? occurrences.get(segment.messageId) || 0 : 0
        if (segment.messageId) occurrences.set(segment.messageId, occurrence + 1)
        units.push({
          type: segment.kind, key: segment.messageId ? `message:${segment.messageId}${occurrence ? `:segment:${occurrence}` : ''}` : `${base}-s${si}`, segment,
          ...(segment.kind === 'ask-user' ? { block: segment.block } : {}),
          ts: msg.timestamp,
          turnId: tid,
          isFinalReply: segment.phase === 'final_answer' || (!segment.phase && si === finalTextIndex),
        })
        // A mid-turn delivery rides a tool result (see Segment.delegations), so
        // the envelope surfaces here as its OWN unit rather than inside the tool
        // container. The unit carries the real uuid when history has one, which
        // is what keeps copy/rewind acting on the stored message rather than a
        // re-wrapped copy; the key deduplicates across history reloads.
        for (const [di, delegation] of (segment.delegations || []).entries()) {
          units.push({
            type: 'delegation',
            key: `delegation:${base}:s${si}:d${di}`,
            msg: { ...msg, uuid: msg.uuid, text: reencodeDelegationEnvelope(delegation) },
            turnId: tid,
            delegation,
          })
        }
        // Consumed: the tools unit keeps only its own output, so the envelope
        // cannot render twice (once as the lifted bubble, once inside a card).
        segment.delegations = []
      })
      return
    }
    units.push({
      type: 'text', key: base, segment: { kind: 'text', text: msg.text || '',
        ...(msg.phase === 'commentary' || msg.phase === 'partial_answer' || msg.phase === 'final_answer' ? { phase: msg.phase } : {}) },
      ts: msg.timestamp, turnId: tid, isFinalReply: (msg.isFinalReply === true || msg.phase === 'final_answer'),
    })
  })
  const withTargets = units.map(unit => unit.msg?.localRender?.externalFriendMessage
    ? { ...unit, msg: { ...unit.msg, friendRequestTarget: friendRequestTarget(visible, unit.msg.localRender) } } : unit)
  return attachFriendFollowUps(withTargets)
}

export function applyTurnTimestamps(
  messages: any[],
  turnStartedAtMs: Record<string, number>,
  turnFinishedAtMs: Record<string, number>,
): any[] {
  return messages.map(msg => {
    if (msg?.timestamp || typeof msg?.turnId !== 'string') return msg
    const timestamp = msg.role === 'user'
      ? turnStartedAtMs[msg.turnId]
      : msg.role === 'assistant'
        ? turnFinishedAtMs[msg.turnId]
        : undefined
    return timestamp ? { ...msg, timestamp } : msg
  })
}

type FoldItem =
  | { kind: 'unit'; unit: Unit }
  | { kind: 'turn-agents'; key: string; tools: NonNullable<Segment['tools']>; turnInterrupted: boolean; turnId?: string }

type ActivityFoldNode = {
  kind: 'activity-fold'
  key: string
  items: FoldItem[]
  turnId?: string
  foldKey: string
  open: boolean
  mode: 'summary' | 'active' | 'thinking'
  activeAction?: ActivityAction
  thinkingHeading?: string
  summary: ActivitySummary
}

type TurnFoldNode = {
  kind: 'turn-fold'
  key: string
  items: RenderNode[]
  turnId?: string
  foldKey: string
  open: boolean
  messageCount: number
  durationMs?: number
  startedAtMs?: number | null
  completedAtMs?: number | null
  running?: boolean
}

type RenderNode =
  | { kind: 'unit'; unit: Unit }
  | ActivityFoldNode
  | TurnFoldNode
  | { kind: 'history-gap'; key: string; request: TurnBoundaryRequest }
  | { kind: 'turn-visuals'; key: string; artifacts: VisualArtifact[] }
  // 本回合工具产出的图片，恒可见。挂在折叠之外，理由见 foldUnits 里的注释。
  | { kind: 'turn-media'; key: string; paths: string[] }
  // 回合改动区块：跟在该回合最后一个兄弟节点之后，内容自己从产物 store 取。
  // 回合末资源卡已经呈现了它改的每个文件时不出（status/finalText 用于这个判定）。
  | { kind: 'turn-changes'; key: string; turnId: string; status?: string; finalText?: string }
  // 回合内启动的子 agent 状态行；连续 spawn 共用一个投影节点，但逐个渲染。
  | { kind: 'turn-agents'; key: string; tools: NonNullable<Segment['tools']>; turnInterrupted: boolean; turnId?: string }
  // 工作树初始化行：跟在本回合首个用户气泡之后（worktree-init 语义），
  // 只在 foldUnits 有了用户节点才插 —— 进行中态归 live 层，这里只画落定态。
  | { kind: 'worktree-init'; key: string; status: 'completed' | 'failed' }
  // A turn with no process content yet still shows its elapsed work time.
  | { kind: 'work-divider'; key: string; startedAtMs: number | null; completedAtMs?: number | null }

function isAnswerToTurn(msg: any, turnId?: string): boolean {
  return !!msg?.questionAnswer && (!msg.questionAnswer.turnId || !turnId || msg.questionAnswer.turnId === turnId)
}

function isPersistentTurnNode(node: RenderNode): boolean {
  return node.kind === 'unit' && !node.unit.friendReplyInProcess
    && !(node.unit.type === 'user' && node.unit.msg?.questionAnswer && node.unit.hasFollowingFinalAnswer)
    && (['user', 'delegation', 'workflow-record', 'proposed-plan', 'goal-completion', 'approval-review'].includes(node.unit.type)
    || node.unit.type === 'ask-user' && !isSettledAskUserUnit(node.unit)
    // A partial answer is stable answer text that may be followed by more
    // output or tool calls: it stays visible when the turn's process
    // collapses, without taking the final-reply identity.
    || node.unit.type === 'text' && node.unit.segment?.phase === 'partial_answer')
}

// 在途回合的身份。主转录必须按引擎给的 turn_id 认：history 层与 live 层同时
// 在画，只有身份能把「本回合」和上一轮完结回合分开。子 Agent 只读转录两样都
// 没有——壳层不给它 turn 图（engine.rs subagent_transcript_messages 传空 map），
// 也没有 live 层——它的在途回合就是转录尾组，用 'tail' 表示。
export type InProgressTurn = { turnId: string } | 'tail'

export function uniqueVisualArtifacts(values: Array<VisualArtifact | undefined>): VisualArtifact[] {
  const index = new Map<string, number>()
  const artifacts: VisualArtifact[] = []
  for (const value of values) {
    if (!value) continue
    const key = `${value.kind}:${value.id}`
    const at = index.get(key)
    // A later artifact for the same surface replaces the earlier one: the card
    // shows the newest state the turn observed (created empty, then drawn into).
    if (at === undefined) { index.set(key, artifacts.length); artifacts.push(value) } else artifacts[at] = value
  }
  return artifacts
}

function visualArtifactsFromUnits(units: Unit[]): VisualArtifact[] {
  return uniqueVisualArtifacts(units.flatMap(unit =>
    unit.type === 'tools'
      ? (unit.segment?.tools || []).map(tool => tool.output?.artifact)
      : [],
  ))
}

// A child settling after its parent turn ended keeps the turn that spawned it
// (the store stamps spawnTurnId onto the task and the record), so its row stays
// inside the owning turn — merged with its siblings and ahead of the turn's
// change block — instead of forming a per-agent tail group. Records persisted
// before that stamping carry a per-agent pseudo turn; repair them here from the
// spawn call still visible in the same transcript.
function reanchorAgentEventTurns(units: Unit[]): Unit[] {
  const spawnTurnByTask = new Map<string, string>()
  for (const unit of units) {
    for (const tool of unit.segment?.tools || []) {
      if (tool.activityKind === 'spawn' && unit.turnId && !spawnTurnByTask.has(tool.toolCallId)) {
        spawnTurnByTask.set(tool.toolCallId, unit.turnId)
      }
    }
  }
  if (!spawnTurnByTask.size) return units
  const tasks = Object.fromEntries(w().KlausSubagentPanel?.listTasks?.() || []) as Record<string, AgentTask>
  return units.map(unit => {
    if (unit.type !== 'agent-event') return unit
    if (unit.turnId && !unit.turnId.startsWith('agent:')) return unit
    const event = unit.agentEvent && resolveAgentActivityTask(unit.agentEvent, tasks)
    const spawnTurn = spawnTurnByTask.get(event?.taskId || '')
    return spawnTurn && spawnTurn !== unit.turnId ? { ...unit, turnId: spawnTurn } : unit
  })
}

function groupAdjacentAgentEvents<T extends Unit | LiveUnit>(units: T[]): T[] {
  const tasks = Object.fromEntries(w().KlausSubagentPanel?.listTasks?.() || []) as Record<string, AgentTask>
  const eventOf = (unit: Unit | LiveUnit) => unit.type === 'live-agent-event' ? unit : unit.type === 'agent-event' ? unit.agentEvent : undefined
  const groups = units.reduce<T[]>((result, unit) => {
    const previous = result.at(-1)
    const event = eventOf(unit)
    const previousEvent = previous && eventOf(previous)
    if (event && previousEvent && unit.turnId === previous?.turnId) {
      // Coalesce presentation only: retain every notification in the source list.
      result[result.length - 1] = { ...previous, agentEvents: [...(previous.agentEvents || [previousEvent]), ...(unit.agentEvents || [event])] }
    } else result.push(unit)
    return result
  }, [])
  const laterIds = new Set<string>()
  return [...groups].reverse().map(unit => {
    const event = eventOf(unit)
    if (!event) return unit
    const result = { ...unit, laterAgentIds: [...laterIds] }
    for (const item of unit.agentEvents || [event]) {
      const resolved = resolveAgentActivityTask(item, tasks)
      laterIds.add(resolved.agentId || resolved.taskId)
    }
    return result
  }).reverse()
}

export function activityEntries(units: Unit[], turnKey: string, interrupted: boolean, recordedWorkflowIds: Set<string>,
  livePlanReviewIds: ReadonlySet<string> = new Set()): ActivityEntry<FoldItem>[] {
  // Once a child reports its own lifecycle inline, the settled spawn call row
  // is redundant, so the spawn entry is dropped when every receiver has inline
  // activity. Running spawns keep their row.
  const notified = new Set(units.filter(unit => unit.type === 'agent-event' && unit.agentEvent)
    .map(unit => unit.agentEvent!.taskId))
  const runningSpawns = new Set(units.flatMap(unit => unit.segment?.tools || [])
    .filter(tool => tool.activityKind === 'spawn' && (tool.state === 'running' || tool.state === 'awaiting-approval')).map(tool => tool.toolCallId))
  const visible = units.flatMap<Unit>(unit => {
    if (unit.type === 'agent-event' && unit.agentEvent?.status === 'started' && runningSpawns.has(unit.agentEvent.taskId)) return []
    if (unit.type !== 'tools' || !unit.segment?.tools) return [unit]
    const tools = unit.segment.tools.filter(tool => !isHiddenAgentMessageTool({ ...tool, output: tool.output?.text }))
    return tools.length ? [{ ...unit, segment: { ...unit.segment, tools } }] : []
  })
  return groupAdjacentAgentEvents(visible).flatMap((unit): ActivityEntry<FoldItem>[] => {
    if (unit.type === 'text' && !(unit.segment?.text || unit.msg?.text || '').trim()) return []
    if (unit.type !== 'tools') return [{
      key: unit.key,
      value: { kind: 'unit', unit },
      grouping: unit.type === 'thinking' ? 'reasoning' : 'standalone',
    }]
    return (unit.segment?.tools || []).flatMap((tool, index): ActivityEntry<FoldItem>[] => {
      // The pet pill is the only consumer of this call; the transcript keeps
      // its row out of the history projection entirely.
      if (isPetPillOnlyTool(tool.toolName)) return []
      const key = tool.toolCallId || `${unit.key}:${index}`
      const workflowRecord = workflowRecordFromTool(tool)
      if (workflowRecord) {
        if (workflowRecord.kind === 'goal-completed') return []
        if (recordedWorkflowIds.has(key)) return []
        recordedWorkflowIds.add(key)
        // The live review card is the same approval record on screen; the
        // history-side record would render a second settled card for it.
        if (workflowRecord.kind === 'spec-execution' && livePlanReviewIds.has(key)) return []
        return [{ key, grouping: 'standalone', value: { kind: 'unit', unit: { type: 'workflow-record', key: `workflow:${key}`, turnId: unit.turnId, workflowRecord } } }]
      }
      if (tool.activityKind) {
        // A settled spawn call whose child already reports inline lifecycle
        // rows is the same child twice, so the spawn entry is dropped once its
        // receivers have inline activity.
        if (notified.has(key) && tool.state !== 'running' && tool.state !== 'awaiting-approval') return []
        return [{
          key,
          value: { kind: 'turn-agents', key: `turn-agents-${turnKey}-${key}`, tools: [tool], turnInterrupted: interrupted, turnId: unit.turnId },
          grouping: 'standalone',
        }]
      }
      return [{
        key,
        value: { kind: 'unit', unit: { ...unit, key: `tool:${key}`, segment: { kind: 'tools', tools: [tool] } } },
        grouping: isAgentActionToolName(tool.toolName) || tool.state === 'awaiting-approval' ? 'standalone' : 'tool',
        action: describeActivity(tool.toolName, tool.args, tool.state, tool.output?.text, tool.output?.media),
      }]
    })
  })
}

function groupTurnActivities(
  entries: ActivityEntry<FoldItem>[], turnId: string | undefined, turnKey: string,
  active: boolean, overrides: Record<string, boolean>, tailClosed = false,
): RenderNode[] {
  const nodes: RenderNode[] = projectActivity(entries, active, tailClosed).map(node => {
    if (node.kind === 'item') return node.entry.value
    const foldKey = `activity:${turnKey}:${node.key}`
    return {
      kind: 'activity-fold', key: foldKey, foldKey, turnId,
      items: node.entries.map(entry => entry.value),
      open: activityCollapseState(node.mode, overrides[foldKey]).open,
      mode: node.mode, activeAction: node.activeAction, summary: node.summary,
    }
  })
  return nodes.reduce<RenderNode[]>((result, node) => {
    const previous = result.at(-1)
    if (previous?.kind === 'turn-agents' && node.kind === 'turn-agents') previous.tools.push(...node.tools)
    else result.push(node)
    return result
  }, [])
}

function hasUnsettledAgents(items: FoldItem[], turnId?: string): boolean {
  return items.some(item => item.kind === 'turn-agents'
    && resolveSubagentActivities(item.tools, item.turnInterrupted).some(row => subagentPreventsAutoCollapse(row, turnId)))
}

// A child that is still working holds the turn open; every terminal outcome
// (completed, stopped, failed) settles it. A failed spawn must still render its
// row with the failure label — settling only releases the fold, not the record.
function subagentPreventsAutoCollapse(row: ResolvedSubagentActivity, turnId?: string): boolean {
  // The turn stays open only while a child is still working: a failed
  // child's background record is dropped entirely (its last turn failed while
  // the runtime is no longer active), and an interrupted child settles. Only
  // non-terminal statuses hold the fold open.
  return !(turnId && row.task?.spawnTurnId && row.task.spawnTurnId !== turnId) && !isTerminalSubagentStatus(row.status)
}

// Fold from each child's latest lifecycle while retaining earlier notices.
function unsettledAgentEventRows(units: (Unit | LiveUnit)[]): boolean {
  const events = units.flatMap(unit => {
    const events = unit.type === 'live-agent-event'
      ? (unit.agentEvents || [unit as AgentLifecycleEvent])
      : unit.type === 'agent-event' && unit.agentEvent
        ? (unit.agentEvents || [unit.agentEvent])
        : null
    return events?.map(event => ({ ...event, turnId: unit.turnId })) || []
  })
  const panel = w().KlausSubagentPanel
  const tasks = Object.fromEntries(panel?.listTasks?.() || []) as Record<string, AgentTask>
  // Historical labels stay intact. Only the latest lifecycle for each child
  // controls folding, so an earlier start cannot pin a finished run open.
  return uniqueAgentLifecycleEvents(events.map(event => resolveAgentActivityTask(event, tasks))).some(event => {
    if (isSettledAgentEventRowStatus(event.status)) return false
    const task = tasks[event.taskId] || panel?.getTask?.(event.taskId)
      || (event.agentId ? panel?.getTaskByConversationId?.(event.agentId)?.task : undefined)
    if (task?.spawnTurnId && event.turnId && task.spawnTurnId !== event.turnId) return false
    const startedAt = (event as AgentLifecycleEvent & { timestamp?: number }).timestamp
    if (event.status === 'started' && typeof startedAt === 'number' && task) {
      const terminalAt = task.completedAtMs ?? task.lifecycleUpdatedAtMs ?? task.updatedAtMs
      if (typeof terminalAt === 'number' && startedAt > terminalAt) return true
    }
    return !task || !isTerminalSubagentStatus(subagentDisplayStatus(task))
  })
}
// A settled question card is turn process evidence: like any other tool row it
// folds with the turn that asked. A pending request must stay outside the fold —
// it owns the composer slot and the user has to see it to answer.
function isSettledAskUserUnit(unit: { type: string; block?: any; req?: any; resolved?: unknown; request?: { status: string } }): boolean {
  if (unit.type === 'ask-user') return unit.block?.name === 'ask_user_async' || questionResolution(unit.block) !== null
  if (unit.type === 'live-ask') return unit.req?.responseChannel === 'async-question' || unit.resolved != null
  if (unit.type === 'live-planning-question') return unit.request?.status !== 'pending'
  return false
}

export interface TurnArtifactAnchor {
  ownerKey?: string
}

/** Resolve footer ownership before pagination or compaction hides its message. */
const artifactMessageUnits = new WeakMap<object, { text: unknown; blocks: unknown; final: unknown; units: Unit[] }>()

/** Immutable saved rows share their artifact projection across history page updates. */
function artifactUnitsForMessage(message: any): Unit[] {
  const cached = artifactMessageUnits.get(message)
  if (cached && cached.text === message.text && cached.blocks === message.contentBlocks && cached.final === message.isFinalReply) return cached.units
  const units = unitsFromMessages([message])
  artifactMessageUnits.set(message, { text: message.text, blocks: message.contentBlocks, final: message.isFinalReply, units })
  return units
}

export function turnArtifactAnchors(history: any[]): Map<string, TurnArtifactAnchor> {
  const anchors = new Map<string, TurnArtifactAnchor>()
  const keyed = history.map((msg, index) => msg.uuid ? msg : { ...msg, uuid: `i-${index}` })
  for (const msg of keyed) {
    if (!msg.turnId) continue
    const anchor = anchors.get(msg.turnId) ?? {}
    const hasFinal = msg.isFinalReply || msg.phase === 'final_answer'
      || msg.contentBlocks?.some((block: any) => block.phase === 'final_answer')
    if (hasFinal) {
      const final = [...artifactUnitsForMessage(msg)].reverse().find(unit => unit.type === 'text' && unit.isFinalReply && unit.segment?.text?.trim())
      if (final) anchor.ownerKey = final.key
    }
    anchors.set(msg.turnId, anchor)
  }
  for (let index = keyed.length - 1; index >= 0; index--) {
    const msg = keyed[index]
    const anchor = anchors.get(msg.turnId)
    if (anchor && !anchor.ownerKey) anchor.ownerKey = artifactUnitsForMessage(msg).at(-1)?.key
  }
  return anchors
}

export function foldUnits(...args: Parameters<typeof foldTurnGroups>): RenderNode[] {
  return foldTurnGroups(...args).flatMap(group => group.nodes)
}

function goalSourcesFromHistory(units: readonly Unit[]): GoalCompletionSource[] {
  return units.flatMap<GoalCompletionSource>(unit => {
    if (unit.type === 'goal-completion' && unit.segment?.goal) return [{
      turnId: unit.turnId, snapshot: true,
      completion: { goalId: unit.segment.goal.goalId, durationSeconds: unit.segment.goal.timeUsedSeconds },
    }]
    return (unit.segment?.tools ?? []).flatMap(tool => {
      const completion = workflowRecordFromTool(tool)
      return completion?.kind === 'goal-completed' ? [{ turnId: unit.turnId, completion }] : []
    })
  })
}

/** Both render layers use the same outcomes while answer ownership hands over. */
export function transcriptGoalCompletions(history: readonly Unit[], live: readonly LiveUnit[] = [],
  tools: Record<string, ToolCardState> = {}): Map<string, GoalCompletionSummary> {
  return goalCompletionsByTurn([...goalSourcesFromHistory(history), ...goalSourcesFromLive(live, tools)])
}

function goalSourcesFromLive(live: readonly LiveUnit[], tools: Record<string, ToolCardState>): GoalCompletionSource[] {
  const sources: GoalCompletionSource[] = []
  for (const unit of live) {
    if (unit.type === 'live-goal-completion') sources.push({
      turnId: unit.turnId, snapshot: true,
      completion: { goalId: unit.goal.goalId, durationSeconds: unit.goal.timeUsedSeconds },
    })
    if (unit.type !== 'live-tools') continue
    for (const id of unit.order) {
      const card = tools[id]
      const completion = card && workflowRecordFromTool({ ...card, state: card.status })
      if (completion?.kind === 'goal-completed') sources.push({ turnId: unit.turnId, completion })
    }
  }
  return sources
}

function useTranscriptGoalCompletions(sessionId: string, history: any[]): ReadonlyMap<string, GoalCompletionSummary> {
  const savedSources = useMemo(() => goalSourcesFromHistory(unitsFromMessages(history)), [history])
  // Only compact accounting changes invalidate saved folds. Streaming text and
  // tool progress must not reparse the full conversation on every frame.
  const liveSignature = useChatStream(state => {
    const session = state.sessions[sessionId]
    return JSON.stringify(goalSourcesFromLive(session?.liveUnits ?? EMPTY_LIVE, session?.tools ?? EMPTY_TOOLS))
  })
  return useMemo(() => goalCompletionsByTurn([...savedSources, ...JSON.parse(liveSignature) as GoalCompletionSource[]]), [savedSources, liveSignature])
}

// Preserve chronological turn segments before flattening for legacy consumers.
export function foldTurnGroups(
  units: Unit[],
  inProgress: InProgressTurn | null,
  turnStatuses: Record<string, string>,
  turnCollapseOverrides: Record<string, boolean>,
  turnErrors: Record<string, string> = {},
  turnDurations: Record<string, number> = {},
  turnCancelledTools: Record<string, string[]> = {},
  livePlanReviewIds: ReadonlySet<string> = new Set(),
  turnErrorKinds: Record<string, string> = {},
  worktreeInit: 'completed' | 'failed' | null = null,
  artifactAnchors?: ReadonlyMap<string, TurnArtifactAnchor>,
  turnErrorDetails: Record<string, ProviderErrorDetails> = {},
  turnStartedAtMs: Record<string, number> = {},
  shellTurnIds: ReadonlySet<string> = new Set(),
  turnWorkCompletedAtMs: Record<string, number> = {},
  goalCompletionByTurn: ReadonlyMap<string, GoalCompletionSummary> = transcriptGoalCompletions(units),
  friendReplyBoundaryTurnIds: ReadonlySet<string> = new Set(),
): { key: string; turnId?: string; nodes: RenderNode[] }[] {
  const renderedGroups: { key: string; turnId?: string; nodes: RenderNode[] }[] = []
  const recordedWorkflowIds = new Set(units.flatMap(unit => unit.type === 'goal-completion' && unit.segment?.goal ? [`goal:${unit.segment.goal.goalId}`] : []))
  // Completion snapshots carry accounting for an answer footer, not message rows.
  units = units.filter(unit => unit.type !== 'goal-completion')
  units = reanchorAgentEventTurns(units)
  // 按 turnId 分组；user 轮界始终切新组。缺 turnId 的旧数据（转录扫描兜底/
  // 导入）若只按 turnId 分，undefined === undefined 会让整段历史变成一轮：
  // 折叠条吞掉上一轮的 assistant 正文、漂到上一个 user 气泡后面。
  let groups: { turnId: string | undefined; units: Unit[] }[] = []
  let currentGroup: { turnId: string | undefined; units: Unit[] } = { turnId: undefined, units: [] }
  for (const unit of units) {
    const userBoundary = unit.type === 'user' && currentGroup.units.length > 0
      && (!unit.turnId || unit.turnId !== currentGroup.turnId)
    if (userBoundary || (unit.turnId && currentGroup.turnId && unit.turnId !== currentGroup.turnId && currentGroup.units.length > 0)) {
      groups.push(currentGroup)
      currentGroup = { turnId: unit.turnId, units: [] }
    }
    currentGroup.turnId = unit.turnId || currentGroup.turnId
    currentGroup.units.push(unit)
  }
  if (currentGroup.units.length > 0) groups.push(currentGroup)

  // A receipt that names a turn this transcript does not hold (a per-agent
  // pseudo turn from before durable attribution, or a turn removed by
  // rollback) has no owner to settle into. Drop its row instead of letting it
  // form a tail group that reads as a turn of its own forever.
  const ownedTurnIds = new Set(units.filter(unit => unit.type !== 'agent-event' && unit.turnId).map(unit => unit.turnId as string))
  // A receipt naming a turn with no other rows anywhere in the transcript is
  // an owner-less tail group: drop it, but only when the transcript has real
  // turns to compare against — a history that is nothing but lifecycle rows
  // still shows them.
  const hasRealTurn = groups.some(group => group.units.some(unit => unit.type !== 'agent-event'))
  if (hasRealTurn) {
    groups = groups.filter(group => !(group.turnId
      && group.units.every(unit => unit.type === 'agent-event')
      && !ownedTurnIds.has(group.turnId)))
  }

  // Saved child notifications may arrive after a different parent turn has
  // started. Receipts in a later segment still belong to the original process,
  // including when ordinary resumed commentary shares that segment. Relocate
  // only the receipts; ordinary text/tools retain their chronological identity.
  const processByTurn = new Map<string, { group: typeof groups[number]; hasFinal: boolean }>()
  for (const group of groups) {
    if (!group.turnId) continue
    const process = processByTurn.get(group.turnId)
    const tail = [...group.units].reverse().find(unit => unit.type !== 'agent-event')
    const hasFinal = group.units.some(unit => unit.type === 'text' && unit.isFinalReply && unit.segment?.text?.trim())
      || tail?.type === 'text' && !tail.segment?.phase && !!tail.segment?.text?.trim()
    if (process && !hasFinal && (process.hasFinal || group.units.every(unit => unit.type === 'agent-event'))) {
      process.group.units.push(...group.units.filter(unit => unit.type === 'agent-event'))
      group.units = group.units.filter(unit => unit.type !== 'agent-event')
    }
    if (group.units.length && (!process || hasFinal || !process.hasFinal)) processByTurn.set(group.turnId, { group, hasFinal })
  }
  groups = placeFriendReplies(groups.filter(group => group.units.length > 0), friendReplyBoundaryTurnIds)

  // A continuation can fail before producing a message. Its recorded terminal
  // diagnostics still need a group when the live error hands over to history.
  const representedTurns = new Set(groups.map(group => group.turnId))
  const firstVisibleStart = groups.map(group => group.turnId ? turnStartedAtMs[group.turnId] : undefined)
    .find(start => typeof start === 'number' && Number.isFinite(start) && start > 0)
  const emptyFailures = Object.entries(turnStatuses).filter(([turnId, status]) => {
    const start = turnStartedAtMs[turnId]
    return status === 'failed' && !representedTurns.has(turnId)
      && Number.isFinite(start) && start > 0
      && (firstVisibleStart === undefined || start >= firstVisibleStart)
      && !!(turnErrors[turnId]?.trim() || turnErrorDetails[turnId]?.message?.trim())
  }).sort(([left], [right]) => turnStartedAtMs[left] - turnStartedAtMs[right])
  for (const [turnId] of emptyFailures) {
    const next = groups.findIndex(group => group.turnId && turnStartedAtMs[group.turnId] > turnStartedAtMs[turnId])
    groups.splice(next < 0 ? groups.length : next, 0, { turnId, units: [] })
  }

  // A paged first paint can spend its item budget before reaching the oldest
  // turns of its window: those turns arrive as shells (identity plus lifecycle
  // metadata, no messages yet). They still own a fold capsule, placed by start
  // time like the empty failure groups, so the transcript shows where the
  // loaded window ends instead of silently stopping.
  for (const turnId of [...shellTurnIds]
    .filter(id => !groups.some(group => group.turnId === id))
    .sort((left, right) => (turnStartedAtMs[left] ?? 0) - (turnStartedAtMs[right] ?? 0))) {
    const next = groups.findIndex(group => group.turnId && (turnStartedAtMs[group.turnId] ?? 0) > (turnStartedAtMs[turnId] ?? 0))
    groups.splice(next < 0 ? groups.length : next, 0, { turnId, units: [] })
  }

  // Replayed turns can resume after another turn's messages. Keep that chronology,
  // but give each segment a distinct identity and the turn's artifacts one owner.
  // Duplicate React keys can leave detached cards behind when switching chats.
  const turnOwners = new Map<string, { first: number; last: number; final?: number }>()
  groups.forEach((group, index) => {
    if (!group.turnId) return
    const owner = turnOwners.get(group.turnId) ?? { first: index, last: index }
    owner.last = index
    if (group.units.some(unit => unit.type === 'text' && unit.isFinalReply && unit.segment?.text?.trim())) owner.final = index
    turnOwners.set(group.turnId, owner)
  })

  groups.forEach((group, gi) => {
    const nodes: RenderNode[] = []
    const isLast = gi === groups.length - 1
    const turnId = group.turnId
    // 回合内工具结果带的媒体路径，供同回合去重（让位判定在 lastText 之后）。
    const mediaPaths = new Set<string>()
    for (const u of group.units) {
      if (u.type !== 'tools') continue
      for (const tool of u.segment?.tools || []) {
        for (const item of tool.output?.media || []) {
          if (item?.path) mediaPaths.add(String(item.path))
        }
      }
    }
    const owner = turnId ? turnOwners.get(turnId) : undefined
    const turnKey = turnId
      ? owner?.first === gi ? turnId : `${turnId}:segment:${group.units[0].key}`
      : `legacy-${group.units[0].key}`
    const artifactAnchor = turnId ? artifactAnchors?.get(turnId) : undefined
    const ownsArtifacts = group.units.length > 0 && (artifactAnchors
      ? group.units.some(unit => unit.key === artifactAnchor?.ownerKey)
      : owner != null && (owner.final ?? owner.last) === gi)
    const turnStatus = turnId ? (turnStatuses[turnId] || '') : ''
    // 失败轮次的历史标记：live 错误卡只在会话存活期存在，turnErrors 是引擎
    // turn_lifecycle 落盘的失败原因；补在组尾，折叠与否都要可见。
    const failUnit: Unit | null = turnStatus === 'failed' && turnId
      ? { type: 'fail-hint', key: `fail-${turnKey}`, turnId, msg: { text: turnErrors[turnId] || '', kind: turnErrorKinds[turnId] || '', errorDetails: turnErrorDetails[turnId] } }
      : null
    const isTurnCancelled = turnStatus === 'interrupted'
    // A tool call this Turn's abort killed did not fail on its own merits. The
    // engine has to report both as errors so the model can act on them, so the
    // Turn's own cancelled-call list is the only thing that separates them.
    const cancelledTools = turnId ? turnCancelledTools[turnId] : undefined
    if (cancelledTools && cancelledTools.length > 0) {
      const cancelled = new Set(cancelledTools)
      for (const unit of group.units) {
        if (unit.type !== 'tools') continue
        for (const tool of unit.segment?.tools || []) {
          if (tool.state === 'error' && cancelled.has(tool.toolCallId)) tool.state = 'interrupted'
        }
      }
    }
    // Interrupted Turns remain expanded so their partial response and tool
    // activity stay inspectable. Their terminal label belongs to this group.
    const interruptedUnit: Unit | null = turnStatus === 'interrupted'
      ? { type: 'turn-status', key: `interrupted-${turnKey}`, turnId, msg: { durationMs: turnId ? turnDurations[turnId] : 0 } }
      : null
    // 过程不该被「已处理 N 个操作」收起来。
    // The turn's own recorded terminal state outranks the session-level running
    // flag. The flag is session-scoped derived state with several async writers
    // (a recovered question card, the host working-registry reconcile), so a
    // turn the engine already settled as completed or failed can be named
    // "active" for the frames between two writers disagreeing. The fold guard
    // must therefore read the turn's own terminal record, exactly like the
    // history restore path (`restoredTurnId`) already does: a settled turn is
    // never in progress, whatever the session flag says.
    // 过程不该被「已处理 N 个操作」收起来。
    // The turn's own recorded terminal state outranks the session-level running
    // flag. The flag is session-scoped derived state with several async writers
    // (a recovered question card, the host working-registry reconcile), so a
    // turn the engine already settled as completed or failed can be named
    // "active" for the frames between two writers disagreeing. The fold guard
    // must therefore read the turn's own terminal record, exactly like the
    // history restore path (`restoredTurnId`) already does: a settled turn is
    // never in progress, whatever the session flag says.
    const isTurnInProgress = inProgress != null
      && !['completed', 'failed'].includes(turnStatus)
      && (inProgress === 'tail' ? isLast : inProgress.turnId === turnId)
    // A running conversation can be opened from history before its tool result
    // arrives. Missing results in an old completed transcript are not live work.
    for (const unit of group.units) {
      for (const tool of unit.segment?.tools || []) {
        if (tool.pendingResult) tool.state = isTurnCancelled ? 'interrupted' : isTurnInProgress ? 'running' : 'done'
      }
    }
    // New history names the final assistant message explicitly. The positional
    // fallback keeps imported/legacy transcripts readable when that metadata is
    // absent, but must never override an explicit final reply followed by tools.
    const finalUnit = [...group.units].reverse().find(unit => unit.type !== 'agent-event' && !unit.friendReplyInProcess)
    const explicitFinal = [...group.units].reverse().find(unit => unit.type === 'text' && unit.isFinalReply && unit.segment?.text?.trim()) || null
    const lastText: Unit | null = explicitFinal || (!isTurnInProgress && finalUnit?.type === 'text' && finalUnit.segment?.text?.trim() && !finalUnit.segment?.phase ? finalUnit : null)
    if (lastText) {
      lastText.hasActions = true
      lastText.goalCompletion = !isTurnInProgress && !isTurnCancelled && turnStatus !== 'failed' && (!turnId || ownsArtifacts)
        ? turnId ? goalCompletionByTurn.get(turnId) : goalSourcesFromHistory(group.units).at(-1)?.completion
        : undefined
    }

    // 同回合一张图只出一遍，以最终回复为权威面。
    //
    // 出图面从工具卡搬到了回合末尾的恒可见区块（见 turnMediaNode）：工具卡在
    // 回合折叠里，图挂在它下面就等于「生成成功但用户看不到」——只有展开折叠历史
    // 才看得见。区块在折叠之外，和最终回复一样恒可见。
    //
    // 最终回复自己嵌的图仍然以它为准：区块让位，不出同路径的第二遍；中间正文按
    // 工具产物路径剥，展开折叠也不出第二遍。
    //
    // 解析顺序是承重的一半：模型常把生图结果里的裸文件名贴进最终回复
    // （`![](image-178….png)`），相对路径在渲染管线里无从解析，只出 alt 文本。
    // 先按本回合工具产出的路径把它改写成绝对路径，去重判定才认得出「这张图最终
    // 回复已经嵌了」，否则同一张图会出两遍。
    const mediaAliases = collectImageSourceAliases(group.units.flatMap(unit => (unit.segment?.tools || []).flatMap(tool => tool.output?.media || [])))
    const resolvedFinal = lastText && mediaPaths.size > 0
      ? resolveRelativeImagePaths(lastText.segment?.text || '', mediaPaths, mediaAliases)
      : ''
    if (lastText && resolvedFinal && resolvedFinal !== lastText.segment?.text) lastText.resolvedText = resolvedFinal
    const finalSource = resolvedFinal || lastText?.segment?.text || ''
    // Turn-end resources belong to the segment that owns the turn's final reply,
    // and only once the turn has settled.
    if (lastText) lastText.endResourceTurn = turnId && ownsArtifacts && !isTurnInProgress && ['completed', 'failed'].includes(turnStatus)
      ? { turnId, status: turnStatus } : null
    const finalPaths = lastText ? collectMarkdownImagePaths(finalSource) : null
    // 回合末尾只放「真的在向用户汇报」的产物，规则是：
    //   - 最终回复把图嵌进正文（![](path)）→ 正文里出，末尾不再重复；
    //   - 最终回复提到了它（全路径或文件名）→ 回合末尾出；
    //   - 显式生成工具（generate_image / generate_video）的产出 → 调用它就是要一张
    //     图，即使回复没点名也出；
    //   - 其余一律是过程产物（自检截图、读回来的图、源码性写入的页面），留在折叠内
    //     的工具卡里，一次展开就能看见。上一版把本回合所有图和所有写入的 HTML 都堆
    //     到末尾，于是改源码的 index.html 也被当成交付物汇报，正是这个规则要修掉的。
    const explicitMedia = new Set<string>()
    for (const u of group.units) {
      if (u.type !== 'tools') continue
      for (const tool of u.segment?.tools || []) {
        if (!isExplicitMediaGenerationTool(tool.toolName)) continue
        for (const item of tool.output?.media || []) if (item?.path) explicitMedia.add(String(item.path))
      }
    }
    const reported = lastText ? collectReportedPaths(finalSource, mediaPaths, mediaAliases) : new Set<string>()
    const turnMedia = isTurnInProgress
      ? []
      : [...mediaPaths].filter(path => (explicitMedia.has(path) || reported.has(path)) && !finalPaths?.has(path))
    // 已经在别处呈现的图（正文内嵌、或回合末尾区块）不在工具卡里再出一遍；没被汇报
    // 的图回到卡片——那是它唯一的呈现面。
    const suppressFigures = new Set<string>([...(finalPaths ?? []), ...turnMedia])
    for (const u of group.units) {
      if (u.type === 'tools' && suppressFigures.size > 0) u.suppressFigurePaths = suppressFigures
      else if (u.type === 'text' && u !== lastText && mediaPaths.size > 0) u.suppressImagePaths = mediaPaths
    }
    const mediaNode: RenderNode | null = turnMedia.length
      ? { kind: 'turn-media', key: `turn-media-${turnKey}`, paths: turnMedia }
      : null

    // 本回合改了哪些文件，跟在整组最后。在途回合不出：那时归 composer 胶囊报，
    // 同一批改动同时有两个在跑的读数就会各说一套。
    const visualArtifacts = visualArtifactsFromUnits(group.units)
    const diagramsNode: RenderNode | null = visualArtifacts.length
      ? { kind: 'turn-visuals', key: `turn-visuals-${turnKey}`, artifacts: visualArtifacts }
      : null
    const changesNode: RenderNode | null = turnId && ownsArtifacts && !isTurnInProgress
      ? {
          kind: 'turn-changes',
          key: `turn-changes-${turnId}`,
          turnId,
          status: turnStatus,
          finalText: finalSource,
        }
      : null

    const leading: Unit[] = []
    const processUnits: Unit[] = []
    const post: Unit[] = []
    let pastFinal = false
    for (const original of group.units) {
      if (original === lastText) { pastFinal = true; continue }
      if (original.friendReplyInProcess) { processUnits.push(original); continue }
      const unit = original.type === 'user' && isAnswerToTurn(original.msg, turnId)
        ? { ...original, hasFollowingFinalAnswer: !!lastText && !pastFinal } : original
      // The initial owner input leads its turn even if its live acknowledgement
      // reached the transcript after the first work or final reply.
      if (unit.type === 'user' && unit.msg?.localRender?.delegationKind === 'initial-input') {
        leading.push(unit)
        continue
      }
      // Lifecycle notices belong to the turn's activity region even when the
      // child settled after the final answer: inline subagent rows stay inside
      // the activity area, ahead of the turn diff.
      if (pastFinal && unit.type !== 'agent-event') { post.push(unit); continue }
      if (processUnits.length === 0 && (unit.type === 'user' && !isAnswerToTurn(unit.msg, turnId) || unit.type === 'compaction' || unit.type === 'delegation')) leading.push(unit)
      else processUnits.push(unit)
    }
    // A delegation is a MESSAGE, not process evidence — whether it arrived as its
    // own idle row (an envelope-only user message) or was drained mid-turn into a
    // tool result (unit carries the parsed payload): a steered message is a
    // first-class user bubble regardless of what else the
    // turn was doing, and a bubble buried inside the turn fold reads as "nothing
    // arrived". It is therefore a PERSISTENT section of the fold: visible while
    // every activity section around it collapses, and — unlike the old lift ahead
    // of the fold — kept at its ARRIVAL position, so a mid-turn delivery reads as
    // [work before it] [bubble] [work after it] instead of floating above the
    // activity it interrupted. A delegation that OPENS the group (the delivered
    // message started this turn, so it is the turn's first unit) still leads the
    // turn via `leading`, exactly like the user bubble it stands in for.
    // Friend sends stay inside the process region at their arrival position.
    // Lifting them out put settled cards below commentary that followed them
    // and left them unfolded after the turn settled.
    const foldedUnits = processUnits
    const entries = activityEntries(foldedUnits, turnKey, isTurnCancelled, recordedWorkflowIds, livePlanReviewIds)
    const projected = groupTurnActivities(entries, turnId, turnKey, isTurnInProgress, turnCollapseOverrides, lastText !== null)
    const persistent = projected.filter(isPersistentTurnNode)
    const turnNodes = projected.filter(node => !persistent.includes(node))
    const foldKey = `turn:${turnKey}`
    const startedAtMs = workTimestamp(turnId ? turnStartedAtMs[turnId] : null)
      ?? group.units.map(unit => workTimestamp(unit.type === 'user' ? unit.msg?.timestamp : unit.ts)).find(value => value != null)
      ?? null
    const completedAtMs = workTimestamp(turnId ? turnWorkCompletedAtMs[turnId] : null)
      ?? (lastText ? workTimestamp(lastText.ts) : null)
    const collapse = turnCollapseState({
      hasFinal: lastText != null, interrupted: isTurnCancelled, hasActivity: turnNodes.length > 0,
      hasRunningTools: isTurnInProgress && entries.some(entry => entry.action?.running),
      allowCollapseBeforeFinal: isTurnInProgress
        || ['completed', 'failed', 'interrupted'].includes(turnStatus) && leading.some(unit => unit.type === 'user'),
      preventAutoCollapse: isTurnInProgress || !isTurnCancelled && (hasUnsettledAgents(entries.map(entry => entry.value), turnId) || unsettledAgentEventRows(processUnits))
        || turnCollapseOverrides[`mcp-expanded:${turnKey}`] === true,
      collapsed: turnCollapseOverrides[foldKey],
    })
    nodes.push(...leading.map(unit => ({ kind: 'unit' as const, unit })))
    // 工作树初始化行跟在本回合首个用户气泡之后（worktree-init 语义）：
    // 它修饰的是“发起这条消息的运行环境”，放在消息上方会把回合开头从用户
    // 的原话换成系统状态。只挂在有用户气泡的组；第一组没有用户节点（历史被
    // 压缩等）时不补，避免行漂离它修饰的消息。
    if (worktreeInit && gi === 0 && leading.some(unit => unit.type === 'user')) {
      nodes.push({ kind: 'worktree-init', key: 'worktree-init-row', status: worktreeInit })
    }
    if (collapse.allowed) {
      nodes.push({
        kind: 'turn-fold', key: foldKey, foldKey, turnId,
        open: collapse.open, items: projected,
        messageCount: entries.filter(entry => entry.grouping !== 'reasoning'
          && !isPersistentTurnNode(entry.value)).length,
        durationMs: turnId ? turnDurations[turnId] : undefined,
        startedAtMs, completedAtMs, running: isTurnInProgress,
      })
    } else nodes.push(...projected)
    // Before the first work item, keep the same time label ready below the user.
    // Once process content exists its disclosure owns the label instead.
    if (isTurnInProgress && !isTurnCancelled && !collapse.allowed) {
      const firstWork = nodes.findIndex(node => node.kind !== 'worktree-init'
        && !(node.kind === 'unit' && ['user', 'delegation'].includes(node.unit.type)))
      nodes.splice(firstWork < 0 ? nodes.length : firstWork, 0, {
        kind: 'work-divider', key: `work-divider:${turnKey}`, startedAtMs, completedAtMs,
      })
    }
    if (lastText) nodes.push({ kind: 'unit', unit: lastText })
    nodes.push(...groupTurnActivities(activityEntries(post, turnKey, isTurnCancelled, recordedWorkflowIds, livePlanReviewIds), turnId, turnKey, isTurnInProgress, turnCollapseOverrides))
    if (failUnit) nodes.push({ kind: 'unit', unit: failUnit })
    if (interruptedUnit) nodes.push({ kind: 'unit', unit: interruptedUnit })
    // 「本回合产出了什么」连排：图 → 页面 → 图表 → 改动的文件。都在折叠之外。
    if (mediaNode) nodes.push(mediaNode)
    if (diagramsNode) nodes.push(diagramsNode)
    if (changesNode) nodes.push(changesNode)
    renderedGroups.push({ key: turnKey, turnId, nodes })
  })
  return renderedGroups
}

// 单元渲染的宿主上下文（UnitView / TurnFold / live 层共用同一份）。
type UnitProps = {
  questionComposer?: HTMLElement | null
  questionSource?: HTMLElement
  isThinkingExpanded: (key: string) => boolean
  onToggleThinking: (key: string) => void
  archived: boolean
  running: boolean
  // 本面的 user 回合是不是人在输入框里发的（粘贴 chip 复原开关，见
  // buildUserBubbleHtml）。
  composerAuthored: boolean
  readOnly?: boolean
  sessionId?: string
  streamSessionId?: string
  /**
   * Request ids that have both a parked request row and a later task-delivery
   * row in the same conversation. The request row is hidden once the task row
   * arrives so the same arrival is not rendered twice.
   */
  supersededFriendRequestIds?: ReadonlySet<string>
  /**
   * The message an edit may target, or null when nothing in this transcript is editable.
   *
   * An edit truncates the conversation from its target onward and re-runs it, so only the
   * newest user message can be one: editing an older message would discard everything the
   * user has since written, which is why the app refuses it with "Only the most recent message
   * can be edited." Computed once here rather than per row, because a row cannot tell from
   * itself whether a newer user message follows it — that is a property of the whole list.
   *
   * Spanning BOTH layers is what makes a stopped turn editable. A turn the user stopped
   * deliberately keeps its partial output in the live layer and never reloads history, so
   * the bubble on screen is the renderer's own optimistic one — and the history layer's
   * newest message is still the PREVIOUS one. Reading only the history layer therefore
   * offered Edit on the wrong message after every stop.
   *
   * The target is a turn id rather than a uuid exactly in that case: the engine assigns the
   * message uuid and no event carries it back, so the optimistic bubble has none. The host
   * resolves the turn through the engine's own history.
   */
  editTarget: EditTargetRef | null
}

// Elapsed-time wording for a Turn's terminal status row. It floors to whole
// seconds (so 900ms reads as zero seconds, never a rounded-up
// "1s"), drops zero-valued units above one minute, and renders each unit with
// the locale's narrow form. See stop-interaction-vectors.json
// (status-label-duration-format) for the captured rule and its samples.
function durationUnit(value: number, unit: 'second' | 'minute' | 'hour' | 'day'): string {
  try {
    return new Intl.NumberFormat(intlLocale(), { style: 'unit', unit, unitDisplay: 'narrow' }).format(value)
  } catch {
    const suffix = unit === 'second' ? 's' : unit === 'minute' ? 'm' : unit === 'hour' ? 'h' : 'd'
    return `${value}${suffix}`
  }
}

export function terminalDurationLabel(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null
  const total = Math.floor(durationMs / 1000)
  if (total < 1) return durationUnit(0, 'second')
  if (total < 60) return durationUnit(total, 'second')
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total / 3600) % 24
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days > 0 || hours > 0) {
    const parts: string[] = []
    if (days > 0) parts.push(durationUnit(days, 'day'))
    if (hours > 0) parts.push(durationUnit(hours, 'hour'))
    if (minutes > 0) parts.push(durationUnit(minutes, 'minute'))
    if (seconds > 0) parts.push(durationUnit(seconds, 'second'))
    return parts.join(' ')
  }
  return seconds === 0
    ? durationUnit(minutes, 'minute')
    : `${durationUnit(minutes, 'minute')} ${durationUnit(seconds, 'second')}`
}

// The Turn's terminal status: a quiet, left-aligned divider that belongs to the
// Turn it ended, followed by a hairline rule. Not a centered pill, not an icon
// badge, and not a separate transcript entry.
export function TurnTerminalStatus({ startedAt = 0, finishedAt = 0, durationMs }: { startedAt?: number; finishedAt?: number; durationMs?: number }) {
  const t = useT()
  const elapsed = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && startedAt > 0 && finishedAt >= startedAt
        ? finishedAt - startedAt
        : -1)
  const duration = terminalDurationLabel(elapsed)
  const label = duration
    ? (t('turn_interrupted') || 'You stopped after {duration}').replace('{duration}', duration)
    : (t('chat_aborted') || 'Stopped')
  return (
    <div className={styles['turn-terminal-status']}>
      <span className={styles['turn-terminal-label']} role="status">{label}</span>
      <span className={styles['turn-terminal-rule']} aria-hidden="true" />
    </div>
  )
}

// The work label is shared by the initial placeholder and the process disclosure.
// Final-answer text freezes its clock while the process can remain expanded.
export const WORK_DIVIDER_TIME_THRESHOLD_MS = 1000
export const WORK_DIVIDER_TICK_MS = 1000

function workTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

type ClientWorkTimes = {
  turnWorkStartedAtMs?: Record<string, number>
  turnWorkCompletedAtMs?: Record<string, number>
}
const EMPTY_WORK_TIMES: Record<string, number> = {}

function useTurnWorkTimes(sessionId: string) {
  const recorded = useChatStream(state => selectSessionStream(state, sessionId).turnStartedAtMs)
  const local = useChatStream(state => (selectSessionStream(state, sessionId) as ReturnType<typeof selectSessionStream> & ClientWorkTimes).turnWorkStartedAtMs ?? EMPTY_WORK_TIMES)
  const completedAtMs = useChatStream(state => (selectSessionStream(state, sessionId) as ReturnType<typeof selectSessionStream> & ClientWorkTimes).turnWorkCompletedAtMs ?? EMPTY_WORK_TIMES)
  const startedAtMs = useMemo(() => ({ ...recorded, ...local }), [recorded, local])
  return { startedAtMs, completedAtMs }
}

export function TurnWorkLabel({ startedAtMs, completedAtMs = null, durationMs, fallback }: {
  startedAtMs: number | null
  completedAtMs?: number | null
  durationMs?: number
  fallback?: ReactNode
}) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAtMs == null || completedAtMs != null || durationMs != null) return
    const timer = setInterval(() => setNow(Date.now()), WORK_DIVIDER_TICK_MS)
    return () => clearInterval(timer)
  }, [startedAtMs, completedAtMs, durationMs])
  let label: ReactNode
  const elapsed = startedAtMs != null && completedAtMs != null
    ? Math.max(completedAtMs - startedAtMs, 0)
    : durationMs != null ? Math.max(durationMs, 0)
    : startedAtMs != null ? Math.max(now - startedAtMs, 0) : null
  if (elapsed == null) {
    if (fallback != null) return <>{fallback}</>
    label = <>
      <span className={styles['turn-work-loading']} aria-hidden="true" />
      <span className={styles['turn-work-loading-text']}>{t('activity_loading_status')}</span>
    </>
  } else {
    const completed = completedAtMs != null || durationMs != null
    label = completed
      ? t('activity_worked_for').replace('{duration}', terminalDurationLabel(elapsed) ?? '')
      : elapsed < WORK_DIVIDER_TIME_THRESHOLD_MS
      ? (t('activity_working') || 'Working')
      : (t('activity_working_for') || 'Working for {duration}').replace('{duration}', terminalDurationLabel(elapsed) ?? '')
  }
  return <span data-work-label={elapsed == null ? 'loading' : completedAtMs != null || durationMs != null ? 'completed' : 'working'}>{label}</span>
}

export function TurnWorkDivider({ startedAtMs, completedAtMs = null }: { startedAtMs: number | null; completedAtMs?: number | null }) {
  return (
    <div className={styles['turn-terminal-status']} data-work-divider={startedAtMs == null ? 'loading' : 'working'}>
      <span className={styles['turn-terminal-label']}><TurnWorkLabel startedAtMs={startedAtMs} completedAtMs={completedAtMs} /></span>
      <span className={styles['turn-terminal-rule']} aria-hidden="true" />
    </div>
  )
}

export function CompactionEvent({ loading, trigger, restoredText }: {
  loading: boolean; trigger?: string; restoredText?: string
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const label = t(loading ? 'compaction_in_progress' : trigger === 'auto' ? 'compaction_completed_auto' : 'compaction_completed')
  const contents = <><Icon name="compaction" size={16} /><span className={styles['compaction-label']}>{label}</span></>
  return <div className={`msg-group system ${styles['compaction-row']}`} data-state={loading ? 'running' : 'completed'}>
    {loading ? <div className={`${styles['compaction-pill']} is-loading`} role="status" aria-live="polite">{contents}</div>
      : restoredText ? <button type="button" className={`${styles['compaction-pill']} is-clickable`} onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded} aria-label={`${label} · ${t('compaction_restored_files')}`}>
          {contents}<Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
        </button> : <div className={styles['compaction-pill']}>{contents}</div>}
    {expanded && restoredText ? <div className={styles['compaction-restored']}>
      <span>{t('compaction_restored_files')}</span>
      <pre>{restoredText}</pre>
    </div> : null}
  </div>
}

/**
 * The persistent worktree-init row.
 *
 * Worktree creation happens in the host before the first Turn, so the engine
 * never persists a record for it. The live status rides the stream store's
 * `worktreeInit` field; after a reload the render layer derives the settled
 * row from the session workdir. The item renders INSIDE the turn
 * activity, below the first user message — the row names what backs this
 * conversation, so it follows the message that started it. Never a toast,
 * never above the user bubble, never inside a turn fold.
 */
export function WorktreeInitEvent({ status }: { status: 'running' | 'completed' | 'failed' }) {
  const t = useT()
  const label = t(status === 'running' ? 'worktree_init_running'
    : status === 'failed' ? 'worktree_init_failed' : 'worktree_init_completed')
  const contents = <>
    {status === 'running' ? <span className={styles['compaction-spinner']} aria-hidden="true" />
      : <Icon name="run-mode-worktree" size={16} />}
    <span className={styles['compaction-label']}>{label}</span>
  </>
  return <div className={`msg-group system ${styles['compaction-row']} ${styles['worktree-init-row']}`}
    data-state={status} data-worktree-init={status}>
    <div className={`${styles['compaction-pill']}${status === 'running' ? ' is-loading' : ''}`}
      role={status === 'running' ? 'status' : undefined} aria-live={status === 'running' ? 'polite' : undefined}>
      {contents}
    </div>
  </div>
}

function AgentNameList({ names, buttons, overflow }: { names: string[]; buttons: ReactNode[]; overflow?: string }) {
  const t = useT()
  const labels = overflow ? [...names, overflow] : names
  const destinations = overflow ? [...buttons, overflow] : buttons
  return <span className={styles['subagent-activity-names']}>{labels.map((_label, index) => <Fragment key={index}>
    {index > 0 ? <span className={styles['subagent-activity-separator']}>{t(index === labels.length - 1 ? 'subagent_name_and' : 'subagent_name_separator')}</span> : null}
    <span>{destinations[index]}</span>
  </Fragment>)}</span>
}

const AgentEntranceContext = createContext<{
  seen: ReadonlySet<string>; readOnly: boolean; finish: (key: string) => void
} | null>(null)

function agentEntranceKeys(units: (Unit | LiveUnit)[]): string[] {
  const tasks = Object.fromEntries(w().KlausSubagentPanel?.listTasks?.() || []) as Record<string, AgentTask>
  return units.flatMap(unit => {
    const events = unit.type === 'live-agent-event' ? unit.agentEvents || [unit]
      : unit.type === 'agent-event' && unit.agentEvent ? unit.agentEvents || [unit.agentEvent] : []
    const tools = unit.type === 'tools' ? unit.segment?.tools || [] : []
    const fallback = resolveSubagentActivities(tools.filter(tool => tool.activityKind === 'spawn'))
    const liveFallback = unit.type === 'live-tools' ? unit.order.flatMap(taskId => {
      const task = w().KlausSubagentPanel?.getTask?.(taskId) as AgentTask | undefined
      return task ? [`${unit.turnId || 'live'}:${subagentConversationId(taskId, task)}`] : []
    }) : []
    return [...events.map(event => {
      const resolved = resolveAgentActivityTask(event, tasks)
      return `${unit.turnId || 'live'}:${resolved.agentId || resolved.taskId}`
    }),
      ...fallback.map(row => `${unit.turnId || 'live'}:${row.conversationId}`), ...liveFallback]
  })
}

function AgentEntranceProvider({ units, readOnly = false, children }: {
  units: (Unit | LiveUnit)[]; readOnly?: boolean; children: ReactNode
}) {
  // Replayed identities are already seen. Newly added identities animate once
  // per owning turn, including when their row later moves into its disclosure.
  const [seen, setSeen] = useState(() => new Set(agentEntranceKeys(units)))
  const value = useMemo(() => ({ seen, readOnly, finish: (key: string) => setSeen(previous => {
    if (previous.has(key)) return previous
    return new Set([...previous, key])
  }) }), [seen, readOnly])
  return <AgentEntranceContext.Provider value={value}>{children}</AgentEntranceContext.Provider>
}

function SubagentInlineAvatar({ avatarId, conversationId, name, status, interactive, onOpen, turnId }: {
  avatarId?: number; conversationId: string; name: string; status: string
  interactive: boolean; onOpen: () => void; turnId?: string
}) {
  const entrance = useContext(AgentEntranceContext)
  const key = `${turnId || 'live'}:${conversationId}`
  const animate = entrance != null && !entrance.seen.has(key)
  const animation = { 'data-animate-entrance': animate ? '' : undefined,
    onAnimationEnd: animate ? () => entrance?.finish(key) : undefined }
  const avatar = <RawHtml tag="span" html={subagentAvatarHtml(avatarId, 16, status, conversationId)} />
  return interactive
    ? <button type="button" className={styles['subagent-activity-avatar']} onClick={onOpen} {...animation}
        data-agent-conversation-id={conversationId} aria-label={name}
        data-klaus-tip={entrance && !entrance.readOnly ? name : undefined}>{avatar}</button>
    : <span {...animation}>{avatar}</span>
}

export function AgentLifecycleRow({ event, events = [event], turnId, laterAgentIds = [] }: {
  event: AgentLifecycleEvent; events?: AgentLifecycleEvent[]; turnId?: string; laterAgentIds?: string[]
}) {
  useSyncExternalStore(subscribeSubagents, subagentsVersion, () => 0)
  const t = useT()
  const panel = w().KlausSubagentPanel
  const registeredTasks = Object.fromEntries(panel?.listTasks?.() || []) as Record<string, AgentTask>
  const rows = uniqueAgentLifecycleEvents(events.map(item => resolveAgentActivityTask(item, registeredTasks))).map(item => {
    const linked = item.agentId ? panel?.getTaskByConversationId?.(item.agentId) : null
    const task = (linked?.task || panel?.getTask?.(item.taskId) || registeredTasks[item.taskId]) as AgentTask | null
    const taskId = linked?.taskId || item.taskId
    const conversationId = item.agentId || (task ? subagentConversationId(item.taskId, task) : item.taskId)
    const historicalTitle = [taskId, item.agentId, task?.agentName, task?.agentType].includes(item.name) ? '' : item.name
    const name = subagentDisplayName(taskId, { description: task?.description || historicalTitle })
    // Earlier groups keep their historical wording. The final group for a
    // child reflects an already completed run in this owning parent turn,
    // even when its last saved notice only recorded that it had started.
    const completed = !!task && task.spawnTurnId === turnId && !!turnId
      && !laterAgentIds.includes(item.agentId || item.taskId)
      && (subagentDisplayStatus(task) === 'completed' || task.status === 'budget_limited')
    const eventStatus = completed ? 'completed' : item.status
    const status = eventStatus === 'cancelled' ? 'stopped'
      : eventStatus === 'started' || eventStatus === 'updated' ? 'running' : eventStatus
    return { task, taskId, conversationId, name, status, eventStatus, canOpen: !!task || item.status === 'started' }
  })
  const open = (row: typeof rows[number]) => {
    if (row.task) panel?.openByTaskId?.(row.taskId)
    else panel?.openByConversationId?.(row.conversationId)
  }
  const shown = rows.length > 3 ? rows.slice(0, 2) : rows
  // Adjacent lifecycle notices form one bounded inline group. Each child keeps
  // its latest notice in that group; intervening messages/tools start a new one.
  const eventStatus = agentEventRowStatus(rows.map(row => ({ taskId: row.taskId, name: row.name, status: row.eventStatus })))
  const status = rows.some(row => row.status === 'stopped') ? 'stopped'
    : rows.some(row => row.status === 'failed') ? 'failed'
    : rows.every(row => row.status === 'completed') ? 'completed' : 'running'
  return <div className={styles['subagent-activities']} data-agent-event={eventStatus} data-agent-task-id={rows[0].taskId} data-status={status}>
    <span className={styles['subagent-avatar-stack']}>
      {rows.slice(0, 4).map((row, index) => <SubagentInlineAvatar key={row.conversationId}
        avatarId={row.task?.avatarId} conversationId={row.conversationId} name={row.name} status={row.status}
        turnId={turnId} interactive={index >= shown.length && row.canOpen} onOpen={() => open(row)} />)}
    </span>
    <span className={styles['subagent-activity-text']}>
      <AgentNameList names={shown.map(row => row.name)} overflow={rows.length > shown.length ? t('subagent_activity_more').replace('{count}', String(rows.length - shown.length)) : undefined} buttons={shown.map(row =>
        row.canOpen ? <button key={row.conversationId} className={styles['subagent-activity-name']} type="button" onClick={() => open(row)}
          data-agent-conversation-id={row.conversationId} aria-label={`${row.name} · ${t('subagent_open_workspace')}`}>{subagentNamePreview(row.name)}</button>
          : <span key={row.conversationId}>{subagentNamePreview(row.name)}</span>)} />
      <span className={styles['subagent-activity-status']}>{t(`subagent_event_${eventStatus}${eventStatus === 'cancelled' && rows.length > 1 ? '_plural' : ''}`)}</span>
    </span>
  </div>
}

// Terminal provider failures carry the engine's raw English message; the kind
// the host projects alongside it selects a localized wording so the failure
// surface says what happened instead of only echoing the transport string.
// Network failures and bare quota codes use localized wording. Descriptive
// quota and invalid-request messages retain the provider's rejection reason
// behind the localized lead-in.
const PROVIDER_KIND_MESSAGE_KEYS: Record<string, string> = {
  network: 'provider_network',
  quota: 'provider_quota',
  max_output: 'provider_max_output',
  auth: 'provider_auth',
  timeout: 'provider_timeout',
}

export function providerErrorText(raw: string, kind: string | undefined, t: (key: string) => string, details?: ProviderErrorDetails): string {
  const kiro = knownKiroErrorText(raw, t)
  if (kiro !== undefined) return kiro
  const trae = knownTraeErrorText(raw, t)
  if (trae !== undefined) return trae
  const antigravity = knownAntigravityErrorText(raw, t)
  if (antigravity !== undefined) return antigravity
  const cursor = knownCursorErrorText(raw, t)
  if (cursor !== undefined) return cursor
  const sourceProse = knownEngineSourceProseErrorText(raw, t)
  if (sourceProse !== undefined) return sourceProse
  // Host envelope failures carry transport jargon; show the problem and the
  // remedy instead, and keep the raw envelope in host logs only.
  const friendly = friendlyErrorText(raw, t)
  if (friendly !== undefined) return friendly
  // Older saved turns may contain the terminal sentence without its auth kind.
  if ((!kind || kind === 'unknown') && raw === 'Authentication failed for the selected model provider.') return t('provider_auth')
  const fastModeCreditMessages = [raw, details?.message, details?.providerError?.message]
  if (fastModeCreditMessages.some(message => /usage credits are required for fast mode/i.test(message ?? ''))) {
    return t('provider_fast_mode_credits_required')
  }
  const code = details?.providerCode ?? details?.providerError?.code
  if (code === 'image_preprocessing_failed' || /\bimage[ _]preprocessing[ _]failed\b/i.test(raw)) {
    return t('provider_image_preprocessing_failed')
  }
  // A billing refusal does not establish that the account's credit pool is empty.
  if (kind === 'quota' && ((details?.status ?? details?.providerError?.status) === 402
    || (details?.providerCode ?? details?.providerError?.code) === '402'
    || /\b(?:payment[ _]required|HTTP[ :]+402)\b/i.test(raw))) return t('provider_payment_required')
  const quotaReason = raw.replace(/\s+\(request-id:[^)]*\)\s*$/, '').trim()
  if (kind === 'quota' && quotaReason && !/^[a-z_][a-z0-9_]*$/i.test(quotaReason)) {
    return `${t('provider_quota')} (${raw})`
  }
  const detailedKey = kind === 'request_too_large' ? 'provider_request_too_large'
    : kind === 'prompt_too_long' ? 'provider_prompt_too_long'
      : kind === 'invalid_request' ? 'provider_invalid' : undefined
  if (detailedKey) return raw ? `${t(detailedKey)} (${raw})` : t(detailedKey)
  const key = kind ? PROVIDER_KIND_MESSAGE_KEYS[kind] : undefined
  return key ? t(key) : raw
}

/**
 * One sent user message: its bubble, or the inline editor replacing it.
 *
 * Its own component rather than a branch of `UnitView` because the editor subscribes
 * to the edit store with a hook. `UnitView` renders every unit kind from one function,
 * so a hook on the `user` path would be called for some renders of that key and not
 * others — the order React requires would change whenever a unit's kind changed.
 */
export function UserMessageRow({ msg, composerAuthored, archived, running, readOnly, canEdit, turnId, sessionId, supersededFriendRequestIds }: {
  msg: any
  composerAuthored: boolean
  archived: boolean
  running: boolean
  readOnly?: boolean
  canEdit: boolean
  /** The turn this bubble started; the edit target's handle when the uuid is unknown. */
  turnId?: string
  sessionId?: string
  supersededFriendRequestIds?: ReadonlySet<string>
}) {
  const runtime = useSyncExternalStore(subscribeFriendsRuntime, friendsRuntimeSnapshot, friendsRuntimeSnapshot)
  useSyncExternalStore(subscribeFriendOutgoingActions, friendOutgoingActionsRevision, friendOutgoingActionsRevision)
  const t = useT()
  const built = buildUserBubbleHtml(msg, composerAuthored, sessionId)
  // A friend task's bubble shows the sender's prose while the model-facing text is the
  // approval envelope; copy follows what the bubble shows, and the envelope is not
  // user-authored text, so it never enters the composer as an edit draft.
  const friendDisplay = externalMessageDisplay(msg.localRender)
  const copyText = friendDisplay ?? userCopyText(msg, composerAuthored)
  const isFriend = friendDisplay !== null
  const row = useRef<HTMLDivElement>(null)
  const expansion = useRef<{ expandedText: string | null }>({ expandedText: null })
  const richCopy = useMemo(() => renderUserDocument(msg.localRender?.composerDocument, undefined, { preserveTableHeaders: true }), [msg.localRender?.composerDocument])

  // An externally delivered row is not the owner's own typing, so it reads as
  // the other party in a group chat: the sender's avatar and name sit on the
  // LEFT and the row flips to left alignment, while typed messages stay on the
  // right. Typed messages and internal delegations render no sender column.
  const sender = isFriend ? externalMessageSender(msg.localRender, msg.text) : null
  const identity = isFriend ? resolveFriendIdentity(sender) : null
  const senderColumn = identity ? renderExternalSenderAvatarHtml({
    ...msg.localRender,
    sender: { ...sender, displayName: identity.name, avatarUrl: identity.avatarUrl },
  }, msg.text) : ''
  // The owner's own rows carry their profile avatar on the RIGHT, the mirror
  // of the external sender column; externally delivered rows already show the
  // other party on the left and keep that single column.
  const ownerColumn = isFriend ? '' : renderOwnerSenderAvatarHtml()
  const editable = userBubbleEditable(isFriend ? false : canEdit, running, archived, readOnly)
  const editUuid = typeof msg.uuid === 'string' && isEngineMessageUuid(msg.uuid) ? msg.uuid : ''
  const editHandle = { uuid: editUuid, turnId: turnId || '' }
  const inlineEdit = useInlineUserEdit(sessionId || '', editHandle)
  const wasEditing = useRef(false)
  useLayoutEffect(() => {
    if (wasEditing.current && !inlineEdit.state) row.current?.querySelector<HTMLButtonElement>('[data-action="edit"]')?.focus()
    wasEditing.current = !!inlineEdit.state
  }, [inlineEdit.state])
  // `editTurn` is passed even though the uuid usually suffices: a stopped turn's optimistic
  // bubble has no uuid, and the turn is the only handle that makes its pencil render and its
  // click resolve. See `MsgActionsSpec.editTurn`.
  // A friend message's reply and handoff are icon buttons in the same bar as its
  // time and copy control, revealed on hover like every other message action.
  const friendActions = isFriend && !readOnly ? friendMessageActionsHtml(msg.localRender, sender, t) : ''
  const actions = renderMsgActionsHtml({ ts: msg.timestamp, copyText, uuid: isFriend ? undefined : msg.uuid, editTurn: isFriend ? undefined : turnId, kind: 'user', archived, running, readOnly: isFriend || readOnly, canEdit: editable, extraHtml: friendActions, copyTooltip: !!friendActions })

  const friendIds = [...new Set<string>([
    ...(msg.localRender?.composerReferences || []).filter((ref: any) => ref.kind === 'friend').map((ref: any) => String(ref.id)),
    ...(msg.localRender?.friendOutgoingMessage && msg.localRender?.friendId ? [String(msg.localRender.friendId)] : []),
  ])]
  const receipts = friendOutgoingForMessage(runtime?.outgoing || [], sessionId || '', friendIds, msg.timestamp, {
    requestId: msg.localRender?.friendOutgoingMessage ? msg.localRender?.requestId : undefined,
    dispatchId: msg.localRender?.friendDispatchId,
  })
  const deliveryHtml = receipts.length ? `<div class="friend-outgoing-status">${receipts.map(row => renderFriendOutgoingStatusHtml(row, (w().getFriendDirectoryEntry?.(row.friendId)?.name) || row.friendDisplayName, t, friendOutgoingActionPending(row.requestId))).join('')}</div>` : ''
  const rowHtml = (built?.html || '') + deliveryHtml + actions
  // A scheduled run's trigger message is host-authored: the caption names its
  // provenance above the bubble, the same shape as the delegation label row.
  const automationLabel = automationMessageLabel(msg.localRender, t('chat_user_source_automation'))
  const sourceTagHtml = msg.localRender?.delegationKind === 'initial-input'
    ? renderDelegationLabelHtml(msg.text)
    : automationLabel
    ? `<div class="${styles['automation-source-row']}">${rawIconHtml('cron-sb-task')}<span>${escapeHtml(automationLabel)}</span></div>`
    : ''
  const html = senderColumn + `<div class="${styles['user-row-main']}">` + sourceTagHtml + rowHtml + '</div>' + ownerColumn
  const contentHtml = sourceTagHtml + (built?.html || '')
  useLayoutEffect(() => {
    if (!row.current || isFriend || inlineEdit.state || !richCopy) return
    return registerUserMessageCopy(row.current, { text: richCopy.clipboardText, html: richCopy.html })
  }, [richCopy?.clipboardText, richCopy?.html, isFriend, inlineEdit.state])
  // Replayed metadata can contain a new document object with identical content.
  // Clipboard updates must not unwrap and reinstall the visible disclosure body.
  useLayoutEffect(() => {
    if (!row.current || isFriend || inlineEdit.state) return
    return installUserMessageDisclosure(row.current, copyText, expansion.current, {
      more: t('chat_user_show_more'), less: t('chat_user_show_less'),
    })
  }, [isFriend ? html : built?.content?.bubble?.html ?? contentHtml, copyText, isFriend, t, inlineEdit.state])
  if (!built) return null
  const friendRequestId = isFriend && isIncomingFriendRequest(msg.localRender) && typeof msg.localRender?.requestId === 'string'
    ? msg.localRender.requestId : undefined
  if (friendRequestId && supersededFriendRequestIds?.has(friendRequestId)) return null
  if (isFriend && friendStatusDisplay(msg.localRender)) {
    return <RawHtml className="msg-group system friend-status-row" data-uuid={msg.uuid || undefined} html={built.html} />
  }
  if (inlineEdit.state) return <div ref={row} className={`msg-group user ${ownerColumn ? styles['owner-sender-row'] : ''}`} data-uuid={msg.uuid || undefined} data-nav-turn="true">
    <div className={styles['user-row-main']}>
      {built.attachmentsHtml && <RawHtml html={built.attachmentsHtml} />}
      <InlineUserEditor editKey={inlineEdit.key} />
    </div>
    {ownerColumn && <RawHtml html={ownerColumn} />}
  </div>
  if (isFriend) {
    // A request's decision belongs with the message that asks for it: the card
    // renders right under that bubble, aligned with the sender column, instead
    // of floating at the end of the conversation.
    const approvalRequestId = isIncomingFriendRequest(msg.localRender) && typeof msg.localRender?.requestId === 'string'
      ? msg.localRender.requestId : ''
    // A request paired to an ordinary conversation is answered there by the
    // owner; it never offers the friend-task approval.
    const ownerChat = msg.localRender?.ownerChat === true
    const ownerChatFriendId = typeof sender?.friendshipId === 'string' ? sender.friendshipId : ''
    return <>
      <RawHtml ref={row}
        className={`msg-group user ${styles['external-sender-row']}`} data-nav-turn="true" data-uuid={msg.uuid || undefined}
        data-external-sender="true" html={html} />
      {approvalRequestId && !readOnly ? <div className={chatStyles['friend-approval-inline']}>{ownerChat
        ? <FriendOwnerChatRequest requestId={approvalRequestId} friendId={ownerChatFriendId}
            friendName={identity?.name || ''} messageId={msg.localRender?.messageId || approvalRequestId} />
        : <FriendTaskApproval sessionId={sessionId || ''} requestId={approvalRequestId} />}</div> : null}
    </>
  }
  // Status and action changes must not replace the submitted content or its images.
  // Separate HTML hosts preserve decoded thumbnails, the avatar and text selection.
  // The turn handle also addresses optimistic messages that have no saved uuid yet.
  return (
    <div ref={row}
      className={`msg-group user ${styles['owner-sender-row']}`} data-nav-turn="true" data-uuid={msg.uuid || undefined}
      data-owner-sender="true"
      data-editable={editable ? 'true' : undefined}
      data-edit-uuid={editable ? editUuid : undefined}
      data-edit-turn={editable && turnId ? turnId : undefined}
    >
      <div className={styles['user-row-main']}>
        <RawHtml style={{ display: 'contents' }} html={sourceTagHtml} />
        {built.content ? <SubmittedMessageContent content={built.content} /> : <RawHtml style={{ display: 'contents' }} html={built.html} />}
        <RawHtml style={{ display: 'contents' }} html={deliveryHtml + actions} />
      </div>
      <RawHtml style={{ display: 'contents' }} html={ownerColumn} />
    </div>
  )
}

export function FriendFollowUp({ children }: { text: string; children: ReactNode; streaming?: boolean }) {
  return <>{children}</>
}

function TranscriptErrorNotice({ text, children }: { text: string; children?: ReactNode }) {
  return <div className={`msg-group system ${styles['error-notice-row']}`}>
    <RawHtml className="error-notice-host" html={renderErrorNoticeHtml(text)} />
    {children}
  </div>
}

function UnitView({ unit, isThinkingExpanded, onToggleThinking, archived, running, composerAuthored, readOnly, sessionId, streamSessionId, editTarget, supersededFriendRequestIds }: UnitProps & {
  unit: Unit
}) {
  const t = useT()
  // Device names resolve asynchronously from the account device list; a row
  // that names a computer must repaint when the name arrives.
  useDeviceNamesVersion()
  const msg = unit.msg
  if (unit.type === 'workflow-record') {
    return unit.workflowRecord ? <WorkflowRecordView record={unit.workflowRecord} sessionId={sessionId || ''} /> : null
  }
  if (unit.type === 'agent-event') {
    return unit.agentEvent ? <AgentLifecycleRow event={unit.agentEvent} events={unit.agentEvents} turnId={unit.turnId} laterAgentIds={unit.laterAgentIds} /> : null
  }
  if (unit.type === 'compaction') {
    return <CompactionEvent loading={!!msg.isCompactionStart} trigger={msg.compactionTrigger || msg.trigger}
      restoredText={unit.restoredText} />
  }
  if (unit.type === 'compact-file-restore') {
    return <div className={`msg-group system ${styles['compaction-row']}`}>
      <details className={styles['compaction-restored']}>
        <summary>{t('compaction_restored_files')}</summary>
        <pre>{msg.text || ''}</pre>
      </details>
    </div>
  }
  if (unit.type === 'compact-summary') {
    return <CompactSummaryCard text={msg.text || ''} sessionId={sessionId} />
  }
  if (unit.type === 'turn-status') {
    return <TurnTerminalStatus durationMs={msg?.durationMs} />
  }
  if (unit.type === 'fail-hint') {
    return <TranscriptErrorNotice text={providerErrorText(msg?.text || '', typeof msg?.kind === 'string' ? msg.kind : undefined, t, msg?.errorDetails) || t('chat_error_generic')} />
  }
  if (unit.type === 'fork') {
    const actions = renderMsgActionsHtml({ ts: msg.timestamp, copyText: msg.text || '', uuid: msg.uuid, kind: 'user', archived, running, readOnly })
    return (
      <RawHtml className={`msg-group user ${styles['fork-message']}`} data-uuid={msg.uuid || undefined}
        html={buildForkHtml(msg.text) + actions} />
    )
  }
  if (unit.type === 'teammate') {
    const html = buildTeammateGroupHtml(msg.text, sessionId)
    if (!html) return null
    const actions = renderMsgActionsHtml({ ts: msg.timestamp, copyText: msg.text || '', uuid: msg.uuid, kind: 'user', archived, running, readOnly })
    return (
      <RawHtml className="msg-group teammate" data-uuid={msg.uuid || undefined}
        html={html + actions} />
    )
  }
  if (unit.type === 'delegation') {
    if (externalMessageDisplay(msg.localRender) !== null) {
      return <UserMessageRow msg={msg} composerAuthored={false} archived={archived} running={running} readOnly={readOnly} canEdit={false} turnId={unit.turnId} sessionId={sessionId} />
    }
    // The shape: a delegation is an ordinary user bubble with ONE small line
    // above it saying where it came from, not a card of its own. The bubble is
    // built by the same function as a typed message so the two cannot drift apart;
    // only the text is swapped for the sender's prose out of the envelope.
    //
    // A malformed envelope yields null and falls through to the ordinary user
    // bubble, so nothing is ever swallowed.
    const input = delegationEnvelopeInput(msg.text)
    if (input !== null) {
      const built = buildUserBubbleHtml({ ...msg, text: input }, false, sessionId)
      const label = renderDelegationLabelHtml(msg.text)
      if (built && label) {
        // Copy takes the sender's prose, not the protocol wrapper — the same rule
        // the bubble itself follows. The uuid stays on the row so the click
        // delegate and any rewind lookup can still find the message.
        const actions = renderMsgActionsHtml({ ts: msg.timestamp, copyText: input, uuid: msg.uuid, kind: 'user', archived, running, readOnly })
        // The sender column carries the agent's own avatar; the provenance
        // line above the bubble keeps naming the sending chat or computer.
        return (
          <RawHtml className={`msg-group user delegation ${styles['external-sender-row']}`} data-uuid={msg.uuid || undefined}
            data-external-sender="true"
            html={renderAgentSenderAvatarHtml() + `<div class="${styles['user-row-main']}">` + label + built.html + actions + '</div>'} />
        )
      }
    }
    // Not a well-formed envelope: ordinary prose that merely MENTIONS the tag, an
    // envelope with text around it, two envelopes in one message, or an unclosed
    // one. The substring classifier cannot tell those apart from a real delegation,
    // so this branch must render them itself — falling through reaches the
    // `unit.segment!` tail below, and a delegation unit has no segment, which threw
    // a TypeError and blanked the WHOLE transcript. A user typing "what does
    // <klaus-delegation> mean?" is enough to hit it.
    //
    // Showing the raw text is deliberate, the same rule `parseDelegationEnvelope`
    // applies: swallowing user-visible text is worse than showing a wrapper that
    // failed to parse.
  }
  if (unit.type === 'user' || unit.type === 'delegation') {
    return (
      <UserMessageRow
        msg={msg} composerAuthored={composerAuthored} archived={archived} running={running}
        readOnly={readOnly}
        supersededFriendRequestIds={supersededFriendRequestIds}
        canEdit={unit.type === 'user' && rowIsEditTarget(editTarget, msg.uuid, unit.turnId, unit.steered === true)}
        turnId={unit.turnId} sessionId={sessionId}
      />
    )
  }
  if (unit.type === 'approval-review' && unit.approvalReview) return <ApprovalReviewCard review={unit.approvalReview} />
  if (unit.type === 'goal-completion') return null
  if (unit.type === 'proposed-plan' && unit.segment?.plan) return <ProposedPlanView plan={unit.segment.plan} sessionId={sessionId || streamSessionId || unit.segment.plan.threadId} />
  if (unit.type === 'ask-user') {
    if (unit.block?.name === 'request_user_input') {
      const block = unit.block
      const owner = sessionId || streamSessionId || ''
      return <PlanningQuestionHistoryView readOnly={readOnly} sessionId={owner} turnId={unit.turnId || block.turnId} block={block} />
    }
    if (unit.block?.name === 'ask_user_async') {
      const receipt = asyncQuestionReceipt(unit.block)
      const questions = unit.block.input?.questions || []
      if (!receipt) return <div className={styles['async-question-text']}>{questions.map((question: any, index: number) => <p key={index}>{question.question}</p>)}</div>
      const owner = sessionId || streamSessionId || ''
      return <AsyncQuestionText sessionId={owner} readOnly={readOnly} request={{ ...receipt, sessionId: owner, toolCallId: unit.block.id,
        toolName: 'ask_user_async', responseChannel: 'async-question', toolInput: { questions } }} />
    }
    const card = renderResolvedAskUserCardHtml(unit.block)
    if (!card) return null
    // 外壳由组件渲染（question-card 是消息流顶层直接子节点，不多包一层）。
    return <RawHtml className={card.className} html={card.innerHtml} />
  }
  const segment = unit.segment!
  if (segment.kind === 'thinking') {
    return (
      <div className={`thinking-done${isThinkingExpanded(unit.key) ? ' open' : ''}`}>
        <RawHtml className={`${styles['thinking-toggle']}`} onClick={() => onToggleThinking(unit.key)}
          html={`<span><span data-i18n="thought_for">${t('thought_for') || 'Thought for '}</span>${segment.durationLabel}</span>${rawIconHtml('chevron-right', { cls: styles['thinking-chevron'] })}`} />
        <RawHtml className={`${styles['thinking-detail']}`} html={formatThinkingHtml(segment.thinking)} />
      </div>
    )
  }
  if (segment.kind === 'text') {
    const bubble = <FinalAssistantBubble
      // foldUnits 把相对路径的嵌图解析成了绝对路径（按本回合工具产物），渲染和
      // 复制都用解析后的那份：用户复制到的路径就是能打开的那个。
      text={unit.resolvedText ?? segment.text ?? ''}
      navigationAnswer={!!unit.isFinalReply || !!unit.hasActions}
      suppressImagePaths={unit.suppressImagePaths}
      sessionId={sessionId || streamSessionId || ''}
      inlineVis={segment.inlineVis}
      endResourceTurn={readOnly ? null : unit.endResourceTurn}
      turnId={unit.turnId}
      actionsHtml={unit.hasActions ? renderMsgActionsHtml({ ts: unit.ts, copyText: '', kind: 'assistant', archived, running, readOnly, goalCompletion: unit.goalCompletion }) : ''}
    />
    return unit.friendFollowUp ? <FriendFollowUp text={unit.resolvedText ?? segment.text ?? ''}>{bubble}</FriendFollowUp> : bubble
  }
  return <HistoryToolCards tools={segment.tools || []} sessionId={sessionId} stateSessionId={streamSessionId} turnKey={unit.turnId} suppressFigurePaths={unit.suppressFigurePaths} readOnly={readOnly} />
}

export function HistoryToolCards({ tools, sessionId = '', stateSessionId = sessionId, turnKey = '', suppressFigurePaths, readOnly }: {
  tools: SegmentTool[]; sessionId?: string; stateSessionId?: string; turnKey?: string; suppressFigurePaths?: ReadonlySet<string>; readOnly?: boolean
}) {
  return <div className={styles['tool-container']} data-done="1">
    {tools.map(tool => <HistoryActivityTool key={tool.toolCallId} tool={tool}
      sessionId={sessionId} stateSessionId={stateSessionId} turnKey={turnKey} suppressFigurePaths={suppressFigurePaths} readOnly={readOnly} />)}
  </div>
}

function HistoryActivityTool({ tool, sessionId, stateSessionId, turnKey, suppressFigurePaths, readOnly }: {
  tool: SegmentTool; sessionId: string; stateSessionId: string; turnKey: string; suppressFigurePaths?: ReadonlySet<string>; readOnly?: boolean
}) {
  const parentAgentId = useChatStream(state => selectSubagentParentId(state, stateSessionId))
  const saved = useChatStream(state => state.sessions[stateSessionId]?.turnCollapseOverrides[`tool:${tool.toolCallId}`])
  const [localOpen, setLocalOpen] = useState(false)
  const open = stateSessionId ? saved === false : localOpen
  const toggle = () => {
    if (!stateSessionId) { setLocalOpen(!open); return }
    setTurnCollapsed(stateSessionId, `tool:${tool.toolCallId}`, open)
    if (!open && /^mcp[_.]/i.test(tool.toolName)) setTurnCollapsed(stateSessionId, `mcp-expanded:${turnKey}`, true)
  }
  const data: ActivityToolData = { ...tool, sessionId, parentAgentId, output: tool.output?.text, media: tool.output?.media,
    state: tool.state === 'running' || tool.state === 'error' || tool.state === 'interrupted' || tool.state === 'awaiting-approval' ? tool.state : 'done' }
  const media = activityToolPresentation(data).kind === 'image' ? [] : (tool.output?.media || []).filter(item => !suppressFigurePaths?.has(item.path))
  return <><ActivityTool tool={data} open={open} onToggle={toggle} readOnly={readOnly} />
    {media.length ? <RawHtml className={styles['media-figures']} html={renderMediaFigureHtml(media.map(item => ({ path: item.path, sessionId, src: mediaUrl(item.path, sessionId), name: basenameFromPath(item.path) })))} /> : null}
  </>
}

function FoldItems({ items, sessionId, unitProps }: {
  items: FoldItem[]
  sessionId: string
  unitProps: UnitProps
}) {
  return <>{items.map(item => item.kind === 'unit'
    ? <UnitView unit={item.unit} key={item.unit.key} {...unitProps} />
    : <TurnAgentRows key={item.key} tools={item.tools} sessionId={sessionId} turnInterrupted={item.turnInterrupted} />)}</>
}

function activitySummaryParts(t: (key: string) => string, summary: ActivitySummary): string[] {
  const parts: string[] = []
  const add = (key: string, count?: number) => {
    const plurality = count == null ? '' : `_${new Intl.PluralRules(intlLocale()).select(count) === 'one' ? 'one' : 'other'}`
    parts.push(t(`chat_summary_${key}${plurality}_${parts.length ? 'following' : 'leading'}`).replace('{count}', String(count ?? '')))
  }
  if (summary.sources.length) {
    add('integrations', summary.sources.length)
    parts[0] = parts[0].replace('{sources}', new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(summary.sources))
  }
  if (summary.skills + summary.loadedTools) add('loaded', summary.skills + summary.loadedTools)
  if (summary.unnamedMcp) add('called', summary.unnamedMcp)
  if (summary.edits) add('edited', summary.edits)
  if (summary.images) add('images', summary.images)
  if (summary.reads || summary.searches || summary.lists) add('read')
  if (summary.commands) add('commands', summary.commands)
  if (summary.web) add('web')
  const semanticPart = (tool: { name: string }) => {
    const kind = mediaGenerationKind(tool.name)
    const calls = summary.allTools.filter(call => call.toolName === tool.name)
    const semantic = semanticActivity(tool.name, calls[0]?.args)
    if (semantic) {
      const actions = new Map<string, typeof calls>()
      for (const call of calls) {
        const action = semanticActivity(call.toolName, call.args, call.content)!
        actions.set(action.action, [...(actions.get(action.action) ?? []), call])
      }
      for (const group of actions.values()) {
        const action = semanticActivity(group[0].toolName, group[0].args, group[0].content)!
        if (group.some(call => semanticActivity(call.toolName, call.args, call.content)?.target !== action.target)) action.target = ''
        const label = semanticActivityLabel(action, mediaGenerationSummaryState(group.map(call => call.state)), intlLocale())
        parts.push(parts.length && !intlLocale().startsWith('zh') ? label.charAt(0).toLowerCase() + label.slice(1) : label)
      }
    } else if (kind) {
      parts.push(mediaGenerationLabel(kind, mediaGenerationSummaryState(calls.map(call => call.state)), intlLocale()))
    } else parts.push(activityToolDisplayName(tool.name))
  }
  const web = summary.tools.filter(tool => semanticActivity(tool.name)?.category === 'web')
  web.forEach(semanticPart)
  if (summary.dynamicTools.length) parts.push(chatActivitySummaryLabel(t, summary.dynamicTools, parts.length === 0))
  summary.tools.filter(tool => !web.includes(tool)).forEach(semanticPart)
  return parts.length ? parts : [t('activity_completed')]
}

// Exported for the glyph-parity test: the headline is the third surface that
// resolves a tool icon, and asserting it needs the component, not just the
// resolver (a test that calls the resolver twice proves nothing).
export type ActivityHeaderNode = Pick<ActivityFoldNode, 'mode' | 'activeAction' | 'summary' | 'thinkingHeading'>

export function activitySummaryLabel(t: (key: string) => string, node: ActivityHeaderNode): string {
  if (node.mode !== 'summary') {
    const action = node.activeAction
    const semantic = action && semanticActivity(action.name, action.tool.args, action.tool.content)
    if (semantic) return semanticActivityLabel(semantic, action.tool.state, intlLocale())
    const generationKind = action && mediaGenerationKind(action.name)
    if (generationKind) return mediaGenerationLabel(generationKind, action.tool.state, intlLocale())
    if (action?.dynamic) return dynamicActivityLabel(t, action.tool, false)
    if (action?.kind === 'skill') {
      // A SKILL.md read carries its identifier in the target path; the `skill`
      // tool never lands here because it renders through the dynamic branch.
      return skillActivityLabel(t, skillIdentifierFromPath(action.target), action.tool.state)
    }
    if (action?.kind === 'image') return t('activity_active_image').replace('{count}', String(action.imageCount || 1))
    if (action) return `${t(`activity_active_${action.kind}`)}${action.target ? ` ${action.target}` : action.kind === 'tool' ? ` ${action.name}` : ''}`
    return t('thinking_label')
  }
  const parts = activitySummaryParts(t, node.summary)
  if (node.summary.allTools.some(tool => semanticActivity(tool.toolName, tool.args)?.category === 'friend')) return parts.join(' · ')
  return new Intl.ListFormat(intlLocale(), { style: 'long', type: 'unit' }).format(parts)
}

export function ActivityHeader({ node, thinkingHeading = node.thinkingHeading || '' }: {
  node: ActivityHeaderNode; thinkingHeading?: string
}) {
  const t = useT()
  const action = node.activeAction
  const pendingLabel = activitySummaryLabel(t, { ...node, thinkingHeading })
  const pendingIcon = action ? activityToolIconName(action.tool.toolName, action.tool.args) : ''
  const [headline, setHeadline] = useState({ label: pendingLabel, icon: pendingIcon })
  const updatedAt = useRef(0)
  useEffect(() => {
    if (node.mode === 'summary') { updatedAt.current = 0; return }
    const timer = setTimeout(() => {
      setHeadline({ label: pendingLabel, icon: pendingIcon })
      updatedAt.current = Date.now()
    }, Math.max(0, 1000 - (Date.now() - updatedAt.current)))
    return () => clearTimeout(timer)
  }, [pendingLabel, pendingIcon, node.mode])
  if (node.mode !== 'summary') return <span className={styles['activity-active-label']}>
    {headline.icon ? <Icon name={headline.icon} size={16} /> : null}<span>{headline.label}</span>
  </span>
  return <span className={styles['activity-summary-label']}>{chatGroupIcon(node)}<span>{activitySummaryLabel(t, node)}</span></span>
}

export function activitySummaryIconTool(node: ActivityHeaderNode): ChatActivityTool | undefined {
  if (node.mode !== 'summary') return node.activeAction?.tool
  const allTools = node.summary.allTools
  const kind = (tool: ChatActivityTool) => describeActivity(tool.toolName, tool.args, tool.state, tool.content ?? tool.output?.text, tool.media).kind
  return allTools.find(tool => mcpActivitySource(tool.toolName) !== null && !mcpActivityIsCommand(tool.toolName) && !semanticActivity(tool.toolName, tool.args))
    || allTools.find(tool => isToolDiscovery(tool.toolName) && loadedActivityToolNames([tool]).size > 0)
    || allTools.find(tool => tool.toolName.startsWith('mcp__') && !mcpActivityIsCommand(tool.toolName) && !semanticActivity(tool.toolName, tool.args))
    || allTools.find(tool => kind(tool) === 'skill')
    || allTools.find(tool => kind(tool) === 'edit')
    || allTools.find(tool => kind(tool) === 'image')
    || allTools.find(tool => !isToolDiscovery(tool.toolName) && ['read', 'list', 'search'].includes(kind(tool)))
    || allTools.find(tool => kind(tool) === 'command')
    || allTools.find(tool => kind(tool) === 'web')
    || node.summary.dynamicTools[0]
    || allTools[0]
}

export function chatGroupIcon(node: ActivityHeaderNode): ReactNode {
  const first = activitySummaryIconTool(node)
  if (!first) return null
  const sourceIcon = node.mode === 'summary' && isToolDiscovery(first.toolName) ? 'activity-loaded-tools'
    : first.toolName.startsWith('mcp__') && !mcpActivityIsCommand(first.toolName) && !semanticActivity(first.toolName, first.args) ? 'activity-mcp-source'
    : null
  const html = sourceIcon ? rawIconHtml(sourceIcon) : rawIconHtml(activityToolIconName(first.toolName, first.args))
  return <RawHtml tag="span" className="kls-icon-host" html={html} />
}

function ActivityFold({ node, onToggle, sessionId, ...unitProps }: UnitProps & {
  node: ActivityFoldNode
  onToggle: () => void
  sessionId: string
}) {
  return <ActivityDisclosure enabled={node.mode === 'summary'} open={node.open} onToggle={onToggle} label={<ActivityHeader node={node} />}>
    <FoldItems items={node.items} sessionId={sessionId} unitProps={{ ...unitProps, sessionId }} />
  </ActivityDisclosure>
}

function ProcessNodeView({ node, onToggle, sessionId, unitProps }: {
  node: RenderNode
  onToggle: (foldKey: string, open: boolean) => void
  sessionId: string
  unitProps: UnitProps
}): ReactNode {
  if (node.kind === 'unit') return <UnitView unit={node.unit} {...unitProps} />
  if (node.kind === 'turn-agents') return <TurnAgentRows tools={node.tools} sessionId={sessionId} turnInterrupted={node.turnInterrupted} turnId={node.turnId} />
  if (node.kind === 'activity-fold') return <ActivityFold node={node} {...unitProps} sessionId={sessionId} onToggle={() => onToggle(node.foldKey, node.open)} />
  return null
}

function TurnFold({ node, onToggleFold, sessionId, unitProps }: {
  node: TurnFoldNode
  onToggleFold: (foldKey: string, open: boolean) => void
  sessionId: string
  unitProps: UnitProps
}) {
  const t = useT()
  const owner = unitProps.streamSessionId || sessionId
  const pagination = useTurnItemsPagination(owner, node.turnId)
  const label = <TurnWorkLabel startedAtMs={node.running || node.completedAtMs != null ? node.startedAtMs ?? null : null}
    completedAtMs={node.completedAtMs} durationMs={!node.running ? node.durationMs : undefined}
    fallback={node.running ? undefined : t('activity_previous_messages').replace('{count}', String(node.messageCount))} />
  const gap = pagination && !pagination.hasLoadedOldest && node.turnId ? [{
    key: `history-gap:${node.turnId}`, persistent: false,
    content: <TurnHistoryGap sessionId={owner} turnId={node.turnId} pagination={pagination} open={node.open} />,
  }] : []
  return <ActivityDisclosure variant="turn" open={node.open} onToggle={() => onToggleFold(node.foldKey, node.open)} label={label}
    sections={[...gap, ...node.items.map(item => ({
      key: item.kind === 'unit' ? item.unit.key : item.key,
      // Messages and workflow artifacts retain their arrival position while activity collapses.
      persistent: isPersistentTurnNode(item),
      content: <ProcessNodeView node={item} sessionId={sessionId} unitProps={unitProps} onToggle={onToggleFold} />,
    }))]} />
}

function useTurnItemsPagination(sessionId: string, turnId: string | undefined) {
  return useChatStream(state => turnId
    ? savedTurn(state.sessions[sessionId]?.savedTranscript ?? null, turnId)?.itemsPagination : undefined)
}

/** Visible gaps advance one page at a time; failures wait for an explicit retry. */
function HistoryGap({ loading, failed, progressKey, load, enabled = true, observe }: {
  loading: boolean
  failed: boolean
  progressKey: string
  load: () => void
  enabled?: boolean
  observe?: RefObject<HTMLDivElement | null>
}) {
  const t = useT()
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = observe?.current ?? element.current
    if (!target || !enabled || failed || loading || typeof IntersectionObserver === 'undefined') return
    let root = target.parentElement
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load()
    }, { root, rootMargin: '800px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [enabled, failed, loading, progressKey, load, observe])
  // Paging older items is background work. A standalone status row above the
  // turn interrupts the conversation for no actionable reason, so keep only an
  // invisible anchor for the observer. Failures still need the explicit retry.
  if (!failed) return <div ref={element} className={styles['transcript-history-sentinel']} aria-hidden="true" />
  return <div ref={element} className={styles['transcript-load-failed']} role="alert">
    <span className={styles['transcript-load-failed-text']}>{t('transcript_history_load_failed')}</span>
    <button className={styles['transcript-load-failed-retry']} type="button" disabled={loading} onClick={load}>
      {t('transcript_history_load_retry')}
    </button>
  </div>
}

function SavedHistoryGap({ sessionId, request }: { sessionId: string; request: TurnBoundaryRequest }) {
  const failed = useChatStream(state => state.sessions[sessionId]?.historyLoadFailed ?? false)
  const loading = useChatStream(state => state.sessions[sessionId]?.turnsPagination?.isLoadingOlder ?? false)
  const load = useCallback(() => { void loadOlderHistoryPage(sessionId, request) },
    [sessionId, request.generation, request.islandId, request.boundaryId, request.progressKey])
  return <HistoryGap loading={loading} failed={failed} progressKey={request.progressKey} load={load} />
}

function TurnHistoryGap({ sessionId, turnId, pagination, open, observe }: {
  sessionId: string; turnId: string; pagination: TurnItemsPagination; open: boolean; observe?: RefObject<HTMLDivElement | null>
}) {
  const load = useCallback(() => { void loadTurnHistoryItems(sessionId, turnId).catch(() => {}) }, [sessionId, turnId])
  return <HistoryGap enabled={open} observe={observe} loading={pagination.isLoadingOlder} failed={!!pagination.error}
    progressKey={JSON.stringify([pagination.summaryItemIds, pagination.olderCursor, pagination.olderItemId, pagination.evicted])} load={load} />
}

/**
 * A turn's produced images, OUTSIDE the turn fold.
 *
 * This block exists because of where the images used to hang: on the tool card,
 * which the turn fold swallows once a final answer arrives. The result was a
 * conversation that generated a picture successfully and showed the user
 * nothing — the picture was one expansion away, in the folded history. A
 * generated image is a deliverable, so it renders where the deliverables
 * render: after the final answer, alongside the diagram and changed-file blocks.
 *
 * The lightbox delegation needs no wiring here: it matches `.media-figure`
 * anywhere in the transcript container, the same class the folded card and the
 * markdown-rendered inline images use.
 */
export function TurnMediaBlock({ paths, sessionId }: { paths: string[]; sessionId: string }) {
  const figures = paths
    .map(path => ({ path, src: mediaUrl(path, sessionId), name: basenameFromPath(path) || 'image' }))
    .filter(item => item.src)
  if (!figures.length) return null
  // 容器用 turn-media 而不是 media-figures：这个区块是正文列（.msg-group）的兄弟
  // 节点，必须跟回合改动卡、图表卡同一套列约束（居中、限宽 720）。media-figures
  // 是全宽左对齐的，只适合待在工具卡或正文流内部。
  return (
    <div className={styles['turn-media']}>
      {figures.map((item, index) => (
        <button className={styles['media-figure']} type="button" aria-label={item.name} data-media-figure="1" data-media-path={item.path} data-media-session={sessionId} key={`${item.path}:${index}`}>
          <img src={item.src} alt={item.name} loading="lazy" />
        </button>
      ))}
    </div>
  )
}

/**
 * A turn's visual-surface cards, OUTSIDE the turn fold.
 *
 * Same placement reason as the media block: a deliverable the fold would swallow
 * is a deliverable the user never sees. Each card opens the in-app panel that
 * owns its kind, so a scene and a diagram built in one turn each get their own
 * way in. The kinds are listed per artifact rather than per block, because one
 * turn can legitimately produce both.
 */
const VISUAL_ARTIFACT_SURFACE = {
  diagram: { icon: 'digram', readyKey: 'digram_artifact_ready', openKey: 'digram_artifact_open', open: 'klausOpenDigramPanel' },
  model3d: { icon: 'model3d', readyKey: 'model3d_artifact_ready', openKey: 'model3d_artifact_open', open: 'klausOpenModel3DPanel' },
  prototype: { icon: 'canvas', readyKey: 'prototype_artifact_ready', createdKey: 'prototype_artifact_created', openKey: 'prototype_artifact_open', open: 'klausOpenPrototypePanel' },
  'video-editing': { icon: 'tool-generate-video', readyKey: 'video_editing_artifact_ready', openKey: 'video_editing_artifact_open', open: 'klausOpenVideoEditingPanel' },
  ppt: { icon: 'canvas', readyKey: 'ppt_artifact_ready', createdKey: 'ppt_artifact_created', openKey: 'ppt_artifact_open', open: 'klausOpenPptPanel' },
} as const

function VisualArtifactsBlock({ sessionId, artifacts }: { sessionId: string; artifacts: VisualArtifact[] }) {
  const t = useT()
  return (
    <div className={styles['diagram-artifacts']}>
      {artifacts.map(artifact => {
        const surface = VISUAL_ARTIFACT_SURFACE[artifact.kind]
        return (
          <button
            className={styles['diagram-artifact-card']}
            type="button"
            key={`${artifact.kind}:${artifact.id}`}
            onClick={() => w()[surface.open]?.(artifact.id, sessionId)}
          >
            <RawHtml tag="span" className={styles['diagram-artifact-icon']} html={rawIconHtml(surface.icon)} />
            <span className={styles['diagram-artifact-copy']}>
              <span className={styles['diagram-artifact-title']}>{artifact.title}</span>
              <span className={styles['diagram-artifact-hint']}>{t(visualArtifactHintState(artifact) === 'created' && 'createdKey' in surface ? surface.createdKey : surface.readyKey)}</span>
            </span>
            <span className={styles['diagram-artifact-open']}>{t(surface.openKey)}</span>
            <RawHtml tag="span" className={styles['diagram-artifact-chevron']} html={rawIconHtml('chevron-right')} />
          </button>
        )
      })}
    </div>
  )
}

// 回合改动区块：一个完结回合改了哪些文件。
//
// 数据取自概览「产物」区那份按回合的记录（引擎的 session/fileChanges），不是
// 工作树的 git 改动。这里是当前回合切片；审查入口打开 Changes 面板并定位到该
// 回合的记录，面板报的则是所选比较范围内的全部改动。
//
// 行数可能是 null（引擎拿不到基线），显示 `–` 而不是 0；0 是量出来的零，照印。
const TURN_CHANGES_PREVIEW_FILES = 3

/** 右侧工作面板开着时悬停预览让位：面板里就是完整 diff，浮层只会叠在上面。 */
function artifactsPanelOpen(): boolean {
  const panel = document.getElementById('artifacts-panel')
  return !!panel && !panel.classList.contains('collapsed')
}

function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
  }
  return null
}

/** 展开文件列表时把卡片钉在原地：列表变高会把下方内容推走，补偿滚动容器的
 *  偏移直到 350ms 后或用户自己滚动/按键为止。 */
function anchorScrollWhile(el: HTMLElement | null): void {
  const parent = el ? scrollParentOf(el) : null
  if (!el || !parent) return
  const start = el.getBoundingClientRect().top
  const until = performance.now() + 350
  let done = false
  const stop = () => { done = true }
  parent.addEventListener('wheel', stop, { once: true, passive: true })
  parent.addEventListener('touchstart', stop, { once: true, passive: true })
  window.addEventListener('keydown', stop, { once: true })
  const step = () => {
    if (done || performance.now() > until) return
    const delta = el.getBoundingClientRect().top - start
    if (Math.abs(delta) > 0.5) parent.scrollTop += delta
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export type ResolvedSubagentActivity = {
  background: boolean
  canLoadTranscript: boolean
  conversationId: string
  displayName: string
  status: SubagentDisplayStatus
  task: AgentTask | null
  taskId: string
  taskText: string
  tool: SegmentTool
}

export function subagentActivityTitleParts(args: any, task: AgentTask | null, taskId: string): { name: string; task: string } {
  const name = subagentDisplayName(taskId, { description: task?.description || args?.description })
  if (task) return { name, task: subagentTaskText(task) }
  const description = typeof args?.description === 'string' ? args.description.trim() : ''
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
  return { name, task: description || prompt }
}

export function resolveSubagentActivities(tools: SegmentTool[], turnInterrupted = false): ResolvedSubagentActivity[] {
  const panel = (w() as any).KlausSubagentPanel
  return tools.map(tool => {
    const task = panel?.getTask?.(tool.toolCallId) as AgentTask | null
    const taskId = tool.toolCallId
    const conversationId = task ? subagentConversationId(taskId, task) : taskId
    const titleParts = subagentActivityTitleParts(tool.args, task, taskId)
    // `isBackground` is NOT the discriminator here: reconcileAgentStatus stamps it
    // on every run the engine confirms, foreground spawns included. What marks a
    // run as deliberately detached is its KIND.
    const detached = task?.agentType === 'background' || task?.type === 'background'
    const taskStatus = task ? subagentDisplayStatus(task) : null
    // The Turn's terminal state wins over a snapshot that still claims to run.
    // The spawn call itself usually finishes long before the subagent does, so
    // the tool's own state says nothing here: what settles a subagent belonging to
    // this Turn is the Turn ending. Left to the snapshot, the row keeps a live
    // elapsed timer ticking under a Turn the user already stopped.
    const stopped = (tool.state === 'interrupted' || (turnInterrupted && !detached))
      && (taskStatus == null || !isTerminalSubagentStatus(taskStatus))
    const status: SubagentDisplayStatus = stopped
      ? 'stopped'
      : taskStatus
        ?? (tool.state === 'error'
          ? 'failed'
          : tool.state === 'running'
            ? 'running'
            : 'completed')
    return {
      background: task?.isBackground === true,
      canLoadTranscript: !!task && (task.type === 'in_process_teammate' || !!task.agentId),
      conversationId,
      displayName: titleParts.name,
      status,
      task: task || null,
      taskId,
      taskText: titleParts.task,
      tool,
    }
  })
}

function TurnAgentRows({ tools, sessionId: _sessionId, turnInterrupted = false, turnId }: { tools: SegmentTool[]; sessionId: string; turnInterrupted?: boolean; turnId?: string }) {
  useSyncExternalStore(subscribeSubagents, subagentsVersion, () => 0)
  const t = useT()
  const rows = resolveSubagentActivities(tools, turnInterrupted)
  if (!rows.length) return null
  const shown = rows.length > 3 ? rows.slice(0, 2) : rows
  const status = rows.some(row => row.status === 'stopped') ? 'stopped'
    : rows.some(row => row.status === 'failed') ? 'failed'
    : rows.every(row => row.status === 'completed') ? 'completed' : 'running'
  const open = (row: ResolvedSubagentActivity) => {
    const panel = w().KlausSubagentPanel
    if (row.task) panel?.openByTaskId?.(row.taskId)
    else panel?.openByConversationId?.(row.conversationId)
  }
  const states = rows.map(row => ({ taskId: row.taskId, name: row.displayName,
    status: row.status === 'stopped' ? 'cancelled' as const : row.status === 'failed' ? 'failed' as const
      : row.task && (!turnId || !row.task.spawnTurnId || row.task.spawnTurnId === turnId)
        && (row.status === 'completed' || row.status === 'budget_limited') ? 'completed' as const : 'started' as const }))
  const eventStatus = rows.every(row => !row.task && row.tool.state === 'running') ? 'pending' : agentEventRowStatus(states)
  return <div className={styles['subagent-activities']} data-status={status} data-agent-event={eventStatus}>
    <span className={styles['subagent-avatar-stack']}>
      {rows.slice(0, 4).map((row, index) => <SubagentInlineAvatar key={row.conversationId}
        avatarId={row.task?.avatarId} conversationId={row.conversationId} name={row.displayName || t('subagent_default_name')} status={row.status}
        turnId={turnId} interactive={index >= shown.length && !!row.task} onOpen={() => open(row)} />)}
    </span>
    <span className={styles['subagent-activity-text']}>
      <AgentNameList names={shown.map(row => row.displayName || t('subagent_default_name'))} overflow={rows.length > shown.length ? t('subagent_activity_more').replace('{count}', String(rows.length - shown.length)) : undefined} buttons={shown.map(row =>
        row.task ? <button key={row.conversationId} className={styles['subagent-activity-name']} type="button" onClick={() => open(row)}
          aria-label={`${row.displayName || t('subagent_default_name')} · ${t('subagent_open_workspace')}`}>
          {subagentNamePreview(row.displayName || t('subagent_default_name'))}
        </button> : <span key={row.conversationId}>{subagentNamePreview(row.displayName || t('subagent_default_name'))}</span>)} />
      <span className={styles['subagent-activity-status']}>{t(`subagent_event_${eventStatus}${eventStatus === 'cancelled' && rows.length > 1 ? '_plural' : ''}`)}</span>
    </span>
  </div>
}

export function TurnChangesBlock({ sessionId, turnId, status, finalText }: {
  sessionId: string
  turnId: string
  status?: string
  finalText?: string
}) {
  const t = useT()
  const version = useSyncExternalStore(subscribeArtifacts, artifactsVersion)
  const turn = useMemo(() => artifactTurn(sessionId, turnId), [version, sessionId, turnId])
  const [expanded, setExpanded] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  // The turn-end resource cards already present every file this turn edited.
  const covered = useMemo(() => {
    if (!turn || finalText === undefined) return false
    const edited = turn.files.map(file => file.path)
    return endResourcesCoverEdits(turnEndResources({ sessionId, status, finalText, editedPaths: edited }), edited)
  }, [turn, sessionId, status, finalText])
  if (!turn || turn.files.length === 0 || covered) return null

  const files = turn.files
  const count = files.length
  const single = count === 1 ? files[0] : null
  const shown = expanded ? files : files.slice(0, TURN_CHANGES_PREVIEW_FILES)
  const hidden = count - shown.length
  const locale = intlLocale()
  const formatCount = (value: LineCount) => value === null ? '–' : new Intl.NumberFormat(locale).format(value)
  const stats = (added: LineCount, removed: LineCount, className: string) => (
    <span className={className}>
      <span className="diff-add">{`+${formatCount(added)}`}</span>
      <span className="diff-del">{`-${formatCount(removed)}`}</span>
    </span>
  )
  const previewOff = artifactsPanelOpen()
  const previewDisabled = (file: ArtifactFile) => previewOff
    || file.turnDiff === null
    || isLargeDiff(file.turnDiff, file.added, file.removed)
  const openReview = (path: string | null) => openTurnChanges(turnId, path)

  const head = (
    <div className={styles['turn-changes-head']}>
      <button type="button" className={styles['turn-changes-head-btn']}
        aria-label={t('turn_changes_review_aria')}
        onClick={() => openReview(single ? single.path : null)} />
      <div className={styles['turn-changes-head-content']}>
        <RawHtml tag="span" className={styles['turn-changes-icon']} html={rawIconHtml('turn-changes-title')} />
        <span className={styles['turn-changes-copy']}>
          <span className={styles['turn-changes-title']}>
            {single
              ? t('turn_changes_title_file').replace('{filename}', single.name || single.relativePath || single.path)
              : t('turn_changes_title').replace('{n}', new Intl.NumberFormat(locale).format(count))}
          </span>
          <span className={styles['turn-changes-sub']}>
            <span className={styles['turn-changes-sub-default']}>
              {stats(turn.added, turn.removed, styles['turn-changes-stats'])}
            </span>
            <span className={styles['turn-changes-sub-hover']}>
              {t('turn_changes_review_hover')}
              <RawHtml tag="span" className={styles['turn-changes-sub-arrow']} html={rawIconHtml('arrow-up-right')} />
            </span>
          </span>
        </span>
        <span className={styles['turn-changes-actions']}>
          <button type="button" className={styles['turn-changes-review']}
            onClick={event => { event.stopPropagation(); openReview(single ? single.path : null) }}>
            {t('turn_changes_review')}
          </button>
        </span>
      </div>
    </div>
  )

  const rowFor = (file: ArtifactFile) => {
    const rel = file.relativePath || file.name || file.path
    const slash = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'))
    const dir = slash >= 0 ? rel.slice(0, slash + 1) : ''
    const base = slash >= 0 ? rel.slice(slash + 1) : rel
    return (
      <button type="button" className={styles['turn-changes-file']}
        onClick={event => {
          // 修饰键点击打开文件本体，普通点击打开该回合的 Changes 记录并定位到它。
          if (event.metaKey || event.ctrlKey) { w().klausOpenWorkspaceFilePath?.(file.path); return }
          openReview(file.path)
        }}>
        <span className={styles['tc-sr']}>{rel}</span>
        <span className={styles['turn-changes-file-path']} aria-hidden="true">
          {dir ? <span className={styles['turn-changes-file-dir']}>{dir}</span> : null}
          <span className={styles['turn-changes-file-base']}>{base}</span>
        </span>
        {file.turnDiff !== null && isLargeDiff(file.turnDiff, file.added, file.removed)
          ? <span className={styles['turn-changes-file-note']}>{t('turn_changes_too_large')}</span>
          : null}
        {stats(file.added, file.removed, styles['turn-changes-file-stats'])}
      </button>
    )
  }

  return (
    <div className={styles['turn-changes']} ref={cardRef}>
      {single
        ? <TurnDiffPreview diff={single.turnDiff} disabled={previewDisabled(single)}>{head}</TurnDiffPreview>
        : head}
      {single ? null : (
        <div className={styles['turn-changes-files']}>
          {shown.map(file => (
            <TurnDiffPreview key={file.path} diff={file.turnDiff} disabled={previewDisabled(file)}>
              {rowFor(file)}
            </TurnDiffPreview>
          ))}
          {hidden > 0 || expanded ? (
            <button type="button" className={styles['turn-changes-toggle']} aria-expanded={expanded}
              onClick={() => { anchorScrollWhile(cardRef.current); setExpanded(v => !v) }}>
              <span>{(expanded
                ? t('turn_changes_show_less')
                : hidden === 1 ? t('turn_changes_show_more_one') : t('turn_changes_show_more')).replace('{n}', String(hidden))}</span>
              <RawHtml tag="span" className={styles['turn-changes-toggle-chevron']} html={rawIconHtml('chevron-down')} />
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function FinalAssistantBubble({ text, actionsHtml = '', suppressImagePaths, sessionId = '', navigationAnswer = true, inlineVis, endResourceTurn, turnId = '' }: { endResourceTurn?: { turnId: string; status: string } | null; turnId?: string; text: string; actionsHtml?: string; suppressImagePaths?: ReadonlySet<string>; sessionId?: string; navigationAnswer?: boolean; inlineVis?: readonly InlineVisFragment[] }) {
  const source = suppressImagePaths?.size ? stripMarkdownImagesForPaths(text, suppressImagePaths) : text
  const { projected, present } = useTurnEndResources(sessionId, navigationAnswer ? endResourceTurn : null, source)
  // A line that only links a file the resource card shows says the same thing
  // twice; the card is that file's presentation. Copying keeps the full reply.
  const display = useMemo(() => stripEndResourceLinkLines(source, endResourceFilePaths(present), sessionWorkdirOf(sessionId)), [source, present, sessionId])
  const html = inlineVisPostProcess(useAsyncMarkdownHtml(display, sessionId, `history:${turnId}`, false))
  // 操作栏必须是 group 直接子节点（:scope > .msg-actions 查询与旧结构对齐），
  // 故 group 内容整体由工厂拼接。data-md 存原始 markdown 供复制。
  return (
    <InlineVisualizationHtml
      className="msg-group assistant"
      html={`<div class="msg assistant"${navigationAnswer ? ' data-nav-answer="true"' : ''} data-md="${escapeHtml(source || '')}">${html}</div>${actionsHtml}`}
      message={projected.length ? { html, markdown: source, answer: navigationAnswer, actionsHtml } : undefined}
      afterContent={present.length ? <EndResourceCards resources={present} sessionId={sessionId} /> : undefined}
      fragments={inlineVis ?? []}
      sessionId={sessionId}
      onOpenExternal={url => w().klaus?.app?.openExternal?.(url)}
    />
  )
}

/** The conversation's working directory, for resolving a reply's relative links. */
function sessionWorkdirOf(sessionId: string): string | null {
  const workdir = w().getKnownSessionInfo?.(sessionId)?.workdir
  return typeof workdir === 'string' && workdir ? workdir : null
}

function CompactSummaryCard({ text, sessionId }: { text: string; sessionId?: string }) {
  const t = useT()
  const bodyRef = useRef<HTMLDivElement>(null)
  const [hasToggle, setHasToggle] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const body = bodyRef.current
    if (body && body.scrollHeight > body.clientHeight + 2) setHasToggle(true)
  }, [text])
  return (
    <div className={`msg-group system ${styles['compact-summary-row']}`}>
      <div className={`${styles['compact-summary-card']}${hasToggle ? ' has-toggle' : ''}${expanded ? ' expanded' : ''}`}>
        <RawHtml className={`${styles['compact-summary-head']}`}
          html={`${rawIconHtml('compact-summary')}<span>${escapeHtml(t('compact_summary_title') || 'Conversation summary')}</span>`} />
        <RawHtml className={`${styles['compact-summary-body']}`} ref={bodyRef} html={renderMarkdownHtml(text, sessionId)} />
        {hasToggle ? (
          <button type="button" className={`${styles['compact-summary-toggle']}`} onClick={() => setExpanded(v => !v)}>
            {expanded ? (t('compact_summary_collapse') || 'Show less') : (t('compact_summary_expand') || 'Show more')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ==================== TranscriptView 容器 ====================

// The host owns scroll intent; the main transcript owns measured virtual rows.
export type TranscriptScrollMode = 'main' | 'simple' | 'none'

export function TranscriptView({ sessionId, container, scroll = 'none', readOnly = false, contextSessionId }: { sessionId: string; container: HTMLElement; scroll?: TranscriptScrollMode; readOnly?: boolean; contextSessionId?: string }) {
  const contextId = contextSessionId || sessionId
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  // 选区引用浮层：scroll 模式即 surface 标识（main = 主转录；simple = 侧任务
  // slot；none = 对照/探针挂载，不启用）。
  const quoteSurface: QuoteSurface | null = readOnly ? null : scroll === 'main' ? 'main' : scroll === 'simple' ? 'side' : null
  const t = useT()
  const history = useChatStream(state => state.sessions[sessionId]?.history ?? null)
  const historyStale = useChatStream(state => state.sessions[sessionId]?.historyStale ?? false)
  const historyLoading = useChatStream(state => state.sessions[sessionId]?.historyLoading ?? false)
  const historyLoadFailed = useChatStream(state => state.sessions[sessionId]?.historyLoadFailed ?? false)
  const turnShells = useChatStream(state => state.sessions[sessionId]?.turnShells)
  const savedTranscript = useChatStream(state => state.sessions[sessionId]?.savedTranscript)
  const shellTurnIds = useMemo(() => new Set(Object.keys(turnShells ?? {})), [turnShells])
  const liveUnitCount = useChatStream(state => state.sessions[sessionId]?.liveUnits?.length ?? 0)
  const liveAnswers = useChatStream(useShallow(state => (state.sessions[sessionId]?.liveUnits ?? EMPTY_LIVE)
    .filter(unit => unit.type === 'live-user' && unit.msg?.questionAnswer)))
  // Text updates belong to the live subtree. The history layer subscribes only
  // to structural review/edit changes, keeping historical cards and selections stable.
  const liveReviewSignature = useChatStream(state => JSON.stringify(
    (state.sessions[sessionId]?.liveUnits ?? EMPTY_LIVE)
      .filter(unit => unit.type === 'live-plan-review')
      .map(unit => String((unit as { req?: { toolCallId?: unknown } }).req?.toolCallId ?? ''))
      .filter(Boolean)))
  const livePlanReviewIds = useMemo(() => new Set<string>(JSON.parse(liveReviewSignature)), [liveReviewSignature])
  const liveEditUser = useChatStream(state => {
    const units = state.sessions[sessionId]?.liveUnits ?? EMPTY_LIVE
    for (let index = units.length - 1; index >= 0; index--) {
      const unit = units[index]
      if (unit.type === 'live-user' && !unit.msg?.steered && (unit.msg?.uuid || unit.turnId)) return unit
    }
    return null
  })
  const running = useChatStream(state => state.sessions[sessionId]?.running ?? false)
  const activeTurnId = useChatStream(state => state.sessions[sessionId]?.activeTurnId ?? null)
  const turnStatuses = useChatStream(state => selectSessionStream(state, sessionId).turnStatuses)
  const { startedAtMs: turnStartedAtMs, completedAtMs: turnWorkCompletedAtMs } = useTurnWorkTimes(sessionId)
  const turnFinishedAtMs = useChatStream(state => selectSessionStream(state, sessionId).turnFinishedAtMs)
  const turnErrors = useChatStream(state => selectSessionStream(state, sessionId).turnErrors)
  const turnErrorKinds = useChatStream(state => selectSessionStream(state, sessionId).turnErrorKinds)
  const turnErrorDetails = useChatStream(state => selectSessionStream(state, sessionId).turnErrorDetails)
  const turnDurations = useChatStream(state => selectSessionStream(state, sessionId).turnDurations)
  const turnCancelledTools = useChatStream(state => selectSessionStream(state, sessionId).turnCancelledTools)
  const turnCollapseOverrides = useChatStream(state => selectSessionStream(state, sessionId).turnCollapseOverrides)
  // Subagent lifecycle changes alter preventAutoCollapse, so the collapse
  // container consumes this version as well as the activity rows themselves.
  // The captured version must also join the turn-group memo deps below: the
  // subscription alone only re-renders, and a cached fold would keep the
  // open/close state computed before a late-settling child was released.
  const subagentsRevision = useSyncExternalStore(subscribeSubagents, subagentsVersion, () => 0)
  const compactionPendingTrigger = useChatStream(state => state.sessions[sessionId]?.compactionPendingTrigger ?? null)
  const hasLiveCompaction = useChatStream(state => (state.sessions[sessionId]?.liveUnits as LiveUnit[] | undefined)?.some(unit => unit.type === 'live-compaction') ?? false)
  // Worktree-init row: the live status wins while this session is alive; a
  // reload derives the settled row from the managed workdir (the engine never
  // persisted the record, so the workdir is the only durable evidence). The
  // row renders below the first user bubble (worktree-init semantics):
  // history draws the settled state after that bubble, live draws running or
  // failure next to the optimistic bubble that triggered the creation.
  const worktreeInitStatus = useChatStream(state => state.sessions[sessionId]?.worktreeInit?.status ?? null)
  const sessionWorkdir = (w().getKnownSessionInfo?.(sessionId)?.workdir as string | undefined) ?? null
  const worktreeRowStatus: 'running' | 'completed' | 'failed' | null = worktreeInitStatus
    ?? (isWorktreeSessionWorkdir(sessionWorkdir) ? 'completed' : null)
  // 每个思考块独立折叠（不再全局联动）：默认全折叠——刚收口的思考自动合上，
  // 点哪个只展开哪个。进行中的思考盒（LiveTail）不受此集合控制，天然展开。
  const [expandedThinkingKeys, setExpandedThinkingKeys] = useState<Set<string>>(() => new Set())
  const controller = transcriptScrollControllerFor(container)
  useEffect(() => retainSessionStream(sessionId), [sessionId])
  useEffect(() => retainSessionView(sessionId), [sessionId])

  useEffect(() => {
    // null = 首次拉；stale = 旧值继续展示、后台重拉（loadSessionHistory 自带
    // in-flight 去重，重入无害）。
    if (history === null || historyStale) void loadSessionHistory(sessionId)
  }, [history, historyStale, sessionId])

  // 工厂 HTML 内交互点（工具卡 toggle/复制/预览/fork 展开/消息级动作）：容器级原生委托。
  useEffect(() => {
    const handler = makeTranscriptClickHandler(readOnly ? '' : sessionId)
    const unbindImageMenu = bindImageContextMenu(container)
    const dblClick = makeTranscriptDblClickHandler(readOnly ? '' : sessionId)
    const mediaError = makeTranscriptMediaErrorHandler()
    container.addEventListener('click', handler)
    container.addEventListener('dblclick', dblClick)
    // img error 不冒泡，捕获阶段才能接到（React 合成事件无捕获 error 通道）。
    container.addEventListener('error', mediaError, true)
    // 挂监听前已失败的存量图（历史同步出图，error 早于 effect）扫一次：
    // complete 且 naturalWidth 为 0 即加载失败。正在加载的图不动，等 error 事件。
    container.querySelectorAll('img').forEach(img => {
      if (img.complete && img.naturalWidth === 0) markMediaBroken(img)
    })
    return () => {
      unbindImageMenu()
      container.removeEventListener('click', handler)
      container.removeEventListener('dblclick', dblClick)
      container.removeEventListener('error', mediaError, true)
    }
  }, [container, sessionId, readOnly])

  // Publish every settled turn's resources for the overview panel and the turn
  // navigation preview. The same projection the cards use, fed by the same
  // final reply and the same engine file-change record.
  useEffect(() => {
    if (readOnly) return
    const sync = () => {
      const stream = selectSessionStream(chatStreamStore.getState(), sessionId)
      if (stream.history === null && !stream.liveUnits.length) return
      const finals = new Map<string, string>()
      for (const message of stream.history ?? []) {
        if (!message?.turnId) continue
        const final = [...artifactUnitsForMessage(message)].reverse().find(unit => unit.type === 'text' && unit.isFinalReply && unit.segment?.text?.trim())
        if (final) finals.set(message.turnId, final.segment?.text ?? '')
      }
      for (const unit of stream.liveUnits) {
        if (unit.type !== 'live-text' || unit.streaming || !unit.turnId) continue
        if (unit.phase === 'final_answer' || unit.turnTail) finals.set(unit.turnId, unit.text)
      }
      const turns: TurnEndResources[] = []
      for (const [turnId, finalText] of finals) {
        const status = stream.turnStatuses[turnId] || (stream.running && stream.activeTurnId === turnId ? '' : stream.lastTerminalStatus && stream.liveTurnId === turnId ? stream.lastTerminalStatus : '')
        const editedPaths = artifactTurn(contextId, turnId)?.files.map(file => file.path) ?? []
        const resources = turnEndResources({ sessionId: contextId, status, finalText, editedPaths })
        if (resources.length) turns.push({ turnId, resources })
      }
      publishEndResources(contextId, turns)
    }
    sync()
    const stopStream = chatStreamStore.subscribe(sync)
    const stopArtifacts = subscribeArtifacts(sync)
    return () => { stopStream(); stopArtifacts() }
  }, [sessionId, contextId, readOnly])

  const keyedHistory = useMemo(() => (history || []).map((msg, index) => msg.uuid ? msg : { ...msg, uuid: `i-${index}` }), [history])
  const artifactAnchors = useMemo(() => turnArtifactAnchors(keyedHistory), [keyedHistory])
  // Compaction changes model context, while the transcript remains continuous.
  // Page over the complete saved projection so scrolling crosses every boundary.
  const visible = keyedHistory
  // Pending compaction belongs after the current live output, not above it in history.
  const start = transcriptPageStart(visible, 0)
  // A saved summary and live middle answers share one ordered projection. The
  // same UUID still owns its section when saved history takes over that answer.
  const orderedHistory = useMemo(() => {
    const rows = visible.slice(start)
    const turns = new Set(rows.map(message => message.turnId).filter(Boolean))
    return mergeSubmittedUserHistory(rows, liveAnswers.filter(unit => unit.turnId && turns.has(unit.turnId)), [])
  }, [visible, start, liveAnswers])
  const timestamped = useMemo(() => applyTurnTimestamps(orderedHistory, turnStartedAtMs, turnFinishedAtMs), [orderedHistory, turnStartedAtMs, turnFinishedAtMs])
  // Legacy creations recorded their creator on the thread, before per-message
  // display metadata existed. Only the real beginning can identify that input;
  // the first row of a bounded recent page might be a later coordination message.
  const legacyCreator = !savedTranscript || savedTranscript.islands[0]?.olderBoundary.status === 'exhausted'
    ? w().getKnownSessionInfo?.(sessionId)?.hostMetadata?.delegatedFrom : undefined
  const historyUnits = useMemo(() => unitsFromMessages(timestamped, legacyCreator), [timestamped, legacyCreator])
  const goalCompletionByTurn = useTranscriptGoalCompletions(sessionId, keyedHistory)
  const friendReplyBoundaries = useMemo(() => new Set((savedTranscript?.islands.slice(1) ?? [])
    .filter(island => island.olderBoundary.status === 'available' && island.olderBoundary.boundaryId)
    .flatMap(island => {
      const turn = savedTranscript?.entitiesByKey[island.entries[0]?.value]?.id
      return turn ? [turn] : []
    })), [savedTranscript])
  const foldedTurnGroups = useMemo(() => foldTurnGroups(historyUnits, running && activeTurnId ? { turnId: activeTurnId } : null, turnStatuses, turnCollapseOverrides, turnErrors, turnDurations, turnCancelledTools, livePlanReviewIds, turnErrorKinds, worktreeRowStatus !== 'running' ? worktreeRowStatus : null, artifactAnchors, turnErrorDetails, turnStartedAtMs, shellTurnIds, turnWorkCompletedAtMs, goalCompletionByTurn, friendReplyBoundaries),
    [historyUnits, running, activeTurnId, turnStatuses, turnCollapseOverrides, turnErrors, turnDurations, turnCancelledTools, livePlanReviewIds, turnErrorKinds, worktreeRowStatus, artifactAnchors, turnErrorDetails, turnStartedAtMs, subagentsRevision, shellTurnIds, turnWorkCompletedAtMs, goalCompletionByTurn, friendReplyBoundaries])
  const turnGroups = useMemo(() => {
    const groups = [...foldedTurnGroups]
    for (const island of savedTranscript?.islands ?? []) {
      const boundary = island.olderBoundary
      if (boundary.status !== 'available' || !boundary.boundaryId) continue
      const firstTurn = savedTranscript?.entitiesByKey[island.entries[0]?.value]?.id
      const index = groups.findIndex(group => group.turnId === firstTurn)
      if (index < 0) continue
      const request: TurnBoundaryRequest = { ...boundary, boundaryId: boundary.boundaryId,
        islandId: island.id, edge: 'older', generation: savedTranscript!.generation }
      const key = `history-gap:${boundary.boundaryId}`
      groups.splice(index, 0, { key, nodes: [{ kind: 'history-gap', key, request }] })
    }
    return groups
  }, [foldedTurnGroups, savedTranscript])
  const editTarget = useMemo(() => editTargetFor(historyUnits, liveEditUser ? [liveEditUser] : []), [historyUnits, liveEditUser])
  const [loadingVisible, setLoadingVisible] = useState(false)
  const nothingToRender = history === null && historyLoading && liveUnitCount === 0
  useEffect(() => {
    if (!nothingToRender) { setLoadingVisible(false); return }
    const timer = setTimeout(() => setLoadingVisible(true), 400)
    return () => clearTimeout(timer)
  }, [nothingToRender])
  const showHistorySkeleton = nothingToRender && loadingVisible

  // history 未加载不挡 live 层：新会话首条消息就是这个状态（会话刚 promote 出来，
  // 历史层还没有值），本回合的乐观气泡与流式回复必须照样上屏。把整棵树 return
  // null 掉，首发就只能靠「抢先拉一次 history」把画面撑起来，而那份 history 已经
  // 含本回合，正是同一条消息画两遍的来源。

  // Paging is owned by the surface controller; prepends retain the bottom distance.
  const pageState = useRef({ historyLoadFailed, count: visible.length })
  pageState.current = { historyLoadFailed, count: visible.length }
  useLayoutEffect(() => {
    if (!controller || scroll === 'none') return
    return controller.setOlderHistoryLoader(container, async () => {
      if (pageState.current.historyLoadFailed) return 'stop'
      const currentSessionId = sessionIdRef.current
      const pagination = chatStreamStore.getState().sessions[currentSessionId]?.turnsPagination
      if (!pagination || pagination.hasLoadedOldest || pagination.isLoadingOlder) return 'stop'
      const before = pageState.current.count
      const outcome = await loadOlderHistoryPage(currentSessionId)
      if (outcome === 'stop') return 'stop'
      // The next loop reads committed geometry, after React has inserted the page.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      return pageState.current.count === before ? 'stop' : 'continue'
    }, !historyLoadFailed)
  }, [controller, container, sessionId, scroll, historyLoadFailed])

  const toggleThinking = (key: string) => {
    setExpandedThinkingKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Requests whose decision card renders under their own message row; the
  // conversation-end card keeps only the ones no message carries (a legacy row
  // or a park that never produced one).
  const inlineApprovalRequests = new Set<string>()
  // The same friend arrival is visible twice after approval: the parked request
  // row and the task-delivery turn carry the same requestId, one marked as the
  // request and the other as the running task. Keep the turn row and hide the
  // parked row once the delivery exists.
  const supersededRequestIds = new Set<string>()
  const friendRequestIds = new Set<string>()
  for (const unit of [...historyUnits, ...selectSessionStream(chatStreamStore.getState(), sessionId).liveUnits]) {
    const local = (unit as any)?.msg?.localRender
    if (local?.externalFriendMessage !== true || typeof local?.requestId !== 'string') continue
    if (isIncomingFriendRequest(local)) { inlineApprovalRequests.add(local.requestId); friendRequestIds.add(local.requestId) }
    else if (friendRequestIds.has(local.requestId)) supersededRequestIds.add(local.requestId)
  }

  const unitProps = {
    isThinkingExpanded: (key: string) => expandedThinkingKeys.has(key),
    onToggleThinking: toggleThinking,
    archived: !!w().getKnownSessionInfo?.(sessionId)?.archived,
    running,
    composerAuthored: !readOnly,
    readOnly,
    streamSessionId: sessionId,
    questionSource: scroll === 'simple' ? container : undefined,
    questionComposer: readOnly ? null : scroll === 'main' ? document.getElementById('question-composer-slot') : scroll === 'simple' ? document.getElementById('side-question-composer-slot') : null,
    sessionId: contextId,
    editTarget,
    supersededFriendRequestIds: supersededRequestIds,
  }

  const renderNode = (node: RenderNode) => node.kind === 'history-gap'
    ? <SavedHistoryGap key={node.key} sessionId={sessionId} request={node.request} />
    : node.kind === 'activity-fold'
    ? <ActivityFold node={node} key={node.key} {...unitProps} sessionId={contextId}
        onToggle={() => setTurnCollapsed(sessionId, node.foldKey, node.open)} />
    : node.kind === 'turn-fold'
      ? <TurnFold node={node} key={node.key} unitProps={unitProps} sessionId={contextId}
          onToggleFold={(foldKey, open) => setTurnCollapsed(sessionId, foldKey, open)} />
    : node.kind === 'turn-media'
      ? <TurnMediaBlock paths={node.paths} sessionId={contextId} key={node.key} />
    : node.kind === 'turn-visuals'
      ? <VisualArtifactsBlock sessionId={contextId} artifacts={node.artifacts} key={node.key} />
      : node.kind === 'turn-changes'
        ? readOnly ? null : <TurnChangesBlock sessionId={contextId} turnId={node.turnId} status={node.status} finalText={node.finalText} key={node.key} />
        : node.kind === 'turn-agents'
          ? <TurnAgentRows key={node.key} tools={node.tools} sessionId={contextId} turnInterrupted={node.turnInterrupted} turnId={node.turnId} />
        : node.kind === 'worktree-init'
          ? <WorktreeInitEvent status={node.status} key={node.key} />
          : node.kind === 'work-divider'
            ? <TurnWorkDivider startedAtMs={node.startedAtMs} completedAtMs={node.completedAtMs} key={node.key} />
            : <UnitView unit={node.unit} key={node.unit.key} {...unitProps} />

  return (
    <AgentEntranceProvider units={[...historyUnits, ...selectSessionStream(chatStreamStore.getState(), sessionId).liveUnits]} readOnly={readOnly}>
      {scroll === 'main' ? <BranchBanner sessionId={sessionId} /> : null}
      {showHistorySkeleton ? <TranscriptHistorySkeleton label={t('loading')} /> : null}
      {!showHistorySkeleton && historyLoadFailed ? (
        <div className={`${styles['transcript-load-failed']}`} role="alert">
          <span className={`${styles['transcript-load-failed-text']}`}>{t('transcript_history_load_failed')}</span>
          <button className={`${styles['transcript-load-failed-retry']}`} type="button"
            onClick={() => { void retryHistoryLoad(sessionId) }}>
            {t('transcript_history_load_retry')}
          </button>
        </div>
      ) : null}
      <LiveTail sessionId={sessionId} unitProps={unitProps} scroll={scroll} container={container}
        timeline={{ groups: turnGroups, controller: scroll !== 'none' ? controller : null, renderNode }} />
      {!readOnly && <FriendTaskApproval sessionId={sessionId} skipPending={inlineApprovalRequests} />}
      {!readOnly && <AsyncQuestionComposer sessionId={sessionId} composer={unitProps.questionComposer} source={container} />}
      {compactionPendingTrigger && !hasLiveCompaction ? <CompactionEvent loading trigger={compactionPendingTrigger} /> : null}
      {quoteSurface ? <QuoteSelectionToolbar container={container} surface={quoteSurface} /> : null}
    </AgentEntranceProvider>
  )
}

// A forked conversation opens looking exactly like its source: same inherited
// history, same title. The transcript answers that with a one-line "Thread forked from
// <name>" banner at the top of the fork. The source title is read from the sidebar ledger, which the fork
// action refreshes right after switching, and re-reads whenever the ledger
// changes so a late list refresh still fills the banner in.
export function BranchBanner({ sessionId }: { sessionId: string }) {
  const t = useT()
  const [, forceRead] = useState(0)
  useEffect(() => {
    const refresh = () => forceRead(value => value + 1)
    window.addEventListener('klaus:sessions-list-updated', refresh)
    return () => window.removeEventListener('klaus:sessions-list-updated', refresh)
  }, [])
  const source = w().getKnownSessionInfo?.(sessionId)?.forkedFrom
  const sourceId = typeof source?.sessionId === 'string' ? source.sessionId : ''
  if (!sourceId || sourceId === sessionId) return null
  const sourceTitle = String(source?.title || '').trim()
  const label = sourceTitle
    ? t('session_branch_banner').replace('{title}', sourceTitle)
    : t('session_branch_badge')
  return (
    <button className={styles['branch-banner']} type="button" aria-label={label}
      onClick={() => { void w().klausSwitchSession?.(sourceId) }}>
      <Icon name="session-branch" size={14} />
      <span className={styles['branch-banner-label']}>{label}</span>
    </button>
  )
}

function TranscriptHistorySkeleton({ label }: { label: string }) {
  return <div className="transcript-skeleton" role="status" aria-label={label}>
    <div className="sk-row user"><div className="sk-block sk-bubble" style={{ width: '42%' }} /></div>
    <div className="sk-row"><div className="sk-block" style={{ width: '76%' }} /></div>
    <div className="sk-row"><div className="sk-block" style={{ width: '58%' }} /></div>
    <div className="sk-row user"><div className="sk-block sk-bubble" style={{ width: '34%' }} /></div>
    <div className="sk-row"><div className="sk-block" style={{ width: '68%' }} /></div>
  </div>
}

// ==================== live 回合尾巴 ====================
// liveUnits 序列渲染（本回合在途单元流）+ 思考盒 + turn-activity 三点脉冲。
// 与旧 chatEvent 管线的 DOM 输出对齐：流式 text 带 .streaming + 三点、
// 工具卡 live 态（running→done/error、progress/输出区）、notice/error/file/
// plan/diff 卡、channel user 气泡。

function liveActivityTool(card: ToolCardState): SegmentTool {
  return {
    toolName: card.toolName,
    toolCallId: card.toolCallId,
    args: card.args,
    state: card.status === 'error' ? 'error' : card.status === 'ok' ? 'done' : card.status === 'interrupted' ? 'interrupted' : 'running',
    output: null,
    agent: true,
    activityKind: subagentActivityKind(card.toolName),
  }
}

function liveToolData(card: ToolCardState, sessionId = ''): ActivityToolData {
  return { ...card, sessionId, state: card.status === 'ok' ? 'done' : card.status,
    output: card.content ?? card.progress.map(part => String(part ?? '')).join('') }
}

export function LiveToolCard({ card, suppressFigurePaths, sessionId = '', stateSessionId = sessionId, open, onToggle, suppressDelegations = false, readOnly }: {
  card: ToolCardState
  readOnly?: boolean
  suppressFigurePaths?: ReadonlySet<string>
  sessionId?: string
  stateSessionId?: string
  open: boolean
  onToggle: () => void
  suppressDelegations?: boolean
}) {
  const parentAgentId = useChatStream(state => selectSubagentParentId(state, stateSessionId))
  const data = { ...liveToolData(card, sessionId), parentAgentId }
  const media = (activityToolPresentation(data).kind === 'image' ? [] : card.media || []).filter(item => !suppressFigurePaths?.has(item.path)).map((item) => ({
    path: item.path,
    src: mediaUrl(item.path, sessionId),
    name: basenameFromPath(item.path) || 'image',
  })).filter(item => item.src)
  return (
    <>
      <ActivityTool tool={data} open={open} onToggle={onToggle} suppressDelegations={suppressDelegations} readOnly={readOnly} />
      {media.length ? (
        <div className={styles['media-figures']}>
          {media.map((item, index) => (
            <button className={styles['media-figure']} type="button" aria-label={item.name} data-media-figure="1" data-media-path={item.path} data-media-session={sessionId} key={`${item.path}:${index}`}>
              <img src={item.src} alt={item.name} loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}

function LiveTools({ unit, tools, figurePaths, sessionId, stateSessionId, turnInterrupted, expandedToolIds, onToggleTool, readOnly }: {
  readOnly?: boolean
  unit: Extract<LiveUnit, { type: 'live-tools' }>
  tools: Record<string, ToolCardState>
  /** Every path the turn-end media block is about to render, so the cards yield. */
  figurePaths: ReadonlySet<string>
  sessionId: string
  stateSessionId?: string
  turnInterrupted: boolean
  expandedToolIds: ReadonlySet<string>
  onToggleTool: (toolCallId: string) => void
}) {
  const chunks: ReactNode[] = []
  let cards: ToolCardState[] = []
  let activities: SegmentTool[] = []
  const flushCards = () => {
    if (!cards.length) return
    const batch = cards
    chunks.push(
      <div className={styles['tool-container']} key={`tools-${batch[0].toolCallId}`}>
        {batch.map(card => (
          <LiveToolCard card={card} suppressFigurePaths={figurePaths} sessionId={sessionId} stateSessionId={stateSessionId} readOnly={readOnly}
            suppressDelegations open={expandedToolIds.has(card.toolCallId)} onToggle={() => onToggleTool(card.toolCallId)}
            key={card.toolCallId} />
        ))}
      </div>,
    )
    cards = []
  }
  const flushActivities = () => {
    if (activities.length === 0) return
    chunks.push(<TurnAgentRows tools={activities} sessionId={sessionId} turnInterrupted={turnInterrupted} turnId={unit.turnId} key={`agents-${activities[0].toolCallId}`} />)
    activities = []
  }
  for (const id of unit.order) {
    const card = tools[id]
    if (!card) continue
    if (subagentActivityKind(card.toolName)) {
      flushCards()
      activities.push(liveActivityTool(card))
    } else {
      flushActivities()
      cards.push(card)
    }
  }
  flushCards()
  flushActivities()
  return <>{chunks}</>
}

/**
 * Capacity retry: when the provider said how long to wait, the turn
 * failure offers a countdown that resubmits on its own, plus a manual retry.
 * Both reuse the composer's Continue path (an empty-input new turn), which is
 * exactly what the user does by hand today.
 */
function OverloadRetryRow({ sessionId, retryAfterMs }: { sessionId: string; retryAfterMs: number }) {
  const t = useT()
  const deadline = useRef(Date.now() + Math.max(1000, retryAfterMs))
  const [remaining, setRemaining] = useState(() => Math.ceil((deadline.current - Date.now()) / 1000))
  const [fired, setFired] = useState(false)
  useEffect(() => {
    if (fired) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000))
      setRemaining(left)
      if (left <= 0) {
        setFired(true)
        void w().klaus?.chat?.continueTurn?.(sessionId)
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [fired, sessionId])
  const retry = () => {
    if (fired) return
    setFired(true)
    void w().klaus?.chat?.continueTurn?.(sessionId)
  }
  return (
    <div className={styles['overload-retry-row']}>
      <span className={styles['overload-retry-count']}>
        <RawHtml tag="span" html={rawIconHtml('tool-clock')} />
        {fired ? t('overload_retry_firing') : t('overload_retry_countdown').replace('{seconds}', String(remaining))}
      </span>
      <button type="button" className={styles['overload-retry-btn']} disabled={fired} onClick={retry}>
        <RawHtml tag="span" html={rawIconHtml('refresh')} />
        {t('overload_retry_now')}
      </button>
    </div>
  )
}

function LiveDelegationView({ delegation }: { delegation: DelegationEnvelope }) {
  useDeviceNamesVersion()
  return <RawHtml className={`msg-group user delegation ${styles['external-sender-row']}`} data-external-sender="true"
    html={renderAgentSenderAvatarHtml()
      + `<div class="${styles['user-row-main']}">`
      + renderDelegationLabelParsedHtml(delegation.sourceHostId, delegation.sourceThreadId)
      + renderDelegationBubbleHtml(delegation.input) + '</div>'} />
}

function LiveTextView({ unit, sessionId, unitProps, mediaPaths, mediaAliases, isLastText, endResourceTurn }: {
  unit: Extract<LiveUnit, { type: 'live-text' }>
  sessionId: string
  unitProps: UnitProps
  mediaPaths: ReadonlySet<string>
  mediaAliases?: ReadonlyMap<string, string>
  isLastText: boolean
  endResourceTurn?: { turnId: string; status: string } | null
}) {
  // Resolve tool-generated media before rendering the last live answer.
  const resolved = isLastText && mediaPaths.size > 0 ? resolveRelativeImagePaths(unit.text, mediaPaths, mediaAliases) : unit.text
  const source = isLastText || mediaPaths.size === 0 ? resolved : stripMarkdownImagesForPaths(unit.text, mediaPaths)
  const { projected, present } = useTurnEndResources(sessionId, isLastText && !unit.streaming && !unitProps.readOnly ? endResourceTurn : null, source)
  const display = useMemo(() => stripEndResourceLinkLines(source, endResourceFilePaths(present), sessionWorkdirOf(sessionId)), [source, present, sessionId])
  const markdown = useAsyncMarkdownHtml(display, unitProps.sessionId || sessionId, unit.key, unit.streaming)
  const html = unit.streaming
    ? `${stripInlineVisLines(markdown)}<span class="streaming-dots"><span></span><span></span><span></span></span>`
    : inlineVisPostProcess(markdown)
  const actionsHtml = unit.turnTail && !unit.streaming
    ? renderMsgActionsHtml({
        ts: unit.turnTail.ts, copyText: source, kind: 'assistant',
        archived: unitProps.archived, running: unitProps.running, readOnly: unitProps.readOnly,
        extraHtml: unit.turnTail.meta ? renderTurnUsageMetaHtml(unit.turnTail.meta) : '',
        goalCompletion: unit.goalCompletion,
      })
    : ''
  const bubbleHtml = `<div class="msg assistant${unit.streaming ? ' streaming' : ''}${unit.aborted ? ' ' + styles['aborted'] : ''}"${isLastText ? ' data-nav-answer="true"' : ''} data-md="${escapeHtml(source)}">${html}</div>${actionsHtml}`
  const bubble = projected.length ? <InlineVisualizationHtml className="msg-group assistant" html={bubbleHtml} fragments={unit.streaming ? [] : unit.inlineVis ?? []} sessionId={sessionId}
    message={{ html, markdown: source, answer: isLastText, className: `msg assistant${unit.streaming ? ' streaming' : ''}${unit.aborted ? ' ' + styles['aborted'] : ''}`, actionsHtml }}
    afterContent={present.length ? <EndResourceCards resources={present} sessionId={sessionId} /> : undefined}
    onOpenExternal={url => w().klaus?.app?.openExternal?.(url)} /> : unit.streaming
    ? <StreamingHtml className="msg-group assistant" html={bubbleHtml} />
    : <InlineVisualizationHtml className="msg-group assistant" html={bubbleHtml} fragments={unit.inlineVis ?? []} sessionId={sessionId}
        onOpenExternal={url => w().klaus?.app?.openExternal?.(url)} />
  return unit.friendFollowUp ? <FriendFollowUp text={source} streaming={unit.streaming}>{bubble}</FriendFollowUp> : bubble
}

function LiveUnitView({ unit, tools, sessionId, unitProps, mediaPaths, mediaAliases, figurePaths, isLastText, endResourceTurn, turnInterrupted, expandedToolIds, onToggleTool }: {
  unit: LiveUnit
  tools: Record<string, ToolCardState>
  sessionId: string
  unitProps: UnitProps
  // 本回合工具已产出的图路径：中间 live-text 去重，且供末段相对路径嵌图解析
  // （见下方 live-text 分支）。出图面本身是 LiveTail 末尾的 TurnMediaBlock。
  mediaPaths: ReadonlySet<string>
  mediaAliases?: ReadonlyMap<string, string>
  // 已在别处呈现的图：工具卡不再重复出（见 LiveTools）。
  figurePaths: ReadonlySet<string>
  isLastText: boolean
  endResourceTurn?: { turnId: string; status: string } | null
  // The live Turn ended because the user stopped it; subagent rows must settle.
  turnInterrupted: boolean
  expandedToolIds: ReadonlySet<string>
  onToggleTool: (toolCallId: string) => void
}) {
  const t = useT()
  if (unit.type === 'live-approval-review-notice') return <ApprovalReviewNotice kind={unit.kind} />
  if (unit.type === 'live-approval-review') return <ApprovalReviewCard review={unit.review} />
  if (unit.type === 'live-goal-completion') return null
  if (unit.type === 'live-planning-question') return <PlanningQuestionView request={unit.request} readOnly={unitProps.readOnly} />
  if (unit.type === 'live-proposed-plan') return <ProposedPlanView plan={unit.plan} sessionId={sessionId} />
  if (unit.type === 'live-delegation') return <LiveDelegationView delegation={unit.delegation} />
  if (unit.type === 'live-agent-event') return <AgentLifecycleRow event={unit} events={unit.agentEvents} turnId={unit.turnId} laterAgentIds={unit.laterAgentIds} />
  if (unit.type === 'live-compaction') return <CompactionEvent loading={unit.state === 'running'} trigger={unit.trigger} />
  if (unit.type === 'live-permission') {
    return <PermissionCard req={unit.req} startedAt={unit.startedAt} resolved={unit.resolved} sessionId={sessionId} />
  }
  if (unit.type === 'live-plan-review') {
    return <PlanReviewCard req={unit.req} startedAt={unit.startedAt} resolved={unit.resolved} sessionId={sessionId} />
  }
  if (unit.type === 'live-execution-mode') {
    return <ExecutionModeCard req={unit.req} startedAt={unit.startedAt} resolved={unit.resolved} sessionId={sessionId} />
  }
  if (unit.type === 'live-elicit') {
    return <ElicitCard req={unit.req} resolved={unit.resolved} sessionId={sessionId} />
  }
  if (unit.type === 'live-ask') {
    if (unit.req.responseChannel === 'async-question') return <AsyncQuestionText request={unit.req} sessionId={sessionId} readOnly={unitProps.readOnly} />
    return <AskUserQuestionCard req={unit.req} resolved={unit.resolved} sessionId={sessionId} composer={unitProps.questionComposer} source={unitProps.questionSource} />
  }
  if (unit.type === 'live-auth') {
    return <AuthRequiredCard reason={unit.reason} mode={unit.mode} />
  }
  if (unit.type === 'live-user') {
    // 与历史 user 同分流（fork/teammate/task-notification/interrupt）。
    //
    // The turn id lives on the live unit, not on the message it wraps: the optimistic
    // bubble is created by `ingestLocalUserTurn` before the engine has named the turn, and
    // `patchSession` stamps the id onto every unit once `stream_mode` reports it. The
    // re-projection only reads `unit.msg`, so without carrying the id across, a stopped
    // turn's bubble renders with no turn handle at all — which is exactly the bubble Edit
    // needs it for, since the engine never reports that message's uuid.
    const derived = liveUserRenderUnits(unit)
    return (
      <>
        {derived.map((u, index) => {
          // A saved uuid can replace the optimistic one without changing the row.
          const key = `${unit.key}:${u.type}:${index}`
          return <UnitView unit={{ ...u, key }} key={key} {...unitProps} />
        })}
      </>
    )
  }
  if (unit.type === 'live-text') return <LiveTextView unit={unit} sessionId={sessionId} unitProps={unitProps}
    mediaPaths={mediaPaths} mediaAliases={mediaAliases} isLastText={isLastText} endResourceTurn={endResourceTurn} />
  if (unit.type === 'live-turn-status') {
    return <TurnTerminalStatus startedAt={unit.startedAt} finishedAt={unit.finishedAt} />
  }
  if (unit.type === 'live-tools') {
    // 出图面是回合末尾那个恒可见区块（LiveTail 的 TurnMediaBlock），卡片里再出一遍
    // 就是同一张图两处，且卡片这处会随回合折叠消失——正是「生成成功却看不到图」的
    // 根因。所以这里让位给区块，与历史层 foldUnits 的 suppressFigurePaths 同规则。
    return <LiveTools unit={unit} tools={tools} figurePaths={figurePaths} sessionId={sessionId} stateSessionId={unitProps.streamSessionId} turnInterrupted={turnInterrupted}
      expandedToolIds={expandedToolIds} onToggleTool={onToggleTool} readOnly={unitProps.readOnly} />
  }
  if (unit.type === 'live-thinking-done') {
    return (
      <div className={`thinking-done${unitProps.isThinkingExpanded(unit.key) ? ' open' : ''}`}>
        <RawHtml className={`${styles['thinking-toggle']}`} onClick={() => unitProps.onToggleThinking(unit.key)}
          html={`<span><span data-i18n="thought_for">${t('thought_for') || 'Thought for '}</span>${unit.elapsedSeconds}s</span>${rawIconHtml('chevron-right', { cls: styles['thinking-chevron'] })}`} />
        <RawHtml className={`${styles['thinking-detail']}`} html={formatThinkingHtml(unit.text)} />
      </div>
    )
  }
  if (unit.type === 'live-notice') {
    const key = noticeI18nKey(unit.code)
    const text = key ? t(key) || unit.text : unit.text
    const multiline = text.includes('\n')
    return (
      <div className={`msg-group ${styles['notice']}${multiline ? ' multiline' : ''}`}>
        <div className={`msg ${styles['notice']}${multiline ? ' multiline' : ''}`}>{text}</div>
      </div>
    )
  }
  if (unit.type === 'live-retry') {
    // Retry budgets remain in the stream; the status row only shows the phase.
    const waiting = unit.phase === 'networkWait'
    const text = waiting
      ? t('reconnect_waiting_for_network')
      : t('reconnect_prefix').trim()
    return (
      <div className={`msg-group ${styles['reconnect-row']}`}>
        <span className={styles['reconnect-icon']} aria-hidden="true">
          <RawHtml tag="span" html={rawIconHtml('wifi')} />
        </span>
        <span className={styles['reconnect-text']}>{text}</span>
      </div>
    )
  }
  if (unit.type === 'live-congestion') {
    const key = unit.kind === 'rate_limit' ? 'provider_rate_limit' : 'provider_overloaded'
    return (
      <div className={`msg-group ${styles['notice']}`}>
        <div className={`msg ${styles['notice']}`}>{t(key)}</div>
      </div>
    )
  }
  if (unit.type === 'live-error') {
    const recovery = unit.submissionUuid ? pendingSubmissionRecovery(unit.submissionUuid) : undefined
    const overload = (unit.kind === 'rate_limit' || unit.kind === 'overloaded') && typeof unit.retryAfterMs === 'number'
    return (
      <TranscriptErrorNotice text={providerErrorText(unit.text, unit.kind, t, unit.errorDetails) || t('chat_error_generic')}>
        {overload ? <OverloadRetryRow sessionId={sessionId} retryAfterMs={unit.retryAfterMs as number} /> : null}
        {recovery ? <div className={styles['overload-retry-row']}><button type="button" className={styles['overload-retry-btn']}
          data-submission-recovery={recovery.action} onClick={recovery.run}>{t(recovery.action === 'back' ? 'submission_go_back' : recovery.action === 'retry' ? 'submission_retry' : 'submission_dismiss')}</button></div> : null}
      </TranscriptErrorNotice>
    )
  }
  if (unit.type === 'live-file') {
    const ext = (unit.name.split('.').pop() || '').toLowerCase()
    const FILE_EXT_LABELS: Record<string, string> = { pdf: 'PDF', json: 'JSON', zip: 'ZIP', gz: 'GZ', txt: 'TXT', csv: 'CSV', md: 'MD', html: 'HTML', png: 'PNG', jpg: 'JPG', jpeg: 'JPG', gif: 'GIF', webp: 'WEBP', svg: 'SVG', mp3: 'MP3', wav: 'WAV', mp4: 'MP4', py: 'PY', ts: 'TS', js: 'JS', sh: 'SH' }
    const label = FILE_EXT_LABELS[ext] || ext.toUpperCase() || 'FILE'
    return (
      <RawHtml className="msg-group assistant"
        html={`<div class="file-card"><div class="${styles['file-card-icon']}">${escapeHtml(label)}</div><div class="${styles['file-card-info']}"><div class="${styles['file-card-name']}">${escapeHtml(unit.name)}</div><div class="${styles['file-card-hint']}">${t('file_ready')}</div></div><a class="${styles['file-card-dl']}" href="${escapeHtml(unit.url)}" download="${escapeHtml(unit.name)}">${t('download')}</a></div>`} />
    )
  }
  return null
}

type LiveActivityNodeValue =
  | { kind: 'unit'; key: string; unit: LiveUnit }
  | { kind: 'workflow-record'; key: string; record: WorkflowRecord }
  | { kind: 'worktree-init'; key: string; status: 'running' | 'completed' | 'failed' }
  | { kind: 'activity'; key: string; units: LiveUnit[]; summary: ActivitySummary; mode: 'summary' | 'active' | 'thinking'; activeAction?: ActivityAction }
  | { kind: 'work-divider'; key: string; startedAtMs: number | null; completedAtMs?: number | null }
  | { kind: 'turn'; key: string; items: LiveActivityNode[]; persistent: LiveActivityNode[]; messageCount: number; preventAutoCollapse: boolean; running: boolean; startedAtMs: number | null; completedAtMs: number | null }

type LiveActivityNode = LiveActivityNodeValue & { turnId?: string }

function isFinalLiveText(unit: LiveUnit, final: Extract<LiveUnit, { type: 'live-text' }> | null): boolean {
  // A projected answer may add footer metadata while retaining its source identity.
  return unit.type === 'live-text' && final !== null && unit.key === final.key && unit.turnId === final.turnId
}

export function liveActivityEntries(liveUnits: LiveUnit[], tools: Record<string, ToolCardState>, recordedWorkflowIds: Set<string>): ActivityEntry<LiveUnit>[] {
  const visibleUnits = liveUnits.flatMap<LiveUnit>(unit => {
    if (unit.type === 'live-agent-event' && unit.status === 'started'
      && subagentActivityKind(tools[unit.taskId]?.toolName || '')
      && ['running', 'awaiting-approval'].includes(tools[unit.taskId].status)) return []
    if (unit.type !== 'live-tools') return [unit]
    const order = unit.order.filter(id => tools[id] && !isHiddenAgentMessageTool(liveToolData(tools[id])))
    return order.length ? [{ ...unit, order }] : []
  })
  // A settled spawn call whose child already reports inline lifecycle rows is
  // the same child twice, so the spawn entry is dropped once its receivers have
  // inline activity.
  const notified = new Set(liveUnits.filter((unit): unit is Extract<LiveUnit, { type: 'live-agent-event' }> => unit.type === 'live-agent-event').map(unit => unit.taskId))
  return groupAdjacentAgentEvents(visibleUnits).flatMap((unit): ActivityEntry<LiveUnit>[] => {
    if (unit.type === 'live-text' && !unit.text.trim()) return []
    if (unit.type !== 'live-tools') return [{
      key: unit.key, value: unit,
      grouping: unit.type === 'live-thinking-done' ? 'reasoning' : 'standalone',
    }]
    return unit.order.flatMap(id => {
      const card = tools[id]
      if (!card) return []
      // Same rule as the history projection: the pet pill consumes this call,
      // the live transcript never shows its row.
      if (isPetPillOnlyTool(card.toolName)) return []
      if (isQuestionTool(card.toolName) && liveUnits.some(row => row.type === 'live-ask' && row.req.toolCallId === id || row.type === 'live-planning-question' && row.request.toolCallId === id)) return []
      const delegations: ActivityEntry<LiveUnit>[] = (delegatedToolOutput(liveToolData(card))?.delegations || [])
        .map((delegation, index) => ({
          key: `delegation:${id}:${index}`,
          value: { type: 'live-delegation', key: `delegation:${id}:${index}`, turnId: unit.turnId, delegation },
          grouping: 'standalone',
        }))
      if (subagentActivityKind(card.toolName) && notified.has(id) && card.status !== 'running' && card.status !== 'awaiting-approval') return delegations
      const record = workflowRecordFromTool({ ...card, state: card.status })
      if (record) {
        if (record.kind === 'goal-completed') return delegations
        if (recordedWorkflowIds.has(id)) return delegations
        recordedWorkflowIds.add(id)
      }
      return [{
        key: id, value: { ...unit, key: `tool:${id}`, order: [id] },
        grouping: record || subagentActivityKind(card.toolName) || isAgentActionToolName(card.toolName) || card.status === 'awaiting-approval' ? 'standalone' : 'tool',
        action: describeActivity(card.toolName, card.args, card.status, card.content, card.media),
      }, ...delegations]
    })
  })
}

function projectLiveTurn(
  liveUnits: LiveUnit[], tools: Record<string, ToolCardState>, running: boolean,
  _thinkingActive: boolean, interrupted: boolean, recordedWorkflowIds: Set<string>,
  worktreeInit: 'running' | 'completed' | 'failed' | null = null,
  startedAtMs: number | null = null,
  recordedCompletedAtMs: number | null = null,
  terminal = false,
  goalCompletionByTurn: ReadonlyMap<string, GoalCompletionSummary> = new Map(),
): LiveActivityNode[] {
  liveUnits = attachFriendFollowUps(liveUnits)
  // Coalesce display rows per turn without changing the stored retry events.
  // Keep the network-wait explanation even if another retry budget follows it.
  const retries = liveUnits.filter(unit => unit.type === 'live-retry')
  const reconnect = retries.find(unit => unit.phase === 'networkWait') || retries.at(-1)
  let reconnectShown = false
  liveUnits = liveUnits.flatMap<LiveUnit>(unit => {
    if (unit.type !== 'live-retry') return [unit]
    if (reconnectShown || !reconnect) return []
    reconnectShown = true
    return [{ ...reconnect, key: unit.key }]
  })
  // The explicit markers (turnTail / final_answer) are the engine's word on the
  // final reply. A turn that already received its terminal event but whose
  // markers never landed (a steered delivery can race the terminal item update)
  // must not stay unfolded forever: like the saved-history projection, fall back
  // to the turn's closing text once the turn is no longer the streaming tail.
  // The fallback only reads the LAST conversation unit: an unmarked mid-turn
  // commentary followed by more work is process evidence, not a final reply.
  // A still-streaming tail keeps its open process.
  const closingText = [...liveUnits].reverse().find(unit => unit.type !== 'live-agent-event')
  const final = [...liveUnits].reverse().find(unit => unit.type === 'live-text'
    && (unit.turnTail || unit.phase === 'final_answer' && unit.text.trim()))
    || (!running && closingText?.type === 'live-text' && !closingText.phase
      && closingText.text.trim() ? closingText : undefined)
  const before: LiveUnit[] = []
  const after: LiveUnit[] = []
  const leading: LiveActivityNode[] = []
  let pastFinal = false
  for (const unit of liveUnits) {
    if (unit === final) { pastFinal = true; continue }
    if (unit.type === 'live-user' && unit.msg.localRender?.delegationKind === 'initial-input') {
      leading.push({ kind: 'unit', key: unit.key, unit })
      continue
    }
    // Late child notices stay with the turn's activity region, ahead of the
    // final answer, matching the static path.
    ;(pastFinal && unit.type !== 'live-agent-event' ? after : before).push(unit)
  }
  const foldsAnswer = (unit: LiveUnit) => !!final && unit.type === 'live-user' && isAnswerToTurn(unit.msg, unit.turnId)
  while (before[0] && ['live-user', 'live-delegation'].includes(before[0].type) && !foldsAnswer(before[0])) {
    const unit = before.shift()!
    leading.push({ kind: 'unit', key: unit.key, unit })
  }
  const persistentTypes = new Set(['live-approval-review-notice', 'live-approval-review', 'live-goal-completion', 'live-planning-question', 'live-proposed-plan', 'live-user', 'live-delegation', 'live-permission', 'live-plan-review', 'live-execution-mode', 'live-elicit', 'live-ask', 'live-auth', 'live-plan', 'live-file', 'live-error', 'live-turn-status'])
  // Same rule as the saved-history projection: friend sends keep their arrival
  // position inside the process disclosure.
  const foldedBefore = before
  // Retain child lifecycle evidence inside the process disclosure after completion.
  const entries = liveActivityEntries(foldedBefore, tools, recordedWorkflowIds)
  const project = (values: ActivityEntry<LiveUnit>[], active: boolean, tailClosed = false): LiveActivityNode[] => projectActivity(values, active, tailClosed).map(node => {
    if (node.kind === 'group') return { kind: 'activity', key: node.key, units: node.entries.map(entry => entry.value), summary: node.summary, mode: node.mode, activeAction: node.activeAction }
    const unit = node.entry.value
    const card = unit.type === 'live-tools' && unit.order.length === 1 ? tools[unit.order[0]] : null
    const record = card ? workflowRecordFromTool({ ...card, state: card.status }) : null
    return record ? { kind: 'workflow-record', key: `workflow:${record.toolCallId}`, record } : { kind: 'unit', key: node.entry.key, unit }
  })
  const projected = project(entries, running && !interrupted, !!final).reduce<LiveActivityNode[]>((result, node) => {
    const previous = result.at(-1)
    const isAgent = (value: LiveActivityNode | undefined) => value?.kind === 'unit' && value.unit.type === 'live-tools'
      && value.unit.order.every(id => subagentActivityKind(tools[id]?.toolName || ''))
    if (isAgent(previous) && isAgent(node) && previous?.kind === 'unit' && previous.unit.type === 'live-tools'
      && node.kind === 'unit' && node.unit.type === 'live-tools') previous.unit = { ...previous.unit, order: [...previous.unit.order, ...node.unit.order] }
    else result.push(node)
    return result
  }, [])
  const persistent = projected.filter(node => node.kind === 'workflow-record'
    || node.kind === 'unit' && !foldsAnswer(node.unit) && (node.unit.type === 'live-ask' || node.unit.type === 'live-planning-question' ? !isSettledAskUserUnit(node.unit) : persistentTypes.has(node.unit.type)))
  const activity = projected.filter(node => !persistent.includes(node))
  const agents = entries.flatMap(entry => entry.value.type === 'live-tools' ? entry.value.order
    .filter(id => subagentActivityKind(tools[id]?.toolName || ''))
    .map(id => liveActivityTool(tools[id])) : [])
  const ownerTurnId = liveUnits.find(unit => unit.turnId)?.turnId
  const preventAutoCollapse = running || !interrupted && (resolveSubagentActivities(agents, interrupted).some(row => subagentPreventsAutoCollapse(row, ownerTurnId))
    || unsettledAgentEventRows(before))
  const state = turnCollapseState({ hasFinal: !!final, interrupted, hasActivity: activity.length > 0,
    hasRunningTools: running && entries.some(entry => entry.action?.running),
    allowCollapseBeforeFinal: (running || terminal) && !interrupted,
    preventAutoCollapse,
  })
  const completedAtMs = recordedCompletedAtMs ?? (final?.type === 'live-text'
    ? workTimestamp((final as { startedAtMs?: number }).startedAtMs) ?? (!running ? workTimestamp(final.turnTail?.ts) : null)
    : null)
  const result: LiveActivityNode[] = [...leading]
  // 工作树初始化行跟在乐观用户气泡之后（worktree-init 语义）：创建动作
  // 是由这条消息触发的，进行中/失败态就长在消息下面。仅首个回合画一次；回合
  // 已有乐观气泡时随气泡插入，空 live 层（首轮发送前）也照样出。
  if (worktreeInit && !interrupted) {
    result.push({ kind: 'worktree-init', key: 'worktree-init-row', status: worktreeInit })
  }
  if (state.allowed) result.push({ kind: 'turn', key: 'turn', items: projected, persistent,
    messageCount: entries.filter(entry => entry.grouping !== 'reasoning'
      && (!persistentTypes.has(entry.value.type) || foldsAnswer(entry.value) || (entry.value.type === 'live-ask' || entry.value.type === 'live-planning-question') && isSettledAskUserUnit(entry.value))
      && !persistent.some(node => node.kind === 'workflow-record' && node.record.toolCallId === entry.key)).length,
    preventAutoCollapse, running, startedAtMs, completedAtMs,
  })
  else result.push(...projected)
  if (running && !interrupted && !state.allowed) {
    const firstWork = result.findIndex(node => node.kind !== 'worktree-init'
      && !(node.kind === 'unit' && ['live-user', 'live-delegation'].includes(node.unit.type)))
    result.splice(firstWork < 0 ? result.length : firstWork, 0, {
      kind: 'work-divider', key: 'work-divider', startedAtMs: startedAtMs ?? Date.now(), completedAtMs,
    })
  }
  if (final) result.push({ kind: 'unit', key: final.key, unit: {
    ...final,
    goalCompletion: !running && !interrupted && !liveUnits.some(unit => unit.type === 'live-error')
      ? goalCompletionByTurn.get(final.turnId ?? ownerTurnId ?? '') : undefined,
  } })
  result.push(...project(liveActivityEntries(after, tools, recordedWorkflowIds), running && !interrupted))
  return result
}

/** Completion snapshots and their successful tool results share one transcript outcome. */
export function historyWorkflowIdsForMessages(history: any[]): Set<string> {
  return new Set(unitsFromMessages(history).flatMap(unit => {
    if (unit.type === 'goal-completion' && unit.segment?.goal) return [`goal:${unit.segment.goal.goalId}`]
    return (unit.segment?.tools || []).flatMap(tool => {
      const record = workflowRecordFromTool(tool)
      return record ? [tool.toolCallId, ...(record.kind === 'goal-completed' && record.goalId ? [`goal:${record.goalId}`] : [])] : []
    })
  }))
}

export function groupLiveActivityUnits(
  units: LiveUnit[], tools: Record<string, ToolCardState>, running: boolean, thinkingActive: boolean, interrupted = false,
  historyWorkflowIds: ReadonlySet<string> = new Set(),
  worktreeInit: 'running' | 'completed' | 'failed' | null = null,
  turnStartedAtMs: Record<string, number> = {},
  liveTailStartedAtMs: number | null = null,
  turnWorkCompletedAtMs: Record<string, number> = {},
  terminal = false,
  activeTurnId?: string | null,
  goalCompletionByTurn: ReadonlyMap<string, GoalCompletionSummary> = transcriptGoalCompletions([], units, tools),
  pendingStart = false,
): LiveActivityNode[] {
  const recordedWorkflowIds = new Set(historyWorkflowIds)
  const completedGoals = new Set(historyWorkflowIds)
  units = units.filter(unit => {
    if (unit.type !== 'live-goal-completion') return true
    const key = `goal:${unit.goal.goalId}`
    if (completedGoals.has(key)) return false
    completedGoals.add(key); recordedWorkflowIds.add(key)
    return true
  })
  units = units.filter(unit => unit.type !== 'live-goal-completion')
  const turns: Array<{ id?: string; units: LiveUnit[] }> = []
  for (const unit of units) {
    let turn = turns.at(-1)
    const startsTurn = unit.turnId && turn?.id && unit.turnId !== turn.id
      || unit.type === 'live-user' && turn?.units.length && (!unit.turnId || unit.turnId !== turn.id)
    if (!turn || startsTurn) { turn = { id: unit.turnId, units: [] }; turns.push(turn) }
    turn.id ||= unit.turnId
    turn.units.push(unit)
  }
  // Live notices can share a resumed commentary segment after another turn.
  // Keep the ordinary commentary in place while returning child receipts to
  // the same process owner used by the saved-history projection.
  const processByTurn = new Map<string, { turn: typeof turns[number]; hasFinal: boolean }>()
  for (const turn of turns) {
    if (!turn.id) continue
    const process = processByTurn.get(turn.id)
    const hasFinal = turn.units.some(unit => unit.type === 'live-text'
      && (unit.turnTail || unit.phase === 'final_answer' && unit.text.trim()))
    if (process && !hasFinal && (process.hasFinal || turn.units.every(unit => unit.type === 'live-agent-event'))) {
      process.turn.units.push(...turn.units.filter(unit => unit.type === 'live-agent-event'))
      turn.units = turn.units.filter(unit => unit.type !== 'live-agent-event')
    }
    if (turn.units.length && (!process || hasFinal || !process.hasFinal)) processByTurn.set(turn.id, { turn, hasFinal })
  }
  const visibleTurns = turns.filter(turn => turn.units.length)
    // A live receipt naming a turn this layer does not hold has no owner to
    // settle into; drop it instead of stranding it after the conversation.
    .filter(turn => !(units.some(unit => unit.type !== 'live-agent-event')
      && turn.id
      && turn.units.every(unit => unit.type === 'live-agent-event')
      && !units.some(unit => unit.type !== 'live-agent-event' && unit.turnId === turn.id)))
  // An empty continuation already owns a turn before its first content arrives.
  // Retained stopped content must never borrow that turn's running state or clock.
  if (running && (activeTurnId ? !visibleTurns.some(turn => turn.id === activeTurnId) : pendingStart)) {
    visibleTurns.push({ id: activeTurnId || undefined, units: [] })
  }
  const completionOwners = new Map<string, typeof turns[number]>()
  for (const turn of visibleTurns) {
    if (turn.id && turn.units.some(unit => unit.type === 'live-text'
      && (unit.turnTail || unit.phase === 'final_answer' && unit.text.trim()))) completionOwners.set(turn.id, turn)
  }
  const hasUserBubble = units.some(unit => unit.type === 'live-user')
  return visibleTurns.flatMap((turn, index) => {
    const last = index === visibleTurns.length - 1
    const current = activeTurnId ? turn.id === activeTurnId : last
    const stopped = turn.units.some(unit => unit.type === 'live-turn-status' || unit.type === 'live-text' && unit.aborted)
      || current && interrupted
    // 只在首个回合画一次工作树行；已有乐观气泡的回合里它随气泡插入，
    // 空 live 层（历史已接管但 store 状态还在）不出，避免与历史层重复。
    const turnWorktreeInit = worktreeInit && index === 0 && (hasUserBubble || units.length === 0) ? worktreeInit : null
    // The engine-stamped per-turn start wins; the running tail falls back to
    // the session's own turn stamp (set when the turn opens, cleared when it
    // settles) so a fresh turn ticks from its first second instead of waiting
    // for a history reload to name its start.
    const stamp = turn.id ? turnStartedAtMs[turn.id] : undefined
    const localStart = turn.units.map(unit => workTimestamp(unit.type === 'live-user'
      ? unit.msg?.timestamp : (unit as { startedAtMs?: number }).startedAtMs)).find(value => value != null)
    return projectLiveTurn(turn.units, tools, running && current, thinkingActive && current, stopped, recordedWorkflowIds, turnWorktreeInit,
      stamp ?? (running && current ? liveTailStartedAtMs ?? undefined : undefined) ?? localStart ?? null,
      workTimestamp(turn.id ? turnWorkCompletedAtMs[turn.id] : null), terminal && current,
      turn.id && completionOwners.has(turn.id) && completionOwners.get(turn.id) !== turn ? new Map() : goalCompletionByTurn)
      .map(node => ({ ...node, turnId: turn.id, key: node.kind === 'turn' ? `turn:${turn.id || index}` : node.key }))
  })
}

type LiveActivityRenderProps = {
  tools: Record<string, ToolCardState>
  sessionId: string
  unitProps: UnitProps
  mediaPaths: ReadonlySet<string>
  mediaAliases?: ReadonlyMap<string, string>
  /**
   * This turn's produced images, minus the ones its own final answer already
   * embeds. Rendered after the turn's fold, so a generated image is visible
   * without expanding the folded history. See TurnMediaBlock.
   */
  turnMedia: string[]
  /** Images already presented elsewhere (inline in the reply, or the turn-end
   *  block), which the folded tool cards must not render a second time. */
  figurePaths: ReadonlySet<string>
  endResourceTurn?: { turnId: string; status: string } | null
  lastLiveText: Extract<LiveUnit, { type: 'live-text' }> | null
  turnInterrupted: boolean
  turnKey: string
  durationMs?: number
  collapseOverrides: Record<string, boolean>
  onToggleFold: (foldKey: string, open: boolean) => void
  expandedToolIds: ReadonlySet<string>
  onToggleTool: (toolCallId: string) => void
}

function LiveActivityNodeView({ node, ...props }: LiveActivityRenderProps & { node: LiveActivityNode }): ReactNode {
  const t = useT()
  if (node.kind === 'workflow-record') return <WorkflowRecordView record={node.record} sessionId={props.sessionId} />
  if (node.kind === 'worktree-init') return <WorktreeInitEvent status={node.status} />
  if (node.kind === 'work-divider') return <TurnWorkDivider startedAtMs={node.startedAtMs} completedAtMs={node.completedAtMs} />
  if (node.kind === 'unit') return <LiveUnitView unit={node.unit} tools={props.tools} sessionId={props.sessionId} unitProps={props.unitProps}
    mediaPaths={props.mediaPaths} mediaAliases={props.mediaAliases} figurePaths={props.figurePaths} isLastText={isFinalLiveText(node.unit, props.lastLiveText)}
    endResourceTurn={props.endResourceTurn} turnInterrupted={props.turnInterrupted} expandedToolIds={props.expandedToolIds} onToggleTool={props.onToggleTool} />
  const foldKey = node.kind === 'activity' ? `activity:${props.turnKey}:${node.key}` : `turn:${props.turnKey}`
  const open = node.kind === 'activity' ? activityCollapseState(node.mode, props.collapseOverrides[foldKey]).open
    : turnCollapseState({ hasFinal: true, interrupted: props.turnInterrupted, hasActivity: true,
        preventAutoCollapse: node.preventAutoCollapse || props.collapseOverrides[`mcp-expanded:${props.turnKey}`] === true, collapsed: props.collapseOverrides[foldKey] }).open
  const label = node.kind === 'activity' ? <ActivityHeader node={node} />
    : <TurnWorkLabel startedAtMs={node.running || node.completedAtMs != null ? node.startedAtMs : null}
        completedAtMs={node.completedAtMs} durationMs={!node.running ? props.durationMs : undefined}
        fallback={node.running ? undefined : t('activity_previous_messages').replace('{count}', String(node.messageCount))} />
  if (node.kind === 'turn') return <ActivityDisclosure variant="turn" open={open} onToggle={() => props.onToggleFold(foldKey, open)} label={label}
    sections={node.items.map(item => ({ key: item.key, persistent: node.persistent.includes(item), content: <LiveActivityNodeView node={item} {...props} /> }))} />
  return <ActivityDisclosure enabled={node.mode === 'summary'} open={open} onToggle={() => props.onToggleFold(foldKey, open)} label={label}>
    {node.units.map(unit => <LiveUnitView unit={unit} tools={props.tools} sessionId={props.sessionId} unitProps={props.unitProps}
      mediaPaths={props.mediaPaths} mediaAliases={props.mediaAliases} figurePaths={props.figurePaths} isLastText={isFinalLiveText(unit, props.lastLiveText)}
      endResourceTurn={props.endResourceTurn} turnInterrupted={props.turnInterrupted} expandedToolIds={props.expandedToolIds} onToggleTool={props.onToggleTool} key={unit.key} />)}
  </ActivityDisclosure>
}

// Keep the section parent stable before final text, during folding, and after
// history takes over. Pending request cards must retain their local form state.
function LiveTurnActivityView({ nodes, ...props }: LiveActivityRenderProps & { nodes: LiveActivityNode[] }) {
  const t = useT()
  const fold = nodes.find(node => node.kind === 'turn')
  const foldKey = `turn:${props.turnKey}`
  const open = !fold || turnCollapseState({ hasFinal: true, interrupted: props.turnInterrupted, hasActivity: true,
    preventAutoCollapse: fold.preventAutoCollapse || props.collapseOverrides[`mcp-expanded:${props.turnKey}`] === true,
    collapsed: props.collapseOverrides[foldKey] }).open
  const label = fold ? <TurnWorkLabel startedAtMs={fold.running || fold.completedAtMs != null ? fold.startedAtMs : null}
    completedAtMs={fold.completedAtMs} durationMs={!fold.running ? props.durationMs : undefined}
    fallback={fold.running ? undefined : t('activity_previous_messages').replace('{count}', String(fold.messageCount))} /> : null
  return <ActivityDisclosure variant="turn" enabled={!!fold} open={open} label={label} headerBefore={fold?.items[0]?.key} onToggle={() => props.onToggleFold(foldKey, open)}
    sections={nodes.flatMap(node => node.kind === 'turn'
      ? node.items.map(item => ({ key: item.key, persistent: node.persistent.includes(item), content: <LiveActivityNodeView node={item} {...props} /> }))
      : [{ key: node.key, persistent: true, content: <LiveActivityNodeView node={node} {...props} /> }])} />
}

export function hasActiveChatActivitySummary(liveUnits: LiveUnit[], tools: Record<string, ToolCardState>, running: boolean): boolean {
  return running && liveUnits.some(unit => unit.type === 'live-tools' && unit.order.some(id => {
    const card = tools[id]
    if (!card || isHiddenAgentMessageTool(liveToolData(card))) return false
    return card.status === 'running' || card.status === 'awaiting-approval'
  }))
}

type WaitingTool = Pick<SegmentTool, 'toolCallId' | 'toolName' | 'args' | 'state'>

function waitingTask(tool: WaitingTool, agentTasks?: Record<string, AgentTask>): AgentTask | null {
  return (agentTasks ? agentTasks[tool.toolCallId] : w().KlausSubagentPanel?.getTask?.(tool.toolCallId)) || null
}

function pendingWaitingTools(tools: WaitingTool[], agentTasks?: Record<string, AgentTask>): WaitingTool[] {
  return tools.filter(tool => {
    if (isHiddenAgentMessageTool(tool) || tool.state !== 'running' && tool.state !== 'awaiting-approval') return false
    const task = isSubagentSpawnToolName(tool.toolName) ? waitingTask(tool, agentTasks) : null
    return !task || !isTerminalSubagentStatus(subagentDisplayStatus(task))
  })
}

function waitingSubagentNames(tools: WaitingTool[], agentTasks?: Record<string, AgentTask>): string[] {
  const pending = pendingWaitingTools(tools, agentTasks)
  if (!pending.length || !pending.every(tool => {
    const task = waitingTask(tool, agentTasks)
    return tool.state === 'running' && isSubagentSpawnToolName(tool.toolName)
      && tool.args?.run_in_background !== true && tool.args?.persistent !== true
      && task?.type !== 'background' && task?.type !== 'in_process_teammate' && task?.agentType !== 'background'
  })) return []
  return [...new Set(pending.map(tool => subagentActivityTitleParts(tool.args, waitingTask(tool, agentTasks), tool.toolCallId).name))]
}

function waitingUnitsForTurn(units: LiveUnit[]): LiveUnit[] {
  const userIndex = units.map(unit => unit.type).lastIndexOf('live-user')
  const turnId = units[userIndex]?.turnId
  // Steering within a turn does not finish the tools that preceded it. A local
  // new user message without a turn ID, however, cannot inherit an older wait.
  return turnId ? units.filter(unit => unit.turnId === turnId) : units.slice(userIndex + 1)
}

function liveWaitingTools(units: LiveUnit[], tools: Record<string, ToolCardState>, historyTools: WaitingTool[] = []): WaitingTool[] {
  const current = new Map(historyTools.map(tool => [tool.toolCallId, tool]))
  for (const unit of units) if (unit.type === 'live-tools') {
    for (const id of unit.order) if (tools[id]) current.set(id, { ...tools[id], state: tools[id].status === 'ok' ? 'done' : tools[id].status })
  }
  return [...current.values()]
}

export function shouldShowLiveWaiting(units: LiveUnit[], tools: Record<string, ToolCardState>, state: {
  running: boolean; thinkingActive: boolean; activityVisible: boolean; compacting: boolean
}, historyTools: WaitingTool[] = [], agentTasks?: Record<string, AgentTask>): boolean {
  const afterPrompt = units.slice(units.map(unit => unit.type).lastIndexOf('live-user') + 1)
  const currentTools = liveWaitingTools(waitingUnitsForTurn(units), tools, historyTools)
  const waitingForSubagent = waitingSubagentNames(currentTools, agentTasks).length > 0
  return state.running && !state.compacting && (state.thinkingActive || state.activityVisible || waitingForSubagent)
    && (!pendingWaitingTools(currentTools, agentTasks).length || waitingForSubagent)
    && !units.some(unit => unit.type === 'live-compaction' && unit.state === 'running'
      || 'resolved' in unit && unit.resolved === null
      || unit.type === 'live-auth')
    && !afterPrompt.some(unit => unit.type === 'live-text' && (!!unit.turnTail || !!unit.text.trim() && (unit.phase === 'final_answer' || unit.streaming)))
}

export function ActivityWaitingIndicator({ label: suppliedLabel }: { label?: string } = {}) {
  const t = useT()
  const [sweeping, setSweeping] = useState(false)
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let start: ReturnType<typeof setTimeout> | undefined
    let stop: ReturnType<typeof setTimeout> | undefined
    let repeat: ReturnType<typeof setInterval> | undefined
    const reset = () => {
      clearTimeout(start)
      clearTimeout(stop)
      clearInterval(repeat)
      setSweeping(false)
    }
    const sweep = () => {
      setSweeping(true)
      stop = setTimeout(() => setSweeping(false), 1000)
    }
    const schedule = () => {
      reset()
      if (!motion.matches) start = setTimeout(() => {
        sweep()
        repeat = setInterval(sweep, 4000)
      }, 600)
    }
    schedule()
    motion.addEventListener('change', schedule)
    return () => {
      reset()
      motion.removeEventListener('change', schedule)
    }
  }, [])
  const label = suppliedLabel || t('thinking_label')
  return <div className={styles['activity-thinking-placeholder']} role="status">
    <span className={styles['activity-waiting-label']} data-sweeping={sweeping || undefined}>
      {label}
      <span className={styles['activity-waiting-sweep']} aria-hidden="true">
        <span className={styles['activity-waiting-highlight']}>{label}</span>
      </span>
    </span>
  </div>
}

function openingHistoryUser(group: HistoryTurnGroup): Unit | undefined {
  return group.nodes.flatMap(node => node.kind === 'turn-fold' ? node.items : [node])
    .find((node): node is Extract<RenderNode, { kind: 'unit' }> => node.kind === 'unit' && node.unit.type === 'user')?.unit
}

/** Saved and streamed projections share the same section parents and user rows. */
const TranscriptTurnFrame = memo(function TranscriptTurnFrame({ renderKey, identity, saved, live, liveProps, renderHistoryNode, unitProps }: {
  renderKey: string
  identity: TranscriptRenderIdentity
  saved?: HistoryTurnGroup
  live?: LiveTurnSegment
  liveProps?: LiveActivityRenderProps
  renderHistoryNode: (node: RenderNode) => ReactNode
  unitProps: UnitProps
}) {
  const t = useT()
  const savedFold = saved?.nodes.find((node): node is TurnFoldNode => node.kind === 'turn-fold')
  const element = useRef<HTMLDivElement>(null)
  const liveFold = live?.nodes.find(node => node.kind === 'turn')
  const foldKey = savedFold?.foldKey || `turn:${liveProps?.turnKey || ''}`
  const open = savedFold?.open ?? (!liveFold || turnCollapseState({ hasFinal: true,
    interrupted: !!liveProps?.turnInterrupted, hasActivity: true,
    preventAutoCollapse: liveFold.preventAutoCollapse || liveProps?.collapseOverrides[`mcp-expanded:${liveProps.turnKey}`] === true,
    collapsed: liveProps?.collapseOverrides[foldKey] }).open)
  const fold = savedFold || liveFold
  const divider = live?.nodes.find(node => node.kind === 'work-divider')
    || saved?.nodes.find(node => node.kind === 'work-divider')
  const owner = unitProps.streamSessionId || unitProps.sessionId || ''
  const pagination = useTurnItemsPagination(owner, saved?.turnId)
  const label = fold ? <TurnWorkLabel startedAtMs={fold.running || fold.completedAtMs != null ? fold.startedAtMs ?? null : null}
    completedAtMs={fold.completedAtMs} durationMs={!fold.running ? savedFold?.durationMs ?? liveProps?.durationMs : undefined}
    fallback={fold.running ? undefined : t('activity_previous_messages').replace('{count}', String(fold.messageCount))} /> : null
  const sections = new Map<string, { key: string; persistent: boolean; content: ReactNode }>()
  let openerKey: string | undefined
  const add = (key: string, persistent: boolean, content: ReactNode, follows = true) => {
    if (!sections.has(key)) sections.set(key, { key, persistent, content: follows ? <div data-latest-turn-follow-content="">{content}</div> : content })
  }
  // Both projections contribute to one turn. Keep its time header at the first
  // observed position, with any process disclosure replacing the placeholder.
  const addWorkHeader = () => add('turn-work-header', true, !fold && divider
    ? <TurnWorkDivider startedAtMs={divider.startedAtMs} completedAtMs={divider.completedAtMs} /> : null, false)
  const savedTerminal = saved?.nodes.find(node => node.kind === 'unit' && node.unit.type === 'turn-status')
  const liveTerminal = live?.nodes.find(node => node.kind === 'unit' && node.unit.type === 'live-turn-status')
  const terminalDuration = savedTerminal?.kind === 'unit' ? savedTerminal.unit.msg?.durationMs : undefined
  const terminalUnit = liveTerminal?.kind === 'unit' && liveTerminal.unit.type === 'live-turn-status' ? liveTerminal.unit : undefined
  const addTerminalStatus = () => add('turn-terminal-status', true,
    <TurnTerminalStatus durationMs={terminalDuration} startedAt={terminalUnit?.startedAt} finishedAt={terminalUnit?.finishedAt} />, false)
  const addUser = (unit: Unit, sourceKey: string, opener: boolean, persistent: boolean) => {
    const key = identity.message(renderKey, unit.msg, sourceKey, opener)
    if (opener && !unit.msg?.steered && !unit.msg?.questionAnswer) openerKey = key
    add(key, persistent, <UnitView unit={unit} {...unitProps} />, false)
  }
  let savedUsers = 0
  const addSaved = (node: RenderNode, persistent = true) => {
    if (node.kind === 'unit' && node.unit.type === 'user') addUser(node.unit, node.unit.key, savedUsers++ === 0, persistent)
    else if (node.kind === 'work-divider') addWorkHeader()
    else if (node.kind === 'unit' && node.unit.type === 'turn-status') addTerminalStatus()
    else add(`saved:${node.kind === 'unit' ? node.unit.key : node.key}`, persistent, renderHistoryNode(node))
  }
  for (const node of saved?.nodes || []) {
    if (node.kind === 'turn-fold') {
      addWorkHeader()
      if (pagination && !pagination.hasLoadedOldest && !pagination.evicted && !pagination.olderItemId && saved?.turnId) {
        add(`history-gap:${saved.turnId}`, false, <TurnHistoryGap sessionId={owner} turnId={saved.turnId} pagination={pagination} open={open} />)
      }
      for (const item of node.items) addSaved(item, isPersistentTurnNode(item))
    } else addSaved(node)
  }
  if ((!savedFold || pagination?.evicted || pagination?.olderItemId) && pagination && !pagination.hasLoadedOldest && saved?.turnId) {
    // Summary-only turns hydrate near the viewport without inventing an empty
    // activity disclosure. Once real process rows arrive, its fold owns the gap.
    add(`history-gap:${saved.turnId}`, true, <TurnHistoryGap sessionId={owner} turnId={saved.turnId}
      pagination={pagination} open observe={element} />)
  }
  const addLive = (node: LiveActivityNode, persistent = true) => {
    if (node.kind === 'unit' && node.unit.type === 'live-user') {
      // Only a leading user opens this segment. The first user in a continuation
      // can arrive after work and must retain that position even without metadata.
      const opener = node === live?.nodes[0]
      for (const [index, unit] of liveUserRenderUnits(node.unit).entries()) {
        if (unit.type === 'user') addUser(unit, `${node.unit.key}:${index}`, opener, persistent)
        else add(`live:${node.unit.key}:${index}`, true, <UnitView unit={unit} {...unitProps} />)
      }
    } else if (node.kind === 'work-divider') addWorkHeader()
    else if (node.kind === 'unit' && node.unit.type === 'live-turn-status') addTerminalStatus()
    else if (liveProps) add(`live:${node.key}`, persistent, <LiveActivityNodeView node={node} {...liveProps} />)
  }
  for (const node of live?.nodes || []) {
    if (node.kind === 'turn') {
      addWorkHeader()
      for (const item of node.items) addLive(item, node.persistent.includes(item))
    } else addLive(node)
  }
  const orderedSections = [...sections.values()]
  if (!savedUsers && openerKey) {
    const index = orderedSections.findIndex(section => section.key === openerKey)
    if (index > 0) orderedSections.unshift(...orderedSections.splice(index, 1))
  }
  return <div ref={element} data-klaus-transcript-turn="" data-klaus-transcript-turn-id={saved?.turnId || live?.owner}
    data-klaus-transcript-turn-key={saved?.key}>
    <ActivityDisclosure variant="turn" enabled={!!fold} open={open} label={label}
      headerBefore={fold ? 'turn-work-header' : undefined}
      onToggle={() => savedFold ? setTurnCollapsed(unitProps.streamSessionId || unitProps.sessionId || '', foldKey, open)
        : liveProps?.onToggleFold(foldKey, open)} sections={orderedSections} />
    {liveProps?.turnMedia.length ? <TurnMediaBlock paths={liveProps.turnMedia} sessionId={liveProps.sessionId} /> : null}
  </div>
})

type HistoryTurnGroup = ReturnType<typeof foldTurnGroups>[number]
type TranscriptTimeline = {
  groups: HistoryTurnGroup[]
  controller: TranscriptScrollController | null
  renderNode: (node: RenderNode) => ReactNode
}
type LiveTurnSegment = { owner: string; key: string; nodes: LiveActivityNode[] }

export function LiveTail({ sessionId, unitProps, scroll = 'none', container, timeline }: {
  sessionId: string
  unitProps: UnitProps
  scroll?: TranscriptScrollMode
  container?: HTMLElement
  timeline?: TranscriptTimeline
}) {
  const t = useT()
  const identity = useRef(new TranscriptRenderIdentity())
  const historyFrameIndex = useRef(new TranscriptFrameIndex<HistoryTurnGroup>())
  const listApi = useRef<VirtualTurnListApi | null>(null)
  const onListApiChange = useCallback((api: VirtualTurnListApi | null) => { listApi.current = api }, [])
  const jumpTargets = useRef(new Map<string, string>())
  useEffect(() => {
    if (!container) return
    const jump = (event: Event) => {
      const uuid = (event as CustomEvent<{ uuid?: string }>).detail?.uuid
      const key = uuid ? jumpTargets.current.get(uuid) : undefined
      if (!key || !uuid) return
      timeline?.controller?.holdViewport()
      void listApi.current?.scrollToKey(key, row => Array.from(row.querySelectorAll<HTMLElement>('[data-uuid]')).find(element => element.dataset.uuid === uuid) ?? null)
    }
    container.addEventListener('klaus-transcript-jump', jump)
    return () => container.removeEventListener('klaus-transcript-jump', jump)
  }, [container, timeline?.controller])
  const liveUnits = useChatStream(state => state.sessions[sessionId]?.liveUnits ?? EMPTY_LIVE)
  const tools = useChatStream(state => state.sessions[sessionId]?.tools ?? EMPTY_TOOLS)
  const agentTasks = useChatStream(state => state.sessions[sessionId]?.agentTasks ?? EMPTY_AGENT_TASKS)
  const history = useChatStream(state => state.sessions[sessionId]?.history ?? null)
  const historyWorkflowIds = useMemo(() => historyWorkflowIdsForMessages(history || []), [history])
  const goalCompletionByTurn = useTranscriptGoalCompletions(sessionId, history ?? EMPTY_HISTORY)
  const running = useChatStream(state => state.sessions[sessionId]?.running ?? false)
  const activeTurnId = useChatStream(state => state.sessions[sessionId]?.activeTurnId ?? null)
  const collapseOverrides = useChatStream(state => selectSessionStream(state, sessionId).turnCollapseOverrides)
  const thinkingActive = useChatStream(state => state.sessions[sessionId]?.thinkingActive ?? false)
  const activityVisible = useChatStream(state => state.sessions[sessionId]?.activityVisible ?? false)
  const goalContinuationLoading = useChatStream(state => state.sessions[sessionId]?.goalContinuationId != null)
  const compacting = useChatStream(state => !!state.sessions[sessionId]?.compactionPendingTrigger)
  // A stopped Turn stays in the live layer with its partial output. Subagent rows
  // in it must not keep claiming to run (see resolveSubagentActivities).
  const turnInterrupted = useChatStream(state => state.sessions[sessionId]?.interruptedLiveTurn != null)
  const terminalStatus = useChatStream(state => state.sessions[sessionId]?.lastTerminalStatus ?? null)
  const turnSequence = useChatStream(state => state.sessions[sessionId]?.turnSequence ?? EMPTY_TURN_SEQUENCE)
  // Worktree-init live status mirrors the main component's row (below the user
  // bubble): creation running/failed draws here, the settled state only while
  // the first turn is still live-owned. See LiveTail's call site for the split.
  const worktreeInitStatus = useChatStream(state => state.sessions[sessionId]?.worktreeInit?.status ?? null)
  const sessionWorkdir = (w().getKnownSessionInfo?.(sessionId)?.workdir as string | undefined) ?? null
  const worktreeRowStatus: 'running' | 'completed' | 'failed' | null = worktreeInitStatus
    ?? (isWorktreeSessionWorkdir(sessionWorkdir) ? 'completed' : null)
  const expandedToolIds = new Set(Object.entries(collapseOverrides).filter(([key, collapsed]) => key.startsWith('tool:') && !collapsed).map(([key]) => key.slice(5)))
  const toggleTool = (toolCallId: string) => {
    const open = expandedToolIds.has(toolCallId)
    setTurnCollapsed(sessionId, `tool:${toolCallId}`, open)
    if (!open && /^mcp[_.]/i.test(tools[toolCallId]?.toolName || '')) {
      const owner = liveUnits.find(unit => unit.type === 'live-tools' && unit.order.includes(toolCallId))?.turnId || turnKey
      setTurnCollapsed(sessionId, `mcp-expanded:${owner}`, true)
    }
  }
  // 在途回合的同回合出图去重：末段 live-text 是最终回复（权威面），它嵌的图由
  // 回合末尾的出图区块让位；工具已出的图路径供中间 live-text 剩重，也供相对路径
  // 的嵌图解析（模型常贴生图结果里的裸文件名）。这两份都按回合算，见 contextForTurn。
  const textUnits = liveUnits.filter(u => u.type === 'live-text')
  const lastLiveText = textUnits.length ? textUnits[textUnits.length - 1] : null
  const mediaPaths = new Set<string>()
  for (const card of Object.values(tools)) {
    for (const item of card.media || []) if (item?.path) mediaPaths.add(String(item.path))
  }
  const visualArtifacts = uniqueVisualArtifacts(liveUnits.flatMap(unit =>
    unit.type === 'live-tools'
      ? unit.order.map(toolCallId => tools[toolCallId]?.artifact)
      : [],
  ))
  const liveTurnId = useChatStream(state => state.sessions[sessionId]?.liveTurnId ?? null)
  const turnKey = activeTurnId || liveTurnId || 'live'
  const turnDurations = useChatStream(state => selectSessionStream(state, sessionId).turnDurations)
  const durationMs = turnDurations[turnKey]
  const liveTurnStatuses = useChatStream(state => selectSessionStream(state, sessionId).turnStatuses)
  const { startedAtMs: turnStartedAtMs, completedAtMs: turnWorkCompletedAtMs } = useTurnWorkTimes(sessionId)
  const liveTailStartedAt = useChatStream(state => selectSessionStream(state, sessionId).turnStartedAt)
  // live 层的工作树行跟在乐观用户气泡下（worktree-init 语义）。行归“拥有
  // 首条用户气泡的那一层”：创建进行中/失败（会话存活期状态）时 live 必画；完成态
  // 只在历史还没有用户消息（首回合仍由 live 层持有）时画，历史一旦接管就交给
  // foldUnits 在首条气泡下画，两层不同时出。
  const historyHasUser = (history || []).some(msg => msg?.role === 'user')
  const liveWorktreeStatus: 'running' | 'completed' | 'failed' | null =
    worktreeRowStatus && (worktreeRowStatus !== 'completed' || !historyHasUser) ? worktreeRowStatus : null
  const activityNodes = groupLiveActivityUnits(liveUnits, tools, running, thinkingActive, turnInterrupted, historyWorkflowIds,
    liveUnits.length > 0 ? liveWorktreeStatus : null, turnStartedAtMs, liveTailStartedAt > 0 ? liveTailStartedAt : null, turnWorkCompletedAtMs,
    !running && (terminalStatus === 'completed' || terminalStatus === 'failed'), activeTurnId, goalCompletionByTurn, hasPendingTurnStart(sessionId))
  const activityTurns: LiveTurnSegment[] = []
  const userKeysByTurn = new Map<string, string>()
  for (const unit of liveUnits) if (unit.type === 'live-user' && !userKeysByTurn.has(unit.turnId || turnKey)) {
    userKeysByTurn.set(unit.turnId || turnKey, unit.key)
  }
  const seenActivityOwners = new Set<string>()
  for (const node of activityNodes) {
    const owner = node.turnId || turnKey
    let segment = activityTurns.at(-1)
    if (!segment || segment.owner !== owner) {
      // The engine assigns the turn id after the optimistic bubble is mounted.
      // Its local unit key survives that handoff, so the React parent must use it.
      const renderKey = userKeysByTurn.get(owner) || owner
      segment = { owner, key: seenActivityOwners.has(owner) ? `${renderKey}:segment:${node.key}` : renderKey, nodes: [] }
      activityTurns.push(segment)
      seenActivityOwners.add(owner)
    }
    segment.nodes.push(node)
  }
  const activityRenderProps: LiveActivityRenderProps = {
    tools, sessionId: unitProps.sessionId || sessionId, unitProps, mediaPaths, lastLiveText,
    turnInterrupted, turnKey, collapseOverrides, durationMs, turnMedia: [], figurePaths: EMPTY_PATHS,
    onToggleFold: (foldKey, open) => setTurnCollapsed(sessionId, foldKey, open),
    expandedToolIds,
    onToggleTool: toggleTool,
  }
  const contextForTurn = (owner: string): Partial<LiveActivityRenderProps> => {
    const units = liveUnits.filter(unit => (unit.turnId || turnKey) === owner)
    const texts = units.filter((unit): unit is Extract<LiveUnit, { type: 'live-text' }> => unit.type === 'live-text')
    const final = [...texts].reverse().find(unit => unit.phase === 'final_answer' || unit.turnTail) || ((!running || owner !== turnKey) ? texts.filter(unit => !unit.phase).at(-1) : null) || null
    // Ordered, not a Set: the turn-end block renders the images in the order the
    // tools produced them, so a turn that made three covers reads as a sequence.
    const produced: string[] = []
    const images = new Set<string>()
    const explicitMedia = new Set<string>()
    for (const unit of units) if (unit.type === 'live-tools') {
      for (const id of unit.order) {
        const card = tools[id]
        if (!card) continue
        if (isExplicitMediaGenerationTool(card.toolName)) {
          for (const item of card.media || []) if (item?.path) explicitMedia.add(String(item.path))
        }
        for (const item of card.media || []) {
          const path = item?.path ? String(item.path) : ''
          if (!path) continue
          images.add(path)
          if (!produced.includes(path)) produced.push(path)
        }
      }
    }
    // 与历史层同一套规则（见 foldUnits）：回合末尾只放真的在向用户汇报的产物——
    // 显式生成工具的产出，或最终回复点过名的；其余是过程产物，留在折叠内的工具卡。
    // 最终回复里贴的裸文件名先按本回合工具产物解析成绝对路径，判定才认得出。
    const mediaAliases = collectImageSourceAliases(units.flatMap(unit => unit.type === 'live-tools' ? unit.order.flatMap(id => tools[id]?.media || []) : []))
    const resolvedFinal = final && images.size > 0 ? resolveRelativeImagePaths(final.text, images, mediaAliases) : final?.text || ''
    const embedded = final ? collectMarkdownImagePaths(resolvedFinal) : EMPTY_PATHS
    const reported = final ? collectReportedPaths(resolvedFinal, images, mediaAliases) : EMPTY_PATHS
    const turnMedia = produced.filter(path => (explicitMedia.has(path) || reported.has(path)) && !embedded.has(path))
    // The live layer holds a just-settled turn until history takes it over; the
    // same resource projection applies once that turn has completed or failed.
    const liveStatus = liveTurnStatuses[owner] || (owner === turnKey ? (running ? '' : terminalStatus ?? '') : 'completed')
    const endResourceTurn = owner !== 'live' && (liveStatus === 'completed' || liveStatus === 'failed') ? { turnId: owner, status: liveStatus } : null
    return { turnKey: owner, lastLiveText: final, endResourceTurn, mediaPaths: images, mediaAliases, durationMs: turnDurations[owner],
      turnMedia,
      // 已在别处呈现的图不在工具卡里再出一遍；没被汇报的图回到卡片，那是它唯一的呈现面。
      figurePaths: new Set<string>([...embedded, ...turnMedia]),
      turnInterrupted: units.some(unit => unit.type === 'live-turn-status') || owner === turnKey && turnInterrupted }
  }
  const currentUnits = liveUnits.filter(unit => !unit.turnId || unit.turnId === turnKey)
  const historyUnits = useMemo(() => {
    if (!history?.length) return []
    // Waiting state only needs the last saved turn, never the earlier transcript.
    let start = history.length - 1
    const tailTurnId = history[start]?.turnId
    if (tailTurnId) {
      while (start > 0 && history[start - 1]?.turnId === tailTurnId) start--
    } else {
      while (start > 0 && history[start]?.role !== 'user') start--
    }
    return unitsFromMessages(history.slice(start))
  }, [history])
  const lastHistoryTurn = historyUnits.at(-1)?.turnId
  const currentUser = [...currentUnits].reverse().find(unit => unit.type === 'live-user')
  const historyTools = running && lastHistoryTurn && (turnKey === 'live' || lastHistoryTurn === turnKey)
    && (!currentUser || currentUser.turnId === lastHistoryTurn)
    ? historyUnits.filter(unit => unit.turnId === lastHistoryTurn)
      .flatMap(unit => (unit.segment?.tools || []).filter(tool => tool.pendingResult)
        .map(tool => ({ ...tool, state: 'running' as const })))
    : []
  const waiting = shouldShowLiveWaiting(currentUnits, tools,
    { running, thinkingActive, activityVisible, compacting }, historyTools, agentTasks)
  const waitingAgents = waitingSubagentNames(liveWaitingTools(waitingUnitsForTurn(currentUnits), tools, historyTools), agentTasks)
  const latestFooter = <>
    {visualArtifacts.length ? <VisualArtifactsBlock sessionId={unitProps.sessionId || sessionId} artifacts={visualArtifacts} /> : null}
    {waiting ? <ActivityWaitingIndicator label={waitingAgents.length
      ? t('activity_waiting_for_agents').replace('{agents}', new Intl.ListFormat(intlLocale()).format(waitingAgents))
      : goalContinuationLoading ? t('goal_continuation_loading') : undefined} /> : null}
  </>
  let timelineContent: ReactNode = null
  if (timeline) {
    const keys = identity.current
    const liveKeys = new Map<LiveTurnSegment, string>()
    const seenLiveOwners = new Set<string>()
    for (const segment of activityTurns) {
      const user = segment.nodes.find(node => node.kind === 'unit' && node.unit.type === 'live-user')
      const msg = user?.kind === 'unit' && user.unit.type === 'live-user' ? user.unit.msg : undefined
      liveKeys.set(segment, keys.turn(segment.owner === 'live' ? undefined : segment.owner, segment.key, msg, seenLiveOwners.has(segment.owner)))
      seenLiveOwners.add(segment.owner)
    }
    type TurnFrame = { key: string; saved?: HistoryTurnGroup; live?: LiveTurnSegment; liveProps?: LiveActivityRenderProps; index?: number }
    const savedIndex = historyFrameIndex.current.read(timeline.groups, keys, group => openingHistoryUser(group)?.msg)
    const liveFrames = new Map<string, TurnFrame>()
    for (const [index, segment] of activityTurns.entries()) {
      const key = liveKeys.get(segment)!
      const context = contextForTurn(segment.owner)
      const ownsMedia = context.lastLiveText
        ? segment.nodes.some(node => node.kind === 'unit' && isFinalLiveText(node.unit, context.lastLiveText!))
        : !activityTurns.slice(index + 1).some(row => row.owner === segment.owner)
      liveFrames.set(key, { key, live: segment,
        liveProps: { ...activityRenderProps, ...context, turnMedia: ownsMedia ? context.turnMedia || [] : [] } })
    }
    const historicalFrames: TurnFrame[] = savedIndex.frames.map(frame => ({ ...frame, ...liveFrames.get(frame.key) }))
    const frameStartMs = (frame: TurnFrame): number => {
      const owner = frame.live?.owner ?? frame.saved?.turnId
      const recorded = owner && owner !== 'live' ? turnStartedAtMs[owner] : undefined
      if (typeof recorded === 'number' && Number.isFinite(recorded) && recorded > 0) return recorded
      const liveOpener = (nodes: LiveActivityNode[]): number | undefined => {
        for (const node of nodes) {
          if (node.kind !== 'unit' || node.unit.type !== 'live-user') continue
          const ts = node.unit.msg?.timestamp
          if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return ts
        }
        return undefined
      }
      const openerTs = frame.live
        ? liveOpener(frame.live.nodes)
        : frame.saved ? openingHistoryUser(frame.saved)?.msg?.timestamp : undefined
      if (typeof openerTs === 'number' && Number.isFinite(openerTs) && openerTs > 0) return openerTs
      const firstUnitTs = frame.saved?.nodes
        ?.map(node => node.kind === 'unit' ? (node.unit.ts ?? node.unit.msg?.timestamp) : undefined)
        .find(ts => typeof ts === 'number' && Number.isFinite(ts) && ts > 0)
      return typeof firstUnitTs === 'number' ? firstUnitTs : Number.POSITIVE_INFINITY
    }
    const toSequenceRef = (frame: TurnFrame, savedIndex: number | null, savedKey: string | null): TurnSequenceRef => {
      const owner = frame.live?.owner ?? frame.saved?.turnId
      return { key: frame.key, savedIndex, savedKey, turnId: owner && owner !== 'live' ? owner : null, startMs: frameStartMs(frame) }
    }
    const savedRefs = historicalFrames.map(frame => toSequenceRef(frame, frame.index ?? null, frame.key))
    const liveRefs = [...liveFrames.values()].map(frame => {
      const saved = savedIndex.byKey.get(frame.key)
      return toSequenceRef(frame, saved ? saved.index : null, saved ? saved.key : null)
    })
    const framesByKey = new Map<string, TurnFrame>()
    for (const frame of historicalFrames) framesByKey.set(frame.key, frame)
    for (const [key, frame] of liveFrames) if (!framesByKey.has(key)) framesByKey.set(key, frame)
    const visibleFrames = mergeTurnSequence(savedRefs, liveRefs, turnSequence)
      .map(ref => framesByKey.get(ref.key))
      .filter((frame): frame is TurnFrame => frame != null)
    const frameByKey = new Map(visibleFrames.map(frame => [frame.key, frame]))
    const targets = new Map<string, string>()
    for (const frame of visibleFrames) {
      for (const node of frame.saved?.nodes ?? []) {
        for (const item of node.kind === 'turn-fold' ? node.items : [node]) {
          if (item.kind === 'unit' && item.unit.msg?.uuid) targets.set(item.unit.msg.uuid, frame.key)
        }
      }
    }
    jumpTargets.current = targets
    const renderFrame = (key: string) => {
      const frame = frameByKey.get(key)
      return frame ? <Fragment key={key}><TranscriptTurnFrame renderKey={key} identity={keys} saved={frame.saved} live={frame.live}
        liveProps={frame.liveProps} renderHistoryNode={timeline.renderNode} unitProps={unitProps} />
        {frame.key === latest?.key ? latestFooter : null}</Fragment> : null
    }
    const latest = visibleFrames.at(-1)
    const latestUser = [...liveUnits].reverse().find(unit => unit.type === 'live-user')
    const phase = latestTurnPhase({ running, hasWork: thinkingActive || activityVisible || Object.keys(tools).length > 0,
      texts: textUnits })
    timelineContent = timeline.controller && container && visibleFrames.length > 0
      ? <VirtualTranscript sessionId={sessionId} container={container} controller={timeline.controller}
          entries={visibleFrames.map(frame => ({ key: frame.key, turnId: frame.saved?.turnId ?? frame.live?.owner,
            historyGap: frame.saved?.nodes.some(node => node.kind === 'history-gap'),
            firstProtectedItemId: running && (frame.saved?.turnId ?? frame.live?.owner) === turnKey
              ? (history ?? []).filter(row => row.turnId === turnKey).at(-500)?.uuid ?? null : null,
            estimatedHeightPx: frame.saved?.nodes.some(node => node.kind === 'history-gap') ? 144 : 280 }))}
          renderRow={renderFrame} latestKey={latest?.key ?? null} placementKey={latest ? `${latest.key}:${latestUser?.key ?? ''}` : null}
          phase={phase} running={running} onApiChange={onListApiChange} />
      : visibleFrames.map(frame => renderFrame(frame.key))

  }
  return (
    <>
      {timeline ? timelineContent : activityTurns.map(({ owner, key, nodes }, index) => {
        const context = contextForTurn(owner)
        const ownsMedia = context.lastLiveText
          ? nodes.some(node => node.kind === 'unit' && isFinalLiveText(node.unit, context.lastLiveText!))
          : !activityTurns.slice(index + 1).some(segment => segment.owner === owner)
        const content = (
          <>
            <LiveTurnActivityView nodes={nodes} {...activityRenderProps} {...context} />
            {/* 出图区块在折叠之外（与历史层的 turn-media 节点同位置）：图是交付物，
                藏在「已处理 N 个操作」里等于没交付。 */}
            {ownsMedia && context.turnMedia?.length
              ? <TurnMediaBlock paths={context.turnMedia} sessionId={unitProps.sessionId || sessionId} />
              : null}
          </>
        )
        return scroll === 'main'
          ? <div key={key} data-klaus-transcript-turn="" data-klaus-transcript-turn-id={owner}>{content}</div>
          : <Fragment key={key}>{content}</Fragment>
      })}
      {!timeline ? latestFooter : null}
    </>
  )
}

const EMPTY_LIVE: LiveUnit[] = []
const EMPTY_HISTORY: any[] = []
const EMPTY_TOOLS: Record<string, ToolCardState> = {}
const EMPTY_TURN_SEQUENCE: string[] = []
const EMPTY_AGENT_TASKS: Record<string, AgentTask> = {}
const EMPTY_PATHS: ReadonlySet<string> = new Set()

// ==================== 静态消息数组渲染（teammate/sub-agent 视图） ====================
// 不订阅 store：直接把 ChatMessage[] 走同一条 units 管线（工具卡/思考折叠
// 与主转录同构）。旧 renderHistoryInto 的 #messages 搬运把戏退役。
//
// running 由宿主给（子任务面板里那条记录的状态）：这条转录是一个可能还在跑的
// 子会话的快照，跑着的时候它的尾组和主转录的在途回合一样必须平铺——不给这个
// 状态就等于宣称「已经跑完了」，于是没结束的子 Agent 一进去就是一行
// 「已处理 N 个操作」。
export function StaticTranscriptView({ msgs, container, running, sessionId }: {
  msgs: any[]
  container: HTMLElement
  running: boolean
  sessionId?: string
}) {
  const t = useT()
  // Nested subagent lifecycles affect this view's preventAutoCollapse decision
  // just as they do in the main transcript.
  useSyncExternalStore(subscribeSubagents, subagentsVersion, () => 0)
  // 与主转录同规则：每个思考块独立折叠，默认全折（静态视图无流式思考盒）。
  const [expandedThinkingKeys, setExpandedThinkingKeys] = useState<Set<string>>(() => new Set())
  // Static transcripts keep the tri-state collapse overrides locally; leaving
  // the view forgets them, just like the per-thinking-block expansion state.
  const [turnCollapseOverrides, setTurnCollapseOverrides] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const handler = makeTranscriptClickHandler('')
    const unbindImageMenu = bindImageContextMenu(container)
    const mediaError = makeTranscriptMediaErrorHandler()
    container.addEventListener('click', handler)
    container.addEventListener('error', mediaError, true)
    container.querySelectorAll('img').forEach(img => {
      if (img.complete && img.naturalWidth === 0) markMediaBroken(img)
    })
    return () => {
      container.removeEventListener('click', handler)
      unbindImageMenu()
      container.removeEventListener('error', mediaError, true)
    }
  }, [container])
  const unitProps = {
    isThinkingExpanded: (key: string) => expandedThinkingKeys.has(key),
    onToggleThinking: (key: string) => setExpandedThinkingKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    }),
    archived: false,
    running,
    // 子 Agent 的 user 回合是父 Agent 写的 prompt，不是输入框发的：原文直接出，
    // 不猜粘贴 chip。
    composerAuthored: false,
    readOnly: true,
    sessionId,
    // This is the static/read-only view, so no message is editable. A null target names
    // nothing, which is what `isEditTarget` needs; the action bar also suppresses Edit for
    // readOnly. Both guards, so a future non-readOnly reuse cannot silently enable it.
    editTarget: null,
  }
  const toggleFold = (foldKey: string, open: boolean) => setTurnCollapseOverrides(prev => ({
    ...prev,
    [foldKey]: open,
  }))
  const units = unitsFromMessages(msgs || [])
  const groups = foldTurnGroups(
    units,
    running ? 'tail' : null,
    {},
    turnCollapseOverrides,
  )
  const controller = transcriptScrollControllerFor(container)
  const nodes = groups.flatMap(group => group.nodes)
  const currentTurnId = units.at(-1)?.turnId
  const currentUnits = currentTurnId ? units.filter(unit => unit.turnId === currentTurnId) : units.slice(units.map(unit => unit.type).lastIndexOf('user') + 1)
  const waitingAgents = waitingSubagentNames(currentUnits.flatMap(unit => unit.segment?.tools || []))
  const pendingTools = pendingWaitingTools(currentUnits.flatMap(unit => unit.segment?.tools || []))
  const waiting = running && !currentUnits.some(unit => unit.isFinalReply && unit.segment?.text?.trim() || unit.type === 'ask-user')
    && (!pendingTools.length || waitingAgents.length > 0)
  const renderNode = (node: RenderNode) =>  node.kind === 'history-gap' ? null : node.kind === 'activity-fold'
        ? <ActivityFold node={node} key={node.key} {...unitProps} sessionId={sessionId || ''} onToggle={() => toggleFold(node.foldKey, node.open)} />
        : node.kind === 'turn-fold'
          ? <TurnFold node={node} key={node.key} unitProps={unitProps} sessionId={sessionId || ''} onToggleFold={toggleFold} />
        // 子 Agent 的编辑已经被折进父回合那份记录里，区块归父转录；这里再出一遍
        // 就是同一批文件报两次。
        : node.kind === 'turn-changes'
          ? null
          : node.kind === 'turn-agents'
            ? <TurnAgentRows key={node.key} tools={node.tools} sessionId={sessionId || ''} turnInterrupted={node.turnInterrupted} turnId={node.turnId} />
            : node.kind === 'turn-visuals'
              ? (sessionId ? <VisualArtifactsBlock sessionId={sessionId} artifacts={node.artifacts} key={node.key} /> : null)
              : node.kind === 'turn-media'
                ? <TurnMediaBlock paths={node.paths} sessionId={sessionId || ''} key={node.key} />
                : node.kind === 'worktree-init'
                  ? null
                  : node.kind === 'work-divider'
                    ? <TurnWorkDivider startedAtMs={node.startedAtMs} completedAtMs={node.completedAtMs} key={node.key} />
                    : <UnitView unit={node.unit} key={node.unit.key} {...unitProps} />
  const renderGroup = (key: string) => {
    const group = groups.find(group => group.key === key)
    return group ? <div data-klaus-transcript-turn="" data-klaus-transcript-turn-id={group.turnId} data-klaus-transcript-turn-key={group.key}>
      {group.nodes.map(renderNode)}
    </div> : null
  }
  return (
    <AgentEntranceProvider units={units} readOnly>
      {controller && sessionId && groups.length > 0 ? <VirtualTranscript sessionId={sessionId} container={container} controller={controller}
        entries={groups.map(group => ({ key: group.key, turnId: group.turnId }))} renderRow={renderGroup} latestKey={groups.at(-1)?.key ?? null} placementKey={null}
        phase={running ? 'prework' : 'idle'} running={running} onApiChange={ignoreVirtualListApi} /> : nodes.map(renderNode)}
      {waiting ? <ActivityWaitingIndicator label={waitingAgents.length
        ? t('activity_waiting_for_agents').replace('{agents}', new Intl.ListFormat(intlLocale()).format(waitingAgents)) : undefined} /> : null}
    </AgentEntranceProvider>
  )
}

function ignoreVirtualListApi(_api: VirtualTurnListApi | null): void {}
import { clientMessageId } from '../../../../contracts/message-identity'
