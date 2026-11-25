export interface WorkspaceChangeItem { kind?: string; path?: string; isDir?: boolean }
export interface WorkspaceChangeNotification { type?: string; sessionId?: string; events?: WorkspaceChangeItem[] }

export function normalizeWorkspacePath(path: unknown) {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function workspacePathTouchesPath(changedPath: unknown, targetPath: unknown) {
  const changed = normalizeWorkspacePath(changedPath)
  const target = normalizeWorkspacePath(targetPath)
  return !!changed && !!target && (changed === target || changed.startsWith(target + '/') || target.startsWith(changed + '/'))
}

export function workspaceEventTouchesAnyPath(event: WorkspaceChangeNotification, targets: readonly string[]) {
  return targets.map(normalizeWorkspacePath).filter(Boolean).some(target => !event.events?.length || event.events.some(item => workspacePathTouchesPath(item.path, target)))
}

export function shouldReloadWorkspaceFileOnChange(event: WorkspaceChangeNotification, targets: readonly string[], isRecentSelfWrite: (path: string) => boolean) {
  const normalizedTargets = targets.map(normalizeWorkspacePath).filter(Boolean)
  if (!normalizedTargets.length) return false
  if (event.type === 'workspace:invalidated') return true
  return event.type === 'workspace:changed' && workspaceEventTouchesAnyPath(event, normalizedTargets)
    && !normalizedTargets.some(isRecentSelfWrite)
}

export function shouldReloadWorkspaceMediaOnChange(event: WorkspaceChangeNotification, targets: readonly string[]) {
  return event.type === 'workspace:changed' && !!event.events?.some(item => {
    const changed = normalizeWorkspacePath(item.path)
    return !!changed && targets.some(path => {
      const target = normalizeWorkspacePath(path)
      return !!target && (changed === target || changed.startsWith(target + '/')
        || (target.startsWith(changed + '/') && (item.kind === 'unlink' || item.kind === 'delete' || item.isDir !== true)))
    })
  })
}
