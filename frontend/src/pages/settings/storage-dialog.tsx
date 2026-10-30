import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ModalPortal } from '../../components/ModalPortal'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import styles from './storage.module.css'

/** Native modal ownership keeps settings overlays, focus and Escape in one layer. */
export function StorageDialog({ title, description, children, footer, onClose, dismissible = true, wide = false, returnFocusId }: {
  title: string; description?: string; children?: ReactNode; footer?: ReactNode
  onClose(): void; dismissible?: boolean; wide?: boolean; returnFocusId?: string
}) {
  const t = useT()
  const titleId = useId(), descriptionId = useId()
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-storage-autofocus]')?.focus()
    return () => {
      dialog.close()
      const target = returnFocusId ? document.getElementById(returnFocusId) : previous
      if (target?.isConnected && target.getClientRects().length && !(target as HTMLButtonElement).disabled) target.focus()
    }
  }, [])
  return <ModalPortal>
    <dialog ref={ref} className={`${styles.dialog}${wide ? ` ${styles.wide}` : ''}`}
      role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
      onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
      onCancel={event => { event.preventDefault(); close.current() }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close.current()
      }}>
      <header className={styles.dialogHeader}>
        <h2 id={titleId}>{title}</h2>
        {description && <p id={descriptionId}>{description}</p>}
        {dismissible && <button type="button" className={styles.close} aria-label={t('storage_close')} onClick={onClose}><Icon name="close" size={16} /></button>}
      </header>
      <div className={styles.dialogBody}>{children}</div>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </dialog>
  </ModalPortal>
}

export function StorageButton({ children, busy = false, danger = false, tone = 'secondary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; danger?: boolean; tone?: 'secondary' | 'outline' | 'ghost' }) {
  return <button {...props} type={props.type ?? 'button'} aria-busy={busy || undefined} data-storage-autofocus={props.autoFocus || undefined} data-tone={tone}
    className={`${styles.button}${danger ? ` ${styles.danger}` : ''}${props.className ? ` ${props.className}` : ''}`}>
    {busy && <span className={styles.spinner} aria-hidden="true" />}{children}
  </button>
}

/** The menu stays inside its modal; a body portal would become inert behind it. */
export function StorageChoice({ id, label, value, options, onChange }: {
  id: string; label: string; value: string; options: Array<{ value: string; label: string }>; onChange(value: string): void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const focusOption = (index: number) => ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[index]?.focus()
  return <div ref={ref} className={styles.choice} onKeyDown={event => {
    if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); return }
    if (!open) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    if (event.key === 'Tab') { setOpen(false); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      focusOption(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length)
    }
  }}>
    <button ref={trigger} id={id} type="button" className={styles.choiceTrigger} aria-label={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined} onClick={() => setOpen(!open)}>
      {options.find(option => option.value === value)?.label}<Icon name="chevron-down" size={12} />
    </button>
    {open && <div id={`${id}-menu`} className={styles.choiceMenu} role="menu" aria-label={label}>
      {options.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={value === option.value}
        ref={node => { if (node && option.value === value) node.focus() }}
        onClick={() => { onChange(option.value); setOpen(false); trigger.current?.focus() }}>
        {option.label}{option.value === value && <Icon name="check" size={14} />}
      </button>)}
    </div>}
  </div>
}
