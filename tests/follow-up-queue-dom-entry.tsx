import vectors from '../contracts/vectors/follow-up-queue-vectors.json'
import type { FollowUpQueueApi, FollowUpQueueHandlers, FollowUpRow } from '../frontend/src/chat/composer/follow-up-queue'

const w = window as any
w.currentLang = 'en'
const labels: Record<string, string> = {
  follow_up_send_now: 'Steer', follow_up_send_now_tooltip: 'Submit without interrupting the model',
  follow_up_retry: 'Retry', follow_up_retry_tooltip: 'Try sending this queued message again',
  follow_up_retry_tooltip_detail: 'Edit or delete it if retry keeps failing', follow_up_paused_hint: 'Retry, edit, or delete it to continue',
  follow_up_more: 'Queued message actions', follow_up_edit_message: 'Edit message', follow_up_open_in_side_chat: 'Open in side chat',
  follow_up_turn_on_queueing: 'Turn on queueing', follow_up_turn_off_queueing: 'Turn off queueing', follow_up_delete: 'Delete',
  follow_up_resume: 'Resume', follow_up_sending: 'Sending', follow_up_full_preview: 'Full queued message',
  follow_up_preview: 'Preview queued message', follow_up_preview_close: 'Close preview', follow_up_close_preview: 'Close preview',
  follow_up_unconfirmed: 'Delivery has not been confirmed. Check the conversation before deleting this message.',
}
w.tt = (key: string) => labels[key] ?? key

type FixtureRow = FollowUpRow & { unconfirmed?: boolean }
type Action = { action: string; id?: string; beforeId?: string | null }
type PointerInput = { type: 'mouseMove' | 'mouseDown' | 'mouseUp'; x: number; y: number; button?: 'left'; clickCount?: number; movementX?: number; movementY?: number }
const results: string[] = []
const actions: Action[] = []
let api: FollowUpQueueApi
let rows: FixtureRow[] = []
let sessionId = vectors.sessionId
let banner: string | null = null
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => unknown, label: string, timeout = 5000) {
  const start = Date.now()
  while (!check()) { if (Date.now() - start > timeout) throw Error(`Timed out: ${label}`); await settle(15) }
}
function assert(value: unknown, label: string): asserts value { if (!value) throw Error(label); results.push(label) }
const find = <T extends HTMLElement = HTMLElement,>(selector: string): T => {
  const element = document.querySelector<T>(selector)
  if (!element) throw Error(`Missing ${selector}`)
  return element
}
const queueRow = (id = 'queued-one') => find(`[data-follow-up-id="${CSS.escape(id)}"]`)
const action = (name: string, id = 'queued-one') => queueRow(id).querySelector<HTMLButtonElement>(`[data-follow-up-action="${name}"]`)
const previewTrigger = (id = 'queued-one') => find<HTMLButtonElement>(`[data-follow-up-id="${CSS.escape(id)}"] [data-follow-up-preview]`)
const fullPreview = () => document.querySelector<HTMLElement>('.follow-up-full-preview')
const menu = () => document.querySelector<HTMLElement>('.follow-up-menu-panel')
const menuItems = () => Array.from(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])
const center = (element: Element) => {
  const rect = element.getBoundingClientRect()
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
}
const makeRow = (id: string, preview: string, overrides: Partial<FixtureRow> = {}): FixtureRow => ({
  id, preview, summary: '', summaryOnly: false, thumbnail: null,
  mutationPending: false, paused: false, pausedTitle: '', pausedDetail: '', dispatching: false, ...overrides,
})
function paint(next: FixtureRow[], nextBanner: string | null = null, nextSession = sessionId) {
  rows = next
  banner = nextBanner
  sessionId = nextSession
  api.render(rows, banner, true, sessionId)
}
async function render(next: FixtureRow[], nextBanner: string | null = null, nextSession = sessionId) {
  paint(next, nextBanner, nextSession)
  await settle(vectors.transitionMs + 70)
}
async function native(request: { key?: string; shift?: boolean; capture?: string; cropQueue?: boolean; width?: number; height?: number; pointer?: PointerInput[] }) {
  await new Promise<void>((resolve, reject) => { w.queueNativeDone = resolve; w.queueNativeFail = reject; w.queueNativeRequest = request })
  await settle(40)
}
async function closePreview() {
  if (!fullPreview()) return
  await native({ key: 'Escape' })
  await until(() => !fullPreview(), 'preview closes with Escape')
}
async function openMenu(id = 'queued-one') {
  const trigger = action('more', id)
  if (!trigger) throw Error('Missing overflow trigger')
  trigger.focus()
  trigger.click()
  await until(() => menu(), 'menu opens')
  return trigger
}
function inViewport(element: Element) {
  const rect = element.getBoundingClientRect()
  return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1
}
const handlers: FollowUpQueueHandlers = {
  onResume() { actions.push({ action: 'resume' }) },
  onDeliver(id) { actions.push({ action: 'deliver', id }) },
  onEdit(id) { actions.push({ action: 'edit', id }) },
  onDelete(id) { actions.push({ action: 'delete', id }) },
  onOpenInSideChat(id) { actions.push({ action: 'side-chat', id }) },
  onToggleQueueing() { actions.push({ action: 'toggle-queueing' }) },
  onReorder(id, beforeId) {
    actions.push({ action: 'reorder', id, beforeId })
    const moved = rows.find(row => row.id === id)
    if (!moved) return
    const next = rows.filter(row => row.id !== id)
    const index = beforeId === null ? next.length : next.findIndex(row => row.id === beforeId)
    if (index < 0) return
    next.splice(index, 0, moved)
    paint(next, banner)
  },
}

async function run() {
  const { mountFollowUpQueue } = await import('../frontend/src/chat/composer/follow-up-queue')
  api = mountFollowUpQueue(find('#follow-up-queue'), handlers)!
  assert(!!api, 'Actual queue component mounts in the composer status stack')
  const first = makeRow('queued-one', vectors.rawText)
  const second = makeRow('queued-two', vectors.secondText)
  const third = makeRow('queued-three', vectors.thirdText)
  await render([first])
  assert(!find('#follow-up-queue').hidden, 'A queued request makes the attached status stack visible')
  assert(JSON.stringify(Array.from(queueRow().querySelectorAll('[data-follow-up-action]')).map(element => element.getAttribute('data-follow-up-action'))) === JSON.stringify(vectors.expectedActionOrder), 'Row actions are ordered steer, delete, and overflow')
  assert(!!action('send-now')?.querySelector('svg'), 'Steer displays its directional icon beside the label')
  assert(previewTrigger().tagName === 'BUTTON' && !!(previewTrigger().getAttribute('aria-label') || previewTrigger().textContent?.trim()), 'Preview is a named keyboard-accessible button')
  assert(!queueRow().querySelector('[data-follow-up-grip]'), 'A single queued request has no reorder handle')
  assert(inViewport(queueRow()) && queueRow().getBoundingClientRect().height < 64, 'Compact request stays inside the composer and occupies one row')
  await native({ capture: 'queue-light' })

  find('#fixture-outside').focus()
  await native({ pointer: [{ type: 'mouseMove', x: 4, y: 4 }] })
  const hover = center(previewTrigger())
  await native({ pointer: [{ type: 'mouseMove', ...hover }] })
  await settle(250)
  assert(!fullPreview(), 'Hover does not open the full preview before the delay')
  await until(() => fullPreview(), 'delayed hover preview', vectors.hoverDelayMs + 1000)
  assert(fullPreview()!.textContent?.includes(vectors.rawText), 'Expanded preview preserves all original lines and literal markup')
  assert(!fullPreview()!.querySelector('strong,em,code'), 'Full preview presents raw request text without markdown formatting')
  const raw = fullPreview()!.querySelector<HTMLElement>('pre,[data-follow-up-full-text],.follow-up-full-preview-text') || fullPreview()!
  const range = document.createRange()
  range.selectNodeContents(raw)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  assert(getSelection()!.toString().includes(vectors.rawText), 'Full preview contents can be selected without truncation')
  getSelection()!.removeAllRanges()
  assert(inViewport(fullPreview()!), 'Expanded preview fits the desktop viewport')
  await native({ capture: 'queue-preview' })
  await closePreview()
  assert(document.activeElement === previewTrigger(), 'Escape returns preview focus to the original row trigger')
  find('#fixture-outside').focus()
  await native({ pointer: [{ type: 'mouseMove', x: 4, y: 4 }] })
  previewTrigger().focus()
  await until(() => fullPreview(), 'focus opens eligible preview immediately', 350)
  assert(!!fullPreview(), 'Keyboard focus opens the eligible full preview without a hover delay')
  await native({ key: 'Tab' })
  assert(document.activeElement === fullPreview(), 'Tab enters the nonmodal preview from its trigger')
  await native({ key: 'Tab', shift: true })
  assert(document.activeElement === previewTrigger(), 'Shift Tab returns from preview to its trigger')
  await native({ key: 'Tab' })
  await native({ key: 'Tab' })
  await until(() => !fullPreview(), 'Tab leaves preview')
  assert(document.activeElement === action('send-now'), 'Forward Tab continues with the next row action')
  find('#fixture-outside').focus()
  previewTrigger().click()
  await until(() => fullPreview(), 'click opens eligible preview', 350)
  assert(!!fullPreview(), 'Click opens the full queued request')
  await closePreview()

  const menuTrigger = await openMenu()
  await until(() => menuItems()[0] === document.activeElement, 'menu focuses first item')
  assert(JSON.stringify(menuItems().map(element => element.getAttribute('data-follow-up-action'))) === JSON.stringify(vectors.expectedMenuActions), 'Overflow menu exposes edit, side chat, and queueing preference')
  await native({ key: 'ArrowDown' })
  assert(document.activeElement === menuItems()[1], 'Arrow Down moves menu focus to the next action')
  await native({ key: 'ArrowUp' })
  assert(document.activeElement === menuItems()[0], 'Arrow Up moves menu focus to the previous action')
  await native({ key: 'End' })
  assert(document.activeElement === menuItems().at(-1), 'End moves menu focus to its last action')
  await native({ key: 'Home' })
  assert(document.activeElement === menuItems()[0], 'Home moves menu focus to its first action')
  await native({ key: 'Tab' })
  assert(document.activeElement === menuItems()[0] && !!menu(), 'Menu keeps Tab inside its roving keyboard navigation')
  await native({ capture: 'queue-menu' })
  await native({ key: 'Escape' })
  await until(() => !menu(), 'Escape closes menu')
  assert(document.activeElement === menuTrigger, 'Escape restores overflow-trigger focus')
  await openMenu()
  const outside = center(find('#fixture-outside'))
  await native({ pointer: [{ type: 'mouseMove', ...outside }, { type: 'mouseDown', ...outside, button: 'left', clickCount: 1 }, { type: 'mouseUp', ...outside, button: 'left', clickCount: 1 }] })
  await until(() => !menu(), 'outside pointer closes menu')
  assert(!menu(), 'Pointer interaction outside the menu dismisses it')
  await openMenu()
  await native({ key: 'Enter' })
  await until(() => !menu(), 'menu action closes menu')
  assert(actions.at(-1)?.action === 'edit' && actions.at(-1)?.id === first.id, 'Keyboard activation edits the queued request identified by its row')
  action('send-now')!.click()
  assert(actions.at(-1)?.action === 'deliver' && actions.at(-1)?.id === first.id, 'Steer forwards the queued request identity')
  action('delete')!.click()
  assert(actions.at(-1)?.action === 'delete' && actions.at(-1)?.id === first.id, 'Delete forwards the queued request identity')

  await render([first], vectors.interruptedBanner)
  assert(document.querySelector('.follow-up-queue-banner')?.textContent?.includes(vectors.interruptedBanner), 'Interrupted queue displays its explanatory header')
  find<HTMLButtonElement>('[data-follow-up-action="resume-queue"]').click()
  assert(actions.at(-1)?.action === 'resume', 'Resume invokes the queue-level recovery action')
  await native({ capture: 'queue-interrupted' })
  await render([makeRow('queued-one', vectors.rawText, { mutationPending: true }), makeRow('queued-two', vectors.secondText, { unconfirmed: true }), makeRow('queued-three', vectors.thirdText, { dispatching: true })])
  assert(Array.from(queueRow().querySelectorAll<HTMLButtonElement>('[data-follow-up-action]')).every(button => button.disabled), 'Pending mutation disables every row action')
  assert(action('send-now', 'queued-two')?.disabled && action('more', 'queued-two')?.disabled && action('delete', 'queued-two')?.disabled === false, 'Unknown delivery permits deletion while disabling resend and edit')
  assert(!action('send-now', 'queued-three') && !action('more', 'queued-three') && action('delete', 'queued-three')?.disabled, 'In-flight delivery hides steer and overflow and disables deletion')
  assert(queueRow('queued-three').textContent?.includes('Sending') && !!queueRow('queued-three').querySelector('svg'), 'In-flight delivery exposes a spinner and accessible Sending status')
  assert(!document.querySelector('[data-follow-up-grip]:not([disabled]):not([aria-disabled="true"])'), 'In-flight or mutation-pending queue cannot be reordered')
  const sendingLabel = queueRow('queued-three').querySelector<HTMLElement>('[role="status"]')!
  assert(getComputedStyle(sendingLabel).position === 'absolute' && sendingLabel.getBoundingClientRect().width <= 1,
    'Sending status is announced without occupying visible row space')
  await native({ capture: 'queue-delivery-states' })

  await render([first])
  await openMenu()
  await render([makeRow('queued-other', vectors.secondText)], null, vectors.otherSessionId)
  assert(!menu() && !fullPreview(), 'Changing conversations closes the previous row menu and preview')
  await render([first], null, vectors.sessionId)
  previewTrigger().focus()
  await until(() => fullPreview(), 'preview before conversation change')
  await render([makeRow('queued-other', vectors.secondText)], null, vectors.otherSessionId)
  assert(!fullPreview(), 'Changing conversations also closes a full text preview')

  await render([first, second, third], null, vectors.sessionId)
  assert(document.querySelectorAll('[data-follow-up-grip]').length === 3, 'Multiple editable requests expose sortable handles')
  const start = center(find('[data-follow-up-id="queued-one"] [data-follow-up-grip]'))
  const target = center(queueRow('queued-three'))
  await native({ pointer: [
    { type: 'mouseMove', ...start }, { type: 'mouseDown', ...start, button: 'left', clickCount: 1 },
    { type: 'mouseMove', x: start.x, y: start.y + 3, movementY: 3 },
  ] })
  assert(!actions.some(value => value.action === 'reorder'), 'A pointer tremor below the activation threshold does not reorder')
  await native({ pointer: [
    { type: 'mouseMove', x: start.x, y: start.y + 12, movementY: 9 },
    { type: 'mouseMove', x: start.x, y: target.y, movementY: target.y - start.y - 12 },
    { type: 'mouseUp', x: start.x, y: target.y, button: 'left', clickCount: 1 },
  ] })
  await until(() => actions.some(value => value.action === 'reorder'), 'trusted pointer reorder')
  await settle(vectors.transitionMs + 100)
  assert(JSON.stringify(rows.map(row => row.id)) === JSON.stringify(vectors.reorderedIds), 'Trusted pointer drag moves a request into the selected queue slot')
  const reorder = actions.find(value => value.action === 'reorder')!
  assert(reorder.id === 'queued-one' && reorder.beforeId === null, 'Sortable gesture forwards the moved identity and end anchor')
  await render([makeRow('engine:owned', vectors.thirdText, { readOnly: true }), first, second])
  assert(!document.querySelector('[data-follow-up-grip]:not([disabled]):not([aria-disabled="true"])'), 'Mixed ownership disables sorting rather than moving rows across owners')

  await render([first, second])
  document.documentElement.dataset.theme = 'dark'
  await native({ capture: 'queue-dark' })
  assert(getComputedStyle(find('#composer-status-stack')).backgroundColor !== 'rgb(255, 255, 255)', 'Queue frame follows the dark theme')
  for (const width of [760, 400]) {
    await native({ width, height: 560, capture: `queue-narrow-${width}` })
    assert(document.documentElement.scrollWidth <= innerWidth + 1 && inViewport(queueRow()), `${width}px composer has no document overflow`)
    await openMenu()
    assert(inViewport(menu()!), `${width}px overflow menu stays inside the viewport`)
    await native({ key: 'Escape' })
    await until(() => !menu(), 'narrow menu closes')
    find('#fixture-outside').focus()
    previewTrigger().focus()
    await until(() => fullPreview(), 'narrow preview opens')
    assert(inViewport(fullPreview()!), `${width}px full preview stays inside the viewport`)
    await closePreview()
  }
  document.documentElement.dataset.theme = 'light'
  labels.follow_up_send_now = '引导'
  find('#fixture-shell').style.padding = '20px 15px 20px 9px'
  await render([makeRow('localized', '注意是指 klaus app 里的会话')])
  await native({ width: 761, height: 560, capture: 'queue-localized', cropQueue: true })
  await render([])
  assert(find('#follow-up-queue').hidden, 'Draining the final row removes the empty status stack from layout')
  w.followUpQueueResults = { passed: results.length, results, actions }
}
w.followUpQueueReady = run().catch(error => { w.followUpQueueError = String(error?.stack ?? error); w.followUpQueueResults = { passed: results.length, results, actions }; throw error })
