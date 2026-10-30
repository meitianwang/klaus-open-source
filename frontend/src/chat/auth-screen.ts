import { serializeIdentityWrite } from '../pages/profile/identity-store'
// 桌面侧栏更新入口与账号身份播种（自 chat.ts 拆出，strict 类型化）。
//
// 全屏登录闸已退役：应用启动直接进入工作台，账号登录的唯一入口是用户菜单里
// 的「登录」行（sidebar/guest-signin.ts，走 beginAccountLogin）。本模块保留
// 登录共享内核、身份 KV 播种、klausAuth:updated 订阅与 updater:status 侧栏/
// 标题栏更新控件。boot() 编排（含 init 时序与 splash 策略）留在 chat.ts，经
// deps 注入。
import { tt } from '../app/i18n'
import { desktopServiceUrl, loadDesktopDistribution } from '../app/distribution'

// ---- window.klaus 最小面 ----
interface KlausUser { displayName?: string; email?: string; avatarUrl?: string }
interface UpdaterStatus { supported?: boolean; state?: string; availableVersion?: string | null }
interface UpdaterInstallResult { ok?: boolean; error?: string }
interface KlausAuthApi {
  klausAuth?: {
    login: () => Promise<{ ok?: boolean; error?: string } | null>
  }
  settings: { kv: { set: (key: string, value: string) => Promise<unknown> } }
  updater?: {
    install?: () => Promise<unknown>
    status?: () => Promise<UpdaterStatus | null>
  }
  on?: {
    updaterStatus?: (cb: (status: UpdaterStatus | null) => void) => unknown
    klausAuthUpdated?: (cb: (payload: { user?: KlausUser | null }) => void) => unknown
  }
}
const klausApi = () => (window as unknown as { klaus: KlausAuthApi }).klaus


// ---- DOM refs（index.html 静态骨架） ----
const bootScreen = document.getElementById('boot-screen')
const updateRestartBtn = document.getElementById('sidebar-update-restart') as HTMLButtonElement | null
const updateRestartLabel = updateRestartBtn?.querySelector('.sidebar-update-restart-label') as HTMLElement | null

export function hideBootScreen(): void {
  if (!bootScreen || bootScreen.dataset.hidden === '1') return
  bootScreen.dataset.hidden = '1'
  bootScreen.classList.add('hiding')
  setTimeout(() => { bootScreen.style.display = 'none' }, 220)
}

// 账号登录的共享内核：开浏览器授权页 + 宿主轮询，返回最终结果。工作区内的
// 用户菜单登录入口（sidebar/guest-signin）走这一条路——登录本身只写凭据、
// 清访客标记、广播 klausAuth:updated，不碰引擎与进行中的回合，所以可以在
// 不打断任务的前提下从工作区里发起。
export async function beginAccountLogin(): Promise<{ ok?: boolean; error?: string } | null> {
  try {
    return await klausApi().klausAuth?.login() ?? null
  } catch (err) {
    return { ok: false, error: (err as Error | null)?.message || String(err) }
  }
}

// ==================== Desktop auto-update control ====================
// A verified download gets one persistent action in the sidebar footer. The
// action stays near the account controls instead of floating above the current
// task, and installation still requires an explicit click.
let latestUpdaterStatus: UpdaterStatus | null = null
let updateInstallInFlight = false
function showUpdateControl(status: UpdaterStatus | null): void {
  latestUpdaterStatus = status
  if (!updateRestartBtn) return
  if (!status || status.supported === false || status.state !== 'downloaded') {
    updateRestartBtn.hidden = true
    updateRestartBtn.disabled = false
    updateRestartBtn.removeAttribute('aria-busy')
    return
  }
  const version = status.availableVersion || ''
  updateRestartBtn.hidden = false
  updateRestartBtn.setAttribute('aria-label', `${(tt('update_ready') || 'Klaus {v} is ready to install.').replace('{v}', version)} ${tt('update_restart') || 'Restart to update'}`)
  if (updateRestartLabel) {
    updateRestartLabel.textContent = updateInstallInFlight ? (tt('update_preparing') || 'Preparing…') : (tt('update_restart') || 'Restart to update')
  }
  updateRestartBtn.disabled = updateInstallInFlight
  if (updateInstallInFlight) updateRestartBtn.setAttribute('aria-busy', 'true')
  else updateRestartBtn.removeAttribute('aria-busy')
}

async function installUpdate(): Promise<void> {
  if (!updateRestartBtn || updateRestartBtn.hidden || updateInstallInFlight) return
  updateInstallInFlight = true
  showUpdateControl(latestUpdaterStatus)
  try {
    const result = await klausApi().updater?.install?.() as UpdaterInstallResult | undefined
    if (result?.ok !== true) throw new Error(result?.error || 'Update installation was not accepted')
    // A successful handoff quits this process. Keep the control busy so a slow
    // native transition cannot be triggered twice.
  } catch (error) {
    updateInstallInFlight = false
    showUpdateControl(latestUpdaterStatus)
    const detail = error instanceof Error ? error.message : String(error)
    const message = detail === 'The macOS application code signature is invalid'
      ? tt('update_install_modified_app')
      : tt('update_install_failed')
    if (window.showToast) window.showToast(message)
    else void window.klausDialog?.alert(message)
  }
}

// 把云端 user (displayName/email/avatarUrl) 写进本地 KV，供 bootstrapProfile 读。
// boot 时从 klausAuth:status 拿；登录成功 / 个人资料更新后由 klausAuth:updated 事件再调一次，
// 这样侧栏和设置页都能立刻反映最新值。
export async function seedIdentityKv(user: KlausUser | null | undefined): Promise<void> {
  if (!user) return
  return serializeIdentityWrite(async () => {
    try {
      await loadDesktopDistribution()
      const kv = klausApi().settings.kv
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
    } catch { /* kv best-effort */ }
  })
}

export function initAuthScreen(): void {
  const w = window as unknown as Record<string, unknown>
  w.seedIdentityKv = seedIdentityKv

  updateRestartBtn?.addEventListener('click', () => { void installUpdate() })
  klausApi().on?.updaterStatus?.(showUpdateControl)
  void klausApi().updater?.status?.().then(showUpdateControl).catch(() => {})
  window.addEventListener('klaus:lang-change', () => showUpdateControl(latestUpdaterStatus))

  // 登录完成 / 服务端资料更新时 main 会广播 klausAuth:updated
  klausApi().on?.klausAuthUpdated?.(async ({ user }) => {
    if (user) {
      await seedIdentityKv(user)
      const bootstrapProfile = (window as unknown as { bootstrapProfile?: () => Promise<void> }).bootstrapProfile
      if (typeof bootstrapProfile === 'function') await bootstrapProfile()
    }
  })
}
