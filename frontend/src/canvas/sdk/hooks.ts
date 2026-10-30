// The canvas host bridge: everything a `.canvas.tsx` can reach outside itself.
//
// This is deliberately the ONLY channel. A canvas is model-authored code running
// in a real webview, so the question is not "can it be sandboxed" (it cannot —
// the agent that wrote it already has a shell) but "what does the SDK make easy".
// Everything here is narrow and purpose-built: read the theme, read the display
// language, persist a state value, ask the host to do one of a fixed set of
// things. The full `window.klaus` surface is NOT loaded into the canvas page, so
// a careless canvas cannot reach a host command by accident.
//
// Why an event/invoke pair rather than the WebSocket an IDE would use: this
// client already has a typed renderer↔host channel, and adding a second
// transport for one page would mean a second thing to keep alive, reconnect, and
// debug. The trade is that the canvas page must be a host window rather than
// something a browser could open — which it is (an isolated Electron child
// WebContentsView; see `canvas` in main/app/windows.ts).

import { useCallback, useRef, useSyncExternalStore } from 'react'

import type { CanvasThemeKind, CanvasTokens } from './tokens'
import { canvasTokensFor } from './tokens'

/** The resolved theme handed to a canvas. */
export interface CanvasHostTheme extends CanvasTokens {
  readonly kind: CanvasThemeKind
  /** The same object, for canvases that destructure `{ tokens }`. */
  readonly tokens: CanvasTokens
}

export type CanvasTextDirection = 'ltr' | 'rtl'

/** The IDE display language, for canvas-owned static labels. */
export interface CanvasHostLanguage {
  /** BCP-47-ish display locale, lowercased: `zh-cn`, `en-us`. */
  readonly locale: string
  /** Primary subtag: `zh`, `en`. */
  readonly language: string
  readonly direction: CanvasTextDirection
  readonly isChinese: boolean
  readonly isEnglish: boolean
}

export type LocalizedTextBundle<T> = Readonly<{ default: T } & Record<string, T>>

export type SetCanvasState<T> = (action: T | ((prev: T) => T)) => void

/** A host action. `type` selects the behaviour; the rest is its payload. */
export type CanvasAction = { type: string; [key: string]: unknown }

export interface SendToChatOptions {
  /**
   * Leave false so the text lands in the composer for the user to read and edit.
   * True submits without another user action, which is only right for a canvas
   * running an explicit automation the user asked for.
   */
  submit?: boolean
  /** Start a fresh session instead of continuing the current one. */
  newChat?: boolean
}

export type SendToChat = (text: string, options?: SendToChatOptions) => Promise<boolean>

/** Options for a canvas-initiated annotation request. */
export interface CanvasAnnotationOptions {
  /**
   * Which control asked. Carried for diagnostics only — the window still runs
   * its own picker and collects the user's note there.
   */
  readonly sourceLabel?: string
}

/** Options for a host action the canvas waits on. */
export interface CanvasActionRequestOptions {
  /** How long to wait before rejecting. Defaults to 30s. */
  readonly timeoutMs?: number
  /**
   * Rejects the promise early. The host leg already in flight is NOT cancelled:
   * the bridge has no cancel channel, and pretending otherwise would leave a
   * canvas believing a write it started never happened.
   */
  readonly signal?: AbortSignal
}

/** What the host injects into the page before the canvas module is evaluated. */
export interface CanvasBootstrap {
  filePath: string
  themeKind: CanvasThemeKind
  locale: string
  /** Persisted `useCanvasState` values, from the `.canvas.data.json` sidecar. */
  data: Record<string, unknown>
}

type Listener = () => void

const THEME_CHANGED = 'klaus-canvas-theme'
const STATE_CHANGED = 'klaus-canvas-state'
const LANGUAGE_CHANGED = 'klaus-canvas-language'

/**
 * Canvas → window: start annotation mode. A window event, not a bridge call,
 * because the receiver is the page's own frame; routing it through the host and
 * back would make the shell a relay for a message that never leaves the window.
 */
const ANNOTATE_REQUESTED = 'klaus-canvas-annotate-request'

/** Default deadline for a host action the canvas waits on. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * The rejection an aborted request produces. Named `AbortError` because that is
 * what callers already check for when they wired an `AbortController`.
 */
function abortError(): Error {
  const error = new Error('canvas action aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Live bridge state. Module-level rather than a React context because the SDK
 * hooks are called from model-authored components that never render a provider —
 * requiring one would mean every canvas breaks the same way.
 */
const host = {
  filePath: '',
  themeKind: 'dark' as CanvasThemeKind,
  language: resolveLanguage('en-us'),
  state: new Map<string, unknown>(),
  ready: false,
}

/** Pending state writes, coalesced so a slider drag is one file write. */
const pendingWrites = new Map<string, unknown>()
let writeTimer: ReturnType<typeof setTimeout> | undefined
const WRITE_DEBOUNCE_MS = 150

function emit(name: string) {
  try {
    doc()?.dispatchEvent(new CustomEvent(name))
  } catch {
    // A page torn down mid-flush has nothing to notify.
  }
}

function resolveLanguage(raw: string): CanvasHostLanguage {
  const locale = (raw || 'en-us').trim().replace(/_/g, '-').toLowerCase()
  const language = locale.split('-')[0] || 'en'
  // Klaus ships no RTL locale today. The field exists because a canvas that
  // hardcodes `flexDirection: 'row'` is invisibly wrong the day one arrives, and
  // it costs nothing to let a canvas ask now.
  const direction: CanvasTextDirection = 'ltr'
  return {
    locale,
    language,
    direction,
    isChinese: language === 'zh',
    isEnglish: language === 'en',
  }
}

/**
 * The narrow host surface `bridge/canvas-api.ts` publishes on this window. Typed
 * structurally rather than imported so the SDK stays independent of the bridge
 * module: `tsconfig.canvas-sdk.json` emits declarations for `src/canvas/sdk`
 * alone, and a bridge import would drag `frontend/bridge` into the shipped
 * contract.
 */
interface CanvasHostApi {
  load(filePath: string): Promise<unknown>
  writeState(filePath: string, entries: Record<string, unknown>): Promise<unknown>
  sendToChat(text: string, options?: SendToChatOptions): Promise<unknown>
  action(filePath: string, action: CanvasAction): Promise<unknown>
}

function api(): CanvasHostApi {
  const surface = (window as unknown as { klausCanvas?: CanvasHostApi }).klausCanvas
  if (!surface) throw new Error('canvas bridge: no host')
  return surface
}

/**
 * The document, when there is one.
 *
 * The bridge is imported by anything that imports the SDK, including contexts
 * with no DOM: a server render, a test, a headless validation pass. A bare
 * `document.` reference makes the whole module unusable there — it throws at the
 * first bootstrap call rather than degrading. Every DOM write in this file goes
 * through here.
 */
function doc(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document
}

/**
 * Publish the theme kind onto `<html data-theme>`.
 *
 * The SDK components read colours from `useHostTheme()`, but the window CHROME
 * (title bar, error panel, scrollbars) is plain CSS in `canvas-window.css` keyed
 * on this attribute. Without it the shell stayed dark while the canvas painted
 * light, which rendered near-black text on a near-black page — caught in the
 * browser, invisible to every unit test, because no test renders the page.
 */
function publishThemeAttribute(kind: CanvasThemeKind) {
  doc()?.documentElement.setAttribute('data-theme', kind)
}

/**
 * Seed the bridge from the host's injected bootstrap. Called once by the page
 * before the canvas module is evaluated, so the first render already has the
 * right theme and persisted state rather than flashing defaults.
 */
export function initCanvasHost(bootstrap: CanvasBootstrap) {
  host.filePath = bootstrap.filePath
  host.themeKind = bootstrap.themeKind === 'light' ? 'light' : 'dark'
  host.language = resolveLanguage(bootstrap.locale)
  host.state = new Map(Object.entries(bootstrap.data ?? {}))
  host.ready = true
  publishThemeAttribute(host.themeKind)
  const root = doc()?.documentElement
  root?.setAttribute('lang', host.language.locale)
  root?.setAttribute('dir', host.language.direction)
}

/** Apply a live theme change from the host. */
export function applyCanvasTheme(kind: CanvasThemeKind) {
  if (kind !== 'light' && kind !== 'dark') return
  if (host.themeKind === kind) return
  host.themeKind = kind
  publishThemeAttribute(kind)
  emit(THEME_CHANGED)
}

/**
 * Apply a live display-language change from the host. Paired with the theme
 * setter rather than left to a reload: both are app appearance settings the user
 * can change with a canvas already open, and only one of them updating would
 * leave the window half-stale.
 */
export function applyCanvasLanguage(locale: string) {
  const next = resolveLanguage(locale)
  if (next.locale === host.language.locale) return
  host.language = next
  const root = doc()?.documentElement
  root?.setAttribute('lang', next.locale)
  root?.setAttribute('dir', next.direction)
  emit(LANGUAGE_CHANGED)
}

/** Flush any coalesced state writes now. Called on page hide. */
export function flushCanvasState() {
  if (writeTimer !== undefined) {
    clearTimeout(writeTimer)
    writeTimer = undefined
  }
  if (pendingWrites.size === 0) return
  const entries = Object.fromEntries(pendingWrites)
  pendingWrites.clear()
  void Promise.resolve()
    .then(() => api().writeState(host.filePath, entries))
    .catch(() => {
      // A dropped persist costs the user their scroll position, not their data.
      // The canvas source is the deliverable; state is a convenience on top.
    })
}

function scheduleWrite(key: string, value: unknown) {
  pendingWrites.set(key, value)
  if (writeTimer !== undefined) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = undefined
    flushCanvasState()
  }, WRITE_DEBOUNCE_MS)
}

/** The absolute path of the canvas being rendered. */
export function getCanvasFilePath(): string {
  return host.filePath
}

/**
 * Resolve an image reference into something an `<img src>` can use.
 *
 * Three forms go through unchanged because they already work in the page: a
 * `data:` URL, an `http(s):` URL, and an absolute `file:` URL. A RELATIVE path is
 * resolved against the canvas's own directory and handed back as a `file:` URL,
 * which is what makes `canvasImage('./shot.png')` work for an image the agent
 * saved beside the canvas.
 *
 * Never build a data URL by hand in a canvas: a base64 image inlined into source
 * is megabytes of text the model has to emit, and it will truncate.
 */
export function canvasImage(source: string): string {
  const value = String(source ?? '').trim()
  if (!value) return ''
  if (host.filePath && typeof location !== 'undefined' && location.protocol === 'klaus-app:' && !/^(data:|https?:|blob:)/i.test(value)) {
    const normalized = host.filePath.replace(/\\/g, '/')
    const base = `file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
    const windowsPath = /^[a-z]:[\\/]/i.test(value)
    const escaped = encodeURI(value.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')
    const file = new URL(/^file:/i.test(value) ? value : windowsPath ? `file:///${escaped}` : escaped, base)
    if (file.protocol !== 'file:') return value
    let path = decodeURIComponent(file.pathname)
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
    if (file.hostname) path = `//${file.hostname}${path}`
    return `klaus-app://app/canvas-asset?path=${encodeURIComponent(path)}`
  }
  if (/^(data:|https?:|file:|blob:)/i.test(value)) return value
  const directory = host.filePath.slice(0, host.filePath.lastIndexOf('/') + 1)
  const relative = value.replace(/^\.\//, '')
  if (!directory) return relative
  // encodeURI, not encodeURIComponent: the slashes in the path have to survive.
  return `file://${encodeURI(directory + relative)}`
}

// ── React glue ────────────────────────────────────────────────────────────────

function subscribeTo(event: string) {
  return (onChange: Listener) => {
    const target = doc()
    target?.addEventListener(event, onChange)
    return () => target?.removeEventListener(event, onChange)
  }
}

const subscribeTheme = subscribeTo(THEME_CHANGED)
const subscribeState = subscribeTo(STATE_CHANGED)
const subscribeLanguage = subscribeTo(LANGUAGE_CHANGED)

/** Cached so `useSyncExternalStore` sees a stable snapshot per theme kind. */
const themeCache = new Map<CanvasThemeKind, CanvasHostTheme>()

function themeSnapshot(): CanvasHostTheme {
  const cached = themeCache.get(host.themeKind)
  if (cached) return cached
  const tokens = canvasTokensFor(host.themeKind)
  const theme: CanvasHostTheme = { ...tokens, kind: host.themeKind, tokens }
  themeCache.set(host.themeKind, theme)
  return theme
}

/**
 * The active theme. Use `tokens.*` for any colour a canvas paints itself, so it
 * follows the app instead of pinning one appearance.
 */
export function useHostTheme(): CanvasHostTheme {
  return useSyncExternalStore(subscribeTheme, themeSnapshot, themeSnapshot)
}

/** The active display language, for canvas-owned labels. */
export function useHostLanguage(): CanvasHostLanguage {
  const snapshot = useCallback(() => host.language, [])
  return useSyncExternalStore(subscribeLanguage, snapshot, snapshot)
}

/**
 * Pick localized canvas-owned text. Falls back exact locale → primary language →
 * `default`, so a bundle only needs the languages it actually has.
 */
export function useLocalizedText<T>(bundle: LocalizedTextBundle<T>): T {
  const { locale, language } = useHostLanguage()
  const table = bundle as Record<string, T>
  return table[locale] ?? table[language] ?? bundle.default
}

/**
 * State that survives a reload, persisted to the canvas's `.canvas.data.json`
 * sidecar. Use it for what the USER did — an open section, a selected row, a
 * filter — not for data the canvas should have embedded.
 */
export function useCanvasState<T>(key: string, defaultValue: T): [T, SetCanvasState<T>] {
  // The default is captured once. A canvas that computes its default inline
  // would otherwise reset the user's stored value on every render.
  const fallback = useRef(defaultValue)
  const snapshot = useCallback(
    () => (host.state.has(key) ? (host.state.get(key) as T) : fallback.current),
    [key],
  )
  const value = useSyncExternalStore(subscribeState, snapshot, snapshot)
  const setValue = useCallback<SetCanvasState<T>>(
    (action) => {
      const previous = host.state.has(key) ? (host.state.get(key) as T) : fallback.current
      const next =
        typeof action === 'function' ? (action as (prev: T) => T)(previous) : action
      if (Object.is(next, previous)) return
      host.state.set(key, next)
      emit(STATE_CHANGED)
      scheduleWrite(key, next)
    },
    [key],
  )
  return [value, setValue]
}

/**
 * Put text in the chat composer. Returns false when the host refuses, so a
 * button can show a failed state instead of silently doing nothing.
 */
export async function sendToChat(text: string, options?: SendToChatOptions): Promise<boolean> {
  const body = String(text ?? '')
  if (!body.trim()) return false
  try {
    await api().sendToChat(body, {
      submit: !!options?.submit,
      newChat: !!options?.newChat,
    })
    return true
  } catch {
    return false
  }
}

/** A stable `sendToChat`, for handlers that need referential identity. */
export function useSendToChat(): SendToChat {
  return useCallback(sendToChat, [])
}

/**
 * Fire-and-forget host actions. The supported set is fixed host-side; an unknown
 * type is refused there rather than silently accepted here, so a typo surfaces.
 */
export function dispatchCanvasAction(action: CanvasAction): void {
  if (!action || typeof action.type !== 'string') return
  void Promise.resolve()
    .then(() => api().action(host.filePath, action))
    .catch(() => {
      // Fire and forget by contract: a canvas cannot recover from a refused UI
      // action, and throwing here would unmount it mid-interaction.
    })
}

/** A stable action dispatcher. */
export function useCanvasAction(): (action: CanvasAction) => void {
  return useCallback(dispatchCanvasAction, [])
}

/**
 * Ask the window to enter annotation mode.
 *
 * The split matters and is the whole reason this is an intent rather than an API
 * that returns something: the WINDOW owns picking, the quote it builds, and the
 * note the user types; the canvas only asks for the mode to start. A canvas that
 * could read the selection would be able to watch the user point at things, and
 * a canvas is agent-authored code — so it gets the button, not the answer.
 *
 * Returns false when there is no window to ask, so a canvas-drawn button can
 * stay disabled instead of looking broken.
 */
export function startCanvasAnnotation(options?: CanvasAnnotationOptions): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.dispatchEvent(
      new CustomEvent(ANNOTATE_REQUESTED, {
        detail: { sourceLabel: options?.sourceLabel ?? '' },
      }),
    )
    return true
  } catch {
    return false
  }
}

/** A stable `startCanvasAnnotation`, for an onClick that keeps its identity. */
export function useCanvasAnnotation(options?: CanvasAnnotationOptions): () => void {
  const label = options?.sourceLabel
  return useCallback(() => {
    startCanvasAnnotation({ sourceLabel: label })
  }, [label])
}

/**
 * Subscribe to canvas-initiated annotation requests. Called by the page, not by
 * a canvas: it exists so the frame does not have to hardcode the event name that
 * `startCanvasAnnotation` dispatches.
 */
export function onCanvasAnnotationRequest(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(ANNOTATE_REQUESTED, listener)
  return () => window.removeEventListener(ANNOTATE_REQUESTED, listener)
}

/**
 * Host actions that answer.
 *
 * Separate from `useCanvasAction()` because the failure modes are opposite. A
 * fire-and-forget UI action swallows refusals on purpose — a canvas cannot
 * recover from "reveal failed" and throwing would unmount it. A request the
 * canvas is WAITING on must reject, or the canvas spins on a promise that never
 * settles and the user sees a permanent spinner with no error.
 *
 * The timeout is the reason this cannot just be `api().action(...)`: the bridge
 * promise has no deadline, so a host leg that never replies hangs forever.
 */
export function useCanvasActionRequest(): <T = unknown>(
  action: CanvasAction,
  options?: CanvasActionRequestOptions,
) => Promise<T> {
  return useCallback(function request<T = unknown>(
    action: CanvasAction,
    options?: CanvasActionRequestOptions,
  ): Promise<T> {
    if (!action || typeof action.type !== 'string') {
      return Promise.reject(new Error('canvas action: `type` must be a string'))
    }
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const signal = options?.signal
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (run: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        run()
      }
      const onAbort = () => finish(() => reject(abortError()))
      const timer = setTimeout(
        () => finish(() => reject(new Error(`canvas action '${action.type}' timed out`))),
        timeoutMs,
      )
      signal?.addEventListener('abort', onAbort)
      Promise.resolve()
        .then(() => api().action(host.filePath, action))
        .then(
          (value) => finish(() => resolve(value as T)),
          (error) =>
            finish(() =>
              reject(error instanceof Error ? error : new Error(String(error))),
            ),
        )
    })
  }, [])
}

/**
 * Reveal the canvas file in the OS file manager. The one host action a canvas
 * gets by name rather than through the generic dispatcher, because "where is
 * this file" is the question a Canvas preview is always asked.
 */
export function revealCanvasFile(): void {
  dispatchCanvasAction({ type: 'reveal' })
}

/** Register a page-hide flush. Called once by the page, not by a canvas. */
export function installCanvasStateFlush() {
  if (typeof window === 'undefined') return
  window.addEventListener('pagehide', flushCanvasState)
  const target = doc()
  target?.addEventListener('visibilitychange', () => {
    if (target.visibilityState === 'hidden') flushCanvasState()
  })
}
