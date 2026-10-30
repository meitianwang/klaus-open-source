import { expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/storage-settings.json'
import { REVIEW_DAY_OPTIONS, REVIEW_PAGE_SIZE, STORAGE_DISPLAY_CATEGORIES, formatStorageBytes } from './storage-model'
import { worktreeContains, worktreeConversations, worktreeSource } from './worktree-storage-model'

test('storage categories, filters and pagination follow the committed contract', () => {
  expect([...STORAGE_DISPLAY_CATEGORIES]).toEqual(vectors.categories)
  expect([...REVIEW_DAY_OPTIONS]).toEqual(vectors.review.days)
  expect(REVIEW_PAGE_SIZE).toBe(vectors.review.pageSize)
})

for (const entry of vectors.bytes) test(`storage size ${entry.value} uses the declared label`, () => {
  expect(formatStorageBytes(entry.value)).toBe(entry.label)
})
for (const entry of vectors.worktreePaths) test(`worktree ownership boundary: ${entry.path}`, () => {
  expect(worktreeContains(entry.root, entry.path)).toBe(entry.included)
})

test('known worktree conversations include pinned branches while excluding unrelated paths and ephemeral tasks', () => {
  const rows = [
    { id: 'root', workdir: '/worktrees/one/src', projectRoot: '/projects/main' },
    { id: 'child', workdir: '/worktrees/one', parentSessionId: 'root' },
    { id: 'pinned-child', workdir: '/worktrees/one', parentSessionId: 'root', sidebarPinnedAt: 1 },
    { id: 'ephemeral', workdir: '/worktrees/one', ephemeral: true },
    { id: 'unrelated', workdir: '/worktrees/one-more' },
  ]
  const known = worktreeConversations('/worktrees/one', rows)
  expect(known.map(row => row.id)).toEqual(['root', 'pinned-child'])
  expect(worktreeSource(known)?.id).toBe('pinned-child')
})
