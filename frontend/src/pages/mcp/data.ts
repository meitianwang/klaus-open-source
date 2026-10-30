// MCP page data and interaction state:
// 状态面单飞探测、待启用连接器补班、OAuth 授权流、失败归类、智能诊断、
// 连接器系统权限预检、跨文件 reload 协议。
import { t } from '../../i18n'
import { icon } from '../../icons/registry'
import { getConnectorLogoSrc } from '../../icons/extension-logos'
import { skillLogoImgHtml } from '../skills/localize'
import type { StatusDotState } from '../../components/StatusDot'

const w = () => window as any
export const showToast = (msg: string) => w().showToast?.(msg)

// ---- 类型（bridge 形状按消费面收敛，边缘保持宽松） ----
export interface McpServerConfig {
  type?: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  timeout?: number
  // 壳会把它透传进会话配置（parse_server_entry），引擎据此跳过该服务器工具的延迟加载。
  alwaysLoad?: boolean
  oauth?: unknown
}

export interface McpServer {
  name: string
  config?: McpServerConfig
  enabled?: boolean
}

export interface McpStatus {
  name: string
  status?: string
  error?: string
  toolCount?: number
  tools?: Array<{ name: string; description?: string }>
  klausNeedsAuth?: boolean
}

export interface McpBuiltinEntry {
  id: string
  /** 市场分类（目录数据给的 id，标签走 mcp_category_<id> 字典）。 */
  category?: string
  nameEn?: string
  nameZh?: string
  descEn?: string
  descZh?: string
  iconSvg?: string
  installed?: boolean
  enabled?: boolean
  needsUv?: boolean
  auth?: string
  envKeys?: Array<{ key: string; label: string; secret?: boolean }>
  deviceAuth?: { registerUrl?: string; ready?: boolean } | null
}

/**
 * 内置档条目：随客户端出厂、只能启停不能卸载的那一类服务。来源两种——
 * engine = 引擎自带的 MCP server；client = 客户端一级能力（对引擎注册成内置
 * MCP server 的宿主能力，如浏览器操作/电脑操控，以及 macOS 连接器组）。
 * 目录条目（McpBuiltinEntry）是「可装可卸」的另一类，两者不能混。
 */
export interface McpBuiltinCapability {
  /** 卡片键：能力键或连接器组 id。 */
  key: string
  origin: 'engine' | 'client'
  title: string
  desc: string
  iconHtml: string
  /** 引擎侧的 server 名（用于取状态点）；组卡这类没有单一 server 时为空。 */
  serverName: string
  /** 有主开关的条目给启停回调；组卡（逐项开关在弹窗内）不给。 */
  enabled?: boolean
  onToggle?: (checked: boolean) => void
  onOpen: () => void
}

/** 内置分类的固定键：目录侧不会出现同名分类（目录条目全是可装可卸的）。 */
export const MCP_BUILTIN_CATEGORY = 'builtin'

/**
 * 目录分类的呈现顺序：固定排而不按本地化标签字母排——字母排会让中英
 * 两语的 tab 顺序不一致，同一个人切语言后找不到刚才的位置。字典外的
 * 新分类排在这些之后，'other' 总在最后。
 */
export const MCP_CATEGORY_ORDER = ['dev', 'data', 'design', 'productivity', 'communication', 'info']

/**
 * 分类显示名：走 mcp_category_<key> 字典（同技能/插件页的分类字典约定）。
 * 字典缺项时原样显示分类 id，不让整行退化成空标签。
 */
export function mcpCategoryLabel(category: string): string {
  const key = `mcp_category_${category}`
  const label = w().tt?.(key)
  return !label || label === key ? category : label
}

export interface ConnectorTool {
  name: string
  enabled?: boolean
  // Both come from the connector binary's own `Effect` declaration, never from
  // the catalog: the read/write grouping and the approval control have to agree
  // with what the engine is told on the wire.
  readOnly?: boolean
  destructive?: boolean
  // `mcp__<server>__<tool>` — the name a permission rule targets. The shell sends
  // it because `klaus-<id>` is not the server name for every connector.
  fullName?: string
  approval?: 'auto' | 'ask'
  labelZh?: string
  labelEn?: string
  descZh?: string
  descEn?: string
}

export interface ConnectorItem {
  id: string
  serverName?: string
  group: string
  icon?: string
  nameEn?: string
  nameZh?: string
  descEn?: string
  descZh?: string
  enabled?: boolean
  availableOnThisPlatform?: boolean
  tools: ConnectorTool[]
}

// ---- 本地化 ----
export function mcpLocalizedText(item: {
  id?: string
  name?: string
  nameEn?: string
  nameZh?: string
  descEn?: string
  descZh?: string
}, lang = typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en'): { name: string; desc: string } {
  const isZh = typeof lang === 'string' && lang.toLowerCase().startsWith('zh')
  const preferredName = isZh ? item.nameZh : item.nameEn
  const fallbackName = isZh ? item.nameEn : item.nameZh
  const preferredDesc = isZh ? item.descZh : item.descEn
  const fallbackDesc = isZh ? item.descEn : item.descZh
  return {
    name: preferredName || fallbackName || item.name || item.id || '',
    desc: preferredDesc || fallbackDesc || '',
  }
}

/**
 * 市场条目四态状态机（行尾图标与状态弹窗共用同一个事实源）：
 * install = 未安装；off = 已安装未启用（含待授权）；
 * failed = 已启用但连接失败；on = 已启用且未报错。
 */
export function computeMarketEntryState(entry: McpBuiltinEntry, status?: McpStatus): 'install' | 'off' | 'on' | 'failed' {
  if (!entry.installed) return 'install'
  if (!entry.enabled || status?.klausNeedsAuth) return 'off'
  if (status?.status === 'failed' || status?.error) return 'failed'
  return 'on'
}

/**
 * 引擎状态 → 状态点。全页只这一份映射，四个调用点（全局 server / 原生能力卡 /
 * 项目 server / 连接器行）都走它，以免同一个状态在四处各自判断、各自漂。
 *
 * 排序就是语义优先级：
 *  - 停用 → 不摆点（开关已经把这事说完了，再摆一个点是冗余）；
 *  - 状态面本轮还没回来（或该行报 pending）→ busy（这是真存在的一段：
 *    探测要真去连每个服务，首帧 statusMap 是空的。以前这一段与「连不上」
 *    长得一模一样（都没点），用户会以为服务坏了）；
 *  - 待授权 → attn；失败/有错 → error；已连 → ok；其余（未审阅的项目声明等）→ 不摆点。
 */
export interface StatusDotSpec {
  state: StatusDotState
  label: string
}

export function mcpStatusDot(input: {
  enabled: boolean
  /** 本轮状态探测是否已经返回（否则“没有状态行”只说明还在探，不能当作未知）。 */
  statusReady: boolean
  status?: McpStatus
}): StatusDotSpec | null {
  if (!input.enabled) return null
  if (!input.statusReady) return { state: 'busy', label: t('mcp_status_connecting') }
  const status = input.status
  // 探测已经回来却没有这一行 = 未知，不摆点。不能回 busy：那会让不在探测集里的
  // 条目永远卡在「连接中」，比不摆点更谎。
  if (!status) return null
  if (status.status === 'pending') return { state: 'busy', label: t('mcp_status_connecting') }
  if (status.klausNeedsAuth || status.status === 'needs-auth') {
    return { state: 'attn', label: t('mcp_status_needs_auth') }
  }
  if (status.error || status.status === 'failed') {
    return { state: 'error', label: t('mcp_status_failed') }
  }
  if (status.status === 'connected') return { state: 'ok', label: t('mcp_status_connected') }
  return null
}

// ---- 状态面（真探测 + klaus 待授权） ----
// 配置面读盘是毫秒级的，状态面要真连每个服务，两者不能绑在同一次 await 里：
// 首帧只等配置面，状态点等探测回来再补。
export interface McpStatusResult {
  rows: McpStatus[]
  needsAuth: Array<{ name: string }>
  error?: string
}

let mcpStatusResult: McpStatusResult | null = null
let mcpStatusRound: Promise<McpStatusResult> | null = null

export function getMcpStatusResult(): McpStatusResult | null {
  return mcpStatusResult
}

export function hasPendingMcpStatusRound(): boolean {
  return mcpStatusRound !== null
}

// 状态面单飞：同时有多处要状态就复用在跑的那一轮，不重复探测。
export function fetchMcpStatus(): Promise<McpStatusResult> {
  if (mcpStatusRound) return mcpStatusRound
  mcpStatusRound = (async () => {
    const [rowsResult, needsAuthResult] = await Promise.allSettled([
      w().klaus.mcp.status(),
      // klaus 引擎下 MCP 走引擎独立 handle，needs-auth 由用户主动 OAuth 授权。仅当 preload
      // 暴露了授权桥（mcp.klausAuthenticate）时才取——桥未就绪则诚实地不显示授权 UI。
      typeof w().klaus.mcp.klausAuthenticate === 'function'
        ? w().klaus.mcp.klausNeedsAuth()
        : Promise.resolve([]),
    ])
    const rows = rowsResult.status === 'fulfilled' && Array.isArray(rowsResult.value) ? rowsResult.value : []
    const needsAuth = needsAuthResult.status === 'fulfilled' && Array.isArray(needsAuthResult.value) ? needsAuthResult.value : []
    const failures = [rowsResult, needsAuthResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason?.message || String(result.reason || ''))
      .filter(Boolean)
    mcpStatusResult = {
      rows,
      needsAuth,
      ...(failures.length ? { error: failures.join('; ') } : {}),
    }
    return mcpStatusResult
  })().finally(() => { mcpStatusRound = null })
  return mcpStatusRound
}

// ---- 待启用连接器（系统权限授权后补班启用） ----
const PENDING_CONNECTOR_ENABLE_KEY = 'klaus_pending_connector_enable_ids'

function getPendingConnectorEnableIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_CONNECTOR_ENABLE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string' && id) : []
  } catch {
    return []
  }
}

function setPendingConnectorEnableIds(ids: string[]): void {
  const unique = [...new Set(ids.filter(Boolean))]
  try {
    if (unique.length) localStorage.setItem(PENDING_CONNECTOR_ENABLE_KEY, JSON.stringify(unique))
    else localStorage.removeItem(PENDING_CONNECTOR_ENABLE_KEY)
  } catch {}
}

function rememberPendingConnectorEnable(id: string): void {
  setPendingConnectorEnableIds([...getPendingConnectorEnableIds(), id])
}

export function forgetPendingConnectorEnable(id: string): void {
  setPendingConnectorEnableIds(getPendingConnectorEnableIds().filter(x => x !== id))
}

export async function applyPendingConnectorEnables(): Promise<boolean> {
  const ids = getPendingConnectorEnableIds()
  if (!ids.length) return false
  const connectorsApi = w().klaus?.connectors
  if (!connectorsApi?.preflight || !connectorsApi?.toggle) return false

  let changed = false
  const remaining = new Set(ids)
  for (const id of ids) {
    try {
      const preflight = await connectorsApi.preflight(id)
      if (!preflight?.ok) continue
      const result = await connectorsApi.toggle(id, true)
      if (result?.ok) {
        remaining.delete(id)
        changed = true
      }
    } catch (error) {
      showToast((error as Error | null)?.message || t('settings_failed'))
    }
  }
  setPendingConnectorEnableIds([...remaining])
  return changed
}

/**
 * 连接器启用前的系统权限预检（macOS TCC）：Messages/Safari 要全盘访问，
 * Photos 要照片库。App UI 按当前宿主契约在首次实际使用时由系统提示。
 * 返回 true = 放行；
 * 'enabled' = 预检内已完成启用；false = 用户取消或需重启后补班。
 */
export async function ensureConnectorEnablePreflight(id: string): Promise<boolean | 'enabled'> {
  if (!['macos-messages', 'macos-safari', 'macos-photos'].includes(id)) return true

  const connectorsApi = w().klaus?.connectors
  if (!connectorsApi?.preflight) return true

  let result
  try {
    result = await connectorsApi.preflight(id)
  } catch (err: any) {
    showToast(String(err?.message || err))
    return false
  }

  if (result?.ok) return true
  if (id === 'macos-photos') {
    const goAuthorize = await w().klausDialog.confirm({
      title: t('connector_photos_permission_title'),
      message: t('connector_photos_permission_body'),
      confirmText: t('sys_auth_grant_btn'),
      cancelText: t('cancel'),
    })
    if (!goAuthorize) return false
    const api = w().klaus?.systemPermissions
    if (!api?.openSettings) return false
    const res = await api.openSettings('photosLibrary')
    if (!res?.ok) {
      showToast(res?.error || t('settings_failed'))
      return false
    }
    rememberPendingConnectorEnable(id)
    const granted = res?.status === 'granted' || res?.nativeStatus === 'authorized' || res?.nativeStatus === 'limited'
    if (granted && connectorsApi?.toggle) {
      const toggleResult = await connectorsApi.toggle(id, true)
      if (!toggleResult?.ok) {
        showToast(toggleResult?.error || t('settings_failed'))
        return false
      }
      forgetPendingConnectorEnable(id)
      w().showRestartPrompt()
      return 'enabled'
    }
    w().showRestartPrompt()
    return false
  }

  if (!result?.needsFullDiskAccess) {
    showToast(result?.error || t('settings_failed'))
    return false
  }

  const titleKey = id === 'macos-safari' ? 'connector_safari_full_disk_title' : 'connector_messages_full_disk_title'
  const bodyKey = id === 'macos-safari' ? 'connector_safari_full_disk_body' : 'connector_messages_full_disk_body'
  const goAuthorize = await w().klausDialog.confirm({
    title: t(titleKey),
    message: t(bodyKey),
    confirmText: t('sys_auth_grant_btn'),
    cancelText: t('cancel'),
  })
  if (!goAuthorize) return false

  const api = w().klaus?.systemPermissions
  if (!api?.openSettings) return false
  const res = await api.openSettings('fullDiskAccess')
  if (!res?.ok) {
    showToast(res?.error || t('settings_failed'))
    return false
  }

  w().showRestartPrompt()
  return false
}

// ---- OAuth 授权流 ----
// Authorization can complete here only after a live Rust session has emitted a pending request.
// Keep only the latest UI generation. The Host itself coalesces duplicate clicks for one pending request.
const mcpAuthGen = new Map<string, number>()

export interface McpAuthResult {
  status: string
  authorizationUrl?: string
  error?: string
}

// 驱动一次授权。返回状态对象；若本次已被更新的一次点击取代，返回 null（调用方应忽略、不改 UI）。
// 授权成功才算启用——没授权成功就不进入「已开启」态，这是 OAuth server 的启用语义。
// opts.quietFailure：失败时不弹 toast/诊断弹窗，由调用方（如市场状态弹窗）就地呈现失败态。
export async function authorizeMcpServer(name: string, opts: { quietFailure?: boolean } = {}): Promise<McpAuthResult | 'unavailable' | null> {
  if (typeof w().klaus.mcp.klausAuthenticate !== 'function') return 'unavailable'
  const gen = (mcpAuthGen.get(name) || 0) + 1
  mcpAuthGen.set(name, gen)
  const isLatest = () => mcpAuthGen.get(name) === gen
  showToast(t('mcp_authorize_opening'))
  let result: McpAuthResult
  try {
    const r = await w().klaus.mcp.klausAuthenticate(name)
    result = {
      // Rust 授权流：无活跃会话时引擎回 unsupported + requires_session 错误码，映射成独立状态
      // 给 toast 分流（不进「失败」诊断弹窗）。
      status: r?.error === 'rust_mcp_authorization_requires_session'
        ? 'requires-session'
        // 引擎凭据库里「有凭据」与 live 行 needs-auth 矛盾（凭据被服务端拒收）：
        // host 回机器码，这里分流成独立 toast，不再落「授权成功」或通用失败。
        : r?.error === 'rust_mcp_credentials_rejected'
          ? 'credentials-rejected'
          : (r?.status || 'failed'),
      ...(r?.authorizationUrl ? { authorizationUrl: r.authorizationUrl } : {}),
      ...(r?.error ? { error: r.error } : {}),
    }
  } catch (err: any) {
    result = {
      status: 'failed',
      error: err?.message || String(err),
    }
  }
  if (!isLatest()) return null // 被更新的点击取代：静默，不弹「取消/超时」等提示，也不改开关
  const status = mcpAuthStatus(result)
  if (mcpAuthOk(result)) showToast(t('mcp_authorize_done'))
  else if (status === 'declined') showToast(t('mcp_authorize_declined'))
  else if (status === 'requires-session') showToast(t('mcp_authorize_requires_session'))
  else if (status === 'credentials-rejected') showToast(t('mcp_authorize_credentials_rejected'))
  else if (status === 'unsupported') showToast(t('mcp_authorize_unsupported'))
  else {
    // 失败只留 toast；原因入口统一在条目的失败态（红点/红叉 → 点开见告警块），
    // 不另弹窗。安静模式（状态弹窗内）连 toast 都不发，由调用方就地切失败态。
    if (!opts.quietFailure) showToast(t('mcp_authorize_failed'))
  }
  return result
}

/** 授权状态是否代表「已可用」（可进入启用态）。null/失败/取消都不算。 */
export function mcpAuthOk(status: McpAuthResult | string | null): boolean {
  const code = mcpAuthStatus(status)
  return code === 'authenticated' || code === 'not-needed'
}

export function mcpAuthStatus(status: McpAuthResult | string | null): string | undefined {
  return typeof status === 'string' ? status : status?.status
}

// ---- 失败归类与诊断 ----
// Windows 上 uvx 类服务的推荐安装命令（用户自行执行；不自动安装）。
export const UV_INSTALL_COMMAND = 'pip install uv'

/**
 * 把原始连接错误归类成给人看的结论（i18n 键）。原始串不呈现给用户——
 * 它只进诊断证据包交给 Agent；分类顺序：安全拦截 → 鉴权 → 超时 → 网络 → 兜底。
 */
export function classifyMcpFailure(error: unknown): string {
  const text = String(error || '')
  if (/云壳|域名拦截|安全策略|防护记录|拦截/.test(text)) return 'mcp_fail_blocked'
  if (/401|403|unauthorized|forbidden|authorization|invalid[_ ]?token|api[_ ]?key/i.test(text)) return 'mcp_fail_auth'
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return 'mcp_fail_timeout'
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket|network|tls|certificate/i.test(text)) return 'mcp_fail_network'
  return 'mcp_fail_generic'
}

// 诊断 prompt 的连接目标描述：stdio = 启动命令，http/sse = URL（从生效配置取）。
export function mcpServerTargetString(servers: McpServer[], name: string): string {
  const server = servers.find(s => s.name === name)
  const cfg = server?.config || {}
  const type = cfg.type || 'stdio'
  return type === 'stdio'
    ? ((cfg.command || '') + (cfg.args ? ' ' + cfg.args.join(' ') : ''))
    : (cfg.url || '')
}

/**
 * 智能诊断：宿主先把排障证据落盘（配置摘要/代理环境/
 * 就地网络探测/最近错误 → ~/.klaus/logs/mcp-diagnose-*.log），prompt 只带一句话 +
 * 日志路径开新会话，材料让 Agent 自己读文件并用 shell 实测。证据包落盘失败时
 * 回退内联详述版（目标 + 错误直接写进 prompt）。只预填不自动发送。
 * opts.closeModals：React 弹窗先经 state 关闭，再兜底清 DOM 遮罩。
 */
export async function startMcpDiagnoseChat(
  displayName: string,
  serverName: string,
  error: string | undefined,
  opts: { targetString?: string; closeModals?: () => void } = {},
): Promise<void> {
  const bundle = await w().klaus.mcp.diagnoseBundle?.(serverName, error || '').catch(() => null)
  const prompt = bundle?.ok && bundle.logPath
    ? t('mcp_diagnose_prompt')
      .replace('{name}', () => displayName || serverName)
      .replace('{logPath}', () => bundle.logPath)
    : t('mcp_diagnose_prompt_fallback')
      .replace('{name}', () => displayName || serverName)
      .replace('{target}', () => opts.targetString || '-')
      .replace('{error}', () => error || 'Unknown error')
  // 关掉覆盖层与设置面，切新会话预填（同技能页「使用」按钮的入会话路径）。
  opts.closeModals?.()
  document.querySelectorAll('.kls-modal-overlay').forEach(el => el.remove())
  if (typeof w().isSettingsViewActive === 'function' && w().isSettingsViewActive()) w().toggleSettings()
  setTimeout(() => {
    try { document.getElementById('btn-new-chat')?.click() } catch {}
    setTimeout(() => {
      const input = document.getElementById('input') as HTMLTextAreaElement | null
      if (!input) return
      input.value = prompt
      input.dispatchEvent(new Event('input'))
      input.focus()
    }, 100)
  }, 50)
}

// ---- 启用/重试后的就地定态 ----
// A status read is already an authoritative engine snapshot. Waiting for a push
// after that read races with the push that completed the read and used to add an
// unconditional eight-second pause. Poll only while the returned row explicitly
// says it is still connecting; a missing row means there is no live session and
// is returned immediately so the durable enabled preference can drive the UI.
export async function probeMarketStatus(id: string): Promise<McpStatus | null> {
  let row: McpStatus | null = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const statuses = await w().klaus.mcp.status()
    if (!Array.isArray(statuses)) throw new Error(t('mcp_load_failed'))
    row = statuses.find((x: McpStatus) => x.name === id) || null
    if (!row || row.status !== 'pending') return row
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 200))
  }
  return row
}

// ---- 连接器图标（Klaus macOS 连接器视觉语言的细线字形，键：connector id / group id） ----
const CONNECTOR_ICON_NAMES: Record<string, string> = {
  // Reminders — notepad with a ring tab on top
  'macos-reminders': 'macos-reminders',
  // Calendar — box with two binding dots on top
  'macos-calendar': 'macos-calendar',
  // Notes — notebook with a spine on the left
  'macos-notes': 'macos-notes',
  // Mail — envelope
  'macos-mail': 'macos-mail',
  // Contacts — address book with side tabs
  'macos-contacts': 'macos-contacts',
  // Messages — speech bubble
  'macos-messages': 'macos-messages',
  // Safari — compass
  'macos-safari': 'macos-safari',
  // Shortcuts — lightning bolt in a rounded square
  'macos-shortcuts': 'macos-shortcuts',
  // Finder — stylized face (smile)
  'macos-finder': 'macos-finder',
  // Photos — landscape image frame
  'macos-photos': 'macos-photos',
  // System tools — wrench
  'macos-system': 'macos-system',
  // App UI — cursor over a window
  'macos-app-ui': 'macos-app-ui',
}

export function connectorIcon(key: string): string {
  const logo = getConnectorLogoSrc(key)
  if (logo) return skillLogoImgHtml(logo)
  const name = CONNECTOR_ICON_NAMES[key]
  return name ? icon(name) : ''
}

// ---- 跨文件 reload 协议 ----
// 页面进入、刷新按钮、每一笔配置改动都走这里，都要重探（工具数、连接态会变）。
// chat.js（项目级 MCP 弹窗提交后）与 mcp:status:updated 推送经 window.reloadMcpView 消费；
// 事件由挂载中的 McpPage 监听执行（未挂载时无人接，首开时自会全量拉取）。
export const MCP_PAGE_RELOAD_EVENT = 'klaus:mcp-page-reload'

let mcpReloadTimer: ReturnType<typeof setTimeout> | null = null

export function reloadMcpView(delayMs = 0): void {
  if (mcpReloadTimer) clearTimeout(mcpReloadTimer)
  mcpReloadTimer = setTimeout(() => {
    mcpReloadTimer = null
    window.dispatchEvent(new CustomEvent(MCP_PAGE_RELOAD_EVENT, { detail: { refreshStatus: true } }))
  }, Math.max(0, delayMs))
}
