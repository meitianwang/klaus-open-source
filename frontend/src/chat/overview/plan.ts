// The Plan section presents the current authoritative Task snapshot. Its rows
// and the composer progress capsule share task-state; transcript items are not
// a second source of plan state.
import { applyDefaultCollapseState } from './shared'
import { createRowViewport, type RowViewport } from './row-viewport'

let planViewport: { element: HTMLElement; controller: RowViewport } | null = null

/** Replace task rows without losing scroll on status updates to the same plan. */
export function renderPlanRows(body: HTMLElement, identity: string, renderRows: () => void): void {
  if (planViewport?.element !== body) {
    planViewport?.controller.dispose()
    planViewport = { element: body, controller: createRowViewport(body) }
  }
  planViewport.controller.render(identity, () => {
    renderRows()
    return Array.from(body.querySelectorAll<HTMLElement>(':scope > .task-row'))
  })
}

/** A session or explicit plan switch starts at the first task. */
export function resetPlanViewport(): void {
  planViewport?.controller.reset()
}

/** Reveal the capsule's task list even when its section was folded. */
export function revealPlan(): void {
  window.klausOpenMonitorPanel?.()
  const section = document.getElementById('monitor-section-plan')
  if (!section) return
  section.classList.remove('collapsed')
  section.querySelector('.artifacts-section-header')?.setAttribute('aria-expanded', 'true')
  section.scrollIntoView({ block: 'nearest' })
}

export function reconcilePlanSection(): void {
  const section = document.getElementById('monitor-section-plan')
  const tasks = document.getElementById('monitor-plan-group-tasks')
  const empty = document.getElementById('monitor-plan-empty')
  if (!section) return
  if (empty) empty.hidden = !!tasks && !tasks.hidden || !!document.getElementById('monitor-proposed-plan')
  applyDefaultCollapseState('monitor-section-plan')
}
