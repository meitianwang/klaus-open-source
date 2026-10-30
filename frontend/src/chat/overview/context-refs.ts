// What this conversation leaned on, grouped by kind.
//
// The signals are already in the tool traffic the transcript renders: MCP calls
// carry their server in the tool name, skill lookups come through skill_search,
// memory writes arrive as their own frame, and a slash command the user picked is
// known at send time. Collecting it from those keeps the section honest — nothing
// is listed that the session did not actually do.
//
// Three tabs, one per page that owns the thing: skills, memory, connectors. A
// tab with nothing in it is not rendered, and a row opens the page that owns it.
// Sub-agents are NOT a group here: they have their own standing section, and one
// fact reported in two places gets double-counted in both headers.
import { tt } from '../../app/i18n'
import { icon as klausIcon } from '../../icons/registry'
import { applyDefaultCollapseState, overviewDeps, styles } from './shared'

type ReferenceGroup = 'skills' | 'memory' | 'mcp'
const REFERENCE_GROUPS: ReferenceGroup[] = ['skills', 'memory', 'mcp']
const REFERENCE_GROUP_LABELS: Record<ReferenceGroup, string> = {
  skills: 'references_tab_skills',
  memory: 'references_tab_memory',
  mcp: 'references_tab_mcp',
}
// Each row is a jump-off point to the page that owns that kind of thing, and it
// carries that page's own icon so the row and its destination read as one thing.
const REFERENCE_GROUP_RAIL: Record<ReferenceGroup, string> = { skills: 'btn-skills', memory: 'btn-memory', mcp: 'btn-mcp' }
const REFERENCE_GROUP_ICON: Record<ReferenceGroup, string> = {
  skills: 'overview-ref-skill',
  memory: 'overview-ref-memory',
  mcp: 'overview-ref-mcp',
}
interface ReferenceEntry { label: string; details: string[]; count: number }
interface SessionReferenceState {
  skills: Map<string, ReferenceEntry>
  memory: Map<string, ReferenceEntry>
  mcp: Map<string, ReferenceEntry>
  seen: Set<string>
}
const sessionReferences = new Map<string, SessionReferenceState>()
let referencesActiveGroup: ReferenceGroup = 'skills'

function referencesFor(sessionId: string | null, create = false): SessionReferenceState | null {
  if (!sessionId) return null
  let entry = sessionReferences.get(sessionId)
  if (!entry && create) {
    entry = { skills: new Map(), memory: new Map(), mcp: new Map(), seen: new Set() }
    sessionReferences.set(sessionId, entry)
  }
  return entry || null
}

// `occurrenceId` identifies the thing that happened (a tool call id), so a
// transcript that gets rendered twice — replay after a rewind, a DOM-cache flip
// — reports the same counts as the first render instead of doubling them.
function addSessionReference(sessionId: string | null, group: ReferenceGroup, key: string, label: string, detail = '', occurrenceId = ''): void {
  const entry = referencesFor(sessionId, true)
  if (!entry || !entry[group] || !key) return
  if (occurrenceId) {
    const token = `${group}:${occurrenceId}`
    if (entry.seen.has(token)) return
    entry.seen.add(token)
  }
  const existing = entry[group].get(key)
  if (existing) {
    existing.count += 1
    if (detail && !existing.details.includes(detail)) existing.details.push(detail)
  } else {
    entry[group].set(key, { label: label || key, details: detail ? [detail] : [], count: 1 })
  }
  if (sessionId === overviewDeps().currentSessionId()) renderReferencesPanel()
}

// Classify one tool call. Unknown tools are not references — reading a file is
// work, not a citation — so only the kinds below are recorded.
export function noteToolReference(sessionId: string | null, toolName: unknown, toolCallId: unknown, args: unknown): void {
  const name = String(toolName || '')
  if (!sessionId || !name) return
  const occurrence = String(toolCallId || '')
  const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    const server = parts[1] || name
    addSessionReference(sessionId, 'mcp', server, server, parts.slice(2).join('__'), occurrence)
    return
  }
  if (name === 'mcp_search' || name === 'mcp_prompts' || name === 'mcp_resources') {
    addSessionReference(sessionId, 'mcp', name, name, '', occurrence)
    return
  }
  if (name === 'skill_search' || name === 'request_skill_install') {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    addSessionReference(sessionId, 'skills', `${name}:${query}`, query || tt('references_tab_skills'), name, occurrence)
    return
  }
  // A delegated turn is not a citation here: the sub-agents section already lists
  // every agent this conversation derived, with its status and its own timing.
  // save_memory is a write the turn made, and the memory tab is where writes are
  // listed, so it lands there keyed by the call that made it.
  if (name === 'save_memory') {
    const text = typeof input.memory === 'string' ? input.memory.trim() : ''
    if (!text || !occurrence) return
    addSessionReference(sessionId, 'memory', text, text.length > 60 ? `${text.slice(0, 60)}\u2026` : text, name, occurrence)
  }
}

// A completed auto-memory / auto-dream pass. One row per touched file, because
// the file name IS the memory kind in Klaus (one file per kind under
// ~/.klaus/agent-memory). A pass that merely ran touched nothing and says nothing.
export function noteMemoryWriteReference(sessionId: string | null, runId: string, kind: string, filesTouched: string[]): void {
  if (!sessionId || !runId) return
  for (const file of filesTouched) {
    if (!file) continue
    addSessionReference(sessionId, 'memory', file, file.split('/').pop() || file, kind, `${runId}:${file}`)
  }
}

// A slash command the user attached is a reference this turn stands on. Keyed by
// the message uuid so a re-rendered transcript does not count the send twice.
export function noteCommandReference(sessionId: string | null, command: { name?: string } | null, occurrenceId = ''): void {
  if (!sessionId || !command) return
  const deps = overviewDeps()
  const group = deps.commandGroupKey(command)
  if (group !== 'skills' && group !== 'plugins' && group !== 'mcp') return
  const name = deps.slashCommandDisplayName(command) || command.name || ''
  if (!name) return
  addSessionReference(
    sessionId,
    group === 'mcp' ? 'mcp' : 'skills',
    `command:${name}`,
    name,
    `/${command.name || name}`,
    occurrenceId,
  )
}

function referenceGroupCount(sessionId: string | null, group: ReferenceGroup): number {
  return referencesFor(sessionId)?.[group]?.size || 0
}

export function renderReferencesPanel(): void {
  const tabsEl = document.getElementById('monitor-references-tabs')
  const bodyEl = document.getElementById('monitor-references-body')
  if (!tabsEl || !bodyEl) return
  const sessionId = overviewDeps().currentSessionId()
  // Land on a group that has something in it, so the section never opens empty
  // while another group holds entries.
  if (referenceGroupCount(sessionId, referencesActiveGroup) === 0) {
    const populated = REFERENCE_GROUPS.find(group => referenceGroupCount(sessionId, group) > 0)
    if (populated) referencesActiveGroup = populated
  }
  // The tab label is the whole tab: a count badge on a tab that only exists
  // because it has entries is a number that can never read zero.
  tabsEl.replaceChildren(...REFERENCE_GROUPS.filter(group => referenceGroupCount(sessionId, group) > 0).map(group => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = styles['artifacts-subtab']
    btn.setAttribute('role', 'tab')
    const active = group === referencesActiveGroup
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
    btn.textContent = tt(REFERENCE_GROUP_LABELS[group])
    btn.addEventListener('click', () => {
      referencesActiveGroup = group
      renderReferencesPanel()
    })
    return btn
  }))

  const entries = [...(referencesFor(sessionId)?.[referencesActiveGroup]?.values() || [])]
  if (entries.length === 0) {
    bodyEl.replaceChildren()
    const empty = document.createElement('div')
    empty.className = 'ctx-empty'
    empty.textContent = tt('references_empty')
    bodyEl.appendChild(empty)
    return
  }
  bodyEl.replaceChildren(...entries.map(entry => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = styles['reference-row']
    const mark = document.createElement('span')
    mark.className = styles['reference-row-icon']
    mark.setAttribute('aria-hidden', 'true')
    mark.innerHTML = klausIcon(REFERENCE_GROUP_ICON[referencesActiveGroup])
    row.appendChild(mark)
    const label = document.createElement('span')
    label.className = styles['reference-row-label']
    label.textContent = entry.label
    row.appendChild(label)
    row.addEventListener('click', () => {
      document.getElementById(REFERENCE_GROUP_RAIL[referencesActiveGroup])?.click()
    })
    return row
  }))
  applyDefaultCollapseState('monitor-section-references')
}

// Replay 路径采集：history 是权威回放源，其中的 tool_use 块与 live 事件看到的是
// 同一批调用（同 id）。订阅按 history 数组引用变化触发，seen set 幂等。
interface HistoryContentBlock { type?: string; name?: string; id?: string; input?: unknown }
interface HistoryMessage { content?: HistoryContentBlock[] | string }
const scannedHistories = new WeakSet<object>()
export function scanHistoryForReferences(sessionId: string, history: unknown): void {
  if (!Array.isArray(history) || history.length === 0) return
  if (scannedHistories.has(history as object)) return
  scannedHistories.add(history as object)
  for (const msg of history as HistoryMessage[]) {
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name) {
        noteToolReference(sessionId, block.name, block.id || '', block.input)
      }
    }
  }
}
