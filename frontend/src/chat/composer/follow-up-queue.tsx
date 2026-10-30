import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { restrictToVerticalAxis, restrictToFirstScrollableAncestor } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { QueueMessagePreview } from './queue-message-preview'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { icon } from '../../icons'
import { RawHtml } from '../../components/RawHtml'
import { renderMarkdownHtml } from '../markdown'
import type { ComposerReferenceToken } from './reference-token'
import { renderReferencePreview } from './reference-preview'
import { browserTabIconHtml } from './browser-tab-icon'
import { escapeHtml } from '../transcript/factories'

const tt = (key: string): string => (window as any).tt?.(key) || ''

export interface FollowUpRow {
  id: string
  /** An uncertain admission stays saved and cannot be resubmitted. */
  unconfirmed?: boolean
  /** Engine-owned rows are resumed together and are never resent as client rows. */
  readOnly?: boolean
  /** Confirmed mutable engine input can be removed without becoming resendable. */
  removable?: boolean
  /** A mutation is awaiting the host's reply, so the row must not be touched again. */
  mutationPending: boolean
  /** True when delivery failed; the row then offers Retry instead of Steer. */
  paused: boolean
  /** The tooltip's main line for a paused row. */
  pausedTitle: string
  /** The tooltip's second, dimmer line — what the user can do about it. */
  pausedDetail: string
  /** True once the host claimed the row and handed it to the engine. */
  dispatching: boolean
  /**
   * The row's own text, rendered as markdown. Empty when the message carried only
   * attachments, in which case `summary` describes them instead.
   */
  preview: string
  fullText?: string
  composerReferences?: ComposerReferenceToken[]
  /** What to show when there is no text: a paste preview or an attachment count. */
  summary: string
  /** True when `summary` rather than `preview` is what the row shows. */
  summaryOnly: boolean
  /** First inline image, if any — drawn as a thumbnail before the text. */
  thumbnail: { src: string; alt: string } | null
}

export interface FollowUpQueueHandlers {
  onResume(): void
  onDeliver(id: string): void
  onEdit(id: string): void
  onDelete(id: string): void
  /** Move `id` immediately before `beforeId`; `null` appends it to the end. */
  onReorder(id: string, beforeId: string | null): void
  /**
   * Start this queued message as a side chat instead of waiting for the turn.
   *
   * Optional: a side chat's own queue omits it, since opening a side chat from a
   * side chat is not a thing this product does. When absent the menu item is not
   * rendered at all rather than rendered dead — a control that cannot work is worse
   * than no control.
   */
  onOpenInSideChat?(id: string): void
  /** Flip the follow-up default between queueing and steering. */
  onToggleQueueing(): void
}

export interface FollowUpQueueApi {
  /** rows=null → 整条隐藏（归档态/空队列）；banner 为打断暂停的头部横幅。 */
  render(rows: FollowUpRow[] | null, banner: string | null, queueingEnabled: boolean, sessionId?: string): void
}

interface QueueState {
  sessionId: string
  rows: FollowUpRow[] | null
  banner: string | null
  queueingEnabled: boolean
}

/** Keep list changes readable while rows enter and leave. */
const TRANSITION_MS = 180
/** Movement needed before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 6

/**
 * Whether a press has become a drag yet.
 *
 * Split out from the pointer handler so the rule is testable on its own: a row
 * that started dragging the instant it was pressed made the Steer/Edit/Delete
 * buttons feel unreliable, because any tremor while clicking one turned into a
 * move. The vertical-only reading lives here too — a sideways sweep must not
 * change the drop target in a list that has one axis.
 */
export function dragActive(startY: number, clientY: number): boolean {
  return Math.abs(clientY - startY) >= DRAG_THRESHOLD_PX
}

/**
 * Rows the host has dropped but that are still animating out, plus rows that just
 * arrived and are animating in.
 *
 * Without this the queue bar changes height in one frame, which reads as flicker
 * when several messages drain back to back. A library would hand it over; the
 * alternative was keeping nothing, so the departing row is held for exactly one
 * transition and the timers are cleared on unmount so a closing window cannot
 * setState on a dead component.
 */
function useRowTransitions(rows: FollowUpRow[] | null) {
  const live = rows ?? []
  const [departing, setDeparting] = useState<Map<string, FollowUpRow>>(() => new Map())
  const [entering, setEntering] = useState<Set<string>>(() => new Set())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const known = useRef(new Map<string, FollowUpRow>())

  useEffect(() => {
    const ids = new Set(live.map(row => row.id))
    for (const [id, row] of known.current) {
      if (ids.has(id) || timers.current.has(id)) continue
      setDeparting(previous => new Map(previous).set(id, row))
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id)
        setDeparting(previous => {
          const next = new Map(previous)
          next.delete(id)
          return next
        })
      }, TRANSITION_MS))
    }
    for (const row of live) {
      if (known.current.has(row.id)) continue
      setEntering(previous => new Set(previous).add(row.id))
    }
    known.current = new Map(live.map(row => [row.id, row]))
  }, [live])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [])

  // A row stays "entering" for one frame so the transition has a start value.
  useLayoutEffect(() => {
    if (entering.size === 0) return
    const frame = requestAnimationFrame(() => setEntering(new Set()))
    return () => cancelAnimationFrame(frame)
  }, [entering])

  const extra = useMemo(() => {
    const out: FollowUpRow[] = []
    for (const [id, row] of departing) if (!ids(live).has(id)) out.push(row)
    return out
  }, [departing, live])

  return { live, extra, entering, leaving: departing }
}

function ids(rows: FollowUpRow[]): Set<string> {
  return new Set(rows.map(row => row.id))
}

/** The pointer-drag state a row reads, and the gesture callbacks it forwards to. */
export interface RowDrag {
  dragId: string | null
  overId: string | null
  begin(event: React.PointerEvent<HTMLElement>, id: string): void
  move(event: React.PointerEvent<HTMLElement>): void
  end(): void
  cancel(): void
  gripProps?: React.HTMLAttributes<HTMLElement>
}

/**
 * The `beforeId` a drop commits, given the row the pointer ended on.
 *
 * The highlighted row is the SLOT the dragged message takes, which is what the
 * whole-row highlight promises: dropping downwards lands the dragged row
 * immediately AFTER the highlighted one (so it occupies that row's old position),
 * dropping upwards lands it immediately BEFORE. The first shipped semantics was a
 * bare "insert before the target" in both directions, which made the most common
 * gesture in a queue — dragging the top message down onto its neighbour — insert
 * the row back where it came from: a silent no-op that read as "dragging does
 * nothing", and every longer downward drop landed one slot above the row the user
 * aimed at.
 *
 * `null` means the end of the queue: a downward drop onto the last row has no
 * successor to land before. Callers must pass an order containing both ids; the
 * hook checks that before committing, because a row can be dispatched away
 * mid-gesture and a commit against a vanished row must not become an append.
 */
/** One row of the queue as the drag gesture needs it: identity plus mutability. */
export interface QueueOrderEntry {
  id: string
  readOnly: boolean
}

/** One row's vertical span in viewport coordinates, as the drop-target read needs it. */
export interface RowSpan {
  id: string
  top: number
  bottom: number
}

/** The vertical spans of every row in the list, in DOM order. */
export function rowSpansOf(list: HTMLElement): RowSpan[] {
  return [...list.querySelectorAll<HTMLElement>('[data-follow-up-id]')].map(el => {
    const rect = el.getBoundingClientRect()
    return { id: el.dataset.followUpId ?? '', top: rect.top, bottom: rect.bottom }
  })
}

/**
 * The row a pointer's vertical position is over.
 *
 * Geometry, not hit-testing. The list fades its top and bottom edges with a
 * mask, and masked-away pixels do not hit-test: a drag whose pointer sat in a
 * fade band asked "what is under the pointer" and got nothing back, so the
 * gesture lost its drop target exactly where the list ends — the two places a
 * reorder most often aims. Rects are also the only answer for the gaps between
 * rows, where hit-testing returns the list container itself and therefore no
 * row at all. Inside a row's span that row wins; in a gap the nearer row does;
 * outside the list there is no target, so a stray sweep over the transcript
 * cannot highlight anything.
 *
 * Only the vertical axis is read, matching the gesture: a sideways sweep must
 * not change the drop target in a single-column list.
 */
export function rowAtPoint(rows: RowSpan[], list: { top: number; bottom: number }, y: number): string | null {
  if (rows.length === 0 || y < list.top || y > list.bottom) return null
  let nearest: string | null = null
  let nearestDistance = Infinity
  for (const row of rows) {
    if (y >= row.top && y <= row.bottom) return row.id
    const distance = y < row.top ? row.top - y : y - row.bottom
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = row.id
    }
  }
  return nearest
}

export function dropBeforeId(order: QueueOrderEntry[], dragId: string, overId: string): string | null {
  const from = order.findIndex(entry => entry.id === dragId)
  const to = order.findIndex(entry => entry.id === overId)
  if (from < 0 || to < 0) return null
  // The first slot below `start` the dragged row may actually take: read-only
  // rows never move, and the dragged row cannot be its own anchor.
  const nextSlot = (start: number) =>
    order.slice(start).find(entry => !entry.readOnly && entry.id !== dragId)?.id ?? null
  // A drop on a read-only row aims as high as the queue allows: immediately
  // after the read-only block. Committing the read-only row's own id instead is
  // how a drop used to vanish — the host keeps those rows out of its client
  // queue and answered the reorder with a silent failure.
  if (order[to].readOnly) return nextSlot(to + 1)
  if (from > to) return overId
  return nextSlot(to + 1)
}

/**
 * Vertical-only drag with a distance threshold.
 *
 * Native HTML5 drag-and-drop gives neither: it starts on any movement and lets the
 * pointer wander sideways. Both matter here — a row that starts dragging the
 * instant it is pressed makes the action buttons feel unreliable, and a horizontal
 * drag has no meaning in a single-column list.
 */
/**
 * The two-part tooltip for a row whose delivery failed.
 *
 * A paused row has to say both what went wrong and what the user can do, and one
 * run-on sentence is hard to read in a hover bubble. The detail rides its own
 * attribute, which the global tooltip renders as a dimmer second line; see
 * `readDetail` in app/tooltip.ts. Nothing is emitted for an ordinary row, so this
 * cannot leave a stale tip on a row that recovered.
 */
function pausedTip(row: FollowUpRow): { title?: string; 'data-klaus-tip-detail'?: string } {
  if (!row.paused) return {}
  return { title: row.pausedTitle, 'data-klaus-tip-detail': row.pausedDetail }
}

function RowIcon({ name, className }: { name: string; className?: string }) {
  return <RawHtml tag="span" className={`composer-status-row-icon${className ? ` ${className}` : ''}`} html={icon(name)} aria-hidden="true" />
}

/**
 * Whether a pointer press starts a drag.
 *
 * Split out because getting it wrong is invisible to every other check in this
 * file, and the shipped first version got it wrong: the queue could not be
 * reordered at all, while the threshold and drop-target tests above all passed.
 *
 * The failure mode this pins. The pointer listener lives on the ROW, so
 * `event.currentTarget` is the row and the grip is one of its descendants.
 * `.closest()` walks UP only, so asking it to find the grip from `currentTarget`
 * can never succeed — the answer is always null and no drag ever starts. The test
 * has to be able to tell that apart from the correct version, which is why both
 * fields are parameters here: a test that passes a row as `currentTarget` and a
 * grip inside it as `target` gets `false` from the broken rule and `true` from this
 * one. Testing `isGripPress` alone would not have caught it, because the broken
 * code never called it.
 */
export function dragPressStarts(event: {
  button: unknown
  target: unknown
  currentTarget: unknown
}): boolean {
  // A secondary press is a context menu, not a drag.
  if (event.button !== 0) return false
  return isGripPress(event.target)
}

/**
 * Whether a press started on the row's drag grip.
 *
 * Walks UP from the element actually pressed, because the listener sits on the row
 * and the grip is below it. See `dragPressStarts` for why the direction matters.
 */
export function isGripPress(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null
  return !!el?.closest?.('[data-follow-up-grip]')
}

/**
 * The row's overflow menu: Edit, Open in side chat, and the queueing default.
 *
 * Edit moved in here from a button of its own because a row carrying three icon
 * buttons beside a labelled one is where a queue of six messages starts to read as
 * a wall of controls. Delete stays outside it — that one is the action a user needs
 * to reach while skimming a list they did not mean to fill.
 *
 * `queueingEnabled` is queue-level rather than row-level, but the toggle is offered
 * per row because that is where the user is looking when they decide the default was
 * wrong; every row shows the same switch, and flipping any of them flips the one
 * preference.
 */
/**
 * `initialOpen` exists so a test can render the menu in its open state. There is no
 * DOM test environment in this project — component coverage is `renderToStaticMarkup`,
 * which never dispatches a click — so without this seam the three menu entries could
 * only be asserted as source strings, which proves the file mentions them rather than
 * that the menu offers them. Production callers never pass it.
 */
export function RowMenu({ row, handlers, queueingEnabled, disabled, initialOpen = false }: {
  row: FollowUpRow
  handlers: FollowUpQueueHandlers
  queueingEnabled: boolean
  disabled: boolean
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  const menuId = useId(), triggerId = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const firstFocus = useRef<'first' | 'last'>('first')
  const typeahead = useRef({ value: '', time: 0 })
  const close = (restore = true) => {
    setOpen(false)
    if (restore) triggerRef.current?.focus({ preventScroll: true })
  }
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useLayoutEffect(() => {
    if (!open) return
    const items = panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    const item = firstFocus.current === 'last' ? items?.[items.length - 1] : items?.[0]
    item?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      // The panel is portalled to `document.body` (see the render below), so it is
      // NOT a descendant of `rootRef`; without this second check the very click
      // that opens the menu would also count as "outside" and close it again.
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) close(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key === 'Tab') { event.preventDefault(); return }
      if ((event.key === 'Enter' || event.key === ' ') && panelRef.current?.contains(document.activeElement)) {
        event.preventDefault(); (document.activeElement as HTMLButtonElement)?.click(); return
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
        const now = Date.now(), previous = typeahead.current
        const query = (now - previous.time < 700 ? previous.value : '') + event.key.toLocaleLowerCase()
        typeahead.current = { value: query, time: now }
        const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
        const match = items.find(item => item.textContent?.trim().toLocaleLowerCase().startsWith(query))
        match?.focus({ preventScroll: true })
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next]?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  // The panel is `position: fixed` because its natural parent clips: the row sits in
  // a height-capped scroll list, and an absolutely positioned menu inside it would
  // be cut off by the list's own overflow. Fixed positioning escapes `overflow`
  // clipping, but NOT a mask: the list's edge fade (`mask-image` on
  // `.follow-up-queue-inner`) clips the painted output of the whole subtree, fixed
  // descendants included, so a menu opening above the list's top edge was painted
  // nowhere and hit-tested to nothing — the trigger looked dead. Measured in
  // headless Chrome: with the mask, `elementFromPoint` at the panel's centre
  // returned the row behind it; without it, the panel. The panel therefore renders
  // through a portal into `document.body`, where no ancestor can clip or re-anchor
  // it, and is positioned from viewport coordinates as before. Scrolling or
  // resizing the window would leave a body-level panel hanging over unrelated
  // content, so closing on either stays the cheapest correct answer — the menu is
  // a transient affordance, and re-opening it costs one click.
  useEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return
    const trigger = triggerRef.current
    const panel = panelRef.current
    const rect = trigger.getBoundingClientRect()
    panel.style.left = '0px'
    panel.style.top = '0px'
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
    const panelRect = panel.getBoundingClientRect()
    // Right-align to the trigger, then pull it back inside the viewport.
    let left = rect.right - panelRect.width
    if (left < 8) left = 8
    if (left + panelRect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - panelRect.width - 8)
    // The queue sits at the bottom of the window, so the menu opens UPWARD unless
    // there is no room above it either.
    let top = rect.top - panelRect.height - 4
    if (top < 8) top = Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - panelRect.height - 8))
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`

    const close = () => setOpen(false)
    // Close when a scroll moves the row out from under the panel. The listener
    // must NOT sit on `window` in the capture phase: scroll does not bubble, but
    // capture still walks the whole chain from window down, so the transcript's
    // sticky-to-bottom auto-scroll during a running turn fired it and closed the
    // menu in the same frame the click opened it — the menu looked dead. Only
    // scrollers that actually contain the trigger can move the row, so listen on
    // exactly that ancestor chain.
    const scrollers: EventTarget[] = []
    for (let el: HTMLElement | null = trigger.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el)
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) scrollers.push(el)
    }
    const onScroll = (event: Event) => { if (scrollers.includes(event.target as EventTarget)) close() }
    for (const scroller of scrollers) scroller.addEventListener('scroll', onScroll)
    window.addEventListener('resize', close)
    return () => {
      for (const scroller of scrollers) scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const choose = (action: () => void) => () => { if (!disabled) { close(); action() } }

  return (
    <span className="follow-up-menu" ref={rootRef}>
      <button
        type="button"
        className="composer-status-icon-action"
        data-follow-up-action="more"
        ref={triggerRef}
        id={triggerId}
        aria-controls={open ? menuId : undefined}
        onClick={() => { firstFocus.current = 'first'; setOpen(value => !value) }}
        onKeyDown={event => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault(); firstFocus.current = event.key === 'ArrowUp' ? 'last' : 'first'; setOpen(true)
          }
        }}
        aria-haspopup="menu"
        disabled={disabled}
        aria-label={tt('follow_up_more')}
        aria-expanded={open}
      >
        <RawHtml html={icon('follow-up-more')} />
      </button>
      {open ? (() => {
        const panel = (
          <div className="follow-up-menu-panel" role="menu" id={menuId} aria-labelledby={triggerId} aria-orientation="vertical" ref={panelRef}>
            <button
              type="button"
              className="follow-up-menu-item"
              role="menuitem"
              data-follow-up-action="edit"
              onClick={choose(() => handlers.onEdit(row.id))}
            >
              <RawHtml className="follow-up-menu-icon" html={icon('follow-up-edit-full')} />
              <span className="follow-up-menu-label">{tt('follow_up_edit_message')}</span>
            </button>
            {handlers.onOpenInSideChat ? (
              <button
                type="button"
                className="follow-up-menu-item"
                role="menuitem"
                data-follow-up-action="side-chat"
                onClick={choose(() => handlers.onOpenInSideChat!(row.id))}
              >
                <RawHtml className="follow-up-menu-icon" html={icon('follow-up-side-chat')} />
                <span className="follow-up-menu-label">{tt('follow_up_open_in_side_chat')}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="follow-up-menu-item"
              role="menuitem"
              data-follow-up-action="toggle-queueing"
              onClick={choose(() => handlers.onToggleQueueing())}
            >
              <RawHtml className="follow-up-menu-icon" html={icon('follow-up-queueing')} />
              <span className="follow-up-menu-label">{tt(queueingEnabled ? 'follow_up_turn_off_queueing' : 'follow_up_turn_on_queueing')}</span>
            </button>
          </div>
        )
        // Portalled to `document.body` so no ancestor's mask / overflow / containing
        // block can hide it; see the positioning effect above. `typeof document`
        // keeps `renderToStaticMarkup` (the tests' renderer, no DOM) working: it
        // renders the panel inline, where the markup assertions can see it.
        return typeof document !== 'undefined' ? createPortal(panel, document.body) : panel
      })() : null}
    </span>
  )
}

export function QueueRow({ row, handlers, drag, reorderable, queueingEnabled, sessionId }: {
  sessionId?: string
  row: FollowUpRow
  handlers: FollowUpQueueHandlers
  drag: RowDrag
  reorderable: boolean
  queueingEnabled: boolean
}) {
  const classes = [
    'composer-status-row',
    'follow-up-queue-item',
    row.paused ? 'is-paused' : '',
    row.dispatching ? 'is-dispatching' : '',
    row.mutationPending ? 'is-mutation-pending' : '',
    drag.dragId === row.id ? 'is-dragging' : '',
    drag.overId === row.id && drag.dragId !== row.id ? 'is-drop-target' : '',
  ].filter(Boolean).join(' ')
  const disabled = row.dispatching || row.mutationPending
  const submissionDisabled = disabled || !!row.unconfirmed
  // The pointer handlers live on the row itself; the slot wrapper that carries the
  // enter/exit animation is rendered by the caller so the collapse can be measured.
  return (
    <div
      className={classes}
      data-follow-up-id={row.id}
      onPointerDown={event => { if (!row.readOnly) drag.begin(event, row.id) }}
      onPointerMove={drag.move}
      onPointerUp={drag.end}
      onPointerCancel={drag.cancel}
    >
        {/* The grip is always drawn once there is something to reorder against:
            hiding it but keeping its slot left a wide dead gap at the row's left
            edge, and a handle that only appears on hover made the row's left
            inset jump. A single row has nothing to reorder, so it renders no
            grip at all and the text starts right after the queue icon. */}
        {reorderable && !row.readOnly ? (
          <span className="follow-up-queue-grip" data-follow-up-grip="" {...drag.gripProps}>
            <RawHtml html={icon('follow-up-queue-grip')} />
          </span>
        ) : null}
        <RowIcon
          name={row.dispatching ? 'follow-up-sending' : 'follow-up-queue'}
          className={row.dispatching ? 'follow-up-queue-icon is-sending' : 'follow-up-queue-icon'}
        />
        {row.dispatching ? <span className="sr-only" role="status">{tt('follow_up_sending')}</span> : null}
        {row.paused || row.unconfirmed ? <span className="follow-up-warning" title={row.unconfirmed ? tt('follow_up_delivery_unknown') : row.pausedTitle}
          data-klaus-tip-detail={row.unconfirmed ? undefined : row.pausedDetail}><RowIcon name="follow-up-paused" /></span> : null}
        {row.thumbnail ? (
          <img className="follow-up-queue-thumb" src={row.thumbnail.src} alt={row.thumbnail.alt} draggable={false} />
        ) : null}
        {/* The row's own words render as markdown, clamped to one line: a queued
            message often carries a path or an inline code span, and showing those
            as literal asterisks makes the row harder to recognise at a glance. The
            pipeline escapes raw HTML, so the text stays inert. A row with no words
            of its own shows the attachment summary instead. */}
        <QueueMessagePreview text={row.fullText ?? row.preview} summary={row.summaryOnly ? row.summary : row.preview}
          disabled={!!drag.dragId}>
        {row.summaryOnly ? (
          <span
            className="composer-status-row-title follow-up-queue-preview is-summary"
            {...pausedTip(row)}
          >
            {row.summary}
          </span>
        ) : (
          <RawHtml
            tag="span"
            className="composer-status-row-title follow-up-queue-preview follow-up-queue-markdown"
            html={renderReferencePreview(row.preview, row.composerReferences, text => renderMarkdownHtml(text, sessionId).replace(/<a\b[^>]*>/g, '<span>').replace(/<\/a>/g, '</span>'), reference =>
              (window as any).renderComposerReferencePillHtml?.(reference)
              || `<span class="slash-pill composer-reference-pill">${reference.kind === 'browser-tab' ? browserTabIconHtml(reference.browserTab?.faviconUrl, 'slash-pill-icon') : ''}<span class="slash-pill-label">${escapeHtml(reference.name)}</span></span>`)}
            {...pausedTip(row)}
          />
        )}
        </QueueMessagePreview>
        {!row.readOnly || row.removable ? <span className="composer-status-row-actions">
          {!row.readOnly && !row.dispatching ? <>
          <button
            type="button"
            className="composer-status-action is-primary follow-up-queue-steer"
            data-follow-up-action={row.paused ? 'retry' : 'send-now'}
            onClick={() => handlers.onDeliver(row.id)}
            disabled={submissionDisabled}
            {...(row.paused
              ? { title: tt('follow_up_retry_tooltip'), 'data-klaus-tip-detail': tt('follow_up_retry_tooltip_detail') }
              : { title: tt('follow_up_send_now_tooltip') })}
          >
            <RawHtml html={icon('follow-up-steer')} />
            <span>{row.paused ? tt('follow_up_retry') : tt('follow_up_send_now')}</span>
          </button>
          </> : null}
          <button
            type="button"
            className="composer-status-icon-action"
            data-follow-up-action="delete"
            onClick={() => handlers.onDelete(row.id)}
            disabled={disabled}
            aria-label={tt('follow_up_delete')}
          >
            <RawHtml html={icon('follow-up-delete-full')} />
          </button>
          {!row.readOnly && !row.dispatching ? <RowMenu row={row} handlers={handlers} queueingEnabled={queueingEnabled} disabled={submissionDisabled} /> : null}
        </span> : null}
    </div>
  )
}

function SortableRow({ row, handlers, reorderable, queueingEnabled, sessionId, draggingId }: {
  row: FollowUpRow; handlers: FollowUpQueueHandlers; reorderable: boolean; queueingEnabled: boolean; sessionId: string; draggingId: string | null
}) {
  const sortable = useSortable({ id: row.id, disabled: !reorderable })
  const drag: RowDrag = {
    dragId: draggingId, overId: null,
    begin() {}, move() {}, end() {}, cancel() {},
    gripProps: { ...sortable.attributes, ...sortable.listeners },
  }
  return <div ref={sortable.setNodeRef} style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition,
    position: 'relative', zIndex: sortable.isDragging ? 1 : undefined }}>
    <QueueRow row={row} handlers={handlers} drag={drag} reorderable={reorderable} queueingEnabled={queueingEnabled} sessionId={sessionId} />
  </div>
}

function QueueContents({ rows, banner, queueingEnabled, sessionId, container, handlers }: QueueState & {
  container: HTMLElement; handlers: FollowUpQueueHandlers
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_THRESHOLD_PX } }))
  const { live, extra, entering, leaving } = useRowTransitions(rows)
  const latest = useRef(live)
  latest.current = live
  const [activeId, setActiveId] = useState<string | null>(null)
  const reorderable = live.length > 1 && live.every(row => !row.readOnly && !row.dispatching && !row.mutationPending && !row.unconfirmed)
  useEffect(() => { if (!reorderable) setActiveId(null) }, [reorderable])
  const visible = live.length > 0 || extra.length > 0
  useLayoutEffect(() => { container.hidden = !visible }, [container, visible])
  if (!visible) return null
  return <DndContext key={reorderable ? 'sortable' : 'fixed'} sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
    onDragStart={event => setActiveId(String(event.active.id))} onDragCancel={() => setActiveId(null)}
    onDragEnd={event => {
      setActiveId(null)
      const from = String(event.active.id), to = event.over ? String(event.over.id) : null
      const current = latest.current
      if (!reorderable || !to || from === to || !current.some(row => row.id === from) || !current.some(row => row.id === to)) return
      handlers.onReorder(from, dropBeforeId(current.map(row => ({ id: row.id, readOnly: false })), from, to))
    }}>
    <div className="composer-status-rail follow-up-queue-inner" data-dragging={!!activeId}>
      {banner ? <div className="composer-status-row follow-up-queue-banner">
        <span className="composer-status-row-title">{banner}</span>
        <span className="composer-status-row-actions"><button type="button" className="composer-status-action is-primary"
          data-follow-up-action="resume-queue" disabled={live.some(row => row.dispatching || row.mutationPending || row.unconfirmed)}
          onClick={handlers.onResume}>{tt('follow_up_resume')}</button></span>
      </div> : null}
      <SortableContext items={live.map(row => row.id)} strategy={verticalListSortingStrategy}>
        {[...live, ...extra].map(row => <div key={row.id} className="follow-up-queue-slot"
          data-state={leaving.has(row.id) ? 'leaving' : entering.has(row.id) ? 'entering' : 'settled'}>
          <SortableRow row={row} handlers={handlers} reorderable={reorderable && !leaving.has(row.id)}
            queueingEnabled={queueingEnabled} sessionId={sessionId} draggingId={activeId} />
        </div>)}
      </SortableContext>
    </div>
  </DndContext>
}

function FollowUpQueueBody({ store, container, handlers }: {
  store: StoreApi<QueueState>; container: HTMLElement; handlers: FollowUpQueueHandlers
}) {
  const state = useStore(store)
  // A different conversation must never retain a preview, menu or drag from the previous one.
  return <QueueContents key={state.sessionId} {...state} container={container} handlers={handlers} />
}

export function mountFollowUpQueue(container: HTMLElement | null, handlers: FollowUpQueueHandlers): FollowUpQueueApi | null {
  if (!container) return null
  const store = createStore<QueueState>(() => ({ rows: null, banner: null, queueingEnabled: false, sessionId: '' })) as StoreApi<QueueState>
  createRoot(container).render(<FollowUpQueueBody store={store} container={container} handlers={handlers} />)
  return { render(rows, banner, queueingEnabled, sessionId = '') {
    store.setState({ rows: rows ? [...rows] : null, banner: banner ?? null, queueingEnabled, sessionId })
  } }
}
