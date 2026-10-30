import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')

describe('session running synchronization wire', () => {
  test('stream state drives every sidebar row and reconciles the task source', () => {
    const start = CHAT_TS.indexOf('chatStreamStore.subscribe((state, previousState) => {')
    const end = CHAT_TS.indexOf('\n  const offered = composerContinueMode()', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = CHAT_TS.slice(start, end)

    expect(body).toContain('sessionRunningChanges(previousState.sessions, state.sessions)')
    expect(body).toContain('setSessionRunning(change.sessionId, change.running)')
    expect(body).toContain('reconcileAgentTasksFromEngine(change.sessionId)')
    expect(body).not.toContain('window.currentSessionId')
    expect(body).not.toContain('syncMainTranscriptChrome()')
  })
})
