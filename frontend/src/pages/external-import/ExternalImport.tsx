// External Agent Import 组件族（迁自 js/external-import.js 的渲染工厂）：
// 设置页 tab（intro/检测中/错误/结果四态）、onboarding 覆层流、自定义清单
// 弹窗、项目级导入弹窗。类名与旧版逐一对应。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import {
  dismissOnboarding, externalImportGroupState, externalImportHeaderSourceProviderId,
  externalImportHasDetectedItems, externalImportItemId, externalImportItemLabel, externalImportItemTypeTitle,
  externalImportProjectItemDescription, externalImportProviderAccent, externalImportProviderLogoSrc,
  externalImportProviders, externalImportRun, externalImportSelectedItems, externalImportState,
  externalImportSummary, externalImportTooltipText, externalImportVisibleItems, getVersion,
  initExternalImportState, replaceSelectedItemIds, setStep, subscribe, toggleGroup, toggleItem, toggleProvider,
} from './state'
import type { ExternalImportGroupEntry, ExternalImportProvider } from './state'
import { SettingsPage } from '../settings/kv'
import styles from './external-import.module.css'

const w = () => window as any

function Raw({ name }: { name: string }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: rawIconHtml(name) }} />
}

function ProviderLogo({ id }: { id: string }) {
  const src = externalImportProviderLogoSrc(id)
  if (src) return <img src={src} alt="" />
  return <Raw name="external-import-external-import-fallback-provider" />
}

function ProviderIcon({ provider }: { provider: ExternalImportProvider }) {
  const id = provider?.id || 'claude-code'
  const hasLogo = Boolean(externalImportProviderLogoSrc(id))
  return (
    <div
      className={`${styles['external-import-provider-icon']} ${styles['external-import-logo-icon']} ${hasLogo ? 'official' : 'fallback'}`}
      style={{ ['--external-import-provider-color' as any]: provider?.accent || externalImportProviderAccent(id) }}
    ><ProviderLogo id={id} /></div>
  )
}

function ImportHeader({ title, subtitle }: { title: string; subtitle: string }) {
  const sourceProviderId = externalImportHeaderSourceProviderId()
  return (
    <div className={styles['external-import-header']}>
      <div className={styles['external-import-icon-row']} aria-hidden="true">
        <div className={`${styles['external-import-source-icon']} ${styles['external-import-logo-icon']} official`}><ProviderLogo id={sourceProviderId} /></div>
        <div className={styles['external-import-arrow']}><Raw name="external-import-external-import-arrow" /></div>
        <div className={styles['external-import-target-icon']}><img src="logo.png" alt="" /></div>
      </div>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  )
}

function ProviderRows() {
  const providers = externalImportProviders()
  const t = useT()
  return (
    <div className={styles['external-import-provider-card']} role="list" aria-label={t('external_import_apps_found')}>
      {providers.map(provider => {
        const checked = externalImportState.selectedProviderIds?.has(provider.id)
        return (
          <div className={styles['external-import-provider-row']} role="listitem" key={provider.id}>
            <ProviderIcon provider={provider} />
            <div className={styles['external-import-provider-copy']}>
              <div className={styles['external-import-provider-name']}>{provider.name}</div>
              <div className={styles['external-import-provider-status']}>
                {provider.itemCount
                  ? t('external_import_provider_count').replace('{count}', String(provider.itemCount))
                  : t('external_import_provider_no_data')}
                {!provider.nativeChatsSupported ? <> · {t('external_import_provider_chats_unsupported')}</> : null}
              </div>
            </div>
            <button
              type="button"
              className={`${styles['external-import-toggle']} ${checked ? 'on' : ''}`}
              disabled={provider.itemCount === 0}
              aria-pressed={checked ? 'true' : 'false'}
              aria-label={provider.name}
              onClick={() => toggleProvider(provider.id)}
            ><span /></button>
          </div>
        )
      })}
    </div>
  )
}

function OptionRow({ groupKey, state, busy, iconName, title, description, tooltip }: {
  groupKey: 'tools' | 'projects' | 'chats'
  state: 'off' | 'on' | 'mixed'
  busy: boolean
  iconName: string
  title: string
  description: string
  tooltip: string
}) {
  const status = externalImportState.pending && state !== 'off' ? 'pending'
    : externalImportState.complete && state !== 'off' ? 'complete' : 'idle'
  return (
    <div className={styles['external-import-option-row']} role="listitem" data-external-import-group={groupKey}>
      <div className={styles['external-import-row-icon']}><Raw name={iconName} /></div>
      <div className={styles['external-import-row-copy']}>
        <div className={styles['external-import-row-title']}>{title}</div>
        <div className={styles['external-import-row-desc']}>{description}</div>
      </div>
      {tooltip ? (
        <button type="button" className={styles['external-import-info']} title={tooltip} aria-label={tooltip}>
          <Raw name="external-import-external-import-info" />
        </button>
      ) : null}
      <button
        type="button"
        className={`${styles['external-import-check']} ${state}`}
        disabled={busy}
        aria-pressed={state === 'mixed' ? 'mixed' : state === 'on' ? 'true' : 'false'}
        aria-label={title}
        onClick={() => toggleGroup(groupKey)}
      >
        {status === 'pending' ? <span className={styles['external-import-spinner']} />
          : status === 'complete' ? <Raw name="external-import-external-import-check" /> : null}
      </button>
    </div>
  )
}

function OptionRows() {
  const t = useT()
  const summary = externalImportSummary()
  const busy = externalImportState.pending || externalImportState.complete
  return (
    <>
      {summary.toolsCount > 0 && (
        <OptionRow
          groupKey="tools" state={externalImportGroupState(summary.tools)} busy={busy}
          iconName="external-import-external-import-settings"
          title={t('external_import_tools_title')} description={t('external_import_tools_desc')}
          tooltip={externalImportTooltipText(summary.tools)}
        />
      )}
      {summary.projectCount > 0 && (
        <OptionRow
          groupKey="projects" state={externalImportGroupState(summary.projects)} busy={busy}
          iconName="external-import-external-import-folder"
          title={t('external_import_projects_title').replace('{count}', String(summary.projectCount))}
          description={t('external_import_projects_desc')}
          tooltip={externalImportTooltipText(summary.projects)}
        />
      )}
      {summary.chatCount > 0 && (
        <OptionRow
          groupKey="chats" state={externalImportGroupState(summary.chats)} busy={busy}
          iconName="external-import-external-import-chats"
          title={t('external_import_chats_title').replace('{count}', String(summary.chatCount))}
          description={t('external_import_chats_desc')}
          tooltip={externalImportTooltipText(summary.chats)}
        />
      )}
    </>
  )
}

/** 自定义清单弹窗（逐条勾选）。 */
function CustomizeModal({ onClose }: { onClose: () => void }) {
  const t = useT()
  const items = externalImportSummary().items
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [picked, setPicked] = useState<Set<string>>(() => new Set(
    items.map(item => externalImportItemId(item)).filter(id => externalImportState.selectedItemIds.has(id)),
  ))
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') || [])
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const nodes = focusable()
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
    document.addEventListener('keydown', onKeyDown, true)
    requestAnimationFrame(() => focusable()[0]?.focus())
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previousFocus?.focus?.()
    }
  }, [])
  return (
    <div className={styles['external-import-modal-backdrop']} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className={styles['external-import-modal']} role="dialog" aria-modal="true"
        aria-labelledby="external-import-customize-title" ref={dialogRef}
      >
        <div className={styles['external-import-modal-title']} id="external-import-customize-title">{t('external_import_customize_title')}</div>
        <div className={styles['external-import-modal-list']}>
          {items.map((item, index) => {
            const id = externalImportItemId(item)
            return (
              <label className={styles['external-import-modal-row']} key={`${id}:${index}`}>
                <input
                  type="checkbox" checked={picked.has(id)}
                  onChange={(e) => {
                    setPicked(prev => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(id)
                      else next.delete(id)
                      return next
                    })
                  }}
                />
                <span>{externalImportItemLabel(item)}</span>
                <small>{item.description || ''}</small>
              </label>
            )
          })}
        </div>
        <div className={styles['external-import-modal-actions']}>
          <button type="button" className={styles['external-import-ghost']} onClick={onClose}>{t('cancel')}</button>
          <button type="button" className={styles['external-import-primary']} onClick={() => { replaceSelectedItemIds(picked); onClose() }}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}

/** onboarding 覆层 / settings-embedded 全版式流（provider 步 → items 步）。 */
export function ExternalImportFlow({ mode, onSkip, onImported }: {
  mode: 'overlay' | 'embedded'
  onSkip: () => void
  onImported: () => void
}) {
  const t = useT()
  useSyncExternalStore(subscribe, getVersion)
  const [customize, setCustomize] = useState(false)
  const summary = externalImportSummary()
  const shellClass = mode === 'overlay' ? styles['external-import-shell'] : `${styles['external-import-shell']} ${styles['settings-embedded']}`

  if (!externalImportHasDetectedItems()) {
    return (
      <div className={`settings-section ${styles['external-import-settings']}`}>
        <div className={styles['external-import-empty']}>
          <ImportHeader title={t('external_import_title')} subtitle={t('external_import_subtitle')} />
          <p className="empty-text">{t('external_import_none')}</p>
          <p className={styles['external-import-note']}>{t('external_import_native_chat_limit')}</p>
        </div>
      </div>
    )
  }

  const busy = externalImportState.pending || externalImportState.complete
  const canImport = externalImportSelectedItems().length > 0

  const body = externalImportState.step === 'items' ? (
    <>
      <ImportHeader title={t('external_import_items_title')} subtitle={t('external_import_items_subtitle')} />
      <div className={styles['external-import-items-card']} role="list" aria-label={t('external_import_options')}>
        <OptionRows />
      </div>
      <div className={styles['external-import-note']}>{t('external_import_preserved_note')}</div>
      <div className={`${styles['external-import-actions']} ${styles['item-actions']}`}>
        {summary.items.length > 0 && (
          <button type="button" className={styles['external-import-ghost']} disabled={busy} onClick={() => { if (!busy) setCustomize(true) }}>{t('external_import_customize')}</button>
        )}
        <button
          type="button" className={styles['external-import-primary']} disabled={busy || !canImport}
          onClick={() => { void externalImportRun({ requireOnboardingDismissal: mode === 'overlay' }).then(ok => { if (ok) onImported() }) }}
        >{externalImportState.pending ? t('external_import_importing') : externalImportState.complete ? t('external_import_imported') : t('external_import_continue')}</button>
        <button type="button" className={styles['external-import-ghost']} disabled={externalImportState.pending} onClick={onSkip}>{t('external_import_skip')}</button>
        {externalImportState.error ? <div className={styles['external-import-error']} role="alert">{externalImportState.error}</div> : null}
        {externalImportState.notice ? <div className={styles['external-import-notice']}>{externalImportState.notice}</div> : null}
      </div>
    </>
  ) : (
    <>
      <ImportHeader title={t('external_import_title')} subtitle={t('external_import_subtitle')} />
      <div className={styles['external-import-provider-area']}>
        <div className={styles['external-import-list-label']}>{t('external_import_apps_found')}</div>
        <ProviderRows />
        <div className={styles['external-import-note']}>{t('external_import_apps_note')}</div>
      </div>
      <div className={styles['external-import-actions']}>
        <button
          type="button" className={styles['external-import-primary']}
          onClick={() => {
            if (!externalImportState.selectedProviderIds?.size) { onSkip(); return }
            setStep('items')
          }}
        >{t('external_import_continue')}</button>
        <button type="button" className={styles['external-import-ghost']} onClick={onSkip}>{t('external_import_skip')}</button>
      </div>
    </>
  )

  return (
    <div className={`settings-section ${styles['external-import-settings']}`}>
      <div className={shellClass}>{body}</div>
      {customize && <CustomizeModal onClose={() => setCustomize(false)} />}
    </div>
  )
}

// ==================== 设置页 tab（紧凑版式四态） ====================

type SettingsTabPhase =
  | { kind: 'intro' }
  | { kind: 'detecting' }
  | { kind: 'error'; message: string }
  | { kind: 'result' }

function SettingsShell({ children }: { children: React.ReactNode }) {
  const t = useT()
  return (
    <SettingsPage title={t('external_import_settings')} subtitle={t('external_import_settings_desc')}>
      <div className={styles['external-import-settings-compact']}>
        {children}
      </div>
    </SettingsPage>
  )
}

export function ExternalImportSettingsTab() {
  const t = useT()
  useSyncExternalStore(subscribe, getVersion)
  const [phase, setPhase] = useState<SettingsTabPhase>({ kind: 'intro' })
  const [customize, setCustomize] = useState(false)

  const detect = async () => {
    setPhase({ kind: 'detecting' })
    try {
      const result = await w().klaus.externalAgentImport.detect({ includeHome: true })
      initExternalImportState(result)
      setPhase({ kind: 'result' })
    } catch (err: any) {
      setPhase({ kind: 'error', message: err?.message || String(err) })
    }
  }

  if (phase.kind === 'intro' || phase.kind === 'error') {
    const isError = phase.kind === 'error'
    return (
      <SettingsShell>
        <div className={`${styles['external-import-settings-card']} ${styles['external-import-settings-action-card']}`}>
          <div className={styles['external-import-settings-card-main']}>
            {isError
              ? <div className={`${styles['external-import-settings-card-icon']} danger`} aria-hidden="true">!</div>
              : <div className={`${styles['external-import-settings-card-icon']} ${styles['external-import-logo-icon']} official`} aria-hidden="true"><ProviderLogo id="claude-code" /></div>}
            <div className={styles['external-import-settings-copy']}>
              <div className={styles['external-import-settings-card-title']}>{isError ? t('external_import_failed') : t('external_import_title')}</div>
              <div className={styles['external-import-settings-card-desc']}>{isError ? phase.message : t('external_import_subtitle')}</div>
            </div>
          </div>
          <button type="button" className={`btn-sm btn-primary ${styles['external-import-settings-action']}`} onClick={() => { void detect() }}>
            {isError ? t('external_import_redetect') : t('external_import_detect_action')}
          </button>
        </div>
      </SettingsShell>
    )
  }

  if (phase.kind === 'detecting') {
    return (
      <SettingsShell>
        <div className={`${styles['external-import-settings-card']} ${styles['external-import-checking-card']}`} aria-live="polite">
          <div className={styles['external-import-settings-card-main']}>
            <div className={styles['external-import-settings-spinner']} aria-hidden="true" />
            <div className={styles['external-import-settings-copy']}>
              <div className={styles['external-import-settings-card-title']}>{t('external_import_checking_title')}</div>
              <div className={styles['external-import-settings-card-desc']}>{t('external_import_checking_desc')}</div>
            </div>
          </div>
          <div className={styles['external-import-checking-steps']} aria-hidden="true">
            <div className={styles['external-import-checking-step']}><span />{t('external_import_check_step_apps')}</div>
            <div className={styles['external-import-checking-step']}><span />{t('external_import_check_step_projects')}</div>
            <div className={styles['external-import-checking-step']}><span />{t('external_import_check_step_sessions')}</div>
          </div>
        </div>
      </SettingsShell>
    )
  }

  // result 态
  const summary = externalImportSummary()
  const providers = externalImportProviders()
  if (!externalImportHasDetectedItems()) {
    return (
      <SettingsShell>
        <div className={`${styles['external-import-settings-card']} ${styles['external-import-settings-action-card']}`}>
          <div className={styles['external-import-settings-card-main']}>
            <div className={`${styles['external-import-settings-card-icon']} ${styles['external-import-logo-icon']} official`} aria-hidden="true"><ProviderLogo id="claude-code" /></div>
            <div className={styles['external-import-settings-copy']}>
              <div className={styles['external-import-settings-card-title']}>{t('external_import_none')}</div>
              <div className={styles['external-import-settings-card-desc']}>{t('external_import_native_chat_limit')}</div>
            </div>
          </div>
          <button type="button" className={`btn-sm btn-primary ${styles['external-import-settings-action']}`} onClick={() => { void detect() }}>{t('external_import_redetect')}</button>
        </div>
      </SettingsShell>
    )
  }

  const busy = externalImportState.pending || externalImportState.complete
  const canImport = externalImportSelectedItems().length > 0
  const selectedCount = externalImportState.selectedProviderIds?.size || 0

  const stepBody = externalImportState.step === 'items' ? (
    <>
      <div className={styles['external-import-items-card']} role="list" aria-label={t('external_import_options')}>
        <OptionRows />
      </div>
      <div className={styles['external-import-settings-note']}>{t('external_import_preserved_note')}</div>
      <div className={styles['external-import-settings-actions']}>
        <button type="button" className={styles['external-import-ghost']} disabled={busy} onClick={() => { if (!busy) setStep('provider') }}>{t('back')}</button>
        {summary.items.length > 0 && (
          <button type="button" className={styles['external-import-ghost']} disabled={busy} onClick={() => { if (!busy) setCustomize(true) }}>{t('external_import_customize')}</button>
        )}
        <button type="button" className="btn-sm btn-primary" disabled={busy || !canImport} onClick={() => { void externalImportRun() }}>
          {externalImportState.pending ? t('external_import_importing') : externalImportState.complete ? t('external_import_imported') : t('external_import_start_import')}
        </button>
      </div>
      {externalImportState.error ? <div className={styles['external-import-error']} role="alert">{externalImportState.error}</div> : null}
      {externalImportState.notice ? <div className={styles['external-import-notice']}>{externalImportState.notice}</div> : null}
    </>
  ) : (
    <div className={styles['external-import-provider-area']}>
      <div className={styles['external-import-list-label']}>{t('external_import_apps_found')}</div>
      <ProviderRows />
      <div className={styles['external-import-settings-note']}>{t('external_import_apps_note')}</div>
      <div className={styles['external-import-settings-actions']}>
        <button type="button" className="btn-sm btn-primary" disabled={!selectedCount} onClick={() => setStep('items')}>{t('external_import_continue')}</button>
      </div>
    </div>
  )

  return (
    <SettingsShell>
      <div className={styles['external-import-settings-card']}>
        <div className={styles['external-import-settings-result-head']}>
          <div className={styles['external-import-settings-copy']}>
            <div className={styles['external-import-settings-card-title']}>{t('external_import_found_title').replace('{count}', String(providers.filter(provider => provider.itemCount > 0).length))}</div>
            <div className={styles['external-import-settings-card-desc']}>{t('external_import_found_desc')}</div>
          </div>
          <button type="button" className={`${styles['external-import-ghost']} ${styles['external-import-settings-small-action']}`} disabled={externalImportState.pending} onClick={() => { void detect() }}>{t('external_import_redetect')}</button>
        </div>
        {stepBody}
      </div>
      {customize && <CustomizeModal onClose={() => setCustomize(false)} />}
    </SettingsShell>
  )
}

// ==================== 项目级导入弹窗 ====================

export function ExternalImportProjectDialog({ onFinish }: { onFinish: () => void }) {
  const t = useT()
  useSyncExternalStore(subscribe, getVersion)
  const items = externalImportVisibleItems()
  const selectedItems = externalImportSelectedItems()
  const busy = externalImportState.pending || externalImportState.complete

  const run = async () => {
    const ok = await externalImportRun()
    if (ok) window.setTimeout(() => onFinish(), 500)
  }

  return (
    <div
      className={`kls-modal-overlay ${styles['external-import-project-dialog-backdrop']}`}
      id="external-import-project-dialog"
      onClick={e => { if (e.target === e.currentTarget && !externalImportState.pending) onFinish() }}
    >
      <div className={`kls-modal ${styles['external-import-project-dialog-panel']}`} role="dialog" aria-modal="true" aria-labelledby="external-import-project-dialog-title">
        <div className="kls-modal-head">
          <div>
            <h3 id="external-import-project-dialog-title" className="kls-modal-title">{t('external_import_project_dialog_title')}</h3>
            <p className="kls-modal-subtitle">{t('external_import_project_dialog_subtitle')}</p>
          </div>
          <button
            type="button" className="kls-modal-close" aria-label={t('external_import_project_dialog_close')}
            disabled={externalImportState.pending}
            onClick={() => { if (!externalImportState.pending) onFinish() }}
          ><Raw name="close" /></button>
        </div>
        <div className={`kls-modal-body ${styles['external-import-project-dialog-body']}`}>
          <div className={styles['external-import-project-dialog-list']} role="list" aria-label={t('external_import_project_dialog_list')}>
            {items.map((item, index) => {
              const id = externalImportItemId(item)
              const checked = externalImportState.selectedItemIds.has(id)
              const status = externalImportState.pending && checked ? 'pending' : externalImportState.complete && checked ? 'complete' : 'idle'
              return (
                <div className={styles['external-import-project-dialog-item']} role="listitem" key={`${id}:${index}`}>
                  <button
                    type="button"
                    className={`${styles['external-import-project-dialog-row']} ${checked ? 'selected' : ''}`}
                    disabled={externalImportState.pending}
                    aria-pressed={checked}
                    onClick={() => { if (!externalImportState.pending) toggleItem(id) }}
                  >
                    <span className={styles['external-import-project-dialog-row-copy']}>
                      <span className={styles['external-import-project-dialog-row-title']}>{externalImportItemTypeTitle(item)}</span>
                      <span className={styles['external-import-project-dialog-row-desc']}>{externalImportProjectItemDescription(item)}</span>
                    </span>
                    <span className={styles['external-import-project-dialog-check']} aria-hidden="true">
                      {status === 'pending' ? <span className={styles['external-import-spinner']} />
                        : checked ? <Raw name="external-import-external-import-check" /> : null}
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
          {externalImportState.error ? <div className={styles['external-import-project-dialog-error']} role="alert">{externalImportState.error}</div> : null}
        </div>
        <div className="kls-modal-foot">
          <button type="button" className="klaus-dialog-btn klaus-dialog-cancel" disabled={busy} onClick={() => { if (!externalImportState.pending) onFinish() }}>{t('external_import_project_dialog_skip')}</button>
          <button type="button" className="klaus-dialog-btn klaus-dialog-confirm" disabled={busy || selectedItems.length === 0} onClick={() => { void run() }}>
            {externalImportState.pending ? t('external_import_importing') : externalImportState.complete ? t('external_import_imported') : t('external_import_project_dialog_continue')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** onboarding 覆层容器（导入成功 650ms 后自关）。 */
export function ExternalImportOnboarding({ onClose }: { onClose: () => void }) {
  const t = useT()
  useSyncExternalStore(subscribe, getVersion)
  return (
    <div className={styles['external-import-onboarding-inner']}>
      <ExternalImportFlow
        mode="overlay"
        onSkip={() => {
          void dismissOnboarding().then(onClose).catch((error: unknown) => {
            w().showToast?.((error as Error | null)?.message || t('external_import_failed'))
          })
        }}
        onImported={() => { window.setTimeout(onClose, 650) }}
      />
    </div>
  )
}
