import { useT } from '../../i18n'
import { GlobalModelTiers } from './global-model-tiers'
import { SettingsPage } from './kv'
import { openModelSettings } from './shell'

export function ModelTiersSettingsTab() {
  const t = useT()
  return <SettingsPage title={t('model_mapping_title')} subtitle={t('model_mapping_desc')}>
    <GlobalModelTiers configureSource={openModelSettings} />
  </SettingsPage>
}
