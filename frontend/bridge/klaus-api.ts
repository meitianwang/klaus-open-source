import type { PptChatRequest } from './ppt-api'
import type { BrowserImportRequest } from '../../contracts/browser-import'
import type { BrowserImportJobSnapshot } from '../../contracts/browser-import-jobs'
import type { BrowserAutofillProfileInput, BrowserAutofillProfileKind, BrowserPasswordInput, BrowserPasswordImportRow } from '../../contracts/browser-credentials'
import type { WindowsSandboxReadinessResponse, WindowsSandboxSetupStartParams, WindowsSandboxSetupStartResponse, WindowsSandboxSetupCompletedNotification } from '../../contracts/windows-sandbox'
import type { StorageSnapshot, StorageReviewRow, StorageCleanupOptions } from '../../main/services/device-storage'
import type { StorageChatsChanged } from '../../contracts/storage-settings'
import type { WorktreeStorageList, WorktreeStorageSettings, WorktreeStorageSettingsPatch } from '../../contracts/worktree-storage'
import type { FastModeState } from '../../shared/model-fast-mode'
import type { GranularApprovalPolicy, PermissionSelection, PermissionPreset, RuntimeConfigScope, RuntimeConfigSnapshot } from '../../contracts/runtime-settings'
import type { WorkspaceDependenciesResponse } from '../../contracts/workspace-dependency-settings'
// The `window.klaus` surface.
//
// One entry per host capability the UI can reach, and nothing else: no business
// logic lives here, every method is a named channel plus its argument shape.
// That makes this file the single readable inventory of the UI→shell contract,
// and it is what `scripts/audit-command-map.mjs` parses to prove the shell routes
// every channel the UI can call (and that the shell has no arms the UI never
// reaches).
//
// `webview-integration` is imported for its side effects and must be evaluated
// before any UI script runs, because it installs the drag-region, external-link,
// close, context-menu, and notification behaviour the UI assumes is already there.
import { removeQueuedWithReceipt, type RemovalRequest } from './queue-removal'
import { addQueuedWithReceipt } from './queue-addition'
import type { PetMainCapture } from '../../contracts/desktop-pet-appshot'
import './webview-integration.js'
import type { FriendsSnapshot, FriendProfile, FriendsRuntimeSnapshot, FriendAppsSnapshot, FriendTaskGrant, FriendCard, FriendMessageIntent, FriendOnReply } from '../../shared/friends'
import type { BrowserTabMention } from '../../shared/browser-tab-mention'
import type { SessionMentionPage, SessionMentionRequest } from '../../shared/session-mentions'
import type { SiteOpenRequest, SiteOpenResult, SiteOpenTargets } from '../../contracts/browser-sites'
import type { DesktopDistribution } from '../../shared/desktop-edition'
import { desktopDistribution } from '../src/app/distribution'
import type { DiffOptions } from '../../contracts/git-changes'
import type { PowerSavePreferences, PowerSaveRequest, PowerSaveSnapshot } from '../../contracts/power-save'
import type { CollaborationFileScope, CollaborationRequest } from '../../contracts/team-collaboration'
import type { TurnInterruptReply, CollaborationMode, GoalMutation, GoalObjectiveInput, GoalSnapshot, GoalUpdated, PreparedGoalObjective, PlanningReply, PlanningUpdated, PlanIdentity, PlanDocumentReply, PlanAcceptance, PlanFeedback, PlanActionReply, PlanningInputRequest, PlanningInputResponse } from '../../contracts/planning-goals'
import type { AsyncQuestionRequest, AsyncQuestionResolution } from '../../contracts/async-questions'
import type { FilePreview } from '../../main/services/team-collaboration/files'
import type { LocalCollaborationAgent } from '../../main/services/team-collaboration/agents'
import { teamIssueDeepLink, type TeamIssueDeepLink } from '../../main/app/deep-links'
import type { CollaborationUpdate, DesktopCollaborationResponse, DraftOptions, ExecuteOptions, ExecutionReply, IssueDraft, IssueDraftOptions, LocalBinding, ProjectDraft } from '../../main/services/team-collaboration/types'
import type { KeybindingUpdate, KeymapState } from '../../contracts/keybindings.js'
import { call, post, subscribe, expose, localFilePath, type Unsubscribe } from './ipc.js'

async function browserDataReply(pending: Promise<any>): Promise<any> {
  const result = await pending
  if (result && result.ok === false) throw new Error(String(result.error || 'Browser data operation failed.'))
  return result
}
import { petApi } from './pet-api.js'
import type { VoiceChatAnswer, VoiceChatAudioFrame, VoiceChatControl, VoiceChatEvent, VoiceChatLevels, VoiceChatOffer, VoiceChatPresentation, VoiceChatState } from '../../contracts/voice-chat'
import { localMediaUrl } from './media-url'
import type {
  BackgroundProcessChangedPush,
  BackgroundProcessOutputReply,
  BackgroundProcessSnapshotReply,
  BackgroundProcessStopReply,
  BlenderInstallPush,
  BrowserUseOpenRequest,
  ComputerUsePipHostLayout,
  ComputerUsePipState,
  ComputerUsePipVisibilityRequest,
  FeatureModelPatch,
  FeatureModelsReply,
  GlobalModelTierOptions,
  GlobalModelTierReply,
  MainModelSelection,
  ModelTierName,
  ModelTierReference,
  QueueEditRequest,
  QueueRemoveRequest,
  QueueReorderRequest,
} from './types.js'

expose('klaus', {
  desktopPet: { ...petApi, setMainConversation: (sessionId: string | null): Promise<void> => call('desktop-pet:set-main-conversation', { sessionId }) },
  composerPredictions: {
    source: (sessionId: string): Promise<{ turnId: string | null; reason?: string }> => call('composer:prediction:source', { sessionId }),
    get: (sessionId: string, turnId: string, trigger: 'live' | 'catch_up') =>
      call('composer:prediction', { sessionId, turnId, trigger }),
    cancel: (sessionId: string) => call('composer:prediction:cancel', { sessionId }),
    availability: (): Promise<{ available: boolean; reason?: string }> => call('composer:prediction:availability'),
  },
  teamCollaboration: {
    request: <R extends CollaborationRequest>(request: R): Promise<DesktopCollaborationResponse<R['type']>> =>
      call('collaboration:request', request),
    localBinding: (projectId: string): Promise<LocalBinding> =>
      call('collaboration:local-binding', { projectId }),
    setLocalBinding: (projectId: string, localFolder: string | null): Promise<LocalBinding> =>
      call('collaboration:set-local-binding', { projectId, localFolder }),
    pickLocalFolder: (projectId: string): Promise<LocalBinding> =>
      call('collaboration:pick-local-folder', { projectId }),
    draftProject: (prompt: string, options: DraftOptions): Promise<ProjectDraft> =>
      call('collaboration:draft-project', { prompt, ...options }),
    draftIssue: (prompt: string, options: IssueDraftOptions): Promise<IssueDraft> =>
      call('collaboration:draft-issue', { prompt, ...options }),
    cancelDraft: (requestId: string): Promise<{ cancelled: boolean }> =>
      call('collaboration:cancel-draft', { requestId }),
    execute: (options: ExecuteOptions): Promise<ExecutionReply> =>
      call('collaboration:execute', options),
    downloadFile: (scope: CollaborationFileScope, fileId: string): Promise<{ saved: boolean; name: string }> =>
      call('collaboration:download-file', { scope, fileId }),
    previewFile: (scope: CollaborationFileScope, fileId: string): Promise<FilePreview> =>
      call('collaboration:preview-file', { scope, fileId }),
    localAgents: (): Promise<LocalCollaborationAgent[]> =>
      call('collaboration:local-agents', {}),
    issueLink: (projectId: string, issueId: string): string => teamIssueDeepLink(projectId, issueId, desktopDistribution().protocol),
    watch: (projectId: string | null): Promise<{ watching: string | null }> =>
      call('collaboration:watch', { projectId }),
    onUpdated: (handler: (event: CollaborationUpdate) => void): Unsubscribe =>
      subscribe('collaboration:updated', handler),
  },

  // Server-controlled feature gates. `snapshot` reads the host's resolved
  // key→boolean map (server values over fail-closed client defaults);
  // `onUpdated` fires whenever a background refresh changes a resolved value,
  // so a gated feature can appear or disappear while the app runs.
  featureGates: {
    snapshot: (): Promise<{ features: Record<string, boolean> }> => call('featureGates:snapshot'),
    onUpdated: (handler: (payload: { features: Record<string, boolean> }) => void): Unsubscribe =>
      subscribe('feature-gates:updated', handler),
  },
  // Control-plane guide config. `snapshot` reads the host's last accepted
  // payload (null when the server published nothing usable); `onUpdated` fires
  // whenever a refresh or an account change moves it, including to null, so a
  // withdrawn guide disappears while the app runs. The guide is fail-closed:
  // no answer means no guide.
  onboardingGuide: {
    snapshot: (): Promise<unknown> => call('onboardingGuide:snapshot'),
    onUpdated: (handler: (payload: { config: unknown }) => void): Unsubscribe =>
      subscribe('onboarding-guide:updated', handler),
  },
  // Chat
  chat: {
    send: (sessionId: string, text: string, media?: any[], displayMetadata?: any) => {
      console.log('[bridge] chat.send invoked', { sessionId, textLen: text?.length })
      return call('chat:send', { sessionId, text, media, displayMetadata })
        .then((r) => { console.log('[bridge] chat.send resolved'); return r })
        .catch((e) => { console.error('[bridge] chat.send ERROR', e); throw e })
    },
    // `expectedTurnId` scopes the stop to the Turn the user was looking at. The
    // host refuses the request when the session has already moved on, so a stop
    // that was still in flight cannot abort the Turn that started next.
    interrupt: (sessionId: string, expectedTurnId?: string | null): Promise<TurnInterruptReply> =>
      call('chat:interrupt', { sessionId, expectedTurnId: expectedTurnId ?? undefined }),
    interruptTurn: (sessionId: string, expectedTurnId: string): Promise<TurnInterruptReply> =>
      call('chat:interrupt', { sessionId, expectedTurnId, origin: 'targeted-turn' }),
    // Continue a stopped or failed Turn: a NEW Turn with no user input, so the model
    // picks the thread back up instead of re-sending the last message. Named
    // separately from `send` for exactly that reason.
    continueTurn: (sessionId: string) =>
      call('chat:continue', { sessionId }),
    followUp: (sessionId: string, text: string, media?: any[], displayMetadata?: any) =>
      call('chat:follow-up', { sessionId, text, media, displayMetadata }),
    queuedFollowUps: (sessionId: string) =>
      call('chat:queued-follow-ups', { sessionId }),
    queueSnapshot: (sessionId: string) =>
      call('chat:queue-snapshot', { sessionId }),
    editQueued: (sessionId: string, request: QueueEditRequest) =>
      call('chat:edit-queued', { sessionId, request }),
    removeQueued: (sessionId: string, request: QueueRemoveRequest) =>
      call('chat:remove-queued', { sessionId, request }),
    reorderQueued: (sessionId: string, request: QueueReorderRequest) =>
      call('chat:reorder-queued', { sessionId, request }),
    // The client-owned follow-up queue: the host stores it durably, dispatches it
    // after each turn ends, and answers every mutation with the new snapshot.
    clientQueueSnapshot: (sessionId: string) =>
      call('chat:client-queue-snapshot', { sessionId }),
    // `anchors` carries BOTH former neighbours of a re-inserted row, so an edited or
    // undone message returns to its old position even if one neighbour has since been
    // dispatched or deleted.
    clientQueueAdd: (sessionId: string, id: string, item: unknown, anchors: { afterId?: string | null; beforeId?: string | null } = {}) =>
      addQueuedWithReceipt(request => call('chat:client-queue-add', request), { sessionId, id, item, afterId: anchors.afterId || null, beforeId: anchors.beforeId || null }),
    clientQueueRemove: (sessionId: string, id: string, expectedRevision?: number, identity?: Pick<RemovalRequest, 'clientMutationId' | 'mutationFingerprint'>) =>
      removeQueuedWithReceipt(request => call('chat:client-queue-remove', request), { sessionId, id, expectedRevision }, identity),
    clientQueueRestore: (sessionId: string, row: unknown, anchors: { afterId?: string | null; beforeId?: string | null } = {}, options: { requireRemovedReceipt?: boolean } = {}) =>
      call('chat:client-queue-restore', { sessionId, row, afterId: anchors.afterId || null, beforeId: anchors.beforeId || null, requireRemovedReceipt: options.requireRemovedReceipt !== false }),
    clientQueueReorder: (sessionId: string, id: string, beforeId?: string | null, expectedRevision?: number) =>
      call('chat:client-queue-reorder', { sessionId, id, beforeId: beforeId || null, expectedRevision }),
    // `dispatch: false` clears the interruption marks WITHOUT sending the head row:
    // used when the user's own new message is about to start a turn, which would
    // otherwise lose the race to a dispatch started at the same moment.
    clientQueueResume: (sessionId: string, dispatch = true) =>
      call('chat:client-queue-resume', { sessionId, dispatch }),
    clientQueueDeliver: (sessionId: string, id: string, options: { expectedRevision?: number; expectedTurnId?: string; requireExpectedTurn?: boolean; allowUnconfirmedRetry?: boolean } = {}) =>
      call('chat:client-queue-deliver', { sessionId, id, ...options }),
    clientQueueClear: (sessionId: string) =>
      call('chat:client-queue-clear', { sessionId }),
    sideQuestion: (sessionId: string, question: string, requestId: string) =>
      call('chat:side-question', { sessionId, question, requestId }),
    cancelSideQuestion: (requestId: string) =>
      call('chat:side-question:cancel', { requestId }),
    uploadFile: (name: string, type: string, buffer: ArrayBuffer) =>
      call('chat:upload', { name, type, buffer }),
    uploadFilePath: (path: string) =>
      call('chat:upload-path', { path }),
    localFilePath,
    /** Store a large composer paste as a host-owned text file; returns its reference. */
    pastedTextCreate: (text: string) =>
      call('chat:pasted-text-create', { text }),
    /** Read a stored paste back so the composer can restore it as editable text. */
    pastedTextRead: (path: string) =>
      call('chat:pasted-text-read', { path }),
    /** Delete a stored paste a draft no longer references. */
    pastedTextRemove: (path: string) =>
      call('chat:pasted-text-remove', { path }),
    /** Drop ledger ownership after submit; the sent message keeps the file. */
    pastedTextRelease: (paths: string[]) =>
      call('chat:pasted-text-release', { paths }),
    /** Truncate transcript at the target user message, keeping files on disk.
     *  Returns the removed draft's text, media/file paths and display metadata for composer restoration. */
    rewindFrom: (sessionId: string, messageUuid: string, turnId?: string) =>
      call('chat:rewind-from', { sessionId, messageUuid, ...(turnId ? { turnId } : {}) }),
    /**
     * Edit the LAST user message in place: truncate the conversation from it and
     * re-send the edited text as a new turn. Files the
     * dropped turn wrote are left alone — that is what separates this from a rewind.
     * Refusals come back soft as `{ok:false, reason}`.
     *
     * A bubble that never learned the uuid the engine assigned it — the optimistic one
     * a stopped turn leaves on screen — passes `turnId` instead and leaves
     * `messageUuid` empty; the host resolves the turn to its user message through the
     * engine's own history. Passing `media` rebuilds the whole payload like a normal
     * send, so attachments can be added or removed; omitting it keeps the original
     * message's attachments and swaps only its text.
     */
    editMessage: (sessionId: string, messageUuid: string, text: string, displayMetadata?: any, media?: any[], turnId?: string) =>
      call('chat:edit-message', { sessionId, messageUuid, text, displayMetadata, media, turnId }),
    /**
     * Read one sent user message back as a composer payload: the user's own wording plus
     * its attachments as a `media` manifest, so an edit refills the real composer and can
     * add or remove attachments like a normal send. Changes nothing.
     *
     * Takes the same `messageUuid`-or-`turnId` handle as `editMessage`, because the
     * bubble a stopped turn leaves on screen never learned its engine uuid.
     */
    editPrepare: (sessionId: string, messageUuid: string, turnId?: string) =>
      call('chat:edit-prepare', { sessionId, messageUuid, turnId }),
  },

  feedback: {
    submit: (sessionId: string, description: string) =>
      call('feedback:submit', { sessionId, description }),
    submitSuggestion: (payload: { description: string, attachments?: Array<{ path: string, name?: string, size?: number, contentType?: string }> }) =>
      call('feedback:suggestion-submit', payload),
    pickAttachments: () => call('feedback:pick-attachments'),
    captureScreenshot: () => call('feedback:capture-screenshot'),
  },

  // Clipboard access is host-owned. Chromium's Clipboard API is permission and
  // transient-activation sensitive on custom app origins, while Electron's native
  // clipboard has the exact desktop semantics the UI expects.
  clipboard: {
    readFilePaths: () => call('clipboard:read-file-paths'),
    readText: () => call('clipboard:read-text'),
    writeText: (text: string) => call('clipboard:write-text', { text }),
  },

  profile: {
    activity: (): Promise<import('../../contracts/profile').ProfileActivity> => call('profile:activity'),
  },

  // Sessions
  session: {
    new: (opts?: { workdir?: string | null; workspaceId?: string | null; projectRoot?: string | null }) => call('session:new', opts ?? {}),
    list: () => call('session:list'),
    /**
     * Search conversation titles for the composer menu. Empty or whitespace-only
     * queries return no items. The host searches its cached catalog and returns
     * only `{id,title}` rows; pass `nextCursor` back to continue a page.
     */
    mentionCandidates: (opts: SessionMentionRequest = {}): Promise<SessionMentionPage> =>
      call('session:mention-candidates', opts),
    runtimeState: (sessionIds?: string[]): Promise<import('../../contracts/session-runtime').SessionRuntimeRead> =>
      call('session:runtime-state', sessionIds ? { sessionIds } : undefined),
    listArchived: () => call('session:list-archived'),
    retainView: (sessionId: string, viewId: string) => call('session:view-retain', { sessionId, viewId }),
    releaseView: (sessionId: string, viewId: string) => call('session:view-release', { sessionId, viewId }),
    /** Fork a conversation into a branch. `beforeMessageUuid` cuts the
     *  inherited history strictly BEFORE that message (「在新任务中继续」);
     *  omit it for a full-transcript branch. The source stays untouched. */
    fork: (sessionId: string, opts?: { beforeMessageUuid?: string; inheritGoal?: boolean }) =>
      call('session:fork', { sessionId, ...(opts?.beforeMessageUuid ? { beforeMessageUuid: opts.beforeMessageUuid } : {}), ...(opts?.inheritGoal ? { inheritGoal: true } : {}) }),
    listSideTasks: (parentSessionId: string) =>
      call('side-task:list', { parentSessionId }),
    createSideTask: (parentSessionId: string, options?: { initialTitleIndex: number }) =>
      call('side-task:create', { parentSessionId, ...(options ? { initialTitleIndex: options.initialTitleIndex } : {}) }),
    touchSideTask: (sessionId: string) =>
      call('side-task:touch', { sessionId }),
    closeSideTask: (sessionId: string) =>
      call('side-task:close', { sessionId }),
    archive: (sessionId: string, displayTitle?: string) => call('session:archive', { sessionId, displayTitle }),
    unarchive: (sessionId: string) => call('session:unarchive', { sessionId }),
    delete: (sessionId: string, opts?: { wipeWorkspace?: boolean }) =>
      call('session:delete', { sessionId, wipeWorkspace: !!opts?.wipeWorkspace }),
    rename: (sessionId: string, title: string) => call('session:rename', { sessionId, title }),
    setPinned: (sessionId: string, pinned: boolean) => call('session:set-pinned', { sessionId, pinned }),
    export: (sessionId: string) => call('session:export', { sessionId }),
    history: (sessionId: string) => call('session:history', { sessionId }),
    /** One page of saved turns with their turn shells; the renderer drives
     *  transcript pagination through this plus `historyItems` instead of
     *  assembling the whole transcript in one call. */
    historyPage: (sessionId: string, opts?: { cursor?: string | null; limit?: number; itemsView?: string; sortDirection?: string }) =>
      call('session:history-page', {
        sessionId,
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.itemsView ? { itemsView: opts.itemsView } : {}),
        ...(opts?.sortDirection ? { sortDirection: opts.sortDirection } : {}),
      }),
    /** One page of ONE turn's messages, by message cursor. */
    historyItems: (sessionId: string, opts: { turnId: string; cursor?: string | null; beforeItemId?: string | null; limit?: number; sortDirection?: string }) =>
      call('session:history-items', {
        sessionId,
        turnId: opts.turnId,
        ...(opts.beforeItemId ? { beforeItemId: opts.beforeItemId } : {}),
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.sortDirection ? { sortDirection: opts.sortDirection } : {}),
      }),
    /** The files THIS session changed, folded per file, with the summed line
     *  counts its edits reported. Not a git diff: it stays answerable outside a
     *  repository and survives a commit made mid-session. The Changes surface
     *  keeps asking `diff:summary` for the whole project. */
    fileChanges: (sessionId: string) => call('session:file-changes', { sessionId }),
    backgroundProcesses: (sessionId: string): Promise<BackgroundProcessSnapshotReply> =>
      call('session:background-processes', { sessionId }),
    backgroundProcessOutput: (
      sessionId: string,
      shellId: string,
      options?: { afterOffset?: number; maxBytes?: number },
    ): Promise<BackgroundProcessOutputReply> => call('session:background-process-output', {
      sessionId,
      shellId,
      ...(options?.afterOffset !== undefined ? { afterOffset: options.afterOffset } : {}),
      ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    }),
    stopBackgroundProcess: (
      sessionId: string,
      shellId: string,
      signal?: string,
    ): Promise<BackgroundProcessStopReply> => call('session:stop-background-process', {
      sessionId,
      shellId,
      ...(signal ? { signal } : {}),
    }),
    /** Returns { custom: string|null, hasMessages: boolean } — drives the
     *  workdir button label and the "switch mid-conversation" confirm guard. */
    getWorkdir: (sessionId: string) => call('session:get-workdir', { sessionId }),
    /** Returns the effective cwd for the session: project root or default session workspace. */
    getResolvedWorkdir: (sessionId: string) => call('session:get-resolved-workdir', { sessionId }),
    /** Opens the native directory picker. Resolves { path: string|null }. */
    pickWorkdir: () => call('session:pick-workdir'),
    /** Opens the native directory picker in multi-select mode. Resolves { paths: string[] }, empty when cancelled. */
    pickWorkdirs: () => call('session:pick-workdirs'),
    setWorkdir: (sessionId: string, dir: string) => call('session:set-workdir', { sessionId, dir }),
    clearWorkdir: (sessionId: string) => call('session:clear-workdir', { sessionId }),
    /** Bind a session to a multi-folder workspace: its primary root becomes the
     *  cwd and the extra roots ride along as additional writable roots. A null
     *  workspaceId clears both bindings, so the session falls back to projectless. */
    setWorkspace: (sessionId: string, workspaceId: string | null) =>
      call('session:set-workspace', { sessionId, workspaceId }),
    /** Per-session main model picker. With no session, reads or writes the
     *  remembered default used when the next conversation is created. */
    getMainModel: (sessionId?: string | null, options?: { resolve?: boolean }): Promise<MainModelSelection> =>
      call('session:get-main-model', { ...(sessionId ? { sessionId } : {}), ...options }),
    getMainModelOptions: (source?: string) =>
      source ? call('session:get-main-model-options', { source }) : call('session:get-main-model-options'),
    getCustomMainModelOptions: () => call('session:get-custom-main-model-options'),
    setMainModel: (mode: string, sessionId?: string | null, source?: string) =>
      call('session:set-main-model', { mode, ...(sessionId ? { sessionId } : {}), ...(source ? { source } : {}) }),
    getPermissionMode: (sessionId?: string | null): Promise<PermissionSelection> =>
      call('session:get-permission-mode', { ...(sessionId ? { sessionId } : {}) }),
    setPermissionMode: (
      mode: PermissionPreset,
      sessionId?: string | null,
    ) => call('session:set-permission-mode', { mode, ...(sessionId ? { sessionId } : {}) }),
    /** Per-session thinking level: off / low / medium / high / xhigh / max. With
     *  no session, reads or writes the default the next conversation starts with. */
    getThinkingLevel: (sessionId?: string | null) =>
      call('session:get-thinking-level', { ...(sessionId ? { sessionId } : {}) }),
    setThinkingLevel: (level: string, sessionId?: string | null, options?: { ultraMode?: false }) =>
      call('session:set-thinking-level', { level, ...(sessionId ? { sessionId } : {}), ...(options?.ultraMode === false ? { ultraMode: false } : {}) }),
    /** Per-session local orchestration mode. Only unscoped selections write the
     *  future default; existing conversations retain their own selections. */
    getUltraMode: (sessionId?: string | null): Promise<{ enabled: boolean }> =>
      call('session:get-ultra-mode', { ...(sessionId ? { sessionId } : {}) }),
    setUltraMode: (enabled: boolean, sessionId?: string | null, options?: { permissionMode?: PermissionPreset }) =>
      call('session:set-ultra-mode', { enabled, ...(sessionId ? { sessionId } : {}), ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}) }),
    /** Fast mode availability depends on the selected source and remains session-scoped. */
    getFastMode: (sessionId?: string | null): Promise<FastModeState> =>
      call('session:get-fast-mode', { ...(sessionId ? { sessionId } : {}) }),
    setFastMode: (enabled: boolean, sessionId?: string | null) =>
      call('session:set-fast-mode', { enabled, ...(sessionId ? { sessionId } : {}) }),
    getCollaborationMode: (sessionId: string): Promise<PlanningReply> => call('session:get-collaboration-mode', { sessionId }),
    setCollaborationMode: (sessionId: string, mode: CollaborationMode, expectedRevision?: number): Promise<PlanningReply> =>
      call('session:set-collaboration-mode', { sessionId, mode, expectedRevision }),
    /** Compatibility accessors for saved planning UI state. */
    getSpecMode: (sessionId: string) => call('session:get-spec-mode', { sessionId }),
    setSpecMode: (sessionId: string, enabled: boolean) => call('session:set-spec-mode', { sessionId, enabled }),
    /** Open the approved spec document (plans dir / project .klaus/specs only). */
    openSpecDoc: (path: string) => call('spec:open-doc', { path }),
    /** Read the spec document for the in-app review panel (same path allowlist). */
    readSpecDoc: (path: string) => call('spec:read-doc', { path }),
    saveSpecDoc: (name: string, content: string) => call('spec:save-doc', { name, content }),
  },

  planningInput: {
    pending: (sessionId: string): Promise<PlanningInputRequest[]> => call('planning-input:pending', { sessionId }),
    answer: (sessionId: string, input: PlanningInputResponse): Promise<PlanningReply & { accepted: boolean }> => call('planning-input:answer', { sessionId, ...input }),
    cancel: (sessionId: string, input: Omit<PlanningInputResponse, 'status' | 'answers'>): Promise<PlanningReply & { accepted: boolean }> =>
      call('planning-input:answer', { sessionId, ...input, answers: {}, status: 'cancelled' }),
  },
  plan: {
    get: (sessionId: string): Promise<PlanningReply> => call('plan:get', { sessionId }),
    readDocument: (sessionId: string, input: PlanIdentity): Promise<PlanDocumentReply> => call('plan:read-document', { sessionId, ...input }),
    saveDocument: (sessionId: string, input: PlanIdentity & { content: string; expectedContent?: string }): Promise<PlanDocumentReply> => call('plan:save-document', { sessionId, ...input }),
    accept: (sessionId: string, input: PlanAcceptance): Promise<PlanActionReply> => call('plan:accept', { sessionId, ...input }),
    feedback: (sessionId: string, input: PlanFeedback): Promise<PlanActionReply> => call('plan:feedback', { sessionId, ...input }),
    cancel: (sessionId: string, input: PlanIdentity): Promise<PlanningReply> => call('plan:cancel', { sessionId, ...input }),
  },
  goal: {
    get: (sessionId: string): Promise<GoalSnapshot> => call('goal:get', { sessionId }),
    set: (sessionId: string, input: GoalMutation): Promise<GoalSnapshot & { ok: boolean; admission?: 'scheduled' | 'steered' | 'deferred' }> => call('goal:set', { sessionId, ...input }),
    clear: (sessionId: string, input?: { expectedGoalId?: string | null; expectedGoalRevision?: number; origin?: 'user' | 'automatic' }): Promise<GoalSnapshot & { ok: boolean; cleared: boolean }> => call('goal:clear', { sessionId, ...input }),
    prepareObjective: (sessionId: string, input: GoalObjectiveInput): Promise<PreparedGoalObjective> => call('goal:prepare-objective', { sessionId, input }),
    readObjective: (sessionId: string, objective: string): Promise<{ content: string }> => call('goal:read-objective', { sessionId, objective }),
    discardPreparedObjective: (sessionId: string, preparationId: string): Promise<{ ok: boolean }> => call('goal:discard-prepared-objective', { sessionId, preparationId }),
  },

  // Project workspace roots (project registry). Conversations
  // carry a session workdir; this global state decides what new chats inherit.
  projects: {
    list: () => call('projects:list'),
    add: (path: string, label?: string) => call('projects:add', { path, label }),
    remove: (path: string) => call('projects:remove', { path }),
    setActive: (path: string | null) => call('projects:set-active', { path }),
    resolveRoot: (path: string) => call('projects:resolve-root', { path }) as Promise<{ root: string | null } | null | undefined>,
    // Persist the dragged Projects-section order. `keys` is the section's
    // complete top-to-bottom key list (workspace containers `ws:<id>`, friend
    // groups `friend:<id>`, project paths interleaved as shown); the host
    // answers with the refreshed projects:list payload.
    reorder: (keys: string[]) => call('projects:reorder', { keys }),
  },
  // Multi-folder workspaces (settings.db workspace.groups KV). A workspace
  // groups >=1 registered roots under a name; roots[0] is the PRIMARY root the
  // bound session runs in. list returns { workspaces: [{id,name,roots}] }; save
  // creates (omit id) or updates (with id) and echoes the id back.
  workspaces: {
    list: () => call('workspaces:list'),
    save: (input: { id?: string; name?: string; roots: string[] }) => call('workspaces:save', input),
    delete: (id: string, deleteSessions?: boolean) => call('workspaces:delete', { id, ...(deleteSessions ? { deleteSessions: true } : {}) }),
  },

  // SSH remote projects (project picker "Connect SSH"). Hosts are read from
  // ~/.ssh/config; connect/browse go through the system ssh binary in the
  // main process — the renderer only passes opaque target strings around.
  // Password prompts arrive over `onAskpass` and are answered per requestId
  // (null password = user cancelled → ssh aborts the auth attempt).
  ssh: {
    listHosts: () => call('ssh:list-hosts'),
    test: (target: string) => call('ssh:test', { target }),
    listDirs: (target: string, path: string) => call('ssh:list-dirs', { target, path }),
    makeWorkdir: (target: string, path: string) => call('ssh:make-workdir', { target, path }),
    onAskpass: (cb: (payload: { requestId: string; prompt: string; echo?: boolean }) => void) =>
      subscribe('ssh:askpass', cb),
    answerAskpass: (requestId: string, password: string | null) =>
      call('ssh:askpass-answer', { requestId, password }),
  },

  // Managed slash commands (settings page CRUD over file-backed custom
  // commands: global ~/.klaus/commands + per-project <root>/.klaus/commands).
  commands: {
    list: (opts?: { projectRoot?: string; workspaceId?: string }) =>
      call('commands:list', { projectRoot: opts?.projectRoot, workspaceId: opts?.workspaceId }),
    save: (input: {
      scope: 'global' | 'project'
      projectRoot?: string
      workspaceId?: string
      name: string
      description?: string
      argumentHint?: string
      body?: string
      originalName?: string
    }) => call('commands:save', input),
    remove: (input: { scope: 'global' | 'project'; projectRoot?: string; workspaceId?: string; name: string }) =>
      call('commands:delete', input),
  },

  externalAgentImport: {
    detect: (opts?: { includeHome?: boolean; workspaceRoots?: string[] }) =>
      call('external-agent-import:detect', opts ?? {}),
    import: (items: any[]) => call('external-agent-import:import', { items }),
    status: () => call('external-agent-import:status'),
  },

  // Tasks (engine TaskCreate/TaskUpdate state, drives the task panel)
  tasks: {
    list: (sessionId: string) => call('tasks:list', { sessionId }),
  },

  // Agent / teammate task snapshot (legacy BackgroundTasksDialog data feed).
  // Renderer calls this on session switch so the agent panel hydrates from
  // the authoritative appState.tasks Record without waiting on chat events.
  agents: {
    snapshot: (sessionId: string) => call('agents:snapshot', { sessionId }),
    // Engine-direct read of the session's background sub-agents (run_in_background
    // tasks + persistent swarm teammates), straight from Session.backgroundAgentSummaries().
    backgroundSummaries: (sessionId?: string) => call('agents:background-summaries', { sessionId }),
    // Sub-agent transcript projection (teammate view data source).
    history: (sessionId: string, agentId: string) => call('agents:history', { sessionId, agentId }),
    // In-process teammate messages from AppState (no JSONL file — read memory).
    teammateMessages: (sessionId: string, taskId: string) => call('agents:teammate-messages', { sessionId, taskId }),
    // Persistent task cache — renderer writes after every mergeAgentTasks;
    // loaded on session switch to restore completed agents across restarts.
    saveTasks: (sessionId: string, tasks: Record<string, unknown>) => call('agents:save-tasks', { sessionId, tasks }),
    loadTasks: (sessionId: string) => call('agents:load-tasks', { sessionId }),
    definitions: {
      list: (sessionId?: string) => call('agents:definitions:list', { sessionId }),
      read: (id: string) => call('agents:definitions:read', { id }),
      save: (id: string | null, content: string) => call('agents:definitions:save', { id, content }),
      delete: (id: string) => call('agents:definitions:delete', { id }),
    },
    // 子智能体广场：服务端目录的浏览与安装。卸载不开新通道——装完就是普通的
    // 用户智能体文件，删除仍走 definitions.delete，只保留一种回收站行为。
    market: (opts?: { query?: string }) => call('agents:market', opts),
    install: (slug: string, version?: string) => call('agents:install', { slug, version }),
  },

  // Engine introspection / control surfaces that don't fit chat or session.
  // - contextStats: snapshot of the session's context window for the monitor panel
  // - compact:      manual /compact — replicates the host's
  //                 commands/compact/compact.ts via the unmodified engine APIs
  engine: {
    contextStats: (sessionId: string) =>
      call('engine:contextStats', { sessionId }),
    runtimeCapabilities: (sessionId: string) =>
      call('runtime:capabilities', { sessionId }),
    extensionRuntime: (sessionId: string) =>
      call('runtime:extensions', { sessionId }),
    compact: (sessionId: string, customInstructions?: string) =>
      call('engine:compactSession', { sessionId, customInstructions: customInstructions ?? '' }),
    slashCommands: (sessionId?: string, opts?: { root?: string; forceReload?: boolean }) =>
      call('engine:slashCommands', { sessionId, root: opts?.root, forceReload: opts?.forceReload }),
    workspaceFileSearch: (sessionId: string | undefined, query: string, limit?: number) =>
      call('engine:workspaceFileSearch', { sessionId, query, limit }),
    // Persistent-session counterpart to workspaceFileSearch. The picker opens one
    // session when it enters the file/folder category, re-ranks it per keystroke,
    // and stops it when the menu closes, so the tree is walked once instead of
    // once per keystroke. Returns are plain arrays/shapes, mirroring the one-shot
    // channel; a stopped or superseded query resolves empty rather than throwing.
    workspaceFileSearchSessionStart: (sessionId: string | undefined, deadlineMs?: number, root?: string) =>
      call('engine:workspaceFileSearchSessionStart', { sessionId, deadlineMs, root }),
    workspaceFileSearchSessionQuery: (searchSessionId: string, query: string, limit?: number, deadlineMs?: number) =>
      call('engine:workspaceFileSearchSessionQuery', { sessionId: searchSessionId, query, limit, deadlineMs }),
    workspaceFileSearchSessionStop: (searchSessionId: string) =>
      call('engine:workspaceFileSearchSessionStop', { sessionId: searchSessionId }),
    refreshCommands: () =>
      call('engine:refreshCommands'),
  },

  // Local media (images / video / audio / PDF) for `src` attributes. NOT a
  // channel: the URL is built synchronously here and the `klaus-media://`
  // handler (media.rs) re-checks scope and the extension whitelist on every
  // request. Synchronous on purpose — an awaited URL is what forced the old
  // per-element backfills and race guards around `artifacts:file-url`.
  media: {
    readImage: (source: { sessionId: string; filePath?: string; data?: string; mimeType?: string; name?: string }) => call('media:read-image', source),
    saveImage: (source: { sessionId: string; filePath?: string; data?: string; mimeType?: string; name?: string }) => call('media:save-image', source),
    copyImage: (source: { sessionId: string; filePath?: string; data?: string; mimeType?: string; name?: string }) => call('media:copy-image', source),
    revealImage: (source: { sessionId: string; filePath: string }) => call('media:reveal-image', source),
    url: localMediaUrl,
  },

  // Artifacts — generic file viewer plumbing reused by the workspace tree
  // (and the memory dir preview). The legacy session_artifacts list is gone;
  // these four are kept because the standalone preview window still needs to
  // read / reveal / open / show-in-finder for arbitrary file paths.
  artifacts: {
    authorizePreview: (sessionId: string, filePath: string) => call('artifacts:authorize-preview', { sessionId, filePath }),
    read: (sessionId: string, filePath: string) => call('artifacts:read', { sessionId, filePath }),
    fileUrl: (sessionId: string, filePath: string) => call('artifacts:file-url', { sessionId, filePath }),
    widgetUrl: (sessionId: string, widgetId: string, revision: number, filePath: string) =>
      call('artifacts:widget-url', { sessionId, widgetId, revision, filePath }),
    openWorkspace: (sessionId: string) => call('artifacts:open-workspace', { sessionId }),
    reveal: (filePath: string) => call('artifacts:reveal', { filePath }),
    saveCopy: (sessionId: string, filePath: string) =>
      call('artifacts:save-copy', { sessionId, filePath }) as Promise<{ ok?: boolean; cancelled?: boolean; filePath?: string; error?: string }>,
    openWindow: (sessionId: string, filePath: string, displayName?: string) =>
      call('artifacts:open-window', { sessionId, filePath, displayName }),
  },

  // Canvas — `.canvas.tsx` artifacts render in an isolated child webview whose
  // rectangle is owned by the right work panel. The main window controls only
  // that surface; generated code keeps the narrow bridge in canvas-api.ts.
  ppt: {
    list: (sessionId: string) =>
      call('ppt:list', { sessionId }) as Promise<{ presentations: { id: string; title: string }[]; error?: string }>,
    open: (id: string, sessionId: string) =>
      call('ppt:open', { id, sessionId }) as Promise<{ ok?: boolean; error?: string }>,
    openResult: (requestId: string, ok: boolean, error?: string) =>
      call('ppt:open-result', { requestId, ok, error }),
    panelShow: (id: string, sessionId: string, bounds: { x: number; y: number; width: number; height: number }) =>
      call('ppt:panel-show', { id, sessionId, bounds }) as Promise<{ ok?: boolean; error?: string }>,
    panelSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      call('ppt:panel-set-bounds', { bounds }) as Promise<{ ok?: boolean; error?: string }>,
    panelHide: () => call('ppt:panel-hide'),
    panelClose: () => call('ppt:panel-close'),
    onOpenPanel: (cb: (payload: { requestId?: string; id: string; title?: string; sessionId: string }) => void) =>
      subscribe('ppt:open-panel', cb),
    onChatRequest: (cb: (payload: PptChatRequest) => void) => subscribe('ppt:chat-request', cb),
    chatResult: (requestId: string, ok: boolean, error?: string) => call('ppt:chat-result', { requestId, ok, error }),
  },
  prototype: {
    list: (sessionId: string) =>
      call('prototype:list', { sessionId }) as Promise<{ prototypes: { id: string; title: string }[]; error?: string }>,
    open: (id: string, sessionId: string) =>
      call('prototype:open', { id, sessionId }) as Promise<{ ok?: boolean; error?: string }>,
    openResult: (requestId: string, ok: boolean, error?: string) =>
      call('prototype:open-result', { requestId, ok, error }),
    panelShow: (id: string, sessionId: string, bounds: { x: number; y: number; width: number; height: number }) =>
      call('prototype:panel-show', { id, sessionId, bounds }) as Promise<{ ok?: boolean; error?: string }>,
    panelSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      call('prototype:panel-set-bounds', { bounds }) as Promise<{ ok?: boolean; error?: string }>,
    panelHide: () => call('prototype:panel-hide'),
    panelClose: () => call('prototype:panel-close'),
    onOpenPanel: (cb: (payload: { requestId?: string; id: string; title?: string; sessionId: string }) => void) =>
      subscribe('prototype:open-panel', cb),
  },
  videoEditing: {
    list: (sessionId: string) =>
      call('video-editing:list', { sessionId }) as Promise<{ videos: { id: string; title: string }[]; error?: string }>,
    open: (id: string, sessionId: string) =>
      call('video-editing:open', { id, sessionId }) as Promise<{ ok?: boolean; error?: string }>,
    openResult: (requestId: string, ok: boolean, error?: string) =>
      call('video-editing:open-result', { requestId, ok, error }),
    panelShow: (id: string, sessionId: string, bounds: { x: number; y: number; width: number; height: number }) =>
      call('video-editing:panel-show', { id, sessionId, bounds }) as Promise<{ ok?: boolean; error?: string }>,
    panelSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      call('video-editing:panel-set-bounds', { bounds }) as Promise<{ ok?: boolean; error?: string }>,
    panelHide: () => call('video-editing:panel-hide'),
    panelClose: () => call('video-editing:panel-close') as Promise<{ ok?: boolean; error?: string }>,
    onOpenPanel: (cb: (payload: { requestId?: string; id: string; title?: string; sessionId: string }) => void) =>
      subscribe('video-editing:open-panel', cb),
  },
  canvas: {
    list: () =>
      call('canvas:list') as Promise<{
        canvases: { filePath: string; name: string; modifiedMs: number }[]
      }>,
    open: (filePath: string, displayName?: string) =>
      call('canvas:open', { filePath, displayName }),
    openResult: (requestId: string, ok: boolean, error?: string) =>
      call('canvas:open-result', { requestId, ok, error }),
    panelShow: (filePath: string, displayName: string, bounds: { x: number; y: number; width: number; height: number }, reload = false) =>
      call('canvas:panel-show', { filePath, displayName, bounds, reload }),
    panelSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      call('canvas:panel-set-bounds', { bounds }),
    panelHide: () => call('canvas:panel-hide'),
    panelClose: () => call('canvas:panel-close'),
    onOpenPanel: (cb: (payload: { requestId?: string; filePath: string; displayName?: string; sessionId?: string }) => void) =>
      subscribe('canvas:open-panel', (payload: { requestId?: string; filePath: string; displayName?: string; sessionId?: string }) => cb(payload)),
    /**
     * A canvas asked to put text in the composer. Fires in the MAIN window
     * because that is where the composer is; the canvas window raised this one
     * to the front on the way out.
     */
    onSendToChat: (cb: (payload: { text: string; submit: boolean; newChat: boolean }) => void) =>
      subscribe('canvas:send-to-chat', (payload: { text: string; submit: boolean; newChat: boolean }) =>
        cb(payload),
      ),
  },

  // digram — the built-in diagram surface. The document lives host-side
  // (~/.klaus/digram, decoded by crates/klaus-shell/src/digram.rs); the renderer
  // is ours (src/chat/digram). These calls are the ONLY way the panel reads or
  // mutates a document, so a user drag and an agent tool call funnel through the
  // same host `apply` and can never hold two copies of the state.
  digram: {
    /** Current-session diagrams, newest first. Backs the panel's doc switcher. */
    list: (sessionId: string) =>
      call('digram:list', { sessionId }) as Promise<{
        diagrams: { id: string; title: string; version: number; updatedAtMs: number; pages: number; nodes: number }[]
      }>,
    /** One current-session document by id, or that session's newest one. */
    get: (sessionId: string, id?: string) => call('digram:get', { sessionId, ...(id ? { id } : {}) }),
    /** Apply an op batch (all-or-nothing) and get the new document back. `baseVersion`
     *  guards against overwriting a change that landed since: a mismatch replies
     *  `{ stale: true, document }` instead of applying. */
    applyEdit: (sessionId: string, id: string, ops: unknown[], baseVersion?: number) =>
      call('digram:apply-edit', { sessionId, id, ops, baseVersion }),
    /** Save a rendered PNG, JPG, or SVG to a path selected by the user. */
    export: (sessionId: string, id: string, format: string, opts?: { scale?: number; svg?: string }) =>
      call('digram:export', { sessionId, id, format, scale: opts?.scale, svg: opts?.svg }) as Promise<{
        ok?: boolean
        canceled?: boolean
        error?: string
        path?: string
      }>,
    /** Resolve icon keys to path data for the renderer (only the ones a diagram uses). */
    icons: (keys: string[]) =>
      call('digram:icons', { keys }) as Promise<{ icons: Record<string, string> }>,
    /** Past revisions (newest first) for one current-session diagram. */
    history: (sessionId: string, id: string) => call('digram:history', { sessionId, id }),
    revert: (sessionId: string, id: string, version: number) => call('digram:revert', { sessionId, id, version }),
    /** A current-session document changed host-side; an open panel re-fetches it. */
    onChanged: (cb: (payload: { id: string; version: number; sessionId: string }) => void) =>
      subscribe('digram:changed', (payload: { id: string; version: number; sessionId: string }) => cb(payload)),
    /**
     * The agent's digram_export tool needs a rendered image, and rendering is
     * the renderer's job. The shell hands the whole document over; the panel
     * renders it OFF-SCREEN and returns bytes through `renderResult`. No visible
     * side effect — the panel's own view is untouched.
     */
    onRenderRequest: (
      cb: (payload: { requestId: string; document: unknown; format: string; scale: number }) => void,
    ) =>
      subscribe('digram:render-request', (payload: { requestId: string; document: unknown; format: string; scale: number }) =>
        cb(payload),
      ),
    /** Hand rendered bytes (base64 for raster, raw text for svg) back to the waiting tool call. */
    renderResult: (payload: { requestId: string; format?: string; data?: string; error?: string }) =>
      call('digram:render-result', payload),
  },

  // model3d — the built-in 3D surface. The document lives host-side, owned by an
  // in-process WASM kernel (manifold for CAD booleans, rapier for physics); the
  // renderer (src/chat/model3d) draws it with three.js. Like digram, these calls
  // are the ONLY way the panel reads or mutates the scene, so a user drag and an
  // agent tool call funnel through the same host document and can never hold two
  // copies of it. There is no install: the kernel ships with the app.
  model3d: {
    /** This session's 3D documents, newest first. Backs the panel's switcher. */
    list: (sessionId: string) =>
      call('model3d:list', { sessionId }) as Promise<{
        documents: { id: string; title: string; version: number; updatedAtMs: number; objects: number; meshes: number; materials: number }[]
      }>,
    /** One current-session document by id, or that session's newest one. */
    get: (sessionId: string, id?: string) => call('model3d:get', { sessionId, ...(id ? { id } : {}) }),
    /** One object's evaluated geometry as typed arrays (structured-cloned, no base64). */
    mesh: (sessionId: string, name: string) => call('model3d:mesh', { sessionId, name }),
    /** Apply a panel op batch and get the new document back. `baseVersion` guards
     *  against clobbering an agent edit that landed since: a mismatch replies
     *  `{ stale: true, document }` instead of applying. */
    apply: (sessionId: string, ops: unknown[], baseVersion?: number) =>
      call('model3d:apply', { sessionId, ops, baseVersion }),
    /** Save the document to a user-chosen .model3d.json path. */
    /** A current-session document changed host-side; an open panel re-fetches it. */
    onChanged: (cb: (payload: { id: string; version: number; sessionId: string }) => void) =>
      subscribe('model3d:changed', cb),
    /**
     * The host asking the panel to render. The main process has no WebGL context,
     * so model3d_render delegates the draw here; the panel renders OFF-SCREEN at
     * the requested size and returns bytes through renderResult, leaving the
     * visible view untouched.
     */
    onRenderRequest: (cb: (payload: { requestId: string; sessionId?: string; document: unknown; format: string; width: number; height: number }) => void) =>
      subscribe('model3d:render-request', cb),
    /** Hand rendered bytes (base64) back to the waiting tool call. `panelVisible`
     *  reports whether the user could actually see the scene; a render succeeds
     *  with the panel closed by design, and the host surfaces this to the agent so
     *  it never tells the user the panel is open when it is not. */
    renderResult: (payload: { requestId: string; format?: string; data?: string; error?: string; panelVisible?: boolean }) =>
      call('model3d:render-result', payload),
  },

  // Workspace browsing loads directories on demand. Filename filtering uses
  // the same root-scoped file set, including hidden and generated entries.
  workspace: {
    list: (sessionId: string, filePath?: string) => call('workspace:list', { sessionId, ...(filePath ? { filePath } : {}) }),
    search: (sessionId: string, query: string) => call('workspace:search', { sessionId, query }),
    open: (sessionId: string, filePath: string) => call('workspace:open', { sessionId, filePath }),
    reveal: (sessionId: string, filePath: string) => call('workspace:reveal', { sessionId, filePath }),
    rename: (sessionId: string, filePath: string, newName: string) =>
      call('workspace:rename', { sessionId, filePath, newName }),
    delete: (sessionId: string, filePath: string) => call('workspace:delete', { sessionId, filePath }),
    write: (sessionId: string, filePath: string, content: string, options?: { expectedMtimeMs?: number | null; force?: boolean }) =>
      call('workspace:write', { sessionId, filePath, content, ...(options ? { expectedMtimeMs: options.expectedMtimeMs, force: options.force } : {}) }),
    getExcludes: () => call('workspace:get-excludes'),
    setExcludes: (patterns: string[]) => call('workspace:set-excludes', { patterns }),
  },

  // Git diff view — app-side host wrapper around the host diff shape.
  diff: {
    summary: (sessionId: string, options: DiffOptions = {}) => call('diff:summary', { sessionId, ...options }),
    hunks: (sessionId: string, filePath: string, options: DiffOptions = {}) => call('diff:hunks', { sessionId, filePath, ...options }),
    applyReviewAction: (sessionId: string, action: 'stage' | 'unstage' | 'revert', options: DiffOptions & {
      expectedSnapshotId: string; filePath?: string; hunkIndex?: number
    }) => call('diff:apply-review-action', { sessionId, ...options, action }),
    open: (sessionId: string, filePath: string, options: DiffOptions = {}) =>
      call('diff:open', { sessionId, filePath, ...options }),
    reveal: (sessionId: string, filePath: string, options: DiffOptions = {}) =>
      call('diff:reveal', { sessionId, filePath, ...options }),
    // diff → 提交闭环：旁路生成提交信息 + 一键 git add -A && commit。
    generateCommitMessage: (sessionId: string, options: DiffOptions = {}) =>
      call('diff:generateCommitMessage', { sessionId, ...options }),
    commit: (sessionId: string, message: string, options: DiffOptions = {}) =>
      call('diff:commit', { sessionId, message, ...options }),
  },

  // 受管 worktree（并行会话隔离工作区）：创建/状态/移除/Finder 展示。
  worktree: {
    /** 新会话页 Worktree 模式：以项目目录 + 可选基分支直接建隔离工作区。
     *  includeUncommitted 把主仓的未提交改动一起搬进新工作树。 */
    createFromWorkdir: (workdir: string, baseRef?: string, includeUncommitted?: boolean) =>
      call('worktree:create-from-workdir', { workdir, baseRef, includeUncommitted: includeUncommitted === true }),
    status: (path: string, availabilityOnly = false) => call('worktree:status', { path, availabilityOnly }),
    remove: (path: string) => call('worktree:remove', { path }),
    reveal: (path: string) => call('worktree:reveal', { path }),
    list: (): Promise<WorktreeStorageList> => call('worktree:list'),
    configure: (patch: WorktreeStorageSettingsPatch): Promise<{ ok: true; settings: WorktreeStorageSettings }> => call('worktree:configure', patch),
    deleteManaged: (path: string) => call('worktree:storage-delete', { path }),
  },

  // Profile-local storage measurements, reviewed cleanup and lifecycle updates.
  storage: {
    usage: (): Promise<StorageSnapshot> => call('storage:usage'),
    refresh: (): Promise<StorageSnapshot> => call('storage:refresh'),
    review: (): Promise<{ reviewId: string; inventory: StorageReviewRow[] }> => call('storage:review'),
    cleanup: (selection: Array<{ id: string; updatedAt: number }>, options: StorageCleanupOptions): Promise<{ deleted: number; skipped: number; failed: number }> =>
      call('storage:cleanup', { selection, ...options }),
    onChanged: (callback: (event: StorageChatsChanged) => void): Unsubscribe => subscribe('storage:chats-changed', callback),
  },

  // 新会话页分支选择器：列分支 / 检出（支持新建）/ 非 git 目录初始化。
  git: {
    branches: (workdir: string) => call('git:branches', { workdir }),
    /** 切换分支前的未提交改动：数量 + 会被 checkout 拒绝的文件集。 */
    uncommitted: (workdir: string, branch?: string) => call('git:uncommitted', { workdir, branch }),
    checkout: (workdir: string, branch: string, opts?: { create?: boolean; sessionId?: string }) =>
      call('git:checkout', { workdir, branch, create: !!opts?.create, sessionId: opts?.sessionId }),
    /** 「提交并切换分支」：只提交会被检出拒绝的那些文件，其余改动原样留在工作区。 */
    commitPaths: (workdir: string, paths: string[], message: string) =>
      call('git:commit-paths', { workdir, paths, message }),
    init: (workdir: string) => call('git:init', { workdir }),
  },

  // Voice input: microphone permission (macOS) plus recording transcription.
  // Cloud sources stream through the dictation pipeline: AudioWorklet PCM frames
  // accumulate in a ledger, silence-aware segments are transcribed while the user
  // speaks (transcribe with partial:true — raw text, no polish or history), and the
  // full-audio pass runs at stop, with joined partial text as fallback. System ASR keeps its
  // streaming session (macOS klaus-speech-helper): sessionAudio uplink after start,
  // partial/final/error pushed back over onSessionEvent. Hotwords/memories/history
  // stay settings-managed; learn is the fire-and-forget loop after sending.
  voice: {
    chat: {
      reserve: (requestId: string, sessionId?: string): Promise<void> => call('voice:chat:reserve', { requestId, ...(sessionId ? { sessionId } : {}) }),
      state: (sessionId?: string): Promise<VoiceChatState> => call('voice:chat:state', { ...(sessionId ? { sessionId } : {}) }),
      negotiate: (value: VoiceChatOffer): Promise<VoiceChatAnswer> => call('voice:chat:negotiate', value),
      end: (value: { requestId: string; generation?: number }): Promise<VoiceChatState> => call('voice:chat:end', value),
      control: (value: VoiceChatControl): Promise<VoiceChatState> => call('voice:chat:control', value),
      appendAudio: (value: VoiceChatAudioFrame): Promise<null> => call('voice:chat:audio', value),
      onEvent: (callback: (event: VoiceChatEvent) => void): Unsubscribe => subscribe('voice:chat:event', callback),
      onToggle: (callback: (value: { action: 'start' | 'stop' }) => void): Unsubscribe => subscribe('voice:chat:toggle', callback),
      present: (value: VoiceChatPresentation): Promise<void> => call('voice:chat:present', value),
      levels: (value: VoiceChatLevels): Promise<void> => call('voice:chat:levels', value),
    },
    micPermission: (operationId?: string) => call('voice:mic-permission', { operationId }),
    transcribe: (data: ArrayBuffer, mimeType?: string, operationId?: string, options?: { source: string; context?: string; chatSessionId?: string; durationMs?: number; partial?: boolean; segmentIds?: string[] }) =>
      call('voice:transcribe', { data, mimeType, operationId, ...options }),
    config: (operationId?: string, includeAvailability = false) => call('voice:config:get', { operationId, includeAvailability }),
    sessionStart: (options?: { locale?: string; context?: string; operationId?: string; source?: string; chatSessionId?: string }) =>
      call('voice:session:start', options ?? {}),
    sessionAudio: (sessionId: string, data: ArrayBuffer, seq?: number) =>
      call('voice:session:audio', { sessionId, data, seq }),
    sessionStop: (sessionId?: string) => call('voice:session:stop', { sessionId }),
    sessionCancel: (sessionId?: string) => call('voice:session:cancel', { sessionId }),
    onSessionEvent: (cb: (event: unknown) => void) => subscribe('voice:session:event', cb),
    learn: (payload: { rawText?: string; insertedText: string; finalText: string; chatSessionId?: string }) =>
      call('voice:learn', payload),
    hotwords: {
      list: () => call('voice:hotwords:list'),
      add: (text: string, id?: string) => call('voice:hotwords:add', { text, ...(id ? { id } : {}) }),
      remove: (id: string) => call('voice:hotwords:delete', { id }),
      toggle: (id: string, enabled: boolean) => call('voice:hotwords:toggle', { id, enabled }),
    },
    memories: {
      list: () => call('voice:memories:list'),
      remove: (id: string) => call('voice:memories:delete', { id }),
    },
    history: {
      list: (limit?: number) => call('voice:history:list', { limit }),
      clear: () => call('voice:history:clear'),
    },
  },

  // Settings
  settings: {
    models: {
      list: () => call('settings:models:list'),
      upsert: (model: any) => call('settings:models:upsert', model),
      delete: (id: string) => call('settings:models:delete', { id }),
      getTiers: (): Promise<GlobalModelTierReply> => call('settings:models:tiers:get'),
      setTier: (tier: ModelTierName, target: ModelTierReference | null, expectedRevision: number): Promise<GlobalModelTierReply> =>
        call('settings:models:tiers:set', { tier, target, expectedRevision }),
      tierOptions: (): Promise<GlobalModelTierOptions> => call('settings:models:tiers:options'),
    },
    permissions: {
      list: () => call('permission:rules:list'),
      add: (payload: { toolName: string; ruleContent?: string; behavior: 'allow' | 'deny' | 'ask'; source?: string }) =>
        call('permission:rules:add', payload),
      delete: (payload: { toolName: string; ruleContent?: string; behavior: 'allow' | 'deny' | 'ask'; source?: string }) =>
        call('permission:rules:delete', payload),
    },
    advisor: {
      get: (source?: string) =>
        source ? call('settings:advisor:get', { source }) : call('settings:advisor:get'),
      set: (config: { enabled?: boolean; model?: string; source?: string }) =>
        call('settings:advisor:set', config),
    },
    // Auxiliary task models: title generation, message predictions, memory and
    // dream upkeep, and speech refinement. Each pick is one global
    // "source:modelId" reference; an empty string follows the chat's main model.
    featureModels: {
      get: (): Promise<FeatureModelsReply> => call('settings:feature-models:get'),
      set: (patch: FeatureModelPatch): Promise<FeatureModelsReply> => call('settings:feature-models:set', patch),
    },
    // Custom endpoints stay global. A native source names its separate model preferences.
    imageGen: {
      get: (source?: string) =>
        source ? call('settings:image-gen:get', { source }) : call('settings:image-gen:get'),
      set: (config: { source?: string; provider?: string; baseUrl?: string; apiKey?: string; model?: string; localModel?: string }) =>
        call('settings:image-gen:set', config),
    },
    // The global image backend: which source's own image API (or the global
    // custom endpoint) runs generate_image for every chat. `availability`
    // says which choices are usable right now (signed in / configured).
    imageSelection: {
      get: () => call('settings:image-selection:get'),
      set: (selection: string, model?: string) => call('settings:image-selection:set', { selection, ...(model === undefined ? {} : { model }) }),
    },
    // The global video backend, mirroring the image one: which video route runs
    // generate_video for every chat, independent of the conversation's language
    // source. `availability` says which choices are usable right now.
    videoSelection: {
      get: () => call('settings:video-selection:get'),
      set: (selection: string, model?: string) => call('settings:video-selection:set', { selection, ...(model === undefined ? {} : { model }) }),
    },
    // Which model-subscription search sources are usable right now: the web
    // settings page lists them all and disables the ones not signed in.
    webSearchSources: {
      get: (): Promise<{ ok: boolean; availability: Record<string, boolean> }> => call('settings:web-search-sources:get'),
    },
    webFetchSources: {
      get: (): Promise<{ ok: boolean; availability: Record<string, boolean> }> => call('settings:web-fetch-sources:get'),
    },
    videoGen: {
      get: (source?: string) =>
        source ? call('settings:video-gen:get', { source }) : call('settings:video-gen:get'),
      set: (config: { source?: string; provider?: string; baseUrl?: string; apiKey?: string; model?: string; localModel?: string }) =>
        call('settings:video-gen:set', config),
    },
    // The global audio backend: which audio route runs generate_audio for every
    // chat, independent of the conversation's language source. `availability`
    // says which choices are usable right now.
    audioSelection: {
      get: () => call('settings:audio-selection:get'),
      set: (selection: string, model?: string) => call('settings:audio-selection:set', { selection, ...(model === undefined ? {} : { model }) }),
    },
    // The custom audio endpoint configuration: base URL, API key and model for the
    // OpenAI-compatible speech route the `custom` audio selection runs.
    audioGen: {
      get: (source?: string) =>
        source ? call('settings:audio-gen:get', { source }) : call('settings:audio-gen:get'),
      set: (config: { source?: string; provider?: string; baseUrl?: string; apiKey?: string; model?: string; voice?: string }) =>
        call('settings:audio-gen:set', config),
    },
    musicSelection: {
      get: () => call('settings:music-selection:get'),
      set: (selection: string, model?: string) => call('settings:music-selection:set', { selection, ...(model === undefined ? {} : { model }) }),
    },
    musicGen: {
      get: (source: string) => call('settings:music-gen:get', { source }),
      set: (config: { source: string; model?: string }) => call('settings:music-gen:set', config),
    },
    browserUse: {
      discoverProfiles: () => browserDataReply(call('settings:browser-use:discover-profiles')),
      importStart: (request: BrowserImportRequest) => browserDataReply(call('settings:browser-use:import-start', request)),
      importCancel: (jobId: string) => browserDataReply(call('settings:browser-use:import-cancel', { jobId })),
      importState: (jobId: string) => browserDataReply(call('settings:browser-use:import-state', { jobId })),
      openImportPermissionSettings: () => browserDataReply(call('settings:browser-use:import-permission-settings')),
      subscribeImport: (listener: (snapshot: BrowserImportJobSnapshot) => void): Unsubscribe => subscribe('settings:browser-use:import-progress', listener),
      credentials: {
        listPasswords: (originUrl?: string) => browserDataReply(call('settings:browser-use:passwords', { originUrl })),
        savePassword: (input: BrowserPasswordInput) => browserDataReply(call('settings:browser-use:password-save', input)),
        revealPassword: (id: string) => browserDataReply(call('settings:browser-use:password-reveal', { id })),
        copyPassword: async (id: string) => { await browserDataReply(call('settings:browser-use:password-copy', { id })) },
        deletePassword: async (id: string) => { await browserDataReply(call('settings:browser-use:password-delete', { id })) },
        importPasswords: (rows: BrowserPasswordImportRow[]) => browserDataReply(call('settings:browser-use:password-import', { rows })),
        listAutofillProfiles: (kind?: BrowserAutofillProfileKind) => browserDataReply(call('settings:browser-use:autofill-profiles', { kind })),
        getAutofillProfile: (id: string) => browserDataReply(call('settings:browser-use:autofill-profile', { id })),
        saveAutofillProfile: (input: BrowserAutofillProfileInput) => browserDataReply(call('settings:browser-use:autofill-save', input)),
        updateAutofillProfile: (id: string, input: BrowserAutofillProfileInput) => browserDataReply(call('settings:browser-use:autofill-update', { id, input })),
        deleteAutofillProfile: async (id: string) => { await browserDataReply(call('settings:browser-use:autofill-delete', { id })) },
      },
      extensions: {
        list: () => browserDataReply(call('settings:browser-use:extensions')),
        install: (input: { path: string }) => browserDataReply(call('settings:browser-use:extension-install', input)),
        choose: () => browserDataReply(call('settings:browser-use:extension-choose')),
        setEnabled: (id: string, enabled: boolean) => browserDataReply(call('settings:browser-use:extension-set-enabled', { id, enabled })),
        remove: async (id: string) => { await browserDataReply(call('settings:browser-use:extension-remove', { id })) },
      },
      get: () => call('settings:browser-use:get'),
      subscribe: (listener: (snapshot: any) => void): Unsubscribe => subscribe('settings:browser-use:changed', listener),
      setPreferences: (patch: Record<string, unknown>) => call('settings:browser-use:set-preferences', patch),
      setOriginPolicy: (policy: { pattern?: string; resource: string; setting: string }) => call('settings:browser-use:set-origin-policy', policy),
      removeOriginPolicy: (pattern: string) => call('settings:browser-use:remove-origin-policy', { pattern }),
      setSitePermission: (permission: { origin: string; permission: string; setting: string }) => call('settings:browser-use:set-site-permission', permission),
      history: (options: Record<string, unknown> = {}) => call('settings:browser-use:history', options),
      removeHistory: (ids: string[]) => call('settings:browser-use:remove-history', { ids }),
      downloads: (options: Record<string, unknown> = {}) => call('settings:browser-use:downloads', options),
      subscribeDownloads: (listener: (event: any) => void): Unsubscribe => subscribe('browser-use:downloads-changed', listener),
      downloadAction: (action: string, id: string) => call('settings:browser-use:download-action', { action, id }),
      chooseDownloadDirectory: () => call('settings:browser-use:choose-download-directory'),
      setEnabled: (enabled: boolean) =>
        call('settings:browser-use:set-enabled', { enabled }),
      setChromeEnabled: (enabled: boolean) =>
        call('settings:browser-use:set-chrome-enabled', { enabled }),
      chromeDiagnostics: () =>
        call('settings:browser-use:chrome-diagnostics'),
      installChromeNativeHost: () =>
        call('settings:browser-use:chrome-install-native-host'),
      setupChrome: () =>
        call('settings:browser-use:chrome-setup'),
      openChromeWindow: () =>
        call('settings:browser-use:chrome-open-window'),
      openChromeWebstore: () =>
        call('settings:browser-use:chrome-open-webstore'),
      openChromeExtensionManager: () =>
        call('settings:browser-use:chrome-open-extension-manager'),
      deployChromeExtension: () =>
        call('settings:browser-use:chrome-deploy-extension'),
      revealChromeExtension: () =>
        call('settings:browser-use:chrome-reveal-extension'),
      policyInstallChromeExtension: () =>
        call('settings:browser-use:chrome-policy-install'),
      policyUninstallChromeExtension: () =>
        call('settings:browser-use:chrome-policy-uninstall'),
      setApprovalMode: (mode: string) =>
        call('settings:browser-use:set-approval-mode', { mode }),
      setScreenshotMode: (mode: string) =>
        call('settings:browser-use:set-screenshot-mode', { mode }),
      addOrigin: (kind: string, origin: string) =>
        call('settings:browser-use:add-origin', { kind, origin }),
      removeOrigin: (kind: string, origin: string) =>
        call('settings:browser-use:remove-origin', { kind, origin }),
      clearData: (kind?: string) =>
        call('settings:browser-use:clear-data', { kind }),
    },
    computerUse: {
      get: () => call('settings:computer-use:get'),
      setEnabled: (enabled: boolean) =>
        call('settings:computer-use:set-enabled', { enabled }),
      // Saved app approvals are managed separately from the connector switch.
      addAllowedApp: (app: string) =>
        call('settings:computer-use:add-allowed-app', { app }),
      removeAllowedApp: (app: string) =>
        call('settings:computer-use:remove-allowed-app', { app }),
      listApps: () =>
        call('settings:computer-use:list-apps'),
      appDetails: (app: string) =>
        call('settings:computer-use:app-details', { app }),
      // Record & Replay: the floating panel (recorder.html) drives these
      // channels. There is no `start` here on purpose: recording begins from
      // the skills page's 录制技能 entry, which opens a chat whose agent calls
      // the connector's event_stream_start tool.
      record: {
        stop: () => call('computer-use:record:stop'),
        discard: () => call('computer-use:record:discard'),
        status: () => call('computer-use:record:status'),
      },
    },
    // Local environment history: a bounded on-device timeline of app and window
    // observations. Nothing is uploaded; the organization policy can block it.
    computerHistory: {
      get: () => call('settings:computer-history:get'),
      setEnabled: (enabled: boolean) =>
        call('settings:computer-history:set-enabled', { enabled }),
      pause: () => call('settings:computer-history:pause'),
      resume: () => call('settings:computer-history:resume'),
      updateObservation: (entry: { observe: 'include' | 'exclude'; scope: 'app' | 'url'; target: string }) =>
        call('settings:computer-history:update-observation', entry),
      removeObservationEntry: (scope: 'app' | 'url', target: string) =>
        call('settings:computer-history:remove-observation-entry', { scope, target }),
      clearHistory: (interval: 'all' | 'last-day' | 'last-hour') =>
        call('settings:computer-history:clear-history', { interval }),
      entries: (limit?: number, before?: number) =>
        call('settings:computer-history:entries', { ...(limit !== undefined ? { limit } : {}), ...(before !== undefined ? { before } : {}) }),
    },
    mobileBridge: {
      get: () => call('settings:mobile-bridge:get'),
      devices: () => call('settings:mobile-bridge:devices'),
      set: (update: { enabled?: boolean; port?: number; relayUrl?: string; allowLockedComputerUse?: boolean }) =>
        call('settings:mobile-bridge:set', update),
      removeDevice: (deviceId: string) =>
        call('settings:mobile-bridge:remove-device', { deviceId }),
      renameDevice: (deviceId: string, name: string) =>
        call('settings:mobile-bridge:rename-device', { deviceId, name }),
      rotateToken: () => call('settings:mobile-bridge:rotate-token'),
      restart: () => call('settings:mobile-bridge:restart'),
    },
    hooks: {
      get: () => call('settings:hooks:get'),
      set: (hooks: unknown) => call('settings:hooks:set', { hooks }),
    },
    // klaus 引擎 hooks：全局档读写 ~/.klaus/hooks.json，项目档读写 <root>/.klaus/hooks.json
    // （都是引擎会话装配时实际读取的文件），与 settings.json 的 hooks 键并存。
    klausHooks: {
      get: (opts?: { projectRoot?: string; workspaceId?: string }) =>
        call('klaus:hooks:get', opts?.projectRoot ? { projectRoot: opts.projectRoot } : opts?.workspaceId ? { workspaceId: opts.workspaceId } : undefined),
      set: (hooks: unknown, opts?: { projectRoot?: string; workspaceId?: string }) =>
        call('klaus:hooks:set', { hooks, ...(opts?.projectRoot ? { projectRoot: opts.projectRoot } : {}), ...(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {}) }),
      // 信任门：未信任或声明已变更的钩子不会注入会话；trust 记录当前声明哈希。
      trust: (keys: string[], opts?: { projectRoot?: string; workspaceId?: string }) =>
        call('settings:hooks:trust', { keys, ...(opts?.projectRoot ? { projectRoot: opts.projectRoot } : {}), ...(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {}) }),
      setEnabled: (key: string, enabled: boolean, opts?: { projectRoot?: string; workspaceId?: string }) =>
        call('settings:hooks:enabled', { key, enabled, ...(opts?.projectRoot ? { projectRoot: opts.projectRoot } : {}), ...(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {}) }),
    },
    kv: {
      get: (key: string, scope?: RuntimeConfigScope) => call('settings:kv:get', { key, ...(scope ? { scope } : {}) }),
      set: (key: string, value: string | GranularApprovalPolicy | null, scope?: RuntimeConfigScope, expectedVersion?: string) =>
        call('settings:kv:set', { key, value, ...(scope ? { scope } : {}), ...(expectedVersion ? { expectedVersion } : {}) }),
    },
    runtime: {
      windowsSandboxReadiness: (): Promise<WindowsSandboxReadinessResponse> => call('settings:runtime:windows-sandbox-readiness'),
      startWindowsSandboxSetup: (params: WindowsSandboxSetupStartParams): Promise<WindowsSandboxSetupStartResponse> =>
        call('settings:runtime:windows-sandbox-setup-start', params),
      onWindowsSandboxSetupCompleted: (listener: (event: WindowsSandboxSetupCompletedNotification) => void) =>
        subscribe('settings:runtime:windows-sandbox-setup-completed', listener),
    },
    runtimeConfig: {
      get: (scope?: RuntimeConfigScope): Promise<RuntimeConfigSnapshot> => call('settings:runtime-config:get', { ...(scope ? { scope } : {}) }),
      open: (scope?: RuntimeConfigScope): Promise<{ ok: true; path: string }> => call('settings:runtime-config:open', { ...(scope ? { scope } : {}) }),
    },
    workspaceDependencies: {
      get: (): Promise<WorkspaceDependenciesResponse> => call('settings:workspace-dependencies:get', {}),
      diagnose: (): Promise<WorkspaceDependenciesResponse> => call('settings:workspace-dependencies:diagnose', {}),
      reinstall: (): Promise<WorkspaceDependenciesResponse> => call('settings:workspace-dependencies:reinstall', {}),
    },
    // Keyboard shortcuts. The host owns keybindings.json; the renderer reads the
    // live state, applies one update (set/replace/append/remove/clear/reset), or
    // resets everything. `KeymapUpdate` is the update union those six share.
    keymap: {
      state: (): Promise<KeymapState> => call('keymap:state'),
      set: (commandId: string, update: KeybindingUpdate): Promise<KeymapState> =>
        call('keymap:set', { commandId, ...update }),
      reset: (): Promise<KeymapState> => call('keymap:reset'),
      // Bracket a capture so the host releases every registered global hotkey for
      // its duration: the OS resolves a global accelerator before the window sees
      // the keydown, so re-recording the key that is currently bound (⌘⇧K, say)
      // would otherwise fire the hotkey instead of reaching the input. The host
      // also releases the suppression on window blur/destroy/crash/navigation, so
      // a capture that dies with its window cannot strand the hotkeys.
      captureBegin: (): Promise<{ ok: boolean }> => call('keymap:capture-begin'),
      captureEnd: (): Promise<{ ok: boolean }> => call('keymap:capture-end'),
    },
    outputStyles: {
      list: (sessionId?: string) => call('settings:output-styles:list', { sessionId }),
      set: (style: string, sessionId?: string) => call('settings:output-styles:set', { style, sessionId }),
    },
    cron: {
      list: () => call('settings:cron:list'),
      upsert: (task: any) => call('settings:cron:upsert', task),
      delete: (id: string) => call('settings:cron:delete', { id }),
      runs: (filters?: { limit?: number; offset?: number; taskId?: string; status?: string }) =>
        call('settings:cron:runs:list', filters ?? {}),
      // Remove completed run history while preserving conversations and all running rows.
      runsPrune: (opts?: { before?: number; taskId?: string }) =>
        call('settings:cron:runs:prune', opts ?? {}),
      runNow: (id: string) => call('settings:cron:run:now', { id }),
      // Next scheduled slot per task + currently running task ids.
      status: () => call('settings:cron:status'),
      keepAwake: {
        get: () => call('settings:cron:keep-awake:get'),
        set: (enabled: boolean) => call('settings:cron:keep-awake:set', { enabled }),
      },
    },
  },

  powerSave: {
    snapshot: (): Promise<PowerSaveSnapshot> => call('power:snapshot'),
    setPreference: (key: keyof PowerSavePreferences, enabled: boolean): Promise<{ ok: boolean; revision: number } & PowerSavePreferences> =>
      call('settings:power:set', { key, enabled }),
    setRequest: (request: PowerSaveRequest) => call('power:request:set', request),
    subscribe: (listener: (snapshot: PowerSaveSnapshot) => void): Unsubscribe => subscribe('power:context', listener),
  },

  computerUsePip: {
    getState: (): Promise<ComputerUsePipState> => call('computer-use-pip:get-state'),
    setVisibility: (request: ComputerUsePipVisibilityRequest): Promise<ComputerUsePipState> =>
      call('computer-use-pip:set-visibility', request),
    setHostLayout: (layout: ComputerUsePipHostLayout): Promise<unknown> =>
      call('computer-use-pip:set-host-layout', layout),
  },
  endResources: {
    targets: (request: import('../../contracts/end-resource-open').EndResourceTargetsRequest): Promise<import('../../contracts/end-resource-open').EndResourceTargets> =>
      call('end-resources:targets', request),
    open: (request: import('../../contracts/end-resource-open').EndResourceOpenRequest): Promise<{ ok?: boolean; error?: string }> =>
      call('end-resources:open', request),
    reveal: (sessionId: string, filePath: string): Promise<{ ok?: boolean; error?: string }> =>
      call('end-resources:reveal', { sessionId, filePath }),
    downloadCopy: (sessionId: string, filePath: string): Promise<{ ok?: boolean; filePath?: string; error?: string }> =>
      call('end-resources:download-copy', { sessionId, filePath }),
    existing: (sessionId: string, paths: string[]): Promise<{ existing?: string[] }> =>
      call('end-resources:existing', { sessionId, paths }),
    pageMeta: (sessionId: string, filePath: string): Promise<import('../../contracts/end-resource-open').EndResourcePageMeta> =>
      call('end-resources:page-meta', { sessionId, filePath }),
  },
  browser: {
    siteOpenTargets: (): Promise<SiteOpenTargets | { ok: false; code: string; error: string }> =>
      call('site-references:open-targets'),
    openSite: (request: SiteOpenRequest): Promise<SiteOpenResult> =>
      call('site-references:open', request),
  },
  browserUse: {
    annotationCapture: (request: { sessionId: string; focusRevision: number }) => call('browser-use:annotation-capture', request),
    annotationAnchor: (request: { snapshotId: string; point: { x: number; y: number } }) => call('browser-use:annotation-anchor', request),
    annotationSave: (request: { snapshotId: string; sessionId: string; tabId: string; focusRevision: number; crop?: { x: number; y: number; width: number; height: number } | null }) => call('browser-use:annotation-save', request),
    annotationCommit: (request: { snapshotId: string; sessionId: string; tabId: string; focusRevision: number }) => call('browser-use:annotation-commit', request),
    annotationDiscard: (snapshotId: string) => call('browser-use:annotation-discard', { snapshotId }),
    mentionTabs: (options: { sessionId: string | null; query: string }): Promise<{ ok: true; tabs: BrowserTabMention[]; errors: Array<{ browserId: string; message: string; code?: string }> } | { ok: false; error: string }> =>
      call('browser-use:mention-tabs', options),
    state: () => call('browser-use:state'),
    show: (bounds?: { x: number; y: number; width: number; height: number }, scope?: BrowserUseOpenRequest) =>
      call('browser-use:show', { bounds, ...scope }),
    hide: () => call('browser-use:hide'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      call('browser-use:set-bounds', { bounds }),
    // Retained until the old shell's channel table is retired. The native browser
    // panel does not call viewInput or consume frame events.
    viewAvailable: () => call('browser-use:view-available'),
    viewInput: (event: Record<string, unknown>) => call('browser-use:view-input', event),
    navigate: (url: string) => call('browser-use:navigate', { url }),
    back: () => call('browser-use:back'),
    forward: () => call('browser-use:forward'),
    reload: () => call('browser-use:reload'),
    stop: () => call('browser-use:stop'),
    screenshot: (options?: any) => call('browser-use:screenshot', options ?? {}),
    tabs: (action: any) => call('browser-use:tabs', action),
    // Point the embedded browser at a session's own conversation, so its page
    // set follows the selected session instead of being shared app-wide.
    setConversation: (conversationId: string) =>
      call('browser-use:set-conversation', { conversationId }),
    // A page inside the embedded browser asked for a permission; the host
    // parks the question and the window's own dialog answers it per requestId.
    onPermissionRequest: (cb: (request: { requestId: string; sessionId: string; permission: string; origin: string; pageUrl: string }) => void): Unsubscribe =>
      subscribe('browser-use:permission-request', (request: { requestId: string; sessionId: string; permission: string; origin: string; pageUrl: string }) => cb(request)),
    onPermissionCancelled: (cb: (event: { requestId: string }) => void): Unsubscribe => subscribe('browser-use:permission-cancelled', cb),
    answerPermission: (requestId: string, allowed: boolean) =>
      call('browser-use:permission-answer', { requestId, allowed }),
  },
  runPreview: {
    state: (scope: { sessionId: string; toolCallId: string; focusRevision: number }) =>
      call('run-preview:state', scope),
    retry: (scope: { sessionId: string; toolCallId: string; focusRevision: number }) =>
      call('run-preview:retry', scope),
    open: (request: { sessionId: string; toolCallId: string; focusRevision: number; url: string; name: string }) =>
      call('run-preview:open', request),
  },

  // App lifecycle
  app: {
    findContent: (query: string, options: import('../../contracts/content-find').ContentFindOptions = {}): Promise<import('../../contracts/content-find').ContentFindResult> => call('app:content-find', { action: 'find', query, options }),
    stopContentFind: (): Promise<void> => call('app:content-find', { action: 'stop' }),
    reportNativeMenuState: (state: import('../../contracts/native-menu-state').NativeMenuState) => call('app:native-menu-state', state),
    distribution: (): Promise<DesktopDistribution> => call('app:distribution'),
    loginItem: {
      get: () => call('app:loginItem:get'),
      set: (enabled: boolean) => call('app:loginItem:set', { enabled }),
    },
    // Camera lease for the friends scan dialog: the host media gate admits
    // video only while this lease is held, and the dialog releases it on close.
    cameraLease: () => call('app:camera-lease'),
    cameraLeaseRelease: () => call('app:camera-lease-release'),
    openExternal: (url: string) => call('app:openExternal', { url }),
    // 待处理审批/提问数 → 系统角标（macOS Dock 数字 / Windows 任务栏 overlay）。
    setApprovalBadge: (count: number) => call('app:setApprovalBadge', { count }),
    // 焦点是否落在自持撤销历史的 composer 里。宿主据此决定是否把系统的
    // Cmd+Z / Cmd+Shift+Z 从 Chromium 手里接过来交给 composer 自己的历史栈；
    // 上报失败只是让撤销退回原生行为，不影响输入，所以调用方吞掉错误。
    reportComposerFocus: (owned: boolean) => call('composer:edit-focus', { owned }),
  },

  // Window chrome（Windows titleBarOverlay 跟随主题真实颜色；macOS no-op）
  window: {
    setTitleBarColors: (color: string, symbolColor: string) =>
      call('window:setTitleBarColors', { color, symbolColor }),
  },

  // Integrated terminal
  terminal: {
    start: (opts?: { id?: string; cwd?: string | null; cols?: number; rows?: number }) =>
      call('terminal:start', opts ?? {}),
    write: (id: string, data: string) => call('terminal:write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      call('terminal:resize', { id, cols, rows }),
    kill: (id: string) => call('terminal:kill', { id }),
  },

  // Permission response
  approvalReview: {
    approve: (sessionId: string, event: Record<string, unknown>): Promise<Record<string, never>> => call('approval-review:approve', { sessionId, event }),
  },
  permission: {
    pending: (sessionId: string) => call('permission:pending', { sessionId }),
    respond: (
      requestId: string,
      decision: 'allow' | 'deny',
      acceptedSuggestionIndices?: number[],
      updatedInput?: Record<string, unknown>,
    ) =>
      call('permission:respond', { requestId, decision, acceptedSuggestionIndices, updatedInput }),
  },

  // Elicit response（引擎内置 ask_user 追问卡 → resolveElicit）
  elicit: {
    pending: (sessionId: string) => call('elicit:pending', { sessionId }),
    respond: (
      requestId: string,
      response: { kind: 'accept'; values: string[] } | { kind: 'answers'; answers: Record<string, string>; attachments?: Record<string, Array<{ path: string; name: string; type: string; size: number }>> } | { kind: 'decline'; reason?: string },
    ) => call('elicit:respond', { requestId, response }),
  },

  // Nonblocking questions are bound to the turn that asked them.
  question: {
    pending: (sessionId: string) => call('question:pending', { sessionId }),
    answer: (sessionId: string, requestId: string, turnId: string, clientResponseId: string,
      answers: Record<string, string>, attachments?: Record<string, Array<{ path: string; name: string; type: string; size: number }>>) =>
      call('question:answer', { sessionId, requestId, turnId, clientResponseId, answers, attachments }),
  },

  // 用户态记忆快照合并决策（merge/keep/replace → resolveSnapshotDecision）
  memorySnapshot: {
    respond: (requestId: string, choice: 'merge' | 'keep' | 'replace') =>
      call('memory-snapshot:respond', { requestId, choice }),
  },

  // System-level privacy permissions (macOS only)
  systemPermissions: {
    check: () => call('system:permissions:check'),
    openSettings: (type: string) => call('system:permissions:open', { type }),
    request: (type: string) => call('system:permissions:request', { type }),
    restartApp: () => call('system:restart-app'),
  },

  // MCP
  mcp: {
    reconnect: () => call('mcp:reconnect'),
    // 诊断证据包：宿主落盘排障材料并返回日志路径（智能诊断会话用）。
    diagnoseBundle: (name: string, lastError?: string) =>
      call('mcp:diagnose:bundle', { name, lastError }),
    // 设备授权流（GitHub 等不支持 DCR 的服务商）：开始拿 user_code / 等终态 / 取消 / 读写 client_id。
    deviceStart: (id: string) => call('mcp:device:start', { id }),
    deviceWait: (id: string) => call('mcp:device:wait', { id }),
    deviceCancel: (id: string) => call('mcp:device:cancel', { id }),
    deviceClientId: (id: string, clientId?: string) =>
      call('mcp:device:client-id', { id, clientId }),
    status: () => call('mcp:status'),
    list: () => call('mcp:list'),
    create: (input: any) => call('mcp:create', input),
    update: (name: string, config: any) => call('mcp:update', { name, config }),
    toggle: (name: string, enabled: boolean) => call('mcp:toggle', { name, enabled }),
    // 单个工具的启停：写这条 server 自己的 disabledTools，引擎从同一份 init 读并在
    // tools/list 后过滤，与 connectors.setToolEnabled 同形，但作用于用户自建的 MCP server。
    setToolEnabled: (name: string, toolName: string, enabled: boolean) =>
      call('mcp:setToolEnabled', { name, toolName, enabled }),
    remove: (name: string) => call('mcp:remove', { name }),
    importJson: (json: string) => call('mcp:import', { json }),
    revokeAuth: (name: string) => call('mcp:revokeAuth', { name }),
    builtinList: () => call('mcp:builtin:list'),
    builtinInstall: (id: string, env: Record<string, string>) =>
      call('mcp:builtin:install', { id, env }),
    uvCheck: () => call('mcp:uv:check'),
    // klaus 引擎 MCP OAuth 桥：列出 needs-auth server / 主动触发某 server 授权。
    klausNeedsAuth: () => call('mcp:klaus:needs-auth'),
    klausAuthenticate: (name: string) => call('mcp:klaus:authenticate', { name }),
    // 某会话工作目录下生效的 MCP（含项目级 <cwd>/.klaus/mcp.json），供聊天区只读卡片。
    sessionStatus: (sessionId?: string, cwd?: string, workspaceId?: string) => call('mcp:session:status', { sessionId, cwd, workspaceId }),
    // 项目作用域 MCP 增删改查：直接读写 <cwd>/.klaus/mcp.json（写入口在工作目录 popover）。
    project: {
      list: (cwd: string) => call('mcp:project:list', { cwd }),
      create: (cwd: string, name: string, config: Record<string, unknown>) => call('mcp:project:create', { cwd, name, config }),
      update: (cwd: string, name: string, config: Record<string, unknown>) => call('mcp:project:update', { cwd, name, config }),
      toggle: (cwd: string, name: string, enabled: boolean) => call('mcp:project:toggle', { cwd, name, enabled }),
      remove: (cwd: string, name: string) => call('mcp:project:remove', { cwd, name }),
    },
    // 本地作用域 MCP 增删改查：读写 ~/.klaus/projects.json（按 cwd 键、私有不进仓库；写入口同工作目录 popover）。
    local: {
      list: (cwd: string) => call('mcp:local:list', { cwd }),
      create: (cwd: string, name: string, config: Record<string, unknown>) => call('mcp:local:create', { cwd, name, config }),
      update: (cwd: string, name: string, config: Record<string, unknown>) => call('mcp:local:update', { cwd, name, config }),
      toggle: (cwd: string, name: string, enabled: boolean) => call('mcp:local:toggle', { cwd, name, enabled }),
      remove: (cwd: string, name: string) => call('mcp:local:remove', { cwd, name }),
    },
    // 项目 .mcp.json 信任门：批准/拒绝项目声明的 project 作用域 MCP server（未批准则不连）。
    // 决定写 <cwd>/.klaus/settings.local.json（per-user 私有、不提交）。reset 清空该项目全部决定。
    trust: {
      decide: (cwd: string, decisions: { approved?: string[]; rejected?: string[]; enableAllFuture?: boolean }) =>
        call('mcp:trust:decide', { cwd, ...decisions }),
      reset: (cwd: string) => call('mcp:trust:reset', { cwd }),
    },
  },

  // Connectors (Klaus built-in system integrations)
  connectors: {
    list: () => call('connectors:list'),
    toggle: (id: string, enabled: boolean) =>
      call('connectors:toggle', { id, enabled }),
    preflight: (id: string) => call('connectors:preflight', { id }),
    setToolEnabled: (id: string, toolName: string, enabled: boolean) =>
      call('connectors:setToolEnabled', { id, toolName, enabled }),
    status: () => call('connectors:status'),
  },

  // Skills
  skills: {
    // 不传 projectRoot = 全局 (~/.klaus/skills)；传 = 项目级 (<root>/.klaus/skills)。
    list: (opts?: { projectRoot?: string; workspaceId?: string }) => call('skills:list', opts),
    market: (opts?: { cursor?: string; limit?: number; query?: string }) =>
      call('skills:market', opts),
    builtin: () => call('skills:builtin'),
    install: (name: string, options?: { installMissing?: boolean; skipDependencyInstall?: boolean; version?: string }) =>
      call('skills:install', {
        name,
        installMissing: !!options?.installMissing,
        skipDependencyInstall: !!options?.skipDependencyInstall,
        version: options?.version,
      }),
    update: (slug: string, version?: string) =>
      call('skills:update', { slug, version }),
    uninstall: (name: string, opts?: { projectRoot?: string }) =>
      call('skills:uninstall', { name, projectRoot: opts?.projectRoot }),
    toggle: (name: string, enabled: boolean) => call('skills:toggle', { name, enabled }),
    upload: (name: string, buffer: ArrayBuffer, opts?: { force?: boolean }) =>
      call('skills:upload', { name, buffer, force: !!opts?.force }),
    // Install one skill from a direct HTTP(S) ZIP archive.
    installFromSource: (spec: string, opts?: { name?: string; force?: boolean }) =>
      call('skills:install-from-source', {
        spec,
        name: opts?.name,
        force: !!opts?.force,
      }),
    // Read SKILL.md for the artifact-window preview. Relative paths resolve
    // under ~/.klaus/skills; absolute project-skill paths are validated in main.
    readFile: (filePath: string) => call('skills:read-file', { filePath }),
    // Open SKILL.md in the standalone preview window. Pass skill name; main
    // resolves the path (projectRoot = project-scoped skill, validated in main).
    openWindow: (name: string, opts?: { projectRoot?: string }) =>
      call('skills:open-window', { name, projectRoot: opts?.projectRoot }),
  },

  // Plugins
  //
  // Install / enable / uninstall are ENGINE operations: the engine owns the
  // installed-plugin ledger (it loads it at startup), so there is no project
  // scope and no dependency pre-install to pass here.
  plugins: {
    list: (sessionId?: string) => call('plugins:list', { sessionId }),
    runtime: (sessionId?: string) => call('plugins:runtime', { sessionId }),
    market: () => call('plugins:market'),
    refresh: (options?: { ifStale?: boolean }) => call('plugins:refresh', options ?? {}),
    // `source` is a GitHub `owner/repo`, a git URL, or an absolute directory.
    addMarketplace: (source: string) => call('plugins:marketplace:add', { source }),
    install: (id: string, options?: { sessionId?: string }) =>
      call('plugins:install', { id, sessionId: options?.sessionId }),
    update: (id: string, options: { version: string; installedVersion?: string }) =>
      call('plugins:update', { id, ...options }),
    cancel: (id: string) => call('plugins:cancel', { id }),
    uninstall: (id: string, sessionId?: string) => call('plugins:uninstall', { id, sessionId }),
    toggle: (id: string, enabled: boolean, sessionId?: string) =>
      call('plugins:toggle', { id, enabled, sessionId }),
  },

  // Auth (Claude 订阅登录)
  auth: {
    status: () => call('auth:status'),
    login: () => call('auth:login'),
    logout: (accountId?: string) => call('auth:logout', accountId ? { accountId } : {}),
    importLocal: () => call('auth:import-local'),
  },

  // Auth (Codex / ChatGPT 订阅登录)
  codexAuth: {
    status: () => call('codex-auth:status'),
    start: () => call('codex-auth:start'),
    poll: (deviceCode: string) => call('codex-auth:poll', { deviceCode }),
    logout: () => call('codex-auth:logout'),
    importLocal: () => call('codex-auth:import-local'),
    models: (opts?: { force?: boolean }) => call('codex-auth:models', { force: !!opts?.force }),
  },


  // Browser authorization and imported snapshots use separate credential lifecycles.
  cursorAuth: {
    status: () => call('cursor-auth:status'),
    start: () => call('cursor-auth:start'),
    poll: (flowId: string) => call('cursor-auth:poll', { flowId }),
    cancel: (flowId: string) => call('cursor-auth:cancel', { flowId }),
    importLocal: () => call('cursor-auth:import-local'),
    logout: () => call('cursor-auth:logout'),
    models: (forceRefresh?: boolean) => call('cursor-auth:models', { forceRefresh: forceRefresh === true }),
  },

  // Auth (Qoder 订阅登录)：device flow 由完整的 start/poll 两步驱动，凭证归
  // Klaus 自己；logout 不动 Qoder 客户端，importLocal 才去读它的登录态。
  qoderAuth: {
    status: () => call('qoder-auth:status'),
    start: () => call('qoder-auth:start'),
    poll: (flowId: string) => call('qoder-auth:poll', { flowId }),
    logout: () => call('qoder-auth:logout'),
    importLocal: () => call('qoder-auth:import-local'),
    models: () => call('qoder-auth:models'),
  },

  traeAuth: {
    status: () => call('trae-auth:status'),
    start: () => call('trae-auth:start'),
    poll: (flowId: string) => call('trae-auth:poll', { flowId }),
    cancel: (flowId: string) => call('trae-auth:cancel', { flowId }),
    importLocal: () => call('trae-auth:import-local'),
    logout: () => call('trae-auth:logout'),
    models: () => call('trae-auth:models'),
  },
  kiroAuth: {
    status: () => call('kiro-auth:status'),
    start: () => call('kiro-auth:start'),
    poll: (flowId: string) => call('kiro-auth:poll', { flowId }),
    cancel: (flowId: string) => call('kiro-auth:cancel', { flowId }),
    importLocal: () => call('kiro-auth:import-local'),
    logout: () => call('kiro-auth:logout'),
    models: () => call('kiro-auth:models'),
  },
  // Browser authorization and local credential reuse are independent entrypoints.
  antigravityAuth: {
    status: () => call('antigravity-auth:status'),
    start: () => call('antigravity-auth:start'),
    poll: (flowId: string) => call('antigravity-auth:poll', { flowId }),
    cancel: (flowId: string) => call('antigravity-auth:cancel', { flowId }),
    importLocal: () => call('antigravity-auth:import-local'),
    logout: () => call('antigravity-auth:logout'),
    models: () => call('antigravity-auth:models'),
  },
  // The engine owns this subscription's credentials and cloud protocol.
  qwenworkAuth: {
    status: () => call('qwenwork-auth:status'),
    start: () => call('qwenwork-auth:start'),
    poll: (flowId: string) => call('qwenwork-auth:poll', { flowId }),
    logout: () => call('qwenwork-auth:logout'),
    importLocal: () => call('qwenwork-auth:import-local'),
    models: () => call('qwenwork-auth:models'),
  },

  // Auth (WorkBuddy subscription). The engine owns the external-link login and the
  // catalog; the shell only opens the returned browser URL. Importing reuses a
  // login WorkBuddy AI already holds, decrypted by that app's own runtime.
  workbuddyAuth: {
    status: () => call('workbuddy-auth:status'),
    start: (region?: 'cn' | 'intl') => call('workbuddy-auth:start', region === undefined ? {} : { region }),
    poll: (flowId: string) => call('workbuddy-auth:poll', { flowId }),
    logout: () => call('workbuddy-auth:logout'),
    importLocal: (region?: 'cn' | 'intl') => call('workbuddy-auth:import-local', region === undefined ? {} : { region }),
    models: () => call('workbuddy-auth:models'),
  },

  // Kimi keeps the same surface as the other subscription sources, plus the one
  // they do not have: a console API key, which is the credential Kimi documents
  // for third-party clients. `importLocal` is deliberately absent — Kimi leaves
  // no local store this app can read.
  kimiAuth: {
    status: () => call('kimi-auth:status'),
    setApiKey: (apiKey: string, apiBase?: string) =>
      call('kimi-auth:set-api-key', apiBase ? { apiKey, apiBase } : { apiKey }),
    start: () => call('kimi-auth:start'),
    poll: (flowId: string) => call('kimi-auth:poll', { flowId }),
    logout: () => call('kimi-auth:logout'),
    models: () => call('kimi-auth:models'),
  },

  // Aliyun Bailian Token Plan. Narrower than the others in both directions: a plan
  // key is the ONLY credential the service accepts, so there is no `start`/`poll`
  // pair and no `importLocal`, and the second argument names a SITE ('cn' | 'intl')
  // rather than a base URL — Token Plan serves exactly one region per site and a key
  // is bound to the site that issued it.
  bailianAuth: {
    status: () => call('bailian-auth:status'),
    setApiKey: (apiKey: string, region?: string) =>
      call('bailian-auth:set-api-key', region ? { apiKey, region } : { apiKey }),
    logout: () => call('bailian-auth:logout'),
    models: () => call('bailian-auth:models'),
    consoleLogin: () => call('bailian-auth:console-login'),
    consoleStatus: () => call('bailian-auth:console-status'),
    consoleLogout: () => call('bailian-auth:console-logout'),
  },

  // MiniMax M Plan. A subscription key is the only credential the plan accepts, so
  // there is no `start`/`poll` pair and no `importLocal`. The second argument names a
  // SITE ('cn' | 'global'), and an empty or absent one means the engine should detect
  // the site from the key: both sites mint the same `sk-cp-` shape and do not share
  // keys, so defaulting to either would report a good key from the other site as
  // invalid. Omitting `region` from the payload entirely is what asks for detection.
  minimaxAuth: {
    status: () => call('minimax-auth:status'),
    setApiKey: (apiKey: string, region?: string) =>
      call('minimax-auth:set-api-key', region ? { apiKey, region } : { apiKey }),
    logout: () => call('minimax-auth:logout'),
    models: () => call('minimax-auth:models'),
  },

  // Zhipu GLM Coding Plan. The same narrow surface as the Bailian one above, and for
  // the same reason: a plan key is the only credential the service accepts, so there
  // is no `start`/`poll` pair and no `importLocal`, and the second argument names a
  // SITE ('cn' | 'intl') rather than a base URL — Coding Plan is sold by two
  // platforms whose accounts and keys do not cross.
  zhipuAuth: {
    status: () => call('zhipu-auth:status'),
    setApiKey: (apiKey: string, region?: string) =>
      call('zhipu-auth:set-api-key', region ? { apiKey, region } : { apiKey }),
    logout: () => call('zhipu-auth:logout'),
    models: () => call('zhipu-auth:models'),
  },

  // Volcengine Ark Coding Plan. The same narrow surface as the other plan sources:
  // a plan key is the only credential the service accepts, so there is no
  // `start`/`poll` pair and no `importLocal`. The optional second argument names the
  // single published region; the engine refuses any other value rather than probing.
  arkAuth: {
    status: () => call('ark-auth:status'),
    setApiKey: (apiKey: string, region?: string) =>
      call('ark-auth:set-api-key', region ? { apiKey, region } : { apiKey }),
    logout: () => call('ark-auth:logout'),
    models: () => call('ark-auth:models'),
    // The console session that unlocks the allowance figures the plan key cannot
    // read. Login opens the browser on the engine's authorize URL; the card polls
    // status until the loopback callback stores the session.
    consoleLogin: () => call('ark-auth:console-login'),
    consoleStatus: () => call('ark-auth:console-status'),
    consoleLogout: () => call('ark-auth:console-logout'),
  },

  // The quota popover follows the active conversation or the new-chat default.
  usage: {
    subscriptions: (sessionId?: string | null) => call('usage:subscriptions', sessionId ? { sessionId } : {}),
  },

  // modelSources registry removed — channels are no-ops on the backend

  // Klaus account sign-in opens the browser and polls for completion. Guest mode
  // is a separate local entry that does not create or imitate a cloud account.
  klausAuth: {
    status: () => call('klausAuth:status'),
    login: () => call('klausAuth:login'),
    // Aborts a pending login: the shell's poll loop notices on its next tick.
    cancelLogin: () => call('klausAuth:cancelLogin'),
    // Enter the local workbench without a Klaus cloud account.
    guestEnter: () => call('klausAuth:guestEnter'),
    // Login-dialog window mode: true shrinks the main window to the card size
    // (fixed, centred), false restores the working size.
    loginWindow: (active: boolean) => call('klausAuth:loginWindow', { active }),
    clientConfig: () => call('klausAuth:clientConfig'),
    logout: (opts?: { wipeLocal?: boolean }) =>
      call('klausAuth:logout', opts),
    /** Destructive: wipes ~/.klaus settings/sessions/transcripts/uploads. Confirm in UI first. */
    wipeLocal: () => call('klausAuth:wipeLocal'),
    updateProfile: (displayName: string) =>
      call('klausAuth:updateProfile', { displayName }),
    uploadAvatar: (mime: string, buffer: ArrayBuffer) =>
      call('klausAuth:uploadAvatar', { mime, buffer }),
    subscription: () => call('klausAuth:subscription'),
  },

  // 桌面端自动更新（feed 指向 Klaus 云端 release 服务）
  updater: {
    status: () => call('updater:status'),
    // A person-initiated check is the only attempt that shows a result notice;
    // the background cadence runs in the host without this flag.
    check: (args?: { explicit?: boolean }) => call('updater:check', args ?? {}),
    install: () => call('updater:install'),
  },

  friends: {
    sendMessage: (args: { friendId: string; prompt: string; sessionId: string; intent: FriendMessageIntent; onReply?: FriendOnReply; requestId?: string; supplementToRequestId?: string; replyToMessageId?: string; questionId?: string } | { sessionId: string; text: string; displayMetadata: Record<string, unknown> }): Promise<unknown> => call('friends:send-message', args),
    list: (): Promise<FriendsSnapshot> => call('friends:list'),
    runtime: (): Promise<FriendsRuntimeSnapshot> => call('friends:runtime'),
    setReceiver: (args: { deviceId: string }): Promise<FriendsRuntimeSnapshot> => call('friends:set-receiver', args),
    apps: (args: { deviceId: string }): Promise<FriendAppsSnapshot> => call('friends:apps', args),
    approve: (args: { taskId: string; grant: FriendTaskGrant }): Promise<FriendsRuntimeSnapshot> => call('friends:approve', args),
    retryReply: (args: { taskId: string }): Promise<FriendsRuntimeSnapshot> => call('friends:retry-reply', args),
    retrySend: (args: { requestId: string }): Promise<FriendsRuntimeSnapshot> => call('friends:retry-send', args),
    prepareLocalAssist: (args: { sessionId: string; friendId: string; text: string; messageId?: string }): Promise<{ sessionId: string }> => call('friends:prepare-local-assist', args),
    reject: (args: { taskId: string }): Promise<FriendsRuntimeSnapshot> => call('friends:reject', args),
    ignore: (args: { scope: 'task' | 'friend' | 'all'; taskId?: string; friendId?: string }): Promise<FriendsRuntimeSnapshot> => call('friends:ignore', args),
    cancel: (args: { taskId: string } | { requestId: string }): Promise<FriendsRuntimeSnapshot> => call('friends:cancel', args),
    saveTemplate: (args: { friendId: string; deviceId: string; grant: FriendTaskGrant }): Promise<FriendsRuntimeSnapshot> => call('friends:save-template', args),
    revokeTemplate: (args: { friendId: string; deviceId: string }): Promise<FriendsRuntimeSnapshot> => call('friends:revoke-template', args),
    setDefaultGrant: (args: { grant: FriendTaskGrant }): Promise<FriendsRuntimeSnapshot> => call('friends:set-default-grant', args),
    resolveAccessRequest: (args: { requestId: string; decision: 'approve' | 'decline'; remember?: boolean }): Promise<FriendsRuntimeSnapshot> => call('friends:resolve-access-request', args),
    pendingAccessRequests: (): Promise<any[]> => call('friends:pending-access-requests'),
    requestReply: (args: { taskId: string }): Promise<FriendsRuntimeSnapshot> => call('friends:request-reply', args),
    lookup: (email: string): Promise<{ profile: FriendProfile | null }> => call('friends:lookup', { email }),
    request: (args: { email: string; allowIncomingAgentTasks: boolean; grant?: FriendTaskGrant }): Promise<FriendsSnapshot> => call('friends:request', args),
    respond: (args: { friendId: string; accept: boolean; allowIncomingAgentTasks: boolean }): Promise<FriendsSnapshot> => call('friends:respond', args),
    setAuthorization: (args: { friendId: string; allowed: boolean }): Promise<FriendsSnapshot> => call('friends:set-authorization', args),
    setRemark: (args: { friendId: string; remark: string }): Promise<FriendsSnapshot> => call('friends:set-remark', args),
    remove: (args: { friendId: string }): Promise<FriendsSnapshot> => call('friends:remove', args),
    myCard: (): Promise<FriendCard> => call('friends:my-card'),
    saveQrCard: (): Promise<{ saved: boolean; path: string | null }> => call('friends:save-qr-card'),
    shareQrCard: (): Promise<{ shared: boolean }> => call('friends:share-qr-card'),
  },

  // Dream / autoMemory — feeds the sidebar 「记忆」 view (current dream card,
  // history list with infinite scroll, memory file browser).
  dream: {
    current: () => call('dream:current'),
    list: (filters?: { before?: number; from?: number; to?: number; limit?: number }) =>
      call('dream:list', filters ?? {}),
    detail: (taskId: string) => call('dream:detail', { taskId }),
    stop: (taskId: string) => call('dream:stop', { taskId }),
    triggerNow: () => call('dream:trigger-now'),
    configGet: () => call('dream:config-get'),
    configSet: (cfg: { enabled?: boolean; minHours?: number; minSessions?: number }) =>
      call('dream:config-set', cfg),
  },
  memory: {
    readFile: (relPath: string) => call('memory:read-file', { relPath }),
    reveal: () => call('memory:reveal'),
    /** Open a single memory file in the standalone preview window
     *  (same UI as artifacts.openWindow but for memory dir paths). */
    openWindow: (filePath: string) => call('memory:open-window', { filePath }),
  },

  // Channels
  channels: {
    list: () => call('channels:list'),
    connect: (id: string, config: any) => call('channels:connect', { id, config }),
    disconnect: (id: string) => call('channels:disconnect', { id }),
    discordAccess: () => call('channels:discord:access'),
    discordSetDmPolicy: (dmPolicy: string) => call('channels:discord:setDmPolicy', { dmPolicy }),
    discordApprovePending: (code: string) => call('channels:discord:approvePending', { code }),
    discordDenyPending: (code: string) => call('channels:discord:denyPending', { code }),
    discordAddAllowFrom: (senderId: string) => call('channels:discord:addAllowFrom', { senderId }),
    discordRemoveAllowFrom: (senderId: string) => call('channels:discord:removeAllowFrom', { senderId }),
    discordUpsertGroup: (payload: { channelId: string, requireMention?: boolean, allowFrom?: string[] }) =>
      call('channels:discord:upsertGroup', payload),
    discordRemoveGroup: (channelId: string) => call('channels:discord:removeGroup', { channelId }),
    discordUpdateDelivery: (payload: any) => call('channels:discord:updateDelivery', payload),
    wechatQrStart: () => call('channels:wechat:qrStart'),
    wechatQrPoll: () => call('channels:wechat:qrPoll'),
    whatsappStart: () => call('channels:whatsapp:start'),
    whatsappPoll: () => call('channels:whatsapp:poll'),
  },

  // Host → UI pushes. Each returns an unsubscribe fn.
  on: {
    skillsChanged: (cb: () => void): Unsubscribe =>
      subscribe('skills:changed', () => cb()),
    // The shell aggregates stream events into ~16ms frames to cut per-event IPC
    // overhead. Unpacked in order here, so UI handlers keep their
    // one-event-at-a-time contract.
    chatEvent: (cb: (event: any) => void): Unsubscribe =>
      subscribe('chat:event:batch', (events: any) => {
        if (!Array.isArray(events)) return
        for (const event of events) cb(event)
      }),
    permissionRequest: (cb: (req: any) => void): Unsubscribe =>
      subscribe('permission:request', (req: any) => cb(req)),
    elicitRequest: (cb: (req: any) => void): Unsubscribe =>
      subscribe('elicit:request', (req: any) => cb(req)),
    friendAccessRequest: (cb: (req: any) => void): Unsubscribe =>
      subscribe('friend:access-request', (req: any) => cb(req)),
    friendAccessResolved: (cb: (resolution: any) => void): Unsubscribe =>
      subscribe('friend:access-resolved', (resolution: any) => cb(resolution)),
    planningInputRequested: (cb: (req: PlanningInputRequest) => void): Unsubscribe => subscribe('planning-input:requested', cb),
    planningInputResolved: (cb: (req: PlanningInputRequest) => void): Unsubscribe => subscribe('planning-input:resolved', cb),
    questionRequested: (cb: (req: AsyncQuestionRequest) => void): Unsubscribe =>
      subscribe('question:requested', (req: AsyncQuestionRequest) => cb(req)),
    questionResolved: (cb: (resolution: AsyncQuestionResolution) => void): Unsubscribe =>
      subscribe('question:resolved', (resolution: AsyncQuestionResolution) => cb(resolution)),
    memorySnapshotPrompt: (cb: (req: any) => void): Unsubscribe =>
      subscribe('memory:snapshot:prompt', (req: any) => cb(req)),
    engineStatus: (cb: (status: any) => void): Unsubscribe =>
      subscribe('engine:status', (status: any) => cb(status)),
    engineProcessCrashed: (cb: (payload: { detail?: string }) => void): Unsubscribe =>
      subscribe('engine:process-crashed', (payload: { detail?: string }) => cb(payload)),
    notifySound: (cb: (kind: 'done' | 'input') => void): Unsubscribe =>
      subscribe('notify:sound', (kind: 'done' | 'input') => cb(kind)),
    friendMessageArrived: (cb: (payload: { sessionId: string; friendId: string; senderName: string; preview: string; wantReply: boolean; muted: boolean; ts: number }) => void): Unsubscribe =>
      subscribe('friends:message-arrived', (payload: { sessionId: string; friendId: string; senderName: string; preview: string; wantReply: boolean; task?: boolean; muted: boolean; ts: number }) => cb(payload)),
    trayNewChat: (cb: () => void): Unsubscribe =>
      subscribe('tray:new-chat', () => cb()),
    desktopPetDraft: (cb: (payload: { text: string }) => void | Promise<void>): Unsubscribe =>
      subscribe('desktop-pet:draft', cb),
    desktopPetMainCapture: (cb: (payload: PetMainCapture) => void | Promise<void>): Unsubscribe => subscribe('desktop-pet:appshot-main-capture', cb),
    // The recorder panel ended a recording itself (stop or discard): the chat
    // picks it up and asks the model to draft the skill while the user's
    // demonstration intent is still in context.
    recordEnded: (cb: (payload: { recordingId: string; sessionId: string; generation: number; mode: 'stop' | 'discard' | 'error'; eventsPath?: string; error?: string }) => void | Promise<void>): Unsubscribe =>
      subscribe('computer-use:record:ended', (payload: any) => cb(payload)),
    // 全局快速输入窗提交：主窗收到后新建会话并直接发送该段文本。
    quickInputSubmit: (cb: (payload: { text: string; submissionId?: string }) => void | Promise<void>): Unsubscribe =>
      subscribe('quick-input:submit', (payload: { text: string; submissionId?: string }) => cb(payload)),
    trayOpenSettings: (cb: () => void): Unsubscribe =>
      subscribe('tray:open-settings', () => cb()),
    deepLinkOpenSession: (cb: (payload: { sessionId: string }) => void): Unsubscribe =>
      subscribe('deep-link:open-session', (payload: { sessionId: string }) => cb(payload)),
    deepLinkOpenTeamIssue: (cb: (payload: TeamIssueDeepLink) => void | Promise<void>): Unsubscribe =>
      subscribe('deep-link:open-team-issue', (payload: TeamIssueDeepLink) => cb(payload)),
    deepLinkFriendInvite: (cb: (payload: { email: string }) => void): Unsubscribe =>
      subscribe('deep-link:friend-invite', (payload: { email: string }) => cb(payload)),
    deepLinkFriendTask: (cb: (payload: { taskId: string }) => void): Unsubscribe =>
      subscribe('deep-link:friend-task', (payload: { taskId: string }) => cb(payload)),
    /**
     * The agent asked to move the window (klaus_action nav.open), so the user
     * ends up looking at whatever was just discussed. `view` is a page-view id
     * or 'settings' / 'chat'; `tab` is a settings tab and only meaningful for
     * view 'settings'. The host validated both before pushing.
     */
    appNavigate: (cb: (payload: { view: string; tab?: string; focusComposer?: boolean }) => void): Unsubscribe =>
      subscribe('app:navigate', (payload: { view: string; tab?: string; focusComposer?: boolean }) => cb(payload)),
    /**
     * A setting was written by the agent (klaus_action preference.set or
     * setting.set) rather than by a widget in this window.
     * Every widget keeps itself current after its own write; a write from the
     * outside has nobody doing that, so appearance, language and an open
     * settings page would keep showing what they read at open. `key` is the
     * storage row that moved.
     */
    appPreferencesChanged: (cb: (payload: { key: string }) => void): Unsubscribe =>
      subscribe('app:preferences-changed', (payload: { key: string }) => cb(payload)),
    /**
     * The keymap changed on the host side: a binding was set/removed/reset, so
     * the stored accelerators, the native menu and the os-global hotkeys all
     * moved. The renderer re-reads `settings.keymap.state()` and rebuilds its
     * listeners, the settings page and the read-only dialog refresh, and any
     * in-UI key hints update. Pushed after every successful host write.
     */
    keymapChanged: (cb: () => void): Unsubscribe =>
      subscribe('keymap:changed', () => cb()),
    /**
     * A native application-menu item was clicked. The menu does not run the
     * action itself — it forwards the command id so the renderer dispatches
     * through the same handler table a keybinding uses, which keeps one
     * execution path per command (the payload is `{commandId}`).
     */
    keymapRunCommand: (cb: (payload: { commandId: string }) => void): Unsubscribe =>
      subscribe('keymap:run-command', (payload: { commandId: string }) => cb(payload)),
    klausAuthUpdated: (cb: (payload: { user: any }) => void): Unsubscribe =>
      subscribe('klausAuth:updated', (payload: { user: any }) => cb(payload)),
    // A background refresh resolved a different gate value (e.g. ops opened
    // teamCollaboration for this account): surfaces appear/disappear live.
    featureGatesUpdated: (cb: (payload: { features: Record<string, boolean> }) => void): Unsubscribe =>
      subscribe('feature-gates:updated', (payload: { features: Record<string, boolean> }) => cb(payload)),
    // Fired when a login starts; carries the browser URL so the waiting screen
    // can offer "copy the login link" when the browser never showed up.
    klausAuthLoginPending: (cb: (payload: { url?: string }) => void): Unsubscribe =>
      subscribe('klausAuth:loginPending', (payload: { url?: string }) => cb(payload)),
    updaterStatus: (cb: (status: any) => void): Unsubscribe =>
      subscribe('updater:status', (status: any) => cb(status)),
    pluginProgress: (cb: (progress: any) => void): Unsubscribe =>
      subscribe('plugins:progress', (progress: any) => cb(progress)),
    mcpStatusUpdated: (cb: (payload: { cwd?: string }) => void): Unsubscribe =>
      subscribe('mcp:status:updated', (payload: { cwd?: string }) => cb(payload)),
    /**
     * The thread's goal changed. Pushed for every change the ENGINE made (the
     * model creating or finishing one, usage reaching the budget, a failed turn
     * blocking it), so the composer indicator does not have to poll.
     */
    goalUpdated: (cb: (payload: GoalUpdated) => void): Unsubscribe =>
      subscribe('goal:updated', (payload: GoalUpdated) => cb(payload)),
    planningUpdated: (cb: (payload: PlanningUpdated) => void): Unsubscribe =>
      subscribe('planning:updated', (payload: PlanningUpdated) => cb(payload)),
    backgroundProcessChanged: (cb: (payload: BackgroundProcessChangedPush) => void): Unsubscribe =>
      subscribe('background-process:changed', (payload: BackgroundProcessChangedPush) => cb(payload)),
    friendsChanged: (cb: () => void): Unsubscribe => subscribe('friends:changed', () => cb()),
    dreamEvent: (cb: (snap: any) => void): Unsubscribe =>
      subscribe('dream:event', (snap: any) => cb(snap)),
    terminalData: (cb: (payload: { id: string; data: string }) => void | Promise<void>): Unsubscribe =>
      subscribe('terminal:data', (payload: { id: string; data: string }) => cb(payload)),
    terminalExit: (cb: (payload: { id: string; exitCode?: number; signal?: number }) => void): Unsubscribe =>
      subscribe('terminal:exit', (payload: { id: string; exitCode?: number; signal?: number }) => cb(payload)),
    computerUsePipState: (cb: (state: ComputerUsePipState) => void): Unsubscribe =>
      subscribe('computer-use-pip:state', cb),
    browserUseState: (cb: (state: any) => void): Unsubscribe =>
      subscribe('browser-use:state', (state: any) => cb(state)),
    browserUseOpenPanel: (cb: (payload?: any) => void): Unsubscribe =>
      subscribe('browser-use:open-panel', (payload?: any) => cb(payload)),
    runPreviewChanged: (cb: (payload: { sessionId: string; toolCallId: string }) => void): Unsubscribe =>
      subscribe('run-preview:changed', cb),
    cronFailed: (cb: (payload: any) => void): Unsubscribe =>
      subscribe('cron:failed', (payload: any) => cb(payload)),
    channelFailed: (cb: (payload: { label: string; error: string }) => void): Unsubscribe =>
      subscribe('channel:failed', (payload: { label: string; error: string }) => cb(payload)),
  },

})
