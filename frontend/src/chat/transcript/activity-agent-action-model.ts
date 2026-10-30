import type { ActivityToolData, ActivityToolState } from './activity-tool-model'

export type AgentActionKind = 'message' | 'interrupt' | 'list' | 'resume' | 'close'

export interface AgentActionRecipient {
  id: string
  name: string
  isParent?: boolean
  description?: string
  role?: string
  model?: string
  status?: string
  statusMessage?: string
  prompt?: string
}

export interface AgentActionPresentation {
  action: AgentActionKind
  state: ActivityToolState
  agents: AgentActionRecipient[]
  count: number
  prompt: string
  input: string
  output: string
  toParent: boolean
  parentIsMain: boolean
}

type ObjectValue = Record<string, unknown>

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function field(value: ObjectValue | null, ...keys: string[]): string {
  for (const key of keys) if (typeof value?.[key] === 'string' && (value[key] as string).trim()) return value[key] as string
  return ''
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

function agentToolName(toolName: string): string {
  if (/^mcp[_.]/i.test(toolName)) return ''
  return toolName.split(/__|[.:/]/).at(-1)?.replace(/[-_]/g, '').toLowerCase() ?? ''
}

/** Native message delivery publishes a notice only after successful acceptance. */
export function isAgentMessageNoticeToolName(toolName: string): boolean {
  return ['sendmessage', 'followuptask'].includes(agentToolName(toolName))
}

export function isHiddenAgentMessageTool(tool: Pick<ActivityToolData, 'toolName' | 'args' | 'output'> & { state: string }): boolean {
  if (!isAgentMessageNoticeToolName(tool.toolName)) return false
  if (tool.state !== 'done' || tool.output == null) return true
  const model = agentActionPresentation({ ...tool, state: 'done', toolCallId: '' })
  return model?.state !== 'done' || !model.agents.length
}

export function sentAgentMessageLabel(locale: string, recipient?: string): string {
  if (locale.startsWith('zh')) return recipient ? `已向 ${recipient} 发送消息` : '已向父代理发送消息'
  return recipient ? `Sent message to ${recipient}` : 'Sent message to parent'
}

/** These names represent control operations, not a newly spawned agent. */
export function agentActionKind(toolName: string): AgentActionKind | null {
  const name = agentToolName(toolName)
  if (['sendinput', 'sendmessage', 'followuptask'].includes(name)) return 'message'
  // In Klaus, shell_id is only a deprecated alias for an agent task_id.
  if (['interruptagent', 'taskstop'].includes(name)) return 'interrupt'
  if (['listagents', 'listpeers'].includes(name)) return 'list'
  if (name === 'resumeagent') return 'resume'
  if (name === 'closeagent') return 'close'
  return null
}

export function isAgentActionToolName(toolName: string): boolean {
  return agentActionKind(toolName) !== null
}

function outputObjects(output: string | undefined): ObjectValue[] {
  const root = parsed(output)
  const queue: unknown[] = [root]
  const result: ObjectValue[] = []
  const seen = new Set<unknown>()
  while (queue.length) {
    const value = queue.shift()
    if (seen.has(value)) continue
    seen.add(value)
    const item = object(value)
    if (!item) continue
    result.push(item)
    for (const key of ['output', 'result', 'data', 'structuredContent', 'serializable']) {
      const child = parsed(item[key])
      if (object(child)) queue.push(child)
    }
    for (const key of ['content', 'model_content']) {
      if (Array.isArray(item[key])) for (const block of item[key]) {
        const content = object(block)
        if (content?.type === 'text' || typeof content?.text === 'string') queue.push(parsed(content?.text))
      }
    }
  }
  if (Array.isArray(root)) result.push({ agents: root })
  return result
}

function stateValue(value: unknown): Pick<AgentActionRecipient, 'status' | 'statusMessage'> {
  if (typeof value === 'string') return { status: value }
  const item = object(value)
  if (!item) return {}
  const status = field(item, 'status', 'state')
  if (status) return { status, statusMessage: field(item, 'message', 'error') || undefined }
  for (const key of ['pendingInit', 'running', 'interrupted', 'shutdown', 'completed', 'errored', 'notFound', 'failed']) {
    if (Object.hasOwn(item, key)) return { status: key, statusMessage: typeof item[key] === 'string' ? item[key] as string : undefined }
  }
  return {}
}

function recipient(value: unknown, fallbackId = ''): AgentActionRecipient | null {
  if (typeof value === 'string') return value.trim() && value !== '*' ? { id: value, name: value } : null
  const item = object(value)
  if (!item) return null
  const thread = object(item.thread)
  const id = field(item, 'threadId', 'thread_id', 'agentId', 'agent_id', 'taskId', 'task_id', 'id', 'peer', 'target', 'name') || fallbackId
  if (!id || id === '*') return null
  const status = stateValue(item.status ?? item.state)
  if (!status.status && typeof item.active === 'boolean') status.status = item.active ? 'running' : 'idle'
  return {
    id,
    name: field(thread, 'agentNickname', 'nickname', 'agentName', 'name', 'title') || field(item, 'agentNickname', 'nickname', 'agentName', 'agent_name', 'displayName', 'name', 'peer', 'title') || id,
    description: field(thread, 'description', 'title') || field(item, 'description', 'title') || undefined,
    role: field(thread, 'agentRole', 'role') || field(item, 'agentRole', 'role', 'agent_type') || undefined,
    model: field(thread, 'model') || field(item, 'model') || undefined,
    ...status,
    statusMessage: status.statusMessage || field(item, 'statusMessage', 'status_message') || undefined,
    prompt: field(item, 'prompt', 'instructions') || undefined,
  }
}

function promptValue(args: ObjectValue | null): string {
  const direct = field(args, 'prompt', 'message', 'instructions')
  if (direct) return direct
  if (object(args?.message)) return printable(args?.message)
  const input = args?.input
  if (typeof input === 'string') return input
  if (Array.isArray(input)) return input.map(part => {
    const item = object(part)
    return field(item, 'text') || (item?.type === 'text' ? printable(item?.content) : '')
  }).filter(Boolean).join('\n')
  return ''
}

export function agentActionPresentation(tool: ActivityToolData): AgentActionPresentation | null {
  const action = agentActionKind(tool.toolName)
  if (!action) return null
  const args = object(parsed(tool.args))
  const parentAlias = action === 'message' && ['target', 'agent_id', 'agentId', 'thread_id', 'threadId', 'id', 'to', 'recipient']
    .some(key => args?.[key] === 'parent')
  const outputs = outputObjects(tool.output)
  const agents = new Map<string, AgentActionRecipient>()
  const add = (value: unknown, fallbackId = '') => {
    const next = recipient(value, fallbackId)
    if (!next) return
    const previous = agents.get(next.id)
    const entries = Object.entries(next).filter(([, value]) => value !== undefined)
    const merged = { ...previous, ...Object.fromEntries(entries) } as AgentActionRecipient
    if (previous && next.name === next.id) merged.name = previous.name
    agents.set(next.id, merged)
  }
  if (action !== 'list') {
    for (const key of ['target', 'agent_id', 'agentId', 'thread_id', 'threadId', 'task_id', 'shell_id', 'id', 'to', 'recipient']) add(args?.[key])
    for (const key of ['targets', 'ids', 'agent_ids', 'recipients']) if (Array.isArray(args?.[key])) for (const value of args[key]) add(value)
  }
  let explicitCount: number | undefined
  for (const output of outputs) {
    if (Array.isArray(output.recipients) && action === 'message') {
      // A broadcast's recipients are the actual delivered targets, including none.
      agents.clear()
      for (const value of output.recipients) add(value)
      explicitCount = agents.size
    }
    for (const key of ['agents', 'peers', 'receiverThreads', 'receiver_threads', 'recipients']) {
      const list = output[key]
      if (Array.isArray(list)) {
        for (const value of list) add(value)
        if (action === 'list') explicitCount = agents.size
      } else if (object(list)) for (const [id, value] of Object.entries(list as ObjectValue)) {
        add({ ...object(value), id, ...stateValue(value) })
      }
    }
    for (const key of ['agentsStates', 'agents_states', 'agent_states']) {
      const states = object(output[key])
      if (states) for (const [id, value] of Object.entries(states)) add({ id, ...stateValue(value) })
    }
    const resultId = field(output, 'agent_id', 'agentId', 'thread_id', 'threadId', 'task_id')
    if (resultId) add({ ...output, id: resultId })
    const statuses = object(output.status)
    if (statuses) {
      const state = stateValue(statuses)
      if (state.status && agents.size === 1) add({ id: [...agents.keys()][0], ...state })
      else if (!state.status) for (const [id, value] of Object.entries(statuses)) add({ id, ...stateValue(value) })
    }
  }
  const failed = outputs.some(output => output.ok === false || output.isError === true || output.is_error === true)
  const state = tool.state === 'done' && failed ? 'error' : tool.state
  // The input alias and resolved delivery identify the same single recipient.
  if (parentAlias && agents.size > 1) agents.delete('parent')
  const recipients = [...agents.values()].sort((a, b) => a.id.localeCompare(b.id)).map(agent => ({ ...agent,
    ...(action === 'message' && (agent.id === tool.parentAgentId || agent.id === tool.sessionId || agent.id === 'parent' || parentAlias && agents.size === 1) ? { isParent: true } : {}),
  }))
  return {
    action, state,
    agents: recipients,
    count: (agents.size || explicitCount === 0) ? agents.size : 1,
    prompt: promptValue(args),
    input: printable(tool.args),
    output: tool.output ?? '',
    toParent: recipients.length === 1 && recipients[0].isParent === true,
    parentIsMain: recipients[0]?.id === tool.sessionId || !tool.parentAgentId || tool.parentAgentId === tool.sessionId,
  }
}

export function parentMessageLabel(state: ActivityToolState, locale: string, mainConversation = false): string {
  if (mainConversation) {
    const labels: Record<ActivityToolState, [string, string]> = {
      running: ['Sending message to main conversation', '正在向主会话发送消息'],
      done: ['Sent message to main conversation', '已向主会话发送消息'],
      error: ['Failed to message main conversation', '向主会话发送消息失败'],
      interrupted: ['Message to main conversation interrupted', '向主会话发送消息已中断'],
      'awaiting-approval': ['Message to main conversation awaiting approval', '向主会话发送消息等待批准'],
    }
    return labels[state][locale.startsWith('zh') ? 1 : 0]
  }
  const labels: Record<ActivityToolState, [string, string]> = {
    running: ['Sending message to parent agent', '正在向父代理发送消息'],
    done: ['Sent message to parent agent', '已向父代理发送消息'],
    error: ['Failed to message parent agent', '向父代理发送消息失败'],
    interrupted: ['Message to parent agent interrupted', '向父代理发送消息已中断'],
    'awaiting-approval': ['Message to parent agent awaiting approval', '向父代理发送消息等待批准'],
  }
  return labels[state][locale.startsWith('zh') ? 1 : 0]
}

const verbs: Record<AgentActionKind, [string, string, string]> = {
  message: ['Messaging', 'Messaged', 'Failed to message'],
  interrupt: ['Interrupting', 'Interrupted', 'Failed to interrupt'],
  list: ['Listing', 'Listed', 'Failed to list'],
  resume: ['Resuming', 'Resumed', 'Failed to resume'],
  close: ['Closing', 'Closed', 'Failed to close'],
}

const chineseVerbs: Record<AgentActionKind, [string, string, string]> = {
  message: ['正在发送消息', '已发送消息', '无法发送消息'],
  interrupt: ['正在中断', '已中断', '中断未成功'],
  list: ['正在列出', '已列出', '列出未成功'],
  resume: ['正在恢复', '已恢复', '无法恢复'],
  close: ['正在关闭', '已关闭', '无法关闭'],
}

export function agentActionLabel(action: AgentActionKind, state: ActivityToolState, locale: string, row = false, hasPrompt = false): string {
  const zh = locale.startsWith('zh')
  if (state === 'interrupted') return zh ? '已中断' : 'Interrupted'
  if (state === 'awaiting-approval') return zh ? '等待批准' : 'Awaiting approval'
  if (!zh && row && state === 'error') {
    if (action === 'message' && !hasPrompt) return 'Failed messaging'
    if (action === 'resume') return 'Failed resuming'
    if (action === 'close') return 'Failed closing'
  }
  return (zh ? chineseVerbs : verbs)[action][state === 'running' ? 0 : state === 'error' ? 2 : 1]
}

export function agentActionCount(count: number, locale: string): string {
  const formatted = new Intl.NumberFormat(locale).format(count)
  return locale.startsWith('zh') ? ` ${formatted} 个智能体` : count === 1 ? ' an agent' : ` ${formatted} agents`
}

export function agentActionStateLabel(status: string, locale: string): string {
  const key = status.replace(/[-_]/g, '').toLowerCase()
  const labels: Record<string, [string, string]> = {
    pendinginit: ['pending init', '待定初始化'], pending: ['pending init', '待定初始化'],
    running: ['running', '正在运行'], interrupted: ['interrupted', '已中断'], stopped: ['interrupted', '已中断'],
    shutdown: ['shutdown', '关闭'], completed: ['completed', '已完成'],
    errored: ['errored', '出错'], failed: ['errored', '出错'], notfound: ['not found', '找不到'],
    idle: ['idle', '空闲'], paused: ['paused', '已暂停'],
  }
  return labels[key]?.[locale.startsWith('zh') ? 1 : 0] ?? status
}
