// Guest-mode account sign-in from inside the workbench (sidebar user menu).
//
// A guest has no cloud session to end, so the menu's destructive "Logout" row
// is replaced by an account sign-in entry. The sign-in runs IN PLACE: the host
// opens the browser authorize page and polls it, while the workbench — and any
// turn running in it — stays untouched. Success arrives as the regular
// `klausAuth:updated` broadcast (the host writes credentials, clears the guest
// marker and marks inference config stale for the NEXT turn), so a running
// turn keeps its bound provider and the menu simply re-renders as signed in.
//
// Unlike the boot login screen this path never shrinks the window or hides
// the app (`klausAuth:loginWindow` is not called): a guest with work on screen
// must not lose sight of it while authorizing in the browser.
//
// The row-visibility rules live in a pure reducer so they are unit-testable;
// initGuestSignin owns the DOM and the IPC wiring.

import { writeClipboardText } from '../../clipboard'
import { accountLoginErrorText } from '../account-login-error'

export interface GuestSigninState {
  /** The running user has no Klaus account (host status.loggedIn === false). */
  guest: boolean
  /** A browser sign-in started from the menu is in flight. */
  waiting: boolean
  /** Browser authorize URL pushed by klausAuth:loginPending while waiting. */
  pendingUrl: string
}

export const initialGuestSigninState: GuestSigninState = { guest: false, waiting: false, pendingUrl: '' }

export interface GuestSigninRows {
  /** Separator + sign-in row: guests only. */
  login: boolean
  /** While waiting the row is a status, not an action. */
  loginDisabled: boolean
  loginLabelKey: 'menu_login' | 'menu_login_waiting'
  /** Self-help when the browser never opened: only with a URL in hand. */
  copyLink: boolean
  cancel: boolean
  /** Signed-in users keep the destructive row; guests have nothing to end. */
  logout: boolean
}

export function guestSigninRows(state: GuestSigninState): GuestSigninRows {
  const waiting = state.guest && state.waiting
  return {
    login: state.guest,
    loginDisabled: waiting,
    loginLabelKey: waiting ? 'menu_login_waiting' : 'menu_login',
    copyLink: waiting && state.pendingUrl !== '',
    cancel: waiting,
    logout: !state.guest,
  }
}

export interface GuestSigninDeps {
  /** i18n lookup, injected so this module stays loadable without the window-bound app/i18n. */
  t(key: string): string
  status(): Promise<{ loggedIn?: boolean } | null | undefined>
  login(): Promise<{ ok?: boolean; error?: string } | null>
  cancelLogin(): Promise<unknown>
  onLoginPending(cb: (payload: { url?: string }) => void): void
  onAuthUpdated(cb: (payload: { user?: unknown }) => void): void
  toast(message: string): void
}

interface GuestSigninDom {
  sep: HTMLElement | null
  login: HTMLButtonElement | null
  loginLabel: HTMLElement | null
  copy: HTMLButtonElement | null
  copyLabel: HTMLElement | null
  cancel: HTMLButtonElement | null
  logoutSep: HTMLElement | null
  logout: HTMLButtonElement | null
}

function queryDom(): GuestSigninDom {
  const login = document.getElementById('menu-login') as HTMLButtonElement | null
  const copy = document.getElementById('menu-login-copy') as HTMLButtonElement | null
  return {
    sep: document.getElementById('menu-login-sep'),
    login,
    loginLabel: login?.querySelector('span[data-i18n], span:last-of-type') ?? null,
    copy,
    copyLabel: copy?.querySelector('span[data-i18n], span:last-of-type') ?? null,
    cancel: document.getElementById('menu-login-cancel') as HTMLButtonElement | null,
    logoutSep: document.getElementById('menu-logout-sep'),
    logout: document.getElementById('menu-logout') as HTMLButtonElement | null,
  }
}

export function renderGuestSigninRows(state: GuestSigninState): void {
  const dom = queryDom()
  const rows = guestSigninRows(state)
  if (dom.sep) dom.sep.hidden = !rows.login
  if (dom.login) {
    dom.login.hidden = !rows.login
    dom.login.disabled = rows.loginDisabled
    // The label is driven here (not by applyI18n) because it doubles as the
    // in-flight status; init strips its data-i18n so language switches do not
    // overwrite a live waiting copy.
    if (dom.loginLabel) dom.loginLabel.textContent = translate(rows.loginLabelKey)
  }
  if (dom.copy) dom.copy.hidden = !rows.copyLink
  if (dom.cancel) dom.cancel.hidden = !rows.cancel
  if (dom.logoutSep) dom.logoutSep.hidden = !rows.logout
  if (dom.logout) dom.logout.hidden = !rows.logout
}

let state: GuestSigninState = { ...initialGuestSigninState }
let deps: GuestSigninDeps | null = null
let copyResetTimer: ReturnType<typeof setTimeout> | null = null
// Identity until init injects the real lookup; renders before init (none in
// practice) then show raw keys instead of crashing on a missing window.
let translate: (key: string) => string = (key) => key

function set(next: Partial<GuestSigninState>): void {
  state = { ...state, ...next }
  renderGuestSigninRows(state)
}

/** Re-read the host auth status and re-render the menu rows. */
export async function syncGuestSigninUi(): Promise<void> {
  if (!deps) return
  try {
    const status = await deps.status()
    set({ guest: status?.loggedIn !== true })
  } catch {
    // An IPC hiccup must not flip a signed-in user's menu into guest mode;
    // keep whatever the last authoritative read said.
    renderGuestSigninRows(state)
  }
}

export async function startGuestSignin(): Promise<void> {
  if (!deps || state.waiting) return
  set({ waiting: true, pendingUrl: '' })
  const res = await deps.login()
  // On success the klausAuth:updated handler already flipped guest off.
  set({ waiting: false, pendingUrl: '' })
  if (res?.ok) return
  // The user's own cancel is not an error: settle back to the idle row.
  if (res?.error === 'login cancelled') return
  deps.toast(translate('login_failed_prefix') + accountLoginErrorText(res?.error, translate))
}

async function copyPendingLink(): Promise<void> {
  const dom = queryDom()
  if (!state.pendingUrl || !dom.copy || !dom.copyLabel) return
  try {
    await writeClipboardText(state.pendingUrl)
  } catch { return }
  const done = translate('login_copy_link_done')
  const original = translate('login_copy_link')
  dom.copyLabel.textContent = done
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    // Only restore while the row still means "copy"; a state change re-renders.
    if (guestSigninRows(state).copyLink && dom.copyLabel) dom.copyLabel.textContent = original
  }, 1600)
}

export function initGuestSignin(injected: GuestSigninDeps): void {
  deps = injected
  translate = injected.t
  const dom = queryDom()
  // The waiting copy is state-driven, so the static i18n binding must not
  // fight it on language switches.
  dom.loginLabel?.removeAttribute('data-i18n')
  dom.copyLabel?.removeAttribute('data-i18n')
  renderGuestSigninRows(state)

  dom.login?.addEventListener('click', (e) => {
    // Keep the menu open: the waiting rows live inside it.
    e.stopPropagation()
    void startGuestSignin()
  })
  dom.copy?.addEventListener('click', (e) => {
    e.stopPropagation()
    void copyPendingLink()
  })
  dom.cancel?.addEventListener('click', (e) => {
    e.stopPropagation()
    // The in-flight login promise resolves as cancelled and resets the rows.
    void deps?.cancelLogin()
  })

  // The labels are state-driven (data-i18n stripped above), so a language
  // switch must re-render them like bootstrapProfile does for the name row.
  window.addEventListener('klaus:lang-change', () => renderGuestSigninRows(state))

  deps.onLoginPending(({ url }) => {
    if (state.waiting) set({ pendingUrl: url || '' })
  })
  deps.onAuthUpdated(({ user }) => {
    set(user ? { guest: false, waiting: false, pendingUrl: '' } : { guest: true, waiting: false, pendingUrl: '' })
  })
}
