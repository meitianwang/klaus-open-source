import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const CHAT = read('./chat.ts')
const MONITOR = read('./background-process-monitor.ts')
const OVERVIEW = read('./overview/background-processes.ts')
const TABS = read('./panels/panel-tabs.tsx')
const INDEX = read('../../index.html')

describe('background process desktop wiring', () => {
  test('a persistent process stays in Monitor without keeping the conversation spinner running', () => {
    const workingFn = CHAT.slice(CHAT.indexOf('function isSidebarSessionWorking'), CHAT.indexOf('function isSessionOpenInChatView'))
    expect(workingFn).not.toContain('sidebarProcessWorkingSessions')
    expect(MONITOR).not.toContain('updateSidebarWorking')
    expect(CHAT).not.toContain('setSessionRunning(sessionId, processes')
    expect(CHAT).not.toContain('sessions.map(session => backgroundProcessMonitor.refreshSession(session.id))')
    expect(MONITOR).not.toContain('runningSessions')
    expect(MONITOR).not.toContain('syncBusyForCurrentSession')
  })

  test('merges pushed events before active-session render filtering and audits only active lifecycle', () => {
    const handler = MONITOR.slice(MONITOR.indexOf('function applyChanged'), MONITOR.indexOf('async function activate'))
    expect(handler.indexOf('processesBySession.set(sessionId, next)')).toBeLessThan(handler.indexOf('renderCurrent(sessionId)'))
    expect(MONITOR).toContain('backgroundProcessChanged')
    expect(MONITOR).not.toContain('setInterval')
    expect(MONITOR).toContain('createBackgroundLifecyclePoller')
    expect(MONITOR).toContain('lifecyclePoller.update(sessionId, working)')
  })

  test('uses a standing peer section and owned nonpersistent workspace tab', () => {
    const sectionTag = INDEX.match(/<div\b[^>]*\bid="monitor-section-background-processes"[^>]*>/)?.[0]
    expect(sectionTag).toBeDefined()
    expect(sectionTag).not.toMatch(/\bhidden\b/)
    expect(INDEX).toContain('data-i18n="overview_background_processes_empty"')
    expect(INDEX.indexOf('monitor-section-background-processes')).toBeGreaterThan(INDEX.indexOf('monitor-section-subagents'))
    expect(INDEX.indexOf('monitor-section-background-processes')).toBeLessThan(INDEX.indexOf('monitor-section-artifacts'))
    expect(OVERVIEW).toContain('orderBackgroundProcesses')
    expect(TABS).toContain("'background-process': { fixed: false, mode: 'background-process', labelKey: 'overview_background_processes_title', persist: false, owned: true }")
    expect(TABS).toContain('async function openBackgroundProcess(shellId: string')
  })

  test('detail stop stays optimistic until terminal event and output reads carry the independent cursor', () => {
    expect(MONITOR).toContain('backgroundProcessOutput(sessionId, shellId, { afterOffset, maxBytes: 256 * 1024 })')
    expect(MONITOR).toContain('controller.terminal()')
    expect(MONITOR).toContain('stopButton.disabled = terminal || workspace.stopping')
    expect(MONITOR).toContain('background_process_stopping')
  })

  test('keeps background processes in Monitor and out of the Quest transcript', () => {
    expect(MONITOR).not.toContain('results: (sessionId: string)')
    expect(MONITOR).not.toContain('announceBackgroundProcessChange()')
    const transcript = read('./transcript/TranscriptView.tsx')
    expect(transcript).not.toContain('subscribeBackgroundProcesses')
    expect(transcript).not.toContain("msg.kind === 'background-process-result'")
    expect(transcript).not.toContain('BackgroundProcessResultCard')
    expect(transcript).toContain('data-background-process-shell-id')
    expect(OVERVIEW).toContain('renderBackgroundProcessSection')
  })

  test('the thread row menu carries no stop entry; stopping lives in the composer and the process panel', () => {
    expect(CHAT).not.toContain('stopSessionFromMenu')
    expect(CHAT).not.toContain("['stop', tt('session_menu_stop')]")
    const menuItems = CHAT.slice(CHAT.indexOf('const items = session.archived'), CHAT.indexOf('menu.innerHTML = items.map'))
    expect(menuItems).not.toContain("'stop'")
  })
})
