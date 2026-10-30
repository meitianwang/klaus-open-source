export interface WorktreeConversation {
  id: string; workdir?: string; workspaceId?: string; projectRoot?: string
  parentSessionId?: string; parentThreadId?: string; ephemeral?: boolean
  sidebarPinnedAt?: number; pinned?: boolean; isWorking?: boolean; updatedAt?: number
  title?: string; name?: string
}

export function worktreeContains(root: string, path: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[A-Za-z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized
  }
  const base = normalize(root), target = normalize(path)
  return target === base || target.startsWith(`${base}/`)
}

export function worktreePinned(row: WorktreeConversation): boolean {
  return row.pinned === true || Number(row.sidebarPinnedAt) > 0
}

export function worktreeConversations(path: string, rows: WorktreeConversation[]): WorktreeConversation[] {
  return rows.filter(row => !!row.workdir && worktreeContains(path, row.workdir) && !row.ephemeral
    && (worktreePinned(row) || !(row.parentSessionId || row.parentThreadId)))
}

export function worktreeSource(rows: WorktreeConversation[]): WorktreeConversation | undefined {
  return rows.find(worktreePinned) ?? rows[0]
}
