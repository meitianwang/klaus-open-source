import { describe, expect, test } from 'bun:test'
import { shouldRestoreWelcomeRunMode, type DraftRunMode } from './draft-run-mode'

const saved: DraftRunMode = {
  mode: 'worktree',
  baseBranch: 'main',
  workdir: '/workspace/klaus',
  workspaceId: null,
}

describe('welcome draft run mode target', () => {
  test('restores the mode when reopening the same project draft', () => {
    expect(shouldRestoreWelcomeRunMode(saved, {
      workdir: '/workspace/klaus',
      workspaceId: null,
    }, true)).toBe(true)
  })

  test('resets the mode when an explicit entry targets another project', () => {
    expect(shouldRestoreWelcomeRunMode(saved, {
      workdir: '/workspace/other',
      workspaceId: null,
    }, true)).toBe(false)
  })

  test('keeps workspace identity distinct from its primary project', () => {
    const workspaceSaved: DraftRunMode = {
      ...saved,
      workspaceId: 'workspace-a',
    }
    expect(shouldRestoreWelcomeRunMode(workspaceSaved, {
      workdir: '/workspace/klaus',
      workspaceId: null,
    }, true)).toBe(false)
    expect(shouldRestoreWelcomeRunMode(workspaceSaved, {
      workdir: '/workspace/klaus',
      workspaceId: 'workspace-a',
    }, true)).toBe(true)
  })

  test('restores an unscoped return but does not guess for legacy explicit entries', () => {
    const legacy: DraftRunMode = { mode: 'worktree', baseBranch: 'main' }
    const target = { workdir: '/workspace/klaus', workspaceId: null }
    expect(shouldRestoreWelcomeRunMode(legacy, target, false)).toBe(true)
    expect(shouldRestoreWelcomeRunMode(legacy, target, true)).toBe(false)
  })
})
