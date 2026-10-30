import { useEffect, useState } from 'react'
import { isSubscriptionWebSearchSource, resolveWebSearchSettings } from '../../../../contracts/web-search-settings'
import { useT } from '../../i18n'
import { kvGet } from './kv'
import { ModelSourceSelect } from './model-shared'
import { useSettingsSnapshot } from './settings-snapshot'
import { useWebSourceAvailability } from './web-source-availability'
import { enqueueSearchSource, searchSourceItems, type SearchSourceSnapshot } from './search-source-state'
import styles from './settings.module.css'

/** Search reuses the subscription credentials managed on the source page. */
export function SearchSourceRow({ configureSource }: { configureSource?: (source: string) => void }) {
  const t = useT()
  const [snapshot, update, beginRead] = useSettingsSnapshot<SearchSourceSnapshot>('function-settings:search-source', { source: null })
  const [retry, setRetry] = useState(0)
  const { availability, failed: availabilityFailed, reload: reloadAvailability } = useWebSourceAvailability()
  useEffect(() => {
    let disposed = false
    const load = () => {
      const publish = beginRead()
      void Promise.all(['klaus.webSearch.source', 'klaus.webSearch.enabled', 'klaus.webSearch.mode'].map(kvGet)).then(([source, enabled, mode]) => {
        if (!disposed) publish(current => current.pending ? current : { source: resolveWebSearchSettings({ source, enabled, mode }).source,
          ...(current.saveError ? { error: current.error, saveError: true } : {}) })
      }, () => { if (!disposed) publish(current => current.pending ? current : { ...current, error: t('settings_section_load_failed') }) })
    }
    load()
    window.addEventListener('klaus:models-changed', load)
    return () => { disposed = true; window.removeEventListener('klaus:models-changed', load) }
  }, [beginRead, retry, t])
  const items = snapshot.source ? searchSourceItems(snapshot.source).map(item => ({ ...item, label: t(`klaus_websearch_source_${item.value}`) }))
    : [{ value: '', label: t('loading'), disabled: true }]
  const source = isSubscriptionWebSearchSource(snapshot.source) ? snapshot.source : ''
  const needsConnection = source && availability[source] === false
  const error = snapshot.error || (availabilityFailed ? t('settings_section_load_failed') : '')
  return (
    <>
      <div className={`pref-row${!snapshot.source ? ' ' + styles['pref-row-disabled'] : ''}`} data-function-search-source aria-busy={Boolean(snapshot.pending)}>
        <div className={styles['pref-row-text']}>
          <div className={styles['pref-row-label']} id="klaus-ws-source-label">{t('klaus_websearch_source')}</div>
        </div>
        <ModelSourceSelect id="klaus-ws-source" className={`kls-select ${styles['model-tier-select']}`} labelId="klaus-ws-source-label"
          value={snapshot.source ?? ''} items={items} disabled={!snapshot.source} bindKey={JSON.stringify([snapshot.source, items])}
          onChange={source => {
            if (!isSubscriptionWebSearchSource(source)) return
            void enqueueSearchSource(snapshot, source, update, {
              set: value => (window as any).settingsApi.kv.set('klaus.webSearch.source', value), error: t('settings_failed'),
              settled: () => { window.dispatchEvent(new Event('klaus:models-changed')) },
            })
          }} />
      </div>
      {needsConnection ? <p className="card-meta" role="status" data-search-connection-required>{t('search_source_connection_required').replace('{source}', t(`klaus_websearch_source_${source}`))}{configureSource ? <> <button className="btn-sm" type="button" onClick={() => configureSource(source)}>{t('media_source_configure')}</button></> : null}</p> : null}
      {error ? <p className="card-meta" role="alert">{error} <button type="button" className="btn-sm" onClick={() => {
        update(current => ({ ...current, error: undefined, saveError: false })); setRetry(value => value + 1); reloadAvailability()
      }}>{t('auth_status_retry')}</button></p> : null}
    </>
  )
}
