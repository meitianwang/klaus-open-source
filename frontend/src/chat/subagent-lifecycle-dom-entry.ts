import { mountReactTranscript } from './transcript'
import { chatStreamStore, getSessionStream, ingestChatEvent, loadSessionHistory, prepareSubagentStream } from './stream-store'
import { notifySubagentsChanged } from './subagent-state'
import { coalesceSubagentTaskAliases, navigateToSubagentConversation } from './subagent-navigation'
import type { AgentTask } from './engine-events'
import '../app/tooltip'
import communicationVectors from '../../../contracts/vectors/subagent-communication-vectors.json'

let parent = 'lifecycle-fixture'
const child = 'review-source'
const taskId = 'review-task'
const childTurn = 'source-turn'
const parentTurn = 'parent-turn'
const parentElement = document.querySelector<HTMLElement>('#messages')!
const childElement = document.querySelector<HTMLElement>('#subagent-messages')!
const host = window as any
host.currentLang = 'zh'
host.currentSessionId = parent
let childHistoryReady = false
let childStreamId: string | null = null
let copiedMessage = ''
const parentHistoryWaiters: Array<(value: unknown) => void> = []
const user = { role: 'user', uuid: 'request', turnId: parentTurn, text: '检查代码并验证发布流程。' }
const childHistory = [
  { role: 'user', uuid: 'child-user', turnId: childTurn, text: '检查子智能体会话。' },
  { role: 'assistant', uuid: 'child-process', turnId: childTurn, contentBlocks: [
    { type: 'text', messageId: 'child-comment', text: '正在检查会话渲染链路。', phase: 'commentary' },
    { type: 'tool_use', id: 'child-command', name: 'exec_command', input: { cmd: 'npm run verify' }, __result: { text: 'round 1\nround 2\nAll checks passed', isError: false } },
    { type: 'text', messageId: 'child-final', text: '会话检查已完成。', phase: 'final_answer' },
  ] },
]
host.klaus = {
  clipboard: { writeText: async (value: string) => { copiedMessage = value } },
  session: { history: () => new Promise(resolve => parentHistoryWaiters.push(resolve)) },
  agents: { history: async (_parent: string, agentId: string) => ({ messages: agentId === child && childHistoryReady ? childHistory : [] }) },
}
const tasks = () => getSessionStream(parent).agentTasks
host.KlausSubagentPanel = {
  listTasks: () => Object.entries(tasks()),
  getTask: (id: string) => tasks()[id],
  getTaskByConversationId: (id: string) => {
    const entry = Object.entries(tasks()).find(([, task]) => task.agentId === id)
    return entry ? { taskId: entry[0], task: entry[1] } : null
  },
  openByTaskId: (id: string) => {
    const task = tasks()[id]
    if (!task) return
    const streamId = prepareSubagentStream(parent, id, task)
    childStreamId = streamId
    parentElement.hidden = true
    childElement.hidden = false
    document.querySelector<HTMLElement>('#back')!.hidden = false
    mountReactTranscript(streamId, childElement, { readOnly: true, contextSessionId: parent })
  },
  openByConversationId: (id: string) => navigateToSubagentConversation(id, {
    selectedSessionId: () => parent,
    tasks: () => tasks(),
    snapshot: async () => ({ tasks: { 'uncached-child': { agentId: 'uncached-child', description: 'Discovered review', status: 'running' } } }),
    merge: (_sessionId, incoming) => {
      chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [parent]: { ...getSessionStream(parent), agentTasks: coalesceSubagentTaskAliases({ ...tasks(), ...incoming }) } } }))
      notifySubagentsChanged()
    },
    open: id => host.KlausSubagentPanel.openByTaskId(id),
    unavailable: () => { throw new Error('Unavailable child in fixture') },
  }),
}
function send(event: any) {
  ingestChatEvent({ sessionId: parent, ...event })
  notifySubagentsChanged()
}
function sendChild(event: any) { send({ type: 'agent_progress', agentId: child, event }) }
function back() {
  parentElement.hidden = false
  childElement.hidden = true
  document.querySelector<HTMLElement>('#back')!.hidden = true
}
document.querySelector('#back')!.addEventListener('click', back)
const frames = async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame) }
async function start() {
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [parent]: { ...getSessionStream(parent), history: [user], running: true } } }))
  mountReactTranscript(parent, parentElement)
  send({ type: 'stream_mode', mode: 'requesting', turnId: parentTurn })
  send({ type: 'tasks_changed', tasks: { [taskId]: { agentId: child, avatarId: 0, description: 'Repository scope', status: 'running' } } })
  send({ type: 'text_delta', messageId: 'parent-comment', text: '正在检查发布流程，两个子智能体分别审核代码和验证回归。', phase: 'commentary' })
  send({ type: 'tasks_changed', tasks: { ...tasks(), gate: { agentId: 'review-gate', avatarId: 2, description: 'Push gate impl', status: 'running' } } })
  sendChild({ type: 'stream_mode', mode: 'requesting', turnId: childTurn })
  sendChild({ type: 'text_delta', messageId: 'child-comment', text: '正在检查', phase: 'commentary' })
  sendChild({ type: 'text_delta', messageId: 'child-comment', text: '会话渲染链路。', phase: 'commentary' })
  sendChild({ type: 'tool_start', toolCallId: 'child-command', toolName: 'exec_command', args: { cmd: 'npm run verify' } })
  sendChild({ type: 'progress', toolCallId: 'child-command', content: 'round 1\n' })
  await frames()
}
async function progress() {
  sendChild({ type: 'progress', toolCallId: 'child-command', content: 'round 2\n' })
  await frames()
}
async function finishChild() {
  sendChild({ type: 'tool_end', toolCallId: 'child-command', toolName: 'exec_command', content: 'round 1\nround 2\nAll checks passed', isError: false })
  sendChild({ type: 'text_delta', messageId: 'child-final', text: '会话检查已完成。', phase: 'final_answer' })
  sendChild({ type: 'done', turnId: childTurn, finalMessageId: 'child-final' })
  send({ type: 'tasks_changed', tasks: { ...tasks(), [taskId]: { ...tasks()[taskId], status: 'completed' } } })
  await frames()
}
async function finishParent() {
  send({ type: 'text_delta', messageId: 'parent-final', text: '代码检查完成，等待发布验证结束。', phase: 'final_answer' })
  send({ type: 'done', turnId: parentTurn, finalMessageId: 'parent-final' })
  await frames()
}
async function finishGate(status = 'completed') {
  send({ type: 'tasks_changed', tasks: { ...tasks(), gate: { ...tasks().gate, status } } })
  await frames()
}
async function handoff() {
  const history = [user,
    { role: 'assistant', uuid: 'parent-process', turnId: parentTurn, text: '正在检查发布流程，两个子智能体分别审核代码和验证回归。', phase: 'commentary' },
    { role: 'assistant', uuid: 'parent-final-history', turnId: parentTurn, text: '代码检查完成，等待发布验证结束。', phase: 'final_answer' },
  ]
  for (const resolve of parentHistoryWaiters.splice(0)) resolve({ messages: history })
  childHistoryReady = true
  await loadSessionHistory(prepareSubagentStream(parent, taskId, tasks()[taskId]!))
  await frames()
}
const crowdTasks = () => Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`crowd-${index}`, {
  agentId: `crowd-child-${index}`, avatarId: index % 7, status: 'running',
  description: `${index + 1}. Review conversation ownership and lifecycle rendering 会话过程检查`,
}]))
async function crowdStart() {
  back()
  host.currentLang = 'zh'
  window.dispatchEvent(new Event('klaus:lang-change'))
  document.documentElement.dataset.theme = 'light'
  parent = 'crowd-fixture'
  host.currentSessionId = parent
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [parent]: { ...getSessionStream(parent), history: [
    { role: 'user', uuid: 'crowd-request', turnId: 'crowd-turn', text: '并行检查 20 个模块的会话过程。' },
  ], running: true } } }))
  mountReactTranscript(parent, parentElement)
  await frames()
  send({ type: 'stream_mode', mode: 'requesting', turnId: 'crowd-turn' })
  send({ type: 'tasks_changed', tasks: crowdTasks() })
  await frames()
}
async function crowdFinish() {
  send({ type: 'text_delta', messageId: 'crowd-comment', text: '并行检查完成，正在汇总各模块的结果。', phase: 'commentary' })
  send({ type: 'text_delta', messageId: 'crowd-final', text: '模块检查结束，失败与取消详情保留在会话过程中。', phase: 'final_answer' })
  send({ type: 'done', turnId: 'crowd-turn', finalMessageId: 'crowd-final' })
  send({ type: 'tasks_changed', tasks: Object.fromEntries(Object.entries(tasks()).map(([id, task], index) => [id, {
    ...task, status: index === 18 ? 'failed' : index === 19 ? 'cancelled' : 'completed',
  }])) })
  await frames()
}
async function crowdHistory(mixedResume = false, live = false) {
  const taskSnapshot = Object.fromEntries(Object.entries(crowdTasks()).map(([id, task], index) => [id, {
    ...task, spawnTurnId: 'crowd-turn', status: index === 18 ? 'failed' : index === 19 ? 'cancelled' : 'completed',
  }]))
  const notice = (id: string, task: any, status: string, suffix: string) => ({
    kind: 'agent-event', uuid: `${id}-${suffix}`, turnId: 'crowd-turn',
    agentEvent: { taskId: id, agentId: task.agentId, name: task.description, status },
  })
  const history = [
    { role: 'user', uuid: 'crowd-request', turnId: 'crowd-turn', text: '并行检查 20 个模块的会话过程。' },
    ...Object.entries(taskSnapshot).map(([id, task]) => notice(id, task, 'started', 'start')),
    { role: 'assistant', uuid: 'crowd-comment-history', turnId: 'crowd-turn', text: '并行检查完成，正在汇总各模块的结果。', phase: 'commentary' },
    { role: 'assistant', uuid: 'crowd-final-history', turnId: 'crowd-turn', text: '模块检查结束，失败与取消详情保留在会话过程中。', phase: 'final_answer' },
    { role: 'user', uuid: 'next-user', turnId: 'next-turn', text: '继续处理下一轮。' },
    { role: 'assistant', uuid: 'next-comment', turnId: 'next-turn', text: '正在检查下一轮。', phase: 'commentary' },
    { role: 'assistant', uuid: 'next-final', turnId: 'next-turn', text: '下一轮已完成。', phase: 'final_answer' },
    ...(mixedResume ? [{ role: 'assistant', uuid: 'resumed-comment', turnId: 'crowd-turn', text: '普通后续说明保留在原来的位置。', phase: 'commentary' }] : []),
    // These are actual saved rows, not the synthetic delivery ledger path.
    ...Object.entries(taskSnapshot).map(([id, task]) => notice(id, task, task.status || 'completed', 'terminal')),
  ]
  parent = `crowd-history-fixture-${mixedResume}-${live}`
  host.currentSessionId = parent
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [parent]: { ...getSessionStream(parent),
    history: live ? [] : history, liveUnits: live ? history.map((message: any) => message.kind === 'agent-event'
      ? { type: 'live-agent-event' as const, key: message.uuid, turnId: message.turnId, timestamp: 1, ...message.agentEvent }
      : message.role === 'user'
        ? { type: 'live-user' as const, key: message.uuid, turnId: message.turnId, msg: message }
        : { type: 'live-text' as const, key: message.uuid, turnId: message.turnId, text: message.text, phase: message.phase, streaming: false }) : [],
    liveTurnId: live ? 'next-turn' : null, activeTurnId: null, running: false,
    agentTasks: taskSnapshot, agentTimeline: [], historyStale: false, turnCollapseOverrides: {}, turnStatuses: { 'crowd-turn': 'completed', 'next-turn': 'completed' },
  } } }))
  mountReactTranscript(parent, parentElement)
  await frames()
}
async function uncachedHistory() {
  parent = 'uncached-fixture'
  host.currentSessionId = parent
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [parent]: { ...getSessionStream(parent), history: [
    { kind: 'agent-event', uuid: 'uncached-start', turnId: 'uncached-parent-turn', agentEvent: { taskId: 'uncached-child', agentId: 'uncached-child', name: 'Discovered review', status: 'started' } },
  ], agentTasks: {} } } }))
  mountReactTranscript(parent, parentElement)
  await frames()
}
async function registerUncachedChild() {
  send({ type: 'agent_progress', agentId: 'uncached-child', event: { type: 'stream_mode', mode: 'requesting', turnId: 'uncached-run' } })
  send({ type: 'agent_progress', agentId: 'uncached-child', event: { type: 'text_delta', messageId: 'uncached-text', text: '子会话正在持续更新。', phase: 'commentary' } })
  send({ type: 'tasks_changed', tasks: { dispatch: { agentId: 'uncached-child', description: 'Discovered review', status: 'running' } } })
  await frames()
}
async function fallbackHistory(missing = false) {
  parent = `fallback-history-fixture-${missing}`
  host.currentSessionId = parent
  const task = { agentId: 'saved-child', avatarId: 48, description: 'Saved review', status: 'completed', spawnTurnId: 'saved-turn' }
  const savedTasks: Record<string, AgentTask> = missing ? {} : { 'saved-spawn': task }
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [parent]: { ...getSessionStream(parent), agentTasks: savedTasks, history: [
    { role: 'user', uuid: 'saved-user', turnId: 'saved-turn', text: '查看之前保存的检查过程。' },
    { role: 'assistant', uuid: 'saved-tool', turnId: 'saved-turn', contentBlocks: Array.from({ length: missing ? 4 : 1 }, (_, index) => ({ type: 'tool_use', id: missing ? `missing-${index}` : 'saved-spawn', name: 'spawn_agent', input: missing ? { description: `Saved review ${index}` } : {}, __result: { text: 'Started', isError: false } })) },
    { role: 'assistant', uuid: 'saved-final', turnId: 'saved-turn', text: '之前的检查已完成。', phase: 'final_answer' },
  ], turnStatuses: { 'saved-turn': 'completed' } } } }))
  mountReactTranscript(parent, parentElement)
  await frames()
}
async function aliasHistory() {
  parent = 'alias-history-fixture'
  host.currentSessionId = parent
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [parent]: { ...getSessionStream(parent),
    agentTasks: { dispatch: { agentId: 'alias-child', agentName: 'Review API', description: 'API review', avatarId: 48, status: 'completed', spawnTurnId: 'alias-parent' } },
    history: [
      { kind: 'agent-event', uuid: 'alias-start', turnId: 'alias-parent', agentEvent: { taskId: 'dispatch', agentId: 'alias-child', name: 'API review', status: 'started' } },
      { role: 'assistant', uuid: 'alias-comment', turnId: 'alias-parent', text: '正在检查接口。', phase: 'commentary' },
      { kind: 'agent-event', uuid: 'alias-update', turnId: 'alias-parent', agentEvent: { taskId: 'Review API', name: 'Review API', status: 'updated' } },
      { role: 'assistant', uuid: 'alias-final', turnId: 'alias-parent', text: '接口检查已完成。', phase: 'final_answer' },
    ], turnStatuses: { 'alias-parent': 'completed' },
  } } }))
  mountReactTranscript(parent, parentElement)
  await frames()
}
async function communicationStart() {
  back()
  parent = 'communication-fixture'
  host.currentSessionId = parent
  host.currentLang = 'en'
  window.dispatchEvent(new Event('klaus:lang-change'))
  document.documentElement.dataset.theme = 'light'
  await start()
  const content = structuredClone(communicationVectors.cases[0]!.content)
  content[0]!.text = content[0]!.text!.replace('parent-session', parent)
  const event = { type: 'user_message', message: { uuid: 'communication-received', isMeta: true, message: { content } } }
  sendChild(event)
  sendChild(event)
  await frames()
}
async function communicationReplay() {
  const received = { role: 'user', uuid: 'communication-received', kind: 'agent-message', turnId: childTurn,
    text: communicationVectors.cases[0]!.expected!.text,
    agentMessage: { ...communicationVectors.cases[0]!.expected!, senderId: parent } }
  host.klaus.agents.history = async () => ({ messages: [childHistory[0], received, childHistory[1]] })
  await finishChild()
  await loadSessionHistory(childStreamId!)
  sendChild({ type: 'user_message', message: { uuid: 'communication-received', isMeta: true,
    message: { content: communicationVectors.cases[0]!.content } } })
  await frames()
}
async function queuedNavigation() {
  back()
  parent = 'queued-navigation-fixture'
  host.currentSessionId = parent
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [parent]: { ...getSessionStream(parent), history: [], running: true } } }))
  mountReactTranscript(parent, parentElement)
  send({ type: 'stream_mode', mode: 'requesting', turnId: 'message-turn' })
  send({ type: 'tool_start', toolCallId: 'queued-message', toolName: 'send_message', args: { to: 'uncached-child', message: 'Inspect this communication.' } })
  send({ type: 'tool_end', toolCallId: 'queued-message', toolName: 'send_message', content: JSON.stringify({ ok: true, agentId: 'uncached-child', resumed: false }) })
  await frames()
}
async function outgoingParentStart() {
  back()
  parent = 'outgoing-parent-fixture'
  host.currentSessionId = parent
  host.currentLang = 'zh'
  document.documentElement.dataset.theme = 'light'
  window.dispatchEvent(new Event('klaus:lang-change'))
  host.klaus.agents.history = async () => ({ messages: [] })
  await start()
  sendChild({ type: 'tool_start', toolCallId: 'parent-mail', toolName: 'send_message',
    args: { target: 'parent', message: communicationVectors.parentAction.message } })
  await frames()
}
async function outgoingParentFinish() {
  sendChild({ type: 'tool_end', toolCallId: 'parent-mail', toolName: 'send_message',
    content: JSON.stringify({ ok: true, agentId: parent, recipients: [parent], delivery: 'queued', resumed: false }) })
  const content = structuredClone(communicationVectors.cases[0]!.content)
  content[0]!.text = content[0]!.text!.replace('parent-session', child)
  content[1]!.text = communicationVectors.parentAction.message
  send({ type: 'user_message', message: { uuid: 'parent-mail-received', isMeta: true, message: { content } } })
  await frames()
}
async function outgoingParentReplay() {
  const process = childHistory[1]!
  host.klaus.agents.history = async () => ({ messages: [childHistory[0], { ...process, contentBlocks: [
    ...process.contentBlocks!.slice(0, -1), { type: 'tool_use', id: 'parent-mail', name: 'send_message',
      input: { target: 'parent', message: communicationVectors.parentAction.message },
      __result: { content: [{ type: 'text', text: 'Message queued for agent: ' + parent }],
        agentCommunication: { ok: true, agentId: parent, recipients: [parent], delivery: 'queued', resumed: false } } },
    process.contentBlocks!.at(-1)!,
  ] }] })
  await finishChild()
  await loadSessionHistory(childStreamId!)
  await frames()
}
async function nestedStart() {
  back()
  parent = 'nested-conversation-fixture'
  host.currentSessionId = parent
  host.currentLang = 'en'
  window.dispatchEvent(new Event('klaus:lang-change'))
  host.klaus.agents.history = async () => ({ messages: [] })
  await start()
  send({ type: 'agent_progress', agentId: 'nested-child', parentAgentId: child, spawnTurnId: childTurn, depth: 2,
    event: { type: 'stream_mode', mode: 'requesting', turnId: 'nested-run' } })
  send({ type: 'agent_progress', agentId: 'nested-child', parentAgentId: child, spawnTurnId: childTurn, depth: 2,
    event: { type: 'text_delta', messageId: 'nested-comment', text: 'The nested conversation owns this progress.', phase: 'commentary' } })
  send({ type: 'agent_progress', agentId: 'nested-child', parentAgentId: child, spawnTurnId: childTurn, depth: 2,
    event: { type: 'tool_start', toolCallId: 'nested-parent-mail', toolName: 'send_message', args: { to: child, message: 'Nested parent report' } } })
  send({ type: 'agent_progress', agentId: 'nested-child', parentAgentId: child, spawnTurnId: childTurn, depth: 2,
    event: { type: 'tool_end', toolCallId: 'nested-parent-mail', toolName: 'send_message', content: JSON.stringify({ ok: true, agentId: child, recipients: [child], delivery: 'queued' }) } })
  send({ type: 'tasks_changed', tasks: { ...tasks(), 'nested-call': {
    agentId: 'nested-child', parentAgentId: child, spawnTurnId: childTurn, depth: 2, description: 'Nested review', status: 'running',
  } } })
  await frames()
}
async function queuedReplay() {
  const queued = communicationVectors.queuedAction
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [parent]: { ...getSessionStream(parent), running: false,
    activeTurnId: null, liveTurnId: null, liveUnits: [], history: [
      { role: 'user', uuid: 'queued-request', text: 'Coordinate the review.', turnId: 'message-turn' },
      { role: 'assistant', uuid: 'queued-process', turnId: 'message-turn', contentBlocks: [{ type: 'tool_use', id: 'queued-message',
        name: queued.toolName, input: { to: 'uncached-child', message: 'Inspect this communication.' },
        __result: { content: [{ type: 'text', text: queued.modelText }], agentCommunication: { ...queued.output, agentId: 'uncached-child' } } }] },
      { role: 'assistant', uuid: 'queued-final', turnId: 'message-turn', text: 'The message is waiting for the recipient.', phase: 'final_answer', isFinalReply: true },
    ], turnStatuses: { 'message-turn': 'completed' } } } }))
  mountReactTranscript(parent, parentElement)
  await frames()
}
async function nestedFinish() {
  send({ type: 'agent_progress', agentId: 'nested-child', parentAgentId: child, spawnTurnId: childTurn, depth: 2,
    event: { type: 'text_delta', messageId: 'nested-final', text: 'Nested review is complete.', phase: 'final_answer' } })
  send({ type: 'agent_progress', agentId: 'nested-child', parentAgentId: child, spawnTurnId: childTurn, depth: 2,
    event: { type: 'done', turnId: 'nested-run', finalMessageId: 'nested-final' } })
  await frames()
}
function snapshot() {
  const visible = parentElement.hidden ? childElement : parentElement
  const images = [...visible.querySelectorAll<HTMLImageElement>('img')]
  return {
    text: visible.innerText,
    communications: [...visible.querySelectorAll<HTMLElement>('[data-agent-message-id]')].map(row => ({
      id: row.dataset.agentMessageId, senderId: row.dataset.agentSenderId, text: row.innerText,
      copyText: row.querySelector<HTMLElement>('[data-copy-text]')?.dataset.copyText,
      forbiddenActions: row.querySelectorAll('[data-action="edit"], [data-action="rewind"], [title], [data-klaus-tip]').length,
      width: row.getBoundingClientRect().width,
    })),
    sentNotices: [...visible.querySelectorAll<HTMLElement>('[data-agent-message-notice]')].map(row => ({
      callId: row.closest<HTMLElement>('[data-agent-action-id]')?.dataset.agentActionId,
      recipientId: row.dataset.recipientId,
      text: row.innerText,
      interactive: row.querySelectorAll('button, a, summary, [tabindex], [aria-expanded]').length,
      width: row.getBoundingClientRect().width,
      scrollWidth: row.scrollWidth,
    })),
    outgoingStatus: getSessionStream(parentElement.hidden ? childStreamId! : parent).tools['parent-mail']?.status,
    rows: [...visible.querySelectorAll<HTMLElement>('[data-agent-event]')].map(row => ({ status: row.dataset.agentEvent, text: row.innerText, inlineText: row.textContent,
      insideProcess: !!row.closest('[data-variant="turn"]'), avatars: row.querySelectorAll('.subagent-avatar').length,
      destinations: [...row.querySelectorAll<HTMLElement>('[data-agent-conversation-id]')].map(button => button.dataset.agentConversationId),
      width: row.getBoundingClientRect().width, height: row.getBoundingClientRect().height,
      controlsFit: [...row.querySelectorAll<HTMLElement>('button')].every(button => {
        const rect = button.getBoundingClientRect(), bounds = row.getBoundingClientRect()
        return rect.width > 0 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
      }),
    })),
    folds: [...visible.querySelectorAll<HTMLElement>('[data-variant="turn"]')].map(fold => ({ open: fold.dataset.open, label: fold.querySelector('button')?.textContent })),
    tool: visible.querySelector('[data-tool-call-id="child-command"]')?.getAttribute('data-tool-state'),
    toolOpen: visible.querySelector('[data-tool-call-id="child-command"] button[aria-expanded]')?.getAttribute('aria-expanded'),
    child: !childElement.hidden,
    childStreamId,
    copiedMessage,
    animatedAvatars: visible.querySelectorAll('[data-animate-entrance]').length,
    streamingText: getSessionStream(parentElement.hidden ? childStreamId! : parent).liveUnits.some(unit => unit.type === 'live-text' && unit.streaming),
    imagesLoaded: images.every(img => img.complete && img.naturalWidth > 0),
    avatarsDrawn: visible.querySelectorAll('.subagent-avatar svg .subagent-avatar-mark rect').length > 0,
  }
}
host.lifecycleFixture = { outgoingParentStart, outgoingParentFinish, outgoingParentReplay, queuedReplay, nestedStart, nestedFinish, communicationStart, communicationReplay, queuedNavigation, start, progress, finishChild, finishParent, finishGate, handoff, crowdStart, crowdFinish, crowdHistory, fallbackHistory, aliasHistory, uncachedHistory, registerUncachedChild, snapshot, back, frames,
  language: async (lang: string) => { host.currentLang = lang; window.dispatchEvent(new Event('klaus:lang-change')); await frames() } }
