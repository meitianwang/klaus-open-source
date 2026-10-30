import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { subscribeSubagents, subagentsVersion } from '../subagent-state'
import { subagentDisplayName } from '../subagent-identity'
import type { ActivityToolData } from './activity-tool-model'
import { agentActionCount, agentActionLabel, agentActionPresentation, agentActionStateLabel, isAgentMessageNoticeToolName, isHiddenAgentMessageTool, parentMessageLabel, sentAgentMessageLabel, type AgentActionPresentation, type AgentActionRecipient } from './activity-agent-action-model'
import styles from './activity-agent-action.module.css'
import { writeClipboardText } from '../../clipboard'

export interface AgentActionActivityToolProps {
  tool: ActivityToolData
  open: boolean
  onToggle: () => void
  locale: string
}

const text = (locale: string, english: string, chinese: string) => locale.startsWith('zh') ? chinese : english

function Body({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(open)
  useLayoutEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame)
    }
    setVisible(false)
    const timer = setTimeout(() => setMounted(false), 300)
    return () => clearTimeout(timer)
  }, [open])
  return <div className={styles.disclosure} id={id} data-open={visible || undefined} aria-hidden={!open} inert={!open}>
    <div className={styles.disclosureInner}>{mounted ? <div className={styles.rows}>{children}</div> : null}</div>
  </div>
}

function agentIdentity(agent: AgentActionRecipient, locale: string, sessionId?: string) {
  const panel = typeof window !== 'undefined' && (!sessionId || window.currentSessionId === sessionId) ? window.KlausSubagentPanel : undefined
  const task = panel?.getTask?.(agent.id)
  const conversation = task ? null : panel?.getTaskByConversationId?.(agent.id)
  const peer = !task && !conversation ? panel?.listTasks?.().find((entry: [string, { agentId?: string; agentName?: string }]) => entry[1].agentId === agent.id || entry[1].agentName === agent.id) : undefined
  const taskId = task ? agent.id : conversation?.taskId ?? peer?.[0]
  const knownTask = task ?? conversation?.task ?? peer?.[1]
  const historicalTitle = [agent.id, taskId, agent.role, knownTask?.agentName, knownTask?.agentType].includes(agent.name) ? '' : agent.name
  const name = subagentDisplayName(taskId || agent.id, { description: knownTask?.description || agent.description || historicalTitle }, locale)
  const role = agent.role === 'default' ? '' : agent.role
  return { panel, taskId, name, role, hasName: !!(knownTask?.description || agent.description || historicalTitle) }
}

function AgentName({ agent, locale, sessionId }: { agent: AgentActionRecipient; locale: string; sessionId?: string }) {
  useSyncExternalStore(subscribeSubagents, subagentsVersion, () => 0)
  if (agent.isParent) return <span className={styles.agent}><span className={styles.agentName}>{text(locale, 'parent agent', '父代理')}</span></span>
  const { panel, taskId, name, role } = agentIdentity(agent, locale, sessionId)
  return <span className={styles.agent}>
    {(taskId && panel?.openByTaskId) || panel?.openByConversationId
      ? <button type="button" className={styles.agentName} onClick={() => taskId ? panel?.openByTaskId?.(taskId) : panel?.openByConversationId?.(agent.id)} aria-label={text(locale, `Open ${name}`, `打开 ${name}`)}>{name}</button>
      : <span className={styles.agentName}>{name}</span>}
    {role ? <span> ({role})</span> : null}
  </span>
}

function CopyButton({ value, label, locale }: { value: string; label: string; locale: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const feedback = copyState === 'copied' ? text(locale, 'Copied', '已复制') : copyState === 'error' ? text(locale, 'Copy failed', '复制失败') : ''
  const copy = async () => {
    try { await writeClipboardText(value); setCopyState('copied') } catch { setCopyState('error') }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopyState('idle'), 1500)
  }
  return <><button className={styles.copy} type="button" onClick={() => void copy()} aria-label={feedback || label}><Icon name={copyState === 'copied' ? 'check' : 'copy'} size={14} /></button>
    <span className={styles.srOnly} role="status">{feedback}</span></>
}

function RawDetail({ value, label, locale }: { value: string; label: string; locale: string }) {
  return <details className={styles.rawDetail}>
    <summary>{label}</summary>
    <div className={styles.rawCard}>
      <div className={styles.rawHeader}>{label}<CopyButton value={value} label={text(locale, `Copy ${label.toLowerCase()}`, `复制${label}`)} locale={locale} /></div>
      <pre tabIndex={0}>{value}</pre>
    </div>
  </details>
}

function MessageContent({ value, locale }: { value: string; locale: string }) {
  return <div className={styles.messageContent} data-agent-message-content>
    <div className={styles.messageText}>{value || text(locale, 'No message text', '没有消息正文')}</div>
    {value ? <CopyButton value={value} label={text(locale, 'Copy message', '复制消息')} locale={locale} /> : null}
  </div>
}

function SentMessageNotice({ model, tool, locale }: { model: AgentActionPresentation; tool: ActivityToolData; locale: string }) {
  useSyncExternalStore(subscribeSubagents, subagentsVersion, () => 0)
  if (model.state !== 'done' || !model.agents.length) return null
  return <div className={styles.activity} data-agent-action="message" data-agent-action-id={tool.toolCallId} data-state="done">
    {model.agents.map(agent => {
      const identity = agent.isParent && model.parentIsMain ? null : agentIdentity(agent, locale, tool.sessionId)
      const recipient = identity ? identity.hasName ? identity.name : text(locale, 'Agent', '智能体') : undefined
      return <div key={agent.id} className={styles.messageNotice} data-agent-message-notice data-recipient-id={agent.id}>
        <span className={styles.icon} aria-hidden="true"><Icon name="tc-chat" size={16} /></span>
        <span>{sentAgentMessageLabel(locale, recipient)}</span>
      </div>
    })}
  </div>
}

/** The disclosure describes this operation; recipient status comes only from its result. */
export function AgentActionActivityTool({ tool, open, onToggle, locale }: AgentActionActivityToolProps) {
  const model = useMemo(() => agentActionPresentation(tool), [tool.toolName, tool.args, tool.output, tool.state, tool.parentAgentId, tool.sessionId])
  const bodyId = useId()
  if (!model) return null
  if (isAgentMessageNoticeToolName(tool.toolName)) return isHiddenAgentMessageTool(tool) ? null : <SentMessageNotice model={model} tool={tool} locale={locale} />
  const { action, state, agents, prompt } = model
  const operationLabel = (row = false, hasPrompt = false) => agentActionLabel(action, state, locale, row, hasPrompt)
  const label = model.toParent ? parentMessageLabel(state, locale, model.parentIsMain) : operationLabel()
  const count = model.toParent ? '' : agentActionCount(model.count, locale)
  const summary = label + count
  return <div className={styles.activity} data-agent-action={action} data-agent-action-id={tool.toolCallId} data-state={state}>
    <button type="button" className={styles.header} aria-expanded={open} aria-controls={bodyId} aria-label={summary} onClick={onToggle}>
      <span className={styles.icon} aria-hidden="true"><Icon name={action === 'message' ? 'tc-chat' : 'subagent-banner'} size={16} /></span>
      <span className={styles.summary}><span className={styles.verb} data-running={state === 'running' || undefined}>{label}</span>{count}</span>
      <span className={styles.chevron} data-open={open || undefined} aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
    </button>
    <Body open={open} id={bodyId}>
      {action === 'message' ? <>
        {!model.toParent && agents.length ? <div className={styles.row}>{agents.map(agent => <span key={agent.id} data-recipient-id={agent.id}><AgentName agent={agent} locale={locale} sessionId={tool.sessionId} /> </span>)}</div> : null}
        <MessageContent value={prompt} locale={locale} />
      </> : <>
        {agents.length ? agents.map(agent => {
          const showStatus = action !== 'resume' && action !== 'close' && !!agent.status
          return <div key={agent.id} className={styles.row} data-recipient-id={agent.id}>
            {operationLabel(true)} <AgentName agent={agent} locale={locale} sessionId={tool.sessionId} />{showStatus ? ` (${agentActionStateLabel(agent.status!, locale)}${agent.statusMessage?.trim() ? `: ${agent.statusMessage}` : ''})` : ''}
          </div>
        }) : <div className={styles.row}>{operationLabel(true)}</div>}
        {prompt.trim() ? <div className={styles.inputPrompt}>{text(locale, 'Input: ', '输入：')}{prompt}</div> : null}
        {model.input ? <RawDetail value={model.input} label={text(locale, 'Input', '输入')} locale={locale} /> : null}
        {model.output ? <RawDetail value={model.output} label={text(locale, 'Tool result', '工具结果')} locale={locale} /> : null}
      </>}
    </Body>
  </div>
}
