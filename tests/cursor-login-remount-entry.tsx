import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SubscriptionCardBody } from '../frontend/src/pages/settings/subscription-card'
import '../frontend/src/app/ui-shared'

// A real account-card remount while the host is publishing a saved browser grant.
const target = window as any
const checks: { name: string; ok: boolean }[] = []
window.addEventListener('error', event => checks.push({ name: String(event.error?.stack || event.message), ok: false }))
const check = (name: string, ok: boolean) => { checks.push({ name, ok }); if (!ok) throw new Error(name) }
const waitFor = async (predicate: () => boolean, stage: string) => {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out at ' + stage)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
let committed = false, polling = false, cancels = 0, activations = 0, reloads = 0, revision = 0
let finishPoll!: (value: unknown) => void
const grant = new Promise(resolve => { finishPoll = resolve })
target.currentLang = 'en'
target.currentSessionId = 'fixture-session'
target.klaus = {
  cursorAuth: {
    status: async () => committed ? { loggedIn: true, account: 'fixture@example.invalid' } : { loggedIn: false },
    start: async () => ({ ok: true, flowId: 'fixture-flow', interval: 1, expiresAt: Date.now() + 60_000 }),
    poll: async () => { polling = true; return grant },
    cancel: async () => { cancels++; return { ok: true } },
  },
  session: { setMainModel: async () => { activations++ } },
}
const root = createRoot(document.getElementById('root')!)
const render = () => root.render(createElement(SubscriptionCardBody, {
  key: revision++, mode: 'cursor', reloadSeq: revision, reload: () => { reloads++; render() },
}))
async function main() {
  render()
  await waitFor(() => !!document.getElementById('cursor-auth-login-btn'), 'initial login card')
  document.getElementById('cursor-auth-login-btn')!.click()
  await waitFor(() => polling, 'browser grant poll')
  render()
  await new Promise(resolve => setTimeout(resolve, 30))
  await waitFor(() => !!document.getElementById('cursor-auth-login-btn'), 'remounted login card')
  check('card remount does not cancel the pending account flow', cancels === 0)
  committed = true
  finishPoll({ ok: true, account: 'fixture@example.invalid' })
  await waitFor(() => activations === 1 && !!document.getElementById('cursor-auth-logout-btn'), 'committed account card')
  check('committed authorization publishes across a card remount', document.body.textContent!.includes('fixture@example.invalid'))
  check('account publication refreshes once', reloads === 1)
  check('model activation runs once', activations === 1)
  root.unmount()
  await new Promise(resolve => setTimeout(resolve, 0))
  check('completed account survives later card cleanup', cancels === 0)
}
main().catch(error => {
  if (!checks.some(row => !row.ok && row.name === error.message)) checks.push({ name: error.message, ok: false })
}).finally(() => {
  target.cursorRemountResult = { checks, passed: checks.filter(row => row.ok).length, failed: checks.filter(row => !row.ok).length }
})
