import type { EffectiveMediaModel, EffectiveMediaModelCatalog } from '../../../../contracts/effective-media-models'
import { logHostDiagnostic } from './settings-error-text'

export interface MediaSelectionChange extends EffectiveMediaModel { model?: string }
interface PendingSelection {
  confirmed: EffectiveMediaModelCatalog
  changes: Array<MediaSelectionChange & { onSaved?: () => void }>
  done?: Promise<void>
}
export interface MediaSelectionSnapshot {
  reply: EffectiveMediaModelCatalog | null
  pending?: PendingSelection
  error?: string
  saveError?: boolean
}
type UpdateSnapshot = (update: (current: MediaSelectionSnapshot) => MediaSelectionSnapshot) => void

/** Resolve the remembered source-local identity without selecting a catalog head. */
export function mediaSelectionChange(catalog: EffectiveMediaModelCatalog, value: string, field: 'source' | 'model'): MediaSelectionChange | null {
  if (field === 'source') {
    if (value === catalog.selection || !catalog.options.some(option => option.source === value && (option.available || option.selectable))) return null
    const target = catalog.currentBySource[value]
    if (!target) return null
    const available = catalog.options.some(option => option.source === value && option.modelId === target.modelId && (option.available || option.selectable))
    return { ...target, ...(available ? { model: target.modelId } : {}) }
  }
  if (value === catalog.current.modelId || !catalog.options.some(option => option.source === catalog.selection && option.modelId === value && (option.available || option.selectable))) return null
  return { source: catalog.selection, modelId: value, model: value }
}

function apply(catalog: EffectiveMediaModelCatalog, change: MediaSelectionChange): EffectiveMediaModelCatalog {
  const current = { source: change.source, modelId: change.modelId }
  return { ...catalog, selection: change.source, current, currentBySource: { ...catalog.currentBySource, [change.source]: current } }
}

/** The shared pending queue survives a settings remount and serializes rapid choices. */
export function enqueueMediaSelection(snapshot: MediaSelectionSnapshot, change: MediaSelectionChange, update: UpdateSnapshot, api: {
  set(source: string, model?: string): Promise<{ ok?: boolean; error?: string }>
  settled(): void
  error: string
}, onSaved?: () => void): Promise<void> {
  if (!snapshot.reply) return Promise.resolve()
  const pending: PendingSelection = snapshot.pending ?? { confirmed: snapshot.reply, changes: [] }
  pending.changes.push({ ...change, onSaved })
  update(current => current.reply ? { reply: apply(current.reply, change), pending } : current)
  if (!pending.done) pending.done = (async () => {
    let error: string | undefined
    while (pending.changes.length) {
      const next = pending.changes.shift()!
      try {
        const result = await api.set(next.source, next.model)
        if (result?.ok !== true) { logHostDiagnostic('effective-media', result?.error); throw new Error(api.error) }
        pending.confirmed = apply(pending.confirmed, next)
        error = undefined
      } catch (cause) {
        logHostDiagnostic('effective-media', cause)
        error = api.error
      }
      if (!error) next.onSaved?.()
    }
    update(current => current.pending === pending ? { reply: pending.confirmed, ...(error ? { error, saveError: true } : {}) } : current)
    api.settled()
  })()
  return pending.done
}
