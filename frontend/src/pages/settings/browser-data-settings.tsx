import { useEffect, useRef, useState } from 'react'
import type { BrowserCredentialsApi, BrowserCredentialsLabels } from '../../../../contracts/browser-credentials'
import { BrowserCredentialsSettings } from './browser-credentials'
import styles from './browser-data-settings.module.css'

/** Extension lifecycle operations are injected by the settings bridge. */
export interface BrowserExtensionInfoLike {
  id: string
  name: string
  version: string
  enabled: boolean
  loaded: boolean
  path: string
  permissions: string[]
  error?: string
}

export interface BrowserExtensionPackageLike {
  path: string
  id?: string
  name?: string
  version?: string
}

export interface BrowserExtensionsSnapshotLike {
  items: BrowserExtensionInfoLike[]
}

export type BrowserExtensionsListReply = BrowserExtensionsSnapshotLike | BrowserExtensionInfoLike[]

export interface BrowserExtensionsApiLike {
  list(): Promise<BrowserExtensionsListReply>
  install(input: BrowserExtensionPackageLike): Promise<unknown>
  choose?(): Promise<{cancelled?: boolean; item?: BrowserExtensionInfoLike}>
  setEnabled(id: string, enabled: boolean): Promise<unknown>
  remove(id: string): Promise<void>
}

export interface BrowserDataSettingsApi {
  credentials: BrowserCredentialsApi
  extensions: BrowserExtensionsApiLike
}

export interface BrowserDataSettingsLabels {
  credentials: BrowserCredentialsLabels
  extensionsTitle: string
  extensionsDescription: string
  extensionPathLabel: string
  installExtension: string
  refreshExtensions: string
  emptyExtensions: string
  enabledLabel: string
  disabledLabel: string
  loadedLabel: string
  notLoadedLabel: string
  permissionsLabel: string
  enableAction: string
  disableAction: string
  removeAction: string
  installFailed: string
  extensionActionFailed: string
}

interface Props {
  api: BrowserDataSettingsApi
  labels: BrowserDataSettingsLabels
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeList(reply: BrowserExtensionsListReply): BrowserExtensionInfoLike[] {
  return Array.isArray(reply) ? reply : reply.items
}

export function BrowserDataSettings({ api, labels }: Props) {
  const [extensions, setExtensions] = useState<BrowserExtensionInfoLike[]>([])
  const [extensionPath, setExtensionPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const loadRevision = useRef(0)
  const mounted = useRef(false)
  const loadExtensions = async () => {
    if (!mounted.current) return
    const revision = ++loadRevision.current
    setLoading(true)
    try {
      const reply = await api.extensions.list()
      if (!mounted.current || revision !== loadRevision.current) return
      setExtensions(normalizeList(reply))
      setError('')
    } catch (cause) {
      if (mounted.current && revision === loadRevision.current) setError(`${labels.extensionActionFailed}: ${errorText(cause)}`)
    } finally {
      if (mounted.current && revision === loadRevision.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void loadExtensions()
    return () => { mounted.current = false; loadRevision.current++ }
  }, [api])

  const install = async (event: React.FormEvent) => {
    event.preventDefault()
    const path = extensionPath.trim()
    if (!path) return
    setBusy('install')
    setError('')
    try {
      await api.extensions.install({ path })
      setExtensionPath('')
      await loadExtensions()
    } catch (cause) {
      setError(`${labels.installFailed}: ${errorText(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const choose = async () => {
    if (!api.extensions.choose) return
    setBusy('install')
    setError('')
    try {
      const result = await api.extensions.choose()
      if (!result.cancelled) await loadExtensions()
    } catch (cause) { setError(`${labels.installFailed}: ${errorText(cause)}`) }
    finally { setBusy(null) }
  }

  const setEnabled = async (item: BrowserExtensionInfoLike, enabled: boolean) => {
    setBusy(`toggle:${item.id}`)
    setError('')
    try {
      await api.extensions.setEnabled(item.id, enabled)
      await loadExtensions()
    } catch (cause) {
      setError(`${labels.extensionActionFailed}: ${errorText(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (item: BrowserExtensionInfoLike) => {
    setBusy(`remove:${item.id}`)
    setError('')
    try {
      await api.extensions.remove(item.id)
      await loadExtensions()
    } catch (cause) {
      setError(`${labels.extensionActionFailed}: ${errorText(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.root}>
      <section className={styles.extensions}>
        <header className={styles.header}>
          <h2>{labels.extensionsTitle}</h2>
          <p>{labels.extensionsDescription}</p>
        </header>

        {error ? <p className={styles.error} role="alert">{error}</p> : null}

        {api.extensions.choose ? <div className={styles.actions}><button type="button" disabled={busy !== null || loading} onClick={() => void choose()}>{labels.installExtension}</button><button type="button" disabled={busy !== null || loading} onClick={() => void loadExtensions()}>{labels.refreshExtensions}</button></div> : <form className={styles.installForm} onSubmit={install}>
          <label>
            <span>{labels.extensionPathLabel}</span>
            <input
              value={extensionPath}
              onChange={event => setExtensionPath(event.target.value)}
              spellCheck={false}
            />
          </label>
          <div className={styles.actions}>
            <button type="submit" disabled={busy !== null || !extensionPath.trim()}>
              {labels.installExtension}
            </button>
            <button type="button" disabled={busy !== null || loading} onClick={() => void loadExtensions()}>
              {labels.refreshExtensions}
            </button>
          </div>
        </form>}

        {extensions.length ? (
          <ul className={styles.list}>
            {extensions.map(item => (
              <li key={item.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <strong>{item.name || item.id}</strong>
                  <span>{item.version} · {item.path}</span>
                  <span>
                    {item.enabled ? labels.enabledLabel : labels.disabledLabel}
                    {' · '}
                    {item.loaded ? labels.loadedLabel : labels.notLoadedLabel}
                    {item.permissions.length ? ` · ${labels.permissionsLabel}: ${item.permissions.join(', ')}` : ''}
                  </span>
                  {item.error ? <span className={styles.error}>{item.error}</span> : null}
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void setEnabled(item, !item.enabled)}
                  >
                    {item.enabled ? labels.disableAction : labels.enableAction}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void remove(item)}
                  >
                    {labels.removeAction}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>{loading ? labels.refreshExtensions : labels.emptyExtensions}</p>
        )}
      </section>

      <BrowserCredentialsSettings api={api.credentials} labels={labels.credentials} />
    </div>
  )
}
