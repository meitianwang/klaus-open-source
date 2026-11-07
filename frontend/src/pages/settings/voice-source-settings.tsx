import { useEffect, useState } from 'react'
import { VOICE_INPUT_SOURCE_KEY, isVoiceInputSource, visibleVoiceInputSources } from '../../../../shared/voice-input'
import { useT } from '../../i18n'
import { kvGet, kvSet } from './kv'
import { ModelSourceSelect } from './model-shared'
import { useSettingsSnapshot } from './settings-snapshot'
import styles from './settings.module.css'
import { settingsErrorText } from './settings-error-text'

interface VoiceCapabilities { systemAsr: boolean; availability: Record<string, boolean>; effectiveSource?: string; streaming?: boolean; nativeStreaming?: boolean; experience?: string }
interface VoiceSourceSnapshot { source: string | null; pending?: object; error?: string; saveError?: boolean }
interface CapabilitySnapshot { value: VoiceCapabilities | null; error?: string }

/** The capability selector and language preferences share the same saved source. */
export function useVoiceInputSource(reloadSeq = 0) {
  const t = useT()
  const [snapshot, update, beginRead] = useSettingsSnapshot<VoiceSourceSnapshot>('voice-input:source', { source: null })
  const [capabilities, , beginCapabilityRead] = useSettingsSnapshot<CapabilitySnapshot>('voice-input:capabilities', { value: null })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const load = () => {
      const publish = beginRead()
      void kvGet(VOICE_INPUT_SOURCE_KEY).then(source => {
        publish(current => current.pending ? current : { source: source || '', ...(current.saveError ? { error: current.error, saveError: true } : {}) })
      }, () => { publish(current => current.pending ? current : { ...current, error: t('settings_section_load_failed') }) })
    }
    load()
    window.addEventListener('klaus:voice-source-changed', load)
    return () => window.removeEventListener('klaus:voice-source-changed', load)
  }, [beginRead, reloadSeq, retry, t])
  useEffect(() => {
    const load = () => {
      const publish = beginCapabilityRead()
      const voice = (window as any).klaus?.voice
      void (async () => {
        try {
          const config = voice?.config ? await voice.config(undefined, true) : { systemAsr: false }
          if (config?.ok === false) throw new Error(t('voice_source_unavailable'))
          publish({ value: { systemAsr: !!config?.systemAsr, availability: config?.availability || {}, effectiveSource: config?.source, streaming: config?.streaming === true, nativeStreaming: config?.nativeStreaming === true, experience: config?.experience } })
        } catch (error: any) {
          publish(current => ({ ...current, error: settingsErrorText('voice-source', error, 'settings_section_load_failed') }))
        }
      })()
    }
    load()
    window.addEventListener('klaus:voice-source-changed', load)
    window.addEventListener('klaus:models-changed', load)
    window.addEventListener('klaus:auth-mode-changed', load)
    return () => {
      window.removeEventListener('klaus:voice-source-changed', load)
      window.removeEventListener('klaus:models-changed', load)
      window.removeEventListener('klaus:auth-mode-changed', load)
    }
  }, [beginCapabilityRead, reloadSeq, retry, t])
  const source = snapshot.source || (snapshot.source !== null && capabilities.value?.systemAsr ? 'system' : '')
  const save = async (next: string) => {
    if (!isVoiceInputSource(next) || !source || next === source || capabilities.value?.availability[next] === false) return
    const pending = {}
    let previous: string | null = null
    update(current => {
      if (current.pending || current.source === null) return current
      previous = current.source
      return { source: next, pending }
    })
    if (previous === null) return
    const saved = await kvSet(VOICE_INPUT_SOURCE_KEY, next)
    update(current => current.pending !== pending ? current : { source: saved ? next : previous,
      ...(!saved ? { error: t('settings_failed'), saveError: true } : {}) })
    window.dispatchEvent(new Event('klaus:voice-source-changed'))
  }
  return { source, capabilities: capabilities.value, disabled: !source || Boolean(snapshot.pending), pending: Boolean(snapshot.pending),
    error: snapshot.error || capabilities.error, save, reload: () => {
      update(current => ({ ...current, error: undefined, saveError: false }))
      setRetry(value => value + 1)
    } }
}

export function voiceSourceItems(source: string, availability: Record<string, boolean>, label: (key: string) => string) {
  return visibleVoiceInputSources(availability, source).map(value => ({ value,
    label: isVoiceInputSource(value) ? label(`voice_source_${value}`) : value, disabled: availability[value] === false }))
}

export function VoiceInputSourceRow({ source, availability, disabled, ready, onChange }: {
  source: string; availability: Record<string, boolean>; disabled: boolean; ready?: boolean; onChange: (next: string) => void
}) {
  const t = useT()
  const items = source || ready ? voiceSourceItems(source, availability, t) : [{ value: '', label: t('loading'), disabled: true }]
  return <div className="pref-row" data-capability-voice-source>
    <div className={styles['pref-row-text']}>
      <div className={styles['pref-row-label']} id="voice-source-row-label">{t('model_tiers_source')}</div>
    </div>
    <ModelSourceSelect id="voice-source-select" className={`kls-select ${styles['model-tier-select']}`} labelId="voice-source-row-label"
      value={source} items={items} disabled={disabled} bindKey={JSON.stringify([source, items, disabled])} onChange={onChange} />
  </div>
}
