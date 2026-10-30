import { createRoot } from 'react-dom/client'
import { createTwoFilesPatch, structuredPatch } from 'diff'
import { DiffPage } from './DiffPage'
import { ChangesCapsule, ChangesEntry } from './changes-summary'
import * as changes from './store'
import type { DiffOptions } from '../../../../contracts/git-changes'

const mainRepository = '/fixture/project', worktreeRepository = '/fixture/worktrees/topic/project'
const repositories = [{ root: mainRepository, name: 'project' }, { root: worktreeRepository, name: 'topic/project' }]
const headRevision = '2222222222222222222222222222222222222222', baseRevision = '1111111111111111111111111111111111111111'
const commit = { sha: headRevision, subject: 'Update review settings' }
const requests: any[] = [], listeners = new Set<(event: any) => void>(), toasts: string[] = []
let sessionId = 'changes-fixture-0', sessionCount = 0, revision = 0, scenario = 'normal', failSummary = false
let clipboard = '', composer = '', deferred: ((value: any) => void) | undefined
const w = window as any
w.currentLang = 'en'
w.getCurrentSessionId = () => sessionId
w.showToast = (text: string) => toasts.push(text)
w.klausComposer = { appendReviewFeedback(text: string, owner: string) { if (owner !== sessionId) return false; composer += text; return true } }
w.klausOpenWorkspaceFilePath = (path: string) => requests.push({ operation: 'internal-open', path })
const before = '{\n' + Array.from({ length: 155 }, (_, index) => `  "setting${index}": "value${index}"${index === 154 ? '' : ','}`).join('\n') + '\n}\n'
const after = before.replace('"setting125": "value125"', `"setting125": "updated${revision}"`) + ''
function definitions(options: DiffOptions = {}) {
  const root = options.repositoryRoot ?? mainRepository
  if (options.source === 'last-turn' && options.turnId === 'active-turn' && scenario === 'capsule-net-zero') return []
  if (options.source === 'last-turn' && options.turnId === 'active-turn') return [{ repositoryRoot: mainRepository, path: 'new.txt', before: '', after: 'untracked content first line\nuntracked content second line', isUntracked: true }]
  if (options.source === 'last-turn') return [
    { repositoryRoot: mainRepository, path: 'shared.ts', entryId: 'first-repository', before: 'const value = 1\n', after: 'const value = 2\n' },
    { repositoryRoot: worktreeRepository, path: 'shared.ts', entryId: 'second-repository', before: '', after: 'const worktree = true\n' },
  ]
  const normal = [
    { repositoryRoot: root, path: 'apps/desktop/contracts/vectors/runtime-settings.json', before, after: after.replace('updated0', 'updated' + revision) },
    { repositoryRoot: root, path: 'apps/desktop/frontend/src/chat/review.ts', before: 'import { oldName } from "./source"\n\nexport const stable = true\n', after: 'import { newName } from "./source"\n\nexport const stable = true\n' },
    { repositoryRoot: root, path: 'new.txt', before: '', after: 'untracked content first line\nuntracked content second line', isUntracked: true },
    { repositoryRoot: root, path: 'picture.bin', before: '', after: '', isBinary: true },
  ]
  if (scenario === 'navigation') return normal.map((file, index) => index === 0 ? { ...file, after: before.replaceAll('value', 'updated') } : file)
  if (scenario === 'gitlink') return [{ repositoryRoot: root, path: 'nested', before: `Subproject commit ${baseRevision}\n`, after: `Subproject commit ${headRevision}\n`, isGitlink: true }]
  if (scenario === 'media') return [
    { repositoryRoot: root, path: 'image.png', before: '', after: '', isBinary: true, media: 'image/png' },
    { repositoryRoot: root, path: 'document.pdf', before: '', after: '', isBinary: true, media: 'application/pdf' },
  ]
  if (scenario === 'empty') return []
  if (scenario === 'unavailable') return [{ ...normal[0], patchUnavailable: true }]
  if (scenario === 'markdown') return [{ repositoryRoot: root, path: 'notes.md', before: '# Before\n\nAn older paragraph.\n', after: '# After\n\nA changed paragraph.\n' }]
  if (scenario === 'rename') return [{ repositoryRoot: root, path: 'renamed.txt', previousPath: 'original.txt', before: 'same\n', after: 'same\n' }]
  if (scenario === 'generated') return [...normal, { repositoryRoot: root, path: 'generated/output.ts', before: '', after: 'export const generated = true\n', isGenerated: true }]
  return normal
}
function counts(file: any) {
  const patch = structuredPatch('before', 'after', file.before, file.after, '', '', { context: 3 })
  return file.isBinary ? { additions: null, deletions: null } : {
    additions: patch.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith('+')).length, 0),
    deletions: patch.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith('-')).length, 0),
  }
}
function summary(options: DiffOptions = {}, id = sessionId) {
  const source = options.source ?? 'branch', root = options.repositoryRoot ?? mainRepository
  const files = definitions(options).map(({ before: _old, after: _new, ...file }) => ({ ...file, ...counts({ ...file, before: _old, after: _new }), snapshotId: `${id}:${source}:${file.repositoryRoot}:${file.path}:${revision}` }))
  const sum = (key: 'additions' | 'deletions') => files.some(file => file[key] === null) ? null : files.reduce((total, file) => total + (file[key] ?? 0), 0)
  return { ok: true, isGit: scenario !== 'plain', root: scenario === 'remote' ? 'ssh://fixture/workspace' : root,
    repositoryRoot: source === 'last-turn' ? null : root, repositories, source, currentBranch: 'main',
    defaultBaseBranch: 'origin/main', baseBranches: ['refs/remotes/origin/main', 'origin/main', 'main', 'refs/remotes/upstream/main'],
    commits: [commit], canCommit: false, snapshotId: `all:${id}:${source}:${revision}`, transient: scenario === 'transient',
    turnId: source === 'last-turn' ? options.turnId ?? 'turn-7' : null,
    comparison: source === 'last-turn' ? { type: 'last-turn', turnId: options.turnId ?? 'turn-7' }
      : scenario === 'no-base' ? { type: 'expected', reason: 'default_branch_unavailable' }
      : { type: 'success', baseBranch: options.baseBranch ?? 'origin/main', baseRevision, headRevision },
    detailsTruncated: scenario === 'truncated', stats: { filesCount: files.length, linesAdded: sum('additions'), linesRemoved: sum('deletions') }, files }
}
w.klaus = { diff: {
  async summary(id: string, options: DiffOptions) {
    requests.push({ operation: 'summary', sessionId: id, options: structuredClone(options) })
    if (scenario === 'capsule-summary-error' && options.turnId === 'active-turn') return { ok: false, error: 'Recorded changes unavailable' }
    if (failSummary) { failSummary = false; return { ok: false, error: 'Fixture summary failed' } }
    if (scenario === 'deferred' && id === 'delayed-session') return new Promise(resolve => { deferred = resolve })
    return summary(options, id)
  },
  async hunks(id: string, path: string, options: DiffOptions) {
    requests.push({ operation: 'hunks', sessionId: id, path, options: structuredClone(options) })
    const file: any = definitions(options).find(file => file.path === path && file.repositoryRoot === options.repositoryRoot)
    if (!file) return { ok: false, error: 'Fixture file not found' }
    if (scenario === 'hunk-error') return { ok: false, error: 'Fixture patch failed' }
    const patch = file.isGitlink ? `diff --git a/${path} b/${path}\nindex ${baseRevision}..${headRevision} 160000\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-Subproject commit ${baseRevision}\n+Subproject commit ${headRevision}\n`
      : file.previousPath && file.before === file.after ? `diff --git a/${file.previousPath} b/${file.path}\nsimilarity index 100%\nrename from ${file.previousPath}\nrename to ${file.path}\n`
      : createTwoFilesPatch(file.before === '' ? '/dev/null' : 'a/' + (file.previousPath ?? path), file.after === '' ? '/dev/null' : 'b/' + path, file.before, file.after)
    return { ok: true, files: [{ path, repositoryRoot: options.repositoryRoot, patch,
      hunks: structuredPatch('before', 'after', file.before, file.after, '', '', { context: 3 }).hunks,
      ...(options.includeContents ? scenario === 'partial' ? { contentsUnavailable: 'unavailable' }
        : file.media ? { oldDataUrl: mediaDataUrl(file.media), newDataUrl: mediaDataUrl(file.media), contentsUnavailable: 'binary' } : { oldContent: file.before, newContent: file.after } : {}) }] }
  },
  async open(id: string, path: string, options: DiffOptions) { requests.push({ operation: 'open', sessionId: id, path, options }); return { ok: true } },
  async reveal(id: string, path: string, options: DiffOptions) { requests.push({ operation: 'reveal', sessionId: id, path, options }); return { ok: true } },
  async applyReviewAction(id: string, action: string, options: any) { requests.push({ operation: 'mutation', sessionId: id, action, options }); return { ok: true } },
}, clipboard: { async writeText(text: string) { clipboard = text } }, on: { chatEvent(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener) } } }
function mediaDataUrl(mime: string) {
  if (mime === 'image/png') return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfcAAAAASUVORK5CYII='
  const stream = 'BT /F1 18 Tf 20 100 Td (Recorded review preview) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return 'data:application/pdf;base64,' + btoa(pdf)
}
const root = createRoot(document.getElementById('diff-view-content')!)
root.render(<DiffPage />)
const capsuleRoot = createRoot(document.getElementById('changes-capsule-fixture')!)
const entryRoot = createRoot(document.getElementById('changes-entry-fixture')!)
function renderEntries() {
  capsuleRoot.render(<ChangesCapsule sessionId={sessionId} turn={{ turnId: 'active-turn', files: [{ path: '/fixture/project/new.txt', relativePath: 'new.txt', name: 'new.txt', kind: 'create', added: 2, removed: 0, turnDiff: createTwoFilesPatch('before', 'after', '', 'untracked content first line\nuntracked content second line') }], added: 2, removed: 0 }} />)
  entryRoot.render(<ChangesEntry sessionId="child-session" />)
}
changes.installDiffViewProtocol()
async function frames(count = 4) { for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame) }
async function settled() {
  for (let index = 0; index < 240; index++) {
    await frames(2)
    if (!changes.state.loading && !changes.state.loadingPaths.size) { await frames(6); return snapshot() }
  }
  throw new Error('Changes renderer did not settle')
}
function deepText(element: Element | ShadowRoot): string {
  return Array.from(element.childNodes).map(child => {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent ?? ''
    if (!(child instanceof Element) || ['STYLE', 'SCRIPT', 'svg', 'SVG'].includes(child.tagName)) return ''
    return deepText(child) + (child.shadowRoot ? deepText(child.shadowRoot) : '')
  }).join('\n')
}

function snapshot() {
  return { sessionId, reviewSessionId: changes.state.sessionId, source: changes.state.source, repositoryRoot: changes.state.repositoryRoot,
    baseBranch: changes.state.baseBranch, turnId: changes.state.requestedTurnId, selectedPath: changes.state.selectedPath,
    text: deepText(document.getElementById('diff-view')!),
    rows: Array.from(document.querySelectorAll<HTMLButtonElement>('#diff-panel-file-list [role="treeitem"][data-directory="false"]')).map(button => ({ text: button.innerText, key: button.dataset.treeKey })),
    requests: structuredClone(requests), hunkCacheKeys: [...changes.state.hunkMap.keys()], detailKeys: [...changes.state.detailMap.keys()],
    forbiddenAttributes: Array.from(document.querySelectorAll('#diff-view [title],#diff-view [data-klaus-tip]')).map(element => element.outerHTML),
    viewport: { width: innerWidth, height: innerHeight }, preferences: { ...changes.reviewPreferences },
    fileStates: Array.from(document.querySelectorAll<HTMLElement>('[data-file-key]')).map(node => ({ key: node.dataset.fileKey, collapsed: node.dataset.collapsed, viewed: node.dataset.viewed })),
    nativeDiffs: Array.from(document.querySelectorAll('diffs-container')).map(element => ({ text: element.shadowRoot ? deepText(element.shadowRoot) : '', html: element.shadowRoot?.innerHTML.slice(-16000) })),
    clipboard, composer, toasts: [...toasts],
    bodyOverflow: document.documentElement.scrollWidth > innerWidth,
  }
}
function button(label: string, root: ParentNode = document) {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label)
  if (!found) throw new Error('Missing Changes button: ' + label)
  return found
}
async function click(label: string) { button(label).click(); return settled() }
async function menu(label: string, item?: string) {
  button(label).click(); await frames(3)
  if (item) {
    const target = Array.from(document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')).find(element => element.textContent?.trim() === item)
    if (!target) throw new Error('Missing Changes menu item: ' + item)
    target.click(); return settled()
  }
  return snapshot()
}
async function selectControl(label: string, value: string) {
  if (label === 'Scope') {
    if (value === 'commit') { changes.setSource('commit'); return settled() }
    const labels: any = { branch: 'Branch', uncommitted: 'Uncommitted', staged: 'Staged', unstaged: 'Unstaged', 'last-turn': 'Last turn' }
    return menu('Scope', labels[value])
  }
  if (label === 'Repository') return menu(label, repositories.find(repo => repo.root === value)?.name)
  if (label === 'Base branch') {
    return menu(label, value === '' ? 'origin/main (automatic)' : value.startsWith('refs/remotes/') ? value.slice(13) : value + ' (local)')
  }
  throw new Error('Unknown Changes control: ' + label)
}
async function reset(nextScenario = 'normal') {
  sessionId = `changes-fixture-${++sessionCount}`; scenario = nextScenario; revision = 0
  requests.length = 0; toasts.length = 0; clipboard = ''; composer = ''; failSummary = nextScenario === 'summary-error'
  localStorage.clear()
  Object.assign(changes.reviewPreferences, { layout: 'auto', wordWrap: false, fileTree: true, wordDiffs: true, showGenerated: true, fullFiles: false, richPreview: true, hideWhitespace: false, hideImports: false })
  changes.show({ source: 'branch', sessionId }); renderEntries(); return settled()
}
async function input(label: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"],textarea[aria-label="${label}"]`)
  if (!element) throw new Error('Missing Changes input: ' + label)
  const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true })); await frames(4); return snapshot()
}
w.changesFixture = { reset, settled, snapshot, selectControl, frames, click, menu, input, button,
  roots: { mainRepository, worktreeRepository },
  async selectRow(index: number) { const row = document.querySelectorAll<HTMLButtonElement>('#diff-panel-file-list [data-directory="false"]')[index]; if (!row) throw new Error('Missing file row'); row.click(); return settled() },
  async theme(value: 'light' | 'dark') { document.documentElement.dataset.theme = value; await frames(8); return snapshot() },
  async customBase(value: string) { await menu('Base branch'); await input('Specify reference', value); document.querySelector<HTMLFormElement>('[role="menu"] form')!.requestSubmit(); return settled() },
  async refreshSame() { await changes.reload(true); return settled() },
  async refreshRevision() { revision++; await changes.reload(true); return settled() },
  async emit(type: string) { for (const listener of listeners) listener({ sessionId, type }); await new Promise(resolve => setTimeout(resolve, 300)); return settled() },
  async capsule() { return click('Review this turn’s changes') },
  async showTurn(turnId: string, path: string, owner?: string) { changes.openTurnChanges(turnId, path, owner); return settled() },
  async race() {
    scenario = 'deferred'; sessionId = 'delayed-session'; const pending = changes.reload(true)
    await frames(2); sessionId = 'current-session'; await changes.reload(true); deferred?.(summary({ source: 'branch' }, 'delayed-session')); await pending
    return settled()
  },
  async selectLine(line: number) {
    const host = document.querySelector('diffs-container')!
    const shadow = host.shadowRoot!
    const node = Array.from(shadow.querySelectorAll<HTMLElement>('[data-line]')).find(node => node.dataset.line === String(line))
    return { html: shadow.innerHTML.slice(-20000), found: Boolean(node) }
  },
}
void reset()
