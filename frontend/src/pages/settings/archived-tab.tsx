// 归档会话 tab（迁自 js/settings.js 的 loadArchivedSessionsTab）：
// 搜索/项目筛选/按项目分组、打开（关设置切会话）、取消归档（生命周期控制器
// 防重入）、全部删除（rendererProductContracts 驱动逐个删 + 失败上浮）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import { SettingsPage } from './kv'
import { useSettingsSnapshot } from './settings-snapshot'
import { ensureSettingsAccountListener } from '../profile/ProfilePage'
import styles from './settings.module.css'

const w = () => window as any

function Raw({ name }: { name: string }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: rawIconHtml(name) }} />
}

interface ArchivedSession {
  id: string
  workdir?: string
  updatedAt?: number
  createdAt?: number
}

export function ArchivedSessionsTab() {
  const t = useT()
  const [archived, setArchived, beginRead] = useSettingsSnapshot<ArchivedSession[] | null>('account:archived-sessions', null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadSequence, setReloadSequence] = useState(0)
  const [query, setQuery] = useState('')
  const [selectedProject, setSelectedProject] = useState('all')
  const [deleteAllPending, setDeleteAllPending] = useState(false)
  const [, setTick] = useState(0)
  // 生命周期控制器跨渲染持有（isPending 驱动行 busy 态；bump 强制重渲）。
  const lifecycleRef = useRef<any>(null)
  if (!lifecycleRef.current) {
    lifecycleRef.current = w().KlausRendererProductContracts.createArchivedLifecycleController()
  }
  const bump = () => setTick(n => n + 1)

  useEffect(() => {
    ensureSettingsAccountListener()
    let cancelled = false
    const publish = beginRead()
    void (async () => {
      try {
        const list = await w().klaus.session.listArchived()
        list.sort((a: ArchivedSession, b: ArchivedSession) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
        if (!cancelled && publish(list)) setLoadError(null)
      } catch (error: any) {
        if (!cancelled) setLoadError(error?.message || t('archived_sessions_load_failed'))
      }
    })()
    return () => { cancelled = true }
  }, [reloadSequence, beginRead])

  const projectKey = (session: ArchivedSession) => String(session?.workdir || '').trim() || '__no_project__'
  const projectLabel = (key: string) => {
    if (key === '__no_project__') return t('archived_no_project')
    const normalized = key.replace(/[\\/]+$/, '')
    return normalized.split(/[\\/]/).pop() || key
  }
  const formatDate = (value: number | undefined) => {
    if (!value) return ''
    const date = new Date(Number(value) || 0)
    if (Number.isNaN(date.getTime())) return ''
    return new Intl.DateTimeFormat(w().getLang?.() === 'zh' ? 'zh-CN' : 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  }

  useEffect(() => {
    if (!archived || selectedProject === 'all') return
    const available = archived.some(session => projectKey(session) === selectedProject)
    if (!available) setSelectedProject('all')
  }, [archived, selectedProject])

  const groups = useMemo(() => {
    if (!archived) return new Map<string, ArchivedSession[]>()
    const needle = query.trim().toLocaleLowerCase()
    const visible = archived.filter(session => {
      if (selectedProject !== 'all' && projectKey(session) !== selectedProject) return false
      if (!needle) return true
      const title = String(w().sessionDisplayTitle(session) || t('untitled')).toLocaleLowerCase()
      return title.includes(needle) || projectLabel(projectKey(session)).toLocaleLowerCase().includes(needle)
    })
    const map = new Map<string, ArchivedSession[]>()
    for (const session of visible) {
      const key = projectKey(session)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(session)
    }
    return map
  }, [archived, query, selectedProject, t])

  const errorNotice = loadError == null ? null : (
    <div className={`${styles['archived-settings-empty']} error`} role="alert">
      <span>{loadError}</span>
      <button type="button" className="btn-sm" onClick={() => setReloadSequence(value => value + 1)}>{t('sessions_retry')}</button>
    </div>
  )
  if (!archived) {
    return (
      <SettingsPage title={t('archived_sessions')} subtitle={t('archived_settings_desc')}>
        {errorNotice || <div className={styles['archived-settings-empty']}>{t('loading')}</div>}
      </SettingsPage>
    )
  }

  const lifecycle = lifecycleRef.current
  const contracts = w().KlausRendererProductContracts
  const projects = [...new Set(archived.map(projectKey))]
    .sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)))

  const deleteAll = async () => {
    if (deleteAllPending) return
    const confirmed = await w().klausDialog.confirm({ message: t('archived_delete_all_confirm'), danger: true })
    if (!confirmed) return
    setDeleteAllPending(true)
    try {
      const results = await contracts.runArchivedDeleteAll(
        lifecycle,
        [...archived],
        async (sessionId: string) => {
          try {
            await w().deleteSession(sessionId, { skipConfirm: true })
            return { ok: true }
          } catch (error: any) {
            return { ok: false, code: error?.code, error: error?.message || String(error) }
          }
        },
        bump,
      )
      const failure = results.find(({ result }: any) => (
        result?.ok === false
        && result?.code !== 'lifecycle_operation_in_progress'
        && result?.code !== 'session_deleted'
      ))
      if (failure) {
        await w().klausDialog.alert(
          failure.result?.code || failure.result?.error || t('setup_status_unknown'),
        )
      }
      setReloadSequence(value => value + 1)
    } catch (error: any) {
      setLoadError(error?.message || t('archived_sessions_load_failed'))
    } finally {
      setDeleteAllPending(false)
    }
  }

  const openSession = async (sessionId: string) => {
    if (lifecycle.isPending(sessionId)) return
    const operation = lifecycle.run(sessionId, 'open', async () => {
      try {
        await w().listArchivedSessions()
        w().closeSettings()
        await w().switchSession(sessionId)
        return { ok: true }
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error) }
      }
    })
    bump()
    const result = await operation
    bump()
    if (!result?.ok) {
      await w().klausDialog.alert(result?.error || t('archived_sessions_load_failed'))
      return
    }
  }

  const unarchive = async (sessionId: string) => {
    if (lifecycle.isPending(sessionId)) return
    const operation = lifecycle.run(sessionId, 'unarchive', async () => {
      try {
        return await w().klaus.session.unarchive(sessionId)
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error) }
      }
    })
    bump()
    const result = await operation
    if (!contracts.shouldRefreshAfterUnarchive(result)) {
      bump()
      await w().klausDialog.alert(
        t('archived_unarchive_failed').replace(
          '{reason}',
          result?.code || result?.error || result?.status || t('setup_status_unknown'),
        ),
      )
      return
    }
    const refreshed = await w().klaus.session.listArchived()
    await w().updateSessionInList()
    const next = [...refreshed]
    next.sort((a: ArchivedSession, b: ArchivedSession) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
    if (result?.ok === true) w().showToast(t('archived_unarchive_success'))
    setArchived(next)
  }

  return (
    <SettingsPage
      title={t('archived_sessions')} subtitle={t('archived_settings_desc')}
      actions={
        <button
          type="button" className={styles['archived-settings-delete-all']} aria-busy={deleteAllPending}
          disabled={!archived.length || deleteAllPending}
          onClick={() => { void deleteAll() }}
        >
          <Raw name="trash" />
          {t('archived_delete_all')}
        </button>
      }
    >
      {errorNotice}
      <div className={styles['archived-settings-toolbar']}>
        <label className={styles['archived-settings-search']}>
          <Raw name="archived-search" />
          <input
            type="search" value={query} placeholder={t('archived_search_placeholder')} aria-label={t('archived_search_placeholder')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className={styles['archived-settings-project']}>
          <Raw name="folder" />
          <select aria-label={t('archived_project_filter')} value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
            <option value="all">{t('archived_all_projects')}</option>
            {projects.map(key => <option value={key} key={key}>{projectLabel(key)}</option>)}
          </select>
        </label>
      </div>
      <div className="archived-settings-body">
        {groups.size ? [...groups.entries()].map(([key, sessions]) => (
          <section className={styles['archived-settings-group']} key={key}>
            <div className={styles['archived-settings-group-header']}>
              <div className={styles['archived-settings-project-name']}>
                <Raw name="folder" />
                <span>{projectLabel(key)}</span>
              </div>
              <span>{t('archived_count').replace('{count}', String(sessions.length))}</span>
            </div>
            <div className={styles['archived-settings-list']}>
              {sessions.map(session => {
                const pending = deleteAllPending || lifecycle.isPending(session.id)
                return (
                  <div className={styles['archived-settings-row']} data-session-id={session.id} aria-busy={pending} key={session.id}>
                    <button
                      type="button" className={styles['archived-settings-session-main']} disabled={pending}
                      aria-label={`${t('archived_open')}: ${w().sessionDisplayTitle(session) || t('untitled')}`}
                      onClick={() => { void openSession(session.id) }}
                    >
                      <span className={styles['archived-settings-session-title']}>{w().sessionDisplayTitle(session) || t('untitled')}</span>
                      <span className={styles['archived-settings-session-date']}>{formatDate(session.updatedAt || session.createdAt)}</span>
                    </button>
                    <div className={styles['archived-settings-actions']}>
                      <button
                        type="button" className="btn-sm" disabled={pending}
                        onClick={() => { void unarchive(session.id) }}
                      >{t('archived_unarchive')}</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )) : <div className={styles['archived-settings-empty']}>{t('archived_sessions_empty')}</div>}
      </div>
    </SettingsPage>
  )
}
