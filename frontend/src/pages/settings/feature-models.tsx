import { useEffect, useMemo, useRef, useState } from 'react'
import { modelOptionForValue, modelOptionIsSelectable, modelOptionsForValue } from '../../../../shared/cursor-model-catalog'
import { useT } from '../../i18n'
import type { GlobalModelTierOptions } from '../../../bridge/types'
import { KlsSelect, ModelSourceSelect, loadGlobalModelTierOptions, sourceLabel } from './model-shared'
import { useSettingsSnapshot } from './settings-snapshot'
import {
  ALL_FEATURE_MODEL_ROWS, EMPTY_FEATURE_MODEL_VALUES, FEATURE_MODEL_ROWS, composeFeatureModelValue, effectiveRowSource,
  featureModelInCatalog, normalizedFeatureModelValues, parseFeatureModelReference,
  type FeatureModelField, type FeatureModelRow as FeatureModelRowSpec, type FeatureModelSlot, type FeatureModelValues,
} from './feature-models-state'
import styles from './settings.module.css'
import { settingsErrorText } from './settings-error-text'

const w = () => window as any

interface FeatureModelsSnapshot { values: FeatureModelValues; pending?: object; saveError?: string }

export interface FeatureModelController {
  values: FeatureModelValues
  saving: boolean
  ready: boolean
  options: GlobalModelTierOptions | null
  sourceRows: any[]
  loadError: string
  saveError?: string
  sourceChoices: Partial<Record<FeatureModelSlot, string>>
  setSourceChoice: (slot: FeatureModelSlot, source: string) => void
  clearSourceChoice: (slot: FeatureModelSlot) => void
  saveSlot: (field: FeatureModelField, value: string) => void
}

// Each auxiliary task keeps one global pick, mirroring the advisor: any
// source's catalog can supply it, an empty slot follows the chat's main model,
// and a stored reference whose source or model left the catalog keeps its row
// visible so the user can see and replace it.
//
// One controller feeds every surface that shows a task model. A caller that
// already loaded the catalog passes it in; standalone callers let the hook load it.
export function useFeatureModelSettings(options?: GlobalModelTierOptions | null): FeatureModelController {
  const t = useT()
  const [snapshot, setSnapshot, beginRead] = useSettingsSnapshot<FeatureModelsSnapshot | null>('model-defaults:feature-models', null)
  const [loadError, setLoadError] = useState('')
  const [loadedOptions, setLoadedOptions] = useState<GlobalModelTierOptions | null>(null)
  // Standalone use inside feature pages loads the catalogs itself; callers
  // with an existing model catalog can pass it in.
  const catalogOptions = options === undefined ? loadedOptions : options
  // The source half of a pick is UI state first: switching sources clears the
  // stored model, and without a local choice the row would snap back to the
  // stored reference instead of staying where the user just pointed it.
  const [sourceChoices, setSourceChoices] = useState<Partial<Record<FeatureModelSlot, string>>>({})
  const savePending = useRef(false)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      const publish = beginRead()
      publish(current => current)
      void w().klaus.settings.featureModels.get().then((reply: any) => {
        if (reply?.ok === false || !reply?.settings) {
          if (!cancelled && publish(current => current)) setLoadError(t('feature_models_load_failed'))
          return
        }
        if (!cancelled && publish(current => current?.pending ? current : {
          values: normalizedFeatureModelValues(reply.settings), saveError: current?.saveError,
        })) setLoadError('')
      }, () => { if (!cancelled && publish(current => current)) setLoadError(t('feature_models_load_failed')) })
    }
    load()
    window.addEventListener('klaus:models-changed', load)
    return () => { cancelled = true; window.removeEventListener('klaus:models-changed', load) }
  }, [beginRead, t])
  useEffect(() => {
    if (options !== undefined) return
    let cancelled = false
    const load = () => {
      void loadGlobalModelTierOptions().then(value => {
        if (!cancelled) setLoadedOptions(value)
      }, () => {
        if (!cancelled) setLoadError(t('settings_section_load_failed'))
      })
    }
    load()
    window.addEventListener('klaus:models-changed', load)
    return () => { cancelled = true; window.removeEventListener('klaus:models-changed', load) }
  }, [options, t])
  const values = snapshot?.values ?? EMPTY_FEATURE_MODEL_VALUES
  const saving = Boolean(snapshot?.pending)
  const sourceRows = useMemo(() => catalogOptions?.sources || [], [catalogOptions])
  // Re-anchor a row when the stored pick changes from elsewhere. While a save
  // is in flight the stored value still lags the local choice, so both are
  // left alone.
  useEffect(() => {
    if (saving) return
    setSourceChoices(current => {
      let next = current
      for (const row of ALL_FEATURE_MODEL_ROWS) {
        const choice = current[row.slot]
        if (choice === undefined) continue
        const stored = parseFeatureModelReference(values[row.field])
        if (stored && stored.source !== choice) { next = { ...next }; delete next[row.slot] }
      }
      return next
    })
  }, [values, saving])
  const saveSlot = (field: FeatureModelField, value: string) => {
    if (savePending.current || snapshot?.pending) return
    savePending.current = true
    const previous = snapshot
    const pending = {}
    setSnapshot({ values: { ...values, [field]: value }, pending })
    void w().klaus.settings.featureModels.set({ [field]: value }).then((result: any) => {
      if (result?.ok === false) throw new Error(result.error || t('settings_failed'))
      const saved = result?.settings ? normalizedFeatureModelValues(result.settings) : { ...values, [field]: value }
      setSnapshot(current => current?.pending === pending ? { values: saved } : current)
    }).catch((error: any) => {
      setSnapshot(current => current?.pending === pending && previous ? { ...previous, saveError: settingsErrorText('feature-models-save', error, 'feature_models_save_failed') } : current)
    }).finally(() => {
      savePending.current = false
      window.dispatchEvent(new Event('klaus:models-changed'))
    })
  }
  return {
    values, saving, ready: Boolean(snapshot), options: catalogOptions || null, sourceRows, loadError,
    saveError: snapshot?.saveError, sourceChoices,
    setSourceChoice: (slot, source) => setSourceChoices(current => ({ ...current, [slot]: source })),
    clearSourceChoice: slot => setSourceChoices(current => { const choices = { ...current }; delete choices[slot]; return choices }),
    saveSlot,
  }
}

export function FeatureModelRow({ row, model }: {
  row: FeatureModelRowSpec
  model: FeatureModelController
}) {
  const t = useT()
  const stored = model.values[row.field]
  const storedRef = parseFeatureModelReference(stored)
  const storedSourceRow = storedRef ? model.sourceRows.find(candidate => candidate.source === storedRef.source) : undefined
  const storedSelected = storedRef ? modelOptionForValue(storedSourceRow?.options || [], storedRef.modelId) : undefined
  // A row reports missing only against a loaded catalog: the stored identity
  // must parse, its source must be known, and its model must still be in that
  // source's options.
  const missing = Boolean(model.options) && Boolean(stored) && (!storedRef || !storedSourceRow || !storedSelected)
  const source = effectiveRowSource(stored, model.sourceChoices[row.slot], model.sourceRows.map(candidate => candidate.source))
  const sourceRow = model.sourceRows.find(candidate => candidate.source === source)
  const modelId = storedRef && storedRef.source === source ? storedRef.modelId : ''
  const modelItems = [
    { value: '', label: t('model_tiers_pick_model'), disabled: true },
    ...(storedRef && storedRef.source === source && !featureModelInCatalog(sourceRow?.options || [], storedRef.modelId)
      ? [{ value: storedRef.modelId, label: storedRef.modelId, disabled: true }] : []),
    // Model rows carry the name only. The catalog description is provider copy
    // in two languages; as a second row it stretched the fixed-position panel
    // across the whole window.
    ...(modelOptionsForValue(sourceRow?.options || [], modelId) as any[]).map(option => ({
      value: option.modelId,
      label: option.label,
      disabled: !modelOptionIsSelectable(option, source),
    })),
  ]
  return (
    <div className="pref-row" data-feature-model={row.slot}>
      <div className={styles['pref-row-text']}>
        <div className={styles['pref-row-label']} id={`feature-model-${row.slot}-label`}>{t(row.labelKey)}</div>
        {missing ? <p className={styles['tier-reason']} role="alert">{t('feature_model_missing')}</p> : null}
      </div>
      <div className={styles['feature-model-controls']}>
        <ModelSourceSelect id={`feature-model-${row.slot}-source`} className={`kls-select ${styles['model-tier-select']}`}
          ariaLabel={`${t(row.labelKey)} ${t('model_tiers_source')}`}
          items={[{ value: '', label: t('feature_model_follow_main') }, ...model.sourceRows.map(candidate => ({ value: candidate.source, label: sourceLabel(candidate.source) }))]}
          value={source} disabled={!model.ready || model.saving || !model.options}
          bindKey={`feature-source|${row.slot}|${source}|${model.saving}|${Boolean(model.options)}`}
          onChange={next => {
            model.setSourceChoice(row.slot, next)
            const keep = storedRef && storedRef.source === next ? storedRef.modelId : ''
            model.saveSlot(row.field, composeFeatureModelValue(next, keep))
          }} />
        {source !== '' ? (
          <KlsSelect id={`feature-model-${row.slot}-model`} className={`kls-select ${styles['model-tier-select']}`}
            ariaLabel={`${t(row.labelKey)} ${t('model_tiers_model')}`}
            items={modelItems} value={modelId}
            disabled={!model.ready || model.saving || !model.options || sourceRow?.status !== 'ready'}
            bindKey={JSON.stringify([row.slot, source, modelId, model.saving, Boolean(model.options), sourceRow])}
            onChange={next => {
              model.clearSourceChoice(row.slot)
              model.saveSlot(row.field, composeFeatureModelValue(source, next))
            }} />
        ) : null}
      </div>
    </div>
  )
}

export function FeatureModelSettings({ options, slots, heading = true }: {
  options?: GlobalModelTierOptions | null
  slots?: readonly FeatureModelSlot[]
  heading?: boolean
}) {
  const t = useT()
  const model = useFeatureModelSettings(options)
  const rows = slots ? FEATURE_MODEL_ROWS.filter(row => slots.includes(row.slot)) : FEATURE_MODEL_ROWS
  const card = (
    <div className={`${styles['pref-card']} ${styles['default-model-card']}`} data-feature-models data-model-settings-card>
      {rows.map(row => <FeatureModelRow key={row.slot} row={row} model={model} />)}
      {model.saveError || model.loadError ? <p className={styles['tier-reason']} role="alert">{model.saveError || model.loadError}</p> : null}
    </div>
  )
  if (!heading) return card
  return (
    <div className={styles['tiers-group']}>
      <div className={styles['settings-section-heading']}>
        <div className="settings-section-title">{t('feature_models_settings')}</div>
        <p className={styles['settings-section-hint']}>{t('feature_models_settings_desc')}</p>
      </div>
      {card}
    </div>
  )
}
