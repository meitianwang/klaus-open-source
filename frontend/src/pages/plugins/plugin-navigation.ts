import { t } from '../../i18n'
import { pluginStore } from './plugin-store'
import styles from './plugins.module.css'

/** Keep quiet update counts visible even before the marketplace is first opened. */
export function initializePluginNavigation(): void {
  const render = () => {
    const count = pluginStore.getSnapshot().data?.plugins.filter(plugin => plugin.installed && plugin.updateAvailable).length ?? 0
    for (const [id, label] of [['btn-plugins', 'plugins'], ['btn-extensions', 'extensions']]) {
      const button = document.getElementById(id!)
      if (!button) continue
      let badge = button.querySelector<HTMLElement>('[data-plugin-update-count]')
      if (!badge) {
        badge = document.createElement('span')
        badge.className = styles['pl-nav-count']!
        badge.dataset.pluginUpdateCount = ''
        badge.setAttribute('aria-hidden', 'true')
        button.appendChild(badge)
      }
      badge.hidden = !count
      badge.textContent = String(count)
      button.setAttribute('aria-label', count ? `${t(label!)}, ${t('plugins_updates_count').replace('{count}', String(count))}` : t(label!))
    }
  }
  pluginStore.subscribe(render)
  window.addEventListener('klaus:lang-change', render)
  ;(window as any).klaus?.on?.appPreferencesChanged?.(({ key }: { key?: string }) => {
    if (key === 'plugins') void pluginStore.load()
  })
  render()
  void pluginStore.load()
}
