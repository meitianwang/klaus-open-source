import type { WorkspaceDependenciesViewState } from '../../../../contracts/workspace-dependency-settings'

/** A completed check can find an unhealthy bundle without failing to run. */
export function dependenciesDiagnoseFeedback(state: WorkspaceDependenciesViewState): {
  key: 'runtime_dependencies_diagnose_ready' | 'runtime_dependencies_diagnose_problem'
  tone: 'success' | 'warning'
} {
  return state === 'ready'
    ? { key: 'runtime_dependencies_diagnose_ready', tone: 'success' }
    : { key: 'runtime_dependencies_diagnose_problem', tone: 'warning' }
}
