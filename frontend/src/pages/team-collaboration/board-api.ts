import { useEffect, useState } from 'react'
import type { CollaborationFileScope, CollaborationPage, CollaborationRequest } from '../../../../contracts/team-collaboration'
import type { CollaborationUpdate, DesktopCollaborationResponse, DraftOptions, ExecuteOptions, ExecutionReply, IssueDraft, IssueDraftOptions, ProjectDraft } from '../../../../main/services/team-collaboration/types'
import type { LocalCollaborationAgent } from '../../../../main/services/team-collaboration/agents'
import type { FilePreview } from '../../../../main/services/team-collaboration/files'
import { isConflict } from './board-model'
import type { BoardT } from './board-i18n'

export type BoardUpdate = CollaborationUpdate
interface LocalBinding { projectId: string; localFolder: string | null }
export interface BoardBridge {
  request<R extends CollaborationRequest>(request: R): Promise<DesktopCollaborationResponse<R['type']>>;
  onUpdated(handler: (event: BoardUpdate) => void): () => void;
  watch(projectId: string | null): Promise<{ watching: string | null }>;
  localBinding(projectId: string): Promise<LocalBinding>;
  pickLocalFolder(projectId: string): Promise<LocalBinding>;
  execute(options: ExecuteOptions): Promise<ExecutionReply>;
  draftProject(prompt: string, options: DraftOptions): Promise<ProjectDraft>;
  draftIssue(prompt: string, options: IssueDraftOptions): Promise<IssueDraft>;
  cancelDraft(requestId: string): Promise<{ cancelled: boolean }>;
  downloadFile(scope: CollaborationFileScope, fileId: string): Promise<{ saved: boolean; name: string }>;
  previewFile(scope: CollaborationFileScope, fileId: string): Promise<FilePreview>;
  localAgents(): Promise<LocalCollaborationAgent[]>;
  issueLink(projectId: string, issueId: string): string;
}
export function boardBridge(): BoardBridge {
  const bridge = (window as unknown as { klaus?: { teamCollaboration?: BoardBridge } }).klaus?.teamCollaboration
  if (!bridge) throw new Error('Team collaboration bridge is unavailable')
  return bridge
}
export function boardRequest<R extends CollaborationRequest>(request: R): Promise<DesktopCollaborationResponse<R['type']>> {
  return boardBridge().request(request)
}
export async function allPages<T>(load: (cursor?: string) => Promise<CollaborationPage<T>>): Promise<T[]> {
  const rows: T[] = [], seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await load(cursor)
    rows.push(...page.items)
    if (!page.nextCursor) return rows
    if (seen.has(page.nextCursor)) throw new Error('The server returned a repeated pagination cursor')
    seen.add(page.nextCursor)
    cursor = page.nextCursor
  } while (cursor)
  return rows
}
export function errorText(error: unknown, t: BoardT): string {
  if (isConflict(error)) return t('conflict')
  return error instanceof Error ? error.message : typeof error === 'string' ? error : t('error')
}
export function useBoardIdentity(): { userId: string | null; ready: boolean } {
  const [state, setState] = useState<{ userId: string | null; ready: boolean }>({ userId: null, ready: false })
  useEffect(() => {
    let alive = true, generation = 0
    const auth = (window as unknown as { klaus?: { klausAuth?: { status(): Promise<{ loggedIn?: boolean; user?: { id?: string | number } }> } } }).klaus?.klausAuth
    const refresh = () => {
      const requestId = ++generation
      void auth?.status().then(result => {
        if (alive && requestId === generation) setState({ userId: result.loggedIn && result.user?.id != null ? String(result.user.id) : null, ready: true })
      }).catch(() => { if (alive && requestId === generation) setState({ userId: null, ready: true }) })
    }
    refresh()
    if (!auth) setState({ userId: null, ready: true })
    let unsubscribe: (() => void) | undefined
    try { unsubscribe = boardBridge().onUpdated(event => { if (event.kind === 'account') { setState({ userId: null, ready: false }); refresh() } }) } catch { /* The parent presents the unavailable bridge error. */ }
    return () => { alive = false; unsubscribe?.() }
  }, [])
  return state
}
export async function openExecutionChat(sessionId: string): Promise<void> {
  const navigation = window as unknown as { klausSwitchSession?: (id: string) => void | Promise<void>; switchSession?: (id: string) => void | Promise<void> }
  const open = navigation.klausSwitchSession || navigation.switchSession
  if (!open) throw new Error('Chat navigation is unavailable')
  await open(sessionId)
}
