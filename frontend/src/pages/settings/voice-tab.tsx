// Voice preferences expose personalization and a shared correction dictionary.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLang, useT } from '../../i18n'
import { SettingsPage, boolChecked, kvGet, kvSet, PrefToggleRow } from './kv'
import { VOICE_DICTIONARY_TERM_MAX_LENGTH } from '../../../../shared/voice-input'
import { dictionaryWords, parseDictionaryCsv, type DictionaryFilter, type DictionaryWord } from './voice-dictionary'
import { FeatureModelRow, useFeatureModelSettings } from './feature-models'
import { VOICE_REFINEMENT_FEATURE_MODEL_ROW } from './feature-models-state'
import { useVoiceInputSource, VoiceInputSourceRow } from './voice-source-settings'
import { RealtimeSettings } from './realtime-settings'
import styles from './settings.module.css'
import voiceStyles from './voice-settings.module.css'

const w = () => window as any
let personalizationCache: boolean | null = null
let personalizationRevision = 0
let personalizationPending = false
let wordsCache: DictionaryWord[] | null = null
let wordsRevision = 0

function ActionMenu({ label, disabled, items }: { label: string; disabled?: boolean; items: Array<{ label: string; run(): void; danger?: boolean }> }) {
  const button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    if (!position) return
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return
      if (event.type === 'pointerdown' && (button.current?.contains(event.target as Node) || menu.current?.contains(event.target as Node))) return
      setPosition(null)
      if (event.type === 'keydown') button.current?.focus()
    }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', close); window.addEventListener('resize', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); window.removeEventListener('resize', close) }
  }, [position])
  return <>
    <button type="button" className="btn-sm" ref={button} aria-label={label} aria-haspopup="menu" aria-expanded={!!position} disabled={disabled} onClick={() => {
      const rect = button.current!.getBoundingClientRect()
      setPosition(current => current ? null : { top: Math.min(window.innerHeight - items.length * 36 - 20, rect.bottom + 4), left: Math.max(8, Math.min(window.innerWidth - 204, rect.right - 196)) })
    }}>⋯</button>
    {position ? createPortal(<div className={voiceStyles.menu} role="menu" ref={menu} style={position}>
      {items.map(item => <button type="button" role="menuitem" className={item.danger ? voiceStyles.danger : ''} key={item.label} onClick={() => { setPosition(null); item.run() }}>{item.label}</button>)}
    </div>, document.body) : null}
  </>
}

export function VoiceInputSettingsTab() {
  const t = useT()
  const language = useLang()
  const [personalized, setPersonalized] = useState<boolean | null>(() => personalizationCache)
  const [words, setWords] = useState<DictionaryWord[]>(() => wordsCache ?? [])
  const [loading, setLoading] = useState(() => wordsCache === null)
  const [error, setError] = useState(''), [personalizationError, setPersonalizationError] = useState('')
  const [busy, setBusy] = useState(() => personalizationPending), [filter, setFilter] = useState<DictionaryFilter>('all'), [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const fileInput = useRef<HTMLInputElement>(null), mounted = useRef(false), request = useRef(0)
  const api = () => w().klaus?.voice
  const voiceSource = useVoiceInputSource()
  const voiceRefinementModel = useFeatureModelSettings()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const loadWords = useCallback(async () => {
    const current = ++request.current, revision = wordsRevision
    if (mounted.current) { setLoading(wordsCache === null); setError('') }
    try {
      const result = await w().klaus?.voice?.hotwords?.list?.()
      if (!mounted.current || current !== request.current || revision !== wordsRevision) return
      if (!Array.isArray(result)) throw Error(t('settings_section_load_failed'))
      wordsCache = result; setWords(result)
      setSelected(previous => new Set([...previous].filter(id => result.some(word => word.id === id && word.enabled !== false))))
    } catch (value: any) {
      if (mounted.current && current === request.current) setError(value?.message || t('settings_section_load_failed'))
    } finally { if (mounted.current && current === request.current) setLoading(false) }
  }, [t])
  const loadPersonalization = useCallback(async () => {
    const revision = personalizationRevision
    setPersonalizationError(''); setBusy(personalizationPending)
    try {
      const result = await kvGet('voice.learning.enabled')
      if (!mounted.current || revision !== personalizationRevision || personalizationPending) return
      personalizationCache = boolChecked(result, true); setPersonalized(personalizationCache)
    } catch (value: any) { if (mounted.current) setPersonalizationError(value?.message || t('settings_section_load_failed')) }
  }, [t])
  useEffect(() => {
    void loadWords(); void loadPersonalization()
    window.addEventListener('klaus:voice-dictionary-changed', loadWords)
    window.addEventListener('klaus:voice-personalization-changed', loadPersonalization)
    return () => { window.removeEventListener('klaus:voice-dictionary-changed', loadWords); window.removeEventListener('klaus:voice-personalization-changed', loadPersonalization) }
  }, [loadWords, loadPersonalization])
  const showFailure = (value: any) => w().showToast(value?.message || t('settings_failed'))
  const refresh = async () => { wordsRevision++; await loadWords(); window.dispatchEvent(new Event('klaus:voice-dictionary-changed')) }
  const setPersonalization = async (next: boolean) => {
    if (busy) return
    if (!next && !await w().klausDialog.confirm({ title: t('voice_personalization_disable'), message: t('voice_personalization_disable_confirm'), confirmText: t('voice_personalization_disable'), cancelText: t('cancel') })) return
    const previous = personalized
    setBusy(true); personalizationPending = true; personalizationRevision++; personalizationCache = next; setPersonalized(next)
    try {
      if (!await kvSet('voice.learning.enabled', next ? 'on' : 'off')) { personalizationCache = previous; if (mounted.current) setPersonalized(previous) }
    } finally { personalizationPending = false; if (mounted.current) setBusy(false); window.dispatchEvent(new Event('klaus:voice-personalization-changed')) }
  }
  const editWord = async (word?: DictionaryWord) => {
    if (busy) return
    await w().klausDialog.prompt({ title: t(word ? 'voice_dictionary_edit' : 'voice_dictionary_new'), message: t('voice_dictionary_term_hint'), placeholder: t('voice_dictionary_term'), initialValue: word?.text || '', confirmText: t(word ? 'voice_dictionary_save' : 'voice_dictionary_add'), cancelText: t('cancel'),
      onConfirm: async (value: string) => {
        const term = value.trim()
        if (!term || term.length > VOICE_DICTIONARY_TERM_MAX_LENGTH) { w().showToast(t('voice_dictionary_term_limit')); return false }
        try {
          const result = await api().hotwords.add(term, word?.id)
          if (result?.ok !== true) throw Error(t(result?.error === 'voice-dictionary-term-exists' ? 'voice_dictionary_exists' : 'settings_failed'))
          await refresh(); return true
        } catch (value: any) { showFailure(value); return false }
      },
    })
  }
  const deleteWords = async (ids: string[]) => {
    if (busy || !ids.length) return
    if (!await w().klausDialog.confirm({ title: t('voice_dictionary_delete'), message: t('voice_dictionary_delete_confirm').replace('{count}', String(ids.length)), confirmText: t('voice_delete'), cancelText: t('cancel'), danger: true })) return
    setBusy(true)
    try {
      const results = await Promise.all(ids.map(id => api().hotwords.remove(id)))
      if (results.some(result => result?.ok !== true)) throw Error(t('settings_failed'))
    } catch (value: any) { showFailure(value) }
    finally { await refresh(); if (mounted.current) setBusy(false) }
  }
  const importFile = async (file?: File) => {
    if (!file || busy) return
    try {
      if (file.size > 5 * 1024 * 1024) throw Error('voice_dictionary_csv_size')
      const parsed = parseDictionaryCsv(await file.text())
      const existing = new Set(words.filter(word => word.enabled !== false).map(word => word.text))
      const ready = parsed.filter(term => !existing.has(term))
      if (!ready.length) { w().showToast(t('voice_dictionary_import_empty')); return }
      if (!await w().klausDialog.confirm({ title: t('voice_dictionary_import'), message: t('voice_dictionary_import_preview').replace('{count}', String(ready.length)), detail: ready.join('\n'), confirmText: t('voice_dictionary_add'), cancelText: t('cancel') })) return
      setBusy(true)
      let succeeded = 0, failed = 0
      for (let offset = 0; offset < ready.length; offset += 200) {
        const results = await Promise.all(ready.slice(offset, offset + 200).map(term => api().hotwords.add(term).catch(() => null)))
        succeeded += results.filter(result => result?.ok === true).length; failed += results.filter(result => result?.ok !== true).length
      }
      await refresh()
      w().showToast(t('voice_dictionary_import_result').replace('{succeeded}', String(succeeded)).replace('{failed}', String(failed)))
    } catch (value: any) { w().showToast(t(value?.message?.startsWith('voice_dictionary_') ? value.message : 'settings_failed')) }
    finally { if (mounted.current) setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }
  const visible = dictionaryWords(words, filter, search)
  const allSelected = !!visible.length && visible.every(word => selected.has(word.id))
  return <SettingsPage title={t('voice_settings')} subtitle={t('voice_settings_desc')}>
    <section className="settings-section">
      <div className={styles['pref-card']} data-voice-input-card aria-busy={voiceSource.pending}>
        <PrefToggleRow id="voice-personalization-toggle" label={t('voice_personalization_title')} desc={t('voice_personalization_desc')}
          checked={personalized !== false} disabled={personalized === null || busy} onChange={checked => { void setPersonalization(checked) }} />
        <VoiceInputSourceRow source={voiceSource.source} availability={voiceSource.capabilities?.availability || {}}
          disabled={voiceSource.disabled} onChange={next => { void voiceSource.save(next) }} />
        <FeatureModelRow row={VOICE_REFINEMENT_FEATURE_MODEL_ROW} model={voiceRefinementModel} />
      </div>
      {personalizationError ? <p role="alert" className="card-meta">{personalizationError} <button type="button" className="btn-sm" onClick={() => { void loadPersonalization() }}>{t('auth_status_retry')}</button></p> : null}
      {voiceSource.error ? <p className="card-meta" role="alert">{voiceSource.error} <button type="button" className="btn-sm" onClick={voiceSource.reload}>{t('auth_status_retry')}</button></p> : null}
    </section>
    <RealtimeSettings language={language} />
    <section className="settings-section">
      <div className={`${styles['settings-section-heading']} ${voiceStyles.heading}`}>
        <div><div className="settings-section-title">{t('voice_dictionary_title')}</div><p className={styles['settings-section-hint']}>{t('voice_dictionary_desc')}</p></div>
        <div className={voiceStyles.actions}>
          <button type="button" className="btn-sm" id="voice-dictionary-import" disabled={busy} onClick={() => fileInput.current?.click()}>{t('voice_dictionary_import')}</button>
          <button type="button" className="btn-sm" id="voice-dictionary-new" disabled={busy} onClick={() => { void editWord() }}>{t('voice_dictionary_new')}</button>
          <input type="file" accept=".csv,text/csv" hidden ref={fileInput} onChange={event => { void importFile(event.target.files?.[0]) }} />
        </div>
      </div>
      <div className={voiceStyles.toolbar}>
        <div role="tablist" aria-label={t('voice_dictionary_filter')} className={voiceStyles.filters}>
          {(['all', 'learned', 'manual'] as const).map(value => <button type="button" role="tab" aria-selected={filter === value} key={value} onClick={() => { setFilter(value); setSelected(new Set()) }}>{t(`voice_dictionary_filter_${value}`)}</button>)}
        </div>
        <input type="search" className={styles['settings-field-input']} id="voice-dictionary-search" aria-label={t('voice_dictionary_search')} placeholder={t('voice_dictionary_search')} value={search} onChange={event => { setSearch(event.target.value); setSelected(new Set()) }} />
      </div>
      <div className={styles['pref-card']} id="voice-dictionary-list" aria-busy={loading || busy}>
        {loading ? <div className="pref-row">{t('loading')}</div> : error ? <div className="pref-row" role="alert">{error} <button type="button" className="btn-sm" onClick={() => { void loadWords() }}>{t('auth_status_retry')}</button></div> : !visible.length ? <div className="pref-row">{t(search ? 'voice_dictionary_no_results' : 'voice_dictionary_empty')}</div> : <>
          <div className={`pref-row ${voiceStyles.row}`}>
            <input type="checkbox" aria-label={t('voice_dictionary_select_all')} checked={allSelected} disabled={busy} onChange={event => setSelected(event.target.checked ? new Set(visible.map(word => word.id)) : new Set())} />
            <span className={voiceStyles.term}>{t('voice_dictionary_words').replace('{count}', String(visible.length))}</span>
            {selected.size ? <button type="button" className="btn-sm" id="voice-dictionary-delete-selected" disabled={busy} onClick={() => { void deleteWords([...selected]) }}>{t('voice_dictionary_delete_selected').replace('{count}', String(selected.size))}</button> : null}
          </div>
          {visible.map(word => <div className={`pref-row ${voiceStyles.row}`} data-word-id={word.id} key={word.id}>
            <input type="checkbox" aria-label={t('voice_dictionary_select').replace('{term}', word.text)} checked={selected.has(word.id)} disabled={busy} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(word.id); else next.delete(word.id); return next })} />
            <span className={voiceStyles.term}>{word.text}</span>
            <ActionMenu label={t('voice_dictionary_word_actions').replace('{term}', word.text)} disabled={busy} items={[{ label: t('voice_dictionary_edit'), run: () => { void editWord(word) } }, { label: t('voice_delete'), danger: true, run: () => { void deleteWords([word.id]) } }]} />
          </div>)}
        </>}
      </div>
    </section>
  </SettingsPage>
}
