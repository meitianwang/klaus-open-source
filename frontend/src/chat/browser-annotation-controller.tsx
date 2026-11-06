import { createRoot } from 'react-dom/client'
import { BrowserAnnotationOverlay } from './browser-annotation-view'
import {
  finalizeBrowserAnnotation,
  type BrowserAnnotationAnchor,
  type BrowserAnnotationLabels,
  type BrowserAnnotationRect,
  type BrowserAnnotationSavedScreenshot,
  type BrowserAnnotationSelection,
  type BrowserAnnotationScreenshotMode,
  type BrowserAnnotationSnapshot,
} from './browser-annotation-core'

export interface BrowserAnnotationHostSnapshot {
  snapshotId: string
  windowId?: number
  sessionId: string
  tabId: string
  focusRevision: number
  url: string
  title: string
  previewUrl: string
  width: number
  height: number
  capturedAt: number
}

export interface BrowserAnnotationSaveRequest {
  snapshotId: string
  sessionId: string
  tabId: string
  focusRevision: number
  crop?: BrowserAnnotationRect | null
}

export interface BrowserAnnotationHostApi {
  currentSessionId(): string | null
  currentFocusRevision(): number | null
  capture(request: { sessionId: string; focusRevision: number }): Promise<BrowserAnnotationHostSnapshot>
  anchorAt(request: { snapshotId: string; point: { x: number; y: number } }): Promise<BrowserAnnotationAnchor | null>
  save(request: BrowserAnnotationSaveRequest): Promise<BrowserAnnotationSavedScreenshot>
  commit(request: { snapshotId: string; sessionId: string; tabId: string; focusRevision: number }): Promise<void>
  discard(snapshotId: string, savedPath?: string): Promise<void>
  suspendBrowser(): Promise<void>
  resumeBrowser(): Promise<void>
}

export interface OpenBrowserAnnotationOptions {
  api: BrowserAnnotationHostApi
  mount: HTMLElement
  labels: BrowserAnnotationLabels
  screenshotMode: BrowserAnnotationScreenshotMode
  signal?: AbortSignal
  onSubmit(payload: ReturnType<typeof finalizeBrowserAnnotation>, sessionId: string): Promise<void> | void
  onError?(error: unknown): void
}

export interface BrowserAnnotationController {
  snapshot: BrowserAnnotationHostSnapshot
  close(): Promise<void>
}

/** The save request is also the mode-to-crop seam used by the controller. */
export function browserAnnotationSaveRequest(
  selection: BrowserAnnotationSelection,
  snapshot: BrowserAnnotationHostSnapshot,
): BrowserAnnotationSaveRequest {
  return {
    snapshotId: snapshot.snapshotId,
    sessionId: snapshot.sessionId,
    tabId: snapshot.tabId,
    focusRevision: snapshot.focusRevision,
    ...(selection.cropScreenshot ? { crop: selection.anchor.rect } : {}),
  }
}

function snapshotView(value: BrowserAnnotationHostSnapshot): BrowserAnnotationSnapshot {
  return {
    id: value.snapshotId,
    tabId: value.tabId,
    url: value.url,
    title: value.title,
    previewUrl: value.previewUrl,
    width: value.width,
    height: value.height,
    capturedAt: value.capturedAt,
  }
}

/**
 * Host-independent lifecycle around the static annotation view. The host owns
 * screenshot storage; this controller only orders capture, overlay, save,
 * discard and native browser hide/resume. It never submits a chat message.
 */
export async function openBrowserAnnotation(options: OpenBrowserAnnotationOptions): Promise<BrowserAnnotationController> {
  options.signal?.throwIfAborted()
  const sessionId = options.api.currentSessionId()
  const focusRevision = options.api.currentFocusRevision()
  if (!sessionId || focusRevision == null) throw new Error('Open a conversation before annotating a browser page.')
  const captured = await options.api.capture({ sessionId, focusRevision })
  const cleanupCapture = async () => {
    await options.api.discard(captured.snapshotId).catch(() => undefined)
  }
  if (options.api.currentSessionId() !== sessionId || options.api.currentFocusRevision() !== focusRevision) {
    await cleanupCapture()
    throw new Error('The browser task changed while the annotation snapshot was being captured.')
  }
  if (options.signal?.aborted) {
    await cleanupCapture()
    options.signal.throwIfAborted()
  }
  try {
    await options.api.suspendBrowser()
  } catch (error) {
    await cleanupCapture()
    throw error
  }
  if (options.signal?.aborted || options.api.currentSessionId() !== sessionId || options.api.currentFocusRevision() !== focusRevision) {
    await cleanupCapture()
    await options.api.resumeBrowser()
    throw new DOMException('The annotation opening was cancelled.', 'AbortError')
  }

  const root = createRoot(options.mount)
  const snapshot = snapshotView(captured)
  let closed = false
  let closePromise: Promise<void> | null = null
  let submitPromise: Promise<void> | null = null
  let suspended = true

  const close = async (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      if (closed) return
      closed = true
      options.signal?.removeEventListener('abort', onAbort)
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
      root.unmount()
      try {
        await options.api.discard(captured.snapshotId)
      } finally {
        if (suspended) {
          suspended = false
          await options.api.resumeBrowser()
        }
      }
    })()
    return closePromise
  }

  const onAbort = (): void => { void close().catch(error => options.onError?.(error)) }
  const onPageHide = (): void => { void close().catch(() => undefined) }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)

  const submit = async (selection: BrowserAnnotationSelection) => {
    if (closed || submitPromise) return
    submitPromise = (async () => {
      let saved: BrowserAnnotationSavedScreenshot
      try {
        saved = await options.api.save(browserAnnotationSaveRequest(selection, captured))
      } catch (error) {
        await close()
        if (!options.signal?.aborted) options.onError?.(error)
        return
      }
      if (closed || options.signal?.aborted || options.api.currentSessionId() !== sessionId || options.api.currentFocusRevision() !== focusRevision) {
        await close()
        return
      }
      const payload = finalizeBrowserAnnotation(selection, saved)
      try {
        await options.onSubmit(payload, sessionId)
      } catch (error) {
        await close()
        options.onError?.(error)
        return
      }
      try {
        await options.api.commit({
          snapshotId: captured.snapshotId,
          sessionId,
          tabId: captured.tabId,
          focusRevision,
        })
      } catch (error) {
        await close()
        options.onError?.(error)
        return
      }
      await close()
    })()
    await submitPromise
  }

  try {
    root.render(
      <BrowserAnnotationOverlay
        snapshot={snapshot}
        screenshotMode={options.screenshotMode}
        labels={options.labels}
        onAnchorAt={point => options.api.anchorAt({ snapshotId: captured.snapshotId, point })}
        onSubmit={submit}
        onCancel={() => { void close().catch(error => options.onError?.(error)) }}
      />,
    )
    if (options.signal?.aborted || options.api.currentSessionId() !== sessionId || options.api.currentFocusRevision() !== focusRevision) {
      await close()
    }
  } catch (error) {
    await close()
    throw error
  }

  return { snapshot: captured, close }
}
