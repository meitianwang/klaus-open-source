import { useEffect, useId, useRef } from 'react'
import { Icon } from '../../components/Icon'
import type { UltraAccessDecision } from './ultra-selection'
import styles from './composer.module.css'

export function UltraAccessDialog({ onDecision, translate, titleKey = 'ultra_full_access_title', messageKey = 'ultra_full_access_message' }: {
  onDecision: (decision: UltraAccessDecision) => void
  translate: (key: string) => string
  titleKey?: string
  messageKey?: string
}) {
  const titleId = useId()
  const messageId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    continueRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onDecision('cancel')
      } else if (event.key === 'Tab') {
        const buttons = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>('button') || [])
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected) previous.focus()
    }
  }, [onDecision])
  return (
    <div className="klaus-dialog-overlay active">
      <div className="klaus-dialog-backdrop" onClick={() => onDecision('cancel')} />
      <div className={`klaus-dialog-card ${styles['ultra-access-card']}`} ref={cardRef}
        role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
        <button type="button" className={styles['ultra-access-close']} aria-label={translate('close')}
          onClick={() => onDecision('cancel')}><Icon name="tc-close" size={16} /></button>
        <div className="klaus-dialog-title" id={titleId}>{translate(titleKey)}</div>
        <div className="klaus-dialog-message" id={messageId}>{translate(messageKey)}</div>
        <div className={`klaus-dialog-footer ${styles['ultra-access-footer']}`}>
          <button type="button" className="klaus-dialog-btn klaus-dialog-confirm klaus-dialog-danger"
            onClick={() => onDecision('full-access')}>{translate('ultra_full_access_use')}</button>
          <button type="button" ref={continueRef} className="klaus-dialog-btn klaus-dialog-confirm"
            onClick={() => onDecision('restricted')}>{translate('ultra_full_access_continue')}</button>
        </div>
      </div>
    </div>
  )
}
