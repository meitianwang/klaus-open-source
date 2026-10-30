import type { ThreadGoal } from '../../contracts/planning-goals';
import { object } from '../ipc/arguments';
import { goalSnapshot } from './workflow-snapshots';

/** Completion presentation uses the successful tool's captured accounting snapshot. */
export function completedGoalResult(name: string, result: unknown): ThreadGoal | undefined {
  if (name !== 'update_goal') return undefined;
  const record = object(result), output = object(record?.output) ?? record;
  if (output?.ok !== true) return undefined;
  const goal = goalSnapshot(output.goal, 0)?.goal;
  return goal?.status === 'complete' ? goal : undefined;
}
