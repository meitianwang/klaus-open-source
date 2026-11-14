import { Fragment } from 'react'
import { useT } from '../i18n'
import {
  canCancelPluginOperation,
  formatRemainingLabel,
  formatTransferBytes,
  stageLabelKey,
  transferDisplayPercent,
  transferRemaining,
  transferStepIndex,
  type CancellableOperationLike,
} from '../pages/plugins/plugin-transfer'
import styles from './ExtensionTransfer.module.css'

const PIPELINE_STEPS = [
  { key: 'download', labelKey: 'plugins_step_download' },
  { key: 'unpack', labelKey: 'plugins_step_unpack' },
  { key: 'activate', labelKey: 'plugins_step_activate' },
] as const

function indeterminateStage(stage: string | undefined, total: number): boolean {
  return stage === 'downloading' && total <= 0
}

export function ExtensionInlineProgressBar({
  operation,
  label,
  dataAttr = 'plugin-inline-bar',
}: {
  operation?: CancellableOperationLike
  label: string
  dataAttr?: string
}) {
  if (!operation || operation.phase !== 'running' || !operation.progress) return null
  const percent = transferDisplayPercent(operation.progress)
  const indeterminate = indeterminateStage(operation.progress.stage, operation.progress.total)
  const attrs: Record<string, string> = { [`data-${dataAttr}`]: operation.progress.stage }
  return (
    <div
      className={styles.inlineTrack}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : percent}
      {...attrs}
    >
      <div
        className={`${styles.fill} ${indeterminate ? styles.fillIndeterminate : styles.fillActive}`}
        style={indeterminate ? undefined : { width: `${Math.max(4, percent)}%` }}
      />
    </div>
  )
}

export function ExtensionTransferBanner({
  itemId,
  name,
  iconHtml,
  operation,
  queuedCount,
  openLabelKey = 'plugins_transfer_open_detail',
  onOpen,
  onCancel,
  bannerAttr = 'plugin-transfer-banner',
  detailAttr = 'transfer-detail',
  cancelAttr = 'plugin-cancel',
}: {
  itemId: string
  name: string
  iconHtml: string
  operation: CancellableOperationLike
  queuedCount: number
  openLabelKey?: string
  onOpen?: () => void
  onCancel: () => void
  bannerAttr?: string
  detailAttr?: string
  cancelAttr?: string
}) {
  const t = useT()
  const progress = operation.progress
  if (!progress || operation.phase !== 'running') return null
  const barPercent = transferDisplayPercent(progress)
  const indeterminate = indeterminateStage(progress.stage, progress.total)
  const stageText = operation.cancelling ? t('plugins_cancelling') : t(stageLabelKey(progress.stage))
  const cancellable = canCancelPluginOperation(operation)

  const metrics: string[] = []
  if (progress.stage === 'downloading') {
    if (progress.total > 0) {
      metrics.push(`${barPercent}%`)
      metrics.push(`${formatTransferBytes(progress.transferred)} / ${formatTransferBytes(progress.total)}`)
    } else if (progress.transferred > 0) {
      metrics.push(formatTransferBytes(progress.transferred))
    }
    if (progress.bytesPerSecond > 0) {
      metrics.push(`${formatTransferBytes(progress.bytesPerSecond)}/s`)
      metrics.push(formatRemainingLabel(transferRemaining(progress), t))
    }
  } else {
    metrics.push(`${barPercent}%`)
    if (progress.total > 0) metrics.push(formatTransferBytes(progress.total))
  }

  const rootAttrs: Record<string, string> = { [`data-${bannerAttr}`]: itemId, 'data-stage': progress.stage }
  const detailAttrs: Record<string, string> = { [`data-${detailAttr}`]: itemId }
  const cancelAttrs: Record<string, string> = { [`data-${cancelAttr}`]: itemId }

  const leadBody = (
    <>
      <span className={styles.bannerIcon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconHtml }} />
      <span className={styles.bannerInfo}>
        <span className={styles.bannerTitleRow}>
          <span className={styles.bannerName}>{name}</span>
          <span className={styles.bannerStage}>{stageText}</span>
          {queuedCount > 0 && (
            <span className="s-badge s-badge-gray">
              {t('plugins_transfer_queued_more').replace('{count}', String(queuedCount))}
            </span>
          )}
        </span>
        {metrics.length > 0 && <span className={styles.bannerMeta}>{metrics.join(' · ')}</span>}
      </span>
    </>
  )

  return (
    <div className={styles.banner} role="status" {...rootAttrs}>
      <div className={styles.bannerHead}>
        {onOpen ? (
          <button type="button" className={`${styles.bannerLead} ${styles.bannerLeadClickable}`} data-transfer-open onClick={onOpen}>
            {leadBody}
          </button>
        ) : (
          <div className={styles.bannerLead}>{leadBody}</div>
        )}
        <div className={styles.bannerActions}>
          {onOpen && (
            <button type="button" className="btn-sm" {...detailAttrs} onClick={onOpen}>
              {t(openLabelKey)}
            </button>
          )}
          {(cancellable || operation.cancelling) && (
            <button type="button" className="btn-sm" {...cancelAttrs} disabled={!cancellable} onClick={onCancel}>
              {t(operation.cancelling ? 'plugins_cancelling' : 'plugins_cancel')}
            </button>
          )}
        </div>
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={`${name} ${stageText}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : barPercent}
      >
        <div
          className={`${styles.fill} ${indeterminate ? styles.fillIndeterminate : styles.fillActive}`}
          style={indeterminate ? undefined : { width: `${Math.max(4, barPercent)}%` }}
        />
      </div>
    </div>
  )
}

export function ExtensionDetailTransferPanel({
  itemId,
  name,
  operation,
  panelAttr = 'plugin-detail-transfer',
}: {
  itemId: string
  name: string
  operation?: CancellableOperationLike
  panelAttr?: string
}) {
  const t = useT()
  if (!operation || (operation.action !== 'install' && operation.action !== 'update')) return null
  if (operation.phase !== 'queued' && operation.phase !== 'running') return null

  const progress = operation.progress
  const isQueued = operation.phase === 'queued'
  const stage = progress?.stage
  const barPercent = isQueued ? 0 : transferDisplayPercent(progress)
  const headlinePercent = progress && !indeterminateStage(stage, progress.total) ? barPercent : null
  const indeterminate = isQueued || !progress || indeterminateStage(stage, progress.total)
  const activeStep = isQueued ? -1 : transferStepIndex(stage)
  const stageLabel = operation.cancelling ? t('plugins_cancelling') : t(stageLabelKey(stage, isQueued))
  const rootAttrs: Record<string, string> = {
    [`data-${panelAttr}`]: itemId,
    'data-stage': isQueued ? 'queued' : stage || 'starting',
  }

  return (
    <section className={styles.panel} role="status" aria-live="polite" {...rootAttrs}>
      <div className={styles.panelTop}>
        <div className={styles.panelStage}>
          <span className={styles.spinner} aria-hidden="true" />
          <span>{stageLabel}</span>
        </div>
        <div className={styles.panelNumbers}>
          {progress && progress.total > 0 && (
            <span className={styles.size}>
              {stage === 'downloading'
                ? `${formatTransferBytes(progress.transferred)} / ${formatTransferBytes(progress.total)}`
                : formatTransferBytes(progress.total)}
            </span>
          )}
          {headlinePercent !== null && <span className={styles.percent}>{headlinePercent}%</span>}
        </div>
      </div>

      <div
        className={styles.track}
        role="progressbar"
        aria-label={`${name} ${stageLabel}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : barPercent}
      >
        <div
          className={`${styles.fill} ${indeterminate ? styles.fillIndeterminate : styles.fillActive}`}
          style={indeterminate ? undefined : { width: `${Math.max(4, barPercent)}%` }}
        />
      </div>

      {progress && stage === 'downloading' && (
        <div className={styles.metaRow}>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>{t('plugins_transfer_speed')}</span>
            <span className={styles.metaValue} data-transfer-speed>
              {progress.bytesPerSecond > 0 ? `${formatTransferBytes(progress.bytesPerSecond)}/s` : t('plugins_transfer_calculating')}
            </span>
          </span>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>{t('plugins_transfer_remaining')}</span>
            <span className={styles.metaValue} data-transfer-eta>
              {formatRemainingLabel(transferRemaining(progress), t)}
            </span>
          </span>
        </div>
      )}

      <div className={styles.steps}>
        {PIPELINE_STEPS.map((step, index) => {
          const done = index < activeStep
          const current = index === activeStep
          const stateClass = done ? styles.stepDone : current ? styles.stepActive : ''
          return (
            <Fragment key={step.key}>
              {index > 0 && (
                <span
                  className={`${styles.stepConnector} ${index <= activeStep ? styles.stepConnectorActive : ''}`}
                  aria-hidden="true"
                />
              )}
              <div
                className={`${styles.step} ${stateClass}`}
                data-transfer-step={step.key}
                data-step-state={done ? 'done' : current ? 'active' : 'pending'}
              >
                <span className={styles.stepMarker} aria-hidden="true">
                  {done ? (
                    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.25 6.25 4.85 8.85 9.75 3.5" />
                    </svg>
                  ) : current ? (
                    <span className={styles.stepSpinner} />
                  ) : (
                    <span className={styles.stepDot} />
                  )}
                </span>
                <span className={styles.stepLabel}>{t(step.labelKey)}</span>
              </div>
            </Fragment>
          )
        })}
      </div>

      {stage === 'installing' && (
        <p className={styles.hint}>{t('plugins_transfer_finishing_hint')}</p>
      )}
    </section>
  )
}
