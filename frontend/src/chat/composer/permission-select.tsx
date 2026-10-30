import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BypassConfirmDialog } from './bypass-confirm-dialog'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { PermissionPreset } from '../../../../contracts/runtime-settings'
export type { PermissionPreset } from '../../../../contracts/runtime-settings'
import { Icon } from '../../components/Icon'
import { claimOverlay, overlayIdForElement, registerOverlay } from '../../app/overlay-registry'

const w = () => window as any
const tt = (key: string): string => w().tt?.(key) || key

const PRESETS: { value: PermissionPreset; labelKey: string; descKey: string; iconKey: string }[] = [
  { value: 'default', labelKey: 'perm_manual', descKey: 'perm_manual_desc', iconKey: 'permission-request' },
  { value: 'auto', labelKey: 'perm_auto', descKey: 'perm_auto_desc', iconKey: 'permission-review' },
  { value: 'bypassPermissions', labelKey: 'perm_bypass', descKey: 'perm_bypass_desc',       iconKey: 'sys-auth-shield-warn' },
]

/** The preset that lifts the sandbox and every approval prompt. Its menu row
 *  and trigger carry the warning colour so the unlocked state stays visible
 *  after the menu closes, instead of reading like any other preset. */
export function isDangerPermissionPreset(preset: string | null): boolean {
  return preset === 'bypassPermissions'
}

export function PermissionSelectCaret() {
  return <Icon name="chevron-down" cls="kls-select-caret" size={12} />
}

function isPermissionPreset(v: unknown): v is PermissionPreset {
  return v === 'default' || v === 'auto' || v === 'bypassPermissions'
}

export function permissionPresetFromResponse(response: { mode?: unknown; preset?: unknown; effectiveMode?: unknown } | null | undefined): PermissionPreset | null {
  if (response?.effectiveMode === 'read-only') return 'default'
  const value = response && Object.hasOwn(response, 'preset') ? response.preset : response?.mode
  return isPermissionPreset(value) ? value : null
}

interface PermissionSelectState {
  value: PermissionPreset | null
  open: boolean
  unavailable?: boolean
}

export interface PermissionSelectApi {
  close(): void
  setValue(next: PermissionPreset | null): void
  setUnavailable(): void
  refresh(): void
}

// Exported for markup tests: the menu renders without touching the document,
// so a static render is enough to pin its row and trigger classes.
export function PermissionSelectMenu({ store, rootEl, getSessionId }: {
  store: StoreApi<PermissionSelectState>
  rootEl: HTMLElement
  getSessionId: () => string | null
}) {
  const value = useStore(store, s => s.value)
  const open = useStore(store, s => s.open)
  const unavailable = useStore(store, s => s.unavailable === true)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // While the bypass confirmation dialog is up, its clicks bubble to document
  // and would trip the outside-click close below; hold the menu open instead.
  const confirmingRef = useRef(false)
  const [, force] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const mountedRef = useRef(true)
  const keyboardOpenRef = useRef(false)
  const confirmationSessionRef = useRef<string | null | undefined>(undefined)
  // The ref guards the menu's outside-click / Escape / scroll closers during
  // the confirmation dialog. Opening flips it in the same tick as the state;
  // closing defers the flip past the current event dispatch, because the click
  // that answers the dialog is portalled to the body and still bubbles to the
  // document closer — resetting synchronously would shut the menu on cancel.
  const setConfirmingBoth = (next: boolean) => {
    setConfirming(next)
    if (next) confirmingRef.current = true
    else setTimeout(() => { confirmingRef.current = false }, 0)
  }
  ;(store as any).__forceRender = () => force(v => v + 1)
  useEffect(() => {
    mountedRef.current = true
    const changed = () => {
      requestRef.current++
      confirmingRef.current = false
      setConfirming(false)
      setSaving(false)
      setError('')
      store.setState({ open: false })
      force(value => value + 1)
    }
    window.addEventListener('klaus:session-change', changed)
    return () => {
      mountedRef.current = false
      requestRef.current++
      window.removeEventListener('klaus:session-change', changed)
      delete (store as any).__forceRender
    }
  }, [])

  const selectedPreset = PRESETS.find(p => p.value === value)
  const presetLabel = unavailable ? tt('perm_unavailable') : tt(value === 'bypassPermissions' ? 'perm_bypass_short' : selectedPreset?.labelKey ?? 'permission_mode')

  const close = (restoreFocus = false) => {
    store.setState({ open: false })
    if (restoreFocus) triggerRef.current?.focus()
  }

  const applyPreset = async (preset: PermissionPreset) => {
    if (saving || unavailable) return
    const previous = value
    const targetSession = getSessionId()
    const request = ++requestRef.current
    setSaving(true)
    setError('')
    store.setState({ value: preset, open: false })
    try {
      const result = await w().klaus.session.setPermissionMode(preset, targetSession)
      if (result?.ok === false || result?.error) throw new Error(result.error || tt('settings_failed'))
      if (!mountedRef.current || request !== requestRef.current || targetSession !== getSessionId()) return
      triggerRef.current?.focus()
      w().refreshComposerPreferences?.()
      w().refreshSidePermissionButton?.()
    } catch (err) {
      if (!mountedRef.current || request !== requestRef.current || targetSession !== getSessionId()) return
      const message = err instanceof Error ? err.message : String(err)
      store.setState({ value: previous, open: true })
      setError(message || tt('settings_failed'))
      w().showToast?.(message || tt('settings_failed'))
      w().refreshComposerPreferences?.()
    } finally {
      if (mountedRef.current && request === requestRef.current) setSaving(false)
    }
  }

  // Entering the full-access preset stops at a dedicated confirmation dialog:
  // it lifts the sandbox and every approval prompt, so the switch is never one
  // unmarked click. Cancelling keeps the menu open at the previous value.
  const choose = (preset: PermissionPreset) => {
    if (saving || unavailable) return
    if (isDangerPermissionPreset(preset) && value !== preset) {
      confirmationSessionRef.current = getSessionId()
      setConfirmingBoth(true)
      return
    }
    void applyPreset(preset)
  }
  const onBypassDecision = (confirmed: boolean) => {
    setConfirmingBoth(false)
    if (confirmed && confirmationSessionRef.current === getSessionId()) void applyPreset('bypassPermissions')
    else if (confirmationSessionRef.current !== getSessionId()) close()
    confirmationSessionRef.current = undefined
  }

  // Confirmation owns focus and dismissal until the user answers it.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (confirmingRef.current) return
      if (!rootEl.contains(e.target as Node)) close()
    }
    const onKeydown = (e: KeyboardEvent) => {
      if (confirmingRef.current) return
      if (e.key === 'Escape') {
        e.preventDefault()
        close(true)
      } else if (e.key === 'Tab') close(true)
    }
    const onScroll = (e: Event) => {
      if (confirmingRef.current) return
      if (e.target instanceof Node && rootEl.contains(e.target)) return
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
  }, [open, error, value])

  const triggerOpen = () => {
    if (open) { close(); return }
    claimOverlay(overlayIdForElement(rootEl, 'permission-select'))
    setError('')
    store.setState({ open: true })
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

  const menuPanel = (
    <div
      ref={panelRef}
      className="kls-select-panel permission-select-panel"
      role="menu"
      aria-label={tt('perm_menu_title')}
      aria-busy={saving}
      hidden={!open}
      onKeyDown={onMenuKeyDown}
    >
      {PRESETS.map(preset => (
        <button
          key={preset.value}
          type="button"
          data-preset={preset.value}
          className={`kls-select-item${preset.value === value ? ' is-selected' : ''}${isDangerPermissionPreset(preset.value) ? ' is-danger' : ''}`}
          role="menuitemradio"
          aria-checked={preset.value === value}
          disabled={saving || unavailable}
          onClick={() => choose(preset.value)}
        >
          <span className="kls-select-icon"><Icon name={preset.iconKey} size={15} /></span>
          <span className="kls-select-item-copy">
            <span className="kls-select-item-label">{tt(preset.labelKey)}</span>
            <span className="kls-select-item-desc">{tt(preset.descKey)}</span>
          </span>
        </button>
      ))}
      {error && <div className="permission-select-error" role="alert">{error}</div>}
      {unavailable && <div className="permission-select-error" role="alert">{tt('perm_read_error')}{' '}
        <button type="button" className="permission-select-help" onClick={() => {
          w().refreshComposerPreferences?.()
          w().refreshSidePermissionButton?.()
        }}>{tt('auth_status_retry')}</button>
      </div>}
    </div>
  )

  const bypassDialog = confirming
    ? <BypassConfirmDialog onDecision={onBypassDecision} translate={tt} />
    : null

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`kls-select-trigger${isDangerPermissionPreset(value) ? ' is-danger' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={saving}
        disabled={saving}
        onClick={triggerOpen}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          keyboardOpenRef.current = true
          if (!open) triggerOpen()
          else panelRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
        }}
        aria-label={tt('permission_mode')}
      >
        <span className="kls-select-trigger-icon"><Icon name={selectedPreset?.iconKey ?? 'settings-nav-preferences'} size={14} /></span>
        <span className="kls-select-text">{presetLabel}</span>
      </button>
      {menuPanel}
      {bypassDialog}
    </>
  )
}

const permissionSelectRoots = new Map<HTMLElement, Root>()

export function mountPermissionSelect(root: HTMLElement | null, getSessionId: () => string | null = () => w().currentSessionId ?? null): PermissionSelectApi | null {
  if (!root) return null

  const store = createStore<PermissionSelectState>(() => ({
    value: null,
    open: false,
    unavailable: true,
  })) as StoreApi<PermissionSelectState>
  store.subscribe(state => { root.classList.toggle('open', state.open) })
  registerOverlay(overlayIdForElement(root, 'permission-select'), () => {
    store.setState({ open: false })
  })

  let reactRoot = permissionSelectRoots.get(root)
  if (!reactRoot) {
    reactRoot = createRoot(root)
    permissionSelectRoots.set(root, reactRoot)
  }
  reactRoot.render(
    <PermissionSelectMenu store={store} rootEl={root} getSessionId={getSessionId} />,
  )

  return {
    close() { store.setState({ open: false }) },
    setValue(next) {
      store.setState({ value: next, unavailable: false })
      ;(store as any).__forceRender?.()
    },
    setUnavailable() { store.setState({ unavailable: true, open: false }) },
    refresh() {
      ;(store as any).__forceRender?.()
    },
  }
}
