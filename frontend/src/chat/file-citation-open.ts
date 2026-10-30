// The one open path for a file citation chip, wherever the chip was clicked.
//
// Two surfaces render citations: the transcript body (whose click delegate
// owns its container) and every other markdown surface in the window (composer
// follow-up previews, plan review documents), which a document-level catch-all
// covers. Both must resolve a relative citation against the session's workdir
// the same way, so the resolution lives here once.
export function openFileCitation(rawPath: string, line: number | undefined, sessionId: string): void {
  const w = window as any
  const location = Number.isFinite(line) && (line ?? 0) > 0 ? { line: Math.floor(line as number) } : undefined
  const open = (path: string): void => { w.klausOpenWorkspaceFilePath?.(path, location) }
  if (!rawPath) return
  if (/^(?:[/\\]|[a-zA-Z]:[\\/]|\\\\)/.test(rawPath)) { open(rawPath); return }
  const workdir = w.klaus?.session?.getResolvedWorkdir?.(sessionId) as Promise<{ workdir?: string | null } | null> | undefined
  if (!workdir) { open(rawPath); return }
  void workdir
    .then((data: { workdir?: string | null } | null) => {
      const cwd = data?.workdir || ''
      open(cwd ? `${cwd.replace(/[/\\]+$/, '')}/${rawPath.replace(/^\.?\//, '')}` : rawPath)
    })
    .catch(() => open(rawPath))
}

/** Read a citation chip's data attributes into an open call. */
export function openFileCitationFromElement(chip: HTMLElement): void {
  openFileCitation(chip.dataset.filePath || '', Number(chip.dataset.fileLine || ''), chip.dataset.fileSession || (window as any).currentSessionId || '')
}
