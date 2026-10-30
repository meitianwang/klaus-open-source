export type WorktreeAvailability = {
  sessionId: string
  state: 'available' | 'gone' | 'unavailable'
  repoRoot: string | null
}

export function classifyWorktreeAvailability(sessionId: string, result: { ok?: boolean; state?: string; repoRoot?: string } | null): WorktreeAvailability {
  return {
    sessionId,
    state: result?.ok === true && result.state === 'gone' ? 'gone'
      : result?.ok === true && result.state === 'available' ? 'available' : 'unavailable',
    repoRoot: typeof result?.repoRoot === 'string' ? result.repoRoot : null,
  }
}

export function paintWorktreeAvailability(
  row: HTMLElement,
  message: HTMLElement,
  action: HTMLButtonElement,
  status: WorktreeAvailability | null,
  currentSessionId: string | null,
  labels: { missing: string; unavailable: string; continueInOrigin: string; retry: string },
): void {
  row.hidden = !status || status.state === 'available' || status.sessionId !== currentSessionId
  if (row.hidden || !status) return
  message.textContent = status.state === 'gone' ? labels.missing : labels.unavailable
  action.hidden = status.state === 'gone' && !status.repoRoot
  action.textContent = status.state === 'gone' ? labels.continueInOrigin : labels.retry
}
