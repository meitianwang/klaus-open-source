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
  CRON_PAGE_RELOAD_EVENT, CRON_PAGE_VISIBLE_EVENT, channelLabelOf, cronExecutionTarget, cronPermissionPreset,
  effectiveCronRunStatus, humanizeSchedule, relFromNow,
  sortTasksFlat, taskMatchesSearch,
} from './data'
import type { CronRun, CronStatus, CronTask } from './data'
import { CronTaskFormModal } from './form'
import {
  CRON_SIDEBAR_ACTION_EVENT,
  CRON_SIDEBAR_SELECT_EMPTY_EVENT,
  CRON_SIDEBAR_SYNC_EVENT,
} from '../../chat/sidebar/secondary-module-panes'
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
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'paused'>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [emptyTaskId, setEmptyTaskId] = useState<string | null>(null)
  const [formTask, setFormTask] = useState<{ task: CronTask | null; runAfter?: boolean } | null>(null)
  const [kebab, setKebab] = useState<KebabState | null>(null)
  const [tasksLoaded, setTasksLoaded] = useState(false)
  const [tasksError, setTasksError] = useState('')
  const [executionNames, setExecutionNames] = useState<{ projects: Record<string, string>; workspaces: Record<string, string> }>({
    projects: {}, workspaces: {},
  })
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set())
  const pendingTaskIdsRef = useRef(new Set<string>())
  const visibleRef = useRef(true)
  const stateRef = useRef({ statusFilter, selectedId, tasksData })
  stateRef.current = { statusFilter, selectedId, tasksData }

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
      for (const r of recentRuns as CronRun[]) {
        const prev = lastRunByTask.get(r.taskId)
        if (!prev || r.startedAt > prev.startedAt) lastRunByTask.set(r.taskId, r)
      }
      setTasksData({ tasks, status: status || { nextRuns: {}, running: [] }, lastRunByTask })
      try { w().refreshCronSidebar?.() } catch {}
    } catch (error: any) {
      setTasksError(error?.message || t('cron_load_failed'))
    } finally {
      setTasksLoaded(true)
    }
  }, [t])

  useEffect(() => { void loadTasks() }, [loadTasks])

  // Detail rows name the saved location. The saved id/path remains displayed
  // when a project or workspace was removed, so a history row never implies
  // that the task silently became an ordinary session.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const projects: Record<string, string> = {}, workspaces: Record<string, string> = {}
      const [projectState, workspaceState] = await Promise.allSettled([
        w().klaus.projects?.list?.(),
        w().klaus.workspaces?.list?.(),
      ])
      if (projectState.status === 'fulfilled') {
        const roots = Array.isArray(projectState.value?.roots) ? projectState.value.roots : []
        const labels = projectState.value?.labels && typeof projectState.value.labels === 'object' ? projectState.value.labels : {}
        for (const raw of roots) {
          const root = typeof raw === 'string' ? raw : raw?.path
          if (typeof root !== 'string' || !root || root.startsWith('ssh://')) continue
          projects[root] = labels[root] || root.split('/').filter(Boolean).pop() || root
        }
      }
      if (workspaceState.status === 'fulfilled') {
        const rows = Array.isArray(workspaceState.value?.workspaces) ? workspaceState.value.workspaces : []
        for (const row of rows) {
          if (row && typeof row.id === 'string' && row.id) workspaces[row.id] = typeof row.name === 'string' && row.name ? row.name : row.id
        }
      }
      if (!cancelled) setExecutionNames({ projects, workspaces })
    })()
    return () => { cancelled = true }
  }, [])

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

  useEffect(() => { bindTasksFilter() }, [tasksData, statusFilter, bindTasksFilter])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(CRON_SIDEBAR_SYNC_EVENT, {
      detail: {
        tasks: tasksData.tasks,
        status: tasksData.status,
        statusFilter,
        selectedId,
        emptyTaskId,
      },
    }))
  }, [tasksData, statusFilter, selectedId, emptyTaskId])

  useEffect(() => {
    const onSidebarAction = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string; taskId?: string; filter?: 'all' | 'enabled' | 'paused' }>).detail
      if (!detail) return
      if (detail.type === 'select' && typeof detail.taskId === 'string') {
        setEmptyTaskId(null)
        setSelectedId(detail.taskId)
      } else if (detail.type === 'filter' && detail.filter) {
        setStatusFilter(detail.filter)
      } else if (detail.type === 'create-manual') {
        setFormTask({ task: null })
      }
    }
    const onSelectEmpty = (event: Event) => {
      const taskId = (event as CustomEvent<{ taskId?: string | null }>).detail?.taskId
      setEmptyTaskId(typeof taskId === 'string' && taskId ? taskId : null)
    }
    window.addEventListener(CRON_SIDEBAR_ACTION_EVENT, onSidebarAction)
    window.addEventListener(CRON_SIDEBAR_SELECT_EMPTY_EVENT, onSelectEmpty)
    return () => {
      window.removeEventListener(CRON_SIDEBAR_ACTION_EVENT, onSidebarAction)
      window.removeEventListener(CRON_SIDEBAR_SELECT_EMPTY_EVENT, onSelectEmpty)
    }
  }, [])

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
  const emptyTask = emptyTaskId ? (tasks.find(task => task.id === emptyTaskId) ?? null) : null

  // Split mode: while a detail panel is open the view stops scrolling as one
  // page; the header stays pinned and each pane scrolls inside its column.
  useEffect(() => {
    const view = document.getElementById('cron-view')
    if (!view) return
    view.classList.toggle('cron-view-split', !!selected && !emptyTask)
    return () => { view.classList.remove('cron-view-split') }
  }, [selected, emptyTask])

  const executionLabel = (task: CronTask): string => {
    const target = cronExecutionTarget(task)
    if (target.kind === 'workspace') {
      const name = executionNames.workspaces[target.id]
      return name ? t('cron_form_workspace_label').replace('{name}', name)
        : t('cron_form_workspace_unavailable').replace('{name}', target.id)
    }
    if (target.kind === 'project') {
      const name = executionNames.projects[target.root] || target.root.split('/').filter(Boolean).pop() || target.root
      return t('cron_form_project_label').replace('{name}', name)
    }
    return t('cron_form_project_none')
  }

  const permissionLabel = (task: CronTask): string => {
    const preset = cronPermissionPreset(task.permissionPreset)
    return t(preset === 'default' ? 'perm_manual' : preset === 'auto' ? 'perm_auto' : 'perm_bypass')
  }

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
    const meta: string[] = [humanizeSchedule(task.schedule) || t('cron_custom_schedule')]
    meta.push(executionLabel(task), permissionLabel(task))
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
      {emptyTask ? (
        <div className={styles['cron-empty-session-state']}>
          <div className={styles['cron-empty-session-icon']} aria-hidden="true">
            <Raw name="cron-empty-tasks" />
          </div>
          <h3 className={styles['cron-empty-session-title']}>
            {t('cron_empty_sessions_title').replace('{name}', emptyTask.name || emptyTask.id)}
          </h3>
          {emptyTask.schedule ? (
            <p className={styles['cron-empty-session-schedule']}>
              {humanizeSchedule(emptyTask.schedule)}
            </p>
          ) : null}
          <p className={styles['cron-empty-session-desc']}>
            {t('cron_empty_sessions_desc').replace('{name}', emptyTask.name || emptyTask.id)}
          </p>
          <div className={styles['cron-empty-actions']}>
            <button
              type="button"
              className="kls-btn"
              disabled={pendingTaskIds.has(emptyTask.id)}
              onClick={() => {
                setEmptyTaskId(null)
                void runTaskNow(emptyTask)
              }}
            >
              <Raw name="cron-empty-new" />
              <span>{t('cron_run_now')}</span>
            </button>
            <button
              type="button"
              className="kls-pill-btn"
              onClick={() => setFormTask({ task: emptyTask })}
            >
              {t('cron_edit')}
            </button>
            <button
              type="button"
              className="kls-pill-btn"
              onClick={() => {
                setEmptyTaskId(null)
                setSelectedId(emptyTask.id)
              }}
            >
              {t('cron_back_all_setup')}
            </button>
          </div>
        </div>
      ) : (
        <>
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
        </>
      )}

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
