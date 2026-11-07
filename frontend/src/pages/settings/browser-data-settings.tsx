import { useEffect, useRef, useState } from 'react'
import type { BrowserCredentialsApi, BrowserCredentialsLabels } from '../../../../contracts/browser-credentials'
import styles from './browser-data-settings.module.css'
import { logHostDiagnostic } from './settings-error-text'

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
  extensionItemError: string
}

interface Props {
  api: BrowserExtensionsApiLike
  labels: BrowserDataSettingsLabels
}

function normalizeList(reply: BrowserExtensionsListReply): BrowserExtensionInfoLike[] {
  return Array.isArray(reply) ? reply : reply.items
}

/** Extension management lives on its own surface, separate from saved passwords. */
export function BrowserExtensionSettings({ api, labels }: Props) {
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
      const reply = await api.list()
      if (!mounted.current || revision !== loadRevision.current) return
      setExtensions(normalizeList(reply))
      setError('')
    } catch (cause) {
      if (mounted.current && revision === loadRevision.current) { logHostDiagnostic('browser-extensions', cause); setError(labels.extensionActionFailed) }
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
      await api.install({ path })
      setExtensionPath('')
      await loadExtensions()
    } catch (cause) {
      logHostDiagnostic('browser-extensions', cause)
      setError(labels.installFailed)
    } finally {
      setBusy(null)
    }
  }

  const choose = async () => {
    if (!api.choose) return
    setBusy('install')
    setError('')
    try {
      const result = await api.choose()
      if (!result.cancelled) await loadExtensions()
    } catch (cause) { logHostDiagnostic('browser-extensions', cause); setError(labels.installFailed) }
    finally { setBusy(null) }
  }

  const setEnabled = async (item: BrowserExtensionInfoLike, enabled: boolean) => {
    setBusy(`toggle:${item.id}`)
    setError('')
    try {
      await api.setEnabled(item.id, enabled)
      await loadExtensions()
    } catch (cause) {
      logHostDiagnostic('browser-extensions', cause)
      setError(labels.extensionActionFailed)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (item: BrowserExtensionInfoLike) => {
    setBusy(`remove:${item.id}`)
    setError('')
    try {
      await api.remove(item.id)
      await loadExtensions()
    } catch (cause) {
      logHostDiagnostic('browser-extensions', cause)
      setError(labels.extensionActionFailed)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={styles.extensions}>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      {api.choose ? <div className={styles.actions}><button type="button" disabled={busy !== null || loading} onClick={() => void choose()}>{labels.installExtension}</button><button type="button" disabled={busy !== null || loading} onClick={() => void loadExtensions()}>{labels.refreshExtensions}</button></div> : <form className={styles.installForm} onSubmit={install}>
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
                {item.error ? <span className={styles.error}>{labels.extensionItemError}</span> : null}
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
  )
}
