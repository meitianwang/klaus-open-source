import type { PlanningSnapshot } from '../planning/types'

/** Goal mode starts from a fresh collaboration snapshot, independently of permissions. */
export async function leavePlanningForGoal(options: {
  valid(): boolean
  read(): Promise<{ planning: PlanningSnapshot }>
  setDefault(): Promise<{ planning: PlanningSnapshot }>
  apply(planning: PlanningSnapshot): void
}): Promise<boolean> {
  const read = async () => {
    const result = await options.read()
    if (!result?.planning || 'ok' in result && result.ok === false || 'error' in result && result.error || !['default', 'plan'].includes(result.planning.mode)) throw new Error('Invalid collaboration mode')
    return result.planning
  }
  let planning = await read()
  if (!options.valid()) return false
  if (planning.mode === 'plan') {
    const result = await options.setDefault()
    if (!options.valid()) return false
    if (!result?.planning || 'ok' in result && result.ok === false || 'error' in result && result.error || result.planning.mode !== 'default') throw new Error('Planning mode did not change')
    planning = await read()
    if (!options.valid()) return false
    if (planning.mode !== 'default') throw new Error('Planning mode is still active')
  }
  options.apply(planning)
  return true
}
