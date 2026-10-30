// DOM harness entry for the citation line-jump: the real workspace panel opens
// a cited file and must land the source view on the cited line. The panel
// module grabs its DOM nodes at load, so the page provides the panel skeleton
// and the host bridge stub before the bundle runs.
const w = window as any
w.currentLang = 'en'
w.currentSessionId = 's1'
const LINES = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
w.klaus = {
  artifacts: {
    authorizePreview: async (_sessionId: string, path: string) => ({ ok: true, filePath: path }),
    read: async () => ({ ok: true, content: LINES, binary: false, readonly: false, encoding: 'utf-8', truncated: false }),
    fileUrl: async () => ({ ok: true, url: '' }),
  },
  settings: { kv: { get: async () => null } },
}

import 'klaus-styles'
import { initWorkspacePanel, openWorkspaceFilePath } from 'klaus-workspace-panel'

initWorkspacePanel({
  ensureSession: async () => 's1',
  draftProjectWorkdir: () => null,
  inputEl: () => document.createElement('textarea'),
  addWorkspaceComposerMention: () => {},
  rememberWorkspaceRoot: () => {},
  closeSessionContextMenu: () => {},
  hideBtwPanel: () => {},
  setCurrentNonChatView: () => {},
  openArtifactsPanel: () => {},
  setArtifactsPanelMode: () => {},
  syncArtifactsToggleVisibility: () => {},
  syncTopModeButtons: () => {},
  renderSessionList: () => {},
  artifactsPanel: () => document.getElementById('artifacts-panel'),
  artifactsList: () => document.getElementById('artifacts-list'),
})

const results: Record<string, unknown> = {}
openWorkspaceFilePath('/abs/app.ts', { line: 40 })
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
void (async () => {
  const body = document.getElementById('workspace-file-body')!
  const elements = (root: Element | ShadowRoot): Element[] => [...root.querySelectorAll('*')].flatMap(element => [element, ...element.shadowRoot ? elements(element.shadowRoot) : []])
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((body.firstElementChild?.scrollTop ?? 0) > 100 && elements(body).some(element => element.getAttribute('contenteditable') === 'true')) break
    await settle(25)
  }
  const scroller = body.firstElementChild as HTMLElement | null
  const text = elements(body).filter(element => !element.children.length && !['STYLE', 'SCRIPT'].includes(element.tagName)).map(element => element.textContent).join('\n')
  results.renderedLines = (text.match(/line \d+/g) || []).length
  results.bodyScrollTop = Math.round(scroller?.scrollTop ?? 0)
  results.bodyClientHeight = scroller?.clientHeight ?? 0
  results.bodyScrollHeight = scroller?.scrollHeight ?? 0
  results.shellHidden = document.getElementById('workspace-file-shell')?.hasAttribute('hidden') ?? null
  results.mainViewDisplay = getComputedStyle(document.getElementById('workspace-main-view')!).display
  results.scrolled = (scroller?.scrollTop ?? 0) > 100
  const pre = document.createElement('pre')
  pre.id = 'measure-result'
  pre.textContent = JSON.stringify(results)
  document.body.appendChild(pre)
})()
