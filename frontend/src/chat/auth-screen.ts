import { serializeIdentityWrite } from '../pages/profile/identity-store'
// 桌面侧栏更新入口与账号身份播种（自 chat.ts 拆出，strict 类型化）。
//
// 全屏登录闸已退役：应用启动直接进入工作台，账号登录的唯一入口是用户菜单里
// 的「登录」行（sidebar/guest-signin.ts，走 beginAccountLogin）。本模块保留
// 登录共享内核、身份 KV 播种与 klausAuth:updated 订阅。更新提示已整体迁到
// app/update（一个 store 驱动进度弹窗、常驻卡片、就绪决策与安装浮层），本模块
// 不再持有第二份更新状态。boot() 编排（含 init 时序与 splash 策略）留在
// chat.ts，经 deps 注入。
import { desktopServiceUrl, loadDesktopDistribution } from '../app/distribution'

// ---- window.klaus 最小面 ----
interface KlausUser { displayName?: string; email?: string; avatarUrl?: string }
interface KlausAuthApi {
  klausAuth?: {
    login: () => Promise<{ ok?: boolean; error?: string } | null>
  }
  settings: { kv: { set: (key: string, value: string) => Promise<unknown> } }
  on?: {
    klausAuthUpdated?: (cb: (payload: { user?: KlausUser | null }) => void) => unknown
  }
}
const klausApi = () => (window as unknown as { klaus: KlausAuthApi }).klaus


// ---- DOM refs（index.html 静态骨架） ----
const bootScreen = document.getElementById('boot-screen')

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

  // 登录完成 / 服务端资料更新时 main 会广播 klausAuth:updated
  klausApi().on?.klausAuthUpdated?.(async ({ user }) => {
    if (user) {
      await seedIdentityKv(user)
      const bootstrapProfile = (window as unknown as { bootstrapProfile?: () => Promise<void> }).bootstrapProfile
      if (typeof bootstrapProfile === 'function') await bootstrapProfile()
    }
  })
}
