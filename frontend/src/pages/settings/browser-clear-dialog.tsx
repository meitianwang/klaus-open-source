import { useEffect, useId, useRef, useState } from 'react'
import { ModalPortal } from '../../components/ModalPortal'
import { icon } from '../../icons/registry'
import { useT } from '../../i18n'
import shared from './settings.module.css'
import styles from './browser-clear-dialog.module.css'

/** Canonical list of clearable browsing data kinds, in dialog display order. */
export const BROWSER_CLEAR_KINDS = ['history', 'downloads', 'cookies', 'cache', 'siteData'] as const
export type BrowserClearKind = (typeof BROWSER_CLEAR_KINDS)[number]

const KIND_ICONS: Record<BrowserClearKind, string> = {
  history: 'import-history',
  downloads: 'import-downloads',
  cookies: 'import-cookies',
  cache: 'import-cache',
  siteData: 'import-site-data',
}

// Site data holds per-site permissions and preferences users often want to
// keep, so it starts unchecked while the routine cleanup kinds start checked.
const DEFAULT_SELECTED: Record<BrowserClearKind, boolean> = {
  history: true,
  downloads: true,
  cookies: true,
  cache: true,
  siteData: false,
}

export function BrowserClearDialog({ busy, onConfirm, onClose }: {
  busy: boolean
  onConfirm: (kinds: BrowserClearKind[]) => void
  onClose: () => void
}) {
  const t = useT()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Record<BrowserClearKind, boolean>>({ ...DEFAULT_SELECTED })
  const chosen = BROWSER_CLEAR_KINDS.filter(kind => selected[kind])

  useEffect(() => {
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [busy, onClose])

  return <ModalPortal>
    <div className="kls-modal-overlay" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div className={`kls-modal ${styles['clear-modal']}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} data-clear-dialog="1" tabIndex={-1}>
        <h2 id={titleId}>{t('browser_settings_clear_dialog_title')}</h2>
        <p className={styles['clear-description']}>{t('browser_settings_clear_dialog_desc')}</p>
        <div className={styles['clear-list']}>
          {BROWSER_CLEAR_KINDS.map(kind => <label key={kind} className={styles['clear-row']}>
            <span className={styles['clear-icon']} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(KIND_ICONS[kind], { size: 18 }) }} />
            <span className={styles['clear-copy']}>
              <span className={styles['clear-label']}>{t(`browser_settings_data_${kind}`)}</span>
              <span className={styles['clear-desc']}>{t(`browser_settings_data_${kind}_desc`)}</span>
            </span>
            <span className={shared['pref-switch']}>
              <input type="checkbox" data-clear-kind={kind} checked={selected[kind]} disabled={busy} onChange={event => setSelected(current => ({ ...current, [kind]: event.target.checked }))} />
              <span className={shared['pref-switch-track']} />
            </span>
          </label>)}
        </div>
        <div className={styles['clear-actions']}>
          <button type="button" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="button" className={styles['clear-confirm']} disabled={busy || chosen.length === 0} onClick={() => onConfirm([...chosen])}>{t(busy ? 'browser_settings_clearing' : 'browser_settings_clear_confirm')}</button>
        </div>
      </div>
    </div>
  </ModalPortal>
}
