// Skills 页（React 岛）——迁自 js/pages/skills.js。
// market（三页共用双列卡片 + 远程搜索/无限滚动）/ installed（本页单列行式
// 列表 sk-row，使用/卸载 + 对勾启停）双档 + 分类 tabs + 全局/项目作用域。
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { ModalPortal } from '../../components/ModalPortal'
import { PageHeader } from '../../components/PageHeader'
import { MarketCard, MarketGrid } from '../../components/Market'
import { ExtensionInlineProgressBar, ExtensionTransferBanner } from '../../components/ExtensionTransfer'
import { acquisitionPending, skillAcquisitionStore, type ExtensionAcquisitionItem } from '../../components/extension-acquisition-store'
import { canCancelPluginOperation, compactStageLabelKey, compactTransferSummary } from '../plugins/plugin-transfer'
import { rawIconHtml } from '../../components/Icon'
import {
  getSkillBrandTile, getSkillCategory, getSkillIconName, getSkillSearchValuesLocal, groupSkillsByCategory,
  localizeSkillDescription, localizeSkillName, renderLineIcon, skillCategoryLabel, skillGlyphSvg,
  skillEmojiBrickHtml, skillEmojiGlyphHtml, skillLogoBrickHtml, skillLogoImgHtml, skillRemoteIconHtml,
  sortSkillsByName, type SkillItem,
} from './localize'
import {
  appendMarketToCache, consumeInstalledStale, getSkillsCache, invalidateSkillsDataCache,
  isInstalledStale, loadSkillsData, marketCursor, marketIsRemote, markInstalledCacheStale,
  markSkillInstalledInCache, markSkillUpdatedInCache, replaceMarketInCache, updateCachedSkillEnabled,
} from './data'
import { SkillSourceModal, SkillUploadModal } from './modals'
import styles from './skills.module.css'

const w = () => window as any
const showToast = (msg: string) => w().showToast?.(msg)

interface Snapshot {
  installed: SkillItem[]
  market: SkillItem[]
  userInstalled: SkillItem[]
  projects: { roots: string[]; labels: Record<string, string> }
  workspaces: Array<{ id: string; name: string; primary: string }>
  errors: { installed: string | null; market: string | null; builtin: string | null }
}

/** Scope values for workspace tabs; project tabs use the raw root. */
const WORKSPACE_SCOPE_PREFIX = 'ws:'

interface MarketPage {
  items: SkillItem[]
  nextCursor: string | null
  isRemote: boolean
  error: string | null
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || '').trim()
    if (message) return message
  }
  return typeof error === 'string' && error.trim() ? error : fallback
}

function marketPage(value: any): MarketPage {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) {
    throw new Error('Skill market returned an invalid response')
  }
  return {
    items: value.items,
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
    isRemote: value.isRemote === true,
    error: value.error ? errorText(value.error, 'Skill market request failed') : null,
  }
}

function requireMutationResult(value: any, fallback: string): any {
  if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') throw new Error(fallback)
  return value
}

function requireVoidOrOk(value: any, fallback: string): void {
  if (value == null || value?.ok === true) return
  throw new Error(value?.error || fallback)
}

/** 内置技能开箱就在，不需安装，所以它们属于技能广场而不是「用户安装」；
 *  它们带 `tags: [builtin]`，因此分类行自然长出一个「内置」档，无需特判。
 *  同名的市场条目被内置条目顶掉（cron-manager 既是内置又在随包市场目录里），
 *  否则同一个技能会在广场里出现两次。 */
function mergeBuiltinIntoMarket(
  builtin: SkillItem[],
  market: SkillItem[],
  query = '',
  matches?: (query: string, values: unknown[]) => boolean,
): SkillItem[] {
  const visibleBuiltin = query && matches
    ? builtin.filter(skill => matches(query, getSkillSearchValuesLocal(skill)))
    : builtin
  const key = (s: SkillItem) => String(s.dirName || s.name || '').trim().toLowerCase()
  const builtinKeys = new Set(builtin.map(key).filter(Boolean))
  return [...visibleBuiltin, ...market.filter(s => !builtinKeys.has(key(s)))]
}

function SkillHealthBadge({ skill }: { skill: SkillItem }) {
  const t = useT()
  const status = skill.dependencyStatus
  if (!status || status === 'ready') return null
  const title = status === 'missing'
    ? `${t('skills_dependency_missing')}: ${(skill.missingBins || []).join(', ')}`
    : status === 'config'
      ? `${t('skills_dependency_env_hint')}: ${(skill.missingEnv || []).join(', ')}`
      : status === 'invalid'
        ? (skill.error || t('skills_health_invalid'))
        : t('skills_health_unsupported')
  const labelKey = status === 'missing' ? 'skills_health_missing'
    : status === 'config' ? 'skills_health_config'
      : status === 'invalid' ? 'skills_health_invalid' : 'skills_health_unsupported'
  return <span className={`sk-health-badge sk-health-${status}`} title={title}>{t(labelKey)}</span>
}

/** 「使用」/「通过 Klaus 创建」：新会话预选命令芯片（同快捷指令页链路）。 */
function draftInComposer(command: Record<string, unknown>, seed: string) {
  if (w().isSettingsViewActive()) w().toggleSettings()
  try { document.getElementById('btn-new-chat')?.click() } catch { /* welcome btn absent */ }
  const insertWhenReady = (attempt = 0) => {
    if (w().klausComposer?.setSlashCommandDraft) {
      w().klausComposer.setSlashCommandDraft(command, seed)
      return
    }
    const input = document.getElementById('input') as HTMLTextAreaElement | null
    if (input) {
      input.value = `/${command.name} ${seed}`.trimEnd() + ' '
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      return
    }
    if (attempt < 20) setTimeout(() => insertWhenReady(attempt + 1), 50)
  }
  setTimeout(() => insertWhenReady(), 120)
}

/** 「录制技能」：新会话预填一段纯文本指令（不是斜杠命令），用户确认后发出，
 *  由 agent 调 event_stream_start 开始录制。 */
function draftTextInComposer(text: string) {
  if (w().isSettingsViewActive()) w().toggleSettings()
  try { document.getElementById('btn-new-chat')?.click() } catch { /* welcome btn absent */ }
  const insertWhenReady = (attempt = 0) => {
    if (w().klausComposer?.setText) {
      w().klausComposer.setText(text)
      return
    }
    const input = document.getElementById('input') as HTMLTextAreaElement | null
    if (input) {
      input.value = text
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      return
    }
    if (attempt < 20) setTimeout(() => insertWhenReady(attempt + 1), 50)
  }
  setTimeout(() => insertWhenReady(), 120)
}

function skillSlug(skill: SkillItem): string {
  return String(skill.upstreamSlug || skill.dirName || skill.name || '').trim()
}

function skillBusyLabel(operation: ExtensionAcquisitionItem | undefined, fallback: string | null, t: (key: string) => string): string {
  if (operation?.cancelling) return t('plugins_cancelling')
  if (operation?.phase === 'queued') return t('plugins_queued')
  if (operation?.progress) return t(compactStageLabelKey(operation.progress.stage))
  if (fallback) return fallback
  return operation?.action === 'update' ? (t('skills_updating') || '更新中...') : t('plugins_installing')
}

async function performSkillUpdate(
  skill: SkillItem,
  t: (key: string) => string,
  onChanged: () => void,
): Promise<{ ok?: boolean; cancelled?: boolean; installed?: boolean; error?: string; version?: string }> {
  const id = skillSlug(skill)
  if (!id) return { ok: false, error: 'Missing skill slug' }
  return skillAcquisitionStore.enqueue(id, 'update', async () => {
    const result = requireMutationResult(
      await w().klaus.skills.update(id, skill.latestVersion || undefined),
      t('skills_invalid_response'),
    )
    if (result.cancelled) return { ok: false, cancelled: true }
    if (result.ok) {
      showToast(`${t('skills_updated_toast') || '已更新'}: ${result.name}`)
      markSkillUpdatedInCache(id, skill.latestVersion)
      markInstalledCacheStale()
      onChanged()
      return { ok: true, version: skill.latestVersion }
    }
    if (result.installed) {
      markSkillUpdatedInCache(id, skill.latestVersion)
      markInstalledCacheStale()
      onChanged()
      showToast(t('skills_saved_reload_failed'))
      return { ok: false, installed: true, version: skill.latestVersion }
    }
    showToast(t('toast_error_prefix') + (result.error || t('toast_unknown')))
    return { ok: false, error: result.error || t('toast_unknown') }
  })
}

/** 市场卡行尾安装/更新钮（接入共享传输进度与可取消队列）。 */
function MarketInstallBtn({
  skill,
  operation,
  onChanged,
  onCancel,
}: {
  skill: SkillItem
  operation?: ExtensionAcquisitionItem
  onChanged: () => void
  onCancel: () => void
}) {
  const t = useT()
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const busyRef = useRef(false)
  const id = skillSlug(skill)
  const pending = acquisitionPending(operation) || Boolean(busyLabel)
  const cancellable = canCancelPluginOperation(operation)

  const install = async () => {
    if (busyRef.current || acquisitionPending(operation)) return
    busyRef.current = true
    setBusyLabel(t('skills_install_checking'))
    try {
      await skillAcquisitionStore.enqueue(id, 'install', async () => {
        let result = requireMutationResult(
          await w().klaus.skills.install(id, { version: skill.latestVersion || undefined }),
          t('skills_invalid_response'),
        )
        if (result.cancelled) return { ok: false, cancelled: true }
        if (result.needsDependencyInstall) {
          const missing = (result.missingBins || []).join(', ')
          if (result.canAutoInstall) {
            const choice = await w().klausDialog.confirm({
              title: t('skills_dependency_install_title'),
              message: `${t('skills_dependency_install_message')}\n\n${t('skills_dependency_missing')}: ${missing}`,
              confirmText: t('skills_dependency_install_confirm'),
              checkbox: { label: t('skills_dependency_install_checkbox'), defaultChecked: true },
            })
            if (!choice.confirmed) return { ok: false, cancelled: true }
            setBusyLabel(choice.checked ? t('skills_installing_dependencies') : t('settings_skills_uploading'))
            result = requireMutationResult(await w().klaus.skills.install(id, choice.checked
              ? { installMissing: true, version: skill.latestVersion || undefined }
              : { skipDependencyInstall: true, version: skill.latestVersion || undefined }), t('skills_invalid_response'))
          } else {
            const confirmed = await w().klausDialog.confirm({
              title: t('skills_dependency_manual_title'),
              message: `${t('skills_dependency_manual_message')}\n\n${t('skills_dependency_missing')}: ${missing}`,
              confirmText: t('skills_dependency_install_anyway'),
            })
            if (!confirmed) return { ok: false, cancelled: true }
            setBusyLabel(t('settings_skills_uploading'))
            result = requireMutationResult(
              await w().klaus.skills.install(id, { skipDependencyInstall: true, version: skill.latestVersion || undefined }),
              t('skills_invalid_response'),
            )
          }
        }
        if (result.cancelled) return { ok: false, cancelled: true }
        if (result.ok) {
          let message = `${t('settings_skills_installed_toast')}: ${result.name}`
          if (result.missingBins?.length) message += ` · ${t('skills_dependency_missing')}: ${result.missingBins.join(', ')}`
          if (result.missingEnv?.length) message += ` · ${t('skills_dependency_env_hint')}: ${result.missingEnv.join(', ')}`
          if (result.dependencyWarnings?.length) message += ` · ${result.dependencyWarnings[0]}`
          showToast(message)
          markSkillInstalledInCache(id)
          markInstalledCacheStale()
          setDone(true)
          onChanged()
          return { ok: true, version: skill.latestVersion }
        }
        if (result.installed) {
          markSkillInstalledInCache(id)
          markInstalledCacheStale()
          setDone(true)
          onChanged()
          showToast(t('skills_saved_reload_failed'))
          return { ok: false, installed: true }
        }
        const missing = result.missingBins?.length ? `${t('skills_dependency_missing')}: ${result.missingBins.join(', ')}. ` : ''
        const warning = result.dependencyWarnings?.length ? result.dependencyWarnings[0] : ''
        const err = missing + (result.error || warning || t('toast_unknown'))
        showToast(t('toast_error_prefix') + err)
        return { ok: false, error: err }
      })
    } catch (err: any) {
      showToast(t('toast_error_prefix') + (err?.message || err || t('toast_unknown')))
    } finally {
      busyRef.current = false
      setBusyLabel(null)
    }
  }

  const update = async () => {
    if (busyRef.current || acquisitionPending(operation)) return
    busyRef.current = true
    setBusyLabel(t('skills_updating') || '更新中...')
    try {
      const outcome = await performSkillUpdate(skill, t, onChanged)
      if (outcome.ok || outcome.installed) setDone(true)
    } finally {
      busyRef.current = false
      setBusyLabel(null)
    }
  }

  if (done || (skill.installed && !skill.hasUpdate && !pending)) {
    return <button className="btn-xs" disabled>{t('installed') || '已安装'}</button>
  }
  if (!pending && (skill.dependencyStatus === 'unsupported' || skill.dependencyStatus === 'invalid')) {
    return <button className="btn-xs" disabled>
      {t(skill.dependencyStatus === 'invalid' ? 'skills_health_invalid' : 'skills_health_unsupported')}
    </button>
  }
  if (pending) {
    return (
      <>
        <button className="btn-xs" disabled>
          <span className={styles['sk-spinner']} aria-hidden="true" />
          {skillBusyLabel(operation, busyLabel, t)}
        </button>
        {(cancellable || operation?.cancelling) && (
          <button
            type="button"
            className="btn-xs"
            data-skill-cancel={id}
            disabled={!cancellable}
            onClick={(e) => { e.stopPropagation(); onCancel() }}
          >
            {t(operation?.cancelling ? 'plugins_cancelling' : 'plugins_cancel')}
          </button>
        )}
      </>
    )
  }
  if (skill.hasUpdate) {
    const label = skill.latestVersion
      ? t('skills_update_to').replace('{version}', skill.latestVersion)
      : (t('skills_update_btn') || '更新')
    return <button className="btn-xs" data-skill-update={id} onClick={(e) => { e.stopPropagation(); void update() }}>{label}</button>
  }
  return (
    <button className="btn-xs" data-skill-install={id} onClick={(e) => { e.stopPropagation(); void install() }}>
      {t('settings_skills_install') || t('skills_install_btn') || '安装'}
    </button>
  )
}

export function SkillsPage() {
  const t = useT()
  const transferSnap = useSyncExternalStore(skillAcquisitionStore.subscribe, skillAcquisitionStore.getSnapshot)
  const { operations: transferOps, batch: transferBatch } = transferSnap
  const filterTextMatches = w().filterTextMatches as (q: string, hay: unknown[]) => boolean
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadWarning, setLoadWarning] = useState<string | null>(null)
  const [scopeError, setScopeError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [installedContextLoading, setInstalledContextLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState<Set<string>>(new Set())
  const [view, setView] = useState<'market' | 'installed'>('market')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState('global')
  const [modal, setModal] = useState<'upload' | 'source' | null>(null)
  const seqRef = useRef(0)
  const searchSeqRef = useRef(0)
  const committedMarketQueryRef = useRef('')
  const actionBusyRef = useRef(new Set<string>())
  const stateRef = useRef({ view, scope, snap, search })
  stateRef.current = { view, scope, snap, search }
  const sentinelRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(async (opts: { forceRefresh?: boolean; view?: 'market' | 'installed'; scope?: string; maskInstalled?: boolean } = {}) => {
    const seq = ++seqRef.current
    const curView = opts.view ?? stateRef.current.view
    let curScope = opts.scope ?? stateRef.current.scope
    if (opts.maskInstalled) setInstalledContextLoading(true)
    try {
      const [dataResult, projectsResult, workspacesResult] = await Promise.allSettled([
        loadSkillsData(!!opts.forceRefresh),
        Promise.resolve(w().klaus.projects?.list?.()),
        Promise.resolve(w().klaus.workspaces?.list?.()),
      ])
      if (dataResult.status === 'rejected') throw dataResult.reason
      const data = dataResult.value
      if (seq !== seqRef.current) return
      const warnings = Object.values(data.errors).filter((value): value is string => Boolean(value))
      let projects = stateRef.current.snap?.projects ?? { roots: [], labels: {} }
      const projectsState = projectsResult.status === 'fulfilled' ? projectsResult.value : null
      if (projectsState && typeof projectsState === 'object') {
        const roots = Array.isArray(projectsState.roots)
          ? projectsState.roots.map((root: any) => (typeof root === 'string' ? root : root?.path)).filter((root: unknown): root is string => typeof root === 'string' && !root.startsWith('ssh://'))
          : []
        projects = {
          roots: [...new Set<string>(roots)],
          labels: projectsState.labels && typeof projectsState.labels === 'object' ? projectsState.labels : {},
        }
      } else {
        warnings.push(projectsResult.status === 'rejected'
          ? errorText(projectsResult.reason, t('skills_projects_unavailable'))
          : t('skills_projects_unavailable'))
      }
      const workspaces = workspacesResult.status === 'fulfilled'
        ? (Array.isArray((workspacesResult.value as any)?.workspaces) ? (workspacesResult.value as any).workspaces : [])
          .map((ws: any) => ({
            id: String(ws?.id || ''),
            name: String(ws?.name || ''),
            roots: Array.isArray(ws?.roots) ? ws.roots.filter((root: unknown): root is string => typeof root === 'string') : [],
          }))
          .filter((ws: { id: string; roots: string[] }) => !!ws.id && ws.roots.length > 0)
          .map((ws: { id: string; name: string; roots: string[] }) => ({ id: ws.id, name: ws.name || ws.roots[0]!.split(/[\\/]/).filter(Boolean).pop() || ws.roots[0]!, primary: ws.roots[0]! }))
        : stateRef.current.snap?.workspaces ?? []
      if (curScope !== 'global'
        && !projects.roots.includes(curScope)
        && !(curScope.startsWith(WORKSPACE_SCOPE_PREFIX) && workspaces.some((ws: { id: string; name: string; primary: string }) => WORKSPACE_SCOPE_PREFIX + ws.id === curScope))) curScope = 'global'

      // 项目/工作空间档清单每次现拉（<root>/.klaus/skills 目录小且可能被外部改动，不进缓存）
      let userInstalled = data.installed
      let nextScopeError: string | null = null
      if (curView === 'installed' && curScope !== 'global') {
        try {
          const projectSkills = curScope.startsWith(WORKSPACE_SCOPE_PREFIX)
            ? await w().klaus.skills.list({ workspaceId: curScope.slice(WORKSPACE_SCOPE_PREFIX.length) })
            : await w().klaus.skills.list({ projectRoot: curScope })
          if (seq !== seqRef.current) return
          if (!Array.isArray(projectSkills)) throw new Error(t('skills_invalid_response'))
          userInstalled = projectSkills
        } catch (reason) {
          nextScopeError = errorText(reason, t('skills_load_failed'))
          userInstalled = []
        }
      }

      setScope(curScope)
      setScopeError(nextScopeError)
      setLoadWarning(warnings.length ? [...new Set(warnings)].join(' · ') : null)
      setSnap({
        installed: data.installed,
        market: mergeBuiltinIntoMarket(data.builtin, data.market),
        userInstalled,
        projects,
        workspaces,
        errors: data.errors,
      })
      setError(null)
    } catch (err: any) {
      if (seq !== seqRef.current) return
      // 拉取失败不能永久白屏/转圈：已有内容则 toast，冷启动则壳里内联报错
      if (stateRef.current.snap) showToast(`${t('toast_error_prefix')}${err?.message || err}`)
      else setError(String(err?.message || err))
    } finally {
      if (seq === seqRef.current) setInstalledContextLoading(false)
    }
  }, [t])

  useEffect(() => { void reload() }, [])

  useEffect(() => {
    const onChanged = () => {
      if (document.getElementById('skills-view')?.classList.contains('active')) void reload()
    }
    window.addEventListener('klaus:projects-changed', onChanged)
    window.addEventListener('klaus:skills-changed', onChanged)
    return () => {
      window.removeEventListener('klaus:projects-changed', onChanged)
      window.removeEventListener('klaus:skills-changed', onChanged)
    }
  }, [reload])

  // 无限滚动：sentinel 进视口时拉下一页（带当前搜索词——远程分页的 nextCursor
  // 属于「同一查询」的续页，丢 query 会把未过滤的目录页混进搜索结果）。
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || view !== 'market' || !marketCursor || searching) return
    let isLoadingMore = false
    let userHasScrolled = false
    const viewEl = document.getElementById('skills-view')
    const markScrolled = () => { userHasScrolled = true }
    viewEl?.addEventListener('scroll', markScrolled, { once: true, capture: true })
    const observer = new IntersectionObserver(async (entries) => {
      if (!entries[0]?.isIntersecting || isLoadingMore || !marketCursor || !userHasScrolled || category !== 'all') return
      isLoadingMore = true
      const requestSeq = searchSeqRef.current
      const query = committedMarketQueryRef.current
      const cursor = marketCursor
      try {
        const page = marketPage(await w().klaus.skills.market({ cursor, query }))
        if (requestSeq !== searchSeqRef.current || query !== committedMarketQueryRef.current) return
        if (page.error) showToast(`${t('toast_error_prefix')}${page.error}`)
        if (!page.isRemote) {
          replaceMarketInCache(page.items, null, false)
          const fallbackCache = getSkillsCache()
          if (fallbackCache) setSnap(previous => previous
            ? { ...previous, market: mergeBuiltinIntoMarket(fallbackCache.builtin, fallbackCache.market), errors: { ...previous.errors, market: page.error } }
            : previous)
          observer.disconnect()
          return
        }
        const pageItems = query
          ? page.items.filter(skill => skill.upstreamSlug || filterTextMatches(query, getSkillSearchValuesLocal(skill)))
          : page.items
        const newItems = appendMarketToCache(pageItems, page.nextCursor)
        const cache = getSkillsCache()
        if (cache && newItems.length) {
          setSnap(previous => previous
            ? { ...previous, market: mergeBuiltinIntoMarket(cache.builtin, cache.market, query, filterTextMatches) }
            : previous)
        }
        if (!marketCursor) observer.disconnect()
      } catch (err) {
        showToast(`${t('toast_error_prefix')}${err instanceof Error ? err.message : String(err)}`)
      } finally {
        isLoadingMore = false
      }
    }, { rootMargin: '200px 0px' })
    observer.observe(sentinel)
    return () => {
      observer.disconnect()
      viewEl?.removeEventListener('scroll', markScrolled, { capture: true } as any)
    }
  }, [snap?.market?.length, view, category, searching, t])

  const switchView = (next: 'market' | 'installed') => {
    const hadMarketQuery = Boolean(committedMarketQueryRef.current)
    const installedNeedsRefresh = next === 'installed' && isInstalledStale()
    searchSeqRef.current++
    committedMarketQueryRef.current = ''
    setSearch('')
    setSearching(false)
    setView(next)
    setCategory('all')
    if (installedNeedsRefresh) {
      consumeInstalledStale()
    }
    // Remote query results replace the market cache. Restore the unfiltered
    // catalog while leaving the view so returning cannot resurrect stale rows.
    void reload({
      forceRefresh: hadMarketQuery || installedNeedsRefresh,
      view: next,
      maskInstalled: next === 'installed' && (scope !== 'global' || installedNeedsRefresh),
    })
    w().klsPageViews.scrollViewToTop('skills-view')
  }
  const switchScope = (next: string) => {
    setScope(next)
    setScopeError(null)
    void reload({ scope: next, view: 'installed', maskInstalled: true })
    w().klsPageViews.scrollViewToTop('skills-view')
  }

  // 远程搜索（market + remote：Enter 触发后端查询）
  const remoteSearch = useCallback(async (input: string) => {
    const value = input.trim()
    const requestSeq = ++searchSeqRef.current
    committedMarketQueryRef.current = value
    setSearch(value)
    setSearching(true)
    try {
      if (!value) {
        await reload({ forceRefresh: true })
        return
      }
      const page = marketPage(await w().klaus.skills.market({ query: value }))
      if (requestSeq !== searchSeqRef.current) return
      const pageItems = page.isRemote
        ? page.items.filter(skill => skill.upstreamSlug || filterTextMatches(value, getSkillSearchValuesLocal(skill)))
        : page.items
      replaceMarketInCache(pageItems, page.nextCursor, page.isRemote)
      const cache = getSkillsCache()
      if (cache) {
        setSnap(previous => previous
          ? { ...previous, market: mergeBuiltinIntoMarket(cache.builtin, cache.market, value, filterTextMatches), errors: { ...previous.errors, market: page.error } }
          : previous)
      }
      if (page.error) showToast(`${t('toast_error_prefix')}${page.error}`)
    } catch (err) {
      if (requestSeq === searchSeqRef.current) showToast(`${t('toast_error_prefix')}${errorText(err, t('toast_unknown'))}`)
    } finally {
      if (requestSeq === searchSeqRef.current) setSearching(false)
    }
  }, [reload, t])

  // Enter 触发远程搜索：PageHeader 的 input 由工厂持有，监听挂在 document 上按 id 路由
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      const target = e.target as HTMLInputElement
      if (target?.id !== 'sk-search-input') return
      if (stateRef.current.view === 'market' && marketIsRemote) {
        e.preventDefault()
        void remoteSearch(target.value)
      }
    }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [remoteSearch])

  const runRowAction = async (key: string, action: () => Promise<void>) => {
    if (actionBusyRef.current.has(key)) return
    actionBusyRef.current.add(key)
    setActionBusy(new Set(actionBusyRef.current))
    try { await action() } finally {
      actionBusyRef.current.delete(key)
      setActionBusy(new Set(actionBusyRef.current))
    }
  }

  const toggleSkill = async (skill: SkillItem) => {
    const dirName = String(skill.dirName || skill.name || '')
    if (!dirName) return
    const nextEnabled = !skill.userEnabled
    await runRowAction(`toggle:${dirName}`, async () => {
      try {
        const result = await w().klaus.skills.toggle(dirName, nextEnabled)
        if (result?.saved === true) {
          updateCachedSkillEnabled(dirName, nextEnabled)
          showToast(t('skills_saved_reload_failed'))
          await reload()
          return
        }
        requireVoidOrOk(result, t('skills_invalid_response'))
        updateCachedSkillEnabled(dirName, nextEnabled)
        showToast(nextEnabled ? t('settings_skills_on') : t('settings_skills_off'))
        await reload()
      } catch (err: any) {
        showToast(t('toast_error_prefix') + errorText(err, t('toast_unknown')))
      }
    })
  }

  const uninstallSkill = async (skill: SkillItem) => {
    const dirName = String(skill.dirName || skill.name || '')
    if (!dirName) return
    // A workspace tab spans several member folders; the row's own root owns
    // the skill directory, so removal targets exactly that folder.
    const owningRoot = scope.startsWith(WORKSPACE_SCOPE_PREFIX) ? (skill.root || '') : scope !== 'global' ? scope : ''
    await runRowAction(`uninstall:${scope}:${dirName}`, async () => {
      try {
        if (!(await w().klausDialog.confirm({
          title: t('settings_skills_uninstall'),
          message: t('settings_skills_uninstall') + ': ' + dirName + '?',
          confirmText: t('settings_skills_uninstall'),
          danger: true,
        }))) return
        const result = await w().klaus.skills.uninstall(
          dirName,
          view === 'installed' && owningRoot ? { projectRoot: owningRoot } : undefined,
        )
        if (result !== true && result?.removed !== true) throw new Error(result?.error || t('toast_unknown'))
        invalidateSkillsDataCache()
        showToast(result?.removed === true ? t('skills_removed_reload_failed') : t('settings_skills_uninstalled_toast'))
        await reload({ forceRefresh: true })
      } catch (err: any) {
        showToast(`${t('toast_error_prefix')}${errorText(err, t('toast_unknown'))}`)
      }
    })
  }

  const useSkill = (skill: SkillItem) => {
    const dirName = String(skill.dirName || skill.name || '')
    if (!dirName) return
    draftInComposer({
      name: dirName,
      displayName: localizeSkillName(skill),
      description: localizeSkillDescription(skill),
      type: 'prompt',
      loadedFrom: 'skill',
      source: 'skill',
    }, '')
  }

  const openSkillWindow = (dirName: string) => {
    const isProject = view === 'installed' && scope !== 'global'
    w().klaus.skills.openWindow(dirName, isProject ? { projectRoot: scope } : undefined)
      .then((result: any) => {
        if (!result || result.ok !== true) showToast(`${t('toast_error_prefix')}${result?.error || t('skills_invalid_response')}`)
      })
      .catch((err: any) => showToast(`${t('toast_error_prefix')}${err?.message || err}`))
  }

  const createViaKlaus = () => {
    const seed = t('skills_via_klaus_draft') || 'Help me create a Klaus skill that does "what it should do".'
    // `/skill-creator` 是客户端自带的内置命令（bundled-commands.json，标
    // `builtin-skill`），不靠市场安装——否则这个按钮插出来的就是个假芯片。
    draftInComposer({
      name: 'skill-creator',
      displayName: t('skills_creator_command_label') || 'Skill Creator',
      type: 'prompt',
      loadedFrom: 'builtin-skill',
    }, seed)
  }

  // 录制技能：录的是用户自己的演示。入口只预填指令开新会话，真正的开始由
  // agent 调 event_stream_start 完成（会先走一次确认），这样停止后整理技能
  // 的上下文还在同一个会话里。
  const recordSkill = () => {
    draftTextInComposer(t('skills_record_skill_draft'))
  }

  const closeSkillModal = () => {
    setModal(null)
    setTimeout(() => document.getElementById('sk-create-btn')?.focus(), 0)
  }

  // ---- 派生列表 ----
  const esc = w().esc as (s: unknown) => string
  const marketByDir = new Map<string, SkillItem>()
  for (const item of snap?.market ?? []) {
    const key = String(item.dirName || item.upstreamSlug || item.name || '').trim()
    if (key && item.source !== 'builtin') marketByDir.set(key, item)
  }
  const updatableSkills = (snap?.market ?? []).filter(s => s.source !== 'builtin' && s.installed && s.hasUpdate)
  useEffect(() => {
    skillAcquisitionStore.setAvailableUpdates(updatableSkills.length)
  }, [updatableSkills.length])

  const enrichedInstalled = (snap?.userInstalled ?? []).map(item => {
    if (scope !== 'global') return item
    const dir = String(item.dirName || item.name || '').trim()
    const m = marketByDir.get(dir)
    if (!m) return item
    return {
      ...item,
      upstreamSlug: m.upstreamSlug ?? item.upstreamSlug,
      hasUpdate: m.hasUpdate === true,
      version: m.version ?? item.version,
      latestVersion: m.latestVersion ?? item.latestVersion,
    }
  })
  const baseList = snap ? (view === 'market' ? snap.market : enrichedInstalled) : []
  const enabledFiltered = view === 'installed'
    ? baseList.filter(s => (filter === 'enabled' ? s.userEnabled : filter === 'disabled' ? !s.userEnabled : true))
    : baseList
  // 本地搜索（远程搜索直接改写 market 数据，这里不再二次过滤远程档）
  const searchApplies = !(view === 'market' && marketIsRemote)
  const searched = searchApplies && search
    ? enabledFiltered.filter(s => filterTextMatches(search, getSkillSearchValuesLocal(s)))
    : enabledFiltered
  // 分类行只属于市场档。已安装档的二级已经被作用域行占掉，再叠分类就成了三级
  // tab；而且装机清单大多没有 tags，那一行只会退化成「全部 / 其他」两档，白占
  // 一行高度还什么也筛不出来。既然不渲染，分类筛选在该档也一并不生效——留一个
  // 看不见的过滤条件在后面挡列表，是比多一行更糟的事。
  const categoryApplies = view === 'market'
  const activeCategory = !categoryApplies || (category !== 'all' && !searched.some(s => getSkillCategory(s) === category)) ? 'all' : category
  const groups = groupSkillsByCategory(searched)
  // 「内置」置首、「其他」置尾，中间按字母。内置是用户已经拥有的那一档，
  // 按字母插到 automation 和 content 之间只会把它埋起来。
  const categoryKeys = [...groups.keys()].filter(k => k !== 'other' && k !== 'builtin').sort()
  if (groups.has('builtin')) categoryKeys.unshift('builtin')
  if (groups.has('other')) categoryKeys.push('other')
  const categoryTabs = [
    { key: 'all', label: t('skills_filter_all') || '全部', count: searched.length },
    ...categoryKeys.map(key => ({ key, label: skillCategoryLabel(key), count: groups.get(key)!.length })),
  ]
  const showCategoryTabs = categoryApplies && categoryTabs.some(tab => tab.key !== 'all' && tab.key !== 'other')
  const visibleSkills = sortSkillsByName(activeCategory === 'all' ? searched : searched.filter(s => getSkillCategory(s) === activeCategory))

  // ---- 页头 bodyHtml（tabbar + 作用域栏 + 分类 tabs，与旧版结构逐字对应） ----
  const bodyHtml = (() => {
    if (!snap) return undefined
    const tabs = [
      { key: 'market', label: t('skills_tab_market'), count: snap.market.length, showBadge: true },
      { key: 'installed', label: t('skills_tab_installed'), count: snap.userInstalled.length, showBadge: snap.userInstalled.length > 0 },
    ]
    // 作用域 tab 组：已安装档下自占一行的二级 tab（.qc-scope-bar，同快捷命令/Hooks 页）。
    // 项目多时不与一级 tab 抢一行宽度，宽度不够由 qc-scope-seg 自己横向滚动；
    // 市场档无此行（全局目录不存在项目级市场）。
    const scopeBar = view === 'installed'
      ? `
        <div class="qc-scope-bar">
          <div class="qc-scope-seg" role="tablist" aria-label="${esc(t('skills_tab_installed'))}">
            <button class="qc-scope-tab ${scope === 'global' ? 'active' : ''}" role="tab" aria-selected="${scope === 'global'}" tabindex="${scope === 'global' ? 0 : -1}" data-sk-scope="global">${esc(t('slash_commands_scope_global'))}</button>
            ${snap.projects.roots.map(root => {
              const label = snap.projects.labels?.[root] || root.split(/[\\/]/).filter(Boolean).pop() || root
              const active = scope === root
              return `<button class="qc-scope-tab qc-scope-tab-project ${active ? 'active' : ''}" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}" data-sk-scope-root="${esc(root)}"><span>${esc(label)}</span></button>`
            }).join('')}
            ${(snap.workspaces ?? []).map(ws => {
              const key = WORKSPACE_SCOPE_PREFIX + ws.id
              const active = scope === key
              return `<button class="qc-scope-tab qc-scope-tab-project ${active ? 'active' : ''}" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}" data-sk-scope-ws="${esc(ws.id)}"><span>${esc(ws.name)}</span></button>`
            }).join('')}
          </div>
        </div>`
      : ''
    const updateAllIdle = !(transferBatch?.running || (updatableSkills.length > 0 && updatableSkills.every(item => acquisitionPending(transferOps[skillSlug(item)]))))
    const trailingActionsHtml = `<div class="${styles['sk-tab-actions']}">${updatableSkills.length > 0 ? `<button type="button" class="btn-sm" data-skill-update-all${updateAllIdle ? '' : ' disabled'}>${esc(t('skills_update_all').replace('{count}', String(updatableSkills.length)))}</button>` : ''}${view === 'installed' ? '<div class="sk-filters"><div id="sk-filter" class="kls-select"></div></div>' : ''}</div>`
    return `<div class="sk-tabbar">
          <div class="sk-tabs" role="tablist" aria-label="${esc(t('skills'))}">
            ${tabs.map(tab => `<button class="sk-tab ${view === tab.key ? 'active' : ''}" role="tab" aria-selected="${view === tab.key}" tabindex="${view === tab.key ? 0 : -1}" data-skill-tab="${tab.key}">${esc(tab.label)}${tab.showBadge ? ` <span class="sk-tab-count">${tab.count}</span>` : ''}</button>`).join('')}
          </div>
          ${trailingActionsHtml}
        </div>
        ${scopeBar}
        ${showCategoryTabs ? `
        <div class="sk-category-tabs" role="tablist" aria-label="${esc(t('skills'))}">
          ${categoryTabs.map(tab => `<button class="qc-scope-tab ${activeCategory === tab.key ? 'active' : ''}" role="tab" aria-selected="${activeCategory === tab.key}" tabindex="${activeCategory === tab.key ? 0 : -1}" data-skill-category-tab="${esc(tab.key)}">${esc(tab.label)} <span class="qc-scope-tab-count">${tab.count}</span></button>`).join('')}
        </div>` : ''}`
  })()

  // 启停筛选下拉（工厂 HTML 宿主，渲染后 klsSelect 绑定）
  useEffect(() => {
    const host = document.getElementById('sk-filter')
    if (!host || view !== 'installed') return
    const select = w().klsSelect.bind(host, {
      items: [
        { value: 'all', i18nKey: 'skills_filter_all' },
        { value: 'enabled', i18nKey: 'skills_filter_enabled' },
        { value: 'disabled', i18nKey: 'skills_filter_disabled' },
      ],
      value: filter,
      onChange: (v: 'all' | 'enabled' | 'disabled') => setFilter(v),
    })
    return () => select?.destroy?.()
  }, [bodyHtml, view])

  const refreshPage = useCallback(async () => {
    const query = committedMarketQueryRef.current
    await reload({ forceRefresh: true })
    if (stateRef.current.view === 'market' && query) await remoteSearch(query)
  }, [reload, remoteSearch])

  const cancelSkillTransfer = async (skill: SkillItem) => {
    const slug = skillSlug(skill)
    if (!slug) return
    if (await skillAcquisitionStore.cancel(slug)) {
      showToast(t('skills_cancelled_named').replace('{name}', localizeSkillName(skill)))
    }
  }

  const updateAllSkills = async () => {
    const bySlug = new Map(updatableSkills.map(item => [skillSlug(item), item]))
    await skillAcquisitionStore.runBatch([...bySlug.keys()], id => {
      const target = bySlug.get(id)
      return target ? performSkillUpdate(target, t, () => { void refreshPage() }) : Promise.resolve({ ok: false })
    })
  }

  const onSearchInput = (value: string) => {
    setSearch(value)
    if (stateRef.current.view === 'market' && !value.trim() && committedMarketQueryRef.current) {
      void remoteSearch('')
    }
  }

  const header = (
    <PageHeader
      titleKey="skills"
      subtitleKey="skills_subtitle"
      {...(bodyHtml != null ? { bodyHtml } : {})}
      refresh={{ id: 'sk-refresh', titleKey: 'skills_refresh', onClick: refreshPage }}
      search={{ id: 'sk-search-input', placeholderKey: 'search_placeholder', value: search, onInput: onSearchInput }}
      create={{
        btnId: 'sk-create-btn',
        menuId: 'sk-create-menu',
        items: [
          { action: 'upload', labelKey: 'settings_skills_upload', iconHtml: w().klsTopbar.icons.upload },
          { action: 'source', labelKey: 'skills_source_install_btn', iconHtml: w().klsTopbar.icons.install },
          { action: 'via-klaus', labelKey: 'topbar_via_klaus', iconHtml: w().klsTopbar.icons.sparkle },
          { action: 'record', labelKey: 'skills_record_skill', iconHtml: w().klsTopbar.icons.record },
        ],
        onAction: (action) => {
          if (action === 'upload') setModal('upload')
          else if (action === 'source') setModal('source')
          else if (action === 'via-klaus') createViaKlaus()
          else if (action === 'record') recordSkill()
        },
      }}
    />
  )

  if (error != null && !snap) {
    return (
      <div className="sk-section">
        {header}
        <div className="empty-text sk-empty" role="alert">
          <p>{error}</p>
          <button type="button" className="btn-sm" onClick={() => { void reload({ forceRefresh: true }) }}>{t('auth_status_retry')}</button>
        </div>
      </div>
    )
  }
  if (!snap) {
    return (
      <div className="sk-section">
        {header}
        <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
      </div>
    )
  }

  const emptyText = t('no_skills') || 'No skills found'
  const isProjectScope = view === 'installed' && scope !== 'global'
  const visibleLoadError = scopeError || (view === 'market'
    ? [snap.errors.market, snap.errors.builtin].filter(Boolean).join(' · ')
    : snap.errors.installed)
  const pageWarning = [...new Set([loadWarning, visibleLoadError].filter((value): value is string => Boolean(value)))]
    .join(' · ')
  const activeTransferSlug = Object.keys(transferOps).find(id => {
    const op = transferOps[id]
    return op?.phase === 'running' && Boolean(op.progress)
  })
  const activeTransferSkill = activeTransferSlug
    ? (snap.market.find(s => skillSlug(s) === activeTransferSlug) || enrichedInstalled.find(s => skillSlug(s) === activeTransferSlug))
    : undefined
  const showTransferBanner = Boolean(activeTransferSkill && !visibleSkills.some(s => skillSlug(s) === activeTransferSlug))
  const queuedSkillCount = Object.values(transferOps).filter(op => op?.phase === 'queued').length
  const skillTileHtml = (s: SkillItem) => {
    const tile = getSkillBrandTile(s)
    return tile?.kind === 'logo' ? skillLogoImgHtml(tile.src)
      : tile?.kind === 'icon' ? skillRemoteIconHtml(tile.src)
        : tile?.kind === 'emoji' ? skillEmojiGlyphHtml(tile.emoji)
          : skillGlyphSvg(getSkillIconName(s))
  }
  const skillVersionText = (s: SkillItem) => s.hasUpdate && s.version && s.latestVersion
    ? `${s.version} → ${s.latestVersion}`
    : s.version || s.latestVersion || ''

  return (
    <div
      className="sk-section"
      aria-busy={searching || installedContextLoading || actionBusy.size > 0 ? 'true' : 'false'}
      onClick={(e) => {
        const target = e.target as Element
        if (target.closest('[data-skill-update-all]')) { void updateAllSkills(); return }
        const tabBtn = target.closest('[data-skill-tab]') as HTMLElement | null
        if (tabBtn) {
          const next = tabBtn.dataset.skillTab as 'market' | 'installed'
          if (next !== view) switchView(next)
          return
        }
        const catBtn = target.closest('[data-skill-category-tab]') as HTMLElement | null
        if (catBtn) { setCategory(catBtn.dataset.skillCategoryTab || 'all'); return }
        const globalScope = target.closest('[data-sk-scope]')
        if (globalScope) { if (scope !== 'global') switchScope('global'); return }
        const rootScope = target.closest('[data-sk-scope-root]') as HTMLElement | null
        if (rootScope) {
          const root = rootScope.dataset.skScopeRoot || ''
          if (root && root !== scope) switchScope(root)
          return
        }
        const wsScope = target.closest('[data-sk-scope-ws]') as HTMLElement | null
        if (wsScope) {
          const key = WORKSPACE_SCOPE_PREFIX + (wsScope.dataset.skScopeWs || '')
          if (wsScope.dataset.skScopeWs && key !== scope) switchScope(key)
        }
      }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const target = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]')
        const tablist = target?.closest('[role="tablist"]')
        if (!target || !tablist) return
        const tabs = [...tablist.querySelectorAll<HTMLButtonElement>(':scope > [role="tab"]')]
        const index = tabs.indexOf(target)
        if (index < 0 || !tabs.length) return
        event.preventDefault()
        const nextIndex = event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        const nextTab = tabs[nextIndex]
        if (!nextTab) return
        const identity = Object.entries(nextTab.dataset).find(([key]) => [
          'skillTab', 'skillCategoryTab', 'skScope', 'skScopeRoot', 'skScopeWs',
        ].includes(key))
        nextTab.focus()
        nextTab.click()
        if (identity) setTimeout(() => {
          const replacement = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
            .find(button => button.dataset[identity[0]] === identity[1])
          replacement?.focus()
        }, 0)
      }}
    >
      {header}
      {transferBatch && (
        <p className={styles['sk-batch-status']} role="status" data-skill-batch>
          {t(transferBatch.running ? 'skills_batch_progress' : transferBatch.failed ? 'skills_batch_partial' : 'skills_batch_success')
            .replace('{completed}', String(transferBatch.completed))
            .replace('{total}', String(transferBatch.total))
            .replace('{failed}', String(transferBatch.failed))}
        </p>
      )}
      {showTransferBanner && activeTransferSkill && activeTransferSlug && transferOps[activeTransferSlug] && (
        <ExtensionTransferBanner
          itemId={activeTransferSlug}
          name={localizeSkillName(activeTransferSkill)}
          iconHtml={skillTileHtml(activeTransferSkill)}
          operation={transferOps[activeTransferSlug]!}
          queuedCount={queuedSkillCount}
          openLabelKey="plugins_transfer_locate"
          onOpen={view !== 'market' ? () => switchView('market') : undefined}
          onCancel={() => { void cancelSkillTransfer(activeTransferSkill) }}
          bannerAttr="skill-transfer-banner"
          detailAttr="skill-transfer-locate"
          cancelAttr="skill-cancel"
        />
      )}
      {pageWarning && (
        <div className={styles['sk-load-warning']} role="status">
          <span>{pageWarning}</span>
          <button type="button" className="btn-xs" onClick={() => { void refreshPage() }}>{t('auth_status_retry')}</button>
        </div>
      )}
      <div id="sk-grid">
        {installedContextLoading && view === 'installed' ? (
          <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
        ) : visibleSkills.length === 0 && scopeError ? null : visibleSkills.length === 0 ? (
          isProjectScope ? (
            <div className="qc-empty-state">
              <span className="kls-icon-host" dangerouslySetInnerHTML={{ __html: renderLineIcon('folder') }} />
              <p>{t('skills_project_empty')}</p>
            </div>
          ) : (
            <p className="empty-text sk-empty">{emptyText}</p>
          )
        ) : view === 'market' ? (
          <MarketGrid empty={false} emptyText={emptyText}>
            {visibleSkills.map(s => {
              const dirName = String(s.dirName || s.name || '').trim()
              const slug = skillSlug(s)
              const operation = slug ? transferOps[slug] : undefined
              const summary = compactTransferSummary(operation, t)
              const versionText = skillVersionText(s)
              const tile = getSkillBrandTile(s)
              return (
                <div key={dirName || localizeSkillName(s)} className={styles['sk-card-wrap']}>
                  <MarketCard
                    datasets={{
                      name: localizeSkillName(s),
                      'skill-slug': slug,
                      category: getSkillCategory(s),
                      search: getSkillSearchValuesLocal(s).join(' '),
                    }}
                    iconHtml={skillTileHtml(s)}
                    {...(tile?.kind === 'logo' || tile?.kind === 'icon'
                      ? { iconClassName: styles['kls-market-icon-logo'] }
                      : tile?.kind === 'emoji' ? { iconClassName: styles['kls-market-icon-emoji'] } : {})}
                    title={localizeSkillName(s)}
                    subtitle={summary
                      ? <span className={styles['sk-transfer-meta']} data-skill-transfer-meta={slug}>{summary}</span>
                      : (dirName || versionText) ? (
                        <>
                          {dirName && <span className={styles['sk-row-cmd']}>/{dirName}</span>}
                          {s.hasUpdate && versionText && <span className={styles['sk-version']}>{versionText}</span>}
                        </>
                      ) : undefined}
                    badge={<SkillHealthBadge skill={s} />}
                    desc={localizeSkillDescription(s) || dirName}
                    controls={s.source === 'builtin'
                      ? <>
                          <span className="sk-health-badge">{t('skills_builtin_badge')}</span>
                          {s.userInvocable && dirName && (
                            <button className="btn-xs" onClick={() => useSkill(s)}>{t('slash_commands_use')}</button>
                          )}
                        </>
                      : <MarketInstallBtn skill={s} operation={operation} onChanged={() => { void refreshPage() }} onCancel={() => { void cancelSkillTransfer(s) }} />}
                  />
                  <ExtensionInlineProgressBar
                    operation={operation}
                    label={`${localizeSkillName(s)} ${skillBusyLabel(operation, null, t)}`}
                    dataAttr="skill-inline-bar"
                  />
                </div>
              )
            })}
          </MarketGrid>
        ) : (
          <div className={styles['sk-row-grid']}>
            {visibleSkills.map(s => {
              const skillName = localizeSkillName(s)
              const skillDescription = localizeSkillDescription(s)
              const dirName = String(s.dirName || s.name || '').trim()
              const slug = skillSlug(s)
              const operation = scope === 'global' && slug ? transferOps[slug] : undefined
              const transferPending = acquisitionPending(operation)
              const cancellable = canCancelPluginOperation(operation)
              const summary = compactTransferSummary(operation, t)
              const versionText = skillVersionText(s)
              const rowBusy = transferPending || actionBusy.has(`toggle:${dirName}`) || actionBusy.has(`uninstall:${scope}:${dirName}`)
              const tile = getSkillBrandTile(s)
              return (
                <div key={dirName || skillName} className={styles['sk-row-wrap']}>
                  <div
                    className="sk-row"
                    data-skill-key={dirName}
                    data-name={skillName}
                    data-category={getSkillCategory(s)}
                    aria-busy={rowBusy ? 'true' : 'false'}
                  >
                    <button type="button" className={styles['sk-row-open']} aria-label={skillName} disabled={!dirName || rowBusy} onClick={() => openSkillWindow(dirName)}>
                      {tile?.kind === 'logo'
                        ? <span className="kls-icon-host" dangerouslySetInnerHTML={{ __html: skillLogoBrickHtml(tile.src) }} />
                        : tile?.kind === 'icon'
                          ? <span className="kls-icon-host" dangerouslySetInnerHTML={{ __html: skillLogoBrickHtml(tile.src) }} />
                          : tile?.kind === 'emoji'
                            ? <span className="kls-icon-host" dangerouslySetInnerHTML={{ __html: skillEmojiBrickHtml(tile.emoji) }} />
                            : <span className="kls-icon-host" dangerouslySetInnerHTML={{ __html: renderLineIcon(getSkillIconName(s)) }} />}
                      <div className={styles['sk-row-main']}>
                        <div className={styles['sk-row-name-line']}>
                          <span className={styles['sk-row-name']}>{skillName}</span>
                          {dirName && <span className={styles['sk-row-cmd']}>/{dirName}</span>}
                          {!summary && s.hasUpdate && versionText ? <span className={styles['sk-version']}>{versionText}</span> : null}
                          <SkillHealthBadge skill={s} />
                        </div>
                        <div className={styles['sk-row-desc']}>
                          {summary
                            ? <span className={styles['sk-transfer-meta']} data-skill-transfer-meta={slug}>{summary}</span>
                            : (skillDescription || dirName)}
                        </div>
                      </div>
                    </button>
                    <div className={`${styles['sk-row-actions']}${s.hasUpdate || transferPending ? ` ${styles['sk-row-actions-visible']}` : ''}`}>
                      {scope === 'global' && (s.hasUpdate || transferPending) && (
                        <>
                          <button
                            type="button"
                            className="btn-xs"
                            data-skill-update={slug}
                            disabled={transferPending}
                            onClick={() => { void performSkillUpdate(s, t, () => { void refreshPage() }) }}
                          >
                            {transferPending && <span className={styles['sk-spinner']} aria-hidden="true" />}
                            {transferPending
                              ? skillBusyLabel(operation, null, t)
                              : (s.latestVersion ? t('skills_update_to').replace('{version}', s.latestVersion) : (t('skills_update_btn') || '更新'))}
                          </button>
                          {(cancellable || operation?.cancelling) && (
                            <button
                              type="button"
                              className="btn-xs"
                              data-skill-cancel={slug}
                              disabled={!cancellable}
                              onClick={() => { void cancelSkillTransfer(s) }}
                            >
                              {t(operation?.cancelling ? 'plugins_cancelling' : 'plugins_cancel')}
                            </button>
                          )}
                        </>
                      )}
                      {!transferPending && s.userInvocable && dirName && (
                        <button className="btn-xs" disabled={rowBusy} onClick={() => useSkill(s)}>{t('slash_commands_use')}</button>
                      )}
                      {!transferPending && s.source === 'installed' && (
                        <button
                          className="btn-xs qc-btn-danger" aria-label={t('settings_skills_uninstall')}
                          disabled={rowBusy}
                          onClick={() => { void uninstallSkill(s) }}
                          dangerouslySetInnerHTML={{ __html: rawIconHtml('trash', { size: 13 }) }}
                        />
                      )}
                    </div>
                    <button
                      className={`${styles['sk-row-check']} ${s.userEnabled ? 'on' : ''}`}
                      role="switch"
                      aria-checked={s.userEnabled ? 'true' : 'false'}
                      aria-label={`${s.userEnabled ? t('skills_disable_action') : t('skills_enable_action')}: ${skillName}`}
                      disabled={!dirName || rowBusy}
                      onClick={() => { void toggleSkill(s) }}
                      dangerouslySetInnerHTML={{ __html: rawIconHtml('check') }}
                    />
                  </div>
                  <ExtensionInlineProgressBar
                    operation={operation}
                    label={`${skillName} ${skillBusyLabel(operation, null, t)}`}
                    dataAttr="skill-inline-bar"
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div id="sk-scroll-sentinel" className={styles['sk-scroll-sentinel']} ref={sentinelRef} />
      {modal === 'upload' && (
        <ModalPortal>
          <SkillUploadModal onClose={closeSkillModal} onInstalled={() => { void refreshPage() }} />
        </ModalPortal>
      )}
      {modal === 'source' && (
        <ModalPortal>
          <SkillSourceModal onClose={closeSkillModal} onInstalled={() => { void refreshPage() }} />
        </ModalPortal>
      )}
    </div>
  )
}
