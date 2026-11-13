import { modelOptionHasValue, modelOptionForValue, modelOptionIsSelectable, modelOptionsForValue } from '../../../../shared/cursor-model-catalog'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { ModalPortal } from '../../components/ModalPortal'
import {
  AUTH_MODE_ORDER, KlsSelect, MODEL_TIERS, ModelSourceSelect, loadGlobalModelTierMappings,
  loadGlobalModelTierOptions, modelReferenceLabel, saveGlobalModelTier, sourceLabel,
} from './model-shared'
import type { GlobalModelTierMapping, GlobalModelTierOptions, ModelTierReference } from '../../../bridge/types'
import { FOLLOW_CHAT_MODEL, GlobalModelTiersState } from './global-model-tiers-state'
import styles from './settings.module.css'
import { settingsErrorText } from './settings-error-text'
import { useSettingsSnapshot } from './settings-snapshot'

const w = () => window as any

interface AdvisorSnapshot { enabled: boolean; model: string; pending?: object; saveError?: string }
interface OrchestratorSnapshot { model: string; pending?: object; saveError?: string }
const USE_MEDIUM_MODEL = '__use_medium__'

// The tier mapping and catalog seed a fresh state instance across remounts;
// the snapshot write-back below keeps them current.
let tierViewCache: { mapping: GlobalModelTierMapping | null; options: GlobalModelTierOptions | null } | null = null

export function GlobalModelTiers({ configureSource }: { configureSource: (source: string) => void }) {
  const t = useT()
  const [state] = useState(() => new GlobalModelTiersState({
    get: loadGlobalModelTierMappings, options: loadGlobalModelTierOptions, set: saveGlobalModelTier,
  }, tierViewCache ?? undefined))
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot)
  const { mapping, options, editor, loading, loadError, optionsError, saving, saveError } = snapshot
  const modalRef = useRef<HTMLDivElement>(null)
  // Keep the cross-remount seed current with whatever this view last read.
  useEffect(() => {
    if (!mapping && !options) return
    tierViewCache = { mapping, options }
  }, [mapping, options])
  // The advisor is one global pick too: any source's catalog can supply it, so
  // a chat's model source never limits which advisor model is in force. Only
  // known rows from a signed-in source are offered under its selection policy.
  const [advisor, setAdvisorState, beginAdvisorRead] = useSettingsSnapshot<AdvisorSnapshot | null>('model-defaults:advisor', null)
  const advisorSaving = Boolean(advisor?.pending)
  const advisorSavePending = useRef(false)
  const [advisorError, setAdvisorError] = useState('')
  useEffect(() => {
    let cancelled = false
    const load = () => {
      const publish = beginAdvisorRead()
      publish(current => current)
      void w().klaus.settings.advisor.get().then((reply: any) => {
        if (reply?.ok === false) {
          if (!cancelled && publish(current => current)) setAdvisorError(t('advisor_load_failed'))
          return
        }
        if (!cancelled && publish(current => current?.pending ? current : {
          enabled: Boolean(reply?.enabled), model: String(reply?.model || ''), saveError: current?.saveError,
        })) setAdvisorError('')
      }, () => { if (!cancelled && publish(current => current)) setAdvisorError(t('advisor_load_failed')) })
    }
    load()
    window.addEventListener('klaus:models-changed', load)
    return () => { cancelled = true; window.removeEventListener('klaus:models-changed', load) }
  }, [beginAdvisorRead, t])
  // The advisor pick is stored as one "source:modelId" reference, but choosing
  // it is two steps like the tier editor: a source first, then one of that
  // source's models. The source half of the stored reference seeds the first
  // step; a stored reference whose source or model vanished from the catalog
  // keeps its row so the user can see and replace it.
  const advisorReferenceParsed = useMemo<ModelTierReference | null>(() => {
    const stored = String(advisor?.model || '')
    const separator = stored.indexOf(':')
    if (separator < 1) return null
    return { source: stored.slice(0, separator), modelId: stored.slice(separator + 1) }
  }, [advisor?.model])
  const advisorSourceRows = options?.sources || []
  // The source half of the pick is UI state first: switching sources clears the
  // stored model, and without a local choice the row would snap back to the
  // default source instead of staying where the user just pointed it.
  const [advisorSourceChoice, setAdvisorSourceChoice] = useSettingsSnapshot('model-defaults:advisor-source', '')
  // Re-anchor the row to the stored reference when it changes from elsewhere.
  // While a save is in flight the stored value still lags the local choice, and
  // a source switch deliberately clears the stored model, so both are left alone.
  useEffect(() => {
    if (advisorSaving || !advisorReferenceParsed || advisorReferenceParsed.source === advisorSourceChoice) return
    setAdvisorSourceChoice(advisorReferenceParsed.source)
  }, [advisorReferenceParsed?.source, advisorSourceChoice, advisorSaving])
  const advisorSource = (advisorSourceChoice && advisorSourceRows.some(row => row.source === advisorSourceChoice) ? advisorSourceChoice : advisorReferenceParsed?.source)
    || advisorSourceRows.find(row => row.status === 'ready')?.source
    || advisorSourceRows[0]?.source || ''
  const advisorSourceRow = advisorSourceRows.find(row => row.source === advisorSource)
  const advisorModelItems = [
    { value: '', label: t('model_tiers_pick_model'), disabled: true },
    ...(advisorReferenceParsed && advisorReferenceParsed.source === advisorSource
      && !(advisorSourceRow?.options || []).some(row => modelOptionHasValue(row, advisorReferenceParsed.modelId))
      ? [{ value: advisorReferenceParsed.modelId, label: advisorReferenceParsed.modelId, disabled: true }] : []),
    // Model rows carry the name only: the catalog description is provider copy
    // in two languages and stretched the fixed-position panel to viewport width.
    ...modelOptionsForValue(advisorSourceRow?.options || [], advisorReferenceParsed?.source === advisorSource ? advisorReferenceParsed.modelId : '').map(row => ({
      value: row.modelId,
      label: row.label,
      disabled: !modelOptionIsSelectable(row, advisorSource),
    })),
  ]
  const advisorModelId = advisorReferenceParsed && advisorReferenceParsed.source === advisorSource ? advisorReferenceParsed.modelId : ''
  const advisorSelected = modelOptionForValue(advisorSourceRow?.options || [], advisorModelId)
  const advisorMissing = Boolean(advisor?.model && !advisorReferenceParsed)
    || Boolean(advisorReferenceParsed && !advisorSourceRows.some(row => row.source === advisorReferenceParsed.source))
    || Boolean(advisorModelId && !advisorSelected)
  const saveAdvisor = async (enabled: boolean, model = advisor?.model || '') => {
    if (advisorSavePending.current || advisor?.pending) return
    advisorSavePending.current = true
    const previous = advisor
    const pending = {}
    setAdvisorState({ enabled, model, pending })
    setAdvisorError('')
    try {
      const result = await w().klaus.settings.advisor.set({ enabled, model })
      if (result?.ok === false) throw new Error(result.error || t('settings_failed'))
      const saved = result?.settings || { enabled, model }
      setAdvisorState(current => current?.pending === pending ? { enabled: Boolean(saved.enabled), model: String(saved.model || '') } : current)
    } catch (error: any) {
      const message = settingsErrorText('model-tiers-action', error, 'settings_failed')
      setAdvisorState(current => current?.pending === pending && previous ? { ...previous, saveError: message } : current)
      setAdvisorError(message)
    } finally {
      advisorSavePending.current = false
      window.dispatchEvent(new Event('klaus:models-changed'))
    }
  }

  const [orchestrator, setOrchestratorState, beginOrchestratorRead] = useSettingsSnapshot<OrchestratorSnapshot | null>('model-defaults:orchestrator', null)
  const orchestratorSaving = Boolean(orchestrator?.pending)
  const orchestratorSavePending = useRef(false)
  const [orchestratorError, setOrchestratorError] = useState('')
  useEffect(() => {
    let cancelled = false
    const load = () => {
      const api = w().klaus?.settings?.orchestrator
      const publish = beginOrchestratorRead()
      if (!api?.get) {
        publish(current => current ?? { model: '' })
        return
      }
      publish(current => current)
      void api.get().then((reply: any) => {
        if (reply?.ok === false) {
          if (!cancelled && publish(current => current)) setOrchestratorError(t('orchestrator_load_failed'))
          return
        }
        if (!cancelled && publish(current => current?.pending ? current : {
          model: String(reply?.model || ''), saveError: current?.saveError,
        })) setOrchestratorError('')
      }, () => { if (!cancelled && publish(current => current)) setOrchestratorError(t('orchestrator_load_failed')) })
    }
    load()
    window.addEventListener('klaus:models-changed', load)
    return () => { cancelled = true; window.removeEventListener('klaus:models-changed', load) }
  }, [beginOrchestratorRead, t])

  const orchestratorRefParsed = useMemo<ModelTierReference | null>(() => {
    const stored = String(orchestrator?.model || '')
    const sep = stored.indexOf(':')
    if (sep < 1) return null
    return { source: stored.slice(0, sep), modelId: stored.slice(sep + 1) }
  }, [orchestrator?.model])
  const [orchestratorSourceChoice, setOrchestratorSourceChoice] = useSettingsSnapshot('model-defaults:orchestrator-source', '')
  useEffect(() => {
    if (orchestratorSaving) return
    if (!orchestrator?.model) {
      if (orchestratorSourceChoice && orchestratorSourceChoice !== USE_MEDIUM_MODEL && !orchestratorRefParsed) return
      if (!orchestratorSourceChoice) setOrchestratorSourceChoice(USE_MEDIUM_MODEL)
      return
    }
    if (orchestratorRefParsed && orchestratorRefParsed.source !== orchestratorSourceChoice) {
      setOrchestratorSourceChoice(orchestratorRefParsed.source)
    }
  }, [orchestrator?.model, orchestratorRefParsed?.source, orchestratorSourceChoice, orchestratorSaving])

  const orchestratorSource = orchestratorSourceChoice === USE_MEDIUM_MODEL
    ? USE_MEDIUM_MODEL
    : (orchestratorSourceChoice && advisorSourceRows.some(row => row.source === orchestratorSourceChoice)
      ? orchestratorSourceChoice
      : orchestratorRefParsed?.source || USE_MEDIUM_MODEL)
  const orchestratorSourceRow = orchestratorSource === USE_MEDIUM_MODEL
    ? undefined
    : advisorSourceRows.find(row => row.source === orchestratorSource)
  const orchestratorModelId = orchestratorRefParsed && orchestratorRefParsed.source === orchestratorSource ? orchestratorRefParsed.modelId : ''
  const orchestratorSelected = orchestratorSourceRow ? modelOptionForValue(orchestratorSourceRow.options || [], orchestratorModelId) : undefined
  const orchestratorModelItems = orchestratorSource === USE_MEDIUM_MODEL ? [] : [
    { value: '', label: t('model_tiers_pick_model'), disabled: true },
    ...(orchestratorRefParsed && orchestratorRefParsed.source === orchestratorSource
      && !(orchestratorSourceRow?.options || []).some(row => modelOptionHasValue(row, orchestratorRefParsed.modelId))
      ? [{ value: orchestratorRefParsed.modelId, label: orchestratorRefParsed.modelId, disabled: true }] : []),
    ...modelOptionsForValue(orchestratorSourceRow?.options || [], orchestratorModelId).map(row => ({
      value: row.modelId,
      label: row.label,
      disabled: !modelOptionIsSelectable(row, orchestratorSource),
    })),
  ]
  const orchestratorMissing = Boolean(orchestrator?.model && !orchestratorRefParsed)
    || Boolean(orchestratorRefParsed && !advisorSourceRows.some(row => row.source === orchestratorRefParsed.source))
    || Boolean(orchestratorModelId && !orchestratorSelected)

  const saveOrchestrator = async (model: string) => {
    if (orchestratorSavePending.current || orchestrator?.pending) return
    orchestratorSavePending.current = true
    const previous = orchestrator
    const pending = {}
    setOrchestratorState({ model, pending })
    setOrchestratorError('')
    try {
      const result = await w().klaus?.settings?.orchestrator?.set({ model })
      if (result?.ok === false) throw new Error(result.error || t('settings_failed'))
      const saved = result?.settings || { model }
      setOrchestratorState(current => current?.pending === pending ? { model: String(saved.model || '') } : current)
    } catch (error: any) {
      const message = settingsErrorText('model-tiers-action', error, 'settings_failed')
      setOrchestratorState(current => current?.pending === pending && previous ? { ...previous, saveError: message } : current)
      setOrchestratorError(message)
    } finally {
      orchestratorSavePending.current = false
      window.dispatchEvent(new Event('klaus:models-changed'))
    }
  }

  useEffect(() => {
    void state.load()
    const refresh = () => { void state.load() }
    window.addEventListener('klaus:models-changed', refresh)
    window.addEventListener('klaus:auth-mode-changed', refresh)
    return () => {
      state.cancelPending()
      window.removeEventListener('klaus:models-changed', refresh)
      window.removeEventListener('klaus:auth-mode-changed', refresh)
    }
  }, [state])

  useEffect(() => {
    if (!editor) return
    const previous = document.activeElement as HTMLElement | null
    modalRef.current?.querySelector<HTMLElement>('button')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The select consumes its own Escape before the modal closes.
        const select = modalRef.current?.querySelector<HTMLElement>('.kls-select.open')
        if (select) {
          (select as any).__klsSelect?.close()
          select.querySelector<HTMLElement>('.kls-select-trigger')?.focus()
          event.preventDefault()
          event.stopPropagation()
          return
        }
        event.preventDefault()
        state.close()
      }
      if (event.key !== 'Tab') return
      const items = Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') || [])
        .filter(item => item.getClientRects().length)
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true); previous?.focus() }
  }, [state, editor?.tier])

  const onSave = async () => {
    if (!await state.save()) return
    w().showToast?.(t('model_mapping_saved'))
    window.dispatchEvent(new Event('klaus:models-changed'))
  }
  const source = options?.sources.find(row => row.source === editor?.source)
  const selected = modelOptionForValue(source?.options || [], editor?.modelId || '')
  const missingModel = Boolean(editor?.modelId && !selected)
  const conflict = Boolean(editor && mapping && editor.revision !== mapping.revision)
  const configure = (source: string) => { state.close(); configureSource(source) }
  const reasonText = (code?: string, fallback?: string) => {
    const key = code ? `model_tiers_reason_${code.toLowerCase()}` : ''
    return key && t(key) !== key ? t(key) : fallback || ''
  }

  return (
    <section className={styles['global-tiers']} data-global-model-tiers aria-busy={loading}>
      {/* Every effective model is selected here; provider setup has its own page. */}
      <div className={styles['tiers-body']}>

      <div className={styles['tiers-group']}>
        <div className={styles['settings-section-heading']}>
          <div className="settings-section-title">{t('orchestrator_settings')}</div>
          <p className={styles['settings-section-hint']}>{t('orchestrator_settings_desc')}</p>
        </div>
        <div className={`${styles['pref-card']} ${styles['default-model-card']}`} data-orchestrator-models data-model-settings-card>
          <div className="pref-row">
            <div className={styles['pref-row-text']}>
              <div className={styles['pref-row-label']} id="orchestrator-source-label">{t('model_tiers_source')}</div>
            </div>
            <ModelSourceSelect id="orchestrator-source-select" className={`kls-select ${styles['model-tier-select']}`}
              labelId="orchestrator-source-label"
              items={[
                { value: USE_MEDIUM_MODEL, label: t('orchestrator_use_medium') },
                ...advisorSourceRows.map(row => ({ value: row.source, label: sourceLabel(row.source) })),
              ]}
              value={orchestratorSource} disabled={!orchestrator || orchestratorSaving || !options}
              bindKey={`orchestrator-source|${orchestratorSource}|${orchestratorSaving}|${Boolean(options)}`}
              onChange={source => {
                setOrchestratorSourceChoice(source)
                if (source === USE_MEDIUM_MODEL) {
                  void saveOrchestrator('')
                  return
                }
                const next = orchestratorRefParsed && orchestratorRefParsed.source === source
                  ? orchestratorRefParsed.modelId
                  : (advisorSourceRows.find(row => row.source === source)?.options?.find(opt => modelOptionIsSelectable(opt, source))?.modelId || '')
                if (next) void saveOrchestrator(`${source}:${next}`)
              }} />
          </div>
          {orchestratorSource !== USE_MEDIUM_MODEL ? (
            <div className="pref-row">
              <div className={styles['pref-row-text']}>
                <div className={styles['pref-row-label']} id="orchestrator-model-label">{t('model_tiers_model')}</div>
              </div>
              <KlsSelect id="orchestrator-model-select" className={`kls-select ${styles['model-tier-select']}`}
                labelId="orchestrator-model-label" items={orchestratorModelItems} value={orchestratorModelId}
                disabled={!orchestrator || orchestratorSaving || !options || orchestratorSourceRow?.status !== 'ready'}
                bindKey={JSON.stringify([orchestratorSource, orchestratorModelId, orchestratorSaving, Boolean(options), orchestratorSourceRow])}
                onChange={modelId => { void saveOrchestrator(modelId ? `${orchestratorSource}:${modelId}` : '') }} />
            </div>
          ) : null}
          {orchestrator?.saveError || orchestratorError || (orchestratorSource !== USE_MEDIUM_MODEL && (orchestratorSourceRow?.status !== 'ready' || orchestratorMissing)) ? (
            <div className="pref-row">
              <p className={styles['tier-reason']} role="alert" style={{ margin: 0 }}>
                {orchestrator?.saveError || orchestratorError || reasonText(orchestratorSourceRow?.reasonCode, orchestratorSourceRow?.reason) || t('orchestrator_model_unavailable')}
              </p>
              {orchestratorSource !== USE_MEDIUM_MODEL && orchestratorSourceRow?.status !== 'ready' ? (
                <button type="button" className="btn-xs" onClick={() => configure(orchestratorSource)}>{t('model_tiers_configure_source')}</button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles['tiers-group']}>
        <div className={styles['settings-section-heading']}>
          <div className="settings-section-title">{t('subagent_tiers_settings')}</div>
          <p className={styles['settings-section-hint']}>{t('subagent_tiers_settings_desc')}</p>
        </div>
        {mapping?.migration?.warning ? <p className={styles['tier-migration']} role="alert">{mapping.migration.warning === 'invalid_legacy_mapping' ? t('model_tiers_migration_invalid') : t('model_tiers_migration_warning')}</p> : null}
        {loadError || optionsError ? (
          <div className={styles['tier-load-error']} role="alert">
            <span>{loadError || optionsError}</span>
            <button type="button" className="btn-sm" onClick={() => { void state.load() }}>{t('auth_status_retry')}</button>
          </div>
        ) : null}
        <div className={styles['tier-grid']}>
          {MODEL_TIERS.map(tier => {
            const target = mapping?.[tier.tier] || null
            const catalog = target ? options?.sources.find(row => row.source === target.source) : undefined
            const model = target ? modelOptionForValue(catalog?.options || [], target.modelId) : undefined
            // Keep saved cards neutral while the source catalog is loading.
            const catalogPending = Boolean(target) && !options && !optionsError && !loadError
            const status = !mapping ? 'unavailable' : !target ? 'inherit'
              : catalogPending ? 'loading'
              : optionsError || loadError || catalog?.status !== 'ready' || !modelOptionIsSelectable(model, target.source) ? 'unavailable' : 'ready'
            const label = status === 'loading' ? t('loading') : (model?.label || modelReferenceLabel(target, options))
            const reason = loadError || optionsError || (target && status === 'unavailable'
              ? reasonText(model?.reasonCode || catalog?.reasonCode, model?.reason || catalog?.reason) || t('model_tiers_missing_model') : '')
            return (
              <article className={styles['tier-card']} key={tier.tier} data-model-tier={tier.tier} data-tier-status={status}>
                <header className={styles['tier-card-heading']}>
                  <strong>{t(tier.labelKey)}</strong>
                </header>
                <p className={styles['tier-purpose']}>{t(tier.hintKey)}</p>
                <div className={styles['tier-target']}>
                  <span className={styles['tier-model-label']}>{mapping ? (target ? label : t('no_models')) : t('loading')}</span>
                </div>
                {reason ? <p className={styles['tier-reason']}>{reason}</p> : null}
                <div className={styles['tier-card-actions']}>
                  {target && status === 'unavailable' ? <button type="button" className="btn-xs" onClick={() => configure(target.source)}>{t('model_tiers_configure_source')}</button> : null}
                  <button type="button" className="btn-sm" disabled={!mapping || Boolean(loadError) || status === 'loading'} data-tier-edit={tier.tier}
                    aria-label={t('model_tiers_edit_label').replace('{tier}', t(tier.labelKey))}
                    onClick={() => { state.open(tier.tier); void state.load() }}>{t('model_tiers_edit')}</button>
                </div>
              </article>
            )
          })}
        </div>
      </div>

      <div className={styles['tiers-group']}>
        <div className={styles['settings-section-heading']}>
          <div className="settings-section-title">{t('advisor_settings')}</div>
          <p className={styles['settings-section-hint']}>{t('advisor_settings_desc')}</p>
        </div>
        <div className={`${styles['pref-card']} ${styles['default-model-card']}`} data-advisor-models data-model-settings-card>
          <div className="pref-row">
            <div className={styles['pref-row-text']}>
              <div className={styles['pref-row-label']}>{t('advisor_enable')}</div>
            </div>
            <label className={styles['pref-switch']}>
              <input type="checkbox" id="advisor-enabled" aria-label={t('advisor_enable')} checked={Boolean(advisor?.enabled)} disabled={!advisor || advisorSaving}
                onChange={event => { void saveAdvisor(event.target.checked) }} />
              <span className={styles['pref-switch-track']} />
            </label>
          </div>
          <div className="pref-row">
            <div className={styles['pref-row-text']}>
              <div className={styles['pref-row-label']} id="advisor-source-label">{t('model_tiers_source')}</div>
            </div>
            <ModelSourceSelect id="advisor-source-select" className={`kls-select ${styles['model-tier-select']}`}
              labelId="advisor-source-label"
              items={advisorSourceRows.map(row => ({ value: row.source, label: sourceLabel(row.source) }))}
              value={advisorSource} disabled={!advisor || advisorSaving || !options}
              bindKey={`advisor-source|${advisorSource}|${advisorSaving}|${Boolean(options)}`}
              onChange={source => {
                setAdvisorSourceChoice(source)
                const next = advisorReferenceParsed && advisorReferenceParsed.source === source ? advisorReferenceParsed.modelId : ''
                void saveAdvisor(Boolean(advisor?.enabled), next ? `${source}:${next}` : '')
              }} />
          </div>
          <div className="pref-row">
            <div className={styles['pref-row-text']}>
              <div className={styles['pref-row-label']} id="advisor-model-label">{t('model_tiers_model')}</div>
            </div>
            <KlsSelect id="advisor-model-select" className={`kls-select ${styles['model-tier-select']}`}
              labelId="advisor-model-label" items={advisorModelItems} value={advisorModelId}
              disabled={!advisor || advisorSaving || !options || advisorSourceRow?.status !== 'ready'}
              bindKey={JSON.stringify([advisorSource, advisorModelId, advisorSaving, Boolean(options), advisorSourceRow])}
              onChange={modelId => { void saveAdvisor(Boolean(advisor?.enabled), modelId ? `${advisorSource}:${modelId}` : '') }} />
          </div>
          {advisor?.saveError || advisorError || advisorMissing ? <p className={styles['tier-reason']} role="alert">{advisor?.saveError || advisorError || t('advisor_model_unavailable')}</p> : null}
        </div>
      </div>
      </div>
      {editor ? (
        <ModalPortal>
          <div className="kls-modal-overlay" data-tier-modal onPointerDown={event => { if (event.target === event.currentTarget) state.close() }}>
            <div className={`kls-modal ${styles['tier-modal']}`} role="dialog" aria-modal="true" aria-labelledby="tier-edit-title" ref={modalRef}>
              <div className="kls-modal-head">
                <h3 className="kls-modal-title" id="tier-edit-title">{t('model_tiers_edit_label').replace('{tier}', t(`model_map_${editor.tier}`))}</h3>
                <button type="button" className="kls-modal-close" aria-label={t('cancel')} disabled={saving} onClick={() => state.close()}>×</button>
              </div>
              <div className={`kls-modal-body ${styles['tier-editor-body']}`}>
                <div className="form-row">
                  <label id="tier-source-label">{t('model_tiers_source')}</label>
                  <ModelSourceSelect id="tier-source-select" labelId="tier-source-label" className="kls-select kls-select-block"
                    items={[{ value: FOLLOW_CHAT_MODEL, label: t('model_mapping_follow_default') }, ...AUTH_MODE_ORDER.map(source => ({ value: source, label: sourceLabel(source) }))]}
                    value={editor.source} disabled={saving}
                    bindKey={`source|${editor.source}|${saving}|${t('model_tiers_source')}`}
                    onChange={value => state.selectSource(value)} />
                </div>
                {editor.source !== FOLLOW_CHAT_MODEL ? (
                  <div className="form-row">
                    <label id="tier-model-label">{t('model_tiers_model')}</label>
                    <KlsSelect id="tier-model-select" labelId="tier-model-label" className="kls-select kls-select-block"
                      items={[
                        { value: '', label: t('model_tiers_pick_model'), disabled: true },
                        ...(missingModel ? [{ value: editor.modelId, label: editor.modelId, disabled: true }] : []),
                        // Model rows carry the name only: the catalog
                        // description is provider copy in two languages and
                        // stretched the fixed-position panel to viewport width.
                        ...modelOptionsForValue(source?.options || [], editor.modelId).map(row => ({
                          value: row.modelId,
                          label: row.label,
                          disabled: !modelOptionIsSelectable(row, editor.source),
                        })),
                      ]}
                      value={editor.modelId} disabled={saving || source?.status !== 'ready' || Boolean(optionsError)}
                      bindKey={`model|${editor.source}|${editor.modelId}|${JSON.stringify(source)}|${saving}|${optionsError}`}
                      onChange={value => state.selectModel(value)} />
                  </div>
                ) : null}
                {saveError ? <p className={styles['tier-load-error']} role="alert">{saveError}</p> : null}
                {conflict ? (
                  <div className={styles['tier-load-error']} role="alert">
                    <span>{t('model_tiers_conflict')}</span>
                    <button type="button" className="btn-sm" onClick={() => state.open(editor.tier)}>{t('model_tiers_reload')}</button>
                  </div>
                ) : null}
              </div>
              <div className="kls-modal-foot">
                <button type="button" className="btn-sm" disabled={saving} data-tier-cancel onClick={() => state.close()}>{t('cancel')}</button>
                <button type="button" className="btn-sm btn-primary" disabled={!state.canSave()} data-tier-save onClick={() => { void onSave() }}>{t(saving ? 'model_tiers_saving' : 'save')}</button>
              </div>
            </div>
          </div>
        </ModalPortal>
      ) : null}
    </section>
  )
}
