// Boot login screen, shared browser sign-in flow, and identity KV seeding.
//
// Fresh installs (neither `klaus-auth.json` nor `klaus-guest-mode` on disk) land
// on `#login-screen` in a compact 900x600 window; users either sign in through
// the browser or choose "Continue as guest" (`klausAuth.guestEnter`) to persist
// the guest marker and enter the workbench. Guests who later decide to sign in
// from inside the workbench use `sidebar/guest-signin.ts`, which shares
// `beginAccountLogin()` without shrinking the window or disturbing active turns.
// Auto-update UI lives in `app/update`.

import { loadDesktopDistribution, desktopServiceUrl } from '../app/distribution'
import { writeClipboardText } from '../clipboard'
import { t as tt } from '../i18n'
import { serializeIdentityWrite } from '../pages/profile/identity-store'
import { accountLoginErrorText } from './account-login-error'
import { startLoginVisual, stopLoginVisual } from './login-visual'

export interface KlausUser {
  displayName?: string
  email?: string
  avatarUrl?: string
}

interface KlausAuthApi {
  klausAuth?: {
    login: () => Promise<{ ok?: boolean; error?: string; user?: KlausUser } | null>
    cancelLogin?: () => Promise<unknown>
    guestEnter?: () => Promise<{ ok?: boolean; error?: string } | null>
    loginWindow?: (active: boolean) => Promise<unknown>
  }
  settings: {
    kv: {
      set: (key: string, value: string) => Promise<unknown>
    }
  }
  on?: {
    klausAuthLoginPending?: (cb: (payload: { url?: string }) => void) => unknown
    klausAuthUpdated?: (cb: (payload: { user?: KlausUser | null }) => void) => unknown
  }
}

export interface AuthScreenDeps {
  /** Initializes (if needed) and reveals the workbench after sign-in or guest entry. */
  enterWorkbench: () => Promise<void>
}

interface LoginDom {
  bootScreen: HTMLElement | null
  loginScreen: HTMLElement | null
  appEl: HTMLElement | null
  loginBtn: HTMLButtonElement | null
  loginBtnLabel: HTMLElement | null
  loginErrorEl: HTMLElement | null
  loginHelpEl: HTMLElement | null
  loginCopyLinkBtn: HTMLButtonElement | null
  loginCancelBtn: HTMLButtonElement | null
  loginGuestBtn: HTMLButtonElement | null
  loginLangBtn: HTMLButtonElement | null
  loginLangLabel: HTMLElement | null
  loginLangMenu: HTMLElement | null
}

const klausApi = (): KlausAuthApi | undefined =>
  (window as unknown as { klaus?: KlausAuthApi }).klaus

function queryDom(): LoginDom {
  return {
    bootScreen: document.getElementById('boot-screen'),
    loginScreen: document.getElementById('login-screen'),
    appEl: document.getElementById('app'),
    loginBtn: document.getElementById('login-btn') as HTMLButtonElement | null,
    loginBtnLabel: document.getElementById('login-btn-label'),
    loginErrorEl: document.getElementById('login-error'),
    loginHelpEl: document.getElementById('login-help'),
    loginCopyLinkBtn: document.getElementById('login-copy-link') as HTMLButtonElement | null,
    loginCancelBtn: document.getElementById('login-cancel') as HTMLButtonElement | null,
    loginGuestBtn: document.getElementById('login-guest') as HTMLButtonElement | null,
    loginLangBtn: document.getElementById('login-lang-btn') as HTMLButtonElement | null,
    loginLangLabel: document.getElementById('login-lang-label'),
    loginLangMenu: document.getElementById('login-lang-menu'),
  }
}

let authDeps: AuthScreenDeps | null = null
let loginScreenOpen = false
let loginBusy = false
let loginRetry = false
let pendingLoginUrl = ''
let copyResetTimer: ReturnType<typeof setTimeout> | null = null
let boundRoot: HTMLElement | null = null
let globalListenersBound = false

export function hideBootScreen(): void {
  const { bootScreen } = queryDom()
  if (!bootScreen || bootScreen.dataset.hidden === '1') return
  bootScreen.dataset.hidden = '1'
  bootScreen.classList.add('hiding')
  setTimeout(() => {
    bootScreen.style.display = 'none'
  }, 220)
}

export function isLoginScreenVisible(): boolean {
  const { loginScreen } = queryDom()
  return !!loginScreen && !loginScreen.hidden && loginScreen.style.display !== 'none'
}

function setLoginMessage(message: string): void {
  const { loginErrorEl } = queryDom()
  if (!loginErrorEl) return
  loginErrorEl.classList.remove('show')
  if (!message) {
    loginErrorEl.textContent = ''
    return
  }
  loginErrorEl.textContent = message
  loginErrorEl.classList.add('show')
}

function syncLoginControls(): void {
  const dom = queryDom()
  if (dom.loginBtn) {
    dom.loginBtn.disabled = loginBusy
    dom.loginBtn.classList.toggle('waiting', loginBusy)
  }
  if (dom.loginBtnLabel) {
    dom.loginBtnLabel.textContent = loginBusy
      ? tt('login_waiting')
      : loginRetry
        ? tt('login_retry')
        : tt('login_btn')
  }
  // Self-help actions (copy link / cancel) apply only while browser sign-in is
  // in flight; keep `#login-help` invisible when idle so `#login-guest` stays
  // anchored on the right of `.login-footer`.
  if (dom.loginHelpEl) dom.loginHelpEl.style.visibility = loginBusy ? 'visible' : 'hidden'
  if (dom.loginCopyLinkBtn) {
    dom.loginCopyLinkBtn.style.display = loginBusy && pendingLoginUrl ? '' : 'none'
    if (!copyResetTimer) dom.loginCopyLinkBtn.textContent = tt('login_copy_link')
  }
  if (dom.loginCancelBtn) dom.loginCancelBtn.style.display = loginBusy ? '' : 'none'
  if (dom.loginGuestBtn) dom.loginGuestBtn.style.display = loginBusy ? 'none' : ''
}

function syncLoginLangLabel(): void {
  const { loginLangLabel } = queryDom()
  if (!loginLangLabel) return
  const cur = (window as unknown as { currentLang?: string }).currentLang || document.documentElement.lang || 'en'
  loginLangLabel.textContent = cur === 'zh' ? '中文' : 'English'
}

export function showLoginScreen(): void {
  const dom = queryDom()
  if (!dom.loginScreen) return
  hideBootScreen()
  const applyI18n = (window as unknown as { applyI18n?: () => void }).applyI18n
  if (typeof applyI18n === 'function') applyI18n()
  loginBusy = false
  loginRetry = false
  pendingLoginUrl = ''
  if (copyResetTimer) {
    clearTimeout(copyResetTimer)
    copyResetTimer = null
  }
  setLoginMessage('')
  syncLoginControls()
  syncLoginLangLabel()
  dom.loginLangMenu?.classList.add('hidden')
  dom.loginScreen.hidden = false
  dom.loginScreen.style.display = 'flex'
  if (dom.appEl) dom.appEl.style.visibility = 'hidden'
  if (!loginScreenOpen) {
    loginScreenOpen = true
    void klausApi()?.klausAuth?.loginWindow?.(true)?.catch?.(() => {})
  }
  startLoginVisual()
  void loadDesktopDistribution()
}

export function hideLoginScreen(): void {
  const dom = queryDom()
  hideBootScreen()
  stopLoginVisual()
  loginBusy = false
  loginRetry = false
  pendingLoginUrl = ''
  if (copyResetTimer) {
    clearTimeout(copyResetTimer)
    copyResetTimer = null
  }
  dom.loginLangMenu?.classList.add('hidden')
  if (dom.loginScreen) {
    dom.loginScreen.hidden = true
    dom.loginScreen.style.display = 'none'
  }
  if (dom.appEl) dom.appEl.style.visibility = ''
  if (loginScreenOpen) {
    loginScreenOpen = false
    void klausApi()?.klausAuth?.loginWindow?.(false)?.catch?.(() => {})
  }
}

async function enterWorkbenchFromLogin(): Promise<void> {
  hideLoginScreen()
  await authDeps?.enterWorkbench()
}

// Shared account sign-in kernel: opens the browser authorization page and polls
// the host until completion or cancellation. Used by both `#login-screen` and
// `sidebar/guest-signin.ts`.
export async function beginAccountLogin(): Promise<{ ok?: boolean; error?: string; user?: KlausUser } | null> {
  try {
    return (await klausApi()?.klausAuth?.login()) ?? null
  } catch (err) {
    return { ok: false, error: (err as Error | null)?.message || String(err) }
  }
}

async function startLoginFromScreen(): Promise<void> {
  if (loginBusy) return
  setLoginMessage('')
  loginBusy = true
  loginRetry = false
  pendingLoginUrl = ''
  syncLoginControls()
  await loadDesktopDistribution()
  const res = await beginAccountLogin()
  if (res?.ok) {
    if (res.user) await seedIdentityKv(res.user)
    await enterWorkbenchFromLogin()
    return
  }
  if (!isLoginScreenVisible()) return
  loginBusy = false
  pendingLoginUrl = ''
  if (res?.error === 'login cancelled') {
    loginRetry = false
    syncLoginControls()
    return
  }
  loginRetry = true
  syncLoginControls()
  setLoginMessage(tt('login_failed_prefix') + accountLoginErrorText(res?.error, tt))
}

async function enterAsGuest(): Promise<void> {
  const { loginGuestBtn } = queryDom()
  if (loginBusy || loginGuestBtn?.disabled) return
  if (loginGuestBtn) loginGuestBtn.disabled = true
  setLoginMessage('')
  try {
    const res = await klausApi()?.klausAuth?.guestEnter?.()
    if (res && res.ok === false) {
      setLoginMessage(tt('login_failed_prefix') + (res.error || ''))
      return
    }
    await enterWorkbenchFromLogin()
  } catch (err) {
    setLoginMessage(tt('login_failed_prefix') + ((err as Error | null)?.message || String(err)))
  } finally {
    const btn = queryDom().loginGuestBtn
    if (btn) btn.disabled = false
  }
}

async function copyPendingLoginUrl(): Promise<void> {
  const { loginCopyLinkBtn } = queryDom()
  if (!pendingLoginUrl || !loginCopyLinkBtn) return
  try {
    await writeClipboardText(pendingLoginUrl)
  } catch {
    return
  }
  loginCopyLinkBtn.textContent = tt('login_copy_link_done')
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    copyResetTimer = null
    if (loginBusy && pendingLoginUrl) {
      const btn = queryDom().loginCopyLinkBtn
      if (btn) btn.textContent = tt('login_copy_link')
    }
  }, 1600)
}

// Writes cloud profile fields (displayName/email/avatarUrl) into local KV for
// `bootstrapProfile`. Invoked on boot when signed in and on `klausAuth:updated`.
export async function seedIdentityKv(user: KlausUser | null | undefined): Promise<void> {
  if (!user) return
  return serializeIdentityWrite(async () => {
    try {
      await loadDesktopDistribution()
      const kv = klausApi()?.settings.kv
      if (!kv) return
      if (user.displayName) await kv.set('display_name', user.displayName)
      await kv.set('email', user.email || '')
      if (user.avatarUrl) {
        const url = user.avatarUrl.startsWith('http')
          ? user.avatarUrl
          : desktopServiceUrl(user.avatarUrl)
        await kv.set('avatar_data_url', url)
      } else {
        await kv.set('avatar_data_url', '')
      }
    } catch {
      /* kv best-effort */
    }
  })
}

function bindLoginDomControls(): void {
  const dom = queryDom()
  if (!dom.loginScreen || boundRoot === dom.loginScreen) return
  boundRoot = dom.loginScreen

  // State-driven labels must not be overwritten by static `applyI18n()` passes
  // when the user switches languages mid-wait or on retry.
  dom.loginBtnLabel?.removeAttribute('data-i18n')
  dom.loginCopyLinkBtn?.removeAttribute('data-i18n')
  syncLoginControls()
  syncLoginLangLabel()

  dom.loginBtn?.addEventListener('click', () => {
    if (dom.loginBtn?.disabled) return
    void startLoginFromScreen()
  })
  dom.loginGuestBtn?.addEventListener('click', () => {
    void enterAsGuest()
  })
  dom.loginCopyLinkBtn?.addEventListener('click', () => {
    void copyPendingLoginUrl()
  })
  dom.loginCancelBtn?.addEventListener('click', () => {
    void klausApi()?.klausAuth?.cancelLogin?.()
  })
  dom.loginLangBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    queryDom().loginLangMenu?.classList.toggle('hidden')
  })
  dom.loginLangMenu?.addEventListener('click', (e) => {
    e.stopPropagation()
    const opt = (e.target as Element | null)?.closest?.('button[data-lang]') as HTMLElement | null
    if (!opt) return
    const lang = opt.dataset.lang
    queryDom().loginLangMenu?.classList.add('hidden')
    if (!lang) return
    const setLanguage = (window as unknown as { setLanguage?: (code: string) => void }).setLanguage
    if (typeof setLanguage === 'function') setLanguage(lang)
    document.documentElement.lang = lang
    syncLoginLangLabel()
    syncLoginControls()
    void klausApi()?.settings.kv.set('language', lang)?.catch?.(() => {})
  })
}

export function initAuthScreen(deps?: AuthScreenDeps): void {
  if (deps) authDeps = deps
  const w = window as unknown as Record<string, unknown>
  w.seedIdentityKv = seedIdentityKv
  w.showLoginScreen = showLoginScreen
  w.hideLoginScreen = hideLoginScreen

  bindLoginDomControls()

  if (!globalListenersBound) {
    globalListenersBound = true
    document.addEventListener('click', () => {
      queryDom().loginLangMenu?.classList.add('hidden')
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') queryDom().loginLangMenu?.classList.add('hidden')
    })
    window.addEventListener('klaus:lang-change', () => {
      syncLoginLangLabel()
      syncLoginControls()
    })

    klausApi()?.on?.klausAuthLoginPending?.(({ url }) => {
      if (!loginBusy || !isLoginScreenVisible()) return
      pendingLoginUrl = url || ''
      syncLoginControls()
    })

    klausApi()?.on?.klausAuthUpdated?.(async ({ user }) => {
      if (user) {
        await seedIdentityKv(user)
        const bootstrapProfile = (window as unknown as { bootstrapProfile?: () => Promise<void> }).bootstrapProfile
        if (typeof bootstrapProfile === 'function') await bootstrapProfile()
        if (isLoginScreenVisible()) {
          await enterWorkbenchFromLogin()
        }
      } else {
        showLoginScreen()
      }
    })
  }
}
