// Memory 页数据层（迁自 js/memory-view.js 的纯逻辑）：
// 梦境三档鲜明度/年龄分档、诗意时间、文件友好名、错误码文案、时间格式化。
import { t } from '../../i18n'

const w = () => window as any

export interface DreamSkillDistilled {
  name: string
  action?: string
  rejectReason?: string
}

export interface DreamSkillReview {
  status?: string
  summary?: string
  distilled?: DreamSkillDistilled[]
}

export interface DreamRun {
  taskId: string
  status: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  summary?: string
  sessionsReviewing?: number
  filesTouched?: string[]
  skillReview?: DreamSkillReview
  stoppable?: boolean
}

export type Vividness = 'vivid' | 'faint' | 'broken'

// 三档视觉分层：flat-equal 行太像 cron，让每个梦无论是否写了东西都同重。
//   vivid  — 有摘要且触及文件 > 0（或蒸馏出技能）→ 完整卡 + 展开
//   faint  — 完成但 0 文件（「记忆已然安定」）→ 单行冷凝
//   broken — failed/killed → 断月牙单行
export function vividnessOf(run: DreamRun): Vividness {
  if (run.status === 'failed' || run.status === 'killed') return 'broken'
  // Klaus extension — a dream that distilled at least one skill is
  // significant even if the main dream wrote no memory file.
  const distilledClean = (run.skillReview?.distilled ?? []).filter(d => !d.rejectReason).length
  if ((run.filesTouched?.length ?? 0) === 0 && distilledClean === 0) return 'faint'
  return 'vivid'
}

export function ageOf(startedAt: number): 'fresh' | 'recent' | 'old' | 'distant' {
  const days = (Date.now() - startedAt) / (24 * 3600 * 1000)
  if (days < 1) return 'fresh'
  if (days < 3) return 'recent'
  if (days < 7) return 'old'
  return 'distant'
}

// Map a memory-file path to a human-readable label by its filename prefix.
// Memory files follow the `<type>_<rest>.md` naming convention; MEMORY.md is
// the index. Anything else falls back to the basename.
export function friendlyMemoryName(path: string): string {
  const base = (path || '').split(/[/\\]/).pop() || ''
  if (base === 'MEMORY.md') return t('memory_file_label_index')
  const m = /^(user|feedback|project|reference)_/i.exec(base)
  if (m) return t('memory_file_label_' + m[1].toLowerCase())
  return base
}

// ---- Time formatting ----

export function formatElapsed(start: number, end?: number): string {
  const ms = (end ?? Date.now()) - start
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const sec = Math.floor(ms / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60), s = sec % 60
  if (m < 60) return `${m}m${s ? ' ' + s + 's' : ''}`
  const h = Math.floor(m / 60), mm = m % 60
  return `${h}h ${mm}m`
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${h}:${mi}`
}

// Soft, narrative time labels — "今晨 8 点 / 昨夜 3 点 / 前天傍晚" —
// instead of the precise digital stamp. Dreams aren't measured in minutes.
export function formatRelativeTime(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayDiff = Math.round((nowStart - dStart) / (24 * 3600 * 1000))
  const hour = d.getHours()
  const lang = typeof w().getLang === 'function' ? w().getLang() : 'en'
  const period = periodFor(hour, lang)
  if (lang === 'zh') {
    if (dayDiff === 0) return `今${period}`
    if (dayDiff === 1) return `昨${period}`
    if (dayDiff === 2) return `前${period}`
    if (dayDiff < 7) return `${dayDiff} 天前的${period}`
    if (dayDiff < 30) return `${Math.floor(dayDiff / 7)} 周前`
    return `${Math.floor(dayDiff / 30)} 个月前`
  } else {
    if (dayDiff === 0) return `This ${period}`
    if (dayDiff === 1) return `Yesterday ${period}`
    if (dayDiff === 2) return `Two days ago, ${period}`
    if (dayDiff < 7) return `${dayDiff} days ago, ${period}`
    if (dayDiff < 30) return `${Math.floor(dayDiff / 7)} weeks ago`
    return `${Math.floor(dayDiff / 30)} months ago`
  }
}

// Hour → period name. Asymmetric on purpose: night has more granularity
// (深夜 / 夜里 / 入夜) because the dream metaphor lives there.
function periodFor(hour: number, lang: string): string {
  if (lang === 'zh') {
    if (hour < 5)  return '深夜'    // 0-4
    if (hour < 7)  return '清晨'    // 5-6
    if (hour < 9)  return '早晨'    // 7-8
    if (hour < 12) return '上午'    // 9-11
    if (hour < 14) return '午间'    // 12-13
    if (hour < 17) return '下午'    // 14-16
    if (hour < 19) return '黄昏'    // 17-18
    if (hour < 22) return '夜里'    // 19-21
    return '深夜'                   // 22-23
  } else {
    if (hour < 5)  return 'late night'
    if (hour < 7)  return 'dawn'
    if (hour < 9)  return 'morning'
    if (hour < 12) return 'late morning'
    if (hour < 14) return 'noon'
    if (hour < 17) return 'afternoon'
    if (hour < 19) return 'dusk'
    if (hour < 22) return 'evening'
    return 'late night'
  }
}

// Map a backend-returned error code to a human-readable, dream-themed message.
export function triggerErrorMessage(reason: unknown): string {
  if (reason === 'no-context') return t('memory_trigger_no_context')
  if (reason === 'gate-closed') return t('memory_trigger_gate_closed')
  if (reason === 'lock-held') return t('memory_trigger_lock_held')
  if (reason === 'lock-error') return t('memory_trigger_lock_error')
  if (reason === 'pre-dream-error') return t('memory_trigger_not_ready')
  if (reason === 'already-running') return t('memory_trigger_lock_held')
  return t('memory_trigger_failed')
}

// Pull the frontmatter `description: ...` line from a memory file. Cheap
// regex parse: don't pull in a full YAML parser for one field.
export interface MemoryFileInfo {
  description?: string
  error?: string
  detail?: string
}

export async function fetchFileDescription(path: string): Promise<MemoryFileInfo> {
  try {
    const r = await w().klaus.memory.readFile(path)
    if (!r?.ok) return { error: 'unreadable', detail: r?.error }
    const text = String(r.content ?? '')
    // Frontmatter must start at very beginning of file. Scan only the
    // leading ~2KB so we don't pay for body content.
    const head = text.slice(0, 2048)
    const fm = /^---\s*\n([\s\S]*?)\n---/m.exec(head)
    if (!fm) return {}
    const desc = /^description\s*:\s*(.+?)\s*$/m.exec(fm[1])
    if (!desc) return {}
    // Strip surrounding quotes if present and trim trailing whitespace.
    let value = desc[1].trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return { description: value }
  } catch (err) {
    return { error: 'unreadable', detail: err instanceof Error ? err.message : String(err) }
  }
}

// ---- 跨模块协议 ----
// dream:event 的最新快照住模块级（页面未挂载时也要驱动侧栏红点）；
// 组件挂载时读快照、随事件更新。
export const MEMORY_DREAM_EVENT = 'klaus:memory-dream-event'

let currentDreamSnapshot: DreamRun | null = null

export function getCurrentDream(): DreamRun | null {
  return currentDreamSnapshot
}

export function setCurrentDream(snap: DreamRun | null): void {
  currentDreamSnapshot = snap
}

export function updateSidebarDot(active: boolean): void {
  document.getElementById('btn-memory')?.classList.toggle('has-active', !!active)
}
