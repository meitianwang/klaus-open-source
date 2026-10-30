/** Preference row that gates installation and provisioning of the managed workspace runtime. */
export const WORKSPACE_DEPENDENCIES_ENABLED_KEY = 'klaus.workspaceDependencies'

/** Absent or unreadable preference means the managed runtime stays available. */
export const WORKSPACE_DEPENDENCIES_ENABLED_DEFAULT = 'on'

export const WORKSPACE_DEPENDENCIES_CHANNELS = [
  'settings:workspace-dependencies:get',
  'settings:workspace-dependencies:diagnose',
  'settings:workspace-dependencies:reinstall',
] as const

export type WorkspaceDependenciesViewState = 'missing' | 'installing' | 'ready' | 'failed' | 'unsupported' | 'disabled'

export interface WorkspaceDependenciesView {
  enabled: boolean
  state: WorkspaceDependenciesViewState
  version?: string
  pythonVersion?: string
  logPath?: string
  error?: string
}

export type WorkspaceDependenciesResponse = { ok: true } & WorkspaceDependenciesView
