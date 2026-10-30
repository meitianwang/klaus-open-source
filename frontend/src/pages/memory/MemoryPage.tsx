// Memory 页（React 岛）——迁自 js/memory-view.js（autoDream UI）。
// 「当前梦」运行卡（1s elapsed 心跳 + 叫醒按钮）+ 往昔的梦时间线
// （无限滚动 + 时间筛选 + 三档鲜明度 + synapse 覆盖层）+ 文件/技能预览路由。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { PageHeader } from '../../components/PageHeader'
import { rawIconHtml } from '../../components/Icon'
import { icon } from '../../icons/registry'
import {
  MEMORY_DREAM_EVENT, ageOf, fetchFileDescription, formatDuration, formatElapsed, formatRelativeTime,
  formatTimestamp, friendlyMemoryName, getCurrentDream, triggerErrorMessage, updateSidebarDot, vividnessOf,
} from './data'
import type { DreamRun, DreamSkillDistilled, DreamSkillReview, MemoryFileInfo, Vividness } from './data'
import { highlightSynapsesForRow, renderSynapses, stopSynapsePulses } from './synapse'
import styles from './memory.module.css'

const w = () => window as any

export const MEMORY_PAGE_VISIBLE_EVENT = 'klaus:memory-page-visible'

// Neuron-shaped marker SVGs. Three vividness tiers as three "states of a
// neuron"; `.neuron-core` class is preserved in the glyphs so the synapse
// overlay can locate marker centers reliably.
function neuronSvg(vividness: Vividness): string {
  if (vividness === 'vivid') return icon('neuron-soma')
  if (vividness === 'faint') return icon('neuron-core')
  return icon('neuron-dendrite')
}

function Marker({ vividness }: { vividness: Vividness }) {
  return <span className={styles['memory-history-marker']} aria-hidden="true" dangerouslySetInnerHTML={{ __html: neuronSvg(vividness) }} />
}

/** 触及文件 chips（当前梦卡）：类型友好名做 chip 文案，原始路径进 hover/点击。 */
function FilesTouched({ files }: { files: string[] | undefined }) {
  if (!files || files.length === 0) return null
  return (
    <div className={styles['memory-files-touched']}>
      {files.map(f => (
        <span className={styles['memory-file-chip']} data-rel-path={f} title={f} role="button" tabIndex={0} key={f}>{friendlyMemoryName(f)}</span>
      ))}
    </div>
  )
}

// Klaus extension — skill-evolution sub-fork status line in the live dream
// card. Hides itself for skipped/failed/zero-distilled silent outcomes.
function CurrentSkillReview({ sr }: { sr: DreamSkillReview | undefined }) {
  const t = useT()
  if (!sr) return null
  if (sr.status === 'running' || sr.status === 'pending') {
    return <div className={`${styles['memory-current-summary']} ${styles['memory-current-skill-review']}`}>{t('distilling_skills')}</div>
  }
  if (sr.status === 'completed' && sr.summary) {
    return <div className={`${styles['memory-current-summary']} ${styles['memory-current-skill-review']}`}>{sr.summary}</div>
  }
  return null
}

interface HistoryPageState {
  rows: DreamRun[]
  hasMore: boolean
  cursor: number | null
  loadedOnce: boolean
}

export function MemoryPage() {
  const t = useT()
  const [currentDream, setCurrentDreamState] = useState<DreamRun | null>(() => getCurrentDream())
  const [history, setHistory] = useState<HistoryPageState>({ rows: [], hasMore: true, cursor: null, loadedOnce: false })
  const [isLoadingPage, setIsLoadingPage] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [timeRange, setTimeRange] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // taskId → path → frontmatter description（懒取：展开才付 IPC 往返）。
  const [detailInfo, setDetailInfo] = useState<Map<string, Map<string, MemoryFileInfo>>>(new Map())
  const [, setTick] = useState(0)
  const visibleRef = useRef(true)
  const historyGenerationRef = useRef(0)
  const requestSequenceRef = useRef(0)
  const appendRequestRef = useRef<number | null>(null)
  const loadingRequestsRef = useRef(new Set<number>())
  const stateRef = useRef({ history, timeRange, currentDream })
  stateRef.current = { history, timeRange, currentDream }
  const historyElRef = useRef<HTMLDivElement>(null)
  const synapseHostRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const runsByIdRef = useRef(new Map<string, DreamRun>())

  // ---- Time filter → query bounds ----
  const resolveTimeBounds = (value: string): { from?: number; to?: number } => {
    const now = Date.now()
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    if (value === 'today') return { from: startOfToday.getTime(), to: now }
    if (value === 'week') return { from: now - 7 * 24 * 3600 * 1000, to: now }
    if (value === 'month') return { from: now - 30 * 24 * 3600 * 1000, to: now }
    return {}
  }

  const scheduleSynapses = useCallback(() => {
    requestAnimationFrame(() => {
      const host = synapseHostRef.current
      const container = historyElRef.current
      if (!host || !container) return
      renderSynapses({ host, container, runsById: runsByIdRef.current, isVisible: () => visibleRef.current })
    })
  }, [])

  const loadNextHistoryPage = useCallback(async (over?: { reset?: boolean; range?: string }) => {
    const cur = stateRef.current.history
    const reset = !!over?.reset
    if (!reset && !cur.hasMore) return
    if (!reset && appendRequestRef.current != null) return
    const generation = reset ? ++historyGenerationRef.current : historyGenerationRef.current
    const requestId = ++requestSequenceRef.current
    if (!reset) appendRequestRef.current = requestId
    loadingRequestsRef.current.add(requestId)
    setHistoryError('')
    setIsLoadingPage(true)
    try {
      const bounds = resolveTimeBounds(over?.range ?? stateRef.current.timeRange)
      const filters: any = { limit: 20, ...bounds }
      const cursor = reset ? null : cur.cursor
      if (cursor != null) filters.before = cursor
      const res = await w().klaus.dream.list(filters)
      if (generation !== historyGenerationRef.current) return
      const runs: DreamRun[] = res.runs || []
      if (reset) runsByIdRef.current.clear()
      for (const run of runs) runsByIdRef.current.set(run.taskId, run)
      const last = runs[runs.length - 1]
      setHistory(prev => ({
        rows: reset ? runs : [...prev.rows, ...runs],
        hasMore: !!res.hasMore,
        cursor: last ? last.startedAt : (reset ? null : prev.cursor),
        loadedOnce: true,
      }))
      if (reset) {
        setExpanded(new Set())
        setDetailInfo(new Map())
      }
      // Re-render synapse overlay after each page load — rAF waits one frame
      // so getBoundingClientRect reflects final row heights.
      scheduleSynapses()
    } catch (err: any) {
      if (generation === historyGenerationRef.current) {
        setHistoryError(err?.message || t('memory_history_load_failed'))
      }
    } finally {
      if (appendRequestRef.current === requestId) appendRequestRef.current = null
      loadingRequestsRef.current.delete(requestId)
      setIsLoadingPage(loadingRequestsRef.current.size > 0)
    }
  }, [scheduleSynapses, t])

  const hydrate = useCallback(async () => {
    // Pull the live snapshot in case the renderer just reopened — engine has
    // been pushing dream:event all along but we may have missed those.
    try {
      const snap = await w().klaus.dream.current()
      if (snap) {
        setCurrentDreamState(snap)
        updateSidebarDot(snap.status === 'running')
      }
    } catch (err) {
      w().showToast?.(err instanceof Error ? err.message : t('memory_history_load_failed'))
    }
    stopSynapsePulses()
    await loadNextHistoryPage({ reset: true })
  }, [loadNextHistoryPage])

  useEffect(() => { void hydrate() }, [])

  // 岛入口的 onShow/onHide 经事件驱动：show → 重水化；hide → 停脉冲。
  useEffect(() => {
    const onVisible = (event: Event) => {
      const vis = !!(event as CustomEvent).detail?.visible
      visibleRef.current = vis
      if (vis) void hydrate()
      else stopSynapsePulses()
    }
    window.addEventListener(MEMORY_PAGE_VISIBLE_EVENT, onVisible)
    return () => window.removeEventListener(MEMORY_PAGE_VISIBLE_EVENT, onVisible)
  }, [hydrate])

  // dream:event（模块级订阅转发）：更新当前梦卡；终态转换时刷新首页历史。
  useEffect(() => {
    const onDream = (event: Event) => {
      const snap = (event as CustomEvent).detail as DreamRun | null
      if (!snap) return
      const wasRunning = stateRef.current.currentDream?.status === 'running'
      setCurrentDreamState(snap)
      if (visibleRef.current && wasRunning && snap.status !== 'running') {
        // Just terminated — refresh history so the new row materializes.
        void loadNextHistoryPage({ reset: true })
      }
    }
    window.addEventListener(MEMORY_DREAM_EVENT, onDream)
    return () => window.removeEventListener(MEMORY_DREAM_EVENT, onDream)
  }, [loadNextHistoryPage])

  // Live elapsed ticker — while a dream is running, refresh the subtitle's
  // elapsed time once a second so the user sees forward motion.
  useEffect(() => {
    const timer = setInterval(() => {
      if (visibleRef.current && stateRef.current.currentDream?.status === 'running') setTick(n => n + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // IntersectionObserver triggers the next page when the sentinel scrolls
  // into view. Root is the page overlay (#memory-view) — the scroll container.
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = document.getElementById('memory-view')
    if (!sentinel || !root) return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && visibleRef.current) void loadNextHistoryPage()
      }
    }, { root, rootMargin: '160px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadNextHistoryPage])

  // 侧栏折叠/字号/窗宽变化都挪动标记 x 位——ResizeObserver 合并到 rAF 重画。
  useEffect(() => {
    const el = historyElRef.current
    if (!el || typeof ResizeObserver !== 'function') return
    let pending = false
    const ro = new ResizeObserver(() => {
      if (!visibleRef.current || pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        if (visibleRef.current && stateRef.current.history.rows.length > 0) scheduleSynapses()
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scheduleSynapses])

  // 语言切换（useT 重渲染）改变行高 → 重画突触层。
  useEffect(() => { scheduleSynapses() }, [t, scheduleSynapses])

  // ---- 页头动作行（refresh · Open in Finder · Run now，工厂 topbarHtml） ----
  const topbarHtml = `
      <button class="kls-icon-btn" id="memory-refresh" data-i18n-title="memory_refresh" title="${t('memory_refresh')}">
        ${icon('refresh')}
      </button>
      <button class="kls-pill-btn" id="memory-reveal">
        ${icon('kls-pill-btn')}
        <span data-i18n="memory_reveal">${t('memory_reveal')}</span>
      </button>
      <!-- Run-now button: bypasses the 24h+5sessions gates so the user can
           trigger a consolidation on demand. Disabled while a dream is already
           running (dream:event status running). -->
      <button class="kls-btn kls-btn-primary" id="memory-trigger-now">
        ${icon('kls-btn')}
        <span data-i18n="memory_trigger_now">${t('memory_trigger_now')}</span>
      </button>`

  // 自定义动作行的事件按 id 挂（dataset 守卫防重复；lang 切换重建节点后重挂）。
  useEffect(() => {
    const refreshBtn = document.getElementById('memory-refresh')
    const revealBtn = document.getElementById('memory-reveal')
    const triggerBtn = document.getElementById('memory-trigger-now') as HTMLButtonElement | null
    const disposers: Array<() => void> = []
    if (refreshBtn && refreshBtn.dataset.bound !== '1') {
      refreshBtn.dataset.bound = '1'
      const fn = () => { void hydrate() }
      refreshBtn.addEventListener('click', fn)
      disposers.push(() => refreshBtn.removeEventListener('click', fn))
    }
    if (revealBtn && revealBtn.dataset.bound !== '1') {
      revealBtn.dataset.bound = '1'
      const fn = () => {
        void w().klaus.memory.reveal().catch((error: unknown) => {
          w().showToast?.(error instanceof Error ? error.message : t('settings_failed'))
        })
      }
      revealBtn.addEventListener('click', fn)
      disposers.push(() => revealBtn.removeEventListener('click', fn))
    }
    if (triggerBtn && triggerBtn.dataset.bound !== '1') {
      triggerBtn.dataset.bound = '1'
      // "Run now" — force-trigger a dream (lock still acquired so this can't
      // overlap a natural dream). Brief crescent spin suggests "going to sleep".
      const fn = async () => {
        if (stateRef.current.currentDream?.status === 'running') return
        triggerBtn.disabled = true
        triggerBtn.classList.add(styles['memory-trigger-spinning'])
        setTimeout(() => triggerBtn.classList.remove(styles['memory-trigger-spinning']), 1500)
        try {
          const r = await w().klaus.dream.triggerNow()
          if (!r?.ok) {
            await w().klausDialog?.alert(triggerErrorMessage(r?.error))
          }
        } catch (err) {
          // Surface every IPC failure mode through klausDialog so the error
          // path is never invisible.
          console.warn('[memory-view] dream.triggerNow failed:', err)
          await w().klausDialog?.alert(triggerErrorMessage(err instanceof Error ? err.message : String(err)))
        } finally {
          // Re-enable in 1.5s as a safety net in case dream:event never lands.
          setTimeout(() => { triggerBtn.disabled = false }, 1500)
        }
      }
      triggerBtn.addEventListener('click', fn)
      disposers.push(() => triggerBtn.removeEventListener('click', fn))
    }
    return () => { for (const d of disposers) d() }
  }, [topbarHtml, hydrate])

  // Mirror running state onto the "Run now" button so users can't queue a
  // parallel trigger from the topbar.
  useEffect(() => {
    const btn = document.getElementById('memory-trigger-now') as HTMLButtonElement | null
    if (btn) btn.disabled = currentDream?.status === 'running'
  }, [currentDream, topbarHtml])

  // 时间筛选下拉（kls-select，与 cron 同一套基建）。
  const timeFilterBodyHtml = `
            <div class="${styles['memory-toolbar']}">
              <h3 class="${styles['memory-section-title']}" data-i18n="memory_history">${t('memory_history')}</h3>
              <div id="memory-time-filter" class="kls-select"></div>
            </div>`
  useEffect(() => {
    const host = document.getElementById('memory-time-filter')
    if (!host) return
    w().klsSelect.bind(host, {
      items: [
        { value: 'all',   i18nKey: 'memory_filter_all' },
        { value: 'today', i18nKey: 'memory_filter_today' },
        { value: 'week',  i18nKey: 'memory_filter_week' },
        { value: 'month', i18nKey: 'memory_filter_month' },
      ],
      value: stateRef.current.timeRange,
      onChange: (v: string) => {
        setTimeRange(v)
        void loadNextHistoryPage({ reset: true, range: v })
      },
    })
  }, [timeFilterBodyHtml, loadNextHistoryPage])

  // ---- 文件/技能点击 → 独立预览窗（委托路由） ----
  const openReference = (target: Element) => {
    const skillTarget = target.closest('[data-skill-name]')
    if (skillTarget) {
      const name = skillTarget.getAttribute('data-skill-name')
      if (name && w().klaus?.skills?.openWindow) {
        w().klaus.skills.openWindow(name).catch((err: unknown) => {
          w().showToast?.(err instanceof Error ? err.message : t('settings_failed'))
        })
      }
      return
    }
    const memTarget = target.closest('[data-rel-path]')
    if (memTarget) {
      const path = memTarget.getAttribute('data-rel-path')
      if (path) {
        w().klaus.memory.openWindow(path).catch((err: unknown) => {
          w().showToast?.(err instanceof Error ? err.message : t('settings_failed'))
        })
      }
    }
  }

  const onSectionClick = (e: React.MouseEvent) => {
    openReference(e.target as Element)
  }

  const onSectionKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const target = e.target as Element
    const reference = target.closest('[data-skill-name], [data-rel-path]')
    if (!reference) return
    e.preventDefault()
    e.stopPropagation()
    openReference(reference)
  }

  // ---- 行展开：懒取 frontmatter description ----
  const toggleRow = (run: DreamRun) => {
    const isOpen = expanded.has(run.taskId)
    setExpanded(prev => {
      const next = new Set(prev)
      if (isOpen) next.delete(run.taskId)
      else next.add(run.taskId)
      return next
    })
    // Row height changed — synapse positions need recomputing.
    scheduleSynapses()
    if (isOpen) return
    if (detailInfo.has(run.taskId)) return
    void (async () => {
      const byPath = new Map<string, MemoryFileInfo>()
      await Promise.all((run.filesTouched ?? []).map(async (path) => {
        byPath.set(path, await fetchFileDescription(path))
      }))
      setDetailInfo(prev => {
        const next = new Map(prev)
        next.set(run.taskId, byPath)
        return next
      })
      // Async content can change row height — re-place synapses.
      scheduleSynapses()
    })()
  }

  // ---- 当前梦卡 ----
  const renderCurrentCard = () => {
    // The card only earns its place while a dream is in flight — terminal
    // states become the top row of the timeline below within seconds.
    const d = currentDream
    const isRunning = d?.status === 'running'
    if (!d || !isRunning) return null
    const statusClass =
      d.status === 'completed' ? styles['memory-status-completed'] :
      d.status === 'failed' || d.status === 'killed' ? styles['memory-status-' + d.status] :
      styles['memory-status-running']
    const elapsed = formatElapsed(d.startedAt, d.endedAt)
    const sessionsLabel = d.sessionsReviewing === 1 ? t('memory_dream_subtitle_session') : t('memory_dream_subtitle_sessions')
    const fileCount = d.filesTouched?.length ?? 0
    const filesLabel = fileCount === 1 ? t('memory_dream_subtitle_file') : t('memory_dream_subtitle_files')
    // Subtitle: "0:45 · 梦见 3 个会话 · 触及 5 份记忆"（动词 + 数 + 单位）。
    const subtitleParts = [elapsed]
    if ((d.sessionsReviewing ?? 0) > 0) subtitleParts.push(`${t('memory_dream_reviewing')} ${d.sessionsReviewing} ${sessionsLabel}`)
    if (fileCount > 0) subtitleParts.push(`${t('memory_dream_touched')} ${fileCount} ${filesLabel}`)

    const stop = async () => {
      if (!d.taskId) return
      const ok = await w().klausDialog?.confirm({
        message: t('memory_dream_stop_confirm'),
        danger: true,
      })
      if (!ok) return
      try {
        const r = await w().klaus.dream.stop(d.taskId)
        if (!r?.ok) await w().klausDialog?.alert(t('memory_dream_stop_failed'))
      } catch (err) {
        await w().klausDialog?.alert(err instanceof Error ? err.message : t('memory_dream_stop_failed'))
      }
    }

    // Running dream renders as a slim timeline-row that merges into the
    // dream-record below: pulsing vivid marker + inline stop + status pill.
    return (
      <div id="memory-current" className={styles['memory-current']} style={{ display: 'block' }}>
        <Marker vividness="vivid" />
        <div className={styles['memory-current-head']}>
          <div className={styles['memory-current-title']}>{t('memory_dream_title')}</div>
          <div className={styles['memory-current-actions']}>
            <span className={`${styles['memory-status-pill']} ${statusClass}`}>
              <span className={styles['memory-status-led']} />
              <span>{t('memory_dream_status_' + d.status)}</span>
            </span>
            {isRunning && d.stoppable !== false && (
              <button className={styles['memory-current-stop']} onClick={() => { void stop() }}>{t('memory_dream_stop')}</button>
            )}
          </div>
        </div>
        <div className={styles['memory-current-subtitle']}>{subtitleParts.join(' · ')}</div>
        {d.summary ? <div className={styles['memory-current-summary']}>{d.summary}</div> : null}
        <CurrentSkillReview sr={d.skillReview} />
        <FilesTouched files={d.filesTouched} />
      </div>
    )
  }

  // ---- 历史行 ----
  const renderDetailFileRow = (run: DreamRun, path: string) => {
    const info = detailInfo.get(run.taskId)?.get(path)
    const label = friendlyMemoryName(path)
    const text = info?.error
      ? t('memory_detail_unreadable')
      : (info?.description ?? t('memory_detail_no_description'))
    const descCls = info?.error || !info?.description
      ? `${styles['memory-detail-desc']} ${styles['memory-detail-desc-muted']}`
      : styles['memory-detail-desc']
    return (
      <div className={styles['memory-detail-file']} key={path}>
        <span className={styles['memory-detail-label']} data-rel-path={path} title={path} role="button" tabIndex={0}>{label}</span>
        <span className={styles['memory-detail-sep']}>·</span>
        <span className={descCls}>{text}</span>
      </div>
    )
  }

  // 蒸馏技能行（同 renderDetailFile 的「标签 · 描述」节奏）；被回滚的技能
  // 不可点击（SKILL.md 已删，点开必 404），回滚原因灰显在描述列。
  const renderDetailSkillRow = (d: DreamSkillDistilled, i: number) => {
    const actionLabel = t(d.action === 'create' ? 'skill_action_create' : 'skill_action_update')
    const rejected = !!d.rejectReason
    const text = rejected ? `${actionLabel} · ${t('skill_chip_rejected')}: ${d.rejectReason}` : actionLabel
    const descCls = rejected ? `${styles['memory-detail-desc']} ${styles['memory-detail-desc-muted']}` : styles['memory-detail-desc']
    return (
      <div className={styles['memory-detail-file']} key={`skill:${d.name}:${i}`}>
        {rejected
          ? <span className={styles['memory-detail-label']} title={d.name}>{d.name}</span>
          : <span className={styles['memory-detail-label']} data-skill-name={d.name} title={d.name} role="button" tabIndex={0}>{d.name}</span>}
        <span className={styles['memory-detail-sep']}>·</span>
        <span className={descCls}>{text}</span>
      </div>
    )
  }

  const firstVividId = history.rows.find(run => vividnessOf(run) === 'vivid')?.taskId

  const renderHistoryRow = (run: DreamRun) => {
    const vividness = vividnessOf(run)
    const age = ageOf(run.startedAt)
    const expandable = vividness === 'vivid'
    const isExpanded = expanded.has(run.taskId)
    const fileCount = run.filesTouched?.length ?? 0
    const preciseTitle = formatTimestamp(run.startedAt)
    const poeticTime = formatRelativeTime(run.startedAt)
    const sr = run.skillReview
    const skillSummaryOk = sr?.status === 'completed' && sr.summary

    const classNames = [
      styles['memory-history-row'],
      `status-${run.status}`,
      `vividness-${vividness}`,
      `age-${age}`,
      run.taskId === firstVividId ? styles['is-latest'] : '',
      expandable ? styles['is-expandable'] : '',
      isExpanded ? 'expanded' : '',
    ].filter(Boolean).join(' ')

    if (vividness !== 'vivid') {
      // Faint / broken: condensed single-line — crescent + poetic time + soft note.
      const note = run.summary
        || (vividness === 'faint' ? t('memory_history_note_faint') : t('memory_history_note_broken'))
      return (
        <div
          className={classNames} data-task-id={run.taskId} key={run.taskId}
          onMouseEnter={() => highlightSynapsesForRow(run.taskId, true)}
          onMouseLeave={() => highlightSynapsesForRow(run.taskId, false)}
        >
          <Marker vividness={vividness} />
          <div className={styles['memory-history-condensed']}>
            <span className={styles['memory-history-time']} title={preciseTitle}>{poeticTime}</span>
            <span className={styles['memory-history-condensed-sep']} aria-hidden="true">·</span>
            <span className={styles['memory-history-condensed-note']}>{note}</span>
            {skillSummaryOk ? (
              <>
                <span className={styles['memory-history-condensed-sep']} aria-hidden="true">·</span>
                <span className={`${styles['memory-history-condensed-note']} ${styles['memory-history-condensed-skill']}`}>{sr!.summary}</span>
              </>
            ) : null}
          </div>
        </div>
      )
    }

    const dur = run.durationMs != null ? formatDuration(run.durationMs) : ''
    const sessionsLabel = run.sessionsReviewing === 1 ? t('memory_dream_subtitle_session') : t('memory_dream_subtitle_sessions')
    const filesLabel = fileCount === 1 ? t('memory_dream_subtitle_file') : t('memory_dream_subtitle_files')
    const distilledCount = (sr?.distilled ?? []).filter(d => !d.rejectReason).length

    return (
      <div
        className={classNames} data-task-id={run.taskId} key={run.taskId}
        onMouseEnter={() => highlightSynapsesForRow(run.taskId, true)}
        onMouseLeave={() => highlightSynapsesForRow(run.taskId, false)}
        onClick={(e) => {
          // Don't toggle on detail-panel content — file chips have their own
          // preview behavior, and clicking description text collapsing the
          // panel that just appeared feels wrong.
          const target = e.target as Element
          if (target.closest('[data-rel-path], [data-skill-name]')) return
          if (target.closest('[data-memory-history-detail]')) return
          toggleRow(run)
        }}
      >
        <Marker vividness="vivid" />
        <div className={styles['memory-history-title']} title={preciseTitle}>
          <button
            type="button"
            className={styles['memory-history-toggle']}
            data-memory-row-toggle
            aria-expanded={isExpanded}
            onClick={(e) => {
              e.stopPropagation()
              toggleRow(run)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              toggleRow(run)
            }}
          >
            <span className={styles['memory-history-time']}>{poeticTime}</span>
            <span className={styles['memory-history-chevron']} aria-hidden="true">›</span>
          </button>
        </div>
        <div className={styles['memory-history-meta']}>
          {dur ? <span>{dur}</span> : null}
          <span>{fileCount} {filesLabel}</span>
          {(run.sessionsReviewing ?? 0) > 0 ? <span>{run.sessionsReviewing} {sessionsLabel}</span> : null}
          {distilledCount > 0 ? <span className={styles['memory-history-skill-chip']}>{distilledCount} {t('skills_distilled_chip')}</span> : null}
          <span className={styles[`memory-history-status-${run.status}`]}>{t('memory_dream_status_' + run.status)}</span>
        </div>
        <div className={styles['memory-history-summary']}>
          {run.summary
            ? <span className={styles['memory-history-summary-text']}>{run.summary}</span>
            : <span className={`${styles['memory-history-summary-text']} ${styles['memory-history-summary-fallback']}`}>{t('memory_summary_unavailable')}</span>}
        </div>
        {skillSummaryOk ? (
          <div className={`${styles['memory-history-summary']} ${styles['memory-history-skill-summary']}`}>
            <span className={styles['memory-history-summary-text']}>{sr!.summary}</span>
          </div>
        ) : null}
        <div className={styles['memory-history-detail']} data-memory-history-detail>
          {isExpanded && (
            !detailInfo.has(run.taskId) && fileCount > 0
              ? <div className={styles['memory-detail-loading']}>{t('memory_detail_loading')}</div>
              : (() => {
                  const fragments = [
                    ...(run.filesTouched ?? []).map(path => renderDetailFileRow(run, path)),
                    ...(sr?.distilled ?? []).map((d, i) => renderDetailSkillRow(d, i)),
                  ]
                  return fragments.length ? fragments : <div className={styles['memory-detail-empty']}>{t('memory_detail_no_files')}</div>
                })()
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles['memory-inner']} onClick={onSectionClick} onKeyDownCapture={onSectionKeyDownCapture}>
      <PageHeader
        titleKey="memory_title"
        subtitleKey="memory_subtitle"
        topbarHtml={topbarHtml}
        bodyHtml={timeFilterBodyHtml}
      />

      {renderCurrentCard()}
      <div id="memory-history" className={styles['memory-history']} ref={historyElRef}>
        {/* Synapse 覆盖层宿主：React 只渲染这个空壳，SVG 子树归 synapse.ts 独管。 */}
        <div style={{ display: 'contents' }} ref={synapseHostRef} />
        {history.rows.map(renderHistoryRow)}
      </div>
      <div id="memory-history-empty" className="cron-empty" style={{ display: history.loadedOnce && !historyError && history.rows.length === 0 ? 'flex' : 'none' }}>
        <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: rawIconHtml('memory-empty-crescent') }} />
        <p>{t('memory_history_empty')}</p>
      </div>
      <div id="memory-history-loading" className={styles['memory-loading']} style={{ display: isLoadingPage ? 'block' : 'none' }}>
        <span>{t('loading')}</span>
      </div>
      {historyError ? (
        <div className="cron-empty" role="alert">
          <p>{historyError}</p>
          <button type="button" className="btn-sm" onClick={() => { void loadNextHistoryPage({ reset: true, range: timeRange }) }}>{t('memory_history_retry')}</button>
        </div>
      ) : null}
      {/* Sentinel for the IntersectionObserver — fetch next page when this scrolls into view. */}
      <div id="memory-history-sentinel" className={styles['memory-history-sentinel']} ref={sentinelRef} />
      {/* End-of-journal mark — shown only when no further pages exist AND there's a row to bookend. */}
      <div id="memory-history-end" className={styles['memory-history-end']} style={{ display: !history.hasMore && history.rows.length > 0 ? 'flex' : 'none' }}>
        <span className={styles['memory-history-end-mark']}>·</span>
        <span className="memory-history-end-text">{t('memory_history_end')}</span>
        <span className={styles['memory-history-end-mark']}>·</span>
      </div>
    </div>
  )
}
