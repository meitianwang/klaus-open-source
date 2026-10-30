// Unified task sidebar: Pinned, Channels, Projects, and Recent share one
// session model and one row implementation. Automation executions are ordinary
// sessions with a source marker; their definitions and history stay in Scheduled.
import { createRoot } from 'react-dom/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { useLayoutEffect, useRef } from 'react'
import { rawIconHtml } from '../../components/Icon'
import { RawHtml } from '../../components/RawHtml'
import { escapeHtml } from '../transcript/factories'
import type { CollapsedBadge, SidebarSectionKey } from './collapse'
import type { SidebarSortMode } from './sort'
import { MarqueeText } from './marquee-text'
import type { SessionWaitingKind } from './attention'
import { ProjectDropIndicator, ProjectReorderList, useProjectGroupDrag, useProjectReorder } from './project-reorder'
import styles from './sidebar.module.css'

const tt = (key: string): string => (window as any).tt?.(key) || ''

export interface SessionRowSpec {
  id: string
  active: boolean
  working: boolean
  completeUnread: boolean
  leadState: 'working' | 'failed' | 'unread' | 'read'
  title: string
  channelLabel: string | null
  worktreeTitle: string | null
  automationLabel: string | null
  pinned: boolean
  draft: boolean
  branchIconHtml: string
  /** Which kind of wait is parked: approval vs user input. Drives the row's
   *  status chip and the Needs-input pill's snooze affordance. */
  waitingKind: SessionWaitingKind | null
  /** Requests parked on this row; >0 makes it a waiting row. */
  waitingCount: number
  /** Snooze deadline (epoch ms) for the Needs-input pill's countdown fill; a
   *  pill without a deadline renders as a static label like Awaiting approval. */
  snoozeDeadlineMs: number | null
  /** Snooze is available only on Needs-input rows. */
  snoozeRequestId: string | null
  /** Completed-but-unseen turns; the badge caps at 99. */
  unreadCount: number
  /** A friend message that awaits the user's reply parks a static pill. */
  friendAwaiting?: boolean
}

/** A thread row inside a project group. Rows inside a project group carry no
 *  timestamp; neither do the flat sections, so the two paths read the same. */
export type ProjectThreadRowSpec = SessionRowSpec

export interface ProjectRowSpec {
  key: string
  name: string
  workdir: string
  ssh: boolean
  isWorkspace?: boolean
  /** A friend folder: grouped by friendship, no project menu and no new-chat. */
  isFriend?: boolean
  workspaceId?: string | null
  active: boolean
  expanded: boolean
  justOpened: boolean
  closing: boolean
  /** Friend groups only: requests this computer still owes a decision plus
   *  conversations holding unread friend messages; painted as a number at the
   *  row's trailing edge, folded or not. */
  pendingCount?: number
  /** Aggregate status while the group is folded: spinner when something inside
   *  runs, dot when something waits/is unread, else null. */
  collapsedBadge: CollapsedBadge
  threads: null | {
    rows: ProjectThreadRowSpec[]
    /** Rows remain beyond the pagination window. */
    more: boolean
  }
}

/** One sidebar section: rows plus its own collapse state and folded badge. */
export interface SidebarSectionSpec<T> {
  rows: T[]
  collapsed: boolean
  collapsedBadge: CollapsedBadge
}

/** The Projects section adds drag-reorder state: the order is the user's own
 *  arrangement, and a commit is optimistic, so the indicator stays painted until
 *  the host confirms (or rolls back) the write. Optional because a snapshot
 *  built before a reorder ever happened simply has nothing in flight. */
export interface ProjectsSectionSpec extends SidebarSectionSpec<ProjectRowSpec> {
  /** A reorder commit is in flight. */
  reorderPending?: boolean
}

export interface SidebarSnapshot {
  pinned: SidebarSectionSpec<SessionRowSpec>
  channels: SidebarSectionSpec<SessionRowSpec>
  projects: ProjectsSectionSpec
  recent: SidebarSectionSpec<SessionRowSpec>
  /** Active ordering; drives the sort action's aria-label so
   *  React re-renders own every attribute on the button. */
  sortMode: SidebarSortMode
  /** Whether the ordering menu is open; drives the trigger's aria-expanded. */
  sortMenuOpen: boolean
}

export interface SidebarActions {
  switchSession(id: string): void
  showContextMenu(event: MouseEvent | React.MouseEvent, sessionId: string, rowEl: HTMLElement): void
  toggleProject(workdir: string): void
  projectMenu(key: string, anchor: HTMLElement | null, point: { x: number; y: number } | null): void
  projectNewChat(workdir: string): void
  /** Reveal ten more threads in a group (5 shown first, then +10 per press;
   *  there is no "show less" inside a project group). */
  showMoreThreads(key: string): void
  toggleSection(section: SidebarSectionKey): void
  addProjectFromSection(): void
  projectCloseFinished(key: string): void
  /** Commit a dragged Projects-section order. `keys` is the section's complete
   *  top-to-bottom key list, not an index pair: the host stores that list, and it
   *  stays correct if a row appears or vanishes between the drag and the write. */
  reorderProjects(keys: string[]): void
  /** Snooze a Needs-input wait for 60s. */
  snoozeInput(sessionId: string, requestId: string): void
  /** Open the sidebar ordering menu anchored to the section
   *  head action that triggered it. */
  openSortMenu(anchor: HTMLElement): void
}

export interface SidebarApi {
  render(snapshot: SidebarSnapshot): void
}

// 前导状态槽：working→spinner、failed→红点、
// unread→蓝点、read→灰点，固定 12px 让标题对齐成列。
function leadHtml(state: string): string {
  if (state === 'working') {
    const label = tt('agent_status_running') || 'Running'
    return `<span class="${styles['s-lead']} is-working" role="status" aria-label="${escapeHtml(label)}">${rawIconHtml('s-lead-spinner-track')}</span>`
  }
  if (state === 'failed') {
    const label = tt('cron_status_failed') || 'Failed'
    return `<span class="${styles['s-lead']} is-failed" role="status" aria-label="${escapeHtml(label)}"></span>`
  }
  if (state === 'unread') {
    const label = tt('agent_status_completed') || 'Completed'
    return `<span class="${styles['s-lead']} is-unread" role="status" aria-label="${escapeHtml(label)}"></span>`
  }
  return `<span class="${styles['s-lead']}" aria-hidden="true"></span>`
}

/** Everything before the title in a session row. The title is a real React
 *  element (MarqueeText) so it can own its measurement lifecycle, which means
 *  the row can no longer be one flat HTML string — the parts around it are
 *  rendered through RawHtml with `display: contents` so they stay direct flex
 *  participants of the row, exactly as they were when inlined. */
function sessionRowPrefixHtml(row: SessionRowSpec): string {
  const automationHtml = row.automationLabel
    ? `<span class="${styles['s-automation-source']}" role="img" aria-label="${escapeHtml(row.automationLabel)}">${rawIconHtml('cron-sb-task')}</span>`
    : ''
  const badgeHtml = row.channelLabel ? `<span class="s-channel-badge">${escapeHtml(row.channelLabel)}</span>` : ''
  const worktreeBadgeHtml = row.worktreeTitle !== null
    ? `<span class="s-channel-badge ${styles['s-worktree-badge']}" aria-label="${escapeHtml(row.worktreeTitle)}">${escapeHtml(tt('worktree_badge'))}</span>`
    : ''
  // A waiting row's chip replaces the lead status: the pill IS the state, a dot
  // beside it would double-report.
  const leadState = row.waitingCount > 0 ? 'read' : row.leadState
  return `${leadHtml(leadState)}${automationHtml}${badgeHtml}${worktreeBadgeHtml}`
}

function sessionRowSuffixHtml(row: SessionRowSpec): string {
  const draftHtml = row.draft ? `<span class="s-draft-badge">${escapeHtml(tt('draft_badge'))}</span>` : ''
  return `${row.branchIconHtml}${draftHtml}${statusChipHtml(row)}<button class="session-menu-action" type="button" aria-label="${escapeHtml(tt('session_menu_more'))}">${rawIconHtml('chat-session-menu')}</button>`
}

// ==================== waiting-state chips ====================
//
// Awaiting approval → green chip in the title line (bg green/20).
// Needs input → blue pill at the row's trailing edge (bg blue/15),
// click snoozes the wait for 60s and the pill carries a countdown fill that
// drains toward the deadline and restarts the wait when it empties. Waiting rows
// hide their lead dot: the pill IS the state.

function chipLabel(key: string, fallback: string): string {
  const value = tt(key)
  return value && value !== key ? value : fallback
}

function awaitingApprovalChipHtml(): string {
  const label = chipLabel('session_awaiting_approval', 'Awaiting approval')
  return `<span class="s-status-chip is-approval" role="status">${escapeHtml(label)}</span>`
}

function needsInputPillHtml(row: SessionRowSpec): string {
  const label = chipLabel('session_needs_input', 'Needs input')
  const aria = chipLabel('session_needs_input_aria', 'Needs your input — click to snooze for a minute')
  const snoozeRequestId = row.snoozeRequestId ?? ''
  // Countdown fill: animation-delay holds the bar full until (deadline − 60s),
  // then drains over the remaining window.
  const fill = row.snoozeDeadlineMs != null
    ? `<span class="s-status-pill-fill" aria-hidden="true"></span>`
    : ''
  return `<button class="s-status-pill is-input" type="button" role="status" aria-label="${escapeHtml(aria)}" data-snooze-request="${escapeHtml(snoozeRequestId)}">${fill}<span class="s-status-pill-label">${escapeHtml(label)}</span></button>`
}

/** A friend message awaiting a reply parks a static, non-interactive chip:
 *  unlike the Needs-input pill it carries no snooze affordance. */
function friendAwaitChipHtml(): string {
  const label = chipLabel('friend_await_reply', 'Awaiting reply')
  return `<span class="s-status-chip is-friend" role="status">${escapeHtml(label)}</span>`
}

function statusChipHtml(row: SessionRowSpec): string {
  if (row.waitingCount > 0) {
    if (row.waitingKind === 'input') return needsInputPillHtml(row)
    return awaitingApprovalChipHtml()
  }
  if (row.friendAwaiting) return friendAwaitChipHtml()
  return ''
}

/** The thread-row title renders through MarqueeText with
 *  `animateOnGroupHover`, so the row carries the `kls-marquee-group` hover
 *  marker. Both row kinds use it; keeping it a single global name lets the
 *  marquee stylesheet trigger without knowing about either row class. */
const MARQUEE_GROUP_CLASS = 'kls-marquee-group'

function SessionRow({ row, actions }: { row: SessionRowSpec; actions: SidebarActions }) {
  return (
    <SessionRowContainer
      className={styles['session-item'] + ' ' + MARQUEE_GROUP_CLASS + (row.active ? ' active' : '') + (row.working ? ' is-working' : '') + (row.completeUnread ? ' is-complete-unread' : '') + (row.waitingCount > 0 ? ' is-waiting' : '')}
      row={row}
      actions={actions}
      onClick={(e) => {
        const menuBtn = (e.target as HTMLElement).closest('.session-menu-action')
        if (menuBtn) {
          e.stopPropagation()
          actions.showContextMenu(e, row.id, e.currentTarget as HTMLElement)
          return
        }
        actions.switchSession(row.id)
      }}
    >
      <RawHtml tag="span" className={styles.contents} html={sessionRowPrefixHtml(row)} />
      <MarqueeText className={styles['s-title']} animateOnGroupHover><span dir="auto">{row.title}</span></MarqueeText>
      <RawHtml tag="span" className={styles.contents} html={sessionRowSuffixHtml(row)} />
    </SessionRowContainer>
  )
}

/** Collapsed aggregate badge: a spinner while something inside
 *  runs, a dot when something waits or is unread, nothing otherwise. Rendered
 *  only while the owner is folded. */
function collapsedBadgeHtml(badge: CollapsedBadge): string {
  if (badge === 'loading') {
    const label = tt('sidebar_badge_working') || 'Working'
    return `<span class="${styles['s-lead']} is-working" role="status" aria-label="${escapeHtml(label)}">${rawIconHtml('s-lead-spinner-track')}</span>`
  }
  if (badge === 'unread') {
    const label = tt('sidebar_badge_attention') || 'Needs attention'
    return `<span class="${styles['s-lead']} is-unread" role="status" aria-label="${escapeHtml(label)}"></span>`
  }
  return ''
}

/** Section header: a real toggle button with aria-expanded and a disclosure
 *  chevron. The chevron hides until hover/focus but stays visible while the
 *  section is collapsed (rotated -90deg), so a folded section still reads as
 *  expandable.
 *
 *  The chevron sits immediately AFTER the label text. Putting it
 *  before the label (and reserving its width even while hidden) made every
 *  section head read as indented relative to the nav rows above it.
 *
 *  The prop is named `label`, not `title`, because a `title=` attribute on a
 *  sidebar surface would be a tooltip and the tooltip-policy guard is
 *  deliberately strict about that (AGENTS.md). */
function SectionHeader({ label, sectionKey, collapsed, badge, actions, trailing }: {
  label: string
  sectionKey: SidebarSectionKey
  collapsed: boolean
  badge: CollapsedBadge
  actions: SidebarActions
  trailing?: React.ReactNode
}) {
  return (
    <div className={styles['sidebar-section-head']}>
      <button
        type="button"
        className={styles['sidebar-section-toggle'] + (collapsed ? ' is-collapsed' : '')}
        data-section-toggle={sectionKey}
        aria-expanded={collapsed ? 'false' : 'true'}
        onClick={() => actions.toggleSection(sectionKey)}
      >
        <span className={styles['sidebar-section-label']}>{label}</span>
        <span
          aria-hidden="true"
          className={styles['sidebar-section-chevron']}
          dangerouslySetInnerHTML={{ __html: rawIconHtml('chat-sidebar-chevron') }}
        />
      </button>
      {badge ? (
        <span className={styles['sidebar-section-badge']} dangerouslySetInnerHTML={{ __html: collapsedBadgeHtml(badge) }} />
      ) : null}
      {trailing}
    </div>
  )
}

function SessionSection({ label, sectionKey, section, actions, trailing }: {
  label: string
  sectionKey: SidebarSectionKey
  section: SidebarSectionSpec<SessionRowSpec>
  actions: SidebarActions
  trailing?: React.ReactNode
}) {
  if (section.rows.length === 0) return null
  return (
    <section className={styles['sidebar-task-section']}>
      <SectionHeader label={label} sectionKey={sectionKey} collapsed={section.collapsed} badge={section.collapsedBadge} actions={actions} trailing={trailing} />
      {section.collapsed ? null : (
        <div className={styles['sidebar-task-section-body']}>
          {section.rows.map(row => <SessionRow row={row} actions={actions} key={row.id} />)}
        </div>
      )}
    </section>
  )
}

// ==================== projects 组（含开合动画） ====================
// 动画机制对齐旧 animateProjectThreadListOpen/collapse…WithAnimation：高度/
// 内边距/透明度/位移四通道过渡，transitionend(height) 或 300ms 兜底收尾。
// React 姿势：入场在 mount 后播（justOpened）；退场保留节点播完再回调
// closeFinished 让数据面真正移除（closing 标记驱动）。

function reduceSidebarMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
}

function threadListPadding(list: HTMLElement) {
  const style = getComputedStyle(list)
  return { top: style.paddingTop, bottom: style.paddingBottom }
}

function clearThreadListMotionStyles(list: HTMLElement) {
  list.style.height = ''
  list.style.opacity = ''
  list.style.transform = ''
  list.style.paddingTop = ''
  list.style.paddingBottom = ''
}

function animateThreadListOpen(list: HTMLElement) {
  if (!list || reduceSidebarMotion()) return
  const targetHeight = list.scrollHeight
  const padding = threadListPadding(list)
  list.classList.add('is-animating')
  list.style.height = '0px'
  list.style.paddingTop = '0px'
  list.style.paddingBottom = '0px'
  list.style.opacity = '0'
  list.style.transform = 'translateY(-2px)'
  list.getBoundingClientRect()
  requestAnimationFrame(() => {
    list.style.height = `${targetHeight}px`
    list.style.paddingTop = padding.top
    list.style.paddingBottom = padding.bottom
    list.style.opacity = '1'
    list.style.transform = 'translateY(0)'
  })
  const cleanup = (event?: TransitionEvent) => {
    if (event && event.propertyName !== 'height') return
    list.classList.remove('is-animating')
    clearThreadListMotionStyles(list)
    list.removeEventListener('transitionend', cleanup as any)
  }
  list.addEventListener('transitionend', cleanup as any)
  setTimeout(() => cleanup(), 300)
}

function projectThreadPrefixHtml(row: ProjectThreadRowSpec): string {
  const automationHtml = row.automationLabel
    ? `<span class="${styles['s-automation-source']}" role="img" aria-label="${escapeHtml(row.automationLabel)}">${rawIconHtml('cron-sb-task')}</span>`
    : ''
  const leadState = row.waitingCount > 0 ? 'read' : row.leadState
  return `${leadHtml(leadState)}${automationHtml}`
}

function projectThreadSuffixHtml(row: ProjectThreadRowSpec): string {
  return `${row.branchIconHtml}${statusChipHtml(row)}<button class="${styles['project-thread-menu']}" type="button" aria-label="${escapeHtml(tt('session_menu_more'))}">${rawIconHtml('chat-session-menu')}</button>`
}

function ProjectThreadRow({ row, actions }: { row: ProjectThreadRowSpec; actions: SidebarActions }) {
  return (
    <SessionRowContainer
      className={styles['project-thread-item'] + ' ' + MARQUEE_GROUP_CLASS + (row.active ? ' active' : '') + (row.working ? ' is-working' : '') + (row.completeUnread ? ' is-complete-unread' : '') + (row.waitingCount > 0 ? ' is-waiting' : '')}
      row={row}
      actions={actions}
      onClick={(e) => {
        const menuBtn = (e.target as HTMLElement).closest(`.${styles['project-thread-menu']}`)
        if (menuBtn) {
          e.stopPropagation()
          actions.showContextMenu(e, row.id, e.currentTarget as HTMLElement)
          return
        }
        actions.switchSession(row.id)
      }}
    >
      <RawHtml tag="span" className={styles.contents} html={projectThreadPrefixHtml(row)} />
      <MarqueeText className={styles['project-thread-title']} animateOnGroupHover><span dir="auto">{row.title}</span></MarqueeText>
      <RawHtml tag="span" className={styles.contents} html={projectThreadSuffixHtml(row)} />
    </SessionRowContainer>
  )
}

/** Shared row shell for both row kinds: keyboard activation, the context menu,
 *  and the Needs-input pill's snooze click. A snooze click must not also switch
 *  sessions, so the pill button stops propagation. */
function SessionRowContainer({ className, row, actions, onClick, children }: {
  className: string
  row: SessionRowSpec
  actions: SidebarActions
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}) {
  return (
    <div
      className={className}
      tabIndex={0}
      aria-current={row.active ? 'page' : undefined}
      data-waiting={row.waitingCount > 0 ? row.waitingKind : undefined}
      onClick={(e) => {
        const snoozeBtn = (e.target as HTMLElement).closest('.s-status-pill') as HTMLElement | null
        if (snoozeBtn) {
          e.stopPropagation()
          const requestId = snoozeBtn.dataset.snoozeRequest || ''
          if (requestId) actions.snoozeInput(row.id, requestId)
          return
        }
        onClick(e)
      }}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onClick(e as unknown as React.MouseEvent)
      }}
      onContextMenu={(e) => actions.showContextMenu(e, row.id, e.currentTarget as HTMLElement)}
    >
      {children}
    </div>
  )
}

function ProjectThreadList({ project, actions }: { project: ProjectRowSpec; actions: SidebarActions }) {
  const ref = useRef<HTMLDivElement>(null)
  const closingStarted = useRef(false)

  // 入场动画：本次快照刚打开时在 mount 帧播。
  useLayoutEffect(() => {
    if (project.justOpened && ref.current) animateThreadListOpen(ref.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 退场动画：closing 置位后播一次，完成（transitionend height 或 300ms）
  // 回调 closeFinished 让数据面移除本节点。
  useLayoutEffect(() => {
    if (!project.closing || closingStarted.current) return
    const list = ref.current
    if (!list) return
    closingStarted.current = true
    if (reduceSidebarMotion()) {
      actions.projectCloseFinished(project.key)
      return
    }
    const startHeight = list.getBoundingClientRect().height
    const padding = threadListPadding(list)
    list.classList.add('is-animating', 'is-closing')
    list.style.height = `${startHeight}px`
    list.style.paddingTop = padding.top
    list.style.paddingBottom = padding.bottom
    list.style.opacity = '1'
    list.style.transform = 'translateY(0)'
    list.getBoundingClientRect()
    requestAnimationFrame(() => {
      list.style.height = '0px'
      list.style.paddingTop = '0px'
      list.style.paddingBottom = '0px'
      list.style.opacity = '0'
      list.style.transform = 'translateY(-2px)'
    })
    let finished = false
    const finish = (event?: TransitionEvent) => {
      if (finished || (event && event.propertyName !== 'height')) return
      finished = true
      list.removeEventListener('transitionend', finish as any)
      actions.projectCloseFinished(project.key)
    }
    list.addEventListener('transitionend', finish as any)
    setTimeout(() => finish(), 300)
  }, [project.closing])

  // 退场动画未播完就重新展开：节点不卸载（key 稳定），于是残留的内联
  // height/opacity 0 与 is-closing 类会留在 DOM 上——数据面已经展开、行也在，
  // 视觉上却塌成零高并停在那里。只在确实带着 is-closing（退场被打断）时清理，
  // 避免误伤正在播放的入场动画。挂载帧不走这条（无 is-closing）。
  useLayoutEffect(() => {
    if (project.closing) return
    closingStarted.current = false
    const list = ref.current
    if (!list || !list.classList.contains('is-closing')) return
    list.classList.remove('is-animating', 'is-closing')
    clearThreadListMotionStyles(list)
    if (project.justOpened) animateThreadListOpen(list)
  }, [project.closing, project.justOpened])

  const threads = project.threads
  if (!threads) return null
  return (
    <div className={styles['project-thread-list']} data-project-key={project.key} ref={ref}>
      {threads.rows.map(row => <ProjectThreadRow row={row} actions={actions} key={row.id} />)}
      {threads.more ? (
        <button
          type="button" className={styles['project-thread-more']}
          onClick={(e) => { e.stopPropagation(); actions.showMoreThreads(project.key) }}
        >{tt('project_threads_show_more')}</button>
      ) : null}
    </div>
  )
}

/** A project row has no chevron — group expansion is signalled by swapping the
 *  folder glyph. Identity wins over state: a remote host
 *  keeps its own icon and never swaps, so an SSH project (the remote analogue)
 *  and a multi-folder workspace (the stacked-folder identity) keep theirs too.
 *  Only an ordinary local folder flips open/closed. */
function projectFolderIconName(project: ProjectRowSpec, open: boolean): string {
  if (project.ssh) return 'project-sb-3'
  if (project.isWorkspace) return 'project-sb-workspace'
  if (project.isFriend) return 'sb-nav-friends'
  return open ? 'project-sb-open' : 'project-sb'
}

function ProjectRow({ project, actions }: { project: ProjectRowSpec; actions: SidebarActions }) {
  const open = project.expanded && !project.closing
  const drag = useProjectGroupDrag(project.key)
  const reorder = useProjectReorder()
  // The line is a SIBLING above the group, not a child of it: it marks the
  // boundary the group will be inserted at, and a boundary belongs to no group.
  const showsIndicator = reorder?.dropIndicator?.beforeKey === project.key
  return (
    <>
      {showsIndicator ? <ProjectDropIndicator /> : null}
      <div ref={drag.group.ref} style={drag.group.style} className={drag.group.className} {...(drag.group.inert ? { inert: true } : {})}>
      <div
        ref={drag.row.ref}
        aria-roledescription={drag.row['aria-roledescription']}
        aria-describedby={drag.row['aria-describedby']}
        onPointerDown={drag.row.onPointerDown}
        className={styles['project-sb-item'] + (project.active ? ' active' : '')}
        data-project-key={project.key}
        tabIndex={0}
        aria-expanded={open ? 'true' : 'false'}
        onClick={(e) => {
          const target = e.target as HTMLElement
          if (target.closest(`.${styles['project-sb-more']}`)) {
            e.stopPropagation()
            actions.projectMenu(project.key, target.closest(`.${styles['project-sb-more']}`) as HTMLElement, null)
            return
          }
          if (target.closest(`.${styles['project-sb-new']}`)) {
            e.stopPropagation()
            actions.projectNewChat(project.key)
            return
          }
          actions.toggleProject(project.key)
        }}
        onKeyDown={(e) => {
          // The reorder path gets the arrow keys first: it stops propagation on a
          // handled press, so the activate gesture below never sees it.
          drag.onReorderKeyDown(e)
          if (e.defaultPrevented) return
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          actions.toggleProject(project.key)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          actions.projectMenu(project.key, null, { x: e.clientX, y: e.clientY })
        }}
        dangerouslySetInnerHTML={{
          __html: `
    ${rawIconHtml(projectFolderIconName(project, open))}
    <span class="${styles['project-sb-title']}">${escapeHtml(project.name)}</span>
    ${open ? '' : `<span class="${styles['project-sb-badge']}">${collapsedBadgeHtml(project.collapsedBadge)}</span>`}
    ${project.isFriend && project.pendingCount ? `<span class="${styles['s-group-count']}" role="status" aria-label="${escapeHtml(sidebarLabel('sidebar_badge_attention', 'Needs attention'))}: ${project.pendingCount}">${project.pendingCount > 99 ? '99+' : project.pendingCount}</span>` : ''}
    ${project.isFriend ? '' : `
    <button class="${styles['project-sb-more']}" type="button" aria-label="${escapeHtml(tt('project_menu'))}">
      ${rawIconHtml('chat-project-more')}
    </button>
    <button class="${styles['project-sb-new']}" type="button" aria-label="${escapeHtml(tt('project_new_chat'))}">
      ${rawIconHtml('chat-project-new-chat')}
    </button>`}`,
        }}
      />
      {(project.expanded || project.closing) && project.threads ? (
        <ProjectThreadList project={project} actions={actions} key={`list-${project.key}`} />
      ) : null}
      </div>
    </>
  )
}

/** The end-of-list insertion slot. A drop below the last group has no group of
 *  its own to hang the line on, so it gets one of its own at the list's tail. */
function ProjectListEndIndicator() {
  const reorder = useProjectReorder()
  const target = reorder?.dropIndicator
  if (target == null || target.beforeKey !== null) return null
  return <ProjectDropIndicator />
}

export type Store = StoreApi<{ snapshot: SidebarSnapshot | null }>

function sidebarLabel(key: string, fallback: string) {
  const value = tt(key)
  return value && value !== key ? value : fallback
}

export function SidebarRoot({ store, actions }: { store: Store; actions: SidebarActions }) {
  const snapshot = useStore(store, state => state.snapshot)
  if (!snapshot) return null
  return (
    <div className={styles['unified-sidebar']}>
      <SessionSection
        label={sidebarLabel('pinned_chats', '置顶任务')}
        sectionKey="pinned"
        section={snapshot.pinned}
        actions={actions}
      />
      <SessionSection
        label={sidebarLabel('im_sessions', '渠道会话')}
        sectionKey="channels"
        section={snapshot.channels}
        actions={actions}
      />
      {snapshot.projects.rows.length > 0 ? (
        <section className={styles['sidebar-task-section']}>
          <SectionHeader
            label={sidebarLabel('projects', '项目')}
            sectionKey="projects"
            collapsed={snapshot.projects.collapsed}
            badge={snapshot.projects.collapsedBadge}
            actions={actions}
            trailing={(
              <button
                type="button"
                className={styles['sidebar-section-action']}
                aria-label={sidebarLabel('project_add', '添加项目')}
                onClick={(e) => { e.stopPropagation(); actions.addProjectFromSection() }}
                dangerouslySetInnerHTML={{ __html: rawIconHtml('chat-project-add') }}
              />
            )}
          />
          {snapshot.projects.collapsed ? null : (
            <ProjectReorderList
              keys={snapshot.projects.rows.map(project => project.key)}
              reorderable={snapshot.projects.rows.length > 1}
              pending={snapshot.projects.reorderPending === true}
              onCommit={actions.reorderProjects}
              overlayFor={key => {
                const project = snapshot.projects.rows.find(row => row.key === key)
                if (!project) return null
                return {
                  iconHtml: rawIconHtml(projectFolderIconName(project, project.expanded && !project.closing)),
                  label: project.name,
                }
              }}
            >
              {snapshot.projects.rows.map(project => <ProjectRow project={project} actions={actions} key={project.key} />)}
              <ProjectListEndIndicator />
            </ProjectReorderList>
          )}
        </section>
      ) : null}
      <SessionSection
        label={sidebarLabel('recent_chats', '最近任务')}
        sectionKey="recent"
        section={snapshot.recent}
        actions={actions}
        trailing={(
          <button
            type="button"
            className={styles['sidebar-section-action']}
            aria-haspopup="menu"
            aria-expanded={snapshot.sortMenuOpen ? 'true' : 'false'}
            aria-label={snapshot.sortMode === 'priority'
              ? sidebarLabel('sidebar_sort_priority_desc', 'Needs input and unread chats first')
              : sidebarLabel('sidebar_sort_updated_desc', 'Sort chats by last updated time')}
            onClick={(e) => { e.stopPropagation(); actions.openSortMenu(e.currentTarget) }}
            dangerouslySetInnerHTML={{ __html: rawIconHtml('sidebar-sort') }}
          />
        )}
      />
    </div>
  )
}

export function mountSidebar({ rootEl, actions }: {
  rootEl: HTMLElement | null
  actions: SidebarActions
}): SidebarApi | null {
  if (!rootEl) return null
  const store = createStore<{ snapshot: SidebarSnapshot | null }>(() => ({ snapshot: null })) as Store
  createRoot(rootEl).render(<SidebarRoot store={store} actions={actions} />)
  return {
    render(snapshot) {
      store.setState({ snapshot })
    },
  }
}
