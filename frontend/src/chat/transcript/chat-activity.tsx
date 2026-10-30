import { useEffect, useRef, useState, type ReactNode } from 'react'
import upperFirst from 'lodash-es/upperFirst'
import { Icon } from '../../components/Icon'
import { intlLocale, useT } from '../../i18n'
import { getSkillsCache } from '../../pages/skills/data'
import { localizeSkillName, normalizeMarketKey } from '../../pages/skills/localize'
import { deviceNameForHost, localDeviceId, useDeviceNamesVersion } from '../device-names'
import styles from './transcript.module.css'
import { mediaGenerationKind, mediaGenerationSummaryState } from './media-generation-activity'
import { genericActivityLabel, semanticActivity, semanticActivityLabel } from './activity-semantic'

export type ChatActivityKind =
  | 'read' | 'list' | 'list_archived' | 'send' | 'create' | 'fork' | 'wait' | 'list_hosts' | 'list_projects'
  | 'pin' | 'unpin' | 'archive' | 'restore' | 'rename'
export type ChatActivityTool = { toolName: string; args: unknown; state: string; toolCallId?: string; content?: string; output?: { text?: string } | null; media?: Array<{ path: string; mimeType?: string }> }
export type ChatActivityVariant = 'row' | 'summary' | 'summary-text'

/**
 * The six label states of a conversation-coordination tool card.
 *
 * The label for every one of these tools is a six-way select over
 * `{state}`, and the two dimensions are orthogonal: `leading` is whether the card
 * starts a summary line (capitalized) or follows another action (lowercase), and
 * `failed` is whether the call errored. Klaus previously modelled only the leading
 * dimension, so an errored read rendered as "Read chat" — a card that claimed
 * success for a call that failed.
 */
export type ChatActivityState = 'active' | 'completed' | 'following' | 'failed' | 'failed_following' | 'other'

export type NativeActivityKind = 'reading' | 'search' | 'edit' | 'command'

// Native tools and imported native aliases keep their specialized presentation.
// In particular, a host tool containing "list" or "read" is not a file read.
const NATIVE_ACTIVITY_KINDS = new Map<string, NativeActivityKind>([
  ...['read', 'read_file', 'glob', 'ls', 'list_files', 'file_search', 'notebookread', 'notebook_read'].map(name => [name, 'reading'] as const),
  ...['grep', 'tool_search', 'toolsearch', 'web_search', 'websearch', 'web_fetch', 'webfetch', 'advisor'].map(name => [name, 'search'] as const),
  ...['write', 'write_file', 'edit', 'multi_edit', 'multiedit', 'apply_patch', 'notebookedit', 'notebook_edit'].map(name => [name, 'edit'] as const),
  ...['bash', 'bash_output', 'bashoutput', 'exec_command', 'write_stdin', 'kill_shell', 'killshell', 'killbash'].map(name => [name, 'command'] as const),
])
// These native operations have existing detail/media renderers. Browser captures
// can accompany any browser response, not just browser_screenshot, so preserve
// every registered browser operation rather than hiding its image attachments.
const NATIVE_DETAIL_TOOLS = new Set([
  'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click',
  'browser_type', 'browser_eval', 'browser_console', 'browser_network',
  'browser_read_page', 'browser_find', 'browser_form_input', 'browser_computer',
  'browser_tabs', 'browser_locator', 'browser_page_text', 'browser_batch',
  'browser_resize', 'browser_close', 'browser_gif_creator', 'browser_upload_image',
  'browser_file_upload', 'browser_shortcuts_list', 'browser_shortcuts_execute',
  'browser_switch_browser', 'browser_list_connected_browsers', 'browser_select_browser',
  'browser_history', 'browser_tabs_content', 'browser_content_export', 'browser_download',
  'browser_clipboard', 'browser_dialog', 'browser_mark_tab', 'browser_permission',
  // Native and imported aliases with an existing dedicated transcript icon.
  'task_output', 'taskoutput', 'task_stop', 'taskstop', 'taskget', 'tasklist',
  'croncreate', 'cronlist', 'crondelete', 'think', 'pushnotification',
  'monitor', 'remotetrigger', 'enterworktree', 'exitworktree',
])
const STANDALONE_ACTIVITY_TOOLS = new Set([
  'task', 'agent', 'spawn_agent', 'ask_user', 'askuserquestion', 'request_user_input',
  'permission', 'elicitation', 'elicit', 'auth_required', 'createplan', 'enterplanmode', 'exitplanmode',
  'create_plan', 'enter_plan_mode', 'exit_plan_mode', 'suggest_execution_mode', 'update_plan', 'todo_write', 'todowrite',
  'handoff_thread',
])

/**
 * Whether this tool's output IS the deliverable: asking it to run is asking for a
 * picture or a video, so its result is presented even when the reply never names
 * it. Everything else that emits media (a browser screenshot taken to check the
 * model's own work, a read that returns an image) is process, and stays inside the
 * fold unless the reply reports it.
 *
 * generate_audio is deliberately NOT here. This predicate feeds the turn's media
 * figures, which render as images; audio answers with its saved path as text and
 * contributes no media items, so listing it would only offer a future change a path
 * that draws an <img> for an mp3.
 */
export function isExplicitMediaGenerationTool(toolName: string): boolean {
  const name = (toolName || '').toLowerCase()
  return name === 'generate_image' || name === 'generate_video' || name === 'generateimage' || name === 'generatevideo'
}

export function nativeActivityKind(toolName: string): NativeActivityKind | null {
  return NATIVE_ACTIVITY_KINDS.get(toolName.toLowerCase()) ?? null
}

export function isToolDiscovery(toolName: string): boolean {
  return toolName === 'tool_search' || toolName === 'ToolSearch'
}

export function loadedActivityToolNames(tools: ChatActivityTool[]): Set<string> {
  const names = new Set<string>()
  for (const tool of tools) {
    if (!isToolDiscovery(tool.toolName)) continue
    const text = tool.content ?? tool.output?.text ?? ''
    // The native tool result defines this section separately from tools that
    // were already available and names that could not be found.
    let loading = false
    for (const line of text.split(/\r?\n/)) {
      if (line === 'These tools are now available:') { loading = true; continue }
      if (line === 'These tools were already available:' || line === 'No matching tools found for:') {
        loading = false
        continue
      }
      if (!loading) continue
      const match = /^- ([^\s:]+): /.exec(line)
      if (match) names.add(match[1])
    }
  }
  return names
}

export function mcpActivitySource(toolName: string): string | null {
  return /^mcp__(.+?)__.+$/.exec(toolName)?.[1]?.trim() || null
}

export function mcpActivityIsCommand(toolName: string): boolean {
  const source = mcpActivitySource(toolName)
  return source === 'node_repl' || source === 'cua_repl'
}

const SOURCE_ACRONYMS = new Set(['GH', 'IA', 'MCP', 'API', 'CI', 'CLI', 'LLM', 'PDF', 'PR', 'UI', 'URL', 'SQL', 'TW', 'GPU', 'CPU'])
const SOURCE_NAMES = new Map([
  ['openai', 'OpenAI'], ['openaideveloperdocs', 'OpenAI Developer Docs'], ['openapi', 'OpenAPI'],
  ['github', 'GitHub'], ['pagerduty', 'PagerDuty'], ['datadog', 'DataDog'],
  ['sharepoint', 'SharePoint'], ['sqlite', 'SQLite'], ['fastapi', 'FastAPI'],
])
const SOURCE_SMALL_WORDS = new Set(['and', 'or', 'to', 'up', 'with'])

export function mcpActivitySourceName(source: string): string {
  return source.replace(/[_-]+/g, ' ').split(/\s+/).filter(Boolean).map((word, index) => {
    const capitalized = word.toUpperCase()
    if (SOURCE_ACRONYMS.has(capitalized)) return capitalized
    if (word.toLowerCase().endsWith('s') && SOURCE_ACRONYMS.has(word.slice(0, -1).toUpperCase())) {
      return `${word.slice(0, -1).toUpperCase()}s`
    }
    const lower = word.toLowerCase()
    return SOURCE_NAMES.get(lower) ?? (index > 0 && SOURCE_SMALL_WORDS.has(lower) ? lower : lower.slice(0, 1).toUpperCase() + lower.slice(1))
  }).join(' ')
}

export function isDynamicActivityTool(toolName: string, args?: unknown): boolean {
  if (mediaGenerationKind(toolName)) return false
  if (semanticActivity(toolName, args)) return false
  if (chatActivityKind(toolName, args)) return true
  // MCP calls retain their existing server-specific renderer and namespace.
  if (toolName.startsWith('mcp__')) return false
  const name = toolName.toLowerCase()
  return !nativeActivityKind(toolName) && !NATIVE_DETAIL_TOOLS.has(name) && !STANDALONE_ACTIVITY_TOOLS.has(name)
}

/** Chat listings retain their query inputs and returned page in a disclosure. */
export function isChatListActivityTool(toolName: string, args?: unknown): boolean {
  const kind = chatActivityKind(toolName, args)
  return kind === 'list' || kind === 'list_archived'
}

/** Compact activity labels also identify rows with specialized disclosures. */
export function isCompactActivityTool(toolName: string, args?: unknown): boolean {
  return chatActivityKind(toolName, args) !== null || ['skill', 'klaus_query', 'read_thread_terminal'].includes(toolName)
}

/**
 * The running-summary call has a single consumer: the desktop pet pill. The
 * transcript keeps its rows out of both the history and the live projection,
 * so the summary text appears only on the surface that asked for it.
 */
export function isPetPillOnlyTool(toolName: string): boolean {
  return toolName === 'update_running_summary'
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

// Only the host-owned tools have this contract. An unrelated MCP tool with the
// same suffix must retain its own renderer and must never gain navigation.
export function chatActivityKind(toolName: string, args?: unknown): ChatActivityKind | null {
  if (toolName === 'read_thread') return 'read'
  if (toolName === 'list_threads') return 'list'
  if (toolName === 'list_archived_threads') return 'list_archived'
  if (toolName === 'send_message_to_thread') return 'send'
  if (toolName === 'create_thread') return 'create'
  if (toolName === 'fork_thread') return 'fork'
  if (toolName === 'wait_threads') return 'wait'
  // Listing COMPUTERS is a different object from listing chats, so it gets its own
  // verb rather than sharing the `list` label: "Listed chats" would misreport what
  // the call returned.
  if (toolName === 'list_hosts') return 'list_hosts'
  // Listing PROJECTS is again a different object from listing chats or computers.
  if (toolName === 'list_projects') return 'list_projects'
  // Undoing an action gets its own verb, because "Unpinned chat" is true
  // and "Pinned chat" would be a lie about what the call did.
  if (toolName === 'set_thread_pinned') return record(args)?.pinned === false ? 'unpin' : 'pin'
  if (toolName === 'set_thread_archived') return record(args)?.archived === false ? 'restore' : 'archive'
  if (toolName === 'set_thread_title') return 'rename'
  if (toolName !== 'klaus_query') return null
  const input = record(args)
  if (input?.key !== 'session') return null
  if (input.action === 'history') return 'read'
  if (input.action === 'list') return 'list'
  return null
}

export function chatActivityCompleted(state: string): boolean {
  return state !== 'running' && state !== 'awaiting-approval'
}

/**
 * The conversation id inside a successful `create_thread` result, or null when
 * this result does not carry one.
 *
 * The id exists only in the RESULT — `create_thread` creates the conversation, so
 * its arguments cannot name it — which is why the row reads it here instead of
 * through `chatActivityTarget`. The row has to parse the tool result to learn the
 * id, and swapping the whole row for the created-chat card is deliberately
 * redundant with the model's own `::created-thread` line.
 *
 * THREE shapes parse, because the result text reaches this function through three
 * different routes that do not agree on wrapping:
 * - the host tool envelope `{ success, contentItems: [{ type: 'inputText', text }] }`
 *   (what `thread-tools.ts` `toolText` returns to the engine);
 * - that envelope's `text` unwrapped to the bare result object `{ ok, threadId, … }`
 *   — what a LIVE card holds, because these are dynamic tools and the host splits
 *   `contentItems` before the renderer ever sees them (`splitDynamicToolMedia`);
 * - a JSON STRING holding either of the above, since a result can be quoted once
 *   as text on its way through history.
 *
 * `threadId` is validated only the way the `::created-thread` parser validates it —
 * nonempty and not all whitespace, passed through UNTRIMMED — because a card in
 * the body and a card on the tool row must accept exactly the same ids, and the
 * navigation contract this codebase already uses does not trim. A result that does
 * not parse, or that carries no usable id, yields null and the row keeps its
 * ordinary label — the call may well have succeeded in a way this card cannot link
 * to, and showing no card is the cheaper failure. A result that names a NON-LOCAL
 * host is refused for the same reason `chatActivityTarget` refuses one: this
 * navigator opens local conversations only, and a remote id can collide with a
 * local one. Never throws: this runs during render.
 */
export function createdThreadIdFromToolResult(result: unknown): string | null {
  const seen = new Set<unknown>()
  const idOf = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null
    return value
  }
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 5 || value === null || value === undefined) return null
    if (typeof value === 'string') {
      // A result may be a JSON document quoted as a string. A string that does not
      // parse — a plain sentence, an error message — is output, not an id.
      if (!value.trimStart().startsWith('{')) return null
      try { return visit(JSON.parse(value), depth + 1) } catch { return null }
    }
    if (typeof value !== 'object' || seen.has(value)) return null
    seen.add(value)
    if (Array.isArray(value)) {
      // Result content arrives as a block list; the text block is where the tool's
      // own JSON rides.
      for (const item of value) {
        const nested = visit(item, depth + 1)
        if (nested) return nested
      }
      return null
    }
    const record = value as Record<string, unknown>
    const direct = idOf(record.threadId) ?? idOf(record.thread_id)
    // The same host rule `chatActivityTarget` applies to an argument: this
    // navigator opens local conversations only, and a remote id can collide with a
    // local one. Read from THIS record — the one the id came from — so a result
    // naming a remote host cannot fall through to another id further in.
    if (direct) {
      const host = record.hostId ?? record.host_id
      return host !== undefined && host !== 'local' ? null : direct
    }
    for (const key of ['contentItems', 'content', 'result', 'output', 'data', 'text']) {
      const nested = visit(record[key], depth + 1)
      if (nested) return nested
    }
    return null
  }
  return visit(result, 0)
}

/**
 * The created-chat card a tool row should render INSTEAD of its ordinary label,
 * or null when this row is not one.
 *
 * The gate: the row is swapped only for `create_thread`, only once
 * the call COMPLETED, and only when it did not fail. An interrupted call keeps the
 * card for the same reason the activity labels keep their neutral wording — a
 * cancelled turn can still have created the conversation, and the result says so.
 *
 * This is the single place the gate lives, so the component and its tests cannot
 * disagree about which rows swap.
 */
export function createdThreadCardId(tool: { toolName: string; state: string; output?: string | null }): string | null {
  if (tool.toolName !== 'create_thread') return null
  if (!chatActivityCompleted(tool.state) || chatActivityFailed(tool.state)) return null
  return createdThreadIdFromToolResult(tool.output)
}

/**
 * Whether a card reports a FAILED call.
 *
 * `error` is the tool's own failure. `interrupted` is deliberately NOT here: an
 * interrupted turn was cancelled, not failed, and the call may well have landed
 * (a delivered message cannot be un-delivered by the cancellation that followed
 * it), so it keeps the neutral completed wording.
 */
export function chatActivityFailed(state: string): boolean {
  return state === 'error'
}

/**
 * The six label states of a card, derived from the tool's own state plus whether
 * the card leads a summary line. This is the single derivation every caller goes
 * through, so the row card and the summary line cannot disagree.
 */
export function chatActivityState(state: string, leading: boolean): ChatActivityState {
  if (!chatActivityCompleted(state)) return 'active'
  if (chatActivityFailed(state)) return leading ? 'failed' : 'failed_following'
  return leading ? 'completed' : 'following'
}

/**
 * The tools whose card navigates to the conversation it acted on.
 *
 * `read_thread` and `send_message_to_thread` only — both carry a `threadId`
 * argument, which is what makes the target knowable before the call resolves.
 * `create_thread` and `fork_thread` are excluded on purpose: their target is
 * created BY the call, so it exists only in the RESULT and this function — which
 * reads ARGUMENTS — can never know it. Reaching a created conversation is
 * therefore the job of the two result-side paths, neither of which routes through
 * here: `createdThreadIdFromToolResult` (the tool row renders the card itself, a
 * redundant path that survives a model that forgets the directive) and
 * the model's own `::created-thread` line (the body card). An unrelated MCP tool
 * that happens to take a `threadId` must not gain navigation, so this is an
 * allowlist and not a "has threadId" test.
 */
const NAVIGABLE_CHAT_ACTIVITY_KINDS: ReadonlySet<ChatActivityKind> = new Set(['read', 'send'])

export function chatActivityTarget(toolName: string, args: unknown, variant: ChatActivityVariant = 'row'): string | null {
  const kind = chatActivityKind(toolName, args)
  if (variant !== 'row' || kind === null || !NAVIGABLE_CHAT_ACTIVITY_KINDS.has(kind)) return null
  const input = record(args)
  const address = toolName === 'klaus_query' ? record(input?.arguments) : input
  // This navigator opens local chats only; remote IDs can collide with local IDs.
  const thisHost = localDeviceId()
  if (address?.hostId !== undefined && address.hostId !== 'local' && (!thisHost || address.hostId !== thisHost)) return null
  const id = toolName === 'klaus_query' ? address?.sessionId : address?.threadId
  // The navigation contract accepts a nonempty string; it does not trim or
  // validate an ID against a possibly stale sidebar inventory.
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Resolve a kind+state pair to display text.
 *
 * Two lookups, both deliberate:
 * 1. The published key names for the three states that already shipped —
 *    `active`, `completed` and `completed_following` — are kept as-is, so the
 *    existing translations and vectors stay valid and no string had to be
 *    re-translated for this change. That is why `following` maps onto the legacy
 *    `completed_following` key rather than a new one.
 * 2. `t()` returns the KEY ITSELF when a translation is missing, which would put
 *    something like `chat_activity_send_failed` on screen. So a miss falls back to
 *    the `other` form. `other` is reachable ONLY through that fallback:
 *    `chatActivityState` returns one of five states and never `other`, so the
 *    sixth is a defence against a future state arriving without a translation,
 *    not something any card renders today.
 *
 * This is the single place state becomes text; every caller goes through it, so
 * the mapping cannot drift between the row card and the summary line.
 */
function resolveChatActivityLabel(
  translate: (key: string) => string,
  kind: ChatActivityKind,
  state: ChatActivityState,
  leading: boolean,
): string {
  const legacy = state === 'following' ? 'completed_following' : state
  const key = `chat_activity_${kind}_${legacy}`
  const label = translate(key)
  if (label !== key) return label
  const otherKey = `chat_activity_${kind}_other`
  const other = translate(otherKey)
  if (other === otherKey) return label
  return leading ? upperFirst(other) : other
}

/**
 * The market display name for a skill identifier, or '' when it cannot be
 * resolved.
 *
 * The identifier is the skill's directory name, which is what the market list
 * and the installed list key on, so the market cache resolves it to the same
 * localized display name the Skills page shows. The cache is empty until the
 * page or its idle prewarm has run; callers fall back to the raw identifier,
 * because a raw name still tells the user WHICH skill loaded.
 */
export function skillDisplayName(identifier: string): string {
  const key = normalizeMarketKey(identifier)
  if (!key) return ''
  const cache = getSkillsCache()
  if (!cache) return ''
  for (const list of [cache.installed, cache.market, cache.builtin]) {
    const match = list.find(item => normalizeMarketKey(item?.dirName || item?.name) === key || normalizeMarketKey(item?.upstreamSlug) === key)
    const display = match ? localizeSkillName(match) : ''
    if (display) return display
  }
  return ''
}

/** The skill directory segment a SKILL.md path points at, e.g. `…/cr-review/SKILL.md` → `cr-review`. */
export function skillIdentifierFromPath(path: string): string {
  return path.replace(/[/\\]SKILL\.md$/i, '').split(/[/\\]/).filter(Boolean).at(-1) ?? ''
}

/**
 * The four-state label for a skill load, shared by the `skill` tool card and
 * by file reads whose target is a SKILL.md, so both surfaces word the same
 * event identically. The identifier is the skill's directory name or the tool
 * call's `name` argument; `{name}` in the message becomes its market display
 * name, falling back to the identifier itself. The caller applies its own
 * leading-capitalization rule.
 */
export function skillActivityLabel(translate: (key: string) => string, identifier: string, state: string): string {
  const key = state === 'error' ? 'failed' : state === 'interrupted' ? 'stopped' : state === 'running' || state === 'awaiting-approval' ? 'active' : 'completed'
  const raw = identifier.trim()
  // A streaming call carries no name yet; the unnamed wording stays honest
  // instead of showing a bare tool name or an empty slot.
  if (!raw) return translate(`chat_skill_unnamed_${key}`)
  const name = skillDisplayName(raw) || raw
  return translate(`chat_skill_${key}`).replace('{name}', name)
}

export function dynamicActivityLabel(translate: (key: string) => string, tool: ChatActivityTool, completed: boolean, leading = true): string {
  const locale = intlLocale()
  const effectiveState = tool.state === 'done' && !completed ? 'running' : tool.state
  const follow = (label: string) => leading || locale.startsWith('zh') ? label : label.charAt(0).toLowerCase() + label.slice(1)
  const semantic = semanticActivity(tool.toolName, tool.args, typeof tool.content === 'string' ? tool.content : undefined)
  if (semantic) return follow(semanticActivityLabel(semantic, effectiveState, locale))
  const kind = chatActivityKind(tool.toolName, tool.args)
  if (kind) return resolveChatActivityLabel(translate, kind, chatActivityState(tool.state, leading), leading)
  if (tool.toolName === 'skill') {
    const label = skillActivityLabel(translate, String(record(tool.args)?.name ?? ''), tool.state)
    return leading ? upperFirst(label) : label
  }
  if (tool.toolName === 'klaus_query') {
    const query = klausQueryActivity(tool.args, completed)
    const state = tool.state === 'error' ? 'failed' : tool.state === 'interrupted' ? 'stopped' : completed ? 'completed' : 'active'
    const label = translate(`chat_query_${state === 'active' || state === 'completed' ? query.verb + '_' : ''}${state}`)
      .replace('{target}', translate(`chat_query_target_${query.target}`))
    return leading ? upperFirst(label) : label
  }
  if (tool.toolName === 'read_thread_terminal') {
    const state = !completed ? 'active' : leading ? 'completed' : 'completed_following'
    return translate(`chat_activity_terminal_${state}`)
  }
  return follow(genericActivityLabel(tool.toolName, effectiveState, locale))
}

function klausQueryActivity(args: unknown, completed = false): { key: string; target: string; verb: 'query' | 'read' | 'search' | 'view' } {
  const input = record(args)
  const scope = typeof input?.key === 'string' ? input.key : ''
  // Only the top-level action is executed by the host. An action nested in
  // arguments is not a request to search/read and must not be presented as one.
  const action = typeof input?.action === 'string' ? input.action : ''
  const key = `${scope}:${action}`
  if (scope === 'docs') {
    if (!action && completed) return { key, target: 'docs_actions', verb: 'view' }
    if (action === 'search') return { key, target: 'docs', verb: 'search' }
    if (action === 'section') return { key, target: 'section', verb: 'read' }
    if (action === 'outline') return { key, target: 'outline', verb: 'view' }
    return { key, target: 'docs', verb: 'query' }
  }
  if (scope === 'account') {
    if (!action && completed) return { key, target: 'account_actions', verb: 'view' }
    return { key, target: action === 'status' ? 'account_status' : 'account', verb: 'query' }
  }
  return { key, target: 'klaus', verb: 'query' }
}

export function navigateChatActivity(toolName: string, args: unknown, navigate: (id: string) => unknown): boolean {
  const target = chatActivityTarget(toolName, args)
  if (target === null) return false
  void navigate(target)
  return true
}

function ActivityLabel({ active, children }: { active: boolean; children: ReactNode }) {
  const element = useRef<HTMLSpanElement>(null)
  const canAnimate = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  useEffect(() => {
    if (!active || !canAnimate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const node = element.current
    if (!node) return
    let finish: ReturnType<typeof setTimeout> | undefined
    let interval: ReturnType<typeof setInterval> | undefined
    const sweep = () => {
      if (finish) clearTimeout(finish)
      node.classList.remove(styles['chat-activity-sweeping'])
      node.classList.add(styles['chat-activity-sweeping'])
      finish = setTimeout(() => {
        node.classList.remove(styles['chat-activity-sweeping'])
        finish = undefined
      }, 1000)
    }
    const start = setTimeout(() => {
      sweep()
      interval = setInterval(sweep, 4000)
    }, 600)
    return () => {
      clearTimeout(start)
      if (finish) clearTimeout(finish)
      if (interval) clearInterval(interval)
      node.classList.remove(styles['chat-activity-sweeping'])
    }
  }, [active, canAnimate])
  return <span ref={element} className={`${styles['chat-activity-label']}${active ? ` ${styles['chat-activity-active']}` : ''}`}>
    {children}
    {active && canAnimate ? <span aria-hidden="true" className={styles['chat-activity-sweep']}>
      <span className={styles['chat-activity-highlight']}>{children}</span>
    </span> : null}
  </span>
}

/**
 * The display title of the conversation a coordination tool acted on, or '' when
 * it cannot be resolved on this screen.
 *
 * The row reads "Sent message to {title}" — the destination is part of the
 * event, not a detail hidden in the collapsed JSON. The sidebar inventory is the
 * same source the row's own navigation uses, resolved through the host-published
 * lookup so this module stays decoupled from the sidebar store. A remote-host
 * target or a thread this device has never listed resolves to '' and the label
 * keeps its generic wording, which is honest: showing no name beats guessing.
 */
export function chatActivityTargetTitle(toolName: string, args: unknown): string {
  const target = chatActivityTarget(toolName, args, 'row')
  if (!target) return ''
  const known = (typeof window !== 'undefined' ? (window as any).getKnownSessionInfo?.(target) : null) || null
  const title = String(known?.title || '').trim()
  if (!title || /^(?:新对话|New Chat)$/i.test(title)) return ''
  return title
}

/**
 * The opening of the message a `send_message_to_thread` carried, for the row.
 *
 * "Sent message to chat" leaves the user to expand JSON to learn what went out;
 * the delegated row names the destination, and the approval card already
 * shows the message head for the same reason. Here the head is appended after
 * the title so one row answers "to whom, saying what" without expanding.
 */
export function chatActivitySentHead(args: unknown, limit = 80): string {
  const prompt = (args as Record<string, unknown> | null)?.prompt
  if (typeof prompt !== 'string') return ''
  const head = prompt.trim().replace(/\s+/g, ' ')
  if (!head) return ''
  return head.length > limit ? `${head.slice(0, limit)}…` : head
}

export function ChatActivity({ tool, variant = 'row', leading = true, navigate }: {
  tool: ChatActivityTool
  variant?: ChatActivityVariant
  leading?: boolean
  navigate?: (id: string) => unknown
}) {
  const t = useT()
  // Device names arrive asynchronously from the account device list; a row that
  // names the destination computer must repaint when the name resolves.
  useDeviceNamesVersion()
  const kind = chatActivityKind(tool.toolName, tool.args)
  if (!isDynamicActivityTool(tool.toolName, tool.args)) return null
  const completed = chatActivityCompleted(tool.state)
  const target = chatActivityTarget(tool.toolName, tool.args, variant)
  const // Only settled send rows name the destination. Other chat actions and
    // summary lines use their localized lifecycle wording.
    targetTitle = variant === 'row' && kind === 'send' && completed && !chatActivityFailed(tool.state) ? chatActivityTargetTitle(tool.toolName, tool.args) : ''
  const // The message opening rides on EVERY settled send row, local or remote,
    // including a failed one (it says what did not get through): dropping it when
    // the destination cannot be named (a remote chat this device has never
    // listed) left the row saying nothing at all — "sent message to chat" with
    // no to-whom and no saying-what.
    sentHead = variant === 'row' && tool.toolName === 'send_message_to_thread' && completed
      ? chatActivitySentHead(tool.args)
      : ''
  const // A cross-computer send names the destination COMPUTER, not a chat title:
    // the target conversation lives on another device and this device has no
    // title for it. Unresolved falls through to the generic wording — but still
    // carries the message head, which is the half that must never drop.
    remoteDevice = variant === 'row' && tool.toolName === 'send_message_to_thread'
      ? deviceNameForHost((tool.args as Record<string, unknown> | null)?.hostId as string | undefined)
      : ''
  const state = chatActivityState(tool.state, leading)
  const stateKey = state === 'following' ? 'completed_following' : state
  const label = <ActivityLabel active={!completed}>
    {remoteDevice
      ? t(`chat_activity_send_remote_${stateKey}`).replace('{device}', remoteDevice) + (sentHead ? ` — ${sentHead}` : '')
      : targetTitle
        ? t(`chat_activity_${kind}_to_${stateKey}`).replace('{title}', targetTitle) + (sentHead ? ` — ${sentHead}` : '')
        : dynamicActivityLabel(t, tool, completed, leading) + (sentHead ? ` — ${sentHead}` : '')}
  </ActivityLabel>
  const content = <>{variant === 'summary-text' ? null : <Icon name="chat-activity" size={16} />}{label}</>
  const className = `${styles['chat-activity']}${variant === 'row' ? '' : ` ${styles['chat-activity-summary']}`}`
  const prompt = (tool.args as Record<string, unknown> | null)?.prompt
  if (variant === 'row' && kind === 'send' && typeof prompt === 'string' && prompt.length > 0) {
    return <details className={styles['chat-send-disclosure']} data-chat-send-disclosure>
      <summary className={className} data-chat-activity="send" data-chat-send-summary>
        {content}<Icon name="chevron-right" size={14} />
      </summary>
      <div className={styles['chat-send-body']}>
        <div className={styles['chat-send-heading']}>{t('chat_activity_sent_message_body')}</div>
        <pre className={styles['chat-send-message']}>{prompt}</pre>
        {target ? <button type="button" className={styles['chat-send-open']} data-chat-activity-thread-id={target}
          onClick={event => {
            event.stopPropagation()
            navigateChatActivity(tool.toolName, tool.args, navigate ?? (id => (window as any).klausSwitchSession?.(id)))
          }}>{t('chat_activity_created_thread_open')}</button> : null}
      </div>
    </details>
  }
  if (!kind && variant === 'row') return <div className={className} data-chat-activity="dynamic">{content}</div>
  if (target === null) return <span className={className} data-chat-activity={kind ?? 'dynamic'}>{content}</span>
  return <button type="button" className={`${className} ${styles['chat-activity-link']}`}
    data-chat-activity={kind} data-chat-activity-thread-id={target}
    onClick={event => {
      event.stopPropagation()
      navigateChatActivity(tool.toolName, tool.args, navigate ?? (id => (window as any).klausSwitchSession?.(id)))
    }}>{content}</button>
}

export function chatActivitySummaryParts(tools: ChatActivityTool[]): ChatActivityTool[] {
  const seen = new Map<string, ChatActivityTool>()
  for (const tool of tools) {
    if (!isDynamicActivityTool(tool.toolName, tool.args)) continue
    const kind = chatActivityKind(tool.toolName, tool.args)
    const key = `host:${tool.toolName}:${tool.toolName === 'klaus_query' ? kind ?? klausQueryActivity(tool.args).key : ''}`
    const previous = seen.get(key)
    seen.set(key, previous ? { ...previous, state: mediaGenerationSummaryState([previous.state, tool.state]) } : tool)
  }
  return [...seen.values()]
}

export function chatActivitySummaryLabel(translate: (key: string) => string, tools: ChatActivityTool[], leading = true): string {
  return new Intl.ListFormat(intlLocale(), { style: 'long', type: 'unit' }).format(
    chatActivitySummaryParts(tools).map((tool, index) => dynamicActivityLabel(
      translate, tool, true, leading && index === 0,
    )),
  )
}


export function ChatActivityDisclosure({ label, active, thinking = false, icon, summaryKey, open, onToggle, children }: {
  label: string
  active: boolean
  thinking?: boolean
  icon?: ReactNode
  summaryKey?: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const [bodyMounted, setBodyMounted] = useState(open)
  useEffect(() => { if (open) setBodyMounted(true) }, [open])
  const key = summaryKey ?? (active ? thinking ? 'thinking' : label : 'summary')
  const latest = { key, label, active, thinking, icon }
  const [displayed, setDisplayed] = useState(latest)
  const lastCommit = useRef<number | null>(null)
  useEffect(() => {
    const now = Date.now()
    lastCommit.current ??= now
    if (key === displayed.key) return
    const commit = () => {
      lastCommit.current = Date.now()
      setDisplayed(latest)
    }
    if (!active) { commit(); return }
    const remaining = 1000 - (now - lastCommit.current)
    if (remaining <= 0) { commit(); return }
    const timer = setTimeout(commit, remaining)
    return () => clearTimeout(timer)
  }, [key, label, active, thinking, icon, displayed.key])
  const header = !active || displayed.key === key ? latest : displayed
  return <div className={`${styles['chat-activity-fold']}${open ? ' open' : ''}`}>
    <button type="button" className={styles['chat-activity-toggle']} aria-expanded={open}
      onClick={event => { event.stopPropagation(); onToggle() }}>
      {header.thinking ? null : header.icon ?? <Icon name="chat-activity" size={16} />}
      <ActivityLabel active={header.active}>{header.label}</ActivityLabel>
      <Icon name="chevron-right" cls={styles['activity-fold-chevron']} />
    </button>
    <div className={styles['chat-activity-collapse']} inert={!open} aria-hidden={!open}
      onTransitionEnd={event => {
        if (event.target === event.currentTarget && !open) setBodyMounted(false)
      }}>
      <div className={styles['chat-activity-body']}>{open || bodyMounted ? children : null}</div>
    </div>
  </div>
}
