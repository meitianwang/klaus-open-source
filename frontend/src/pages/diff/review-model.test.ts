import { expect, test } from 'bun:test'
import { structuredPatch } from 'diff'
import { fileTree, importHunks, patchForHunks, reviewMetadata } from './review-model'
import { commentFeedback, readCommentDraft, writeCommentDraft } from './review-feedback'
const hunks = (before: string, after: string) => structuredPatch('before', 'after', before, after, '', '', { context: 3 }).hunks

test('complete metadata preserves context coordinates and import filtering retains both file sides', () => {
  const before = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n') + '\n'
  const after = before.replace('line 80\n', 'changed 80\n')
  const changes = hunks(before, after)
  const model = reviewMetadata({ path: 'file.ts' }, changes, { oldContent: before, newContent: after }, { hideImports: true, hideWhitespace: false }, 'snapshot')!
  expect(model.isPartial).toBe(false)
  expect(model.deletionLines).toHaveLength(100)
  expect(model.additionLines).toHaveLength(100)
  expect(model.hunks[0].deletionStart).toBe(changes[0].oldStart)
})
test('empty new files and pure renames retain their actual change types', () => {
  const empty = reviewMetadata({ path: 'empty.txt', isUntracked: true }, [], { oldContent: '', newContent: '', patch: 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n' }, { hideImports: false, hideWhitespace: false }, 'empty')!
  expect(empty.type).toBe('new')
  const rename = reviewMetadata({ path: 'new.txt', previousPath: 'old.txt' }, [], { oldContent: 'same\n', newContent: 'same\n', patch: 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n' }, { hideImports: false, hideWhitespace: false }, 'rename')!
  expect(rename.type).toBe('rename-pure')
  expect(rename.prevName).toBe('old.txt')
})
test('whitespace filtering removes only whitespace effects and preserves new content with complete sides', () => {
  const before = 'one\nconst value=1\n', after = 'one\nconst value = 1\n'
  expect(reviewMetadata({ path: 'file.ts' }, hunks(before, after), { oldContent: before, newContent: after }, { hideImports: false, hideWhitespace: true }, 'white')).toBeNull()
})
test('syntax imports exclude strings, comments, local imports and public Rust exports', async () => {
  const before = 'import { oldName } from "./source"\n\nexport const stable = true\n'
  const after = 'import { newName } from "./source"\n\nexport const stable = true\n'
  expect([...await importHunks('file.ts', hunks(before, after), before, after)]).toEqual([0])
  const commentsBefore = '// import old\nconst a = "import old"\n', commentsAfter = '// import new\nconst a = "import new"\n'
  expect([...await importHunks('file.ts', hunks(commentsBefore, commentsAfter), commentsBefore, commentsAfter)]).toEqual([])
  const pyBefore = 'def function():\n    import old\n', pyAfter = 'def function():\n    import new\n'
  expect([...await importHunks('file.py', hunks(pyBefore, pyAfter), pyBefore, pyAfter)]).toEqual([])
  const rustBefore = 'pub use old::Value;\n', rustAfter = 'pub use new::Value;\n'
  expect([...await importHunks('file.rs', hunks(rustBefore, rustAfter), rustBefore, rustAfter)]).toEqual([])
})
test('tree grouping preserves repository and duplicate entry identities while compressing directory chains', () => {
  const files = [{ path: 'src/deep/file.ts', repositoryRoot: '/a', entryId: 'one' }, { path: 'src/deep/file.ts', repositoryRoot: '/b', entryId: 'two' }]
  const tree = fileTree(files, file => file.entryId!, [{ root: '/a', name: 'main' }, { root: '/b', name: 'topic' }])
  expect(tree).toHaveLength(2)
  expect(tree.flatMap(node => node.children!.map(child => child.key))).toEqual(['one', 'two'])
  expect(tree[0].label).toBe('main/src/deep')
})
test('feedback keeps both range sides and the original captured patch without breaking code fences', () => {
  const context = patchForHunks([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-```', '+new'] }])
  const text = commentFeedback([{ id: 'comment', fileKey: 'key', path: '/repo/file.ts', range: { start: 1, end: 2, side: 'deletions', endSide: 'additions' }, body: 'Keep the original semantics.', localDiffHunk: context }], 'Review feedback')
  expect(text).toContain('1 (before) to 2 (after)')
  expect(text).toContain(context)
  expect(text).toContain('````diff')
})

test('fully hidden import patches stay hidden when the full raw patch is cached', () => {
  const before = 'import oldName from "./old"\n', after = 'import newName from "./new"\n'
  const patch = patchForHunks(hunks(before, after))
  expect(reviewMetadata({ path: 'file.ts' }, [], { oldContent: before, newContent: after, patch },
    { hideImports: true, hideWhitespace: false }, 'hidden')).toBeNull()
})
test('unfinished line feedback retains its captured snapshot and remains isolated by owner and path', () => {
  const draft = { range: { start: 4, end: 7, side: 'additions' as const }, body: 'Review this range', localDiffHunk: '@@ original', snapshotId: 'before-refresh' }
  writeCommentDraft('owner-one', '/repo/file.ts', draft)
  expect(readCommentDraft('owner-one', '/repo/file.ts')).toEqual(draft)
  expect(readCommentDraft('owner-two', '/repo/file.ts')).toBeNull()
  expect(readCommentDraft('owner-one', '/repo/other.ts')).toBeNull()
  writeCommentDraft('owner-one', '/repo/file.ts', null)
  expect(readCommentDraft('owner-one', '/repo/file.ts')).toBeNull()
})
