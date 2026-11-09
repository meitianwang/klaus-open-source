import { describe, expect, test } from 'bun:test'
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_COLLAPSE_THRESHOLD,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_COLLAPSE_THRESHOLD,
  PANEL_MIN_MAIN_WIDTH,
  clampSidebarWidth,
  computeWorkspaceWidth,
  rightPanelBounds,
  clampRightPanelWidth,
  rightPanelWidthToRatio,
  rightPanelRatioToWidth,
  resolveStoredRightPanelRatio,
  defaultSplitRightPanelWidth,
  evaluateSidebarDragStep,
  evaluateRightPanelDragStep,
  evaluateKeyboardResizeStep,
  createResponsiveAutoCollapseState,
  evaluateWindowResizeAutoCollapse,
} from './panel-layout'

describe('panel and sidebar coordinated layout state machine', () => {
  test('left sidebar clamps to [240, min(520, shellWidth - 240)] and collapses below 120px on drag', () => {
    expect(clampSidebarWidth(180, 1440)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(300, 1440)).toBe(300)
    expect(clampSidebarWidth(600, 1440)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(500, 680)).toBe(440)
    expect(clampSidebarWidth(NaN, 1440)).toBe(SIDEBAR_DEFAULT_WIDTH)

    // Dragging below 0.5 * 240 = 120px collapses; dragging back >= 120px re-expands
    expect(evaluateSidebarDragStep(SIDEBAR_COLLAPSE_THRESHOLD - 1, 1440)).toEqual({
      open: false,
      width: 0,
    })
    expect(evaluateSidebarDragStep(SIDEBAR_COLLAPSE_THRESHOLD, 1440)).toEqual({
      open: true,
      width: SIDEBAR_MIN_WIDTH,
    })
    expect(evaluateSidebarDragStep(380, 1440)).toEqual({
      open: true,
      width: 380,
    })
  })

  test('right panel ratio preserves proportional split across sidebar expand/collapse and sidebar drag', () => {
    const shellWidth = 1440
    // 1. Sidebar collapsed, right panel dragged to 660px
    const wsCollapsed = computeWorkspaceWidth(shellWidth, false, 300)
    expect(wsCollapsed).toBe(1440)
    const ratio = rightPanelWidthToRatio(660, wsCollapsed)
    expect(rightPanelRatioToWidth(ratio, wsCollapsed)).toBe(660)

    // 2. Sidebar expanded (300px): workspace shrinks to 1140px, right panel scales down proportionally
    // while keeping main chat >= 420px
    const wsExpanded = computeWorkspaceWidth(shellWidth, true, 300)
    expect(wsExpanded).toBe(1140)
    const widthWithSidebar = rightPanelRatioToWidth(ratio, wsExpanded)
    expect(widthWithSidebar).toBeLessThan(660)
    expect(wsExpanded - widthWithSidebar).toBeGreaterThanOrEqual(PANEL_MIN_MAIN_WIDTH)

    // 3. Dragging left sidebar wider to 440px shrinks workspace to 1000px and scales right panel live
    const wsWideSidebar = computeWorkspaceWidth(shellWidth, true, 440)
    expect(wsWideSidebar).toBe(1000)
    const widthWithWideSidebar = rightPanelRatioToWidth(ratio, wsWideSidebar)
    expect(wsWideSidebar - widthWithWideSidebar).toBeGreaterThanOrEqual(PANEL_MIN_MAIN_WIDTH)

    // 4. Collapsing left sidebar again restores the exact original 660px right panel width
    expect(rightPanelRatioToWidth(ratio, wsCollapsed)).toBe(660)
  })

  test('right panel drag handles collapse threshold (< 130px), full-width maximize (< 160px main), and 50/50 double-click reset', () => {
    const wsWidth = 1140

    // Below 130px collapses the right panel
    expect(evaluateRightPanelDragStep(RIGHT_PANEL_COLLAPSE_THRESHOLD - 1, wsWidth)).toEqual({
      open: false,
      fullWidth: false,
      width: RIGHT_PANEL_MIN_WIDTH,
      ratio: 0,
    })

    // Normal split drag within bounds
    const normal = evaluateRightPanelDragStep(520, wsWidth)
    expect(normal.open).toBe(true)
    expect(normal.fullWidth).toBe(false)
    expect(normal.width).toBe(520)

    // Dragging past max so remaining main chat < 160px triggers full-width mode
    const full = evaluateRightPanelDragStep(wsWidth - 120, wsWidth)
    expect(full.open).toBe(true)
    expect(full.fullWidth).toBe(true)
    expect(full.width).toBe(wsWidth - PANEL_MIN_MAIN_WIDTH)

    // Double-click resets to 50/50 split clamped by bounds
    expect(defaultSplitRightPanelWidth(1140)).toBe(570)
  })

  test('stored right panel width supports both normalized ratio and legacy pixel values', () => {
    const wsWidth = 1200
    expect(resolveStoredRightPanelRatio('0.5', null, wsWidth)).toBe(0.5)
    const legacyRatio = resolveStoredRightPanelRatio(null, '500', wsWidth)
    expect(rightPanelRatioToWidth(legacyRatio, wsWidth)).toBe(500)
    const fallbackRatio = resolveStoredRightPanelRatio(null, null, wsWidth, RIGHT_PANEL_DEFAULT_WIDTH)
    expect(rightPanelRatioToWidth(fallbackRatio, wsWidth)).toBe(RIGHT_PANEL_DEFAULT_WIDTH)
  })

  test('keyboard resize steps respect edge direction, Shift multiplier, Home, and End', () => {
    expect(evaluateKeyboardResizeStep({
      currentSize: 300,
      key: 'ArrowRight',
      edge: 'right',
      minimumSize: 240,
      maximumSize: 520,
    })).toBe(316)
    expect(evaluateKeyboardResizeStep({
      currentSize: 300,
      key: 'ArrowLeft',
      shiftKey: true,
      edge: 'right',
      minimumSize: 240,
      maximumSize: 520,
    })).toBe(268)
    expect(evaluateKeyboardResizeStep({
      currentSize: 460,
      key: 'ArrowLeft',
      edge: 'left',
      minimumSize: 260,
      maximumSize: 720,
    })).toBe(476)
    expect(evaluateKeyboardResizeStep({
      currentSize: 460,
      key: 'Home',
      edge: 'left',
      minimumSize: 260,
      maximumSize: 720,
    })).toBe(260)
    expect(evaluateKeyboardResizeStep({
      currentSize: 460,
      key: 'End',
      edge: 'left',
      minimumSize: 260,
      maximumSize: 720,
    })).toBe(720)
  })

  test('window resize auto-collapses and auto-restores right panel at <= 960px and left sidebar at <= 720px', () => {
    let state = createResponsiveAutoCollapseState()

    // Initial seed at 1360px shell width with both sidebar (300) and right panel open
    state = evaluateWindowResizeAutoCollapse(state, {
      shellWidth: 1360,
      workspaceWidth: 1060,
      sidebarOpen: true,
      panelOpen: true,
      panelMaximized: false,
    }).state

    // Shrink window so workspaceWidth crosses <= 960px while both are open: right panel auto-collapses
    const step1 = evaluateWindowResizeAutoCollapse(state, {
      shellWidth: 1200,
      workspaceWidth: 900,
      sidebarOpen: true,
      panelOpen: true,
      panelMaximized: false,
    })
    state = step1.state
    expect(step1.collapsePanel).toBe(true)
    expect(step1.collapseSidebar).toBe(false)

    // Shrink window further to <= 720px: left sidebar auto-collapses
    const step2 = evaluateWindowResizeAutoCollapse(state, {
      shellWidth: 700,
      workspaceWidth: 700,
      sidebarOpen: true,
      panelOpen: false,
      panelMaximized: false,
    })
    state = step2.state
    expect(step2.collapseSidebar).toBe(true)

    // Widen window to 860px (> 720px, but workspaceWidth with sidebar is 560 <= 960): sidebar restores, panel stays closed
    const step3 = evaluateWindowResizeAutoCollapse(state, {
      shellWidth: 860,
      workspaceWidth: 560,
      sidebarOpen: false,
      panelOpen: false,
      panelMaximized: false,
    })
    state = step3.state
    expect(step3.restoreSidebar).toBe(true)
    expect(step3.restorePanel).toBe(false)

    // Widen window back to 1360px (workspaceWidth 1060 > 960): right panel auto-restores!
    const step4 = evaluateWindowResizeAutoCollapse(state, {
      shellWidth: 1360,
      workspaceWidth: 1060,
      sidebarOpen: true,
      panelOpen: false,
      panelMaximized: false,
    })
    expect(step4.restorePanel).toBe(true)
  })
})
