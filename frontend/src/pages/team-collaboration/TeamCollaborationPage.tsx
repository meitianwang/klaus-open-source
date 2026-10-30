import { useEffect, useState } from 'react'
import { AccountContext, COLLABORATION_HIDE, COLLABORATION_REFRESH, canManageProject, collaborationBridge, errorMessage, request, useCollaborationRoute, useResource, type CollaborationProject } from './data'
import { ErrorNotice, Icon, Loading, MemberAvatars, Popover } from './primitives'
import { ProjectsList } from './project-list'
import { ProjectDescription } from './project-description'
import { ProjectActionModal, ProjectSettingsModal, type ProjectAction } from './project-settings'
import { InvitationPreview, InvitationsModal, MembersModal } from './member-management'
import { ProjectBoard } from './ProjectBoard'
import { useT } from './i18n'
import { startGuestSignin } from '../../chat/sidebar/guest-signin'
import styles from './team-collaboration.module.css'

type AuthState = { accountId: string | null; epoch: number }
interface AuthBridge {
  klausAuth: { status(): Promise<{ loggedIn: boolean; user?: { id?: string | number } }> }
  on?: { klausAuthUpdated?(handler: () => void): () => void }
}
export function TeamCollaborationPage() {
  const t = useT()
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const show = () => { setVisible(true); setReload(value => value + 1) }
    const hide = () => setVisible(false)
    const settings = (event: Event) => setVisible(!(event as CustomEvent<{ open: boolean }>).detail.open && !!document.getElementById('team-collaboration-view')?.classList.contains('active'))
    window.addEventListener(COLLABORATION_REFRESH, show); window.addEventListener(COLLABORATION_HIDE, hide)
    window.addEventListener('klaus:settings-visibility-change', settings)
    return () => { window.removeEventListener(COLLABORATION_REFRESH, show); window.removeEventListener(COLLABORATION_HIDE, hide); window.removeEventListener('klaus:settings-visibility-change', settings) }
  }, [])
  useEffect(() => {
    let current = true, generation = 0
    const api = window.klaus as unknown as AuthBridge
    const refresh = () => {
      const revision = ++generation
      setAuth(null); setError('')
      void Promise.resolve().then(() => {
        if (!api?.klausAuth?.status) throw new Error(t('auth_status_unavailable'))
        return api.klausAuth.status()
      }).then(status => {
        if (!current || revision !== generation) return
        if (typeof status.loggedIn !== 'boolean' || status.loggedIn && !status.user?.id) throw new Error(t('auth_status_unavailable'))
        setAuth({ accountId: status.loggedIn ? String(status.user!.id) : null, epoch: revision })
      }).catch(cause => { if (current && revision === generation) setError(errorMessage(cause)) })
    }
    refresh()
    const offAuth = api?.on?.klausAuthUpdated?.(refresh)
    let offCollaboration: (() => void) | undefined
    try { offCollaboration = collaborationBridge().onUpdated(event => { if (event.kind === 'account') refresh() }) } catch { /* The signed-in page surfaces the missing host interface. */ }
    return () => { current = false; generation++; offAuth?.(); offCollaboration?.() }
  }, [reload])
  if (!visible) return null
  return <div className={styles.page}><div className={styles.pageInner}>
    {!auth && !error && <Loading />}
    <ErrorNotice error={error} onRetry={() => setReload(value => value + 1)} />
    {auth && (auth.accountId ? <AccountContext.Provider value={auth.accountId}><ProjectsContent key={`${auth.accountId}:${auth.epoch}`} /></AccountContext.Provider> : <div className={styles.emptyState}><Icon name="tc-team" size={48} /><h1>{t('tc_guest_title')}</h1><p>{t('tc_guest_body')}</p><button type="button" className={styles.primaryButton} onClick={() => {
      void startGuestSignin()
    }}>{t('tc_login')}</button></div>)}
  </div></div>
}

function ProjectsContent() {
  const { route, navigate } = useCollaborationRoute()
  const openProject = (project: CollaborationProject) => navigate({ ...route, projectId: project.id, archived: !!project.archivedAt, inviteToken: null })
  return <>{route.projectId ? <ProjectWorkspace key={route.projectId} projectId={route.projectId} onBack={() => navigate({ ...route, projectId: null, inviteToken: null })} /> : <ProjectsList route={route} onNavigate={navigate} onOpen={openProject} />}
    {route.inviteToken && <InvitationPreview key={route.inviteToken} token={route.inviteToken} onJoined={openProject} onClose={() => navigate({ ...route, inviteToken: null })} />}
  </>
}

export function ProjectWorkspace({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const t = useT()
  const result = useResource(async () => {
    const [project, members] = await Promise.all([request({ type: 'projects.get', projectId }), request({ type: 'project-members.list', projectId })])
    return { project, members }
  }, [projectId], projectId)
  const [dialog, setDialog] = useState<'settings' | 'members' | 'invite' | ProjectAction | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [searchTarget, setSearchTarget] = useState<HTMLDivElement | null>(null)
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    let active = true
    try { void collaborationBridge().watch(projectId).catch(error => { if (active) setConnectionError(errorMessage(error)) }) }
    catch (error) { setConnectionError(errorMessage(error)) }
    return () => { active = false; try { void collaborationBridge().watch(null).catch(() => {}) } catch { /* The visible load error already reports an unavailable host. */ } }
  }, [projectId])
  const changed = () => { setDialog(null); result.refresh() }
  const project = result.data?.project, members = result.data?.members || []
  return <div className={styles.workspace}>
    <div className={styles.breadcrumb}><button type="button" onClick={onBack}>{t('tc_nav')}</button><span>/</span><span>{project?.name || t('tc_loading')}</span>
      {project && <><Popover label={t('tc_more')} trigger={<Icon name="tc-more" size={20} />}>{close => <><button type="button" role="menuitem" onClick={() => { close(); setDialog('settings') }}>{t('tc_settings')}</button><button type="button" role="menuitem" onClick={() => { close(); setDialog('members') }}>{t('tc_members')}</button>{canManageProject(project) && <button type="button" role="menuitem" onClick={() => { close(); setDialog(project.archivedAt ? 'restore' : 'archive') }}>{t(project.archivedAt ? 'tc_restore' : 'tc_archive')}</button>}{project.archivedAt && project.role === 'owner' && <button type="button" role="menuitem" className={styles.textDanger} onClick={() => { close(); setDialog('delete') }}>{t('tc_delete')}</button>}</>}</Popover></>}
    </div>
    <ErrorNotice error={result.error || connectionError} onRetry={() => { setConnectionError(''); result.refresh() }} />
    {result.pending && !project && <Loading />}
    {project && <><header className={styles.projectHeading}><div className={styles.projectTitle}><h1>{project.name}</h1><ProjectDescription project={project} onChanged={result.refresh} /></div><div className={styles.projectHeaderActions}><button type="button" aria-label={t('tc_members')} className={styles.avatarButton} onClick={() => setDialog('members')}><MemberAvatars members={members} total={project.memberCount} /></button><div ref={setSearchTarget} className={styles.boardSearchTarget} />{project.role === 'owner' && <button type="button" onClick={() => setDialog('invite')}><Icon name="tc-team" size={16} />{t(project.archivedAt ? 'tc_invite_links' : 'tc_invite')}</button>}<div ref={setHeaderActionsTarget} /></div></header>{project.archivedAt && <p className={styles.archivedNotice}>{t('tc_project_archived_notice')}</p>}
      <ProjectBoard project={project} members={members} onProjectChanged={result.refresh} searchTarget={searchTarget} headerActionsTarget={headerActionsTarget} />
      {dialog === 'settings' && <ProjectSettingsModal project={project} onClose={() => setDialog(null)} onChanged={changed} />}
      {dialog === 'members' && <MembersModal project={project} onClose={() => setDialog(null)} onChanged={result.refresh} onLeft={onBack} onInvite={() => setDialog('invite')} />}
      {dialog === 'invite' && <InvitationsModal project={project} onClose={() => setDialog(null)} onManageSettings={() => setDialog('members')} />}
      {(dialog === 'archive' || dialog === 'restore' || dialog === 'delete') && <ProjectActionModal project={project} action={dialog} onClose={() => setDialog(null)} onChanged={() => { setDialog(null); onBack() }} />}
    </>}
  </div>
}
