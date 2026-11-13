interface StopOwner { turnId: string | null; token: object }

/** Stop presentation belongs to the captured turn, not every future turn in its session. */
export function createTurnStopState(currentTurn: (sessionId: string) => string | null) {
  const owners = new Map<string, StopOwner>()
  return {
    has(sessionId: string): boolean {
      const owner = owners.get(sessionId)
      return !!owner && owner.turnId === currentTurn(sessionId)
    },
    add(sessionId: string): StopOwner {
      const owner = { turnId: currentTurn(sessionId), token: {} }
      owners.set(sessionId, owner)
      return owner
    },
    delete(sessionId: string, owner?: StopOwner): boolean {
      if (owner && owners.get(sessionId) !== owner) return false
      return owners.delete(sessionId)
    },
  }
}
