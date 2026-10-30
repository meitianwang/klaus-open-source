import { useEffect, useState } from 'react';
import { CODEX_REALTIME_SOURCE_ID, type PetRealtimeOptions } from '../../../../contracts/desktop-pet-voice';
import { petApi } from '../../../bridge/pet-api';
import { useT } from '../../i18n';
import { KlsSelect, ModelSourceSelect } from './model-shared';
import { petMessages } from '../../pets/messages';
import { petVoiceError } from '../../pets/voice-errors';
import { isRealtimeCapableSubscription, QODER_REALTIME_SOURCE_ID, realtimeSettingsPlan, realtimeSourceKind, realtimeSubscriptionItems, ZHIPU_REALTIME_SOURCE_ID } from './realtime-settings-model';
import styles from './settings.module.css';

const sourceApi = () => window.klaus.settings;
const NO_OPTIONS: PetRealtimeOptions = { available: false, sourceId: '', protocol: 'public', transcriptSource: 'peer', voices: [] };
/** Per-subscription voice preference key; the historical Codex key keeps its name. */
const realtimeVoiceKey = (sourceId: string) => `desktop_pet.realtime_voice.${sourceId.startsWith('subscription:') ? sourceId.slice('subscription:'.length) : 'codex'}`;

// Realtime source and voice preferences persist as soon as a pick is made. A
// source that is not signed in keeps the previous preference until signing in
// makes it usable, so picking it only surfaces the sign-in notice.
export function RealtimeSettings({ language }: { language: 'en' | 'zh' }) {
  const m = petMessages(language);
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState('');
  const [savedProvider, setSavedProvider] = useState<string | null>(null);
  const [voice, setVoice] = useState('');
  const [voiceTouched, setVoiceTouched] = useState(false);
  const [subscriptionVoice, setSubscriptionVoice] = useState('');
  const [options, setOptions] = useState<PetRealtimeOptions | null>(null);
  const [optionsSource, setOptionsSource] = useState('');
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [saveNonce, setSaveNonce] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      const id = await sourceApi().kv.get('desktop_pet.realtime_provider');
      const provider = typeof id === 'string' ? id : '';
      const configuredVoice = provider ? await sourceApi().kv.get(realtimeVoiceKey(provider)) : '';
      if (!live) return;
      setLoaded(true); setSelected(provider); setSavedProvider(provider);
      setSubscriptionVoice(typeof configuredVoice === 'string' ? configuredVoice : '');
    })().catch(error => { if (live) setError(petVoiceError(error, language)); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    setOptions(null); setError('');
    if (!isRealtimeCapableSubscription(selected)) { setLoadingOptions(false); return; }
    let live = true; setLoadingOptions(true);
    void petApi.realtimeOptions(selected).then(value => {
      if (live) { setOptions(value); setOptionsSource(selected); }
    }).catch(error => { if (live) setError(petVoiceError(error, language)); }).finally(() => { if (live) setLoadingOptions(false); });
    void sourceApi().kv.get(realtimeVoiceKey(selected)).then((value: unknown) => {
      if (live) setSubscriptionVoice(typeof value === 'string' ? value : '');
    }).catch(() => {});
    return () => { live = false; };
  }, [selected, language]);
  // The saved voice seeds the picker; a voice this source no longer offers
  // shows as that source's default until the next pick writes it back.
  useEffect(() => {
    if (!options || optionsSource !== selected) return;
    setVoice(options.voices.includes(subscriptionVoice) ? subscriptionVoice : options.defaultVoice ?? '');
  }, [options, optionsSource, selected, subscriptionVoice]);
  const sourceDirty = savedProvider !== null && selected !== savedProvider;
  const voiceDirty = voiceTouched && voice !== subscriptionVoice;
  const loadedOptions = options && optionsSource === selected ? options : null;
  useEffect(() => {
    if (!loaded || pending || savedProvider === null || (!sourceDirty && !voiceDirty)) return;
    if (selected !== '' && (!loadedOptions || loadingOptions || loadedOptions.available === false)) return;
    const planOptions = loadedOptions ?? NO_OPTIONS;
    setPending(true); setError('');
    void (async () => {
      try {
        const plan = realtimeSettingsPlan({ selected, options: planOptions, sources: [], model: '', voice: planOptions.voices.includes(voice) ? voice : planOptions.defaultVoice ?? '', transcription: '' });
        if (plan.subscriptionVoice && (voiceDirty || sourceDirty)) {
          const result = await sourceApi().kv.set(realtimeVoiceKey(selected), plan.subscriptionVoice) as { ok?: boolean; error?: string } | null;
          if (result?.ok === false || result?.error) throw new Error(result.error || m.error);
          setSubscriptionVoice(plan.subscriptionVoice);
        }
        if (sourceDirty) {
          const result = await sourceApi().kv.set('desktop_pet.realtime_provider', plan.providerPreference) as { ok?: boolean; error?: string } | null;
          if (result?.ok === false || result?.error) throw new Error(result.error || m.error);
          setSavedProvider(plan.providerPreference);
        }
        window.dispatchEvent(new Event('klaus:models-changed'));
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        setError(code === 'model-required' || code === 'source-unavailable' ? m.realtimeModelRequired : code === 'voice-unavailable' ? m.realtimeVoiceUnavailable : code === 'source-changed' ? m.realtimeUnsupportedSource : petVoiceError(code, language));
      } finally { setPending(false); }
    })();
  }, [loaded, pending, savedProvider, selected, voice, sourceDirty, voiceDirty, loadedOptions, loadingOptions, saveNonce]);
  const subscription = realtimeSourceKind(selected) === 'subscription';
  const authMissing = Boolean(options && !options.available && /sign.?in|authenticat|credential|logged.?in/i.test(options.reason || ''));
  const sourceItems = realtimeSubscriptionItems(selected, { disabled: m.realtimeCurrentSource, unsupported: m.realtimeUnsupportedSource }, id => id === CODEX_REALTIME_SOURCE_ID ? m.realtimeSubscriptionSource : id === ZHIPU_REALTIME_SOURCE_ID ? m.realtimeSubscriptionZhipu : id === QODER_REALTIME_SOURCE_ID ? m.realtimeSubscriptionQoder : id);
  const sourceBind = JSON.stringify([language, selected, pending]);
  const onSourceChange = (value: string) => { setSelected(value); setSaveNonce(nonce => nonce + 1); };
  const onVoiceChange = (value: string) => { setVoice(value); setVoiceTouched(true); setSaveNonce(nonce => nonce + 1); };
  return <section className="settings-section" aria-label={m.realtimeSettingsTitle} data-realtime-settings>
    <div className={styles['settings-section-heading']}>
      <div className="settings-section-title" id="realtime-source-label">{m.realtimeSettingsTitle}</div>
      <p className={styles['settings-section-hint']}>{m.realtimeSettingsDescription}</p>
    </div>
    {error && <p className="card-meta" style={{ color: 'var(--danger)' }} role="alert">{error}</p>}
    {!loaded ? <p role="status">{m.loading}</p> : <>
      {subscription && loadedOptions && loadedOptions.available !== false ? <div className={`${styles['pref-card']} ${styles['default-model-card']}`} data-realtime-card>
        <div className="pref-row">
          <div className={styles['pref-row-text']}>
            <div className={styles['pref-row-label']} id="realtime-source-row-label">{t('model_tiers_source')}</div>
          </div>
          <ModelSourceSelect id="realtime-source" labelId="realtime-source-row-label" bindKey={sourceBind} ariaLabel={m.realtimeSource} className={`kls-select ${styles['model-tier-select']}`} value={selected} disabled={pending} items={sourceItems} onChange={onSourceChange} />
        </div>
        <div className="pref-row">
          <div className={styles['pref-row-text']}>
            <div className={styles['pref-row-label']} id="realtime-model-label">{m.realtimeModel}</div>
          </div>
          <div id="realtime-model" data-realtime-model-static className={`${styles['model-tier-select']} ${styles['media-model-static']}`} aria-labelledby="realtime-model-label">{loadedOptions.model?.trim() || t('media_model_service_default')}</div>
        </div>
        {loadedOptions.voices.length > 0 && <div className="pref-row">
          <div className={styles['pref-row-text']}>
            <div className={styles['pref-row-label']} id="realtime-voice-label">{m.realtimeVoice}</div>
          </div>
          <KlsSelect id="realtime-voice" labelId="realtime-voice-label" bindKey={JSON.stringify([language, selected, voice, pending, loadedOptions.voices])} ariaLabel={m.realtimeVoice} className={`kls-select ${styles['model-tier-select']}`} value={voice} disabled={pending} items={loadedOptions.voices.map(item => ({ value: item, label: item }))} onChange={onVoiceChange} />
        </div>}
      </div> : <ModelSourceSelect id="realtime-source" labelId="realtime-source-label" bindKey={sourceBind} ariaLabel={m.realtimeSource} className="kls-select kls-select-block" value={selected} disabled={pending} items={sourceItems} onChange={onSourceChange} />}
      {loadingOptions && <p role="status">{m.loading}</p>}
      {options && !options.available && <p className={styles['settings-section-hint']} role="status">{authMissing ? m.realtimeSignInRequired : petVoiceError(options.reason || 'realtime-source-unsupported', language)}</p>}
      {subscription && <p className={styles['settings-section-hint']}>{m.realtimeSubscriptionDescription}</p>}
      {!selected && <p className={styles['settings-section-hint']}>{m.realtimeCurrentSourceHint}</p>}
    </>}
  </section>;
}
