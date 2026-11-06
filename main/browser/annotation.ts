export type BrowserAnnotationScreenshotMode = 'always' | 'necessary'
export type BrowserAnnotationAnchorKind = 'element' | 'region'

export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAnnotationCaptureRequest {
  format: 'png'
  clip?: BrowserAnnotationRect & { scale: 1 }
  captureBeyondViewport: false
}

export interface BrowserAnnotationScreenshotMetadata {
  path: string
  name: string
  mimeType: 'image/png' | 'image/jpeg'
  size: number
  width: number
  height: number
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite.`)
  return value
}

/** Clamp a region to the captured viewport and reject empty drags. */
export function normalizeAnnotationRegion(
  rect: BrowserAnnotationRect,
  viewport: { width: number; height: number },
): BrowserAnnotationRect | null {
  const width = finite(viewport.width, 'viewport.width')
  const height = finite(viewport.height, 'viewport.height')
  if (width <= 0 || height <= 0) throw new Error('The annotation viewport is empty.')
  const left = Math.max(0, Math.min(width, finite(rect.x, 'rect.x')))
  const top = Math.max(0, Math.min(height, finite(rect.y, 'rect.y')))
  const right = Math.max(0, Math.min(width, finite(rect.x, 'rect.x') + finite(rect.width, 'rect.width')))
  const bottom = Math.max(0, Math.min(height, finite(rect.y, 'rect.y') + finite(rect.height, 'rect.height')))
  const normalized = { x: left, y: top, width: right - left, height: bottom - top }
  return normalized.width > 0 && normalized.height > 0 ? normalized : null
}

/**
 * Whole viewport for `always` and element/additional-anchor requests.
 * Only a pure region in `necessary` mode produces a crop.
 */
export function annotationCropRect(
  mode: BrowserAnnotationScreenshotMode,
  anchor: { kind: BrowserAnnotationAnchorKind; rect: BrowserAnnotationRect },
  additionalAnchors: Array<{ kind: BrowserAnnotationAnchorKind; rect: BrowserAnnotationRect }>,
  viewport: { width: number; height: number },
): BrowserAnnotationRect | null {
  if (mode !== 'necessary' || anchor.kind !== 'region' || additionalAnchors.length > 0) return null
  return normalizeAnnotationRegion(anchor.rect, viewport)
}

export function annotationCaptureRequest(
  mode: BrowserAnnotationScreenshotMode,
  anchor: { kind: BrowserAnnotationAnchorKind; rect: BrowserAnnotationRect },
  additionalAnchors: Array<{ kind: BrowserAnnotationAnchorKind; rect: BrowserAnnotationRect }>,
  viewport: { width: number; height: number },
): BrowserAnnotationCaptureRequest {
  const rect = annotationCropRect(mode, anchor, additionalAnchors, viewport)
  return rect
    ? { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: false }
    : { format: 'png', captureBeyondViewport: false }
}

/** A durable attachment is a host path, never a data URL or an object URL. */
export function validateAnnotationScreenshotMetadata(
  value: BrowserAnnotationScreenshotMetadata,
): BrowserAnnotationScreenshotMetadata {
  if (!value || typeof value !== 'object') throw new Error('The annotation screenshot metadata is missing.')
  if (typeof value.path !== 'string' || !value.path.trim()) throw new Error('The annotation screenshot path is missing.')
  if (/^(?:data|blob):/i.test(value.path)) throw new Error('The annotation screenshot must use a durable host path.')
  if (value.mimeType !== 'image/png' && value.mimeType !== 'image/jpeg') throw new Error('The annotation screenshot must be PNG or JPEG.')
  if (!Number.isFinite(value.size) || value.size <= 0) throw new Error('The annotation screenshot is empty.')
  if (!Number.isFinite(value.width) || value.width <= 0 || !Number.isFinite(value.height) || value.height <= 0) throw new Error('The annotation screenshot dimensions are invalid.')
  const name = String(value.name || '').trim()
  if (!name) throw new Error('The annotation screenshot name is missing.')
  return { ...value, name }
}
