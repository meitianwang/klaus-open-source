import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../components/Icon'
import { SettingsPage } from './kv'
import { StorageButton, StorageDialog } from './storage-dialog'
import { worktreeConversations, worktreePinned, worktreeSource, type WorktreeConversation } from './worktree-storage-model'
import type { ManagedWorktreeRecord, WorktreeStorageSettings, WorktreeStorageSettingsPatch } from '../../../../contracts/worktree-storage'
import styles from './storage.module.css'

const w = () => window as any

/** Managed working copies and their storage policy share one settings page. */
export function WorktreesManager() {
  const t = useT()
  const [records, setRecords] = useState<ManagedWorktreeRecord[] | null>(null), [conversations, setConversations] = useState<WorktreeConversation[]>([])
  const [settings, setSettings] = useState<WorktreeStorageSettings | null>(null), [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false), [saving, setSaving] = useState<Set<string>>(() => new Set())
  const [rootDraft, setRootDraft] = useState<string | null>(null), [keepDraft, setKeepDraft] = useState<string | null>(null)
  const [confirmDisable, setConfirmDisable] = useState(false), [pending, setPending] = useState<Set<string>>(() => new Set())
  const alive = useRef(true), revision = useRef(0), saveLock = useRef(new Set<string>()), rowLock = useRef(new Set<string>())
  const load = useCallback(async () => {
    const current = ++revision.current
    setRefreshing(true)
    try {
      const [listed, rows] = await Promise.all([w().klaus.worktree.list(), w().klaus.session.list()])
      if (listed?.ok === false || listed?.error || !Array.isArray(listed.worktrees)) throw Error(listed?.error || t('worktrees_error_body'))
      if (!alive.current || current !== revision.current) return
      setRecords(listed.worktrees); setConversations(rows); if (!saveLock.current.size) setSettings(listed.settings); setError(null)
    } catch (reason: any) { if (alive.current && current === revision.current) setError(reason?.message || t('worktrees_error_body')) }
    finally { if (alive.current && current === revision.current) setRefreshing(false) }
  }, [t])
  useEffect(() => {
    alive.current = true; void load()
    const timer = setInterval(() => { if (!saveLock.current.size && !rowLock.current.size) void load() }, 60_000)
    return () => { alive.current = false; revision.current++; clearInterval(timer) }
  }, [load])
  const save = async (patch: WorktreeStorageSettingsPatch, key: string, success: string, failure: string) => {
    if (saveLock.current.has(key)) return false
    saveLock.current.add(key); setSaving(new Set(saveLock.current)); revision.current++; setRefreshing(false)
    try {
      const result = await w().klaus.worktree.configure(patch)
      if (result?.ok === false || result?.error) throw Error(result?.error)
      if (alive.current) setSettings(previous => previous ? { ...previous, ...Object.fromEntries(Object.keys(patch).map(field => [field, result.settings[field]])) } : result.settings)
      w().showToast(t(success)); return true
    } catch { w().showToast(t(failure)); return false }
    finally { saveLock.current.delete(key); if (alive.current) setSaving(new Set(saveLock.current)) }
  }
  const commitRoot = async () => {
    if (!settings || rootDraft == null || saving.has('root')) return
    const value = rootDraft.trim()
    if (value === settings.root) { setRootDraft(null); return }
    if (value && !/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(value)) return
    if (await save({ root: value }, 'root', 'worktrees_root_saved', 'worktrees_root_error')) setRootDraft(null)
  }
  const commitKeep = async () => {
    if (!settings || keepDraft == null || saving.has('keepCount') || saving.has('autoCleanup')) return
    if (!keepDraft.trim() || !Number.isFinite(Number(keepDraft))) { setKeepDraft(null); return }
    const value = Math.max(1, Math.trunc(Number(keepDraft)))
    if (value === settings.keepCount) { setKeepDraft(null); return }
    if (await save({ keepCount: value }, 'keepCount', 'worktrees_keep_count_save', 'worktrees_keep_count_error')) setKeepDraft(null)
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && rootDraft != null && !saving.has('root')) { event.preventDefault(); void commitRoot() }
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [rootDraft, settings, saving])
  const openChat = async (record: ManagedWorktreeRecord, rows: WorktreeConversation[]) => {
    if (rowLock.current.has(record.path)) return
    rowLock.current.add(record.path); setPending(new Set(rowLock.current))
    try {
      const source = worktreeSource(rows)
      const info = await w().klaus.session.new({ workdir: record.path,
        ...(source?.projectRoot || record.repoRoot ? { projectRoot: source?.projectRoot || record.repoRoot } : {}) })
      if (!info?.id) throw Error(info?.error || t('settings_failed'))
      await w().updateSessionInList?.(); w().closeSettings?.(); await w().switchSession(info.id)
    } catch (reason: any) { w().showToast(reason?.message || t('settings_failed')) }
    finally { rowLock.current.delete(record.path); if (alive.current) setPending(new Set(rowLock.current)) }
  }
  const remove = async (record: ManagedWorktreeRecord) => {
    if (rowLock.current.has(record.path)) return
    rowLock.current.add(record.path); setPending(new Set(rowLock.current))
    try {
      const rows = await w().klaus.session.list()
      if (worktreeConversations(record.path, rows).some(worktreePinned)) { w().showToast(t('worktrees_delete_pinned')); return }
      const result = await w().klaus.worktree.deleteManaged(record.path)
      if (result?.ok === false || result?.error) throw Error(result?.error)
      w().showToast(t('worktrees_delete_success')); await w().updateSessionInList?.()
    } catch (reason: any) { w().showToast(t(String(reason?.message || reason).includes('worktree-pinned') ? 'worktrees_delete_pinned' : 'worktrees_delete_error')) }
    finally { rowLock.current.delete(record.path); if (alive.current) { setPending(new Set(rowLock.current)); void load() } }
  }
  const groups = useMemo(() => {
    const result = new Map<string, Array<{ record: ManagedWorktreeRecord; rows: WorktreeConversation[] }>>()
    for (const record of records ?? []) {
      const key = record.repoRoot || '', group = result.get(key) ?? []
      group.push({ record, rows: worktreeConversations(record.path, conversations) }); result.set(key, group)
    }
    return [...result].map(([key, entries]) => ({ key, entries: entries.sort((a, b) => b.rows.length - a.rows.length) }))
  }, [records, conversations])
  const refreshControl = <StorageButton tone="ghost" id="worktrees-refresh-button" title={t('worktrees_refresh')} busy={refreshing} disabled={refreshing} aria-label={t('worktrees_refresh')} onClick={() => { void load() }}><Icon name="refresh" size={14} /></StorageButton>
  return <div className={styles.worktreeManager} data-worktrees-page="1">
    {settings && <div className={styles.card}>
      <div className={styles.row}><div><div className={styles.rowLabel} id="worktrees-root-label">{t('worktrees_root_label')}</div><p className={styles.description}>{t('worktrees_root_desc')}</p></div>
        <input id="worktrees-root" className={styles.settingInput} aria-labelledby="worktrees-root-label" value={rootDraft ?? settings.root} placeholder={settings.defaultRoot}
          disabled={saving.has('root')} onChange={event => setRootDraft(event.target.value)} onBlur={() => { void commitRoot() }} /></div>
      <div className={styles.row}><div><div className={styles.rowLabel} id="worktrees-upstream-label">{t('worktrees_upstream_label')}</div><p className={styles.description}>{t('worktrees_upstream_desc')}</p></div>
        <button type="button" className={styles.switch} id="worktrees-upstream" role="switch" aria-labelledby="worktrees-upstream-label"
          aria-checked={settings.upstreamRefreshMode === 'best-effort'} disabled={saving.has('upstream')} onClick={() => {
            const mode = settings.upstreamRefreshMode === 'best-effort' ? 'never' : 'best-effort'
            void save({ upstreamRefreshMode: mode }, 'upstream', mode === 'never' ? 'worktrees_upstream_off' : 'worktrees_upstream_on', 'worktrees_upstream_error')
          }} /></div>
      <div className={styles.row}><div><div className={styles.rowLabel} id="worktrees-auto-cleanup-label">{t('worktrees_auto_cleanup_label')}</div><p className={styles.description}>{t('worktrees_auto_cleanup_desc')}</p></div>
        <button type="button" className={styles.switch} id="worktrees-auto-cleanup" role="switch" aria-labelledby="worktrees-auto-cleanup-label"
          aria-checked={settings.autoCleanupEnabled} disabled={saving.has('autoCleanup')} onClick={() => {
            if (settings.autoCleanupEnabled) setConfirmDisable(true)
            else void save({ autoCleanupEnabled: true }, 'autoCleanup', 'worktrees_auto_cleanup_save_enabled', 'worktrees_auto_cleanup_error')
          }} /></div>
      <div className={styles.row}><div><div className={styles.rowLabel} id="worktrees-keep-count-label">{t('worktrees_keep_count_label')}</div><p className={styles.description}>{t(settings.autoCleanupEnabled ? 'worktrees_keep_count_desc' : 'worktrees_keep_count_desc_disabled')}</p></div>
        <input id="worktrees-keep-count" type="number" inputMode="numeric" min={1} step={1} className={`${styles.settingInput} ${styles.number}`} aria-labelledby="worktrees-keep-count-label"
          value={keepDraft ?? String(settings.keepCount)} disabled={saving.has('keepCount') || saving.has('autoCleanup') || !settings.autoCleanupEnabled} onChange={event => setKeepDraft(event.target.value)}
          onBlur={() => { void commitKeep() }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void commitKeep() } }} /></div>
    </div>}
    {records == null && !error && <p className={styles.empty} role="status">{t('worktrees_loading')}</p>}
    {error && <div className={styles.card}><header className={styles.cardHeader}><h3>{t('worktrees_error_title')}</h3>{refreshControl}</header><p className={styles.empty} role="alert">{error}</p></div>}
    {records?.length === 0 && !error && <div className={styles.card}><header className={styles.cardHeader}><h3>{t('worktrees_empty_title')}</h3>{refreshControl}</header><p className={styles.empty}>{t('worktrees_empty_body')}</p></div>}
    {!error && groups.map(({ key, entries }, index) => <section className={styles.card} key={key}>
      <header className={styles.cardHeader}><h3>{key || t('worktrees_repo_unknown')}</h3>{index === 0 && refreshControl}</header>
      {entries.map(({ record, rows }) => {
        const pinned = rows.some(worktreePinned)
        return <div className={styles.worktreeEntry} key={record.path} data-worktree-path={record.path}>
          <div className={styles.row}><div><div className={styles.rowLabel}>{t('worktrees_row_title')}</div><div className={styles.path}>{record.path}</div>
            <p className={styles.description}>{t(pinned ? 'worktrees_row_pinned' : 'worktrees_new_chat_desc')}</p></div>
            <div className={styles.actions}><StorageButton disabled={pending.has(record.path)} onClick={() => { void openChat(record, rows) }}><Icon name="plus" size={14} />{t('worktrees_new_chat')}</StorageButton>
              <StorageButton danger busy={pending.has(record.path)} disabled={pinned || pending.has(record.path) || refreshing} onClick={() => { void remove(record) }}>{t('worktrees_row_delete')}</StorageButton></div>
          </div>
          <div className={styles.conversations}><span>{t('worktrees_row_conversations')}</span>
            {rows.length ? rows.map(row => <button key={row.id} type="button" onClick={() => { w().closeSettings?.(); void w().switchSession(row.id) }}>{w().sessionDisplayTitle?.(row) || row.title || t('storage_cleanup_untitled')}</button>)
              : <span>{t('worktrees_conversations_empty')}</span>}
          </div>
        </div>
      })}
    </section>)}
    {confirmDisable && <StorageDialog title={t('worktrees_auto_cleanup_confirm_title')} dismissible={false} onClose={() => setConfirmDisable(false)}
      footer={<><StorageButton tone="ghost" autoFocus onClick={() => setConfirmDisable(false)}>{t('worktrees_auto_cleanup_confirm_cancel')}</StorageButton><StorageButton danger onClick={() => {
        setConfirmDisable(false); setKeepDraft(null); void save({ autoCleanupEnabled: false }, 'autoCleanup', 'worktrees_auto_cleanup_save_disabled', 'worktrees_auto_cleanup_error')
      }}>{t('worktrees_auto_cleanup_confirm_ok')}</StorageButton></>}><p className={styles.description}>{t('worktrees_auto_cleanup_confirm_body')}</p></StorageDialog>}
  </div>
}

export function WorktreesTab() {
  const t = useT()
  return <SettingsPage title={t('worktrees_settings')}><WorktreesManager /></SettingsPage>
}
