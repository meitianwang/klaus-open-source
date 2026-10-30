export interface AuthMenuState {
  sessionId: string | null
  revision: number
  activeMode: string
}

// A menu belongs to the conversation that opened it. The source itself is read
// from the pill's already-refreshed state; opening the menu never probes provider
// configuration.
export class AuthMenuRequests {
  private revision = 0

  constructor(private readonly currentSessionId: () => string | null) {}

  invalidate(): void {
    this.revision++
  }

  isCurrent(state: Pick<AuthMenuState, 'sessionId' | 'revision'>): boolean {
    return state.revision === this.revision && state.sessionId === this.currentSessionId()
  }

  capture(): Pick<AuthMenuState, 'sessionId' | 'revision'> {
    return { sessionId: this.currentSessionId(), revision: this.revision }
  }
}
