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

export function composerReferenceClass(reference: Pick<ComposerReferenceToken, 'kind'>) {
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

export function composerReferenceIconSvg(reference: ComposerReferenceToken, className = '') {
  if (reference.kind === 'file' || reference.kind === 'folder') return klausIcon(reference.kind === 'folder' ? 'workspace-dir-pill' : 'workspace-file-pill', { cls: className })
  if (reference.kind === 'skill') return klausIcon('skill-sparkle-fill', { cls: className })
  if (reference.kind === 'mcp') return klausIcon('mcp-grid-fill', { cls: className })
  if (reference.kind === 'browser-tab') return browserTabIconHtml(reference.browserTab?.faviconUrl, className)
  if (reference.kind === 'plugin') return klausIcon('plugin-fill', { cls: className })
  if (reference.kind === 'device') return `<span class="${className}">${klausIcon('run-mode-local')}</span>`
  if (reference.kind === 'conversation') return `<span class="${className}">${klausIcon('chat-bubble')}</span>`
  if (reference.kind === 'friend') {
    const { name, avatarUrl } = friendReferenceIdentity(reference)
    return `<span class="${className} friend-reference-avatar" aria-hidden="true">${escapeHtml(name.slice(0, 1))}${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer" data-media-figure data-media-thumb>` : ''}</span>`
  }
  return klausIcon('subagent-kind-background', { cls: className })
}

export function renderComposerReferencePillHtml(reference: ComposerReferenceToken, submittedActions = false) {
  const icon = composerReferenceIconSvg(reference, 'slash-pill-icon')
  const name = reference.kind === 'friend' ? friendReferenceIdentity(reference).name : reference.name
  const marker = reference.kind === 'friend' ? `<small class="friend-identity-tag">${escapeHtml(t('friend_identity_tag'))}</small>` : ''
  const actionable = submittedActions && ['skill', 'plugin', 'conversation', 'file', 'folder'].includes(reference.kind)
    && (reference.kind === 'skill' ? !!reference.skillPath && reference.skillPreview === true : reference.kind === 'file' || reference.kind === 'folder' ? !!(reference.path || reference.rel) : !!reference.id)
  const tag = actionable ? 'button' : 'span'
  const action = actionable ? ` type="button" data-submitted-reference-kind="${reference.kind}" data-submitted-reference="${escapeHtml(JSON.stringify(reference))}"` : ''
  return `<${tag} class="slash-pill composer-reference-pill ${composerReferenceClass(reference)}"${action}>${icon}<span class="slash-pill-label">${escapeHtml(name)}</span>${marker}</${tag}>`
}
