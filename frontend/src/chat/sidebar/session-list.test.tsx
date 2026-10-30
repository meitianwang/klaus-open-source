// Behaviour-level tests for the sidebar collapse surface: real React render
// (renderToStaticMarkup) against the real components, asserting the DOM that
// ships — section toggle buttons, chevrons, aggregate badges, the folder-glyph
// swap, show-more pagination, and the absence of thread timestamps inside
// project groups. The pure decision rules live in collapse-vectors.test.ts;
// this file pins what the user actually sees.
//
// Note: bun imports CSS modules as raw text, not as a class-name map, so these
// assertions deliberately target structure, ARIA semantics and glyph paths
// rather than hashed class names — which are the sturdier contract anyway.
import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore } from 'zustand/vanilla'
import { SidebarRoot, type ProjectRowSpec, type SessionRowSpec, type SidebarActions, type SidebarSnapshot, type Store } from './session-list'
import { bezierStops, marqueeVars, roundToDevicePx, MARQUEE_BEZIER_SAMPLES, MARQUEE_LEAD_IN_SECONDS } from './marquee-text'
import { friendGroupThreadTitle } from './friend-title'
import friendVectors from '../../../../contracts/vectors/friends-messaging-vectors.json'

// session-list.tsx reads window.tt lazily per call, so a stub installed before
// any render is enough.
const globalAny = globalThis as unknown as { window?: unknown }
const previousWindow = globalAny.window
const LABELS: Record<string, string> = {
  pinned_chats: 'Pinned',
  im_sessions: 'Channels',
  projects: 'Projects',
  recent_chats: 'Recent',
  project_threads_show_more: 'Show more',
  sidebar_badge_working: 'Working',
  sidebar_badge_attention: 'Needs attention',
  project_menu: 'Project menu',
  project_new_chat: 'New chat in project',
  project_add: 'Add project',
  session_menu_more: 'Session menu',
  agent_status_running: 'Running',
  agent_status_completed: 'Completed',
}
globalAny.window = { tt: (key: string) => LABELS[key] || key }
afterAll(() => { globalAny.window = previousWindow })

function row(id: string, extra: Partial<SessionRowSpec> = {}): SessionRowSpec {
  return {
    id, active: false, working: false, completeUnread: false, leadState: 'read',
    title: id, channelLabel: null, worktreeTitle: null, automationLabel: null,
    pinned: false, draft: false, branchIconHtml: '',
    waitingKind: null, waitingCount: 0, snoozeDeadlineMs: null, snoozeRequestId: null,
    unreadCount: 0,
    ...extra,
  }
}

function project(key: string, extra: Partial<ProjectRowSpec> = {}): ProjectRowSpec {
  return {
    key, name: key, workdir: `/repo/${key}`, ssh: false, active: false,
    expanded: true, justOpened: false, closing: false, collapsedBadge: null,
    threads: null, ...extra,
  }
}

/** Whether the section paints its AGGREGATE status badge (the folded-group
 *  spinner/dot). The badge is the only place `aria-label="Needs attention"` or
 *  `"Working"` appears, so this is a precise proxy.
 *
 *  It deliberately is NOT `role="status"`: the Projects section now carries two
 *  live regions (the drag context's own announcement output and the keyboard
 *  reorder one), both of which render `role="status"` unconditionally. Using that
 *  attribute as the badge proxy would fail on every render regardless of the
 *  badge, so these assertions target the badge's accessible name instead. */
function hasAggregateBadge(html: string): boolean {
  return html.includes('aria-label="Needs attention"') || html.includes('aria-label="Working"')
}

function snapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
  const section = (rows: SessionRowSpec[]) => ({ rows, collapsed: false, collapsedBadge: null })
  return {
    pinned: section([]), channels: section([]),
    projects: { rows: [], collapsed: false, collapsedBadge: null },
    recent: section([row('recent-1')]),
    sortMode: 'updated_at',
    sortMenuOpen: false,
    ...overrides,
  }
}

const actions: SidebarActions = {
  switchSession: () => {}, showContextMenu: () => {}, toggleProject: () => {},
  projectMenu: () => {}, projectNewChat: () => {}, showMoreThreads: () => {},
  toggleSection: () => {}, addProjectFromSection: () => {}, projectCloseFinished: () => {},
  snoozeInput: () => {}, openSortMenu: () => {}, reorderProjects: () => {},
}

function render(snap: SidebarSnapshot): string {
  const store = createStore<{ snapshot: SidebarSnapshot | null }>(() => ({ snapshot: snap })) as Store
  return renderToStaticMarkup(<SidebarRoot store={store} actions={actions} />)
}

/** Every section-head toggle button, by its distinguishing attributes. */
function sectionToggles(html: string): string[] {
  // The head toggle is the button whose first child is the label span and
  // whose second is the decorative chevron; head actions (add project, sort)
  // carry a bare svg instead and must not count as toggles.
  return [...html.matchAll(/<button type="button"[^>]*aria-expanded="(?:true|false)"[^>]*><span[^>]*>[^<]*<\/span><span aria-hidden="true"/g)].map(match => match[0])
}

/** The accessible label of each section head. The chevron follows the label
 *  text, so the label is the first span inside the toggle. */
function sectionLabels(html: string): string[] {
  return [...html.matchAll(/aria-expanded="(?:true|false)"><span[^>]*>([^<]*)<\/span><span aria-hidden="true"[^>]*><svg[^]*?<\/svg><\/span>/g)].map(m => m[1])
}

describe('sidebar section heads', () => {
  const html = () => render(snapshot({
    pinned: { rows: [row('p1', { pinned: true })], collapsed: false, collapsedBadge: null },
    projects: { rows: [project('app')], collapsed: false, collapsedBadge: null },
    recent: { rows: [row('r1')], collapsed: true, collapsedBadge: null },
  }))

  test('every rendered section head is a real button with aria-expanded and a decorative chevron', () => {
    const toggles = sectionToggles(html())
    expect(toggles.map(tag => tag.includes('aria-expanded="true"') ? 'true' : 'false')).toEqual(['true', 'true', 'false'])
    expect(sectionLabels(html())).toEqual(['Pinned', 'Projects', 'Recent'])
    // The chevron is aria-hidden and the accessible name is the label.
    for (const toggle of toggles) expect(toggle).toContain('type="button"')
    const chevrons = html().match(/<span aria-hidden="true"[^>]*><svg/g) || []
    expect(chevrons.length).toBe(3)
  })

  test('the chevron follows the label text, never precedes it', () => {
    // A chevron before the label — or one reserving width while hidden — makes
    // every head read as indented relative to the nav rows above it. Asserted
    // structurally (class names are not rendered under bun), so it holds
    // regardless of CSS-module hashing: the toggle's first child span must be
    // the label, i.e. must NOT carry aria-hidden.
    const htmlText = html()
    const labelFirst = [...htmlText.matchAll(/aria-expanded="(?:true|false)"><span(?![^>]*aria-hidden)/g)]
    expect(labelFirst.length).toBe(3)
    const chevronFirst = [...htmlText.matchAll(/aria-expanded="(?:true|false)"><span[^>]*aria-hidden/g)]
    expect(chevronFirst.length).toBe(0)
  })

  test('a collapsed section hides its rows and shows the aggregate badge', () => {
    const folded = render(snapshot({ recent: { rows: [row('r1'), row('r2')], collapsed: true, collapsedBadge: 'loading' } }))
    expect(folded).not.toContain('r1')
    expect(folded).not.toContain('r2')
    expect(folded).toContain('role="status"')
    expect(folded).toContain('aria-label="Working"')
  })

  test('an expanded section shows its rows and never renders a badge', () => {
    const open = render(snapshot({ recent: { rows: [row('r1')], collapsed: false, collapsedBadge: null } }))
    expect(open).toContain('r1')
    expect(open).not.toContain('role="status"')
  })

  test('a collapsed section with nothing pending renders no badge', () => {
    const folded = render(snapshot({ recent: { rows: [row('r1')], collapsed: true, collapsedBadge: null } }))
    expect(folded).toContain('aria-expanded="false"')
    expect(folded).not.toContain('role="status"')
  })

  test('a waiting/unread badge renders a bare dot while a running badge renders a spinner', () => {
    const unread = render(snapshot({ recent: { rows: [row('r1')], collapsed: true, collapsedBadge: 'unread' } }))
    expect(unread).toContain('aria-label="Needs attention"')
    // The dot has no inner glyph; the spinner does (badge priority is pinned in
    // collapse-vectors.test.ts, here we pin the two distinct renderings).
    expect(unread.match(/role="status"[^>]*><\/span>/)).toBeTruthy()
    const loading = render(snapshot({ recent: { rows: [row('r1')], collapsed: true, collapsedBadge: 'loading' } }))
    expect(loading.match(/role="status"[^>]*><svg/)).toBeTruthy()
  })

  test('the Projects head carries a localized add-project button with no tooltip', () => {
    const withProjects = render(snapshot({ projects: { rows: [project('app')], collapsed: false, collapsedBadge: null } }))
    expect(withProjects).toContain('aria-label="Add project"')
    expect(withProjects).not.toMatch(/\stitle="/)
  })

  test('an empty section renders nothing at all', () => {
    expect(render(snapshot({ pinned: { rows: [], collapsed: false, collapsedBadge: null } }))).not.toContain('Pinned')
  })
})

describe('project rows', () => {
  for (const vector of friendVectors.friendGroupThreadTitle.cases) {
    test(`friend folder titles: ${vector.name}`, () => {
      const metadata = { friend: { friendshipId: 'friend-a', displayName: vector.senderName } }
      const title = friendGroupThreadTitle(vector.title, 'friend-a', metadata)
      const html = render(snapshot({
        pinned: { rows: [row('pinned-friend', { title: vector.title })], collapsed: false, collapsedBadge: null },
        projects: {
          rows: [project('friend:friend-a', {
            name: vector.groupName, isFriend: true,
            threads: { rows: [row('grouped-friend', { title })], more: false },
          })],
          collapsed: false, collapsedBadge: null,
        },
      }))
      expect(html).toContain(`<span dir="auto">${vector.expected}</span>`)
      expect(html).toContain(`<span dir="auto">${vector.title}</span>`)
      expect(metadata.friend.displayName).toBe(vector.senderName)
    })
  }

  test('a missing or unrelated sender record leaves the title intact', () => {
    const title = 'Nick · Review'
    for (const metadata of [undefined, {}, { friend: null }, { friend: { friendshipId: 'other', displayName: 'Nick' } }]) {
      expect(friendGroupThreadTitle(title, 'friend-a', metadata)).toBe(title)
    }
  })

  test('an open group renders its threads and reports aria-expanded=true', () => {
    const html = render(snapshot({
      projects: {
        rows: [project('app', { expanded: true, threads: { rows: [row('t1'), row('t2')], more: false } })],
        collapsed: false, collapsedBadge: null,
      },
    }))
    expect(html).toContain('data-project-key="app"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('t1')
    expect(html).toContain('t2')
    expect(hasAggregateBadge(html)).toBe(false)
  })

  test('a folded group keeps rows out of the DOM and surfaces its badge', () => {
    const html = render(snapshot({
      projects: { rows: [project('app', { expanded: false, collapsedBadge: 'unread', threads: null })], collapsed: false, collapsedBadge: null },
    }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('t1')
    expect(hasAggregateBadge(html)).toBe(true)
    expect(html).toContain('aria-label="Needs attention"')
  })

  test('a folded group with nothing pending renders no badge', () => {
    const html = render(snapshot({
      projects: { rows: [project('app', { expanded: false, collapsedBadge: null, threads: null })], collapsed: false, collapsedBadge: null },
    }))
    expect(hasAggregateBadge(html)).toBe(false)
  })

  test('while the exit animation plays, rows stay rendered and no badge overlaps them', () => {
    // The fold is committed at click time, so during the animation the group is
    // already `expanded: false` but `closing: true` — chat.ts keeps `threads`
    // populated so the rows can animate out, and deliberately reports
    // `collapsedBadge: null` so the badge cannot appear on top of rows that are
    // still fading. This is the shape buildSidebarSnapshot produces mid-close.
    const html = render(snapshot({
      projects: {
        rows: [project('app', {
          expanded: false,
          closing: true,
          collapsedBadge: null,
          threads: { rows: [row('fading-1'), row('fading-2')], more: false },
        })],
        collapsed: false, collapsedBadge: null,
      },
    }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('fading-1')
    expect(html).toContain('fading-2')
    expect(hasAggregateBadge(html)).toBe(false)
  })

  // The project row's own icon carries class="project-sb-icon" (library.ts
  // shell option); the section-head chevron does not, so scoping by that class
  // isolates the glyph under test.
  const projectGlyph = (spec: Partial<ProjectRowSpec>, expanded: boolean) => {
    const html = render(snapshot({ projects: { rows: [project('app', { ...spec, expanded })], collapsed: false, collapsedBadge: null } }))
    return (html.match(/<svg class="project-sb-icon"[\s\S]*?<path d="([^"]+)"/) || [])[1]
  }

  test('an ordinary project swaps its folder glyph with fold state', () => {
    const folded = projectGlyph({}, false)
    const open = projectGlyph({}, true)
    expect(folded).toBeTruthy()
    expect(open).toBeTruthy()
    // Closed folder vs open folder, no chevron.
    expect(folded).not.toBe(open)
  })

  test('an SSH project keeps its identity glyph in both states', () => {
    expect(projectGlyph({ ssh: true }, true)).toBe(projectGlyph({ ssh: true }, false))
  })

  test('a workspace container keeps its stacked-folder glyph in both states', () => {
    expect(projectGlyph({ isWorkspace: true }, true)).toBe(projectGlyph({ isWorkspace: true }, false))
  })

  test('a friend row keeps its identity glyph a direct row child, capped by the row-level svg rule', () => {
    const html = render(snapshot({
      projects: { rows: [project('friend:1', { isFriend: true, expanded: false })], collapsed: false, collapsedBadge: null },
    }))
    // The row's own glyph must stay a DIRECT child of the row div: identity
    // glyphs (the friend row's users-three) ship with no width/height and no
    // sizing class, so the row-level `.project-sb-item > svg` cap is the only
    // thing keeping a 1:1-viewBox svg from inflating the whole row.
    expect(html).toMatch(/<div class="[^"]*" data-project-key="friend:1"[^>]*>\s*<svg/)
    const source = readFileSync(new URL('./sidebar.module.css', import.meta.url), 'utf8')
    expect(source).toMatch(/\.project-sb-item > svg \{[^}]*width: 16px;[^}]*height: 16px;/)
  })
})

describe('show-more pagination inside a project group', () => {
  const groupWith = (more: boolean, rows: SessionRowSpec[]) => render(snapshot({
    projects: { rows: [project('app', { expanded: true, threads: { rows, more } })], collapsed: false, collapsedBadge: null },
  }))

  test('a truncated group renders exactly one Show more and no Show less', () => {
    const html = groupWith(true, [row('t1'), row('t2'), row('t3'), row('t4'), row('t5')])
    expect((html.match(/Show more/g) || []).length).toBe(1)
    // Reveal-only inside a group; folding resets the page instead.
    expect(html).not.toContain('Show less')
    expect(html).not.toContain('收起')
  })

  test('a fully revealed group renders no pagination button', () => {
    expect(groupWith(false, [row('t1')])).not.toContain('Show more')
  })

  test('a forced-visible active row still renders inside the truncated window', () => {
    const html = groupWith(true, [row('t1'), row('t2'), row('t3'), row('t4'), row('t5'), row('deep-active', { active: true })])
    expect(html).toContain('deep-active')
    expect(html).toContain('aria-current="page"')
  })
})

describe('timestamps inside project groups', () => {
  test('a thread row renders only its lead slot, title and menu button', () => {
    const html = render(snapshot({
      projects: {
        rows: [project('app', { expanded: true, threads: { rows: [row('t1')], more: false } })],
        collapsed: false, collapsedBadge: null,
      },
    }))
    const threadRow = html.match(/data-project-key="app"><div[^>]*tabindex="0">([\s\S]*?)<\/div><\/div>/)
    expect(threadRow).toBeTruthy()
    const inner = threadRow![1]
    // Inside a project group the row hides thread timestamps, so the row is
    // lead + title + menu with no time element between them. Asserted by what
    // is present and by the absence of any timestamp rather than by counting
    // spans: the title is now the marquee's four-layer structure, so its span
    // count is an implementation detail of that component, not of this row.
    expect(inner).toContain('t1')
    expect(inner).toContain('aria-label="Session menu"')
    expect(inner).toContain('aria-hidden="true"')
    expect(inner).not.toMatch(/\d{1,2}:\d{2}/)
    expect(inner).not.toContain('<time')
    // Exactly one button (the menu) and exactly one title; the lead slot is a
    // decorative span, so nothing else may claim the row.
    expect(inner.match(/<button/g)!.length).toBe(1)
    expect(inner.match(/data-marquee-text=/g)!.length).toBe(1)
  })
})

describe('MarqueeText motion math', () => {
  // These assertions pin the NUMBERS the marquee computes, because the whole
  // point of the component is that the motion reads consistently: a constant
  // em/second pace, a fixed lead-in, a bezier sampled into linear() stops, and
  // a single pass that holds at the end.

  test('duration is lead-in plus travel at a constant speed, with a tail only in loop mode', () => {
    // 294px at 13px font × 2em/s = 26px/s → 11.3077s travel + 0.35s lead-in.
    const stopAtEnd = marqueeVars(294, 26, 'stop-at-end') as Record<string, string>
    expect(stopAtEnd['--marquee-duration']).toBe('11.658s')
    expect(stopAtEnd['--marquee-scroll-distance']).toBe('294px')

    const loop = marqueeVars(294, 26, 'loop') as Record<string, string>
    expect(loop['--marquee-duration']).toBe('13.508s')
    expect(loop['--marquee-scroll-distance']).toBe('294px')
  })

  test('timing is a linear() curve sampled from cubic-bezier(.49,.6,.7,1)', () => {
    const vars = marqueeVars(260, 26, 'stop-at-end') as Record<string, string>
    const timing = vars['--marquee-scroll-timing']
    expect(timing.startsWith('linear(')).toBe(true)
    expect(timing.endsWith(')')).toBe(true)
    const stops = timing.slice('linear('.length, -1).split(', ')
    // The curve emits 1 opening stop + 33 bezier samples; loop mode appends a
    // closing stop so the seam is held.
    expect(stops.length).toBe(1 + MARQUEE_BEZIER_SAMPLES + 1)
    expect(stops[0]).toBe('0.0000 0.0000%')
    // The first bezier sample is the end of the lead-in: no travel yet, 0.35s in.
    const total = 0.35 + 260 / 26
    expect(stops[1]).toBe(`0.0000 ${((MARQUEE_LEAD_IN_SECONDS / total) * 100).toFixed(4)}%`)
    const loopStops = (marqueeVars(260, 26, 'loop') as Record<string, string>)['--marquee-scroll-timing']
      .slice('linear('.length, -1).split(', ')
    expect(loopStops.length).toBe(stops.length + 1)
    expect(loopStops[loopStops.length - 1]).toBe('1.0000 100.0000%')
  })

  test('bezier samples are monotonically increasing in both time and progress', () => {
    const total = 12
    const stops = bezierStops(MARQUEE_LEAD_IN_SECONDS, total - MARQUEE_LEAD_IN_SECONDS, total)
    expect(stops.length).toBe(MARQUEE_BEZIER_SAMPLES + 1)
    const parsed = stops.map(stop => {
      const [progress, percent] = stop.split(' ')
      return { progress: Number(progress), percent: Number(percent.slice(0, -1)) }
    })
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i].progress).toBeGreaterThanOrEqual(parsed[i - 1].progress)
      expect(parsed[i].percent).toBeGreaterThan(parsed[i - 1].percent)
    }
    // The curve ends exactly at full progress and full time.
    expect(parsed[parsed.length - 1].progress).toBe(1)
    expect(parsed[parsed.length - 1].percent).toBe(100)
  })

  test('travel distance is rounded to device pixels', () => {
    expect(roundToDevicePx(220.4, 1)).toBe(220)
    expect(roundToDevicePx(220.6, 1)).toBe(221)
    // 100.3 × 1.5 = 150.45 → rounds to 150 device px → 100 CSS px. Landing on
    // a whole device pixel is the point: the travel distance can then never be
    // a fraction of a rendered pixel off from what was measured.
    expect(roundToDevicePx(100.3, 1.5)).toBe(100)
    expect(roundToDevicePx(100.3, 2)).toBe(100.5)
    expect(roundToDevicePx(220.25, 2)).toBe(220.5)
  })
})

describe('sidebar rows delegate their title to the marquee', () => {
  const rowHtml = (extra: Partial<SessionRowSpec> = {}) => render(snapshot({
    recent: { rows: [row('a-title-that-is-quite-long', { active: true, ...extra })], collapsed: false, collapsedBadge: null },
  }))

  test('both row kinds render the title through MarqueeText, hover-triggered', () => {
    const flat = rowHtml()
    expect(flat).toContain('data-marquee-text=""')
    expect(flat).toContain('data-marquee-content=""')
    // Thread rows animate on group hover and never carry an always-on
    // `animate`, so no always-on class may ship: the trigger is the row hover
    // marker.
    expect(flat).not.toMatch(/animateOnGroupHover=|data-marquee-animatable=""/)

    const grouped = render(snapshot({
      projects: {
        rows: [project('app', { expanded: true, threads: { rows: [row('t1')], more: false } })],
        collapsed: false, collapsedBadge: null,
      },
    }))
    expect(grouped).toContain('data-marquee-text=""')
    expect(grouped).toContain('data-marquee-content=""')
  })

  test('the marquee has four layers, in order', () => {
    const html = rowHtml()
    const marquee = html.match(/<span[^>]*data-marquee-text=""[\s\S]*?<\/span><\/span><\/span><\/span><\/span>/)
    expect(marquee).toBeTruthy()
    const inner = marquee![0]
    // viewport → clipViewport → track → content, strictly nested: the text must
    // be reachable only inside all three wrappers, since clipViewport owns the
    // overflow clipping, track owns the transform and content owns the width
    // that gets measured.
    expect(inner.indexOf('data-marquee-content=""')).toBeGreaterThan(inner.indexOf('data-marquee-text=""'))
    // Five spans: the four marquee layers plus the `dir="auto"` wrapper
    // around the title text itself.
    expect(inner.match(/<span/g)!.length).toBe(5)
    expect(inner).toContain('dir="auto"')
  })

  test('selection no longer drives the marquee; the row hover marker does', () => {
    // The shipped bug was a selected-only trigger whose measurement died on the
    // first row rewrite. The trigger is row hover, which is why both a
    // selected and an unselected row carry the same marker.
    const selected = rowHtml({ active: true })
    const unselected = rowHtml({ active: false })
    expect(selected).toContain('kls-marquee-group')
    expect(unselected).toContain('kls-marquee-group')
    expect(selected).toContain('data-marquee-text=""')
    expect(unselected).toContain('data-marquee-text=""')
  })

  test('the parts around the title stay direct flex children via display:contents', () => {
    const html = rowHtml({ leadState: 'working', working: true, channelLabel: 'IM', draft: true })
    expect(html).toContain('role="status"')
    expect(html).toContain('s-channel-badge')
    expect(html).toContain('session-menu-action')
    // The wrappers must not become boxes of their own, or the row layout and
    // the ellipsis measurement both shift.
    const source = readFileSync(new URL('./sidebar.module.css', import.meta.url), 'utf8')
    expect(source).toMatch(/\.contents \{[^}]*display: contents;/)
  })
})

describe('tooltip policy on the collapse surface', () => {
  test('no title attribute or tooltip hook ships anywhere in the sidebar markup', () => {
    const html = render(snapshot({
      pinned: { rows: [row('p1', { pinned: true })], collapsed: false, collapsedBadge: null },
      channels: { rows: [row('c1', { channelLabel: 'IM' })], collapsed: false, collapsedBadge: null },
      projects: {
        rows: [project('app', { expanded: true, threads: { rows: [row('t1')], more: true } })],
        collapsed: false, collapsedBadge: null,
      },
      recent: { rows: [row('r1')], collapsed: true, collapsedBadge: 'loading' },
    }))
    expect(html).not.toMatch(/\stitle="/)
    expect(html).not.toContain('data-klaus-tip')
    expect(html).not.toContain('data-i18n-title')
  })
})

describe('friend group attention badge', () => {
  test('a friend group row paints its attention count folded and expanded', () => {
    const expanded = render(snapshot({ projects: { rows: [project('friend:1', { isFriend: true, pendingCount: 2 })], collapsed: false, collapsedBadge: null } }))
    const folded = render(snapshot({ projects: { rows: [project('friend:1', { isFriend: true, pendingCount: 2, expanded: false, threads: null })], collapsed: false, collapsedBadge: null } }))
    for (const html of [expanded, folded]) {
      expect(html).toContain('aria-label="Needs attention: 2"')
      expect(html).toContain('>2</span>')
    }
  })

  test('zero or missing counts and plain project rows paint no badge', () => {
    const html = render(snapshot({ projects: { rows: [
      project('friend:1', { isFriend: true, pendingCount: 0 }),
      project('friend:2', { isFriend: true }),
      project('app', { pendingCount: 3 }),
    ], collapsed: false, collapsedBadge: null } }))
    expect(html).not.toContain('Needs attention:')
  })

  test('counts above the cap render as 99+', () => {
    const html = render(snapshot({ projects: { rows: [project('friend:1', { isFriend: true, pendingCount: 140 })], collapsed: false, collapsedBadge: null } }))
    expect(html).toContain('>99+</span>')
  })
})
