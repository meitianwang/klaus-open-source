import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n'
import { Icon } from '../../components/Icon'
import { openSiteReference, siteOpenTargets, type SiteOpenTarget, type SiteReference } from '../site-references'
import styles from './site-reference-card.module.css'

export function SiteReferenceCard({ reference, sessionId }: { reference: SiteReference; sessionId: string }) {
  const t = useT()
  const menuId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const [targets, setTargets] = useState<SiteOpenTarget[] | null>(null)
  const [preferred, setPreferred] = useState('in-app')
  const [menuError, setMenuError] = useState(false)
  const close = () => { setPosition(null); trigger.current?.focus() }
  useEffect(() => {
    if (!position) return
    let active = true
    setTargets(null)
    setMenuError(false)
    void siteOpenTargets().then(result => {
      if (!active) return
      setTargets(result.targets)
      setPreferred(result.preferredTarget)
    }).catch(() => { if (active) setMenuError(true) })
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null)
    }
    const dismiss = () => setPosition(null)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      active = false
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [position])
  useEffect(() => { if (position) menu.current?.focus() }, [position])
  useEffect(() => { if (targets && position) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus() }, [targets, position])
  const label = (target: SiteOpenTarget) => target.kind === 'in-app' ? t('site_reference_in_app')
    : target.kind === 'system-default' ? t('site_reference_system_default') : target.name
  // Every row leads with official artwork: the bundled product logo for the
  // in-app target, the resolved application icon for everything else.
  const icon = (target: SiteOpenTarget) => target.kind === 'in-app'
    ? <img src="logo.png" width="18" height="18" alt="" className={styles.menuIcon} />
    : target.iconDataUrl
      ? <img src={target.iconDataUrl} width="18" height="18" alt="" className={styles.menuIcon} />
      : <Icon name="browser" size={18} />
  const copy = async () => {
    close()
    try {
      await (window as any).klaus.clipboard.writeText(reference.url)
      ;(window as any).showToast?.(t('site_reference_copied'))
    } catch { (window as any).showToast?.(t('site_reference_copy_failed')) }
  }
  return <div className={styles.card} data-site-reference="true" data-site-url={reference.url} data-site-title={reference.title} data-site-turn={reference.turnId}>
    <button type="button" className={styles.body} aria-label={`${t('site_reference_open')}: ${reference.title} (${reference.url})`}
      onClick={() => { void openSiteReference(sessionId, reference.url) }}>
      <span className={styles.icon}><Icon name="tc-globe" size={24} /></span>
      <span className={styles.copy}><span className={styles.title}>{t('site_reference_title')}</span><span className={styles.subtitle}>{t('site_reference_website')}</span></span>
    </button>
    <button type="button" className={styles.trigger} ref={trigger} aria-haspopup="menu" aria-expanded={!!position} aria-controls={position ? menuId : undefined}
      onClick={() => {
        if (position) { close(); return }
        const box = trigger.current!.getBoundingClientRect()
        setPosition({ top: Math.min(box.bottom + 6, window.innerHeight - 240), right: Math.max(8, window.innerWidth - box.right) })
      }}>
      {t('site_reference_open_with')}<Icon name="chevron-down" size={14} />
    </button>
    {position ? createPortal(<div className={styles.menu} ref={menu} id={menuId} role="menu" tabIndex={-1} aria-label={t('site_reference_open_with')}
      style={{ top: Math.max(8, position.top), right: position.right }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); return }
        const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
          items[next]?.focus()
        }
        if (event.key === 'Tab') setPosition(null)
      }}>
      {!targets && !menuError ? <span className={styles.loading} role="status">{t('site_reference_loading')}</span> : null}
      {menuError ? <button type="button" role="menuitem" onClick={close}>{t('site_reference_unavailable')}</button> : null}
      {targets?.map(target => <button type="button" role="menuitem" key={target.id} onClick={() => { close(); void openSiteReference(sessionId, reference.url, target.id) }}>
        {icon(target)}
        <span>{label(target)}</span>{target.isDefault && target.kind !== 'system-default' ? <span className={styles.hint}>{t('site_reference_default')}</span> : null}
        {target.id === preferred ? <Icon name="check" size={14} /> : null}
      </button>)}
      <button type="button" role="menuitem" onClick={() => { void copy() }}><Icon name="copy" size={18} /><span>{t('site_reference_copy_link')}</span></button>
    </div>, document.body) : null}
  </div>
}
export function SiteReferenceCards({ references, sessionId }: { references: readonly SiteReference[]; sessionId: string }) {
  return <>{references.map(reference => <SiteReferenceCard key={reference.id} reference={reference} sessionId={sessionId} />)}</>
}
