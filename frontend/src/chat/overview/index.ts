// The overview panel's assembly point: wiring, one repaint entry, and the public
// face the rest of the chat surface imports.
//
// Sections live in sibling modules and know nothing about each other. This file
// is the only place that knows which sections compose the panel, so a caller
// never has to.
import { chatStreamStore } from '../stream-store'
import {
  initMonitorSectionCollapse,
  setOverviewDeps,
  overviewDeps,
  type MonitorSummaryDeps,
} from './shared'
import { initArtifactsSection, reloadArtifacts, renderArtifactsSection } from './artifacts'
import { renderReferencesPanel, scanHistoryForReferences } from './context-refs'
import { reconcilePlanSection, resetPlanViewport } from './plan'
import { renderSubagentSection } from './subagents'
import { renderBackgroundProcessSection } from './background-processes'
import { initComputerUseSection, renderComputerUseSection } from './computer-use'

// ---- Public face (chat.ts / approvals.ts / panel-tabs.tsx consume these) ----
export type { MonitorSummaryDeps } from './shared'
export { applyDefaultCollapseState } from './shared'
export { artifactTurn, artifactsReady, ensureArtifactsForSession, formatLineCount, reloadArtifacts, revealArtifacts, subscribeArtifacts, artifactsVersion } from './artifacts'
export type { ArtifactFile, ArtifactTurn, LineCount } from './artifacts'
export { noteCommandReference, noteMemoryWriteReference, noteToolReference, renderReferencesPanel } from './context-refs'
export { reconcilePlanSection, renderPlanRows, resetPlanViewport, revealPlan } from './plan'
export {
  initBackgroundProcessSection,
  backgroundProcessClockSnapshot,
  backgroundProcessDisplayTitle,
  backgroundProcessDuration,
  backgroundProcessStatusText,
  renderBackgroundProcessSection,
  subscribeBackgroundProcessClock,
} from './background-processes'
export {
  initSubagentSection,
  isBackgroundSubagent,
  isTerminalSubagentStatus,
  renderSubagentSection,
  subagentConversationId,
  subagentClockSnapshot,
  subagentDisplayName,
  subagentDisplayStatus,
  subagentStatusText,
  subagentTaskText,
  subscribeSubagentClock,
  type SubagentEntry,
} from './subagents'

export function initMonitorSummary(injected: MonitorSummaryDeps): void {
  setOverviewDeps(injected)
  let specSignature = ''
  const renderIfSpecListChanged = () => {
    const sessionId = injected.currentSessionId() || ''
    const next = JSON.stringify([sessionId, injected.specDocuments(sessionId).map(document => [document.path, document.title])])
    if (specSignature === next) return
    specSignature = next
    renderArtifactsSection()
  }
  injected.subscribeSpecDocuments(renderIfSpecListChanged)
  initMonitorSectionCollapse()
  initArtifactsSection()
  initComputerUseSection()
  // Every summary section is session-scoped, so they repaint on every switch. The
  // current Task snapshot has its own cache and refresh path. Artifacts refetch
  // their engine record, and each conversation starts at the top of its plan.
  window.addEventListener('klaus:session-change', () => {
    resetPlanViewport()
    void reloadArtifacts()
    renderOverviewSections()
    renderIfSpecListChanged()
  })
  window.addEventListener('klaus:lang-change', renderOverviewSections)
  // Replay 采集：history 到位/更新时扫一遍 tool_use（幂等）。
  chatStreamStore.subscribe((state) => {
    const sessionId = overviewDeps().currentSessionId()
    if (!sessionId) return
    const history = (state.sessions as Record<string, { history?: unknown }>)[sessionId]?.history
    if (history) scanHistoryForReferences(sessionId, history)
  })
  renderOverviewSections()
  renderIfSpecListChanged()
}

// One repaint entry point for the whole summary, in the order the panel reads.
export function renderOverviewSections(): void {
  reconcilePlanSection()
  renderSubagentSection()
  renderBackgroundProcessSection()
  renderComputerUseSection()
  renderArtifactsSection()
  renderReferencesPanel()
}
