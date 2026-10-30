// Klaus Desktop — 跨页共享 UI 助手（迁自 js/ui-shared.js）。
// 从 settings.js / pages/channels.js 迁出的寄生共享块，统一归位：
//   - showToast 全局轻提示（含 toast viewport 管理）
//   - 斜杠命令中文本地化（SLASH_COMMAND_TEXT_ZH + window.klausSlashCommandI18n）
//   - 卡片搜索机制（bindCardSearch / window.klausSearch）
//     搜索框本体不在这里：页头三件套（刷新 / 搜索 / 添加）唯一渲染源是 app/ui-topbar.ts。
// 领域取值器原经运行时全局调用（localizeSkillName / classifySlashCommand 等），
// TS 化后改为显式 import 同一实现（pages/skills/localize、pages/slash-commands/helpers）。
import { icon } from '../icons/registry'
import {
  normalizeMarketKey,
  getMarketUiLang,
  localizeSkillName,
  localizeSkillDescription,
  getSkillCategory,
  skillCategoryLabel,
  getPluginBaseName,
  localizePluginName,
  localizePluginDescription,
} from '../pages/skills/localize'
import { classifySlashCommand, slashCommandTypeLabel } from '../pages/slash-commands/helpers'

const tt = (key: string): string => (window as any).tt?.(key) || key
// 同 settings/shell.ts 的 esc：本地定义而非 import，避免把 settings 页树拉进
// 早期求值链（本模块在 main.ts 里先于 pages 求值）。
const esc = (str: unknown): string =>
  str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') : ''

let toastIdSeq = 0
function ensureToastViewport() {
  let viewport = document.getElementById('settings-toast-viewport')
  if (!viewport) {
    viewport = document.createElement('span')
    viewport.id = 'settings-toast-viewport'
    viewport.className = 'toast-viewport'
    viewport.setAttribute('aria-live', 'polite')
    viewport.setAttribute('aria-atomic', 'false')
    document.body.appendChild(viewport)
  }
  return viewport
}

export function showToast(msg: unknown, opts: { onClick?: () => void; duration?: number; tone?: 'success' | 'warning' | 'danger'; head?: { avatar: string; title: string } } = {}) {
  const text = msg == null ? '' : String(msg)
  if (!text.trim()) return

  const viewport = ensureToastViewport()
  const toast = document.createElement('div')
  toast.id = `settings-toast-${++toastIdSeq}`
  toast.className = 'toast-root s-toast no-drag'
  toast.dataset.state = 'entering'
  if (opts.tone) toast.dataset.tone = opts.tone

  const alert = document.createElement('div')
  alert.className = 'alert-root'
  alert.setAttribute('role', 'alert')

  // Optional sender head (avatar + name) for person-sourced toasts such as
  // friend message arrivals; plain toasts keep the single-line chip.
  if (opts.head) {
    const head = document.createElement('div')
    head.className = 'toast-head'
    const avatar = document.createElement('span')
    avatar.className = 'toast-avatar'
    avatar.textContent = opts.head.avatar || '?'
    const title = document.createElement('span')
    title.className = 'toast-head-title'
    title.textContent = opts.head.title
    head.appendChild(avatar)
    head.appendChild(title)
    alert.appendChild(head)
  }

  const message = document.createElement('div')
  message.className = 'toast-message'
  message.textContent = text

  alert.appendChild(message)
  toast.appendChild(alert)
  viewport.appendChild(toast)

  requestAnimationFrame(() => {
    toast.dataset.state = 'entered'
  })

  while (viewport.children.length > 3) {
    viewport.firstElementChild?.remove()
  }

  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    toast.dataset.state = 'exiting'
    window.setTimeout(() => {
      toast.remove()
      if (!viewport.children.length) viewport.remove()
    }, 260)
  }

  if (typeof opts.onClick === 'function') {
    toast.style.cursor = 'pointer'
    toast.addEventListener('click', () => { try { opts.onClick!() } catch {} remove() })
  }
  window.setTimeout(remove, opts.duration || 2500)
  return remove
}

const SLASH_COMMAND_TEXT_ZH: Record<string, string[]> = {
  'add-dir': ['添加工作目录', '添加新的工作目录。', '<路径>'],
  agents: ['代理配置', '管理代理配置。'],
  branch: ['创建分支', '从当前会话位置创建一个分支。', '[名称]'],
  btw: ['临时提问', '快速提出旁路问题，不打断主对话。', '<问题>'],
  chrome: ['Chrome 设置', 'Klaus in Chrome（Beta）设置。'],
  color: ['提示栏颜色', '设置本会话的提示栏颜色。', '<颜色|default>'],
  config: ['配置', '打开配置面板。'],
  copy: ['复制回复', '复制上一条回复到剪贴板，也可复制倒数第 N 条。', '[N]'],
  desktop: ['桌面应用', '在桌面应用中继续当前会话。'],
  context: ['上下文视图', '以彩色网格查看当前上下文用量。'],
  diff: ['查看变更', '查看未提交变更和每轮对话差异。'],
  doctor: ['诊断', '诊断并验证 Klaus 安装和设置。'],
  effort: ['推理强度', '设置模型使用的推理强度。', '[low|medium|high|max|auto]'],
  exit: ['退出', '退出 REPL。'],
  export: ['导出会话', '将当前对话导出到文件或剪贴板。', '[文件名]'],
  fast: ['快速模式', '切换快速模式。', '[on|off]'],
  help: ['帮助', '显示帮助和可用命令。'],
  hooks: ['钩子', '查看工具事件钩子配置。'],
  ide: ['IDE 集成', '管理 IDE 集成并显示状态。', '[open]'],
  'install-github-app': ['安装 GitHub App', '为仓库设置 GitHub Actions 集成。'],
  login: ['登录', '使用 Anthropic 账号登录。'],
  logout: ['退出登录', '退出登录并清除认证凭据。'],
  memory: ['记忆', '编辑记忆文件。'],
  mobile: ['移动端', '显示移动应用下载二维码。'],
  model: ['模型', '设置会话使用的 AI 模型。', '[模型]'],
  passes: ['通行证', '管理订阅通行证。'],
  permissions: ['权限', '管理允许和拒绝的工具权限规则。'],
  plan: ['计划模式', '启用计划模式或查看当前会话计划。', '[open|<描述>]'],
  plugin: ['插件', '管理插件。'],
  'privacy-settings': ['隐私设置', '查看和更新隐私设置。'],
  'remote-env': ['远程环境', '配置 teleport 会话的默认远程环境。'],
  rename: ['重命名会话', '重命名当前会话。', '[名称]'],
  resume: ['恢复会话', '恢复之前的会话。', '[会话 ID 或搜索词]'],
  session: ['远程会话', '显示远程会话 URL 和二维码。'],
  skills: ['技能', '列出可用技能。'],
  stats: ['使用统计', '显示使用统计和活动。'],
  status: ['状态', '显示 Klaus 状态，包括版本、模型、账号、API 连通性和工具状态。'],
  tag: ['会话标签', '切换当前会话的可搜索标签。', '<标签名>'],
  tasks: ['后台任务', '列出并管理后台任务。'],
  'terminal-setup': ['终端设置', '安装终端快捷键。'],
  theme: ['主题', '切换主题。'],
  'think-back': ['年度回顾', '查看 2025 年度回顾。'],
  upgrade: ['升级', '升级到 Max，以获得更高的速率限制和更多 Opus 用量。'],
  usage: ['用量', '查看套餐使用限制。'],
  heapdump: ['堆快照', '将 JS 堆快照导出到 ~/Desktop。'],
  'install-slack-app': ['安装 Slack App', '安装 Slack 集成。'],
  keybindings: ['快捷键', '打开或创建快捷键配置文件。'],
  'release-notes': ['更新说明', '查看更新说明。'],
  'reload-plugins': ['重载插件', '激活当前会话中待生效的插件变更。'],
  rewind: ['回退会话', '将当前对话回退到之前的检查点。'],
  statusline: ['状态栏', '设置状态栏 UI。'],
  stickers: ['贴纸', '订购贴纸。'],
  vim: ['Vim 模式', '在 Vim 和普通编辑模式之间切换。'],
  compact: ['压缩', '压缩此聊天的上下文', '<可选的自定义摘要指令>'],
  cost: ['成本', '显示当前会话的总成本和耗时。'],
  files: ['上下文文件', '列出当前上下文中的所有文件。'],
  mcp: ['MCP 服务', '管理 MCP 服务。', '[status|enable|disable [服务名]]'],
  'pr-comments': ['PR 评论', '获取 GitHub Pull Request 评论。'],
  version: ['版本', '打印当前会话正在运行的版本。'],
  clear: ['清空对话', '清空对话历史并释放上下文。'],
  commit: ['提交', '创建 git 提交。'],
  'commit-push-pr': ['提交并开 PR', '提交、推送并创建 Pull Request。'],
  init: ['初始化项目', '为此项目初始化 KLAUS.md。'],
  'init-verifiers': ['初始化验证器', '为代码变更创建自动验证技能。'],
  review: ['PR 审查', '审查一个 Pull Request。'],
  'security-review': ['安全审查', '对当前分支的待提交变更进行安全审查。'],
  'code-review': ['代码审查', '审查一个 Pull Request。'],
  'review-pr': ['综合 PR 审查', '使用专用代理进行综合 PR 审查。', '[审查范围]'],
  'clean-gone': ['清理失效分支', '清理标记为 gone 的本地分支及关联 worktree。'],
  'extra-usage': ['额外用量', '配置达到限制后继续工作的额外用量。'],
  insights: ['会话洞察', '生成会话分析报告。'],
  ultrareview: ['超级审查', '在 Web 端查找并验证当前分支中的 bug。'],
  brief: ['工作简报', '概述近期工作和定时任务。'],
  assistant: ['助手模式', '配置助手模式。'],
  'remote-control': ['远程控制', '管理 Remote Control bridge。'],
  voice: ['语音模式', '切换语音模式。'],
  'web-setup': ['网页端设置', '在 Web 上设置 Klaus。'],
  ultraplan: ['超级规划', '启动 ultraplan 会话。'],
  peers: ['对等会话', '列出已连接的 peer 会话。'],
  fork: ['分叉代理', '将当前会话分叉到一个子代理。'],
  workflows: ['工作流', '列出并管理工作流脚本。'],
}

function getSlashCommandKey(command: any) {
  return normalizeMarketKey(command?.name)
}

function isSkillSlashCommand(command: any) {
  const source = String(command?.source || '').toLowerCase()
  return source.includes('skill') || source === 'bundled'
}

function getSlashCommandZhEntry(command: any) {
  if (getMarketUiLang() !== 'zh') return null
  return SLASH_COMMAND_TEXT_ZH[getSlashCommandKey(command)] || null
}

export function localizeSlashCommandDisplayName(command: any): string {
  const entry = getSlashCommandZhEntry(command)
  if (entry?.[0]) return entry[0]
  if (isSkillSlashCommand(command)) {
    return localizeSkillName({
      dirName: command?.name,
      name: command?.displayName || command?.name,
      description: command?.description,
    })
  }
  return command?.displayName || command?.name || ''
}

export function localizeSlashCommandDescription(command: any): string {
  const entry = getSlashCommandZhEntry(command)
  if (entry?.[1]) return entry[1]
  if (isSkillSlashCommand(command)) {
    return localizeSkillDescription({
      dirName: command?.name,
      name: command?.displayName || command?.name,
      description: command?.description,
    })
  }
  return command?.description || ''
}

export function localizeSlashCommandArgumentHint(command: any): string {
  const entry = getSlashCommandZhEntry(command)
  if (entry?.[2]) return entry[2]
  return command?.argumentHint || ''
}

;(window as any).klausSlashCommandI18n = {
  displayName: localizeSlashCommandDisplayName,
  description: localizeSlashCommandDescription,
  argumentHint: localizeSlashCommandArgumentHint,
}

/**
 * 市场档卡片网格（MCP 市场 / 技能广场 / 插件广场共用的唯一市场组件）。
 *
 * 市场是「逸而发现」场景：双列卡片网格（图标砖 + 名称/副标 + 两行描述 +
 * 行尾态度控件）给得起信息密度；安装档才是「管理」场景，走各页自己的
 * 单列行式列表。三页市场档必须共用本组件，不得各自再起卡片骨架。
 *
 * card 参数：cardKey（卡体点击路由键）、datasets（额外 data-* ）、iconHtml
 *（完整 <svg>）、title、badgeHtml、subtitleHtml（命令芯这类）、desc、
 * controlsHtml（行尾控件：四态态度图标 / 安装钮）。
 */
function renderMarketCard(entry: any = {}) {
  const attrs = Object.entries(entry.datasets || {})
    .map(([k, v]) => `data-${k}="${esc(String(v))}"`)
    .join(' ')
  return `
    <div class="kls-market-card" ${entry.cardKey ? `data-card-key="${esc(entry.cardKey)}"` : ''} ${attrs}>
      <div class="kls-market-body" data-card-open>
        <span class="kls-market-icon" aria-hidden="true">${entry.iconHtml || ''}</span>
        <div class="kls-market-text">
          <div class="kls-market-name-row">
            <span class="kls-market-name">${esc(entry.title)}</span>
            ${entry.subtitleHtml || ''}
            ${entry.badgeHtml || ''}
          </div>
          <div class="kls-market-desc">${esc(entry.desc || '')}</div>
        </div>
        ${entry.controlsHtml ? `<span class="kls-market-controls">${entry.controlsHtml}</span>` : ''}
      </div>
    </div>`
}

// 市场档网格容器（空态兼底同列表容器语汇）。
function renderMarketGrid(cardsHtml: string, emptyText?: string) {
  if (!cardsHtml) return `<div class="kls-market-empty">${esc(emptyText || '')}</div>`
  return `<div class="kls-market-grid">${cardsHtml}</div>`
}

;(window as any).klsMarket = { card: renderMarketCard, grid: renderMarketGrid }

function flattenSearchValues(values: unknown, output: string[] = []): string[] {
  if (values == null) return output
  if (Array.isArray(values)) {
    values.forEach(value => flattenSearchValues(value, output))
    return output
  }
  output.push(String(values))
  return output
}

function normalizeSearchText(value: unknown) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function searchValueVariants(value: unknown) {
  const normalized = normalizeSearchText(value)
  if (!normalized) return []
  const withoutSlash = normalized.replace(/^\/+/, '')
  const spaced = withoutSlash.replace(/[\/._:|#@()[\]{}"'`]+/g, ' ').replace(/[-]+/g, ' ').replace(/\s+/g, ' ').trim()
  const compact = spaced.replace(/\s+/g, '')
  const rawCompact = withoutSlash.replace(/[\s\/._:|#@()[\]{}"'`-]+/g, '')
  const initials = spaced.split(/\s+/).filter(Boolean).map(part => part[0]).join('')
  return [...new Set([normalized, withoutSlash, spaced, compact, rawCompact, initials].filter(Boolean))]
}

function searchQueryTokens(query: unknown) {
  const normalized = normalizeSearchText(query).replace(/^\/+/, '')
  if (!normalized) return []
  const spaced = normalized.replace(/[\/._:|#@()[\]{}"'`]+/g, ' ').replace(/[-]+/g, ' ').replace(/\s+/g, ' ').trim()
  const parts = spaced.split(/\s+/).filter(Boolean)
  const compact = normalized.replace(/[\s\/._:|#@()[\]{}"'`-]+/g, '')
  return [...new Set([
    ...(parts.length > 1 ? [] : [normalized]),
    compact,
    ...parts,
  ].filter(Boolean))]
}

export function filterTextMatches(query: unknown, values: unknown) {
  const tokens = searchQueryTokens(query)
  if (tokens.length === 0) return true
  const flatValues = flattenSearchValues(values)
  const variants = [...flatValues, flatValues.join(' ')].flatMap(searchValueVariants)
  return tokens.every(token => variants.some(value => value.includes(token)))
}

export function getSkillSearchValues(skill: any): unknown[] {
  const command = String(skill?.dirName || skill?.name || '').trim()
  const category = getSkillCategory(skill || {})
  return [
    command,
    command ? `/${command}` : '',
    skill?.dirName,
    skill?.name,
    skill?.displayName,
    skill?.description,
    localizeSkillName(skill || {}),
    localizeSkillDescription(skill || {}),
    category,
    skillCategoryLabel(category),
    tt('skills'),
  ]
}

export function getPluginSearchValues(plugin: any): unknown[] {
  const key = getPluginBaseName(plugin || {})
  return [
    key,
    key ? `/${key}` : '',
    plugin?.name,
    plugin?.description,
    plugin?.category,
    plugin?.author,
    plugin?.hasLsp ? 'lsp' : '',
    plugin?.badges,
    plugin?.lspCommands,
    plugin?.lspExtensions,
    localizePluginName(plugin || {}),
    localizePluginDescription(plugin || {}),
    tt(`plugins_category_${plugin?.category || 'other'}`),
    tt('plugins'),
  ]
}

export function getSlashCommandSearchValues(command: any): unknown[] {
  const name = String(command?.name || '').trim()
  const category = classifySlashCommand(command || {})
  return [
    name,
    name ? `/${name}` : '',
    command?.displayName,
    command?.description,
    command?.argumentHint,
    command?.source,
    command?.type,
    localizeSlashCommandDisplayName(command || {}),
    localizeSlashCommandDescription(command || {}),
    localizeSlashCommandArgumentHint(command || {}),
    category,
    tt(`slash_commands_category_${category}`),
    slashCommandTypeLabel(command?.type),
    isSkillSlashCommand(command) ? getSkillSearchValues({
      dirName: name,
      name: command?.displayName || name,
      description: command?.description,
    }) : [],
  ]
}

function getCronTaskSearchValues(task: any): unknown[] {
  return [
    task?.id,
    task?.id ? `/${task.id}` : '',
    task?.name,
    task?.name ? `/${task.name}` : '',
    task?.prompt,
    task?.schedule,
    task?.channelBinding?.label,
    task?.channelBinding?.targetId,
    task?.channelBinding?.channelId,
  ]
}

function getCronRunSearchValues(run: any): unknown[] {
  return [
    run?.taskId,
    run?.taskId ? `/${run.taskId}` : '',
    run?.taskName,
    run?.taskName ? `/${run.taskName}` : '',
    run?.status,
    run?.triggerType,
    run?.error,
  ]
}

export function bindCardSearch(
  inputId: string,
  gridId: string,
  itemSelector: string,
  stateSetter: (query: string) => void,
  emptyText: string,
  onFilter?: (visible: number, total: number) => void,
) {
  const input = document.getElementById(inputId) as HTMLInputElement | null
  const grid = document.getElementById(gridId)
  if (!input || !grid) return
  const apply = () => {
    const query = input.value || ''
    stateSetter(query)
    const cards = Array.from(grid.querySelectorAll<HTMLElement>(itemSelector))
    let visible = 0
    cards.forEach(card => {
      const match = filterTextMatches(query, [card.dataset.search, card.textContent])
      card.classList.toggle('kls-search-hidden', !match)
      card.setAttribute('aria-hidden', match ? 'false' : 'true')
      if (match) visible += 1
    })
    let empty = grid.querySelector<HTMLElement>('[data-search-empty]')
    if (!empty) {
      empty = document.createElement('p')
      empty.className = 'empty-text sk-empty'
      empty.dataset.searchEmpty = '1'
      empty.textContent = emptyText
      grid.appendChild(empty)
    }
    empty.style.display = query && cards.length > 0 && visible === 0 ? '' : 'none'
    if (onFilter) onFilter(visible, cards.length)
  }
  input.addEventListener('input', apply)
  apply()
}

;(window as any).klausSearch = {
  matches: filterTextMatches,
  skillValues: getSkillSearchValues,
  pluginValues: getPluginSearchValues,
  slashCommandValues: getSlashCommandSearchValues,
  cronTaskValues: getCronTaskSearchValues,
  cronRunValues: getCronRunSearchValues,
}

// 全局统一的页面加载态：空页居中一枚灰色 Klaus 品牌标（六边形对话气泡 +
// 「>|」，与 logo 同形的描边重绘），动效 = 自我组装：先勾气泡轮廓、再画
// 「>|」，成形停一拍后淡出重来（stroke-dashoffset 描边自绘，一笔一笔写出来）。
// 管理页专用；会话区切换用 transcript-skeleton、对话流用 thinking 三点，各司其职。
// 用法：container.innerHTML = window.klsLoading.render()。
function renderKlsLoading() {
  return `<div class="kls-loading" role="status" aria-label="${esc(tt('loading'))}">
    ${icon('kls-loading-mark')}
  </div>`
}
;(window as any).klsLoading = { render: renderKlsLoading }

// [module-bridge] classic-script 时代的跨文件全局；chat.js 与 pages/ 仍经 window 消费。
Object.assign(window, { bindCardSearch, filterTextMatches, getPluginSearchValues, getSkillSearchValues, getSlashCommandSearchValues, localizeSlashCommandArgumentHint, localizeSlashCommandDescription, localizeSlashCommandDisplayName, showToast })

/** HTML 转义（自 chat.ts 收编共享）。 */
export function escapeHtml(str: unknown): string {
  return str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''
}
