// Hover preview for one turn's recorded patch: the row's own unified diff,
// parsed locally and drawn above the row after a dwell delay. The layer is
// pointer-transparent and only built while open, so a transcript full of
// change rows costs nothing until a row is actually hovered.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Hunk } from '../../pages/diff/diff-render'
import { parseUnifiedDiff } from './turn-diff-parse'
import { effectiveViewportRight } from '../../app/native-overlay-inset'
import styles from './transcript.module.css'

const OPEN_DELAY_MS = 800

export function TurnDiffPreview({ diff, disabled, children }: {
  diff: string | null
  disabled: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const close = () => {
    clearTimer()
    setOpen(false)
  }

  useEffect(() => close, [])
  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('keydown', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('keydown', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  if (disabled || !diff) return <>{children}</>
  const enter = () => {
    clearTimer()
    timer.current = setTimeout(() => {
      const row = wrapRef.current?.firstElementChild as HTMLElement | null
      const rect = row?.getBoundingClientRect()
      if (!rect || !rect.width) return
      const rightLimit = effectiveViewportRight(rect.left)
      const width = Math.min(Math.max(320, rect.width - 64), Math.max(240, rightLimit - 16))
      const left = Math.max(8, Math.min(rect.left + 32, rightLimit - width - 8))
      setBox({ top: rect.top - 8, left, width })
      setOpen(true)
    }, OPEN_DELAY_MS)
  }
  return (
    <span ref={wrapRef} className={styles['tc-preview-wrap']} onPointerEnter={enter} onPointerLeave={close}>
      {children}
      {open && box ? (
        <span className={styles['tc-preview']} style={{ top: box.top, left: box.left, width: box.width }} role="tooltip">
          <span className={styles['tc-preview-body']}>
            {parseUnifiedDiff(diff).map((hunk, index) => <Hunk key={index} hunk={hunk} path={null} />)}
          </span>
        </span>
      ) : null}
    </span>
  )
}
