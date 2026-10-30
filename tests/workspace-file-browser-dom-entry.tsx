import { initWorkspacePanel, loadWorkspace, showWorkspaceMainView, setWorkspaceRoot, openWorkspaceFilePath } from '../frontend/src/chat/workspace-panel'
import { setLanguage } from '../frontend/src/app/i18n'
import { searchNodes } from '../frontend/src/chat/workspace-file-tree'

const root = '/workspace'
const calls: { kind: string; path?: string; query?: string; session?: string | null }[] = []
let delay = 0
let directoryError = false
let searchError = false
let renamed = ''
let duplicateRoots = false
const dir = (name: string) => ({ name, path: `${root}/${name}`, isDir: true, children: [], childrenLoaded: false })
const file = (name: string) => ({ name, path: `${root}/${name}`, isDir: false })
const names = ['.git', '.klaus', '.pytest_cache', '.qoder', 'apps', 'content', 'dist', 'docker', 'docs', 'engine', 'hyperframes', 'node_modules', 'public', 'release', 'resources', 'scripts', 'src']
const files = ['.DS_Store', '.gitattributes', '.gitignore', '.gitmodules', 'AGENTS.md', 'design-qa.md', 'dev.bat', 'dev.sh', 'docker-compose.yml', 'drizzle.config.ts', 'fix_css.cjs', 'fix_css.js', 'KLAUS.md', 'package-lock.json', 'package.json', 'rust-toolchain.toml', 'tsconfig.json', 'tsconfig.portal-islands.json', 'tsup.config.ts']
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const api = {
  workspace: {
    list: async (session: string | null, path?: string) => {
      calls.push({ kind: 'list', path, session })
      const ownDelay = delay
      if (ownDelay) await wait(ownDelay)
      if (session === 'other') return { root: '/other', tree: [{ name: 'other.md', path: '/other/other.md', isDir: false }] }
      if (path && directoryError) throw new Error('Directory read failed')
      return { root, roots: duplicateRoots ? [root, '/other/src'] : [root], tree: path ? [
        { name: renamed || 'nested.ts', path: `${path}/${renamed || 'nested.ts'}`, isDir: false },
        { name: 'deep', path: `${path}/deep`, isDir: true, children: [], childrenLoaded: false },
      ] : [...names.map(dir), ...(duplicateRoots ? [{ name: 'src', path: '/other/src', isDir: true, children: [], childrenLoaded: false }] : []), ...files.map(file)] }
    },
    rename: async (session: string, path: string, name: string) => {
      calls.push({ kind: 'rename', path, query: name, session }); renamed = name
      return { ok: true, path: path.slice(0, path.lastIndexOf('/') + 1) + name }
    },
    open: async () => ({ ok: true }), reveal: async () => ({ ok: true }),
    delete: async () => ({ ok: true }), write: async (session: string, path: string, content: string) => { calls.push({ kind: 'write', session, path, query: content }); return { ok: true } },
    search: async (session: string, query: string) => {
      const hits = await api.engine.workspaceFileSearch(session, query)
      return { hits, truncated: false }
    },
  },
  artifacts: {
    authorizePreview: async (_session: string, path: string) => {
      const canonical = path === '/external/report-alias.html' ? '/canonical/report.html' : path
      calls.push({ kind: 'authorize-preview', path, query: canonical })
      return { ok: true, filePath: canonical }
    },
    read: async (_session: string, path: string) => {
      if (!calls.some(call => call.kind === 'authorize-preview' && call.query === path)) throw new Error('Preview was not authorized')
      calls.push({ kind: 'read-preview', path })
      return { content: `File: ${path}\nconst value = 1\n`, readonly: !path.startsWith('/workspace/') }
    },
    fileUrl: async (_session: string, path: string) => {
      calls.push({ kind: 'preview-url', path })
      return { ok: true, url: path === '/canonical/report.html' ? 'data:text/html,<h1>External report</h1>' : '' }
    },
  },
  engine: { workspaceFileSearch: async (session: string, query: string) => {
    calls.push({ kind: 'search', query, session })
    await wait(query === 'slow' ? 350 : 15)
    if (searchError) throw new Error('Search unavailable')
    if (query === 'absent') return []
    return [{ rel: query === 'slow' ? 'src/stale.ts' : 'apps/desktop/frontend/src/match.ts', name: 'match.ts', isDir: false }]
  } },
}
Object.assign(window, { klaus: api, currentSessionId: 'files', klausDialog: { alert: async () => {}, confirm: async () => true } })
setLanguage('zh')
initWorkspacePanel({
  ensureSession: async () => 'files', draftProjectWorkdir: () => root,
  inputEl: () => document.querySelector('textarea')!, addWorkspaceComposerMention: () => {},
  rememberWorkspaceRoot: (session, path) => { if (typeof path === 'string') setWorkspaceRoot(session, path) },
  closeSessionContextMenu: () => {}, hideBtwPanel: () => {}, setCurrentNonChatView: () => {},
  openArtifactsPanel: () => {}, setArtifactsPanelMode: () => {}, syncArtifactsToggleVisibility: () => {},
  syncTopModeButtons: () => {}, renderSessionList: () => {},
  artifactsPanel: () => document.getElementById('artifacts-panel'), artifactsList: () => document.getElementById('artifacts-list'),
})
const shadow = () => document.querySelector('file-tree-container')?.shadowRoot
const rows = () => [...shadow()?.querySelectorAll<HTMLElement>('[role=treeitem]') || []]
const rowPath = (row: HTMLElement) => (row.dataset.itemPath || '').replace(/^f::/, '').replace(/\/$/, '')
Object.assign(window, { fileBrowserFixture: {
  calls, load: loadWorkspace, open: openWorkspaceFilePath,
  show: showWorkspaceMainView,
  rows: () => rows().map(row => ({ path: rowPath(row), text: row.textContent, selected: row.getAttribute('aria-selected'), expanded: row.getAttribute('aria-expanded'), height: row.getBoundingClientRect().height, svg: row.querySelectorAll('svg').length })),
  click: (path: string) => rows().find(row => rowPath(row) === path)?.click(),
  doubleClick: (path: string) => rows().find(row => rowPath(row) === path)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true })),
  context: (path: string) => rows().find(row => rowPath(row) === path)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 1300, clientY: 300 })),
  key: (key: string) => shadow()?.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true })),
  focus: (path: string) => rows().find(row => rowPath(row) === path)?.focus(),
  filter: (query: string) => { const input = document.querySelector<HTMLInputElement>('.workspace-tree-filter input')!; input.value = query; input.dispatchEvent(new Event('input', { bubbles: true })) },
  setDelay: (value: number) => { delay = value }, setDirectoryError: (value: boolean) => { directoryError = value }, setSearchError: (value: boolean) => { searchError = value },
  setDuplicateRoots: (value: boolean) => { duplicateRoots = value },
  modelCases: () => ({
    filesystemRoot: searchNodes([{ rel: '/usr/local/readme.md', name: 'readme.md', isDir: false }], '/', ['/']),
    extraRoot: searchNodes([{ rel: '/other/empty', name: 'empty', isDir: true }], root, ['/other/empty']),
    traversal: searchNodes([{ rel: '../private.txt', name: 'private.txt', isDir: false }], root, [root]),
  }),
  switch: async (session: string) => { (window as any).currentSessionId = session; await loadWorkspace(session); showWorkspaceMainView({ openPanel: false }) },
  shadow,
} })
void loadWorkspace('files').then(() => showWorkspaceMainView({ openPanel: false }))
