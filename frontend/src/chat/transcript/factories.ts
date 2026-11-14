import { composerTokenClipboardText } from '../composer/clipboard-token-text'
import { composerDocumentText, restoreComposerDocument } from '../composer/document-model'
import { questionResolution, resolvedQuestionPresentation } from './question-state'
// Transcript HTML 工厂（迁自 js/chat.js 消息渲染域的纯函数层）：转义、工具卡
// 分类/图标/状态/Input-Output 块、思考排版、user 附件卡、粘贴卡、teammate
// 解析。HTML 结构逐字节对齐旧版——React 组件层以 dangerouslySetInnerHTML
// 消费这些工厂，交互（toggle/copy/预览）由组件层绑定。
// 依赖 window 垫片的少数域函数（slash pill / workspace mention pill /
// 图片预览）在组件层经 w() 调用，不在本文件。
import styles from './transcript.module.css'
import { rawIconHtml } from '../../components/Icon'
import { t as tGlobal } from '../../i18n'
import { chatActivityKind } from './chat-activity'
import { deviceNameForHost, localDeviceId } from '../device-names'
import { activityToolIconName } from './activity-tool-model'
import { renderMarkdownHtml } from '../markdown'
import { parseDelegationEnvelope } from '../../../../contracts/thread-delegation'
import { parseSelectedTextEnvelope } from '../selected-text-envelope'
import { stripGoalImageReferences } from '../goals/goal-image-references'
import { formatWorkflowDuration, type GoalCompletionSummary } from './goal-completion'
import { pastedCardPreview, parsePastedReferenceSection, pastedTextPreview } from '../composer/pasted-text'
import { renderFriendMessageHtml, summarizeFriendMessage } from '../../friend-message-summary'

export function escapeHtml(str: unknown): string {
  return str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''
}

// ==================== thinking 排版 ====================
// 行首 **标题** 提升为块级 headline，其余原样转义（pre-wrap 展示）。
export function formatThinkingHtml(text: unknown): string {
  const src = String(text || '')
  const out: string[] = []
  let plain = ''
  let atLineStart = true
  let i = 0
  const flushPlain = () => { if (plain) { out.push(escapeHtml(plain)); plain = '' } }
  while (i < src.length) {
    if (atLineStart && src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2)
      const inner = end > i + 2 ? src.slice(i + 2, end) : ''
      if (inner && !inner.includes('\n')) {
        flushPlain()
        out.push(`<span class="${styles['thinking-headline']}">${escapeHtml(inner)}</span>`)
        i = end + 2
        // 标题本身是块级元素，吃掉紧随的一个换行避免 pre-wrap 下多出空行。
        if (src[i] === '\n') i++
        atLineStart = true
        continue
      }
    }
    const ch = src[i]
    plain += ch
    atLineStart = ch === '\n'
    i++
  }
  flushPlain()
  return out.join('')
}

// ==================== 工具卡 ====================

export function getToolCategory(name: string): string {
  if (chatActivityKind(name)) return ''
  if (/bash/i.test(name)) return 'terminal'
  if (/file|read|write|edit|glob|notebook/i.test(name)) return 'file'
  if (/grep|search|web/i.test(name)) return 'search'
  // 引擎子 agent 工具名是 'task'（不含 'agent'）；精确匹配 task（不含 task_output/task_stop 等
  // 后台控制工具），归入 agent 类 → 走嵌套卡，避免与 Monitor 任务面板重复信息。
  if (/agent/i.test(name) || /^task$/i.test(name)) return 'agent'
  if (/advisor/i.test(name)) return 'search'
  return ''
}

const SYSTEM_REMINDER_RE = /\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/g
export function sanitizeToolOutput(text: unknown): string {
  if (typeof text !== 'string' || !text) return ''
  return text.replace(SYSTEM_REMINDER_RE, '').trimEnd()
}

// 工具结果里的媒体块：shell 侧 normalize_output_blocks 已把 base64 落进内容寻址
// 池并只传 path（engine.rs to_media_block），此处只搬运 path，src 由组件层经
// klaus.media.url 拼装 —— 本文件不碰 window。
export interface ReplayToolMedia { path: string; mimeType?: string; sourcePath?: string }
/**
 * A clickable "open this surface" card in the transcript. The kind selects which
 * in-app panel it opens and which copy it shows; the host is the only thing that
 * can mint one, and it only does so for a built-in visual tool it recognises.
 */
export type VisualArtifactKind = 'diagram' | 'model3d' | 'prototype' | 'video-editing' | 'ppt'
export interface VisualArtifact {
  kind: VisualArtifactKind
  id: string
  title: string
  /** Whether the surface already held content when the card was published; absent means unknown (ready copy). */
  ready?: boolean
}
export interface ReplayToolResult {
  text: string
  isError: boolean
  media: ReplayToolMedia[]
  artifact?: VisualArtifact
}

const VISUAL_ARTIFACT_KINDS: readonly string[] = ['diagram', 'model3d', 'prototype', 'video-editing', 'ppt']
const VISUAL_ARTIFACT_FALLBACK_TITLE: Record<VisualArtifactKind, string> = { diagram: 'Diagram', model3d: '3D scene', prototype: 'Prototype', 'video-editing': 'Video Editing', ppt: 'PPT' }

export function normalizeVisualArtifact(value: unknown): VisualArtifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const artifact = value as Record<string, unknown>
  const kind = artifact.kind
  // An unknown kind is dropped rather than guessed at: it would render a card
  // whose click opens nothing, which is worse than no card.
  if (typeof kind !== 'string' || !VISUAL_ARTIFACT_KINDS.includes(kind)) return undefined
  if (typeof artifact.id !== 'string' || !artifact.id) return undefined
  const surface = kind as VisualArtifactKind
  return {
    kind: surface,
    id: artifact.id,
    title: typeof artifact.title === 'string' && artifact.title.trim() ? artifact.title : VISUAL_ARTIFACT_FALLBACK_TITLE[surface],
    ...(typeof artifact.ready === 'boolean' ? { ready: artifact.ready } : {}),
  }
}

/**
 * Empty editor documents show their created state until content is published.
 * Other surfaces only ever publish ready cards. An absent flag keeps the ready
 * copy for saved history that predates explicit content state.
 */
export function visualArtifactHintState(artifact: VisualArtifact): 'created' | 'ready' {
  return (artifact.kind === 'prototype' || artifact.kind === 'ppt') && artifact.ready === false ? 'created' : 'ready'
}

export function normalizeToolResultForReplay(result: any): ReplayToolResult | null {
  if (typeof result === 'string') {
    const text = sanitizeToolOutput(result)
    return text ? { text, isError: false, media: [] } : null
  }
  if (!result || typeof result !== 'object') return null
  // 两种 __result 形状都要认：cc 路径 { text, isError }；klaus 路径
  // { content:[{type:'text',text}|image], is_error }。
  let rawText = typeof result.text === 'string' ? result.text : ''
  if (!rawText && Array.isArray(result.content)) {
    rawText = result.content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
  }
  const media: ReplayToolMedia[] = Array.isArray(result.content)
    ? result.content
      .filter((b: any) => b && b.type === 'image' && typeof b.path === 'string' && b.path)
      .map((b: any) => ({ path: b.path, mimeType: typeof b.mimeType === 'string' ? b.mimeType : undefined, ...(typeof b.sourcePath === 'string' ? { sourcePath: b.sourcePath } : {}) }))
    : []
  const text = sanitizeToolOutput(rawText)
  const isError = result.isError === true || result.is_error === true
  const artifact = isError ? undefined : normalizeVisualArtifact(result.artifact)
  // Media or a structured artifact counts as a visible result even without text.
  if (!text && !isError && media.length === 0 && !artifact) return null
  return { text, isError, media, ...(artifact ? { artifact } : {}) }
}

export function advisorToolArgsFromBlock(block: any): Record<string, unknown> {
  if (block?.input && typeof block.input === 'object' && !Array.isArray(block.input)) return block.input
  return {}
}

export function advisorResultFromBlock(block: any): ReplayToolResult {
  // advisor 结果永远只有文本，媒体位恒为空。
  const plain = (text: string, isError = false): ReplayToolResult => ({ text, isError, media: [] })
  const content = block?.content
  if (!content || typeof content !== 'object') return plain('')
  if (content.type === 'advisor_result') return plain(content.text || '')
  if (content.type === 'advisor_redacted_result') return plain('[Advisor result redacted]')
  if (content.type === 'advisor_tool_result_error') {
    return plain(`Advisor failed: ${content.error_code || 'unknown_error'}`, true)
  }
  return plain('')
}

// 工具调用的主对象（命令/路径/URL/模式）：权限卡的对象行与工具行摘要共用。
// 提不出时返回空串，由调用方决定兜底（工具行用 JSON 截断，权限卡不展示）。
export function primaryToolTarget(toolName: string, args: any): string {
  if (!args || typeof args !== 'object') return ''
  if (String(toolName).toLowerCase() === 'advisor' && args.model) return String(args.model)
  if (typeof args.command === 'string' && args.command) return '$ ' + args.command
  // A cross-conversation write is gated ONLY by this card now that the delegation
  // rate ledger is gone, so the card has to answer "to whom, saying what" without the
  // user expanding a JSON blob. Naming the destination plus the opening of the
  // message is what makes the approval a decision instead of a reflex; the full text
  // stays in the collapsed input below.
  if (String(toolName) === 'send_message_to_thread' && typeof args.threadId === 'string' && args.threadId) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    const host = typeof args.hostId === 'string' && args.hostId && args.hostId !== 'local' ? `${args.hostId} · ` : ''
    const head = prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt
    return head ? `${host}${args.threadId} — ${head}` : `${host}${args.threadId}`
  }
  for (const key of ['file_path', 'path', 'url', 'pattern']) {
    if (typeof args[key] === 'string' && args[key]) return args[key]
  }
  return ''
}

export function toolValueText(toolName: string, args: any): string {
  if (chatActivityKind(toolName, args)) return ''
  if (!args || typeof args !== 'object') return ''
  if (toolName === 'AskUserQuestion') return ''
  const target = primaryToolTarget(toolName, args)
  if (target) return target
  const v = JSON.stringify(args)
  return v.length > 80 ? v.slice(0, 80) + '...' : v
}

// 工具名 → 字形。字形名的唯一真相是 activityToolIconName（单条目卡、分组摘要、
// 在途标题三处共用同一张表），这里只负责包成 svg 字符串。
export function toolIconForName(toolName: string, args?: unknown): string {
  return rawIconHtml(activityToolIconName(toolName, args))
}

export function renderToolStatus(state: string): string {
  if (state === 'running') {
    return `<span class="${styles['tool-status']} running"><span class="${styles['tool-dot']}"></span><span>${escapeHtml(tGlobal('tool_running') || 'Running')}</span></span>`
  }
  // 停在审批上：同一个 pill 位，但文案说清它在等人，点不呼吸（没东西在跑）。
  if (state === 'awaiting-approval') {
    return `<span class="${styles['tool-status']} awaiting"><span class="${styles['tool-dot']}"></span><span>${escapeHtml(tGlobal('tool_awaiting_approval') || 'Awaiting approval')}</span></span>`
  }
  if (state === 'interrupted') {
    return `<span class="${styles['tool-status']} interrupted"><span class="${styles['tool-dot']}"></span><span>${escapeHtml(tGlobal('tool_interrupted') || 'Interrupted')}</span></span>`
  }
  if (state === 'error') {
    return `<span class="${styles['tool-status']} error" aria-label="${escapeHtml(tGlobal('tool_failed') || 'Failed')}" title="${escapeHtml(tGlobal('tool_failed') || 'Failed')}"><span class="${styles['tool-dot']}"></span></span>`
  }
  return `<span class="${styles['tool-status']} done">${rawIconHtml('tool-check')}</span>`
}

export function formatToolInput(args: any): string {
  if (!args || typeof args !== 'object') return ''
  try { return JSON.stringify(args, null, 2) } catch { return String(args) }
}

// Input 参数展示形态：≤6 个纯原始值键走 key-value grid，否则 JSON pre。
export function shouldRenderInputAsFields(args: any): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const keys = Object.keys(args).filter((k) => !k.startsWith('__'))
  if (keys.length === 0 || keys.length > 6) return false
  return keys.every((k) => {
    const v = args[k]
    return v === null || ['string', 'number', 'boolean'].includes(typeof v)
  })
}

export function renderInputBlock(args: any): string {
  const labelHtml = `<span class="tool-detail-bar-label">${escapeHtml(tGlobal('tool_input') || 'Input')}</span>`
  const copyHtml = `<button class="tool-detail-bar-copy" type="button">${escapeHtml(tGlobal('copy') || 'Copy')}</button>`
  if (shouldRenderInputAsFields(args)) {
    const keys = Object.keys(args).filter((k) => !k.startsWith('__'))
    const fieldsHtml = keys.map((k) => {
      const v = args[k] == null ? '' : String(args[k])
      const isLong = v.length > 60 || /\n/.test(v)
      return `<div class="${styles['tool-detail-field-key']}">${escapeHtml(k)}</div><div class="${styles['tool-detail-field-val']}${isLong ? ' long' : ''}">${escapeHtml(v)}</div>`
    }).join('')
    const metaText = `${keys.length} ${tGlobal(keys.length === 1 ? 'tool_field' : 'tool_fields') || 'fields'}`
    const copyText = keys.map((k) => `${k}: ${args[k] == null ? '' : String(args[k])}`).join('\n')
    return `<div class="tool-detail-section"><div class="tool-detail-block">
      <div class="tool-detail-bar">${labelHtml}<span class="tool-detail-bar-meta">${escapeHtml(metaText)}</span>${copyHtml}</div>
      <div class="tool-detail-fields tool-detail-input" data-copy-text="${escapeHtml(copyText)}">${fieldsHtml}</div>
    </div></div>`
  }
  const jsonText = formatToolInput(args)
  const metaText = jsonText ? `${jsonText.split('\n').length} ${tGlobal('tool_lines') || 'lines'}` : ''
  return `<div class="tool-detail-section"><div class="tool-detail-block">
    <div class="tool-detail-bar">${labelHtml}<span class="tool-detail-bar-meta">${escapeHtml(metaText)}</span>${copyHtml}</div>
    <pre class="tool-detail-pre tool-detail-input">${escapeHtml(jsonText)}</pre>
  </div></div>`
}

// Output 段（bar + pre）；text 已 sanitize，行数 meta 由调用方算好传入。
export function renderOutputBlock(text: string, isError: boolean): string {
  const lines = text ? text.split('\n').length : 0
  const metaText = lines ? `${lines} ${tGlobal('tool_lines') || 'lines'}` : ''
  return `<div class="tool-detail-section"><div class="tool-detail-block">
    <div class="tool-detail-bar">
      <span class="tool-detail-bar-label">${escapeHtml(tGlobal('tool_output') || 'Output')}</span>
      <span class="tool-detail-bar-meta">${escapeHtml(metaText)}</span>
      <button class="tool-detail-bar-copy" type="button">${escapeHtml(tGlobal('copy') || 'Copy')}</button>
    </div>
    <pre class="tool-detail-pre tool-detail-output${isError ? ' tool-detail-error' : ''}">${escapeHtml(text || (tGlobal('tool_no_output') || '(no output)'))}</pre>
  </div></div>`
}

// ==================== user 附件/粘贴 chip ====================
// 发送后的附件行与输入框待发行同一套 .kls-attach-* 外形（styles.css），差别只
// 在于没有删除角标。

export function basenameFromPath(path: unknown): string {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || 'attachment'
}

export function extractSentFileCards(text: unknown): { cards: Array<{ name: string }>; text: string } {
  const cards: Array<{ name: string }> = []
  let next = String(text || '')
  const collectFiles = (_match: string, names: string) => {
    String(names || '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
      .forEach(name => cards.push({ name }))
    return ''
  }
  next = next.replace(/\[Files?: (.+?)\]/g, collectFiles)
  next = next.replace(/\[文件: (.+?)\]/g, collectFiles)
  return {
    cards,
    text: (() => {
      const nl = String.fromCharCode(10)
      const blankRun = new RegExp('[ \\t]*' + nl + '[ \\t]*' + nl + '[ \\t]*', 'g')
      return next.replace(blankRun, nl + nl).trim()
    })(),
  }
}

// user 消息里的媒体块同样只带 path（engine.rs to_media_block 把附件图也落进了
// 内容寻址池），src 由组件层拼装。document（PDF 附件）回放同样成块到达——
// 丢掉它就是「发过的 PDF 在历史里凭空消失」，所以这里降级成文件 chip。
export function userAttachmentsFromContentBlocks(blocks: any): Array<{ type: string; name: string; path?: string }> {
  if (!Array.isArray(blocks)) return []
  return blocks.flatMap(block => {
    if (!block) return []
    if (block.type === 'file') {
      return [{
        type: 'file',
        name: block.name || block.fileName || (block.path ? basenameFromPath(block.path) : 'file'),
        ...(typeof block.path === 'string' && block.path ? { path: block.path } : {}),
      }]
    }
    if (block.type === 'document' || block.type === 'media') {
      return [{
        type: 'file',
        name: block.filename || block.name || (block.path ? basenameFromPath(block.path) : 'document'),
        ...(typeof block.path === 'string' && block.path ? { path: block.path } : {}),
      }]
    }
    if (block.type !== 'image') return []
    if (typeof block.path !== 'string' || !block.path) return []
    return [{
      type: 'image',
      name: block.name || basenameFromPath(block.path) || 'image',
      path: block.path,
    }]
  })
}

// 产物图片：工具结果里的图直接上正文层（不塞进折叠的 Output 区），点击进
// lightbox —— 「看大图」绑在图片元素上，不绑任何产物登记系统。
export function renderMediaFigureHtml(items: Array<{ src: string; name?: string; path?: string; sessionId?: string }>): string {
  const figures = items.map(item => {
    const src = String(item?.src || '')
    if (!src) return ''
    const name = String(item?.name || 'image').trim() || 'image'
    // No title tooltip: the figure already shows the image full-size and the
    // pool hash name carries no information, so hovering must stay clean.
    return `<button class="${styles['media-figure']}" type="button" aria-label="${escapeHtml(name)}" data-media-figure="1" data-media-path="${escapeHtml(item.path || '')}" data-media-session="${escapeHtml(item.sessionId || '')}">`
      + `<img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" loading="lazy">`
      + `</button>`
  }).filter(Boolean)
  if (figures.length === 0) return ''
  return `<div class="${styles['media-figures']}">${figures.join('')}</div>`
}

export function renderSentFileCardHtml(file: any): string {
  const name = String(file?.name || 'file').trim() || 'file'
  const path = typeof file?.path === 'string' ? file.path : ''
  const tag = path ? 'button' : 'div'
  const action = path ? ` type="button" data-user-file="${escapeHtml(path)}" data-user-file-session="${escapeHtml(file?.sessionId || '')}"` : ''
  return `
    <${tag} class="kls-attach-chip" aria-label="${escapeHtml(name)}"${action}>
      <span class="kls-attach-chip-icon">${rawIconHtml('file-2')}</span>
      <span class="kls-attach-chip-name">${escapeHtml(name)}</span>
    </${tag}>
  `
}

export function renderSentImageCardHtml(image: any): string {
  const name = String(image?.name || 'image').trim() || 'image'
  const src = String(image?.src || '')
  if (!src) return ''
  return `
    <button class="kls-attach-thumb ${styles['user-image-thumb']}" type="button" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}" data-media-thumb="1" data-media-path="${escapeHtml(image?.path || '')}" data-media-session="${escapeHtml(image?.sessionId || '')}">
      <img src="${escapeHtml(src)}" alt="${escapeHtml(name)}">
    </button>
  `
}

export function renderSentPastedCardHtml(card: any): string {
  const preview = pastedCardPreview(card) || pastedTextPreview(card?.text || '')
  if (!preview) return ''
  const path = typeof card?.path === 'string' ? card.path : ''
  const hasContent = path || String(card?.text || '')
  // Stored files and retained legacy text each have a read-only destination.
  const subtitle = path
    ? `<span class="kls-paste-card-subtitle">${escapeHtml(tGlobal('pasted_text_identity'))}</span>`
    : hasContent
      ? `<span class="kls-paste-card-subtitle">${escapeHtml(tGlobal('pasted_text_identity'))}</span>`
      : `<span class="kls-paste-card-subtitle">${escapeHtml(tGlobal('pasted_text_unavailable'))}</span>`
  // Single-line HTML: the card is spliced into .msg.user's sibling row, whose
  // pre-wrap whitespace would render template indentation as real line breaks.
  return `<span class="kls-paste-card is-thread" data-paste-path="${escapeHtml(path)}"${!path && typeof card?.text === 'string' ? ` data-paste-text="${escapeHtml(card.text)}"` : ''}>`
    + (hasContent ? `<button class="kls-paste-card-open" type="button" data-paste-open="1" aria-label="${escapeHtml(preview)}"></button>` : '')
    + `<span class="kls-paste-card-icon">${rawIconHtml('pasted-text')}</span>`
    + `<span class="kls-paste-card-text"><span class="kls-paste-card-title">${escapeHtml(preview)}</span>${subtitle}</span>`
    + `</span>`
}

export function renderSentQuoteCardHtml(card: any, inline = false): string {
  const preview = card?.previewText || pastedTextPreview(card?.text || '')
  if (!preview) return ''
  const fullText = String(card?.text || preview)
  // Single-line HTML: see renderSentPastedCardHtml — pre-wrap bubbles render
  // template indentation around an inline chip as visible line breaks.
  // The hover title carries the full quoted text: the chip truncates it, and
  // reading it must not require opening the click-through dialog.
  return `<button type="button" class="kls-attach-chip is-quote${inline || Number.isInteger(card?.requestOffset) ? ' is-inline' : ''}" title="${escapeHtml(fullText)}" data-user-quote="${escapeHtml(fullText)}" aria-label="${escapeHtml(`${tGlobal('quoted_text_badge') || 'QUOTE'}: ${preview}`)}">`
    + `<span class="kls-attach-chip-icon">${rawIconHtml('quoted-text')}</span>`
    + `<span class="kls-attach-chip-name">${escapeHtml(preview)}</span>`
    + `</button>`
}

export function renderUserAttachmentsHtml(attachments: any): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return ''
  return attachments.map(attachment => {
    if (!attachment) return ''
    const name = attachment.name || (attachment.type === 'image' ? 'image' : 'file')
    if (attachment.type === 'image' && attachment.src) {
      return renderSentImageCardHtml({ name, src: attachment.src, path: attachment.path, sessionId: attachment.sessionId })
    }
    return renderSentFileCardHtml({ name, path: attachment.path, sessionId: attachment.sessionId })
  }).filter(Boolean).join(' ')
}

// ==================== 杂项标记 ====================

const INTERRUPT_MARKER_RE = /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/

export function isInterruptMarkerText(text: unknown): boolean {
  return typeof text === 'string' && INTERRUPT_MARKER_RE.test(text)
}

// ==================== teammate 消息解析 ====================

export const AGENT_COLOR_MAP: Record<string, string> = {
  blue: 'var(--info)',
  green: 'var(--success)',
  purple: 'var(--theme-skill)',
  orange: 'var(--warning)',
  red: 'var(--danger)',
  yellow: 'var(--warning)',
}

export function teammateColorVar(color: unknown): string {
  return AGENT_COLOR_MAP[String(color || '')] || AGENT_COLOR_MAP.blue
}

export const TEAMMATE_MSG_RE = /<teammate-message\s+([^>]*?)>([\s\S]*?)<\/teammate-message>/g

export function parseTeammateAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /(\w+)="([^"]*)"/g
  let m
  while ((m = re.exec(attrStr)) !== null) attrs[m[1]] = m[2]
  return attrs
}

// 内容分类：JSON 结构化消息走特化样式，非 JSON 走普通 markdown。
export function classifyTeammateContent(rawContent: string): any {
  const text = rawContent.trim()
  if (!text.startsWith('{')) return { kind: 'text', text }
  let obj
  try { obj = JSON.parse(text) } catch { return { kind: 'text', text } }
  const type = obj?.type
  if (type === 'shutdown_approved' || type === 'idle_notification' || type === 'teammate_terminated') {
    return { kind: 'hidden' }
  }
  if (type === 'plan_approval_request') return { kind: 'plan_request', ...obj }
  if (type === 'plan_approval_response') return { kind: 'plan_response', ...obj }
  if (type === 'shutdown_request') return { kind: 'shutdown_request', ...obj }
  if (type === 'shutdown_rejected') return { kind: 'shutdown_rejected', ...obj }
  if (type === 'task_completed') return { kind: 'task_completed', ...obj }
  return { kind: 'text', text }
}

export const FORK_BOILERPLATE_RE = /<fork-boilerplate>([\s\S]*?)<\/fork-boilerplate>\s*([\s\S]*)/

// ==================== 消息操作栏 ====================

export function formatMsgTime(ts: unknown): string {
  if (!ts) return ''
  const d = new Date(ts as any)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

export interface MsgActionsSpec {
  ts: unknown
  copyText: string
  // Only a user bubble with a uuid offers rewind; branch is offered on user (with uuid)
// and on the assistant's last segment.
  uuid?: string
  turnId?: string
  /**
   * The turn this user bubble started. Used by inline edit and pre-turn fork
   * when an optimistic stopped-turn bubble has not received its saved uuid yet.
   */
  editTurn?: string
  kind: 'user' | 'assistant'
  archived: boolean
  running: boolean
  readOnly?: boolean
  /**
   * Whether this bubble is the LAST user message, i.e. the only one an inline edit
   * can target. The running half of that rule is applied in `userBubbleEditable`,
   * not here.
   */
  canEdit?: boolean
  // 追加在 copy 后的额外 span（turn usage meta 等 bar.appendChild 追加面）。
  extraHtml?: string
  /**
   * Keep the copy control's tooltip on a read-only bar. A friend message's bar
   * is read-only for rewind and edit, yet its copy sits next to tooltipped
   * reply and handoff icons and must read the same way.
   */
  copyTooltip?: boolean
  goalCompletion?: import('./goal-completion').GoalCompletionSummary
}

/**
 * Whether a user bubble offers the inline edit entry point at all.
 *
 * The pencil is hidden while the turn runs: the gate is
 * `turn.status === 'inProgress' ? undefined : handler`, so the button simply is not
 * rendered, and the host-side `turn-in-progress` refusal is only the race guard for
 * a submit that started before the turn did. The entry point therefore
 * disappears with the turn it would truncate, exactly like the sibling rewind control.
 * The worded refusal (`msg_edit_busy`) still exists for the race.
 */
export function userBubbleEditable(canEdit: boolean | undefined, running: boolean, archived: boolean, readOnly: boolean | undefined): boolean {
  return !!canEdit && !running && !archived && !readOnly
}

/**
 * The collapsed shell of a long externally delivered friend message. The
 * bubble keeps the sender's lead line and a size line; the full text is one
 * click away inline (a bounded scroll box) or in the shared reader overlay.
 * Copy still hands back the whole original through the row's action bar, so
 * collapsing never loses a character.
 *
 * The shared renderer carries the original text for the reader and renders
 * the expanded body as Markdown.
 */
export function renderFriendCollapsedHtml(display: string): string | null {
  const summary = summarizeFriendMessage(display)
  if (!summary.collapsed) return null
  return renderFriendMessageHtml(display, tGlobal)
}

/**
 * The human-facing text of an externally delivered message, or null when the row is
 * not one. Such a row's model-facing text is an approval envelope the device owner
 * never typed, so every user-facing action (bubble body, copy) follows the display
 * snapshot instead, and the row is not an edit target.
 */
export function externalMessageDisplay(localRender: unknown): string | null {
  const render = localRender !== null && typeof localRender === 'object' && !Array.isArray(localRender) ? localRender as Record<string, unknown> : null
  if (render?.externalFriendMessage !== true) return null
  return typeof render.displayText === 'string' ? render.displayText : null
}

/**
 * The external person whose agent authored an externally delivered message, or
 * null when the row is not one. The name and avatar are what the friendship
 * ledger recorded at delivery time; the id is kept out of the surface because
 * a display name and a face are what a person recognizes.
 *
 * Snapshots written before sender identity rode the display metadata are
 * recovered from the model-facing envelope text: its last paragraph is the
 * host-authored JSON carrying the same sender object (without the avatar).
 * That fallback is display-only and only runs on rows the host already marked
 * external, so typing an envelope by hand can never produce a sender row.
 */
export function externalMessageSender(localRender: unknown, modelText?: string): { userId?: string; displayName?: string; avatarUrl?: string; friendshipId?: string } | null {
  const render = localRender !== null && typeof localRender === 'object' && !Array.isArray(localRender) ? localRender as Record<string, unknown> : null
  if (render?.externalFriendMessage !== true) return null
  const fromSnapshot = senderFields(render.sender)
  if (fromSnapshot) return fromSnapshot
  return senderFields(externalEnvelopePayload(modelText)?.sender)
}

function senderFields(sender: unknown): { userId?: string; displayName?: string; avatarUrl?: string; friendshipId?: string } | null {
  if (sender === null || typeof sender !== 'object' || Array.isArray(sender)) return null
  const row = sender as Record<string, unknown>
  const userId = typeof row.userId === 'string' ? row.userId : undefined
  const displayName = typeof row.displayName === 'string' ? row.displayName : undefined
  const avatarUrl = typeof row.avatarUrl === 'string' ? row.avatarUrl : undefined
  const friendshipId = typeof row.friendshipId === 'string' ? row.friendshipId : undefined
  return userId === undefined && displayName === undefined && avatarUrl === undefined ? null : { userId, displayName, avatarUrl, ...(friendshipId ? { friendshipId } : {}) }
}

/** The host-authored JSON paragraph of a friend envelope, or an empty object. */
function externalEnvelopePayload(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return {}
  const last = text.split('\n\n').at(-1)?.trim() ?? ''
  if (!last.startsWith('{')) return {}
  try {
    const parsed = JSON.parse(last)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

/**
 * The sender column of an externally delivered message: the friend's avatar on
 * the bubble's LEFT, the way a group chat shows the other party, so a
 * transcript mixing the owner's typing and incoming friend messages reads at a
 * glance. The group's own class flips the row's alignment; the column carries
 * the avatar (image over an initial, exactly like the friends page) and the
 * sender's name as a caption.
 *
 * Returns '' when no sender identity can be recovered at all, leaving the row
 * an ordinary right-aligned user bubble. The avatar image carries the
 * media-figure anchor so a dead avatar URL falls into the transcript's own
 * broken-image handling instead of showing a torn picture.
 */
export function renderExternalSenderAvatarHtml(localRender: unknown, modelText?: string): string {
  const sender = externalMessageSender(localRender, modelText)
  if (!sender) return ''
  const name = String(sender.displayName || '').trim()
  const initial = escapeHtml(name.slice(0, 1)) || rawIconHtml('sb-nav-friends', { size: 16 })
  const img = sender.avatarUrl
    ? `<img src="${escapeHtml(sender.avatarUrl)}" alt="" referrerpolicy="no-referrer" data-media-figure data-media-thumb>`
    : ''
  // The data marker is the stable identity of the column: the styling class is
  // a CSS-module hash, which a test DOM cannot reproduce.
  return `<div class="${styles['external-sender-col']}" data-external-sender-col aria-hidden="true">`
    + `<span class="${styles['transcript-avatar']}">${initial}${img}</span>`
    + (name ? `<span class="${styles['external-sender-name']}" data-external-sender-name>${escapeHtml(name)}</span>` : '')
    + `</div>`
}

/**
 * The avatar column of a cross-conversation or cross-device delivery: the
 * agent's own avatar, the image the owner set for it on the profile page and
 * the sidebar shows. The provenance line above the bubble ("from which chat /
 * which computer") stays exactly as it was; this column only answers "who
 * sent it" with a face. The profile bootstrap publishes the stored avatar on
 * `window` so this string builder can read it without a store subscription.
 */
function profileAvatar(): { url: string; name: string } {
  const published = typeof window !== 'undefined' ? (window as any).__klausProfileAvatar : undefined
  const url = published && typeof published.url === 'string' ? published.url : ''
  const name = published && typeof published.name === 'string' ? published.name : ''
  return { url, name }
}

function profileAvatarImg(): string {
  const { url } = profileAvatar()
  return url ? `<img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer" data-media-figure data-media-thumb>` : ''
}

export function renderAgentSenderAvatarHtml(): string {
  // The agent's official face ships as a product asset, so a cross-conversation
  // or cross-device row reads as "the agent on my other chat/device" even on a
  // fresh profile with no uploaded avatar.
  return `<div class="${styles['external-sender-col']}" data-agent-sender-col aria-hidden="true">`
    + `<span class="${styles['transcript-avatar']}"><img src="agent-avatar.png" alt="" referrerpolicy="no-referrer" data-media-figure data-media-thumb>K</span>`
    + `</div>`
}

/**
 * The owner's own avatar column, on the RIGHT of their rows (typed messages,
 * steered follow-ups and non-blocking question answers alike): the group-chat
 * mirror of the external sender column. It reads the profile page avatar, the
 * same image the sidebar shows; without one it falls back to the owner's
 * display-name initial. No name caption — the row is mine, and the bubble's
 * side already says so.
 */
export function renderOwnerSenderAvatarHtml(): string {
  const { name } = profileAvatar()
  const initial = escapeHtml(name.trim().slice(0, 1)) || 'U'
  return `<div class="${styles['external-sender-col']}" data-owner-sender-col aria-hidden="true">`
    + `<span class="${styles['transcript-avatar']}">${initial}${profileAvatarImg()}</span>`
    + `</div>`
}

/**
 * The text a user bubble's copy action puts on the clipboard: what the person
 * actually typed, never the stored request text.
 *
 * The stored text can carry host-appended blocks the composer never contained —
 * a friend mention's delivery receipt is concatenated onto the request before it
 * reaches the engine, so copying the stored text would hand back the raw mention
 * token plus that receipt while the bubble shows only the typed sentence. The
 * display snapshot keeps the typed text (and the quote envelope the bubble
 * renders as cards), so copy follows it; rows without a snapshot fall back to
 * the same envelope parse the bubble body uses.
 */
export function userCopyText(msg: { text?: unknown; localRender?: unknown } | null | undefined, composerAuthored: boolean): string {
  const text = typeof msg?.text === 'string' ? msg.text : ''
  const local = msg?.localRender !== null && typeof msg?.localRender === 'object' && !Array.isArray(msg?.localRender)
    ? msg.localRender as Record<string, unknown> : null
  const document = restoreComposerDocument(local?.composerDocument)
  if (document) return composerDocumentText(document, composerTokenClipboardText)
  if (local && typeof local.displayText === 'string') return stripGoalImageReferences(local.displayText)
  const composed = (composerAuthored ? parseSelectedTextEnvelope(text)?.message : null) ?? text
  // The reference section is model-facing scaffolding; copying a row hands back
  // what the bubble shows, which is the body before that section. Goal image
  // reference lines are the same kind of scaffolding and stay out of the clip.
  return stripGoalImageReferences(parsePastedReferenceSection(composed)?.displayText ?? composed)
}

// Row order follows the bubble's alignment: user = time/rewind/branch/copy/edit;
// assistant = branch/copy/time. Edit sits after copy (last in the bar), the
// user-message action bar order.
// Disabled state is applied up front (syncMessageActionAvailability semantics):
// rewind is disabled while archived or running with the reason in its title;
// branch is disabled only while running.
export function renderMsgActionsHtml(spec: MsgActionsSpec): string {
  const timeText = formatMsgTime(spec.ts)
  const timeHtml = timeText ? `<span class="msg-time">${escapeHtml(timeText)}</span>` : ''
  const rdDisabled = spec.archived || spec.running
  const rdReason = spec.archived ? tGlobal('msg_actions_archived') : spec.running ? tGlobal('msg_actions_busy') : ''
  const iconBtn = (svg: string, action: string, title: string, opts: { disabled?: boolean; disabledTitle?: string; baseTitle?: string } = {}) => {
    const disabled = !!opts.disabled
    const shownTitle = disabled ? (opts.disabledTitle || title) : title
    return `<button type="button" class="msg-action-btn" data-action="${action}"${opts.baseTitle ? ` data-base-title="${escapeHtml(opts.baseTitle)}"` : ''} title="${escapeHtml(shownTitle)}" aria-label="${escapeHtml(title)}"${disabled ? ' disabled' : ''} aria-disabled="${disabled}">${svg}</button>`
  }
  const copyBtn = `<button type="button" class="msg-action-btn"${spec.readOnly && !spec.copyTooltip ? '' : ` title="${escapeHtml(tGlobal('copy'))}"`} aria-label="${escapeHtml(tGlobal('copy'))}">${rawIconHtml('copy')}</button>`
  const parts: string[] = spec.kind === 'user' ? [timeHtml] : []
  if (!spec.readOnly && spec.kind === 'user' && spec.uuid) {
    parts.push(iconBtn(rawIconHtml('rewind'), 'rewind', tGlobal('msg_rewind'), { disabled: rdDisabled, disabledTitle: rdReason, baseTitle: tGlobal('msg_rewind') }))
    parts.push(iconBtn(rawIconHtml('branch'), 'branch', tGlobal('msg_branch'), { disabled: spec.running, disabledTitle: tGlobal('msg_actions_busy') }))
  }
  if (!spec.readOnly && spec.kind === 'assistant') {
    parts.push(iconBtn(rawIconHtml('branch'), 'branch', tGlobal('msg_branch'), { disabled: spec.running, disabledTitle: tGlobal('msg_actions_busy') }))
  }
  if (spec.kind !== 'user' || spec.copyText.trim()) parts.push(copyBtn)
  // Edit is offered whenever the bubble is the editable target AND the click can resolve it
  // — by uuid for a settled row, or by turn for a stopped turn's optimistic bubble. The
  // sibling rewind/branch controls above stay uuid-only: those go to host methods
  // that take a messageUuid, which a uuid-less bubble has nothing to give them.
  if (spec.kind === 'user' && (spec.uuid || spec.editTurn) && userBubbleEditable(spec.canEdit, spec.running, spec.archived, spec.readOnly)) {
    parts.push(iconBtn(rawIconHtml('edit'), 'edit', tGlobal('msg_edit')))
  }
  if (spec.kind === 'assistant') parts.push(timeHtml)
  if (spec.extraHtml) parts.push(spec.extraHtml)
  if (spec.kind === 'assistant' && spec.goalCompletion) parts.push(renderGoalCompletionMetaHtml(spec.goalCompletion))
  const turnAttr = spec.turnId ? ` data-turn-id="${escapeHtml(spec.turnId)}"` : ''
  const msgAttr = spec.uuid ? ` data-message-uuid="${escapeHtml(spec.uuid)}"` : ''
  return `<div class="msg-actions" data-copy-text="${escapeHtml(spec.copyText)}"${turnAttr}${msgAttr}>${parts.filter(Boolean).join('')}</div>`
}

export function renderGoalCompletionMetaHtml(completion: GoalCompletionSummary): string {
  const locale = (window as any).currentLang === 'zh' ? 'zh' : 'en'
  const label = completion.durationSeconds === null
    ? tGlobal('goal_achieved_record')
    : tGlobal('goal_achieved_in').replace('{duration}', formatWorkflowDuration(completion.durationSeconds, locale))
  return `<span class="msg-goal-completion" data-goal-completion>${rawIconHtml('goal')}<span>${escapeHtml(label)}</span></span>`
}

// ==================== turn usage meta（klaus 引擎本回合用量） ====================
// 对齐旧版 formatTokens + appendTurnUsageMeta：行内只露关键数字，明细进 title；
// 停止原因仅非正常收尾时单独露一枚（danger 色）。

export function formatTokens(n: unknown): string {
  if (typeof n !== 'number' || !isFinite(n)) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

const TURN_STOP_REASON_LABELS: Record<string, Record<string, string>> = {
  zh: {
    max_tokens: '已达输出上限', length: '已达输出上限',
    stop_sequence: '命中停止序列', content_filter: '内容过滤拦截',
    refusal: '模型拒答', pause_turn: '回合暂停', error: '异常结束',
    turn_limit_exhausted: '已达轮次上限，本回合结束', spend_limit_exhausted: '已达花费上限，本回合结束',
  },
  en: {
    max_tokens: 'Output limit reached', length: 'Output limit reached',
    stop_sequence: 'Stop sequence hit', content_filter: 'Content filtered',
    refusal: 'Refused', pause_turn: 'Turn paused', error: 'Errored',
    turn_limit_exhausted: 'Turn limit reached, turn ended', spend_limit_exhausted: 'Spend limit reached, turn ended',
  },
}
const TURN_STOP_REASON_NORMAL = new Set(['end_turn', 'stop', 'complete', 'tool_use', 'completed', ''])

export function renderTurnUsageMetaHtml(meta: { turnTokens: number; usage: any; stopReason: string }): string {
  const lang = (window as any).currentLang === 'zh' ? 'zh' : 'en'
  const u = meta.usage || {}
  const tokensLabel = lang === 'zh' ? '本回合' : 'turn'
  const text = `${tokensLabel} ${formatTokens(meta.turnTokens)} tok`
  const detailParts: string[] = []
  if (typeof u.inputTokens === 'number') detailParts.push(`in ${formatTokens(u.inputTokens)}`)
  if (typeof u.outputTokens === 'number') detailParts.push(`out ${formatTokens(u.outputTokens)}`)
  if (typeof u.cacheReadInputTokens === 'number' && u.cacheReadInputTokens) detailParts.push(`cache-read ${formatTokens(u.cacheReadInputTokens)}`)
  if (typeof u.cacheCreationInputTokens === 'number' && u.cacheCreationInputTokens) detailParts.push(`cache-write ${formatTokens(u.cacheCreationInputTokens)}`)
  let html = `<span class="msg-time turn-usage-meta" title="${escapeHtml(detailParts.join('  ·  ') || text)}">${escapeHtml(text)}</span>`
  const reason = String(meta.stopReason || '')
  if (reason && !TURN_STOP_REASON_NORMAL.has(reason)) {
    const reasonText = TURN_STOP_REASON_LABELS[lang][reason]
      || (lang === 'zh' ? `结束原因: ${reason}` : `stop: ${reason}`)
    html += `<span class="msg-time turn-stop-reason" title="${escapeHtml(reasonText)}" style="color: var(--danger);">${escapeHtml(reasonText)}</span>`
  }
  return html
}

// The replay summary displays the exact answer strings returned by the engine.
export function renderResolvedAskUserCardHtml(block: any): { className: string; innerHtml: string } | null {
  const questions = block?.input?.questions
  const resolution = questionResolution(block)
  if (!Array.isArray(questions) || !resolution) return null
  const summary = resolvedQuestionPresentation(questions, resolution)
  const kind = tGlobal(summary.kind === 'multi' ? 'question_multi' : 'question_single')
  const count = summary.rows.length > 1 ? ` · ${summary.rows.length}` : ''
  const chip = `<div class="${styles['question-chip']}">${rawIconHtml('chat-bubble')}<span>${escapeHtml(tGlobal('question_chip'))}</span><span class="${styles['question-chip-sep']}">·</span><span class="${styles['question-chip-kind']}">${escapeHtml(kind + count)}</span></div>`
  const rows = summary.rows.map(row => {
    const resultClass = `${styles['question-summary-answer']}${row.answer ? '' : ` ${styles['question-summary-skipped']}`}`
    return `<div class="${styles['question-summary-row']}"><div class="${styles['question-summary-question']}"><span class="${styles['question-summary-index']}">${row.index}.</span><span>${escapeHtml(row.question)}</span></div><div class="${resultClass}">${escapeHtml(row.answer || tGlobal('question_skipped'))}</div></div>`
  }).join('')
  return { className: styles['question-summary'], innerHtml: chip + rows }
}

/**
 * The cards a `::created-thread{…}` directive set renders as.
 *
 * Each directive
 * becomes ONE full-width row button — an icon box, a "Created chat" title and a
 * trailing chevron — and multiple rows stack
 * in a divided list capped at three visible entries with a "Show N more chats"
 * expander. The list mounts OUTSIDE the message body, which is why the builder is
 * split: `renderCreatedThreadCardHtml` is one row, `renderCreatedThreadListHtml`
 * is the capped shell around them, and `postProcessHtml` (TranscriptView) is what
 * strips the directive paragraphs and appends the list.
 *
 * A pure HTML-string builder, like every other card here, so the markup is
 * testable without a DOM. The thread id is model-authored, so it goes through
 * `escapeHtml` and lands in a `data-` attribute that the click handler re-reads —
 * never concatenated into an inline handler. The expander is plain DOM toggling
 * driven by the click delegate, not inline JS.
 */

/** The default-visible list caps at three entries. */
export const CREATED_THREAD_LIST_CAP = 3

/** One row button. `compact` is the list's overflow variant: smaller icon box. */
export function renderCreatedThreadCardHtml(threadId: string, compact = false): string {
  const label = tGlobal('chat_activity_created_thread_label')
  const open = tGlobal('chat_activity_created_thread_open')
  const icon = rawIconHtml('chat-activity', { size: compact ? 16 : 20 })
  return `<button type="button" class="${styles['created-thread-card']}${compact ? ` ${styles['created-thread-card-compact']}` : ''}" data-created-thread-id="${escapeHtml(threadId)}" aria-label="${escapeHtml(open)}">`
    + `<span class="${styles['created-thread-icon']}">${icon}</span>`
    + `<span class="${styles['created-thread-title']}">${escapeHtml(label)}</span>`
    + `<span class="${styles['created-thread-trailing']}">${rawIconHtml('chevron-down', { size: 16, cls: styles['created-thread-chevron'] })}`
    + `</span></button>`
}

/**
 * The capped list shell. One directive still renders the bare row (no shell
 * chrome); two or more stack with a hairline divider, overflow rows beyond the
 * cap ship inline `display:none` (the CSS hides `[data-hidden-overflow]` while
 * the shell is collapsed), and the expander row toggles the state. The shell
 * keeps `data-created-thread-list` so tests and the click delegate can find it
 * without parsing class names.
 */
export function renderCreatedThreadListHtml(threadIds: readonly string[]): string {
  if (threadIds.length === 0) return ''
  const visible = threadIds.slice(0, CREATED_THREAD_LIST_CAP)
  const overflow = threadIds.slice(CREATED_THREAD_LIST_CAP)
  const rows = visible.map(id => renderCreatedThreadCardHtml(id)).join('')
  if (overflow.length === 0) {
    return `<div class="${styles['created-thread-list']}" data-created-thread-list>${rows}</div>`
  }
  const more = tGlobal('chat_activity_created_thread_more').replace('{n}', String(overflow.length))
  const fewer = tGlobal('chat_activity_created_thread_fewer')
  const hiddenRows = overflow.map(id => renderCreatedThreadCardHtml(id, true).replace('<button type="button"', '<button data-hidden-overflow type="button"')).join('')
  return `<div class="${styles['created-thread-list']}" data-created-thread-list data-collapsed="true">`
    + rows
    + `<button type="button" class="${styles['created-thread-more']}" data-created-thread-more aria-expanded="false" data-more-label="${escapeHtml(more)}" data-fewer-label="${escapeHtml(fewer)}">`
    + `<span>${escapeHtml(more)}</span>${rawIconHtml('chevron-down', { size: 16 })}</button>`
    + hiddenRows
    + `</div>`
}

/**
 * The one-line label above a delegated message's bubble.
 *
 * A delegation renders exactly like an ordinary user message, with its
 * provenance carried by a single small line above the bubble rather than by a card
 * of its own. This builder produces that line. The source conversation id is
 * deliberately NOT surfaced: it is
 * model-authored, a remote one is meaningless on this device, and the label's job
 * is provenance, not navigation.
 *
 * Returns '' when the text is not exactly one well-formed envelope, so the caller
 * renders the message as an ordinary user bubble with no label at all. Falling
 * back is deliberate: swallowing model-authored text is worse than showing a
 * wrapper that failed to parse, and `parseDelegationEnvelope` refuses anything
 * with surrounding prose.
 */
export function renderDelegationLabelHtml(text: string): string {
  const envelope = parseDelegationEnvelope(text ?? '')
  if (!envelope) return ''
  return renderDelegationLabelParsedHtml(envelope.sourceHostId, envelope.sourceThreadId)
}

/** Keep navigation local: a remote thread id may collide with one on this computer. */
export function renderDelegationLabelParsedHtml(sourceHostId?: string | null, sourceThreadId?: string | null): string {
  const thisHost = localDeviceId()
  const local = !sourceHostId || sourceHostId === 'local' || !!thisHost && sourceHostId === thisHost
  if (local) {
    const source = typeof sourceThreadId === 'string' && sourceThreadId.trim() ? sourceThreadId : ''
    const known = source ? (typeof window !== 'undefined' ? (window as any).getKnownSessionInfo?.(source) : null) : null
    const title = String(known?.title || '').trim()
    const named = title && !/^(?:新对话|New Chat)$/i.test(title)
    const label = named ? tGlobal('delegation_received_named_label').replace('{title}', title)
      : tGlobal('delegation_received_label')
    const contents = `${rawIconHtml('chat-activity')}<span>${escapeHtml(label)}</span>`
    return `<div class="${styles['delegation-label-row']}">${source
      ? `<button type="button" class="${styles['delegation-source-link']}" data-delegation-source-id="${escapeHtml(source)}" aria-label="${escapeHtml(label)}">${contents}</button>`
      : contents}</div>`
  }
  const device = deviceNameForHost(sourceHostId)
  const label = device ? tGlobal('delegation_received_remote_label').replace('{device}', device)
    : tGlobal('delegation_received_other_device_label')
  return `<div class="${styles['delegation-label-row']}">${rawIconHtml('chat-activity')}`
    + `<span>${escapeHtml(label)}</span></div>`
}

/**
 * The sender's prose out of a delegation envelope, for the bubble itself.
 *
 * The envelope is what the recipient MODEL reads — it carries the sender's id so a
 * reply can find its way back — while the recipient's OWNER reads only the prompt.
 * That is why this is a renderer concern rather than a host one: the envelope has
 * to survive to the model, so it cannot be stripped at delivery.
 *
 * Returns null when the text is not exactly one well-formed envelope, so the
 * caller renders the message untouched.
 */
export function delegationEnvelopeInput(text: string): string | null {
  return parseDelegationEnvelope(text ?? '')?.input ?? null
}

/**
 * The whole delegation presentation: the provenance label row above the sender's
 * prose rendered as an ORDINARY user bubble.
 *
 * This is the single builder both arrival paths render through. The idle path
 * (a `user` message that is exactly one envelope) and the mid-turn path (an
 * envelope the engine drained into the turn's last tool result) must look the
 * same — a steered message and an idle-delivered one must read identically —
 * and building both from one function is what stops them from drifting. The
 * bubble deliberately comes from a plain `<div class="msg user">` rather than the
 * full {@linkcode "TranscriptView" buildUserBubbleHtml} machinery: a delegation
 * has no composer-authored state, so quote/paste chips and slash pills cannot
 * occur, and pulling the heavier builder in would drag the transcript component
 * (and its cycle back to the tool cards) into this factory module.
 *
 * Returns '' when the input is not exactly one well-formed envelope, so the
 * caller renders the raw text instead of swallowing it.
 */
export function renderDelegationBubbleHtml(input: string): string {
  const prose = typeof input === 'string' ? input : ''
  if (!prose.trim()) return ''
  const bubble = `<div class="msg user">${escapeHtml(prose)}</div>`
  return `<div class="sent-user-stack">${bubble}</div>`
}
