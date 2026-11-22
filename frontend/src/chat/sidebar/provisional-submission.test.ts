import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DraftSessionPromotion } from '../draft-session-promotion'
import { GoalInteractionClock } from '../goals/draft-review'
import { createGoalSubmissionGate } from '../goal-creation'
import { normalizeComposerDraft } from '../composer/slash-draft'
import { clientMessageId as userMessageClientId } from '../../../../contracts/message-identity'
import { runContextRowVisible } from '../run-context'
import { transcriptChromeState, transcriptContentPresence } from '../transcript/chrome-state'
import {
  automationSourceLabel,
  isPinnedSession,
  isPlaceholderSessionTitle,
  partitionSidebarSessions,
} from './model'
import {
  hasMoreProjectThreads,
  isProjectOpen,
  isSectionCollapsed,
  mergeCollapsedBadge,
  parseSectionsCollapsed,
  placeProvisionalProjectRow,
  projectThreadWindow,
  readProjectExpansion,
  reduceCollapsedBadge,
  revealDecision,
  withProjectExpansion,
  withSectionCollapsed,
} from './collapse'
import { reconcileOrder } from './project-order'
import { sortSectionRows } from './sort'
import { chatFunctionFixture } from '../test-support/chat-function-fixture'

;(globalThis as unknown as { window?: Record<string, unknown> }).window = {
  ...((globalThis as unknown as { window?: Record<string, unknown> }).window || {}),
  addEventListener() {},
}
const store = await import('../stream-store')

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function createSidebarSendHarness(options: {
  projectRoot?: string
  workspace?: { id: string; name: string; roots: string[] }
  initialExpansion: Record<string, boolean>
  initialSectionsCollapsed?: Record<string, boolean>
  existingTitles?: string[]
}) {
  const root = options.projectRoot ?? '/repo/klaus'
  const workspace = options.workspace ?? null
  const snapshots: any[] = []
  const creation = deferred<any>()

  const existingSessions = (options.existingTitles ?? ['Earlier chat 1', 'Earlier chat 2', 'Earlier chat 3', 'Earlier chat 4']).map((title, index) => ({
    id: `existing-${index + 1}`,
    title,
    createdAt: 1000 - index,
    updatedAt: 1000 - index,
    workdir: workspace ? workspace.roots[0]! : root,
    ...(workspace ? { workspaceId: workspace.id } : {}),
  }))

  let draft = normalizeComposerDraft('Investigate collapsed project send')
  let welcome = normalizeComposerDraft('')

  const c: Record<string, any> = {
    crypto: { randomUUID },
    Date,
    console,
    CustomEvent: class { constructor(public type: string, public detail: any) {} },
    flushSync: (fn: () => void) => fn(),
    window: {
      currentSessionId: null as string | null,
      klaus: { browserUse: { setConversation: async () => {} } },
      dispatchEvent: () => c.draftPromotion.navigate(),
      KlausPanelTabs: { promoteDraftSession() {} },
    },
    klausApi: {
      session: {
        new: async () => creation.promise,
        delete: async () => {},
      },
    },
    draftPromotion: new DraftSessionPromotion(),
    goalInteractions: new GoalInteractionClock(),
    promoteInflight: null,
    creatingGoalSessions: createGoalSubmissionGate(),
    preparingSubmissions: createGoalSubmissionGate(),
    sessions: [...existingSessions],
    projectRoots: [root],
    projectLabels: { [root]: 'klaus' },
    projectWorkspaces: workspace ? [workspace] : [],
    sidebarProjectExpansion: { ...options.initialExpansion },
    sidebarSectionsCollapsed: parseSectionsCollapsed(options.initialSectionsCollapsed ?? null),
    projectExpansionRevision: 0,
    sectionsCollapsedRevision: 0,
    projectExpansionQueue: { commit() {} },
    sectionsCollapsedQueue: { commit() {} },
    expandedProjectThreadLists: new Set<string>(),
    projectThreadPages: new Map<string, number>(),
    closingProjectThreadLists: new Set<string>(),
    openingProjectThreadLists: new Set<string>(),
    sidebarProjectOrderPending: null,
    sidebarProjectOrder: [],
    sidebarSortMode: 'updated_at',
    sidebarSortMenuOpen: false,
    sidebarActivityOpen: false,
    currentNonChatView: false,
    activeProjectWorkdir: workspace ? null : root,
    pendingNewChatWorkdir: workspace ? workspace.roots[0]! : root,
    pendingNewChatProjectRoot: workspace ? null : root,
    pendingNewChatWorkspaceId: workspace ? workspace.id : null,
    welcomeWorkMode: null,
    draftOnlySessionIds: new Set<string>(),
    runningSessions: new Set<string>(),
    sidebarListedWorkingSessions: new Set<string>(),
    sidebarCompletedSessions: new Set<string>(),
    pendingPermissionsBySession: new Map(),
    pendingElicitsBySession: new Map(),
    pendingComposerSubmissions: new Map(),
    visiblePendingSubmissionId: null as string | null,
    sessionDrafts: new Map(),
    busy: false,
    btnSend: { disabled: false, classList: { add() {}, remove() {} } },
    welcomeEl: { style: { display: 'flex' } },
    messagesEl: { style: { display: 'none' } },
    composerContextRowEl: { hidden: false },
    sidebarApi: {
      render: (snapshot: any) => { snapshots.push(structuredClone(snapshot)) },
    },
    // Pure imports & helpers referenced by the production functions under test
    ...store,
    runContextRowVisible,
    transcriptChromeState,
    transcriptContentPresence,
    userMessageClientId,
    automationSourceLabel,
    isPinnedSession,
    isPlaceholderSessionTitle,
    partitionSidebarSessions,
    hasMoreProjectThreads,
    isProjectOpen,
    isSectionCollapsed,
    mergeCollapsedBadge,
    placeProvisionalProjectRow,
    projectThreadWindow,
    readProjectExpansion,
    reduceCollapsedBadge,
    revealDecision,
    withProjectExpansion,
    withSectionCollapsed,
    reconcileOrder,
    sortSectionRows,
    normalizeProjectWorkdir: (w: string | null | undefined) => (w ? String(w).replace(/\/+$/, '') : null),
    basenameOf: (p: string) => p.split('/').filter(Boolean).pop() || p,
    workspaceContainerKey: (id: string) => `ws:${id}`,
    workspaceIdFromKey: (key: string | null) => (key && key.startsWith('ws:') ? key.slice(3) : null),
    workspacePrimaryRoot: (id: string | null) => (workspace && id === workspace.id ? workspace.roots[0] || null : null),
    friendshipIdFromKey: () => null,
    friendGroupKey: (id: string) => `friend:${id}`,
    friendRowsForSidebar: () => [],
    friendConversationSessions: () => [],
    friendGroupAttentionCount: () => 0,
    friendGroupThreadTitle: (title: string) => title,
    isSidebarFriendSessionVisible: () => true,
    getFriendsFeatureEnabled: () => false,
    sharedFriendUnread: () => ({ countOf: () => 0, wantReplyOf: () => false }),
    pendingFriendTaskForSession: () => null,
    detectChannelPrefix: () => null,
    isSshProjectWorkdir: () => false,
    isWorktreeSessionWorkdir: () => false,
    sessionBranchIconHtml: () => '',
    projectStateKey: (key: string | null) => (key ? String(key).replace(/\/+$/, '') : null),
    sessionProjectKey: (s: any) => (s.workspaceId ? null : (s.projectRoot || s.workdir || null)),
    sessionWorkdir: (id: string) => c.sessions.find((s: any) => s.id === id)?.workdir || null,
    findKnownSession: (id: string | null) => c.sessions.find((s: any) => s.id === id),
    sidebarSessionWorking: ({ turnRunning, listedWorking }: { turnRunning: boolean; listedWorking: boolean }) => turnRunning || listedWorking,
    sidebarSessionWait: () => ({ count: 0, kind: 'approval', snooze: null }),
    firstInputRequestId: () => null,
    canEditProjectForCurrentConversation: () => !c.window.currentSessionId || c.draftOnlySessionIds.has(c.window.currentSessionId),
    currentEditableWorkspaceId: () => (!c.window.currentSessionId ? c.pendingNewChatWorkspaceId : null),
    composedInputDraft: () => draft,
    setDraft: (target: string, value: unknown) => { c.sessionDrafts.set(target, normalizeComposerDraft(value)) },
    setWelcomeDraft: (value: unknown) => { welcome = normalizeComposerDraft(value) },
    clearComposerAfterSubmit: () => { draft = normalizeComposerDraft('') },
    normalizeComposerReferences: (_text: string, refs: any[]) => refs || [],
    buildOutgoingPayload: (text: string) => ({
      text,
      finalText: text,
      displayText: text,
      media: [],
      liveAttachments: [],
      pastedCards: [],
      selectedTextAttachments: [],
      sentSlashCommand: null,
      composerReferences: [],
      createdAt: Date.now(),
    }),
    mainScrollController: {
      resetForConversation() {},
      prepareLatestTurnPlacement() {},
      movePendingLatestTurnPlacement() {},
    },
    mountReactTranscript() {},
    showTranscriptSurface: () => {
      c.welcomeEl.style.display = 'none'
      c.messagesEl.style.display = 'block'
    },
    seedPromotedComposerPreferences() {},
    saveRunModeForDraft() {},
    forgetRunModeForDraft() {},
    updateGoalIndicator() {},
    updateSpecBanner() {},
    syncTopModeButtons() {},
    updateScrollToBottomBtn() {},
    refreshWorkdirButton() {},
    renderFollowUpQueue() {},
    renderTaskPanel() {},
    refreshTasksForSession: async () => {},
    updateSendBtn() {},
    syncTitlebarSessionTitle() {},
    updateCronNavBadge() {},
    syncSidebarToolbar() {},
    renderSidebarActivityView() {},
    persistExpandedProjectThreadLists() {},
    tt: (key: string) => key,
  }

  const api = chatFunctionFixture<{
    renderSessionList(): void
    beginPendingComposerSubmission(draft: any, files: any[], slash: any, token: string, goalMode?: boolean): any
    ensureSession(pending?: any): Promise<string | null>
    setProjectThreadListOpen(workdir: string | null, open: boolean): void
  }>([
    'regularLocalSessions',
    'groupedLocalSessions',
    'projectlessConversationSessions',
    'selectedProjectWorkdir',
    'draftProjectWorkdir',
    'projectRowsFromSessions',
    'projectConversationSessions',
    'workspaceConversationSessions',
    'isProjectThreadListOpen',
    'setProjectThreadListOpen',
    'commitProjectExpansion',
    'isSidebarSectionCollapsed',
    'projectShowMoreState',
    'projectCollapsedBadge',
    'sectionCollapsedBadge',
    'sidebarSessionActivity',
    'sectionSessionIdsForBadge',
    'projectGroupSessionIds',
    'isSidebarSessionWorking',
    'isSidebarSessionCompleteUnread',
    'sessionMessagePresence',
    'sessionDisplayTitle',
    'sidebarSessionRowSpec',
    'projectThreadsWindow',
    'workspaceRowsForSidebar',
    'orderProjectRows',
    'sortSessionRows',
    'buildSidebarSnapshot',
    'renderSessionList',
    'syncComposerContextRowVisibility',
    'currentPendingComposerSubmission',
    'createPendingComposerSubmissionRecord',
    'beginPendingComposerSubmission',
    'promotePendingComposerSubmission',
    'ensureSession',
  ], c, '{ renderSessionList, beginPendingComposerSubmission, ensureSession, setProjectThreadListOpen }')

  // Mirror the global stream-store subscription that marks promoted sessions running.
  const unsubscribe = store.chatStreamStore.subscribe((state, previousState) => {
    for (const [sessionId, nextStream] of Object.entries(state.sessions)) {
      if (nextStream?.provisional || previousState.sessions[sessionId]?.provisional) continue
      const wasRunning = !!previousState.sessions[sessionId]?.running
      const nowRunning = !!nextStream?.running
      if (nowRunning !== wasRunning) {
        if (nowRunning) c.runningSessions.add(sessionId)
        else c.runningSessions.delete(sessionId)
      }
    }
  })

  return {
    api,
    state: c,
    snapshots,
    resolveSessionNew: (info: any) => creation.resolve(info),
    cleanup: () => unsubscribe(),
    draftText: () => welcome.text,
  }
}

describe('sending a new chat into a sidebar project group', () => {
  test('an explicitly collapsed project stays collapsed across send and session promotion without flashing a single-item list', async () => {
    const harness = createSidebarSendHarness({
      projectRoot: '/repo/klaus',
      initialExpansion: { '/repo/klaus': false },
    })
    try {
      // Stage 0: New-chat draft targeting the collapsed project.
      harness.api.renderSessionList()
      const draftSnap = harness.snapshots.at(-1)!
      const draftProject = draftSnap.projects.rows.find((row: any) => row.key === '/repo/klaus')
      expect(draftProject.expanded).toBe(false)
      expect(draftProject.threads).toBeNull()
      expect(draftProject.collapsedBadge).toBeNull()
      expect(draftProject.active).toBe(true)

      // Stage 1: User clicks Send (provisional submission created before session:new resolves).
      const pending = harness.api.beginPendingComposerSubmission(
        normalizeComposerDraft('Investigate collapsed project send'),
        [],
        null,
        '0:0',
        false,
      )
      const sendSnap = harness.snapshots.at(-1)!
      const sendProject = sendSnap.projects.rows.find((row: any) => row.key === '/repo/klaus')
      expect(sendProject.expanded).toBe(false)
      expect(sendProject.threads).toBeNull()
      expect(sendProject.collapsedBadge).toBe('loading')
      expect(sendProject.active).toBe(false)

      // Stage 2: session:new resolves and promotes the provisional submission to a real session.
      const promotion = harness.api.ensureSession(pending)
      harness.resolveSessionNew({
        id: 'created-session-1',
        title: 'New Chat',
        createdAt: 2000,
        updatedAt: 2000,
        workdir: '/repo/klaus',
      })
      const createdId = await promotion
      expect(createdId).toBe('created-session-1')

      const promotedSnap = harness.snapshots.at(-1)!
      const promotedProject = promotedSnap.projects.rows.find((row: any) => row.key === '/repo/klaus')
      expect(promotedProject.expanded).toBe(false)
      expect(promotedProject.threads).toBeNull()
      expect(promotedProject.collapsedBadge).toBe('loading')
      expect(promotedProject.active).toBe(false)

      // Stage 3: Unfolding the group manually shows the new chat (with drafted title) alongside all existing chats.
      harness.api.setProjectThreadListOpen('/repo/klaus', true)
      harness.api.renderSessionList()
      const unfoldedProject = harness.snapshots.at(-1)!.projects.rows.find((row: any) => row.key === '/repo/klaus')
      expect(unfoldedProject.expanded).toBe(true)
      expect(unfoldedProject.threads.rows.map((row: any) => row.id)).toEqual([
        'created-session-1',
        'existing-1',
        'existing-2',
        'existing-3',
        'existing-4',
      ])
      expect(unfoldedProject.threads.rows[0].title).toBe('Investigate collapsed project send')
    } finally {
      harness.cleanup()
    }
  })

  test('an explicitly collapsed workspace container stays collapsed with a loading badge across send and promotion', async () => {
    const harness = createSidebarSendHarness({
      workspace: { id: 'ws-1', name: 'Workspace One', roots: ['/repo/klaus', '/repo/extra'] },
      initialExpansion: { 'ws:ws-1': false },
    })
    try {
      const pending = harness.api.beginPendingComposerSubmission(
        normalizeComposerDraft('Workspace task'),
        [],
        null,
        '0:0',
        false,
      )
      const sendWorkspace = harness.snapshots.at(-1)!.projects.rows.find((row: any) => row.key === 'ws:ws-1')
      expect(sendWorkspace.expanded).toBe(false)
      expect(sendWorkspace.threads).toBeNull()
      expect(sendWorkspace.collapsedBadge).toBe('loading')

      const promotion = harness.api.ensureSession(pending)
      harness.resolveSessionNew({
        id: 'created-ws-session',
        title: 'New Chat',
        createdAt: 2000,
        updatedAt: 2000,
        workdir: '/repo/klaus',
        workspaceId: 'ws-1',
      })
      await promotion

      const promotedWorkspace = harness.snapshots.at(-1)!.projects.rows.find((row: any) => row.key === 'ws:ws-1')
      expect(promotedWorkspace.expanded).toBe(false)
      expect(promotedWorkspace.threads).toBeNull()
      expect(promotedWorkspace.collapsedBadge).toBe('loading')
    } finally {
      harness.cleanup()
    }
  })

  test('an open project at the 5-row preview limit keeps 5 rows and its drafted title across promotion', async () => {
    const harness = createSidebarSendHarness({
      projectRoot: '/repo/klaus',
      initialExpansion: { '/repo/klaus': true },
      existingTitles: ['Chat 1', 'Chat 2', 'Chat 3', 'Chat 4', 'Chat 5'],
    })
    try {
      const pending = harness.api.beginPendingComposerSubmission(
        normalizeComposerDraft('Keep preview window steady'),
        [],
        null,
        '0:0',
        false,
      )
      const sendProject = harness.snapshots.at(-1)!.projects.rows.find((row: any) => row.key === '/repo/klaus')
      expect(sendProject.expanded).toBe(true)
      expect(sendProject.threads.rows).toHaveLength(5)
      expect(sendProject.threads.rows[0].title).toBe('Keep preview window steady')
      expect(sendProject.threads.more).toBe(true)

      const promotion = harness.api.ensureSession(pending)
      harness.resolveSessionNew({
        id: 'created-open-session',
        title: 'New Chat',
        createdAt: 2000,
        updatedAt: 2000,
        workdir: '/repo/klaus',
      })
      await promotion

      const promotedProject = harness.snapshots.at(-1)!.projects.rows.find((row: any) => row.key === '/repo/klaus')
      expect(promotedProject.expanded).toBe(true)
      expect(promotedProject.threads.rows).toHaveLength(5)
      expect(promotedProject.threads.rows[0].id).toBe('created-open-session')
      expect(promotedProject.threads.rows[0].title).toBe('Keep preview window steady')
      expect(promotedProject.threads.more).toBe(true)
    } finally {
      harness.cleanup()
    }
  })
})
