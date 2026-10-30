import { modelOptionsForValue, type CursorModelMetadata } from '../../../../shared/cursor-model-catalog'
// Cron 任务表单弹窗（迁自 js/cron.js 的 openForm/saveForm 一族）：
// 频率下拉 + 一次性日期日历 + 滚轮时间 + 时区自动完成 + 通道绑定。
// cron-modal / cron-dd / cron-date / cron-time / cron-tz 类名与旧版逐一对应；
// 弹层全部 position:fixed（escape modal overflow），单开语义由 openPopup 态承担。
import { useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useT } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import { AUTH_MODE_ORDER, sourceLabel } from '../settings/model-shared'
import { channelLabelOf, compileSchedule, fmtDate, pad2, parseSchedule, resolvedCronTaskTimezone, retainedCronTaskFields } from './data'
import type { CronTask } from './data'
import { cronThinkingItems, cronThinkingLevels, cronThinkingSelection, cronThinkingValue, DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from './model-thinking'
import styles from './cron.module.css'

const w = () => window as any

interface ModelOption extends CursorModelMetadata { value: string; label: string; description?: string; supportedThinkingLevels?: string[]; defaultThinkingLevel?: string }

// Position a popup below its anchor using viewport coords (the popups use
// `position: fixed` so they escape the modal's overflow clipping). Flips to
// align right edge when the popup would spill off-screen.
export function positionPopup(anchor: HTMLElement, popup: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  popup.style.top = (rect.bottom + 4) + 'px'
  popup.style.left = rect.left + 'px'
  popup.style.right = 'auto'
  requestAnimationFrame(() => {
    const pr = popup.getBoundingClientRect()
    if (pr.right > window.innerWidth - 8) {
      popup.style.left = Math.max(8, rect.right - pr.width) + 'px'
    }
    if (pr.bottom > window.innerHeight - 8) {
      popup.style.top = Math.max(8, rect.top - pr.height - 4) + 'px'
    }
  })
}

type PopupId = 'freq' | 'weekday' | 'monthday' | 'date' | 'time' | 'tz' | 'source' | 'model' | 'thinking' | 'project' | null

// ---- Custom dropdown (button + floating panel) ----
// Preferred over a native <select> so the open panel matches Klaus styling
// rather than rendering as an OS-native list with system accent colors.
function CronDd({ id, cls, value, items, hidden, open, onToggle, onPick }: {
  id: string
  cls: string
  value: string
  items: Array<{ value: string; label: string }>
  hidden?: boolean
  open: boolean
  onToggle: () => void
  onPick: (value: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const current = items.find(item => item.value === value)

  useEffect(() => {
    if (!open) return
    const trigger = rootRef.current?.querySelector<HTMLElement>(`.${styles['cron-dd-trigger']}`)
    if (trigger && panelRef.current) positionPopup(trigger, panelRef.current)
  }, [open])

  return (
    <div className={`${styles['cron-dd']} ${cls}${open ? ' open' : ''}`} id={id} data-value={value} hidden={hidden} ref={rootRef}>
      <button type="button" className={styles['cron-dd-trigger']} onClick={(e) => { e.stopPropagation(); onToggle() }}>
        <span className="cron-dd-text">{current?.label ?? value}</span>
        <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: rawIconHtml('cron-dd-caret') }} />
      </button>
      <div className={styles['cron-dd-panel']} hidden={!open} role="listbox" ref={panelRef} onClick={(e) => {
        const item = (e.target as Element).closest(`.${styles['cron-dd-item']}`) as HTMLElement | null
        if (!item) return
        onPick(item.dataset.value || '')
      }}>
        {items.map(item => (
          <button
            type="button"
            key={item.value}
            className={`${styles['cron-dd-item']}${item.value === value ? ' is-selected' : ''}`}
            data-value={item.value}
            role="option"
          >{item.label}</button>
        ))}
      </div>
    </div>
  )
}

// ---- Wheel time picker (two scrollable columns, snap-on-scroll) ----
const WHEEL_ITEM_H = 32
const WHEEL_VISIBLE = 7   // odd: center row is active
const WHEEL_PAD = Math.floor(WHEEL_VISIBLE / 2) * WHEEL_ITEM_H
const HOUR_VALUES = Array.from({ length: 24 }, (_, i) => i)
const MINUTE_VALUES = Array.from({ length: 60 }, (_, i) => i)

function Wheel({ kind, values, wheelRef, onSettle }: {
  kind: string
  values: number[]
  wheelRef: RefObject<HTMLDivElement | null>
  onSettle: () => void
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncActive = (el: HTMLElement) => {
    const idx = Math.round(el.scrollTop / WHEEL_ITEM_H)
    el.querySelectorAll(`.${styles['cron-wheel-item']}`).forEach((it, i) => it.classList.toggle('is-active', i === idx))
  }
  return (
    <div
      className={styles['cron-wheel']}
      data-wheel={kind}
      aria-label={kind === 'hour' ? 'Hour' : 'Minute'}
      ref={wheelRef}
      onScroll={(e) => {
        const el = e.currentTarget
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => { syncActive(el); onSettle() }, 90)
      }}
      onClick={(e) => {
        const item = (e.target as Element).closest(`.${styles['cron-wheel-item']}`)
        if (!item) return
        const parent = item.parentElement as HTMLElement
        const idx = [...parent.querySelectorAll(`.${styles['cron-wheel-item']}`)].indexOf(item)
        parent.scrollTo({ top: idx * WHEEL_ITEM_H, behavior: 'smooth' })
      }}
    >
      <div className={styles['cron-wheel-pad']} style={{ height: WHEEL_PAD + 'px' }} />
      {values.map(v => (
        <button type="button" className={styles['cron-wheel-item']} data-value={String(v)} key={v}>{pad2(v)}</button>
      ))}
      <div className={styles['cron-wheel-pad']} style={{ height: WHEEL_PAD + 'px' }} />
    </div>
  )
}

// ---- Calendar date picker (YYYY-MM-DD) ----
const DAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function CalendarGrid({ viewY, viewM, selected, onPick }: {
  viewY: number
  viewM: number
  selected: string
  onPick: (iso: string) => void
}) {
  const first = new Date(viewY, viewM, 1)
  const startDow = first.getDay()
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate()
  const daysInPrev = new Date(viewY, viewM, 0).getDate()
  const cells: Array<{ day: number; other: boolean; iso?: string }> = []
  // Previous month tail
  for (let i = startDow - 1; i >= 0; i--) {
    cells.push({ day: daysInPrev - i, other: true })
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, other: false, iso: fmtDate(viewY, viewM + 1, d) })
  }
  // Next month leading — pad to 42 cells (6 rows)
  let next = 1
  while (cells.length < 42) cells.push({ day: next++, other: true })
  return (
    <div className={styles['cron-date-grid']} onClick={(e) => {
      const cell = (e.target as Element).closest(`.${styles['cron-date-cell']}[data-iso]`) as HTMLElement | null
      if (cell?.dataset.iso) onPick(cell.dataset.iso)
    }}>
      {cells.map((c, i) => {
        const isSel = !!c.iso && c.iso === selected
        const cls = styles['cron-date-cell'] + (c.other ? ' ' + styles['is-other'] : '') + (isSel ? ' is-selected' : '')
        return c.iso
          ? <button type="button" className={cls} data-iso={c.iso} key={i}>{c.day}</button>
          : <span className={cls} key={i}>{c.day}</span>
      })}
    </div>
  )
}

function defaultIsoToday(): string {
  const d = new Date()
  return fmtDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

// Time picker default for new tasks — the user usually wants "something
// near now" rather than a pinned 09:00. Edit flows still restore the
// stored hour/minute via the parsed hour/minute branch.
function defaultTimeNow(): { h: number; m: number } {
  const d = new Date()
  return { h: d.getHours(), m: d.getMinutes() }
}

export interface CronFormResult {
  saved: boolean
}

export function CronTaskFormModal({ existing, onClose, onSaved }: {
  existing: CronTask | null
  onClose: () => void
  onSaved: (intent?: 'run') => void
}) {
  const t = useT()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const editingId = existing?.id ?? null

  // ---- Schedule picker state（openForm 的初始化逻辑内嵌在 useState 惰性求值里） ----
  const initial = (() => {
    const parsed = parseSchedule(existing?.schedule, !!existing?.deleteAfterRun)
    const now = defaultTimeNow()
    if (parsed) {
      return {
        freq: parsed.freq,
        hour: parsed.hour != null ? Number(parsed.hour) : now.h,
        minute: parsed.minute != null ? Number(parsed.minute) : now.m,
        weekday: parsed.weekday ?? '1',
        monthday: parsed.monthday ?? '1',
        interval: parsed.interval ?? '30',
        isoDate: parsed.isoDate ?? defaultIsoToday(),
        custom: '',
      }
    }
    if (existing?.schedule) {
      return { freq: 'custom', hour: now.h, minute: now.m, weekday: '1', monthday: '1', interval: '30', isoDate: defaultIsoToday(), custom: existing.schedule }
    }
    return { freq: 'daily', hour: now.h, minute: now.m, weekday: '1', monthday: '1', interval: '30', isoDate: defaultIsoToday(), custom: '' }
  })()

  const [freq, setFreq] = useState(initial.freq)
  const [weekday, setWeekday] = useState(initial.weekday)
  const [monthday, setMonthday] = useState(initial.monthday)
  const [isoDate, setIsoDate] = useState(initial.isoDate)
  const [time, setTime] = useState({ h: initial.hour, m: initial.minute })
  const [openPopup, setOpenPopup] = useState<PopupId>(null)
  // currently displayed month (independent of selection)
  const [dateView, setDateView] = useState(() => {
    const [y, m] = initial.isoDate.split('-').map(Number)
    return { y, m: m - 1 }
  })

  const nameRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const intervalRef = useRef<HTMLInputElement>(null)
  const customRef = useRef<HTMLInputElement>(null)
  const tzInputRef = useRef<HTMLInputElement>(null)
  const wheelHourRef = useRef<HTMLDivElement>(null)
  const wheelMinuteRef = useRef<HTMLDivElement>(null)
  const datePopupRef = useRef<HTMLDivElement>(null)
  const dateTriggerRef = useRef<HTMLButtonElement>(null)
  const timePopupRef = useRef<HTMLDivElement>(null)
  const timeTriggerRef = useRef<HTMLButtonElement>(null)
  const tzPanelRef = useRef<HTMLDivElement>(null)
  const modalBodyRef = useRef<HTMLDivElement>(null)

  // ---- Timezone autocomplete (input + filtered Klaus-styled panel) ----
  const [tzQuery, setTzQuery] = useState(existing?.timezone ?? '')
  const tzAll: string[] = (() => {
    try { return (Intl as any).supportedValuesOf?.('timeZone') || [] } catch { return [] }
  })()
  const tzMatches = (tzQuery.trim()
    ? tzAll.filter(z => z.toLowerCase().includes(tzQuery.trim().toLowerCase()))
    : tzAll
  ).slice(0, 60)

  // ---- Channel binding（write-once：编辑态只读 summary，新建态才可挑） ----
  const [boundSummary, setBoundSummary] = useState<{ text: string; locked: boolean } | null>(null)
  const [channelHint, setChannelHint] = useState<{ text: string; warning: boolean }>({ text: '', warning: false })
  const [channelLoadFailed, setChannelLoadFailed] = useState(false)
  const [channelReloadSequence, setChannelReloadSequence] = useState(0)
  const baseChannelHintRef = useRef('')
  const channelHostRef = useRef<HTMLDivElement>(null)
  const channelSelectRef = useRef<any>(null)

  // ---- Project binding（定时任务跑在哪个项目目录里） ----
  const [projectItems, setProjectItems] = useState<Array<{ value: string; label: string }>>([])
  const [workdirValue, setWorkdirValue] = useState(existing?.workdir ?? '')
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let roots: string[] = []
      const labels: Record<string, string> = {}
      try {
        const state = await w().klaus.projects?.list?.()
        roots = Array.isArray(state?.roots)
          ? state.roots.map((root: any) => (typeof root === 'string' ? root : root?.path)).filter((value: any) => typeof value === 'string' && !value.startsWith('ssh://'))
          : []
        if (state?.labels && typeof state.labels === 'object') Object.assign(labels, state.labels)
      } catch {}
      if (cancelled) return
      const items = [...new Set(roots)].map(root => ({ value: root, label: labels[root] || root.split('/').filter(Boolean).pop() || root }))
      // A stored directory that no longer registers as a project stays pickable
      // so editing the task does not silently drop the binding.
      if (workdirValue && !items.some(item => item.value === workdirValue)) {
        items.unshift({ value: workdirValue, label: workdirValue.split('/').filter(Boolean).pop() || workdirValue })
      }
      setProjectItems(items)
    })()
    return () => { cancelled = true }
  }, [])

  // ---- Model source & model & thinking（对齐输入区两级模型菜单） ----
  // The stored value is the full session mode (`source:id`), the same shape the
  // composer pins onto a conversation. The form splits it into a source pick
  // plus a per-source catalog pick; an empty model means the app default.
  const [modelValue, setModelValue] = useState(existing?.model ?? '')
  const sourcePrefixOf = (mode: string) => AUTH_MODE_ORDER.find(source => mode.startsWith(source + ':')) ?? ''
  const [sourceValue, setSourceValue] = useState(() => sourcePrefixOf(existing?.model ?? ''))
  const [sourceItems, setSourceItems] = useState<Array<{ value: string; label: string }>>([])
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [thinkingValue, setThinkingValue] = useState(
    existing?.thinking && THINKING_LEVELS.includes(existing.thinking) ? existing.thinking : DEFAULT_THINKING_LEVEL,
  )
  const thinkingLevelsOf = (value: string) => sourceValue === 'cursor' && !value.startsWith('cursor:') ? [] : cronThinkingLevels(modelOptions, value)
  const displayedThinking = cronThinkingValue(modelOptions, modelValue, thinkingValue)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Every supported source uses the user's own provider credentials.
      let current = ''
      try { current = String((await w().klaus.session.getMainModel(null, { resolve: false }))?.source || '') } catch {}
      if (cancelled) return
      setSourceItems(AUTH_MODE_ORDER.map(source => ({ value: source, label: sourceLabel(source) })))
      if (!sourceValue) setSourceValue(current && AUTH_MODE_ORDER.includes(current) ? current : (AUTH_MODE_ORDER[0] ?? ''))
    })()
    return () => { cancelled = true }
  }, [])
  // The model catalog belongs to the picked source; switching source reloads it.
  useEffect(() => {
    if (!sourceValue) return
    let cancelled = false
    ;(async () => {
      let rows: ModelOption[] = []
      try {
        const result = await w().klaus.session.getMainModelOptions(sourceValue)
        const options: ModelOption[] = Array.isArray(result?.options) ? result.options : []
        rows = options
          .map(option => ({ ...option, value: String(option.value || '') }))
          .filter(option => option.value && option.value !== 'auto')
      } catch {}
      if (!cancelled) setModelOptions(rows)
    })()
    return () => { cancelled = true }
  }, [sourceValue])
  // The source the model row shows: the stored pick wins over the browsing pick.
  const activeSource = sourcePrefixOf(modelValue) || sourceValue

  // ---- Notification policy（默认仅失败通知） ----
  const [notifyPolicy, setNotifyPolicy] = useState<'' | 'all_runs' | 'failed_runs_only'>(
    existing?.notificationPolicy === 'all_runs' ? 'all_runs' : '',
  )

  // Channel-specific gotchas that aren't obvious from the dropdown item alone.
  // QQ is the current standout: official bots can't send proactive messages
  // without audit approval, so a cron-triggered push can silently fail on the
  // server side.
  const updateChannelHint = (pickedValue: string) => {
    if (pickedValue === 'qq') {
      setChannelHint({ text: t('cron_form_channel_qq_warning'), warning: true })
      return
    }
    setChannelHint({ text: baseChannelHintRef.current, warning: false })
  }

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      // Binding is write-once: set on create, never changed. So in edit mode
      // we always show a read-only summary — never the editable dropdown.
      if (editingId) {
        if (existing?.channelBinding) {
          const b = existing.channelBinding
          const label = channelLabelOf(b.channelId)
          const target = b.chatType === 'group'
            ? t('cron_form_channel_group') + (b.label || b.targetId)
            : (b.label || t('cron_form_channel_me'))
          setBoundSummary({ text: `${label} · ${target}`, locked: true })
        } else {
          setBoundSummary({ text: t('cron_form_channel_none_bound'), locked: false })
        }
        return
      }

      setChannelLoadFailed(false)
      let channels: any[]
      try {
        const loaded = await w().klaus.channels.list()
        if (!Array.isArray(loaded)) throw new Error(t('cron_form_channel_load_failed'))
        channels = loaded
      } catch {
        if (!cancelled) {
          setChannelLoadFailed(true)
          setChannelHint({ text: t('cron_form_channel_load_failed'), warning: true })
        }
        return
      }
      const items: any[] = [{ value: '', i18nKey: 'cron_form_channel_none' }]
      const pendingDmChannels: string[] = []
      try {
        for (const ch of channels) {
          if (!ch.connected) continue
          // owner_id is captured on first DM to the bot; until that happens we
          // don't have a target for "send to me" delivery. Drop the channel from
          // the picker and explain in the hint below.
          const key = `channel.${ch.id}.owner_id`
          const ownerId = await w().klaus.settings.kv.get(key)
          const label = channelLabelOf(ch.id)
          if (ownerId) {
            items.push({ value: ch.id, label: `${label} · ${t('cron_form_channel_me')}` })
          } else {
            pendingDmChannels.push(label)
          }
        }
      } catch {
        if (!cancelled) {
          setChannelLoadFailed(true)
          setChannelHint({ text: t('cron_form_channel_load_failed'), warning: true })
        }
        return
      }
      if (cancelled || !channelHostRef.current) return
      channelSelectRef.current = w().klsSelect.bind(channelHostRef.current, {
        items,
        value: '',
        onChange: (value: string) => updateChannelHint(value),
      })

      // Hint morphs depending on what's available.
      baseChannelHintRef.current = pendingDmChannels.length
        ? t('cron_form_channel_hint_dm') + pendingDmChannels.join(', ') + t('cron_form_channel_hint_dm_suffix')
        : t('cron_form_channel_hint')
      updateChannelHint('')
    }
    void run()
    return () => { cancelled = true; channelSelectRef.current?.destroy?.() }
  }, [channelReloadSequence])

  useEffect(() => {
    const timer = setTimeout(() => nameRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  // Escape：关掉浮层 + 关表单（旧版两个 document 监听同时命中，语义一致）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpenPopup(null)
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 外点关浮层（点击 trigger 自身已 stopPropagation）。
  useEffect(() => {
    const onDocClick = () => setOpenPopup(null)
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [])

  const togglePopup = (id: Exclude<PopupId, null>) => {
    setOpenPopup(prev => (prev === id ? null : id))
  }

  // 打开日期/时间浮层时定位 + 滚轮就位（hidden 时 scrollTop 写入无效，必须开后 rAF）。
  useEffect(() => {
    if (openPopup === 'date' && dateTriggerRef.current && datePopupRef.current) {
      positionPopup(dateTriggerRef.current, datePopupRef.current)
    }
    if (openPopup === 'time' && timeTriggerRef.current && timePopupRef.current) {
      positionPopup(timeTriggerRef.current, timePopupRef.current)
      requestAnimationFrame(() => {
        const setWheel = (el: HTMLElement | null, n: number) => {
          if (!el) return
          el.scrollTop = n * WHEEL_ITEM_H
          const idx = Math.round(el.scrollTop / WHEEL_ITEM_H)
          el.querySelectorAll(`.${styles['cron-wheel-item']}`).forEach((it, i) => it.classList.toggle('is-active', i === idx))
        }
        setWheel(wheelHourRef.current, time.h)
        setWheel(wheelMinuteRef.current, time.m)
      })
    }
    if (openPopup === 'tz' && tzInputRef.current && tzPanelRef.current) {
      positionPopup(tzInputRef.current, tzPanelRef.current)
    }
  }, [openPopup])

  // Written after user scroll — wheel positions drive the trigger text.
  const settleTimeFromWheels = () => {
    const hh = wheelHourRef.current ? Math.round(wheelHourRef.current.scrollTop / WHEEL_ITEM_H) : time.h
    const mm = wheelMinuteRef.current ? Math.round(wheelMinuteRef.current.scrollTop / WHEEL_ITEM_H) : time.m
    setTime({ h: hh, m: mm })
  }

  const saveForm = async (intent?: 'run') => {
    if (saving) return
    const name = nameRef.current?.value.trim() || ''
    const prompt = promptRef.current?.value.trim() || ''
    const isCustom = freq === 'custom'
    const isOneShot = freq === 'oneshot'

    if (isOneShot && !isoDate) {
      await w().klausDialog.alert(t('cron_form_date_required'))
      return
    }

    const schedule = isCustom
      ? (customRef.current?.value.trim() || '')
      : compileSchedule({
          freq,
          hour: time.h,
          minute: time.m,
          weekday,
          monthday,
          interval: intervalRef.current?.value ?? '30',
          isoDate,
        })

    if (!schedule || !prompt) {
      await w().klausDialog.alert(t('cron_fields_required'))
      return
    }
    if (isCustom && schedule.split(/\s+/).length !== 5) {
      await w().klausDialog.alert(t('cron_form_schedule_invalid'))
      return
    }

    const now = Date.now()
    const id = editingId ?? ('task-' + now.toString(36))
    const tz = resolvedCronTaskTimezone(existing, isCustom, tzInputRef.current?.value || '')
    const model = modelValue || undefined
    const workdir = workdirValue || undefined
    const thinking = modelValue.startsWith('cursor:') || thinkingLevelsOf(modelValue).includes(displayedThinking) ? displayedThinking : DEFAULT_THINKING_LEVEL

    // channelBinding is only written on create. Edits retain whatever the
    // row already had (upsertTask preserves the column on conflict).
    let channelBinding
    let createdBy
    if (!editingId) {
      const pickedChannel = channelSelectRef.current?.getValue?.() || ''
      if (pickedChannel && !pickedChannel.startsWith('__disabled__:')) {
        let ownerId
        try {
          ownerId = await w().klaus.settings.kv.get(`channel.${pickedChannel}.owner_id`)
        } catch (error: any) {
          const message = error?.message || t('cron_form_channel_load_failed')
          setSaveError(message)
          w().showToast?.(message)
          return
        }
        if (ownerId) {
          channelBinding = {
            channelId: pickedChannel,
            accountId: 'default',
            targetId: ownerId,
            chatType: 'direct',
          }
          createdBy = 'manual'
        }
      }
      if (!createdBy) createdBy = 'manual'
    }

    setSaving(true)
    setSaveError('')
    try {
      const result = await w().klaus.settings.cron.upsert({
        id,
        name: name || undefined,
        schedule,
        prompt,
        ...retainedCronTaskFields(existing),
        deleteAfterRun: isOneShot,
        timezone: tz,
        channelBinding,
        createdBy,
        model: model || null,
        workdir: workdir || null,
        thinking,
        notificationPolicy: notifyPolicy || 'failed_runs_only',
        createdAt: editingId ? undefined : now,
        updatedAt: now,
      })
      if (result?.ok === false || result?.error) throw new Error(result.error || t('settings_failed'))
      onSaved(intent)
    } catch (error: any) {
      const message = error?.message || t('settings_failed')
      setSaveError(message)
      w().showToast?.(message)
    } finally {
      setSaving(false)
    }
  }

  const freqItems = [
    { value: 'oneshot', label: t('cron_freq_oneshot') },
    { value: 'interval', label: t('cron_freq_interval') },
    { value: 'hourly', label: t('cron_freq_hourly') },
    { value: 'daily', label: t('cron_every_day') },
    { value: 'weekdays', label: t('cron_weekdays') },
    { value: 'weekly', label: t('cron_weekly') },
    { value: 'monthly', label: t('cron_monthly') },
    { value: 'custom', label: t('cron_freq_custom') },
  ]
  const weekdayItems = [
    { value: '1', label: t('cron_monday') },
    { value: '2', label: t('cron_tuesday') },
    { value: '3', label: t('cron_wednesday') },
    { value: '4', label: t('cron_thursday') },
    { value: '5', label: t('cron_friday') },
    { value: '6', label: t('cron_saturday') },
    { value: '0', label: t('cron_sunday') },
  ]
  // Day-of-month dropdown (1-31).
  const monthdayItems = Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))

  // Time picker is meaningless for interval / hourly / custom.
  const timeHidden = freq === 'interval' || freq === 'hourly' || freq === 'custom'
  const icon = (name: string): ReactNode => (
    <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: rawIconHtml(name) }} />
  )

  return (
    <div id="cron-modal" className={`${styles['cron-modal']} active`}>
      <div className={styles['cron-modal-backdrop']} id="cron-modal-backdrop" onClick={onClose} />
      <div className={styles['cron-modal-card']}>
        <div className={styles['cron-modal-header']}>
          <h2 id="cron-modal-title">{editingId ? t('cron_edit') : t('cron_new')}</h2>
          <button className={styles['cron-modal-close']} id="cron-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div
          className={styles['cron-modal-body']}
          ref={modalBodyRef}
          // Popups are position:fixed, so they can't follow internal modal
          // scroll — close them all so they don't float off anchor.
          onScroll={() => setOpenPopup(null)}
        >
          <p className={styles['cron-modal-subtitle']}>{t('cron_subtitle')}</p>

          <div className={styles['cron-form-row']}>
            <label>{t('cron_form_name')}</label>
            <input id="cron-form-name" type="text" placeholder={t('cron_form_name_placeholder')} defaultValue={existing?.name ?? ''} ref={nameRef} />
          </div>

          <div className={styles['cron-form-row']}>
            <label>{t('cron_form_schedule_time')}</label>
            <div className={styles['cron-schedule-picker']}>
              {/* Primary: frequency mode */}
              <CronDd
                id="cron-form-freq" cls={styles['cron-dd-freq']} value={freq} items={freqItems}
                open={openPopup === 'freq'} onToggle={() => togglePopup('freq')}
                onPick={(v) => { setFreq(v); setOpenPopup(null) }}
              />

              {/* Secondary: only one visible at a time, driven by mode */}
              {/* oneshot: date picker */}
              <div className={styles['cron-date']} id="cron-form-date" data-value={isoDate} hidden={freq !== 'oneshot'}>
                <button type="button" className={styles['cron-date-trigger']} ref={dateTriggerRef} onClick={(e) => { e.stopPropagation(); togglePopup('date') }}>
                  <span className={styles['cron-date-text']}>{isoDate || t('cron_form_pick_date')}</span>
                  {icon('cron-date-icon')}
                </button>
                <div className={styles['cron-date-popup']} hidden={openPopup !== 'date'} ref={datePopupRef} onClick={(e) => e.stopPropagation()}>
                  <div className={styles['cron-date-header']}>
                    <button type="button" className="cron-date-nav" data-dir="-1" aria-label="Previous month" onClick={() => {
                      setDateView(v => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))
                    }}>{icon('cron-date-nav-prev')}</button>
                    <span className={styles['cron-date-title']}>{`${MONTH_NAMES[dateView.m]} ${dateView.y}`}</span>
                    <button type="button" className="cron-date-nav" data-dir="1" aria-label="Next month" onClick={() => {
                      setDateView(v => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))
                    }}>{icon('cron-date-nav-next')}</button>
                  </div>
                  <div className={styles['cron-date-weekdays']}>
                    {DAY_SHORT.map(d => <span key={d}>{d}</span>)}
                  </div>
                  <CalendarGrid viewY={dateView.y} viewM={dateView.m} selected={isoDate} onPick={(iso) => {
                    setIsoDate(iso)
                    const [y, m] = iso.split('-').map(Number)
                    setDateView({ y, m: m - 1 })
                    setOpenPopup(null)
                  }} />
                </div>
              </div>

              {/* weekly: weekday dropdown */}
              <CronDd
                id="cron-form-weekday" cls={styles['cron-dd-weekday']} value={weekday} items={weekdayItems}
                hidden={freq !== 'weekly'}
                open={openPopup === 'weekday'} onToggle={() => togglePopup('weekday')}
                onPick={(v) => { setWeekday(v); setOpenPopup(null) }}
              />

              {/* monthly: day-of-month dropdown */}
              <CronDd
                id="cron-form-monthday" cls={styles['cron-dd-monthday']} value={monthday} items={monthdayItems}
                hidden={freq !== 'monthly'}
                open={openPopup === 'monthday'} onToggle={() => togglePopup('monthday')}
                onPick={(v) => { setMonthday(v); setOpenPopup(null) }}
              />

              {/* interval: number + unit */}
              <div className={styles['cron-interval']} id="cron-form-interval-wrap" hidden={freq !== 'interval'}>
                <input type="number" id="cron-form-interval" className={styles['cron-interval-input']} min={1} max={59} defaultValue={initial.interval} ref={intervalRef} />
                <span className={styles['cron-interval-unit']}>{t('cron_unit_minutes')}</span>
              </div>

              {/* custom: raw cron input (inline) */}
              <input type="text" id="cron-form-schedule" className={styles['cron-schedule-input']} placeholder="0 9 * * *" hidden={freq !== 'custom'} defaultValue={initial.custom} ref={customRef} />

              {/* Wheel-style time picker — hidden for hourly / interval / custom */}
              <div className={styles['cron-time']} id="cron-form-time" data-hour={String(time.h)} data-minute={String(time.m)} hidden={timeHidden}>
                <button type="button" className={styles['cron-time-trigger']} ref={timeTriggerRef} onClick={(e) => { e.stopPropagation(); togglePopup('time') }}>
                  <span className="cron-time-text">{`${pad2(time.h)}:${pad2(time.m)}`}</span>
                  {icon('cron-time-icon')}
                </button>
                <div className={styles['cron-time-popup']} hidden={openPopup !== 'time'} ref={timePopupRef} onClick={(e) => e.stopPropagation()}>
                  <div className={styles['cron-time-band']} aria-hidden="true" />
                  <Wheel kind="hour" values={HOUR_VALUES} wheelRef={wheelHourRef} onSettle={settleTimeFromWheels} />
                  <Wheel kind="minute" values={MINUTE_VALUES} wheelRef={wheelMinuteRef} onSettle={settleTimeFromWheels} />
                </div>
              </div>
            </div>

            {/* Timezone row, only when custom */}
            <div className={styles['cron-tz-row']} id="cron-form-tz-row" hidden={freq !== 'custom'}>
              <label>{t('cron_form_timezone')}</label>
              <div className={`${styles['cron-tz']}${openPopup === 'tz' ? ' open' : ''}`} id="cron-form-tz">
                <input
                  type="text" id="cron-form-timezone" className={styles['cron-tz-input']} placeholder="Asia/Shanghai"
                  autoComplete="off" spellCheck={false} defaultValue={existing?.timezone ?? ''} ref={tzInputRef}
                  onFocus={() => { if (tzMatches.length) setOpenPopup('tz') }}
                  onInput={(e) => {
                    setTzQuery((e.target as HTMLInputElement).value)
                    setOpenPopup('tz')
                  }}
                  onBlur={() => setTimeout(() => setOpenPopup(prev => (prev === 'tz' ? null : prev)), 120)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div
                  className={styles['cron-tz-panel']} hidden={openPopup !== 'tz' || !tzMatches.length} role="listbox" ref={tzPanelRef}
                  onMouseDown={(e) => {
                    // mousedown (not click) so blur doesn't fire first and close the panel.
                    const item = (e.target as Element).closest(`.${styles['cron-tz-item']}`) as HTMLElement | null
                    if (!item) return
                    e.preventDefault()
                    if (tzInputRef.current) tzInputRef.current.value = item.dataset.value || ''
                    setOpenPopup(null)
                  }}
                >
                  {tzMatches.map(z => (
                    <button type="button" className={styles['cron-tz-item']} data-value={z} role="option" key={z}>{z}</button>
                  ))}
                </div>
              </div>
            </div>

            <p className={styles['cron-form-hint']} id="cron-form-schedule-hint" hidden={freq !== 'custom'}>{t('cron_form_schedule_hint')}</p>
          </div>

          <div className={styles['cron-form-row']}>
            <label>{t('cron_form_project')}</label>
            <CronDd
              id="cron-form-project" cls={styles['cron-dd-project']} value={workdirValue}
              items={[{ value: '', label: t('cron_form_project_none') }, ...projectItems]}
              open={openPopup === 'project'} onToggle={() => togglePopup('project')}
              onPick={(v) => { setWorkdirValue(v); setOpenPopup(null) }}
            />
            <p className={styles['cron-form-hint']}>{t('cron_form_project_hint')}</p>
          </div>

          <div className={styles['cron-form-row']}>
            <label>{t('cron_form_channel')}</label>
            <div id="cron-form-channel" className="kls-select" hidden={!!editingId} ref={channelHostRef} />
            <div id="cron-form-channel-bound" className={`${styles['cron-form-channel-bound']}${boundSummary?.locked ? ' ' + styles['is-locked'] : ''}`} hidden={!editingId}>{boundSummary?.text ?? ''}</div>
            <p className={`${styles['cron-form-hint']}${channelHint.warning ? ' is-warning' : ''}`} id="cron-form-channel-hint">
              {channelHint.text || t('cron_form_channel_hint')}
              {channelLoadFailed ? <> <button type="button" className="btn-xs" onClick={() => setChannelReloadSequence(value => value + 1)}>{t('cron_retry')}</button></> : null}
            </p>
          </div>

          <div className={styles['cron-form-row']}>
            <label>{t('cron_form_prompt_label')}</label>
            <textarea id="cron-form-prompt" rows={5} placeholder={t('cron_form_prompt_placeholder')} defaultValue={existing?.prompt ?? ''} ref={promptRef} />
          </div>

          {/* Two-level model pick like the composer: source, then that source's
              catalog, then the reasoning level. The pick is frozen onto each
              run conversation; empty model = the app's remembered default. */}
          <div className={styles['cron-form-row']}>
            <label>{t('cron_form_model')}</label>
            <div className={styles['cron-model-row']}>
              <CronDd
                id="cron-form-source" cls={styles['cron-dd-source']} value={activeSource}
                items={sourceItems}
                hidden={!sourceItems.length}
                open={openPopup === 'source'} onToggle={() => togglePopup('source')}
                onPick={(v) => {
                  setSourceValue(v)
                  // A pick from another source cannot survive the switch; the
                  // catalog below now belongs to the newly picked source.
                  setModelValue(prev => (sourcePrefixOf(prev) === v ? prev : ''))
                  setOpenPopup(null)
                }}
              />
              <CronDd
                id="cron-form-model" cls={styles['cron-dd-model']} value={modelValue}
                items={[{ value: '', label: t('cron_form_model_default') }, ...modelOptionsForValue(modelOptions, modelValue).map(option => ({ value: option.value, label: option.label }))]}
                hidden={!modelOptions.length}
                open={openPopup === 'model'} onToggle={() => togglePopup('model')}
                onPick={(v) => {
                  setModelValue(v)
                  if (!thinkingLevelsOf(v).includes(thinkingValue)) setThinkingValue(DEFAULT_THINKING_LEVEL)
                  setOpenPopup(null)
                }}
              />
              <CronDd
                id="cron-form-thinking" cls={styles['cron-dd-thinking']} value={displayedThinking}
                hidden={!thinkingLevelsOf(modelValue).length}
                items={cronThinkingItems(modelOptions, modelValue, t)}
                open={openPopup === 'thinking'} onToggle={() => togglePopup('thinking')}
                onPick={(v) => {
                  const selection = cronThinkingSelection(modelOptions, modelValue, v)
                  if (selection) { setThinkingValue(selection.thinking); setModelValue(selection.model) }
                  setOpenPopup(null)
                }}
              />
            </div>
            <p className={styles['cron-form-hint']}>{t('cron_form_model_hint')}</p>
          </div>

          {/* Per-task notification policy. Default = notify on
              failures only; the toggle opts into a banner for every run. */}
          <div className={styles['cron-form-row']}>
            <label>{t('cron_form_notify')}</label>
            <div className={`${styles['cron-notify-toggle']}${notifyPolicy === 'all_runs' ? ' on' : ''}`} id="cron-form-notify" role="switch" aria-checked={notifyPolicy === 'all_runs'}
              onClick={() => setNotifyPolicy(p => (p === 'all_runs' ? '' : 'all_runs'))}>
              <span className={styles['cron-notify-track']}><span className={styles['cron-notify-thumb']} /></span>
              <span className={styles['cron-notify-label']}>{t('cron_form_notify_all_runs')}</span>
            </div>
            <p className={styles['cron-form-hint']}>{t('cron_form_notify_hint')}</p>
          </div>
        </div>
        <div className={styles['cron-modal-footer']}>
          {saveError ? <span role="alert" className={styles['cron-form-save-error']}>{saveError}</span> : null}
          <button className="btn-secondary" id="cron-form-cancel" disabled={saving} onClick={onClose}>{t('cancel')}</button>
          {!editingId && (
            <button className="btn-secondary" id="cron-form-save-run" disabled={saving} onClick={() => { void saveForm('run') }}>{t('cron_save_run_now')}</button>
          )}
          <button className="btn-primary" id="cron-form-save" disabled={saving} onClick={() => { void saveForm() }}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}
