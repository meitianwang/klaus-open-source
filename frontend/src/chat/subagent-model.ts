import type { AgentTask } from './engine-events'

/** Display the child's resolved model; older tasks may have no model stamp. */
export function paintSubagentModel(
  element: HTMLElement,
  task: AgentTask | null,
): void {
  const model = typeof task?.model === 'string' ? task.model.trim() : ''
  element.textContent = model
  element.hidden = !model
}
