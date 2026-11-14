import { agentAcquisitionStore, skillAcquisitionStore } from '../../components/extension-acquisition-store'
import { t } from '../../i18n'
import { pluginStore } from './plugin-store'
import styles from './plugins.module.css'

function upsertNavBadge(
  buttonId: string,
  labelKey: string,
  countKey: string,
  datasetName: string,
  count: number,
  suppress: boolean,
): void {
  const button = document.getElementById(buttonId)
  if (!button) return
  const attr = datasetName.replace(/([A-Z])/g, match => `-${match.toLowerCase()}`)
  let badge = button.querySelector<HTMLElement>(`[data-${attr}]`)
  if (!badge) {
    badge = document.createElement('span')
    badge.className = styles['pl-nav-count']!
    badge.dataset[datasetName] = ''
    badge.setAttribute('aria-hidden', 'true')
    button.appendChild(badge)
  }
  badge.hidden = !count || suppress
  badge.textContent = String(count)
  button.setAttribute(
    'aria-label',
    count > 0 && !suppress
      ? `${t(labelKey)}, ${t(countKey).replace('{count}', String(count))}`
      : t(labelKey),
  )
}

/** Keep quiet update counts visible across Plugins, Skills and Sub-agents. */
export function initializePluginNavigation(): void {
  const render = () => {
    const pluginCount = pluginStore.getSnapshot().data?.plugins.filter(plugin => plugin.installed && plugin.updateAvailable).length ?? 0
    const skillCount = skillAcquisitionStore.getSnapshot().availableUpdates
    const agentCount = agentAcquisitionStore.getSnapshot().availableUpdates
    const totalCount = pluginCount + skillCount + agentCount
    const group = document.getElementById('btn-extensions')
    const expanded = group?.getAttribute('aria-expanded') === 'true'

    upsertNavBadge('btn-plugins', 'plugins', 'plugins_updates_count', 'pluginUpdateCount', pluginCount, false)
    upsertNavBadge('btn-skills', 'skills', 'skills_updates_count', 'skillUpdateCount', skillCount, false)
    upsertNavBadge('btn-agents', 'agents', 'agents_updates_count', 'agentUpdateCount', agentCount, false)
    upsertNavBadge('btn-extensions', 'extensions', 'plugins_updates_count', 'pluginUpdateCount', totalCount, expanded)
  }
  pluginStore.subscribe(render)
  skillAcquisitionStore.subscribe(render)
  agentAcquisitionStore.subscribe(render)
  window.addEventListener('klaus:lang-change', render)
  // Collapse/expand is owned by the sidebar shell; watch the group's expanded
  // state so the badge can yield to the child row without a second owner.
  const group = document.getElementById('btn-extensions')
  if (group) new MutationObserver(() => render()).observe(group, { attributes: true, attributeFilter: ['aria-expanded'] })
  ;(window as any).klaus?.on?.appPreferencesChanged?.(({ key }: { key?: string }) => {
    if (key === 'plugins') void pluginStore.load()
  })
  render()
  void pluginStore.load()
}
