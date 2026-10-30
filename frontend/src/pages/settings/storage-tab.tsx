import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { intlLocale, useT } from '../../i18n'
import { SettingsPage } from './kv'
import { StorageButton, StorageChoice, StorageDialog } from './storage-dialog'
import { loadSettingsTab } from './shell'
import { REVIEW_DAY_OPTIONS, REVIEW_PAGE_SIZE, categoryCompleted, cleanupReady, displayCategories,
  eligibleReviewRows, formatStorageBytes, reviewCutoffMs, selectionSubagentTotal,
  type StorageReviewRowWire, type StorageSnapshotWire } from './storage-model'
import styles from './storage.module.css'

const w = () => window as any
const categoryKeys: Record<string, string> = { threads: 'threads', subagents: 'subagents', archived: 'archived', worktrees: 'worktrees', other: 'other' }

function UsagePanel({ snapshot, scanning, loadError, onRefresh }: {
  snapshot: StorageSnapshotWire | null; scanning: boolean; loadError: boolean; onRefresh(): void
}) {
  const t = useT(), usage = snapshot?.usage
  const total = usage ? formatStorageBytes(usage.totalBytes, intlLocale()) : ''
  const failed = loadError || snapshot?.status === 'error'
  const totalLabel = !usage ? t('storage_home_label') : snapshot?.measuredAt == null && snapshot?.status !== 'ready'
    ? t('storage_measured_total').replace('{size}', total) : t('storage_total').replace('{size}', total)
  return <div className={styles.usage}>
    <div className={styles.totalRow}>
      <p id="storage-total-label" className={styles.total}>{totalLabel}</p>
      <StorageButton id="storage-refresh-button" busy={scanning} disabled={scanning} onClick={onRefresh}>{t(scanning ? 'storage_updating' : 'storage_refresh')}</StorageButton>
    </div>
    {!usage && scanning && <div className={styles.skeleton} role="progressbar" aria-label={t('storage_measuring')} />}
    {failed && <p role="alert" className={styles.error}>{t('storage_load_error')}</p>}
    {usage && <>
      <div className={styles.bar} role="img" aria-labelledby="storage-total-label">
        {displayCategories(usage.categories).map(segment => <div key={segment.category} data-storage-segment={segment.category}
          className={styles[segment.category]} style={{ width: `${usage.totalBytes > 0 ? segment.bytes / usage.totalBytes * 100 : 0}%` }} />)}
      </div>
      <ul className={styles.legend}>
        {displayCategories(usage.categories).map(segment => <li key={segment.category}>
          <span className={styles.legendName}><span aria-hidden="true" className={`${styles.dot} ${styles[segment.category]}`} />{t(`storage_category_${categoryKeys[segment.category]}`)}</span>
          <span className={styles.legendSize}>{snapshot && categoryCompleted(snapshot, segment.category) ? formatStorageBytes(segment.bytes, intlLocale())
            : t(failed ? 'storage_category_incomplete' : 'storage_category_updating').replace('{size}', formatStorageBytes(segment.bytes, intlLocale()))}</span>
        </li>)}
      </ul>
      <p className={styles.home}>{usage.home}</p>
    </>}
  </div>
}

export function StorageReviewDialog({ inventory, onClose, onConfirm }: {
  inventory: StorageReviewRowWire[]; onClose(): void
  onConfirm(selection: Array<{ id: string; updatedAt: number }>, cutoffMs: number, archivedOnly: boolean): void
}) {
  const t = useT(), openedAt = useRef(Date.now()).current
  const [days, setDays] = useState(90), [archivedOnly, setArchivedOnly] = useState(true)
  const [visible, setVisible] = useState(REVIEW_PAGE_SIZE), [confirmOpen, setConfirmOpen] = useState(false)
  const cutoff = reviewCutoffMs(days, openedAt)
  const eligible = useMemo(() => eligibleReviewRows(inventory, cutoff, archivedOnly), [inventory, cutoff, archivedOnly])
  const [selected, setSelected] = useState(() => new Set(eligible.map(row => row.id)))
  const submitting = useRef(false)
  const changeFilters = (nextDays: number, nextArchived: boolean) => {
    setDays(nextDays); setArchivedOnly(nextArchived); setVisible(REVIEW_PAGE_SIZE)
    setSelected(new Set(eligibleReviewRows(inventory, reviewCutoffMs(nextDays, openedAt), nextArchived).map(row => row.id)))
  }
  const chosen = eligible.filter(row => selected.has(row.id))
  if (confirmOpen) return <StorageDialog returnFocusId="storage-review-button" title={t('storage_cleanup_confirm_title')} dismissible={false} onClose={() => setConfirmOpen(false)}
    footer={<><StorageButton tone="ghost" autoFocus onClick={() => setConfirmOpen(false)}>{t('storage_cleanup_cancel')}</StorageButton>
      <StorageButton danger id="storage-confirm-delete" onClick={() => {
        if (submitting.current) return
        submitting.current = true
        onConfirm(chosen.map(row => ({ id: row.id, updatedAt: row.updatedAt })), cutoff, archivedOnly)
      }}>{t('storage_cleanup_confirm_delete')}</StorageButton></>}>
    <p className={styles.description}>{t('storage_cleanup_confirm_body').replace('{count}', String(chosen.length))}</p>
  </StorageDialog>
  return <StorageDialog returnFocusId="storage-review-button" title={t('storage_cleanup_dialog_title')} description={t('storage_cleanup_warning')} onClose={onClose}
    footer={<div className={styles.reviewFooter}>
      <p aria-live="polite">{t('storage_cleanup_selection').replace('{count}', String(selected.size)).replace('{subagents}', String(selectionSubagentTotal(eligible, selected)))}</p>
      <div className={styles.actions}><StorageButton tone="outline" autoFocus onClick={onClose}>{t('storage_cleanup_cancel')}</StorageButton>
        <StorageButton danger id="storage-review-delete" disabled={selected.size === 0} onClick={() => setConfirmOpen(true)}>{t('storage_cleanup_delete')}</StorageButton></div>
    </div>}>
    <div className={styles.card}>
      <div className={styles.filterRow}><span>{t('storage_cleanup_age')}</span><StorageChoice id="storage-review-days" label={t('storage_cleanup_age')}
        value={String(days)} options={REVIEW_DAY_OPTIONS.map(value => ({ value: String(value), label: t('storage_cleanup_days').replace('{days}', String(value)) }))}
        onChange={value => changeFilters(Number(value), archivedOnly)} /></div>
      <div className={styles.filterRow}><span>{t('storage_cleanup_include')}</span><StorageChoice id="storage-review-include" label={t('storage_cleanup_include')}
        value={archivedOnly ? 'archived' : 'all'} options={[{ value: 'archived', label: t('storage_cleanup_archived') }, { value: 'all', label: t('storage_cleanup_all') }]}
        onChange={value => changeFilters(days, value === 'archived')} /></div>
    </div>
    {eligible.length === 0 ? <p className={styles.empty}>{t('storage_cleanup_empty')}</p> : <div className={`${styles.card} ${styles.reviewList}`}>
      {eligible.slice(0, visible).map(row => <label key={row.id} className={styles.reviewRow} data-cleanup-id={row.id}>
        <span className={styles.reviewTitle}>{w().sessionDisplayTitle?.(row.row) || t('storage_cleanup_untitled')}</span>
        <span className={styles.bytes}>{formatStorageBytes(row.bytes, intlLocale())}</span>
        <input type="checkbox" checked={selected.has(row.id)} onChange={event => {
          const next = new Set(selected); if (event.target.checked) next.add(row.id); else next.delete(row.id); setSelected(next)
        }} />
      </label>)}
    </div>}
    {visible < eligible.length && <StorageButton tone="ghost" className={styles.showMore} onClick={() => setVisible(count => count + REVIEW_PAGE_SIZE)}>{t('storage_cleanup_show_more')}</StorageButton>}
  </StorageDialog>
}

export function StorageTab() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<StorageSnapshotWire | null>(null), [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(false)
  const [inventory, setInventory] = useState<StorageReviewRowWire[] | null>(null), [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState(false), [cleanupPending, setCleanupPending] = useState(false)
  const alive = useRef(true), sequence = useRef(0), reviewId = useRef<string>('')
  const cleanupLock = useRef(false), reviewLock = useRef(false)
  const read = useCallback(async (refresh = false) => {
    const revision = ++sequence.current
    setLoading(true)
    try {
      const next = await (refresh ? w().klaus.storage.refresh() : w().klaus.storage.usage())
      if (alive.current && revision === sequence.current) { setSnapshot(next); setLoadError(false) }
    } catch { if (alive.current && revision === sequence.current) setLoadError(true) }
    finally { if (alive.current && revision === sequence.current) setLoading(false) }
  }, [])
  useEffect(() => { alive.current = true; void read(); return () => { alive.current = false; sequence.current++ } }, [read])
  useEffect(() => {
    if (snapshot?.status !== 'scanning') return
    const timer = setTimeout(() => { void read() }, 1000)
    return () => clearTimeout(timer)
  }, [snapshot, read])
  const openReview = async () => {
    if (reviewLock.current || cleanupLock.current) return
    reviewLock.current = true; setReviewLoading(true); setReviewError(false)
    try {
      const result = await w().klaus.storage.review()
      if (alive.current) { reviewId.current = result.reviewId; setInventory(result.inventory) }
    } catch { if (alive.current) setReviewError(true) }
    finally { reviewLock.current = false; if (alive.current) setReviewLoading(false) }
  }
  const cleanup = async (selection: Array<{ id: string; updatedAt: number }>, cutoffMs: number, archivedOnly: boolean) => {
    if (cleanupLock.current) return
    cleanupLock.current = true; setInventory(null); setCleanupPending(true)
    const dismiss = w().showToast(t('storage_cleanup_deleting'), { duration: 3_600_000 })
    try {
      const result = await w().klaus.storage.cleanup(selection, { reviewId: reviewId.current, cutoffMs, archivedOnly })
      w().showToast(t('storage_cleanup_result').replace('{deleted}', String(result.deleted)).replace('{skipped}', String(result.skipped)).replace('{failed}', String(result.failed)), { duration: 6000 })
      await w().updateSessionInList?.()
    } catch { w().showToast(t('storage_cleanup_recheck_error'), { duration: 6000 }) }
    finally { dismiss?.(); cleanupLock.current = false; if (alive.current) { setCleanupPending(false); void read(true) } }
  }
  return <SettingsPage title={t('storage_page_title')}>
    <div className={styles.page}>
      <section className={styles.device} data-storage-page="1">
        <header><h2>{t('storage_this_device')}</h2><p>{t('storage_device_desc')}</p></header>
        <UsagePanel snapshot={snapshot} scanning={loading || snapshot?.status === 'scanning'} loadError={loadError} onRefresh={() => { void read(true) }} />
      </section>
      <div className={styles.card}><div className={styles.row}>
        <div><div className={styles.rowLabel}>{t('storage_cleanup_title')}</div><div className={styles.description}>{t('storage_cleanup_desc')}</div></div>
        <StorageButton id="storage-review-button" busy={reviewLoading || cleanupPending} disabled={loadError || !cleanupReady(snapshot) || reviewLoading || cleanupPending}
          onClick={() => { void openReview() }}>{t('storage_cleanup_review')}</StorageButton>
      </div></div>
      {reviewError && <p className={styles.error} role="alert">{t('storage_cleanup_load_error')}</p>}
      <div className={styles.card}>
        <div className={styles.row}><div><div className={styles.rowLabel}>{t('storage_worktree_management')}</div><div className={styles.description}>{t('storage_worktree_desc')}</div></div>
          <StorageButton id="storage-manage-worktrees" onClick={() => loadSettingsTab('worktrees')}>{t('storage_manage')}</StorageButton></div>
        <div className={styles.row}><div><div className={styles.rowLabel}>{t('storage_archive_management')}</div><div className={styles.description}>{t('storage_archive_desc')}</div></div>
          <StorageButton id="storage-manage-archived" onClick={() => loadSettingsTab('archivedSessions')}>{t('storage_manage')}</StorageButton></div>
      </div>
    </div>
    {inventory && <StorageReviewDialog inventory={inventory} onClose={() => setInventory(null)} onConfirm={(selection, cutoffMs, archivedOnly) => { void cleanup(selection, cutoffMs, archivedOnly) }} />}
  </SettingsPage>
}
