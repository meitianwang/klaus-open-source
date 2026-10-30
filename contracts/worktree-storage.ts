export interface WorktreeStorageSettings {
  root: string
  defaultRoot: string
  upstreamRefreshMode: 'never' | 'best-effort'
  autoCleanupEnabled: boolean
  keepCount: number
}

export interface ManagedWorktreeRecord {
  path: string
  repoRoot: string | null
  createdAt: number
}

export interface WorktreeStorageList {
  worktrees: ManagedWorktreeRecord[]
  settings: WorktreeStorageSettings
}

export type WorktreeStorageSettingsPatch = Partial<Pick<WorktreeStorageSettings, 'root' | 'upstreamRefreshMode' | 'autoCleanupEnabled' | 'keepCount'>>
