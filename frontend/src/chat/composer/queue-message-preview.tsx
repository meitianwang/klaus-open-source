import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A nonmodal, selectable preview that remains open while reading or copying. */
export function QueueMessagePreview({ text, summary, children, disabled }: {
  text: string
  summary: string
  children: ReactNode
  disabled: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const exitPoint = useRef({ x: 0, y: 0, from: 'trigger' as 'trigger' | 'content' })
  const restoringFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const fullText = text.trim() ? text : summary
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined }
  const available = () => !!trigger.current && !disabled && !!fullText
    && (fullText !== summary || fullText.includes('\n') || trigger.current.scrollWidth > trigger.current.clientWidth
      || !![...trigger.current.children].some(child => child.scrollWidth > child.clientWidth))
  const close = (restore = false) => {
    cancel()
    setOpen(false)
    if (restore) {
      restoringFocus.current = true
      trigger.current?.focus({ preventScroll: true })
      queueMicrotask(() => { restoringFocus.current = false })
    }
  }
  const show = () => { cancel(); if (available()) setOpen(true) }
  const scheduleClose = () => {
    cancel()
    timer.current = setTimeout(() => {
      const active = document.activeElement
      const selection = window.getSelection()
      if (active === trigger.current || content.current?.contains(active)
        || (selection && !selection.isCollapsed && content.current?.contains(selection.anchorNode))) return
      setOpen(false)
    }, 180)
  }

  useEffect(() => () => cancel(), [])
  useEffect(() => { if (disabled) close() }, [disabled])
  useLayoutEffect(() => {
    if (!open || !content.current || !trigger.current) return
    const panel = content.current
    const anchor = trigger.current.getBoundingClientRect()
    const width = Math.min(432 + 40, window.innerWidth - 32)
    panel.style.width = `${width}px`
    const above = anchor.top - 30, below = window.innerHeight - anchor.bottom - 30
    const placeAbove = above >= 180 || above >= below
    panel.style.maxHeight = `${Math.max(40, placeAbove ? above : below)}px`
    const rect = panel.getBoundingClientRect()
    panel.style.left = `${Math.max(16, Math.min(anchor.left, window.innerWidth - rect.width - 16))}px`
    panel.style.top = `${Math.max(16, Math.min(window.innerHeight - rect.height - 16,
      placeAbove ? anchor.top - rect.height - 14 : anchor.bottom + 14))}px`
  }, [open, fullText])

  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null) => target instanceof Node
      && (trigger.current?.contains(target) || content.current?.contains(target))
    const pointerDown = (event: PointerEvent) => { if (!inside(event.target)) close() }
    const pointerMove = (event: PointerEvent) => {
      if (inside(event.target)) { cancel(); return }
      const a = trigger.current?.getBoundingClientRect(), b = content.current?.getBoundingClientRect()
      // Follow a triangle from the exit point to the destination's near edge.
      // This lets the pointer cross the gap without retaining unrelated hover areas.
      const destination = exitPoint.current.from === 'trigger' ? b : a
      if (a && b && destination) {
        const origin = exitPoint.current
        const edgeY = origin.y < destination.top ? destination.top : destination.bottom
        const cross = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)
        const x = event.clientX, y = event.clientY
        const d1 = cross(x, y, origin.x, origin.y, destination.left - 4, edgeY)
        const d2 = cross(x, y, destination.left - 4, edgeY, destination.right + 4, edgeY)
        const d3 = cross(x, y, destination.right + 4, edgeY, origin.x, origin.y)
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) { cancel(); return }
      }
      if (!timer.current) scheduleClose()
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close(true)
      }
      if (event.key === 'Tab' && event.target === trigger.current && !event.shiftKey) {
        event.preventDefault(); content.current?.focus({ preventScroll: true })
      } else if (event.key === 'Tab' && event.target === content.current) {
        if (event.shiftKey) { event.preventDefault(); trigger.current?.focus({ preventScroll: true }) }
        else {
          event.preventDefault()
          const focusables = [...document.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')]
            .filter(element => element.getClientRects().length && !content.current?.contains(element))
          const next = focusables[focusables.indexOf(trigger.current!) + 1]
          close()
          next?.focus({ preventScroll: true })
        }
      }
    }
    const focus = (event: FocusEvent) => { if (!inside(event.target)) close() }
    const resize = () => close()
    const scroll = (event: Event) => {
      if (event.target instanceof Element && event.target.contains(trigger.current)) close()
    }
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('pointermove', pointerMove)
    document.addEventListener('keydown', keyDown, true)
    document.addEventListener('focusin', focus)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('pointermove', pointerMove)
      document.removeEventListener('keydown', keyDown, true)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', resize)
    }
  }, [open])

  return <>
    <button type="button" ref={trigger} className="follow-up-preview-trigger composer-status-row-title"
      data-follow-up-preview="" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onPointerEnter={() => { cancel(); timer.current = setTimeout(show, 700) }}
      onPointerLeave={event => { exitPoint.current = { x: event.clientX, y: event.clientY, from: 'trigger' }; scheduleClose() }} onFocus={() => { if (!restoringFocus.current) show() }} onBlur={scheduleClose}
      onClick={show} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      }}>
      {children}
    </button>
    {open && typeof document !== 'undefined' ? createPortal(
      <div ref={content} id={id} role="dialog" aria-modal="false" aria-label={fullText}
        tabIndex={-1} className="follow-up-full-preview" onPointerEnter={cancel} onPointerLeave={event => { exitPoint.current = { x: event.clientX, y: event.clientY, from: 'content' }; scheduleClose() }}>
        <div className="follow-up-full-preview-text">{fullText}</div>
      </div>, document.body,
    ) : null}
  </>
}
