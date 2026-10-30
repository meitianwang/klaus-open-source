import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')

describe('worktree sessions keep origin project membership', () => {
  test('sidebar rows group sessions by membership, not by run directory', () => {
    const projectRows = CHAT_TS.slice(
      CHAT_TS.indexOf('function projectRowsFromSessions()'),
      CHAT_TS.indexOf('function regularLocalSessions()'),
    )
    expect(projectRows).toContain('pushProject(sessionProjectKey(session), session)')
    expect(projectRows).not.toContain('pushProject(session.workdir, session)')
    const conversationRows = CHAT_TS.slice(
      CHAT_TS.indexOf('function projectConversationSessions('),
      CHAT_TS.indexOf('function persistExpandedProjectThreadLists()'),
    )
    expect(conversationRows).toContain('sessionProjectKey(session) === selected')
  })

  test('worktree creation locks membership to the origin repository', () => {
    const create = CHAT_TS.slice(
      CHAT_TS.indexOf('async function ensureRunModeWorkspaceForSend('),
      CHAT_TS.indexOf('let branchPickerEl'),
    )
    expect(create).toContain('pendingNewChatProjectRoot = res.repoRoot || base')
    expect(create).toContain('projectRoot: res.repoRoot || base')
    const promote = CHAT_TS.slice(
      CHAT_TS.indexOf('async function ensureSession('),
      CHAT_TS.indexOf('function forgetSessionLocalState('),
    )
    expect(promote).toContain('...(inheritedProjectRoot ? { projectRoot: inheritedProjectRoot } : {})')
  })

  test('activating a project never persists a managed worktree path', () => {
    const setActive = CHAT_TS.slice(
      CHAT_TS.indexOf('function setActiveProjectWorkdir('),
      CHAT_TS.indexOf('async function refreshProjectWorkspaces('),
    )
    expect(setActive).toContain('projectIdentityForWorkdir(normalizeProjectWorkdir(workdir))')
    const boot = CHAT_TS.slice(
      CHAT_TS.indexOf('let activeProjectWorkdir = (() => {'),
      CHAT_TS.indexOf('let pendingNewChatWorkdir'),
    )
    expect(boot).toContain('if (value && isWorktreeSessionWorkdir(value)) return null')
  })
})
