import { describe, expect, test } from 'bun:test'
import { runContextControls, runContextRowVisible, type RunContextInput } from './run-context'
import vectors from '../../../contracts/vectors/composer-submission-vectors.json'

const input = (over: Partial<RunContextInput> = {}): RunContextInput =>
  ({ target: 'project', isGitRepo: true, hasBranch: true, ...over })

describe('composer run-context gating', () => {
  test('shows execution setup only while the visible composer is an unsent draft', () => {
    for (const vector of vectors.runContext.cases) {
      expect({ name: vector.name, visible: runContextRowVisible(vector.input) })
        .toEqual({ name: vector.name, visible: vector.visible })
    }
  })

  test('a single project folder in a real checkout shows the branch and allows worktree', () => {
    expect(runContextControls(input())).toEqual({
      branchVisible: true, worktreeEnabled: true, worktreeDisabledReasonKey: null, forceLocalMode: false,
    })
  })

  test('a multi-folder workspace behaves like a .code-workspace target', () => {
    // A workspace-file target disables Worktree with
    // "Not available for this project", and its branch state is cleared, so the
    // branch component renders nothing at all.
    const workspace = runContextControls(input({ target: 'workspace' }))
    expect(workspace.branchVisible).toBe(false)
    expect(workspace.worktreeEnabled).toBe(false)
    expect(workspace.worktreeDisabledReasonKey).toBe('run_worktree_unavailable')
    expect(workspace.forceLocalMode).toBe(true)
  })

  test('a workspace is treated the same whether or not a root happens to be a repo', () => {
    // The workspace's primary root being a git checkout must NOT leak a branch pill
    // back in: the workspace has no single current branch.
    expect(runContextControls(input({ target: 'workspace', isGitRepo: true, hasBranch: true })).branchVisible).toBe(false)
    expect(runContextControls(input({ target: 'workspace', isGitRepo: false, hasBranch: false })).branchVisible).toBe(false)
  })

  test('a non-repository folder hides the branch and disables worktree', () => {
    const plain = runContextControls(input({ isGitRepo: false, hasBranch: false }))
    expect(plain.branchVisible).toBe(false)
    expect(plain.worktreeEnabled).toBe(false)
    expect(plain.forceLocalMode).toBe(true)
  })

  test('an initialised repository without a commit has no branch and no worktree', () => {
    // `git rev-parse --abbrev-ref HEAD` prints the literal "HEAD" on an unborn
    // branch; callers normalise that to hasBranch: false.
    const unborn = runContextControls(input({ isGitRepo: true, hasBranch: false }))
    expect(unborn.branchVisible).toBe(false)
    expect(unborn.worktreeEnabled).toBe(false)
  })

  test('no target at all exposes neither control', () => {
    const none = runContextControls(input({ target: 'none', isGitRepo: false, hasBranch: false }))
    expect(none.branchVisible).toBe(false)
    expect(none.worktreeEnabled).toBe(false)
    expect(none.forceLocalMode).toBe(true)
  })

  test('worktree is never offered without a branch, for any target kind', () => {
    for (const target of ['none', 'project', 'workspace'] as const) {
      for (const isGitRepo of [true, false]) {
        for (const hasBranch of [true, false]) {
          const gate = runContextControls({ target, isGitRepo, hasBranch })
          if (gate.worktreeEnabled) {
            expect(target).toBe('project')
            expect(isGitRepo).toBe(true)
            expect(hasBranch).toBe(true)
          }
          // A hidden branch always means worktree is off, and vice versa: the two
          // controls share one gate.
          if (!gate.branchVisible) expect(gate.worktreeEnabled).toBe(false)
        }
      }
    }
  })
})
