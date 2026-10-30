// Shared spine of the overview panel: the injected host dependencies, the
// section-collapse machinery every section calls into, and the brand loading
// mark.
//
// Everything here is what more than one section needs. Sections import from this
// module and never from each other, so the panel has no import cycles and a
// section can be read on its own.
import { icon as klausIcon } from '../../icons/registry'
import type { SpecDocument } from '../spec-document-model'
import styles from './overview.module.css'

export { styles }

// ---- 跨域依赖注入（slash 命令归组仍在 chat.ts） ----
export interface MonitorSummaryDeps {
  currentSessionId(): string | null
  commandGroupKey(command: unknown): string
  slashCommandDisplayName(command: unknown): string
  specDocuments(sessionId: string): SpecDocument[]
  subscribeSpecDocuments(listener: () => void): () => void
  openSpecDocument(document: { sessionId: string; path: string }): unknown
}

// Set once by initMonitorSummary. Read through a function so a section that runs
// before injection fails loudly on the missing dependency instead of silently
// capturing an undefined binding at module-eval time.
let deps!: MonitorSummaryDeps
export function setOverviewDeps(injected: MonitorSummaryDeps): void {
  deps = injected
}
export function overviewDeps(): MonitorSummaryDeps {
  return deps
}

// ==================== Monitor sections collapse ====================
// Monitor sections collapse in place. The chevron sits at the right end of the
// section header (the header row itself is the hit target), and the collapsed
// set is persisted so the panel comes back the way it was left.
//
// A section with no persisted choice defaults to `hasContent`: an empty section
// opens collapsed so the summary is a short list of what this conversation
// actually has, not a wall of headers the user has to fold away once each.
const MONITOR_SECTION_COLLAPSE_KEY = 'klaus_monitor_sections_collapsed'
const SECTIONS_KEPT_OPEN_WHEN_EMPTY = new Set<string>()
const COLLAPSIBLE_MONITOR_SECTIONS = [
  'monitor-section-plan',
  'monitor-section-subagents',
  'monitor-section-background-processes',
  'monitor-section-artifacts',
  'monitor-section-references',
]

function readCollapsedMonitorSections(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MONITOR_SECTION_COLLAPSE_KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

// Sections the user has never touched are absent from BOTH persisted sets, so
// the expanded set is what separates "chose to open" from "never decided".
const MONITOR_SECTION_EXPANDED_KEY = 'klaus_monitor_sections_expanded'

function readExpandedMonitorSections(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MONITOR_SECTION_EXPANDED_KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function sectionHasContent(section: HTMLElement): boolean {
  if (SECTIONS_KEPT_OPEN_WHEN_EMPTY.has(section.id)) return true
  const body = section.querySelector('.artifacts-section-body')
  if (!body) return false
  // A body holding only an empty-state line has no content. Groups count when
  // they are visible: a hidden group is one that reported nothing.
  const groups = [...body.querySelectorAll('.artifacts-group')]
  if (groups.length > 0) return groups.some(group => !(group as HTMLElement).hidden)
  const meaningful = [...body.children].filter(child => !child.classList.contains('ctx-empty'))
  return meaningful.some(child => (child.textContent || '').trim().length > 0 || child.children.length > 0)
}

// Called after a section's content changes so a section that filled up for the
// first time opens itself, while one the user folded stays folded.
export function applyDefaultCollapseState(sectionId: string): void {
  const section = document.getElementById(sectionId)
  if (!section) return
  if (readCollapsedMonitorSections().has(sectionId)) return
  if (readExpandedMonitorSections().has(sectionId)) return
  const collapsed = !sectionHasContent(section)
  section.classList.toggle('collapsed', collapsed)
  section.querySelector('.artifacts-section-header')?.setAttribute('aria-expanded', String(!collapsed))
}

export function initMonitorSectionCollapse(): void {
  const collapsed = readCollapsedMonitorSections()
  const expanded = readExpandedMonitorSections()
  for (const id of COLLAPSIBLE_MONITOR_SECTIONS) {
    const section = document.getElementById(id)
    const header = section?.querySelector('.artifacts-section-header')
    if (!section || !header) continue
    const startCollapsed = collapsed.has(id)
      ? true
      : expanded.has(id)
        ? false
        : !sectionHasContent(section)
    section.classList.toggle('collapsed', startCollapsed)
    const chevron = document.createElement('span')
    chevron.className = styles['artifacts-section-chevron']
    chevron.setAttribute('aria-hidden', 'true')
    chevron.innerHTML = klausIcon('chat-init-monitor-section-collapse')
    header.appendChild(chevron)
    header.setAttribute('role', 'button')
    ;(header as HTMLElement).tabIndex = 0
    header.setAttribute('aria-expanded', String(!startCollapsed))
    const toggle = () => {
      const next = !section.classList.contains('collapsed')
      section.classList.toggle('collapsed', next)
      header.setAttribute('aria-expanded', String(!next))
      // Both sets are written so a later content change cannot silently
      // override a choice the user made in either direction.
      const collapsedSet = readCollapsedMonitorSections()
      const expandedSet = readExpandedMonitorSections()
      if (next) {
        collapsedSet.add(id)
        expandedSet.delete(id)
      } else {
        collapsedSet.delete(id)
        expandedSet.add(id)
      }
      localStorage.setItem(MONITOR_SECTION_COLLAPSE_KEY, JSON.stringify([...collapsedSet]))
      localStorage.setItem(MONITOR_SECTION_EXPANDED_KEY, JSON.stringify([...expandedSet]))
    }
    header.addEventListener('click', (event) => {
      // Header actions keep their own click.
      if ((event.target as HTMLElement).closest('button, a')) return
      toggle()
    })
    header.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key !== 'Enter' && key !== ' ') return
      if (event.target !== header) return
      event.preventDefault()
      toggle()
    })
  }
}
