import { useEffect, useRef } from 'react'
import { useT } from '../../i18n'
import { EntryToggle } from '../../components/McpEntry'
import { renderMarkdownHtml } from '../../chat/markdown'
import { operationPending, type PluginItem, type PluginOperation } from './plugin-store'
import { PluginDetailTransferPanel } from './PluginTransfer'
import { canCancelPluginOperation, stageLabelKey } from './plugin-transfer'
import styles from './plugins.module.css'

interface Props {
  plugin: PluginItem
  name: string
  description: string
  iconHtml: string
  category: string
  operation?: PluginOperation
  restartRequired: boolean
  onBack: () => void
  onUpdate: () => void
  onInstall: () => void
  onCancel: () => void
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
  onTry: () => void
}

/** A stable detail surface shares the same operation state as the market row. */
export function PluginDetail(props: Props) {
  const { plugin, operation } = props, t = useT(), back = useRef<HTMLButtonElement>(null)
  const pending = operationPending(operation)
  const cancellable = canCancelPluginOperation(operation)
  useEffect(() => { back.current?.focus({ preventScroll: true }) }, [plugin.id])
  const contributions: Array<[string, string[] | undefined]> = [
    [t('skills'), plugin.contributions?.skills], [t('agents'), plugin.contributions?.agents],
    [t('slash_commands'), plugin.contributions?.commands], ['MCP', plugin.contributions?.mcpServers],
    [t('plugins_runtime_hooks'), plugin.contributions?.hooks], [t('plugins_runtime_output_styles'), plugin.contributions?.outputStyles],
  ]
  const activeStageLabel = operation?.cancelling
    ? t('plugins_cancelling')
    : operation?.progress
      ? t(stageLabelKey(operation.progress.stage))
      : null
  const availableLabel = pending
    ? activeStageLabel || t(operation?.phase === 'queued' ? 'plugins_queued' : 'plugins_updating')
    : t('plugins_update_to').replace('{version}', plugin.availableVersion || '')
  const installLabel = pending
    ? activeStageLabel || t(operation?.phase === 'queued' ? 'plugins_queued' : 'plugins_installing')
    : t('plugins_install')
  return <section className={styles['pl-detail']} data-plugin-detail={plugin.id} aria-labelledby="plugin-detail-title">
    <div className={styles['pl-detail-nav']}>
      <button ref={back} type="button" className="btn-sm" data-plugin-back onClick={props.onBack}>← {t('plugins')}</button>
      <span>{props.name}</span>
    </div>
    <div className={styles['pl-detail-heading']}>
      <span className={styles['pl-detail-logo']} aria-hidden="true" dangerouslySetInnerHTML={{ __html: props.iconHtml }} />
      <div className={styles['pl-detail-title']}>
        <h2 id="plugin-detail-title">{props.name}</h2>
        <div className={styles['pl-detail-badges']}>
          <span className="s-badge s-badge-gray">{props.category}</span>
          <span className={styles['pl-version']}>{plugin.installedVersion || plugin.availableVersion || plugin.version}</span>
          {plugin.updateAvailable && <span className="s-badge s-badge-green">{t('plugins_update_available')}</span>}
        </div>
        {plugin.author && <p>{plugin.author}</p>}
      </div>
      <div className={styles['pl-detail-actions']}>
        {plugin.updateAvailable && <button type="button" className="btn-sm" data-detail-action="update" disabled={pending} onClick={props.onUpdate}>
          {pending && <span className={styles['pl-spinner']} aria-hidden="true" />}{availableLabel}
        </button>}
        {!plugin.installed && <button type="button" className="btn-sm" data-detail-action="install" disabled={pending} onClick={props.onInstall}>{pending && <span className={styles['pl-spinner']} aria-hidden="true" />}{installLabel}</button>}
        {(cancellable || operation?.cancelling) && (
          <button type="button" className="btn-sm" data-detail-action="cancel" disabled={!cancellable} onClick={props.onCancel}>
            {t(operation?.cancelling ? 'plugins_cancelling' : 'plugins_cancel')}
          </button>
        )}
        {plugin.installed && <button type="button" className="kls-submit-btn" data-plugin-try disabled={!plugin.enabled || pending || props.restartRequired} onClick={props.onTry}>{t('plugins_try')}</button>}
      </div>
    </div>
    <PluginDetailTransferPanel pluginId={plugin.id} name={props.name} operation={operation} />
    <p className={styles['pl-detail-description']}>{props.description}</p>
    {plugin.installed && <div className={styles['pl-detail-enable']}>
      <div><strong>{t('plugins_enable_for_chats')}</strong><p>{t('plugins_enable_description')}</p></div>
      <EntryToggle checked={!!plugin.enabled} title={t(plugin.enabled ? 'plugins_state_enabled' : 'plugins_state_disabled')} disabled={pending} onChange={props.onToggle} />
    </div>}
    <dl className={styles['pl-detail-meta']}>
      {plugin.installedVersion && <><dt>{t('plugins_installed_version')}</dt><dd>{plugin.installedVersion}</dd></>}
      {plugin.availableVersion && <><dt>{t('plugins_available_version')}</dt><dd>{plugin.availableVersion}</dd></>}
      <dt>{t('plugins_detail_source')}</dt><dd>{plugin.marketplace || plugin.id.slice(plugin.id.lastIndexOf('@') + 1)}</dd>
      {plugin.hasLsp && plugin.lspCommands?.length ? <><dt>{t('plugins_lsp_command')}</dt><dd>{plugin.lspCommands.join(', ')}</dd></> : null}
      {plugin.hasLsp && plugin.lspExtensions?.length ? <><dt>{t('plugins_lsp_extensions')}</dt><dd>{plugin.lspExtensions.join(', ')}</dd></> : null}
    </dl>
    {plugin.compatibility && <section className={styles['pl-detail-section']}><h3>{t('plugins_compatibility')}</h3><p>{plugin.compatibility}</p></section>}
    {plugin.releaseNotes && <section className={styles['pl-detail-section']}><h3>{t('plugins_release_notes')}</h3><div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(plugin.releaseNotes) }} /></section>}
    {contributions.filter(([, values]) => values?.length).map(([label, values]) => <section key={label} className={styles['pl-detail-section']}>
      <h3>{label} <span className={styles['pl-version']}>{values!.length}</span></h3>
      <ul>{values!.map(value => <li key={value}>{value}</li>)}</ul>
    </section>)}
    {plugin.readme && <section className={styles['pl-detail-section']}><h3>{t('plugins_about')}</h3><div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(plugin.readme) }} /></section>}
    {plugin.homepage && /^https?:\/\//i.test(plugin.homepage) && <p><a href={plugin.homepage} target="_blank" rel="noopener noreferrer">{t('plugins_homepage')} ↗</a></p>}
    {plugin.installed && plugin.source !== 'builtin' && <div className={styles['pl-detail-footer']}>
      <button type="button" className="btn-sm" data-detail-action="uninstall" disabled={pending} onClick={props.onUninstall}>{t('settings_skills_uninstall')}</button>
    </div>}
  </section>
}
