const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
import { icon, strokeGlyph24 } from '../../icons/registry'
import { getAgentLogoSrc, getConnectorLogoSrc, getPluginLogoSrc } from '../../icons/extension-logos'
import { getSkillLogoSrc } from '../../pages/skills/localize'
import type { ComposerReferenceToken } from './reference-token'

export const CONNECTOR_GLYPH_BY_ID: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), {
  'google-gmail': 'macos-mail', 'google-calendar': 'macos-calendar',
  ...Object.fromEntries('reminders calendar notes mail contacts messages safari shortcuts finder photos system app-ui'.split(' ').map(name => [`macos-${name}`, `macos-${name}`])),
}))
const key = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : ''
export function isConnectorIdentity(value: unknown, explicitFlag = false): boolean {
  return explicitFlag || !!(getConnectorLogoSrc(key(value)) || CONNECTOR_GLYPH_BY_ID[key(value)])
}
export function safeChipImageSrc(value: unknown): string {
  if (typeof value !== 'string' || value.length > 131072 || /[\s<>"'\\]/.test(value)) return ''
  if (/^(?:skill-logos|extension-logos)\/(?:[\w-]+\/)*[\w-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(value)) return value
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(value) && !value.endsWith(',')) return value
  try { const url = new URL(value); if (/^(https|klaus-media):\/\//i.test(value) && url.hostname && !url.username && !url.password) return value } catch { /* Fall back to a vector. */ }
  return ''
}
export interface ComposerMcpVisual { name?: string; nameZh?: string; nameEn?: string; id?: string; connectorId?: string; iconDataUrl?: unknown; iconSvg?: unknown; status?: string; needsAuth?: boolean }
const metadata = { skill: new Map<string, ComposerMcpVisual>(), plugin: new Map<string, ComposerMcpVisual>(), mcp: new Map<string, ComposerMcpVisual>() }
function remember(family: keyof typeof metadata, rows: readonly ComposerMcpVisual[]) {
  const map = metadata[family]
  for (const row of rows) { const id = key(row.id || row.name); if (id) map.set(id, { ...map.get(id), ...row }) }
  while (map.size > 1024) map.delete(map.keys().next().value!)
}
export const rememberComposerPluginVisuals = (rows: readonly ComposerMcpVisual[]) => remember('plugin', rows)
export const rememberComposerMcpVisuals = (rows: readonly ComposerMcpVisual[]) => remember('mcp', rows)
export const rememberComposerSkillVisuals = (rows: readonly { name?: string; dirName?: string; icon?: unknown }[]) => remember('skill', rows.map(row => ({ id: row.dirName, name: row.name, iconDataUrl: row.icon })))
type Family = 'skill' | 'plugin' | 'connector' | 'mcp' | 'shortcut' | 'agent'
export function renderCapabilityMiniTileHtml(family: Family, iconClass: string, glyph: string, src = '', needsAuth = false): string {
  const image = safeChipImageSrc(src)
  return `<span class="${escapeAttribute(iconClass)} slash-chip-tile is-${family}-tile${image ? ' is-brand-tile' : ''}${needsAuth ? ' is-needs-auth' : ''}" aria-hidden="true">${image ? `<img src="${escapeAttribute(image)}" alt="" referrerpolicy="no-referrer">` : glyph}${needsAuth ? '<span class="slash-chip-status-dot"></span>' : ''}</span>`
}
export function referenceCapabilityTile(reference: Pick<ComposerReferenceToken, 'kind' | 'id' | 'name' | 'connectorId' | 'iconUrl' | 'needsAuth'>, cls: string): string {
  const { kind, name, connectorId } = reference
  const id = key(connectorId || reference.id || name)
  const bareId = id.split('@')[0]!
  const live = kind === 'plugin' ? (metadata.plugin.get(id) || metadata.plugin.get(bareId)) : kind === 'skill' || kind === 'mcp' ? metadata[kind].get(id) : undefined
  const image = safeChipImageSrc(reference.iconUrl) || safeChipImageSrc(live?.iconDataUrl)
  if (kind === 'skill') return renderCapabilityMiniTileHtml(kind, cls, icon('skill-sparkle-fill'), getSkillLogoSrc({ dirName: id, name }) || image)
  if (kind === 'plugin') return renderCapabilityMiniTileHtml(kind, cls, icon('plugin-fill'), image || [id, bareId, `${bareId}@klaus-official`, `${bareId}@builtin`].map(id => getPluginLogoSrc({ id })).find(Boolean) || getSkillLogoSrc({ dirName: bareId, name: bareId }))
  if (kind === 'agent') return renderCapabilityMiniTileHtml(kind, cls, icon('subagent-kind-background'), getAgentLogoSrc(id))
  if (kind !== 'mcp') return ''
  const auth = live?.needsAuth ?? reference.needsAuth ?? live?.status === 'needs-auth'
  if (isConnectorIdentity(id, !!(connectorId || live?.connectorId))) return renderCapabilityMiniTileHtml('connector', cls, icon((CONNECTOR_GLYPH_BY_ID[id] || 'mcp-grid-fill') as Parameters<typeof icon>[0]), getConnectorLogoSrc(id) || image, auth)
  const svg = sanitizeMcpCatalogGlyph(live?.iconSvg)
  return renderCapabilityMiniTileHtml('mcp', cls, /^<svg\b/i.test(svg) ? svg : icon('mcp-grid-fill'), image, auth)
}

const glyphTags = new Set('svg path circle ellipse rect line polygon polyline g'.split(' '))
const glyphAttributes = new Set('viewBox d fill stroke stroke-width stroke-linecap stroke-linejoin fill-rule clip-rule opacity transform cx cy r rx ry x y x1 x2 y1 y2 points width height'.split(' '))
export function sanitizeMcpCatalogGlyph(rawSvg: unknown): string {
  if (typeof rawSvg !== 'string' || !rawSvg.trim() || rawSvg.length > 16384) return ''
  const source = /^<svg\b/.test(rawSvg.trim()) ? rawSvg.trim() : strokeGlyph24(rawSvg.trim(), 10)
  const stack: string[] = []
  let rest = source
  let root = false
  while ((rest = rest.trimStart())) {
    const tag = /^<(\/?)([a-z]+)([^<>]*?)(\/?)>/.exec(rest)
    if (!tag || !glyphTags.has(tag[2])) return ''
    const [, closing, name, attrs, selfClosing] = tag
    if (closing) {
      if (attrs.trim() || selfClosing || stack.pop() !== name) return ''
    } else {
      if (!stack.length) { if (root || name !== 'svg' || selfClosing) return ''; root = true }
      else if (name === 'svg') return ''
      let tail = attrs
      while (tail.trim()) {
        const attr = /^\s+([\w-]+)\s*=\s*(["'])([a-zA-Z0-9#.,%+()\s-]*)\2/.exec(tail)
        if (!attr || !glyphAttributes.has(attr[1]) || /url\s*\(/i.test(attr[3])) return ''
        tail = tail.slice(attr[0].length)
      }
      if (!selfClosing) stack.push(name)
    }
    rest = rest.slice(tag[0].length)
  }
  return root && !stack.length ? source : ''
}

export function mcpReferenceLabel(reference: Pick<ComposerReferenceToken, 'id' | 'name' | 'connectorId'>): string {
  const id = key(reference.connectorId || reference.id || reference.name)
  if (key(reference.name) !== id) return reference.name
  const row = metadata.mcp.get(id)
  return (typeof window !== 'undefined' && window.currentLang === 'zh' ? row?.nameZh : row?.nameEn) || reference.name
}

let catalog: Promise<ComposerMcpVisual[]> | undefined
export function loadComposerMcpCatalog(api: { builtins?: () => Promise<unknown> } | undefined) {
  if (typeof api?.builtins !== 'function') return Promise.resolve([])
  return catalog ??= Promise.resolve().then(() => api.builtins!()).then(value => {
    const rows: ComposerMcpVisual[] = Array.isArray(value) ? value.filter(row => typeof row?.id === 'string') : []
    rememberComposerMcpVisuals(rows)
    return rows
  }).catch(() => [])
}
