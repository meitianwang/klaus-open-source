// Browser capability, Chrome access, and extension connectivity are separate facts.
// Reads never opt in. Explicit connection actions enable access and register the
// local native host before the user loads the extension from its stable folder.
// The presentation panel receives snapshots and callbacks so both state and
// connection actions can be exercised without writing a real browser profile.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import { getPluginLogoSrc } from '../../icons/extension-logos'
import { skillLogoImgHtml } from '../skills/localize'
import { writeClipboardText } from '../../clipboard'
import { reloadMcpView, showToast } from './data'
import { EntryAction, EntryModal, EntryPoints } from './entry-modal'
import styles from './mcp.module.css'
import { enableChromeConnection, prepareChromeConnection, readBrowserConnectionSettings } from './browser-connection-actions'

const w = () => window as any

/// 浏览器的安心栏三行：标题沿用共用那套，描述换成浏览器自己的话。
const BROWSER_POINT_DESCS: [string, string, string] = [
  'browser_point_tools_desc',
  'browser_point_permission_desc',
  'browser_point_control_desc',
]

export interface ChromeInstanceRow {
  id: string
  name?: string
  version?: string
}

/** 宿主 chrome-diagnostics 里弹窗要读的那一半。 */
export interface ChromeDiagnosticsState {
  ok?: boolean
  runtimeReachable?: boolean
  nativeHostCorrect?: boolean
  extensionInstalled?: boolean
  extensionEnabled?: boolean
  /** The browser profile could not be read, so installation is unconfirmed rather than absent. */
  extensionInstallStateUnknown?: boolean
  /** A record exists but states neither way, so enablement is unconfirmed rather than disabled. */
  extensionEnablementUnknown?: boolean
  browserCount?: number
  extensionVersions?: string[]
  connectedBrowsers?: ChromeInstanceRow[]
  extensionManagerUrl?: string
  /** Where the manual-install copy lives and whether it is already there. */
  deployDirectory?: string
  deployed?: boolean
  /** Managed-policy install state: the zero-gesture path, macOS only. */
  policyInstalled?: boolean
  policyEntry?: string | null
  policyPlistPath?: string
  policyEffective?: boolean
  /** Whether the zero-gesture path can work here at all (MDM kills it). */
  policySupported?: boolean
  policySupportReason?: 'not_macos' | 'no_manifest' | 'mdm_enrolled' | null
  policyUpdateManifestUrl?: string | null
}

/** 复制成功的小字回显停留时长：够看清「已复制」，又不至于挂成常驻态。 */
const COPIED_FLASH_MS = 1600

/**
 * Which explanation the disconnected state shows.
 *
 * A refused profile read (macOS protects another application's data directory)
 * leaves installation unconfirmed, and an extension record without an explicit
 * enablement state leaves that unconfirmed too. Neither should tell the user to
 * install a second copy of an extension that is already there; the actionable
 * step in both cases is to get it reconnected.
 */
function waitingDescKey(diag: ChromeDiagnosticsState | null): string {
  if (diag?.extensionInstallStateUnknown === true) return 'browser_ext_waiting_unknown_install_desc'
  if (diag?.extensionInstalled === true) return 'browser_ext_waiting_reconnect_desc'
  return 'browser_ext_waiting_desc'
}

export interface BrowserExtensionPanelProps {
  diag: ChromeDiagnosticsState | null
  manualOpen: boolean
  deployedPath: string | null
  copied: 'path' | 'url' | null
  deployBusy: boolean
  openBusy: boolean
  prepareBusy: boolean
  policyInstalled: boolean
  policyBusy: boolean
  chromeEnabled?: boolean | null
  chromeBusy?: boolean
  accessLoadFailed?: boolean
  onEnableChrome?: () => void
  onRetryAccess?: () => void
  onToggleManual: () => void
  onPrepare: () => void
  onPolicyInstall: () => void
  onPolicyUninstall: () => void
  onOpenManager: () => void
  onCopyManagerUrl: () => void
  onCopyExtension: () => void
  onOpenFolder: () => void
  onCopyPath: () => void
}

/**
 * 扩展连接状态区 + 未连时的手动安装引导。纯展示：一切事实从 props 进。
 *
 * 引导默认展开，且顶部有一个「一键准备安装」：部署拷贝、复制路径、打开扩展管理
 * 页、Finder 定位四件事合成一次点击。分步区留给想看清每一步的人，不是必经之路。
 */
export function BrowserExtensionPanel(props: BrowserExtensionPanelProps) {
  const t = useT()
  const { diag, manualOpen, deployedPath, copied, deployBusy, openBusy, prepareBusy, policyInstalled, policyBusy } = props
  const connected = diag?.runtimeReachable === true
  const needsSetup = !connected || diag?.ok === false || diag?.nativeHostCorrect === false
  const instances = diag?.connectedBrowsers ?? []
  const version = (diag?.extensionVersions ?? [])[0]
  // 诊断知道拷贝在不在：在就把路径行直接摆出来，不需要先点一次「复制扩展」。
  const shownPath = deployedPath ?? (diag?.deployed === true ? (diag.deployDirectory ?? null) : null)
  // 零手势只在宿主确认能生效的机器上出现：受设备管理的 Mac 上手工策略是死的，
  // 摆一个注定不生效的按钮比不摆更糟。
  const policyAvailable = diag?.policySupported === true
  const policyUnsupportedReason = diag && diag.policySupported === false ? diag.policySupportReason ?? null : null
  return (
    <>
      {props.onEnableChrome ? (
        <div className={styles['browser-ext-policy']} data-chrome-access={props.chromeEnabled === true ? 'enabled' : props.chromeEnabled === false ? 'disabled' : 'unknown'}>
          <div className={styles['browser-ext-policy-text']}>
            <div className={styles['browser-ext-policy-title']}>{t('browser_ext_access_title')}</div>
            <div className={styles['browser-ext-policy-desc']}>
              {t(props.accessLoadFailed ? 'browser_ext_access_load_failed' : props.chromeEnabled == null ? 'browser_ext_access_checking'
                : props.chromeEnabled ? 'browser_ext_access_enabled_desc' : 'browser_ext_access_disabled_desc')}
            </div>
          </div>
          {props.accessLoadFailed ? <button type="button" className={styles['browser-ext-mini-btn']} disabled={props.chromeBusy} onClick={props.onRetryAccess}>{t('mention_group_retry')}</button>
            : props.chromeEnabled === true ? <span className={styles['browser-ext-current']}>{t('browser_ext_access_enabled')}</span>
              : <button type="button" className={styles['browser-ext-mini-btn']} disabled={props.chromeBusy || props.chromeEnabled == null} onClick={props.onEnableChrome}>
                {t(props.chromeBusy ? 'browser_ext_access_busy' : 'browser_ext_access_enable')}
              </button>}
        </div>
      ) : null}
      {diag ? (
        <div className={styles['browser-ext-status']} data-connected={connected}>
          <div className={styles['browser-ext-status-row']}>
            <span className={`${styles['browser-ext-dot']}${connected ? ` ${styles['is-on']}` : ''}`} />
            <span className={styles['browser-ext-status-label']}>
              {connected ? t('browser_ext_connected') : t('browser_ext_waiting')}
            </span>
            <span className={styles['browser-ext-chip']}>Chrome</span>
            {version ? <span className={styles['browser-ext-chip']}>v{version}</span> : null}
          </div>
          {connected ? (
            <>
              <div className={styles['browser-ext-count']}>
                {t('browser_ext_instances').replace('{count}', String(diag.browserCount ?? instances.length))}
              </div>
              <div className={styles['browser-ext-list']}>
                {instances.map(row => (
                  <div className={styles['browser-ext-instance']} key={row.id}>
                    <span className={`${styles['browser-ext-dot']} ${styles['is-on']}`} />
                    <span
                      className={styles['browser-ext-instance-icon']}
                      dangerouslySetInnerHTML={{ __html: rawIconHtml('browser') }}
                    />
                    <div className={styles['browser-ext-instance-text']}>
                      <div className={styles['browser-ext-instance-name']}>
                        {row.name || t('browser_ext_unknown_browser')}{row.version ? ` v${row.version}` : ''}
                      </div>
                      <div className={styles['browser-ext-instance-id']}>
                        {t('browser_ext_id_hint').replace('{id}', row.id.slice(0, 6))}
                      </div>
                    </div>
                    <span className={styles['browser-ext-current']}>{t('browser_ext_current')}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className={styles['browser-ext-waiting-desc']}>{t(waitingDescKey(diag))}</p>
          )}
        </div>
      ) : null}
      {policyInstalled ? (
        <div className={styles['browser-ext-policy']} data-installed="true">
          <div className={styles['browser-ext-policy-text']}>
            <div className={styles['browser-ext-policy-title']}>{t('browser_ext_policy_installed')}</div>
            <div className={styles['browser-ext-policy-desc']}>
              {diag?.policyEffective === false ? t('browser_ext_policy_inert') : t('browser_ext_policy_installed_desc')}
            </div>
          </div>
          <button
            type="button"
            className={styles['browser-ext-mini-btn']}
            disabled={policyBusy}
            onClick={props.onPolicyUninstall}
          >
            {t('browser_ext_policy_uninstall')}
          </button>
        </div>
      ) : policyAvailable ? (
        <div className={styles['browser-ext-policy']}>
          <div className={styles['browser-ext-policy-text']}>
            <div className={styles['browser-ext-policy-title']}>{t('browser_ext_policy_title')}</div>
            <div className={styles['browser-ext-policy-desc']}>{t('browser_ext_policy_desc')}</div>
          </div>
          <button
            type="button"
            className={styles['browser-ext-mini-btn']}
            disabled={policyBusy}
            onClick={props.onPolicyInstall}
          >
            {policyBusy ? t('browser_ext_policy_busy') : t('browser_ext_policy_install')}
          </button>
        </div>
      ) : null}
      {needsSetup ? (
        <div className={styles['browser-ext-manual']}>
          {!policyAvailable && policyUnsupportedReason === 'mdm_enrolled' ? (
            <p className={styles['browser-ext-policy-note']}>{t('browser_ext_policy_unsupported_mdm')}</p>
          ) : null}
          <div className={styles['browser-ext-prepare']}>
            <button
              type="button"
              className={styles['browser-ext-prepare-btn']}
              disabled={prepareBusy || deployBusy || props.chromeBusy || (!!props.onEnableChrome && props.chromeEnabled == null)}
              onClick={props.onPrepare}
            >
              {prepareBusy ? t('browser_ext_preparing') : t(props.chromeEnabled === false ? 'browser_ext_prepare_enable' : 'browser_ext_prepare')}
            </button>
            <div className={styles['browser-ext-prepare-desc']}>{t('browser_ext_prepare_desc')}</div>
          </div>
          <button
            type="button"
            className={styles['browser-ext-manual-toggle']}
            aria-expanded={manualOpen}
            onClick={props.onToggleManual}
          >
            {manualOpen ? t('browser_ext_manual_hide') : t('browser_ext_manual_toggle')}
          </button>
          {manualOpen ? (
            <ol className={styles['browser-ext-steps']}>
              <li>
                <div className={styles['browser-ext-step-title']}>{t('browser_ext_step1_title')}</div>
                <div className={styles['browser-ext-step-desc']}>{t('browser_ext_step1_desc')}</div>
                <div className={styles['browser-ext-step-actions']}>
                  <button type="button" className={styles['browser-ext-mini-btn']} disabled={openBusy} onClick={props.onOpenManager}>
                    {t('browser_ext_open_manager')}
                  </button>
                  <button type="button" className={styles['browser-ext-mini-btn']} disabled={!diag?.extensionManagerUrl} onClick={props.onCopyManagerUrl}>
                    {copied === 'url' ? t('browser_ext_copied') : t('browser_ext_copy_url')}
                  </button>
                </div>
              </li>
              <li>
                <div className={styles['browser-ext-step-title']}>{t('browser_ext_step2_title')}</div>
                <div className={styles['browser-ext-step-desc']}>{t('browser_ext_step2_desc')}</div>
                <div className={styles['browser-ext-step-actions']}>
                  <button type="button" className={styles['browser-ext-mini-btn']} disabled={deployBusy} onClick={props.onCopyExtension}>
                    {copied === 'path' ? t('browser_ext_copied') : t('browser_ext_deploy')}
                  </button>
                  <button type="button" className={styles['browser-ext-mini-btn']} disabled={deployBusy} onClick={props.onOpenFolder}>
                    {t('browser_ext_open_folder')}
                  </button>
                </div>
                {shownPath ? (
                  <div className={styles['browser-ext-path-row']}>
                    <code className={styles['browser-ext-path']}>{shownPath}</code>
                    <button type="button" className={styles['browser-ext-mini-btn']} onClick={props.onCopyPath}>
                      {copied === 'path' ? t('browser_ext_copied') : t('browser_ext_copy_path')}
                    </button>
                  </div>
                ) : null}
              </li>
              <li>
                <div className={styles['browser-ext-step-title']}>{t('browser_ext_step3_title')}</div>
                <div className={styles['browser-ext-step-desc']}>{t('browser_ext_step3_desc')}</div>
              </li>
              <li>
                <details className={styles['browser-ext-faq']}>
                  <summary>{t('browser_ext_faq_question')}</summary>
                  <ol>
                    <li>{t('browser_ext_faq_step1')}</li>
                    <li>{t('browser_ext_faq_step2')}</li>
                    <li>{t('browser_ext_faq_step3')}</li>
                  </ol>
                </details>
              </li>
            </ol>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/**
 * 浏览器能力启停弹窗：双 logo hero + 状态徽 + 标题/描述 + 扩展连接状态区 +
 * （未连时）手动安装引导 + 安心栏 + 全宽按钮。启用/断开即行上开关，改动立刻
 * reloadMcpView：弹窗背后就是那行开关，等关窗再对齐就又是两张嘴。
 */
export function BrowserCapabilityModal({ enabled: initialEnabled, onClose }: {
  enabled: boolean
  onClose: () => void
}) {
  const t = useT()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [busy, setBusy] = useState(false)
  const [chromeEnabled, setChromeEnabled] = useState<boolean | null>(null)
  const [chromeBusy, setChromeBusy] = useState(false)
  const [accessLoadFailed, setAccessLoadFailed] = useState(false)
  const connectionActionRef = useRef(false)
  const [diag, setDiag] = useState<ChromeDiagnosticsState | null>(null)
  // 引导默认展开：未连时这一屏的唯一目的就是把它装好，折叠起来等于把答案藏一层。
  // 例外：宿主确认零手势可用的机器上，主路径是那颗按钮，引导收起来当备选。
  const [manualOpen, setManualOpen] = useState(true)
  const guideTouchedRef = useRef(false)
  useEffect(() => {
    if (!diag || guideTouchedRef.current) return
    setManualOpen(diag.policySupported === true ? false : true)
  }, [diag])
  const [deployedPath, setDeployedPath] = useState<string | null>(null)
  const [deployBusy, setDeployBusy] = useState(false)
  const [openBusy, setOpenBusy] = useState(false)
  const [prepareBusy, setPrepareBusy] = useState(false)
  const [policyBusy, setPolicyBusy] = useState(false)
  const [copied, setCopied] = useState<'path' | 'url' | null>(null)
  const copiedTimer = useRef<number | undefined>(undefined)
  const seqRef = useRef(0)
  const name = t('browser_use_title')

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current
    const api = w().settingsApi?.browserUse
    const [settings, diagnostics] = await Promise.allSettled([
      readBrowserConnectionSettings(api), Promise.resolve().then(() => api?.chromeDiagnostics?.()),
    ])
    if (seq !== seqRef.current) return
    setAccessLoadFailed(settings.status === 'rejected')
    if (settings.status === 'fulfilled') { setChromeEnabled(settings.value.enabled && settings.value.chromeEnabled); setEnabled(settings.value.enabled) }
    else setChromeEnabled(null)
    setDiag(diagnostics.status === 'fulfilled' && diagnostics.value?.ok === true ? diagnostics.value.diagnostics as ChromeDiagnosticsState : null)
  }, [])

  useEffect(() => {
    void refresh()
    return () => { seqRef.current++ }
  }, [refresh])

  const connected = diag?.runtimeReachable === true
  // 未连期间轮询：扩展是在 Chrome 里装好的，这张弹窗要自己看见它连上。
  useEffect(() => {
    if (connected && !accessLoadFailed) return
    const timer = window.setInterval(() => { void refresh() }, 3000)
    return () => window.clearInterval(timer)
  }, [connected, accessLoadFailed, refresh])
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  const flashCopied = (kind: 'path' | 'url') => {
    setCopied(kind)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(null), COPIED_FLASH_MS)
  }

  const apply = async (next: boolean) => {
    if (connectionActionRef.current) return
    setBusy(true)
    const res = await Promise.resolve(w().settingsApi?.browserUse?.setEnabled?.(next))
      .catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
    setBusy(false)
    if (!res?.ok) {
      showToast(res?.error || t('settings_failed'))
      return
    }
    setEnabled(next)
    showToast(next ? t('enabled') : t('mcp_disconnected_toast'))
    reloadMcpView()
    await refresh()
  }

  const chromeFailure = (error: any) => showToast(`${t('toast_error_prefix')}${t(error?.message || 'browser_ext_connection_failed')}`)
  const enableChrome = async () => {
    if (connectionActionRef.current || chromeBusy || prepareBusy) return
    connectionActionRef.current = true
    setChromeBusy(true)
    try {
      const settings = await enableChromeConnection(w().settingsApi?.browserUse)
      setEnabled(settings.enabled)
      setChromeEnabled(settings.chromeEnabled)
      showToast(t('browser_ext_access_enabled'))
      reloadMcpView()
    } catch (error) { chromeFailure(error) }
    finally { connectionActionRef.current = false; setChromeBusy(false); await refresh() }
  }

  /** 把随包扩展复制到稳定目录；返回落点路径，失败返回 null 并已 toast。 */
  const deploy = async (): Promise<string | null> => {
    setDeployBusy(true)
    try {
      const res = await Promise.resolve(w().settingsApi?.browserUse?.deployChromeExtension?.())
        .catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
      if (res?.ok !== true || typeof res.extensionPath !== 'string') {
        showToast(`${t('toast_error_prefix')}${res?.error || t('settings_failed')}`)
        return null
      }
      setDeployedPath(res.extensionPath)
      return res.extensionPath
    } finally {
      setDeployBusy(false)
    }
  }

  const copyExtension = async () => {
    const path = await deploy()
    if (!path) return
    try {
      await writeClipboardText(path)
      showToast(t('browser_ext_path_copied'))
      flashCopied('path')
    } catch (error: any) {
      showToast(`${t('toast_error_prefix')}${error?.message || error}`)
    }
  }

  const openFolder = async () => {
    const path = deployedPath ?? await deploy()
    if (!path) return
    const res = await Promise.resolve(w().settingsApi?.browserUse?.revealChromeExtension?.())
      .catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
    if (res?.ok !== true) showToast(`${t('toast_error_prefix')}${res?.error || t('settings_failed')}`)
  }

  const copyPath = async () => {
    if (!deployedPath) return
    try {
      await writeClipboardText(deployedPath)
      showToast(t('browser_ext_path_copied'))
      flashCopied('path')
    } catch (error: any) {
      showToast(`${t('toast_error_prefix')}${error?.message || error}`)
    }
  }

  const openManager = async () => {
    setOpenBusy(true)
    try {
      const res = await Promise.resolve(w().settingsApi?.browserUse?.openChromeExtensionManager?.())
        .catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
      if (res?.ok !== true) showToast(`${t('toast_error_prefix')}${res?.error || t('settings_failed')}`)
    } finally {
      setOpenBusy(false)
    }
  }

  const copyManagerUrl = async () => {
    const url = diag?.extensionManagerUrl
    if (!url) return
    try {
      await writeClipboardText(url)
      showToast(t('browser_ext_url_copied'))
      flashCopied('url')
    } catch (error: any) {
      showToast(`${t('toast_error_prefix')}${error?.message || error}`)
    }
  }

  /** Explicit opt-in prepares the stable extension and native host before Chrome's manual load step. */
  const prepare = async () => {
    if (connectionActionRef.current || prepareBusy || chromeBusy) return
    connectionActionRef.current = true
    setPrepareBusy(true)
    try {
      const result = await prepareChromeConnection(w().settingsApi?.browserUse, writeClipboardText)
      setEnabled(result.settings.enabled); setChromeEnabled(result.settings.chromeEnabled); setDeployedPath(result.path)
      guideTouchedRef.current = true; setManualOpen(true)
      if (result.copied) flashCopied('path')
      showToast(t(result.revealed && result.copied ? 'browser_ext_prepare_done' : 'browser_ext_prepare_partial'))
      reloadMcpView()
    } catch (error) { chromeFailure(error) }
    finally { connectionActionRef.current = false; setPrepareBusy(false); await refresh() }
  }

  /**
   * 零手势安装：写系统托管策略让 Chrome 自己拉扩展。代价（管理员授权、管理横幅、
   * 全机生效）在确认弹窗里逐条说清，确认了才发；卸载走同一个确认语义。
   */
  const policyInstall = async () => {
    if (!(await w().klausDialog.confirm({
      title: t('browser_ext_policy_confirm_title'),
      message: t('browser_ext_policy_confirm_message'),
    }))) return
    setPolicyBusy(true)
    try {
      const res = await Promise.resolve(w().settingsApi?.browserUse?.policyInstallChromeExtension?.())
        .catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
      if (res?.ok !== true) {
        showToast(`${t('toast_error_prefix')}${res?.error || t('settings_failed')}`)
        return
      }
      // "Written but inert" is a real outcome on MDM-enrolled machines: the
      // plist landed but the filtered preferences view will never hand it to
      // Chrome. Say so instead of celebrating a policy the browser ignores.
      showToast(res.policyEffective === false ? t('browser_ext_policy_inert_toast') : t('browser_ext_policy_done'))
      await refresh()
    } finally {
      setPolicyBusy(false)
    }
  }

  const policyUninstall = async () => {
    if (!(await w().klausDialog.confirm({
      title: t('browser_ext_policy_uninstall_title'),
      message: t('browser_ext_policy_uninstall_message'),
      danger: true,
    }))) return
    setPolicyBusy(true)
    try {
      const res = await Promise.resolve(w().settingsApi?.browserUse?.policyUninstallChromeExtension?.())
        .catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
      if (res?.ok !== true) {
        showToast(`${t('toast_error_prefix')}${res?.error || t('settings_failed')}`)
        return
      }
      showToast(t('browser_ext_policy_removed'))
      await refresh()
    } finally {
      setPolicyBusy(false)
    }
  }

  return (
    <EntryModal
      entryIconHtml={skillLogoImgHtml(getPluginLogoSrc({ id: 'browser@builtin' }))}
      state={enabled ? 'on' : 'off'}
      title={(enabled ? t('mcp_state_on_title') : t('mcp_state_enable_cta')).replace('{name}', name)}
      desc={t('browser_settings_desc')}
      onClose={onClose}
      closeDisabled={busy || chromeBusy || prepareBusy}
      actions={enabled
        ? <EntryAction kind="danger" id="browser-disable" disabled={busy} onClick={() => { void apply(false) }}>{t('mcp_market_disconnect')}</EntryAction>
        : <EntryAction id="browser-enable" disabled={busy} onClick={() => { void apply(true) }}>{t('mcp_state_enable_cta').replace('{name}', name)}</EntryAction>}
    >
      <BrowserExtensionPanel
        diag={diag}
        manualOpen={manualOpen}
        deployedPath={deployedPath}
        copied={copied}
        deployBusy={deployBusy}
        openBusy={openBusy}
        prepareBusy={prepareBusy}
        policyInstalled={diag?.policyInstalled === true}
        policyBusy={policyBusy}
        chromeEnabled={chromeEnabled}
        chromeBusy={chromeBusy || prepareBusy || busy}
        accessLoadFailed={accessLoadFailed}
        onEnableChrome={() => { void enableChrome() }}
        onRetryAccess={() => { void refresh() }}
        onToggleManual={() => { guideTouchedRef.current = true; setManualOpen(open => !open) }}
        onPrepare={() => { void prepare() }}
        onPolicyInstall={() => { void policyInstall() }}
        onPolicyUninstall={() => { void policyUninstall() }}
        onOpenManager={() => { void openManager() }}
        onCopyManagerUrl={() => { void copyManagerUrl() }}
        onCopyExtension={() => { void copyExtension() }}
        onOpenFolder={() => { void openFolder() }}
        onCopyPath={() => { void copyPath() }}
      />
      <EntryPoints descKeys={BROWSER_POINT_DESCS} />
    </EntryModal>
  )
}
