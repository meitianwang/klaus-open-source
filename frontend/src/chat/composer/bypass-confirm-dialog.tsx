// Confirmation dialog shown before the composer switches to the full-access
// permission preset. The preset lifts the sandbox and every approval prompt,
// so the dialog spells out what that covers — files anywhere on this machine,
// shell commands, and the network — before the switch is allowed through.
// It reuses the shared klaus-dialog shell classes (overlay / card / title /
// footer) so it reads as the same dialog family the rest of the app shows,
// with the warning colour carried by the client's own danger tokens.
import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import { desktopSiteUrl } from '../../app/distribution'
import styles from './composer.module.css'

const CAPABILITIES: { icon: string; titleKey: string; descKey: string }[] = [
  { icon: 'folder', titleKey: 'perm_bypass_scope_files', descKey: 'perm_bypass_scope_files_desc' },
  { icon: 'terminal', titleKey: 'perm_bypass_scope_shell', descKey: 'perm_bypass_scope_shell_desc' },
  { icon: 'tc-globe', titleKey: 'perm_bypass_scope_network', descKey: 'perm_bypass_scope_network_desc' },
]

export function BypassConfirmDialog({ onDecision, translate }: {
  onDecision: (confirmed: boolean) => void
  translate: (key: string) => string
}) {
  const titleId = useId()
  const messageId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    // Destructive confirmations start on the safe button: focus landing on
    // the red confirm would let one stray space key lift every guard.
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onDecision(false)
      } else if (event.key === 'Enter') {
        // Enter confirms from anywhere in the card, matching the shared
        // dialog's keyboard behaviour without depending on focus order.
        event.preventDefault()
        event.stopPropagation()
        onDecision(true)
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

  const openDocs = () => {
    void (window as any).klaus?.app?.openExternal?.(desktopSiteUrl('/docs/desktop/plan-and-permission'))
  }

  return createPortal(
    <div className="klaus-dialog-overlay active">
      <div className="klaus-dialog-backdrop" onClick={() => onDecision(false)} />
      <div className={`klaus-dialog-card ${styles['bypass-confirm-card']}`} ref={cardRef}
        role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
        <div className="klaus-dialog-title" id={titleId}>
          <span className="klaus-dialog-title-icon" aria-hidden="true">
            <Icon name="sys-auth-shield-warn" size={15} />
          </span>
          <span>{translate('perm_bypass_dialog_title')}</span>
        </div>
        <div className="klaus-dialog-message" id={messageId}>{translate('perm_bypass_dialog_message')}</div>
        <div className={styles['bypass-confirm-scopes']}>
          {CAPABILITIES.map(scope => (
            <div className={styles['bypass-confirm-scope']} key={scope.titleKey}>
              <span className={styles['bypass-confirm-scope-icon']} aria-hidden="true">
                <Icon name={scope.icon} size={16} />
              </span>
              <span className={styles['bypass-confirm-scope-copy']}>
                <span className={styles['bypass-confirm-scope-title']}>{translate(scope.titleKey)}</span>
                <span className={styles['bypass-confirm-scope-desc']}>{translate(scope.descKey)}</span>
              </span>
            </div>
          ))}
        </div>
        <div className={`klaus-dialog-message ${styles['bypass-confirm-risk']}`}>
          {translate('perm_bypass_dialog_risk')}{' '}
          <button type="button" className={styles['bypass-confirm-learn-more']} onClick={openDocs}>
            {translate('perm_bypass_dialog_learn_more')}
          </button>
        </div>
        <div className="klaus-dialog-footer">
          <button type="button" ref={cancelRef} className="klaus-dialog-btn klaus-dialog-cancel"
            onClick={() => onDecision(false)}>{translate('cancel')}</button>
          <button type="button" className="klaus-dialog-btn klaus-dialog-confirm klaus-dialog-danger"
            onClick={() => onDecision(true)}>
            <Icon name="sys-auth-shield-warn" size={14} />
            <span>{translate('perm_bypass_dialog_confirm')}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
