/**
 * Managed-worktree path predicate.
 *
 * The host creates managed worktrees under `~/.klaus/worktrees/` (the real
 * path validation lives in the main-process worktree manager); this is the
 * display-side check shared by the sidebar, the composer and the transcript's
 * worktree-init row.
 */
export function isWorktreeSessionWorkdir(workdir: string | null | undefined): boolean {
  return typeof workdir === 'string' && /[\\/]\.klaus[\\/]worktrees[\\/]/.test(workdir)
}
