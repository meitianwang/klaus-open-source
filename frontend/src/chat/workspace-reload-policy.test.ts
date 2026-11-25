import { expect, test } from 'bun:test'
import { shouldReloadWorkspaceFileOnChange, shouldReloadWorkspaceMediaOnChange, type WorkspaceChangeItem, type WorkspaceChangeNotification } from './workspace-reload-policy'

const changed = (...events: WorkspaceChangeItem[]) => ({ type: 'workspace:changed', events })
const video = '/repo/media/clip.mp4'
const decisions = (event: WorkspaceChangeNotification, targets: string[], ownWrite = (_path: string) => false) => [
  shouldReloadWorkspaceFileOnChange(event, targets, ownWrite),
  shouldReloadWorkspaceMediaOnChange(event, targets),
]

test('ignores repository edits for an external video', () => {
  expect(decisions(changed({ path: '/repo/notes.txt' }), ['/external/clip.mp4'])).toEqual([false, false])
})

test('ignores sibling edits for a repository video', () => {
  expect(decisions(changed({ path: '/repo/media/notes.txt' }), [video])).toEqual([false, false])
})

test('preserves media for live ancestor directory events but reloads on removal', () => {
  for (const kind of ['change', 'add']) {
    expect(decisions(changed({ path: '/repo/media', isDir: true, kind }), [video])).toEqual([true, false])
  }
  for (const kind of ['unlink', 'delete']) {
    expect(decisions(changed({ path: '/repo/media', isDir: true, kind }), [video])).toEqual([true, true])
  }
})

test('reloads for direct changes to the tab path or resolved preview path', () => {
  const previewPath = '/external/resolved.mp4'
  for (const path of [video, previewPath]) {
    expect(decisions(changed({ path, kind: 'change' }), [video, previewPath])).toEqual([true, true])
  }
})

test('suppresses file reload for a recent self-write on either normalized target', () => {
  const previewPath = '/external/resolved.mp4'
  expect(decisions(changed({ path: video }), [video, '\\external\\resolved.mp4'], path => path === previewPath)).toEqual([false, true])
})

test('refreshes file authorization without forcing a media reload on invalidation', () => {
  const event = { type: 'workspace:invalidated' }
  expect(decisions(event, [video], () => true)).toEqual([true, false])
  expect(decisions(event, [])).toEqual([false, false])
})

test('refreshes file data without forcing media reload for pathless notifications', () => {
  expect(decisions(changed(), [video])).toEqual([true, false])
})
