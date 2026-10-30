export interface BrowserFrameOwner { sessionId?: string; focusRevision?: number }
export interface BrowserStateOwner { conversationId?: string; focusRevision?: number }

/** Host revisions bind frames to the visible task across asynchronous decoding. */
export class BrowserFrameScope {
  generation = 0
  private latestRevision = -1
  private accepted: BrowserFrameOwner | null = null

  invalidate(): void {
    this.generation += 1
    this.accepted = null
  }

  update(state: BrowserStateOwner, currentSessionId: string): boolean {
    const revision = state.focusRevision
    if (revision !== undefined) {
      if (!Number.isSafeInteger(revision) || revision < this.latestRevision) return false
      if (revision > this.latestRevision && this.accepted) this.invalidate()
      this.latestRevision = revision
    }
    if (state.conversationId !== undefined && state.conversationId !== currentSessionId) return false
    if (state.conversationId !== undefined && revision !== undefined) {
      if (this.accepted?.sessionId !== state.conversationId || this.accepted?.focusRevision !== revision) this.generation += 1
      this.accepted = { sessionId: state.conversationId, focusRevision: revision }
    }
    return true
  }

  accepts(frame: BrowserFrameOwner, currentSessionId: string, generation = this.generation): boolean {
    if (generation !== this.generation) return false
    if (frame.sessionId === undefined) return true
    return frame.sessionId === currentSessionId && this.accepted?.sessionId === currentSessionId
      && frame.focusRevision !== undefined && frame.focusRevision === this.accepted.focusRevision
      && frame.focusRevision === this.latestRevision
  }
}
