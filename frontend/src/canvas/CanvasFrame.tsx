// The isolated Canvas frame: toolbar, mounted canvas, and error panel.
//
// The error panel is the reason this component exists rather than a bare mount.
// A canvas is generated code, so failing is a normal state, not an exception —
// and the useful response to a failure is the message and the line, in the window
// the user is already looking at. A blank window would send them to the console.
//
// An error boundary wraps the canvas because a render-time throw inside
// model-authored code must not take the chrome down with it: losing the title bar
// and the reload button is what turns a fixable canvas into a window the user can
// only close.

import type { ComponentType, CSSProperties, ErrorInfo, ReactNode } from 'react'
import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CanvasListRow, CanvasLoadReply } from '../../bridge/canvas-api'
import type { Annotation } from './annotate'
import { AnnotationLayer, annotationMessage } from './annotate'
import type { CanvasRuntimeConfig } from './loader'
import { CanvasLoadError, failureHeading, loadCanvas } from './loader'
import {
  applyCanvasLanguage,
  applyCanvasTheme,
  dispatchCanvasAction,
  flushCanvasState,
  initCanvasHost,
  installCanvasStateFlush,
  onCanvasAnnotationRequest,
} from './sdk/hooks'
import type { CanvasThemeKind } from './sdk/tokens'

/** The narrow surface `bridge/canvas-api.ts` publishes for this window. */
function hostApi() {
  const surface = (window as unknown as {
    klausCanvas?: {
      load(filePath: string): Promise<CanvasLoadReply>
      sendToChat(text: string, options?: { submit?: boolean }): Promise<unknown>
      list(): Promise<{ canvases: CanvasListRow[] }>
      open(filePath: string): Promise<unknown>
    }
  }).klausCanvas
  if (!surface) throw new Error('this window has no host bridge')
  return surface
}

/**
 * The other canvases on disk, for the toolbar switcher.
 *
 * The switcher exists because a canvas opens in its own isolated surface with no file
 * browser behind it: without a way to reach the others, every canvas but the
 * newest is only findable in Finder. Loaded lazily on open rather than on mount
 * so the common case — look at this canvas, close it — costs no directory read.
 */
function CanvasSwitcher({ current }: { current: string }) {
  const [rows, setRows] = useState<CanvasListRow[] | null>(null)
  const [open, setOpen] = useState(false)

  const toggle = useCallback(async () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    try {
      const reply = await hostApi().list()
      setRows(reply.canvases ?? [])
    } catch {
      setRows([])
    }
  }, [open])

  // Any click outside closes it. A menu that only closes by re-clicking its own
  // trigger is the kind of thing people report as "stuck".
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest('[data-canvas-switcher]')) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const others = (rows ?? []).filter((row) => row.filePath !== current)

  return (
    <div data-canvas-switcher style={{ position: 'relative' }}>
      <button
        type="button"
        className={open ? 'cv-action is-active' : 'cv-action'}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => void toggle()}
        aria-label="Other canvases"
      >
        Canvases
      </button>
      {open ? (
        <div className="cv-switcher-menu" role="menu">
          {rows === null ? (
            <p className="cv-switcher-empty">Loading…</p>
          ) : others.length === 0 ? (
            <p className="cv-switcher-empty">No other canvases yet.</p>
          ) : (
            others.map((row) => (
              <button
                key={row.filePath}
                type="button"
                role="menuitem"
                className="cv-switcher-item"
                onClick={() => {
                  setOpen(false)
                  void hostApi().open(row.filePath)
                }}
              >
                {row.name}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; Canvas: ComponentType; config: CanvasRuntimeConfig; generation: number }
  | { phase: 'failed'; error: CanvasLoadError | Error }

/**
 * Turn a canvas's shell request into styles for the body element.
 *
 * `full-bleed` drops the frame's padding and width cap so the canvas owns every
 * pixel below the title bar. The title bar itself is NOT negotiable: it carries
 * Reveal and the annotation entry, and a canvas that could hide it would be a
 * canvas the user cannot get out of.
 */
function shellStyle(config: CanvasRuntimeConfig): CSSProperties | undefined {
  const shell = config.shell
  if (!shell) return undefined
  const style: CSSProperties = {}
  if (shell.mode === 'full-bleed') {
    style.padding = 0
    style.maxWidth = 'none'
  }
  // An explicit padding wins over the mode's default, so `full-bleed` plus a
  // padding is a way to say "edge to edge, but breathe".
  if (shell.padding !== undefined) style.padding = shell.padding
  if (shell.background) style.background = shell.background
  if (shell.color) style.color = shell.color
  if (shell.fontFamily) style.fontFamily = shell.fontFamily
  if (shell.fontSize !== undefined) style.fontSize = shell.fontSize
  if (shell.lineHeight !== undefined) style.lineHeight = shell.lineHeight
  return Object.keys(style).length > 0 ? style : undefined
}

export function CanvasFrame({
  filePath,
  displayName,
}: {
  filePath: string
  displayName: string
}) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  // Bumped on every reload so a remount discards the previous tree's state; a
  // canvas edited from "3 rows" to "5 rows" must not keep the old selection
  // pointing at a row that no longer exists.
  const [generation, setGeneration] = useState(0)

  const load = useCallback(async () => {
    setState({ phase: 'loading' })
    // The host leg and the compile leg are separated on purpose. ANYTHING that
    // fails before there is source — a missing file, a scope refusal, a dead
    // bridge — is a load failure, and letting it fall through to the generic
    // handler below labelled it "failed while rendering", which points the reader
    // at the canvas's code when the code was never read.
    let payload: CanvasLoadReply
    try {
      payload = await hostApi().load(filePath)
      if (payload.error) throw new Error(payload.error)
    } catch (error) {
      setState({
        phase: 'failed',
        error: new CanvasLoadError(
          'load',
          error instanceof Error ? error.message : String(error),
        ),
      })
      return
    }
    try {
      initCanvasHost({
        filePath,
        themeKind: payload.themeKind,
        locale: payload.locale,
        data: payload.data ?? {},
      })
      const { component: Canvas, config } = loadCanvas(payload.source)
      setState({ phase: 'ready', Canvas, config, generation })
    } catch (error) {
      setState({
        phase: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }, [filePath, generation])

  useEffect(() => {
    installCanvasStateFlush()
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // The host pushes appearance changes and a reload when the file changes on
  // disk. Both arrive as plain DOM events the shell dispatches into this page.
  useEffect(() => {
    const onTheme = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string }>).detail
      applyCanvasTheme((detail?.kind === 'light' ? 'light' : 'dark') as CanvasThemeKind)
    }
    const onLanguage = (event: Event) => {
      const detail = (event as CustomEvent<{ locale?: string }>).detail
      if (detail?.locale) applyCanvasLanguage(detail.locale)
    }
    const onReload = () => {
      // Persist what the user did before the new source replaces the tree.
      flushCanvasState()
      setGeneration((value) => value + 1)
    }
    window.addEventListener('klaus-host-theme', onTheme)
    window.addEventListener('klaus-host-language', onLanguage)
    window.addEventListener('klaus-canvas-reload', onReload)
    return () => {
      window.removeEventListener('klaus-host-theme', onTheme)
      window.removeEventListener('klaus-host-language', onLanguage)
      window.removeEventListener('klaus-canvas-reload', onReload)
    }
  }, [])

  const title = useMemo(
    () => displayName || filePath.split('/').pop() || 'Canvas',
    [displayName, filePath],
  )

  // Annotation mode is the window's. A canvas can ASK for it — see
  // startCanvasAnnotation — but it never learns what the user picked or wrote,
  // so a canvas cannot use the picker to watch the user.
  const [annotating, setAnnotating] = useState(false)
  const body = useRef<HTMLElement | null>(null)
  const ready = state.phase === 'ready'

  // Leaving annotation mode on across a reload would leave the overlay pointing
  // at elements from the previous tree.
  useEffect(() => {
    if (!ready) setAnnotating(false)
  }, [ready])

  // A canvas-drawn "discuss this" button reaches the same mode as the title-bar
  // entry. Gated on `ready` for the same reason the button is disabled: there is
  // nothing to point at until the tree is mounted.
  useEffect(() => {
    return onCanvasAnnotationRequest(() => {
      if (ready) setAnnotating(true)
    })
  }, [ready])

  const submitAnnotation = useCallback(
    async (annotation: Annotation) => {
      try {
        // Fill, do not submit: the user wrote the note, but they should still see
        // the assembled message in the composer before it is sent.
        await hostApi().sendToChat(annotationMessage(annotation, filePath), { submit: false })
        return true
      } catch {
        return false
      }
    },
    [filePath],
  )

  return (
    <div className="cv-shell">
      <header className="cv-titlebar">
        <span className="cv-title">{title}</span>
        <div className="cv-actions">
          <CanvasSwitcher current={filePath} />
          <button
            type="button"
            className={annotating ? 'cv-action is-active' : 'cv-action'}
            disabled={!ready}
            aria-pressed={annotating}
            onClick={() => setAnnotating((value) => !value)}
            aria-label="Pick something in this canvas and ask about it"
          >
            Ask about…
          </button>
          <button
            type="button"
            className="cv-action"
            onClick={() => setGeneration((value) => value + 1)}
            aria-label="Reload"
          >
            Reload
          </button>
          <button
            type="button"
            className="cv-action"
            onClick={() => dispatchCanvasAction({ type: 'reveal' })}
            aria-label="Reveal in Finder"
          >
            Reveal
          </button>
        </div>
      </header>
      <main
        className="cv-body"
        ref={body}
        style={state.phase === 'ready' ? shellStyle(state.config) : undefined}
      >
        {state.phase === 'loading' ? null : state.phase === 'failed' ? (
          <CanvasError error={state.error} filePath={filePath} onRetry={() => setGeneration((v) => v + 1)} />
        ) : (
          <CanvasBoundary key={generation} filePath={filePath} onRetry={() => setGeneration((v) => v + 1)}>
            <state.Canvas />
          </CanvasBoundary>
        )}
      </main>
      {annotating && ready ? (
        <AnnotationLayer
          containerRef={body}
          onExit={() => setAnnotating(false)}
          onSubmit={submitAnnotation}
        />
      ) : null}
    </div>
  )
}

/** The failure panel. States the stage, the message, and the line when there is
 *  one — the three things needed to fix the file. */
function CanvasError({
  error,
  filePath,
  onRetry,
}: {
  error: CanvasLoadError | Error
  filePath: string
  onRetry: () => void
}) {
  const stage = error instanceof CanvasLoadError ? error.stage : 'render'
  const line = error instanceof CanvasLoadError ? error.line : undefined
  return (
    <div className="cv-error" role="alert">
      <h1 className="cv-error-title">{failureHeading(stage)}</h1>
      <p className="cv-error-message">
        {line !== undefined ? <span className="cv-error-line">Line {line}</span> : null}
        {error.message}
      </p>
      <p className="cv-error-path">{filePath}</p>
      <button type="button" className="cv-action" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

interface BoundaryProps {
  children: ReactNode
  filePath: string
  onRetry: () => void
}

/**
 * Catches a throw from inside the canvas tree. Class component because that is
 * the only form React gives an error boundary.
 */
class CanvasBoundary extends Component<BoundaryProps, { error: Error | null }> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The component stack is the only pointer back to WHICH part of a canvas
    // threw, and it exists nowhere else once the tree is gone.
    console.error('[canvas] render failed', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <CanvasError
          error={this.state.error}
          filePath={this.props.filePath}
          onRetry={() => {
            this.setState({ error: null })
            this.props.onRetry()
          }}
        />
      )
    }
    return this.props.children
  }
}
