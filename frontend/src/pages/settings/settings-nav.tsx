// The header stays outside the scrollable navigation. Keep filtered entries
// mounted because the settings shell owns active-tab classes and aria-current.
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../components/Icon'
import { filterNavEntries, visibleNavEntries } from './settings-nav-entries'
import { loadSettingsTab, toggleSettings } from './shell'
import styles from './settings.module.css'

const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '')

interface UpdaterStatusLite { currentVersion?: string; supported?: boolean; error?: string | null }

const BACK_I18N = 'settings_back_to_app'

// The bundle version, read from the updater status the shell already serves
// (same payload the update banner reads). The About menu row is macOS-only, so
// this footer is the one place every platform shows the running version.
// Rendered as a plain node (not via data-i18n) because the version string is
// runtime data; the label half re-renders on language change via useT.
function VersionFooter() {
  const tr = useT()
  const [version, setVersion] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const api = (window as unknown as { klaus?: { updater?: { status?: () => Promise<UpdaterStatusLite> } } }).klaus
    api?.updater?.status?.()
      .then(status => {
        if (cancelled) return
        setVersion(status?.currentVersion ?? null)
        // Keep the reason for unavailable updates beside the running version
        // so every platform has a visible explanation.
        setUnavailable(status && status.supported === false ? (status.error || 'updates_unavailable') : null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  if (!version) return null
  return (
    <div className={styles['settings-version']}>
      {tr('settings_version_label')} {version}
      {unavailable && (
        <div className={styles['settings-version-unavailable']}>{tr('update_unavailable_notice').replace('{reason}', unavailable)}</div>
      )}
    </div>
  )
}

function SettingsSidebar() {
  const tr = useT()
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Opening settings can target any tab; do not leave its focus target hidden.
    const resetSearch = () => setQuery('')
    window.addEventListener('klaus:settings-visibility-change', resetSearch)
    return () => window.removeEventListener('klaus:settings-visibility-change', resetSearch)
  }, [])
  const entries = visibleNavEntries(IS_MAC)
  const matches = new Set(filterNavEntries(entries, query, tr))
  function updateQuery(value: string) {
    setQuery(value)
    if (scroll.current) scroll.current.scrollTop = 0
  }
  return (
    <>
      <header className={styles['settings-sidebar-header']}>
        <button type="button" className={styles['settings-back']} id="settings-back" onClick={() => toggleSettings()}>
          <Icon name="settings-back" />
          <span data-i18n={BACK_I18N}>{tr(BACK_I18N)}</span>
        </button>
        <h1 className={styles['settings-sidebar-title']}>{tr('settings')}</h1>
        <div className={styles['settings-search']}>
          <Icon name="search" />
          <input
            ref={search} id="settings-search" type="search" autoComplete="off" spellCheck={false}
            placeholder={tr('search_placeholder')} aria-label={tr('settings_search')}
            value={query} onChange={event => updateQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                event.stopPropagation()
                updateQuery('')
              }
            }}
          />
          {query && <button type="button" aria-label={tr('settings_search_clear')} onClick={() => {
            updateQuery('')
            search.current?.focus()
          }}><Icon name="close" /></button>}
        </div>
      </header>
      <div ref={scroll} className={styles['settings-sidebar-scroll']}>
        <nav className={styles['settings-sidebar-nav']} aria-label={tr('settings')}>
          {entries.map(entry => entry.kind === 'group'
            ? <div className={styles['settings-sidebar-group']} hidden={!matches.has(entry)} data-i18n={entry.i18n} key={entry.i18n}>{tr(entry.i18n)}</div>
            : (
              <button
                type="button" hidden={!matches.has(entry)}
                className={`${styles['settings-nav-item']}${entry.stab === 'profile' ? ' active' : ''}`}
                data-stab={entry.stab} id={entry.id} key={entry.stab}
                aria-current={entry.stab === 'profile' ? 'page' : undefined}
                onClick={() => loadSettingsTab(entry.stab!)}
              >
                <Icon name={entry.icon!} />
                <span data-i18n={entry.i18n}>{tr(entry.i18n)}</span>
              </button>
            ))}
        </nav>
        {matches.size === 0 && <p className={styles['settings-search-empty']} role="status">{tr('settings_search_empty')}</p>}
        <VersionFooter />
      </div>
    </>
  )
}

// Mount once; language changes update the labels and current search results.
export function mountSettingsSidebar(): void {
  const host = document.querySelector('#settings-view .settings-sidebar')
  if (!host) return
  createRoot(host).render(<SettingsSidebar />)
}
