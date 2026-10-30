// Composer run-context gating for the empty state.
//
// One computed gate drives both the execution-mode selector and the branch
// selector: a multi-folder workspace target, no target at all, or no current
// branch DISABLE the Worktree option with the reason "Not available for this
// project" and fall the running mode back to Local; the branch selector renders
// nothing at all in those cases (the host clears its branch state for those
// targets, so the component returns null rather than a disabled pill). A plain
// folder inside a real checkout is the only target that offers a branch at all.
//
// Klaus has two target kinds (a single project folder, or a named
// multi-folder workspace). A workspace has no single current branch — its roots
// are independent repositories — so it takes the grouped treatment:
// no branch pill, Worktree disabled.

import { transcriptContentPresence, type TranscriptChromeInput } from './transcript/chrome-state'

export type RunTargetKind = 'none' | 'project' | 'workspace'

export interface RunContextRowInput extends Pick<TranscriptChromeInput, 'running' | 'liveUnitCount' | 'history'> {
  editable: boolean
  pendingSubmission: boolean
}

/** Presentation ends at submission; workspace preparation may still need the draft settings. */
export function runContextRowVisible(input: RunContextRowInput): boolean {
  return input.editable && !input.pendingSubmission && transcriptContentPresence(input) !== 'present'
}

export interface RunContextInput {
  /** What the composer is pointed at right now. */
  target: RunTargetKind
  /** The target resolves to a git working tree (host `git:branches` succeeded). */
  isGitRepo: boolean
  /** That repository has a current branch (an initialised repo with no commit does not). */
  hasBranch: boolean
}

export interface RunContextControls {
  /** Render the branch pill ("Runs in  <project>  <mode>  <branch>"). */
  branchVisible: boolean
  /** The Worktree option is selectable. */
  worktreeEnabled: boolean
  /** i18n key for the disabled reason shown under the Worktree option, if disabled. */
  worktreeDisabledReasonKey: string | null
  /** The current mode cannot stay on Worktree for this target; fall back to local. */
  forceLocalMode: boolean
}

const UNAVAILABLE = 'run_worktree_unavailable'

const GROUPED: Omit<RunContextControls, 'branchVisible'> = {
  worktreeEnabled: false,
  worktreeDisabledReasonKey: UNAVAILABLE,
  forceLocalMode: true,
}

export function runContextControls(input: RunContextInput): RunContextControls {
  // A workspace is a group of independent repositories, so it exposes neither a
  // branch nor an isolated-worktree mode.
  if (input.target === 'workspace') return { branchVisible: false, ...GROUPED }
  // No project at all: with no target there is nothing to branch from, so both
  // controls hide outright and Local is forced. Callers hide the whole row for
  // this case.
  if (input.target === 'none') return { branchVisible: false, ...GROUPED }
  // Not a git working tree: Worktree is unavailable and there is no branch to show.
  if (!input.isGitRepo || !input.hasBranch) return { branchVisible: false, ...GROUPED }
  return { branchVisible: true, worktreeEnabled: true, worktreeDisabledReasonKey: null, forceLocalMode: false }
}
