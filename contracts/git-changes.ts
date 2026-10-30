/** Selects a repository comparison without changing its checkout or refs. */
export type DiffSource = 'branch' | 'uncommitted' | 'unstaged' | 'staged' | 'commit' | 'last-turn'
export interface DiffOptions {
  source?: DiffSource
  repositoryRoot?: string | null
  baseBranch?: string | null
  commitSha?: string | null
  turnId?: string | null
  previousPath?: string
  entryId?: string
  expectedBaseRevision?: string | null
  expectedHeadRevision?: string | null
  /** Include complete, bounded text snapshots when the comparison can supply them. */
  includeContents?: boolean
  /** Reject details when the selected file changed after its summary was read. */
  expectedSnapshotId?: string
}
