import { OFFICE_PREVIEW_EXTENSIONS, extOfPath } from '../../../contracts/office-preview'
import { preferredDesignPanelWidth } from './design-panel'
import type { TurnEndResources } from './end-resources'

export function pathWithinDirectory(directory: string, targetPath: string): boolean {
  const cleanDir = directory.replace(/[\\/]+$/, '')
  if (!cleanDir) return false
  return targetPath === cleanDir || targetPath.startsWith(`${cleanDir}/`) || targetPath.startsWith(`${cleanDir}\\`)
}

export function fileBelongsToSession(input: {
  sessionId: string
  filePath: string
  roots?: readonly string[]
  hasOpenTab?: boolean
  hasArtifact?: boolean
  hasEndResource?: boolean
  hasTranscriptCitation?: boolean
}): boolean {
  const { sessionId, filePath } = input
  if (!sessionId || !filePath) return false
  if (input.hasOpenTab) return true
  if ((input.roots ?? []).some(root => Boolean(root) && pathWithinDirectory(root, filePath))) return true
  if (input.hasArtifact) return true
  if (input.hasEndResource) return true
  if (input.hasTranscriptCitation) return true
  const slashPath = filePath.replace(/\\/g, '/')
  return slashPath.includes(`/.klaus/visualizations/${sessionId}/`)
}

export function shouldWidenPanelForOpenedFiles(files: readonly string[]): boolean {
  return files.some(path => OFFICE_PREVIEW_EXTENSIONS.has(extOfPath(path)))
}

export interface SystemOpenFilesDeps {
  currentSessionId: () => string | null
  inChatView: () => boolean
  findSession: (id: string) => { archived?: boolean; sshHostId?: string | null } | null
  sessionWorkdir: (id: string) => string | null
  workspaceRootFor: (id: string) => string
  hasOpenWorkspaceTabs: (id: string, paths: readonly string[]) => boolean
  sessionHasArtifactPath: (id: string, path: string) => boolean
  endResourcesForSession: (id: string) => readonly TurnEndResources[]
  draftProjectWorkdir: () => string | null
  newProjectlessChat: () => void
  ensureSession: () => Promise<string | null>
  attachFiles: (files: readonly string[]) => void
  widenOfficePanel: (calc: (currentWidth: number, workspaceWidth: number) => number | null) => void
  openFile: (path: string) => void
}

export function resolveSystemFileOpenSessionReuse(
  files: readonly string[],
  deps: Pick<
    SystemOpenFilesDeps,
    | 'currentSessionId'
    | 'inChatView'
    | 'findSession'
    | 'sessionWorkdir'
    | 'workspaceRootFor'
    | 'hasOpenWorkspaceTabs'
    | 'sessionHasArtifactPath'
    | 'endResourcesForSession'
  >,
): { reuse: boolean; alreadyOpenTabs: boolean } {
  const activeId = deps.currentSessionId()
  const inChatView = deps.inChatView()
  const known = activeId ? deps.findSession(activeId) : null
  if (!inChatView || !activeId || known?.archived || known?.sshHostId || files.length === 0) {
    return { reuse: false, alreadyOpenTabs: false }
  }
  const alreadyOpenTabs = deps.hasOpenWorkspaceTabs(activeId, files)
  if (alreadyOpenTabs) return { reuse: true, alreadyOpenTabs: true }
  const roots = [deps.workspaceRootFor(activeId), deps.sessionWorkdir(activeId) || ''].filter(Boolean)
  const citedPaths = new Set<string>()
  if (typeof document !== 'undefined') {
    for (const chip of document.querySelectorAll<HTMLElement>('#messages .md-file-citation[data-file-path]')) {
      const value = chip.getAttribute('data-file-path')
      if (value) citedPaths.add(value)
    }
  }
  const resources = deps.endResourcesForSession(activeId)
  const reuse = files.every(filePath => fileBelongsToSession({
    sessionId: activeId,
    filePath,
    roots,
    hasOpenTab: deps.hasOpenWorkspaceTabs(activeId, [filePath]),
    hasArtifact: deps.sessionHasArtifactPath(activeId, filePath),
    hasEndResource: resources.some(turn =>
      turn.resources.some(resource => (resource.type === 'file' ? resource.path : resource.target) === filePath),
    ),
    hasTranscriptCitation: citedPaths.has(filePath),
  }))
  return { reuse, alreadyOpenTabs: false }
}

export async function handleSystemOpenFiles(
  payload: { files?: string[] } | undefined,
  deps: SystemOpenFilesDeps,
): Promise<void> {
  const files = [...new Set((payload?.files ?? []).filter(path => typeof path === 'string' && path.trim()))]
  if (!files.length) return
  if (typeof window !== 'undefined') (window as any).KlausPanelTabs?.setMaximized?.(false)
  const activeId = deps.currentSessionId()
  const inChatView = deps.inChatView()
  const { reuse, alreadyOpenTabs } = resolveSystemFileOpenSessionReuse(files, deps)
  if (!reuse) {
    if (activeId || deps.draftProjectWorkdir() || !inChatView) deps.newProjectlessChat()
    const sessionId = await deps.ensureSession()
    if (!sessionId || deps.currentSessionId() !== sessionId) return
    deps.attachFiles(files)
    if (shouldWidenPanelForOpenedFiles(files)) {
      deps.widenOfficePanel(preferredDesignPanelWidth)
    }
  }
  for (const path of alreadyOpenTabs ? files.slice(-1) : files) deps.openFile(path)
}
