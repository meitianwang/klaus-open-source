// Hover tip for ellipsized labels: the global tooltip (app/tooltip.ts) picks
// up data-klaus-tip from any hovered element, so a label clipped by CSS
// ellipsis publishes its full text there while a label that fits publishes
// nothing and stays tooltip-free. The overflow probe mirrors the check the
// transcript activity rows use for their own clipped prompts.
export function syncTruncatedTip(host: HTMLElement, measured: HTMLElement, text: string): void {
  if (text && measured.scrollWidth > measured.clientWidth) host.dataset.klausTip = text
  else delete host.dataset.klausTip
}
