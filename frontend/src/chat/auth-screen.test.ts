import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { I18N as MESSAGES } from '../i18n/messages'
import {
  hideLoginScreen,
  initAuthScreen,
  isLoginScreenVisible,
  showLoginScreen,
  type KlausUser,
} from './auth-screen'

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const stylesCss = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8')

type Listener = (event?: any) => void

class FakeClassList {
  private readonly set = new Set<string>()

  constructor(initial: string[] = []) {
    for (const cls of initial) if (cls) this.set.add(cls)
  }

  add(...tokens: string[]) {
    for (const t of tokens) if (t) this.set.add(t)
  }

  remove(...tokens: string[]) {
    for (const t of tokens) this.set.delete(t)
  }

  toggle(token: string, force?: boolean): boolean {
    if (force === true) {
      this.set.add(token)
      return true
    }
    if (force === false) {
      this.set.delete(token)
      return false
    }
    if (this.set.has(token)) {
      this.set.delete(token)
      return false
    }
    this.set.add(token)
    return true
  }

  contains(token: string): boolean {
    return this.set.has(token)
  }
}

class FakeElement {
  id = ''
  hidden = false
  disabled = false
  textContent = ''
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  classList: FakeClassList
  private readonly attrs = new Map<string, string>()
  private readonly listeners = new Map<string, Listener[]>()
  parent: FakeElement | null = null

  constructor(id = '', classes: string[] = [], attrs: Record<string, string> = {}) {
    this.id = id
    this.classList = new FakeClassList(classes)
    for (const [k, v] of Object.entries(attrs)) {
      this.attrs.set(k, v)
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
        this.dataset[camel] = v
      }
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatch(type: string, payload: Record<string, unknown> = {}): void {
    const event = {
      type,
      target: payload.target ?? this,
      stopPropagation() {},
      preventDefault() {},
      ...payload,
    }
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event)
    }
  }

  click(): void {
    this.dispatch('click', { target: this })
  }

  closest(selector: string): FakeElement | null {
    if (selector === 'button[data-lang]') {
      let cur: FakeElement | null = this
      while (cur) {
        if (cur.dataset.lang) return cur
        cur = cur.parent
      }
    }
    return null
  }
}

interface HarnessState {
  elements: Map<string, FakeElement>
  langOptEn: FakeElement
  langOptZh: FakeElement
  loginWindowCalls: boolean[]
  guestEnterCalls: number
  cancelLoginCalls: number
  kvWrites: Array<[string, string]>
  enterWorkbenchCalls: number
  bootstrapProfileCalls: number
  loginImpl: () => Promise<{ ok?: boolean; error?: string; user?: KlausUser } | null>
  guestEnterImpl: () => Promise<{ ok?: boolean; error?: string } | null>
  emitPending: (url: string) => void
  emitAuthUpdated: (user: KlausUser | null) => Promise<void>
}

const prevWindow = (globalThis as any).window
const prevDocument = (globalThis as any).document

let harness!: HarnessState

function buildFakeDom(): HarnessState {
  const elements = new Map<string, FakeElement>()
  const add = (el: FakeElement) => {
    if (el.id) elements.set(el.id, el)
    return el
  }

  const boot = add(new FakeElement('boot-screen', ['boot-screen']))
  boot.style.display = 'flex'

  const loginScreen = add(new FakeElement('login-screen', ['login-screen'], { 'data-klaus-native-suspend': '' }))
  loginScreen.hidden = true
  loginScreen.style.display = 'none'

  const appEl = add(new FakeElement('app'))
  appEl.style.visibility = 'hidden'

  add(new FakeElement('login-btn'))
  add(new FakeElement('login-btn-label', [], { 'data-i18n': 'login_btn' }))
  const spinner = add(new FakeElement('login-btn-spinner', ['login-btn-spinner']))
  spinner.style.display = 'none'
  const errEl = add(new FakeElement('login-error', ['login-error']))
  errEl.style.display = 'none'
  const helpEl = add(new FakeElement('login-help', ['login-help']))
  helpEl.style.display = 'none'
  add(new FakeElement('login-copy-link', ['login-link'], { 'data-i18n': 'login_copy_link' }))
  add(new FakeElement('login-cancel', ['login-link']))
  add(new FakeElement('login-guest', ['login-link', 'login-guest']))
  add(new FakeElement('login-lang-btn', ['login-lang-trigger']))
  const langLabel = add(new FakeElement('login-lang-label'))
  langLabel.textContent = 'English'
  const langMenu = add(new FakeElement('login-lang-menu', ['login-lang-menu', 'hidden']))
  const langOptEn = new FakeElement('', [], { 'data-lang': 'en' })
  langOptEn.parent = langMenu
  const langOptZh = new FakeElement('', [], { 'data-lang': 'zh' })
  langOptZh.parent = langMenu

  return {
    elements,
    langOptEn,
    langOptZh,
    loginWindowCalls: [],
    guestEnterCalls: 0,
    cancelLoginCalls: 0,
    kvWrites: [],
    enterWorkbenchCalls: 0,
    bootstrapProfileCalls: 0,
    loginImpl: async () => ({ ok: true }),
    guestEnterImpl: async () => ({ ok: true }),
    emitPending: () => {},
    emitAuthUpdated: async () => {},
  }
}

beforeAll(() => {
  const docListeners = new Map<string, Listener[]>()
  const winListeners = new Map<string, Listener[]>()
  let pendingCb: ((payload: { url?: string }) => void) | null = null
  let updatedCb: ((payload: { user?: KlausUser | null }) => Promise<void> | void) | null = null

  harness = buildFakeDom()

  const fakeDoc = {
    hidden: false,
    documentElement: {
      lang: 'en',
      getAttribute(name: string) {
        return name === 'data-reduced-motion' ? 'true' : null
      },
    },
    getElementById(id: string) {
      return harness.elements.get(id) ?? null
    },
    addEventListener(type: string, cb: Listener) {
      const list = docListeners.get(type) ?? []
      list.push(cb)
      docListeners.set(type, list)
    },
    dispatchEvent(event: { type: string; key?: string }) {
      for (const cb of docListeners.get(event.type) ?? []) cb(event)
      return true
    },
  }

  const fakeWin: Record<string, any> = {
    currentLang: 'en',
    t(key: string) {
      const lang = fakeWin.currentLang === 'zh' ? 'zh' : 'en'
      return (MESSAGES[lang] as Record<string, string>)[key] ?? key
    },
    setLanguage(lang: string) {
      fakeWin.currentLang = lang
      for (const cb of winListeners.get('klaus:lang-change') ?? []) cb({ type: 'klaus:lang-change' })
    },
    bootstrapProfile: async () => {
      harness.bootstrapProfileCalls += 1
    },
    addEventListener(type: string, cb: Listener) {
      const list = winListeners.get(type) ?? []
      list.push(cb)
      winListeners.set(type, list)
    },
    klaus: {
      klausAuth: {
        login: () => harness.loginImpl(),
        cancelLogin: async () => {
          harness.cancelLoginCalls += 1
        },
        guestEnter: async () => {
          harness.guestEnterCalls += 1
          return harness.guestEnterImpl()
        },
        loginWindow: async (active: boolean) => {
          harness.loginWindowCalls.push(active)
        },
      },
      settings: {
        kv: {
          set: async (key: string, value: string) => {
            harness.kvWrites.push([key, value])
          },
        },
      },
      on: {
        klausAuthLoginPending: (cb: (payload: { url?: string }) => void) => {
          pendingCb = cb
        },
        klausAuthUpdated: (cb: (payload: { user?: KlausUser | null }) => Promise<void> | void) => {
          updatedCb = cb
        },
      },
    },
  }

  ;(globalThis as any).document = fakeDoc
  ;(globalThis as any).window = fakeWin

  initAuthScreen({
    enterWorkbench: async () => {
      harness.enterWorkbenchCalls += 1
    },
  })

  const bindCallbacks = () => {
    harness.emitPending = (url: string) => pendingCb?.({ url })
    harness.emitAuthUpdated = async (user: KlausUser | null) => {
      await updatedCb?.({ user })
    }
  }
  bindCallbacks()
})

beforeEach(() => {
  hideLoginScreen()
  const prevEmitPending = harness.emitPending
  const prevEmitAuthUpdated = harness.emitAuthUpdated
  harness = buildFakeDom()
  harness.emitPending = prevEmitPending
  harness.emitAuthUpdated = prevEmitAuthUpdated
  ;(globalThis as any).window.currentLang = 'en'
  ;(globalThis as any).document.documentElement.lang = 'en'
  initAuthScreen({
    enterWorkbench: async () => {
      harness.enterWorkbenchCalls += 1
    },
  })
})

afterAll(() => {
  if (prevWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = prevWindow
  if (prevDocument === undefined) delete (globalThis as any).document
  else (globalThis as any).document = prevDocument
})

describe('boot login screen static contract', () => {
  test('index.html ships #login-screen hidden by default with sign-in, guest, language, and native-overlay suspend markers', () => {
    expect(indexHtml).toContain('id="login-screen"')
    expect(indexHtml).toContain('data-klaus-native-suspend')
    expect(indexHtml).toContain('id="login-btn"')
    expect(indexHtml).toContain('id="login-guest"')
    expect(indexHtml).toContain('id="login-lang-btn"')
    expect(indexHtml).toContain('id="login-copy-link"')
    expect(indexHtml).toContain('id="login-cancel"')
    expect(indexHtml).toContain('id="login-visual-canvas"')
    expect(stylesCss).toMatch(/\.login-screen\s*\{/)
    expect(stylesCss).toMatch(/\.login-screen\[hidden\]\s*\{\s*display:\s*none;\s*\}/)
  })

  test('every login screen i18n key resolves in both English and Chinese', () => {
    const keys = [
      'login_welcome_title',
      'login_welcome_subtitle',
      'login_welcome_desc',
      'login_btn',
      'login_waiting',
      'login_help_hint',
      'login_guest_btn',
      'login_retry',
      'login_copy_link',
      'login_copy_link_done',
      'login_cancel',
    ] as const
    for (const key of keys) {
      expect(MESSAGES.en[key]).toBeTruthy()
      expect(MESSAGES.zh[key]).toBeTruthy()
    }
  })
})

describe('boot login screen runtime behavior', () => {
  test('fresh-install boot opens #login-screen, sizes loginWindow(true) once, and keeps #app hidden', () => {
    showLoginScreen()
    showLoginScreen()

    const screen = harness.elements.get('login-screen')!
    const app = harness.elements.get('app')!
    const boot = harness.elements.get('boot-screen')!

    expect(isLoginScreenVisible()).toBe(true)
    expect(screen.hidden).toBe(false)
    expect(screen.style.display).toBe('flex')
    expect(app.style.visibility).toBe('hidden')
    expect(boot.classList.contains('hiding')).toBe(true)
    expect(harness.loginWindowCalls).toEqual([true])
    expect(harness.enterWorkbenchCalls).toBe(0)
  })

  test('clicking Continue as guest persists guest mode, restores window bounds, and enters the workbench', async () => {
    showLoginScreen()
    harness.elements.get('login-guest')!.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(harness.guestEnterCalls).toBe(1)
    expect(isLoginScreenVisible()).toBe(false)
    expect(harness.elements.get('login-screen')!.hidden).toBe(true)
    expect(harness.elements.get('login-screen')!.style.display).toBe('none')
    expect(harness.elements.get('app')!.style.visibility).toBe('')
    expect(harness.loginWindowCalls).toEqual([true, false])
    expect(harness.enterWorkbenchCalls).toBe(1)
  })

  test('browser sign-in exposes waiting controls, handles cancel cleanly, surfaces retry on error, and transitions on success', async () => {
    showLoginScreen()

    let resolveLogin!: (value: { ok?: boolean; error?: string; user?: KlausUser } | null) => void
    harness.loginImpl = () =>
      new Promise((resolve) => {
        resolveLogin = resolve
      })

    harness.elements.get('login-btn')!.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(harness.elements.get('login-btn')!.disabled).toBe(true)
    expect(harness.elements.get('login-btn')!.classList.contains('waiting')).toBe(true)
    expect(harness.elements.get('login-btn-label')!.textContent).toBe(MESSAGES.en.login_waiting)
    expect(harness.elements.get('login-guest')!.style.display).toBe('none')
    expect(harness.elements.get('login-help')!.style.visibility).toBe('visible')
    expect(harness.elements.get('login-cancel')!.style.display).toBe('')
    expect(harness.elements.get('login-copy-link')!.style.display).toBe('none')

    harness.emitPending('https://example.com/desktop-authorize')
    expect(harness.elements.get('login-copy-link')!.style.display).toBe('')

    harness.elements.get('login-cancel')!.click()
    expect(harness.cancelLoginCalls).toBe(1)
    resolveLogin({ ok: false, error: 'login cancelled' })
    await new Promise((r) => setTimeout(r, 0))

    expect(harness.elements.get('login-btn')!.disabled).toBe(false)
    expect(harness.elements.get('login-btn')!.classList.contains('waiting')).toBe(false)
    expect(harness.elements.get('login-btn-label')!.textContent).toBe(MESSAGES.en.login_btn)
    expect(harness.elements.get('login-error')!.classList.contains('show')).toBe(false)
    expect(harness.elements.get('login-help')!.style.visibility).toBe('hidden')
    expect(harness.elements.get('login-guest')!.style.display).toBe('')

    harness.loginImpl = async () => ({ ok: false, error: 'login_timed_out' })
    harness.elements.get('login-btn')!.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(harness.elements.get('login-btn-label')!.textContent).toBe(MESSAGES.en.login_retry)
    expect(harness.elements.get('login-error')!.classList.contains('show')).toBe(true)
    expect(harness.elements.get('login-error')!.textContent).toContain(MESSAGES.en.login_timed_out)

    harness.loginImpl = async () => {
      await harness.emitAuthUpdated({ displayName: 'Ada', email: 'ada@example.com' })
      return { ok: true, user: { displayName: 'Ada', email: 'ada@example.com' } }
    }
    harness.elements.get('login-btn')!.click()
    await new Promise((r) => setTimeout(r, 10))

    expect(isLoginScreenVisible()).toBe(false)
    expect(harness.loginWindowCalls).toEqual([true, false])
    expect(harness.kvWrites).toContainEqual(['display_name', 'Ada'])
    expect(harness.kvWrites).toContainEqual(['email', 'ada@example.com'])
    expect(harness.enterWorkbenchCalls).toBeGreaterThanOrEqual(1)
  })

  test('logout broadcast returns to #login-screen and language switching updates waiting labels', async () => {
    await harness.emitAuthUpdated(null)
    expect(isLoginScreenVisible()).toBe(true)
    expect(harness.loginWindowCalls).toEqual([true])

    harness.elements.get('login-lang-btn')!.click()
    expect(harness.elements.get('login-lang-menu')!.classList.contains('hidden')).toBe(false)

    harness.elements.get('login-lang-menu')!.dispatch('click', { target: harness.langOptZh })
    await new Promise((r) => setTimeout(r, 0))

    expect(harness.elements.get('login-lang-menu')!.classList.contains('hidden')).toBe(true)
    expect(harness.elements.get('login-lang-label')!.textContent).toBe('中文')
    expect(harness.elements.get('login-btn-label')!.textContent).toBe(MESSAGES.zh.login_btn)
    expect(harness.kvWrites).toContainEqual(['language', 'zh'])
  })
})
