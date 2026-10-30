import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')

function functionBody(startMarker: string, endMarker: string) {
  const start = CHAT_TS.indexOf(startMarker)
  const end = CHAT_TS.indexOf(endMarker, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return CHAT_TS.slice(start, end)
}

describe('draft promotion keeps the session list id-unique', () => {
  // The host lists a new thread as soon as session:new persists it, so a
  // refresh (the 15s runtime audit while any session runs, or any event-driven
  // updateSessionInList) can file the id before ensureSession's await settles.
  // Inserting it again produced duplicate React keys: two rows for one session,
  // both rendering `active`, both frozen at their insert-time titles.
  test('ensureSession replaces an existing row instead of inserting a duplicate', () => {
    const ensureSession = functionBody('async function ensureSession(', '\nfunction forgetSessionLocalState(')
    expect(ensureSession).toContain('sessions.filter((candidate) => candidate.id !== info.id)')
    expect(ensureSession).not.toContain('sessions.unshift(info)')
  })
})
