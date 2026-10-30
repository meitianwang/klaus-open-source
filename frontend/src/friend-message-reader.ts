// Full-text reader overlay for long incoming friend messages. A collapsed
// summary answers "what is this about"; this overlay answers "let me read all
// of it" without growing the page: a fixed sheet above dialogs, with search,
// copy and Esc-to-close. One instance per document object, mounted on demand
// by the friends page and the transcript alike.
//
// The body is plain text rendered through textContent — a friend message is
// prose, never trusted markup.

import { findSpecMatches } from './chat/spec-document-model'
import { writeClipboardText } from './clipboard'
import { t } from './i18n'
import { icon } from './icons/registry'
import './friend-message-reader.css'

export interface FriendMessageReaderOptions {
  title: string
  meta: string
  text: string
}

interface ReaderState {
  root: HTMLElement
  body: HTMLElement
  count: HTMLElement
  find: HTMLElement
  input: HTMLInputElement
  matches: HTMLElement[]
  matchIndex: number
  rendered: string
  onClose?: () => void
}

let state: ReaderState | null = null

function buildRoot(owner: Document): HTMLElement {
  const root = owner.createElement('div')
  root.className = 'friend-message-reader'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.innerHTML = `
    <div class="friend-message-reader-sheet">
      <div class="friend-message-reader-head">
        <span class="friend-message-reader-title"></span>
        <span class="friend-message-reader-meta"></span>
        <div class="friend-message-reader-actions">
          <button type="button" data-reader-action="find"></button>
          <button type="button" data-reader-action="copy"></button>
          <button type="button" data-reader-action="close"></button>
        </div>
      </div>
      <div class="friend-message-reader-find" hidden>
        <input type="search" spellcheck="false" />
        <span class="friend-message-reader-count" aria-live="polite">0/0</span>
        <button type="button" data-reader-action="previous">↑</button>
        <button type="button" data-reader-action="next">↓</button>
      </div>
      <div class="friend-message-reader-body"><pre></pre></div>
    </div>`
  return root
}

function syncCount() {
  if (!state) return
  const total = state.matches.length
  state.count.textContent = total && state.matchIndex >= 0 ? `${state.matchIndex + 1}/${total}` : '0/0'
  for (const action of ['previous', 'next']) {
    const control = state.root.querySelector<HTMLButtonElement>(`[data-reader-action="${action}"]`)
    if (control) control.disabled = total === 0
  }
}

function unmark() {
  if (!state) return
  state.matches = []
  state.matchIndex = -1
  state.rendered = ''
}

/** Unwrap every search mark back into plain text so a fresh search starts clean. */
function clearMarks() {
  if (!state) return
  const pre = state.body.querySelector('pre')
  if (pre) {
    pre.querySelectorAll('mark.friend-message-reader-match').forEach(mark => mark.replaceWith(...mark.childNodes))
    pre.normalize()
  }
  unmark()
}

function selectMatch(index: number) {
  if (!state) return
  const total = state.matches.length
  state.matchIndex = total ? (index % total + total) % total : -1
  state.matches.forEach((mark, at) => mark.classList.toggle('is-current', at === state!.matchIndex))
  const target = state.matches[state.matchIndex]
  if (target) {
    const body = state.body
    body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 2
  }
  syncCount()
}

function search() {
  if (!state) return
  const query = state.input.value
  const signature = `${state.body.textContent?.length ?? 0}:${query}`
  if (signature === state.rendered) return
  state.rendered = signature
  const pre = state.body.querySelector('pre')
  if (!pre) return
  clearMarks()
  const text = pre.textContent || ''
  const ranges = findSpecMatches(text, query)
  state.matches = []
  if (!ranges.length) { syncCount(); return }
  // Walk once, splitting forward; offsets stay valid because each split only
  // shortens the node it consumes.
  let node = pre.firstChild as Text | null
  let offset = 0
  let rangeAt = 0
  while (node && rangeAt < ranges.length) {
    const length = node.data.length
    const range = ranges[rangeAt]
    if (range.start >= offset + length) { offset += length; node = node.nextSibling as Text | null; continue }
    const localStart = Math.max(0, range.start - offset)
    const localEnd = Math.min(length, range.end - offset)
    if (localStart > 0) { node.splitText(localStart); offset += localStart; node = node.nextSibling as Text | null; continue }
    const rest = node.splitText(localEnd - localStart)
    const mark = state.root.ownerDocument.createElement('mark')
    mark.className = 'friend-message-reader-match'
    node.replaceWith(mark)
    mark.appendChild(node)
    state.matches.push(mark)
    rangeAt++
    offset += localEnd - localStart
    node = rest
  }
  selectMatch(0)
}

function toggleFind(open: boolean) {
  if (!state) return
  const find = state.find
  find.hidden = !open
  if (open) { state.input.focus(); state.input.select(); search() }
  else {
    state.input.value = ''
    clearMarks()
    syncCount()
  }
}

function close() {
  if (!state) return
  const onClose = state.onClose
  state.root.remove()
  state = null
  onClose?.()
}

function onClick(event: MouseEvent) {
  if (!state) return
  const target = (event.target as Element).closest<HTMLButtonElement>('[data-reader-action]')
  if (!target) {
    // A click on the scrim (outside the sheet) closes, like every overlay here.
    if (!(event.target as Element).closest('.friend-message-reader-sheet')) close()
    return
  }
  const action = target.dataset.readerAction
  if (action === 'close') { close(); return }
  if (action === 'find') { toggleFind(state.find.hidden); return }
  if (action === 'previous' || action === 'next') { selectMatch(state.matchIndex + (action === 'next' ? 1 : -1)); return }
  if (action === 'copy') {
    const text = state.body.querySelector('pre')?.textContent || ''
    void writeClipboardText(text).then(() => {
      target.classList.add('copied')
      setTimeout(() => target.classList.remove('copied'), 1200)
    }).catch(() => undefined)
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (!state) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (!state.find.hidden) toggleFind(false)
    else close()
    return
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    event.stopPropagation()
    toggleFind(true)
  }
}

/**
 * Open (or replace) the reader with one message's full text. Returns a close
 * function so the caller can tear the overlay down when its own surface goes
 * away; calling it twice for the same text is a no-op beyond focus.
 */
export function openFriendMessageReader(options: FriendMessageReaderOptions & { onClose?: () => void }): () => void {
  const owner = document
  if (!state) {
    const root = buildRoot(owner)
    state = {
      root,
      body: root.querySelector('.friend-message-reader-body') as HTMLElement,
      count: root.querySelector('.friend-message-reader-count') as HTMLElement,
      find: root.querySelector('.friend-message-reader-find') as HTMLElement,
      input: root.querySelector('.friend-message-reader-find input') as HTMLInputElement,
      matches: [],
      matchIndex: -1,
      rendered: '',
    }
    root.addEventListener('click', onClick)
    root.querySelector('.friend-message-reader-find input')?.addEventListener('input', search)
    owner.addEventListener('keydown', onKeyDown, true)
    owner.body.appendChild(root)
  }
  state.onClose = options.onClose
  state.root.querySelector('.friend-message-reader-title')!.textContent = options.title
  state.root.querySelector('.friend-message-reader-meta')!.textContent = options.meta
  const pre = state.body.querySelector('pre')!
  pre.textContent = options.text
  state.body.scrollTop = 0
  toggleFind(false)
  const labels: Record<string, string> = { find: 'friend_reader_find', copy: 'copy', close: 'friend_reader_close', previous: 'friend_reader_previous', next: 'friend_reader_next' }
  for (const [action, key] of Object.entries(labels)) {
    const control = state.root.querySelector<HTMLButtonElement>(`[data-reader-action="${action}"]`)
    if (!control) continue
    control.setAttribute('aria-label', t(key))
    control.title = t(key)
    if (action === 'find' || action === 'copy' || action === 'close') control.innerHTML = icon(action === 'find' ? 'search' : action === 'copy' ? 'copy' : 'close')
  }
  state.root.querySelector('.friend-message-reader-find input')?.setAttribute('placeholder', t('friend_reader_find_placeholder'))
  requestAnimationFrame(() => state?.input.focus())
  return close
}

export function friendMessageReaderOpen(): boolean {
  return !!state
}
