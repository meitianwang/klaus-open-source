import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import styles from './browser-annotation.module.css'
import {
  createBrowserAnnotationSelection,
  normalizeRegion,
  pointerToViewportPoint,
  type BrowserAnnotationAnchor,
  type BrowserAnnotationLabels,
  type BrowserAnnotationSelection,
  type BrowserAnnotationScreenshotMode,
  type BrowserAnnotationSnapshot,
} from './browser-annotation-core'

export interface BrowserAnnotationOverlayProps {
  snapshot: BrowserAnnotationSnapshot
  screenshotMode: BrowserAnnotationScreenshotMode
  initialAnchor?: BrowserAnnotationAnchor | null
  additionalAnchors?: BrowserAnnotationAnchor[]
  onAnchorAt?: (point: { x: number; y: number }) => Promise<BrowserAnnotationAnchor | null> | BrowserAnnotationAnchor | null
  onSubmit: (selection: BrowserAnnotationSelection) => Promise<void> | void
  onCancel: () => void
  labels: BrowserAnnotationLabels
}

function highlightStyle(rect: BrowserAnnotationAnchor['rect'], viewport: BrowserAnnotationSnapshot): CSSProperties {
  return {
    left: `${(rect.x / Math.max(1, viewport.width)) * 100}%`,
    top: `${(rect.y / Math.max(1, viewport.height)) * 100}%`,
    width: `${(rect.width / Math.max(1, viewport.width)) * 100}%`,
    height: `${(rect.height / Math.max(1, viewport.height)) * 100}%`,
  }
}

/** Static screenshot overlay. It never reaches into the page or exposes a host bridge. */
export function BrowserAnnotationOverlay({
  snapshot,
  screenshotMode,
  initialAnchor = null,
  additionalAnchors = [],
  onAnchorAt,
  onSubmit,
  onCancel,
  labels,
}: BrowserAnnotationOverlayProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [imageSize, setImageSize] = useState({ width: snapshot.width, height: snapshot.height })
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const anchorRequest = useRef(0)
  const [anchor, setAnchor] = useState<BrowserAnnotationAnchor | null>(initialAnchor)
  const [hover, setHover] = useState<BrowserAnnotationAnchor | null>(null)
  const [dragRect, setDragRect] = useState<BrowserAnnotationAnchor['rect'] | null>(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    overlayRef.current?.focus()
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const scale = Math.min(stage.clientWidth / snapshot.width, stage.clientHeight / snapshot.height)
      if (!(scale > 0)) return
      setImageSize({ width: snapshot.width * scale, height: snapshot.height * scale })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(stage)
    return () => observer?.disconnect()
  }, [snapshot.id, snapshot.width, snapshot.height])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel, submitting])

  useEffect(() => {
    setAnchor(initialAnchor)
    setHover(null)
    setDragRect(null)
    setNote('')
    setError(null)
  }, [snapshot.id, initialAnchor])

  const pointFor = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const image = imageRef.current
    if (!image) return { x: 0, y: 0 }
    return pointerToViewportPoint(event.clientX, event.clientY, image.getBoundingClientRect(), snapshot)
  }, [snapshot])

  const requestAnchor = useCallback((point: { x: number; y: number }) => {
    if (!onAnchorAt) return
    const request = ++anchorRequest.current
    void Promise.resolve(onAnchorAt(point)).then(result => {
      if (request === anchorRequest.current) setHover(result)
    }).catch(() => {
      if (request === anchorRequest.current) setHover(null)
    })
  }, [onAnchorAt])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
    const point = pointFor(event)
    dragStartRef.current = point
    setDragRect(null)
    setError(null)
    setHover(null)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointFor(event)
    const start = dragStartRef.current
    if (start) {
      const rect = normalizeRegion(start, point, snapshot)
      setDragRect(rect)
      return
    }
    requestAnchor(point)
  }

  const finishPointer = async (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current
    dragStartRef.current = null
    if (!start) return
    const rect = normalizeRegion(start, pointFor(event), snapshot)
    if (rect) {
      setAnchor({ kind: 'region', rect })
      setHover(null)
      setDragRect(null)
      return
    }
    const point = pointFor(event)
    if (onAnchorAt) {
      try {
        const result = await onAnchorAt(point)
        if (result) {
          setAnchor(result)
          setHover(result)
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    setDragRect(null)
  }

  const submit = async () => {
    if (!anchor || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(createBrowserAnnotationSelection({ snapshot, anchor, additionalAnchors, note, screenshotMode }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSubmitting(false)
    }
  }

  const shown = dragRect ? { kind: 'region' as const, rect: dragRect } : anchor
  const hint = anchor
    ? anchor.kind === 'element' ? `${labels.element}: ${anchor.selector}` : `${labels.region}: ${Math.round(anchor.rect.x)},${Math.round(anchor.rect.y)} ${Math.round(anchor.rect.width)}×${Math.round(anchor.rect.height)}`
    : labels.hint

  return (
    <div
      ref={overlayRef}
      className={styles['overlay']}
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      data-browser-annotation-overlay="true"
      tabIndex={-1}
    >
      <div
        ref={stageRef}
        className={styles['stage']}
        data-browser-annotation-stage="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
      >
        <div className={styles['viewport']} style={imageSize}>
        <img
          ref={imageRef}
          className={styles['image']}
          src={snapshot.previewUrl}
          alt={snapshot.title || snapshot.url}
          draggable={false}
        />
        {shown ? <div className={styles['highlight']} style={highlightStyle(shown.rect, snapshot)} /> : null}
        {hover && hover.kind !== shown?.kind ? <div className={styles['hover']} style={highlightStyle(hover.rect, snapshot)} /> : null}
        {additionalAnchors.map((additional, index) => (
          <div
            className={styles['additional']}
            key={`${additional.kind}-${index}-${additional.rect.x}-${additional.rect.y}`}
            style={highlightStyle(additional.rect, snapshot)}
          />
        ))}
        </div>
      </div>
      <div className={styles['panel']}>
        <div className={styles['heading']}>
          <strong>{labels.title}</strong>
          <span className={styles['hint']}>{hint}</span>
        </div>
        <label className={styles['note-label']}>
          <span>{labels.note}</span>
          <textarea
            className={styles['note']}
            value={note}
            onChange={event => setNote(event.target.value)}
            rows={3}
            placeholder={labels.note}
            disabled={submitting}
          />
        </label>
        {error ? <div className={styles['error']} role="alert">{error}</div> : null}
        <div className={styles['actions']}>
          <button className={styles['cancel']} type="button" onClick={onCancel} disabled={submitting}>{labels.cancel}</button>
          <button className={styles['submit']} type="button" onClick={() => void submit()} disabled={!anchor || submitting}>
            {submitting ? '…' : labels.submit}
          </button>
        </div>
      </div>
    </div>
  )
}
