// Update presentations, reading one shared snapshot so no two surfaces can
// disagree about the phase:
//   - the persistent sidebar card for available, downloading, and ready offers,
//   - the centered installation hand-off, raised only once installation begins.
import { Fragment, useCallback, useEffect, useId, useRef, useSyncExternalStore } from 'react'
import { Icon } from '../../components/Icon'
import { ModalPortal } from '../../components/ModalPortal'
import { useT } from '../../i18n'
import { displayPercent, formatBytes, remainingTime, type UpdateProgress, type UpdateStatus } from './model'
import {
  deferUpdate, downloadUpdate, installUpdate, subscribeUpdate, updateSnapshot,
  type UpdateSnapshot,
} from './store'
import styles from './update.module.css'

export function useUpdateSnapshot(): UpdateSnapshot {
  return useSyncExternalStore(subscribeUpdate, updateSnapshot, updateSnapshot)
}

function fill(template: string, values: Record<string, string>): string {
  let text = template
  for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(value)
  return text
}

/**
 * Focus lands inside the dialog, Tab stays inside it, and focus returns to the
 * opener on close. Escape runs the surface's own dismissal when supplied.
 */
function useDialogFocus(onEscape?: () => void) {
  const container = useRef<HTMLDivElement>(null)
  const escape = useRef(onEscape)
  escape.current = onEscape
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const buttons = () => Array.from(container.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (buttons()[0]) buttons()[0]!.focus()
    else container.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && escape.current) {
        event.preventDefault(); event.stopPropagation(); escape.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = buttons()
      const first = focusable[0], last = focusable.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (previous?.isConnected && !previous.matches(':disabled,[aria-disabled=true]')) previous.focus()
    }
  }, [])
  return container
}

function remainingShortLabel(progress: UpdateProgress | null | undefined, t: (key: string) => string): string {
  const value = remainingTime(progress?.bytesPerSecond ?? 0, progress?.transferred ?? 0, progress?.total ?? 0)
  if (value.kind === 'calculating') return t('update_time_calculating')
  const unit = value.kind === 'seconds'
    ? fill(t('update_time_seconds'), { count: String(value.count) })
    : value.kind === 'minutes'
      ? fill(t('update_time_minutes'), { count: String(value.count) })
      : fill(t('update_time_hours_minutes'), { hours: String(value.hours), minutes: String(value.minutes) })
  return fill(t('update_time_remaining_short'), { time: unit })
}

/** Squircle app badge anchoring the installation dialog to the Klaus brand mark. */
function UpdateAppBadge() {
  return (
    <span className={styles.appBadge} aria-hidden="true">
      <svg viewBox="0 0 48 48" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="3.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M24 5 38.5 13v16.5L24 37.5 18.5 42v-7.8L9.5 29.5V13Z" />
        <path d="M18 17.5 25.5 23 18 28.5M30.5 17v12" />
      </svg>
    </span>
  )
}

const INSTALL_STEPS = ['preparing', 'installing', 'restarting'] as const

/** Installation ends in a restart, so it explains the wait and offers no exit. */
export function UpdateInstallingOverlay({ status }: { status: UpdateStatus | null }) {
  const t = useT()
  const titleId = useId()
  const container = useDialogFocus()
  const percent = displayPercent(status?.progress)
  const version = status?.availableVersion ?? ''
  // The host reports its own milestones; the bar position picks the active step
  // so the labels and the bar can never disagree.
  const active = percent >= 97 ? 2 : percent >= 88 ? 1 : 0
  return <ModalPortal>
    <div className={styles.backdrop}>
      <div className={styles.dialog} ref={container} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-surface="update-installing">
        <div className={styles.head}>
          <UpdateAppBadge />
          <div className={styles.headText}>
            <h2 className={styles.title} id={titleId}>{version ? fill(t('update_installing_title_version'), { version }) : t('update_installing_title')}</h2>
            <p className={styles.subtitle}>{t('update_installing_body')}</p>
          </div>
        </div>
        <div className={styles.installBody}>
          <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t('update_installing_title')}>
            <div className={`${styles.fill} ${styles.fillActive}`} style={{ width: `${Math.max(8, percent)}%` }} />
          </div>
          <div className={styles.steps}>
            {INSTALL_STEPS.map((step, index) => {
              const done = index < active
              const current = index === active
              return (
                <Fragment key={step}>
                  {index > 0 && <span className={`${styles.stepConnector} ${index <= active ? styles.stepConnectorActive : ''}`} aria-hidden="true" />}
                  <div className={`${styles.step} ${done ? styles.stepDone : current ? styles.stepActive : ''}`}>
                    <span className={styles.stepMarker} aria-hidden="true">
                      {done ? (
                        <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2.25 6.25 4.85 8.85 9.75 3.5" />
                        </svg>
                      ) : current ? (
                        <span className={styles.stepSpinner} />
                      ) : (
                        <span className={styles.stepDot} />
                      )}
                    </span>
                    <span className={styles.stepLabel}>{t(`update_step_${step}`)}</span>
                  </div>
                </Fragment>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  </ModalPortal>
}

/**
 * The persistent sidebar card: announces available updates when automatic
 * downloads are off, reports transfer progress quietly while downloading, and
 * offers the restart action once the download finishes.
 */
export function UpdateBanner({ status, surfaces, pending, downloadingPending = false }: {
  status: UpdateStatus | null
  surfaces: { banner: boolean }
  pending: boolean
  downloadingPending?: boolean
}) {
  const t = useT()
  const state = status?.state
  const available = state === 'available'
  const downloading = state === 'downloading'
  const version = status?.availableVersion ?? ''
  const progress = status?.progress ?? null
  const percent = displayPercent(progress)
  const onDownload = useCallback(() => { void downloadUpdate().catch(() => {}) }, [])
  const onInstall = useCallback(() => { void installUpdate() }, [])
  if (!surfaces.banner) return null
  const cardState = downloading ? 'downloading' : available ? 'available' : 'ready'
  const title = downloading
    ? (version ? fill(t('update_banner_downloading_version'), { version }) : t('update_banner_downloading'))
    : (version ? fill(t('update_banner_available'), { version }) : t('update_banner_ready'))
  return <div className={styles.banner} data-surface="update-banner" data-state={cardState}>
    <div className={styles.bannerHead}>
      <span className={styles.bannerArt} aria-hidden="true"><Icon name="sidebar-user-update" /></span>
      <div className={styles.bannerText}>
        <div className={styles.bannerTitleRow}>
          <div className={styles.bannerTitle}>{title}</div>
          {downloading && <span className={styles.bannerPercent}>{percent}%</span>}
        </div>
        {downloading ? (
          <div className={styles.bannerMeta}>
            <span className={styles.bannerSize}>{formatBytes(progress?.transferred ?? 0)} / {formatBytes(progress?.total ?? 0)}</span>
            <span className={styles.bannerEta}>· {remainingShortLabel(progress, t)}</span>
          </div>
        ) : (
          <div className={styles.bannerDesc}>
            {available ? t('update_banner_available_desc') : t('update_banner_ready_desc')}
          </div>
        )}
      </div>
    </div>
    {downloading ? (
      <div className={`${styles.track} ${styles.bannerTrack}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t('update_header_downloading')}>
        <div className={`${styles.fill} ${styles.fillActive}`} style={{ width: `${percent}%` }} />
      </div>
    ) : (
      <div className={styles.bannerActions}>
        {available
          ? <button type="button" className="btn-sm btn-primary" data-action="update-download" disabled={downloadingPending} onClick={onDownload}>{downloadingPending ? t('update_banner_downloading') : t('update_download_action')}</button>
          : <button type="button" className="btn-sm btn-primary" data-action="update-install" disabled={pending} onClick={onInstall}>{pending ? t('update_preparing') : t('update_restart')}</button>}
        <button type="button" className="btn-sm" data-action="update-later" disabled={available ? downloadingPending : pending} onClick={deferUpdate}>{t('update_later')}</button>
      </div>
    )}
  </div>
}

/** Modal installation hand-off, mounted once per renderer. */
export function UpdateOverlays() {
  const { status, surfaces } = useUpdateSnapshot()
  return <>
    {surfaces.installingOverlay && <UpdateInstallingOverlay status={status} />}
  </>
}
