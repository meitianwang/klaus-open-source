import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')

describe('workspace and standalone project separation', () => {
  test('workspace folder picks never register projects', () => {
    const addHandler = CHAT_TS.slice(
      CHAT_TS.indexOf("modal.querySelector('#ws-add-folder')"),
      CHAT_TS.indexOf("modal.querySelector('#ws-submit')"),
    )
    expect(addHandler).toContain('await pickProjectWorkdirs()')
    expect(addHandler).not.toContain('pickAndRegisterProjectWorkdir')
    expect(addHandler).not.toContain('projects?.add')
  })

  test('workspace sessions never synthesize standalone sidebar projects', () => {
    const projectRows = CHAT_TS.slice(
      CHAT_TS.indexOf('function projectRowsFromSessions()'),
      CHAT_TS.indexOf('function regularLocalSessions()'),
    )
    expect(projectRows).toContain('pushProject(sessionProjectKey(session), session)')
    expect(projectRows).not.toContain('pushProject(activeProjectWorkdir)')
  })

  test('workspace navigation clears rather than activates a bare project', () => {
    expect(CHAT_TS).not.toContain('setActiveProjectWorkdir(workspaceId ? primary : null')
    expect(CHAT_TS).not.toContain('setActiveProjectWorkdir(primary, { render: false')
    expect(CHAT_TS).toContain('setActiveProjectWorkdir(targetSession?.workspaceId ? null')
    expect(CHAT_TS).toContain('pendingNewChatWorkdir = workspaceId ? primary : null')
    expect(CHAT_TS).toContain('if (pendingNewChatWorkspaceId) {\n    setActiveProjectWorkdir(null')
  })

  test('friend task conversations never activate their scratch home as a project', () => {
    expect(CHAT_TS).toContain('if (!targetSession?.friendGroupId) {\n      setActiveProjectWorkdir(targetSession?.workspaceId ? null')
  })

  test('new chat drafted from a friend conversation does not inherit its scratch home', () => {
    expect(CHAT_TS).toContain('if (session?.friendGroupId) return { workdir: null }')
  })
})
