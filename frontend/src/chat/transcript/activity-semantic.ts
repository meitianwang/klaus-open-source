import lowerCase from 'lodash-es/lowerCase'
import upperFirst from 'lodash-es/upperFirst'

export interface SemanticActivity {
  action: string
  icon: string
  target: string
  category: 'browser' | 'web' | 'memory' | 'design' | 'diagram' | 'video' | 'dependencies' | 'schedule' | 'friend'
  /** For a friend send: what kind of message it was, or that the owner chose not to send it. */
  friendOutcome?: 'request' | 'notice' | 'reply' | 'progress' | 'question' | 'declined'
}

type ActionText = [icon: string, chinese: string, active: string, completed: string, verb: string]
const ACTIONS: Record<string, ActionText> = {
  web_search: ['tool-web', '搜索网页', 'Searching the web', 'Searched the web', 'search the web'],
  web_fetch: ['tool-web', '读取网页', 'Reading webpage', 'Read webpage', 'read webpage'],
  browser_navigate: ['tool-browser', '打开网页', 'Opening webpage', 'Opened webpage', 'open webpage'],
  browser_snapshot: ['tool-browser', '查看网页结构', 'Inspecting webpage', 'Inspected webpage', 'inspect webpage'],
  browser_click: ['tool-browser-click', '点击网页元素', 'Clicking webpage element', 'Clicked webpage element', 'click webpage element'],
  browser_type: ['tool-browser', '填写网页内容', 'Typing in webpage', 'Typed in webpage', 'type in webpage'],
  browser_eval: ['tool-browser', '运行网页脚本', 'Running webpage script', 'Ran webpage script', 'run webpage script'],
  browser_read_page: ['tool-web', '读取网页', 'Reading webpage', 'Read webpage', 'read webpage'],
  browser_page_text: ['tool-web', '读取网页文本', 'Reading webpage text', 'Read webpage text', 'read webpage text'],
  browser_find: ['tool-browser', '查找网页内容', 'Finding webpage content', 'Found webpage content', 'find webpage content'],
  browser_locator: ['tool-browser', '定位网页元素', 'Locating webpage element', 'Located webpage element', 'locate webpage element'],
  browser_form_input: ['tool-browser', '填写网页表单', 'Filling webpage form', 'Filled webpage form', 'fill webpage form'],
  browser_computer: ['tool-browser', '操作浏览器', 'Using browser', 'Used browser', 'use browser'],
  browser_tabs: ['tool-browser', '查看浏览器标签页', 'Viewing browser tabs', 'Viewed browser tabs', 'view browser tabs'],
  browser_new_tab: ['tool-browser', '打开浏览器标签页', 'Opening browser tab', 'Opened browser tab', 'open browser tab'],
  browser_select_tab: ['tool-browser', '切换浏览器标签页', 'Switching browser tab', 'Switched browser tab', 'switch browser tab'],
  browser_close: ['tool-browser', '关闭浏览器标签页', 'Closing browser tab', 'Closed browser tab', 'close browser tab'],
  browser_resolve_tab: ['tool-browser', '查找浏览器标签页', 'Finding browser tab', 'Found browser tab', 'find browser tab'],
  browser_claim_tab: ['tool-browser', '连接浏览器标签页', 'Connecting browser tab', 'Connected browser tab', 'connect browser tab'],
  browser_list_connected_browsers: ['tool-browser', '查看已连接浏览器', 'Listing connected browsers', 'Listed connected browsers', 'list connected browsers'],
  browser_select_browser: ['tool-browser', '选择浏览器', 'Selecting browser', 'Selected browser', 'select browser'],
  browser_switch_browser: ['tool-browser', '切换浏览器', 'Switching browser', 'Switched browser', 'switch browser'],
  browser_console: ['tool-browser', '读取网页控制台', 'Reading browser console', 'Read browser console', 'read browser console'],
  browser_network: ['tool-browser', '读取网页网络请求', 'Reading browser network requests', 'Read browser network requests', 'read browser network requests'],
  browser_batch: ['tool-browser', '执行浏览器操作', 'Running browser actions', 'Ran browser actions', 'run browser actions'],
  browser_resize: ['tool-browser', '调整浏览器尺寸', 'Resizing browser', 'Resized browser', 'resize browser'],
  browser_file_upload: ['tool-browser', '上传网页文件', 'Uploading webpage files', 'Uploaded webpage files', 'upload webpage files'],
  browser_download: ['tool-browser', '下载网页文件', 'Downloading webpage file', 'Downloaded webpage file', 'download webpage file'],
  browser_content_export: ['tool-browser', '导出网页', 'Exporting webpage', 'Exported webpage', 'export webpage'],
  browser_clipboard: ['tool-browser', '访问浏览器剪贴板', 'Accessing browser clipboard', 'Accessed browser clipboard', 'access browser clipboard'],
  browser_dialog: ['tool-browser', '处理网页对话框', 'Handling browser dialog', 'Handled browser dialog', 'handle browser dialog'],
  browser_permission: ['tool-browser', '更新网页权限', 'Updating browser permission', 'Updated browser permission', 'update browser permission'],
  browser_history: ['tool-browser', '读取浏览历史', 'Reading browser history', 'Read browser history', 'read browser history'],
  browser_tabs_content: ['tool-web', '读取标签页内容', 'Reading browser tabs', 'Read browser tabs', 'read browser tabs'],
  browser_read_urls: ['tool-web', '读取网页', 'Reading webpages', 'Read webpages', 'read webpages'],
  browser_mark_tab: ['tool-browser', '标记浏览器标签页', 'Marking browser tab', 'Marked browser tab', 'mark browser tab'],
  list_friends: ['tool-friends', '查看好友列表', 'Viewing friends', 'Viewed friends', 'view friends'],
  send_message_to_friend: ['tool-friend-send', '向好友发送消息', 'Sending message to friend', 'Sent message to friend', 'send message to friend'],
  reply_to_friend: ['tool-friend-reply', '回复好友', 'Replying to friend', 'Replied to friend', 'reply to friend'],
  send_friend_progress: ['tool-friend-send', '向好友发送进展', 'Sending progress to friend', 'Sent progress to friend', 'send progress to friend'],
  ask_friend_for_information: ['tool-ask-user', '向好友提问', 'Asking friend', 'Asked friend', 'ask friend'],
  save_memory: ['tool-memory', '保存记忆', 'Saving memory', 'Saved memory', 'save memory'],
  load_workspace_dependencies: ['tool-dependencies', '加载工作区依赖', 'Loading workspace dependencies', 'Loaded workspace dependencies', 'load workspace dependencies'],
  prototype_open: ['tool-design', '打开设计', 'Opening design', 'Opened design', 'open design'],
  prototype_inspect: ['tool-design', '查看设计', 'Inspecting design', 'Inspected design', 'inspect design'],
  prototype_commands: ['tool-design', '查找设计命令', 'Finding design commands', 'Found design commands', 'find design commands'],
  prototype_execute: ['tool-design', '更新设计', 'Updating design', 'Updated design', 'update design'],
  prototype_export: ['tool-design', '导出设计', 'Exporting design', 'Exported design', 'export design'],
  video_editing_open: ['tool-generate-video', '打开视频工程', 'Opening video project', 'Opened video project', 'open video project'],
  video_editing_inspect: ['tool-generate-video', '查看视频工程', 'Inspecting video project', 'Inspected video project', 'inspect video project'],
  video_editing_execute: ['tool-generate-video', '编辑视频', 'Editing video', 'Edited video', 'edit video'],
  video_editing_status: ['tool-generate-video', '查看视频编辑状态', 'Checking video editor status', 'Checked video editor status', 'check video editor status'],
  video_editing_setup: ['tool-dependencies', '准备视频编辑器', 'Preparing video editor', 'Prepared video editor', 'prepare video editor'],
  video_editing_docs: ['tool-generate-video', '读取视频编辑文档', 'Reading video editor documentation', 'Read video editor documentation', 'read video editor documentation'],
  video_editing_command: ['tool-generate-video', '执行视频命令', 'Running video command', 'Ran video command', 'run video command'],
  video_editing_request: ['tool-generate-video', '操作视频工程', 'Operating video project', 'Operated video project', 'operate video project'],
  video_editing_project_file: ['tool-generate-video', '编辑视频工程文件', 'Editing video project file', 'Edited video project file', 'edit video project file'],
  video_editing_job: ['tool-generate-video', '查看视频任务', 'Checking video job', 'Checked video job', 'check video job'],
  digram_open: ['tool-diagram', '打开图表', 'Opening diagram', 'Opened diagram', 'open diagram'],
  digram_get: ['tool-diagram', '读取图表', 'Reading diagram', 'Read diagram', 'read diagram'],
  digram_edit: ['tool-diagram', '更新图表', 'Updating diagram', 'Updated diagram', 'update diagram'],
  digram_inspect: ['tool-diagram', '查看图表', 'Inspecting diagram', 'Inspected diagram', 'inspect diagram'],
  digram_layout: ['tool-diagram', '调整图表布局', 'Arranging diagram', 'Arranged diagram', 'arrange diagram'],
  digram_icons_search: ['tool-diagram', '搜索图表图标', 'Searching diagram icons', 'Searched diagram icons', 'search diagram icons'],
  digram_icon_get: ['tool-diagram', '读取图表图标', 'Reading diagram icon', 'Read diagram icon', 'read diagram icon'],
  digram_export: ['tool-diagram', '导出图表', 'Exporting diagram', 'Exported diagram', 'export diagram'],
  digram_history: ['tool-diagram', '读取图表历史', 'Reading diagram history', 'Read diagram history', 'read diagram history'],
  digram_revert: ['tool-diagram', '恢复图表版本', 'Restoring diagram version', 'Restored diagram version', 'restore diagram version'],
  croncreate: ['tool-clock', '创建定时任务', 'Creating scheduled task', 'Created scheduled task', 'create scheduled task'],
  cronlist: ['tool-clock', '查看定时任务', 'Listing scheduled tasks', 'Listed scheduled tasks', 'list scheduled tasks'],
  crondelete: ['tool-clock', '取消定时任务', 'Cancelling scheduled task', 'Cancelled scheduled task', 'cancel scheduled task'],
  automation_update: ['tool-clock', '更新定时任务', 'Updating scheduled task', 'Updated scheduled task', 'update scheduled task'],
}

export function activityRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return {} } }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function safeActivityUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

/** Friend tools that deliver a message to a friend; their rows sit outside the turn fold. */
export const FRIEND_SEND_TOOLS: ReadonlySet<string> = new Set(['send_message_to_friend', 'reply_to_friend', 'send_friend_progress', 'ask_friend_for_information'])
const FRIEND_TOOLS: ReadonlySet<string> = new Set(['list_friends', ...FRIEND_SEND_TOOLS])

export function friendSendToolName(toolName: string): string | null {
  const name = toolName.toLowerCase().replace(/^functions[._]/, '')
  return FRIEND_SEND_TOOLS.has(name) ? name : null
}

/** What the host reported for one friend send: who received it, what was sent, and how it ended. */
export interface FriendSendResult {
  friendId?: string
  friendName?: string
  prompt?: string
  requestId?: string
  accepted: boolean
  delivered: boolean
  declined: boolean
  /** The host turned a notice reply into the result of a pending request. */
  converted: boolean
  awaitingAuthorization: boolean
  kind?: string
}

export function friendSendResult(output: string | undefined): FriendSendResult {
  const objects = activityResultObjects(output)
  const receipt = objects.find(item => item.declined === true || item.accepted === true || item.delivered === true || typeof item.friendName === 'string')
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined
  return {
    friendId: text(receipt?.friendId), friendName: text(receipt?.friendName), prompt: text(receipt?.prompt),
    requestId: text(receipt?.requestId), kind: text(receipt?.kind),
    accepted: receipt?.accepted === true, delivered: receipt?.delivered === true,
    declined: receipt?.declined === true, converted: receipt?.converted === true, awaitingAuthorization: receipt?.awaitingAuthorization === true,
  }
}

function friendDirectoryName(friendId: unknown): string {
  if (typeof friendId !== 'string' || typeof window === 'undefined') return ''
  const friend = (window as any).getFriendDirectoryEntry?.(friendId)
  return typeof friend?.name === 'string' ? friend.name : ''
}

/**
 * The recipient a friend tool row names. `send_message_to_friend` carries the friend
 * as an argument; the reply, progress and question tools are bound by the host to
 * the task's requester, so their name only arrives with the result.
 */
export function friendRecipientName(args: Record<string, unknown>, output?: string): string {
  const result = output ? friendSendResult(output) : undefined
  return friendDirectoryName(args.friendId) || result?.friendName || friendDirectoryName(result?.friendId)
}

export function semanticActivity(toolName: string, input?: unknown, output?: string): SemanticActivity | null {
  let name = toolName.toLowerCase().replace(/^functions[._]/, '')
  const ownedMcp = /^mcp__(klaus-prototype|klaus-digram|klaus-video-editing)__(.+)$/.exec(name)
  if (ownedMcp && ((ownedMcp[1] === 'klaus-prototype' && ownedMcp[2].startsWith('prototype_')) || (ownedMcp[1] === 'klaus-digram' && ownedMcp[2].startsWith('digram_')) || (ownedMcp[1] === 'klaus-video-editing' && ownedMcp[2].startsWith('video_editing_')))) name = ownedMcp[2]
  if (name === 'websearch') name = 'web_search'
  if (name === 'webfetch' || name === 'fetch_url') name = 'web_fetch'
  if (!Object.hasOwn(ACTIONS, name)) return null
  const args = activityRecord(input)
  if (name === 'browser_tabs') {
    if (args.action === 'new') name = 'browser_new_tab'
    else if (args.action === 'close' || args.action === 'finalize') name = 'browser_close'
    else if (args.action === 'select') name = 'browser_select_tab'
  }
  let target = ''
  const url = safeActivityUrl(args.url)
  if (url) target = new URL(url).hostname
  let friendOutcome: SemanticActivity['friendOutcome']
  if (FRIEND_SEND_TOOLS.has(name)) {
    target = friendRecipientName(args, output)
    const result = output ? friendSendResult(output) : undefined
    friendOutcome = result?.declined ? 'declined'
      // A notice reply the host turned into the result of a pending request is a reply.
      : result?.converted ? 'reply'
        : name === 'send_message_to_friend' ? args.intent === 'notice' ? 'notice' : 'request'
          : name === 'reply_to_friend' ? 'reply' : name === 'send_friend_progress' ? 'progress' : 'question'
  }
  if (name === 'web_search') target = String(args.query ?? args.search_query ?? args.q ?? '').trim().slice(0, 160)
  if (name === 'browser_click' || name === 'browser_locator') target = String(args.name ?? args.label ?? '').trim().slice(0, 100)
  if (name.startsWith('prototype_') || name.startsWith('video_editing_') || name === 'digram_open') target = typeof args.title === 'string' ? args.title.slice(0, 100) : ''
  return { action: name, icon: ACTIONS[name][0], target, ...(friendOutcome ? { friendOutcome } : {}), category: name.startsWith('browser_') ? 'browser' : name.startsWith('web_') ? 'web'
    : name.startsWith('prototype_') ? 'design' : name.startsWith('digram_') ? 'diagram' : name.startsWith('video_editing_') ? 'video' : name.startsWith('cron') || name === 'automation_update' ? 'schedule'
      : FRIEND_TOOLS.has(name) ? 'friend' : name === 'save_memory' ? 'memory' : 'dependencies' }
}

const FRIEND_DONE_LABELS: Record<NonNullable<SemanticActivity['friendOutcome']>, [zh: string, en: string]> = {
  request: ['已向 {name} 发送请求', 'Sent a request to {name}'],
  notice: ['已通知 {name}', 'Notified {name}'],
  reply: ['已回复 {name}', 'Replied to {name}'],
  progress: ['已向 {name} 发送进展', 'Sent progress to {name}'],
  question: ['已向 {name} 提问', 'Asked {name}'],
  declined: ['未发送给 {name}', 'Not sent to {name}'],
}

export function semanticActivityLabel(activity: SemanticActivity, state: string, locale: string): string {
  const [, zh, active, completed, verb] = ACTIONS[activity.action]
  if (activity.friendOutcome && activity.target && (state === 'done' || activity.friendOutcome === 'declined')) {
    const [chinese, english] = FRIEND_DONE_LABELS[activity.friendOutcome]
    return (locale.startsWith('zh') ? chinese : english).replace('{name}', activity.target)
  }
  const label = locale.startsWith('zh')
    ? state === 'running' ? `正在${zh}` : state === 'error' ? `${zh}失败` : state === 'interrupted' ? `已停止${zh}` : state === 'awaiting-approval' ? `等待批准${zh}` : `已${zh}`
    : state === 'running' ? active : state === 'error' ? `Failed to ${verb}` : state === 'interrupted' ? `Stopped ${active.toLowerCase()}` : state === 'awaiting-approval' ? `Awaiting approval to ${verb}` : completed
  return activity.target ? `${label} · ${activity.target}` : label
}

export function activityDisplayName(name: string): string {
  const leaf = name.replace(/^functions[._]/, '').split('__').at(-1) || name
  const label = leaf.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
  return label ? label[0].toUpperCase() + label.slice(1) : name
}

export function genericActivityLabel(name: string, state: string, locale: string): string {
  const label = upperFirst(lowerCase(name.replace(/^functions[._]/, '')))
  if (locale.startsWith('zh')) return `${state === 'running' ? '正在调用工具' : state === 'error' ? '工具调用失败' : state === 'interrupted' ? '工具调用已停止' : state === 'awaiting-approval' ? '工具等待批准' : '工具调用已完成'} · ${label}`
  return `${state === 'running' ? 'Running' : state === 'error' ? 'Failed' : state === 'interrupted' ? 'Stopped' : state === 'awaiting-approval' ? 'Awaiting approval' : 'Completed'} ${label}`
}

/** Decode text envelopes without executing or interpreting their contents as markup. */
export function activityResultObjects(output: string | undefined): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || results.length > 500) return
    if (typeof value === 'string') { try { visit(JSON.parse(value), depth + 1) } catch {} return }
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return }
    if (!value || typeof value !== 'object') return
    const item = value as Record<string, unknown>
    results.push(item)
    for (const key of ['content', 'contentItems', 'text', 'data', 'result', 'output', 'sources', 'citations', 'results', 'items', 'jobs']) visit(item[key], depth + 1)
  }
  visit(output, 0)
  return results
}

export function webActivitySources(output: string | undefined): Array<{ url: string; title: string }> {
  const links = new Map<string, string>()
  const add = (url: unknown, title?: unknown) => {
    const safe = safeActivityUrl(url)
    if (safe && !links.has(safe) && links.size < 12) links.set(safe, typeof title === 'string' && title.trim() ? title.trim() : new URL(safe).hostname)
  }
  for (const item of activityResultObjects(output)) add(item.finalUrl ?? item.url ?? item.href, item.title ?? item.name)
  const text = activityResultText(output)
  for (const match of text.matchAll(/(?:^|\n)(?:\[\d+\]|\d+\.)\s+([^\n]+)\n\s+(https?:\/\/\S+)/g)) add(match[2], match[1])
  for (const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) add(match[2], match[1])
  for (const match of text.matchAll(/https?:\/\/[^\s<>"\\\])}]+/g)) add(match[0].replace(/[.,;，。]+$/, ''))
  return [...links].map(([url, title]) => ({ url, title }))
}

export function activityResultText(output: string | undefined): string {
  const text = activityResultObjects(output).flatMap(item => typeof item.text === 'string' ? [item.text] : typeof item.content === 'string' ? [item.content] : [])
  return text.length ? [...new Set(text)].join('\n') : output ?? ''
}

/** Remove the model-facing error envelope from the human-readable failure reason. */
export function activityErrorText(output: string | undefined): string {
  const text = activityResultText(output)
  const match = /^\s*<tool_use_error(?:\s+tool="[^"]*")?\s*>\r?\n?([\s\S]*?)\r?\n?<\/tool_use_error>\s*$/.exec(text)
  return match?.[1] ?? text
}
