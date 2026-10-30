import type { PendingFileEntry } from '../engine-events'

/** Keep this field order stable so durable submission receipts survive client updates. */
export function goalAttachmentIntent(files: readonly PendingFileEntry[]) {
  return files.map(file => ({ path: file.uploadPath, type: file.file.type, name: file.file.name, size: file.file.size, kind: file.kind, text: file.text, source: file.sourcePath }))
}
export function serializeGoalSubmissionIntent(draft: unknown, files: readonly PendingFileEntry[]): string {
  return JSON.stringify({ draft, files: goalAttachmentIntent(files) })
}

export interface GoalSubmissionTarget { expectedGoalId: string | null; expectedGoalRevision: number }
export interface GoalSubmissionReceipt extends GoalSubmissionTarget { id: string }
interface Receipt extends GoalSubmissionReceipt { fingerprint: string }

function hasErrorCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; data?: { code?: unknown; error?: { code?: unknown } } }
  return value.code === code || value.data?.code === code || value.data?.error?.code === code
}
export function isGoalConflict(error: unknown): boolean { return hasErrorCode(error, 'GOAL_CONFLICT') }
export function isGoalIntentConflict(error: unknown): boolean { return hasErrorCode(error, 'GOAL_INTENT_CONFLICT') }

/** Keep only receipt identities and hashes; draft content stays with its composer. */
export class GoalSubmissionReceipts {
  private readonly entries = new Map<string, Receipt>()
  constructor(private readonly save: (value: string) => void, serialized: string | null = null) {
    if (!serialized) return
    try {
      const entries: unknown = JSON.parse(serialized)
      if (!Array.isArray(entries)) return
      for (const entry of entries.slice(-100)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1]?.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry[1]?.fingerprint)
          || entry[1]?.expectedGoalId !== null && typeof entry[1]?.expectedGoalId !== 'string'
          || !Number.isSafeInteger(entry[1]?.expectedGoalRevision) || entry[1].expectedGoalRevision < 0) continue
        this.entries.set(entry[0], { fingerprint: entry[1].fingerprint, id: entry[1].id, expectedGoalId: entry[1].expectedGoalId, expectedGoalRevision: entry[1].expectedGoalRevision })
      }
    } catch { /* An invalid receipt cache does not replace an authoritative goal. */ }
  }
  async forIntent(sessionId: string, serializedIntent: string, target: GoalSubmissionTarget): Promise<GoalSubmissionReceipt> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializedIntent))
    const fingerprint = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')
    const existing = this.entries.get(sessionId)
    if (existing?.fingerprint === fingerprint) return existing
    const id = crypto.randomUUID()
    this.entries.delete(sessionId)
    const receipt = { fingerprint, id, ...target }
    this.entries.set(sessionId, receipt)
    while (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!)
    this.persist()
    return receipt
  }
  rejectConflict(sessionId: string, receiptId: string, error: unknown): boolean {
    if (!(isGoalConflict(error) || isGoalIntentConflict(error)) || this.entries.get(sessionId)?.id !== receiptId) return false
    this.forget(sessionId)
    return true
  }
  forget(sessionId: string): void { if (this.entries.delete(sessionId)) this.persist() }
  private persist(): void { this.save(JSON.stringify([...this.entries])) }
}
