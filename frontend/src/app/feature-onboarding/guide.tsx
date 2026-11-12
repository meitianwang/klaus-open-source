// The post-upgrade guide: a full-screen page sequence introducing the release,
// closed by a reading-density choice.
//
// Behaviour contract (what the surface must do, independent of its look):
//
//   - Four content pages in a fixed scene order, then a fifth reading-mode page.
//     Turning a page ALWAYS takes user input: each page carries an artwork
//     timeline that drives its illustration and its progress only, never an
//     auto-advance. A timeline that翻页 by itself would spend pages on a user
//     who is still reading the previous one.
//   - Previous is disabled on the first page; Next on the last content page
//     leads to the reading page; Skip acknowledges the guide and closes it.
//   - Dots jump to any content page; the counter and the per-page progress fill
//     track the artwork timeline; the seek bar rewinds the current page's
//     timeline and leaves it paused until the next page change.
//   - Arrow keys and Home/End turn pages and move focus to Next; Escape
//     acknowledges and closes, the same as Skip.
//   - Reduced motion stops the timeline and the transitions; paging still works.
//   - The reading page persists its choice through the ledger, which is also
//     the moment the guide is acknowledged: dismissal, not first paint.
//
// The copy comes from resolveGuideContent: the shipped dictionary, overridden
// per locale by whatever the control plane published.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../i18n'
import type { ReadingMode } from '../../../../contracts/feature-onboarding'
import { guideInitialReadingMode } from './ledger'
import { guideLocale, resolveGuideContent } from './guide-content'
import { applyReadingMode } from './reading-mode'
import styles from './feature-onboarding.module.css'

export { applyReadingMode }

/** Format a page index as the counter reads: `01 / 04`. */
function counterText(index: number, total: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(index + 1)} / ${pad(total)}`
}

export function PostUpgradeGuide({ onFinish, onDismiss }: {
  onFinish: (mode: ReadingMode) => void
  onDismiss: () => void
}) {
  const locale = guideLocale()
  const content = useMemo(() => resolveGuideContent(locale), [locale])
  const pages = content.pages
  const labels = content.labels
  const pageCount = pages.length

  const [page, setPage] = useState(0)
  const [reading, setReading] = useState<ReadingMode>(
    guideInitialReadingMode() ?? 'comfortable',
  )
  const [paused, setPaused] = useState(false)
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [announce, setAnnounce] = useState('')

  const shellRef = useRef<HTMLDivElement | null>(null)
  const nextRef = useRef<HTMLButtonElement | null>(null)
  const seekRef = useRef<HTMLInputElement | null>(null)
  const elapsedRef = useRef(0)
  const seekPausedRef = useRef(false)
  const pageRef = useRef(page)
  pageRef.current = page

  // --- artwork timeline: rAF drives illustration + progress, never paging ---
  // The loop reads pause/reduce through refs so toggling them does not restart
  // the effect: a restart would reset the page's elapsed time and the artwork
  // would jump back to the chapter start.
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced

  useEffect(() => {
    if (page >= pageCount) return
    let frame = 0
    let last = performance.now()
    elapsedRef.current = 0
    const duration = pages[page].durationMs
    const chapterStart = pages.slice(0, page).reduce((sum, entry) => sum + entry.durationMs, 0)
    const totalDuration = pages.reduce((sum, entry) => sum + entry.durationMs, 0)
    const tick = (now: number) => {
      const dt = now - last
      last = now
      const held = pausedRef.current || reducedRef.current || seekPausedRef.current
      if (!held) elapsedRef.current = Math.min(duration, elapsedRef.current + dt)
      const pageProgress = duration > 0 ? elapsedRef.current / duration : 1
      const totalProgress = totalDuration > 0 ? (chapterStart + elapsedRef.current) / totalDuration : 1
      const shell = shellRef.current
      if (shell) {
        shell.style.setProperty('--page-progress', String(pageProgress))
        shell.style.setProperty('--total-progress', String(totalProgress))
      }
      // The seek thumb tracks the timeline from the loop rather than from
      // React state: a re-render per frame would remount the copy block.
      if (seekRef.current && document.activeElement !== seekRef.current) {
        seekRef.current.value = String(chapterStart + elapsedRef.current)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [page, pageCount, pages])

  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])

  // The shell owns the keyboard while the guide is up; without taking focus
  // the arrow keys would scroll the transcript behind it instead of paging.
  useEffect(() => {
    shellRef.current?.focus()
  }, [])

  const goTo = useCallback((index: number, focusNext: boolean) => {
    const clamped = Math.max(0, Math.min(pageCount - 1, index))
    seekPausedRef.current = false
    setPage(clamped)
    setAnnounce(t('onb_guide_page_announce')
      .replace('{i}', String(clamped + 1))
      .replace('{n}', String(pageCount))
      .replace('{label}', pages[clamped].eyebrow))
    if (focusNext) nextRef.current?.focus()
  }, [pageCount, pages])

  const toReading = useCallback(() => {
    seekPausedRef.current = false
    setPage(pageCount)
  }, [pageCount])

  // --- keyboard: arrows/Home/End page, Escape acknowledges and closes ---
  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const onKey = (event: KeyboardEvent) => {
      // Escape acknowledges and closes from any page, the reading page
      // included: it is the same decision as Skip, not a page turn.
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss()
        return
      }
      if (pageRef.current >= pageCount) return
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault()
          if (pageRef.current === pageCount - 1) toReading()
          else goTo(pageRef.current + 1, true)
          break
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault()
          goTo(pageRef.current - 1, true)
          break
        case 'Home':
          event.preventDefault()
          goTo(0, true)
          break
        case 'End':
          event.preventDefault()
          goTo(pageCount - 1, true)
          break
      }
    }
    shell.addEventListener('keydown', onKey)
    return () => shell.removeEventListener('keydown', onKey)
  }, [goTo, toReading, onDismiss, pageCount])

  const onSeek = (value: number) => {
    const chapterStart = pages.slice(0, page).reduce((sum, entry) => sum + entry.durationMs, 0)
    const within = Math.max(0, Math.min(pages[page].durationMs, value - chapterStart))
    elapsedRef.current = within
    seekPausedRef.current = true
  }

  const totalDuration = pages.reduce((sum, entry) => sum + entry.durationMs, 0)
  const chapterStart = pages.slice(0, page).reduce((sum, entry) => sum + entry.durationMs, 0)
  const onReadingPage = page >= pageCount
  const active = onReadingPage ? null : pages[page]

  return (
    <div className={styles['guide-backdrop']}>
      <div
        className={`${styles['guide-shell']}${reduced ? ` ${styles['guide-reduced']}` : ''}`}
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="klaus-guide-title"
        tabIndex={-1}
      >
        <span className={styles['guide-sr-only']} id="klaus-guide-title">{t('onb_guide_dialog_title')}</span>
        <div aria-live="polite" aria-atomic="true" className={styles['guide-sr-only']}>{announce}</div>

        {!onReadingPage && active ? (
          <>
            <div className={styles['guide-left']}>
              <div className={styles['guide-copy']} key={`${page}:${locale}`}>
                <span className={styles['guide-eyebrow']}>{active.eyebrow}</span>
                <h2 className={styles['guide-title']}>
                  {active.title.map((line, lineIndex) => (
                    <span className={styles['guide-title-line']} key={lineIndex}>
                      {active.emphasis && line.includes(active.emphasis) ? splitEmphasis(line, active.emphasis) : line}
                    </span>
                  ))}
                </h2>
                <p className={styles['guide-desc']}>{active.description}</p>
              </div>
              <div className={styles['guide-footer']}>
                <div className={styles['guide-controls']}>
                  <button
                    type="button"
                    className={styles['guide-round']}
                    onClick={() => goTo(page - 1, false)}
                    disabled={page === 0}
                    aria-label={labels.previous}
                  >‹</button>
                  <button
                    type="button"
                    className={styles['guide-primary']}
                    ref={nextRef}
                    onClick={() => (page === pageCount - 1 ? toReading() : goTo(page + 1, false))}
                  >
                    {labels.next} <span aria-hidden="true">›</span>
                  </button>
                </div>
                <button type="button" className={styles['guide-skip']} onClick={onDismiss}>
                  {labels.skip}
                </button>
              </div>
              <div className={styles['guide-ruler']}>
                <div className={styles['guide-dots']} role="group" aria-label={t('onb_guide_dialog_title')}>
                  {pages.map((entry, index) => (
                    <button
                      type="button"
                      key={entry.scene}
                      className={`${styles['guide-dot']}${index === page ? ` ${styles['guide-dot-current']}` : ''}`}
                      onClick={() => goTo(index, false)}
                      aria-label={t('onb_guide_page_announce')
                        .replace('{i}', String(index + 1))
                        .replace('{n}', String(pageCount))
                        .replace('{label}', entry.eyebrow)}
                    >
                      <i />
                    </button>
                  ))}
                </div>
                <span className={styles['guide-counter']}>{counterText(page, pageCount)}</span>
                <button
                  type="button"
                  className={styles['guide-play']}
                  onClick={() => setPaused(value => !value)}
                  aria-label={paused ? t('onb_guide_play') : t('onb_guide_pause')}
                  aria-pressed={paused}
                >
                  {paused ? '▶' : '❚❚'}
                </button>
                <input
                  type="range"
                  className={styles['guide-seek']}
                  ref={seekRef}
                  min={0}
                  max={totalDuration}
                  defaultValue={0}
                  onChange={event => onSeek(Number(event.target.value))}
                  aria-label={t('onb_guide_play')}
                />
              </div>
            </div>
            <div className={styles['guide-visual']} data-scene={active.scene} aria-hidden="true">
              <SceneArt scene={active.scene} />
            </div>
          </>
        ) : (
          <div className={styles['guide-reading']}>
            <span className={styles['guide-eyebrow']}>{labels.chooseReading}</span>
            <h2 className={styles['guide-reading-title']}>{labels.startTitle}</h2>
            <div className={styles['guide-reading-options']} role="radiogroup" aria-label={labels.chooseReading}>
              {(['comfortable', 'efficient'] as ReadingMode[]).map(mode => (
                <label className={styles['guide-reading-option']} key={mode}>
                  <input
                    type="radio"
                    name="klaus-reading-mode"
                    value={mode}
                    checked={reading === mode}
                    onChange={() => setReading(mode)}
                  />
                  <span className={styles['guide-reading-body']}>
                    <span className={styles['guide-reading-name']}>
                      {mode === 'comfortable' ? labels.comfortable : labels.efficient}
                    </span>
                    <span className={styles['guide-reading-hint']}>
                      {mode === 'comfortable' ? labels.comfortableHint : labels.efficientHint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className={styles['guide-reading-desc']}>
              {reading === 'comfortable' ? labels.readingDescriptionComfortable : labels.readingDescriptionEfficient}
            </p>
            <button type="button" className={styles['guide-primary']} onClick={() => onFinish(reading)}>
              {labels.start}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Split one title line around its emphasis substring, so the emphasized part
 *  can sweep in on its own layer. */
function splitEmphasis(line: string, emphasis: string) {
  const at = line.indexOf(emphasis)
  const before = line.slice(0, at)
  const after = line.slice(at + emphasis.length)
  return (
    <>
      {before}
      <span className={styles['guide-emphasis']} data-text={emphasis}>{emphasis}</span>
      {after}
    </>
  )
}

/** Line art per scene. Strokes follow the page timeline through the
 *  `--page-progress` custom property the rAF loop maintains, so the artwork
 *  and the progress fill can never disagree. */
function SceneArt({ scene }: { scene: string }) {
  switch (scene) {
    case 'overview':
      return (
        <svg viewBox="0 0 320 240" className={styles['guide-art']}>
          <rect x="80" y="30" width="160" height="180" rx="10" className={styles['art-surface']} />
          <rect x="100" y="56" width="120" height="8" rx="4" className={styles['art-line']} />
          <rect x="100" y="76" width="104" height="8" rx="4" className={styles['art-line']} />
          <rect x="100" y="96" width="112" height="8" rx="4" className={styles['art-line']} />
          <rect x="100" y="130" width="120" height="10" rx="5" className={styles['art-live']} />
          <circle cx="228" cy="135" r="7" className={styles['art-caret']} />
        </svg>
      )
    case 'collaboration':
      return (
        <svg viewBox="0 0 320 240" className={styles['guide-art']}>
          <circle cx="110" cy="70" r="18" className={styles['art-avatar']} />
          <circle cx="160" cy="70" r="18" className={styles['art-avatar-2']} />
          <circle cx="210" cy="70" r="18" className={styles['art-avatar-3']} />
          <rect x="70" y="110" width="180" height="90" rx="10" className={styles['art-surface']} />
          <rect x="86" y="128" width="90" height="10" rx="5" className={styles['art-chip-1']} />
          <rect x="86" y="150" width="120" height="10" rx="5" className={styles['art-chip-2']} />
          <rect x="86" y="172" width="70" height="10" rx="5" className={styles['art-chip-3']} />
        </svg>
      )
    case 'cocreation':
      return (
        <svg viewBox="0 0 320 240" className={styles['guide-art']}>
          <rect x="60" y="40" width="200" height="160" rx="10" className={styles['art-surface']} />
          <rect x="90" y="70" width="110" height="70" rx="6" className={styles['art-selection']} />
          <path d="M96 128 C 130 96, 160 132, 194 84" className={styles['art-stroke']} />
          <circle cx="194" cy="84" r="6" className={styles['art-caret']} />
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 320 240" className={styles['guide-art']}>
          <circle cx="160" cy="110" r="52" className={styles['art-surface-round']} />
          <path d="M160 78 V 110 L 186 126" className={styles['art-stroke']} />
          <circle cx="90" cy="180" r="10" className={styles['art-chip-1-round']} />
          <circle cx="160" cy="190" r="10" className={styles['art-chip-2-round']} />
          <circle cx="230" cy="180" r="10" className={styles['art-chip-3-round']} />
        </svg>
      )
  }
}
