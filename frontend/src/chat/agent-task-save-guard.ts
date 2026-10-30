/** Keep unsaved task payloads alive until the host acknowledges their lifecycle. */
export function createAgentTaskSaveGuard<Snapshot>() {
  type State = { acknowledged?: Snapshot; acknowledgedRevision: number; revision: number; pending: Set<number> }
  type Ticket = { sessionId: string; state: State; revision: number }
  const sessions = new Map<string, State>()
  const current = (ticket: Ticket) => sessions.get(ticket.sessionId) === ticket.state
  return {
    active: current,
    acknowledged(sessionId: string, snapshot: Snapshot): boolean {
      return sessions.get(sessionId)?.acknowledged === snapshot
    },
    protected(sessionId: string, snapshot: Snapshot): boolean {
      const state = sessions.get(sessionId)
      return !!state?.pending.size || state?.acknowledged !== snapshot
    },
    begin(sessionId: string): Ticket {
      let state = sessions.get(sessionId)
      if (!state) {
        state = { acknowledgedRevision: 0, revision: 0, pending: new Set() }
        sessions.set(sessionId, state)
      }
      const revision = ++state.revision
      state.pending.add(revision)
      return { sessionId, state, revision }
    },
    complete(ticket: Ticket, snapshot: Snapshot): boolean {
      if (!current(ticket)) return false
      ticket.state.pending.delete(ticket.revision)
      if (ticket.revision > ticket.state.acknowledgedRevision) {
        ticket.state.acknowledged = snapshot
        ticket.state.acknowledgedRevision = ticket.revision
      }
      return true
    },
    fail(ticket: Ticket): boolean {
      if (!current(ticket)) return false
      ticket.state.pending.delete(ticket.revision)
      return true
    },
    forget(sessionId: string): void { sessions.delete(sessionId) },
  }
}
