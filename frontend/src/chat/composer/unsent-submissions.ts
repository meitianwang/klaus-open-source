import type { ComposerDraft } from './slash-draft'
import type { OutgoingPayload, PendingFileEntry } from '../engine-events'
import { windowStateKey } from '../../app/window-state'

/**
 * A submit that was cancelled or failed after its conversation entity existed
 * keeps its payload here so the conversation can offer a retry, including
 * after a reload. Keyed by session: one outstanding unsent submit per chat.
 */
export interface UnsentSubmissionRecord {
  sessionId: string
  uuid: string
  draft: ComposerDraft
  files: PendingFileEntry[]
  payload: OutgoingPayload
  error?: string
  atMs: number
}

const UNSENT_SUBMISSIONS_KEY = windowStateKey('klaus_unsent_submissions')

function readAll(): Record<string, UnsentSubmissionRecord> {
  try {
    const parsed = JSON.parse(localStorage.getItem(UNSENT_SUBMISSIONS_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, UnsentSubmissionRecord> : {}
  } catch {
    return {}
  }
}

function writeAll(records: Record<string, UnsentSubmissionRecord>) {
  try {
    localStorage.setItem(UNSENT_SUBMISSIONS_KEY, JSON.stringify(records))
  } catch {
    // Storage unavailable: the retry state lives only until the next reload.
  }
}

export function recordUnsentSubmission(record: UnsentSubmissionRecord): void {
  const records = readAll()
  records[record.sessionId] = record
  writeAll(records)
}

export function unsentSubmissionFor(sessionId: string): UnsentSubmissionRecord | null {
  return readAll()[sessionId] ?? null
}

export function clearUnsentSubmission(sessionId: string): void {
  const records = readAll()
  if (!records[sessionId]) return
  delete records[sessionId]
  writeAll(records)
}

export function listUnsentSessionIds(): string[] {
  return Object.keys(readAll())
}
