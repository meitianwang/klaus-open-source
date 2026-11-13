import { approvalReview } from '../../../../contracts/approval-review'
import { ApprovalReviewToolDetails } from './approval-review'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { RawHtml } from '../../components/RawHtml'
import { I18N, intlLocale, useT } from '../../i18n'
import { EditActivityTool } from './activity-edit'
import { AgentActionActivityTool } from './activity-agent-action'
import { WidgetTool } from './activity-widget'
import { isAgentActionToolName } from './activity-agent-action-model'
import { ChatActivity, chatActivityCompleted, createdThreadCardId, dynamicActivityLabel, isChatListActivityTool, isCompactActivityTool, mcpActivitySourceName, skillActivityLabel, skillIdentifierFromPath } from './chat-activity'
import { renderCreatedThreadCardHtml, renderDelegationBubbleHtml, renderDelegationLabelHtml, renderDelegationLabelParsedHtml } from './factories'
import { useChatStream, setTurnCollapsed } from '../stream-store'
import styles from './activity-tool.module.css'
import { writeClipboardText } from '../../clipboard'
import { mediaGenerationLabel } from './media-generation-activity'
import { genericActivityLabel, semanticActivityLabel } from './activity-semantic'
import { ImageActivityDetails, ScheduleActivityDetails, WebActivitySources } from './activity-rich-details'
import { FriendActivityDetails } from './activity-friend'

import { activityToolPresentation, activityToolDisplayName, activityShellResult, activityInputText, activityToolIconName, isDynamicActivityPresentation, type ActivityToolData, type ActivityToolProps, type ActivityToolPresentation, type ActivityToolState, type ActivityShellResult } from './activity-tool-model'
import { DELEGATION_TAG_OPEN, findEmbeddedDelegationEnvelopes } from '../../../../contracts/thread-delegation'
export * from './activity-tool-model'

function copyText(locale: string, english: string, chinese: string): string {
  return locale.startsWith('zh') ? chinese : english
}

function elapsedLabel(milliseconds: number | undefined, locale: string): string {
  if (milliseconds === undefined || milliseconds <= 0) return ''
  const seconds = Math.max(1, Math.floor(milliseconds / 1000))
  const unit = (value: number, unit: 'second' | 'minute' | 'hour') => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value)
  if (seconds < 60) return unit(seconds, 'second')
  if (seconds < 3600) return [unit(Math.floor(seconds / 60), 'minute'), seconds % 60 ? unit(seconds % 60, 'second') : ''].filter(Boolean).join(' ')
  return [unit(Math.floor(seconds / 3600), 'hour'), Math.floor(seconds % 3600 / 60) ? unit(Math.floor(seconds % 3600 / 60), 'minute') : ''].filter(Boolean).join(' ')
}

export function activityToolSummary(presentation: ActivityToolPresentation, state: ActivityToolState, open: boolean, locale: string, elapsed?: number): string {
  const { kind, command, path, query, name } = presentation
  if (presentation.generationKind) return mediaGenerationLabel(presentation.generationKind, state, locale)
  if (presentation.semantic) return semanticActivityLabel(presentation.semantic, state, locale)
  const zh = locale.startsWith('zh')
  if (isChatListActivityTool(name, presentation.args)) {
    const translate = (key: string) => (zh ? I18N.zh[key] : I18N.en[key]) || key
    return dynamicActivityLabel(translate, { toolName: name, args: presentation.args, state }, chatActivityCompleted(state))
  }
  if (state === 'awaiting-approval') return zh ? '等待批准' : 'Awaiting approval'
  const active = state === 'running'
  const failed = state === 'error'
  const stopped = state === 'interrupted'
  if (kind === 'discovery') {
    const verb = zh ? active ? '正在搜索工具' : stopped ? '已停止搜索工具' : failed ? '工具搜索失败' : '已搜索工具'
      : active ? 'Searching tools' : stopped ? 'Stopped searching tools' : failed ? 'Tool search failed' : 'Searched tools'
    return `${verb}${query ? zh ? `：${query}` : ` for ${query}` : ''}`
  }
  if (kind === 'image') {
    const count = Math.max(1, presentation.imageCount || 1)
    if (zh) return `${active ? '正在查看' : stopped ? '已停止查看' : failed ? '未能查看' : '已查看'} ${count} 张图像`
    const noun = count === 1 ? 'image' : 'images'
    return `${active ? 'Viewing' : stopped ? 'Stopped viewing' : failed ? 'Failed to view' : 'Viewed'} ${count} ${noun}`
  }
  // The advisor row names the consultation itself; the question and the advice
  // live in the expanded card, so the headline stays a plain state sentence.
  if (name === 'advisor') {
    if (zh) return active ? '正在咨询顾问' : stopped ? '已停止咨询顾问' : failed ? '顾问咨询失败' : '已咨询顾问'
    return active ? 'Consulting advisor' : stopped ? 'Stopped consulting advisor' : failed ? 'Advisor consultation failed' : 'Consulted advisor'
  }
  if (name.startsWith('mcp__')) {
    const label = presentation.source ? `${mcpActivitySourceName(presentation.source)} · ${activityToolDisplayName(name)}` : name
    return failed || stopped ? `${zh ? stopped ? '已停止' : '未能完成' : stopped ? 'Stopped' : 'Failed'} ${label}` : label
  }
  if (kind === 'exec') {
    const time = elapsedLabel(elapsed, locale)
    if (active) return zh ? `${command ? `正在运行 ${command}` : '命令正在运行'}${time ? `，已运行 ${time}` : ''}`
      : `Running ${command || 'command'}${time ? ` for ${time}` : ''}`
    const target = open || !command ? (zh ? '命令' : 'command') : command
    if (stopped) return zh ? `已停止 ${target}${time ? `，用时 ${time}` : ''}` : `Stopped ${target}${time ? ` after ${time}` : ''}`
    if (failed) return zh ? `未能运行 ${target}${time ? `，用时 ${time}` : ''}` : `Failed to run ${target}${time ? ` after ${time}` : ''}`
    return zh ? (time ? `已在 ${time} 内运行 ${target}` : `已运行 ${target}`) : `Ran ${target}${time ? ` in ${time}` : ''}`
  }
  // A SKILL.md read names the skill it loads, exactly like the `skill` tool
  // card does; the market display name replaces the raw directory path.
  if (kind === 'skill') {
    const translate = (key: string) => (zh ? I18N.zh[key] : I18N.en[key]) || key
    const label = skillActivityLabel(translate, skillIdentifierFromPath(path), state)
    return zh ? label : label.charAt(0).toUpperCase() + label.slice(1)
  }
  if (kind === 'read') return zh ? `${active ? '正在读取' : stopped ? '已停止读取' : failed ? '未能读取' : '已读取'}${path ? ` ${path}` : ''}` : `${active ? 'Reading' : stopped ? 'Stopped reading' : failed ? 'Failed to read' : 'Read'}${path ? ` ${path}` : ''}`
  if (kind === 'list') return zh ? `${active ? '正在列出' : stopped ? '已停止列出' : failed ? '未能列出' : '已列出'}${path ? ` ${path} 中的` : ''}文件` : `${active ? 'Listing' : stopped ? 'Stopped listing' : failed ? 'Failed to list' : 'Listed'} files${path ? ` in ${path}` : ''}`
  if (kind === 'search') return zh
    ? `${active ? '正在' : stopped ? '已停止' : failed ? '未能' : '已'}${path ? `${active ? ' ' : '在 '}${path} 中` : ''}${query ? `搜索“${query}”` : '搜索文件'}`
    : `${active ? 'Searching' : stopped ? 'Stopped searching' : failed ? 'Failed to search' : 'Searched'}${query ? ` for ${query}` : ' for files'}${path ? ` in ${path}` : ''}`
  return genericActivityLabel(name, state, locale)
}

interface AnsiChunk { text: string; style: CSSProperties }

const ANSI_PALETTE = ['#000000', '#bb0000', '#00bb00', '#bbbb00', '#0000bb', '#bb00bb', '#00bbbb', '#ffffff', '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff']

function ansiColor(index: number): string {
  if (index < 16) return ANSI_PALETTE[index]
  if (index >= 232) return `rgb(${Array(3).fill(8 + (index - 232) * 10).join(',')})`
  const channel = [0, 95, 135, 175, 215, 255]
  const color = index - 16
  return `rgb(${channel[Math.floor(color / 36)]},${channel[Math.floor(color / 6) % 6]},${channel[color % 6]})`
}

/** Render ANSI styling as React text nodes, never executable HTML. */
export function activityAnsiChunks(source: string): AnsiChunk[] {
  const cleaned = source.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\r\n/g, '\n')
  const chunks: AnsiChunk[] = []
  let style: CSSProperties = {}, column = 0
  const line: Array<{ text: string; style: CSSProperties }> = []
  const flushLine = () => {
    for (const entry of line) {
      const cell = entry ?? { text: ' ', style }
      const previous = chunks.at(-1)
      if (previous && previous.style === cell.style) previous.text += cell.text
      else chunks.push({ ...cell })
    }
    line.length = 0
    column = 0
  }
  const append = (text: string) => {
    for (const character of text) {
      if (character === '\r') column = 0
      else if (character === '\b') { column = Math.max(0, column - 1); line.splice(column, 1) }
      else if (character === '\n') { line.push({ text: '\n', style }); flushLine() }
      else if (character >= ' ' || character === '\t') line[column++] = { text: character, style }
    }
  }
  const pattern = /\x1b\[([0-9;]*)([A-Za-z])/g
  let offset = 0
  for (const match of cleaned.matchAll(pattern)) {
    append(cleaned.slice(offset, match.index))
    offset = match.index! + match[0].length
    if (match[2] === 'K') {
      if (match[1] === '2') line.length = 0
      else line.splice(column)
      continue
    }
    if (match[2] !== 'm') continue
    const codes = (match[1] || '0').split(';').map(Number)
    style = { ...style }
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]
      if (code === 0) style = {}
      else if (code === 1) style.fontWeight = 700
      else if (code === 2) style.opacity = 0.5
      else if (code === 3) style.fontStyle = 'italic'
      else if (code === 4) style.textDecoration = 'underline'
      else if (code === 9) style.textDecoration = 'line-through'
      else if (code === 22) { delete style.fontWeight; delete style.opacity }
      else if (code === 23) delete style.fontStyle
      else if (code === 24 || code === 29) delete style.textDecoration
      else if (code === 39) delete style.color
      else if (code === 49) delete style.backgroundColor
      else if (code >= 30 && code <= 37) style.color = ansiColor(code - 30)
      else if (code >= 90 && code <= 97) style.color = ansiColor(code - 90 + 8)
      else if (code >= 40 && code <= 47) style.backgroundColor = ansiColor(code - 40)
      else if (code >= 100 && code <= 107) style.backgroundColor = ansiColor(code - 100 + 8)
      else if (code === 38 || code === 48) {
        const key = code === 38 ? 'color' : 'backgroundColor'
        if (codes[index + 1] === 5 && codes[index + 2] >= 0 && codes[index + 2] <= 255) { style[key] = ansiColor(codes[index + 2]); index += 2 }
        else if (codes[index + 1] === 2 && codes.slice(index + 2, index + 5).length === 3 && codes.slice(index + 2, index + 5).every(value => value >= 0 && value <= 255)) { style[key] = `rgb(${codes.slice(index + 2, index + 5).join(',')})`; index += 4 }
      }
    }
  }
  append(cleaned.slice(offset))
  flushLine()
  return chunks
}

function AnsiText({ text }: { text: string }) {
  const chunks = useMemo(() => activityAnsiChunks(text), [text])
  return <>{chunks.map((chunk, index) => <span key={index} style={chunk.style}>{chunk.text}</span>)}</>
}

function CopyButton({ text, label, locale }: { text: string; label: string; locale: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const feedback = state === 'copied' ? copyText(locale, 'Copied', '已复制') : state === 'error' ? copyText(locale, 'Copy failed', '复制失败') : ''
  const copy = async () => {
    try { await writeClipboardText(text); setState('copied') } catch { setState('error') }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1500)
  }
  return <>
    <button type="button" className={styles.copyButton} aria-label={feedback || label} onClick={() => void copy()}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={14} />
    </button>
    <span className={styles.srOnly} role="status">{feedback}</span>
  </>
}

function ScrollOutput({ text, copyValue = text, label, locale, terminal = false }: { text: string; copyValue?: string; label: string; locale: string; terminal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ top: false, bottom: false })
  const updateEdges = () => {
    const element = ref.current
    if (!element) return
    const distance = element.scrollHeight - element.clientHeight
    const fromBottom = -element.scrollTop
    const next = { top: distance > 1 && fromBottom < distance - 1, bottom: fromBottom > 1 }
    setEdges(previous => previous.top === next.top && previous.bottom === next.bottom ? previous : next)
  }
  useLayoutEffect(() => {
    updateEdges()
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateEdges)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  return <div className={styles.outputGroup}>
    <div ref={ref} className={styles.outputScroll} tabIndex={0} role="region" aria-label={label} onScroll={updateEdges}
      data-fade-top={edges.top || undefined} data-fade-bottom={edges.bottom || undefined}>
      <pre className={styles.outputText}>{terminal ? <AnsiText text={text} /> : text}</pre>
    </div>
    <CopyButton text={copyValue} label={copyText(locale, 'Copy output', '复制输出')} locale={locale} />
  </div>
}

function DisclosureBody({ open, children, id }: { open: boolean; children: ReactNode; id: string }) {
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
  return <div id={id} className={styles.disclosure} data-open={visible || undefined} aria-hidden={!open} inert={!open}>
    <div className={styles.disclosureInner}>{mounted ? children : null}</div>
  </div>
}

function useElapsed(tool: ActivityToolData, result: ActivityShellResult): number | undefined {
  const clock = useRef<{ id: string; started?: number; elapsed?: number }>({ id: tool.toolCallId })
  const [, tick] = useState(0)
  if (clock.current.id !== tool.toolCallId) clock.current = { id: tool.toolCallId }
  if (tool.state === 'running' && clock.current.started === undefined) clock.current.started = result.startedAtMs ?? Date.now()
  if (tool.state === 'running' && clock.current.started !== undefined) clock.current.elapsed = Math.max(0, Date.now() - clock.current.started)
  useEffect(() => {
    if (tool.state !== 'running') return
    const timer = setInterval(() => tick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [tool.toolCallId, tool.state])
  if (result.durationMs !== undefined && tool.state !== 'running') return result.durationMs
  return clock.current.elapsed
}

function ShellCard({ tool, presentation, result, locale }: { tool: ActivityToolData; presentation: ActivityToolPresentation; result: ActivityShellResult; locale: string }) {
  const [expandedCommand, setExpandedCommand] = useState<string | null>(null)
  const command = presentation.command
  const commandOpen = expandedCommand === command
  const running = tool.state === 'running'
  const interrupted = tool.state === 'interrupted' || result.aborted
  const success = tool.state === 'done' && result.exitCode === 0 && !result.timedOut && !interrupted
  const status = tool.state === 'awaiting-approval' ? copyText(locale, 'Awaiting approval', '等待批准')
    : interrupted ? copyText(locale, 'Stopped', '已停止')
    : result.timedOut ? copyText(locale, 'Timed out', '已超时')
    : success ? copyText(locale, 'Success', '成功')
    : `${copyText(locale, 'Exit code', '退出码')} ${result.exitCode ?? copyText(locale, 'unknown', '未知')}`
  const output = result.output || (running ? '' : copyText(locale, 'No output', '无输出'))
  return <div className={styles.shellCard}>
    <div className={styles.shellName}>{copyText(locale, 'Shell', 'Shell')}</div>
    {command ? <div className={styles.commandGroup}>
      <button type="button" className={styles.command} data-expanded={commandOpen || undefined}
        aria-label={`$ ${command}`} onClick={() => setExpandedCommand(command)}>
        <span className={styles.prompt}>$</span><AnsiText text={command} />
      </button>
      <CopyButton text={command} label={copyText(locale, 'Copy command', '复制命令')} locale={locale} />
    </div> : null}
    {presentation.cwd ? <div className={styles.cwd}><span>{copyText(locale, 'cwd', '工作目录')}</span> {presentation.cwd}</div> : null}
    <ScrollOutput text={output} copyValue={result.output} label={copyText(locale, 'Command output', '命令输出')} locale={locale} terminal />
    <div className={styles.footer}>
      {result.shellId ? <button type="button" className={styles.processButton} onClick={() => (window as any).klausOpenBackgroundProcess?.(result.shellId, tool.sessionId || undefined)}>{copyText(locale, 'Open process', '打开进程')}</button> : null}
      {!running ? <span className={styles.footerStatus}>{success ? <Icon name="check" size={12} /> : null}{status}</span> : null}
    </div>
  </div>
}

/**
 * A tool result carrying one or more delegation envelopes.
 *
 * The engine drains a message delivered mid-turn into the output of the turn's last
 * tool call, so a `read` or `bash` result can end with a raw `<klaus-delegation>`
 * wrapper. Showing that verbatim reads as corruption — it is protocol markup where
 * the user expects their command's output, and it is the exact shape that made a real
 * recipient grep its own repository for tampering.
 *
 * This splits the stored text into the tool's own output plus each envelope, so the
 * output stays byte-for-byte and the envelope renders as a labelled card instead.
 * Returns null when there is nothing to fold, which keeps ordinary tool output on
 * its existing path untouched.
 */
function splitDelegatedToolOutput(text: string): { output: string; delegations: Array<{ sourceThreadId: string | null; sourceHostId?: string; input: string }> } | null {
  if (!text.includes(DELEGATION_TAG_OPEN)) return null
  const found = findEmbeddedDelegationEnvelopes(text)
  if (!found.length) return null
  // Everything that is NOT an envelope, in order: each segment's leading text plus
  // whatever follows the last envelope. Built by index arithmetic rather than by
  // searching for the raw wrapper again — `lastIndexOf` on model-authored text can
  // match an earlier identical occurrence and silently drop real output.
  let output = ''
  let cursor = 0
  for (const segment of found) {
    output += segment.before
    cursor += segment.before.length + segment.raw.length
  }
  output += text.slice(cursor)
  return { output: output.replace(/\s+$/, ''), delegations: found.map(segment => segment.parsed) }
}

export function delegatedToolOutput(
  tool: ActivityToolData,
  presentation = activityToolPresentation(tool),
  result = activityShellResult(tool),
): ReturnType<typeof splitDelegatedToolOutput> {
  const text = presentation.kind === 'exec' ? result.output : tool.output
  return text ? splitDelegatedToolOutput(text) : null
}

/** Keep a tool-result delegation visible until history owns its user-message row. */
function DelegatedToolOutputCard({ delegation, locale }: { delegation: { sourceThreadId: string | null; sourceHostId?: string; input: string }; locale: string }) {
  void locale
  return <div className="msg-group user delegation">
    <RawHtml
      html={renderDelegationLabelParsedHtml(delegation.sourceHostId, delegation.sourceThreadId) + renderDelegationBubbleHtml(delegation.input)}
      />
  </div>
}

/**
 * The advisor consultation reads as a question-and-answer exchange, so its body
 * replaces the generic input/output dump with the question and the advice as two
 * labeled panels. The advice is advisory text from another model, rendered as
 * inert text: no markdown, no HTML, no links.
 */
function AdvisorAdviceCard({ tool, locale }: { tool: ActivityToolData; locale: string }) {
  const question = typeof (tool.args as { question?: unknown })?.question === 'string'
    ? (tool.args as { question: string }).question : ''
  const advice = tool.output ?? ''
  return <div className={styles.advisorCard}>
    <div className={styles.advisorSection}>
      <div className={styles.advisorHeading}>{copyText(locale, 'Question', '请教的问题')}</div>
      <div className={styles.advisorText}>{question || copyText(locale, 'No question supplied', '未提供问题')}</div>
    </div>
    <div className={styles.advisorSection} data-state={tool.state}>
      <div className={styles.advisorHeading}>
        {tool.state === 'error' || tool.state === 'interrupted'
          ? copyText(locale, 'Advisor could not answer', '顾问未能回答')
          : copyText(locale, 'Advice', '顾问建议')}
        <CopyButton text={advice} label={copyText(locale, 'Copy advice', '复制建议')} locale={locale} />
      </div>
      <div className={styles.advisorAdvice} data-state={tool.state}>
        {advice || (tool.state === 'running' ? '' : copyText(locale, 'No advice returned', '没有返回建议'))}
      </div>
    </div>
  </div>
}

function ToolDetails({ tool, presentation, locale }: { tool: ActivityToolData; presentation: ActivityToolPresentation; locale: string }) {
  if (tool.toolName === 'advisor') return <AdvisorAdviceCard tool={tool} locale={locale} />
  const completedImage = presentation.kind === 'image' && tool.state === 'done' && !!presentation.imagePaths?.length
  const input = activityInputText(presentation.args)
  const details = <div className={styles.detailsCard}>
    {tool.toolName.startsWith('mcp__') ? <div className={styles.detailSection}><div className={styles.detailHeading}>{tool.toolName}</div></div> : null}
    <div className={styles.detailSection}>
      <div className={styles.detailHeading}>{copyText(locale, 'Input', '输入')}<CopyButton text={input} label={copyText(locale, 'Copy input', '复制输入')} locale={locale} /></div>
      <pre className={styles.inputText} tabIndex={0}>{input || copyText(locale, 'No input', '无输入')}</pre>
    </div>
    <div className={styles.detailSection}>
      <div className={styles.detailHeading}>{copyText(locale, 'Output', '输出')}</div>
      <ScrollOutput text={tool.output ?? (tool.state === 'running' ? '' : copyText(locale, 'No output', '无输出'))} copyValue={tool.output ?? ''} label={copyText(locale, 'Tool output', '工具输出')} locale={locale} />
    </div>
  </div>
  // The friend card is the whole story: recipient, sent text and one status
  // line. A raw input/output dump under it added nothing the card hides.
  if (presentation.semantic?.category === 'friend') return <FriendActivityDetails tool={tool} locale={locale} />
  return <>
    {presentation.kind === 'image' ? <ImageActivityDetails tool={tool} presentation={presentation} locale={locale} /> : null}
    {presentation.semantic?.category === 'web' ? <WebActivitySources tool={tool} locale={locale} /> : null}
    {presentation.semantic?.category === 'schedule' ? <ScheduleActivityDetails tool={tool} locale={locale} /> : null}
    {completedImage
      ? tool.output?.trim() ? <ScrollOutput text={tool.output} label={copyText(locale, 'Image notes', '图片说明')} locale={locale} /> : null
      : details}
  </>
}

/**
 * Locale is explicit here so the view can also be rendered in offline transcript
 * fixtures.
 *
 * This wrapper exists to fold a delegated message out of the tool output ONCE, above
 * every renderer, rather than inside each card.
 *
 * The engine drains a message delivered mid-turn into the output of that turn's LAST
 * tool call, and that call can be any tool at all — including the ones with their own
 * specialized cards (`EditActivityTool`, `AgentActionActivityTool`), which print
 * `tool.output` straight into a `<pre>`. Folding inside each card is how the first
 * version of this fix shipped with two renderers still leaking raw
 * `<klaus-delegation>` markup, and it would leak again through any card added later.
 *
 * WHICH string to fold depends on the card, and getting it wrong silently does
 * nothing: an exec card prints the DECODED `aggregatedOutput` out of a JSON result
 * envelope, where the wrapper's newlines are escaped as `\n` and the parser cannot
 * match them, while every other card prints `tool.output` verbatim. So the fold
 * targets the string the card will actually print.
 */
export function ActivityToolContent(props: ActivityToolProps & { locale: string; expandedFiles?: Record<string, boolean>; onToggleFile?: (path: string, open: boolean) => void; suppressDelegations?: boolean }) {
  const { tool, locale } = props
  const presentation = useMemo(() => activityToolPresentation(tool), [tool.toolName, tool.args, tool.media, tool.output])
  const result = useMemo(() => activityShellResult(tool), [tool.output, tool.startedAtMs, tool.durationMs, tool.exitCode])
  const isExec = presentation.kind === 'exec'
  const split = useMemo(() => delegatedToolOutput(tool, presentation, result), [presentation, result, tool.output])
  // Only the representation the printed card reads is replaced, so an exec card keeps
  // its JSON result intact for the other fields it renders.
  const strippedTool = !isExec && split ? { ...tool, output: split.output } : tool
  const strippedResult = isExec && split ? { ...result, output: split.output } : result
  return <>
    <ToolCardBody {...props} tool={strippedTool} result={strippedResult} presentation={presentation} locale={locale} />
    {split && !props.suppressDelegations ? <div className={styles.toolDelegationGroup}>
      {split.delegations.map((delegation, index) =>
        <DelegatedToolOutputCard key={index} delegation={delegation} locale={locale} />)}
    </div> : null}
  </>
}

function ToolCardBody({ tool, result, presentation, open, onToggle, locale, expandedFiles, onToggleFile, readOnly }: Omit<ActivityToolProps, 'tool'> & {
  tool: ActivityToolData; result: ActivityShellResult; presentation: ActivityToolPresentation; locale: string
  expandedFiles?: Record<string, boolean>; onToggleFile?: (path: string, open: boolean) => void
}) {
  const elapsed = useElapsed(tool, result)
  const detailsId = useId()
  const summaryId = useId()
  if (tool.toolName === 'show_widget') return <WidgetTool tool={tool} locale={locale}
    fallback={<OrdinaryToolCard tool={tool} result={result} presentation={presentation} open={open}
      onToggle={onToggle} locale={locale} elapsed={elapsed} detailsId={detailsId} summaryId={summaryId} readOnly={readOnly} />} />
  if (!tool.toolName.startsWith('mcp__') && isAgentActionToolName(tool.toolName)) return <AgentActionActivityTool tool={tool} open={open} onToggle={onToggle} locale={locale} />
  if (presentation.kind === 'edit') return <EditActivityTool tool={tool} open={open} onToggle={onToggle} locale={locale} expandedFiles={expandedFiles} onToggleFile={onToggleFile} />
  if (isDynamicActivityPresentation(presentation)) {
    // A successful chat-creation result carries the identity needed for navigation.
    // Render its normal card even when the assistant omitted a separate task link.
    const createdThreadId = createdThreadCardId(tool)
    if (createdThreadId !== null) return <RawHtml className={styles.activityTool} html={renderCreatedThreadCardHtml(createdThreadId)}
      data-created-thread-tool-row data-tool-call-id={tool.toolCallId} data-tool-state={tool.state} />
    if (isCompactActivityTool(tool.toolName, presentation.args) && !isChatListActivityTool(tool.toolName, presentation.args)) return <ChatActivity tool={{ toolName: tool.toolName, args: presentation.args, state: tool.state, toolCallId: tool.toolCallId }} />
  }
  return <OrdinaryToolCard tool={tool} result={result} presentation={presentation} open={open}
    onToggle={onToggle} locale={locale} elapsed={elapsed} detailsId={detailsId} summaryId={summaryId} readOnly={readOnly} />
}

function OrdinaryToolCard({ tool, result, presentation, open, onToggle, locale, elapsed, detailsId, summaryId, readOnly }: {
  tool: ActivityToolData; result: ActivityShellResult; presentation: ActivityToolPresentation; readOnly?: boolean
  open: boolean; onToggle: () => void; locale: string; elapsed: number | undefined; detailsId: string; summaryId: string
}) {
  const exceptional = tool.state === 'error' || tool.state === 'interrupted' || tool.state === 'awaiting-approval'
  // Ordinary tools keep their real input and result inspectable. A successful
  // image inspection keeps thumbnails and accompanying notes; failures retain diagnostic details.
  // Specialized privacy-preserving and agent-action rows returned above retain their own UI.
  const expandable = true
  const declined = presentation.kind === 'exec' && tool.state === 'error' && tool.approvalReviews?.some(review => review.status === 'denied') === true
  const summary = declined && presentation.kind === 'exec' ? copyText(locale, 'Command declined', '命令已拒绝') : activityToolSummary(presentation, tool.state, open, locale, elapsed)
  const icon = activityToolIconName(tool.toolName, tool.args, presentation)
  const pathStart = (presentation.kind === 'read' || presentation.kind === 'image') && !exceptional && presentation.path ? summary.lastIndexOf(presentation.path) : -1
  return <div className={styles.activityTool} data-tool-call-id={tool.toolCallId} data-tool-state={tool.state} data-tool-kind={presentation.kind}>
    <div className={styles.header} data-expandable={expandable || undefined}>
      {expandable ? <button type="button" className={styles.headerButton} aria-labelledby={summaryId} aria-expanded={open} aria-controls={detailsId}
        onClick={event => { event.stopPropagation(); onToggle() }} /> : null}
      <span className={styles.icon} aria-hidden="true"><Icon name={declined ? 'sys-auth-shield-warn' : icon} size={16} /></span>
      <span id={summaryId} className={styles.summary} data-file={pathStart >= 0 || undefined} data-running={tool.state === 'running' || undefined}>
        {pathStart >= 0 ? <><span className={styles.fileVerb}>{summary.slice(0, pathStart).trimEnd()}</span><button type="button" className={styles.fileLink} data-agent-activity-file-link
          aria-label={presentation.path}
          onClick={event => { event.stopPropagation(); (window as any).klausOpenWorkspaceFilePath?.(presentation.path) }}>{presentation.path.split(/[/\\]/).at(-1) || presentation.path}</button></> : summary}
      </span>
      {tool.state === 'error' && !declined ? <span className={styles.errorIndicator} aria-label={copyText(locale, 'Failed', '失败')} /> : null}
      {expandable ? <span className={styles.chevron} data-open={open || undefined} aria-hidden="true"><Icon name="chevron-right" size={14} /></span> : null}
    </div>
    {expandable ? <DisclosureBody id={detailsId} open={open}>
      <div className={styles.body}>{presentation.kind === 'exec' ? <ShellCard tool={tool} presentation={presentation} result={result} locale={locale} /> : <ToolDetails tool={tool} presentation={presentation} locale={locale} />}
        {presentation.kind === 'exec' && !!tool.approvalReviews?.length && <ApprovalReviewToolDetails sessionId={tool.sessionId ?? ''} reviews={tool.approvalReviews} declined={declined} readOnly={readOnly} />}
      </div>
    </DisclosureBody> : null}
  </div>
}

export function ActivityTool(props: ActivityToolProps & { suppressDelegations?: boolean }) {
  useT()
  const overrides = useChatStream(state => state.sessions[props.tool.sessionId || '']?.turnCollapseOverrides)
  const reviewUnits = useChatStream(state => state.sessions[props.tool.sessionId || '']?.liveUnits)
  const history = useChatStream(state => state.sessions[props.tool.sessionId || '']?.history)
  const reviews = new Map<string, NonNullable<ActivityToolData['approvalReviews']>[number]>()
  for (const message of history ?? []) {
    const review = message.kind === 'approval-review' ? approvalReview(message.approvalReview) : undefined
    if (review?.targetItemId === props.tool.toolCallId) reviews.set(review.reviewId, review)
  }
  for (const unit of reviewUnits ?? []) if (unit.type === 'live-approval-review' && unit.review.targetItemId === props.tool.toolCallId) reviews.set(unit.review.reviewId, unit.review)
  const tool = reviews.size ? { ...props.tool, approvalReviews: [...reviews.values()] } : props.tool
  const prefix = `edit:${props.tool.toolCallId}:`
  const expandedFiles = overrides ? Object.fromEntries(Object.entries(overrides).filter(([key]) => key.startsWith(prefix)).map(([key, collapsed]) => [key.slice(prefix.length), !collapsed])) : undefined
  return <ActivityToolContent {...props} tool={tool} locale={intlLocale()} expandedFiles={expandedFiles} onToggleFile={props.tool.sessionId ? (path, open) => setTurnCollapsed(props.tool.sessionId!, `${prefix}${path}`, open) : undefined} />
}
