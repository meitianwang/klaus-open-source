import { escapeHtml } from './transcript/factories'

/** Conversation errors expose only their concise user-facing message. */
export function renderErrorNoticeHtml(text: string): string {
  return `<div class="error-notice"><div class="error-notice-text">${escapeHtml(text)}</div></div>`
}
