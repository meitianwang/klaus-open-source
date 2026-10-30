import {
  COMPOSER_EDIT_COMMAND_GLOBAL,
  dispatchComposerEditCommand,
  refreshComposerFocusReport,
  setComposerFocusReporter,
  type ComposerEditCommand,
} from './contenteditable-control'

/** The narrow slice of the bridge this module uses, so it is testable without the host. */
export interface ComposerFocusSink {
  reportComposerFocus?: (owned: boolean) => Promise<unknown> | undefined
}

/**
 * Wire the composer's edit commands to the host.
 *
 * Two halves, both needed because the host is the one that decides whether a
 * Cmd+Z belongs to the composer:
 *
 *   - the renderer REPORTS whether the focused surface is an editor with its own
 *     history. The host keeps that as its only reason to intercept;
 *   - the host DISPATCHES the command back into the page, because it suppresses
 *     the keystroke before the page ever sees it.
 *
 * The dispatch global is published on the window rather than reached through the
 * bridge: the host evaluates it in the page world with `executeJavaScript`, and
 * the guard inside `editCommandScript` tolerates the page not having installed it
 * yet (a reload in flight).
 *
 * Reporting is best-effort. A dropped report leaves the host on its previous
 * answer, which at worst means one keystroke is routed the way it was before the
 * fix — never a lost edit, so the error is swallowed like the approval badge's.
 */
export function installComposerEditCommandBridge(
  sink: { app?: ComposerFocusSink },
  globals: Record<string, unknown>,
  doc: Document,
): () => void {
  globals[COMPOSER_EDIT_COMMAND_GLOBAL] = (command: ComposerEditCommand) =>
    dispatchComposerEditCommand(doc, command === 'redo' ? 'redo' : 'undo')

  setComposerFocusReporter(state => {
    try { sink.app?.reportComposerFocus?.(state.owned)?.catch?.(() => {}) } catch { /* focus report best-effort */ }
  })
  // A page that loaded with a composer already focused fired no `focusin`, so
  // ask now: without it the host would keep its initial "no composer" answer
  // until the user clicked away and back.
  refreshComposerFocusReport()

  return () => {
    delete globals[COMPOSER_EDIT_COMMAND_GLOBAL]
    setComposerFocusReporter(null)
  }
}
