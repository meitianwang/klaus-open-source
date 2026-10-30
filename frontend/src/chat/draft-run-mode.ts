export type DraftRunModeTarget = {
  workdir: string | null
  workspaceId: string | null
}

export type DraftRunMode = {
  mode: 'local' | 'worktree'
  baseBranch: string | null
  /** Worktree mode only: carry the main checkout's uncommitted work into the new
   *  worktree (the "Include N uncommitted changes" toggle); defaults on. */
  includeUncommitted?: boolean
  workdir?: string | null
  workspaceId?: string | null
}

export function shouldRestoreWelcomeRunMode(
  saved: DraftRunMode | undefined,
  target: DraftRunModeTarget,
  targetWasExplicit: boolean,
) {
  if (!saved) return false
  if (!targetWasExplicit) return true

  // Records written before draft targets were persisted cannot prove that an
  // explicit project entry is reopening the same welcome draft.
  const hasStoredTarget = Object.prototype.hasOwnProperty.call(saved, 'workdir')
    || Object.prototype.hasOwnProperty.call(saved, 'workspaceId')
  if (!hasStoredTarget) return false

  return (saved.workdir ?? null) === target.workdir
    && (saved.workspaceId ?? null) === target.workspaceId
}
