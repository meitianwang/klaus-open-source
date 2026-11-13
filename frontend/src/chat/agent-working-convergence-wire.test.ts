// Wire-level regression for the sidebar working sources. A settled
// conversation must never read as a running turn while a long-lived sub-agent
// is still finishing, so the row follows the main turn and the host live-turn
// registry alone; sub-agent activity is Monitor-only. The runtime audit stays
// the convergence loop for the two sources that can light a row.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chatFunctionFixture } from './test-support/chat-function-fixture'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')

function sliceBetween(from: string, to: string): string {
  const start = CHAT_TS.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  const end = CHAT_TS.indexOf(to, start)
  expect(end).toBeGreaterThan(start)
  return CHAT_TS.slice(start, end)
}

describe('sidebar working sources wire', () => {
  test('no sub-agent working set remains in the renderer', () => {
    expect(CHAT_TS).not.toContain('sidebarAgentWorkingSessions')
    expect(CHAT_TS).not.toContain('hasActiveAgentTasks')
  })

  test('the row predicate reads only the turn and the host registry', () => {
    const body = sliceBetween('function isSidebarSessionWorking', 'function isSessionOpenInChatView')
    expect(body).toContain('turnRunning: runningSessions.has(sessionId)')
    expect(body).toContain('listedWorking: sidebarListedWorkingSessions.has(sessionId)')
    expect(body).not.toContain('agentWorking')
  })

  test('the runtime audit gate and convergence branch ignore sub-agent activity', () => {
    const gate = sliceBetween('function scheduleSessionRuntimeAudit', 'async function auditSessionRuntimeState')
    expect(gate).not.toContain('agentWorking')
    expect(gate).not.toContain('agentStuck')
    const converge = sliceBetween('function syncSidebarWorkingFromSessions', 'function scheduleSessionRuntimeAudit')
    expect(converge).not.toContain('agentStuck')
    expect(converge).not.toContain('reconcileAgentTasksFromEngine(s.id)')
  })

  test('working source changes repaint only real status transitions without starting a polling audit', () => {
    const working = new Set<string>()
    let renders = 0, audits = 0
    const api = chatFunctionFixture<{ updateSidebarWorkingSource(set: Set<string>, id: string, value: boolean, options?: { render: boolean }): void }>(['updateSidebarWorkingSource'], {
      sidebarSessionStatusKind: (id: string) => working.has(id) ? 'active' : 'idle',
      renderSessionList: () => { renders++ }, scheduleSessionRuntimeAudit: () => { audits++ },
    })
    api.updateSidebarWorkingSource(working, 'owned', true)
    expect(working.has('owned')).toBe(true)
    expect(renders).toBe(1)
    api.updateSidebarWorkingSource(working, 'owned', true)
    expect(renders).toBe(1)
    api.updateSidebarWorkingSource(working, 'owned', false)
    expect(working.has('owned')).toBe(false)
    expect(renders).toBe(2)
    api.updateSidebarWorkingSource(working, 'owned', true, { render: false })
    expect(working.has('owned')).toBe(true)
    expect(renders).toBe(2)
    expect(audits).toBe(0)
  })

  test('a failed child pull retries independently without changing parent work', () => {
    const body = sliceBetween('async function reconcileAgentTasksFromEngine', 'const backgroundAgentPoller')
    expect(body).toContain('backgroundAgentPoller.retry(sessionId, known.working)')
    expect(body).not.toContain('updateSidebarWorkingSource')
  })
})
