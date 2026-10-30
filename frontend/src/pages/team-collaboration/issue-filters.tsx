import { useState } from 'react'
import type { CollaborationMember } from '../../../../contracts/team-collaboration'
import { DEFAULT_BOARD_PREFERENCES, FILTER_OPERATOR_KEYS, ISSUE_PRIORITIES, ISSUE_STATUSES, filterOptions, memberName, parseSavedBoardFilters, type BoardPreferences, type FilterField, type FilterOperator, type SavedBoardFilter } from './board-model'
import { useBoardT } from './board-i18n'
import { BoardError } from './issue-fields'
import styles from './board-styles.module.css'

export function IssueFilters({ projectId, userId, prefs, members, onChange }: { projectId: string; userId: string | null; prefs: BoardPreferences; members: CollaborationMember[]; onChange(patch: Partial<BoardPreferences>): void }) {
  const t = useBoardT(), storageKey = `klaus:collaboration:filters:${projectId}:${userId || ''}`
  const [queries, setQueries] = useState<Record<FilterField, string>>({ statuses: '', priorities: '', assignees: '' })
  const [saved, setSaved] = useState<SavedBoardFilter[]>(() => { try { return parseSavedBoardFilters(localStorage.getItem(storageKey)) } catch { return [] } })
  const [name, setName] = useState(''), [error, setError] = useState('')
  function persist(next: SavedBoardFilter[]) {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setSaved(next); setError(''); return true }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('error')); return false }
  }
  function save() {
    if (!name.trim()) return
    const existing = saved.find(filter => filter.name === name.trim())
    const next = { id: existing?.id || crypto.randomUUID(), name: name.trim(), preferences: { ...prefs } }
    if (persist([...saved.filter(filter => filter.id !== next.id), next])) setName('')
  }
  function apply(filter: SavedBoardFilter) {
    const { statuses, priorities, assignees, statusOperator, priorityOperator, assigneeOperator, search, tab, archived } = filter.preferences
    onChange({ statuses, priorities, assignees, statusOperator, priorityOperator, assigneeOperator, search, tab, archived })
  }
  return <div className={styles.filterPanel}>
    <div className={styles.filterFields}>{(['statuses', 'priorities', 'assignees'] as const).map(field => {
      const label = t(field === 'statuses' ? 'status' : field === 'priorities' ? 'priority' : 'assignee')
      const options = field === 'statuses' ? ISSUE_STATUSES.map(value => ({ value, label: t(value) })) : field === 'priorities' ? ISSUE_PRIORITIES.map(value => ({ value, label: t(value) })) : [{ value: 'unassigned', label: t('unassigned') }, ...members.map(member => ({ value: member.id, label: memberName(member) }))]
      const filtered = filterOptions(options, prefs[field], queries[field]), operatorKey = FILTER_OPERATOR_KEYS[field]
      return <fieldset key={field}><legend>{label}</legend>
        <select aria-label={`${label} · ${t('filterOperator')}`} value={prefs[operatorKey]} onChange={event => onChange({ [operatorKey]: event.target.value as FilterOperator })}><option value="any">{t('includes')}</option><option value="none">{t('excludes')}</option></select>
        <input aria-label={`${label} · ${t('filterSearch')}`} placeholder={t('filterSearch')} value={queries[field]} onChange={event => setQueries(current => ({ ...current, [field]: event.target.value }))} />
        <div className={styles.filterChoices}>{filtered.map(option => <label key={option.value} className={styles.checkbox}><input type="checkbox" checked={(prefs[field] as string[]).includes(option.value)} onChange={event => onChange({ [field]: event.target.checked ? [...prefs[field], option.value] : prefs[field].filter(value => value !== option.value) })} />{option.label}</label>)}{!filtered.length && <p className={styles.muted}>{t('noFilterOptions')}</p>}</div>
      </fieldset>
    })}</div>
    <div className={styles.savedFilters}><h3>{t('savedFilters')}</h3>{saved.map(filter => <div key={filter.id}><button aria-label={`${t('applyFilter')} ${filter.name}`} onClick={() => apply(filter)}>{filter.name}</button><button aria-label={`${t('deleteFilter')} ${filter.name}`} onClick={() => persist(saved.filter(row => row.id !== filter.id))}>×</button></div>)}
      <form onSubmit={event => { event.preventDefault(); save() }}><input aria-label={t('filterName')} placeholder={t('filterName')} value={name} maxLength={100} onChange={event => setName(event.target.value)} /><button disabled={!name.trim()}>{t('saveFilter')}</button></form><p className={styles.muted}>{t('localFilters')}</p>
    </div>
    <button onClick={() => { setQueries({ statuses: '', priorities: '', assignees: '' }); onChange({ search: '', statuses: [], priorities: [], assignees: [], statusOperator: DEFAULT_BOARD_PREFERENCES.statusOperator, priorityOperator: 'any', assigneeOperator: 'any' }) }}>{t('clear')}</button>
    <BoardError message={error} />
  </div>
}
