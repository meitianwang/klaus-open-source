export interface SessionRunningState {
  running?: boolean
}

// Sub-agent and background-process activity is Monitor-only by product
// decision: a settled conversation must never read as a running turn while a
// long-lived child finishes, so neither source may light a sidebar row.
export interface SidebarWorkingSources {
  turnRunning: boolean
  listedWorking: boolean
}

export function sidebarSessionWorking(sources: SidebarWorkingSources): boolean {
  return sources.turnRunning || sources.listedWorking
}

export interface SessionRunningChange {
  sessionId: string
  running: boolean
}

export function sessionRunningChanges(
  previous: Record<string, SessionRunningState | undefined>,
  current: Record<string, SessionRunningState | undefined>,
): SessionRunningChange[] {
  const changes: SessionRunningChange[] = []
  for (const [sessionId, state] of Object.entries(current)) {
    if (!state) continue
    const running = state.running === true
    if ((previous[sessionId]?.running === true) === running) continue
    changes.push({ sessionId, running })
  }
  return changes
}
