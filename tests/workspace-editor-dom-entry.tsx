import 'katex/dist/katex.min.css'
import { EditorView } from '@codemirror/view'
import vectors from '../contracts/vectors/document-editor-vectors.json'

const w = window as any
w.currentLang = 'en'
w.currentSessionId = 's1'
type DiskFile = { content: string; mtimeMs: number }
const disk = new Map<string, DiskFile>([
  ['s1:/fixture/document.md', { content: vectors.fixture, mtimeMs: 1 }],
  ['s1:/fixture/next.md', { content: '# Another document\n\nAnother tab.', mtimeMs: 1 }],
  ['s2:/fixture/document.md', { content: '# Other session\n', mtimeMs: 1 }],
])
const writes: Array<{ sessionId: string; path: string; content: string }> = []
let failNext = false
let writePause: (() => void) | undefined
let pauseNext = false
let pauseReadNext = false
let completeRead: (() => void) | undefined
w.klaus = {
  settings: { kv: { get: async () => null } },
  app: { openExternal: async () => {} },
  workspace: {
    list: async () => ({ root: '/fixture', tree: [] }),
    write: async (sessionId: string, path: string, content: string, options?: { expectedMtimeMs?: number | null }) => {
      const key = `${sessionId}:${path}`
      if (pauseNext) { pauseNext = false; await new Promise<void>(resolve => { writePause = resolve }) }
      if (failNext) { failNext = false; return { ok: false, error: 'Simulated write failure' } }
      const saved = disk.get(key)!
      if (options?.expectedMtimeMs != null && options.expectedMtimeMs !== saved.mtimeMs) return { ok: false, conflict: true, content: saved.content, mtimeMs: saved.mtimeMs }
      writes.push({ sessionId, path, content })
      const next = { content, mtimeMs: saved.mtimeMs + 1 }
      disk.set(key, next)
      return { ok: true, mtimeMs: next.mtimeMs }
    },
  },
  artifacts: {
    authorizePreview: async (_sessionId: string, path: string) => ({ ok: true, filePath: path }),
    read: async (sessionId: string, path: string) => {
      const result = { ok: true, ...disk.get(`${sessionId}:${path}`), binary: false, readonly: false, encoding: 'utf-8', truncated: false }
      if (pauseReadNext) { pauseReadNext = false; await new Promise<void>(resolve => { completeRead = resolve }) }
      return result
    },
    fileUrl: async () => ({ ok: true, url: '' }),
  },
}

const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => unknown, label: string, timeout = 12000) {
  const start = Date.now()
  while (!check()) { if (Date.now() - start > timeout) throw Error(`Timed out: ${label}`); await settle() }
}
const body = () => document.getElementById('workspace-file-body')!
const view = () => EditorView.findFromDOM(body().querySelector('.cm-editor') as HTMLElement)
const assert = (value: unknown, label: string) => { if (!value) throw Error(label); results.push(label) }
const results: string[] = []
async function nativeInput(request: { text?: string; undo?: boolean; capture?: string }): Promise<void> {
  await new Promise<void>(resolve => { w.workspaceNativeDone = resolve; w.workspaceNativeRequest = request })
  await settle(100)
}
function deepElements(root: Document | ShadowRoot | Element): Element[] {
  return Array.from(root.querySelectorAll('*')).flatMap(element => [element, ...element.shadowRoot ? deepElements(element.shadowRoot) : []])
}

async function run() {
  const panel = await import('../frontend/src/chat/workspace-panel')
  panel.initWorkspacePanel({
    ensureSession: async () => w.currentSessionId, draftProjectWorkdir: () => null, inputEl: () => document.createElement('textarea'),
    addWorkspaceComposerMention() {}, rememberWorkspaceRoot() {}, closeSessionContextMenu() {}, hideBtwPanel() {},
    setCurrentNonChatView() {}, openArtifactsPanel() {}, setArtifactsPanelMode() {}, syncArtifactsToggleVisibility() {},
    syncTopModeButtons() {}, renderSessionList() {}, artifactsPanel: () => document.getElementById('artifacts-panel'), artifactsList: () => document.getElementById('artifacts-list'),
  })
  panel.openWorkspaceFilePath('/fixture/document.md')
  await until(() => body().querySelector('.cm-editor'), 'default document editor')
  assert(body().querySelector('.cm-editor'), 'Markdown opens in the live document editor')
  assert(!body().querySelector('textarea'), 'No textarea overlay is used')
  const heading = Array.from(body().querySelectorAll('.cm-line span')).find(element => element.textContent === 'A document') as HTMLElement
  const link = body().querySelector('[data-markdown-href]') as HTMLElement
  assert(!!heading && getComputedStyle(heading).textDecorationLine === 'none', 'Document headings use heading typography without a link underline')
  const themeLink = document.createElement('span')
  themeLink.style.color = 'var(--theme-accent)'
  body().append(themeLink)
  const themeLinkColor = getComputedStyle(themeLink).color
  themeLink.remove()
  assert(getComputedStyle(link).color === themeLinkColor, 'Document links use the theme link color')
  const sourceButton = document.getElementById('workspace-file-view-source') as HTMLButtonElement
  assert(!sourceButton.hidden && sourceButton.textContent === 'View source', 'Source action is visible and labeled')
  await nativeInput({ capture: 'markdown-document' })
  const original = view()!
  original.dispatch({ changes: { from: original.state.doc.length, insert: '\nDocument edit' } })
  await until(() => writes.some(write => write.content.includes('Document edit')), 'automatic save', 7000)
  assert(writes[0]?.sessionId === 's1', 'Autosave writes to the document owner')
  sourceButton.click()
  await until(() => deepElements(body()).some(element => element.getAttribute('contenteditable') === 'true'), 'source editor')
  assert(!body().querySelector('.cm-editor'), 'Source view uses the dedicated code editor')
  assert(deepElements(body()).some(element => element.getAttribute('contenteditable') === 'true'), 'Source view is editable')
  const sourceInput = deepElements(body()).find(element => element.getAttribute('contenteditable') === 'true') as HTMLElement
  sourceInput.focus()
  await nativeInput({ text: 'Source edit', capture: 'markdown-source' })
  await until(() => writes.some(write => write.content.includes('Source edit')), 'source automatic save', 7000)
  assert(disk.get('s1:/fixture/document.md')!.content.includes('Source edit'), 'Typing in the source editor updates and automatically saves raw Markdown')
  const previewButton = document.getElementById('workspace-file-view-preview') as HTMLButtonElement
  assert(previewButton.textContent === 'View preview', 'Preview action is visible and labeled')
  previewButton.click()
  await until(() => body().querySelector('.cm-editor'), 'return to document')
  assert(view()!.state.sliceDoc().includes('Document edit') && view()!.state.sliceDoc().includes('Source edit'), 'Mode switching preserves edits from both representations')
  view()!.dispatch({ selection: { anchor: 3 } })
  sourceButton.click()
  await until(() => !body().querySelector('.cm-editor') && deepElements(body()).some(element => element.getAttribute('contenteditable') === 'true'), 'source again')
  panel.openWorkspaceFilePath('/fixture/next.md')
  await until(() => body().querySelector('.cm-editor') && view()!.state.sliceDoc().includes('Another tab'), 'another tab')
  panel.openWorkspaceFilePath('/fixture/document.md')
  await until(() => !body().querySelector('.cm-editor') && deepElements(body()).some(element => element.getAttribute('contenteditable') === 'true'), 'retained source view')
  assert(!previewButton.hidden, 'Each tab retains its selected mode')
  previewButton.click()
  await until(() => body().querySelector('.cm-editor'), 'restored document selection')
  assert(view()!.state.selection.main.anchor === 3, 'Document selection survives source mode and tab switches')
  failNext = true
  const failureView = view()!
  failureView.dispatch({ changes: { from: failureView.state.doc.length, insert: '\nRetry draft' } })
  sourceButton.click()
  await until(() => body().textContent?.includes('Retry draft') && document.body.textContent?.includes('Simulated write failure'), 'save failure notice')
  assert(body().querySelector('.cm-editor'), 'Failed save keeps the active editing mode')
  const retry = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Retry save')!
  retry.click()
  await until(() => writes.some(write => write.content.includes('Retry draft')), 'retry save')
  assert(view()!.state.sliceDoc().includes('Retry draft'), 'Retry preserves the full draft')
  pauseReadNext = true
  const staleRead = panel.loadWorkspaceFile('/fixture/document.md', { force: true })
  await until(() => completeRead, 'delayed background read')
  const latestView = view()!
  latestView.dispatch({ changes: { from: latestView.state.doc.length, insert: '\nSaved while reading' } })
  await until(() => writes.some(write => write.content.includes('Saved while reading')), 'save while reading', 7000)
  completeRead!()
  await staleRead
  assert(view()!.state.sliceDoc().includes('Saved while reading'), 'A delayed disk read cannot roll back a newer saved document')
  const key = 's1:/fixture/document.md'
  disk.set(key, { content: '# External change\n', mtimeMs: disk.get(key)!.mtimeMs + 1 })
  const conflictView = view()!
  conflictView.dispatch({ changes: { from: conflictView.state.doc.length, insert: '\nLocal conflict' } })
  sourceButton.click()
  await until(() => document.body.textContent?.includes('Choose which version'), 'conflict notice')
  assert(view()!.state.sliceDoc().includes('Local conflict'), 'External changes do not overwrite the draft')
  const keep = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Keep my changes')!
  keep.click()
  await until(() => disk.get(key)!.content.includes('Local conflict'), 'conflict resolution')
  pauseNext = true
  const ownerView = view()!
  ownerView.dispatch({ changes: { from: ownerView.state.doc.length, insert: '\nOwned draft' } })
  sourceButton.click()
  await until(() => writePause, 'pending write')
  panel.hideWorkspaceMainView()
  w.currentSessionId = 's2'
  panel.openWorkspaceFilePath('/fixture/document.md')
  writePause!()
  await until(() => body().querySelector('.cm-editor') && view()!.state.sliceDoc().includes('Other session'), 'second session')
  await until(() => disk.get(key)!.content.includes('Owned draft'), 'first session write')
  assert(disk.get('s2:/fixture/document.md')!.content === '# Other session\n', 'An in-flight save cannot write into another session')
  const { createSourceEditor } = await import('../frontend/src/chat/workspace-source-editor')
  const sourceHost = document.createElement('div')
  sourceHost.style.cssText = 'position:absolute;inset:0;width:900px;height:600px;background:var(--bg);z-index:1000'
  document.body.append(sourceHost)
  let sourceContent = Array.from({ length: 220 }, (_, index) => `Line ${index + 1}`).join('\n')
  let sourceChanges = 0
  let source = createSourceEditor({ parent: sourceHost, path: '/fixture/state.ts', content: sourceContent, readOnly: false,
    onChange(content) { sourceContent = content; sourceChanges++ }, onSave() {} })
  source.goToLine(90)
  await until(() => source.snapshot().state, 'source state ready')
  await until(() => (source.snapshot().state?.editor.selections?.[0]?.start.line ?? 0) === 89, 'pending source line selection').catch(error => { throw Error(error.message + ' ' + JSON.stringify(source.snapshot().state?.editor)) })
  assert(source.snapshot().state!.editor.selections![0].start.line === 89, 'A line jump requested before editor attachment is retained')
  await nativeInput({ text: 'State edit' })
  await until(() => sourceContent.includes('State edit'), 'source component input')
  source.goToLine(140)
  await settle(100)
  const sourceSnapshot = source.snapshot()
  const undoEntries = sourceSnapshot.state!.document.history.undoStack.length
  assert(undoEntries > 0, 'Source editor records native input in its undo history')
  assert(sourceSnapshot.scrollTop > 0, 'Source editor scrolls to requested lines')
  source.destroy()
  sourceContent = '// Shared edit\n' + sourceContent
  source = createSourceEditor({ parent: sourceHost, path: '/fixture/state.ts', content: sourceContent, readOnly: false,
    initialState: sourceSnapshot, onChange(content) { sourceContent = content; sourceChanges++ }, onSave() {} })
  await until(() => source.getContent() === sourceContent && source.snapshot().state, 'source retained state synchronization')
  assert(source.snapshot().state!.document.history.undoStack.length >= undoEntries, 'Source history survives edits in another representation')
  assert((source.snapshot().state!.editor.selections?.[0]?.start.line ?? 0) >= 139, 'Source caret survives a representation switch')
  source.setReadOnly(true)
  await settle(80)
  assert(source.getContent() === sourceContent && !!source.snapshot().state, 'Read-only transition keeps source content and history')
  const refreshedSource = '// External refresh\n' + sourceContent
  source.updateContent(refreshedSource)
  sourceContent = refreshedSource
  source.setReadOnly(false)
  await until(() => source.snapshot().state && deepElements(sourceHost).some(element => element.getAttribute('contenteditable') === 'true'), 'editable source restored')
  await until(() => source.getContent() === refreshedSource, 'read-only external update retained')
  assert(source.getContent() === refreshedSource, 'Read-only external updates survive resuming editing')
  assert(source.snapshot().state!.document.history.undoStack.length >= undoEntries, 'Editing resumes with retained undo history')
  assert(!deepElements(sourceHost).some(element => element.hasAttribute('title')), 'Source surface has accessible labels without hover titles')
  assert(sourceChanges === 1, 'Restoring source state does not emit stale content callbacks')
  source.destroy()
  sourceHost.remove()
  const { applyTheme } = await import('../frontend/src/app/i18n')
  applyTheme('dark')
  panel.openWorkspaceFilePath('/fixture/document.md')
  await until(() => body().querySelector('.cm-editor'), 'dark document')
  await nativeInput({ capture: 'markdown-dark' })
  assert(getComputedStyle(body().querySelector('.cm-editor')!).backgroundColor !== 'rgb(255, 255, 255)', 'Document editor follows the dark appearance')
  w.workspaceEditorResults = { passed: results.length, results, writes: writes.length }
}

w.workspaceEditorReady = run().catch(error => { w.workspaceEditorError = String(error?.stack ?? error); throw error })
