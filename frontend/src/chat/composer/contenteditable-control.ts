export { composerKeyWasHandled } from './composer-key-routing'
import type { InlineTokenSnapshot } from './inline-token'
import type { ComposerDocumentSnapshot } from './document-model'
import { installDocumentControl } from './document-control'
import type { ComposerQuery } from './composer-query'

export interface ContenteditableToken extends InlineTokenSnapshot {
  element: HTMLElement
}

type TokenResolver = (value: string) => ContenteditableToken[]

/** The platform editing command the host may route into a control. */
export type ComposerEditCommand = 'undo' | 'redo'

/**
 * What the host needs to know before it decides whether a Cmd+Z belongs to a
 * composer: whether the focused surface is an editor that keeps its own history
 * and so must not be routed to the browser's native undo stack.
 */
export interface ComposerFocusState {
  owned: boolean
}

/** The part of an installed control the app needs after install. */
export interface ComposerTextControl {
  destroy?(): void
  setEditable?(editable: boolean): void
  readTokens(): InlineTokenSnapshot[]
  refreshTokens(): void
  snapshotDocument(): ComposerDocumentSnapshot
  restoreDocument(snapshot: unknown): boolean
  restoreText(value: string): void
  serializeSubmission(): { text: string; tokens: InlineTokenSnapshot[] }
  readonly revision: number
  readonly historyGeneration?: number
  readonly composing: boolean
  queryAtCaret(): ComposerQuery | null
  dismissQuery(): void
  continueQuery(prefix: ComposerQuery['prefix'], start: number): void
  replaceRange(start: number, end: number, text: string, inputType: string, tokenMode?: 'resolve' | 'literal'): void
  /**
   * Drop both stacks and re-base on the current content. The app replaces the
   * whole document when it switches session, restores a draft, recalls a sent
   * message or clears the composer after sending; none of those are user edits,
   * and leaving them undoable would let Cmd+Z resurrect another session's text.
   */
  resetHistory(): void
}

/**
 * One installed control, kept so the host's dispatcher can find whichever
 * composer has focus. The main and side composers install separately and only
 * one of them is focused at a time.
 */
interface EditControl {
  root: HTMLElement
  /** Answer one platform command. True when the control's own history moved. */
  apply(command: ComposerEditCommand): boolean
  destroy?: () => void
}

const controls = new Set<EditControl>()
const editFallbacks = new WeakMap<HTMLElement, (command: ComposerEditCommand) => boolean>()
export function setComposerEditFallback(root: HTMLElement, apply: (command: ComposerEditCommand) => boolean): void {
  editFallbacks.set(root, apply)
}
/** Documents that already have the focus listener, so each install does not add another. */
const watchedDocuments = new WeakSet<Document>()
/** Every document with at least one installed control, for reporting on demand. */
const watchedDocumentList = new Set<Document>()
let reporter: ((state: ComposerFocusState) => void) | null = null
let lastReported: boolean | null = null

function activeControl(doc: Document): EditControl | null {
  const active = doc.activeElement
  if (!active) return null
  for (const control of controls) {
    if (control.root === active || control.root.contains(active)) return control
  }
  return null
}

/**
 * Drop controls whose root left the document.
 *
 * A side composer is a fresh clone each time one opens, and nothing owns the
 * teardown of the old one, so the registry would otherwise grow for the life of
 * the window. Pruning on `isConnected` is self-healing: it needs no call site to
 * remember to dispose, and a detached root can never be the active element, so
 * removing it cannot change which control answers a command.
 */
function pruneDetachedControls(): void {
  for (const control of controls) {
    if (!control.root.isConnected) { controls.delete(control); control.destroy?.() }
  }
  // A side composer is torn down with its whole document fragment, so drop
  // documents that no longer hold a control either.
  for (const doc of watchedDocumentList) {
    let hasControl = false
    for (const control of controls) {
      if (control.root.ownerDocument === doc) { hasControl = true; break }
    }
    if (!hasControl) watchedDocumentList.delete(doc)
  }
}

/**
 * Watch every focus move in the document, not just the composer's own.
 *
 * The host swallows Cmd+Z while a composer owns the focus, so a stale `owned`
 * would take undo away from whichever plain input the user moved to. `focusin`
 * fires after `activeElement` has settled on the new target, which is what makes
 * the recomputation accurate; watching the document rather than the control is
 * what makes it notice focus LEAVING the composer.
 */
function watchDocumentFocus(doc: Document): void {
  watchedDocumentList.add(doc)
  if (watchedDocuments.has(doc)) return
  watchedDocuments.add(doc)
  doc.addEventListener('focusin', () => reportFocusState(), true)
}

/**
 * Tell the host whether the focused surface owns its own history.
 *
 * Ownership is answered across every document with an installed control rather
 * than the one that fired, because the renderer may hold more than one composer
 * (the main and side surfaces) and only the focused one matters. Deduplicated on
 * the value because this runs after every edit and every focus change: the
 * answer flips only when focus moves between a composer and something else, so
 * reporting per keystroke would be an IPC round trip for nothing.
 */
function reportFocusState(): void {
  if (!reporter) return
  pruneDetachedControls()
  let owned = false
  for (const doc of watchedDocumentList) {
    if (activeControl(doc) !== null) { owned = true; break }
  }
  if (owned === lastReported) return
  lastReported = owned
  reporter({ owned })
}

/**
 * Where a composer reports its focus state. This module knows nothing about IPC;
 * the app wires this to the bridge once.
 */
export function setComposerFocusReporter(report: ((state: ComposerFocusState) => void) | null): void {
  reporter = report
  lastReported = null
}

/**
 * Report the current focus state immediately.
 *
 * Focus events only fire on a CHANGE, so a page that loads with a composer
 * already focused produces no `focusin`. Without this the host would stay on its
 * initial "no composer" answer until the user clicked away and back, which leaves
 * the first Cmd+Z of the session on the native path — the exact path that cannot
 * see a programmatic rewrite.
 */
export function refreshComposerFocusReport(): void {
  reportFocusState()
}

/**
 * Answer one platform undo/redo command for the focused composer.
 *
 * The host dispatches this from `before-input-event`, because a keystroke it
 * suppresses never reaches the page and so the page cannot route it itself.
 * `null` means no composer has focus and the browser's own editing command is
 * the right answer; `false` means a composer owns the focus but its history has
 * nothing to give, so the keystroke is deliberately swallowed instead of being
 * handed to a native stack that may still hold another session's text.
 */
export function dispatchComposerEditCommand(doc: Document, command: ComposerEditCommand): boolean | null {
  pruneDetachedControls()
  const control = activeControl(doc)
  if (!control) return null
  return control.apply(command) || editFallbacks.get(control.root)?.(command) || false
}

/** Register an editor's existing history authority and retire it with the editor view. */
export function registerOwnedEditControl(root: HTMLElement, apply: (command: ComposerEditCommand) => boolean): () => void {
  const control: EditControl = { root, apply }
  controls.add(control)
  watchDocumentFocus(root.ownerDocument)
  reportFocusState()
  return () => {
    controls.delete(control)
    pruneDetachedControls()
    reportFocusState()
  }
}

/** The window global the host calls. Named in `main/app/composer-edit-commands.ts`. */
export const COMPOSER_EDIT_COMMAND_GLOBAL = 'klausComposerEditCommand'

export function installContenteditableTextControl(root: HTMLElement, resolveTokens: TokenResolver,
  options?: { restoreTokens?(value: string, tokens: InlineTokenSnapshot[]): void; onLongPaste?(text: string): boolean }): ComposerTextControl | null {
  if (root.tagName === 'TEXTAREA' || root.dataset.klausTextControl === '1') return null
  root.dataset.klausTextControl = '1'
  let dispose = () => {}
  const result = installDocumentControl(root, resolveTokens, options?.restoreTokens, (element, apply, destroy) => {
    const unregister = registerOwnedEditControl(element, apply)
    const control = Array.from(controls).find(entry => entry.root === element)
    let disposed = false
    dispose = () => { if (disposed) return; disposed = true; destroy(); unregister(); delete root.dataset.klausTextControl }
    if (control) control.destroy = dispose
  }, options?.onLongPaste)
  return Object.assign(result, { destroy: () => dispose() })
}
