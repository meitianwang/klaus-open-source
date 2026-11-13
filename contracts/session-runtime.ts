/** Session activity and turn outcomes are different facts. Missing rows prove neither. */
export interface SessionRuntimeSnapshot {
  sessionId: string
  status: 'active' | 'idle' | 'notLoaded'
  activeFlags?: string[]
  turn?: { id: string; status: string; startedAt: number | null; completedAt: number | null; error?: string; clientMessageId?: string }
}
export interface SessionRuntimeRead {
  sessions: SessionRuntimeSnapshot[]
  unavailableSessionIds: string[]
  /** Compatibility summary only; consumers must not infer idle from absence. */
  workingSessionIds: string[]
}
