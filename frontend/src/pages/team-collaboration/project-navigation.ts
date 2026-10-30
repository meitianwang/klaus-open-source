const projectRouteKeys = ['tcProject', 'tcIssue', 'tcArchived', 'tcInvite', 'tcSearch', 'tcView'] as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function teamIssueRouteHash(hash: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || !('projectId' in payload) || !('issueId' in payload)) return null
  if (typeof payload.projectId !== 'string' || typeof payload.issueId !== 'string' || !uuid.test(payload.projectId) || !uuid.test(payload.issueId)) return null
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  for (const key of projectRouteKeys) params.delete(key)
  params.set('tcProject', payload.projectId.toLowerCase())
  params.set('tcIssue', payload.issueId.toLowerCase())
  return `#${params}`
}

export function restoreCollaborationRoute(): void {
  const params = new URLSearchParams(window.location.hash.slice(1))
  if (['tcProject', 'tcArchived', 'tcInvite', 'tcSearch', 'tcView'].some(key => params.has(key))) {
    document.getElementById('btn-team-collaboration')?.click()
  }
}

export function openTeamIssueDeepLink(payload: unknown): boolean {
  const hash = teamIssueRouteHash(window.location.hash, payload)
  if (!hash) {
    console.warn('[collaboration] invalid Issue deep-link payload')
    return false
  }
  const oldURL = window.location.href
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`)
  // replaceState emits no event; notify mounted routes and reopen even an identical link.
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }))
  return true
}
