import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import styles from './diff.module.css'
import wrapSvg from '@phosphor-icons/core/assets/regular/arrow-bend-down-left.svg?raw'
import unifiedSvg from '@phosphor-icons/core/assets/regular/rows.svg?raw'
import splitSvg from '@phosphor-icons/core/assets/regular/columns.svg?raw'
import collapseSvg from '@phosphor-icons/core/assets/regular/arrows-in-line-vertical.svg?raw'
import expandSvg from '@phosphor-icons/core/assets/regular/arrows-out-line-vertical.svg?raw'

export function ReviewIcon({ name }: { name: 'wrap' | 'unified' | 'split' | 'collapse' | 'expand' }) {
  return <span className={styles['review-control-icon']} aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: ({ wrap: wrapSvg, unified: unifiedSvg, split: splitSvg, collapse: collapseSvg, expand: expandSvg })[name] }} />
}

export function ReviewMenu({ label, icon, children, className = '', text, pressed }: {
  label: string; icon?: string; text?: ReactNode; className?: string; pressed?: boolean
  children: (close: () => void) => ReactNode
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = () => { setPosition(null); trigger.current?.focus({ preventScroll: true }) }
  useEffect(() => {
    if (!position) return
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled), input')?.focus()
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null)
    }
    const dismiss = () => setPosition(null)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', dismiss)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss) }
  }, [position])
  return <>
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(position)}
      aria-pressed={pressed} className={`${styles['review-button']} ${className}`}
      onClick={() => {
        if (position) { close(); return }
        const box = trigger.current!.getBoundingClientRect()
        setPosition({ top: box.bottom + 5, left: Math.max(8, Math.min(box.left, innerWidth - 288)) })
      }}>
      {icon ? <Icon name={icon} size={16} /> : null}{text}
    </button>
    {position ? createPortal(<div ref={menu} role="menu" aria-label={label} className={styles['review-menu']}
      style={{ top: position.top, left: position.left, maxHeight: Math.max(120, innerHeight - position.top - 12) }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); return }
        if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && (event.target as HTMLElement).tagName === 'SUMMARY') {
          event.preventDefault(); (event.target as HTMLElement).closest('details')!.open = event.key === 'ArrowRight'; return
        }
        if (event.key === 'Tab') { setPosition(null); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || (event.target as HTMLElement).tagName === 'INPUT') return
        const items = Array.from(menu.current!.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')).filter(item => {
          const details = item.closest('details')
          return item.getClientRects().length > 0 && (!details || details.open || item.tagName === 'SUMMARY' && item.parentElement === details)
        })
        if (!items.length) return
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        event.preventDefault(); items[next].focus()
      }}>
      {children(close)}
    </div>, document.body) : null}
  </>
}

export function MenuItem({ children, onClick, checked, disabled = false, icon }: {
  children: ReactNode; onClick: () => void; checked?: boolean; disabled?: boolean; icon?: string
}) {
  return <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked}
    disabled={disabled} className={styles['review-menu-item']} onClick={onClick}>
    {icon ? <Icon name={icon} size={16} /> : null}<span>{children}</span>
    {checked ? <Icon name="check" size={14} /> : null}
  </button>
}

export function ChangeStats({ added, removed, compact = false }: { added: number | null | undefined; removed: number | null | undefined; compact?: boolean }) {
  const label = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString()
  return <span className={styles['review-stats']}>
    {!compact || added !== 0 ? <span className={styles['diff-add']}>+{label(added)}</span> : null}
    {!compact || removed !== 0 ? <span className={styles['diff-del']}>-{label(removed)}</span> : null}
  </span>
}

export function FileFilter({ value, onChange, id = 'diff-search' }: { value: string; onChange: (value: string) => void; id?: string }) {
  const t = useT()
  return <div className={styles['review-filter']}>
    <Icon name="search" size={15} />
    <input id={id} type="search" role="searchbox" aria-label={t('changes_filter')} value={value}
      placeholder={t('changes_filter')} autoComplete="off" onChange={event => onChange(event.target.value)} />
    {value ? <button type="button" aria-label={t('clear')} onClick={() => onChange('')}><Icon name="diff-clear" size={14} /></button> : null}
  </div>
}
