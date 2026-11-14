// Pure plugin transfer presentation model: no DOM, no window, no React.
// Keeps byte formatting, smoothed ETA, monotonic bar progress, 3-step pipeline
// mapping and cancellation eligibility testable without a browser.
import { formatBytes, remainingTime, type RemainingTime } from '../../app/update/model'

export type PluginInstallStage = 'downloading' | 'verifying' | 'extracting' | 'installing'

export interface PluginTransferProgress {
  id: string
  action: 'install' | 'update'
  stage: PluginInstallStage
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
  cancellable: boolean
}

export interface CancellableOperationLike {
  action: 'update' | 'install' | 'toggle' | 'uninstall'
  phase: 'queued' | 'running' | 'success' | 'error'
  cancelling?: boolean
  progress?: PluginTransferProgress
}

export { formatBytes as formatTransferBytes }

export function transferDisplayPercent(progress?: PluginTransferProgress | null): number {
  const raw = progress?.percent
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  return Math.min(100, Math.max(0, Math.round(raw)))
}

/**
 * Download byte ratio (0-100) for human-facing download readouts so "50%"
 * matches "108 MB / 216 MB", while `transferDisplayPercent` drives the
 * monotonic cross-stage bar (0-82 download, 86 verify, 92 extract, 97 install).
 */
export function downloadRatioPercent(progress?: PluginTransferProgress | null): number | null {
  if (!progress || progress.stage !== 'downloading' || progress.total <= 0) return null
  const ratio = Math.min(1, Math.max(0, progress.transferred / progress.total))
  return Math.round(ratio * 100)
}

export function transferRemaining(progress?: PluginTransferProgress | null): RemainingTime {
  if (!progress || progress.stage !== 'downloading') return { kind: 'calculating' }
  return remainingTime(progress.bytesPerSecond, progress.transferred, progress.total)
}

export function formatRemainingLabel(value: RemainingTime, t: (key: string) => string): string {
  if (value.kind === 'calculating') return t('plugins_transfer_calculating')
  if (value.kind === 'seconds') return t('plugins_transfer_seconds').replace('{count}', String(value.count))
  if (value.kind === 'minutes') return t('plugins_transfer_minutes').replace('{count}', String(value.count))
  return t('plugins_transfer_hours_minutes')
    .replace('{hours}', String(value.hours))
    .replace('{minutes}', String(value.minutes))
}

export function compactStageLabelKey(stage?: PluginInstallStage, queued = false): string {
  if (queued) return 'plugins_queued'
  switch (stage) {
    case 'downloading': return 'plugins_stage_short_downloading'
    case 'verifying': return 'plugins_stage_short_verifying'
    case 'extracting': return 'plugins_stage_short_extracting'
    case 'installing': return 'plugins_stage_short_installing'
    default: return 'plugins_installing'
  }
}

export function stageLabelKey(stage?: PluginInstallStage, queued = false): string {
  if (queued) return 'plugins_stage_queued'
  switch (stage) {
    case 'downloading': return 'plugins_stage_downloading'
    case 'verifying': return 'plugins_stage_verifying'
    case 'extracting': return 'plugins_stage_extracting'
    case 'installing': return 'plugins_stage_installing'
    default: return 'plugins_installing'
  }
}

/** Maps the host stage onto the 3-step pipeline: 0 download, 1 unpack, 2 activate. */
export function transferStepIndex(stage?: PluginInstallStage): 0 | 1 | 2 {
  if (!stage || stage === 'downloading') return 0
  if (stage === 'verifying' || stage === 'extracting') return 1
  return 2
}

/** Only install/update acquisitions before the engine ledger commit can be cancelled. */
export function canCancelPluginOperation(operation?: CancellableOperationLike): boolean {
  if (!operation || operation.cancelling) return false
  if (operation.action !== 'install' && operation.action !== 'update') return false
  if (operation.phase === 'queued') return true
  if (operation.phase === 'running') return operation.progress?.cancellable !== false
  return false
}

/** Compact single-line summary for MarketCard subtitle / EntryCard meta. */
export function compactTransferSummary(operation: CancellableOperationLike | undefined, t: (key: string) => string): string | null {
  if (!operation || (operation.action !== 'install' && operation.action !== 'update')) return null
  if (operation.cancelling) return t('plugins_cancelling')
  if (operation.phase !== 'running' || !operation.progress) return null
  const { progress } = operation
  if (progress.stage === 'downloading') {
    const pct = transferDisplayPercent(progress)
    const parts: string[] = []
    if (progress.total > 0) {
      parts.push(`${pct}%`)
      parts.push(`${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}`)
    } else if (progress.transferred > 0) {
      parts.push(formatBytes(progress.transferred))
    }
    if (progress.bytesPerSecond > 0) parts.push(`${formatBytes(progress.bytesPerSecond)}/s`)
    return parts.length ? parts.join(' · ') : t('plugins_stage_downloading')
  }
  return `${transferDisplayPercent(progress)}% · ${t(stageLabelKey(progress.stage))}`
}
