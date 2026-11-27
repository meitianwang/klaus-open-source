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
function fixtureMediaUrl() {
  const wav = new Uint8Array([
    82, 73, 70, 70, 38, 0, 0, 0, 87, 65, 86, 69,
    102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0,
    64, 31, 0, 0, 128, 62, 0, 0, 2, 0, 16, 0,
    100, 97, 116, 97, 2, 0, 0, 0, 0, 0,
  ])
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
}
const mediaUrls = new Map([['/fixture/clip.mp4', fixtureMediaUrl()]])
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
    fileUrl: async (_sessionId: string, path: string) => ({ ok: true, url: mediaUrls.get(path) ?? '' }),
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
async function nativeInput(request: { text?: string; undo?: boolean; capture?: string; drag?: { fromX: number; fromY: number; toX: number; toY: number } }): Promise<void> {
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
  const toc = body().querySelector('[data-markdown-toc]') as HTMLElement | null
  assert(!!toc && !toc.hidden, 'Rendered Markdown mounts a visible right-side table of contents')
  const editorRect = body().querySelector('.cm-editor')!.getBoundingClientRect()
  const tocRect = toc!.getBoundingClientRect()
  assert(tocRect.left >= editorRect.right - 2 && tocRect.width >= 140, 'Table of contents sits to the right of the document editor')
  const tocLabels = () => Array.from(body().querySelectorAll('[data-markdown-toc] ul button')).map(el => el.textContent)
  assert(JSON.stringify(tocLabels()) === JSON.stringify(['A document', 'Section one', 'Details']), 'Table of contents lists document headings and ignores code comments')
  assert(!toc!.querySelector('[title],[data-klaus-tip]'), 'Table of contents exposes no hover tooltip attributes')
  const tocButtons = Array.from(body().querySelectorAll<HTMLButtonElement>('[data-markdown-toc] ul button'))
  tocButtons[2].click()
  assert(tocButtons[2].getAttribute('aria-current') === 'location', 'Clicking a table of contents item activates it')
  const collapseToc = toc!.querySelector<HTMLButtonElement>('[data-toc-action="collapse"]')!
  collapseToc.click()
  assert(toc!.dataset.tocMode === 'compact', 'Table of contents collapses to compact right rail')
  const expandToc = toc!.querySelector<HTMLButtonElement>('[data-toc-action="expand"]')!
  expandToc.click()
  assert(toc!.dataset.tocMode === 'docked', 'Table of contents expands back to docked rail')
  const sourceButton = document.getElementById('workspace-file-view-source') as HTMLButtonElement
  assert(!sourceButton.hidden && sourceButton.textContent === 'View source', 'Source action is visible and labeled')
  await nativeInput({ capture: 'markdown-document' })
  const original = view()!
  original.focus()
  const docText = original.state.sliceDoc()
  for (const selection of [
    { anchor: docText.indexOf('formatted') + 2 },
    { anchor: docText.indexOf('local link') + 2 },
    { anchor: docText.indexOf('formatted'), head: docText.indexOf('local link') + 6 },
    { anchor: 0, head: docText.length },
  ]) {
    original.dispatch({ selection })
    await settle(20)
    const renderedText = original.contentDOM.textContent ?? ''
    assert(!renderedText.includes('**formatted**') && !renderedText.includes('](./next.md)') && !renderedText.includes('# A document') && !renderedText.includes('```typescript'),
      'Selecting or focusing Markdown content keeps syntax markers concealed in document view')
    assert(!!body().querySelector('[data-markdown-widget="table"] table') && !!body().querySelector('[data-markdown-widget="math"]'),
      'Selecting Markdown content keeps rendered table and math widgets intact')
  }
  const strongSpan = Array.from(body().querySelectorAll('.cm-line span')).find(element => element.textContent === 'formatted') as HTMLElement
  const strongRect = strongSpan.getBoundingClientRect()
  const linkRect = link.getBoundingClientRect()
  await nativeInput({
    drag: { fromX: strongRect.left + 2, fromY: strongRect.top + strongRect.height / 2, toX: linkRect.right - 2, toY: linkRect.top + linkRect.height / 2 },
    capture: 'markdown-selected',
  })
  assert(!original.state.selection.main.empty, 'Pointer drag creates a document text selection')
  assert(!(original.contentDOM.textContent ?? '').includes('**formatted**') && !(original.contentDOM.textContent ?? '').includes('](./next.md)'),
    'Pointer drag selection never exposes raw Markdown delimiters')
  const tableCell = body().querySelector('[data-markdown-widget="table"] td') as HTMLElement
  tableCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await settle(20)
  assert(!!body().querySelector('[data-markdown-widget="table"] table'), 'Pointer press inside a rendered table keeps the table widget rendered')
  const domSel = window.getSelection()!
  const cellRange = document.createRange()
  cellRange.selectNodeContents(tableCell)
  domSel.removeAllRanges()
  domSel.addRange(cellRange)
  const copiedTable = new DataTransfer()
  original.contentDOM.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: copiedTable }))
  assert(copiedTable.getData('text/plain').trim() === 'Example', 'Copying a selection inside a rendered table copies the selected cell text')
  domSel.removeAllRanges()
  original.dispatch({ selection: { anchor: original.state.doc.length } })
  original.dispatch({ changes: { from: original.state.doc.length, insert: '\nDocument edit' } })
  await until(() => writes.some(write => write.content.includes('Document edit')), 'automatic save', 7000)
  assert(writes[0]?.sessionId === 's1', 'Autosave writes to the document owner')
  sourceButton.click()
  await until(() => deepElements(body()).some(element => element.getAttribute('contenteditable') === 'true'), 'source editor')
  assert(!body().querySelector('.cm-editor'), 'Source view uses the dedicated code editor')
  assert(!body().querySelector('[data-markdown-toc]'), 'Source view hides the document table of contents')
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
  assert(!!body().querySelector('[data-markdown-toc]'), 'Returning to document view restores the table of contents')
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
  const longDoc = ['# Long Document', ...Array.from({ length: 45 }, (_, i) => `Paragraph line ${i + 1}`), '## Bottom Section', ...Array.from({ length: 30 }, (_, i) => `Trailing line ${i + 1}`)].join('\n\n')
  disk.set('s2:/fixture/long.md', { content: longDoc, mtimeMs: 1 })
  panel.openWorkspaceFilePath('/fixture/long.md')
  await until(() => body().querySelector('.cm-editor') && view()!.state.sliceDoc().includes('Bottom Section'), 'long document')
  const longScroller = body().querySelector('.cm-scroller') as HTMLElement
  longScroller.scrollTop = 0
  const bottomBtn = Array.from(body().querySelectorAll<HTMLButtonElement>('[data-markdown-toc] ul button')).find(b => b.textContent === 'Bottom Section')!
  bottomBtn.click()
  await until(() => longScroller.scrollTop > 100, 'table of contents click scrolls document')
  assert(bottomBtn.getAttribute('aria-current') === 'location', 'Clicked heading remains active after scrolling')
  const longView = view()!
  longView.dispatch({ changes: { from: longView.state.doc.length, insert: '\n\n## Added Live Heading\n' } })
  await until(() => Array.from(body().querySelectorAll('[data-markdown-toc] ul button')).some(b => b.textContent === 'Added Live Heading'), 'live edit updates table of contents')
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
  const clip = '/fixture/clip.mp4'
  w.currentSessionId = 's1'
  panel.openWorkspaceFilePath(clip)
  await panel.loadWorkspaceFile(clip)
  const video = () => body().querySelector('video')
  const initial = video()
  assert(initial instanceof HTMLVideoElement && initial.src === mediaUrls.get(clip), 'Video mounts with its capability URL')
  await settle(60)
  await until(() => initial?.readyState, 'video metadata')
  assert(initial?.error === null, 'Video fixture loads without a media error')
  await panel.loadWorkspaceFile(clip)
  assert(video() === initial, 'Loading a mounted video preserves the node')
  panel.showWorkspaceMainView({ openPanel: true })
  assert(video() === initial, 'Re-entering the Files panel preserves the video node')
  await panel.loadWorkspaceFile(clip, { force: true, reloadMedia: false })
  assert(video() === initial, 'Refreshing an unchanged capability preserves the video node')
  assert(!panel.shouldReloadWorkspaceFileForEvent({ type: 'workspace:changed', events: [{ path: '/fixture/other.ts' }] }, clip), 'Unrelated file changes do not reload the video')
  await panel.loadWorkspaceFile(clip, { force: true, reloadMedia: true })
  const replaced = video()
  assert(replaced instanceof HTMLVideoElement && replaced !== initial, 'Explicit media reload replaces the video node')
  mediaUrls.set(clip, fixtureMediaUrl())
  await panel.loadWorkspaceFile(clip, { force: true, reloadMedia: false })
  assert(video() !== replaced && video()?.src === mediaUrls.get(clip), 'A new capability URL replaces the video node')
  const htmlPath = '/fixture/page.html'
  mediaUrls.set(htmlPath, 'about:blank')
  disk.set(`s1:${htmlPath}`, { content: '<!doctype html><main>Preview page</main>', mtimeMs: 1 })
  panel.openWorkspaceFilePath(htmlPath)
  await panel.loadWorkspaceFile(htmlPath)
  await until(() => body().querySelector('iframe')?.getAttribute('src') === 'about:blank', 'html preview iframe')
  const initialFrame = body().querySelector('iframe')
  assert(initialFrame instanceof HTMLIFrameElement, 'HTML preview mounts an iframe')
  panel.showWorkspaceMainView({ openPanel: true })
  assert(body().querySelector('iframe') === initialFrame, 'Re-entering the Files panel preserves an unchanged HTML preview')
  await panel.loadWorkspaceFile(htmlPath, { force: true, reloadMedia: false })
  assert(body().querySelector('iframe') === initialFrame, 'Forced refresh without content changes preserves the HTML preview iframe')
  disk.set(`s1:${htmlPath}`, { content: '<!doctype html><main>Updated page</main>', mtimeMs: 2 })
  await panel.loadWorkspaceFile(htmlPath, { force: true, reloadMedia: false })
  await until(() => body().querySelector('iframe') && body().querySelector('iframe') !== initialFrame, 'updated html preview iframe')
  assert(body().querySelector('iframe') !== initialFrame, 'Changed HTML content replaces the preview iframe')
  const mixedDoc = [
    '# Scroll Stability Document',
    ...Array.from({ length: 18 }, (_, i) => `Section ${i + 1}: ${'Long wrapped narrative sentence for reading stability verification. '.repeat(6)}`),
    '| Column A | Column B |\n| --- | --- |\n| Alpha | Beta |\n| Gamma | Delta |',
    '```ts\nconst x = 1\nconst y = 2\n```',
    '---',
    ...Array.from({ length: 28 }, (_, i) => `Continuation ${i + 1}: ${'Detailed explanation paragraph below code and table blocks. '.repeat(6)}`),
  ].join('\n\n')
  disk.set('s1:/fixture/mixed-scroll.md', { content: mixedDoc, mtimeMs: 1 })
  panel.openWorkspaceFilePath('/fixture/mixed-scroll.md')
  await until(() => body().querySelector('.cm-editor') && view()!.state.sliceDoc().includes('Scroll Stability Document'), 'mixed scroll document')
  const mixedScroller = body().querySelector('.cm-scroller') as HTMLElement
  const mixedContent = body().querySelector('.cm-content') as HTMLElement
  const topVisibleLineText = () => {
    const scroller = body().querySelector('.cm-scroller') as HTMLElement
    const sr = scroller.getBoundingClientRect()
    const hit = Array.from(scroller.querySelectorAll<HTMLElement>('.cm-line')).find(el => {
      const r = el.getBoundingClientRect()
      return r.bottom > sr.top + 28 && el.textContent && el.textContent.trim().length > 8
    })
    return hit?.textContent?.slice(0, 32) ?? ''
  }
  for (let step = 0; step < 32; step++) {
    const prevTop = mixedScroller.scrollTop
    mixedScroller.scrollTop = prevTop + 60
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    assert(mixedScroller.scrollTop >= prevTop, 'Mixed prose, code, and table scrolling never jumps backward')
  }
  const readingScrollTop = mixedScroller.scrollTop
  assert(readingScrollTop > 1200, 'Mixed document reaches deep scroll offset')
  mixedContent.blur()
  await settle(30)
  mixedContent.focus()
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  assert(Math.abs(mixedScroller.scrollTop - readingScrollTop) <= 1, 'Refocusing the editor does not jump back to an off-screen caret')
  const anchorBeforeHide = topVisibleLineText()
  panel.hideWorkspaceMainView()
  panel.showWorkspaceMainView({ openPanel: true })
  await until(() => body().querySelector('.cm-editor'), 'reopened mixed scroll document')
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  assert(topVisibleLineText() === anchorBeforeHide, 'Reopening the Files panel restores the exact visible reading paragraph')
  const { applyTheme } = await import('../frontend/src/app/i18n')
  applyTheme('dark')
  w.currentSessionId = 's1'
  panel.openWorkspaceFilePath('/fixture/document.md')
  await until(() => body().querySelector('.cm-editor') && body().querySelector('[data-markdown-toc] ul button'), 'dark document')
  await nativeInput({ capture: 'markdown-dark' })
  assert(getComputedStyle(body().querySelector('.cm-editor')!).backgroundColor !== 'rgb(255, 255, 255)', 'Document editor follows the dark appearance')
  w.workspaceEditorResults = { passed: results.length, results, writes: writes.length }
}

w.workspaceEditorReady = run().catch(error => { w.workspaceEditorError = String(error?.stack ?? error); throw error })
