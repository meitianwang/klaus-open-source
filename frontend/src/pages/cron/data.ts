// Cron 页数据层（迁自 js/cron.js 的纯逻辑）：schedule 编译/解析/人话化、
// 时间格式化 helpers、任务/运行行类型。
import { t } from '../../i18n'
export { effectiveCronRunStatus } from '../../../../contracts/cron-runs'

const w = () => window as any

export interface CronChannelBinding {
  channelId: string
  accountId?: string
  targetId?: string
  chatType?: string
  label?: string
  threadId?: string
}

export interface CronTask {
  id: string
  name?: string
  description?: string | null
  schedule?: string
  prompt?: string
  enabled?: boolean
  thinking?: string | null
  model?: string | null
  /** Project directory the run session binds to; empty runs projectless. */
  workdir?: string | null
  /** Saved multi-folder workspace the run session binds to. Mutually exclusive with workdir. */
  workspaceId?: string | null
  /** Initial permission preset for each run. Missing legacy rows keep the historical full-access default. */
  permissionPreset?: CronPermissionPreset | null
  deleteAfterRun?: boolean
  timezone?: string
  executionMode?: CronExecutionMode | null
  channelBinding?: CronChannelBinding | null
  createdBy?: string
  /** Notification gating: 'failed_runs_only' (default) | 'all_runs'. */
  notificationPolicy?: 'failed_runs_only' | 'all_runs'
  createdAt?: number
  updatedAt?: number
}

export type CronPermissionPreset = 'default' | 'auto' | 'bypassPermissions'
export type CronExecutionTarget =
  | { kind: 'none' }
  | { kind: 'project'; root: string }
  | { kind: 'workspace'; id: string }

/** The run's saved location. A workspace wins if an older or malformed row carries both. */
export function cronExecutionTarget(task: Pick<CronTask, 'workdir' | 'workspaceId'> | null | undefined): CronExecutionTarget {
  const workspaceId = task?.workspaceId?.trim()
  if (workspaceId) return { kind: 'workspace', id: workspaceId }
  const root = task?.workdir?.trim()
  return root ? { kind: 'project', root } : { kind: 'none' }
}

/** Dropdown values need one string; the stored row still keeps workdir and workspaceId separate. */
export function cronExecutionValue(task: Pick<CronTask, 'workdir' | 'workspaceId'> | null | undefined): string {
  const target = cronExecutionTarget(task)
  return target.kind === 'workspace' ? `workspace:${target.id}`
    : target.kind === 'project' ? `project:${target.root}`
      : ''
}

export function parseCronExecutionValue(value: string): CronExecutionTarget {
  if (value.startsWith('workspace:')) return { kind: 'workspace', id: value.slice('workspace:'.length) }
  if (value.startsWith('project:')) return { kind: 'project', root: value.slice('project:'.length) }
  return { kind: 'none' }
}

/** Unknown values in an old row cannot identify a preset; those rows historically ran fully open. */
export function cronPermissionPreset(value: unknown): CronPermissionPreset {
  return value === 'default' || value === 'auto' || value === 'bypassPermissions' ? value : 'bypassPermissions'
}

export interface CronRun {
  taskId: string
  taskName?: string
  sessionId?: string
  status: string
  error?: string
  startedAt: number
  durationMs?: number
  triggerType?: string
}

export interface CronStatus {
  nextRuns: Record<string, number>
  running: string[]
}

/** Keep transport diagnostics available without making them the primary run-history copy. */
export function cronRunErrorText(error: string, translate: (key: string) => string = t): string {
  if (/\bstream total timeout:\s*model response exceeded\s+\d+\s*ms\b/i.test(error)) {
    return translate('cron_run_model_timeout')
  }
  return error
}

export function cronDeleteSucceeded(result: unknown): boolean {
  if (result === true) return true
  if (!result || typeof result !== 'object') return false
  const payload = result as Record<string, unknown>
  return payload.ok === true || payload.deleted === true
}

export function retainedCronTaskFields(existing: CronTask | null): Pick<CronTask, 'enabled' | 'description' | 'thinking' | 'model' | 'workdir' | 'workspaceId' | 'permissionPreset' | 'notificationPolicy' | 'executionMode'> {
  if (!existing) return { enabled: true, executionMode: cronExecutionMode(undefined), permissionPreset: 'bypassPermissions', notificationPolicy: 'failed_runs_only' }
  return {
    executionMode: cronExecutionMode(existing?.executionMode),
    enabled: existing.enabled !== false,
    description: existing.description,
    thinking: existing.thinking,
    model: existing.model ?? null,
    workdir: existing.workdir ?? null,
    workspaceId: existing.workspaceId ?? null,
    permissionPreset: cronPermissionPreset(existing.permissionPreset),
    notificationPolicy: existing.notificationPolicy === 'all_runs' ? 'all_runs' : 'failed_runs_only',
  }
}

export function resolvedCronTaskTimezone(existing: CronTask | null, custom: boolean, customValue: string): string | undefined {
  const value = custom ? customValue.trim() : (existing?.timezone || '').trim()
  return value || undefined
}

export async function navigateToCronRunSession(host: Record<string, any>, sessionId: string): Promise<void> {
  const navigate = host.klausSwitchSession ?? host.switchSession
  if (typeof navigate !== 'function') throw new Error('Session navigation is unavailable')
  await navigate.call(host, sessionId)
}

// Channel display label — reuses the settings_ch_<id> keys that the
// Channels settings page already localizes (微信 / 飞书 / 钉钉 / ...).
export function channelLabelOf(id: string): string {
  const key = 'settings_ch_' + id
  const v = t(key)
  return v === key ? id : v
}

export function pad2(n: number | string): string { return String(n).padStart(2, '0') }
export function fmtDate(y: number, m: number, d: number): string { return `${y}-${pad2(m)}-${pad2(d)}` }
export function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
export function formatTime(ms: number): string { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` }
export function fmtDuration(v: number): string { return v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms' }

function localeOf(): string {
  const l = w().getLang?.() || 'en'
  return l === 'zh' ? 'zh-CN' : l
}

// "in 3 hours" / "23 minutes ago" — Intl handles the wording per locale.
export function relFromNow(ms: number): string {
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  try {
    const rtf = new Intl.RelativeTimeFormat(localeOf(), { numeric: 'auto' })
    if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second')
    if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute')
    if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour')
    return rtf.format(Math.round(diff / 86_400_000), 'day')
  } catch {
    return new Date(ms).toLocaleString()
  }
}

export interface ScheduleState {
  freq: string
  hour?: string | number
  minute?: string | number
  weekday?: string
  monthday?: string
  interval?: string
  isoDate?: string
}

// Compile the picker state into a cron expression (or null when the caller
// should use the raw `custom` input verbatim). One-shot collapses into a
// specific-date cron that fires once per year; the scheduler+store handle
// the self-delete after the first execution so it never fires again.
export function compileSchedule(state: ScheduleState): string | null {
  const { freq, hour, minute, weekday, monthday, interval, isoDate } = state
  switch (freq) {
    case 'oneshot': {
      if (!isoDate) return null
      const [, m, d] = isoDate.split('-').map(Number)
      return `${Number(minute) || 0} ${Number(hour) || 0} ${d} ${m} *`
    }
    case 'interval': {
      const n = Math.max(1, Math.min(59, Number(interval) || 30))
      return `*/${n} * * * *`
    }
    case 'hourly': return `0 * * * *`
    case 'daily': return `${Number(minute) || 0} ${Number(hour) || 0} * * *`
    case 'weekdays': return `${Number(minute) || 0} ${Number(hour) || 0} * * 1-5`
    case 'weekly': return `${Number(minute) || 0} ${Number(hour) || 0} * * ${weekday ?? '1'}`
    case 'monthly': return `${Number(minute) || 0} ${Number(hour) || 0} ${monthday ?? '1'} * *`
    default: return null
  }
}

// Decompose a stored cron back into picker state. Everything that doesn't
// fit a preset falls through to 'custom' so the raw cron stays editable.
export function parseSchedule(cron: string | undefined, deleteAfterRun: boolean): ScheduleState | null {
  if (!cron || typeof cron !== 'string') return null
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, mon, dow] = parts
  const isNum = (s: string) => /^\d+$/.test(s)

  // Interval: */N * * * *
  const intMatch = min.match(/^\*\/(\d+)$/)
  if (intMatch && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { freq: 'interval', interval: intMatch[1] }
  }

  // Hourly: 0 * * * *
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { freq: 'hourly' }
  }

  if (!isNum(min) || !isNum(hour)) return null
  const baseTime = { hour: String(Number(hour)), minute: String(Number(min)) }

  // One-shot: M H D Mo * (day and month both numeric), flagged as delete-after-run
  if (isNum(dom) && isNum(mon) && dow === '*' && deleteAfterRun) {
    // Infer the year: pick the next upcoming occurrence at or after today.
    const today = new Date()
    const m = Number(mon), d = Number(dom)
    let y = today.getFullYear()
    const trial = new Date(y, m - 1, d, Number(hour), Number(min))
    if (trial.getTime() < today.getTime()) y++
    return { ...baseTime, freq: 'oneshot', isoDate: `${y}-${pad2(m)}-${pad2(d)}` }
  }

  if (dom === '*' && mon === '*') {
    if (dow === '*') return { ...baseTime, freq: 'daily' }
    if (dow === '1-5') return { ...baseTime, freq: 'weekdays' }
    if (/^[0-6]$/.test(dow)) return { ...baseTime, freq: 'weekly', weekday: dow }
  }
  if (isNum(dom) && mon === '*' && dow === '*') {
    return { ...baseTime, freq: 'monthly', monthday: String(Number(dom)) }
  }
  return null
}

export function humanizeSchedule(cron: string | undefined): string {
  if (!cron || typeof cron !== 'string') return ''
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [min, hour, dom, mon, dow] = parts
  const isInt = (s: string) => /^\d+$/.test(s)

  // Interval: */N * * * *
  const intMatch = min.match(/^\*\/(\d+)$/)
  if (intMatch && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `${t('cron_freq_interval')} ${intMatch[1]} ${t('cron_unit_minutes')}`
  }

  // Hourly: M * * * *
  if (isInt(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return min === '0' ? t('cron_freq_hourly') : `${t('cron_freq_hourly')} :${pad2(min)}`
  }

  const timeStr = isInt(hour) && isInt(min) ? `${pad2(hour)}:${pad2(min)}` : null
  if (timeStr && dom === '*' && mon === '*') {
    if (dow === '*') return `${t('cron_every_day')} ${timeStr}`
    if (dow === '1-5') return `${t('cron_weekdays')} ${timeStr}`
    if (dow === '0,6' || dow === '6,0') return `${t('cron_weekends')} ${timeStr}`
    const names: Record<string, string> = {
      '0': t('cron_sunday'), '1': t('cron_monday'),
      '2': t('cron_tuesday'), '3': t('cron_wednesday'),
      '4': t('cron_thursday'), '5': t('cron_friday'),
      '6': t('cron_saturday'),
    }
    if (isInt(dow) && names[dow]) return `${t('cron_every')}${names[dow]} ${timeStr}`
  }

  // Monthly: M H D * *
  if (timeStr && isInt(dom) && mon === '*' && dow === '*') {
    return `${t('cron_monthly')} · ${dom} · ${timeStr}`
  }

  // One-shot / yearly: M H D Mo *
  if (timeStr && isInt(dom) && isInt(mon) && dow === '*') {
    return `${mon}/${dom} ${timeStr}`
  }

  return cron
}

// Flat ordering: running tasks first, then enabled ones by next slot,
// paused ones sink to the bottom (most recently touched first).
export function sortTasksFlat(tasks: CronTask[], status: CronStatus): CronTask[] {
  const nextOf = (x: CronTask) => status.nextRuns[x.id] ?? Infinity
  return [...tasks].sort((a, b) => {
    const runA = status.running.includes(a.id) ? 0 : 1
    const runB = status.running.includes(b.id) ? 0 : 1
    if (runA !== runB) return runA - runB
    if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1
    if (a.enabled) return nextOf(a) - nextOf(b)
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  })
}

export function taskMatchesSearch(task: CronTask, searchQuery: string): boolean {
  if (!searchQuery) return true
  const values = [
    task.id,
    task.id ? `/${task.id}` : '',
    task.name,
    task.name ? `/${task.name}` : '',
    task.prompt,
    task.schedule,
    humanizeSchedule(task.schedule),
    task.workdir,
    task.workspaceId,
    task.permissionPreset,
    task.executionMode,
    task.channelBinding?.label,
    task.channelBinding?.targetId,
    task.channelBinding?.channelId,
    w().klausSearch?.cronTaskValues?.(task),
  ]
  if (w().klausSearch?.matches) return w().klausSearch.matches(searchQuery, values)
  const q = searchQuery.toLowerCase().replace(/^\/+/, '')
  return values.flat().some(value => String(value || '').toLowerCase().includes(q))
}

export function runMatchesSearch(run: CronRun, searchQuery: string): boolean {
  if (!searchQuery) return true
  const values = [
    run.taskId,
    run.taskId ? `/${run.taskId}` : '',
    run.taskName,
    run.taskName ? `/${run.taskName}` : '',
    run.status,
    run.triggerType,
    run.error,
    w().klausSearch?.cronRunValues?.(run),
  ]
  if (w().klausSearch?.matches) return w().klausSearch.matches(searchQuery, values)
  const q = searchQuery.toLowerCase().replace(/^\/+/, '')
  return values.flat().some(value => String(value || '').toLowerCase().includes(q))
}

// 跨文件 reload 协议：onShow 进入与外部刷新都经此事件让挂载中的 CronPage 重拉。
export const CRON_PAGE_RELOAD_EVENT = 'klaus:cron-page-reload'
export const CRON_PAGE_VISIBLE_EVENT = 'klaus:cron-page-visible'

export const CRON_EXECUTION_MODES = ['default', 'orchestrate', 'parallel'] as const
export type CronExecutionMode = typeof CRON_EXECUTION_MODES[number]

export function cronExecutionMode(value: unknown): CronExecutionMode {
  return value === 'orchestrate' || value === 'parallel' ? value : 'default'
}

export interface ConnectedCronChannel { id: string; connected: boolean; ownerId?: string | null }
export interface CronChannelSelectOption { value: string; label: string }

export function buildCronChannelSelectState(
  existingBinding: CronChannelBinding | null | undefined,
  channels: ConnectedCronChannel[] | null,
  translate: (key: string) => string,
  labelOf: (id: string) => string,
): { options: CronChannelSelectOption[]; initialValue: string; pendingDmLabels: string[] } {
  const options = [{ value: '', label: translate('cron_form_channel_none') }]
  const pendingDmLabels: string[] = []
  const me = translate('cron_form_channel_me')
  const ready = (channels ?? []).filter(ch => ch.connected && ch.ownerId && String(ch.ownerId).trim())
  for (const ch of ready) options.push({ value: `dm:${ch.id}`, label: `${labelOf(ch.id)} · ${me}` })
  for (const ch of channels ?? []) {
    if (ch.connected && !String(ch.ownerId ?? '').trim()) pendingDmLabels.push(labelOf(ch.id))
  }
  let initialValue = ''
  if (existingBinding?.channelId && existingBinding.targetId) {
    const { channelId, targetId, chatType, threadId, accountId } = existingBinding
    const match = chatType !== 'group' && !threadId && (!accountId || accountId === 'default')
      && ready.find(ch => ch.id === channelId && String(ch.ownerId) === String(targetId))
    if (match) initialValue = `dm:${match.id}`
    else {
      const baseName = existingBinding.label || labelOf(channelId)
      const detail = chatType === 'group' ? `${translate('cron_form_channel_group')}${targetId}`
        : channels !== null && !channels.some(ch => ch.id === channelId && ch.connected)
          ? `${me} (${translate('cron_form_channel_disconnected')})` : me
      initialValue = '__existing__'
      options.splice(1, 0, { value: initialValue, label: `${baseName} · ${detail}` })
    }
  }
  return { options, initialValue, pendingDmLabels }
}

export function resolveCronChannelBindingSelection(
  selection: string,
  existingBinding: CronChannelBinding | null | undefined,
  ownerIdsByChannel: Record<string, string>,
  labelOf: (id: string) => string,
): CronChannelBinding | null {
  if (selection === '__existing__') return existingBinding ? { ...existingBinding } : null
  const channelId = selectedCronChannelId(selection, existingBinding)
  const ownerId = channelId && Object.hasOwn(ownerIdsByChannel, channelId) ? ownerIdsByChannel[channelId] : ''
  return ownerId?.trim()
    ? { channelId, accountId: 'default', targetId: String(ownerId), chatType: 'direct', label: labelOf(channelId) }
    : null
}

export function selectedCronChannelId(selection: string, existingBinding: CronChannelBinding | null | undefined): string {
  if (selection === '__existing__') return existingBinding?.channelId || ''
  return selection.startsWith('dm:') ? selection.slice(3) : ''
}
