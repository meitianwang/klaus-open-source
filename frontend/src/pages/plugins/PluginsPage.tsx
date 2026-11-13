import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { PageHeader } from '../../components/PageHeader'
import { MarketCard, MarketGrid } from '../../components/Market'
import { EntryCard, EntryList, EntryToggle, EntryIconButton, StateIconButton } from '../../components/McpEntry'
import { ModalPortal } from '../../components/ModalPortal'
import { BrowserCapabilityModal } from '../mcp/browser-connect'
import { fillGlyph24Sized } from '../../icons/registry'
import { pluginCategoryLabel, skillLogoImgHtml } from '../skills/localize'
import { getPluginLogoSrc } from '../../icons/extension-logos'
import { resourceReference } from '../../chat/composer/resource-reference'
import { PluginDetail } from './PluginDetail'
import { PluginInlineProgressBar, PluginTransferBanner } from './PluginTransfer'
import { canCancelPluginOperation, compactTransferSummary, stageLabelKey, transferDisplayPercent } from './plugin-transfer'
import { operationPending, pluginErrorKey, pluginStore, type PluginItem, type PluginOperation } from './plugin-store'
import { pluginActivationNote } from './activation-note'
import styles from './plugins.module.css'

const w = () => window as any
const showToast = (text: string) => w().showToast?.(text)
// Failure dialogs queue up: a batch that fails twice must not stack two
// modal overlays, and each failure is acknowledged exactly once per page load.
const diagnosedFailures = new Set<string>()
let failureDialogQueue: Promise<unknown> = Promise.resolve()
const pluginName = (plugin: PluginItem) => w().localizePluginName(plugin)
const pluginDescription = (plugin: PluginItem) => w().localizePluginDescription(plugin)
const pluginCategory = (plugin: PluginItem) => plugin.source === 'builtin' ? 'builtin' : String(plugin.category || 'other')
const pluginState = (plugin: PluginItem) => !plugin.installed ? 'install' : plugin.enabled ? 'on' : 'off'
function pluginGlyph(plugin: PluginItem, size = 20): string {
  const logo = getPluginLogoSrc(plugin)
  if (logo) return skillLogoImgHtml(logo)
  const body = w().KLAUS_GLYPH_LIBRARY[w().getPluginIconName(plugin)] || w().KLAUS_GLYPH_LIBRARY.sparkles
  return fillGlyph24Sized(body, size)
}

export function PluginsPage() {
  const t = useT()
  const snapshot = useSyncExternalStore(pluginStore.subscribe, pluginStore.getSnapshot)
  const { data, operations, checking, batch } = snapshot
  const [view, setView] = useState<'market' | 'installed'>('market')
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [browserModal, setBrowserModal] = useState<{ enabled: boolean } | null>(null)
  const listScroll = useRef(0)
  useEffect(() => {
    void pluginStore.load()
    void pluginStore.check()
    const unsubscribe = w().klaus?.on?.appPreferencesChanged?.(({ key }: { key?: string }) => {
      if (key === 'plugins') void pluginStore.load()
    })
    const focus = () => {
      if (document.getElementById('plugins-view')?.classList.contains('active')) void pluginStore.check()
    }
    window.addEventListener('focus', focus)
    return () => { unsubscribe?.(); window.removeEventListener('focus', focus) }
  }, [])

  const uninstall = async (plugin: PluginItem) => {
    if (operationPending(operations[plugin.id])) return
    if (!(await w().klausDialog.confirm({ message: `${t('plugins_uninstall_confirm')}\n\n${pluginName(plugin)}`, danger: true }))) return
    if (await pluginStore.uninstall(plugin)) showToast(t('settings_skills_uninstalled_toast'))
  }
  const completionToast = (base: string, plugin: PluginItem): string => {
    const note = pluginActivationNote(pluginStore.getSnapshot().operations[plugin.id]?.result, t)
    return note ? `${base}${note}` : base
  }
  const update = async (plugin: PluginItem) => {
    if (operationPending(operations[plugin.id])) return
    if (await pluginStore.update(plugin)) showToast(completionToast(t('plugins_updated_named').replace('{name}', pluginName(plugin)), plugin))
  }
  const install = async (plugin: PluginItem) => {
    if (operationPending(operations[plugin.id])) return
    if (await pluginStore.install(plugin)) showToast(completionToast(t('plugins_installed_named').replace('{name}', pluginName(plugin)), plugin))
  }
  const cancel = async (plugin: PluginItem) => {
    if (await pluginStore.cancel(plugin.id)) {
      showToast(t('plugins_cancelled_named').replace('{name}', pluginName(plugin)))
    }
  }
  const diagnoseWithKlaus = (operation: PluginOperation, name: string) => {
    const composer = w().klausComposer
    if (!composer?.startNewChat || !composer?.submit) { showToast(t('plugins_try_unavailable')); return }
    const key = operation.action === 'update' ? 'plugins_diagnose_query_update' : operation.action === 'install' ? 'plugins_diagnose_query_install' : 'plugins_diagnose_query_change'
    const query = t(key).replace('{name}', name) + (operation.diagnosticLog ? t('plugins_diagnose_log_line').replace('{path}', operation.diagnosticLog) : '')
    composer.startNewChat()
    void composer.submit(query)
  }
  useEffect(() => {
    for (const [id, operation] of Object.entries(operations)) {
      if (operation.phase !== 'error' || operation.failedAt == null) continue
      const token = `${id}:${operation.failedAt}`
      if (diagnosedFailures.has(token)) continue
      diagnosedFailures.add(token)
      failureDialogQueue = failureDialogQueue.then(async () => {
        const plugin = pluginStore.getSnapshot().data?.plugins.find(row => row.id === id)
        const name = plugin ? pluginName(plugin) : id
        const title = t(operation.action === 'update' ? 'plugins_update_failed_named' : operation.action === 'install' ? 'plugins_install_failed_named' : 'plugins_change_failed_named').replace('{name}', name)
        const accepted = await w().klausDialog.confirm({ title, message: t('plugins_failure_diagnose_hint'), confirmText: t('plugins_diagnose_with_klaus'), variant: 'error' })
        if (accepted) diagnoseWithKlaus(operation, name)
        pluginStore.dismiss(id)
      })
    }
  }, [operations])
  const openPlugin = (plugin: PluginItem) => {
    if (plugin.source === 'builtin' && plugin.name === 'browser') {
      void Promise.resolve(w().settingsApi?.browserUse?.get?.()).then(config => setBrowserModal({ enabled: !!config?.enabled })).catch(error => showToast(String(error)))
      return
    }
    listScroll.current = document.getElementById('plugins-view')?.scrollTop || 0
    setDetailId(plugin.id)
    w().klsPageViews?.scrollViewToTop('plugins-view')
  }
  const closeDetail = () => {
    const id = detailId
    setDetailId(null)
    requestAnimationFrame(() => {
      const page = document.getElementById('plugins-view')
      if (page) page.scrollTop = listScroll.current
      document.querySelector<HTMLElement>(`[data-plugin-id="${CSS.escape(id || '')}"] [data-card-open]`)?.focus({ preventScroll: true })
    })
  }
  const tryPlugin = (plugin: PluginItem) => {
    if (!plugin.installed || !plugin.enabled || pluginStore.getSnapshot().data?.restartRequired) return
    const composer = w().klausComposer
    if (!composer?.insertReference || !composer?.startNewChat) { showToast(t('plugins_try_unavailable')); return }
    composer.startNewChat()
    composer.insertReference({ ...resourceReference('plugin', pluginName(plugin), plugin.id), replaceDraft: true })
  }
  const addMarketplace = async () => {
    if (adding) return
    const source = await w().klausDialog.prompt?.({ title: t('plugins_add_marketplace'), message: t('plugins_add_marketplace_message'), placeholder: 'owner/repo', confirmText: t('plugins_add_marketplace') })
    if (typeof source !== 'string' || !source.trim()) return
    setAdding(true)
    try {
      const result = await w().klaus.plugins.addMarketplace(source.trim())
      if (result?.ok !== true) throw new Error(result?.error || t('toast_unknown'))
      showToast(t(result.alreadyAdded ? 'plugins_marketplace_already_added' : 'plugins_marketplace_added').replace('{name}', result.name || source.trim()))
      await pluginStore.load()
      setView('market')
      setCategory('all')
    } catch (error) { showToast(`${t('toast_error_prefix')}${error instanceof Error ? error.message : error}`) }
    finally { setAdding(false) }
  }

  const all = data?.plugins ?? []
  const installedCount = all.filter(plugin => plugin.installed).length
  const updates = all.filter(plugin => plugin.installed && plugin.updateAvailable)
  const market = all.filter(p => p.id.endsWith('@builtin') || p.id.endsWith('@klaus-official'))
  const inView = view === 'installed' ? all.filter(plugin => plugin.installed) : market
  const searched = inView.filter(plugin => w().filterTextMatches(search, w().getPluginSearchValues(plugin))).sort((a, b) => pluginName(a).localeCompare(pluginName(b)))
  const groups = new Map<string, PluginItem[]>()
  for (const plugin of searched) {
    const key = pluginCategory(plugin)
    groups.set(key, [...(groups.get(key) ?? []), plugin])
  }
  const categoryKeys = [...groups.keys()].filter(key => key !== 'other' && key !== 'builtin').sort()
  if (groups.has('builtin')) categoryKeys.unshift('builtin')
  if (groups.has('other')) categoryKeys.push('other')
  const categoryTabs = [{ key: 'all', label: t('plugins_category_all'), count: searched.length }, ...categoryKeys.map(key => ({ key, label: pluginCategoryLabel(key), count: groups.get(key)!.length }))]
  const activeCategory = view === 'market' && categoryTabs.some(tab => tab.key === category) ? category : 'all'
  const visiblePlugins = activeCategory === 'all' ? searched : groups.get(activeCategory) ?? []
  const esc = w().esc
  const tabs = [
    { key: 'market', label: t('plugins_tab_market'), count: market.length },
    { key: 'installed', label: t('plugins_tab_installed'), count: installedCount },
  ]
  // The batch action rides the tab row: the transient checking indicator and
  // the update-all button share its trailing slot, so no standalone status
  // strip sits between the filters and the cards.
  const checkingNow = checking || !!data?.updateCheck?.checking
  const updateAllIdle = !(batch?.running || updates.every(plugin => operationPending(operations[plugin.id])))
  const tabActionsHtml = checkingNow || updates.length > 0 ? `<div class="${styles['pl-tab-actions']}">${checkingNow ? `<span class="${styles['pl-tab-status']}" role="status"><span class="${styles['pl-spinner']}" aria-hidden="true"></span>${esc(t('plugins_checking_updates'))}</span>` : ''}${updates.length > 0 ? `<button type="button" class="btn-sm" data-plugin-update-all${updateAllIdle ? '' : ' disabled'}>${esc(t('plugins_update_all').replace('{count}', String(updates.length)))}</button>` : ''}</div>` : ''
  const tabsBodyHtml = !data ? undefined : `<div class="sk-tabbar"><div class="sk-tabs" role="tablist" aria-label="${esc(t('plugins'))}">${tabs.map(tab => `<button type="button" class="sk-tab ${view === tab.key ? 'active' : ''}" role="tab" aria-selected="${view === tab.key}" tabindex="${view === tab.key ? '0' : '-1'}" data-plugin-tab="${tab.key}">${esc(tab.label)} <span class="sk-tab-count">${tab.count}</span></button>`).join('')}</div>${tabActionsHtml}</div>${view === 'market' && categoryTabs.length > 2 ? `<div class="sk-category-tabs" role="tablist" aria-label="${esc(t('plugins'))}">${categoryTabs.map(tab => `<button type="button" class="qc-scope-tab ${activeCategory === tab.key ? 'active' : ''}" role="tab" aria-selected="${activeCategory === tab.key}" tabindex="${activeCategory === tab.key ? '0' : '-1'}" data-plugin-category-tab="${esc(tab.key)}">${esc(tab.label)} <span class="qc-scope-tab-count">${tab.count}</span></button>`).join('')}</div>` : ''}`
  const header = <PageHeader titleKey="plugins" subtitleKey="plugins_subtitle" bodyHtml={tabsBodyHtml}
    refresh={{ id: 'pl-refresh', titleKey: 'plugins_check_updates', disabled: checking, onClick: () => pluginStore.check(true) }}
    search={{ id: 'pl-search-input', placeholderKey: 'search_placeholder', value: search, onInput: setSearch }}
    create={{ btnId: 'pl-add-btn', menuId: 'pl-add-menu', disabled: adding, items: [{ action: 'marketplace', labelKey: 'plugins_add_marketplace', iconHtml: w().klsTopbar.icons.install }], onAction: () => { void addMarketplace() } }} />
  const versionLabel = (plugin: PluginItem) => plugin.updateAvailable ? `${plugin.installedVersion} → ${plugin.availableVersion}` : plugin.installedVersion || plugin.availableVersion || plugin.version || ''
  const busyLabel = (operation?: PluginOperation) => {
    if (operation?.cancelling) return t('plugins_cancelling')
    if (operation?.phase === 'queued') return t('plugins_queued')
    if (operation?.progress) {
      const stageText = t(stageLabelKey(operation.progress.stage))
      return operation.progress.total > 0 || operation.progress.stage !== 'downloading'
        ? `${stageText} ${transferDisplayPercent(operation.progress)}%`
        : stageText
    }
    return operation?.action === 'install' ? t('plugins_installing') : operation?.action === 'update' ? t('plugins_updating') : t('plugins_busy')
  }
  const subtitleSlot = (plugin: PluginItem, operation?: PluginOperation) => {
    const summary = compactTransferSummary(operation, t)
    return summary
      ? <span className={styles['pl-transfer-inline-meta']} data-plugin-transfer-meta={plugin.id}>{summary}</span>
      : <span className={styles['pl-version']}>{versionLabel(plugin)}</span>
  }
  const cancelControl = (plugin: PluginItem, operation?: PluginOperation) => {
    const cancellable = canCancelPluginOperation(operation)
    if (!cancellable && !operation?.cancelling) return null
    return (
      <button
        type="button"
        className="btn-sm"
        data-plugin-cancel={plugin.id}
        disabled={!cancellable}
        onClick={event => { event.stopPropagation(); void cancel(plugin) }}
      >
        {t(operation?.cancelling ? 'plugins_cancelling' : 'plugins_cancel')}
      </button>
    )
  }
  const updateButton = (plugin: PluginItem) => plugin.updateAvailable && !operationPending(operations[plugin.id]) && <button type="button" className="btn-sm" data-plugin-update={plugin.id}
    onClick={event => { event.stopPropagation(); void update(plugin) }}>
    {t('plugins_update_to').replace('{version}', plugin.availableVersion || '')}
  </button>
  // The single-column list has no trailing state control, so its update pill
  // owns the busy state itself: spinner plus queued/updating label.
  const updateListButton = (plugin: PluginItem) => {
    const operation = operations[plugin.id]
    if (!plugin.updateAvailable) return null
    const pending = operationPending(operation)
    return <button type="button" className="btn-sm" data-plugin-update={plugin.id} disabled={pending}
      onClick={event => { event.stopPropagation(); void update(plugin) }}>
      {pending && <span className={styles['pl-spinner']} aria-hidden="true" />}
      {pending ? busyLabel(operation) : t('plugins_update_to').replace('{version}', plugin.availableVersion || '')}
    </button>
  }
  const detail = detailId ? all.find(plugin => plugin.id === detailId) : null
  const activeTransferId = Object.keys(operations).find(id => {
    const op = operations[id]
    return op?.phase === 'running' && (op.action === 'install' || op.action === 'update') && Boolean(op.progress)
  })
  const activeTransferPlugin = activeTransferId ? all.find(plugin => plugin.id === activeTransferId) : null
  const showTransferBanner = Boolean(activeTransferPlugin && !visiblePlugins.some(plugin => plugin.id === activeTransferPlugin.id))
  const queuedCount = Object.values(operations).filter(op => op?.phase === 'queued' && (op.action === 'install' || op.action === 'update')).length
  const refreshError = snapshot.refreshError || data?.updateCheck?.error || data?.marketplaceError

  return <div className="sk-section" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tab = (event.target as Element).closest<HTMLElement>('[data-plugin-tab], [data-plugin-category-tab]')
    if (!tab) return
    const selector = tab.hasAttribute('data-plugin-tab') ? '[data-plugin-tab]' : '[data-plugin-category-tab]'
    const tabs = Array.from(tab.parentElement?.querySelectorAll<HTMLElement>(selector) ?? [])
    const current = tabs.indexOf(tab)
    if (current < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length
    tabs[next]?.focus()
    tabs[next]?.click()
  }} onClick={event => {
    const target = event.target as Element
    if (target.closest('[data-plugin-update-all]')) { void pluginStore.updateAll(); return }
    const tab = target.closest<HTMLElement>('[data-plugin-tab]')
    if (tab) {
      setView(tab.dataset.pluginTab === 'installed' ? 'installed' : 'market')
      w().klsPageViews?.scrollViewToTop('plugins-view')
    }
    const category = target.closest<HTMLElement>('[data-plugin-category-tab]')
    if (category) setCategory(category.dataset.pluginCategoryTab || 'all')
  }}>
    {detail ? <PluginDetail plugin={detail} name={pluginName(detail)} description={pluginDescription(detail)} iconHtml={pluginGlyph(detail, 32)} category={pluginCategoryLabel(pluginCategory(detail))}
      operation={operations[detail.id]} restartRequired={!!data?.restartRequired} onBack={closeDetail} onUpdate={() => { void update(detail) }} onInstall={() => { void install(detail) }} onCancel={() => { void cancel(detail) }}
      onToggle={enabled => { void pluginStore.toggle(detail, enabled) }} onUninstall={() => { void uninstall(detail) }} onTry={() => tryPlugin(detail)} /> : <>
      {header}
      {batch && <p className={styles['pl-batch-status']} role="status" data-plugin-batch>{t(batch.running ? 'plugins_batch_progress' : batch.failed ? 'plugins_batch_partial' : 'plugins_batch_success').replace('{completed}', String(batch.completed)).replace('{total}', String(batch.total)).replace('{failed}', String(batch.failed))}</p>}
      {showTransferBanner && activeTransferPlugin && operations[activeTransferPlugin.id] && (
        <PluginTransferBanner
          plugin={activeTransferPlugin}
          name={pluginName(activeTransferPlugin)}
          iconHtml={pluginGlyph(activeTransferPlugin, 20)}
          operation={operations[activeTransferPlugin.id]!}
          queuedCount={queuedCount}
          onOpen={() => openPlugin(activeTransferPlugin)}
          onCancel={() => { void cancel(activeTransferPlugin) }}
        />
      )}
      {!data && snapshot.loadError && <div className="mcp-empty" role="alert"><p>{t(pluginErrorKey(snapshot.loadError))}</p><button type="button" className="btn-sm" onClick={() => { void pluginStore.load() }}>{t('plugins_retry')}</button></div>}
      {!data && !snapshot.loadError && <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />}
      {data && (view === 'market' ? <MarketGrid empty={!visiblePlugins.length} emptyText={search ? t('plugins_search_empty') : t('plugins_empty')}>
        {visiblePlugins.map(plugin => {
          const operation = operations[plugin.id]
          return <div key={plugin.id} className={styles['pl-card-wrap']}>
            <MarketCard cardKey={`plg:${plugin.id}`} datasets={{ 'plugin-id': plugin.id, 'plugin-state': pluginState(plugin) }} iconHtml={pluginGlyph(plugin)} title={pluginName(plugin)} desc={pluginDescription(plugin)} subtitle={subtitleSlot(plugin, operation)}
              onOpen={() => openPlugin(plugin)} controls={<>{updateButton(plugin)}{cancelControl(plugin, operation)}<StateIconButton state={pluginState(plugin)} label={busyLabel(operation)}
                disabled={operationPending(operation)} busy={operationPending(operation)} onClick={() => { if (plugin.installed || plugin.source === 'builtin') openPlugin(plugin); else void install(plugin) }} /></>} />
            <PluginInlineProgressBar operation={operation} label={`${pluginName(plugin)} ${busyLabel(operation)}`} />
          </div>
        })}
      </MarketGrid> : <EntryList empty={!visiblePlugins.length} emptyText={search ? t('plugins_search_empty') : t('plugins_empty')}>
        {visiblePlugins.map(plugin => {
          const operation = operations[plugin.id]
          return <div key={plugin.id} className={styles['pl-row-wrap']}>
            <EntryCard cardKey={`plg:${plugin.id}`} datasets={{ 'plugin-id': plugin.id }} iconHtml={pluginGlyph(plugin)} title={pluginName(plugin)} desc={pluginDescription(plugin)} meta={subtitleSlot(plugin, operation)}
              dot={{ state: plugin.enabled ? 'ok' : 'idle', label: t(plugin.enabled ? 'plugins_state_enabled' : 'plugins_state_disabled') }} onOpen={() => openPlugin(plugin)} onToggleKey={() => { if (!operationPending(operation)) void pluginStore.toggle(plugin, !plugin.enabled) }}
              controls={<>{updateListButton(plugin)}{cancelControl(plugin, operation)}<EntryToggle checked={!!plugin.enabled} title={t(plugin.enabled ? 'plugins_state_enabled' : 'plugins_state_disabled')} disabled={operationPending(operation)} onChange={enabled => { void pluginStore.toggle(plugin, enabled) }} />
                {plugin.source !== 'builtin' && <EntryIconButton iconName="trash" title={t('settings_skills_uninstall')} disabled={operationPending(operation)} onClick={() => { void uninstall(plugin) }} />}</>} />
            <PluginInlineProgressBar operation={operation} label={`${pluginName(plugin)} ${busyLabel(operation)}`} />
          </div>
        })}
      </EntryList>)}
    </>}
    {refreshError && <div className={`${styles['pl-market-note']} ${styles['pl-note-error']}`} role="alert" data-plugin-check-error>
      <p>{t('plugins_check_failed')} {t(pluginErrorKey(refreshError))}</p><button type="button" className="btn-sm" disabled={checking} onClick={() => { void pluginStore.check(true) }}>{t('plugins_retry')}</button>
      <details className={styles['pl-error-details']}><summary>{t('plugins_error_details')}</summary><p>{refreshError}</p></details>
    </div>}
    {snapshot.readError && <p className={styles['pl-market-note']} role="status">{t('plugins_result_refresh_warning')} <button type="button" className="btn-sm" onClick={() => { void pluginStore.load() }}>{t('plugins_retry')}</button></p>}
    {data?.restartRequired && <div className={styles['pl-market-note']} role="status">{t('plugins_pending_restart')} <button type="button" className="btn-sm" onClick={() => {
      void w().klaus.systemPermissions.restartApp().catch((error: unknown) => showToast(String(error instanceof Error ? error.message : error)))
    }}>{t('sys_auth_restart_now')}</button></div>}
    {browserModal && <ModalPortal><BrowserCapabilityModal enabled={browserModal.enabled} onClose={() => { setBrowserModal(null); void pluginStore.load() }} /></ModalPortal>}
  </div>
}
