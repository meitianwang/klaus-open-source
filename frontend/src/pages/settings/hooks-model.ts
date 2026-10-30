/** Stable event order for configured hooks; unknown events remain visible last. */
export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'PermissionRequest', 'PermissionDenied', 'Setup',
  'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult',
  'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded', 'CwdChanged', 'FileChanged',
] as const

export interface HookStateRow {
  key: string
  scope: 'global' | 'project'
  filePath: string
  event: string
  command: string
  matcher?: string
  timeoutMs?: number
  isAsync: boolean
  status: 'trusted' | 'new' | 'changed' | 'disabled'
}

export interface HooksReply {
  ok?: boolean
  error?: string
  hooks?: Record<string, unknown>
  path?: string
  rows?: HookStateRow[]
  disabledByPolicy?: boolean
  managedOnly?: boolean
}

export interface HookEntry {
  id: string
  event: string
  type: string
  content: string
  filePath: string
  matcher?: string
  timeoutMs?: number
  isAsync: boolean
  state?: HookStateRow
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

/** A project reply also includes global rows. Each source owns only its file. */
export function hookEntries(reply: HooksReply, scope: 'global' | 'project'): HookEntry[] {
  const rows = (Array.isArray(reply.rows) ? reply.rows : [])
    .filter(row => row.scope === scope && row.filePath === reply.path)
  const consumed = new Set<string>()
  const entries: HookEntry[] = []
  for (const [event, groups] of Object.entries(object(reply.hooks))) {
    if (!Array.isArray(groups)) continue
    groups.forEach((value, groupIndex) => {
      const group = object(value)
      if (!Array.isArray(group.hooks)) return
      group.hooks.forEach((value, hookIndex) => {
        const hook = object(value)
        if (!Object.keys(hook).length) return
        const state = rows.find(row => row.event === event && row.key.endsWith(`:${event}:${groupIndex}:${hookIndex}`))
        if (state) consumed.add(state.key)
        const type = state ? 'command' : typeof hook.type === 'string' ? hook.type : 'unknown'
        const content = type === 'command' ? state?.command ?? hook.command
          : type === 'http' ? hook.url : hook.prompt
        entries.push({
          id: state?.key ?? `${reply.path}:${event}:${groupIndex}:${hookIndex}`,
          event, type, content: typeof content === 'string' ? content : JSON.stringify(hook, null, 2),
          filePath: reply.path ?? '', state,
          matcher: state ? state.matcher : typeof group.matcher === 'string' ? group.matcher : undefined,
          timeoutMs: state ? state.timeoutMs : typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) ? hook.timeout * 1000 : undefined,
          isAsync: state ? state.isAsync : hook.async === true,
        })
      })
    })
  }
  for (const state of rows) {
    if (consumed.has(state.key)) continue
    entries.push({
      id: state.key, event: state.event, type: 'command', content: state.command,
      filePath: state.filePath, matcher: state.matcher, timeoutMs: state.timeoutMs,
      isAsync: state.isAsync, state,
    })
  }
  return entries
}

export function groupHookEntries(entries: HookEntry[]): Array<{ event: string; entries: HookEntry[] }> {
  const groups = new Map<string, HookEntry[]>()
  for (const entry of entries) groups.set(entry.event, [...(groups.get(entry.event) ?? []), entry])
  const order = (event: string) => {
    const index = (HOOK_EVENTS as readonly string[]).indexOf(event)
    return index < 0 ? HOOK_EVENTS.length : index
  }
  return [...groups].sort(([a], [b]) => order(a) - order(b))
    .map(([event, entries]) => ({ event, entries }))
}

export function needsHookReview(entry: HookEntry): boolean {
  return entry.state?.status === 'new' || entry.state?.status === 'changed'
}

export function parseHooksEditorValue(raw: string): Record<string, unknown> {
  const parsed: unknown = raw.trim() ? JSON.parse(raw) : {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('hooks_invalid_object')
  if (!Object.hasOwn(parsed, 'hooks')) return parsed as Record<string, unknown>
  const hooks = (parsed as Record<string, unknown>).hooks ?? {}
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('hooks_invalid_object')
  return hooks as Record<string, unknown>
}
