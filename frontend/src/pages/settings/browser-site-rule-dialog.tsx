import { useEffect, useId, useRef, useState } from 'react'
import { BROWSER_RESOURCES, browserOriginPattern, type BrowserAccess, type BrowserResource } from '../../../../contracts/browser-settings'
import { ModalPortal } from '../../components/ModalPortal'
import { useT } from '../../i18n'
import { RuntimeChoice } from './runtime-tab'
import styles from './browser-site-rule-dialog.module.css'

export type BrowserSiteRulePolicies = Partial<Record<BrowserResource, BrowserAccess | 'inherit'>>

const inheritAll = (): BrowserSiteRulePolicies => Object.fromEntries(BROWSER_RESOURCES.map(resource => [resource, 'inherit'])) as BrowserSiteRulePolicies
const resourceLabel = (t: (key: string) => string, resource: BrowserResource) => t(`browser_settings_resource_${resource}`)

export function BrowserSiteRuleDialog({ onAdd, onClose }: {
  onAdd: (pattern: string, policies: BrowserSiteRulePolicies) => Promise<boolean>
  onClose: () => void
}) {
  const t = useT()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [policies, setPolicies] = useState<BrowserSiteRulePolicies>(inheritAll)
  const [moreOpen, setMoreOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const pattern = browserOriginPattern(draft)
  const options = [
    { value: 'inherit', label: t('browser_settings_inherit') },
    { value: 'allow', label: t('browser_settings_allow') },
    { value: 'ask', label: t('browser_settings_ask') },
    { value: 'deny', label: t('browser_settings_deny') },
  ]
  const visibleResources = moreOpen ? BROWSER_RESOURCES : BROWSER_RESOURCES.slice(0, 1)

  useEffect(() => {
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || pending) return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [pending, onClose])

  const submit = async () => {
    if (!pattern) { setError(t('browser_settings_site_permission_invalid')); return }
    setError('')
    setPending(true)
    const ok = await onAdd(pattern, policies)
    setPending(false)
    if (ok) onClose()
    else setError(t('browser_settings_save_failed'))
  }

  return <ModalPortal>
    <div className="kls-modal-overlay" onClick={event => { if (event.target === event.currentTarget && !pending) onClose() }}>
      <div className={`kls-modal ${styles['site-modal']}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} data-site-rule-dialog="1" tabIndex={-1}>
        <button type="button" className={styles['site-close']} aria-label={t('cancel')} onClick={onClose}>×</button>
        <h2 id={titleId}>{t('browser_settings_site_dialog_title')}</h2>
        <p className={styles['site-description']}>{t('browser_settings_site_dialog_desc')}</p>
        <label className={styles['site-field']}>
          <span>{t('browser_settings_site_permission_origin')}</span>
          <input className={styles['site-input']} value={draft} placeholder={t('browser_settings_site_permission_origin_placeholder')} autoFocus onChange={event => { setDraft(event.target.value); setError('') }} />
        </label>
        {visibleResources.map(resource => (
          <div className={styles['site-field']} key={resource}>
            <span>{resourceLabel(t, resource)}</span>
            <RuntimeChoice id={`browser-site-rule-${resource}`} label={resourceLabel(t, resource)} value={policies[resource] ?? 'inherit'} options={options} onChange={value => setPolicies(current => ({ ...current, [resource]: value as BrowserAccess | 'inherit' }))} />
          </div>
        ))}
        {!moreOpen && <button type="button" className={styles['site-more']} onClick={() => setMoreOpen(true)}>{t('browser_settings_site_more')}</button>}
        {error && <p role="alert" className={styles['site-error']}>{error}</p>}
        <div className={styles['site-actions']}>
          <button type="button" disabled={pending} onClick={onClose}>{t('cancel')}</button>
          <button type="button" className={styles['site-primary']} disabled={pending || !pattern} onClick={() => { void submit() }}>{t('browser_settings_site_permission_add')}</button>
        </div>
      </div>
    </div>
  </ModalPortal>
}
