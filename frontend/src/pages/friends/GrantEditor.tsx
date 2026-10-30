import { useId, type ReactNode } from 'react'
import type { FriendAppsSnapshot, FriendExecutionTargets, FriendTaskGrant } from '../../../../shared/friends'
import { FRIEND_EXECUTION_PRESETS, friendExecutionPreset, friendGrantMode, type FriendExecutionPreset } from '../../../../shared/friends'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { KlsSelect } from '../settings/model-shared'
import { PrefToggleRow } from '../settings/kv'
import settingsStyles from '../settings/settings.module.css'
import styles from './friends.module.css'

export type ReceiveChoice = 'off' | 'approve' | 'auto'
export function receiveChoice(allowed: boolean, policy?: FriendTaskGrant['policy']): ReceiveChoice {
  return !allowed || policy === 'reject' ? 'off' : policy === 'auto' ? 'auto' : 'approve'
}
export const GRANT_POLICIES = [
  { id: 'off' as const, label: 'friends_receive_off' },
  { id: 'approve' as const, label: 'friends_policy_approve' },
  { id: 'auto' as const, label: 'friends_receive_auto' },
]

export function targetSelectValue(target: FriendTaskGrant['target']): string {
  if (target?.kind === 'project') return 'project:' + target.root
  if (target?.kind === 'workspace') return 'workspace:' + target.id
  return 'none'
}
export function targetFromSelectValue(value: string): FriendTaskGrant['target'] {
  if (value.startsWith('project:')) return { kind: 'project', root: value.slice('project:'.length) }
  if (value.startsWith('workspace:')) return { kind: 'workspace', id: value.slice('workspace:'.length) }
  return { kind: 'none' }
}
export function targetSelectItems(targets: FriendExecutionTargets | null | undefined, t: (key: string) => string, current?: FriendTaskGrant['target']): Array<{ value: string; label: string }> {
  const items = [
    { value: 'none', label: t('friends_execution_target_none') },
    ...(targets?.projects ?? []).map(row => ({ value: 'project:' + row.root, label: `${t('friends_execution_target_project')} · ${row.name || row.root}` })),
    ...(targets?.workspaces ?? []).map(row => ({ value: 'workspace:' + row.id, label: `${t('friends_execution_target_workspace')} · ${row.name || row.id}` })),
  ]
  const value = targetSelectValue(current)
  if (!items.some(row => row.value === value) && current && current.kind !== 'none') items.push({ value, label: current.kind === 'project' ? current.root : current.id })
  return items
}

function PermissionRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className={`${settingsStyles['profile-account-row']} ${styles.permissionRow}`}><div className={settingsStyles['profile-account-row-copy']}><div className={settingsStyles['profile-account-row-title']}>{title}</div>{description && <div className={settingsStyles['profile-account-row-desc']}>{description}</div>}</div><div className={settingsStyles['profile-account-row-value']}>{children}</div></div>
}

export function ReceiveChoiceRow({ value, disabled, onChange }: { value: ReceiveChoice; disabled?: boolean; onChange: (value: ReceiveChoice) => void }) {
  const t = useT()
  return <PermissionRow title={t('friends_receive_choice')} description={t('friends_receive_choice_hint')}><KlsSelect className="kls-select" bindKey="friend-receive-choice" ariaLabel={t('friends_receive_choice')} value={value} disabled={disabled} items={GRANT_POLICIES.map(row => ({ value: row.id, label: t(row.label) }))} onChange={value => onChange(value as ReceiveChoice)} /></PermissionRow>
}

/** All permission surfaces edit a draft through this form; only their owner persists it. */
export function GrantEditor({ draft, apps, disabled, sharedRoot, targets, receiving, onReceivingChange, showPolicy = true, onPickDirectory, onChange }: {
  draft: FriendTaskGrant; apps: FriendAppsSnapshot | null; disabled: boolean; sharedRoot?: string | null;
  targets?: FriendExecutionTargets | null; receiving?: boolean; onReceivingChange?: (allowed: boolean) => void; showPolicy?: boolean;
  onPickDirectory: () => Promise<string | null>; onChange: (next: (value: FriendTaskGrant) => FriendTaskGrant) => void;
}) {
  const t = useT(), id = useId()
  const choice = receiveChoice(receiving ?? true, draft.policy)
  const scopeDisabled = disabled || showPolicy && choice === 'off'
  const pick = async () => {
    if (scopeDisabled) return
    const path = await onPickDirectory()
    if (path) onChange(value => value.directories.some(row => row.path === path) ? value : { ...value, directories: [...value.directories, { path, access: 'read' }] })
  }
  const unavailableApps = draft.apps.filter(appId => !apps?.apps.some(app => app.id === appId))
  return <div className={styles.permissionForm}>
    <div className={`${settingsStyles['profile-account-card']} ${styles.permissionCard}`}>
      {showPolicy && <ReceiveChoiceRow value={choice} disabled={disabled} onChange={value => {
        onReceivingChange?.(value !== 'off')
        onChange(current => ({ ...current, policy: value === 'off' ? onReceivingChange ? 'approve' : 'reject' : value }))
      }} />}
      <PermissionRow title={t('friends_execution_permission')} description={t('friends_execution_permission_hint')}>
        <KlsSelect className="kls-select" bindKey="grant-execution-permission" ariaLabel={t('friends_execution_permission')} value={friendExecutionPreset(draft.mode)} disabled={scopeDisabled}
          items={FRIEND_EXECUTION_PRESETS.map(preset => ({ value: preset, label: t(preset === 'bypassPermissions' ? 'perm_bypass' : preset === 'auto' ? 'perm_auto' : 'perm_manual') }))}
          onChange={value => onChange(current => ({ ...current, mode: friendGrantMode(value as FriendExecutionPreset) }))} />
      </PermissionRow>
      <PermissionRow title={t('friends_execution_target')} description={t('friends_execution_target_hint')}><KlsSelect className="kls-select" bindKey="grant-target" ariaLabel={t('friends_execution_target')} value={targetSelectValue(draft.target)} disabled={scopeDisabled} items={targetSelectItems(targets, t, draft.target)} onChange={value => onChange(current => ({ ...current, target: targetFromSelectValue(value) }))} /></PermissionRow>
      <PrefToggleRow id={`${id}-network`} label={t('friends_network')} desc={t('friends_network_hint')} checked={draft.network === true} disabled={scopeDisabled || apps?.taskCommands === false && draft.network !== true} onChange={network => onChange(value => ({ ...value, network }))} />
      <PrefToggleRow id={`${id}-computer`} label={t('friends_computer_use')} desc={t('friends_apps_hint')} checked={draft.computerUse} disabled={scopeDisabled || !!apps && !apps.available && !draft.computerUse} onChange={computerUse => onChange(value => ({ ...value, computerUse, apps: computerUse ? value.apps : [] }))} />
      {draft.computerUse && apps?.apps.map(app => <PrefToggleRow key={app.id} id={`${id}-${app.id}`} label={app.name} checked={draft.apps.includes(app.id)} disabled={scopeDisabled} onChange={checked => onChange(value => ({ ...value, apps: checked ? [...new Set([...value.apps, app.id])] : value.apps.filter(item => item !== app.id) }))} />)}
      {draft.computerUse && unavailableApps.map(appId => <PermissionRow key={appId} title={appId} description={t('friends_app_no_longer_available')}><button type="button" className="kls-btn kls-btn-ghost" disabled={scopeDisabled} onClick={() => onChange(value => ({ ...value, apps: value.apps.filter(row => row !== appId) }))}>{t('friends_remove')}</button></PermissionRow>)}
    </div>
    {!apps && <p className={styles.muted} role="status">{t('friends_apps_loading')}</p>}
    {apps && !apps.available && <p className={styles.formError} role="alert">{apps.error || t('friends_apps_unavailable')}</p>}
    {draft.computerUse && apps && !apps.apps.length && <p className={styles.muted}>{t('friends_no_apps')}</p>}
    {apps?.taskCommands === false && <p className={styles.muted}>{t('friends_commands_unavailable')}</p>}
    <div className={styles.sectionHeading}><h3>{t('friends_filesystem')}</h3><button type="button" className="kls-btn kls-btn-secondary" onClick={() => void pick()} disabled={scopeDisabled}><Icon name="plus" size={13} />{t('friends_add_directory')}</button></div>
    <div className={`${settingsStyles['profile-account-card']} ${styles.permissionCard}`}>
      {sharedRoot && <PermissionRow title={t('friends_shared_directory')} description={sharedRoot}><span className={styles.muted}>{t('friends_read_write')}</span></PermissionRow>}
      {draft.directories.map(row => <PermissionRow key={row.path} title={row.path}><KlsSelect className="kls-select" bindKey={`dir-access:${row.path}`} ariaLabel={`${t('friends_directory_access')} ${row.path}`} value={row.access} disabled={scopeDisabled} items={[{ value: 'read', label: t('friends_read_only') }, { value: 'write', label: t('friends_read_write') }]} onChange={access => onChange(value => ({ ...value, directories: value.directories.map(item => item.path === row.path ? { ...item, access: access as 'read' | 'write' } : item) }))} /><button type="button" disabled={scopeDisabled} className="kls-icon-btn" aria-label={t('friends_remove_directory')} onClick={() => onChange(value => ({ ...value, directories: value.directories.filter(item => item.path !== row.path) }))}><Icon name="close" size={14} /></button></PermissionRow>)}
      {!draft.directories.length && !sharedRoot && <p className={styles.muted}>{t('friends_no_directories')}</p>}
    </div>
    <p className={styles.boundary}>{t('friends_scope_boundary')}</p>
  </div>
}
