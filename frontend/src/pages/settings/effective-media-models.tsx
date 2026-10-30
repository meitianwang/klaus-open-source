import { useEffect, useState } from 'react'
import type { EffectiveMediaModelCatalog, EffectiveMediaModelOption, MediaModelKind } from '../../../../contracts/effective-media-models'
import { useT } from '../../i18n'
import { KlsSelect, ModelSourceSelect, sourceLabel } from './model-shared'
import { useSettingsSnapshot } from './settings-snapshot'
import styles from './settings.module.css'
import { enqueueMediaSelection, mediaSelectionChange, type MediaSelectionSnapshot } from './effective-media-state'

export function effectiveMediaModeItems(catalog: EffectiveMediaModelCatalog, label: (source: string) => string) {
  return [...new Set(catalog.options.map(option => option.source))]
    .filter(source => source === catalog.selection || catalog.options.some(option => option.source === source && (option.available || option.selectable)))
    .map(source => ({ value: source, label: label(source) }))
}

export function effectiveMediaModelItems(options: EffectiveMediaModelOption[], serviceDefault: string, unavailable: string) {
  return options.map(option => ({ value: option.modelId, disabled: !option.available && !option.selectable,
    label: `${option.label || option.modelId || serviceDefault}${option.available || option.selectable ? '' : ` (${unavailable})`}` }))
}

/** A source without a model choice states its effective model instead of offering one. */
export function effectiveMediaModelStaticText(selection: string, options: EffectiveMediaModelOption[], currentModelId: string, serviceDefault: string, disabledLabel: string): string {
  if (selection === 'none') return disabledLabel
  if (currentModelId) return options.find(option => option.modelId === currentModelId)?.label || currentModelId
  return serviceDefault
}

/** A function keeps source/model rows whenever any of its modes offers a model choice. */
export function hasMultipleMediaModels(options: EffectiveMediaModelOption[]): boolean {
  const modes = new Map<string, Set<string>>()
  for (const option of options) {
    if (!modes.has(option.source)) modes.set(option.source, new Set())
    modes.get(option.source)!.add(option.modelId)
  }
  return [...modes.values()].some(models => models.size > 1)
}

export function EffectiveMediaModels({ kind, id, label }: { kind: MediaModelKind; id: string; label: string }) {
  const t = useT()
  const [snapshot, setSnapshot, beginRead] = useSettingsSnapshot<MediaSelectionSnapshot>(`effective-models:${kind}`, { reply: null })
  const [retry, setRetry] = useState(0)
  const reply = snapshot.reply
  useEffect(() => {
    let disposed = false
    const load = () => {
      const publish = beginRead()
      void (window as any).klaus.settings[`${kind}Selection`].get().then((value: EffectiveMediaModelCatalog) => {
        if (disposed) return
        if (!value?.ok || !value.current || !value.currentBySource || !Array.isArray(value.options)) {
          publish(current => current.pending ? current : { ...current, error: t('native_media_models_unavailable'), saveError: false })
        } else publish(current => current.pending ? current : { reply: value, ...(current.saveError ? { error: current.error, saveError: true } : {}) })
      }, () => { if (!disposed) publish(current => current.pending ? current : { ...current, error: t('native_media_models_unavailable'), saveError: false }) })
    }
    load()
    window.addEventListener('klaus:models-changed', load)
    return () => { disposed = true; window.removeEventListener('klaus:models-changed', load) }
  }, [kind, beginRead, retry, t])
  const source = (value: string) => value === 'none' ? t('media_generation_disabled') : sourceLabel(value)
  const models = reply?.options.filter(option => option.source === reply.selection) ?? []
  const modelItems = !reply ? [{ value: '', label: t('loading'), disabled: true }]
    : effectiveMediaModelItems(models, t('media_model_service_default'), t('native_media_model_unavailable'))
  const modeItems = reply ? effectiveMediaModeItems(reply, source) : [{ value: '', label: t('loading'), disabled: true }]
  const modelRows = kind === 'music' || Boolean(reply && hasMultipleMediaModels(reply.options))
  // A model dropdown only exists where the selected source actually offers a
  // choice. Single-model and service-managed routes state their effective
  // model as a value; a disabled dropdown reading like a placeholder made
  // those routes look unloaded.
  const modelChoice = reply !== null && reply.selection !== 'none' && hasMultipleMediaModels(models) && models.some(option => option.available || option.selectable)
  const save = (value: string, field: 'source' | 'model') => {
    if (!reply) return
    const change = mediaSelectionChange(reply, value, field)
    if (!change) return
    void enqueueMediaSelection(snapshot, change, setSnapshot, {
      set: (source, model) => (window as any).klaus.settings[`${kind}Selection`].set(source, model),
      error: t('settings_failed'),
      settled: () => { window.dispatchEvent(new Event('klaus:models-changed')) },
    }, () => {
      const connectionKey = kind === 'image' ? 'image_source_connection_required'
        : kind === 'video' ? 'video_source_connection_required' : kind === 'music' ? 'music_source_connection_required' : 'audio_source_connection_required'
      if (field === 'source' && connectionKey && reply.options.some(option => option.source === change.source && option.connected === false)) {
        ;(window as any).showToast?.(t(connectionKey).replace('{source}', source(change.source)))
      }
    })
  }
  const disabled = !reply
  const selectClass = `kls-select ${styles['model-tier-select']}`
  return <div data-effective-media-model={kind} data-effective-media-layout={modelRows ? 'card' : 'single'} aria-busy={Boolean(snapshot.pending)}>
    {modelRows ? <div className={`${styles['pref-card']} ${styles['default-model-card']}`} data-model-settings-card>
      <div className="pref-row" data-effective-media-source>
        <div className={styles['pref-row-text']}>
          <div className={styles['pref-row-label']} id={`${id}-source-label`}>{t('model_tiers_source')}</div>
        </div>
        <ModelSourceSelect id={id} className={selectClass} labelId={`${id}-source-label`} items={modeItems}
          value={reply?.selection ?? ''} disabled={disabled}
          bindKey={JSON.stringify([modeItems, reply?.selection])} onChange={value => { void save(value, 'source') }} />
      </div>
      <div className="pref-row" data-effective-media-specific>
        <div className={styles['pref-row-text']}>
          <div className={styles['pref-row-label']} id={`${id}-model-label`}>{t('model_tiers_model')}</div>
        </div>
        {!reply || modelChoice ? (
          <KlsSelect id={`${id}-model`} className={selectClass} labelId={`${id}-model-label`}
            items={!reply ? [{ value: '', label: t('loading'), disabled: true }] : modelItems}
            value={reply?.current.modelId ?? ''} disabled={!reply}
            bindKey={JSON.stringify([modelItems, reply?.current.modelId])} onChange={value => { void save(value, 'model') }} />
        ) : (
          <div id={`${id}-model`} data-effective-media-static aria-labelledby={`${id}-model-label`}
            className={`${styles['model-tier-select']} ${styles['media-model-static']}`}>
            {effectiveMediaModelStaticText(reply.selection, models, reply.current.modelId, t('media_model_service_default'), t('media_generation_disabled'))}
          </div>
        )}
      </div>
    </div> : <ModelSourceSelect id={id} className="kls-select kls-select-block" ariaLabel={label} items={modeItems}
      value={reply?.selection ?? ''} disabled={disabled}
      bindKey={JSON.stringify([modeItems, reply?.selection])} onChange={value => { void save(value, 'source') }} />}
    {snapshot.error ? <p className="card-meta" role="alert">{snapshot.error} <button className="btn-sm" type="button" onClick={() => { setSnapshot(current => ({ ...current, error: undefined, saveError: false })); setRetry(value => value + 1) }}>{t('auth_status_retry')}</button></p> : null}
  </div>
}
