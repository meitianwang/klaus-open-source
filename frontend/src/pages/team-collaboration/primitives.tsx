import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ModalPortal } from '../../components/ModalPortal'
import { Icon } from '../../components/Icon'
import type { CollaborationMember } from './data'
import { COVER_COLORS, COVER_PALETTE, coverName } from './data'
import { projectCoverIconCatalog, randomProjectCoverIcon, searchProjectCoverIcons } from './project-cover-icons'

import { useT } from './i18n'
import styles from './team-collaboration.module.css'

export { Icon }
export function ErrorNotice({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  const t = useT()
  if (!error) return null
  return <div className={styles.error} role="alert"><Icon name="tc-warning" size={16} /><span>{error}</span>{onRetry && <button type="button" onClick={onRetry}>{t('tc_retry')}</button>}</div>
}
export function Loading() { const t = useT(); return <div className={styles.loading} role="status">{t('tc_loading')}</div> }

export function Modal({ title, children, onClose, wide = false, busy = false, headerActions, width }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; busy?: boolean; headerActions?: ReactNode; width?: number }) {
  const t = useT()
  const id = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  const locked = useRef(busy)
  close.current = onClose; locked.current = busy
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = dialog.current
    const targets = () => [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || [])].filter(node => node.getClientRects().length > 0)
    ;(root?.querySelector<HTMLElement>('[data-autofocus]') || targets()[0] || root)?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if ((event.target as Element)?.closest('[data-tc-popover="open"]')) return; event.preventDefault(); event.stopPropagation(); if (!locked.current) close.current(); return }
      if (event.key !== 'Tab') return
      const nodes = targets(), first = nodes[0], last = nodes[nodes.length - 1]
      if (!first) { event.preventDefault(); root?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus() }
  }, [])
  return <ModalPortal><div className={styles.modalOverlay} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} style={width ? { width, maxWidth: '100%' } : undefined} className={`${styles.modal} ${wide ? styles.modalWide : ''}`}>
      <header className={styles.modalHeader}><h2 id={id}>{title}</h2>{headerActions}<button type="button" className={styles.iconButton} aria-label={t('tc_close')} disabled={busy} onClick={onClose}><Icon name="tc-close" size={18} /></button></header>
      {children}
    </div>
  </div></ModalPortal>
}

export function Popover({ label, trigger, children, active = false, kind = 'menu' }: { label: string; trigger: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); active?: boolean; kind?: 'menu' | 'dialog' }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 500 })
  const id = useId()
  const close = () => { setOpen(false); button.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = button.current?.getBoundingClientRect(), box = panel.current?.getBoundingClientRect()
      if (!anchor || !box) return
      const maxHeight = Math.max(100, window.innerHeight - 16)
      const height = Math.min(box.height, maxHeight)
      const below = anchor.bottom + 5
      const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 5)
      const left = Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))
      setPosition(current => current.left === left && current.top === top && current.maxHeight === maxHeight ? current : { left, top, maxHeight })
    }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    const observer = new ResizeObserver(place)
    if (panel.current) observer.observe(panel.current)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[data-popover-content] input, [data-popover-content] button')?.focus()
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  return <div ref={root} className={styles.popoverRoot} data-tc-popover={open ? 'open' : undefined} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); close() }
    if ((event.target as HTMLElement).matches('input, textarea') || !open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-popover-content] button:not(:disabled)') || [])]
    const index = buttons.findIndex(item => item === document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault(); buttons[next]?.focus()
  }}>
    <button ref={button} type="button" className={`${styles.iconButton} ${active ? styles.activeControl : ''}`} aria-label={label} aria-haspopup={kind} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{trigger}</button>
    {open && <div ref={panel} id={id} role={kind} style={position} data-popover-content aria-label={label} className={`${styles.popover} ${kind === 'dialog' ? styles.iconPopover : ''}`}>{typeof children === 'function' ? children(close) : children}</div>}
  </div>
}

export function CoverIcon({ icon = 'gyro', color = 'Aurora', size = 20 }: { icon?: string; color?: string; size?: number }) {
  const safeIcon = projectCoverIconCatalog.some(item => item.id === icon) ? icon : 'gyro'
  return <span className={styles.coverIcon} data-color={coverName(color)}><Icon name={`tc-cover-${safeIcon}`} size={size} /></span>
}
export function CoverPicker({ icon, color, onChange }: { icon: string; color: string; onChange: (next: { coverIcon?: string; coverColor?: string }) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const matches = searchProjectCoverIcons(query)
  return <div className={styles.coverPicker}>
    <div className={styles.coverPickerHeader}><span>{t('tc_cover')}</span><Popover kind="dialog" label={t('tc_cover_icon')} trigger={<span className={styles.coverPickerLink}>{t('tc_select_icon')}</span>}>{close => <><div className={styles.iconSearch}><input aria-label={t('tc_search_icons')} placeholder={t('tc_search_icons')} value={query} onChange={event => setQuery(event.target.value)} /><button type="button" aria-label={t('tc_random_icon')} onClick={() => onChange({ coverIcon: randomProjectCoverIcon(icon) })}><Icon name="tc-dice" size={16} /></button></div><div className={styles.iconCount}><span>{t('tc_cover_icon')}</span><span>{matches.length}</span></div><div className={styles.iconChoices}>{matches.map(item => <button type="button" key={item.id} aria-label={window.currentLang === 'en' ? item.en : item.zh} aria-pressed={icon === item.id} onClick={() => { onChange({ coverIcon: item.id }); close() }}><Icon name={`tc-cover-${item.id}`} size={16} /></button>)}</div>{matches.length === 0 && <p className={styles.hint}>{t('tc_no_icons')}</p>}</>}</Popover></div>
    <fieldset className={styles.swatches} aria-label={t('tc_cover_color')}>{COVER_COLORS.map(value => <button type="button" key={value} aria-label={value} aria-pressed={coverName(color) === value} onClick={() => onChange({ coverColor: COVER_PALETTE[value] })}><CoverIcon icon={icon} color={value} /></button>)}</fieldset>
  </div>
}
export function MemberAvatar({ member }: { member: CollaborationMember }) {
  const name = member.agent?.name || member.user.displayName
  const avatar = member.agent?.avatarUrl || member.user.avatarUrl
  const safe = avatar && /^https?:\/\//i.test(avatar) ? avatar : null
  return <span className={styles.avatar} aria-label={name}>{safe ? <img src={safe} alt="" referrerPolicy="no-referrer" /> : member.kind === 'agent' ? <Icon name="tc-robot" size={15} /> : name.slice(0, 1).toUpperCase()}</span>
}
export function MemberAvatars({ members, total }: { members: CollaborationMember[]; total?: number }) {
  return <span className={styles.avatars}>{members.slice(0, 4).map(member => <MemberAvatar key={member.id} member={member} />)}{(total || members.length) > 4 && <span className={styles.avatar}>+{(total || members.length) - 4}</span>}</span>
}
