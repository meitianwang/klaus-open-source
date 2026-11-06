import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n'
import { Icon } from '../../components/Icon'
import {
  END_RESOURCE_COLLAPSED_COUNT, END_RESOURCE_VISIBLE_LIMIT, endResourceFileKind, isLocalWebUrl, isUrlTarget, resourceDirectoryLabel,
  type EndResource, type EndResourceFileKind,
} from '../../../../contracts/end-resources'
import type { EndResourceApp, EndResourceTargets } from '../../../../contracts/end-resource-open'
import {
  downloadEndResourceCopy, endResourcePageMeta, endResourceTargets, existingEndResourceFiles, localSiteTargets,
  openEndResourceFile, openEndResourceInApp, revealEndResource, turnEndResources,
} from '../end-resources'
import { artifactTurn, artifactsVersion, subscribeArtifacts } from '../overview/artifacts'
import { openSiteReference } from '../site-references'
import styles from './end-resource-card.module.css'

const w = (): any => window as any

const FILE_ICON: Record<EndResourceFileKind, string> = {
  word: 'resource-file-word', excel: 'resource-file-excel', powerpoint: 'resource-file-powerpoint', pdf: 'resource-file-pdf',
  spreadsheet: 'resource-file-spreadsheet', presentation: 'resource-file-presentation', document: 'resource-file-document',
  image: 'resource-file-image', code: 'resource-file-code', html: 'resource-file-html', audio: 'resource-file-audio',
  latex: 'resource-file-document', file: 'resource-file',
}

function basename(path: string): string { return path.split(/[\\/]/).pop() || path }

// ---- menu ----

interface MenuItem {
  key: string
  icon?: ReactNode
  label: ReactNode
  onSelect?: () => void
  separatorBefore?: boolean
  message?: boolean
}

/** Dropdown anchored to its trigger's end edge, rendered at the body so the transcript never clips it. */
function ResourceMenu({ anchor, items, label, onClose }: { anchor: HTMLElement; items: MenuItem[]; label: string; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null)
  const box = anchor.getBoundingClientRect()
  const position = { top: Math.min(box.bottom + 8, window.innerHeight - 8), right: Math.max(8, window.innerWidth - box.right) }
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose()
    }
    const dismiss = () => onClose()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    menu.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [anchor, onClose])
  const firstItem = items.findIndex(item => !item.message)
  useEffect(() => {
    if (firstItem >= 0) menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]?.focus()
  }, [firstItem, items.length])
  return createPortal(<div className={styles.menu} ref={menu} role="menu" tabIndex={-1} aria-label={label}
    style={{ top: position.top, right: position.right }}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        anchor.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus()
        return
      }
      if (event.key === 'Tab') { onClose(); return }
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || buttons.length === 0) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }}>
    {items.map(item => <div key={item.key} className={styles.menuGroup}>
      {item.separatorBefore ? <div className={styles.menuSeparator} role="separator" /> : null}
      {item.message
        ? <div className={styles.menuMessage} role="status">{item.label}</div>
        : <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { onClose(); item.onSelect?.() }}>
            <span className={styles.menuItemIcon} aria-hidden="true">{item.icon}</span>
            <span className={styles.menuItemLabel}>{item.label}</span>
          </button>}
    </div>)}
  </div>, document.body)
}

function AppIcon({ app }: { app: EndResourceApp }) {
  return app.iconDataUrl ? <img src={app.iconDataUrl} alt="" width="16" height="16" className={styles.appIcon} draggable={false} /> : <Icon name="resource-file" size={16} />
}

/** Loads the application list the first time the user points at the open control. */
function useTargets(sessionId: string, resource: EndResource) {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'failed'; targets?: EndResourceTargets }>({ status: 'idle' })
  const started = useRef(false)
  const load = () => {
    if (started.current) return
    started.current = true
    setState({ status: 'loading' })
    void endResourceTargets(sessionId, resource)
      .then(targets => setState({ status: 'ready', targets }))
      .catch(() => setState({ status: 'failed' }))
  }
  return { ...state, load }
}

// ---- rows ----

function ResourceRow({ kind, label, ariaLabel, onOpen, onPrime, icon, title, defaultSubtitle, hoverSubtitle, trailing, menuOpen }: {
  kind: 'website' | 'file'
  /** Name the turn navigation preview shows; a website shows its type instead. */
  label?: string
  ariaLabel: string
  onOpen: () => void
  onPrime?: () => void
  icon: ReactNode
  title: string
  defaultSubtitle: ReactNode
  hoverSubtitle: ReactNode
  trailing: ReactNode
  menuOpen: boolean
}) {
  return <div className={styles.row} data-menu-open={menuOpen || undefined} data-end-resource-type={kind} data-end-resource-label={label}>
    <button type="button" className={styles.rowButton} aria-label={ariaLabel} onClick={onOpen} onFocus={onPrime} onMouseEnter={onPrime} />
    <div className={styles.rowContent}>
      <span className={styles.rowIcon}>{icon}</span>
      <span className={styles.rowCopy}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowSubtitle}>
          <span className={styles.subtitleDefault}>{defaultSubtitle}</span>
          <span className={styles.subtitleHover}>{hoverSubtitle}</span>
        </span>
      </span>
      {trailing}
    </div>
  </div>
}

function OpenInButton({ split, onPrimary, onToggle, buttonRef, open, onPrime }: {
  split: boolean
  onPrimary?: () => void
  onToggle: () => void
  buttonRef: React.RefObject<HTMLDivElement | null>
  open: boolean
  onPrime: () => void
}) {
  const t = useT()
  const id = useId()
  if (!split) return <div ref={buttonRef} className={styles.openIn}>
    <button type="button" className={styles.openInSingle} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={onToggle} onFocus={onPrime} onMouseEnter={onPrime}>
      <span>{t('end_resource_open_in')}</span>
      <span className={styles.chevron} aria-hidden="true"><Icon name="chevron-down" size={14} /></span>
    </button>
  </div>
  return <div ref={buttonRef} className={styles.openIn}>
    <button type="button" className={styles.openInPrimary} onClick={onPrimary} onFocus={onPrime} onMouseEnter={onPrime}>{t('end_resource_open_in')}</button>
    <button type="button" className={styles.openInSecondary} aria-label={t('end_resource_open_in_menu')} aria-haspopup="menu" aria-expanded={open}
      onMouseDown={event => event.preventDefault()} onClick={onToggle} onFocus={onPrime} onMouseEnter={onPrime}>
      <span className={styles.chevron} aria-hidden="true"><Icon name="chevron-down" size={14} /></span>
    </button>
  </div>
}

function WebsiteRow({ sessionId, resource }: { sessionId: string; resource: Extract<EndResource, { type: 'website' }> }) {
  const t = useT()
  const url = isUrlTarget(resource.target)
  const [meta, setMeta] = useState<{ title: string | null; iconUrl: string | null } | null>(null)
  const [iconFailed, setIconFailed] = useState<string | null>(null)
  const [browserName, setBrowserName] = useState<string | null | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const targets = useTargets(sessionId, resource)
  useEffect(() => {
    if (url) return
    let active = true
    void endResourcePageMeta(sessionId, resource.target).then(result => { if (active) setMeta(result) })
    return () => { active = false }
  }, [sessionId, resource.target, url])
  const title = meta?.title || t('end_resource_website_title')
  const icon = meta?.iconUrl && iconFailed !== meta.iconUrl
    ? <img src={meta.iconUrl} alt="" className={styles.favicon} draggable={false} onError={() => setIconFailed(meta.iconUrl)} />
    : <Icon name="resource-globe" size={24} />
  const openInApp = () => {
    if (url) { void openSiteReference(sessionId, resource.target, 'in-app'); return }
    openEndResourceFile(resource.target)
  }
  const open = () => {
    if (url) { void openSiteReference(sessionId, resource.target); return }
    openEndResourceFile(resource.target)
  }
  const prime = () => {
    targets.load()
    if (url && browserName === undefined) {
      setBrowserName(null)
      void localSiteTargets().then(result => {
        if (!result) return
        const preferred = result.preferredTarget ?? 'in-app'
        if (preferred === 'in-app') { setBrowserName('in-app'); return }
        const target = result.targets.find(entry => entry.id === preferred)
        setBrowserName(target?.kind === 'named' ? target.name : '')
      })
    }
  }
  const hoverSubtitle = !url || browserName === 'in-app'
    ? t('end_resource_open_hover')
    : <>{browserName ? t('end_resource_open_in_browser_named').replace('{browser}', browserName) : t('end_resource_open_in_default_browser')}
        <span className={styles.external} aria-hidden="true"><Icon name="resource-external" size={12} /></span></>
  const items: MenuItem[] = [{ key: 'in-app', icon: <img src="logo.png" alt="" width="16" height="16" className={styles.appIcon} draggable={false} />, label: t('end_resource_in_app'), onSelect: openInApp }]
  for (const app of targets.targets?.apps ?? []) {
    items.push({ key: app.id, icon: <AppIcon app={app} />, label: app.label, onSelect: () => { void openEndResourceInApp(sessionId, resource, app.appPath) } })
  }
  if (targets.status === 'loading' && !(targets.targets?.apps.length)) items.push({ key: 'loading', label: t('end_resource_loading_apps'), message: true })
  if (url) {
    items.push({ key: 'copy', separatorBefore: true, icon: <Icon name="copy" size={16} />, label: t('end_resource_copy_link'), onSelect: () => {
      void Promise.resolve(w().klaus?.clipboard?.writeText?.(resource.target))
        .then(() => w().showToast?.(t('end_resource_link_copied')))
        .catch(() => w().showToast?.(t('end_resource_copy_failed')))
    } })
  }
  return <>
    <ResourceRow kind="website" ariaLabel={t('end_resource_open_named').replace('{title}', title)} onOpen={open} onPrime={prime} icon={icon} title={title}
      defaultSubtitle={t('end_resource_website_subtitle')} hoverSubtitle={hoverSubtitle} menuOpen={menuOpen}
      trailing={<OpenInButton split onPrimary={open} buttonRef={anchor} open={menuOpen} onPrime={prime}
        onToggle={() => { prime(); setMenuOpen(value => !value) }} />} />
    {menuOpen && anchor.current ? <ResourceMenu anchor={anchor.current} items={items} label={t('end_resource_open_in_menu')} onClose={() => setMenuOpen(false)} /> : null}
  </>
}

function fileSubtitle(t: (key: string) => string, path: string): string {
  const kind = endResourceFileKind(path)
  if (kind === 'file') return resourceDirectoryLabel(path)
  return t(`end_resource_kind_${kind}`)
}

function FileRow({ sessionId, resource }: { sessionId: string; resource: Extract<EndResource, { type: 'file' }> }) {
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const targets = useTargets(sessionId, resource)
  const name = basename(resource.path)
  const platform = targets.targets?.platform ?? (/Mac/i.test(navigator.platform) ? 'darwin' : /Win/i.test(navigator.platform) ? 'win32' : 'linux')
  const items: MenuItem[] = []
  for (const app of targets.targets?.apps ?? []) {
    items.push({ key: app.id, icon: <AppIcon app={app} />, label: app.isDefault ? t('end_resource_app_default').replace('{target}', app.label) : app.label,
      onSelect: () => { void openEndResourceInApp(sessionId, resource, app.appPath) } })
  }
  if (targets.status === 'loading') items.push({ key: 'loading', label: t('end_resource_loading_apps'), message: true })
  items.push({
    key: 'reveal', separatorBefore: items.length > 0,
    icon: targets.targets?.fileManagerIconDataUrl ? <img src={targets.targets.fileManagerIconDataUrl} alt="" width="16" height="16" className={styles.appIcon} draggable={false} /> : <Icon name="folder" size={16} />,
    label: platform === 'darwin' ? t('end_resource_show_in_finder') : platform === 'win32' ? t('end_resource_show_in_explorer') : t('end_resource_show_in_file_manager'),
    onSelect: () => { void revealEndResource(sessionId, resource.path) },
  })
  if (targets.targets?.downloadsIconDataUrl) {
    items.push({ key: 'download', icon: <img src={targets.targets.downloadsIconDataUrl} alt="" width="16" height="16" className={styles.appIcon} draggable={false} />,
      label: t('end_resource_download_copy'), onSelect: () => { void downloadEndResourceCopy(sessionId, resource.path) } })
  }
  return <>
    <ResourceRow kind="file" label={name} ariaLabel={t('end_resource_open_named').replace('{title}', name)} onOpen={() => openEndResourceFile(resource.path)}
      icon={<Icon name={FILE_ICON[endResourceFileKind(resource.path)]} size={24} />} title={name}
      defaultSubtitle={fileSubtitle(t, resource.path)} hoverSubtitle={t('end_resource_open_preview')} menuOpen={menuOpen}
      trailing={<OpenInButton split={false} buttonRef={anchor} open={menuOpen} onPrime={targets.load}
        onToggle={() => { targets.load(); setMenuOpen(value => !value) }} />} />
    {menuOpen && anchor.current ? <ResourceMenu anchor={anchor.current} items={items} label={t('end_resource_open_in_menu')} onClose={() => setMenuOpen(false)} /> : null}
  </>
}

// ---- list ----

const existenceListeners = new Set<() => void>()
let existenceVersion = 0
/** `'all'` means the check itself failed: every file row is shown rather than none. */
const existenceCache = new Map<string, Set<string> | 'all' | 'pending'>()

function useExistingFiles(sessionId: string, paths: readonly string[]): Set<string> | 'all' | null {
  const key = `${sessionId}\0${paths.join('\0')}`
  useSyncExternalStore(listener => { existenceListeners.add(listener); return () => { existenceListeners.delete(listener) } }, () => existenceVersion, () => existenceVersion)
  useEffect(() => {
    if (paths.length === 0 || existenceCache.has(key)) return
    existenceCache.set(key, 'pending')
    void existingEndResourceFiles(sessionId, paths).then(existing => existing, () => 'all' as const).then(existing => {
      existenceCache.set(key, existing)
      existenceVersion++
      for (const listener of existenceListeners) listener()
    })
  }, [key])
  if (paths.length === 0) return new Set()
  const cached = existenceCache.get(key)
  return cached && cached !== 'pending' ? cached : null
}

const EMPTY_RESOURCES: readonly EndResource[] = Object.freeze([])

/**
 * One turn's resources, recomputed when the engine's file-change record for
 * that turn arrives. `projected` is the list before the existence check; it
 * fixes the bubble's structure. `present` drops file rows the host has not
 * confirmed yet, and is what the cards and the reply's link-line pruning use.
 */
export function useTurnEndResources(sessionId: string, turn: { turnId: string; status: string } | null | undefined, finalText: string): { projected: readonly EndResource[]; present: readonly EndResource[] } {
  const version = useSyncExternalStore(subscribeArtifacts, artifactsVersion, artifactsVersion)
  const projected = useMemo(() => {
    if (!turn) return EMPTY_RESOURCES
    const editedPaths = artifactTurn(sessionId, turn.turnId)?.files.map(file => file.path) ?? []
    const resources = turnEndResources({ sessionId, status: turn.status, finalText, editedPaths })
    return resources.length ? resources : EMPTY_RESOURCES
  }, [version, sessionId, turn?.turnId, turn?.status, finalText])
  const filePaths = useMemo(() => projected.flatMap(resource => resource.type === 'file' ? [resource.path] : []), [projected])
  const existing = useExistingFiles(sessionId, filePaths)
  const present = useMemo(() => filePaths.length === 0 ? projected
    : projected.filter(resource => resource.type !== 'file' || existing === 'all' || existing?.has(resource.path)), [projected, filePaths, existing])
  return { projected, present }
}

/**
 * The turn-end resource list: the deliverables of one completed turn, after its
 * final reply.
 */
export function EndResourceCards({ sessionId, resources }: { sessionId: string; resources: readonly EndResource[] }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const present = resources
  if (present.length === 0) return null
  const limit = present.length > END_RESOURCE_VISIBLE_LIMIT ? END_RESOURCE_COLLAPSED_COUNT : present.length
  const shown = expanded ? present : present.slice(0, limit)
  const hidden = present.length - shown.length
  return <div className={styles.list} data-end-resources="true">
    {shown.map(resource => resource.type === 'file'
      ? <FileRow key={`file:${resource.path}`} sessionId={sessionId} resource={resource} />
      : <WebsiteRow key={`website:${resource.target}`} sessionId={sessionId} resource={resource} />)}
    {hidden > 0 ? <button type="button" className={styles.showMore} aria-expanded={false} onClick={() => setExpanded(true)}>
      <span>{t('end_resource_show_more').replace('{count}', new Intl.NumberFormat().format(hidden))}</span>
      <span className={styles.chevron} aria-hidden="true"><Icon name="chevron-down" size={14} /></span>
    </button> : null}
  </div>
}

/** Whether a website target is something the system browser can open. */
export function websiteTargetIsUrl(target: string): boolean { return isUrlTarget(target) && isLocalWebUrl(target) }
