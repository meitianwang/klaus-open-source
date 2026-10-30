import { useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { WINDOWS_SANDBOX_SETTING_KEY } from '../../../../contracts/windows-sandbox'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { WindowsSandboxController, needsNativeWindowsSetup, windowsSetupAppDependencies, windowsSetupPending, type WindowsSetupEnvironment, type WindowsSetupState } from './windows-sandbox-controller'
import styles from './windows-sandbox-banner.module.css'

export function WindowsSandboxBanner({ state, onContinue, onRetry, onDismiss }: {
  state: WindowsSetupState
  onContinue(): void
  onRetry(): void
  onDismiss(): void
}) {
  const t = useT()
  if (!state.readinessError && !state.retained && state.readiness !== 'notConfigured' && state.readiness !== 'updateRequired') return null
  const pending = windowsSetupPending(state.phase)
  const failed = state.phase === 'retryUnelevated' || state.phase === 'failed'
  const success = state.success && !pending
  const title = state.readinessError ? 'windows_setup_check_error' : success ? 'windows_setup_success'
    : pending ? 'windows_setup_pending' : failed ? 'windows_setup_failed' : 'windows_setup_title'
  const detail = state.readinessError ? 'windows_setup_check_error_detail' : success ? 'windows_setup_success_detail'
    : pending ? 'windows_setup_pending_detail' : failed ? `windows_setup_error_${state.error ?? 'setup_failed'}`
      : state.readiness === 'updateRequired' ? null : 'windows_setup_detail'
  return <div className={`${styles.banner}${failed || state.readinessError ? ` ${styles.failed}` : ''}${success ? ` ${styles.success}` : ''}`}
    role="status" aria-live="polite" data-windows-setup-status={state.readinessError ? 'readiness-error' : success ? 'success' : pending ? 'pending' : failed ? state.phase : 'required'}>
    <span className={styles.icon} aria-hidden="true"><Icon name={failed || state.readinessError ? 'sys-auth-shield-warn' : 'sys-auth-shield-ok'} size={20} /></span>
    <div className={styles.copy}><div className={styles.title}>{t(title)}</div>{detail && <div className={styles.detail}>{t(detail)}</div>}</div>
    <div className={styles.action}>
      {state.readinessError ? <button type="button" onClick={onRetry}>{t('auth_status_retry')}</button>
        : success ? <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label={t('windows_setup_dismiss')}><Icon name="close" size={14} /></button>
          : pending ? <span className={styles.spinner} aria-hidden="true" />
            : <button type="button" onClick={onContinue}>{t(state.phase === 'retryUnelevated' && state.readiness !== 'updateRequired' ? 'windows_setup_without_admin' : failed ? 'windows_setup_retry' : 'windows_setup_continue')}</button>}
    </div>
  </div>
}

export interface WindowsBannerContext { environment: WindowsSetupEnvironment; cwd: string | null }
function ConnectedBanner({ controller, context }: { controller: WindowsSandboxController; context: WindowsBannerContext }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const enabled = needsNativeWindowsSetup(context.environment)
  useEffect(() => { if (enabled) void controller.check(context.environment) }, [controller, enabled])
  if (!enabled) return null
  return <WindowsSandboxBanner state={state} onContinue={() => { void controller.continue(context.cwd) }}
    onRetry={() => { void controller.check(context.environment, true) }} onDismiss={() => controller.dismiss()} />
}

let sharedController: WindowsSandboxController | undefined
function productionController(): WindowsSandboxController {
  if (sharedController) return sharedController
  sharedController = new WindowsSandboxController(windowsSetupAppDependencies({ settings: window.klaus.settings, session: window.klaus.session }, () => {
    ;(window as any).refreshComposerPreferences?.()
    ;(window as any).refreshSidePermissionButton?.()
  }))
  window.addEventListener('pagehide', () => { sharedController?.dispose(); sharedController = undefined }, { once: true })
  return sharedController
}

export interface WindowsSandboxBannerMount { refresh(): void; dispose(): void }

/** Mount the same local setup status in main and side composers without copying React DOM. */
export function mountWindowsSandboxBanner(wrapper: HTMLElement, context: () => WindowsBannerContext, controller = productionController()): WindowsSandboxBannerMount {
  wrapper.querySelector('[data-windows-sandbox-host]')?.remove()
  const host = document.createElement('div')
  host.dataset.windowsSandboxHost = ''
  host.className = styles.host
  wrapper.prepend(host)
  const root = createRoot(host)
  const refresh = () => root.render(<ConnectedBanner controller={controller} context={context()} />)
  const unsubscribe = window.klaus.on.appPreferencesChanged(({ key }: { key: string }) => {
    if (key !== WINDOWS_SANDBOX_SETTING_KEY) return
    const current = context()
    if (needsNativeWindowsSetup(current.environment)) void controller.check(current.environment, true)
  })
  refresh()
  return { refresh, dispose: () => { unsubscribe(); root.unmount(); host.remove() } }
}
