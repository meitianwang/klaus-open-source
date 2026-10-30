// MCP connector page (React island).
// market（三页共用双列卡片）/ installed（单列条目卡）双档 + 全局/项目两级
// 作用域 + 内置连接器组卡（归全局档）；详情/状态/表单弹窗见 modals。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { PageHeader } from '../../components/PageHeader'
import { MarketCard, MarketGrid } from '../../components/Market'
import { EntryCard, EntryIconButton, EntryList, EntryMeta, EntryToggle, MCP_GENERIC_SERVER_ICON, SourceBadge, StateIconButton } from '../../components/McpEntry'
import { escHtml } from '../../components/mcpDetailShell'
import { rawIconHtml } from '../../components/Icon'
import { ModalPortal } from '../../components/ModalPortal'
import { strokeGlyph24 } from '../../icons/registry'
import {
  MCP_BUILTIN_CATEGORY, MCP_CATEGORY_ORDER, MCP_PAGE_RELOAD_EVENT, applyPendingConnectorEnables, authorizeMcpServer,
  computeMarketEntryState, connectorIcon, fetchMcpStatus, getMcpStatusResult, hasPendingMcpStatusRound, mcpAuthOk, mcpCategoryLabel,
  mcpLocalizedText, mcpStatusDot, reloadMcpView, showToast,
} from './data'
import type { ConnectorItem, McpBuiltinCapability, McpBuiltinEntry, McpServer, McpStatus } from './data'
import { normalizeProjectMcpData } from './project-status'
import type { ProjectMcpData, ProjectMcpServer } from './project-status'
import { ComputerUseModal, ConnectorGroupModal, McpEditModal, McpJsonModal, McpMarketStateModal, McpProjectDetailModal, McpServerDetailModal } from './modals'
import type { ServerDetailContext } from './modals'
import { formatMcpCommandLine } from './server-form'
import styles from './mcp.module.css'

const w = () => window as any

type McpView = 'market' | 'installed'

// 旧协议归一：settings.js 的浏览器设置跳转仍写 'builtin'（市场档的旧名）。
function normalizeView(value: unknown): McpView {
  return value === 'installed' ? 'installed' : 'market'
}

interface PageData {
  builtin: McpBuiltinEntry[]
  builtinById: Map<string, McpBuiltinEntry>
  needsUvIds: Set<string>
  globalServers: McpServer[]
  statusMap: Map<string, McpStatus>
  /** 本轮真探测是否已返回：首帧先画配置面（毫秒级），此时已启用的服务是「连接中」而不是「连不上」。 */
  statusReady: boolean
  statusError: string | null
  uvMissing: boolean
  connectors: ConnectorItem[]
  // 宿主原生能力卡（电脑操控）：对引擎就是内置 MCP server，
  // 所以开关与配置面长在本页而不是设置页。浏览器能力已归内置插件，在插件页。
  computerUse: { enabled: boolean; available: boolean } | null
  projects: { roots: string[]; labels: Record<string, string> }
  workspaces: Array<{ id: string; name: string; primary: string }>
  projectData: ProjectMcpData | null
  warnings: string[]
}

/** Scope values for workspace tabs; project tabs use the raw root. */
const WORKSPACE_SCOPE_PREFIX = 'ws:'

type ModalState =
  | { kind: 'edit'; server: McpServer | null }
  | { kind: 'json' }
  | { kind: 'market'; entry: McpBuiltinEntry; initialStatus?: McpStatus }
  | { kind: 'connector-group'; groupId: string }
  | { kind: 'native-capability'; capability: 'computerUse' }
  | { kind: 'server-detail'; ctx: ServerDetailContext }
  | { kind: 'project-detail'; server: ProjectMcpServer }

export function McpPage() {
  const t = useT()
  const [data, setData] = useState<PageData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [view, setView] = useState<McpView>(() => normalizeView(w().mcpServersView))
  const [scope, setScope] = useState('global')
  // 市场档的二级分类（'all' / 'builtin' / 目录分类 id）。切档不清空：
  // 回到市场档时还在刚才那个分类，分类已不存在时由 activeCategory 回落。
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState(() => String(w().mcpSearch ?? ''))
  const [modal, setModal] = useState<ModalState | null>(null)
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  const busyKeysRef = useRef(new Set<string>())
  const seqRef = useRef(0)
  const stateRef = useRef({ view, scope, data })
  stateRef.current = { view, scope, data }

  const runBusy = async <T,>(key: string, action: () => Promise<T>): Promise<T | undefined> => {
    if (busyKeysRef.current.has(key)) return undefined
    busyKeysRef.current.add(key)
    setBusyKeys(new Set(busyKeysRef.current))
    try { return await action() }
    finally {
      busyKeysRef.current.delete(key)
      setBusyKeys(new Set(busyKeysRef.current))
    }
  }

  const reload = useCallback(async (over?: { view?: McpView; scope?: string; refreshStatus?: boolean; resetScroll?: boolean }) => {
    const seq = ++seqRef.current
    const curView = over?.view ?? stateRef.current.view
    let curScope = over?.scope ?? stateRef.current.scope
    try {
      const appliedPendingConnectors = await applyPendingConnectorEnables()
      // 打开页面/改完配置才重探；搜索、切档、切作用域只是重渲染，用上一轮结果就行。
      const statusRound = over?.refreshStatus || !getMcpStatusResult() || hasPendingMcpStatusRound() ? fetchMcpStatus() : null
      const k = w().klaus
      const settingsApi = w().settingsApi
      const [servers, builtin, connectorItems, projectsResult, workspacesResult, uvResult, computerUseResult] = await Promise.all([
        k.mcp.list(),
        k.mcp.builtinList(),
        k.connectors.list(),
        Promise.resolve(k.projects?.list?.())
          .then((value: any) => ({ value, error: '' }))
          .catch(() => ({ value: null, error: t('mcp_projects_load_failed') })),
        Promise.resolve(k.workspaces?.list?.())
          .then((value: any) => ({ value, error: '' }))
          .catch(() => ({ value: null, error: '' })),
        (k?.mcp?.uvCheck ? k.mcp.uvCheck() : Promise.resolve(null))
          .then((value: any) => ({ value, error: '' }))
          .catch(() => ({ value: null, error: t('mcp_uv_check_failed') })),
        Promise.resolve(settingsApi?.computerUse?.get?.())
          .then((value: any) => ({ value, error: '' }))
          .catch(() => ({ value: null, error: t('mcp_computer_use_load_failed') })),
      ])
      if (!Array.isArray(servers) || !Array.isArray(builtin) || !Array.isArray(connectorItems)) throw new Error(t('mcp_load_failed'))
      const projectsState = projectsResult.value
      const uvAvailability = uvResult.value
      const computerUseCfg = computerUseResult.value
      const invalidProjects = projectsState != null && (typeof projectsState !== 'object' || Array.isArray(projectsState))
      const warnings = [projectsResult.error, invalidProjects ? t('mcp_projects_load_failed') : '', uvResult.error, computerUseResult.error].filter(Boolean)
      const uvMissing = uvAvailability?.available === false
      const statusResult = getMcpStatusResult()
      const statusMap = new Map<string, McpStatus>((statusResult?.rows || []).map(s => [s.name, s]))
      // klaus 引擎的 needs-auth 合进 statusMap（覆盖为 needs-auth 态，让状态点变黄并显示【授权】按钮）。
      for (const a of statusResult?.needsAuth || []) {
        statusMap.set(a.name, { name: a.name, status: 'needs-auth', toolCount: 0, klausNeedsAuth: true })
      }

      // 项目作用域 tab 数据源：侧栏项目注册表（同技能/快捷指令页），与当前会话解耦。
      let projects = stateRef.current.data?.projects ?? { roots: [], labels: {} }
      if (projectsState && typeof projectsState === 'object' && !Array.isArray(projectsState)) {
        const roots = Array.isArray(projectsState.roots)
          ? projectsState.roots.map((root: any) => (typeof root === 'string' ? root : root?.path)).filter((root: unknown): root is string => typeof root === 'string' && !root.startsWith('ssh://'))
          : []
        projects = {
          roots: [...new Set<string>(roots)],
          labels: projectsState.labels && typeof projectsState.labels === 'object' ? projectsState.labels : {},
        }
      }
      // 选中的项目/工作空间被移除时回退到全局档。
      const workspaces = workspacesResult.value && typeof workspacesResult.value === 'object'
        ? (Array.isArray((workspacesResult.value as any)?.workspaces) ? (workspacesResult.value as any).workspaces : [])
            .map((ws: any) => ({
              id: String(ws?.id || ''),
              name: String(ws?.name || ''),
              roots: Array.isArray(ws?.roots) ? ws.roots.filter((root: unknown): root is string => typeof root === 'string') : [],
            }))
            .filter((ws: { id: string; roots: string[] }) => !!ws.id && ws.roots.length > 0)
            .map((ws: { id: string; name: string; roots: string[] }) => ({ id: ws.id, name: ws.name || ws.roots[0]!.split(/[\\/]/).filter(Boolean).pop() || ws.roots[0]!, primary: ws.roots[0]! }))
        : stateRef.current.data?.workspaces ?? []
      if (curScope !== 'global'
        && !projects.roots.includes(curScope)
        && !(curScope.startsWith(WORKSPACE_SCOPE_PREFIX) && workspaces.some((ws: { id: string }) => WORKSPACE_SCOPE_PREFIX + ws.id === curScope))) curScope = 'global'

      // 全局档 = ~/.klaus/.mcp.json 全部条目（含从市场安装落盘的）。
      // 插件贡献的 MCP server 不在这里列：它们由引擎按插件账本加载，展示与启停
      // 都归插件页（详情里的 MCP 贡献行），MCP 页只摆用户自己能编辑的条目。
      const globalServers: McpServer[] = [...servers]

      // 项目作用域档：按选中的项目根现拉 <root>/.klaus/mcp.json 与本地私有声明，
      // 与当前会话解耦；user/plugin 作用域已在全局档展示，只留 project/local。
      let projectData: ProjectMcpData | null = null
      if (curView === 'installed' && curScope !== 'global') {
        const isWorkspace = curScope.startsWith(WORKSPACE_SCOPE_PREFIX)
        const pstatus = isWorkspace
          ? await k.mcp.sessionStatus(undefined, undefined, curScope.slice(WORKSPACE_SCOPE_PREFIX.length))
          : await k.mcp.sessionStatus(undefined, curScope)
        const normalized = normalizeProjectMcpData(pstatus, isWorkspace ? '' : curScope)
        if (!normalized) throw new Error(t('mcp_load_failed'))
        projectData = {
          ...normalized,
          servers: normalized.servers.filter(s => s.scope === 'project' || s.scope === 'local'),
        }
      }

      if (seq !== seqRef.current) return
      setLoadError('')
      setScope(curScope)
      setData({
        builtin,
        builtinById: new Map(builtin.map((b: McpBuiltinEntry) => [b.id, b])),
        // uvx 类服务的失败诊断需要知道行是否依赖 uv。
        needsUvIds: new Set(builtin.filter((b: McpBuiltinEntry) => b.needsUv).map((b: McpBuiltinEntry) => b.id)),
        globalServers,
        statusMap,
        statusReady: !!statusResult,
        statusError: statusResult?.error || null,
        uvMissing,
        connectors: connectorItems,
        computerUse: computerUseCfg
          ? {
              enabled: computerUseCfg.enabled !== false,
              available: computerUseCfg.availableOnThisPlatform !== false,
            }
          : null,
        projects,
        workspaces,
        projectData,
        warnings,
      })
      // 档/作用域切换：与本次渲染同一轮归零滚动，否则旧滚动位置会在新档内容上
      // 被夹回或错位（探测回来的补渲不带此位，不能把用户的滚动位置摸掉）。
      if (over?.resetScroll) w().klsPageViews.scrollViewToTop('mcp-view')
      // 本次画的是探测前的状态面（首开时干净为空）：这一轮探测回来后原地补渲一次，
      // 补渲不带 refreshStatus，不会再拉起一轮。
      if (statusRound) {
        void statusRound.then(() => {
          if (seq !== seqRef.current) return
          void reload()
        })
      }
      if (appliedPendingConnectors) showToast(t('enabled'))
    } catch (err: any) {
      if (seq !== seqRef.current) return
      if (stateRef.current.data) showToast(`${t('toast_error_prefix')}${err?.message || err}`)
      else setLoadError(err?.message || t('mcp_load_failed'))
    }
  }, [t])

  useEffect(() => { void reload({ refreshStatus: true }) }, [])

  // 跨文件 reload 协议：页面进入（onShow）、chat.js 项目级 MCP 弹窗提交、
  // mcp:status:updated 推送都经此事件进来；进入时同步跳转协议写下的全局档位/搜索词。
  useEffect(() => {
    const onReload = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.syncGlobals) {
        const nextView = normalizeView(w().mcpServersView)
        if (nextView !== stateRef.current.view) setView(nextView)
        const nextSearch = String(w().mcpSearch ?? '')
        const input = document.getElementById('mcp-search-input') as HTMLInputElement | null
        if (input && input.value !== nextSearch) {
          input.value = nextSearch
          input.dispatchEvent(new Event('input')) // 经 PageHeader 的监听回灌 setSearch
        }
      }
      void reload({ refreshStatus: !!detail.refreshStatus, view: normalizeView(w().mcpServersView) })
    }
    window.addEventListener(MCP_PAGE_RELOAD_EVENT, onReload)
    return () => window.removeEventListener(MCP_PAGE_RELOAD_EVENT, onReload)
  }, [reload])

  const switchView = (next: McpView) => {
    w().mcpServersView = next
    setView(next)
    void reload({ view: next, resetScroll: true })
  }
  const switchScope = (next: string) => {
    setScope(next)
    void reload({ scope: next, resetScroll: true })
  }

  /** 市场状态弹窗（四态原地切换）：打开前读取最新目录与可用状态。 */
  const openMarketStateModal = async (builtinId: string) => {
    await runBusy(`market:${builtinId}`, async () => {
      try {
        const [listResult, statusResult] = await Promise.allSettled([
          w().klaus.mcp.builtinList(),
          w().klaus.mcp.status(),
        ])
        if (listResult.status !== 'fulfilled' || !Array.isArray(listResult.value)) throw new Error(t('mcp_load_failed'))
        const list = listResult.value
        const statuses = statusResult.status === 'fulfilled' && Array.isArray(statusResult.value) ? statusResult.value : []
        const entry = (list as McpBuiltinEntry[]).find(x => x.id === builtinId)
        if (!entry) throw new Error(t('mcp_load_failed'))
        const initialStatus = (statuses as McpStatus[]).find(s => s.name === builtinId)
        setModal({ kind: 'market', entry, ...(initialStatus ? { initialStatus } : {}) })
      } catch (error: any) {
        showToast(error?.message || t('mcp_load_failed'))
      }
    })
  }

  /**
   * 行尾态度图标动作：install = 直装（需要采集 env 的条目仍走状态弹窗采集），
   * 其余态与卡体点击同路 → 状态弹窗（启用/断开/诊断都在弹窗里）。
   */
  const handleMarketAction = async (id: string, state: string) => {
    if (!id) return
    if (state === 'install') {
      await runBusy(`market:${id}`, async () => {
        try {
          const list = await w().klaus.mcp.builtinList()
          if (!Array.isArray(list)) throw new Error(t('mcp_load_failed'))
          const entry = (list as McpBuiltinEntry[]).find(x => x.id === id)
          if (!entry) throw new Error(t('mcp_load_failed'))
          // Credentialed entries must stay in the state dialog so installation
          // cannot bypass their authorization or device-login path.
          if ((entry.envKeys || []).length || entry.auth === 'oauth' || entry.deviceAuth) {
            setModal({ kind: 'market', entry })
            return
          }
          const result = await w().klaus.mcp.builtinInstall(id, {})
          if (result?.ok !== true) throw new Error(result?.error || t('settings_failed'))
          showToast(t('mcp_installed_toast'))
          reloadMcpView()
        } catch (error: any) {
          showToast(error?.message || t('settings_failed'))
        }
      })
      return
    }
    void openMarketStateModal(id)
  }

  /** 条目卡头点击路由：市场装的目录条目 = 与市场同一张四态状态弹窗，自建/插件 = 配置详情弹窗。 */
  const openServerDetail = (name: string) => {
    const d = stateRef.current.data
    if (!d) return
    if (d.builtinById.has(name)) { void openMarketStateModal(name); return }
    const server = d.globalServers.find(s => s.name === name)
    if (!server) return
    setModal({
      kind: 'server-detail',
      ctx: {
        server,
        ...(d.statusMap.get(name) ? { status: d.statusMap.get(name)! } : {}),
        statusReady: d.statusReady,
        catalog: d.builtinById.get(name) || null,
        uvMissing: d.uvMissing,
        servers: d.globalServers,
      },
    })
  }

  /** 全局档启停：OAuth server 开启时挂授权链路（授权成功才算启用）。 */
  const toggleServer = async (server: McpServer, checked: boolean, klausNeedsAuth: boolean) => {
    const name = server.name
    await runBusy(`server:${name}`, async () => {
      try {
        // Keep OAuth servers enabled while the first live session performs authorization.
        if (checked && (server.config?.oauth != null || klausNeedsAuth) && typeof w().klaus.mcp.klausAuthenticate === 'function') {
          const enabled = await w().klaus.mcp.toggle(name, true)
          if (enabled?.ok !== true) throw new Error(enabled?.error || t('settings_failed'))
          const status = await authorizeMcpServer(name)
          if (status === null) return
          setTimeout(() => reloadMcpView(), 300)
          return
        }
        const result = await w().klaus.mcp.toggle(name, checked)
        if (result?.ok !== true) throw new Error(result?.error || t('settings_failed'))
        showToast(checked ? t('enabled') : t('disabled'))
        reloadMcpView()
      } catch (error: any) {
        showToast(error?.message || t('settings_failed'))
        reloadMcpView()
      }
    })
  }

  const editServer = async (name: string) => {
    await runBusy(`server:${name}`, async () => {
      try {
        const list = await w().klaus.mcp.list()
        if (!Array.isArray(list)) throw new Error(t('mcp_load_failed'))
        const entry = (list as McpServer[]).find(x => x.name === name)
        if (!entry) throw new Error(t('mcp_load_failed'))
        setModal({ kind: 'edit', server: entry })
      } catch (error: any) {
        showToast(error?.message || t('mcp_load_failed'))
      }
    })
  }

  const deleteServer = async (name: string) => {
    await runBusy(`server:${name}`, async () => {
      if (!(await w().klausDialog.confirm({
        message: t('settings_mcp_delete_confirm') + ': ' + name + '?',
        danger: true,
      }))) return
      try {
        const result = await w().klaus.mcp.remove(name)
        if (result !== true && result?.ok !== true) throw new Error(result?.error || t('settings_failed'))
        showToast(t('settings_deleted') || 'Deleted')
        reloadMcpView()
      } catch (error: any) {
        showToast(error?.message || t('settings_failed'))
      }
    })
  }

  const authorizeServer = async (name: string) => {
    // klaus 引擎 MCP OAuth：点授权 → 引擎打开授权 URL、换 token 存钥匙串、后续会话连接自动带。
    // 授权成功即「启用」该 server（置 pref on），与「授权成功才进入开启态」语义一致。
    await runBusy(`server:${name}`, async () => {
      try {
        const status = await authorizeMcpServer(name)
        if (status === null) return
        if (mcpAuthOk(status)) {
          const result = await w().klaus.mcp.toggle(name, true)
          if (result?.ok !== true) throw new Error(result?.error || t('settings_failed'))
        }
        reloadMcpView()
      } catch (error: any) {
        showToast(error?.message || t('settings_failed'))
      }
    })
  }

  /** 项目/本地 MCP 行动作（作用域档的项目根即当前 tab）。 */
  const handleProjectAction = async (action: 'add' | 'edit' | 'toggle' | 'del', name: string, rowScope: string, enabled?: boolean) => {
    const cwd = stateRef.current.scope !== 'global' ? stateRef.current.scope : null
    if (!cwd) { showToast(t('mcp_session_card_no_workdir')); return }
    const busyKey = action === 'add' ? `project:${cwd}:add` : `project:${cwd}:${name}`
    await runBusy(busyKey, async () => {
      const api = rowScope === 'local' ? w().klaus.mcp?.local : w().klaus.mcp?.project
      if (action === 'add') {
        w().openProjectMcpModal(cwd, null, 'project')
        return
      }
      if (action === 'edit') {
        const list = await api?.list?.(cwd)
        if (!Array.isArray(list)) throw new Error(t('mcp_load_failed'))
        const entry = list.find((x: any) => x.name === name)
        if (!entry) throw new Error(t('mcp_load_failed'))
        w().openProjectMcpModal(cwd, entry, rowScope || 'project')
        return
      }
      if (action === 'toggle') {
        const res = await api?.toggle?.(cwd, name, enabled === true)
        if (res?.ok !== true) throw new Error(res?.error || t('settings_failed'))
        showToast(enabled ? t('enabled') : t('disabled'))
        reloadMcpView()
        return
      }
      const ok = await w().klausDialog.confirm({
        message: (rowScope === 'local' ? t('mcp_local_delete_confirm') : t('mcp_project_delete_confirm')).replace('{name}', name),
        confirmText: t('remove'),
        danger: true,
      })
      if (!ok) return
      const res = await api?.remove?.(cwd, name)
      if (res?.ok === true) { showToast(t('mcp_project_needs_new_session')); reloadMcpView() }
      else throw new Error(res?.error || t('settings_failed'))
    })
  }

  // ---- 页头（tab 行走 bodyHtml 保持吸顶结构，点击容器委托，同插件页） ----
  const esc = escHtml
  const filterTextMatches = w().filterTextMatches as (q: string, hay: unknown[]) => boolean

  // 宿主原生能力启停：对引擎就是注册/注销一个内置 MCP server（computer-use），
  // 所以开关长在本页而不是设置页。浏览器能力已归内置插件，开关在插件页。
  const toggleNativeCapability = async (capability: 'computerUse', checked: boolean) => {
    await runBusy(`native:${capability}`, async () => {
      const settingsApi = w().settingsApi
      const call = settingsApi?.computerUse?.setEnabled?.(checked)
      const res = await Promise.resolve(call).catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
      if (!res?.ok) {
        showToast(res?.error || t('settings_failed'))
        return
      }
      showToast(t('settings_saved'))
      await reload({ refreshStatus: true })
    })
  }

  // ---- 过滤与分类 ----
  // 分类 tab 行与市场网格必须同一个事实源（tab 上的计数就是网格里的条目数），
  // 所以这一段排在页头之前算；安装状态只改行尾态度图标，不从目录移除。
  const visibleMarket = (data?.builtin ?? []).filter(b =>
    filterTextMatches(search, [b.id, b.nameEn, b.nameZh, b.descEn, b.descZh]),
  )
  const visibleGlobalServers = (data?.globalServers ?? []).filter(s => {
    const catalog = data?.builtinById.get(s.name)
    return filterTextMatches(search, [
      s.name, s.config?.type, s.config?.command, s.config?.url, (s.config?.args || []).join(' '),
      catalog?.nameEn, catalog?.nameZh, catalog?.descEn, catalog?.descZh,
    ])
  })
  const availableConnectors = (data?.connectors ?? []).filter(c => c.availableOnThisPlatform)
  const connectorGroupTitles: Record<string, string> = { macos: t('connectors_group_macos') }
  const visibleConnectors = availableConnectors.filter(c =>
    filterTextMatches(search, [c.id, c.nameEn, c.nameZh, c.descEn, c.descZh, c.group, connectorGroupTitles[c.group]]),
  )
  // 内置连接器组卡：与全局 server 同一套条目卡组件，点卡弹连接器详情弹窗。
  // 组由搜索命中的连接器聚出来——搜「照片」要能把 macOS 组捞出来。
  const connectorGroups = new Map<string, ConnectorItem[]>()
  for (const c of visibleConnectors) {
    if (!connectorGroups.has(c.group)) connectorGroups.set(c.group, [])
    connectorGroups.get(c.group)!.push(c)
  }

  // 宿主原生能力卡：对引擎就是两个内置 MCP server，所以与 server 卡同列呈现：
  // 开关即服务开关，点卡进配置弹窗（原设置页正文）。
  interface NativeCapabilityCard {
    capability: 'computerUse'
    title: string
    desc: string
    iconName: string
    enabled: boolean
    serverName: string
    disabled?: boolean
  }
  const nativeCapabilityCards: NativeCapabilityCard[] = []
  if (data?.computerUse && data.computerUse.available) {
    nativeCapabilityCards.push({
      capability: 'computerUse',
      title: t('computer_use_title'),
      desc: t('computer_use_desc'),
      iconName: 'browser-use-logo-5',
      enabled: data.computerUse.enabled,
      serverName: 'computer-use',
    })
  }
  const visibleNativeCards = nativeCapabilityCards.filter(card =>
    filterTextMatches(search, [card.capability, card.serverName, card.title, card.desc]),
  )

  /**
   * 内置档条目：随客户端出厂的服务，只给启停，没有安装/卸载入口——它们不在
   * `.mcp.json` 里，卸载对它们无意义。来源作为字段而不是靠 id 猜：今天两个原生
   * 能力卡与 macOS 连接器组都是客户端一级能力，引擎侧内置 server 出现时只需把
   * origin 给成 'engine'，这一档的呈现不用再改。
   */
  const builtinCapabilities: McpBuiltinCapability[] = [
    ...visibleNativeCards.map(card => ({
      key: card.capability,
      origin: 'client' as const,
      title: card.title,
      desc: card.desc,
      iconHtml: connectorIcon(card.capability) || rawIconHtml(card.iconName),
      serverName: card.serverName,
      enabled: card.enabled,
      onToggle: (checked: boolean) => { void toggleNativeCapability(card.capability, checked) },
      onOpen: () => setModal({ kind: 'native-capability', capability: card.capability }),
    })),
    // 连接器组不给主开关：逐个连接器的开关在组弹窗里（且各自要过系统权限预检），
    // 一个聚合开关会把「全开/全关」这种没人要的动作摆到最显眼的位置。
    ...[...connectorGroups.keys()].map(groupId => ({
      key: `connectors:${groupId}`,
      origin: 'client' as const,
      title: connectorGroupTitles[groupId] || groupId,
      desc: t('mcp_connectors_group_desc'),
      iconHtml: connectorIcon('group:' + groupId),
      serverName: '',
      onOpen: () => setModal({ kind: 'connector-group', groupId }),
    })),
  ]
  // 一级 tab 上的市场计数是「这一档共有多少条」，不随搜索变，所以内置那部分也取未过滤的量。
  const builtinCapabilityTotal = nativeCapabilityCards.length + new Set(availableConnectors.map(c => c.group)).size
  const marketTotal = (data?.builtin.length ?? 0) + builtinCapabilityTotal

  // 分类分组：目录条目按 category 落档（缺项/未知值归 other），内置自成一档置首。
  const catalogGroups = new Map<string, McpBuiltinEntry[]>()
  for (const b of visibleMarket) {
    const key = b.category || 'other'
    if (!catalogGroups.has(key)) catalogGroups.set(key, [])
    catalogGroups.get(key)!.push(b)
  }
  const orderedCatalogKeys = [
    ...MCP_CATEGORY_ORDER.filter(key => catalogGroups.has(key)),
    ...[...catalogGroups.keys()].filter(key => key !== 'other' && !MCP_CATEGORY_ORDER.includes(key)).sort(),
    ...(catalogGroups.has('other') ? ['other'] : []),
  ]
  const categoryTabs = [
    { key: 'all', label: t('mcp_category_all'), count: visibleMarket.length + builtinCapabilities.length },
    ...(builtinCapabilities.length
      ? [{ key: MCP_BUILTIN_CATEGORY, label: mcpCategoryLabel(MCP_BUILTIN_CATEGORY), count: builtinCapabilities.length }]
      : []),
    ...orderedCatalogKeys.map(key => ({ key, label: mcpCategoryLabel(key), count: catalogGroups.get(key)!.length })),
  ]
  // 搜索把当前分类筛空时回落到「全部」：留一个选中却什么也不显示的 tab，
  // 比切回全部更难懂（用户会以为搜索没命中任何东西）。
  const activeCategory = categoryTabs.some(tab => tab.key === category) ? category : 'all'
  // 分类行只属于市场档：已安装档的二级已被作用域行占掉，再叠一层就成三级 tab；
  // 既然不渲染，分类筛选在该档也一并不生效。
  const showCategoryTabs = view === 'market' && categoryTabs.length > 1
  const categoryBuiltinCards = activeCategory === 'all' || activeCategory === MCP_BUILTIN_CATEGORY ? builtinCapabilities : []
  const categoryMarketEntries = activeCategory === MCP_BUILTIN_CATEGORY
    ? []
    : activeCategory === 'all' ? visibleMarket : (catalogGroups.get(activeCategory) ?? [])

  const tabsBodyHtml = (() => {
    if (!data) return undefined
    /**
     * 作用域 tab 组：已安装档下自占一行的二级 tab（.qc-scope-bar，同快捷命令/
     * Hooks 页），全局 + 各项目平铺，项目多时由 qc-scope-seg 自己横向滚动；
     * 市场档无此行（市场是全局目录，不存在项目级市场）。
     */
    const scopeBar = view === 'installed'
      ? `
        <div class="qc-scope-bar">
          <div class="qc-scope-seg" role="tablist" aria-label="${esc(t('mcp_tab_installed'))}">
            <button class="qc-scope-tab ${scope === 'global' ? 'active' : ''}" role="tab" aria-selected="${scope === 'global'}" data-mcp-scope="global">${esc(t('slash_commands_scope_global'))}</button>
            ${data.projects.roots.map(root => {
              const label = data.projects.labels?.[root] || root.split(/[\\/]/).filter(Boolean).pop() || root
              const active = scope === root
              return `<button class="qc-scope-tab qc-scope-tab-project ${active ? 'active' : ''}" role="tab" aria-selected="${active}" data-mcp-scope-root="${esc(root)}"><span>${esc(label)}</span></button>`
            }).join('')}
            ${(data.workspaces ?? []).map(ws => {
              const key = WORKSPACE_SCOPE_PREFIX + ws.id
              const active = scope === key
              return `<button class="qc-scope-tab qc-scope-tab-project ${active ? 'active' : ''}" role="tab" aria-selected="${active}" data-mcp-scope-ws="${esc(ws.id)}"><span>${esc(ws.name)}</span></button>`
            }).join('')}
          </div>
        </div>`
      : ''
    return `<div class="sk-tabbar">
          <div class="sk-tabs">
            <button class="sk-tab ${view === 'market' ? 'active' : ''}" data-mcp-tab="market">${t('mcp_tab_market')}${marketTotal > 0 ? ` <span class="sk-tab-count">${marketTotal}</span>` : ''}</button>
            <button class="sk-tab ${view === 'installed' ? 'active' : ''}" data-mcp-tab="installed">${t('mcp_tab_installed')}${data.globalServers.length > 0 ? ` <span class="sk-tab-count">${data.globalServers.length}</span>` : ''}</button>
          </div>
        </div>
        ${scopeBar}
        ${showCategoryTabs ? `
        <div class="sk-category-tabs" role="tablist" aria-label="${esc(t('mcp_tab_market'))}">
          ${categoryTabs.map(tab => `<button class="qc-scope-tab ${activeCategory === tab.key ? 'active' : ''}" role="tab" aria-selected="${activeCategory === tab.key}" data-mcp-category-tab="${esc(tab.key)}">${esc(tab.label)} <span class="qc-scope-tab-count">${tab.count}</span></button>`).join('')}
        </div>` : ''}`
  })()

  // 页头声明一处，冷启动壳与正常渲染共用（同其他页）。
  const header = (
    <PageHeader
      titleKey="mcp"
      subtitleKey="mcp_subtitle"
      {...(tabsBodyHtml != null ? { bodyHtml: tabsBodyHtml } : {})}
      refresh={{
        id: 'mcp-refresh', titleKey: 'settings_mcp_reconnect',
        onClick: async () => {
          await runBusy('refresh', async () => {
            try {
              await w().klaus.mcp.reconnect()
              showToast(t('mcp_status_refreshed'))
              reloadMcpView()
            } catch (error: any) {
              showToast(error?.message || t('settings_failed'))
            }
          })
        },
      }}
      search={{
        id: 'mcp-search-input', placeholderKey: 'search_placeholder', value: search,
        onInput: (value) => {
          w().mcpSearch = value
          setSearch(value)
        },
      }}
      create={{
        btnId: 'mcp-add-btn',
        menuId: 'mcp-add-menu',
        items: [
          { action: 'manual', labelKey: 'mcp_add_manual', iconHtml: w().klsTopbar.icons.form },
          { action: 'json', labelKey: 'mcp_add_json', iconHtml: w().klsTopbar.icons.code },
        ],
        onAction: (action) => {
          if (action === 'manual') setModal({ kind: 'edit', server: null })
          else if (action === 'json') setModal({ kind: 'json' })
        },
      }}
    />
  )

  const modalNode = modal == null ? null : (
    <ModalPortal>
      {modal.kind === 'edit' ? <McpEditModal existing={modal.server} onClose={() => setModal(null)} />
        : modal.kind === 'json' ? <McpJsonModal onClose={() => setModal(null)} />
          : modal.kind === 'market' ? <McpMarketStateModal entry={modal.entry} {...(modal.initialStatus ? { initialStatus: modal.initialStatus } : {})} onClose={() => setModal(null)} />
            : modal.kind === 'native-capability'
              // 弹窗内的主开关/配置改动不实时回写卡片：关闭时重拉一轮，卡上开关态与
              // 状态点（启用会注册/注销 computer-use 内置 server）一并对齐。
              ? <ComputerUseModal enabled={!!data?.computerUse?.enabled} onClose={() => { setModal(null); void reload({ refreshStatus: true }) }} />
              : modal.kind === 'server-detail' ? <McpServerDetailModal ctx={modal.ctx} onClose={() => setModal(null)} />
                : modal.kind === 'project-detail' ? <McpProjectDetailModal server={modal.server} onClose={() => setModal(null)} />
                  : <ConnectorGroupModal groupId={modal.groupId} onClose={() => setModal(null)} />}
    </ModalPortal>
  )

  // 冷启动壳（标题 + 居中品牌标加载态）；数据面读盘毫秒级，状态点等探测回来再补。
  if (!data) {
    return (
      <div className="mcp-section">
        {header}
        {loadError ? (
          <div className="empty-text sk-empty" role="alert">
            <p>{loadError}</p>
            <button type="button" className="btn-sm" onClick={() => { void reload({ refreshStatus: true }) }}>{t('mcp_retry')}</button>
          </div>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
        )}
        {modalNode}
      </div>
    )
  }

  const scopeIsProject = scope !== 'global'
  const projectServers = (data.projectData?.servers ?? []).filter(server => (
    filterTextMatches(search, [server.name, server.scope, server.transport])
  ))

  return (
    <div
      className="mcp-section"
      onClick={(e) => {
        const target = e.target as Element
        const tabBtn = target.closest('[data-mcp-tab]') as HTMLElement | null
        if (tabBtn) {
          const next = normalizeView(tabBtn.dataset.mcpTab)
          if (next !== view) switchView(next)
          return
        }
        // 分类切换只是重渲染（目录已在手上），不重拉也不重探。
        const catBtn = target.closest('[data-mcp-category-tab]') as HTMLElement | null
        if (catBtn) { setCategory(catBtn.dataset.mcpCategoryTab || 'all'); return }
        const globalScope = target.closest('[data-mcp-scope]')
        if (globalScope) { if (scope !== 'global') switchScope('global'); return }
        const rootScope = target.closest('[data-mcp-scope-root]') as HTMLElement | null
        if (rootScope) {
          const root = rootScope.dataset.mcpScopeRoot || ''
          if (root && root !== scope) switchScope(root)
          return
        }
        const wsScope = target.closest('[data-mcp-scope-ws]') as HTMLElement | null
        if (wsScope) {
          const key = WORKSPACE_SCOPE_PREFIX + (wsScope.dataset.mcpScopeWs || '')
          if (wsScope.dataset.mcpScopeWs && key !== scope) switchScope(key)
        }
      }}
    >
      {header}
      {data.statusError && (
        <div className="empty-text sk-empty" role="status">
          <span>{t('mcp_status_load_failed')}</span>{' '}
          <button type="button" className="btn-sm" onClick={() => { void reload({ refreshStatus: true }) }}>{t('mcp_retry')}</button>
        </div>
      )}
      {data.warnings.map(warning => (
        <div className="empty-text sk-empty" role="status" key={warning}>
          <span>{warning}</span>{' '}
          <button type="button" className="btn-sm" onClick={() => { void reload() }}>{t('mcp_retry')}</button>
        </div>
      ))}
      {view === 'market' ? (
        <div data-mcp-panel="market">
          {/*
            市场档条目：走三页市场共用的双列卡片组件——市场是逸而发现场景，
            卡片给得起密度；行尾四态态度图标（+ 直装 / 其余态弹状态弹窗）。
            内置档条目排在目录条目之前：它们是用户已经拥有的那一档，混排到
            目录后面就等于被埋掉。
          */}
          <MarketGrid empty={!categoryBuiltinCards.length && !categoryMarketEntries.length} emptyText={t('mcp_search_empty')}>
            {categoryBuiltinCards.map(cap => (
              <MarketCard
                key={`builtin:${cap.key}`}
                cardKey={`builtin:${cap.key}`}
                datasets={{ 'builtin-key': cap.key, 'builtin-origin': cap.origin }}
                iconHtml={cap.iconHtml}
                title={cap.title}
                desc={cap.desc}
                onOpen={cap.onOpen}
                // 行尾只有启停开关：内置不给安装/卸载态度图标（没有可卸载的东西），
                // 状态点等语义在点开的配置弹窗里。
                controls={cap.onToggle
                  ? (
                      <EntryToggle
                        checked={!!cap.enabled}
                        title={cap.enabled ? t('enabled') : t('disabled')}
                        disabled={busyKeys.has(`native:${cap.key}`)}
                        onChange={cap.onToggle}
                      />
                    )
                  : undefined}
              />
            ))}
            {categoryMarketEntries.map(b => {
              const text = mcpLocalizedText(b)
              const status = data.statusMap.get(b.id)
              const state = computeMarketEntryState(b, status)
              // 品牌 tile 优先于目录描边字形：出厂自带成品方砖的连接器（如 GitHub）
              // 用官方 mark 呈现，目录 iconSvg 只作无 tile 时的兜底。
              const brandLogo = connectorIcon(b.id)
              const label = state === 'install' ? t('mcp_market_install')
                : state === 'off' ? t('mcp_market_enable')
                  : state === 'failed' ? t('mcp_detail_error_title') : t('mcp_market_disconnect')
              return (
                <MarketCard
                  key={b.id}
                  cardKey={`mkt:${b.id}`}
                  datasets={{ 'market-id': b.id, 'market-state': state }}
                  iconHtml={brandLogo || strokeGlyph24(b.iconSvg || MCP_GENERIC_SERVER_ICON, 20)}
                  title={text.name}
                  desc={text.desc}
                  onOpen={() => { void openMarketStateModal(b.id) }}
                  controls={
                    <StateIconButton
                      state={state} label={label}
                      disabled={busyKeys.has(`market:${b.id}`)}
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleMarketAction(b.id, state)
                      }}
                    />
                  }
                />
              )
            })}
          </MarketGrid>
        </div>
      ) : scopeIsProject ? (
        <div data-mcp-panel="installed">
          {/* 项目作用域档：行内标题栏（cwd + 添加）+ 条目卡竖排。 */}
          <div className="mcp-project-scope" data-mcp-tab-project>
            <div className={styles['mcp-project-tab-head']}>
              {(() => {
                const pd = data.projectData
                const cwdBase = pd?.isDefaultWorkdir ? '' : ((pd?.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '')
                return cwdBase ? <span className={styles['mcp-project-tab-cwd']} title={pd?.cwd || ''}>{cwdBase}</span> : null
              })()}
              <div className={styles['mcp-project-tab-actions']}>
                {data.projectData && !data.projectData.isDefaultWorkdir && (
                  <button
                    className="mcp-icon-btn" title={t('mcp_project_add')} aria-label={t('mcp_project_add')}
                    disabled={busyKeys.has(`project:${scope}:add`)}
                    onClick={() => { void handleProjectAction('add', '', 'project').catch((error: any) => showToast(error?.message || t('settings_failed'))) }}
                    dangerouslySetInnerHTML={{ __html: rawIconHtml('mcp-icon-btn') }}
                  />
                )}
              </div>
            </div>
            <EntryList empty={!projectServers.length} emptyText={search ? t('mcp_search_empty') : t('mcp_session_card_empty')}>
              {projectServers.map(s => {
                const editable = s.scope === 'project' || s.scope === 'local'
                return (
                  <EntryCard
                    key={`proj:${s.scope}:${s.name}`}
                    cardKey={`proj:${s.scope}:${s.name}`}
                    datasets={{ 'proj-name': s.name, 'proj-scope': s.scope }}
                    title={s.name}
                    desc={String(s.transport || 'stdio').toUpperCase()}
                    descMono
                    badge={<SourceBadge text={s.scope === 'local' ? t('mcp_scope_local') : t('mcp_scope_project')} />}
                    meta={s.enabled === false ? <EntryMeta text={t('disabled')} /> : undefined}
                    onOpen={() => setModal({ kind: 'project-detail', server: s })}
                    onToggleKey={() => { void handleProjectAction('toggle', s.name, s.scope, s.enabled === false) }}
                    controls={editable ? (
                      <>
                        <EntryToggle
                          checked={s.enabled !== false}
                          title={s.enabled === false ? t('disabled') : t('enabled')}
                          disabled={busyKeys.has(`project:${scope}:${s.name}`)}
                          onChange={(checked) => { void handleProjectAction('toggle', s.name, s.scope, checked).catch((error: any) => showToast(error?.message || t('settings_failed'))) }}
                        />
                        <EntryIconButton
                          iconName="edit" title={t('mcp_edit')}
                          disabled={busyKeys.has(`project:${scope}:${s.name}`)}
                          onClick={(e) => { e.stopPropagation(); void handleProjectAction('edit', s.name, s.scope).catch((error: any) => showToast(error?.message || t('settings_failed'))) }}
                        />
                        <EntryIconButton
                          iconName="trash" title={t('delete_title')}
                          disabled={busyKeys.has(`project:${scope}:${s.name}`)}
                          onClick={(e) => { e.stopPropagation(); void handleProjectAction('del', s.name, s.scope).catch((error: any) => showToast(error?.message || t('settings_failed'))) }}
                        />
                      </>
                    ) : undefined}
                  />
                )
              })}
            </EntryList>
          </div>
        </div>
      ) : (
        <div data-mcp-panel="installed">
          {/*
            全局档 = 条目卡竖排：自建/插件/市场装的 server 卡 + 内置连接器组卡
            （内置算全局的一部分，同一套卡组件）。行尾不报工具数：列表只担
            「这个服务在不在、通不通」，状态点已经说完；失败态同理只由红点播报。
          */}
          <EntryList
            empty={!visibleGlobalServers.length && !connectorGroups.size && !visibleNativeCards.length}
            emptyText={search ? t('mcp_search_empty') : t('mcp_no_global')}
          >
            {visibleGlobalServers.map(server => {
              const status = data.statusMap.get(server.name)
              const catalog = data.builtinById.get(server.name) || null
              const catalogText = catalog ? mcpLocalizedText(catalog) : null
              const cfg = server.config || {}
              const type = cfg.type || 'stdio'
              const detail = type === 'stdio'
                ? formatMcpCommandLine(cfg.command || '', cfg.args || [])
                : cfg.url || ''
              // 停用态不是故障态：无状态点、不显错误行（探测层可能残留旧 error，渲染层兜底）。
              const disabled = !server.enabled
              const klausNeedsAuth = !!status?.klausNeedsAuth
              // 卡头状态点同连接器卡语义，全页共用 mcpStatusDot 一份映射。
              const statusDot = mcpStatusDot({ enabled: !disabled, statusReady: data.statusReady, status })
              return (
                <EntryCard
                  key={`srv:${server.name}`}
                  cardKey={`srv:${server.name}`}
                  datasets={{
                    name: server.name,
                    oauth: cfg.oauth != null || klausNeedsAuth ? 'true' : '',
                    'needs-uv': data.needsUvIds.has(server.name) ? 'true' : 'false',
                  }}
                  iconHtml={connectorIcon(server.name) || undefined}
                  iconSvg={catalog?.iconSvg || ''}
                  title={catalogText?.name || server.name}
                  desc={catalogText?.desc || detail}
                  descMono={!catalogText}
                  // 卡头状态点：连上=实心绿，待授权=琥珀环，失败=实心红，探测中=蓝环，停用不摆点。
                  dot={statusDot}
                  // 行尾文字标是状态的第三通道（色+形+文），只给失败/连接中：
                  // 待授权行本身已经摆了【授权】按钮，再加一句「待授权」就是重词；
                  // 已连接是常态，不需要播报。
                  meta={statusDot && (statusDot.state === 'error' || statusDot.state === 'busy')
                    ? <EntryMeta text={statusDot.label} />
                    : undefined}
                  onOpen={() => openServerDetail(server.name)}
                  onToggleKey={() => { void toggleServer(server, !(!!server.enabled && !klausNeedsAuth), klausNeedsAuth) }}
                  // 卡头只留高频控件（开关/编辑/删除，待授权时加「授权」）；
                  // 重置/诊断/uv 指引收进点卡弹出的详情弹窗，按需才显。
                  controls={
                    <>
                      {klausNeedsAuth && (
                        <button
                          className={`${styles['mcp-action-btn']} ${styles['mcp-action-primary']}`}
                          disabled={busyKeys.has(`server:${server.name}`)}
                          onClick={(e) => { e.stopPropagation(); void authorizeServer(server.name) }}
                        >{t('mcp_authorize')}</button>
                      )}
                      <EntryToggle
                        checked={!!server.enabled && !klausNeedsAuth}
                        title={server.enabled ? t('enabled') : t('disabled')}
                        disabled={busyKeys.has(`server:${server.name}`)}
                        onChange={(checked) => { void toggleServer(server, checked, klausNeedsAuth) }}
                      />
                      <EntryIconButton
                        iconName="edit" title={t('mcp_edit')}
                        disabled={busyKeys.has(`server:${server.name}`)}
                        onClick={(e) => { e.stopPropagation(); void editServer(server.name) }}
                      />
                      <EntryIconButton
                        iconName="trash" title={t('delete_title') || 'Delete'}
                        disabled={busyKeys.has(`server:${server.name}`)}
                        onClick={(e) => { e.stopPropagation(); void deleteServer(server.name) }}
                      />
                    </>
                  }
                />
              )
            })}
            {visibleNativeCards.map(card => {
              const status = data.statusMap.get(card.serverName)
              // 同 server 卡语义（停用不摆点：未启用的内置 server 不在探测集里）。
              const statusDot = mcpStatusDot({ enabled: card.enabled, statusReady: data.statusReady, status })
              return (
                <EntryCard
                  key={`native:${card.capability}`}
                  cardKey={`native:${card.capability}`}
                  iconHtml={connectorIcon(card.capability) || rawIconHtml(card.iconName)}
                  title={card.title}
                  desc={card.desc}
                  dot={statusDot}
                  meta={statusDot && (statusDot.state === 'error' || statusDot.state === 'busy')
                    ? <EntryMeta text={statusDot.label} />
                    : undefined}
                  onOpen={() => setModal({ kind: 'native-capability', capability: card.capability })}
                  onToggleKey={() => { void toggleNativeCapability(card.capability, !card.enabled) }}
                  controls={
                    <EntryToggle
                      checked={card.enabled}
                      title={card.enabled ? t('enabled') : t('disabled')}
                      disabled={busyKeys.has(`native:${card.capability}`)}
                      onChange={(checked) => { void toggleNativeCapability(card.capability, checked) }}
                    />
                  }
                />
              )
            })}
            {[...connectorGroups.keys()].map(groupId => (
              // 行尾不摆「n/total 已启用」聚合计数：组卡只担入口，启用明细点进详情弹窗看。
              <EntryCard
                key={`group:${groupId}`}
                cardKey={`group:${groupId}`}
                iconHtml={connectorIcon('group:' + groupId)}
                title={connectorGroupTitles[groupId] || groupId}
                desc={t('mcp_connectors_group_desc')}
                onOpen={() => setModal({ kind: 'connector-group', groupId })}
              />
            ))}
          </EntryList>
        </div>
      )}
      {modalNode}
    </div>
  )
}
