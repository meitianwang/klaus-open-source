import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')
const SESSION_LIST_TS = readFileSync(fileURLToPath(new URL('./sidebar/session-list.tsx', import.meta.url)), 'utf8')
const WORKSPACE_PANEL_TS = readFileSync(fileURLToPath(new URL('./workspace-panel.ts', import.meta.url)), 'utf8')

function functionBody(startMarker: string, endMarker: string) {
  const start = CHAT_TS.indexOf(startMarker)
  const end = CHAT_TS.indexOf(endMarker, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return CHAT_TS.slice(start, end)
}

describe('draft-only new session layout', () => {
  test('attachment promotion does not count as the first sent turn', () => {
    const ensureSession = functionBody('async function ensureSession(', '\nfunction forgetSessionLocalState(')
    expect(ensureSession).toContain('draftOnlySessionIds.add(info.id)')

    const chromeState = functionBody('function mainTranscriptChromeState(', '\n// 主转录是否已有内容')
    expect(chromeState).toContain('draftOnly: isDraftOnlySession(id)')
  })

  test('promotion selects the browser task before announcing the new session', () => {
    const ensureSession = functionBody('async function ensureSession(', '\nfunction forgetSessionLocalState(')
    const selected = ensureSession.indexOf('window.currentSessionId = info.id')
    const browser = ensureSession.indexOf('await window.klaus?.browserUse?.setConversation?.(info.id)')
    const staleGuard = ensureSession.indexOf('if (!isCurrent() || window.currentSessionId !== info.id)')
    const announced = ensureSession.indexOf("window.dispatchEvent(new CustomEvent('klaus:session-change'")

    expect(selected).toBeGreaterThan(-1)
    expect(browser).toBeGreaterThan(selected)
    expect(staleGuard).toBeGreaterThan(browser)
    expect(announced).toBeGreaterThan(staleGuard)
  })

  test('run context stays editable until the promoted session starts a turn', () => {
    const canEdit = functionBody('function canEditProjectForCurrentConversation()', '\nfunction newChatTargetFromCurrentSelection(')
    expect(canEdit).toContain('if (isDraftOnlySession(window.currentSessionId)) return true')

    const refreshWorkdir = functionBody('async function refreshWorkdirButton()', '\nif (btnWorkdir && workdirClearEl)')
    expect(refreshWorkdir).toContain('const hasMessages = !!reportedHasMessages && !isDraftOnlySession(id)')
  })

  test('the first real turn releases both welcome-layout guards', () => {
    const submit = functionBody('async function submitTurnPayload(', '\nfunction clientQueueFor(')
    expect(submit).toContain('draftOnlySessionIds.delete(targetSessionId)')
    expect(submit.indexOf('draftOnlySessionIds.delete(targetSessionId)'))
      .toBeLessThan(submit.indexOf('renderLocalUserPayload(targetSessionId, payload)'))

    const eventHandler = functionBody('function handleChatEvent(event: ChatEvent) {', '\nklausApi.on.permissionRequest(')
    // The run-activity guard releases the draft-only lifecycle and the draft's
    // run-mode record together, in one block.
    const guardStart = eventHandler.indexOf('if (event.sessionId && isRunActivityEvent(event)) {')
    expect(guardStart).toBeGreaterThan(-1)
    const guardBody = eventHandler.slice(guardStart, eventHandler.indexOf('\n  }', guardStart))
    expect(guardBody).toContain('draftOnlySessionIds.delete(event.sessionId)')
    expect(guardBody).toContain('forgetRunModeForDraft(event.sessionId)')
  })

  test('both navigation paths recycle a proven-empty persisted placeholder', () => {
    const switchSession = functionBody('async function switchSession(id: string)', '\n// 进入"虚拟新对话"状态')
    expect(switchSession).toContain('discardEmptySessionOnLeave(window.currentSessionId, leavingHadContent)')

    const enterNewChat = functionBody('function enterNewChatState(', '\nfunction newChat(')
    expect(enterNewChat).toContain('discardEmptySessionOnLeave(window.currentSessionId, leavingHadContent)')

    const discard = functionBody('function discardEmptySessionOnLeave(', '\n// 把"虚拟新对话"提升为后端 session entity')
    expect(discard).toContain('shouldDiscardEmptySessionOnLeave(session, {')
    expect(discard).toContain('klausApi.session.history(sessionId)')
    expect(discard).toContain('discardSessionWithKnownHistory(sessionId, confirmedHistory')
    expect(discard).toContain('draftOnly: isDraftOnlySession(sessionId)')
  })

  test('shows an existing session loading surface before waiting on browser IPC', () => {
    const switchSession = functionBody('async function switchSession(id: string)', '\n// 进入"虚拟新对话"状态')
    const selected = switchSession.indexOf('window.currentSessionId = id')
    const history = switchSession.indexOf('void loadSessionHistory(id)')
    const mounted = switchSession.indexOf("mountReactTranscript(id, messagesEl, { scroll: 'main' })")
    const chrome = switchSession.indexOf('syncMainTranscriptChrome()')
    const browser = switchSession.indexOf('await window.klaus?.browserUse?.setConversation?.(id)')
    const panelLayout = switchSession.indexOf('prepareArtifactsPanelLayoutForSessionSwitch(id)')

    expect(selected).toBeGreaterThan(-1)
    expect(history).toBeGreaterThan(selected)
    expect(panelLayout).toBeGreaterThan(selected)
    expect(mounted).toBeGreaterThan(panelLayout)
    expect(mounted).toBeGreaterThan(history)
    expect(chrome).toBeGreaterThan(mounted)
    expect(browser).toBeGreaterThan(chrome)
  })

  test('keeps one welcome draft outside the sidebar and session history', () => {
    const setWelcomeDraft = functionBody('function setWelcomeDraft(', '\n// composer 内容的统一持久化入口')
    expect(setWelcomeDraft).not.toContain('renderSessionList()')

    const snapshot = functionBody('function buildSidebarSnapshot()', '\n\nconst sidebarApi')
    expect(snapshot).not.toContain('welcomeDraft')
    expect(SESSION_LIST_TS).not.toContain('WelcomeDraftRow')
    expect(SESSION_LIST_TS).not.toContain('welcomeDraft:')
  })

  test('chooses project context from the next new-chat entry', () => {
    const switchSession = functionBody('async function switchSession(id: string)', '\n// 进入"虚拟新对话"状态')
    expect(switchSession).toContain('pendingNewChatWorkdir = null')
    expect(switchSession).toContain('pendingNewChatWorkspaceId = null')

    const target = functionBody('function newChatTargetFromCurrentSelection()', '\n\nfunction projectlessConversationSessions')
    expect(target).toContain('workdir: sessionWorkdir(window.currentSessionId)')
    expect(target).toContain('workspaceId: session.workspaceId')
    expect(target).toContain('workdir: draftProjectWorkdir()')
    expect(target).toContain('workspaceId: pendingNewChatWorkspaceId')

    expect(target).toContain('if (currentNonChatView) return { workdir: null }')
    expect(CHAT_TS).toContain('newChat(target)')
  })

  test('restores a welcome run mode only when its draft target still matches', () => {
    const enterNewChat = functionBody('function enterNewChatState(', '\nfunction newChat(')
    expect(enterNewChat).toContain('const targetWasExplicit =')
    expect(enterNewChat).toContain('shouldRestoreWelcomeRunMode(welcomeRunMode, {')
    expect(enterNewChat).toContain('workdir: normalizeProjectWorkdir(pendingNewChatWorkdir)')
    expect(enterNewChat).toContain('workspaceId: pendingNewChatWorkspaceId || null')

    const saveRunMode = functionBody('function saveRunModeForDraft(', '\nfunction forgetRunModeForDraft(')
    expect(saveRunMode).toContain('saved.workdir = normalizeProjectWorkdir(pendingNewChatWorkdir)')
    expect(saveRunMode).toContain('saved.workspaceId = pendingNewChatWorkspaceId || null')
  })

  test('does not let sidebar expansion rewrite the pending new-chat target', () => {
    const toggleProject = functionBody('function toggleProjectSidebarItem(', '\n\nfunction projectSidebarCloseFinished')
    expect(toggleProject).not.toContain('pendingNewChatWorkdir =')
  })

  test('a background session user bubble never flips the main column surface', () => {
    // A queued dispatch or steer for an off-screen session paints its bubble
    // through the same helper the on-screen first send uses. Flipping the main
    // column there would hide the welcome screen of the new chat the user is
    // looking at and dock the composer back to the bottom.
    const render = functionBody('function renderLocalUserPayload(', '\n  // A slash command the user attached')
    expect(render).toContain('} else if (targetSessionId === window.currentSessionId) {')
    expect(render.indexOf('} else if (targetSessionId === window.currentSessionId) {'))
      .toBeLessThan(render.indexOf('showTranscriptSurface()'))
  })

  test('background workspace refresh never mints a draft session', () => {
    // Entering the new-chat state (including after deleting the current
    // session) refreshes the files panel with a null id; that path must show
    // the empty tree instead of promoting the draft into a real session that
    // then appears in the sidebar.
    const loadWorkspace = WORKSPACE_PANEL_TS.slice(
      WORKSPACE_PANEL_TS.indexOf('export async function loadWorkspace('),
      WORKSPACE_PANEL_TS.indexOf('export const loadArtifacts = loadWorkspace'),
    )
    expect(loadWorkspace).toContain('if (!targetSessionId && options.promoteDraft) targetSessionId = (await ensureWorkspaceSessionForCurrentDraft()) || null')

    const enterNewChat = functionBody('function enterNewChatState(', '\nfunction newChat(')
    expect(enterNewChat).toContain('loadArtifacts(null)')

    // Surfaces the user opens on purpose keep the promotion.
    expect(WORKSPACE_PANEL_TS).toContain("loadWorkspace(currentSessionId(), { promoteDraft: true })")
    expect(CHAT_TS).toContain('loadWorkspace(window.currentSessionId, { promoteDraft: true })')
  })

  test('entering new-chat state snapshots outgoing panel state and clears instance tabs before resetting views', () => {
    const enterNewChat = functionBody('function enterNewChatState(', '\nfunction newChat(')
    const saveArtifacts = enterNewChat.indexOf('saveArtifactsStateFor(window.currentSessionId)')
    const switchTabs = enterNewChat.indexOf('window.KlausPanelTabs?.beginSessionSwitch?.(')
    const hideDiff = enterNewChat.indexOf('window.hideDiffView()')
    const hideWorkspace = enterNewChat.indexOf('window.hideWorkspaceMainView()')
    const restorePanel = enterNewChat.indexOf('restoreArtifactsPanelForChatView()')

    expect(saveArtifacts).toBeGreaterThan(-1)
    expect(switchTabs).toBeGreaterThan(saveArtifacts)
    expect(hideDiff).toBeGreaterThan(switchTabs)
    expect(hideWorkspace).toBeGreaterThan(switchTabs)
    expect(restorePanel).toBeGreaterThan(switchTabs)
  })
})
