import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type {
  CollaborationExecution, CollaborationInvitationSettings, CollaborationMember, CollaborationOperationMap,
  CollaborationProject, CollaborationRequest, CollaborationResponse,
} from '../../../../contracts/team-collaboration'
import { t } from '../../i18n'
import { normalizeProjectRepositoryUrl, PROJECT_NAME_LIMIT, PROJECT_DESCRIPTION_LIMIT, type ProjectDraftPatch } from './project-model'

export type * from '../../../../contracts/team-collaboration'
export const COLLABORATION_REFRESH = 'klaus:team-collaboration-refresh'
export const COLLABORATION_HIDE = 'klaus:team-collaboration-hide'
export interface ProjectBoardProps {
  project: CollaborationProject
  members: CollaborationMember[]
  onProjectChanged: () => void
  searchTarget?: HTMLElement | null
  headerActionsTarget?: HTMLElement | null
}
export interface LocalBinding { projectId: string; localFolder: string | null }
export interface DraftAttachment { id: string; name: string; mimeType: string; size: number; base64: string }
export interface ProjectDraft { requestId: string; explanation: string; patch: ProjectDraftPatch }
export interface ProjectDraftOptions {
  requestId: string
  model?: string
  context?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  files?: Array<{ name: string; content: string }>
  current?: ProjectDraftPatch
  allowedCoverIds?: string[]
  allowedCoverIconIds?: string[]
  attachments?: DraftAttachment[]
}
export type CollaborationUpdate =
  | { kind: 'account'; accountId: string | null }
  | { kind: 'event'; accountId: string; projectId: string | null; event: unknown }
  | { kind: 'connection'; accountId: string; projectId: string; state: 'connected' | 'reconnecting' | 'forbidden'; error?: string }
  | { kind: 'execution'; accountId: string; projectId: string; executionId: string; syncPending: boolean }
export interface CollaborationBridge {
  request<R extends CollaborationRequest>(request: R): Promise<CollaborationResponse<R['type']>>
  localBinding(projectId: string): Promise<LocalBinding>
  setLocalBinding(projectId: string, localFolder: string | null): Promise<LocalBinding>
  pickLocalFolder(projectId: string): Promise<LocalBinding>
  draftProject(prompt: string, options: ProjectDraftOptions): Promise<ProjectDraft>
  cancelDraft(requestId: string): Promise<{ cancelled: boolean }>
  execute(options: { projectId: string; issueId: string; issueVersion: number; agentId: string; idempotencyKey: string; localFolderConfirmed: true; prompt?: string }): Promise<{ execution: CollaborationExecution; sessionId: string | null; turnId: string | null }>
  watch(projectId: string | null): Promise<{ watching: string | null }>
  onUpdated(handler: (event: CollaborationUpdate) => void): () => void
}
export function collaborationBridge(): CollaborationBridge {
  const bridge = (window as unknown as { klaus?: { teamCollaboration?: CollaborationBridge } }).klaus?.teamCollaboration
  if (!bridge) throw new Error(t('tc_bridge_unavailable'))
  return bridge
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
  return typeof error === 'string' ? error : t('tc_request_failed')
}
export async function request<K extends keyof CollaborationOperationMap>(input: { type: K } & CollaborationOperationMap[K]['request']): Promise<CollaborationOperationMap[K]['response']> {
  const result = await collaborationBridge().request(input as CollaborationRequest)
  if (result && typeof result === 'object' && 'error' in result) throw new Error(errorMessage(result.error))
  return result as CollaborationOperationMap[K]['response']
}
export const AccountContext = createContext<string | null>(null)
export const useAccountId = () => useContext(AccountContext)

export function useResource<T>(load: () => Promise<T>, dependencies: readonly unknown[] = [], projectId?: string) {
  const accountId = useAccountId()
  const [data, setData] = useState<T | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const loadRef = useRef(load)
  const generation = useRef(0)
  loadRef.current = load
  const refresh = useCallback(() => { generation.current++; setRevision(value => value + 1) }, [])
  useEffect(() => {
    let current = true
    const sequence = ++generation.current
    const valid = () => current && sequence === generation.current
    setPending(true)
    setError('')
    void Promise.resolve().then(() => loadRef.current()).then(value => { if (valid()) setData(value) }).catch(cause => {
      if (valid()) {
        const fault = cause as { status?: number; code?: string } | null
        if ([401, 403, 404].includes(fault?.status || 0) || /not_authenticated|account_changed|forbidden|membership_required|not_found|\b(?:401|403|404)\b/i.test(`${fault?.code || ''} ${errorMessage(cause)}`)) setData(null)
        setError(errorMessage(cause))
      }
    }).finally(() => { if (valid()) setPending(false) })
    return () => { current = false }
  }, [accountId, revision, ...dependencies])
  useEffect(() => {
    const reload = () => refresh()
    window.addEventListener(COLLABORATION_REFRESH, reload)
    window.addEventListener('online', reload)
    const offline = () => setError(t('tc_offline'))
    window.addEventListener('offline', offline)
    let unsubscribe: (() => void) | undefined, updateTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => { clearTimeout(updateTimer); updateTimer = setTimeout(refresh, 50) }
    try {
      unsubscribe = collaborationBridge().onUpdated(event => {
        if (event.kind !== 'account' && event.accountId === accountId && (!projectId || event.projectId === projectId)) {
          if (event.kind === 'connection' && event.state !== 'connected') {
            if (event.state === 'forbidden') { clearTimeout(updateTimer); generation.current++; setData(null); setPending(false) }
            setError(event.error || t(event.state === 'forbidden' ? 'tc_no_permission' : 'tc_reconnecting'))
          } else scheduleRefresh()
        }
      })
    } catch (cause) { setError(errorMessage(cause)) }
    return () => { clearTimeout(updateTimer); unsubscribe?.(); window.removeEventListener(COLLABORATION_REFRESH, reload); window.removeEventListener('online', reload); window.removeEventListener('offline', offline) }
  }, [accountId, projectId, refresh])
  return { data, pending, error, refresh }
}

export function useMutation() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const running = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const run = useCallback(async <T,>(operation: () => Promise<T>, onSuccess?: (value: T) => void): Promise<T | undefined> => {
    if (running.current) return undefined
    running.current = true
    setPending(true); setError('')
    try {
      const value = await operation()
      if (alive.current) onSuccess?.(value)
      return alive.current ? value : undefined
    } catch (cause) { if (alive.current) setError(errorMessage(cause)); return undefined }
    finally { running.current = false; if (alive.current) setPending(false) }
  }, [])
  return { pending, error, setError, run }
}

export async function allPages<T>(load: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = []
  const visited = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await load(cursor)
    items.push(...page.items)
    cursor = page.nextCursor || undefined
    if (cursor && visited.has(cursor)) throw new Error(t('tc_request_failed'))
    if (cursor) visited.add(cursor)
  } while (cursor)
  return items
}

export const COVER_COLORS = ['Aurora', 'Reef', 'Ember', 'Violet', 'Cobalt', 'Moss'] as const
export const COVER_PALETTE: Record<typeof COVER_COLORS[number], string> = { Aurora: '#8877d9', Reef: '#54b8af', Ember: '#dc8b6a', Violet: '#a67ac7', Cobalt: '#678ede', Moss: '#8dac72' }
export function coverName(color: string): typeof COVER_COLORS[number] { return COVER_COLORS.find(name => name.toLowerCase() === color.toLowerCase() || COVER_PALETTE[name].toLowerCase() === color.toLowerCase()) || 'Aurora' }
export function canManageProject(project: CollaborationProject): boolean { return project.role === 'owner' || project.role === 'admin' }
export function canChangeMember(project: CollaborationProject, member: CollaborationMember, members: CollaborationMember[]): boolean {
  if (project.role !== 'owner') return false
  if (member.role === 'owner') return members.filter(item => item.role === 'owner').length > 1
  return true
}
export function projectMemberRemovalAction(project: CollaborationProject, member: CollaborationMember, accountId: string | null): 'leave' | 'remove' | null {
  if (!accountId || member.role === 'owner') return null
  if (member.kind === 'human' && member.userId === accountId) return 'leave'
  return project.role === 'owner' ? 'remove' : null
}
export function canCreateProjectInvitation(project: CollaborationProject, settings: CollaborationInvitationSettings | null): boolean {
  return !project.archivedAt && !!settings?.canManage && settings.enabled
}
export async function updateProjectInvitationAccess(projectId: string, settings: CollaborationInvitationSettings, enabled: boolean): Promise<CollaborationInvitationSettings> {
  if (!settings.canManage) throw new Error(t('tc_no_permission'))
  return request({ type: 'project-invitation-settings.update', projectId, version: settings.version, enabled })
}
export function projectInputError(input: { name: string; identifier: string; description?: string; repositoryUrl?: string | null }): string | null {
  if (!input.name.trim() || input.name.trim().length > PROJECT_NAME_LIMIT) return 'tc_invalid_name'
  if ('description' in input && typeof input.description === 'string' && input.description.length > PROJECT_DESCRIPTION_LIMIT) return 'tc_invalid_description'
  if (!/^[A-Z]{3}$/.test(input.identifier)) return 'tc_invalid_identifier'
  if (input.repositoryUrl && !normalizeProjectRepositoryUrl(input.repositoryUrl)) return 'tc_invalid_repository'
  return null
}

export interface CollaborationRoute { projectId: string | null; archived: boolean; inviteToken: string | null }
const ROUTE_KEYS = ['tcProject', 'tcIssue', 'tcArchived', 'tcInvite', 'tcSearch', 'tcView'] as const
export function readRoute(hash: string): CollaborationRoute {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  return { projectId: params.get('tcProject'), archived: params.get('tcArchived') === '1', inviteToken: params.get('tcInvite') }
}
export function routeHash(hash: string, route: CollaborationRoute): string {
  const preserved = hash.replace(/^#/, '').split('&').filter(part => part && !ROUTE_KEYS.some(key => part.split('=')[0] === key))
  if (route.projectId) preserved.push(`tcProject=${encodeURIComponent(route.projectId)}`)
  if (route.archived) preserved.push('tcArchived=1')
  if (route.inviteToken) preserved.push(`tcInvite=${encodeURIComponent(route.inviteToken)}`)
  return preserved.length ? `#${preserved.join('&')}` : ''
}
export function useCollaborationRoute() {
  const [route, setRoute] = useState(() => readRoute(window.location.hash))
  useEffect(() => {
    const update = () => setRoute(readRoute(window.location.hash))
    window.addEventListener('hashchange', update); window.addEventListener('popstate', update)
    return () => { window.removeEventListener('hashchange', update); window.removeEventListener('popstate', update) }
  }, [])
  const navigate = useCallback((next: CollaborationRoute, replace = false) => {
    window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', `${window.location.pathname}${window.location.search}${routeHash(window.location.hash, next)}`)
    setRoute(next)
  }, [])
  return { route, navigate }
}
