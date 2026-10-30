import { marked } from 'marked'
import { t } from '../i18n'
import type { SiteOpenTargetId, SiteOpenTargets } from '../../../contracts/browser-sites'
export type { SiteOpenTarget } from '../../../contracts/browser-sites'

export interface SiteReference { id: string; url: string; title: string; turnId: string }
const sessions = new Map<string, readonly SiteReference[]>()
const listeners = new Set<() => void>()
const empty: readonly SiteReference[] = Object.freeze([])
const projections = new WeakMap<object, { text: string; turnId: string; references: SiteReference[] }>()

/** Unchanged message objects share extraction work without retaining their text globally. */
export function websiteReferencesForItem(item: object, text: string, turnId: string): SiteReference[] {
  const cached = projections.get(item)
  if (cached?.text === text && cached.turnId === turnId) return cached.references
  const references = websiteReferencesFromText(text, turnId)
  projections.set(item, { text, turnId, references })
  return references
}

/** Web links in assistant prose are resources. Code and image tokens are not. */
export function websiteReferencesFromText(text: string, turnId: string): SiteReference[] {
  // Escapes and entities can encode URL punctuation. Keep them on the full parser path.
  if (!/[:&\\]|www\./i.test(text)) return []
  const references = new Map<string, SiteReference>()
  const complete = text.replace(/\[[^\]\n]*\]\([^\)\n]*$/g, '')
  marked.walkTokens(marked.lexer(complete), token => {
    if (token.type !== 'link') return
    try {
      const url = new URL(token.href)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
      if (!references.has(url.href)) references.set(url.href, {
        id: `${turnId}:${url.href}`, turnId, url: url.href,
        title: token.text.replace(/<[^>]*>/g, '').trim() || url.hostname,
      })
    } catch { /* Relative and malformed links are not websites. */ }
  })
  return [...references.values()]
}

export function replaceSiteReferences(sessionId: string, references: readonly SiteReference[]): void {
  const unique = [...new Map(references.map(reference => [reference.id, reference])).values()]
  if (JSON.stringify(sessions.get(sessionId) ?? empty) === JSON.stringify(unique)) return
  sessions.set(sessionId, unique)
  for (const listener of listeners) listener()
}
export function siteReferencesForSession(sessionId: string): readonly SiteReference[] { return sessions.get(sessionId) ?? empty }
export function retireSiteReferences(sessionId: string): void {
  if (!sessions.delete(sessionId)) return
  for (const listener of listeners) listener()
}
export function subscribeSiteReferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export async function siteOpenTargets(): Promise<SiteOpenTargets> {
  const api = (window as any).klaus?.browser
  if (!api?.siteOpenTargets) throw new Error(t('site_reference_unavailable'))
  const result = await api.siteOpenTargets()
  if (!Array.isArray(result?.targets)) throw new Error(t('site_reference_unavailable'))
  return result
}
export async function openSiteReference(sessionId: string, url: string, target?: SiteOpenTargetId): Promise<void> {
  try {
    const api = (window as any).klaus?.browser
    if (!api?.openSite) throw new Error(t('site_reference_unavailable'))
    const result = await api.openSite({ sessionId, url, ...(target ? { target } : {}) })
    if (result?.ok !== true) throw new Error(result?.error || t('site_reference_unavailable'))
  } catch (error) {
    ;(window as any).showToast?.(t('site_reference_open_failed').replace('{reason}', error instanceof Error ? error.message : String(error)))
  }
}
