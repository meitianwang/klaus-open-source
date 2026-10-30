import type { ComposerDraft } from './slash-draft'
import type { OutgoingPayload, PendingFileEntry } from '../engine-events'

/** The submitted snapshot owns its presentation independently of the next draft. */
export interface PendingComposerSubmission {
  id: string
  uuid: string
  sourceSessionId: string | null
  sessionId: string | null
  viewId: string
  navigationToken: string
  draft: ComposerDraft
  files: PendingFileEntry[]
  payload: OutgoingPayload
  startedAtMs: number
  workdir: string | null
  workspaceId: string | null
  projectRoot: string | null
  phase: 'preparing' | 'submitting' | 'accepted' | 'failed' | 'unconfirmed' | 'cancelled'
  cancelled: boolean
  error?: string
}

/** Goal echoes use a receipt-derived identity, including replies preceding the ACK. */
export async function goalSubmissionUserUuid(receiptId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(receiptId))
  return `goal-user-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** An empty composer can recover a failed snapshot without replacing newer input. */
export function canRestorePendingDraft(draft: ComposerDraft, files: readonly PendingFileEntry[]): boolean {
  return !draft.text.trim() && files.length === 0
}

interface PendingSubmissionRecovery { action: 'back' | 'dismiss' | 'retry'; run(): void }
const recovery = new Map<string, PendingSubmissionRecovery>()
export function setPendingSubmissionRecovery(uuid: string, value: PendingSubmissionRecovery): void { recovery.set(uuid, value) }
export function clearPendingSubmissionRecovery(uuid: string): void { recovery.delete(uuid) }
export function pendingSubmissionRecovery(uuid: string): PendingSubmissionRecovery | undefined { return recovery.get(uuid) }
