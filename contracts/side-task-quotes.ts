export interface SideTaskQuotePanel {
  placement: 'right' | 'bottom';
  activeId: string | null;
  tabs: readonly string[];
}

/** Panel priority precedes active-tab priority; remaining tabs keep their strip order. */
export function selectSideTaskQuoteTarget(
  panels: readonly SideTaskQuotePanel[],
  available: (id: string) => boolean,
): string | null {
  for (const placement of ['right', 'bottom'] as const) {
    const panel = panels.find(candidate => candidate.placement === placement);
    if (!panel) continue;
    if (panel.activeId && panel.tabs.includes(panel.activeId) && available(panel.activeId)) return panel.activeId;
    for (const id of panel.tabs) {
      if (id !== panel.activeId && available(id)) return id;
    }
  }
  return null;
}
