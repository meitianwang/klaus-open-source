import { isConnectorIdentity, mcpReferenceLabel, referenceCapabilityTile } from './capability-chip-visuals'
import { PLUGIN_NAME_EN_OVERRIDES, PLUGIN_NAME_ZH_OVERRIDES } from '../../pages/settings/market-tables'
// Sent-bubble rendering of a composer reference chip. Lives outside chat.ts so
// DOM harnesses can mount the exact production markup without booting the whole
// chat bootstrap; chat.ts re-exports it on `window` for the transcript shim.
import { icon as klausIcon } from '../../icons/registry'
import { escapeHtml } from '../../app/ui-shared'
import { browserTabIconHtml } from './browser-tab-icon'
import type { ComposerReferenceToken } from './reference-token'
import { friendDisplayName } from '../../pages/friends/display-name'
import { t } from '../../i18n'

export function friendReferenceIdentity(reference: ComposerReferenceToken) {
  const row = typeof window !== 'undefined' ? (window as any).getFriendDirectoryEntry?.(reference.id) : undefined
  return { name: row?.name || friendDisplayName({ displayName: reference.name }), avatarUrl: row?.avatarUrl }
}

function legacyReferenceClass(reference: Pick<ComposerReferenceToken, 'kind'>) {
  if (reference.kind === 'file' || reference.kind === 'folder') return 'is-file-reference'
  if (reference.kind === 'skill') return 'is-skills-command'
  if (reference.kind === 'mcp') return 'is-mcp-command'
  if (reference.kind === 'browser-tab') return 'is-browser-tab-reference'
  if (reference.kind === 'plugin') return 'is-plugin-reference'
  if (reference.kind === 'device') return 'is-device-reference'
  if (reference.kind === 'conversation') return 'is-conversation-reference'
  if (reference.kind === 'friend') return 'is-friend-reference'
  return 'is-agent-reference'
}

export function composerReferenceClass(reference: Pick<ComposerReferenceToken, 'kind' | 'id' | 'name' | 'connectorId' | 'unavailable'>) {
  const capability = ['skill', 'plugin', 'mcp', 'agent'].includes(reference.kind)
  const connector = reference.kind === 'mcp' && isConnectorIdentity(reference.connectorId || reference.id || reference.name, !!reference.connectorId)
  return [legacyReferenceClass(reference), capability ? 'is-capability-chip' : reference.kind !== 'friend' ? 'is-context-chip' : '', connector ? 'is-connector-reference' : '', reference.unavailable ? 'is-unavailable' : ''].filter(Boolean).join(' ')
}

export function composerReferenceIconSvg(reference: ComposerReferenceToken, className = '') {
  if (reference.kind === 'file' || reference.kind === 'folder') return klausIcon(reference.kind === 'folder' ? 'workspace-dir-pill' : 'workspace-file-pill', { cls: className })
  const tile = referenceCapabilityTile(reference, className)
  if (tile) return tile
  if (reference.kind === 'browser-tab') return browserTabIconHtml(reference.browserTab?.faviconUrl, className)
  if (reference.kind === 'device') return `<span class="${className}">${klausIcon('run-mode-local')}</span>`
  if (reference.kind === 'conversation') return `<span class="${className}">${klausIcon('chat-bubble')}</span>`
  if (reference.kind === 'friend') {
    const { name, avatarUrl } = friendReferenceIdentity(reference)
    return `<span class="${className} friend-reference-avatar" aria-hidden="true">${escapeHtml(name.slice(0, 1))}${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer" data-media-figure data-media-thumb>` : ''}</span>`
  }
  return klausIcon('subagent-kind-background', { cls: className })
}

function skillReferenceLabel(reference: ComposerReferenceToken): string {
  const raw = String(reference.name || reference.id || '')
  const id = String(reference.id || reference.name || '')
  if (!id || raw !== id) return raw
  const localize = typeof window !== 'undefined' ? (window as any).localizeSkillName : undefined
  if (typeof localize === 'function') {
    const localized = String(localize({ dirName: id, name: raw }) || '').trim()
    if (localized) return localized
  }
  return raw
}

function pluginReferenceLabel(reference: ComposerReferenceToken): string {
  const raw = reference.name || reference.id || ''
  const id = reference.id || raw
  const base = id.split('@')[0]
  if (raw !== id && raw !== base) return raw
  const table: Record<string, string> = typeof window !== 'undefined' && window.currentLang === 'zh' ? PLUGIN_NAME_ZH_OVERRIDES : PLUGIN_NAME_EN_OVERRIDES
  return Object.hasOwn(table, base.toLowerCase()) ? table[base.toLowerCase()] : raw
}

export function composerReferenceLabel(reference: ComposerReferenceToken): string {
  return reference.kind === 'friend'
    ? friendReferenceIdentity(reference).name
    : reference.kind === 'skill'
      ? skillReferenceLabel(reference)
      : reference.kind === 'plugin' ? pluginReferenceLabel(reference) : reference.kind === 'mcp' ? mcpReferenceLabel(reference) : reference.name
}

export function renderComposerReferencePillHtml(reference: ComposerReferenceToken, submittedActions = false) {
  const icon = composerReferenceIconSvg(reference, 'slash-pill-icon')
  const name = composerReferenceLabel(reference)
  const marker = reference.kind === 'friend' ? `<small class="friend-identity-tag">${escapeHtml(t('friend_identity_tag'))}</small>` : ''
  const actionable = submittedActions && ['skill', 'plugin', 'conversation', 'file', 'folder'].includes(reference.kind)
    && (reference.kind === 'skill' ? !!reference.skillPath && reference.skillPreview === true : reference.kind === 'file' || reference.kind === 'folder' ? !!(reference.path || reference.rel) : !!reference.id)
  const tag = actionable ? 'button' : 'span'
  const action = actionable ? ` type="button" data-submitted-reference-kind="${reference.kind}" data-submitted-reference="${escapeHtml(JSON.stringify(reference))}"` : ''
  return `<${tag} class="slash-pill composer-reference-pill ${composerReferenceClass(reference)}"${action}>${icon}<span class="slash-pill-label">${escapeHtml(name)}</span>${marker}</${tag}>`
}
