import type { InferenceSnapshot, ModelUpdateState } from '../../bridge/types'

const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const nonempty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

export function inferenceSnapshot(value: unknown): InferenceSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const model = nonempty(row.model)
  if (!isRevision(row.revision) || !model) return null
  const snapshot: InferenceSnapshot = { revision: row.revision, model }
  for (const key of ['changeId', 'source', 'tier', 'selection'] as const) {
    const text = nonempty(row[key])
    if (text) snapshot[key] = text
  }
  return snapshot
}

export function nextModelUpdate(previous: ModelUpdateState | null, value: unknown): ModelUpdateState | null {
  if (!value || typeof value !== 'object') return previous
  const row = value as Record<string, unknown>
  const changeId = nonempty(row.changeId)
  if (!changeId || !isRevision(row.preferenceRevision)
    || !['preparing', 'ready', 'failed'].includes(String(row.status))) return previous
  if (previous) {
    if (row.preferenceRevision < previous.preferenceRevision) return previous
    if (row.preferenceRevision === previous.preferenceRevision && changeId !== previous.changeId
      && row.status !== 'preparing') return previous
    if (changeId === previous.changeId) {
      if (previous.status !== 'preparing' && row.status === 'preparing') return previous
      if (previous.status === 'ready' && row.status === 'failed') return previous
    }
  }
  return {
    status: row.status as ModelUpdateState['status'],
    changeId,
    preferenceRevision: row.preferenceRevision,
    ...(isRevision(row.revision) ? { revision: row.revision } : {}),
    ...(nonempty(row.error) ? { error: nonempty(row.error) } : {}),
    ...(row.quiet === true ? { quiet: true } : {}),
  }
}

export interface ComposerInferenceState {
  running: boolean
  streamMode: string
  currentInference: InferenceSnapshot | null
  modelUpdate: ModelUpdateState | null
}
