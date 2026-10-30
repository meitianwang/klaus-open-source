// External Agent Import 入口：三个 window 导出的挂载器（settings.js 与
// chat.js 消费面签名照旧）。settings tab 宿主由 loadSettingsTab 反复清空
// innerHTML，所以每次挂载前 unmount 旧 root，避免 render 到脱离节点。
import { createRoot, type Root } from 'react-dom/client'
import {
  ExternalImportOnboarding, ExternalImportProjectDialog, ExternalImportSettingsTab,
} from './ExternalImport'
import {
  EXTERNAL_IMPORT_ONBOARDING_DISMISSED_KEY, externalImportProjectSettingItems, initExternalImportState,
} from './state'
import { externalImportState } from './state'
import { mountSettingsTab } from '../settings/kv'
import styles from './external-import.module.css'

const w = window as any

function loadExternalImportSettingsTab(container: HTMLElement): void {
  mountSettingsTab(container, <ExternalImportSettingsTab />)
}

// ---- 首启 onboarding 覆层 ----
function closeExternalImportOverlay(): void {
  const overlay = document.getElementById('external-import-onboarding')
  if (!overlay) return
  const root = (overlay as any).__reactRoot as Root | undefined
  root?.unmount()
  overlay.remove()
}

function showExternalImportOverlay(): void {
  closeExternalImportOverlay()
  const overlay = document.createElement('div')
  overlay.id = 'external-import-onboarding'
  overlay.className = styles['external-import-onboarding']
  document.body.appendChild(overlay)
  const root = createRoot(overlay)
  ;(overlay as any).__reactRoot = root
  root.render(<ExternalImportOnboarding onClose={closeExternalImportOverlay} />)
}

async function maybeShowExternalAgentImportOnboarding(): Promise<void> {
  if (!w.klaus?.externalAgentImport?.detect) return
  let dismissed
  try {
    dismissed = await w.settingsApi.kv.get(EXTERNAL_IMPORT_ONBOARDING_DISMISSED_KEY)
  } catch (error: any) {
    w.showToast?.(`${w.tt?.('toast_error_prefix') || ''}${error?.message || error}`)
    return
  }
  if (dismissed === '1') return
  let detect
  try {
    detect = await w.klaus.externalAgentImport.detect({ includeHome: true })
    if (detect?.ok === false || detect?.error) throw new Error(detect?.error || w.tt?.('external_import_failed'))
  } catch (error: any) {
    w.showToast?.(`${w.tt?.('toast_error_prefix') || ''}${error?.message || error}`)
    return
  }
  if (!detect || !Array.isArray(detect.items) || detect.items.length === 0) return
  initExternalImportState(detect)
  showExternalImportOverlay()
}

// ---- 项目级导入弹窗 ----
function closeExternalImportProjectDialog(): void {
  const host = document.getElementById('external-import-project-dialog-host')
  if (!host) return
  const root = (host as any).__reactRoot as Root | undefined
  root?.unmount()
  host.remove()
}

async function maybeShowExternalImportForProject(projectRoot: unknown): Promise<boolean> {
  const root = typeof projectRoot === 'string' ? projectRoot.trim() : ''
  if (!root || !w.klaus?.externalAgentImport?.detect) return false
  let detect
  try {
    detect = await w.klaus.externalAgentImport.detect({
      includeHome: false,
      workspaceRoots: [root],
    })
    if (detect?.ok === false || detect?.error) throw new Error(detect?.error || w.tt?.('external_import_failed'))
  } catch (error: any) {
    w.showToast?.(`${w.tt?.('toast_error_prefix') || ''}${error?.message || error}`)
    return false
  }
  const items = externalImportProjectSettingItems(detect)
  if (!items.length) return false
  initExternalImportState({ ...detect, items })
  return new Promise<boolean>(resolve => {
    closeExternalImportProjectDialog()
    const host = document.createElement('div')
    host.id = 'external-import-project-dialog-host'
    document.body.appendChild(host)
    const previousFocus = document.activeElement as HTMLElement | null

    const finish = (shown = true) => {
      document.removeEventListener('keydown', onKeyDown, true)
      const reactRoot = (host as any).__reactRoot as Root | undefined
      reactRoot?.unmount()
      host.remove()
      previousFocus?.focus?.()
      resolve(shown)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // pending 时不许 Escape 关闭（导入中）
      if (e.key === 'Escape' && !externalImportState.pending) {
        e.preventDefault()
        finish(true)
        return
      }
      if (e.key !== 'Tab') return
      const nodes = Array.from(host.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'))
      if (!nodes.length) return
      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)

    const reactRoot = createRoot(host)
    ;(host as any).__reactRoot = reactRoot
    reactRoot.render(<ExternalImportProjectDialog onFinish={() => finish(true)} />)
    requestAnimationFrame(() => host.querySelector<HTMLElement>('button:not([disabled])')?.focus())
  })
}

Object.assign(w, {
  loadExternalImportSettingsTab,
  maybeShowExternalAgentImportOnboarding,
  maybeShowExternalImportForProject,
})
