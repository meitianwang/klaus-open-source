// The subagent row title in the Overview panel, rendered through the same
// MarqueeText the sidebar session rows use, so an over-long name scrolls on
// row hover instead of dying at an ellipsis.
//
// The Overview sections are plain DOM (see subagents.ts), so each row title
// gets its own tiny React root mounted into a placeholder span the row builds.
// session-list.tsx does the same for the sidebar; the difference is only who
// owns the surrounding markup.
//
// The row carries the `kls-marquee-group` hover marker the marquee stylesheet
// triggers on, and the title keeps `animateOnGroupHover`, exactly as the
// sidebar rows do.

import { createRoot, type Root } from 'react-dom/client'
import { MarqueeText } from '../sidebar/marquee-text'
import { styles } from './shared'

export const SUBAGENT_ROW_MARQUEE_GROUP_CLASS = 'kls-marquee-group'

export function subagentRowTitleHtml(): string {
  return `<span class="${styles['subagent-row-title']}"></span>`
}

/** Mount the marquee title into the row's placeholder. Returns the disposer
 *  the section must call when the row leaves the DOM, so replaced rows do not
 *  keep a live React root (and its ResizeObserver) behind them. */
export function mountSubagentRowTitle(host: HTMLElement, name: string): () => void {
  const root: Root = createRoot(host)
  root.render(<SubagentRowTitle name={name} />)
  return () => root.unmount()
}

function SubagentRowTitle({ name }: { name: string }) {
  return (
    <MarqueeText className={styles['subagent-row-name']} animateOnGroupHover>
      <span dir="auto">{name}</span>
    </MarqueeText>
  )
}
