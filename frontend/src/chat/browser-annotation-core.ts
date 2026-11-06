import type { PendingFileEntry } from './engine-events'

export type BrowserAnnotationScreenshotMode = 'always' | 'necessary'

export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAnnotationElementAnchor {
  kind: 'element'
  selector: string
  rect: BrowserAnnotationRect
  tagName?: string
  selectedText?: string
}

export interface BrowserAnnotationRegionAnchor {
  kind: 'region'
  rect: BrowserAnnotationRect
  selectedText?: string
}

export type BrowserAnnotationAnchor =
  | BrowserAnnotationElementAnchor
  | BrowserAnnotationRegionAnchor

export interface BrowserAnnotationSnapshot {
  id: string
  tabId?: string
  url: string
  title: string
  /** Display-only image source. Durable attachments always use `path`. */
  previewUrl: string
  /** CSS viewport dimensions at capture time. */
  width: number
  height: number
  capturedAt: number
}

export interface BrowserAnnotationSavedScreenshot {
  /** Host-owned content-addressed attachment path. */
  path: string
  name: string
  mimeType: 'image/png' | 'image/jpeg'
  size: number
  width: number
  height: number
  /** Optional display URL; never used as the attachment identity. */
  previewUrl?: string
}

export interface BrowserAnnotationSelection {
  snapshot: BrowserAnnotationSnapshot
  anchor: BrowserAnnotationAnchor
  additionalAnchors?: BrowserAnnotationAnchor[]
  note: string
  screenshotMode: BrowserAnnotationScreenshotMode
  cropScreenshot: boolean
}

export interface BrowserAnnotationComposerPayload {
  text: string
  attachment: PendingFileEntry
}

export const BROWSER_ANNOTATION_MIN_REGION_SIZE = 8

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Convert a pointer position inside the rendered image to capture-space CSS pixels. */
export function pointerToViewportPoint(
  clientX: number,
  clientY: number,
  imageRect: Pick<BrowserAnnotationRect, 'x' | 'y' | 'width' | 'height'>,
  viewport: Pick<BrowserAnnotationSnapshot, 'width' | 'height'>,
): { x: number; y: number } {
  const width = Math.max(1, finite(imageRect.width, 1))
  const height = Math.max(1, finite(imageRect.height, 1))
  return {
    x: clamp((finite(clientX) - finite(imageRect.x)) / width * finite(viewport.width, 1), 0, finite(viewport.width, 1)),
    y: clamp((finite(clientY) - finite(imageRect.y)) / height * finite(viewport.height, 1), 0, finite(viewport.height, 1)),
  }
}

/** Normalize a drag in either direction and keep it inside the captured viewport. */
export function normalizeRegion(
  start: { x: number; y: number },
  end: { x: number; y: number },
  viewport: Pick<BrowserAnnotationSnapshot, 'width' | 'height'>,
): BrowserAnnotationRect | null {
  const width = Math.max(1, finite(viewport.width, 1))
  const height = Math.max(1, finite(viewport.height, 1))
  const x1 = clamp(finite(start.x), 0, width)
  const y1 = clamp(finite(start.y), 0, height)
  const x2 = clamp(finite(end.x), 0, width)
  const y2 = clamp(finite(end.y), 0, height)
  const left = Math.min(x1, x2)
  const top = Math.min(y1, y2)
  const right = Math.max(x1, x2)
  const bottom = Math.max(y1, y2)
  const rect = { x: left, y: top, width: right - left, height: bottom - top }
  if (rect.width < BROWSER_ANNOTATION_MIN_REGION_SIZE || rect.height < BROWSER_ANNOTATION_MIN_REGION_SIZE) return null
  return rect
}

export function regionFromPointer(
  start: { x: number; y: number },
  end: { x: number; y: number },
  viewport: Pick<BrowserAnnotationSnapshot, 'width' | 'height'>,
): BrowserAnnotationRect | null {
  return normalizeRegion(start, end, viewport)
}

/**
 * `always` captures the whole viewport. `necessary` crops only a pure region.
 * An element or any additional anchor keeps the whole screenshot because the
 * note can refer to more than the drag area.
 */
export function shouldCropBrowserAnnotationScreenshot(
  mode: BrowserAnnotationScreenshotMode,
  anchor: BrowserAnnotationAnchor,
  additionalAnchors: BrowserAnnotationAnchor[] = [],
): boolean {
  return mode === 'necessary' && anchor.kind === 'region' && additionalAnchors.length === 0
}

export function cropRegionForBrowserAnnotation(
  mode: BrowserAnnotationScreenshotMode,
  anchor: BrowserAnnotationAnchor,
  additionalAnchors: BrowserAnnotationAnchor[] = [],
): BrowserAnnotationRect | null {
  return shouldCropBrowserAnnotationScreenshot(mode, anchor, additionalAnchors) ? { ...anchor.rect } : null
}

function rectText(rect: BrowserAnnotationRect): string {
  return `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
}

function quote(text: string | undefined): string | null {
  const value = String(text || '').trim()
  return value ? `"${value.replace(/"/g, '\\"')}"` : null
}

export function buildBrowserAnnotationText(
  selection: Pick<BrowserAnnotationSelection, 'snapshot' | 'anchor' | 'additionalAnchors' | 'note'>,
): string {
  const lines = [
    'Browser annotation',
    `URL: ${selection.snapshot.url}`,
    `Title: ${selection.snapshot.title || selection.snapshot.url}`,
  ]
  if (selection.anchor.kind === 'element') {
    lines.push(`Element: ${selection.anchor.selector}`)
    if (selection.anchor.tagName) lines.push(`Tag: ${selection.anchor.tagName}`)
  } else {
    lines.push(`Region: ${rectText(selection.anchor.rect)}`)
  }
  const selectedText = quote(selection.anchor.selectedText)
  if (selectedText) lines.push(`Selected text: ${selectedText}`)
  for (const [index, anchor] of (selection.additionalAnchors ?? []).entries()) {
    if (anchor.kind === 'element') lines.push(`Additional element ${index + 1}: ${anchor.selector}`)
    else lines.push(`Additional region ${index + 1}: ${rectText(anchor.rect)}`)
  }
  const note = selection.note.trim()
  lines.push('', note || 'No note was provided.')
  return lines.join('\n')
}

function filenameForScreenshot(saved: BrowserAnnotationSavedScreenshot): string {
  const name = String(saved.name || '').trim()
  if (name) return name
  return saved.path.split(/[\\/]/).pop() || 'browser-annotation.png'
}

export function browserAnnotationAttachment(
  saved: BrowserAnnotationSavedScreenshot,
): PendingFileEntry {
  if (!saved.path || !saved.path.trim()) throw new Error('The annotation screenshot path is missing.')
  if (!Number.isFinite(saved.size) || saved.size <= 0) throw new Error('The annotation screenshot is empty.')
  return {
    file: { name: filenameForScreenshot(saved), type: saved.mimeType, size: saved.size },
    uploadPath: saved.path,
    uploading: false,
    objectUrl: saved.previewUrl || null,
    kind: 'browser-annotation',
  }
}

export function finalizeBrowserAnnotation(
  selection: BrowserAnnotationSelection,
  saved: BrowserAnnotationSavedScreenshot,
): BrowserAnnotationComposerPayload {
  return {
    text: buildBrowserAnnotationText(selection),
    attachment: browserAnnotationAttachment(saved),
  }
}

export function createBrowserAnnotationSelection(input: {
  snapshot: BrowserAnnotationSnapshot
  anchor: BrowserAnnotationAnchor
  additionalAnchors?: BrowserAnnotationAnchor[]
  note: string
  screenshotMode: BrowserAnnotationScreenshotMode
}): BrowserAnnotationSelection {
  const additionalAnchors = input.additionalAnchors ?? []
  return {
    snapshot: input.snapshot,
    anchor: input.anchor,
    ...(additionalAnchors.length > 0 ? { additionalAnchors } : {}),
    note: input.note,
    screenshotMode: input.screenshotMode,
    cropScreenshot: shouldCropBrowserAnnotationScreenshot(input.screenshotMode, input.anchor, additionalAnchors),
  }
}

export interface BrowserAnnotationLabels {
  title: string
  hint: string
  note: string
  cancel: string
  submit: string
  element: string
  region: string
}
