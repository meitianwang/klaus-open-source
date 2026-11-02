import { randomUUID } from 'node:crypto'
import type { BrowserManager, BrowserPage } from './manager'
import type { BrowserAnnotationRect } from './annotation'
import { normalizeAnnotationRegion } from './annotation'

const MAX_SNAPSHOTS_PER_WINDOW = 1
const MAX_ANCHORS = 200
const MAX_ANCHOR_TEXT = 160
const MAX_ANNOTATION_PIXELS = 16_777_216
const MAX_ANNOTATION_BYTES = 12 * 1024 * 1024

export interface AnnotationCaptureRequest {
  sessionId: string
  focusRevision: number
}

export interface AnnotationAnchor {
  kind: 'element'
  selector: string
  tagName?: string
  selectedText?: string
  rect: BrowserAnnotationRect
}

export interface FrozenAnnotationSnapshot {
  snapshotId: string
  windowId: number
  sessionId: string
  tabId: string
  focusRevision: number
  url: string
  title: string
  width: number
  height: number
  capturedAt: number
  previewUrl: string
  anchors: AnnotationAnchor[]
}

export interface AnnotationSaveRequest {
  snapshotId: string
  sessionId: string
  tabId: string
  focusRevision: number
  crop?: BrowserAnnotationRect | null
}

export interface AnnotationCommitRequest {
  snapshotId: string
  sessionId: string
  tabId: string
  focusRevision: number
}

export interface AnnotationSavedScreenshot {
  path: string
  name: string
  mimeType: 'image/png' | 'image/jpeg'
  size: number
  width: number
  height: number
  previewUrl?: string
}

export interface AnnotationPersistence {
  save(input: {
    snapshotId: string
    sessionId: string
    tabId: string
    bytes: Buffer
    mimeType: 'image/png'
    width: number
    height: number
  }): Promise<AnnotationSavedScreenshot>
  /** Promote a staged attachment after the composer has accepted it. */
  commit?(input: {
    snapshotId: string
    sessionId: string
    tabId: string
    focusRevision: number
    saved: AnnotationSavedScreenshot
  }): Promise<void>
  /** Remove an uncommitted staging file. Never remove a committed content-pool file. */
  discard?(snapshotId: string, savedPath?: string): Promise<void>
}

export interface AnnotationSessionOptions {
  browser: Pick<BrowserManager, 'windowId' | 'state' | 'page'>
  persistence: AnnotationPersistence
  imageSize?: (bytes: Buffer) => Promise<{ width: number; height: number }>
  cropImage?: (bytes: Buffer, rect: BrowserAnnotationRect) => Promise<{ bytes: Buffer; width: number; height: number }>
}

interface FrozenRecord {
  snapshot: FrozenAnnotationSnapshot
  png: Buffer
  imageWidth: number
  imageHeight: number
  saved?: AnnotationSavedScreenshot
  adopted?: boolean
  discarded?: boolean
  savePromise?: Promise<AnnotationSavedScreenshot>
}

function defaultImageSize(bytes: Buffer): Promise<{ width: number; height: number }> {
  return import('electron').then(({ nativeImage }) => {
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) throw new Error('The annotation snapshot is not a valid image.')
    return image.getSize()
  })
}

function defaultCropImage(bytes: Buffer, rect: BrowserAnnotationRect): Promise<{ bytes: Buffer; width: number; height: number }> {
  return import('electron').then(({ nativeImage }) => {
    const image = nativeImage.createFromBuffer(bytes)
    const cropped = image.crop({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
    if (cropped.isEmpty()) throw new Error('The annotation crop is empty.')
    return { bytes: cropped.toPNG(), ...cropped.getSize() }
  })
}

const ANCHOR_SCRIPT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const selector = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 5; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(x => x.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (node === document.body) break;
    }
    return parts.join(' > ').slice(0, 120);
  };
  const out = [];
  const nodes = document.querySelectorAll('a,button,input,textarea,select,[role],[tabindex],img,h1,h2,h3,h4,h5,h6,p,li,label');
  for (const el of nodes) {
    if (out.length >= ${MAX_ANCHORS}) break;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    const skipText = ['input', 'textarea', 'select'].includes(tag) || el.isContentEditable;
    const text = skipText ? undefined : (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, ${MAX_ANCHOR_TEXT});
    out.push({ selector: selector(el), tagName: tag, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, ...(text ? { selectedText: text } : {}) });
  }
  return { width: innerWidth, height: innerHeight, anchors: out };
})()`

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite.`)
  return value
}

function assertBounds(bytes: Buffer, width: number, height: number): void {
  if (width <= 0 || height <= 0 || width * height > MAX_ANNOTATION_PIXELS) throw new Error('The annotation snapshot exceeds the pixel limit.')
  if (bytes.length > MAX_ANNOTATION_BYTES) throw new Error('The annotation snapshot exceeds the byte limit.')
}

/** One frozen screenshot per window. Every save reads its original bytes. */
export class AnnotationSessionManager {
  private readonly snapshots = new Map<number, FrozenRecord>()
  private readonly capturing = new Set<number>()
  private readonly captureTokens = new Map<number, symbol>()
  private readonly size: (bytes: Buffer) => Promise<{ width: number; height: number }>
  private readonly crop: (bytes: Buffer, rect: BrowserAnnotationRect) => Promise<{ bytes: Buffer; width: number; height: number }>

  constructor(private readonly options: AnnotationSessionOptions) {
    this.size = options.imageSize ?? defaultImageSize
    this.crop = options.cropImage ?? defaultCropImage
  }

  private state(request: AnnotationCaptureRequest, record?: FrozenRecord) {
    const state = this.options.browser.state()
    if (state.conversationId !== request.sessionId || state.focusRevision !== request.focusRevision) throw new Error('The annotation snapshot belongs to a stale task.')
    if (record) {
      if (record.snapshot.windowId !== this.options.browser.windowId) throw new Error('The annotation snapshot belongs to another window.')
      if (record.snapshot.sessionId !== request.sessionId || record.snapshot.focusRevision !== request.focusRevision || record.snapshot.tabId !== state.tabId) throw new Error('The annotation snapshot is bound to another tab or task.')
      if (record.snapshot.url !== state.url) throw new Error('The annotation snapshot page changed before it was saved.')
    }
    return state
  }

  async capture(request: AnnotationCaptureRequest): Promise<FrozenAnnotationSnapshot> {
    const windowId = this.options.browser.windowId
    if (this.snapshots.has(windowId) || this.capturing.has(windowId)) throw new Error('An annotation snapshot is already open for this window.')
    const token = Symbol('annotation-capture')
    this.capturing.add(windowId)
    this.captureTokens.set(windowId, token)
    const ensureCurrent = (): void => {
      if (this.captureTokens.get(windowId) !== token) throw new Error('The annotation capture was released.')
    }
    try {
    const state = this.state(request)
    const tabId = state.tabId
    if (!tabId) throw new Error('The browser tab is unavailable.')
    const page: BrowserPage = this.options.browser.page(request.sessionId, tabId)
    const shot = await page.cdp.screenshot({ format: 'png' })
    ensureCurrent()
    const data = String(shot.data ?? '')
    if (!data) throw new Error('The browser returned no annotation screenshot.')
    const png = Buffer.from(data, 'base64')
    const image = await this.size(png)
    ensureCurrent()
    assertBounds(png, image.width, image.height)
    const metrics = page.cdp.evaluate(ANCHOR_SCRIPT).then(async value => value as { width?: number; height?: number; anchors?: unknown[] })
    const measured = await metrics
    ensureCurrent()
    const width = finite(measured.width, 'viewport.width')
    const height = finite(measured.height, 'viewport.height')
    const anchors = (measured.anchors ?? []).flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const candidate = value as { selector?: unknown; tagName?: unknown; rect?: unknown; selectedText?: unknown }
      if (typeof candidate.selector !== 'string' || typeof candidate.tagName !== 'string' || !candidate.rect || typeof candidate.rect !== 'object') return []
      const rect = candidate.rect as BrowserAnnotationRect
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return []
      return [{ kind: 'element' as const, selector: candidate.selector, tagName: candidate.tagName, rect: { ...rect }, ...(typeof candidate.selectedText === 'string' ? { selectedText: candidate.selectedText } : {}) }]
    })
    const snapshot: FrozenAnnotationSnapshot = {
      snapshotId: randomUUID(),
      windowId,
      sessionId: request.sessionId,
      tabId,
      focusRevision: request.focusRevision,
      url: state.url || '',
      title: state.title || '',
      width,
      height,
      capturedAt: Date.now(),
      previewUrl: `data:image/png;base64,${data}`,
      anchors,
    }
    const current = this.state(request)
    if (this.options.browser.windowId !== windowId || current.tabId !== tabId || current.url !== state.url) throw new Error('The browser page changed while the annotation was being captured.')
    ensureCurrent()
    this.snapshots.set(windowId, { snapshot, png, imageWidth: image.width, imageHeight: image.height })
    return snapshot
    } finally {
      if (this.captureTokens.get(windowId) === token) {
        this.captureTokens.delete(windowId)
        this.capturing.delete(windowId)
      }
    }
  }

  anchorAt(snapshotId: string, point: { x: number; y: number }): AnnotationAnchor | null {
    const record = [...this.snapshots.values()].find(value => value.snapshot.snapshotId === snapshotId)
    if (!record) throw new Error('The annotation snapshot has been discarded.')
    if (record.snapshot.windowId !== this.options.browser.windowId) throw new Error('The annotation snapshot belongs to another window.')
    this.state(record.snapshot, record)
    finite(point.x, 'point.x'); finite(point.y, 'point.y')
    let best: AnnotationAnchor | null = null
    for (const anchor of record.snapshot.anchors) {
      const r = anchor.rect
      if (point.x < r.x || point.x > r.x + r.width || point.y < r.y || point.y > r.y + r.height) continue
      if (!best || r.width * r.height < best.rect.width * best.rect.height) best = anchor
    }
    return best
  }

  async save(request: AnnotationSaveRequest): Promise<AnnotationSavedScreenshot> {
    const record = [...this.snapshots.values()].find(value => value.snapshot.snapshotId === request.snapshotId)
    if (!record) throw new Error('The annotation snapshot has been discarded.')
    if (record.snapshot.windowId !== this.options.browser.windowId) throw new Error('The annotation snapshot belongs to another window.')
    const state = this.state({ sessionId: request.sessionId, focusRevision: request.focusRevision }, record)
    if (state.tabId !== request.tabId) throw new Error('The annotation snapshot tab changed before saving.')
    if (record.saved) return record.saved
    if (record.savePromise) return record.savePromise
    const work = (async () => {
      let bytes = record.png
      let width = record.imageWidth
      let height = record.imageHeight
      if (request.crop) {
        const css = normalizeAnnotationRegion(request.crop, { width: record.snapshot.width, height: record.snapshot.height })
        if (!css) throw new Error('The annotation crop is empty.')
        const scaleX = record.imageWidth / record.snapshot.width
        const scaleY = record.imageHeight / record.snapshot.height
        const pixelRect = { x: css.x * scaleX, y: css.y * scaleY, width: css.width * scaleX, height: css.height * scaleY }
        const cropped = await this.crop(record.png, pixelRect)
        bytes = cropped.bytes
        width = cropped.width
        height = cropped.height
      }
      assertBounds(bytes, width, height)
      const saved = await this.options.persistence.save({
        snapshotId: record.snapshot.snapshotId,
        sessionId: record.snapshot.sessionId,
        tabId: record.snapshot.tabId,
        bytes,
        mimeType: 'image/png',
        width,
        height,
      })
      if (!saved.path || /^(?:data|blob):/i.test(saved.path)) throw new Error('The annotation attachment path is not durable.')
      if (record.discarded || this.snapshots.get(record.snapshot.windowId) !== record) {
        await this.options.persistence.discard?.(record.snapshot.snapshotId, saved.path)
        throw new Error('The annotation snapshot was discarded before saving completed.')
      }
      record.saved = saved
      return saved
    })()
    const tracked = work.finally(() => {
      if (record.savePromise === tracked) record.savePromise = undefined
    })
    record.savePromise = tracked
    return tracked
  }

  async commit(request: AnnotationCommitRequest): Promise<void> {
    const record = [...this.snapshots.values()].find(value => value.snapshot.snapshotId === request.snapshotId)
    if (!record || record.discarded) throw new Error('The annotation snapshot has been discarded.')
    if (record.snapshot.windowId !== this.options.browser.windowId) throw new Error('The annotation snapshot belongs to another window.')
    if (record.snapshot.sessionId !== request.sessionId || record.snapshot.tabId !== request.tabId || record.snapshot.focusRevision !== request.focusRevision) {
      throw new Error('The annotation commit does not match the captured tab or task.')
    }
    if (!record.saved) throw new Error('The annotation screenshot has not been saved.')
    if (record.adopted) return
    await this.options.persistence.commit?.({
      snapshotId: record.snapshot.snapshotId,
      sessionId: record.snapshot.sessionId,
      tabId: record.snapshot.tabId,
      focusRevision: record.snapshot.focusRevision,
      saved: record.saved,
    })
    record.adopted = true
  }

  async discard(snapshotId: string): Promise<void> {
    for (const [windowId, record] of this.snapshots) {
      if (record.snapshot.snapshotId !== snapshotId) continue
      record.discarded = true
      this.snapshots.delete(windowId)
      if (!record.adopted) await this.options.persistence.discard?.(snapshotId, record.saved?.path)
      return
    }
  }

  has(snapshotId: string): boolean {
    return [...this.snapshots.values()].some(record => !record.discarded && record.snapshot.snapshotId === snapshotId)
  }
  ownsWindow(snapshotId: string, windowId: number): boolean {
    return this.snapshots.get(windowId)?.snapshot.snapshotId === snapshotId
  }
  async releaseWindow(windowId: number): Promise<void> {
    this.captureTokens.delete(windowId)
    this.capturing.delete(windowId)
    const record = this.snapshots.get(windowId)
    if (record) await this.discard(record.snapshot.snapshotId)
  }
  async dispose(): Promise<void> {
    for (const record of [...this.snapshots.values()]) await this.discard(record.snapshot.snapshotId)
    this.capturing.clear()
    this.captureTokens.clear()
  }
}

export const ANNOTATION_LIMITS = { MAX_ANCHORS, MAX_ANCHOR_TEXT, MAX_ANNOTATION_PIXELS, MAX_ANNOTATION_BYTES, MAX_SNAPSHOTS_PER_WINDOW }
