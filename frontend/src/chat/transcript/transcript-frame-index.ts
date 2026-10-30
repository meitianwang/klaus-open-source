import { TranscriptRenderIdentity } from './transcript-render-identity'

export interface SavedTurnFrame<T> { key: string; saved: T; index: number }
export interface SavedTurnFrameIndex<T> {
  frames: SavedTurnFrame<T>[]
  byKey: Map<string, SavedTurnFrame<T>>
  structure: string
}

/** Historical frames change only with saved input or newly learned turn aliases. */
export class TranscriptFrameIndex<T extends { key: string; turnId?: string }> {
  private groups: readonly T[] | null = null
  private identity: TranscriptRenderIdentity | null = null
  private revision = -1
  private value: SavedTurnFrameIndex<T> = { frames: [], byKey: new Map(), structure: '' }

  read(groups: readonly T[], identity: TranscriptRenderIdentity, opener: (group: T) => Parameters<TranscriptRenderIdentity['turn']>[2]): SavedTurnFrameIndex<T> {
    if (groups === this.groups && identity === this.identity && identity.revision === this.revision) return this.value
    const frames: SavedTurnFrame<T>[] = []
    const byKey = new Map<string, SavedTurnFrame<T>>()
    const seenOwners = new Set<string>()
    for (const [index, group] of groups.entries()) {
      const base = identity.turn(group.turnId, group.key, opener(group), !!group.turnId && seenOwners.has(group.turnId))
      if (group.turnId) seenOwners.add(group.turnId)
      const key = byKey.has(base) ? `${base}:segment:${group.key}` : base
      const frame = { key, saved: group, index }
      frames.push(frame)
      byKey.set(key, frame)
    }
    this.groups = groups
    this.identity = identity
    this.revision = identity.revision
    return this.value = { frames, byKey, structure: groups.map(group => group.key).join('\u0000') }
  }
}
