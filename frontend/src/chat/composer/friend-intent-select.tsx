import { useEffect, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { Icon } from '../../components/Icon'
import type { FriendMessageIntent } from '../../../../shared/friends'

const w = () => window as any
const tt = (key: string): string => w().tt?.(key) || key

export interface FriendIntentSelectState {
  value: FriendMessageIntent
  open: boolean
  disabled: boolean
}

export interface FriendIntentSelectApi {
  setValue(next: FriendMessageIntent): void
  setHidden(hidden: boolean): void
  setDisabled(disabled: boolean): void
  close(): void
}

const INTENTS: FriendMessageIntent[] = ['request', 'notice']

export function friendIntentLabelKey(intent: FriendMessageIntent): string {
  return intent === 'notice' ? 'chat_friend_intent_notice' : 'chat_friend_intent_request'
}

/** The friend message purpose picker. It reuses the composer's shared
 *  dropdown chrome (`.kls-select--flat` trigger plus `.kls-select-panel`
 *  rows) so it reads exactly like the model and permission pickers beside
 *  it. The open state lives in this store and only user actions flip it:
 *  composer refreshes push value/hidden/disabled through the api and must
 *  never tear down an open menu, which is what made the earlier native
 *  `<select>` (whose options were rewritten on every refresh) flicker shut
 *  while the pointer was inside it. */
export function FriendIntentSelectMenu({ store, rootEl, onIntentChange }: {
  store: StoreApi<FriendIntentSelectState>
  rootEl: HTMLElement
  onIntentChange: (intent: FriendMessageIntent) => void
}) {
  const value = useStore(store, s => s.value)
  const open = useStore(store, s => s.open)
  const disabled = useStore(store, s => s.disabled)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const keyboardOpenRef = useRef(false)

  const close = () => store.setState({ open: false })

  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent) => {
      if (event.target instanceof Node && rootEl.contains(event.target)) return
      close()
    }
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && rootEl.contains(event.target)) return
      close()
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKeydown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKeydown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) return
    const panel = panelRef.current
    const place = () => {
      const rect = triggerRef.current!.getBoundingClientRect()
      panel.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`
      panel.style.right = 'auto'
      const above = rect.top - panel.offsetHeight - 4
      panel.style.top = `${above >= 8 ? above : Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - panel.offsetHeight - 8))}px`
    }
    place()
    if (keyboardOpenRef.current) {
      ;(panel.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? panel.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus()
      keyboardOpenRef.current = false
    }
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, value])

  const triggerOpen = () => {
    if (disabled) return
    store.setState({ open: !open })
  }

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="menuitemradio"]')
    if (item && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      if (!item.disabled) item.click()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])
    if (!items.length) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const choose = (intent: FriendMessageIntent) => {
    store.setState({ open: false })
    if (intent !== value) onIntentChange(intent)
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="kls-select-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        aria-label={tt('chat_friend_intent')}
        onClick={triggerOpen}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          keyboardOpenRef.current = true
          if (!open) triggerOpen()
          else panelRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
        }}
      >
        <span className="kls-select-text">{tt(friendIntentLabelKey(value))}</span>
        <Icon name="chevron-down" cls="kls-select-caret" size={12} />
      </button>
      <div
        ref={panelRef}
        className="kls-select-panel friend-intent-panel"
        role="menu"
        aria-label={tt('chat_friend_intent')}
        hidden={!open}
        onKeyDown={onMenuKeyDown}
      >
        {INTENTS.map(intent => (
          <button
            key={intent}
            type="button"
            data-intent={intent}
            className={`kls-select-item${intent === value ? ' is-selected' : ''}`}
            role="menuitemradio"
            aria-checked={intent === value}
            onClick={() => choose(intent)}
          >
            <span className="kls-select-item-copy">
              <span className="kls-select-item-label">{tt(friendIntentLabelKey(intent))}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

const friendIntentRoots = new Map<HTMLElement, Root>()

export function mountFriendIntentSelect(root: HTMLElement | null, options: {
  onIntentChange: (intent: FriendMessageIntent) => void
}): FriendIntentSelectApi | null {
  if (!root) return null
  const store = createStore<FriendIntentSelectState>(() => ({
    value: 'request',
    open: false,
    disabled: false,
  }))
  store.subscribe(state => {
    root.classList.toggle('open', state.open)
    root.classList.toggle('is-disabled', state.disabled)
  })
  let reactRoot = friendIntentRoots.get(root)
  if (!reactRoot) {
    reactRoot = createRoot(root)
    friendIntentRoots.set(root, reactRoot)
  }
  reactRoot.render(<FriendIntentSelectMenu store={store} rootEl={root} onIntentChange={options.onIntentChange} />)
  return {
    setValue(next) { store.setState({ value: next }) },
    setHidden(hidden) {
      root.hidden = hidden
      if (hidden) store.setState({ open: false })
    },
    setDisabled(disabled) { store.setState({ disabled, ...(disabled ? { open: false } : {}) }) },
    close() { store.setState({ open: false }) },
  }
}
