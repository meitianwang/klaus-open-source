// Coordinated layout state machine for the left sidebar, main chat pane, and
// right work panel across collapse/expand transitions, pointer/keyboard drag
// resizing, ratio-preserving workspace updates, and responsive window bounds.

export const SIDEBAR_MIN_WIDTH = 240
export const SIDEBAR_MAX_WIDTH = 520
export const SIDEBAR_DEFAULT_WIDTH = 300
export const SIDEBAR_COLLAPSE_THRESHOLD = 0.5 * SIDEBAR_MIN_WIDTH

export const RIGHT_PANEL_MIN_WIDTH = 260
export const RIGHT_PANEL_MAX_WIDTH = 1400
export const RIGHT_PANEL_DEFAULT_WIDTH = 460
export const RIGHT_PANEL_COLLAPSE_THRESHOLD = 0.5 * RIGHT_PANEL_MIN_WIDTH

export const PANEL_MIN_MAIN_WIDTH = 420
export const MAIN_PANE_FULL_WIDTH_THRESHOLD = 160

export const BOTH_PANELS_AUTO_COLLAPSE_WIDTH = 960
export const NARROW_WINDOW_AUTO_COLLAPSE_WIDTH = 720
export const RESIZER_KEYBOARD_STEP = 16

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function clampSidebarWidth(
  width: number,
  shellWidth = Number.POSITIVE_INFINITY,
  minWidth = SIDEBAR_MIN_WIDTH,
): number {
  if (!Number.isFinite(width) || width <= 0) {
    return Math.max(SIDEBAR_DEFAULT_WIDTH, minWidth)
  }
  const maxByShell = Number.isFinite(shellWidth) && shellWidth > 0
    ? Math.max(minWidth, shellWidth - SIDEBAR_MIN_WIDTH)
    : SIDEBAR_MAX_WIDTH
  return Math.round(Math.max(minWidth, Math.min(width, SIDEBAR_MAX_WIDTH, maxByShell)))
}

export function computeWorkspaceWidth(
  shellWidth: number,
  sidebarOpen: boolean,
  sidebarWidth: number,
): number {
  if (!Number.isFinite(shellWidth) || shellWidth <= 0) return 0
  const left = sidebarOpen ? clampSidebarWidth(sidebarWidth, shellWidth) : 0
  return Math.max(0, shellWidth - left)
}

export function rightPanelBounds(
  workspaceWidth: number,
  minPanel = RIGHT_PANEL_MIN_WIDTH,
  maxPanel = RIGHT_PANEL_MAX_WIDTH,
  minMain = PANEL_MIN_MAIN_WIDTH,
): { minimum: number; maximum: number } {
  const available = Number.isFinite(workspaceWidth) && workspaceWidth > 0
    ? workspaceWidth - minMain
    : maxPanel
  const maximum = Math.max(minPanel, Math.min(maxPanel, available))
  return {
    minimum: Math.min(minPanel, maximum),
    maximum,
  }
}

export function clampRightPanelWidth(
  width: number,
  workspaceWidth: number,
  minPanel = RIGHT_PANEL_MIN_WIDTH,
  maxPanel = RIGHT_PANEL_MAX_WIDTH,
  minMain = PANEL_MIN_MAIN_WIDTH,
): number {
  const { minimum, maximum } = rightPanelBounds(workspaceWidth, minPanel, maxPanel, minMain)
  const resolved = Number.isFinite(width) && width > 0 ? width : RIGHT_PANEL_DEFAULT_WIDTH
  return Math.round(Math.max(minimum, Math.min(resolved, maximum)))
}

export function rightPanelWidthToRatio(
  width: number,
  workspaceWidth: number,
  minPanel = RIGHT_PANEL_MIN_WIDTH,
  maxPanel = RIGHT_PANEL_MAX_WIDTH,
  minMain = PANEL_MIN_MAIN_WIDTH,
): number {
  const { minimum, maximum } = rightPanelBounds(workspaceWidth, minPanel, maxPanel, minMain)
  const span = maximum - minimum
  if (span <= 0) return 0
  const clamped = clampRightPanelWidth(width, workspaceWidth, minPanel, maxPanel, minMain)
  return clamp01((clamped - minimum) / span)
}

export function rightPanelRatioToWidth(
  ratio: number,
  workspaceWidth: number,
  minPanel = RIGHT_PANEL_MIN_WIDTH,
  maxPanel = RIGHT_PANEL_MAX_WIDTH,
  minMain = PANEL_MIN_MAIN_WIDTH,
): number {
  const { minimum, maximum } = rightPanelBounds(workspaceWidth, minPanel, maxPanel, minMain)
  return clampRightPanelWidth(
    minimum + clamp01(ratio) * (maximum - minimum),
    workspaceWidth,
    minPanel,
    maxPanel,
    minMain,
  )
}

export function resolveStoredRightPanelRatio(
  storedRatioRaw: string | null | undefined,
  storedWidthRaw: string | null | undefined,
  workspaceWidth: number,
  defaultWidth = RIGHT_PANEL_DEFAULT_WIDTH,
): number {
  if (storedRatioRaw != null && storedRatioRaw !== '') {
    const parsedRatio = Number(storedRatioRaw)
    if (Number.isFinite(parsedRatio)) return clamp01(parsedRatio)
  }
  if (storedWidthRaw != null && storedWidthRaw !== '') {
    const parsedWidth = Number(storedWidthRaw)
    if (Number.isFinite(parsedWidth) && parsedWidth > 0) {
      return parsedWidth <= 1
        ? clamp01(parsedWidth)
        : rightPanelWidthToRatio(parsedWidth, workspaceWidth)
    }
  }
  return rightPanelWidthToRatio(defaultWidth, workspaceWidth)
}

export function defaultSplitRightPanelWidth(workspaceWidth: number): number {
  return clampRightPanelWidth(workspaceWidth / 2, workspaceWidth)
}

export interface SidebarDragEvaluation {
  open: boolean
  width: number
}

export function evaluateSidebarDragStep(
  rawWidth: number,
  shellWidth: number,
  collapsible = true,
): SidebarDragEvaluation {
  const open = !collapsible || rawWidth >= SIDEBAR_COLLAPSE_THRESHOLD
  return {
    open,
    width: open ? clampSidebarWidth(rawWidth, shellWidth) : 0,
  }
}

export interface RightPanelDragEvaluation {
  open: boolean
  fullWidth: boolean
  width: number
  ratio: number
}

export function evaluateRightPanelDragStep(
  rawWidth: number,
  workspaceWidth: number,
  allowFullWidth = true,
): RightPanelDragEvaluation {
  const open = rawWidth >= RIGHT_PANEL_COLLAPSE_THRESHOLD
  if (!open) {
    return { open: false, fullWidth: false, width: RIGHT_PANEL_MIN_WIDTH, ratio: 0 }
  }
  const maxAllowed = rightPanelRatioToWidth(1, workspaceWidth)
  const fullWidth = allowFullWidth
    && workspaceWidth > 0
    && rawWidth > maxAllowed
    && workspaceWidth - rawWidth < MAIN_PANE_FULL_WIDTH_THRESHOLD
  const width = clampRightPanelWidth(rawWidth, workspaceWidth)
  const ratio = rightPanelWidthToRatio(width, workspaceWidth)
  return { open: true, fullWidth, width, ratio }
}

export function evaluateKeyboardResizeStep(options: {
  currentSize: number
  key: string
  shiftKey?: boolean
  edge: 'left' | 'right'
  minimumSize: number
  maximumSize: number
  step?: number
}): number | null {
  const { currentSize, key, shiftKey, edge, minimumSize, maximumSize, step = RESIZER_KEYBOARD_STEP } = options
  if (key === 'Home') return minimumSize
  if (key === 'End') return maximumSize
  const deltaMagnitude = shiftKey ? step * 2 : step
  let delta: number | null = null
  if (key === 'ArrowLeft') {
    delta = edge === 'left' ? deltaMagnitude : -deltaMagnitude
  } else if (key === 'ArrowRight') {
    delta = edge === 'right' ? deltaMagnitude : -deltaMagnitude
  }
  if (delta === null) return null
  return Math.round(Math.max(minimumSize, Math.min(maximumSize, currentSize + delta)))
}

export interface ResponsiveAutoCollapseState {
  prevBothNarrow: boolean | null
  prevPanelNarrow: boolean | null
  prevSidebarNarrow: boolean | null
  autoClosedPanel: boolean
  autoCollapsedSidebar: boolean
  sidebarAutoCollapsible: boolean
}

export function createResponsiveAutoCollapseState(): ResponsiveAutoCollapseState {
  return {
    prevBothNarrow: null,
    prevPanelNarrow: null,
    prevSidebarNarrow: null,
    autoClosedPanel: false,
    autoCollapsedSidebar: false,
    sidebarAutoCollapsible: true,
  }
}

export interface ResponsiveAutoCollapseInput {
  shellWidth: number
  workspaceWidth: number
  sidebarOpen: boolean
  panelOpen: boolean
  panelMaximized: boolean
}

export interface ResponsiveAutoCollapseResult {
  state: ResponsiveAutoCollapseState
  collapsePanel: boolean
  restorePanel: boolean
  collapseSidebar: boolean
  restoreSidebar: boolean
}

export function evaluateWindowResizeAutoCollapse(
  state: ResponsiveAutoCollapseState,
  input: ResponsiveAutoCollapseInput,
): ResponsiveAutoCollapseResult {
  const { shellWidth, workspaceWidth, sidebarOpen, panelOpen, panelMaximized } = input
  if (!(shellWidth > 0) || !(workspaceWidth > 0)) {
    return {
      state,
      collapsePanel: false,
      restorePanel: false,
      collapseSidebar: false,
      restoreSidebar: false,
    }
  }
  const bothNarrow = workspaceWidth <= BOTH_PANELS_AUTO_COLLAPSE_WIDTH
  const panelNarrow = workspaceWidth <= NARROW_WINDOW_AUTO_COLLAPSE_WIDTH
  const sidebarNarrow = shellWidth <= NARROW_WINDOW_AUTO_COLLAPSE_WIDTH

  const bothChanged = state.prevBothNarrow !== null && bothNarrow !== state.prevBothNarrow
  const panelChanged = state.prevPanelNarrow !== null && panelNarrow !== state.prevPanelNarrow
  const sidebarChanged = state.prevSidebarNarrow !== null && sidebarNarrow !== state.prevSidebarNarrow

  const nextState: ResponsiveAutoCollapseState = {
    ...state,
    prevBothNarrow: bothNarrow,
    prevPanelNarrow: panelNarrow,
    prevSidebarNarrow: sidebarNarrow,
  }

  if (!bothChanged && !panelChanged && !sidebarChanged) {
    return {
      state: nextState,
      collapsePanel: false,
      restorePanel: false,
      collapseSidebar: false,
      restoreSidebar: false,
    }
  }

  let collapseSidebar = false
  let restoreSidebar = false
  if (sidebarChanged && state.sidebarAutoCollapsible) {
    if (sidebarNarrow && sidebarOpen) {
      collapseSidebar = true
      nextState.autoCollapsedSidebar = true
    } else if (!sidebarNarrow && !sidebarOpen && state.autoCollapsedSidebar) {
      restoreSidebar = true
      nextState.autoCollapsedSidebar = false
    }
  }

  const effectiveSidebarOpen = collapseSidebar ? false : restoreSidebar ? true : sidebarOpen
  let collapsePanel = false
  let restorePanel = false

  if (!panelMaximized) {
    const shouldCollapsePanel = panelOpen && (
      (bothChanged && effectiveSidebarOpen && bothNarrow)
      || (panelChanged && panelNarrow)
    )
    if (shouldCollapsePanel) {
      collapsePanel = true
      nextState.autoClosedPanel = true
    } else if (!panelNarrow && !(effectiveSidebarOpen && bothNarrow) && state.autoClosedPanel && !panelOpen) {
      restorePanel = true
      nextState.autoClosedPanel = false
    }
  }

  return {
    state: nextState,
    collapsePanel,
    restorePanel,
    collapseSidebar,
    restoreSidebar,
  }
}
