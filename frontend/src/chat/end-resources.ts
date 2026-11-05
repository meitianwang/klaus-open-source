// Renderer side of turn-end resources: one projection per turn, published per
// conversation so the transcript cards, the overview panel and the turn
// navigation preview read the same list.

import { endResources, isUrlTarget, type EndResource } from '../../../contracts/end-resources'
import type { EndResourceTargets, EndResourcePageMeta } from '../../../contracts/end-resource-open'
import type { SiteOpenTargets } from '../../../contracts/browser-sites'
import { t } from '../i18n'

export type { EndResource } from '../../../contracts/end-resources'

export interface TurnEndResources {
  turnId: string
  resources: EndResource[]
}

const w = (): any => window as any

/** The conversation's working directory, for resolving relative citations. */
export function sessionWorkdir(sessionId: string): string | null {
  const info = w().getKnownSessionInfo?.(sessionId)
  return typeof info?.workdir === 'string' && info.workdir ? info.workdir : null
}

/** One turn's resources. `editedPaths` comes from the engine's own file-change record. */
export function turnEndResources(input: { sessionId: string; status: string | undefined; finalText: string | null | undefined; editedPaths: readonly string[] }): EndResource[] {
  return endResources({
    complete: input.status === 'completed' || input.status === 'failed',
    finalText: input.finalText,
    editedPaths: input.editedPaths,
    cwd: sessionWorkdir(input.sessionId),
  })
}

// ---- per-conversation publication (overview panel, turn navigation) ----

const sessions = new Map<string, readonly TurnEndResources[]>()
const listeners = new Set<() => void>()
const empty: readonly TurnEndResources[] = Object.freeze([])

export function publishEndResources(sessionId: string, turns: readonly TurnEndResources[]): void {
  const next = turns.filter(turn => turn.resources.length > 0)
  if (JSON.stringify(sessions.get(sessionId) ?? empty) === JSON.stringify(next)) return
  sessions.set(sessionId, next)
  for (const listener of listeners) listener()
}
export function endResourcesForSession(sessionId: string): readonly TurnEndResources[] { return sessions.get(sessionId) ?? empty }
export function retireEndResources(sessionId: string): void {
  if (!sessions.delete(sessionId)) return
  for (const listener of listeners) listener()
}
export function subscribeEndResources(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// ---- host calls ----

function api(): any { return w().klaus?.endResources }

export async function endResourceTargets(sessionId: string, resource: EndResource): Promise<EndResourceTargets> {
  const request = resource.type === 'file'
    ? { sessionId, filePath: resource.path }
    : isUrlTarget(resource.target) ? { sessionId, url: resource.target } : { sessionId, filePath: resource.target }
  const result = await api()?.targets?.(request)
  if (!result || !Array.isArray(result.apps)) throw new Error(t('end_resource_open_failed'))
  return result
}

export async function existingEndResourceFiles(sessionId: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const result = await api()?.existing?.(sessionId, [...paths])
  return new Set(Array.isArray(result?.existing) ? result.existing : [])
}

export async function endResourcePageMeta(sessionId: string, filePath: string): Promise<EndResourcePageMeta | null> {
  try {
    const result = await api()?.pageMeta?.(sessionId, filePath)
    return result && typeof result === 'object' && !('error' in result) ? result : null
  } catch { return null }
}

function toastFailure(): void { w().showToast?.(t('end_resource_open_failed')) }

/** Open a resource in a listed application. */
export async function openEndResourceInApp(sessionId: string, resource: EndResource, appPath: string): Promise<void> {
  try {
    const request = resource.type === 'file'
      ? { sessionId, filePath: resource.path, appPath }
      : isUrlTarget(resource.target) ? { sessionId, url: resource.target, appPath } : { sessionId, filePath: resource.target, appPath }
    const result = await api()?.open?.(request)
    if (result?.ok !== true) toastFailure()
  } catch { toastFailure() }
}

export async function revealEndResource(sessionId: string, path: string): Promise<void> {
  try {
    const result = await api()?.reveal?.(sessionId, path)
    if (result?.ok !== true) toastFailure()
  } catch { toastFailure() }
}

export async function downloadEndResourceCopy(sessionId: string, path: string): Promise<void> {
  try {
    const result = await api()?.downloadCopy?.(sessionId, path)
    w().showToast?.(result?.ok === true ? t('end_resource_download_success') : t('end_resource_download_failure'))
  } catch { w().showToast?.(t('end_resource_download_failure')) }
}

/** Open a file resource in the work panel's preview, the same surface a citation opens. */
export function openEndResourceFile(path: string): void {
  w().klausOpenWorkspaceFilePath?.(path)
}

/** The browser that opens this local URL when the user clicks the row. */
export async function localSiteTargets(): Promise<SiteOpenTargets | null> {
  try {
    const result = await w().klaus?.browser?.siteOpenTargets?.()
    return Array.isArray(result?.targets) ? result : null
  } catch { return null }
}
