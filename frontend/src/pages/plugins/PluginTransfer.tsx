import { useT } from '../../i18n'
import type { PluginItem, PluginOperation } from './plugin-store'
import {
  canCancelPluginOperation,
  downloadRatioPercent,
  formatRemainingLabel,
  formatTransferBytes,
  stageLabelKey,
  transferDisplayPercent,
  transferRemaining,
  transferStepIndex,
} from './plugin-transfer'
import styles from './plugins.module.css'

const PIPELINE_STEPS = [
  { key: 'download', labelKey: 'plugins_step_download' },
  { key: 'unpack', labelKey: 'plugins_step_unpack' },
  { key: 'activate', labelKey: 'plugins_step_activate' },
] as const

function indeterminateStage(stage: string | undefined, total: number): boolean {
  return stage === 'downloading' && total <= 0
}

export function PluginInlineProgressBar({ operation, label }: { operation?: PluginOperation; label: string }) {
  if (!operation || operation.phase !== 'running' || !operation.progress) return null
  const percent = transferDisplayPercent(operation.progress)
  const indeterminate = operation.progress.stage === 'downloading' && operation.progress.total <= 0
  return (
    <div
      className={styles['pl-inline-track']}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : percent}
      data-plugin-inline-bar={operation.progress.stage}
    >
      <div
        className={`${styles['pl-inline-fill']}${indeterminate ? ` ${styles['pl-fill-indeterminate']}` : ''}`}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  )
}

export function PluginTransferBanner({
  plugin,
  name,
  iconHtml,
  operation,
  queuedCount,
  onOpen,
  onCancel,
}: {
  plugin: PluginItem
  name: string
  iconHtml: string
  operation: PluginOperation
  queuedCount: number
  onOpen: () => void
  onCancel: () => void
}) {
  const t = useT()
  const progress = operation.progress
  if (!progress || operation.phase !== 'running') return null
  const barPercent = transferDisplayPercent(progress)
  const indeterminate = progress.stage === 'downloading' && progress.total <= 0
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

  return (
    <div className={styles['pl-transfer-banner']} role="status" data-plugin-transfer-banner={plugin.id} data-stage={progress.stage}>
      <div className={styles['pl-transfer-banner-head']}>
        <button type="button" className={styles['pl-transfer-banner-open']} data-transfer-open onClick={onOpen}>
          <span className={styles['pl-transfer-banner-icon']} aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconHtml }} />
          <span className={styles['pl-transfer-banner-info']}>
            <span className={styles['pl-transfer-banner-title-row']}>
              <span className={styles['pl-transfer-banner-name']}>{name}</span>
              <span className={styles['pl-transfer-banner-stage']}>{stageText}</span>
              {queuedCount > 0 && (
                <span className="s-badge s-badge-gray">
                  {t('plugins_transfer_queued_more').replace('{count}', String(queuedCount))}
                </span>
              )}
            </span>
            {metrics.length > 0 && <span className={styles['pl-transfer-banner-meta']}>{metrics.join(' · ')}</span>}
          </span>
        </button>
        <div className={styles['pl-transfer-banner-actions']}>
          <button type="button" className="btn-sm" data-transfer-detail={plugin.id} onClick={onOpen}>
            {t('plugins_transfer_open_detail')}
          </button>
          {(cancellable || operation.cancelling) && (
            <button
              type="button"
              className="btn-sm"
              data-plugin-cancel={plugin.id}
              disabled={!cancellable}
              onClick={onCancel}
            >
              {t(operation.cancelling ? 'plugins_cancelling' : 'plugins_cancel')}
            </button>
          )}
        </div>
      </div>
      <div
        className={styles['pl-transfer-track']}
        role="progressbar"
        aria-label={`${name} ${stageText}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : barPercent}
      >
        <div
          className={`${styles['pl-transfer-fill']}${indeterminate ? ` ${styles['pl-fill-indeterminate']}` : ''}`}
          style={indeterminate ? undefined : { width: `${barPercent}%` }}
        />
      </div>
    </div>
  )
}

export function PluginDetailTransferPanel({
  pluginId,
  name,
  operation,
}: {
  pluginId: string
  name: string
  operation?: PluginOperation
}) {
  const t = useT()
  if (!operation || (operation.action !== 'install' && operation.action !== 'update')) return null
  if (operation.phase !== 'queued' && operation.phase !== 'running') return null

  const progress = operation.progress
  const isQueued = operation.phase === 'queued'
  const stage = progress?.stage
  const barPercent = isQueued ? 0 : transferDisplayPercent(progress)
  const dlPercent = downloadRatioPercent(progress)
  const headlinePercent = progress && (!indeterminateStage(stage, progress.total)) ? barPercent : null
  const indeterminate = isQueued || !progress || indeterminateStage(stage, progress.total)
  const activeStep = isQueued ? -1 : transferStepIndex(stage)
  const stageLabel = operation.cancelling ? t('plugins_cancelling') : t(stageLabelKey(stage, isQueued))

  return (
    <section
      className={styles['pl-transfer-panel']}
      role="status"
      aria-live="polite"
      data-plugin-detail-transfer={pluginId}
      data-stage={isQueued ? 'queued' : stage || 'starting'}
    >
      <div className={styles['pl-transfer-panel-top']}>
        <div className={styles['pl-transfer-panel-stage']}>
          <span className={styles['pl-spinner']} aria-hidden="true" />
          <span>{stageLabel}</span>
        </div>
        <div className={styles['pl-transfer-panel-numbers']}>
          {headlinePercent !== null && <span className={styles['pl-transfer-percent']}>{headlinePercent}%</span>}
          {progress && progress.total > 0 && (
            <span className={styles['pl-transfer-size']}>
              {stage === 'downloading'
                ? `${formatTransferBytes(progress.transferred)} / ${formatTransferBytes(progress.total)}`
                : formatTransferBytes(progress.total)}
            </span>
          )}
        </div>
      </div>

      <div
        className={styles['pl-transfer-track']}
        role="progressbar"
        aria-label={`${name} ${stageLabel}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : barPercent}
      >
        <div
          className={`${styles['pl-transfer-fill']}${indeterminate ? ` ${styles['pl-fill-indeterminate']}` : ''}`}
          style={indeterminate ? undefined : { width: `${barPercent}%` }}
        />
      </div>

      {progress && stage === 'downloading' && (
        <div className={styles['pl-transfer-metrics']}>
          <div>
            <div className={styles['pl-transfer-metric-label']}>{t('plugins_transfer_speed')}</div>
            <div className={styles['pl-transfer-metric-value']} data-transfer-speed>
              {progress.bytesPerSecond > 0 ? `${formatTransferBytes(progress.bytesPerSecond)}/s` : t('plugins_transfer_calculating')}
            </div>
          </div>
          <div>
            <div className={styles['pl-transfer-metric-label']}>{t('plugins_transfer_remaining')}</div>
            <div className={styles['pl-transfer-metric-value']} data-transfer-eta>
              {formatRemainingLabel(transferRemaining(progress), t)}
            </div>
          </div>
        </div>
      )}

      <div className={styles['pl-transfer-steps']}>
        {PIPELINE_STEPS.map((step, index) => {
          const stateClass = index < activeStep
            ? styles['pl-step-done']
            : index === activeStep
              ? styles['pl-step-active']
              : ''
          const stepWidth = index < activeStep
            ? 100
            : index === activeStep
              ? (index === 0 && dlPercent !== null ? dlPercent : index === 1 && stage === 'extracting' ? 75 : 50)
              : 0
          return (
            <div
              key={step.key}
              className={`${styles['pl-transfer-step']}${stateClass ? ` ${stateClass}` : ''}`}
              data-transfer-step={step.key}
              data-step-state={index < activeStep ? 'done' : index === activeStep ? 'active' : 'pending'}
            >
              <div className={styles['pl-step-track']}>
                <div className={styles['pl-step-fill']} style={{ width: `${stepWidth}%` }} />
              </div>
              <span className={styles['pl-step-label']}>{t(step.labelKey)}</span>
            </div>
          )
        })}
      </div>

      {stage === 'installing' && (
        <p className={styles['pl-transfer-hint']}>{t('plugins_transfer_finishing_hint')}</p>
      )}
    </section>
  )
}
