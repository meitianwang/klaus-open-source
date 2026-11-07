import { useCallback, useEffect, useRef, useState } from 'react'
import { ModalPortal } from '../../components/ModalPortal'
import { icon } from '../../icons/registry'
import { useT } from '../../i18n'
import { SettingsPage } from './kv'
import { useSettingsSnapshot } from './settings-snapshot'
import { HOOK_EVENTS, groupHookEntries, hookEntries, needsHookReview, parseHooksEditorValue, type HookEntry, type HooksReply } from './hooks-model'
import shared from './settings.module.css'
import styles from './hooks-settings.module.css'
import { logHostDiagnostic, settingsErrorText } from './settings-error-text'

const w = () => window as any
interface HookSource {
  id: string
  kind: 'global' | 'project' | 'plugin'
  name: string
  projectRoot?: string
  events?: Array<{ event: string; count: number }>
  enabled?: boolean
  reply?: HooksReply
  error?: string
}
const scopeOf = (source: HookSource) => source.projectRoot ? { projectRoot: source.projectRoot } : undefined
const entriesOf = (source: HookSource) => source.kind === 'plugin' ? [] : hookEntries(source.reply ?? {}, source.kind)
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
const countText = (t: (key: string) => string, key: string, count: number) => t(count === 1 ? `${key}_one` : key).replace('{count}', String(count))

function Glyph({ name, size = 18 }: { name: string; size?: number }) {
  return <span className={styles.glyph} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(name, { size }) }} />
}

export function HooksSettingsTab() {
  const t = useT()
  const [sourceSnapshot, setSources, beginSourcesRead] = useSettingsSnapshot<HookSource[] | null>('hooks:sources', null)
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({})
  const sources = (sourceSnapshot ?? []).map(source => ({ ...source, error: sourceErrors[source.id] }))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(sourceSnapshot === null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const mutation = useRef(false)

  const loadAll = useCallback(async () => {
    if (mutation.current) return
    const seq = ++revision.current
    const publish = beginSourcesRead()
    setLoading(true)
    setError('')
    const results = await Promise.allSettled([
      w().klaus.projects.list(),
      w().klaus.workspaces.list(),
      w().klaus.plugins.market(),
    ])
    if (seq !== revision.current) return
    const failures: unknown[] = []
    const read = (index: number) => {
      const result = results[index]!
      if (result.status === 'fulfilled') {
        if (result.value?.error) failures.push(result.value.error)
        return result.value
      }
      failures.push(result.reason)
      return undefined
    }
    const projects = read(0)
    const workspaces = read(1)
    const plugins = read(2)
    const names = new Map<string, string>()
    for (const root of Array.isArray(projects?.roots) ? projects.roots : []) {
      const path = typeof root === 'string' ? root : root?.path
      if (typeof path === 'string') names.set(path, projects?.labels?.[path] || folderName(path))
    }
    for (const workspace of Array.isArray(workspaces?.workspaces) ? workspaces.workspaces : []) {
      const roots = Array.isArray(workspace.roots) ? workspace.roots : []
      for (const root of roots) {
        if (typeof root === 'string' && !names.has(root)) names.set(root, roots.length === 1 && workspace.name ? workspace.name : folderName(root))
      }
    }
    const next: HookSource[] = [{ id: 'global', kind: 'global', name: '' }]
    for (const [projectRoot, name] of names) {
      if (!projectRoot || /^[a-z][a-z0-9+.-]*:\/\//i.test(projectRoot)) continue
      next.push({ id: `project:${projectRoot}`, kind: 'project', name, projectRoot })
    }
    let cursor = 0
    const worker = async () => {
      while (cursor < next.length) {
        const source = next[cursor++]!
        try {
          const reply: HooksReply = await w().settingsApi.klausHooks.get(scopeOf(source))
          if (reply?.ok === false) throw new Error(reply.error || t('settings_failed'))
          source.reply = reply
        } catch (error) { source.error = settingsErrorText('hooks-source', error, 'hooks_source_load_failed') }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, next.length) }, worker))
    if (seq !== revision.current) return
    for (const plugin of Array.isArray(plugins) ? plugins : Array.isArray(plugins?.plugins) ? plugins.plugins : []) {
      const events = Array.isArray(plugin.contributions?.hooks) ? plugin.contributions.hooks.filter((event: unknown): event is string => typeof event === 'string') : []
      if (plugin.installed && events.length) next.push({ id: `plugin:${plugin.id}`, kind: 'plugin', name: plugin.name || plugin.id, events: events.map((value: string) => { const match = /^(.*?)(?: \((\d+)\))?$/.exec(value)!; return { event: match[1]!, count: match[2] ? Number(match[2]) : 1 } }), enabled: plugin.enabled === true })
    }
    if (!publish(current => next.map(({ error, ...source }) => error
      ? { ...source, reply: current?.find(previous => previous.id === source.id)?.reply }
      : source))) {
      if (seq === revision.current) setLoading(false)
      return
    }
    setSourceErrors(Object.fromEntries(next.filter(source => source.error).map(source => [source.id, source.error!])))
    if (failures.length) {
      for (const failure of failures) logHostDiagnostic('hooks', failure)
      setError(t('hooks_source_load_failed'))
    } else setError('')
    setLoading(false)
  }, [t, beginSourcesRead])

  useEffect(() => {
    void loadAll()
    return () => { revision.current += 1 }
  }, [loadAll])

  const updateSource = async (source: HookSource, operation: () => Promise<any>) => {
    if (mutation.current) throw new Error(t('hooks_update_pending'))
    mutation.current = true
    setSources(current => current)
    setBusy(true)
    const seq = revision.current
    try {
      const result = await operation()
      if (result?.ok === false || result?.error) throw new Error(result.error || t('settings_failed'))
      const reply: HooksReply = await w().settingsApi.klausHooks.get(scopeOf(source))
      if (reply?.ok === false) throw new Error(reply.error || t('settings_failed'))
      if (seq === revision.current) {
        setSources(current => current?.map(item => item.id === source.id ? { ...item, reply } : item) ?? null)
        setSourceErrors(current => { const next = { ...current }; delete next[source.id]; return next })
      }
      return reply
    } finally {
      mutation.current = false
      if (seq === revision.current) setBusy(false)
    }
  }
  const selected = sources.find(source => source.id === selectedId)
  const sourceTitle = (source: HookSource) => source.kind === 'global' ? t('hooks_user_config') : source.name
  const section = (kind: HookSource['kind'], title: string) => {
    const rows = sources.filter(source => source.kind === kind)
    if (!rows.length) return null
    return <div className="settings-section">
      <div className="settings-section-title">{title}</div>
      <div className={styles['source-list']}>
        {rows.map(source => {
          const entries = entriesOf(source)
          const pending = entries.filter(needsHookReview).length
          return <button type="button" key={source.id} className={styles['source-row']} data-hook-source={source.id} disabled={loading || busy} onClick={() => setSelectedId(source.id)}>
            <Glyph name={kind === 'global' ? 'external-import-external-import-settings' : kind === 'project' ? 'folder' : 'settings-nav-hooks'} size={21} />
            <span className={styles['source-copy']}>
              <span className={styles['source-name']}>{sourceTitle(source)}</span>
              <span className={styles['source-summary']}>
                {source.error ? t('hooks_source_load_failed') : kind === 'plugin'
                  ? countText(t, 'hooks_event_count', source.events?.length ?? 0)
                  : countText(t, 'hooks_hook_count', entries.length)}
                {pending > 0 && <span className={styles.warning}> · {countText(t, 'hooks_review_count', pending)}</span>}
                {kind === 'plugin' && !source.enabled && <> · {t('hooks_status_disabled')}</>}
              </span>
            </span>
            <Glyph name="chevron-right" size={17} />
          </button>
        })}
      </div>
    </div>
  }
  return <SettingsPage title={t('hooks_settings')} subtitle={t('hooks_settings_desc')} actions={
    <button type="button" className={styles['icon-button']} data-hooks-refresh aria-busy={loading} aria-label={t('hooks_refresh')} disabled={loading || busy} onClick={() => { void loadAll() }}><Glyph name="refresh" size={20} /></button>
  }>
    {loading && !sources.length ? <p className={styles.notice} role="status">{t('loading')}</p> : <>
      {error && <div className={styles.error} role="alert">{error}<button type="button" className="btn-sm" disabled={loading || busy} onClick={() => { void loadAll() }}>{t('auth_status_retry')}</button></div>}
      {section('global', t('hooks_from_config'))}
      {section('plugin', t('hooks_from_plugins'))}
      {section('project', t('hooks_from_projects'))}
    </>}
    {selected && <HookSourceDialog key={selected.id} source={selected} title={sourceTitle(selected)} busy={busy} update={operation => updateSource(selected, operation)} onClose={() => setSelectedId(null)} />}
  </SettingsPage>
}

function HookSourceDialog({ source, title, busy, update, onClose }: {
  source: HookSource; title: string; busy: boolean
  update: (operation: () => Promise<any>) => Promise<HooksReply>
  onClose: () => void
}) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<() => void>(() => {})
  const [expanded, setExpanded] = useState<Record<string, string | null>>({})
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => JSON.stringify(source.reply?.hooks ?? {}, null, 2))
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [closing, setClosing] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const busyRef = useRef(false)
  busyRef.current = busy || closing
  const entries = entriesOf(source)
  const pending = entries.filter(needsHookReview)
  const locked = busy || closing || !!source.error || !!source.reply?.disabledByPolicy || !!source.reply?.managedOnly
  const requestClose = () => {
    if (busyRef.current) return
    if (dirty) { setClosing(true); return }
    onClose()
  }
  closeRef.current = () => { void requestClose() }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    return () => {
      element.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    if (editing) editor.current?.focus()
  }, [editing])
  const act = async (operation: () => Promise<any>, success?: string) => {
    if (locked || busyRef.current) return
    busyRef.current = true
    setMessage(null)
    try {
      const reply = await update(operation)
      if (success) setMessage({ text: success, error: false })
      return reply
    } catch (error) { setMessage({ text: settingsErrorText('hooks-apply', error, 'hooks_apply_failed'), error: true }); return undefined }
    finally { busyRef.current = false }
  }
  const reveal = (path: string) => {
    if (!path) return
    void w().artifacts.reveal(path).then((result: any) => {
      if (result?.error || result?.ok === false) throw new Error(result.error || t('settings_failed'))
    }).catch((error: unknown) => setMessage({ text: settingsErrorText('hooks-reveal', error, 'settings_failed'), error: true }))
  }
  const save = async () => {
    let hooks: Record<string, unknown>
    try { hooks = parseHooksEditorValue(draft) }
    catch (error) {
      logHostDiagnostic('hooks-editor', error)
      setMessage({ text: error instanceof Error && error.message === 'hooks_invalid_object' ? t('hooks_invalid_object') : t('hooks_invalid_json'), error: true })
      return
    }
    const reply = await act(() => w().settingsApi.klausHooks.set(hooks, scopeOf(source)), t('hooks_saved'))
    if (reply) { setDraft(JSON.stringify(reply.hooks ?? hooks, null, 2)); setDirty(false) }
  }
  const description = source.kind === 'project' ? source.projectRoot : t('hooks_all_projects')
  return <ModalPortal><dialog ref={dialog} className={styles.dialog} data-hooks-dialog role="dialog" aria-modal="true" aria-labelledby="hooks-source-title" aria-describedby="hooks-source-description" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current() }
  }} onCancel={event => { event.preventDefault(); closeRef.current() }} onClick={event => {
    if (event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeRef.current()
  }}>
    <div className={styles['dialog-header']}>
      <div className={styles['dialog-heading']}><Glyph name={source.kind === 'global' ? 'external-import-external-import-settings' : source.kind === 'project' ? 'folder' : 'settings-nav-hooks'} size={21} /><h2 id="hooks-source-title">{title}</h2></div>
      <button type="button" className="kls-modal-close" data-hooks-close aria-label={t('close')} disabled={busy || closing} onClick={() => closeRef.current()} autoFocus><Glyph name="close" /></button>
      <p id="hooks-source-description">{description}</p>
    </div>
    <div className={styles['dialog-body']} aria-busy={busy}>
      {source.error && <div className={styles.error} role="alert">{source.error}</div>}
      {source.reply?.disabledByPolicy && <p className={styles.error}>{t('hooks_policy_disabled')}</p>}
      {source.reply?.managedOnly && <p className={styles.notice}>{t('hooks_policy_managed_only')}</p>}
      {message && <p className={message.error ? styles.error : styles.notice} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      {pending.length > 0 && <div className={styles['review-notice']}>
        <p>{t('hooks_review_hint')}</p>
        <button type="button" className="btn-sm" id="hooks-trust-all" disabled={locked || dirty} onClick={() => { void act(() => w().settingsApi.klausHooks.trust(pending.map(entry => entry.state!.key), scopeOf(source)), t('hooks_trusted')) }}>{t('hooks_trust_all')}</button>
      </div>}
      {source.kind === 'plugin' ? <>
        <p className={styles.notice}>{t('hooks_plugin_details_notice')}</p>
        <div className={styles['event-list']}>{source.events?.map(({ event, count }) => <div className={styles['event-heading']} key={event}><Glyph name="settings-nav-hooks" /><div><div>{event} · {countText(t, 'hooks_hook_count', count)}</div><p>{t((HOOK_EVENTS as readonly string[]).includes(event) ? `hooks_event_${event}` : 'hooks_event_other')}</p></div></div>)}</div>
        <button type="button" className="btn-sm" onClick={() => { onClose(); w().closeSettings?.(); w().klausKeybindingActions?.openPlugins?.() }}>{t('hooks_manage_plugins')}</button>
      </> : <>
        {!entries.length && !source.error && <div className={styles.empty}><p>{t('hooks_empty_title')}</p><span>{t('hooks_empty_desc')}</span></div>}
        {entries.length > 0 && <div className={styles['event-list']}>
          {groupHookEntries(entries).map(group => <section className={styles['event-group']} key={group.event} data-hook-event={group.event}>
            <div className={styles['event-heading']}><Glyph name="settings-nav-hooks" /><div><h3>{group.event}</h3><p>{t((HOOK_EVENTS as readonly string[]).includes(group.event) ? `hooks_event_${group.event}` : 'hooks_event_other')}</p></div></div>
            <div className={styles['event-rows']}>{group.entries.map((entry, index) => {
              const label = t('hooks_numbered').replace('{number}', String(index + 1))
              const open = expanded[group.event] === entry.id
              const review = needsHookReview(entry)
              return <div className={styles['hook-row']} data-hook-row={entry.id} key={entry.id}>
                <div className={styles['hook-controls']}>
                  <div className={styles['hook-main']}>
                    <button type="button" className={styles['hook-expand']} data-hook-expand={entry.id} aria-label={`${group.event}: ${label}`} aria-expanded={open} aria-controls={`hook-detail-${group.event}-${index}`} onClick={() => setExpanded(current => ({ ...current, [group.event]: open ? null : entry.id }))}>
                      <span>{label}{review && <span className={styles['review-badge']}>{t(entry.state?.status === 'changed' ? 'hooks_status_changed' : 'hooks_status_new')}</span>}</span>
                      <Glyph name="chevron-down" size={16} />
                    </button>
                    <button type="button" className={`${styles['icon-button']} ${styles['reveal-button']}`} data-hook-reveal={entry.id} aria-label={`${t('hooks_reveal_config')}: ${label}`} onClick={() => reveal(entry.filePath)} disabled={!entry.filePath}><Glyph name="kls-icon-btn-3" size={15} /></button>
                  </div>
                  {review && <button type="button" className="btn-sm" data-hook-trust={entry.state!.key} disabled={locked || dirty} onClick={() => { void act(() => w().settingsApi.klausHooks.trust([entry.state!.key], scopeOf(source)), t('hooks_trusted')) }}>{t('hooks_trust')}</button>}
                  <label className={`${shared['pref-switch']} ${styles['hook-switch']}`}>
                    <input type="checkbox" role="switch" checked={entry.state?.status === 'trusted'} data-hook-enabled={entry.state?.key} aria-label={`${t('hooks_enabled')}: ${group.event}, ${label}`} aria-describedby={review ? 'hooks-review-description' : !entry.state ? 'hooks-readonly-description' : undefined} disabled={locked || dirty || review || !entry.state} onChange={event => { const enabled = event.currentTarget.checked; void act(() => w().settingsApi.klausHooks.setEnabled(entry.state!.key, enabled, scopeOf(source))) }} />
                    <span className={shared['pref-switch-track']} />
                  </label>
                </div>
                {open && <HookDetails entry={entry} id={`hook-detail-${group.event}-${index}`} />}
              </div>
            })}</div>
          </section>)}
        </div>}
        <span id="hooks-review-description" className={styles['sr-only']}>{t('hooks_review_hint')}</span>
        {entries.some(entry => !entry.state) && <p className={styles.notice} id="hooks-readonly-description">{t('hooks_readonly_hint')}</p>}
        <div className={styles['config-actions']}>
          <button type="button" className="btn-sm" data-hooks-editor-toggle aria-expanded={editing} aria-controls="hooks-config-editor" disabled={busy || closing || !source.reply} onClick={() => setEditing(value => !value)}>{t(editing ? 'hooks_hide_editor' : 'hooks_edit_config')}</button>
          <button type="button" className="btn-sm" disabled={!source.reply?.path} onClick={() => reveal(source.reply!.path!)}>{t('hooks_reveal_config')}</button>
        </div>
        {editing && <section id="hooks-config-editor" className={styles.editor}>
          <h3 id="hooks-editor-label">{t('hooks_editor_label')}</h3>
          <p id="hooks-editor-hint">{t('hooks_editor_hint')}</p>
          <p id="hooks-editor-lifecycle-hint">{t('hooks_editor_lifecycle_hint')}</p>
          <textarea id="hooks-json-editor" ref={editor} className={shared['hooks-json-editor']} spellCheck={false} value={draft} aria-labelledby="hooks-editor-label" aria-describedby="hooks-editor-hint hooks-editor-lifecycle-hint" disabled={locked} onChange={event => { setDraft(event.currentTarget.value); setDirty(true); setMessage(null) }} />
          <div className={styles['config-actions']}>
            <button type="button" className="btn-sm btn-primary" id="hooks-save-btn" disabled={locked || !dirty} onClick={() => { void save() }}>{t('hooks_save')}</button>
            <button type="button" className="btn-sm" disabled={locked} onClick={() => {
              try { setDraft(JSON.stringify(parseHooksEditorValue(draft), null, 2)); setMessage(null) }
              catch (error) { logHostDiagnostic('hooks-editor', error); setMessage({ text: t('hooks_invalid_json'), error: true }) }
            }}>{t('hooks_format')}</button>
            {dirty && <span className={styles.notice}>{t('hooks_unsaved_changes')}</span>}
          </div>
          <p className={styles['config-path']}>{source.reply?.path}</p>
        </section>}
      </>}
    </div>
  </dialog>
    {closing && <DiscardHookChangesDialog onKeep={() => setClosing(false)} onDiscard={onClose} />}
  </ModalPortal>
}

function HookDetails({ entry, id }: { entry: HookEntry; id: string }) {
  const t = useT()
  const details = [
    [t('hooks_detail_type'), entry.type],
    [t(entry.type === 'command' ? 'hooks_detail_command' : entry.type === 'http' ? 'hooks_detail_url' : 'hooks_detail_prompt'), entry.content],
    ...(entry.matcher !== undefined ? [[t('hooks_row_matcher'), entry.matcher]] : []),
    ...(entry.timeoutMs !== undefined ? [[t('hooks_row_timeout'), `${entry.timeoutMs / 1000}s`]] : []),
    ...(entry.isAsync ? [[t('hooks_row_async'), t('settings_on')]] : []),
    [t('hooks_config_path'), entry.filePath],
  ]
  return <dl className={styles.details} id={id}>{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

function DiscardHookChangesDialog({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={dialog} className={`${styles.dialog} ${styles['discard-dialog']}`} data-hooks-discard-dialog role="alertdialog" aria-modal="true" aria-labelledby="hooks-discard-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onKeep() }
  }} onCancel={event => { event.preventDefault(); onKeep() }}>
    <p id="hooks-discard-title">{t('hooks_unsaved_close_confirm')}</p>
    <div className={styles['config-actions']}>
      <button type="button" className="btn-sm" data-hooks-keep-editing onClick={onKeep} autoFocus>{t('hooks_keep_editing')}</button>
      <button type="button" className="btn-sm btn-danger" data-hooks-discard onClick={onDiscard}>{t('hooks_discard_changes')}</button>
    </div>
  </dialog>
}
