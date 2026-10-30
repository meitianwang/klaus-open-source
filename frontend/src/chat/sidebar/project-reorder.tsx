// Drag-to-reorder for the sidebar's Projects section.
//
// The section is ONE ordered list: multi-folder workspace containers, friend
// groups and ordinary projects sit in it together, and the user arranges all of
// them by dragging any row. The dragged unit is the whole GROUP — the row plus
// its expanded thread list — but only the ROW accepts the press, so grabbing a
// thread inside an open group still opens that conversation.
//
// Layering, and why each piece lives where it is:
//
//   - This module owns the GESTURE: the activation threshold, collision
//     detection, the insertion indicator, the lifted overlay, the source group's
//     dimming, edge auto-scroll, the keyboard path and the screen-reader output.
//     All of it is presentation, rendered through the section's own React tree.
//   - `./project-order` owns the ORDER MATH: which half of the hovered row the
//     pointer is in, what key order results, how a stored order reconciles with
//     the rows that exist now. Pure, so every rule is unit-testable.
//   - `chat.ts` owns DURABILITY: it applies a drop optimistically, writes it
//     through `projects:reorder`, and rolls back to the last confirmed order if
//     the write fails. It reports the in-flight write back as `pending`, which is
//     what keeps the indicator painted until the order is confirmed.
//
// A drop is handed to the host as the section's COMPLETE key list, not as an
// index pair. The list is what the host stores, and it stays correct when rows
// appear or vanish between the drag and the write — an index would not.
//
// Keyboard: alt+Arrow moves a group one slot. Enter and Space stay the row's
// existing activate gesture (fold/unfold the group), so a lift-with-space model
// is deliberately not used here: it would take those two keys away from a
// behaviour that already exists and is already covered by tests.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext, DragOverlay, MeasuringStrategy, PointerSensor,
  closestCenter, pointerWithin, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type UniqueIdentifier,
} from '@dnd-kit/core'
import { restrictToFirstScrollableAncestor, restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, type SortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { arrayMove, dropPlacement, dropTargetFrom, moveBefore } from './project-order'
import styles from './sidebar.module.css'

const tt = (key: string, fallback: string): string => {
  const value = (window as any).tt?.(key)
  return value && value !== key ? value : fallback
}

/** Movement needed before a press becomes a drag rather than a click on the row.
 *  Below it, the tremor of an ordinary click would start a reorder. */
export const PROJECT_REORDER_DISTANCE_PX = 6

/** Drag ids carry a prefix so a key that is a path, a digit string or an empty
 *  fragment still yields a usable, unambiguous id. */
const DRAG_ID_PREFIX = 'sidebar-project:'

export function dragIdOfProject(key: string): UniqueIdentifier {
  return `${DRAG_ID_PREFIX}${key}`
}

function keyOfDragId(id: UniqueIdentifier | undefined | null): string | null {
  if (id == null) return null
  const value = String(id)
  return value.startsWith(DRAG_ID_PREFIX) ? value.slice(DRAG_ID_PREFIX.length) : null
}

/** Where the insertion line goes: immediately before this key, or null for the
 *  end of the list. Drives both the painted indicator and the committed order. */
export interface DropIndicatorTarget {
  beforeKey: string | null
}

/** The props a group block and its row need to take part in the drag. */
export interface ProjectGroupDragProps {
  /** Spread on the block that moves: the row plus its expanded thread list. */
  group: {
    ref: (node: HTMLElement | null) => void
    style: React.CSSProperties
    className: string
    inert?: true
  }
  /** Spread on the ROW only, so a thread inside an open group stays clickable. */
  row: {
    ref: (node: HTMLElement | null) => void
    'aria-roledescription'?: string
    'aria-describedby'?: string
    onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void
  }
  /** Whether this group is the one in flight; the block dims while it is. */
  isDragging: boolean
  /** Whether this group is reorderable at all. */
  reorderable: boolean
  /** alt+Arrow handler for the keyboard path. Attach to the row's own keydown
   *  alongside the existing Enter/Space activate gesture. */
  onReorderKeyDown(event: React.KeyboardEvent<HTMLElement>): void
}

export interface ProjectReorderApi {
  /** Whether dragging is offered. False below two rows: nothing to reorder against. */
  reorderable: boolean
  /** The keys in the order currently painted, top to bottom. */
  keys: string[]
  /** Where the insertion line sits, or null while nothing is in flight. */
  dropIndicator: DropIndicatorTarget | null
  /** The key being dragged, or null. */
  activeKey: string | null
  /** Move one group by a signed offset (the alt+arrow keyboard path). */
  moveByOffset(key: string, delta: number): void
}

const ProjectReorderContext = createContext<ProjectReorderApi | null>(null)

/** Read the section's reorder state from inside a row. Null when the section is
 *  not rendered through `ProjectReorderList`, so every consumer must treat
 *  dragging as optional rather than assume it exists. */
export function useProjectReorder(): ProjectReorderApi | null {
  return useContext(ProjectReorderContext)
}

/**
 * No make-way displacement while a group is being dragged.
 *
 * The library's default vertical strategy slides every neighbour out of the
 * dragged row's path. This list deliberately does not, for two reasons.
 *
 * First, the drop position is already fully shown by three cues that agree: the
 * insertion line at the exact slot, the lifted overlay in the hand, and the
 * dimmed source marking the slot being vacated. A fourth cue that also shoves the
 * neighbours around is redundant, and because the strategy keys off the
 * collision's over-index rather than the resolved drop slot, it slides the source
 * one slot past where the line and the commit both say it will land whenever the
 * pointer sits in the upper half of a row — so the row visibly settles somewhere
 * it does not end up.
 *
 * Second, with the neighbours held still there is nothing for the dimmed source
 * to collide with. An earlier build suppressed the source's own transform but
 * still shifted its neighbours, and the first displaced group painted straight on
 * top of the vacated slot.
 *
 * Returning null for every row keeps the list stable under the cursor: the only
 * thing that moves mid-drag is the insertion line. The rows still reorder on
 * drop, through the committed key order — the animation was only ever a cue.
 */
const noDisplacementStrategy: SortingStrategy = () => null

/** A rectangle reduced to what the before/after decision reads. */
interface VerticalRect {
  top: number
  bottom: number
}

function rectOf(rect: { top: number; bottom: number } | undefined | null): VerticalRect | null {
  return rect == null ? null : { top: rect.top, bottom: rect.bottom }
}

/**
 * Collision detection for one column of groups, plus the pointer read that the
 * before/after decision needs.
 *
 * Two passes, in this order:
 *
 *  1. The groups the POINTER is inside. The pointer is what the user aims with,
 *     so when it is over a row that row wins — even when the dragged block is
 *     tall (an expanded group) and overlaps several others at once.
 *  2. Failing that, the group whose centre is nearest the pointer. Without this
 *     pass, dragging above the first row or below the last one — the natural
 *     gesture for "move it to the very top/bottom" — resolves to nothing and the
 *     drop is silently thrown away.
 *
 * Pass 2 collapses the dragged rectangle to a zero-size rect at the pointer, so
 * the comparison measures from where the user is pointing rather than from a
 * block that may span most of the list.
 *
 * The pointer coordinates are stashed for the caller because a drag event does
 * not carry them, and the before/after decision is a pointer decision: using the
 * dragged block's centre instead would place the line by where the block happens
 * to be, which reads one row off as soon as the block is taller than its
 * neighbour.
 */
function createProjectCollision(pointer: { current: { x: number; y: number } | null }): CollisionDetection {
  return (args) => {
    pointer.current = args.pointerCoordinates
    const underPointer = pointerWithin(args)
    if (underPointer.length > 0) return underPointer
    if (args.pointerCoordinates == null) return closestCenter(args)
    const { x, y } = args.pointerCoordinates
    return closestCenter({
      ...args,
      collisionRect: { ...args.collisionRect, top: y, bottom: y, left: x, right: x, width: 0, height: 0 },
    })
  }
}

/**
 * The Projects section body: one sortable list, its lifted overlay, and the
 * screen-reader output for both reorder paths.
 *
 * `keys` is the order to paint. The caller owns it — including the optimistic
 * order it applies the instant a drop lands and the rollback it applies if the
 * write fails — so this component never guesses at durability. `pending` says a
 * commit is in flight, which keeps the indicator painted at the drop position
 * until the host confirms the order.
 */
export function ProjectReorderList({ keys, reorderable, pending, onCommit, overlayFor, children }: {
  /** Keys in the order to paint, top to bottom. */
  keys: string[]
  /** Whether dragging is offered; false below two rows. */
  reorderable: boolean
  /** Whether a commit is in flight. */
  pending: boolean
  /** Called with the section's complete new key order after a drop or an alt+arrow move. */
  onCommit(keys: string[]): void
  /** The lifted copy's contents for one key: its glyph and its label. */
  overlayFor(key: string): { iconHtml: string; label: string } | null
  children: React.ReactNode
}): React.ReactElement {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  /** The indicator target while the pointer is down. */
  const [liveTarget, setLiveTarget] = useState<DropIndicatorTarget | null>(null)
  /** The target of the last commit, kept painted while `pending` is true. */
  const [committedTarget, setCommittedTarget] = useState<DropIndicatorTarget | null>(null)
  /** Keyboard-path announcement. The drag path is announced by DndContext's own
   *  live region; an alt+arrow move never starts a drag, so it needs one too. */
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState('')

  // Refs rather than state for everything that changes on every pointer move:
  // re-rendering the whole section per pixel makes a long list stutter under the
  // cursor, and none of these values needs a render of its own.
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const activeKeyRef = useRef<string | null>(null)
  activeKeyRef.current = activeKey
  const keysRef = useRef<string[]>(keys)
  keysRef.current = keys

  // Once the host confirms the order the indicator has nothing left to mark, and
  // a stale line would sit between rows that already moved.
  useEffect(() => {
    if (!pending) setCommittedTarget(null)
  }, [pending])

  const collisionDetection = useMemo(() => createProjectCollision(pointer), [])

  const sensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: { distance: PROJECT_REORDER_DISTANCE_PX },
  }))

  /** Resolve the current pointer/over reading into "before which key". */
  const resolveTarget = useCallback((
    activeRect: VerticalRect | null,
    overKey: string | null,
    overRect: VerticalRect | null,
  ): DropIndicatorTarget | null => {
    if (activeRect == null || overKey == null || overRect == null) return null
    const placement = dropPlacement(activeRect, pointer.current?.y ?? null, overRect)
    return dropTargetFrom(keysRef.current, activeKeyRef.current, overKey, placement)
  }, [])

  const clearGesture = useCallback(() => {
    setActiveKey(null)
    activeKeyRef.current = null
    setLiveTarget(null)
    pointer.current = null
  }, [])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const key = keyOfDragId(event.active.id)
    setActiveKey(key)
    activeKeyRef.current = key
  }, [])

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    setLiveTarget(resolveTarget(
      rectOf(event.active.rect.current.translated),
      keyOfDragId(event.over?.id),
      rectOf(event.over?.rect),
    ))
  }, [resolveTarget])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    // Resolved from the END event rather than reused from the last move: the last
    // move can predate the pointer's final position, which would commit a slot
    // the user did not drop on.
    const target = resolveTarget(
      rectOf(event.active.rect.current.translated),
      keyOfDragId(event.over?.id),
      rectOf(event.over?.rect),
    )
    const dragged = keyOfDragId(event.active.id)
    clearGesture()
    resetShellScroll()
    // Released on itself, on the row it already neighbours, or outside the list:
    // nothing changes, so nothing is written.
    if (dragged == null || target == null) return
    setCommittedTarget(target)
    onCommit(moveBefore(keysRef.current, dragged, target.beforeKey))
  }, [clearGesture, onCommit, resolveTarget])

  const handleDragCancel = useCallback(() => {
    clearGesture()
    resetShellScroll()
  }, [clearGesture])

  // A gesture that loses its pointer must not stay stuck: switching windows or
  // losing capture mid-drag would leave the lifted overlay on screen with no way
  // to drop it. The library already cancels on resize and on a hidden tab.
  useEffect(() => {
    if (activeKey == null) return
    const cancel = () => handleDragCancel()
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  }, [activeKey, handleDragCancel])

  const moveByOffset = useCallback((key: string, delta: number) => {
    const current = keysRef.current
    const index = current.indexOf(key)
    const next = index + delta
    if (index === -1 || next < 0 || next >= current.length) return
    const moved = arrayMove(current, index, next)
    // No insertion line here. The line marks where a LIFTED row will land; a
    // keyboard move has no lifted row, so its feedback is the new order plus the
    // announcement below. Painting a line would claim a pending drop that does
    // not exist.
    setKeyboardAnnouncement(
      tt('project_reorder_moved_to', 'Moved {name} to position {position} of {count}')
        .replace('{name}', overlayFor(key)?.label ?? key)
        .replace('{position}', String(next + 1))
        .replace('{count}', String(moved.length)),
    )
    onCommit(moved)
  }, [onCommit, overlayFor])

  const api = useMemo<ProjectReorderApi>(() => ({
    reorderable,
    keys,
    dropIndicator: liveTarget ?? (pending ? committedTarget : null),
    activeKey,
    moveByOffset,
  }), [activeKey, committedTarget, keys, liveTarget, moveByOffset, pending, reorderable])

  const overlay = activeKey == null ? null : overlayFor(activeKey)

  return (
    <ProjectReorderContext.Provider value={api}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor, restrictToParentElement]}
        // Re-measure droppables continuously during the drag: edge auto-scroll
        // moves the list under a stationary pointer, which changes every row's
        // viewport-relative rect. A one-shot measurement at drag start would
        // leave the collision detection aiming at where rows WERE before the
        // scroll, so the indicator would land a row off near the container edge.
        measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }}
        autoScroll={{
          // Scroll ONLY real scroll containers (overflow auto/scroll) that hold
          // the pointer. An earlier version allowed any ancestor whose rect
          // contains the pointer, which included the document body and the
          // sidebar shell: both are `overflow: hidden`, and a hidden-overflow box
          // is still programmatically scrollable in Chromium — and the lifted
          // overlay is portalled to the body, so while it hangs near the window's
          // bottom edge the body's scrollHeight exceeds its client height and the
          // auto-scroller drags the WHOLE app upward, leaving it shifted after the
          // release (header rows clipped off the top, window background showing
          // below the footer). Overflow-hidden shells are never scroll targets
          // here; the list's own container is the only one.
          canScroll: (element) => {
            const y = pointer.current?.y
            if (y == null) return false
            const overflow = getComputedStyle(element).overflowY
            if (overflow !== 'auto' && overflow !== 'scroll') return false
            const rect = element.getBoundingClientRect()
            return y >= rect.top && y <= rect.bottom
          },
        }}
        accessibility={{
          container: typeof document === 'undefined' ? undefined : document.body,
          announcements: {
            onDragStart: ({ active }) => {
              const key = keyOfDragId(active.id)
              if (key == null) return undefined
              const position = keys.indexOf(key)
              if (position < 0) return undefined
              return tt('project_reorder_picked_up', 'Picked up {name}, position {position} of {count}')
                .replace('{name}', overlayFor(key)?.label ?? key)
                .replace('{position}', String(position + 1))
                .replace('{count}', String(keys.length))
            },
            onDragOver: ({ over }) => {
              const key = keyOfDragId(over?.id)
              const position = key == null ? -1 : keys.indexOf(key)
              if (position < 0) return undefined
              return tt('project_reorder_moving_to', 'Moving to position {position} of {count}')
                .replace('{position}', String(position + 1))
                .replace('{count}', String(keys.length))
            },
            onDragEnd: ({ over }) => (over == null
              ? tt('project_reorder_cancelled', 'Reordering cancelled')
              : tt('project_reorder_released', 'Project released')),
            onDragCancel: () => tt('project_reorder_cancelled', 'Reordering cancelled'),
          },
          screenReaderInstructions: {
            draggable: tt('project_reorder_instructions', 'Drag to reorder projects, or press alt with the up or down arrow key to move a project by one place.'),
          },
        }}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={keys.map(dragIdOfProject)} strategy={noDisplacementStrategy}>
          <div className={styles['project-sb-body']} role="list" data-project-reorder={reorderable ? 'on' : 'off'}>
            {children}
          </div>
        </SortableContext>
        {overlay == null || activeKey == null ? null : <ProjectDragOverlay iconHtml={overlay.iconHtml} label={overlay.label} />}
      </DndContext>
      <span className={styles['project-reorder-live']} role="status" aria-live="polite" aria-atomic="true">
        {keyboardAnnouncement}
      </span>
    </ProjectReorderContext.Provider>
  )
}

/** Put every overflow-hidden shell back at the top.
 *
 *  The app shell (html, body, the sidebar frame) never scrolls by design — its
 *  overflow is hidden. A stray programmatic scroll of one of them (the drag
 *  auto-scroller is the one thing in this window that can cause it, because a
 *  hidden-overflow box is still scrollable from script and the lifted overlay
 *  portalled to the body can stretch its scroll height) shifts the entire
 *  interface: rows clip off the top and window background shows at the bottom,
 *  with nothing in the normal render path to put it back. Resetting on drag end
 *  and cancel is the guarantee that a finished gesture always leaves the shell
 *  exactly where it was. */
function resetShellScroll(): void {
  if (typeof document === 'undefined') return
  for (const element of [document.documentElement, document.body, document.getElementById('app'), document.getElementById('sidebar')]) {
    if (element != null && element.scrollTop !== 0) element.scrollTop = 0
  }
}

/**
 * Hook for one group: the props its block and its row must carry.
 *
 * The block gets the measurement/transform side, the row gets the pointer
 * listeners. Splitting them is what keeps a thread row inside an expanded group
 * clickable: if the listeners sat on the block, a press anywhere in the group —
 * including on a conversation — would start a drag instead of opening it.
 *
 * The block is `inert` while it is the one being dragged. The lifted overlay is
 * what follows the pointer, and an inert source cannot be re-targeted by the
 * pointer passing back over it, which would otherwise flip the insertion line
 * onto the row being moved.
 */
export function useProjectGroupDrag(key: string): ProjectGroupDragProps {
  const reorder = useProjectReorder()
  const reorderable = reorder?.reorderable ?? false
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: dragIdOfProject(key), disabled: !reorderable })

  const isActive = reorder?.activeKey === key

  const onReorderKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!reorderable || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    // Stop the row's own Enter/Space activate path and the sidebar's arrow
    // navigation from also firing on the same press.
    event.preventDefault()
    event.stopPropagation()
    reorder?.moveByOffset(key, event.key === 'ArrowUp' ? -1 : 1)
  }, [key, reorder, reorderable])

  const style: React.CSSProperties = {
    // With the no-displacement strategy this is always undefined during a drag:
    // no group slides, so the dimmed source keeps marking the slot it was picked
    // up from and the insertion line alone shows where it will land. The line is
    // still driven off the strategy so a future switch back to make-way would
    // animate rather than jump.
    transform: CSS.Translate.toString(transform),
    transition,
    // Touch dragging must not also scroll the list, or the gesture both moves the
    // row and drags the sidebar.
    touchAction: reorderable ? 'none' : undefined,
  }

  return {
    group: {
      ref: setNodeRef,
      style,
      className: [
        styles['project-reorder-group'],
        isDragging ? styles['is-dragging'] : '',
      ].filter(Boolean).join(' '),
      ...(isActive ? { inert: true as const } : {}),
    },
    row: {
      ref: setActivatorNodeRef,
      // Only the two attributes that tell a screen reader this row can be
      // reordered. The row's own role, tabIndex and aria-expanded stay exactly as
      // the section renders them, so this cannot change what the row is.
      'aria-roledescription': reorderable ? attributes['aria-roledescription'] : undefined,
      'aria-describedby': reorderable ? attributes['aria-describedby'] : undefined,
      onPointerDown: reorderable
        ? (listeners?.onPointerDown as ((event: React.PointerEvent<HTMLElement>) => void) | undefined)
        : undefined,
    },
    isDragging,
    reorderable,
    onReorderKeyDown,
  }
}

/** The insertion line, painted between two groups.
 *
 *  Zero height on purpose: it must not shift the rows it sits between, because
 *  the shifting is the sortable strategy's job and a line with height of its own
 *  would double it. The dot at its left end marks which side the row lands on, so
 *  the line reads as an insertion point rather than a divider.
 */
export function ProjectDropIndicator(): React.ReactElement {
  return <div className={styles['project-reorder-indicator']} aria-hidden="true" role="presentation" />
}

/**
 * The lifted copy that follows the pointer.
 *
 * Portalled to the body because the section lives inside the sidebar's scroll
 * container, which clips: an absolutely positioned overlay would be cut off at
 * the list's edge exactly while the user drags past it, and a body-level portal
 * sits outside every ancestor's overflow.
 *
 * It carries the glyph and the name only. The hover actions and the aggregate
 * status badge describe the row where it sits, not the thing being moved, and
 * painting them on a floating copy invites a click that cannot happen.
 */
function ProjectDragOverlay({ iconHtml, label }: { iconHtml: string; label: string }): React.ReactElement | null {
  if (typeof document === 'undefined') return null
  return createPortal(
    <DragOverlay dropAnimation={null} zIndex={2147483647} modifiers={[restrictToVerticalAxis]}>
      <div className={styles['project-reorder-overlay']} aria-hidden="true">
        <span className={styles['project-reorder-overlay-icon']} dangerouslySetInnerHTML={{ __html: iconHtml }} />
        <span className={styles['project-reorder-overlay-label']}>{label}</span>
      </div>
    </DragOverlay>,
    document.body,
  )
}

