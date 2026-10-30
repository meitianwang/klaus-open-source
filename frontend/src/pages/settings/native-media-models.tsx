import { useEffect, useRef, useState } from 'react'
import { providerCapabilities, type ProviderCapability } from '../../../../contracts/provider-capabilities'
import { useT } from '../../i18n'
import { KlsSelect } from './model-shared'
import { useSettingsSnapshot } from './settings-snapshot'

/** A saved unavailable choice stays visible until the user replaces it. */
export function nativeMediaModelOptions(capability: ProviderCapability, saved: string): Array<{ id: string; label: string; unavailable?: boolean }> {
  const models = capability.models ?? []
  return saved && !models.some(model => model.id === saved)
    ? [{ id: saved, label: saved, unavailable: true }, ...models]
    : models
}

interface NativeMediaSnapshot { data: any; pending?: object; saveError?: string }

export function NativeMediaModels({ kind, source, reloadSeq }: { kind: 'image' | 'video' | 'audio' | 'music'; source: 'workbuddy' | 'qwenwork' | 'antigravity'; reloadSeq: number }) {
  const t = useT()
  const [cached, setCached, beginRead] = useSettingsSnapshot<NativeMediaSnapshot>(`native-media:${kind}:${source}`, { data: null })
  const snapshot = cached.data
  const [error, setError] = useState('')
  const saving = Boolean(cached.pending)
  const savePending = useRef(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let disposed = false
    const api = (window as any).klaus.settings[kind === 'image' ? 'imageGen' : kind === 'video' ? 'videoGen' : kind === 'music' ? 'musicGen' : 'audioGen']
    const load = () => {
      const publish = beginRead()
      publish(current => current)
      setError('')
      void api.get(source).then((value: any) => {
        if (disposed) return
        if (!value || value.error || value.ok === false) {
          if (publish(current => current)) setError(t('native_media_models_unavailable'))
          return
        }
        publish(current => current.pending ? current : { data: value, saveError: current.saveError })
      }, () => { if (!disposed && publish(current => current)) setError(t('native_media_models_unavailable')) })
    }
    load()
    window.addEventListener('klaus:models-changed', load)
    return () => { disposed = true; window.removeEventListener('klaus:models-changed', load) }
  }, [kind, source, reloadSeq, retry, t, beginRead])
  const capabilities = providerCapabilities(snapshot?.capabilities)
  const fields = ['model'] as const
  const save = async (field: string, value: string) => {
    if (savePending.current || saving) return
    savePending.current = true
    const previous = cached
    const pending = {}
    setCached({ data: { ...snapshot, [field]: value }, pending })
    setError('')
    try {
      const api = (window as any).klaus.settings[kind === 'image' ? 'imageGen' : kind === 'video' ? 'videoGen' : kind === 'music' ? 'musicGen' : 'audioGen']
      const result = await api.set({ source, [field]: value })
      if (result?.ok !== true) throw new Error('unavailable')
      setCached(current => current.pending === pending ? { data: { ...current.data, ...result.config } } : current)
    } catch {
      setCached(current => current.pending === pending ? { ...previous, saveError: t('native_media_model_save_failed') } : current)
    }
    finally {
      savePending.current = false
      window.dispatchEvent(new Event('klaus:models-changed'))
    }
  }
  return <div data-native-media-models={kind}>
    {cached.saveError || error ? <div className="card-meta" role="alert">{cached.saveError || error} <button type="button" className="btn-sm" onClick={() => { setCached(current => ({ ...current, saveError: undefined })); setRetry(value => value + 1) }}>{t('auth_status_retry')}</button></div> : null}
    {snapshot ? fields.map(field => {
      const capability = capabilities[kind]
      const saved = typeof snapshot[field] === 'string' ? snapshot[field] : ''
      const value = saved || capability.defaultModel || ''
      const models = nativeMediaModelOptions(capability, saved)
      if (!models.length) return null
      return <div className="form-row" key={field}>
        <label id={`native-${kind}-${field}-label`}>{t('image_gen_field_model')}</label>
        <KlsSelect id={`native-${kind}-${field}`} className="kls-select kls-select-block"
          labelId={`native-${kind}-${field}-label`} value={value} disabled={saving || !capability.available}
          bindKey={`${source}:${kind}:${field}:${value}:${saving}:${capability.available}:${models.map(model => model.id).join(',')}`}
          items={models.map(model => ({ value: model.id, disabled: model.unavailable,
            label: `${model.label}${model.unavailable ? ` (${t('native_media_model_unavailable')})` : ''}` }))}
          onChange={next => { if (models.some(model => model.id === next && !model.unavailable)) void save(field, next) }} />
      </div>
    }) : null}
  </div>
}
