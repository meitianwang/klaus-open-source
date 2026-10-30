import { expect, test, beforeEach } from 'bun:test'
import { windowStateKey } from '../../app/window-state'
import { clearUnsentSubmission, listUnsentSessionIds, recordUnsentSubmission, unsentSubmissionFor } from './unsent-submissions'

// The renderer module persists through the browser storage API; the test
// runtime supplies a map-backed stand-in so the round-trip is still exercised.
const storage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
}

const KEY = windowStateKey('klaus_unsent_submissions')

function record(sessionId: string, uuid = `uuid-${sessionId}`) {
  return {
    sessionId,
    uuid,
    draft: { text: 'Authored message', references: [], document: null },
    files: [],
    payload: {
      finalText: 'Authored message', displayText: 'Authored message', media: [], liveAttachments: [],
      pastedCards: [], selectedTextAttachments: [], sentSlashCommand: null, composerReferences: [], createdAt: 1,
    },
    error: 'The request was refused',
    atMs: 1,
  }
}

beforeEach(() => {
  storage.clear()
})

test('an unsent submission persists per session and survives rereads', () => {
  recordUnsentSubmission(record('chat-a') as any)
  expect(unsentSubmissionFor('chat-a')?.uuid).toBe('uuid-chat-a')
  expect(unsentSubmissionFor('chat-a')?.payload.finalText).toBe('Authored message')
  expect(unsentSubmissionFor('chat-b')).toBeNull()
  expect(listUnsentSessionIds()).toEqual(['chat-a'])
})

test('a newer record replaces the outstanding one for the same session', () => {
  recordUnsentSubmission(record('chat-a', 'first') as any)
  recordUnsentSubmission(record('chat-a', 'second') as any)
  expect(unsentSubmissionFor('chat-a')?.uuid).toBe('second')
  expect(listUnsentSessionIds()).toHaveLength(1)
})

test('clearing removes only the addressed session and is idempotent', () => {
  recordUnsentSubmission(record('chat-a') as any)
  recordUnsentSubmission(record('chat-b') as any)
  clearUnsentSubmission('chat-a')
  clearUnsentSubmission('chat-a')
  expect(unsentSubmissionFor('chat-a')).toBeNull()
  expect(unsentSubmissionFor('chat-b')?.uuid).toBe('uuid-chat-b')
  expect(listUnsentSessionIds()).toEqual(['chat-b'])
})

test('a corrupted store degrades to an empty retry state instead of throwing', () => {
  localStorage.setItem(KEY, '{not json')
  expect(unsentSubmissionFor('chat-a')).toBeNull()
  expect(listUnsentSessionIds()).toEqual([])
  recordUnsentSubmission(record('chat-a') as any)
  expect(unsentSubmissionFor('chat-a')?.uuid).toBe('uuid-chat-a')
})
