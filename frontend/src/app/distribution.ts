import definitions from '../../../contracts/desktop-editions.json'
import { DEFAULT_DESKTOP_EDITION, isDesktopProtocol, parseDesktopEditionId, type DesktopDistribution } from '../../../shared/desktop-edition'

// The committed public definitions only seed the value shown before the host
// answers. The host owns the build's identity, which may be an edition that is
// not part of the public definitions.
const seed = definitions.editions[DEFAULT_DESKTOP_EDITION]
let current: DesktopDistribution = Object.freeze({
  edition: DEFAULT_DESKTOP_EDITION,
  application: seed.application,
  productName: seed.productName,
  protocol: seed.protocol,
  serverUrl: seed.serverUrl,
  siteUrl: seed.serverUrl,
  supportEmail: seed.supportEmail,
  defaultLanguage: null,
})
let pending: Promise<DesktopDistribution> | undefined
const listeners = new Set<() => void>()

export function desktopDistribution(): DesktopDistribution {
  return current
}

export function subscribeDesktopDistribution(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function text(value: unknown, field: string, maximum = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid desktop distribution identity: ${field}`)
  }
  return value
}

function serviceUrl(value: unknown, site = false): string {
  let address: URL
  try { address = new URL(text(value, site ? 'siteUrl' : 'serverUrl', 2048)) } catch { throw new Error('Invalid desktop service URL') }
  if (address.username || address.password || (site ? address.protocol !== 'https:' || address.pathname !== '/' || address.search || address.hash
    : !['https:', 'http:'].includes(address.protocol))) throw new Error('Invalid desktop service URL')
  return site ? address.origin : String(value).replace(/\/+$/, '')
}

/** Validate the shape of the host's answer; identity values come from the trusted host. */
export function parseDesktopDistribution(value: unknown): DesktopDistribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop distribution')
  const candidate = value as Record<string, unknown>
  const edition = parseDesktopEditionId(candidate.edition)
  if (!isDesktopProtocol(candidate.protocol)) throw new Error('Invalid desktop distribution identity: protocol')
  if (candidate.defaultLanguage !== null && candidate.defaultLanguage !== 'en') throw new Error('Invalid desktop distribution identity: defaultLanguage')
  const supportEmail = text(candidate.supportEmail, 'supportEmail')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw new Error('Invalid desktop distribution identity: supportEmail')
  return Object.freeze({
    edition,
    application: text(candidate.application, 'application'),
    productName: text(candidate.productName, 'productName', 64),
    protocol: candidate.protocol,
    serverUrl: serviceUrl(candidate.serverUrl),
    siteUrl: serviceUrl(candidate.siteUrl, true),
    supportEmail,
    defaultLanguage: candidate.defaultLanguage === 'en' ? 'en' : null,
  })
}

export async function loadDesktopDistribution(): Promise<DesktopDistribution> {
  if (pending) return pending
  const reader = (globalThis as any).window?.klaus?.app?.distribution
  if (typeof reader !== 'function') return current
  pending = Promise.resolve().then(() => reader()).then(raw => {
    current = parseDesktopDistribution(raw)
    for (const listener of listeners) listener()
    return current
  }).catch(error => {
    pending = undefined
    throw error
  })
  return pending
}

export function desktopSiteUrl(path: string, distribution: DesktopDistribution = desktopDistribution()): string {
  return new URL(path, distribution.siteUrl + '/').toString()
}

export function desktopServiceUrl(path: string, distribution: DesktopDistribution = desktopDistribution()): string {
  return new URL(distribution.serverUrl + '/' + path.replace(/^\/+/, '')).toString()
}
