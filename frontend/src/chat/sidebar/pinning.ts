import type { SessionInfo } from '../engine-events'
import { isPinnedSession } from './model'

interface PinReply {
  ok?: boolean
  error?: string
  sidebarPinnedAt?: number | null
}

interface PinActions {
  getSessions(): SessionInfo[]
  setSessions(sessions: SessionInfo[]): void
  persist(sessionId: string, pinned: boolean): Promise<PinReply>
  render(): void
}

interface PendingPin {
  desiredPinned: boolean
  confirmedPinnedAt: number | null | undefined
  persistedPinned: boolean
  task: Promise<void>
}

export class SessionPinning {
  private versions = new Map<string, number>()
  private pending = new Map<string, PendingPin>()

  constructor(private actions: PinActions) {}

  snapshot(): Map<string, number> {
    return new Map(this.versions)
  }

  mergeSnapshot(incoming: SessionInfo[], before: Map<string, number>): SessionInfo[] {
    const current = new Map(this.actions.getSessions().map(session => [session.id, session]))
    return incoming.map(session => {
      if ((this.versions.get(session.id) || 0) <= (before.get(session.id) || 0)) return session
      const fresh = current.get(session.id)
      return fresh ? { ...session, sidebarPinnedAt: fresh.sidebarPinnedAt } : session
    })
  }

  async toggle(sessionId: string): Promise<void> {
    const session = this.actions.getSessions().find(row => row.id === sessionId)
    if (!session) return
    const nextPinned = !isPinnedSession(session)
    const optimisticPinnedAt = nextPinned ? this.nextOptimisticPinnedAt() : null
    const existing = this.pending.get(sessionId)
    if (existing) {
      existing.desiredPinned = nextPinned
      this.applySidebarPinnedAt(sessionId, optimisticPinnedAt, true)
      return existing.task
    }

    const confirmedPinnedAt = session.sidebarPinnedAt
    const state: PendingPin = {
      desiredPinned: nextPinned,
      confirmedPinnedAt,
      persistedPinned: Boolean(Number.isFinite(confirmedPinnedAt) && Number(confirmedPinnedAt) > 0),
      task: Promise.resolve(),
    }
    this.applySidebarPinnedAt(sessionId, optimisticPinnedAt, true)
    const task = this.flush(sessionId, state)
    state.task = task
    this.pending.set(sessionId, state)
    return task
  }

  private async flush(sessionId: string, state: PendingPin): Promise<void> {
    try {
      while (state.desiredPinned !== state.persistedPinned) {
        const targetPinned = state.desiredPinned
        const result = await this.actions.persist(sessionId, targetPinned)
        if (!result?.ok) throw new Error(result?.error || 'session_pin_failed')
        const pinnedAt = targetPinned ? result.sidebarPinnedAt : null
        if (targetPinned && (!Number.isFinite(pinnedAt) || Number(pinnedAt) <= 0)) {
          throw new Error('session_pin_failed')
        }
        state.confirmedPinnedAt = pinnedAt
        state.persistedPinned = targetPinned
        if (state.desiredPinned === targetPinned) {
          this.applySidebarPinnedAt(sessionId, pinnedAt, false)
        }
      }
    } catch (error) {
      const confirmedPinned = Boolean(
        Number.isFinite(state.confirmedPinnedAt) && Number(state.confirmedPinnedAt) > 0,
      )
      this.applySidebarPinnedAt(sessionId, state.confirmedPinnedAt, true)
      if (confirmedPinned !== state.desiredPinned) throw error
    } finally {
      if (this.pending.get(sessionId) === state) this.pending.delete(sessionId)
    }
  }

  private nextOptimisticPinnedAt(): number {
    let highest = Date.now()
    for (const row of this.actions.getSessions()) {
      const value = Number(row.sidebarPinnedAt)
      if (Number.isFinite(value) && value >= highest) highest = value + 1
    }
    return highest
  }

  private applySidebarPinnedAt(
    sessionId: string,
    sidebarPinnedAt: number | null | undefined,
    alwaysRender: boolean,
  ): void {
    const previousRows = this.actions.getSessions()
    const current = previousRows.find(row => row.id === sessionId)
    this.versions.set(sessionId, (this.versions.get(sessionId) || 0) + 1)
    if (!current) {
      if (alwaysRender) this.actions.render()
      return
    }
    const changed = current.sidebarPinnedAt !== sidebarPinnedAt
    // Refreshes and title pushes replace rows while persistence is in flight.
    this.actions.setSessions(previousRows.map(row =>
      row.id === sessionId ? { ...row, sidebarPinnedAt } : row,
    ))
    if (alwaysRender || changed) this.actions.render()
  }
}
