import { activityToolPresentation, isDynamicActivityPresentation } from './activity-tool-model'
import { chatActivitySummaryParts, isToolDiscovery, loadedActivityToolNames, mcpActivityIsCommand, mcpActivitySource, mcpActivitySourceName, nativeActivityKind, type ChatActivityTool } from './chat-activity'
import { semanticActivity } from './activity-semantic'

// Shared projection for streamed and replayed activity. Tool classification
// affects the summary, never whether an ordinary tool belongs to its turn.
export type ActivityKind = 'image' | 'read' | 'list' | 'search' | 'web' | 'edit' | 'command' | 'tool' | 'skill'

export interface ActivityAction {
  kind: ActivityKind
  name: string
  target: string
  paths: string[]
  running: boolean
  failed: boolean
  source?: string
  tool: ChatActivityTool
  dynamic?: boolean
  discoveredNames?: string[]
  imageCount?: number
}

export interface ActivityEntry<T> {
  key: string
  value: T
  grouping: 'tool' | 'standalone' | 'reasoning'
  action?: ActivityAction
}

export interface ActivitySummary {
  images: number
  reads: number
  lists: number
  searches: number
  web: number
  edits: number
  commands: number
  tools: Array<{ name: string; count: number }>
  sources: string[]
  skills: number
  allTools: ChatActivityTool[]
  dynamicTools: ChatActivityTool[]
  loadedTools: number
  unnamedMcp: number
  explorationKind?: 'read' | 'list' | 'search'
}

export type ActivityProjection<T> =
  | { kind: 'item'; entry: ActivityEntry<T> }
  | { kind: 'group'; key: string; entries: ActivityEntry<T>[]; summary: ActivitySummary; mode: 'summary' | 'active' | 'thinking'; activeAction?: ActivityAction }

function stringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof args[key] === 'string' && args[key]) return args[key] as string
  return ''
}

export function describeActivity(name: string, input: unknown, status: string, output?: string, media?: Array<{ path: string; mimeType?: string }>): ActivityAction {
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { /* Preserve unstructured arguments. */ } }
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const normalized = name.toLowerCase().replace(/^functions[._]/, '')
  const tool: ChatActivityTool = { toolName: name, args: input, state: status, ...(output !== undefined ? { content: output } : {}), ...(media?.length ? { media } : {}) }
  const presentation = activityToolPresentation({ toolCallId: '', toolName: name, args: input, state: 'done', media, output })
  let target = stringArg(args, 'file_path', 'notebook_path', 'path', 'pattern', 'query', 'q', 'command', 'cmd')
  let kind: ActivityKind = 'tool'
  if (presentation.semantic) target = presentation.semantic.target
  else if (presentation.kind === 'image' || presentation.kind === 'read' || presentation.kind === 'list' || presentation.kind === 'search' || presentation.kind === 'skill') {
    kind = presentation.kind
    target = presentation.kind === 'search' ? presentation.query : presentation.path
  }
  else if (/^(web_search|web_fetch|websearch|webfetch|fetch_url)$/.test(normalized)) kind = 'web'
  else if (presentation.kind === 'edit') kind = 'edit'
  else if (presentation.kind === 'exec') kind = 'command'
  else if (!isToolDiscovery(name)) {
    const nativeKind = nativeActivityKind(name)
    if (nativeKind === 'command') kind = 'command'
    else if (nativeKind === 'search') kind = 'search'
  }
  if (kind === 'read' && /(?:^|[/\\])SKILL\.md$/i.test(target)) kind = 'skill'
  const source = mcpActivitySource(name)
  if (mcpActivityIsCommand(name)) kind = 'command'
  const paths = kind === 'edit' ? [...new Set([
    stringArg(args, 'file_path', 'notebook_path', 'path'),
    ...String(args.patch || args.input || (typeof input === 'string' ? input : '')).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
  ].map(value => typeof value === 'string' ? value : value[1]).filter(Boolean))] : []
  const dynamic = kind === 'tool' && isDynamicActivityPresentation(presentation)
  return {
    kind, name, target, paths, tool,
    running: status === 'running' || status === 'awaiting-approval', failed: status === 'error',
    ...(kind === 'tool' && source ? { source: mcpActivitySourceName(source) } : {}),
    ...(dynamic ? { dynamic: true } : {}),
    ...(isToolDiscovery(name) ? { discoveredNames: [...loadedActivityToolNames([tool])] } : {}),
    ...(kind === 'image' ? { imageCount: presentation.imageCount || 1 } : {}),
  }
}

export function summarizeActivity<T>(entries: ActivityEntry<T>[]): ActivitySummary {
  const reads = new Set<string>()
  const edits = new Set<string>()
  const skills = new Set<string>()
  const sources = new Set<string>()
  const tools = new Map<string, number>()
  const loaded = new Set<string>()
  const dynamicTools: ChatActivityTool[] = []
  const summary: ActivitySummary = { images: 0, reads: 0, lists: 0, searches: 0, web: 0, edits: 0, commands: 0, tools: [], sources: [], skills: 0, allTools: [], dynamicTools: [], loadedTools: 0, unnamedMcp: 0 }
  for (const entry of entries) {
    const action = entry.action
    if (!action) continue
    summary.allTools.push(action.tool)
    if (action.dynamic) { dynamicTools.push(action.tool); continue }
    if (action.discoveredNames) {
      for (const name of action.discoveredNames) loaded.add(name)
      continue
    }
    if (['read', 'list', 'search'].includes(action.kind)) summary.explorationKind ||= action.kind as 'read' | 'list' | 'search'
    switch (action.kind) {
      case 'image': summary.images += action.imageCount || 1; break
      case 'read': reads.add(action.target || entry.key); break
      case 'list': summary.lists++; break
      case 'search': summary.searches++; break
      case 'web': summary.web++; break
      case 'edit': for (const path of action.paths.length ? action.paths : [entry.key]) edits.add(path); break
      case 'command': summary.commands++; break
      case 'skill': skills.add(action.target.replace(/\\/g, '/')); break
      case 'tool':
        if (semanticActivity(action.name, action.tool.args)) tools.set(action.name, (tools.get(action.name) || 0) + 1)
        else if (action.source) sources.add(action.source)
        else if (action.name.startsWith('mcp__')) summary.unnamedMcp++
        else tools.set(action.name, (tools.get(action.name) || 0) + 1)
        break
    }
  }
  summary.sources = [...sources]
  summary.skills = skills.size
  summary.reads = reads.size
  summary.edits = edits.size
  summary.tools = [...tools].map(([name, count]) => ({ name, count }))
  summary.dynamicTools = chatActivitySummaryParts(dynamicTools)
  summary.loadedTools = loaded.size
  return summary
}

export function projectActivity<T>(entries: ActivityEntry<T>[], active: boolean, tailClosed = false): ActivityProjection<T>[] {
  const nodes: ActivityProjection<T>[] = []
  let pending: ActivityEntry<T>[] = []
  const flush = (tail = false) => {
    if (!pending.length) return
    const items = pending
    pending = []
    // A later message or parallel activity does not finish an earlier tool.
    const activeAction = active ? [...items].reverse().find(item => item.action?.running)?.action : undefined
    // A tool result ends one call, not the sequence. Keep the live tail open
    // through model requests until visible content or a final/turn boundary.
    const mode = activeAction ? 'active' : active && tail && !tailClosed ? 'thinking' : 'summary'
    // A lone action is already a one-line record: wrapping it in a disclosure
    // would only repeat the row label behind a chevron, so a single settled
    // item stays standalone. Blocks of two or more collapse into a summary
    // that condenses what the rows spell out.
    if (mode === 'summary' && items.length === 1) {
      nodes.push({ kind: 'item', entry: items[0] })
    } else {
      nodes.push({ kind: 'group', key: items[0].key, entries: items, summary: summarizeActivity(items), mode, activeAction })
    }
  }
  for (const entry of entries) {
    if (entry.grouping === 'reasoning') continue
    if (entry.grouping === 'tool') pending.push(entry)
    else {
      flush()
      nodes.push({ kind: 'item', entry })
    }
  }
  flush(true)
  return nodes
}

export function activityCollapseState(mode: 'summary' | 'active' | 'thinking', collapsed?: boolean): { enabled: boolean; open: boolean } {
  const enabled = mode === 'summary'
  return { enabled, open: !enabled || collapsed === false }
}

export function turnCollapseState(options: {
  hasFinal: boolean
  interrupted: boolean
  hasActivity: boolean
  hasRunningTools?: boolean
  preventAutoCollapse?: boolean
  collapsed?: boolean
  allowCollapseBeforeFinal?: boolean
}): { allowed: boolean; open: boolean } {
  const allowed = (!!options.allowCollapseBeforeFinal || options.hasFinal && !options.interrupted)
    && (!options.hasRunningTools || !!options.allowCollapseBeforeFinal) && options.hasActivity
  return { allowed, open: !allowed || !(options.collapsed ?? !options.preventAutoCollapse) }
}

// A page starts at a turn boundary so fetching earlier messages never changes
// the first activity's identity or steals its persisted disclosure state.
export function transcriptPageStart(messages: any[], requested: number): number {
  let start = Math.max(0, Math.min(requested, messages.length))
  while (start > 0 && start < messages.length) {
    const current = messages[start]
    const previous = messages[start - 1]
    const isUserRequest = current.role === 'user'
      && current.kind !== 'compaction'
      && current.kind !== 'compact-summary'
      && current.kind !== 'compact-file-restore'
    if (current.turnId) {
      if (previous.turnId && previous.turnId !== current.turnId) break
      if (isUserRequest && previous.turnId !== current.turnId) break
    } else if (isUserRequest) break
    start--
  }
  return start
}
