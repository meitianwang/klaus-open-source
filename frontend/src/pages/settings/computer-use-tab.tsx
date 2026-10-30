import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { showToast } from '../../app/ui-shared'
import { SettingsPage } from './kv'
import { StorageButton, StorageDialog } from './storage-dialog'
import styles from './computer-use.module.css'

interface AppDetails { name: string; iconDataUrl?: string }
interface InstalledApp { name: string; path: string; bundleId?: string; running?: boolean; iconDataUrl?: string }
interface Settings { allowedApps: string[] }
const api = () => (window as any).settingsApi.computerUse
const label = (app: string) => app === 'app:self' ? 'Klaus' : app.replace(/^(bundle:|path:|name:)/, '')
const iconSource = (value: unknown) => typeof value === 'string' && value.length < 90_000
  && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) ? value : undefined
function settings(value: any): Settings {
  if (value?.ok === false || !Array.isArray(value?.allowedApps) || value.allowedApps.some((app: unknown) => typeof app !== 'string'))
    throw Error(value?.error || 'Invalid application settings')
  return value
}
function catalog(value: any): InstalledApp[] {
  return (Array.isArray(value?.apps) ? value.apps : []).flatMap((app: any) => typeof app?.name === 'string'
    && typeof app?.path === 'string' && app.path.length > 0 && app.path.length <= 4096
    ? [{ name: app.name, path: app.path, iconDataUrl: iconSource(app.iconDataUrl),
      ...(typeof app.bundleId === 'string' ? { bundleId: app.bundleId } : {}),
      ...(app.running === true ? { running: true } : {}) }]
    : [])
}

export function ComputerUseSettingsTab() {
  const t = useT()
  const [apps, setApps] = useState<string[] | null>(null), [error, setError] = useState(false)
  const [pending, setPending] = useState<string | null>(null), [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false), [appInput, setAppInput] = useState('')
  const [addError, setAddError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [details, setDetails] = useState<Record<string, AppDetails>>({})
  const [installed, setInstalled] = useState<InstalledApp[] | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [query, setQuery] = useState(''), [selected, setSelected] = useState('')
  const [manual, setManual] = useState(false)
  const [pickerIcons, setPickerIcons] = useState<Record<string, string>>({})
  const alive = useRef(false), revision = useRef(0), locked = useRef(false)
  const list = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), appList = useRef<HTMLDivElement>(null)
  const focusAfter = useRef<string | null>(null), buttons = useRef(new Map<string, HTMLButtonElement>())
  const load = useCallback(async () => {
    const current = ++revision.current
    setError(false)
    try {
      const result = settings(await api().get())
      if (alive.current && current === revision.current) setApps(result.allowedApps)
    } catch { if (alive.current && current === revision.current) setError(true) }
  }, [])
  useEffect(() => {
    alive.current = true; void load()
    return () => { alive.current = false; revision.current++ }
  }, [load])
  useLayoutEffect(() => {
    if (pending || adding || saving || focusAfter.current === null) return
    const target = buttons.current.get(focusAfter.current) ?? heading.current
    focusAfter.current = null
    target?.focus()
  }, [apps, pending, adding, saving])
  useEffect(() => {
    if (!apps || !list.current) return
    let disposed = false, active = 0
    const queued: string[] = [], seen = new Set<string>()
    const pump = () => {
      while (!disposed && active < 2 && queued.length) {
        const app = queued.shift()!
        active++
        void Promise.resolve().then(() => api().appDetails(app)).then((value: AppDetails) => {
          if (!disposed && typeof value?.name === 'string') {
            setDetails(previous => ({ ...previous, [app]: { name: value.name, iconDataUrl: iconSource(value.iconDataUrl) } }))
          }
        }).catch(() => {}).finally(() => { active--; pump() })
      }
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const app = (entry.target as HTMLElement).dataset.app!
        observer.unobserve(entry.target)
        if (!seen.has(app)) { seen.add(app); queued.push(app) }
      }
      pump()
    }, { rootMargin: '80px' })
    list.current.querySelectorAll<HTMLElement>('[data-app]').forEach(row => observer.observe(row))
    return () => { disposed = true; observer.disconnect() }
  }, [apps])
  useEffect(() => {
    if (!adding) return
    let disposed = false
    setInstalled(null); setCatalogError(false)
    api().listApps().then((value: unknown) => { if (!disposed) setInstalled(catalog(value)) })
      .catch(() => { if (!disposed) setCatalogError(true) })
    return () => { disposed = true }
  }, [adding])


  const remove = async () => {
    if (!pending || locked.current) return
    locked.current = true; setSaving(true); setSaveError(false); revision.current++
    const app = pending, index = apps!.indexOf(app), name = details[app]?.name ?? label(app)
    try {
      const result = await api().removeAllowedApp(app)
      const next = settings(result?.ok === false ? result : result?.settings).allowedApps
      if (!alive.current) return
      focusAfter.current = next[Math.min(index, next.length - 1)] ?? ''
      setApps(next); setPending(null)
      showToast(t('computer_use_app_removed').replace('{name}', name), { tone: 'success' })
    } catch {
      if (alive.current) setSaveError(true)
    } finally { locked.current = false; if (alive.current) setSaving(false) }
  }
  const pendingName = pending ? details[pending]?.name ?? label(pending) : ''
  const add = async (value: string) => {
    const selector = value.trim()
    if (!selector || locked.current) return
    locked.current = true; setSaving(true); setAddError(false); revision.current++
    try {
      const result = await api().addAllowedApp(selector)
      const next = settings(result?.ok === false ? result : result?.settings).allowedApps
      if (!alive.current) return
      setApps(next); setAdding(false); setAppInput(''); setSelected(''); setQuery('')
      showToast(t('computer_use_app_added'), { tone: 'success' })
    } catch {
      if (alive.current) setAddError(true)
    } finally { locked.current = false; if (alive.current) setSaving(false) }
  }
  const allowed = new Set(apps ?? [])
  const needle = query.trim().toLowerCase()
  const filtered = (installed ?? []).filter(app => !needle || app.name.toLowerCase().includes(needle)
    || app.path.toLowerCase().includes(needle) || (app.bundleId ?? '').toLowerCase().includes(needle))
    .sort((left, right) => Number(!!right.running) - Number(!!left.running)
      || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  const firstPick = filtered.find(app => !allowed.has(`path:${app.path}`) && !allowed.has(app.name))
  return <SettingsPage title={t('computer_use_title')} subtitle={t('computer_use_settings_desc')}>
    <section aria-labelledby="computer-use-apps-title" className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 id="computer-use-apps-title" ref={heading} tabIndex={-1}>{t('computer_use_apps_title')}</h2>
        <StorageButton id="computer-use-add-app" disabled={apps === null || error || saving || !!pending}
          onClick={() => { setAddError(false); setAppInput(''); setQuery(''); setSelected(''); setManual(false); setInstalled(null); setCatalogError(false); setAdding(true) }}>
          {t('computer_use_app_add')}</StorageButton>
      </div>
      <div className={styles.card} ref={list} aria-busy={apps === null && !error}>
        {error ? <div className={styles.message} role="alert">{t('computer_use_apps_load_error')} <StorageButton onClick={() => void load()}>{t('computer_use_retry')}</StorageButton></div>
          : apps === null ? <div className={styles.message} role="status">{t('loading')}</div>
          : !apps.length ? <div className={styles.message}>{t('computer_use_apps_empty')}</div>
          : apps.map(app => {
            const item = details[app], name = item?.name ?? label(app)
            return <div className={styles.row} key={app} data-app={app}>
              <span className={styles.icon} aria-hidden="true">{item?.iconDataUrl
                ? <img src={item.iconDataUrl} width={32} height={32} alt="" onError={() => setDetails(previous => ({ ...previous, [app]: { name } }))} />
                : <Icon name="computer-use-pip" size={24} />}</span>
              <span className={styles.name}>{name}</span>
              <button type="button" className={styles.remove} aria-label={t('computer_use_app_remove').replace('{name}', name)}
                ref={node => { if (node) buttons.current.set(app, node); else buttons.current.delete(app) }}
                disabled={saving || adding} onClick={() => { setSaveError(false); setPending(app) }}><Icon name="trash" size={18} /></button>
            </div>
          })}
      </div>
    </section>
    {adding && <StorageDialog wide title={t('computer_use_app_add')} description={t('computer_use_app_picker_desc')}
      returnFocusId="computer-use-add-app" onClose={() => { if (!locked.current) setAdding(false) }} dismissible={!saving}
      footer={<><StorageButton disabled={saving} onClick={() => setAdding(false)}>{t('cancel')}</StorageButton>
        <StorageButton busy={saving} disabled={saving || (!selected && !appInput.trim())}
          onClick={() => void add(selected || appInput)}>{t('computer_use_add')}</StorageButton></>}>
      <div className={styles.picker}>
        <label className={styles.search}>
          <Icon name="search" size={16} />
          <input data-storage-autofocus autoFocus autoComplete="off" maxLength={256} type="search"
            aria-label={t('computer_use_app_search_label')} placeholder={t('computer_use_app_search_placeholder')}
            value={query} disabled={saving}
            onChange={event => { setQuery(event.target.value); setSelected('') }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || manual || !firstPick) return
              event.preventDefault(); void add(`path:${firstPick.path}`)
            }} />
        </label>
        <div className={styles.appList} ref={appList} role="listbox" aria-label={t('computer_use_app_search_label')}
          aria-busy={installed === null && !catalogError}>
          {catalogError ? <div className={styles.pickerMessage} role="alert">{t('computer_use_app_picker_error')}</div>
            : installed === null ? <div className={styles.pickerMessage} role="status">{t('loading')}</div>
            : !filtered.length ? <div className={styles.pickerMessage}>{t('computer_use_app_no_matches')}</div>
            : filtered.map(app => {
              const selector = `path:${app.path}`, added = allowed.has(selector) || allowed.has(app.name)
              const icon = app.iconDataUrl
              return <button type="button" role="option" key={app.path} aria-selected={selected === selector}
                disabled={added || saving} data-catalog-path={app.path}
                className={styles.appOption} onClick={() => { setSelected(selector); setManual(false) }}>
                <span className={styles.icon} aria-hidden="true">{icon
                  ? <img src={icon} width={32} height={32} alt="" />
                  : <Icon name="computer-use-pip" size={24} />}</span>
                <span className={styles.appText}>
                  <span className={styles.appName}>{app.name}</span>
                  <span className={styles.appPath}>{app.path}</span>
                </span>
                {app.running && <span className={styles.badge}>{t('computer_use_app_running')}</span>}
                {added && <span className={styles.badge}>{t('computer_use_app_already_added')}</span>}
              </button>
            })}
        </div>
        {manual
          ? <form className={styles.addForm} onSubmit={event => { event.preventDefault(); void add(appInput) }}>
            <label htmlFor="computer-use-app-input">{t('computer_use_app_manual_label')}</label>
            <input id="computer-use-app-input" autoComplete="off" maxLength={4096}
              value={appInput} disabled={saving} aria-invalid={addError || undefined}
              aria-describedby={addError ? 'computer-use-add-error' : undefined}
              onChange={event => { setAppInput(event.target.value); setAddError(false) }} />
            {addError && <p id="computer-use-add-error" role="alert">{t('computer_use_app_add_error')}</p>}
          </form>
          : <button type="button" className={styles.manualToggle} onClick={() => setManual(true)}>{t('computer_use_app_manual_toggle')}</button>}
      </div>
    </StorageDialog>}
    {pending && <StorageDialog title={t('computer_use_app_remove_title').replace('{name}', pendingName)}
      description={t('computer_use_app_remove_desc').replace('{name}', pendingName)}
      onClose={() => { if (!locked.current) setPending(null) }} dismissible={!saving}
      footer={<><StorageButton autoFocus disabled={saving} onClick={() => setPending(null)}>{t('cancel')}</StorageButton>
        <StorageButton danger busy={saving} disabled={saving} onClick={() => void remove()}>{t('computer_use_remove')}</StorageButton></>}>
      {saveError && <p role="alert">{t('computer_use_apps_save_error')}</p>}
    </StorageDialog>}
  </SettingsPage>
}
