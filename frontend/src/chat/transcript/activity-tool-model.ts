import type { ApprovalReview } from '../../../../contracts/approval-review'
import { isCompactActivityTool, isDynamicActivityTool, isToolDiscovery, mcpActivityIsCommand, mcpActivitySource } from './chat-activity'
import { isAgentActionToolName } from './activity-agent-action-model'
import { mediaGenerationKind, MEDIA_GENERATION_ICONS, type MediaGenerationKind } from './media-generation-activity'
import { activityDisplayName, activityResultObjects, semanticActivity, type SemanticActivity } from './activity-semantic'

export type ActivityToolState = 'running' | 'done' | 'error' | 'interrupted' | 'awaiting-approval'

export interface ActivityToolData {
  approvalReviews?: ApprovalReview[]
  toolCallId: string
  sessionId?: string
  parentAgentId?: string
  toolName: string
  args: unknown
  state: ActivityToolState
  output?: string
  startedAtMs?: number
  durationMs?: number
  exitCode?: number
  media?: Array<{ path: string; mimeType?: string }>
}

export interface ActivityToolProps {
  readOnly?: boolean
  tool: ActivityToolData
  open: boolean
  onToggle: () => void
}

type RecordValue = Record<string, unknown>
type ToolKind = 'native' | 'generation' | 'image' | 'read' | 'search' | 'list' | 'exec' | 'edit' | 'skill' | 'discovery' | 'tool'

export interface ActivityToolPresentation {
  kind: ToolKind
  name: string
  command: string
  path: string
  query: string
  cwd: string
  args: unknown
  source?: string
  imageCount?: number
  generationKind?: MediaGenerationKind
  semantic?: SemanticActivity
  imagePaths?: string[]
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function textField(value: RecordValue | null, ...keys: string[]): string {
  for (const key of keys) if (typeof value?.[key] === 'string' && value[key]) return value[key] as string
  return ''
}

function numberField(value: RecordValue | null, ...keys: string[]): number | undefined {
  for (const key of keys) if (typeof value?.[key] === 'number' && Number.isFinite(value[key])) return value[key] as number
  return undefined
}

const IMAGE_TOOL_NAMES = new Set([
  'view_image', 'viewimage', 'screenshot', 'browser_screenshot',
  'capture_screenshot', 'capturescreenshot', 'capture_screen_context', 'capturescreencontext',
])

/** Keep this list aligned with the engine's image-aware `read` implementation. */
export function isReadableImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(path.trim())
}

function imageReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (typeof item === 'string') return item ? [item] : []
    const object = record(item)
    return object ? [textField(object, 'path', 'file_path', 'image_path', 'url')].filter(Boolean) : []
  })
}

function imageCount(tool: ActivityToolData, object: RecordValue | null, path: string, explicit: boolean): number {
  const media = tool.media?.filter(item => item?.path) || []
  if (media.length) return media.length
  const referenced = [
    ...imageReferences(object?.referenced_image_paths),
    ...imageReferences(object?.image_paths),
    ...imageReferences(object?.paths),
    ...imageReferences(object?.images),
  ]
  if (referenced.length) return referenced.length
  if (path && (explicit || isReadableImagePath(path))) return 1
  return explicit ? 1 : 0
}

function viewedImagePaths(tool: ActivityToolData, object: RecordValue | null, path: string): string[] {
  const local = (value: string) => /^(?:\/|[A-Za-z]:[/\\]|\\\\)/.test(value) && !value.includes('\0')
  const returned = (tool.media ?? []).filter(item => item.path && (!item.mimeType || item.mimeType.startsWith('image/'))).map(item => item.path)
  const resolved = activityResultObjects(tool.output).filter(item => item.found === true && item.kind === 'image' && typeof item.path === 'string').map(item => item.path as string)
  const args = [...imageReferences(object?.referenced_image_paths), ...imageReferences(object?.image_paths), ...imageReferences(object?.paths), ...imageReferences(object?.images), path,
    textField(object, 'image_path', 'imagePath')]
  return [...new Set((returned.length ? returned : resolved.length ? resolved : args).filter(value => value && local(value))) ]
}

/** Tokenize only simple shell commands; compound commands keep their full execution view. */
export function simpleCommandWords(command: string): string[] | null {
  const words: string[] = []
  let word = '', quote = '', started = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (character === '\\' && quote !== "'") {
      if (index + 1 === command.length) return null
      word += command[++index]
      started = true
    } else if (quote) {
      if (character === quote) quote = ''
      else {
        if (quote === '"' && (character === '$' || character === '`')) return null
        word += character
      }
    } else if (character === '"' || character === "'") {
      quote = character
      started = true
    } else if (/[|;&<>`$\n\r()]/.test(character)) return null
    else if (/\s/.test(character)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += character
      started = true
    }
  }
  if (quote) return null
  if (started) words.push(word)
  return words
}

export function displayShellCommand(command: string): string {
  const words = simpleCommandWords(command.trim())
  if (words?.length === 3 && /(?:^|\/)(?:zsh|bash|sh)$/.test(words[0]) && /^-[a-z]*c[a-z]*$/.test(words[1])) return words[2]
  return command.trim()
}

function semanticShellCommand(command: string): Pick<ActivityToolPresentation, 'kind' | 'path' | 'query'> | null {
  const words = simpleCommandWords(command)
  if (!words?.length) return null
  const name = words[0].split('/').pop()
  const parameters = words.slice(1)
  if (name === 'cat' && parameters.length === 1 && !parameters[0].startsWith('-')) return { kind: 'read', path: parameters[0], query: '' }
  if ((name === 'head' || name === 'tail') && parameters.length > 0) {
    const rest = parameters.filter((word, index) => !/^-(?:\d+|[nqc])+?$/.test(word) && !/^--(?:lines|bytes)=/.test(word) && !['-n', '-c', '--lines', '--bytes'].includes(parameters[index - 1]))
    if (rest.length === 1 && !rest[0].startsWith('-')) return { kind: 'read', path: rest[0], query: '' }
  }
  if (name === 'sed' && parameters.length === 3 && parameters[0] === '-n' && /^\d+(?:,\d+)?p$/.test(parameters[1])) return { kind: 'read', path: parameters[2], query: '' }
  if (name === 'ls') {
    const paths = parameters.filter(word => !word.startsWith('-'))
    if (paths.length <= 1) return { kind: 'list', path: paths[0] ?? '', query: '' }
  }
  if (name === 'rg' || name === 'grep') {
    const paths: string[] = []
    const patterns: string[] = []
    const valueFlags = new Set(['-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '--max-depth', '--color', '--colors', '--encoding'])
    let literal = false
    for (let index = 0; index < parameters.length; index++) {
      const word = parameters[index]
      if (literal) { paths.push(word); continue }
      if (word === '--') { literal = true; continue }
      if (word === '-e' || word === '--regexp') { if (!parameters[index + 1]) return null; patterns.push(parameters[++index]); continue }
      if (word === '-f' || word === '--file') return null
      if (valueFlags.has(word)) { if (!parameters[index + 1]) return null; index++; continue }
      if (word.startsWith('-')) continue
      paths.push(word)
    }
    if (name === 'rg' && parameters.includes('--files')) return { kind: 'list', path: paths.join(', '), query: '' }
    if (!patterns.length && paths.length) patterns.push(paths.shift()!)
    if (patterns.length) return { kind: 'search', path: paths.join(', '), query: patterns.join(', ') }
  }
  return null
}

export function activityToolPresentation(tool: ActivityToolData): ActivityToolPresentation {
  const args = parseArguments(tool.args)
  const object = record(args)
  const name = tool.toolName.toLowerCase().replace(/^functions[._]/, '')
  const commandValue = textField(object, 'command', 'cmd') || (Array.isArray(object?.command) ? object.command.join(' ') : '')
  const command = displayShellCommand(commandValue)
  const path = textField(object, 'file_path', 'notebook_path', 'path', 'filePath', 'filename', 'directory')
  const query = textField(object, 'pattern', 'query', 'search_query', 'regex', 'q')
  const common = { name: tool.toolName, command, path, query, cwd: textField(object, 'cwd', 'workdir', 'working_directory'), args, source: mcpActivitySource(tool.toolName) ?? undefined }
  const generationKind = mediaGenerationKind(tool.toolName)
  if (generationKind) return { ...common, kind: 'generation', generationKind }
  // Discovery retains output controls even after success; a file-search row does not.
  if (isToolDiscovery(tool.toolName)) return { ...common, kind: 'discovery' }
  if (['write', 'write_file', 'writefile', 'edit', 'edit_file', 'editfile', 'multi_edit', 'multiedit', 'apply_patch', 'patch', 'notebook_edit', 'notebookedit'].includes(name)) return { ...common, kind: 'edit' }
  const explicitImage = IMAGE_TOOL_NAMES.has(name)
  const count = imageCount(tool, object, path, explicitImage)
  if (explicitImage || (['read', 'read_file', 'readfile'].includes(name) && isReadableImagePath(path))) {
    const imagePaths = viewedImagePaths(tool, object, path)
    return { ...common, kind: 'image', imageCount: imagePaths.length || count, imagePaths }
  }
  const semantic = semanticActivity(tool.toolName, args, tool.output)
  if (semantic) return { ...common, kind: 'native', semantic }
  if (['read', 'read_file', 'readfile', 'notebook_read', 'notebookread'].includes(name)) return { ...common, kind: /(?:^|[/\\])SKILL\.md$/i.test(path) ? 'skill' : 'read' }
  if (['grep', 'search', 'file_search', 'search_files', 'rg'].includes(name)) return { ...common, kind: 'search' }
  if (['ls', 'list', 'list_dir', 'list_files', 'list_directory', 'glob'].includes(name)) return { ...common, path: path || query, kind: 'list' }
  if (['bash', 'exec', 'command', 'terminal', 'exec_command', 'shell', 'execute_command', 'run_command', 'bashoutput', 'bash_output', 'write_stdin'].includes(name)) {
    const semantic = semanticShellCommand(command)
    return { ...common, kind: 'exec', ...semantic, ...(semantic?.kind === 'read' && /(?:^|[/\\])SKILL\.md$/i.test(semantic.path) ? { kind: 'skill' as const } : {}) }
  }
  return { ...common, kind: 'tool' }
}

/** Tool names that describe a web lookup; the presentation vocabulary has no `web` kind. */
const WEB_TOOL_NAMES = /^(?:web_search|web_fetch|websearch|webfetch|fetch_url)$/

/** Plan/task mutations; their transcript rows are dropped but the group summary still resolves one. */
const PLAN_TOOL_NAMES = /^(?:task_write|taskwrite|task_create|taskcreate|task_update|taskupdate|task_get|taskget|task_list|tasklist|create_plan|createplan|update_plan|updateplan|todo_write|todowrite|enter_plan_mode|enterplanmode|exit_plan_mode|exitplanmode|suggest_execution_mode)$/

/**
 * One icon per tool row, resolved for every surface that draws one.
 *
 * The per-item card, the collapsed group summary and the in-progress headline
 * used to each carry their own name→glyph table. They disagreed: a lone `read`
 * row drew `tool-read` while the headline drew `tool-notebook`, a `list` row drew
 * `tool-list` while the headline drew `folder`, and a web search drew a generic
 * wrench because `ToolKind` has no `web` member at all. Three tables is what let
 * that drift happen, so there is now one.
 *
 * The agent-action, edit, dynamic and mcp branches MIRROR `ActivityToolContent`'s
 * dispatch in order. Each of those hands the row to a component that draws its
 * own fixed glyph and never asks this function, so a resolver that skipped the
 * order would disagree with the very row it summarises. Everything below the
 * mirror is the generic card, which does ask.
 *
 * `presentation` is optional because the summary surfaces only have a tool name;
 * the card passes its own memoised one so streaming arguments are not re-parsed
 * on every delta.
 */
export function activityToolIconName(toolName: string, args?: unknown, presentation?: ActivityToolPresentation): string {
  const resolved = presentation ?? activityToolPresentation({ toolCallId: '', toolName, args, state: 'done' })
  if (resolved.generationKind) return MEDIA_GENERATION_ICONS[resolved.generationKind]
  if (resolved.semantic) return resolved.semantic.icon
  if (!toolName.startsWith('mcp__') && isAgentActionToolName(toolName)) return 'subagent-banner'
  if (resolved.kind === 'edit') return 'tool-edit'
  const name = (toolName || '').toLowerCase().replace(/^functions[._]/, '')
  // Plan mutations never reach a card — they are dropped before rendering — so
  // the dispatch mirror cannot bind them. Resolve them by name first, or the
  // host-tool fallback below would claim them and the summary would lose the
  // plan glyph it used to draw.
  if (PLAN_TOOL_NAMES.test(name)) return 'tool-plan-mode'
  if (isDynamicActivityPresentation(resolved)) return isCompactActivityTool(toolName, args) ? 'chat-activity' : 'tool-wrench'
  if (toolName.startsWith('mcp__')) return mcpActivityIsCommand(toolName) ? 'tool-bash' : 'tool-mcp-plug'
  // Name distinctions the generic card can make but `ToolKind` cannot express.
  if (WEB_TOOL_NAMES.test(name)) return 'tool-web'
  if (/(?:^|[_-])notebook(?:[_-]|$)/.test(name)) return 'tool-notebook'
  if (['agent', 'spawn_agent', 'task', 'task_output', 'task_stop'].includes(name)) return 'tool-agent'
  if (['ask_user', 'askuserquestion', 'request_user_input'].includes(name)) return 'tool-ask-user'
  if (/^(?:cron|schedule)/.test(name)) return 'tool-clock'
  if (name === 'pushnotification') return 'tool-bell'
  if (['monitor', 'remotetrigger'].includes(name)) return 'tool-monitor'
  if (name.endsWith('worktree')) return 'tool-worktree'
  if (name === 'think') return 'tool-think'
  if (name === 'advisor') return 'tool-advisor'
  // `glob` classifies as a list (its label reads "Listed files in …"), but the
  // summary table always gave it its own glyph to separate pattern enumeration
  // from a directory listing. Preserved rather than collapsed into `tool-list`.
  if (name === 'glob') return 'tool-glob'
  switch (resolved.kind) {
    // A SKILL.md load reads like any other file: the summary text carries the
    // distinction, so the glyph does not need its own case.
    case 'image': return 'tool-image'
    case 'read': case 'skill': return 'tool-read'
    case 'list': return 'tool-list'
    case 'search': case 'discovery': return 'tool-grep'
    case 'exec': return 'tool-bash'
    default: return 'tool-wrench'
  }
}

/** New native aliases and agent controls take precedence over the host fallback. */
export function isDynamicActivityPresentation(presentation: ActivityToolPresentation): boolean {
  const nativeName = presentation.name.toLowerCase().replace(/^functions[._]/, '')
  return presentation.kind === 'tool'
    && !isAgentActionToolName(presentation.name)
    && nativeName !== 'fetch_url'
    && isDynamicActivityTool(nativeName, presentation.args)
    && isDynamicActivityTool(presentation.name, presentation.args)
}

export interface ActivityShellResult {
  output: string
  exitCode?: number
  durationMs?: number
  startedAtMs?: number
  shellId?: string
  timedOut: boolean
  aborted: boolean
}

/** Decode transport metadata only when the result is an identifiable command envelope. */
export function activityShellResult(tool: ActivityToolData): ActivityShellResult {
  const raw = tool.output ?? ''
  let object: RecordValue | null = null
  try { object = record(JSON.parse(raw)) } catch { /* Plain stdout stays byte-for-byte intact. */ }
  const envelope = object && ['exitCode', 'exit_code', 'stdout', 'stderr', 'aggregatedOutput', 'shellId', 'timedOut', 'aborted', 'durationMs', 'duration_ms'].some(key => key in object!)
  const value = envelope ? object : null
  const streams = value && (typeof value.stdout === 'string' || typeof value.stderr === 'string')
    ? [value.stdout, value.stderr].filter((part): part is string => typeof part === 'string').join('') : undefined
  const output = value ? streams ?? textField(value, 'aggregatedOutput', 'output', 'text', 'content') : raw
  return {
    output,
    exitCode: tool.exitCode ?? numberField(value, 'exitCode', 'exit_code'),
    durationMs: tool.durationMs ?? numberField(value, 'durationMs', 'duration_ms'),
    startedAtMs: tool.startedAtMs ?? numberField(value, 'startedAtMs', 'started_at_ms'),
    shellId: textField(value, 'shellId', 'shell_id') || undefined,
    timedOut: value?.timedOut === true || value?.timed_out === true,
    aborted: value?.aborted === true,
  }
}

export function activityInputText(args: unknown): string {
  if (typeof args === 'string') return args
  if (args === undefined) return ''
  try { return JSON.stringify(args, null, 2) ?? String(args) } catch { return String(args) }
}



/** Human-readable fallback when a tool has no specialized presentation metadata. */
export function activityToolDisplayName(name: string): string {
  return activityDisplayName(name)
}
