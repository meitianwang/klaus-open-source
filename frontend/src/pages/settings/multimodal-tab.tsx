import { useT } from '../../i18n'
import { EffectiveMediaModels } from './effective-media-models'
import { SettingsPage } from './kv'
import styles from './settings.module.css'

export function MultimodalSettingsTab() {
  const t = useT()
  const rows = [
    { kind: 'image', id: 'tier-image-select', labelKey: 'image_tier_title' },
    { kind: 'audio', id: 'tier-audio-select', labelKey: 'audio_gen_settings' },
    { kind: 'music', id: 'tier-music-select', labelKey: 'music_gen_settings' },
    { kind: 'video', id: 'tier-video-select', labelKey: 'video_gen_settings' },
  ] as const
  return <SettingsPage title={t('multimodal_models_settings')} subtitle={t('multimodal_models_settings_desc')}>
    <div className={styles['tiers-body']} data-multimodal-models>
      {rows.map(row => <section className={styles['tiers-group']} data-multimodal-kind={row.kind} key={row.kind}>
        <div className="settings-section-title">{t(row.labelKey)}</div>
        <EffectiveMediaModels kind={row.kind} id={row.id} label={t(row.labelKey)} />
      </section>)}
    </div>
  </SettingsPage>
}
