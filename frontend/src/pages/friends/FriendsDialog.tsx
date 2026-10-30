import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ModalPortal } from '../../components/ModalPortal'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import styles from './friends.module.css'

export function FriendsDialog({ title, subtitle, onClose, children, footer, wide = false, closeDisabled = false }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; closeDisabled?: boolean
}) {
  const t = useT(), titleId = useId(), dialog = useRef<HTMLDivElement>(null), close = useRef(onClose)
  const locked = useRef(closeDisabled)
  close.current = onClose
  locked.current = closeDisabled
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const getFocusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex="0"]') ?? [])].filter(node => node.getClientRects().length)
    ;(dialog.current?.querySelector<HTMLElement>('[data-initial-focus]') ?? getFocusable()[0] ?? dialog.current)?.focus()
    const keyDown = (event: KeyboardEvent) => {
      if ([...document.querySelectorAll('[role="dialog"]')].at(-1) !== dialog.current) return
      if (event.key === 'Escape') { event.preventDefault(); if (!locked.current) close.current(); return }
      if (event.key !== 'Tab') return
      const items = getFocusable(), first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyDown)
    return () => { document.removeEventListener('keydown', keyDown); previous?.focus() }
  }, [])
  return <ModalPortal><div className="kls-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !closeDisabled) onClose() }}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`kls-modal ${wide ? styles.wideModal : ''}`}>
      <div className="kls-modal-head"><div><h2 className="kls-modal-title" id={titleId}>{title}</h2>{subtitle && <p className="kls-modal-subtitle">{subtitle}</p>}</div><button className="kls-modal-close" aria-label={t('friends_close')} disabled={closeDisabled} onClick={onClose}><Icon name="close" /></button></div>
      <div className="kls-modal-body">{children}</div>{footer && <div className={`kls-modal-foot ${styles.dialogFooter}`}>{footer}</div>}
    </div>
  </div></ModalPortal>
}

export function FriendAvatar({ name, url, large = false, small = false }: { name: string; url: string | null; large?: boolean; small?: boolean }) {
  const [failed, setFailed] = useState(false)
  const t = useT()
  const baseName = name.trim() === t('friends_no_nickname') ? '' : name.trim()
  const initial = baseName.match(/[\p{L}\p{N}]/u)?.[0] ?? ''
  useEffect(() => setFailed(false), [url])
  return <span className={`${styles.avatar} ${large ? styles.avatarLarge : ''} ${small ? styles.avatarSmall : ''}`} aria-hidden="true">
    <span>{initial || <Icon name="sb-nav-friends" size={22} />}</span>{url && !failed && <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
  </span>
}
