import { mountWindowsSandboxBanner, type WindowsBannerContext } from '../frontend/src/chat/composer/windows-sandbox-banner'
import { WindowsSandboxController, type WindowsReadiness, type WindowsSetupCompleted } from '../frontend/src/chat/composer/windows-sandbox-controller'
import { I18N } from '../frontend/src/i18n'

const w = window as any
w.currentLang = 'zh'
const preferenceListeners = new Set<(event: { key: string }) => void>()
w.klaus = { on: { appPreferencesChanged: (listener: (event: { key: string }) => void) => { preferenceListeners.add(listener); return () => preferenceListeners.delete(listener) } } }
let status: WindowsReadiness = 'notConfigured', failRead = false, failWrite = false
let completion: ((event: WindowsSetupCompleted) => void) | undefined
let readinessReads = 0, subscriptionCount = 0
const starts: Array<{ mode: string; cwd?: string | null }> = []
const writes: string[] = [], permissions: string[] = []
const controller = new WindowsSandboxController({
  readiness: async () => { readinessReads++; if (failRead) { failRead = false; throw Error('Mock readiness failed') } return { status } },
  start: async args => { starts.push(args); return { started: true } },
  onCompleted: listener => { completion = listener; subscriptionCount++; return () => { completion = undefined; subscriptionCount-- } },
  readMode: async () => writes.at(-1) ?? null,
  writeMode: async mode => { if (failWrite) { failWrite = false; throw Error('Mock config write failed') } writes.push(mode); return { ok: true } },
  selectRequestApproval: async () => { permissions.push('default'); return { ok: true } },
  refreshPermissions: () => {},
})
const main: WindowsBannerContext = { environment: { platform: 'win32', local: true }, cwd: 'C:\\work' }
const side: WindowsBannerContext = { environment: { platform: 'win32', local: true }, cwd: 'C:\\side' }
const mainMount = mountWindowsSandboxBanner(document.getElementById('main-composer')!, () => main, controller)
const sideMount = mountWindowsSandboxBanner(document.getElementById('side-composer')!, () => side, controller)
const checks: string[] = []
const assert = (value: unknown, label: string) => { if (!value) throw Error(label); checks.push(label) }
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => unknown, label: string) {
  const started = Date.now()
  while (!check()) { if (Date.now() - started > 8000) throw Error('Timed out: ' + label); await settle() }
}
const banner = (side = false) => document.querySelector<HTMLElement>(`#${side ? 'side' : 'main'}-composer [data-windows-setup-status]`)
async function native(request: { click?: { x: number; y: number }; capture?: string; width?: number; height?: number }) {
  await new Promise<void>((resolve, reject) => { w.windowsNativeDone = resolve; w.windowsNativeFail = reject; w.windowsNativeRequest = request })
  await settle(40)
}
async function click(selector: string) {
  const node = document.querySelector<HTMLElement>(selector)
  if (!node) throw Error('Missing click target: ' + selector)
  const rect = node.getBoundingClientRect()
  await native({ click: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } })
}
const complete = (mode: 'elevated' | 'unelevated', success: boolean, error: string | null = null) => completion?.({ mode, success, error })

async function run() {
  await until(() => banner() && banner(true), 'shared banners mounted')
  assert(readinessReads === 1 && subscriptionCount === 1, 'Both composers share one readiness read and completion subscription')
  assert(banner()?.textContent?.includes('完成 Windows 设置以继续'), 'Initial Windows setup status is reachable in the composer')
  assert(document.querySelectorAll('[role="dialog"],select').length === 0, 'Preparation adds no modal or independent setting selector')
  await native({ capture: 'windows-setup-initial-zh' })
  await click('#main-composer button')
  await until(() => starts.length === 1 && banner()?.dataset.windowsSetupStatus === 'pending', 'elevated setup pending')
  assert(starts[0]?.mode === 'elevated' && starts[0]?.cwd === 'C:\\work', 'The primary action starts elevated preparation with the current working directory')
  assert(document.querySelectorAll('[data-windows-setup-status] button').length === 0, 'A pending operation shows no clickable setup action')
  complete('unelevated', true); await settle()
  assert(banner()?.dataset.windowsSetupStatus === 'pending', 'Wrong-mode global completion cannot finish an active operation')
  complete('elevated', false, 'orchestrator_helper_launch_canceled: administrator approval canceled')
  await until(() => banner()?.dataset.windowsSetupStatus === 'retryUnelevated', 'fallback after elevated failure')
  assert(banner()?.textContent?.includes('在没有管理员权限的情况下继续'), 'The non-admin action appears only after elevated setup failure')
  await native({ width: 390, height: 760, capture: 'windows-setup-fallback-narrow-zh' })
  assert(document.documentElement.scrollWidth <= innerWidth, 'The setup card fits a narrow composer')
  await click('#side-composer button')
  await until(() => starts.length === 2, 'non-admin setup started')
  assert(starts[1]?.mode === 'unelevated' && starts[1]?.cwd === 'C:\\side', 'Fallback uses the clicked composer’s current directory')
  complete('unelevated', true)
  await until(() => writes.length === 1, 'independent Windows mode write')
  await settle(100)
  assert(banner()?.dataset.windowsSetupStatus === 'pending', 'Finalization retains the pending state during its 500ms delay')
  await until(() => banner()?.dataset.windowsSetupStatus === 'success', 'Windows setup finalized')
  assert(writes[0] === 'unelevated' && permissions.join(',') === 'default', 'Successful enable writes its exact mode and selects Request approval, without automatic review')
  await native({ width: 940, height: 760, capture: 'windows-setup-success-zh' })
  assert(!!document.querySelector('#main-composer button[aria-label="关闭 Windows 设置状态"]'), 'Successful setup has an accessible dismiss action')
  await click('#main-composer button')
  await until(() => !banner(), 'success dismissed')
  status = 'updateRequired'; await controller.check(main.environment, true)
  await until(() => banner()?.dataset.windowsSetupStatus === 'required', 'update requirement shown')
  await click('#main-composer button'); await until(() => starts.length === 3, 'update started')
  complete('elevated', true); await until(() => banner()?.dataset.windowsSetupStatus === 'success', 'update completed')
  assert(starts[2]?.mode === 'elevated' && writes.length === 1 && permissions.length === 1, 'Updating requests elevated preparation without rewriting mode or approval preferences')
  controller.dismiss(); status = 'notConfigured'; failRead = true; await controller.check(main.environment, true)
  await until(() => banner()?.dataset.windowsSetupStatus === 'readiness-error', 'readiness error shown')
  assert(banner()?.textContent?.includes('无法检查 Windows 设置'), 'Readiness failures have their own retry status')
  await click('#main-composer button'); await until(() => banner()?.dataset.windowsSetupStatus === 'required', 'explicit readiness retry succeeded')
  failWrite = true
  await click('#main-composer button'); await until(() => starts.length === 4, 'setup before config failure')
  complete('elevated', true); await until(() => banner()?.dataset.windowsSetupStatus === 'failed', 'config failure remains visible')
  assert(banner()?.textContent?.includes('无法写入配置') && permissions.length === 1, 'A config write failure cannot report successful enable or change approval preferences')
  main.environment = { platform: 'darwin', local: true }; side.environment = { platform: 'win32', local: false }
  mainMount.refresh(); sideMount.refresh(); await until(() => !banner() && !banner(true), 'non-local native context hidden')
  assert(!banner() && !banner(true), 'Mac and remote composers do not display local Windows setup')
  main.environment = { platform: 'win32', local: true, engineInWsl: true }; mainMount.refresh(); await settle()
  assert(!banner(), 'A WSL engine does not display native Windows preparation')
  w.currentLang = 'en'; window.dispatchEvent(new Event('klaus:lang-change'))
  main.environment = { platform: 'win32', local: true }; mainMount.refresh(); await settle()
  assert(banner()?.textContent?.includes('Failed to write config'), 'Setup status follows the current interface language')
  await native({ capture: 'windows-setup-config-error-en' })
  assert(Object.keys(I18N.en).filter(key => key.startsWith('windows_setup_')).every(key => (I18N.zh as Record<string, string>)[key]), 'Every displayed setup message has English and Chinese copy')
  mainMount.dispose(); sideMount.dispose(); controller.dispose()
  assert(subscriptionCount === 0 && preferenceListeners.size === 0, 'Removing setup surfaces releases their listeners')
  w.windowsSetupResults = { passed: checks.length, checks, readinessReads, starts, writes, permissions }
}
w.windowsSetupReady = run().catch(error => { w.windowsSetupError = String(error?.stack || error); throw error })
