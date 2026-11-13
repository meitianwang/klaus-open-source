import { describe, expect, test } from 'bun:test'
import {
  canCancelPluginOperation,
  compactTransferSummary,
  downloadRatioPercent,
  formatRemainingLabel,
  formatTransferBytes,
  stageLabelKey,
  transferDisplayPercent,
  transferRemaining,
  transferStepIndex,
  type PluginTransferProgress,
} from './plugin-transfer'

const zhMap: Record<string, string> = {
  plugins_cancelling: '正在取消…',
  plugins_stage_queued: '排队等待中…',
  plugins_stage_downloading: '正在下载安装包…',
  plugins_stage_verifying: '正在校验完整性…',
  plugins_stage_extracting: '正在解压插件包…',
  plugins_stage_installing: '正在安装并启用…',
  plugins_installing: '安装中…',
  plugins_transfer_calculating: '计算中…',
  plugins_transfer_seconds: '{count} 秒',
  plugins_transfer_minutes: '{count} 分钟',
  plugins_transfer_hours_minutes: '{hours} 小时 {minutes} 分钟',
}
const t = (key: string) => zhMap[key] || key

function sampleProgress(overrides: Partial<PluginTransferProgress> = {}): PluginTransferProgress {
  return {
    id: 'reverse-engineering@klaus-official',
    action: 'install',
    stage: 'downloading',
    percent: 41,
    transferred: 108 * 1024 * 1024,
    total: 216 * 1024 * 1024,
    bytesPerSecond: 2 * 1024 * 1024,
    cancellable: true,
    ...overrides,
  }
}

describe('plugin transfer presentation model', () => {
  test('formats byte ratios, smoothed speeds and honest remaining time across stages', () => {
    const downloading = sampleProgress()
    expect(downloadRatioPercent(downloading)).toBe(50)
    expect(transferDisplayPercent(downloading)).toBe(41)
    expect(formatTransferBytes(downloading.total)).toBe('216 MB')
    expect(formatRemainingLabel(transferRemaining(downloading), t)).toBe('54 秒')
    expect(compactTransferSummary({ action: 'install', phase: 'running', progress: downloading }, t))
      .toBe('41% · 108 MB / 216 MB · 2 MB/s')

    const unknownSpeed = sampleProgress({ bytesPerSecond: 0, transferred: 0, percent: 0 })
    expect(formatRemainingLabel(transferRemaining(unknownSpeed), t)).toBe('计算中…')

    const verifying = sampleProgress({ stage: 'verifying', percent: 86, bytesPerSecond: 0 })
    expect(downloadRatioPercent(verifying)).toBeNull()
    expect(transferDisplayPercent(verifying)).toBe(86)
    expect(compactTransferSummary({ action: 'install', phase: 'running', progress: verifying }, t))
      .toBe('86% · 正在校验完整性…')
  })

  test('maps stages monotonically onto the 3-step pipeline', () => {
    expect(transferStepIndex('downloading')).toBe(0)
    expect(transferStepIndex('verifying')).toBe(1)
    expect(transferStepIndex('extracting')).toBe(1)
    expect(transferStepIndex('installing')).toBe(2)
    expect(stageLabelKey(undefined, true)).toBe('plugins_stage_queued')
  })

  test('restricts cancellation to queued or pre-commit install/update operations', () => {
    expect(canCancelPluginOperation({ action: 'install', phase: 'queued' })).toBe(true)
    expect(canCancelPluginOperation({ action: 'update', phase: 'running', progress: sampleProgress({ cancellable: true }) })).toBe(true)
    expect(canCancelPluginOperation({ action: 'install', phase: 'running', progress: sampleProgress({ stage: 'installing', cancellable: false }) })).toBe(false)
    expect(canCancelPluginOperation({ action: 'install', phase: 'running', cancelling: true, progress: sampleProgress() })).toBe(false)
    expect(canCancelPluginOperation({ action: 'toggle', phase: 'running' })).toBe(false)
    expect(canCancelPluginOperation({ action: 'uninstall', phase: 'running' })).toBe(false)
  })
})
