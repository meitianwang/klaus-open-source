// Settings 视图壳（迁自 js/settings.js 尾段，settings.js 至此整体退役）：
// 开合切换、tab 分发（全部 case 均为 React 挂载器）、重启提示、esc 工具与
// 命令/插件页 idle 预热。跨文件消费面（chat.js / i18n.js / ui-shared.js /
// React 各页）全部走 window，导出面与旧 settings.js 一致。
import { t as tGlobal } from '../../i18n'
import { unmountSettingsTab } from './kv'
import styles from './settings.module.css'

const w = () => window as any

// 设置域 API 别名（React tabs 经 w().settingsApi 消费）。桥可能还没装（模块被
// 别的链路先拉进来时），取值用 ?. ——下面 klausOpenExternalUrl 对同一个对象已经
// 是这么取的，这里硬取会让「import 到本模块」本身变成一个断言。
// Non-DOM importers (renderer contract tests) may evaluate this module before a
// window exists; the aliases below are module-load side effects, so skip them
// instead of failing the import.
const hostWindow = typeof window === 'undefined' ? undefined : window as any
if (hostWindow) hostWindow.settingsApi = hostWindow.klaus?.settings

// 系统浏览器开链（chat.js 同款 || 幂等定义，先到者生效）。
if (hostWindow) hostWindow.klausOpenExternalUrl = hostWindow.klausOpenExternalUrl || (async (url: string) => {
  const opener = (window as any).klaus?.app?.openExternal
  if (typeof opener === 'function') {
    const res = await opener(url)
    if (res?.ok === false) throw new Error(res.error || 'failed to open external url')
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
})

if (hostWindow) hostWindow.settingsVisible = false
if (hostWindow) hostWindow.currentSettingsTab = 'profile'
let settingsPreviousFocus: HTMLElement | null = null

export function isSettingsViewActive(): boolean {
  const view = document.getElementById('settings-view')
  return !!view?.classList.contains('active')
}

export function openSettings(tab?: string): void {
  if (!isSettingsViewActive()) settingsPreviousFocus = document.activeElement as HTMLElement | null
  w().settingsVisible = true
  document.body.classList.add('settings-open')
  w().klaus?.browserUse?.hide?.().catch(() => {})
  const view = document.getElementById('settings-view')
  view?.classList.add('active')
  window.dispatchEvent(new CustomEvent('klaus:settings-visibility-change', { detail: { open: true } }))
  loadSettingsTab(tab || w().currentSettingsTab)
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`.${styles['settings-nav-item']}.active`)?.focus())
}

export function openModelSettings(category?: string): void {
  if (category && typeof w().setModelSettingsCategory === 'function') {
    w().setModelSettingsCategory(category)
  }
  if (isSettingsViewActive()) loadSettingsTab('models')
  else openSettings('models')
}

export function closeSettings(): void {
  unmountSettingsTab()
  w().settingsVisible = false
  document.body.classList.remove('settings-open')
  document.getElementById('settings-view')?.classList.remove('active')
  window.dispatchEvent(new CustomEvent('klaus:settings-visibility-change', { detail: { open: false } }))
  if (typeof w().isBrowserPanelVisible === 'function' && w().isBrowserPanelVisible()) {
    w().showBrowserPanel?.()
  } else {
    w().klaus?.browserUse?.hide?.().catch(() => {})
  }
  settingsPreviousFocus?.focus?.()
  settingsPreviousFocus = null
}

export function toggleSettings(tab?: string): void {
  if (isSettingsViewActive()) closeSettings()
  else openSettings(tab)
}

function resetSettingsContent(): HTMLElement | null {
  const content = document.getElementById('settings-content')
  if (!content) return null
  unmountSettingsTab()
  const fresh = content.cloneNode(false) as HTMLElement
  content.replaceWith(fresh)
  return fresh
}

export function loadSettingsTab(tab: string): void {
  if (tab === 'sandbox' || tab === 'runtime') tab = 'preferences'
  if (tab === 'subscription') tab = 'profile'
  w().currentSettingsTab = tab
  document.querySelectorAll(`.${styles['settings-nav-item']}`).forEach(btn => {
    const active = (btn as HTMLElement).dataset.stab === tab
    btn.classList.toggle('active', active)
    if (active) btn.setAttribute('aria-current', 'page')
    else btn.removeAttribute('aria-current')
  })
  const main = document.querySelector<HTMLElement>('.settings-main')
  // Switching tabs starts at the top; a reload of the tab already open (a host
  // settings write remounts it to pick up external changes) keeps the reader's
  // place instead of yanking the page back to its header.
  if (main) {
    if (main.dataset.stab !== tab) main.scrollTop = 0
    main.dataset.stab = tab
  }
  const content = resetSettingsContent()
  if (!content) return
  switch (tab) {
    case 'profile': w().loadProfileTab(content); break
    case 'friends': w().loadFriendsSettingsTab(content); break
    case 'preferences': w().loadPreferencesTab(content); break
    case 'pets': w().loadPetsSettingsTab(content); break
    case 'keyboard': w().loadKeyboardShortcutsTab(content); break
    case 'externalImport': w().loadExternalImportSettingsTab(content); break
    case 'archivedSessions': w().loadArchivedSessionsTab(content); break
    case 'permissions': w().loadPermissionRulesTab(content); break
    case 'hooks': w().loadHooksSettingsTab(content); break
    case 'mobile': w().loadMobileBridgeSettingsTab(content); break
    case 'computerUse': w().loadComputerUseSettingsTab(content); break
    case 'voiceInput': w().loadVoiceInputSettingsTab(content); break
    case 'storage': w().loadStorageSettingsTab(content); break
    case 'worktrees': w().loadWorktreesSettingsTab(content); break
    case 'models': w().loadModelsTab(content); break
    case 'modelTiers': w().loadModelTiersSettingsTab(content); break
    case 'multimodal': w().loadMultimodalSettingsTab(content); break
    case 'engineWeb': w().loadEngineWebTab(content); break
    case 'engineMemory': w().loadDreamSettingsTab(content); break
    case 'systemAuth': w().loadSystemAuthTab(content); break
    case 'about': w().loadAboutTab(content); break
  }
}

// ==================== System Authorization ====================
// macOS 隐私与安全授权状态查看 + 一键跳转系统设置对应面板
// 授权完成后 macOS 对已运行进程缓存了 TCC 决定，新权限必须重启 Klaus 才能生效
export function showRestartPrompt(): void {
  if (document.getElementById('sys-auth-restart-modal')) return
  const previousFocus = document.activeElement as HTMLElement | null
  const modal = document.createElement('div')
  modal.id = 'sys-auth-restart-modal'
  modal.className = styles['sys-auth-modal']
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-labelledby', 'sys-auth-restart-title')
  modal.setAttribute('aria-describedby', 'sys-auth-restart-body')
  modal.innerHTML = `
    <div class="${styles['sys-auth-modal-backdrop']}"></div>
    <div class="${styles['sys-auth-modal-card']}">
      <div class="${styles['sys-auth-modal-title']}" id="sys-auth-restart-title">${tGlobal('sys_auth_restart_title')}</div>
      <div class="${styles['sys-auth-modal-body']}" id="sys-auth-restart-body">${tGlobal('sys_auth_restart_body')}</div>
      <div class="${styles['sys-auth-modal-footer']}">
        <button type="button" class="btn-sm" id="sys-auth-restart-later">${tGlobal('sys_auth_restart_later')}</button>
        <button type="button" class="btn-sm btn-primary" id="sys-auth-restart-now">${tGlobal('sys_auth_restart_now')}</button>
      </div>
    </div>`
  document.body.appendChild(modal)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const nodes = Array.from(modal.querySelectorAll<HTMLElement>('button:not([disabled])'))
    if (!nodes.length) return
    const first = nodes[0]!
    const last = nodes[nodes.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  const close = () => {
    document.removeEventListener('keydown', onKeyDown, true)
    modal.remove()
    previousFocus?.focus?.()
  }
  document.addEventListener('keydown', onKeyDown, true)
  modal.querySelector(`.${styles['sys-auth-modal-backdrop']}`)?.addEventListener('click', close)
  modal.querySelector('#sys-auth-restart-later')?.addEventListener('click', close)
  modal.querySelector('#sys-auth-restart-now')?.addEventListener('click', async () => {
    try { await w().klaus.systemPermissions.restartApp() }
    catch (err: any) { w().showToast(String(err?.message || err)) }
  })
  ;(modal.querySelector('#sys-auth-restart-later') as HTMLElement | null)?.focus()
}

// ==================== Utils ====================
export function esc(str: unknown): string {
  return str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') : ''
}

function prewarmCommandAndPluginViews(): void {
  const run = () => {
    const pluginsContent = document.getElementById('plugins-view-content')
    if (pluginsContent && pluginsContent.dataset.ready !== '1') w().reloadPluginsView?.()
    const slashContent = document.getElementById('slash-commands-view-content')
    if (slashContent && slashContent.dataset.ready !== '1') w().reloadSlashCommandsView?.()
  }
  if (typeof w().requestIdleCallback === 'function') {
    w().requestIdleCallback(run, { timeout: 2000 })
  } else {
    setTimeout(run, 900)
  }
}

if (hostWindow) Object.assign(hostWindow, {
  toggleSettings,
  openSettings,
  openModelSettings,
  closeSettings,
  loadSettingsTab,
  isSettingsViewActive,
  esc,
  showRestartPrompt,
})

// Idle prewarm only makes sense with a real document; skip it for non-DOM importers.
if (hostWindow) prewarmCommandAndPluginViews()
