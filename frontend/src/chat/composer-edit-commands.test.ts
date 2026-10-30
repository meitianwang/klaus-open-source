// The system undo/redo wiring between host and renderer.
//
// The composer keeps its own history because the app rewrites its value
// programmatically (paste, chip edits), which Chromium's native undo stack cannot
// see. Routing the platform's Cmd+Z into that history needs both sides, and the
// contract between them is a single window global name. A rename on either side
// compiles cleanly and fails silently — every undo becomes a no-op — so the name
// is asserted here as one value read from both files.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { COMPOSER_EDIT_COMMAND_GLOBAL } from './composer/contenteditable-control'
import { runInNewContext } from 'node:vm'
import { transpileModule, ScriptTarget } from 'typescript'
import { EditorState } from 'prosemirror-state'
import { history, undo } from 'prosemirror-history'
import { composerDocumentSchema, composerTokenNode } from './composer/document-model'
import { projectComposerDocument } from './composer/document-projection'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')
const CONTROL_TS = readFileSync(fileURLToPath(new URL('./composer/contenteditable-control.ts', import.meta.url)), 'utf8')
const BRIDGE_TS = readFileSync(fileURLToPath(new URL('./composer/edit-command-bridge.ts', import.meta.url)), 'utf8')
const HOST_TS = readFileSync(fileURLToPath(new URL('../../../main/app/composer-edit-commands.ts', import.meta.url)), 'utf8')
const RUNTIME_TS = readFileSync(fileURLToPath(new URL('../../../main/app/runtime.ts', import.meta.url)), 'utf8')
const BRIDGE_API_TS = readFileSync(fileURLToPath(new URL('../../bridge/klaus-api.ts', import.meta.url)), 'utf8')

describe('composer system edit commands', () => {
  test('the host and the renderer name the same dispatch global', () => {
    // The renderer publishes it through this constant, so the literal appears
    // once there. The host evaluates it in the page world, where it must be
    // spelled out as a string, so that copy is what drifts — and the host's own
    // test pins the exact script text.
    expect(COMPOSER_EDIT_COMMAND_GLOBAL).toBe('klausComposerEditCommand')
    expect(CONTROL_TS).toContain(`export const COMPOSER_EDIT_COMMAND_GLOBAL = '${COMPOSER_EDIT_COMMAND_GLOBAL}'`)
    expect(HOST_TS).toContain(`window.${COMPOSER_EDIT_COMMAND_GLOBAL}`)
    expect(BRIDGE_TS).toContain('COMPOSER_EDIT_COMMAND_GLOBAL')
  })

  test('the host intercepts only undo/redo, and only while a composer owns the focus', () => {
    // Everything else — Cmd+C/V/X/A, and undo in a plain input, the terminal or
    // the embedded browser — must reach Chromium untouched.
    expect(HOST_TS).toContain("if (key !== 'z' && key !== 'y') return null")
    expect(HOST_TS).toContain('if (!state.owned) return null')
    expect(HOST_TS).toContain("event.preventDefault()")
    // Suppressing the keystroke is what stops the menu accelerator from also
    // running the native command against a stack the composer does not share.
    const intercept = HOST_TS.indexOf('event.preventDefault()')
    expect(intercept).toBeGreaterThan(HOST_TS.indexOf('routeEditCommand(input, this.state'))
  })

  test('a composer that cannot answer swallows the keystroke instead of using the native stack', () => {
    // The native stack can still hold entries from before a session switch, so
    // falling back there would resurrect another session's text.
    expect(HOST_TS).toContain('if (handled === null || handled === undefined)')
    expect(HOST_TS).not.toContain('if (handled !== true)')
  })

  test('the host hooks each main window and detaches its command owner on close', () => {
    expect(RUNTIME_TS).toContain("owner.webContents.on('before-input-event', listener)")
    expect(RUNTIME_TS).toContain("owner.webContents.removeListener('before-input-event', listener)")
    expect(RUNTIME_TS).toContain('createComposerCommands(owner)')
    expect(RUNTIME_TS).toContain('composerCommandsByWindow.get(id)?.close()')
    expect(RUNTIME_TS).toContain("'composer:edit-focus'")
    expect(BRIDGE_API_TS).toContain("call('composer:edit-focus'")
  })

  test('a document-wide replacement drops the undo history rather than straddling sessions', () => {
    // setComposerText is the single exit for every whole-document replacement:
    // session switch, draft restore, recalling a sent message, clear after send.
    const fn = CHAT_TS.slice(
      CHAT_TS.indexOf('function setComposerText('),
      CHAT_TS.indexOf('function setSlashCommandDraft('),
    )
    expect(fn).toContain('mainComposerControl?.resetHistory()')
    // The side composer clears after a send, which is the same kind of
    // replacement and gets the same treatment.
    expect(CHAT_TS).toContain('sideComposerControl?.resetHistory()')
  })

  test('undo restores full quoted content into its attachment projection without losing ordinary files', () => {
    const helper = CHAT_TS.slice(CHAT_TS.indexOf('function restoreInlineDocumentFiles('), CHAT_TS.indexOf('function commandDocumentTokens('))
    const code = transpileModule(`${helper}\nrestoreInlineDocumentFiles`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
    const restoreFiles = runInNewContext(code, {}) as (files: any[], tokens: unknown[]) => any[]
    const quote = composerTokenNode({ value: '\uFFFC', label: 'Quote', data: { kind: 'selected-text', quoteId: 'quote-undo', text: 'Full retained passage', source: 'Selected source' } })
    const doc = composerDocumentSchema.nodes.doc.create(null, composerDocumentSchema.nodes.paragraph.create(null, quote))
    let state = EditorState.create({ doc, plugins: [history()] })
    const file = { path: '/owned/file.txt', file: { name: 'file.txt' } }
    const before = restoreFiles([file], projectComposerDocument(state.doc).tokens)
    state = state.apply(state.tr.delete(1, 2))
    const removed = restoreFiles(before, projectComposerDocument(state.doc).tokens)
    expect(removed).toEqual([file])
    expect(undo(state, transaction => { state = state.apply(transaction) })).toBe(true)
    const restored = restoreFiles(removed, projectComposerDocument(state.doc).tokens)
    expect(restored).toEqual(before)
    expect(restored[0]).toBe(file)
    expect(restored[1].text).toBe('Full retained passage')
    expect(restored[1].quoteId).toBe('quote-undo')
    expect(restored[1].range).toEqual({ start: 0, end: 1 })
  })

  test('the bridge installs once from the composer boot path', () => {
    expect(CHAT_TS).toContain('installComposerEditCommandBridge(')
    // A page that loads with the composer already focused fires no focusin, so
    // the install has to report immediately or the first Cmd+Z is lost.
    expect(BRIDGE_TS).toContain('refreshComposerFocusReport()')
  })
})
