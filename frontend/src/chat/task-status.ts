import type { TaskStatus } from './task-state'

export const TASK_MARK_ICON: Record<TaskStatus, string> = {
  pending: 'plan-mark-pending',
  in_progress: 'plan-mark-in-progress',
  completed: 'plan-mark-completed',
}
