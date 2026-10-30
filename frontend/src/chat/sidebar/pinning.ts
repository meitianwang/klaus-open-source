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

export class SessionPinning {
  private versions = new Map<string, number>()
  private pending = new Set<string>()

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
    if (this.pending.has(sessionId)) return
    const session = this.actions.getSessions().find(row => row.id === sessionId)
    if (!session) return
    const pinned = !isPinnedSession(session)
    this.pending.add(sessionId)
    try {
      const result = await this.actions.persist(sessionId, pinned)
      if (!result?.ok) throw new Error(result?.error || 'session_pin_failed')
      const pinnedAt = pinned ? result.sidebarPinnedAt : null
      if (pinned && (!Number.isFinite(pinnedAt) || Number(pinnedAt) <= 0)) {
        throw new Error('session_pin_failed')
      }
      this.versions.set(sessionId, (this.versions.get(sessionId) || 0) + 1)
      // Refreshes and title pushes replace rows while persistence is in flight.
      this.actions.setSessions(this.actions.getSessions().map(row =>
        row.id === sessionId ? { ...row, sidebarPinnedAt: pinnedAt } : row,
      ))
      this.actions.render()
    } finally {
      this.pending.delete(sessionId)
    }
  }
}
