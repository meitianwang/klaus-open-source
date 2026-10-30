import { afterAll, beforeAll, expect, test } from 'bun:test'

let savedWindow: any, savedDocument: any
let currentSession: string | null = 'diff-initial'
const summaries: any[] = [], details: any[] = [], opened: any[] = []
let summaryReply: (id: string, options: any) => Promise<any>
let detailReply: (id: string, path: string, options: any) => Promise<any>
let store: typeof import('./store')
const result = (options: any = {}, files: any[] = []) => ({
  isGit: true, source: options.source, repositoryRoot: options.repositoryRoot ?? '/a', root: '/a',
  repositories: [{ root: '/a', name: 'a' }, { root: '/b', name: 'b' }],
  defaultBaseBranch: 'origin/main', baseBranches: ['main', 'refs/remotes/origin/main'],
  currentBranch: 'feature', commits: [{ sha: 'abc', subject: 'feature' }],
  comparison: { type: 'success', baseRevision: 'base', headRevision: 'head' },
  stats: { filesCount: files.length, linesAdded: 1, linesRemoved: 0 }, canCommit: true, files,
})
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
beforeAll(async () => {
  savedWindow = (globalThis as any).window; savedDocument = (globalThis as any).document
  summaryReply = async (_id, options) => result(options)
  detailReply = async (_id, path) => ({ ok: true, files: [{ path, hunks: [] }] })
  ;(globalThis as any).window = {
    currentLang: 'en', addEventListener: () => {}, getCurrentSessionId: () => currentSession,
    klaus: { diff: {
      summary: (id: string, options: any) => { summaries.push([id, options]); return summaryReply(id, options) },
      hunks: (id: string, path: string, options: any) => { details.push([id, path, options]); return detailReply(id, path, options) },
      open: (...args: any[]) => { opened.push(args); return Promise.resolve({ ok: true }) },
    } },
  }
  ;(globalThis as any).document = { getElementById: (id: string) => id === 'diff-view' ? { classList: { contains: () => true, add() {}, remove() {} } } : null }
  store = await import('./store')
})
afterAll(() => { (globalThis as any).window = savedWindow; (globalThis as any).document = savedDocument })
test('automatic remote base stays automatic while explicit local and remote bases remain distinct', async () => {
  await store.reload(true)
  expect(summaries.at(-1)[1].source).toBe('branch')
  expect(summaries.at(-1)[1].baseBranch).toBeNull()
  store.setBaseBranch('main'); await flush()
  expect(summaries.at(-1)[1].baseBranch).toBe('main')
  store.setBaseBranch('refs/remotes/origin/main'); await flush()
  expect(summaries.at(-1)[1].baseBranch).toBe('refs/remotes/origin/main')
})
test('last-turn duplicate paths have distinct cache entries and repo selection switches to uncommitted', async () => {
  summaryReply = async (_id, options) => result(options, [
    { repositoryRoot: '/a', path: 'src/index.ts', additions: 1, deletions: 0 },
    { repositoryRoot: '/b', path: 'src/index.ts', additions: 1, deletions: 0 },
  ])
  store.setSource('last-turn'); await flush()
  const files = store.allFiles(); expect(store.fileKey(files[0])).not.toBe(store.fileKey(files[1]))
  store.selectPath(store.fileKey(files[1])); await flush(); await store.runFileAction('open')
  expect(opened.at(-1)[1]).toBe('src/index.ts'); expect(opened.at(-1)[2].repositoryRoot).toBe('/b')
  store.setRepository('/b'); await flush()
  expect(summaries.at(-1)[1]).toMatchObject({ source: 'uncommitted', repositoryRoot: '/b', baseBranch: null, commitSha: null })
})
test('untracked text loads its content with comparison identity and binary unknown totals stay unknown', async () => {
  summaryReply = async (_id, options) => result(options, [{ repositoryRoot: '/b', path: 'new.ts', isUntracked: true, additions: 1, deletions: 0 }])
  await store.reload(true); await flush()
  expect(details.at(-1)[1]).toBe('new.ts')
  expect(details.at(-1)[2]).toMatchObject({ repositoryRoot: '/b', expectedBaseRevision: 'base', expectedHeadRevision: 'head' })
  expect(store.countLabel(null)).toBe('—')
  expect(store.shouldLoadHunks({ path: 'blob', isBinary: true })).toBe(false)
})
test('closing a session rejects an earlier summary response', async () => {
  let resolve!: (value: any) => void
  summaryReply = () => new Promise(settle => { resolve = settle })
  currentSession = 'diff-race'; const pending = store.reload(true)
  currentSession = null; await store.reload(true)
  resolve(result({}, [{ path: 'stale.ts' }])); await pending
  expect(store.state.sessionId).toBeNull(); expect(store.state.summary).toBeNull()
})
test('switching comparison rejects a late hunk response from the old scope', async () => {
  currentSession = 'diff-race-details'
  summaryReply = async (_id, options) => result(options, [{ path: 'same.ts', repositoryRoot: '/a' }])
  let resolveOld!: (value: any) => void
  detailReply = () => new Promise(settle => { resolveOld = settle })
  await store.reload(true)
  detailReply = async (_id, path) => ({ ok: true, files: [{ path, hunks: [{ lines: ['+current'] }] }] })
  store.setSource('staged'); await flush()
  resolveOld({ ok: true, files: [{ path: 'same.ts', hunks: [{ lines: ['+stale'] }] }] }); await flush()
  expect(store.state.hunkMap.get(store.fileKey(store.selectedFile()))?.[0]?.lines).toEqual(['+current'])
})
test('historical duplicate entries use distinct keys and Commit starts with a selected SHA', async () => {
  expect(store.fileKey({ repositoryRoot: '/a', path: 'same.ts', entryId: '1' })).not.toBe(store.fileKey({ repositoryRoot: '/a', path: 'same.ts', entryId: '2' }))
  store.setSource('commit'); await flush()
  expect(summaries.at(-1)[1].commitSha).toBe('abc')
})
test('distinct rename relations retain their own details and original paths', async () => {
  currentSession = 'diff-rename-relations'
  summaryReply = async (_id, options) => result(options, [
    { path: 'target.ts', previousPath: 'old-a.ts', repositoryRoot: '/a' },
    { path: 'target.ts', previousPath: 'old-b.ts', repositoryRoot: '/a' },
  ])
  detailReply = async (_id, path, options) => ({ ok: true, files: [{ path, hunks: [{ lines: [`-${options.previousPath}`] }] }] })
  await store.reload(true); await flush()
  const files = store.allFiles()
  store.selectPath(store.fileKey(files[1])); await flush()
  expect(details.at(-1)[2].previousPath).toBe('old-b.ts')
  store.selectPath(store.fileKey(files[0])); await flush()
  expect(store.state.hunkMap.get(store.fileKey(store.selectedFile()))?.[0]?.lines).toEqual(['-old-a.ts'])
})

test('an inactive last-turn review keeps a new conversation’s requested historical turn and absolute repository path', async () => {
  currentSession = 'historical-owner'
  store.state.sessionId = 'previous-owner'
  store.state.source = 'last-turn'
  summaryReply = async (_id, options) => ({ ...result(options, [
    { repositoryRoot: '/a', path: 'shared.ts', snapshotId: 'a' },
    { repositoryRoot: '/b', path: 'shared.ts', snapshotId: 'b' },
  ]), repositoryRoot: null, turnId: options.turnId })
  detailReply = async (_id, path) => ({ ok: true, files: [{ path, hunks: [] }] })
  store.openTurnChanges('older-turn', '/b/shared.ts'); await flush()
  expect(store.state.requestedTurnId).toBe('older-turn')
  expect(store.state.summary?.turnId).toBe('older-turn')
  expect(store.selectedFile()?.repositoryRoot).toBe('/b')
  expect(summaries.at(-1)[1].turnId).toBe('older-turn')
})
test('a child checkout review does not change the chat and a later chat switch clears its ownership', async () => {
  currentSession = 'parent-chat'
  summaryReply = async (_id, options) => result(options, [{ path: 'file.ts', repositoryRoot: '/a', snapshotId: 'child' }])
  store.show({ source: 'branch', sessionId: 'child-checkout', repositoryRoot: '/a' }); await flush()
  expect(store.state.sessionId).toBe('child-checkout')
  expect(currentSession).toBe('parent-chat')
  currentSession = 'next-chat'; await store.reload(true)
  expect(store.state.sessionId).toBe('next-chat')
  expect(store.state.reviewSessionId).toBeNull()
})
test('unchanged refresh retains all loaded files and a changed viewed revision reopens only that file', async () => {
  currentSession = 'refresh-owner'
  let revision = 'one'
  summaryReply = async (_id, options) => result(options, [
    { path: 'first.ts', repositoryRoot: '/a', snapshotId: revision },
    { path: 'second.ts', repositoryRoot: '/a', snapshotId: 'stable' },
  ])
  detailReply = async (_id, path) => ({ ok: true, files: [{ path, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }] })
  store.show({ source: 'branch', sessionId: currentSession }); await flush()
  await store.loadFileHunks(store.allFiles()[1])
  const second = store.state.hunkMap.get(store.fileKey(store.allFiles()[1]))
  store.toggleViewed(store.allFiles()[0])
  await store.reload(true); await flush()
  expect(store.state.hunkMap.get(store.fileKey(store.allFiles()[1]))).toBe(second)
  expect(store.isViewed(store.allFiles()[0])).toBe(true)
  revision = 'two'; await store.reload(true); await flush()
  expect(store.isViewed(store.allFiles()[0])).toBe(false)
  expect(store.state.collapsedPaths.has(store.fileKey(store.allFiles()[0]))).toBe(false)
})
test('a detail reply for a different file cannot populate the selected file cache', async () => {
  currentSession = 'detail-owner'
  summaryReply = async (_id, options) => result(options, [{ path: 'selected.ts', repositoryRoot: '/a', snapshotId: 'selected' }])
  detailReply = async () => ({ ok: true, files: [{ path: 'unrelated.ts', hunks: [{ lines: ['+wrong'] }] }] })
  store.show({ source: 'branch', sessionId: currentSession }); await flush()
  const key = store.fileKey(store.selectedFile())
  expect(store.state.hunkMap.has(key)).toBe(false)
  expect(store.state.hunkErrors.has(key)).toBe(true)
})

test('commit generation and confirmation cannot cross comparison ownership or open duplicate flows', async () => {
  currentSession = 'commit-owner'
  summaryReply = async (_id, options) => result(options, [{ repositoryRoot: '/a', path: 'file.ts', snapshotId: 'commit-file' }])
  store.show({ source: 'uncommitted', sessionId: currentSession }); await flush()
  const win = (globalThis as any).window, commits: any[] = [], prompts: any[] = []
  let finishGeneration!: (value: any) => void
  win.klaus.diff.generateCommitMessage = () => new Promise(resolve => { finishGeneration = resolve })
  win.klaus.diff.commit = (...args: any[]) => { commits.push(args); return Promise.resolve({ ok: true }) }
  win.klausDialog = { prompt: (value: any) => { prompts.push(value); return Promise.resolve('message') }, alert: () => Promise.resolve() }
  const first = store.startCommitFlow(); await flush()
  expect(store.state.committing).toBe(true)
  await store.startCommitFlow()
  store.setSource('unstaged'); await flush()
  finishGeneration({ ok: true, message: 'Captured comparison' }); await first
  expect(prompts).toHaveLength(0); expect(commits).toHaveLength(0)
  expect(store.state.committing).toBe(false)
  win.klaus.diff.generateCommitMessage = () => Promise.resolve({ ok: true, message: 'same owner' })
  let confirm!: (value: string) => void
  win.klausDialog.prompt = () => new Promise(resolve => { confirm = resolve })
  const second = store.startCommitFlow(); await flush()
  currentSession = 'another-commit-owner'; await store.reload(true)
  confirm('Do not commit after navigation'); await second
  expect(commits).toHaveLength(0); expect(store.state.committing).toBe(false)
})
