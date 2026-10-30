import { useEffect, useRef, useState } from 'react'
import { allPages, canManageProject, request, useResource, type CollaborationProject, type CollaborationRoute } from './data'
import { CoverIcon, ErrorNotice, Icon, Loading, Popover } from './primitives'
import { ProjectCreateModal } from './project-form'
import { ProjectActionModal, type ProjectAction } from './project-settings'
import { filterAndSortProjects, PROJECT_FILTERS, PROJECT_SORTS } from './project-model'
import { useProjectPreferences } from './project-preferences'
import { intlLocale, useT } from './i18n'
import styles from './team-collaboration.module.css'

export function ProjectsList({ route, onNavigate, onOpen }: { route: CollaborationRoute; onNavigate: (route: CollaborationRoute) => void; onOpen: (project: CollaborationProject) => void }) {
  const t = useT()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CollaborationProject | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const { preferences, update, error: preferencesError } = useProjectPreferences()
  const result = useResource(() => allPages(cursor => request({ type: 'projects.list', archived: route.archived, cursor, limit: 100 })), [route.archived])
  const filtered = filterAndSortProjects(result.data || [], preferences, intlLocale())
  useEffect(() => { if (searchOpen) searchInput.current?.focus() }, [searchOpen])
  const focused = new Set(preferences.focusedIds)
  const hasProjects = (result.data?.length || 0) > 0
  return <>
    <header className={styles.pageHeader}><div><h1>{t('tc_nav')}</h1><p>{t('tc_subtitle')}</p></div>
      <div className={styles.headerActions}>
        {hasProjects && <>
          {searchOpen || preferences.search ? <div className={styles.searchBox}><Icon name="tc-search" size={14} /><input ref={searchInput} type="search" aria-label={t('tc_search')} placeholder={t('tc_search')} value={preferences.search} onChange={event => update(current => ({ ...current, search: event.target.value }))} onBlur={() => { if (!preferences.search.trim()) setSearchOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); update(current => ({ ...current, search: '' })); setSearchOpen(false) } }} />{preferences.search && <button type="button" className={styles.iconButton} aria-label={t('tc_clear_search')} onMouseDown={event => event.preventDefault()} onClick={() => { update(current => ({ ...current, search: '' })); searchInput.current?.focus() }}><Icon name="tc-close" size={12} /></button>}</div> : <button type="button" className={styles.iconButton} aria-label={t('tc_search')} onClick={() => setSearchOpen(true)}><Icon name="tc-search" size={16} /></button>}
          <Popover label={t('tc_filter')} trigger={<Icon name="tc-filter" size={16} />} active={preferences.filter !== 'all'}>{close => PROJECT_FILTERS.map(filter => <button type="button" role="menuitemradio" aria-checked={preferences.filter === filter} key={filter} onClick={() => { update(current => ({ ...current, filter })); close() }}><span>{t(`tc_filter_${filter}`)}</span>{preferences.filter === filter && <Icon name="tc-check" size={14} />}</button>)}</Popover>
          <Popover label={t('tc_sort')} trigger={<Icon name="tc-sort" size={16} />}>{close => PROJECT_SORTS.map(sort => <button type="button" role="menuitemradio" aria-checked={preferences.sort === sort} key={sort} onClick={() => { update(current => ({ ...current, sort })); close() }}><span>{t(`tc_sort_${sort}`)}</span>{preferences.sort === sort && <Icon name="tc-check" size={14} />}</button>)}</Popover>
          <button type="button" className={styles.primaryButton} onClick={() => setCreating(true)}><Icon name="tc-add" size={16} />{t('tc_new')}</button>
        </>}
        <Popover label={t('tc_more')} trigger={<Icon name="tc-more" size={18} />}>{close => <><button type="button" role="menuitem" onClick={() => { onNavigate({ ...route, archived: !route.archived }); close() }}><Icon name="tc-archive" size={15} />{t(route.archived ? 'tc_active' : 'tc_archived')}</button><button type="button" role="menuitem" onClick={() => { result.refresh(); close() }}><Icon name="tc-refresh" size={15} />{t('tc_refresh')}</button></>}</Popover>
      </div>
    </header>
    {route.archived && <div className={styles.archiveHeading}><Icon name="tc-archive" size={15} /><span>{t('tc_archived')}</span><button type="button" onClick={() => onNavigate({ ...route, archived: false })}>{t('tc_active')}</button></div>}
    <ErrorNotice error={result.error} onRetry={result.refresh} /><ErrorNotice error={preferencesError} />
    {result.pending && !result.data ? <Loading /> : !result.error && filtered.length === 0 ? <div className={styles.emptyState}><Icon name={route.archived ? 'tc-archive' : 'tc-projects'} size={48} /><h2>{t(hasProjects ? 'tc_no_results' : route.archived ? 'tc_archived_empty' : 'tc_empty')}</h2><p>{t(hasProjects ? 'tc_no_results_hint' : route.archived ? 'tc_archived_empty_hint' : 'tc_empty_body')}</p>{hasProjects ? <button type="button" onClick={() => update(current => ({ ...current, search: '', filter: 'all' }))}>{t('tc_clear_filters')}</button> : !route.archived && <button type="button" className={styles.primaryButton} onClick={() => setCreating(true)}><Icon name="tc-add" size={16} />{t('tc_new')}</button>}</div> : <ul className={styles.projectList}>{filtered.map(project => <ProjectListRow key={project.id} project={project} focused={focused.has(project.id)} onFocusToggle={() => update(current => ({ ...current, focusedIds: current.focusedIds.includes(project.id) ? current.focusedIds.filter(id => id !== project.id) : [...current.focusedIds, project.id] }))} onOpen={() => onOpen(project)} onChanged={result.refresh} />)}</ul>}
    {created && <div role="status" className={styles.successNotice}><Icon name="tc-check" size={16} /><span>{t('tc_created')}</span><button type="button" onClick={() => onOpen(created)}>{t('tc_view_project')}</button><button type="button" className={styles.iconButton} aria-label={t('tc_close')} onClick={() => setCreated(null)}><Icon name="tc-close" size={14} /></button></div>}
    {creating && <ProjectCreateModal onClose={() => setCreating(false)} onCreated={project => { setCreating(false); setCreated(project); result.refresh() }} />}
  </>
}

function ProjectListRow({ project, focused, onFocusToggle, onOpen, onChanged }: { project: CollaborationProject; focused: boolean; onFocusToggle: () => void; onOpen: () => void; onChanged: () => void }) {
  const t = useT()
  const [action, setAction] = useState<ProjectAction | null>(null)
  return <li className={styles.projectRow}>
    <button type="button" className={styles.projectRowLink} aria-label={project.name} onClick={onOpen}><CoverIcon icon={project.coverIcon} color={project.coverColor} size={20} /><span className={styles.projectRowText}><strong>{project.name}</strong><span>{project.description || t('tc_no_description')}</span></span></button>
    <div className={styles.projectRowActions}><button type="button" className={`${styles.focusButton} ${focused ? styles.focused : ''}`} aria-pressed={focused} aria-label={`${t(focused ? 'tc_unfocus' : 'tc_focus')} ${project.name}`} onClick={onFocusToggle}><Icon name={focused ? 'tc-star-fill' : 'tc-star'} size={14} /></button>
      {project.archivedAt && canManageProject(project) && <Popover label={t('tc_more')} trigger={<Icon name="tc-more" size={18} />}>{close => <><button type="button" role="menuitem" onClick={() => { close(); setAction('restore') }}>{t('tc_restore')}</button>{project.role === 'owner' && <button type="button" role="menuitem" className={styles.textDanger} onClick={() => { close(); setAction('delete') }}>{t('tc_delete')}</button>}</>}</Popover>}
    </div>
    {action && <ProjectActionModal project={project} action={action} onClose={() => setAction(null)} onChanged={() => { setAction(null); onChanged() }} />}
  </li>
}
