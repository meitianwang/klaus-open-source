import { t } from '../i18n'
import type { SiteOpenTargetId, SiteOpenTargets } from '../../../contracts/browser-sites'
export type { SiteOpenTarget } from '../../../contracts/browser-sites'

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
