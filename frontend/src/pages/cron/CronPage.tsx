// Scheduled Tasks 页（React 岛）：
// 左侧任务列表（状态点 + 标题 + 调度摘要 + Next run/Paused/Last run failed），
// 点击行在右侧详情面板打开（编辑字段 + Previous runs 按日分组 + Open chat +
// Retry）；工具行 = 状态筛选（All/Active/Paused）+ 搜索 + Create 下拉
// （Set up manually / Create via Klaus）。运行历史不再独立成 tab。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { PageHeader } from '../../components/PageHeader'
import { ModalPortal } from '../../components/ModalPortal'
import { rawIconHtml } from '../../components/Icon'
import {
  CRON_PAGE_RELOAD_EVENT, CRON_PAGE_VISIBLE_EVENT, channelLabelOf, effectiveCronRunStatus, humanizeSchedule,
  navigateToCronRunSession, pad2, relFromNow, runMatchesSearch, sortTasksFlat, startOfDay, taskMatchesSearch,
} from './data'
import type { CronRun, CronStatus, CronTask } from './data'
import { CronTaskFormModal } from './form'
import styles from './cron.module.css'

const w = () => window as any
const api = () => w().klaus.settings.cron

interface TasksData {
  tasks: CronTask[]
  status: CronStatus
  lastRunByTask: Map<string, CronRun>
}

interface KebabState {
  task: CronTask
  anchorRect: DOMRect
}

function Raw({ name }: { name: string }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: rawIconHtml(name) }} />
}

/** 行 kebab 菜单（body 传送门 + 视口定位，右缘对齐锚点）。 */
function CardMenu({ state, onClose, onAct }: {
  state: KebabState
  onClose: () => void
  onAct: (act: 'run' | 'toggle' | 'edit' | 'delete') => void
}) {
  const t = useT()
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const pop = popRef.current
    if (!pop) return
    const rect = state.anchorRect
    pop.style.top = `${rect.bottom + 4}px`
    pop.style.left = `${rect.right - pop.offsetWidth}px`
  }, [state])

  useEffect(() => {
    const close = () => onClose()
    const timer = setTimeout(() => document.addEventListener('click', close), 0)
    return () => { clearTimeout(timer); document.removeEventListener('click', close) }
  }, [onClose])

  return (
    <div className={styles['cron-popover']} ref={popRef}>
      <button onClick={(e) => { e.stopPropagation(); onClose(); onAct('run') }}>{t('cron_run_now')}</button>
      <button onClick={(e) => { e.stopPropagation(); onClose(); onAct('toggle') }}>{state.task.enabled ? t('cron_disable') : t('cron_enable')}</button>
      <button onClick={(e) => { e.stopPropagation(); onClose(); onAct('edit') }}>{t('cron_edit')}</button>
      <button className={styles['cron-popover-danger']} onClick={(e) => { e.stopPropagation(); onClose(); onAct('delete') }}>{t('delete_title')}</button>
    </div>
  )
}

export function CronPage() {
  const t = useT()
  const [tasksData, setTasksData] = useState<TasksData>({ tasks: [], status: { nextRuns: {}, running: [] }, lastRunByTask: new Map() })
  const [runsByTask, setRunsByTask] = useState<Map<string, CronRun[]>>(new Map())
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'paused'>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [formTask, setFormTask] = useState<{ task: CronTask | null; runAfter?: boolean } | null>(null)
  const [kebab, setKebab] = useState<KebabState | null>(null)
  const [tasksLoaded, setTasksLoaded] = useState(false)
  const [tasksError, setTasksError] = useState('')
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set())
  const pendingTaskIdsRef = useRef(new Set<string>())
  const visibleRef = useRef(true)
  const stateRef = useRef({ statusFilter, selectedId, tasksData, runsByTask })
  stateRef.current = { statusFilter, selectedId, tasksData, runsByTask }

  const beginTaskOperation = (taskId: string): boolean => {
    if (pendingTaskIdsRef.current.has(taskId)) return false
    pendingTaskIdsRef.current.add(taskId)
    setPendingTaskIds(new Set(pendingTaskIdsRef.current))
    return true
  }

  const endTaskOperation = (taskId: string) => {
    pendingTaskIdsRef.current.delete(taskId)
    setPendingTaskIds(new Set(pendingTaskIdsRef.current))
  }

  const loadTasks = useCallback(async () => {
    setTasksError('')
    try {
      const [tasks, status, recentRuns] = await Promise.all([
        api().list(),
        api().status ? api().status().catch(() => null) : Promise.resolve(null),
        api().runs({ limit: 300 }).catch(() => []),
      ])
      if (!Array.isArray(tasks) || !Array.isArray(recentRuns)) throw new Error(t('cron_load_failed'))
      const lastRunByTask = new Map<string, CronRun>()
      const runsByTask = new Map<string, CronRun[]>()
      for (const r of recentRuns as CronRun[]) {
        const prev = lastRunByTask.get(r.taskId)
        if (!prev || r.startedAt > prev.startedAt) lastRunByTask.set(r.taskId, r)
        const list = runsByTask.get(r.taskId)
        if (list) list.push(r)
        else runsByTask.set(r.taskId, [r])
      }
      for (const list of runsByTask.values()) list.sort((a, b) => b.startedAt - a.startedAt)
      setTasksData({ tasks, status: status || { nextRuns: {}, running: [] }, lastRunByTask })
      setRunsByTask(runsByTask)
      try { w().refreshCronSidebar?.() } catch {}
    } catch (error: any) {
      setTasksError(error?.message || t('cron_load_failed'))
    } finally {
      setTasksLoaded(true)
    }
  }, [t])

  useEffect(() => { void loadTasks() }, [loadTasks])

  // onShow 进入（含语言切换 reload 由 useT 承担）→ 全量刷新。
  useEffect(() => {
    const onReload = () => { void loadTasks() }
    const onVisible = (event: Event) => { visibleRef.current = !!(event as CustomEvent).detail?.visible }
    window.addEventListener(CRON_PAGE_RELOAD_EVENT, onReload)
    window.addEventListener(CRON_PAGE_VISIBLE_EVENT, onVisible)
    return () => {
      window.removeEventListener(CRON_PAGE_RELOAD_EVENT, onReload)
      window.removeEventListener(CRON_PAGE_VISIBLE_EVENT, onVisible)
    }
  }, [loadTasks])

  // Relative labels ("in 3 hours") and running pulses go stale while the page
  // sits open — refresh on a slow cadence, only when the page is visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (visibleRef.current) void loadTasks()
    }, 30_000)
    return () => clearInterval(timer)
  }, [loadTasks])

  // 任务档的启用/暂停筛选是一个下拉框（klsSelect，跟随 header bodyHtml 重建重绑）。
  const bindTasksFilter = useCallback(() => {
    const host = document.getElementById('cron-tasks-status')
    if (!host) return
    w().klsSelect.bind(host, {
      items: [
        { value: 'all',     i18nKey: 'cron_filter_all' },
        { value: 'enabled', i18nKey: 'cron_filter_enabled' },
        { value: 'paused',  i18nKey: 'cron_filter_paused' },
      ],
      value: stateRef.current.statusFilter,
      onChange: (v: string) => setStatusFilter(v as 'all' | 'enabled' | 'paused'),
    })
  }, [])

  useEffect(() => { bindTasksFilter() }, [tasksData, bindTasksFilter])

  const toggleTaskEnabled = async (task: CronTask) => {
    if (!beginTaskOperation(task.id)) return
    try {
      const result = await api().upsert({ ...task, enabled: !task.enabled, updatedAt: Date.now() })
      if (result?.ok === false) throw new Error(result.error || t('settings_failed'))
      await loadTasks()
    } catch (error: any) {
      w().showToast?.(error?.message || t('settings_failed'))
    } finally {
      endTaskOperation(task.id)
    }
  }

  // Shared by the detail panel, the kebab menu, and the retry buttons.
  const runTaskNow = async (task: CronTask) => {
    if (!beginTaskOperation(task.id)) return
    try {
      const res = await api().runNow(task.id)
      if (!res?.ok) {
        const already = /already running/i.test(res?.error || '')
        throw new Error(already ? t('cron_run_already') : (res?.error || t('cron_run_failed')))
      }
      w().showToast?.(t('cron_run_started'))
      w().surfaceCronRunInSidebar?.(task.id)
      void loadTasks()
      setTimeout(() => { void loadTasks() }, 800)
    } catch (error: any) {
      w().showToast?.(error?.message || t('cron_run_failed'))
    } finally {
      endTaskOperation(task.id)
    }
  }

  const deleteTask = async (task: CronTask) => {
    if (!(await w().klausDialog.confirm({
      title: t('cron_delete_title').replace('{name}', task.name || t('cron_untitled')),
      message: t('cron_delete_message'),
      confirmText: t('cron_delete_confirm_btn'),
      danger: true,
    }))) return
    if (!beginTaskOperation(task.id)) return
    try {
      const result = await api().delete(task.id)
      if (!cronDeleteSucceeded(result)) throw new Error(result?.error || t('settings_failed'))
      if (stateRef.current.selectedId === task.id) setSelectedId('')
      await loadTasks()
    } catch (error: any) {
      w().showToast?.(error?.message || t('settings_failed'))
    } finally {
      endTaskOperation(task.id)
    }
  }

  // ---- "Create via Klaus" — seed the chat input with a real command chip ----
  const createViaKlaus = () => {
    w().hideCronView?.()
    const seed = t('cron_via_klaus_draft')
    const command = {
      name: 'cron-manager',
      displayName: t('cron_creator_command_label'),
      type: 'prompt',
      loadedFrom: 'bundled',
    }
    // Land on a fresh chat with the prompt pre-filled
    try {
      document.getElementById('btn-new-chat')?.click()
    } catch {}
    // Fill the input after DOM has caught up
    setTimeout(() => {
      if (w().klausComposer?.setSlashCommandDraft) {
        w().klausComposer.setSlashCommandDraft(command, seed)
      } else {
        const inp = document.getElementById('input') as HTMLTextAreaElement | null
        if (inp) {
          inp.value = `/cron-manager ${seed}`
          inp.dispatchEvent(new Event('input'))
          inp.focus()
        }
      }
    }, 100)
  }

  const openRunSession = async (sessionId: string) => {
    try {
      await navigateToCronRunSession(w(), sessionId)
    } catch (error: any) {
      w().showToast?.(error?.message || t('cron_load_failed'))
    }
  }

  // ---- 页头（工具行走 bodyHtml 保持吸顶结构，点击容器委托） ----
  const header = (
    <PageHeader
      titleKey="cron"
      subtitleKey="cron_subtitle"
      bodyHtml={`<div class="sk-tabbar">
              <div class="sk-filters"><div data-for-tab="tasks"><div id="cron-tasks-status" class="kls-select"></div></div></div>
            </div>`}
      refresh={{
        id: 'cron-refresh', titleKey: 'cron_refresh',
        onClick: async () => { await loadTasks() },
      }}
      search={{
        id: 'cron-search', placeholderKey: 'cron_search_placeholder', value: search,
        onInput: (value) => setSearch(value.trim()),
      }}
      create={{
        btnId: 'cron-new-btn',
        menuId: 'cron-create-menu',
        items: [
          { action: 'manual', labelKey: 'topbar_create_manual', iconHtml: w().klsTopbar.icons.form },
          { action: 'via-klaus', labelKey: 'topbar_via_klaus', iconHtml: w().klsTopbar.icons.sparkle },
        ],
        onAction: (action) => {
          if (action === 'via-klaus') createViaKlaus()
          else setFormTask({ task: null })
        },
      }}
    />
  )

  // ---- List pane derivations ----
  const { tasks, status, lastRunByTask } = tasksData
  const visibleTasks = sortTasksFlat(
    tasks.filter(task => taskMatchesSearch(task, search)).filter(task => {
      if (statusFilter === 'enabled') return !!task.enabled
      if (statusFilter === 'paused') return !task.enabled
      return true
    }),
    status,
  )
  const tasksFiltered = !!search || statusFilter !== 'all'
  const selected = visibleTasks.find(task => task.id === selectedId)
    || tasks.find(task => task.id === selectedId)
    || null

  const renderTaskRow = (task: CronTask) => {
    const title = task.name || task.id
    const running = status.running.includes(task.id)
    const next = task.enabled ? (status.nextRuns[task.id] ?? null) : null
    const last = lastRunByTask.get(task.id)
    const failed = !!last && effectiveCronRunStatus(last) === 'failed'

    // Row anatomy: title + schedule summary, status line
    // (Next run … / In progress / Paused / Last run failed), kebab menu.
    let statusLine: React.ReactNode
    if (running) statusLine = <span className={styles['cron-row-running']}><span className={styles['cron-run-pulse']} />{t('cron_running_now')}</span>
    else if (!task.enabled) statusLine = <span>{t('cron_paused')}</span>
    else if (next != null) statusLine = <span>{`${t('cron_next_run')} ${relFromNow(next)}`}</span>
    else statusLine = <span>{t('cron_paused')}</span>

    return (
      <div
        className={`${styles['cron-row']}${task.enabled ? '' : ' is-paused'}${running ? ' is-running' : ''}${task.id === selectedId ? ' is-selected' : ''}`}
        data-cron-id={task.id}
        key={task.id}
        onClick={(e) => {
          if ((e.target as Element).closest('button')) return
          setSelectedId(task.id)
        }}
      >
        <button type="button" className={styles['cron-row-main']} onClick={() => setSelectedId(task.id)}>
          <div className={styles['cron-row-title']}>{title}</div>
          <div className={styles['cron-row-schedule']}>{humanizeSchedule(task.schedule)}</div>
          <div className={styles['cron-row-meta']}>
            {statusLine}
            {failed && !running && (
              <>
                <span className={styles['cron-row-sep']}>·</span>
                <span className={styles['cron-row-meta-failed']}>{t('cron_last_failed')}</span>
              </>
            )}
          </div>
        </button>
        <button
          className={styles['cron-row-menu']} data-action="menu" aria-label="More"
          disabled={pendingTaskIds.has(task.id)}
          onClick={(e) => {
            e.stopPropagation()
            setKebab({ task, anchorRect: e.currentTarget.getBoundingClientRect() })
          }}
          dangerouslySetInnerHTML={{ __html: rawIconHtml('cron-row-menu') }}
        />
      </div>
    )
  }

  // ---- Detail pane: selected task's fields + Previous runs ----
  const renderDetail = (task: CronTask) => {
    const running = status.running.includes(task.id)
    const next = task.enabled ? (status.nextRuns[task.id] ?? null) : null
    const last = lastRunByTask.get(task.id)
    const runs = runsByTask.get(task.id) ?? []
    const todayMs = startOfDay(new Date()).getTime()
    const yesterdayMs = todayMs - 24 * 60 * 60 * 1000
    // Previous runs are grouped by day under a labeled header.
    const groups = new Map<string, { date: Date; rows: CronRun[] }>()
    for (const r of runs) {
      const d = new Date(r.startedAt)
      const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
      if (!groups.has(key)) groups.set(key, { date: d, rows: [] })
      groups.get(key)!.rows.push(r)
    }
    const meta: string[] = [humanizeSchedule(task.schedule) || t('cron_custom_schedule')]
    if (task.channelBinding) meta.push(channelLabelOf(task.channelBinding.channelId))
    return (
      <div className={styles['cron-detail']} key={task.id}>
        <div className={styles['cron-detail-head']}>
          <div className={styles['cron-detail-title']}>{task.name || task.id}</div>
          <div className={styles['cron-detail-meta']}>
            {meta.map((part, i) => (
              <span style={{ display: 'contents' }} key={i}>
                {i > 0 && <span className={styles['cron-row-sep']}>·</span>}
                {part}
              </span>
            ))}
          </div>
          <div className={styles['cron-row-meta']}>
            {running
              ? <span className={styles['cron-row-running']}><span className={styles['cron-run-pulse']} />{t('cron_running_now')}</span>
              : task.enabled && next != null
                ? <span>{`${t('cron_next_run')} ${relFromNow(next)}`}</span>
                : <span>{t('cron_paused')}</span>}
            {last && !running && (
              <>
                <span className={styles['cron-row-sep']}>·</span>
                <span className={effectiveCronRunStatus(last) === 'failed' ? styles['cron-row-meta-failed'] : ''}>
                  {`${effectiveCronRunStatus(last) === 'failed' ? t('cron_last_failed') : effectiveCronRunStatus(last) === 'stopped' ? t('cron_last_stopped') : t('cron_last_success')} ${relFromNow(last.startedAt)}`}
                </span>
              </>
            )}
          </div>
          <div className={styles['cron-detail-actions']}>
            <button type="button" className="kls-btn" disabled={pendingTaskIds.has(task.id)} onClick={() => { void runTaskNow(task) }}>
              <Raw name="cron-empty-new" />
              <span>{t('cron_run_now')}</span>
            </button>
            <button type="button" className="kls-pill-btn" disabled={pendingTaskIds.has(task.id)} onClick={() => { void toggleTaskEnabled(task) }}>
              {task.enabled ? t('cron_disable') : t('cron_enable')}
            </button>
            <button type="button" className="kls-pill-btn" onClick={() => setFormTask({ task })}>{t('cron_edit')}</button>
            <button type="button" className={`kls-pill-btn ${styles['cron-detail-danger']}`} disabled={pendingTaskIds.has(task.id)} onClick={() => { void deleteTask(task) }}>
              {t('delete_title')}
            </button>
          </div>
          <p className={styles['cron-detail-prompt']}>{task.prompt}</p>
        </div>
        <div className={styles['cron-detail-runs']}>
          <div className={styles['cron-detail-runs-title']}>{t('cron_previous_runs')}</div>
          {runs.length === 0 ? (
            <p className={styles['cron-detail-empty']}>{t('cron_runs_empty')}</p>
          ) : (
            [...groups.entries()].map(([key, g]) => {
              const dayMs = startOfDay(g.date).getTime()
              const label = dayMs === todayMs ? t('cron_today')
                : dayMs === yesterdayMs ? t('cron_yesterday')
                  : `${g.date.getMonth() + 1}${t('cron_month')}${g.date.getDate()}${t('cron_day')}`
              return (
                <div className={styles['cron-runs-group']} key={key}>
                  <div className={styles['cron-runs-group-header']}>
                    <span className={styles['cron-runs-group-dot']} />
                    <span className={styles['cron-runs-group-label']}>{label}</span>
                  </div>
                  <div className={styles['cron-runs-group-list']}>
                    {g.rows.map(renderRunRow)}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    )
  }

  const renderRunRow = (r: CronRun) => {
    const duration = r.durationMs != null ? fmtDurationMs(r.durationMs) : '—'
    const triggerLabel = r.triggerType === 'manual' ? t('cron_trigger_manual') : t('cron_trigger_scheduled')
    const effStatus = effectiveCronRunStatus(r)
    const statusLabel = effStatus === 'failed'
      ? <span className={styles['cron-run-status-failed']}>{t('cron_status_failed')}</span>
      : effStatus === 'stopped'
        ? <span className={styles['cron-run-status-badge']}>{t('cron_status_stopped')}</span>
        : effStatus === 'success'
          ? <span className={styles['cron-run-status-success']}>{t('cron_status_success')}</span>
          : <span className={styles['cron-run-status-badge']}>{t('cron_status_running')}</span>
    const clickable = !!r.sessionId
    const content = (
      <>
        <div className={styles['cron-run-meta']}>
          <span>{relFromNow(r.startedAt)}</span>
          <span>{duration}</span>
          <span>{triggerLabel}</span>
          {statusLabel}
        </div>
        {effStatus === 'failed' && r.error ? <span className={styles['cron-run-error']}>{r.error}</span> : null}
      </>
    )
    return (
      <div
        className={`${styles['cron-run-row']} status-${effStatus}${clickable ? ' is-clickable' : ''}`}
        {...(clickable ? { 'data-session-id': r.sessionId } : {})}
        key={`${r.taskId}:${r.startedAt}:${r.sessionId || ''}`}
      >
        {clickable ? (
          <button type="button" className={styles['cron-run-open']} onClick={() => { void openRunSession(r.sessionId!) }}>
            {content}
            <span className={styles['cron-run-open-chat']}>{t('cron_open_chat')}</span>
          </button>
        ) : <div className={styles['cron-run-open']}>{content}</div>}
        {effStatus === 'failed' && (
          <button
            className={styles['cron-run-retry']} data-task-id={r.taskId}
            disabled={pendingTaskIds.has(r.taskId)}
            onClick={() => {
              const task = stateRef.current.tasksData.tasks.find(x => x.id === r.taskId)
              if (task) void runTaskNow(task)
              else w().showToast?.(t('cron_run_failed'))
            }}
          >{t('cron_retry')}</button>
        )}
      </div>
    )
  }

  return (
    <div
      className="cron-inner"
      onClick={(e) => {
        const target = e.target as Element
        if (target.closest('[data-cron-tab]')) return
      }}
    >
      {header}

      <div className={`${styles['cron-split']}${selected ? ' has-detail' : ''}`}>
        {/* Task list pane. */}
        <div id="cron-pane-tasks" className={`${styles['cron-pane']} ${styles['cron-pane-list']}${selected ? '' : ' active'}`}>
          {!tasksLoaded && !tasksError ? <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} /> : null}
          {tasksError ? (
            <div className="cron-empty" role="alert">
              <p>{tasksError}</p>
              <button type="button" className="btn-sm" onClick={() => { void loadTasks() }}>{t('cron_retry')}</button>
            </div>
          ) : null}
          <div id="cron-list" className={styles['cron-list']}>
            {visibleTasks.map(renderTaskRow)}
          </div>
          <div id="cron-empty" className="cron-empty" style={{ display: tasksLoaded && !tasksError && visibleTasks.length === 0 ? 'flex' : 'none' }}>
            <Raw name="cron-empty-tasks" />
            <p data-i18n="no_cron">{tasksFiltered ? t('cron_search_empty') : t('no_cron')}</p>
            <p className={styles['cron-empty-hint']} style={tasksFiltered ? { display: 'none' } : undefined}>{t('cron_empty_hint')}</p>
            <div className={styles['cron-empty-actions']} style={tasksFiltered ? { display: 'none' } : undefined}>
              <button className="kls-btn" id="cron-empty-new" onClick={() => setFormTask({ task: null })}>
                <Raw name="cron-empty-new" />
                <span>{t('cron_new')}</span>
              </button>
              <button className="kls-pill-btn" id="cron-empty-via-klaus" onClick={createViaKlaus}>
                <Raw name="cron-empty-via-klaus" />
                <span>{t('cron_via_klaus')}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Detail pane: edit fields + Previous runs. */}
        <div className={`${styles['cron-pane']} ${styles['cron-pane-detail']}${selected ? ' active' : ''}`}>
          {selected
            ? renderDetail(selected)
            : <div className={styles['cron-detail-placeholder']}>{t('cron_select_placeholder')}</div>}
        </div>
      </div>

      {kebab && (
        <ModalPortal>
          <CardMenu
            state={kebab}
            onClose={() => setKebab(null)}
            onAct={(act) => {
              const task = kebab.task
              if (act === 'run') void runTaskNow(task)
              else if (act === 'toggle') void toggleTaskEnabled(task)
              else if (act === 'edit') setFormTask({ task })
              else void deleteTask(task)
            }}
          />
        </ModalPortal>
      )}

      {formTask && (
        <ModalPortal>
          <CronTaskFormModal
            existing={formTask.task}
            onClose={() => setFormTask(null)}
            onSaved={(intent) => {
              const runAfter = intent === 'run'
              setFormTask(null)
              void (async () => {
                await loadTasks()
                if (runAfter) {
                  const saved = (await api().list().catch(() => [] as CronTask[])) as CronTask[]
                  const target = (saved as CronTask[]).find(x => x.id === (formTask.task ?? saved[0])?.id)
                    ?? (formTask.task ? null : (saved[0] ?? null))
                  if (target?.id) void runTaskNow(target)
                }
              })()
            }}
          />
        </ModalPortal>
      )}
    </div>
  )
}

function cronDeleteSucceeded(result: unknown): boolean {
  if (result === true) return true
  if (!result || typeof result !== 'object') return false
  const payload = result as Record<string, unknown>
  return payload.ok === true || payload.deleted === true
}

function fmtDurationMs(v: number): string { return v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms' }
