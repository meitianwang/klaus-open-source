import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transpileModule, ScriptTarget } from 'typescript'

const INDEX_HTML = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')
const STYLES_CSS = readFileSync(fileURLToPath(new URL('../../css/styles.css', import.meta.url)), 'utf8')
const ACTION_DOTS_CSS = readFileSync(fileURLToPath(new URL('./action-dots.module.css', import.meta.url)), 'utf8')
const COMPOSER_CSS = readFileSync(fileURLToPath(new URL('./composer/composer.module.css', import.meta.url)), 'utf8')
const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')
const GOAL_TSX = readFileSync(fileURLToPath(new URL('./goals/components.tsx', import.meta.url)), 'utf8')
const QUEUE_TSX = readFileSync(fileURLToPath(new URL('./composer/follow-up-queue.tsx', import.meta.url)), 'utf8')

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('composer status layout', () => {
  test('keeps the queue inside the composer wrapper before the input card', () => {
    const wrapperStart = INDEX_HTML.search(/<div\b[^>]*\bid="input-wrapper"[^>]*>/)
    const queue = INDEX_HTML.indexOf('<div id="follow-up-queue"', wrapperStart)
    const inputArea = INDEX_HTML.indexOf('<div id="input-area">', wrapperStart)
    const wrapperEnd = INDEX_HTML.indexOf('</div>\n\n      <!-- Composer home anchor', wrapperStart)

    expect(wrapperStart).toBeGreaterThanOrEqual(0)
    expect(queue).toBeGreaterThan(wrapperStart)
    expect(queue).toBeLessThan(inputArea)
    expect(inputArea).toBeLessThan(wrapperEnd)
  })

  test('keeps the outer status containers full width with no chrome of their own', () => {
    // The frame moved OUT of the rows and onto `#composer-status-stack` when the
    // stack above the input became one attached card. The rows and their wrappers
    // must stay chrome-free, or every row would sit inside a second box and the
    // stack would read as nested frames.
    const wrapper = cssRule(STYLES_CSS, '#input-wrapper, #side-input-wrapper {')
    const queue = cssRule(STYLES_CSS, '.follow-up-queue {')
    const hiddenQueue = cssRule(STYLES_CSS, '.follow-up-queue[hidden] {')
    const goal = cssRule(STYLES_CSS, '#goal-indicator {')

    expect(wrapper).toContain('max-width: 752px;')
    expect(wrapper).toContain('padding: 0 16px 20px;')
    for (const status of [queue, goal]) {
      expect(status).toContain('width: 100%;')
      // No bottom margin any more: the stack owns the spacing and the join to the
      // input card, so an 8px gap here would re-open the seam the attachment closes.
      expect(status).toContain('margin: 0;')
      expect(status).not.toContain('border:')
      expect(status).not.toContain('border-radius:')
      expect(status).not.toContain('background:')
    }
    expect(queue).not.toContain('max-width:')
    expect(queue).not.toContain('padding:')
    expect(hiddenQueue).toContain('display: none !important;')
  })

  test('one attached stack frames everything above the input and tucks under the card', () => {
    // The reason these assertions changed: the rows above the
    // composer live in ONE `data-composer-rail` container that draws the top and
    // sides of a card, leaves its bottom edge open and tucks under the input, so the
    // stack and the composer read as a single surface. Klaus previously gave each
    // row its own bordered card with an 8px gap, which read as widgets floating over
    // the transcript. The stack now owns the frame; the rows own nothing.
    const stack = cssRule(STYLES_CSS, '.composer-status-stack {')
    expect(stack).toContain('border: none;')
    expect(cssRule(STYLES_CSS, '.composer-status-stack::before {')).toContain('border: 1px solid var(--border);')

    expect(stack).toContain('border-radius: 8px 8px 0 0;')
    // Decorative borders do not add a second row to the tucked join.
    expect(stack).toContain('margin: 0 14px -24px;')
    expect(stack).toContain('overflow: clip;')

    // An empty stack reserves nothing. This is CSS rather than a JS class because the
    // queue sets its own `hidden` from a React effect and the goal row is added and
    // removed, so a JS mirror of that state would race both.
    expect(STYLES_CSS).toContain('.composer-status-stack:not(:has(> :not([hidden]))) { display: none; }')

    // Rows are frame-less and separated by 1px, which is what makes the stack read as
    // one card with dividers instead of a pile of cards.
    const separator = cssRule(STYLES_CSS, '.composer-status-stack > :not(:first-child),')
    expect(separator).toContain('border-top: 1px solid')
    const shell = cssRule(STYLES_CSS, '.composer-status-card,\n.composer-status-row {')
    expect(shell).toContain('background: transparent;')
    expect(shell).not.toContain('border:')
    expect(shell).not.toContain('border-radius:')

    // The input keeps its ordinary corner radius in front of the inset status rail.
    expect(STYLES_CSS).toContain('#input-wrapper:has(#composer-status-stack > :not([hidden])) #input-area,')
    expect(STYLES_CSS).toContain('#side-input-wrapper:has(#side-composer-status-stack > :not([hidden])) #side-input-area {')
    const attachedInput = cssRule(STYLES_CSS, '#input-wrapper:has(#composer-status-stack > :not([hidden])) #input-area,')
    expect(attachedInput).not.toContain('border-radius:')
    expect(cssRule(STYLES_CSS, '#input-area, #side-input-area {')).toContain('border-radius: var(--radius-sm);')

    // Only required questions replace the ordinary input and join its status stack.


    // The goal card is a string-markup consumer of the shared row shape, so it must
    // keep naming it. Without this the two surfaces silently stop sharing a contract.
    expect(GOAL_TSX).toContain('goal-indicator-card composer-status-card')
    // The queue component composes the shared classes rather than private ones.
    expect(QUEUE_TSX).toContain("'composer-status-row'")
    expect(QUEUE_TSX).toContain('composer-status-rail follow-up-queue-inner')
  })

  test('the row menu escapes the masked scroll list through a portal', () => {
    // The row's overflow menu is `position: fixed` and positioned from viewport
    // coordinates. Fixed escapes `overflow` clipping but NOT a mask: the list's
    // edge fade (`mask-image` on `.follow-up-queue-inner`) clips the paint of the
    // whole subtree, fixed descendants included. Measured in headless Chrome: a
    // menu opening above the list's top edge painted nowhere and
    // `elementFromPoint` at its centre hit the row behind it, so clicking the
    // trigger looked like nothing happened. An earlier version of this test
    // claimed the mask was harmless because the menu "stayed at viewport
    // coordinates" — coordinates were never the failure mode, paint was. The
    // defence is that the panel renders through a portal into `document.body`,
    // where no ancestor's mask, overflow or containing block can reach it; these
    // assertions are what keep it from moving back into the row.
    expect(QUEUE_TSX).toContain('createPortal(panel, document.body)')
    expect(QUEUE_TSX).toContain('className="follow-up-menu-panel"')
    const inner = cssRule(STYLES_CSS, '.follow-up-queue-inner {')
    expect(inner).toContain('mask-image:')
    expect(inner).not.toContain('backdrop-filter')
    expect(STYLES_CSS).toContain('position: fixed;')
  })

  test('row controls stay hover-revealed except the one the row is waiting on', () => {
    const action = cssRule(STYLES_CSS, '.composer-status-action,\n.composer-status-icon-action {')
    expect(action).toContain('opacity: 0;')
    const primary = cssRule(STYLES_CSS, '.composer-status-action.is-primary {')
    expect(primary).toContain('opacity: 1;')
    expect(STYLES_CSS).toContain('.composer-status-row:hover .composer-status-action,')
    expect(STYLES_CSS).toContain('.composer-status-action:focus-visible,')
    // The queue's own module no longer carries a second copy of these rules.
    expect(COMPOSER_CSS).not.toContain('.follow-up-queue-actions')
    expect(COMPOSER_CSS).not.toContain('.follow-up-queue-item')
  })

  test('the queue list is height-capped, edge-faded and scrollable', () => {
    const inner = cssRule(STYLES_CSS, '.follow-up-queue-inner {')
    expect(inner).toContain('max-height: 30dvh;')
    expect(inner).toContain('overflow-y: auto;')
    expect(inner).toContain('mask-image:')
    // Rows animate through a grid-rows slot so draining does not jump.
    const slot = cssRule(STYLES_CSS, '.follow-up-queue-slot {')
    expect(slot).toContain('grid-template-rows: 1fr;')
    expect(cssRule(STYLES_CSS, '.follow-up-queue-slot[data-state="leaving"] {')).toContain('grid-template-rows: 0fr;')
  })

  test('dragging needs a real gesture and only the vertical axis matters', () => {
    // A row that dragged on any press made the action buttons feel unreliable, and
    // a horizontal sweep has no meaning in a single-column list. Both guards live in
    // the component, so they are pinned there rather than in CSS.
    expect(QUEUE_TSX).toContain('DRAG_THRESHOLD_PX = 6')
    expect(QUEUE_TSX).toContain('export function dragActive(')
    expect(QUEUE_TSX).toContain('data-follow-up-grip')
    // Reordering is offered only once there is something to reorder against.
    expect(QUEUE_TSX).toContain('const reorderable = live.length > 1 && live.every(')
  })

  test('reserves a layout row for composer status', () => {
    const actionDots = cssRule(ACTION_DOTS_CSS, '.action-dots {')
    expect(actionDots).not.toContain('position: absolute;')
    expect(actionDots).not.toContain('top: -40px;')
    expect(INDEX_HTML).toContain('<div class="composer-activity-rail">')
    expect(INDEX_HTML).toContain('<div class="composer-content">')
    expect(CHAT_TS).toContain("const queue = inputWrapperEl.querySelector('#follow-up-queue')")
    const start = CHAT_TS.indexOf('function syncComposerStatusOrder() {')
    const end = CHAT_TS.indexOf('\n}', start) + 2
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    type StatusNode = { id: string; parentElement: unknown; readonly nextSibling: StatusNode | null }
    const nodes = new Map<string, StatusNode>()
    let order: StatusNode[] = [], moves = 0
    const cancel = {}, focused: { value: object | null } = { value: cancel }
    const content = { insertBefore(row: StatusNode, anchor: StatusNode) {
      order = order.filter(node => node !== row)
      order.splice(order.indexOf(anchor), 0, row)
      moves++
      focused.value = null
    } }
    const row = (id: string): StatusNode => {
      const node: StatusNode = { id, parentElement: content, get nextSibling() { return order[order.indexOf(node) + 1] ?? null } }
      nodes.set(id, node)
      return node
    }
    const goal = row('goal-indicator'), spec = row('spec-banner'), queue = row('follow-up-queue')
    order = [goal, spec, queue]
    const source = transpileModule(CHAT_TS.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
    const synchronize = new Function('document', 'inputWrapperEl', `${source}; return syncComposerStatusOrder`)(
      { getElementById: (id: string) => nodes.get(id) }, { querySelector: () => queue },
    ) as () => void
    synchronize()
    expect(moves).toBe(0)
    expect(focused.value).toBe(cancel)
    order = [goal, queue, spec]
    synchronize()
    expect(order.map(node => node.id)).toEqual(['goal-indicator', 'spec-banner', 'follow-up-queue'])
    moves = 0; focused.value = cancel
    synchronize()
    expect(moves).toBe(0)
    expect(focused.value).toBe(cancel)
  })

  test('the side composer keeps its own queue island instead of dropping it', () => {
    // A side chat keeps its own queue mount while main workflow controls are removed.
    expect(CHAT_TS).not.toContain('#side-action-dots-host, #side-follow-up-queue')
    // The clone copied the main island's rendered DOM, so it is emptied before the
    // side mount renders it fresh; leaving it would freeze a copy of the main queue.
    expect(CHAT_TS).toContain("clone.querySelector<HTMLElement>('#side-follow-up-queue')?.replaceChildren()")
    expect(CHAT_TS).toContain('sideFollowUpQueueApi = mountFollowUpQueue(sideFollowUpQueueEl')
    // Bound to the side conversation, not the main one: a side row must never act on
    // the main queue. And the side-chat menu entry is dropped, since opening a side
    // chat from a side chat is not a thing the product does.
    expect(CHAT_TS).toContain('() => sideSurfaceSessionId,')
    expect(CHAT_TS).toContain('{ offerSideChat: false }')
    // Every side-session change repaints, or the reused composer shows the previous
    // side chat's rows.
    for (const hook of ['window.klausSideSurfaceActivate', 'window.klausSideSurfaceRemove', 'window.klausSideSurfaceClear']) {
      const start = CHAT_TS.indexOf(hook)
      expect(start).toBeGreaterThan(0)
      expect(CHAT_TS.slice(start, start + 2000)).toContain('renderSideFollowUpQueue()')
    }
  })

  test('the side composer can queue while its turn runs, like the main one', () => {
    // Enter is the follow-up path while running; the button follows the same
    // rule as the main composer (submit face once the composer holds
    // content, stop face while it is empty). Without the Enter split the side
    // island could never be filled.
    expect(CHAT_TS).toContain('sideSubmit({ followUp: true, invert: e.metaKey || e.ctrlKey })')
    expect(CHAT_TS).toContain('await sideSubmitRunningFollowUp(sid, options.replay === true ? false : options.invert === true)')
    expect(CHAT_TS).toContain("followUpModeHelper.resolveSubmitAction(followUpQueueMode, invert)")
  })

  test('the side send button stops only with an empty composer, and an empty Enter still stops', () => {
    // Two regressions this split could introduce, both silent and both destructive:
    // the button never stopping (so a side turn could not be stopped at all), and an
    // empty Enter becoming a follow-up (so pressing Enter to stop would send a stray
    // empty message instead). The button hands over to submit ONLY while the
    // composer holds content; with an empty composer the click still stops, and the
    // follow-up branch inside sideSubmit additionally requires non-empty content, so
    // an empty Enter (which passes followUp) falls through to the stop.
    expect(CHAT_TS).toContain('if (running && !stopping && hasContent) sideSubmit({ followUp: true })')
    expect(CHAT_TS).toContain('else sideSubmit()')
    expect(CHAT_TS).toContain('if ((value || sidePendingFiles.length > 0) && options.followUp) {')
    // The stop path is reached when either condition fails.
    const stopBranch = CHAT_TS.slice(
      CHAT_TS.indexOf('if ((value || sidePendingFiles.length > 0) && options.followUp) {'),
      CHAT_TS.indexOf('if ((value || sidePendingFiles.length > 0) && options.followUp) {') + 900,
    )
    expect(stopBranch).toContain('requestTurnStop(sid)')
    // The side button mirrors the main one's face while running with content.
    expect(CHAT_TS).toContain('const runningSubmit = !!running && !stopping && !empty')
    expect(CHAT_TS).toContain("sideSend.classList.toggle('running-submit', runningSubmit)")
  })
})

describe('composer attachment layout', () => {
  test('caps the preview item itself to the visible chip width', () => {
    const row = cssRule(STYLES_CSS, '#previews, #side-previews {')
    const item = cssRule(STYLES_CSS, '.kls-attach-item {')
    const quote = cssRule(COMPOSER_CSS, '.quote-preview-item {')

    expect(row).toContain('gap: 8px;')
    expect(item).toContain('max-width: min(240px, 100%);')
    expect(quote).toContain('max-width: min(262px, 100%);')
  })
})
