// Which platform undo/redo keystroke the host routes into the composer's own
// history, and when it must leave the keystroke to Chromium.
//
// The composer keeps its own undo stack (see
// `frontend/src/chat/composer/edit-history.ts`) because the app rewrites the
// composer's value programmatically for every paste and chip edit, and a
// programmatic rewrite is invisible to Chromium's native stack. Measured in
// Electron against the real control:
//
//   - after a programmatic write with an empty native stack, the menu's undo
//     command produced no `beforeinput:historyUndo` at all, so Cmd+Z was inert;
//   - after typing plus a programmatic write, redo restored text that did not
//     match what the user saw ("abc" + programmatic "abcXYZ" came back as
//     "abcXYZabcabc").
//
// So for a composer the platform keystroke is intercepted and answered from the
// composer's own history, and the native stack is never consulted for it — not
// even when the composer's history is empty, because the native stack can still
// hold entries from before a session switch and would resurrect that text.
//
// Every OTHER editable surface keeps native behaviour: this module returns null
// for them, the keystroke is not suppressed, and Chromium's own editing commands
// run exactly as before. The renderer reports which surface has focus, so "is
// this mine" is the composer's answer rather than a guess made here.
//
// Nothing here imports Electron. The host supplies the keystroke fields and the
// reported state, so the mapping is testable in plain Node.

/** The fields of Electron's `before-input-event` input that this routing reads. */
export interface EditCommandKeystroke {
  /** `keyDown` or `keyUp`. Only keyDown is routed. */
  type: string
  /** Equivalent to KeyboardEvent.key. */
  key: string
  shift: boolean
  control: boolean
  alt: boolean
  meta: boolean
  /** Equivalent to KeyboardEvent.isComposing. */
  isComposing?: boolean
}

/**
 * What the renderer last reported about the focused editable surface: whether it
 * is an editor that keeps its own history, and so must not be routed to the
 * browser's native undo stack.
 */
export interface ComposerFocusState {
  owned: boolean
}

/** The state to assume before the renderer has reported anything. */
export const INITIAL_COMPOSER_FOCUS_STATE: ComposerFocusState = { owned: false }

export type EditCommand = 'undo' | 'redo'

/**
 * Read a keystroke as an undo or redo request, or null when it means neither.
 *
 * Only the platform's standard bindings: macOS is Cmd+Z / Cmd+Shift+Z, elsewhere
 * Ctrl+Z with Ctrl+Y or Ctrl+Shift+Z for redo. This is deliberately not a place
 * to invent shortcuts. Option/Alt is excluded because it is a text-navigation
 * modifier on macOS, and the modifier that is not "primary" on the platform must
 * be clear so a chord like Ctrl+Cmd+Z is not mistaken for undo.
 *
 * A keystroke during IME composition is excluded: the composition owns those
 * keys, and taking one would abort a candidate selection.
 */
export function readEditCommand(keystroke: EditCommandKeystroke, platform: NodeJS.Platform): EditCommand | null {
  if (keystroke.type !== 'keyDown' || keystroke.isComposing === true || keystroke.alt) return null
  const key = String(keystroke.key || '').toLowerCase()
  if (key !== 'z' && key !== 'y') return null
  const primary = platform === 'darwin' ? keystroke.meta : keystroke.control
  const other = platform === 'darwin' ? keystroke.control : keystroke.meta
  if (!primary || other) return null
  if (key === 'y') return platform === 'darwin' ? null : 'redo'
  return keystroke.shift ? 'redo' : 'undo'
}

/**
 * Decide whether the host should take this keystroke away from Chromium and
 * answer it from the composer's own history.
 *
 * Returns the command to dispatch, or null to leave the keystroke alone. Null is
 * the common case: every plain input, textarea, terminal and web page keeps
 * native undo/redo.
 */
export function routeEditCommand(
  keystroke: EditCommandKeystroke,
  state: ComposerFocusState,
  platform: NodeJS.Platform,
): EditCommand | null {
  if (!state.owned) return null
  return readEditCommand(keystroke, platform)
}

/**
 * The page-world expression that answers one command.
 *
 * The dispatcher is published by the renderer's own composer module, so this is a
 * call into code the page already owns rather than a script the host composes.
 * It is guarded because the keystroke can land before the page has installed the
 * dispatcher (a reload in flight), and a throwing `executeJavaScript` would
 * surface as an unhandled rejection for a keypress the user cannot diagnose.
 */
export function editCommandScript(command: EditCommand): string {
  return `window.klausComposerEditCommand ? window.klausComposerEditCommand(${JSON.stringify(command)}) : null`
}

/**
 * Validate a focus report from the renderer.
 *
 * The renderer is not trusted to be well-formed: anything that is not the exact
 * shape falls back to "not owned", which is the safe direction because it leaves
 * the keystroke with Chromium instead of swallowing it.
 */
export function parseComposerFocusState(value: unknown): ComposerFocusState {
  if (typeof value !== 'object' || value === null) return INITIAL_COMPOSER_FOCUS_STATE
  return { owned: (value as Record<string, unknown>).owned === true }
}

/** The two window capabilities this needs, so the class is testable without Electron. */
export interface EditCommandHost {
  /** Attach the keystroke hook. Returns nothing; `close` removes it. */
  onBeforeInput(listener: (event: { preventDefault(): void }, input: EditCommandKeystroke) => void): () => void
  /**
   * Run one expression in the page world.
   *
   * Untyped on purpose: the value comes from a script evaluated in a page the
   * host does not control, so the caller narrows it rather than asserting a
   * shape Electron never guaranteed.
   */
  evaluate(script: string): Promise<unknown>
  /** The browser's own undo, used when no composer answers. */
  undo(): void
  redo(): void
}

/**
 * Routes the platform's undo/redo into the focused composer's own history.
 *
 * The decision is deliberately narrow: the keystroke is intercepted only while
 * the renderer reports that the focused surface keeps its own history. Every
 * other editable surface — a settings input, the terminal, a page in the
 * embedded browser — is left completely alone, and the keystroke reaches Chromium
 * untouched.
 *
 * If the renderer's report is stale and no composer answers, the command falls
 * back to the browser's own. That is the right answer for the case the staleness
 * describes (focus moved to a plain input), and it cannot corrupt a composer:
 * `dispatchComposerEditCommand` returns null only when no installed control
 * contains the focused element.
 *
 * This is not a shortcut system. No binding is configurable and nothing new is
 * bound: Cmd+Z and Cmd+Shift+Z keep their platform meaning and their menu
 * accelerators, and this exists only because the composer's history lives
 * somewhere Chromium cannot see.
 */
export class ComposerEditCommands {
  private state: ComposerFocusState = INITIAL_COMPOSER_FOCUS_STATE
  private detach: (() => void) | null = null

  constructor(
    private readonly host: EditCommandHost,
    private readonly options: { platform: NodeJS.Platform; log?: (message: string) => void } = { platform: process.platform },
  ) {}

  /** Start intercepting. Idempotent: a second call does not stack a listener. */
  start(): void {
    if (this.detach) return
    this.detach = this.host.onBeforeInput((event, input) => {
      const command = routeEditCommand(input, this.state, this.options.platform)
      if (!command) return
      // Suppress first: the menu accelerator for the same chord would otherwise
      // still fire and run the native command against a stack the composer does
      // not share, which is what produced the corrupted text in the first place.
      event.preventDefault()
      void this.execute(command)
    })
  }

  /** Keyboard and menu commands consult the same currently focused renderer control. */
  async execute(command: EditCommand): Promise<boolean | null> {
    try {
      const handled = await this.host.evaluate(editCommandScript(command))
      if (handled === true || handled === false) return handled
      if (handled === null || handled === undefined) {
        if (command === 'undo') this.host.undo()
        else this.host.redo()
        return null
      }
      return false
    } catch (error) {
      this.options.log?.(String(error))
      return false
    }
  }

  /** Accept one focus report from the renderer. */
  reportFocus(value: unknown): void {
    this.state = parseComposerFocusState(value)
  }

  /** What the host currently believes, for diagnostics and tests. */
  focusState(): ComposerFocusState {
    return { ...this.state }
  }

  close(): void {
    this.detach?.()
    this.detach = null
    this.state = INITIAL_COMPOSER_FOCUS_STATE
  }
}
