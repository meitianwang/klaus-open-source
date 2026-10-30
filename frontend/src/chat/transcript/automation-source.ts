// Provenance caption for a user row the scheduler authored on the user's behalf.
//
// A scheduled run sends its prompt through the host: no composer typed it, so the
// bubble carries a display snapshot (`localRender`) with `origin: 'automation'`
// and the task identity. The transcript shows one small caption line above that
// bubble — the same shape as the delegation label row — so a reopened run still
// reads as machine-triggered rather than as something the user typed.

/** The display-snapshot fields a scheduled send stamps onto its user row. */
export interface AutomationSource {
  origin: 'automation'
  taskName?: string
  taskId?: string
  runId?: number
  triggerType?: string
}

export function automationSourceFromLocalRender(localRender: unknown): AutomationSource | null {
  if (!localRender || typeof localRender !== 'object' || Array.isArray(localRender)) return null
  const render = localRender as { origin?: unknown }
  if (render.origin !== 'automation') return null
  return localRender as AutomationSource
}

/**
 * `Scheduled task · Daily report`, or the bare scheduled label when the snapshot
 * carries no task name. Null for every row a human (or a friend, or a channel)
 * authored: the caption is provenance, not decoration.
 */
export function automationMessageLabel(localRender: unknown, scheduledLabel: string): string | null {
  const source = automationSourceFromLocalRender(localRender)
  if (!source) return null
  const taskName = String(source.taskName ?? '').trim()
  return taskName ? `${scheduledLabel} · ${taskName}` : scheduledLabel
}
