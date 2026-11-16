import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../../css/styles.css', import.meta.url), 'utf8')

// The Scheduled Tasks overlay root is hidden by `#cron-view { display: none }`
// and shown by `#cron-view.active`. The split modifier (a task detail open) is
// toggled by the page island and OUTLIVES hide(): navigating away removes only
// `.active` while the mounted island keeps its selection, so any root-level
// display rule that does not require `.active` keeps the hidden overlay on
// screen and every sidebar navigation appears to do nothing.
const rootDisplaySelectors = (): string[] => {
  const offenders: string[] = []
  const rule = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = rule.exec(css))) {
    const display = match[2].match(/\bdisplay\s*:\s*([^;}]+)/)
    if (!display) continue
    // The base `display: none` hiding rule is the one root-level display rule
    // allowed without `.active`; every visible value must require it.
    if (display[1].trim() === 'none') continue
    for (const entry of match[1].split(',').map(part => part.trim())) {
      if (!entry) continue
      // Only selectors whose final compound targets the root element itself;
      // descendant targets (#cron-view-content, …) cannot un-hide the root.
      const last = entry.split(/\s+/).pop() || ''
      if (last !== '#cron-view' && !/^#cron-view[.:]/.test(last)) continue
      if (!entry.includes('.active')) offenders.push(entry)
    }
  }
  return offenders
}

describe('scheduled tasks overlay visibility', () => {
  test('every root-level display rule for the overlay stays gated on .active', () => {
    expect(rootDisplaySelectors()).toEqual([])
  })

  test('the split layout rule requires the active overlay', () => {
    expect(css).toContain('#cron-view.active.cron-view-split {')
    expect(css).not.toContain('\n#cron-view.cron-view-split {')
  })

  test('hidden and shown states keep their base rules', () => {
    expect(css).toContain('#cron-view.active { display: block; }')
    expect(css).toMatch(/#cron-view \{[^}]*display: none;/)
  })
})
