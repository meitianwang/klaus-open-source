import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RuntimeConfigScope, RuntimeConfigSnapshot, RuntimeSettingKey } from '../../../../contracts/runtime-settings'
import { WORKSPACE_DEPENDENCIES_ENABLED_KEY, type WorkspaceDependenciesResponse } from '../../../../contracts/workspace-dependency-settings'
import { claimOverlay, registerOverlay } from '../../app/overlay-registry'
import { desktopSiteUrl } from '../../app/distribution'
import { showToast } from '../../app/ui-shared'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { PrefToggleRow, SettingsPage } from './kv'
import { useSettingsSnapshot } from './settings-snapshot'
import { dependenciesDiagnoseFeedback } from './workspace-dependency-state'
import { settingsErrorText } from './settings-error-text'
import styles from './runtime-tab.module.css'

interface Choice {
  value: string
  label: string
  description?: string
  group?: string
}

interface RuntimeRow {
  key: RuntimeSettingKey
  name: string
  values: string[]
}

export const RUNTIME_ROWS: RuntimeRow[] = [
  { key: 'klaus.approvalPolicy', name: 'approval', values: ['on-request', 'never'] },
  { key: 'klaus.sandboxMode', name: 'sandbox', values: ['read-only', 'workspace-write', 'danger-full-access'] },
  { key: 'klaus.modelVerbosity', name: 'verbosity', values: ['', 'low', 'medium', 'high'] },
  { key: 'klaus.reasoningSummary', name: 'summary', values: ['auto', 'concise', 'detailed', 'none'] },
]

const w = () => window as any
let rememberedScope: RuntimeConfigScope = { kind: 'user' }
const scopeKey = (scope: RuntimeConfigScope) => scope.kind === 'user' ? 'user' : scope.cwd

export function runtimeSettingValue(snapshot: RuntimeConfigSnapshot | null, key: RuntimeSettingKey): string {
  const effective = snapshot?.effective
  if (key === 'klaus.approvalPolicy') {
    const recognized = (value: unknown) => typeof value === 'string' && ['on-request', 'never', 'untrusted', 'on-failure'].includes(value) ? value : null
    return recognized(snapshot?.values[key]) ?? recognized(effective?.[key]) ?? 'on-request'
  }
  return effective?.[key] ?? (key === 'klaus.reasoningSummary' ? 'auto' : '')
}

export function RuntimeChoice({ id, label, descriptionId, options, value, valueLabel, disabled, onChange, scope = false }: {
  id: string
  label: string
  descriptionId?: string
  options: Choice[]
  value: string
  valueLabel?: string
  disabled?: boolean
  onChange: (value: string) => void
  scope?: boolean
}) {
  const overlayId = useId()
  const listId = `${overlayId}-list`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const keyboardRef = useRef<'selected' | 'last' | null>(null)
  const searchRef = useRef({ text: '', at: 0 })
  const selected = options.find(option => option.value === value)
  const close = (focus = false) => {
    setOpen(false)
    if (focus) triggerRef.current?.focus()
  }

  useEffect(() => registerOverlay(overlayId, () => setOpen(false)), [overlayId])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const node = event.target as Node
      if (!triggerRef.current?.contains(node) && !panelRef.current?.contains(node)) close()
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return
      close()
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return
    const place = () => {
      const rect = triggerRef.current!.getBoundingClientRect()
      const panel = panelRef.current!
      panel.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`
      panel.style.left = `${Math.max(8, Math.min(scope ? rect.left : rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8))}px`
      const below = rect.bottom + 4
      panel.style.top = `${below + panel.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, rect.top - panel.offsetHeight - 4)}px`
    }
    place()
    if (keyboardRef.current) {
      const items = panelRef.current.querySelectorAll<HTMLButtonElement>('[role="option"]')
      const selectedItem = panelRef.current.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ;(keyboardRef.current === 'last' ? items[items.length - 1] : selectedItem ?? items[0])?.focus()
      keyboardRef.current = null
    }
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, scope, options])

  const openMenu = (keyboard: 'selected' | 'last' | null = null) => {
    if (disabled) return
    keyboardRef.current = keyboard
    claimOverlay(overlayId)
    setOpen(true)
  }
  const keyDown = (event: React.KeyboardEvent) => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="option"]')
    if (option && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      option.click()
      return
    }
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); close(true) }
      return
    }
    if (event.key === 'Tab') { close(true); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (!open) { openMenu(event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'selected'); return }
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
      if (!items.length) return
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
      items[next]?.focus()
    } else if (open && event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      const at = Date.now()
      const text = `${at - searchRef.current.at < 700 ? searchRef.current.text : ''}${event.key}`.slice(-100).toLocaleLowerCase()
      searchRef.current = { text, at }
      const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(text))
      panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus()
    }
  }

  return <>
    <button type="button" ref={triggerRef} id={id} value={value} className={styles['choice-trigger']} role="combobox"
      aria-label={label} aria-describedby={descriptionId} aria-haspopup="listbox" aria-controls={open ? listId : undefined}
      aria-expanded={open} disabled={disabled} onKeyDown={keyDown}
      onClick={() => { if (open) close(); else openMenu() }}>
      <span>{selected?.label ?? valueLabel ?? value}</span><Icon name="chevron-down" size={12} />
    </button>
    {open && createPortal(<div ref={panelRef} id={listId} className={styles['choice-panel']} role="listbox" aria-label={label}
      onKeyDown={keyDown}>
      {options.map((option, index) => <div key={option.value} role="presentation">
        {option.group && option.group !== options[index - 1]?.group && <div className={styles['choice-group']}>{option.group}</div>}
        <button type="button" className={styles['choice-option']} role="option" aria-selected={option.value === value}
          data-value={option.value} onClick={() => { close(true); onChange(option.value) }}>
          <span className={styles['choice-copy']}><span>{option.label}</span>
            {option.description && <span className={styles['choice-description']}>{option.description}</span>}</span>
          {option.value === value && <Icon name="check" size={14} />}
        </button>
      </div>)}
    </div>, document.body)}
  </>
}

export function RuntimeSettingsTab({ embedded = false }: { embedded?: boolean }) {
  const t = useT()
  const [scope, setScope] = useState<RuntimeConfigScope>(rememberedScope)
  const [snapshot, setSnapshot, beginSnapshotRead] = useSettingsSnapshot<RuntimeConfigSnapshot | null>(`runtime:snapshot:${JSON.stringify(scope)}`, null)
  const [projects, , beginProjectsRead] = useSettingsSnapshot<{ path: string; label: string }[]>('runtime:projects', [])
  const [error, setError] = useState('')
  const [readFailed, setReadFailed] = useState(false)
  const [projectError, setProjectError] = useState('')
  const [saving, setSaving] = useState(false)
  const [opening, setOpening] = useState(false)
  const sequenceRef = useRef(0)
  const projectsSequenceRef = useRef(0)
  const savingRef = useRef(false)
  const [reload, setReload] = useState(0)
  const [deps, setDeps] = useState<WorkspaceDependenciesResponse | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  const [reinstalling, setReinstalling] = useState(false)
  const [depsError, setDepsError] = useState('')
  const diagnosingRef = useRef(false)

  const loadProjects = useCallback(async () => {
    const sequence = ++projectsSequenceRef.current
    const publish = beginProjectsRead()
    try {
      const [state, workspaces] = await Promise.all([w().klaus.projects.list(), w().klaus.workspaces?.list?.()])
      if (sequence !== projectsSequenceRef.current) return
      const roots: unknown[] = Array.isArray(state?.roots) ? [...state.roots] : []
      for (const workspace of Array.isArray(workspaces?.workspaces) ? workspaces.workspaces : []) {
        if (Array.isArray(workspace.roots)) roots.push(...workspace.roots)
      }
      const labels = state?.labels ?? {}
      const seen = new Set<string>()
      const rows = roots.flatMap((root: any) => {
        const path = typeof root === 'string' ? root : root?.path
        if (typeof path !== 'string' || !path || seen.has(path)) return []
        seen.add(path)
        return [{ path, label: labels[path] || path.split(/[/\\]/).filter(Boolean).at(-1) || path }]
      })
      if (!publish(rows)) return
      setProjectError('')
    } catch (reason) {
      if (sequence === projectsSequenceRef.current && publish(current => current)) setProjectError(settingsErrorText('runtime-projects', reason, 'settings_section_load_failed'))
    }
  }, [beginProjectsRead])

  useEffect(() => {
    void loadProjects()
    return () => { projectsSequenceRef.current++ }
  }, [loadProjects])
  const loadDeps = useCallback(async () => {
    try {
      const next = await w().settingsApi.workspaceDependencies.get()
      setDeps(next)
      setReinstalling(next.state === 'installing')
    } catch (reason) {
      setDepsError(settingsErrorText('runtime-deps', reason, 'runtime_write_error'))
    }
  }, [])
  useEffect(() => {
    void loadDeps()
  }, [loadDeps])
  useEffect(() => w().klaus.on.appPreferencesChanged?.(({ key }: { key?: string }) => {
    if (key === WORKSPACE_DEPENDENCIES_ENABLED_KEY) void loadDeps()
  }), [loadDeps])
  useEffect(() => {
    const sequence = ++sequenceRef.current
    const publish = beginSnapshotRead()
    setError('')
    setReadFailed(false)
    void w().settingsApi.runtimeConfig.get(scope).then((next: RuntimeConfigSnapshot) => {
      if (sequence === sequenceRef.current) publish(next)
    }).catch((reason: unknown) => {
      if (sequence === sequenceRef.current && publish(current => current)) {
        setReadFailed(true)
        setError(settingsErrorText('runtime-load', reason, 'settings_section_load_failed'))
      }
    })
    return () => { sequenceRef.current++ }
  }, [scope, reload, beginSnapshotRead])
  useEffect(() => w().klaus.on.appPreferencesChanged?.(({ key }: { key?: string }) => {
    if (!savingRef.current && key && (key.startsWith('klaus.') || key === 'composer.permission_mode')) setReload(value => value + 1)
  }), [])

  const save = async (key: RuntimeSettingKey, value: string) => {
    if (!snapshot || savingRef.current || readFailed) return
    savingRef.current = true
    setSnapshot(current => current)
    setSaving(true)
    setError('')
    const sequence = sequenceRef.current
    try {
      const result = await w().settingsApi.kv.set(key, value, scope, snapshot.version)
      if (result?.ok === false || result?.error) throw new Error(result.error || t('runtime_write_error'))
      const next = await w().settingsApi.runtimeConfig.get(scope)
      if (sequence === sequenceRef.current) setSnapshot(next)
    } catch (reason) {
      if (sequence === sequenceRef.current) {
        setError(settingsErrorText('runtime-save', reason, 'runtime_write_error'))
        // A durable write can succeed before live publication fails. Display
        // the authoritative file state without repeating the mutation.
        try {
          const actual = await w().settingsApi.runtimeConfig.get(scope)
          if (sequence === sequenceRef.current) setSnapshot(actual)
        } catch { /* The write error remains visible beside the last known state. */ }
      }
    } finally {
      savingRef.current = false
      if (sequence === sequenceRef.current) setSaving(false)
    }
  }

  const openConfig = async () => {
    setOpening(true)
    try {
      const result = await w().settingsApi.runtimeConfig.open(scope)
      if (result?.ok === false || result?.error) throw new Error(result.error || t('settings_failed'))
    } catch (reason) { setError(settingsErrorText('runtime-open-config', reason, 'settings_failed')) }
    finally { setOpening(false) }
  }
  const openHelp = () => {
    void w().klaus.app.openExternal(desktopSiteUrl('/docs/desktop/plan-and-permission')).catch((reason: unknown) => {
      setError(settingsErrorText('runtime-open-help', reason, 'settings_failed'))
    })
  }
  const setDepEnabled = async (checked: boolean) => {
    setDepsError('')
    try {
      const result = await w().settingsApi.kv.set(WORKSPACE_DEPENDENCIES_ENABLED_KEY, checked ? 'on' : 'off')
      if (result?.ok === false || result?.error) throw new Error(result.error || t('runtime_write_error'))
      await loadDeps()
    } catch (reason) { setDepsError(settingsErrorText('runtime-deps', reason, 'runtime_write_error')) }
  }
  const diagnoseDeps = async () => {
    if (diagnosingRef.current) return
    diagnosingRef.current = true
    setDiagnosing(true); setDepsError('')
    try {
      const result = await w().settingsApi.workspaceDependencies.diagnose()
      setDeps(result)
      setReinstalling(result.state === 'installing')
      const feedback = dependenciesDiagnoseFeedback(result.state)
      showToast(t(feedback.key), { tone: feedback.tone, duration: 5000 })
    } catch {
      showToast(t('runtime_dependencies_diagnose_failed'), { tone: 'danger', duration: 5000 })
    } finally {
      diagnosingRef.current = false
      setDiagnosing(false)
      void loadDeps()
    }
  }
  const reinstallDeps = async () => {
    setReinstalling(true); setDepsError('')
    try {
      const result = await w().settingsApi.workspaceDependencies.reinstall()
      setDeps(result)
      setReinstalling(result.state === 'installing')
    } catch (reason) {
      setReinstalling(false)
      setDepsError(reason instanceof Error ? reason.message : t('runtime_write_error'))
    }
  }
  const scopeOptions: Choice[] = [{ value: 'user', label: 'Klaus', group: t('runtime_scope_global') }]
  for (const project of projects) scopeOptions.push({ value: project.path, label: project.label, description: project.path, group: t('runtime_scope_projects') })
  if (scope.kind === 'project' && !projects.some(project => project.path === scope.cwd)) {
    scopeOptions.push({ value: scope.cwd, label: scope.cwd.split(/[/\\]/).filter(Boolean).at(-1) || scope.cwd, description: scope.cwd, group: t('runtime_scope_projects') })
  }
  const effective = snapshot?.effective
  const sandbox = effective?.['klaus.sandboxMode'] ?? 'read-only'

  const content = <div className={styles['runtime-content']}>
      {embedded && <div className="settings-section-title">{t('runtime_settings')}</div>}
      <div className={styles['config-toolbar']}>
        <RuntimeChoice id="runtime-scope" label={t('runtime_scope')} scope options={scopeOptions} value={scopeKey(scope)} disabled={saving}
          onChange={value => {
            rememberedScope = value === 'user' ? { kind: 'user' } : { kind: 'project', cwd: value }
            setScope(rememberedScope)
          }} />
        <button type="button" className={styles['open-config']} disabled={opening || !snapshot} onClick={() => { void openConfig() }}>
          {t('runtime_open_config')}<Icon name="arrow-up-right" size={13} />
        </button>
      </div>
      {projectError && <div className={styles['runtime-error']} role="alert">{projectError}{' '}
        <button type="button" className={styles['text-link']} onClick={() => { void loadProjects() }}>{t('auth_status_retry')}</button></div>}
      {snapshot?.migrationWarnings?.length ? <div className={styles['runtime-notice']} role="status" data-config-migration-notice>
        {t('runtime_migration_notice')}
      </div> : null}
      {error && <div className={styles['runtime-error']} role="alert">{error}{' '}
        <button type="button" className={styles['text-link']} disabled={saving} onClick={() => setReload(value => value + 1)}>{t('auth_status_retry')}</button></div>}
      {!snapshot ? !error && <div className={styles['runtime-loading']} role="status">{t('runtime_loading')}</div> : <div className={styles['runtime-card']} aria-busy={saving}>
        {RUNTIME_ROWS.map(row => {
          const value = runtimeSettingValue(snapshot, row.key)
          const valueKey = `runtime_${row.name}_${value || 'default'}`
          const valueLabel = t(valueKey) === valueKey ? value : t(valueKey)
          const options: Choice[] = row.values.map(option => ({ value: option,
            label: t(`runtime_${row.name}_${option || 'default'}`),
            description: option && row.values.includes(option) ? t(`runtime_${row.name}_${option}_desc`) : undefined,
          }))
          return <div key={row.key}>
            <div className={styles['runtime-row']} data-setting={row.key}>
              <div className={styles['runtime-row-copy']}>
                <div className={styles['runtime-label']} id={`runtime-${row.name}-label`}>{t(`runtime_${row.name}`)}</div>
                <div className={styles['runtime-description']} id={`runtime-${row.name}-desc`}>{t(`runtime_${row.name}_desc`)}</div>
              </div>
              <RuntimeChoice id={`runtime-${row.name}`} label={t(`runtime_${row.name}`)} descriptionId={`runtime-${row.name}-desc`}
                options={options} value={value} valueLabel={valueLabel} disabled={saving || readFailed} onChange={next => { void save(row.key, next) }} />
            </div>
            {row.name === 'sandbox' && sandbox === 'workspace-write' && <div className={styles['network-row']}>
              <PrefToggleRow id="runtime-network" label={t('runtime_network')} desc={t('runtime_network_desc')}
                checked={effective?.['klaus.sandbox.networkAllowed'] === 'on'} disabled={saving || readFailed}
                onChange={checked => { void save('klaus.sandbox.networkAllowed', checked ? 'on' : 'off') }} />
            </div>}
          </div>
        })}
        <div className={styles['dep-toggle-row']} data-subagent-model-policy>
          <PrefToggleRow id="runtime-subagent-model-catalog" label={t('runtime_subagent_model_catalog')} desc={t('runtime_subagent_model_catalog_desc')}
            checked={effective?.['klaus.subagentModelCatalog'] === 'on'} disabled={saving || readFailed}
            onChange={checked => { void save('klaus.subagentModelCatalog', checked ? 'on' : 'off') }} />
        </div>
      </div>}
      {deps && <div className={styles['dependencies-section']}>
        <div className={styles['section-title']}>{t('runtime_dependencies_section')}</div>
        <div className={styles['runtime-card']} data-workspace-dependencies>
          <div className={styles['dep-toggle-row']}>
            <PrefToggleRow id="runtime-dependencies-toggle" label={t('runtime_dependencies_toggle')} desc={t('runtime_dependencies_toggle_desc')}
              checked={deps.enabled} disabled={diagnosing || reinstalling} onChange={checked => { void setDepEnabled(checked) }} />
          </div>
          <div className={styles['runtime-row']} data-dependency="diagnose">
            <div className={styles['runtime-row-copy']}>
              <div className={styles['runtime-label']}>{t('runtime_dependencies_diagnose')}</div>
              <div className={styles['runtime-description']}>{t('runtime_dependencies_diagnose_desc')}</div>
            </div>
            <button type="button" className={styles['dep-button']} disabled={!deps.enabled || diagnosing || reinstalling}
              aria-busy={diagnosing}
              onClick={() => { void diagnoseDeps() }}>
              <Icon name="search" size={13} />{diagnosing ? t('runtime_dependencies_diagnosing') : t('runtime_dependencies_diagnose_btn')}
            </button>
          </div>
          <div className={styles['runtime-row']} data-dependency="reinstall">
            <div className={styles['runtime-row-copy']}>
              <div className={styles['runtime-label']}>{t('runtime_dependencies_reinstall_row')}</div>
              <div className={styles['runtime-description']}>{t('runtime_dependencies_reinstall_desc')}</div>
            </div>
            <button type="button" className={styles['dep-button-danger']} disabled={!deps.enabled || diagnosing || reinstalling}
              onClick={() => { void reinstallDeps() }}>
              {reinstalling ? t('runtime_dependencies_installing') : t('runtime_dependencies_reinstall_btn')}
            </button>
          </div>
        </div>
        {depsError && <div className={styles['runtime-error']} role="alert">{depsError}</div>}
      </div>}
    </div>
  if (embedded) return content
  return <SettingsPage title={t('runtime_settings')} subtitle={<>{t('runtime_settings_desc')}{' '}
    <button type="button" className={styles['text-link']} onClick={openHelp}>{t('perm_learn_more')}</button></>}>{content}</SettingsPage>
}
