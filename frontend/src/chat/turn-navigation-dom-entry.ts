import { createTurnNavigationController } from './turn-navigation'
import { mountReactTranscript, mountStaticTranscript, unmountReactTranscript } from './transcript'
import { chatStreamStore, getSessionStream } from './stream-store'
import { mountOuterScrollbar, type OuterScrollbarHandle } from './outer-scrollbar'

const host = document.querySelector<HTMLElement>('#host')!
const scroll = document.querySelector<HTMLElement>('#scroll')!
let controller: ReturnType<typeof createTurnNavigationController> = null
let rail: HTMLElement
let list: HTMLElement
let tooltip: HTMLElement
let navigations: Array<{ index: number; behavior: string }> = []
const inputs: Array<{ type: string; trusted: boolean; button?: number }> = []
let rectReads = 0
let anchorCount = 0
let composerActions = 0
let composer: HTMLInputElement | null = null
let proxy: OuterScrollbarHandle | null = null
let savedContent: Element | null = null

for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'keydown']) {
  document.addEventListener(type, event => inputs.push({ type, trusted: event.isTrusted, button: (event as MouseEvent).button }), true)
}

function addTurn(index: number, nested = false) {
  const user = document.createElement('div')
  user.className = 'msg-group user'
  user.dataset.navTurn = 'true'
  user.innerHTML = `<div class="sent-user-stack"><div class="msg user">Prompt ${index + 1}</div></div>`
  const nativeRect = user.getBoundingClientRect.bind(user)
  user.getBoundingClientRect = () => { rectReads += 1; return nativeRect() }
  const answer = document.createElement('div')
  answer.className = 'assistant-row'
  answer.innerHTML = `<div class="msg assistant" data-nav-answer="true">Final answer ${index + 1}</div><div class="msg-actions">Never preview this action</div>`
  if (nested) {
    const wrapper = document.createElement('section')
    const inner = document.createElement('div')
    inner.append(user, answer)
    wrapper.append(inner)
    ;(scroll.querySelector('[data-klaus-transcript-content]') || scroll).append(wrapper)
  } else (scroll.querySelector('[data-klaus-transcript-content]') || scroll).append(user, answer)
  anchorCount += 1
}

function mount() {
  rail = document.createElement('nav')
  rail.id = 'turn-navigation'
  rail.className = 'turn-navigation'
  list = document.createElement('div')
  list.id = 'turn-navigation-list'
  list.className = 'turn-navigation-list'
  tooltip = document.createElement('div')
  tooltip.id = 'turn-navigation-tooltip'
  tooltip.className = 'turn-navigation-tooltip'
  tooltip.setAttribute('role', 'tooltip')
  rail.append(list, tooltip)
  host.append(rail)
  controller = createTurnNavigationController({ scrollEl: scroll, railEl: rail, listEl: list, tooltipEl: tooltip,
    translate: (_key, fallback) => fallback || '',
    onNavigate(anchor, detail) {
      if (!scroll.contains(anchor)) return false
      navigations.push({ index: detail.index, behavior: detail.behavior })
      const top = scroll.scrollTop + anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12
      scroll.scrollTo({ top: Math.max(0, top), behavior: detail.behavior as ScrollBehavior })
      return true
    },
  })
  controller!.setChatActive(true)
}

async function frames(count = 4) { for (let index = 0; index < count; index += 1) await new Promise<number>(resolve => requestAnimationFrame(resolve)) }
async function reset(count = 20, gutter = 80, nestedLast = false, wrapped = false) {
  proxy?.destroy()
  proxy = null
  composer?.remove()
  composer = null
  composerActions = 0
  controller?.destroy()
  unmountReactTranscript(scroll)
  rail?.remove()
  scroll.replaceChildren()
  scroll.style.setProperty('--fixture-gutter', `${gutter}px`)
  scroll.scrollTop = 0
  anchorCount = 0
  if (wrapped) {
    const content = document.createElement('div')
    content.dataset.klausTranscriptContent = ''
    scroll.append(content)
  }
  for (let index = 0; index < count; index += 1) addTurn(index, nestedLast && index === count - 1)
  navigations = []
  inputs.length = 0
  mount()
  await frames(12)
  return snapshot()
}
function markers() { return Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-turn-index]')) }
function snapshot() {
  const buttons = markers()
  return { hidden: rail.hidden, count: buttons.length, anchorCount, current: buttons.filter(button => button.hasAttribute('aria-current')).map(button => Number(button.dataset.turnIndex)),
    visible: buttons.filter(button => button.hasAttribute('data-visible')).map(button => Number(button.dataset.turnIndex)),
    scrubbing: list.hasAttribute('data-scrubbing'), captures: buttons.filter(button => button.hasPointerCapture(1)).map(button => Number(button.dataset.turnIndex)),
    tooltip: !tooltip.hidden, text: tooltip.textContent, top: scroll.scrollTop, height: scroll.scrollHeight, viewport: scroll.clientHeight,
    focus: buttons.indexOf(document.activeElement as HTMLButtonElement), tabStops: buttons.filter(button => button.tabIndex === 0).length,
    navigations: [...navigations], rectReads, inputs: [...inputs], composerActions,
    contentWrapper: !!scroll.querySelector(':scope > [data-klaus-transcript-content]'),
    turnWrappers: scroll.querySelectorAll('[data-klaus-transcript-turn]').length,
    contentKept: savedContent === scroll.querySelector(':scope > [data-klaus-transcript-content]'),
    proxyRange: host.querySelector<HTMLElement>('.chat-outer-scrollbar > div')?.style.height }
}
async function point(index: number) {
  const button = markers()[index]
  button.scrollIntoView({ block: 'nearest' })
  await frames(3)
  const rect = button.getBoundingClientRect()
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}
function line(index: number) {
  const button = markers()[index]
  const style = getComputedStyle(button, '::before')
  const rect = button.getBoundingClientRect()
  const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform)
  return { width: parseFloat(style.width) * Math.abs(matrix.a), x: rect.x + parseFloat(style.left), hitWidth: rect.width, radius: style.borderRadius, transition: style.transitionDuration }
}
const sessionId = 'navigation-live-fixture'
async function realLive(withProxy = false) {
  await reset(0)
  if (withProxy) {
    proxy = mountOuterScrollbar({ scrollEl: scroll, region: host })
    host.querySelector<HTMLElement>('.chat-outer-scrollbar')!.style.cssText = 'position:absolute;right:0;width:6px;overflow:auto'
    proxy!.sync()
  }
  const history = [0, 1, 2].flatMap(index => [
    { role: 'user', uuid: `history-${index}`, turnId: `turn-${index}`, text: `History prompt ${index + 1}` },
    { role: 'assistant', uuid: `answer-${index}`, turnId: `turn-${index}`, text: `History final ${index + 1}`, phase: 'final_answer' },
  ])
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: {
    ...getSessionStream(sessionId), history, historyLoading: false, historyStale: false,
    running: true, activeTurnId: 'live-turn', liveTurnId: 'live-turn',
    liveUnits: [{ type: 'live-user', key: 'live-user', turnId: 'live-turn', msg: { role: 'user', uuid: 'live-user', text: 'Live fourth prompt' } }],
  } } }))
  mountReactTranscript(sessionId, scroll, { scroll: 'main', readOnly: true })
  await frames(20)
  return { ...snapshot(), nestedLive: scroll.querySelector('[data-uuid="live-user"]')?.parentElement !== scroll }
}
async function handoff() {
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: { ...getSessionStream(sessionId),
    running: false, liveUnits: [], history: [...getSessionStream(sessionId).history!,
      { role: 'user', uuid: 'live-user', turnId: 'live-turn', text: 'Live fourth prompt' },
      { role: 'assistant', uuid: 'live-answer', turnId: 'live-turn', phase: 'final_answer', text: 'Live final answer' }],
  } } }))
  await frames(20)
  return snapshot()
}

async function legacyHistory() {
  await realLive()
  const history = [0, 1, 2, 3].flatMap(index => [
    { role: 'user', uuid: `legacy-${index}`, turnId: `legacy-turn-${index}`, text: `Legacy prompt ${index + 1}` },
    { role: 'assistant', uuid: `legacy-answer-${index}`, turnId: `legacy-turn-${index}`, text: `Legacy final ${index + 1}` },
  ])
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: {
    ...getSessionStream(sessionId), history, liveUnits: [], running: false,
  } } }))
  await frames(20)
  return snapshot()
}

async function finalWithCommentary() {
  await legacyHistory()
  const history = getSessionStream(sessionId).history!.map(message => message.role === 'assistant' ? { ...message, phase: 'final_answer' } : message)
  history.splice(2, 0, { role: 'assistant', uuid: 'late-commentary', turnId: 'legacy-turn-0', phase: 'commentary', text: 'Late commentary must not appear' })
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: { ...getSessionStream(sessionId), history } } }))
  await frames(20)
  return snapshot()
}

async function steeredHistory() {
  await legacyHistory()
  const history = getSessionStream(sessionId).history!.slice()
  history.splice(1, 0, { role: 'user', uuid: 'steered-user', turnId: 'legacy-turn-0', text: 'Steering in the same turn' })
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: { ...getSessionStream(sessionId), history } } }))
  await frames(20)
  const wrapper = scroll.querySelector('[data-uuid="legacy-0"]')!.closest('[data-klaus-transcript-turn]')!
  return { ...snapshot(), firstTurnAnchors: wrapper.querySelectorAll('[data-nav-turn="true"]').length }
}

;(window as any).navFixture = { reset, frames, point, snapshot, line, realLive, handoff, legacyHistory, finalWithCommentary, steeredHistory,
  focus: (index: number) => markers()[index].focus(),
  scroll: (top: number) => { scroll.scrollTop = top },
  resizeLast: () => { scroll.querySelectorAll<HTMLElement>('.assistant-row')[anchorCount - 1].style.height = '784px' },
  readReset: () => { rectReads = 0 },
  append: () => { addTurn(anchorCount); controller!.refresh() },
  removeLast: () => { for (let index = 0; index < 2; index += 1) scroll.lastElementChild?.remove(); anchorCount -= 1; controller!.refresh() },
  removeFirst: () => { for (let index = 0; index < 2; index += 1) scroll.firstElementChild?.remove(); anchorCount -= 1; controller!.refresh() },
  identity: () => { (window as any).savedMarkers = markers(); return markers().length },
  identityKept: () => (window as any).savedMarkers.every((button: HTMLElement, index: number) => markers()[index] === button),
  releaseCapture: () => { for (const button of markers()) if (button.hasPointerCapture(1)) button.releasePointerCapture(1) },
  hideLast: () => { scroll.querySelectorAll<HTMLElement>('[data-nav-turn]')[anchorCount - 1].parentElement!.hidden = true },
  hideAllButFirst: () => { for (const anchor of Array.from(scroll.querySelectorAll<HTMLElement>('[data-nav-turn="true"]')).slice(1)) anchor.hidden = true },
  addCommentary: () => { const element = document.createElement('div'); element.className = 'msg assistant'; element.textContent = 'Commentary must not replace the final reply'; scroll.querySelector('.assistant-row')!.append(element) },
  resizeAt: (index: number, height: number) => { scroll.querySelectorAll<HTMLElement>('.assistant-row')[index].style.height = `${height}px` },
  expectedCurrent: () => {
    const readingLine = scroll.scrollTop + scroll.clientHeight * 0.25
    return Array.from(scroll.querySelectorAll<HTMLElement>('[data-nav-turn="true"]')).reduce((active, anchor, index) =>
      anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop <= readingLine ? index : active, 0)
  },
  saveContent: () => { savedContent = scroll.querySelector(':scope > [data-klaus-transcript-content]') },
  enlargeReactAnswer: () => { scroll.querySelector<HTMLElement>('.msg.assistant[data-nav-answer="true"]')!.style.height = '1200px' },
  mode: async (mode: string) => {
    if (mode === 'unmount') unmountReactTranscript(scroll)
    else if (mode === 'static') mountStaticTranscript(getSessionStream(sessionId).history!, scroll)
    else mountReactTranscript(sessionId, scroll, { scroll: mode as 'main' | 'none', readOnly: true })
    await frames(20)
    return snapshot()
  },
  updateAnswer: () => { scroll.querySelector<HTMLElement>('.msg.assistant[data-nav-answer="true"]')!.firstChild!.nodeValue = 'Fresh answer 1' },
  composerFocus: () => {
    composer = document.createElement('input')
    composer.style.cssText = 'position:absolute;bottom:0;right:0;width:200px'
    composer.addEventListener('keydown', event => { if (event.key === 'Escape') composerActions += 1 })
    host.append(composer)
    composer.focus()
  },
  suspend: () => { const lease = controller!.suspend('fixture'); controller!.resume(lease, 'next-session') },
}
