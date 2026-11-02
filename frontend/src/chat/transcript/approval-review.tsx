import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { approvalReviewActionSummary, type ApprovalReview, type ApprovalReviewAction } from '../../../../contracts/approval-review'
import { useT } from '../../i18n'
import { Icon } from '../../components/Icon'
import styles from './approval-review.module.css'
import menuStyles from '../composer/composer.module.css'
import { approvalReviewDenials, deniedApprovalReview, approvalReviewPending, approvalReviewRevision, approveDeniedReview, subscribeApprovalReviews, type DeniedApprovalReview } from '../approval-review-state'

function actionSummary(action: ApprovalReviewAction, t: (key: string) => string): string {
  const format = (key: string, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), t(key))
  switch (action.type) {
    case 'writeStdin': return format('approval_review_action_stdin', { processId: action.processId, stdin: action.stdin })
    case 'applyPatch': return action.files.length === 1 ? format('approval_review_action_file', { file: action.files[0] }) : format('approval_review_action_files', { count: action.files.length })
    case 'networkAccess': return format('approval_review_action_network', { target: action.target })
    case 'mcpToolCall': return format('approval_review_action_mcp', { toolName: action.toolName, connector: action.connectorName ?? action.server })
    case 'browserToolCall': return format('approval_review_action_browser', { toolName: action.toolName })
    case 'requestPermissions': return action.reason == null ? t('approval_review_action_permissions') : format('approval_review_action_permissions_reason', { reason: action.reason })
    default: return approvalReviewActionSummary(action)
  }
}

export function ApprovalReviewDetails({ review }: { review: ApprovalReview }) {
  const t = useT()
  const title = t(review.status === 'denied' && review.riskLevel === 'high' ? 'approval_review_denied_high' : `approval_review_${review.status}`)
  const summary = review.rationale?.trim() || t(`approval_review_summary_${review.status === 'inProgress' || review.status === 'aborted' || review.status === 'timedOut' ? review.status : 'completed'}`)
  return <details className={styles.details}>
    <summary className={styles.status} data-review-risk={review.riskLevel}>{title}</summary>
    <p className={styles.rationale}>{summary}</p>
  </details>
}

export function ApprovalReviewCard({ review }: { review: ApprovalReview }) {
  const t = useT()
  return <details className={styles.review} data-review-id={review.reviewId} data-review-status={review.status} data-target-item-id={review.targetItemId}
    data-turn-id={review.turnId} aria-live={review.status === 'inProgress' ? 'polite' : undefined}>
    <summary className={styles.heading}><Icon name="permission-review" size={15} /><span>{actionSummary(review.action, t)}</span></summary>
    {review.status === 'denied' ? <p className={styles.rationale}>{t(review.riskLevel === 'high' ? 'approval_review_explicit_high' : 'approval_review_explicit')}</p> : <ApprovalReviewDetails review={review} />}
  </details>
}

export function ApprovalReviewAuthorization({ sessionId, review }: { sessionId: string; review: ApprovalReview }) {
  const t = useT()
  useSyncExternalStore(subscribeApprovalReviews, () => approvalReviewRevision(sessionId), () => 0)
  const selected = deniedApprovalReview(sessionId, review.reviewId)
  const pending = approvalReviewPending(sessionId)
  if (!selected) return null
  const approve = async () => {
    try {
      if (await approveDeniedReview(sessionId, selected, event => (window as any).klaus.approvalReview.approve(sessionId, event))) (window as any).showToast?.(t('approval_review_recorded'))
    } catch { (window as any).showToast?.(t('approval_review_record_failed')) }
  }
  return <div className={styles.authorization}>
    <p className={styles.authorizationHeading}>{t('approval_review_what_approval_allows')}</p>
    <div className={styles.authorizationAction}><p>{t('approval_review_approval_effect')}</p>
      <button type="button" className={styles.approve} data-review-approve={review.reviewId} disabled={pending !== null}
        onClick={event => { event.stopPropagation(); void approve() }}>{t(pending === review.reviewId ? 'approval_review_approving' : 'approval_review_approve')}</button>
    </div>
  </div>
}

export function ApprovalReviewToolDetails({ sessionId, reviews, declined, readOnly = false }: { sessionId: string; reviews: ApprovalReview[]; declined: boolean; readOnly?: boolean }) {
  const t = useT()
  const denied = declined ? reviews.findLast(review => review.status === 'denied') : undefined
  return <div className={styles.toolDetails}>
    {denied ? <><p className={styles.authorizationHeading}>{t('approval_review_why_denied')}</p><p className={styles.rationale}>{denied.rationale?.trim() || t('approval_review_no_denial_rationale')}</p>
      {!readOnly && <ApprovalReviewAuthorization sessionId={sessionId} review={denied} />}</> : reviews.map(review => <ApprovalReviewDetails key={review.reviewId} review={review} />)}
  </div>
}

export function ApprovalReviewNotice({ kind }: { kind: 'strictReviewRequired' | 'tooManyDenials' }) {
  const t = useT()
  return <div className={styles.notice} data-review-notice={kind} role={kind === 'strictReviewRequired' ? 'status' : undefined} aria-live={kind === 'strictReviewRequired' ? 'polite' : undefined}>
    <Icon name="sys-auth-shield-warn" size={15} /><span>{t(`approval_review_notice_${kind}`)}</span>
    {kind === 'tooManyDenials' && <button type="button" className={styles.info} aria-label={t('approval_review_interruption_details')}
      data-klaus-tip={t('approval_review_interruption_next_steps')}><Icon name="approval-review-info" size={12} /></button>}
  </div>
}

export function ApprovalReviewDenialsMenu({ sessionId, close, currentSessionId }: { sessionId: string; close(): void; currentSessionId(): string | null }) {
  const t = useT()
  const mounted = useRef(true)
  useSyncExternalStore(subscribeApprovalReviews, () => approvalReviewRevision(sessionId), () => 0)
  const rows = approvalReviewDenials(sessionId)
  const pending = approvalReviewPending(sessionId)
  const current = () => mounted.current && currentSessionId() === sessionId
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [sessionId])
  const approve = async (selected: DeniedApprovalReview) => {
    if (!current()) return
    try {
      const accepted = await approveDeniedReview(sessionId, selected, event => (window as any).klaus.approvalReview.approve(sessionId, event))
      if (!accepted || !current()) return
      close()
      ;(window as any).showToast?.(t('approval_review_recorded'))
    } catch { if (current()) (window as any).showToast?.(t('approval_review_record_failed')) }
  }
  return <div data-approval-review-menu={sessionId} role="listbox" aria-label={t('approval_review_denials_title')} aria-busy={pending !== null}>
    <div className={menuStyles['slash-menu-group']}>{t('approval_review_denials_description')}</div>
    {rows.length === 0 && <p>{t('approval_review_no_denials')}</p>}
    {rows.map((row, index) => <button type="button" role="option" key={row.review.reviewId} data-review-choice={row.review.reviewId}
      aria-selected={index === 0} disabled={pending !== null} className={`${menuStyles['slash-menu-item']} kls-select-item ${styles.choice}${index === 0 ? ' active' : ''}`} onClick={() => void approve(row)}>
      <span className={menuStyles['slash-menu-copy']}><span className={menuStyles['slash-menu-item-name']}>{actionSummary(row.review.action, t)}</span>
        <span className={menuStyles['slash-menu-item-desc']}>{pending === row.review.reviewId ? t('approval_review_recording') : row.review.rationale ?? t('approval_review_no_rationale')}</span>
      </span>
    </button>)}
  </div>
}

let closeActiveReviewMenu: (() => void) | undefined
export function openApprovalReviewDenials(sessionId: string, currentSessionId: () => string | null, anchor: HTMLElement): void {
  closeActiveReviewMenu?.()
  const host = document.createElement('div')
  host.className = 'slash-menu kls-select-panel'
  host.style.position = 'fixed'
  const position = () => {
    if (!anchor.isConnected) { close(); return }
    const rect = anchor.getBoundingClientRect()
    const width = Math.min(560, innerWidth - 16)
    host.style.width = `${width}px`
    host.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`
    host.style.bottom = `${Math.max(8, innerHeight - rect.top + 6)}px`
    host.style.maxHeight = `${Math.max(0, rect.top - 16)}px`
  }
  document.body.appendChild(host)
  const root = createRoot(host)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    if (closeActiveReviewMenu === close) closeActiveReviewMenu = undefined
    observer.disconnect()
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onPointer, true)
    window.removeEventListener('klaus:session-change', onSession)
    window.removeEventListener('resize', position)
    window.removeEventListener('scroll', position, true)
    queueMicrotask(() => { root.unmount(); host.remove() })
  }
  const onSession = () => { if (currentSessionId() !== sessionId) close() }
  const onPointer = (event: PointerEvent) => { if (!host.contains(event.target as Node) && !anchor.contains(event.target as Node)) close() }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      event.stopPropagation(); close()
    } else if (event.key === 'Enter' && !host.contains(event.target as Node)) {
      event.preventDefault(); event.stopPropagation()
      host.querySelector<HTMLButtonElement>('[data-review-choice]:not(:disabled)')?.click()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      const items = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-review-choice]:not(:disabled)'))
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const index = current < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[index]?.focus()
    }
  }
  const observer = new ResizeObserver(position)
  observer.observe(anchor)
  closeActiveReviewMenu = close
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('klaus:session-change', onSession)
  window.addEventListener('resize', position)
  window.addEventListener('scroll', position, true)
  position()
  root.render(<ApprovalReviewDenialsMenu sessionId={sessionId} currentSessionId={currentSessionId} close={close} />)
}
