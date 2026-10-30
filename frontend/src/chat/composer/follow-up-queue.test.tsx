// The queue bar's row, rendered.
//
// composer-queue-layout.test.ts pins the stylesheet and the component's source
// shape; this pins what the component actually DRAWS and what its handlers do.
// Both are needed: a row can be built from the right classes and still hand the
// wrong id to the host, and a CSS-only test cannot see that.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

const labels: Record<string, string> = {
  follow_up_send_now: 'Steer',
  follow_up_send_now_tooltip: 'Submit without interrupting the model',
  follow_up_retry: 'Retry',
  follow_up_retry_tooltip: 'Try sending this queued message again',
  follow_up_retry_tooltip_detail: 'Edit or delete it if retry keeps failing',
  follow_up_paused_hint: 'Retry, edit, or delete it to continue the queue',
  follow_up_paused: 'This queued message could not be sent',
  follow_up_edit: 'Edit',
  follow_up_edit_message: 'Edit message',
  follow_up_more: 'Queued message actions',
  follow_up_open_in_side_chat: 'Open in side chat',
  follow_up_turn_on_queueing: 'Turn on queueing',
  follow_up_turn_off_queueing: 'Turn off queueing',
  follow_up_delete: 'Delete',
}

// The icon registry publishes itself onto `window` at module load, so the global
// has to exist before the component is imported — hence the dynamic import below,
// which is also how the transcript tests in this repo handle it.
;(globalThis as Record<string, unknown>).window = { tt: (key: string) => labels[key] ?? key, addEventListener: () => {} }

const { dragActive, dragPressStarts, dropBeforeId, rowAtPoint, QueueRow, RowMenu } = await import('./follow-up-queue')
type FollowUpRow = import('./follow-up-queue').FollowUpRow
type FollowUpQueueHandlers = import('./follow-up-queue').FollowUpQueueHandlers
type RowDrag = import('./follow-up-queue').RowDrag

function row(overrides: Partial<FollowUpRow> = {}): FollowUpRow {
  return {
    id: 'queued-one',
    mutationPending: false,
    paused: false,
    pausedTitle: '',
    pausedDetail: '',
    dispatching: false,
    preview: 'Check the final tool output',
    summary: '',
    summaryOnly: false,
    thumbnail: null,
    ...overrides,
  }
}

function idleDrag(): RowDrag {
  return { dragId: null, overId: null, begin: () => {}, move: () => {}, end: () => {}, cancel: () => {} }
}

/**
 * Inert handlers. These rows are rendered with `renderToStaticMarkup`, which never
 * dispatches an event, so nothing here is ever called; they exist only to satisfy
 * the component's required prop.
 */
function handlers(): FollowUpQueueHandlers {
  return { onResume() {}, onDeliver() {}, onEdit() {}, onDelete() {}, onReorder() {}, onOpenInSideChat() {}, onToggleQueueing() {} }
}

const render = (
  value: FollowUpRow,
  overrides: Partial<{ handlers: FollowUpQueueHandlers; drag: RowDrag; reorderable: boolean; queueingEnabled: boolean }> = {},
) =>
  renderToStaticMarkup(
    <QueueRow
      row={value}
      handlers={overrides.handlers ?? handlers()}
      drag={overrides.drag ?? idleDrag()}
      reorderable={overrides.reorderable ?? false}
      queueingEnabled={overrides.queueingEnabled ?? false}
    />,
  )

describe('queued message row', () => {
  test('an ordinary row offers Steer, a row menu and delete', () => {
    const html = render(row())
    expect(html).toContain('Check the final tool output')
    expect(html).toContain('data-follow-up-action="send-now"')
    expect(html).toContain('<span>Steer</span>')
    expect(html.indexOf('data-follow-up-action="delete"')).toBeLessThan(html.indexOf('data-follow-up-action="more"'))
    expect(html).toContain('data-follow-up-action="more"')
    expect(html).toContain('data-follow-up-action="delete"')
    // Icon-only controls carry a localized accessible name instead of a tooltip,
    // which is the rule for controls outside the collapsed right rail.
    expect(html).toContain('aria-label="Queued message actions"')
    expect(html).toContain('aria-label="Delete"')
    expect(html).not.toContain('is-paused')
  })

  test('edit lives in the row menu, which is collapsed until opened', () => {
    // Three icon buttons beside a labelled one is what made a queue of six messages
    // read as a wall of controls, so edit moved behind the overflow trigger.
    const closed = render(row())
    expect(closed).not.toContain('data-follow-up-action="edit"')
    expect(closed).not.toContain('Open in side chat')
    expect(closed).toContain('aria-expanded="false"')
  })

  test('the open menu offers edit, side chat and the queueing switch', () => {
    const html = renderToStaticMarkup(
      <RowMenu row={row()} handlers={handlers()} queueingEnabled disabled={false} initialOpen />,
    )
    expect(html).toContain('data-follow-up-action="edit"')
    expect(html).toContain('Edit message')
    expect(html).toContain('data-follow-up-action="side-chat"')
    expect(html).toContain('Open in side chat')
    expect(html).toContain('data-follow-up-action="toggle-queueing"')
    // The switch is labelled by what it will DO, not by the current mode: a row that
    // read "Queueing: on" would leave the user guessing what clicking means.
    expect(html).toContain('Turn off queueing')
    expect(html).not.toContain('Turn on queueing')
    expect(html).toContain('role="menu"')
    expect(html).toContain('role="menuitem"')
    // Static markup has no `document`, so this is the fallback branch: the panel
    // renders inline. In the browser RowMenu portals it to `document.body` — the
    // masked scroll list clips a fixed descendant's paint, which is what made the
    // menu invisible — and composer-queue-layout.test.ts pins that portal.
    expect(html).toContain('follow-up-menu-panel')
  })

  test('the queueing switch offers the opposite of the current default', () => {
    const html = renderToStaticMarkup(
      <RowMenu row={row()} handlers={handlers()} queueingEnabled={false} disabled={false} initialOpen />,
    )
    expect(html).toContain('Turn on queueing')
    expect(html).not.toContain('Turn off queueing')
  })

  test('the menu trigger is disabled while the host owns the row', () => {
    const html = renderToStaticMarkup(
      <RowMenu row={row({ dispatching: true })} handlers={handlers()} queueingEnabled disabled initialOpen />,
    )
    expect(html).toContain('data-follow-up-action="more"')
    expect(html).toMatch(/data-follow-up-action="more"[^>]*disabled=""/)
  })

  test('a failed row says Retry and keeps the failure reason reachable', () => {
    const html = render(row({
      paused: true,
      pausedTitle: 'The engine refused this input',
      pausedDetail: 'Retry, edit, or delete it to continue the queue',
    }))
    expect(html).toContain('data-follow-up-action="retry"')
    expect(html).toContain('<span>Retry</span>')
    expect(html).not.toContain('data-follow-up-action="send-now"')
    expect(html).toContain('is-paused')
    // Both halves of the explanation have to survive into the markup: the reason as
    // the tooltip's main line and the remedy as its dimmer second line.
    expect(html).toContain('The engine refused this input')
    expect(html).toContain('Retry, edit, or delete it to continue the queue')
    expect(html).toContain('data-klaus-tip-detail=')
    expect(html).toContain('title="Try sending this queued message again"')
  })

  test('an ordinary row carries no paused tooltip of its own', () => {
    const html = render(row())
    expect(html).not.toContain('data-klaus-tip-detail')
    expect(html).toContain('title="Submit without interrupting the model"')
  })

  test('a row the host is sending cannot be edited, retried or deleted', () => {
    const html = render(row({ dispatching: true }))
    expect(html).toContain('is-dispatching')
    const disabledCount = html.split('disabled=""').length - 1
    expect(disabledCount).toBe(1)
  })

  test('a row with a mutation in flight is locked the same way', () => {
    const html = render(row({ mutationPending: true }))
    expect(html).toContain('is-mutation-pending')
    expect(html.split('disabled=""').length - 1).toBe(3)
  })

  test('the grip renders only when there is something to reorder against', () => {
    // A single row has no reorder target, so it draws no grip at all — an empty
    // slot would leave dead space at the row's left edge. A reorderable row
    // draws the grip permanently, not as a hover reveal.
    const single = render(row(), { reorderable: false })
    expect(single).not.toContain('data-follow-up-grip')
    const pair = render(row(), { reorderable: true })
    expect(pair).toContain('data-follow-up-grip')
    expect(pair).not.toContain('visibility:hidden')
  })

  test('drag and drop targets are marked on the rows involved', () => {
    const dragging = render(row(), { drag: { ...idleDrag(), dragId: 'queued-one' } })
    expect(dragging).toContain('is-dragging')
    const targeted = render(row({ id: 'queued-two' }), { drag: { ...idleDrag(), dragId: 'queued-one', overId: 'queued-two' } })
    expect(targeted).toContain('is-drop-target')
    // The row being dragged is never its own drop target.
    const selfTargeted = render(row(), { drag: { ...idleDrag(), dragId: 'queued-one', overId: 'queued-one' } })
    expect(selfTargeted).not.toContain('is-drop-target')  })

  test('every row shares the status-row primitive with the goal card', () => {
    const html = render(row())
    expect(html).toContain('composer-status-row')
    expect(html).toContain('composer-status-row-actions')
    expect(html).toContain('composer-status-action is-primary')
    expect(html).toContain('composer-status-icon-action')
    expect(html).toContain('data-follow-up-id="queued-one"')
  })

  test('the row’s own words render as markdown, not as literal markup', () => {
    const html = render(row({ preview: 'Check `dist/main.js` and *then* stop' }))
    expect(html).toContain('follow-up-queue-markdown')
    expect(html).toContain('<code>dist/main.js</code>')
    expect(html).toContain('<em>then</em>')
    // The raw text is gone: showing it alongside the rendered form would print
    // the backticks and asterisks the user never meant to read.
    expect(html).not.toContain('Check `dist/main.js`')
  })

  test('a queued message cannot inject markup of its own', () => {
    const html = render(row({ preview: 'hi <img src=x onerror="steal()"> there' }))
    // The invariant is that no live element came out of the user's text. Checking
    // for the word "onerror" is the wrong test: the escaped output still contains
    // it as inert characters, which is exactly what must happen.
    expect(html).not.toMatch(/<img\s[^>]*onerror/i)
    expect(html).toContain('&lt;img src=x onerror=&quot;steal()&quot;&gt;')
  })

  test('an attachment-only row shows its summary and its thumbnail', () => {
    const html = render(row({
      preview: '',
      summary: '2 images',
      summaryOnly: true,
      thumbnail: { src: 'klaus-media://uploads/abc.png', alt: 'screenshot.png' },
    }))
    expect(html).toContain('2 images')
    expect(html).toContain('is-summary')
    expect(html).toContain('class="follow-up-queue-thumb"')
    expect(html).toContain('src="klaus-media://uploads/abc.png"')
    expect(html).toContain('alt="screenshot.png"')
    expect(html).not.toContain('follow-up-queue-markdown')
  })

  test('a thumbnail never renders when the row has no image', () => {
    expect(render(row())).not.toContain('follow-up-queue-thumb')
  })
})

describe('drag activation', () => {
  test('a press that barely moved is still a click on the control under it', () => {
    expect(dragActive(100, 100)).toBe(false)
    expect(dragActive(100, 105)).toBe(false)
    expect(dragActive(100, 95)).toBe(false)
  })

  test('a deliberate vertical move becomes a drag', () => {
    expect(dragActive(100, 106)).toBe(true)
    expect(dragActive(100, 80)).toBe(true)
  })
})

describe('drop position', () => {
  const entry = (id: string, readOnly = false) => ({ id, readOnly })
  const order = [entry('q1'), entry('q2'), entry('q3')]

  test('a downward drop takes the highlighted row’s slot', () => {
    // REGRESSION: the first shipped drop rule was "insert before the target" in
    // both directions. Dragging the top row onto its neighbour then inserted it
    // back where it came from — a silent no-op the user reads as "dragging does
    // nothing" — and every longer downward drop landed one slot above the row
    // aimed at. Downwards, the dragged row must land AFTER the highlighted one.
    expect(dropBeforeId(order, 'q1', 'q2')).toBe('q3')
    expect(dropBeforeId(order, 'q1', 'q3')).toBe(null)
    expect(dropBeforeId(order, 'q2', 'q3')).toBe(null)
  })

  test('an upward drop lands immediately before the highlighted row', () => {
    expect(dropBeforeId(order, 'q3', 'q1')).toBe('q1')
    expect(dropBeforeId(order, 'q3', 'q2')).toBe('q2')
    expect(dropBeforeId(order, 'q2', 'q1')).toBe('q1')
  })

  test('the drop target comes from row geometry, not hit-testing', () => {
    // The list's edge fade masks its first and last pixels away and masked
    // pixels do not hit-test, so asking "what is under the pointer" lost the
    // drop target inside the fade bands — the two places a reorder aims most.
    // Rects answer there, and in the gaps between rows where hit-testing
    // returns the list container and therefore no row at all.
    const rows = [
      { id: 'q1', top: 61, bottom: 90 },
      { id: 'q2', top: 96, bottom: 125 },
    ]
    const list = { top: 61, bottom: 125 }
    // Inside the top fade band, which overlaps the first row's own span.
    expect(rowAtPoint(rows, list, 63)).toBe('q1')
    // Inside the bottom fade band, overlapping the last row.
    expect(rowAtPoint(rows, list, 124)).toBe('q2')
    // In the gap between two rows the nearer one wins.
    expect(rowAtPoint(rows, list, 94)).toBe('q2')
    expect(rowAtPoint(rows, list, 91)).toBe('q1')
    // Outside the list there is no target: a stray sweep over the transcript
    // must not highlight a row.
    expect(rowAtPoint(rows, list, 40)).toBe(null)
    expect(rowAtPoint(rows, list, 140)).toBe(null)
    expect(rowAtPoint([], list, 80)).toBe(null)
  })

  test('a drop on a read-only row lands as high as the queue allows', () => {
    // Engine-owned rows lead the list and never move, so a drop on one aims at
    // the first slot below the read-only block. Committing the read-only row's
    // own id instead is how such a drop used to vanish without a trace.
    const mixed = [entry('engine:1', true), entry('q1'), entry('q2')]
    expect(dropBeforeId(mixed, 'q2', 'engine:1')).toBe('q1')
    // A row already sitting directly under the read-only block has nowhere
    // higher to go: the resolved slot equals its own successor, which the drop
    // handler reads as "no move" and commits nothing.
    expect(dropBeforeId(mixed, 'q1', 'engine:1')).toBe('q2')
  })
})

/**
 * A minimal ancestor chain standing in for the row's DOM: grip → row → list.
 *
 * `closest` walks UP only, which is the entire point of the regression below — the
 * real row markup has the grip as a child of the row, so a test that only checked a
 * truthy/falsy result on the grip would have passed the broken implementation too.
 *
 * Attributes are spelled exactly as they appear in the markup, including the
 * `data-` prefix the production selector asks for, so this fake answers the same
 * questions the real element would.
 */
function element(attrs: string[], parent: FakeEl | null = null): FakeEl {
  const el: FakeEl = {
    attrs,
    parent,
    closest(selector: string) {
      const wanted = selector.replace(/[[\]"]/g, '')
      for (let node: FakeEl | null = el; node; node = node.parent) {
        if (node.attrs.some(attr => attr === wanted)) return node
      }
      return null
    },
  }
  return el
}
interface FakeEl {
  attrs: string[]
  parent: FakeEl | null
  closest(selector: string): FakeEl | null
}

describe('recognizing a press that starts a drag', () => {
  const list = element(['follow-up-queue-inner'])
  const row = element(['follow-up-queue-item'], list)
  const grip = element(['data-follow-up-grip'], row)
  const gripSvg = element(['kls-icon-host'], grip)
  const title = element(['follow-up-queue-preview'], row)
  const deleteButton = element(['composer-status-icon-action'], row)
  const press = (target: FakeEl | null, button = 0) => ({ button, target, currentTarget: row })

  test('a press on the grip starts a drag', () => {
    // REGRESSION, and the one that matters. The pointer listener sits on the ROW, so
    // `currentTarget` is the row and the grip is a DESCENDANT of it. The first
    // shipped version tested `currentTarget.closest('[data-follow-up-grip]')`, and
    // because `closest` walks UP it always answered null: every drag was dead and
    // the queue could not be reordered at all. This assertion passes the row as
    // `currentTarget` and a grip inside it as `target`, so that version gets `false`
    // here while the correct one gets `true`.
    expect(dragPressStarts(press(grip))).toBe(true)
    // The grip renders an SVG inside it, so the real event target is the icon; the
    // walk up from it must still find the grip.
    expect(dragPressStarts(press(gripSvg))).toBe(true)
  })

  test('a press on the row, its text or an action button does not start a drag', () => {
    // Without this, clicking Delete would also begin a drag gesture.
    expect(dragPressStarts(press(row))).toBe(false)
    expect(dragPressStarts(press(list))).toBe(false)
    expect(dragPressStarts(press(title))).toBe(false)
    expect(dragPressStarts(press(deleteButton))).toBe(false)
  })

  test('a secondary press is a context menu, never a drag', () => {
    expect(dragPressStarts(press(grip, 2))).toBe(false)
    expect(dragPressStarts(press(grip, 1))).toBe(false)
  })

  test('a missing or non-element target does not start a drag', () => {
    expect(dragPressStarts(press(null))).toBe(false)
    expect(dragPressStarts({ button: 0, target: undefined, currentTarget: row })).toBe(false)
    expect(dragPressStarts({ button: 0, target: 'grip', currentTarget: row })).toBe(false)
    expect(dragPressStarts({ button: 0, target: {}, currentTarget: row })).toBe(false)
  })
})

test('engine-owned queued rows expose their input without resend, edit, delete or drag controls', () => {
  const html = render(row({ id: 'engine:stable', readOnly: true, preview: 'Still queued' }), { reorderable: true })
  expect(html).toContain('Still queued')
  expect(html).not.toContain('data-follow-up-action=')
  expect(html).not.toContain('data-follow-up-grip')
})

test('mutable pending engine input offers delete alone', () => {
  const html = render(row({ readOnly: true, removable: true }))
  expect(html).toContain('data-follow-up-action="delete"')
  expect(html).not.toContain('data-follow-up-action="send-now"')
  expect(html).not.toContain('follow-up-queue-grip')
  expect(html).not.toContain('Queued message actions')
})
