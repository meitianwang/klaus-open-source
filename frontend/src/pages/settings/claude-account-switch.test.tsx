import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { I18N } from '../../i18n/messages'

let React: any
let act: any
let createRoot: any
let SubscriptionCardBody: any
let happyWindow: any
const originalGlobals = new Map<string, PropertyDescriptor | undefined>()

interface StoredAccount {
  id: string
  email: string
  displayName: string
}

function installAuth(options: {
  lang?: 'en' | 'zh'
  accounts: StoredAccount[]
  failSwitchCode?: string
}) {
  let queue = options.accounts.map(row => ({ ...row }))
  const events: string[] = []
  const switchedIds: string[] = []
  const setMainModelCalls: unknown[] = []
  happyWindow.currentLang = options.lang ?? 'zh'
  happyWindow.currentSessionId = 'session-1'
  happyWindow.klsLoading = { render: () => '<div>loading</div>' }
  happyWindow.klausDialog = { confirm: async () => true }
  const origDispatch = happyWindow.dispatchEvent.bind(happyWindow)
  happyWindow.dispatchEvent = (event: Event) => {
    events.push(event.type)
    return origDispatch(event)
  }
  happyWindow.klaus = {
    auth: {
      status: async () => {
        if (queue.length === 0) return { loggedIn: false, accounts: [] }
        const head = queue[0]!
        return {
          loggedIn: true,
          account: head.email || head.displayName,
          subscriptionType: 'max',
          accounts: queue.map((row, index) => ({ ...row, isCurrent: index === 0 })),
        }
      },
      switchAccount: async (accountId: string) => {
        switchedIds.push(accountId)
        if (options.failSwitchCode) return { ok: false, error: options.failSwitchCode }
        const index = queue.findIndex(row => row.id === accountId)
        if (index < 0) return { ok: false, error: 'claude_account_not_found' }
        if (index > 0) {
          const picked = queue[index]!
          queue = [picked, ...queue.slice(0, index), ...queue.slice(index + 1)]
        }
        return { ok: true, accountId }
      },
      logout: async (accountId?: string) => {
        if (!accountId) queue = []
        else queue = queue.filter(row => row.id !== accountId)
        return { ok: true }
      },
      login: async () => ({ ok: true }),
      importLocal: async () => ({ ok: true }),
    },
    session: {
      setMainModel: async (...args: unknown[]) => { setMainModelCalls.push(args) },
    },
  }
  return { events, switchedIds, setMainModelCalls, getQueue: () => queue }
}

async function mountCard() {
  const container = happyWindow.document.createElement('div')
  happyWindow.document.body.appendChild(container)
  const root = createRoot(container)
  let seq = 0
  const renderCard = () => root.render(
    React.createElement(SubscriptionCardBody, {
      mode: 'subscription',
      reloadSeq: seq,
      reload: () => {
        seq += 1
        renderCard()
      },
    }),
  )
  await act(async () => { renderCard() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, root }
}

beforeAll(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  happyWindow = new Window({ url: 'http://localhost/' })
  const host = globalThis as any
  host.window = happyWindow
  host.document = happyWindow.document
  host.navigator = happyWindow.navigator
  host.HTMLElement = happyWindow.HTMLElement
  host.Node = happyWindow.Node
  host.Event = happyWindow.Event
  host.MouseEvent = happyWindow.MouseEvent
  host.CustomEvent = happyWindow.CustomEvent
  host.MutationObserver = happyWindow.MutationObserver
  host.getComputedStyle = happyWindow.getComputedStyle.bind(happyWindow)
  host.requestAnimationFrame = (callback: any) => setTimeout(() => callback(Date.now()), 0)
  host.cancelAnimationFrame = (id: any) => clearTimeout(id)
  host.IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  createRoot = (await import('react-dom/client')).createRoot
  SubscriptionCardBody = (await import('./subscription-card')).SubscriptionCardBody
})

afterEach(() => {
  happyWindow.document.body.innerHTML = ''
})

afterAll(async () => {
  await happyWindow.happyDOM.cancelAsync()
  happyWindow.close?.()
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as any)[key]
  }
})

describe('Claude subscription account pool active-account switch', () => {
  test('promotes a queued account to current without altering conversation source selection', async () => {
    const harness = installAuth({
      lang: 'zh',
      accounts: [
        { id: 'acct-a', email: 'alice@example.invalid', displayName: 'Alice' },
        { id: 'acct-b', email: 'bob@example.invalid', displayName: 'Bob' },
        { id: 'acct-c', email: 'carol@example.invalid', displayName: 'Carol' },
      ],
    })
    const { container, root } = await mountCard()

    const initialRows = [...container.querySelectorAll('[data-account-id]')] as HTMLElement[]
    expect(initialRows.map(el => el.getAttribute('data-account-id'))).toEqual(['acct-a', 'acct-b', 'acct-c'])
    expect(initialRows[0]!.textContent).toContain(I18N.zh.sub_account_current)
    expect(initialRows[0]!.querySelector('[data-switch-account]')).toBeNull()
    expect(initialRows[1]!.querySelector('[data-switch-account="acct-b"]')?.textContent).toBe(I18N.zh.sub_account_switch)
    expect(initialRows[2]!.querySelector('[data-switch-account="acct-c"]')?.textContent).toBe(I18N.zh.sub_account_switch)

    const switchCarol = initialRows[2]!.querySelector('[data-switch-account="acct-c"]') as HTMLButtonElement
    await act(async () => { switchCarol.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(harness.switchedIds).toEqual(['acct-c'])
    expect(harness.events).toContain('klaus:auth-mode-changed')
    expect(harness.setMainModelCalls).toEqual([])

    const updatedRows = [...container.querySelectorAll('[data-account-id]')] as HTMLElement[]
    expect(updatedRows.map(el => el.getAttribute('data-account-id'))).toEqual(['acct-c', 'acct-a', 'acct-b'])
    expect(updatedRows[0]!.textContent).toContain(I18N.zh.sub_account_current)
    expect(updatedRows[0]!.querySelector('[data-switch-account]')).toBeNull()
    expect(updatedRows[1]!.querySelector('[data-switch-account="acct-a"]')).not.toBeNull()
    expect(updatedRows[2]!.querySelector('[data-switch-account="acct-b"]')).not.toBeNull()

    await act(async () => { root.unmount() })
  })

  test('renders localized recovery copy when the target account is missing', async () => {
    installAuth({
      lang: 'en',
      accounts: [
        { id: 'acct-a', email: 'alice@example.invalid', displayName: 'Alice' },
        { id: 'acct-b', email: 'bob@example.invalid', displayName: 'Bob' },
      ],
      failSwitchCode: 'claude_account_not_found',
    })
    const { container, root } = await mountCard()

    const switchBob = container.querySelector('[data-switch-account="acct-b"]') as HTMLButtonElement
    expect(switchBob.textContent).toBe(I18N.en.sub_account_switch)
    await act(async () => { switchBob.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    const statusText = container.querySelector('#auth-login-status')?.textContent ?? ''
    expect(statusText).toBe(I18N.en.auth_err_account_not_found)
    expect(statusText).not.toContain('claude_account_not_found')

    await act(async () => { root.unmount() })
  })

  test('Antigravity account pool switches active head, shows credential-saved and expired badges and keeps add-account actions', async () => {
    let queue = [
      { id: 'ag-a', email: 'alpha@example.invalid', displayName: '', needsLogin: true },
      { id: 'ag-b', email: 'beta@example.invalid', displayName: '', needsLogin: false },
    ]
    const switched: string[] = []
    happyWindow.currentLang = 'zh'
    happyWindow.klaus = {
      antigravityAuth: {
        status: async () => ({
          loggedIn: true,
          signedIn: true,
          account: queue[0]!.email,
          needsLogin: queue[0]!.needsLogin,
          accounts: queue.map((row, index) => ({ ...row, isCurrent: index === 0 })),
        }),
        switchAccount: async (accountId: string) => {
          switched.push(accountId)
          const idx = queue.findIndex(row => row.id === accountId)
          if (idx < 0) return { ok: false, error: 'antigravity_account_not_found' }
          if (idx > 0) {
            const picked = queue[idx]!
            queue = [picked, ...queue.slice(0, idx), ...queue.slice(idx + 1)]
          }
          return {
            ok: true,
            accountId,
            account: queue[0]!.email,
            needsLogin: queue[0]!.needsLogin,
            accounts: queue.map((row, index) => ({ ...row, isCurrent: index === 0 })),
          }
        },
        logout: async (accountId?: string) => {
          queue = accountId ? queue.filter(row => row.id !== accountId) : []
          return {
            ok: true,
            loggedIn: queue.length > 0,
            signedIn: queue.length > 0,
            account: queue[0]?.email,
            accounts: queue.map((row, index) => ({ ...row, isCurrent: index === 0 })),
          }
        },
        start: async () => ({ ok: true }),
        poll: async () => ({ ok: true }),
        cancel: async () => ({ ok: true }),
        importLocal: async () => ({ ok: true }),
      },
      session: { setMainModel: async () => {} },
    }

    const container = happyWindow.document.createElement('div')
    happyWindow.document.body.appendChild(container)
    const root = createRoot(container)
    let seq = 0
    const renderAg = () => root.render(
      React.createElement(SubscriptionCardBody, {
        mode: 'antigravity',
        reloadSeq: seq,
        reload: () => { seq += 1; renderAg() },
      }),
    )
    await act(async () => { renderAg() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(container.querySelector('#antigravity-auth-card .card-header')?.textContent).toContain(I18N.zh.antigravity_credential_saved)
    const rows = [...container.querySelectorAll('[data-account-id]')] as HTMLElement[]
    expect(rows.map(r => r.getAttribute('data-account-id'))).toEqual(['ag-a', 'ag-b'])
    expect(rows[0]!.textContent).toContain(I18N.zh.sub_account_expired)
    expect(container.querySelector('#antigravity-auth-login-btn')).not.toBeNull()
    expect(container.querySelector('#antigravity-auth-import-btn')).not.toBeNull()

    const switchBeta = rows[1]!.querySelector('[data-switch-account="ag-b"]') as HTMLButtonElement
    await act(async () => { switchBeta.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(switched).toEqual(['ag-b'])
    const updated = [...container.querySelectorAll('[data-account-id]')] as HTMLElement[]
    expect(updated.map(r => r.getAttribute('data-account-id'))).toEqual(['ag-b', 'ag-a'])
    expect(updated[0]!.textContent).toContain(I18N.zh.sub_account_current)
    expect(container.querySelector('[role="alert"]')).toBeNull()

    await act(async () => { root.unmount() })
  })
})
