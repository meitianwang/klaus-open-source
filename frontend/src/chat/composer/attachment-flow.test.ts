import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { decideComposerPaste } from './clipboard-paste'
import { isLargePastedText, pastedTextPreview, PASTE_RESTORE_CHAR_LIMIT } from './pasted-text'
import { GoalInteractionClock } from '../goals/draft-review'
import type { PendingFileEntry } from '../engine-events'
import { AttachmentHistory } from './attachment-history'

const ast = createSourceFile('chat.ts', readFileSync(new URL('../chat.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
const lifecycle = createSourceFile('attachment-lifecycle.ts', readFileSync(new URL('./attachment-lifecycle.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
const names = new Set(['uploadAttachment', 'mainAttachmentRetained', 'removeMainAttachment', 'uploadFileEntry',
  'attachMainPastedText', 'handleMainComposerPaste', 'addFiles', 'addFilePaths', 'basenameFromPath',
  'filesFromClipboardData', 'filePathsFromClipboardData', 'clipboardLooksFileLike', 'handleComposerFileDrop', 'droppedFileEntries', 'directoryEntriesFromDrop', 'readPastedTextForRestore'])
const functions = ast.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text || ''))
if (functions.length !== names.size) throw new Error('Missing production attachment entry point')
const script = transpileModule([...functions, ...lifecycle.statements.filter(isFunctionDeclaration)]
  .map(node => node.getText().replace(/^export\s+/, '')).join('\n') +
  '\n({ handleMainComposerPaste, uploadFileEntry, handleComposerFileDrop, readPastedTextForRestore });', { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const pasted = (data: Record<string, string> = {}, files: any[] = [], types = Object.keys(data)) => ({
  defaultPrevented: false, preventDefault() { this.defaultPrevented = true },
  clipboardData: { files, items: [], types, getData: (type: string) => data[type] || '' },
})

function fixture() {
  const creation = deferred<any>(), upload = deferred<any>(), probe = deferred<string[]>()
  const calls = { renders: 0, releases: 0, cancels: 0, removed: [] as string[], revoked: [] as string[], paths: [] as string[] }
  const input = { value: 'before selected after', selectionStart: 7, selectionEnd: 15 }
  const context: any = {
    decideComposerPaste, isLargePastedText, pastedTextPreview, PASTE_RESTORE_CHAR_LIMIT,
    window: { currentSessionId: 'one' }, goalInteractions: new GoalInteractionClock(),
    inputEl: input, mainComposerControl: { revision: 0, replaceRange(start: number, end: number, text: string) {
      input.value = input.value.slice(0, start) + text + input.value.slice(end); this.revision++
    } },
    pendingFiles: [], sessionPendingFiles: new Map(),
    mainAttachmentHistory: new AttachmentHistory(),
    createPastedTextAttachment: () => creation.promise,
    renderPreviews: () => { calls.renders++ }, updateSendBtn() {}, persistComposerDraft() {},
    releaseDeferredSendIfReady: () => { calls.releases++ }, cancelDeferredSend: () => { calls.cancels++ },
    rejectOversizedAttachment: () => false, isInlineImage: () => false, showToast() {}, tt: (key: string) => key,
    URL: class extends URL { static revokeObjectURL(url: string) { calls.revoked.push(url) } },
    dropOverlay: { classList: { remove() {} } }, CustomEvent: class { constructor(public type: string, public detail: any) { this.detail = detail.detail } },
    document: { elementFromPoint: (_x: number, _y: number) => null },
    klausApi: { clipboard: { readFilePaths: () => probe.promise }, chat: {
      pastedTextRead: async (_path: string): Promise<any> => ({ ok: true, text: 'restored' }), pastedTextRemove: async (path: string) => { calls.removed.push(path) }, uploadFile: () => upload.promise,
      uploadFilePath: async (path: string) => { calls.paths.push(path); return { ok: true, path, name: 'file.txt' } },
    } },
  }
  const api = runInNewContext(script, context) as { handleMainComposerPaste(event: any): Promise<void>; uploadFileEntry(entry: PendingFileEntry): Promise<void>; handleComposerFileDrop(event: any): void; readPastedTextForRestore(entry: PendingFileEntry, current: () => boolean): Promise<string | null> }
  return { context, api, input, calls, creation, upload, probe }
}

test('main large paste leaves selection and text untouched and settles its cached draft', async () => {
  const f = fixture()
  const pending = f.api.handleMainComposerPaste(pasted({ 'text/plain': 'x'.repeat(5000) }))
  const entry = f.context.pendingFiles[0]
  f.context.sessionPendingFiles.set('one', f.context.pendingFiles)
  f.context.window.currentSessionId = 'two'
  f.context.pendingFiles = []
  f.input.value = 'new draft'
  const renders = f.calls.renders
  f.creation.resolve({ uploadPath: '/pastes/one', uploading: false })
  await pending
  expect(f.input.value).toBe('new draft')
  expect([f.input.selectionStart, f.input.selectionEnd]).toEqual([7, 15])
  expect(f.context.mainComposerControl.revision).toBe(0)
  expect(entry.uploadPath).toBe('/pastes/one')
  expect(entry.uploading).toBe(false)
  expect(f.calls.renders).toBe(renders)
  expect(f.calls.releases).toBe(0)
})

test('failed main paste removes only its owner and never inserts the full text', async () => {
  const f = fixture()
  const pending = f.api.handleMainComposerPaste(pasted({ 'text/plain': ' '.repeat(5000) }))
  f.creation.resolve(null)
  await pending
  expect(f.input.value).toBe('before selected after')
  expect([f.input.selectionStart, f.input.selectionEnd]).toEqual([7, 15])
  expect(f.context.pendingFiles).toEqual([])
  expect(f.calls.cancels).toBe(1)
  expect(f.calls.releases).toBe(0)
})

test('removed main paste releases a late file', async () => {
  const f = fixture()
  const pending = f.api.handleMainComposerPaste(pasted({ 'text/plain': 'x'.repeat(5000) }))
  f.context.pendingFiles = []
  f.creation.resolve({ uploadPath: '/pastes/orphan' })
  await pending
  expect(f.calls.removed).toEqual(['/pastes/orphan'])
})

for (const success of [false, true]) test(`removed pending paste ${success ? 'settles for undo' : 'retires failed undo'}`, async () => {
  const f = fixture()
  const pending = f.api.handleMainComposerPaste(pasted({ 'text/plain': 'x'.repeat(5000) }))
  const entry = f.context.pendingFiles[0], history: AttachmentHistory = f.context.mainAttachmentHistory
  history.remove(entry, { files: () => f.context.pendingFiles, setFiles: files => { f.context.pendingFiles = files },
    current: () => true, changed() {}, finalize() {},
  })
  f.creation.resolve(success ? { uploadPath: '/pastes/retained', text: 'x'.repeat(5000) } : null)
  await pending
  expect(f.calls.releases).toBe(0)
  expect(history.apply('undo')).toBe(success)
  expect(f.context.pendingFiles).toHaveLength(success ? 1 : 0)
  if (success) { expect(f.context.pendingFiles[0]).toBe(entry); expect(entry.uploading).toBe(false); expect(entry.uploadPath).toBe('/pastes/retained') }
  history.dispose()
})

test('an upload completion updates its cached conversation without rendering another draft', async () => {
  const f = fixture()
  const entry: PendingFileEntry = { uploading: true, file: { name: 'file.txt', type: 'text/plain', size: 0, arrayBuffer: async () => new ArrayBuffer(0) } as File }
  f.context.pendingFiles.push(entry)
  const pending = f.api.uploadFileEntry(entry)
  f.context.sessionPendingFiles.set('cached', [entry])
  f.context.pendingFiles = []
  f.upload.resolve({ path: '/uploads/original' })
  await pending
  expect(f.context.sessionPendingFiles.get('cached')[0]).toBe(entry)
  expect(entry.uploadPath).toBe('/uploads/original')
  expect(entry.uploading).toBe(false)
  expect(f.calls.renders).toBe(0)
})

test('failed upload removes its cached owner and revokes its URL once', async () => {
  const f = fixture()
  const entry: PendingFileEntry = { objectUrl: 'blob:original', uploading: true, file: { name: 'file.txt', type: 'text/plain', size: 0, arrayBuffer: async () => new ArrayBuffer(0) } as File }
  f.context.sessionPendingFiles.set('cached', [entry])
  const pending = f.api.uploadFileEntry(entry)
  f.upload.reject(new Error('Upload failed'))
  await pending
  expect(f.context.sessionPendingFiles.get('cached')).toEqual([])
  expect(f.calls.revoked).toEqual(['blob:original'])
  expect(entry.objectUrl).toBeNull()
})

test('main native clipboard probe cannot cross a navigation and return', async () => {
  const f = fixture()
  const pending = f.api.handleMainComposerPaste(pasted({}, [], ['Files']))
  f.context.goalInteractions.navigate()
  f.probe.resolve(['/tmp/stale.txt'])
  await pending
  expect(f.calls.paths).toEqual([])
})

test('file drop targets the side composer underneath the full-window overlay', async () => {
  const f = fixture()
  const dropped: any[] = [], file = { name: 'side.txt' }
  f.context.document.elementFromPoint = () => ({ closest: (selector: string) => selector === '#side-input-wrapper' ? { dispatchEvent: (event: any) => dropped.push(event.detail) } : null })
  f.api.handleComposerFileDrop({ defaultPrevented: false, preventDefault() {}, clientX: 30, clientY: 80,
    dataTransfer: { types: ['Files'], files: [file], items: [] } })
  expect(dropped).toEqual([[file]])
  expect(f.context.pendingFiles).toEqual([])
})

test('a directory does not hide an unrelated dropped file with the same basename', () => {
  const f = fixture()
  const dropped: any[] = [], folder = { name: 'notes.txt', size: 0 }, file = { name: 'notes.txt', size: 12 }
  f.context.document.elementFromPoint = () => ({ closest: (selector: string) => selector === '#side-input-wrapper' ? { dispatchEvent: (event: any) => dropped.push(event.detail) } : null })
  f.api.handleComposerFileDrop({ defaultPrevented: false, preventDefault() {}, clientX: 30, clientY: 80,
    dataTransfer: { types: ['Files'], files: [folder, file], items: [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, name: folder.name }), getAsFile: () => folder },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false, name: file.name }), getAsFile: () => file },
    ] } })
  expect(dropped).toEqual([[file]])
  expect(dropped[0][0]).toBe(file)
})

test('a zero-byte ordinary file is ignored independently of a same-name directory', () => {
  const f = fixture()
  const dropped: any[] = [], folder = { name: 'empty', size: 0 }, file = { name: 'empty', size: 0 }
  f.context.document.elementFromPoint = () => ({ closest: (selector: string) => selector === '#side-input-wrapper' ? { dispatchEvent: (event: any) => dropped.push(event.detail) } : null })
  f.api.handleComposerFileDrop({ defaultPrevented: false, preventDefault() {}, clientX: 30, clientY: 80,
    dataTransfer: { types: ['Files'], files: [folder, file], items: [
      { kind: 'string', webkitGetAsEntry: () => null, getAsFile: () => null },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false, name: file.name }), getAsFile: () => file },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, name: folder.name }), getAsFile: () => folder },
    ] } })
  expect(dropped).toEqual([])
})

test('an isolated empty ordinary file does not create a drop attachment', () => {
  const f = fixture(), file = { name: 'empty.txt', size: 0 }
  const dropped: any[] = []
  f.context.document.elementFromPoint = () => ({ closest: (selector: string) => selector === '#side-input-wrapper' ? { dispatchEvent: (event: any) => dropped.push(event.detail) } : null })
  f.api.handleComposerFileDrop({ defaultPrevented: false, preventDefault() {}, clientX: 30, clientY: 80,
    dataTransfer: { types: ['Files'], files: [file], items: [{ kind: 'file', getAsFile: () => file }] } })
  expect(dropped).toEqual([])
})

test('native directories retain exact distinct paths without an upload or image preview', () => {
  const f = fixture()
  const native = new Map<any, string>(), folders = [
    { name: 'images.png', size: 0 }, { name: 'images.png', size: 0 }, { name: 'backslash\\', size: 0 },
  ]
  folders.forEach((folder, index) => native.set(folder, ['/one/images.png', '/two/images.png/', '/three/backslash\\'][index]!))
  f.context.klausApi.chat.localFilePath = (file: any) => native.get(file) || ''
  const event = () => ({ defaultPrevented: false, preventDefault() {}, clientX: 30, clientY: 80,
    dataTransfer: { types: ['Files'], files: folders, items: folders.map(folder => ({ kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: true, name: folder.name }), getAsFile: () => folder })) } })
  f.api.handleComposerFileDrop(event())
  f.api.handleComposerFileDrop(event())
  expect(f.context.pendingFiles.map((entry: PendingFileEntry) => entry.uploadPath))
    .toEqual(['/one/images.png/', '/two/images.png/', '/three/backslash\\/'])
  expect(f.context.pendingFiles.every((entry: PendingFileEntry) => !entry.uploading && entry.objectUrl === null && entry.file.type === 'inode/directory')).toBe(true)
  expect(f.calls.paths).toEqual([])
})

test('a mixed drop preserves ordinary-file and directory order in the attachment tray', () => {
  const f = fixture(), ordinary = { name: 'first.txt', size: 1, arrayBuffer: async () => new ArrayBuffer(1) }, directory = { name: 'second', size: 0 }
  f.context.klausApi.chat.localFilePath = () => '/native/second'
  f.api.handleComposerFileDrop({ defaultPrevented: false, preventDefault() {}, clientX: 30, clientY: 80,
    dataTransfer: { types: ['Files'], files: [ordinary, directory], items: [ordinary, directory].map(file => ({ kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: file === directory, name: file.name }), getAsFile: () => file })) } })
  expect(f.context.pendingFiles.map((entry: PendingFileEntry) => entry.file.name)).toEqual(['first.txt', 'second'])
  expect(f.context.pendingFiles[1].uploadPath).toBe('/native/second/')
})

for (const result of [{ ok: false, error: 'pasted_text_restore_too_large' }, { ok: true, text: '😀'.repeat(12501) }]) {
  test(`restore refuses an over-limit host file even when a shorter cached snapshot exists: ${result.ok}`, async () => {
    const f = fixture()
    f.context.klausApi.chat.pastedTextRead = async () => result
    const entry: PendingFileEntry = { kind: 'pasted-text', uploading: false, text: 'short cached version', uploadPath: '/pastes/one', file: { name: 'pasted text', size: 30, type: 'text/plain' } }
    expect(await f.api.readPastedTextForRestore(entry, () => true)).toBeNull()
  })
}
